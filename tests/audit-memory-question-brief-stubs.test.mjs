// Todo #11 fourth review rework: memory / question / topic brief / queued text caps, whole topics
// left out before degrading, and a degraded board that still lists topics and cards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import { validateModel } from '../sdk/harness/contracts.mjs'
import { fitSnapshotBudget, HOST_JSON_LIMIT, SNAPSHOT_BUDGET } from '../src/server/diff-budget.mjs'

const L = x => Buffer.byteLength(JSON.stringify(x))
const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit11e-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {} } })
  const host = { agents: { async list() { return { agents: [] } }, async models() { return { models: [] } } }, models: { async list() { return { data: [] } } }, async request() { return null }, sessions: {} }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const project = db.createProject(1, 'default', { name: 'P', repoPath: root, defaultBranch: 'main' })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const rawWrite = fn => { const raw = new DatabaseSync(sqlitePath); try { return fn(raw) } finally { raw.close() } }
  const rawRead = fn => { const raw = new DatabaseSync(sqlitePath, { readOnly: true }); try { return fn(raw) } finally { raw.close() } }
  const cleanup = () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, project, tools, rawWrite, rawRead, cleanup }
}

const loadFull = async (ctx, label) => {
  const snap = await ctx.orch.getSnapshot(ctx.run)
  assert.equal(snap.snapshotOverflow, undefined, `${label}: not a degraded snapshot`)
  assert.ok(L(snap) <= SNAPSHOT_BUDGET, `${label}: snapshot size ${L(snap)}`)
  assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
  return snap
}

/* ---------- Must-fix 1 ---------- */

test('audit#11 r4: two 1.2 MB memories saved through manage_memory are capped and the existing card stays on the board', async () => {
  const ctx = setup()
  try {
    const { db, run, project, tools } = ctx
    await ctx.orch.getSnapshot(run)
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'existing card', spec: 'keep me' })
    const props = tools.get('manage_memory').inputSchema.properties
    assert.equal(props.content.maxLength, 4000)
    assert.equal(props.title.maxLength, 160)
    for (let i = 0; i < 2; i += 1) {
      const res = await tools.get('manage_memory').execute({ action: 'upsert', title: `M${i} ${'题'.repeat(500)}`, content: `HEAD ${'忆'.repeat(1_200_000)}` }, run)
      assert.equal(res.ok, true)
    }
    const rows = ctx.rawRead(raw => raw.prepare('SELECT title, content FROM memories').all())
    assert.equal(rows.length, 2)
    for (const r of rows) {
      assert.ok(r.content.length <= 4000 && r.content.startsWith('HEAD ') && r.content.endsWith('…'), `stored content length ${r.content.length}`)
      assert.ok(r.title.length <= 160, `stored title length ${r.title.length}`)
    }
    const snap = await loadFull(ctx, 'memories')
    const view = snap.todos.find(t => t.id === card.id)
    assert.ok(view, 'the existing card is still on the board')
    assert.equal(view.spec, 'keep me')
  } finally { ctx.cleanup() }
})

test('audit#11 r4: oversized memories already in the database are shortened in the board view only', async () => {
  const ctx = setup()
  try {
    const { db, run, project } = ctx
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'existing card' })
    const ids = [0, 1].map(i => db.upsertMemory(1, 'default', { title: `m${i}`, content: 'seed' }).id)
    ctx.rawWrite(raw => raw.prepare('UPDATE memories SET content = ?').run(`LEGACY ${'忆'.repeat(1_200_000)}`))
    const snap = await loadFull(ctx, 'legacy memories')
    assert.ok(snap.todos.some(t => t.id === card.id))
    for (const m of snap.memories) {
      assert.ok(m.content.length <= 4000 && m.content.startsWith('LEGACY '))
      assert.equal(m.contentTrimmed, true)
    }
    // Pinning a memory does not rewrite its stored content.
    db.upsertMemory(1, 'default', { id: ids[0], pinned: true })
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT length(content) AS n FROM memories WHERE id = ?').get(ids[0]).n) > 1_200_000)
    assert.equal(db.getMemory(1, 'default', ids[0]).pinned, true)
  } finally { ctx.cleanup() }
})

test('audit#11 r4: a 400000-character ask_user keeps the card at the human gate on the board', async () => {
  const ctx = setup()
  try {
    const { db, run, project, tools } = ctx
    await ctx.orch.getSnapshot(run)
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'needs a decision' })
    const props = tools.get('ask_user').inputSchema.properties
    assert.equal(props.title.maxLength, 2000)
    assert.equal(props.why.maxLength, 2000)
    const res = await tools.get('ask_user').execute({
      todo_id: card.id,
      title: `Q ${'问'.repeat(400_000)}`,
      why: `W ${'因'.repeat(400_000)}`,
      options: [{ label: `A ${'选'.repeat(400_000)}` }, { label: 'B' }],
    }, run)
    assert.equal(res.ok, true)
    const q = JSON.parse(ctx.rawRead(raw => raw.prepare('SELECT question_json FROM todos WHERE id = ?').get(card.id).question_json))
    assert.ok(q.title.length <= 2000 && q.title.startsWith('Q '), `stored question title length ${q.title.length}`)
    assert.ok(q.why.length <= 2000 && q.why.startsWith('W '))
    assert.ok(q.options.every(o => o.label.length <= 2000))
    const snap = await loadFull(ctx, 'ask_user')
    const view = snap.todos.find(t => t.id === card.id)
    assert.ok(view, 'the card waiting for a decision is still on the board')
    assert.equal(view.gateKind, 'question')
    assert.equal(view.question.active, true)
    assert.equal(view.question.options.length, 2)
  } finally { ctx.cleanup() }
})

test('audit#11 r4: an oversized question already in the database is shortened in the board view only', async () => {
  const ctx = setup()
  try {
    const { db, run, project } = ctx
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'legacy question' })
    db.updateTodo(1, 'default', card.id, { phase: 'confirm', gateOwner: 'human', gateKind: 'question' })
    const legacy = JSON.stringify({ active: true, version: 1, title: `LEGACY ${'问'.repeat(1_200_000)}`, why: 'w', options: [{ id: 'opt-1', label: 'A', recommended: true }], answeredText: '' })
    ctx.rawWrite(raw => raw.prepare('UPDATE todos SET question_json = ? WHERE id = ?').run(legacy, card.id))
    const snap = await loadFull(ctx, 'legacy question')
    const view = snap.todos.find(t => t.id === card.id)
    assert.ok(view, 'the card is not left out')
    assert.ok(view.question.title.length <= 2000 && view.question.title.startsWith('LEGACY '))
    assert.equal(view.questionTrimmed, true)
    db.appendTimeline(1, 'default', card.id, 'unrelated', 'system')
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT question_json FROM todos WHERE id = ?').get(card.id).question_json), legacy, 'an unrelated update does not rewrite the stored question')
  } finally { ctx.cleanup() }
})

test('audit#11 r4: a topic-level ask_user of about two million characters is capped and the board loads', async () => {
  const ctx = setup()
  try {
    const { db, run, project, tools } = ctx
    await ctx.orch.getSnapshot(run)
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'existing card' })
    const topic = db.createTopic(1, 'default', { title: 'decision' })
    const res = await tools.get('ask_user').execute({
      topic_id: topic.id,
      title: `T ${'题'.repeat(1_000_000)}`,
      why: `W ${'因'.repeat(1_000_000)}`,
      recommendation: `R ${'荐'.repeat(100_000)}`,
      options: [`A ${'选'.repeat(100_000)}`, 'B'],
    }, run)
    assert.equal(res.ok, true)
    const brief = JSON.parse(ctx.rawRead(raw => raw.prepare('SELECT brief_json FROM topics WHERE id = ?').get(topic.id).brief_json))
    for (const key of ['waitingTitle', 'waitingOnYou', 'waitingRecommendation']) assert.ok(brief[key].length <= 2000 && brief[key].length > 0, `stored brief.${key} length ${brief[key].length}`)
    assert.ok(brief.waitingOptions.every(o => o.label.length <= 2000))
    const snap = await loadFull(ctx, 'topic ask_user')
    assert.ok(snap.todos.some(t => t.id === card.id))
    assert.ok(snap.topics.find(t => t.id === topic.id).brief.waitingOnYou.startsWith('T '))
    // update_topic_brief declares and applies the same limits.
    const bp = tools.get('update_topic_brief').inputSchema.properties
    for (const key of ['goal', 'progress', 'next', 'waiting_title', 'waiting_on_you', 'waiting_recommendation', 'blocked']) assert.equal(bp[key].maxLength, 2000, key)
    await tools.get('update_topic_brief').execute({ topic_id: topic.id, goal: `G ${'目'.repeat(500_000)}` }, run)
    assert.ok(JSON.parse(ctx.rawRead(raw => raw.prepare('SELECT brief_json FROM topics WHERE id = ?').get(topic.id).brief_json)).goal.length <= 2000)
    await loadFull(ctx, 'update_topic_brief')
  } finally { ctx.cleanup() }
})

test('audit#11 r4: an oversized brief already in the database is shortened in the board view only', async () => {
  const ctx = setup()
  try {
    const { db } = ctx
    const topic = db.createTopic(1, 'default', { title: 'legacy brief' })
    const legacy = JSON.stringify({ goal: `LEGACY ${'目'.repeat(1_000_000)}`, progress: 'p', next: '', waitingOnYou: '', waitingTitle: '', waitingRecommendation: '', waitingOptions: [], blocked: '', updatedAt: 1 })
    ctx.rawWrite(raw => raw.prepare('UPDATE topics SET brief_json = ? WHERE id = ?').run(legacy, topic.id))
    const snap = await loadFull(ctx, 'legacy brief')
    const view = snap.topics.find(t => t.id === topic.id)
    assert.ok(view.brief.goal.length <= 2000 && view.brief.goal.startsWith('LEGACY '))
    assert.equal(view.briefTrimmed, true)
    db.updateTopic(1, 'default', topic.id, { pinned: true })
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT brief_json FROM topics WHERE id = ?').get(topic.id).brief_json), legacy)
  } finally { ctx.cleanup() }
})

test('audit#11 r4: three topics with twenty 12000-character queued messages each load without degrading', async () => {
  const ctx = setup()
  try {
    const { db, project } = ctx
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'existing card' })
    const topics = [0, 1, 2].map(i => db.createTopic(1, 'default', { title: `q${i}` }))
    for (const t of topics) for (let i = 0; i < 20; i += 1) db.enqueueTopicItem(1, 'default', t.id, { kind: 'user', text: `Q${i} ${'排'.repeat(30_000)}`, createdAt: 1000 + i })
    const rows = ctx.rawRead(raw => raw.prepare('SELECT text FROM topic_queue').all())
    assert.equal(rows.length, 60)
    for (const r of rows) assert.ok(r.text.length <= 12_000 && r.text.endsWith('…'), `stored queued text length ${r.text.length}`)
    const snap = await loadFull(ctx, 'queued text')
    assert.ok(snap.todos.some(t => t.id === card.id))
    for (const t of topics) {
      const view = snap.topics.find(x => x.id === t.id)
      assert.equal(view.queuedItems.length, 20, 'every queued item is still listed, so it can still be withdrawn')
      assert.ok(view.queuedItems.every(q => q.id && q.text.startsWith('Q')))
    }
    assert.ok(snap.topics.some(t => t.queuedItems.some(q => q.textTrimmed === true)), 'queued text was shortened in the view')
    assert.ok(db.listTopicQueue(1, 'default', topics[0].id).every(q => q.text.length > 11_000), 'the queue itself keeps the stored text')
  } finally { ctx.cleanup() }
})

/* ---------- Must-fix 2 ---------- */

const longTopic = (i, archived = false) => ({
  id: `t${i}`, title: `Topic ${i}`, archived, pinned: false, updatedAt: 1000 + i, projectId: 'p', lastError: '',
  brief: { goal: 'g', progress: '', next: '', waitingOnYou: '', waitingTitle: '', waitingRecommendation: '', waitingOptions: [], blocked: '', updatedAt: 1 },
  queuedItems: [],
  messages: Array.from({ length: 30 }, (_, k) => ({ id: `t${i}-m${k}`, kind: 'chief', text: '复'.repeat(20_000), createdAt: k })),
})

test('audit#11 r4: forty topics with long replies load; whole topics are left out, archived and least recently active first', () => {
  const topics = [...Array.from({ length: 36 }, (_, i) => longTopic(i)), ...Array.from({ length: 4 }, (_, i) => longTopic(100 + i, true))]
  const todos = Array.from({ length: 6 }, (_, i) => ({ id: `td-${i}`, number: i + 1, title: `Card ${i}`, phase: 'review', gateOwner: 'human', gateKind: 'review', updatedAt: i, diffs: [], timeline: [], buildChat: [], spec: 's', plan: '', lastError: '' }))
  const snap = { topics, todos }
  assert.ok(L(snap) > HOST_JSON_LIMIT)
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.snapshotOverflow, undefined, 'not degraded')
  assert.ok(fitted.topics.length > 0 && fitted.topics.length < 40, `topics kept ${fitted.topics.length}`)
  assert.equal(fitted.topics.length + fitted.topicsOmitted, 40)
  assert.equal(fitted.todos.length, 6, 'every card is still listed')
  assert.ok(fitted.topics.every(t => !t.archived), 'archived topics go first')
  const kept = fitted.topics.map(t => t.updatedAt)
  assert.equal(Math.min(...kept), 1000 + (36 - kept.length), 'then exactly the least recently active ones')
  assert.ok(fitted.topics.every(t => t.messages.length >= 1 && t.messages[t.messages.length - 1].id === `${t.id}-m29`))
  assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', { settings: {}, concurrency: {}, counts: {}, projects: [], agents: [], memories: [], schedules: [], quotaProviders: [], runtime: {}, ...fitted }))
})

test('audit#11 r4: a degraded snapshot still lists every topic and card by name instead of returning empty arrays', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project } = ctx
    await orch.getSnapshot(run)
    const topicIds = Array.from({ length: 40 }, (_, i) => {
      const t = db.createTopic(1, 'default', { title: `Topic ${i}` })
      db.addTopicMessage(1, 'default', t.id, { kind: 'chief', text: `R${i} ${'复'.repeat(19_000)}`, createdAt: 1000 + i })
      return t.id
    })
    // Running cards filled to the write caps cannot be left out, so the board has to degrade.
    const cardIds = Array.from({ length: 26 }, (_, i) => {
      const t = db.createTodo(1, 'default', { projectId: project.id, topicId: topicIds[i], title: `Card ${i}`, spec: '规'.repeat(20_000) })
      db.updateTodo(1, 'default', t.id, {
        phase: 'building', gateOwner: 'chief', plan: '计'.repeat(16_000),
        timeline: Array.from({ length: 80 }, (_, k) => ({ time: k, event: `${k} `.padEnd(600, '事'), actor: 'system' })),
        buildChat: Array.from({ length: 24 }, (_, k) => ({ role: '执行进度', time: '', text: `${k} `.padEnd(4000, '聊') })),
      })
      return t.id
    })
    const snap = await orch.getSnapshot(run)
    assert.equal(snap.snapshotOverflow, true)
    assert.ok(snap.overflowBytes > HOST_JSON_LIMIT)
    assert.ok(L(snap) <= SNAPSHOT_BUDGET, `degraded size ${L(snap)}`)
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
    assert.equal(snap.topics.length, 40, 'every topic is listed')
    assert.equal(snap.todos.length, 26, 'every card is listed')
    assert.equal(snap.todosOmitted, undefined)
    assert.equal(snap.topicsOmitted, undefined)
    for (const id of topicIds) {
      const t = snap.topics.find(x => x.id === id)
      assert.ok(t && /^Topic \d+$/.test(t.title) && t.archived === false && typeof t.updatedAt === 'number')
      assert.deepEqual(t.messages, [], 'the conversation body is not included')
    }
    for (const id of cardIds) {
      const td = snap.todos.find(x => x.id === id)
      assert.ok(td && /^Card \d+$/.test(td.title) && td.phase === 'building' && td.gateOwner === 'chief' && td.gateKind === 'none')
      assert.ok(typeof td.number === 'number' && typeof td.updatedAt === 'number')
      assert.equal(td.spec, undefined, 'card bodies are not included')
      assert.equal(td.plan, undefined)
    }
  } finally { ctx.cleanup() }
})

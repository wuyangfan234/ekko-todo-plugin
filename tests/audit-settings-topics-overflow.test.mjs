// Todo #11 third review rework: charter / topic error / topic message / project avatar / queue caps,
// a degraded snapshot instead of an error above the host limit, and no silent truncation of stored
// text by unrelated updates.
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
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit11d-'))
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

const assertLoads = async (ctx, label) => {
  const snap = await ctx.orch.getSnapshot(ctx.run)
  assert.ok(L(snap) <= SNAPSHOT_BUDGET, `${label}: snapshot size ${L(snap)}`)
  assert.equal(snap.snapshotOverflow, undefined, `${label}: not a degraded snapshot`)
  assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
  return snap
}

/* ---------- Must-fix 1: the four uncapped fields and the queue ---------- */

test('audit#11 r3: a 900000-character charter written through configure_chief is capped and the board loads', async () => {
  const ctx = setup()
  try {
    await ctx.orch.getSnapshot(ctx.run)
    assert.equal(ctx.tools.get('configure_chief').inputSchema.properties.charter.maxLength, 20_000)
    const res = await ctx.tools.get('configure_chief').execute({ charter: `HEAD ${'章'.repeat(900_000)}` }, ctx.run)
    assert.equal(res.ok, true)
    const stored = ctx.rawRead(raw => raw.prepare('SELECT charter FROM settings').get().charter)
    assert.ok(stored.length <= 20_000, `stored charter length ${stored.length}`)
    assert.ok(stored.startsWith('HEAD ') && stored.endsWith('…'))
    await assertLoads(ctx, 'charter')
  } finally { ctx.cleanup() }
})

test('audit#11 r3: an oversized charter already in the database is shortened in the board view only', async () => {
  const ctx = setup()
  try {
    await ctx.orch.getSnapshot(ctx.run)
    ctx.rawWrite(raw => raw.prepare('UPDATE settings SET charter = ?').run(`LEGACY ${'章'.repeat(900_000)}`))
    const snap = await assertLoads(ctx, 'legacy charter')
    assert.ok(snap.settings.charter.length <= 20_000 && snap.settings.charter.startsWith('LEGACY '))
    assert.equal(snap.settings.charterTrimmed, true)
    // An unrelated settings change does not rewrite the stored charter.
    ctx.db.updateSettings(1, 'default', { notifySound: false })
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT length(charter) AS n FROM settings').get().n) > 900_000)
  } finally { ctx.cleanup() }
})

test('audit#11 r3: two topics with 1.2 MB errors are capped when stored and the board loads', async () => {
  const ctx = setup()
  try {
    const { db } = ctx
    const ids = [0, 1].map(i => db.createTopic(1, 'default', { title: `t${i}` }).id)
    for (const id of ids) db.updateTopic(1, 'default', id, { lastError: `ENGINE ${'e'.repeat(1_200_000)}` })
    const rows = ctx.rawRead(raw => raw.prepare('SELECT last_error FROM topics').all())
    for (const r of rows) assert.ok(r.last_error.length <= 2000 && r.last_error.startsWith('ENGINE '), `stored topic lastError length ${r.last_error.length}`)
    await assertLoads(ctx, 'topic errors')
    // Legacy rows: view only.
    ctx.rawWrite(raw => raw.prepare('UPDATE topics SET last_error = ?').run(`LEGACY ${'e'.repeat(1_200_000)}`))
    const snap = await assertLoads(ctx, 'legacy topic errors')
    for (const t of snap.topics) {
      assert.ok(t.lastError.length <= 2000 && t.lastError.startsWith('LEGACY '))
      assert.equal(t.lastErrorTrimmed, true)
    }
    db.updateTopic(1, 'default', ids[0], { pinned: true })
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT length(last_error) AS n FROM topics WHERE id = ?').get(ids[0]).n) > 1_200_000, 'an unrelated update does not rewrite the stored error')
  } finally { ctx.cleanup() }
})

test('audit#11 r3: twenty 120 KB topic messages are capped when stored and the board loads', async () => {
  const ctx = setup()
  try {
    const { db } = ctx
    const topic = db.createTopic(1, 'default', { title: 'long' })
    for (let i = 0; i < 20; i += 1) db.addTopicMessage(1, 'default', topic.id, { kind: 'chief', text: `M${i} ${'话'.repeat(120_000)}`, createdAt: 1000 + i })
    const rows = ctx.rawRead(raw => raw.prepare('SELECT text FROM topic_messages').all())
    assert.equal(rows.length, 20)
    for (const r of rows) assert.ok(r.text.length <= 20_000 && r.text.endsWith('…'), `stored message length ${r.text.length}`)
    const snap = await assertLoads(ctx, 'topic messages')
    assert.equal(snap.topics.find(t => t.id === topic.id).messages.length, 20, 'capped messages all fit')
  } finally { ctx.cleanup() }
})

test('audit#11 r3: oversized topic messages already in the database are shortened in the board view only', async () => {
  const ctx = setup()
  try {
    const { db } = ctx
    const topic = db.createTopic(1, 'default', { title: 'legacy' })
    db.addTopicMessage(1, 'default', topic.id, { kind: 'chief', text: 'seed', createdAt: 1 })
    ctx.rawWrite(raw => raw.prepare('UPDATE topic_messages SET text = ?').run(`LEGACY ${'x'.repeat(1_900_000)}`))
    const snap = await assertLoads(ctx, 'legacy message')
    const msg = snap.topics.find(t => t.id === topic.id).messages[0]
    assert.ok(msg.text.length <= 20_000 && msg.text.startsWith('LEGACY '))
    assert.equal(msg.textTrimmed, true)
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT length(text) AS n FROM topic_messages').get().n) > 1_900_000)
  } finally { ctx.cleanup() }
})

test('audit#11 r3: topic conversations are trimmed down to the newest 5 and then 1 message when 20 is not enough', () => {
  const topics = Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`, updatedAt: i, archived: false,
    messages: Array.from({ length: 20 }, (_, k) => ({ id: `t${i}-m${k}`, kind: 'chief', text: '话'.repeat(20_000), createdAt: k })),
  }))
  const snap = { topics, todos: [] }
  assert.ok(L(snap) > HOST_JSON_LIMIT)
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.snapshotOverflow, undefined)
  assert.equal(fitted.topics.length, 12)
  for (const t of fitted.topics) {
    assert.ok(t.messages.length >= 1)
    assert.equal(t.messages.length + (t.messagesOmitted || 0), 20)
    assert.equal(t.messages[t.messages.length - 1].id, `${t.id}-m19`, 'the newest message is kept')
  }
  assert.ok(fitted.topics.find(t => t.id === 't11').messages.length >= fitted.topics.find(t => t.id === 't0').messages.length, 'the most recently active topic keeps at least as much')
})

test('audit#11 r3: twenty projects with 120 KB avatars load, and saving the stand-in back keeps the stored avatar', async () => {
  const ctx = setup()
  try {
    const { db, root } = ctx
    const upload = `data:image/png;base64,${'A'.repeat(120_000)}`
    const ids = Array.from({ length: 20 }, (_, i) => db.createProject(1, 'default', { name: `P${i}`, repoPath: root, defaultBranch: 'main', avatar: upload }).id)
    const snap = await assertLoads(ctx, 'project avatars')
    const swapped = snap.projects.filter(p => p.avatarOmitted === true)
    assert.ok(swapped.length > 0, 'some project avatars were swapped for the monogram')
    for (const p of swapped) assert.ok(!p.avatar.startsWith('data:'))
    assert.equal(ctx.rawRead(raw => raw.prepare("SELECT COUNT(*) AS n FROM projects WHERE avatar LIKE 'data:%'").get().n), 20, 'stored avatars are untouched')
    // Saving the project from the trimmed view sends the stand-in back.
    const view = swapped[0]
    db.updateProject(1, 'default', view.id, { id: view.id, displayName: 'renamed', avatar: view.avatar })
    const after = db.getProject(1, 'default', view.id)
    assert.equal(after.displayName, 'renamed')
    assert.equal(after.avatar, upload, 'the uploaded avatar is still stored')
    // Clearing the avatar on purpose still works.
    db.updateProject(1, 'default', ids[1], { avatar: '' })
    assert.equal(db.getProject(1, 'default', ids[1]).avatar, '')
  } finally { ctx.cleanup() }
})

test('audit#11 r3: the board carries only the newest 20 queued items per topic and reports the rest', async () => {
  const ctx = setup()
  try {
    const { db } = ctx
    const topic = db.createTopic(1, 'default', { title: 'queue' })
    const quiet = db.createTopic(1, 'default', { title: 'quiet' })
    for (let i = 0; i < 60; i += 1) db.enqueueTopicItem(1, 'default', topic.id, { kind: 'user', text: `Q${i} ${'排'.repeat(11_000)}`, createdAt: 1000 + i })
    db.enqueueTopicItem(1, 'default', quiet.id, { kind: 'user', text: 'one' })
    const snap = await assertLoads(ctx, 'queue')
    const view = snap.topics.find(t => t.id === topic.id)
    assert.equal(view.queuedItems.length, 20)
    assert.equal(view.queuedItemsOmitted, 40)
    assert.ok(view.queuedItems[0].text.startsWith('Q40 ') && view.queuedItems[19].text.startsWith('Q59 '), 'the newest 20, in order')
    const other = snap.topics.find(t => t.id === quiet.id)
    assert.equal(other.queuedItems.length, 1)
    assert.equal(other.queuedItemsOmitted, undefined)
    assert.equal(db.listTopicQueue(1, 'default', topic.id).length, 60, 'nothing is removed from the queue')
  } finally { ctx.cleanup() }
})

/* ---------- Must-fix 2: degraded snapshot instead of an error ---------- */

// A running card filled to the write caps in CJK: about 97 KB even after every trimming stage.
const fillRunning = (db, projectId, i) => {
  const t = db.createTodo(1, 'default', { projectId, title: `B${i}`, spec: '规'.repeat(20_000) })
  db.updateTodo(1, 'default', t.id, {
    phase: 'building',
    plan: '计'.repeat(16_000),
    timeline: Array.from({ length: 80 }, (_, k) => ({ time: k, event: `${k} `.padEnd(600, '事'), actor: 'system' })),
    buildChat: Array.from({ length: 24 }, (_, k) => ({ role: '执行进度', time: '', text: `${k} `.padEnd(4000, '聊') })),
  })
  return t.id
}

test('audit#11 r3: above the host limit the board returns a degraded snapshot and writes still report success', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, tools } = ctx
    await orch.getSnapshot(run)
    for (let i = 0; i < 26; i += 1) fillRunning(db, project.id, i)
    const snap = await orch.getSnapshot(run)
    assert.equal(snap.snapshotOverflow, true)
    assert.equal(snap.snapshotTrimmed, true)
    assert.ok(snap.overflowBytes > HOST_JSON_LIMIT, `overflowBytes ${snap.overflowBytes}`)
    assert.ok(L(snap) <= SNAPSHOT_BUDGET, `degraded size ${L(snap)}`)
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
    // Bodies are gone, but every card is still listed by name (see audit-memory-question-brief-stubs).
    assert.deepEqual([snap.topics, snap.memories], [[], []])
    assert.equal(snap.todos.length, 26)
    assert.ok(snap.todos.every(t => t.stub === true && t.phase === 'building' && t.spec === undefined))
    assert.equal(snap.counts.building, 26, 'counts still describe the full board')
    assert.equal(snap.concurrency.active, 26)
    assert.ok(snap.settings && typeof snap.settings.maxConcurrentBuilds === 'number')
    // A write made in this state is stored and reported as a success.
    const res = await tools.get('configure_chief').execute({ charter: 'new charter' }, run)
    assert.equal(res.ok, true)
    assert.equal(db.getSettings(1, 'default').charter, 'new charter')
    const saved = await orch.saveSettings(run, { notifySound: false })
    assert.equal(saved.snapshotOverflow, true, 'the write returns the degraded board, not an error')
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', saved))
    assert.equal(db.getSettings(1, 'default').notifySound, false)
    // The Chief's self-inspection tool keeps working.
    const cfg = await tools.get('get_system_config').execute({}, run)
    assert.equal(cfg.ok, true)
    assert.equal(db.listTodos(1, 'default').length, 26, 'nothing is deleted')
  } finally { ctx.cleanup() }
})

test('audit#11 r3: 45 review cards with full plans load; the oldest review cards are left out, running cards never', () => {
  const planCard = (id, phase, updatedAt) => ({ id, phase, updatedAt, diffs: [], lastError: '', spec: 's', plan: 'p'.repeat(49_000), timeline: [], buildChat: [] })
  const todos = [
    ...Array.from({ length: 3 }, (_, i) => planCard(`bd-${i}`, ['building', 'reviewing', 'merging'][i], i)),
    ...Array.from({ length: 45 }, (_, i) => planCard(`rv-${i}`, 'review', 100 + i)),
  ]
  const fitted = fitSnapshotBudget({ topics: [], todos })
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.snapshotOverflow, undefined)
  assert.equal(fitted.todos.length + fitted.todosOmitted, 48)
  for (const id of ['bd-0', 'bd-1', 'bd-2']) assert.ok(fitted.todos.some(t => t.id === id), `${id} stays`)
  const keptReview = fitted.todos.filter(t => t.phase === 'review').map(t => t.updatedAt)
  assert.ok(keptReview.length > 0 && keptReview.length < 45)
  assert.equal(Math.min(...keptReview), 100 + (45 - keptReview.length), 'exactly the oldest review cards are left out')
})

/* ---------- Must-fix 3: unrelated updates never truncate stored text ---------- */

test('audit#11 r3: appendTimeline and a title-only update leave an oversized stored spec, plan and worker chat untouched', async () => {
  const ctx = setup()
  try {
    const { db, project } = ctx
    const t = db.createTodo(1, 'default', { projectId: project.id, title: 'legacy', spec: 'seed' })
    const legacy = {
      spec: `SPEC ${'s'.repeat(200_000)} SPEC-TAIL`,
      plan: `PLAN ${'p'.repeat(60_000)}`,
      title: `TITLE ${'t'.repeat(500)}`,
      chat: JSON.stringify(Array.from({ length: 40 }, (_, k) => ({ role: 'r', time: '', text: `${k} `.padEnd(9000, 'c') }))),
      err: `ERR ${'e'.repeat(50_000)}`,
    }
    ctx.rawWrite(raw => raw.prepare('UPDATE todos SET spec = ?, plan = ?, title = ?, build_chat_json = ?, last_error = ? WHERE id = ?').run(legacy.spec, legacy.plan, legacy.title, legacy.chat, legacy.err, t.id))
    const read = () => ctx.rawRead(raw => raw.prepare('SELECT spec, plan, title, build_chat_json AS chat, last_error AS err, timeline_json FROM todos WHERE id = ?').get(t.id))

    db.appendTimeline(1, 'default', t.id, 'unrelated event', 'system')
    let row = read()
    assert.equal(row.spec.length, legacy.spec.length, 'spec is not truncated by appendTimeline')
    assert.ok(row.spec.endsWith('SPEC-TAIL'))
    assert.equal(row.plan, legacy.plan)
    assert.equal(row.title, legacy.title)
    assert.equal(row.chat, legacy.chat)
    assert.equal(row.err, legacy.err)
    assert.ok(JSON.parse(row.timeline_json).some(e => e.event === 'unrelated event'))

    db.updateTodo(1, 'default', t.id, { title: 'only the title' })
    row = read()
    assert.equal(row.title, 'only the title')
    assert.equal(row.spec, legacy.spec, 'spec is not truncated by a title-only update')
    assert.equal(row.plan, legacy.plan)
    assert.equal(row.chat, legacy.chat)

    // Workers still read the full text; the board view is shortened and marked.
    assert.equal(db.getTodo(1, 'default', t.id).spec, legacy.spec)
    const snap = await ctx.orch.getSnapshot(ctx.run)
    const view = snap.todos.find(x => x.id === t.id)
    assert.ok(view.spec.length <= 20_000 && view.specTrimmed === true)
    assert.ok(Buffer.byteLength(view.plan) <= 50_000 && view.planTrimmed === true)
    assert.ok(view.buildChat.length <= 24 && view.buildChat.every(m => m.text.length <= 4000) && view.buildChatTrimmed === true)
    assert.equal(read().spec, legacy.spec, 'reading the board does not rewrite the row')

    // A patch that does carry the field is still capped.
    db.updateTodo(1, 'default', t.id, { spec: `NEW ${'n'.repeat(200_000)}` })
    assert.ok(read().spec.length <= 20_000)
    assert.equal(read().plan, legacy.plan, 'and still leaves the other fields alone')
  } finally { ctx.cleanup() }
})

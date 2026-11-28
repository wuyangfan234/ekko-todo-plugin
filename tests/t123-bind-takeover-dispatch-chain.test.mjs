// Todo #123: "bind the project → take the card over → dispatch" is one chain the Chief walks by itself.
// #121 lets a Chief bind its own topic (set_topic_project). A card that already exists is still managed by
// another topic (#117), so run_build answers TODO_TOPIC_NOT_MANAGER, and nothing told the Chief what to do
// next. This card changes words only: the Chief instructions and the two refusal texts name the next call.
// No rule of #117 or #121 is changed: binding a topic never moves a card, and a card moves only through
// watch_todos with take_over: true.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import { buildChiefInstructions } from '../src/server/prompts.mjs'

const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const MISMATCH = 'TOPIC_PROJECT_MISMATCH'
const NOT_MANAGER = 'TODO_TOPIC_NOT_MANAGER'

function initRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test User')
  writeFileSync(join(repoDir, 'app.txt'), 'ok\n', 'utf8')
  git('add', '.')
  git('commit', '-m', 'init')
}

// Project alpha with two Chief topics, T2 (sess-t2, the one that manages the card) and T3 (sess-t3), and
// T1 (sess-t1): a Chief topic without a project.
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t123-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn() {}, info() {} } })
  const working = new Map()
  let seq = 0
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(body) { seq += 1; return { session: { id: `s-${seq}`, title: body?.title } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async get(sid) { return { session: { id: sid, ended_at: null }, is_running: Boolean(working.get(sid)) } },
      async connect(sid, cb) {
        setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(working.get(sid)), runStartedAt: Date.now() }), 2)
        return { close() {} }
      },
      async run(sid) { working.set(sid, true); return { run_id: `r-${sid}` } },
      async stop(sid) { working.set(sid, false) },
      async messages() { return { messages: [] } },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const runFrom = sessionId => ({ ...run, identity: { ...run.identity, sessionId } })
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const dir = join(root, 'alpha')
  initRepo(dir)
  const alpha = (await orch.addProject(run, { name: 'alpha', repoPath: dir })).project
  const chiefTopic = async (sessionId, input = {}) => {
    const { topic } = await orch.createTopic(run, input)
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  const t2 = await chiefTopic('sess-t2', { projectId: alpha.id, title: '原管理话题' })
  const t3 = await chiefTopic('sess-t3', { projectId: alpha.id, title: '同项目话题' })
  const t1 = await chiefTopic('sess-t1', { title: '新话题' })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const call = async (name, input, from = run) => {
    try { return await tools.get(name).execute(input, from) } catch (err) { return { ok: false, thrown: err?.message || String(err) } }
  }
  const card = (await orch.createTodo(run, { projectId: alpha.id, topicId: t2.id, title: '已有的卡' })).todo
  const todo = () => db.getTodo(1, 'default', card.id)
  const topicOf = id => db.getTopic(1, 'default', id)
  const activeWatches = () => db.getActiveWatchesForTodo(1, 'default', card.id).map(w => w.topicId)
  const systemTexts = topicId => topicOf(topicId).messages.filter(m => m.kind === 'system').map(m => m.text)
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, alpha, t1, t2, t3, card, todo, topicOf, activeWatches, systemTexts, call, tools, chiefTopic, cleanup }
}

const takeOverCall = (topic, card) => `watch_todos（topic_id 填 ${topic.id}，todo_id 填 ${card.id}，take_over: true）`

// ── instructions ─────────────────────────────────────────────────────────────────────────────────────

test('#123 instructions: a topic without a project is told the three steps in order, with its own topic id', async () => {
  const ctx = await setup()
  try {
    const { orch, run, alpha, t1, topicOf, chiefTopic } = ctx
    const detached = await chiefTopic('sess-detached', { title: '摘除过的话题' })
    await orch.updateTopicMeta(run, { topicId: detached.id, projectId: '' })
    const scope = topic => buildChiefInstructions({ topic, firstCardBinds: orch.topicBindsOnFirstCard(topic), projects: [alpha], agents: [], activeTodos: [], chiefAgent: {}, settings: {}, memories: [] })
      .split('\n').find(line => line.startsWith('PROJECT SCOPE:'))
    assert.equal(orch.topicBindsOnFirstCard(topicOf(t1.id)), true, 'fixture: the undecided branch')
    assert.equal(orch.topicBindsOnFirstCard(topicOf(detached.id)), false, 'fixture: the detached branch')
    for (const [name, topic] of [['undecided', topicOf(t1.id)], ['detached', topicOf(detached.id)]]) {
      const text = scope(topic)
      assert.match(text, /work on an existing card[^.]*three steps yourself/, name)
      // (1) bind, (2) take over when another topic manages the card, (3) act: in this order.
      assert.match(text, /\(1\) bind this topic with set_topic_project first.*\(2\) if that card is managed by another topic.*TODO_TOPIC_NOT_MANAGER.*call watch_todos \(topic_id [^,]+, todo_id of the card, take_over: true\).*\(3\) then act on the card/, name)
      assert.ok(text.includes(`call watch_todos (topic_id ${topic.id}, todo_id of the card, take_over: true)`), `${name}: take over into its own topic`)
      assert.match(text, /and the user did ask this topic to handle it/, `${name}: step 2 has its condition`)
    }
  } finally { ctx.cleanup() }
})

test('#123 instructions: taking over is never the Chief\'s own idea, in every branch', async () => {
  const ctx = await setup()
  try {
    const { orch, run, alpha, t1, t2, topicOf, chiefTopic } = ctx
    const detached = await chiefTopic('sess-detached', { title: '摘除过的话题' })
    await orch.updateTopicMeta(run, { topicId: detached.id, projectId: '' })
    const prompt = topic => buildChiefInstructions({ topic, firstCardBinds: orch.topicBindsOnFirstCard(topic), projects: [alpha], agents: [], activeTodos: [], chiefAgent: {}, settings: {}, memories: [] })
    const scope = text => text.split('\n').find(line => line.startsWith('PROJECT SCOPE:'))
    for (const [name, topic] of [['undecided', topicOf(t1.id)], ['detached', topicOf(detached.id)]]) {
      const text = scope(prompt(topic))
      assert.match(text, /Never take a card over on your own/, name)
      assert.match(text, /only mentions the card[^.]*do not take it over, only say which topic manages it/, name)
      assert.match(text, /Taking a card over makes its previous topic lose every progress notice of that card/, name)
    }
    // A topic that has a project: the sentence that was there is brought in line, and not written twice.
    const owned = prompt(topicOf(t2.id))
    const header = owned.split('\n').find(line => line.startsWith('Current Active Todos'))
    assert.match(header, /Never take a card over on your own/)
    assert.match(header, /only when the user, in this topic, explicitly asks for work on such a card[^.]*`watch_todos`[^.]*`take_over: true`[^.]*then act/)
    assert.match(header, /only mentions the card[^.]*only say which topic manages it/)
    assert.match(header, /lose every progress notice of that card/)
    assert.doesNotMatch(header, /unless the user explicitly asks this topic to manage it/, 'the old condition asked for more than "work on this card here"')
    assert.doesNotMatch(scope(owned), /three steps yourself/, 'not repeated in the scope of a topic that has a project')
    // The same header is part of the instructions of the two other branches.
    assert.ok(prompt(topicOf(t1.id)).includes(header))
  } finally { ctx.cleanup() }
})

// ── refusal texts ────────────────────────────────────────────────────────────────────────────────────

test('#123 TODO_TOPIC_NOT_MANAGER: the answer names set_topic_project and the take_over call, and no longer sends the user to the other topic', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, t2, t3, card, todo, activeWatches } = ctx
    for (const [name, input] of [['run_build', { todo_id: card.id }], ['watch_todos', { topic_id: t3.id, todo_id: card.id }]]) {
      const res = await call(name, input, runFrom('sess-t3'))
      assert.equal(res.error, NOT_MANAGER, `${name}: ${res.content || res.thrown}`)
      assert.ok(res.content.includes(`由话题「原管理话题」（${t2.id}）管理`), res.content)
      assert.ok(res.content.includes('本话题已属于卡片的项目 alpha，不必再调用 set_topic_project'), res.content)
      assert.ok(res.content.includes(`直接调用 ${takeOverCall(t3, card)}接管，然后再行动`), res.content)
      assert.ok(res.content.includes('用户在本话题明确要求处理这张卡时'), 'the condition comes first')
      assert.ok(res.content.includes('不得主动接管'), res.content)
      assert.ok(res.content.includes('只告知它由话题「原管理话题」管理'), res.content)
      assert.ok(res.content.includes('原话题不再收到它的进展'), res.content)
      assert.equal(res.content.includes('请到话题'), false, 'the user is not sent to another topic')
      assert.ok(res.content.indexOf('set_topic_project') < res.content.indexOf('take_over: true'))
    }
    assert.equal(todo().topicId, t2.id, 'a refusal moves nothing')
    assert.deepEqual(activeWatches(), [t2.id])
  } finally { ctx.cleanup() }
})

test('#123 TOPIC_PROJECT_MISMATCH for a topic without a project: bind first, then take over, then act', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, alpha, t1, t2, card, todo, activeWatches, topicOf } = ctx
    for (const [name, input] of [['run_build', { todo_id: card.id }], ['watch_todos', { topic_id: t1.id, todo_id: card.id, take_over: true }]]) {
      const res = await call(name, input, runFrom('sess-t1'))
      assert.equal(res.error, MISMATCH, `${name}: ${res.content || res.thrown}`)
      const bind = res.content.indexOf(`也可以直接调用 set_topic_project（topic_id ${t1.id}，project_id ${alpha.id}）把本话题绑定到项目 alpha`)
      const take = res.content.indexOf(`再调用 ${takeOverCall(t1, card)}接管，然后行动`)
      assert.ok(bind >= 0, res.content)
      assert.ok(take > bind, `take over is named after binding: ${res.content}`)
      assert.ok(res.content.includes('且用户确实是在本话题要求处理它'), res.content)
      assert.ok(res.content.includes('不得主动接管'), res.content)
      assert.ok(res.content.includes('原话题不再收到它的进展'), res.content)
    }
    assert.equal(topicOf(t1.id).projectId, '', 'a refusal binds nothing')
    assert.equal(todo().topicId, t2.id)
    assert.deepEqual(activeWatches(), [t2.id])
  } finally { ctx.cleanup() }
})

// ── the chain, end to end ────────────────────────────────────────────────────────────────────────────

test('#123 end to end: from a topic without a project the Chief binds, takes the card over and dispatches it, following each answer', async () => {
  const ctx = await setup()
  try {
    const { orch, call, runFrom, alpha, t1, t2, card, todo, topicOf, activeWatches, systemTexts } = ctx
    const chief = runFrom('sess-t1')
    assert.equal(todo().topicId, t2.id, 'fixture: the card is managed by T2')
    assert.deepEqual(activeWatches(), [t2.id])
    // The user says "dispatch that card" in T1. Before anything: refused, and the answer names step 1.
    const first = await call('run_build', { todo_id: card.id }, chief)
    assert.equal(first.error, MISMATCH, first.content || first.thrown)
    assert.match(first.content, /set_topic_project/)
    // Step 1: bind. The card does not move with the topic.
    const bound = await call('set_topic_project', { topic_id: t1.id, project_id: alpha.id, reason: '用户要求在本话题处理已有卡' }, chief)
    assert.equal(bound.ok, true, bound.content || bound.thrown)
    assert.equal(topicOf(t1.id).projectId, alpha.id)
    assert.equal(todo().topicId, t2.id, 'binding a topic takes no card over')
    assert.deepEqual(activeWatches(), [t2.id])
    // Still refused, now as not the manager, and the answer names step 2 with the ids to use.
    const second = await call('run_build', { todo_id: card.id }, chief)
    assert.equal(second.error, NOT_MANAGER, second.content || second.thrown)
    assert.ok(second.content.includes(takeOverCall(t1, card)), second.content)
    assert.equal(orch.chiefTodoScopeCheck(chief, 'run_build', card.id).code, NOT_MANAGER)
    assert.equal(todo().phase, 'todo', 'not started')
    // A plain watch is no take-over.
    assert.equal((await call('watch_todos', { topic_id: t1.id, todo_id: card.id }, chief)).error, NOT_MANAGER)
    assert.equal(todo().topicId, t2.id)
    // Step 2: take over, exactly the call the answer named.
    const taken = await call('watch_todos', { topic_id: t1.id, todo_id: card.id, take_over: true, reason: '用户在本话题要求派工' }, chief)
    assert.equal(taken.ok, true, taken.content || taken.thrown)
    assert.deepEqual(taken.data, { topicId: t1.id, todoId: card.id, tookOver: true, fromTopicId: t2.id })
    assert.equal(todo().topicId, t1.id, 'todos.topic_id is T1')
    assert.deepEqual(activeWatches(), [t1.id], 'T2 has no active watch left')
    assert.equal(systemTexts(t2.id).filter(t => t.startsWith('管理权转移')).length, 1, 'T2 is told once')
    assert.equal(systemTexts(t1.id).filter(t => t.startsWith('管理权转移')).length, 1)
    // Step 3: act. #117 holds the other way round now.
    assert.equal(orch.chiefTodoScopeCheck(chief, 'run_build', card.id), null, 'run_build is no longer refused')
    assert.equal(orch.chiefTodoScopeCheck(runFrom('sess-t2'), 'run_build', card.id).code, NOT_MANAGER, 'the previous topic reads only')
    const started = await call('run_build', { todo_id: card.id }, chief)
    assert.equal(started.ok, true, started.content || started.thrown)
    assert.equal(todo().phase, 'building')
  } finally { ctx.cleanup() }
})

// ── contract, documents, bundle, version ─────────────────────────────────────────────────────────────

test('#123: the contract, the documents, the server bundle and the version carry the chain', () => {
  const watch = contract.tools.watch_todos.description
  for (const word of ['#123', 'set_topic_project', 'take_over', 'never on its own']) assert.ok(watch.includes(word), `watch_todos contract has ${word}`)
  const docs = read('docs/CONTRACTS.md')
  assert.match(docs, /#123/)
  assert.ok(docs.includes('不必再调用 set_topic_project'), 'CONTRACTS.md quotes the new TODO_TOPIC_NOT_MANAGER text')
  assert.equal(docs.split('请到话题「<title>」操作；只有用户明确要求由本话题接管时').length - 1, 1, 'the old text is quoted once')
  assert.ok(docs.includes('before it the part after `本次未做任何改动。` read `请到话题「<title>」操作；'), 'and only as what it was before #123')
  const bundle = read('dist/server.mjs')
  for (const literal of ['three steps yourself', 'Never take a card over on your own']) assert.ok(bundle.includes(literal), `server bundle has ${literal}`)
  // Chinese literals may be written as \uXXXX in the bundle: count both forms.
  const esc = text => [...text].map(c => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('')
  const has = text => bundle.includes(text) || bundle.toLowerCase().includes(esc(text).toLowerCase())
  assert.ok(has('看板') || has('话题'), 'control: the way of counting finds a text that is surely there')
  for (const literal of ['不得主动接管', '不必再调用 set_topic_project']) assert.ok(has(literal), `server bundle has ${literal}`)
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  assert.ok(major > 0 || minor > 9 || (minor === 9 && patch >= 78), `version ${pkg.version} is 0.9.78 or later`)
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(contract.description.includes(`v${pkg.version} `))
  assert.match(read('CHANGELOG.md'), /## \[0\.9\.78\][\s\S]*?#123/)
})

// Todo #118: the first card a Chief creates in a topic whose project was never decided binds that topic to the
// card's project, instead of sending the card to another topic. Before it, such a topic could do nothing until
// the user set its project by hand (topic menu 改挂项目).
// The binding is written into topics.project_id, so it happens only when all of these hold:
//   G1  the call comes through the create_todo tool (the page RPC never binds);
//   G2  the caller is known: identity.sessionId is the topic's Chief session, or, without a session id,
//       exactly one Chief session has create_todo open under its own name and no session that is no Chief has;
//   G3  a tool_call wrapper, a Chief that is merely running, and several candidates never bind;
//   G4  the topic is not archived, has no project and no topic-adopt row, and the project exists;
//   G5  the row, the topic's project, the card, its watch and the system message are one transaction.
// The fixture topic is made here and never touched by update-topic: the "loose" topic of the #97 tests has its
// topic-adopt row written by the fixture, so it can never be bound and a test using it would pass for nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import { registerAllRpcs } from '../src/server/rpc-handlers.mjs'
import { buildChiefInstructions } from '../src/server/prompts.mjs'

const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const MISMATCH = 'TOPIC_PROJECT_MISMATCH'
const CREATE_TOOL = 'mcp__ekko_todo__ekko_todo__create_utodo'

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

// Two projects, alpha and beta, each with a Chief topic (sess-alpha / sess-beta), and `fresh`: a Chief topic
// (sess-fresh) made without a project and without a topic-adopt row.
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t118-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  const infos = []
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn() {}, info(message, data) { infos.push({ message, data }) } } })
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
  const addRepo = async name => {
    const dir = join(root, name)
    initRepo(dir)
    return (await orch.addProject(run, { name, repoPath: dir })).project
  }
  const alpha = await addRepo('alpha')
  const beta = await addRepo('beta')
  const chiefTopic = async (sessionId, input = {}) => {
    const { topic } = await orch.createTopic(run, input)
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  const topicA = await chiefTopic('sess-alpha', { projectId: alpha.id, title: '甲项目话题' })
  const topicB = await chiefTopic('sess-beta', { projectId: beta.id, title: '乙项目话题' })
  const fresh = await chiefTopic('sess-fresh', { title: '新话题' })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const call = async (name, input, from = run) => {
    try { return await tools.get(name).execute(input, from) } catch (err) { return { ok: false, thrown: err?.message || String(err) } }
  }
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const sql = (text, ...params) => {
    const raw = new DatabaseSync(sqlitePath)
    try { return raw.prepare(text).run(...params) } finally { raw.close() }
  }
  const scalar = (text, ...params) => {
    const raw = new DatabaseSync(sqlitePath, { readOnly: true })
    try { return raw.prepare(text).get(...params).n } finally { raw.close() }
  }
  const counts = () => ({
    todos: scalar('SELECT COUNT(*) AS n FROM todos'),
    watches: scalar('SELECT COUNT(*) AS n FROM todo_watches'),
    topics: scalar('SELECT COUNT(*) AS n FROM topics'),
    messages: scalar('SELECT COUNT(*) AS n FROM topic_messages'),
    wakes: scalar('SELECT COUNT(*) AS n FROM wake_log'),
  })
  const adoptRows = topicId => scalar('SELECT COUNT(*) AS n FROM wake_log WHERE wake_key = ?', `topic-adopt:${topicId}`)
  const topicOf = id => db.getTopic(1, 'default', id)
  const hostEvent = (type, sessionId, data = {}) => orch.handleHostEvent({ type, data: { session_id: sessionId, ...data } }, run)
  const systemTexts = topicId => topicOf(topicId).messages.filter(m => m.kind === 'system').map(m => m.text)
  // The state a bound topic must be in after its first card.
  const assertBound = (topic, project, todoId) => {
    const now = topicOf(topic.id)
    assert.equal(now.projectId, project.id, 'topics.project_id is the project of the card')
    assert.equal(adoptRows(topic.id), 1, 'the topic-adopt row is written once')
    const todo = db.getTodo(1, 'default', todoId)
    assert.equal(todo.topicId, topic.id, 'the card stays in the calling topic')
    assert.equal(todo.projectId, project.id)
    assert.equal(orch.topicManagesTodo(now, todo), true, 'the bound topic is the managing topic of the card (#117)')
    assert.deepEqual(now.watchedTodoIds, [todoId], 'and watches it')
    const said = systemTexts(topic.id)
    assert.equal(said.length, 1)
    assert.equal(said[0], `话题已绑定到项目 ${project.name}（依据总管在本话题创建的第一张卡 #${todo.number}）。之后本话题只处理该项目的卡片；如挂错，在话题菜单「改挂项目」更换。`)
  }
  // The state of a topic that was not bound.
  const assertUnbound = (topic, keyRows = 0) => {
    const now = topicOf(topic.id)
    assert.equal(now.projectId, '', 'the topic still has no project')
    assert.equal(adoptRows(topic.id), keyRows)
    assert.deepEqual(now.watchedTodoIds, [], 'it watches nothing')
    assert.equal(systemTexts(topic.id).length, 0, 'nothing was written into it')
  }
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, alpha, beta, topicA, topicB, fresh, tools, call, sql, scalar, counts, adoptRows, topicOf, hostEvent, systemTexts, assertBound, assertUnbound, chiefTopic, addRepo, infos, cleanup }
}

// ── 1. the topic is bound ────────────────────────────────────────────────────────────────────────────

test('#118 bind: the first card made by the topic\'s own Chief session binds a topic without a project to the card\'s project', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, alpha, fresh, topicA, assertBound, counts, infos } = ctx
    assert.equal(ctx.adoptRows(fresh.id), 0, 'fixture: the topic-adopt row is not written, or nothing below would be tested')
    assert.equal(ctx.orch.topicBindsOnFirstCard(ctx.topicOf(fresh.id)), true)
    const before = counts()
    const res = await call('create_todo', { project_id: alpha.id, title: '新话题里的第一张卡' }, runFrom('sess-fresh'))
    assert.equal(res.ok, true, res.thrown)
    assert.equal(res.data.topicId, fresh.id)
    assert.equal(res.data.topicResolvedBy, 'caller-session')
    assert.equal(res.data.topicBoundProjectId, alpha.id)
    assert.equal('topicRedirectedFrom' in res.data, false, 'the card was not sent elsewhere')
    // The instructions of this turn still say "no project": the answer names the project, its repository and the way back.
    assert.match(res.content, /本话题原先没有项目，已绑定到项目 alpha（/)
    assert.ok(res.content.includes(alpha.id) && res.content.includes(alpha.repoPath), 'project id and repository path')
    assert.match(res.content, /如挂错可在话题菜单「改挂项目」更换/)
    assertBound(fresh, alpha, res.data.id)
    const after = counts()
    assert.deepEqual(after, { todos: before.todos + 1, watches: before.watches + 1, topics: before.topics, messages: before.messages + 1, wakes: before.wakes + 1 }, 'one card, one watch, one message, one row; no topic is created')
    assert.equal(ctx.topicOf(topicA.id).watchedTodoIds.length, 0, 'the project\'s other topic gets nothing')
    assert.ok(ctx.db.getTodo(1, 'default', res.data.id).timeline.some(e => /本卡是话题里的第一张卡：话题已绑定到项目 alpha/.test(e.event || e.text || JSON.stringify(e))), 'said on the card timeline')
    assert.ok(infos.some(i => i.message === 'Topic without a project bound to the project of the first card its Chief created' && i.data.topicId === fresh.id && i.data.projectId === alpha.id))
    assert.equal(ctx.orch.topicBindsOnFirstCard(ctx.topicOf(fresh.id)), false, 'bound once')
  } finally { ctx.cleanup() }
})

test('#118 bind: without a session id, the one Chief session that has create_todo open under its own name is the caller', async () => {
  const ctx = await setup()
  try {
    const { call, run, beta, fresh, hostEvent, assertBound } = ctx
    await hostEvent('chat.tool.started', 'sess-fresh', { name: CREATE_TOOL })
    assert.deepEqual({ by: ctx.orch.resolveChiefCaller(run, 'create_todo').by, tier: ctx.orch.resolveChiefCaller(run, 'create_todo').tier }, { by: 'caller-tool', tier: 'by-name' })
    const res = await call('create_todo', { project_id: beta.id, title: '不带会话身份的第一张卡' })
    assert.equal(res.ok, true, res.thrown)
    assert.equal(res.data.topicId, fresh.id)
    assert.equal(res.data.topicResolvedBy, 'caller-tool')
    assert.equal(res.data.topicBoundProjectId, beta.id)
    assertBound(fresh, beta, res.data.id)
  } finally { ctx.cleanup() }
})

test('#118 bind: topic_id set to the caller\'s own topic binds too; before it was refused', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, alpha, fresh, assertBound } = ctx
    const res = await call('create_todo', { project_id: alpha.id, topic_id: fresh.id, title: '把 Current Topic 的 id 填进了 topic_id' }, runFrom('sess-fresh'))
    assert.equal(res.ok, true, res.thrown)
    assert.equal(res.data.topicResolvedBy, 'explicit')
    assert.equal(res.data.topicBoundProjectId, alpha.id)
    assertBound(fresh, alpha, res.data.id)
  } finally { ctx.cleanup() }
})

test('#118 bind: the bound topic dispatches the card in the same turn, keeps its project, and sends a card of another project elsewhere', async () => {
  const ctx = await setup()
  try {
    const { db, orch, call, runFrom, alpha, beta, fresh, topicB } = ctx
    const from = runFrom('sess-fresh')
    // Before the first card every tool refuses this topic.
    assert.equal((await call('list_todos', {}, from)).error, MISMATCH)
    const first = await call('create_todo', { project_id: alpha.id, title: '第一张卡' }, from)
    assert.equal(first.data.topicBoundProjectId, alpha.id)
    assert.equal(orch.chiefTodoScopeCheck(from, 'run_build', first.data.id), null, 'the scope guard reads the topic as stored now')
    const built = await call('run_build', { todo_id: first.data.id }, from)
    assert.equal(built.ok, true, built.thrown || built.content)
    assert.equal(db.getTodo(1, 'default', first.data.id).phase, 'building')
    const listed = await call('list_todos', {}, from)
    assert.equal(listed.ok, true)
    assert.equal(listed.data.projectId, alpha.id)
    // A second card of the same project: same topic, nothing bound again.
    const second = await call('create_todo', { project_id: alpha.id, title: '第二张卡' }, from)
    assert.equal(second.data.topicId, fresh.id)
    assert.equal(second.data.topicResolvedBy, 'caller-session')
    assert.equal('topicBoundProjectId' in second.data, false)
    assert.doesNotMatch(second.content, /已绑定到项目/)
    // A card of another project: the usual way (#97), the topic's project is not changed.
    const other = await call('create_todo', { project_id: beta.id, title: '别的项目的卡' }, from)
    assert.equal(other.data.topicId, topicB.id)
    assert.equal(other.data.topicRedirectedFrom, fresh.id)
    assert.equal('topicBoundProjectId' in other.data, false)
    assert.equal(ctx.topicOf(fresh.id).projectId, alpha.id, 'a project that is set is never changed by a card')
    assert.equal(ctx.adoptRows(fresh.id), 1)
    assert.equal(ctx.systemTexts(fresh.id).filter(t => t.startsWith('话题已绑定到项目')).length, 1)
  } finally { ctx.cleanup() }
})

// ── 2. the topic is not bound ────────────────────────────────────────────────────────────────────────

test('#118 G1: the page RPC and a createTodo call without the tool\'s switch never bind, whoever calls', async () => {
  const ctx = await setup()
  try {
    const { orch, runFrom, alpha, fresh, topicA, hostEvent, assertUnbound } = ctx
    const handlers = new Map()
    registerAllRpcs({ extensions: { rpc: { register(name, handler) { handlers.set(name, handler); return () => {} } } } }, contract, orch)
    // The strongest evidence there is: the topic's own session id, and create_todo open by name.
    await hostEvent('chat.tool.started', 'sess-fresh', { name: CREATE_TOOL })
    const state = await handlers.get('create-todo')({ projectId: alpha.id, title: '页面建卡' }, runFrom('sess-fresh'))
    const made = state.todos.find(t => t.title === '页面建卡')
    assert.equal(made.topicId, topicA.id, 'the card goes to a topic of its project')
    assertUnbound(fresh)
    const direct = await orch.createTodo(runFrom('sess-fresh'), { projectId: alpha.id, title: '内部调用', actor: 'chief' })
    assert.equal(direct.topicBoundProject, null)
    assert.equal(direct.topicRedirectedFrom.topicId, fresh.id)
    assertUnbound(fresh)
    // The page RPC has no way to ask for the binding: the switch is not part of createTodoInput.
    await assert.rejects(async () => handlers.get('create-todo')({ projectId: alpha.id, title: '带开关的页面请求', bindCallerTopic: true }, runFrom('sess-fresh')))
    assertUnbound(fresh)
  } finally { ctx.cleanup() }
})

test('#118 G3: a tool_call wrapper shows that some tool is open, not which: the topic is not bound and the card goes the usual way', async () => {
  const ctx = await setup()
  try {
    const { orch, call, run, alpha, fresh, topicA, hostEvent, assertUnbound } = ctx
    await hostEvent('chat.run.started', 'sess-fresh')
    await hostEvent('chat.tool.started', 'sess-fresh', { name: 'tool_call' })
    const caller = orch.resolveChiefCaller(run, 'create_todo')
    assert.deepEqual({ by: caller.by, tier: caller.tier, ids: caller.topics.map(t => t.id), ambiguous: caller.ambiguous }, { by: 'caller-tool', tier: 'wrapper', ids: [fresh.id], ambiguous: false }, 'one candidate, not ambiguous: only the tier keeps it from binding')
    assert.equal(orch.firstCardBindTopic(run), null)
    const res = await call('create_todo', { project_id: alpha.id, title: '经包装调用' })
    assert.equal(res.ok, true, res.thrown)
    assert.equal(res.data.topicId, topicA.id)
    assert.equal('topicBoundProjectId' in res.data, false)
    assert.equal(res.data.topicRedirectedFrom, fresh.id, 'the #97 redirect, as before')
    assertUnbound(fresh)
  } finally { ctx.cleanup() }
})

test('#118 G3: a Chief that is merely running (active-run) is a guess: the topic is not bound', async () => {
  const ctx = await setup()
  try {
    const { orch, call, run, alpha, fresh, topicA, hostEvent, assertUnbound } = ctx
    await hostEvent('chat.run.started', 'sess-fresh')
    const caller = orch.resolveChiefCaller(run, 'create_todo')
    assert.deepEqual({ by: caller.by, tier: caller.tier, ids: caller.topics.map(t => t.id), ambiguous: caller.ambiguous }, { by: 'active-run', tier: 'active-run', ids: [fresh.id], ambiguous: false })
    const res = await call('create_todo', { project_id: alpha.id, title: '只有它在跑' })
    assert.equal(res.ok, true, res.thrown)
    assert.equal(res.data.topicId, topicA.id)
    assert.equal('topicBoundProjectId' in res.data, false)
    assertUnbound(fresh)
    // A build worker of project alpha creating a card while this Chief runs is the case the guard is for.
    assert.equal(orch.resolveChiefCaller(run, 'create_todo').topics[0].id, fresh.id)
  } finally { ctx.cleanup() }
})

test('#118 G2: two Chief sessions, or a Chief and a session that is no Chief, with create_todo open by name: nobody is bound', async () => {
  const ctx = await setup()
  try {
    const { orch, call, run, alpha, fresh, topicA, hostEvent, assertUnbound, chiefTopic } = ctx
    const second = await chiefTopic('sess-fresh-2', { title: '另一个新话题' })
    await hostEvent('chat.tool.started', 'sess-fresh', { name: CREATE_TOOL })
    await hostEvent('chat.tool.started', 'sess-fresh-2', { name: CREATE_TOOL })
    const two = orch.resolveChiefCaller(run, 'create_todo')
    assert.equal(two.tier, 'by-name')
    assert.equal(two.topics.length, 2)
    const res = await call('create_todo', { project_id: alpha.id, title: '两个候选' })
    assert.equal(res.ok, true, res.thrown)
    assert.equal(res.data.topicId, topicA.id)
    assert.equal('topicBoundProjectId' in res.data, false)
    assertUnbound(fresh)
    assertUnbound(second)
    // One Chief left, plus a build worker (no topic's session) that has the tool open in the same tier.
    await hostEvent('chat.tool.completed', 'sess-fresh-2', { name: CREATE_TOOL })
    await hostEvent('chat.tool.started', 'sess-worker', { name: CREATE_TOOL })
    const mixed = orch.resolveChiefCaller(run, 'create_todo')
    assert.deepEqual({ tier: mixed.tier, ids: mixed.topics.map(t => t.id), ambiguous: mixed.ambiguous }, { tier: 'by-name', ids: [fresh.id], ambiguous: true })
    const again = await call('create_todo', { project_id: alpha.id, title: '总管和工人都开着' })
    assert.equal('topicBoundProjectId' in again.data, false)
    assertUnbound(fresh)
    // Control: with the worker's call over, the same topic is bound.
    await hostEvent('chat.tool.completed', 'sess-worker', { name: CREATE_TOOL })
    const alone = await call('create_todo', { project_id: alpha.id, title: '只剩它一个' })
    assert.equal(alone.data.topicBoundProjectId, alpha.id)
    assert.equal(ctx.topicOf(fresh.id).projectId, alpha.id)
  } finally { ctx.cleanup() }
})

test('#118 G4: a topic the user detached (topic-adopt row written) is never bound, with or without topic_id', async () => {
  const ctx = await setup()
  try {
    const { orch, run, call, runFrom, alpha, fresh, topicA, assertUnbound, counts } = ctx
    // The user sets a project and takes it away again: the row stays.
    await orch.updateTopicMeta(run, { topicId: fresh.id, projectId: alpha.id })
    await orch.updateTopicMeta(run, { topicId: fresh.id, projectId: '' })
    assert.equal(ctx.adoptRows(fresh.id), 1)
    assert.equal(orch.topicBindsOnFirstCard(ctx.topicOf(fresh.id)), false)
    const res = await call('create_todo', { project_id: alpha.id, title: '摘除过项目的话题' }, runFrom('sess-fresh'))
    assert.equal(res.ok, true, res.thrown)
    assert.equal(res.data.topicId, topicA.id)
    assert.equal(res.data.topicRedirectedFrom, fresh.id)
    assert.equal('topicBoundProjectId' in res.data, false)
    assertUnbound(fresh, 1)
    const before = counts()
    const explicit = await call('create_todo', { project_id: alpha.id, topic_id: fresh.id, title: '显式指向它' }, runFrom('sess-fresh'))
    assert.match(explicit.thrown, /话题「新话题」未归属任何项目，不能创建项目 alpha 的卡片/)
    assert.deepEqual(counts(), before, 'a refused call stores nothing')
    assertUnbound(fresh, 1)
  } finally { ctx.cleanup() }
})

test('#118 G4: an archived topic is not bound, and a topic that has a project is never moved to another one by a card', async () => {
  const ctx = await setup()
  try {
    const { db, orch, call, runFrom, alpha, beta, fresh, topicA, topicB } = ctx
    db.updateTopic(1, 'default', fresh.id, { archived: true })
    assert.equal(orch.firstCardBindTopic(runFrom('sess-fresh')), null)
    const res = await call('create_todo', { project_id: alpha.id, title: '归档话题的总管建卡' }, runFrom('sess-fresh'))
    assert.equal(res.ok, true, res.thrown)
    assert.equal(res.data.topicId, topicA.id)
    assert.equal('topicBoundProjectId' in res.data, false)
    assert.equal(ctx.topicOf(fresh.id).projectId, '')
    assert.equal(ctx.adoptRows(fresh.id), 0)
    // topicA was created with its project, so it has no topic-adopt row either: only "has a project" protects it.
    assert.equal(ctx.adoptRows(topicA.id), 0)
    const cross = await call('create_todo', { project_id: beta.id, title: '甲话题里建乙项目的卡' }, runFrom('sess-alpha'))
    assert.equal(cross.data.topicId, topicB.id)
    assert.equal(cross.data.topicRedirectedFrom, topicA.id)
    assert.equal('topicBoundProjectId' in cross.data, false)
    assert.equal(ctx.topicOf(topicA.id).projectId, alpha.id)
    assert.equal(ctx.adoptRows(topicA.id), 0)
  } finally { ctx.cleanup() }
})

test('#118 G4: an unknown project, and a topic_id that names another topic without a project, are refused and nothing is bound', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, alpha, fresh, assertUnbound, counts, chiefTopic } = ctx
    const other = await chiefTopic('sess-other', { title: '别人的新话题' })
    const before = counts()
    const gone = await call('create_todo', { project_id: 'proj-missing', title: '项目不存在' }, runFrom('sess-fresh'))
    assert.match(gone.thrown, /Project not found: proj-missing/)
    // The caller is `fresh`; the topic it names is another one whose project was never decided either.
    const named = await call('create_todo', { project_id: alpha.id, topic_id: other.id, title: '指向别人的无项目话题' }, runFrom('sess-fresh'))
    assert.match(named.thrown, /话题「别人的新话题」未归属任何项目，不能创建项目 alpha 的卡片/)
    assert.deepEqual(counts(), before, 'neither call stores anything')
    assertUnbound(fresh)
    assertUnbound(other)
  } finally { ctx.cleanup() }
})

// ── 3. atomic, and two calls at once ─────────────────────────────────────────────────────────────────

test('#118 G5: when one write of the binding fails nothing is stored (no row, no project, no card, no watch), and the next call binds', async () => {
  const ctx = await setup()
  try {
    const { db, call, runFrom, alpha, fresh, assertBound, assertUnbound, counts } = ctx
    const before = counts()
    const real = db.addTopicMessage
    let failed = 0
    // The last write of the transaction: everything before it has been written by then.
    db.addTopicMessage = (...args) => { failed += 1; throw new Error('disk I/O error (injected)') }
    const res = await call('create_todo', { project_id: alpha.id, title: '写系统消息时失败' }, runFrom('sess-fresh'))
    db.addTopicMessage = real
    assert.equal(failed, 1, 'the injected failure was reached')
    assert.match(res.thrown, /disk I\/O error \(injected\)/)
    assert.deepEqual(counts(), before, 'no card, watch, message, topic or wake_log row is left')
    assertUnbound(fresh)
    assert.equal(ctx.orch.topicBindsOnFirstCard(ctx.topicOf(fresh.id)), true, 'the topic can still be bound')
    const retry = await call('create_todo', { project_id: alpha.id, title: '重试' }, runFrom('sess-fresh'))
    assert.equal(retry.ok, true, retry.thrown)
    assert.equal(retry.data.topicBoundProjectId, alpha.id)
    assert.equal(retry.data.number, 1, 'the card number of the failed call was not used up')
    assertBound(fresh, alpha, retry.data.id)
  } finally { ctx.cleanup() }
})

test('#118 two calls at once: the topic is bound once; the other card takes the usual way; a row taken in between means no binding', async () => {
  const ctx = await setup()
  try {
    const { db, call, runFrom, alpha, beta, fresh, topicA, topicB, chiefTopic, sql, assertUnbound } = ctx
    const [one, two] = await Promise.all([
      call('create_todo', { project_id: alpha.id, title: '并发甲' }, runFrom('sess-fresh')),
      call('create_todo', { project_id: beta.id, title: '并发乙' }, runFrom('sess-fresh')),
    ])
    assert.equal(one.ok && two.ok, true, one.thrown || two.thrown)
    const bound = [one, two].filter(r => 'topicBoundProjectId' in r.data)
    assert.equal(bound.length, 1, 'exactly one call binds')
    assert.equal(ctx.adoptRows(fresh.id), 1)
    const now = ctx.topicOf(fresh.id)
    assert.equal(now.projectId, bound[0].data.topicBoundProjectId)
    assert.equal(ctx.systemTexts(fresh.id).length, 1)
    const loser = [one, two].find(r => !('topicBoundProjectId' in r.data))
    assert.equal(loser.data.topicRedirectedFrom, fresh.id)
    assert.equal(loser.data.topicId, now.projectId === alpha.id ? topicB.id : topicA.id, 'the other card is in a topic of its own project')
    assert.deepEqual(now.watchedTodoIds, [bound[0].data.id])
    // The row is written by someone else between the check and the transaction: the check is repeated by the
    // write itself (INSERT OR IGNORE), nothing is bound and the card takes the usual way.
    const raced = await chiefTopic('sess-raced', { title: '被抢先的话题' })
    sql('INSERT INTO wake_log (wake_key, todo_id, topic_id, fired_at) VALUES (?, ?, ?, ?)', `topic-adopt:${raced.id}`, '', raced.id, Date.now())
    const realHas = db.hasWakeKey
    db.hasWakeKey = key => (key === `topic-adopt:${raced.id}` ? false : realHas(key))
    const res = await call('create_todo', { project_id: alpha.id, title: '检查之后键被写入' }, runFrom('sess-raced'))
    db.hasWakeKey = realHas
    assert.equal(res.ok, true, res.thrown)
    assert.equal('topicBoundProjectId' in res.data, false)
    assert.notEqual(res.data.topicId, raced.id)
    assert.equal(db.getTodo(1, 'default', res.data.id).projectId, alpha.id)
    assertUnbound(raced, 1)
  } finally { ctx.cleanup() }
})

// ── 4. what is said, and the contract ────────────────────────────────────────────────────────────────

test('#118 texts: the Chief of an undecided topic is told to create the card; a detached topic keeps the old sentence; topicScopeReason follows', async () => {
  const ctx = await setup()
  try {
    const { orch, run, fresh, topicA, alpha, chiefTopic } = ctx
    const detached = await chiefTopic('sess-detached', { title: '摘除过的话题' })
    await orch.updateTopicMeta(run, { topicId: detached.id, projectId: '' })
    const prompt = (topic, firstCardBinds) => buildChiefInstructions({ topic, firstCardBinds, projects: [alpha], agents: [], activeTodos: [], chiefAgent: {}, settings: {}, memories: [] })
    const open = prompt(ctx.topicOf(fresh.id), orch.topicBindsOnFirstCard(ctx.topicOf(fresh.id)))
    assert.match(open, /PROJECT SCOPE: this topic has no project yet\. The first card you create here fixes it: call create_todo with the correct project_id/)
    assert.match(open, /this topic is bound to that project/)
    assert.match(open, /Do not ask the user to set the project first/)
    assert.ok(open.includes(fresh.id), 'names its own topic id for topic_id')
    // #121: the gap #118 left (work on an existing card) is closed by set_topic_project; the user is no longer sent to the menu.
    // #123: that sentence became three steps (bind, take over, act); binding is still the first one.
    assert.match(open, /When the user asks, in this topic, for work on an existing card instead of a new one, do three steps yourself: \(1\) bind this topic with set_topic_project first/)
    assert.doesNotMatch(open, /this topic has no project, so it cannot list/)
    const closed = prompt(ctx.topicOf(detached.id), orch.topicBindsOnFirstCard(ctx.topicOf(detached.id)))
    // #121: a detached topic is still not bound by a card; its Chief binds it with set_topic_project.
    assert.match(closed, /PROJECT SCOPE: this topic has no project, so it cannot list, dispatch, review or merge any card yet, and a card you create here does not bind it\./)
    assert.doesNotMatch(closed, /The first card you create here fixes it/)
    const owned = prompt(ctx.topicOf(topicA.id), orch.topicBindsOnFirstCard(ctx.topicOf(topicA.id)))
    assert.match(owned, /PROJECT SCOPE: this topic belongs to project alpha/)
    // The same condition on the page-facing reason.
    const snap = await orch.getSnapshot(run)
    const reason = id => snap.topics.find(t => t.id === id).topicScopeReason
    assert.equal(reason(fresh.id).message, '本话题还没有绑定项目，总管会根据你说的事判断项目并自动绑定；也可以直接在总管那里说要绑定到哪个项目，或直接让总管建第一张卡，话题会自动固定到该卡的项目。绑定前总管不能在这里列卡、派工、审查或合并，也不会被卡片进展唤醒。')
    assert.equal(reason(detached.id).message, '本话题还没有绑定项目，总管会根据你说的事判断项目并自动绑定；也可以直接在总管那里说要绑定到哪个项目。绑定前总管不能在这里列卡、派工、审查或合并，也不会被卡片进展唤醒。')
    assert.equal(reason(fresh.id).code, 'no-project')
  } finally { ctx.cleanup() }
})

test('#118 contract: create_todo declares the binding and has no caller_topic_id; documents and the server bundle carry it', async () => {
  const ctx = await setup()
  try {
    const schema = ctx.tools.get('create_todo').inputSchema
    assert.deepEqual(Object.keys(schema.properties).sort(), ['agent_id', 'kind', 'project_id', 'spec', 'title', 'topic_id', 'with_plan'], 'no caller_topic_id: the caller is never taken from its own word here')
    assert.equal(schema.additionalProperties, false)
    assert.match(ctx.tools.get('create_todo').description, /topicBoundProjectId/)
  } finally { ctx.cleanup() }
  assert.match(contract.tools.create_todo.description, /#118/)
  assert.match(contract.tools.create_todo.description, /data\.topicBoundProjectId/)
  assert.match(contract.models.createTodoInput.properties.topicId.description, /#118/)
  assert.equal('bindCallerTopic' in contract.models.createTodoInput.properties, false, 'the switch is not an RPC input')
  const contracts = read('docs/CONTRACTS.md')
  assert.match(contracts, /First card binds a topic without a project \(#118/)
  for (const guard of ['G1', 'G2', 'G3', 'G4', 'G5']) assert.ok(contracts.includes(`${guard} `) || contracts.includes(`${guard}:`) || contracts.includes(`(${guard})`), `CONTRACTS.md names ${guard}`)
  assert.match(read('docs/FIELD_REFERENCE.md'), /topicBoundProjectId/)
  const bundle = read('dist/server.mjs')
  for (const literal of ['topicBoundProjectId', 'firstCardBindTopic', 'topicBindsOnFirstCard', 'bindCallerTopic']) assert.ok(bundle.includes(literal), `server bundle has ${literal}`)
})

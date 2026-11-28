// Todo #97: a topic handles cards of its own project only. Before it, a card could be created in, listed from,
// dispatched from and reported to a topic of another project (or of no project).
// Each rule is exercised through the function that enforces it: createTodo / resolveTodoTopic, the MCP tool
// wrapper (chiefTodoScopeViolation), chiefListScope, watchTodoFromTopic, maybeWakeChief (through settleWorkerRun)
// and repairTodoTopic. Every one of them decides through topicOwnsProject in src/server/orchestrator.mjs.
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
import { todoCardStub } from '../src/server/diff-budget.mjs'
import { validateModel } from '../sdk/harness/contracts.mjs'

const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const MISMATCH = 'TOPIC_PROJECT_MISMATCH'

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

// Two projects, alpha and beta, each with a Chief topic (sess-alpha / sess-beta), and a Chief topic without a
// project (sess-loose).
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t97-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  const warnings = []
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn(message, data) { warnings.push({ message, data }) }, info() {} } })
  const sessionRuns = []
  const working = new Map()
  const hostMessages = new Map()
  let seq = 0
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(body) { seq += 1; const id = `s-${seq}`; hostMessages.set(id, []); return { session: { id, title: body?.title } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async get(sid) { return { session: { id: sid, ended_at: null }, is_running: Boolean(working.get(sid)) } },
      async connect(sid, cb) {
        setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(working.get(sid)), runStartedAt: Date.now() }), 2)
        return { close() {} }
      },
      async run(sid, input, opts) { sessionRuns.push({ sid, input, opts }); working.set(sid, true); return { run_id: `r-${sessionRuns.length}` } },
      async stop(sid) { working.set(sid, false) },
      async messages(sid) { return { messages: hostMessages.get(sid) || [] } },
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
  const loose = await chiefTopic('sess-loose', { title: '无项目话题' })
  // The user decided that this topic has no project, so it is never adopted by a project (see "adopt" below).
  await orch.updateTopicMeta(run, { topicId: loose.id, projectId: '' })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  // A tool call the way the host makes it: a thrown refusal is reported as { thrown }.
  const call = async (name, input, from = run) => {
    try { return await tools.get(name).execute(input, from) } catch (err) { return { ok: false, thrown: err?.message || String(err) } }
  }
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const sql = (text, ...params) => {
    const raw = new DatabaseSync(sqlitePath)
    try { return raw.prepare(text).run(...params) } finally { raw.close() }
  }
  const count = table => {
    const raw = new DatabaseSync(sqlitePath, { readOnly: true })
    try { return raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n } finally { raw.close() }
  }
  // The stored state #97 is about: a card of one project linked to and watched by a topic of another.
  const dirtyCard = async (project, topic, title = '串台的旧卡片') => {
    const { todo } = await orch.createTodo(run, { projectId: project.id, title })
    const made = todo.topicId
    sql('UPDATE todos SET topic_id = ? WHERE id = ?', topic.id, todo.id)
    sql('DELETE FROM todo_watches WHERE todo_id = ?', todo.id)
    db.watchTodo(1, 'default', topic.id, todo.id, 'stored before #97')
    return { todo: db.getTodo(1, 'default', todo.id), madeTopicId: made }
  }
  // Ends the build round under way the way a finished host run is settled. A round has output (0.9.47: a
  // round that leaves the worktree as it was is an idle round).
  let built = 0
  const settleBuild = async todoId => {
    const cur = db.getTodo(1, 'default', todoId)
    assert.equal(cur.phase, 'building')
    built += 1
    writeFileSync(join(cur.worktreePath, `built-${built}.txt`), 'built\n')
    working.set(cur.buildSessionId, false)
    hostMessages.set(cur.buildSessionId, [{ id: `m${built}`, role: 'assistant', content: '完成。', timestamp: built }])
    return orch.settleWorkerRun(run, 1, 'default', todoId, { sessionId: cur.buildSessionId, outcome: 'completed' })
  }
  // Stored state from before #97, written straight into the tables: the card sits in `topic` and is watched by it.
  const moveRaw = (todo, topic) => {
    sql('UPDATE todos SET topic_id = ? WHERE id = ?', topic.id, todo.id)
    sql('DELETE FROM todo_watches WHERE todo_id = ?', todo.id)
    db.watchTodo(1, 'default', topic.id, todo.id, 'stored before #97')
  }
  const finishBuild = async todoId => {
    await orch.startBuild(run, { todoId })
    return settleBuild(todoId)
  }
  const hostEvent = (type, sessionId, data = {}) => orch.handleHostEvent({ type, data: { session_id: sessionId, ...data } }, run)
  const systemTexts = topicId => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'system').map(m => m.text)
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, alpha, beta, topicA, topicB, loose, tools, call, sql, count, dirtyCard, moveRaw, finishBuild, settleBuild, hostEvent, systemTexts, sessionRuns, working, warnings, chiefTopic, addRepo, cleanup }
}

// ── 1. creating a card ───────────────────────────────────────────────────────────────────────────────

test('#97 create: an explicit topic of another project, of no project, or unknown is refused and nothing is stored', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, alpha, beta, topicA, topicB, loose, count } = ctx
    const before = { todos: count('todos'), watches: count('todo_watches'), topics: count('topics'), messages: count('topic_messages'), wakes: count('wake_log') }
    await assert.rejects(
      () => orch.createTodo(run, { projectId: beta.id, topicId: topicA.id, title: '挂到甲项目话题的乙项目卡' }),
      err => {
        assert.match(err.message, /话题「甲项目话题」属于项目 alpha，不能创建项目 beta 的卡片/)
        assert.match(err.message, /请改用项目 beta 的话题或省略 topic_id/)
        return true
      },
    )
    await assert.rejects(() => orch.createTodo(run, { projectId: beta.id, topicId: loose.id, title: '挂到无项目话题' }), /话题「无项目话题」未归属任何项目，不能创建项目 beta 的卡片/)
    await assert.rejects(() => orch.createTodo(run, { projectId: beta.id, topicId: 'topic-missing', title: '话题不存在' }), /话题不存在：topic-missing/)
    const viaTool = await call('create_todo', { project_id: alpha.id, topic_id: topicB.id, title: '工具入口同样拒绝' })
    assert.match(viaTool.thrown, /属于项目 beta，不能创建项目 alpha 的卡片/)
    assert.deepEqual({ todos: count('todos'), watches: count('todo_watches'), topics: count('topics'), messages: count('topic_messages'), wakes: count('wake_log') }, before, 'no card, watch, topic, message or wake is left behind')
    // Control: the topic of the project takes the card.
    const ok = await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '同项目显式话题' })
    assert.equal(ok.todo.topicId, topicB.id)
    assert.equal(ok.topicResolvedBy, 'explicit')
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', ok.todo.id).map(w => w.topicId), [topicB.id])
  } finally { ctx.cleanup() }
})

test('#97 create: called from a Chief topic of another project, the card goes to a topic of its own project and the timeline says so', async () => {
  const ctx = await setup()
  try {
    const { db, orch, call, runFrom, alpha, beta, topicA, topicB, systemTexts } = ctx
    // beta has a Chief topic: the card of beta made from alpha's Chief lands there.
    const res = await call('create_todo', { project_id: beta.id, title: '甲话题里建乙项目的卡' }, runFrom('sess-alpha'))
    assert.equal(res.ok, true)
    const todo = db.getTodo(1, 'default', res.data.id)
    assert.equal(todo.topicId, topicB.id)
    assert.equal(res.data.topicResolvedBy, 'chief-topic')
    assert.equal(res.data.topicRedirectedFrom, topicA.id)
    assert.match(res.content, /当前话题「甲项目话题」不属于该项目，卡片已转到该项目的话题/)
    assert.ok(todo.timeline.some(e => e.event === '当前话题「甲项目话题」属于项目 alpha，已转到项目 beta 的话题「乙项目话题」'), 'the timeline names both projects')
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', todo.id).map(w => w.topicId), [topicB.id], 'only the topic of its project watches it')
    assert.equal(db.getTopic(1, 'default', topicA.id).watchedTodoIds.includes(todo.id), false)
    assert.equal(systemTexts(topicA.id).length, 0, 'nothing is written into the calling topic')

    // A project without any topic: one is created, Autopilot off, no Chief session.
    const gamma = await ctx.addRepo('gamma')
    const topicsBefore = db.listTopics(1, 'default').length
    const made = await orch.createTodo(runFrom('sess-alpha'), { projectId: gamma.id, title: '还没有话题的项目', actor: 'chief' })
    const home = db.getTopic(1, 'default', made.todo.topicId)
    assert.equal(made.topicResolvedBy, 'unattended')
    assert.equal(home.projectId, gamma.id)
    assert.equal(home.autopilot, false)
    assert.equal(home.chiefSessionId, '')
    assert.equal(db.listTopics(1, 'default').length, topicsBefore + 1)
    assert.ok(made.todo.timeline.some(e => /当前话题「甲项目话题」属于项目 alpha，已转到项目 gamma 的话题/.test(e.event)))
    assert.ok(systemTexts(home.id).some(t => /^无人值守话题：#\d+ 建单的话题「甲项目话题」不属于项目 gamma/.test(t)))
    // The next card of that project reuses the topic instead of making another one.
    const again = await orch.createTodo(runFrom('sess-alpha'), { projectId: gamma.id, title: '第二张', actor: 'chief' })
    assert.equal(again.todo.topicId, home.id)
    assert.equal(db.listTopics(1, 'default').length, topicsBefore + 1)
  } finally { ctx.cleanup() }
})

test('#97 create: a topic without a project never takes a card, as caller or as the most recent Chief topic', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, runFrom, loose, hostEvent, addRepo } = ctx
    const gamma = await addRepo('gamma')
    // The projectless topic is the most recently updated Chief topic and its Chief is the caller.
    db.addTopicMessage(1, 'default', loose.id, { kind: 'human', text: '最新活动' })
    const fromCaller = await orch.createTodo(runFrom('sess-loose'), { projectId: gamma.id, title: '无项目话题的总管建卡', actor: 'chief' })
    const home = db.getTopic(1, 'default', fromCaller.todo.topicId)
    assert.notEqual(home.id, loose.id)
    assert.equal(home.projectId, gamma.id)
    assert.equal(home.autopilot, false)
    assert.equal(fromCaller.topicResolvedBy, 'unattended')
    assert.ok(fromCaller.todo.timeline.some(e => /当前话题「无项目话题」未归属任何项目，已转到项目 gamma 的话题/.test(e.event)))
    // No session id; the projectless Chief is the one running.
    await hostEvent('chat.run.started', 'sess-loose')
    const delta = await addRepo('delta')
    const byRun = await orch.createTodo(run, { projectId: delta.id, title: '只有无项目总管在跑', actor: 'chief' })
    const deltaHome = db.getTopic(1, 'default', byRun.todo.topicId)
    assert.equal(deltaHome.projectId, delta.id)
    assert.equal(deltaHome.autopilot, false)
    assert.equal(byRun.topicResolvedBy, 'unattended')
    assert.ok(byRun.todo.timeline.some(e => /^建单未指定话题：推断调用方为话题「无项目话题」，它未归属任何项目，已转到项目 delta 的话题/.test(e.event)), 'the guess is called a guess')
    // The same state, but the card is made by the user on the page: no Chief is named.
    const byUser = await orch.createTodo(run, { projectId: delta.id, title: '用户在页面上建卡' })
    assert.equal(byUser.todo.topicId, deltaHome.id)
    assert.equal(byUser.topicRedirectedFrom, null)
    assert.equal(byUser.todo.timeline.some(e => /推断调用方|当前话题/.test(e.event)), false)
    assert.equal(db.getTopic(1, 'default', loose.id).watchedTodoIds.length, 0)
  } finally { ctx.cleanup() }
})

test('#97 create: inside one project the order caller session → tool → running Chief → most recent Chief topic is kept, and no topic is made', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, runFrom, alpha, topicA, chiefTopic, hostEvent } = ctx
    await new Promise(r => setTimeout(r, 4))
    const second = await chiefTopic('sess-alpha-2', { projectId: alpha.id, title: '甲项目第二话题' })
    await new Promise(r => setTimeout(r, 4))
    const third = await chiefTopic('sess-alpha-3', { projectId: alpha.id, title: '甲项目第三话题' })
    const topics = db.listTopics(1, 'default').length
    const recent = await orch.createTodo(run, { projectId: alpha.id, title: '最近话题', actor: 'chief' })
    assert.equal(recent.topicResolvedBy, 'chief-topic')
    assert.equal(recent.todo.topicId, third.id, 'the most recently updated Chief topic of the project')

    // A Chief of another project runs from here on: it is never taken and not counted.
    await hostEvent('chat.run.started', 'sess-beta')
    await hostEvent('chat.run.started', 'sess-alpha-2')
    const running = await orch.createTodo(run, { projectId: alpha.id, title: '活跃运行', actor: 'chief' })
    assert.equal(running.topicResolvedBy, 'active-run')
    assert.equal(running.todo.topicId, second.id)
    assert.equal(running.topicCandidates, 1, 'the running Chief of the other project is not counted')

    await hostEvent('chat.run.started', 'sess-alpha')
    await hostEvent('chat.tool.started', 'sess-alpha', { name: 'mcp__ekko_todo__ekko_todo__create_utodo' })
    await hostEvent('chat.run.started', 'sess-alpha-3')
    const byTool = await orch.createTodo(run, { projectId: alpha.id, title: '调用中的工具', actor: 'chief' })
    assert.equal(byTool.topicResolvedBy, 'caller-tool')
    assert.equal(byTool.todo.topicId, topicA.id)

    const bySession = await orch.createTodo(runFrom('sess-alpha-2'), { projectId: alpha.id, title: '调用方会话', actor: 'chief' })
    assert.equal(bySession.topicResolvedBy, 'caller-session')
    assert.equal(bySession.todo.topicId, second.id)
    assert.equal(db.listTopics(1, 'default').length, topics, 'no topic was created')
    for (const res of [recent, running, byTool, bySession]) assert.equal(res.topicRedirectedFrom, null)
  } finally { ctx.cleanup() }
})

// ── 2. what a Chief can see ──────────────────────────────────────────────────────────────────────────

test('#97 list_todos: a Chief sees its own project by default, another project is refused with the topic to use, a non-Chief sees every project', async () => {
  const ctx = await setup()
  try {
    const { orch, run, runFrom, call, alpha, beta, topicA, topicB, loose } = ctx
    const a = (await orch.createTodo(run, { projectId: alpha.id, topicId: topicA.id, title: '甲的卡' })).todo
    const b = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙的卡' })).todo
    const ids = res => res.data.todos.map(t => t.id).sort()

    const own = await call('list_todos', {}, runFrom('sess-alpha'))
    assert.equal(own.ok, true)
    assert.deepEqual(ids(own), [a.id], 'only the cards of the topic\'s project')
    assert.deepEqual(ids(await call('list_todos', { project_id: alpha.id }, runFrom('sess-alpha'))), [a.id])
    assert.deepEqual(ids(await call('list_todos', { topic_id: topicA.id }, runFrom('sess-alpha'))), [a.id])

    const otherProject = await call('list_todos', { project_id: beta.id }, runFrom('sess-alpha'))
    assert.equal(otherProject.ok, false, 'not an empty list')
    assert.equal(otherProject.error, MISMATCH)
    assert.match(otherProject.content, /话题「甲项目话题」属于项目 alpha，不能查看项目 beta 的卡片/)
    assert.ok(otherProject.content.includes(`请到项目 beta 的话题「乙项目话题」（${topicB.id}）操作`))
    const otherTopic = await call('list_todos', { topic_id: topicB.id }, runFrom('sess-alpha'))
    assert.equal(otherTopic.error, MISMATCH)
    assert.match(otherTopic.content, /不能查看话题「乙项目话题」/)
    const overview = await call('list_todos', { all_projects: true }, runFrom('sess-alpha'))
    assert.equal(overview.error, MISMATCH)
    assert.match(overview.content, /总管会话不能使用跨项目总览/)
    const fromLoose = await call('list_todos', {}, runFrom('sess-loose'))
    assert.equal(fromLoose.error, MISMATCH)
    assert.match(fromLoose.content, /话题「无项目话题」未归属任何项目，看不到任何项目的卡片/)
    assert.ok(loose.id)

    // Not a Chief: the page / a plain session (no session id and no Chief running), or a session that is no topic's Chief.
    assert.deepEqual(ids(await call('list_todos', {})), [a.id, b.id].sort())
    assert.deepEqual(ids(await call('list_todos', { all_projects: true })), [a.id, b.id].sort())
    assert.deepEqual(ids(await call('list_todos', { project_id: beta.id }, runFrom('sess-plain-chat'))), [b.id])
    assert.deepEqual(ids(await call('list_todos', { all_projects: true, project_id: beta.id }, runFrom('sess-plain-chat'))), [a.id, b.id].sort())
  } finally { ctx.cleanup() }
})

test('#97 list_todos without a session id: the Chief that has the tool open is the caller; two running Chiefs of different projects must name their project', async () => {
  const ctx = await setup()
  try {
    const { orch, run, call, alpha, beta, topicA, topicB, hostEvent } = ctx
    const a = (await orch.createTodo(run, { projectId: alpha.id, topicId: topicA.id, title: '甲的卡' })).todo
    const b = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙的卡' })).todo
    await hostEvent('chat.run.started', 'sess-alpha')
    await hostEvent('chat.run.started', 'sess-beta')
    const unknown = await call('list_todos', {})
    assert.equal(unknown.error, 'CALLER_AMBIGUOUS', 'fail-closed: nothing is listed for a caller that cannot be told apart')
    assert.match(unknown.content, /^无法确定调用方话题，请显式传 topic_id/)
    await hostEvent('chat.tool.started', 'sess-beta', { name: 'mcp__ekko_todo__ekko_todo__list_utodos' })
    const scoped = await call('list_todos', {})
    assert.deepEqual(scoped.data.todos.map(t => t.id), [b.id], 'the Chief that started list_todos is the caller')
    const foreign = await call('list_todos', { project_id: alpha.id })
    assert.equal(foreign.error, MISMATCH)
    assert.match(foreign.content, /调用未带会话身份/)
    await hostEvent('chat.tool.completed', 'sess-beta', { name: 'mcp__ekko_todo__ekko_todo__list_utodos' })
    await hostEvent('chat.run.completed', 'sess-beta')
    assert.deepEqual((await call('list_todos', {})).data.todos.map(t => t.id), [a.id], 'only the Chief of alpha is still running')
  } finally { ctx.cleanup() }
})

test('#97 Chief prompt: the task list and the digest a Chief is given hold cards of its topic\'s project only', async () => {
  const ctx = await setup()
  try {
    const { orch, run, alpha, beta, topicA, topicB, sessionRuns } = ctx
    await orch.createTodo(run, { projectId: alpha.id, topicId: topicA.id, title: '甲项目独有标题XA' })
    await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙项目独有标题XB' })
    await orch.sendTopicMessage(run, { topicId: topicA.id, text: '看看进度' })
    const sent = sessionRuns.filter(r => r.sid === 'sess-alpha')
    assert.equal(sent.length, 1)
    const text = JSON.stringify(sent[0])
    assert.ok(text.includes('甲项目独有标题XA'), 'its own card is listed')
    assert.equal(text.includes('乙项目独有标题XB'), false, 'a card of another project is not')
  } finally { ctx.cleanup() }
})

// ── 3. acting on a card ──────────────────────────────────────────────────────────────────────────────

const TODO_TOOLS = ['create_schedule', 'update_todo', 'run_build', 'get_todo_conversation', 'get_todo_diff', 'get_todo_detail', 'run_review', 'ask_user', 'confirm_plan', 'message_todo', 'merge_build', 'retry_merge', 'watch_todos', 'cancel_build', 'complete_todo']
const inputFor = (name, todoId, topicId) => ({
  todo_id: todoId,
  ...(name === 'message_todo' ? { message: '继续' } : {}),
  ...(name === 'watch_todos' ? { topic_id: topicId } : {}),
  ...(name === 'ask_user' ? { title: '选哪个', options: [{ label: '甲' }, { label: '乙' }] } : {}),
  ...(name === 'update_todo' ? { title: '被改掉的标题' } : {}),
})

test('#97 guard: every tool that takes todo_id refuses a Chief of another project (and of no project) and leaves the card untouched', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, runFrom, call, tools, alpha, beta, topicA, topicB, sessionRuns } = ctx
    const named = [...tools.values()].filter(d => d.inputSchema?.properties?.todo_id).map(d => d.name).sort()
    assert.deepEqual(named, [...TODO_TOOLS].sort(), 'the tools that name a card; a new one must be added here and is guarded by the same wrapper')
    const card = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙项目的卡' })).todo
    assert.ok(alpha.id)
    const runsBefore = sessionRuns.length
    for (const name of TODO_TOOLS) {
      for (const [session, phrase] of [['sess-alpha', '话题「甲项目话题」属于项目 alpha'], ['sess-loose', '话题「无项目话题」未归属任何项目']]) {
        const res = await call(name, inputFor(name, card.id, topicA.id), runFrom(session))
        assert.equal(res.ok, false, `${name} from ${session}`)
        assert.equal(res.error, MISMATCH, `${name} from ${session}: ${res.content || res.thrown}`)
        assert.ok(res.content.includes(`${phrase}，不能操作项目 beta 的卡片 #${card.number}`), `${name}: ${res.content}`)
        assert.ok(res.content.includes(`请到项目 beta 的话题「乙项目话题」（${topicB.id}）操作`), `${name} names the topic to use`)
      }
    }
    const after = db.getTodo(1, 'default', card.id)
    assert.equal(after.revision, card.revision, 'nothing was written on the card')
    assert.equal(after.phase, 'todo')
    assert.equal(after.title, '乙项目的卡')
    assert.equal(sessionRuns.length, runsBefore, 'no session was started')
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', card.id).map(w => w.topicId), [topicB.id])
  } finally { ctx.cleanup() }
})

test('#97 guard: the Chief of the card\'s project and a non-Chief caller are let through by every tool', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, runFrom, call, beta, topicB } = ctx
    const mk = async title => (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title })).todo
    const own = runFrom('sess-beta')
    // The six entries named in the card, with their effect.
    const built = await mk('派工')
    const dispatched = await call('run_build', { todo_id: built.id }, own)
    assert.equal(dispatched.ok, true, dispatched.content || dispatched.thrown)
    assert.equal(db.getTodo(1, 'default', built.id).phase, 'building')
    const messaged = await call('message_todo', { todo_id: built.id, message: '补充一句' }, own)
    assert.equal(messaged.ok, true, messaged.content || messaged.thrown)
    const diff = await call('get_todo_diff', { todo_id: built.id }, own)
    assert.equal(diff.ok, true, diff.content || diff.thrown)
    const watched = await call('watch_todos', { todo_id: built.id, topic_id: topicB.id }, own)
    assert.equal(watched.ok, true, watched.content)
    for (const name of ['run_review', 'merge_build']) {
      const res = await call(name, { todo_id: built.id }, own)
      assert.notEqual(res.error, MISMATCH, `${name} is decided by its own rules, not by the ownership guard`)
      assert.doesNotMatch(String(res.content || res.thrown || ''), /不能操作项目/)
    }
    // Every other tool: never the ownership refusal for the own Chief, nor for a caller that is not a Chief.
    for (const name of TODO_TOOLS) {
      const card = await mk(`放行 ${name}`)
      for (const from of [own, runFrom('sess-plain-chat')]) {
        const res = await call(name, inputFor(name, card.id, topicB.id), from)
        assert.notEqual(res.error, MISMATCH, `${name}: ${res.content}`)
        assert.doesNotMatch(String(res.content || res.thrown || ''), /不能操作项目/, name)
      }
    }
    const edited = await mk('可改标题')
    assert.equal((await call('update_todo', { todo_id: edited.id, title: '用户改的标题' }, run)).ok, true)
    assert.equal(db.getTodo(1, 'default', edited.id).title, '用户改的标题')
  } finally { ctx.cleanup() }
})

test('#97 guard without a session id: decided from the open tool calls and running Chiefs; a non-Chief session with the tool open is not a Chief', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, beta, topicB, hostEvent } = ctx
    const card = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙项目的卡' })).todo
    assert.equal(orch.resolveChiefCaller(run, 'run_build').by, 'not-chief')
    assert.equal(orch.chiefTodoScopeViolation(run, 'run_build', card.id), '', 'nobody is running: the caller is the user')

    // Only the Chief of alpha is running: it is the caller.
    await hostEvent('chat.run.started', 'sess-alpha')
    assert.equal(orch.resolveChiefCaller(run, 'run_build').by, 'active-run')
    const refused = await call('run_build', { todo_id: card.id })
    assert.equal(refused.error, MISMATCH)
    assert.match(refused.content, /调用未带会话身份，按正在运行的总管会话判定/)
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'todo')

    // It has the tool open under its full name, then behind the tool_call wrapper.
    for (const name of ['mcp__ekko_todo__ekko_todo__run_ubuild', 'mcp__magpie__tool_call']) {
      await hostEvent('chat.tool.started', 'sess-alpha', { name })
      assert.equal(orch.resolveChiefCaller(run, 'run_build').by, 'caller-tool')
      assert.match(orch.chiefTodoScopeViolation(run, 'run_build', card.id), /不能操作项目 beta 的卡片/)
      await hostEvent('chat.tool.completed', 'sess-alpha', { name })
    }

    // A plain (non-Chief) session has the tool open: the call is its, and it is not restricted.
    await hostEvent('chat.tool.started', 'sess-plain-chat', { name: 'mcp__ekko_todo__ekko_todo__run_ubuild' })
    assert.equal(orch.resolveChiefCaller(run, 'run_build').by, 'not-chief')
    assert.equal(orch.chiefTodoScopeViolation(run, 'run_build', card.id), '')
    await hostEvent('chat.tool.completed', 'sess-plain-chat', { name: 'mcp__ekko_todo__ekko_todo__run_ubuild' })
    assert.match(orch.chiefTodoScopeViolation(run, 'run_build', card.id), /不能操作项目 beta/, 'its call ended: the running Chief counts again')

    // The Chief of beta runs too: the caller may be the right one, so the call is not refused.
    // The Chief of beta runs too: nothing says which of the two is calling, so the call is refused.
    await hostEvent('chat.run.started', 'sess-beta')
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id).code, 'CALLER_AMBIGUOUS')
    // #108: no open tool shows who is calling, so a declared topic is not believed (it was before).
    const selfNamed = orch.chiefTodoScopeCheck(run, 'run_build', card.id, topicB.id)
    assert.equal(selfNamed.code, 'CALLER_AMBIGUOUS', 'running Chiefs only: a declaration is refused')
    assert.match(selfNamed.text, /仅凭「总管正在运行」不接受自报/)
    // The open tool shows that only alpha's Chief is calling: the ownership refusal again.
    await hostEvent('chat.tool.started', 'sess-alpha', { name: 'mcp__ekko_todo__ekko_todo__run_ubuild' })
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id).code, MISMATCH)
    assert.match(orch.chiefTodoScopeViolation(run, 'run_build', card.id), /不能操作项目 beta/)
    await hostEvent('chat.run.completed', 'sess-alpha')
    await hostEvent('chat.run.completed', 'sess-beta')
    assert.equal(orch.chiefTodoScopeViolation(run, 'run_build', card.id), '')
    assert.equal(orch.chiefTodoScopeViolation(run, 'run_build', 'todo-missing'), '', 'an unknown card is left to the tool')
  } finally { ctx.cleanup() }
})

// ── 4. watches, notices and wakes ────────────────────────────────────────────────────────────────────

test('#97 watch: a card is watched only from a topic of its project', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, beta, topicA, topicB, loose } = ctx
    const card = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙项目的卡' })).todo
    assert.throws(() => orch.watchTodoFromTopic(run, { topicId: topicA.id, todoId: card.id }), /话题「甲项目话题」属于项目 alpha，不能关注项目 beta 的卡片 #\d+；一张卡只能由它的管理话题关注/)
    assert.throws(() => orch.watchTodoFromTopic(run, { topicId: loose.id, todoId: card.id }), /未归属任何项目，不能关注/)
    // The user's own call (no Chief) is refused as well: the rule is about the topic, not the caller.
    const viaTool = await call('watch_todos', { topic_id: topicA.id, todo_id: card.id, reason: '跨项目盯卡' })
    assert.equal(viaTool.ok, false)
    assert.equal(viaTool.error, MISMATCH)
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', card.id).map(w => w.topicId), [topicB.id])
    assert.equal((await call('watch_todos', { topic_id: topicB.id, todo_id: card.id })).ok, true)
  } finally { ctx.cleanup() }
})

test('#97 notify: a card stored in a topic of another project wakes no Chief; it is said once on the card and in that topic', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, beta, topicA, topicB, dirtyCard, finishBuild, systemTexts, sessionRuns, warnings } = ctx
    db.updateTopic(1, 'default', topicA.id, { autopilot: true })
    db.updateTopic(1, 'default', topicB.id, { autopilot: true })
    await orch.updateProject(run, { id: beta.id, autopilot: { autoMergeAfterReview: true } })
    const { todo } = await dirtyCard(beta, topicA)
    const settled = await finishBuild(todo.id)
    assert.equal(settled.phase, 'review')
    assert.equal(settled.gateOwner, 'human', 'no Chief holds the gate of a card that is in another project\'s topic')
    const chiefRuns = () => sessionRuns.filter(r => r.sid === 'sess-alpha' || r.sid === 'sess-beta' || r.sid === 'sess-loose')
    assert.equal(chiefRuns().length, 0, 'no Chief session was started')
    assert.equal(db.listTopicQueue(1, 'default', topicA.id).length, 0, 'and no wake was queued')
    assert.equal(systemTexts(topicA.id).filter(t => /^关注的任务有进展/.test(t)).length, 0, 'no progress notice in the other project\'s topic')
    const flagged = () => systemTexts(topicA.id).filter(t => /^归属异常：#\d+ 串台的旧卡片 属于项目 beta，不属于本话题的项目/.test(t))
    assert.equal(flagged().length, 1)
    const line = () => db.getTodo(1, 'default', todo.id).timeline.filter(e => /^归属异常：卡片属于项目 beta，话题「甲项目话题」属于项目 alpha；进展通知不再投递到该话题，未唤醒任何总管/.test(e.event))
    assert.equal(line().length, 1)
    assert.ok(warnings.some(w => /belongs to another project/.test(w.message)))
    // A second round: the dispatch does not renew the foreign watch into a wake, and nothing is said twice.
    assert.equal((await finishBuild(todo.id)).phase, 'review')
    assert.equal(flagged().length, 1, 'said once')
    assert.equal(line().length, 1)
    assert.equal(chiefRuns().length, 0)

    // Control: the same event on a card that is in a topic of its project wakes that Chief.
    const clean = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '归属正常的卡' })).todo
    assert.equal((await finishBuild(clean.id)).gateOwner, 'chief', 'control: the gate of a card in its own project\'s AUTO topic is the Chief\'s')
    assert.equal(systemTexts(topicB.id).filter(t => /^关注的任务有进展：#\d+ 归属正常的卡/.test(t)).length, 1)
    assert.ok(sessionRuns.some(r => r.sid === 'sess-beta'), 'the Chief of its project is woken')
    assert.equal(sessionRuns.some(r => r.sid === 'sess-alpha'), false)
  } finally { ctx.cleanup() }
})

test('#97 notify: a question on a card stored in another project\'s topic is not posted into that topic', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, beta, topicA, topicB, dirtyCard } = ctx
    const { todo } = await dirtyCard(beta, topicA)
    const ask = id => orch.askUserQuestion(run, { todoId: id, title: '选哪个方案', options: [{ label: '甲' }, { label: '乙' }] })
    await ask(todo.id)
    assert.equal(db.getTodo(1, 'default', todo.id).question.active, true, 'the question is on the card (board column 待你处理)')
    assert.equal(db.getTopic(1, 'default', topicA.id).messages.filter(m => /需要你拍板/.test(m.text)).length, 0)
    const clean = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '正常卡' })).todo
    await ask(clean.id)
    assert.equal(db.getTopic(1, 'default', topicB.id).messages.filter(m => /需要你拍板/.test(m.text)).length, 1)
  } finally { ctx.cleanup() }
})

// ── 5. stored cards that are in the wrong topic ──────────────────────────────────────────────────────

test('#97 snapshot: a card in a topic of another project carries topicProjectMismatch; the stub and the detail keep it; other cards do not have the field', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, beta, topicA, topicB, loose, dirtyCard, sql } = ctx
    const { todo } = await dirtyCard(beta, topicA)
    const { todo: inLoose } = await dirtyCard(beta, loose, '挂在无项目话题的卡')
    const { todo: orphan } = await dirtyCard(beta, topicA, '话题已不存在的卡')
    sql('UPDATE todos SET topic_id = ? WHERE id = ?', 'topic-gone', orphan.id)
    const clean = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '正常卡' })).todo
    const snap = await orch.getSnapshot(run)
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
    const view = id => snap.todos.find(t => t.id === id)
    assert.deepEqual(view(todo.id).topicProjectMismatch, { todoProjectId: beta.id, topicProjectId: topicA.projectId, topicId: topicA.id, topicExists: true, repairable: true, reason: '' })
    assert.deepEqual(view(inLoose.id).topicProjectMismatch, { todoProjectId: beta.id, topicProjectId: '', topicId: loose.id, topicExists: true, repairable: true, reason: '' })
    assert.deepEqual(view(orphan.id).topicProjectMismatch, { todoProjectId: beta.id, topicProjectId: '', topicId: 'topic-gone', topicExists: false, repairable: true, reason: '' })
    assert.equal('topicProjectMismatch' in view(clean.id), false, 'absent on a card that is where it belongs')
    assert.deepEqual(todoCardStub(view(todo.id)).topicProjectMismatch, view(todo.id).topicProjectMismatch)
    assert.equal('topicProjectMismatch' in todoCardStub(view(clean.id)), false)
    assert.deepEqual(orch.getTodoDetail(run, { todoId: todo.id }).topicProjectMismatch, view(todo.id).topicProjectMismatch)
    assert.equal('topicProjectMismatch' in orch.getTodoDetail(run, { todoId: clean.id }), false)
    // While a round is in flight the card is flagged but not repairable yet.
    await orch.startBuild(run, { todoId: todo.id })
    const busy = (await orch.getSnapshot(run)).todos.find(t => t.id === todo.id).topicProjectMismatch
    assert.equal(busy.repairable, false)
    assert.match(busy.reason, /先等当前轮结束或停止后再修/)
    assert.equal(db.getTodo(1, 'default', todo.id).topicProjectMismatch, undefined, 'derived, never stored')
  } finally { ctx.cleanup() }
})

test('#97 repair-todo-topic: moves the card to a topic of its project, writes one system line in the old and the new topic, keeps everything else, and can be repeated', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, runFrom, call, beta, topicA, topicB, dirtyCard, finishBuild, systemTexts, sessionRuns } = ctx
    assert.ok(contract.rpc['repair-todo-topic'], 'declared in the contract')
    assert.equal(contract.rpc['repair-todo-topic'].output, 'stateSnapshot')
    assert.doesNotThrow(() => validateModel(contract, contract.rpc['repair-todo-topic'].input, { todoId: 'todo-1' }))
    assert.throws(() => validateModel(contract, contract.rpc['repair-todo-topic'].input, {}))
    // Through the registered RPC handler, the way the page calls it.
    const handlers = new Map()
    registerAllRpcs({ extensions: { rpc: { register(name, handler) { handlers.set(name, handler); return () => {} } } } }, contract, orch)
    const rpc = handlers.get('repair-todo-topic')
    assert.equal(typeof rpc, 'function', 'registered')

    db.updateTopic(1, 'default', topicB.id, { autopilot: true })
    const { todo } = await dirtyCard(beta, topicA)
    await finishBuild(todo.id)
    const before = db.getTodo(1, 'default', todo.id)
    const messagesA = db.getTopic(1, 'default', topicA.id).messages.length
    const messagesB = db.getTopic(1, 'default', topicB.id).messages.length

    const state = await rpc({ todoId: todo.id }, run)
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', state))
    const after = db.getTodo(1, 'default', todo.id)
    assert.equal(after.topicId, topicB.id, 'todos.topic_id now names a topic of the card\'s project')
    assert.equal('topicProjectMismatch' in state.todos.find(t => t.id === todo.id), false)
    for (const key of ['phase', 'branch', 'worktreePath', 'buildSessionId', 'reviewSessionId', 'snapshotSha', 'projectId', 'number', 'spec']) assert.deepEqual(after[key], before[key], `${key} is kept`)
    assert.deepEqual(after.diffs, before.diffs, 'diffs are kept')
    assert.deepEqual(after.buildChat, before.buildChat)
    assert.deepEqual(after.timeline.slice(0, before.timeline.length), before.timeline, 'earlier timeline lines are kept')
    assert.equal(after.timeline.filter(e => e.event === '归属修复：从话题「甲项目话题」（属于项目 alpha）转到项目 beta 的话题「乙项目话题」').length, 1)
    assert.equal(db.getTopic(1, 'default', topicA.id).messages.length, messagesA + 1, 'no message of the old topic is removed, one is added')
    assert.equal(db.getTopic(1, 'default', topicB.id).messages.length, messagesB + 1)
    assert.equal(systemTexts(topicA.id).filter(t => /^归属修复：#\d+ 串台的旧卡片 属于项目 beta，已转到该项目的话题「乙项目话题」/.test(t)).length, 1)
    assert.equal(systemTexts(topicB.id).filter(t => /^归属修复：#\d+ 串台的旧卡片 从话题「甲项目话题」（属于项目 alpha）转入本话题/.test(t)).length, 1)
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', todo.id).map(w => w.topicId), [topicB.id], 'the watch moved with the card')

    // Repeated: nothing more is written.
    const rev = after.revision
    const again = await orch.repairTodoTopic(run, { todoId: todo.id })
    assert.equal(again.repaired, false)
    await rpc({ todoId: todo.id }, run)
    assert.equal(db.getTodo(1, 'default', todo.id).revision, rev)
    assert.equal(db.getTopic(1, 'default', topicA.id).messages.length, messagesA + 1)
    assert.equal(db.getTopic(1, 'default', topicB.id).messages.length, messagesB + 1)

    // The card now works from its project's topic: its Chief may act on it and is woken by its progress.
    assert.equal(orch.chiefTodoScopeViolation(runFrom('sess-beta'), 'run_review', todo.id), '')
    assert.match(orch.chiefTodoScopeViolation(runFrom('sess-alpha'), 'run_review', todo.id), /不能操作项目 beta/)
    const wakesBefore = sessionRuns.filter(r => r.sid === 'sess-beta').length
    await call('message_todo', { todo_id: todo.id, message: '再补一处' }, runFrom('sess-beta'))
    assert.equal((await ctx.settleBuild(todo.id)).phase, 'review')
    assert.ok(sessionRuns.filter(r => r.sid === 'sess-beta').length > wakesBefore, 'progress after the repair wakes the Chief of the card\'s project')
    assert.equal(sessionRuns.some(r => r.sid === 'sess-alpha'), false)
    await assert.rejects(() => orch.repairTodoTopic(run, { todoId: 'todo-missing' }), /Todo not found/)
  } finally { ctx.cleanup() }
})

test('#97 repair-todo-topic: refused while the card is building, reviewing or merging; a project without a topic gets one with Autopilot off', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, topicA, dirtyCard, addRepo, systemTexts, sql } = ctx
    const gamma = await addRepo('gamma')
    const { todo, madeTopicId } = await dirtyCard(gamma, topicA)
    // The topic made for the card when it was created is removed: the project has no topic at all.
    await orch.deleteTopic(run, madeTopicId)
    sql('UPDATE todos SET topic_id = ? WHERE id = ?', topicA.id, todo.id)
    db.watchTodo(1, 'default', topicA.id, todo.id, 'stored before #97')
    for (const phase of ['building', 'reviewing', 'merging']) {
      sql('UPDATE todos SET phase = ? WHERE id = ?', phase, todo.id)
      await assert.rejects(() => orch.repairTodoTopic(run, { todoId: todo.id }), /先等当前轮结束或停止后再修/, phase)
      assert.equal(db.getTodo(1, 'default', todo.id).topicId, topicA.id, `${phase}: not moved`)
    }
    sql('UPDATE todos SET phase = ? WHERE id = ?', 'review', todo.id)
    const topicsBefore = db.listTopics(1, 'default').length
    const res = await orch.repairTodoTopic(run, { todoId: todo.id })
    assert.equal(res.repaired, true)
    assert.equal(res.fromTopicId, topicA.id)
    const home = db.getTopic(1, 'default', res.toTopicId)
    assert.equal(home.projectId, gamma.id)
    assert.equal(home.autopilot, false)
    assert.equal(home.chiefSessionId, '')
    assert.equal(db.listTopics(1, 'default').length, topicsBefore + 1)
    assert.ok(systemTexts(home.id).some(t => /转入本话题。之后它的进展通知到这里；本话题没有总管会话，进展只记录不唤醒/.test(t)))
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', todo.id).map(w => w.topicId), [home.id])
    // A finished card is moved without a new watch.
    const { todo: done } = await dirtyCard(gamma, topicA, '已完成的旧卡')
    sql('UPDATE todos SET phase = ? WHERE id = ?', 'done', done.id)
    const moved = await orch.repairTodoTopic(run, { todoId: done.id })
    assert.equal(moved.toTopicId, home.id, 'the project\'s topic is reused')
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', done.id), [])
  } finally { ctx.cleanup() }
})

// ── 5b. upgrade path: topics without a project, batch repair, ambiguous callers ───────────────────────

test('#97 adopt: a topic without a project takes the project of most of its cards on first Chief use, once; its cards work again', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, runFrom, call, alpha, beta, topicA, topicB, chiefTopic, moveRaw, settleBuild, systemTexts, sessionRuns } = ctx
    const orphan = await chiefTopic('sess-orphan', { title: '老话题' })
    const mk = async (project, topic, title) => (await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title })).todo
    const b1 = await mk(beta, topicB, '乙卡一')
    const b2 = await mk(beta, topicB, '乙卡二')
    const a1 = await mk(alpha, topicA, '甲卡')
    for (const td of [b1, b2, a1]) moveRaw(td, orphan)
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, '', 'stored state before the upgrade')
    const adoptLines = () => systemTexts(orphan.id).filter(t => /^话题已归属到项目 /.test(t))

    // First use by its Chief: the list is not refused and not empty.
    const listed = await call('list_todos', {}, runFrom('sess-orphan'))
    assert.equal(listed.ok, true, listed.content)
    assert.deepEqual(listed.data.todos.map(t => t.id).sort(), [b1.id, b2.id].sort())
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, beta.id)
    assert.equal(adoptLines().length, 1)
    assert.match(adoptLines()[0], /^话题已归属到项目 beta（按其中卡片多数）：本话题 3 张卡片中 2 张属于该项目。其余 1 张属于其他项目/)
    // The card of the other project is said to be there, in the answer and in the snapshot.
    assert.equal(listed.data.topicScopeReason.code, 'foreign-todos')
    assert.match(listed.content, /其中 1 张卡片属于其他项目/)

    // Once: later reads and calls change nothing.
    const stamp = db.getTopic(1, 'default', orphan.id).updatedAt
    assert.deepEqual(orch.adoptOrphanTopics(run, 1, 'default'), [])
    await orch.getSnapshot(run)
    await call('list_todos', {}, runFrom('sess-orphan'))
    assert.equal(adoptLines().length, 1, 'no second system message')
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, beta.id)
    assert.equal(db.getTopic(1, 'default', orphan.id).updatedAt, stamp, 'the topic is not written again')

    // Its cards of that project work from it again: dispatch, progress notice, wake.
    const snap = await orch.getSnapshot(run)
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
    assert.equal('topicProjectMismatch' in snap.todos.find(t => t.id === b1.id), false)
    assert.equal(snap.todos.find(t => t.id === a1.id).topicProjectMismatch.topicProjectId, beta.id)
    assert.deepEqual(snap.topics.find(t => t.id === orphan.id).topicScopeReason, {
      code: 'foreign-todos',
      message: '本话题属于项目 beta，其中 1 张卡片属于其他项目，不在这里处理；可用「修复话题归属」（repair-topic-todos）把它们迁到各自项目的话题。',
      projectId: beta.id,
      todoCount: 3,
      foreignTodoCount: 1,
    })
    const built = await call('run_build', { todo_id: b1.id }, runFrom('sess-orphan'))
    assert.equal(built.ok, true, built.content || built.thrown)
    assert.equal((await settleBuild(b1.id)).phase, 'review')
    assert.equal(systemTexts(orphan.id).filter(t => /^关注的任务有进展：#\d+ 乙卡一/.test(t)).length, 1)
    assert.ok(sessionRuns.some(r => r.sid === 'sess-orphan'), 'its Chief is woken')
    assert.equal((await call('run_build', { todo_id: a1.id }, runFrom('sess-orphan'))).error, MISMATCH, 'the card of the other project is still not its to handle')

    // The user's own choice is final: a topic the user detached is not adopted again.
    await orch.updateTopicMeta(run, { topicId: orphan.id, projectId: '' })
    await orch.getSnapshot(run)
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, '')
    assert.equal(adoptLines().length, 1)
  } finally { ctx.cleanup() }
})

test('#97 adopt: the first load adopts too; a tie goes to the project of the card updated last; cards of a removed project do not count', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, alpha, beta, topicA, topicB, chiefTopic, moveRaw, sql, systemTexts } = ctx
    const mk = async (project, topic, title) => (await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title })).todo
    const tied = await chiefTopic('sess-tied', { title: '平票话题' })
    const ghost = await chiefTopic('sess-ghost', { title: '项目已删话题' })
    const ta = await mk(alpha, topicA, '甲')
    const tb = await mk(beta, topicB, '乙')
    const gone = await mk(beta, topicB, '项目已删的卡')
    moveRaw(ta, tied); moveRaw(tb, tied); moveRaw(gone, ghost)
    sql('UPDATE todos SET updated_at = ? WHERE id = ?', 5000, ta.id)
    sql('UPDATE todos SET updated_at = ? WHERE id = ?', 9000, tb.id)
    sql('UPDATE todos SET project_id = ? WHERE id = ?', 'proj-removed', gone.id)
    const snap = await orch.getSnapshot(run)
    assert.equal(db.getTopic(1, 'default', tied.id).projectId, beta.id, 'the project of the card updated last')
    assert.equal(systemTexts(tied.id).filter(t => /^话题已归属到项目 beta（按其中卡片多数）/.test(t)).length, 1)
    assert.equal(db.getTopic(1, 'default', ghost.id).projectId, '', 'no existing project to adopt')
    assert.equal(snap.topics.find(t => t.id === ghost.id).topicScopeReason.code, 'no-project')
    assert.equal(systemTexts(ghost.id).length, 0)
    // A topic that has a project but only cards of one other project is not changed: the reason suggests the project.
    const wrong = await chiefTopic('sess-wrong', { projectId: alpha.id, title: '挂错项目的话题' })
    for (const title of ['乙一', '乙二']) moveRaw(await mk(beta, topicB, title), wrong)
    const reason = (await orch.getSnapshot(run)).topics.find(t => t.id === wrong.id).topicScopeReason
    assert.equal(db.getTopic(1, 'default', wrong.id).projectId, alpha.id, 'a project that was set is never changed automatically')
    assert.equal(reason.code, 'foreign-todos')
    assert.equal(reason.suggestedProjectId, beta.id)
    // #126: the tool the Chief calls itself is named first; the topic menu is the last, optional sentence.
    assert.match(reason.message, /^本话题属于项目 alpha，但其中 2 张卡片全部属于项目 beta：更可能是话题挂错了项目。由本话题的总管调用 set_topic_project 把本话题改绑到 beta/)
    // Following the suggestion clears every flag without moving a card.
    await orch.updateTopicMeta(run, { topicId: wrong.id, projectId: beta.id })
    const fixed = await orch.getSnapshot(run)
    assert.equal('topicScopeReason' in fixed.topics.find(t => t.id === wrong.id), false)
    assert.equal(fixed.todos.filter(t => t.topicId === wrong.id && t.topicProjectMismatch).length, 0)
  } finally { ctx.cleanup() }
})

test('#97 adopt: a topic without cards stays without a project and every answer says why (never an unexplained empty list)', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, runFrom, call, beta, topicA, topicB, chiefTopic, systemTexts } = ctx
    const empty = await chiefTopic('sess-empty', { title: '空话题' })
    const card = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙项目的卡' })).todo
    const snap = await orch.getSnapshot(run)
    assert.equal(db.getTopic(1, 'default', empty.id).projectId, '')
    assert.equal(systemTexts(empty.id).length, 0)
    // #118: this topic's project was never decided, so the message also names the first-card way.
    assert.deepEqual(snap.topics.find(t => t.id === empty.id).topicScopeReason, {
      code: 'no-project',
      // #124: the page is told the Chief binds the topic; the menu is no longer the first thing named.
      message: '本话题还没有绑定项目，总管会根据你说的事判断项目并自动绑定；也可以直接在总管那里说要绑定到哪个项目，或直接让总管建第一张卡，话题会自动固定到该卡的项目。绑定前总管不能在这里列卡、派工、审查或合并，也不会被卡片进展唤醒。',
      projectId: '',
      todoCount: 0,
      foreignTodoCount: 0,
    })
    assert.equal('topicScopeReason' in snap.topics.find(t => t.id === topicB.id), false, 'absent on a topic that is in order')
    const listed = await call('list_todos', {}, runFrom('sess-empty'))
    assert.equal(listed.ok, false)
    assert.equal(listed.error, MISMATCH)
    assert.match(listed.content, /^本话题还没有绑定项目：话题「空话题」未归属任何项目，看不到任何项目的卡片；请调用 set_topic_project /)
    assert.equal(listed.data.topicScopeReason.code, 'no-project')
    const acted = await call('run_build', { todo_id: card.id }, runFrom('sess-empty'))
    assert.equal(acted.error, MISMATCH)
    assert.match(acted.content, /^本话题还没有绑定项目：由你调用 set_topic_project 绑定到卡片所在的项目/)
    // A Chief whose project has no card gets a sentence, not a bare empty answer.
    const none = await call('list_todos', {}, runFrom('sess-alpha'))
    assert.equal(none.ok, true)
    assert.equal(none.data.count, 0)
    assert.match(none.content, /^本话题所属项目（.+）下暂无匹配的任务；本话题只列出该项目的卡片。$/)
    assert.ok(topicA.id)
  } finally { ctx.cleanup() }
})

test('#97 repair-topic-todos: dryRun stores nothing; the run moves every foreign card of the topic, skips cards in flight, and can be repeated', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, alpha, beta, topicA, topicB, addRepo, moveRaw, sql, count, systemTexts } = ctx
    assert.equal(contract.rpc['repair-topic-todos'].input, 'repairTopicTodosInput')
    assert.equal(contract.rpc['repair-topic-todos'].output, 'repairTopicTodosOutput')
    assert.throws(() => validateModel(contract, 'repairTopicTodosInput', {}))
    assert.throws(() => validateModel(contract, 'repairTopicTodosInput', { topicId: 't', dryRun: 'yes' }))
    const handlers = new Map()
    registerAllRpcs({ extensions: { rpc: { register(name, handler) { handlers.set(name, handler); return () => {} } } } }, contract, orch)
    const rpc = handlers.get('repair-topic-todos')
    assert.equal(typeof rpc, 'function', 'registered')

    const gamma = await addRepo('gamma')
    const mk = async (project, input, title) => (await orch.createTodo(run, { projectId: project.id, title, ...input })).todo
    const x1 = await mk(beta, { topicId: topicB.id }, '乙卡一')
    const x2 = await mk(beta, { topicId: topicB.id }, '乙卡二')
    const busy = await mk(beta, { topicId: topicB.id }, '构建中的乙卡')
    const g1 = await mk(gamma, {}, '丙卡')
    const own = await mk(alpha, { topicId: topicA.id }, '甲自己的卡')
    await orch.deleteTopic(run, g1.topicId) // gamma has no topic at all
    for (const td of [x1, x2, busy, g1]) moveRaw(td, topicA)
    sql('UPDATE todos SET phase = ? WHERE id = ?', 'building', busy.id)
    sql('UPDATE todos SET phase = ? WHERE id = ?', 'done', x2.id)
    const stored = () => ({
      rows: { topics: count('topics'), messages: count('topic_messages'), watches: count('todo_watches'), wakes: count('wake_log') },
      cards: [x1, x2, busy, g1, own].map(td => { const cur = db.getTodo(1, 'default', td.id); return [cur.topicId, cur.revision, cur.timeline.length] }),
    })

    const before = stored()
    const dry = await rpc({ topicId: topicA.id, dryRun: true }, run)
    assert.deepEqual(stored(), before, 'dryRun writes nothing: no topic, message, watch, card revision or timeline line')
    assert.equal(dry.dryRun, true)
    assert.deepEqual(dry.moved.map(e => e.id), [x1.id, x2.id, g1.id])
    assert.deepEqual(dry.moved[0], { id: x1.id, number: x1.number, title: '乙卡一', projectId: beta.id, oldTopicId: topicA.id, newTopicId: topicB.id, reason: '' })
    assert.equal(dry.moved[2].newTopicId, '', 'a topic that would be created has no id yet')
    assert.deepEqual(dry.skipped, [{ id: busy.id, number: busy.number, title: '构建中的乙卡', projectId: beta.id, oldTopicId: topicA.id, newTopicId: '', reason: '任务正在执行（构建 / 审查 / 合并中），先等当前轮结束或停止后再修' }])
    assert.deepEqual(dry.topics, [
      { id: topicB.id, title: '乙项目话题', projectId: beta.id, created: false, unattended: false, count: 2 },
      { id: '', title: 'gamma', projectId: gamma.id, created: true, unattended: true, count: 1 },
    ])

    const messagesA = db.getTopic(1, 'default', topicA.id).messages.length
    const messagesB = db.getTopic(1, 'default', topicB.id).messages.length
    const done = await rpc({ topicId: topicA.id }, run)
    assert.equal(done.dryRun, false)
    assert.deepEqual(done.moved.map(e => e.id), [x1.id, x2.id, g1.id])
    assert.deepEqual(done.skipped.map(e => e.id), [busy.id])
    const gammaHome = db.getTopic(1, 'default', done.moved[2].newTopicId)
    assert.equal(gammaHome.projectId, gamma.id)
    assert.equal(gammaHome.autopilot, false)
    assert.equal(gammaHome.chiefSessionId, '')
    assert.deepEqual(done.topics.map(t => [t.id, t.created, t.count]), [[topicB.id, false, 2], [gammaHome.id, true, 1]])
    assert.equal(db.getTodo(1, 'default', x1.id).topicId, topicB.id)
    assert.equal(db.getTodo(1, 'default', x2.id).topicId, topicB.id)
    assert.equal(db.getTodo(1, 'default', g1.id).topicId, gammaHome.id)
    assert.equal(db.getTodo(1, 'default', busy.id).topicId, topicA.id, 'the card in flight stays')
    assert.equal(db.getTodo(1, 'default', own.id).revision, own.revision, 'a card of the topic\'s project is not touched')
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', x1.id).map(w => w.topicId), [topicB.id], 'the watch moved')
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', x2.id), [], 'a finished card gets no new watch')
    assert.equal(db.getTodo(1, 'default', x1.id).timeline.filter(e => e.event === '归属修复：从话题「甲项目话题」（属于项目 alpha）转到项目 beta 的话题「乙项目话题」').length, 1)
    // One message per topic concerned, not one per card.
    assert.equal(db.getTopic(1, 'default', topicA.id).messages.length, messagesA + 1)
    assert.equal(db.getTopic(1, 'default', topicB.id).messages.length, messagesB + 1)
    assert.equal(systemTexts(topicA.id).filter(t => /^归属修复：本话题有 3 张不属于本话题项目的卡片已转到各自项目的话题：.*另有 1 张未迁移/.test(t)).length, 1)
    assert.equal(systemTexts(topicB.id).filter(t => /^归属修复：2 张卡片（#\d+、#\d+）从话题「甲项目话题」（属于项目 alpha）转入本话题/.test(t)).length, 1)
    assert.equal(systemTexts(gammaHome.id).filter(t => /^归属修复：1 张卡片.*本话题没有总管会话，进展只记录不唤醒/.test(t)).length, 1)

    // Repeated: nothing more is moved or written.
    const after = stored()
    const again = await rpc({ topicId: topicA.id }, run)
    assert.deepEqual(again.moved, [])
    assert.deepEqual(again.topics, [])
    assert.deepEqual(again.skipped.map(e => e.id), [busy.id])
    assert.deepEqual(stored(), after)
    // Once its round has ended the skipped card is moved by the next call.
    sql('UPDATE todos SET phase = ? WHERE id = ?', 'review', busy.id)
    const last = await rpc({ topicId: topicA.id }, run)
    assert.deepEqual(last.moved.map(e => [e.id, e.newTopicId]), [[busy.id, topicB.id]])
    assert.deepEqual((await rpc({ topicId: topicA.id, dryRun: true }, run)).moved, [])
    await assert.rejects(() => orch.repairTopicTodos(run, { topicId: 'topic-missing' }), /话题不存在：topic-missing/)
  } finally { ctx.cleanup() }
})

test('#97 repair-topic-todos before adoption (dryRun): a topic stored without a project is judged as if adopted, and nothing is stored', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, alpha, beta, topicA, topicB, loose, chiefTopic, moveRaw, count } = ctx
    const mk = async (project, topic, title) => (await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title })).todo
    const cards = []
    for (const [project, topic, title] of [[beta, topicB, '乙卡一'], [beta, topicB, '乙卡二'], [alpha, topicA, '甲卡'], [beta, topicB, '解除项目话题里的乙卡'], [alpha, topicA, '解除项目话题里的甲卡']]) cards.push(await mk(project, topic, title))
    const [b1, b2, a1, l1, l2] = cards
    // Stored state before the upgrade, and nothing has loaded a snapshot or used a Chief since.
    const orphan = await chiefTopic('sess-orphan', { title: '尚未归属的老话题' })
    for (const td of [b1, b2, a1]) moveRaw(td, orphan)
    for (const td of [l1, l2]) moveRaw(td, loose)
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, '')
    const stored = () => JSON.stringify({ topics: count('topics'), messages: count('topic_messages'), watches: count('todo_watches'), wakes: count('wake_log'), project: db.getTopic(1, 'default', orphan.id).projectId, cards: cards.map(td => { const cur = db.getTodo(1, 'default', td.id); return [cur.topicId, cur.revision] }) })
    const before = stored()
    const dry = await orch.repairTopicTodos(run, { topicId: orphan.id, dryRun: true })
    assert.deepEqual(dry.moved.map(e => [e.id, e.newTopicId]), [[a1.id, topicA.id]], 'only the card that is not of the project the topic will be adopted by')
    assert.deepEqual(dry.skipped, [])
    assert.equal(stored(), before, 'dryRun adopts nothing and stores nothing')
    // A topic the user detached is not adopted: every card in it is foreign.
    const detached = await orch.repairTopicTodos(run, { topicId: loose.id, dryRun: true })
    assert.deepEqual(detached.moved.map(e => e.id).sort(), [l1.id, l2.id].sort())
    assert.equal(stored(), before)
  } finally { ctx.cleanup() }
})

test('#97 repair-topic-todos before adoption (run): the topic is adopted first, keeps the cards of its project and still has cards afterwards', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, alpha, beta, topicA, topicB, chiefTopic, moveRaw, systemTexts } = ctx
    const mk = async (project, topic, title) => (await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title })).todo
    const b1 = await mk(beta, topicB, '乙卡一')
    const b2 = await mk(beta, topicB, '乙卡二')
    const a1 = await mk(alpha, topicA, '甲卡')
    const orphan = await chiefTopic('sess-orphan', { title: '尚未归属的老话题' })
    for (const td of [b1, b2, a1]) moveRaw(td, orphan)
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, '')
    const dry = await orch.repairTopicTodos(run, { topicId: orphan.id, dryRun: true })
    const done = await orch.repairTopicTodos(run, { topicId: orphan.id })
    assert.deepEqual(done.moved.map(e => [e.id, e.newTopicId]), [[a1.id, topicA.id]], 'the cards of the adopted project are not moved away')
    assert.deepEqual(done.moved, dry.moved, 'the preview and the run answer the same cards')
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, beta.id, 'adopted by the project of most of its cards')
    assert.equal(systemTexts(orphan.id).filter(t => /^话题已归属到项目 beta（按其中卡片多数）/.test(t)).length, 1)
    assert.equal(db.getTodo(1, 'default', b1.id).topicId, orphan.id)
    assert.equal(db.getTodo(1, 'default', b2.id).topicId, orphan.id)
    assert.equal(db.getTodo(1, 'default', a1.id).topicId, topicA.id)
    const snap = await orch.getSnapshot(run)
    assert.equal(snap.todos.filter(t => [b1.id, b2.id, a1.id].includes(t.id) && t.topicProjectMismatch).length, 0)
    assert.equal('topicScopeReason' in snap.topics.find(t => t.id === orphan.id), false, 'the topic is in order: a project, and only cards of it')
    assert.deepEqual((await orch.repairTopicTodos(run, { topicId: orphan.id })).moved, [], 'repeated: nothing more')
  } finally { ctx.cleanup() }
})

test('#97 fail-closed: one running Chief is the caller and is not refused; two possible callers of different projects are refused until the caller names its topic', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, tools, alpha, beta, topicA, topicB, chiefTopic, hostEvent } = ctx
    const mk = async (project, topic, title) => (await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title })).todo
    const AMBIGUOUS = 'CALLER_AMBIGUOUS'
    // The normal case: one topic, one Chief, no session id on the call.
    const first = await mk(beta, topicB, '正常场景的卡')
    await hostEvent('chat.run.started', 'sess-beta')
    assert.equal(orch.resolveChiefCaller(run, 'run_build').ambiguous, false)
    const listed = await call('list_todos', {})
    assert.equal(listed.ok, true, listed.content)
    assert.deepEqual(listed.data.todos.map(t => t.id), [first.id])
    const built = await call('run_build', { todo_id: first.id })
    assert.equal(built.ok, true, built.content || built.thrown)
    assert.equal(db.getTodo(1, 'default', first.id).phase, 'building')

    // A Chief of another project runs as well: nothing says which of the two is calling.
    const card = await mk(beta, topicB, '两个总管并行时的卡')
    await hostEvent('chat.run.started', 'sess-alpha')
    assert.equal(orch.resolveChiefCaller(run, 'run_build').ambiguous, true)
    for (const name of ['run_build', 'message_todo', 'update_todo', 'merge_build', 'complete_todo', 'cancel_build']) {
      const res = await call(name, inputFor(name, card.id, topicB.id))
      assert.equal(res.ok, false, name)
      assert.equal(res.error, AMBIGUOUS, `${name}: ${res.content || res.thrown}`)
      assert.match(res.content, /^无法确定调用方话题，请显式传 topic_id（参数 caller_topic_id/)
      assert.ok(res.content.includes(`「甲项目话题」（${topicA.id}）`) && res.content.includes(`「乙项目话题」（${topicB.id}）`), 'the candidates are named')
    }
    const untouched = db.getTodo(1, 'default', card.id)
    assert.equal(untouched.revision, card.revision)
    assert.equal(untouched.phase, 'todo')
    for (const input of [{}, { project_id: beta.id }, { topic_id: topicB.id }]) {
      const res = await call('list_todos', input)
      assert.equal(res.error, AMBIGUOUS, JSON.stringify(input))
      assert.match(res.content, /无法确定调用方话题，请显式传 topic_id/)
    }
    // #108: with running Chiefs only, naming a topic settles nothing (nothing shows who holds the tool).
    assert.equal((await call('run_build', { todo_id: card.id, caller_topic_id: topicB.id })).error, AMBIGUOUS)
    assert.equal((await call('list_todos', { caller_topic_id: topicB.id })).error, AMBIGUOUS)
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'todo')
    // Both Chiefs have the tool open: the caller names its topic and the usual rule applies to that topic.
    for (const sid of ['sess-alpha', 'sess-beta']) {
      await hostEvent('chat.tool.started', sid, { name: 'mcp__ekko_todo__ekko_todo__run_ubuild' })
      await hostEvent('chat.tool.started', sid, { name: 'mcp__ekko_todo__ekko_todo__list_utodos' })
    }
    assert.equal((await call('run_build', { todo_id: card.id })).error, AMBIGUOUS)
    assert.equal((await call('run_build', { todo_id: card.id, caller_topic_id: topicA.id })).error, MISMATCH)
    const unknown = await call('run_build', { todo_id: card.id, caller_topic_id: 'topic-nope' })
    assert.equal(unknown.error, AMBIGUOUS)
    assert.match(unknown.content, /caller_topic_id topic-nope 不是当前可能在调用的总管话题/)
    assert.deepEqual((await call('list_todos', { caller_topic_id: topicB.id })).data.todos.map(t => t.id).sort(), [first.id, card.id].sort())
    const named = await call('run_build', { todo_id: card.id, caller_topic_id: topicB.id })
    assert.equal(named.ok, true, named.content || named.thrown)
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'building')
    for (const sid of ['sess-alpha', 'sess-beta']) await hostEvent('chat.tool.completed', sid, {})
    // The open tool call settles it without the parameter.
    const third = await mk(beta, topicB, '看工具事件的卡')
    await hostEvent('chat.tool.started', 'sess-beta', { name: 'mcp__ekko_todo__ekko_todo__update_utodo' })
    assert.equal((await call('update_todo', { todo_id: third.id, title: '乙总管改的标题' })).ok, true)
    // …but a session that is no Chief with the same tool open beside a Chief does not.
    await hostEvent('chat.tool.started', 'sess-alpha', { name: 'mcp__ekko_todo__ekko_todo__run_ubuild' })
    await hostEvent('chat.tool.started', 'sess-plain-chat', { name: 'mcp__ekko_todo__ekko_todo__run_ubuild' })
    assert.equal((await call('run_build', { todo_id: third.id })).error, AMBIGUOUS)
    await hostEvent('chat.run.completed', 'sess-alpha')
    await hostEvent('chat.run.completed', 'sess-beta')

    // Two Chiefs of the same project. Before #117 whoever called might act, so nothing was refused. Since #117
    // only the managing topic acts on a card: nothing says which of the two is calling, so a write is refused
    // as ambiguous (fail-closed); reading the card stays open to both.
    await chiefTopic('sess-alpha-2', { projectId: alpha.id, title: '甲项目第二话题' })
    const mine = await mk(alpha, topicA, '同项目两个总管')
    await hostEvent('chat.run.started', 'sess-alpha')
    await hostEvent('chat.run.started', 'sess-alpha-2')
    assert.equal(orch.resolveChiefCaller(run, 'update_todo').ambiguous, true)
    assert.equal(orch.chiefTodoScopeCheck(run, 'update_todo', mine.id).code, AMBIGUOUS)
    assert.equal(orch.chiefTodoScopeCheck(run, 'get_todo_diff', mine.id), null)
    assert.equal((await call('list_todos', {})).ok, true)
    assert.equal(orch.chiefTodoScopeCheck(run, 'update_todo', third.id).code, AMBIGUOUS, 'a card of another project: refused, and as ambiguous')

    // Every tool that names a card takes caller_topic_id and does not pass it on to its own handler.
    for (const def of tools.values()) {
      if (def.inputSchema?.properties?.todo_id || def.name === 'list_todos') assert.ok(def.inputSchema.properties.caller_topic_id, def.name)
    }
  } finally { ctx.cleanup() }
})

// ── 5c. #108: caller_topic_id cannot be borrowed; adoption is atomic ─────────────────────────────────

const RUN_BUILD = 'mcp__ekko_todo__ekko_todo__run_ubuild'
const WRAPPER = 'mcp__magpie__tool_call'

test('#108 caller_topic_id: the id of another project\'s topic is refused — not a candidate of this call, although its Chief runs and has a wrapper open', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, alpha, beta, topicA, topicB, hostEvent } = ctx
    const card = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙项目的卡' })).todo
    await hostEvent('chat.run.started', 'sess-alpha')
    await hostEvent('chat.run.started', 'sess-beta')
    // The Chief of alpha is the one calling run_build (its tool is open by name). The Chief of beta is busy
    // with some other tool behind a wrapper: it is running and has a tool open, but is no candidate here.
    await hostEvent('chat.tool.started', 'sess-alpha', { name: RUN_BUILD })
    await hostEvent('chat.tool.started', 'sess-beta', { name: WRAPPER })
    const honest = orch.resolveChiefCaller(run, 'run_build')
    assert.deepEqual([honest.by, honest.topics.map(t => t.id)], ['caller-tool', [topicA.id]])
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id).code, MISMATCH, 'without a declaration: alpha may not touch the card of beta')

    // It names the topic of beta to get at the card of beta.
    const forged = orch.resolveChiefCaller(run, 'run_build', topicB.id)
    assert.notEqual(forged.by, 'declared')
    assert.equal(forged.declaredRefusal, 'not-candidate')
    assert.deepEqual(forged.topics.map(t => t.id), [topicA.id], 'the candidates stay what the evidence says')
    const check = orch.chiefTodoScopeCheck(run, 'run_build', card.id, topicB.id)
    assert.equal(check.code, 'CALLER_AMBIGUOUS')
    assert.match(check.text, new RegExp(`caller_topic_id ${topicB.id} 不是当前可能在调用的总管话题`))
    for (const name of ['run_build', 'update_todo', 'message_todo', 'complete_todo', 'cancel_build']) {
      await hostEvent('chat.tool.started', 'sess-alpha', { name: `mcp__ekko_todo__ekko_todo__${name.replace('_', '_u')}` })
      const res = await call(name, { ...inputFor(name, card.id, topicB.id), caller_topic_id: topicB.id })
      assert.equal(res.error, 'CALLER_AMBIGUOUS', `${name}: ${res.content || res.thrown}`)
    }
    await hostEvent('chat.tool.started', 'sess-alpha', { name: 'mcp__ekko_todo__ekko_todo__list_utodos' })
    const listed = await call('list_todos', { caller_topic_id: topicB.id })
    assert.equal(listed.error, 'CALLER_AMBIGUOUS', 'list_todos refuses the same forged id')
    const after = db.getTodo(1, 'default', card.id)
    assert.deepEqual([after.phase, after.revision, after.title], ['todo', card.revision, card.title], 'nothing was done to the card')
    // A topic id that names nothing, and a declaration with no candidate at all, are refused too.
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id, 'topic-nope').code, 'CALLER_AMBIGUOUS')
    for (const sid of ['sess-alpha', 'sess-beta']) await hostEvent('chat.run.completed', sid)
    assert.equal(orch.resolveChiefCaller(run, 'run_build').by, 'not-chief')
    const none = orch.chiefTodoScopeCheck(run, 'run_build', card.id, topicB.id)
    assert.equal(none.code, 'CALLER_AMBIGUOUS', 'no candidate: the declaration is not believed either')
    assert.match(none.text, /当前没有可核实的总管调用方/)
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id), null, 'without it the call is a non-Chief call, as before')
    assert.ok(alpha.id)
  } finally { ctx.cleanup() }
})

test('#108 caller_topic_id: accepted when the named topic is a candidate and its Chief session has this tool open under its own name', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, alpha, beta, topicA, topicB, hostEvent } = ctx
    const cardB = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙项目的卡' })).todo
    const cardA = (await orch.createTodo(run, { projectId: alpha.id, topicId: topicA.id, title: '甲项目的卡' })).todo
    await hostEvent('chat.run.started', 'sess-alpha')
    await hostEvent('chat.run.started', 'sess-beta')
    await hostEvent('chat.tool.started', 'sess-alpha', { name: RUN_BUILD })
    await hostEvent('chat.tool.started', 'sess-beta', { name: RUN_BUILD })
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', cardB.id).code, 'CALLER_AMBIGUOUS', 'two Chiefs have it open')
    const named = orch.resolveChiefCaller(run, 'run_build', topicB.id)
    assert.deepEqual([named.by, named.ambiguous, named.topics.map(t => t.id)], ['declared', false, [topicB.id]])
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', cardB.id, topicB.id), null, 'its own card')
    // Accepted is not the same as allowed: the usual rule applies to the named topic.
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', cardA.id, topicB.id).code, MISMATCH)
    const built = await call('run_build', { todo_id: cardB.id, caller_topic_id: topicB.id })
    assert.equal(built.ok, true, built.content || built.thrown)
    assert.equal(db.getTodo(1, 'default', cardB.id).phase, 'building')
    assert.ok(alpha.id)
  } finally { ctx.cleanup() }
})

test('#108 caller_topic_id: a tool_call wrapper is no evidence of the tool — behind wrappers every declaration is refused, the forged one and the true one; by name the same declaration is accepted', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, beta, topicA, topicB, hostEvent } = ctx
    const card = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙项目的卡' })).todo
    await hostEvent('chat.run.started', 'sess-alpha')
    await hostEvent('chat.run.started', 'sess-beta')
    // The Chief of alpha calls run_build through the wrapper; the Chief of beta calls list_todos through the
    // wrapper at the same time. The host names the wrapper only, so both look the same.
    await hostEvent('chat.tool.started', 'sess-alpha', { name: WRAPPER })
    await hostEvent('chat.tool.started', 'sess-beta', { name: WRAPPER })
    const plain = orch.resolveChiefCaller(run, 'run_build')
    assert.deepEqual([plain.by, plain.ambiguous, plain.topics.map(t => t.id).sort()], ['caller-tool', true, [topicA.id, topicB.id].sort()])
    // alpha names the topic of beta to get at the card of beta: refused, as is beta's own true declaration.
    for (const declared of [topicB.id, topicA.id]) {
      const caller = orch.resolveChiefCaller(run, 'run_build', declared)
      assert.deepEqual([caller.by, caller.ambiguous, caller.declaredUnknown, caller.declaredRefusal], ['caller-tool', true, declared, 'no-open-tool'], declared)
      assert.deepEqual(caller.topics.map(t => t.id).sort(), [topicA.id, topicB.id].sort())
      const check = orch.chiefTodoScopeCheck(run, 'run_build', card.id, declared)
      assert.equal(check.code, 'CALLER_AMBIGUOUS', declared)
      assert.match(check.text, /该话题的总管会话是经 tool_call 包装调用的，包装看不出里面是哪个工具，不能当作开着本工具的证据/)
      assert.match(check.text, /请改为直呼工具名后重试/)
    }
    const forged = await call('run_build', { todo_id: card.id, caller_topic_id: topicB.id })
    assert.deepEqual([forged.ok, forged.error], [false, 'CALLER_AMBIGUOUS'], forged.content || forged.thrown)
    assert.equal((await call('list_todos', { caller_topic_id: topicB.id })).error, 'CALLER_AMBIGUOUS')
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'todo', 'the card of beta was not touched')
    // One Chief behind a wrapper only: its declaration is not believed either (nothing says the wrapper holds run_build).
    await hostEvent('chat.tool.completed', 'sess-alpha', { name: WRAPPER })
    assert.equal(orch.resolveChiefCaller(run, 'run_build', topicB.id).declaredRefusal, 'no-open-tool')
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id, topicB.id).code, 'CALLER_AMBIGUOUS')
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id), null, 'without a declaration the one wrapper candidate is the caller, as before')

    // Control: the same two Chiefs call run_build by its name, and the same declaration is accepted.
    await hostEvent('chat.tool.completed', 'sess-beta', { name: WRAPPER })
    await hostEvent('chat.tool.started', 'sess-alpha', { name: RUN_BUILD })
    await hostEvent('chat.tool.started', 'sess-beta', { name: RUN_BUILD })
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id).code, 'CALLER_AMBIGUOUS')
    assert.equal(orch.resolveChiefCaller(run, 'run_build', topicB.id).by, 'declared')
    const direct = await call('run_build', { todo_id: card.id, caller_topic_id: topicB.id })
    assert.equal(direct.ok, true, direct.content || direct.thrown)
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'building')
  } finally { ctx.cleanup() }
})

test('#108 caller_topic_id: with running Chiefs only (no open tool seen) a declaration is refused, also a true one; once the tool event arrives it is accepted', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, beta, topicA, topicB, hostEvent } = ctx
    const card = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙项目的卡' })).todo
    await hostEvent('chat.run.started', 'sess-alpha')
    await hostEvent('chat.run.started', 'sess-beta')
    assert.equal(orch.resolveChiefCaller(run, 'run_build').by, 'active-run')
    for (const declared of [topicB.id, topicA.id]) {
      const caller = orch.resolveChiefCaller(run, 'run_build', declared)
      assert.deepEqual([caller.by, caller.ambiguous, caller.declaredRefusal], ['active-run', true, 'no-open-tool'], declared)
      assert.deepEqual(caller.topics.map(t => t.id).sort(), [topicA.id, topicB.id].sort())
      const check = orch.chiefTodoScopeCheck(run, 'run_build', card.id, declared)
      assert.equal(check.code, 'CALLER_AMBIGUOUS', declared)
      assert.match(check.text, /无法核实：没有看到该话题的总管会话正开着本工具，仅凭「总管正在运行」不接受自报/)
    }
    const res = await call('run_build', { todo_id: card.id, caller_topic_id: topicB.id })
    assert.deepEqual([res.ok, res.error], [false, 'CALLER_AMBIGUOUS'])
    assert.equal((await call('list_todos', { caller_topic_id: topicB.id })).error, 'CALLER_AMBIGUOUS')
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'todo')
    // One running Chief only: still not believed on its word, the call is refused with the declaration …
    await hostEvent('chat.run.completed', 'sess-alpha')
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id, topicB.id).code, 'CALLER_AMBIGUOUS')
    // … and let through without it (one running Chief is not ambiguous), as before.
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id), null)
    // The tool event arrives: the same declaration is now verified.
    await hostEvent('chat.tool.started', 'sess-beta', { name: RUN_BUILD })
    assert.equal(orch.resolveChiefCaller(run, 'run_build', topicB.id).by, 'declared')
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id, topicB.id), null)
  } finally { ctx.cleanup() }
})

test('#108 adopt: a failed topic write leaves no one-time key behind, so the next call adopts the topic', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, alpha, beta, topicA, topicB, chiefTopic, moveRaw, systemTexts, warnings } = ctx
    const orphan = await chiefTopic('sess-orphan', { title: '老话题' })
    const other = await chiefTopic('sess-orphan-2', { title: '另一个老话题' })
    const b1 = (await orch.createTodo(run, { projectId: beta.id, topicId: topicB.id, title: '乙卡' })).todo
    const a1 = (await orch.createTodo(run, { projectId: alpha.id, topicId: topicA.id, title: '甲卡' })).todo
    moveRaw(b1, orphan)
    moveRaw(a1, other)
    const adoptLines = id => systemTexts(id).filter(t => /^话题已归属到项目 /.test(t))
    const key = `topic-adopt:${orphan.id}`

    // The topic write fails for this topic.
    const realUpdate = db.updateTopic
    db.updateTopic = (userId, profile, id, patch) => {
      if (id === orphan.id && patch?.projectId) throw new Error('disk I/O error')
      return realUpdate(userId, profile, id, patch)
    }
    let adopted
    assert.doesNotThrow(() => { adopted = orch.adoptOrphanTopics(run, 1, 'default') }, 'a failed adoption does not break the call')
    db.updateTopic = realUpdate
    assert.deepEqual(adopted.map(a => a.topicId), [other.id], 'the other topic of the same call is adopted')
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, '')
    assert.equal(db.hasWakeKey(key), false, 'the one-time key was rolled back with the failed write')
    assert.equal(adoptLines(orphan.id).length, 0)
    assert.ok(warnings.some(w => /Adopting a topic without a project failed/.test(w.message) && w.data.topicId === orphan.id))

    // The message write fails: the project written just before it is rolled back too.
    const realAdd = db.addTopicMessage
    db.addTopicMessage = (userId, profile, topicId, msg) => {
      if (topicId === orphan.id) throw new Error('disk I/O error')
      return realAdd(userId, profile, topicId, msg)
    }
    assert.deepEqual(orch.adoptOrphanTopics(run, 1, 'default'), [])
    db.addTopicMessage = realAdd
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, '', 'no half adoption: project without its message')
    assert.equal(db.hasWakeKey(key), false)

    // Retry: adopted, once.
    assert.deepEqual(orch.adoptOrphanTopics(run, 1, 'default').map(a => [a.topicId, a.projectId]), [[orphan.id, beta.id]])
    assert.equal(db.getTopic(1, 'default', orphan.id).projectId, beta.id)
    assert.equal(db.hasWakeKey(key), true)
    assert.equal(adoptLines(orphan.id).length, 1)
    assert.deepEqual(orch.adoptOrphanTopics(run, 1, 'default'), [])
    assert.equal(adoptLines(orphan.id).length, 1)
  } finally { ctx.cleanup() }
})

test('#108 db.transaction: all writes or none; the error is thrown on; a nested call joins the outer transaction', async () => {
  const ctx = await setup()
  try {
    const { db } = ctx
    assert.equal(db.transaction(() => { db.claimWakeKey('t108:a', '', ''); return 7 }), 7)
    assert.equal(db.hasWakeKey('t108:a'), true)
    assert.throws(() => db.transaction(() => { db.claimWakeKey('t108:b', '', ''); throw new Error('boom') }), /boom/)
    assert.equal(db.hasWakeKey('t108:b'), false)
    assert.throws(() => db.transaction(() => {
      db.claimWakeKey('t108:c', '', '')
      db.transaction(() => db.claimWakeKey('t108:d', '', ''))
      throw new Error('outer')
    }), /outer/)
    assert.deepEqual([db.hasWakeKey('t108:c'), db.hasWakeKey('t108:d')], [false, false])
    assert.equal(db.transaction(() => db.claimWakeKey('t108:e', '', '')), true, 'usable again after a rollback')
  } finally { ctx.cleanup() }
})

test('#108: the contract, the tool schema and CONTRACTS.md say when caller_topic_id is accepted, that adoption is atomic, and the fail-closed cost for a non-Chief session', async () => {
  for (const name of ['list_todos', 'run_build', 'merge_build', 'update_todo']) assert.match(contract.tools[name].description, /Since #108 the value is accepted only when that topic is one of the candidates of the call and its Chief session has this tool open/, name)
  const docs = read('docs/CONTRACTS.md')
  for (const literal of ['#108', 'no-open-tool', 'not-candidate', '仅凭「总管正在运行」不接受自报', 'Known cost of fail-closed', 'in one transaction', 'under its own tool name only', 'in the wrapper tier `caller_topic_id` is always refused', '请改为直呼工具名后重试']) assert.ok(docs.includes(literal), `CONTRACTS.md has ${literal}`)
  const ctx = await setup()
  try {
    assert.match(ctx.tools.get('run_build').inputSchema.properties.caller_topic_id.description, /has this tool open under its own name \(call the tool directly: a call made through a tool_call wrapper is never accepted\)/)
    assert.doesNotMatch(docs, /or behind a `tool_call` wrapper/)
    for (const name of ['list_todos', 'run_build']) assert.match(contract.tools[name].description, /a tool_call wrapper hides which tool is called and is no evidence/, name)
  } finally { ctx.cleanup() }
  const server = read('dist/server.mjs')
  for (const literal of ['sessionHasToolOpen', 'declaredRefusal', 'no-open-tool']) assert.ok(server.includes(literal), `server bundle has ${literal}`)
})

// ── 6. contract, documents, bundle ───────────────────────────────────────────────────────────────────

test('#97: the contract and CONTRACTS.md describe the rule, the field and the RPC; the server bundle carries the code', () => {
  assert.match(contract.rpc['repair-todo-topic'].description, /topic_id/)
  assert.match(contract.models.repairTodoTopicInput.properties.todoId.description, /Todo ID/)
  assert.match(contract.models.stateSnapshot.properties.todos.items.description, /topicProjectMismatch/)
  assert.match(contract.models.createTodoInput.properties.topicId.description, /must be a topic of the card's project/)
  for (const name of ['list_todos', 'create_todo', 'watch_todos', 'run_build', 'merge_build']) assert.match(contract.tools[name].description, /#97|own project|same project|project of the calling/i, name)
  const docs = read('docs/CONTRACTS.md')
  for (const literal of ['repair-todo-topic', 'topicProjectMismatch', 'TOPIC_PROJECT_MISMATCH', 'all_projects', 'openToolCalls', 'topic-mismatch', 'repair-topic-todos', 'topicScopeReason', 'CALLER_AMBIGUOUS', 'caller_topic_id', 'topic-adopt:']) assert.ok(docs.includes(literal), `CONTRACTS.md has ${literal}`)
  const server = read('dist/server.mjs')
  for (const literal of ['topicProjectMismatch', 'repair-todo-topic', 'TOPIC_PROJECT_MISMATCH', 'chiefTodoScopeViolation', 'topicOwnsProject', 'repair-topic-todos', 'topicScopeReason', 'CALLER_AMBIGUOUS', 'adoptOrphanTopics']) assert.ok(server.includes(literal), `server bundle has ${literal}`)
})

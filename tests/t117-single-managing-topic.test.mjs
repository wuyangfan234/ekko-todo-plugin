// Todo #117: a card has exactly one managing topic (todos.topic_id). Before it, every topic of the card's
// project could watch the card, was shown it, was woken by it and could start or stop it: the user stopped a
// card in one topic and another topic of the project started it again.
// Each rule is exercised through the function that enforces it: the schema (index + triggers), the MCP tool
// wrapper (chiefTodoScopeCheck), watchTodoFromTopic, maybeWakeChief (through settleWorkerRun), the Chief
// prompt, and convergeTodoWatches for rows stored before the rule. All of them decide through
// topicManagesTodo in src/server/orchestrator.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, planWatchConvergence, convergeTodoWatches } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import { buildChiefInstructions } from '../src/server/prompts.mjs'
import { byTestId, cleanupClient, loadClient, mountElement } from './helpers/mini-dom.mjs'

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const NOT_MANAGER = 'TODO_TOPIC_NOT_MANAGER'
const AMBIGUOUS = 'CALLER_AMBIGUOUS'

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

// One project with two Chief topics, A (sess-a) and B (sess-b), both Autopilot on.
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t117-'))
  const dataDir = join(root, 'data')
  let db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
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
  const dir = join(root, 'alpha')
  initRepo(dir)
  const alpha = (await orch.addProject(run, { name: 'alpha', repoPath: dir })).project
  const chiefTopic = async (sessionId, title) => {
    const { topic } = await orch.createTopic(run, { projectId: alpha.id, title })
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId, autopilot: true })
    return db.getTopic(1, 'default', topic.id)
  }
  const topicA = await chiefTopic('sess-a', '话题甲')
  const topicB = await chiefTopic('sess-b', '话题乙')
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
  const rows = (text, ...params) => {
    const raw = new DatabaseSync(sqlitePath, { readOnly: true })
    try { return raw.prepare(text).all(...params).map(r => ({ ...r })) } finally { raw.close() }
  }
  const exec = text => {
    const raw = new DatabaseSync(sqlitePath)
    try { raw.exec(text) } finally { raw.close() }
  }
  // The schema as it was before #117: the index and the triggers are gone, so a second watch can be stored.
  const dropRule = () => exec('DROP INDEX IF EXISTS idx_todo_watches_one_active; DROP TRIGGER IF EXISTS trg_todo_watch_manager_insert; DROP TRIGGER IF EXISTS trg_todo_watch_manager_update; DROP TRIGGER IF EXISTS trg_todo_topic_moves_watch;')
  const rawWatch = (topicId, todoId, reason = 'stored before #117') => sql('INSERT INTO todo_watches (id, user_id, profile, topic_id, todo_id, reason, active, created_at) VALUES (?, 1, \'default\', ?, ?, ?, 1, ?)', `w-raw-${Math.random().toString(16).slice(2, 10)}`, topicId, todoId, reason, Date.now())
  const mk = async (topic, title) => (await orch.createTodo(run, { projectId: alpha.id, topicId: topic.id, title })).todo
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
  const finishBuild = async todoId => {
    await orch.startBuild(run, { todoId })
    return settleBuild(todoId)
  }
  const systemTexts = topicId => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'system').map(m => m.text)
  const notices = topicId => systemTexts(topicId).filter(t => /^关注的任务有进展/.test(t))
  const chiefRuns = sid => sessionRuns.filter(r => r.sid === sid)
  const activeWatches = todoId => db.getActiveWatchesForTodo(1, 'default', todoId).map(w => w.topicId)
  const timeline = todoId => db.getTodo(1, 'default', todoId).timeline.map(e => e.event)
  const hostEvent = (type, sessionId, data = {}) => orch.handleHostEvent({ type, data: { session_id: sessionId, ...data } }, run)
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { get db() { return db }, orch, run, runFrom, alpha, topicA, topicB, tools, call, sql, rows, exec, dropRule, rawWatch, mk, finishBuild, settleBuild, systemTexts, notices, chiefRuns, activeWatches, timeline, hostEvent, sessionRuns, working, warnings, chiefTopic, dataDir, sqlitePath, cleanup }
}

// ── 1. the reported bug ──────────────────────────────────────────────────────────────────────────────

test('#117 repro: a card made in topic A and watched from topic B of the same project does not notify or wake B', async () => {
  const ctx = await setup()
  try {
    const { call, mk, finishBuild, topicA, topicB, notices, chiefRuns, activeWatches, runFrom } = ctx
    const card = await mk(topicA, '甲话题建的卡')
    const watched = await call('watch_todos', { topic_id: topicB.id, todo_id: card.id, reason: '乙话题也想盯' }, runFrom('sess-b'))
    assert.equal(watched.ok, false, 'a second topic cannot watch the card')
    assert.equal(watched.error, NOT_MANAGER, watched.content || watched.thrown)
    assert.deepEqual(activeWatches(card.id), [topicA.id], 'one watch, of the managing topic')
    assert.equal((await finishBuild(card.id)).phase, 'review')
    assert.equal(notices(topicB.id).length, 0, 'no progress notice in topic B')
    assert.equal(chiefRuns('sess-b').length, 0, 'the Chief of topic B is not woken')
    assert.equal(notices(topicA.id).length, 1, 'control: the managing topic is told')
    assert.equal(chiefRuns('sess-a').length, 1, 'control: and its Chief is woken')
  } finally { ctx.cleanup() }
})

test('#117 repro (the incident): the Chief of another topic of the project can neither start nor stop the card, and is told where to go', async () => {
  const ctx = await setup()
  try {
    const { db, call, mk, topicA, topicB, runFrom, sessionRuns } = ctx
    const card = await mk(topicA, '甲话题的卡')
    const other = runFrom('sess-b')
    const started = await call('run_build', { todo_id: card.id }, other)
    assert.equal(started.ok, false)
    assert.equal(started.error, NOT_MANAGER, started.content || started.thrown)
    assert.ok(started.content.includes(`卡片 #${card.number}（${card.id}）由话题「话题甲」（${topicA.id}）管理`), started.content)
    assert.ok(started.content.includes(`话题「话题乙」（${topicB.id}）对它只读`), started.content)
    assert.ok(started.content.includes('只告知它由话题「话题甲」管理'), 'names the managing topic (#123: the user is no longer sent there)')
    assert.ok(started.content.includes('take_over: true'), 'and how the topic can take the card over')
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'todo', 'not started')
    // The managing topic starts it; the other topic cannot stop it.
    assert.equal((await call('run_build', { todo_id: card.id }, runFrom('sess-a'))).ok, true)
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'building')
    const runs = sessionRuns.length
    const stopped = await call('cancel_build', { todo_id: card.id }, other)
    assert.equal(stopped.ok, false)
    assert.equal(stopped.error, NOT_MANAGER, stopped.content || stopped.thrown)
    assert.ok(stopped.content.includes('只告知它由话题「话题甲」管理'))
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'building', 'still building')
    assert.equal(sessionRuns.length, runs)
    // The managing topic stops it, and the user (no Chief session) is never refused.
    const own = await call('cancel_build', { todo_id: card.id }, runFrom('sess-a'))
    assert.equal(own.ok, true, own.content || own.thrown)
    const second = await mk(topicA, '用户自己操作的卡')
    assert.equal((await call('run_build', { todo_id: second.id }, ctx.run)).ok, true, 'the page / the user is not a Chief')
  } finally { ctx.cleanup() }
})

// ── 2. the guard on every tool that names a card ─────────────────────────────────────────────────────

const WRITE_TOOLS = ['create_schedule', 'update_todo', 'run_build', 'run_review', 'ask_user', 'confirm_plan', 'message_todo', 'merge_build', 'retry_merge', 'cancel_build', 'complete_todo']
// #125: get_todo_detail only reads, like the other two.
const PROJECT_SCOPED_TOOLS = ['get_todo_conversation', 'get_todo_diff', 'get_todo_detail', 'watch_todos']
const inputFor = (name, todoId) => ({
  todo_id: todoId,
  ...(name === 'message_todo' ? { message: '继续' } : {}),
  ...(name === 'ask_user' ? { title: '选哪个', options: [{ label: '甲' }, { label: '乙' }] } : {}),
  ...(name === 'update_todo' ? { title: '被改掉的标题' } : {}),
})

test('#117 guard: every tool that takes todo_id and writes refuses a Chief of another topic of the project; the two read tools do not', async () => {
  const ctx = await setup()
  try {
    const { db, call, mk, tools, topicA, runFrom, sessionRuns, activeWatches } = ctx
    const named = [...tools.values()].filter(d => d.inputSchema?.properties?.todo_id).map(d => d.name).sort()
    assert.deepEqual(named, [...WRITE_TOOLS, ...PROJECT_SCOPED_TOOLS].sort(), 'the tools that name a card: a new one is refused for another topic unless it is added to TODO_PROJECT_SCOPED_TOOLS')
    const card = await mk(topicA, '只有甲话题能动的卡')
    const runs = sessionRuns.length
    for (const name of WRITE_TOOLS) {
      const res = await call(name, inputFor(name, card.id), runFrom('sess-b'))
      assert.equal(res.ok, false, name)
      assert.equal(res.error, NOT_MANAGER, `${name}: ${res.content || res.thrown}`)
      assert.ok(res.content.includes('由话题「话题甲」'), `${name}: ${res.content}`)
    }
    const after = db.getTodo(1, 'default', card.id)
    assert.equal(after.revision, card.revision, 'nothing was written on the card')
    assert.equal(after.title, '只有甲话题能动的卡')
    assert.equal(after.phase, 'todo')
    assert.equal(sessionRuns.length, runs, 'no session was started')
    assert.deepEqual(activeWatches(card.id), [topicA.id])
    for (const name of ['get_todo_conversation', 'get_todo_diff', 'get_todo_detail']) {
      const res = await call(name, { todo_id: card.id }, runFrom('sess-b'))
      assert.notEqual(res.error, NOT_MANAGER, `${name} only reads`)
      assert.equal(res.ok, true, `${name}: ${res.content || res.thrown}`)
    }
    // The managing topic's own Chief and a caller that is no Chief are never refused by this guard.
    for (const name of WRITE_TOOLS) {
      for (const from of [runFrom('sess-a'), runFrom('sess-plain-chat'), ctx.run]) {
        const own = await mk(topicA, `放行 ${name}`)
        const res = await call(name, inputFor(name, own.id), from)
        assert.notEqual(res.error, NOT_MANAGER, `${name}: ${res.content}`)
      }
    }
  } finally { ctx.cleanup() }
})

test('#117 guard without a session id: two Chiefs of one project cannot be told apart, so a write is refused as ambiguous; the one that manages the card is let through alone', async () => {
  const ctx = await setup()
  try {
    const { db, orch, call, mk, topicA, hostEvent, run } = ctx
    const card = await mk(topicA, '并行总管时的卡')
    await hostEvent('chat.run.started', 'sess-a')
    assert.equal(orch.chiefTodoScopeCheck(run, 'run_build', card.id), null, 'one running Chief, the managing one')
    await hostEvent('chat.run.started', 'sess-b')
    const res = await call('run_build', { todo_id: card.id })
    assert.equal(res.error, AMBIGUOUS, res.content || res.thrown)
    assert.match(res.content, /为避免跨项目、跨话题误操作已拒绝/)
    assert.equal(db.getTodo(1, 'default', card.id).phase, 'todo')
    assert.equal(orch.chiefTodoScopeCheck(run, 'get_todo_diff', card.id), null, 'reading is open to both')
    await hostEvent('chat.run.completed', 'sess-a')
    const onlyB = orch.chiefTodoScopeCheck(run, 'run_build', card.id)
    assert.equal(onlyB.code, NOT_MANAGER, 'only the other topic\'s Chief runs: refused as not the manager')
    assert.match(onlyB.text, /调用未带会话身份/)
  } finally { ctx.cleanup() }
})

// ── 3. what a Chief is told about ────────────────────────────────────────────────────────────────────

test('#117 Chief prompt and list_todos: the task list and the digest hold the cards the topic manages; list_todos shows the project\'s other cards read-only with their managing topic', async () => {
  const ctx = await setup()
  try {
    const { orch, run, call, mk, topicA, topicB, chiefRuns, runFrom } = ctx
    const mine = await mk(topicB, '乙话题独有标题XB')
    const theirs = await mk(topicA, '甲话题独有标题XA')
    await orch.sendTopicMessage(run, { topicId: topicB.id, text: '看看进度' })
    const sent = chiefRuns('sess-b')
    assert.equal(sent.length, 1)
    const text = JSON.stringify(sent[0])
    assert.ok(text.includes('乙话题独有标题XB'), 'its own card is listed')
    assert.equal(text.includes('甲话题独有标题XA'), false, 'a card of another topic of the project is not')
    const listed = await call('list_todos', {}, runFrom('sess-b'))
    assert.equal(listed.ok, true, listed.content)
    const lineOf = id => listed.content.split('\n').find(l => l.includes(id))
    assert.ok(lineOf(mine.id).includes('| 本话题管理]'), lineOf(mine.id))
    assert.ok(lineOf(theirs.id).includes(`| 只读·由话题「话题甲」（${topicA.id}）管理]`), lineOf(theirs.id))
    assert.deepEqual(listed.data.todos.map(t => t.topicId).sort(), [topicA.id, topicB.id].sort())
    const prompt = buildChiefInstructions({ topic: topicB, projects: [], agents: [], activeTodos: [], chiefAgent: {}, settings: {}, memories: [] })
    assert.match(prompt, /every card has exactly one managing topic/)
    assert.match(prompt, /TODO_TOPIC_NOT_MANAGER/)
  } finally { ctx.cleanup() }
})

// ── 4. taking a card over ────────────────────────────────────────────────────────────────────────────

test('#117 take over: watch_todos with take_over moves the management; the old topic keeps its messages and goes silent, the new one is told and woken', async () => {
  const ctx = await setup()
  try {
    const { db, call, mk, finishBuild, topicA, topicB, runFrom, notices, chiefRuns, activeWatches, systemTexts, timeline } = ctx
    const card = await mk(topicA, '要被乙话题接管的卡')
    await finishBuild(card.id)
    assert.equal(notices(topicA.id).length, 1)
    const messagesBefore = db.getTopic(1, 'default', topicA.id).messages.map(m => m.id)
    const runsA = chiefRuns('sess-a').length
    const taken = await call('watch_todos', { topic_id: topicB.id, todo_id: card.id, take_over: true, reason: '用户要求在乙话题管理' }, runFrom('sess-b'))
    assert.equal(taken.ok, true, taken.content || taken.thrown)
    assert.deepEqual(taken.data, { topicId: topicB.id, todoId: card.id, tookOver: true, fromTopicId: topicA.id })
    assert.equal(db.getTodo(1, 'default', card.id).topicId, topicB.id, 'todos.topic_id is the new topic')
    assert.deepEqual(activeWatches(card.id), [topicB.id], 'the only watch is the new topic\'s')
    assert.equal(systemTexts(topicA.id).filter(t => t === `管理权转移：#${card.number} 要被乙话题接管的卡 已由话题「话题乙」接管。本话题不再收到它的进展，也不能再操作它；历史消息保留。`).length, 1)
    assert.equal(systemTexts(topicB.id).filter(t => t.startsWith(`管理权转移：#${card.number} 要被乙话题接管的卡 从话题「话题甲」转入本话题`)).length, 1)
    assert.ok(timeline(card.id).some(e => e === '管理话题变更：从话题「话题甲」转到话题「话题乙」；此后只有该话题收到进展并可操作这张卡'))
    const kept = db.getTopic(1, 'default', topicA.id).messages.map(m => m.id)
    assert.deepEqual(kept.slice(0, messagesBefore.length), messagesBefore, 'every message the old topic had is still there')
    assert.equal(kept.length, messagesBefore.length + 1, 'plus the one line that says the card left')
    // From now on: the new topic manages, the old one is refused and hears nothing.
    assert.equal((await call('cancel_build', { todo_id: card.id }, runFrom('sess-a'))).error, NOT_MANAGER)
    assert.equal((await finishBuild(card.id)).phase, 'review')
    assert.equal(notices(topicA.id).length, 1, 'no new notice in the old topic')
    assert.equal(chiefRuns('sess-a').length, runsA, 'its Chief is not woken again')
    assert.equal(notices(topicB.id).length, 1, 'the new topic is told')
    assert.equal(chiefRuns('sess-b').length, 1, 'and its Chief is woken')
    // Repeating the call is a plain watch: nothing moves and nothing is said twice.
    const again = await call('watch_todos', { topic_id: topicB.id, todo_id: card.id, take_over: true }, runFrom('sess-b'))
    assert.equal(again.ok, true)
    assert.equal(again.data, undefined)
    assert.equal(systemTexts(topicB.id).filter(t => t.startsWith('管理权转移')).length, 1)
  } finally { ctx.cleanup() }
})

test('#117 take over: a Chief takes a card into its own topic only; without take_over nothing moves; a failed write leaves nothing half done', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, mk, topicA, topicB, runFrom, activeWatches, systemTexts, hostEvent, chiefTopic } = ctx
    const card = await mk(topicA, '不能被代为接管的卡')
    const topicC = await chiefTopic('sess-c', '话题丙')
    // The Chief of A names topic C: it would hand the card to a topic it does not speak for.
    const forged = await call('watch_todos', { topic_id: topicC.id, todo_id: card.id, take_over: true }, runFrom('sess-a'))
    assert.equal(forged.ok, false)
    assert.equal(forged.error, NOT_MANAGER, forged.content || forged.thrown)
    assert.match(forged.content, /总管只能把卡片接管到自己所在的话题：你在话题「话题甲」/)
    // The Chief of B names topic C: the same.
    assert.equal((await call('watch_todos', { topic_id: topicC.id, todo_id: card.id, take_over: true }, runFrom('sess-b'))).error, NOT_MANAGER)
    // No session id and two running Chiefs: nothing says who is taking it.
    await hostEvent('chat.run.started', 'sess-b')
    await hostEvent('chat.run.started', 'sess-c')
    assert.equal((await call('watch_todos', { topic_id: topicB.id, todo_id: card.id, take_over: true })).error, AMBIGUOUS)
    await hostEvent('chat.run.completed', 'sess-b')
    await hostEvent('chat.run.completed', 'sess-c')
    // Without take_over the call only says who manages the card.
    const plain = await call('watch_todos', { topic_id: topicB.id, todo_id: card.id }, runFrom('sess-b'))
    assert.equal(plain.error, NOT_MANAGER)
    assert.match(plain.content, /^未关注。卡片 #\d+（td-[0-9a-f]+）由话题「话题甲」/)
    assert.equal(db.getTodo(1, 'default', card.id).topicId, topicA.id)
    assert.deepEqual(activeWatches(card.id), [topicA.id])
    assert.equal(systemTexts(topicB.id).length, 0)
    // The transfer is one transaction: the last write fails, so the first ones are undone.
    const addTopicMessage = db.addTopicMessage
    db.addTopicMessage = (u, p, topicId, m) => { if (topicId === topicB.id) throw new Error('disk full'); return addTopicMessage(u, p, topicId, m) }
    assert.throws(() => orch.watchTodoFromTopic(run, { topicId: topicB.id, todoId: card.id, takeOver: true }), /disk full/)
    db.addTopicMessage = addTopicMessage
    assert.equal(db.getTodo(1, 'default', card.id).topicId, topicA.id, 'the card did not move')
    assert.deepEqual(activeWatches(card.id), [topicA.id], 'its watch is where it was')
    assert.equal(systemTexts(topicA.id).filter(t => t.startsWith('管理权转移')).length, 0, 'and the old topic was told nothing')
    // The user (no Chief session) may move a card into any topic of the project.
    const byUser = await call('watch_todos', { topic_id: topicC.id, todo_id: card.id, take_over: true })
    assert.equal(byUser.ok, true, byUser.content || byUser.thrown)
    assert.equal(db.getTodo(1, 'default', card.id).topicId, topicC.id)
    assert.deepEqual(activeWatches(card.id), [topicC.id])
  } finally { ctx.cleanup() }
})

test('#117 archived managing topic: progress goes nowhere else, another topic of the project can take the card over, and the archived topic keeps its messages', async () => {
  const ctx = await setup()
  try {
    const { db, call, mk, finishBuild, topicA, topicB, runFrom, notices, chiefRuns, timeline, activeWatches } = ctx
    const card = await mk(topicA, '管理话题被归档的卡')
    db.addTopicMessage(1, 'default', topicA.id, { kind: 'human', text: '归档前说过的话' })
    db.updateTopic(1, 'default', topicA.id, { archived: true })
    assert.equal((await finishBuild(card.id)).phase, 'review')
    assert.equal(chiefRuns('sess-a').length + chiefRuns('sess-b').length, 0, 'nobody is woken')
    assert.equal(notices(topicB.id).length, 0, 'the notice is not rerouted to another topic')
    assert.ok(timeline(card.id).some(e => e === '进展通知未送达：话题「话题甲」已归档'))
    const refused = await call('run_build', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(refused.error, NOT_MANAGER)
    assert.match(refused.content, /的管理话题「话题甲」（topic-[0-9a-f]+）已归档/)
    const taken = await call('watch_todos', { topic_id: topicB.id, todo_id: card.id, take_over: true }, runFrom('sess-b'))
    assert.equal(taken.ok, true, taken.content || taken.thrown)
    assert.deepEqual(activeWatches(card.id), [topicB.id])
    assert.ok(db.getTopic(1, 'default', topicA.id).messages.some(m => m.text === '归档前说过的话'), 'the archived topic keeps what was said in it')
    // An archived topic takes nothing over.
    const back = await call('watch_todos', { topic_id: topicA.id, todo_id: card.id, take_over: true })
    assert.equal(back.error, NOT_MANAGER)
    assert.match(back.content, /已归档，不能接管/)
  } finally { ctx.cleanup() }
})

// ── 5. the rule is stored in the schema ──────────────────────────────────────────────────────────────

test('#117 schema: a second active watch is refused by the database itself, and moving a card ends the other topic\'s watch in the same statement', async () => {
  const ctx = await setup()
  try {
    const { db, mk, sql, rawWatch, topicA, topicB, activeWatches, rows } = ctx
    const card = await mk(topicA, '库里只能有一条关注的卡')
    // Written straight into the table, past every function of the plugin.
    assert.throws(() => rawWatch(topicB.id, card.id), /WATCH_NOT_MANAGING_TOPIC/)
    assert.throws(() => db.watchTodo(1, 'default', topicB.id, card.id, 'second topic'), /WATCH_NOT_MANAGING_TOPIC/)
    assert.deepEqual(activeWatches(card.id), [topicA.id])
    // An inactive row of another topic may exist; switching it on is refused as well.
    sql('INSERT INTO todo_watches (id, user_id, profile, topic_id, todo_id, reason, active, created_at) VALUES (\'w-off\', 1, \'default\', ?, ?, \'old\', 0, 1)', topicB.id, card.id)
    assert.throws(() => sql('UPDATE todo_watches SET active = 1 WHERE id = \'w-off\''), /WATCH_NOT_MANAGING_TOPIC/)
    // Moving the card (todos.topic_id) ends the watch of the topic it leaves.
    sql('UPDATE todos SET topic_id = ? WHERE id = ?', topicB.id, card.id)
    assert.deepEqual(activeWatches(card.id), [], 'the old topic\'s watch ended with the move')
    db.watchTodo(1, 'default', topicB.id, card.id, 'new managing topic')
    assert.deepEqual(activeWatches(card.id), [topicB.id])
    // The index alone: one active watch per card id, also for a card that is not (or no longer) stored.
    rawWatch(topicA.id, 'td-gone0001')
    assert.throws(() => rawWatch(topicB.id, 'td-gone0001'), /UNIQUE constraint failed: todo_watches\.todo_id/)
    assert.equal(rows('SELECT todo_id FROM todo_watches WHERE active = 1 GROUP BY todo_id HAVING COUNT(*) > 1').length, 0)
  } finally { ctx.cleanup() }
})

test('#117 notify: a second watch stored before the rule wakes nobody; it ends on the first event and the card says so once', async () => {
  const ctx = await setup()
  try {
    const { mk, finishBuild, dropRule, rawWatch, topicA, topicB, notices, chiefRuns, activeWatches, timeline, warnings } = ctx
    const card = await mk(topicA, '存量双关注的卡')
    dropRule()
    rawWatch(topicB.id, card.id)
    assert.deepEqual(activeWatches(card.id).sort(), [topicA.id, topicB.id].sort(), 'the stored state of the bug: two topics watch one card')
    assert.equal((await finishBuild(card.id)).phase, 'review')
    assert.equal(notices(topicB.id).length, 0, 'no notice in the topic that does not manage the card')
    assert.equal(chiefRuns('sess-b').length, 0, 'its Chief is not woken')
    assert.equal(notices(topicA.id).length, 1)
    assert.equal(chiefRuns('sess-a').length, 1)
    assert.deepEqual(activeWatches(card.id), [topicA.id], 'the foreign watch ended')
    const line = () => timeline(card.id).filter(e => e === '话题「话题乙」不是这张卡的管理话题，它的关注已结束：进展不投递到该话题，未唤醒其总管')
    assert.equal(line().length, 1)
    assert.ok(warnings.some(w => /not the managing topic/.test(w.message)))
    ctx.sql('UPDATE todo_watches SET active = 1 WHERE topic_id = ? AND todo_id = ?', topicB.id, card.id)
    await finishBuild(card.id)
    assert.equal(line().length, 1, 'said once')
    assert.equal(chiefRuns('sess-b').length, 0)
  } finally { ctx.cleanup() }
})

// ── 6. rows stored before the rule ───────────────────────────────────────────────────────────────────

test('#117 convergence: the plan reads only; opening the database applies it once, keeps the managing topic\'s watch and leaves no card with two', async () => {
  const ctx = await setup()
  const { mk, finishBuild, dropRule, rawWatch, sql, rows, topicA, topicB, dataDir, sqlitePath } = ctx
  try {
    const both = await mk(topicA, '甲乙都关注')            // watched by A (managing) and B        → B ends
    const onlyOther = await mk(topicA, '只有乙关注·未完成')   // watched by B only, unfinished      → B ends, A gets the watch
    const doneOther = await mk(topicA, '只有乙关注·已完成')   // watched by B only, done            → B ends, nobody watches
    const clean = await mk(topicB, '归属正常')              // watched by B (managing)            → untouched
    await finishBuild(clean.id)
    dropRule()
    rawWatch(topicB.id, both.id)
    sql('UPDATE todo_watches SET active = 0 WHERE todo_id IN (?, ?)', onlyOther.id, doneOther.id)
    rawWatch(topicB.id, onlyOther.id)
    rawWatch(topicB.id, doneOther.id)
    sql('UPDATE todos SET phase = \'done\' WHERE id = ?', doneOther.id)
    rawWatch(topicB.id, 'td-deleted1')                    // the card is gone                    → ends
    const active = () => rows('SELECT topic_id AS topicId, todo_id AS todoId FROM todo_watches WHERE active = 1 ORDER BY todo_id, topic_id')
    const before = active()
    const todosBefore = rows('SELECT id, topic_id, phase, revision, updated_at FROM todos ORDER BY id')
    const watchRowsBefore = rows('SELECT COUNT(*) AS n FROM todo_watches')[0].n
    assert.equal(rows('SELECT todo_id FROM todo_watches WHERE active = 1 GROUP BY todo_id HAVING COUNT(*) > 1').length, 1)

    // The plan, on a read-only handle: it cannot write.
    const ro = new DatabaseSync(sqlitePath, { readOnly: true })
    const plan = planWatchConvergence(ro)
    ro.close()
    assert.deepEqual(active(), before, 'planning stored nothing')
    assert.deepEqual(plan.deactivate.map(r => [r.todoId, r.topicId, r.managingTopicId, r.todoMissing]).sort(), [
      [both.id, topicB.id, topicA.id, false],
      [onlyOther.id, topicB.id, topicA.id, false],
      [doneOther.id, topicB.id, topicA.id, false],
      ['td-deleted1', topicB.id, '', true],
    ].sort())
    assert.deepEqual(plan.repoint.map(r => [r.todoId, r.topicId]), [[onlyOther.id, topicA.id]])

    // Opening the database (what a plugin reload does) applies exactly that plan.
    ctx.db.close()
    const reopened = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
    try {
      assert.deepEqual(reopened.watchConvergence.deactivate.map(r => r.id).sort(), plan.deactivate.map(r => r.id).sort())
      assert.deepEqual(reopened.watchConvergence.repoint.map(r => r.todoId), [onlyOther.id])
      assert.equal(reopened.watchConvergence.error, '')
      assert.deepEqual(active(), [
        { topicId: topicA.id, todoId: both.id },
        { topicId: topicA.id, todoId: onlyOther.id },
        { topicId: topicB.id, todoId: clean.id },
      ].sort((a, b) => (a.todoId < b.todoId ? -1 : 1)))
      assert.equal(rows('SELECT w.id FROM todo_watches w LEFT JOIN todos t ON t.id = w.todo_id WHERE w.active = 1 AND (t.id IS NULL OR t.topic_id != w.topic_id)').length, 0, 'no active watch outside the managing topic')
      assert.deepEqual(rows('SELECT id, topic_id, phase, revision, updated_at FROM todos ORDER BY id'), todosBefore, 'no card was touched')
      assert.equal(rows('SELECT COUNT(*) AS n FROM todo_watches')[0].n, watchRowsBefore, 'no row is deleted: ended watches stay with active = 0, and the managing topic\'s old row is switched on again')
      assert.throws(() => rawWatch(topicB.id, both.id), /UNIQUE|WATCH_NOT_MANAGING_TOPIC/, 'and the rule is stored again')
    } finally { reopened.close() }
    // Repeating it changes nothing.
    const raw = new DatabaseSync(sqlitePath)
    const second = convergeTodoWatches(raw)
    raw.close()
    assert.deepEqual(second, { deactivate: [], repoint: [] })
  } finally { ctx.cleanup() }
})

// ── 7. cards made at the same time ───────────────────────────────────────────────────────────────────

test('#117 concurrent creation: cards made from two topics at once each get one watch, of their own topic', async () => {
  const ctx = await setup()
  try {
    const { db, orch, alpha, topicA, topicB, runFrom, rows } = ctx
    const jobs = []
    for (let i = 0; i < 8; i += 1) {
      const [topic, sid] = i % 2 ? [topicB, 'sess-b'] : [topicA, 'sess-a']
      // Half name the topic, half are resolved from the calling Chief session.
      jobs.push(orch.createTodo(runFrom(sid), { projectId: alpha.id, title: `并发卡 ${i}`, actor: 'chief', ...(i < 4 ? { topicId: topic.id } : {}) }).then(r => ({ todo: r.todo, topic })))
    }
    const made = await Promise.all(jobs)
    assert.equal(new Set(made.map(m => m.todo.id)).size, 8)
    for (const { todo, topic } of made) {
      assert.equal(todo.topicId, topic.id, `${todo.title} belongs to the topic that made it`)
      assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', todo.id).map(w => w.topicId), [topic.id])
    }
    assert.equal(rows('SELECT COUNT(*) AS n FROM todo_watches WHERE active = 1')[0].n, 8)
    assert.equal(rows('SELECT w.id FROM todo_watches w JOIN todos t ON t.id = w.todo_id WHERE w.active = 1 AND t.topic_id != w.topic_id').length, 0)
  } finally { ctx.cleanup() }
})

// ── 8. the card says who manages it ──────────────────────────────────────────────────────────────────

test('#117 drawer: the card shows its managing topic, and says so when that topic is archived, deleted or not set', async () => {
  const mod = await loadClient({ ManagingTopicTag: 'components/TodoDrawer.jsx', managingTopicOf: 'utils.js' })
  try {
    const { React, ManagingTopicTag, managingTopicOf } = mod
    const topics = [{ id: 'topic-a', title: '天机阁新增功能' }, { id: 'topic-old', title: '旧话题', archived: true }]
    const shown = async todo => {
      const view = await mountElement(mod, React.createElement(ManagingTopicTag, { todo, topics }))
      const el = byTestId(view.container, 'todo-managing-topic')
      const out = { text: el.textContent, state: el.getAttribute('data-state'), topicId: el.getAttribute('data-topic-id'), title: el.getAttribute('title') }
      view.unmount()
      return out
    }
    const ok = await shown({ id: 'td-1', topicId: 'topic-a' })
    assert.equal(ok.text, '管理话题天机阁新增功能')
    assert.equal(ok.state, 'ok')
    assert.equal(ok.topicId, 'topic-a')
    assert.match(ok.title, /只有这个话题的总管会收到它的进展并能操作它，其他话题只读/)
    assert.deepEqual([(await shown({ id: 'td-2', topicId: 'topic-old' })).text, (await shown({ id: 'td-2', topicId: 'topic-old' })).state], ['管理话题旧话题（已归档）', 'archived'])
    assert.deepEqual([(await shown({ id: 'td-3', topicId: 'topic-gone' })).text, (await shown({ id: 'td-3', topicId: 'topic-gone' })).state], ['管理话题管理话题已不存在', 'missing'])
    assert.equal((await shown({ id: 'td-4', topicId: '' })).state, 'none')
    assert.equal(managingTopicOf(null, null).state, 'none')
    // The drawer renders it and the page hands it the topics.
    assert.match(read('src/client/components/TodoDrawer.jsx'), /<ManagingTopicTag todo=\{todo\} topics=\{topics\} \/>/)
    assert.match(read('src/client/App.jsx'), /<TodoDrawer\s+todo=\{drawerTodo\}\s+project=\{drawerProject\}\s+topics=\{state\.topics\}/)
  } finally { cleanupClient() }
})

// ── 9. contract and documents ────────────────────────────────────────────────────────────────────────

test('#117: the contract and CONTRACTS.md describe the rule, the error code, take_over and the stored index and triggers', () => {
  const contract = JSON.parse(read('contracts/plugin.json'))
  const docs = read('docs/CONTRACTS.md')
  for (const name of WRITE_TOOLS) assert.ok(contract.tools[name].description.includes('TODO_TOPIC_NOT_MANAGER'), name)
  for (const name of ['get_todo_conversation', 'get_todo_diff']) assert.ok(contract.tools[name].description.includes('#117: read-only'), name)
  assert.ok(contract.tools.watch_todos.description.includes('take_over'))
  assert.ok(contract.tools.list_todos.description.includes('managing topic'))
  for (const needle of ['TODO_TOPIC_NOT_MANAGER', 'take_over', 'idx_todo_watches_one_active', 'trg_todo_watch_manager_insert', 'trg_todo_topic_moves_watch', 'convergeTodoWatches', 'topicManagesTodo']) {
    assert.ok(docs.includes(needle), `CONTRACTS.md names ${needle}`)
  }
  assert.equal(docs.includes('一张卡只能由同项目的话题关注'), false, 'the sentence of the old rule is gone')
})

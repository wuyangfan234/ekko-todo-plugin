// Todo #125, second part: the user message a card comes from carries the card's id (topic_messages.todo_id),
// so get_todo_detail returns what the user asked for. Before it only progress notices carried a card id and
// `topicMessages` never held a word of the user.
// The link is written from what is known, never guessed from time or wording:
//   L1 known caller    identity.sessionId, or exactly one Chief with the tool open under its own name
//   L2 same topic      the card is managed by the caller's own topic
//   L3 one card        a message is about one card, the first one; only kind human
//   L4 the turn        the message that started the Chief turn; a wake turn has none
//   L5 tool only       create_todo / message_todo of a Chief; a card made on the page links nothing
// Each rule is exercised through the registered tools and the turn functions of the orchestrator.
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

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
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

// Project alpha with Chief topics A (sess-a) and B (sess-b); project beta with topic C (sess-c).
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t125b-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn() {}, info() {} } })
  const sessionRuns = []
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
      async connect(sid, cb) { setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(working.get(sid)), runStartedAt: Date.now() }), 2); return { close() {} } },
      async run(sid, input, opts) { sessionRuns.push({ sid, input, opts }); working.set(sid, true); return { run_id: `r-${sessionRuns.length}` } },
      async stop(sid) { working.set(sid, false) },
      async messages() { return { messages: [] } },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const runFrom = sessionId => ({ ...run, identity: { ...run.identity, sessionId } })
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const project = async name => {
    const dir = join(root, name)
    initRepo(dir)
    return (await orch.addProject(run, { name, repoPath: dir })).project
  }
  const alpha = await project('alpha')
  const beta = await project('beta')
  const chiefTopic = async (proj, sessionId, title) => {
    const { topic } = await orch.createTopic(run, { projectId: proj.id, title })
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId, autopilot: true })
    return db.getTopic(1, 'default', topic.id)
  }
  const topicA = await chiefTopic(alpha, 'sess-a', '话题甲')
  const topicB = await chiefTopic(alpha, 'sess-b', '话题乙')
  const topicC = await chiefTopic(beta, 'sess-c', '话题丙')
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const call = async (name, input, from = run) => {
    try { return await tools.get(name).execute(input, from) } catch (err) { return { ok: false, thrown: err?.message || String(err) } }
  }
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const fingerprint = () => {
    const raw = new DatabaseSync(sqlitePath, { readOnly: true })
    try {
      const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name)
      return JSON.stringify(names.map(name => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
    } finally { raw.close() }
  }
  const hostEvent = (type, sessionId, data = {}) => orch.handleHostEvent({ type, data: { session_id: sessionId, ...data } }, run)
  const messages = topic => db.getTopic(1, 'default', topic.id).messages
  const humans = topic => messages(topic).filter(m => m.kind === 'human').map(m => [m.text, m.todoId])
  // The user says something in a topic: a Chief turn starts for it.
  const say = async (topic, text) => {
    const before = sessionRuns.length
    await orch.sendTopicMessage(run, { topicId: topic.id, text })
    assert.equal(sessionRuns.length, before + 1, `a Chief turn started for「${text}」`)
    return messages(topic).filter(m => m.kind === 'human' && m.text === text).at(-1)
  }
  // The Chief turn of the topic ends.
  const endTurn = async topic => {
    const sid = db.getTopic(1, 'default', topic.id).chiefSessionId
    working.set(sid, false)
    await hostEvent('chat.run.completed', sid)
    db.updateTopic(1, 'default', topic.id, { isRunning: false, activeRunId: '' })
  }
  const create = (title, from, extra = {}) => call('create_todo', { project_id: alpha.id, title, spec: `${title}的任务书`, ...extra }, from)
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, alpha, beta, topicA, topicB, topicC, tools, call, fingerprint, hostEvent, messages, humans, say, endTurn, create, sessionRuns, working, cleanup }
}

test('#125 link: the user message that started the turn carries the id of the card the Chief creates, and get_todo_detail returns the user\'s words without writing', async () => {
  const ctx = await setup()
  try {
    const { say, endTurn, create, runFrom, topicA, humans, call, fingerprint, db } = ctx
    // Ordinary chat first: a turn in which no card is made.
    await say(topicA, '今天先随便聊聊XCHAT')
    await endTurn(topicA)
    const asked = await say(topicA, '把回测延迟降到 200ms 以内XASK')
    assert.equal(asked.todoId, '', 'not about a card until one is created')
    const made = await create('回测延迟修复', runFrom('sess-a'))
    assert.equal(made.ok, true, made.content || made.thrown)
    assert.deepEqual(humans(topicA), [['今天先随便聊聊XCHAT', ''], ['把回测延迟降到 200ms 以内XASK', made.data.id]], 'the message of this turn, and only it')
    // Nothing else of the row changed.
    const stored = ctx.messages(topicA).find(m => m.id === asked.id)
    assert.deepEqual({ ...stored, todoId: '' }, asked)
    await endTurn(topicA)
    // Another topic of the project reads the user's words; the read writes nothing.
    const before = fingerprint()
    const res = await call('get_todo_detail', { todo_id: made.data.id }, runFrom('sess-b'))
    assert.equal(res.ok, true, res.content || res.thrown)
    assert.equal(fingerprint(), before, 'get_todo_detail still only reads')
    assert.deepEqual(res.data.topicMessages.map(m => [m.kind, m.text, m.topicId]), [['human', '把回测延迟降到 200ms 以内XASK', topicA.id]])
    assert.ok(res.content.includes('[human] 把回测延迟降到 200ms 以内XASK'), res.content)
    assert.equal(res.data.topicMessages.some(m => m.text.includes('XCHAT')), false, 'ordinary chat is not returned')
    assert.equal(res.content.includes('] 今天先随便聊聊XCHAT'), false)
    assert.equal(db.getTodo(1, 'default', made.data.id).topicId, topicA.id)
  } finally { ctx.cleanup() }
})

test('#125 link L3: a message is about one card, the first one; a later card of the same turn and a card of another turn do not take it', async () => {
  const ctx = await setup()
  try {
    const { say, endTurn, create, runFrom, topicA, humans, call, db } = ctx
    await say(topicA, '做两件事：登录和导出XTWO')
    const first = await create('登录', runFrom('sess-a'))
    const second = await create('导出', runFrom('sess-a'))
    assert.equal(first.ok && second.ok, true)
    assert.deepEqual(humans(topicA), [['做两件事：登录和导出XTWO', first.data.id]])
    assert.deepEqual((await call('get_todo_detail', { todo_id: second.data.id }, runFrom('sess-a'))).data.topicMessages, [], 'the second card has no message of the user')
    await endTurn(topicA)
    // The next user turn has its own message; the earlier one stays with its card.
    await say(topicA, '再加一个搜索XNEXT')
    const third = await create('搜索', runFrom('sess-a'))
    assert.deepEqual(humans(topicA), [['做两件事：登录和导出XTWO', first.data.id], ['再加一个搜索XNEXT', third.data.id]])
    // The query itself: only a human message that is not about a card yet, of that topic.
    const msgs = ctx.messages(topicA)
    assert.equal(db.linkTopicMessageToTodo(1, 'default', topicA.id, msgs[0].id, second.data.id), false, 'never moved to another card')
    const sysId = db.addTopicMessage(1, 'default', topicA.id, { kind: 'system', text: '系统注记' })
    assert.equal(db.linkTopicMessageToTodo(1, 'default', topicA.id, sysId, second.data.id), false, 'only a user message')
    const loose = db.addTopicMessage(1, 'default', topicA.id, { kind: 'human', text: '另一条' })
    assert.equal(db.linkTopicMessageToTodo(1, 'default', ctx.topicB.id, loose, second.data.id), false, 'only in its own topic')
    assert.equal(db.linkTopicMessageToTodo(1, 'default', topicA.id, loose, ''), false)
    assert.equal(db.linkTopicMessageToTodo(1, 'default', topicA.id, loose, second.data.id), true)
  } finally { ctx.cleanup() }
})

test('#125 link L1: without a session id only a Chief with create_todo open under its own name is linked; a running Chief or a tool_call wrapper is not', async () => {
  const ctx = await setup()
  try {
    const { say, endTurn, create, run, topicA, humans, hostEvent } = ctx
    await say(topicA, '第一件事XRUN')
    // The Chief is running (chat.run.started) but nothing shows that it holds create_todo: the card is made,
    // the message is not linked.
    await hostEvent('chat.run.started', 'sess-a')
    const guessed = await create('凭运行推断', run)
    assert.equal(guessed.ok, true, guessed.content || guessed.thrown)
    assert.equal(guessed.data.topicResolvedBy, 'active-run')
    assert.deepEqual(humans(topicA), [['第一件事XRUN', '']])
    // A tool_call wrapper hides which tool is open.
    await hostEvent('chat.tool.started', 'sess-a', { name: 'mcp__magpie__tool_call' })
    const wrapped = await create('经包装调用', run)
    assert.equal(wrapped.ok, true, wrapped.content || wrapped.thrown)
    assert.deepEqual(humans(topicA), [['第一件事XRUN', '']])
    await hostEvent('chat.tool.completed', 'sess-a', { name: 'mcp__magpie__tool_call' })
    // The tool open under its own name, by one Chief: known.
    await hostEvent('chat.tool.started', 'sess-a', { name: CREATE_TOOL })
    const named = await create('按工具名调用', run)
    assert.equal(named.ok, true, named.content || named.thrown)
    assert.deepEqual(humans(topicA), [['第一件事XRUN', named.data.id]])
    await endTurn(topicA)
  } finally { ctx.cleanup() }
})

test('#125 link L1: two Chiefs with create_todo open at once link nothing', async () => {
  const ctx = await setup()
  try {
    const { say, create, run, topicA, topicB, humans, hostEvent } = ctx
    await say(topicA, '甲话题的要求XA')
    await say(topicB, '乙话题的要求XB')
    await hostEvent('chat.tool.started', 'sess-a', { name: CREATE_TOOL })
    await hostEvent('chat.tool.started', 'sess-b', { name: CREATE_TOOL })
    const made = await create('分不清是谁建的', run)
    assert.equal(made.ok, true, made.content || made.thrown)
    assert.deepEqual(humans(topicA), [['甲话题的要求XA', '']])
    assert.deepEqual(humans(topicB), [['乙话题的要求XB', '']])
  } finally { ctx.cleanup() }
})

test('#125 link L2: a card that goes to another topic is not linked to the caller\'s message, and a message of another topic is never taken', async () => {
  const ctx = await setup()
  try {
    const { say, create, runFrom, topicA, topicB, topicC, humans, call, alpha } = ctx
    await say(topicA, '甲话题的要求XA')
    await say(topicB, '乙话题的要求XB')
    await say(topicC, '丙话题（另一个项目）的要求XC')
    // The Chief of A puts the card into topic B by topic_id.
    const elsewhere = await create('建到乙话题', runFrom('sess-a'), { topic_id: topicB.id })
    assert.equal(elsewhere.ok, true, elsewhere.content || elsewhere.thrown)
    assert.equal(elsewhere.data.topicId, topicB.id)
    assert.deepEqual([humans(topicA), humans(topicB)], [[['甲话题的要求XA', '']], [['乙话题的要求XB', '']]])
    // The Chief of C (project beta) creates a card of alpha: it is sent to a topic of alpha (#97).
    const redirected = await create('别的项目的总管建的', runFrom('sess-c'))
    assert.equal(redirected.ok, true, redirected.content || redirected.thrown)
    assert.notEqual(redirected.data.topicId, topicC.id)
    assert.deepEqual(humans(topicC), [['丙话题（另一个项目）的要求XC', '']], 'a message of another project is never tied to the card')
    assert.deepEqual([humans(topicA), humans(topicB)], [[['甲话题的要求XA', '']], [['乙话题的要求XB', '']]])
    const detail = await call('get_todo_detail', { todo_id: redirected.data.id }, runFrom('sess-a'))
    assert.equal(JSON.stringify(detail.data.topicMessages).includes('XC'), false)
    // Its own card, in its own topic, is linked as usual.
    // The same rule for a later instruction: a card of topic B is not tied to a message of topic A.
    assert.equal(ctx.orch.linkTurnMessageToTodo(runFrom('sess-a'), 'message_todo', elsewhere.data.id), '')
    assert.deepEqual(humans(topicA), [['甲话题的要求XA', '']])
    const own = await create('甲话题自己的卡', runFrom('sess-a'))
    assert.deepEqual(humans(topicA), [['甲话题的要求XA', own.data.id]])
    assert.ok(alpha.id)
  } finally { ctx.cleanup() }
})

test('#125 link L4: a wake turn answers no user message, so a card made in it is not tied to the last thing the user said', async () => {
  const ctx = await setup()
  try {
    const { say, endTurn, create, runFrom, topicA, humans, db, orch, run, sessionRuns } = ctx
    await say(topicA, '看看进度XOLD')
    await endTurn(topicA)
    // An automated wake starts the next turn of the topic.
    db.enqueueTopicItem(1, 'default', topicA.id, { kind: 'wake', text: 'Automated wake: #1 finished building.' })
    const item = db.listTopicQueue(1, 'default', topicA.id)[0]
    const before = sessionRuns.length
    await orch.promoteTopicQueueItem(run, { topicId: topicA.id, itemId: item.id })
    assert.equal(sessionRuns.length, before + 1, 'the wake turn started')
    const made = await create('总管自己起意建的卡', runFrom('sess-a'))
    assert.equal(made.ok, true, made.content || made.thrown)
    assert.deepEqual(humans(topicA), [['看看进度XOLD', '']])
    await endTurn(topicA)
    // A queued follow-up of the user that is delivered later is a user turn again.
    db.enqueueTopicItem(1, 'default', topicA.id, { kind: 'human', text: '排队后送达的要求XQ' })
    const queued = db.listTopicQueue(1, 'default', topicA.id)[0]
    await orch.promoteTopicQueueItem(run, { topicId: topicA.id, itemId: queued.id })
    const later = await create('排队消息建的卡', runFrom('sess-a'))
    assert.deepEqual(humans(topicA), [['看看进度XOLD', ''], ['排队后送达的要求XQ', later.data.id]])
    await endTurn(topicA)
    // A wake that is delivered at once (the Chief is idle) is a wake turn too.
    await say(topicA, '又说了一句XDIRECT')
    await endTurn(topicA)
    const beforeWake = sessionRuns.length
    await orch.maybeWakeChief(run, 1, 'default', db.getTodo(1, 'default', later.data.id), ctx.alpha, '构建完成')
    assert.equal(sessionRuns.length, beforeWake + 1, 'the wake was delivered as a run')
    await create('直接唤醒里建的卡', runFrom('sess-a'))
    assert.deepEqual(humans(topicA).at(-1), ['又说了一句XDIRECT', ''])
  } finally { ctx.cleanup() }
})

test('#125 link L5: a card made on the page (not by the create_todo tool) links nothing, also while a Chief turn of the topic runs', async () => {
  const ctx = await setup()
  try {
    const { say, runFrom, topicA, humans, orch, run, alpha } = ctx
    await say(topicA, '用户正在和总管说话XPAGE')
    await orch.createTodo(run, { projectId: alpha.id, topicId: topicA.id, title: '页面上建的卡' })
    await orch.createTodo(runFrom('sess-a'), { projectId: alpha.id, title: '不经工具的调用', actor: 'chief' })
    assert.deepEqual(humans(topicA), [['用户正在和总管说话XPAGE', '']])
  } finally { ctx.cleanup() }
})

test('#125 link: a later instruction of the user that the Chief passes on with message_todo is tied to that card; rows stored before are not rewritten', async () => {
  const ctx = await setup()
  try {
    const { say, endTurn, create, runFrom, topicA, topicB, humans, call, db, orch } = ctx
    // Stored before the rule: a user message and a card with nothing between them.
    const oldId = db.addTopicMessage(1, 'default', topicA.id, { kind: 'human', text: '很久以前说的话XHIST' })
    const { todo: old } = await orch.createTodo(ctx.run, { projectId: ctx.alpha.id, topicId: topicA.id, title: '很久以前的卡' })
    await say(topicA, '建一张卡XFIRST')
    const made = await create('要补充指令的卡', runFrom('sess-a'))
    await endTurn(topicA)
    await say(topicA, '补充：还要支持导出XMORE')
    // Topic B does not manage the card: refused, nothing linked.
    const refused = await call('message_todo', { todo_id: made.data.id, message: '还要支持导出' }, runFrom('sess-b'))
    assert.equal(refused.error, 'TODO_TOPIC_NOT_MANAGER')
    const sent = await call('message_todo', { todo_id: made.data.id, message: '还要支持导出' }, runFrom('sess-a'))
    assert.equal(sent.ok, true, sent.content || sent.thrown)
    assert.deepEqual(humans(topicA), [['很久以前说的话XHIST', ''], ['建一张卡XFIRST', made.data.id], ['补充：还要支持导出XMORE', made.data.id]])
    assert.deepEqual(humans(topicB), [])
    const res = await call('get_todo_detail', { todo_id: made.data.id }, runFrom('sess-b'))
    assert.deepEqual(res.data.topicMessages.filter(m => m.kind === 'human').map(m => m.text), ['建一张卡XFIRST', '补充：还要支持导出XMORE'])
    assert.equal(ctx.messages(topicA).find(m => m.id === oldId).todoId, '', 'no back-fill')
    assert.equal((await call('get_todo_detail', { todo_id: old.id }, runFrom('sess-a'))).data.topicMessages.some(m => m.kind === 'human'), false)
  } finally { ctx.cleanup() }
})

test('#125 link: documents and the server bundle say it', () => {
  const contract = JSON.parse(read('contracts/plugin.json'))
  for (const name of ['create_todo', 'message_todo', 'get_todo_detail']) assert.ok(contract.tools[name].description.includes('topic_messages.todo_id'), name)
  assert.match(read('docs/CONTRACTS.md'), /User message of a card \(#125\)/)
  assert.match(read('docs/FIELD_REFERENCE.md'), /用户消息与卡片的关联/)
  assert.match(read('CHANGELOG.md'), /## \[0\.9\.81\][\s\S]*?你当时说的那句话[\s\S]*?## \[0\.9\.80\]/)
  const bundle = read('dist/server.mjs')
  for (const word of ['linkTopicMessageToTodo', 'linkTurnMessageToTodo', 'turnMessageOf']) assert.ok(bundle.includes(word), `dist/server.mjs has ${word}`)
})

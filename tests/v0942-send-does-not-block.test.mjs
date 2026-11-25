// v0.9.42 (Todo #23 rework): sending a message must not wait for the Chief / worker run to be accepted by the
// host. The host can hold `sessions.run` for 120 s (a run sent into a busy session); the caller timed out,
// retried, and the retry was stored or executed a second time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(20) } return cond() }
// 'returned' when the call answers inside `ms`, 'blocked' when it is still waiting.
const answersWithin = (promise, ms) => Promise.race([
  promise.then(v => ({ state: 'returned', value: v }), e => ({ state: 'rejected', error: e })),
  sleep(ms).then(() => ({ state: 'blocked' })),
])

const rejections = []
process.on('unhandledRejection', err => { rejections.push(err) })

function setup({ orchOpts = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-nonblock-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const warns = []
  const log = { warn(msg, data) { warns.push({ msg, data }) }, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], ...orchOpts })
  let seq = 0
  const sessions = new Map()
  const calls = { run: 0, runDone: 0, connect: 0 }
  // hold: the host keeps `sessions.run` open until release() (stands for the 120 s block).
  const flags = { runDelayMs: 0, runFails: false, hold: null, connectDelayMs: 0 }
  const emitted = []
  const hold = () => { let release; const promise = new Promise(r => { release = r }); flags.hold = { promise, release: () => { flags.hold = null; release() } }; return flags.hold }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        calls.run += 1
        if (flags.hold) await flags.hold.promise
        if (flags.runDelayMs) await sleep(flags.runDelayMs)
        if (flags.runFails) throw new Error('{"ok":false,"status":"failed","event":"run.failed","error":"engine exploded while starting","session_id":"' + id + '","output":""}')
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        calls.runDone += 1
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false } },
      // The live probe: answers `resumed` with the session's working flag after connectDelayMs.
      async connect(id, cb) {
        calls.connect += 1
        const timer = setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(sessions.get(id)?.is_running), runStartedAt: 0, queueLength: 0 }), flags.connectDelayMs)
        return { close() { clearTimeout(timer) } }
      },
    },
  }
  const run = {
    identity: { userId: 1, profile: 'default' },
    host,
    messages: { emit(name, payload) { emitted.push({ name, reason: payload?.reason, at: Date.now() }) } },
  }
  const cleanup = () => { flags.hold?.release(); try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  const humans = topicId => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'human')
  const queue = topicId => db.listTopicQueue(1, 'default', topicId)
  return { root, db, orch, run, emitted, calls, flags, sessions, cleanup, humans, queue, warns, hold, dataDir }
}

// ---- A. the send call does not wait for the launch ----------------------------------------------------

test('v0.9.42: a host that takes 3 s to accept the run does not hold send-topic-message', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, flags, humans, emitted, warns } = ctx
    const topic = db.createTopic(1, 'default', {})
    flags.runDelayMs = 3000
    const startedAt = Date.now()
    const res = await answersWithin(orch.sendTopicMessage(run, { topicId: topic.id, text: '启动要三秒', clientNonce: 'cn-3s' }), 2000)
    const tookMs = Date.now() - startedAt
    assert.equal(res.state, 'returned', 'the call answered while the host was still starting the run')
    assert.ok(tookMs < 1500, `answered after ${tookMs} ms (budget 800 ms)`)
    assert.equal(humans(topic.id).length, 1, 'stored once')
    assert.equal(calls.runDone, 0, 'the run is still being started')
    const view = res.value.topics.find(t => t.id === topic.id)
    assert.equal(view.launching, true, 'the snapshot says the Chief is still being started')
    assert.equal(view.messages.filter(m => m.clientNonce === 'cn-3s').length, 1)
    assert.equal(view.launchingMessageId, view.messages.find(m => m.clientNonce === 'cn-3s').id, 'and for which message')

    assert.ok(await until(() => calls.runDone === 1, 5000), 'the launch finished in the background')
    await until(() => emitted.some(e => e.reason === `topic.run.started:${topic.id}`), 1000)
    assert.ok(emitted.some(e => e.reason === `topic.run.started:${topic.id}`), 'topic.run.started announced when it finished')
    assert.equal(calls.run, 1, 'run once')
    assert.equal(humans(topic.id).length, 1)
    assert.equal(humans(topic.id)[0].sendError, undefined)
    assert.equal(db.getTopic(1, 'default', topic.id).isRunning, true)
    const snapAfter = await orch.getSnapshot(run)
    assert.equal(snapAfter.topics.find(t => t.id === topic.id).launching, undefined)
    // D: a launch slower than 3 s is written to the host log with the topic and the time it took.
    const slow = warns.find(w => /slow/i.test(w.msg) && w.data?.topicId === topic.id)
    assert.ok(slow, 'slow launch logged')
    assert.ok(slow.data.ms >= 3000, `logged ${slow.data.ms} ms`)
  } finally { ctx.cleanup() }
})

test('v0.9.42: a host that blocks the run for 120 s: the call returns, a retry stores and runs nothing more', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, humans, queue, hold } = ctx
    const topic = db.createTopic(1, 'default', {})
    const gate = hold() // released by the test instead of waiting 120 s
    const first = await answersWithin(orch.sendTopicMessage(run, { topicId: topic.id, text: '宿主卡住', clientNonce: 'cn-120' }), 2000)
    assert.equal(first.state, 'returned')
    assert.equal(humans(topic.id).length, 1)
    // The caller gave up and sends the same message again (same nonce), twice.
    for (let i = 0; i < 2; i += 1) {
      const again = await answersWithin(orch.sendTopicMessage(run, { topicId: topic.id, text: '宿主卡住', clientNonce: 'cn-120' }), 2000)
      assert.equal(again.state, 'returned')
    }
    assert.equal(humans(topic.id).length, 1, 'no second bubble')
    assert.equal(queue(topic.id).length, 0, 'not queued either')
    assert.equal(calls.run, 1, 'no second run sent to the host')
    // A different message sent meanwhile waits in the queue, once.
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '另一条', clientNonce: 'cn-other' })
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '另一条', clientNonce: 'cn-other' })
    assert.deepEqual(queue(topic.id).map(q => q.clientNonce), ['cn-other'])
    gate.release()
    assert.ok(await until(() => calls.runDone === 1))
    await sleep(50)
    assert.equal(calls.run, 1, 'after the host let go: still one run for that message')
    assert.equal(humans(topic.id).length, 1)
  } finally { ctx.cleanup() }
})

test('v0.9.42: a launch that fails after the call returned writes the reason on the message, once, with no unhandled rejection', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, flags, humans, queue, emitted, warns } = ctx
    const topic = db.createTopic(1, 'default', {})
    flags.runDelayMs = 1200
    flags.runFails = true
    const before = rejections.length
    const res = await answersWithin(orch.sendTopicMessage(run, { topicId: topic.id, text: '后台会失败', clientNonce: 'cn-bgfail' }), 2000)
    assert.equal(res.state, 'returned', 'the call answered (accepted) before the launch failed')
    assert.equal(humans(topic.id)[0].sendError, undefined, 'no error yet')
    assert.ok(await until(() => Boolean(humans(topic.id)[0].sendError), 4000), 'the reason arrived on the message')
    const stored = humans(topic.id)
    assert.equal(stored.length, 1)
    assert.match(stored[0].sendError, /engine exploded while starting/)
    assert.ok(!stored[0].sendError.includes('{'), 'readable, not the raw host envelope')
    assert.equal(queue(topic.id).length, 0, 'not also a queued follow-up')
    assert.ok(emitted.some(e => e.reason === `topic.message.failed:${topic.id}`), 'announced, not silent')
    assert.ok(warns.some(w => w.data?.topicId === topic.id && /engine exploded/.test(String(w.data?.error))), 'written to the log')
    assert.equal(db.getTopic(1, 'default', topic.id).isRunning, false)
    const snap = await orch.getSnapshot(run)
    assert.equal(snap.topics.find(t => t.id === topic.id).launching, undefined)
    await sleep(30)
    assert.equal(rejections.length, before, 'no unhandled rejection')
    // The topic is usable again.
    flags.runFails = false
    flags.runDelayMs = 0
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '再发一次', clientNonce: 'cn-bgfail-2' })
    assert.equal(humans(topic.id).length, 2)
  } finally { ctx.cleanup() }
})

test('v0.9.42: a launch that fails inside the budget still fails the call, as before', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, flags, humans } = ctx
    const topic = db.createTopic(1, 'default', {})
    flags.runFails = true
    await assert.rejects(() => orch.sendTopicMessage(run, { topicId: topic.id, text: '马上失败', clientNonce: 'cn-fast-fail' }), /engine exploded/)
    assert.equal(humans(topic.id).length, 1)
    assert.ok(humans(topic.id)[0].sendError)
  } finally { ctx.cleanup() }
})

// ---- B. a retry inside the probe window ---------------------------------------------------------------

async function runningTopic(ctx) {
  const { db, orch, run } = ctx
  const topic = db.createTopic(1, 'default', {})
  await orch.sendTopicMessage(run, { topicId: topic.id, text: '第一轮', clientNonce: 'cn-turn1' })
  const sid = db.getTopic(1, 'default', topic.id).chiefSessionId
  assert.ok(sid)
  return { topic, sid }
}

test('v0.9.42: the same nonce sent again 50 ms later, while the busy probe is open, is queued once', async () => {
  const ctx = setup()
  try {
    const { orch, run, calls, flags, humans, queue } = ctx
    const { topic } = await runningTopic(ctx)
    flags.connectDelayMs = 300 // the probe answers "still working" after 300 ms
    const a = orch.sendTopicMessage(run, { topicId: topic.id, text: '追问', clientNonce: 'cn-retry' })
    await sleep(50)
    const b = orch.sendTopicMessage(run, { topicId: topic.id, text: '追问', clientNonce: 'cn-retry' })
    await Promise.all([a, b])
    assert.equal(queue(topic.id).length, 1, 'one queued follow-up')
    assert.equal(queue(topic.id)[0].clientNonce, 'cn-retry')
    assert.equal(humans(topic.id).length, 1, 'still only the first turn as a bubble')
    assert.equal(calls.run, 1)
  } finally { ctx.cleanup() }
})

test('v0.9.42: same retry when the probe answers "not working": one bubble, one run, nothing queued', async () => {
  const ctx = setup()
  try {
    const { orch, run, calls, flags, humans, queue, sessions } = ctx
    const { topic, sid } = await runningTopic(ctx)
    sessions.get(sid).is_running = false // turn 1 ended on the host; the plugin still has it as running
    flags.connectDelayMs = 300
    const a = orch.sendTopicMessage(run, { topicId: topic.id, text: '追问', clientNonce: 'cn-retry-f' })
    await sleep(50)
    const b = orch.sendTopicMessage(run, { topicId: topic.id, text: '追问', clientNonce: 'cn-retry-f' })
    await Promise.all([a, b])
    await until(() => calls.runDone === 2)
    assert.equal(queue(topic.id).length, 0, 'the retry was not queued behind its own first delivery')
    assert.deepEqual(humans(topic.id).map(m => m.clientNonce), ['cn-turn1', 'cn-retry-f'])
    assert.equal(calls.run, 2, 'turn 1 plus exactly one run for the follow-up')
  } finally { ctx.cleanup() }
})

test('v0.9.42: topic_queue holds a nonce once per topic; an older database with doubles is cleaned first', () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-nonblock-mig-'))
  try {
    const dataDir = join(root, 'data')
    const first = createDatabase(dataDir, {})
    const topic = first.createTopic(1, 'default', {})
    const other = first.createTopic(1, 'default', {})
    first.close()
    // The 0.9.41-branch shape: nonce column, no unique index, the same send queued twice.
    const raw = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'))
    raw.exec('DROP INDEX IF EXISTS idx_topic_queue_nonce')
    const ins = raw.prepare("INSERT INTO topic_queue (id, topic_id, user_id, profile, kind, text, attachments_json, mentioned_agent_ids_json, client_nonce, created_at) VALUES (?, ?, 1, 'default', 'user', ?, '[]', '[]', ?, ?)")
    ins.run('tq-late', topic.id, '重复的（后到）', 'cn-dup', 2000)
    ins.run('tq-early', topic.id, '重复的（先到）', 'cn-dup', 1000)
    ins.run('tq-plain-1', topic.id, '没有 nonce', '', 1500)
    ins.run('tq-plain-2', topic.id, '没有 nonce', '', 1600)
    ins.run('tq-other', other.id, '别的话题同 nonce', 'cn-dup', 1700)
    raw.close()

    const db = createDatabase(dataDir, {})
    assert.deepEqual(db.listTopicQueue(1, 'default', topic.id).map(q => q.id), ['tq-early', 'tq-plain-1', 'tq-plain-2'], 'the earliest copy is kept; rows without a nonce are untouched')
    assert.equal(db.listTopicQueue(1, 'default', other.id).length, 1, 'the same nonce in another topic is a different send')
    // A second insert for the pair stores nothing and says so.
    assert.equal(db.enqueueTopicItem(1, 'default', topic.id, { kind: 'user', text: '又来', clientNonce: 'cn-dup' }), null)
    assert.equal(db.listTopicQueue(1, 'default', topic.id).length, 3)
    const fresh = db.enqueueTopicItem(1, 'default', topic.id, { kind: 'user', text: '新的', clientNonce: 'cn-new' })
    assert.equal(fresh.clientNonce, 'cn-new')
    assert.ok(db.enqueueTopicItem(1, 'default', topic.id, { kind: 'wake', text: 'w' }))
    assert.ok(db.enqueueTopicItem(1, 'default', topic.id, { kind: 'wake', text: 'w' }), 'items without a nonce never collide')
    db.close()
    // Starting again on the cleaned database is a no-op.
    const again = createDatabase(dataDir, {})
    assert.equal(again.listTopicQueue(1, 'default', topic.id).length, 6)
    again.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---- C. a failed delivery is a bubble or a queued item, never both -------------------------------------

test('v0.9.42: a queued follow-up whose launch fails goes back to the queue without leaving a bubble', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, flags, humans, queue, sessions } = ctx
    const { topic, sid } = await runningTopic(ctx)
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '排队的追问', clientNonce: 'cn-q' })
    assert.equal(queue(topic.id).length, 1)
    // Turn 1 ends; the drain tries to deliver the follow-up and the host refuses.
    flags.runFails = true
    sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    assert.ok(await until(() => db.getTopic(1, 'default', topic.id).messages.some(m => m.kind === 'system' && /没能发给大总管/.test(m.text))), 'the failed delivery was reported')
    assert.deepEqual(queue(topic.id).map(q => q.clientNonce), ['cn-q'], 'back in the queue')
    assert.deepEqual(humans(topic.id).map(m => m.clientNonce), ['cn-turn1'], 'and not also a bubble')
  } finally { ctx.cleanup() }
})

test('v0.9.42: "run now" on a queued follow-up that fails: back in the queue, no bubble; a later success shows it once', async () => {
  const ctx = setup()
  try {
    const { orch, run, flags, humans, queue, calls } = ctx
    const { topic } = await runningTopic(ctx)
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '立即执行这条', clientNonce: 'cn-p' })
    const item = queue(topic.id)[0]
    flags.runFails = true
    await assert.rejects(() => orch.promoteTopicQueueItem(run, { topicId: topic.id, itemId: item.id }))
    assert.deepEqual(queue(topic.id).map(q => q.clientNonce), ['cn-p'])
    assert.deepEqual(humans(topic.id).map(m => m.clientNonce), ['cn-turn1'])
    flags.runFails = false
    const runsBefore = calls.runDone
    await orch.promoteTopicQueueItem(run, { topicId: topic.id, itemId: queue(topic.id)[0].id })
    await until(() => calls.runDone === runsBefore + 1)
    assert.equal(queue(topic.id).length, 0)
    assert.deepEqual(humans(topic.id).map(m => m.clientNonce), ['cn-turn1', 'cn-p'])
  } finally { ctx.cleanup() }
})

// ---- A. message-todo ------------------------------------------------------------------------------------

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
  g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
  return repoPath
}

async function buildingTodo(ctx) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: true })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T' })
  const built = await orch.startBuild(run, { todoId: todo.id })
  assert.equal(built.phase, 'building')
  // The first turn is over: the session is idle, so an instruction is sent instead of queued.
  ctx.sessions.get(built.buildSessionId).is_running = false
  return { todo: built }
}
const timeline = (ctx, todoId) => (ctx.db.getTodo(1, 'default', todoId).timeline || []).map(e => String(e.event || ''))

test('v0.9.42: message-todo answers inside its budget while the host holds the run, and the retry is not a second run', async () => {
  const ctx = setup({ orchOpts: { messageTodoBudgetMs: 300 } })
  try {
    const { db, orch, run, calls, hold } = ctx
    const { todo } = await buildingTodo(ctx)
    const tools = new Map()
    registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
    const runsBefore = calls.run
    const gate = hold() // the worker session is busy: the host blocks the new run
    const startedAt = Date.now()
    const res = await answersWithin(tools.get('message_todo').execute({ todo_id: todo.id, message: '补充：别动数据库' }, run), 2500)
    assert.equal(res.state, 'returned', 'the tool call answered while the host was still holding the run')
    assert.ok(Date.now() - startedAt < 1500)
    assert.equal(res.value.ok, true)
    assert.match(res.value.content, /starting|background/i, 'the answer says the run is still being started')
    assert.equal(res.value.data.accepted, true)
    assert.equal(res.value.data.starting, true)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'building')
    assert.equal(calls.run, runsBefore + 1)

    // The caller sends the same instruction again: accepted, nothing new is sent to the host.
    const again = await answersWithin(orch.messageTodo(run, { todoId: todo.id, note: '补充：别动数据库' }), 2500)
    assert.equal(again.state, 'returned')
    assert.equal(calls.run, runsBefore + 1)
    // A different instruction cannot be delivered right now and says so instead of vanishing.
    await assert.rejects(() => orch.messageTodo(run, { todoId: todo.id, note: '另一条指令' }), /还在启动|稍后/)

    gate.release()
    assert.ok(await until(() => calls.runDone === runsBefore + 1))
    await sleep(50)
    assert.equal(calls.run, runsBefore + 1, 'one run for that instruction')
    // Once it is through and the worker's turn is over, the next instruction goes out normally.
    ctx.sessions.get(db.getTodo(1, 'default', todo.id).buildSessionId).is_running = false
    const next = await orch.messageTodo(run, { todoId: todo.id, note: '另一条指令' })
    assert.equal(next.phase, 'building')
    assert.equal(calls.run, runsBefore + 2)
  } finally { ctx.cleanup() }
})

test('v0.9.42: message-todo whose launch fails after the call returned leaves the reason on the card', async () => {
  const ctx = setup({ orchOpts: { messageTodoBudgetMs: 200 } })
  try {
    const { db, orch, run, flags, warns } = ctx
    const { todo } = await buildingTodo(ctx)
    const before = rejections.length
    flags.runDelayMs = 700
    flags.runFails = true
    const res = await answersWithin(orch.messageTodo(run, { todoId: todo.id, note: '这条会在后台失败' }), 2000)
    assert.equal(res.state, 'returned')
    assert.ok(await until(() => db.getTodo(1, 'default', todo.id).phase === 'failed', 4000), 'the card shows the failure')
    assert.match(db.getTodo(1, 'default', todo.id).lastError, /engine exploded/)
    assert.ok(timeline(ctx, todo.id).some(t => /启动失败|不可用/.test(t)))
    assert.ok(warns.some(w => w.data?.todoId === todo.id), 'written to the log')
    await sleep(30)
    assert.equal(rejections.length, before, 'no unhandled rejection')
  } finally { ctx.cleanup() }
})

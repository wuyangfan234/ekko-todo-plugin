// v0.9.42 (Todo #23, second rework): every instruction to a worker (message-todo, request-changes,
// answer-question, confirm-plan) answers inside its budget, is never a silent no-op, waits in todo_queue while
// the worker session is busy, treats a host "already running" refusal as a failed delivery, and is dispatched
// once per 60 s for the same text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'

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
  const root = mkdtempSync(join(tmpdir(), 'ekko-instr-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const warns = []
  const log = { warn(msg, data) { warns.push({ msg, data }) }, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], ...orchOpts })
  let seq = 0
  const sessions = new Map()
  const calls = { run: 0, runDone: 0, connect: 0, inputs: [] }
  // hold: the host keeps `sessions.run` open until release() (stands for the 120 s block).
  const flags = { runDelayMs: 0, runFails: false, hold: null, connectDelayMs: 0, alreadyRunning: false }
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
        calls.inputs.push(String(input))
        if (flags.hold) await flags.hold.promise
        if (flags.runDelayMs) await sleep(flags.runDelayMs)
        if (flags.alreadyRunning) throw new Error('Session ' + id + ' is already running')
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


const idle = (ctx, todoId) => { ctx.sessions.get(ctx.db.getTodo(1, 'default', todoId).buildSessionId).is_running = false }

// ---- 1. every instruction entry point answers inside its budget ----------------------------------------

for (const [name, call] of [
  ['request-changes', (orch, run, id) => orch.requestChanges(run, { todoId: id, note: '改一下命名' })],
  ['answer-question', (orch, run, id) => orch.answerQuestion(run, { todoId: id, optionId: 'a', note: '选 B' })],
  ['confirm-plan', (orch, run, id) => orch.confirmPlan(run, { todoId: id, note: '按方案做' })],
]) {
  test(`v0.9.42: ${name} answers within 2 s while the host takes 2 s to accept the run`, async () => {
    const ctx = setup()
    try {
      const { db, orch, run, calls, flags, emitted } = ctx
      const { todo } = await buildingTodo(ctx)
      if (name === 'answer-question') {
        await orch.askUserQuestion(run, { todoId: todo.id, title: '选哪个?', why: 'x', options: [{ id: 'a', label: 'A', recommended: true }] })
      }
      const runsBefore = calls.run
      flags.runDelayMs = 2000
      const startedAt = Date.now()
      const res = await answersWithin(call(orch, run, todo.id), 2000)
      assert.equal(res.state, 'returned', `${name} answered before the host accepted the run`)
      assert.ok(Date.now() - startedAt < 2000)
      assert.equal(res.value.launchPending, true)
      assert.ok(emitted.some(e => e.reason === `todo.launch.pending:${todo.id}`), 'todo.launch.pending emitted')
      assert.ok(await until(() => calls.runDone === runsBefore + 1, 4000), 'the run went out in the background')
      assert.equal(calls.run, runsBefore + 1)
      await until(() => emitted.some(e => e.reason === `todo.launch.settled:${todo.id}`), 1000)
      assert.equal(db.getTodo(1, 'default', todo.id).phase, 'building')
    } finally { ctx.cleanup() }
  })
}

// ---- 2. a start under way: answer-question is refused with a reason, not a silent success --------------

test('v0.9.42: answer-question while the card is still starting is refused and leaves the question open', async () => {
  const ctx = setup({ orchOpts: { messageTodoBudgetMs: 200 } })
  try {
    const { db, orch, run, calls, hold, emitted } = ctx
    const { todo } = await buildingTodo(ctx)
    await orch.askUserQuestion(run, { todoId: todo.id, title: '选哪个?', why: 'x', options: [{ id: 'a', label: 'A' }] })
    const gate = hold()
    const pending = await orch.messageTodo(run, { todoId: todo.id, note: '先补一句' })
    assert.equal(pending.launchPending, true)
    const runs = calls.run
    await assert.rejects(() => orch.answerQuestion(run, { todoId: todo.id, optionId: 'a', note: '选 B' }), /没有发出/)
    const cur = db.getTodo(1, 'default', todo.id)
    assert.notEqual(cur.question.answeredText, '选 B', 'the answer was not recorded as given')
    assert.ok(!cur.spec.includes('选 B'), 'nor written into the spec')
    assert.ok(!timeline(ctx, todo.id).some(t => t === '用户决策：选 B'), 'no "用户决策" line claiming it was taken')
    assert.ok(timeline(ctx, todo.id).some(t => /用户决策没有发出/.test(t)), 'the timeline says it was not sent')
    assert.ok(emitted.some(e => e.reason === `todo.message.failed:${todo.id}`))
    assert.equal(calls.run, runs)
    gate.release()
    assert.ok(await until(() => calls.runDone >= 2))
    // startBuild itself no longer answers a second start with the unchanged card.
    const gate2 = hold()
    const first = orch.startBuild(run, { todoId: todo.id, withPlan: false, extraMessage: 'x' })
    await assert.rejects(() => orch.startBuild(run, { todoId: todo.id }), /还在启动中/)
    gate2.release()
    await first.catch(() => {})
  } finally { ctx.cleanup() }
})

// ---- 3. a busy worker session: the instruction waits in todo_queue --------------------------------------

test('v0.9.42: an instruction to a busy worker is queued, no run is sent, and it is delivered when the turn ends', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, sessions, emitted } = ctx
    const { todo } = await buildingTodo(ctx)
    const sid = db.getTodo(1, 'default', todo.id).buildSessionId
    sessions.get(sid).is_running = true // the worker is in the middle of a turn
    const runs = calls.run
    const res = await answersWithin(orch.messageTodo(run, { todoId: todo.id, note: '顺便改 README' }), 1500)
    assert.equal(res.state, 'returned')
    assert.equal(res.value.queued, true)
    assert.equal(calls.run, runs, 'nothing sent into the busy session')
    const q = db.listTodoQueue(1, 'default', todo.id)
    assert.equal(q.length, 1)
    assert.equal(q[0].kind, 'message')
    assert.equal(q[0].text, '顺便改 README')
    assert.ok(timeline(ctx, todo.id).some(t => /已排队，本轮结束后自动送达/.test(t)))
    assert.ok(emitted.some(e => e.reason === `todo.message.queued:${todo.id}`))
    // request-changes is queued behind it, in order.
    const rc = await orch.requestChanges(run, { todoId: todo.id, note: '再加测试' })
    assert.equal(rc.queued, true)
    assert.deepEqual(db.listTodoQueue(1, 'default', todo.id).map(i => i.kind), ['message', 'changes'])
    assert.equal(calls.run, runs)

    // The turn ends: the first queued instruction goes out, the second stays queued.
    sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    assert.equal(calls.run, runs + 1)
    assert.equal(calls.inputs.at(-1), '顺便改 README')
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'building', 'not settled as finished')
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 1)
    sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    assert.equal(calls.run, runs + 2)
    assert.match(calls.inputs.at(-1), /再加测试/)
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 0)
  } finally { ctx.cleanup() }
})

// ---- 3b. the host refuses with "already running": a failed delivery, written on the card ---------------

test('v0.9.42: a run refused as "already running" is a failed delivery with a readable lastError and timeline', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, flags, emitted } = ctx
    const { todo } = await buildingTodo(ctx)
    flags.alreadyRunning = true // the probe saw an idle session, the host refuses anyway
    await assert.rejects(() => orch.messageTodo(run, { todoId: todo.id, note: '这条会被拒' }), /没有送达/)
    const cur = db.getTodo(1, 'default', todo.id)
    assert.match(cur.lastError, /already running/)
    assert.match(cur.lastError, /没有送达/)
    assert.ok(timeline(ctx, todo.id).some(t => /指令没有送达/.test(t)), 'the timeline shows it')
    assert.ok(emitted.some(e => e.reason === `todo.message.failed:${todo.id}`))
    // The failed instruction can be sent again (its idempotency key was dropped).
    flags.alreadyRunning = false
    const again = await orch.messageTodo(run, { todoId: todo.id, note: '这条会被拒' })
    assert.equal(again.duplicate, undefined)
    assert.equal(again.phase, 'building')
  } finally { ctx.cleanup() }
})

// ---- 4. the same instruction inside 60 s is dispatched once ---------------------------------------------

test('v0.9.42: the same instruction sent again after its run started (inside 60 s) is not dispatched twice', async () => {
  const ctx = setup({ orchOpts: { instructionDedupeMs: 300 } })
  try {
    const { db, orch, run, calls } = ctx
    const { todo } = await buildingTodo(ctx)
    const runs = calls.run
    const first = await orch.messageTodo(run, { todoId: todo.id, note: '只要一次' })
    assert.equal(first.phase, 'building')
    assert.equal(calls.run, runs + 1)
    idle(ctx, todo.id)
    const lines = timeline(ctx, todo.id).length
    const again = await orch.messageTodo(run, { todoId: todo.id, note: '只要一次' })
    assert.equal(again.duplicate, true)
    assert.equal(calls.run, runs + 1, 'no second dispatch')
    assert.equal(timeline(ctx, todo.id).length, lines, 'no second timeline entry')
    const rc = await orch.requestChanges(run, { todoId: todo.id, note: '只要一次' })
    assert.equal(rc.duplicate, undefined, 'another kind of instruction is not a duplicate')
    assert.equal(calls.run, runs + 2)
    idle(ctx, todo.id)
    await sleep(350) // the window has passed: the same text is a new instruction
    const later = await orch.messageTodo(run, { todoId: todo.id, note: '只要一次' })
    assert.equal(later.duplicate, undefined)
    assert.equal(calls.run, runs + 3)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'building')
  } finally { ctx.cleanup() }
})

test('v0.9.42: a worker launch slower than the warn threshold is logged with the todo and the time', async () => {
  const ctx = setup({ orchOpts: { slowLaunchWarnMs: 200 } })
  try {
    const { orch, run, flags, warns } = ctx
    const { todo } = await buildingTodo(ctx)
    // The setup launch is a real dispatch and can itself cross the 200 ms threshold when the whole suite
    // runs in parallel; `warns.find` would then pick that one up and read its smaller duration. Measure
    // only the launch this test slows down on purpose.
    warns.length = 0
    flags.runDelayMs = 300
    await orch.messageTodo(run, { todoId: todo.id, note: '慢一点' })
    const slow = warns.find(w => /slow/i.test(w.msg) && w.data?.todoId === todo.id)
    assert.ok(slow, 'slow launch logged')
    assert.ok(slow.data.ms >= 300)
  } finally { ctx.cleanup() }
})

// ---- 5. todo_queue is drained whatever the card's phase when the busy turn ends -------------------------

test('v0.9.42: an answer queued at the confirm gate is delivered when the busy turn ends, and the queue is empty', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, sessions } = ctx
    const { todo } = await buildingTodo(ctx)
    const sid = db.getTodo(1, 'default', todo.id).buildSessionId
    await orch.askUserQuestion(run, { todoId: todo.id, title: '选哪个?', why: 'x', options: [{ id: 'a', label: '选 A' }] })
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'confirm')
    sessions.get(sid).is_running = true // the worker is still finishing the turn in which it asked
    const runs = calls.run
    const res = await orch.answerQuestion(run, { todoId: todo.id, optionId: 'a', note: '' })
    assert.equal(res.queued, true)
    assert.equal(calls.run, runs)
    sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    assert.equal(calls.run, runs + 1, 'the answer went out')
    assert.match(calls.inputs.at(-1), /选 A/)
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 0)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'building')
  } finally { ctx.cleanup() }
})

test('v0.9.42: changes requested at the review gate while the session is busy are delivered when the turn ends', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, sessions } = ctx
    const { todo } = await buildingTodo(ctx)
    const sid = db.getTodo(1, 'default', todo.id).buildSessionId
    db.updateTodo(1, 'default', todo.id, { phase: 'review', gateOwner: 'human', gateKind: 'merge' })
    sessions.get(sid).is_running = true
    const runs = calls.run
    const res = await orch.requestChanges(run, { todoId: todo.id, note: '把日志去掉' })
    assert.equal(res.queued, true)
    sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    assert.equal(calls.run, runs + 1, 'the changes went out')
    assert.match(calls.inputs.at(-1), /把日志去掉/)
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 0)
  } finally { ctx.cleanup() }
})

test('v0.9.42: instructions queued behind a turn that fails are removed with the reason on the card', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, sessions } = ctx
    const { todo } = await buildingTodo(ctx)
    const sid = db.getTodo(1, 'default', todo.id).buildSessionId
    sessions.get(sid).is_running = true
    const res = await orch.messageTodo(run, { todoId: todo.id, note: '顺手补测试' })
    assert.equal(res.queued, true)
    const runs = calls.run
    sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.failed', data: { session_id: sid, error: 'boom' } }, run)
    const cur = db.getTodo(1, 'default', todo.id)
    assert.equal(cur.phase, 'failed')
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 0, 'nothing left to be replayed later')
    assert.equal(calls.run, runs, 'not sent into a failed card')
    assert.match(cur.lastError, /排队的 1 条指令没有送达/)
    assert.ok(timeline(ctx, todo.id).some(t => /排队的 1 条指令没有送达.*顺手补测试/.test(t)), 'the timeline names it')
    // A later instruction is not followed by the stale one.
    const next = await orch.messageTodo(run, { todoId: todo.id, note: '继续' })
    assert.equal(next.phase, 'building')
    sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: db.getTodo(1, 'default', todo.id).buildSessionId } }, run)
    assert.ok(!calls.inputs.some(i => i.includes('顺手补测试')), 'the dropped instruction is never replayed')
  } finally { ctx.cleanup() }
})

test('v0.9.42: a queued answer whose turn-end event was lost is delivered by reconcile once the session is idle', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, sessions } = ctx
    const { todo } = await buildingTodo(ctx)
    const sid = db.getTodo(1, 'default', todo.id).buildSessionId
    await orch.askUserQuestion(run, { todoId: todo.id, title: '选哪个?', why: 'x', options: [{ id: 'a', label: '选 A' }] })
    sessions.get(sid).is_running = true
    assert.equal((await orch.answerQuestion(run, { todoId: todo.id, optionId: 'a', note: '' })).queued, true)
    const runs = calls.run
    await orch.reconcileActiveRuns(run)
    assert.equal(calls.run, runs, 'still busy: nothing sent')
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 1)
    sessions.get(sid).is_running = false // the turn ended, no host event arrived
    await orch.reconcileActiveRuns(run)
    assert.equal(calls.run, runs + 1)
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 0)
  } finally { ctx.cleanup() }
})

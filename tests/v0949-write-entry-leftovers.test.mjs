// v0.9.49 (#46): what the review of #44 left next to the write entries.
//  1. A review dispatch writes `reviewing` and the review session BEFORE it launches the run, so a review that
//     ends while the launch call is still out is settled instead of being lost.
//  2. mergeBuild checks the merge conditions twice: before it takes the lock and again, on the card as stored,
//     once it holds it.
//  3. cancelBuild refuses a card that is done or closed (it used to write it back to `todo`).
//  4. closeTodo refuses a done card in words, not with the state machine's English error.
//  5. `cancelled` is not a phase: it is gone from TODO_QUEUE_DROP_PHASES and from CONTRACTS.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { TODO_PHASES } from '../src/server/state-machine.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-writeleft-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  // The lock clock reads Date.now at call time, so a test can move the time forward (movedClock).
  // hooks.onClock: called once, the next time the orchestrator reads its clock (taking a write lock does).
  // hooks.now: when set, the injected clock answers it instead of Date.now (only the orchestrator's clock moves).
  const hooks = { onClock: null, now: 0 }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], clock: () => { const h = hooks.onClock; if (h) { hooks.onClock = null; h() } return hooks.now || Date.now() } })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, stop: 0 }
  // createGate / runGate / messagesGate: while set, that host call waits for the promise (a call that hangs
  // inside the host).
  // agentsGate: the engine probe (host.agents.list). stopGate: the next sessions.stop only (one shot).
  // endDuringRun: { text, type? }: the next sessions.run ends its turn and the host reports it BEFORE the
  // launch call returns (a review that finishes at once). runError: the next sessions.run throws it.
  // probeUnknown: session ids the host no longer knows (live probe refused, detail missing): a probe ends unknown.
  const flags = { createGate: null, runGate: null, messagesGate: null, agentsGate: null, stopGate: null, endDuringRun: null, runError: null, probeUnknown: new Set() }
  const host = {
    agents: { async list() { if (flags.agentsGate) await flags.agentsGate; return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) {
        if (flags.createGate) await flags.createGate
        calls.create += 1
        const id = `sess-${++seq}`
        sessions.set(id, { id, ...input, messages: [], is_running: false })
        return { session: { id } }
      },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        if (flags.runGate) await flags.runGate
        if (flags.runError) { const e = flags.runError; flags.runError = null; throw e }
        calls.run += 1
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        if (flags.endDuringRun && s) {
          const end = flags.endDuringRun
          flags.endDuringRun = null
          s.is_running = false
          if (end.text) s.messages.push({ id: `a-${++seq}`, role: 'assistant', content: end.text, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
          const type = end.type || 'chat.run.completed'
          const reported = orch.handleHostEvent({ type, data: { session_id: id, ...(type === 'chat.run.failed' ? { error: end.error || 'reviewer crashed' } : { finish_reason: 'stop' }) } }, run)
          reported.catch(() => {})
          // The event is handled while the launch call has not returned yet.
          await new Promise(resolve => setTimeout(resolve, 80))
        }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { if (flags.stopGate) { const g = flags.stopGate; flags.stopGate = null; await g } calls.stop += 1; const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { if (flags.probeUnknown.has(id)) return null; const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) {
        if (flags.messagesGate) await flags.messagesGate
        return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false }
      },
      async connect(id, cb) {
        if (flags.probeUnknown.has(id)) throw new Error('unknown session')
        const timer = setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(sessions.get(id)?.is_running), runStartedAt: 0, queueLength: 0 }), 0)
        return { close() { clearTimeout(timer) } }
      },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {}, notify() {} } }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, calls, flags, hooks, sessions, cleanup }
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim()

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
  return repoPath
}

const CONFIGS = [{ id: 'cfg-1', label: '主力', engine: 'codex', mode: 'global', provider: 'p1', model: 'model-one', reasoningEffort: 'high' }]
const SUMMARY = 'VERDICT: APPROVED\n逻辑正确，测试充分。'
const DISCARDED = '本轮结果已丢弃：这张卡在等待期间被另一个写操作接管'

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const patch = (ctx, id, p) => ctx.db.updateTodo(1, 'default', id, p)
const tick = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
const hasBranch = (repoPath, branch) => git(repoPath, 'branch', '--list', branch).includes(branch)

function gate() {
  let open
  const promise = new Promise(resolve => { open = resolve })
  return { promise, open }
}

// Move Date.now forward: what the orchestrator sees as time passing (engine cache 45 s, lock TTL 10 min).
function movedClock() {
  const real = Date.now
  let offset = 0
  Date.now = () => real() + offset
  return { advance(ms) { offset += ms }, restore() { Date.now = real } }
}
const PAST_LOCK_TTL_MS = 11 * 60 * 1000

async function rejection(promise) {
  try { await promise } catch (err) { return err }
  return null
}

async function buildingTodo(ctx, { autopilot = false, testCommand = 'true' } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '写入口测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '写入口测试 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id, withPlan: false })
  assert.equal(built.phase, 'building')
  return { todo: built, project, topic, agent }
}

// The worker's turn ends normally.
async function endTurn(ctx, todoId, text = 'done') {
  const sessionId = get(ctx, todoId).buildSessionId
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: text, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)
  return get(ctx, todoId)
}

function commitWork(todo, text = 'feature side\n') {
  writeFileSync(join(todo.worktreePath, 'a.txt'), text)
  git(todo.worktreePath, 'commit', '-am', 'work')
}

// A card at the merge gate with a committed change and an APPROVED independent review.
async function reviewCard(ctx, opts = {}) {
  const made = await buildingTodo(ctx, opts)
  commitWork(made.todo)
  const atGate = await endTurn(ctx, made.todo.id)
  assert.equal(atGate.phase, 'review')
  patch(ctx, made.todo.id, { evidence: { reviewVerdict: 'approved', reviewSummary: SUMMARY } })
  return { ...made, todo: get(ctx, made.todo.id) }
}

// A card whose independent review is running.
async function reviewingCard(ctx, opts = {}) {
  const made = await reviewCard(ctx, opts)
  const reviewing = await ctx.orch.runIndependentReview(ctx.run, { todoId: made.todo.id })
  assert.equal(reviewing.phase, 'reviewing')
  return { ...made, todo: get(ctx, made.todo.id) }
}
const realNow = Date.now
// Like waitFor, but answers false instead of throwing, so the assertion that follows names what is wrong.
async function reaches(check, ms = 2500) {
  const until = realNow() + ms
  while (!check()) {
    if (realNow() > until) return false
    await tick(25)
  }
  return true
}
const verdictLines = (ctx, id) => timeline(ctx, id).filter(e => e.startsWith('独立审查结论'))
const REVIEW_DISPATCHED = '派发独立只读审查至'
const REVIEW_NOT_LAUNCHED = '审查派发未成功'

// A card at the merge gate that the Chief may merge: topic AUTO, project auto-merge, test gate passed, APPROVED.
async function chiefMergeCard(ctx) {
  const made = await reviewCard(ctx, { autopilot: true })
  await ctx.orch.updateProject(ctx.run, { id: made.project.id, autopilot: { autoMergeAfterReview: true } })
  assert.equal(Number(made.todo.evidence.testRc), 0, 'the test gate passed')
  return made
}

const mainFile = project => readFileSync(join(project.repoPath, 'a.txt'), 'utf8')

// ---- 1. review dispatch: the card is `reviewing` before the run is launched --------------------------------

test('v0.9.49 #46: a first review that ends while its launch call is still out is settled, not lost', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    assert.equal(todo.reviewSessionId, '', 'no review session yet: the event cannot be matched by an old id')
    ctx.flags.endDuringRun = { text: SUMMARY }
    await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    await reaches(() => verdictLines(ctx, todo.id).length > 0)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review', 'the card left reviewing: the verdict was settled')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.gateKind, 'merge')
    assert.equal(cur.reviewRunId, '')
    assert.ok(cur.reviewSessionId, 'the review session is on the card')
    assert.deepEqual(verdictLines(ctx, todo.id), ['独立审查结论：通过'], 'settled exactly once')
    const lines = timeline(ctx, todo.id)
    assert.ok(lines.findIndex(e => e.includes(REVIEW_DISPATCHED)) >= 0, 'the dispatch is on the timeline')
    assert.ok(lines.findIndex(e => e.includes(REVIEW_DISPATCHED)) < lines.indexOf('独立审查结论：通过'), 'dispatch line before the verdict line')
    assert.ok(!lines.some(e => e.includes(DISCARDED)), 'nothing was dropped on the way')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: a repeated review (same session) that ends during its launch is settled with its own verdict', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const s = ctx.sessions.get(todo.reviewSessionId)
    s.is_running = false
    s.messages.push({ id: 'r-1', role: 'assistant', content: SUMMARY, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: todo.reviewSessionId, finish_reason: 'stop' } }, ctx.run)
    assert.equal(get(ctx, todo.id).evidence.reviewVerdict, 'approved')

    ctx.flags.endDuringRun = { text: 'VERDICT: CHANGES_REQUESTED\n缺少边界用例。' }
    await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    await reaches(() => verdictLines(ctx, todo.id).length > 1)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'changes_requested', 'the second verdict, not the first one and not pending')
    assert.equal(cur.gateKind, 'changes')
    assert.equal(cur.reviewSessionId, todo.reviewSessionId, 'the same review session was reused')
    assert.deepEqual(verdictLines(ctx, todo.id), ['独立审查结论：通过', '独立审查结论：需修改'])
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(DISCARDED)))
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: a review run reported as failed during its launch is settled as failed review', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    ctx.flags.endDuringRun = { text: '', type: 'chat.run.failed', error: 'reviewer crashed: rc=9' }
    await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    // Since #47 a failed review run is `review_failed` with its own timeline line (no 「独立审查结论」 line).
    await reaches(() => timeline(ctx, todo.id).some(e => e.startsWith('审查运行失败')))
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'review_failed')
    assert.equal(cur.gateKind, 'review_failed')
    assert.match(cur.lastError, /reviewer crashed: rc=9/)
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: while the review launch is out, the card already is reviewing with its session and a pending verdict', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const g = gate()
    ctx.flags.runGate = g.promise
    const slow = ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    slow.catch(() => {})
    await reaches(() => get(ctx, todo.id).phase === 'reviewing')
    const during = get(ctx, todo.id)
    assert.equal(during.phase, 'reviewing', 'written before the launch returned')
    assert.ok(during.reviewSessionId, 'the session a settle is matched by is on the card')
    assert.equal(during.evidence.reviewVerdict, 'pending')
    assert.equal(during.gateKind, 'review')
    assert.equal(during.reviewRunId, '', 'the run id is only known once the launch returned')
    assert.ok(ctx.orch.todoWriteLocks.get(todo.id), 'the dispatch still holds the lock')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(REVIEW_DISPATCHED)), 'the dispatch line waits for the launch')

    ctx.flags.runGate = null
    g.open()
    const reviewed = await slow
    assert.equal(reviewed.phase, 'reviewing')
    assert.ok(reviewed.reviewRunId, 'the run id was added after the launch')
    assert.equal(reviewed.reviewSessionId, during.reviewSessionId)
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(REVIEW_DISPATCHED)).length, 1)
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)

    // The usual order (the run ends after the dispatch returned) settles as before.
    const s = ctx.sessions.get(reviewed.reviewSessionId)
    s.is_running = false
    s.messages.push({ id: 'r-1', role: 'assistant', content: SUMMARY, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: reviewed.reviewSessionId, finish_reason: 'stop' } }, ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'review')
    assert.deepEqual(verdictLines(ctx, todo.id), ['独立审查结论：通过'])
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: a review launch that fails puts the card back exactly where it was', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    // #47's ask-once count of the round before (the dispatch writes 0 before it launches).
    patch(ctx, todo.id, { evidence: { reviewInconclusiveRetries: 1 } })
    const before = get(ctx, todo.id)
    ctx.flags.runError = new Error('upstream 503: no capacity')
    const err = await rejection(ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id }))
    assert.ok(err, 'the dispatch fails')
    assert.match(err.message, /upstream 503/)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review', 'not left in reviewing with no run')
    assert.equal(cur.gateOwner, before.gateOwner)
    assert.equal(cur.gateKind, before.gateKind)
    assert.equal(cur.evidence.reviewVerdict, 'approved', 'the verdict of the round before is back')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1, 'the ask-once count of the round before is back')
    assert.equal(cur.reviewSessionId, before.reviewSessionId)
    assert.equal(cur.reviewRunId, before.reviewRunId)
    assert.equal(cur.reviewerId, before.reviewerId)
    const lines = timeline(ctx, todo.id)
    assert.equal(lines.filter(e => e.startsWith(REVIEW_NOT_LAUNCHED)).length, 1, 'the failed launch is on the timeline')
    assert.match(lines.find(e => e.startsWith(REVIEW_NOT_LAUNCHED)), /upstream 503/)
    assert.ok(!lines.some(e => e.includes(REVIEW_DISPATCHED)))
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
    // The card can be reviewed again right away.
    assert.equal((await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })).phase, 'reviewing')
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: a hung review dispatch that is taken over leaves the card to the new holder (real TTL)', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const { todo } = await reviewCard(ctx)
    const g = gate()
    ctx.flags.runGate = g.promise
    const hung = ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    hung.catch(() => {})
    await reaches(() => get(ctx, todo.id).phase === 'reviewing')
    assert.equal(get(ctx, todo.id).phase, 'reviewing', 'the hung dispatch already wrote reviewing')
    assert.equal((await rejection(ctx.orch.closeTodo(ctx.run, { todoId: todo.id }))).code, 'TODO_BUSY', 'inside the TTL the lock refuses')

    clk.advance(PAST_LOCK_TTL_MS)
    const closed = await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')
    const revisionAtClose = get(ctx, todo.id).revision

    ctx.flags.runGate = null
    g.open()
    const returned = await hung
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'closed', 'the late dispatch wrote nothing over closed')
    assert.equal(cur.reviewRunId, '', 'no review run was recorded')
    assert.equal(cur.gateKind, 'none')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARDED)).length, 1)
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(REVIEW_DISPATCHED)))
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith(REVIEW_NOT_LAUNCHED)), 'not rolled back either: the card is not its own')
    assert.equal(returned.phase, 'closed')
    assert.ok(cur.revision > revisionAtClose, 'only the discard line was added')
  } finally { clk.restore(); ctx.cleanup() }
})

test('v0.9.49 #46: the backstop: a card left in reviewing whose review session is idle is settled by the reconcile', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const s = ctx.sessions.get(todo.reviewSessionId)
    s.is_running = false
    s.messages.push({ id: 'r-1', role: 'assistant', content: SUMMARY, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    // No host event at all (it was lost).
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
  } finally { ctx.cleanup() }
})

// ---- 1b. the reconcile and a review whose run was not launched (yet) ---------------------------------------

const HEALED = '检测到未启动的审查'

test('v0.9.49 #46: the reconcile does not settle a review whose launch call is still out', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const g = gate()
    ctx.flags.runGate = g.promise
    const slow = ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    slow.catch(() => {})
    await reaches(() => get(ctx, todo.id).phase === 'reviewing')
    const during = get(ctx, todo.id)
    assert.equal(during.phase, 'reviewing')
    assert.equal(during.reviewRunId, '', 'the launch has not returned')
    assert.ok(during.reviewSessionId, 'the session exists and is idle: nothing runs in it yet')

    // The session is idle only because the run has not started. That is not a finished review: the
    // reconcile does not even ask the host about it.
    const probed = []
    const connect = ctx.run.host.sessions.connect
    ctx.run.host.sessions.connect = (id, cb) => { probed.push(id); return connect(id, cb) }
    await ctx.orch.reconcileActiveRuns(ctx.run)
    ctx.run.host.sessions.connect = connect
    assert.ok(!probed.includes(during.reviewSessionId), 'the review session was not probed while its launch is out')
    let cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing', 'still reviewing after the reconcile')
    assert.equal(cur.evidence.reviewVerdict, 'pending')

    ctx.flags.runGate = null
    g.open()
    await slow
    // Nothing was kept back to be settled once the dispatch is through.
    await tick(200)
    cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing', 'the review that just started was not settled')
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.equal(cur.gateKind, 'review')
    assert.ok(cur.reviewRunId, 'the run is on the card')
    assert.deepEqual(verdictLines(ctx, todo.id), [], 'no verdict line for a review that has not answered')

    // The review answers: settled as usual.
    const s = ctx.sessions.get(cur.reviewSessionId)
    s.is_running = false
    s.messages.push({ id: 'r-1', role: 'assistant', content: SUMMARY, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: cur.reviewSessionId, finish_reason: 'stop' } }, ctx.run)
    assert.equal(get(ctx, todo.id).evidence.reviewVerdict, 'approved')
    assert.deepEqual(verdictLines(ctx, todo.id), ['独立审查结论：通过'])
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: a card left in reviewing with no review run (restart during the launch) goes back to the merge gate', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    // A second review round was being dispatched when the process ended: the card is `reviewing` / pending,
    // has its review session (with the answer of the round before in it) and no run. A new process knows
    // of no launch.
    const { todo } = await reviewingCard(ctx)
    const s = ctx.sessions.get(todo.reviewSessionId)
    s.is_running = false
    s.messages.push({ id: 'r-1', role: 'assistant', content: SUMMARY, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    patch(ctx, todo.id, { reviewRunId: '' })
    const left = get(ctx, todo.id)
    assert.equal(left.phase, 'reviewing')
    assert.equal(left.evidence.reviewVerdict, 'pending')

    // Young: left alone. The old answer in the session is not taken as the verdict of this round.
    await ctx.orch.reconcileActiveRuns(ctx.run)
    let cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing', 'not settled from a session in which no run of this round ran')
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.equal(cur.revision, left.revision, 'nothing was written')

    // Old and its session is working (a launch the host accepted without a run id): left alone.
    clk.advance(3 * 60 * 1000)
    s.is_running = true
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'reviewing', 'a working review session is not taken for an unlaunched one')

    // Old and idle: back to the merge gate, without a verdict. (The live chat of the working session was
    // copied to the card just now, which counts as a write: the quiet time starts again.)
    s.is_running = false
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'reviewing', 'written less than the quiet time ago: left alone')
    clk.advance(3 * 60 * 1000)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.gateKind, 'merge')
    assert.equal(cur.gateOwner, 'human')
    assert.equal(cur.evidence.reviewVerdict, 'none', 'no verdict: neither pending nor the one of the round before')
    assert.match(cur.lastError, /审查.*重新派发审查/)
    assert.equal(cur.reviewSessionId, left.reviewSessionId, 'the review session is kept for the next dispatch')
    assert.equal(timeline(ctx, todo.id).filter(e => e.startsWith(HEALED)).length, 1)
    assert.deepEqual(verdictLines(ctx, todo.id), [])
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)

    // Once is enough, and the next dispatch reuses the session.
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(timeline(ctx, todo.id).filter(e => e.startsWith(HEALED)).length, 1)
    const again = await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    assert.equal(again.phase, 'reviewing')
    assert.equal(again.reviewSessionId, left.reviewSessionId)
    assert.ok(again.reviewRunId)
  } finally { clk.restore(); ctx.cleanup() }
})

test('v0.9.49 #46: a card put back by the reconcile gets its merge gate owner from mergeGateNeedsHuman', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    // AUTO topic, project without auto-merge: the Chief may not merge, so the gate is the user's.
    const { todo, project } = await reviewingCard(ctx, { autopilot: true })
    assert.equal(project.autopilot.autoMergeAfterReview, false)
    ctx.sessions.get(todo.reviewSessionId).is_running = false
    patch(ctx, todo.id, { reviewRunId: '', evidence: { reviewSummary: SUMMARY } })
    assert.equal(get(ctx, todo.id).evidence.reviewSummary, SUMMARY, 'the old review text is on the card')
    clk.advance(3 * 60 * 1000)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.gateOwner, 'human', 'AUTO topic without auto-merge: the user holds the gate (the Chief is not woken)')
    assert.equal(cur.evidence.reviewVerdict, 'none')
    assert.equal(cur.evidence.reviewSummary, '', 'no verdict and no old review text side by side')
  } finally { clk.restore(); ctx.cleanup() }
})

test('v0.9.49 #46: a put-back card in an AUTO topic with auto-merge and a passed test gate is the Chief\'s', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const { todo, project } = await reviewingCard(ctx, { autopilot: true })
    await ctx.orch.updateProject(ctx.run, { id: project.id, autopilot: { autoMergeAfterReview: true } })
    assert.equal(Number(get(ctx, todo.id).evidence.testRc), 0)
    ctx.sessions.get(todo.reviewSessionId).is_running = false
    patch(ctx, todo.id, { reviewRunId: '' })
    clk.advance(3 * 60 * 1000)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.gateOwner, 'chief')
  } finally { clk.restore(); ctx.cleanup() }
})

// The put-back card's gate: every condition of mergeGateNeedsHuman counts, each on its own.
async function healedGateOwner(ctx, clk, cardPatch) {
  const { todo, project } = await reviewingCard(ctx, { autopilot: true })
  await ctx.orch.updateProject(ctx.run, { id: project.id, autopilot: { autoMergeAfterReview: true } })
  assert.equal(Number(get(ctx, todo.id).evidence.testRc), 0, 'the test gate passed')
  ctx.sessions.get(todo.reviewSessionId).is_running = false
  patch(ctx, todo.id, { reviewRunId: '', ...cardPatch })
  clk.advance(3 * 60 * 1000)
  await ctx.orch.reconcileActiveRuns(ctx.run)
  const cur = get(ctx, todo.id)
  assert.equal(cur.phase, 'review', 'the card went back to the merge gate')
  return cur
}

test('v0.9.49 #46: a put-back card whose test gate was skipped (no open question) is the user\'s', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const cur = await healedGateOwner(ctx, clk, { evidence: { gateSkipped: 'no-snapshot' } })
    assert.equal(cur.evidence.gateSkipped, 'no-snapshot')
    assert.ok(!cur.question?.active)
    assert.equal(cur.gateOwner, 'human', 'a skipped gate leaves the gate with the user')
  } finally { clk.restore(); ctx.cleanup() }
})

test('v0.9.49 #46: a put-back card with an open question (gate not skipped) is the user\'s', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const cur = await healedGateOwner(ctx, clk, { question: { active: true, text: '要不要改接口？', choices: [] } })
    assert.ok(!cur.evidence.gateSkipped)
    assert.equal(cur.question?.active, true)
    assert.equal(cur.gateOwner, 'human', 'an open question leaves the gate with the user')
  } finally { clk.restore(); ctx.cleanup() }
})

// The review session of a `reviewing` card without a run cannot be probed (the host forgot it after a restart).
test('v0.9.49 #46: a reviewing card whose review session stays unknown past the quiet window goes back to the merge gate', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    patch(ctx, todo.id, { reviewRunId: '' })
    ctx.flags.probeUnknown.add(todo.reviewSessionId)
    const t0 = Date.now() + 3 * 60 * 1000 // the card is already quiet: only the unknown probes are timed
    ctx.hooks.now = t0
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'reviewing', 'the first unknown probe only starts the count')
    ctx.hooks.now = t0 + 60 * 1000
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'reviewing', 'unknown for less than the quiet window')
    ctx.hooks.now = t0 + 2 * 60 * 1000 + 1
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review', 'unknown for the whole quiet window: put back')
    assert.equal(cur.evidence.reviewVerdict, 'none')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('检测到未启动的审查')))
  } finally { ctx.hooks.now = 0; ctx.cleanup() }
})

test('v0.9.49 #46: one unknown probe of a quiet reviewing card does not put it back; a known probe resets the count', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    patch(ctx, todo.id, { reviewRunId: '' })
    ctx.sessions.get(todo.reviewSessionId).is_running = true // a review the host accepted without a run id
    const t0 = Date.now() + 3 * 60 * 1000 // long quiet: only the unknown count keeps it
    ctx.hooks.now = t0
    ctx.flags.probeUnknown.add(todo.reviewSessionId)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'reviewing', 'a single unknown probe is not taken as idle')
    // The host answers again (working), then forgets it once more: the count starts again.
    ctx.flags.probeUnknown.delete(todo.reviewSessionId)
    ctx.hooks.now = t0 + 90 * 1000
    await ctx.orch.reconcileActiveRuns(ctx.run)
    ctx.flags.probeUnknown.add(todo.reviewSessionId)
    ctx.hooks.now = t0 + 2 * 60 * 1000 + 1
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing', 'unknown since the known probe for less than the window: left alone')
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('检测到未启动的审查')))
  } finally { ctx.hooks.now = 0; ctx.cleanup() }
})

test('v0.9.49 #46: the quiet time of the reviewing heal is read from the injected clock', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    ctx.sessions.get(todo.reviewSessionId).is_running = false
    patch(ctx, todo.id, { reviewRunId: '' })
    // Only the injected clock moves; Date.now does not.
    const later = Date.now() + 3 * 60 * 1000
    ctx.hooks.now = later
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'review', 'quiet time measured on the injected clock')
  } finally { ctx.hooks.now = 0; ctx.cleanup() }
})

test('v0.9.49 #46: a card another write holds is not put back by the reconcile', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const { todo } = await reviewingCard(ctx)
    ctx.sessions.get(todo.reviewSessionId).is_running = false
    patch(ctx, todo.id, { reviewRunId: '' })
    clk.advance(3 * 60 * 1000)
    ctx.orch.todoWriteLocks.set(todo.id, { owner: 'foreign#1', acquiredAt: Date.now(), label: '停止' })
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'reviewing')
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith(HEALED)))
    ctx.orch.todoWriteLocks.delete(todo.id)
  } finally { clk.restore(); ctx.cleanup() }
})

// ---- 2. merge: the conditions are checked before the lock and again inside it ----------------------------

test('v0.9.49 #46: a verdict changed between the first merge check and the lock stops the Chief merge', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await chiefMergeCard(ctx)
    // The moment the merge takes the lock, another write has just withdrawn the approval.
    ctx.hooks.onClock = () => patch(ctx, todo.id, { evidence: { reviewVerdict: 'changes_requested' } })
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }))
    assert.equal(ctx.hooks.onClock, null, 'the change did land at lock time')
    assert.ok(err, 'the merge is refused')
    assert.match(err.message, /拒绝合并 #\d+：.*独立审查结论为「changes_requested」/)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review', 'the card did not go to merging')
    assert.equal(cur.evidence.reviewVerdict, 'changes_requested')
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('开始合并分支至')), 'no merge was started')
    assert.equal(mainFile(project), 'base\n', 'git merged nothing')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false, 'the refused merge released the lock')
    // Nothing is left that blocks the card: the user may still merge it.
    assert.equal((await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })).phase, 'done')
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: a card that left the merge gate between the first check and the lock is not merged', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    ctx.hooks.onClock = () => patch(ctx, todo.id, { phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError: '主备模型均失败' })
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.equal(ctx.hooks.onClock, null)
    assert.ok(err, 'the merge is refused')
    assert.match(err.message, /当前阶段为「failed」/)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'failed')
    assert.equal(cur.lastError, '主备模型均失败')
    assert.equal(mainFile(project), 'base\n')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: a card deleted between the first merge check and the lock is reported as gone', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    ctx.hooks.onClock = () => ctx.db.deleteTodoCascade(1, 'default', todo.id)
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.ok(err)
    assert.match(err.message, /Todo not found/)
    assert.equal(mainFile(project), 'base\n')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: the first merge check still runs before the lock (a refusal costs no lock and no busy line)', async () => {
  const ctx = setup()
  try {
    const { todo } = await chiefMergeCard(ctx)
    patch(ctx, todo.id, { evidence: { reviewVerdict: 'none' } })
    // Another write holds the card.
    ctx.orch.todoWriteLocks.set(todo.id, { owner: 'foreign#1', acquiredAt: Date.now(), label: '构建派发' })
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }))
    assert.ok(err)
    assert.notEqual(err.code, 'TODO_BUSY', 'refused by the merge conditions, before the lock was asked for')
    assert.match(err.message, /拒绝合并/)
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('正在执行「构建派发」')), 'no busy line on the card')
    ctx.orch.todoWriteLocks.delete(todo.id)
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: an undisturbed Chief merge still goes through', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await chiefMergeCard(ctx)
    const merged = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' })
    assert.equal(merged.phase, 'done')
    assert.equal(mainFile(project), 'feature side\n')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

// ---- 3. stop: not on a card that is done or closed ---------------------------------------------------------

test('v0.9.49 #46: stopping a merged card is refused in words and changes nothing (it used to go back to todo)', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    assert.equal((await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })).phase, 'done')
    const before = get(ctx, todo.id)
    const stopsBefore = ctx.calls.stop
    for (const discard of [false, true]) {
      const err = await rejection(ctx.orch.cancelBuild(ctx.run, { todoId: todo.id, discard }))
      assert.ok(err, `refused (discard=${discard})`)
      assert.match(err.message, /已完成/)
      assert.match(err.message, /停止没有执行/)
      assert.doesNotMatch(err.message, /Transition|not allowed/)
      const cur = get(ctx, todo.id)
      assert.equal(cur.phase, 'done')
      assert.equal(cur.revision, before.revision, 'nothing was written')
      assert.equal(cur.buildRunId, before.buildRunId)
      assert.equal(cur.branch, before.branch)
      assert.equal(ctx.calls.stop, stopsBefore, 'no session was stopped')
      assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('已停止')))
      assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
    }
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: stop with discard on a closed card is refused; its worktree and branch stay', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await buildingTodo(ctx)
    // Uncommitted work: closing leaves such a worktree alone.
    writeFileSync(join(todo.worktreePath, 'draft.txt'), 'not committed\n')
    assert.equal((await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })).phase, 'closed')
    const before = get(ctx, todo.id)
    assert.ok(before.worktreePath && existsSync(before.worktreePath), 'the closed card kept its worktree')

    for (const discard of [true, false]) {
      const err = await rejection(ctx.orch.cancelBuild(ctx.run, { todoId: todo.id, discard }))
      assert.ok(err, `refused (discard=${discard})`)
      assert.match(err.message, /已关闭/)
      assert.match(err.message, /停止没有执行/)
      const cur = get(ctx, todo.id)
      assert.equal(cur.phase, 'closed')
      assert.equal(cur.revision, before.revision)
      assert.equal(cur.worktreePath, before.worktreePath)
      assert.ok(existsSync(join(before.worktreePath, 'draft.txt')), 'the uncommitted file is still there')
      assert.ok(hasBranch(project.repoPath, before.branch), 'the branch is still there')
      assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
    }
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: stop still works in every phase that has something to stop or park', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    assert.equal((await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })).phase, 'todo', 'building')
    for (const [phase, expected] of [['queued', 'todo'], ['confirm', 'todo'], ['failed', 'todo'], ['review', 'todo'], ['reviewing', 'review'], ['merging', 'review'], ['todo', 'todo']]) {
      patch(ctx, todo.id, { phase })
      assert.equal((await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })).phase, expected, phase)
      assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
    }
  } finally { ctx.cleanup() }
})

// ---- 4. close: a done card is refused in words -------------------------------------------------------------

test('v0.9.49 #46: closing a done card (merged, or marked done) says why in Chinese and changes nothing', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    assert.equal((await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })).phase, 'done')
    const before = get(ctx, todo.id)
    const err = await rejection(ctx.orch.closeTodo(ctx.run, { todoId: todo.id }))
    assert.ok(err, 'refused')
    assert.doesNotMatch(err.message, /Transition|not allowed|phase "/, 'not the state machine text')
    assert.match(err.message, new RegExp(`#${todo.number} 已完成`))
    assert.match(err.message, /不需要关闭/)
    assert.match(err.message, /关闭没有执行/)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'done')
    assert.equal(cur.revision, before.revision)
    assert.ok(!timeline(ctx, todo.id).includes('已关闭'))
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)

    // Marked done by hand: the same answer.
    const plain = (await ctx.orch.createTodo(ctx.run, { projectId: todo.projectId, topicId: todo.topicId, title: 'T2', agentId: todo.agentId })).todo
    assert.equal((await ctx.orch.completeTodo(ctx.run, { todoId: plain.id })).phase, 'done')
    assert.match((await rejection(ctx.orch.closeTodo(ctx.run, { todoId: plain.id }))).message, /已完成.*不需要关闭/)
    assert.equal(get(ctx, plain.id).phase, 'done')
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: close still closes the phases it could close', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    for (const phase of ['todo', 'queued', 'confirm', 'failed', 'review']) {
      patch(ctx, todo.id, { phase })
      assert.equal((await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })).phase, 'closed', phase)
    }
  } finally { ctx.cleanup() }
})

// ---- 5. `cancelled` is not a phase -------------------------------------------------------------------------

test('v0.9.49 #46: every phase whose queue is dropped is a phase of the state machine', () => {
  const ctx = setup()
  try {
    const drop = ctx.orch.TODO_QUEUE_DROP_PHASES
    assert.ok(drop instanceof Set, 'the orchestrator shows the set')
    for (const phase of drop) assert.ok(TODO_PHASES.includes(phase), `「${phase}」 is a phase the state machine knows`)
    assert.deepEqual([...drop].sort(), ['closed', 'done'])
    assert.ok(!TODO_PHASES.includes('cancelled'), 'no such phase was added')
  } finally { ctx.cleanup() }
})

test('v0.9.49 #46: neither CONTRACTS.md nor the orchestrator names a `cancelled` todo phase', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const doc = read('docs/CONTRACTS.md')
  const queued = doc.split('\n').find(l => l.includes('Queued instructions and a finished card'))
  assert.ok(queued, 'the paragraph exists')
  assert.ok(!queued.includes('cancelled'), 'the paragraph names only phases that exist')
  assert.match(queued, /not in `done` \/ `closed`/)
  // The whole document, not only that paragraph: `cancelled` written as a code word names a phase.
  for (const [i, line] of doc.split('\n').entries()) {
    assert.ok(!line.includes('`cancelled`'), `CONTRACTS.md line ${i + 1} names no \`cancelled\` phase`)
  }
  const src = read('src/server/orchestrator.mjs')
  assert.ok(!/'cancelled'/.test(src), "no 'cancelled' phase literal in the orchestrator")
  assert.ok(!src.includes('done / closed / cancelled'))
})

// ---- docs and version --------------------------------------------------------------------------------------

test('v0.9.49 #46: one 0.9.49 changelog section holds these entries; CONTRACTS.md describes the five points', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const changelog = read('CHANGELOG.md')
  assert.equal(changelog.split('\n').filter(l => l.startsWith('## [0.9.49]')).length, 1, 'exactly one 0.9.49 heading')
  const section = changelog.slice(changelog.indexOf('## [0.9.49]'), changelog.indexOf('## [0.9.48]'))
  for (const needle of ['审查派发未成功', '不需要关闭', '停止没有执行', '`cancelled`']) {
    assert.ok(section.includes(needle), `the 0.9.49 section mentions ${needle}`)
  }
  const doc = read('docs/CONTRACTS.md')
  const contracts = doc.slice(doc.indexOf('since 0.9.49'))
  for (const needle of ['审查派发未成功', '不需要关闭', 'reconcileActiveRuns', 'inside the lock']) {
    assert.ok(contracts.includes(needle), `CONTRACTS.md mentions ${needle}`)
  }
  const pkg = JSON.parse(read('package.json'))
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
})

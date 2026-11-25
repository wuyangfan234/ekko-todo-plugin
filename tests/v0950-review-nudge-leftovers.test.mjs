// v0.9.52 (#50): three leftovers of the request for a missing review verdict (#47), plus one spelling.
//  1. The host refuses the request because the review session already has a run ("already running"):
//     nothing was sent, so nothing is counted and the timeline does not say the reviewer was asked.
//  2. The end of the same turn settled twice (same last assistant message) does not use up the one request:
//     evidence.reviewInconclusiveTurn holds the id of the message the request was sent for. While the
//     requested run works (or the host cannot tell) nothing is written. Once the session is known idle the
//     transcript is read again and the card IS written: to the human gate when the requested run wrote
//     nothing, with the new verdict when its answer arrived meanwhile.
//  3. The bare words YET and LATER no longer make a text with a verdict token a progress report.
//  4. `VERDICT: CHANGES REQUESTED` / `VERDICT: CHANGES-REQUESTED` are read as the rejection line.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import * as orchestratorModule from '../src/server/orchestrator.mjs'

const { createOrchestrator } = orchestratorModule
const parse = text => orchestratorModule.parseReviewVerdict?.(text)

// ---- harness (as tests/v0949-review-inconclusive.test.mjs, with three more switches) ----------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-nudge-leftovers-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], clock: () => Date.now() })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, runs: [] }
  // runError: the next sessions.run throws it. runErrorLeavesRunning: the session is working when it does
  // (the host took the run, or had one already). onRunError: called just before the throw.
  // probeUnknown: session ids the host cannot tell the state of.
  // onProbe: called once, when the host is next asked whether a session is working.
  // messagesError: reading a transcript fails while it is set. onMessages: called once, on the next reading.
  // queueLength: the number of runs the host reports as queued for a session when it is asked.
  const flags = { queueLength: 0, runError: null, runErrorLeavesRunning: false, onRunError: null, onProbe: null, onMessages: null, messagesError: false, probeUnknown: new Set() }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) {
        calls.create += 1
        const id = `sess-${++seq}`
        sessions.set(id, { id, ...input, messages: [], is_running: false })
        return { session: { id } }
      },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        const s = sessions.get(id)
        if (flags.runError) {
          const err = flags.runError
          flags.runError = null
          if (flags.runErrorLeavesRunning && s) s.is_running = true
          flags.runErrorLeavesRunning = false
          const hook = flags.onRunError
          flags.onRunError = null
          hook?.()
          throw err
        }
        calls.run += 1
        calls.runs.push({ id, input: String(input) })
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) {
        if (flags.probeUnknown.has(id)) return null
        const s = sessions.get(id)
        return s ? { session: s, is_running: s.is_running } : null
      },
      async messages(id) {
        if (flags.messagesError) throw new Error('transcript unavailable')
        const hook = flags.onMessages
        flags.onMessages = null
        hook?.()
        return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false }
      },
      async connect(id, cb) {
        if (flags.probeUnknown.has(id)) throw new Error('socket closed')
        const hook = flags.onProbe
        flags.onProbe = null
        hook?.()
        const timer = setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(sessions.get(id)?.is_running), runStartedAt: 0, queueLength: flags.queueLength }), 0)
        return { close() { clearTimeout(timer) } }
      },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {}, notify() {} } }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, calls, flags, sessions, cleanup }
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
const PROGRESS = '静态审查已完成（三处写点逐个核对过）。测试循环还在跑（目标文件已连续 3 次 33/33 绿），等它跑完后我再补跑全量、两个探针和 dist 重建比对，然后给结论。'
const NUDGE_LINE = '审查未给出结论，已要求它收口'
const HUMAN_LINE = '审查两次都没有给出结论，需要人工判断或重派审查'
const STOPPED_LINE = '审查被停止，没有给出结论'
const DISCARD_LINE = '本轮结果已丢弃'

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))

async function reviewingCard(ctx, { autopilot = true, autoMerge = false } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '催促残留测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '催促残留测试 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
  if (autoMerge) db.updateProject(1, 'default', project.id, { autopilot: { autoMergeAfterReview: true } })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot })
  const chief = await run.host.sessions.create({ title: 'chief' })
  db.updateTopic(1, 'default', topic.id, { chiefSessionId: chief.session.id })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id, withPlan: false })
  writeFileSync(join(built.worktreePath, 'a.txt'), 'feature side\n')
  git(built.worktreePath, 'commit', '-am', 'work')
  await endRun(ctx, built.buildSessionId, 'done')
  assert.equal(get(ctx, todo.id).phase, 'review')
  const reviewing = await orch.runIndependentReview(run, { todoId: todo.id })
  assert.equal(reviewing.phase, 'reviewing')
  return { todo: get(ctx, todo.id), project, topic, chiefSessionId: chief.session.id }
}

// A turn of `sessionId` ends with `text` as its last assistant message ('' = no assistant text).
async function endRun(ctx, sessionId, text, type = 'chat.run.completed', data = {}) {
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  if (text) s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: text, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type, data: { session_id: sessionId, finish_reason: 'stop', ...data } }, ctx.run)
}

// The host reports the end of a turn of `sessionId` once more: nothing new in the transcript, and the
// session is left as it is (after the request it is working on the run the request started).
const sameEventAgain = (ctx, sessionId, type = 'chat.run.completed') =>
  ctx.orch.handleHostEvent({ type, data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)

const runsOf = (ctx, sessionId) => ctx.calls.runs.filter(r => r.id === sessionId)

// ---- 1. "already running" is not a request that was sent -------------------------------------------------

test('#50: a request the host refused as "already running" is not counted and not written as sent', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const reviewRuns = runsOf(ctx, todo.reviewSessionId).length
    ctx.flags.runError = new Error('Session is already running')
    ctx.flags.runErrorLeavesRunning = true
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    let cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing', 'the review goes on: a run is working in its session')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 0, 'nothing was sent, so nothing is counted')
    assert.equal(cur.reviewRunId, todo.reviewRunId, 'the run on the card is not replaced by an empty one')
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(NUDGE_LINE)), 'the timeline does not say the reviewer was asked')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
    assert.equal(cur.revision, todo.revision, 'the card is not written at all')
    assert.equal(runsOf(ctx, todo.reviewSessionId).length, reviewRuns)

    // The run that was working ends without a verdict as well: this is the first request, and it is sent.
    await endRun(ctx, todo.reviewSessionId, '全量还剩两个文件，稍后继续。')
    cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    assert.equal(runsOf(ctx, todo.reviewSessionId).length, reviewRuns + 1, 'the one request is still available')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(NUDGE_LINE)).length, 1)
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)), 'one turn without a verdict is not "twice"')

    await endRun(ctx, todo.reviewSessionId, 'VERDICT: APPROVED')
    cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.gateKind, 'merge')
  } finally { ctx.cleanup() }
})

test('#50: "already running" while the card was taken over is dropped with the usual line', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    ctx.flags.runError = new Error('session already running')
    // The card leaves `reviewing` while the request is out (a stop that put it back at the gate).
    ctx.flags.onRunError = () => ctx.db.updateTodo(1, 'default', todo.id, { phase: 'review', reviewRunId: '' })
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 0)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(DISCARD_LINE) && e.includes('审查续跑')), 'one line says the result was dropped')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(NUDGE_LINE)))
  } finally { ctx.cleanup() }
})

// The rule is the host's "already running", not an empty run id: a launch call that timed out while the
// host took the run answers without a run id too, and that request was sent.
test('#50: a request that timed out but was taken by the host is still counted as sent', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    ctx.flags.runError = new Error('The operation was aborted due to timeout')
    ctx.flags.runErrorLeavesRunning = true
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    assert.equal(cur.reviewRunId, '', 'the host gave no run id')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(NUDGE_LINE)))
  } finally { ctx.cleanup() }
})

// ---- 2. the same turn settled twice ----------------------------------------------------------------------

test('#50: the same turn reported twice does not use up the request, and the verdict that follows is kept', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const nudged = get(ctx, todo.id)
    assert.equal(nudged.evidence.reviewInconclusiveRetries, 1)
    assert.ok(nudged.evidence.reviewInconclusiveTurn, 'the message the request was sent for is on the card')
    assert.equal(ctx.sessions.get(todo.reviewSessionId).is_running, true, 'the requested run is working')

    // The end of that first turn is reported again, twice. No new assistant text.
    for (const round of [1, 2]) {
      await sameEventAgain(ctx, todo.reviewSessionId)
      const cur = get(ctx, todo.id)
      assert.equal(cur.phase, 'reviewing', `still reviewing after repeat ${round}`)
      assert.equal(cur.evidence.reviewVerdict, 'pending')
      assert.equal(cur.gateKind, 'review')
      assert.equal(cur.reviewRunId, nudged.reviewRunId)
      assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
      assert.equal(cur.revision, nudged.revision, 'nothing is written')
      assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)), 'one turn without a verdict is not "twice"')
    }
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(NUDGE_LINE)).length, 1)

    // The reviewer answers the request: its verdict is read, not dropped.
    await endRun(ctx, todo.reviewSessionId, '全量 33/33 绿，dist 一致。\nVERDICT: APPROVED')
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.gateKind, 'merge')
    assert.ok(timeline(ctx, todo.id).includes('独立审查结论：通过'))
  } finally { ctx.cleanup() }
})

// The other reading of "same last message": the requested turn has ended and wrote nothing. The card must
// not stay `reviewing` with no run; it goes to the human gate as before.
test('#50: a requested turn that ends without any text still parks the card at the human gate', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    assert.equal(get(ctx, todo.id).evidence.reviewInconclusiveRetries, 1)
    await endRun(ctx, todo.reviewSessionId, '')
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateOwner, 'human')
    assert.equal(cur.gateKind, 'review_inconclusive')
    assert.equal(cur.reviewRunId, '')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
  } finally { ctx.cleanup() }
})

test('#50: a repeat while the host cannot tell whether the session is working changes nothing', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const nudged = get(ctx, todo.id)
    ctx.flags.probeUnknown.add(todo.reviewSessionId)
    ctx.sessions.get(todo.reviewSessionId).is_running = false
    await sameEventAgain(ctx, todo.reviewSessionId)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing', 'unknown is not taken as "the requested turn ended"')
    assert.equal(cur.revision, nudged.revision)
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
  } finally { ctx.cleanup() }
})

test('#50: a message without an id is never taken for one that was settled before', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const s = ctx.sessions.get(todo.reviewSessionId)
    s.is_running = false
    s.messages.push({ role: 'assistant', content: PROGRESS, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    await sameEventAgain(ctx, todo.reviewSessionId)
    const nudged = get(ctx, todo.id)
    assert.equal(nudged.evidence.reviewInconclusiveRetries, 1)
    assert.equal(nudged.evidence.reviewInconclusiveTurn, '', 'no id, no key')
    // Reported again while the requested run is working: without an id the two cannot be told apart, so
    // this settles as it did before #50.
    await sameEventAgain(ctx, todo.reviewSessionId)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.gateKind, 'review_inconclusive')
  } finally { ctx.cleanup() }
})

test('#50: a stop of the requested run is not held back as a repeat', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    assert.equal(ctx.sessions.get(todo.reviewSessionId).is_running, true)
    // The stop event arrives while the host still shows the session as working.
    await sameEventAgain(ctx, todo.reviewSessionId, 'chat.run.stopped')
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateOwner, 'human')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(STOPPED_LINE)))
  } finally { ctx.cleanup() }
})

test('#50: the settled message is forgotten by the next review dispatch and by a build dispatch', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    assert.equal(todo.evidence.reviewInconclusiveTurn, '', 'a fresh round has no settled message')
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const firstKey = get(ctx, todo.id).evidence.reviewInconclusiveTurn
    assert.ok(firstKey)
    await endRun(ctx, todo.reviewSessionId, '全量还剩两个文件，稍后继续。')
    assert.equal(get(ctx, todo.id).gateKind, 'review_inconclusive')
    assert.equal(get(ctx, todo.id).evidence.reviewInconclusiveTurn, firstKey, 'kept on the settled card, like the count')

    const again = await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    assert.equal(again.evidence.reviewInconclusiveTurn, '', 'a new review dispatch starts without it')
    assert.equal(again.evidence.reviewInconclusiveRetries, 0)
    // The new round ends with no text at all: the last message with text is the one of the round before.
    // It is asked for the verdict (the first request of this round), not skipped as "seen".
    const runsBefore = runsOf(ctx, again.reviewSessionId).length
    await endRun(ctx, again.reviewSessionId, '')
    let cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    assert.equal(runsOf(ctx, again.reviewSessionId).length, runsBefore + 1)
    assert.ok(cur.evidence.reviewInconclusiveTurn)

    await endRun(ctx, again.reviewSessionId, '缺一条用例。\nVERDICT: CHANGES_REQUESTED')
    assert.equal(get(ctx, todo.id).evidence.reviewVerdict, 'changes_requested')
    const rebuilt = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, extraMessage: '补一条用例' })
    cur = get(ctx, rebuilt.id)
    assert.equal(cur.phase, 'building')
    assert.equal(cur.evidence.reviewInconclusiveTurn, '', 'a build dispatch clears it with the count')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 0)
  } finally { ctx.cleanup() }
})

test('#50: a card taken over while the repeat asks the host is not written', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    // The requested run is over (idle), and while the settle asks the host the card is put back at the
    // merge gate by somebody else.
    ctx.sessions.get(todo.reviewSessionId).is_running = false
    ctx.flags.onProbe = () => ctx.db.updateTodo(1, 'default', todo.id, { phase: 'review', gateOwner: 'human', gateKind: 'merge', reviewRunId: '', evidence: { reviewVerdict: 'none' } })
    await sameEventAgain(ctx, todo.reviewSessionId)
    const cur = get(ctx, todo.id)
    assert.equal(cur.gateKind, 'merge', 'the gate the other write set is kept')
    assert.equal(cur.evidence.reviewVerdict, 'none')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(DISCARD_LINE) && e.includes('审查结论')))
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
  } finally { ctx.cleanup() }
})

// The verdict arrives while the repeat is asking the host. Its own end event is refused at the entry of the
// settle (one settle per card at a time), so the settle that is waiting must read the transcript again.
test('#50: a verdict that arrives while the repeat asks the host is the one that is settled', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    assert.equal(get(ctx, todo.id).evidence.reviewInconclusiveRetries, 1)
    let late = null
    ctx.flags.onProbe = () => { late = endRun(ctx, todo.reviewSessionId, '全量 33/33 绿，dist 一致。\nVERDICT: APPROVED') }
    await sameEventAgain(ctx, todo.reviewSessionId)
    await late
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'approved', 'the last message of the session decides')
    assert.equal(cur.gateKind, 'merge')
    assert.notEqual(cur.gateKind, 'review_inconclusive')
    assert.ok(cur.evidence.reviewSummary.includes('VERDICT: APPROVED'))
    assert.ok(timeline(ctx, todo.id).includes('独立审查结论：通过'))
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
  } finally { ctx.cleanup() }
})

test('#50: a rejection that arrives while the repeat asks the host is settled as a rejection', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    let late = null
    ctx.flags.onProbe = () => { late = endRun(ctx, todo.reviewSessionId, '缺一条并发用例。\nVERDICT: CHANGES_REQUESTED') }
    await sameEventAgain(ctx, todo.reviewSessionId)
    await late
    const cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'changes_requested')
    assert.equal(cur.gateKind, 'changes')
    assert.ok(cur.evidence.reviewSummary.includes('缺一条并发用例'))
  } finally { ctx.cleanup() }
})

// The requested run writes a verdict and then fails while the repeat asks the host. Its failed event is
// refused at the entry of the settle; the settle that is waiting must keep the failure, not the text.
test('#50: a run that writes a verdict and then fails while the repeat asks the host stays review_failed', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    assert.equal(get(ctx, todo.id).evidence.reviewInconclusiveRetries, 1)
    let late = null
    ctx.flags.onProbe = () => {
      late = endRun(ctx, todo.reviewSessionId, '全量 33/33 绿。\nVERDICT: APPROVED', 'chat.run.failed', { error: 'HTTP 529 overloaded' })
    }
    await sameEventAgain(ctx, todo.reviewSessionId)
    await late
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'review_failed', 'the failure is kept, not the text before it')
    assert.equal(cur.gateKind, 'review_failed')
    assert.notEqual(cur.gateKind, 'merge')
    assert.equal(cur.gateOwner, 'human')
    assert.ok(cur.lastError.includes('HTTP 529 overloaded'), 'the reason of the failure is on the card')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('审查运行失败：') && e.includes('HTTP 529 overloaded')))
    assert.ok(!timeline(ctx, todo.id).includes('独立审查结论：通过'))
  } finally { ctx.cleanup() }
})

test('#50: a run that fails without text while the repeat asks the host stays review_failed', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    let late = null
    ctx.flags.onProbe = () => {
      late = endRun(ctx, todo.reviewSessionId, '', 'chat.run.failed', { error: 'HTTP 529 overloaded' })
    }
    await sameEventAgain(ctx, todo.reviewSessionId)
    await late
    const cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'review_failed', 'not an ordinary turn without a verdict')
    assert.equal(cur.gateKind, 'review_failed')
    assert.ok(cur.lastError.includes('HTTP 529 overloaded'))
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
  } finally { ctx.cleanup() }
})

test('#50: a failure kept during the repeat is written even when the transcript cannot be read again', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    let late = null
    ctx.flags.onProbe = () => {
      late = endRun(ctx, todo.reviewSessionId, '', 'chat.run.failed', { error: 'HTTP 529 overloaded' })
      ctx.flags.messagesError = true
    }
    await sameEventAgain(ctx, todo.reviewSessionId)
    await late
    ctx.flags.messagesError = false
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review', 'a failure needs no text: the card is not left reviewing with no run')
    assert.equal(cur.evidence.reviewVerdict, 'review_failed')
    assert.ok(cur.lastError.includes('HTTP 529 overloaded'))
  } finally { ctx.cleanup() }
})

test('#50: a failure kept during the repeat is written even when the host still says the session is working', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    let late = null
    ctx.flags.onProbe = () => {
      late = endRun(ctx, todo.reviewSessionId, '', 'chat.run.failed', { error: 'HTTP 529 overloaded' })
      // The host's session state lags behind its own end event.
      ctx.sessions.get(todo.reviewSessionId).is_running = true
    }
    await sameEventAgain(ctx, todo.reviewSessionId)
    await late
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review', 'the end event says the run is over, whatever the probe answered')
    assert.equal(cur.evidence.reviewVerdict, 'review_failed')
  } finally { ctx.cleanup() }
})

test('#50: a failure kept during the repeat is not replaced by a later report of the same run', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const late = []
    ctx.flags.onProbe = () => {
      late.push(endRun(ctx, todo.reviewSessionId, 'VERDICT: APPROVED', 'chat.run.failed', { error: 'HTTP 529 overloaded' }))
      late.push(sameEventAgain(ctx, todo.reviewSessionId))
    }
    await sameEventAgain(ctx, todo.reviewSessionId)
    await Promise.all(late)
    const cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'review_failed')
    assert.equal(cur.gateKind, 'review_failed')
    assert.ok(cur.lastError.includes('HTTP 529 overloaded'))
  } finally { ctx.cleanup() }
})

// The requested run is still in the host's queue: the session is not working yet, but a run is waiting.
// The launch and the reconcile already read a non-empty queue as "working"; the repeat reads it the same.
test('#50: a repeat while the requested run is still queued changes nothing, and the queued run decides', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const nudged = get(ctx, todo.id)
    const lines = timeline(ctx, todo.id).length
    ctx.sessions.get(todo.reviewSessionId).is_running = false
    ctx.flags.queueLength = 1
    await sameEventAgain(ctx, todo.reviewSessionId)
    let cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing', 'a queued run is a run that has not ended')
    assert.equal(cur.revision, nudged.revision, 'the card is not written')
    assert.equal(cur.gateKind, nudged.gateKind)
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.equal(timeline(ctx, todo.id).length, lines, 'no timeline line')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
    // The queued run starts and gives its verdict.
    ctx.flags.queueLength = 0
    await endRun(ctx, todo.reviewSessionId, '全量绿，dist 一致。\nVERDICT: APPROVED')
    cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.gateKind, 'merge')
    assert.ok(timeline(ctx, todo.id).includes('独立审查结论：通过'))
  } finally { ctx.cleanup() }
})

// The end events kept during the repeat only go up: completed < stopped < failed.
test('#50: a stop kept during the repeat is not replaced by a later completed report of the same run', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const late = []
    ctx.flags.onProbe = () => {
      late.push(endRun(ctx, todo.reviewSessionId, '', 'chat.run.stopped'))
      late.push(sameEventAgain(ctx, todo.reviewSessionId))
    }
    await sameEventAgain(ctx, todo.reviewSessionId)
    await Promise.all(late)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateOwner, 'human')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(STOPPED_LINE)), 'the timeline says the review was stopped')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)), 'not "twice without a verdict"')
  } finally { ctx.cleanup() }
})

test('#50: a failure after a stop kept during the repeat is the one that is written', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const late = []
    ctx.flags.onProbe = () => {
      late.push(endRun(ctx, todo.reviewSessionId, '', 'chat.run.stopped'))
      late.push(endRun(ctx, todo.reviewSessionId, '', 'chat.run.failed', { error: 'HTTP 529 overloaded' }))
      late.push(sameEventAgain(ctx, todo.reviewSessionId))
    }
    await sameEventAgain(ctx, todo.reviewSessionId)
    await Promise.all(late)
    const cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'review_failed')
    assert.equal(cur.gateKind, 'review_failed')
    assert.ok(cur.lastError.includes('HTTP 529 overloaded'))
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(STOPPED_LINE)))
  } finally { ctx.cleanup() }
})

test('#50: a card taken over while the transcript is read again is not written', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    ctx.sessions.get(todo.reviewSessionId).is_running = false
    // Still the owner after the probe; the card is put back at the merge gate during the second reading.
    ctx.flags.onProbe = () => {
      ctx.flags.onMessages = () => ctx.db.updateTodo(1, 'default', todo.id, { phase: 'review', gateOwner: 'human', gateKind: 'merge', reviewRunId: '', evidence: { reviewVerdict: 'none' } })
    }
    await sameEventAgain(ctx, todo.reviewSessionId)
    const cur = get(ctx, todo.id)
    assert.equal(cur.gateKind, 'merge', 'the gate the other write set is kept')
    assert.equal(cur.evidence.reviewVerdict, 'none')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARD_LINE) && e.includes('审查结论')).length, 1)
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
  } finally { ctx.cleanup() }
})

// The second reading: when it fails, nothing is known about the requested turn, and nothing is written.
test('#50: the card is not parked when the transcript cannot be read again after the probe', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const nudged = get(ctx, todo.id)
    ctx.sessions.get(todo.reviewSessionId).is_running = false
    ctx.flags.onProbe = () => { ctx.flags.messagesError = true }
    await sameEventAgain(ctx, todo.reviewSessionId)
    let cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing')
    assert.equal(cur.revision, nudged.revision, 'nothing is written')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
    // The transcript is back and still ends with the same message: the requested turn wrote nothing.
    ctx.flags.messagesError = false
    await sameEventAgain(ctx, todo.reviewSessionId)
    cur = get(ctx, todo.id)
    assert.equal(cur.gateKind, 'review_inconclusive')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(HUMAN_LINE)))
  } finally { ctx.cleanup() }
})

test('#50: a review dispatch that fails to launch puts the settled message back with the count', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    await endRun(ctx, todo.reviewSessionId, '全量还剩两个文件，稍后继续。')
    const parked = get(ctx, todo.id)
    assert.equal(parked.gateKind, 'review_inconclusive')
    assert.ok(parked.evidence.reviewInconclusiveTurn)
    ctx.flags.runError = new Error('host refused: no capacity')
    await assert.rejects(ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id }), /no capacity/)
    const cur = get(ctx, todo.id)
    assert.equal(cur.gateKind, 'review_inconclusive', 'the card is as it was')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    assert.equal(cur.evidence.reviewInconclusiveTurn, parked.evidence.reviewInconclusiveTurn)
  } finally { ctx.cleanup() }
})

// ---- 3. YET / LATER --------------------------------------------------------------------------------------

test('#50: the bare words YET and LATER no longer turn a text with a verdict token into a progress report', () => {
  assert.equal(parse('CHANGES_REQUESTED: the retry path has yet to be covered by a test.'), 'changes_requested')
  assert.equal(parse('CHANGES_REQUESTED：并发路径缺用例（see the later section of the diff）。'), 'changes_requested')
  assert.equal(parse('APPROVED. The two naming nits can be handled later.'), 'approved')
  assert.equal(parse('Looks correct. APPROVED. Later refactors are out of scope here.'), 'approved')
  assert.equal(parse('APPROVED — best version yet.'), 'approved')
})

test('#50: YET and LATER next to a negation or a promise still wait for a later turn', () => {
  for (const text of [
    // `not yet`, kept as it was.
    'Not yet. Leaning APPROVED.',
    'The full run is not yet done; leaning APPROVED.',
    // A negation and `yet` in one sentence: without this, "not APPROVED yet" would read as approved.
    'This is not APPROVED yet.',
    'The full run has not finished yet; leaning APPROVED.',
    "I can't call this APPROVED yet.",
    'No verdict yet, probably APPROVED.',
    'Cannot say APPROVED yet.',
    // A promise and `later` in one sentence.
    'I will give the verdict later, likely APPROVED.',
    "I'll report later whether this is APPROVED.",
    'Later I will post the verdict; leaning APPROVED.',
    // The other waiting words are untouched.
    'Static review done. I will continue once the loop finishes; leaning APPROVED.',
    'Tests are still running, so this is not APPROVED yet.',
    '静态审查没发现问题，稍后继续，暂时倾向 APPROVED。',
  ]) assert.equal(parse(text), 'inconclusive', text)
})

// The two samples the task card gave both hold `not yet`, which stays a waiting word: they are still
// inconclusive (asked once), not misread as a verdict of the other kind.
test('#50: a text with `not yet` in it is still asked once, whatever token it names', () => {
  assert.equal(parse('CHANGES_REQUESTED: 新用例还没有覆盖并发路径 (not yet covered).'), 'inconclusive')
  assert.equal(parse('APPROVED. One path is not yet covered; can be added later.'), 'inconclusive')
})

test('#50: an approval that mentions "later" settles as approved without a request; "not APPROVED yet" is asked', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx, { autoMerge: true })
    const reviewRuns = runsOf(ctx, todo.reviewSessionId).length
    await endRun(ctx, todo.reviewSessionId, 'APPROVED. The two naming nits can be handled later.')
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 0)
    assert.equal(runsOf(ctx, todo.reviewSessionId).length, reviewRuns, 'the reviewer is not asked again')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(NUDGE_LINE)))
  } finally { ctx.cleanup() }
  const ctx2 = setup()
  try {
    const { todo } = await reviewingCard(ctx2, { autoMerge: true })
    await endRun(ctx2, todo.reviewSessionId, 'This is not APPROVED yet.')
    const cur = get(ctx2, todo.id)
    assert.notEqual(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    await assert.rejects(ctx2.orch.mergeBuild(ctx2.run, { todoId: todo.id, caller: 'chief' }))
    assert.notEqual(get(ctx2, todo.id).phase, 'done')
  } finally { ctx2.cleanup() }
})

// ---- 4. CHANGES REQUESTED / CHANGES-REQUESTED on a verdict line ------------------------------------------

test('#50: a verdict line that writes the rejection with a space or a hyphen is a rejection', () => {
  assert.equal(parse('缺一条用例。\nVERDICT: CHANGES REQUESTED'), 'changes_requested')
  assert.equal(parse('缺一条用例。\nVERDICT: CHANGES-REQUESTED'), 'changes_requested')
  assert.equal(parse('**Verdict：changes requested**'), 'changes_requested')
  assert.equal(parse('VERDICT: APPROVED 是上一轮的结论。\nVERDICT: CHANGES REQUESTED'), 'changes_requested')
})

test('#50: VERDICT: APPROVED after such a rejection line is not approved', () => {
  for (const reject of ['VERDICT: CHANGES REQUESTED', 'VERDICT: CHANGES-REQUESTED', 'VERDICT：CHANGES REQUESTED', 'verdict : changes-requested']) {
    assert.equal(parse(`必须修改。\n${reject}\n修好后可以改成\nVERDICT: APPROVED`), 'inconclusive', reject)
  }
})

test('#50: the words "changes requested" without VERDICT: in front are prose, as before', () => {
  assert.equal(parse('No changes requested. APPROVED.'), 'approved')
  assert.equal(parse('VERDICT: APPROVED, no changes requested'), 'approved')
  assert.equal(parse('上一轮 changes requested 的三处已修好。\nVERDICT: APPROVED'), 'approved')
  // The underscore token and the full-width colon are read as they were.
  assert.equal(parse('问题见上。\nVERDICT ： CHANGES_REQUESTED'), 'changes_requested')
  assert.equal(parse('Overall: CHANGES_REQUESTED, see the two findings above.'), 'changes_requested')
})

test('#50: a rejection written with a space, then a conditional VERDICT: APPROVED, is not merged by the Chief', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx, { autoMerge: true })
    await endRun(ctx, todo.reviewSessionId, '发现 3 处问题，必须修改。\nVERDICT: CHANGES REQUESTED\n修好后可以改成\nVERDICT: APPROVED')
    const cur = get(ctx, todo.id)
    assert.notEqual(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.evidence.reviewVerdict, 'pending', 'the reviewer is asked for one verdict')
    assert.ok(!timeline(ctx, todo.id).includes('独立审查结论：通过'))
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }))
    assert.notEqual(get(ctx, todo.id).phase, 'done')
  } finally { ctx.cleanup() }
})

// ---- 5. documents ----------------------------------------------------------------------------------------

test('#50: documents, contract and version', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const pkg = JSON.parse(read('package.json'))
  const plugin = JSON.parse(read('plugin.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const contract = JSON.parse(read('contracts/plugin.json'))
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  assert.ok(major > 0 || minor > 9 || (minor === 9 && patch >= 52), `version ${pkg.version} is 0.9.52 or later`)
  assert.equal(plugin.version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(contract.description.includes(`v${pkg.version} `))

  const changelog = read('CHANGELOG.md')
  assert.equal(changelog.split('## [0.9.52]').length - 1, 1, 'exactly one 0.9.52 heading')
  const section = changelog.slice(changelog.indexOf('## [0.9.52]'), changelog.indexOf('## [0.9.51]'))
  assert.ok(section.length > 0 && changelog.indexOf('## [0.9.52]') < changelog.indexOf('## [0.9.51]'), 'the 0.9.52 section is above 0.9.51')
  for (const heading of ['### Fixed', '### Changed', '### Not changed']) {
    assert.equal(section.split(`${heading}\n`).length - 1, 1, `one "${heading}" list in the 0.9.52 section`)
  }
  for (const word of ['already running', 'reviewInconclusiveTurn', 'CHANGES REQUESTED', 'CHANGES-REQUESTED', '构建完毕 · 测试通过', 'chat.run.failed', 'queueLength', 'chat.run.stopped']) {
    assert.ok(section.includes(word), `the 0.9.52 section names ${word}`)
  }
  // The entries of this card are not left in the 0.9.50 section (#49), which has been released.
  const s50 = changelog.slice(changelog.indexOf('## [0.9.50]'), changelog.indexOf('## [0.9.49]'))
  assert.ok(s50.includes('reasoning.delta'), 'the 0.9.50 section keeps #49')
  for (const word of ['already running', 'reviewInconclusiveTurn', 'CHANGES-REQUESTED']) {
    assert.ok(!s50.includes(word), `the 0.9.50 section does not name ${word}`)
  }

  const contracts = read('docs/CONTRACTS.md')
  for (const word of ['reviewInconclusiveTurn', 'already running', 'CHANGES REQUESTED', 'CHANGES-REQUESTED']) {
    assert.ok(contracts.includes(word), `CONTRACTS.md names ${word}`)
  }
  // The rule list no longer names the two bare words.
  assert.ok(!contracts.includes('`not yet`, `yet`, `later`'), 'CONTRACTS.md does not list bare yet / later any more')
  const runReview = contract.tools?.run_review?.description || JSON.stringify(contract).match(/"run_review":\s*\{\s*"description":\s*"([^"]*)"/)?.[1] || ''
  assert.ok(runReview.includes('CHANGES REQUESTED') && runReview.includes('CHANGES-REQUESTED'), 'run_review names the two spellings')
  // The tool description gained the two spellings and nothing else: what a refused or a repeated request
  // does is in CONTRACTS.md, where both outcomes of a repeat (nothing written / written) are spelled out.
  for (const word of ['already running', 'reviewInconclusiveTurn', 'changes nothing']) {
    assert.ok(!runReview.includes(word), `run_review does not describe ${word}`)
  }
  const repeat = contracts.slice(contracts.indexOf('Same turn settled again.'))
  const repeatLine = repeat.slice(0, repeat.indexOf('\n'))
  for (const word of ['nothing is written', 'read once more', 'human gate', 'Another message']) {
    assert.ok(repeatLine.includes(word), `the repeated settle is documented with: ${word}`)
  }
})

test('0.9.57: a new review round that ends with no text never reuses the previous round\'s APPROVED', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, '看过了。\nVERDICT: APPROVED')
    assert.equal(get(ctx, todo.id).evidence.reviewVerdict, 'approved')
    // Review again (same review session is reused); this round produces nothing at all.
    const again = await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    assert.equal(again.reviewSessionId, todo.reviewSessionId, 'the review session is reused')
    await endRun(ctx, again.reviewSessionId, '')
    const cur = get(ctx, todo.id)
    assert.notEqual(cur.evidence.reviewVerdict, 'approved', 'the old verdict is not this round\'s')
  } finally { ctx.cleanup() }
})

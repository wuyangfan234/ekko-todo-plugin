// v0.9.49 (#47): a review that ends without a verdict is no longer recorded as a rejection.
//  1. parseReviewVerdict has a third value, `inconclusive` (no verdict line, empty text, a progress report).
//  2. The first inconclusive turn of a review round is answered with one request for the verdict, in the
//     same review session (evidence.reviewInconclusiveRetries, at most 1). The second parks the card at a
//     human gate (gateKind review_inconclusive) and does not run the Chief.
//  3. A review run that failed is `review_failed`, not `changes_requested`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import * as orchestratorModule from '../src/server/orchestrator.mjs'

const { createOrchestrator } = orchestratorModule
// Not exported before #47: on the old code every rule below fails as an assertion, not as an import error.
const parse = text => orchestratorModule.parseReviewVerdict?.(text)

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-inconclusive-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], clock: () => Date.now() })
  let seq = 0
  const sessions = new Map()
  // runs: every sessions.run call, in order ({ id, input }). runError: the next sessions.run throws it.
  const calls = { create: 0, run: 0, runs: [] }
  const flags = { runError: null }
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
        if (flags.runError) { const err = flags.runError; flags.runError = null; throw err }
        calls.run += 1
        calls.runs.push({ id, input: String(input) })
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false } },
      async connect(id, cb) {
        const timer = setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(sessions.get(id)?.is_running), runStartedAt: 0, queueLength: 0 }), 0)
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
// The last assistant message of the review that was misjudged (session 7465d6b6…, message 377885).
const PROGRESS = '静态审查已完成（三处写点逐个核对过）。测试循环还在跑（目标文件已连续 3 次 33/33 绿），等它跑完后我再补跑全量、两个探针和 dist 重建比对，然后给结论。'
const NUDGE_LINE = '审查未给出结论，已要求它收口'
const HUMAN_LINE = '审查两次都没有给出结论，需要人工判断或重派审查'

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))

// A card whose independent review is running, in a topic that has a Chief session. `autopilot` on means a
// rejected review is the Chief's to act on (it is run with a wake prompt).
async function reviewingCard(ctx, { autopilot = true, autoMerge = false } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '审查结论测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '审查结论测试 Agent')
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
  const card = { todo: get(ctx, todo.id), project, topic, chiefSessionId: chief.session.id }
  // The Chief was already woken once for the finished build; what counts below is what the review adds.
  return { ...card, wakesBefore: chiefWakes(ctx, card) }
}

// A turn of `sessionId` ends normally with `text` as its last assistant message ('' = no assistant text).
async function endRun(ctx, sessionId, text, type = 'chat.run.completed', data = {}) {
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  if (text) s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: text, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type, data: { session_id: sessionId, finish_reason: 'stop', ...data } }, ctx.run)
}

const runsOf = (ctx, sessionId) => ctx.calls.runs.filter(r => r.id === sessionId)
// Times the Chief of the card's topic was run, or (while it is busy) had a wake queued for its next turn.
const chiefWakes = (ctx, { topic, chiefSessionId }) => runsOf(ctx, chiefSessionId).length
  + ctx.db.listTopicQueue(1, 'default', topic.id).filter(q => q.kind === 'wake').length

// ---- 1. the rule -------------------------------------------------------------------------------------------

test('#47: a verdict line decides as before (APPROVED / CHANGES_REQUESTED)', () => {
  // #103: APPROVED decides only as the sole last line; a verdict line followed by more text does not approve.
  assert.equal(parse('逻辑正确。\nVERDICT: APPROVED'), 'approved')
  assert.equal(parse('VERDICT: APPROVED\n逻辑正确。'), 'inconclusive')
  assert.equal(parse('问题见上。\nVERDICT: CHANGES_REQUESTED'), 'changes_requested')
  assert.equal(parse('**Verdict : approved**'), 'approved')
  assert.equal(parse('verdict:changes_requested'), 'changes_requested')
  // Both lines in one text, the rejection last: rejected.
  assert.equal(parse('VERDICT: APPROVED\n…\nVERDICT: CHANGES_REQUESTED'), 'changes_requested')
  // A verdict line outranks waiting words in the same message.
  assert.equal(parse('稍后构建方修完我会再看一遍。\nVERDICT: CHANGES_REQUESTED'), 'changes_requested')
  // Without a verdict line the bare rejection token still counts, as before. #103: the bare word APPROVED
  // no longer approves (no verdict line -> inconclusive).
  assert.equal(parse('Overall: CHANGES_REQUESTED, see the two findings above.'), 'changes_requested')
  assert.equal(parse('Looks correct. APPROVED.'), 'inconclusive')
})

test('#47: no verdict line and no verdict token is inconclusive, not a rejection', () => {
  assert.equal(parse(''), 'inconclusive')
  assert.equal(parse('   \n  '), 'inconclusive')
  assert.equal(parse(null), 'inconclusive')
  assert.equal(parse(PROGRESS), 'inconclusive')
  assert.equal(parse('你希望我按哪个基线比对？'), 'inconclusive')
  // An approval in other words is not turned into a rejection either (it is asked for the verdict line).
  assert.equal(parse('没有发现必须修改的地方。'), 'inconclusive')
  assert.equal(parse('The diff was cut off after the third fi'), 'inconclusive')
})

test('#47: a progress report that waits for a later turn is inconclusive even when it names a verdict token', () => {
  for (const text of [
    '测试还在跑，稍后给出结论（APPROVED 或 CHANGES_REQUESTED）。',
    '等全量测试跑完再决定是 APPROVED 还是 CHANGES_REQUESTED。',
    '静态审查没发现问题，稍后继续，暂时倾向 APPROVED。',
    'Static review done. I will continue once the loop finishes; leaning APPROVED.',
    'Tests are still running, so this is not APPROVED yet.',
    'CHANGES_REQUESTED is likely, but I will continue after the full run.',
  ]) assert.equal(parse(text), 'inconclusive', text)
})

// ---- 1b. several verdict lines in one text (rework of #47) -------------------------------------------------

// The smallest piece of a review that approved the change and quoted both verdict lines while describing
// the rule it had checked. Stored as a rejection at first; since the second rework it is neither guessed
// to be an approval: the reviewer is asked for one verdict.
const QUOTES_BOTH_THEN_APPROVES = [
  '1. `VERDICT: CHANGES_REQUESTED` → `changes_requested`（原样）',
  '2. `VERDICT: APPROVED` → `approved`（原样）',
  '结论',
  'VERDICT: APPROVED',
].join('\n')
// Says nothing a rule other than the last one (the fallback) can catch: no verdict line, no waiting words,
// no verdict token.
const NO_VERDICT_AT_ALL = '你希望我按哪个基线比对？'

test('#47: a review that quotes both verdict lines and ends with VERDICT: APPROVED is inconclusive, not a rejection', () => {
  assert.equal(parse(QUOTES_BOTH_THEN_APPROVES), 'inconclusive')
})

test('#47: a review that quotes both verdict lines and ends with VERDICT: CHANGES_REQUESTED is rejected', () => {
  assert.equal(parse([
    '1. VERDICT: APPROVED → approved（原样）',
    '2. VERDICT: CHANGES_REQUESTED → changes_requested（原样）',
    '缺一条用例。',
    'VERDICT: CHANGES_REQUESTED',
  ].join('\n')), 'changes_requested')
})

test('#47: a last verdict line that names both verdicts is inconclusive', () => {
  for (const text of [
    'VERDICT: APPROVED or CHANGES_REQUESTED',
    '静态部分看完了。\nVERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED',
    'VERDICT: CHANGES_REQUESTED / APPROVED',
    '稍后给出 VERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED。',
    // An earlier clean line does not decide when the last one is the two-way one.
    'VERDICT: CHANGES_REQUESTED\n（格式：VERDICT: APPROVED or CHANGES_REQUESTED）',
  ]) assert.equal(parse(text), 'inconclusive', text)
  // The other way round: a two-way line earlier, a clean line last. The earlier line holds a rejection
  // line, so APPROVED does not decide; a clean CHANGES_REQUESTED last does.
  assert.equal(parse('最后一行写 VERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED。\n\nVERDICT: APPROVED'), 'inconclusive')
  assert.equal(parse('最后一行写 VERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED。\n\nVERDICT: CHANGES_REQUESTED'), 'changes_requested')
})

test('#47 / #103: a rejection counts wherever it is written; an approval only as a sole last line (bold is fine, a code block is not)', () => {
  assert.equal(parse('前面引用过 `VERDICT: CHANGES_REQUESTED` 的判法。\n```\nVERDICT: APPROVED\n```'), 'inconclusive')
  assert.equal(parse('规则里有 VERDICT: APPROVED。\n> VERDICT: CHANGES_REQUESTED'), 'changes_requested')
  assert.equal(parse('VERDICT: CHANGES_REQUESTED 是上一轮的结论。\n\n**VERDICT: APPROVED**\n'), 'inconclusive')
  // Waiting words elsewhere do not outrank a verdict line, whichever verdict it is.
  assert.equal(parse('上一轮写过 VERDICT: CHANGES_REQUESTED，稍后不用再看。\nVERDICT: APPROVED'), 'inconclusive')
  // The same markup and the same waiting words without a rejection line in the text: read as written.
  assert.equal(parse('三处写点都核对过。\n```\nVERDICT: APPROVED\n```'), 'inconclusive')
  assert.equal(parse('三处写点都核对过。\n\n**VERDICT: APPROVED**\n'), 'approved')
  assert.equal(parse('上一轮的问题已修好，稍后不用再看。\nVERDICT: APPROVED'), 'approved')
})

test('#47: the review that quoted both lines is asked once, and its one-line answer settles as approved', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, QUOTES_BOTH_THEN_APPROVES)
    let cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    assert.equal(cur.phase, 'reviewing')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('需修改')))
    await endRun(ctx, todo.reviewSessionId, 'VERDICT: APPROVED')
    cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.gateKind, 'merge')
    assert.ok(timeline(ctx, todo.id).includes('独立审查结论：通过'))
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('需修改')))
  } finally { ctx.cleanup() }
})

// ---- 1c. APPROVED next to a rejection line is never read as approved (second rework of #47) ----------------

// A review that rejects the change and then says what would make it pass. "The last line decides" read it
// as approved, and with auto-merge on the Chief merged the rejected change.
const REJECTS_THEN_CONDITIONAL_APPROVED = [
  '发现 3 处问题（见上），必须修改。',
  'VERDICT: CHANGES_REQUESTED',
  '修好这三处、补上用例后可以改成',
  'VERDICT: APPROVED',
].join('\n')

test('#47: VERDICT: APPROVED as the last line is not approved when a VERDICT: CHANGES_REQUESTED line is in the text', () => {
  assert.equal(parse(REJECTS_THEN_CONDITIONAL_APPROVED), 'inconclusive')
  assert.equal(parse('缺一条用例。\nVERDICT: CHANGES_REQUESTED\n\n修好后可改成：\n**VERDICT: APPROVED**'), 'inconclusive')
  // The other direction stays a rejection: a rejection as the last line stops the card for a person or
  // for rework, it merges nothing.
  assert.equal(parse('上一轮是 VERDICT: APPROVED。\n这一轮多了一处回归。\nVERDICT: CHANGES_REQUESTED'), 'changes_requested')
  // Only a verdict line counts for this: the bare token in prose does not block an approval.
  assert.equal(parse('上一轮 CHANGES_REQUESTED 的三处已修好。\nVERDICT: APPROVED'), 'approved')
})

test('#47: a rejecting review that ends with a conditional APPROVED line is not approved', async () => {
  const ctx = setup()
  try {
    const card = await reviewingCard(ctx, { autoMerge: true })
    const { todo } = card
    const runsBefore = ctx.calls.run
    await endRun(ctx, todo.reviewSessionId, REJECTS_THEN_CONDITIONAL_APPROVED)
    let cur = get(ctx, todo.id)
    assert.notEqual(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.evidence.reviewVerdict, 'pending', 'the reviewer is asked for one verdict')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    assert.equal(cur.phase, 'reviewing')
    assert.equal(ctx.calls.run, runsBefore + 1)
    assert.equal(ctx.calls.runs.at(-1).id, todo.reviewSessionId)
    assert.ok(!timeline(ctx, todo.id).includes('独立审查结论：通过'))
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }))
    assert.notEqual(get(ctx, todo.id).phase, 'done')
    // Said again the same way: a person decides, and the Chief still may not merge.
    await endRun(ctx, todo.reviewSessionId, REJECTS_THEN_CONDITIONAL_APPROVED)
    cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateOwner, 'human')
    assert.equal(cur.gateKind, 'review_inconclusive')
    assert.ok(!timeline(ctx, todo.id).includes('独立审查结论：通过'))
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }), /拒绝合并/)
    assert.equal(get(ctx, todo.id).phase, 'review')
  } finally { ctx.cleanup() }
})

test('#47: a verdict line written with a full-width colon is read like one with an ASCII colon', () => {
  assert.equal(parse('最后一行写 VERDICT：APPROVED 或 CHANGES_REQUESTED。'), 'inconclusive')
  // #103: with a label in front the line is not a sole verdict line.
  assert.equal(parse('结论：VERDICT：APPROVED'), 'inconclusive')
  assert.equal(parse('结论如下。\nVERDICT：APPROVED'), 'approved')
  assert.equal(parse('结论：VERDICT：CHANGES_REQUESTED'), 'changes_requested')
  assert.equal(parse('问题见上。\nVERDICT ： CHANGES_REQUESTED'), 'changes_requested')
  // Mixed colons meet the same rule: a rejection line of either kind keeps APPROVED from deciding.
  assert.equal(parse('必须修改。\nVERDICT：CHANGES_REQUESTED\n修好后可以改成\nVERDICT: APPROVED'), 'inconclusive')
  assert.equal(parse('必须修改。\nVERDICT: CHANGES_REQUESTED\n修好后可以改成\nVERDICT：APPROVED'), 'inconclusive')
  // ASCII colon: as before.
  assert.equal(parse('最后一行写 VERDICT: APPROVED 或 CHANGES_REQUESTED。'), 'inconclusive')
  assert.equal(parse('结论：VERDICT: APPROVED'), 'inconclusive')
  assert.equal(parse('结论如下。\nVERDICT: APPROVED'), 'approved')
  assert.equal(parse('结论：VERDICT: CHANGES_REQUESTED'), 'changes_requested')
})

// Only the fallback: these three fail when the last `return 'inconclusive'` alone answers a rejection.
test('#47 fallback only: text with no verdict line, no waiting words and no token is inconclusive', () => {
  for (const text of [NO_VERDICT_AT_ALL, '逻辑看起来是对的，三处写点都核对过。', 'Read all three write points; nothing stands out.']) {
    assert.equal(parse(text), 'inconclusive', text)
  }
})

test('#47 fallback only: such a turn is asked once for the verdict', async () => {
  const ctx = setup()
  try {
    const card = await reviewingCard(ctx)
    const { todo } = card
    const runsBefore = ctx.calls.run
    await endRun(ctx, todo.reviewSessionId, NO_VERDICT_AT_ALL)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing')
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    assert.equal(ctx.calls.run, runsBefore + 1)
    assert.equal(ctx.calls.runs.at(-1).id, todo.reviewSessionId)
    assert.equal(chiefWakes(ctx, card), card.wakesBefore)
  } finally { ctx.cleanup() }
})

test('#47 fallback only: two such turns park the card at the human gate, not at the changes gate', async () => {
  const ctx = setup()
  try {
    const card = await reviewingCard(ctx)
    const { todo } = card
    await endRun(ctx, todo.reviewSessionId, NO_VERDICT_AT_ALL)
    await endRun(ctx, todo.reviewSessionId, '逻辑看起来是对的，三处写点都核对过。')
    const cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateOwner, 'human')
    assert.equal(cur.gateKind, 'review_inconclusive')
    assert.equal(chiefWakes(ctx, card), card.wakesBefore)
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('需修改')))
  } finally { ctx.cleanup() }
})

// ---- 2. one request for the verdict, then a human gate -----------------------------------------------------

test('#47: the first inconclusive turn is answered once, in the same review session', async () => {
  const ctx = setup()
  try {
    const card = await reviewingCard(ctx)
    const { todo } = card
    assert.equal(todo.evidence.reviewInconclusiveRetries, 0)
    const runsBefore = ctx.calls.run
    const createsBefore = ctx.calls.create
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing', 'the review goes on')
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    assert.equal(cur.reviewSessionId, todo.reviewSessionId, 'same session')
    assert.ok(cur.reviewRunId && cur.reviewRunId !== todo.reviewRunId, 'the new run is recorded')
    assert.equal(ctx.calls.run, runsBefore + 1, 'exactly one more run')
    assert.equal(ctx.calls.create, createsBefore, 'no new session')
    const sent = ctx.calls.runs.at(-1)
    assert.equal(sent.id, todo.reviewSessionId)
    assert.match(sent.input, /VERDICT: APPROVED/)
    assert.match(sent.input, /VERDICT: CHANGES_REQUESTED/)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(NUDGE_LINE)), 'the timeline says the verdict was asked for')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('需修改')), 'not recorded as a rejection')
    assert.equal(chiefWakes(ctx, card), card.wakesBefore, 'the Chief is neither run nor queued a wake')
  } finally { ctx.cleanup() }
})

test('#47: a verdict given after the request settles normally', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    await endRun(ctx, todo.reviewSessionId, '全量 33/33 绿，dist 一致。\nVERDICT: APPROVED')
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.gateKind, 'merge')
    assert.equal(cur.lastError, '')
    assert.ok(timeline(ctx, todo.id).includes('独立审查结论：通过'))
  } finally { ctx.cleanup() }
})

test('#47: a second inconclusive turn parks the card at a human gate and does not run the Chief', async () => {
  const ctx = setup()
  try {
    const card = await reviewingCard(ctx)
    const { todo } = card
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const runsAfterNudge = ctx.calls.run
    await endRun(ctx, todo.reviewSessionId, '全量还剩两个文件，稍后继续。')
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateOwner, 'human', 'a person decides, also in an AUTO topic')
    assert.equal(cur.gateKind, 'review_inconclusive')
    assert.equal(cur.reviewRunId, '')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
    assert.equal(ctx.calls.run, runsAfterNudge, 'no second request and no Chief run')
    assert.equal(chiefWakes(ctx, card), card.wakesBefore, 'the Chief is neither run nor queued a wake')
    const lines = timeline(ctx, todo.id)
    assert.ok(lines.some(e => e.includes(HUMAN_LINE)))
    assert.ok(!lines.some(e => e.includes('需修改')), 'not recorded as a rejection')
    assert.equal(lines.filter(e => e.includes(NUDGE_LINE)).length, 1)
    // The Chief may not merge it; nothing was approved.
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }), /拒绝合并/)
  } finally { ctx.cleanup() }
})

test('#47: a review whose turns never say anything (empty text) takes the same road', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx, { autopilot: false })
    await endRun(ctx, todo.reviewSessionId, '')
    assert.equal(get(ctx, todo.id).phase, 'reviewing')
    assert.equal(get(ctx, todo.id).evidence.reviewInconclusiveRetries, 1)
    await endRun(ctx, todo.reviewSessionId, '')
    const cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateOwner, 'human')
    assert.equal(cur.gateKind, 'review_inconclusive')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('需修改')))
  } finally { ctx.cleanup() }
})

test('#47: the next review round of the card may ask again (the count is per review dispatch)', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    assert.equal(get(ctx, todo.id).gateKind, 'review_inconclusive')
    const again = await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    assert.equal(again.phase, 'reviewing')
    assert.equal(again.evidence.reviewInconclusiveRetries, 0, 'a new dispatch starts at zero')
    assert.equal(again.lastError, '')
    const runsBefore = ctx.calls.run
    await endRun(ctx, again.reviewSessionId, PROGRESS)
    assert.equal(ctx.calls.run, runsBefore + 1)
    assert.equal(get(ctx, todo.id).evidence.reviewInconclusiveRetries, 1)
  } finally { ctx.cleanup() }
})

test('#47: a stopped review turn is not asked again; the card waits for a person', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const runsBefore = ctx.calls.run
    await endRun(ctx, todo.reviewSessionId, PROGRESS, 'chat.run.stopped')
    const cur = get(ctx, todo.id)
    assert.equal(ctx.calls.run, runsBefore, 'a stop somebody asked for is not answered with a new run')
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateOwner, 'human')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 0)
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('需修改')))
  } finally { ctx.cleanup() }
})

test('#47: when the request for the verdict cannot be sent, the card goes to the human gate with the reason', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    ctx.flags.runError = new Error('host refused: session is gone')
    await endRun(ctx, todo.reviewSessionId, PROGRESS)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateOwner, 'human')
    assert.equal(cur.gateKind, 'review_inconclusive')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 0, 'a request that was never sent is not counted')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('host refused: session is gone')))
  } finally { ctx.cleanup() }
})

// ---- 3. a failed review run -------------------------------------------------------------------------------

test('#47: a review run that failed is review_failed, worded differently from a rejection, and is not rerun', async () => {
  const ctx = setup()
  try {
    const card = await reviewingCard(ctx)
    const { todo } = card
    const runsBefore = ctx.calls.run
    await endRun(ctx, todo.reviewSessionId, PROGRESS, 'chat.run.failed', { error: 'HTTP 529 overloaded' })
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'review_failed')
    assert.equal(cur.gateOwner, 'human')
    assert.equal(cur.gateKind, 'review_failed')
    assert.match(cur.lastError, /529/)
    assert.equal(ctx.calls.run, runsBefore, 'no request for a verdict and no Chief run')
    assert.equal(chiefWakes(ctx, card), card.wakesBefore, 'the Chief is neither run nor queued a wake')
    const lines = timeline(ctx, todo.id)
    assert.ok(lines.some(e => e.startsWith('审查运行失败')), 'the timeline names a failed run')
    assert.ok(!lines.some(e => e.includes('需修改')), 'not recorded as a rejection')
    assert.ok(!lines.some(e => e.startsWith('独立审查结论')), 'no verdict line: there was no verdict')
  } finally { ctx.cleanup() }
})

// ---- 4. what did not change -------------------------------------------------------------------------------

test('#47: VERDICT: CHANGES_REQUESTED still parks at the changes gate and wakes the Chief of an AUTO topic', async () => {
  const ctx = setup()
  try {
    const card = await reviewingCard(ctx)
    const { todo } = card
    await endRun(ctx, todo.reviewSessionId, '命名不清，缺一条用例。\nVERDICT: CHANGES_REQUESTED')
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'changes_requested')
    assert.equal(cur.gateKind, 'changes')
    assert.equal(cur.gateOwner, 'chief')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 0)
    assert.ok(timeline(ctx, todo.id).includes('独立审查结论：需修改'))
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(NUDGE_LINE)))
    assert.equal(chiefWakes(ctx, card), card.wakesBefore + 1, 'the Chief is woken for a real rejection')
    assert.equal(runsOf(ctx, todo.reviewSessionId).length, 1, 'the reviewer is not asked again')
  } finally { ctx.cleanup() }
})

test('#47: VERDICT: CHANGES_REQUESTED without AUTO is the user\'s gate, VERDICT: APPROVED is the merge gate', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx, { autopilot: false })
    await endRun(ctx, todo.reviewSessionId, 'VERDICT: CHANGES_REQUESTED\n命名不清。')
    let cur = get(ctx, todo.id)
    assert.equal(cur.gateKind, 'changes')
    assert.equal(cur.gateOwner, 'human')
    const again = await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    await endRun(ctx, again.reviewSessionId, '逻辑正确，测试充分。\nVERDICT: APPROVED')
    cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.gateKind, 'merge')
    assert.equal(cur.gateOwner, 'human')
    assert.equal(cur.lastError, '')
    assert.ok(timeline(ctx, todo.id).includes('独立审查结论：通过'))
  } finally { ctx.cleanup() }
})

// ---- 4b. #69 (C01): a negated APPROVED is not an approval --------------------------------------------------

test('#69 C01: a negated APPROVED (verdict line or bare token) is never approved', () => {
  for (const text of ['VERDICT: NOT APPROVED', 'not approved', '不能 APPROVED', '不 APPROVED']) {
    assert.notEqual(parse(text), 'approved', text)
  }
  // A verdict line that says it is not approved is a rejection; a negated bare token is asked again.
  assert.equal(parse('VERDICT: NOT APPROVED'), 'changes_requested')
  assert.equal(parse('问题见上。\nVERDICT：不予 APPROVED'), 'changes_requested')
  assert.equal(parse('not approved'), 'inconclusive')
  // A plain approval line after a negated one does not decide (like after a CHANGES_REQUESTED line).
  assert.equal(parse('VERDICT: NOT APPROVED\n修好后可改成\nVERDICT: APPROVED'), 'inconclusive')
})

test('#69 C01: the negation is looked for only right before the token, not in the whole text', () => {
  // #103: the bare word and a verdict that shares its line no longer approve at all (inconclusive).
  assert.equal(parse('Looks correct. APPROVED.'), 'inconclusive')
  assert.equal(parse('报告正文 not approved yet\nVERDICT: APPROVED'), 'approved')
  assert.equal(parse('审查结论：未通过\nVERDICT: CHANGES_REQUESTED'), 'changes_requested')
  // A negation in an earlier clause of the same line does not reach the token.
  assert.equal(parse('不需要修改，VERDICT: APPROVED'), 'inconclusive')
  assert.equal(parse('不需要修改。\nVERDICT: APPROVED'), 'approved')
  assert.equal(parse('No blocking issues; APPROVED.'), 'inconclusive')
})

test('#69 C01: a hard line break between the negation and the token does not hide the negation', () => {
  assert.notEqual(parse('not\napproved'), 'approved')
  assert.notEqual(parse('NOT\nAPPROVED'), 'approved')
  assert.notEqual(parse('这次改动\n不\nAPPROVED'), 'approved')
})

// ---- 4c. #69 (C03): a transcript that could not be read is not an empty reply -----------------------------

test('#69 C03: a failed first read of the review transcript writes nothing and uses no request for a verdict', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const realMessages = ctx.run.host.sessions.messages
    let failNext = true
    ctx.run.host.sessions.messages = async (...a) => {
      if (failNext) { failNext = false; throw new Error('host read failed') }
      return realMessages(...a)
    }
    const runsBefore = runsOf(ctx, todo.reviewSessionId).length
    await endRun(ctx, todo.reviewSessionId, '三处写点都核对过。\nVERDICT: APPROVED')
    let cur = get(ctx, todo.id)
    const nudgeRuns = runsOf(ctx, todo.reviewSessionId).length - runsBefore
    assert.equal(nudgeRuns, 0, 'no request for a verdict was sent')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 0, 'the one request is still available')
    assert.equal(cur.phase, 'reviewing', 'nothing was written: the next settle decides')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(NUDGE_LINE)))
    // The end is reported again (event re-delivery / the next tick): now it is read and settles.
    await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: todo.reviewSessionId, finish_reason: 'stop' } }, ctx.run)
    cur = get(ctx, todo.id)
    assert.equal(runsOf(ctx, todo.reviewSessionId).length - runsBefore, 0)
    assert.notEqual(cur.evidence.reviewVerdict, 'inconclusive')
    assert.notEqual(cur.gateKind, 'review_inconclusive')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.gateKind, 'merge')
  } finally { ctx.cleanup() }
})

test('#69 C03: after a failed first read, the next tick (reconcileActiveRuns) settles the verdict', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const realMessages = ctx.run.host.sessions.messages
    let failNext = true
    ctx.run.host.sessions.messages = async (...a) => {
      if (failNext) { failNext = false; throw new Error('host read failed') }
      return realMessages(...a)
    }
    const runsBefore = runsOf(ctx, todo.reviewSessionId).length
    await endRun(ctx, todo.reviewSessionId, '三处写点都核对过。\nVERDICT: APPROVED')
    assert.equal(get(ctx, todo.id).phase, 'reviewing')
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const cur = get(ctx, todo.id)
    assert.equal(runsOf(ctx, todo.reviewSessionId).length - runsBefore, 0)
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.gateKind, 'merge')
  } finally { ctx.cleanup() }
})

test('#69 C03: a stopped review whose transcript cannot be read still goes to the human gate, not asked again', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const realMessages = ctx.run.host.sessions.messages
    let failNext = true
    ctx.run.host.sessions.messages = async (...a) => {
      if (failNext) { failNext = false; throw new Error('host read failed') }
      return realMessages(...a)
    }
    const runsBefore = runsOf(ctx, todo.reviewSessionId).length
    await endRun(ctx, todo.reviewSessionId, PROGRESS, 'chat.run.stopped')
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const cur = get(ctx, todo.id)
    assert.equal(runsOf(ctx, todo.reviewSessionId).length - runsBefore, 0, 'a stop is not answered with a request')
    assert.equal(cur.gateKind, 'review_inconclusive')
    assert.equal(cur.evidence.reviewInconclusiveRetries, 0)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('审查被停止')))
  } finally { ctx.cleanup() }
})

test('#69 C03 guard: a transcript that was read and is empty still takes the request for a verdict', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const runsBefore = runsOf(ctx, todo.reviewSessionId).length
    await endRun(ctx, todo.reviewSessionId, '')
    const cur = get(ctx, todo.id)
    assert.equal(runsOf(ctx, todo.reviewSessionId).length - runsBefore, 1)
    assert.equal(cur.evidence.reviewInconclusiveRetries, 1)
  } finally { ctx.cleanup() }
})

// ---- 5. documents ------------------------------------------------------------------------------------------

test('#47: the new evidence key, verdict values and gate kinds are documented; one 0.9.49 changelog section', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const contracts = read('docs/CONTRACTS.md')
  for (const word of ['reviewInconclusiveRetries', '`inconclusive`', '`review_failed`', '`review_inconclusive`', NUDGE_LINE, HUMAN_LINE, 'full-width']) {
    assert.ok(contracts.includes(word), `CONTRACTS.md names ${word}`)
  }
  const changelog = read('CHANGELOG.md')
  assert.equal(changelog.split('## [0.9.49]').length - 1, 1, 'exactly one 0.9.49 heading')
  const section = changelog.slice(changelog.indexOf('## [0.9.49]'), changelog.indexOf('## [0.9.48]'))
  assert.ok(section.includes('reviewInconclusiveRetries'))
  assert.ok(section.includes(HUMAN_LINE))
})

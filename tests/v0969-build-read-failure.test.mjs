// #71 — a transcript that could not be read is not an empty reply, on the build side too (#69 fixed only the
// review side), and a card whose transcript keeps failing to read says so on its timeline instead of sitting
// silently in `building` / `reviewing`.
//
// New file rather than an addition to v0949: the build-side cases need the v0957 build harness (worktree,
// commits, tool-call rounds), the v0949 file is the review harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'

// ---- harness (v0957 build harness + targeted read failures) ----------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-v0969-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const warnings = []
  const log = { warn(msg, meta) { warnings.push({ msg, meta }) }, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, inputs: [], sessions: [] }
  // failReads: { [sessionId]: n } — the next n reads of that session's transcript throw.
  const flags = { failReads: {} }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { calls.create += 1; const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        calls.run += 1
        calls.inputs.push(String(input))
        calls.sessions.push(id)
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) {
        if (flags.failReads[id] > 0) { flags.failReads[id] -= 1; throw new Error('host transcript read failed') }
        return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false }
      },
      async connect(id, cb) {
        const timer = setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(sessions.get(id)?.is_running), runStartedAt: 0, queueLength: 0 }), 0)
        return { close() { clearTimeout(timer) } }
      },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {}, notify() {} } }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, calls, flags, sessions, warnings, cleanup }
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim()

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
  return repoPath
}

const ONE = [{ id: 'cfg-1', label: '主力', engine: 'codex', mode: 'global', provider: 'p1', model: 'model-one', reasoningEffort: 'high' }]

async function buildingTodo(ctx) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '读失败测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: ONE })
  const agent = db.listAgents(1, 'default').find(a => a.name === '读失败测试 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id, withPlan: false })
  assert.equal(built.phase, 'building')
  assert.ok(built.worktreePath && existsSync(built.worktreePath), 'worktree exists')
  return { todo: built, project, topic }
}

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const NOTE_RE = /会话记录连续 3 次读取失败/
const nudgeLines = (ctx, id) => timeline(ctx, id).filter(e => /已在同一会话催促|审查未给出结论，已要求它收口/.test(e))

// A real worker round: tool calls, then a final reply. The host event says the run completed.
function finishRound(ctx, sessionId, text, tools = 3) {
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  const ts = Math.floor(Date.now() / 1000)
  for (let i = 0; i < tools; i += 1) {
    s.messages.push({ id: `tc-${s.messages.length}`, role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'terminal', arguments: '{}' } }], timestamp: ts })
    s.messages.push({ id: `tr-${s.messages.length}`, role: 'tool', content: 'ok', timestamp: ts })
  }
  if (text) s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: text, finish_reason: 'stop', timestamp: ts })
}
const completed = (ctx, sessionId) => ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)

// The worker's real reply: no new commit this round, but a report with commit ids and exit codes (0.9.66
// sends it to acceptance). Read as empty, the same round is idle: rerun / failed.
const REPORT = '这一轮不需要新提交：任务书里的改动已经在提交 `5b37aa4`（实现）和 `827d2cb`（用例）里，共 6 个文件，+858 / −5。\n\n'
  + '**已核对**\n- `git status --porcelain` 为空，工作树干净。\n- 完整门禁：`npm test; echo GATE_RC=$?` 结果 `GATE_RC=0`，822 条全部通过。\n'
  + '- 接口在 `src/server/api.mjs` 第 378 和 386 行。\n\n**结论**：请按上面的提交号和 `GATE_RC=0` 验收。'

/* ── A. build side: unreadable ≠ empty ─────────────────────────────────────────────────────────── */

test('#71 A: a build transcript that could not be read is not settled as an idle round (no nudge, no failure); the next tick settles it', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const sid = todo.buildSessionId
    const runs = ctx.calls.run
    const creates = ctx.calls.create
    finishRound(ctx, sid, REPORT)
    ctx.flags.failReads[sid] = 1
    await completed(ctx, sid)
    let card = get(ctx, todo.id)
    assert.equal(card.phase, 'building', 'still building: waits for a readable transcript')
    assert.equal(card.buildSessionId, sid, 'same build session')
    assert.notEqual(card.gateKind, 'failed')
    assert.ok(!card.lastError, 'nothing written as an error')
    assert.equal(Number(card.evidence?.idleNudges) || 0, 0, 'no nudge spent')
    assert.equal(Number(card.evidence?.idleRetries) || 0, 0, 'no idle rerun spent')
    assert.equal(ctx.calls.run, runs, 'no run was started (no nudge, no rerun)')
    assert.equal(ctx.calls.create, creates, 'no new session')
    assert.deepEqual(nudgeLines(ctx, todo.id), [])
    assert.ok(!timeline(ctx, todo.id).some(e => /没有产生任何提交|空转|构建失败/.test(e)), 'not written as idle or failed')
    assert.ok(ctx.warnings.some(w => /could not be read/.test(w.msg) && w.meta?.todoId === todo.id), 'the deferral is logged')
    // Next tick: the transcript reads, and the round settles as what it was — a report with evidence.
    await ctx.orch.reconcileActiveRuns(ctx.run)
    card = get(ctx, todo.id)
    assert.equal(card.phase, 'review')
    assert.equal(card.gateKind, 'deliverable')
    assert.match(card.evidence.deliverable, /5b37aa4/)
    assert.equal(ctx.calls.run, runs, 'settled without a nudge')
  } finally { ctx.cleanup() }
})

test('#71 A: a round with real commits whose transcript could not be read waits, then hands the worker report over', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const sid = todo.buildSessionId
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'feature\n')
    git(todo.worktreePath, 'commit', '-am', 'feature')
    finishRound(ctx, sid, '已实现 a.txt 并提交 feature，门禁 rc=0。')
    ctx.flags.failReads[sid] = 1
    await completed(ctx, sid)
    assert.equal(get(ctx, todo.id).phase, 'building', 'not settled on an unreadable transcript')
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const card = get(ctx, todo.id)
    assert.equal(card.phase, 'review')
    assert.equal(card.gateKind, 'merge')
    assert.match(card.evidence.workerReport, /已实现 a\.txt/, 'the worker report travels with the card')
  } finally { ctx.cleanup() }
})

test('#71 A: a stopped build round is settled now even when its transcript cannot be read (the stop is not deferred)', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const sid = todo.buildSessionId
    const runs = ctx.calls.run
    finishRound(ctx, sid, '先看一下代码。', 0)
    ctx.flags.failReads[sid] = 1
    await ctx.orch.handleHostEvent({ type: 'chat.run.stopped', data: { session_id: sid } }, ctx.run)
    const card = get(ctx, todo.id)
    assert.notEqual(card.phase, 'building', 'the stop is settled with this event')
    assert.equal(ctx.calls.run, runs, 'a stop is never answered with a new run')
  } finally { ctx.cleanup() }
})

/* ── B. read failures in a row are written on the card ─────────────────────────────────────────── */

test('#71 B: 3 failed reads in a row of a build transcript write one timeline line; the card is not failed', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const sid = todo.buildSessionId
    finishRound(ctx, sid, REPORT)
    ctx.flags.failReads[sid] = 99
    await completed(ctx, sid)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.ok(!timeline(ctx, todo.id).some(e => NOTE_RE.test(e)), 'two failures: nothing on the card yet')
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const lines = timeline(ctx, todo.id).filter(e => NOTE_RE.test(e))
    assert.equal(lines.length, 1, 'the third failure writes the line')
    assert.match(lines[0], /仍未结算.*下一次调度重试/)
    assert.ok(ctx.warnings.some(w => /3 reads in a row/.test(w.msg)), 'logged too')
    await ctx.orch.reconcileActiveRuns(ctx.run)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(timeline(ctx, todo.id).filter(e => NOTE_RE.test(e)).length, 1, 'written once, not on every tick')
    const card = get(ctx, todo.id)
    assert.equal(card.phase, 'building')
    assert.ok(!card.lastError, 'no error before the long threshold')
    // Recovery: settles normally.
    ctx.flags.failReads[sid] = 0
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'review')
  } finally { ctx.cleanup() }
})

test('#71 B: 30 failed reads in a row put the reason in lastError without failing the card; a later read clears it and settles', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const sid = todo.buildSessionId
    finishRound(ctx, sid, REPORT)
    ctx.flags.failReads[sid] = 999
    await completed(ctx, sid)
    for (let i = 0; i < 28; i += 1) await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.ok(!get(ctx, todo.id).lastError, '29 failures: no lastError yet')
    await ctx.orch.reconcileActiveRuns(ctx.run)
    let card = get(ctx, todo.id)
    assert.equal(card.phase, 'building', 'never turned into failed')
    assert.match(card.lastError, /会话记录连续 30 次读取失败/)
    assert.ok(timeline(ctx, todo.id).some(e => /会话记录连续 30 次读取失败/.test(e)))
    ctx.flags.failReads[sid] = 0
    await ctx.orch.reconcileActiveRuns(ctx.run)
    card = get(ctx, todo.id)
    assert.equal(card.phase, 'review')
    assert.ok(!card.lastError, 'the read-failure error is cleared once the transcript reads')
  } finally { ctx.cleanup() }
})

test('#71 B: 3 failed reads in a row of a review transcript write the line too (the card no longer sits silently in reviewing)', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'feature\n')
    git(todo.worktreePath, 'commit', '-am', 'feature')
    finishRound(ctx, todo.buildSessionId, '已实现并提交。', 0)
    await completed(ctx, todo.buildSessionId)
    assert.equal(get(ctx, todo.id).phase, 'review')
    const reviewing = await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    assert.equal(reviewing.phase, 'reviewing')
    const rsid = reviewing.reviewSessionId
    finishRound(ctx, rsid, 'VERDICT: APPROVED', 0)
    ctx.flags.failReads[rsid] = 3
    await completed(ctx, rsid)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const card = get(ctx, todo.id)
    assert.equal(card.phase, 'reviewing')
    assert.equal(timeline(ctx, todo.id).filter(e => NOTE_RE.test(e)).length, 1)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).evidence.reviewVerdict, 'approved', 'settles once readable')
  } finally { ctx.cleanup() }
})

/* ── C. a transcript read as empty is still an empty round ─────────────────────────────────────── */

test('#71 C: a transcript that reads fine but holds no reply is still settled as an idle round now', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const sid = todo.buildSessionId
    finishRound(ctx, sid, '', 0)
    await completed(ctx, sid)
    const card = get(ctx, todo.id)
    const settledAsIdle = card.phase === 'failed' || card.buildSessionId !== sid || Number(card.evidence?.idleRetries) > 0
    assert.ok(settledAsIdle, `settled as idle now (phase=${card.phase})`)
    assert.ok(timeline(ctx, todo.id).some(e => /没有产生任何提交/.test(e)), 'written as an idle round')
    assert.ok(!timeline(ctx, todo.id).some(e => /读取失败/.test(e)))
  } finally { ctx.cleanup() }
})

/* ── D. a settled card starts counting from zero ───────────────────────────────────────────────── */

test('#71 D: a read that succeeds and settles resets the count; a single later failure does not reach the threshold', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const sid = todo.buildSessionId
    finishRound(ctx, sid, REPORT)
    ctx.flags.failReads[sid] = 2
    await completed(ctx, sid)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'building', 'two failures: still waiting')
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'review', 'third reading succeeds and settles')
    // A new round on the same card (same build session).
    await ctx.orch.messageTodo(ctx.run, { todoId: todo.id, note: '再核一遍门禁' })
    const again = get(ctx, todo.id)
    assert.equal(again.phase, 'building')
    finishRound(ctx, again.buildSessionId, REPORT)
    ctx.flags.failReads[again.buildSessionId] = 1
    await completed(ctx, again.buildSessionId)
    assert.equal(get(ctx, todo.id).phase, 'building')
    assert.ok(!timeline(ctx, todo.id).some(e => NOTE_RE.test(e)), 'one failure after a settle is failure 1, not 3')
  } finally { ctx.cleanup() }
})

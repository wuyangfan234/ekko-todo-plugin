// 0.9.58 — absorbed from mature multi-agent frameworks (no restructuring): the supervisor gets the worker's
// own final message with the hand-back notice (LangGraph supervisor output_mode, OpenAI Agents SDK agents-as-
// tools). Evidence: on a real board 18 of 27 Chief wakes began with get_todo_conversation just to read it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { buildAutomatedWakePrompt, consecutiveFailedRounds } from '../src/server/prompts.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-v0958-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, inputs: [], options: [], sessions: [] }
  // onStop: called inside sessions.stop (the host reports the stop before stop() returns).
  // createFails: sessions.create rejects. alreadyRunning: sessions.run is refused as "already running".
  const flags = { onStop: null, createFails: false, alreadyRunning: false }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request(path) { return path === '/api/hermes/available-models' && flags.catalog ? flags.catalog : null },
    sessions: {
      async create(input) { if (flags.createFails) throw new Error('host refused to create a session'); calls.create += 1; const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input, options) {
        calls.run += 1
        calls.inputs.push(String(input))
        calls.options.push(options || {})
        calls.sessions.push(id)
        if (flags.alreadyRunning) throw new Error('Session ' + id + ' is already running')
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; if (flags.onStop) await flags.onStop(id); return { ok: true } },
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
  // The test gate appends one line to a file outside the repo: its line count is how often the gate ran.
  const gateLog = join(root, 'gate.log')
  return { root, db, orch, run, calls, flags, sessions, cleanup, gateLog }
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
const TWO = [...ONE, { id: 'cfg-2', label: '备选', engine: 'codex', mode: 'global', provider: 'p2', model: 'model-two', reasoningEffort: 'high' }]

async function buildingTodo(ctx, { configs = ONE, autoFallback = true, withPlan = false, kind, title = 'T', autopilot = false, engine = 'codex', systemPrompt } = {}) {
  const { root, db, orch, run, gateLog } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '空转测试 Agent', role: 'builder', engine, autoFallback, modelConfigs: configs, ...(systemPrompt !== undefined ? { systemPrompt } : {}) })
  const agent = db.listAgents(1, 'default').find(a => a.name === '空转测试 Agent')
  assert.ok(agent, 'agent saved')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: `echo ran >> "${gateLog}"` })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title, kind, agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id, withPlan })
  assert.equal(built.phase, 'building')
  assert.ok(built.worktreePath && existsSync(built.worktreePath), 'worktree exists')
  return { todo: built, agent, project, topic }
}

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const gateRuns = ctx => (existsSync(ctx.gateLog) ? readFileSync(ctx.gateLog, 'utf8').split('\n').filter(Boolean).length : 0)

// The worker's turn ends normally (finish_reason=stop) with a last assistant line, as in the real incident.
async function completeOnce(ctx, todoId, text) {
  const sessionId = get(ctx, todoId).buildSessionId
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: text, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)
  return get(ctx, todoId)
}

// 0.9.57: an idle round that answered with words is first resumed once in the same session ("keep going").
// These tests are about what happens when the worker still does nothing: the nudged round idles too.
// `ctx.calls.nudges` counts the nudges so run counts can be compared without them.
async function complete(ctx, todoId, text = 'Base is current. Now set up the plan and read code.') {
  let after = await completeOnce(ctx, todoId, text)
  const nudged = () => after.phase === 'building' && /已在同一会话催促它实际执行/.test(after.timeline.at(-2)?.event || after.timeline.at(-1)?.event || '')
  if (nudged()) {
    ctx.calls.nudges = (ctx.calls.nudges || 0) + 1
    after = await completeOnce(ctx, todoId, text)
  }
  return after
}


const WORKER_REPORT = '已完成：tokens.css 落地并接入 shell.css。\n- 改动 3 个文件，提交 a1b2c3d\n- 门禁 ./scripts/test.sh rc=0\n- 未验证：375px 真机'

// The Chief's own session, so wakes are really launched and their text can be read.
function attachChief(ctx, topicId) {
  ctx.sessions.set('sess-chief', { id: 'sess-chief', messages: [], is_running: false })
  ctx.db.updateTopic(1, 'default', topicId, { chiefSessionId: 'sess-chief', isRunning: false })
}
const wakes = ctx => ctx.calls.inputs.filter((_, i) => ctx.calls.sessions[i] === 'sess-chief')

test('0.9.58: the worker\'s final reply of the round reaches the Chief in the wake, no conversation read needed', async () => {
  const ctx = setup()
  try {
    const { todo, topic } = await buildingTodo(ctx, { autopilot: true })
    attachChief(ctx, topic.id)
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'changed\n')
    git(todo.worktreePath, 'commit', '-am', 'work')
    const after = await completeOnce(ctx, todo.id, WORKER_REPORT)
    assert.equal(after.phase, 'review')
    assert.equal(after.evidence.workerReport, WORKER_REPORT)
    const wake = wakes(ctx).at(-1)
    assert.ok(wake, 'the Chief was woken')
    assert.match(wake, /Worker's final report \(this round\):/)
    assert.match(wake, /  > - 门禁 \.\/scripts\/test\.sh rc=0/)
    assert.doesNotMatch(wake, /First inspect the latest output via get_todo_conversation/)
  } finally { ctx.cleanup() }
})

test('0.9.58: a failed (idle) round hands back what the worker said, and a new dispatch clears it', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    await completeOnce(ctx, todo.id, '我会先读 tokens.css 再改。')
    const failed = await completeOnce(ctx, todo.id, '接下来改 shell.css，然后提交。')
    assert.equal(failed.phase, 'failed')
    assert.equal(failed.evidence.workerReport, '接下来改 shell.css，然后提交。')
    const again = await ctx.orch.startBuild(ctx.run, { todoId: todo.id })
    assert.equal(again.evidence.workerReport, '', 'an old round\'s report is not shown as the new one\'s')
  } finally { ctx.cleanup() }
})

test('0.9.58: review findings are quoted in the wake; long reports are cut and marked', () => {
  const base = { id: 'td-1', number: 3, title: 'T', phase: 'review', gateOwner: 'chief', gateKind: 'changes', lastError: '', question: {}, timeline: [] }
  const findings = '缺少 375px 用例。\nVERDICT: CHANGES_REQUESTED'
  const wake = buildAutomatedWakePrompt({ topic: { autopilot: true }, todo: { ...base, evidence: { reviewVerdict: 'changes_requested', reviewSummary: findings, workerReport: 'x' } }, project: { name: 'P', autopilot: {} }, reason: 'review_changes', recentDigest: [] })
  assert.match(wake, /Review findings \(full\):\n  > 缺少 375px 用例。/)
  assert.match(wake, /findings are quoted above/)
  const long = 'r'.repeat(3000)
  const w2 = buildAutomatedWakePrompt({ topic: { autopilot: true }, todo: { ...base, gateKind: 'merge', evidence: { workerReport: long, reviewVerdict: 'none' } }, project: { name: 'P', autopilot: {} }, reason: 'build_completed', recentDigest: [] })
  assert.match(w2, /cut at 3000 chars/)
  assert.doesNotMatch(w2, /Review findings/, 'no findings without a verdict')
  // A text card's report is already in the wake as the deliverable: not repeated.
  const w3 = buildAutomatedWakePrompt({ topic: { autopilot: true }, todo: { ...base, gateKind: 'deliverable', evidence: { deliverable: 'D'.repeat(50), workerReport: 'D'.repeat(50) } }, project: { name: 'P', autopilot: {} }, reason: 'deliverable_ready', recentDigest: [] })
  assert.doesNotMatch(w3, /Worker's final report/)
})

test('0.9.58: tool output rows in the build conversation are labelled as tool results, not instructions', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const s = ctx.sessions.get(todo.buildSessionId)
    s.messages.push({ id: 't-1', role: 'tool', content: '{"output":"GATE_RC=0"}' })
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'changed\n')
    git(todo.worktreePath, 'commit', '-am', 'work')
    const after = await completeOnce(ctx, todo.id, '完成')
    const row = after.buildChat.find(m => m.text.includes('GATE_RC=0'))
    assert.equal(row.role, '工具结果')
    assert.ok(after.buildChat.some(m => m.role === '任务指令'), 'the instruction itself keeps its label')
  } finally { ctx.cleanup() }
})

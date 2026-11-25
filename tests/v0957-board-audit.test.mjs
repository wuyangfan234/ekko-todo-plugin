// 0.9.57 — audit of a real board (topic 天机阁项目): why cards kept failing, and every judging rule that
// failed correct work. Each test names the incident it pins down.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { buildAutomatedWakePrompt, consecutiveFailedRounds } from '../src/server/prompts.mjs'
import { checkModelInCatalog, normalizeModelRef } from '../src/shared/model-ref.mjs'
import { classifyChiefTool } from '../src/shared/chief-guard.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-v0957-'))
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


const REPORT = '## 部署结果\n目标 NAS 18340，已上传 dist 并写入 .deployed-commit=f64f2e7。\n验证：curl http://nas:18340/ 返回 200，页面含新首页标题。'
const FAILED_TURN = 'Your request was not processed. Send it again if you still want me to carry it out.'
const CATALOG = { groups: [
  { provider: 'kimi-coding', label: 'Kimi', models: ['k3.1-pro'] },
  { provider: 'custom:magpie-jp', label: 'magpie', models: ['kiro/claude-opus-5.5', 'claude/claude-opus-5-5'] },
] }
const HERMES = [{ id: 'cfg-1', label: '首选', engine: 'hermes', mode: 'scoped', provider: 'kimi-coding', model: 'k3.1-pro', reasoningEffort: 'high' }]

async function endWith(ctx, todoId, msg) {
  const sid = get(ctx, todoId).buildSessionId
  const s = ctx.sessions.get(sid)
  s.is_running = false
  s.messages.push({ id: `a-${s.messages.length}`, timestamp: Math.floor(Date.now() / 1000), ...msg })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid, finish_reason: 'stop' } }, ctx.run)
  return get(ctx, todoId)
}

/* ── model names ─────────────────────────────────────────────────────────────────────────────── */

test('0.9.57: provider repeated in the model id and `custom` + `custom:<pool>/…` are normalized', () => {
  assert.deepEqual(normalizeModelRef({ provider: 'kimi-coding', model: 'kimi-coding/k3.1-pro' }), { provider: 'kimi-coding', model: 'k3.1-pro' })
  assert.deepEqual(normalizeModelRef({ provider: 'kimi-coding', model: 'kimi-coding/kimi-coding/k3.1-pro' }), { provider: 'kimi-coding', model: 'k3.1-pro' })
  assert.deepEqual(normalizeModelRef({ provider: 'custom', model: 'custom:magpie-jp/kiro/claude-opus-5.5' }), { provider: 'custom:magpie-jp', model: 'kiro/claude-opus-5.5' })
  assert.deepEqual(normalizeModelRef({ provider: '', model: 'custom:claude.example/claude-opus-5-5' }), { provider: 'custom:claude.example', model: 'claude-opus-5-5' })
  assert.deepEqual(normalizeModelRef({ provider: 'custom:magpie-jp', model: 'kiro/claude-opus-5.5' }), { provider: 'custom:magpie-jp', model: 'kiro/claude-opus-5.5' }, 'a valid pair is untouched')
  const cat = { status: 'ready', models: [{ provider: 'kimi-coding', id: 'k3.1-pro' }] }
  assert.equal(checkModelInCatalog(cat, { provider: 'kimi-coding', model: 'k3.1-pro' }).ok, true)
  assert.deepEqual(checkModelInCatalog(cat, { provider: 'kimi-coding', model: 'k9' }), { known: true, ok: false, suggestions: [] })
  assert.equal(checkModelInCatalog({ status: 'empty', models: [] }, { provider: 'x', model: 'y' }).known, false, 'no catalog: no verdict')
})

test('0.9.57: configure_agent stores the normalized pair and refuses a model the host does not serve', async () => {
  const ctx = setup()
  try {
    ctx.flags.catalog = CATALOG
    const { agent } = await ctx.orch.saveAgent(ctx.run, { name: '天机主程', role: 'builder', engine: 'hermes', modelConfigs: [{ id: 'c1', engine: 'hermes', provider: 'kimi-coding', model: 'kimi-coding/k3.1-pro' }] })
    assert.equal(agent.modelConfigs[0].model, 'k3.1-pro')
    const pooled = await ctx.orch.saveAgent(ctx.run, { id: agent.id, provider: 'custom', model: 'custom:magpie-jp/kiro/claude-opus-5.5', modelConfigs: [{ id: 'c1', engine: 'hermes', provider: 'custom', model: 'custom:magpie-jp/kiro/claude-opus-5.5' }] })
    assert.equal(pooled.agent.modelConfigs[0].provider, 'custom:magpie-jp')
    assert.equal(pooled.agent.modelConfigs[0].model, 'kiro/claude-opus-5.5')
    await assert.rejects(
      ctx.orch.saveAgent(ctx.run, { id: agent.id, modelConfigs: [{ id: 'c1', engine: 'hermes', provider: 'kimi-coding', model: 'k3.1-pro' }, { id: 'c2', engine: 'hermes', provider: 'custom:magpie-jp', model: 'opus-6' }] }),
      /不在 Studio 可用模型目录中.*备选 #1 custom:magpie-jp\/opus-6/,
    )
    assert.equal(ctx.db.getAgent(1, 'default', agent.id).modelConfigs[0].provider, 'custom:magpie-jp', 'a refused save writes nothing')
  } finally { ctx.cleanup() }
})

test('0.9.57: a config stored before the fix is cleaned when the run starts (no 404 from a doubled prefix)', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { engine: 'hermes', configs: HERMES })
    // Written straight to the store, as configure_agent did before 0.9.57.
    const agent = ctx.db.getAgent(1, 'default', todo.agentId)
    ctx.db.upsertAgent(1, 'default', { ...agent, modelConfigs: [{ ...HERMES[0], model: 'kimi-coding/k3.1-pro' }] })
    assert.equal(ctx.db.getAgent(1, 'default', todo.agentId).modelConfigs[0].model, 'kimi-coding/k3.1-pro')
    await ctx.orch.startBuild(ctx.run, { todoId: todo.id, extraMessage: '继续' })
    const opts = ctx.calls.options.at(-1)
    assert.equal(opts.model, 'k3.1-pro')
    assert.equal(opts.provider, 'kimi-coding')
    void todo
  } finally { ctx.cleanup() }
})

/* ── launch ──────────────────────────────────────────────────────────────────────────────────── */

test('0.9.57: an agent without a system prompt is launched without an `instructions` key (host refused undefined)', async () => {
  const ctx = setup()
  try {
    await buildingTodo(ctx, { systemPrompt: '' })
    const opts = ctx.calls.options.at(-1)
    assert.equal(Object.prototype.hasOwnProperty.call(opts, 'instructions'), false)
    const src = readFileSync(new URL('../src/server/orchestrator.mjs', import.meta.url), 'utf8')
    assert.equal((src.match(/systemPrompt \|\| undefined/g) || []).length, 0, 'no launch passes undefined instructions')
  } finally { ctx.cleanup() }
})

/* ── failure diagnosis ───────────────────────────────────────────────────────────────────────── */

test('0.9.57: a failed run whose model is not in the catalog says so instead of "empty reply"', async () => {
  const ctx = setup()
  try {
    ctx.flags.catalog = CATALOG
    const { todo } = await buildingTodo(ctx, { engine: 'hermes', configs: HERMES })
    // The agent is changed under the card to a model the host does not serve (stored before 0.9.57).
    ctx.db.upsertAgent(1, 'default', { ...ctx.db.getAgent(1, 'default', todo.agentId), modelConfigs: [{ ...HERMES[0], model: 'k9-pro' }] })
    const sid = get(ctx, todo.id).buildSessionId
    ctx.sessions.get(sid).messages.push({ id: 'ft', role: 'assistant', display_kind: 'failed_turn', content: FAILED_TURN })
    ctx.sessions.get(sid).is_running = false
    await ctx.orch.handleHostEvent({ type: 'chat.run.failed', data: { session_id: sid } }, ctx.run)
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.match(after.lastError, /k9-pro 不在 Studio 可用模型目录中/)
    assert.doesNotMatch(after.lastError, /空响应/)
  } finally { ctx.cleanup() }
})

test('0.9.57: the host failed-turn row is never a deliverable, and without a catalog verdict it is named', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研 X' })
    // The failed-turn notice is long enough to pass for a report; it must not be delivered.
    const after = await endWith(ctx, todo.id, { role: 'assistant', content: FAILED_TURN })
    assert.notEqual(after.gateKind, 'deliverable')
    assert.ok(!after.evidence.deliverable)
  } finally { ctx.cleanup() }
})

/* ── idle rounds ─────────────────────────────────────────────────────────────────────────────── */

test('0.9.57: a round that only announced its plan is resumed once in the same session, then fails', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const sid = todo.buildSessionId
    const runs = ctx.calls.run
    const creates = ctx.calls.create
    const nudged = await completeOnce(ctx, todo.id, '改用已构建 dist 与标准库静态服务取证；先提交脚本再运行。')
    assert.equal(nudged.phase, 'building', 'not failed yet')
    assert.equal(nudged.buildSessionId, sid, 'same session')
    assert.equal(ctx.calls.create, creates, 'no new session')
    assert.equal(ctx.calls.run, runs + 1)
    assert.match(ctx.calls.inputs.at(-1), /平台自动催促.*git commit/s)
    assert.equal(nudged.evidence.idleNudges, 1)
    assert.ok(timeline(ctx, todo.id).some(e => /已在同一会话催促它实际执行（1\/1）/.test(e)))
    const failed = await completeOnce(ctx, todo.id, '好的，我这就去提交。')
    assert.equal(failed.phase, 'failed')
    assert.match(failed.lastError, /没有产生任何提交/)
    // Once nudged, the nudged round's success path: a fresh dispatch starts with a fresh allowance.
    const again = await ctx.orch.startBuild(ctx.run, { todoId: todo.id })
    assert.equal(again.evidence.idleNudges, 0)
  } finally { ctx.cleanup() }
})

test('0.9.57: the nudged round that commits reaches review, and a productive round restores the idle rerun', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { configs: TWO })
    ctx.db.updateTodo(1, 'default', todo.id, { evidence: { idleRetries: 1 } })
    await completeOnce(ctx, todo.id, '接下来先改 a.txt，然后提交。')
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'changed\n')
    git(todo.worktreePath, 'commit', '-am', 'work')
    const after = await completeOnce(ctx, todo.id, '已提交 a.txt，测试通过。')
    assert.equal(after.phase, 'review')
    assert.equal(after.evidence.idleRetries, 0)
  } finally { ctx.cleanup() }
})

test('0.9.57: a deploy card that ran the deployment and reported it is delivered for acceptance, not failed', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'deploy', title: 'deploy(tianji): 阶段一上线 NAS 18340', autopilot: true })
    const after = await completeOnce(ctx, todo.id, REPORT)
    assert.equal(after.phase, 'review')
    assert.equal(after.gateKind, 'deliverable')
    assert.equal(after.gateOwner, 'human', 'deploy redline: a person accepts the deploy in AUTO too')
    assert.equal(after.evidence.deliverable, REPORT)
    assert.ok(timeline(ctx, todo.id).some(e => /部署已执行，未改仓库代码/.test(e)))
    assert.equal(gateRuns(ctx), 0)
  } finally { ctx.cleanup() }
})

test('0.9.57: a text card whose branch already has commits is not settled as text (commits would be lost)', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研并写报告' })
    writeFileSync(join(todo.worktreePath, 'report.md'), REPORT)
    git(todo.worktreePath, 'add', '.'); git(todo.worktreePath, 'commit', '-m', 'report')
    const first = await completeOnce(ctx, todo.id, REPORT)
    assert.equal(first.gateKind, 'merge')
    // A later round that changes nothing but reports again: still the merge gate, report attached.
    await ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, extraMessage: '再补一句结论' })
    const second = await completeOnce(ctx, todo.id, REPORT + '\n补充结论。')
    assert.equal(second.phase, 'review')
    assert.equal(second.gateKind, 'merge')
    assert.equal(second.evidence.filesChanged, 1)
    assert.match(second.evidence.deliverable, /补充结论/)
  } finally { ctx.cleanup() }
})

test('0.9.57: a planning round with no plan is nudged once, then fails instead of asking to approve nothing', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { withPlan: true })
    const nudged = await completeOnce(ctx, todo.id, '好')
    assert.equal(nudged.phase, 'building')
    assert.match(ctx.calls.inputs.at(-1), /没有给出实施方案/)
    const failed = await completeOnce(ctx, todo.id, '好')
    assert.equal(failed.phase, 'failed')
    assert.match(failed.lastError, /没有给出实施方案/)
  } finally { ctx.cleanup() }
})

/* ── chief ───────────────────────────────────────────────────────────────────────────────────── */

test('0.9.57: the Chief guard treats skill_manage / cronjob_manage as writes and browser_cdp as execution', () => {
  assert.equal(classifyChiefTool('skill_manage'), 'write')
  assert.equal(classifyChiefTool('mcp__magpie__skill_manage'), 'write')
  assert.equal(classifyChiefTool('cronjob_manage'), 'write')
  assert.equal(classifyChiefTool('browser_cdp'), 'execute')
  assert.equal(classifyChiefTool('skill_view'), 'read')
})

test('0.9.57: message_todo from the Chief is recorded as the Chief, not the user', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    await completeOnce(ctx, todo.id, 'x')
    await completeOnce(ctx, todo.id, 'x')
    await ctx.orch.messageTodo(ctx.run, { todoId: todo.id, note: '继续', caller: 'chief' })
    const tl = get(ctx, todo.id).timeline
    assert.ok(tl.some(e => e.event === '总管发送补充指令' && e.actor === 'chief'))
    const mcp = readFileSync(new URL('../src/server/mcp-tools.mjs', import.meta.url), 'utf8')
    assert.match(mcp, /messageTodo\(run, \{ todoId: input\.todo_id, note: input\.message, caller: 'chief' \}\)/)
  } finally { ctx.cleanup() }
})

test('0.9.57: the wake for a card that failed several rounds in a row tells the Chief not to re-dispatch unchanged', () => {
  const tl = ['派发构建', '构建失败：a', '派发构建', '构建完成（1 文件）', '派发构建', '构建失败：b', '派发构建', '构建失败：c'].map(event => ({ event }))
  assert.equal(consecutiveFailedRounds({ timeline: tl }), 2)
  const todo = { id: 'td-1', number: 13, title: 'T', phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError: 'x', evidence: {}, question: {}, timeline: tl }
  const wake = buildAutomatedWakePrompt({ topic: { autopilot: true }, todo, project: { name: 'P', autopilot: {} }, reason: 'build_failed', recentDigest: [] })
  assert.match(wake, /failed 2 rounds in a row/)
  assert.match(wake, /Do NOT call run_build again unchanged/)
  const once = buildAutomatedWakePrompt({ topic: { autopilot: true }, todo: { ...todo, timeline: tl.slice(0, 6) }, project: { name: 'P', autopilot: {} }, reason: 'build_failed', recentDigest: [] })
  assert.doesNotMatch(once, /rounds in a row/)
})

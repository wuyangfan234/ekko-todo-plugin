// v0.9.55: research / content cards ("调研不改代码") delivered their report in the final reply, but the #36
// idle gate saw no commit and failed the card ("本轮没有产生任何提交…任务未推进"). Now such a round goes to
// acceptance with the report attached; code cards keep the idle gate, and their text reply is no longer lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { buildAutomatedWakePrompt, buildChiefInstructions, buildWorkerPrompt } from '../src/server/prompts.mjs'
import { hasTextDeliverable, inferTodoKind, isNoCodeKind } from '../src/shared/todo-kind.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-deliv-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, inputs: [] }
  // onStop: called inside sessions.stop (the host reports the stop before stop() returns).
  // createFails: sessions.create rejects. alreadyRunning: sessions.run is refused as "already running".
  const flags = { onStop: null, createFails: false, alreadyRunning: false }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { if (flags.createFails) throw new Error('host refused to create a session'); calls.create += 1; const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        calls.run += 1
        calls.inputs.push(String(input))
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

async function buildingTodo(ctx, { configs = ONE, autoFallback = true, withPlan = false, kind, title = 'T', autopilot = false } = {}) {
  const { root, db, orch, run, gateLog } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '空转测试 Agent', role: 'builder', engine: 'codex', autoFallback, modelConfigs: configs })
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
  // 0.9.64: up to 3 nudges in a row.
  for (let i = 0; i < 3 && nudged(); i += 1) {
    ctx.calls.nudges = (ctx.calls.nudges || 0) + 1
    after = await completeOnce(ctx, todoId, text)
  }
  return after
}


const REPORT = '## 结论\n选型推荐 A 方案：社区活跃、许可证 MIT、和现有栈兼容。\n\n## 依据\n- A：近 30 天 120 次提交，issue 响应中位 1 天\n- B：已半年无发布\n\n## 风险\nA 的插件接口在 2.x 有破坏性变更，接入需锁版本。'

test('v0.9.55: a research card that changed no file but reported is delivered for acceptance, not failed', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研三个开源方案' })
    assert.equal(todo.kind, 'question')
    const runsBefore = ctx.calls.run
    // #104: a research report counts only when the round really looked something up (a tool call), or the
    // report itself names files / command output.
    ctx.sessions.get(todo.buildSessionId).messages.push({ id: 'tc-1', role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'web_search' }, { id: 'c2', name: 'web_extract' }] })
    const after = await complete(ctx, todo.id, REPORT)
    assert.equal(after.phase, 'review')
    assert.equal(after.gateKind, 'deliverable')
    assert.equal(after.gateOwner, 'human')
    assert.equal(after.lastError, '')
    assert.equal(after.evidence.deliverable, REPORT)
    assert.equal(after.evidence.deliverableChars, REPORT.length)
    assert.equal(after.evidence.gateSkipped, 'no-code-task')
    assert.equal(gateRuns(ctx), 0, 'the test gate is not run on unchanged code')
    assert.equal(ctx.calls.run, runsBefore, 'no idle rerun')
    assert.ok(timeline(ctx, todo.id).some(e => /成果已交付（调研类任务，不要求改代码；成果 \d+ 字），待验收/.test(e)))
    assert.ok(!timeline(ctx, todo.id).some(e => /没有产生任何提交/.test(e)))
    // There is nothing to merge; acceptance is complete.
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }), /没有代码可合并/)
    const done = await ctx.orch.completeTodo(ctx.run, { todoId: todo.id })
    assert.equal(done.phase, 'done')
  } finally { ctx.cleanup() }
})

test('v0.9.55: content cards behave the same; AUTO topic hands acceptance to the Chief', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'content', title: '写一份展会招商说明', autopilot: true })
    const after = await complete(ctx, todo.id, REPORT)
    assert.equal(after.gateKind, 'deliverable')
    assert.equal(after.gateOwner, 'chief')
    assert.ok(timeline(ctx, todo.id).some(e => /内容类任务/.test(e)))
  } finally { ctx.cleanup() }
})

test('v0.9.55: a research card whose round left only a status line (or was stopped) is still idle', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研 X' })
    const after = await complete(ctx, todo.id, '好的，开始调研。')
    assert.equal(after.phase, 'failed')
    assert.match(after.lastError, /没有产生任何提交/)
  } finally { ctx.cleanup() }
})

test('v0.9.55: only this round\'s reply counts, not a report left by an earlier round', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研 Y' })
    const s = ctx.sessions.get(todo.buildSessionId)
    // An earlier reply, then a new instruction, then this round ends with no text at all.
    s.messages.splice(0, 0, { id: 'old', role: 'assistant', content: REPORT, timestamp: 1 })
    s.is_running = false
    await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: todo.buildSessionId, finish_reason: 'stop' } }, ctx.run)
    assert.equal(get(ctx, todo.id).phase, 'failed')
  } finally { ctx.cleanup() }
})

test('v0.9.55: a code card that only answered in text still fails idle, but the reply is kept on the timeline', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'feature', title: '实现登录' })
    const after = await complete(ctx, todo.id, REPORT)
    assert.equal(after.phase, 'failed')
    assert.match(after.lastError, /没有产生任何提交/)
    const note = timeline(ctx, todo.id).find(e => e.startsWith('本轮未改代码，但留下了'))
    assert.ok(note, 'the text output is recorded')
    assert.match(note, /选型推荐 A 方案/)
    assert.match(note, /kind=question/)
  } finally { ctx.cleanup() }
})

test('v0.9.55: a research card that did commit a file goes through the normal build path', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研并写报告文件' })
    writeFileSync(join(todo.worktreePath, 'report.md'), REPORT)
    git(todo.worktreePath, 'add', '.'); git(todo.worktreePath, 'commit', '-m', 'report')
    const after = await complete(ctx, todo.id, REPORT)
    assert.equal(after.phase, 'review')
    assert.equal(after.gateKind, 'merge')
    assert.equal(after.evidence.filesChanged, 1)
  } finally { ctx.cleanup() }
})

test('v0.9.55: kind inference, worker prompt and Chief prompts', () => {
  assert.equal(inferTodoKind('调研三个开源记忆方案'), 'question')
  assert.equal(inferTodoKind('Research vector DB options'), 'question')
  assert.equal(inferTodoKind('评估 Windows 兼容性'), 'question')
  assert.equal(inferTodoKind('修复登录白屏'), 'feature')
  assert.equal(isNoCodeKind('question'), true)
  assert.equal(isNoCodeKind('content'), true)
  assert.equal(isNoCodeKind('feature'), false)
  assert.equal(hasTextDeliverable('好的'), false)
  assert.equal(hasTextDeliverable(REPORT), true)

  const project = { name: 'P', defaultBranch: 'main', testCommand: '' }
  const w = buildWorkerPrompt({ todo: { number: 1, title: '调研', kind: 'question', branch: 'b', worktreePath: '/w' }, project, withPlan: false })
  assert.match(w, /research \/ investigation task/)
  assert.match(w, /FINAL reply is collected verbatim as the deliverable/)
  const code = buildWorkerPrompt({ todo: { number: 1, title: 'x', kind: 'feature', branch: 'b', worktreePath: '/w' }, project, withPlan: false })
  assert.match(code, /^Implement Todo #1/)

  const chief = buildChiefInstructions({ settings: { chiefStrictOrchestration: true }, agents: [], projects: [], activeTodos: [], memories: [], chiefAgent: {}, topic: {} })
  assert.match(chief, /kind="question"/)

  const todo = { id: 'td-1', number: 1, title: '调研', phase: 'review', gateOwner: 'chief', gateKind: 'deliverable', evidence: { deliverable: REPORT, deliverableChars: REPORT.length }, question: {} }
  const wake = buildAutomatedWakePrompt({ topic: { autopilot: true }, todo, project: { name: 'P', autopilot: { autoMergeAfterReview: true } }, reason: 'deliverable_ready', recentDigest: [] })
  assert.ok(wake.includes('选型推荐 A 方案'), 'the report reaches the Chief')
  assert.match(wake, /complete_todo\(todo_id="td-1"\)/)
  assert.match(wake, /Do NOT call run_review or merge_build/)
})

test('v0.9.55: create_todo without kind infers it; the MCP schema lists content and explains question', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { title: '调研 Windows 凭据路径' })
    assert.equal(todo.kind, 'question')
    const mcp = readFileSync(new URL('../src/server/mcp-tools.mjs', import.meta.url), 'utf8')
    assert.match(mcp, /enum: \['feature', 'bug', 'question', 'deploy', 'content'\], description: "Task type\. Use 'question' for research/)
    assert.match(mcp, /kind: input\.kind \|\| '',/)
  } finally { ctx.cleanup() }
})

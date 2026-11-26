// v0.9.47 (#36): a build round that ends normally but produced nothing (HEAD and the worktree tree are both
// what they were when the round started) is not "build completed": no test gate, no review gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { captureWorktreeSnapshot } from '../src/server/git-engine.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-idle-'))
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

async function buildingTodo(ctx, { configs = ONE, autoFallback = true, withPlan = false } = {}) {
  const { root, db, orch, run, gateLog } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '空转测试 Agent', role: 'builder', engine: 'codex', autoFallback, modelConfigs: configs })
  const agent = db.listAgents(1, 'default').find(a => a.name === '空转测试 Agent')
  assert.ok(agent, 'agent saved')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: `echo ran >> "${gateLog}"` })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id, withPlan })
  assert.equal(built.phase, 'building')
  assert.ok(built.worktreePath && existsSync(built.worktreePath), 'worktree exists')
  return { todo: built, agent, project }
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

// ---- 1. idle round: failed, not at the review gate, gate not run -----------------------------------------

test('v0.9.47: a round that ends normally with no commit and no change fails the card instead of reaching review', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const head = git(todo.worktreePath, 'rev-parse', 'HEAD')
    assert.equal(todo.evidence.roundBaseSha, head, 'the round baseline is the worktree HEAD at dispatch')
    assert.match(String(todo.evidence.roundBaseTree), /^[0-9a-f]{40}$/)
    const runsBefore = ctx.calls.run
    const after = await complete(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.notEqual(after.phase, 'review')
    assert.equal(after.gateKind, 'failed')
    assert.equal(after.gateOwner, 'human')
    assert.match(after.lastError, /没有产生任何提交/)
    assert.ok(after.lastError.includes(head.slice(0, 12)), 'the error names the HEAD that did not move')
    assert.match(after.lastError, /任务未推进/)
    assert.equal(after.evidence.gateSkipped, 'no-new-commit')
    assert.equal(gateRuns(ctx), 0, 'the test gate was not run on the old code')
    assert.equal(after.evidence.testRc, -1, 'no test result is recorded')
    assert.equal(after.evidence.testSummary, '')
    assert.equal(ctx.calls.run - (ctx.calls.nudges || 0), runsBefore, 'single config: nothing to rerun with')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('构建失败') && e.includes('没有产生任何提交')))
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('构建完成')), 'no "build completed" line')
  } finally { ctx.cleanup() }
})

// ---- 2. a commit: unchanged behaviour ---------------------------------------------------------------------

test('v0.9.47: a round that commits goes to the review gate with the test gate run', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const base = git(todo.worktreePath, 'rev-parse', 'HEAD')
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'changed\n')
    git(todo.worktreePath, 'commit', '-am', 'work')
    const after = await complete(ctx, todo.id, 'done')
    assert.equal(after.phase, 'review')
    assert.equal(after.lastError, '')
    assert.equal(after.evidence.testRc, 0)
    assert.equal(gateRuns(ctx), 1)
    assert.equal(after.evidence.roundBaseSha, base, 'the baseline of the round is kept on the card')
    assert.ok(!after.evidence.gateSkipped, 'gate not marked as skipped')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('构建完成')))
  } finally { ctx.cleanup() }
})

test('v0.9.47: an empty commit moves HEAD and counts as output', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    assert.ok(todo.evidence.roundBaseSha, 'baseline recorded')
    git(todo.worktreePath, 'commit', '--allow-empty', '-m', 'empty')
    const after = await complete(ctx, todo.id, 'done')
    assert.equal(after.phase, 'review')
    assert.equal(after.lastError, '')
  } finally { ctx.cleanup() }
})

// ---- 3. touched or reverted: tree unchanged = idle --------------------------------------------------------

test('v0.9.47: touching a file or changing it and changing it back leaves the tree as it was: idle', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const file = join(todo.worktreePath, 'a.txt')
    writeFileSync(file, 'something else\n')
    writeFileSync(file, 'base\n')
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)
    const after = await complete(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.match(after.lastError, /没有产生任何提交/)
    assert.equal(after.evidence.gateSkipped, 'no-new-commit')
    assert.equal(gateRuns(ctx), 0)
  } finally { ctx.cleanup() }
})

// ---- 4. uncommitted but changed: output -------------------------------------------------------------------

test('v0.9.47: an uncommitted change made in the round is output; the same uncommitted change one round later is idle', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const head = git(todo.worktreePath, 'rev-parse', 'HEAD')
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'edited, not committed\n')
    writeFileSync(join(todo.worktreePath, 'new.txt'), 'untracked\n')
    const first = await complete(ctx, todo.id, 'edited')
    assert.equal(first.phase, 'review', 'tree changed: not idle')
    assert.equal(first.lastError, '')
    assert.equal(gateRuns(ctx), 1)
    assert.equal(first.evidence.testRc, 0)
    assert.ok(first.evidence.roundBaseTree, 'baseline tree recorded')

    // Next round on the same card: nothing is touched, the dirty worktree is exactly what the round started with.
    const again = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, extraMessage: '请补充报告' })
    assert.equal(again.phase, 'building')
    assert.notEqual(again.evidence.roundBaseTree, todo.evidence.roundBaseTree, 'the new round has its own baseline tree')
    assert.equal(again.evidence.testRc, -1, 'a dispatch clears the test result of the round before it')
    assert.equal(again.evidence.testSummary, '')
    assert.equal(again.evidence.roundBaseSha, head)
    const second = await complete(ctx, todo.id, 'report only')
    assert.equal(second.phase, 'failed')
    assert.match(second.lastError, /有改动未提交，且 HEAD 未前进/)
    assert.ok(second.lastError.includes(head.slice(0, 12)))
    assert.equal(second.evidence.gateSkipped, 'no-new-commit')
    assert.equal(second.evidence.testRc, -1, 'the test result of the earlier round is not left on a failed idle round')
    assert.equal(gateRuns(ctx), 1, 'the gate did not run again')
  } finally { ctx.cleanup() }
})

// ---- 5. no baseline: the check is skipped, never a wrong verdict ------------------------------------------

test('v0.9.47: worktree gone before settle: the output check is skipped with a timeline line', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    rmSync(todo.worktreePath, { recursive: true, force: true })
    const after = await complete(ctx, todo.id)
    assert.notEqual(after.phase, 'failed')
    assert.equal(after.phase, 'review')
    assert.doesNotMatch(after.lastError, /没有产生任何提交|HEAD 未前进/)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('取不到工作树快照，跳过产出校验')))
    // No snapshot: the test command is not run in a directory that may be gone, and the card says so.
    assert.equal(gateRuns(ctx), 0)
    assert.equal(after.evidence.gateSkipped, 'no-snapshot')
    assert.equal(after.evidence.testRc, -1)
    assert.equal(after.gateOwner, 'human')
  } finally { ctx.cleanup() }
})

for (const missing of ['roundBaseSha', 'roundBaseTree']) {
  test(`v0.9.47: ${missing} missing on the card: the output check is skipped with a timeline line`, async () => {
    const ctx = setup()
    try {
      const { todo } = await buildingTodo(ctx)
      assert.ok(todo.evidence[missing], 'baseline was written at dispatch')
      ctx.db.updateTodo(1, 'default', todo.id, { evidence: { [missing]: '' } })
      const after = await complete(ctx, todo.id)
      assert.equal(after.phase, 'review', 'an unchanged worktree is not called idle without a baseline')
      assert.equal(after.lastError, '')
      assert.ok(!after.evidence.gateSkipped)
      assert.equal(gateRuns(ctx), 1)
      assert.ok(timeline(ctx, todo.id).some(e => e.includes('跳过产出校验')))
    } finally { ctx.cleanup() }
  })
}

test('v0.9.47: a planning round writes no code by design and is not judged', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { withPlan: true })
    const after = await complete(ctx, todo.id, '1. do this\n2. do that')
    assert.equal(after.phase, 'confirm')
    assert.equal(after.gateKind, 'plan')
    assert.equal(after.lastError, '')
    assert.ok(!after.evidence.gateSkipped)
  } finally { ctx.cleanup() }
})

test('v0.9.47: a deploy card needs output like any other card: an idle round fails it', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    ctx.db.updateTodo(1, 'default', todo.id, { kind: 'deploy' })
    assert.equal(get(ctx, todo.id).kind, 'deploy')
    const after = await complete(ctx, todo.id, 'deployed')
    assert.equal(after.phase, 'failed')
    assert.notEqual(after.phase, 'review')
    assert.equal(after.gateKind, 'failed')
    assert.notEqual(after.gateKind, 'deploy')
    assert.match(after.lastError, /没有产生任何提交/)
    assert.equal(after.evidence.gateSkipped, 'no-new-commit')
    assert.equal(after.evidence.testRc, -1)
    assert.equal(gateRuns(ctx), 0)
  } finally { ctx.cleanup() }
})

test('v0.9.47: a deploy card that commits stops at the deploy gate as before', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    ctx.db.updateTodo(1, 'default', todo.id, { kind: 'deploy' })
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'release\n')
    git(todo.worktreePath, 'commit', '-am', 'release')
    const after = await complete(ctx, todo.id, 'deployed')
    assert.equal(after.phase, 'review')
    assert.equal(after.gateKind, 'deploy')
    assert.equal(after.gateOwner, 'human')
    assert.equal(after.evidence.testRc, 0)
    assert.ok(!after.evidence.gateSkipped)
  } finally { ctx.cleanup() }
})

// ---- 5b. a stopped round is never rerun -------------------------------------------------------------------

const stopEvent = (ctx, sessionId) => ctx.orch.handleHostEvent({ type: 'chat.run.stopped', data: { session_id: sessionId } }, ctx.run)

test('v0.9.47: the host reports chat.run.stopped while cancelBuild is stopping the session: no rerun, no orphan session', async () => {
  const ctx = setup()
  try {
    const { todo, agent } = await buildingTodo(ctx, { configs: TWO })
    const runsBefore = ctx.calls.run
    const createsBefore = ctx.calls.create
    let seenPhase = ''
    // The stop event arrives before sessions.stop returns: the card is still `building` at that moment.
    ctx.flags.onStop = async id => { seenPhase = get(ctx, todo.id).phase; await stopEvent(ctx, id) }
    const after = await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })
    assert.equal(seenPhase, 'building', 'the event was handled while the card was still building')
    assert.equal(ctx.calls.run - (ctx.calls.nudges || 0), runsBefore, 'no run was started')
    assert.equal(ctx.calls.create, createsBefore, 'no session was created')
    assert.notEqual(after.phase, 'building')
    assert.equal(after.phase, 'todo')
    assert.equal(after.activeConfigId, 'cfg-1')
    assert.ok(!after.fallbackHistory.some(h => h.category === 'idle_build'))
    assert.equal(ctx.db.listAgentCooldowns(agent.id).length, 0)
    assert.ok(!after.evidence.idleRetries)
    assert.equal(gateRuns(ctx), 0)
  } finally { ctx.cleanup() }
})

test('v0.9.47: a stopped round without output fails the card and says it was stopped; it is not an idle rerun', async () => {
  const ctx = setup()
  try {
    const { todo, agent } = await buildingTodo(ctx, { configs: TWO })
    const head = git(todo.worktreePath, 'rev-parse', 'HEAD')
    const runsBefore = ctx.calls.run
    ctx.sessions.get(todo.buildSessionId).is_running = false
    await stopEvent(ctx, todo.buildSessionId)
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.match(after.lastError, /本轮被停止，没有产出/)
    assert.ok(after.lastError.includes(head.slice(0, 12)))
    assert.equal(ctx.calls.run - (ctx.calls.nudges || 0), runsBefore)
    assert.equal(after.fallbackHistory.length, 0)
    assert.equal(ctx.db.listAgentCooldowns(agent.id).length, 0)
    assert.ok(!after.evidence.idleRetries)
    assert.equal(after.evidence.testRc, -1)
    assert.equal(gateRuns(ctx), 0)
  } finally { ctx.cleanup() }
})

test('v0.9.47: a stopped round that did change the worktree settles as it did before', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { configs: TWO })
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'half done\n')
    ctx.sessions.get(todo.buildSessionId).is_running = false
    await stopEvent(ctx, todo.buildSessionId)
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'review')
    assert.equal(after.lastError, '')
    assert.equal(gateRuns(ctx), 1)
  } finally { ctx.cleanup() }
})

// ---- 5c. choices that are locked in -----------------------------------------------------------------------

test('v0.9.47: a commit followed by its revert moved HEAD: output, even though the tree is the baseline tree again', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'changed\n')
    git(todo.worktreePath, 'commit', '-am', 'work')
    git(todo.worktreePath, 'revert', '--no-edit', 'HEAD')
    assert.equal(git(todo.worktreePath, 'rev-parse', 'HEAD^{tree}'), todo.evidence.roundBaseTree, 'the tree is back at the baseline')
    assert.notEqual(git(todo.worktreePath, 'rev-parse', 'HEAD'), todo.evidence.roundBaseSha)
    const after = await complete(ctx, todo.id, 'reverted')
    assert.equal(after.phase, 'review')
    assert.equal(after.lastError, '')
    assert.equal(gateRuns(ctx), 1)
    assert.ok(!after.evidence.gateSkipped)
  } finally { ctx.cleanup() }
})

test('v0.9.47: an instruction refused as "already running" leaves the baseline of the running round in place', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const { roundBaseSha, roundBaseTree } = todo.evidence
    assert.ok(roundBaseSha && roundBaseTree)
    // The running round has already committed: a baseline read now would be this new HEAD.
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'changed\n')
    git(todo.worktreePath, 'commit', '-am', 'work')
    ctx.sessions.get(todo.buildSessionId).is_running = false // the probe sees an idle session, the host refuses anyway
    ctx.flags.alreadyRunning = true
    await assert.rejects(() => ctx.orch.messageTodo(ctx.run, { todoId: todo.id, note: '这条会被拒' }), /没有送达/)
    ctx.flags.alreadyRunning = false
    const cur = get(ctx, todo.id)
    assert.equal(cur.evidence.roundBaseSha, roundBaseSha)
    assert.equal(cur.evidence.roundBaseTree, roundBaseTree)
    // The round that was running all along is judged against its own baseline: it committed.
    const after = await complete(ctx, todo.id, 'done')
    assert.equal(after.phase, 'review')
  } finally { ctx.cleanup() }
})

// ---- 6. one automatic rerun ------------------------------------------------------------------------------

test('v0.9.47: idle with a fallback config: rerun once on the other config, a second idle round fails the card', async () => {
  const ctx = setup()
  try {
    const { todo, agent } = await buildingTodo(ctx, { configs: TWO })
    const firstSession = todo.buildSessionId
    const createsBefore = ctx.calls.create
    const runsBefore = ctx.calls.run
    const first = await complete(ctx, todo.id)
    assert.equal(first.phase, 'building', 'rerun instead of failing')
    assert.equal(first.activeConfigId, 'cfg-2')
    assert.equal(first.evidence.idleRetries, 1)
    assert.equal(ctx.calls.create, createsBefore + 1, 'a new session')
    assert.equal(ctx.calls.run - (ctx.calls.nudges || 0), runsBefore + 1, 'exactly one rerun')
    assert.notEqual(first.buildSessionId, firstSession)
    assert.equal(first.fallbackHistory.length, 1)
    assert.equal(first.fallbackHistory[0].category, 'idle_build')
    assert.equal(first.fallbackHistory[0].fromConfigId, 'cfg-1')
    assert.equal(first.fallbackHistory[0].toConfigId, 'cfg-2')
    const prompt = ctx.calls.inputs.at(-1)
    assert.ok(prompt.includes(todo.worktreePath), 'the rerun instruction names the worktree')
    assert.match(prompt, /没有产生任何提交/)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('构建会话空转（无产出）') && e.includes('已自动切换')))
    assert.equal(ctx.db.listAgentCooldowns(agent.id)[0]?.configId, 'cfg-1')
    assert.equal(gateRuns(ctx), 0)

    const second = await complete(ctx, todo.id)
    assert.equal(second.phase, 'failed')
    assert.equal(second.evidence.idleRetries, 1)
    assert.equal(second.evidence.gateSkipped, 'no-new-commit')
    assert.match(second.lastError, /没有产生任何提交/)
    assert.equal(ctx.calls.run - (ctx.calls.nudges || 0), runsBefore + 1, 'no second rerun')
    assert.equal(second.fallbackHistory.length, 1)
    assert.equal(gateRuns(ctx), 0)
  } finally { ctx.cleanup() }
})

test('v0.9.47: the rerun that does produce a commit reaches review; the skipped mark does not stay', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { configs: TWO })
    const first = await complete(ctx, todo.id)
    assert.equal(first.phase, 'building')
    assert.equal(first.evidence.idleRetries, 1)
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'second try\n')
    git(todo.worktreePath, 'commit', '-am', 'work')
    const second = await complete(ctx, todo.id, 'done')
    assert.equal(second.phase, 'review')
    assert.equal(second.lastError, '')
    assert.equal(second.evidence.testRc, 0)
    assert.ok(!second.evidence.gateSkipped)
  } finally { ctx.cleanup() }
})

test('v0.9.47: the rerun cannot be started: the card fails with both causes instead of staying in building without a session', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { configs: TWO })
    const runsBefore = ctx.calls.run
    ctx.flags.createFails = true
    let threw = null
    await complete(ctx, todo.id).catch(err => { threw = err })
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.equal(after.gateKind, 'failed')
    assert.match(after.lastError, /没有产生任何提交/)
    assert.match(after.lastError, /自动重跑未能启动/)
    assert.match(after.lastError, /host refused to create a session/)
    assert.equal(threw, null, 'the settle itself does not reject')
    assert.ok(!after.evidence.idleRetries, 'a rerun that never started is not counted')
    assert.equal(after.evidence.gateSkipped, 'no-new-commit')
    assert.equal(after.evidence.testRc, -1)
    assert.equal(ctx.calls.run - (ctx.calls.nudges || 0), runsBefore)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('自动重跑未能启动')))
  } finally { ctx.cleanup() }
})

test('v0.9.47: autoFallback off: an idle round fails without a rerun even when another config exists', async () => {
  const ctx = setup()
  try {
    const { todo, agent } = await buildingTodo(ctx, { configs: TWO, autoFallback: false })
    const runsBefore = ctx.calls.run
    const after = await complete(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.equal(after.activeConfigId, 'cfg-1')
    assert.equal(ctx.calls.run - (ctx.calls.nudges || 0), runsBefore)
    assert.equal(after.fallbackHistory.length, 0)
    assert.equal(ctx.db.listAgentCooldowns(agent.id).length, 0, 'no cooldown recorded without a switch attempt')
    assert.ok(!after.evidence.idleRetries)
  } finally { ctx.cleanup() }
})

// ---- 7. snapshot: head and tree are returned and stable --------------------------------------------------

test('v0.9.47: captureWorktreeSnapshot returns headSha and a worktreeTreeSha that is stable for the same dirty worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-idle-snap-'))
  try {
    const repoPath = makeRepo(root)
    const worktreePath = join(root, 'wt')
    git(repoPath, 'worktree', 'add', '-b', 'task', worktreePath, 'main')
    const args = { repoPath, worktreePath, baseCommit: git(repoPath, 'rev-parse', 'main'), baseBranch: 'main', snapshotRefName: 'snap-test' }
    const head = git(worktreePath, 'rev-parse', 'HEAD')
    const headTree = git(worktreePath, 'rev-parse', 'HEAD^{tree}')

    const clean = await captureWorktreeSnapshot(args)
    assert.equal(clean.headSha, head)
    assert.equal(clean.worktreeTreeSha, headTree, 'clean worktree: the tree of HEAD')

    writeFileSync(join(worktreePath, 'a.txt'), 'basf\n') // one byte changed, not committed
    const one = await captureWorktreeSnapshot(args)
    const two = await captureWorktreeSnapshot(args)
    assert.match(one.worktreeTreeSha, /^[0-9a-f]{40}$/)
    assert.equal(one.worktreeTreeSha, two.worktreeTreeSha, 'same dirty worktree, same tree')
    assert.notEqual(one.worktreeTreeSha, headTree)
    assert.equal(one.headSha, head)
    assert.equal(two.headSha, git(worktreePath, 'rev-parse', 'HEAD'))
    assert.equal(git(worktreePath, 'status', '--porcelain'), 'M a.txt', 'the real index is not touched')

    writeFileSync(join(worktreePath, 'a.txt'), 'base\n') // back to the committed content
    const back = await captureWorktreeSnapshot(args)
    assert.equal(back.worktreeTreeSha, headTree)
    // The fields that existed before are still there.
    for (const key of ['snapshotSha', 'snapshotFullSha', 'filesChanged', 'additions', 'deletions', 'diffs']) assert.ok(key in back, key)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---- 8. release metadata and bundle ----------------------------------------------------------------------

test('v0.9.47: the shipped server bundle carries the change, versions agree, the changelog has the section', () => {
  const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const server = read('dist/server.mjs')
  for (const literal of ['no-new-commit', 'idle_build', 'roundBaseSha', 'roundBaseTree', 'worktreeTreeSha', 'idleRetries']) {
    assert.ok(server.includes(literal), `server bundle has ${literal}`)
  }
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const [major, minor, patchNo] = pkg.version.split('.').map(Number)
  assert.ok(major === 0 && minor === 9 && patchNo >= 47, `version ${pkg.version} is 0.9.47 or later`)
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(JSON.parse(read('contracts/plugin.json')).description.includes(`v${pkg.version} `))
  const changelog = read('CHANGELOG.md')
  const start = changelog.indexOf('## [0.9.47]')
  assert.ok(start >= 0, 'changelog section 0.9.47')
  const section = changelog.slice(start, changelog.indexOf('\n## [', start + 1))
  assert.match(section, /no-new-commit/)
  assert.match(section, /没有产生任何提交/)
  assert.match(section, /chat\.run\.stopped/)
  assert.match(section, /部署类卡片同样要求产出/)
  assert.doesNotMatch(section, /部署类卡片、取不到/)
  assert.ok(server.includes('no-snapshot'), 'server bundle has no-snapshot')
  assert.equal((changelog.match(/^## \[0\.9\.47\]/gm) || []).length, 1, 'one 0.9.47 section')
  for (const v of ['0.9.46', '0.9.45', '0.9.44']) assert.ok(changelog.includes(`## [${v}]`), `section ${v} is kept`)
  // #35's classifier is not where idle rounds are classified.
  assert.ok(!read('src/server/failover.mjs').includes('idle_build'), 'failover.mjs has no idle category')
})

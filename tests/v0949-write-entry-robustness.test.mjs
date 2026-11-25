// v0.9.49 (#44): the write entries of one card are closed up.
//  1. `startBuild({ fresh: true })` validates the phase change before it removes anything.
//  2. An operation whose write lock was taken over (TTL) no longer writes the card when it finally returns;
//     a settle whose card moved on while it waited drops its result as well.
//  3. `cancelBuild`, `closeTodo` and `reopenTodo` take the same lock; a card that is merging is not stopped
//     with discard and not closed.
//  4. `retryMerge` records who called it and needs the worktree to be a directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-writeentry-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  // The lock clock reads Date.now at call time, so a test can move the time forward (movedClock).
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], clock: () => Date.now() })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, stop: 0 }
  // createGate / runGate / messagesGate: while set, that host call waits for the promise (a call that hangs
  // inside the host).
  // agentsGate: the engine probe (host.agents.list). stopGate: the next sessions.stop only (one shot).
  const flags = { createGate: null, runGate: null, messagesGate: null, agentsGate: null, stopGate: null }
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
        calls.run += 1
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { if (flags.stopGate) { const g = flags.stopGate; flags.stopGate = null; await g } calls.stop += 1; const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) {
        if (flags.messagesGate) await flags.messagesGate
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
const ENGINE_CACHE_MS = 46 * 1000
const PAST_LOCK_TTL_MS = 11 * 60 * 1000

async function waitFor(check, what, ms = 8000) {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await tick(25)
  }
}

// A git hook that holds the git command that runs it until release(): the only way to make a real
// `git worktree add` / `git branch -D` / `git merge` take long. It holds only after arm().
function blockingHook(ctx, repoPath, hookName) {
  const dir = join(ctx.root, `hook-${hookName}`)
  mkdirSync(dir, { recursive: true })
  const armed = join(dir, 'armed'), started = join(dir, 'started'), released = join(dir, 'released')
  const file = join(repoPath, '.git', 'hooks', hookName)
  mkdirSync(join(repoPath, '.git', 'hooks'), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n[ -f "${armed}" ] || exit 0\n: > "${started}"\ni=0\nwhile [ ! -f "${released}" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done\nexit 0\n`)
  chmodSync(file, 0o755)
  return {
    arm() { writeFileSync(armed, '') },
    started: () => waitFor(() => existsSync(started), `the ${hookName} hook`),
    release() { writeFileSync(released, '') },
  }
}

// The first write of a build dispatch (`building`) comes after the engine probe, real git and a worktree
// read, and an instruction answers after 1500 ms with `launchPending` while its launch goes on. Whatever
// depends on that write waits for it; a fixed sleep is not enough under load.
const building = (ctx, id) => waitFor(() => get(ctx, id).phase === 'building', 'the dispatch to write building')
// The launch of an instruction is over: the card is building, the run id is new, the lock is released.
const launched = (ctx, id, runIdBefore) => waitFor(
  () => { const t = get(ctx, id); return t.phase === 'building' && Boolean(t.buildRunId) && t.buildRunId !== runIdBefore && !ctx.orch.todoWriteLocks.has(id) },
  'the instruction launch to be recorded on the card')
const queueOf = (ctx, id) => ctx.db.listTodoQueue(1, 'default', id)

async function rejection(promise) {
  try { await promise } catch (err) { return err }
  return null
}

// A card that was never dispatched (phase todo, no worktree).
async function plainTodo(ctx, { autopilot = false, testCommand = 'true' } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '写入口测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '写入口测试 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  return { todo, project, topic, agent }
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

// ---- 1. fresh restart: validate first, remove afterwards -------------------------------------------------

test('v0.9.49: a fresh build on a card under review is refused before its worktree and branch are removed', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewingCard(ctx)
    assert.ok(todo.worktreePath && existsSync(todo.worktreePath), 'the card has a real worktree')
    assert.ok(hasBranch(project.repoPath, todo.branch), 'the card has a real branch')
    assert.ok(todo.snapshotSha, 'the card has a snapshot')
    assert.ok(todo.diffs.length > 0, 'the card has diffs')
    const runsBefore = ctx.calls.run

    const err = await rejection(ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, fresh: true }))
    assert.ok(err, 'the dispatch is refused')
    assert.match(err.message, /START_BUILD is not allowed from phase "reviewing"/)

    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'reviewing', 'the phase is unchanged')
    assert.ok(existsSync(todo.worktreePath), 'the worktree directory is still there')
    assert.ok(hasBranch(project.repoPath, todo.branch), 'the task branch is still there')
    assert.equal(cur.worktreePath, todo.worktreePath)
    assert.equal(cur.branch, todo.branch)
    assert.equal(cur.snapshotSha, todo.snapshotSha)
    assert.equal(cur.baseCommit, todo.baseCommit)
    assert.deepEqual(cur.diffs, todo.diffs)
    assert.equal(cur.buildSessionId, todo.buildSessionId)
    assert.equal(cur.reviewSessionId, todo.reviewSessionId)
    assert.equal(cur.evidence.reviewVerdict, 'pending')
    assert.equal(ctx.calls.run, runsBefore, 'no run was started')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false, 'the refused dispatch released the lock')
  } finally { ctx.cleanup() }
})

test('v0.9.49: with every build slot taken, a dispatch the state machine refuses is not parked in the queue', async () => {
  const ctx = setup()
  try {
    const { todo, project, topic, agent } = await reviewingCard(ctx)
    ctx.db.updateSettings(1, 'default', { maxConcurrentBuilds: 1 })
    // A second card holds a slot too: nothing is free.
    const other = (await ctx.orch.createTodo(ctx.run, { projectId: project.id, topicId: topic.id, title: 'T2', agentId: agent.id })).todo
    patch(ctx, other.id, { phase: 'building' })

    for (const fresh of [true, false]) {
      const err = await rejection(ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, fresh }))
      assert.ok(err, `refused (fresh=${fresh})`)
      assert.match(err.message, /START_BUILD is not allowed from phase "reviewing"/)
      const cur = get(ctx, todo.id)
      assert.equal(cur.phase, 'reviewing', 'not parked as queued')
      assert.equal(cur.gateKind, 'review')
      assert.ok(existsSync(todo.worktreePath))
      assert.ok(hasBranch(project.repoPath, todo.branch))
      assert.equal(cur.worktreePath, todo.worktreePath)
    }

    // A card the state machine lets start is still parked when no slot is free.
    patch(ctx, todo.id, { phase: 'review', gateOwner: 'human', gateKind: 'merge' })
    const parked = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false })
    assert.equal(parked.phase, 'queued')
    assert.equal(parked.worktreePath, todo.worktreePath)
  } finally { ctx.cleanup() }
})

test('v0.9.49: a fresh restart of a failed card still removes the old worktree and starts over', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await buildingTodo(ctx)
    writeFileSync(join(todo.worktreePath, 'junk.txt'), 'left over\n')
    patch(ctx, todo.id, { phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError: '主备模型均失败：upstream 503' })
    ctx.sessions.get(todo.buildSessionId).is_running = false
    const again = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, fresh: true })
    assert.equal(again.phase, 'building')
    assert.ok(existsSync(again.worktreePath))
    assert.equal(existsSync(join(again.worktreePath, 'junk.txt')), false, 'the worktree was recreated')
    assert.notEqual(again.buildSessionId, todo.buildSessionId, 'a new session')
    assert.ok(hasBranch(project.repoPath, again.branch))
  } finally { ctx.cleanup() }
})

// ---- 2. a taken-over operation does not write the card ---------------------------------------------------

test('v0.9.49: a review dispatch whose lock was taken over does not write the card back to reviewing', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    // The review dispatch hangs inside the host at sessions.run.
    const g = gate()
    ctx.flags.runGate = g.promise
    const hung = ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    hung.catch(() => {})
    // #46: the dispatch writes `reviewing` (verdict pending) before it launches, so the hung card is
    // `reviewing` already. "Mark done" has no exit from `reviewing`; the write that takes over is a close.
    await waitFor(() => get(ctx, todo.id).phase === 'reviewing', 'the dispatch to write reviewing')
    const lock = ctx.orch.todoWriteLocks.get(todo.id)
    assert.ok(lock, 'the hung dispatch holds the lock')
    assert.equal(get(ctx, todo.id).evidence.reviewVerdict, 'pending')

    // The lock expires and a close takes the card over.
    lock.acquiredAt = Date.now() - 11 * 60 * 1000
    const closed = await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')

    // The hung dispatch returns.
    ctx.flags.runGate = null
    g.open()
    const returned = await hung
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'closed', 'the card was not written back to reviewing')
    assert.equal(cur.gateKind, 'none')
    assert.equal(cur.gateOwner, 'none')
    assert.equal(cur.reviewRunId, '', 'no review run was recorded on the card')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARDED)).length, 1, 'the discard is on the timeline once')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('派发独立只读审查至')), 'no dispatch line was written')
    assert.equal(returned.phase, 'closed', 'the operation answers with the card as it really is')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.49: a review dispatch that keeps its lock still writes the card (nothing is dropped by mistake)', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const g = gate()
    ctx.flags.runGate = g.promise
    const slow = ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    await tick()
    // Another write is refused meanwhile and takes nothing over.
    assert.ok(await rejection(ctx.orch.completeTodo(ctx.run, { todoId: todo.id })))
    ctx.flags.runGate = null
    g.open()
    const reviewed = await slow
    assert.equal(reviewed.phase, 'reviewing')
    assert.equal(reviewed.evidence.reviewVerdict, 'pending')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(DISCARDED)))
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.49: a build dispatch whose lock was taken over records neither a session nor a failure on the card', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const g = gate()
    ctx.flags.runGate = g.promise
    const hung = ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, extraMessage: '再补一个用例' })
    hung.catch(() => {})
    await building(ctx, todo.id)
    await tick()
    const lock = ctx.orch.todoWriteLocks.get(todo.id)
    assert.ok(lock)
    assert.equal(get(ctx, todo.id).phase, 'building')
    lock.acquiredAt = Date.now() - 11 * 60 * 1000
    const closed = await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')
    const runIdAtClose = get(ctx, todo.id).buildRunId

    ctx.flags.runGate = null
    g.open()
    const returned = await hung
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'closed')
    assert.equal(cur.buildRunId, runIdAtClose, 'the late launch did not write its run id')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARDED)).length, 1)
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('派发构建至') && timeline(ctx, todo.id).indexOf(e) > timeline(ctx, todo.id).indexOf('已关闭')))
    assert.equal(returned.phase, 'closed')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.49: a merge that outlives the lock TTL and is taken over writes nothing on the card (real TTL)', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const { todo, project } = await reviewCard(ctx)
    // git holds the merge in its pre-merge-commit hook: the merge is slow for real.
    const hook = blockingHook(ctx, project.repoPath, 'pre-merge-commit')
    hook.arm()
    const merging = ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    merging.catch(() => {})
    await hook.started()
    assert.equal(get(ctx, todo.id).phase, 'merging')
    const mergeLock = ctx.orch.todoWriteLocks.get(todo.id)
    assert.ok(mergeLock, 'the merge holds the lock')

    // Inside the TTL another write is refused by the lock, past it the lock is taken over. Reopen is the
    // entry without a merging guard; the state machine then refuses it, and it releases what it took.
    assert.equal((await rejection(ctx.orch.reopenTodo(ctx.run, { todoId: todo.id }))).code, 'TODO_BUSY')
    clk.advance(PAST_LOCK_TTL_MS)
    const taken = await rejection(ctx.orch.reopenTodo(ctx.run, { todoId: todo.id }))
    assert.match(taken.message, /REOPEN is not allowed/)
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false, 'the merge lock was taken over and released')

    hook.release()
    const returned = await merging
    const cur = get(ctx, todo.id)
    assert.notEqual(cur.phase, 'done', 'the taken-over merge did not mark the card done')
    assert.equal(cur.phase, 'merging')
    assert.equal(cur.worktreePath, todo.worktreePath, 'worktreePath was not cleared by the late write')
    const dropped = timeline(ctx, todo.id).filter(e => e.includes(DISCARDED))
    assert.equal(dropped.length, 1)
    assert.match(dropped[0], /合并已执行，main 上为 [0-9a-f]{7,}/, 'the line says the merge happened and names the commit')
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('已合并至')))
    assert.equal(returned.phase, 'merging')
    assert.equal(readFileSync(join(project.repoPath, 'a.txt'), 'utf8'), 'feature side\n', 'git did merge')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)

    // The way out of the card left in `merging`: a stop without discard puts it back at the merge gate.
    const freed = await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })
    assert.equal(freed.phase, 'review')
  } finally { clk.restore(); ctx.cleanup() }
})

test('v0.9.49: a build settle that returns after the card was closed does not move it to the merge gate', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    commitWork(todo)
    const s = ctx.sessions.get(todo.buildSessionId)
    s.is_running = false
    s.messages.push({ id: 'a-1', role: 'assistant', content: 'done', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    // The settle hangs while it reads the transcript.
    const g = gate()
    ctx.flags.messagesGate = g.promise
    const settling = ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: todo.buildSessionId, finish_reason: 'stop' } }, ctx.run)
    await tick()
    assert.equal(get(ctx, todo.id).phase, 'building')
    const closed = await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')

    ctx.flags.messagesGate = null
    g.open()
    await settling
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'closed', 'the late settle did not write review over closed')
    assert.equal(cur.gateKind, 'none')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARDED)).length, 1)
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('构建完成')))
  } finally { ctx.cleanup() }
})

test('v0.9.49: a failed build settle that returns after the card was stopped does not mark it failed', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    ctx.sessions.get(todo.buildSessionId).is_running = false
    const g = gate()
    ctx.flags.messagesGate = g.promise
    const settling = ctx.orch.handleHostEvent({ type: 'chat.run.failed', data: { session_id: todo.buildSessionId, error: 'tool crashed: rc=3' } }, ctx.run)
    await tick()
    assert.equal(get(ctx, todo.id).phase, 'building')
    const stopped = await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })
    assert.equal(stopped.phase, 'todo')

    ctx.flags.messagesGate = null
    g.open()
    await settling
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'todo', 'the late settle did not write failed over todo')
    assert.equal(cur.gateKind, 'none')
    assert.equal(cur.lastError, '')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARDED)).length, 1)
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('构建失败')))
  } finally { ctx.cleanup() }
})

test('v0.9.49: a review settle that returns after the card was completed does not put it back at the gate', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const s = ctx.sessions.get(todo.reviewSessionId)
    s.is_running = false
    s.messages.push({ id: 'r-1', role: 'assistant', content: 'VERDICT: CHANGES_REQUESTED\n命名不清。', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    const g = gate()
    ctx.flags.messagesGate = g.promise
    const settling = ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: todo.reviewSessionId, finish_reason: 'stop' } }, ctx.run)
    await tick()
    const closed = await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')
    ctx.flags.messagesGate = null
    g.open()
    await settling
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'closed')
    assert.equal(cur.evidence.reviewVerdict, 'pending', 'the late verdict was not written')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARDED)).length, 1)
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('独立审查结论')))
  } finally { ctx.cleanup() }
})

test('v0.9.49: an undisturbed settle still settles (build, then review)', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('构建完成')))
    const s = ctx.sessions.get(todo.reviewSessionId)
    s.is_running = false
    s.messages.push({ id: 'r-1', role: 'assistant', content: SUMMARY, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: todo.reviewSessionId, finish_reason: 'stop' } }, ctx.run)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'review')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(DISCARDED)))
  } finally { ctx.cleanup() }
})

// ---- 2b. real TTL takeovers during the long waits of a build dispatch, a stop and a cleanup ---------------

const dispatchLines = (ctx, id) => timeline(ctx, id).filter(e => e.startsWith('派发构建至') || e.includes('已自动切换'))

test('v0.9.49: a build dispatch hung at the engine probe past the TTL does not write the completed card (real TTL)', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const { todo } = await reviewCard(ctx)
    // The engine cache (45 s) has expired, so the dispatch really asks the host, and the host does not answer.
    clk.advance(ENGINE_CACHE_MS)
    const g = gate()
    ctx.flags.agentsGate = g.promise
    const runsBefore = ctx.calls.run
    const createsBefore = ctx.calls.create
    const dispatchedBefore = dispatchLines(ctx, todo.id).length
    const hung = ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false })
    hung.catch(() => {})
    await tick()
    assert.ok(ctx.orch.todoWriteLocks.get(todo.id), 'the hung dispatch holds the lock')
    assert.equal(get(ctx, todo.id).phase, 'review', 'nothing written yet')
    // Inside the TTL the card cannot be completed; past it "mark done" takes the card over.
    assert.equal((await rejection(ctx.orch.completeTodo(ctx.run, { todoId: todo.id }))).code, 'TODO_BUSY')
    clk.advance(PAST_LOCK_TTL_MS)
    const done = await ctx.orch.completeTodo(ctx.run, { todoId: todo.id })
    assert.equal(done.phase, 'done')
    assert.equal(done.worktreePath, '', 'the clean worktree was released')
    assert.equal(existsSync(todo.worktreePath), false)

    ctx.flags.agentsGate = null
    g.open()
    const returned = await hung
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'done', 'the card was not written to building')
    assert.equal(cur.evidence.reviewVerdict, 'approved', 'the verdict was not reset to none')
    assert.equal(cur.buildRunId, '')
    assert.equal(cur.gateKind, 'none')
    assert.equal(cur.gateOwner, 'none')
    assert.equal(cur.worktreePath, '')
    assert.equal(existsSync(todo.worktreePath), false, 'no worktree was created for the dropped dispatch')
    assert.equal(dispatchLines(ctx, todo.id).length, dispatchedBefore, 'no new dispatch line')
    assert.equal(ctx.calls.run, runsBefore, 'no run was started')
    assert.equal(ctx.calls.create, createsBefore, 'no session was created')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARDED)).length, 1)
    assert.equal(returned.phase, 'done')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { clk.restore(); ctx.cleanup() }
})

test('v0.9.49: a build dispatch taken over while its worktree is being created names the worktree it leaves (real TTL)', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const { todo, project } = await plainTodo(ctx)
    // `git worktree add` is held in its post-checkout hook.
    const hook = blockingHook(ctx, project.repoPath, 'post-checkout')
    hook.arm()
    const hung = ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false })
    hung.catch(() => {})
    await hook.started()
    assert.equal(get(ctx, todo.id).phase, 'todo')
    clk.advance(PAST_LOCK_TTL_MS)
    const closed = await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')

    hook.release()
    const returned = await hung
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'closed', 'the card was not written to building')
    assert.equal(cur.worktreePath, '', 'the new worktree was not recorded on a card somebody else owns')
    assert.equal(cur.branch, '')
    assert.equal(cur.buildSessionId, '')
    assert.equal(cur.buildRunId, '')
    assert.equal(ctx.calls.run, 0, 'no run was started')
    assert.equal(ctx.calls.create, 0, 'no session was created')
    assert.equal(dispatchLines(ctx, todo.id).length, 0)
    const dropped = timeline(ctx, todo.id).filter(e => e.includes(DISCARDED))
    assert.equal(dropped.length, 1)
    const named = /工作树 (\S+) 已建好但未记入卡片/.exec(dropped[0])
    assert.ok(named, `the line names the worktree that was left: ${dropped[0]}`)
    assert.ok(existsSync(named[1]), 'and that directory is the one on disk')
    assert.equal(returned.phase, 'closed')
  } finally { clk.restore(); ctx.cleanup() }
})

test('v0.9.49: a fresh restart taken over while the old worktree is being removed does not write the card (real TTL)', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const { todo, project } = await buildingTodo(ctx)
    patch(ctx, todo.id, { phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError: '主备模型均失败：upstream 503' })
    ctx.sessions.get(todo.buildSessionId).is_running = false
    const runsBefore = ctx.calls.run
    // `git branch -D` is held in the reference-transaction hook.
    const hook = blockingHook(ctx, project.repoPath, 'reference-transaction')
    hook.arm()
    const hung = ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, fresh: true })
    hung.catch(() => {})
    await hook.started()
    clk.advance(PAST_LOCK_TTL_MS)
    const closed = await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')

    hook.release()
    const returned = await hung
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'closed', 'the card was not written to building')
    assert.equal(cur.buildSessionId, todo.buildSessionId, 'the session was not cleared by the late write')
    assert.equal(cur.lastError, '主备模型均失败：upstream 503')
    assert.equal(ctx.calls.run, runsBefore, 'no run was started')
    const dropped = timeline(ctx, todo.id).filter(e => e.includes(DISCARDED))
    assert.equal(dropped.length, 1)
    assert.ok(dropped[0].includes(todo.worktreePath) && dropped[0].includes('已删除但未记入卡片'), dropped[0])
    assert.equal(existsSync(todo.worktreePath), false, 'no worktree was created again')
    assert.equal(returned.phase, 'closed')
  } finally { clk.restore(); ctx.cleanup() }
})

test('v0.9.49: a stop with discard taken over while it removes the worktree does not write the card (real TTL)', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const { todo, project } = await buildingTodo(ctx)
    const hook = blockingHook(ctx, project.repoPath, 'reference-transaction')
    hook.arm()
    const hung = ctx.orch.cancelBuild(ctx.run, { todoId: todo.id, discard: true })
    hung.catch(() => {})
    await hook.started()
    assert.equal(get(ctx, todo.id).phase, 'building', 'nothing written yet')
    clk.advance(PAST_LOCK_TTL_MS)
    const closed = await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')
    const revisionAtClose = get(ctx, todo.id).revision

    hook.release()
    const returned = await hung
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'closed', 'the late stop did not write todo over closed')
    assert.ok(!timeline(ctx, todo.id).includes('已停止构建并清理工作树'))
    const dropped = timeline(ctx, todo.id).filter(e => e.includes(DISCARDED))
    assert.equal(dropped.length, 1)
    assert.ok(dropped[0].includes('已删除但未记入卡片') && dropped[0].includes(todo.worktreePath) && dropped[0].includes(todo.branch), dropped[0])
    // Only the timeline line was written: the path the card still shows is what the line is about.
    assert.equal(cur.revision, revisionAtClose + 1)
    assert.equal(cur.worktreePath, todo.worktreePath)
    assert.equal(existsSync(todo.worktreePath), false)
    assert.equal(hasBranch(project.repoPath, todo.branch), false)
    assert.equal(returned.phase, 'closed')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { clk.restore(); ctx.cleanup() }
})

test('v0.9.49: a delete taken over while it stops the session does not delete the card or its worktree (real TTL)', async () => {
  const ctx = setup()
  const clk = movedClock()
  try {
    const { todo, project } = await buildingTodo(ctx)
    const g = gate()
    ctx.flags.stopGate = g.promise
    const hung = ctx.orch.deleteTodo(ctx.run, { todoId: todo.id })
    hung.catch(() => {})
    await tick()
    clk.advance(PAST_LOCK_TTL_MS)
    const stopped = await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })
    assert.equal(stopped.phase, 'todo')

    g.open()
    const returned = await hung
    const cur = get(ctx, todo.id)
    assert.ok(cur, 'the card was not deleted')
    assert.equal(cur.phase, 'todo')
    assert.ok(existsSync(todo.worktreePath), 'the worktree was not removed')
    assert.ok(hasBranch(project.repoPath, todo.branch))
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARDED)).length, 1)
    assert.equal(returned.discarded, true)
  } finally { clk.restore(); ctx.cleanup() }
})

// `git status` and `git worktree remove` run no hook, so this window cannot be held open for real: the
// takeover is put in the lock table by hand right after the call. The real TTL path is covered above.
test('v0.9.49: the worktree cleanup of a completed card stops when the card was taken over meanwhile', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const completing = ctx.orch.completeTodo(ctx.run, { todoId: todo.id })
    const foreign = { owner: 'other#1', acquiredAt: Date.now(), label: '别的操作' }
    ctx.orch.todoWriteLocks.set(todo.id, foreign)
    await completing
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'done', 'the phase was written while the lock was still held')
    assert.equal(cur.worktreePath, todo.worktreePath, 'worktreePath was not cleared on a card somebody else owns')
    assert.ok(existsSync(todo.worktreePath), 'the worktree was not removed')
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('已清理工作树')))
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(DISCARDED)).length, 1)
    assert.equal(ctx.orch.todoWriteLocks.get(todo.id), foreign, 'the new holder keeps its lock')
  } finally { ctx.cleanup() }
})

test('v0.9.49: an undisturbed complete and close still release the clean worktree', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const done = await ctx.orch.completeTodo(ctx.run, { todoId: todo.id })
    assert.equal(done.worktreePath, '')
    assert.equal(existsSync(todo.worktreePath), false)
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('已清理工作树')))
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(DISCARDED)))
  } finally { ctx.cleanup() }
})

test('v0.9.49: the Chief tools answer in words when the card is gone, instead of a TypeError', async () => {
  const tools = new Map()
  const { registerMcpTools } = await import('../src/server/mcp-tools.mjs')
  const gone = async () => null
  registerMcpTools({ extensions: { tools: { register(def) { tools.set(def.name, def); return () => {} } } } }, {
    db: { getTodo: () => null, getProject: () => null },
    orchestrator: { startBuild: gone, runIndependentReview: gone, cancelBuild: gone, completeTodo: gone },
  })
  const run = { identity: { userId: 1, profile: 'default' } }
  for (const name of ['run_build', 'run_review', 'cancel_build', 'complete_todo']) {
    const res = await tools.get(name).execute({ todo_id: 't-gone' }, run)
    assert.equal(res.ok, true, name)
    assert.match(res.content, /卡片已不存在/, name)
    assert.deepEqual(res.data, { id: 't-gone', discarded: true }, name)
    assert.ok(!('todoId' in res.data), `${name}: the card id is under \`id\`, as in the answer of a dispatch that went through`)
  }
})

// ---- 2c. a finished card is not started again by an instruction left in its queue -------------------------

const QUEUE_DROPPED = '已移出队列'

// A building card whose worker is busy, with one instruction waiting in the queue.
async function buildingWithQueued(ctx) {
  const made = await buildingTodo(ctx)
  const sent = await ctx.orch.messageTodo(ctx.run, { todoId: made.todo.id, note: '顺便把文档也改了' })
  assert.equal(sent.queued, true, 'the instruction waits for the running turn')
  assert.equal(queueOf(ctx, made.todo.id).length, 1)
  return made
}

const turnEvent = (ctx, type, sessionId) => ctx.orch.handleHostEvent({ type, data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)

test('v0.9.49: closing a card with a queued instruction does not start it again when the stopped turn is reported', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await buildingWithQueued(ctx)
    const runsBefore = ctx.calls.run
    const createsBefore = ctx.calls.create
    const closed = await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')
    assert.equal(queueOf(ctx, todo.id).length, 0, 'closing emptied the queue at once')

    await turnEvent(ctx, 'chat.run.stopped', todo.buildSessionId)
    await tick(800)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'closed', 'the card was not started again')
    assert.equal(ctx.calls.run, runsBefore, 'no run was started')
    assert.equal(ctx.calls.create, createsBefore, 'no session was created')
    assert.equal(queueOf(ctx, todo.id).length, 0)
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(QUEUE_DROPPED)).length, 1, 'the dropped instruction is on the timeline once')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(QUEUE_DROPPED) && e.includes('任务已结束') && e.includes('顺便把文档也改了')))
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('送达排队的指令')))
    assert.equal(dispatchLines(ctx, todo.id).length, 1, 'only the first dispatch')
    assert.equal(cur.worktreePath, '', 'the released worktree was not created again')
    assert.equal(existsSync(todo.worktreePath), false)
    assert.ok(hasBranch(project.repoPath, todo.branch), 'the branch is kept, as close always did')
  } finally { ctx.cleanup() }
})

test('v0.9.49: a card that is done or closed is not started again by an instruction still in its queue (settle alone)', async () => {
  for (const phase of ['done', 'closed']) {
    for (const type of ['chat.run.completed', 'chat.run.stopped']) {
      const ctx = setup()
      try {
        // The card reached the end with the instruction still queued (no entry emptied the queue).
        const { todo } = await buildingWithQueued(ctx)
        patch(ctx, todo.id, { phase, gateOwner: 'none', gateKind: 'none', buildRunId: '' })
        ctx.sessions.get(todo.buildSessionId).is_running = false
        const runsBefore = ctx.calls.run
        await turnEvent(ctx, type, todo.buildSessionId)
        await tick(300)
        const cur = get(ctx, todo.id)
        assert.equal(cur.phase, phase, `${phase} / ${type}: not started again`)
        assert.equal(ctx.calls.run, runsBefore, `${phase} / ${type}: no run`)
        assert.equal(queueOf(ctx, todo.id).length, 0, `${phase} / ${type}: queue emptied`)
        assert.equal(timeline(ctx, todo.id).filter(e => e.includes(QUEUE_DROPPED) && e.includes('任务已结束')).length, 1, `${phase} / ${type}: dropped once`)
        assert.ok(!timeline(ctx, todo.id).some(e => e.includes('送达排队的指令')), `${phase} / ${type}: not delivered`)
        assert.equal(dispatchLines(ctx, todo.id).length, 1)
      } finally { ctx.cleanup() }
    }
  }
})

test('v0.9.49: stopping a card empties its queue at once; the instruction is not delivered when the stop is reported', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingWithQueued(ctx)
    const runsBefore = ctx.calls.run
    const stopped = await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })
    assert.equal(stopped.phase, 'todo')
    assert.equal(queueOf(ctx, todo.id).length, 0, 'stopping emptied the queue at once')
    await turnEvent(ctx, 'chat.run.stopped', todo.buildSessionId)
    await tick(300)
    assert.equal(get(ctx, todo.id).phase, 'todo', 'the stopped card was not started again')
    assert.equal(ctx.calls.run, runsBefore)
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes(QUEUE_DROPPED)).length, 1)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes(QUEUE_DROPPED) && e.includes('任务已停止')))
  } finally { ctx.cleanup() }
})

test('v0.9.49: a queued instruction is still delivered when the turn of a card that goes on ends', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingWithQueued(ctx)
    const runsBefore = ctx.calls.run
    ctx.sessions.get(todo.buildSessionId).is_running = false
    await turnEvent(ctx, 'chat.run.completed', todo.buildSessionId)
    await waitFor(() => ctx.calls.run === runsBefore + 1, 'the queued instruction to be delivered')
    assert.equal(queueOf(ctx, todo.id).length, 0)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('送达排队的指令')))
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(QUEUE_DROPPED)))
    assert.equal(get(ctx, todo.id).phase, 'building')
  } finally { ctx.cleanup() }
})

// ---- 3. cancel / close / reopen are in the lock; a merging card is protected ------------------------------

test('v0.9.49: while a card is merging, cancel with discard and close are refused; worktree and branch stay', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    const merging = ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    merging.catch(() => {})
    assert.equal(get(ctx, todo.id).phase, 'merging')
    const stopsBefore = ctx.calls.stop

    const errCancel = await rejection(ctx.orch.cancelBuild(ctx.run, { todoId: todo.id, discard: true }))
    assert.ok(errCancel, 'cancel with discard is refused')
    assert.match(errCancel.message, /任务正在合并，完成后再操作/)
    let cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'merging')
    assert.equal(cur.worktreePath, todo.worktreePath)
    assert.equal(cur.branch, todo.branch)
    assert.ok(hasBranch(project.repoPath, todo.branch), 'the branch was not deleted under the merge')
    assert.equal(ctx.calls.stop, stopsBefore, 'no session was stopped by the refused cancel')

    // A plain stop cannot stop a git merge either: refused while the merge is running.
    const errStop = await rejection(ctx.orch.cancelBuild(ctx.run, { todoId: todo.id }))
    assert.ok(errStop, 'a plain stop is refused while the merge runs')
    assert.equal(get(ctx, todo.id).phase, 'merging')

    const errClose = await rejection(ctx.orch.closeTodo(ctx.run, { todoId: todo.id }))
    assert.ok(errClose, 'close is refused')
    assert.match(errClose.message, /任务正在合并，完成后再操作/)
    assert.equal(get(ctx, todo.id).phase, 'merging')

    const merged = await merging
    assert.equal(merged.phase, 'done', 'the merge was not disturbed')
    assert.equal(readFileSync(join(project.repoPath, 'a.txt'), 'utf8'), 'feature side\n')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes(DISCARDED)))
  } finally { ctx.cleanup() }
})

test('v0.9.49: a card left in merging (no live merge) refuses discard and close, and a plain stop still frees it', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    patch(ctx, todo.id, { phase: 'merging', gateOwner: 'chief', gateKind: 'merge' })

    const errCancel = await rejection(ctx.orch.cancelBuild(ctx.run, { todoId: todo.id, discard: true }))
    assert.ok(errCancel)
    assert.match(errCancel.message, /任务正在合并，完成后再操作/)
    assert.ok(existsSync(todo.worktreePath), 'the worktree was not removed')
    assert.ok(hasBranch(project.repoPath, todo.branch), 'the branch was not deleted')
    assert.equal(get(ctx, todo.id).worktreePath, todo.worktreePath)
    assert.equal(get(ctx, todo.id).phase, 'merging')

    const errClose = await rejection(ctx.orch.closeTodo(ctx.run, { todoId: todo.id }))
    assert.ok(errClose)
    assert.match(errClose.message, /任务正在合并，完成后再操作/)
    assert.equal(get(ctx, todo.id).phase, 'merging')

    // The way out of a stuck `merging` card is unchanged: stop without discard.
    const freed = await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })
    assert.equal(freed.phase, 'review')
    assert.ok(existsSync(todo.worktreePath))
    assert.equal(freed.branch, todo.branch)
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.49: cancel, close and reopen are refused while another write holds the card, and change nothing', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    const g = gate()
    ctx.flags.createGate = g.promise
    const hung = ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    hung.catch(() => {})
    await tick()
    assert.ok(ctx.orch.todoWriteLocks.get(todo.id), 'the review dispatch holds the lock')
    const before = get(ctx, todo.id)

    for (const [name, call] of [
      ['cancel', () => ctx.orch.cancelBuild(ctx.run, { todoId: todo.id, discard: true })],
      ['close', () => ctx.orch.closeTodo(ctx.run, { todoId: todo.id })],
      ['reopen', () => ctx.orch.reopenTodo(ctx.run, { todoId: todo.id })],
    ]) {
      const err = await rejection(call())
      assert.ok(err, `${name} is refused`)
      assert.equal(err.code, 'TODO_BUSY', `${name}: ${err.message}`)
      assert.match(err.message, /正在执行「审查派发」/)
      const cur = get(ctx, todo.id)
      assert.equal(cur.revision, before.revision, `${name} changed nothing`)
      assert.equal(cur.phase, 'review')
      assert.ok(existsSync(todo.worktreePath), `${name} left the worktree`)
      assert.ok(hasBranch(project.repoPath, todo.branch), `${name} left the branch`)
    }

    ctx.flags.createGate = null
    g.open()
    assert.equal((await hung).phase, 'reviewing')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.49: cancel, close and reopen release the lock, whether they go through or are refused by the state machine', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    assert.equal((await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })).phase, 'todo')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
    // REOPEN is not a way out of `todo`: refused, lock released.
    await assert.rejects(ctx.orch.reopenTodo(ctx.run, { todoId: todo.id }), /REOPEN is not allowed/)
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
    assert.equal((await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })).phase, 'closed')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
    await assert.rejects(ctx.orch.closeTodo(ctx.run, { todoId: todo.id }), /CLOSE is not allowed/)
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
    assert.equal((await ctx.orch.reopenTodo(ctx.run, { todoId: todo.id })).phase, 'todo')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.49: an instruction followed by a stop on the same card goes through (no deadlock between the two)', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const runIdBefore = todo.buildRunId
    const sent = await ctx.orch.messageTodo(ctx.run, { todoId: todo.id, note: '再补一个边界用例' })
    assert.ok(!sent.queued && !sent.duplicate)
    // Under load the instruction answers with launchPending before the card is written.
    await launched(ctx, todo.id, runIdBefore)
    assert.equal(get(ctx, todo.id).phase, 'building')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false, 'the launch released the lock')
    const stopped = await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })
    assert.equal(stopped.phase, 'todo')
    // Both at once: the launch holds the lock, the stop is refused and can be repeated afterwards.
    const g = gate()
    ctx.flags.runGate = g.promise
    const launching = ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, extraMessage: '继续' })
    await tick()
    const err = await rejection(ctx.orch.cancelBuild(ctx.run, { todoId: todo.id }))
    assert.ok(err, 'refused, not waiting')
    assert.equal(err.code, 'TODO_BUSY')
    ctx.flags.runGate = null
    g.open()
    assert.equal((await launching).phase, 'building')
    assert.equal((await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id })).phase, 'todo')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

// ---- 4. retry_merge: caller and worktree -----------------------------------------------------------------

async function failedMergeCard(ctx) {
  const made = await reviewCard(ctx)
  writeFileSync(join(made.project.repoPath, 'a.txt'), 'main side\n')
  git(made.project.repoPath, 'commit', '-am', 'main moved')
  await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: made.todo.id, caller: 'user' }))
  return { ...made, todo: get(ctx, made.todo.id) }
}

const retryLine = ctx => e => String(e.event || '').includes('重新进入合并关口（保留上次审查结论）')

test('v0.9.49: the retry_merge timeline line names the Chief when the Chief called it, the user otherwise', async () => {
  const ctx = setup()
  try {
    const { todo } = await failedMergeCard(ctx)
    await ctx.orch.retryMerge(ctx.run, { todoId: todo.id, caller: 'chief' })
    let lines = get(ctx, todo.id).timeline.filter(retryLine(ctx))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].actor, 'chief')

    patch(ctx, todo.id, { phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError: '合并失败：x' })
    await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })
    lines = get(ctx, todo.id).timeline.filter(retryLine(ctx))
    assert.equal(lines.length, 2)
    assert.equal(lines[1].actor, 'user')

    // The MCP tool is the Chief's entry; the RPC is the user's.
    const tools = new Map()
    const seen = []
    const { registerMcpTools } = await import('../src/server/mcp-tools.mjs')
    registerMcpTools({ extensions: { tools: { register(def) { tools.set(def.name, def); return () => {} } } } }, {
      db: {},
      orchestrator: { async retryMerge(_run, args) { seen.push(args); return { id: args.todoId, number: 7, phase: 'review', gateOwner: 'human', evidence: {} } } },
    })
    await tools.get('retry_merge').execute({ todo_id: 't1' }, {})
    assert.deepEqual(seen, [{ todoId: 't1', caller: 'chief' }])
  } finally { ctx.cleanup() }
})

test('v0.9.49: retry_merge refuses a worktree path that is a file, not a directory', async () => {
  const ctx = setup()
  try {
    const { todo } = await failedMergeCard(ctx)
    const file = join(ctx.root, 'not-a-directory')
    writeFileSync(file, 'x\n')
    patch(ctx, todo.id, { worktreePath: file })
    const err = await rejection(ctx.orch.retryMerge(ctx.run, { todoId: todo.id }))
    assert.ok(err, 'a file is not a worktree')
    assert.match(err.message, /工作树/)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'failed')
    assert.ok(cur.lastError.startsWith('合并失败'))
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('重试合并没有执行')))
    // The real directory is accepted.
    patch(ctx, todo.id, { worktreePath: todo.worktreePath })
    assert.equal((await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })).phase, 'review')
  } finally { ctx.cleanup() }
})

test('v0.9.49: who holds the merge gate after a build is unchanged (shared rule with retry_merge)', async () => {
  const ctx = setup()
  try {
    // Topic AUTO on, project auto-merge on, passing test gate: the Chief holds the gate.
    const { todo, project } = await buildingTodo(ctx, { autopilot: true })
    await ctx.orch.updateProject(ctx.run, { id: project.id, autopilot: { autoMergeAfterReview: true } })
    commitWork(todo)
    let atGate = await endTurn(ctx, todo.id)
    assert.equal(atGate.phase, 'review')
    assert.equal(atGate.gateOwner, 'chief')
    assert.equal(atGate.gateKind, 'merge')

    // A failing test gate keeps it with the user.
    await ctx.orch.updateProject(ctx.run, { id: project.id, testCommand: 'false' })
    const runIdBefore = get(ctx, todo.id).buildRunId
    await ctx.orch.messageTodo(ctx.run, { todoId: todo.id, note: '再改一处' })
    // The turn can only end once its launch is on the card: a settle that arrives while the launch still
    // holds the lock is dropped, and the gate owner of the round before would be read.
    await launched(ctx, todo.id, runIdBefore)
    commitWork(get(ctx, todo.id), 'feature side 2\n')
    atGate = await endTurn(ctx, todo.id)
    assert.equal(atGate.phase, 'review')
    assert.equal(atGate.gateOwner, 'human')
  } finally { ctx.cleanup() }
})

// ---- docs and version ------------------------------------------------------------------------------------

test('v0.9.49: CONTRACTS.md lists every entry that takes the write lock', () => {
  const doc = readFileSync(new URL('../docs/CONTRACTS.md', import.meta.url), 'utf8')
  const section = doc.slice(doc.indexOf('since 0.9.49'))
  assert.ok(doc.includes('since 0.9.49'), 'a 0.9.49 section exists')
  for (const name of ['startBuild', 'runIndependentReview', 'mergeBuild', 'retryMerge', 'completeTodo', 'deleteTodo', 'cancelBuild', 'closeTodo', 'reopenTodo', 'dispatchInstruction']) {
    assert.ok(section.includes(`\`${name}\``), `${name} is named`)
  }
  assert.ok(section.includes(DISCARDED), 'the discard line is documented')
})

test('v0.9.49: version is 0.9.49 or later in the five places, changelog starts with it and keeps the older sections', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const contract = JSON.parse(read('contracts/plugin.json'))
  const [major, minor, patchNo] = pkg.version.split('.').map(Number)
  assert.ok(major > 0 || minor > 9 || (minor === 9 && patchNo >= 49), `version ${pkg.version} is 0.9.49 or later`)
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(contract.description.includes(`v${pkg.version} `))
  const changelog = read('CHANGELOG.md')
  for (const v of ['0.9.49', '0.9.48', '0.9.47', '0.9.46']) assert.ok(changelog.includes(`## [${v}]`), `CHANGELOG has a ${v} section`)
  assert.ok(changelog.indexOf('## [0.9.49]') < changelog.indexOf('## [0.9.48]'))
  // The tool count is what it was: this version adds no tool.
  assert.equal(Object.keys(contract.tools).length, 32)
})

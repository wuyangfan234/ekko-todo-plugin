// v0.9.48 (#34): the merge gate survives a failed merge. A card whose merge failed keeps its review verdict,
// branch and worktree and can be put back at the merge gate (`retry_merge`) without a rebuild or a second
// review; write operations on one card (build dispatch, review dispatch, merge, complete, delete, retry)
// exclude each other through one in-process lock that expires on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { canTransition, transitionTodoPhase } from '../src/server/state-machine.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-mergegate-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0 }
  // createGate: while set, sessions.create waits for this promise (a launch that hangs inside the host).
  const flags = { createGate: null }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
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
        calls.run += 1
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
const SUMMARY = 'VERDICT: APPROVED\n逻辑正确，测试充分。'

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const patch = (ctx, id, p) => ctx.db.updateTodo(1, 'default', id, p)

async function buildingTodo(ctx, { autopilot = false, autoMerge = false, testCommand = 'true' } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '合并关口测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '合并关口测试 Agent')
  const added = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand })
  const project = autoMerge
    ? (await orch.updateProject(run, { id: added.project.id, autopilot: { autoMergeAfterReview: true } })).project
    : added.project
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id, withPlan: false })
  assert.equal(built.phase, 'building')
  return { todo: built, project, topic }
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

// A card at the merge gate with a committed change and an APPROVED independent review.
async function reviewCard(ctx, opts = {}) {
  const { todo, project, topic } = await buildingTodo(ctx, opts)
  writeFileSync(join(todo.worktreePath, 'a.txt'), 'feature side\n')
  git(todo.worktreePath, 'commit', '-am', 'work')
  const atGate = await endTurn(ctx, todo.id)
  assert.equal(atGate.phase, 'review')
  patch(ctx, todo.id, { evidence: { reviewVerdict: 'approved', reviewSummary: SUMMARY } })
  return { todo: get(ctx, todo.id), project, topic }
}

// The base branch moves on the same line, so merging the task branch conflicts.
function conflictOnMain(project) {
  writeFileSync(join(project.repoPath, 'a.txt'), 'main side\n')
  git(project.repoPath, 'commit', '-am', 'main moved')
}

async function failedMergeCard(ctx, opts = {}) {
  const made = await reviewCard(ctx, opts)
  conflictOnMain(made.project)
  await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: made.todo.id, caller: 'user' }))
  return { ...made, todo: get(ctx, made.todo.id) }
}

async function rejection(promise) {
  try { await promise } catch (err) { return err }
  return null
}

const needRetryMerge = ctx => assert.equal(typeof ctx.orch.retryMerge, 'function', 'the orchestrator offers retryMerge')

// ---- 1. a failed merge keeps the review verdict and everything a retry needs ------------------------------

test('v0.9.48: a failed merge keeps the review verdict, branch and worktree, and says it can be retried', async () => {
  const ctx = setup()
  try {
    const before = (await reviewCard(ctx)).todo
    const project = ctx.db.getProject(1, 'default', before.projectId)
    const mainHead = git(project.repoPath, 'rev-parse', 'HEAD')
    conflictOnMain(project)
    const mainAfterMove = git(project.repoPath, 'rev-parse', 'HEAD')
    assert.notEqual(mainAfterMove, mainHead)
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: before.id, caller: 'user' }), /Merge conflict/)
    const after = get(ctx, before.id)
    assert.equal(after.phase, 'failed')
    assert.equal(after.gateKind, 'failed')
    assert.equal(after.gateOwner, 'human')
    assert.equal(after.evidence.reviewVerdict, 'approved', 'the review verdict is not reset')
    assert.equal(after.evidence.reviewSummary, SUMMARY, 'the review summary is unchanged')
    assert.equal(after.evidence.commitSha, before.evidence.commitSha)
    assert.equal(after.evidence.testRc, before.evidence.testRc)
    assert.equal(after.branch, before.branch)
    assert.equal(after.worktreePath, before.worktreePath)
    assert.equal(after.snapshotSha, before.snapshotSha)
    assert.deepEqual(after.diffs, before.diffs)
    assert.ok(existsSync(after.worktreePath), 'the worktree is still on disk')
    assert.ok(git(project.repoPath, 'branch', '--list', after.branch).includes(after.branch), 'the task branch is still there')
    assert.equal(git(project.repoPath, 'rev-parse', 'HEAD'), mainAfterMove, 'the main checkout is not left half merged')
    assert.equal(git(project.repoPath, 'status', '--porcelain'), '')
    assert.ok(after.lastError.startsWith('合并失败'), after.lastError)
    assert.ok(after.lastError.includes('retry_merge'), `the error names the way back: ${after.lastError}`)
    // The file list this version puts in front of the raw git error (which names a.txt on its own as well).
    assert.ok(after.lastError.includes('冲突文件：a.txt；'), `the error lists the conflicting file: ${after.lastError}`)
    assert.ok(after.lastError.startsWith('合并失败（冲突文件：a.txt；处理后可调用 retry_merge 回到合并关口，审查结论保留）：'), after.lastError)
    assert.ok(timeline(ctx, before.id).includes(after.lastError), 'the timeline carries the same text')
  } finally { ctx.cleanup() }
})

test('v0.9.48: a merge with several conflicting files lists each of them once', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await buildingTodo(ctx)
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'feature side\n')
    writeFileSync(join(todo.worktreePath, 'b.txt'), 'feature b\n')
    git(todo.worktreePath, 'add', '.'); git(todo.worktreePath, 'commit', '-m', 'work')
    assert.equal((await endTurn(ctx, todo.id)).phase, 'review')
    writeFileSync(join(project.repoPath, 'a.txt'), 'main side\n')
    writeFileSync(join(project.repoPath, 'b.txt'), 'main b\n')
    git(project.repoPath, 'add', '.'); git(project.repoPath, 'commit', '-m', 'main moved')
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    const { lastError } = get(ctx, todo.id)
    const listed = /^合并失败（冲突文件：([^；]+)；处理后可调用 retry_merge/.exec(lastError)
    assert.ok(listed, lastError)
    assert.deepEqual(listed[1].split('、').sort(), ['a.txt', 'b.txt'])
  } finally { ctx.cleanup() }
})

test('v0.9.48: a merge that failed without a conflict names no conflicting files and can still be retried', async () => {
  const ctx = setup()
  try {
    needRetryMerge(ctx)
    const { todo, project } = await reviewCard(ctx)
    // The main checkout is dirty: the merge is refused before git merges anything.
    const stray = join(project.repoPath, 'stray.txt')
    writeFileSync(stray, 'left behind\n')
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }), /uncommitted changes/)
    const failed = get(ctx, todo.id)
    assert.equal(failed.phase, 'failed')
    assert.ok(!failed.lastError.includes('CONFLICT'), failed.lastError)
    assert.ok(!failed.lastError.includes('冲突文件'), `no file list without a conflict: ${failed.lastError}`)
    assert.ok(failed.lastError.startsWith('合并失败（处理后可调用 retry_merge 回到合并关口，审查结论保留）：'), failed.lastError)
    assert.equal(failed.evidence.reviewVerdict, 'approved')
    rmSync(stray)
    assert.equal((await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })).phase, 'review')
    assert.equal((await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })).phase, 'done')
  } finally { ctx.cleanup() }
})

// ---- 2. retry_merge: back at the merge gate with the verdict intact --------------------------------------

test('v0.9.48: retry_merge puts a merge-failed card back at the merge gate without touching the review verdict', async () => {
  const ctx = setup()
  try {
    needRetryMerge(ctx)
    const { todo } = await failedMergeCard(ctx)
    assert.equal(todo.phase, 'failed')
    const evidenceBefore = JSON.parse(JSON.stringify(todo.evidence))
    const retried = await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })
    assert.equal(retried.phase, 'review')
    assert.equal(retried.evidence.reviewVerdict, 'approved')
    assert.equal(retried.evidence.reviewSummary, SUMMARY)
    assert.deepEqual(retried.evidence, evidenceBefore, 'evidence is carried over as it was')
    assert.equal(retried.lastError, '')
    assert.equal(retried.gateKind, 'merge')
    assert.equal(retried.gateOwner, 'human', 'topic AUTO is off: the user holds the gate')
    assert.equal(retried.branch, todo.branch)
    assert.equal(retried.worktreePath, todo.worktreePath)
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes('重新进入合并关口（保留上次审查结论）')).length, 1)
    assert.equal(ctx.calls.run, 1, 'no build or review run was started by the retry')
    // The retry does not merge by itself.
    assert.equal(get(ctx, todo.id).phase, 'review')
  } finally { ctx.cleanup() }
})

test('v0.9.48: after retry_merge the same merge goes through once the conflict is gone', async () => {
  const ctx = setup()
  try {
    needRetryMerge(ctx)
    const { todo, project } = await failedMergeCard(ctx)
    // The task branch takes the base branch in and resolves the conflict.
    try { git(todo.worktreePath, 'merge', 'main') } catch {}
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'feature side on top of main\n')
    git(todo.worktreePath, 'commit', '-am', 'resolve')
    await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })
    const merged = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    assert.equal(merged.phase, 'done')
    assert.equal(merged.evidence.reviewVerdict, 'approved')
    assert.equal(readFileSync(join(project.repoPath, 'a.txt'), 'utf8'), 'feature side on top of main\n')
  } finally { ctx.cleanup() }
})

test('v0.9.48: failed has a way back to review in the state machine, only through RETRY_MERGE', () => {
  assert.equal(canTransition('failed', 'RETRY_MERGE'), true)
  assert.equal(transitionTodoPhase('failed', 'RETRY_MERGE'), 'review')
  for (const phase of ['todo', 'queued', 'confirm', 'building', 'reviewing', 'merging', 'review', 'done', 'closed']) {
    assert.equal(canTransition(phase, 'RETRY_MERGE'), false, `${phase} has no RETRY_MERGE`)
  }
})

// ---- 3. only merge failures can be retried ---------------------------------------------------------------

test('v0.9.48: retry_merge refuses a card that failed for another reason (build failure, idle round)', async () => {
  const ctx = setup()
  try {
    needRetryMerge(ctx)
    // (a) an idle round: the real #36 failure, lastError starts with 「本轮没有产生任何提交」.
    const { todo } = await buildingTodo(ctx)
    let idle = await endTurn(ctx, todo.id, 'Base is current.')
    // 0.9.57/0.9.64: idle rounds are resumed up to 3 times in the same session; the nudged rounds idle too.
    for (let i = 0; i < 3 && idle.phase === 'building'; i += 1) idle = await endTurn(ctx, todo.id, 'Base is current.')
    assert.equal(idle.phase, 'failed')
    assert.ok(idle.lastError.startsWith('本轮没有产生任何提交'), idle.lastError)
    const errIdle = await rejection(ctx.orch.retryMerge(ctx.run, { todoId: todo.id }))
    assert.ok(errIdle, 'an idle failure is refused')
    assert.match(errIdle.message, /合并失败/)
    let cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'failed')
    assert.equal(cur.gateKind, 'failed')
    assert.equal(cur.lastError, idle.lastError)
    assert.deepEqual(cur.evidence, idle.evidence)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('重试合并') && e.includes('没有执行')), 'the refusal is on the timeline')

    // (b) a build failure, and the other two idle wordings.
    for (const lastError of ['主备模型均失败：upstream 503', '有改动未提交，且 HEAD 未前进（abc）', '本轮被停止，没有产出']) {
      patch(ctx, todo.id, { phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError, evidence: { reviewVerdict: 'approved' } })
      const err = await rejection(ctx.orch.retryMerge(ctx.run, { todoId: todo.id }))
      assert.ok(err, `refused: ${lastError}`)
      cur = get(ctx, todo.id)
      assert.equal(cur.phase, 'failed')
      assert.equal(cur.lastError, lastError)
    }

    // (c) a card that is not failed at all.
    patch(ctx, todo.id, { phase: 'review', gateOwner: 'human', gateKind: 'merge', lastError: '合并失败：x' })
    assert.ok(await rejection(ctx.orch.retryMerge(ctx.run, { todoId: todo.id })))
    assert.equal(get(ctx, todo.id).phase, 'review')
    assert.equal(get(ctx, todo.id).lastError, '合并失败：x')
  } finally { ctx.cleanup() }
})

// ---- 4. the worktree must still exist --------------------------------------------------------------------

test('v0.9.48: retry_merge refuses when the worktree or branch is gone and does not recreate it', async () => {
  const ctx = setup()
  try {
    needRetryMerge(ctx)
    const { todo } = await failedMergeCard(ctx)
    const gone = join(ctx.root, 'no-such-worktree')
    patch(ctx, todo.id, { worktreePath: gone })
    const err = await rejection(ctx.orch.retryMerge(ctx.run, { todoId: todo.id }))
    assert.ok(err)
    assert.match(err.message, /工作树/)
    assert.match(err.message, /重新构建/)
    let cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'failed')
    assert.equal(cur.worktreePath, gone)
    assert.equal(existsSync(gone), false, 'nothing was created at the missing path')
    assert.ok(cur.lastError.startsWith('合并失败'))

    patch(ctx, todo.id, { worktreePath: '' })
    assert.ok(await rejection(ctx.orch.retryMerge(ctx.run, { todoId: todo.id })))
    assert.equal(get(ctx, todo.id).phase, 'failed')

    patch(ctx, todo.id, { worktreePath: todo.worktreePath, branch: '' })
    assert.ok(await rejection(ctx.orch.retryMerge(ctx.run, { todoId: todo.id })))
    cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'failed')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
  } finally { ctx.cleanup() }
})

// ---- 5. the retry is not a way around the review gate ----------------------------------------------------

test('v0.9.48: after retry_merge the Chief merge is still checked by assertMergeAllowed', async () => {
  const ctx = setup()
  try {
    needRetryMerge(ctx)
    const { todo } = await failedMergeCard(ctx, { autopilot: true, autoMerge: true })
    await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })
    patch(ctx, todo.id, { evidence: { reviewVerdict: 'none' } })
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }))
    assert.ok(err, 'the Chief merge is refused')
    assert.match(err.message, /拒绝合并/)
    assert.match(err.message, /独立审查结论为「none」/)
    assert.equal(get(ctx, todo.id).phase, 'review')
  } finally { ctx.cleanup() }
})

// ---- 6. who holds the gate after a retry -----------------------------------------------------------------

test('v0.9.48: after retry_merge a gateSkipped card and a failed test gate stay with the user', async () => {
  const ctx = setup()
  try {
    needRetryMerge(ctx)
    // Topic AUTO on and project auto-merge on: nothing but the card itself can make the gate human.
    const { todo } = await reviewCard(ctx, { autopilot: true, autoMerge: true })
    const mergeFailed = { phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError: '合并失败：Main repository working tree has uncommitted changes.' }

    // Control: a clean approved card with a passing test gate goes back to the Chief.
    patch(ctx, todo.id, { ...mergeFailed, evidence: { reviewVerdict: 'approved', testRc: 0, gateSkipped: '' } })
    let retried = await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })
    assert.equal(retried.phase, 'review')
    assert.equal(retried.gateOwner, 'chief')
    assert.equal(retried.gateKind, 'merge')

    // The #36 card: no snapshot, test gate skipped.
    patch(ctx, todo.id, { ...mergeFailed, evidence: { reviewVerdict: 'approved', testRc: -1, gateSkipped: 'no-snapshot' } })
    retried = await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })
    assert.equal(retried.phase, 'review')
    assert.equal(retried.gateOwner, 'human', 'gateSkipped keeps the gate with the user')
    assert.equal(retried.evidence.gateSkipped, 'no-snapshot')
    assert.equal(retried.evidence.testRc, -1)

    // gateSkipped alone (test result says 0) is enough.
    patch(ctx, todo.id, { ...mergeFailed, evidence: { reviewVerdict: 'approved', testRc: 0, gateSkipped: 'no-snapshot' } })
    assert.equal((await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })).gateOwner, 'human')

    // A failed test gate alone is enough.
    patch(ctx, todo.id, { ...mergeFailed, evidence: { reviewVerdict: 'approved', testRc: 1, gateSkipped: '' } })
    assert.equal((await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })).gateOwner, 'human')

    // The project setting is read when the retry happens: auto-merge switched off in between.
    patch(ctx, todo.id, { ...mergeFailed, evidence: { reviewVerdict: 'approved', testRc: 0, gateSkipped: '' } })
    await ctx.orch.updateProject(ctx.run, { id: todo.projectId, autopilot: { autoMergeAfterReview: false } })
    assert.equal((await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })).gateOwner, 'human')
    // ... and the merge itself reads it again, whatever gateOwner says.
    patch(ctx, todo.id, { gateOwner: 'chief' })
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }))
    assert.match(err.message, /未允许审查通过后由总管合并/)
    assert.equal(get(ctx, todo.id).phase, 'review')
  } finally { ctx.cleanup() }
})

test('v0.9.48: a deploy card whose merge failed comes back as a deploy gate held by the user', async () => {
  const ctx = setup()
  try {
    needRetryMerge(ctx)
    // Topic AUTO on and project auto-merge on: only the card being a deploy card keeps the gate with the user.
    const { todo, project } = await reviewCard(ctx, { autopilot: true, autoMerge: true })
    patch(ctx, todo.id, { kind: 'deploy', gateOwner: 'human', gateKind: 'deploy', evidence: { testRc: 0, gateSkipped: '' } })
    assert.equal(get(ctx, todo.id).kind, 'deploy')
    conflictOnMain(project)
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }), /Merge conflict/)
    const failed = get(ctx, todo.id)
    assert.equal(failed.phase, 'failed')
    assert.equal(failed.gateKind, 'failed')
    const retried = await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })
    assert.equal(retried.phase, 'review')
    assert.equal(retried.gateKind, 'deploy')
    assert.equal(retried.gateOwner, 'human')
    assert.equal(retried.evidence.reviewVerdict, 'approved')
    // The Chief cannot merge it after the retry either.
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }))
    assert.match(err.message, /部署类任务必须由用户放行/)
    assert.equal(get(ctx, todo.id).phase, 'review')
  } finally { ctx.cleanup() }
})

// ---- 7. a card that is merging takes no other write ------------------------------------------------------

test('v0.9.48: while a card is merging, complete and build dispatch are refused and leave it untouched', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const merging = ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    const during = get(ctx, todo.id)
    assert.equal(during.phase, 'merging')

    const errComplete = await rejection(ctx.orch.completeTodo(ctx.run, { todoId: todo.id }))
    assert.ok(errComplete, 'complete is refused')
    assert.match(errComplete.message, /任务正在合并，完成后再操作/)
    assert.equal(get(ctx, todo.id).phase, 'merging')

    const errBuild = await rejection(ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, fresh: true }))
    assert.ok(errBuild, 'a build dispatch is refused')
    assert.match(errBuild.message, /正在/)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'merging')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.branch, todo.branch, 'a fresh restart did not drop the branch under the merge')
    assert.equal(cur.worktreePath, todo.worktreePath)

    const errDelete = await rejection(ctx.orch.deleteTodo(ctx.run, { todoId: todo.id }))
    assert.match(errDelete.message, /任务正在合并，完成后再删除/)

    const merged = await merging
    assert.equal(merged.phase, 'done', 'the merge itself was not disturbed')
    assert.equal(merged.evidence.reviewVerdict, 'approved')
  } finally { ctx.cleanup() }
})

test('v0.9.48: a card left in merging (no live merge) also refuses complete and a fresh build', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    patch(ctx, todo.id, { phase: 'merging', gateOwner: 'chief', gateKind: 'merge' })
    const errComplete = await rejection(ctx.orch.completeTodo(ctx.run, { todoId: todo.id }))
    assert.match(errComplete.message, /任务正在合并，完成后再操作/)
    const errBuild = await rejection(ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false, fresh: true }))
    assert.match(errBuild.message, /正在合并/)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'merging')
    assert.equal(cur.evidence.reviewVerdict, 'approved')
    assert.equal(cur.branch, todo.branch)
    assert.ok(existsSync(todo.worktreePath), 'the worktree was not removed')
  } finally { ctx.cleanup() }
})

// ---- 8. the lock expires on its own ----------------------------------------------------------------------

test('v0.9.48: a write lock older than its TTL no longer blocks the card', async () => {
  const ctx = setup()
  try {
    assert.ok(ctx.orch.todoWriteLocks instanceof Map, 'the orchestrator exposes its in-process lock table')
    assert.equal(ctx.orch.TODO_WRITE_LOCK_TTL_MS, 10 * 60 * 1000)
    const { todo } = await reviewCard(ctx)
    // A review dispatch that hangs inside the host keeps the lock.
    let openGate
    ctx.flags.createGate = new Promise(resolve => { openGate = resolve })
    const hung = ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    hung.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 150))
    const lock = ctx.orch.todoWriteLocks.get(todo.id)
    assert.ok(lock, 'the hung dispatch holds the lock')
    assert.equal(typeof lock.owner, 'string')
    assert.ok(lock.owner.length > 0)
    assert.equal(typeof lock.label, 'string')
    assert.ok(Math.abs(Date.now() - lock.acquiredAt) < 5000, 'acquiredAt is the time it was taken')

    const refused = await rejection(ctx.orch.completeTodo(ctx.run, { todoId: todo.id }))
    assert.ok(refused, 'a fresh lock blocks')
    assert.match(refused.message, /正在/)
    assert.equal(get(ctx, todo.id).phase, 'review')

    lock.acquiredAt = Date.now() - 11 * 60 * 1000
    const done = await ctx.orch.completeTodo(ctx.run, { todoId: todo.id })
    assert.equal(done.phase, 'done', 'the expired lock was taken over')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false, 'the new holder released it')

    // The hung dispatch ends later: it must not release a lock it no longer holds, nor leave one behind.
    ctx.flags.createGate = null
    openGate()
    await hung.catch(() => {})
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.48: the lock is released when the operation fails', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    conflictOnMain(ctx.db.getProject(1, 'default', todo.projectId))
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false, 'a failed merge leaves no lock')
    // A refused merge (not at the gate) leaves none either.
    await assert.rejects(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }), /只有构建完成/)
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
    await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

// ---- 9. two writes at once: one goes through, the other is told why --------------------------------------

test('v0.9.48: of two concurrent writes on one card one succeeds and the other is refused without changing the card', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const before = get(ctx, todo.id)
    const runsBefore = ctx.calls.run
    // Same tick: a review dispatch and "mark done".
    const reviewing = ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    const completing = ctx.orch.completeTodo(ctx.run, { todoId: todo.id })
    const refused = await rejection(completing)
    assert.ok(refused, 'the second write is refused')
    assert.match(refused.message, /正在/)
    assert.match(refused.message, new RegExp(`#${todo.number}`))
    // The refused call changed nothing: the card is exactly what it was.
    const atRefusal = get(ctx, todo.id)
    assert.equal(atRefusal.revision, before.revision, 'revision unchanged by the refused write')
    assert.deepEqual(atRefusal.evidence, before.evidence)
    assert.equal(atRefusal.phase, 'review')
    assert.deepEqual(atRefusal.timeline, before.timeline)

    const reviewed = await reviewing
    assert.equal(reviewed.phase, 'reviewing', 'the first write went through')
    assert.equal(ctx.calls.run, runsBefore + 1)
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

test('v0.9.48: two review dispatches at once start one review, the other is refused with a timeline note', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const runsBefore = ctx.calls.run
    const results = await Promise.allSettled([
      ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id }),
      ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id }),
    ])
    assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected'])
    const refused = results.find(r => r.status === 'rejected').reason
    assert.match(refused.message, /正在执行/)
    assert.equal(ctx.calls.run, runsBefore + 1, 'one review run, not two')
    assert.equal(get(ctx, todo.id).phase, 'reviewing')
    assert.equal(timeline(ctx, todo.id).filter(e => e.includes('正在执行') && e.includes('没有发出')).length, 1)
  } finally { ctx.cleanup() }
})

test('v0.9.48: an instruction to the worker still starts its run through the lock (no self-deadlock)', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    const runsBefore = ctx.calls.run
    const sent = await ctx.orch.messageTodo(ctx.run, { todoId: todo.id, note: '再补一个边界用例' })
    assert.ok(!sent.queued && !sent.duplicate)
    const cur = get(ctx, todo.id)
    assert.equal(cur.phase, 'building')
    assert.equal(ctx.calls.run, runsBefore + 1)
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false, 'the launch released the lock')
    // The next instruction (after the turn) goes through as well.
    writeFileSync(join(cur.worktreePath, 'a.txt'), 'feature side 2\n')
    git(cur.worktreePath, 'commit', '-am', 'more')
    assert.equal((await endTurn(ctx, todo.id)).phase, 'review')
    const again = await ctx.orch.requestChanges(ctx.run, { todoId: todo.id, note: '改一下命名' })
    assert.ok(!again.queued)
    assert.equal(get(ctx, todo.id).phase, 'building')
    assert.equal(ctx.orch.todoWriteLocks.has(todo.id), false)
  } finally { ctx.cleanup() }
})

// ---- contract, tool and version --------------------------------------------------------------------------

test('v0.9.48: retry-merge RPC and retry_merge tool are declared, registered and described', async () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const contract = JSON.parse(read('contracts/plugin.json'))
  assert.ok(contract.rpc['retry-merge'], 'RPC declared')
  assert.equal(contract.rpc['retry-merge'].output, 'stateSnapshot')
  const input = contract.models[contract.rpc['retry-merge'].input]
  assert.deepEqual(input.required, ['todoId'])
  assert.equal(input.additionalProperties, false)
  assert.ok(input.properties.todoId.description)
  assert.ok(contract.tools.retry_merge, 'tool declared')
  assert.match(contract.tools.retry_merge.description, /failed/)
  assert.match(contract.tools.retry_merge.description, /merge/i)

  const tools = new Map()
  const { registerMcpTools } = await import('../src/server/mcp-tools.mjs')
  registerMcpTools({ extensions: { tools: { register(def) { tools.set(def.name, def); return () => {} } } } }, { db: {}, orchestrator: {} })
  const tool = tools.get('retry_merge')
  assert.ok(tool, 'tool registered')
  assert.ok(tool.description.includes('仅当卡片因合并失败而停在 failed 时可用'), tool.description)
  assert.deepEqual(tool.inputSchema.required, ['todo_id'])
  assert.equal(tool.inputSchema.additionalProperties, false)
  assert.equal(tool.readOnly, false)
  // A refusal is an answer, not a thrown tool error; success reports the gate.
  const refusedOut = await tool.execute({ todo_id: 't1' }, {}).catch(err => ({ threw: err }))
  assert.equal(refusedOut.threw, undefined)
  assert.equal(refusedOut.ok, false)
  const okTool = new Map()
  registerMcpTools({ extensions: { tools: { register(def) { okTool.set(def.name, def); return () => {} } } } }, {
    db: {},
    orchestrator: { async retryMerge(_run, { todoId }) { return { id: todoId, number: 7, phase: 'review', gateOwner: 'human', evidence: { reviewVerdict: 'approved' } } } },
  })
  const okOut = await okTool.get('retry_merge').execute({ todo_id: 't1' }, {})
  assert.equal(okOut.ok, true)
  assert.deepEqual(okOut.data, { id: 't1', phase: 'review', gateOwner: 'human', reviewVerdict: 'approved' })

  assert.match(read('src/server/rpc-handlers.mjs'), /registerRpc\(ctx, contract, 'retry-merge'/)

  // The tool count the Chief is told is the number of tools that are registered and declared.
  assert.equal(tools.size, Object.keys(contract.tools).length)
  const { buildChiefInstructions } = await import('../src/server/prompts.mjs')
  const stated = /server — (\d+) tools\)/.exec(read('src/server/prompts.mjs'))
  assert.ok(stated, 'the Chief prompt states a tool count')
  assert.equal(Number(stated[1]), tools.size, 'the Chief prompt states the real tool count')
  assert.equal(typeof buildChiefInstructions, 'function')
  for (const src of ['src/server/index.mjs', 'src/server/mcp-tools.mjs']) {
    for (const m of read(src).matchAll(/(\d+) MCP tools/g)) assert.equal(Number(m[1]), tools.size, `${src} states the real tool count`)
  }
  assert.match(read('docs/CONTRACTS.md'), /retry-merge/)
  assert.match(read('docs/CONTRACTS.md'), /retry_merge/)
  assert.match(read('docs/CONTRACTS.md'), /RETRY_MERGE/)
})

test('v0.9.48: version is 0.9.48 or later and agrees across the five places, changelog keeps the older sections', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const contract = JSON.parse(read('contracts/plugin.json'))
  const [major, minor, patchNo] = pkg.version.split('.').map(Number)
  assert.ok(major > 0 || minor > 9 || (minor === 9 && patchNo >= 48), `version ${pkg.version} is 0.9.48 or later`)
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(contract.description.includes(`v${pkg.version} `))
  const changelog = read('CHANGELOG.md')
  for (const v of ['0.9.48', '0.9.47', '0.9.46', '0.9.45', '0.9.44']) {
    assert.ok(changelog.includes(`## [${v}]`), `CHANGELOG has a ${v} section`)
  }
  assert.ok(changelog.indexOf('## [0.9.48]') < changelog.indexOf('## [0.9.47]'))
})

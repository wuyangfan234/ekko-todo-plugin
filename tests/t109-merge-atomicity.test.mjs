// #109: what is merged is what was checked. Between the review binding (#103) and the merge (#102) nothing may
// slip in: a worktree that holds uncommitted changes is refused when the card has a snapshot or a reviewed
// commit (they are never committed by the merge any more), and the commit the caller expects (`expectedHeadSha`)
// must be the worktree HEAD. Only a card without any snapshot keeps the automatic commit, and it is written on
// the timeline. Every repository here is a real one made by `git init` in a temporary directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import * as gitEngine from '../src/server/git-engine.mjs'

const { mergeWorktreeBranch, ensureWorktree, captureWorktreeSnapshot } = gitEngine

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim()
const gitRc = (cwd, ...a) => {
  try { execFileSync('git', a, { cwd, stdio: 'pipe' }); return 0 } catch (err) { return err.status ?? 1 }
}
const isAncestor = (repo, a, b) => gitRc(repo, 'merge-base', '--is-ancestor', a, b) === 0
const branchExists = (repo, name) => gitRc(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`) === 0

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
  return repoPath
}

async function rejection(promise) {
  try { await promise } catch (err) { return err }
  return null
}

// ---- git-engine: mergeWorktreeBranch called directly ---------------------------------------------------------

async function engineCase(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-109-engine-'))
  try {
    const repoPath = makeRepo(root)
    const wt = await ensureWorktree({ repoPath, worktreesDir: join(root, 'wts'), worktreeName: 'card', branchName: 'ekko-todo/card', baseBranch: 'main' })
    await fn({ root, repoPath, wt, branch: wt.branchName, wtPath: wt.worktreePath })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function commitInWorktree(wtPath, content = 'feature\n', msg = 'work') {
  writeFileSync(join(wtPath, 'a.txt'), content)
  git(wtPath, 'commit', '-am', msg)
  return git(wtPath, 'rev-parse', 'HEAD')
}

const mergeArgs = (c, extra = {}) => ({ repoPath: c.repoPath, worktreePath: c.wtPath, branchName: c.branch, baseBranch: 'main', ...extra })

function assertKept(c, mainBefore) {
  assert.ok(existsSync(c.wtPath), 'the worktree is still there')
  assert.ok(branchExists(c.repoPath, c.branch), 'the branch is still there')
  assert.equal(git(c.repoPath, 'rev-parse', 'main'), mainBefore, 'main did not move')
  assert.equal(git(c.repoPath, 'status', '--porcelain'), '', 'the main checkout is clean')
}

test('#109 engine: expectedHeadSha is the worktree HEAD and the worktree is clean -> merged, nothing auto-committed', async () => {
  await engineCase(async c => {
    const head = commitInWorktree(c.wtPath)
    const merged = await mergeWorktreeBranch(mergeArgs(c, { snapshotSha: head.slice(0, 12), expectedHeadSha: head }))
    assert.equal(merged.verifiedSha, head)
    assert.equal(merged.expectedHeadSha, head)
    assert.equal(merged.autoCommittedCount, 0)
    assert.ok(isAncestor(c.repoPath, head, 'main'))
    assert.equal(existsSync(c.wtPath), false)
  })
})

test('#109 engine: uncommitted changes with expectedHeadSha -> refused with the file names, not committed, everything kept', async () => {
  await engineCase(async c => {
    const head = commitInWorktree(c.wtPath)
    writeFileSync(join(c.wtPath, 'a.txt'), 'edited after the review\n')
    writeFileSync(join(c.wtPath, 'late-file.txt'), 'never reviewed\n')
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { expectedHeadSha: head })))
    assert.ok(err, 'the merge is refused')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.equal(err.stage, 'pre')
    assert.match(err.message, /工作树在审查\/快照之后有 2 项未提交改动/)
    assert.match(err.message, /请先提交或清理再合并/)
    assert.ok(err.message.includes('a.txt') && err.message.includes('late-file.txt'), err.message)
    assert.equal(err.details.dirtyCount, 2)
    assert.deepEqual([...err.details.dirtyPaths].sort(), ['a.txt', 'late-file.txt'])
    assertKept(c, mainBefore)
    assert.equal(git(c.wtPath, 'rev-parse', 'HEAD'), head, 'no automatic commit was made')
    assert.equal(readFileSync(join(c.wtPath, 'late-file.txt'), 'utf8'), 'never reviewed\n', 'the change is not lost')
  })
})

test('#109 engine: uncommitted changes with a snapshot only (no expectedHeadSha) are refused the same way', async () => {
  await engineCase(async c => {
    const head = commitInWorktree(c.wtPath)
    writeFileSync(join(c.wtPath, 'late-file.txt'), 'after the snapshot\n')
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { snapshotSha: head.slice(0, 12) })))
    assert.equal(err?.code, 'MERGE_VERIFY_FAILED')
    assert.match(err.message, /工作树在审查\/快照之后有 1 项未提交改动（late-file\.txt），请先提交或清理再合并/)
    assertKept(c, mainBefore)
    assert.equal(git(c.wtPath, 'rev-parse', 'HEAD'), head)
  })
})

test('#109 engine: the refusal lists the first 5 changed files and the total', async () => {
  await engineCase(async c => {
    const head = commitInWorktree(c.wtPath)
    for (let i = 1; i <= 7; i += 1) writeFileSync(join(c.wtPath, `f${i}.txt`), `${i}\n`)
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { expectedHeadSha: head })))
    assert.equal(err?.code, 'MERGE_VERIFY_FAILED')
    assert.match(err.message, /有 7 项未提交改动（f1\.txt、f2\.txt、f3\.txt、f4\.txt、f5\.txt 等）/)
    assert.ok(!err.message.includes('f6.txt'), err.message)
    assert.equal(err.details.dirtyCount, 7)
  })
})

// Only expectedHeadSha refuses this one: the worktree is clean and HEAD contains the snapshot, which is the
// relation `ancestor` that #102 accepts.
test('#109 engine: a clean commit made after the expected one -> refused by expectedHeadSha, both shas named', async () => {
  await engineCase(async c => {
    const reviewed = commitInWorktree(c.wtPath, 'reviewed\n', 'reviewed')
    const later = commitInWorktree(c.wtPath, 'not reviewed\n', 'slipped in')
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { snapshotSha: reviewed.slice(0, 12), expectedHeadSha: reviewed })))
    assert.ok(err, 'the merge is refused')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.equal(err.stage, 'pre')
    assert.match(err.message, /工作树 HEAD=[0-9a-f]{12} 不是期望合并的提交 [0-9a-f]{12}/)
    assert.ok(err.message.includes(later.slice(0, 12)) && err.message.includes(reviewed.slice(0, 12)), err.message)
    assert.equal(err.details.expectedHeadSha, reviewed)
    assertKept(c, mainBefore)
    assert.equal(git(c.wtPath, 'rev-parse', 'HEAD'), later)
    // The same state without expectedHeadSha is what #102 alone lets through.
    const merged = await mergeWorktreeBranch(mergeArgs(c, { snapshotSha: reviewed.slice(0, 12) }))
    assert.equal(merged.snapshotRelation, 'ancestor')
  })
})

test('#109 engine: an expectedHeadSha that names no commit is refused', async () => {
  await engineCase(async c => {
    commitInWorktree(c.wtPath)
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { expectedHeadSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })))
    assert.equal(err?.code, 'MERGE_VERIFY_FAILED')
    assert.match(err.message, /期望合并的提交 deadbeefdead 在仓库中找不到/)
    assertKept(c, mainBefore)
  })
})

test('#109 engine: without snapshot and expectedHeadSha the automatic commit stays, counted and reported', async () => {
  await engineCase(async c => {
    commitInWorktree(c.wtPath)
    writeFileSync(join(c.wtPath, 'a.txt'), 'left uncommitted\n')
    mkdirSync(join(c.wtPath, 'dir'))
    writeFileSync(join(c.wtPath, 'dir', 'one.txt'), '1\n')
    writeFileSync(join(c.wtPath, 'dir', 'two.txt'), '2\n')
    const seen = []
    const merged = await mergeWorktreeBranch(mergeArgs(c, { onAutoCommit: info => seen.push(info) }))
    assert.equal(merged.autoCommittedCount, 3, 'files are counted one by one, not per untracked directory')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].count, 3)
    assert.equal(seen[0].headSha, merged.verifiedSha)
    assert.equal(merged.snapshotRelation, 'none')
    assert.equal(git(c.repoPath, 'show', 'main:dir/two.txt'), '2')
    assert.equal(git(c.repoPath, 'show', 'main:a.txt'), 'left uncommitted')
  })
})

test('#109 engine: a snapshot of uncommitted files is no longer committed by the merge; committed by hand it is proven by its tree', async () => {
  await engineCase(async c => {
    writeFileSync(join(c.wtPath, 'a.txt'), 'not committed by the worker\n')
    const snap = await captureWorktreeSnapshot({ repoPath: c.repoPath, worktreePath: c.wtPath, baseCommit: c.wt.baseCommit, baseBranch: 'main', snapshotRefName: 't-109' })
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const headBefore = git(c.wtPath, 'rev-parse', 'HEAD')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { snapshotSha: snap.snapshotSha })))
    assert.equal(err?.code, 'MERGE_VERIFY_FAILED')
    assert.match(err.message, /未提交改动（a\.txt）/)
    assertKept(c, mainBefore)
    assert.equal(git(c.wtPath, 'rev-parse', 'HEAD'), headBefore)
    git(c.wtPath, 'commit', '-am', 'committed before the merge')
    const head = git(c.wtPath, 'rev-parse', 'HEAD')
    const merged = await mergeWorktreeBranch(mergeArgs(c, { snapshotSha: snap.snapshotSha, expectedHeadSha: head }))
    assert.equal(merged.snapshotRelation, 'tree')
    assert.equal(merged.autoCommittedCount, 0)
    assert.ok(isAncestor(c.repoPath, head, 'main'))
  })
})

// ---- orchestrator: mergeBuild ---------------------------------------------------------------------------------

// `beforeMerge` runs after the review binding (#103) answered and right before the real mergeWorktreeBranch:
// the window in which another process may write the worktree.
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-109-orch-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const ctx = { root, db, beforeMerge: null, mergeCalls: [] }
  const orch = createOrchestrator({
    db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], clock: () => Date.now(),
    mergeWorktreeBranchImpl: async args => {
      ctx.mergeCalls.push({ ...args })
      if (ctx.beforeMerge) await ctx.beforeMerge(args)
      return mergeWorktreeBranch(args)
    },
  })
  let seq = 0
  const sessions = new Map()
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
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
  return Object.assign(ctx, { orch, run, sessions, cleanup })
}

const CONFIGS = [{ id: 'cfg-1', label: '主力', engine: 'codex', mode: 'global', provider: 'p1', model: 'model-one', reasoningEffort: 'high' }]
const APPROVE = '逻辑正确，测试充分。\nVERDICT: APPROVED'
const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const mainHead = project => git(project.repoPath, 'rev-parse', 'main')

async function endRun(ctx, sessionId, text) {
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  if (text) s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: text, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)
}

// A card at the merge gate: the build ended with one commit.
async function gateCard(ctx, { chiefMayMerge = false } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '合并原子性测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '合并原子性测试 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
  if (chiefMayMerge) db.updateProject(1, 'default', project.id, { autopilot: { autoMergeAfterReview: true } })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: chiefMayMerge })
  if (chiefMayMerge) {
    const chief = await run.host.sessions.create({ title: 'chief' })
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: chief.session.id })
  }
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id, withPlan: false })
  writeFileSync(join(built.worktreePath, 'a.txt'), 'feature side\n')
  git(built.worktreePath, 'commit', '-am', 'work')
  await endRun(ctx, built.buildSessionId, 'done')
  assert.equal(get(ctx, todo.id).phase, 'review')
  return { todo: get(ctx, todo.id), project: db.getProject(1, 'default', project.id) }
}

// The same card with an APPROVED independent review bound to the worktree HEAD.
async function reviewedCard(ctx) {
  const made = await gateCard(ctx)
  const reviewing = await ctx.orch.runIndependentReview(ctx.run, { todoId: made.todo.id })
  assert.equal(reviewing.phase, 'reviewing')
  await endRun(ctx, get(ctx, made.todo.id).reviewSessionId, APPROVE)
  const todo = get(ctx, made.todo.id)
  assert.equal(todo.evidence.reviewVerdict, 'approved')
  assert.equal(todo.reviewedSha, git(todo.worktreePath, 'rev-parse', 'HEAD'))
  return { ...made, todo }
}

function assertFailedNotDone(ctx, before, project, mainBefore) {
  const after = get(ctx, before.id)
  assert.equal(after.phase, 'failed', 'the card is failed, not done')
  assert.equal(after.gateKind, 'failed')
  assert.equal(after.gateOwner, 'human')
  assert.equal(after.branch, before.branch)
  assert.equal(after.worktreePath, before.worktreePath)
  assert.equal(after.snapshotSha, before.snapshotSha)
  assert.equal(after.reviewedSha, before.reviewedSha)
  assert.equal(after.evidence.mergeVerify, 'failed')
  assert.equal(after.evidence.mergedSha, undefined, 'no mergedSha without the proof')
  assert.ok(after.lastError.startsWith('合并失败') && after.lastError.includes('merge_verify_failed'), after.lastError)
  const lines = timeline(ctx, before.id)
  assert.ok(lines.some(e => e.includes('merge_verify_failed')), 'the timeline carries the marker')
  assert.ok(!lines.some(e => e.startsWith('已合并至') || e.includes('已在 main 中')), 'no line says it was merged')
  assert.ok(existsSync(before.worktreePath), 'the worktree is kept')
  assert.ok(branchExists(project.repoPath, before.branch), 'the branch is kept')
  assert.equal(mainHead(project), mainBefore, 'main did not move')
  return after
}

test('#109 card: a file changed after the review binding passed -> merge refused with the file name, failed, worktree and branch kept', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewedCard(ctx)
    const mainBefore = mainHead(project)
    ctx.beforeMerge = () => { writeFileSync(join(todo.worktreePath, 'slipped-in.txt'), 'written after the review\n') }
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.ok(err, 'the merge is refused')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.match(err.message, /工作树在审查\/快照之后有 1 项未提交改动（slipped-in\.txt），请先提交或清理再合并/)
    assert.equal(ctx.mergeCalls.length, 1)
    assert.equal(ctx.mergeCalls[0].expectedHeadSha, todo.reviewedSha, 'the reviewed commit is handed down as the expected HEAD')
    const after = assertFailedNotDone(ctx, todo, project, mainBefore)
    assert.ok(after.lastError.includes('slipped-in.txt'), after.lastError)
    assert.equal(git(todo.worktreePath, 'rev-parse', 'HEAD'), todo.reviewedSha, 'nothing was committed for it')
    assert.equal(git(project.repoPath, 'rev-parse', todo.branch), todo.reviewedSha)
    assert.equal(readFileSync(join(todo.worktreePath, 'slipped-in.txt'), 'utf8'), 'written after the review\n', 'the file is still there')
    assert.equal(gitRc(project.repoPath, 'cat-file', '-e', 'main:slipped-in.txt') === 0, false, 'it is not on main')
  } finally { ctx.cleanup() }
})

test('#109 card: a commit made after the review binding passed -> refused by expectedHeadSha, failed, nothing merged', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewedCard(ctx)
    const mainBefore = mainHead(project)
    let later = ''
    ctx.beforeMerge = () => {
      writeFileSync(join(todo.worktreePath, 'a.txt'), 'committed after the review\n')
      git(todo.worktreePath, 'commit', '-am', 'slipped in')
      later = git(todo.worktreePath, 'rev-parse', 'HEAD')
    }
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.ok(err, 'the merge is refused')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.match(err.message, /不是期望合并的提交/)
    assert.ok(err.message.includes(later.slice(0, 12)) && err.message.includes(todo.reviewedSha.slice(0, 12)), err.message)
    assertFailedNotDone(ctx, todo, project, mainBefore)
    assert.equal(isAncestor(project.repoPath, later, 'main'), false)
  } finally { ctx.cleanup() }
})

test('#109 card: reviewed and the worktree clean -> merged as before, no automatic-commit line', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewedCard(ctx)
    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    assert.equal(done.phase, 'done')
    assert.equal(done.evidence.mergeVerify, 'passed')
    assert.ok(isAncestor(project.repoPath, todo.reviewedSha, 'main'))
    assert.equal(git(project.repoPath, 'show', 'main:a.txt'), 'feature side')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('自动提交了')), 'nothing was auto-committed')
    assert.equal(existsSync(todo.worktreePath), false)
  } finally { ctx.cleanup() }
})

test('#109 card: a card without any snapshot keeps the automatic commit, and the timeline says how many files', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await gateCard(ctx)
    await ctx.orch.saveSettings(ctx.run, { confirmUnreviewedMerge: false })
    ctx.db.updateTodo(1, 'default', todo.id, { snapshotSha: '' })
    assert.equal(get(ctx, todo.id).snapshotSha, '')
    assert.equal(get(ctx, todo.id).reviewedSha, '')
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'left by an old card\n')
    writeFileSync(join(todo.worktreePath, 'old-extra.txt'), 'x\n')
    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    assert.equal(done.phase, 'done')
    assert.equal(ctx.mergeCalls[0].expectedHeadSha, '', 'no expected HEAD for a card without a snapshot')
    const lines = timeline(ctx, todo.id)
    assert.ok(lines.some(e => /^为无审查快照的卡自动提交了 2 个文件（提交 [0-9a-f]{12}）/.test(e)), lines.join('\n'))
    assert.equal(git(project.repoPath, 'show', 'main:old-extra.txt'), 'x')
    assert.equal(git(project.repoPath, 'show', 'main:a.txt'), 'left by an old card')
  } finally { ctx.cleanup() }
})

for (const caller of ['user', 'chief']) {
  test(`#109 card: no review but a snapshot, worktree dirty -> ${caller} is refused at the gate with the file name, nothing committed`, async () => {
    const ctx = setup()
    try {
      const { todo, project } = await gateCard(ctx, { chiefMayMerge: true })
      await ctx.orch.saveSettings(ctx.run, { confirmUnreviewedMerge: false })
      // A card stored before #103: approved, no reviewed commit on record (so the Chief gets as far as the binding).
      ctx.db.updateTodo(1, 'default', todo.id, { gateOwner: 'chief', evidence: { reviewVerdict: 'approved' } })
      assert.ok(todo.snapshotSha, 'the build left a snapshot')
      const mainBefore = mainHead(project)
      const head = git(todo.worktreePath, 'rev-parse', 'HEAD')
      writeFileSync(join(todo.worktreePath, 'after-snapshot.txt'), 'x\n')
      const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller }))
      assert.ok(err, 'the merge is refused')
      assert.match(err.message, /工作树有 1 项未提交改动（after-snapshot\.txt），合并不会自动提交它们/)
      assert.match(err.message, /请先提交或清理再合并/)
      assert.equal(ctx.mergeCalls.length, 0, 'refused before the merge was started')
      const after = get(ctx, todo.id)
      assert.equal(after.phase, 'review', 'back at the gate')
      assert.equal(after.gateOwner, 'human')
      assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('合并未执行：工作树有 1 项未提交改动（after-snapshot.txt）')))
      assert.equal(git(todo.worktreePath, 'rev-parse', 'HEAD'), head, 'no automatic commit')
      assert.equal(mainHead(project), mainBefore)
    } finally { ctx.cleanup() }
  })
}

test('#109 card: no review but a snapshot -> the HEAD the binding read is the expected HEAD; a commit in between fails the merge', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await gateCard(ctx)
    await ctx.orch.saveSettings(ctx.run, { confirmUnreviewedMerge: false })
    const head = git(todo.worktreePath, 'rev-parse', 'HEAD')
    const mainBefore = mainHead(project)
    ctx.beforeMerge = () => {
      writeFileSync(join(todo.worktreePath, 'a.txt'), 'moved in between\n')
      git(todo.worktreePath, 'commit', '-am', 'moved')
    }
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.equal(err?.code, 'MERGE_VERIFY_FAILED')
    assert.equal(ctx.mergeCalls[0].expectedHeadSha, head)
    assert.match(err.message, /不是期望合并的提交/)
    assert.equal(get(ctx, todo.id).phase, 'failed')
    assert.equal(mainHead(project), mainBefore)
    assert.ok(existsSync(todo.worktreePath))
  } finally { ctx.cleanup() }
})

test('#109 contract: the rule is declared in the tool descriptions and documented', () => {
  const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
  const text = JSON.stringify(contract)
  assert.ok(text.includes('#109'), 'contracts/plugin.json names #109')
  const doc = readFileSync(new URL('../docs/CONTRACTS.md', import.meta.url), 'utf8')
  for (const needle of ['#109', 'expectedHeadSha', '请先提交或清理再合并', '不是期望合并的提交', '为无审查快照的卡自动提交了']) {
    assert.ok(doc.includes(needle), `docs/CONTRACTS.md mentions ${needle}`)
  }
})

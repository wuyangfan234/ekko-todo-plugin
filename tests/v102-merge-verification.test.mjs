// #102: no fake merge. A merge is proven before the card is written `done` and before the worktree and the
// branch are deleted: HEAD of the worktree is on the card's branch and is the card's snapshot, and after the
// merge that commit is an ancestor of the base branch. Every repository here is a real one made by `git init`
// in a temporary directory; nothing is mocked. The case "git answers success and the base branch does not
// contain the commit" is made with a real `post-merge` hook that moves the base branch back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import * as gitEngine from '../src/server/git-engine.mjs'
import * as mcpTools from '../src/server/mcp-tools.mjs'

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

// `git merge` answers 0, then this hook puts the base branch back where it was: the incident, with real git.
function installMergeUndoHook(repoPath) {
  const hook = join(repoPath, '.git', 'hooks', 'post-merge')
  mkdirSync(join(repoPath, '.git', 'hooks'), { recursive: true })
  writeFileSync(hook, '#!/bin/sh\ngit reset -q --hard HEAD^\n')
  chmodSync(hook, 0o755)
}

async function rejection(promise) {
  try { await promise } catch (err) { return err }
  return null
}

// ---- git-engine: mergeWorktreeBranch called directly on a real repository ------------------------------------

async function engineCase(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-102-engine-'))
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

test('#102 engine: a real merge is proven: mergedSha is the head of main and the snapshot is its ancestor', async () => {
  await engineCase(async c => {
    const head = commitInWorktree(c.wtPath)
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const merged = await mergeWorktreeBranch(mergeArgs(c, { snapshotSha: head.slice(0, 12) }))
    const mainAfter = git(c.repoPath, 'rev-parse', 'main')
    assert.notEqual(mainAfter, mainBefore)
    assert.equal(merged.mergedFullSha, mainAfter)
    assert.ok(mainAfter.startsWith(merged.mergedSha))
    assert.equal(merged.mergeKind, 'merge_commit')
    assert.equal(merged.verifiedSha, head)
    assert.equal(merged.snapshotRelation, 'head')
    assert.ok(isAncestor(c.repoPath, head, 'main'))
    assert.equal(existsSync(c.wtPath), false, 'a proven merge removes the worktree')
    assert.equal(branchExists(c.repoPath, c.branch), false, 'and the branch')
  })
})

test('#102 engine: HEAD of the worktree is not the snapshot: refused, both shas named, everything kept', async () => {
  await engineCase(async c => {
    const reviewed = commitInWorktree(c.wtPath, 'reviewed\n', 'reviewed')
    git(c.wtPath, 'reset', '-q', '--hard', 'HEAD^')
    const other = commitInWorktree(c.wtPath, 'something else\n', 'not what was reviewed')
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { snapshotSha: reviewed.slice(0, 12) })))
    assert.ok(err, 'the merge is refused')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.equal(err.stage, 'pre')
    assert.match(err.message, /工作树 HEAD=[0-9a-f]{12} 与卡片快照 [0-9a-f]{12} 不一致/)
    assert.ok(err.message.includes(other.slice(0, 12)) && err.message.includes(reviewed.slice(0, 12)), err.message)
    assertKept(c, mainBefore)
    assert.equal(git(c.wtPath, 'rev-parse', 'HEAD'), other)
  })
})

test('#102 engine: commits on a detached HEAD (the incident): refused, the commit stays reachable, nothing deleted', async () => {
  await engineCase(async c => {
    git(c.wtPath, 'checkout', '-q', '--detach')
    const detached = commitInWorktree(c.wtPath, 'made on a detached HEAD\n')
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    assert.equal(git(c.repoPath, 'rev-parse', c.branch), mainBefore, 'the branch never moved: git would say Already up to date')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { snapshotSha: detached.slice(0, 12) })))
    assert.ok(err, 'the merge is refused, not reported as up to date')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.match(err.message, /游离 HEAD/)
    assert.ok(err.message.includes(c.branch), err.message)
    assertKept(c, mainBefore)
    assert.equal(git(c.wtPath, 'rev-parse', 'HEAD'), detached, 'the work is still checked out in the worktree')
    assert.equal(isAncestor(c.repoPath, detached, 'main'), false)
  })
})

test('#102 engine: HEAD of the worktree is on another branch: refused, both branch names listed, nothing deleted', async () => {
  await engineCase(async c => {
    git(c.wtPath, 'checkout', '-q', '-b', 'side-line')
    const side = commitInWorktree(c.wtPath, 'made on side-line\n')
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { snapshotSha: side.slice(0, 12) })))
    assert.ok(err, 'the merge is refused')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.ok(err.message.includes('「side-line」') && err.message.includes(`「${c.branch}」`), err.message)
    assertKept(c, mainBefore)
    assert.ok(branchExists(c.repoPath, 'side-line'))
  })
})

test('#102 engine: the branch does not exist: refused, never "Already up to date"', async () => {
  await engineCase(async c => {
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { branchName: 'ekko-todo/never-made' })))
    assert.ok(err, 'the merge is refused')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.match(err.message, /分支不存在：ekko-todo\/never-made/)
    assert.ok(existsSync(c.wtPath))
    assert.equal(git(c.repoPath, 'rev-parse', 'main'), mainBefore)
  })
})

test('#102 engine: the worktree does not exist: refused, the branch is kept', async () => {
  await engineCase(async c => {
    const head = commitInWorktree(c.wtPath)
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const gone = join(c.root, 'wts', 'no-such-worktree')
    for (const worktreePath of [gone, '']) {
      const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { worktreePath, snapshotSha: head.slice(0, 12) })))
      assert.ok(err, `refused for worktreePath=${JSON.stringify(worktreePath)}`)
      assert.equal(err.code, 'MERGE_VERIFY_FAILED')
      assert.match(err.message, /工作树不存在/)
    }
    assertKept(c, mainBefore)
    assert.equal(git(c.repoPath, 'rev-parse', c.branch), head, 'the unmerged commit is still on its branch')
  })
})

test('#102 engine: already an ancestor of main: accepted without a new commit, and told apart', async () => {
  await engineCase(async c => {
    const head = commitInWorktree(c.wtPath)
    git(c.repoPath, 'merge', '-q', '--no-ff', c.branch, '-m', 'merged by hand')
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const merged = await mergeWorktreeBranch(mergeArgs(c, { snapshotSha: head.slice(0, 12) }))
    assert.equal(merged.mergeKind, 'already_merged')
    assert.equal(git(c.repoPath, 'rev-parse', 'main'), mainBefore, 'no second merge commit')
    assert.equal(merged.mergedFullSha, mainBefore)
    assert.equal(merged.verifiedSha, head)
    assert.ok(isAncestor(c.repoPath, head, 'main'))
    assert.equal(existsSync(c.wtPath), false)
  })
})

test('#102 engine: git merge answers success but main does not contain the commit: failed, everything kept', async () => {
  await engineCase(async c => {
    const head = commitInWorktree(c.wtPath)
    installMergeUndoHook(c.repoPath)
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { snapshotSha: head.slice(0, 12) })))
    assert.ok(err, 'a merge that left main without the commit is a failure')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.equal(err.stage, 'post')
    assert.match(err.message, /合并命令返回成功但快照提交未进入 main/)
    assert.match(err.message, /已保留工作树与分支/)
    assertKept(c, mainBefore)
    assert.equal(git(c.repoPath, 'rev-parse', c.branch), head)
    assert.equal(isAncestor(c.repoPath, head, 'main'), false)
  })
})

// #109: the merge no longer commits those files itself (tests/t109-merge-atomicity.test.mjs has the refusal);
// they are committed here, as the review dispatch does, and the relation `tree` is what proves that commit.
test('#102 engine: a snapshot of uncommitted files is proven by its tree, and the commit made from it is in main', async () => {
  await engineCase(async c => {
    writeFileSync(join(c.wtPath, 'a.txt'), 'not committed by the worker\n')
    writeFileSync(join(c.wtPath, 'new.txt'), 'untracked\n')
    const snap = await captureWorktreeSnapshot({ repoPath: c.repoPath, worktreePath: c.wtPath, baseCommit: c.wt.baseCommit, baseBranch: 'main', snapshotRefName: 't-1' })
    assert.notEqual(snap.snapshotFullSha, snap.headSha, 'the snapshot is a commit of its own')
    git(c.wtPath, 'add', '-A'); git(c.wtPath, 'commit', '-m', 'commit what the snapshot was taken of')
    const merged = await mergeWorktreeBranch(mergeArgs(c, { snapshotSha: snap.snapshotSha }))
    assert.equal(merged.snapshotRelation, 'tree')
    assert.equal(merged.mergeKind, 'merge_commit')
    assert.ok(isAncestor(c.repoPath, merged.verifiedSha, 'main'))
    assert.equal(git(c.repoPath, 'rev-parse', `${merged.verifiedSha}^{tree}`), git(c.repoPath, 'rev-parse', `${snap.snapshotFullSha}^{tree}`))
    assert.equal(readFileSync(join(c.repoPath, 'new.txt'), 'utf8'), 'untracked\n')
  })
})

test('#102 engine: files changed after the snapshot was taken: refused, the worktree and branch are kept', async () => {
  await engineCase(async c => {
    writeFileSync(join(c.wtPath, 'a.txt'), 'what was reviewed\n')
    const snap = await captureWorktreeSnapshot({ repoPath: c.repoPath, worktreePath: c.wtPath, baseCommit: c.wt.baseCommit, baseBranch: 'main', snapshotRefName: 't-2' })
    writeFileSync(join(c.wtPath, 'a.txt'), 'changed after the review\n')
    const mainBefore = git(c.repoPath, 'rev-parse', 'main')
    // #109: uncommitted, it is refused as an uncommitted change and not committed by the merge.
    const dirtyErr = await rejection(mergeWorktreeBranch(mergeArgs(c, { snapshotSha: snap.snapshotSha })))
    assert.equal(dirtyErr?.code, 'MERGE_VERIFY_FAILED')
    assert.match(dirtyErr.message, /未提交改动（a\.txt）/)
    assertKept(c, mainBefore)
    // Committed, it is a tree the snapshot does not have: the check of #102.
    git(c.wtPath, 'commit', '-am', 'the later change, committed')
    const err = await rejection(mergeWorktreeBranch(mergeArgs(c, { snapshotSha: snap.snapshotSha })))
    assert.ok(err, 'the merge is refused')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    assert.match(err.message, /与卡片快照 [0-9a-f]{12} 不一致/)
    assertKept(c, mainBefore)
    assert.equal(readFileSync(join(c.wtPath, 'a.txt'), 'utf8'), 'changed after the review\n', 'the later change is not lost')
  })
})

test('#102 engine: the three outcomes of a merge are told apart from the shas alone', () => {
  assert.equal(typeof gitEngine.classifyMergeOutcome, 'function')
  assert.equal(gitEngine.classifyMergeOutcome({ before: 'a', after: 'a', head: 'h' }), 'already_merged')
  assert.equal(gitEngine.classifyMergeOutcome({ before: 'a', after: 'h', head: 'h' }), 'fast_forward')
  assert.equal(gitEngine.classifyMergeOutcome({ before: 'a', after: 'm', head: 'h' }), 'merge_commit')
})

// ---- orchestrator: mergeBuild on a card at the merge gate ----------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-102-orch-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
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
  return { root, db, orch, run, sessions, cleanup }
}

const CONFIGS = [{ id: 'cfg-1', label: '主力', engine: 'codex', mode: 'global', provider: 'p1', model: 'model-one', reasoningEffort: 'high' }]
const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const patch = (ctx, id, p) => ctx.db.updateTodo(1, 'default', id, p)

// A card at the merge gate with one committed change on its branch and an APPROVED review.
async function reviewCard(ctx) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '合并校验测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '合并校验测试 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id, withPlan: false })
  assert.equal(built.phase, 'building')
  writeFileSync(join(built.worktreePath, 'a.txt'), 'feature side\n')
  git(built.worktreePath, 'commit', '-am', 'work')
  const s = ctx.sessions.get(built.buildSessionId)
  s.is_running = false
  s.messages.push({ id: 'a-1', role: 'assistant', content: 'done', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: built.buildSessionId, finish_reason: 'stop' } }, run)
  assert.equal(get(ctx, todo.id).phase, 'review')
  // #103: an approved card names the commit that was reviewed (the worktree HEAD); without it the merge
  // first asks the user to confirm and never reaches the checks of #102.
  patch(ctx, todo.id, { reviewedSha: git(built.worktreePath, 'rev-parse', 'HEAD'), evidence: { reviewVerdict: 'approved', reviewSummary: 'VERDICT: APPROVED' } })
  return { todo: get(ctx, todo.id), project }
}

function assertNotDone(ctx, before, project, mainBefore) {
  const after = get(ctx, before.id)
  assert.equal(after.phase, 'failed', 'the card is not done')
  assert.equal(after.gateKind, 'failed')
  assert.equal(after.gateOwner, 'human')
  assert.equal(after.branch, before.branch)
  assert.equal(after.worktreePath, before.worktreePath)
  assert.equal(after.snapshotSha, before.snapshotSha, 'the snapshot was not replaced by a "merged" sha')
  assert.equal(after.evidence.reviewVerdict, 'approved')
  assert.equal(after.evidence.mergeVerify, 'failed')
  assert.ok(after.lastError.startsWith('合并失败'), after.lastError)
  assert.ok(after.lastError.includes('merge_verify_failed'), after.lastError)
  const lines = timeline(ctx, before.id)
  assert.ok(lines.some(e => e.includes('merge_verify_failed')), 'the timeline carries the marker')
  assert.ok(!lines.some(e => e.startsWith('已合并至') || e.includes('已在 main 中')), 'no line says it was merged')
  assert.ok(existsSync(before.worktreePath), 'the worktree is kept')
  assert.ok(branchExists(project.repoPath, before.branch), 'the branch is kept')
  assert.equal(git(project.repoPath, 'rev-parse', 'main'), mainBefore, 'main did not move')
  return after
}

test('#102 card: a real merge writes done only with the proof: mergedSha is the head of main, the kind is named', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    const workSha = git(todo.worktreePath, 'rev-parse', 'HEAD')
    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    const mainHead = git(project.repoPath, 'rev-parse', 'main')
    assert.equal(done.phase, 'done')
    assert.equal(done.evidence.mergeVerify, 'passed')
    assert.equal(done.evidence.mergeKind, 'merge_commit')
    assert.ok(mainHead.startsWith(done.evidence.mergedSha), 'mergedSha is the head of main')
    assert.equal(done.evidence.mergeVerifiedSha, workSha)
    assert.equal(done.evidence.mergeSnapshotSha, todo.snapshotSha, 'the snapshot that was merged stays on record')
    assert.ok(isAncestor(project.repoPath, workSha, 'main'))
    const line = timeline(ctx, todo.id).find(e => e.startsWith('已合并至 main（'))
    assert.ok(line, 'the timeline says it was merged')
    assert.ok(line.includes('新合并提交') && line.includes(workSha.slice(0, 12)), line)
    assert.equal(existsSync(todo.worktreePath), false)
    const out = mcpTools.mergeBuildToolResult(done)
    assert.equal(out.ok, true)
    assert.match(out.content, /^Merged #\d+ \(/)
    assert.equal(out.data.commitSha, done.evidence.mergedSha)
  } finally { ctx.cleanup() }
})

test('#102 card: work committed on a detached HEAD is refused: not done, marker on the timeline, nothing deleted, retry possible', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    git(todo.worktreePath, 'checkout', '-q', '--detach')
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'made on a detached HEAD\n')
    git(todo.worktreePath, 'commit', '-am', 'detached work')
    const detached = git(todo.worktreePath, 'rev-parse', 'HEAD')
    // #103: with a review snapshot the review binding refuses this first (HEAD is not the reviewed commit;
    // tests/t103-review-integrity.test.mjs). This case is the check of #102 alone: a card without a review
    // snapshot, with the confirmation switched off.
    ctx.db.updateSettings(1, 'default', { confirmUnreviewedMerge: false })
    patch(ctx, todo.id, { snapshotSha: detached.slice(0, 12), reviewedSha: '' })
    const before = get(ctx, todo.id)
    const mainBefore = git(project.repoPath, 'rev-parse', 'main')
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.ok(err, 'the merge is refused')
    assert.match(err.message, /游离 HEAD/)
    const after = assertNotDone(ctx, before, project, mainBefore)
    assert.ok(after.lastError.includes(before.branch), 'the registered branch is named')
    assert.equal(git(todo.worktreePath, 'rev-parse', 'HEAD'), detached, 'the detached commit is still checked out')
    const back = await ctx.orch.retryMerge(ctx.run, { todoId: todo.id })
    assert.equal(back.phase, 'review', 'retry_merge takes the card back to the merge gate')
  } finally { ctx.cleanup() }
})

test('#102 card: git says merged but main does not contain the snapshot: failed, not done, worktree and branch kept', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    installMergeUndoHook(project.repoPath)
    const mainBefore = git(project.repoPath, 'rev-parse', 'main')
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.ok(err, 'the merge is a failure')
    assert.equal(err.code, 'MERGE_VERIFY_FAILED')
    const after = assertNotDone(ctx, todo, project, mainBefore)
    assert.match(after.lastError, /合并命令返回成功但快照提交未进入 main（main=[0-9a-f]{12}，应包含 [0-9a-f]{12}），已保留工作树与分支/)
    assert.equal(after.evidence.mergedSha, undefined, 'no mergedSha without the proof')
    const out = mcpTools.mergeBuildToolResult(after)
    assert.equal(out.ok, false)
    assert.ok(!/marked done\.$/.test(out.content), out.content)
  } finally { ctx.cleanup() }
})

test('#102 card: a card whose worktree record is empty is refused instead of written done without a merge', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    const mainBefore = git(project.repoPath, 'rev-parse', 'main')
    patch(ctx, todo.id, { worktreePath: '' })
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.ok(err, 'the merge is refused')
    assert.match(err.message, /工作树不存在/)
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('已合并至')))
    assert.ok(branchExists(project.repoPath, todo.branch))
    assert.ok(existsSync(todo.worktreePath))
    assert.equal(git(project.repoPath, 'rev-parse', 'main'), mainBefore)
  } finally { ctx.cleanup() }
})

test('#102 card: a branch already in main is accepted, and the timeline says nothing new was merged', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    const workSha = git(todo.worktreePath, 'rev-parse', 'HEAD')
    git(project.repoPath, 'merge', '-q', '--no-ff', todo.branch, '-m', 'merged by hand')
    const mainBefore = git(project.repoPath, 'rev-parse', 'main')
    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    assert.equal(done.phase, 'done')
    assert.equal(done.evidence.mergeKind, 'already_merged')
    assert.equal(git(project.repoPath, 'rev-parse', 'main'), mainBefore)
    const lines = timeline(ctx, todo.id)
    const line = lines.find(e => e.includes('已在 main 中'))
    assert.ok(line && line.includes('无需再次合并') && line.includes(workSha.slice(0, 12)), lines.join(' | '))
    assert.ok(!lines.some(e => e.startsWith('已合并至')), 'it is not reported as a new merge')
    assert.match(mcpTools.mergeBuildToolResult(done).content, /already contained/)
  } finally { ctx.cleanup() }
})

test('#102 tool: merge_build answers by the phase of the card: merging and taken-over cards are not "marked done"', async () => {
  assert.equal(typeof mcpTools.mergeBuildToolResult, 'function')
  const tools = new Map()
  const card = { id: 't1', number: 7, phase: 'merging', snapshotSha: 'abc1234', evidence: {} }
  mcpTools.registerMcpTools(
    { extensions: { tools: { register(def) { tools.set(def.name, def); return () => {} } } } },
    { db: { getSettings: () => ({}), getTodo: () => null }, orchestrator: { async mergeBuild() { return card } } },
  )
  const tool = tools.get('merge_build')
  const run = { identity: { userId: 1, profile: 'default' } }
  const inFlight = await tool.execute({ todo_id: 't1' }, run)
  assert.ok(!/Merged #7/.test(inFlight.content) && !/and marked done/.test(inFlight.content), inFlight.content)
  assert.match(inFlight.content, /NOT marked done/)
  assert.equal(inFlight.data.phase, 'merging')
  assert.equal(inFlight.data.commitSha, '')

  card.phase = 'review'
  const takenOver = await tool.execute({ todo_id: 't1' }, run)
  assert.equal(takenOver.ok, false)
  assert.equal(takenOver.error, 'MERGE_NOT_COMPLETED')
  assert.match(takenOver.content, /phase "review"/)

  card.phase = 'done'
  const noProof = await tool.execute({ todo_id: 't1' }, run)
  assert.ok(!/^Merged/.test(noProof.content), noProof.content)
  assert.equal(noProof.data.commitSha, '')

  card.evidence = { mergeVerify: 'passed', mergedSha: 'feed123', mergeKind: 'merge_commit' }
  const proven = await tool.execute({ todo_id: 't1' }, run)
  assert.equal(proven.ok, true)
  assert.match(proven.content, /^Merged #7 \(feed123; new merge commit; verified/)
  assert.equal(proven.data.commitSha, 'feed123')
})

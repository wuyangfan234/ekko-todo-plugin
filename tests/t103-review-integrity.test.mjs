// Todo #103 (audit #95, P1-1 and P1-2): the review verdict is bound to the commit that was reviewed, and only
// a verdict line that stands alone as the last line can approve.
//  1. parseReviewVerdict: a table of texts. Approval needs `VERDICT: APPROVED` alone on the last line; a
//     verdict in a sentence, in quotes, in code, followed by a condition, or missing is never `approved`.
//  2. readReviewBinding / reviewBindingProblem (git-engine, real git): HEAD, branch tip and uncommitted changes
//     against the reviewed commit.
//  3. The card: runIndependentReview writes `reviewedSha`; a worktree changed during the review is flagged
//     when the review settles; mergeBuild refuses a branch that is not the reviewed commit (both shas in the
//     text) or has uncommitted changes, and asks the user once for a card without a review snapshot.
//  4. Storage and contract: the two additive columns, their defaults on an older database, the documents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import * as orchestratorModule from '../src/server/orchestrator.mjs'
import * as gitEngine from '../src/server/git-engine.mjs'
import { fitSnapshotBudget, todoCardStub } from '../src/server/diff-budget.mjs'

const { createOrchestrator } = orchestratorModule
const parse = text => orchestratorModule.parseReviewVerdict?.(text)
const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

// ---- 1. the verdict rule ----------------------------------------------------------------------------------

const VERDICT_CASES = [
  // The last line, alone, approves.
  ['sole last line approves', '逻辑正确，测试充分。\nVERDICT: APPROVED', 'approved'],
  ['「必改：无」 followed by the sole last line approves', '必改：无\n建议：无\n放行：全部\nVERDICT: APPROVED', 'approved'],
  ['mixed case approves', '核对完毕。\nVerdict: Approved', 'approved'],
  ['full-width colon and trailing blank lines approve', '核对完毕。\nVERDICT：APPROVED\n\n  \n', 'approved'],
  ['trailing full stop approves', '核对完毕。\nVERDICT: APPROVED。', 'approved'],
  ['bold line and a trailing rule approve', '核对完毕。\n**VERDICT: APPROVED**\n---\n', 'approved'],
  ['a negation in the report body does not reach the last line', '第一稿 not approved yet，这一稿已修好。\nVERDICT: APPROVED', 'approved'],
  // Not the last line, not alone, or not there at all: never approved.
  ['verdict line that is not the last line', 'VERDICT: APPROVED\n逻辑正确，测试充分。', 'inconclusive'],
  ['verdict named in a sentence', '我认为可以给 VERDICT: APPROVED 了。', 'inconclusive'],
  ['verdict after a label on the same line', '结论：VERDICT: APPROVED', 'inconclusive'],
  ['verdict in ASCII quotes', '检查完成。\n"VERDICT: APPROVED"', 'inconclusive'],
  ['verdict in corner quotes', '检查完成。\n「VERDICT: APPROVED」', 'inconclusive'],
  ['verdict in a fenced code block', '检查完成。\n```\nVERDICT: APPROVED\n```', 'inconclusive'],
  ['verdict in a tilde fence followed by prose', '~~~\nVERDICT: APPROVED\n~~~\n以上是模板。', 'inconclusive'],
  ['verdict after an unclosed fence', '结论如下\n```text\nVERDICT: APPROVED', 'inconclusive'],
  ['verdict as inline code', '检查完成。\n`VERDICT: APPROVED`', 'inconclusive'],
  ['verdict in a block quote', '检查完成。\n> VERDICT: APPROVED', 'inconclusive'],
  ['verdict as a list item', '检查完成。\n- VERDICT: APPROVED', 'inconclusive'],
  ['no verdict line, approving prose', '代码看起来没问题，可以合并。', 'inconclusive'],
  ['no verdict line, bare APPROVED', 'Looks correct. APPROVED.', 'inconclusive'],
  ['empty text', '', 'inconclusive'],
  ['template line naming both verdicts', '最后一行写\nVERDICT: APPROVED or CHANGES_REQUESTED', 'inconclusive'],
  // APPROVED with a condition on the same line or on the next line.
  ['APPROVED + 前提是 on the same line', '核对完毕。\nVERDICT: APPROVED，前提是先修掉并发问题', 'inconclusive'],
  ['APPROVED + 必改 on the same line', '核对完毕。\nVERDICT: APPROVED（必改：补一条用例）', 'inconclusive'],
  ['APPROVED + must fix on the same line', 'Checked.\nVERDICT: APPROVED but must fix the race first', 'inconclusive'],
  ['APPROVED + 需修改 on the same line', '核对完毕。\nVERDICT: APPROVED 需修改', 'inconclusive'],
  ['APPROVED + 必改 on the next line', '核对完毕。\nVERDICT: APPROVED\n必改：补一条并发用例', 'inconclusive'],
  ['APPROVED + must fix on the next line', 'Checked.\nVERDICT: APPROVED\nMust fix: the retry path', 'inconclusive'],
  // Rejections.
  ['NOT APPROVED', '问题见上。\nVERDICT: NOT APPROVED', 'changes_requested'],
  ['NOT approved, mixed case', '问题见上。\nverdict: Not approved', 'changes_requested'],
  ['CHANGES_REQUESTED', '问题见上。\nVERDICT: CHANGES_REQUESTED', 'changes_requested'],
  ['不通过', '问题见上。\nVERDICT: 不通过', 'changes_requested'],
  ['驳回', '问题见上。\nVERDICT：驳回', 'changes_requested'],
  ['需修改', '问题见上。\nVERDICT: 需修改', 'changes_requested'],
  ['需要修改', '问题见上。\nVERDICT: 需要修改。', 'changes_requested'],
  ['不可合并', '问题见上。\n**VERDICT: 不可合并**', 'changes_requested'],
  // Waiting words elsewhere do not outrank a sole last rejection line (this one is decided by the sole-line
  // rule alone: the fallback would read the waiting words first).
  ['sole last rejection line after waiting words', '稍后构建方修完我会再看一遍。\nVERDICT: CHANGES_REQUESTED', 'changes_requested'],
  ['sole last 驳回 line after waiting words', '稍后再看。\nVERDICT: 驳回', 'changes_requested'],
  ['a rejection that goes on writing is still a rejection', 'VERDICT: NOT APPROVED，三处必改见上', 'changes_requested'],
  ['中文驳回 in prose only is no verdict (and no approval)', '驳回，见上面三条。', 'inconclusive'],
  // Several verdict lines: the last sole line decides, and a rejection before an approval blocks it.
  ['several verdict lines: the last sole line rejects', '上一轮的结论是\nVERDICT: APPROVED\n这一轮多了一处回归。\nVERDICT: NOT APPROVED', 'changes_requested'],
  ['several verdict lines: sentence mention, then the sole last line', '上一轮 CHANGES_REQUESTED 的三处已修好，不再是 not approved。\nVERDICT: APPROVED', 'approved'],
  ['rejection line, then a conditional approval line', '缺一条用例。\nVERDICT: CHANGES_REQUESTED\n修好后可改成\nVERDICT: APPROVED', 'inconclusive'],
  ['中文 rejection line, then an approval line', 'VERDICT: 驳回\n修好后可改成\nVERDICT: APPROVED', 'inconclusive'],
  ['a rejection wrapped in backticks, then an approval line', '结论：`VERDICT: CHANGES_REQUESTED`\n修好后可以改为\nVERDICT: APPROVED', 'inconclusive'],
  ['a rejection quoted in a code block, then an approval line', '规则示例：\n```\nVERDICT: CHANGES_REQUESTED\n```\n实际结论如下。\nVERDICT: APPROVED', 'inconclusive'],
  ['a rejection quoted in a code block and no verdict line of its own', '规则示例：\n```\nVERDICT: CHANGES_REQUESTED\n```\n以上是格式。', 'inconclusive'],
  // Round 3: code after the verdict line must not vanish and lift the verdict line into the last line.
  ['verdict line followed by inline code 必改', 'ok\nVERDICT: APPROVED\n`必改：修复 X`', 'inconclusive'],
  ['verdict line followed by a fenced block must fix', 'ok\nVERDICT: APPROVED\n```\nmust fix X\n```', 'inconclusive'],
  ['verdict line followed by a quoted 必改', 'ok\nVERDICT: APPROVED\n> 必改', 'inconclusive'],
]

for (const [name, text, want] of VERDICT_CASES) {
  test(`#103 verdict: ${name} -> ${want}`, () => {
    assert.equal(parse(text), want, JSON.stringify(text))
  })
}

test('#103 verdict: the table has at least 20 cases and no text that is not approved reads as approved', () => {
  assert.ok(VERDICT_CASES.length >= 20, `${VERDICT_CASES.length} cases`)
  for (const [, text, want] of VERDICT_CASES) {
    if (want !== 'approved') assert.notEqual(parse(text), 'approved', JSON.stringify(text))
  }
})

// ---- harness ----------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t103-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], clock: () => Date.now() })
  let seq = 0
  const sessions = new Map()
  const calls = { runs: [] }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) {
        const id = `sess-${++seq}`
        sessions.set(id, { id, ...input, messages: [], is_running: false })
        return { session: { id } }
      },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
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
  return { root, db, orch, run, calls, sessions, cleanup }
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
const APPROVE = '逻辑正确，测试充分。\nVERDICT: APPROVED'

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))

async function endRun(ctx, sessionId, text) {
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  if (text) s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: text, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)
}

// A card at the merge gate (build ended with one commit), in a topic with a Chief session.
async function gateCard(ctx, { autopilot = true, autoMerge = true } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '审查绑定测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '审查绑定测试 Agent')
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
  return { todo: get(ctx, todo.id), project: db.getProject(1, 'default', project.id), topic }
}

// The same card with its independent review running.
async function reviewingCard(ctx, opts) {
  const made = await gateCard(ctx, opts)
  const reviewing = await ctx.orch.runIndependentReview(ctx.run, { todoId: made.todo.id })
  assert.equal(reviewing.phase, 'reviewing')
  return { ...made, todo: get(ctx, made.todo.id) }
}

// The same card with the review settled by `text`; `during` runs while the review is out.
async function reviewedCard(ctx, { text = APPROVE, during = null, ...opts } = {}) {
  const made = await reviewingCard(ctx, opts)
  if (during) during(made.todo)
  await endRun(ctx, made.todo.reviewSessionId, text)
  return { ...made, todo: get(ctx, made.todo.id) }
}

async function rejection(promise) {
  try { await promise } catch (err) { return err }
  return null
}

const mainHead = project => git(project.repoPath, 'rev-parse', 'main')
// A refused merge leaves everything where it was.
function assertNothingMerged(ctx, { todo, project }, mainBefore) {
  const cur = get(ctx, todo.id)
  assert.equal(cur.phase, 'review', 'the card stays at the gate')
  assert.ok(existsSync(todo.worktreePath), 'the worktree is kept')
  assert.equal(git(project.repoPath, 'rev-parse', '--verify', `refs/heads/${todo.branch}`).length, 40, 'the branch is kept')
  assert.equal(mainHead(project), mainBefore, 'main did not move')
  assert.equal(git(project.repoPath, 'status', '--porcelain'), '', 'the main checkout is clean')
  assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('已合并至')), 'no merged line')
}

// ---- 2. git-engine: the binding, on a real repository ------------------------------------------------------

function worktreeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t103-git-'))
  const repoPath = makeRepo(root)
  const worktreePath = join(root, 'wt')
  git(repoPath, 'worktree', 'add', '-b', 'task', worktreePath, 'main')
  writeFileSync(join(worktreePath, 'a.txt'), 'feature\n')
  git(worktreePath, 'commit', '-am', 'work')
  return { root, repoPath, worktreePath, branchName: 'task', reviewed: git(worktreePath, 'rev-parse', 'HEAD') }
}

test('#103 binding (git): a clean worktree on the reviewed commit has no problem', async () => {
  const f = worktreeRepo()
  try {
    const state = await gitEngine.readReviewBinding(f)
    assert.equal(state.headSha, f.reviewed)
    assert.equal(state.branchSha, f.reviewed)
    assert.equal(state.dirtyCount, 0)
    assert.equal(gitEngine.reviewBindingProblem(f.reviewed, state), '')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('#103 binding (git): a commit after the review is reported with both shas', async () => {
  const f = worktreeRepo()
  try {
    writeFileSync(join(f.worktreePath, 'a.txt'), 'changed after the review\n')
    git(f.worktreePath, 'commit', '-am', 'after review')
    const head = git(f.worktreePath, 'rev-parse', 'HEAD')
    const problem = gitEngine.reviewBindingProblem(f.reviewed, await gitEngine.readReviewBinding(f))
    assert.match(problem, /HEAD 已不是被审提交/)
    assert.ok(problem.includes(f.reviewed) && problem.includes(head), problem)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('#103 binding (git): uncommitted and untracked changes are reported, HEAD unchanged', async () => {
  const f = worktreeRepo()
  try {
    writeFileSync(join(f.worktreePath, 'a.txt'), 'edited, not committed\n')
    writeFileSync(join(f.worktreePath, 'new.txt'), 'untracked\n')
    const state = await gitEngine.readReviewBinding(f)
    assert.equal(state.headSha, f.reviewed)
    assert.equal(state.dirtyCount, 2)
    const problem = gitEngine.reviewBindingProblem(f.reviewed, state)
    assert.match(problem, /工作树有 2 项未提交改动/)
    assert.ok(problem.includes('a.txt') && problem.includes('new.txt'), problem)
    assert.ok(!/HEAD 已不是/.test(problem), 'HEAD itself did not move')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('#103 binding (git): a detached worktree HEAD whose branch stayed behind is reported', async () => {
  const f = worktreeRepo()
  try {
    git(f.worktreePath, 'checkout', '--detach')
    writeFileSync(join(f.worktreePath, 'a.txt'), 'on a detached head\n')
    git(f.worktreePath, 'commit', '-am', 'detached')
    const state = await gitEngine.readReviewBinding(f)
    assert.equal(state.branchSha, f.reviewed, 'the branch did not move')
    assert.notEqual(state.headSha, f.reviewed)
    assert.match(gitEngine.reviewBindingProblem(f.reviewed, state), /HEAD 已不是被审提交/)
    // The branch moved while the worktree HEAD (detached) stayed: also a mismatch.
    assert.match(gitEngine.reviewBindingProblem(state.headSha, state), /任务分支顶端已不是被审提交/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

// ---- 3. the card -------------------------------------------------------------------------------------------

test('#103: dispatching a review writes reviewedSha (the worktree HEAD), visible on the card and in the snapshot', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewingCard(ctx)
    const head = git(todo.worktreePath, 'rev-parse', 'HEAD')
    assert.equal(todo.reviewedSha, head)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('派发独立只读审查至') && e.includes(`被审提交 ${head.slice(0, 12)}`)))
    const snapshot = await ctx.orch.getSnapshot(ctx.run)
    assert.equal(snapshot.todos.find(t => t.id === todo.id).reviewedSha, head)
  } finally { ctx.cleanup() }
})

test('#103: changes left uncommitted by the build are committed when the review is dispatched, and that commit is reviewed and merged', async () => {
  const ctx = setup()
  try {
    const made = await gateCard(ctx)
    writeFileSync(join(made.todo.worktreePath, 'extra.txt'), 'never committed by the builder\n')
    const before = git(made.todo.worktreePath, 'rev-parse', 'HEAD')
    const reviewing = await ctx.orch.runIndependentReview(ctx.run, { todoId: made.todo.id })
    const head = git(reviewing.worktreePath, 'rev-parse', 'HEAD')
    assert.notEqual(head, before, 'a commit was made')
    assert.equal(git(reviewing.worktreePath, 'status', '--porcelain'), '')
    assert.equal(reviewing.reviewedSha, head)
    assert.ok(timeline(ctx, reviewing.id).some(e => e.startsWith('派审查前工作树有 1 项未提交改动，已提交为') && e.includes(head.slice(0, 12))))
    await endRun(ctx, reviewing.reviewSessionId, APPROVE)
    assert.equal(get(ctx, reviewing.id).evidence.reviewDrift, '')
    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: reviewing.id, caller: 'chief' })
    assert.equal(done.phase, 'done')
    assert.equal(git(made.project.repoPath, 'show', 'main:extra.txt'), 'never committed by the builder')
  } finally { ctx.cleanup() }
})

test('#103: the branch is still the reviewed commit -> the Chief may merge it and the commit is on main', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewedCard(ctx)
    assert.equal(todo.evidence.reviewVerdict, 'approved')
    assert.equal(todo.evidence.reviewDrift, '')
    assert.equal(todo.gateOwner, 'chief')
    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' })
    assert.equal(done.phase, 'done')
    git(project.repoPath, 'merge-base', '--is-ancestor', todo.reviewedSha, 'main')
    assert.equal(git(project.repoPath, 'show', 'main:a.txt'), 'feature side')
  } finally { ctx.cleanup() }
})

for (const caller of ['user', 'chief']) {
  test(`#103: a commit made after the review -> merge by the ${caller} is refused with both shas`, async () => {
    const ctx = setup()
    try {
      const made = await reviewedCard(ctx)
      const { todo, project } = made
      const mainBefore = mainHead(project)
      writeFileSync(join(todo.worktreePath, 'a.txt'), 'slipped in after the review\n')
      git(todo.worktreePath, 'commit', '-am', 'after review')
      const head = git(todo.worktreePath, 'rev-parse', 'HEAD')
      const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller }))
      assert.ok(err, 'the merge is refused')
      assert.match(err.message, /HEAD 已不是被审提交/)
      assert.ok(err.message.includes(todo.reviewedSha) && err.message.includes(head), err.message)
      assertNothingMerged(ctx, made, mainBefore)
      assert.equal(git(project.repoPath, 'show', 'main:a.txt'), 'base')
      const cur = get(ctx, todo.id)
      assert.equal(cur.gateOwner, 'human')
      assert.ok(cur.evidence.reviewDrift.includes(head))
      assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('合并未执行') && e.includes(todo.reviewedSha) && e.includes(head)))
    } finally { ctx.cleanup() }
  })
}

// #102 and #103 together: the review binding passing is not a merge. A card whose worktree record is empty
// has nothing the binding could ask git about, and must then be refused by the merge itself (#102), not
// written `done`. mergeBuild calls mergeWorktreeBranch unconditionally.
for (const caller of ['user', 'chief']) {
  test(`#103 + #102: reviewedSha matches but the worktree record is empty -> merge by the ${caller} fails with merge_verify_failed, not done`, async () => {
    const ctx = setup()
    try {
      const { todo, project } = await reviewedCard(ctx)
      assert.equal(todo.evidence.reviewVerdict, 'approved')
      assert.equal(todo.reviewedSha, git(todo.worktreePath, 'rev-parse', 'HEAD'), 'the binding itself holds')
      assert.equal(todo.evidence.reviewDrift, '')
      const mainBefore = mainHead(project)
      ctx.db.updateTodo(1, 'default', todo.id, { worktreePath: '' })
      const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller }))
      assert.ok(err, 'the merge is refused')
      assert.equal(err.code, 'MERGE_VERIFY_FAILED')
      assert.match(err.message, /工作树不存在/)
      const after = get(ctx, todo.id)
      assert.equal(after.phase, 'failed', 'not done')
      assert.equal(after.gateKind, 'failed')
      assert.equal(after.evidence.mergeVerify, 'failed')
      assert.equal(after.evidence.mergedSha, undefined, 'no mergedSha without the proof')
      assert.ok(after.lastError.startsWith('合并失败') && after.lastError.includes('merge_verify_failed'), after.lastError)
      assert.equal(after.reviewedSha, todo.reviewedSha, 'the review snapshot is kept')
      const lines = timeline(ctx, todo.id)
      assert.ok(lines.some(e => e.includes('merge_verify_failed')), 'the timeline carries the marker')
      assert.ok(!lines.some(e => e.startsWith('已合并至')), 'no merged line')
      assert.ok(existsSync(todo.worktreePath), 'the worktree directory is kept')
      assert.equal(git(project.repoPath, 'rev-parse', '--verify', `refs/heads/${todo.branch}`), todo.reviewedSha, 'the branch is kept')
      assert.equal(mainHead(project), mainBefore, 'main did not move')
    } finally { ctx.cleanup() }
  })
}

test('#103: uncommitted changes after the review -> merge is refused and nothing is committed for them', async () => {
  const ctx = setup()
  try {
    const made = await reviewedCard(ctx)
    const { todo, project } = made
    const mainBefore = mainHead(project)
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'edited after the review, not committed\n')
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.ok(err, 'the merge is refused')
    assert.match(err.message, /工作树有 1 项未提交改动/)
    assert.ok(err.message.includes(todo.reviewedSha), err.message)
    assertNothingMerged(ctx, made, mainBefore)
    assert.equal(git(todo.worktreePath, 'rev-parse', 'HEAD'), todo.reviewedSha, 'no automatic commit was made')
    assert.equal(git(todo.worktreePath, 'status', '--porcelain'), 'M a.txt')
  } finally { ctx.cleanup() }
})

test('#103: the worktree changed while the review ran -> warning on the timeline, approval not mergeable', async () => {
  const ctx = setup()
  try {
    let head = ''
    const made = await reviewedCard(ctx, {
      during: todo => {
        writeFileSync(join(todo.worktreePath, 'a.txt'), 'changed during the review\n')
        git(todo.worktreePath, 'commit', '-am', 'during review')
        head = git(todo.worktreePath, 'rev-parse', 'HEAD')
      },
    })
    const { todo, project } = made
    assert.equal(todo.evidence.reviewVerdict, 'approved', 'the verdict itself is kept')
    assert.ok(todo.evidence.reviewDrift.includes(todo.reviewedSha) && todo.evidence.reviewDrift.includes(head), todo.evidence.reviewDrift)
    assert.equal(todo.gateOwner, 'human', 'not handed to the Chief although AUTO and auto-merge are on')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('警告：审查期间工作树被改动') && e.includes(head)))
    const mainBefore = mainHead(project)
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }))
    assert.match(err?.message || '', /审查期间工作树被改动/)
    assertNothingMerged(ctx, made, mainBefore)
  } finally { ctx.cleanup() }
})

test('#103: uncommitted changes left during the review are flagged the same way', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewedCard(ctx, {
      during: t => writeFileSync(join(t.worktreePath, 'scratch.txt'), 'left by the reviewer\n'),
    })
    assert.match(todo.evidence.reviewDrift, /工作树有 1 项未提交改动（scratch\.txt）/)
    assert.equal(todo.gateOwner, 'human')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('警告：审查期间工作树被改动')))
  } finally { ctx.cleanup() }
})

test('#103: a new review of the new HEAD clears the flag and binds the new commit', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewedCard(ctx, {
      during: t => { writeFileSync(join(t.worktreePath, 'a.txt'), 'second version\n'); git(t.worktreePath, 'commit', '-am', 'v2') },
    })
    assert.ok(todo.evidence.reviewDrift)
    const head = git(todo.worktreePath, 'rev-parse', 'HEAD')
    const again = await ctx.orch.runIndependentReview(ctx.run, { todoId: todo.id })
    assert.equal(again.reviewedSha, head)
    assert.equal(again.evidence.reviewDrift, '')
    await endRun(ctx, again.reviewSessionId, APPROVE)
    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    assert.equal(done.phase, 'done')
    assert.equal(git(project.repoPath, 'show', 'main:a.txt'), 'second version')
  } finally { ctx.cleanup() }
})

test('#103: a card without reviewedSha -> the Chief is refused, the user is asked once and the second call merges', async () => {
  const ctx = setup()
  try {
    const made = await gateCard(ctx)
    const { todo, project } = made
    // A card stored before #103: approved, no reviewed commit on record.
    ctx.db.updateTodo(1, 'default', todo.id, { gateOwner: 'chief', evidence: { reviewVerdict: 'approved' } })
    assert.equal(get(ctx, todo.id).reviewedSha, '')
    const mainBefore = mainHead(project)
    const head = git(todo.worktreePath, 'rev-parse', 'HEAD')

    const chiefErr = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' }))
    assert.match(chiefErr?.message || '', /没有审查快照/)
    assertNothingMerged(ctx, made, mainBefore)
    assert.equal(get(ctx, todo.id).gateOwner, 'human')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('合并未执行：无审查快照') && e.includes('总管不能合并')))

    const firstErr = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.match(firstErr?.message || '', /没有审查快照.*再点一次合并即/)
    assertNothingMerged(ctx, made, mainBefore)
    assert.equal(get(ctx, todo.id).evidence.unreviewedMergeAsk, head)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('需要你确认') && e.includes('没有记录被审的是哪个提交')))

    // The Chief cannot use the user's pending confirmation.
    assert.ok(await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' })))
    assertNothingMerged(ctx, made, mainBefore)

    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    assert.equal(done.phase, 'done')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('用户已确认合并无审查快照的分支')))
    git(project.repoPath, 'merge-base', '--is-ancestor', head, 'main')
  } finally { ctx.cleanup() }
})

test('#103: the confirmation is for one HEAD: a commit in between asks again', async () => {
  const ctx = setup()
  try {
    const made = await gateCard(ctx)
    const { todo, project } = made
    const mainBefore = mainHead(project)
    assert.ok(await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })), 'asked first')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('这一版没有经过独立审查')), 'the reason: never reviewed')
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'another version\n')
    git(todo.worktreePath, 'commit', '-am', 'moved')
    const err = await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' }))
    assert.match(err?.message || '', /再点一次合并即/)
    assertNothingMerged(ctx, made, mainBefore)
  } finally { ctx.cleanup() }
})

test('#103: with confirmUnreviewedMerge off a card without reviewedSha merges at once, with a timeline line', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await gateCard(ctx)
    await ctx.orch.saveSettings(ctx.run, { confirmUnreviewedMerge: false })
    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    assert.equal(done.phase, 'done')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('无审查快照') && e.includes('按设置不要求确认')))
    assert.equal(git(project.repoPath, 'show', 'main:a.txt'), 'feature side')
  } finally { ctx.cleanup() }
})

test('#103: a new build dispatch clears reviewedSha with the verdict', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewedCard(ctx, { text: '缺一条用例。\nVERDICT: CHANGES_REQUESTED' })
    assert.equal(todo.evidence.reviewVerdict, 'changes_requested')
    assert.ok(todo.reviewedSha)
    const rebuilt = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false })
    assert.equal(rebuilt.phase, 'building')
    assert.equal(rebuilt.reviewedSha, '')
    assert.equal(rebuilt.evidence.reviewVerdict, 'none')
  } finally { ctx.cleanup() }
})

test('#103: a review that ends without a sole last verdict line is asked once and never settles as approved', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewedCard(ctx, { text: '核对完毕。\nVERDICT: APPROVED，前提是先补一条并发用例' })
    assert.equal(todo.phase, 'reviewing', 'asked once in the same session')
    assert.equal(todo.evidence.reviewVerdict, 'pending')
    await endRun(ctx, todo.reviewSessionId, '可以合并。\nVERDICT: APPROVED\n必改：补一条并发用例')
    const cur = get(ctx, todo.id)
    assert.equal(cur.evidence.reviewVerdict, 'inconclusive')
    assert.equal(cur.gateKind, 'review_inconclusive')
    assert.equal(cur.gateOwner, 'human')
    assert.match((await rejection(ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'chief' })))?.message || '', /inconclusive/)
  } finally { ctx.cleanup() }
})

// ---- 4. storage and contract --------------------------------------------------------------------------------

test('#103 storage: a database from before #103 gets both columns with their defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t103-db-'))
  try {
    const dataDir = join(root, 'data')
    let db = createDatabase(dataDir, {})
    db.getSettings(1, 'default')
    db.close()
    const raw = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'))
    raw.exec('ALTER TABLE todos DROP COLUMN reviewed_sha; ALTER TABLE settings DROP COLUMN confirm_unreviewed_merge;')
    assert.ok(!raw.prepare('PRAGMA table_info(todos)').all().some(c => c.name === 'reviewed_sha'))
    raw.close()
    db = createDatabase(dataDir, {})
    const check = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'), { readOnly: true })
    const todoCol = check.prepare('PRAGMA table_info(todos)').all().find(c => c.name === 'reviewed_sha')
    const settingCol = check.prepare('PRAGMA table_info(settings)').all().find(c => c.name === 'confirm_unreviewed_merge')
    check.close()
    assert.equal(todoCol?.dflt_value, "''")
    assert.equal(settingCol?.dflt_value, '1')
    assert.equal(db.getSettings(1, 'default').confirmUnreviewedMerge, true, 'the existing settings row asks')
    db.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('#103 storage: confirmUnreviewedMerge defaults to true, is saved, and is kept when another field is saved', async () => {
  const ctx = setup()
  try {
    assert.equal(ctx.db.getSettings(1, 'default').confirmUnreviewedMerge, true)
    await ctx.orch.saveSettings(ctx.run, { confirmUnreviewedMerge: false })
    assert.equal(ctx.db.getSettings(1, 'default').confirmUnreviewedMerge, false)
    await ctx.orch.saveSettings(ctx.run, { maxConcurrentBuilds: 3 })
    assert.equal(ctx.db.getSettings(1, 'default').confirmUnreviewedMerge, false)
    await ctx.orch.saveSettings(ctx.run, { confirmUnreviewedMerge: true })
    assert.equal(ctx.db.getSettings(1, 'default').confirmUnreviewedMerge, true)
  } finally { ctx.cleanup() }
})

test('#103 storage (#112): the card stub and the fitted snapshot keep reviewedSha next to the other identifying fields', () => {
  const card = {
    id: 't1', number: 7, title: '带审查快照的卡', phase: 'done', projectId: 'p1', branch: 'ekko-todo/t1',
    snapshotSha: 'a'.repeat(40), reviewedSha: 'b'.repeat(40),
    spec: 'x'.repeat(50_000), plan: '', diffs: [{ path: 'a.js' }], buildChat: [], timeline: [],
    evidence: { reviewVerdict: 'approved', reviewSummary: 'y'.repeat(500), testRc: 0 },
  }
  const stub = todoCardStub(card)
  assert.equal(stub.stubbed, true)
  assert.equal(stub.reviewedSha, 'b'.repeat(40), 'the reviewed snapshot survives the stub')
  assert.equal(stub.snapshotSha, 'a'.repeat(40))
  assert.equal(stub.branch, 'ekko-todo/t1')
  assert.equal(stub.evidence.reviewVerdict, 'approved', 'the verdict it belongs to is kept too')
  assert.equal(stub.spec, '', 'detail bodies are what the stub drops')
  assert.deepEqual(stub.stubbedFields.sort(), ['diffs', 'evidence', 'spec'])
  // A card that was never reviewed keeps its empty value instead of gaining one.
  assert.equal(todoCardStub({ ...card, reviewedSha: '' }).reviewedSha, '')
  assert.equal('reviewedSha' in todoCardStub({ id: 't2', evidence: {} }), false)
  // The same through the real path: a snapshot over the budget reduces its finished cards to stubs.
  const fitted = fitSnapshotBudget({ todos: [card], topics: [], projects: [] }, 20_000)
  assert.equal(fitted.todos.length, 1, 'the card is still listed')
  assert.equal(fitted.todos[0].stubbed, true, 'the budget forced the stub')
  assert.equal(fitted.todos[0].reviewedSha, 'b'.repeat(40))
})

test('#103 contract: the field, the setting and the rule are declared and documented', () => {
  const contract = JSON.parse(read('contracts/plugin.json'))
  const todoItem = contract.models.stateSnapshot.properties.todos.items
  assert.match(todoItem.description, /reviewedSha/)
  assert.equal(contract.models.saveSettingsInput.properties.confirmUnreviewedMerge?.type, 'boolean')
  assert.match(contract.models.saveSettingsInput.properties.confirmUnreviewedMerge.description, /default true/i)
  assert.match(todoItem.description, /todos\.reviewed_sha TEXT NOT NULL DEFAULT ''/)
  assert.match(contract.models.saveSettingsInput.properties.confirmUnreviewedMerge.description, /settings\.confirm_unreviewed_merge INTEGER NOT NULL DEFAULT 1/)
  for (const tool of ['merge_build', 'run_review', 'retry_merge']) assert.match(contract.tools[tool].description, /reviewedSha/, tool)
  assert.match(contract.rpc['todo-action'].description, /reviewedSha/)
  const docs = read('docs/CONTRACTS.md')
  for (const word of ['reviewedSha', 'reviewed_sha', 'confirmUnreviewedMerge', 'confirm_unreviewed_merge', 'reviewDrift', 'unreviewedMergeAsk', '不可合并']) {
    assert.ok(docs.includes(word), `docs/CONTRACTS.md names ${word}`)
  }
})

test('#103 prompt: the reviewer is told the verdict counts only as the sole last line and to leave the worktree alone', async () => {
  const prompts = read('src/server/prompts.mjs')
  assert.match(prompts, /very last line, alone on that line/)
  assert.match(prompts, /Do not commit, edit or leave files in the worktree/)
  const lines = prompts.slice(prompts.indexOf('Review Checklist:')).split('\n').slice(0, 8).join('\n')
  assert.match(lines, /VERDICT: APPROVED',\n\s+'   or',\n\s+'   VERDICT: CHANGES_REQUESTED'/)
})

// Regression tests for the 2026-11-23 audit fixes (P1 #1-#3, P2 #4-#10).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import { runDeterministicTestGate } from '../src/server/gate-runner.mjs'
import { parseUsageTimestamp } from '../src/server/quota-engine.mjs'

function makeFakeHost({ runDelayMs = 0, runFail = null } = {}) {
  let seq = 0
  const sessions = new Map()
  const runs = []
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input, options) {
        if (runDelayMs) await new Promise(r => setTimeout(r, runDelayMs))
        if (runFail && runFail(id, input, options)) throw new Error('HTTP 400 invalid request: bad prompt')
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        runs.push({ sessionId: id, input, options })
        return { run_id: `run-${seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { const s = sessions.get(id); return { messages: s?.messages || [] } },
    },
  }
  return { host, sessions, runs }
}

function finish(fake, sid, text) {
  const s = fake.sessions.get(sid)
  s.is_running = false
  if (text) s.messages.push({ id: `a-${Math.random().toString(36).slice(2, 8)}`, role: 'assistant', content: text, timestamp: Math.floor(Date.now() / 1000) })
}

function makeRepo(root, name = 'repo') {
  const repoPath = join(root, name)
  mkdirSync(repoPath, { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
  g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
  return { repoPath, g }
}

function setup({ maxConcurrentBuilds = 2, fakeOpts = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit-fix-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds }, log: { warn() {}, info() {} } })
  const fake = makeFakeHost(fakeOpts)
  const run = { identity: { userId: 1, profile: 'default' }, host: fake.host, messages: { emit() {} } }
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0, maxConcurrentBuilds })
  const cleanup = () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, fake, run, tools, cleanup }
}

async function buildToReview(ctx, { projectOpts = {}, todoOpts = {}, topicAutopilot = true } = {}) {
  const { root, db, orch, fake, run } = ctx
  const { repoPath, g } = makeRepo(root)
  const { project } = await orch.addProject(run, { name: 'P', repoPath, testCommand: 'true', ...projectOpts })
  if (projectOpts.autopilot) db.updateProject(1, 'default', project.id, { autopilot: projectOpts.autopilot })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: topicAutopilot })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', ...todoOpts })
  const b = await orch.startBuild(run, { todoId: todo.id })
  writeFileSync(join(b.worktreePath, 'a.txt'), 'change\n')
  finish(fake, b.buildSessionId, 'done')
  await orch.reconcileActiveRuns(run)
  return { project, topic, todo: db.getTodo(1, 'default', todo.id), build: b, repoPath, g }
}

test('P1#1 rejected review parks at the review gate and never flips back to merge-ready', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { todo, build } = await buildToReview(ctx, { projectOpts: { autopilot: { autoMergeAfterReview: true } } })
    const r = await orch.runIndependentReview(run, { todoId: todo.id })
    finish(fake, r.reviewSessionId, 'Bug found.\nVERDICT: CHANGES_REQUESTED')
    await orch.reconcileActiveRuns(run)
    await orch.reconcileActiveRuns(run)
    const t = db.getTodo(1, 'default', todo.id)
    assert.equal(t.phase, 'review')
    assert.equal(t.gateKind, 'changes')
    assert.equal(t.evidence.reviewVerdict, 'changes_requested')
    assert.equal(db.countActiveBuilds(1, 'default'), 0, 'no phantom build slot')
    assert.ok(!t.timeline.slice(-1)[0].event.startsWith('构建完成'), 'no fabricated build completion')

    // The Chief cannot merge a rejected change
    await assert.rejects(orch.mergeBuild(run, { todoId: todo.id, caller: 'chief' }), /拒绝合并/)

    // Rework is dispatched with the reviewer findings, and the verdict is reset
    const runsBefore = fake.runs.filter(x => x.sessionId === build.buildSessionId).length
    const reworked = await orch.requestChanges(run, { todoId: todo.id, note: '' })
    assert.equal(reworked.phase, 'building')
    assert.equal(reworked.evidence.reviewVerdict, 'none')
    const reworkRuns = fake.runs.filter(x => x.sessionId === build.buildSessionId)
    assert.equal(reworkRuns.length, runsBefore + 1)
    assert.ok(String(reworkRuns.at(-1).input).includes('Bug found'), 'review findings forwarded to builder')
  } finally { ctx.cleanup() }
})

test('P1#2 merge gate: only from review; Chief needs AUTO + autoMerge + approved review + passing tests; deploy needs a human', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run, tools } = ctx
    const { repoPath } = makeRepo(ctx.root, 'r2')
    const { project } = await orch.addProject(run, { name: 'Q', repoPath })
    const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: true })
    const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'deploy', kind: 'deploy' })
    const b = await orch.startBuild(run, { todoId: todo.id })
    writeFileSync(join(b.worktreePath, 'a.txt'), 'half written\n')
    const res = await tools.get('merge_build').execute({ todo_id: todo.id }, run)
    assert.equal(res.ok, false)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'building')
    assert.equal(readFileSync(join(repoPath, 'a.txt'), 'utf8'), 'base\n', 'main untouched')
    // UI merge from a non-review phase is refused too
    await assert.rejects(orch.mergeBuild(run, { todoId: todo.id, caller: 'user' }), /待合并关口/)

    // Deploy parked at review: Chief refused, human allowed
    finish(fake, b.buildSessionId, 'ok')
    await orch.reconcileActiveRuns(run)
    const r = await orch.runIndependentReview(run, { todoId: todo.id })
    finish(fake, r.reviewSessionId, 'VERDICT: APPROVED')
    await orch.reconcileActiveRuns(run)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'review')
    const chiefTry = await tools.get('merge_build').execute({ todo_id: todo.id }, run)
    assert.equal(chiefTry.ok, false)
    assert.match(chiefTry.content, /部署类任务必须由用户放行/)
    const humanMerge = await orch.mergeBuild(run, { todoId: todo.id, caller: 'user' })
    assert.equal(humanMerge.phase, 'done')
  } finally { ctx.cleanup() }
})

test('P1#2 Chief merge allowed only when every autopilot condition holds', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run, tools } = ctx
    const { todo } = await buildToReview(ctx, { projectOpts: { autopilot: { autoMergeAfterReview: true } } })
    // No review yet -> refused
    let res = await tools.get('merge_build').execute({ todo_id: todo.id }, run)
    assert.equal(res.ok, false)
    assert.match(res.content, /APPROVED/)
    const r = await orch.runIndependentReview(run, { todoId: todo.id })
    finish(fake, r.reviewSessionId, 'Looks fine.\nVERDICT: APPROVED')
    await orch.reconcileActiveRuns(run)
    const parked = db.getTodo(1, 'default', todo.id)
    assert.equal(parked.gateOwner, 'chief')
    res = await tools.get('merge_build').execute({ todo_id: todo.id }, run)
    assert.equal(res.ok, true, res.content)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'done')
  } finally { ctx.cleanup() }
})

test('P1#2 Chief merge refused when the test gate failed or auto-merge is off', async () => {
  const ctx = setup()
  try {
    const { orch, fake, run, tools } = ctx
    const { todo } = await buildToReview(ctx, { projectOpts: { testCommand: 'false', autopilot: { autoMergeAfterReview: true } } })
    const r = await orch.runIndependentReview(run, { todoId: todo.id })
    finish(fake, r.reviewSessionId, 'VERDICT: APPROVED')
    await orch.reconcileActiveRuns(run)
    const res = await tools.get('merge_build').execute({ todo_id: todo.id }, run)
    assert.equal(res.ok, false)
    assert.match(res.content, /验收命令未通过/)
  } finally { ctx.cleanup() }
  const ctx2 = setup()
  try {
    const { orch, fake, run, tools } = ctx2
    const { todo } = await buildToReview(ctx2)
    const r = await orch.runIndependentReview(run, { todoId: todo.id })
    finish(fake, r.reviewSessionId, 'VERDICT: APPROVED')
    await orch.reconcileActiveRuns(run)
    const res = await tools.get('merge_build').execute({ todo_id: todo.id }, run)
    assert.equal(res.ok, false)
    assert.match(res.content, /未允许审查通过后由总管合并/)
  } finally { ctx2.cleanup() }
})

test('P1#3 test gate timeout kills the whole process group and resolves on time', async () => {
  const t0 = Date.now()
  const r = await runDeterministicTestGate({ cwd: tmpdir(), command: 'sleep 30 && echo done', timeoutMs: 5000 })
  const elapsed = Date.now() - t0
  assert.equal(r.exitCode, 124)
  assert.ok(elapsed < 9000, `resolved after ${elapsed}ms`)
  // Shell exits but a background child keeps the pipe open -> still resolves with the shell's code
  const t1 = Date.now()
  const r2 = await runDeterministicTestGate({ cwd: tmpdir(), command: '(sleep 30 &) ; exit 0', timeoutMs: 60000 })
  assert.equal(r2.exitCode, 0)
  assert.ok(Date.now() - t1 < 6000)
})

test('P2#4 successful merge restores the user main checkout branch', async () => {
  const ctx = setup()
  try {
    const { orch, run } = ctx
    const { todo, g } = await buildToReview(ctx, { topicAutopilot: false })
    g('checkout', '-b', 'my-feature')
    const done = await orch.mergeBuild(run, { todoId: todo.id })
    assert.equal(done.phase, 'done')
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'my-feature')
    assert.equal(g('show', 'main:a.txt'), 'change')
    assert.equal(done.snapshotSha, g('rev-parse', '--short', 'main'))
  } finally { ctx.cleanup() }
})

test('P2#5 concurrency limit holds under parallel dispatch', async () => {
  const ctx = setup({ maxConcurrentBuilds: 1 })
  try {
    const { db, orch, run, root } = ctx
    const { repoPath } = makeRepo(root)
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    const ids = []
    for (const n of [1, 2, 3]) ids.push((await orch.createTodo(run, { projectId: project.id, title: `t${n}` })).todo.id)
    await Promise.all(ids.map(id => orch.startBuild(run, { todoId: id })))
    const phases = ids.map(id => db.getTodo(1, 'default', id).phase).sort()
    assert.deepEqual(phases, ['building', 'queued', 'queued'])
  } finally { ctx.cleanup() }
})

test('P2#6/#7 queued Chief message survives a failed launch; concurrent sends open one Chief run', async () => {
  let failNext = false
  const ctx = setup({ fakeOpts: { runFail: () => failNext } })
  try {
    const { db, orch, fake, run } = ctx
    const { topic } = await orch.createTopic(run, {})
    await orch.sendTopicMessage(run, { topicId: topic.id, text: 'first' })
    const sid = db.getTopic(1, 'default', topic.id).chiefSessionId
    await orch.sendTopicMessage(run, { topicId: topic.id, text: 'SECOND' })
    fake.sessions.get(sid).is_running = false
    failNext = true
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    const q = db.listTopicQueue(1, 'default', topic.id)
    assert.deepEqual(q.map(x => x.text), ['SECOND'], 'item put back in the queue')
    const tp = db.getTopic(1, 'default', topic.id)
    assert.ok(tp.messages.some(m => m.kind === 'system' && m.text.includes('没能发给大总管')), 'user is told')
    // Since 0.9.42 a message that went back to the queue is not also left as a bubble.
    assert.equal(tp.messages.filter(m => m.kind === 'human' && m.text === 'SECOND').length, 0)
  } finally { ctx.cleanup() }

  const ctx2 = setup({ fakeOpts: { runDelayMs: 30 } })
  try {
    const { db, orch, fake, run } = ctx2
    const { topic } = await orch.createTopic(run, {})
    await Promise.all([
      orch.sendTopicMessage(run, { topicId: topic.id, text: 'A' }),
      orch.sendTopicMessage(run, { topicId: topic.id, text: 'B' }),
    ])
    assert.equal(fake.runs.length, 1)
    assert.equal(db.listTopicQueue(1, 'default', topic.id).length, 1)
  } finally { ctx2.cleanup() }
})

test('P2#8 deleting a project removes its todos, schedules and worktrees and frees the slot', async () => {
  const ctx = setup({ maxConcurrentBuilds: 1 })
  try {
    const { db, orch, fake, run, root } = ctx
    const { repoPath, g } = makeRepo(root, 'r1')
    const { repoPath: repo2 } = makeRepo(root, 'r2')
    const { project } = await orch.addProject(run, { name: 'Gone', repoPath })
    const { project: p2 } = await orch.addProject(run, { name: 'Alive', repoPath: repo2 })
    const { todo } = await orch.createTodo(run, { projectId: project.id, title: 'orphan' })
    const b = await orch.startBuild(run, { todoId: todo.id })
    await orch.saveSchedule(run, { todoId: todo.id, frequency: 'hourly', minute: 0 })
    await orch.deleteProject(run, project.id)
    assert.equal(db.getTodo(1, 'default', todo.id), null)
    assert.equal(fake.sessions.get(b.buildSessionId).is_running, false, 'live build stopped')
    assert.equal(existsSync(b.worktreePath), false, 'worktree removed')
    assert.ok(g('branch', '--list').includes(b.branch), 'branch kept in the user repo')
    const snap = await orch.getSnapshot(run)
    assert.equal(snap.schedules.filter(s => s.todoId === todo.id).length, 0)
    const { todo: t2 } = await orch.createTodo(run, { projectId: p2.id, title: 'other' })
    const s2 = await orch.startBuild(run, { todoId: t2.id })
    assert.equal(s2.phase, 'building', 'slot freed')
  } finally { ctx.cleanup() }
})

test('P2#9 usage timestamps: Magpie `t`, epoch seconds/ms, and no Date.parse(0) year-2000 artefact', () => {
  assert.equal(parseUsageTimestamp({ t: '2026-10-01T14:40:24.764178+08:00' }), Date.parse('2026-10-01T14:40:24.764+08:00'))
  assert.equal(parseUsageTimestamp({ ts: 1795420138 }), 1795420138000)
  assert.equal(parseUsageTimestamp({ timestamp_ms: 1795420138258 }), 1795420138258)
  assert.equal(parseUsageTimestamp({}), 0)
  assert.equal(parseUsageTimestamp({ at: 0 }), 0)
})

test('P2#10 project autopilot switches are enforced for Chief actions', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, tools, root } = ctx
    const { repoPath } = makeRepo(root)
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    db.updateProject(1, 'default', project.id, { autopilot: { autoDispatch: false, autoAnswerRoutine: false } })
    const { todo } = await orch.createTodo(run, { projectId: project.id, title: 'x' })
    await assert.rejects(tools.get('run_build').execute({ todo_id: todo.id }, run), /允许总管直接派工/)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'todo')
    await orch.askUserQuestion(run, { todoId: todo.id, title: 'Q?', why: '', options: ['a', 'b'] })
    await assert.rejects(tools.get('message_todo').execute({ todo_id: todo.id, message: 'pick a' }, run), /需要用户本人答复/)
    // The user's own UI action is unaffected
    const started = await orch.answerQuestion(run, { todoId: todo.id, optionId: 'opt-1', note: '' })
    assert.equal(started.phase, 'building')
  } finally { ctx.cleanup() }
})

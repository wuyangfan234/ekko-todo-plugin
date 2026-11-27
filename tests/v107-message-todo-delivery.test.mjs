// Todo #107: a follow-up instruction (message_todo) to a card is never lost on the way to the worker.
// The loss: a card parked at a gate got the message while every build slot was taken; the dispatch parked the
// card in `queued` and dropped the message, and the start out of the queue sent the task prompt only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import { FOLLOW_UP_HEADING, FOLLOW_UP_REPORT_HEADING, FOLLOW_UP_SPEC_HEADING, buildFollowUpPrompt } from '../src/server/prompts.mjs'

const SPEC = 'SPEC-ORIGINAL-107：把导出按钮接到后端'
const REPORT = 'REPORT-ROUND-1：改了 a.txt，门禁 rc=0'
const MESSAGE = '必改项一：补空列表用例\n必改项二：导出失败要提示\n必改项三：文档同步\n必改项四：去掉调试日志'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-107-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const calls = { run: 0, inputs: [], sessionIds: [] }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        calls.run += 1
        calls.inputs.push(String(input))
        calls.sessionIds.push(id)
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
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, calls, sessions, cleanup }
}

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
  g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
  return repoPath
}

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))

async function project(ctx, { slots = 2 } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0, maxConcurrentBuilds: slots })
  const { project: p } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
  const { topic } = await orch.createTopic(run, { projectId: p.id, autopilot: true })
  return { project: p, topic }
}

// A card whose first round is over. `phase`: where it stopped; 'building' leaves it building with an idle session.
async function card(ctx, env, { phase = 'review', title = 'T', spec = SPEC } = {}) {
  const { orch, run, db } = ctx
  const { todo } = await orch.createTodo(run, { projectId: env.project.id, topicId: env.topic.id, title, spec })
  const built = await orch.startBuild(run, { todoId: todo.id })
  assert.equal(built.phase, 'building')
  const s = ctx.sessions.get(built.buildSessionId)
  s.is_running = false
  if (phase === 'building') return get(ctx, todo.id)
  // The first round really ends: a commit in the worktree, a final report, the host event. The card settles
  // at the merge gate with the report stored by the settle itself.
  writeFileSync(join(built.worktreePath, `${title}.txt`), 'work\n')
  execFileSync('git', ['add', '.'], { cwd: built.worktreePath, stdio: 'pipe' })
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-m', 'work'], { cwd: built.worktreePath, stdio: 'pipe' })
  s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: REPORT, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: built.buildSessionId, finish_reason: 'stop' } }, run)
  const settled = get(ctx, todo.id)
  assert.equal(settled.phase, 'review', `first round settled at the gate (${settled.lastError})`)
  assert.equal(settled.evidence.workerReport, REPORT)
  if (phase !== 'review') {
    db.updateTodo(1, 'default', todo.id, {
      phase,
      gateOwner: 'human',
      gateKind: phase === 'failed' ? 'failed' : 'none',
      lastError: phase === 'failed' ? '构建失败：x' : '',
    })
  }
  return get(ctx, todo.id)
}

function assertFollowUp(input, { message = MESSAGE, report = REPORT, spec = SPEC } = {}) {
  assert.ok(input.includes(message), 'the prompt of the new round quotes the message verbatim')
  assert.ok(input.includes(FOLLOW_UP_HEADING), 'under the follow-up heading')
  assert.ok(input.includes('上一轮已完成、且追加要求没有要求改动的部分不要重做'), 'and says not to redo finished work')
  assert.ok(input.includes(FOLLOW_UP_REPORT_HEADING) && input.includes(report), 'the report of the round before is there')
  assert.ok(input.includes(FOLLOW_UP_SPEC_HEADING) && input.includes('Task Specification:') && input.includes(spec), 'and the task specification')
  assert.ok(input.indexOf(message) < input.indexOf(spec), 'the message comes first')
}

// ---- 1. a card parked at a gate ---------------------------------------------------------------------------

for (const phase of ['review', 'failed', 'todo']) {
  test(`#107: message_todo to a card parked in ${phase} starts a round whose prompt holds message + report + spec`, async () => {
    const ctx = setup()
    try {
      const env = await project(ctx)
      const todo = await card(ctx, env, { phase })
      const runs = ctx.calls.run
      const res = await ctx.orch.messageTodo(ctx.run, { todoId: todo.id, note: MESSAGE, caller: 'chief' })
      assert.equal(res.phase, 'building')
      assert.equal(ctx.calls.run, runs + 1)
      assertFollowUp(ctx.calls.inputs.at(-1))
      assert.match(ctx.calls.inputs.at(-1), /由 message_todo 触发/)
      const tl = timeline(ctx, todo.id)
      const line = tl.find(t => t.startsWith('本轮由 message_todo 触发'))
      assert.ok(line, 'the timeline says what started the round')
      assert.ok(line.includes(`追加要求 ${MESSAGE.length} 字`), 'with the size of the message')
      assert.ok(line.includes('必改项一：补空列表用例'), 'and quotes it')
      assert.ok(line.includes('已与原任务书、上一轮报告一并下达'))
    } finally { ctx.cleanup() }
  })
}

// ---- 2. the reported loss: no build slot is free ----------------------------------------------------------

test('#107: a message sent while every build slot is taken waits with the card and goes out with the start', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls } = ctx
    const env = await project(ctx, { slots: 1 })
    const todo = await card(ctx, env, { phase: 'review' })
    const blocker = await card(ctx, env, { phase: 'building', title: 'blocker', spec: 'other' })
    ctx.sessions.get(blocker.buildSessionId).is_running = true // the other card is in the middle of its turn
    const runs = calls.run

    const tools = new Map()
    registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
    const answer = await tools.get('message_todo').execute({ todo_id: todo.id, message: MESSAGE }, run)
    assert.equal(get(ctx, todo.id).phase, 'queued')
    assert.equal(calls.run, runs, 'no run was sent')
    assert.equal(answer.data.parked, true)
    assert.match(answer.content, /NOT delivered yet/)
    assert.doesNotMatch(answer.content, /resumed execution/, 'the tool does not claim a delivery')
    const q = db.listTodoQueue(1, 'default', todo.id)
    assert.equal(q.length, 1, 'the message is stored with the card')
    assert.equal(q[0].text, MESSAGE)
    assert.ok(timeline(ctx, todo.id).some(t => /并发槽位已满/.test(t) && t.includes(`本次指令（${MESSAGE.length} 字）已随卡片保存`)))

    // The reconcile leaves a queued card's instructions alone (they are not sent bare into the old session).
    await orch.reconcileActiveRuns(run).catch(() => {})
    assert.equal(calls.run, runs)
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 1)

    // The slot frees up: the card leaves the queue.
    db.updateTodo(1, 'default', blocker.id, { phase: 'review', gateOwner: 'human', gateKind: 'merge' })
    await orch.settleWorkerRun(run, 1, 'default', blocker.id, { sessionId: '', outcome: 'completed' })
    assert.equal(get(ctx, todo.id).phase, 'building')
    assert.equal(calls.run, runs + 1)
    assertFollowUp(calls.inputs.at(-1))
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 0, 'delivered, so out of the queue')
    const line = timeline(ctx, todo.id).find(t => t.startsWith('本轮由 message_todo 触发'))
    assert.ok(line && line.includes('排队期间保存的 1 条') && line.includes('必改项一'))
  } finally { ctx.cleanup() }
})

// ---- 3. control: a card that is building --------------------------------------------------------------------

test('#107: a message to a building card goes into its session as it is (idle) or waits for the turn (busy); no restart', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, sessions } = ctx
    const env = await project(ctx)
    const todo = await card(ctx, env, { phase: 'building' })
    const sid = todo.buildSessionId
    const runs = calls.run
    const res = await orch.messageTodo(run, { todoId: todo.id, note: MESSAGE })
    assert.equal(res.phase, 'building')
    assert.equal(res.buildSessionId, sid, 'same session')
    assert.equal(calls.run, runs + 1)
    assert.equal(calls.sessionIds.at(-1), sid)
    assert.equal(calls.inputs.at(-1), MESSAGE, 'the bare message, no task prompt again')
    assert.ok(timeline(ctx, todo.id).some(t => t.startsWith('本轮由 message_todo 触发') && t.includes('已投递到当前会话（未重启）')))

    // Busy now (the run above is going on): the next message waits, nothing is sent.
    assert.equal(sessions.get(sid).is_running, true)
    const queued = await orch.messageTodo(run, { todoId: todo.id, note: '再加一条' })
    assert.equal(queued.queued, true)
    assert.equal(calls.run, runs + 1)
    assert.deepEqual(db.listTodoQueue(1, 'default', todo.id).map(i => i.text), ['再加一条'])
  } finally { ctx.cleanup() }
})

// ---- 4. empty and over-long messages --------------------------------------------------------------------------

test('#107: an empty or over-long message is refused with a reason on the card; nothing is sent or cut', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, sessions } = ctx
    const env = await project(ctx)
    const todo = await card(ctx, env, { phase: 'review' })
    const runs = calls.run
    await assert.rejects(() => orch.messageTodo(run, { todoId: todo.id, note: '  \n ' }), /内容为空/)
    await assert.rejects(() => orch.messageTodo(run, { todoId: todo.id, note: 'x'.repeat(20001) }), /20001 字，超过上限 20000 字/)
    assert.equal(calls.run, runs)
    assert.equal(get(ctx, todo.id).phase, 'review', 'the card is unchanged')
    const tl = timeline(ctx, todo.id)
    assert.ok(tl.some(t => t === '补充指令没有发出：内容为空'))
    assert.ok(tl.some(t => /补充指令没有发出：内容 20001 字，超过上限 20000 字/.test(t)))
    // Exactly at the limit: accepted and delivered whole.
    const big = 'y'.repeat(20000)
    await orch.messageTodo(run, { todoId: todo.id, note: big })
    assert.ok(calls.inputs.at(-1).includes(big))

    // Longer than what todo_queue stores and the session is busy: refused, not queued cut.
    const sid = get(ctx, todo.id).buildSessionId
    assert.equal(sessions.get(sid).is_running, true)
    await assert.rejects(() => orch.messageTodo(run, { todoId: todo.id, note: 'z'.repeat(12001) }), /超过排队上限 12000 字/)
    assert.equal(db.listTodoQueue(1, 'default', todo.id).length, 0)
    assert.ok(timeline(ctx, todo.id).some(t => /补充指令没有送达：.*超过排队上限/.test(t)))
  } finally { ctx.cleanup() }
})

// ---- 5. neighbours ----------------------------------------------------------------------------------------------

test('#107: request_changes at the gate is a follow-up round too, and run_build at the gate sends the current spec', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls } = ctx
    const env = await project(ctx)
    const todo = await card(ctx, env, { phase: 'review' })
    await orch.requestChanges(run, { todoId: todo.id, note: '命名改掉' })
    assertFollowUp(calls.inputs.at(-1), { message: '命名改掉' })
    assert.match(calls.inputs.at(-1), /由 request_changes 触发/)

    const other = await card(ctx, env, { phase: 'review', title: 'other' })
    db.updateTodo(1, 'default', other.id, { spec: 'SPEC-REWRITTEN-107' })
    await orch.startBuild(run, { todoId: other.id })
    assert.ok(calls.inputs.at(-1).includes('SPEC-REWRITTEN-107'), 'run_build on a review card carries the new spec')
    assert.ok(!calls.inputs.at(-1).includes(FOLLOW_UP_HEADING))
  } finally { ctx.cleanup() }
})

test('#107: buildFollowUpPrompt says when no report was recorded and when the report is cut', () => {
  const none = buildFollowUpPrompt({ todo: { number: 7 }, basePrompt: 'BASE', message: 'M' })
  assert.match(none, /没有记录到上一轮的报告/)
  const long = buildFollowUpPrompt({ todo: { number: 7 }, basePrompt: 'BASE', message: 'M', previousReport: 'r'.repeat(5000) })
  assert.match(long, /报告共 5000 字，此处只引用前 3000 字/)
  assert.ok(long.endsWith('BASE'))
})

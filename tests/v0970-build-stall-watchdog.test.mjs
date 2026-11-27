// v0.9.70 (#85): stall watchdog of building / reviewing cards.
// #83 hung: the worker session's model request #14 never returned, the host kept answering "working" and sent no
// event for 50+ minutes; the card stayed `building` until the Chief stopped it by hand. reconcileActiveRuns only
// settles a session the probe reports idle and skips one it cannot tell, so nothing brought the card back.
// The watchdog (src/server/orchestrator.mjs watchStalledRun) measures the silence of each building / reviewing
// card on the injected clock: soft at buildStallWarnMs (one timeline line, snapshot `stall.suspicious`, nothing
// stopped), hard at buildStallHealMs (2x while a tool call is open) or the probe unknown for 3 minutes with no
// event: one more probe, then building -> cancelBuild(discard:false) (worktree and branch kept), reviewing ->
// merge gate with reviewVerdict none. At most one card per reconcile pass.
// Control groups (must never stop a card): events every 8 minutes; a 20-minute test gate; a 12-minute tool call;
// a 40-minute build with frequent events.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { stallHint } from '../src/client/stall-view.js'

const MIN = 60 * 1000

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-stall-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const logs = []
  const log = { warn(msg) { logs.push(String(msg)) }, info() {}, error() {} }
  // Only the orchestrator's clock moves (hooks.now); Date.now stays real.
  const hooks = { now: 0 }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], clock: () => hooks.now || Date.now() })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, stop: 0, connect: 0 }
  // probeUnknown: sessions the host cannot tell about (live probe refused, detail missing).
  // onConnect(id, n): called on every live probe with its running count (lets a test act between the two probes).
  const flags = { probeUnknown: new Set(), onConnect: null }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) {
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
      async stop(id) { calls.stop += 1; const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { if (flags.probeUnknown.has(id)) return null; const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false } },
      async connect(id, cb) {
        calls.connect += 1
        if (flags.onConnect) flags.onConnect(id, calls.connect)
        if (flags.probeUnknown.has(id)) throw new Error('unknown session')
        const timer = setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(sessions.get(id)?.is_running), runStartedAt: 0, queueLength: 0 }), 0)
        return { close() { clearTimeout(timer) } }
      },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {}, notify() {} } }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, calls, flags, hooks, sessions, logs, cleanup }
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
const SOFT = '疑似卡住（未打断运行'
const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const softLines = (ctx, id) => timeline(ctx, id).filter(e => e.includes(SOFT))
const tick = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
const hasBranch = (repoPath, branch) => git(repoPath, 'branch', '--list', branch).includes(branch)
const realNow = Date.now
async function reaches(check, ms = 4000) {
  const until = realNow() + ms
  while (!check()) {
    if (realNow() > until) return false
    await tick(25)
  }
  return true
}

async function workspace(ctx, { settings = {}, testCommand = 'true', maxConcurrentBuilds = 2 } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0, maxConcurrentBuilds, ...settings })
  await orch.saveAgent(run, { name: '看门狗测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '看门狗测试 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
  return { project, topic, agent }
}

async function buildingCard(ctx, ws, title = 'T') {
  const { todo } = await ctx.orch.createTodo(ctx.run, { projectId: ws.project.id, topicId: ws.topic.id, title, agentId: ws.agent.id })
  const built = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, withPlan: false })
  assert.equal(built.phase, 'building')
  assert.equal(ctx.sessions.get(built.buildSessionId).is_running, true, 'the host reports the build session working')
  return get(ctx, todo.id)
}

// Moves the orchestrator clock to `atMs` after the start and runs one reconcile pass.
async function passAt(ctx, t0, atMs) {
  ctx.hooks.now = t0 + atMs
  return ctx.orch.reconcileActiveRuns(ctx.run)
}

const hostEvent = (ctx, sessionId, type = 'chat.message.delta', data = {}) =>
  ctx.orch.handleHostEvent({ type, data: { session_id: sessionId, ...data } }, ctx.run)

test('#85 a hung build (host says working, no event): soft mark once at 10 min, then back to todo at 30 min with worktree and branch kept', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 5 * MIN)
    assert.equal(softLines(ctx, card.id).length, 0, 'no mark before the soft threshold')

    await passAt(ctx, t0, 11 * MIN)
    assert.equal(get(ctx, card.id).phase, 'building', 'the soft mark does not stop anything')
    assert.equal(softLines(ctx, card.id).length, 1)
    assert.match(softLines(ctx, card.id)[0], /已 11 分钟没有任何事件/)
    const snap = await ctx.orch.getSnapshot(ctx.run)
    const view = snap.todos.find(t => t.id === card.id)
    assert.equal(view.stall?.suspicious, true, 'the snapshot carries the derived stall view')
    assert.ok(view.stall.silentMs >= 11 * MIN)
    assert.equal(ctx.db.getTodo(1, 'default', card.id).stall, undefined, 'the stall view is not stored on the card')

    await passAt(ctx, t0, 20 * MIN)
    assert.equal(softLines(ctx, card.id).length, 1, 'the soft line is written once per silence')
    const stopsBefore = ctx.calls.stop
    await passAt(ctx, t0, 31 * MIN)
    const after = get(ctx, card.id)
    assert.equal(after.phase, 'todo', 'back to be dispatched again')
    assert.match(after.lastError, /^疑似卡住（已 31 分钟无事件），已退回待派发；工作树与分支保留，可直接重新派发续跑$/)
    assert.ok(timeline(ctx, card.id).some(e => e.startsWith('疑似卡住（已 31 分钟无事件）')), 'the reason is on the timeline')
    assert.ok(!timeline(ctx, card.id).includes('已停止当前运行'), 'not written as a stop by the user')
    assert.equal(ctx.calls.stop, stopsBefore + 1, 'the hung session was stopped')
    assert.ok(after.worktreePath && existsSync(after.worktreePath), 'discard:false keeps the worktree')
    assert.equal(after.worktreePath, card.worktreePath)
    assert.equal(after.branch, card.branch)
    assert.ok(hasBranch(ws.project.repoPath, card.branch), 'discard:false keeps the branch')
    assert.ok(ctx.logs.some(l => l.startsWith('Stall watchdog stopped')))
  } finally {
    ctx.cleanup()
  }
})

test('#85 the probe cannot tell the state for 3 minutes and nothing happens: back to todo', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    ctx.flags.probeUnknown.add(card.buildSessionId)
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 2 * MIN)
    assert.equal(get(ctx, card.id).phase, 'building', 'unknown for 2 minutes is not enough')
    await passAt(ctx, t0, 3 * MIN + 1000)
    const after = get(ctx, card.id)
    assert.equal(after.phase, 'todo')
    assert.match(after.lastError, /^疑似卡住（宿主连续 3 分钟答不出会话状态，期间没有任何事件），已退回待派发；工作树与分支保留/)
    assert.ok(existsSync(after.worktreePath) && hasBranch(ws.project.repoPath, after.branch))
  } finally {
    ctx.cleanup()
  }
})

test('#85 control: unknown probe but events keep arriving: never stopped', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    ctx.flags.probeUnknown.add(card.buildSessionId)
    const t0 = Date.now()
    const probesBefore = ctx.calls.connect
    for (let m = 0; m <= 12; m += 1) {
      ctx.hooks.now = t0 + m * MIN
      await hostEvent(ctx, card.buildSessionId)
      await passAt(ctx, t0, m * MIN + 30 * 1000)
    }
    assert.equal(get(ctx, card.id).phase, 'building')
    assert.equal(softLines(ctx, card.id).length, 0)
    // Recent events keep the unknown path from even asking for a confirmation probe: one probe per pass.
    assert.equal(ctx.calls.connect - probesBefore, 13)
  } finally {
    ctx.cleanup()
  }
})

test('#85 control: a long task with an event every 8 minutes is never marked or stopped', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    for (let m = 8; m <= 64; m += 8) {
      await passAt(ctx, t0, m * MIN - 30 * 1000)
      ctx.hooks.now = t0 + m * MIN
      await hostEvent(ctx, card.buildSessionId)
    }
    await passAt(ctx, t0, 64 * MIN + 1000)
    assert.equal(get(ctx, card.id).phase, 'building')
    assert.equal(softLines(ctx, card.id).length, 0)
  } finally {
    ctx.cleanup()
  }
})

test('#85 control: a normal 40-minute build with frequent events is never marked or stopped', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    const t0 = Date.now()
    for (let m = 0; m <= 40; m += 1) {
      ctx.hooks.now = t0 + m * MIN
      await hostEvent(ctx, card.buildSessionId, m % 2 ? 'chat.tool.started' : 'chat.tool.completed', { name: 'terminal' })
      await passAt(ctx, t0, m * MIN + 20 * 1000)
    }
    assert.equal(get(ctx, card.id).phase, 'building')
    assert.equal(softLines(ctx, card.id).length, 0)
    const view = (await ctx.orch.getSnapshot(ctx.run)).todos.find(t => t.id === card.id)
    assert.equal(view.stall?.suspicious, false)
  } finally {
    ctx.cleanup()
  }
})

test('#85 control: a 12-minute tool call may get the soft mark but never the hard stop (tool still open)', async () => {
  const ctx = setup()
  try {
    // Thresholds low enough that 12 minutes passes the hard one without the open tool (see the next test).
    const ws = await workspace(ctx, { settings: { buildStallWarnMs: 5 * MIN, buildStallHealMs: 10 * MIN } })
    const card = await buildingCard(ctx, ws)
    const t0 = Date.now()
    ctx.hooks.now = t0
    await hostEvent(ctx, card.buildSessionId, 'chat.tool.started', { name: 'terminal' })
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 6 * MIN)
    assert.equal(softLines(ctx, card.id).length, 1, 'the soft mark may appear')
    assert.match(softLines(ctx, card.id)[0], /工具「terminal」仍未返回/)
    await passAt(ctx, t0, 12 * MIN)
    assert.equal(get(ctx, card.id).phase, 'building', 'the hard stop must not fire while the tool is open')
    ctx.hooks.now = t0 + 12 * MIN + 1000
    await hostEvent(ctx, card.buildSessionId, 'chat.tool.completed', { name: 'terminal' })
    await passAt(ctx, t0, 13 * MIN)
    assert.equal(get(ctx, card.id).phase, 'building')
  } finally {
    ctx.cleanup()
  }
})

test('#85 counter-check: the same 12 minutes without an open tool is stopped (the hard threshold is live)', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx, { settings: { buildStallWarnMs: 5 * MIN, buildStallHealMs: 10 * MIN } })
    const card = await buildingCard(ctx, ws)
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 6 * MIN)
    await passAt(ctx, t0, 12 * MIN)
    assert.equal(get(ctx, card.id).phase, 'todo')
  } finally {
    ctx.cleanup()
  }
})

test('#85 control: a 20-minute test gate counts as activity (no mark, no stop)', async () => {
  const ctx = setup()
  try {
    const flagDir = join(ctx.root, 'gate')
    mkdirSync(flagDir, { recursive: true })
    const started = join(flagDir, 'started')
    const release = join(flagDir, 'release')
    const ws = await workspace(ctx, { testCommand: `touch "${started}"; while [ ! -f "${release}" ]; do sleep 0.05; done` })
    const card = await buildingCard(ctx, ws)
    writeFileSync(join(card.worktreePath, 'a.txt'), 'work\n')
    git(card.worktreePath, 'commit', '-am', 'work')
    const t0 = Date.now()
    ctx.hooks.now = t0
    const s = ctx.sessions.get(card.buildSessionId)
    s.is_running = false
    s.messages.push({ id: 'a-1', role: 'assistant', content: '完成：改了 a.txt 并提交。', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    const settling = hostEvent(ctx, card.buildSessionId, 'chat.run.completed', { finish_reason: 'stop' })
    assert.ok(await reaches(() => existsSync(started)), 'the test gate is running')
    // While the gate runs the host reports the session working again (e.g. a queued turn): the card is watched.
    s.is_running = true
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 20 * MIN)
    assert.equal(get(ctx, card.id).phase, 'building')
    assert.equal(softLines(ctx, card.id).length, 0, 'the test gate is activity')
    writeFileSync(release, '')
    await settling
    assert.equal(get(ctx, card.id).phase, 'review')
  } finally {
    ctx.cleanup()
  }
})

test('#85 switched off: 31 minutes of silence do nothing', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx, { settings: { buildStallWatchdog: false } })
    assert.equal(ctx.db.getSettings(1, 'default').buildStallWatchdog, false)
    const card = await buildingCard(ctx, ws)
    const t0 = Date.now()
    const stops = ctx.calls.stop
    for (const m of [0, 11, 31, 61]) await passAt(ctx, t0, m * MIN)
    assert.equal(get(ctx, card.id).phase, 'building')
    assert.equal(softLines(ctx, card.id).length, 0)
    assert.equal(ctx.calls.stop, stops)
    const view = (await ctx.orch.getSnapshot(ctx.run)).todos.find(t => t.id === card.id)
    assert.equal(view.stall, undefined, 'no stall view while the watchdog is off')
  } finally {
    ctx.cleanup()
  }
})

test('#85 at most one card is stopped per reconcile pass', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx, { maxConcurrentBuilds: 3 })
    const cards = []
    for (const title of ['A', 'B', 'C']) cards.push(await buildingCard(ctx, ws, title))
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 11 * MIN)
    await passAt(ctx, t0, 31 * MIN)
    const back = () => cards.filter(c => get(ctx, c.id).phase === 'todo').length
    assert.equal(back(), 1, 'one pass stops one card')
    // #91: and one per cooldown window (default 5 minutes), not one per 6-second pass.
    await passAt(ctx, t0, 31 * MIN + 6000)
    await passAt(ctx, t0, 31 * MIN + 12000)
    assert.equal(back(), 1, 'the next passes inside the cooldown stop nothing')
    await passAt(ctx, t0, 36 * MIN + 1000)
    assert.equal(back(), 2)
    await passAt(ctx, t0, 41 * MIN + 2000)
    assert.equal(back(), 3)
  } finally {
    ctx.cleanup()
  }
})

test('#85 second probe: an event between the two probes cancels the stop', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 11 * MIN)
    // The pass at 31 min probes twice: first the reconcile probe, then the confirmation. An event arrives
    // right when the confirmation probe asks.
    const first = ctx.calls.connect + 1
    ctx.flags.onConnect = (id, n) => {
      if (id === card.buildSessionId && n === first + 1) void hostEvent(ctx, id)
    }
    await passAt(ctx, t0, 31 * MIN)
    ctx.flags.onConnect = null
    assert.equal(get(ctx, card.id).phase, 'building', 'activity found by the confirmation step: nothing is stopped')
    assert.ok(ctx.calls.connect >= first + 1, 'the confirmation probe ran')
  } finally {
    ctx.cleanup()
  }
})

test('#85 a hung review goes back to the merge gate like the unlaunched-review heal, writing no verdict', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    writeFileSync(join(card.worktreePath, 'a.txt'), 'work\n')
    git(card.worktreePath, 'commit', '-am', 'work')
    const s = ctx.sessions.get(card.buildSessionId)
    s.is_running = false
    s.messages.push({ id: 'a-1', role: 'assistant', content: '完成：改了 a.txt 并提交。', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    await hostEvent(ctx, card.buildSessionId, 'chat.run.completed', { finish_reason: 'stop' })
    assert.equal(get(ctx, card.id).phase, 'review')
    const reviewing = await ctx.orch.runIndependentReview(ctx.run, { todoId: card.id })
    assert.equal(reviewing.phase, 'reviewing')
    assert.ok(reviewing.reviewRunId, 'a review run is on the card')
    assert.equal(ctx.sessions.get(reviewing.reviewSessionId).is_running, true)
    const t0 = Date.now()
    const stops = ctx.calls.stop
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 11 * MIN)
    assert.equal(softLines(ctx, card.id).length, 1)
    await passAt(ctx, t0, 31 * MIN)
    const after = get(ctx, card.id)
    assert.equal(after.phase, 'review', 'back to the merge gate, not to todo')
    assert.equal(after.gateKind, 'merge')
    assert.equal(after.evidence.reviewVerdict, 'none', 'no verdict is written (no approved / changes_requested / inconclusive)')
    assert.equal(after.reviewRunId, '')
    assert.match(after.lastError, /^审查疑似卡住（已 31 分钟无事件），已停止该审查并回到待合并关口，没有写入任何审查结论/)
    assert.ok(!timeline(ctx, card.id).some(e => e.startsWith('独立审查结论')), 'no verdict line')
    assert.equal(ctx.calls.stop, stops + 1, 'the review session was stopped')
    assert.ok(existsSync(after.worktreePath) && hasBranch(ws.project.repoPath, after.branch))
  } finally {
    ctx.cleanup()
  }
})

test('#85 settings: defaults, clamps and the save path', async () => {
  const ctx = setup()
  try {
    const d = ctx.db.getSettings(1, 'default')
    assert.equal(d.buildStallWatchdog, true)
    assert.equal(d.buildStallWarnMs, 600000)
    assert.equal(d.buildStallHealMs, 1800000)
    await ctx.orch.saveSettings(ctx.run, { buildStallWatchdog: false, buildStallWarnMs: 1, buildStallHealMs: 99 * 60 * 60 * 1000 })
    const s = ctx.db.getSettings(1, 'default')
    assert.equal(s.buildStallWatchdog, false)
    assert.equal(s.buildStallWarnMs, 60000, 'soft threshold clamped to 1 minute')
    assert.equal(s.buildStallHealMs, 43200000, 'hard threshold clamped to 12 hours')
  } finally {
    ctx.cleanup()
  }
})

test('#85 plugin config seeds a new settings row', () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-stall-cfg-'))
  try {
    const db = createDatabase(join(root, 'data'), { buildStallWatchdog: false, buildStallWarnMs: 120000, buildStallHealMs: 900000 })
    const s = db.getSettings(7, 'default')
    assert.deepEqual([s.buildStallWatchdog, s.buildStallWarnMs, s.buildStallHealMs], [false, 120000, 900000])
    const again = db.getSettings(7, 'default')
    assert.deepEqual([again.buildStallWatchdog, again.buildStallWarnMs, again.buildStallHealMs], [false, 120000, 900000], 'stored, not only returned')
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#85 card hint: only for a running card the server marked suspicious', () => {
  assert.equal(stallHint({ phase: 'building' }), null, 'no stall view')
  assert.equal(stallHint({ phase: 'building', stall: { silentMs: 9 * MIN, suspicious: false } }), null, 'below the soft threshold')
  assert.equal(stallHint({ phase: 'todo', stall: { silentMs: 40 * MIN, suspicious: true } }), null, 'not running')
  const hint = stallHint({ phase: 'reviewing', stall: { silentMs: 23 * MIN + 59 * 1000, suspicious: true } })
  assert.equal(hint.text, '已静默 23 分钟')
  assert.equal(hint.minutes, 23)
  assert.match(hint.title, /运行没有被打断/)
})

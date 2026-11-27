// v0.9.70 (#91): the stall watchdog of #85 must not stop cards it cannot prove are stuck.
// Review of #85 (high risk): when the host as a whole is unreachable, every card is "probe unknown + no event";
// "one per pass" (6 s) returned them all within seconds, and cancelBuild swallowed a failed sessions.stop, so the
// old run could still be working in the worktree when the card was dispatched again (two executors, one tree).
// Fixed in src/server/orchestrator.mjs watchStalledRun: (a) a card goes back only after the host confirmed the
// stop (stopStalledSession: throw / ok:false / no answer in stallStopTimeoutMs = not confirmed -> the card stays,
// timeline 「宿主未确认已停止，保留运行状态」); a confirmation probe answering idle hands it to the normal settle;
// (b) at most one automatic stop per buildStallCooldownMs (default 5 min, lastAutoHealAt) over all cards;
// (c) sessions.stop is bounded by a timeout. And handleHostEvent no longer counts status heartbeats
// (STALL_HEARTBEAT_EVENTS: status.update, thinking.delta, transport.*) as activity.
// Mutations each of these tests must catch: drop the stop-confirmed condition; drop the cooldown; count
// heartbeats as activity again; await sessions.stop without the timeout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { effectiveStallThresholds } from '../src/client/stall-view.js'

const MIN = 60 * 1000

function setup({ stallStopTimeoutMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-stall-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const logs = []
  const log = { warn(msg) { logs.push(String(msg)) }, info() {}, error() {} }
  // Only the orchestrator's clock moves (hooks.now); Date.now stays real.
  const hooks = { now: 0 }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], clock: () => hooks.now || Date.now(), ...(stallStopTimeoutMs ? { stallStopTimeoutMs } : {}) })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, stop: 0, connect: 0 }
  // probeUnknown: sessions the host cannot tell about (live probe refused, detail missing).
  // onConnect(id, n): called on every live probe with its running count (lets a test act between the two probes).
  // stopMode: 'ok' | 'throw' | 'hang' | 'okfalse' | 'delay' (ok after 200 ms) (what sessions.stop does; #91).
  const flags = { probeUnknown: new Set(), onConnect: null, stopMode: 'ok' }
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
      async stop(id) {
        calls.stop += 1
        if (flags.stopMode === 'throw') throw new Error('host unavailable')
        if (flags.stopMode === 'hang') return new Promise(() => {})
        if (flags.stopMode === 'okfalse') return { ok: false, error: 'not stopped' }
        if (flags.stopMode === 'delay') await new Promise(resolve => setTimeout(resolve, 200))
        const s = sessions.get(id); if (s) s.is_running = false; return { ok: true }
      },
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


const KEPT = '宿主未确认已停止，保留运行状态'
const keptLines = (ctx, id) => timeline(ctx, id).filter(e => e.startsWith(KEPT))
const phases = (ctx, cards) => cards.map(c => get(ctx, c.id).phase)

async function threeCards(ctx, settings = {}) {
  const ws = await workspace(ctx, { maxConcurrentBuilds: 3, settings })
  const cards = []
  for (const title of ['A', 'B', 'C']) cards.push(await buildingCard(ctx, ws, title))
  return { ws, cards }
}

// Passes every 6 s (the reconcile interval) from `fromMs` to `toMs`.
async function passEvery6s(ctx, t0, fromMs, toMs) {
  for (let t = fromMs; t <= toMs; t += 6000) await passAt(ctx, t0, t)
}

for (const mode of ['throw', 'okfalse']) {
  test(`#91 control: host-wide outage (every probe unknown, sessions.stop ${mode}) for 5+ minutes returns zero cards`, async () => {
    const ctx = setup()
    try {
      const { cards } = await threeCards(ctx, { buildStallWarnMs: 1 * MIN })
      for (const c of cards) ctx.flags.probeUnknown.add(c.buildSessionId)
      ctx.flags.stopMode = mode
      const t0 = Date.now()
      await passAt(ctx, t0, 0)
      await passAt(ctx, t0, 2 * MIN)
      // Around and after the 3-minute unknown threshold, every 6 s like the real reconcile loop.
      await passEvery6s(ctx, t0, 3 * MIN, 4 * MIN)
      await passAt(ctx, t0, 5 * MIN + 30 * 1000)
      assert.deepEqual(phases(ctx, cards), ['building', 'building', 'building'], 'no card goes back while the host cannot confirm the stop')
      for (const c of cards) {
        assert.equal(softLines(ctx, c.id).length, 1, 'only the soft mark')
        assert.equal(keptLines(ctx, c.id).length, 1, 'one "kept" line per card, not one per pass')
        assert.equal(get(ctx, c.id).lastError || '', '', 'nothing written as a stop')
        assert.ok(existsSync(c.worktreePath))
      }
      assert.ok(ctx.calls.stop >= 3, 'the stop was asked for')
      assert.ok(ctx.calls.stop <= 6, `the stop is not asked again on every pass (asked ${ctx.calls.stop} times)`)
    } finally {
      ctx.cleanup()
    }
  })
}

test('#91 sessions.stop that never answers: the card stays building (timeout, then "kept" line)', { timeout: 15000 }, async () => {
  const ctx = setup({ stallStopTimeoutMs: 300 })
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    ctx.flags.probeUnknown.add(card.buildSessionId)
    ctx.flags.stopMode = 'hang'
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    const started = realNow()
    await passAt(ctx, t0, 3 * MIN + 1000)
    assert.ok(realNow() - started < 5000, 'the pass returned after the stop timeout')
    const after = get(ctx, card.id)
    assert.equal(after.phase, 'building')
    assert.equal(keptLines(ctx, card.id).length, 1)
    assert.match(keptLines(ctx, card.id)[0], /秒内没有答复/)
    assert.equal(after.lastError || '', '')
  } finally {
    ctx.cleanup()
  }
})

test('#91 silence path too: a hung run past the hard threshold is not returned when the stop throws', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    ctx.flags.stopMode = 'throw'
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 11 * MIN)
    await passAt(ctx, t0, 31 * MIN)
    assert.equal(get(ctx, card.id).phase, 'building')
    assert.equal(keptLines(ctx, card.id).length, 1)
    assert.match(keptLines(ctx, card.id)[0], /已 31 分钟无事件/)
  } finally {
    ctx.cleanup()
  }
})

test('#91 outage then recovery: the stop works again -> one card per cooldown window, never two at once', async () => {
  const ctx = setup()
  try {
    const { cards } = await threeCards(ctx)
    for (const c of cards) ctx.flags.probeUnknown.add(c.buildSessionId)
    ctx.flags.stopMode = 'throw'
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    await passEvery6s(ctx, t0, 3 * MIN, 3 * MIN + 30 * 1000)
    await passAt(ctx, t0, 5 * MIN)
    assert.deepEqual(phases(ctx, cards), ['building', 'building', 'building'])
    // The host is back: stop confirms (the probe still cannot tell). Retries wait for the cooldown of the
    // failed stop (5 min after it), then one card per pass and one per cooldown window.
    ctx.flags.stopMode = 'ok'
    const back = () => phases(ctx, cards).filter(p => p === 'todo').length
    await passAt(ctx, t0, 7 * MIN)
    assert.equal(back(), 0, 'not retried before the retry time of the failed stop')
    await passAt(ctx, t0, 8 * MIN + 30 * 1000)
    assert.equal(back(), 1, 'one card once the stop is confirmed')
    await passEvery6s(ctx, t0, 8 * MIN + 36 * 1000, 9 * MIN + 30 * 1000)
    assert.equal(back(), 1, 'no second card inside the cooldown, even over many 6 s passes')
    await passAt(ctx, t0, 13 * MIN + 31 * 1000)
    assert.equal(back(), 2, 'the next one after the cooldown')
    const returned = cards.filter(c => get(ctx, c.id).phase === 'todo')
    for (const c of returned) {
      assert.match(get(ctx, c.id).lastError, /^疑似卡住（宿主连续 \d+ 分钟答不出会话状态/)
      assert.equal(get(ctx, c.id).worktreePath, c.worktreePath, 'worktree kept on the card')
      assert.ok(existsSync(c.worktreePath))
    }
  } finally {
    ctx.cleanup()
  }
})

test('#91 outage then recovery: the probe answers "not running" -> the normal settle takes it, the watchdog stops nothing', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    writeFileSync(join(card.worktreePath, 'a.txt'), 'work\n')
    git(card.worktreePath, 'commit', '-am', 'work')
    ctx.flags.probeUnknown.add(card.buildSessionId)
    ctx.flags.stopMode = 'throw'
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    await passEvery6s(ctx, t0, 3 * MIN, 3 * MIN + 30 * 1000)
    assert.equal(get(ctx, card.id).phase, 'building')
    const stops = ctx.calls.stop
    // The host recovers and its probe says the run is over.
    ctx.flags.probeUnknown.delete(card.buildSessionId)
    ctx.flags.stopMode = 'ok'
    const s = ctx.sessions.get(card.buildSessionId)
    s.is_running = false
    s.messages.push({ id: 'a-1', role: 'assistant', content: '完成：改了 a.txt 并提交。', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    await passAt(ctx, t0, 4 * MIN)
    assert.ok(await reaches(() => get(ctx, card.id).phase === 'review'), 'settled to review like any finished run')
    assert.equal(ctx.calls.stop, stops, 'the watchdog did not stop it')
    assert.doesNotMatch(get(ctx, card.id).lastError || '', /疑似卡住/)
  } finally {
    ctx.cleanup()
  }
})

test('#91 a status heartbeat every 15 minutes does not keep a hung run alive: stopped at the hard threshold', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    const t0 = Date.now()
    const beats = ['chat.status.update', 'status.update', 'chat.thinking.delta', 'transport.connected']
    let beat = 0
    for (let m = 0; m <= 60; m += 1) {
      if (m % 15 === 0) {
        ctx.hooks.now = t0 + m * MIN
        await hostEvent(ctx, card.buildSessionId, beats[beat++ % beats.length], { kind: 'retry', text: 'retrying' })
      }
      await passAt(ctx, t0, m * MIN + 20 * 1000)
      if (get(ctx, card.id).phase !== 'building') break
    }
    const after = get(ctx, card.id)
    assert.equal(after.phase, 'todo', 'heartbeats are not activity')
    assert.match(after.lastError, /^疑似卡住（已 3[01] 分钟无事件）/)
  } finally {
    ctx.cleanup()
  }
})

test('#91 counter-check: a reasoning delta every 15 minutes is progress: never stopped in 60 minutes', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const card = await buildingCard(ctx, ws)
    const t0 = Date.now()
    const deltas = ['chat.reasoning.delta', 'reasoning.delta', 'chat.message.delta', 'message.interim']
    let k = 0
    for (let m = 0; m <= 60; m += 1) {
      if (m % 15 === 0) {
        ctx.hooks.now = t0 + m * MIN
        await hostEvent(ctx, card.buildSessionId, deltas[k++ % deltas.length], { delta: '…' })
      }
      await passAt(ctx, t0, m * MIN + 20 * 1000)
    }
    assert.equal(get(ctx, card.id).phase, 'building')
    assert.equal(ctx.calls.stop, 0)
  } finally {
    ctx.cleanup()
  }
})

test('#91 settings: cooldown default, clamps, save path and config seed', async () => {
  const ctx = setup()
  try {
    assert.equal(ctx.db.getSettings(1, 'default').buildStallCooldownMs, 300000)
    await ctx.orch.saveSettings(ctx.run, { buildStallCooldownMs: 1 })
    assert.equal(ctx.db.getSettings(1, 'default').buildStallCooldownMs, 60000, 'clamped to 1 minute')
    await ctx.orch.saveSettings(ctx.run, { buildStallCooldownMs: 99 * 60 * 60 * 1000 })
    assert.equal(ctx.db.getSettings(1, 'default').buildStallCooldownMs, 3600000, 'clamped to 1 hour')
    await ctx.orch.saveSettings(ctx.run, { buildStallWarnMs: 120000 })
    assert.equal(ctx.db.getSettings(1, 'default').buildStallCooldownMs, 3600000, 'kept when another field is saved')
  } finally {
    ctx.cleanup()
  }
  const root = mkdtempSync(join(tmpdir(), 'ekko-stall-cd-'))
  try {
    const db = createDatabase(join(root, 'data'), { buildStallCooldownMs: 120000 })
    assert.equal(db.getSettings(7, 'default').buildStallCooldownMs, 120000)
    assert.equal(db.getSettings(7, 'default').buildStallCooldownMs, 120000, 'stored, not only returned')
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#91 configured cooldown is the one applied (2 minutes: the second card goes back after 2, not 5)', async () => {
  const ctx = setup()
  try {
    const { cards } = await threeCards(ctx, { buildStallCooldownMs: 2 * MIN })
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    await passAt(ctx, t0, 31 * MIN)
    const back = () => phases(ctx, cards).filter(p => p === 'todo').length
    assert.equal(back(), 1)
    await passAt(ctx, t0, 32 * MIN)
    assert.equal(back(), 1)
    await passAt(ctx, t0, 33 * MIN + 1000)
    assert.equal(back(), 2)
  } finally {
    ctx.cleanup()
  }
})

test('#91 settings panel text: thresholds in effect, and the note when the hard one was raised', () => {
  const d = effectiveStallThresholds({})
  assert.deepEqual([d.warnMin, d.healMin, d.cooldownMin, d.raised], [10, 30, 5, false])
  assert.equal(d.text, '实际生效：提示 10 分钟 / 退回 30 分钟')
  const raised = effectiveStallThresholds({ buildStallWarnMs: 60 * MIN, buildStallHealMs: 30 * MIN })
  assert.deepEqual([raised.warnMin, raised.healMin, raised.raised], [60, 61, true])
  assert.match(raised.text, /^实际生效：提示 60 分钟 \/ 退回 61 分钟（已按下限调整/)
  const clamped = effectiveStallThresholds({ buildStallWarnMs: 1, buildStallHealMs: 1 })
  assert.deepEqual([clamped.warnMin, clamped.healMin, clamped.raised], [1, 5, false], 'clamps like the server')
})

test('#91 review: two overlapping reconcile passes return one card, not two (autoHealInFlight)', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const cards = [await buildingCard(ctx, ws, 'X'), await buildingCard(ctx, ws, 'Y')]
    const t0 = Date.now()
    await passAt(ctx, t0, 0)
    // Both cards are past the hard threshold; the stop answers ok after 200 ms, so the first pass is still
    // waiting for it when the second one looks at the cooldown.
    ctx.flags.stopMode = 'delay'
    ctx.hooks.now = t0 + 31 * MIN
    await Promise.all([ctx.orch.reconcileActiveRuns(ctx.run), ctx.orch.reconcileActiveRuns(ctx.run)])
    const ph = phases(ctx, cards)
    assert.equal(ph.filter(p => p === 'todo').length, 1, `one card back, got ${ph.join(',')}`)
    assert.equal(ph.filter(p => p === 'building').length, 1, 'the other one keeps running')
    assert.equal(ctx.calls.stop, 1, 'one stop over both passes')
    const back = cards.find(c => get(ctx, c.id).phase === 'todo')
    assert.equal(timeline(ctx, back.id).filter(e => e.startsWith('疑似卡住')).length, 1, 'written once')
    // The flag is released: after the cooldown the next pass may take the other card.
    await passAt(ctx, t0, 36 * MIN + 1000)
    assert.deepEqual(phases(ctx, cards).sort(), ['todo', 'todo'])
  } finally {
    ctx.cleanup()
  }
})

test('#91 review: during an outage at most one stop is attempted per pass (3 cards, 5 minutes)', async () => {
  const ctx = setup()
  try {
    const { cards } = await threeCards(ctx)
    for (const c of cards) ctx.flags.probeUnknown.add(c.buildSessionId)
    ctx.flags.stopMode = 'throw'
    const t0 = Date.now()
    let passes = 0
    const perPass = []
    for (let t = 0; t <= 5 * MIN; t += 6000) {
      const before = ctx.calls.stop
      await passAt(ctx, t0, t)
      passes += 1
      perPass.push(ctx.calls.stop - before)
    }
    assert.ok(Math.max(...perPass) <= 1, `at most one stop per pass, got ${JSON.stringify(perPass.filter(n => n))}`)
    assert.ok(ctx.calls.stop <= passes, 'not more stops than passes')
    assert.ok(ctx.calls.stop * 10 < 3 * passes, `far below 3 x passes (${ctx.calls.stop} stops in ${passes} passes)`)
    assert.ok(ctx.calls.stop >= 1, 'the stop was tried')
    assert.deepEqual(phases(ctx, cards), ['building', 'building', 'building'])
  } finally {
    ctx.cleanup()
  }
})

test('#91 review: overlapping passes of two profiles share the cooldown (different cards, still one back)', async () => {
  const ctx = setup()
  try {
    const ws = await workspace(ctx)
    const x = await buildingCard(ctx, ws, 'X')
    // A second profile of the same user: reconcileActiveRuns runs per profile, the cooldown is global.
    const run2 = { ...ctx.run, identity: { userId: 1, profile: 'p2' } }
    ctx.db.getSettings(1, 'p2')
    ctx.db.updateSettings(1, 'p2', { quotaAutoRefreshMin: 0, maxConcurrentBuilds: 2 })
    await ctx.orch.saveAgent(run2, { name: '看门狗测试 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: CONFIGS })
    const agent2 = ctx.db.listAgents(1, 'p2').find(a => a.name === '看门狗测试 Agent')
    const repo2 = join(ctx.root, 'p2'); mkdirSync(repo2)
    const { project } = await ctx.orch.addProject(run2, { name: 'P2', repoPath: makeRepo(repo2), testCommand: 'true' })
    const { topic } = await ctx.orch.createTopic(run2, { projectId: project.id, autopilot: false })
    const { todo } = await ctx.orch.createTodo(run2, { projectId: project.id, topicId: topic.id, title: 'Y', agentId: agent2.id })
    const y = await ctx.orch.startBuild(run2, { todoId: todo.id, withPlan: false })
    assert.equal(y.phase, 'building')
    const phaseY = () => ctx.db.getTodo(1, 'p2', y.id).phase
    const t0 = Date.now()
    ctx.hooks.now = t0
    await ctx.orch.reconcileActiveRuns(ctx.run)
    await ctx.orch.reconcileActiveRuns(run2)
    ctx.flags.stopMode = 'delay'
    ctx.hooks.now = t0 + 31 * MIN
    await Promise.all([ctx.orch.reconcileActiveRuns(ctx.run), ctx.orch.reconcileActiveRuns(run2)])
    const ph = [get(ctx, x.id).phase, phaseY()]
    assert.equal(ph.filter(p => p === 'todo').length, 1, `one card back over both passes, got ${ph.join(',')}`)
    assert.equal(ph.filter(p => p === 'building').length, 1)
    assert.equal(ctx.calls.stop, 1)
  } finally {
    ctx.cleanup()
  }
})

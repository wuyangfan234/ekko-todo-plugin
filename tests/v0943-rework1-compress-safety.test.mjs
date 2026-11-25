// v0.9.43 rework 1 (Todo #29 review): detach must not report a failure or release the lock, /clear copy matches
// what the host does, the capsule uses the host's own context number and threshold, the auto-compression timer
// is stable and cannot stick, /compress passthrough stops the run, and only the lock holder releases the lock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { validateModel } from '../sdk/harness/contracts.mjs'
import * as cmds from '../src/client/chief-commands.js'

const root = new URL('../', import.meta.url).pathname
const read = rel => readFileSync(join(root, rel), 'utf8')
const contract = JSON.parse(read('contracts/plugin.json'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const tick = () => sleep(0)

function fakeHandle() {
  const sent = []
  return { sent, async run(text) { sent.push(text) } }
}

function setupServer({ configAnswer = { compression: { enabled: true, threshold: 0.65 } } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-rework1-'))
  const dataDir = join(dir, 'data')
  const db = createDatabase(dataDir, {})
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {}, error() {} }, settleDelaysMs: [0, 0, 0, 0] })
  const requests = []
  const host = {
    agents: { async list() { return { agents: [] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } } },
    async request(path, opts) {
      requests.push({ path, query: opts?.query })
      if (path === '/api/studio/sessions/context-length') return { context_length: 256000 }
      if (path === '/api/hermes/config') {
        if (configAnswer instanceof Error) throw configAnswer
        return configAnswer
      }
      return null
    },
    sessions: {
      async run() { return { run_id: 'r1' } },
      async stop() { return { ok: true } },
      async get(id) { return { session: { id, source: 'cli', model: 'm', provider: 'p' } } },
      async messages() { return { messages: [], total: 0 } },
      async connect(id, cb) { const t = setTimeout(() => cb({ event: 'resumed', isWorking: false }), 0); return { close() { clearTimeout(t) } } },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const topic = db.createTopic(1, 'default', {})
  db.updateTopic(1, 'default', topic.id, { chiefSessionId: 'sess-chief' })
  const lockOf = async () => (await orch.getSnapshot(run)).topics.find(t => t.id === topic.id).compressingSince
  const systemTexts = () => db.getTopic(1, 'default', topic.id).messages.filter(m => m.kind === 'system').map(m => m.text)
  const cleanup = () => { try { db.close() } catch {} rmSync(dir, { recursive: true, force: true }) }
  return { db, orch, run, topic, requests, lockOf, systemTexts, cleanup }
}

// ---- 必改 1: detach ------------------------------------------------------------------------------------

test('rework1: leaving the topic mid-compression keeps the server lock and writes no failure', async () => {
  const s = setupServer()
  try {
    const runner = cmds.createCommandRunner()
    const h = fakeHandle()
    runner.attach('sess-chief', h)
    const records = []
    const flow = cmds.runManualCompress({
      runner,
      topicId: s.topic.id,
      beginLock: input => s.orch.beginTopicCompress(s.run, input),
      record: async payload => { records.push(payload); return s.orch.recordTopicCommand(s.run, payload) },
      stopRun: () => {},
    })
    await tick()
    runner.handleEvent({ event: 'session.command', session_id: 'sess-chief', action: 'context', ok: true, totalTokens: 174273 })
    for (let i = 0; i < 50 && h.sent.length < 2; i += 1) await sleep(5)
    assert.deepEqual(h.sent, ['/context', '/compress'])
    assert.ok(await s.lockOf(), 'lock taken')
    // App's connect effect cleanup (topic switch) detaches; then the new topic's session attaches.
    runner.detach('sess-chief')
    runner.attach('sess-other', fakeHandle())
    const result = await flow
    assert.equal(result.outcome, 'detached')
    assert.equal(result.detached, true)
    assert.equal(records.length, 0, 'record-topic-command is not called after a detach')
    assert.ok(await s.lockOf(), 'the server lock stays until it expires (135 s) — the host may still be compressing')
    assert.equal(s.systemTexts().some(t => /失败|未变/.test(t)), false)
    const text = cmds.compressResultText(result)
    assert.equal(text, '实时通道已断开，压缩结果未知')
    assert.doesNotMatch(text, /失败|未变/)
  } finally { s.cleanup() }
})

test('rework1: the same session reconnecting keeps the pending command and settles on the host answer', async () => {
  const runner = cmds.createCommandRunner()
  runner.attach('s1', fakeHandle())
  const p = runner.run('/compress', { action: 'compress' })
  await tick()
  runner.detach('s1')
  assert.equal(runner.busy, true, 'pending survives a detach')
  runner.attach('s1', fakeHandle())
  runner.handleEvent({ event: 'session.command', session_id: 's1', action: 'compress', ok: true, compressed: true, beforeTokens: 174273, afterTokens: 8191 })
  const r = await p
  assert.equal(r.ok, true)
  assert.equal(r.afterTokens, 8191)

  // Detached when the timer fires: still "unknown", never "timeout" (the self-check could not run).
  let fire = null
  const timed = cmds.createCommandRunner({ setTimer: fn => { fire = fn; return 1 }, clearTimer: () => {} })
  timed.attach('s1', fakeHandle())
  const p2 = timed.run('/compress', { action: 'compress', timeoutMs: 120000 })
  timed.detach('s1')
  fire()
  const r2 = await p2
  assert.equal(r2.outcome, 'detached')
  // A detach for another session does nothing.
  const other = cmds.createCommandRunner()
  other.attach('s1', fakeHandle())
  const p3 = other.run('/status', { action: 'status' })
  other.detach('s2')
  other.handleEvent({ event: 'session.command', session_id: 's1', action: 'status', ok: true })
  assert.equal((await p3).ok, true)
})

test('rework1: a detach during the /context probe records nothing and takes no lock', async () => {
  const runner = cmds.createCommandRunner()
  runner.attach('s1', fakeHandle())
  const calls = []
  const flow = cmds.runManualCompress({ runner, topicId: 't1', beginLock: async () => calls.push('begin'), record: async p => calls.push(p) })
  await tick()
  runner.detach('s1')
  runner.attach('s2', fakeHandle())
  const r = await flow
  assert.equal(r.outcome, 'detached')
  assert.deepEqual(calls, [])
})

// ---- 必改 2: /clear --------------------------------------------------------------------------------------

test('rework1: /clear copy says what the host does by default (display cleared, history kept)', () => {
  const meta = cmds.SLASH_COMMANDS.find(c => c.name === 'clear')
  assert.equal(meta.label, '清空当前显示（宿主历史保留）')
  const copy = cmds.COMMAND_CONFIRM_COPY.clear
  assert.ok(copy, 'confirm copy lives next to the command table')
  const body = copy.body.join('')
  assert.match(body, /只清空宿主当前显示的对话/)
  assert.match(body, /数据库历史保留，大总管仍记得之前的对话/)
  assert.match(body, /插件的聊天记录和任务卡片保留不动/)
  assert.doesNotMatch(body + meta.label, /删除|不再记得/)
  // The text that is sent is exactly `/clear` (host: "History in the database was not deleted.").
  const parsed = cmds.parseSlashCommand('/clear')
  assert.equal(parsed.text, '/clear')
  const ready = { channel: 'ready', connected: true, hasSession: true }
  assert.equal(cmds.commandGate(parsed, ready).ok, true)
  // Deleting the host history is not offered, typed or not.
  const gate = cmds.commandGate(cmds.parseSlashCommand('/clear --history'), ready)
  assert.equal(gate.ok, false)
  assert.match(gate.reason, /不删除宿主历史/)
  // The dialog renders this copy (no second copy in the JSX).
  const ui = read('src/client/components/ChiefCommandUi.jsx')
  assert.match(ui, /COMMAND_CONFIRM_COPY/)
  assert.doesNotMatch(ui, /宿主会删除大总管会话里的全部历史/)
})

// ---- 建议 1: capsule uses the host's context number and threshold ----------------------------------------

test('rework1: the capsule follows the host context tokens only, and warns against the host threshold', () => {
  assert.equal(cmds.contextTokensOf({ event: 'session.command', action: 'context', totalTokens: 776852 }), undefined, '/context is not the auto-compress number')
  assert.equal(cmds.contextTokensOf({ event: 'session.command', action: 'compress', ok: true, afterTokens: 8191 }), undefined)
  assert.equal(cmds.contextTokensOf({ event: 'compression.completed', compressed: true, afterTokens: 5000, contextTokens: 8191 }), 8191)
  assert.equal(cmds.contextTokensOf({ event: 'compression.completed', compressed: true, afterTokens: 5000 }), undefined, 'afterTokens is message-only')
  assert.equal(cmds.contextTokensOf({ event: 'compression.completed', compressed: false, failed: true, contextTokens: 0 }), undefined)
  assert.equal(cmds.contextTokensOf({ event: 'usage.updated', contextTokens: 528022 }), 528022)
  // threshold 0.65 of 1000000 -> trigger 650000; warn from 90 % of the trigger (585000).
  const ok = cmds.contextCapsule({ tokens: 528022, window: 1000000, threshold: 0.65 })
  assert.equal(ok.level, 'ok')
  assert.equal(ok.triggerTokens, 650000)
  assert.equal(cmds.contextCapsule({ tokens: 585000, window: 1000000, threshold: 0.65 }).level, 'warn')
  assert.equal(cmds.contextCapsule({ tokens: 584999, window: 1000000, threshold: 0.65 }).level, 'ok')
  assert.equal(cmds.contextCapsule({ tokens: 150000, window: 256000 }).level, 'warn', 'no threshold -> 0.65 fallback (166400 trigger)')
  // The Ekko-agent /context answer names its total contextTokens: still the probe baseline.
  assert.equal(cmds.readCommandOutcome({ event: 'session.command', action: 'context', ok: true, contextTokens: 9000 }).totalTokens, 9000)
  const hook = read('src/client/use-chief-context.js')
  assert.doesNotMatch(hook, /tokens:\s*probe\.totalTokens|tokens:\s*result\.afterTokens/, 'probe and /compress answers do not overwrite the capsule')
})

test('rework1: get-topic-context reads the host compression threshold (section only), with fallbacks', async () => {
  const s = setupServer()
  try {
    const out = await s.orch.getTopicContext(s.run, { topicId: s.topic.id })
    validateModel(contract, 'topicContextOutput', out)
    assert.equal(out.compressionThreshold, 0.65)
    assert.equal(out.thresholdSource, 'host')
    const cfg = s.requests.find(r => r.path === '/api/hermes/config')
    assert.deepEqual(cfg.query, { section: 'compression' }, 'only the compression section is read')
  } finally { s.cleanup() }
  const s2 = setupServer({ configAnswer: { compression: {} } })
  try {
    const out = await s2.orch.getTopicContext(s2.run, { topicId: s2.topic.id })
    assert.equal(out.compressionThreshold, 0.5, 'host default when the key is missing')
    assert.equal(out.thresholdSource, 'host')
  } finally { s2.cleanup() }
  const s3 = setupServer({ configAnswer: new Error('403') })
  try {
    const out = await s3.orch.getTopicContext(s3.run, { topicId: s3.topic.id })
    validateModel(contract, 'topicContextOutput', out)
    assert.equal(out.compressionThreshold, 0.65)
    assert.equal(out.thresholdSource, 'fallback')
  } finally { s3.cleanup() }
})

// ---- 建议 2: automatic compression phase ------------------------------------------------------------------

test('rework1: an automatic compression has a stable start time, is cleared by resumed, and cannot stick', () => {
  const base = { tokens: 0, window: 0, phase: 'idle', startedAt: 0 }
  const a = cmds.reduceContextEvent(base, { event: 'compression.started', source: 'bridge' }, { manualBusy: false, now: 1000 })
  assert.equal(a.phase, 'compressing')
  assert.equal(a.startedAt, 1000)
  const b = cmds.reduceContextEvent(a, { event: 'compression.started' }, { manualBusy: false, now: 5000 })
  assert.equal(b.startedAt, 1000, 'a second started keeps the first time')
  const c = cmds.reduceContextEvent(b, { event: 'resumed', isWorking: true, contextTokens: 9000 }, { manualBusy: false, now: 6000 })
  assert.equal(c.phase, 'idle', 'resumed after a missed completion clears the automatic phase')
  assert.equal(c.startedAt, 0)
  assert.equal(c.tokens, 9000)
  const m = cmds.reduceContextEvent({ ...base, phase: 'compressing', startedAt: 1000 }, { event: 'resumed' }, { manualBusy: true, now: 6000 })
  assert.equal(m.phase, 'compressing', 'a manual compression of this page is kept across a reconnect')
  const done = cmds.reduceContextEvent(a, { event: 'compression.completed', compressed: true, contextTokens: 8191 }, { manualBusy: false, now: 3000 })
  assert.equal(done.phase, 'idle')
  assert.equal(done.tokens, 8191)
  assert.equal(cmds.expireAutoCompress(a, { manualBusy: false, now: 1000 + cmds.COMPRESS_TIMEOUT_MS + 1 }).phase, 'idle')
  assert.equal(cmds.expireAutoCompress(a, { manualBusy: false, now: 1000 + cmds.COMPRESS_TIMEOUT_MS - 1 }).phase, 'compressing')
  assert.equal(cmds.expireAutoCompress(a, { manualBusy: true, now: 1000 + cmds.COMPRESS_TIMEOUT_MS + 1 }).phase, 'compressing')
  const ui = read('src/client/components/ChiefCommandUi.jsx')
  assert.doesNotMatch(ui, /compressStartedAt \|\| Date\.now\(\)/, 'no fresh Date.now() per render (the "0s" bug)')
  assert.match(read('src/client/use-chief-context.js'), /reduceContextEvent\(/)
  assert.match(read('src/client/use-chief-context.js'), /expireAutoCompress\(/)
})

// ---- 建议 3: /compress passthrough ------------------------------------------------------------------------

test('rework1: a /compress the host hands to the model is stopped and disables the button', async () => {
  const answers = [
    { ok: true, outcome: 'completed', action: 'context', totalTokens: 1000 },
    { ok: false, outcome: 'unsupported', passthrough: true, message: '宿主把命令当成普通消息交给了模型（命令通道被拦截）' },
  ]
  const runner = { sent: [], async run(text) { this.sent.push(text); return answers.shift() } }
  const calls = []
  const r = await cmds.runManualCompress({
    runner,
    topicId: 't1',
    beginLock: async () => ({ ok: true, lockId: 'L1' }),
    record: async p => calls.push(['record', p]),
    stopRun: () => calls.push(['stop']),
  })
  assert.deepEqual(calls.map(c => c[0]), ['stop', 'record'])
  assert.equal(calls[1][1].outcome, 'unsupported')
  assert.equal(r.outcome, 'unsupported')
  const hook = read('src/client/use-chief-context.js')
  assert.match(hook, /result\.outcome === 'unsupported'/)
  assert.doesNotMatch(hook, /result\.probeFailed && result\.outcome === 'unsupported'/)
})

// ---- 建议 4: lock ownership -------------------------------------------------------------------------------

test('rework1: only the lock holder releases the compression lock', async () => {
  const s = setupServer()
  try {
    const lock = await s.orch.beginTopicCompress(s.run, { topicId: s.topic.id })
    validateModel(contract, 'beginTopicCompressOutput', lock)
    assert.equal(typeof lock.lockId, 'string')
    assert.ok(lock.lockId.length >= 8)
    // A stale tab's probe failure (no lockId) and a late record of an older lock both leave it in place.
    await s.orch.recordTopicCommand(s.run, { topicId: s.topic.id, command: 'compress', ok: false, outcome: 'unsupported', message: 'x' })
    assert.ok(await s.lockOf(), 'record without lockId does not release')
    const wrong = { topicId: s.topic.id, command: 'compress', ok: false, outcome: 'failed', lockId: 'not-the-lock' }
    validateModel(contract, 'recordTopicCommandInput', wrong)
    await s.orch.recordTopicCommand(s.run, wrong)
    assert.ok(await s.lockOf(), 'record with another lockId does not release')
    await s.orch.recordTopicCommand(s.run, { topicId: s.topic.id, command: 'compress', ok: true, lockId: lock.lockId, beforeTokens: 10, afterTokens: 5 })
    assert.equal(await s.lockOf(), undefined, 'the holder releases')
  } finally { s.cleanup() }
  // The page passes the lockId it got; the probe-failure record carries none.
  const answers = [{ ok: true, totalTokens: 10 }, { ok: true, action: 'compress', beforeTokens: 10, afterTokens: 5 }]
  const recs = []
  await cmds.runManualCompress({ runner: { async run() { return answers.shift() } }, topicId: 't1', beginLock: async () => ({ ok: true, lockId: 'L9' }), record: async p => recs.push(p) })
  assert.equal(recs[0].lockId, 'L9')
  const recs2 = []
  await cmds.runManualCompress({ runner: { async run() { return { ok: false, outcome: 'timeout' } } }, topicId: 't1', beginLock: async () => ({ lockId: 'L0' }), record: async p => recs2.push(p) })
  assert.equal(recs2[0].lockId, undefined)
})

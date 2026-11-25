// v0.9.43 (Todo #29): Chief context capsule, manual /compress through the host's own command channel, and the
// slash-command panel that lives next to the 0.9.41 @ picker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { validateModel } from '../sdk/harness/contracts.mjs'
import { findMentionTrigger, mentionEnterAction } from '../src/client/mention.js'
import {
  applySlashCommand,
  CLOSED_COMMANDS,
  commandGate,
  compressGate,
  compressResultText,
  contextCapsule,
  contextTokensOf,
  createCommandRunner,
  emptySlashHint,
  filterSlashCommands,
  findSlashTrigger,
  formatTokenCount,
  HOST_COMMANDS,
  parseSlashCommand,
  runManualCompress,
  SLASH_COMMANDS,
  slashEnterAction,
} from '../src/client/chief-commands.js'

const root = new URL('../', import.meta.url).pathname
const read = rel => readFileSync(join(root, rel), 'utf8')
const contract = JSON.parse(read('contracts/plugin.json'))
const pkg = JSON.parse(read('package.json'))
const chatPaneSrc = read('src/client/components/ChatPane.jsx')
const appSrc = read('src/client/App.jsx')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- slash command parsing (same pattern as the host) --------------------------------------------------

test('v0.9.43: slash commands are parsed the way the host parses them', () => {
  const table = [
    ['/compress', { rawName: 'compress', action: 'compress', args: '', open: true }],
    ['/compact', { rawName: 'compact', action: 'compress', args: '', open: true }],
    ['  /status  ', { rawName: 'status', action: 'status', args: '', open: true }],
    ['/Title 新标题', { rawName: 'title', action: 'title', args: '新标题', open: true }],
    ['/steer：先合并 #12', { rawName: 'steer', action: 'steer', args: '先合并 #12', open: true }],
    ['/context看看', { rawName: 'context', action: 'context', args: '看看', open: true }],
    ['／usage', { rawName: 'usage', action: 'usage', args: '', open: true }],
    ['/plan 写个方案', { rawName: 'plan', action: 'plan', args: '写个方案', open: false }],
    ['/fork', { rawName: 'fork', action: 'branch', args: '', open: false }],
  ]
  for (const [text, want] of table) {
    const got = parseSlashCommand(text)
    assert.ok(got, text)
    for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${text} ${k}`)
  }
  // Not host commands: stay normal chat messages.
  for (const text of ['/tmp/a.log 看一下', '/unknowncmd', 'status', '请 /compress', '/ compress', '/123']) {
    assert.equal(parseSlashCommand(text), null, text)
  }
  // Every migrated or closed name is a real host command.
  for (const c of SLASH_COMMANDS) assert.ok(HOST_COMMANDS[c.name], c.name)
  for (const c of CLOSED_COMMANDS) assert.ok(HOST_COMMANDS[c], c)
  assert.deepEqual(SLASH_COMMANDS.map(c => c.name), ['status', 'context', 'usage', 'compress', 'compact', 'clear', 'title', 'abort', 'queue', 'steer'])
})

test('v0.9.43: the panel opens only while the text up to the caret is a "/" token', () => {
  assert.deepEqual(findSlashTrigger('/', 1), { start: 0, query: '' })
  assert.deepEqual(findSlashTrigger('/co', 3), { start: 0, query: 'co' })
  assert.deepEqual(findSlashTrigger('／st', 3), { start: 0, query: 'st' })
  assert.deepEqual(findSlashTrigger('  /st', 5), { start: 2, query: 'st' })
  assert.equal(findSlashTrigger('/co ', 4), null)
  assert.equal(findSlashTrigger('hi /co', 6), null)
  assert.equal(findSlashTrigger('/title 新', 8), null)
  assert.equal(findSlashTrigger('@平台', 3), null)
  assert.deepEqual(filterSlashCommands('co').map(c => c.name), ['context', 'compress', 'compact'])
  assert.equal(filterSlashCommands('').length, SLASH_COMMANDS.length)
  assert.equal(filterSlashCommands('plan').length, 0)
  assert.match(emptySlashHint('plan'), /Hermes Agent 专有命令/)
  assert.match(emptySlashHint('zz'), /没有以「\/zz」开头的命令/)
  assert.deepEqual(applySlashCommand('/co', 0, 3, { name: 'compress' }), { text: '/compress', cursor: 9 })
  assert.deepEqual(applySlashCommand('/ti', 0, 3, { name: 'title', args: '新标题' }), { text: '/title ', cursor: 7 })
})

test('v0.9.43: "/" and "@" never open together and Enter never sends a draft from an empty panel', () => {
  // The composer opens the slash panel first and closes the @ picker; @ keeps working everywhere else.
  for (const [text, slash, mention] of [
    ['/st', true, false],
    ['@平', false, true],
    ['/@', false, true],
    ['hello /co', false, false],
    ['看 @审查', false, true],
  ]) {
    assert.equal(Boolean(findSlashTrigger(text, text.length)), slash, `${text} slash`)
    assert.equal(Boolean(findMentionTrigger(text, text.length)), mention, `${text} mention`)
  }
  const table = [
    // open, count, query, shift, expected
    [true, 0, 'zz', false, 'swallow'],
    [true, 0, 'plan', true, 'swallow'],
    [true, 3, 'co', false, 'insert'],
    [true, 1, 'status', false, 'send'],
    [true, 1, 'title', false, 'insert'],
    [false, 0, '', false, 'send'],
    [false, 0, '', true, 'newline'],
  ]
  for (const [open, count, query, shiftKey, want] of table) {
    assert.equal(slashEnterAction({ open, count, query, shiftKey }), want, JSON.stringify({ open, count, query, shiftKey }))
  }
  // The @ picker rules of 0.9.41 are unchanged.
  assert.equal(mentionEnterAction({ open: true, count: 0 }), 'swallow')
  assert.equal(mentionEnterAction({ open: true, count: 2 }), 'insert')

  // Wiring: one function decides which panel is open; the slash keys are handled before the @ keys; the
  // only submit() of the key handler is still the one after `enterAction === 'send'` (0.9.41 test keeps it).
  const sync = chatPaneSrc.slice(chatPaneSrc.indexOf('const syncComposerTriggers'), chatPaneSrc.indexOf('const pickSlashCommand'))
  assert.match(sync, /findSlashTrigger\(nextText, cursorPos\)/)
  assert.match(sync, /setMentionQuery\(null\)[\s\S]*return[\s\S]*syncMentionTrigger\(nextText, cursorPos\)/)
  assert.equal((chatPaneSrc.match(/syncComposerTriggers\(/g) || []).length, 3, 'the three textarea handlers')
  assert.equal((chatPaneSrc.match(/syncMentionTrigger\(nextVal|syncMentionTrigger\(e\.target/g) || []).length, 0)
  const keydown = chatPaneSrc.slice(chatPaneSrc.indexOf('onKeyDown={e => {', chatPaneSrc.indexOf('data-testid="chat-input"')))
  assert.ok(keydown.indexOf('slashQuery !== null') < keydown.indexOf("mentionQuery !== null && e.key === 'Escape'"))
  assert.match(keydown, /slashAction === 'insert' \|\| slashAction === 'swallow'/)
  assert.ok(keydown.indexOf('submit()') > keydown.indexOf("enterAction === 'send'"))
})

test('v0.9.43: a host command typed in the composer is never sent as a chat turn', () => {
  const submit = chatPaneSrc.slice(chatPaneSrc.indexOf('const submit = ('), chatPaneSrc.indexOf('const clearComposerForCommand'))
  const cmdAt = submit.indexOf('parseSlashCommand(text)')
  assert.ok(cmdAt > 0 && cmdAt < submit.indexOf('onSendMessage('), 'commands are taken out before onSendMessage')
  assert.match(submit, /if \(!gate\.ok\) \{[\s\S]*?return[\s\S]*?\}/)
  assert.match(submit, /onRunSlashCommand\?\.\(command\)\s*\n\s*return/)
  // Closed and blocked commands are refused with the reason.
  assert.match(commandGate(parseSlashCommand('/plan x'), { channel: 'ready', connected: true, hasSession: true }).reason, /大总管会话未开放/)
  const ready = { channel: 'ready', connected: true, hasSession: true, running: false, compressing: false }
  assert.equal(commandGate(parseSlashCommand('/status'), ready).ok, true)
  assert.equal(commandGate(parseSlashCommand('/status'), { ...ready, running: true }).ok, true)
  assert.match(commandGate(parseSlashCommand('/abort'), ready).reason, /没有在运行/)
  assert.equal(commandGate(parseSlashCommand('/abort'), { ...ready, running: true }).ok, true)
  assert.match(commandGate(parseSlashCommand('/title'), ready).reason, /用法：\/title <新标题>/)
  assert.match(commandGate(parseSlashCommand('/clear'), { ...ready, running: true }).reason, /正在运行/)
})

// ---- capsule and compress gate ---------------------------------------------------------------------------

test('v0.9.43: the context capsule reads "上下文 used / window (percent)" and warns near the host trigger', () => {
  assert.equal(formatTokenCount(8191), '8191')
  assert.equal(formatTokenCount(123456), '12.3万')
  assert.equal(formatTokenCount(1000000), '100万')
  // rework 1: warn from 90 % of the host trigger (window × threshold, 0.65 when unknown -> 166400 here).
  assert.deepEqual(contextCapsule({ tokens: 123000, window: 256000 }), { label: '上下文 12.3万 / 25.6万 (48%)', percent: 48, level: 'ok', triggerTokens: 166400 })
  assert.equal(contextCapsule({ tokens: 149760, window: 256000 }).level, 'warn')
  assert.equal(contextCapsule({ tokens: 149759, window: 256000 }).level, 'ok')
  assert.deepEqual(contextCapsule({}), { label: '上下文 —', percent: null, level: 'unknown', triggerTokens: 0 })
  assert.equal(contextCapsule({ tokens: 9000 }).label, '上下文 9000')
  assert.equal(contextCapsule({ window: 256000 }).label, '上下文 — / 25.6万')
  // Where the used tokens come from.
  assert.equal(contextTokensOf({ event: 'resumed', contextTokens: 186566 }), 186566)
  assert.equal(contextTokensOf({ event: 'resumed', contextTokens: 0 }), undefined)
  assert.equal(contextTokensOf({ event: 'usage.updated', contextTokens: 174273 }), 174273)
  assert.equal(contextTokensOf({ event: 'compression.completed', compressed: true, contextTokens: 8191 }), 8191)
  assert.equal(contextTokensOf({ event: 'compression.completed', error: 'boom', afterTokens: 0 }), undefined)
  assert.equal(contextTokensOf({ event: 'session.command', action: 'context', totalTokens: 9635 }), undefined, 'rework 1: /context is another measure')
  assert.equal(contextTokensOf({ event: 'message.delta', delta: 'x' }), undefined)
})

test('v0.9.43: the compress button is greyed out exactly when the host would refuse', () => {
  const ready = { channel: 'ready', connected: true, hasSession: true, running: false, compressing: false }
  assert.deepEqual(compressGate(ready), { ok: true, reason: '' })
  assert.match(compressGate({ ...ready, running: true }).reason, /正在运行/)
  assert.match(compressGate({ ...ready, compressing: true }).reason, /正在压缩/)
  assert.match(compressGate({ ...ready, connected: false }).reason, /实时通道未连接/)
  assert.match(compressGate({ ...ready, hasSession: false }).reason, /还没有大总管会话/)
  assert.match(compressGate({ ...ready, channel: 'unsupported' }).reason, /不兼容/)
  assert.equal(compressGate({ ...ready, channel: 'unsupported', reason: '来源是 coding_agent' }).reason, '来源是 coding_agent')
  assert.equal(compressGate({ ...ready, channel: 'unknown' }).ok, true, 'unknown is probed with /context first')
  assert.equal(compressResultText({ ok: true, beforeTokens: 174273, afterTokens: 8191 }), '上下文已压缩：174273 → 8191 tokens')
  assert.equal(compressResultText({ ok: false, outcome: 'timeout' }), '压缩超时，上下文未变，可重试')
  assert.match(compressResultText({ ok: false, outcome: 'failed', message: 'x' }), /^压缩失败，上下文未变，可重试/)
})

// ---- command runner over a live handle -------------------------------------------------------------------

function fakeHandle() {
  const sent = []
  return { sent, async run(text) { sent.push(text) }, async stop() { sent.push('<stop>') } }
}

test('v0.9.43: a command settles with the host session.command answer, a timeout, or as a passthrough', async () => {
  const runner = createCommandRunner()
  assert.equal((await runner.run('/status')).message, '实时通道未连接，稍后再试')
  const h = fakeHandle()
  runner.attach('s1', h)
  const p = runner.run('/status', { action: 'status' })
  await sleep(0)
  assert.deepEqual(h.sent, ['/status'])
  assert.equal(runner.busy, true)
  assert.equal((await runner.run('/usage')).message, '上一条命令还没结束')
  runner.handleEvent({ event: 'session.command', session_id: 'other', action: 'status', ok: true })
  runner.handleEvent({ event: 'session.command', session_id: 's1', action: 'usage', ok: true })
  assert.equal(runner.busy, true, 'answers for another session or command are ignored')
  runner.handleEvent({ event: 'session.command', session_id: 's1', command: 'status', action: 'status', ok: true, message: 'Status: idle' })
  const res = await p
  assert.equal(res.ok, true)
  assert.equal(res.message, 'Status: idle')

  // Passthrough: the host started a model run instead of answering.
  const p2 = runner.run('/context', { action: 'context' })
  runner.handleEvent({ event: 'run.started', session_id: 's1' })
  const r2 = await p2
  assert.equal(r2.outcome, 'unsupported')
  assert.equal(r2.passthrough, true)
  // A running-state command (/queue) does not treat the host's run.queued as a passthrough.
  const p3 = runner.run('/queue 晚点再说', { action: 'queue', expectsRun: true })
  runner.handleEvent({ event: 'run.queued', session_id: 's1' })
  runner.handleEvent({ event: 'session.command', session_id: 's1', action: 'queue', ok: true, message: 'Queued' })
  assert.equal((await p3).ok, true)

  // The host's Ekko-agent path answers /compress with action "compact": still the answer to /compress.
  const p6 = runner.run('/compress', { action: 'compress' })
  runner.handleEvent({ event: 'session.command', session_id: 's1', action: 'compact', ok: true, compressed: false, beforeTokens: 0, afterTokens: 0, message: 'Compression completed: 0 -> 0 messages, 0 -> 0 tokens.' })
  const r6 = await p6
  assert.equal(r6.ok, true)
  assert.equal(r6.afterTokens, 0)
  assert.equal(r6.compressed, false)
  assert.equal(compressResultText(r6), '上下文没有可压缩的内容，宿主未改动')
  assert.equal(contextTokensOf({ event: 'session.command', action: 'compact', ok: true, compressed: true, afterTokens: 8191 }), undefined, 'rework 1: the capsule follows compression.completed.contextTokens')

  // Timeout with injected timers.
  let fire = null
  const timed = createCommandRunner({ setTimer: fn => { fire = fn; return 1 }, clearTimer: () => {} })
  timed.attach('s1', fakeHandle())
  const p4 = timed.run('/compress', { action: 'compress', timeoutMs: 120000 })
  fire()
  const r4 = await p4
  assert.equal(r4.outcome, 'timeout')
  assert.match(r4.message, /120 秒内没有收到宿主回包/)
  // Detach during a command, then another session attaches: it settles as detached instead of hanging.
  const p5 = runner.run('/status', { action: 'status' })
  runner.detach('s1')
  runner.attach('s2', fakeHandle())
  const r5 = await p5
  assert.equal(r5.outcome, 'detached')
  assert.match(r5.message, /实时通道已断开/)
})

function scriptedRunner(answers) {
  const sent = []
  return {
    sent,
    async run(text, opts = {}) {
      sent.push(text)
      const next = answers.shift()
      if (typeof next === 'function') return next(opts)
      return next
    },
  }
}

const assertRecordShape = payload => validateModel(contract, 'recordTopicCommandInput', payload)

test('v0.9.43: manual compress = /context probe, lock, host /compress, record (happy path)', async () => {
  const runner = scriptedRunner([
    { ok: true, outcome: 'completed', action: 'context', totalTokens: 174273, contextWindow: 256000 },
    opts => { opts.onProgress?.('started', {}); return { ok: true, outcome: 'completed', action: 'compress', beforeTokens: 174273, afterTokens: 8191, message: 'Compression completed' } },
  ])
  const calls = []
  const result = await runManualCompress({
    runner,
    topicId: 't1',
    beginLock: async input => { calls.push(['begin', input]); return { ok: true } },
    record: async payload => { assertRecordShape(payload); calls.push(['record', payload]) },
    stopRun: () => calls.push(['stop']),
    onProbe: probe => calls.push(['probe', probe.totalTokens]),
  })
  assert.deepEqual(runner.sent, ['/context', '/compress'])
  assert.deepEqual(calls.map(c => c[0]), ['probe', 'begin', 'record'])
  assert.deepEqual(calls[2][1], { topicId: 't1', command: 'compress', ok: true, outcome: 'completed', message: 'Compression completed', beforeTokens: 174273, afterTokens: 8191 })
  assert.equal(result.ok, true)
  assert.equal(compressResultText(result), '上下文已压缩：174273 → 8191 tokens')
})

test('v0.9.43: a probe the host passes to the model is stopped, recorded as unsupported, and nothing is compressed', async () => {
  for (const probe of [
    { ok: false, outcome: 'unsupported', passthrough: true, message: '宿主把命令当成普通消息交给了模型（命令通道被拦截）' },
    { ok: false, outcome: 'timeout', message: '8 秒内没有收到宿主回包' },
  ]) {
    const runner = scriptedRunner([probe])
    const calls = []
    const result = await runManualCompress({
      runner,
      topicId: 't1',
      beginLock: async () => calls.push('begin'),
      record: async payload => { assertRecordShape(payload); calls.push(['record', payload]) },
      stopRun: () => calls.push('stop'),
    })
    assert.deepEqual(runner.sent, ['/context'], 'no /compress')
    assert.ok(!calls.includes('begin'), 'no lock')
    assert.equal(calls.includes('stop'), Boolean(probe.passthrough))
    const rec = calls.find(c => Array.isArray(c))[1]
    // rework 2: only a passthrough is "unsupported"; a probe timeout is one failed attempt (button stays usable).
    const want = probe.passthrough ? 'unsupported' : 'timeout'
    assert.equal(rec.outcome, want)
    assert.equal(rec.ok, false)
    assert.equal(result.outcome, want)
    assert.equal(result.probeFailed, true)
  }
})

test('v0.9.43: a refused lock sends nothing; timeouts self-check with /context; failures are recorded', async () => {
  const ctxOk = tokens => ({ ok: true, outcome: 'completed', action: 'context', totalTokens: tokens })
  // Refused lock (Chief running): the error goes up, /compress is not sent, nothing recorded.
  const r1 = scriptedRunner([ctxOk(174273)])
  const recs1 = []
  await assert.rejects(runManualCompress({ runner: r1, topicId: 't1', beginLock: async () => { throw new Error('大总管正在运行，等这一轮结束后再压缩') }, record: async p => recs1.push(p) }), /正在运行/)
  assert.deepEqual(r1.sent, ['/context'])
  assert.equal(recs1.length, 0)

  // Timeout, then /context shows a clear drop against the /context baseline: success.
  const r2 = scriptedRunner([ctxOk(174273), { ok: false, outcome: 'timeout', message: '120 秒内没有收到宿主回包' }, ctxOk(9000)])
  const recs2 = []
  const res2 = await runManualCompress({ runner: r2, topicId: 't1', beginLock: async () => {}, record: async p => { assertRecordShape(p); recs2.push(p) } })
  assert.deepEqual(r2.sent, ['/context', '/compress', '/context'])
  assert.equal(res2.ok, true)
  assert.deepEqual(recs2[0], { topicId: 't1', command: 'compress', ok: true, outcome: 'completed', message: '超时后核对：上下文已下降', beforeTokens: 174273, afterTokens: 9000 })

  // Timeout without a drop: recorded as timeout (lock released by the record).
  const r3 = scriptedRunner([ctxOk(174273), { ok: false, outcome: 'timeout', message: 'x' }, ctxOk(170000)])
  const recs3 = []
  const res3 = await runManualCompress({ runner: r3, topicId: 't1', beginLock: async () => {}, record: async p => recs3.push(p) })
  assert.equal(res3.outcome, 'timeout')
  assert.equal(recs3[0].outcome, 'timeout')
  assert.equal(compressResultText(res3), '压缩超时，上下文未变，可重试')

  // Host refused (/compress while working): failed, with the host message.
  const r4 = scriptedRunner([ctxOk(174273), { ok: false, outcome: 'failed', message: 'Compression can only run while the session is idle.' }])
  const recs4 = []
  const res4 = await runManualCompress({ runner: r4, topicId: 't1', beginLock: async () => {}, record: async p => recs4.push(p) })
  assert.equal(res4.ok, false)
  assert.deepEqual(recs4[0], { topicId: 't1', command: 'compress', ok: false, outcome: 'failed', message: 'Compression can only run while the session is idle.' })
})

// ---- server: lock, context, record ------------------------------------------------------------------------

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-compress-'))
  const dataDir = join(dir, 'data')
  const db = createDatabase(dataDir, {})
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {}, error() {} }, settleDelaysMs: [0, 0, 0, 0] })
  const calls = { run: 0, request: [] }
  const state = { working: false, source: 'cli' }
  const emitted = []
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request(path, opts) { calls.request.push({ path, query: opts?.query }); return path === '/api/studio/sessions/context-length' ? { context_length: 256000 } : null },
    sessions: {
      async create() { return { session: { id: 'sess-new' } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run() { calls.run += 1; return { run_id: 'r1' } },
      async stop() { state.working = false; return { ok: true } },
      async get(id) { return { session: { id, source: state.source, model: 'gpt-6', provider: 'openai-codex' } } },
      async messages() { return { messages: [], total: 0, offset: 0, limit: 80, hasMore: false } },
      async connect(id, cb) { const t = setTimeout(() => cb({ event: 'resumed', isWorking: state.working, runStartedAt: 0, queueLength: 0 }), 0); return { close() { clearTimeout(t) } } },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit(name, payload) { emitted.push(payload?.reason) } } }
  const topic = db.createTopic(1, 'default', {})
  db.updateTopic(1, 'default', topic.id, { chiefSessionId: 'sess-chief' })
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(dir, { recursive: true, force: true }) }
  return { db, orch, run, calls, state, emitted, topic, cleanup }
}

test('v0.9.43: get-topic-context returns the window and the command channel from the host', async () => {
  const s = setup()
  try {
    const out = await s.orch.getTopicContext(s.run, { topicId: s.topic.id })
    validateModel(contract, 'topicContextOutput', out)
    assert.deepEqual(out, { topicId: s.topic.id, sessionId: 'sess-chief', contextWindow: 256000, model: 'gpt-6', provider: 'openai-codex', commandChannel: 'ready', reason: '', compressionThreshold: 0.65, thresholdSource: 'fallback', compressingSince: 0 })
    assert.deepEqual(s.calls.request[0], { path: '/api/studio/sessions/context-length', query: { model: 'gpt-6', provider: 'openai-codex' } })
    s.state.source = 'builtin_agent'
    const outEkko = await s.orch.getTopicContext(s.run, { topicId: s.topic.id })
    assert.equal(outEkko.commandChannel, 'unknown', 'Ekko-agent sessions are probed with /context first')
    s.state.source = 'coding_agent'
    const out2 = await s.orch.getTopicContext(s.run, { topicId: s.topic.id })
    assert.equal(out2.commandChannel, 'unsupported')
    assert.match(out2.reason, /coding_agent/)
    const bare = s.db.createTopic(1, 'default', {})
    const out3 = await s.orch.getTopicContext(s.run, { topicId: bare.id })
    validateModel(contract, 'topicContextOutput', out3)
    assert.equal(out3.commandChannel, 'unsupported')
    assert.equal(s.calls.request.length, 6, 'no host call for a topic without a Chief session (2 per context read)')
  } finally { s.cleanup() }
})

test('v0.9.43: the compress lock is refused while the Chief runs, and while held no Chief turn starts', async () => {
  const s = setup()
  try {
    const { db, orch, run, calls, state, topic } = s
    // Refused while working, and the topic is left as it was.
    state.working = true
    await assert.rejects(orch.beginTopicCompress(run, { topicId: topic.id }), /大总管正在运行/)
    state.working = false
    db.updateTopic(1, 'default', topic.id, { isRunning: false, activeRunId: '' })

    const lock = await orch.beginTopicCompress(run, { topicId: topic.id })
    validateModel(contract, 'beginTopicCompressOutput', lock)
    assert.equal(lock.until - lock.since, 135000)
    assert.ok(s.emitted.includes(`topic.compress.started:${topic.id}`))
    await assert.rejects(orch.beginTopicCompress(run, { topicId: topic.id }), /正在压缩/)
    const snap = await orch.getSnapshot(run)
    assert.equal(snap.topics.find(t => t.id === topic.id).compressingSince, lock.since)
    assert.equal((await orch.getTopicContext(run, { topicId: topic.id })).compressingSince, lock.since)

    // A send (also with interrupt) is queued, never started; promote is refused; reconcile does not drain.
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '压缩时发的消息', clientNonce: 'cn-1' })
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '插队也不行', interrupt: true, clientNonce: 'cn-2' })
    const queued = db.listTopicQueue(1, 'default', topic.id)
    assert.deepEqual(queued.map(q => q.text), ['压缩时发的消息', '插队也不行'])
    await assert.rejects(orch.promoteTopicQueueItem(run, { topicId: topic.id, itemId: queued[0].id }), /上下文正在压缩/)
    await orch.reconcileActiveRuns(run).catch(() => {})
    await sleep(30)
    assert.equal(calls.run, 0, 'no Chief run while compressing')
    assert.equal(db.listTopicQueue(1, 'default', topic.id).length, 2)
    const fresh = db.getTopic(1, 'default', topic.id)
    assert.equal(fresh.isRunning, false, 'a compression never marks the topic running')
    assert.equal(fresh.messages.filter(m => m.kind === 'human').length, 0)

    // record-topic-command releases the lock and writes the result.
    const input = { topicId: topic.id, command: 'compress', ok: true, outcome: 'completed', beforeTokens: 174273, afterTokens: 8191, lockId: lock.lockId }
    validateModel(contract, 'recordTopicCommandInput', input)
    const after = await orch.recordTopicCommand(run, input)
    const view = after.topics.find(t => t.id === topic.id)
    assert.equal(view.compressingSince, undefined)
    assert.equal(view.messages.at(-1).kind, 'system')
    assert.equal(view.messages.at(-1).text, '上下文已压缩：174273 → 8191 tokens')
    assert.ok(s.emitted.includes(`topic.command.recorded:${topic.id}`))
    const again = await orch.beginTopicCompress(run, { topicId: topic.id })
    assert.equal(again.ok, true, 'the lock can be taken again after it ended')
    await orch.recordTopicCommand(run, { topicId: topic.id, command: 'compress', ok: false, outcome: 'timeout' })
    assert.equal(db.getTopic(1, 'default', topic.id).messages.at(-1).text, '压缩超时，上下文未变，可重试')
    await orch.recordTopicCommand(run, { topicId: topic.id, command: 'compress', ok: true, compressed: false, beforeTokens: 0, afterTokens: 0 })
    assert.equal(db.getTopic(1, 'default', topic.id).messages.at(-1).text, '上下文没有可压缩的内容，宿主未改动')
    await orch.recordTopicCommand(run, { topicId: topic.id, command: 'status', ok: true, message: 'Status: idle, source: cli' })
    assert.equal(db.getTopic(1, 'default', topic.id).messages.at(-1).text, '/status：Status: idle, source: cli')
  } finally { s.cleanup() }
})

test('v0.9.43: the lock ends by itself, so a page that never reports back cannot lock a topic for good', async () => {
  const s = setup()
  const realNow = Date.now
  try {
    const lock = await s.orch.beginTopicCompress(s.run, { topicId: s.topic.id })
    Date.now = () => lock.until + 1
    const snap = await s.orch.getSnapshot(s.run)
    assert.equal(snap.topics.find(t => t.id === s.topic.id).compressingSince, undefined)
    Date.now = realNow
    assert.equal((await s.orch.beginTopicCompress(s.run, { topicId: s.topic.id })).ok, true)
  } finally { Date.now = realNow; s.cleanup() }
})

// ---- contract, wiring, release ----------------------------------------------------------------------------

test('v0.9.43: the three RPCs are declared, registered and the page uses only the host command channel', () => {
  for (const name of ['get-topic-context', 'begin-topic-compress', 'record-topic-command']) {
    assert.ok(contract.rpc[name], name)
    assert.ok(contract.rpc[name].description.length > 20, `${name} description`)
  }
  const handlers = read('src/server/rpc-handlers.mjs')
  for (const name of ['get-topic-context', 'begin-topic-compress', 'record-topic-command']) assert.match(handlers, new RegExp(`'${name}'`))
  // The page sends commands over its live session handle, not through sessions.run / send-topic-message.
  const hook = read('src/client/use-chief-context.js')
  assert.match(appSrc, /chiefContextEventRef\.current\?\.onSessionEvent\(evt\)/)
  assert.match(appSrc, /chiefContextEventRef\.current\?\.attach\(sid, h\)/)
  assert.match(appSrc, /chiefContextEventRef\.current\?\.detach\(sid\)/)
  assert.doesNotMatch(hook, /send-topic-message|sessions\.run/)
  assert.match(hook, /'begin-topic-compress'/)
  assert.match(hook, /'record-topic-command'/)
  // Only the Chief session: the build/review sessions are never addressed by this feature.
  assert.doesNotMatch(hook + read('src/client/chief-commands.js'), /buildSessionId|reviewSessionId/)
  // The header shows the capsule and the confirm dialog guards compress/compact/clear.
  assert.match(chatPaneSrc, /<ChiefContextCapsule/)
  assert.match(chatPaneSrc, /<CommandConfirmDialog command=\{confirmCommand\}/)
  assert.deepEqual(SLASH_COMMANDS.filter(c => c.confirm).map(c => c.name), ['compress', 'compact', 'clear'])
})

test('v0.9.43: shipped bundles carry the feature', () => {
  const client = read('dist/client.mjs')
  const server = read('dist/server.mjs')
  for (const literal of ['begin-topic-compress', 'record-topic-command', 'get-topic-context', 'chief-context-capsule', 'btn-compress-context', 'slash-command-panel']) {
    assert.ok(client.includes(literal), `client bundle has ${literal}`)
  }
  for (const literal of ['get-topic-context', 'begin-topic-compress', 'record-topic-command', 'topic.compress.started:', '/api/studio/sessions/context-length']) {
    assert.ok(server.includes(literal), `server bundle has ${literal}`)
  }
})

test('v0.9.43: release metadata agrees and this change has its own changelog section', () => {
  const plugin = JSON.parse(read('plugin.json'))
  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(plugin.version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(contract.description.includes(`v${pkg.version} `))
  const changelog = read('CHANGELOG.md')
  const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map(m => m[1])
  assert.equal(new Set(headings).size, headings.length, 'no duplicate version headings')
  const start = changelog.indexOf('## [0.9.43]')
  assert.ok(start >= 0)
  const section = changelog.slice(start, changelog.indexOf('\n## [', start + 1))
  assert.match(section, /大总管上下文/)
  assert.match(section, /\/compress/)
})

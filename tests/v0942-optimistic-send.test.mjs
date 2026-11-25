// v0.9.42 (Todo #23): the user's bubble appears when "send" is pressed, the server stores and announces the
// message before it probes engines, and only build/activity refreshes stay in the 800 ms window.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { validateModel } from '../sdk/harness/contracts.mjs'
import {
  REFRESH_GATE_MS, addPendingSend, createClientNonce, createPendingSend, isClientNonce, isUserMessageUpdate, markPendingFailed,
  mergeOptimisticMessages, messageKey, optimisticText, prunePendingSends, refreshWaitMs,
} from '../src/client/optimistic-send.js'

const pkgRoot = new URL('../', import.meta.url).pathname
const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

function setup({ probeDelayMs = 0, runFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-optimistic-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {} }, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const calls = { probe: 0, probeDone: 0, run: 0 }
  const flags = { runFails }
  const emitted = []
  const host = {
    agents: {
      async list() {
        calls.probe += 1
        if (probeDelayMs) await sleep(probeDelayMs)
        calls.probeDone += 1
        return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] }
      },
      async models() { return { models: [] } },
    },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id) {
        calls.run += 1
        if (flags.runFails) throw new Error('engine exploded while starting')
        const s = sessions.get(id)
        if (s) s.is_running = true
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages() { return { messages: [], total: 0, offset: 0, limit: 80, hasMore: false } },
    },
  }
  const run = {
    identity: { userId: 1, profile: 'default' },
    host,
    messages: { emit(name, payload) { emitted.push({ name, reason: payload?.reason, at: Date.now() }) } },
  }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  const humans = topicId => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'human')
  return { db, orch, run, emitted, calls, flags, sessions, cleanup, humans, dataDir }
}

// ---- server -------------------------------------------------------------------------------------------

test('v0.9.42: the user message is stored and announced before the engine probe answers', async () => {
  const ctx = setup({ probeDelayMs: 250 })
  try {
    const { orch, run, emitted, calls, humans, db } = ctx
    // Created in storage directly: no state read has filled the engine cache, so this send really probes.
    const topic = db.createTopic(1, 'default', {})
    const startedAt = Date.now()
    const sending = orch.sendTopicMessage(run, { topicId: topic.id, text: '探测很慢的时候', clientNonce: 'cn-slow-1' })
    // Well inside the 250 ms probe: the bubble is already in storage and already announced.
    await sleep(60)
    assert.ok(calls.probe >= 1, 'the probe has been started')
    assert.equal(calls.probeDone, 0, 'the probe has not answered yet')
    assert.equal(calls.run, 0, 'the Chief has not been started yet')
    const stored = humans(topic.id)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].text, '探测很慢的时候')
    assert.equal(stored[0].clientNonce, 'cn-slow-1')
    const accepted = emitted.find(e => e.reason === `topic.message.accepted:${topic.id}`)
    assert.ok(accepted, 'board.updated with reason topic.message.accepted was emitted')
    assert.ok(accepted.at - startedAt < 100, `announced ${accepted.at - startedAt} ms after the call, long before the 250 ms probe`)
    const snap = await sending
    assert.ok(calls.probeDone >= 1)
    assert.equal(calls.run, 1, 'the Chief still got the message')
    assert.equal(humans(topic.id).length, 1, 'no second bubble after the launch')
    validateModel(contract, 'stateSnapshot', snap)
    assert.equal(snap.topics.find(t => t.id === topic.id).messages.filter(m => m.clientNonce === 'cn-slow-1').length, 1)
  } finally { ctx.cleanup() }
})

test('v0.9.42: a failed launch keeps the message and writes a readable reason on it', async () => {
  const ctx = setup({ runFails: true })
  try {
    const { orch, run, emitted, humans, flags } = ctx
    const { topic } = await orch.createTopic(run, {})
    await assert.rejects(() => orch.sendTopicMessage(run, { topicId: topic.id, text: '这条会失败', clientNonce: 'cn-fail-1' }))
    const stored = humans(topic.id)
    assert.equal(stored.length, 1, 'the user message is kept')
    assert.equal(stored[0].text, '这条会失败')
    assert.ok(stored[0].sendError && stored[0].sendError.length > 0, 'the reason is on the message')
    assert.ok(!stored[0].sendError.includes('{'), 'no raw JSON envelope in the reason')
    assert.ok(emitted.some(e => e.reason === `topic.message.failed:${topic.id}`))
    const snap = await orch.getSnapshot(run)
    validateModel(contract, 'stateSnapshot', snap)
    assert.equal(snap.topics.find(t => t.id === topic.id).messages.find(m => m.clientNonce === 'cn-fail-1').sendError, stored[0].sendError)
    assert.equal(db_topic(ctx, topic.id).isRunning, false)

    // Sending again (new nonce) after the cause is fixed works and leaves the failed one as it was.
    flags.runFails = false
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '这条会失败', clientNonce: 'cn-fail-2' })
    const after = humans(topic.id)
    assert.equal(after.length, 2)
    assert.ok(after[0].sendError)
    assert.equal(after[1].sendError, undefined)
  } finally { ctx.cleanup() }
})

function db_topic(ctx, topicId) { return ctx.db.getTopic(1, 'default', topicId) }

test('v0.9.42: the same nonce delivered twice is stored and run once', async () => {
  const ctx = setup()
  try {
    const { orch, run, calls, humans, db } = ctx
    const { topic } = await orch.createTopic(run, {})
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '只算一次', clientNonce: 'cn-dup-1' })
    const again = await orch.sendTopicMessage(run, { topicId: topic.id, text: '只算一次', clientNonce: 'cn-dup-1' })
    assert.equal(humans(topic.id).length, 1)
    assert.equal(calls.run, 1)
    assert.equal(db.listTopicQueue(1, 'default', topic.id).length, 0, 'the repeat was not queued either')
    assert.equal(again.topics.find(t => t.id === topic.id).messages.filter(m => m.kind === 'human').length, 1)

    // While the Chief is busy a follow-up is queued with its nonce; its repeat is not queued twice.
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '排队的', clientNonce: 'cn-q-1' })
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '排队的', clientNonce: 'cn-q-1' })
    const queue = db.listTopicQueue(1, 'default', topic.id)
    assert.equal(queue.length, 1)
    assert.equal(queue[0].clientNonce, 'cn-q-1')
    assert.equal(humans(topic.id).length, 1, 'a queued follow-up is not a bubble yet')

    // Without a nonce (older page) nothing is deduplicated: behaviour before 0.9.42.
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '没有 nonce' })
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '没有 nonce' })
    assert.equal(db.listTopicQueue(1, 'default', topic.id).length, 3)
    assert.equal(db.listTopicQueue(1, 'default', topic.id)[1].clientNonce, undefined)
  } finally { ctx.cleanup() }
})

test('v0.9.42: a queued follow-up keeps its nonce when it becomes a bubble, once', async () => {
  const ctx = setup()
  try {
    const { orch, run, humans, db, sessions } = ctx
    const { topic } = await orch.createTopic(run, {})
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '第一条', clientNonce: 'cn-a' })
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '第二条', clientNonce: 'cn-b' })
    assert.deepEqual(humans(topic.id).map(m => m.clientNonce), ['cn-a'])
    // Turn 1 ends, the queue is drained.
    const sid = db.getTopic(1, 'default', topic.id).chiefSessionId
    sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    for (let i = 0; i < 40 && humans(topic.id).length < 2; i += 1) await sleep(25)
    assert.deepEqual(humans(topic.id).map(m => m.clientNonce), ['cn-a', 'cn-b'], 'server order: first sent, first shown')
    assert.equal(db.listTopicQueue(1, 'default', topic.id).length, 0)
  } finally { ctx.cleanup() }
})

test('v0.9.42: the contract accepts clientNonce and a database from 0.9.38 gains the new columns', () => {
  validateModel(contract, 'topicMessageInput', { topicId: 't1', text: 'x', clientNonce: createClientNonce() })
  validateModel(contract, 'topicMessageInput', { topicId: 't1', text: 'x' })
  assert.throws(() => validateModel(contract, 'topicMessageInput', { topicId: 't1', text: 'x', clientNonce: 'n'.repeat(65) }))

  const root = mkdtempSync(join(tmpdir(), 'ekko-optimistic-mig-'))
  try {
    const dataDir = join(root, 'data')
    const first = createDatabase(dataDir, {})
    const topic = first.createTopic(1, 'default', {})
    first.addTopicMessage(1, 'default', topic.id, { kind: 'human', text: '旧消息' })
    first.close()
    // Back to the 0.9.38 shape: no nonce / error columns, no nonce index.
    const raw = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'))
    raw.exec('DROP INDEX idx_topic_msgs_nonce; DROP INDEX idx_topic_queue_nonce; ALTER TABLE topic_messages DROP COLUMN client_nonce; ALTER TABLE topic_messages DROP COLUMN send_error; ALTER TABLE topic_queue DROP COLUMN client_nonce;')
    raw.close()
    const db = createDatabase(dataDir, {})
    const old = db.getTopic(1, 'default', topic.id).messages
    assert.equal(old.length, 1)
    assert.equal(old[0].text, '旧消息')
    assert.ok(!('clientNonce' in old[0]) && !('sendError' in old[0]), 'old rows look as they did')
    // Two old rows without a nonce never collide; a nonce is unique inside one topic only.
    assert.ok(db.addTopicMessage(1, 'default', topic.id, { kind: 'human', text: '又一条旧式消息' }))
    assert.ok(db.addTopicMessage(1, 'default', topic.id, { kind: 'human', text: 'a', clientNonce: 'cn-1' }))
    assert.equal(db.addTopicMessage(1, 'default', topic.id, { kind: 'human', text: 'a again', clientNonce: 'cn-1' }), '')
    const other = db.createTopic(1, 'default', {})
    assert.ok(db.addTopicMessage(1, 'default', other.id, { kind: 'human', text: 'a', clientNonce: 'cn-1' }))
    // A nonce with characters outside the allowed set is dropped, the message is still stored.
    assert.ok(db.addTopicMessage(1, 'default', topic.id, { kind: 'human', text: 'b', clientNonce: 'bad nonce!' }))
    assert.equal(db.getTopic(1, 'default', topic.id).messages.at(-1).clientNonce, undefined)
    db.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---- client rules -------------------------------------------------------------------------------------

const stored = (id, text, createdAt, extra = {}) => ({ id, kind: 'human', text, createdAt, attachments: [], ...extra })

test('v0.9.42: the pending bubble is in the list at once and is replaced, never doubled, by the stored message', () => {
  const nonce = createClientNonce()
  assert.ok(isClientNonce(nonce))
  assert.notEqual(nonce, createClientNonce(), 'every send gets its own nonce')
  let pending = addPendingSend([], createPendingSend({ nonce, topicId: 't1', text: '你好', now: 1000, seq: 1 }))
  const topic = { id: 't1', messages: [stored('m1', '早先的', 500)], queuedItems: [] }

  const before = mergeOptimisticMessages(topic, pending)
  assert.deepEqual(before.map(m => m.text), ['早先的', '你好'])
  assert.equal(before[1].pending, true)
  assert.equal(before[1].clientNonce, nonce)

  // The server's copy arrives (answer or emit): one bubble, the stored one, under the same React key.
  const acked = { ...topic, messages: [...topic.messages, stored('m2', '你好', 1003, { clientNonce: nonce })] }
  const after = mergeOptimisticMessages(acked, pending)
  assert.deepEqual(after.map(m => m.id), ['m1', 'm2'])
  assert.equal(after[1].pending, undefined)
  assert.equal(messageKey(before[1]), messageKey(after[1]), 'the bubble is not re-mounted when it is confirmed')
  pending = prunePendingSends(pending, [acked])
  assert.deepEqual(pending, [])

  // The same stored message delivered twice in one list is drawn once.
  const twice = { ...acked, messages: [...acked.messages, acked.messages[1], stored('m9', '你好', 1004, { clientNonce: nonce })] }
  assert.deepEqual(mergeOptimisticMessages(twice, []).map(m => m.id), ['m1', 'm2'])
  // Nothing pending and nothing repeated: the stored array itself is returned (no extra render work).
  assert.equal(mergeOptimisticMessages(acked, []), acked.messages)
})

test('v0.9.42: a send that became a queued follow-up is shown by the queue tray, not as a bubble', () => {
  const pending = [createPendingSend({ nonce: 'cn-q', topicId: 't1', text: '排队', now: 10, seq: 1 })]
  const topic = { id: 't1', messages: [], queuedItems: [{ id: 'tq-1', text: '排队', clientNonce: 'cn-q' }] }
  assert.deepEqual(mergeOptimisticMessages(topic, pending), [])
  assert.deepEqual(prunePendingSends(pending, [topic]), [])
})

test('v0.9.42: order is stable and other topics, reloads and reconnects show the stored result', () => {
  const pending = [
    createPendingSend({ nonce: 'cn-2', topicId: 't1', text: '第二', now: 2000, seq: 2 }),
    createPendingSend({ nonce: 'cn-1', topicId: 't1', text: '第一', now: 2000, seq: 1 }),
    createPendingSend({ nonce: 'cn-x', topicId: 't2', text: '别的话题', now: 1500, seq: 3 }),
  ]
  const t1 = { id: 't1', messages: [stored('m1', 'a', 100), stored('m2', 'b', 100), stored('m3', 'c', 5000)], queuedItems: [] }
  // Stored messages keep the server's order (even one with a later clock); unconfirmed ones follow in send order.
  assert.deepEqual(mergeOptimisticMessages(t1, pending).map(m => m.text), ['a', 'b', 'c', '第一', '第二'])
  // Another topic only shows its own.
  assert.deepEqual(mergeOptimisticMessages({ id: 't2', messages: [], queuedItems: [] }, pending).map(m => m.text), ['别的话题'])
  // The list is not mutated by merging, so a second pass (re-render, repeated emit) gives the same result.
  assert.deepEqual(mergeOptimisticMessages(t1, pending).map(m => m.text), ['a', 'b', 'c', '第一', '第二'])
  // After a reload the pending list is empty: only what the server stored is shown.
  assert.deepEqual(mergeOptimisticMessages(t1, []).map(m => m.id), ['m1', 'm2', 'm3'])
  // Reconnect: the first state after it holds cn-1 as stored and cn-2 not yet.
  const t1b = { ...t1, messages: [...t1.messages, stored('m4', '第一', 5001, { clientNonce: 'cn-1' })] }
  assert.deepEqual(mergeOptimisticMessages(t1b, pending).map(m => m.text), ['a', 'b', 'c', '第一', '第二'])
  assert.deepEqual(prunePendingSends(pending, [t1b]).map(p => p.nonce), ['cn-2', 'cn-x'])
  assert.equal(prunePendingSends(pending, [t1]), pending, 'unchanged list keeps its identity')
})

test('v0.9.42: a send that did not go out keeps its bubble with the reason until the next send in that topic', () => {
  let pending = [createPendingSend({ nonce: 'cn-f', topicId: 't1', text: '没发出去', now: 1, seq: 1 })]
  pending = markPendingFailed(pending, 'cn-f', '网络连接短暂中断')
  const topic = { id: 't1', messages: [], queuedItems: [] }
  const shown = mergeOptimisticMessages(topic, pending)
  assert.equal(shown.length, 1)
  assert.equal(shown[0].pending, false)
  assert.equal(shown[0].sendError, '网络连接短暂中断')
  assert.equal(markPendingFailed(pending, 'cn-f', '')[0].error, '消息没有发出去，请重试。')
  // The server did store it (with its own reason): the stored copy wins.
  const serverHasIt = { ...topic, messages: [stored('m1', '没发出去', 2, { clientNonce: 'cn-f', sendError: '大总管没有启动' })] }
  assert.deepEqual(mergeOptimisticMessages(serverHasIt, pending).map(m => [m.id, m.sendError]), [['m1', '大总管没有启动']])
  // Sending again removes the failed bubble of that topic (its text was put back into the composer).
  pending = addPendingSend(pending, createPendingSend({ nonce: 'cn-g', topicId: 't1', text: '没发出去', now: 3, seq: 2 }))
  assert.deepEqual(pending.map(p => p.nonce), ['cn-g'])
  assert.equal(optimisticText('', [{ name: 'a.png' }, { name: 'b.pdf' }]), '请查看我上传的 2 个附件（a.png、b.pdf）', 'same sentence the server stores')
})

test('v0.9.42: the 800 ms window holds build and activity refreshes only, never the user message', () => {
  assert.equal(REFRESH_GATE_MS, 800)
  assert.equal(isUserMessageUpdate('topic.message.accepted:topic-1'), true)
  assert.equal(isUserMessageUpdate('topic.message.queued:topic-1'), true)
  assert.equal(isUserMessageUpdate('topic.message.failed:topic-1'), true)
  for (const reason of ['topic.run.started:topic-1', 'todo.build.output', 'chief.settled', 'runtime.warmed', '', undefined]) {
    assert.equal(isUserMessageUpdate(reason), false, String(reason))
  }
  assert.equal(refreshWaitMs({ last: 1000, now: 1100, urgent: true }), 0)
  assert.equal(refreshWaitMs({ last: 1000, now: 1100, urgent: false }), 700)
  assert.equal(refreshWaitMs({ last: 1000, now: 2500, urgent: false }), 0)

  const app = readFileSync(new URL('../src/client/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /loadState\(\{ urgent: isUserMessageUpdate\(reason\) \}\)/, 'board.updated reads the reason')
  assert.match(app, /const wait = urgent \? refreshWaitMs\(\{ urgent \}\) : gate\.last \+ 800 - Date\.now\(\)/, 'only non-urgent refreshes wait')
  // The bubble is added before the RPC is awaited, i.e. in the same tick as the click.
  const send = app.slice(app.indexOf('const handleSendTopicMessage'), app.indexOf('const handleAskChiefCreateAgent'))
  assert.ok(send.indexOf('setPendingSends(prev => addPendingSend(prev, entry))') > 0)
  assert.ok(send.indexOf('setPendingSends(prev => addPendingSend(prev, entry))') < send.indexOf("'send-topic-message'"))
  assert.match(send, /clientNonce: nonce/)
  // The assistant stream is untouched: frame-batched, not in the 800 ms window.
  assert.match(app, /rafIdRef\.current = requestAnimationFrame\(/)
})

// ---- render -------------------------------------------------------------------------------------------

let renderPane = null
let workDir = ''
async function loadRenderer() {
  if (renderPane) return renderPane
  workDir = mkdtempSync(join(tmpdir(), 'ekko-optimistic-render-'))
  const entry = join(workDir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import { ChatPane } from ${JSON.stringify(join(pkgRoot, 'src/client/components/ChatPane.jsx'))}`,
    `export function render(props) { return renderToStaticMarkup(React.createElement(ChatPane, props)) }`,
  ].join('\n'))
  const out = join(workDir, 'bundle.mjs')
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'text' }, nodePaths: [join(pkgRoot, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    // DOMPurify needs a browser DOM; this render only checks structure, so the sanitizer is a pass-through here.
    plugins: [{
      name: 'dompurify-stub',
      setup(b) {
        b.onResolve({ filter: /^dompurify$/ }, () => ({ path: 'dompurify-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { sanitize: s => String(s), addHook() {}, removeHook() {}, setConfig() {} }', loader: 'js' }))
      },
    }],
  })
  renderPane = (await import(pathToFileURL(out).href)).render
  return renderPane
}

const paneProps = (topic, pendingSends) => ({
  ctx: { ui: { notify() {} } },
  state: { agents: [], projects: [], todos: [], topics: [topic], settings: {} },
  topic, projects: [], todos: [],
  liveStream: { isWorking: false, tools: [] },
  pendingSends,
  busy: false, composerFocusSeq: 0,
  onSendMessage() {},
})
const count = (html, needle) => html.split(needle).length - 1

test('v0.9.42: the chat renders the pending bubble, then one stored bubble, and the error state', async t => {
  globalThis.localStorage = { getItem() { return null }, setItem() {}, removeItem() {}, key() { return null }, length: 0 }
  t.after(() => { delete globalThis.localStorage; if (workDir) rmSync(workDir, { recursive: true, force: true }) })
  const render = await loadRenderer()
  const topic = { id: 't1', title: '话题', messages: [], queuedItems: [], autopilot: true, projectId: '', createdAt: 1, updatedAt: 1 }
  const pending = [createPendingSend({ nonce: 'cn-r1', topicId: 't1', text: '刚按下发送的话', now: 1700000000000, seq: 1 })]

  // First render after the click, no server answer yet.
  const sending = render(paneProps(topic, pending))
  assert.equal(count(sending, '刚按下发送的话'), 1)
  assert.match(sending, /data-send-state="sending"/)
  assert.match(sending, /发送中…/)

  // Server copy arrived while the pending entry is still in the list: exactly one bubble, stored.
  const acked = { ...topic, messages: [{ id: 'm1', kind: 'human', text: '刚按下发送的话', attachments: [], createdAt: 1700000000005, clientNonce: 'cn-r1' }] }
  const done = render(paneProps(acked, pending))
  assert.equal(count(done, '刚按下发送的话'), 1, 'never two bubbles')
  assert.match(done, /data-send-state="stored"/)
  assert.doesNotMatch(done, /发送中…/)

  // The Chief could not be started: message kept, reason readable on the bubble.
  const failed = { ...topic, messages: [{ ...acked.messages[0], sendError: '大总管没有启动：引擎运行时还没有装好。' }] }
  const failedHtml = render(paneProps(failed, []))
  assert.equal(count(failedHtml, '刚按下发送的话'), 1)
  assert.match(failedHtml, /data-send-state="failed"/)
  assert.match(failedHtml, /role="alert"[^>]*>大总管没有收到：大总管没有启动：引擎运行时还没有装好。/)

  // The call answered while the Chief is still being started: the stored bubble says so, and only that one.
  const older = { id: 'm0', kind: 'human', text: '更早的一条', attachments: [], createdAt: 1699999990000 }
  const starting = render(paneProps({ ...acked, messages: [older, ...acked.messages], launching: true, launchingMessageId: 'm1' }, []))
  assert.equal(count(starting, 'data-send-state="starting"'), 1)
  assert.equal(count(starting, '已收到，正在启动大总管…'), 1)
  assert.equal(count(starting, 'data-send-state="stored"'), 1)
  // A turn being started for something else (a wake) marks no user bubble.
  assert.doesNotMatch(render(paneProps({ ...acked, launching: true }, [])), /正在启动大总管/)

  // The request itself never reached the server.
  const local = render(paneProps(topic, markPendingFailed(pending, 'cn-r1', '网络连接短暂中断')))
  assert.match(local, /未发送：网络连接短暂中断/)

  // A topic without pending sends and without the new fields renders as before.
  const plain = render(paneProps({ ...topic, messages: [{ id: 'm0', kind: 'human', text: '旧消息', attachments: [], createdAt: 1 }] }, undefined))
  assert.match(plain, /data-send-state="stored"/)
  assert.doesNotMatch(plain, /ot-msg-send-state/)
})

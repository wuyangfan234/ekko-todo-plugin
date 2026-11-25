// The streamed answer of a turn stays on screen after the turn ends until the saved message list has it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const pkgRoot = new URL('../', import.meta.url).pathname
const settlePath = join(pkgRoot, 'src/client/stream-settle.js')
// Loaded lazily so that code without the module fails each assertion instead of the whole file import.
const settle = existsSync(settlePath) ? await import(pathToFileURL(settlePath).href) : {}

class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) { this.map.set(k, String(v)) }
  removeItem(k) { this.map.delete(k) }
}

let renderPane = null
let workDir = ''
async function loadRenderer() {
  if (renderPane) return renderPane
  workDir = mkdtempSync(join(tmpdir(), 'ekko-held-'))
  const entry = join(workDir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import { ChatPane } from ${JSON.stringify(join(pkgRoot, 'src/client/components/ChatPane.jsx'))}`,
    `export function render(props) { return renderToStaticMarkup(React.createElement(ChatPane, props)) }`,
  ].join('\n'))
  const out = join(workDir, 'bundle.mjs')
  const purifyStub = join(workDir, 'purify-stub.mjs')
  writeFileSync(purifyStub, 'export default { sanitize: html => html, addHook() {}, removeHook() {} }\n')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    nodePaths: [join(pkgRoot, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    // The HTML sanitizer needs a browser DOM; the markup under test does not depend on it.
    alias: { dompurify: purifyStub },
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  renderPane = (await import(pathToFileURL(out).href)).render
  return renderPane
}
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

const chief = (text, createdAt, hostMessageId = '') => ({ id: `m-${createdAt}-${hostMessageId}`, kind: 'chief', text, createdAt, hostMessageId, tools: [], attachments: [] })
const paneProps = (topic, extra = {}) => ({
  ctx: { ui: { notify() {} } },
  state: { agents: [], projects: [], todos: [], topics: [topic], settings: {} },
  topic,
  projects: [],
  todos: [],
  liveStream: { isWorking: false, tools: [], text: '', reasoning: '' },
  busy: false,
  composerFocusSeq: 0,
  onSendMessage() {},
  ...extra,
})
const topicOf = (messages = []) => ({ id: 'topic-A', title: '话题', messages, autopilot: true, projectId: '', createdAt: 1, updatedAt: 1, isRunning: false })

test('the unsaved part of a streamed turn is what follows the saved Chief messages', () => {
  const { unsavedStreamTail } = settle
  assert.equal(typeof unsavedStreamTail, 'function')
  const stream = '先看一下日志。\n\n查到了原因。\n\n结论：是同步缺口，不是模型问题。'
  assert.equal(unsavedStreamTail(stream, [], 1000), stream.trim())
  // Interim notes were saved during the turn; only the final answer is still unsaved.
  const saved = [chief('先看一下日志。', 2000), chief('查到了原因。', 3000)]
  assert.equal(unsavedStreamTail(stream, saved, 1000), '结论：是同步缺口，不是模型问题。')
  // The final answer arrives in the saved list: nothing left.
  assert.equal(unsavedStreamTail(stream, [...saved, chief('结论：是同步缺口，不是模型问题。', 4000)], 1000), '')
  // An identical sentence from an earlier turn does not count as this turn's answer.
  assert.equal(unsavedStreamTail('好的。', [chief('好的。', 1000)], 60000), '好的。')
  // The server stores a very long message as its head followed by "…": that copy counts as the saved reply.
  const long = Array.from({ length: 900 }, (_, i) => `第 ${i} 行内容。`).join('\n')
  assert.equal(unsavedStreamTail(long, [chief(`${long.slice(0, 3000)}…`, 5000)], 1000), '')
  // A short message that merely ends with "…" is not treated as a shortened copy.
  assert.equal(unsavedStreamTail('稍等…然后是很长的答案', [chief('稍等…', 5000)], 1000), '然后是很长的答案')
})

test('a turn end holds the reply; it is released only when the saved list has it; after 8s it is marked as waiting', () => {
  const { holdFinalReply, resolveHeldReply, HELD_REPLY_PENDING_AFTER_MS } = settle
  assert.equal(typeof holdFinalReply, 'function')
  assert.equal(HELD_REPLY_PENDING_AFTER_MS, 8000)
  assert.equal(holdFinalReply({ topicId: 't', streamText: '', startedAt: 1, messages: [] }), null, 'nothing streamed: nothing held')
  assert.equal(holdFinalReply({ topicId: 't', streamText: '答案', startedAt: 1000, messages: [chief('答案', 2000)] }), null, 'already saved: nothing held')

  const held = holdFinalReply({ topicId: 't', streamText: '旁白。\n\n最终答案', startedAt: 1000, messages: [chief('旁白。', 2000)], now: 10000 })
  assert.equal(held.topicId, 't')
  assert.deepEqual(resolveHeldReply(held, [chief('旁白。', 2000)], 10500), { text: '最终答案', status: 'syncing' })
  assert.deepEqual(resolveHeldReply(held, [chief('旁白。', 2000)], 17999), { text: '最终答案', status: 'syncing' })
  assert.deepEqual(resolveHeldReply(held, [chief('旁白。', 2000)], 18000), { text: '最终答案', status: 'pending' })
  assert.deepEqual(resolveHeldReply(held, [chief('旁白。', 2000), chief('最终答案', 9000)], 30000), { text: '', status: 'saved' })
  assert.deepEqual(resolveHeldReply(null, [], 1), { text: '', status: 'saved' })
})

test('the same sentence saved by the previous turn does not count as this turn\'s answer', () => {
  const { unsavedStreamTail, holdFinalReply, resolveHeldReply, hostBoundaryOf } = settle
  assert.equal(typeof hostBoundaryOf, 'function')
  // Previous turn answered "好的。" 2 seconds before this turn started; it is host message 3.
  const previous = [chief('好的。', 1000, '3')]
  assert.equal(hostBoundaryOf(previous), 3)
  assert.equal(hostBoundaryOf([chief('x', 1, ''), chief('y', 2, 'ts:1:assistant:y')]), 0, 'no numeric host id: boundary 0')
  assert.equal(unsavedStreamTail('好的。', previous, 3000, 3), '好的。')

  // 1. Turn ends: the reply must be held even though an identical saved sentence is 2s old.
  const held = holdFinalReply({ topicId: 't', streamText: '好的。', startedAt: 3000, hostBoundary: hostBoundaryOf(previous), messages: previous, now: 4000 })
  assert.ok(held, 'held')
  assert.equal(held.hostBoundary, 3)
  // 2. Only the previous turn's copy exists: still waiting.
  assert.deepEqual(resolveHeldReply(held, previous, 4500), { text: '好的。', status: 'syncing' })
  assert.deepEqual(resolveHeldReply(held, previous, 12000), { text: '好的。', status: 'pending' })
  // 3. This turn's copy arrives as a newer host message: released.
  assert.deepEqual(resolveHeldReply(held, [...previous, chief('好的。', 4000, '5')], 4600), { text: '', status: 'saved' })

  // A saved message without a host id falls back to the time rule.
  assert.equal(unsavedStreamTail('答案', [chief('答案', 3500, '')], 3000, 3), '')
  assert.equal(unsavedStreamTail('答案', [chief('答案', 100, '')], 60000, 3), '答案')
  // No boundary recorded (turn start not seen): time rule for every message, as before.
  assert.equal(unsavedStreamTail('答案', [chief('答案', 3500, '9')], 3000, null), '')
})

test('the host boundary of a held reply survives a page reload', () => {
  const { saveHeldReply, loadHeldReply } = settle
  const storage = new MemoryStorage()
  saveHeldReply(storage, { topicId: 'topic-A', text: '好的。', startedAt: 5, endedAt: 1000, hostBoundary: 3 })
  assert.equal(loadHeldReply(storage, 'topic-A', 2000).hostBoundary, 3)
  saveHeldReply(storage, { topicId: 'topic-B', text: '好的。', startedAt: 5, endedAt: 1000 })
  assert.equal(loadHeldReply(storage, 'topic-B', 2000).hostBoundary, null, 'unknown boundary stays unknown')
})

test('a held reply survives a page reload, per topic, and the store stays bounded', () => {
  const { saveHeldReply, loadHeldReply, clearHeldReply, HELD_REPLY_STORAGE_KEY, HELD_REPLY_MAX_TOPICS, HELD_REPLY_MAX_CHARS, HELD_REPLY_MAX_AGE_MS } = settle
  assert.equal(typeof saveHeldReply, 'function')
  const storage = new MemoryStorage()
  saveHeldReply(storage, { topicId: 'topic-A', text: '还没保存的回复', startedAt: 5, endedAt: 1000 })
  assert.deepEqual(loadHeldReply(storage, 'topic-A', 2000), { topicId: 'topic-A', text: '还没保存的回复', startedAt: 5, endedAt: 1000, hostBoundary: null })
  assert.equal(loadHeldReply(storage, 'topic-B', 2000), null, 'another topic does not see it')
  assert.equal(loadHeldReply(storage, 'topic-A', 1000 + HELD_REPLY_MAX_AGE_MS + 1), null, 'dropped after a day')

  for (let i = 0; i < 20; i += 1) saveHeldReply(storage, { topicId: `t-${i}`, text: 'x'.repeat(HELD_REPLY_MAX_CHARS + 500), startedAt: 0, endedAt: 1000 + i })
  const all = JSON.parse(storage.getItem(HELD_REPLY_STORAGE_KEY))
  assert.equal(Object.keys(all).length, HELD_REPLY_MAX_TOPICS)
  assert.ok(all['t-19'] && !all['t-0'], 'newest topics kept')
  assert.equal(all['t-19'].text.length, HELD_REPLY_MAX_CHARS)

  for (const id of Object.keys(all)) clearHeldReply(storage, id)
  assert.equal(storage.getItem(HELD_REPLY_STORAGE_KEY), null, 'empty store removes its key')
  assert.equal(loadHeldReply({ getItem() { throw new Error('blocked') } }, 'topic-A', 1), null, 'storage errors are swallowed')
})

test('the developer trace is off by default and keeps at most 200 entries', () => {
  const { createStreamDebug, STREAM_DEBUG_FLAG, STREAM_DEBUG_MAX_ENTRIES } = settle
  assert.equal(typeof createStreamDebug, 'function')
  const storage = new MemoryStorage()
  const sink = []
  const printed = []
  const dbg = createStreamDebug(storage, sink, { debug: (...a) => printed.push(a) })
  assert.equal(dbg.record('turn.end', { streamChars: 10 }), false)
  assert.equal(sink.length, 0)
  storage.setItem(STREAM_DEBUG_FLAG, '1')
  for (let i = 0; i < STREAM_DEBUG_MAX_ENTRIES + 50; i += 1) dbg.record('turn.end', { streamChars: i, savedAlready: false })
  assert.equal(STREAM_DEBUG_MAX_ENTRIES, 200)
  assert.equal(sink.length, 200)
  assert.equal(sink[199].streamChars, 249)
  assert.equal(sink[199].event, 'turn.end')
  assert.equal(printed.length, 250)
})

test('the chat pane shows a held reply after the stream ended, and a retry button once it is waiting', async () => {
  globalThis.localStorage = new MemoryStorage()
  try {
    const render = await loadRenderer()
    const base = render(paneProps(topicOf([chief('旁白。', 2000)])))
    assert.doesNotMatch(base, /data-testid="held-reply"/)

    const syncing = render(paneProps(topicOf([chief('旁白。', 2000)]), { heldReply: { text: '最终答案第一行', status: 'syncing' } }))
    assert.match(syncing, /data-testid="held-reply"[^>]*data-status="syncing"|data-status="syncing"[^>]*data-testid="held-reply"/)
    assert.match(syncing, /最终答案第一行/, 'the streamed answer is still on screen after the run ended')
    assert.match(syncing, /正在保存这条回复/)
    assert.doesNotMatch(syncing, /data-testid="held-reply-retry"/)
    assert.doesNotMatch(syncing, /data-testid="live-stream-block"/, 'not shown as a running stream')

    const pending = render(paneProps(topicOf([]), { heldReply: { text: '最终答案第一行', status: 'pending' } }))
    assert.match(pending, /最终答案第一行/)
    assert.match(pending, /这条回复还没保存到对话记录/)
    assert.match(pending, /data-testid="held-reply-retry"/)
    assert.match(pending, /重试同步/)
  } finally {
    delete globalThis.localStorage
  }
})

test('App keeps the streamed text at turn end instead of clearing it, and wires the retry to a sync', () => {
  const app = readFileSync(join(pkgRoot, 'src/client/App.jsx'), 'utf8')
  const start = app.indexOf("type === 'run.completed' || type === 'run.failed'")
  assert.ok(start > 0)
  const branch = app.slice(start, app.indexOf('applyStreamEvent(buf, evt)', start))
  const holdAt = branch.indexOf('holdFinalReply(')
  const resetAt = branch.indexOf('streamBufRef.current = { ...EMPTY_STREAM')
  assert.ok(holdAt > 0, 'turn end takes a held copy of the streamed text')
  assert.ok(resetAt > holdAt, 'the stream buffer is reset only after the copy is taken')
  assert.match(branch, /saveHeldReply\(/, 'held copy is written to storage so a reload keeps it')
  assert.match(branch, /hostBoundary: turnBoundaryRef\.current/, 'the held copy carries the host boundary taken at turn start')
  const started = app.slice(app.indexOf("type === 'run.started' || type === 'run.queued'"), start)
  assert.match(started, /turnBoundaryRef\.current = hostBoundaryOf\(topicMessagesRef\.current\)/, 'boundary recorded when the turn starts')
  assert.match(started, /buf\.isWorking && turnBoundaryRef\.current == null\) turnBoundaryRef\.current = hostBoundaryOf\(/, 'and when the page joins a turn already in progress')
  assert.match(app, /loadHeldReply\(heldReplyStorage\(\), tid\)/, 'held copy is restored when the topic is shown again')
  assert.match(app, /heldView\.status !== 'saved'\) return[\s\S]{0,400}clearHeldReply\(/, 'cleared only when the saved list has the reply')
  assert.match(app, /heldReply=\{heldView\.status === 'saved' \? null : heldView\}/)
  assert.match(app, /onRetryHeldSync=\{retryHeldSync\}/)
  assert.match(app, /retryHeldSync = useCallback\([\s\S]{0,300}syncActiveTopic\(heldReply\.topicId\)/)
})

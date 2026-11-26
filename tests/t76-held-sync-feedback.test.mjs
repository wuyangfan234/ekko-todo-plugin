// #76: the "sync now" button of a held reply must show a result (saving / saved / still-unsaved / failed),
// errors are not swallowed on that path, and a snapshot dropped by the epoch guard is still judged.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const pkgRoot = new URL('../', import.meta.url).pathname
const settlePath = join(pkgRoot, 'src/client/stream-settle.js')
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
  workDir = mkdtempSync(join(tmpdir(), 'ekko-t76-'))
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
    alias: { dompurify: purifyStub },
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  renderPane = (await import(pathToFileURL(out).href)).render
  return renderPane
}
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

const chief = (text, createdAt = 5000, hostMessageId = '') => ({ id: `m-${createdAt}-${hostMessageId}`, kind: 'chief', text, createdAt, hostMessageId, tools: [], attachments: [] })
const topicOf = (messages = []) => ({ id: 'topic-A', title: '话题', messages, autopilot: true, projectId: '', createdAt: 1, updatedAt: 1, isRunning: false })
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
const held = { topicId: 'topic-A', text: '答案', startedAt: 1000, endedAt: 2000, hostBoundary: null }
const renderWith = async (heldReply, heldSync) => {
  globalThis.localStorage = new MemoryStorage()
  try {
    const render = await loadRenderer()
    return render(paneProps(topicOf([]), { heldReply, heldSync }))
  } finally {
    delete globalThis.localStorage
  }
}
const pending = { text: '最终答案第一行', status: 'pending' }
const retryTag = html => html.match(/<button[^>]*data-testid="held-reply-retry"[^>]*>/)?.[0] || ''

test('a: the reply now in the saved list → saved', () => {
  const { heldSyncOutcome } = settle
  assert.equal(typeof heldSyncOutcome, 'function')
  const out = heldSyncOutcome({ held, before: [], after: [chief('答案')], error: null })
  assert.equal(out.state, 'saved')
  assert.equal(typeof out.reason, 'string')
})

test('b: the saved list still lacks the reply → still-unsaved', () => {
  const out = settle.heldSyncOutcome({ held, before: [], after: [], error: null })
  assert.equal(out.state, 'still-unsaved')
  assert.ok(out.reason.length > 0)
})

test('c: an RPC error → failed with the real error text', () => {
  const out = settle.heldSyncOutcome({ held, before: [], after: [], error: new Error('boom') })
  assert.equal(out.state, 'failed')
  assert.match(out.reason, /boom/)
})

test('d: a very long error text is cut to at most 200 characters', () => {
  const out = settle.heldSyncOutcome({ held, before: [], after: [], error: new Error('E'.repeat(5000)) })
  assert.equal(out.state, 'failed')
  assert.ok(out.reason.length <= 200, `reason length ${out.reason.length}`)
  assert.match(out.reason, /^E{50}/)
})

test('epoch-dropped snapshot is judged, reported as stale, never as failed', () => {
  const stale = settle.heldSyncOutcome({ held, before: [], after: [], error: null, applied: false })
  assert.equal(stale.state, 'still-unsaved')
  assert.match(stale.reason, /快照已过期/)
  const staleButSaved = settle.heldSyncOutcome({ held, before: [], after: [chief('答案')], error: null, applied: false })
  assert.equal(staleButSaved.state, 'still-unsaved', 'not shown as saved until the page has that snapshot')
  assert.match(staleButSaved.reason, /快照已过期/)
})

test('e: while syncing the button says 同步中… and is disabled', async () => {
  const html = await renderWith(pending, { state: 'saving', reason: '' })
  const btn = retryTag(html)
  assert.ok(btn, 'button present')
  assert.match(btn, /disabled/)
  assert.match(html, /data-testid="held-reply-retry"[^>]*>同步中…</)
  assert.match(html, /data-sync-state="saving"/)
})

test('f: failed shows the real reason and the button can be clicked again', async () => {
  const outcome = settle.heldSyncOutcome({ held, before: [], after: [], error: new Error('rpc timeout: sync-topic-session') })
  const html = await renderWith(pending, outcome)
  assert.match(html, /同步失败：rpc timeout: sync-topic-session/)
  assert.match(html, /data-testid="held-reply-sync-result"[^>]*data-sync-state="failed"|data-sync-state="failed"[^>]*data-testid="held-reply-sync-result"/)
  const btn = retryTag(html)
  assert.ok(btn, 'button present')
  assert.doesNotMatch(btn, /disabled/)
  assert.match(html, /最终答案第一行/, 'held text kept')
})

test('g: saved shows 已同步', async () => {
  const outcome = settle.heldSyncOutcome({ held, before: [], after: [chief('答案')], error: null })
  const html = await renderWith(null, outcome)
  assert.match(html, /已同步/)
  assert.match(html, /data-sync-state="saved"/)
})

test('h: still-unsaved never says 已同步 and keeps the held text on screen', async () => {
  const outcome = settle.heldSyncOutcome({ held, before: [], after: [], error: null })
  const html = await renderWith(pending, outcome)
  assert.doesNotMatch(html, /已同步/)
  assert.match(html, /最终答案第一行/)
  assert.match(html, /还没同步上，稍后会自动再试/)
  assert.match(html, /data-sync-state="still-unsaved"/)
  assert.doesNotMatch(retryTag(html), /disabled/)
})

test('pending wording no longer says the reply needs saving; syncing wording unchanged', async () => {
  const html = await renderWith(pending, null)
  assert.match(html, /这条回复还在同步，页面会自动重试/)
  assert.doesNotMatch(html, /还没保存到对话记录/)
  assert.match(retryTag(html), /data-testid="held-reply-retry"/)
  assert.match(html, />立即同步</)
  assert.equal(settle.HELD_REPLY_PENDING_AFTER_MS, 8000)
})

test('click on a fake host whose saved list still lacks the reply ends in a visible result', async () => {
  const { runHeldSync } = settle
  assert.equal(typeof runHeldSync, 'function')
  const states = []
  // Fake host: sync-topic-session succeeds and returns a snapshot whose saved list has no such reply.
  const host = { calls: 0, async call(name, input) { this.calls += 1; assert.equal(name, 'sync-topic-session'); return { topics: [topicOf([chief('旧消息', 10)])], projects: [] } } }
  const sync = async () => {
    try { return { applied: true, next: await host.call('sync-topic-session', { topicId: 'topic-A' }), error: null } } catch (error) { return { applied: false, next: null, error } }
  }
  const out = await runHeldSync({ held, before: [], sync, onState: s => states.push(s) })
  assert.equal(host.calls, 1)
  assert.deepEqual(states.map(s => s.state), ['saving', 'still-unsaved'])
  assert.equal(out.state, 'still-unsaved')
  const html = await renderWith(pending, out)
  assert.match(html, /data-testid="held-reply-sync-result"/, 'a visible result after the click')
  assert.match(html, /还没同步上，稍后会自动再试/)

  // Same click when the host throws: the error reaches the screen.
  const failing = async () => ({ applied: false, next: null, error: new Error('host offline') })
  const failed = await runHeldSync({ held, before: [], sync: failing, onState: () => {} })
  assert.equal(failed.state, 'failed')
  assert.match(await renderWith(pending, failed), /同步失败：host offline/)
})

test('App wires the retry to a judged outcome instead of a fire-and-forget sync', () => {
  const app = readFileSync(join(pkgRoot, 'src/client/App.jsx'), 'utf8')
  const start = app.indexOf('const retryHeldSync = useCallback(')
  assert.ok(start > 0)
  const body = app.slice(start, app.indexOf('}, [', start))
  assert.doesNotMatch(body, /void syncActiveTopic\(/, 'the sync result is awaited')
  assert.match(body, /runHeldSync\(/)
  assert.match(app, /heldSync=\{/)
  // The background polling path keeps swallowing errors.
  const sync = app.slice(app.indexOf('const syncActiveTopic = useCallback('), app.indexOf('const syncActiveTopic = useCallback(') + 700)
  assert.match(sync, /ignore transient reconnect sync errors/)
})

// The thinking box shows the model's reasoning only. The host's status line (`thinking.delta`, e.g.
// "(◕‿◕) pondering...") goes to the running status bar under the stream, not into the reasoning text.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const pkgRoot = new URL('../', import.meta.url).pathname
const eventsPath = join(pkgRoot, 'src/client/stream-events.js')
// Loaded lazily so that code without the module fails each assertion instead of the whole file import.
const events = existsSync(eventsPath) ? await import(pathToFileURL(eventsPath).href) : {}

const REASONING = '先核对基线，再看两条事件各自的来源。'
const STATUS = '(◕‿◕) pondering...'

const newBuf = () => ({ text: '', reasoning: '', status: '', tools: [], usage: null, startedAt: 0, connected: true, isWorking: false, queueLength: 0, loop: null })
const feed = (buf, list) => list.map(evt => events.applyStreamEvent(buf, evt))

let renderPane = null
let workDir = ''
async function loadRenderer() {
  if (renderPane) return renderPane
  workDir = mkdtempSync(join(tmpdir(), 'ekko-thinking-'))
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

const paneProps = liveStream => {
  const topic = { id: 'topic-A', title: '话题', messages: [], autopilot: true, projectId: '', createdAt: 1, updatedAt: 1, isRunning: true }
  return {
    ctx: { ui: { notify() {} } },
    state: { agents: [], projects: [], todos: [], topics: [topic], settings: {} },
    topic,
    projects: [],
    todos: [],
    liveStream,
    busy: false,
    composerFocusSeq: 0,
    onSendMessage() {},
  }
}
const unescape = s => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const thinkingTextOf = html => {
  const m = html.match(/<pre class="ot-thinking-pre">([\s\S]*?)<\/pre>/)
  return m ? unescape(m[1]) : null
}
const statusBarOf = html => {
  const m = html.match(/<div class="ot-streaming-bar">([\s\S]*?)<\/div>/)
  return m ? unescape(m[1].replace(/<[^>]+>/g, '')) : null
}

test('reasoning.delta then a thinking.delta status line: the reasoning text holds the reasoning only', () => {
  assert.equal(typeof events.applyStreamEvent, 'function')
  const buf = newBuf()
  const changed = feed(buf, [
    { event: 'reasoning.delta', data: { text: REASONING } },
    { event: 'thinking.delta', data: { text: STATUS } },
  ])
  assert.deepEqual(changed, [true, true])
  assert.equal(buf.reasoning, REASONING)
  assert.ok(!buf.reasoning.includes('pondering'), 'the status line is not part of the reasoning text')
  assert.equal(buf.status, STATUS)
  assert.equal(buf.isWorking, true)
})

test('a status line that arrives first does not open the reasoning text either', () => {
  assert.equal(typeof events.applyStreamEvent, 'function')
  const buf = newBuf()
  feed(buf, [{ event: 'thinking.delta', data: { text: STATUS } }])
  assert.equal(buf.reasoning, '')
  assert.equal(buf.status, STATUS)
  assert.equal(buf.isWorking, true, 'a status line still marks the turn as running')
  assert.ok(buf.startedAt > 0)
})

test('a newer status line replaces the older one; it is not appended', () => {
  assert.equal(typeof events.applyStreamEvent, 'function')
  const buf = newBuf()
  feed(buf, [
    { event: 'thinking.delta', data: { text: STATUS } },
    { event: 'thinking.delta', data: { delta: '  (｡◕‿◕｡) mulling...\n' } },
  ])
  assert.equal(buf.status, '(｡◕‿◕｡) mulling...')
  assert.equal(buf.reasoning, '')
})

test('an empty thinking.delta is ignored: nothing changes and no flush is asked for', () => {
  assert.equal(typeof events.applyStreamEvent, 'function')
  const buf = newBuf()
  feed(buf, [{ event: 'reasoning.delta', data: { text: REASONING } }, { event: 'thinking.delta', data: { text: STATUS } }])
  const before = JSON.stringify(buf)
  assert.deepEqual(feed(buf, [
    { event: 'thinking.delta', data: { text: '' } },
    { event: 'thinking.delta', data: { text: '   ' } },
    { event: 'thinking.delta', data: {} },
  ]), [false, false, false])
  assert.equal(JSON.stringify(buf), before)
})

test('the status line is dropped once reasoning, answer text or a tool call arrives', () => {
  assert.equal(typeof events.applyStreamEvent, 'function')
  for (const next of [
    { event: 'reasoning.delta', data: { text: REASONING } },
    { event: 'message.delta', data: { delta: '结论：' } },
    { event: 'tool.started', data: { callId: 'c1', name: 'read_file' } },
  ]) {
    const buf = newBuf()
    feed(buf, [{ event: 'thinking.delta', data: { text: STATUS } }, next])
    assert.equal(buf.status, '', `cleared by ${next.event}`)
  }
})

// Control: these paths are not touched by the fix and behave as before.
test('control: reasoning.delta chunks still accumulate, answer text and tools are untouched', () => {
  assert.equal(typeof events.applyStreamEvent, 'function')
  const buf = newBuf()
  feed(buf, [
    { event: 'reasoning.delta', data: { text: '第一段。' } },
    { event: 'reasoning.delta', data: { delta: '第二段。' } },
    { event: 'message.delta', data: { delta: '答案' } },
    { event: 'tool.started', data: { callId: 'c1', name: 'read_file' } },
    { event: 'tool.completed', data: { callId: 'c1' } },
  ])
  assert.equal(buf.reasoning, '第一段。第二段。')
  assert.equal(buf.text, '答案')
  assert.deepEqual(buf.tools, [{ callId: 'c1', name: 'read_file', status: 'done' }])
})

test('rendered: the thinking box shows the reasoning once; the status line is in the running status bar', async () => {
  assert.equal(typeof events.applyStreamEvent, 'function')
  const render = await loadRenderer()
  const buf = newBuf()
  // The order the host really uses within one model call: status line first, then the reasoning stream,
  // then the status line of the next step.
  feed(buf, [
    { event: 'thinking.delta', data: { text: '(·_·) thinking...' } },
    { event: 'reasoning.delta', data: { text: REASONING } },
    { event: 'thinking.delta', data: { text: STATUS } },
  ])
  const html = render(paneProps({ ...buf, tools: [...buf.tools] }))
  assert.ok(html.includes('data-testid="live-stream-block"'), 'live block rendered')
  assert.equal(html.split('ot-thinking-pre').length - 1, 1, 'one thinking box')
  assert.equal(thinkingTextOf(html), REASONING)
  assert.equal(statusBarOf(html)?.startsWith(STATUS), true, `status bar shows the status line, got: ${statusBarOf(html)}`)
  assert.equal(unescape(html).split('pondering').length - 1, 1, 'the status line is on screen once')
  assert.ok(!unescape(html).includes('(·_·) thinking...'), 'the replaced status line is gone')
})

test('rendered: a running tool still wins the status bar; without a status line the wording is the old one', async () => {
  assert.equal(typeof events.applyStreamEvent, 'function')
  const render = await loadRenderer()

  const plain = newBuf()
  feed(plain, [{ event: 'reasoning.delta', data: { text: REASONING } }])
  const plainHtml = render(paneProps(plain))
  assert.equal(thinkingTextOf(plainHtml), REASONING)
  assert.equal(statusBarOf(plainHtml)?.startsWith('正在推理与拆解方案...'), true)

  const idle = render(paneProps(newBuf()))
  assert.equal(statusBarOf(idle)?.startsWith('大总管正在响应...'), true)

  const onlyStatus = newBuf()
  feed(onlyStatus, [{ event: 'thinking.delta', data: { text: STATUS } }])
  const onlyStatusHtml = render(paneProps(onlyStatus))
  assert.equal(thinkingTextOf(onlyStatusHtml), null, 'no thinking box for a status line alone')
  assert.equal(statusBarOf(onlyStatusHtml)?.startsWith(STATUS), true)

  // A stale status next to a running tool cannot come from the reducer; the view still prefers the tool.
  const tool = { ...newBuf(), isWorking: true, status: STATUS, tools: [{ callId: 'c1', name: 'read_file', status: 'running' }] }
  assert.equal(statusBarOf(render(paneProps(tool)))?.startsWith('正在调用工具 read_file...'), true)
})

test('App.jsx feeds the stream through the shared reducer and passes the status line to the view', () => {
  const app = readFileSync(join(pkgRoot, 'src/client/App.jsx'), 'utf8')
  assert.match(app, /import \{ applyStreamEvent \} from '\.\/stream-events\.js'/)
  assert.ok(!/const applyStreamEvent\s*=/.test(app), 'no second copy of the reducer inside App.jsx')
  assert.match(app, /EMPTY_STREAM = Object\.freeze\(\{[^}]*\bstatus: ''/)
  assert.match(app, /setLiveStream\(\{[^}]*\bstatus: cur\.status\b/)
  // Every place that wipes the reasoning text at a turn boundary wipes the status line too.
  assert.equal(app.split("buf.reasoning = ''").length, app.split("buf.status = ''").length)
})

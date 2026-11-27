// #81: the thinking box still showed the same reasoning twice on 0.9.53+.
// The 0.9.53 fix (#52) emptied the box only when a `thinking.delta` line said "retrying" / "trying fallback" /
// "next pool credential". On the real host:
// - retry/fallback lines go out as `status.update` ({kind, text}), not `thinking.delta`;
// - they are buffered and dropped when the retry succeeds (agent._clear_status_buffer()), so a successful
//   empty-response retry sends no line at all; only a final failure flushes them;
// - the immediate reconnect notices that do use `thinking.delta` say "reconnecting", not "retrying".
// So the client must also recognise the replay itself: a reasoning stream that starts over from the start.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { applyStreamEvent, REPLAY_MIN_CHARS, REPLAY_MIN_WHOLE, REPLAY_MIN_RATIO } from '../src/client/stream-events.js'

const BASE = '先核对基线，再看两条事件各自的来源。'
const newBuf = () => ({ text: '', reasoning: '', status: '', tools: [], usage: null, startedAt: 0, connected: true, isWorking: false, queueLength: 0, loop: null })
const feed = (buf, list) => list.map(evt => applyStreamEvent(buf, evt))
const reasoning = text => ({ event: 'reasoning.delta', data: { text } })
const thinking = text => ({ event: 'thinking.delta', data: { text } })
const statusUpdate = (kind, text) => ({ event: 'status.update', data: { kind, text } })
const chunksOf = (s, n) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out }

// ── a) empty-response retry that succeeded: the host sends no status line at all ──
test('repro a: a successful empty-response retry with no status line leaves the reasoning once (length x1, not x2)', () => {
  const buf = newBuf()
  feed(buf, [reasoning(BASE), reasoning(BASE)])
  assert.equal(buf.reasoning, BASE)
  assert.equal(buf.reasoning.length, BASE.length)
})

test('repro a: replay split on different chunk boundaries than the first attempt (partial overlap across chunks)', () => {
  const buf = newBuf()
  feed(buf, [...chunksOf(BASE, 4).map(reasoning), ...chunksOf(BASE, 3).map(reasoning)])
  assert.equal(buf.reasoning, BASE)
  const long = `${BASE}然后按宿主真实事件形态补用例，确认修复前失败、修复后通过。`
  const b2 = newBuf()
  feed(b2, [...chunksOf(long, 5).map(reasoning), ...chunksOf(long, 7).map(reasoning)])
  assert.equal(b2.reasoning, long)
})

test('repro a: attempt 1 stopped part-way, attempt 2 streams the whole reasoning and goes on', () => {
  const full = `${BASE}第二句：比对 status.update 与 thinking.delta。第三句：写结论。`
  const cut = full.slice(0, 30)
  const buf = newBuf()
  feed(buf, [...chunksOf(cut, 6).map(reasoning), ...chunksOf(full, 6).map(reasoning)])
  assert.equal(buf.reasoning, full)
})

test('repro a: a single replay chunk that holds all of the old reasoning and more replaces it', () => {
  const buf = newBuf()
  feed(buf, [reasoning(BASE), reasoning(`${BASE}接着往下想。`)])
  assert.equal(buf.reasoning, `${BASE}接着往下想。`)
})

test('repro a: the replay of attempt 2 keeps appending normally once it is recognised', () => {
  const buf = newBuf()
  feed(buf, [reasoning(BASE), reasoning(BASE), reasoning('再补一句。')])
  assert.equal(buf.reasoning, `${BASE}再补一句。`)
})

test('thresholds are the documented ones', () => {
  assert.equal(REPLAY_MIN_CHARS, 32)
  assert.equal(REPLAY_MIN_WHOLE, 8)
  assert.equal(REPLAY_MIN_RATIO, 0.5)
})

// ── controls: ordinary reasoning must not be cut ──
test('control: a repeated short phrase inside the reasoning is kept', () => {
  const buf = newBuf()
  const parts = ['我们需要', '先看配置。', '我们需要', '再看日志。', '好的', '好的']
  feed(buf, parts.map(reasoning))
  assert.equal(buf.reasoning, parts.join(''))
})

test('control: a later step that opens with the same words but goes elsewhere is kept whole', () => {
  const opening = 'Let me check the plugin manifest and '
  const step1 = `${opening}the version field first.`
  const step2 = `${opening.slice(0, 20)}stream events next, then the tests.`
  const buf = newBuf()
  feed(buf, [...chunksOf(step1, 5).map(reasoning), ...chunksOf(step2, 5).map(reasoning)])
  assert.equal(buf.reasoning, step1 + step2)
})

test('control: multi-step reasoning that quotes less than the threshold of its opening is not truncated', () => {
  const head = '第一步：核对基线版本号是否一致'
  const buf = newBuf()
  const text = `${head}。第二步：读代码。第三步：回到「${head}」这一结论，并展开。`
  // chunk boundary lands exactly on the quoted opening
  const i = text.indexOf(head, 1)
  feed(buf, [reasoning(text.slice(0, i)), reasoning(text.slice(i, i + 8)), reasoning(text.slice(i + 8))])
  assert.equal(buf.reasoning, text)
})

test('control: very short reasoning followed by the same short text is kept (below the whole-replay floor)', () => {
  const buf = newBuf()
  feed(buf, [reasoning('嗯。'), reasoning('嗯。')])
  assert.equal(buf.reasoning, '嗯。嗯。')
})

test('control: a pending replay that diverges is kept as normal text', () => {
  const buf = newBuf()
  const a = `${BASE}后面还有很长的一段，用来让前缀超过三十二个字符的阈值。`
  feed(buf, [reasoning(a), reasoning(BASE.slice(0, 10)), reasoning('——不过换个角度。')])
  assert.equal(buf.reasoning, `${a}${BASE.slice(0, 10)}——不过换个角度。`)
})

test('the replay tracker survives an outside reset of buf.reasoning (resumed/run.started)', () => {
  const buf = newBuf()
  const long = `${BASE}后面还有很长的一段，用来让前缀超过三十二个字符的阈值。`
  feed(buf, [reasoning(long), reasoning(BASE.slice(0, 6))])
  buf.reasoning = '' // App.jsx resets on run.started / resumed
  feed(buf, [reasoning('全新回合的思考，与上一轮无关。')])
  assert.equal(buf.reasoning, '全新回合的思考，与上一轮无关。')
})

// ── b) retry status on the real channel ──
test('repro b: status.update retry line empties the thinking box and only goes to the status bar', () => {
  const buf = newBuf()
  const line = '⚠️ Empty response from model — retrying (1/3) in 5.8s'
  const changed = feed(buf, [reasoning(BASE), statusUpdate('status', line)])
  assert.deepEqual(changed, [true, true])
  assert.equal(buf.reasoning, '')
  assert.equal(buf.status, line)
  feed(buf, [reasoning('第二次尝试的不同思考。')])
  assert.equal(buf.reasoning, '第二次尝试的不同思考。', 'a different second attempt is not appended to the first')
  assert.ok(!buf.reasoning.includes('retrying'))
})

test('status.update attempt kinds: the whitelisted kinds with attempt wording empty the box', () => {
  const cases = [
    ['status', '⚠️ Empty response from model — retrying (1/3) in 5.8s'],
    ['lifecycle', '⚠️ Max retries (3) exhausted — trying fallback...'],
    ['warn', '🔄 Codex soft failure (x) — switched to the next pool credential, retrying...'],
    ['lifecycle', '⚠️ No first stream event from provider in 30s (codex stream, model: x). Reconnecting.'],
    ['lifecycle', '⚠️ Model returning empty responses — switching to fallback provider...'],
    ['lifecycle', '🗜️ Compressed 1,000 → 500 payload bytes, retrying...'],
  ]
  for (const [kind, line] of cases) {
    const buf = newBuf()
    feed(buf, [reasoning(BASE), statusUpdate(kind, line)])
    assert.equal(buf.reasoning, '', `boundary: ${kind} / ${line}`)
    assert.equal(buf.status, line)
  }
})

test('status.update kind "fallback" is a new attempt whatever the wording', () => {
  const buf = newBuf()
  feed(buf, [reasoning(BASE), statusUpdate('fallback', '↻ Switched to fallback: gpt-x (openai)')])
  assert.equal(buf.reasoning, '')
})

test('control: ordinary status.update lines show in the status bar and leave the thinking box alone', () => {
  const cases = [
    ['compacting', 'Compressing context (42 messages)...'],
    ['compacting', 'Compressing context, retrying...'], // compaction progress never clears, whatever the words
    ['compacted', 'Context compacted.'],
    ['lifecycle', 'Session is free; loading the latest transcript...'],
    ['status', '📈 Context window grown to 256K'],
    ['warn', '❌ API failed after 4 attempts and retrying won\'t help.'],
    ['lifecycle', '↻ Thinking-only response — requesting completion (1/2)'],
  ]
  for (const [kind, line] of cases) {
    const buf = newBuf()
    feed(buf, [reasoning(BASE), statusUpdate(kind, line)])
    assert.equal(buf.reasoning, BASE, `not a boundary: ${kind} / ${line}`)
    assert.equal(buf.status, line)
  }
})

test('status.update: empty text is ignored; text falls back to kind like the host does', () => {
  const buf = newBuf()
  feed(buf, [reasoning(BASE)]) // a turn is running
  assert.equal(applyStreamEvent(buf, statusUpdate('status', '   ')), false)
  assert.equal(buf.status, '')
  assert.equal(applyStreamEvent(buf, { event: 'status.update', data: { kind: 'Loading tools...' } }), true)
  assert.equal(buf.status, 'Loading tools...')
})

// ── review P1/P1b: the host also sends status.update between turns ──
test('P1: an idle buffer ignores status.update (ready after manual compaction / busy lock, compacted)', () => {
  for (const [kind, text] of [
    ['status', 'ready'],
    ['compacted', '✓ Context compression complete'],
    ['compacting', 'Compressing context (42 messages)...'],
    ['fallback', '↻ Switched to fallback: gpt-x (openai)'],
  ]) {
    const buf = newBuf()
    buf.status = 'kept'
    buf.reasoning = '上一回合留下的思考'
    const changed = applyStreamEvent(buf, statusUpdate(kind, text))
    assert.equal(changed, false, `${kind}: no change reported`)
    assert.equal(buf.isWorking, false, `${kind}: stays idle`)
    assert.equal(buf.startedAt, 0, `${kind}: startedAt untouched`)
    assert.equal(buf.status, 'kept', `${kind}: status untouched`)
    assert.equal(buf.reasoning, '上一回合留下的思考', `${kind}: reasoning untouched`)
  }
  const bare = newBuf()
  assert.equal(applyStreamEvent(bare, { event: 'status.update', data: { kind: 'ready' } }), false)
  assert.equal(bare.isWorking, false)
})

test('P1b: while running, ready only takes the status line down and the run stays running', () => {
  const buf = newBuf()
  feed(buf, [reasoning(BASE), statusUpdate('compacting', 'Compressing context (42 messages)...')])
  const startedAt = buf.startedAt
  assert.equal(buf.status, 'Compressing context (42 messages)...')
  assert.equal(applyStreamEvent(buf, statusUpdate('status', 'ready')), true)
  assert.equal(buf.status, '', 'ready is not shown')
  assert.equal(buf.isWorking, true)
  assert.equal(buf.startedAt, startedAt)
  assert.equal(buf.reasoning, BASE)
  assert.equal(applyStreamEvent(buf, statusUpdate('status', ' ready ')), false, 'a second ready changes nothing')
})

test('P1: while running, compaction progress updates the status bar and leaves the reasoning', () => {
  const buf = newBuf()
  feed(buf, [reasoning(BASE)])
  for (const [kind, text] of [['compacting', 'Compressing context (42 messages)...'], ['compacted', '✓ Context compression complete']]) {
    assert.equal(applyStreamEvent(buf, statusUpdate(kind, text)), true)
    assert.equal(buf.status, text)
    assert.equal(buf.reasoning, BASE)
    assert.equal(buf.isWorking, true)
  }
})

// ── review P2: a long reasoning that quotes its own opening must not be cut ──
const OPENING = '先确认插件版本与宿主版本是否一致，再逐条比对两条事件通道的来源与时序。' // 36 units
function p2Text() {
  let pre = `${OPENING}第一步读 stream-events.js，第二步读宿主 status_output.py 的缓冲逻辑，第三步看 Studio 中继有没有转发。`
  while (pre.length % 3) pre += '。'
  let mid = `${pre}回到`
  while (mid.length % 3) mid += '—'
  return { text: `${mid}${OPENING}这一步现在可以下结论了，接着写测试与报告，并把阈值写进注释里。`, quoteAt: mid.length }
}

test('P2 control: a 197-unit reasoning that quotes its >=32-unit opening mid-way, in 3-unit chunks, is kept whole', () => {
  let { text, quoteAt } = p2Text()
  while (text.length < 197) text += '。'
  text = text.slice(0, 197)
  assert.equal(text.length, 197)
  assert.equal(quoteAt % 3, 0, 'the quote starts on a chunk boundary')
  assert.equal(text.slice(quoteAt, quoteAt + OPENING.length), OPENING)
  assert.ok(OPENING.length >= REPLAY_MIN_CHARS)
  const buf = newBuf()
  feed(buf, chunksOf(text, 3).map(reasoning))
  assert.equal(buf.reasoning.length, 197)
  assert.equal(buf.reasoning, text)
})

test('control: an 8-20 unit reasoning followed by a much longer chunk that opens with it keeps both', () => {
  for (const head of ['先核对基线版本。', '先核对一下插件的基线版本号再说。']) {
    assert.ok(head.length >= 8 && head.length <= 20)
    const chunk = `${head}然后展开很长的一段新的思考内容，篇幅远超开头那句话，至少是它的两倍以上长度。`
    const buf = newBuf()
    feed(buf, [reasoning(head), reasoning(chunk)])
    assert.equal(buf.reasoning, head + chunk, `kept: ${head}`)
  }
})

test('P2 control: a real long retry (exact copy, different chunk sizes) still leaves one copy', () => {
  let { text } = p2Text()
  while (text.length < 197) text += '。'
  text = text.slice(0, 197)
  for (const [a, b] of [[3, 5], [7, 2], [4, 4]]) {
    const buf = newBuf()
    feed(buf, [...chunksOf(text, a).map(reasoning), ...chunksOf(text, b).map(reasoning)])
    assert.equal(buf.reasoning, text, `chunks ${a}/${b}`)
  }
})

// ── c) reconnect notices on thinking.delta ──
test('repro c: reconnect notices on thinking.delta are attempt boundaries', () => {
  for (const line of [
    '⚠ no response from provider in 30s — reconnecting...',
    '⚠️ Codex stream opened but made no model progress for 60s (model: x). Reconnecting.',
  ]) {
    const buf = newBuf()
    feed(buf, [reasoning(BASE), thinking(line)])
    assert.equal(buf.reasoning, '', `boundary: ${line}`)
    assert.equal(buf.status, line)
  }
})

// ── rendered: what the pane shows (server-rendered ChatPane markup) ──
const pkgRoot = new URL('../', import.meta.url).pathname
let workDir = ''
async function loadRenderer() {
  workDir = mkdtempSync(join(tmpdir(), 'ekko-replay-'))
  const entry = join(workDir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import { ChatPane } from ${JSON.stringify(join(pkgRoot, 'src/client/components/ChatPane.jsx'))}`,
    `export function render(props) { return renderToStaticMarkup(React.createElement(ChatPane, props)) }`,
  ].join('\n'))
  const purifyStub = join(workDir, 'purify-stub.mjs')
  writeFileSync(purifyStub, 'export default { sanitize: html => html, addHook() {}, removeHook() {} }\n')
  const out = join(workDir, 'bundle.mjs')
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'text' }, nodePaths: [join(pkgRoot, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', alias: { dompurify: purifyStub },
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  return (await import(pathToFileURL(out).href)).render
}
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })
const paneProps = liveStream => {
  const topic = { id: 'topic-A', title: '话题', messages: [], autopilot: true, projectId: '', createdAt: 1, updatedAt: 1, isRunning: true }
  return { ctx: { ui: { notify() {} } }, state: { agents: [], projects: [], todos: [], topics: [topic], settings: {} }, topic, projects: [], todos: [], liveStream, busy: false, composerFocusSeq: 0, onSendMessage() {} }
}
const unescape = s => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const thinkingTextOf = html => { const m = html.match(/<pre class="ot-thinking-pre">([\s\S]*?)<\/pre>/); return m ? unescape(m[1]) : null }
const statusBarOf = html => { const m = html.match(/<div class="ot-streaming-bar">([\s\S]*?)<\/div>/); return m ? unescape(m[1].replace(/<[^>]+>/g, '')) : null }

test('rendered: silent retry shows the reasoning once; a status.update retry line shows in the status bar only', async () => {
  const render = await loadRenderer()
  const buf = newBuf()
  feed(buf, [...chunksOf(BASE, 4).map(reasoning), ...chunksOf(BASE, 5).map(reasoning)])
  let html = render(paneProps({ ...buf, tools: [] }))
  assert.equal(thinkingTextOf(html), BASE, 'thinking box holds one copy')
  assert.equal(html.split(BASE).length - 1, 1)

  const line = '⚠️ Empty response from model — retrying (1/3) in 5.8s'
  feed(buf, [statusUpdate('status', line)])
  html = render(paneProps({ ...buf, tools: [] }))
  assert.ok(statusBarOf(html).includes(line), 'status bar shows the latest status.update')
  assert.equal(html.split(BASE).length - 1, 0, 'the superseded attempt left the thinking box')

  const b2 = newBuf()
  feed(b2, [reasoning(BASE), statusUpdate('compacting', 'Compressing context (42 messages)...')])
  html = render(paneProps({ ...b2, tools: [] }))
  assert.equal(thinkingTextOf(html), BASE, 'compaction progress keeps the thinking box')
  assert.ok(statusBarOf(html).includes('Compressing context (42 messages)...'))
})

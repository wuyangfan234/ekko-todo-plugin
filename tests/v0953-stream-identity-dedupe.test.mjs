// A turn's frames can reach the client more than once (reconnect replay, a superseded attempt that
// re-streams what it already sent, a second socket). The host stamps `message.start` / `message.delta` /
// `message.interim` with `turn_id` + `segment` + `offset` (UTF-16 code units); the client upserts by that
// identity and drops what it already has. `reasoning.delta` carries no identity, so the host's
// retry / fallback / credential-switch status line marks the start of a new attempt and empties the
// thinking box. Frames without (or with malformed) identity are appended as before.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const pkgRoot = new URL('../', import.meta.url).pathname
const eventsPath = join(pkgRoot, 'src/client/stream-events.js')
const events = existsSync(eventsPath) ? await import(pathToFileURL(eventsPath).href) : {}

const newBuf = () => ({ text: '', reasoning: '', status: '', tools: [], usage: null, startedAt: 0, connected: true, isWorking: false, queueLength: 0, loop: null })
const feed = (buf, list) => list.map(evt => events.applyStreamEvent(buf, evt))
const reasoning = text => ({ event: 'reasoning.delta', data: { text } })
const status = text => ({ event: 'thinking.delta', data: { text } })
const charsOf = s => [...s]

// Deltas of one segment the way the host stamps them: offset = UTF-16 units already sent in the segment.
function stamped(turnId, segment, chunks, startOffset = 0) {
  let offset = startOffset
  return chunks.map(delta => {
    const evt = { event: 'message.delta', data: { delta, turn_id: turnId, segment, offset } }
    offset += delta.length
    return evt
  })
}

const BASE = '先核对基线'
const RETRY = '⚠️ Empty response from model — retrying (1/3) in 5.8s'

// ---------- 1. attempt boundary of the thinking box ----------

test('repro: a retry status line between two identical reasoning streams leaves the reasoning once (10 -> 5 chars)', () => {
  const buf = newBuf()
  feed(buf, [...charsOf(BASE).map(reasoning), status(RETRY), ...charsOf(BASE).map(reasoning)])
  assert.equal(buf.reasoning, BASE)
  assert.equal(buf.reasoning.length, 5)
  assert.equal(buf.status, '', 'the next reasoning chunk took the status line down, as before')
})

test('the retry status line itself goes to the status bar and empties the thinking box, never into it', () => {
  const buf = newBuf()
  const changed = feed(buf, [reasoning(BASE), status(RETRY)])
  assert.deepEqual(changed, [true, true])
  assert.equal(buf.reasoning, '', 'the superseded attempt\'s reasoning is dropped at the boundary')
  assert.equal(buf.status, RETRY)
  assert.ok(!buf.text.includes('retrying'))
})

test('fallback, max-retries and pool-credential lines are attempt boundaries too', () => {
  for (const line of [
    '⚠️ Rate limited — trying fallback...',
    '⚠️ Max retries (3) exhausted — trying fallback...',
    '🔄 Codex soft failure (empty_output) — switched to the next pool credential, retrying...',
    '⚠️ Empty response from model — retrying (3/3) in 12s',
  ]) {
    const buf = newBuf()
    feed(buf, [reasoning(BASE), status(line), reasoning(BASE)])
    assert.equal(buf.reasoning, BASE, `boundary: ${line}`)
  }
})

test('control: an ordinary status line or a "retrying won\'t help" notice does not touch the reasoning', () => {
  for (const line of ['(◕‿◕) pondering...', 'Provider rejected the request and retrying won\'t help']) {
    const buf = newBuf()
    feed(buf, [reasoning(BASE), status(line), reasoning('。')])
    assert.equal(buf.reasoning, `${BASE}。`, `not a boundary: ${line}`)
  }
})

// ---------- 2. identity-based upsert of the reply ----------

test('a full re-send of the same stamped frames (second socket / replay) paints the reply once', () => {
  const buf = newBuf()
  const frames = stamped('t1', 0, ['结论：', '分支已', '核对完毕。'])
  feed(buf, frames)
  const replay = feed(buf, frames)
  assert.equal(buf.text, '结论：分支已核对完毕。')
  assert.deepEqual(replay, [false, false, false], 'a dropped duplicate asks for no flush')
})

test('a re-sent chunk that straddles what is already applied adds only its new tail', () => {
  const buf = newBuf()
  feed(buf, stamped('t1', 0, ['abc', 'def']))
  feed(buf, [{ event: 'message.delta', data: { delta: 'defgh', turn_id: 't1', segment: 0, offset: 3 } }])
  assert.equal(buf.text, 'abcdefgh')
  feed(buf, [{ event: 'message.delta', data: { delta: 'ij', turn_id: 't1', segment: 0, offset: 8 } }])
  assert.equal(buf.text, 'abcdefghij')
})

test('a superseded attempt re-streaming from offset 0 and then continuing: no copy, the continuation kept', () => {
  const buf = newBuf()
  feed(buf, stamped('t1', 0, ['第一句。', '第二句。']))
  feed(buf, stamped('t1', 0, ['第一句。', '第二句。', '第三句。']))
  assert.equal(buf.text, '第一句。第二句。第三句。')
})

test('a new turn_id resets the whole block (reply and reasoning)', () => {
  const buf = newBuf()
  feed(buf, [reasoning('旧回合的思考'), ...stamped('t1', 0, ['旧回合回复'])])
  feed(buf, [{ event: 'message.start', data: { turn_id: 't2' } }])
  assert.equal(buf.text, '')
  assert.equal(buf.reasoning, '')
  feed(buf, [reasoning('新思考'), ...stamped('t2', 0, ['新回复'])])
  assert.equal(buf.text, '新回复')
  assert.equal(buf.reasoning, '新思考')
  // A delta of yet another turn without a message.start resets as well.
  feed(buf, stamped('t3', 0, ['第三回合']))
  assert.equal(buf.text, '第三回合')
})

test('message.start of the turn already on screen changes nothing', () => {
  const buf = newBuf()
  feed(buf, [{ event: 'message.start', data: { turn_id: 't1' } }, reasoning('思考'), ...stamped('t1', 0, ['回复'])])
  const again = feed(buf, [{ event: 'message.start', data: { turn_id: 't1' } }])
  assert.deepEqual(again, [false])
  assert.equal(buf.text, '回复')
  assert.equal(buf.reasoning, '思考')
})

test('segments: a sealed segment is not repainted by its interim, re-sent seals and old deltas are dropped', () => {
  const buf = newBuf()
  feed(buf, [reasoning('第一步思考'), ...stamped('t1', 0, ['先看', '代码。'])])
  feed(buf, [{ event: 'message.interim', data: { text: '先看代码。', already_streamed: true, turn_id: 't1', segment: 0 } }])
  assert.equal(buf.text, '先看代码。', 'the interim of an already streamed segment is not appended again')
  assert.equal(buf.reasoning, '', 'the seal closes the step; its reasoning leaves the thinking box')
  feed(buf, [reasoning('第二步思考'), ...stamped('t1', 1, ['再改', '实现。'])])
  // replays of the closed segment and its seal
  const late = feed(buf, [
    { event: 'message.interim', data: { text: '先看代码。', already_streamed: true, turn_id: 't1', segment: 0 } },
    ...stamped('t1', 0, ['先看', '代码。']),
    ...stamped('t1', 1, ['再改']),
  ])
  assert.deepEqual(late, [false, false, false, false])
  assert.equal(buf.text, '先看代码。再改实现。')
  assert.equal(buf.reasoning, '第二步思考')
})

test('a stamped interim that was not streamed is shown once (seal adds it, the re-sent seal does not)', () => {
  const buf = newBuf()
  feed(buf, [{ event: 'message.interim', data: { text: '中途说明。', already_streamed: false, turn_id: 't1', segment: 0 } }])
  feed(buf, [{ event: 'message.interim', data: { text: '中途说明。', already_streamed: false, turn_id: 't1', segment: 0 } }])
  feed(buf, stamped('t1', 1, ['最终答复']))
  assert.equal(buf.text, '中途说明。最终答复')
})

test('a gap (missed frame) does not lose later chunks and does not shift the offsets after it', () => {
  const buf = newBuf()
  feed(buf, stamped('t1', 0, ['ab']))
  feed(buf, [{ event: 'message.delta', data: { delta: 'ef', turn_id: 't1', segment: 0, offset: 4 } }])
  feed(buf, [{ event: 'message.delta', data: { delta: 'gh', turn_id: 't1', segment: 0, offset: 6 } }])
  feed(buf, [{ event: 'message.delta', data: { delta: 'efgh', turn_id: 't1', segment: 0, offset: 4 } }])
  assert.equal(buf.text, 'abefgh')
})

// ---------- 3. UTF-16 offsets, long Chinese text, surrogate pairs ----------

test('emoji offsets count UTF-16 code units like the host; overlap inside an emoji keeps it whole', () => {
  const buf = newBuf()
  const full = '好的👍🏽完成🎉！'
  feed(buf, stamped('t1', 0, ['好的👍', '🏽完成']))
  // re-sent chunk starting inside the applied part, covering the rest
  const at = '好的'.length
  feed(buf, [{ event: 'message.delta', data: { delta: full.slice(at), turn_id: 't1', segment: 0, offset: at } }])
  assert.equal(buf.text, full)
  assert.equal(buf.text.length, full.length)
})

test('a surrogate pair split across two chunks is rejoined, and a re-send that starts on the low half is trimmed right', () => {
  const buf = newBuf()
  const full = 'A😀B'
  const hi = full.slice(0, 2) // 'A' + high surrogate
  const lo = full.slice(2) // low surrogate + 'B'
  feed(buf, stamped('t1', 0, [hi, lo]))
  feed(buf, [{ event: 'message.delta', data: { delta: full.slice(2), turn_id: 't1', segment: 0, offset: 2 } }])
  feed(buf, [{ event: 'message.delta', data: { delta: full.slice(1) + 'C', turn_id: 't1', segment: 0, offset: 1 } }])
  assert.equal(buf.text, 'A😀BC')
  assert.equal([...buf.text].length, 4, 'no lone surrogate left behind')
})

test('long Chinese reply delivered twice with random chunking and overlaps is shown exactly once', () => {
  let seed = 7
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const full = Array.from({ length: 3000 }, (_, i) => '会展项目经理核对排期🙂。'[i % 12]).join('')
  const chunksOf = () => {
    const out = []
    for (let i = 0; i < full.length;) { const n = 1 + rand(40); out.push(full.slice(i, i + n)); i += n }
    return out
  }
  const buf = newBuf()
  const first = stamped('t1', 0, chunksOf())
  const second = stamped('t1', 0, chunksOf())
  // interleave the two copies the way two sockets would deliver them
  const mixed = []
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    if (first[i]) mixed.push(first[i])
    if (second[i]) mixed.push(second[i])
  }
  feed(buf, mixed)
  assert.equal(buf.text.length, full.length)
  assert.equal(buf.text, full)
})

// ---------- 4. fallbacks: missing or malformed identity ----------

test('control: deltas without identity are appended exactly as before', () => {
  const buf = newBuf()
  feed(buf, [{ event: 'message.delta', data: { delta: '答' } }, { event: 'message.delta', data: { delta: '答' } }, { event: 'message.interim', data: { text: '中' } }])
  assert.equal(buf.text, '答答中')
})

test('malformed identity never throws and falls back to appending', () => {
  const bad = [
    { turn_id: 't1', segment: 0, offset: '0' },
    { turn_id: 't1', segment: 0, offset: -1 },
    { turn_id: 't1', segment: 0, offset: Number.NaN },
    { turn_id: 't1', segment: 1.5, offset: 0 },
    { turn_id: 't1', segment: null, offset: 0 },
    { turn_id: 123, segment: 0, offset: 0 },
    { turn_id: '', segment: 0, offset: 0 },
    { turn_id: 't1', segment: 0, offset: Infinity },
  ]
  for (const ident of bad) {
    const buf = newBuf()
    assert.doesNotThrow(() => feed(buf, [{ event: 'message.delta', data: { delta: 'x', ...ident } }, { event: 'message.delta', data: { delta: 'x', ...ident } }]))
    assert.equal(buf.text, 'xx', `appended for ${JSON.stringify(ident)}`)
  }
  const buf = newBuf()
  assert.doesNotThrow(() => feed(buf, [
    { event: 'message.start', data: { turn_id: { nested: true } } },
    { event: 'message.interim', data: { text: '中', turn_id: 't1', segment: -2 } },
    { event: 'message.delta', data: null },
    null,
    'message.delta',
  ]))
  assert.equal(buf.text, '中')
})

test('unstamped chunks mixed into a stamped stream are kept and do not break the offsets', () => {
  const buf = newBuf()
  feed(buf, stamped('t1', 0, ['ab']))
  feed(buf, [{ event: 'message.delta', data: { delta: '+' } }])
  feed(buf, [{ event: 'message.delta', data: { delta: 'cd', turn_id: 't1', segment: 0, offset: 2 } }])
  feed(buf, stamped('t1', 0, ['ab', 'cd']))
  assert.equal(buf.text, 'ab+cd')
})

test('an unstamped chunk survives a later seal that rebuilds the reply from its segments', () => {
  const buf = newBuf()
  feed(buf, stamped('t1', 0, ['ab']))
  feed(buf, [{ event: 'message.delta', data: { delta: '+' } }])
  feed(buf, [{ event: 'message.interim', data: { text: '', already_streamed: true, turn_id: 't1', segment: 0 } }])
  feed(buf, stamped('t1', 1, ['cd']))
  assert.equal(buf.text, 'ab+cd')
})

test('deltas arrived without identity, the stamped seal says already streamed: its text is not added again', () => {
  const buf = newBuf()
  feed(buf, [{ event: 'message.delta', data: { delta: '先看' } }, { event: 'message.delta', data: { delta: '代码。' } }])
  feed(buf, [{ event: 'message.interim', data: { text: '先看代码。', already_streamed: true, turn_id: 't1', segment: 0 } }])
  assert.equal(buf.text, '先看代码。')
  // control: not streamed before, so the seal shows it
  const other = newBuf()
  feed(other, [{ event: 'message.delta', data: { delta: '先看代码。' } }])
  feed(other, [{ event: 'message.interim', data: { text: '先看代码。', already_streamed: false, turn_id: 't1', segment: 0 } }])
  assert.equal(other.text, '先看代码。先看代码。')
})

// The host strips the sealed text and decides "already streamed" on whitespace-collapsed text
// (agent/stream_delivery.py), while the streamed deltas keep the model's own blank lines.
const seal = (text, segment, extra = {}) => ({ event: 'message.interim', data: { text, turn_id: 't1', segment, ...extra } })

test('a) already-streamed seal stripped of the leading/trailing newlines: the reply stays once, newlines kept', () => {
  const buf = newBuf()
  feed(buf, [
    { event: 'message.delta', data: { delta: '\n\n先看', turn_id: 't1', segment: 0, offset: 0 } },
    { event: 'message.delta', data: { delta: '代码。\n', turn_id: 't1', segment: 0, offset: 4 } },
    seal('先看代码。', 0, { already_streamed: true }),
  ])
  assert.equal(buf.text, '\n\n先看代码。\n')
})

test('b) paragraphs with blank lines across two frames, seal with the inner blank line: once', () => {
  const buf = newBuf()
  feed(buf, [
    ...stamped('t1', 0, ['\n\n第一段\n\n', '第二段\n']),
    seal('第一段\n\n第二段', 0, { already_streamed: true }),
  ])
  assert.equal(buf.text, '\n\n第一段\n\n第二段\n')
  // collapsed whitespace inside the text counts as the same text, too
  const other = newBuf()
  feed(other, [...stamped('t1', 0, ['第一段\n\n\n第二段\n']), seal('第一段 第二段', 0, { already_streamed: true })])
  assert.equal(other.text, '第一段\n\n\n第二段\n')
  // the streamed text already runs past the sealed text: kept as it is
  const longer = newBuf()
  feed(longer, [...stamped('t1', 0, ['\n先看代码。\n\n还有一句。\n']), seal('先看代码。', 0, { already_streamed: true })])
  assert.equal(longer.text, '\n先看代码。\n\n还有一句。\n')
})

test('c) seal = streamed text + an unstreamed tail: the tail is added once, the streamed part and its blank lines kept', () => {
  const buf = newBuf()
  feed(buf, [
    ...stamped('t1', 0, ['\n\n先看', '代码。\n']),
    seal('先看代码。\n下一句。', 0, { already_streamed: true }),
    ...stamped('t1', 1, ['后续']),
  ])
  assert.equal(buf.text, '\n\n先看代码。\n下一句。后续')
  const inline = newBuf()
  feed(inline, [...stamped('t1', 0, ['  第一句。']), seal('第一句。第二句。', 0, { already_streamed: true })])
  assert.equal(inline.text, '  第一句。第二句。')
})

test('d) nothing stamped in the segment, already streamed and the screen ends with it modulo whitespace: not added', () => {
  const buf = newBuf()
  feed(buf, [
    { event: 'message.delta', data: { delta: '\n\n先看' } },
    { event: 'message.delta', data: { delta: '代码。\n' } },
    seal('先看代码。', 0, { already_streamed: true }),
  ])
  assert.equal(buf.text, '\n\n先看代码。\n')
})

test('e) control: a seal not marked already_streamed still adds its text as before', () => {
  const missing = newBuf()
  feed(missing, [{ event: 'message.delta', data: { delta: '\n\n先看代码。\n' } }, seal('先看代码。', 0)])
  assert.equal(missing.text, '\n\n先看代码。\n先看代码。', 'already_streamed missing, empty segment: added')
  const no = newBuf()
  feed(no, [...stamped('t1', 0, ['\n\n先看代码。\n']), seal('先看代码。', 0, { already_streamed: false })])
  assert.equal(no.text, '\n\n先看代码。\n先看代码。', 'already_streamed false, unrelated raw text: appended')
  const unrelated = newBuf()
  feed(unrelated, [...stamped('t1', 0, ['\n先看代码。\n']), seal('另一段说明。', 0, { already_streamed: true })])
  assert.equal(unrelated.text, '\n先看代码。\n另一段说明。', 'already streamed but unrelated: appended')
})

// ---------- 5. nothing crosses between thinking box and reply ----------

test('reasoning never lands in the reply and reply never lands in the thinking box', () => {
  const buf = newBuf()
  feed(buf, [
    ...charsOf(BASE).map(reasoning),
    status(RETRY),
    ...charsOf(BASE).map(reasoning),
    ...stamped('t1', 0, ['回复正文']),
    ...stamped('t1', 0, ['回复正文']),
  ])
  assert.equal(buf.text, '回复正文')
  assert.equal(buf.reasoning, BASE)
  assert.ok(!buf.text.includes(BASE))
  assert.ok(!buf.reasoning.includes('回复'))
})

// ---------- 6. rendered ----------

let renderPane = null
let workDir = ''
async function loadRenderer() {
  if (renderPane) return renderPane
  workDir = mkdtempSync(join(tmpdir(), 'ekko-dedupe-'))
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

test('rendered: after a retry and a duplicated reply stream the pane shows the reasoning once and the reply once', async () => {
  const render = await loadRenderer()
  const buf = newBuf()
  feed(buf, [...charsOf(BASE).map(reasoning), status(RETRY), ...charsOf(BASE).map(reasoning)])
  const retryHtml = render(paneProps({ ...buf, tools: [] }))
  assert.equal(thinkingTextOf(retryHtml), BASE)
  feed(buf, [status(RETRY)])
  const boundaryHtml = render(paneProps({ ...buf, tools: [] }))
  assert.equal(statusBarOf(boundaryHtml)?.startsWith(RETRY), true, `status bar: ${statusBarOf(boundaryHtml)}`)
  assert.equal(thinkingTextOf(boundaryHtml), null, 'the status line is not drawn as a thinking box')
  feed(buf, [...charsOf(BASE).map(reasoning), ...stamped('t1', 0, ['答复一次。']), ...stamped('t1', 0, ['答复一次。'])])
  const html = unescape(render(paneProps({ ...buf, tools: [] })))
  assert.equal(thinkingTextOf(render(paneProps({ ...buf, tools: [] }))), BASE)
  assert.equal(html.split('答复一次。').length - 1, 1, 'the reply is on screen once')
  assert.equal(html.split(BASE).length - 1, 1, 'the reasoning is on screen once')
})

// ---------- 7. wiring ----------

test('App.jsx drops the identity state wherever it wipes the stream for a new turn or a replay', () => {
  const app = readFileSync(join(pkgRoot, 'src/client/App.jsx'), 'utf8')
  const wipes = app.split("buf.text = ''").length - 1
  assert.ok(wipes >= 2)
  assert.equal(app.split('buf.reply = null').length - 1, wipes, 'each wipe of buf.text also drops buf.reply')
  // after a wipe, the replayed frames of the same turn rebuild the reply instead of being dropped
  const buf = newBuf()
  const frames = stamped('t1', 0, ['重放', '内容'])
  feed(buf, frames)
  buf.text = ''
  buf.reply = null
  feed(buf, frames)
  assert.equal(buf.text, '重放内容')
})

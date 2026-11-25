// Run history (SessionTraceView): the three session kinds (总管 / 构建 / 审查) are picked with one tap from a
// category bar instead of scrolling a 168px list on narrow screens. Only the left list is filtered; the
// selected session on the right stays until the user picks another one.
//
// The repo has no jsdom, so this file installs a minimal DOM (enough for react-dom/client: elements, text
// nodes, attributes, listeners, bubbling dispatch) and drives the real bundled component with clicks.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const pkgRoot = new URL('../', import.meta.url).pathname

// ── minimal DOM ───────────────────────────────────────────────────────────
const HTML_NS = 'http://www.w3.org/1999/xhtml'
class FakeNode {
  constructor(doc, nodeType, nodeName) {
    this.ownerDocument = doc
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.childNodes = []
    this.parentNode = null
    this._listeners = []
  }
  get firstChild() { return this.childNodes[0] || null }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null }
  get nextSibling() {
    const p = this.parentNode
    return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null
  }
  get previousSibling() {
    const p = this.parentNode
    return p ? p.childNodes[p.childNodes.indexOf(this) - 1] || null : null
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c)
    this.childNodes.push(c)
    c.parentNode = this
    return c
  }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c)
    if (c.parentNode) c.parentNode.removeChild(c)
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c)
    c.parentNode = this
    return c
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c)
    if (i >= 0) this.childNodes.splice(i, 1)
    c.parentNode = null
    return c
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue
    return this.childNodes.map(c => c.textContent).join('')
  }
  set textContent(v) {
    if (this.nodeType === 3) { this.nodeValue = String(v); return }
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)))
  }
  addEventListener(type, fn, opts) {
    this._listeners.push({ type, fn, capture: typeof opts === 'boolean' ? opts : Boolean(opts?.capture) })
  }
  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture)
    this._listeners = this._listeners.filter(l => !(l.type === type && l.fn === fn && l.capture === capture))
  }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false }
}
class FakeText extends FakeNode {
  constructor(doc, v) { super(doc, 3, '#text'); this.nodeValue = String(v) }
  get data() { return this.nodeValue }
  set data(v) { this.nodeValue = String(v) }
}
class FakeElement extends FakeNode {
  constructor(doc, tag, ns) {
    super(doc, 1, String(tag).toUpperCase())
    this.tagName = this.nodeName
    this.localName = String(tag).toLowerCase()
    this.namespaceURI = ns || HTML_NS
    this.attrs = new Map()
    this.style = { setProperty(k, v) { this[k] = v }, removeProperty(k) { delete this[k] } }
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)) }
  setAttributeNS(_ns, k, v) { this.setAttribute(k, v) }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null }
  hasAttribute(k) { return this.attrs.has(k) }
  removeAttribute(k) { this.attrs.delete(k) }
  removeAttributeNS(_ns, k) { this.removeAttribute(k) }
  get className() { return this.getAttribute('class') || '' }
  set className(v) { this.setAttribute('class', v) }
  get classList() { return { contains: c => this.className.split(/\s+/).includes(c) } }
  get disabled() { return this.hasAttribute('disabled') }
  focus() {}
  blur() {}
}
class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9, '#document')
    this.ownerDocument = null
    this.documentElement = this.createElement('html')
    this.body = this.createElement('body')
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
    this.activeElement = this.body
  }
  createElement(tag) { return new FakeElement(this, tag, HTML_NS) }
  createElementNS(ns, tag) { return new FakeElement(this, tag, ns) }
  createTextNode(v) { return new FakeText(this, v) }
  createComment(v) { const n = new FakeText(this, v); n.nodeType = 8; n.nodeName = '#comment'; return n }
}
const document = new FakeDocument()
const window = {
  document,
  event: undefined,
  addEventListener() {},
  removeEventListener() {},
  getSelection: () => null,
  HTMLIFrameElement: class HTMLIFrameElement {},
}
document.defaultView = window
globalThis.window = window
globalThis.document = document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// React's act() queues work through a fresh MessageChannel when it cannot require('timers'); real ports keep
// the test process alive after the last test. This stand-in delivers through setImmediate and holds nothing.
globalThis.MessageChannel = class MessageChannel {
  constructor() {
    const a = { onmessage: null, close() {} }
    const b = { onmessage: null, close() {} }
    a.postMessage = data => setImmediate(() => b.onmessage?.({ data }))
    b.postMessage = data => setImmediate(() => a.onmessage?.({ data }))
    this.port1 = a
    this.port2 = b
  }
}

function dispatch(target, type) {
  const path = []
  for (let n = target; n; n = n.parentNode) path.push(n)
  const ev = {
    type, target, bubbles: true, cancelable: true, defaultPrevented: false, isTrusted: true,
    timeStamp: Date.now(), button: 0, currentTarget: null, eventPhase: 0, _stop: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this._stop = true },
  }
  for (const n of [...path].reverse()) {
    ev.currentTarget = n
    for (const l of n._listeners) if (l.type === type && l.capture) l.fn.call(n, ev)
    if (ev._stop) return ev
  }
  for (const n of path) {
    ev.currentTarget = n
    for (const l of n._listeners) if (l.type === type && !l.capture) l.fn.call(n, ev)
    if (ev._stop) return ev
  }
  return ev
}
const walk = (root, out = []) => { for (const c of root.childNodes) { if (c.nodeType === 1) { out.push(c); walk(c, out) } } return out }
const hasClass = (el, c) => (el.getAttribute('class') || '').split(/\s+/).includes(c)

// ── bundle and mount the real component ───────────────────────────────────
let mod = null
let workDir = ''
async function loadView() {
  if (mod) return mod
  workDir = mkdtempSync(join(tmpdir(), 'ekko-trace-pick-'))
  const entry = join(workDir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { createRoot } from 'react-dom/client'`,
    `import { SessionTraceView } from ${JSON.stringify(join(pkgRoot, 'src/client/components/SessionTraceView.jsx'))}`,
    `export { React, createRoot, SessionTraceView }`,
  ].join('\n'))
  const out = join(workDir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    nodePaths: [join(pkgRoot, 'node_modules')],
    // Development build: React.act is only available there.
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  mod = await import(pathToFileURL(out).href)
  return mod
}
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

const SESSIONS = [
  { sessionId: 'c1', kind: 'chief', label: '总管 · 话题A', running: false },
  { sessionId: 'b1', kind: 'build', label: '构建 · #12', running: true },
  { sessionId: 'b2', kind: 'build', label: '构建 · #13', running: false },
  { sessionId: 'r1', kind: 'review', label: '审查 · #12', running: false },
  { sessionId: 'r2', kind: 'review', label: '审查 · #11', running: false },
  { sessionId: 'r3', kind: 'review', label: '审查 · #10', running: false },
]
const traceOf = s => ({ sessionId: s.sessionId, kind: s.kind, label: s.label, running: false, steps: [], toolCalls: 0, startedAt: 1, lastActiveAt: 2 })

async function mount(sessions = SESSIONS) {
  const { React, createRoot, SessionTraceView } = await loadView()
  const calls = []
  const ctx = {
    rpc: {
      async call(name, args) {
        calls.push({ name, args })
        assert.equal(name, 'get-session-trace')
        const sel = sessions.find(s => s.sessionId === args?.sessionId)
        return { sessions, trace: sel ? traceOf(sel) : null }
      },
    },
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const settle = () => React.act(async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)) })
  await React.act(async () => { root.render(React.createElement(SessionTraceView, { ctx, onBack() {} })) })
  await settle()
  const q = id => walk(container).find(el => el.getAttribute('data-testid') === id) || null
  const sessionButtons = () => walk(container).filter(el => /^trace-session-/.test(el.getAttribute('data-testid') || ''))
    .map(el => el.getAttribute('data-testid').slice('trace-session-'.length))
  const click = async el => {
    assert.ok(el, 'element to click exists')
    await React.act(async () => { dispatch(el, 'click') })
    await settle()
  }
  const title = () => walk(container).find(el => hasClass(el, 'ek-trace-title'))?.textContent ?? null
  const unmount = () => React.act(async () => { root.unmount() }).then(() => document.body.removeChild(container))
  return { container, q, sessionButtons, click, title, unmount, calls }
}

const KINDS = ['all', 'chief', 'build', 'review']
const LABELS = { all: '全部', chief: '总管', build: '构建', review: '审查' }

test('a) the kind bar has exactly four tabs with label and correct count', async () => {
  const v = await mount()
  try {
    const bar = v.q('trace-kind-tabs')
    assert.ok(bar, 'trace-kind-tabs rendered')
    assert.equal(bar.getAttribute('role'), 'tablist')
    assert.equal(bar.getAttribute('aria-label'), '会话分类')
    const tabs = walk(bar).filter(el => el.localName === 'button')
    assert.equal(tabs.length, 4)
    const expected = { all: 6, chief: 1, build: 2, review: 3 }
    for (const [i, k] of KINDS.entries()) {
      const tab = v.q(`trace-kind-tab-${k}`)
      assert.equal(tabs[i], tab, `tab ${k} in position ${i}`)
      assert.equal(tab.getAttribute('role'), 'tab')
      const text = tab.textContent
      assert.ok(text.includes(LABELS[k]), `${k} label in "${text}"`)
      assert.ok(text.replace(LABELS[k], '').includes(String(expected[k])), `${k} count ${expected[k]} in "${text}"`)
    }
    assert.equal(v.q('trace-kind-tab-all').getAttribute('aria-selected'), 'true')
    assert.equal(v.q('trace-kind-tab-build').getAttribute('aria-selected'), 'false')
  } finally { await v.unmount() }
})

test('b) picking 构建 leaves only build sessions in the list', async () => {
  const v = await mount()
  try {
    await v.click(v.q('trace-kind-tab-build'))
    assert.deepEqual(v.sessionButtons(), ['b1', 'b2'])
    for (const id of ['c1', 'r1', 'r2', 'r3']) assert.equal(v.q(`trace-session-${id}`), null, `${id} not in DOM`)
    assert.equal(v.q('trace-kind-tab-build').getAttribute('aria-selected'), 'true')
    assert.equal(v.q('trace-kind-tab-all').getAttribute('aria-selected'), 'false')
  } finally { await v.unmount() }
})

test('c) back to 全部: all three groups return in 总管 → 构建 → 审查 order', async () => {
  const v = await mount()
  try {
    await v.click(v.q('trace-kind-tab-review'))
    assert.deepEqual(v.sessionButtons(), ['r1', 'r2', 'r3'])
    await v.click(v.q('trace-kind-tab-all'))
    assert.deepEqual(v.sessionButtons(), ['c1', 'b1', 'b2', 'r1', 'r2', 'r3'])
    const heads = walk(v.container).filter(el => hasClass(el, 'ek-trace-group-head')).map(el => el.textContent)
    assert.deepEqual(heads, ['总管', '构建', '审查'])
  } finally { await v.unmount() }
})

test('d) filtering does not move the selection: a picked review session stays on the right', async () => {
  const v = await mount()
  try {
    assert.equal(v.title(), '总管 · 话题A', 'first session is selected on load')
    await v.click(v.q('trace-kind-tab-review'))
    assert.equal(v.title(), '总管 · 话题A', 'switching the kind alone does not change the selection')
    await v.click(v.q('trace-session-r2'))
    assert.equal(v.title(), '审查 · #11')
    const before = v.calls.length
    await v.click(v.q('trace-kind-tab-build'))
    assert.equal(v.q('trace-session-r2'), null, 'r2 is filtered out of the list')
    assert.equal(v.title(), '审查 · #11', 'right side still shows the review session')
    assert.equal(v.calls.length, before, 'switching the kind loads nothing')
    assert.ok(v.q('trace-timeline'), 'timeline still rendered')
  } finally { await v.unmount() }
})

test('e) a kind with zero sessions is shown but disabled; others are enabled', async () => {
  const v = await mount(SESSIONS.filter(s => s.kind !== 'chief'))
  try {
    const chief = v.q('trace-kind-tab-chief')
    assert.ok(chief, 'zero-count tab is still rendered')
    assert.equal(chief.hasAttribute('disabled'), true)
    assert.ok(chief.textContent.includes('0'))
    for (const k of ['all', 'build', 'review']) assert.equal(v.q(`trace-kind-tab-${k}`).hasAttribute('disabled'), false, k)
  } finally { await v.unmount() }
})

test('control: existing test ids and back/refresh still work', async () => {
  const v = await mount()
  try {
    for (const id of ['session-trace-view', 'btn-trace-back', 'btn-trace-refresh', 'trace-timeline', 'trace-session-c1']) {
      assert.ok(v.q(id), id)
    }
    const before = v.calls.length
    await v.click(v.q('btn-trace-refresh'))
    assert.equal(v.calls.length, before + 1, 'refresh reloads')
  } finally { await v.unmount() }
})

// ── CSS: the bar does not scroll away with the list on narrow screens ─────
function rulesFor(css, selector) {
  // Returns [{ media, body }] for every rule whose selector list contains `selector` exactly.
  const out = []
  const strip = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /@media([^{]*)\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}|([^{}@]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(strip))) {
    if (m[1] !== undefined) {
      const inner = /([^{}]+)\{([^{}]*)\}/g
      let r
      while ((r = inner.exec(m[2]))) {
        if (r[1].split(',').map(s => s.trim()).includes(selector)) out.push({ media: m[1].trim(), body: r[2] })
      }
    } else if (m[3].split(',').map(s => s.trim()).includes(selector)) {
      out.push({ media: '', body: m[4] })
    }
  }
  return out
}
const narrow = r => r.media === '' || /max-width:\s*980px/.test(r.media) || /max-width:\s*780px/.test(r.media)

test('f) <= 980px: the kind bar sits outside the scrolling .ek-trace-list', async () => {
  const v = await mount()
  try {
    const bar = v.q('trace-kind-tabs')
    assert.ok(bar, 'bar rendered')
    const list = walk(v.container).find(el => hasClass(el, 'ek-trace-list'))
    assert.ok(list, '.ek-trace-list rendered')
    assert.equal(list.contains(bar), false, 'bar is not inside the scrolling list')
    assert.equal(bar.parentNode, list.parentNode, 'bar and list are siblings')
    assert.ok(list.contains(v.q('trace-session-c1')), 'sessions live in the scrolling list')
    const holder = bar.parentNode
    assert.equal(holder.localName, 'aside')
    assert.equal(holder.getAttribute('aria-label'), '会话列表')

    const css = readFileSync(join(pkgRoot, 'src/client/styles.css'), 'utf8')
    const holderClasses = holder.getAttribute('class').split(/\s+/).filter(Boolean)
    assert.ok(holderClasses.length > 0)
    for (const c of holderClasses) {
      for (const r of rulesFor(css, `.${c}`).filter(narrow)) {
        assert.ok(!/overflow(-y)?\s*:\s*(auto|scroll)/.test(r.body), `.${c} (${r.media || 'base'}) must not scroll: ${r.body}`)
      }
    }
    const listRules = rulesFor(css, '.ek-trace-list')
    assert.ok(listRules.some(r => r.media === '' && /overflow-y\s*:\s*auto/.test(r.body)), 'list itself still scrolls')
    assert.ok(listRules.some(r => /max-width:\s*980px/.test(r.media) && /max-height/.test(r.body)), 'narrow list keeps its height cap')
    for (const r of rulesFor(css, '.ek-trace-kind-tabs').filter(narrow)) {
      assert.ok(!/overflow-y\s*:\s*(auto|scroll)/.test(r.body), `bar must not be a vertical scroller: ${r.body}`)
    }
  } finally { await v.unmount() }
})

test('board lane tabs keep their phone-only rules (not touched by this change)', () => {
  const css = readFileSync(join(pkgRoot, 'src/client/styles.css'), 'utf8')
  assert.ok(rulesFor(css, '.ot-lane-tabs').some(r => r.media === '' && /display:\s*none/.test(r.body)))
  const view = readFileSync(join(pkgRoot, 'src/client/components/SessionTraceView.jsx'), 'utf8')
  assert.ok(!view.includes('ot-lane-tab'), 'trace view uses the .ot-seg control, not the board lane tabs')
})

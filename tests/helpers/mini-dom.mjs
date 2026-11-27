// Shared by the #100 interaction tests (and the #112 whole-page smoke): the minimal DOM of tests/v0951-trace-quick-pick.test.mjs (elements,
// text nodes, attributes, listeners, capture + bubble dispatch) plus `closest`, an input `type` and event
// init fields, and a bundler that swaps Radix Dialog for a pass-through so dialogs render inline.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

export const pkgRoot = new URL('../../', import.meta.url).pathname

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
  focus() { this.ownerDocument.activeElement = this }
  blur() {}
  get type() { return this.attrs.get('type') || (this.localName === 'input' ? 'text' : this.localName === 'textarea' ? 'textarea' : '') }
  set type(v) { this.attrs.set('type', String(v)) }
  get options() { return walk(this).filter(n => n.localName === 'option') }
  closest(sel) {
    // Enough for interaction.js: a comma list of tag names and [attr] / [attr="v"] selectors.
    const parts = String(sel).split(',').map(s => s.trim())
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
      for (const p of parts) {
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p)
        if (m ? (n.hasAttribute(m[1]) && (m[2] === undefined || n.getAttribute(m[1]) === m[2])) : n.localName === p) return n
      }
    }
    return null
  }
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
// react-dom probes `'oninput' in document`; without it text inputs fall back to an IE-only change path.
document.oninput = null
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
// Radix Switch checks `form instanceof HTMLFormElement`-style globals when it mounts.
for (const name of ['HTMLElement', 'HTMLFormElement', 'HTMLInputElement']) globalThis[name] ??= class {}
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

function dispatch(target, type, init = {}) {
  const path = []
  for (let n = target; n; n = n.parentNode) path.push(n)
  const ev = {
    type, target, bubbles: true, cancelable: true, defaultPrevented: false, isTrusted: true,
    timeStamp: Date.now(), button: 0, currentTarget: null, eventPhase: 0, _stop: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this._stop = true },
    ...init,
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

export { document, window, dispatch, walk, hasClass, FakeElement }
export const byTestId = (root, id) => walk(root).find(el => el.getAttribute('data-testid') === id) || null

/**
 * Todo #112: what the whole page (src/client/App.jsx) reads from a browser beyond the minimal DOM: storage,
 * computed style, media queries, observers, animation frames and element geometry. Call it before mounting
 * App; the returned function puts the globals back.
 */
export function installPageEnvironment({ width = 1440 } = {}) {
  const store = new Map()
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: k => { store.delete(k) },
  }
  const frame = fn => setTimeout(fn, 0)
  const globals = {
    localStorage,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: frame,
    cancelAnimationFrame: id => clearTimeout(id),
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    SVGElement: class SVGElement {},
    Element: FakeElement,
  }
  const windowProps = {
    localStorage,
    getComputedStyle: globals.getComputedStyle,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    innerWidth: width,
    requestAnimationFrame: frame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: id => clearTimeout(id),
    setInterval: (...a) => setInterval(...a),
    clearInterval: id => clearInterval(id),
  }
  const protoProps = {
    scrollTo() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } },
  }
  const undo = []
  const put = (target, key, value) => {
    const had = Object.prototype.hasOwnProperty.call(target, key)
    const prev = target[key]
    target[key] = value
    undo.push(() => { if (had) target[key] = prev; else delete target[key] })
  }
  for (const [k, v] of Object.entries(globals)) put(globalThis, k, v)
  for (const [k, v] of Object.entries(windowProps)) put(window, k, v)
  for (const [k, v] of Object.entries(protoProps)) put(FakeElement.prototype, k, v)
  put(document.documentElement, 'dataset', {})
  return () => { for (const fn of undo.splice(0).reverse()) fn() }
}

const DIALOG_STUB = `
import React from 'react'
const pass = tag => ({ asChild, children, onOpenAutoFocus, onOpenChange, sideOffset, align, ...rest }) =>
  asChild ? children : React.createElement(tag, rest, children)
export const Root = ({ open, children }) => (open ? React.createElement(React.Fragment, null, children) : null)
export const Portal = ({ children }) => React.createElement(React.Fragment, null, children)
export const Overlay = () => null
export const Content = pass('div')
export const Title = pass('h2')
export const Description = pass('div')
export const Close = pass('span')
export const Trigger = pass('span')
`

const dirs = []
/** Bundles `exports` (name → path under src/client) as a development build and imports it. */
export async function loadClient(exports, { stubDialog = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-interaction-'))
  dirs.push(dir)
  const stub = join(dir, 'dialog-stub.jsx')
  writeFileSync(stub, DIALOG_STUB)
  const entry = join(dir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { createRoot } from 'react-dom/client'`,
    ...Object.entries(exports).map(([name, rel]) => `import { ${name} } from ${JSON.stringify(join(pkgRoot, 'src/client', rel))}`),
    `export { React, createRoot, ${Object.keys(exports).join(', ')} }`,
  ].join('\n'))
  const out = join(dir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    nodePaths: [join(pkgRoot, 'node_modules')],
    alias: stubDialog ? { '@radix-ui/react-dialog': stub } : {},
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  return import(pathToFileURL(out).href)
}
export function cleanupClient() { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) }

/** Mounts one element; returns { container, q, click, input, submit, settle, unmount }. */
export async function mountElement(mod, element) {
  const { React, createRoot } = mod
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const settle = () => React.act(async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)) })
  await React.act(async () => { root.render(element) })
  await settle()
  const q = id => byTestId(container, id)
  const fire = async (el, type, init) => {
    if (!el) throw new Error(`no element for ${type}`)
    await React.act(async () => { dispatch(el, type, init) })
    await settle()
  }
  return {
    container, q, settle,
    rerender: async el => { await React.act(async () => { root.render(el) }); await settle() },
    click: el => fire(el, 'click'),
    input: (el, value) => { el.value = value; return fire(el, 'input') },
    submit: el => fire(el, 'submit'),
    unmount: () => React.act(async () => { root.unmount() }).then(() => document.body.removeChild(container)),
  }
}

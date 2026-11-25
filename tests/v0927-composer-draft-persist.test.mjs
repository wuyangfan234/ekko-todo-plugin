import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// v0.9.27 (Todo #18): unsent composer text and uploaded files survive leaving the chat page.
// The chat composer unmounts when another plugin page (board, quota, settings…) is opened; on the next mount
// of the same topic it must come back from the browser's localStorage. Topics never share drafts.

const pkgRoot = new URL('../', import.meta.url).pathname

class MemoryStorage {
  constructor() { this.map = new Map() }
  get length() { return this.map.size }
  key(i) { return [...this.map.keys()][i] ?? null }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) { this.map.set(k, String(v)) }
  removeItem(k) { this.map.delete(k) }
  clear() { this.map.clear() }
}

let renderPane = null
let workDir = ''
async function loadRenderer() {
  if (renderPane) return renderPane
  workDir = mkdtempSync(join(tmpdir(), 'ekko-draft-'))
  const entry = join(workDir, 'entry.jsx')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import { ChatPane } from ${JSON.stringify(join(pkgRoot, 'src/client/components/ChatPane.jsx'))}`,
    `export function render(props) { return renderToStaticMarkup(React.createElement(ChatPane, props)) }`,
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
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  renderPane = (await import(pathToFileURL(out).href)).render
  return renderPane
}

const topicOf = id => ({ id, title: `话题 ${id}`, messages: [], autopilot: true, projectId: '', createdAt: 1, updatedAt: 1 })
const paneProps = topic => ({
  ctx: { ui: { notify() {} } },
  state: { agents: [], projects: [], todos: [], topics: [topic], settings: {} },
  topic,
  projects: [],
  todos: [],
  liveStream: { isWorking: false, tools: [] },
  busy: false,
  composerFocusSeq: 0,
  onSendMessage() {},
})

// What the composer writes for a topic once text is typed and an image has been uploaded.
const storedDraft = {
  v: 1,
  savedAt: 1,
  text: '切页之前写了一半的话',
  files: [{
    id: 'att-img1', type: 'image', name: 'shot.png', path: '/uploads/abc/shot.png', mediaType: 'image/png', size: 2048,
    thumb: 'data:image/jpeg;base64,/9j/AAAA',
  }],
  cards: [],
}

test('v0.9.27: draft text and uploaded file reference come back when the same topic mounts again', async () => {
  const storage = new MemoryStorage()
  globalThis.localStorage = storage
  try {
    storage.setItem('ekko_todo_draft:topic-A', JSON.stringify(storedDraft))
    const render = await loadRenderer()
    // Mount → (unmount by leaving the page) → mount again: the server render is a fresh mount every time.
    const html = render(paneProps(topicOf('topic-A')))
    assert.match(html, /切页之前写了一半的话/, 'unsent text restored into the composer')
    assert.match(html, /shot\.png/, 'uploaded image chip restored')
    assert.match(html, /data:image\/jpeg;base64,\/9j\/AAAA/, 'small preview thumbnail used for the chip')
    // Another topic does not see this draft.
    const other = render(paneProps(topicOf('topic-B')))
    assert.doesNotMatch(other, /切页之前写了一半的话/)
    assert.doesNotMatch(other, /shot\.png/)
  } finally {
    delete globalThis.localStorage
  }
})

test('v0.9.27: images over the 200KB budget turn into "图片需要重新上传" and are not sent', async () => {
  const storage = new MemoryStorage()
  globalThis.localStorage = storage
  try {
    storage.setItem('ekko_todo_draft:topic-C', JSON.stringify({
      v: 1, savedAt: 1, text: '文字保留', files: [{ id: 'att-x', type: 'image', name: 'big.png', needsReupload: true }], cards: [],
    }))
    const render = await loadRenderer()
    const html = render(paneProps(topicOf('topic-C')))
    assert.match(html, /文字保留/)
    assert.match(html, /图片需要重新上传/)
  } finally {
    delete globalThis.localStorage
  }
})

test('v0.9.27: draft module writes per topic, keeps refs only, caps 200KB, clears on send', async () => {
  const mod = await import('../src/client/composer-draft.js')
  const storage = new MemoryStorage()
  const file = { id: 'att-1', type: 'image', name: 'a.png', path: '/up/a.png', mediaType: 'image/png', size: 9_000_000, previewUrl: 'blob:http://x/123', thumb: 'data:image/jpeg;base64,QUJD' }
  mod.saveDraft(storage, 'topic-A', { text: 'hello', files: [file], cards: [{ id: 'td-1', number: 3, title: '卡' }] })
  const raw = storage.getItem('ekko_todo_draft:topic-A')
  assert.ok(raw && !raw.includes('blob:'), 'blob URLs are not persisted')
  const back = mod.loadDraft(storage, 'topic-A')
  assert.equal(back.text, 'hello')
  assert.equal(back.files[0].path, '/up/a.png')
  assert.equal(back.files[0].previewUrl, 'data:image/jpeg;base64,QUJD')
  assert.equal(back.cards[0].id, 'td-1')
  assert.equal(mod.loadDraft(storage, 'topic-B').text, '', 'no cross-topic leak')

  // Sending strips UI-only fields and drops placeholders.
  assert.deepEqual(mod.sendableAttachments([...back.files, { id: 'z', type: 'image', name: 'b', needsReupload: true }]),
    [{ id: 'att-1', type: 'image', name: 'a.png', path: '/up/a.png', mediaType: 'image/png', size: 9_000_000 }])

  // Budget: long text + big thumbs → text kept, images become re-upload placeholders, total ≤ 200KB.
  const bigThumb = `data:image/jpeg;base64,${'A'.repeat(20_000)}`
  const files = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, type: 'image', name: `p${i}.png`, path: `/up/p${i}.png`, thumb: bigThumb }))
  const text = '字'.repeat(60_000) // 180KB of UTF-8
  const json = mod.serializeDraft({ text, files })
  assert.ok(Buffer.byteLength(json) <= mod.DRAFT_MAX_BYTES, `draft is ${Buffer.byteLength(json)} bytes`)
  const parsed = mod.parseDraft(json)
  assert.equal(parsed.text, text, 'text is kept whole')
  assert.ok(parsed.files.every(f => f.needsReupload && !f.path), 'images degraded to re-upload placeholders')

  // Empty draft (after a successful send) removes the key.
  mod.saveDraft(storage, 'topic-A', { text: '', files: [], cards: [] })
  assert.equal(storage.getItem('ekko_todo_draft:topic-A'), null)
  mod.saveDraft(storage, 'topic-A', { text: 'x' })
  mod.clearDraft(storage, 'topic-A')
  assert.equal(storage.getItem('ekko_todo_draft:topic-A'), null)
})

test('v0.9.27: ChatPane wires the draft cache (per-topic load, save on change, clear after send success)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(join(pkgRoot, 'src/client/components/ChatPane.jsx'), 'utf8')
  assert.match(src, /from '\.\.\/composer-draft\.js'/)
  assert.match(src, /saveDraft\(draftStorage, /, 'composer changes are saved')
  assert.match(src, /clearDraft\(draftStorage, /, 'draft cleared once the send succeeds')
  assert.match(src, /sendableAttachments\(/, 'placeholders and preview data never reach send-topic-message')
  const app = readFileSync(join(pkgRoot, 'src/client/App.jsx'), 'utf8')
  assert.match(app, /return \{ ok: sent !== null, topicId: targetTopicId \}/, 'send result reported back to the composer')
})

test.after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

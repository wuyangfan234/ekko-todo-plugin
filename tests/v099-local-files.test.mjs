import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readLocalFile, normalizeLocalPath, LOCAL_FILE_CHUNK_BYTES, defaultAllowRoots } from '../src/server/local-file.mjs'
import { toLocalPath, isImagePath, localMarkedExtension } from '../src/client/local-files.js'
import { Marked } from 'marked'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

function fixture() {
  // Hermes' default TMPDIR is ~/.hermes/cache/scratch, which the preview deny list covers (#62);
  // fall back to /tmp so the fixture root itself is never inside a credential directory.
  const base = [tmpdir(), '/tmp'].map(b => realpathSync(b)).find(b => !/[\\/]\.hermes([\\/]|$)/i.test(b))
  assert.ok(base, `no temp base outside .hermes (tmpdir=${tmpdir()})`)
  const dir = realpathSync(mkdtempSync(join(base, 'ekko-lf-')))
  writeFileSync(join(dir, 'shot.png'), PNG)
  writeFileSync(join(dir, 'note.md'), '# 标题\n![a](/tmp/x.png)\n')
  writeFileSync(join(dir, 'big.bin'), Buffer.alloc(LOCAL_FILE_CHUNK_BYTES * 2 + 123, 7))
  writeFileSync(join(dir, '.env'), 'KEY=1')
  writeFileSync(join(dir, 'state.db'), 'x')
  mkdirSync(join(dir, '.ssh'))
  writeFileSync(join(dir, '.ssh', 'config'), 'Host x')
  return dir
}

test('v0.9.9: read-local-file returns image bytes, text and metadata from the plugin host', () => {
  const dir = fixture()
  try {
    const img = readLocalFile({ path: join(dir, 'shot.png') })
    assert.equal(img.kind, 'image')
    assert.equal(img.mime, 'image/png')
    assert.equal(img.eof, true)
    assert.deepEqual(Buffer.from(img.dataBase64, 'base64'), PNG)
    const md = readLocalFile({ path: join(dir, 'note.md'), mode: 'text' })
    assert.equal(md.kind, 'text')
    assert.match(md.text, /标题/)
    const meta = readLocalFile({ path: `file://${join(dir, 'shot.png')}`, mode: 'meta' })
    assert.equal(meta.size, PNG.length)
    assert.equal(meta.dataBase64, undefined)
    const viaDownload = readLocalFile({ path: `/api/studio/files/download?path=${encodeURIComponent(join(dir, 'shot.png'))}&token=x`, mode: 'meta' })
    assert.equal(viaDownload.name, 'shot.png')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('v0.9.9: large files are chunked and every chunk fits the host 2 MB JSON limit', () => {
  const dir = fixture()
  try {
    let offset = 0
    let total = 0
    let chunks = 0
    for (;;) {
      const res = readLocalFile({ path: join(dir, 'big.bin'), offset })
      assert.ok(Buffer.byteLength(JSON.stringify(res)) < 2_000_000, 'chunk under host limit')
      total += res.length
      offset = res.offset + res.length
      chunks++
      if (res.eof) break
    }
    assert.equal(total, LOCAL_FILE_CHUNK_BYTES * 2 + 123)
    assert.equal(chunks, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('v0.9.9: secrets, databases, directories, relative and out-of-root paths are refused', () => {
  const dir = fixture()
  try {
    assert.throws(() => readLocalFile({ path: join(dir, '.env') }), /安全/)
    assert.throws(() => readLocalFile({ path: join(dir, 'state.db') }), /安全/)
    assert.throws(() => readLocalFile({ path: join(dir, '.ssh', 'config') }), /安全/)
    assert.throws(() => readLocalFile({ path: dir }), /目录/)
    assert.throws(() => readLocalFile({ path: 'relative/a.png' }), /绝对路径/)
    assert.throws(() => readLocalFile({ path: join(dir, 'missing.png') }), /不存在/)
    assert.throws(() => readLocalFile({ path: join(dir, 'shot.png') }, { allowRoots: ['/nonexistent-root'] }), /不在允许/)
    assert.ok(defaultAllowRoots().length > 0)
    assert.equal(normalizeLocalPath('<' + join(dir, 'shot.png') + '>'), join(dir, 'shot.png'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('v0.9.9: client recognizes local hrefs/srcs but leaves web and API links alone', () => {
  assert.equal(toLocalPath('/home/me/a b.png'), '/home/me/a b.png')
  assert.equal(toLocalPath('/home/me/a%20b.png'), '/home/me/a b.png')
  assert.equal(toLocalPath('<C:/Docs/Desktop/s.png>'), 'C:/Docs/Desktop/s.png')
  assert.equal(toLocalPath('file:///tmp/x.pdf'), '/tmp/x.pdf')
  assert.equal(toLocalPath('/api/studio/files/download?path=%2Ftmp%2Fy.png&token=t'), '/tmp/y.png')
  assert.equal(toLocalPath('~/Desktop/r.md'), '~/Desktop/r.md')
  assert.equal(toLocalPath('https://example.com/a.png'), '')
  assert.equal(toLocalPath('/api/plugins/x'), '')
  assert.equal(toLocalPath('#heading'), '')
  assert.equal(toLocalPath('data:image/png;base64,AAAA'), '')
  assert.ok(isImagePath('/a/b.JPG'))
  assert.ok(!isImagePath('/a/b.md'))
})

test('v0.9.9: read-local-file is declared in the contract and chat markdown uses the local-aware renderer', () => {
  const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
  const raw = JSON.stringify(contract)
  assert.ok(raw.includes('"read-local-file"'))
  assert.ok(raw.includes('"readLocalFileInput"'))
  const chat = readFileSync(new URL('../src/client/components/ChatPane.jsx', import.meta.url), 'utf8')
  assert.ok(!/dangerouslySetInnerHTML/.test(chat), 'chat HTML goes through LocalAwareHtml')
  const app = readFileSync(new URL('../src/client/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /<LocalFilePreview/)
  assert.match(app, /setLocalFileRpc/)
})

test('v0.9.9: markdown local images never get a fetchable src; web images are untouched', () => {
  const md = new Marked({ gfm: true }, localMarkedExtension)
  const html = md.parse('![shot](/tmp/a.png) ![win](<C:/Docs/b.png>) ![web](https://e.com/c.png)')
  assert.match(html, /<img data-local-src="\/tmp\/a.png" alt="shot">/)
  assert.match(html, /data-local-src="C:\/Docs\/b.png"/)
  assert.match(html, /<img src="https:\/\/e.com\/c.png"/)
  assert.doesNotMatch(html, / src="\/tmp/)
})

test('v0.9.9: board refreshes are coalesced so build event bursts cannot flood a rate-limited tunnel', () => {
  const app = readFileSync(new URL('../src/client/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /loadGate = useRef\(\{ inflight: false, queued: false, last: 0 \}\)/)
  assert.match(app, /gate\.last \+ 800 - Date\.now\(\)/)
})

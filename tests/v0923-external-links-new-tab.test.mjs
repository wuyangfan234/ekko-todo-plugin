import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Marked } from 'marked'
import * as localFiles from '../src/client/local-files.js'

// The plugin page is a host iframe: a link without target opens GitHub inside that iframe and the
// page shows "refused to connect". Every external http(s) link must open a new browser page with
// rel="noopener noreferrer"; links to files on the plugin host keep opening the in-page preview.

const md = () => new Marked({ gfm: true, breaks: true }, localFiles.localMarkedExtension)
const anchors = html => [...html.matchAll(/<a\b[^>]*>/g)].map(m => m[0])

test('v0.9.23: chat markdown renders https links with target="_blank" and rel="noopener noreferrer"', () => {
  const html = md().parse('CI 通过：https://github.com/example-org/ekko-todo/actions/runs/45447686170\n\n[文档](https://example.com/a?b=1&c=2 "标题") 和 <http://example.org/x>')
  const as = anchors(html)
  assert.equal(as.length, 3, html)
  for (const a of as) {
    assert.match(a, /\starget="_blank"/, a)
    assert.match(a, /\srel="noopener noreferrer"/, a)
  }
  assert.match(html, /href="https:\/\/github\.com\/example-org\/ekko-todo\/actions\/runs\/45447686170"/)
  assert.match(html, /title="标题"/)
  assert.match(html, />文档<\/a>/)
})

test('v0.9.23: local file links are not turned into new-tab links', () => {
  const html = md().parse('[报告](/home/me/report.md) [图](file:///tmp/a.png) [下载](https://studio.example/api/studio/files/download?path=%2Fhome%2Fme%2Fa.pdf) [锚](#x) [相对](docs/a.md)')
  for (const a of anchors(html)) assert.doesNotMatch(a, /target=/, a)
})

function fakeAnchor(attrs) {
  const map = new Map(Object.entries(attrs))
  return {
    tagName: 'A',
    nodeName: 'A',
    getAttribute: k => (map.has(k) ? map.get(k) : null),
    setAttribute: (k, v) => map.set(k, String(v)),
    removeAttribute: k => map.delete(k),
    hasAttribute: k => map.has(k),
    attrs: map,
  }
}

test('v0.9.23: the sanitizer hook keeps new-tab attributes on external links and strips target elsewhere', () => {
  assert.equal(typeof localFiles.installExternalLinkHook, 'function', 'installExternalLinkHook is exported')
  const hooks = []
  const purify = { addHook: (name, fn) => hooks.push([name, fn]) }
  localFiles.installExternalLinkHook(purify)
  localFiles.installExternalLinkHook(purify)
  assert.equal(hooks.length, 1, 'installing twice registers one hook')
  assert.equal(hooks[0][0], 'afterSanitizeAttributes')
  const run = hooks[0][1]

  const ext = fakeAnchor({ href: 'https://github.com/x/y' })
  run(ext)
  assert.equal(ext.attrs.get('target'), '_blank')
  assert.equal(ext.attrs.get('rel'), 'noopener noreferrer')

  const hijack = fakeAnchor({ href: 'https://github.com/x/y', target: '_top', rel: 'opener' })
  run(hijack)
  assert.equal(hijack.attrs.get('target'), '_blank')
  assert.equal(hijack.attrs.get('rel'), 'noopener noreferrer')

  for (const href of ['/home/me/a.md', 'file:///tmp/a.png', 'https://studio.example/api/studio/files/download?path=%2Ftmp%2Fa.png', '#x', 'mailto:a@b.c']) {
    const a = fakeAnchor({ href, target: '_top' })
    run(a)
    assert.equal(a.attrs.has('target'), false, `${href} must not keep a target`)
  }

  const img = { tagName: 'IMG', nodeName: 'IMG', getAttribute: () => 'https://x', setAttribute: () => assert.fail('img touched'), removeAttribute: () => {} }
  run(img)
})

test('v0.9.23: every DOMPurify render path installs the hook', () => {
  for (const file of ['src/client/components/LocalFilePreview.jsx', 'src/client/components/ProjectWorkspace.jsx']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(src, /installExternalLinkHook\(DOMPurify\)/, file)
  }
})

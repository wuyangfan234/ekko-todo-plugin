import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bundledPackages,
  packagesInBundleComments,
  expectedNotices,
  declaredPackages,
  NOTICE_FILE,
  PKG_ROOT,
} from '../scripts/third-party-notices.mjs'

const noticeText = readFileSync(join(PKG_ROOT, NOTICE_FILE), 'utf8')

test('THIRD-PARTY-NOTICES.md lists exactly the packages compiled into the shipped bundles', () => {
  const actual = bundledPackages()
  const declared = declaredPackages(noticeText)
  const missing = actual.filter(name => !declared.includes(name))
  const extra = declared.filter(name => !actual.includes(name))
  assert.deepEqual(missing, [], 'a bundled package is missing from the notices file')
  assert.deepEqual(extra, [], 'the notices file lists a package that is no longer bundled')
  assert.ok(actual.length > 0, 'the bundle must contain third-party packages')
})

test('the bundle manifest still matches the package paths readable in dist/server.mjs', () => {
  // The client bundle is minified, so it cannot be cross-checked this way; the server bundle can, and a stale
  // manifest would otherwise silently under-report what ships.
  const fromComments = packagesInBundleComments()
  const manifest = bundledPackages()
  const unrecorded = fromComments.filter(name => !manifest.includes(name))
  assert.deepEqual(unrecorded, [], 'dist/bundled-packages.json is stale: rebuild before regenerating the notices')
})

test('every bundled package names a licence, carries its text, and is redistributable', () => {
  const blocking = /(?:^|[^LM])(?:A?GPL|SSPL)|unknown|unlicensed|proprietary|non-?commercial/i
  const permissive = /\b(?:MIT|ISC|BSD-[23]-Clause|0BSD|Apache-2\.0|MPL-2\.0|Unlicense|CC0-1\.0)\b/i
  const { entries } = expectedNotices()
  assert.equal(entries.length, bundledPackages().length, 'every bundled package must be resolved from node_modules')
  for (const entry of entries) {
    assert.ok(entry.license && entry.license !== 'UNKNOWN', `${entry.name} must declare a licence`)
    assert.ok(!blocking.test(entry.license), `${entry.name} declares a licence that blocks redistribution: ${entry.license}`)
    assert.match(entry.license, permissive, `${entry.name} declares an unfamiliar licence: ${entry.license}`)
    const block = noticeText.slice(noticeText.indexOf(`### ${entry.name}@`))
    assert.ok(entry.texts.length || block.slice(0, 400).includes('ships no licence file'), `${entry.name} ships no licence text and the notices file does not say so`)
  }
})

test('the notices file is regenerated, not hand-edited', () => {
  const { content } = expectedNotices()
  assert.equal(noticeText, content, 'run node scripts/third-party-notices.mjs --write')
})

test('the shipped bundles carry no build-machine path labels, so a rebuild anywhere produces the same bytes', () => {
  // esbuild labels every compiled module with where it read it. Through a symlinked or nested node_modules
  // that becomes `../../<somewhere>/node_modules/…`, which both makes the committed bundle depend on the
  // maintainer's directory layout and exposes that layout to anyone who installs the plugin.
  for (const file of ['dist/server.mjs', 'dist/client.mjs']) {
    const text = readFileSync(join(PKG_ROOT, file), 'utf8')
    assert.ok(!/(?:\.\.\/)+[^"'\s()]*?node_modules\//.test(text), `${file} still labels a module with a path relative to the build directory`)
  }
})

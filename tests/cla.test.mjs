import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The CLA is the one document that decides whether this project can ever change its licence terms.
// Three things have to stay true, and a well-meaning edit is the likeliest way to lose them: the
// signature phrase must be identical wherever it is quoted, the two promises that make the agreement
// acceptable must survive, and the scope must stay non-retroactive.

const pkgRoot = new URL('../', import.meta.url).pathname
const read = rel => readFileSync(join(pkgRoot, rel), 'utf8')

const SIGNATURE = 'I have read the CLA Document and I hereby sign the CLA'
const PR_TEMPLATE = '.github/PULL_REQUEST_TEMPLATE.md'

test('the signature phrase is quoted byte-for-byte the same in the CLA, the guide and the PR template', () => {
  // A signature line that differs by one word between the document and the instructions is ambiguous:
  // the contributor agrees to something the document does not name. Keep one string.
  for (const file of ['CLA.md', 'CONTRIBUTING.md', PR_TEMPLATE]) {
    assert.ok(read(file).includes(SIGNATURE), `${file} must quote the signature phrase exactly`)
  }
})

test('the CLA keeps the two promises that make it acceptable', () => {
  const cla = read('CLA.md')

  // 1. The contributor keeps ownership. Without this the document is a copyright assignment, and it
  //    would stop being a CLA.
  assert.match(cla, /You keep your copyright/i, 'the section that promises ownership must stay')
  assert.match(cla, /does not transfer ownership/i, 'and must keep saying so in the licence section')
  assert.match(cla, /retain(s)? all right, title and interest/i, 'in the words a contributor can rely on')

  // 2. Relicensing never revokes an existing grant. This is what makes the relicensing right honest.
  assert.match(cla, /does not let Us take back terms already granted/i, 'the no-clawback promise must stay')
  assert.match(cla, /remains? available under MIT/i, 'and it must name MIT, not gestures at "the current licence"')
})

test('the CLA grants relicensing, patent rights and a defensive termination, or it is not worth having', () => {
  const cla = read('CLA.md')
  assert.match(cla, /under whatever terms We choose/i, 'the relicensing right is the point of the document')
  assert.match(cla, /proprietary and commercial terms/i, 'and it must name the case it exists for')
  assert.match(cla, /patent license/i, 'without a patent grant the relicensing right is half a right')
  assert.match(cla, /Defensive termination/i, 'the patent grant needs its termination clause')
  assert.match(cla, /AS IS/i, 'contributions come without warranty')
})

test('the CLA does not reach backwards, and says how a corporation signs', () => {
  const cla = read('CLA.md')
  assert.match(cla, /not\**\s*retroactively covered/i, 'contributions merged before the effective date must stay out of scope')
  assert.match(cla, /Version 1\.0/, 'the version must be stated so a later version can be distinguished')
  assert.match(cla, /Corporate/i, 'an entity needs a way to sign, and §6.2 depends on it')
})

test('the CLA is linked from both places a contributor actually reads', () => {
  assert.match(read('CONTRIBUTING.md'), /\(\.\/CLA\.md\)/, 'CONTRIBUTING must link to the CLA')
  assert.match(read(PR_TEMPLATE), /CLA\.md/, 'the pull request template must link to the CLA')
  // The template's relative link is written for the repository root, where GitHub renders it.
  assert.match(read(PR_TEMPLATE), /\(\.\.\/CLA\.md\)/, 'the PR template link must resolve from .github/')
})

test('no personal names, internal hosts or machine paths leaked into the legal documents', () => {
  for (const file of ['CLA.md', PR_TEMPLATE]) {
    const text = read(file)
    assert.ok(!/\/Users\/[A-Za-z0-9_-]+|\/home\/[A-Za-z0-9_-]+/.test(text), `${file} must not carry a machine path`)
    assert.ok(!/\b192\.168\.\d+\.\d+\b/.test(text), `${file} must not carry a private address`)
  }
})

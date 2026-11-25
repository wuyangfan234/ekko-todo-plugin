import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampDiffs, fitSnapshotBudget, HOST_JSON_LIMIT } from '../src/server/diff-budget.mjs'

const L = x => Buffer.byteLength(JSON.stringify(x))
const minified = 'x'.repeat(160_000)

test('v0.9.8: minified / generated files are not stored as diff bodies', () => {
  const diffs = clampDiffs([
    { path: 'dist/client.mjs', additions: 20, deletions: 19, hunk: `@@ -1,2 +1,2 @@\n-${minified}\n+${minified}y` },
    { path: 'src/app.js', additions: 1, deletions: 1, hunk: '@@ -1 +1 @@\n-a\n+b' },
    { path: 'lib/bundle.js', additions: 1, deletions: 1, hunk: `@@ -1 +1 @@\n-${'q'.repeat(9000)}\n+z` },
  ])
  assert.equal(diffs[0].hunk, '')
  assert.equal(diffs[0].generated, true)
  assert.equal(diffs[0].additions, 20, 'stats are kept')
  assert.equal(diffs[1].hunk, '@@ -1 +1 @@\n-a\n+b')
  assert.equal(diffs[2].generated, true, 'very long single line = minified')
})

test('v0.9.8: long lines and big hunks are clamped with a truncation note', () => {
  const big = ['@@ -1,3000 +1,3000 @@', ...Array.from({ length: 3000 }, (_, i) => `+line ${i} ${'a'.repeat(120)}`)].join('\n')
  const [d] = clampDiffs([{ path: 'src/big.js', additions: 3000, deletions: 0, hunk: big }])
  assert.ok(d.hunk.length <= 41_000)
  assert.match(d.hunk, /\.\.\. \(\d+ more lines truncated\)$/)
  const [w] = clampDiffs([{ path: 'src/wide.js', additions: 1, deletions: 0, hunk: `@@ -0,0 +1 @@\n+${'w'.repeat(1500)}` }])
  assert.ok(w.hunk.split('\n')[1].length < 520)
})

test('v0.9.8: board snapshot always fits under the host JSON limit', () => {
  const todos = Array.from({ length: 40 }, (_, i) => ({
    id: `td-${i}`, phase: i % 2 ? 'done' : 'review', updatedAt: i,
    diffs: clampDiffs(Array.from({ length: 4 }, (_, j) => ({ path: `src/f${j}.js`, additions: 900, deletions: 0, hunk: ['@@ -0,0 +1,900 @@', ...Array.from({ length: 900 }, (_, k) => `+${k} ${'b'.repeat(60)}`)].join('\n') }))),
    buildChat: Array.from({ length: 60 }, (_, k) => ({ text: `step ${k} ${'c'.repeat(300)}` })),
  }))
  const snap = { settings: {}, topics: [], todos }
  assert.ok(L(snap) > HOST_JSON_LIMIT, 'fixture is genuinely oversized')
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= 1_500_000, `fitted size ${L(fitted)}`)
  assert.equal(fitted.snapshotTrimmed, true)
  const omitted = fitted.todos.filter(t => t.diffs.some(d => d.hunkOmitted))
  assert.ok(omitted.length > 0)
  assert.ok(omitted.every(t => t.diffs.every(d => typeof d.additions === 'number')), 'file list and stats survive')
  // done todos lose bodies before active ones
  const firstActiveOmitted = fitted.todos.findIndex(t => t.phase === 'review' && t.diffs.some(d => d.hunkOmitted))
  if (firstActiveOmitted >= 0) assert.ok(fitted.todos.filter(t => t.phase === 'done').every(t => t.diffs.every(d => d.hunkOmitted)))
  // small snapshots pass through untouched
  const small = { todos: [todos[0]] }
  assert.equal(fitSnapshotBudget({ todos: [{ id: 'x', diffs: [] }] }).snapshotTrimmed, undefined)
  void small
})

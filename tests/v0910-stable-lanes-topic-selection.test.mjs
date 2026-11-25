import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sortLaneCards } from '../src/client/utils.js'

const card = (number, createdAt, updatedAt, extra = {}) => ({ id: `td-${number}`, number, createdAt, updatedAt, ...extra })

test('v0.9.10: 执行中 cards keep creation order no matter how often a running build bumps updatedAt', () => {
  const a = card(3, 100, 900)
  const b = card(5, 200, 950)
  const c = card(7, 300, 120)
  const first = sortLaneCards([b, c, a], 'doing').map(t => t.number)
  assert.deepEqual(first, [3, 5, 7])
  // Simulate live updates: updatedAt changes on every event, order must not move.
  for (let i = 0; i < 20; i++) {
    a.updatedAt = 1000 + Math.random() * 1000
    b.updatedAt = 1000 + Math.random() * 1000
    c.updatedAt = 1000 + Math.random() * 1000
    assert.deepEqual(sortLaneCards([c, a, b], 'doing').map(t => t.number), [3, 5, 7])
  }
  assert.deepEqual(sortLaneCards([card(9, 50, 1), card(2, 50, 2)], 'todo').map(t => t.number), [2, 9], '#number breaks ties')
  assert.deepEqual(sortLaneCards([card(1, 10, 100), card(2, 20, 300)], 'done').map(t => t.number), [2, 1], '已完成: newest finish on top')
})

test('v0.9.10: board lanes use sortLaneCards; confirm lane keeps human-first with stable creation order', () => {
  const board = readFileSync(new URL('../src/client/components/KanbanBoard.jsx', import.meta.url), 'utf8')
  assert.match(board, /sortLaneCards\(filtered\.filter\(td => mapPhaseToColumn\(td\) === col\.id\), col\.id\)/)
})

test('v0.9.10: a running topic never looks selected, and selected stays distinct while running', () => {
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  const last = rx => { const all = [...css.matchAll(rx)]; return all.length ? all[all.length - 1][1] : '' }
  assert.match(last(/\.ot-nav-item\.is-topic-running \{([^}]*)\}/g), /background:\s*transparent/)
  const active = last(/\.ot-nav-item\.is-active,\s*\n\.ot-nav-item\.is-active\.is-topic-running \{([^}]*)\}/g)
  // v0.9.40 (Todo #20): rail token is --ek-nav-rail (= --ek-brand); fill is the neutral --ek-nav-selected step
  assert.match(active, /inset 3px 0 0 var\(--ek-nav-rail\)/, 'selected has a solid brand rail')
  assert.match(css, /--ek-nav-rail:\s*var\(--ek-brand\)/, 'the rail token is the brand colour')
  assert.match(active, /background:\s*var\(--ek-nav-selected\)/)
  // the selected rule must come after every running rule so it wins the cascade
  assert.ok(css.lastIndexOf('.ot-nav-item.is-active.is-topic-running') > css.lastIndexOf('.ot-nav-item.is-topic-running { background'))
})

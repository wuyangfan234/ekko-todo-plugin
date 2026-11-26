// v0.9.61: on phones the task detail title sat between the back button and the three header actions,
// 101px wide on a 390px screen, so an ordinary title wrapped to 7 lines. Phones now put back + actions
// on the first row and give the title the full width; desktop keeps the original row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const jsx = readFileSync(new URL('../src/client/components/TodoDrawer.jsx', import.meta.url), 'utf8')

function mediaBlocks(text) {
  const out = []; let i = 0
  while (true) {
    const at = text.indexOf('@media', i); if (at < 0) break
    const open = text.indexOf('{', at); let j = open + 1, d = 1
    while (d > 0) { if (text[j] === '{') d++; else if (text[j] === '}') d--; j++ }
    out.push([text.slice(at, open).trim(), text.slice(open + 1, j - 1), text.slice(at, j)]); i = j
  }
  return out
}
const media = mediaBlocks(css)
const phone = media.filter(([q]) => q === '@media (max-width: 780px)').map(b => b[1]).join('\n')
let desktop = css; for (const b of media) desktop = desktop.replace(b[2], '')
function lastDecl(text, sel, prop) {
  let val = null
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map(s => s.trim()).includes(sel)) continue
    for (const d of m[2].split(';')) { const k = d.indexOf(':'); if (k > 0 && d.slice(0, k).trim() === prop) val = d.slice(k + 1).trim() }
  }
  return val
}

test('v0.9.61: header parts carry classes instead of inline layout', () => {
  assert.match(jsx, /<div className="ot-dialog-head ot-task-head">\s*<div className="ot-task-head-main">/)
  assert.match(jsx, /<div className="ot-task-head-info">/)
  assert.match(jsx, /<div className="ot-task-head-actions">/)
  assert.doesNotMatch(jsx, /alignItems: 'flex-start', gap: 8, minWidth: 0, flex: 1/, 'inline flex row removed (it would beat the phone grid)')
})

test('v0.9.61: desktop keeps the one-row header', () => {
  assert.equal(lastDecl(desktop, '.ot-task-head-main', 'display'), 'flex')
  assert.equal(lastDecl(desktop, '.ot-task-head-main', 'flex'), '1')
  assert.equal(lastDecl(desktop, '.ot-task-head-actions', 'flex'), 'none')
  assert.equal(lastDecl(desktop, '.ot-task-head', 'display'), null, 'desktop does not switch to grid')
})

test('v0.9.61: phones give the title its own full-width row', () => {
  assert.equal(lastDecl(phone, '.ot-task-head', 'display'), 'grid')
  assert.equal(lastDecl(phone, '.ot-task-head', 'grid-template-areas'), '"back . actions" "info info info"')
  assert.equal(lastDecl(phone, '.ot-task-head-main', 'display'), 'contents')
  assert.equal(lastDecl(phone, '.ot-task-head .ot-mobile-back-btn', 'grid-area'), 'back')
  assert.equal(lastDecl(phone, '.ot-task-head-info', 'grid-area'), 'info')
  assert.equal(lastDecl(phone, '.ot-task-head-actions', 'grid-area'), 'actions')
})

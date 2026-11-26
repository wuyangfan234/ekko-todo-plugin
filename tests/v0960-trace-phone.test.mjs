// v0.9.60: on phones the run-record timeline was buried under the session list and six stat tiles
// (165px of a 390x844 screen, 36px of 375x667). The list now folds behind a one-line switcher and the stats
// become a single swipeable row. Desktop layout is untouched (the switcher is display:none above 780px).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const jsx = readFileSync(new URL('../src/client/components/SessionTraceView.jsx', import.meta.url), 'utf8')

function blocks(text) {
  const out = []; let i = 0
  while (true) {
    const at = text.indexOf('@media', i); if (at < 0) break
    const q = text.slice(at, text.indexOf('{', at)).trim()
    let j = text.indexOf('{', at) + 1, d = 1
    while (d > 0) { if (text[j] === '{') d++; else if (text[j] === '}') d--; j++ }
    out.push([q, text.slice(text.indexOf('{', at) + 1, j - 1)]); i = j
  }
  return out
}
const phone = blocks(css).filter(([q]) => q === '@media (max-width: 780px)').map(b => b[1]).join('\n')
let desktop = css; for (const [q, b] of blocks(css)) desktop = desktop.replace(b, '')
function lastDecl(text, sel, prop) {
  let val = null
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map(s => s.trim()).includes(sel)) continue
    for (const d of m[2].split(';')) { const k = d.indexOf(':'); if (k > 0 && d.slice(0, k).trim() === prop) val = d.slice(k + 1).trim() }
  }
  return val
}

test('v0.9.60: phones fold the session list behind a switcher; desktop never shows the switcher', () => {
  assert.equal(lastDecl(desktop, '.ek-trace-side-toggle', 'display'), 'none', 'switcher hidden on desktop')
  assert.equal(lastDecl(phone, '.ek-trace-side-toggle', 'display'), 'flex', 'switcher shown on phones')
  assert.ok(Number(lastDecl(phone, '.ek-trace-side-toggle', 'min-height').replace('px', '')) >= 40)
  assert.equal(lastDecl(phone, '.ek-trace-side:not(.is-open) .ek-trace-list', 'display'), 'none')
  assert.equal(lastDecl(phone, '.ek-trace-side:not(.is-open) .ek-trace-kind-tabs', 'display'), 'none')
  assert.equal(lastDecl(phone, '.ek-trace-side.is-open + .ek-trace-main', 'display'), 'none', 'open list takes the screen')
})

test('v0.9.60: phone stats are one swipeable row, not a 2x3 block', () => {
  assert.equal(lastDecl(phone, '.ek-trace-stats', 'display'), 'flex')
  assert.equal(lastDecl(phone, '.ek-trace-stats', 'overflow-x'), 'auto')
  assert.equal(lastDecl(phone, '.ek-trace-stats > div', 'flex'), 'none')
  assert.match(lastDecl(phone, '.ek-trace-stats', 'mask-image') || '', /linear-gradient/, 'edge fade signals more tiles')
})

test('v0.9.60: list state wiring — open until a session is chosen, closes on pick, toggle flips it', () => {
  assert.match(jsx, /const \[listOpen, setListOpen\] = useState\(false\)/)
  assert.match(jsx, /className=\{`ek-trace-side \$\{listOpen \|\| !selectedId \? 'is-open' : ''\}`\}/)
  assert.match(jsx, /setSelectedId\(s\.sessionId\); setListOpen\(false\)/)
  assert.match(jsx, /onClick=\{\(\) => setListOpen\(v => !v\)\}/)
  assert.match(jsx, /aria-expanded=\{listOpen \|\| !selectedId\}/)
})

// v0.9.59 UI audit: content panels must not repeat the navigation sidebar colour, card footers must fit,
// and the audit's small hit targets are raised. Colours are checked by evaluating the real token formulas
// with the host's light and dark values, not by matching CSS text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const kanban = readFileSync(new URL('../src/client/components/KanbanBoard.jsx', import.meta.url), 'utf8')

const bodyStart = css.indexOf('\nbody {')
const tokensCss = css.slice(0, bodyStart)
const bodyCss = css.slice(bodyStart)
const darkStart = tokensCss.indexOf(':root[data-scheme="dark"]')
const lightTokens = tokensCss.slice(0, darkStart)
const darkTokens = tokensCss.slice(darkStart)

function stripMedia(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const at = text.indexOf('@media', i)
    if (at < 0) { out += text.slice(i); break }
    out += text.slice(i, at)
    let j = text.indexOf('{', at) + 1
    let depth = 1
    while (depth > 0 && j < text.length) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++ }
    i = j
  }
  return out
}
const desktopCss = stripMedia(bodyCss)
const phoneCss = [...bodyCss.matchAll(/@media \(max-width: 780px\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n')

// Last value a selector list containing `sel` declares for `prop`, in cascade (file) order.
function lastDecl(text, sel, prop) {
  let val = null
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map(s => s.trim())
    if (!sels.includes(sel)) continue
    for (const d of m[2].split(';')) {
      const k = d.indexOf(':')
      if (k > 0 && d.slice(0, k).trim() === prop) val = d.slice(k + 1).trim()
    }
  }
  return val
}

function tokenValue(block, name) {
  const m = block.match(new RegExp(`\\n\\s*${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

// Host palettes as delivered by the Studio theme bridge (measured on the live board).
const HOST = {
  light: { '--ot-canvas': [255, 255, 255], '--ot-text': [26, 26, 26] },
  dark: { '--ot-canvas': [42, 42, 42], '--ot-text': [224, 224, 224] },
}
const BLACK = [0, 0, 0]

function evalColor(expr, scheme, block) {
  expr = expr.trim()
  if (expr === '#000000' || expr === '#000') return BLACK
  const v = expr.match(/^var\((--[\w-]+)\)$/)
  if (v) {
    if (HOST[scheme][v[1]]) return HOST[scheme][v[1]]
    const t = tokenValue(block, v[1]) ?? tokenValue(lightTokens, v[1])
    assert.ok(t, `token ${v[1]} defined`)
    return evalColor(t, scheme, block)
  }
  const mix = expr.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+?)(?:\s+([\d.]+)%)?\)$/)
  assert.ok(mix, `understood colour expression: ${expr}`)
  const a = evalColor(mix[1], scheme, block)
  const b = evalColor(mix[3], scheme, block)
  const pa = Number(mix[2]) / 100
  const pb = mix[4] ? Number(mix[4]) / 100 : 1 - pa
  assert.ok(Math.abs(pa + pb - 1) < 1e-6, `opaque mix (weights sum to 100%): ${expr}`)
  return a.map((c, i) => c * pa + b[i] * pb)
}
const dist = (x, y) => Math.hypot(...x.map((c, i) => c - y[i]))

test('v0.9.59: content-area panels no longer paint the navigation sidebar colour', () => {
  assert.equal((bodyCss.match(/var\(--ot-sidebar\)/g) || []).length, 0, 'no rule outside :root uses --ot-sidebar')
  for (const [scheme, block] of [['light', lightTokens], ['dark', darkTokens]]) {
    const surface = tokenValue(block, '--ot-surface-2')
    assert.ok(surface, `--ot-surface-2 defined for ${scheme}`)
    const nav = evalColor('var(--ek-nav-bg)', scheme, block)
    const inset = evalColor(surface, scheme, block)
    const canvas = HOST[scheme]['--ot-canvas']
    assert.ok(dist(nav, inset) >= 3, `${scheme}: inset surface differs from the sidebar (${inset.map(Math.round)} vs ${nav.map(Math.round)})`)
    assert.ok(dist(canvas, inset) >= 3, `${scheme}: inset surface differs from the canvas`)
    assert.equal(tokenValue(block, '--ek-surface-dim'), 'var(--ot-surface-2)', `${scheme}: --ek-surface-dim follows the inset surface`)
  }
})

test('v0.9.59: quota strip, agent list and run list resolve to non-sidebar surfaces in both themes', () => {
  const cases = [
    ['.ot-home-quota-strip', 'var(--ot-canvas)'],
    ['.ek-trace-side', 'var(--ot-canvas)'],
    ['.ot-am-list', 'var(--ot-surface-2)'],
    ['.ot-brief-card', 'var(--ot-surface-2)'],
    ['.ot-drawer--left', 'var(--ek-nav-bg)'],
  ]
  for (const [sel, want] of cases) {
    const got = lastDecl(desktopCss, sel, 'background')
    assert.equal(got, want, `${sel} final background`)
  }
  for (const [scheme, block] of [['light', lightTokens], ['dark', darkTokens]]) {
    const nav = evalColor('var(--ek-nav-bg)', scheme, block)
    for (const sel of ['.ot-home-quota-strip', '.ek-trace-side', '.ot-am-list', '.ot-brief-card']) {
      const c = evalColor(lastDecl(desktopCss, sel, 'background'), scheme, block)
      assert.ok(dist(c, nav) >= 3, `${scheme}: ${sel} (${c.map(Math.round)}) is not the sidebar colour (${nav.map(Math.round)})`)
    }
  }
})

test('v0.9.59: dividers next to same-colour areas use the header line, not the faint soft border', () => {
  assert.equal(lastDecl(desktopCss, '.ot-home-quota-strip', 'border-bottom-color'), 'var(--ek-line)')
  assert.equal(lastDecl(desktopCss, '.ot-mobile-bar', 'border-bottom-color'), 'var(--ek-line)')
  assert.equal(lastDecl(desktopCss, '.ot-proj-tree-col', 'border-right-color'), 'var(--ek-line)')
  assert.equal(lastDecl(desktopCss, '.ek-trace-side', 'border-right-color'), 'var(--ek-line)')
  assert.equal(lastDecl(phoneCss, '.ek-trace-side', 'border-bottom-color'), 'var(--ek-line)')
})

test('v0.9.59: board card footer keeps the time whole and drops the agent pill chrome', () => {
  assert.match(kanban, /<span className="ot-card-time">\{formatSidebarAge\(td\.updatedAt\)\}<\/span>/, 'card time uses the short age (no trailing 前)')
  assert.equal(lastDecl(desktopCss, '.ot-card-time', 'flex'), 'none')
  assert.equal(lastDecl(desktopCss, '.ot-card-agent', 'flex'), '0 1 auto')
  assert.equal(lastDecl(desktopCss, '.ot-card-agent', 'padding'), '0')
  assert.equal(lastDecl(desktopCss, '.ot-card-agent', 'background'), 'transparent')
  assert.equal(lastDecl(desktopCss, '.ot-card-row3', 'gap'), '4px')
})

test('v0.9.59: audit hit targets reach 28px on desktop and 40px on phones', () => {
  const px = v => Number(String(v).replace('px', ''))
  assert.ok(px(lastDecl(desktopCss, '.ot-brief-toggle', 'min-height')) >= 28)
  assert.ok(px(lastDecl(desktopCss, '.ot-brief-toggle', 'min-width')) >= 28)
  assert.ok(px(lastDecl(desktopCss, '.ot-branch-trigger', 'height')) >= 28)
  assert.ok(px(lastDecl(desktopCss, '.ot-proj-seg-tab', 'min-height')) >= 28)
  assert.ok(px(lastDecl(desktopCss, '.ot-proj-view-btn', 'min-height')) >= 28)
  for (const [sel, prop] of [['.ot-tree-filter-input', 'min-height'], ['.ot-engine-strip-trigger', 'min-height'], ['.ot-brief-toggle', 'min-height'], ['.ot-branch-trigger', 'height']]) {
    assert.ok(px(lastDecl(phoneCss, sel, prop)) >= 40, `${sel} ${prop} >= 40 on phones`)
  }
})

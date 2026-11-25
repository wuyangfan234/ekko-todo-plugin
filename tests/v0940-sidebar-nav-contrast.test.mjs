import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Todo #20: the selected topic in the sidebar could not be told apart from the other rows, the hover row
// looked like the selected one, the sidebar ran into the chat area, and the system navigation at the bottom
// (quota / schedules / trace / Agent / settings) looked like more topic rows. These checks resolve the colours the
// stylesheet actually ends up using (last matching top-level rule, :root tokens, host fallbacks) and measure
// WCAG contrast ratios, so a change that only renames a token cannot pass.

const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')

// ── tiny CSS reader ───────────────────────────────────────────────────────────
function topLevelRules(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const head = src.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, '').trim()
    let depth = 1
    let j = open + 1
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') depth--
      j++
    }
    const body = src.slice(open + 1, j - 1)
    if (!head.startsWith('@')) out.push({ selectors: head.split(',').map(s => s.trim()), body })
    i = j
  }
  return out
}
const rules = topLevelRules(css)
const decls = body => {
  const list = []
  for (const part of body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const k = part.indexOf(':')
    if (k < 0) continue
    list.push([part.slice(0, k).trim(), part.slice(k + 1).trim().replace(/\s*!important$/, '')])
  }
  return list
}
/** Last value of any of `props` across every top-level rule whose selector list contains `selector`. */
function effective(selector, props) {
  let value = ''
  for (const r of rules) {
    if (!r.selectors.includes(selector)) continue
    for (const [k, v] of decls(r.body)) if (props.includes(k)) value = v
  }
  return value
}
function tokens(scheme) {
  const map = {}
  for (const r of rules) {
    const sel = r.selectors.join(',')
    const take = sel === ':root' || (scheme === 'dark' && sel === ':root[data-scheme="dark"]')
    if (!take) continue
    for (const [k, v] of decls(r.body)) if (k.startsWith('--')) map[k] = v
  }
  return map
}

// ── colour maths (sRGB, premultiplied color-mix, WCAG 2 contrast) ─────────────
function splitTop(s) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}
function resolve(expr, vars, seen = 0) {
  assert.ok(seen < 40, `runaway var() chain for ${expr}`)
  const e = expr.trim()
  if (e === 'transparent') return [0, 0, 0, 0]
  let m = e.match(/^#([0-9a-f]{6})$/i)
  if (m) return [0, 2, 4].map(k => parseInt(m[1].slice(k, k + 2), 16)).concat(1)
  m = e.match(/^rgba?\(([^)]*)\)$/)
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] }
  m = e.match(/^var\((--[\w-]+)\s*(?:,([\s\S]*))?\)$/)
  if (m) {
    if (vars[m[1]] !== undefined) return resolve(vars[m[1]], vars, seen + 1)
    assert.ok(m[2] !== undefined, `${m[1]} is not defined and has no fallback`)
    return resolve(m[2], vars, seen + 1)
  }
  m = e.match(/^color-mix\(([\s\S]*)\)$/)
  if (m) {
    const [space, a, b] = splitTop(m[1])
    assert.equal(space, 'in srgb')
    const arg = s => { const mm = s.match(/^([\s\S]*?)\s+([\d.]+)%$/); return mm ? [mm[1], Number(mm[2])] : [s, null] }
    let [ca, pa] = arg(a)
    let [cb, pb] = arg(b)
    if (pa === null && pb === null) { pa = 50; pb = 50 } else if (pa === null) pa = 100 - pb; else if (pb === null) pb = 100 - pa
    const sum = pa + pb
    const A = resolve(ca, vars, seen + 1)
    const B = resolve(cb, vars, seen + 1)
    const wa = pa / sum
    const wb = pb / sum
    const alpha = A[3] * wa + B[3] * wb
    const rgb = alpha === 0 ? [0, 0, 0] : [0, 1, 2].map(k => (A[k] * A[3] * wa + B[k] * B[3] * wb) / alpha)
    return [...rgb, alpha * Math.min(sum, 100) / 100]
  }
  throw new Error(`cannot resolve colour: ${e}`)
}
const over = (top, under) => {
  const a = top[3]
  return [0, 1, 2].map(k => top[k] * a + under[k] * (1 - a)).concat(1)
}
const lum = c => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const hex = c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('')

// The stylesheet is driven by host theme variables. Every check runs twice: with the plugin's own fallbacks
// (no host variable set) and with a sample host theme (the values in the Web UI stylesheet on the development
// machine), because a step that is measurable on one set of base colours can vanish on another.
const HOST_SAMPLE = {
  light: { '--bg-card': '#ffffff', '--bg-secondary': '#f0f0f0', '--text-primary': '#1a1a1a', '--text-secondary': '#666666', '--text-muted': '#999999', '--border-color': '#e0e0e0', '--border-light': '#ebebeb' },
  dark: { '--bg-card': '#2a2a2a', '--bg-secondary': '#252525', '--text-primary': '#e0e0e0', '--text-secondary': '#a0a0a0', '--text-muted': '#888888', '--border-color': '#3a3a3a', '--border-light': '#333333' },
}
const CASES = []
for (const scheme of ['light', 'dark']) for (const theme of ['fallback', 'host sample']) CASES.push({ scheme, theme, name: `${scheme}, ${theme}` })

function measure({ scheme, theme }) {
  const vars = { ...tokens(scheme), ...(theme === 'host sample' ? HOST_SAMPLE[scheme] : {}) }
  const canvas = over(resolve('var(--ot-canvas)', vars), [255, 255, 255, 1])
  const sidebarExpr = effective('.ot-left', ['background', 'background-color'])
  const hoverExpr = effective('.ot-nav-item:hover', ['background', 'background-color'])
  const selectedExpr = effective('.ot-nav-item.is-active', ['background', 'background-color'])
  const shadow = effective('.ot-nav-item.is-active', ['box-shadow'])
  const rail = shadow.match(/inset 3px 0 0 (var\([^)]*\)|#[0-9a-f]{6})/i)
  let borderExpr = ''
  for (const r of rules) {
    if (!r.selectors.includes('.ot-left')) continue
    for (const [k, v] of decls(r.body)) {
      if (k === 'border-right-color') borderExpr = v
      if (k === 'border-right') borderExpr = v.replace(/^\s*[\d.]+px\s+solid\s+/, '')
    }
  }
  const sidebar = over(resolve(sidebarExpr, vars), canvas)
  const hover = over(resolve(hoverExpr, vars), sidebar)
  const selected = over(resolve(selectedExpr, vars), sidebar)
  const line = over(resolve(borderExpr, vars), sidebar)
  return {
    sidebarExpr, hoverExpr, selectedExpr, borderExpr, shadow,
    railExpr: rail ? rail[1] : '',
    rail: rail ? over(resolve(rail[1], vars), sidebar) : null,
    canvas, sidebar, hover, selected, line,
    weight: Number(effective('.ot-nav-item.is-active', ['font-weight']) || 400),
    vars,
  }
}
const railOf = shadow => { const r = shadow.match(/inset 3px 0 0 (var\([^)]*\)|#[0-9a-f]{6})/i); return r ? r[1] : '' }
/** The system navigation at the bottom of the sidebar (.ot-left-foot). A foot rule that is missing falls back to the row rule. */
function measureSystem(c) {
  const m = measure(c)
  const pick = (footSel, rowSel, props) => effective(footSel, props) || effective(rowSel, props)
  const idleFgExpr = pick('.ot-left-foot .ot-nav-item', '.ot-nav-item', ['color'])
  const topicFgExpr = pick('.ot-left-scroll .ot-nav-item', '.ot-nav-item', ['color'])
  const selectedExpr = pick('.ot-left-foot .ot-nav-item.is-active', '.ot-nav-item.is-active', ['background', 'background-color'])
  const shadow = pick('.ot-left-foot .ot-nav-item.is-active', '.ot-nav-item.is-active', ['box-shadow'])
  const railExpr = railOf(shadow)
  let lineExpr = ''
  for (const r of rules) {
    if (!r.selectors.includes('.ot-left-foot')) continue
    for (const [k, v] of decls(r.body)) {
      if (k === 'border-top-color') lineExpr = v
      if (k === 'border-top') lineExpr = v.replace(/^\s*[\d.]+px\s+solid\s+/, '')
    }
  }
  return {
    ...m, idleFgExpr, topicFgExpr, lineExpr, shadow, railExpr,
    idleFg: over(resolve(idleFgExpr, m.vars), m.sidebar),
    topicFg: over(resolve(topicFgExpr, m.vars), m.sidebar),
    sysSelected: over(resolve(selectedExpr, m.vars), m.sidebar),
    sysRail: railExpr ? over(resolve(railExpr, m.vars), m.sidebar) : null,
    footLine: over(resolve(lineExpr, m.vars), m.sidebar),
    sysWeight: Number(pick('.ot-left-foot .ot-nav-item.is-active', '.ot-nav-item.is-active', ['font-weight']) || 400),
  }
}

for (const c of CASES) {
  test(`v0.9.40 (${c.name}): the selected topic row stands out from the sidebar, with a brand rail and heavier text`, () => {
    const m = measure(c)
    const ratio = contrast(m.selected, m.sidebar)
    assert.ok(ratio >= 1.2, `selected ${hex(m.selected)} vs sidebar ${hex(m.sidebar)} is ${ratio.toFixed(3)}:1, needs >= 1.2:1`)
    assert.ok(m.rail, `selected row has a 3px left rail (box-shadow was: ${m.shadow})`)
    const railRatio = contrast(m.rail, m.sidebar)
    assert.ok(railRatio >= 3, `rail ${hex(m.rail)} vs sidebar ${hex(m.sidebar)} is ${railRatio.toFixed(2)}:1, needs >= 3:1`)
    // The rail must be the brand colour itself: any other colour with >= 3:1 (for example --ek-sage) fails here.
    const brand = resolve('var(--ek-brand)', m.vars)
    assert.equal(hex(m.rail), hex(brand), `rail ${hex(m.rail)} must be the brand colour ${hex(brand)}`)
    assert.ok(m.weight >= 600, 'selection is not colour-only: the label is heavier')
    // Solid neutral fill: opaque, and the three channels stay within 8 of each other (no tint).
    assert.equal(resolve(m.selectedExpr, m.vars)[3], 1, `the selected fill is opaque (was: ${m.selectedExpr})`)
    const rgb = m.selected.slice(0, 3)
    const spread = Math.max(...rgb) - Math.min(...rgb)
    assert.ok(spread <= 8, `selected fill ${hex(m.selected)} is neutral: channel spread ${spread.toFixed(1)}, needs <= 8`)
  })

  test(`v0.9.40 (${c.name}): hover is a visible step that is clearly weaker than selected, and not the selected colour`, () => {
    const m = measure(c)
    assert.notEqual(m.hoverExpr, m.selectedExpr, 'hover and selected must not share one value')
    assert.notEqual(hex(m.hover), hex(m.selected), 'hover and selected resolve to different colours')
    const hover = contrast(m.hover, m.sidebar)
    const selected = contrast(m.selected, m.sidebar)
    assert.ok(hover >= 1.05, `hover ${hex(m.hover)} is visible on the sidebar (${hover.toFixed(3)}:1)`)
    assert.ok(hover < selected, `hover (${hover.toFixed(3)}:1) stays weaker than selected (${selected.toFixed(3)}:1)`)
    assert.ok(selected - hover >= 0.08, `hover (${hover.toFixed(3)}:1) is clearly weaker than selected (${selected.toFixed(3)}:1): the gap is ${(selected - hover).toFixed(3)}, needs >= 0.08`)
  })

  test(`v0.9.40 (${c.name}): the sidebar has a visible edge against the main area`, () => {
    const m = measure(c)
    assert.ok(!/--ot-border-soft/.test(m.borderExpr), 'no longer the 68%-alpha soft border')
    assert.equal(resolve(m.borderExpr, m.vars)[3], 1, `the edge is an opaque colour, not an alpha line (was: ${m.borderExpr})`)
    const edge = contrast(m.line, m.canvas)
    assert.ok(edge >= 1.25, `separator ${hex(m.line)} vs main ${hex(m.canvas)} is ${edge.toFixed(3)}:1, needs >= 1.25:1`)
    assert.notEqual(hex(m.sidebar), hex(m.canvas), 'the sidebar is a different surface from the main area')
  })
}

for (const c of CASES) {
  test(`v0.9.40 (${c.name}): the system navigation is split from the topics by a visible line and sits one step lower`, () => {
    const s = measureSystem(c)
    assert.ok(!/--ot-border-soft|--ek-line\b/.test(s.lineExpr), `the foot separator is an opaque line (was: ${s.lineExpr})`)
    const line = contrast(s.footLine, s.sidebar)
    assert.ok(line >= 1.15, `foot separator ${hex(s.footLine)} vs sidebar ${hex(s.sidebar)} is ${line.toFixed(3)}:1, needs >= 1.15:1`)
    const sys = contrast(s.idleFg, s.sidebar)
    const topic = contrast(s.topicFg, s.sidebar)
    assert.ok(sys >= 4.5, `system nav text ${hex(s.idleFg)} stays readable on the sidebar (${sys.toFixed(2)}:1, needs >= 4.5:1)`)
    assert.ok(sys <= topic * 0.85, `system nav text (${sys.toFixed(2)}:1) is a step quieter than topic text (${topic.toFixed(2)}:1)`)
  })

  test(`v0.9.40 (${c.name}): a selected system item does not look like a selected topic, and is not colour-only either`, () => {
    const s = measureSystem(c)
    assert.ok(s.sysRail, `selected system item has a 3px left rail (box-shadow was: ${s.shadow})`)
    assert.notEqual(hex(s.sysRail), hex(s.rail), 'the system rail is not the brand rail of a selected topic')
    const rail = contrast(s.sysRail, s.sidebar)
    assert.ok(rail >= 3, `system rail ${hex(s.sysRail)} vs sidebar ${hex(s.sidebar)} is ${rail.toFixed(2)}:1, needs >= 3:1`)
    const fill = contrast(s.sysSelected, s.sidebar)
    assert.ok(fill >= 1.2, `selected system item ${hex(s.sysSelected)} vs sidebar is ${fill.toFixed(3)}:1, needs >= 1.2:1`)
    assert.ok(s.sysWeight >= 600, 'selected system item uses heavier text')
    assert.notEqual(hex(s.sysSelected), hex(s.hover), 'selected system item is not the hover colour')
  })
}

test('v0.9.40: running is still not a selection, and the phone drawer tabs keep a rail of their own', () => {
  assert.equal(effective('.ot-nav-item.is-topic-running', ['background', 'background-color']), 'transparent', 'a running topic has no fill')
  assert.match(effective('.ot-nav-item.is-active.is-topic-running', ['box-shadow']), /inset 3px 0 0 var\(--ek-nav-rail\)/, 'a selected running topic keeps the brand rail')
  assert.match(effective('.ot-left-foot--tabs .ot-nav-item.is-active', ['box-shadow']), /^inset 0 3px 0 var\(--ek-nav-system-rail\)$/, 'drawer tabs: the rail is on top, in the system colour')
})

test('v0.9.40: sidebar groups are separated by a thin line, not a block of same-colour space', () => {
  const groupBorder = effective('.ot-left-scroll > div + div', ['border-top'])
  assert.match(groupBorder, /^1px solid var\(--ek-nav-line\)$/)
  assert.match(effective('.ot-left-foot', ['border-top-color', 'border-top']), /var\(--ek-nav-line\)/, 'the nav group below the topics uses the same line')
  // Touch targets: the phone rules that make rows 40px tall must still come after the desktop rule.
  const phone = css.lastIndexOf('@media (max-width: 780px)')
  assert.ok(phone > css.lastIndexOf('.ot-nav-item.is-active,'), 'phone hit-area rules still win the cascade')
})

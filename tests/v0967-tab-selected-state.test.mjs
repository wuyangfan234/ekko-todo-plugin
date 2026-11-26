// Todo #59: the four drawer tabs (概览与方案 / 执行对话 / 代码 Diff / 状态记录) share .ot-tabs-trigger.
// The selected tab must be unmistakable in both host themes. Colours are evaluated from the real token
// formulas (same host palette as tests/v0959-ui-surfaces.test.mjs), not by matching CSS text.
//
// How each value resolves (light / dark):
//   tab bar background   .ot-tabs-list has no background -> inherits .ot-drawer `var(--ot-canvas)` -> HOST canvas
//                        (255,255,255) / (42,42,42)
//   selected text        `var(--ot-text)` -> HOST text (26,26,26) / (224,224,224)
//   unselected text      `var(--ot-text-2)` -> `var(--text-secondary, #52525b)` / `var(--text-secondary, #c2c2cc)`;
//                        the host bridge does not set --text-secondary in HOST, so the fallback applies
//   indicator            `var(--ek-brand)` -> #1A65B0 / #5AAEF0
//   selected fill        `var(--ek-selected)` -> color-mix(brand 10% / 16%, transparent), composited over the bar
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

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

// Host palettes as delivered by the Studio theme bridge (same values as v0959).
const HOST = {
  light: { '--ot-canvas': [255, 255, 255], '--ot-text': [26, 26, 26] },
  dark: { '--ot-canvas': [42, 42, 42], '--ot-text': [224, 224, 224] },
}

// Returns [r, g, b, a]. `transparent` is alpha 0 so it can be composited later.
function evalColor(expr, scheme) {
  const block = scheme === 'dark' ? darkTokens : lightTokens
  expr = expr.trim()
  if (expr === 'transparent') return [0, 0, 0, 0]
  const hex = expr.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1]
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(1)
  }
  const v = expr.match(/^var\((--[\w-]+)(?:,\s*([\s\S]+))?\)$/)
  if (v) {
    if (HOST[scheme][v[1]]) return HOST[scheme][v[1]].concat(1)
    const t = tokenValue(block, v[1]) ?? tokenValue(lightTokens, v[1])
    if (t) return evalColor(t, scheme)
    assert.ok(v[2], `token ${v[1]} defined or has a fallback`)
    return evalColor(v[2], scheme)
  }
  const mix = expr.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+?)(?:\s+([\d.]+)%)?\)$/)
  assert.ok(mix, `understood colour expression: ${expr}`)
  const a = evalColor(mix[1], scheme)
  const b = evalColor(mix[3], scheme)
  const pa = Number(mix[2]) / 100
  const pb = mix[4] ? Number(mix[4]) / 100 : 1 - pa
  // Premultiplied sRGB interpolation, as color-mix() does.
  const alpha = a[3] * pa + b[3] * pb
  if (alpha === 0) return [0, 0, 0, 0]
  return [0, 1, 2].map(i => (a[i] * a[3] * pa + b[i] * b[3] * pb) / alpha).concat(alpha)
}
const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1)
const lum = c => {
  const [r, g, b] = c.slice(0, 3).map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05) }
const dist = (x, y) => Math.hypot(...[0, 1, 2].map(i => x[i] - y[i]))

const BASE = '.ot-tabs-trigger'
const ACTIVE = '.ot-tabs-trigger[data-state="active"]'
const decl = (sel, prop) => lastDecl(desktopCss, sel, prop)
const activeDecl = prop => decl(ACTIVE, prop) ?? decl(BASE, prop)

function resolved(scheme) {
  assert.equal(decl('.ot-tabs-list', 'background'), null, 'tab bar paints nothing; it shows the drawer surface')
  const bar = evalColor(decl('.ot-drawer', 'background'), scheme)
  const activeBg = over(evalColor(activeDecl('background') ?? 'transparent', scheme), bar)
  return {
    bar,
    activeBg,
    indicator: over(evalColor(decl(ACTIVE, 'border-bottom-color'), scheme), bar),
    activeText: over(evalColor(activeDecl('color'), scheme), activeBg),
    idleText: over(evalColor(decl(BASE, 'color'), scheme), bar),
  }
}

test('#59 a: the selected-tab indicator uses the brand colour, not the body-text ink', () => {
  assert.equal(decl(ACTIVE, 'border-bottom-color'), 'var(--ek-brand)')
})

for (const scheme of ['light', 'dark']) {
  test(`#59 b-d (${scheme}): indicator ≥ 3:1, selected and unselected labels ≥ 4.5:1`, () => {
    const r = resolved(scheme)
    const fmt = c => c.slice(0, 3).map(Math.round).join(',')
    const ind = contrast(r.indicator, r.bar)
    assert.ok(ind >= 3, `${scheme}: indicator ${fmt(r.indicator)} on bar ${fmt(r.bar)} = ${ind.toFixed(2)}:1`)
    const act = contrast(r.activeText, r.activeBg)
    assert.ok(act >= 4.5, `${scheme}: selected label ${fmt(r.activeText)} on ${fmt(r.activeBg)} = ${act.toFixed(2)}:1`)
    const idle = contrast(r.idleText, r.bar)
    assert.ok(idle >= 4.5, `${scheme}: unselected label ${fmt(r.idleText)} on ${fmt(r.bar)} = ${idle.toFixed(2)}:1`)
  })

  test(`#59 e (${scheme}): selected tab differs by a second channel besides colour (weight ≥ 600 or a fill)`, () => {
    const r = resolved(scheme)
    const weight = Number(activeDecl('font-weight'))
    const filled = dist(r.activeBg, r.bar) >= 3
    assert.ok(weight >= 600 || filled, `${scheme}: font-weight ${weight}, fill distance ${dist(r.activeBg, r.bar).toFixed(1)}`)
  })
}

test('#59: indicator ends stay square, tab labels do not shift on selection, phone hit target is kept', () => {
  const radius = decl(BASE, 'border-radius')
  assert.match(radius, /\s0\s+0$/, `bottom corners are square so the 2px underline is not clipped (${radius})`)
  // No width-changing property differs between the states, so counts like "(2)" do not jump.
  for (const prop of ['font-weight', 'padding', 'font-size', 'letter-spacing']) {
    assert.equal(activeDecl(prop), decl(BASE, prop), `${prop} is identical in both states`)
  }
  assert.equal(lastDecl(phoneCss, BASE, 'min-height'), '40px !important')
})

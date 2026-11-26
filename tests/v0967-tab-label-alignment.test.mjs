// Todo #60: #59 widened `.ot-tabs-trigger` to `padding: 0 10px` (from 0 2px) and set `.ot-tabs-list { gap: 0 }`
// so the selected fill does not hug the label. Two other surfaces share the class:
//   settings page        SettingsPanel.jsx  (list sits in .ot-settings-page, content in .ot-dialog-body)
//   add-project dialog   Dialogs.jsx        (list sits in .ot-modal, content in .ot-tab-panel > form > .ot-dialog-body)
//   task drawer          TodoDrawer.jsx     (list sits in .ot-drawer, content is the Tabs.Content .ot-dialog-body) — #65
// The first tab label must start at the same x as the content below it. Values are resolved from the real
// stylesheet with a small cascade (selector specificity, then file order), not by matching CSS text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const bodyCss = css.slice(css.indexOf('\nbody {'))

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

// Left-side value of a box property from one declaration (`padding`, `padding-left`, `padding-inline`, ...).
function leftOf(prop, value, side) {
  const v = value.replace(/!important/, '').trim().split(/\s+/)
  if (prop === `${side}-left` || prop === `${side}-inline-start`) return v[0]
  if (prop === `${side}-inline`) return v[0]
  if (prop === side) return v.length === 4 ? v[3] : v.length >= 2 ? v[1] : v[0]
  return null
}
const px = v => { if (v === '0') return 0; const m = String(v).match(/^(-?[\d.]+)px$/); assert.ok(m, `px length expected, got ${v}`); return Number(m[1]) }

// Resolved left padding/margin of an element with class `cls` inside ancestors `ancestors`.
// A rule applies when its selector is `.cls` or `<ancestor> .cls` (descendant combinator, one level is enough
// for the rules this stylesheet has); later rules of equal or higher specificity win.
function resolveLeft(text, cls, ancestors, side) {
  let best = null
  let order = 0
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    order++
    for (const sel of m[1].split(',').map(s => s.trim())) {
      const parts = sel.split(/\s+/)
      if (parts[parts.length - 1] !== cls) continue
      if (!parts.slice(0, -1).every(p => ancestors.includes(p))) continue
      const spec = parts.length
      for (const d of m[2].split(';')) {
        const k = d.indexOf(':')
        if (k <= 0) continue
        const val = leftOf(d.slice(0, k).trim(), d.slice(k + 1), side)
        if (val == null) continue
        if (!best || spec > best.spec || (spec === best.spec && order >= best.order)) best = { spec, order, val }
      }
    }
  }
  return best ? px(best.val) : 0
}

// x of the first tab label, measured from the same edge the content column starts from.
function surface(text, ancestors) {
  const list = { margin: resolveLeft(text, '.ot-tabs-list', ancestors, 'margin'), padding: resolveLeft(text, '.ot-tabs-list', ancestors, 'padding') }
  const trigger = resolveLeft(text, '.ot-tabs-trigger', [...ancestors, '.ot-tabs-list'], 'padding')
  const content = resolveLeft(text, '.ot-dialog-body', [...ancestors, '.ot-tab-panel'], 'padding')
  return { labelX: list.margin + list.padding + trigger, contentX: content, list, trigger }
}

const SURFACES = {
  settings: ['.ot-settings-page', '.ot-settings-inner'],
  'add-project dialog': ['.ot-modal'],
  // Todo #65: the task drawer (TodoDrawer.jsx) has the same list/body pair inside `.ot-drawer`.
  drawer: ['.ot-drawer'],
}

for (const [name, ancestors] of Object.entries(SURFACES)) {
  test(`#60 (${name}): first tab label starts at the content's left edge`, () => {
    const s = surface(desktopCss, ancestors)
    assert.equal(s.labelX, s.contentX, `${name}: label x ${s.labelX}px (list margin ${s.list.margin} + list padding ${s.list.padding} + trigger padding ${s.trigger}) vs content x ${s.contentX}px`)
  })
}

test('#60: phone layout does not re-introduce an offset on these surfaces', () => {
  for (const [name, ancestors] of Object.entries(SURFACES)) {
    const s = surface(desktopCss + '\n' + phoneCss, ancestors)
    assert.equal(s.labelX, s.contentX, `${name} (phone): label x ${s.labelX}px vs content x ${s.contentX}px`)
  }
})

test('#60: the #59 tab geometry is kept (10px trigger padding, no gap) — the selected fill depends on it', () => {
  const decl = (sel, prop) => {
    let val = null
    for (const m of desktopCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!m[1].split(',').map(s => s.trim()).includes(sel)) continue
      for (const d of m[2].split(';')) { const k = d.indexOf(':'); if (k > 0 && d.slice(0, k).trim() === prop) val = d.slice(k + 1).trim() }
    }
    return val
  }
  assert.equal(decl('.ot-tabs-trigger', 'padding'), '0 10px')
  assert.equal(decl('.ot-tabs-list', 'gap'), '0')
  // No surface-specific override may shrink a trigger's own padding: the fill must keep breathing room on both sides.
  for (const ancestors of [...Object.values(SURFACES), ['.ot-drawer']]) {
    assert.equal(resolveLeft(desktopCss, '.ot-tabs-trigger', [...ancestors, '.ot-tabs-list'], 'padding'), 10)
  }
  assert.doesNotMatch(desktopCss, /\.ot-tabs-trigger:first-child/, 'first tab is not special-cased')
})

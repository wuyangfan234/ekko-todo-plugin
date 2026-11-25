import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')

// The last max-width:780px block that styles the shared page header (quota / trace / schedules / agents).
function mobileHeaderBlock() {
  const blocks = css.split('@media (max-width: 780px) {').slice(1)
  const hit = blocks.filter(b => b.includes('.ot-hub-view .ot-proj-topbar,'))
  assert.ok(hit.length > 0, 'a mobile rule exists for the quota/schedules page header')
  return hit[hit.length - 1]
}

test('v0.9.25: phone quota header grows and wraps instead of a fixed 46px row', () => {
  const b = mobileHeaderBlock()
  assert.match(b, /\.ot-hub-view \.ot-proj-topbar,\s*\.ot-sch-view \.ot-proj-topbar \{[^}]*height: auto;[^}]*min-height: 46px;[^}]*flex-wrap: wrap;/)
  assert.match(b, /\.ot-proj-topbar-right \{[^}]*flex-wrap: wrap;[^}]*margin-left: auto;/)
})

test('v0.9.25: the 已开启 N / M count never wraps and is not padded to 40px', () => {
  const b = mobileHeaderBlock()
  assert.match(b, /\.ot-hub-count-pill \{ flex: none; white-space: nowrap; \}/)
  const pillRules = [...css.matchAll(/([^{}]*\.ot-hub-count-pill[^{}]*)\{([^}]*)\}/g)]
  for (const [, sel, body] of pillRules) assert.doesNotMatch(body, /min-height: 40px|height: 40px/, `pill rule ${sel.trim()} must not force 40px`)
})

test('v0.9.25: header title keeps a readable width and the refresh select border wraps its 40px select', () => {
  const b = mobileHeaderBlock()
  assert.match(b, /\.ot-proj-topbar-name \{ flex: 0 1 auto; min-width: 2\.5em; \}/)
  assert.match(b, /\.ot-hub-auto-select \{ height: auto; \}/)
  // touch targets still come from the shared 40px rules
  assert.match(css, /\.ot-icon-btn,\s*\.ot-send-circle \{\s*width: 40px !important;\s*height: 40px !important;/)
  assert.match(css, /\.ot-hub-select \{ min-height: 40px; \}/)
})

test('v0.9.25: the quota header still holds title, count and actions in that order', () => {
  const jsx = readFileSync(new URL('../src/client/components/QuotaHub.jsx', import.meta.url), 'utf8')
  const head = jsx.slice(jsx.indexOf('<header className="ot-proj-topbar">'), jsx.indexOf('</header>'))
  const iName = head.indexOf('ot-proj-topbar-name'), iPill = head.indexOf('ot-hub-count-pill'), iRight = head.indexOf('ot-proj-topbar-right')
  assert.ok(iName > 0 && iPill > iName && iRight > iPill)
})

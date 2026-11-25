import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { agentSectionsDefaultOpen, AGENT_SECTION_IDS, PHONE_MAX_WIDTH } from '../src/client/layout.js'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const read = rel => readFileSync(join(pkgRoot, rel), 'utf8')
const css = read('src/client/styles.css')
const jsx = read('src/client/components/AgentManager.jsx')
const noComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** Token header: everything before the first `body {` rule. */
function tokenHeader() {
  const i = css.indexOf('\nbody {')
  assert.ok(i > 0)
  return css.slice(0, i)
}
function tokenPx(name) {
  const m = tokenHeader().match(new RegExp(`${name}:\\s*([0-9.]+)px;`))
  assert.ok(m, `${name} is a plain px token in :root`)
  return Number(m[1])
}
/** The phone block of the Agent page: the last max-width:780px block that re-points the type tokens. */
function agentPhoneBlock() {
  const blocks = css.split('@media (max-width: 780px) {').slice(1)
  const hit = blocks.filter(b => b.includes('--ot-fs-xs: var(--ot-fs-m-caption)'))
  assert.equal(hit.length, 1, 'one phone block re-points the Agent page type tokens')
  // cut at the next top-level @media so later blocks are not read as part of this one
  return noComments(hit[0].split('\n@media ')[0])
}

test('Agent page phone type scale: caption < body < field, nothing under 13px, fields at 16px', () => {
  const caption = tokenPx('--ot-fs-m-caption')
  const body = tokenPx('--ot-fs-m-body')
  const field = tokenPx('--ot-fs-touch')
  assert.ok(caption >= 13, `caption ${caption}px is readable on a phone`)
  assert.ok(caption < body && body <= field, `scale steps down: field ${field} >= body ${body} > caption ${caption}`)
  assert.ok(field >= 16, 'focused fields at 16px or more do not make iOS Safari zoom the page')
  // the global no-zoom rule still wins on a phone
  assert.match(css, /body select \{ font-size: var\(--ot-fs-touch\) !important; \}/)
})

test('Agent page phone type scale does not follow the host base size', () => {
  const head = tokenHeader()
  for (const name of ['--ot-fs-m-caption', '--ot-fs-m-body', '--ot-fs-touch']) {
    const line = head.split('\n').find(l => l.trim().startsWith(`${name}:`))
    assert.ok(line, `${name} declared`)
    assert.doesNotMatch(line, /--font-size-base|var\(/, `${name} is a fixed size, not derived from a host variable`)
  }
  const b = agentPhoneBlock()
  assert.match(b, /\.ot-agents-view,\s*\.ot-am-wrap \{[^}]*--ot-fs-xs: var\(--ot-fs-m-caption\);[^}]*--ot-fs-sm: var\(--ot-fs-m-body\);[^}]*font-size: var\(--ot-fs-sm\);/)
  assert.equal(/font-size:\s*[0-9.]+px/.test(b), false, 'sizes come from tokens only')
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/.test(b), false, 'no hard-coded colours')
})

test('iOS text inflation is pinned for the whole plugin document', () => {
  assert.match(css, /\nhtml \{ -webkit-text-size-adjust: 100%; text-size-adjust: 100%; \}/)
})

test('Agent editor field grids: classes instead of inline columns; desktop columns unchanged, two per row on a phone', () => {
  assert.doesNotMatch(jsx, /gridTemplateColumns/, 'no inline grid columns left: a media query cannot override inline styles')
  // desktop: the exact columns the inline styles had
  assert.match(css, /\n\.ot-am-fields--3 \{ grid-template-columns: 1fr 1fr 1fr; \}/)
  assert.match(css, /\n\.ot-am-fields--2 \{ grid-template-columns: 1fr 1fr; \}/)
  assert.match(css, /\n\.ot-am-fields--perm \{ grid-template-columns: 1fr 1fr 124px; \}/)
  assert.match(css, /\n\.ot-am-fields \{ display: grid; gap: 8px; \}/)
  assert.match(css, /\n\.ot-am-fields--tight \{ gap: 6px; \}/)
  assert.match(css, /\n\.ot-cfg-line \{ display: contents; \}/, 'model-row pill groups are layout-transparent on desktop')
  assert.equal((jsx.match(/className="ot-am-fields ot-am-fields--3/g) || []).length, 2)
  assert.equal((jsx.match(/className="ot-am-fields ot-am-fields--2 /g) || []).length, 1)
  assert.equal((jsx.match(/className="ot-am-fields ot-am-fields--perm"/g) || []).length, 1)
  const b = agentPhoneBlock()
  assert.match(b, /\.ot-am-fields--3,\s*\.ot-am-fields--2,\s*\.ot-am-fields--perm \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
  assert.match(b, /\.ot-am-field--wide \{ grid-column: 1 \/ -1; \}/)
  // 320px phones: one field per row
  assert.match(css, /@media \(max-width: 359px\) \{\s*\.ot-am-fields--3,\s*\.ot-am-fields--2,\s*\.ot-am-fields--perm \{ grid-template-columns: minmax\(0, 1fr\); \}/)
})

test('Phone touch targets are not traded for density', () => {
  const b = agentPhoneBlock()
  assert.match(b, /\.ot-am-wrap \.ot-input,\s*\.ot-am-wrap \.ot-input--sm \{ min-height: 40px;/)
  const toggle = b.match(/\.ot-am-section-toggle \{([^}]*)\}/)
  assert.ok(toggle, 'fold button rule present')
  assert.ok(Number(toggle[1].match(/min-height: (\d+)px/)[1]) >= 40, 'fold button is at least 40px tall')
  // no rule in the block shrinks a control under 40px
  for (const [, sel, body] of b.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (/\.ot-cfg-line|\.ot-pill-mono/.test(sel)) continue // text pills, not controls
    for (const [, prop, n] of body.matchAll(/(?:^|[;\s])((?:min-)?height): (\d+)px/g)) {
      assert.ok(Number(n) >= 40, `${sel.trim()} ${prop} ${n}px keeps a 40px target`)
    }
  }
  // chips scroll sideways in one row instead of shrinking or wrapping
  assert.match(b, /\.ot-am-wrap \.ot-role-chip-bar,\s*\.ot-am-wrap \.ot-turns-preset-row \{[^}]*flex-wrap: nowrap; overflow-x: auto;/)
})

test('agentSectionsDefaultOpen: desktop shows everything, a phone opens the model chain (and name/role for a new Agent)', () => {
  assert.deepEqual(AGENT_SECTION_IDS, ['identity', 'models', 'perms'])
  assert.deepEqual(agentSectionsDefaultOpen(), { identity: true, models: true, perms: true })
  assert.deepEqual(agentSectionsDefaultOpen({ phone: false, isNew: true }), { identity: true, models: true, perms: true })
  assert.deepEqual(agentSectionsDefaultOpen({ phone: true }), { identity: false, models: true, perms: false })
  assert.deepEqual(agentSectionsDefaultOpen({ phone: true, isNew: true }), { identity: true, models: true, perms: false })
})

// ── Real component render (server markup) of the fold block the editor is built from ──
// The editor itself fills its draft in an effect, so server markup has no form; the block is rendered
// directly here and the wiring is asserted on the source. The full page is covered by the browser run.
let renderSection = null
let workDir = ''
async function loadRenderer() {
  if (renderSection) return renderSection
  workDir = mkdtempSync(join(tmpdir(), 'ekko-agent-page-'))
  const entry = join(workDir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import { AmSection } from ${JSON.stringify(join(pkgRoot, 'src/client/components/AgentManager.jsx'))}`,
    `export function render(props) {`,
    `  return renderToStaticMarkup(React.createElement(AmSection, {`,
    `    ...props,`,
    `    desktopHead: React.createElement('div', { className: 'ot-form-section-title' }, '3. 权限边界、沙箱与轮次上限'),`,
    `    phoneLead: React.createElement('span', { 'data-testid': 'lead' }, 'lead'),`,
    `  }, React.createElement('input', { className: 'ot-input', 'data-testid': 'field' })))`,
    `}`,
  ].join('\n'))
  const out = join(workDir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    nodePaths: [join(pkgRoot, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  renderSection = (await import(pathToFileURL(out).href)).render
  return renderSection
}
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

const base = { id: 'perms', phoneTitle: '权限、轮次与提示词', summary: '工作区可写 · 按需确认 · 300 轮', onToggle() {} }
const has = (html, re) => re.test(html)

test('Fold block on desktop: plain heading and fields, no fold button', async () => {
  const html = (await loadRenderer())({ ...base, phone: false, open: false })
  assert.equal(has(html, /<button/), false, 'no fold control on desktop, even when the phone state says closed')
  assert.ok(has(html, /3\. 权限边界、沙箱与轮次上限/), 'desktop heading unchanged')
  assert.ok(has(html, /data-testid="field"/), 'fields always rendered on desktop')
  assert.equal(has(html, /data-testid="lead"/), false, 'phone-only lead row is not rendered on desktop')
  assert.equal(has(html, /ot-am-section--fold/), false)
})

test('Fold block on a phone, closed: one button with the value summary, fields not rendered', async () => {
  const html = (await loadRenderer())({ ...base, phone: true, open: false })
  const tag = html.match(/<button[^>]*data-testid="btn-am-section-perms"[^>]*>/)
  assert.ok(tag, 'fold button rendered')
  assert.ok(/aria-expanded="false"/.test(tag[0]) && /aria-controls="ot-am-sec-perms"/.test(tag[0]))
  assert.ok(has(html, /class="ot-am-section-summary">工作区可写 · 按需确认 · 300 轮</), 'summary shows the values hidden inside')
  assert.ok(has(html, /权限、轮次与提示词/))
  assert.equal(has(html, /data-testid="field"/), false)
  assert.ok(has(html, /ot-am-section--fold is-collapsed/))
})

test('Fold block on a phone, open: fields and the lead row shown, summary hidden', async () => {
  const html = (await loadRenderer())({ ...base, phone: true, open: true })
  const tag = html.match(/<button[^>]*data-testid="btn-am-section-perms"[^>]*>/)
  assert.ok(tag && /aria-expanded="true"/.test(tag[0]))
  assert.ok(has(html, /<div class="ot-am-section-body" id="ot-am-sec-perms">/))
  assert.ok(has(html, /data-testid="field"/) && has(html, /data-testid="lead"/))
  assert.equal(has(html, /ot-am-section-summary/), false)
})

test('Editor wiring: three fold blocks, phone state from the 780px breakpoint, row actions split by width', () => {
  assert.equal((jsx.match(/<AmSection\b/g) || []).length, 3)
  for (const id of ['identity', 'models', 'perms']) assert.ok(jsx.includes(`id="${id}"`), `${id} block wired`)
  assert.match(jsx, /window\.matchMedia\?\.\(`\(max-width: \$\{PHONE_MAX_WIDTH\}px\)`\)/)
  assert.match(jsx, /mq\.removeEventListener\?\.\('change', sync\)/, 'the media listener is removed on unmount')
  assert.equal(PHONE_MAX_WIDTH, 780)
  assert.match(jsx, /agentSectionsDefaultOpen\(\{ phone, isNew: selectedId === '__new__' \}\)/)
  // desktop keeps the icon actions on the row; a phone gets them as labelled buttons inside the open editor
  assert.equal((jsx.match(/\{!phone && /g) || []).length, 4)
  assert.match(jsx, /\{phone && \(idx > 0 \|\| draft\.modelConfigs\.length > 1\) && \(\s*<div className="ot-cfg-editor-actions"/)
  // one switch element, placed in the heading on desktop and in the block body on a phone
  assert.equal((jsx.match(/data-testid="switch-agent-autofallback"/g) || []).length, 1)
  assert.equal((jsx.match(/\{autoFallbackSwitch\}/g) || []).length, 2)
})

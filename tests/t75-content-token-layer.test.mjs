/**
 * Todo #79 — content layer on the #74 tokens + AUTO pill "one colour, one meaning".
 * Verification record (measured in a real Chromium render of the COMMITTED dist/client.mjs; `~` = maintainer home,
 * a literal home path cannot be committed, see tests/contracts.test.mjs:184).
 * Harness: ~/.hermes/cache/scratch/t79/render/index.html (fake ctx) + ~/.hermes/cache/scratch/t79/drive.py
 * Raw output: ~/.hermes/cache/scratch/t79/report-final.json (after), report-before.json (main@c6b6137 dist)
 *
 * 1. npm test (rc=0, merge commit 6534d7c): # tests 904 / # pass 904 / # fail 0 / # duration_ms 48466
 *    (baseline main@238d348: 893 / 893 / 0).
 *    npm run harness:check rc=0. This file on main@238d348 (detached worktree): 11/11 not ok; on this branch 11/11 ok.
 *
 * 2. Token references, `var(--x)` count in src/client/styles.css, main@c6b6137 -> this card:
 *    bg-0 0->0  bg-1 0->3  bg-2 0->6  bg-3 0->6  line 2->9  line-strong 0->0  bg-hover 2->4  bg-active 2->2
 *    r-row 2->4  r-rail 1->1  r-card 1->12  r-lane 0->1  r-input 0->1
 *    elev-1 0->1  elev-2 1->3  elev-3 1->4  elev-float 0->2
 *    sp-1 0->2  sp-2 0->7  sp-3 0->2  sp-4 0->1  sp-5 0->1  sp-6 0->1
 *    dur-shell 1->9  dur-fade 9->11  ease-shell 2->12  focus-ring 1->4  meta (new) 0->3
 *    Still 0 on purpose: --ot-bg-0 (= the host canvas, already what every surface sits on) and --ot-line-strong
 *    (no content-layer element needs a stronger rule; left for the consistency sweep card).
 *
 * 3. Hard-coded colour in added src/client lines: `git diff c6b6137 -- src/client | grep '^+' | grep -cE
 *    '#[0-9a-fA-F]{3,8}\b|rgba?\('` = 0 (no hex, no rgb()/rgba()). No provider emblem touched.
 *
 * 4. Screenshots (16, ~/.hermes/cache/scratch/t79/shots/final/): {board, board-empty, drawer, chat}-{light,dark}-{1440x900,
 *    1280x800}.png. board-empty = all four lanes empty, board expanded (bg-3 icon tile on the bg-1 lane well).
 *    cmp: `git show 2a4ef06:dist/client.mjs` == render/client-after.mjs == worktree dist/client.mjs (all identical);
 *    later commits only touch this test file, so dist/client.mjs is unchanged since 2a4ef06.
 *
 * 5. AUTO pill (plan 甲). Before (main): .ot-auto-pill.is-on { background: var(--ek-auto-on) } solid #0F7D52 green,
 *    white text, 3px green halo. Computed before, light & dark: background rgb(15,125,82), border rgb(15,125,82),
 *    color rgb(255,255,255); text 5.15:1; fill-vs-surroundings 5.15:1 light / 2.79:1 dark (a solid green block).
 *    After: background var(--ot-bg-2), border 1.5px var(--ek-brand), color var(--ek-brand), dot brand, no halo.
 *      light: background color(srgb 0.955 0.955 0.955) = 244,244,244 / border rgb(26,101,176) / color rgb(26,101,176);
 *             text 5.38:1, border vs surface 5.95:1, fill vs surface 1.0:1
 *      dark:  background color(srgb 0.229 0.229 0.229) = 58,58,58 / border rgb(90,174,240) / color rgb(90,174,240);
 *             text 4.71:1, border vs surface 5.98:1, fill vs surface 1.0:1
 *    Shots: shots/before/auto-pill-{light,dark}.png, shots/final/auto-pill-{light,dark}.png.
 *    Why: green = done/success only. ON/enabled is a selected toggle -> brand blue (interactive/selected); the solid fill
 *    was the heaviest block in the composer (5.15:1 against white) and now weighs no more than its outline.
 *    v091 assertion diff (the only existing assertion changed, authorised by the card; :233 dashed OFF untouched):
 *    - /\.ot-auto-pill\.is-on \{[^}]*background: var\(--ek-auto-on\)/
 *    + /\.ot-auto-pill\.is-on \{[^}]*background: var\(--ot-bg-2\)[^}]*color: var\(--ek-brand\)[^}]*border: 1\.5px solid var\(--ek-brand\)/
 *    --ek-auto-on / --ek-auto-on-hover stay defined (v091 :226 still requires the token) but no rule reads them any more.
 *
 * 6. Contrast (getComputedStyle text vs composited background, 1440x900), light | dark:
 *    card title 15.76 | 8.57    card meta (time) 7.09 | 4.94    card #ID 7.09 | 4.94
 *    drawer tab selected 14.26 | 7.26    drawer tab unselected 5.41 | 4.82
 *    user bubble 14.82 | 7.44    chief body 17.40 | 10.87    system line 6.30 | 5.36    inline code 15.76 | 8.57
 *    composer placeholder 7.09 | 4.94    empty-state text 5.94 | 4.71        (all text >= 4.5:1)
 *    AUTO pill text 5.38 | 4.71, AUTO outline (non-text) 5.95 | 5.98 (>= 3:1)
 *    First render had card meta / placeholder at 4.22:1 in dark (--ot-muted on the brighter bg-2 card); fixed with the
 *    new --ot-meta token (muted pulled 20% toward body ink), case (j) below locks it from the token formulas.
 *
 * 7. Overflow, document scrollWidth / clientWidth (board scrollWidth / clientWidth), identical light and dark:
 *    1440x900 board 1440/1440 (918/786)   drawer open 1440/1440   empty board expanded 1440/1440 (1188/1188)
 *    1280x800 board 1280/1280 (918/626)   drawer open 1280/1280   empty board expanded 1280/1280 (1028/1028)
 *    Page never overflows. Board 918/786 and 918/626 = same numbers as #74 (four lanes with cards, LANE_MIN_WIDTH 216).
 *
 * 8. Motion samples (rAF, value changes only, [ms, value]):
 *    (ms = rAF timestamp minus the performance.now() taken before the action; a negative value is a frame whose rAF
 *    timestamp predates that call.)
 *    card hover background 244 -> 237: [10, srgb .955] [43, oklab .966] [76, .961] [93, .955] [110, .950] [126, .948]
 *      [143, .947] ... [260, .945] [276, srgb .928]                          (13 intermediate values)
 *    drawer open (left px, opacity): [122, 822, 0] [155, 815.1, .22] [172, 805.1, .53] [205, 793.9, .88] [222, 792.4, .93]
 *      [239, 791.4, .95] [272, 790.5, .98] [289, 790.2, .99] [305, 790.1, 1] [339, 790, 1]    (8 intermediate values)
 *    drawer close: [-8, 790, 1] [42, 796.9, .78] [59, 806.9, .47] [75, 814.9, .22] [109, 819.6, .07] [125, 820.6, .05]
 *      [142, 821.1, .03] [175, 821.8, .01] [192, 821.9, 0] [209, 822, 0] [259, gone]    (8 intermediate values)
 *    prefers-reduced-motion: card hover [10, .955] -> [60, .928] (two values); drawer open first frame already
 *      [38, 790, 1]; drawer close first frame already gone [-3, gone] (no intermediate values).
 *
 * 9. Removal check: revert only the board-card change (calm-layer .ot-card back to radius 10px with no background /
 *    padding, .ot-card:hover background back to var(--ot-card)) -> this file: # pass 10 # fail 1, the only failure is
 *    not ok 2 (b) `expected: 'var(--ot-bg-2)' actual: 'var(--ot-card)'`; restored -> # pass 11 # fail 0.
 *    Raw (re-run on 2a4ef06): ~/.hermes/cache/scratch/t79/mutation.txt
 *
 * Not changed on purpose: resolveLaneModes / LANE_MIN_WIDTH, fitSnapshotBudget, get-todo-detail, stubs, any src/server,
 * contracts, sdk, versions, dist/server.mjs. The drawer loading / error / retry notice (Todo #73) is reused unchanged.
 * Calm-layer `.ot-card { box-shadow: var(--ek-elev-1) }` (ring + 1px shadow) is kept: v097 locks "cards use ring
 * elevation", and with the lane outline removed it is the single edge in that area (lane 0 + card 1 layer).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '')
const rawCss = read('../src/client/styles.css')
const css = stripComments(rawCss)

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
const desktopCss = stripMedia(css)

// Last value a selector list containing exactly `sel` declares for `prop`, in file (cascade) order.
function lastDecl(sel, prop, text = desktopCss) {
  let val = null
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map(s => s.trim()).includes(sel)) continue
    for (const d of m[2].split(';')) {
      const k = d.indexOf(':')
      if (k > 0 && d.slice(0, k).trim() === prop) val = d.slice(k + 1).trim()
    }
  }
  return val
}
const refs = name => (css.match(new RegExp(`var\\(${name}\\)`, 'g')) || []).length

// The #79 section appended at the end of styles.css (raw text, comments included).
const SECTION_MARK = '/* ---------- Todo #79: content layer'
const section = rawCss.slice(rawCss.indexOf(SECTION_MARK))

test('Todo #79 (a): AUTO pill ON is neutral surface + brand outline/text — green is no longer used for "on"', () => {
  const on = /\.ot-auto-pill\.is-on \{([^}]*)\}/.exec(css)
  assert.ok(on, '.ot-auto-pill.is-on rule exists')
  assert.match(on[1], /background: var\(--ot-bg-2\)/)
  assert.match(on[1], /color: var\(--ek-brand\)/)
  assert.match(on[1], /border: 1\.5px solid var\(--ek-brand\)/)
  for (const m of css.matchAll(/([^{}]*\.ot-auto-pill[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(m[2], /--ek-auto-on|--ek-sage|--ot-done-/, `no "done" green in ${m[1].trim()}`)
  }
  assert.match(css, /\.ot-auto-pill \{[^}]*dashed/, 'OFF keeps the dashed outline (v091 :233 semantics)')
})

test('Todo #79 (b): board lanes are bg-1 wells, cards are bg-2 with bg-3 hover, on the radius / spacing tokens', () => {
  assert.equal(lastDecl('.ot-lane', 'background'), 'var(--ot-bg-1)')
  assert.equal(lastDecl('.ot-lane', 'border-radius'), 'var(--ot-r-lane)')
  assert.equal(lastDecl('.ot-lane', 'border-color'), 'transparent', 'lanes carry no outline (cards keep the only edge)')
  assert.equal(lastDecl('.ot-card', 'background'), 'var(--ot-bg-2)')
  assert.equal(lastDecl('.ot-card', 'border-radius'), 'var(--ot-r-card)')
  assert.equal(lastDecl('.ot-card', 'padding'), 'var(--ot-sp-2) var(--ot-sp-3)')
  assert.equal(lastDecl('.ot-card:hover', 'background'), 'var(--ot-bg-3)')
  assert.match(lastDecl('.ot-card', 'transition'), /var\(--ot-dur-shell\) var\(--ot-ease-shell\)/)
  assert.equal(lastDecl('.ot-lane-body', 'gap'), 'var(--ot-sp-2)')
})

test('Todo #79 (c): card #ID sits at the end of the title row; footer is one row (meta left, project chip right)', () => {
  const kb = read('../src/client/components/KanbanBoard.jsx')
  const row1 = kb.slice(kb.indexOf('<div className="ot-card-row1">'), kb.indexOf('</div>', kb.indexOf('<div className="ot-card-row1">')))
  assert.match(row1, /ot-card-title[\s\S]*<span className="ot-card-num">#\{td\.number\}<\/span>/, '#ID follows the title inside row 1')
  const row2 = kb.slice(kb.indexOf('<div className="ot-card-row2">'), kb.indexOf('<div className="ot-card-row3">'))
  assert.doesNotMatch(row2, /ot-card-num/, 'row 2 no longer stacks the #ID above the project chip')
  assert.equal((kb.match(/className="ot-card-num"/g) || []).length, 1, 'the #ID is rendered once')
  assert.equal(lastDecl('.ot-card-row1', 'display'), 'flex')
  assert.equal(lastDecl('.ot-card-row1 .ot-card-num', 'color'), 'var(--ot-meta)')
})

test('Todo #79 (d): task drawer — bg-1 surface, bg-2 blocks, --ot-line tab rule, r-card tabs, shell-motion open/close', () => {
  assert.equal(lastDecl('.ot-drawer', 'background'), 'var(--ot-bg-1)')
  assert.equal(lastDecl('.ot-drawer--left', 'background'), 'var(--ek-nav-bg)', 'the sidebar drawer keeps its own nav surface')
  assert.match(lastDecl('.ot-tabs-list', 'border-bottom'), /var\(--ot-line\)/)
  assert.equal(lastDecl('.ot-tabs-trigger', 'border-radius'), 'var(--ot-r-card) var(--ot-r-card) 0 0')
  assert.equal(lastDecl('.ot-drawer .ot-pre', 'background'), 'var(--ot-bg-2)')
  assert.equal(lastDecl('.ot-drawer .ot-setting-card', 'border-radius'), 'var(--ot-r-card)')
  assert.match(lastDecl('.ot-drawer--task[data-state="open"]', 'animation'), /ot-drawer-in var\(--ot-dur-shell\) var\(--ot-ease-shell\)/)
  assert.match(lastDecl('.ot-drawer--task[data-state="closed"]', 'animation'), /ot-drawer-out var\(--ot-dur-shell\) var\(--ot-ease-shell\)/)
  assert.match(css, /@keyframes ot-drawer-in \{/)
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n')
  assert.match(reduced, /\.ot-drawer--task\[data-state\][^{]*\{\s*animation: none !important;/, 'reduced motion lands the drawer immediately')
})

test('Todo #79 (e): chat — bg-3 user bubble, bg-1 code block, bg-2 inline code, sp-5 between messages, no new .ot-md margins', () => {
  assert.equal(lastDecl('.ot-msg-human', 'background'), 'var(--ot-bg-3)')
  assert.equal(lastDecl('.ot-md pre', 'background'), 'var(--ot-bg-1)')
  assert.equal(lastDecl('.ot-md pre', 'border-radius'), 'var(--ot-r-card)')
  assert.equal(lastDecl('.ot-md code', 'background'), 'var(--ot-bg-2)')
  assert.equal(lastDecl('.ot-chat-stream', 'gap'), 'var(--ot-sp-5)')
  assert.equal(lastDecl('.ot-msg-chief', 'gap'), 'var(--ot-sp-2)')
  assert.equal(lastDecl('.ot-progress-trace', 'color'), 'var(--ot-muted)')
  for (const m of stripComments(section).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\.ot-md/.test(m[1])) continue
    assert.doesNotMatch(m[2], /(^|;)\s*margin/, `#79 adds no margin to ${m[1].trim()} (the table margin must not double)`)
  }
})

test('Todo #79 (f): composer and fields share one focus ring token; composer is bg-2 + line + r-input + elev-float', () => {
  assert.equal(lastDecl('.ot-composer', 'background'), 'var(--ot-bg-2)')
  assert.equal(lastDecl('.ot-composer', 'border-color'), 'var(--ot-line)')
  assert.equal(lastDecl('.ot-composer', 'border-radius'), 'var(--ot-r-input)')
  assert.equal(lastDecl('.ot-composer', 'box-shadow'), 'var(--ot-elev-float)')
  assert.match(lastDecl('.ot-composer:focus-within', 'box-shadow'), /^var\(--ot-focus-ring\)/)
  assert.equal(lastDecl('.ot-shell button:focus-visible', 'box-shadow'), 'var(--ot-focus-ring)')
  assert.equal(lastDecl('body textarea:focus-visible', 'box-shadow'), 'var(--ot-focus-ring)')
  assert.equal((css.match(/--ot-focus-ring:/g) || []).length, 1, 'one focus ring definition for the whole plugin')
  assert.match(css, /--ot-focus-ring: 0 0 0 3px color-mix\(in srgb, var\(--ek-brand\) 26%, transparent\);/)
  assert.equal(lastDecl('.ot-composer textarea::placeholder', 'color'), 'var(--ot-meta)')
})

test('Todo #79 (g): floating layers use the elevation family + a 1px --ot-line edge; empty tiles are bg-3 / r-card', () => {
  for (const sel of ['.ot-menu-popover', '.ot-quick-popover', '.ot-mention-popover', '.ot-cmdk-modal', '.ot-modal', '.ot-popover', '.ot-notify-toast']) {
    assert.equal(lastDecl(sel, 'border-color'), 'var(--ot-line)', `${sel} edge`)
    assert.match(lastDecl(sel, 'box-shadow'), /^var\(--ot-elev-[23]\)$/, `${sel} elevation`)
  }
  assert.equal(lastDecl('.ot-drawer', 'border-left-color'), 'var(--ot-line)')
  assert.equal(lastDecl('.ot-drawer', 'box-shadow'), 'var(--ot-elev-3)')
  for (const sel of ['.ot-lane-empty-icon', '.ot-empty-icon']) {
    assert.equal(lastDecl(sel, 'background'), 'var(--ot-bg-3)')
    assert.equal(lastDecl(sel, 'border-radius'), 'var(--ot-r-card)')
  }
})

test('Todo #79 (h): every content-layer token is actually referenced', () => {
  const names = ['--ot-bg-1', '--ot-bg-2', '--ot-bg-3', '--ot-line', '--ot-r-card', '--ot-r-lane', '--ot-r-input',
    '--ot-sp-1', '--ot-sp-2', '--ot-sp-3', '--ot-sp-4', '--ot-sp-5', '--ot-sp-6', '--ot-elev-1', '--ot-elev-2', '--ot-elev-3', '--ot-elev-float',
    '--ot-focus-ring', '--ot-meta', '--ot-dur-shell', '--ot-ease-shell']
  for (const n of names) assert.ok(refs(n) >= 1, `${n} referenced ${refs(n)}x`)
})

test('Todo #79 (i): the #79 section adds no hard-coded colour (hex, rgb(), rgba())', () => {
  assert.ok(section.length > 500, 'section found')
  const code = stripComments(section)
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(code, /rgba?\(/)
})

// --ot-meta (secondary text on raised surfaces) must clear 4.5:1 on the bg-2 card step in both schemes.
// Same host palettes as tests/v0959 / v0967 (light: canvas 255 / text 26 / muted 153; dark: 42 / 224 / 136);
// --ot-muted is 55% host muted in light and 75% in dark (two :root blocks). Matches the rendered 82 on 244 / 171 on 58.
test('Todo #79 (j): --ot-meta on bg-2 is >= 4.5:1 in light and dark (resolved from the token formulas)', () => {
  const HOST = {
    light: { canvas: [255, 255, 255], text: [26, 26, 26], muted: [153, 153, 153], mutedPct: 0.55 },
    dark: { canvas: [42, 42, 42], text: [224, 224, 224], muted: [136, 136, 136], mutedPct: 0.75 },
  }
  const mix = (a, b, pa) => a.map((x, i) => x * pa + b[i] * (1 - pa))
  const lum = c => { const [r, g, b] = c.map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const cr = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05) }
  assert.match(css, /--ot-muted: color-mix\(in srgb, var\(--text-muted, #71717a\) 55%, var\(--text-primary, #18181b\)\);/)
  assert.match(css, /--ot-muted: color-mix\(in srgb, var\(--text-muted, #9f9fab\) 75%, var\(--text-primary, #f1f1f4\)\);/)
  assert.match(css, /--ot-meta: color-mix\(in srgb, var\(--ot-muted\) 80%, var\(--ot-text\)\);/)
  assert.match(css, /--ot-bg-2: color-mix\(in srgb, var\(--ot-canvas\) 95%, var\(--ot-text\)\);/)
  for (const [scheme, h] of Object.entries(HOST)) {
    const muted = mix(h.muted, h.text, h.mutedPct)
    const meta = mix(muted, h.text, 0.8)
    const bg2 = mix(h.canvas, h.text, 0.95)
    const r = cr(meta, bg2)
    assert.ok(r >= 4.5, `${scheme}: --ot-meta on bg-2 = ${r.toFixed(2)}:1`)
  }
})

test('Todo #79 (k): the shipped bundle carries the new AUTO pill and drawer motion', () => {
  const dist = read('../dist/client.mjs')
  assert.match(dist, /\.ot-auto-pill\.is-on \{ background: var\(--ot-bg-2\); color: var\(--ek-brand\)/)
  assert.ok(dist.includes('@keyframes ot-drawer-in'))
  assert.ok(dist.includes('ot-card-num'))
})

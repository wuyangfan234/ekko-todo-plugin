/**
 * Todo #74 — verification record (measured in a real Chromium render, not asserted by this file).
 * Paths below are on the maintainer's machine; `~` is the maintainer's home directory. A literal home path cannot be
 * committed: tests/contracts.test.mjs:184 fails the build on any personal home-directory path in the source tree.
 * Harness: ~/.hermes/cache/scratch/t74/render/index.html (fake ctx) + ~/.hermes/cache/scratch/t74/drive.py
 * Raw output: ~/.hermes/cache/scratch/t74/report3.json (latest run, from this commit's dist) and report2.json (previous)
 *
 * Sidebar width (.ot-left getBoundingClientRect().width), sampled every 50ms, 1440x900 light.
 * Two runs shown; intermediate values shift a little with timer jitter, the shape does not:
 *   fold   (report3)                          252 -> 154.8 -> 81.6 -> 70.8 -> 68.1 -> 68 -> 68 -> 68 -> 68
 *   fold   (report2)                          252 -> 108.6 -> 76.3 -> 69.4 -> 68 -> 68 -> 68 -> 68
 *   unfold (report3)                           68 -> 165 -> 238.4 -> 250.6 -> 252 -> 252 -> 252 -> 252 -> 252
 *   unfold (report2)                           68 -> 164.7 -> 243.7 -> 250.6 -> 252 -> 252 -> 252 -> 252
 *   fold   (prefers-reduced-motion: reduce)   252 -> 68 -> 68 -> 68 -> 68 -> 68 -> 68 -> 68
 *   unfold (prefers-reduced-motion: reduce)    68 -> 252 -> 252 -> 252 -> 252 -> 252 -> 252 -> 252
 *   chat pane horizontal overflow max during all four runs: 0; document overflow max: 0
 *
 * Layout overflow, scrollWidth / clientWidth (page | board), identical in light and dark:
 *   1440x900 expanded  1440/1440 | 918/786     1440x900 folded  1440/1440 | 970/970
 *   1280x800 expanded  1280/1280 | 918/626     1280x800 folded  1280/1280 | 918/810
 *   The board scrolls whenever four lanes hold cards and it is narrower than 918px (pre-existing rule: lanes with
 *   cards never auto-fold; changing resolveLaneModes is out of scope for this card).
 *
 * Folded rail, all ten entries clicked one by one (clicked testid -> opened testid), rail still shown after each:
 *   btn-open-quota-hub -> quota-hub-view        btn-open-schedules -> schedules-view
 *   btn-open-trace -> session-trace-view        btn-open-agents -> agents-view
 *   btn-open-settings -> settings-modal         btn-open-shortcuts -> shortcuts-dialog
 *   btn-open-cmdk -> command-palette            btn-unified-new -> unified-new-menu
 *   btn-rail-projects -> rail-projects-popover  btn-rail-topics -> rail-topics-popover
 *   (10/10 ok; picking a topic in the popover switches the chat title; waiting dot present;
 *    tooltip gap to button 8px (tipLeft 60, btnRight 52); localStorage ekko-todo:sidebar = "rail")
 *
 * Drawer path untouched: 900x800 (folded state saved / not saved) and 390x844 (saved) -> desktop aside display:none,
 *   drawer width 279, drawer never carries .ot-left--rail, page overflow 0, five tabs at 51.7969px each.
 *
 * Folded lanes: grep -c 'ot-lane-vertical-title' src/client/components/KanbanBoard.jsx = 0
 *   lane-todo: aria="展开「待开始」列，0 项", text="0", width=44, vertical text=false, click expands (light and dark).
 *
 * Board re-layout during the 200ms width transition (1440x900 expanded, one sample per animation frame, 400ms):
 *   fold   25-26 frames (two runs), max frame gap 17ms, 0 frames over 20ms, first lane 216 -> 229 (9 width changes)
 *   unfold 25 frames, max frame gap 17ms, 0 frames over 20ms, first lane 229 -> 216 (2 width changes)
 *   => no visible jank; the 1fr column does re-lay out every frame while it moves (known, accepted).
 *
 * Screenshots (rendered from the committed dist/client.mjs, `cmp` identical to the harness copy):
 *   ~/.hermes/cache/scratch/t74/shots/expanded-light-1440x900.png  .../rail-light-1440x900.png
 *   ~/.hermes/cache/scratch/t74/shots/expanded-light-1280x800.png  .../rail-light-1280x800.png
 *   ~/.hermes/cache/scratch/t74/shots/expanded-dark-1440x900.png   .../rail-dark-1440x900.png
 *   ~/.hermes/cache/scratch/t74/shots/expanded-dark-1280x800.png   .../rail-dark-1280x800.png
 *   plus empty-lanes-folded-{light,dark}-1280x800.png, drawer-*.png, rail-tooltip-trace-light-1440x900.png,
 *   rail-topics-popover-light-1440x900.png in the same directory.
 *
 * Hard-coded colour in this card's added src lines: 0 hex, 0 rgb()/rgba(). One `black` keyword remains in the dark
 *   shadow ink derivation (a dark host theme has no token darker than its canvas).
 *
 * Token layer: defined in :root but only partly wired in. Used by this card: --ot-line, --ot-bg-hover/active,
 *   --ot-r-row/rail/card, --ot-elev-2/3, --ot-dur-shell/fade, --ot-ease-shell, --ot-sidebar-w/rail-w/track.
 *   --ot-bg-0..3 / --ot-line-strong / --ot-elev-1 / --ot-elev-float / --ot-r-lane / --ot-r-input / --ot-sp-1..6 are
 *   DEFINED AND INTENTIONALLY NOT USED YET: the content layer (board cards, drawer, bubbles, forms) wires them in the
 *   next card. This is the Chief's card split, not an omission.
 *
 * AUTO pill (spec 3.5) — CHIEF RULING, DELIBERATELY NOT CHANGED: `.ot-auto-pill.is-on` keeps
 *   `background: var(--ek-auto-on)` (solid green). Deferred to the content-layer card: green also carries the
 *   on/enabled meaning, the pill sits right above the send button, and the accent palette is a system-wide decision
 *   to be made together with bubbles / notices / badges. tests/v091-chief-poll-trace-diff.test.mjs:232 keeps
 *   locking the solid background on purpose.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Todo #74: folding the sidebar used to set its grid column to 0px, so the whole navigation vanished. It now folds
// into a 68px icon rail that keeps every entry reachable, with one width token shared by JS and CSS, a design token
// layer for surfaces / lines / elevation / motion, and folded board lanes that show a dot + count instead of
// vertical Chinese text.

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '')
const css = read('../src/client/styles.css')
const cssCode = stripComments(css)

/** Body of the first top-level `:root { ... }` block (the light / base tokens). */
function rootBlock(src, selector = ':root') {
  const re = new RegExp(`(^|\\n)${selector.replace(/[[\]"=]/g, m => `\\${m}`)} \\{`)
  const m = re.exec(src)
  assert.ok(m, `${selector} block exists`)
  const open = src.indexOf('{', m.index)
  let depth = 1
  let j = open + 1
  while (depth > 0 && j < src.length) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') depth--
    j++
  }
  return src.slice(open + 1, j - 1)
}
const pxToken = (block, name) => {
  const m = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px;`).exec(block)
  return m ? Number(m[1]) : NaN
}

test('Todo #74 (a): layout.js exports the rail width and it sits in the 60–72px band', async () => {
  const layout = await import('../src/client/layout.js')
  assert.equal(typeof layout.SIDEBAR_RAIL_WIDTH, 'number', 'SIDEBAR_RAIL_WIDTH is exported')
  assert.ok(layout.SIDEBAR_RAIL_WIDTH >= 60 && layout.SIDEBAR_RAIL_WIDTH <= 72, `rail ${layout.SIDEBAR_RAIL_WIDTH}px is within 60–72`)
  assert.equal(layout.SIDEBAR_RAIL_WIDTH, 68)
})

test('Todo #74 (b): JS and CSS agree on both sidebar widths (parsed numbers, not substring matches)', async () => {
  const { SIDEBAR_WIDTH, SIDEBAR_RAIL_WIDTH } = await import('../src/client/layout.js')
  const root = rootBlock(cssCode)
  const cssWide = pxToken(root, '--ot-sidebar-w')
  const cssRail = pxToken(root, '--ot-sidebar-rail-w')
  assert.ok(Number.isFinite(cssWide), '--ot-sidebar-w is a px number in :root')
  assert.ok(Number.isFinite(cssRail), '--ot-sidebar-rail-w is a px number in :root')
  assert.equal(SIDEBAR_WIDTH, cssWide, `SIDEBAR_WIDTH ${SIDEBAR_WIDTH} vs --ot-sidebar-w ${cssWide}`)
  assert.equal(cssWide, SIDEBAR_WIDTH, 'and the other way round')
  assert.equal(SIDEBAR_RAIL_WIDTH, cssRail, `SIDEBAR_RAIL_WIDTH ${SIDEBAR_RAIL_WIDTH} vs --ot-sidebar-rail-w ${cssRail}`)
  assert.ok(SIDEBAR_WIDTH >= 248 && SIDEBAR_WIDTH <= 256, `expanded sidebar ${SIDEBAR_WIDTH}px fits a topic title, running tag, age and status icon (248–256)`)
})

test('Todo #74 (c): App.jsx no longer folds the sidebar column to 0px; the folded track is the rail constant', () => {
  const app = read('../src/client/App.jsx')
  assert.doesNotMatch(app, /'0px'/, 'no 0px literal for the sidebar column')
  assert.doesNotMatch(app, /sidebarCollapsed \? '0px'/)
  assert.match(app, /import \{[^}]*SIDEBAR_RAIL_WIDTH[^}]*\} from '\.\/layout\.js'/, 'App imports the rail constant')
  const track = /const sidebarTrack = ([^\n]+)/.exec(app)
  assert.ok(track, 'one named sidebar track feeds every desktop grid template')
  assert.match(track[1], /SIDEBAR_RAIL_WIDTH/, 'the track never goes below the rail width')
  const templates = app.match(/gridTemplateColumns: `[^`]*`/g) || []
  assert.ok(templates.length >= 2, 'both desktop templates are still set inline')
  for (const t of templates) assert.match(t, /^gridTemplateColumns: `\$\{sidebarTrack\}/, `template starts with the sidebar track: ${t}`)
  assert.match(app, /rail=\{sidebarCollapsed\}/, 'the desktop Sidebar is told to render as a rail')
})

test('Todo #74 (d): styles.css has a rail state whose width is the rail token, and no workbench template folds to 0px', () => {
  const rail = /\.ot-left--rail \{([^}]*)\}/.exec(cssCode)
  assert.ok(rail, '.ot-left--rail rule exists')
  assert.match(rail[1], /width: var\(--ot-sidebar-rail-w\)/, 'rail width is the token, not a literal')
  assert.doesNotMatch(rail[1], /width: 0/, 'rail is never zero wide')
  for (const m of cssCode.matchAll(/\.ot-workbench--[\w-]+(?:\.ot-workbench--[\w-]+)* \{ ?grid-template-columns: ([^;]+);/g)) {
    if (/subview|sidebar-collapsed/.test(m[0])) assert.doesNotMatch(m[1], /^0px/, `sidebar track is not 0px: ${m[0]}`)
  }
  for (const m of cssCode.matchAll(/\.ot-workbench--sidebar-collapsed[^{]*\{([^}]*)\}/g)) {
    assert.doesNotMatch(m[1], /grid-template-columns: 0px/, `collapsed variant keeps a rail: ${m[0].slice(0, 80)}`)
  }
  assert.match(cssCode, /--ot-sidebar-track: minmax\(var\(--ot-sidebar-rail-w\), auto\);/, 'desktop sidebar track follows the animated aside width, floored at the rail')
})

test('Todo #74 (e): every entry stays reachable on the rail (one data-testid each)', () => {
  const sidebar = read('../src/client/components/Sidebar.jsx')
  const RAIL_ENTRIES = {
    'btn-unified-new': '新建',
    'btn-open-cmdk': '搜索',
    'btn-rail-projects': '项目',
    'btn-rail-topics': '话题',
    'btn-open-quota-hub': '配额',
    'btn-open-schedules': '定时',
    'btn-open-trace': '记录',
    'btn-open-agents': 'Agent',
    'btn-open-settings': '配置中心',
  }
  for (const [id, name] of Object.entries(RAIL_ENTRIES)) {
    assert.match(sidebar, new RegExp(`data-testid="${id}"`), `${name} (${id}) has a test id`)
  }
  assert.match(sidebar, /data-testid="btn-open-shortcuts"/, 'shortcuts stay on the rail')
  assert.match(sidebar, /data-testid="btn-sidebar-toggle"/, 'fold / unfold button')
  assert.match(sidebar, /ot-left--rail/, 'Sidebar renders the rail state class')
  assert.match(sidebar, /data-testid="rail-topics-waiting-dot"/, 'the topics entry carries the 待你处理 dot')
  assert.match(sidebar, /data-testid="rail-projects-popover"/, 'projects open as a popover on the rail')
  assert.match(sidebar, /data-testid="rail-topics-popover"/, 'topics open as a popover on the rail')
  assert.match(sidebar, /side="right"/, 'tooltips sit to the right of the rail')
  assert.match(sidebar, /sideOffset=\{8\}/)
  assert.match(sidebar, /delayDuration=\{200\}/)
})

test('Todo #74 (f): folded board lanes show a dot and a count, never vertical text', () => {
  const board = read('../src/client/components/KanbanBoard.jsx')
  assert.doesNotMatch(board, /ot-lane-vertical-title/, 'no vertical title element')
  const folded = /className="ot-lane ot-lane--collapsed"[\s\S]*?<\/button>/.exec(board)
  assert.ok(folded, 'folded lane button')
  assert.match(folded[0], /aria-label=\{`[^`]*\$\{col\.label\}[^`]*`\}/, 'name goes to aria-label')
  assert.match(folded[0], /className="ot-lane-count ot-lane-rail-count"/, 'count is rendered')
  assert.match(folded[0], /ot-dot ot-dot--\$\{col\.dot\}/, 'status dot is rendered')
  assert.doesNotMatch(cssCode, /\.ot-lane-vertical-title/, 'vertical title CSS is gone')
  assert.match(cssCode, /\.ot-lane-rail-count \{[^}]*font-variant-numeric: tabular-nums/)
})

test('Todo #74: rail / expanded choice persists in localStorage and survives a throwing storage', async () => {
  const { readSidebarMode, writeSidebarMode, SIDEBAR_STORAGE_KEY } = await import('../src/client/layout.js')
  assert.equal(SIDEBAR_STORAGE_KEY, 'ekko-todo:sidebar')
  const mem = new Map()
  const store = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) }
  assert.equal(readSidebarMode(store), 'expanded', 'default is expanded')
  writeSidebarMode(store, 'rail')
  assert.equal(mem.get('ekko-todo:sidebar'), 'rail')
  assert.equal(readSidebarMode(store), 'rail')
  writeSidebarMode(store, 'expanded')
  assert.equal(readSidebarMode(store), 'expanded')
  mem.set('ekko-todo:sidebar', 'garbage')
  assert.equal(readSidebarMode(store), 'expanded', 'unknown values fall back')
  const hostile = { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceeded') } }
  assert.equal(readSidebarMode(hostile), 'expanded', 'private mode read does not throw')
  assert.doesNotThrow(() => writeSidebarMode(hostile, 'rail'), 'private mode write does not throw')
  assert.equal(readSidebarMode(null), 'expanded')
  const app = read('../src/client/App.jsx')
  assert.match(app, /readSidebarMode\(/)
  assert.match(app, /writeSidebarMode\(/)
})

test('Todo #74: token layer and shell motion are defined once in :root, with a reduced-motion opt-out', () => {
  const root = rootBlock(cssCode)
  for (const name of ['--ot-bg-0', '--ot-bg-1', '--ot-bg-2', '--ot-bg-3', '--ot-line', '--ot-line-strong', '--ot-bg-hover', '--ot-bg-active', '--ot-elev-1', '--ot-elev-2', '--ot-elev-3', '--ot-elev-float', '--ot-r-row', '--ot-r-rail', '--ot-r-card', '--ot-r-lane', '--ot-r-input']) {
    assert.match(root, new RegExp(`${name}:`), `${name} defined in :root`)
  }
  for (const name of ['--ot-bg-0', '--ot-bg-1', '--ot-bg-2', '--ot-bg-3']) {
    assert.match(root, new RegExp(`${name}: [^;]*(var\\(|color-mix)`), `${name} is derived from host tokens`)
  }
  const dark = rootBlock(cssCode, ':root[data-scheme="dark"]')
  assert.match(dark, /--ot-elev-float:/, 'dark scheme lifts the floating shadow')
  assert.match(root, /--ot-ease-shell: cubic-bezier\(0\.32, 0\.72, 0, 1\);/)
  const dur = pxToken(root.replace(/(\d+)ms/g, '$1px'), '--ot-dur-shell')
  assert.ok(dur >= 180 && dur <= 220, `shell duration ${dur}ms within 180–220`)
  assert.match(cssCode, /\.ot-left--desk \{[^}]*transition: width var\(--ot-dur-shell\) var\(--ot-ease-shell\)/, 'the aside animates its own width, not grid-template-columns')
  const reduced = [...cssCode.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n')
  assert.match(reduced, /\.ot-left--desk[^{]*\{[^}]*transition: none/, 'reduced motion lands instantly')
  assert.match(cssCode, /\.ot-col-bar \{[^}]*height: 52px/, 'column headers are 52px')
})

test('Todo #74: the built client bundle carries the rail', () => {
  const dist = read('../dist/client.mjs')
  for (const literal of ['ot-left--rail', 'ekko-todo:sidebar', 'btn-rail-topics', '--ot-sidebar-rail-w', 'ot-lane-rail-count']) {
    assert.ok(dist.includes(literal), `dist/client.mjs contains ${literal}`)
  }
  assert.ok(!dist.includes('ot-lane-vertical-title'), 'dist no longer carries the vertical lane title')
})

test('Todo #74 review: shell headers use --ot-line, the sidebar header keeps --ek-nav-line, shadows derive from host tokens', () => {
  const lastRule = sel => {
    let body = ''
    for (const m of cssCode.matchAll(/(^|\n)([^{}@\n][^{}]*)\{([^{}]*)\}/g)) {
      if (m[2].split(',').map(s => s.trim()).includes(sel) && /border-bottom/.test(m[3])) body = m[3]
    }
    return body
  }
  assert.match(lastRule('.ot-col-bar'), /var\(--ot-line\)/, 'chat / board headers end on --ot-line')
  assert.match(lastRule('.ot-left > .ot-col-bar'), /var\(--ek-nav-line\)/, 'the sidebar header keeps the nav line')
  for (const scheme of [':root', ':root[data-scheme="dark"]']) {
    const block = rootBlock(cssCode, scheme)
    assert.match(block, /--ot-shadow-ink:/, `${scheme} defines the shadow ink`)
    for (const name of ['--ot-elev-1', '--ot-elev-2', '--ot-elev-3', '--ot-elev-float']) {
      const v = new RegExp(`${name}: ([^;]+);`).exec(block)
      assert.ok(v, `${scheme} ${name}`)
      assert.doesNotMatch(v[1], /rgba?\(|#[0-9a-f]{3,8}/i, `${scheme} ${name} has no rgb / hex literal: ${v[1]}`)
      assert.match(v[1], /color-mix\(in srgb, var\(--ot-shadow-ink\)/, `${scheme} ${name} is derived from the shadow ink`)
    }
  }
  assert.doesNotMatch(cssCode, /\.ot-workbench--sidebar-collapsed \{/, 'no dead top-level sidebar-collapsed template')
  assert.doesNotMatch(read('../src/client/App.jsx'), /else setSidebarCollapsed\(false\)/, 'no unreachable desktop branch in the chat-header trigger')
})

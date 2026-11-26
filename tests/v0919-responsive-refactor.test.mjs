import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const LANES = ['todo', 'doing', 'confirm', 'done']

// Rules after the responsive layer starts; comments stripped so prose never satisfies an assertion.
function responsiveLayer() {
  const css = read('../src/client/styles.css')
  const at = css.indexOf('Ekko responsive layer (v0.9.19)')
  assert.ok(at > 0, 'responsive layer marker present')
  return css.slice(at).replace(/\/\*[\s\S]*?\*\//g, '')
}

// Body of the first `@media (max-width: <px>)` block of the layer that contains `needle`.
function mediaBlockWith(layer, px, needle) {
  const head = `@media (max-width: ${px}px) {`
  let from = 0
  for (;;) {
    const start = layer.indexOf(head, from)
    if (start < 0) return ''
    let depth = 0
    let end = start
    for (let i = start + head.length - 1; i < layer.length; i++) {
      if (layer[i] === '{') depth++
      else if (layer[i] === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    const body = layer.slice(start + head.length, end)
    if (body.includes(needle)) return body
    from = end
  }
}

test('v0.9.19: empty lanes fold into rails only when four open lanes do not fit', async () => {
  const { resolveLaneModes, boardWidthForOpenLanes } = await import('../src/client/layout.js')
  const need = boardWidthForOpenLanes(4)
  assert.equal(need, 4 * 216 + 3 * 10 + 24, 'four 216px lanes + gaps + grid padding')

  const counts = { todo: 0, doing: 3, confirm: 0, done: 13 }
  // 1440 desktop: the board pane is ~737px wide, so 已完成 used to be pushed off screen.
  assert.deepEqual(
    resolveLaneModes({ laneIds: LANES, counts, boardWidth: 737 }),
    { todo: 'rail', doing: 'open', confirm: 'rail', done: 'open' },
  )
  // Enough room: nothing folds.
  assert.deepEqual(
    resolveLaneModes({ laneIds: LANES, counts, boardWidth: need }),
    { todo: 'open', doing: 'open', confirm: 'open', done: 'open' },
  )
  // Width not measured yet (first paint): never fold on a guess.
  assert.deepEqual(
    resolveLaneModes({ laneIds: LANES, counts, boardWidth: 0 }),
    { todo: 'open', doing: 'open', confirm: 'open', done: 'open' },
  )
  // A lane that holds cards is never folded automatically, however narrow the board is.
  const full = resolveLaneModes({ laneIds: LANES, counts: { todo: 1, doing: 1, confirm: 1, done: 1 }, boardWidth: 300 })
  assert.deepEqual(Object.values(full), ['open', 'open', 'open', 'open'])
  // A brand-new board (no cards anywhere) keeps its four lanes: folding everything would leave four rails.
  const empty = resolveLaneModes({ laneIds: LANES, counts: { todo: 0, doing: 0, confirm: 0, done: 0 }, boardWidth: 300 })
  assert.deepEqual(Object.values(empty), ['open', 'open', 'open', 'open'])
})

test('v0.9.19: the user\'s own fold / unfold choice always wins over the automatic one', async () => {
  const { resolveLaneModes } = await import('../src/client/layout.js')
  const counts = { todo: 0, doing: 3, confirm: 0, done: 13 }
  const modes = resolveLaneModes({ laneIds: LANES, counts, boardWidth: 737, userCollapsed: { todo: false, done: true } })
  assert.equal(modes.todo, 'open', 'explicitly reopened empty lane stays open')
  assert.equal(modes.done, 'rail', 'explicitly folded lane stays folded')
  assert.equal(modes.confirm, 'rail', 'untouched empty lane still folds')
  // Folding a lane by hand can make the rest fit, and then the empty ones stay open.
  const roomy = resolveLaneModes({ laneIds: LANES, counts, boardWidth: 3 * 216 + 44 + 3 * 10 + 24, userCollapsed: { done: true } })
  assert.deepEqual(roomy, { todo: 'open', doing: 'open', confirm: 'open', done: 'rail' })
})

test('v0.9.19: on a phone every lane is a full page; rails and manual folds do not apply', async () => {
  const { resolveLaneModes, pickInitialLane, laneIndexFromScroll } = await import('../src/client/layout.js')
  const modes = resolveLaneModes({
    laneIds: LANES, counts: { todo: 0, doing: 3, confirm: 0, done: 13 }, boardWidth: 390, phone: true, userCollapsed: { done: true },
  })
  assert.deepEqual(Object.values(modes), ['open', 'open', 'open', 'open'])

  // First lane shown on a phone: what needs you, else what is running, else the backlog, else finished work.
  assert.equal(pickInitialLane({ laneIds: LANES, counts: { todo: 2, doing: 3, confirm: 1, done: 9 } }), 'confirm')
  assert.equal(pickInitialLane({ laneIds: LANES, counts: { todo: 2, doing: 3, confirm: 0, done: 9 } }), 'doing')
  assert.equal(pickInitialLane({ laneIds: LANES, counts: { todo: 2, doing: 0, confirm: 0, done: 9 } }), 'todo')
  assert.equal(pickInitialLane({ laneIds: LANES, counts: { todo: 0, doing: 0, confirm: 0, done: 9 } }), 'done')
  assert.equal(pickInitialLane({ laneIds: LANES, counts: {} }), 'todo')

  assert.equal(laneIndexFromScroll(0, 390, 4), 0)
  assert.equal(laneIndexFromScroll(380, 390, 4), 1, 'nearest page while a swipe settles')
  assert.equal(laneIndexFromScroll(1170, 390, 4), 3)
  assert.equal(laneIndexFromScroll(99999, 390, 4), 3, 'clamped to the last lane')
  assert.equal(laneIndexFromScroll(120, 0, 4), 0, 'unmeasured page width is safe')
})

test('v0.9.19: the phone board renders lane tabs with counts and pages through the lanes', () => {
  const jsx = read('../src/client/components/KanbanBoard.jsx')
  assert.match(jsx, /from '\.\.\/layout\.js'/)
  assert.match(jsx, /resolveLaneModes\(/)
  assert.match(jsx, /pickInitialLane\(/)
  assert.match(jsx, /data-testid="board-lane-tabs"/)
  assert.match(jsx, /data-testid=\{`board-lane-tab-\$\{col\.id\}`\}/)
  assert.match(jsx, /role="tablist"/)
  assert.match(jsx, /aria-selected=\{/)
  assert.match(jsx, /ResizeObserver/, 'board width is measured, not guessed from the window')
  assert.match(jsx, /minmax\(216px, 1fr\)/, 'desktop lanes keep the 216px floor')

  const layer = responsiveLayer()
  assert.match(layer, /\.ot-lane-tabs \{ display: none;/, 'tabs are phone-only')
  const phone = mediaBlockWith(layer, 780, '.ot-lane-tabs')
  assert.match(phone, /\.ot-lane-tabs \{ display: flex;/)
  assert.match(phone, /\.ot-lane-tab \{[^}]*min-height: 40px/)
  assert.match(phone, /\.ot-board-grid \{[^}]*grid-template-columns: repeat\(4, 100%\) !important;[^}]*scroll-snap-type: x mandatory/)
  assert.match(phone, /\.ot-lane \{[^}]*scroll-snap-align: start/)
  assert.match(phone, /\.ot-lane-head \{ display: none/, 'the tab strip replaces the per-lane header on a phone')
})

test('v0.9.19: sidebar is wide enough to read topic titles and shows a short age', async () => {
  // Todo #74: widened to 252px; the constant is still the one source layout.js, App.jsx and the CSS token share.
  const { SIDEBAR_WIDTH } = await import('../src/client/layout.js')
  assert.equal(SIDEBAR_WIDTH, 252)
  const app = read('../src/client/App.jsx')
  assert.match(app, /SIDEBAR_WIDTH/)
  assert.doesNotMatch(app, /'198px'/, 'no stale literal sidebar width in the grid template')
  const css = read('../src/client/styles.css')
  assert.match(css, new RegExp(`--ot-sidebar-w: ${SIDEBAR_WIDTH}px;`))
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /grid-template-columns: (198|204)px/, 'grid templates use the sidebar token')

  const { formatSidebarAge } = await import('../src/client/utils.js')
  const now = Date.UTC(2026, 10, 24, 12, 0, 0)
  assert.equal(formatSidebarAge(now - 20 * 1000, now), '刚刚')
  assert.equal(formatSidebarAge(now - 5 * 60 * 1000, now), '5 分钟')
  assert.equal(formatSidebarAge(now - 3 * 3600 * 1000, now), '3 小时')
  assert.equal(formatSidebarAge(now - 26 * 3600 * 1000, now), '昨天')
  assert.equal(formatSidebarAge(now - 4 * 86400 * 1000, now), '4 天')
  assert.equal(formatSidebarAge(0, now), '')
  assert.match(read('../src/client/components/Sidebar.jsx'), /formatSidebarAge\(tp\.updatedAt\)/)
})

test('v0.9.19: the navigation drawer keeps its five destinations in one compact row', () => {
  const sidebar = read('../src/client/components/Sidebar.jsx')
  for (const id of ['btn-open-quota-hub', 'btn-open-schedules', 'btn-open-trace', 'btn-open-agents', 'btn-open-settings']) {
    assert.match(sidebar, new RegExp(`data-testid="${id}"`), `${id} kept`)
  }
  assert.match(sidebar, /ot-left-foot \$\{inDrawer \? 'ot-left-foot--tabs' : ''\}/)
  for (const short of ['配额', '定时', '记录', '设置']) {
    assert.match(sidebar, new RegExp(`data-short="${short}"`), `short label ${short}`)
  }
  for (const full of ['用量与配额', '定时任务', '运行记录', '配置中心']) {
    assert.match(sidebar, new RegExp(`aria-label="${full}"`), `full name ${full} stays as the accessible name`)
  }
  const layer = responsiveLayer()
  assert.match(layer, /\.ot-left-foot--tabs \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/)
  assert.match(layer, /\.ot-left-foot--tabs \.ot-nav-item \{[^}]*flex-direction: column;[^}]*min-height: 52px/)
})

test('v0.9.19: phone hit targets, single menu button, and inputs that do not trigger iOS zoom', () => {
  const css = read('../src/client/styles.css')
  assert.match(css, /--ot-fs-touch: 16px;/, 'touch input size is a token')
  const layer = responsiveLayer()
  const phone = mediaBlockWith(layer, 780, '.ot-nav-group-head > button')
  assert.ok(phone, 'phone block present')
  assert.match(phone, /\.ot-nav-group-head > button \{[^}]*min-height: 40px/)
  assert.match(phone, /\[data-testid="btn-chat-open-sidebar"\] \{ display: none/, 'one menu button on a phone, not two')
  assert.match(phone, /font-size: var\(--ot-fs-touch\)/)
  for (const sel of ['.ot-switch::before', '.ot-effort-tick', '.ot-concurrency-tick', '.ot-proj-view-btn', '.ot-branch-trigger', '.ot-queue-send-pill']) {
    assert.ok(phone.includes(sel), `${sel} gets a phone hit area`)
  }
  assert.match(phone, /\.ot-proj-topbar \{[^}]*grid-template-areas:/, 'project header becomes two rows instead of overlapping')
  assert.equal(/font-size:\s*[0-9.]+px/.test(layer), false, 'layer uses font-size tokens only')
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)/.test(layer), false, 'layer has no hard-coded colours')
})

test('v0.9.19: the pinned topic brief folds to one line on a phone unless it waits for the user', async () => {
  const { briefStartsCollapsed, pickBriefSummaryRow } = await import('../src/client/layout.js')
  assert.equal(briefStartsCollapsed({ phone: true, waiting: false }), true)
  assert.equal(briefStartsCollapsed({ phone: true, waiting: true }), false, 'a pending decision is never hidden')
  assert.equal(briefStartsCollapsed({ phone: false, waiting: false }), false, 'desktop keeps the full brief')
  assert.equal(briefStartsCollapsed({ phone: false, waiting: true }), false)
  // The folded line shows what needs the user first, then what is blocked, else the first row.
  assert.deepEqual(pickBriefSummaryRow([['目标', 'a'], ['当前', 'b'], ['等你', 'c'], ['卡住', 'd']]), ['等你', 'c'])
  assert.deepEqual(pickBriefSummaryRow([['目标', 'a'], ['卡住', 'd']]), ['卡住', 'd'])
  assert.deepEqual(pickBriefSummaryRow([['目标', 'a'], ['当前', 'b']]), ['当前', 'b'], 'progress says more than the goal')
  assert.deepEqual(pickBriefSummaryRow([['目标', 'a']]), ['目标', 'a'])
  assert.equal(pickBriefSummaryRow([]), null)

  const chat = read('../src/client/components/ChatPane.jsx')
  assert.match(chat, /briefStartsCollapsed\(/)
  assert.match(chat, /data-testid="btn-brief-toggle"/)
  assert.match(chat, /aria-expanded=\{!collapsed\}/)
  assert.match(chat, /if \(b\.waitingOnYou\) setCollapsed\(false\)/, 'a new decision reopens a folded brief')
  const layer = responsiveLayer()
  assert.match(layer, /\.ot-brief-card\.is-collapsed \{/)
  const phone = mediaBlockWith(layer, 780, '.ot-brief-toggle')
  assert.match(phone, /\.ot-brief-toggle \{[^}]*min-height: 40px/)
  assert.match(phone, /\.ot-brief-input-row \.ot-input \{[^}]*min-height: 40px !important/)
  assert.match(phone, /\.ot-brief-opt-chip \{[^}]*min-height: 40px/)
})

test('v0.9.19: reasoning-effort stops wrap to at most four columns on a phone so each stop is 40px wide and tall', async () => {
  const { effortTickColumns, effortTickWidth, EFFORT_TICK_MIN, EFFORT_PHONE_MAX_COLUMNS } = await import('../src/client/layout.js')
  assert.equal(EFFORT_TICK_MIN, 40)
  assert.equal(EFFORT_PHONE_MAX_COLUMNS, 4)
  assert.equal(effortTickColumns(7, { phone: true }), 4, 'seven stops become two rows (4 + 3)')
  assert.equal(effortTickColumns(7, { phone: false }), 7, 'desktop keeps one row under the slider')
  assert.equal(effortTickColumns(3, { phone: true }), 3, 'few stops stay in one row')
  assert.equal(effortTickColumns(0, { phone: true }), 1)
  // 271px is the tick row measured in the 390px settings sheet. Seven columns gave 37px per stop: tall enough
  // after a min-height fix, still too narrow. The width, not only the height, has to reach 40px.
  assert.ok(effortTickWidth(271, 7) < EFFORT_TICK_MIN, 'one row of seven is under 40px wide at 390')
  assert.ok(effortTickWidth(271, effortTickColumns(7, { phone: true })) >= EFFORT_TICK_MIN, 'four columns clear 40px')

  const jsx = read('../src/client/components/ReasoningSlider.jsx')
  assert.doesNotMatch(jsx, /gridTemplateColumns/, 'columns come from CSS variables, so the phone rule can override them')
  assert.match(jsx, /'--ot-effort-cols': effortTickColumns\(stops\.length, \{ phone: false \}\)/)
  assert.match(jsx, /'--ot-effort-cols-phone': effortTickColumns\(stops\.length, \{ phone: true \}\)/)
  assert.match(jsx, /has-tick-rows/)

  const css = read('../src/client/styles.css')
  assert.match(css, /\.ot-effort-ticks \{[^}]*grid-template-columns: repeat\(var\(--ot-effort-cols, 1\), minmax\(0, 1fr\)\)/)
  const phone = mediaBlockWith(responsiveLayer(), 780, '.ot-effort-ticks')
  assert.match(phone, /\.ot-effort-ticks \{[^}]*grid-template-columns: repeat\(var\(--ot-effort-cols-phone, 1\), minmax\(40px, 1fr\)\)/)
  const tick = /\.ot-effort-tick \{([^}]*)\}/.exec(phone)
  assert.ok(tick, 'phone rule for a stop')
  assert.match(tick[1], /min-width: 40px/, 'height alone is not enough: the stop is also at least 40px wide')
  assert.match(tick[1], /min-height: 40px/)
  assert.match(phone, /\.ot-effort-box\.has-tick-rows \.ot-effort-track \{ display: none/, 'a one-row slider cannot line up with two rows of stops')
})

test('v0.9.19: built client bundle carries the responsive layer', () => {
  const dist = read('../dist/client.mjs')
  for (const literal of ['board-lane-tabs', 'ot-left-foot--tabs', '--ot-sidebar-w', '--ot-fs-touch', 'btn-brief-toggle']) {
    assert.ok(dist.includes(literal), `dist/client.mjs contains ${literal}`)
  }
})

test('v0.9.19: release metadata is aligned and the changelog leads with this version', () => {
  const pkg = JSON.parse(read('../package.json'))
  const lock = JSON.parse(read('../package-lock.json'))
  assert.equal(JSON.parse(read('../plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(JSON.parse(read('../contracts/plugin.json')).description.includes(`v${pkg.version}`))
  const changelog = read('../CHANGELOG.md')
  const heads = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map(m => m[1])
  assert.equal(heads[0], pkg.version, 'newest changelog entry is the package version')
  assert.equal(new Set(heads).size, heads.length, 'no duplicate changelog headings')
  // Located by content, not by number, so a renumbering at merge time does not break this test.
  const sections = changelog.split(/^(?=## \[)/m)
  const mine = sections.filter(sec => sec.includes('one lane per screen'))
  assert.equal(mine.length, 1, 'this change is described in exactly one entry')
  assert.match(mine[0], /sidebar/i)
})

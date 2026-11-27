/**
 * Todo #99: board card motion, completion confetti, lane entrance, reduced motion.
 *
 * Result: implemented; client only (src/client, tests, docs). Everything below was measured on the tree committed
 * with this file. Numbers a test can hold are asserted in this file and not copied here.
 *
 * 1. Gates: `npm run harness:check` rc=0. `npm test`: # tests 1246 / # pass 1246 / # fail 0 (main fab1e06: 1232 / 1232 / 0;
 *    no existing test changed). `npm run build` then `git status --porcelain` empty.
 * 2. Removal checks (source mutated, this file run, source restored): 21 of 21 turned this file red.
 *    completion not reported -> tests 1,9,10,13 | first load counted as a move -> 1,9,10,11,12,13 | no key de-dup -> 2 |
 *    no reduced branch -> 2,13 | no removal timer -> 9,10 | timer not cleared on unmount -> 10 | fresh landing target per
 *    render -> 5 | landing class never cleared -> 11 | no landing keyframes -> 5 | no is-dragging -> 5,12 | dragend does
 *    not reset -> 12 | drag scale 1.2 -> 5,8 | layer not clipped -> 8 | layer takes pointer events -> 8 | no hover lift -> 5 |
 *    no stagger -> 6 | 9 groups allowed -> 2,10 | closed celebrated -> 1 | no is-done-flash -> 5,13 | rest shadow back to
 *    --ek-elev-1 -> 7 | no shortcut hint -> 14.
 * 3. Real rendering (Playwright, headless Chromium, the committed dist/client.mjs behind a fake ctx; 53 of 53 checks,
 *    0 page errors; main's dist as control: the card reaches done, 0 bursts). Per-frame series:
 *    hover translateY px: 0 0 -0.49 -1.22 -1.25 -1.56 -1.76 -1.88 -1.94 -1.97 -1.99 -2 (stays -2); box-shadow 12 distinct values.
 *    press scale: 1 0.995 0.98932 0.98668 0.98559 0.98517 0.98503 0.985 (stays).
 *    release scale: 0.985 0.98658 0.98858 0.98894 0.99064 0.99394 0.99846 1.00024 1 (stays).
 *    landing translateY px (ms:value): 12:5.99 29:5.97 45:5.26 62:3.54 79:2.17 95:0.88 112:-0.17 129:-0.76 146:-1.09 162:-1.1
 *      179:-0.95 195:-0.6 212:-0.4 229:-0.13 245:0.06 262:0.16 279:0 ... 345:0.06 362:0.01 379:0; one episode in 3.6s while
 *      the running card re-rendered every second; two replayed snapshots: the only value is 0.
 *    entrance: the first three cards of a lane reach opacity 1 at 253 / 285 / 317 ms.
 *    drag: class is-dragging, scale 1.02, rotation 0.8deg, .ot-shell[data-card-dragging], composer border dashed; after
 *      the drop transform none and the composer holds the quoted card.
 *    burst: 30 particles, origin = card centre (1582,200), layer pointer-events none, elementFromPoint at the origin is
 *      a card, gone after 1018ms; three completions in one snapshot -> 2 bursts / 60 particles.
 * 4. prefers-reduced-motion: reduce: hover translateY only 0, box-shadow 2 values (start, end); press scale only 1;
 *    landing only 0; entrance opacity only 1.00; completion: 0 bursts, is-done-flash for 153ms.
 * 5. Frames (rAF): hover in / out twice 91 frames, max gap 16.8ms, 0 over 20ms, 0 long tasks; a whole completion
 *    (snapshot -> flight -> burst -> removal) light and dark 133 frames each, max gap 16.8ms, 0 over 20ms, 0 long tasks.
 * 6. Overflow: documentElement scrollWidth / clientWidth 1720 / 1720 (light, dark, empty, after a burst), 390 / 390
 *    (light, dark), 375 / 375; on a phone the board keeps its lane-by-lane scroll (grid 1560 / 390, 1500 / 375), every
 *    card inside its lane, a tap at the burst origin opens the card. Board pane after a burst 1066 / 1066 x 960 / 960.
 *    At 1440 the four lanes need 918px in a 786px pane and scroll inside the board on main too (resolveLaneModes).
 * 7. Contrast on the card surface, light / dark: title 15.82 / 8.62, #number and time 7.1 / 4.95, lane title
 *    16.39 / 9.57, lane count 7.28 / 7.15. Status pills light: 4.64-5.54 (unchanged). Dark, before -> after: todo
 *    4.47 -> 5.22, doing 4.31 -> 4.89, failed 4.29 -> 4.89; reviewing / chief 4.62, ready / done 4.55, human 4.9 unchanged.
 * 8. Screenshots (2x, ~/.hermes/workspace/ekko-todo-t99-evidence/shots): 01-board, 02-hover, 04-drag, 05-confetti,
 *    06-empty for light and dark; 03-focus-light; 07-phone and 08-phone-confetti for 390 light / dark and 375 light.
 * 9. Not done, on purpose:
 *    - Lanes do not highlight as drop targets: a card can only be dropped on the composer (the server has no "move
 *      card" action and src/server is out of scope), so the composer is what lights up.
 *    - A closed card gets no confetti although it lands in the done lane: closing is not finishing.
 *    - tests/v097 still finds `.ot-card { box-shadow: var(--ek-elev-1) }` in the calm layer; on the board the #99
 *      section overrides it with --ot-card-shadow-rest (ring only), which test 7 of this file holds.
 *    - Empty-lane sentences are those of #101 (not shortened); only the shortcut hint was added.
 *    - After a drop the hover lift of the source card ends with the next pointer move (same as on main).
 *    Not verified: Safari / Firefox, a real touch device, the live plugin inside Studio (this ran on the built dist
 *    behind a fake ctx), frame pacing on a board with hundreds of cards.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  document, window, dispatch, walk, hasClass, byTestId, FakeElement,
  installPageEnvironment, loadClient, mountElement, cleanupClient,
} from './helpers/mini-dom.mjs'
import {
  CARD_EASE, CARD_MOTION, CARD_LAND_SPRING, CONFETTI,
  cardMotionProps, cardMotionClasses, planLaneEntrance, diffBoardTransitions, completionKey,
  makeConfettiParticles, planCelebration, pickBurstOrigin,
} from '../src/client/motion.js'

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')
const css = read('../src/client/styles.css')
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '')
const section = css.slice(css.indexOf('/* ---------- Todo #99: board card motion'))
const sectionCode = stripComments(section)
// The section without its @media blocks: what applies by default.
const sectionBase = sectionCode.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')

const toColumn = td => (td.phase === 'done' || td.phase === 'closed' ? 'done' : td.phase === 'todo' ? 'todo' : td.phase === 'review' ? 'confirm' : 'doing')
const card = (id, phase, extra = {}) => ({ id, number: Number(id.replace(/\D/g, '')) || 1, title: `任务 ${id}`, phase, gateOwner: 'none', projectId: 'p1', kind: 'feature', updatedAt: 1000, evidence: {}, ...extra })

after(() => cleanupClient())

// ---- pure: phase transitions ---------------------------------------------------------------------------------

test('Todo #99 transitions: only a card entering done from another lane is a completion', () => {
  const first = diffBoardTransitions(new Map(), [card('t1', 'building'), card('t2', 'done')], toColumn)
  assert.deepEqual(first.moved, [], 'first load: nothing moved')
  assert.deepEqual(first.completed, [], 'first load: a card already done is not a completion')

  const second = diffBoardTransitions(first.next, [card('t1', 'done', { updatedAt: 2000 }), card('t2', 'done')], toColumn)
  assert.deepEqual(second.moved, [{ id: 't1', col: 'done' }])
  assert.deepEqual(second.completed, [{ id: 't1', key: 't1:done:2000' }])
  assert.equal(completionKey(card('t1', 'done', { updatedAt: 2000 })), 't1:done:2000', 'key = id + phase + updatedAt')

  const replay = diffBoardTransitions(second.next, [card('t1', 'done', { updatedAt: 2000 }), card('t2', 'done')], toColumn)
  assert.deepEqual(replay.moved, [], 'the same snapshot again moves nothing (the landing is not replayed by polling)')
  assert.deepEqual(replay.completed, [])

  const added = diffBoardTransitions(second.next, [card('t1', 'done', { updatedAt: 2000 }), card('t2', 'done'), card('t3', 'done')], toColumn)
  assert.deepEqual(added.completed, [], 'a done card that was not loaded before is not a completion')

  const closed = diffBoardTransitions(first.next, [card('t1', 'closed'), card('t2', 'done')], toColumn)
  assert.deepEqual(closed.moved, [{ id: 't1', col: 'done' }], 'a closed card still lands in the done lane')
  assert.deepEqual(closed.completed, [], 'but closing is not completing')

  const inLane = diffBoardTransitions(second.next, [card('t1', 'done', { updatedAt: 2000, gateOwner: 'chief' }), card('t2', 'done')], toColumn)
  assert.deepEqual(inLane.completed, [], 'a change inside the done lane is not a completion')
})

test('Todo #99 celebration plan: de-duplicated by id + phase + updatedAt, at most 2 groups, none under reduced motion', () => {
  const seen = new Set()
  const one = planCelebration({ completed: [{ id: 't1', key: 't1:done:2000' }], seenKeys: seen })
  assert.equal(one.bursts.length, 1)
  assert.equal(one.bursts[0].anchorId, 't1', 'a single completion bursts on its card')
  assert.deepEqual(one.flashIds, [])

  // A stale snapshot put the card back to doing and the newer one completed it again: same key, no second burst.
  const again = planCelebration({ completed: [{ id: 't1', key: 't1:done:2000' }], seenKeys: seen })
  assert.deepEqual(again, { bursts: [], flashIds: [] })
  // Reopened and completed later (new updatedAt): a new completion.
  assert.equal(planCelebration({ completed: [{ id: 't1', key: 't1:done:9000' }], seenKeys: seen }).bursts.length, 1)

  const many = planCelebration({ completed: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, key: `${id}:done:1` })), seenKeys: new Set() })
  assert.equal(many.bursts.length, CONFETTI.maxGroups)
  assert.equal(CONFETTI.maxGroups, 2)
  assert.deepEqual(many.bursts[0].todoIds, ['a'])
  assert.deepEqual(many.bursts[1].todoIds, ['b', 'c', 'd', 'e'], 'the rest share one burst')
  assert.equal(many.bursts[1].anchorId, '', 'the merged burst sits on the lane, not on one card')

  const two = planCelebration({ completed: [{ id: 'a', key: 'a:done:1' }, { id: 'b', key: 'b:done:1' }], seenKeys: new Set() })
  assert.deepEqual(two.bursts.map(b => b.anchorId), ['a', 'b'])

  const reduced = planCelebration({ completed: [{ id: 'a', key: 'a:done:1' }, { id: 'b', key: 'b:done:1' }], seenKeys: new Set(), reduced: true })
  assert.deepEqual(reduced, { bursts: [], flashIds: ['a', 'b'] }, 'reduced motion: highlight, no confetti')

  const full = planCelebration({ completed: [{ id: 'a', key: 'a:done:1' }], seenKeys: new Set(), activeCount: CONFETTI.maxActive })
  assert.deepEqual(full.bursts, [], 'no burst is added past the cap of live bursts')

  const keys = new Set()
  for (let i = 0; i < CONFETTI.maxSeenKeys + 50; i++) planCelebration({ completed: [{ id: `k${i}`, key: `k${i}:done:1` }], seenKeys: keys })
  assert.equal(keys.size, CONFETTI.maxSeenKeys, 'the key set is bounded')
})

test('Todo #99 particles: 24-36 per burst, 700-1000ms, brand tones only, deterministic, gravity (rise then fall)', () => {
  for (const [asked, want] of [[undefined, 30], [5, 24], [500, 36], [28, 28]]) {
    assert.equal(makeConfettiParticles({ count: asked, seed: 7 }).length, want)
  }
  const ps = makeConfettiParticles({ seed: 42 })
  assert.deepEqual(ps, makeConfettiParticles({ seed: 42 }), 'same seed, same burst')
  assert.notDeepEqual(ps, makeConfettiParticles({ seed: 43 }))
  assert.deepEqual(CONFETTI.tones, ['brand', 'sage', 'ochre'], 'blue / green / amber, no red')
  for (const p of ps) {
    assert.ok(CONFETTI.tones.includes(p.tone))
    assert.ok(p.rise < 0, 'rises first')
    assert.ok(p.fall > p.rise + 60, 'then falls below its apex')
    assert.ok(p.delay >= 0 && p.delay <= CONFETTI.spreadDelayMs)
  }
  assert.ok(ps.some(p => p.dx < -20) && ps.some(p => p.dx > 20), 'fans out to both sides')
  const longest = CONFETTI.startDelayMs + CONFETTI.spreadDelayMs + CONFETTI.durationMs
  assert.ok(CONFETTI.durationMs >= 700 && longest <= 1000, `a particle lives 700-1000ms (${CONFETTI.durationMs}..${longest})`)
  assert.ok(CONFETTI.lifeMs >= longest && CONFETTI.lifeMs <= 1000, 'the burst is removed after its last particle, within 1s')
  assert.equal(CONFETTI.maxActive * CONFETTI.maxParticles, 144, 'hard cap of particle nodes on the board')
})

test('Todo #99 burst origin: the first candidate inside the layer, relative to it; none when all are off screen', () => {
  const bounds = { left: 100, top: 50, right: 500, bottom: 650 }
  assert.deepEqual(pickBurstOrigin([{ x: 300, y: 200 }, { x: 110, y: 60 }], bounds), { x: 200, y: 150 })
  assert.deepEqual(pickBurstOrigin([{ x: 900, y: 200 }, null, { x: 110, y: 60 }], bounds), { x: 10, y: 10 }, 'falls back to the next one')
  assert.equal(pickBurstOrigin([{ x: 900, y: 200 }, { x: NaN, y: 1 }], bounds), null)
  assert.equal(pickBurstOrigin([{ x: 1, y: 1 }], { left: 0, top: 0, right: 0, bottom: 0 }), null, 'a pane that is not laid out gets no burst')
})

// ---- pure: card motion ---------------------------------------------------------------------------------------

test('Todo #99 card motion: hover / press / drag / landing numbers, stable targets, nothing under reduced motion', () => {
  const rest = cardMotionProps()
  assert.equal(rest.initial, false, 'a card seen before mounts at rest')
  assert.deepEqual(rest.animate, { opacity: 1, y: 0, scale: 1, rotate: 0 })
  assert.equal(rest.whileHover.y, -2)
  assert.ok(rest.whileHover.transition.duration >= 0.16 && rest.whileHover.transition.duration <= 0.2)
  assert.deepEqual(rest.whileHover.transition.ease, [0.22, 1, 0.36, 1])
  assert.equal(rest.whileTap.scale, 0.985)
  assert.ok(rest.whileTap.transition.duration >= 0.09 && rest.whileTap.transition.duration <= 0.12)
  assert.equal(rest.transition.scale.type, 'spring', 'release springs back')

  const drag = cardMotionProps({ dragging: true })
  assert.equal(drag.animate.scale, 1.02)
  assert.ok(drag.animate.rotate > 0 && drag.animate.rotate <= 1)
  // Gesture props stay the same objects during a drag: removing whileTap unmounts motion's press listeners, the
  // pointercancel that follows dragstart is then missed and the card stays at 0.985 after the drop.
  assert.equal(drag.whileHover, rest.whileHover)
  assert.equal(drag.whileTap, rest.whileTap)
  assert.equal(cardMotionProps({ dragging: false }).animate, rest.animate, 'drag end returns to the rest target')

  const land = cardMotionProps({ landing: true })
  assert.deepEqual(land.animate.y, [6, 0], 'lands from 6px low')
  assert.equal(land.transition.y, CARD_LAND_SPRING)
  const zeta = CARD_LAND_SPRING.damping / (2 * Math.sqrt(CARD_LAND_SPRING.stiffness * CARD_LAND_SPRING.mass))
  assert.ok(zeta > 0.35 && zeta < 0.7, `under-damped enough for a small overshoot, not a wobble (${zeta.toFixed(2)})`)
  // The 1s live tick re-renders a landed card: it must hand motion the very same target, or the landing replays.
  assert.equal(cardMotionProps({ landing: true }).animate, land.animate)
  assert.equal(cardMotionProps({ landing: true }).transition, land.transition)
  assert.equal(cardMotionProps().animate, rest.animate)

  const enter = cardMotionProps({ enterDelayMs: 64 })
  assert.deepEqual(enter.initial, { opacity: 0, y: 8, scale: 0.98 })
  assert.equal(enter.transition.y.delay, 0.064)
  assert.equal(cardMotionProps({ enterDelayMs: 64 }).transition, enter.transition)
  assert.equal(cardMotionProps({ enterDelayMs: 64, entered: true }).transition, rest.transition, 'the delay ends with the entrance')

  const reduced = cardMotionProps({ enterDelayMs: 64, landing: true, dragging: true, reduced: true })
  assert.equal(reduced.initial, false)
  assert.deepEqual(reduced.animate, { opacity: 1, y: 0, scale: 1, rotate: 0 })
  assert.equal(reduced.whileHover, undefined)
  assert.equal(reduced.whileTap, undefined)
  assert.equal(reduced.transition.duration, 0)

  assert.equal(cardMotionClasses({ justMovedCol: 'done', dragging: true }), 'is-just-moved is-landed--done is-dragging')
  assert.equal(cardMotionClasses({}), '')
  assert.equal(cardMotionClasses({ doneFlash: true }), 'is-done-flash')
})

test('Todo #99 lane entrance: first render staggers up to 12 cards, later only never-shown cards enter, without a cascade', () => {
  const ids = Array.from({ length: 15 }, (_, i) => `c${i}`)
  const first = planLaneEntrance({ ids, seen: new Set(), laneStaggered: false })
  assert.ok(CARD_MOTION.enterStaggerMs >= 24 && CARD_MOTION.enterStaggerMs <= 40)
  assert.equal(CARD_MOTION.enterStaggerMax, 12)
  assert.deepEqual(ids.slice(0, 12).map(id => first[id]), Array.from({ length: 12 }, (_, i) => i * CARD_MOTION.enterStaggerMs))
  assert.deepEqual(ids.slice(12).map(id => first[id]), [384, 384, 384].map(() => 12 * CARD_MOTION.enterStaggerMs), 'cards past the 12th come together')

  const seen = new Set(ids)
  // Filter / search changed: the cards still shown (and cards coming back) do not replay; one new card enters at once.
  const later = planLaneEntrance({ ids: ['c3', 'new1', 'c9'], seen, laneStaggered: true })
  assert.deepEqual(later, { c3: -1, new1: 0, c9: -1 })
  // A card that moved in from another lane was shown before: no entrance (it lands instead).
  assert.deepEqual(planLaneEntrance({ ids: ['c1'], seen, laneStaggered: false }), { c1: -1 })
})

// ---- styles --------------------------------------------------------------------------------------------------

function decls(sel, text = sectionBase) {
  const out = {}
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map(s => s.trim()).includes(sel)) continue
    for (const d of m[2].split(';')) {
      const k = d.indexOf(':')
      if (k > 0) out[d.slice(0, k).trim()] = d.slice(k + 1).trim()
    }
  }
  return out
}
const token = name => (stripComments(css).match(new RegExp(`${name}:\\s*([^;]+);`)) || [])[1]

test('Todo #99 styles: tokens mirror motion.js, only shadow / colour transitions, no literal colour, calm at rest', () => {
  assert.ok(section.length > 1500, 'section found')
  assert.equal(token('--ot-dur-card-hover'), `${CARD_MOTION.hoverMs}ms`)
  assert.equal(token('--ot-dur-card-press'), `${CARD_MOTION.pressMs}ms`)
  assert.equal(token('--ot-ease-card'), `cubic-bezier(${CARD_EASE.join(', ')})`)
  assert.equal(token('--ot-confetti-dur'), `${CONFETTI.durationMs}ms`)
  assert.equal(token('--ot-confetti-start'), `${CONFETTI.startDelayMs}ms`)

  assert.doesNotMatch(sectionCode, /#[0-9a-fA-F]{3,8}\b/, 'no hex')
  assert.doesNotMatch(sectionCode, /rgba?\(/, 'no rgb() / rgba()')
  for (const name of ['--ot-card-shadow-rest', '--ot-card-shadow-hover', '--ot-card-shadow-press', '--ot-card-shadow-drag']) {
    for (const m of stripComments(css).matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))) {
      assert.doesNotMatch(m[1], /rgba?\(|#[0-9a-f]{3,8}\b/i, `${name} is derived from tokens: ${m[1]}`)
    }
  }
  assert.equal((stripComments(css).match(/--ot-card-shadow-hover:/g) || []).length, 2, 'hover shadow is defined for light and dark')

  // Static card: ring only. Hover lifts the shadow, press pulls it back in, drag raises it most.
  assert.equal(token('--ot-card-shadow-rest'), 'var(--ek-ring)')
  const base = decls('.ot-board-grid .ot-card')
  assert.equal(base['box-shadow'], 'var(--ot-card-shadow-rest)')
  assert.match(base.transition, /^box-shadow var\(--ot-dur-card-hover\) var\(--ot-ease-card\)/)
  assert.doesNotMatch(base.transition, /transform|height|top|left|width|all/, 'transform belongs to motion/react; no layout property is animated')
  assert.equal(decls('.ot-board-grid .ot-card:hover')['box-shadow'], 'var(--ot-card-shadow-hover)')
  assert.equal(decls('.ot-board-grid .ot-card:active')['box-shadow'], 'var(--ot-card-shadow-press)')
  assert.equal(decls('.ot-board-grid .ot-card:active')['transition-duration'], 'var(--ot-dur-card-press)')
  assert.equal(decls('.ot-board-grid .ot-card.is-dragging')['box-shadow'], 'var(--ot-card-shadow-drag)')
  assert.equal(decls('.ot-shell .ot-board-grid .ot-card.is-dragging')['box-shadow'], 'var(--ot-card-shadow-drag)', 'the drag shadow also wins over a focus ring left by the pointer')
  assert.ok(sectionBase.indexOf('.ot-card.is-dragging { box-shadow: var(--ot-card-shadow-drag); }') > sectionBase.indexOf('.ot-card:focus-visible'), 'declared after the focus rule')
  assert.match(decls('.ot-shell .ot-board-grid .ot-card:focus-visible')['box-shadow'], /^var\(--ot-focus-ring\)/, 'keyboard focus keeps the shared focus ring')
  assert.match(decls('.ot-board-grid .ot-card.is-selected')['box-shadow'], /var\(--ek-brand\)/)

  // Keyframes of this section move transform / opacity only.
  for (const m of sectionCode.matchAll(/@keyframes\s+(\w+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
    for (const d of m[2].matchAll(/([\w-]+)\s*:/g)) {
      assert.ok(['transform', 'opacity', 'animation-timing-function'].includes(d[1]), `@keyframes ${m[1]} animates ${d[1]}`)
    }
  }
  assert.match(sectionCode, /@keyframes otConfettiY/)
  assert.doesNotMatch(sectionCode, /writing-mode/, 'no vertical text')

  // Lane head sits on the lane surface, one step below the card surface.
  assert.equal(decls('.ot-lane-head').background, 'var(--ot-bg-1)')
  assert.equal(token('--ot-bg-1') !== token('--ot-bg-2'), true)
})

test('Todo #99 styles: the particle layer is click-through and clipped, gone under reduced motion, and a phone card cannot overflow', () => {
  const layer = decls('.ot-confetti-layer')
  assert.equal(layer['pointer-events'], 'none')
  assert.equal(layer.overflow, 'hidden')
  assert.equal(layer.position, 'absolute')
  assert.equal(layer.inset, '0')
  assert.equal(decls('.ot-board-pane').position, 'relative', 'the layer is clipped to the board pane')
  const burst = decls('.ot-confetti-burst')
  assert.equal(burst.width, '0')
  assert.equal(burst.height, '0')
  for (const tone of CONFETTI.tones) assert.match(decls(`.ot-confetti-p--${tone}`)['--c'], /^var\(--ek-(brand|sage|ochre)\)$/)

  const reduce = sectionCode.slice(sectionCode.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(reduce, /\.ot-confetti-layer \{ display: none; \}/)
  assert.match(reduce, /\.ot-board-grid \.ot-card \{ transition: none; \}/)

  // Phone (<= 780px): one lane per screen, lane body padded 12px left / right. The widest a card gets is while it
  // is dragged (scale 1.02 + 0.8deg): it must stay inside that padding at 390 and 375.
  const phone = stripComments(css).match(/\.ot-lane-body \{ padding: 10px (\d+)px max\(14px/)
  assert.ok(phone, 'phone lane padding found')
  const pad = Number(phone[1])
  for (const vw of [390, 375]) {
    const w = vw - 2 * pad
    const h = 108
    const rad = CARD_MOTION.dragRotateDeg * Math.PI / 180
    const half = (w * Math.cos(rad) + h * Math.sin(rad)) * CARD_MOTION.dragScale / 2
    assert.ok(half - w / 2 <= pad, `${vw}px: a dragged card grows ${(half - w / 2).toFixed(1)}px per side, inside ${pad}px`)
  }
  assert.equal(decls('.ot-card', stripComments(css)).width, '100%', 'a card is as wide as its lane, never wider')
})

// ---- mounted board -------------------------------------------------------------------------------------------

const PANE = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0 }
function installGeometry() {
  const proto = FakeElement.prototype
  const had = ['getBoundingClientRect', 'querySelector'].map(k => [k, Object.prototype.hasOwnProperty.call(proto, k), proto[k]])
  proto.getBoundingClientRect = function () { return PANE }
  proto.querySelector = function (sel) {
    const m = /^\[data-testid="([^"]+)"\]$/.exec(sel)
    return m ? byTestId(this, m[1]) : null
  }
  return () => { for (const [k, own, v] of had) { if (own) proto[k] = v; else delete proto[k] } }
}

async function mountBoard({ reduced = false } = {}) {
  const undoEnv = installPageEnvironment({ width: 1440 })
  const prevMatch = window.matchMedia
  window.matchMedia = q => ({ matches: reduced && /prefers-reduced-motion/.test(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
  const undoGeo = installGeometry()
  // A fresh bundle per mount: motion/react reads prefers-reduced-motion once per module instance.
  const mod = await loadClient({ KanbanBoard: 'components/KanbanBoard.jsx' })
  const opened = []
  const el = todos => mod.React.createElement(mod.KanbanBoard, {
    projects: [{ id: 'p1', name: 'demo' }], agents: [], topics: [], todos,
    selectedProjectId: 'all', activeTopicId: '', selectedTodoId: '', onlyHumanAttention: false, boardExpanded: false,
    onOpenTodo: id => opened.push(id),
  })
  const first = [card('t1', 'building'), card('t2', 'review'), card('t3', 'done'), card('t4', 'done')]
  const view = await mountElement(mod, el(first))
  const count = cls => walk(view.container).filter(n => hasClass(n, cls)).length
  return {
    view, first, opened, count, mod,
    render: todos => view.rerender(el(todos)),
    card: id => view.q(`card-${id}`),
    close: async () => { await view.unmount(); undoGeo(); window.matchMedia = prevMatch; undoEnv() },
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('Todo #99 board: confetti fires once when a card completes, never on load / replay / other moves, and cleans itself up', async () => {
  const b = await mountBoard()
  try {
    assert.equal(b.count('ot-confetti-burst'), 0, 'initial load with two done cards: no confetti')
    assert.equal(b.view.q('confetti-layer'), null, 'no particle layer in the DOM while idle')

    await b.render(b.first.map(t => ({ ...t })))
    assert.equal(b.count('ot-confetti-burst'), 0, 'the same snapshot again: no confetti')

    await b.render([card('t1', 'reviewing'), ...b.first.slice(1)])
    assert.equal(b.count('ot-confetti-burst'), 0, 'a move that is not a completion: no confetti')
    assert.ok(hasClass(b.card('t1'), 'is-just-moved'), 'but the card lands')

    const done = [card('t1', 'done', { updatedAt: 2000 }), ...b.first.slice(1)]
    await b.render(done)
    assert.equal(b.count('ot-confetti-burst'), 1, 'completion: one burst')
    const n = b.count('ot-confetti-p')
    assert.ok(n >= 24 && n <= 36, `24-36 particles (${n})`)
    assert.equal(b.view.q('confetti-layer').getAttribute('aria-hidden'), 'true')
    assert.ok(hasClass(b.card('t1'), 'is-landed--done'))
    assert.ok(!hasClass(b.card('t1'), 'is-done-flash'), 'the reduced-motion highlight is not used here')

    await b.render(done.map(t => ({ ...t })))
    await b.render(done.map(t => ({ ...t })))
    assert.equal(b.count('ot-confetti-burst'), 1, 'replayed snapshots do not add a burst')

    // A stale snapshot followed by the newer one again: same id + phase + updatedAt, no second burst.
    await b.render(b.first)
    await b.render(done)
    assert.equal(b.count('ot-confetti-burst'), 1, 'the same completion is never celebrated twice')

    await b.mod.React.act(async () => { await sleep(CONFETTI.lifeMs + 80) })
    await b.view.settle()
    assert.equal(b.count('ot-confetti-burst'), 0, 'the burst removes itself')
    assert.equal(b.count('ot-confetti-p'), 0, 'no particle node is left')
    assert.equal(b.view.q('confetti-layer'), null, 'and the layer is gone')
  } finally {
    await b.close()
  }
})

test('Todo #99 board: several cards completing at once give at most 2 bursts; unmounting mid-burst clears its timers', async () => {
  const b = await mountBoard()
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const live = new Set()
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const h = realSet(() => { live.delete(h); fn() }, ms, ...rest)
    if (ms === CONFETTI.lifeMs) live.add(h)
    return h
  }
  globalThis.clearTimeout = h => { live.delete(h); return realClear(h) }
  try {
    const start = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id => card(id, 'building'))
    await b.render(start)
    assert.equal(b.count('ot-confetti-burst'), 0)
    await b.render(start.map(t => ({ ...t, phase: 'done', updatedAt: 3000 })))
    assert.equal(b.count('ot-confetti-burst'), 2, 'five completions, two bursts')
    assert.ok(b.count('ot-confetti-p') <= 2 * CONFETTI.maxParticles)
    assert.equal(live.size, 2, 'one removal timer per burst')
    await b.view.unmount()
    assert.equal(live.size, 0, 'unmount cleared the removal timers')
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    // unmount already ran inside the try; close() only restores the environment.
    b.view.unmount = async () => {}
    await b.close()
  }
})

test('Todo #99 board: the landing class is set once per move and polling the same snapshot does not bring it back', async () => {
  const b = await mountBoard()
  try {
    assert.equal(b.count('is-just-moved'), 0, 'initial load: nothing lands')
    const moved = [card('t1', 'review'), ...b.first.slice(1)]
    await b.render(moved)
    assert.equal(b.count('is-just-moved'), 1)
    assert.ok(hasClass(b.card('t1'), 'is-landed--confirm'))
    // The 1s polling keeps delivering the same snapshot while the class is on.
    await b.render(moved.map(t => ({ ...t })))
    assert.equal(b.count('is-just-moved'), 1)
    await b.mod.React.act(async () => { await sleep(CARD_MOTION.landedClassMs + 120) })
    await b.view.settle()
    assert.equal(b.count('is-just-moved'), 0, 'cleared after the landing window')
    await b.render(moved.map(t => ({ ...t })))
    await b.render(moved.map(t => ({ ...t })))
    assert.equal(b.count('is-just-moved'), 0, 'the same snapshot does not replay the landing')
  } finally {
    await b.close()
  }
})

test('Todo #99 board: a card is a focusable button, opens on activation, and carries is-dragging only between dragstart and dragend', async () => {
  const b = await mountBoard()
  try {
    const el = b.card('t1')
    assert.equal(el.localName, 'button', 'Tab reaches it and Enter / Space activate it natively')
    assert.equal(el.getAttribute('type'), 'button')
    assert.notEqual(el.getAttribute('tabindex'), '-1')
    assert.equal(el.getAttribute('draggable'), 'true')
    await b.view.click(el)
    assert.deepEqual(b.opened, ['t1'], 'activation opens the card (drag is not the only way to act on it)')

    assert.ok(!hasClass(el, 'is-dragging'))
    const data = {}
    await b.mod.React.act(async () => { dispatch(el, 'dragstart', { dataTransfer: { setData: (k, v) => { data[k] = v }, effectAllowed: '' } }) })
    await b.view.settle()
    assert.ok(hasClass(b.card('t1'), 'is-dragging'), 'dragstart sets the class')
    assert.equal(b.count('is-dragging'), 1, 'only the dragged card')
    assert.match(data['application/x-ekko-todo-card'], /"id":"t1"/, 'the existing drag payload is unchanged')
    await b.mod.React.act(async () => { dispatch(b.card('t1'), 'dragend', {}) })
    await b.view.settle()
    assert.equal(b.count('is-dragging'), 0, 'dragend clears it')
  } finally {
    await b.close()
  }
})

test('Todo #99 board: under reduced motion a completion gives no confetti, only a 150ms highlight on the card', async () => {
  const b = await mountBoard({ reduced: true })
  try {
    const done = [card('t1', 'done', { updatedAt: 2000 }), ...b.first.slice(1)]
    await b.render(done)
    assert.equal(b.count('ot-confetti-burst'), 0, 'no confetti')
    assert.equal(b.count('ot-confetti-p'), 0)
    assert.ok(hasClass(b.card('t1'), 'is-done-flash'), 'the completed card is highlighted')
    assert.equal(b.count('is-done-flash'), 1, 'only that card')
    assert.equal(CARD_MOTION.doneFlashMs, 150)
    await b.mod.React.act(async () => { await sleep(CARD_MOTION.doneFlashMs + 100) })
    await b.view.settle()
    assert.equal(b.count('is-done-flash'), 0, 'and the highlight ends')
    await b.render(done.map(t => ({ ...t })))
    assert.equal(b.count('is-done-flash'), 0, 'a replayed snapshot does not highlight again')
  } finally {
    await b.close()
  }
})

test('Todo #99 board: an empty lane shows its icon, one sentence and a real shortcut; no hint while filters are on', async () => {
  const undoEnv = installPageEnvironment({ width: 1440 })
  try {
    const mod = await loadClient({ LaneEmpty: 'components/KanbanBoard.jsx' })
    const view = await mountElement(mod, mod.React.createElement('div', null,
      mod.React.createElement(mod.LaneEmpty, { laneId: 'todo', hasFilters: false, boardEmpty: false, onCreate() {}, onClearFilters() {} }),
      mod.React.createElement(mod.LaneEmpty, { laneId: 'done', hasFilters: false, boardEmpty: false }),
      mod.React.createElement(mod.LaneEmpty, { laneId: 'doing', hasFilters: true, boardEmpty: false, onClearFilters() {} }),
    ))
    assert.equal(view.q('lane-empty-hint-todo').textContent, 'N新建任务')
    assert.equal(view.q('lane-empty-hint-done').textContent, '⌘P搜索任务')
    assert.equal(view.q('lane-empty-hint-doing'), null, 'a filtered lane offers 「清除筛选」 instead')
    assert.ok(walk(view.q('lane-empty-todo')).some(n => hasClass(n, 'ot-lane-empty-icon')))
    const shortcuts = read('../src/client/components/ShortcutsDialog.jsx')
    assert.match(shortcuts, /label: '新建任务（未输入时）', keys: 'N'/, 'N is a real shortcut')
    assert.match(shortcuts, /label: '搜索任务', keys: '⌘P'/, '⌘P is a real shortcut')
    await view.unmount()
  } finally {
    undoEnv()
  }
})

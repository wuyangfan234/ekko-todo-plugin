// Todo #99: every motion number of the board lives here (or in the `--ot-*-card-*` / `--ot-confetti-*` tokens of
// styles.css, which mirror the values marked "mirrors"). Pure data and pure functions: no React, no DOM, so the
// whole file runs under `node --test`.

/** Easing shared by hover / press / entrance. Mirrors `--ot-ease-card`. */
export const CARD_EASE = [0.22, 1, 0.36, 1]

/** Layout spring: a card flying to another lane or making room for a sibling. */
export const CARD_SPRING = { type: 'spring', stiffness: 420, damping: 30, mass: 0.85 }

export const CARD_MOTION = Object.freeze({
  /** Hover lift in px and its duration. `hoverMs` mirrors `--ot-dur-card-hover`. */
  hoverLiftPx: -2,
  hoverMs: 180,
  /** Press scale and its duration. `pressMs` mirrors `--ot-dur-card-press`. */
  pressScale: 0.985,
  pressMs: 120,
  /** Source card while it is dragged (the rotation stays under 1deg). */
  dragScale: 1.02,
  dragRotateDeg: 0.8,
  /** Landing after a phase change: starts this many px low, springs to 0 with a small overshoot. */
  landFromPx: 6,
  /** First render of a lane: the first `enterStaggerMax` cards come in one after another. */
  enterStaggerMs: 32,
  enterStaggerMax: 12,
  enterMs: 220,
  enterFromPx: 8,
  enterFromScale: 0.98,
  /** How long `is-just-moved` stays on a card. */
  landedClassMs: 1700,
  /** Reduced motion: the completed card is highlighted this long instead of confetti. */
  doneFlashMs: 150,
})

/** Release after a press / drag: back to rest on a spring. */
export const CARD_RELEASE_SPRING = { type: 'spring', stiffness: 520, damping: 26, mass: 0.7 }
/** Landing spring (damping ratio about 0.47, so it passes 0 by roughly 1px once). */
export const CARD_LAND_SPRING = { type: 'spring', stiffness: 520, damping: 18, mass: 0.7 }

// Handed to motion/react as they are, so they are plain (unfrozen) objects with a stable identity.
const HOVER_TWEEN = { duration: CARD_MOTION.hoverMs / 1000, ease: CARD_EASE }
const PRESS_TWEEN = { duration: CARD_MOTION.pressMs / 1000, ease: CARD_EASE }

const REST = { opacity: 1, y: 0, scale: 1, rotate: 0 }
const DRAG = { opacity: 1, y: 0, scale: CARD_MOTION.dragScale, rotate: CARD_MOTION.dragRotateDeg }
const LAND = { opacity: 1, y: [CARD_MOTION.landFromPx, 0], scale: 1, rotate: 0 }
const ENTER_FROM = { opacity: 0, y: CARD_MOTION.enterFromPx, scale: CARD_MOTION.enterFromScale }
const HOVER = { y: CARD_MOTION.hoverLiftPx, transition: HOVER_TWEEN }
const PRESS = { scale: CARD_MOTION.pressScale, transition: PRESS_TWEEN }

const REST_TRANSITION = {
  layout: CARD_SPRING,
  opacity: { duration: 0.18 },
  y: HOVER_TWEEN,
  scale: CARD_RELEASE_SPRING,
  rotate: CARD_RELEASE_SPRING,
}
const LAND_TRANSITION = { ...REST_TRANSITION, y: CARD_LAND_SPRING }
const STILL_TRANSITION = { duration: 0 }
const enterTransitions = new Map()
function enterTransition(delayMs) {
  let t = enterTransitions.get(delayMs)
  if (!t) {
    const tween = { duration: CARD_MOTION.enterMs / 1000, ease: CARD_EASE, delay: delayMs / 1000 }
    t = { layout: CARD_SPRING, opacity: tween, y: tween, scale: tween, rotate: CARD_RELEASE_SPRING }
    enterTransitions.set(delayMs, t)
  }
  return t
}

/**
 * motion/react props of one board card. Every returned object is a module constant (or cached per delay), so a
 * re-render with the same inputs hands motion the same targets and nothing is replayed.
 *
 * @param {{ enterDelayMs?: number, entered?: boolean, landing?: boolean, dragging?: boolean, reduced?: boolean }} input
 *   enterDelayMs: >= 0 plays the entrance after that delay, < 0 mounts at rest (a card seen before).
 *   entered: the entrance finished (the delay must not apply to later hover / press returns).
 */
export function cardMotionProps({ enterDelayMs = -1, entered = false, landing = false, dragging = false, reduced = false } = {}) {
  if (reduced) {
    return { initial: false, animate: REST, transition: STILL_TRANSITION, whileHover: undefined, whileTap: undefined }
  }
  const entering = enterDelayMs >= 0 && !entered
  return {
    initial: enterDelayMs >= 0 ? ENTER_FROM : false,
    animate: dragging ? DRAG : landing ? LAND : REST,
    transition: entering ? enterTransition(enterDelayMs) : landing ? LAND_TRANSITION : REST_TRANSITION,
    // Never switched off while dragging: motion/react drops a gesture's listeners together with its prop, so the
    // pointercancel that follows dragstart would be missed and the card would stay pressed after the drop.
    whileHover: HOVER,
    whileTap: PRESS,
  }
}

/** State classes the motion layer adds to a card. */
export function cardMotionClasses({ justMovedCol = '', dragging = false, doneFlash = false } = {}) {
  return [
    justMovedCol ? `is-just-moved is-landed--${justMovedCol}` : '',
    dragging ? 'is-dragging' : '',
    doneFlash ? 'is-done-flash' : '',
  ].filter(Boolean).join(' ')
}

/**
 * Entrance plan of one lane render.
 * A lane that shows cards for the first time staggers the cards it has never shown (the first `enterStaggerMax`
 * one after another, the rest together right after them). Later, a card that was never shown comes in at once;
 * a card shown before (same lane or another one, e.g. back from a filter) mounts at rest.
 *
 * @param {{ ids: string[], seen: { has(id: string): boolean }, laneStaggered: boolean }} input
 * @returns {Record<string, number>} id -> entrance delay in ms, or -1 for no entrance
 */
export function planLaneEntrance({ ids = [], seen, laneStaggered = false }) {
  const plan = {}
  let fresh = 0
  for (const id of ids) {
    if (seen?.has(id)) { plan[id] = -1; continue }
    plan[id] = laneStaggered ? 0 : Math.min(fresh, CARD_MOTION.enterStaggerMax) * CARD_MOTION.enterStaggerMs
    fresh++
  }
  return plan
}

// ---- Phase transitions -------------------------------------------------------------------------------------

/** Identity of one completion: the same card completing again later (new updatedAt) is a new one. */
export function completionKey(todo) {
  return `${todo.id}:${todo.phase}:${todo.updatedAt ?? ''}`
}

/**
 * Compare a board snapshot with the previous one.
 * `moved`: cards whose lane / phase / gate owner changed. `completed`: cards that entered the done lane from
 * another lane with phase `done` (a card closed without being finished is not celebrated). A card with no
 * previous entry (first load, newly loaded card) is in neither list, and an identical snapshot gives two empty lists.
 *
 * @param {Map<string, string>} prev id -> signature of the previous snapshot
 * @param {object[]} todos
 * @param {(todo: object) => string} toColumn
 */
export function diffBoardTransitions(prev, todos, toColumn) {
  const next = new Map()
  const moved = []
  const completed = []
  for (const td of todos || []) {
    const col = toColumn(td)
    const sig = `${col}:${td.phase}:${td.gateOwner}`
    next.set(td.id, sig)
    const old = prev?.get(td.id)
    if (!old || old === sig) continue
    moved.push({ id: td.id, col })
    if (col === 'done' && td.phase === 'done' && !old.startsWith('done:')) completed.push({ id: td.id, key: completionKey(td) })
  }
  return { next, moved, completed }
}

// ---- Completion confetti -----------------------------------------------------------------------------------

export const CONFETTI = Object.freeze({
  /** Particles per burst, always clamped to [minParticles, maxParticles]. */
  particles: 30,
  minParticles: 24,
  maxParticles: 36,
  /** One particle animates `durationMs` after `startDelayMs` + its own delay (<= `spreadDelayMs`). Mirror the
      `--ot-confetti-*` tokens. The burst element is removed after `lifeMs`. */
  durationMs: 780,
  startDelayMs: 120,
  spreadDelayMs: 60,
  lifeMs: 1000,
  /** Bursts started by one snapshot; more completions than this share the last burst. */
  maxGroups: 2,
  /** Bursts alive at the same time on the board (so at most maxActive * maxParticles particle nodes). */
  maxActive: 4,
  /** Completion keys remembered for de-duplication. */
  maxSeenKeys: 300,
  /** Brand tokens only: blue, green, amber (no red). */
  tones: Object.freeze(['brand', 'sage', 'ochre']),
  shapes: Object.freeze(['bar', 'square', 'dot']),
})

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedFromString(text) {
  let h = 2166136261
  for (const ch of String(text)) h = Math.imul(h ^ ch.codePointAt(0), 16777619)
  return h >>> 0
}

const round1 = n => Math.round(n * 10) / 10

/**
 * Particles of one burst: each flies sideways by `dx`, rises to `rise` (negative px) and then falls to `fall`.
 * Deterministic for a seed.
 */
export function makeConfettiParticles({ count = CONFETTI.particles, seed = 1 } = {}) {
  const n = Math.max(CONFETTI.minParticles, Math.min(CONFETTI.maxParticles, Math.round(Number(count) || CONFETTI.particles)))
  const rnd = mulberry32(seed)
  const out = []
  for (let i = 0; i < n; i++) {
    // An upward fan: angles spread evenly over -80deg..80deg from straight up, each with a little jitter.
    const angle = ((i + 0.5) / n - 0.5) * (160 * Math.PI / 180) + (rnd() - 0.5) * 0.2
    const power = 46 + rnd() * 62
    const rise = -Math.cos(angle) * power
    out.push({
      i,
      dx: round1(Math.sin(angle) * power * 1.25),
      rise: round1(rise),
      fall: round1(rise + 70 + rnd() * 60),
      rot: Math.round((rnd() - 0.5) * 720),
      delay: Math.round(rnd() * CONFETTI.spreadDelayMs),
      tone: CONFETTI.tones[i % CONFETTI.tones.length],
      shape: CONFETTI.shapes[Math.floor(rnd() * CONFETTI.shapes.length)],
      soft: rnd() < 0.35,
    })
  }
  return out
}

/**
 * Decide what to show for the cards one snapshot completed.
 * Keys already in `seenKeys` are ignored (replayed snapshot, repeated render) and new keys are added to it.
 * Reduced motion: no burst, the cards are flashed instead. Otherwise at most `maxGroups` bursts: one per card,
 * and when more cards completed at once the last burst stands for all the remaining ones (anchored on the lane).
 *
 * @param {{ completed: { id: string, key: string }[], seenKeys: Set<string>, reduced?: boolean, activeCount?: number }} input
 * @returns {{ bursts: { id: string, anchorId: string, todoIds: string[], seed: number }[], flashIds: string[] }}
 */
export function planCelebration({ completed = [], seenKeys, reduced = false, activeCount = 0 }) {
  const fresh = []
  for (const c of completed) {
    if (seenKeys.has(c.key)) continue
    seenKeys.add(c.key)
    fresh.push(c)
  }
  while (seenKeys.size > CONFETTI.maxSeenKeys) seenKeys.delete(seenKeys.values().next().value)
  if (fresh.length === 0) return { bursts: [], flashIds: [] }
  if (reduced) return { bursts: [], flashIds: fresh.map(c => c.id) }
  const room = Math.max(0, Math.min(CONFETTI.maxGroups, CONFETTI.maxActive - activeCount))
  const bursts = []
  for (let i = 0; i < fresh.length && bursts.length < room; i++) {
    const last = bursts.length === room - 1
    const group = last ? fresh.slice(i) : [fresh[i]]
    bursts.push({
      id: group[0].key,
      // One card: burst on the card. Several merged cards: burst on the done lane.
      anchorId: group.length === 1 ? group[0].id : '',
      todoIds: group.map(c => c.id),
      seed: seedFromString(group[0].key),
    })
    if (last) break
  }
  return { bursts, flashIds: [] }
}

/**
 * First candidate point that lies inside `bounds`, relative to its top-left corner; null when none does
 * (the card and the done lane are both off screen, so there is nothing to celebrate on).
 *
 * @param {({ x: number, y: number } | null | undefined)[]} candidates viewport points, best first
 * @param {{ left: number, top: number, right: number, bottom: number }} bounds viewport rect of the particle layer
 */
export function pickBurstOrigin(candidates, bounds) {
  if (!bounds || !(bounds.right > bounds.left) || !(bounds.bottom > bounds.top)) return null
  for (const p of candidates || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    if (p.x < bounds.left || p.x > bounds.right || p.y < bounds.top || p.y > bounds.bottom) continue
    return { x: Math.round(p.x - bounds.left), y: Math.round(p.y - bounds.top) }
  }
  return null
}

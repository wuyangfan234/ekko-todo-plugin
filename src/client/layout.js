// Layout rules shared by the workbench shell and the board. Pure functions, no DOM or JSX, so they run under `node --test`.

/** Desktop sidebar width in px. Mirrors `--ot-sidebar-w` in styles.css. */
export const SIDEBAR_WIDTH = 220

/** Narrowest an open lane may get before the board scrolls sideways. */
export const LANE_MIN_WIDTH = 216
/** Width of a folded lane (count + vertical title). */
export const LANE_RAIL_WIDTH = 44
/** `.ot-board-grid` column gap and left + right padding. */
export const BOARD_GAP = 10
export const BOARD_PADDING_X = 24
/** At or below this width the board shows one lane per screen. Mirrors the 780px media query. */
export const PHONE_MAX_WIDTH = 780

/** Board width needed to show `open` open lanes and `rails` folded ones without horizontal scrolling. */
export function boardWidthForOpenLanes(open, rails = 0) {
  const lanes = open + rails
  return open * LANE_MIN_WIDTH + rails * LANE_RAIL_WIDTH + Math.max(0, lanes - 1) * BOARD_GAP + BOARD_PADDING_X
}

/**
 * Decide which lanes are open and which are folded into a rail.
 *
 * - Phone: every lane is open (one lane per screen, switched by the tab strip).
 * - A lane the user folded or reopened by hand keeps that state.
 * - Otherwise lanes stay open unless the measured board is too narrow for all of them; then the empty ones fold,
 *   so lanes that hold cards are not pushed off screen. A lane with cards never folds on its own, and a board
 *   with no cards at all keeps its lanes.
 *
 * @param {{ laneIds: string[], counts: Record<string, number>, userCollapsed?: Record<string, boolean>, boardWidth?: number, phone?: boolean }} input
 * @returns {Record<string, 'open' | 'rail'>}
 */
export function resolveLaneModes({ laneIds, counts = {}, userCollapsed = {}, boardWidth = 0, phone = false }) {
  const modes = {}
  if (phone) {
    for (const id of laneIds) modes[id] = 'open'
    return modes
  }
  let open = 0
  let rails = 0
  for (const id of laneIds) {
    if (userCollapsed[id] === true) { modes[id] = 'rail'; rails++ } else { modes[id] = 'open'; open++ }
  }
  const width = Number(boardWidth) || 0
  const hasCards = laneIds.some(id => Number(counts[id] || 0) > 0)
  if (width <= 0 || !hasCards || boardWidthForOpenLanes(open, rails) <= width) return modes
  for (const id of laneIds) {
    if (modes[id] === 'open' && userCollapsed[id] !== false && Number(counts[id] || 0) === 0) modes[id] = 'rail'
  }
  return modes
}

const INITIAL_LANE_PRIORITY = ['confirm', 'doing', 'todo', 'done']

/** Lane a phone opens on: what waits for the user, else running work, else the backlog, else finished work. */
export function pickInitialLane({ laneIds, counts = {} }) {
  for (const id of INITIAL_LANE_PRIORITY) {
    if (laneIds.includes(id) && Number(counts[id] || 0) > 0) return id
  }
  return laneIds[0] || ''
}

/** Index of the lane page nearest to a horizontal scroll offset. */
export function laneIndexFromScroll(scrollLeft, pageWidth, laneCount) {
  const page = Number(pageWidth) || 0
  if (page <= 0 || laneCount <= 0) return 0
  return Math.max(0, Math.min(laneCount - 1, Math.round((Number(scrollLeft) || 0) / page)))
}

/** The pinned topic brief starts folded to one line on a phone, except when it holds a decision for the user. */
export function briefStartsCollapsed({ phone = false, waiting = false } = {}) {
  return Boolean(phone) && !waiting
}

const BRIEF_SUMMARY_PRIORITY = ['等你', '卡住', '当前']

/** Row shown on the folded brief: what waits for the user, else what is blocked, else progress, else the first row. */
export function pickBriefSummaryRow(rows = []) {
  for (const label of BRIEF_SUMMARY_PRIORITY) {
    const hit = rows.find(row => row[0] === label)
    if (hit) return hit
  }
  return rows[0] || null
}

/** Smallest touch target on a phone, in px, for both width and height. */
export const EFFORT_TICK_MIN = 40
/** Reasoning-effort stops per row on a phone. Seven stops in one row are 37px wide at 390px. */
export const EFFORT_PHONE_MAX_COLUMNS = 4

/** Columns of the reasoning-effort stop grid: one row on desktop, at most four per row on a phone. */
export function effortTickColumns(count, { phone = false } = {}) {
  const n = Math.max(1, Math.floor(Number(count) || 0))
  return phone ? Math.min(EFFORT_PHONE_MAX_COLUMNS, n) : n
}

/** Width of one stop when `columns` equal columns share `rowWidth` with `gap` px between them. */
export function effortTickWidth(rowWidth, columns, gap = 2) {
  const cols = Math.max(1, Math.floor(Number(columns) || 0))
  return ((Number(rowWidth) || 0) - (cols - 1) * gap) / cols
}

/** Agent editor blocks, in page order. */
export const AGENT_SECTION_IDS = ['identity', 'models', 'perms']

/**
 * Which Agent editor blocks start open.
 * Desktop: all of them (there is no fold control there).
 * Phone: the model chain, which is what gets changed most; name/role and permissions fold to a
 * one-line summary so the whole Agent fits one screen. A new Agent also opens name/role, because
 * the name is required before it can be saved.
 */
export function agentSectionsDefaultOpen({ phone = false, isNew = false } = {}) {
  if (!phone) return { identity: true, models: true, perms: true }
  return { identity: Boolean(isNew), models: true, perms: false }
}

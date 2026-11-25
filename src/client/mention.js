// v0.9.41 (Todo #19): @Agent mention helpers for the chat composer, kept free of JSX so `node --test` can load them.
//
// Typing "@" opens the agent picker wherever the user is writing: at the start of a line, after a space
// (half- or full-width), after a newline, right after Chinese text, or after Chinese/English punctuation.
// The only place "@" does not open the picker is directly after an ASCII letter or digit, so typing an
// e-mail address such as "me@example.com" does not pop the picker up.
//
// The full-width "＠" (U+FF20), which a Chinese input method types for the same key, opens the picker too.
// Picking an agent always writes a half-width "@" in its place.

export const MENTION_QUERY_MAX = 24

const TRIGGER_RE = new RegExp(`[@＠]([^\\s@＠]{0,${MENTION_QUERY_MAX}})$`)
const isAtChar = ch => ch === '@' || ch === '＠'
const BLOCKED_BEFORE_AT = /[A-Za-z0-9]/

/**
 * Find the "@query" the caret is currently inside.
 * @param {string} text full composer text
 * @param {number} [cursorPos] caret offset (defaults to end of text)
 * @returns {{ start: number, query: string } | null} start = offset of "@", query = text typed after it
 */
export function findMentionTrigger(text, cursorPos) {
  const value = String(text ?? '')
  const pos = typeof cursorPos === 'number' && cursorPos >= 0 ? Math.min(cursorPos, value.length) : value.length
  const before = value.slice(0, pos)
  const match = before.match(TRIGGER_RE)
  if (!match) return null
  const start = before.length - match[0].length
  const prev = start > 0 ? before[start - 1] : ''
  if (prev && BLOCKED_BEFORE_AT.test(prev)) return null
  return { start, query: match[1] || '' }
}

/**
 * Agents whose name, role label or engine label contains the query (case-insensitive). Empty query = all.
 */
export function filterMentionCandidates(agents, query, labelsOf = () => []) {
  const list = Array.isArray(agents) ? agents : []
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return list
  return list.filter(a => [a?.name, ...labelsOf(a)].some(v => String(v || '').toLowerCase().includes(q)))
}

/**
 * Replace the "@query" (or "＠query") between `start` and the caret with "@<name> ". When there is no open trigger the token
 * is appended (with a separating space if needed). Returns the new text and caret position.
 */
export function applyMention(text, start, cursorPos, name) {
  const value = String(text ?? '')
  const token = `@${name} `
  const pos = typeof cursorPos === 'number' && cursorPos >= 0 ? Math.min(cursorPos, value.length) : value.length
  if (start >= 0 && start <= pos && isAtChar(value[start])) {
    const next = value.slice(0, start) + token + value.slice(pos)
    return { text: next, cursor: start + token.length }
  }
  const spacer = value && !/\s$/.test(value) ? ' ' : ''
  const next = `${value}${spacer}${token}`
  return { text: next, cursor: next.length }
}

/**
 * What the composer's @ button does: insert "@" at the caret (with a leading space after non-space text, as
 * before) and report where the trigger starts. If the caret already sits right after an open "@", nothing is
 * inserted again — the picker just stays open.
 */
export function insertMentionTrigger(text, cursorPos) {
  const value = String(text ?? '')
  const pos = typeof cursorPos === 'number' && cursorPos >= 0 ? Math.min(cursorPos, value.length) : value.length
  if (pos > 0 && isAtChar(value[pos - 1]) && findMentionTrigger(value, pos)) {
    return { text: value, cursor: pos, start: pos - 1 }
  }
  const needsSpace = pos > 0 && !/\s/.test(value[pos - 1])
  const ins = needsSpace ? ' @' : '@'
  const next = value.slice(0, pos) + ins + value.slice(pos)
  const cursor = pos + ins.length
  return { text: next, cursor, start: cursor - 1 }
}

/**
 * A press of the composer's @ button. While the picker is already open the press changes nothing (returns
 * null): the text keeps its single "@" and whatever filter was typed after it. Otherwise it is
 * insertMentionTrigger().
 * @returns {{ text: string, cursor: number, start: number } | null}
 */
export function pressMentionButton(text, cursorPos, pickerOpen) {
  if (pickerOpen) return null
  return insertMentionTrigger(text, cursorPos)
}

/**
 * What the Enter key does in the composer.
 * - picker open with candidates → 'insert' (the highlighted agent; Shift does not matter)
 * - picker open with no candidate → 'swallow' (do nothing: the draft must not be sent while the picker shows "no match")
 * - picker closed → 'send', or 'newline' with Shift (the browser's default line break)
 * @param {{ open: boolean, count: number, shiftKey?: boolean }} state
 * @returns {'insert' | 'swallow' | 'send' | 'newline'}
 */
export function mentionEnterAction({ open, count, shiftKey = false } = {}) {
  if (open) return count > 0 ? 'insert' : 'swallow'
  return shiftKey ? 'newline' : 'send'
}

/** One-line hint shown in the picker when no agent matches. */
export function emptyMentionHint(agentCount, query) {
  if (!agentCount) return '还没有 Agent，先在「Agent」页新建一个'
  const q = String(query ?? '').trim()
  return q ? `没有名字含「${q}」的 Agent，换个字试试` : '没有可 @ 的 Agent'
}

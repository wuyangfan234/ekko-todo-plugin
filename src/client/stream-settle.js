// Keeps the Chief's streamed answer on screen after a turn ends until the saved message list has it.
// Pure helpers (no React, no DOM beyond an injected storage) so `node --test` can cover them.

export const HELD_REPLY_STORAGE_KEY = 'ekko_todo_held_reply_v1'
export const HELD_REPLY_PENDING_AFTER_MS = 8000
export const HELD_REPLY_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const HELD_REPLY_MAX_TOPICS = 8
export const HELD_REPLY_MAX_CHARS = 60000
export const STREAM_DEBUG_FLAG = 'ekko_todo_debug_stream'
export const STREAM_DEBUG_MAX_ENTRIES = 200

const SINCE_SLACK_MS = 5000
// null = the start of the turn was not seen, so there is no boundary to compare host ids with.
const normalizeBoundary = value => (value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value)))
const MIN_CLIPPED_CHARS = 200

function findSaved(text, saved, from) {
  const exact = text.indexOf(saved, from)
  if (exact >= 0) return { end: exact + saved.length }
  // The server stores long messages as their head followed by "…". Such a copy is the saved form of
  // everything from that head on, so the rest of the stream counts as saved too.
  if (saved.length >= MIN_CLIPPED_CHARS && saved.endsWith('…') && text.indexOf(saved.slice(0, -1), from) >= 0) {
    return { end: text.length }
  }
  return null
}

const hostIdNumber = msg => {
  const raw = String(msg?.hostMessageId || '')
  return /^\d+$/.test(raw) ? Number(raw) : 0
}

/**
 * The largest numeric host message id in a saved list (0 when there is none). Taken when a turn starts:
 * a saved message belongs to that turn only when its host id is larger.
 */
export function hostBoundaryOf(messages) {
  let max = 0
  for (const msg of Array.isArray(messages) ? messages : []) max = Math.max(max, hostIdNumber(msg))
  return max
}

/**
 * The part of the streamed text that is not in the saved list yet. The stream is one string for the whole
 * turn (interim notes followed by the final answer); the saved list has one Chief message per part. Each
 * saved Chief message from this turn is located in the stream, in order; what follows the last one found is
 * still unsaved. Returns '' when everything streamed has been saved.
 *
 * "From this turn": with `hostBoundary` (a number), a saved message that has a numeric host id counts only
 * when that id is larger, so the same sentence saved by the previous turn is not taken for this turn's answer.
 * A saved message without a host id, or any message when `hostBoundary` is null (turn start not seen), is
 * judged by time instead: saved no earlier than 5s before `sinceTs`.
 */
export function unsavedStreamTail(streamText, messages, sinceTs = 0, hostBoundary = null) {
  const text = String(streamText || '')
  if (!text.trim()) return ''
  let cursor = 0
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || msg.kind !== 'chief') continue
    const hostId = hostIdNumber(msg)
    if (hostBoundary != null && hostId > 0) {
      if (hostId <= hostBoundary) continue
    } else if (sinceTs > 0 && Number(msg.createdAt || 0) < sinceTs - SINCE_SLACK_MS) continue
    const saved = String(msg.text || '').trim()
    if (!saved) continue
    const hit = findSaved(text, saved, cursor)
    if (hit) cursor = hit.end
  }
  return text.slice(cursor).trim()
}

/** What to keep when a turn ends: null when nothing was streamed or it is already saved. */
export function holdFinalReply({ topicId, streamText, startedAt = 0, hostBoundary = null, messages = [], now = Date.now() }) {
  if (!topicId) return null
  const boundary = normalizeBoundary(hostBoundary)
  const tail = unsavedStreamTail(streamText, messages, startedAt, boundary)
  if (!tail) return null
  return {
    topicId: String(topicId),
    text: String(streamText || '').slice(-HELD_REPLY_MAX_CHARS),
    startedAt: Number(startedAt) || 0,
    endedAt: now,
    hostBoundary: boundary,
  }
}

/**
 * View of a held reply against the current saved list:
 * { text: unsaved part to show, status: 'saved' | 'syncing' | 'pending' }.
 * 'pending' = still not saved HELD_REPLY_PENDING_AFTER_MS after the turn ended (shown with a retry button).
 */
export function resolveHeldReply(held, messages, now = Date.now()) {
  if (!held || !held.text) return { text: '', status: 'saved' }
  const text = unsavedStreamTail(held.text, messages, held.startedAt, normalizeBoundary(held.hostBoundary))
  if (!text) return { text: '', status: 'saved' }
  const waited = now - Number(held.endedAt || 0)
  return { text, status: waited >= HELD_REPLY_PENDING_AFTER_MS ? 'pending' : 'syncing' }
}

export const HELD_SYNC_REASON_MAX_CHARS = 200
export const HELD_SYNC_SAVED_FLASH_MS = 1200

const clipReason = text => {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > HELD_SYNC_REASON_MAX_CHARS ? `${s.slice(0, HELD_SYNC_REASON_MAX_CHARS - 1)}…` : s
}
const chiefCount = list => (Array.isArray(list) ? list : []).filter(m => m?.kind === 'chief').length

/**
 * Result of one manual "sync now" for a held reply: { state: 'saved' | 'still-unsaved' | 'failed', reason }.
 * `before` / `after`: the topic's saved messages before the request and in the returned snapshot. "Saved" is
 * judged by the same `unsavedStreamTail` that decides when the held copy goes away. `error`: what the request
 * threw (its own text is the reason, cut to 200 characters). `applied: false`: the page dropped the returned
 * snapshot because another write landed meanwhile — still judged, reported as stale, never as failed.
 */
export function heldSyncOutcome({ held, before = [], after = [], error = null, applied = true } = {}) {
  if (error != null) {
    const text = clipReason(error?.message || (typeof error === 'string' ? error : '') || String(error)) || 'unknown error'
    return { state: 'failed', reason: text }
  }
  const saved = !unsavedStreamTail(held?.text || '', after, held?.startedAt || 0, normalizeBoundary(held?.hostBoundary))
  if (!applied) {
    return { state: 'still-unsaved', reason: saved ? '服务端已有这条回复，但快照已过期，正在重新拉取' : '快照已过期，正在重新拉取' }
  }
  if (saved) return { state: 'saved', reason: '已写入对话记录' }
  return { state: 'still-unsaved', reason: chiefCount(after) > chiefCount(before) ? '对话记录有新消息，但还不含这条回复' : '服务端还没有写入这条回复' }
}

/** The saved messages of one topic in a state snapshot ([] when absent). */
export function topicMessagesOf(snapshot, topicId) {
  const topic = Array.isArray(snapshot?.topics) ? snapshot.topics.find(t => t?.id === topicId) : null
  return Array.isArray(topic?.messages) ? topic.messages : []
}

/**
 * One manual sync of a held reply. `sync()` resolves to { applied, next, error } and must not throw;
 * `onState` gets { state: 'saving' } first and the judged outcome last. Returns the outcome.
 */
export async function runHeldSync({ held, before = [], sync, onState = () => {} }) {
  onState({ state: 'saving', reason: '' })
  let res
  try {
    res = await sync()
  } catch (error) {
    res = { applied: false, next: null, error }
  }
  const outcome = heldSyncOutcome({ held, before, after: topicMessagesOf(res?.next, held?.topicId), error: res?.error ?? null, applied: res?.applied !== false })
  onState(outcome)
  return outcome
}

function readAll(storage) {
  try {
    const raw = storage?.getItem?.(HELD_REPLY_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(storage, all) {
  try {
    const keys = Object.keys(all)
    if (!keys.length) storage?.removeItem?.(HELD_REPLY_STORAGE_KEY)
    else storage?.setItem?.(HELD_REPLY_STORAGE_KEY, JSON.stringify(all))
  } catch {
    // storage full or unavailable: the reply stays in memory for this page only
  }
}

/** Held replies survive a page reload: one entry per topic, newest HELD_REPLY_MAX_TOPICS topics kept. */
export function saveHeldReply(storage, held) {
  if (!held?.topicId) return
  const all = readAll(storage)
  all[held.topicId] = { text: String(held.text || '').slice(-HELD_REPLY_MAX_CHARS), startedAt: Number(held.startedAt) || 0, endedAt: Number(held.endedAt) || 0, hostBoundary: normalizeBoundary(held.hostBoundary) }
  const ordered = Object.entries(all).sort((a, b) => Number(b[1]?.endedAt || 0) - Number(a[1]?.endedAt || 0))
  writeAll(storage, Object.fromEntries(ordered.slice(0, HELD_REPLY_MAX_TOPICS)))
}

export function loadHeldReply(storage, topicId, now = Date.now()) {
  if (!topicId) return null
  const entry = readAll(storage)[topicId]
  if (!entry || typeof entry.text !== 'string' || !entry.text) return null
  if (now - Number(entry.endedAt || 0) > HELD_REPLY_MAX_AGE_MS) {
    clearHeldReply(storage, topicId)
    return null
  }
  return { topicId: String(topicId), text: entry.text, startedAt: Number(entry.startedAt) || 0, endedAt: Number(entry.endedAt) || 0, hostBoundary: normalizeBoundary(entry.hostBoundary) }
}

export function clearHeldReply(storage, topicId) {
  const all = readAll(storage)
  if (!(topicId in all)) return
  delete all[topicId]
  writeAll(storage, all)
}

/**
 * Developer switch: `localStorage.setItem('ekko_todo_debug_stream', '1')` turns on a trace of the streamed
 * text length, whether the saved list had the reply, and when the streamed copy was removed. Entries go to
 * `window.__ekkoStreamLog` (newest STREAM_DEBUG_MAX_ENTRIES kept) and to `console.debug`. Off by default.
 */
export function createStreamDebug(storage, sink = null, consoleLike = null) {
  const log = Array.isArray(sink) ? sink : []
  const enabled = () => {
    try { return storage?.getItem?.(STREAM_DEBUG_FLAG) === '1' } catch { return false }
  }
  const record = (event, data = {}) => {
    if (!enabled()) return false
    log.push({ at: Date.now(), event: String(event), ...data })
    if (log.length > STREAM_DEBUG_MAX_ENTRIES) log.splice(0, log.length - STREAM_DEBUG_MAX_ENTRIES)
    try { consoleLike?.debug?.('[ekko-todo stream]', event, data) } catch {}
    return true
  }
  return { record, enabled, log }
}

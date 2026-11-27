// Folds one host session stream event into the live stream buffer of the active Chief session.
// Returns true when the buffer changed and the view should be flushed.
//
// The host sends two different things under similar names:
// - `reasoning.delta`: the model's reasoning, in chunks. Appended to `buf.reasoning` (the thinking box).
// - `thinking.delta`: a one-line status of the turn (spinner wording such as "(◕‿◕) pondering..."), sent
//   whole each time, and as an empty string when the host takes it down. It is kept in `buf.status`
//   (latest one wins) for the running status bar and never becomes part of the reasoning text. An empty
//   one is ignored; the line is dropped when reasoning, answer text or a tool call arrives.
//
// v0.9.53 (#52): a turn's frames can reach the client more than once (reconnect replay, a superseded
// attempt re-streaming what it already sent, a second socket).
// - `message.start` / `message.delta` / `message.interim` may carry the host's identity: `turn_id`, plus
//   `segment` (interim seals before the frame) and, on a delta, `offset` (UTF-16 code units of that
//   segment already sent — the unit a JS string indexes in). With a valid identity a delta is upserted
//   into `buf.reply`: the part at or before what the segment already holds is dropped, only the new tail
//   is added. An interim seals its segment once; a re-sent seal and later deltas of a sealed segment are
//   dropped. A different `turn_id` resets the reply and the reasoning (a new turn).
// - Missing or malformed identity (not a non-empty string / not a non-negative integer) falls back to
//   the old append; nothing here throws on bad input.
// - `reasoning.delta` has no identity. A status line that announces a new attempt (retry, fallback,
//   switch to the next pool credential) empties `buf.reasoning`, because the next attempt streams its
//   reasoning again from the start. A new seal or a new `turn_id` empties it too. The line itself only
//   goes to `buf.status`.
//
// #81: on the real host those retry/fallback lines are `status.update` ({kind, text}), and they are
// buffered and dropped when the retry succeeds, so the most common case (empty response, retried, then
// fine) sends no line at all and the second attempt's reasoning was appended to the first. Two fixes:
// - `status.update` is handled only while the buffer is already working (the host also sends it between
//   turns; it never sets `isWorking` or `startedAt`). The line goes to `buf.status`, except `ready`
//   (kind `status`), which only takes the status line down. It empties the reasoning only for the
//   kinds in ATTEMPT_STATUS_KINDS with attempt wording, or kind `fallback`. Compaction progress
//   (`compacting` / `compacted`) and every other kind never touch the reasoning.
// - Structural replay check, independent of any status line: when the reasoning starts over from its
//   own beginning (a chunk, or a run of chunks, that equals the start of what is already in the box),
//   the old copy is dropped and only the new attempt is kept. It counts as a replay once the replayed
//   part covers the whole old reasoning (at least REPLAY_MIN_WHOLE UTF-16 units), or at least
//   max(REPLAY_MIN_CHARS, ceil(old length * REPLAY_MIN_RATIO)) of it. A real retry streams the same
//   text again, so it grows to that share; a long reasoning that quotes its own opening mid-way does
//   not. Until then the chunks are shown as normal text; a chunk that stops matching ends the check and
//   nothing is removed. Cost: on a long reasoning the duplicate stays on screen until the replay has
//   covered half of it (instead of the first 32 units), then disappears.
import { createStreamLoopTracker, observeStreamTool } from '../shared/loop-guard.mjs'

export const REPLAY_MIN_CHARS = 32
export const REPLAY_MIN_WHOLE = 8
export const REPLAY_MIN_RATIO = 0.5

// "⚠️ Empty response from model — retrying (1/3) in 5.8s", "⚠️ … — trying fallback...",
// "🔄 Codex soft failure (…) — switched to the next pool credential, retrying...", the other
// "…, retrying..." lines the host prints before it calls the model again, the reconnect notices
// ("⚠ no response from provider in 30s — reconnecting...", "… made no model progress … Reconnecting.")
// and "switching to fallback provider..." / "↻ Switched to fallback: …".
const ATTEMPT_BOUNDARY = /\bretrying\b|\btrying fallback\b|\bnext pool credential\b|\breconnecting\b|\bswitch(?:ing|ed) to fallback\b/i
// `status.update` kinds that can announce a new attempt (the host's retry lines are `lifecycle`/`status`
// when flushed, `warn` for warnings). `fallback` always means the model changed mid-turn.
const ATTEMPT_STATUS_KINDS = new Set(['status', 'lifecycle', 'warn'])
const FALLBACK_STATUS_KIND = 'fallback'
// Failure copy that only mentions retrying ("… and retrying won't help") is not a new attempt.
const NOT_AN_ATTEMPT = /retrying won['’]t help|stop retrying|keep retrying/i

export function isAttemptBoundary(line) {
  return typeof line === 'string' && ATTEMPT_BOUNDARY.test(line) && !NOT_AN_ATTEMPT.test(line)
}

const turnIdOf = data => {
  const v = data.turn_id ?? data.turnId
  return typeof v === 'string' && v.trim() ? v : ''
}
const indexOf = v => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : -1)

function freshReply(turnId, base) {
  return { turnId, base, segs: [], ends: [], sealed: [] }
}

function replyText(reply) {
  return reply.base + reply.segs.join('')
}

function growTo(reply, segment) {
  while (reply.segs.length <= segment) {
    reply.segs.push('')
    reply.ends.push(0)
    reply.sealed.push(false)
  }
}

// Returns the identity state for `turnId`, starting a new block when the turn changed.
// The first identified frame adopts whatever unidentified text is already on screen as `base`.
function replyFor(buf, turnId) {
  const cur = buf.reply && typeof buf.reply === 'object' && Array.isArray(buf.reply.segs) ? buf.reply : null
  if (!cur) {
    buf.reply = freshReply(turnId, buf.text)
    return { reply: buf.reply, reset: false }
  }
  if (cur.turnId === turnId) return { reply: cur, reset: false }
  buf.reply = freshReply(turnId, '')
  buf.text = ''
  buf.reasoning = ''
  return { reply: buf.reply, reset: true }
}

function markActive(buf) {
  if (!buf.startedAt) buf.startedAt = Date.now()
  buf.isWorking = true
  buf.status = ''
}

// Unidentified text goes to the tail of the current block, so a later identified frame keeps it.
function appendUnidentified(buf, chunk) {
  const reply = buf.reply && Array.isArray(buf.reply.segs) ? buf.reply : null
  if (reply) {
    if (reply.segs.length) reply.segs[reply.segs.length - 1] += chunk
    else reply.base += chunk
  }
  buf.text += chunk
}

function upsertDelta(buf, turnId, segment, offset, chunk) {
  const { reply, reset } = replyFor(buf, turnId)
  growTo(reply, segment)
  if (reply.sealed[segment]) return reset
  const end = reply.ends[segment]
  if (offset + chunk.length <= end) return reset
  const piece = offset < end ? chunk.slice(end - offset) : chunk
  reply.segs[segment] += piece
  reply.ends[segment] = offset + chunk.length
  if (segment === reply.segs.length - 1) buf.text += piece
  else buf.text = replyText(reply)
  markActive(buf)
  return true
}

// The host strips the sealed text and decides "already streamed" on whitespace-collapsed text, while
// the streamed deltas keep the model's own blank lines; compare the same way.
const norm = s => s.replace(/\s+/g, ' ').trim()

// `text` collapses to `cur` plus more: the part of `text` after the last non-space character of `cur`.
// `cur` keeps its own whitespace, so the tail's leading whitespace is dropped when `cur` already ends in some.
function unstreamedTail(cur, text) {
  let left = cur.replace(/\s+/g, '').length
  let i = 0
  while (i < text.length && left > 0) {
    if (!/\s/.test(text[i])) left -= 1
    i += 1
  }
  const tail = text.slice(i)
  return /\s$/.test(cur) ? tail.replace(/^\s+/, '') : tail
}

function sealSegment(buf, turnId, segment, text, alreadyStreamed) {
  const { reply, reset } = replyFor(buf, turnId)
  growTo(reply, segment)
  if (reply.sealed[segment]) return reset
  reply.sealed[segment] = true
  const cur = reply.segs[segment]
  if (text && alreadyStreamed) {
    const t = norm(text)
    if (!cur) {
      if (!norm(buf.text).endsWith(t)) reply.segs[segment] = text
    } else {
      const c = norm(cur)
      if (c.startsWith(t)) {
        // already on screen: keep the streamed text as it is
      } else if (t.startsWith(c)) {
        reply.segs[segment] = cur + unstreamedTail(cur, text)
      } else {
        reply.segs[segment] = cur + text
      }
    }
  } else if (text) {
    if (!cur) {
      reply.segs[segment] = text
    } else if (text.startsWith(cur)) {
      reply.segs[segment] = text
    } else if (!cur.startsWith(text)) {
      reply.segs[segment] = cur + text
    }
  }
  buf.text = replyText(reply)
  buf.reasoning = ''
  markActive(buf)
  return true
}

export function isAttemptStatus(kind, line) {
  if (kind === FALLBACK_STATUS_KIND) return true
  return ATTEMPT_STATUS_KINDS.has(kind) && isAttemptBoundary(line)
}

// Appends a reasoning chunk, or drops the previous attempt's copy when the reasoning starts over.
// `buf.replayTail` holds the text received since a suspected restart; it is only trusted while
// `buf.reasoning` still ends with it (an outside reset of `buf.reasoning` invalidates it).
// A replay of the earlier reasoning `prior` is accepted only when the replayed part covers enough of it:
// all of it (at least REPLAY_MIN_WHOLE units), or at least max(REPLAY_MIN_CHARS, ceil(prior * REPLAY_MIN_RATIO)).
// A chunk that runs past the whole earlier reasoning replaces it only when that earlier reasoning is at
// least REPLAY_MIN_WHOLE units and makes up at least REPLAY_MIN_RATIO of the new text.
function replayCovers(prior, replayed) {
  if (replayed === prior.length) return prior.length >= REPLAY_MIN_WHOLE
  return replayed >= Math.max(REPLAY_MIN_CHARS, Math.ceil(prior.length * REPLAY_MIN_RATIO))
}
function overrunReplaces(prior, next) {
  return prior.length >= REPLAY_MIN_WHOLE && prior.length >= Math.ceil(next.length * REPLAY_MIN_RATIO)
}

function appendReasoning(buf, chunk) {
  const cur = buf.reasoning || ''
  const tail = typeof buf.replayTail === 'string' && buf.replayTail && cur.endsWith(buf.replayTail) ? buf.replayTail : ''
  buf.replayTail = ''
  if (tail) {
    const prior = cur.slice(0, cur.length - tail.length)
    const next = tail + chunk
    if (prior.startsWith(next)) {
      if (replayCovers(prior, next.length)) {
        buf.reasoning = next
      } else {
        buf.reasoning = cur + chunk
        buf.replayTail = next
      }
      return
    }
    if (next.startsWith(prior) && overrunReplaces(prior, next)) {
      buf.reasoning = next
      return
    }
    // stopped matching: ordinary text; the chunk may still open a new check against the start
  }
  if (cur && chunk.startsWith(cur) && overrunReplaces(cur, chunk)) {
    buf.reasoning = chunk
    return
  }
  if (cur && cur.startsWith(chunk)) {
    if (replayCovers(cur, chunk.length)) {
      buf.reasoning = chunk
      return
    }
    buf.replayTail = chunk
  }
  buf.reasoning = cur + chunk
}

export function applyStreamEvent(buf, rawEvt) {
  if (!rawEvt || typeof rawEvt !== 'object') return false
  const type = String(rawEvt.event || '')
  const data = rawEvt.data && typeof rawEvt.data === 'object' ? rawEvt.data : rawEvt

  if (type === 'message.start') {
    const turnId = turnIdOf(data)
    if (!turnId) return false
    return replyFor(buf, turnId).reset
  } else if (type === 'message.delta' || type === 'message.interim') {
    const chunk = typeof data.delta === 'string' ? data.delta : (typeof data.text === 'string' ? data.text : '')
    const turnId = turnIdOf(data)
    const segment = indexOf(data.segment)
    if (turnId && segment >= 0) {
      if (type === 'message.interim') return sealSegment(buf, turnId, segment, chunk, data.already_streamed === true)
      const offset = indexOf(data.offset)
      if (offset >= 0 && chunk) return upsertDelta(buf, turnId, segment, offset, chunk)
    }
    if (chunk) {
      markActive(buf)
      appendUnidentified(buf, chunk)
      return true
    }
  } else if (type === 'reasoning.delta') {
    const chunk = typeof data.delta === 'string' ? data.delta : (typeof data.text === 'string' ? data.text : '')
    if (chunk) {
      markActive(buf)
      appendReasoning(buf, chunk)
      return true
    }
  } else if (type === 'status.update') {
    // Host shape: {kind, text}; with no text the host sends the kind as the text (kind `status`).
    // The host also sends it outside a turn (`ready` after a manual compaction or a busy lock,
    // `compacted`), so it never marks the session as running: an idle buffer ignores it entirely.
    if (!buf.isWorking) return false
    const kind = typeof data.text === 'string' ? (typeof data.kind === 'string' ? data.kind : '') : 'status'
    const raw = typeof data.text === 'string' ? data.text : (typeof data.kind === 'string' ? data.kind : '')
    const line = raw.trim()
    if (!line) return false
    if (kind === 'status' && line === 'ready') {
      if (!buf.status) return false
      buf.status = ''
      return true
    }
    buf.status = line
    if (isAttemptStatus(kind, line)) {
      buf.reasoning = ''
      buf.replayTail = ''
    }
    return true
  } else if (type === 'thinking.delta') {
    const raw = typeof data.delta === 'string' ? data.delta : (typeof data.text === 'string' ? data.text : '')
    const line = raw.trim()
    if (line) {
      if (!buf.startedAt) buf.startedAt = Date.now()
      buf.isWorking = true
      buf.status = line
      if (isAttemptBoundary(line)) {
        buf.reasoning = ''
        buf.replayTail = ''
      }
      return true
    }
  } else if (type === 'tool.started') {
    const callId = String(data.callId || data.call_id || data.toolCallId || data.id || `tool-${Date.now()}`)
    const name = String(data.name || data.tool || data.toolName || data.title || 'tool')
    if (!buf.startedAt) buf.startedAt = Date.now()
    buf.isWorking = true
    buf.status = ''
    // Same sentence again and again, or schema reads with nothing executed: tell the user right away.
    if (!buf.loopTracker) buf.loopTracker = createStreamLoopTracker()
    buf.loop = observeStreamTool(buf.loopTracker, buf.text, name)
    const idx = buf.tools.findIndex(t => t.callId === callId)
    if (idx >= 0) buf.tools[idx] = { ...buf.tools[idx], status: 'running' }
    else buf.tools.push({ callId, name, status: 'running' })
    return true
  } else if (type === 'tool.completed' || type === 'tool.failed') {
    const callId = String(data.callId || data.call_id || data.toolCallId || data.id || '')
    const status = type === 'tool.failed' ? 'failed' : 'done'
    const idx = callId ? buf.tools.findIndex(t => t.callId === callId) : buf.tools.findLastIndex(t => t.status === 'running')
    if (idx >= 0) buf.tools[idx] = { ...buf.tools[idx], status }
    else if (data.name || data.toolName) buf.tools.push({ callId: callId || `t-${Date.now()}`, name: String(data.name || data.toolName), status })
    return true
  } else if (type === 'usage.updated' || type === 'run.usage.updated') {
    const u = data.usage || data.run_usage || data
    buf.usage = {
      inputTokens: Number(u.inputTokens ?? u.input_tokens ?? buf.usage?.inputTokens ?? 0),
      outputTokens: Number(u.outputTokens ?? u.output_tokens ?? buf.usage?.outputTokens ?? 0),
    }
    return true
  }
  return false
}

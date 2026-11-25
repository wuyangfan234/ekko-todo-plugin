// 0.9.42: the user's bubble is drawn the moment "send" is pressed, before the server answers.
// Every send gets a nonce made here. The server stores it on the message (or on the queued follow-up) and
// returns it as `clientNonce`; that is how the bubble drawn here is replaced by the stored one, never
// shown twice. Pure functions only, so the rules can be tested without a browser.

const NONCE_RE = /^[A-Za-z0-9_.:-]{1,64}$/

let nonceCounter = 0

/** A nonce the server accepts: `cn-<time>-<counter>-<random>`, at most 64 characters. */
export function createClientNonce(now = Date.now(), random = Math.random) {
  nonceCounter = (nonceCounter + 1) % 1e6
  const rand = Math.floor(random() * 0xffffffff).toString(36)
  return `cn-${now.toString(36)}-${nonceCounter.toString(36)}-${rand}`.slice(0, 64)
}

export function isClientNonce(value) {
  return typeof value === 'string' && NONCE_RE.test(value)
}

/** Text of the bubble; the same sentence the server stores for a send that has files and no text. */
export function optimisticText(text, attachments = []) {
  const clean = String(text || '').trim()
  if (clean) return clean
  const files = Array.isArray(attachments) ? attachments : []
  return files.length ? `请查看我上传的 ${files.length} 个附件（${files.map(a => a?.name).join('、')}）` : ''
}

/** One entry of the list of sends the server has not confirmed yet. */
export function createPendingSend({ nonce, topicId, text, attachments = [], now = Date.now(), seq = 0 }) {
  return {
    nonce,
    topicId: String(topicId || ''),
    text: optimisticText(text, attachments),
    attachments: (Array.isArray(attachments) ? attachments : []).map(a => ({ id: a?.id, name: a?.name, path: a?.path, size: a?.size, type: a?.type, mediaType: a?.mediaType })),
    createdAt: now,
    seq,
    status: 'sending',
    error: '',
  }
}

function serverNonces(topic) {
  const set = new Set()
  for (const m of topic?.messages || []) if (m?.clientNonce) set.add(m.clientNonce)
  for (const q of topic?.queuedItems || []) if (q?.clientNonce) set.add(q.clientNonce)
  return set
}

/** Drops the sends the server now holds (as a message or as a queued follow-up). Same array when nothing changed. */
export function prunePendingSends(pending, topics) {
  const list = Array.isArray(pending) ? pending : []
  if (!list.length) return list
  const byTopic = new Map()
  for (const t of topics || []) byTopic.set(t.id, serverNonces(t))
  const next = list.filter(p => !byTopic.get(p.topicId)?.has(p.nonce))
  return next.length === list.length ? list : next
}

export function markPendingFailed(pending, nonce, errorText) {
  return (Array.isArray(pending) ? pending : []).map(p => (p.nonce === nonce
    ? { ...p, status: 'failed', error: String(errorText || '').trim() || '消息没有发出去，请重试。' }
    : p))
}

/** A new send in a topic replaces the failed bubbles left there (their text is back in the composer). */
export function addPendingSend(pending, entry) {
  const kept = (Array.isArray(pending) ? pending : []).filter(p => !(p.topicId === entry.topicId && p.status === 'failed'))
  return [...kept, entry]
}

/**
 * The list the chat draws: stored messages in the server's order, then the unconfirmed sends of this topic.
 * - A stored message appears once, even if the list carries the same id or the same nonce twice.
 * - A send whose nonce the server already holds is not drawn again.
 * - Unconfirmed sends keep the order they were made in (time, then sequence number).
 */
export function mergeOptimisticMessages(topic, pending) {
  const stored = Array.isArray(topic?.messages) ? topic.messages : []
  const mine = (Array.isArray(pending) ? pending : []).filter(p => p.topicId === topic?.id)
  const seenIds = new Set()
  const seenNonces = new Set()
  let duplicate = false
  for (const m of stored) {
    if ((m?.id && seenIds.has(m.id)) || (m?.clientNonce && seenNonces.has(m.clientNonce))) { duplicate = true; break }
    if (m?.id) seenIds.add(m.id)
    if (m?.clientNonce) seenNonces.add(m.clientNonce)
  }
  if (!mine.length && !duplicate) return stored

  const out = []
  seenIds.clear()
  seenNonces.clear()
  for (const m of stored) {
    if ((m?.id && seenIds.has(m.id)) || (m?.clientNonce && seenNonces.has(m.clientNonce))) continue
    if (m?.id) seenIds.add(m.id)
    if (m?.clientNonce) seenNonces.add(m.clientNonce)
    out.push(m)
  }
  for (const q of topic?.queuedItems || []) if (q?.clientNonce) seenNonces.add(q.clientNonce)
  const waiting = mine
    .filter(p => !seenNonces.has(p.nonce))
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq))
  for (const p of waiting) {
    if (seenNonces.has(p.nonce)) continue
    seenNonces.add(p.nonce)
    out.push({
      id: `pending-${p.nonce}`,
      topicId: p.topicId,
      kind: 'human',
      text: p.text,
      attachments: p.attachments,
      createdAt: p.createdAt,
      clientNonce: p.nonce,
      pending: p.status !== 'failed',
      ...(p.status === 'failed' ? { sendError: p.error } : {}),
    })
  }
  return out
}

/**
 * What the bubble shows under it.
 * - 'failed': the message carries a reason (`sendError`).
 * - 'sending': drawn by the page, the server has not confirmed it.
 * - 'starting': stored, and the server is still starting the Chief turn for this very message
 *   (`topic.launchingMessageId`).
 * - 'stored': nothing to show.
 */
export function sendStateOf(msg, launchingMessageId = '') {
  if (msg?.sendError) return 'failed'
  if (msg?.pending) return 'sending'
  if (launchingMessageId && msg?.id === launchingMessageId) return 'starting'
  return 'stored'
}

/** React key that stays the same when the drawn bubble is replaced by the stored message. */
export function messageKey(msg) {
  return msg?.clientNonce ? `n-${msg.clientNonce}` : msg?.id
}

// --- refresh gate -------------------------------------------------------------------------------------
// `board.updated` reasons that announce the user's own message. They are read at once; every other reason
// (build output, activity ticks) stays in the 800 ms window that protects rate-limited tunnels.
export const REFRESH_GATE_MS = 800

export function isUserMessageUpdate(reason) {
  return /^topic\.message\.(accepted|queued|failed):/.test(String(reason || ''))
}

export function refreshWaitMs({ last = 0, now = Date.now(), urgent = false } = {}) {
  if (urgent) return 0
  return Math.max(0, last + REFRESH_GATE_MS - now)
}

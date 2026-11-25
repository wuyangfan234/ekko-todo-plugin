// v0.9.27: per-topic composer draft cache.
// The chat composer is unmounted whenever the user opens another plugin page (board, quota, settings…),
// so unsent text and already-uploaded attachments used to vanish. We persist them in the browser's
// localStorage, keyed by topic id, and restore them on the next mount of the same topic.
//
// Only small data is stored: the text, task-card references, and for each uploaded file the reference the
// plugin already received (path, name, type, size) plus an optional small thumbnail data URL for images.
// The original file bytes are never written. One topic's draft is capped at DRAFT_MAX_BYTES; when the cap is
// exceeded the text is kept and images become "图片需要重新上传" placeholders (they cannot be sent).

export const DRAFT_KEY_PREFIX = 'ekko_todo_draft:'
export const DRAFT_MAX_BYTES = 200 * 1024
export const DRAFT_MAX_TOPICS = 40
export const THUMB_MAX_EDGE = 160
export const THUMB_MAX_CHARS = 24 * 1024
export const REUPLOAD_LABEL = '图片需要重新上传'

const NEW_TOPIC_KEY = '__new__'

export function draftKey(topicId) {
  const id = String(topicId || '').trim()
  return `${DRAFT_KEY_PREFIX}${id || NEW_TOPIC_KEY}`
}

export function getDraftStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage
  } catch {}
  return null
}

function utf8Bytes(str) {
  const s = String(str || '')
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length
  return unescape(encodeURIComponent(s)).length
}

function cleanStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function isSmallDataUrl(v) {
  return typeof v === 'string' && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(v) && v.length <= THUMB_MAX_CHARS
}

// Reduce an in-memory attachment to the reference fields the plugin already has. Blob URLs are dropped
// (they die with the page); only a small `thumb` data URL is kept for the preview.
export function toStoredFile(att) {
  if (!att || typeof att !== 'object') return null
  const id = cleanStr(att.id, 80) || `att-${Math.random().toString(36).slice(2, 10)}`
  const name = cleanStr(att.name, 300)
  const type = att.type === 'image' ? 'image' : 'file'
  if (att.needsReupload) return { id, type, name, needsReupload: true }
  const path = cleanStr(att.path, 4096)
  if (!path) return null
  const out = { id, type, name, path }
  const mediaType = cleanStr(att.mediaType, 200)
  if (mediaType) out.mediaType = mediaType
  if (Number.isFinite(att.size) && att.size >= 0) out.size = att.size
  const thumb = isSmallDataUrl(att.thumb) ? att.thumb : (isSmallDataUrl(att.previewUrl) ? att.previewUrl : '')
  if (type === 'image' && thumb) out.thumb = thumb
  return out
}

function toStoredCard(card) {
  if (!card || typeof card !== 'object' || !card.id) return null
  return {
    id: cleanStr(String(card.id), 120),
    number: Number.isFinite(card.number) ? card.number : (Number(card.number) || 0),
    title: cleanStr(card.title, 300),
  }
}

// Build the JSON string stored for one topic, enforcing the per-topic byte budget.
// Returns '' when there is nothing worth keeping.
export function serializeDraft({ text = '', files = [], cards = [] } = {}, maxBytes = DRAFT_MAX_BYTES) {
  let body = typeof text === 'string' ? text : ''
  let storedFiles = (Array.isArray(files) ? files : []).map(toStoredFile).filter(Boolean)
  const storedCards = (Array.isArray(cards) ? cards : []).map(toStoredCard).filter(Boolean)
  if (!body && !storedFiles.length && !storedCards.length) return ''

  const encode = () => JSON.stringify({ v: 1, savedAt: Date.now(), text: body, files: storedFiles, cards: storedCards })
  let json = encode()
  if (utf8Bytes(json) <= maxBytes) return json

  // Over budget: keep the text, turn images into "needs re-upload" placeholders.
  storedFiles = storedFiles.map(f => (f.type === 'image' ? { id: f.id, type: 'image', name: f.name, needsReupload: true } : f))
  json = encode()
  if (utf8Bytes(json) <= maxBytes) return json

  // Still over: drop file references, then shorten the text as a last resort so the cap always holds.
  storedFiles = storedFiles.filter(f => f.type === 'image').map(f => ({ ...f, name: f.name.slice(0, 80) }))
  json = encode()
  while (utf8Bytes(json) > maxBytes && body.length > 0) {
    const over = utf8Bytes(json) - maxBytes
    body = body.slice(0, Math.max(0, body.length - Math.max(64, Math.ceil(over / 3) + 16)))
    json = encode()
  }
  if (utf8Bytes(json) > maxBytes) {
    storedFiles = []
    json = encode()
  }
  return json
}

export function parseDraft(raw) {
  const empty = { text: '', files: [], cards: [] }
  if (!raw || typeof raw !== 'string') return empty
  let data
  try { data = JSON.parse(raw) } catch { return empty }
  if (!data || typeof data !== 'object') return empty
  const text = typeof data.text === 'string' ? data.text : ''
  const files = (Array.isArray(data.files) ? data.files : []).map(toStoredFile).filter(Boolean)
    .map(f => (f.thumb ? { ...f, previewUrl: f.thumb } : f))
  const cards = (Array.isArray(data.cards) ? data.cards : []).map(toStoredCard).filter(Boolean)
  return { text, files, cards }
}

export function loadDraft(storage, topicId) {
  if (!storage) return parseDraft('')
  try { return parseDraft(storage.getItem(draftKey(topicId))) } catch { return parseDraft('') }
}

export function clearDraft(storage, topicId) {
  if (!storage) return
  try { storage.removeItem(draftKey(topicId)) } catch {}
}

function pruneOldDrafts(storage, keepKey) {
  try {
    const entries = []
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i)
      if (!k || !k.startsWith(DRAFT_KEY_PREFIX) || k === keepKey) continue
      let savedAt = 0
      try { savedAt = Number(JSON.parse(storage.getItem(k) || '{}')?.savedAt) || 0 } catch {}
      entries.push({ k, savedAt })
    }
    if (entries.length < DRAFT_MAX_TOPICS) return
    entries.sort((a, b) => a.savedAt - b.savedAt)
    for (const e of entries.slice(0, entries.length - DRAFT_MAX_TOPICS + 1)) storage.removeItem(e.k)
  } catch {}
}

// Persist one topic's draft. An empty draft removes the key. Returns the stored JSON ('' when cleared).
export function saveDraft(storage, topicId, draft) {
  if (!storage) return ''
  const key = draftKey(topicId)
  const json = serializeDraft(draft)
  try {
    if (!json) {
      storage.removeItem(key)
      return ''
    }
    pruneOldDrafts(storage, key)
    storage.setItem(key, json)
    return json
  } catch {
    // Quota exceeded: retry with images as placeholders only.
    try {
      const fallback = serializeDraft({
        ...draft,
        files: (draft?.files || []).map(f => (f?.type === 'image' ? { ...f, needsReupload: true } : f)),
      })
      if (fallback) storage.setItem(key, fallback)
      return fallback
    } catch {
      return ''
    }
  }
}

// Attachments that can really be sent (placeholders are excluded) with UI-only fields stripped.
export function sendableAttachments(files) {
  return (Array.isArray(files) ? files : [])
    .filter(f => f && !f.needsReupload && f.path)
    .map(({ previewUrl: _p, thumb: _t, needsReupload: _n, ...rest }) => rest)
}

// Browser-only: render a small JPEG thumbnail for an image File. Resolves '' when not possible.
export async function makeImageThumb(file, maxEdge = THUMB_MAX_EDGE) {
  try {
    if (!file || typeof document === 'undefined' || typeof createImageBitmap !== 'function') return ''
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bmp.width || 1, bmp.height || 1))
    const w = Math.max(1, Math.round((bmp.width || 1) * scale))
    const h = Math.max(1, Math.round((bmp.height || 1) * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const g = canvas.getContext('2d')
    if (!g) return ''
    g.drawImage(bmp, 0, 0, w, h)
    try { bmp.close?.() } catch {}
    for (const q of [0.72, 0.5, 0.35]) {
      const url = canvas.toDataURL('image/jpeg', q)
      if (url.length <= THUMB_MAX_CHARS) return url
    }
    return ''
  } catch {
    return ''
  }
}

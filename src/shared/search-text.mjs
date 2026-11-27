// Todo #98: one matching rule for every search box (command palette, board filter, project workspace,
// memory search) and for the server's search-workspace RPC.
//
// - The query is NFKC-normalised (full-width ＃１２３ → #123), trimmed, inner whitespace collapsed, and
//   cut to MAX_SEARCH_QUERY_CHARS.
// - Matching is a literal substring test (no LIKE wildcards, no regex), case-insensitive for ASCII only
//   (the same folding SQLite lower() does, so client and server agree). Chinese is never split into words:
//   「跨项目」 hits 「跨项目串台」.
// - A query with spaces also matches when every space-separated term hits somewhere (AND), so
//   「看板 搜索」 finds 「修复看板的搜索」 — but the whole phrase is tried first and ranks higher.
// - `#123` / `123` (digits only) is also an exact card number.

export const MAX_SEARCH_QUERY_CHARS = 200

// Score of each matched field (higher first; ties by updated_at desc). Exported for docs and tests.
export const SEARCH_FIELD_SCORES = Object.freeze({
  number_hash: 1100, // query written as #N and N is the card number
  title_exact: 1000,
  title_prefix: 900,
  title: 800,
  title_terms: 750, // multi-term query: every term in the title
  number: 700, // bare digits equal to the card number
  branch: 600,
  tags: 560,
  agent: 540,
  project: 520,
  topic: 500,
  brief_goal: 460,
  brief_progress: 450,
  brief_next: 440,
  brief_waiting: 430,
  repo: 460,
  description: 420,
  spec: 400,
  content: 400,
  last_error: 350,
  timeline: 300,
  chat: 200,
  messages: 200,
  terms: 100, // multi-term query: every term hit somewhere, the phrase did not
})

export const MAX_SEARCH_TERMS = 5

/** ASCII-only lower case, identical to SQLite lower() without ICU. */
export function foldCase(text) {
  return String(text ?? '').replace(/[A-Z]+/g, s => s.toLowerCase())
}

/** Normalised query text ('' when nothing searchable is left). */
export function normalizeSearchQuery(raw) {
  let text = String(raw ?? '')
  try { text = text.normalize('NFKC') } catch { /* keep raw */ }
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > MAX_SEARCH_QUERY_CHARS) text = text.slice(0, MAX_SEARCH_QUERY_CHARS).trim()
  return text
}

/** Card number a query names: '#98', '98', '＃９８' → 98; anything else → null. */
export function parseNumberQuery(raw) {
  const q = normalizeSearchQuery(raw)
  const m = /^#?\s*(\d{1,9})$/.exec(q)
  return m ? Number(m[1]) : null
}

/** Space-separated terms of a normalised query (at most MAX_SEARCH_TERMS, duplicates removed). */
export function searchTerms(query) {
  const q = foldCase(normalizeSearchQuery(query))
  if (!q) return []
  return [...new Set(q.split(' ').filter(Boolean))].slice(0, MAX_SEARCH_TERMS)
}

/**
 * Whether `haystack` (string or list of strings) matches `query`: the whole phrase as a substring, or —
 * for a multi-term query — every term as a substring of some part.
 */
export function matchesQuery(haystack, query) {
  const q = foldCase(normalizeSearchQuery(query))
  if (!q) return true
  const parts = (Array.isArray(haystack) ? haystack : [haystack]).map(x => foldCase(x))
  if (parts.some(p => p.includes(q))) return true
  const terms = searchTerms(q)
  if (terms.length < 2) return false
  return terms.every(t => parts.some(p => p.includes(t)))
}

/**
 * Split `text` into [{ text, hit }] for highlighting: hits are the whole phrase, else each term.
 * Never throws on special characters (no regex is built from the query).
 */
export function highlightSegments(text, query) {
  const src = String(text ?? '')
  const q = foldCase(normalizeSearchQuery(query))
  if (!src || !q) return [{ text: src, hit: false }]
  const lower = foldCase(src)
  const needles = lower.includes(q) ? [q] : searchTerms(q).sort((a, b) => b.length - a.length)
  const ranges = []
  for (const n of needles) {
    if (!n) continue
    let from = 0
    while (from <= lower.length) {
      const at = lower.indexOf(n, from)
      if (at < 0) break
      if (!ranges.some(([s, e]) => at < e && at + n.length > s)) ranges.push([at, at + n.length])
      from = at + n.length
      if (ranges.length > 50) break
    }
  }
  if (!ranges.length) return [{ text: src, hit: false }]
  ranges.sort((a, b) => a[0] - b[0])
  const out = []
  let pos = 0
  for (const [s, e] of ranges) {
    if (s > pos) out.push({ text: src.slice(pos, s), hit: false })
    out.push({ text: src.slice(s, e), hit: true })
    pos = e
  }
  if (pos < src.length) out.push({ text: src.slice(pos), hit: false })
  return out
}

/** A short window of `text` around the first hit of `query` (single line, ellipses where cut). */
export function makeSnippet(text, query, { before = 24, after = 72 } = {}) {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!src) return ''
  const lower = foldCase(src)
  const q = foldCase(normalizeSearchQuery(query))
  let at = q ? lower.indexOf(q) : -1
  let len = q.length
  if (at < 0 && q) {
    for (const t of searchTerms(q)) {
      const i = lower.indexOf(t)
      if (i >= 0 && (at < 0 || i < at)) { at = i; len = t.length }
    }
  }
  if (at < 0) return src.length > before + after ? `${src.slice(0, before + after)}…` : src
  const start = Math.max(0, at - before)
  const end = Math.min(src.length, at + len + after)
  return `${start > 0 ? '…' : ''}${src.slice(start, end)}${end < src.length ? '…' : ''}`
}

/**
 * Searchable text of one card as the board knows it (Todo #98): the same fields search-workspace reads,
 * minus worker chat (not worth keeping per card in memory). Used by the board / project filters so that a
 * card already loaded matches immediately, before the server answers.
 */
export function todoSearchFields(td, { agentName = '', reviewerName = '', projectLabel = '', topicTitle = '' } = {}) {
  if (!td) return []
  return [
    `#${td.number}`, td.title || '', td.branch || '', ...(td.tags || []), agentName, reviewerName,
    projectLabel, topicTitle, td.spec || '', td.lastError || '',
    ...(Array.isArray(td.timeline) ? td.timeline.map(e => String(e?.event ?? '')) : []),
  ]
}

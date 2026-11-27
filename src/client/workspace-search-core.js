// Todo #98: React-free core of the client search (unit-tested in node): the debounce / stale-answer
// scheduler and the same-shape local fallback of search-workspace.
import { SEARCH_FIELD_SCORES as S, foldCase, makeSnippet, matchesQuery, normalizeSearchQuery, parseNumberQuery } from '../shared/search-text.mjs'

export const SEARCH_DEBOUNCE_MS = 300

/**
 * The scheduling core of useWorkspaceSearch, without React (unit-tested directly):
 * `update({ query, paused, active, input })` cancels the pending timer, and — unless paused (IME
 * composition) or inactive — schedules one call after `debounceMs` (0 for the empty "recent" query).
 * Every update bumps a sequence number; an answer whose sequence is not the latest is dropped (the host
 * RPC cannot be aborted, so "cancel the in-flight request" means its answer is never used).
 */
export function createSearchRunner({ call, onState, debounceMs = SEARCH_DEBOUNCE_MS, schedule = setTimeout, cancel = clearTimeout }) {
  let seq = 0
  let timer = null
  const clear = () => { if (timer !== null) { cancel(timer); timer = null } }
  return {
    update({ query, paused = false, active = true, input }) {
      clear()
      if (paused) return
      const mine = ++seq
      if (!active) { onState({ status: 'idle', result: null, error: '', query: '' }); return }
      onState(prev => ({ ...(prev || {}), status: 'loading', error: '' }))
      timer = schedule(() => {
        timer = null
        Promise.resolve()
          .then(() => call(input))
          .then(result => { if (mine === seq) onState({ status: 'ready', result: result || null, error: '', query }) })
          .catch(err => { if (mine === seq) onState({ status: 'error', result: null, error: String(err?.message || err || '搜索失败'), query }) })
      }, query ? debounceMs : 0)
    },
    dispose() { clear(); seq += 1 },
  }
}

/** Items of one group of a search-workspace result ([] when absent). */
export function groupItems(result, type) {
  return result?.groups?.find(g => g.type === type)?.items || []
}

export function groupMeta(result, type) {
  const g = result?.groups?.find(x => x.type === type)
  return { total: g?.total || 0, hasMore: Boolean(g?.hasMore) }
}

// Rank of the first field of `fields` ([name, text | text[]]) holding the whole phrase, else 'terms' when
// every term hits somewhere, else null. Mirrors the CASE order of server/search.mjs.
function rankFields(fields, q) {
  const fq = foldCase(q)
  for (const [name, text] of fields) {
    const list = Array.isArray(text) ? text : [text]
    for (const t of list) {
      const ft = foldCase(t)
      if (!ft) continue
      if (name === 'title') {
        if (ft === fq) return { field: 'title_exact', src: t }
        if (ft.startsWith(fq)) return { field: 'title_prefix', src: t }
      }
      if (ft.includes(fq)) return { field: name, src: t }
    }
  }
  const all = fields.flatMap(([, text]) => (Array.isArray(text) ? text : [text]))
  if (q.includes(' ')) {
    const title = fields.find(([name]) => name === 'title')
    const titleText = title ? (Array.isArray(title[1]) ? title[1] : [title[1]]).join(' ') : ''
    if (titleText && matchesQuery([titleText], q)) return { field: 'title_terms', src: titleText }
    if (matchesQuery(all, q)) return { field: 'terms', src: all.join(' · ') }
  }
  return null
}

/**
 * search-workspace over the loaded snapshot, same input / output shape. Used only when the host RPC is
 * not available (preview / tests); stubbed cards have no spec or timeline here.
 */
export function localWorkspaceSearch(state, input = {}) {
  const scope = input.scope || 'all'
  const raw = String(input.query ?? '')
  const q = normalizeSearchQuery(raw)
  const recent = raw === ''
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20))
  const types = scope === 'all' ? ['todos', 'topics', 'projects', 'memories'] : [scope]
  const projects = state?.projects || []
  const projectById = new Map(projects.map(p => [p.id, p]))
  const agentById = new Map((state?.agents || []).map(a => [a.id, a]))
  const topicById = new Map((state?.topics || []).map(t => [t.id, t]))
  const label = p => (p ? p.displayName || p.name || '' : '')
  const hashNum = q.startsWith('#') ? parseNumberQuery(q) : null
  const num = hashNum === null ? parseNumberQuery(q) : null
  const byScore = (a, b) => b.score - a.score || (b.updatedAt || 0) - (a.updatedAt || 0)
  const build = {
    todos: () => (state?.todos || [])
      .filter(td => (!input.projectId || td.projectId === input.projectId) && (!input.topicId || td.topicId === input.topicId))
      .map(td => {
        const base = { type: 'todo', id: td.id, number: td.number, title: td.title, projectId: td.projectId || '', topicId: td.topicId || '', projectName: label(projectById.get(td.projectId)), phase: td.phase, kind: td.kind, branch: td.branch || '', updatedAt: td.updatedAt || 0 }
        if (recent) return { ...base, snippet: '', matchedField: '', score: 0 }
        if (hashNum !== null && td.number === hashNum) return { ...base, snippet: `#${td.number} ${td.title}`, matchedField: 'number_hash', score: S.number_hash }
        const pre = rankFields([['title', td.title || '']], q)
        if (pre) return { ...base, snippet: makeSnippet(pre.src, q), matchedField: pre.field, score: S[pre.field] }
        if (num !== null && td.number === num) return { ...base, snippet: `#${td.number} ${td.title}`, matchedField: 'number', score: S.number }
        const hit = rankFields([
          ['branch', td.branch || ''], ['tags', td.tags || []],
          ['agent', [agentById.get(td.agentId)?.name || '', agentById.get(td.reviewerId)?.name || '']],
          ['project', [projectById.get(td.projectId)?.name || '', projectById.get(td.projectId)?.displayName || '']],
          ['topic', topicById.get(td.topicId)?.title || ''], ['spec', td.spec || ''], ['last_error', td.lastError || ''],
          ['timeline', (td.timeline || []).map(e => String(e?.event ?? ''))],
          ['chat', (td.buildChat || []).map(e => String(e?.text ?? ''))],
        ], q)
        return hit ? { ...base, snippet: makeSnippet(hit.src, q), matchedField: hit.field, score: S[hit.field] } : null
      }),
    topics: () => (state?.topics || [])
      .filter(tp => (!input.projectId || !tp.projectId || tp.projectId === input.projectId) && (!recent || !tp.archived))
      .map(tp => {
        const base = { type: 'topic', id: tp.id, title: tp.title, projectId: tp.projectId || '', topicId: tp.id, projectName: label(projectById.get(tp.projectId)), archived: Boolean(tp.archived), updatedAt: tp.updatedAt || 0 }
        if (recent) return { ...base, snippet: '', matchedField: '', score: 0 }
        const b = tp.brief || {}
        const hit = rankFields([['title', tp.title || ''], ['brief_goal', b.goal || ''], ['brief_progress', b.progress || ''], ['brief_next', b.next || ''], ['brief_waiting', [b.waitingOnYou || '', b.waitingTitle || '', b.blocked || '']], ['messages', (tp.messages || []).map(m => String(m?.text ?? ''))]], q)
        return hit ? { ...base, snippet: makeSnippet(hit.src, q), matchedField: hit.field, score: S[hit.field] } : null
      }),
    projects: () => projects
      .filter(p => !input.projectId || p.id === input.projectId)
      .map(p => {
        const base = { type: 'project', id: p.id, title: label(p), projectId: p.id, topicId: '', projectName: label(p), updatedAt: p.updatedAt || 0 }
        if (recent) return { ...base, snippet: p.githubRepo || '', matchedField: '', score: 0 }
        const hit = rankFields([['title', [p.name || '', p.displayName || '']], ['repo', [p.githubRepo || '', p.repoPath || '']], ['description', p.description || '']], q)
        return hit ? { ...base, snippet: makeSnippet(hit.src, q), matchedField: hit.field, score: S[hit.field] } : null
      }),
    memories: () => (state?.memories || [])
      .filter(m => !input.memoryScope || input.memoryScope === 'all' || m.scope === input.memoryScope)
      .map(m => {
        const base = { type: 'memory', id: m.id, title: m.title, projectId: m.scope === 'project' ? m.scopeId || '' : '', topicId: '', memoryScope: m.scope, category: m.category, updatedAt: m.updatedAt || 0 }
        if (recent) return { ...base, snippet: '', matchedField: '', score: 0 }
        const hit = rankFields([['title', m.title || ''], ['content', m.content || '']], q)
        return hit ? { ...base, snippet: makeSnippet(hit.src, q), matchedField: hit.field, score: S[hit.field] } : null
      }),
  }
  const out = { query: q, scope, recent, truncated: false, groups: [], total: 0, hasMore: false, tookMs: 0 }
  if (!recent && !q) {
    out.groups = types.map(type => ({ type, items: [], total: 0, hasMore: false }))
    return out
  }
  for (const type of types) {
    const all = build[type]().filter(Boolean)
    if (!recent) all.sort(byScore)
    const items = all.slice(0, limit)
    out.groups.push({ type, items, total: all.length, hasMore: all.length > items.length })
    out.total += all.length
    if (all.length > items.length) out.hasMore = true
  }
  return out
}

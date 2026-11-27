// Todo #98: server-side search across the whole workspace (search-workspace RPC).
//
// Every group is ONE SQL statement under (user_id, profile): the score is a CASE over the fields in rank
// order (CASE stops at the first hit, so the costly JSON scans of timeline / worker chat / topic messages
// only run for rows nothing cheaper matched), `COUNT(*) OVER ()` gives the total, and LIMIT is applied in
// SQL. Snippets are cut in SQL with substr() around the hit, so a long spec, timeline or conversation is
// never copied into the response. Matching is instr() on lower(): a literal substring test — `%`, `_` and
// `\` are ordinary characters, nothing is split into words (Chinese 「跨项目」 hits 「跨项目串台」), and the
// query is ASCII-lower-cased with foldCase so it matches what SQLite lower() does to the stored text.

import { MAX_SEARCH_QUERY_CHARS, SEARCH_FIELD_SCORES, foldCase, makeSnippet, normalizeSearchQuery, parseNumberQuery, searchTerms } from '../shared/search-text.mjs'

export const SEARCH_SCOPES = ['all', 'todos', 'topics', 'projects', 'memories']
export const SEARCH_DEFAULT_GROUP_LIMIT = 20
export const SEARCH_DEFAULT_TOTAL_LIMIT = 50
export const SEARCH_MAX_LIMIT = 100
const GROUP_ORDER = ['todos', 'topics', 'projects', 'memories']

// Score table lives in shared/search-text.mjs so the client's local fallback ranks the same way.
export { SEARCH_FIELD_SCORES }

const S = SEARCH_FIELD_SCORES
// Score → field name, per result type (some scores are shared across types, e.g. spec / content).
const TYPE_FIELDS = {
  todos: ['number_hash', 'title_exact', 'title_prefix', 'title', 'title_terms', 'number', 'branch', 'tags', 'agent', 'project', 'topic', 'spec', 'last_error', 'timeline', 'chat', 'terms'],
  topics: ['title_exact', 'title_prefix', 'title', 'title_terms', 'brief_goal', 'brief_progress', 'brief_next', 'brief_waiting', 'messages', 'terms'],
  projects: ['title_exact', 'title_prefix', 'title', 'title_terms', 'repo', 'description', 'terms'],
  memories: ['title_exact', 'title_prefix', 'title', 'title_terms', 'content', 'terms'],
}
const FIELD_BY_SCORE = Object.fromEntries(Object.entries(TYPE_FIELDS).map(([type, keys]) => [type, Object.fromEntries(keys.map(k => [S[k], k]))]))
const fieldOf = (type, score) => FIELD_BY_SCORE[type][score] || 'title'

// Malformed JSON must not make json_each / json_extract throw for the whole query.
const J = (col, empty) => `(CASE WHEN json_valid(${col}) THEN ${col} ELSE '${empty}' END)`
const HIT = col => `instr(lower(coalesce(${col}, '')), $q) > 0`
// Window of `col` around the hit of `needle` (a bound parameter), at most 240 characters.
const WINDOW = (col, needle = '$q') => `substr(${col}, max(1, instr(lower(${col}), ${needle}) - 40), 240)`

function clampLimit(v, fallback) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(SEARCH_MAX_LIMIT, n))
}

// Multi-term query: every term in the title ranks as a title hit (title_terms); every term somewhere in
// the row ranks lowest (terms).
function termsClause(hay, terms, titleSql = '') {
  if (terms.length < 2) return ''
  const all = h => terms.map((_, i) => `instr(${h}, $t${i}) > 0`).join(' AND ')
  return `${titleSql ? `WHEN ${all(titleSql)} THEN ${S.title_terms}` : ''}
        WHEN ${all(hay)} THEN ${S.terms}`
}

function termParams(terms) {
  const out = {}
  for (let i = 0; i < 5; i++) out[`t${i}`] = terms[i] ?? ''
  return out
}

export function createSearchEngine(db) {
  const cache = new Map()
  // node:sqlite refuses unknown named parameters, so bind only the names the statement uses.
  const prep = sql => {
    let entry = cache.get(sql)
    if (!entry) {
      const names = new Set([...sql.matchAll(/\$([a-z][a-z0-9]*)/gi)].map(m => m[1]))
      entry = { st: db.prepare(sql), names }
      if (cache.size > 64) cache.clear()
      cache.set(sql, entry)
    }
    return {
      all: params => entry.st.all(Object.fromEntries(Object.entries(params).filter(([k]) => entry.names.has(k)))),
    }
  }

  function searchTodos(id, q, ctx) {
    const { terms, num, hashNum, limit, projectId, topicId } = ctx
    const where = ['t.user_id = $uid', 't.profile = $profile']
    if (projectId) where.push('t.project_id = $pid')
    if (topicId) where.push('t.topic_id = $tid')
    const hay = `lower(t.title || ' ' || t.spec || ' ' || t.branch || ' ' || t.tags_json || ' ' || coalesce(p.name, '') || ' ' || coalesce(p.display_name, '') || ' ' || coalesce(a.name, '') || ' ' || coalesce(tp.title, ''))`
    const scoreSql = q ? `CASE
        ${hashNum !== null ? `WHEN t.number = $num THEN ${S.number_hash}` : ''}
        WHEN lower(t.title) = $q THEN ${S.title_exact}
        WHEN substr(lower(t.title), 1, length($q)) = $q THEN ${S.title_prefix}
        WHEN ${HIT('t.title')} THEN ${S.title}
        ${num !== null ? `WHEN t.number = $num THEN ${S.number}` : ''}
        WHEN ${HIT('t.branch')} THEN ${S.branch}
        WHEN EXISTS (SELECT 1 FROM json_each(${J('t.tags_json', '[]')}) WHERE ${HIT('value')}) THEN ${S.tags}
        WHEN ${HIT('a.name')} OR ${HIT('r.name')} THEN ${S.agent}
        WHEN ${HIT('p.name')} OR ${HIT('p.display_name')} THEN ${S.project}
        WHEN ${HIT('tp.title')} THEN ${S.topic}
        WHEN ${HIT('t.spec')} THEN ${S.spec}
        WHEN ${HIT('t.last_error')} THEN ${S.last_error}
        WHEN EXISTS (SELECT 1 FROM json_each(${J('t.timeline_json', '[]')}) WHERE ${HIT("json_extract(value, '$.event')")}) THEN ${S.timeline}
        WHEN EXISTS (SELECT 1 FROM json_each(${J('t.build_chat_json', '[]')}) WHERE ${HIT("json_extract(value, '$.text')")}) THEN ${S.chat}
        ${termsClause(hay, terms, 'lower(t.title)')}
        ELSE 0 END` : '1'
    const sql = `
      WITH base AS MATERIALIZED (
        SELECT t.id, t.number, t.title, t.phase, t.kind, t.project_id, t.topic_id, t.branch, t.updated_at,
               p.name AS p_name, p.display_name AS p_alias, ${scoreSql} AS score
        FROM todos t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN agents a ON a.id = t.agent_id
        LEFT JOIN agents r ON r.id = t.reviewer_id
        LEFT JOIN topics tp ON tp.id = t.topic_id
        WHERE ${where.join(' AND ')}
      ),
      top AS MATERIALIZED (
        SELECT *, COUNT(*) OVER () AS total FROM base WHERE score > 0
        ORDER BY score DESC, updated_at DESC, number DESC LIMIT $limit
      )
      SELECT top.*,
        CASE top.score
          WHEN ${S.spec} THEN ${WINDOW('t.spec')}
          WHEN ${S.last_error} THEN ${WINDOW('t.last_error')}
          WHEN ${S.terms} THEN ${WINDOW("(t.title || ' · ' || t.spec)", '$t0')}
          WHEN ${S.timeline} THEN (SELECT ${WINDOW("json_extract(value, '$.event')")} FROM json_each(${J('t.timeline_json', '[]')})
                                   WHERE ${HIT("json_extract(value, '$.event')")} ORDER BY CAST(key AS INTEGER) DESC LIMIT 1)
          WHEN ${S.chat} THEN (SELECT ${WINDOW("json_extract(value, '$.text')")} FROM json_each(${J('t.build_chat_json', '[]')})
                               WHERE ${HIT("json_extract(value, '$.text')")} ORDER BY CAST(key AS INTEGER) DESC LIMIT 1)
          WHEN ${S.tags} THEN (SELECT group_concat(value, ' ') FROM json_each(${J('t.tags_json', '[]')}))
          WHEN ${S.agent} THEN (SELECT coalesce(a.name, '') || ' ' || coalesce(r.name, '') FROM agents a LEFT JOIN agents r ON r.id = t.reviewer_id WHERE a.id = t.agent_id)
          WHEN ${S.topic} THEN (SELECT title FROM topics WHERE id = t.topic_id)
          ELSE NULL END AS snippet_src
      FROM top JOIN todos t ON t.id = top.id
      ORDER BY top.score DESC, top.updated_at DESC, top.number DESC`
    const rows = prep(sql).all({ ...id, q, num: num ?? hashNum ?? -1, limit, pid: projectId || '', tid: topicId || '', ...termParams(terms) })
    const total = rows[0]?.total ?? 0
    return {
      total,
      items: rows.map(r => {
        const field = q ? fieldOf('todos', r.score) : ''
        const projectName = r.p_alias || r.p_name || ''
        let src = r.snippet_src
        if (!src) {
          if (field === 'branch') src = r.branch
          else if (field === 'project') src = projectName
          else if (field === 'number' || field === 'number_hash') src = `#${r.number} ${r.title}`
          else src = r.title
        }
        return {
          type: 'todo', id: r.id, number: r.number, title: r.title,
          snippet: q ? makeSnippet(src, field === 'terms' ? terms[0] : q) : '',
          matchedField: field, score: q ? r.score : 0,
          projectId: r.project_id, topicId: r.topic_id || '',
          projectName, phase: r.phase, kind: r.kind, branch: r.branch || '', updatedAt: r.updated_at,
        }
      }),
    }
  }

  function searchTopics(id, q, ctx) {
    const { terms, limit, projectId } = ctx
    const where = ['tp.user_id = $uid', 'tp.profile = $profile']
    if (projectId) where.push("(tp.project_id = $pid OR tp.project_id = '')")
    const B = key => `json_extract(${J('tp.brief_json', '{}')}, '$.${key}')`
    const hay = `lower(tp.title || ' ' || coalesce(${B('goal')}, '') || ' ' || coalesce(${B('progress')}, '') || ' ' || coalesce(${B('next')}, '') || ' ' || coalesce(${B('waitingOnYou')}, ''))`
    const scoreSql = q ? `CASE
        WHEN lower(tp.title) = $q THEN ${S.title_exact}
        WHEN substr(lower(tp.title), 1, length($q)) = $q THEN ${S.title_prefix}
        WHEN ${HIT('tp.title')} THEN ${S.title}
        WHEN ${HIT(B('goal'))} THEN ${S.brief_goal}
        WHEN ${HIT(B('progress'))} THEN ${S.brief_progress}
        WHEN ${HIT(B('next'))} THEN ${S.brief_next}
        WHEN ${HIT(B('waitingOnYou'))} OR ${HIT(B('waitingTitle'))} OR ${HIT(B('blocked'))} THEN ${S.brief_waiting}
        WHEN EXISTS (SELECT 1 FROM topic_messages m WHERE m.topic_id = tp.id AND ${HIT('m.text')}) THEN ${S.messages}
        ${termsClause(hay, terms, 'lower(tp.title)')}
        ELSE 0 END` : '1'
    const order = q ? 'score DESC, archived ASC, updated_at DESC' : 'archived ASC, pinned DESC, updated_at DESC'
    const sql = `
      WITH base AS MATERIALIZED (
        SELECT tp.id, tp.title, tp.project_id, tp.archived, tp.pinned, tp.updated_at, ${scoreSql} AS score
        FROM topics tp WHERE ${where.join(' AND ')} ${q ? '' : 'AND tp.archived = 0'}
      ),
      top AS MATERIALIZED (
        SELECT *, COUNT(*) OVER () AS total FROM base WHERE score > 0 ORDER BY ${order} LIMIT $limit
      )
      SELECT top.*, p.name AS p_name, p.display_name AS p_alias,
        CASE top.score
          WHEN ${S.brief_goal} THEN ${B('goal')}
          WHEN ${S.brief_progress} THEN ${B('progress')}
          WHEN ${S.brief_next} THEN ${B('next')}
          WHEN ${S.brief_waiting} THEN coalesce(${B('waitingTitle')}, '') || ' ' || coalesce(${B('waitingOnYou')}, '') || ' ' || coalesce(${B('blocked')}, '')
          WHEN ${S.terms} THEN tp.title || ' · ' || coalesce(${B('goal')}, '')
          WHEN ${S.messages} THEN (SELECT ${WINDOW('m.text')} FROM topic_messages m WHERE m.topic_id = tp.id AND ${HIT('m.text')}
                                   ORDER BY m.created_at DESC LIMIT 1)
          ELSE NULL END AS snippet_src
      FROM top JOIN topics tp ON tp.id = top.id LEFT JOIN projects p ON p.id = top.project_id
      ORDER BY ${order.replace(/(\w+) /g, 'top.$1 ')}`
    const rows = prep(sql).all({ ...id, q, limit, pid: projectId || '', ...termParams(terms) })
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map(r => {
        const field = q ? fieldOf('topics', r.score) : ''
        return {
          type: 'topic', id: r.id, title: r.title,
          snippet: q ? makeSnippet(r.snippet_src || r.title, field === 'terms' ? terms[0] : q) : '',
          matchedField: field, score: q ? r.score : 0,
          projectId: r.project_id || '', topicId: r.id, projectName: r.p_alias || r.p_name || '',
          archived: Boolean(r.archived), updatedAt: r.updated_at,
        }
      }),
    }
  }

  function searchProjects(id, q, ctx) {
    const { terms, limit, projectId } = ctx
    const where = ['p.user_id = $uid', 'p.profile = $profile']
    if (projectId) where.push('p.id = $pid')
    const hay = "lower(p.name || ' ' || p.display_name || ' ' || p.github_repo || ' ' || p.repo_path || ' ' || p.description)"
    const scoreSql = q ? `CASE
        WHEN lower(p.name) = $q OR lower(p.display_name) = $q THEN ${S.title_exact}
        WHEN substr(lower(p.name), 1, length($q)) = $q OR substr(lower(p.display_name), 1, length($q)) = $q THEN ${S.title_prefix}
        WHEN ${HIT('p.name')} OR ${HIT('p.display_name')} THEN ${S.title}
        WHEN ${HIT('p.github_repo')} OR ${HIT('p.repo_path')} OR ${HIT('p.remote_url')} THEN ${S.repo}
        WHEN ${HIT('p.description')} THEN ${S.description}
        ${termsClause(hay, terms, "lower(p.name || ' ' || p.display_name)")}
        ELSE 0 END` : '1'
    const sql = `
      WITH base AS MATERIALIZED (
        SELECT p.id, p.name, p.display_name, p.github_repo, p.repo_path, p.description, p.created_at, p.updated_at, ${scoreSql} AS score
        FROM projects p WHERE ${where.join(' AND ')}
      )
      SELECT *, COUNT(*) OVER () AS total FROM base WHERE score > 0
      ORDER BY score DESC, ${q ? 'updated_at DESC' : 'created_at ASC'} LIMIT $limit`
    const rows = prep(sql).all({ ...id, q, limit, pid: projectId || '', ...termParams(terms) })
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map(r => {
        const field = q ? fieldOf('projects', r.score) : ''
        const label = r.display_name || r.name
        const src = field === 'repo' ? `${r.github_repo || ''} ${r.repo_path || ''}` : field === 'description' ? r.description : label
        return {
          type: 'project', id: r.id, title: label,
          snippet: q ? makeSnippet(src, field === 'terms' ? terms[0] : q) : (r.github_repo || ''),
          matchedField: field, score: q ? r.score : 0, projectId: r.id, topicId: '', projectName: label,
          updatedAt: r.updated_at,
        }
      }),
    }
  }

  function searchMemories(id, q, ctx) {
    const { terms, limit, memoryScope } = ctx
    const where = ['m.user_id = $uid', 'm.profile = $profile']
    if (memoryScope && memoryScope !== 'all') where.push('m.scope = $mscope')
    const scoreSql = q ? `CASE
        WHEN lower(m.title) = $q THEN ${S.title_exact}
        WHEN substr(lower(m.title), 1, length($q)) = $q THEN ${S.title_prefix}
        WHEN ${HIT('m.title')} THEN ${S.title}
        WHEN ${HIT('m.content')} THEN ${S.content}
        ${termsClause("lower(m.title || ' ' || m.content)", terms, 'lower(m.title)')}
        ELSE 0 END` : '1'
    const sql = `
      WITH base AS MATERIALIZED (
        SELECT m.id, m.title, m.scope, m.scope_id, m.category, m.pinned, m.updated_at, ${scoreSql} AS score
        FROM memories m WHERE ${where.join(' AND ')}
      ),
      top AS MATERIALIZED (
        SELECT *, COUNT(*) OVER () AS total FROM base WHERE score > 0
        ORDER BY score DESC, ${q ? '' : 'pinned DESC,'} updated_at DESC LIMIT $limit
      )
      SELECT top.*, CASE top.score WHEN ${S.content} THEN ${WINDOW('m.content')}
                                   WHEN ${S.terms} THEN ${WINDOW('m.content', '$t0')}
                                   ELSE NULL END AS snippet_src
      FROM top JOIN memories m ON m.id = top.id
      ORDER BY top.score DESC, ${q ? '' : 'top.pinned DESC,'} top.updated_at DESC`
    const rows = prep(sql).all({ ...id, q, limit, mscope: memoryScope || '', ...termParams(terms) })
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map(r => {
        const field = q ? fieldOf('memories', r.score) : ''
        return {
          type: 'memory', id: r.id, title: r.title,
          snippet: q ? makeSnippet(r.snippet_src || r.title, field === 'terms' ? terms[0] : q) : '',
          matchedField: field, score: q ? r.score : 0,
          projectId: r.scope === 'project' ? r.scope_id || '' : '', topicId: '',
          memoryScope: r.scope, category: r.category, updatedAt: r.updated_at,
        }
      }),
    }
  }

  const RUNNERS = { todos: searchTodos, topics: searchTopics, projects: searchProjects, memories: searchMemories }

  /**
   * search-workspace. `query` '' (never typed) → recent items of each group; whitespace-only (nothing
   * searchable left) → no results; otherwise ranked hits. Never throws on special characters.
   */
  function search(userId, profile, input = {}) {
    const started = Date.now()
    const rawQuery = String(input.query ?? '')
    const scope = SEARCH_SCOPES.includes(input.scope) ? input.scope : 'all'
    const normalized = normalizeSearchQuery(rawQuery)
    const truncated = rawQuery.replace(/\s+/g, ' ').trim().length > MAX_SEARCH_QUERY_CHARS
    const recent = rawQuery === ''
    const groups = scope === 'all' ? GROUP_ORDER : [scope]
    const perGroup = clampLimit(input.limit, SEARCH_DEFAULT_GROUP_LIMIT)
    const totalCap = scope === 'all' ? Math.max(perGroup, Math.min(SEARCH_MAX_LIMIT, SEARCH_DEFAULT_TOTAL_LIMIT)) : perGroup
    const out = { query: normalized, scope, recent, truncated, groups: [], total: 0, hasMore: false, tookMs: 0 }
    if (!recent && !normalized) {
      out.groups = groups.map(type => ({ type, items: [], total: 0, hasMore: false }))
      return out
    }
    const q = foldCase(normalized)
    const hashNum = normalized.startsWith('#') ? parseNumberQuery(normalized) : null
    const ctx = {
      terms: searchTerms(normalized),
      num: hashNum === null ? parseNumberQuery(normalized) : null,
      hashNum,
      projectId: String(input.projectId || ''),
      topicId: String(input.topicId || ''),
      memoryScope: String(input.memoryScope || ''),
    }
    let remaining = totalCap
    for (const type of groups) {
      const limit = Math.max(0, Math.min(perGroup, remaining))
      if (limit === 0) {
        // Still report the total so the UI can say “more”.
        const probe = RUNNERS[type]({ uid: userId, profile }, recent ? '' : q, { ...ctx, limit: 1 })
        out.groups.push({ type, items: [], total: probe.total, hasMore: probe.total > 0 })
        out.total += probe.total
        if (probe.total > 0) out.hasMore = true
        continue
      }
      const res = RUNNERS[type]({ uid: userId, profile }, recent ? '' : q, { ...ctx, limit })
      remaining -= res.items.length
      const hasMore = res.total > res.items.length
      out.groups.push({ type, items: res.items, total: res.total, hasMore })
      out.total += res.total
      if (hasMore) out.hasMore = true
    }
    out.tookMs = Date.now() - started
    return out
  }

  return { search }
}

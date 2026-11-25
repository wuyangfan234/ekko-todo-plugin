// v0.9.14 — token usage per Ekko ToDo session, read from the Hermes engine's own session ledger.
//
// Why: the plugin used to wait for `chat.usage.updated` on the host event bus, but the host never publishes
// usage there (only on the per-session /chat-run stream), so the plugin ledger stayed empty and the page showed
// 0 tokens. Studio's session API only returns the last model call of a session, not its total. The Hermes engine
// keeps exact cumulative totals per session in `state.db` (the same place it already reads config.yaml/.env from),
// so read those read-only for the sessions the plugin created (chief, build, review).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

export function hermesStateDbPath(profile = 'default', home = homedir()) {
  const p = String(profile || 'default')
  if (p !== 'default' && /^[A-Za-z0-9._-]+$/.test(p)) {
    const scoped = join(home, '.hermes', 'profiles', p, 'state.db')
    if (existsSync(scoped)) return scoped
  }
  return join(home, '.hermes', 'state.db')
}

const toMs = v => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

/**
 * Returns Map<sessionId, usage> for the given session ids. Missing database / table / rows → empty map
 * (never throws, never invents numbers). Each usage carries cumulative totals and the last activity time.
 */
export function readHermesSessionUsage(sessionIds = [], { profile = 'default', dbPath = '' } = {}) {
  const ids = [...new Set((sessionIds || []).map(s => String(s || '').trim()).filter(Boolean))]
  const out = new Map()
  if (!ids.length) return out
  const file = dbPath || hermesStateDbPath(profile)
  if (!existsSync(file)) return out
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')
    const cols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name))
    if (!cols.has('id') || !cols.has('input_tokens')) return out
    const pick = (name, fallback = '0') => (cols.has(name) ? name : `${fallback} AS ${name}`)
    const select = [
      'id',
      pick('model', "''"),
      'input_tokens',
      pick('output_tokens'),
      pick('cache_read_tokens'),
      pick('cache_write_tokens'),
      pick('reasoning_tokens'),
      pick('api_call_count'),
      pick('estimated_cost_usd'),
      pick('actual_cost_usd', 'NULL'),
      pick('started_at'),
      pick('ended_at', 'NULL'),
      pick('last_activity_at', 'NULL'),
    ].join(', ')
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400)
      const rows = db.prepare(`SELECT ${select} FROM sessions WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)
      for (const r of rows) {
        const startedAt = toMs(r.started_at)
        const lastAt = toMs(r.last_activity_at) || toMs(r.ended_at) || startedAt
        const actual = r.actual_cost_usd === null || r.actual_cost_usd === undefined ? NaN : Number(r.actual_cost_usd)
        out.set(String(r.id), {
          sessionId: String(r.id),
          model: String(r.model || ''),
          inputTokens: Number(r.input_tokens) || 0,
          outputTokens: Number(r.output_tokens) || 0,
          cacheReadTokens: Number(r.cache_read_tokens) || 0,
          cacheWriteTokens: Number(r.cache_write_tokens) || 0,
          reasoningTokens: Number(r.reasoning_tokens) || 0,
          requests: Number(r.api_call_count) || 0,
          costUsd: Number.isFinite(actual) && actual > 0 ? actual : (Number(r.estimated_cost_usd) || 0),
          startedAt,
          lastActivityAt: lastAt,
        })
      }
    }
  } catch {
    // Locked / incompatible database: report nothing rather than a wrong number.
  } finally {
    try { db?.close() } catch {}
  }
  return out
}

/** Collects every host session the plugin created, with its role. */
export function collectPluginSessions(topics = [], todos = []) {
  const list = []
  const seen = new Set()
  const add = (id, role, label) => {
    const sid = String(id || '').trim()
    if (!sid || seen.has(sid)) return
    seen.add(sid)
    list.push({ sessionId: sid, role, label })
  }
  for (const t of topics) add(t.chiefSessionId, 'chief', t.title || '')
  for (const td of todos) {
    add(td.buildSessionId, 'build', `#${td.number} ${td.title || ''}`.trim())
    add(td.reviewSessionId, 'review', `#${td.number} ${td.title || ''}`.trim())
    for (const extra of Array.isArray(td.sessionIds) ? td.sessionIds : []) add(extra, 'build', `#${td.number}`)
  }
  return list
}

/** Turns session totals into ledger records understood by readLocalTokenUsageSummary. */
export function sessionUsageToRecords(sessions, usageMap) {
  const records = []
  for (const s of sessions) {
    const u = usageMap.get(s.sessionId)
    if (!u) continue
    const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens
    if (total === 0 && !u.requests) continue
    records.push({
      session_id: s.sessionId,
      role: s.role,
      model: u.model,
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      cache_read_tokens: u.cacheReadTokens,
      cache_write_tokens: u.cacheWriteTokens,
      reasoning_tokens: u.reasoningTokens,
      cost_usd: u.costUsd,
      requests: u.requests,
      created_at: u.lastActivityAt,
    })
  }
  return records
}

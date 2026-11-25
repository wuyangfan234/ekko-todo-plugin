import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { readHermesSessionUsage, collectPluginSessions, sessionUsageToRecords } from '../src/server/session-usage.mjs'
import { readLocalTokenUsageSummary } from '../src/server/quota-engine.mjs'

function fakeStateDb(dir) {
  const file = join(dir, 'state.db')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, started_at REAL, ended_at REAL, last_activity_at REAL,
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
    api_call_count INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL)`)
  const now = Date.now() / 1000
  const ins = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  ins.run('s-chief', 'deepseek-v4', now - 3600, null, now - 60, 1000, 200, 5000, 0, 50, 4, 0, null)
  ins.run('s-build', 'gemini-4', now - 7200, now - 7000, now - 7000, 3000, 800, 9000, 0, 10, 6, 0.12, null)
  ins.run('s-old', 'qwen4', now - 40 * 86400, null, now - 40 * 86400, 500, 100, 0, 0, 0, 2, 0, null)
  ins.run('s-other', 'x', now, null, now, 99999, 99999, 0, 0, 0, 1, 0, null)
  db.close()
  return file
}

test('v0.9.14: token totals come from the Hermes session ledger for plugin sessions only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-usage-'))
  try {
    const dbPath = fakeStateDb(dir)
    const sessions = collectPluginSessions(
      [{ chiefSessionId: 's-chief', title: 'T' }, { chiefSessionId: '' }],
      [{ number: 1, title: 'a', buildSessionId: 's-build', reviewSessionId: 's-missing' }, { number: 2, buildSessionId: 's-old' }],
    )
    assert.deepEqual(sessions.map(s => s.sessionId), ['s-chief', 's-build', 's-missing', 's-old'])
    const usage = readHermesSessionUsage(sessions.map(s => s.sessionId), { dbPath })
    assert.equal(usage.size, 3, 'unknown session is skipped, unrelated session is not read')
    assert.ok(!usage.has('s-other'))
    const records = sessionUsageToRecords(sessions, usage)
    const week = readLocalTokenUsageSummary('7d', {}, records)
    assert.equal(week.totals.inputTokens, 4000)
    assert.equal(week.totals.outputTokens, 1000)
    assert.equal(week.totals.cacheReadTokens, 14000)
    assert.equal(week.totals.requests, 10, 'requests = model calls of the sessions')
    assert.equal(week.totals.costUsd, 0.12)
    assert.equal(week.hasTokenLedger, true)
    const all = readLocalTokenUsageSummary('all', {}, records)
    assert.equal(all.totals.inputTokens, 4500)
    assert.equal(all.byModel.length, 3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('v0.9.14: a missing or broken ledger yields no numbers instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-usage-'))
  try {
    assert.equal(readHermesSessionUsage(['a'], { dbPath: join(dir, 'nope.db') }).size, 0)
    const bad = join(dir, 'bad.db')
    const db = new DatabaseSync(bad); db.exec('CREATE TABLE other (x)'); db.close()
    assert.equal(readHermesSessionUsage(['a'], { dbPath: bad }).size, 0)
    assert.equal(readHermesSessionUsage([], { dbPath: bad }).size, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

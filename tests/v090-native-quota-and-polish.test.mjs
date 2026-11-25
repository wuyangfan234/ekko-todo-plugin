// Regression & verification tests for v0.9.0 (7-item polish, Magpie removal, native quota engine, theme & layout convergence)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import {
  DEFAULT_QUOTA_PROVIDERS,
  parseAntigravityQuotaSummary,
  parseGrokBillingPayload,
  parseCodexWhamUsagePayload,
  parseClaudeOAuthUsagePayload,
  computeCyclePaceSummary,
  readLocalTokenUsageSummary,
} from '../src/server/quota-engine.mjs'

test('v0.9.0: Magpie & external CodexBar are uninstalled and legacy DB entries auto-migrate cleanly', () => {
  assert.equal(DEFAULT_QUOTA_PROVIDERS.length, 7)
  assert.equal(DEFAULT_QUOTA_PROVIDERS.some(p => p.id === 'magpie' || p.providerType === 'magpie'), false)
  for (const p of DEFAULT_QUOTA_PROVIDERS) {
    assert.ok(['auto', 'direct', 'local'].includes(p.sourceMode), `unexpected sourceMode: ${p.sourceMode}`)
    assert.doesNotMatch(`${p.name} ${p.subtitle} ${p.credentialPlaceholder}`, /magpie|codexbar/i)
  }

  // Simulate a pre-v0.9.0 database containing legacy magpie row & codexbar snapshots
  const dataDir = mkdtempSync(join(tmpdir(), 'ekko-v090-mig-'))
  try {
    const dbPath = join(dataDir, 'ekko-todo.sqlite')
    const rawDb = new DatabaseSync(dbPath)
    rawDb.exec(`
      CREATE TABLE quota_providers (
        id TEXT NOT NULL, user_id INTEGER NOT NULL, profile TEXT NOT NULL,
        provider_type TEXT NOT NULL, name TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'subscription', accent TEXT NOT NULL DEFAULT 'blue',
        enabled INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 10, source_mode TEXT NOT NULL DEFAULT 'auto',
        endpoint TEXT NOT NULL DEFAULT '', secret_value TEXT NOT NULL DEFAULT '',
        credential_label TEXT NOT NULL DEFAULT '', credential_placeholder TEXT NOT NULL DEFAULT '',
        last_snapshot_json TEXT NOT NULL DEFAULT '{}', last_checked_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (id, user_id, profile)
      );
      INSERT INTO quota_providers VALUES
        ('kimi', 1, 'default', 'kimi', 'Kimi 订阅', 'old', 'plan', 'sky', 1, 1, 1, 'codexbar', '', '', 'Key', '留空走 CodexBar/Magpie', '{"status":"ok","source":"codexbar"}', 1700000000000, 1, 1),
        ('magpie', 1, 'default', 'magpie', 'Magpie 网关', 'old', 'gateway', 'rose', 1, 0, 8, 'magpie', 'http://127.0.0.1:3425/v1/magpie/quotas', '', 'Key', 'Magpie', '{"status":"ok","source":"magpie-cache"}', 1700000000000, 1, 1),
        ('custom-1', 1, 'default', 'magpie', '自建余额', 'custom', 'balance', 'blue', 1, 0, 20, 'direct', 'https://api.example.com/balance', 'sk-x', 'Key', 'Key', '{}', 0, 1, 1);
    `)
    rawDb.close()

    const db = createDatabase(dataDir)
    const list = db.listQuotaProviders(1, 'default')
    assert.equal(list.some(p => p.id === 'magpie'), false, 'built-in magpie row removed')
    const kimi = list.find(p => p.id === 'kimi')
    assert.equal(kimi.sourceMode, 'auto', 'legacy codexbar sourceMode migrated to auto')
    assert.equal(kimi.lastCheckedAt, 0, 'stale codexbar snapshot cleared for native refresh')
    assert.doesNotMatch(kimi.credentialPlaceholder, /codexbar|magpie/i)

    const custom = list.find(p => p.id === 'custom-1')
    assert.equal(custom?.providerType, 'custom', 'non-magpie custom provider preserved and migrated to custom')

    // Native usage_records persistence & aggregation (zero Magpie usage.jsonl)
    const now = Date.now()
    db.recordUsage(1, 'default', {
      sessionId: 'sess-1',
      model: 'deepseek-v4',
      inputTokens: 8000,
      outputTokens: 2000,
      cacheReadTokens: 2000,
      reasoningTokens: 500,
      costUsd: 0.02,
      createdAt: now,
    })
    const recs = db.listUsageRecords(1, 'default')
    assert.equal(recs.length, 1)
    const summary = readLocalTokenUsageSummary('7d', { totalTodos: 3, doneTodos: 2, activeTodos: 1, topicCount: 1 }, recs)
    assert.equal(summary.hasTokenLedger, true)
    assert.equal(summary.totals.totalTokens, 12000)
    assert.equal(summary.totals.cacheHitRate, 20)
    assert.deepEqual(summary.sources, ['Ekko ToDo 会话统计'])
    assert.equal(summary.byModel[0].model, 'deepseek-v4')

    db.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('v0.9.0: Native quota parsers decode Antigravity, Grok, Codex & Claude payloads accurately without external CLIs', () => {
  // 1) Antigravity RetrieveUserQuotaSummary + GetUserStatus
  const ag = parseAntigravityQuotaSummary(
    {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.558, resetTime: '2026-11-28T08:56:11Z' },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.924, resetTime: '2026-11-23T15:56:11Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-11-23T20:02:48Z' },
            ],
          },
        ],
      },
    },
    { userStatus: { email: 'alice@example.com', userTier: { name: 'Google AI Ultra' } } },
  )
  assert.equal(ag.empty, false)
  assert.equal(ag.plan, 'Google AI Ultra')
  assert.equal(ag.accountHint, 'al***@ex***.com')
  assert.equal(ag.windows[0].name, 'Gemini · 5 小时')
  assert.equal(ag.windows[0].remainingPct, 92.4)
  assert.equal(ag.windows[1].name, 'Gemini · 7 天')
  assert.equal(ag.windows[1].remainingPct, 55.8)
  assert.equal(ag.windows[2].name, 'Claude/GPT · 5 小时')

  // 2) Grok cli-chat-proxy unified weekly billing
  const grok = parseGrokBillingPayload(
    {
      config: {
        isUnifiedBillingUser: true,
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-20T18:34:58Z', end: '2026-11-27T18:34:58Z' },
      },
    },
    null,
    { email: 'bob@example.com', hasGrokCodeAccess: true },
  )
  assert.equal(grok.empty, false)
  assert.equal(grok.windows[0].name, '7 天窗口')
  assert.equal(grok.windows[0].remainingPct, 100)
  assert.equal(grok.accountHint, 'bo***@ex***.com')
  assert.equal(parseGrokBillingPayload({}, null, null).empty, true, 'empty Grok reply must never fake 0%')

  // 3) Codex wham usage
  const codex = parseCodexWhamUsagePayload({
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 86400 },
    },
  })
  assert.equal(codex.empty, false)
  assert.equal(codex.plan, 'pro')
  assert.equal(codex.windows[0].remainingPct, 75)
  assert.equal(codex.windows[1].remainingPct, 60)

  // 4) Claude OAuth usage
  const claude = parseClaudeOAuthUsagePayload({
    five_hour: { utilization: 0.3, resets_at: '2026-11-23T20:00:00Z' },
    seven_day: { utilization: 62, resets_at: '2026-11-28T00:00:00Z' },
  })
  assert.equal(claude.empty, false)
  assert.equal(claude.windows[0].remainingPct, 70)
  assert.equal(claude.windows[1].remainingPct, 38)

  // 5) Pace calculator
  const futureReset = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
  const pace = computeCyclePaceSummary(10, futureReset, 10080)
  assert.match(pace, /节奏结余/)
})

test('v0.9.0: Theme tokens, zero hardcoded CSS colors outside :root, no 1.2s polling, adaptive Kanban & Chinese-only UI', () => {
  const styles = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  const lines = styles.split('\n')
  const bodyIdx = lines.findIndex(l => l.trim().startsWith('body {'))
  assert.ok(bodyIdx > 50, 'token header present')
  const bodyCss = lines.slice(bodyIdx).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/.test(bodyCss), false, 'zero hardcoded colors outside :root')
  assert.equal(/font-size:\s*[0-9.]+px/.test(bodyCss), false, 'all font-sizes converged to CSS scale tokens')
  assert.match(styles, /--theme-card-bg/, 'consumes Studio host theme card vars')
  assert.match(styles, /--accent-primary/, 'consumes Studio host accent var')
  assert.match(styles, /\.ot-home-quota-strip/, 'home quota strip styles present')
  assert.match(styles, /min-height:\s*40px\s*!important/, 'mobile touch targets >= 40px')

  const appJsx = readFileSync(new URL('../src/client/App.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(appJsx, /setInterval\(syncScheme/, '1.2s theme polling removed')
  assert.match(appJsx, /HomeQuotaStrip/, 'home quota strip wired in App')

  const kanbanJsx = readFileSync(new URL('../src/client/components/KanbanBoard.jsx', import.meta.url), 'utf8')
  assert.match(kanbanJsx, /minmax\(216px, 1fr\)/, 'Kanban columns stretch fluidly without right whitespace')
  assert.match(kanbanJsx, /HomeQuotaStrip/, 'desktop home quota strip rendered in KanbanBoard')

  const clientIndex = readFileSync(new URL('../src/client/index.jsx', import.meta.url), 'utf8')
  assert.match(clientIndex, /root\.lang\s*=\s*'zh-CN'/, 'Chinese-only UI')

  const quotaHub = readFileSync(new URL('../src/client/components/QuotaHub.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(quotaHub, /magpie|codexbar/i, 'QuotaHub UI has zero Magpie/CodexBar references')
})

test('v0.9.0: saveAgentInput contract & db.upsertAgent align bounds so long MCP-created descriptions save cleanly in UI', async () => {
  const { validateModel } = await import('../sdk/harness/contracts.mjs')
  const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
  const longDesc = '天机主程职责说明：'.repeat(90) // 810 chars (> old 400 limit)
  const longPrompt = '系统规则：'.repeat(1600) // 8000 chars (> old 6000 limit)

  // Contract accepts rich description (up to 4000) and systemPrompt (up to 20000)
  validateModel(contract, 'saveAgentInput', {
    id: 'agent-7e8010e1',
    name: '天机主程',
    role: 'builder',
    roleLabel: '项目专属开发主程',
    description: longDesc,
    engine: 'hermes',
    mode: 'scoped',
    systemPrompt: longPrompt,
    maxTurns: 0,
  })

  // db.upsertAgent caps oversized MCP writes to the exact contract ceiling so UI save never gets locked out
  const dataDir = mkdtempSync(join(tmpdir(), 'ekko-agent-len-'))
  try {
    const db = createDatabase(dataDir)
    const saved = db.upsertAgent(1, 'default', {
      id: 'agent-long',
      name: '超长测试主程',
      role: 'builder',
      roleLabel: '职责'.repeat(60),
      description: '说'.repeat(5000),
      engine: 'hermes',
      systemPrompt: '规'.repeat(25000),
    })
    assert.equal(saved.roleLabel.length, 80)
    assert.equal(saved.description.length, 4000)
    assert.equal(saved.systemPrompt.length, 20000)
    validateModel(contract, 'saveAgentInput', {
      id: saved.id,
      name: saved.name,
      role: saved.role,
      roleLabel: saved.roleLabel,
      description: saved.description,
      engine: saved.engine,
      mode: saved.mode,
      systemPrompt: saved.systemPrompt,
      maxTurns: saved.maxTurns,
    })
    db.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

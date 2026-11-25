/**
 * Native Multi-Provider Quota, Balance & Activity Usage Engine for Ekko ToDo.
 *
 * 100% self-contained inside Ekko ToDo — zero dependency on external CodexBar CLI or Magpie:
 * - Zero hardcoded personal paths, credentials, or accounts.
 * - Native official vendor API probes (Kimi Code, Grok CLI/Web, DeepSeek, Antigravity local app/OAuth,
 *   ChatGPT/Codex OAuth, Claude OAuth, OpenRouter, and generic custom balance APIs).
 * - Independent per-provider detection (`probeSingleQuotaProvider`), never fakes 0% on empty/error replies.
 * - Strictly redacts API keys/tokens/emails before returning data to UI.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const DEFAULT_QUOTA_PROVIDERS = Object.freeze([
  {
    id: 'kimi',
    providerType: 'kimi',
    name: 'Kimi 订阅',
    subtitle: 'Kimi Code 套餐窗口与余额',
    kind: 'plan',
    enabled: true,
    pinned: true,
    sortOrder: 1,
    sourceMode: 'auto', // auto | direct | local
    endpoint: 'https://api.kimi.com/coding/v1/usages',
    accent: 'sky',
    credentialLabel: 'Kimi API Key',
    credentialPlaceholder: '留空自动检测本机凭据，或填入 sk-kimi-...',
  },
  {
    id: 'grok',
    providerType: 'grok',
    name: 'Grok 订阅',
    subtitle: 'Grok 周期配额与重置时间',
    kind: 'subscription',
    enabled: true,
    pinned: true,
    sortOrder: 2,
    sourceMode: 'auto',
    endpoint: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    accent: 'slate',
    credentialLabel: 'Grok Token / Cookie',
    credentialPlaceholder: '留空自动检测本机 Grok 登录态，或手动填入',
  },
  {
    id: 'deepseek',
    providerType: 'deepseek',
    name: 'DeepSeek 余额',
    subtitle: '开放平台实时账户余额',
    kind: 'balance',
    enabled: true,
    pinned: true,
    sortOrder: 3,
    sourceMode: 'auto',
    endpoint: 'https://api.deepseek.com/user/balance',
    accent: 'blue',
    credentialLabel: 'DeepSeek API Key',
    credentialPlaceholder: '留空检测本机环境变量，或填入 sk-...',
  },
  {
    id: 'antigravity',
    providerType: 'antigravity',
    name: '谷歌反重力',
    subtitle: 'Antigravity Gemini 与 Claude 配额',
    kind: 'subscription',
    enabled: true,
    pinned: true,
    sortOrder: 4,
    sourceMode: 'auto',
    endpoint: 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    accent: 'violet',
    credentialLabel: 'Google OAuth Token（可选）',
    credentialPlaceholder: '留空自动连接本机 Antigravity 客户端',
  },
  {
    id: 'codex',
    providerType: 'codex',
    name: 'ChatGPT / Codex 订阅',
    subtitle: 'Codex 5 小时与 7 天配额窗口',
    kind: 'subscription',
    enabled: false,
    pinned: false,
    sortOrder: 5,
    sourceMode: 'auto',
    endpoint: 'https://chatgpt.com/backend-api/wham/usage',
    accent: 'emerald',
    credentialLabel: 'Codex OAuth Token（可选）',
    credentialPlaceholder: '留空自动检测本机 ~/.codex/auth.json',
  },
  {
    id: 'claude',
    providerType: 'claude',
    name: 'Claude 订阅',
    subtitle: 'Claude Pro / Max 5 小时与每周额度',
    kind: 'subscription',
    enabled: false,
    pinned: false,
    sortOrder: 6,
    sourceMode: 'auto',
    endpoint: 'https://api.anthropic.com/api/oauth/usage',
    accent: 'amber',
    credentialLabel: 'Claude OAuth Token（可选）',
    credentialPlaceholder: '留空自动检测本机 Claude 登录态',
  },
  {
    id: 'openrouter',
    providerType: 'openrouter',
    name: 'OpenRouter 余额',
    subtitle: 'OpenRouter 充值额度与消费',
    kind: 'balance',
    enabled: false,
    pinned: false,
    sortOrder: 7,
    sourceMode: 'direct',
    endpoint: 'https://openrouter.ai/api/v1/credits',
    accent: 'indigo',
    credentialLabel: 'OpenRouter API Key',
    credentialPlaceholder: 'sk-or-v1-...',
  },
])

export function maskSecret(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.length <= 8) return `${s.slice(0, 2)}••••`
  return `${s.slice(0, 4)}••••${s.slice(-4)}`
}

export function maskAccountHint(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (s.includes('@')) {
    const [u, d] = s.split('@')
    const domainParts = String(d || '').split('.')
    const dHead = domainParts[0] ? `${domainParts[0].slice(0, 2)}***` : '***'
    const dTld = domainParts.length > 1 ? `.${domainParts[domainParts.length - 1]}` : ''
    return `${u.slice(0, 2)}***@${dHead}${dTld}`
  }
  if (s.length > 14) return `${s.slice(0, 4)}…${s.slice(-4)}`
  return s
}

function clampPct(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10))
}

function formatWindowNameZh(name, minutes) {
  const raw = String(name || '').trim()
  const lower = raw.toLowerCase()
  if (lower.includes('gemini') && (lower.includes('5') || minutes === 300)) return 'Gemini · 5 小时'
  if (lower.includes('gemini') && (lower.includes('week') || lower.includes('7') || minutes === 10080)) return 'Gemini · 7 天'
  if ((lower.includes('claude') || lower.includes('3p') || lower.includes('gpt')) && (lower.includes('5') || minutes === 300)) return 'Claude/GPT · 5 小时'
  if ((lower.includes('claude') || lower.includes('3p') || lower.includes('gpt')) && (lower.includes('week') || lower.includes('7') || minutes === 10080)) return 'Claude/GPT · 7 天'
  if (lower === '5 hours' || lower === '5h' || lower === 'five_hour' || minutes === 300) return '5 小时窗口'
  if (lower === '7 days' || lower === '7d' || lower === 'weekly' || lower === 'seven_day' || minutes === 10080) return '7 天窗口'
  if (lower === 'month' || lower === 'monthly' || lower === '30 days' || minutes === 43200) return '月度窗口'
  if (lower === 'daily' || lower === '24 hours' || minutes === 1440) return '24 小时窗口'
  return raw || (minutes ? `${Math.round(minutes / 60)} 小时窗口` : '配额窗口')
}

export function computeCyclePaceSummary(usedPct, resetsAtIso, windowMinutes) {
  if (!resetsAtIso || !windowMinutes || windowMinutes <= 0) return ''
  const resetMs = Date.parse(resetsAtIso)
  if (!Number.isFinite(resetMs)) return ''
  const totalMs = windowMinutes * 60 * 1000
  const remainingMs = resetMs - Date.now()
  if (remainingMs <= 0 || remainingMs > totalMs * 1.15) return ''
  const elapsedFraction = Math.max(0, Math.min(1, (totalMs - remainingMs) / totalMs))
  const expectedUsed = Math.round(elapsedFraction * 100)
  const delta = Math.round(Number(usedPct || 0) - expectedUsed)
  if (delta <= -8) return `节奏结余 ${Math.abs(delta)}% · 预计够用到重置`
  if (delta >= 12) return `消耗超前 ${delta}% · 注意周期余量`
  return `进度平稳 · 周期已过 ${expectedUsed}%`
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    return { ok: res.ok, status: res.status, data, text }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Strictly loopback-only (127.0.0.1) HTTPS JSON POST helper for local desktop language servers
 * that present a self-signed loopback certificate (e.g. Antigravity IDE language_server).
 */
function postLoopbackHttpsJson(port, path, headers, bodyObj, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj || {})
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: Number(port),
        path,
        method: 'POST',
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      res => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { raw += chunk })
        res.on('end', () => {
          let data = null
          try { data = raw ? JSON.parse(raw) : null } catch { data = null }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0, data, text: raw })
        })
      },
    )
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/* ---------- Native Local Credential Discovery (Zero External CLI Bridges) ---------- */

function readDotEnvKey(filePath, keyNames) {
  if (!existsSync(filePath)) return ''
  try {
    const raw = readFileSync(filePath, 'utf8')
    const want = new Set(keyNames)
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const k = trimmed.slice(0, eq).trim().replace(/^export\s+/, '')
      if (!want.has(k)) continue
      let v = trimmed.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (v) return v
    }
  } catch {
    // ignore unreadable env file
  }
  return ''
}

function readTomlKey(filePath, keyNames) {
  if (!existsSync(filePath)) return ''
  try {
    const raw = readFileSync(filePath, 'utf8')
    for (const key of keyNames) {
      const re = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm')
      const m = raw.match(re)
      if (m?.[1]?.trim()) return m[1].trim()
    }
  } catch {
    // ignore
  }
  return ''
}

function discoverKimiLocalSecret() {
  const fromEnv = String(process.env.KIMI_CODE_API_KEY || process.env.KIMI_API_KEY || '').trim()
  if (fromEnv) return { secret: fromEnv, sourceLabel: '本机环境变量直连' }

  const home = homedir()
  const kimiCred = join(home, '.kimi', 'credentials', 'kimi-code.json')
  if (existsSync(kimiCred)) {
    try {
      const j = JSON.parse(readFileSync(kimiCred, 'utf8'))
      const tok = String(j?.access_token || j?.token || j?.api_key || '').trim()
      if (tok) return { secret: tok, sourceLabel: '本机 Kimi CLI 凭据直连' }
    } catch {}
  }

  for (const cfg of [join(home, '.kimi', 'config.toml'), join(home, '.config', 'kimi', 'config.toml')]) {
    const k = readTomlKey(cfg, ['api_key', 'kimi_api_key', 'KIMI_CODE_API_KEY'])
    if (k) return { secret: k, sourceLabel: '本机 Kimi 配置直连' }
  }

  const fromHermes = readDotEnvKey(join(home, '.hermes', '.env'), ['KIMI_CODE_API_KEY', 'KIMI_API_KEY'])
  if (fromHermes) return { secret: fromHermes, sourceLabel: '本机密钥直连' }

  return null
}

function discoverDeepSeekLocalSecret() {
  const fromEnv = String(process.env.DEEPSEEK_API_KEY || '').trim()
  if (fromEnv) return { secret: fromEnv, sourceLabel: '本机环境变量直连' }
  const fromHermes = readDotEnvKey(join(homedir(), '.hermes', '.env'), ['DEEPSEEK_API_KEY'])
  if (fromHermes) return { secret: fromHermes, sourceLabel: '本机密钥直连' }
  return null
}

function discoverOpenRouterLocalSecret() {
  const fromEnv = String(process.env.OPENROUTER_API_KEY || '').trim()
  if (fromEnv) return { secret: fromEnv, sourceLabel: '本机环境变量直连' }
  const fromHermes = readDotEnvKey(join(homedir(), '.hermes', '.env'), ['OPENROUTER_API_KEY'])
  if (fromHermes) return { secret: fromHermes, sourceLabel: '本机密钥直连' }
  return null
}

function discoverGrokLocalAuth() {
  const authPath = join(homedir(), '.grok', 'auth.json')
  if (!existsSync(authPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const entries = Object.values(parsed).filter(v => v && typeof v === 'object' && v.key)
    if (entries.length === 0) return null
    entries.sort((a, b) => Date.parse(b.expires_at || b.create_time || 0) - Date.parse(a.expires_at || a.create_time || 0))
    const pick = entries[0]
    const expiresMs = Date.parse(pick.expires_at || '')
    const expired = Number.isFinite(expiresMs) && expiresMs > 0 && expiresMs < Date.now()
    return {
      key: String(pick.key || '').trim(),
      email: String(pick.email || '').trim(),
      expiresAt: String(pick.expires_at || ''),
      expired,
    }
  } catch {
    return null
  }
}

function discoverCodexLocalAuth() {
  const authPath = join(homedir(), '.codex', 'auth.json')
  if (!existsSync(authPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf8'))
    const tokens = parsed?.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : null
    const accessToken = String(tokens?.access_token || parsed?.access_token || '').trim()
    const accountId = String(tokens?.account_id || parsed?.account_id || '').trim()
    if (accessToken) return { accessToken, accountId, apiKeyOnly: false }
    if (parsed?.OPENAI_API_KEY) return { accessToken: '', accountId: '', apiKeyOnly: true }
  } catch {}
  return null
}

async function discoverClaudeLocalAuth() {
  const home = homedir()
  const credPath = join(home, '.claude', '.credentials.json')
  if (existsSync(credPath)) {
    try {
      const parsed = JSON.parse(readFileSync(credPath, 'utf8'))
      const oauth = parsed?.claudeAiOauth || parsed
      const token = String(oauth?.accessToken || oauth?.access_token || '').trim()
      if (token) {
        return {
          token,
          plan: String(oauth?.subscriptionType || '').trim(),
          sourceLabel: '本机 Claude 凭据直连',
        }
      }
    } catch {}
  }

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 2000, maxBuffer: 256 * 1024 },
      )
      const parsed = JSON.parse(String(stdout || '{}').trim())
      const oauth = parsed?.claudeAiOauth || parsed
      const token = String(oauth?.accessToken || oauth?.access_token || '').trim()
      if (token) {
        return {
          token,
          plan: String(oauth?.subscriptionType || '').trim(),
          sourceLabel: '本机钥匙串直连',
        }
      }
    } catch {
      // keychain item not present or locked
    }
  }
  return null
}

function discoverGeminiLocalOAuth() {
  const credPath = join(homedir(), '.gemini', 'oauth_creds.json')
  if (!existsSync(credPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(credPath, 'utf8'))
    const token = String(parsed?.access_token || '').trim()
    const expiry = Number(parsed?.expiry_date || 0)
    if (!token) return null
    if (expiry > 0 && expiry < Date.now() - 30_000) return { token: '', expired: true }
    return { token, expired: false }
  } catch {
    return null
  }
}

/* ---------- Pure Parsers (Exported & Unit-Tested) ---------- */

export function parseKimiUsagePayload(payload) {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
    return { windows: [], plan: '', empty: true }
  }
  const windows = []
  const byKey = new Map()

  if (payload.usage && typeof payload.usage === 'object') {
    const lim = Number(payload.usage.limit)
    const usedRaw = payload.usage.used !== undefined
      ? Number(payload.usage.used)
      : (payload.usage.remaining !== undefined ? lim - Number(payload.usage.remaining) : NaN)
    if (Number.isFinite(lim) && lim > 0 && Number.isFinite(usedRaw)) {
      const usedPct = clampPct((usedRaw / lim) * 100)
      byKey.set('7d', {
        id: 'kimi-7d',
        name: '7 天窗口',
        usedPct,
        remainingPct: clampPct(100 - usedPct),
        resetsAt: payload.usage.resetTime || payload.usage.reset_time || '',
        windowMinutes: 10080,
        display: `${Math.max(0, Math.round(usedRaw))} / ${Math.round(lim)}`,
      })
    }
  }
  if (Array.isArray(payload.limits)) {
    for (const item of payload.limits) {
      const d = item?.detail || {}
      const lim = Number(d.limit)
      const usedRaw = d.used !== undefined
        ? Number(d.used)
        : (d.remaining !== undefined ? lim - Number(d.remaining) : NaN)
      if (!Number.isFinite(lim) || lim <= 0 || !Number.isFinite(usedRaw)) continue
      const dur = Number(item?.window?.duration || 0)
      const unit = String(item?.window?.timeUnit || '')
      const mins = unit.includes('HOUR') ? dur * 60 : dur
      const key = mins === 300 ? '5h' : `w-${mins || windows.length}`
      const usedPct = clampPct((usedRaw / lim) * 100)
      byKey.set(key, {
        id: `kimi-${key}`,
        name: formatWindowNameZh('', mins),
        usedPct,
        remainingPct: clampPct(100 - usedPct),
        resetsAt: d.resetTime || d.reset_time || '',
        windowMinutes: mins || 300,
        display: `${Math.max(0, Math.round(usedRaw))} / ${Math.round(lim)}`,
      })
    }
  }

  const uObj = payload.usages && typeof payload.usages === 'object' ? payload.usages : null
  if (uObj) {
    const specs = [
      ['limit_5h', '5h', '5 小时窗口', 300],
      ['limit_7d', '7d', '7 天窗口', 10080],
      ['limit_month_total', 'month', '月度总额', 43200],
    ]
    for (const [field, key, label, mins] of specs) {
      const w = uObj[field]
      if (!w || typeof w !== 'object') continue
      const ratio = Number(w.used_ratio)
      if (!Number.isFinite(ratio)) continue
      const usedPct = clampPct(ratio <= 1 ? ratio * 100 : ratio)
      if (byKey.has(key) && usedPct === 0 && byKey.get(key).usedPct > 0) continue
      byKey.set(key, {
        id: `kimi-${key}`,
        name: label,
        usedPct,
        remainingPct: clampPct(100 - usedPct),
        resetsAt: w.reset_time || w.resetTime || '',
        windowMinutes: mins,
        display: `${usedPct}% 已用`,
      })
    }
  }

  for (const k of ['5h', '7d', 'month']) {
    if (byKey.has(k)) windows.push(byKey.get(k))
  }
  for (const [k, v] of byKey.entries()) {
    if (!['5h', '7d', 'month'].includes(k)) windows.push(v)
  }

  const level = payload.user?.membership?.level || payload.plan || ''
  return { windows, plan: String(level || '').replace(/^LEVEL_/i, ''), empty: windows.length === 0 }
}

export function parseAntigravityQuotaSummary(summaryPayload, userStatusPayload = null) {
  const groups = Array.isArray(summaryPayload?.response?.groups)
    ? summaryPayload.response.groups
    : (Array.isArray(summaryPayload?.groups) ? summaryPayload.groups : [])

  const windows = []
  for (const g of groups) {
    const gName = String(g?.displayName || '').trim()
    const buckets = Array.isArray(g?.buckets) ? g.buckets : []
    const sorted = [...buckets].sort((a, b) => {
      const wa = String(a?.window || a?.bucketId || '').includes('5h') ? 0 : 1
      const wb = String(b?.window || b?.bucketId || '').includes('5h') ? 0 : 1
      return wa - wb
    })
    for (const b of sorted) {
      if (b?.remainingFraction === undefined || b?.remainingFraction === null) continue
      const remPct = clampPct(Number(b.remainingFraction) * 100)
      const usedPct = clampPct(100 - remPct)
      const key = `${gName} ${b.bucketId || b.window || ''}`
      const mins = String(b.window || b.bucketId || '').includes('5h')
        ? 300
        : String(b.window || b.bucketId || '').includes('week') ? 10080 : 0
      windows.push({
        id: String(b.bucketId || `ag-${windows.length}`),
        name: formatWindowNameZh(key, mins),
        usedPct,
        remainingPct: remPct,
        resetsAt: String(b.resetTime || ''),
        windowMinutes: mins,
        display: `${remPct}% 剩余`,
      })
    }
  }

  const us = userStatusPayload?.userStatus || userStatusPayload || {}
  if (windows.length === 0 && Array.isArray(us?.cascadeModelConfigData?.clientModelConfigs)) {
    const seen = new Set()
    for (const cfg of us.cascadeModelConfigData.clientModelConfigs) {
      const qi = cfg?.quotaInfo
      if (!qi || qi.remainingFraction === undefined) continue
      const lbl = String(cfg.label || cfg.modelId || '').trim()
      if (!lbl || seen.has(lbl)) continue
      seen.add(lbl)
      const remPct = clampPct(Number(qi.remainingFraction) * 100)
      windows.push({
        id: String(cfg.modelId || `ag-m-${windows.length}`),
        name: lbl,
        usedPct: clampPct(100 - remPct),
        remainingPct: remPct,
        resetsAt: String(qi.resetTime || ''),
        display: `${remPct}% 剩余`,
      })
      if (windows.length >= 4) break
    }
  }

  const plan = String(
    us?.userTier?.name || us?.planStatus?.planInfo?.planName || '',
  ).trim()
  const email = String(us?.email || '').trim()

  return {
    windows,
    plan,
    accountHint: maskAccountHint(email),
    empty: windows.length === 0,
  }
}

export function parseGrokBillingPayload(creditsPayload, legacyBillingPayload = null, userPayload = null) {
  const cfg = creditsPayload?.config || creditsPayload || {}
  const period = cfg?.currentPeriod && typeof cfg.currentPeriod === 'object' ? cfg.currentPeriod : null
  const legacyCfg = legacyBillingPayload?.config || {}

  const resetsAt = String(
    period?.end || cfg?.billingPeriodEnd || legacyCfg?.billingPeriodEnd || '',
  ).trim()

  const pType = String(period?.type || '').toUpperCase()
  const windowMinutes = pType.includes('WEEK')
    ? 10080
    : pType.includes('DAY')
      ? 1440
      : pType.includes('MONTH')
        ? 43200
        : (period ? 10080 : 0)

  const readVal = v => (v && typeof v === 'object' && v.val !== undefined ? Number(v.val) : Number(v))

  const finitePct = v => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? clampPct(v) : null)

  let usedPct = null
  let display = ''
  let usageReported = true
  if (finitePct(period?.usedPercent) !== null) {
    usedPct = finitePct(period.usedPercent)
  } else if (finitePct(cfg?.creditUsagePercent) !== null) {
    // Live credits reply (verified 2026-11-25): the weekly total lives in config.creditUsagePercent.
    usedPct = finitePct(cfg.creditUsagePercent)
  } else if (finitePct(cfg?.usedPercent) !== null) {
    usedPct = finitePct(cfg.usedPercent)
  } else if (period?.usedRatio !== undefined && Number.isFinite(Number(period.usedRatio))) {
    const r = Number(period.usedRatio)
    usedPct = clampPct(r <= 1 ? r * 100 : r)
  } else {
    const used = readVal(period?.used ?? period?.includedUsed ?? cfg?.used ?? legacyCfg?.used)
    const limit = readVal(period?.limit ?? period?.includedLimit ?? cfg?.limit ?? legacyCfg?.monthlyLimit)
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      usedPct = clampPct((used / limit) * 100)
      display = `${used} / ${limit}`
    } else if (cfg?.isUnifiedBillingUser === true && period?.start && period?.end) {
      // The vendor confirms the period but gives no usage number. Keep the window so the
      // reset time stays visible, but flag it: 0 here is "not reported", not "0% used".
      usedPct = 0
      usageReported = false
      display = '官方未返回已用量'
    }
  }

  const windows = []
  const mainId = pType.includes('MONTH') ? 'grok-month' : 'grok-7d'
  const mainMinutes = windowMinutes || 10080
  const periodName = formatWindowNameZh(pType.includes('MONTH') ? 'monthly' : '7d', mainMinutes)
  if (usedPct !== null) {
    windows.push({
      id: mainId,
      name: periodName,
      usedPct,
      remainingPct: clampPct(100 - usedPct),
      resetsAt,
      windowMinutes: mainMinutes,
      display: display || `${clampPct(100 - usedPct)}% 剩余`,
      usageReported,
    })
  }

  // Per-product split of the same period (config.productUsage[].usagePercent).
  const products = Array.isArray(cfg?.productUsage) ? cfg.productUsage : []
  const seenProducts = new Set()
  for (const item of products) {
    const pct = finitePct(item?.usagePercent ?? item?.usedPercent)
    const product = String(item?.product || item?.name || '').trim().slice(0, 60)
    if (pct === null || !product || seenProducts.has(product)) continue
    seenProducts.add(product)
    windows.push({
      id: `${mainId}-${product}`,
      name: `${product} · ${periodName.replace(/窗口$/, '').trim()}`,
      usedPct: pct,
      remainingPct: clampPct(100 - pct),
      resetsAt,
      windowMinutes: mainMinutes,
      display: `${clampPct(100 - pct)}% 剩余`,
      usageReported: true,
    })
  }

  // Pay-as-you-go allowance on top of the subscription (amounts in US cents).
  const odCap = readVal(cfg?.onDemandCap)
  const odUsed = readVal(cfg?.onDemandUsed)
  if (Number.isFinite(odCap) && odCap > 0 && Number.isFinite(odUsed)) {
    const pct = clampPct((odUsed / odCap) * 100)
    windows.push({
      id: 'grok-on-demand',
      name: '按需额度',
      usedPct: pct,
      remainingPct: clampPct(100 - pct),
      resetsAt,
      windowMinutes: mainMinutes,
      display: `$${(odUsed / 100).toFixed(2)} / $${(odCap / 100).toFixed(2)}`,
      usageReported: true,
    })
  }

  const prepaid = readVal(cfg?.prepaidBalance)
  const balance = Number.isFinite(prepaid) && prepaid > 0 ? `$${(prepaid / 100).toFixed(2)}` : ''

  const note = windows.length === 0
    ? ''
    : usageReported
      ? '官方只返回这一个周期，不包含本地对话用量'
      : '官方只返回这一个周期，未给出已用量；不包含本地对话用量'

  const plan = String(
    userPayload?.teamName
      || cfg?.planName
      || (userPayload?.hasGrokCodeAccess ? 'Grok 订阅' : (cfg?.isUnifiedBillingUser ? 'Grok 订阅' : '')),
  ).trim()

  return {
    windows,
    plan,
    balance,
    note,
    accountHint: maskAccountHint(userPayload?.email || ''),
    empty: windows.length === 0 && !balance,
  }
}

export function parseCodexWhamUsagePayload(payload) {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
    return { windows: [], plan: '', balance: '', empty: true }
  }
  const rl = payload.rate_limit || payload.rateLimit || {}
  const windows = []
  const addWin = (w, fallbackId, fallbackMins) => {
    if (!w || typeof w !== 'object') return
    const rawPct = w.used_percent ?? w.usedPercent
    if (rawPct === undefined || rawPct === null || !Number.isFinite(Number(rawPct))) return
    const usedPct = clampPct(rawPct)
    const mins = Number(w.limit_window_seconds || 0) > 0
      ? Math.round(Number(w.limit_window_seconds) / 60)
      : fallbackMins
    let resetsAt = ''
    if (w.reset_at) {
      const n = Number(w.reset_at)
      resetsAt = Number.isFinite(n) && n > 0
        ? new Date(n < 1e12 ? n * 1000 : n).toISOString()
        : String(w.reset_at)
    } else if (Number(w.reset_after_seconds || 0) > 0) {
      resetsAt = new Date(Date.now() + Number(w.reset_after_seconds) * 1000).toISOString()
    }
    windows.push({
      id: fallbackId,
      name: formatWindowNameZh('', mins),
      usedPct,
      remainingPct: clampPct(100 - usedPct),
      resetsAt,
      windowMinutes: mins,
      display: `${clampPct(100 - usedPct)}% 剩余`,
    })
  }
  addWin(rl.primary_window || rl.primaryWindow, 'codex-5h', 300)
  addWin(rl.secondary_window || rl.secondaryWindow, 'codex-7d', 10080)

  let balance = ''
  const credits = payload.credits
  if (credits && credits.has_credits && credits.balance !== undefined && credits.balance !== null) {
    balance = `$${Number(credits.balance).toFixed(2)}`
  }
  return {
    windows,
    plan: String(payload.plan_type || payload.planType || '').trim(),
    balance,
    empty: windows.length === 0 && !balance,
  }
}

export function parseClaudeOAuthUsagePayload(payload) {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
    return { windows: [], empty: true }
  }
  const windows = []
  const specs = [
    ['five_hour', 'claude-5h', '5 小时窗口', 300],
    ['seven_day', 'claude-7d', '7 天窗口', 10080],
    ['seven_day_sonnet', 'claude-sonnet-7d', 'Sonnet · 7 天', 10080],
  ]
  for (const [key, id, label, mins] of specs) {
    const w = payload[key]
    if (!w || typeof w !== 'object' || w.utilization === undefined || w.utilization === null) continue
    const raw = Number(w.utilization)
    if (!Number.isFinite(raw)) continue
    const usedPct = clampPct(raw <= 1 && raw > 0 ? raw * 100 : raw)
    windows.push({
      id,
      name: label,
      usedPct,
      remainingPct: clampPct(100 - usedPct),
      resetsAt: String(w.resets_at || w.resetsAt || ''),
      windowMinutes: mins,
      display: `${clampPct(100 - usedPct)}% 剩余`,
    })
  }
  return { windows, empty: windows.length === 0 }
}

/* ---------- Native Provider Probes ---------- */

async function probeDeepSeekDirect(secret, endpoint = '', sourceLabel = 'DeepSeek 官方直连') {
  if (!secret) {
    return {
      status: 'unconfigured',
      source: 'direct',
      sourceLabel: 'DeepSeek 官方接口',
      windows: [],
      balance: '',
      error: '请配置 DeepSeek API Key，或设置 DEEPSEEK_API_KEY',
      checkedAt: Date.now(),
    }
  }
  const url = endpoint || 'https://api.deepseek.com/user/balance'
  try {
    const res = await fetchJsonWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      const msg = res.data?.error?.message || res.data?.message || `HTTP ${res.status}`
      return { status: 'error', source: 'direct', sourceLabel, windows: [], balance: '', error: `认证失败：${msg}`, checkedAt: Date.now() }
    }
    const infos = Array.isArray(res.data?.balance_infos) ? res.data.balance_infos : []
    if (infos.length === 0) {
      return { status: 'empty', source: 'direct', sourceLabel, windows: [], balance: '', error: '已认证，但未返回余额明细', checkedAt: Date.now() }
    }
    const primary = infos.find(b => b.currency === 'CNY') || infos[0]
    const sym = primary.currency === 'CNY' ? '¥' : primary.currency === 'USD' ? '$' : `${primary.currency} `
    const total = String(primary.total_balance ?? '0.00')
    const breakdown = infos.map(b => {
      const s = b.currency === 'CNY' ? '¥' : b.currency === 'USD' ? '$' : `${b.currency} `
      return `${s}${b.total_balance}（充值 ${s}${b.topped_up_balance || 0} + 赠金 ${s}${b.granted_balance || 0}）`
    }).join(' · ')
    return {
      status: 'ok',
      source: 'direct',
      sourceLabel,
      plan: res.data?.is_available ? '可用' : '余额不足',
      balance: `${sym}${total}`,
      balanceDetail: breakdown,
      windows: [],
      error: '',
      checkedAt: Date.now(),
    }
  } catch (err) {
    return { status: 'error', source: 'direct', sourceLabel, windows: [], balance: '', error: `请求失败：${err?.message || err}`, checkedAt: Date.now() }
  }
}

async function probeKimiDirect(secret, endpoint = '', sourceLabel = 'Kimi 官方直连') {
  if (!secret) {
    return {
      status: 'unconfigured',
      source: 'direct',
      sourceLabel: 'Kimi 官方接口',
      windows: [],
      balance: '',
      error: '未检测到本机 Kimi 凭据，请点击配置填入 Key',
      checkedAt: Date.now(),
    }
  }
  const url = endpoint || (secret.startsWith('sk-kimi-') ? 'https://api.kimi.com/coding/v1/usages' : 'https://api.moonshot.cn/v1/users/me/balance')
  try {
    const res = await fetchJsonWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: 'application/json',
        'User-Agent': 'kimi-cli/1.0',
      },
    })
    if (!res.ok) {
      const msg = res.data?.error?.message || res.data?.message || `HTTP ${res.status}`
      return { status: 'error', source: 'direct', sourceLabel, windows: [], balance: '', error: `认证失败：${msg}`, checkedAt: Date.now() }
    }
    if (url.includes('/balance')) {
      const avail = res.data?.data?.available_balance ?? res.data?.available_balance
      if (avail !== undefined && avail !== null) {
        return { status: 'ok', source: 'direct', sourceLabel: 'Moonshot 官方直连', plan: 'Open Platform', balance: `¥${Number(avail).toFixed(2)}`, windows: [], error: '', checkedAt: Date.now() }
      }
    }
    const parsed = parseKimiUsagePayload(res.data)
    if (parsed.empty) {
      return { status: 'empty', source: 'direct', sourceLabel, plan: parsed.plan, windows: [], balance: '', error: '已认证，但接口未返回额度窗口', checkedAt: Date.now() }
    }
    const wMain = parsed.windows.find(w => w.windowMinutes === 10080) || parsed.windows[0]
    const paceSummary = wMain ? computeCyclePaceSummary(wMain.usedPct, wMain.resetsAt, wMain.windowMinutes) : ''
    return {
      status: 'ok',
      source: 'direct',
      sourceLabel,
      plan: parsed.plan || 'Kimi Code',
      windows: parsed.windows,
      paceSummary,
      balance: '',
      error: '',
      checkedAt: Date.now(),
    }
  } catch (err) {
    return { status: 'error', source: 'direct', sourceLabel, windows: [], balance: '', error: `请求失败：${err?.message || err}`, checkedAt: Date.now() }
  }
}

async function probeAntigravityLocalApp() {
  try {
    const { stdout: psOut } = await execFileAsync('ps', ['-ax', '-o', 'pid,command'], { timeout: 2500, maxBuffer: 2 * 1024 * 1024 })
    let pid = ''
    let csrf = ''
    for (const line of String(psOut || '').split('\n')) {
      if (line.includes('language_server') && line.toLowerCase().includes('antigravity')) {
        const mp = line.match(/^\s*(\d+)\s+/)
        const mc = line.match(/--csrf_token[=\s]+([^\s]+)/)
        if (mp && mc) {
          pid = mp[1]
          csrf = mc[1]
          break
        }
      }
    }
    if (!pid || !csrf) return null

    let ports = []
    try {
      const { stdout: lsofOut } = await execFileAsync(
        'lsof',
        ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pid],
        { timeout: 2500, maxBuffer: 512 * 1024 },
      )
      ports = [...new Set([...String(lsofOut || '').matchAll(/:(\d+)\s+\(LISTEN\)/g)].map(m => m[1]))]
    } catch {
      return null
    }
    if (ports.length === 0) return null

    const headers = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'X-Codeium-Csrf-Token': csrf,
    }
    const reqBody = { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }

    const callRpc = async (port, rpcName) => {
      const path = `/exa.language_server_pb.LanguageServerService/${rpcName}`
      try {
        const res = await fetchJsonWithTimeout(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(reqBody),
        }, 2200)
        if (res.ok && res.data) return res.data
      } catch {}
      try {
        const res = await postLoopbackHttpsJson(port, path, headers, reqBody, 2200)
        if (res.ok && res.data) return res.data
      } catch {}
      return null
    }

    for (const port of ports) {
      const summary = await callRpc(port, 'RetrieveUserQuotaSummary')
      const status = await callRpc(port, 'GetUserStatus')
      if (!summary && !status) continue
      const parsed = parseAntigravityQuotaSummary(summary, status)
      if (!parsed.empty) {
        const wMain = parsed.windows.find(w => w.windowMinutes === 10080) || parsed.windows[0]
        return {
          status: 'ok',
          source: 'local',
          sourceLabel: '本机客户端直连',
          plan: parsed.plan || 'Antigravity',
          accountHint: parsed.accountHint,
          windows: parsed.windows,
          paceSummary: wMain ? computeCyclePaceSummary(wMain.usedPct, wMain.resetsAt, wMain.windowMinutes) : '',
          balance: '',
          error: '',
          checkedAt: Date.now(),
        }
      }
    }
  } catch {
    // Antigravity app not running
  }
  return null
}

async function probeAntigravityDirect(secret, endpoint = '', sourceLabel = 'Antigravity 官方直连') {
  if (!secret) {
    return {
      status: 'unconfigured',
      source: 'direct',
      sourceLabel: 'Antigravity 检测',
      windows: [],
      balance: '',
      error: '未检测到运行中的本机 Antigravity 客户端，也可手动填入 OAuth Token',
      checkedAt: Date.now(),
    }
  }
  const url = endpoint || 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
  try {
    const res = await fetchJsonWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity',
      },
      body: '{}',
    })
    if (!res.ok) {
      return { status: 'error', source: 'direct', sourceLabel, windows: [], balance: '', error: `HTTP ${res.status}: Token 无效或已过期`, checkedAt: Date.now() }
    }
    const models = res.data?.models && typeof res.data.models === 'object' ? Object.values(res.data.models) : []
    const windows = []
    for (const m of models) {
      const qi = m?.quotaInfo
      if (!qi || qi.remainingFraction === undefined) continue
      const remPct = clampPct(Number(qi.remainingFraction) * 100)
      windows.push({
        id: m.model || m.displayName || `ag-${windows.length}`,
        name: String(m.displayName || m.model || '模型配额'),
        usedPct: clampPct(100 - remPct),
        remainingPct: remPct,
        resetsAt: qi.resetTime || '',
        display: `${remPct}% 剩余`,
      })
    }
    if (windows.length === 0) {
      return { status: 'empty', source: 'direct', sourceLabel, windows: [], balance: '', error: '已连接，但未返回模型配额信息', checkedAt: Date.now() }
    }
    return { status: 'ok', source: 'direct', sourceLabel, plan: 'Cloud Code', windows: windows.slice(0, 6), balance: '', error: '', checkedAt: Date.now() }
  } catch (err) {
    return { status: 'error', source: 'direct', sourceLabel, windows: [], balance: '', error: `请求失败：${err?.message || err}`, checkedAt: Date.now() }
  }
}

async function probeGrokWithToken(secret, endpoint = '', { emailHint = '', sourceLabel = 'Grok 官方直连', source = 'direct' } = {}) {
  if (!secret) {
    return {
      status: 'unconfigured',
      source: 'direct',
      sourceLabel: 'Grok 检测',
      windows: [],
      balance: '',
      error: '未检测到本机 ~/.grok/auth.json 登录态，请先登录 grok CLI 或手动填入 Token',
      checkedAt: Date.now(),
    }
  }
  const isCookie = secret.includes('=') && !secret.startsWith('eyJ')
  if (!isCookie && (!endpoint || endpoint.includes('cli-chat-proxy.grok.com') || endpoint.includes('grok.com/rest/rate-limits'))) {
    const base = 'https://cli-chat-proxy.grok.com'
    const headers = {
      Authorization: `Bearer ${secret}`,
      Accept: 'application/json',
      'User-Agent': 'grok-cli/1.0',
    }
    try {
      const [creditsRes, legacyRes, userRes] = await Promise.all([
        fetchJsonWithTimeout(`${base}/v1/billing?format=credits`, { headers }, 8000),
        fetchJsonWithTimeout(`${base}/v1/billing`, { headers }, 8000).catch(() => ({ ok: false, data: null })),
        fetchJsonWithTimeout(`${base}/v1/user`, { headers }, 8000).catch(() => ({ ok: false, data: null })),
      ])
      if (!creditsRes.ok && !legacyRes.ok) {
        return {
          status: 'error',
          source,
          sourceLabel,
          windows: [],
          balance: '',
          error: `HTTP ${creditsRes.status}: 凭据无效或已过期`,
          checkedAt: Date.now(),
        }
      }
      const parsed = parseGrokBillingPayload(
        creditsRes.ok ? creditsRes.data : null,
        legacyRes.ok ? legacyRes.data : null,
        userRes.ok ? userRes.data : (emailHint ? { email: emailHint } : null),
      )
      if (parsed.empty) {
        return { status: 'empty', source, sourceLabel, windows: [], balance: '', error: '已认证，但未解析到额度字段', checkedAt: Date.now() }
      }
      const wMain = parsed.windows[0]
      return {
        status: 'ok',
        source,
        sourceLabel,
        plan: parsed.plan || 'Grok 订阅',
        accountHint: parsed.accountHint || maskAccountHint(emailHint),
        windows: parsed.windows,
        paceSummary: wMain && wMain.usageReported !== false ? computeCyclePaceSummary(wMain.usedPct, wMain.resetsAt, wMain.windowMinutes) : '',
        balance: parsed.balance,
        ...(parsed.note ? { note: parsed.note } : {}),
        error: '',
        checkedAt: Date.now(),
      }
    } catch (err) {
      return { status: 'error', source, sourceLabel, windows: [], balance: '', error: `请求失败：${err?.message || err}`, checkedAt: Date.now() }
    }
  }

  const url = endpoint || 'https://grok.com/rest/rate-limits'
  try {
    const res = await fetchJsonWithTimeout(url, {
      headers: {
        ...(isCookie ? { Cookie: secret } : { Authorization: `Bearer ${secret}` }),
        Accept: 'application/json',
        'User-Agent': 'grok-cli/1.0',
      },
    })
    if (!res.ok) {
      return { status: 'error', source, sourceLabel, windows: [], balance: '', error: `HTTP ${res.status}: 凭据无效或已过期`, checkedAt: Date.now() }
    }
    const rem = Number(res.data?.remainingQueries ?? res.data?.remaining)
    const tot = Number(res.data?.totalQueries ?? res.data?.total ?? res.data?.limit)
    if (Number.isFinite(rem) && Number.isFinite(tot) && tot > 0) {
      const remPct = clampPct((rem / tot) * 100)
      return {
        status: 'ok',
        source,
        sourceLabel,
        plan: String(res.data?.billingTier || 'SuperGrok'),
        windows: [{ id: 'grok-rate', name: '配额窗口', usedPct: clampPct(100 - remPct), remainingPct: remPct, resetsAt: res.data?.windowResetAt || '', display: `${rem} / ${tot}` }],
        balance: '',
        error: '',
        checkedAt: Date.now(),
      }
    }
    return { status: 'empty', source, sourceLabel, windows: [], balance: '', error: '已认证，但未解析到额度字段', checkedAt: Date.now() }
  } catch (err) {
    return { status: 'error', source, sourceLabel, windows: [], balance: '', error: `请求失败：${err?.message || err}`, checkedAt: Date.now() }
  }
}

async function probeCodexDirect(token, accountId = '', endpoint = '', sourceLabel = 'Codex 官方直连', source = 'direct') {
  if (!token) {
    return {
      status: 'unconfigured',
      source: 'direct',
      sourceLabel: 'Codex 检测',
      windows: [],
      balance: '',
      error: '请运行 codex login 登录，或手动填入 OAuth Token',
      checkedAt: Date.now(),
    }
  }
  const url = endpoint || 'https://chatgpt.com/backend-api/wham/usage'
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'codex-cli/1.0',
    }
    if (accountId) headers['ChatGPT-Account-Id'] = accountId
    const res = await fetchJsonWithTimeout(url, { headers })
    if (!res.ok) {
      return { status: 'error', source, sourceLabel, windows: [], balance: '', error: `HTTP ${res.status}: Codex 登录态已过期，请重新登录`, checkedAt: Date.now() }
    }
    const parsed = parseCodexWhamUsagePayload(res.data)
    if (parsed.empty) {
      return { status: 'empty', source, sourceLabel, windows: [], balance: '', error: '已连接，但未返回配额窗口', checkedAt: Date.now() }
    }
    const wMain = parsed.windows.find(w => w.windowMinutes === 10080) || parsed.windows[0]
    return {
      status: 'ok',
      source,
      sourceLabel,
      plan: parsed.plan || 'Codex',
      windows: parsed.windows,
      paceSummary: wMain ? computeCyclePaceSummary(wMain.usedPct, wMain.resetsAt, wMain.windowMinutes) : '',
      balance: parsed.balance,
      error: '',
      checkedAt: Date.now(),
    }
  } catch (err) {
    return { status: 'error', source, sourceLabel, windows: [], balance: '', error: `请求失败：${err?.message || err}`, checkedAt: Date.now() }
  }
}

async function probeClaudeDirect(token, endpoint = '', { plan = '', sourceLabel = 'Claude 官方直连', source = 'direct' } = {}) {
  if (!token) {
    return {
      status: 'unconfigured',
      source: 'direct',
      sourceLabel: 'Claude 检测',
      windows: [],
      balance: '',
      error: '未检测到本机 Claude 登录态，请先登录 Claude CLI 或填入 Token',
      checkedAt: Date.now(),
    }
  }
  const url = endpoint || 'https://api.anthropic.com/api/oauth/usage'
  try {
    const res = await fetchJsonWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    })
    if (!res.ok) {
      return { status: 'error', source, sourceLabel, windows: [], balance: '', error: `HTTP ${res.status}: 凭据无效或已过期`, checkedAt: Date.now() }
    }
    const parsed = parseClaudeOAuthUsagePayload(res.data)
    if (parsed.empty) {
      return { status: 'empty', source, sourceLabel, windows: [], balance: '', error: '已连接，但未返回额度窗口', checkedAt: Date.now() }
    }
    const wMain = parsed.windows.find(w => w.windowMinutes === 10080) || parsed.windows[0]
    return {
      status: 'ok',
      source,
      sourceLabel,
      plan: plan || 'Claude',
      windows: parsed.windows,
      paceSummary: wMain ? computeCyclePaceSummary(wMain.usedPct, wMain.resetsAt, wMain.windowMinutes) : '',
      balance: '',
      error: '',
      checkedAt: Date.now(),
    }
  } catch (err) {
    return { status: 'error', source, sourceLabel, windows: [], balance: '', error: `请求失败：${err?.message || err}`, checkedAt: Date.now() }
  }
}

async function probeOpenRouterDirect(secret, endpoint = '', sourceLabel = 'OpenRouter 官方直连') {
  if (!secret) {
    return {
      status: 'unconfigured',
      source: 'direct',
      sourceLabel: 'OpenRouter 官方接口',
      windows: [],
      balance: '',
      error: '请填入 OpenRouter API Key',
      checkedAt: Date.now(),
    }
  }
  const url = endpoint || 'https://openrouter.ai/api/v1/credits'
  try {
    const res = await fetchJsonWithTimeout(url, {
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      return { status: 'error', source: 'direct', sourceLabel, windows: [], balance: '', error: `HTTP ${res.status}: ${res.data?.error?.message || '认证失败'}`, checkedAt: Date.now() }
    }
    const total = Number(res.data?.data?.total_credits ?? 0)
    const used = Number(res.data?.data?.total_usage ?? 0)
    const remaining = Math.max(0, total - used)
    const usedPct = total > 0 ? clampPct((used / total) * 100) : 0
    return {
      status: 'ok',
      source: 'direct',
      sourceLabel,
      plan: 'Credits',
      balance: `$${remaining.toFixed(2)}`,
      balanceDetail: `已用 $${used.toFixed(2)} / 总额 $${total.toFixed(2)}`,
      windows: total > 0 ? [{ id: 'or-credits', name: '充值额度', usedPct, remainingPct: clampPct(100 - usedPct), resetsAt: '', display: `$${remaining.toFixed(2)} 剩余` }] : [],
      error: '',
      checkedAt: Date.now(),
    }
  } catch (err) {
    return { status: 'error', source: 'direct', sourceLabel, windows: [], balance: '', error: `请求失败：${err?.message || err}`, checkedAt: Date.now() }
  }
}

async function probeCustomBalanceEndpoint(endpoint, secret) {
  const url = String(endpoint || '').trim()
  if (!url) {
    return { status: 'unconfigured', source: 'direct', sourceLabel: '自定义接口', windows: [], balance: '', error: '请填写接口地址', checkedAt: Date.now() }
  }
  try {
    const headers = { Accept: 'application/json' }
    if (secret) headers.Authorization = `Bearer ${secret}`
    const res = await fetchJsonWithTimeout(url, { headers })
    if (!res.ok) {
      return { status: 'error', source: 'direct', sourceLabel: '自定义接口', windows: [], balance: '', error: `HTTP ${res.status}`, checkedAt: Date.now() }
    }
    const d = res.data || {}
    const bal = d.balance ?? d.total_balance ?? d.hard_limit_usd ?? d.data?.quota ?? d.data?.balance ?? d.remaining
    return {
      status: bal !== undefined ? 'ok' : 'empty',
      source: 'direct',
      sourceLabel: '自定义接口',
      plan: String(d.plan || d.name || 'Custom API'),
      balance: bal !== undefined ? String(bal) : '',
      windows: [],
      error: bal !== undefined ? '' : '返回 200，但未检测到 balance/quota 字段',
      checkedAt: Date.now(),
    }
  } catch (err) {
    return { status: 'error', source: 'direct', sourceLabel: '自定义接口', windows: [], balance: '', error: `连接失败：${err?.message || err}`, checkedAt: Date.now() }
  }
}

/**
 * Independently probe a single quota provider natively inside Ekko ToDo:
 * - 'direct': use user-configured API Key / Token / Endpoint directly
 * - 'local': use native built-in local CLI credential / desktop client discovery
 * - 'auto': prefer user-configured secret when present, else native local discovery -> official API
 */
export async function probeSingleQuotaProvider(providerRecord) {
  const type = providerRecord.providerType || providerRecord.id
  const mode = ['auto', 'direct', 'local'].includes(providerRecord.sourceMode) ? providerRecord.sourceMode : 'auto'
  const secret = String(providerRecord.secretValue || '').trim()
  const endpoint = String(providerRecord.endpoint || '').trim()

  const runDirect = async () => {
    switch (type) {
      case 'deepseek': return probeDeepSeekDirect(secret, endpoint)
      case 'kimi': return probeKimiDirect(secret, endpoint)
      case 'grok': return probeGrokWithToken(secret, endpoint)
      case 'antigravity': return probeAntigravityDirect(secret, endpoint)
      case 'codex': return probeCodexDirect(secret, '', endpoint)
      case 'claude': return probeClaudeDirect(secret, endpoint)
      case 'openrouter': return probeOpenRouterDirect(secret, endpoint)
      default:
        return probeCustomBalanceEndpoint(endpoint, secret)
    }
  }

  const runLocal = async () => {
    switch (type) {
      case 'kimi': {
        const found = discoverKimiLocalSecret()
        if (!found) return null
        return probeKimiDirect(found.secret, endpoint, found.sourceLabel)
      }
      case 'deepseek': {
        const found = discoverDeepSeekLocalSecret()
        if (!found) return null
        return probeDeepSeekDirect(found.secret, endpoint, found.sourceLabel)
      }
      case 'openrouter': {
        const found = discoverOpenRouterLocalSecret()
        if (!found) return null
        return probeOpenRouterDirect(found.secret, endpoint, found.sourceLabel)
      }
      case 'grok': {
        const auth = discoverGrokLocalAuth()
        if (!auth) return null
        if (auth.expired) {
          return {
            status: 'error',
            source: 'local',
            sourceLabel: '本机 Grok 登录态',
            windows: [],
            balance: '',
            error: '本机 Grok 登录态已过期，请重新运行 grok 登录',
            checkedAt: Date.now(),
          }
        }
        return probeGrokWithToken(auth.key, endpoint, {
          emailHint: auth.email,
          source: 'local',
          sourceLabel: '本机 Grok 凭据直连',
        })
      }
      case 'antigravity': {
        const localApp = await probeAntigravityLocalApp()
        if (localApp) return localApp
        const gem = discoverGeminiLocalOAuth()
        if (gem && gem.token) {
          return probeAntigravityDirect(gem.token, endpoint, '本机 Gemini 凭据直连')
        }
        return null
      }
      case 'codex': {
        const auth = discoverCodexLocalAuth()
        if (!auth) return null
        if (auth.apiKeyOnly) {
          return {
            status: 'unconfigured',
            source: 'local',
            sourceLabel: '本机 Codex 检测',
            windows: [],
            balance: '',
            error: '本机 ~/.codex/auth.json 仅含 API Key；订阅窗口需执行 codex login',
            checkedAt: Date.now(),
          }
        }
        return probeCodexDirect(auth.accessToken, auth.accountId, endpoint, '本机 Codex 凭据直连', 'local')
      }
      case 'claude': {
        const auth = await discoverClaudeLocalAuth()
        if (!auth) return null
        return probeClaudeDirect(auth.token, endpoint, {
          plan: auth.plan,
          source: 'local',
          sourceLabel: auth.sourceLabel,
        })
      }
      default:
        return null
    }
  }

  if (mode === 'direct') return runDirect()
  if (mode === 'local') {
    const localRes = await runLocal()
    if (localRes) return localRes
    return {
      status: 'unconfigured',
      source: 'local',
      sourceLabel: '本机自动检测',
      windows: [],
      balance: '',
      error: `未检测到本机 ${providerRecord.name} 凭据或客户端，可手动填入密钥`,
      checkedAt: Date.now(),
    }
  }

  if (secret) {
    const directRes = await runDirect()
    if (directRes.status === 'ok') return directRes
    const localRes = await runLocal()
    if (localRes && localRes.status === 'ok') return localRes
    return directRes
  }

  const localRes = await runLocal()
  if (localRes) return localRes
  return runDirect()
}

/* ---------- Native Ekko ToDo Activity & Usage Aggregator ---------- */

const RANGE_MS = {
  today: 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: Number.MAX_SAFE_INTEGER,
}

/**
 * Parse ISO timestamps or epoch numbers (seconds or milliseconds).
 * Never feed a number into Date.parse (Date.parse(0) is 2000-01-01 in V8).
 */
export function parseUsageTimestamp(rec) {
  for (const key of ['t', 'at', 'ts', 'timestamp', 'time', 'created_at', 'createdAt', 'timestamp_ms']) {
    const v = rec?.[key]
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return v < 1e12 ? Math.round(v * 1000) : Math.round(v)
    }
    if (typeof v === 'string') {
      const s = v.trim()
      if (/^\d+(\.\d+)?$/.test(s)) {
        const n = Number(s)
        if (n > 0) return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
        continue
      }
      const parsed = Date.parse(s)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  }
  return 0
}

export function readLocalTokenUsageSummary(range = '7d', ekkoStats = {}, usageRecords = []) {
  const safeRange = RANGE_MS[range] ? range : '7d'
  const cutoff = safeRange === 'all'
    ? 0
    : safeRange === 'today'
      ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      : Date.now() - RANGE_MS[safeRange]

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    requests: 0,
    costUsd: 0,
  }
  const byModelMap = new Map()
  const byDayMap = new Map()
  const sources = []
  let allTimeRequests = 0

  const list = Array.isArray(usageRecords) ? usageRecords : []
  let matched = 0
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue
    const ts = parseUsageTimestamp(rec)
    const inp = Number(rec.input_tokens ?? rec.inputTokens ?? rec.prompt_tokens ?? 0) || 0
    const out = Number(rec.output_tokens ?? rec.outputTokens ?? rec.completion_tokens ?? 0) || 0
    const cr = Number(rec.cache_read_tokens ?? rec.cacheReadTokens ?? 0) || 0
    const cw = Number(rec.cache_write_tokens ?? rec.cacheWriteTokens ?? 0) || 0
    const reas = Number(rec.reasoning_tokens ?? rec.reasoningTokens ?? 0) || 0
    const cost = Number(rec.cost_usd ?? rec.costUsd ?? 0) || 0
    // A ledger record may be a whole session (requests = its model calls) or a single call.
    const reqs = Math.max(1, Number(rec.requests ?? 1) || 1)
    const tot = inp + out + cr + cw
    if (tot === 0 && !rec.model) continue
    allTimeRequests += reqs
    if (cutoff > 0 && (ts <= 0 || ts < cutoff)) continue

    matched += 1
    totals.inputTokens += inp
    totals.outputTokens += out
    totals.cacheReadTokens += cr
    totals.cacheWriteTokens += cw
    totals.reasoningTokens += reas
    totals.totalTokens += tot
    totals.requests += reqs
    totals.costUsd += cost

    const model = String(rec.model || 'unknown').trim()
    const curM = byModelMap.get(model) || { model, requests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    curM.requests += reqs
    curM.totalTokens += tot
    curM.inputTokens += inp
    curM.outputTokens += out
    curM.cacheReadTokens += cr
    byModelMap.set(model, curM)

    if (ts > 0) {
      const d = new Date(ts)
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const curD = byDayMap.get(dayKey) || { day: dayKey, totalTokens: 0, requests: 0 }
      curD.totalTokens += tot
      curD.requests += reqs
      byDayMap.set(dayKey, curD)
    }
  }
  if (matched > 0) sources.push('Ekko ToDo 会话统计')

  const cacheDenom = totals.inputTokens + totals.cacheReadTokens
  const cacheHitRate = cacheDenom > 0 ? Math.round((totals.cacheReadTokens / cacheDenom) * 1000) / 10 : 0

  return {
    range: safeRange,
    sources,
    hasTokenLedger: totals.requests > 0,
    allTimeRequests,
    totals: {
      ...totals,
      costUsd: Math.round(totals.costUsd * 10000) / 10000,
      cacheHitRate,
    },
    byModel: [...byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 8),
    daily: [...byDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-14),
    ekkoActivity: {
      totalTodos: Number(ekkoStats.totalTodos || 0),
      doneTodos: Number(ekkoStats.doneTodos || 0),
      activeTodos: Number(ekkoStats.activeTodos || 0),
      topicCount: Number(ekkoStats.topicCount || 0),
    },
  }
}

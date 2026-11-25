import { randomUUID } from 'node:crypto'
import { MODEL_CONFIG_LIMITS, assertMaxLength, clampText } from './diff-budget.mjs'

export const CONFIG_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour, matching Todos failover semantics
export const MAX_MODEL_CONFIGS = 8

const NON_SWITCHABLE_PATTERNS = [
  /\b(abort(ed)?|cancel(led|ed)?|stopped by user|manually stopped|user stopped)\b/i,
  /\b(merge conflict|uncommitted changes|not a git repository|directory does not exist|worktree)\b/i,
  /\b(test gate|exit code|rc=[1-9])\b/i,
  // The plugin's own fallback wording, alone: it names no cause, so it never switches models by itself.
  /^\s*(执行|审查)会话异常结束[\s。.!！]*$/,
]

// 0.9.46: the model answered with nothing. Two rules of the same category: the exact Hermes wording is
// checked before the other categories (its text carries status=…/model=… fields that must not be read as
// another fault), the generic wording after them (so "Invalid API response …: 429" stays rate_limited).
const EMPTY_OUTPUT = { category: 'empty_output', label: '模型返回空响应' }

const SWITCHABLE_RULES = [
  {
    ...EMPTY_OUTPUT,
    pattern: /response\.output is empty|empty after stream backfill/i,
  },
  {
    category: 'quota_spent',
    label: '配额或余额耗尽',
    pattern: /\b(quota|insufficient[_ ]quota|billing|balance|credit(s)?\s*(exhausted|depleted|empty)|usage limit|plan limit|spending limit|exceeded your current quota)\b/i,
  },
  {
    category: 'rate_limited',
    label: '触发限流或并发拥堵',
    pattern: /\b(429|529|rate[_ -]?limit|too many requests|overloaded|at capacity|throttl(ed|ing)|concurrency limit|capacity)\b/i,
  },
  {
    category: 'auth_failed',
    label: '认证失效或密钥被拒',
    pattern: /\b(401|403|unauthorized|invalid[_ ]api[_ ]key|authentication|not signed in|sign[- ]?in lapsed|token expired|credential|forbidden|account suspended|access denied)\b/i,
  },
  {
    category: 'model_unavailable',
    label: '模型不可用或已下线',
    pattern: /\b(model[_ ]not[_ ]found|does not exist|model.*(disabled|retired|deprecated|unavailable|not supported)|no provider|unknown model|404.*model)\b/i,
  },
  {
    category: 'upstream_fault',
    label: '上游服务端异常',
    pattern: /\b(500|502|503|504|bad gateway|service unavailable|internal server error|gateway timeout|upstream|cloudflare|<!doctype html|<html)\b/i,
  },
  {
    category: 'network_cutoff',
    label: '网络连接中断或超时',
    pattern: /\b(econnrefused|econnreset|etimedout|enotfound|fetch failed|network error|socket hang up|timed out|timeout|empty reply|stream.*(cut|closed|interrupted)|unreachable)\b/i,
  },
  {
    category: 'incompatible_request',
    label: '参数或思考等级不兼容',
    pattern: /\b(reasoning[_ ]effort|thinking.*not supported|developer role|invalid parameter|unsupported.*parameter|incompatible request)\b/i,
  },
  {
    ...EMPTY_OUTPUT,
    pattern: /\b(invalid api response|no content|no visible content|empty response|empty (output|message|completion)|reasoning-only response)\b|无输出|空响应/i,
  },
]

/**
 * Classifies a failed agent run error using Todos's failover rules.
 * Only genuine model/provider/runtime service faults trigger automatic fallback switching;
 * user aborts, git conflicts, or task logic failures never switch models unexpectedly.
 */
export function classifyModelFailure(errorText) {
  const text = String(errorText || '').trim()
  if (!text) return { switchable: false, category: 'unknown', label: '未知错误' }
  for (const re of NON_SWITCHABLE_PATTERNS) {
    if (re.test(text)) {
      return { switchable: false, category: 'non_model', label: '非模型服务异常' }
    }
  }
  for (const rule of SWITCHABLE_RULES) {
    if (rule.pattern.test(text)) {
      return { switchable: true, category: rule.category, label: rule.label }
    }
  }
  return { switchable: false, category: 'unknown', label: '运行异常' }
}

/**
 * Normalizes an agent's ordered run configurations (`modelConfigs[0]` = Primary, `1..7` = Fallbacks).
 * Always keeps top-level engine/model/reasoningEffort synchronized with index 0.
 */
/**
 * A model config for display: every string field within its limit. Returns the same object when
 * nothing had to be cut. Stored configs are never rewritten by this.
 */
export function clampModelConfigForView(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg
  let next = cfg
  for (const [key, max] of Object.entries(MODEL_CONFIG_LIMITS)) {
    if (typeof cfg[key] === 'string' && cfg[key].length > max) {
      if (next === cfg) next = { ...cfg }
      next[key] = clampText(cfg[key], max)
    }
  }
  return next
}

/**
 * `enforceLimits` is for configs that are about to be written: the label is shortened to 80
 * characters and any other over-long string is refused (see MODEL_CONFIG_LIMITS). Reads leave it off,
 * so configs stored before the limits come back unchanged.
 */
export function normalizeModelConfigs(inputConfigs, fallbackPrimary = {}, { enforceLimits = false } = {}) {
  const list = Array.isArray(inputConfigs) ? inputConfigs : []
  const cleaned = []
  const seenIds = new Set()

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    if (cleaned.length >= MAX_MODEL_CONFIGS) break
    if (enforceLimits) {
      for (const key of ['id', 'engine', 'provider', 'model', 'apiMode', 'baseUrl', 'reasoningEffort']) {
        assertMaxLength(`modelConfigs[${cleaned.length}].${key}`, String(raw[key] || '').trim(), MODEL_CONFIG_LIMITS[key])
      }
    }
    let id = String(raw.id || '').trim()
    if (!id || seenIds.has(id)) id = `cfg-${randomUUID().slice(0, 8)}`
    seenIds.add(id)
    const engine = String(raw.engine || fallbackPrimary.engine || 'hermes').trim()
    const mode = raw.mode === 'scoped' ? 'scoped' : (raw.mode === 'global' ? 'global' : (engine === 'hermes' ? 'scoped' : 'global'))
    cleaned.push({
      id,
      label: enforceLimits ? clampText(String(raw.label || '').trim(), MODEL_CONFIG_LIMITS.label) : String(raw.label || '').trim(),
      engine,
      mode,
      provider: String(raw.provider || '').trim(),
      model: String(raw.model || '').trim(),
      apiMode: String(raw.apiMode || '').trim(),
      baseUrl: String(raw.baseUrl || '').trim(),
      customModel: Boolean(raw.customModel),
      reasoningEffort: String(raw.reasoningEffort || '').trim(),
    })
  }

  if (!cleaned.length) {
    const engine = String(fallbackPrimary.engine || 'hermes').trim()
    const mode = fallbackPrimary.mode === 'scoped'
      ? 'scoped'
      : (fallbackPrimary.mode === 'global' ? 'global' : (engine === 'hermes' ? 'scoped' : 'global'))
    cleaned.push({
      id: String(fallbackPrimary.primaryConfigId || 'cfg-primary'),
      label: '首选配置',
      engine,
      mode,
      provider: String(fallbackPrimary.provider || '').trim(),
      model: String(fallbackPrimary.model || '').trim(),
      apiMode: String(fallbackPrimary.apiMode || '').trim(),
      baseUrl: String(fallbackPrimary.baseUrl || '').trim(),
      customModel: Boolean(fallbackPrimary.customModel),
      reasoningEffort: String(fallbackPrimary.reasoningEffort || '').trim(),
    })
  }

  return cleaned
}

/**
 * Resolves the active run configuration for an agent given an optional activeConfigId.
 */
export function resolveActiveConfig(agent, activeConfigId = '') {
  const configs = normalizeModelConfigs(agent?.modelConfigs, agent || {})
  if (activeConfigId) {
    const hit = configs.find(c => c.id === activeConfigId)
    if (hit) return { config: hit, index: configs.indexOf(hit), configs }
  }
  return { config: configs[0], index: 0, configs }
}

/**
 * Picks the next healthy fallback configuration in list order,
 * skipping the failed config and any config still inside its 1-hour cooldown window.
 */
export function selectNextFallbackConfig({
  agent,
  failedConfigId,
  cooldowns = [],
  nowMs = Date.now(),
  cooldownMs = CONFIG_COOLDOWN_MS,
}) {
  const configs = normalizeModelConfigs(agent?.modelConfigs, agent || {})
  if (configs.length <= 1) return null

  const cooledIds = new Set()
  if (failedConfigId) cooledIds.add(failedConfigId)
  for (const cd of cooldowns) {
    if (cd && cd.configId && (nowMs - Number(cd.failedAt || 0)) < cooldownMs) {
      cooledIds.add(cd.configId)
    }
  }

  for (let i = 0; i < configs.length; i += 1) {
    if (!cooledIds.has(configs[i].id)) {
      return { config: configs[i], index: i }
    }
  }
  return null
}

export function formatConfigLabel(cfg, index = 0) {
  if (!cfg) return '默认配置'
  const prefix = index === 0 ? '首选' : `备选 #${index}`
  const modelPart = cfg.model ? cfg.model : `${cfg.engine} 默认`
  const effortPart = cfg.reasoningEffort ? ` · ${cfg.reasoningEffort}` : ''
  return cfg.label ? `${prefix}（${cfg.label}：${modelPart}${effortPart}）` : `${prefix}（${cfg.engine} / ${modelPart}${effortPart}）`
}

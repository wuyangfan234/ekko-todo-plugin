export function formatRelativeTime(tsMs) {
  const n = Number(tsMs || 0)
  if (!n) return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - n) / 1000))
  if (diffSec < 60) return '刚刚'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} 小时前`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return '昨天'
  return `${diffDay} 天前`
}

/** Sidebar age: the relative time without the trailing 「前」, so narrow rows leave more room for the title. */
export function formatSidebarAge(tsMs, nowMs = Date.now()) {
  const n = Number(tsMs || 0)
  if (!n) return ''
  const diffSec = Math.max(0, Math.floor((nowMs - n) / 1000))
  if (diffSec < 60) return '刚刚'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} 分钟`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} 小时`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return '昨天'
  return `${diffDay} 天`
}

export function formatShortClock(tsMs) {
  const n = Number(tsMs || 0)
  if (!n) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatMessageTimeDivider(tsMs) {
  const n = Number(tsMs || 0)
  if (!n) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const hhmm = formatShortClock(n)
  const sameYear = d.getFullYear() === now.getFullYear()
  const sameDay = sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return hhmm
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday = d.getFullYear() === yesterday.getFullYear()
    && d.getMonth() === yesterday.getMonth()
    && d.getDate() === yesterday.getDate()
  if (isYesterday) return `昨天 ${hhmm}`
  if (sameYear) return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
}

export function shouldShowTimeDivider(prevTsMs, currTsMs, gapMs = 5 * 60 * 1000) {
  const curr = Number(currTsMs || 0)
  if (!curr) return false
  const prev = Number(prevTsMs || 0)
  if (!prev) return true
  if (Math.abs(curr - prev) >= gapMs) return true
  const a = new Date(prev)
  const b = new Date(curr)
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate()
}

/**
 * Bulletproof CJK / mixed Chinese-English IME Enter guard for macOS Safari, WebKit, and Chromium:
 * Prevents Enter pressed to confirm raw English letters in an active IME candidate bar from
 * prematurely submitting the message (which causes stray English characters to linger after submit).
 */
export function isImeComposingEvent(e, composingRef, lastCompositionEndRef) {
  if (!e) return false
  if (composingRef?.current) return true
  if (e.nativeEvent?.isComposing || e.isComposing) return true
  if (e.keyCode === 229 || e.which === 229 || e.key === 'Process') return true
  const endedAt = Number(lastCompositionEndRef?.current || 0)
  if (endedAt > 0 && (Date.now() - endedAt) < 120) return true
  return false
}

export function formatDuration(ms) {
  const n = Number(ms || 0)
  if (n <= 0) return ''
  if (n < 1000) return `${n}ms`
  const sec = (n / 1000).toFixed(n < 10000 ? 1 : 0)
  if (Number(sec) < 60) return `${sec}s`
  const m = Math.floor(Number(sec) / 60)
  const s = Math.round(Number(sec) % 60)
  return `${m}m ${s}s`
}

export function formatTokens(n) {
  const num = Number(n || 0)
  if (!num) return '0'
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`
  return String(num)
}

export function formatModelShort(model, provider = '') {
  const m = String(model || '').trim()
  if (!m) return '引擎默认'
  if (m.startsWith('[') && m.endsWith(']')) {
    try {
      const parsed = JSON.parse(m)
      if (Array.isArray(parsed) && parsed.length) return String(parsed[parsed.length - 1])
    } catch {}
  }
  const clean = m.includes('/') ? m.split('/').pop() : m
  if (clean.length > 26) return `${clean.slice(0, 24)}…`
  return clean || provider || '引擎默认'
}

export const ENGINE_LABEL = {
  hermes: 'Hermes',
  'ekko-agent': 'Ekko Agent',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  dsh: 'DeepSeek',
  qwen: 'Qwen Code',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  copilot: 'Copilot',
  kimi: 'Kimi Code',
  codebuddy: 'CodeBuddy',
  qoder: 'Qoder',
  pi: 'Pi',
}

export const ROLE_LABEL = {
  chief: '总管编排',
  builder: '开发执行',
  reviewer: '代码审查',
  qa: '测试验证',
  custom: '自定义协作者',
}

export const ROLE_PRESET_LABELS = [
  { label: '开发执行', role: 'builder', avatar: 'preset:dev-terminal', sandbox: 'workspace-write' },
  { label: '代码审查', role: 'reviewer', avatar: 'preset:reviewer-shield', sandbox: 'read-only' },
  { label: '测试验证', role: 'qa', avatar: 'preset:qa-flask', sandbox: 'workspace-write' },
  { label: '新媒体运营', role: 'custom', avatar: 'preset:media-spark', sandbox: 'workspace-write' },
  { label: '内容主编', role: 'custom', avatar: 'preset:editor-quill', sandbox: 'workspace-write' },
  { label: '选题策划', role: 'custom', avatar: 'preset:media-spark', sandbox: 'workspace-write' },
  { label: '视觉设计', role: 'custom', avatar: 'preset:designer-palette', sandbox: 'workspace-write' },
  { label: '数据分析', role: 'custom', avatar: 'preset:analyst-chart', sandbox: 'workspace-write' },
  { label: '深度调研', role: 'custom', avatar: 'preset:researcher-owl', sandbox: 'read-only' },
  { label: '产品策划', role: 'custom', avatar: 'preset:chief-compass', sandbox: 'workspace-write' },
  { label: '通用助理', role: 'custom', avatar: 'preset:assistant-bot', sandbox: 'workspace-write' },
]

export const PROJECT_ACCENTS = [
  { id: 'blue', label: '星海蓝' },
  { id: 'amber', label: '暖琥珀' },
  { id: 'emerald', label: '松柏绿' },
  { id: 'violet', label: '丁香紫' },
  { id: 'rose', label: '珊瑚红' },
  { id: 'teal', label: '青碧色' },
]

export function getProjectLabel(project) {
  if (!project) return ''
  return String(project.displayName || '').trim() || String(project.name || '').trim() || '未命名项目'
}

export function getProjectMonogram(project) {
  if (!project) return 'P'
  const label = getProjectLabel(project)
  const chars = Array.from(label)
  const first = chars.find(ch => /[\p{L}\p{N}]/u.test(ch)) || chars[0] || 'P'
  const auto = /[a-z]/.test(first) ? first.toUpperCase() : first
  if (project.displayName) return auto
  const saved = String(project.monogram || '').trim()
  if (!saved) return auto
  return /^[a-z]+$/.test(saved) ? saved.toUpperCase() : saved
}

export function getAgentRoleLabel(agent) {
  if (!agent) return ''
  return String(agent.roleLabel || '').trim() || ROLE_LABEL[agent.role] || agent.role || '协作者'
}

export function formatFileSize(bytes) {
  const n = Number(bytes || 0)
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export const MODE_LABEL = {
  scoped: 'Studio 托管',
  global: 'CLI 原生',
}

export const KIND_LABEL = {
  feature: '功能',
  bug: '缺陷',
  question: '待定',
  deploy: '部署',
  content: '内容',
  failed: '失败',
}

export const SANDBOX_LABEL = {
  'read-only': '只读审计',
  'workspace-write': '工作区可写',
  'full-access': '完全访问',
}

export const APPROVAL_LABEL = {
  never: '不询问',
  'on-failure': '出错时确认',
  'on-request': '按需确认',
  untrusted: '每步确认',
}

export const API_MODE_LABEL = {
  '': '自动匹配协议',
  chat_completions: 'OpenAI Chat Completions',
  codex_responses: 'OpenAI Responses',
  anthropic_messages: 'Anthropic Messages',
}

export const MEMORY_SCOPE_LABEL = {
  chief: '总管全局',
  project: '项目专属',
  agent: 'Agent 专属',
}

export const MEMORY_CATEGORY_LABEL = {
  preference: '协作偏好',
  convention: '工程规范',
  architecture: '架构约定',
  pitfall: '避坑经验',
  decision: '已定决策',
}

export const EFFORT_ORDER = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export const EFFORT_META = {
  '': { label: '默认', short: '默认', tone: 'neutral', desc: '沿用模型或引擎内置思考深度' },
  off: { label: '关闭', short: '关', tone: 'neutral', desc: '不做扩展思考，回复最快' },
  minimal: { label: '极低', short: '极低', tone: 'cool', desc: '轻量校验，最低延迟与开销' },
  low: { label: '低', short: '低', tone: 'cool', desc: '快速响应，适合常规协调与明确改动' },
  medium: { label: '中', short: '中', tone: 'balanced', desc: '速度与推理质量均衡，日常主力档位' },
  high: { label: '高', short: '高', tone: 'deep', desc: '深度推理，适合任务拆单、排障与代码审查' },
  xhigh: { label: '极高', short: '极高', tone: 'deep', desc: '更深的推理，适合跨文件改动和重构' },
  max: { label: '最大', short: '最大', tone: 'intense', desc: '使用模型的最高思考预算，耗时更长' },
  ultra: { label: '超高', short: '超高', tone: 'intense', desc: '最高档，最慢，只在必要时用' },
}

export function getEffortMeta(level) {
  const key = String(level || '').toLowerCase()
  return EFFORT_META[key] || { label: key || '默认', short: key || '默认', tone: 'balanced', desc: '自定义思考等级' }
}

export function normalizeEffortStops(supportedEfforts = [], currentValue = '') {
  const raw = Array.isArray(supportedEfforts) && supportedEfforts.length
    ? supportedEfforts.map(s => String(s || '').toLowerCase()).filter(Boolean)
    : ['off', 'low', 'medium', 'high', 'xhigh', 'max']
  const set = new Set(['', ...raw])
  if (currentValue) set.add(String(currentValue).toLowerCase())
  return [...set].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a)
    const ib = EFFORT_ORDER.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
}

export function formatLiveClock(startedAtMs) {
  const start = Number(startedAtMs || 0)
  if (!start) return ''
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Extract structured waiting options from a Topic Brief.
 * Uses explicit `brief.waitingOptions` when present; for legacy plain-text prompts
 * like "是弃用还是重新提交由你定", safely extracts two concise quick-choice pills.
 */
export function resolveWaitingOptions(brief) {
  if (!brief) return { options: [], inferred: false }
  if (Array.isArray(brief.waitingOptions) && brief.waitingOptions.length > 0) {
    const explicit = brief.waitingOptions
      .map((o, idx) => (typeof o === 'string'
        ? { id: `opt-${idx + 1}`, label: o.trim(), recommended: idx === 0 }
        : { id: String(o?.id || `opt-${idx + 1}`), label: String(o?.label || '').trim(), recommended: Boolean(o?.recommended) }))
      .filter(o => o.label)
    if (explicit.length) {
      if (!explicit.some(o => o.recommended)) explicit[0].recommended = true
      return { options: explicit, inferred: false }
    }
  }
  const text = String(brief.waitingOnYou || '').trim()
  if (!text) return { options: [], inferred: false }
  const m = text.match(/(?:是否|是)\s*([^，。？；、\n]{1,16}?)\s*还是\s*([^，。？；、\n]{1,16}?)(?:由你定|由您定|更合适|比较好|？|\?|$)/)
  if (m && m[1] && m[2]) {
    const a = m[1].trim()
    const b = m[2].trim()
    if (a && b && a !== b) {
      const recA = /建议|推荐|首选/.test(text) && !new RegExp(`(?:建议|推荐|首选)[^，。；]*${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)
      return {
        options: [
          { id: 'inferred-1', label: a, recommended: recA || true },
          { id: 'inferred-2', label: b, recommended: false },
        ],
        inferred: true,
      }
    }
  }
  return { options: [], inferred: false }
}

/**
 * Extracts Chief's concrete recommended decision text so approval dialogs & inline
 * boxes can pre-populate it by default for 1-click confirmation or light tweaking.
 */
export function resolveChiefRecommendation(brief, topicMessages = []) {
  if (!brief) return ''
  const explicit = String(brief.waitingRecommendation || '').trim()
  if (explicit) return explicit

  const waiting = String(brief.waitingOnYou || '').trim()
  // Match explicit Chief advice clauses like "建议直接弃用删除（无合并价值）"
  const adviceMatch = waiting.match(/(?:建议|推荐|结论先说|首选)[：:]?\s*([^；;\n。？?]{4,140})/)
  if (adviceMatch && adviceMatch[1]) {
    return `按大总管建议执行：${adviceMatch[1].trim()}`
  }

  // Scan latest Chief message for explicit recommendation headline
  const lastChief = [...(Array.isArray(topicMessages) ? topicMessages : [])]
    .reverse()
    .find(m => m?.kind === 'chief' && String(m.text || '').trim())
  if (lastChief) {
    const plain = String(lastChief.text || '').replace(/[*#`]/g, '')
    const msgMatch = plain.match(/(?:结论先说|核心建议|推荐方案|建议)[：:]\s*([^\n。]{4,120})/)
    if (msgMatch && msgMatch[1]) {
      return `按大总管建议执行：${msgMatch[1].trim()}`
    }
  }

  const { options } = resolveWaitingOptions(brief)
  const recOpt = options.find(o => o.recommended) || options[0]
  if (recOpt?.label) return `采用推荐方案：${recOpt.label}`

  return waiting ? `按大总管建议推进（${waiting.slice(0, 90)}${waiting.length > 90 ? '…' : ''}）` : ''
}

/**
 * Rich visual status metadata for Kanban cards across all lifecycle stages
 * (queued/planning/building/reviewing/merging/confirm/review-ready/failed/done).
 */
export function getTodoCardStateMeta(td) {
  if (!td) return { tone: 'neutral', statusText: '', running: false, ready: false }
  if (td.phase === 'building') {
    const isPlan = td.gateKind === 'plan' || (td.withPlan && !td.plan)
    return {
      tone: 'doing',
      statusText: isPlan ? '规划方案中' : '编码构建中',
      running: true,
      ready: false,
    }
  }
  if (td.phase === 'reviewing') {
    return {
      tone: 'reviewing',
      statusText: '独立审查中',
      running: true,
      ready: false,
    }
  }
  if (td.phase === 'queued') {
    return {
      tone: 'queued',
      statusText: '排队中 · 等槽位',
      running: false,
      ready: false,
    }
  }
  if (td.phase === 'merging') {
    return {
      tone: 'merging',
      statusText: '正在合并分支',
      running: true,
      ready: false,
    }
  }
  if (td.phase === 'failed') {
    return {
      tone: 'failed',
      statusText: '执行失败 · 可重试',
      running: false,
      ready: false,
    }
  }
  if (td.question?.active) {
    return {
      tone: 'human',
      statusText: '待你回答决策',
      running: false,
      ready: true,
    }
  }
  if (td.phase === 'confirm') {
    if (td.gateOwner === 'chief') {
      return { tone: 'chief', statusText: '方案完毕 · 总管审批中', running: false, ready: true }
    }
    return { tone: 'human', statusText: '方案就绪 · 待你批准', running: false, ready: true }
  }
  if (td.phase === 'review') {
    if (td.gateKind === 'deliverable') {
      return td.gateOwner === 'chief'
        ? { tone: 'chief', statusText: td.kind === 'deploy' ? '部署已执行 · 总管验收中' : '成果已交付 · 总管验收中', running: false, ready: true }
        : { tone: 'ready', statusText: td.kind === 'deploy' ? '部署已执行 · 待你验收' : '成果已交付 · 待你验收', running: false, ready: true }
    }
    const testOk = td.evidence?.testRc === 0
    const revOk = td.evidence?.reviewVerdict === 'approved'
    if (td.gateKind === 'changes' || td.evidence?.reviewVerdict === 'changes_requested') {
      return {
        tone: td.gateOwner === 'chief' ? 'chief' : 'human',
        statusText: td.gateOwner === 'chief' ? '审查要求修改 · 总管安排返工' : '审查要求修改 · 待你决定',
        running: false,
        ready: true,
      }
    }
    if (td.gateOwner === 'chief') {
      return {
        tone: 'chief',
        statusText: revOk ? '已通过审查 · 总管跟进' : '执行完毕 · 总管验收中',
        running: false,
        ready: true,
      }
    }
    if (revOk) return { tone: 'ready', statusText: '审查通过 · 待你合并', running: false, ready: true }
    if (testOk) return { tone: 'ready', statusText: '构建完毕 · 测试通过', running: false, ready: true }
    return { tone: 'human', statusText: '执行完毕 · 待你验收', running: false, ready: true }
  }
  if (td.phase === 'done') {
    const merged = Boolean(td.evidence?.commitSha)
    return {
      tone: 'done',
      statusText: merged ? '已合并完成' : '已完成',
      running: false,
      ready: false,
    }
  }
  if (td.phase === 'closed') {
    return { tone: 'neutral', statusText: '已关闭', running: false, ready: false }
  }
  return { tone: 'todo', statusText: '待开始', running: false, ready: false }
}

// v0.9.10: the server lists todos by updated_at, which a running build bumps on every event, so cards kept
// jumping around. Lanes now use a fixed order: 待开始/执行中/待处理 by creation time (oldest first, #number as
// tie-break); 已完成 keeps the most recently finished on top. Live updates never move a card.
export function sortLaneCards(cards, laneId) {
  const created = td => Number(td.createdAt) || 0
  const num = td => Number(td.number) || 0
  const list = [...cards]
  if (laneId === 'done') {
    return list.sort((a, b) => (Number(b.completedAt || b.updatedAt) || 0) - (Number(a.completedAt || a.updatedAt) || 0) || num(b) - num(a))
  }
  return list.sort((a, b) => created(a) - created(b) || num(a) - num(b))
}

// A topic that watches cards but has no Chief session: progress is written to it, nobody is woken.
// A topic whose first turn is starting has no session id yet and is not flagged.
export function isUnattendedTopic(topic) {
  if (!topic || topic.chiefSessionId || topic.isRunning) return false
  return Array.isArray(topic.watchedTodoIds) && topic.watchedTodoIds.length > 0
}

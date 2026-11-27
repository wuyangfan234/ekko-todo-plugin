// #101 — page-only rules behind "does this setting really apply / where does this new card go / what do I do
// next". Client only: nothing here is sent or stored, and no contract model changes. Every function is pure so
// the dialog, the settings page, the board and ⌘K read one answer.
import { capReasoningEffort } from '../shared/chief-guard.mjs'

// ---- New task: which topic the card is attached to ---------------------------------------------------------

/** Select value meaning "create a topic for this project, then attach the card to it". */
export const NEW_TOPIC_CHOICE = '__new_topic__'

/** Live topics that belong to exactly this project. A topic of another project, or of no project, is never listed. */
export function topicsForProject(topics, projectId) {
  if (!projectId) return []
  return (topics || []).filter(t => t && !t.archived && t.projectId === projectId)
}

/** Default selection: the open topic when it belongs to the project, else the project's first topic, else "new". */
export function pickTaskTopic({ topics, projectId, preferredTopicId = '' }) {
  const list = topicsForProject(topics, projectId)
  if (preferredTopicId && list.some(t => t.id === preferredTopicId)) return preferredTopicId
  return list[0]?.id || NEW_TOPIC_CHOICE
}

/** The dialog's project + topic every time it opens (and the topic again whenever the project changes). */
export function newTaskDraft({ projects, topics, defaultProjectId = '', activeTopicId = '' }) {
  const list = projects || []
  const projectId = list.some(p => p.id === defaultProjectId) ? defaultProjectId : (list[0]?.id || '')
  return { projectId, topicChoice: pickTaskTopic({ topics, projectId, preferredTopicId: activeTopicId }) }
}

/**
 * What the submit sends. `topicId` is only ever a topic of `projectId`; anything else (stale choice, a topic that
 * was archived or moved meanwhile, the "new" option) means "create a topic first".
 */
export function resolveTaskTopic({ topics, projectId, topicChoice }) {
  const hit = topicsForProject(topics, projectId).find(t => t.id === topicChoice)
  return hit ? { topicId: hit.id, createTopic: false } : { topicId: '', createTopic: true }
}

const projectName = (projects, id) => {
  const p = (projects || []).find(x => x.id === id)
  return p ? (p.displayName || p.name || p.id) : id
}

/** Shown in the dialog when the open topic is not a topic of the chosen project. null = nothing to say. */
export function taskTopicNotice({ activeTopic, projectId, projects }) {
  if (!activeTopic || !projectId || activeTopic.projectId === projectId) return null
  const target = projectName(projects, projectId)
  const title = activeTopic.title || '未命名话题'
  return activeTopic.projectId
    ? `当前话题「${title}」属于项目「${projectName(projects, activeTopic.projectId)}」，这张任务归项目「${target}」，不会挂到当前话题。请在下方选一个「${target}」的话题，或新建话题。`
    : `当前话题「${title}」没有绑定项目，这张任务归项目「${target}」，不会挂到当前话题。请在下方选一个「${target}」的话题，或新建话题。`
}

export const TOPIC_NOT_CREATED = '话题没有创建成功，所以任务也没有创建。请重试，或改选一个已有话题。'

/**
 * Sends the card and resolves only when the card exists; every failure throws, so the dialog (#100
 * `settleAction`) stays open with what was typed and shows the reason. `callRpc` resolves null on a refused call
 * and reports the reason through `onError`; that reason is re-thrown here.
 * With `createTopic` the project's topic is created first and the card goes to exactly that new topic. If the
 * topic cannot be created the card is not sent at all (an empty topicId would let the server guess, and its guess
 * can be a topic of another project). `onTopicCreated(id)` fires as soon as the topic exists, so a retry after a
 * refused card reuses it instead of creating a second topic.
 */
export async function createTaskWithTopic({ input, topics, callRpc, onTopicCreated }) {
  const { createTopic, ...todoInput } = input
  const call = async (name, payload, toast) => {
    let refused = null
    const next = await callRpc(name, payload, toast, { onError: err => { refused = err } })
    if (refused) throw refused
    return next
  }
  if (!createTopic && todoInput.topicId) return call('create-todo', todoInput, '已创建任务')
  const known = new Set((topics || []).map(t => t.id))
  const snap = await call('create-topic', { projectId: todoInput.projectId, title: String(todoInput.title || '').slice(0, 32), autopilot: false })
  const created = (snap?.topics || []).find(t => !known.has(t.id) && t.projectId === todoInput.projectId)
  if (!created) throw new Error(TOPIC_NOT_CREATED)
  try { onTopicCreated?.(created.id) } catch {}
  return call('create-todo', { ...todoInput, topicId: created.id }, `已创建任务，并新建话题「${created.title || '未命名话题'}」`)
}

// ---- Chief reasoning effort: requested vs. in effect -------------------------------------------------------

export const EFFORT_LEVELS = [
  ['low', '低', '快速响应与常规协调'],
  ['medium', '中', '均衡主力档位'],
  ['high', '高', '深度推理与复杂拆单'],
  ['xhigh', '极高', '跨文件架构与严苛审查'],
  ['max', '最大', '释放模型最高思考预算'],
]
/** The cap select offers the same ladder as the level picker, plus "no cap". */
export const EFFORT_CAP_OPTIONS = [
  ['low', '低'], ['medium', '中（推荐）'], ['high', '高'], ['xhigh', '极高'], ['max', '最大'], ['', '不限制'],
]
const EFFORT_NAME = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大', ultra: '超高' }
export const effortLabel = v => (v ? (EFFORT_NAME[String(v).toLowerCase()] || String(v)) : '引擎默认')

/**
 * The level that really runs. KNOWN DUPLICATE RULE — 规则复制自服务端，服务端变更需同步：
 *   (line numbers are those at the time of writing; the symbol names are what to search for)
 *   - src/server/orchestrator.mjs:2064-2066 `capChiefCfg`: the cap applies only while
 *     `chiefStrictOrchestration !== false` and `chiefEffortCap` is non-empty;
 *   - src/shared/chief-guard.mjs:125 `capReasoningEffort` (imported here, not copied): an unset level is pinned
 *     to the cap, a level above the cap becomes the cap;
 *   - src/server/db.mjs:646 `normalizeEffortCap(... ?? 'medium')`: a missing cap means 'medium'.
 * The snapshot carries no "effective effort" field (contracts are out of this card's scope), so the page
 * recomputes it. If any of the three places above changes, change this function with it.
 */
export function chiefEffortView(settings, requested = '') {
  const req = String(requested || '').trim().toLowerCase()
  const strict = settings?.chiefStrictOrchestration !== false
  const cap = strict ? String(settings?.chiefEffortCap ?? 'medium').trim().toLowerCase() : ''
  const effective = String((cap ? capReasoningEffort(req, cap) : req) || '').toLowerCase()
  const limited = Boolean(cap) && effective !== req
  let reason = ''
  if (limited) {
    reason = req
      ? `你选的是「${effortLabel(req)}」，但「总管不直接改代码」开着、思考上限是「${effortLabel(cap)}」，所以总管实际按「${effortLabel(effective)}」运行。`
      : `没有指定等级时，总管按思考上限「${effortLabel(cap)}」运行。`
  }
  return {
    requested: req,
    effective,
    cap,
    limited,
    text: `生效：${effortLabel(effective)}${limited ? '（受上限限制）' : ''}`,
    reason,
  }
}

/** Toast after picking a level: says what was asked for and what actually runs. */
export function chiefEffortToast(settings, level) {
  const v = chiefEffortView(settings, level)
  return v.limited
    ? `已请求「${effortLabel(level)}」，${v.text}。到「设置 → 总管与章程」调高思考上限后才会按「${effortLabel(level)}」运行`
    : `总管思考等级已设为「${effortLabel(level)}」，下一轮回复起生效`
}

// ---- Stall watchdog thresholds -----------------------------------------------------------------------------

export const STALL_LIMITS = { warn: [1, 240], heal: [5, 720], cooldown: [1, 60] }

/**
 * Drafts are minutes typed into the three inputs. A contradictory set is refused, never adjusted: the reminder
 * must come before the auto-return, and two auto-returns need at least 60 seconds between them.
 */
export function validateStallDraft({ warn, heal, cooldown }) {
  const errors = {}
  const read = (key, raw, name, belowMin = '') => {
    const text = String(raw ?? '').trim()
    const n = Number(text)
    const [min, max] = STALL_LIMITS[key]
    if (!text || !Number.isFinite(n)) { errors[key] = `${name}要填整数分钟`; return null }
    if (n < min && belowMin) { errors[key] = belowMin; return null }
    if (!Number.isInteger(n)) { errors[key] = `${name}要填整数分钟`; return null }
    if (n < min || n > max) { errors[key] = `${name}要在 ${min}–${max} 分钟之间`; return null }
    return n
  }
  const w = read('warn', warn, '提示阈值')
  const h = read('heal', heal, '自动退回阈值')
  const c = read('cooldown', cooldown, '间隔', '间隔不能小于 60 秒')
  if (w !== null && h !== null && w >= h) {
    errors.warn = `提示阈值必须小于自动退回阈值（${w} ≥ ${h}）`
    errors.heal = '自动退回阈值必须大于提示阈值'
  }
  const ok = Object.keys(errors).length === 0
  return {
    ok,
    errors,
    patch: ok ? { buildStallWarnMs: w * 60000, buildStallHealMs: h * 60000, buildStallCooldownMs: c * 60000 } : null,
  }
}

// ---- Settings: when does a change apply --------------------------------------------------------------------

/** One line per setting: how it is saved and when the saved value starts to apply. */
export const SETTING_EFFECT = {
  chiefModel: '即改即存。下一轮总管回复起生效，正在进行的这一轮不变。',
  chiefStrict: '即改即存（开关与思考上限都是）。下一轮总管回复起生效。',
  charter: '点「保存」后写入。下一轮总管回复起生效。',
  chiefAuthority: '即改即存。总管下一次调用对应工具时生效；「参考宿主记忆」下一轮总管回复起生效。',
  concurrency: '即改即存，立刻生效：正在执行的任务不受影响，排队的任务按新上限补位。',
  cloneRoot: '点「保存」后写入（在输入框里按回车也会保存）。下一次从 GitHub 导入项目时生效，已导入的项目不搬动。',
  sessionMode: '即改即存。之后新建的会话按新方式归类；已有会话点「整理历史会话」才会重新归类。',
  sessionCategory: '点「保存」后写入。之后新建的会话用新分类名；已有会话点「整理历史会话」才会改。',
  notify: '即改即存，立刻生效，只影响当前这个浏览器页面收到的提醒。',
  stallSwitch: '即改即存。下一次巡检（几秒内）起生效。',
  stall: '点「保存」后写入。下一次巡检（几秒内）起生效，正在计时的任务按新阈值重新判断。',
}

// ---- Board lanes -------------------------------------------------------------------------------------------

/** One word per lane, shared by the column head, the phone tab, the stage filter and the card status. */
export const LANE_LABEL = { todo: '待开始', doing: '执行中', confirm: '待处理', done: '已完成' }

/** The 待处理 lane holds both kinds; the head counts every card in it and says how many wait for the user. */
export function confirmLaneCounts(cards, waitingTopics = []) {
  const list = cards || []
  const human = list.filter(td => td.gateOwner === 'human').length + (waitingTopics || []).length
  const total = list.length + (waitingTopics || []).length
  return { total, human, chief: total - human }
}

/** What an empty lane says and which button it offers. Never just 「暂无」. */
export function laneEmptyView({ laneId, hasFilters, boardEmpty }) {
  if (hasFilters) return { text: '没有符合筛选条件的任务。', action: 'clear', actionLabel: '清除筛选' }
  if (laneId === 'todo') {
    return {
      text: boardEmpty ? '看板还是空的。新建一张任务，或在左侧对总管说一句目标，它会拆成任务放到这里。' : '没有等待开始的任务。',
      action: 'create',
      actionLabel: '新建任务',
    }
  }
  if (laneId === 'doing') return { text: '没有正在执行的任务。派工后的任务会出现在这里。', action: '', actionLabel: '' }
  if (laneId === 'confirm') return { text: '没有等你或总管处理的任务。构建完成、需要验收或合并时会出现在这里。', action: '', actionLabel: '' }
  return { text: '还没有完成的任务。合并或验收后的任务会出现在这里。', action: '', actionLabel: '' }
}

// ---- First-run guide ---------------------------------------------------------------------------------------

/**
 * The guide may only move on with an installed engine, unless the user explicitly accepted the consequence for
 * that exact engine (`acknowledgedId`).
 */
export function onboardingEngineGate({ engines, engineId, acknowledgedId = '' }) {
  const eng = (engines || []).find(e => e.id === engineId)
  const installed = Boolean(eng?.installed)
  const acknowledged = !installed && acknowledgedId === engineId
  return {
    installed,
    acknowledged,
    blocked: !installed && !acknowledged,
    guide: installed ? '' : '这个引擎在本机没有检测到。请先在本机安装它的命令行并完成登录（在终端里能直接运行），再重新打开引导；或者改选一个「已就绪」的引擎。',
    consequence: installed ? '' : '仍要继续的后果：总管每次启动都会失败，直到这个引擎装好为止；期间发给总管的消息不会有回复。',
  }
}

// ---- Search entry (⌘K) -------------------------------------------------------------------------------------

export function isTouchDevice(win = typeof window !== 'undefined' ? window : null) {
  try {
    return Boolean(win?.matchMedia?.('(pointer: coarse)')?.matches)
  } catch {
    return false
  }
}

/** Placeholder and footer hints. Touch screens have no ⌘ key, so none of the texts mention it. */
export function paletteHints({ touch, mode = 'all' }) {
  const base = mode === 'tasks' ? '搜索任务标题或编号' : mode === 'topics' ? '搜索话题标题' : '搜索项目、话题、任务，或执行快捷操作'
  const key = mode === 'tasks' ? '⌘P' : mode === 'topics' ? '⌘J' : '⌘K'
  if (touch) return { placeholder: `${base}…`, foot: ['点此搜索：在上方输入关键词', '点条目执行', '点空白处关闭'], searchLabel: '点此搜索' }
  return {
    placeholder: `${base} (${key})…`,
    foot: ['↑↓ 导航', '↵ 执行', '⌘P 任务', '⌘J 话题', '⌘/ 快捷键', 'ESC 关闭'],
    searchLabel: '搜索 ⌘K',
  }
}

/** Empty search: what was searched and what to do next. `limits` are the list sizes the palette really shows. */
export function paletteEmptyView({ query, mode = 'all', topicLimit, todoLimit }) {
  const q = String(query || '').trim()
  const scope = mode === 'tasks'
    ? `只在最近 ${todoLimit} 张任务的标题和编号里找`
    : mode === 'topics'
      ? `只在最近 ${topicLimit} 个话题的标题里找`
      : `在项目名、最近 ${topicLimit} 个话题的标题、最近 ${todoLimit} 张任务的标题和编号里找`
  return {
    title: q ? `没有找到「${q}」` : '没有可显示的内容',
    scope: `搜索范围：${scope}，不搜任务说明和对话内容。`,
    next: '下一步：换一个更短的关键词，或直接新建。',
  }
}

/**
 * Chief orchestration guard — pure rules shared by the server (enforcement) and tests.
 *
 * Pattern borrowed from supervisor/worker setups (LangGraph `create_supervisor`, OpenAI Agents SDK handoffs,
 * Claude Code's orchestrator + subagent split): the supervisor only routes work. Prompts alone do not hold
 * that line — a strong model will "just quickly fix it" — so the boundary is enforced at runtime on tool use:
 *   - write / delegate / execute tools in a Chief turn are refused (the turn is stopped and corrected);
 *   - a turn that keeps investigating without dispatching is cut off and told to dispatch or answer.
 *
 * No imports: this file is bundled into dist/server.mjs and may be bundled into the client.
 */

/** Strip MCP/server prefixes: `mcp__ekko_todo__ekko_todo__create_utodo` → `create_utodo`. */
export function baseToolName(name) {
  const raw = String(name || '').trim()
  const parts = raw.split('__').filter(Boolean)
  return (parts[parts.length - 1] || raw).toLowerCase()
}

// 0.9.57: skill_manage / cronjob_manage write the agent's own skills and schedules; a Chief on a real board
// rewrote a project skill twice with skill_manage and the guard let it through.
const WRITE = /^(write_file|patch|edit|edit_file|apply_patch|multi_edit|multiedit|str_replace_editor|str_replace_based_edit_tool|create_file|notebook_edit|notebookedit|skill_manage|cronjob_manage)$/
const DELEGATE = /^(delegate_task|task|spawn_agent|spawn_subagent|dispatch_agent|agent)$/
const EXECUTE = /^(terminal|bash|shell|exec|execute_code|run_code|process_manage|python|code_interpreter|browser_exec|browser_cdp|browser_dialog|computer_use|close_terminal|image_generate|video_generate)$/
/** Ekko ToDo tools that actually hand work to a Worker (the Chief's real job). */
const DISPATCH = /^(create_todo|run_build|run_review|message_todo|merge_build|retry_merge|confirm_plan|cancel_build|complete_todo|update_todo|create_schedule)$/
/** Every Ekko ToDo board tool (reading the board is orchestration, not investigation). */
const EKKO_TODO_TOOLS = new Set([
  'ask_user', 'cancel_build', 'complete_todo', 'configure_agent', 'configure_chief', 'configure_project', 'confirm_plan',
  'create_schedule', 'create_todo', 'delete_agent', 'delete_schedule', 'get_system_config', 'get_todo_conversation',
  'get_todo_diff', 'import_github_project', 'inspect_project_repo', 'list_agents', 'list_memories', 'list_projects',
  'list_schedules', 'list_todos', 'manage_memory', 'merge_build', 'message_todo', 'rename_topic', 'retry_merge',
  'run_build', 'run_review', 'update_schedule', 'update_todo', 'update_topic_brief', 'watch_todos',
])
/** The host bridge spells `create_todo` as `create_utodo`; map it back. */
function ekkoBase(base) {
  return base.replace(/_u(?=[a-z])/g, '_')
}
/** Tools that are not investigation: talking to the user, plans, memory, schema lookup. */
const META = /^(clarify|ask_u?user|memory|todo|todo_list|tool_search|tool_describe|tool_call|ekko_studio_update_plan|ekko_studio_list_session_tasks|ekko_studio_update_session_tasks|update_plan|send_message)$/

/** 'write' | 'delegate' | 'execute' | 'dispatch' | 'orchestrate' | 'meta' | 'read' (only 'read' counts as investigation) */
export function classifyChiefTool(name) {
  const base = baseToolName(name)
  if (!base) return 'meta'
  if (WRITE.test(base)) return 'write'
  if (DELEGATE.test(base)) return 'delegate'
  if (EXECUTE.test(base)) return 'execute'
  const ekko = ekkoBase(base)
  const raw = String(name || '').toLowerCase()
  if (EKKO_TODO_TOOLS.has(ekko) || EKKO_TODO_TOOLS.has(base) || /(^|__)ekko_todo__/.test(raw)) {
    return DISPATCH.test(ekko) ? 'dispatch' : 'orchestrate'
  }
  if (META.test(base)) return 'meta'
  return 'read'
}

const RANK = { write: 5, delegate: 5, execute: 5, dispatch: 3, read: 2, orchestrate: 1, meta: 1 }

/**
 * Like classifyChiefTool, but sees through wrappers that invoke other tools (Hermes `tool_call` with
 * `calls: [{ name, arguments }]`): the strongest inner category wins, so a dispatch made through the
 * wrapper counts as a dispatch and a terminal call made through it is still refused.
 */
export function classifyChiefToolCall(name, rawArgs = '') {
  const outer = classifyChiefTool(name)
  if (baseToolName(name) !== 'tool_call') return { category: outer, tool: baseToolName(name) }
  const text = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || '')
  const inner = [...text.matchAll(/\\?"name\\?"\s*:\s*\\?"([^"\\]+)\\?"/g)].map(m => m[1])
  let best = { category: outer, tool: 'tool_call' }
  for (const n of inner) {
    const c = classifyChiefTool(n)
    if ((RANK[c] || 0) > (RANK[best.category] || 0)) best = { category: c, tool: baseToolName(n) }
  }
  return best
}

export function isForbiddenChiefCategory(category) {
  return category === 'write' || category === 'delegate' || category === 'execute'
}

// 0.9.63: no read budget and no stopping. Todos keeps its Chief to orchestration by the tools it is given and
// lets it read as much as it needs (repeat reads return only increments); a turn that was cut off midway left the
// user with nothing. A forbidden call is now only flagged to the user, once per tool category per turn.

export function createChiefTurnTracker() {
  return { flagged: new Set(), dispatched: 0, total: 0 }
}

/**
 * Feed one started tool into the tracker. Returns null when the call is fine or was already flagged this turn,
 * otherwise `{ kind: 'forbidden', tool, category }` for a write / delegate / execute call by the Chief.
 * Reading never produces a verdict, however many times it happens.
 */
export function observeChiefTool(tracker, toolName, { rawArgs = '' } = {}) {
  const { category, tool } = classifyChiefToolCall(toolName, rawArgs)
  tracker.total += 1
  if (category === 'dispatch') tracker.dispatched += 1
  if (!isForbiddenChiefCategory(category)) return null
  if (tracker.flagged.has(category)) return null
  tracker.flagged.add(category)
  return { kind: 'forbidden', tool, category }
}

const CATEGORY_LABEL = { write: '直接改文件', delegate: '自己开子代理', execute: '自己跑命令/代码' }

export const CHIEF_GUARD_PREFIX = '提醒：总管'
/** Notices written by 0.9.54–0.9.62, still present in older topics. */
const LEGACY_GUARD_PREFIX = '总管越界，已中止本轮'

/** Notice shown in the topic. The turn keeps running. */
export function formatChiefGuardNotice(verdict) {
  return `${CHIEF_GUARD_PREFIX}调用了 ${verdict?.tool || '工具'}（${CATEGORY_LABEL[verdict?.category] || '越权操作'}）。按约定这类工作应写成任务派给执行 Agent；本轮没有中止，不希望它继续可以点「停止」。`
}

export function isChiefGuardNotice(text) {
  const t = String(text || '')
  return t.startsWith(CHIEF_GUARD_PREFIX + '调用了') || t.startsWith(LEGACY_GUARD_PREFIX)
}

/** Reasoning-effort ladder used to cap the Chief ("" = no cap). */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const DEFAULT_CHIEF_EFFORT_CAP = 'medium'

export function capReasoningEffort(effort, cap) {
  const c = String(cap || '').trim().toLowerCase()
  const e = String(effort || '').trim().toLowerCase()
  if (!c || !EFFORT_ORDER.includes(c)) return effort
  // Unset effort means "engine default", which for several engines is high; pin it to the cap.
  if (!e) return c
  const ei = EFFORT_ORDER.indexOf(e)
  if (ei < 0) return effort
  return ei > EFFORT_ORDER.indexOf(c) ? c : effort
}

// ---- 0.9.62: announce-only turns -------------------------------------------------------------------------
// Real incident (2026-11-25 18:13, model just switched to a smaller one): the Chief answered 「部署进度如何」
// with 「我先查一下 #27 的最新状态。」 — 16 chars, no tool call, finish_reason=stop — and the host ended the
// turn. Its reasoning said the Ekko ToDo tools were deferred and had to be searched first; it never did.
// Same idea as OpenHands' stuck detector "monologue" case and the Worker idle nudge (0.9.57): resume once.

const MCP_PREFIX = 'mcp__ekko_todo__ekko_todo__'
/** Host name of an Ekko ToDo tool behind Hermes tool search: `list_todos` → `mcp__ekko_todo__ekko_todo__list_utodos`. */
export function chiefToolName(name) {
  return MCP_PREFIX + String(name || '').replace(/_/g, '_u')
}

export const CHIEF_ANNOUNCE_MAX_CHARS = 120
export const CHIEF_MAX_ANNOUNCE_NUDGES = 1
// No 我会/我将: those promise later work ("做完我会逐张验收" ended a real status report and was the one false
// positive when every Chief session on the board was scanned).
const ANNOUNCE = /(我先|我去|我来|让我|我马上|马上|稍等|接下来我|下面我|先(去)?(查|看|读|确认|核对|拉|获取)|现在(就)?(去)?(查|看|读|确认|核对|拉|获取)|正在(查|看|读|确认|核对|获取))|\b(let me|i'?ll|i will|i am going to|i'?m going to|checking)\b/i

/**
 * `messages`: the tail of the host transcript. Returns `{ text }` when the current turn (everything after the
 * last user message) made no tool call and ended on a short sentence that only announces what it will do.
 */
export function detectChiefAnnounceOnly(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = -1
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.role === 'user') { start = i; break }
  if (start < 0) return null
  const turn = list.slice(start + 1)
  if (!turn.length) return null
  if (turn.some(m => m?.role === 'tool' || (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0))) return null
  const last = turn[turn.length - 1]
  if (last?.role !== 'assistant') return null
  const text = String(last.content || '').trim()
  if (!text || text.length > CHIEF_ANNOUNCE_MAX_CHARS) return null
  if (/[?？]\s*$/.test(text)) return null
  return ANNOUNCE.test(text) ? { text } : null
}

export const CHIEF_ANNOUNCE_NOTICE_PREFIX = '总管只说了打算、没有执行'

export function formatChiefAnnounceNotice(text) {
  return `${CHIEF_ANNOUNCE_NOTICE_PREFIX}（「${String(text).slice(0, 60)}」后就结束了本轮），已自动让它接着做一次。`
}

export function formatChiefAnnounceNudge(text) {
  return [
    `[系统 · 自动续跑] 你上一轮只回复了「${String(text).slice(0, CHIEF_ANNOUNCE_MAX_CHARS)}」就结束了，没有调用任何工具，用户什么都没拿到。`,
    '现在立刻做你说的事，不要再只说打算。Ekko ToDo 工具是延迟加载的，不必先 tool_search / tool_describe，直接用 tool_call 调完整名，例如：',
    `- 看所有任务状态：${chiefToolName('list_todos')}（参数 {}）`,
    `- 看某个任务的执行输出：${chiefToolName('get_todo_conversation')}（参数 {"todo_id": "td-…"}）`,
    `- 看某个任务的改动：${chiefToolName('get_todo_diff')}（参数 {"todo_id": "td-…"}）`,
    '拿到结果后用中文直接回答用户。如果其实不需要查（通知里已有答案），就直接回答。',
  ].join('\n')
}

// ---- 0.9.63: Ekko ToDo tools not loaded in the Chief session --------------------------------------------
// Seen on another machine: the Web UI wrote the MCP entry but could not hot-reload it into the running agent
// (`WorkerProcess.request() got an unexpected keyword argument 'start_if_needed'`, Web UI newer than the agent).
// Every board call then came back "'mcp__ekko_todo__…' is not a known tool name", the model gave up and the host
// ended the turn with "(empty)". Nothing the Chief can do fixes that, so the user is told what to do.

const NOT_KNOWN = /is not a known tool name/i

/** `messages`: the tail of the host transcript. Returns `{ tool }` when this turn hit an unloaded Ekko ToDo tool. */
export function detectEkkoToolsMissing(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'user' && !/^\[System:/.test(String(list[i]?.content || ''))) { start = i; break }
  }
  for (const m of list.slice(start + 1)) {
    if (m?.role !== 'tool') continue
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
    if (!NOT_KNOWN.test(text)) continue
    // Only a correctly spelled name proves the tools are missing. A misspelt one (`list_agents` for the host's
    // `list_uagents`) also comes back "not known" while the tools are loaded: on this machine all 5 such errors
    // in Chief sessions were misspellings, which the model fixes itself through tool_search.
    for (const m2 of text.matchAll(/(mcp__ekko_todo__ekko_todo__[a-z0-9_]+)/gi)) {
      const name = m2[1]
      const base = ekkoBase(name.slice(MCP_PREFIX.length))
      if (EKKO_TODO_TOOLS.has(base) && chiefToolName(base) === name) return { tool: name }
    }
  }
  return null
}

export const EKKO_TOOLS_MISSING_PREFIX = 'Ekko ToDo 工具没有加载到总管会话'

export function formatEkkoToolsMissingNotice(tool) {
  return `${EKKO_TOOLS_MISSING_PREFIX}（调用 ${String(tool || '').slice(0, 80)} 时宿主回答「不是已知工具」），总管这一轮看不到也操作不了看板。请重启 Hermes Web UI 后再发一次；重启后仍出现，请把 Hermes Agent 更新到与 Web UI 配套的版本。`
}

/** The host persists "(empty)" (or "[SILENT]") when a turn produced no text; that is not a reply. */
export function isHostEmptyPlaceholder(text) {
  const t = String(text || '').trim()
  return t === '' || t === '(empty)' || t === '[SILENT]'
}

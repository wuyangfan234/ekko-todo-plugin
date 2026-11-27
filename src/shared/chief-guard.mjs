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
export const CHIEF_MAX_ANNOUNCE_NUDGES = 2
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

export function formatChiefAnnounceNudge(text, attempt = 1) {
  const lines = [
    `[系统 · 自动续跑] 你上一轮只回复了「${String(text).slice(0, CHIEF_ANNOUNCE_MAX_CHARS)}」就结束了，没有调用任何工具，用户什么都没拿到。`,
    '现在立刻做你说的事，不要再只说打算。Ekko ToDo 工具是延迟加载的，不必先 tool_search / tool_describe，直接用 tool_call 调完整名，例如：',
    `- 看所有任务状态：${chiefToolName('list_todos')}（参数 {}）`,
    `- 看某个任务的执行输出：${chiefToolName('get_todo_conversation')}（参数 {"todo_id": "td-…"}）`,
    `- 看某个任务的改动：${chiefToolName('get_todo_diff')}（参数 {"todo_id": "td-…"}）`,
    '拿到结果后用中文直接回答用户。如果其实不需要查（通知里已有答案），就直接回答。',
  ]
  // 0.9.64: second resume — first action is fixed, so the model has nothing left to plan.
  if (attempt >= 2) lines.push(`这是第 ${attempt} 次续跑：你的第一个动作必须是一次工具调用（不确定查什么就先调 ${chiefToolName('list_todos')}），不能先写文字。`)
  return lines.join('\n')
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

// ---- #105: idle Chief rounds (announce-only or read-only probing without a conclusion) ------------------
// Audit #95 P1-6: detectChiefAnnounceOnly gives up as soon as the turn called any tool, and DESCRIBE_ONLY_LIMIT
// only catches schema reads *in a row inside one turn*. Known incident #22: 101 schema reads, nothing executed.
// A round whose every tool call only reads / probes, and whose reply carries no verifiable conclusion, is now
// an idle round like an announce-only one. Idle rounds are counted per topic (persisted, see db
// setTopicChiefIdle); only a productive round (a dispatch, or a reply with a verifiable conclusion) resets
// the count. Messages, wakes and the automatic resumes themselves never reset it.

/** Consecutive idle Chief rounds that produce a warning in the topic. */
export const CHIEF_IDLE_HINT_AT = 3
/** Consecutive idle Chief rounds that trip the breaker: no automatic resume, the run is stopped, advice is written. */
export const CHIEF_IDLE_BREAK_AT = 4

const READ_ONLY_PROBE = /^(tool_search|tool_describe|read_file|search_files|list_[a-z0-9_]+|inspect_[a-z0-9_]+|get_[a-z0-9_]+)$/

function isReadOnlyBase(name) {
  const base = ekkoBase(baseToolName(name))
  return Boolean(base) && READ_ONLY_PROBE.test(base)
}

/**
 * A read-only / probing tool: tool_search, tool_describe, read_file, search_files, list_*, inspect_*, get_*
 * (MCP prefixes and the host's `_u` spelling are seen through). A `tool_call` wrapper is read-only only when
 * every tool it invokes is; one whose inner names cannot be read is not (nothing is concluded from it).
 */
export function isReadOnlyProbeTool(name, rawArgs = '') {
  if (baseToolName(name) !== 'tool_call') return isReadOnlyBase(name)
  const text = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || '')
  const inner = [...text.matchAll(/\\?"name\\?"\s*:\s*\\?"([^"\\]+)\\?"/g)].map(m => m[1])
  return inner.length > 0 && inner.every(isReadOnlyBase)
}

// A verifiable conclusion cites something that can be checked. #105 review: mentioning what was read is not
// one — a Chief that only read schemas says 「我查看了 3 个工具的 schema」「我看了项目 proj-9af059e7」
// 「我读了 docs/CONTRACTS.md」「#12 待我再确认」, and each of those used to reset the idle count. Kept rules:
const CONCLUSION = [
  // A card with a final or explicit state (not 待 / 进行 / 阶段, which plans use too).
  /#\d+[^\n#]{0,16}?(已完成|已合并|合并(至|进|到)|已通过|审查通过|门禁通过|已失败|构建失败|审查失败|失败了|已关闭|已取消|已打回|被打回|已进入(构建|审查|待合并|关口)|\bphase\s*[=:：]\s*\w+|\b(merged|done|failed|passed|closed)\b)/i,
  // A file reference with a line number (file:line); a bare path is not a conclusion.
  /[\w.~/-]+\.(m?js|cjs|ts|tsx|jsx|json|md|py|sh|ya?ml|toml|css|html|vue|go|rs|sql|lock|txt):\d+/i,
  // A commit sha standing alone (not part of proj-… / agent-… ids) with commit / 提交 / HEAD / 合并 next to it.
  /(commit|提交|\bHEAD\b|合并|\bsha\b)[^\n]{0,12}?(?<![\w-])[0-9a-f]{7,40}(?![\w-])|(?<![\w-])[0-9a-f]{7,40}(?![\w-])[^\n]{0,12}?(commit|提交|\bHEAD\b|合并)/i,
  // An exit code.
  /(\brc|\bexit code|退出码)\s*[=:：]?\s*-?\d+/i,
  // A test result: pass / fail counts, or N tests / 用例 with a verdict.
  /\b(pass|passed|fail|failed|tests?)\s*[=:：]?\s*\d+\b|\b\d+\s*(pass|passed|fail|failed|failing)\b/i,
  /\d+\s*(个|条)?\s*(用例|测试|tests?)[^\n]{0,8}?(全过|全绿|通过|失败|pass|fail)/i,
].map(re => new RegExp(re.source, `${re.flags}g`))

// Command output quoted as a code block counts whatever the prose around it says.
const CODE_BLOCK = /```/

// #110: an identifier inside a sentence about what is still to be done is not a conclusion —
// 「合并 deadbeef 之前我再确认」「等合并 abcdef12 完成后我再派工」「准备去跑 npm test 拿 rc=0」
// 「我会把 #12 已合并的情况再核一遍」 each hit a CONCLUSION rule while reporting nothing. Markers are kept to
// collocations so that past-tense reports survive (「之前的提交 … 已回滚」, 「已进入待合并」, 「等级」,
// 「我先看了日志」 are not markers), and they come in three reaches (#110 review: one reach for all of them
// turned real reports into idle rounds).
const anyOf = list => new RegExp(list.map(re => re.source).join('|'), 'i')

// 「我先看了… / 我去跑了…」: 了 / 过 / 完 within the clause turns the opener into a report of something done.
const DONE_AFTER = '[^，,]{0,12}?(?:了|[跑看查试核读验测做改]过|[跑看查试核读验测做改]完)'
const DONE_OPENER = new RegExp(`我(?:先|去)(?=${DONE_AFTER})`, 'g')

// The speaker's own plan, or a condition: voids a hit in its own clause and in the clauses right before / after.
const INTENT = anyOf([
  /我(?:会|将|再|准备|打算|马上|接着|稍后)/, /让我/, /将(?:要|会|在|于|去|把)/, /即将/,
  // 「我先 / 我去」 only when the clause does not say it was done (「我先看了日志」「我去跑了测试」 are reports).
  new RegExp(`我(?:先|去)(?!${DONE_AFTER})`),
  /准备(?!工作|好了|就绪|完毕)/, /打算/, /稍后/, /接下来/, /下一步/,
  /(?:之前|以前)[，,\s]*(?:我|先|再|还?要|需|得|必须)/,
  /后[，,\s]*我?(?:再|才|即可|就可以)/,
  /先[^，,]{0,24}?再/,
  /再(?:核|确认|查|看|跑|试|验|检查)/, /再[^，,]{0,8}?一(?:遍|下|次)/,
  /才能/, /(?<!不)需要[^，,]{0,24}?(?:后|才|再)/,
  /如果/, /假如/, /一旦/, /要是/,
  /\b(?:will|shall|going to|gonna|about to|plan(?:ning)? to|let me|if)\b/, /\bI'll\b/,
  /\bonce\s+(?:the|it|this|that|we|I|#)/, /(?:^|[,;]\s*)once\b/,
  /\bbefore\s+(?:I|we|merging|running|dispatching|then)\b/,
])

// Waiting on something: voids a hit in its own clause and in the clause after it (「等门禁过，合并 abc1234」),
// not in the clause before it — 「#12 审查通过，等待合并」「测试跑完 rc=0，等你拍板合并」 hand a finished result
// over. Waiting on the user (等你 / 等用户 / 等确认 / 等拍板, 等待合并 / 等待确认) is never a marker.
const WAITING = anyOf([
  /(?:^|[、：:]|[我要需先得须就])\s*等(?![于等级同待你您]|用户|确认|拍板)/,
  /等待(?!合并|拍板|确认|验收|你|您|用户)/, /有待/,
  /待(?:我|总管|验证|校验|核实|核对|检查|执行)/,
])

// A guess or an expectation: voids a hit in its own clause only (「应该会是 rc=0」), so that advice after a
// finding still counts (「根因确认在 src/a.mjs:12，应该改成 x」).
const TENTATIVE = anyOf([/应该/, /应当/, /预计/, /\bshould\b/])

/**
 * True when the clauses around a hit speak of what is still to be done. `own`: the clause(s) the hit sits in;
 * `prev` / `next`: the clauses right before / after it in the same sentence ('' when there is none).
 */
function saysIntent({ prev, own, next }) {
  return INTENT.test(`${prev}，${own}，${next}`) || WAITING.test(prev) || WAITING.test(own) || TENTATIVE.test(own)
}

function clauseSpans(sentence) {
  const spans = []
  let start = 0
  for (const m of sentence.matchAll(/[，,]/g)) { spans.push([start, m.index]); start = m.index + 1 }
  spans.push([start, sentence.length])
  return spans
}

// Sentences end at 。！？!?；; a line break, or an English full stop followed by whitespace / the end of the text
// (so 「3c352dc.」 before a space ends a sentence while the dots of `src/a.mjs` and `v0.9.71` do not).
const SENTENCE_END = /(?:[。！？!?；;\n]|\.(?=\s|$))+/

/**
 * True when the reply carries at least one verifiable conclusion (see CONCLUSION). Tense is judged before the
 * identifier: a hit only counts when saysIntent is false for its clause window (clauses are cut at ，, inside
 * one sentence). Fail-closed: a real result with the speaker's plan in the neighbouring clause
 * (「#97 已合并至 main，我再去派 #98」) does not count until the two are separate sentences.
 */
export function hasVerifiableConclusion(text) {
  const t = String(text || '')
  if (CODE_BLOCK.test(t)) return true
  for (const sentence of t.split(SENTENCE_END)) {
    if (!sentence.trim()) continue
    const spans = clauseSpans(sentence)
    const cut = i => (i < 0 || i >= spans.length ? '' : sentence.slice(spans[i][0], spans[i][1]))
    for (const re of CONCLUSION) {
      for (const m of sentence.matchAll(re)) {
        const end = m.index + m[0].length
        const first = spans.findIndex(([, e]) => m.index <= e)
        let last = spans.findIndex(([, e]) => end <= e)
        if (last < 0) last = spans.length - 1
        const own = sentence.slice(spans[first][0], spans[last][1])
        if (!saysIntent({ prev: cut(first - 1), own, next: cut(last + 1) })) return true
      }
    }
  }
  return false
}

// In a short reply (≤ CHIEF_ANNOUNCE_MAX_CHARS) a sentence that announces the next step is not a conclusion,
// whatever it mentions (「我先查一下 #27 的部署」). #110 review: the other sentences of that reply still are
// (「Merged #12 (commit abc1234). Next I will dispatch #13.」), and 「我先看了日志，问题在 src/a.mjs:12」 opens
// like an announcement but reports what was done. A short announcing reply with a code block stays all-or-nothing.
function withoutAnnouncements(text) {
  const says = s => ANNOUNCE.test(s.replace(DONE_OPENER, ''))
  if (text.length > CHIEF_ANNOUNCE_MAX_CHARS || !says(text)) return text
  if (CODE_BLOCK.test(text)) return ''
  return text.split(SENTENCE_END).filter(s => !says(s)).join('\n')
}

function turnStart(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.role === 'user') return i
  return -1
}

/**
 * `messages`: the tail of the host transcript. Classifies the round that just ended (everything after the last
 * user message):
 *   { kind: 'productive', reason: 'dispatch' | 'conclusion' }
 *   { kind: 'idle', reason: 'announce' | 'read-only', text, tools }   — counts toward the breaker
 *   { kind: 'neutral' }                                                — leaves the count as it is
 * A question to the user, a plain answer without tools and a round with other tools (memory, plans, clarify,
 * a forbidden call) are neutral. A turn whose start is not in view is neutral (nothing is concluded).
 */
export function classifyChiefRound(messages) {
  const list = Array.isArray(messages) ? messages : []
  const start = turnStart(list)
  if (start < 0) return { kind: 'neutral' }
  const turn = list.slice(start + 1)
  if (!turn.length) return { kind: 'neutral' }
  const calls = []
  for (const m of turn) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
    for (const c of m.tool_calls) calls.push({ name: String(c?.function?.name || c?.name || ''), args: c?.function?.arguments ?? c?.arguments ?? '' })
  }
  const lastAssistant = [...turn].reverse().find(m => m?.role === 'assistant' && String(m.content || '').trim())
  const lastText = turn[turn.length - 1]?.role === 'assistant' ? String(turn[turn.length - 1].content || '').trim() : ''
  if (calls.some(c => classifyChiefToolCall(c.name, c.args).category === 'dispatch')) return { kind: 'productive', reason: 'dispatch' }
  // A short sentence that only announces the next step is not a conclusion, whatever it mentions (「我先查一下 #27 的部署」).
  const finalText = String(lastText || lastAssistant?.content || '').trim()
  if (hasVerifiableConclusion(withoutAnnouncements(finalText))) return { kind: 'productive', reason: 'conclusion' }
  if (!calls.length) {
    const hit = detectChiefAnnounceOnly(list)
    return hit ? { kind: 'idle', reason: 'announce', text: hit.text, tools: [] } : { kind: 'neutral' }
  }
  if (/[?？]\s*$/.test(lastText)) return { kind: 'neutral' }
  if (!calls.every(c => isReadOnlyProbeTool(c.name, c.args))) return { kind: 'neutral' }
  const tools = [...new Set(calls.map(c => {
    const inner = baseToolName(c.name) === 'tool_call'
      ? [...String(typeof c.args === 'string' ? c.args : JSON.stringify(c.args || '')).matchAll(/\\?"name\\?"\s*:\s*\\?"([^"\\]+)\\?"/g)].map(m => ekkoBase(baseToolName(m[1])))
      : [ekkoBase(baseToolName(c.name))]
    return inner.join('+')
  }))]
  return { kind: 'idle', reason: 'read-only', text: lastText, tools }
}

export const CHIEF_IDLE_HINT_PREFIX = '提示：总管已连续'
export const CHIEF_IDLE_BREAK_PREFIX = '已熔断：总管连续'
export const CHIEF_RESUME_EXHAUSTED_PREFIX = '本链续跑次数已用尽，需要人工介入'

function idleWhat(verdict) {
  return verdict?.reason === 'read-only'
    ? `只调用只读/查询工具（${(verdict.tools || []).slice(0, 4).join('、') || '查询'}）、没有给出可核验的结论`
    : '只说打算、没有执行'
}

export function formatChiefIdleHint(count, verdict) {
  return `${CHIEF_IDLE_HINT_PREFIX} ${count} 轮没有产出（最近一轮${idleWhat(verdict)}）。再空转 ${Math.max(1, CHIEF_IDLE_BREAK_AT - count)} 轮将熔断：不再自动续跑。`
}

export function formatChiefIdleBreak(count, verdict) {
  return `${CHIEF_IDLE_BREAK_PREFIX} ${count} 轮没有产出（最近一轮${idleWhat(verdict)}），已停止本轮、不再自动续跑。建议：① 直接发一条具体指令（点名卡号和要做的动作，如「对 #12 run_build」）；② 在设置里给总管换一个模型或提高思考等级；③ 若总管一直只查工具说明，检查 Ekko ToDo 工具是否已加载到总管会话。下一轮有产出（派工，或回复里引用具体卡号/文件/命令输出）后计数自动清零。`
}

export function formatChiefResumeExhausted(used, cardLabel = '') {
  return `${CHIEF_RESUME_EXHAUSTED_PREFIX}：总管本链已自动续跑 ${used} 次仍没有产出，不再续跑${cardLabel ? `（关联任务 ${cardLabel}）` : ''}。请发一条具体指令，或在看板上直接处理该任务。`
}

export function formatChiefReadOnlyNudge(verdict, attempt = 1) {
  const lines = [
    `[系统 · 自动续跑] 你上一轮只调用了只读/查询工具（${(verdict?.tools || []).slice(0, 4).join('、') || '查询'}），没有派工，也没有给出可核验的结论，用户什么都没拿到。`,
    '现在直接给出结论（引用具体的卡号与状态、文件、命令输出或测试结果），或者直接调用派工工具（create_todo / run_build / message_todo / merge_build …）。不要再读工具说明。',
  ]
  if (attempt >= 2) lines.push(`这是第 ${attempt} 次续跑：这一轮必须以结论或派工结束。`)
  return lines.join('\n')
}

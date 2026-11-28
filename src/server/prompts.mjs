import { chiefToolName } from '../shared/chief-guard.mjs'
/**
 * Prompt templates for Chief Orchestrator (with Charter + Topic Brief + Memory layers),
 * Isolated Workers (with repo AGENTS.md/CLAUDE.md injection), Independent Reviewers,
 * and Todos-style Automated Wake notices.
 */

function formatMemoryBlock(memories = [], maxChars = 3200) {
  const active = memories.filter(m => m && m.enabled !== false)
  if (!active.length) return ''
  const lines = []
  let used = 0
  for (const m of active) {
    const prefix = m.pinned ? '[置顶]' : `[${m.category || 'convention'}]`
    const scopeTag = m.scope === 'chief' ? '全局' : m.scope === 'project' ? '项目' : 'Agent'
    const entry = `- ${prefix}(${scopeTag}) ${m.title}: ${m.content}`
    if (used + entry.length > maxChars) break
    lines.push(entry)
    used += entry.length + 1
  }
  return lines.join('\n')
}

function formatTopicBrief(brief) {
  if (!brief) return ''
  const lines = []
  if (brief.goal) lines.push(`- Goal: ${brief.goal}`)
  if (brief.progress) lines.push(`- Progress: ${brief.progress}`)
  if (brief.next) lines.push(`- Next: ${brief.next}`)
  if (brief.waitingOnYou) lines.push(`- Waiting on user: ${brief.waitingOnYou}`)
  if (brief.waitingRecommendation) lines.push(`- Chief recommendation: ${brief.waitingRecommendation}`)
  if (brief.blocked) lines.push(`- Blocked: ${brief.blocked}`)
  return lines.join('\n')
}

export function buildChiefInstructions({
  topic,
  projects,
  agents,
  activeTodos,
  chiefAgent,
  settings,
  memories = [],
  hostMemorySnippet = '',
  // #118: true for a topic whose project was never decided; its first card binds it (see PROJECT SCOPE).
  firstCardBinds = false,
}) {
  const projLines = projects.length
    ? projects.map(p => {
        const label = p.displayName ? `${p.displayName} (${p.name})` : p.name
        return `- ${p.id}: ${label} (branch=${p.defaultBranch}, repo=${p.repoPath}${p.githubRepo ? `, github=${p.githubRepo}` : ''}, autoDispatch=${p.autopilot.autoDispatch !== false}, autoAnswer=${p.autopilot.autoAnswerRoutine !== false}, autoMerge=${p.autopilot.autoMergeAfterReview}, deployRedline=${p.autopilot.requireHumanForDeploy})`
      }).join('\n')
    : '- （尚未登记任何项目，用户可直接对话协作、上传文件，也可按需使用 import_github_project 或绑定本地项目目录。）'

  const agentLines = agents
    .map(a => {
      const fbCount = Math.max(0, (a.modelConfigs?.length || 1) - 1)
      return `- ${a.id}: ${a.name} [职责=${a.roleLabel || a.role}, role=${a.role}, engine=${a.engine}/${a.mode}${a.model ? `, model=${a.provider ? `${a.provider}/` : ''}${a.model}` : ''}${a.reasoningEffort ? `, effort=${a.reasoningEffort}` : ''}, fallbacks=${fbCount}, autoFallback=${a.autoFallback}, sandbox=${a.sandboxMode}]`
    })
    .join('\n')

  const ownProject = (projects || []).find(p => p.id && p.id === topic?.projectId) || null
  const todoLines = activeTodos.length
    ? activeTodos.slice(0, 15).map(t => `- #${t.number} (${t.id}) [${t.phase} | wait=${t.gateOwner}/${t.gateKind}] ${t.title}`).join('\n')
    : '- （当前无进行中的任务）'

  const auth = settings?.chiefAuthority || {}
  const charter = String(settings?.charter || '').trim()
  const briefBlock = formatTopicBrief(topic?.brief)
  const memoryBlock = chiefAgent?.memoryEnabled !== false ? formatMemoryBlock(memories, 3600) : ''

  // #123: work on a card that already exists is three calls the Chief makes itself: bind, take over, act.
  // Taking over is never its own idea: only on the user's request, in this topic, for work on that card.
  // #125: and never blind: get_todo_detail first (spec, timeline, the previous topic's messages about the card).
  const readBeforeTakeOver = 'Before taking a card over, call get_todo_detail (todo_id of the card) to read its spec, its timeline and what its previous topic said about it, then decide what to do; never guess from the title.'
  const existingCardChain = `When the user asks, in this topic, for work on an existing card instead of a new one, do three steps yourself: (1) bind this topic with set_topic_project first (to the project of that card); (2) if that card is managed by another topic (run_build or another tool answers TODO_TOPIC_NOT_MANAGER, or the card is shown with another managing topic) and the user did ask this topic to handle it, call watch_todos (topic_id ${topic?.id || ''}, todo_id of the card, take_over: true) to move its management here; (3) then act on the card. ${readBeforeTakeOver} Never take a card over on your own: when the user only mentions the card and has not asked this topic to handle it, do not take it over, only say which topic manages it. Taking a card over makes its previous topic lose every progress notice of that card.`

  const sections = [
    chiefAgent?.systemPrompt || 'You are the Chief Orchestrator inside Ekko ToDo.',
    'Act as the user\'s single point of contact for this topic. Respond in the user\'s language.',
    // #97: a topic handles cards of its own project only; the tools enforce it, this tells the Chief up front.
    ownProject
      ? `PROJECT SCOPE: this topic belongs to project ${ownProject.name} (${ownProject.id}) and handles cards of that project only. list_todos shows that project; every tool that takes todo_id refuses a card of another project (TOPIC_PROJECT_MISMATCH) and names the topic to use. When a tool answers CALLER_AMBIGUOUS (several Chief sessions are running and the call carried no session identity), repeat the same call with caller_topic_id set to this topic's id (${topic.id}), calling the tool directly by its own name: a call made through a tool_call wrapper does not show which tool it is, so caller_topic_id is never accepted there. A card you create for another project is linked to a topic of that project, not to this one: say so to the user and do not follow it up here. When the user says this topic actually belongs to another project, call set_topic_project (topic_id ${topic.id}, project_id of that project, directly by its own name) to rebind it yourself instead of sending the user to the topic menu; it is refused when cards in this topic cannot move with it, and the answer then says what to do. A card of this project that another topic manages is read-only here until the user asks this topic to handle it and you take it over (watch_todos with take_over: true). ${readBeforeTakeOver}`
      : firstCardBinds
        // #118: the first card created here fixes the topic's project. Without this sentence a Chief asks the
        // user to set the project by hand and never creates the card.
        ? `PROJECT SCOPE: this topic has no project yet. The first card you create here fixes it: call create_todo with the correct project_id (the ids are in the project list) and this topic is bound to that project; from then on it handles cards of that project only, and you can dispatch the new card (run_build) in the same turn. Do not ask the user to set the project first. Take the project from what the user asked for; ask the user only when it is unclear which project is meant. Call create_todo directly by its own name and leave topic_id out (or set it to this topic's id, ${topic?.id || ''}): a call made through a tool_call wrapper may not be recognised as coming from this topic, and the card then goes to another topic of its project. You can also bind this topic yourself without creating a card: as soon as you can tell which project the user's request belongs to, call set_topic_project (topic_id ${topic?.id || ''}, project_id from the project list), directly by its own name. ${existingCardChain} Never send the user to the topic menu to set the project. Until a project is set this topic cannot list, dispatch, review or merge any card.`
        // #121: a topic the user detached is not bound by a first card (#118), but its Chief binds it with the tool.
        : `PROJECT SCOPE: this topic has no project, so it cannot list, dispatch, review or merge any card yet, and a card you create here does not bind it. When the user says what to do here, decide which project it belongs to and call set_topic_project (topic_id ${topic?.id || ''}, project_id from the project list), directly by its own name, to bind this topic yourself. ${existingCardChain} Never send the user to the topic menu to set the project; ask the user only when you cannot tell which project is meant.`,
    settings?.chiefStrictOrchestration !== false
      ? [
          'IRON LAW — YOU ARE A DISPATCHER, NOT A WORKER (every violation is reported to the user):',
          '- Your whole job is a five-step loop: understand the intent → write the task spec → dispatch → read the result and accept/reject → report to the user. Nothing else.',
          '- You MUST NOT call write/patch/edit tools, terminal/shell/execute_code, browser automation, or delegate_task/sub-agents — not even for a read-only command like `ls`, `cat` or `git log`. Every such call is shown to the user as a boundary violation.',
          '- Reading to understand the request is your job and has no limit: read documents and code with `read_file` / `search_files`, git state and history with `inspect_project_repo(project_id=...)`, earlier results with `get_todo_conversation` / `get_todo_diff`. Read until you understand the goal; leave fixing, testing and reproducing to the Worker.',
          '- Dispatch rule: as soon as you can state the user\'s goal and how to verify it is done, create the Todo (`create_todo`) and dispatch it (`run_build`) to the project\'s owner agent (`ownerAgentId`). Missing details go into the spec as open questions for the Worker.',
          '- EVERY code change, fix, refactor, branch cleanup, test run, doc edit or deployment is a Todo executed by a Worker in an isolated Git worktree.',
          '- Research / investigation / evaluation / decision memos that need no code change are Todos too: create them with kind="question" (written content: kind="content"). Their deliverable is the Worker\'s final report; no commit is expected and you accept them with complete_todo after reading the report.',
          '- Independent deliverables become separate Todos dispatched together (beyond `maxConcurrentBuilds` they queue and start automatically).',
          '- Keep reasoning short. Routing work needs a clear decision, not a long deliberation; if you notice yourself planning the implementation, stop and put it in the spec instead.',
          '- Spec discipline (4 parts): (1) the user\'s exact words, (2) verified facts with sources, (3) hard constraints / non-goals, (4) open questions. Do NOT invent unrequested requirements.',
          '- Talk to the user only for real decisions or approvals; otherwise keep dispatching and report results briefly.',
        ].join('\n')
      : 'Do not edit project source code directly when a builder agent is available; instead break work into clear todos, dispatch builder agents in isolated Git worktrees via `ekko-todo` MCP tools, verify results, and only interrupt the user when a genuine decision or approval gate requires human input.',
    '',
    `Current Topic: "${topic.title}" (topic_id=${topic.id}, autopilot=${topic.autopilot ? 'ON' : 'OFF'}, userNamed=${topic.isUserNamed})`,
    `Chief Authority: agents=${auth.canConfigureAgents !== false}, models=${auth.canSwitchModels !== false}, memories=${auth.canManageMemories !== false}, projects=${auth.canManageProjects !== false}, concurrency=${auth.canAdjustConcurrency !== false}, strictOrchestration=${settings?.chiefStrictOrchestration !== false}`,
  ]

  if (charter) {
    sections.push('', 'Standing Charter (User-authored team rules — highest priority):', charter.slice(0, 3000))
  }
  if (briefBlock) {
    sections.push('', 'Current Topic Brief:', briefBlock)
  }

  sections.push(
    '',
    'Registered Projects:',
    projLines,
    '',
    'Available Agents:',
    agentLines,
    '',
    'Current Active Todos (the cards THIS topic manages; every card has exactly one managing topic. Other cards of the project are read-only for you: `list_todos` shows them with their managing topic, and acting on them is refused with TODO_TOPIC_NOT_MANAGER. Never take a card over on your own: only when the user, in this topic, explicitly asks for work on such a card, call `watch_todos` with this topic\'s id and `take_over: true`, then act; when the user only mentions the card, only say which topic manages it. Taking a card over makes its previous topic lose every progress notice of that card):',
    todoLines,
  )

  if (memoryBlock) {
    sections.push('', 'Persistent Memories (follow strictly unless user overrides):', memoryBlock)
  }
  if (hostMemorySnippet && auth.injectHostMemory !== false) {
    sections.push('', 'Host Memory Excerpt (read-only reference):', hostMemorySnippet.slice(0, 1200))
  }

  sections.push(
    '',
    'Available MCP tools (`ekko-todo` server — 34 tools):',
    '1. Task orchestration & read-only repo inspection: `list_projects`, `inspect_project_repo` (READ-ONLY git status/branches/unmerged commits/recent log — use this instead of shell!), `list_agents`, `list_todos`, `create_todo`, `update_todo`, `run_build` (auto-queues cleanly into `queued` if concurrency slots are full!), `get_todo_conversation`, `get_todo_diff`, `get_todo_detail` (READ-ONLY: the spec, timeline, managing topic of a card and the topic messages about that card; open to every topic of its project), `run_review`, `ask_user`, `confirm_plan`, `message_todo`, `merge_build`, `retry_merge` (only for a card that stopped in `failed` because its merge failed: puts it back at the merge gate with the review verdict kept; it does not merge), `watch_todos`, `cancel_build`, `complete_todo`.',
    '2. Topic governance & human decision gates: `rename_topic` (give concise title when userNamed=false or requested), `update_topic_brief` (maintain goal/progress/next/waiting_on_you/waiting_recommendation/waiting_options/blocked), `set_topic_project` (bind this topic to a project, or move it to another one, yourself: never ask the user to do it in the topic menu). Whenever you need the user to make a decision or approval without an existing todo, ALWAYS set `waiting_on_you`, a concrete executable `waiting_recommendation` (which is pre-filled as the default decision in the user approval box!), AND 2-4 concise `waiting_options` (or call `ask_user` with `topic_id` & `recommendation`) so an actionable approval card immediately surfaces in the Kanban "待你处理" column.',
    '3. Scheduled recurring/one-shot runs (Todos Schedules parity): `list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule`. Whenever the user explicitly asks to schedule a task (e.g. "每天早上9点跑一次", "每周二检查", "今晚20:00发布"), create the Todo first if needed, call `create_schedule` immediately, and summarize the saved rule (frequency, time, timezone, next run). Never create unrequested schedules without asking first.',
    '4. Chief super-admin configuration: `get_system_config`, `configure_chief`, `configure_agent` (supports custom `role_label`, `role: "custom"`, humanized Notion `avatar` seeds, primary + fallback `model_configs`, `auto_fallback`, and `max_turns`: `0` = unlimited or `1`–`2000`; it is sent with every run, but the current host enforces its own cap from config.yaml `agent.max_turns` instead), `delete_agent`, `configure_project` (supports `display_name` alias & `accent`), `import_github_project`, `list_memories`, `manage_memory`.',
    '5. Whenever the user asks you to create a custom Agent (e.g. for new media, copywriting, research, data analysis, operations, or specialized coding), help them design a clear name, custom `role_label`, tailored `system_prompt`, and suitable engine/model (omit `avatar` to auto-assign a unique fresh Notion portrait), then immediately call `configure_agent` and report the created Agent cleanly.',
    '6. When the user uploads files/images or uses `@AgentName`, read the attached local file paths and honor the user\'s @-mentioned Agent preference when dispatching or configuring.',
    '6. Whenever the user asks to tweak an agent\'s model, fallback chain, reasoning effort, charter, project alias/display name, GitHub repo binding, concurrency limit, or remember/forget a durable rule, apply it immediately via MCP and report exact updated fields.',
    '7. When autopilot is ON and the project permits auto-merge, you may call `confirm_plan` / `merge_build` autonomously after verification; NEVER bypass a locked deployment redline or unanswered human question.',
    '8. Keep replies concise, factual, and formatted in clean Markdown.',
    '9. NEVER busy-wait. Do not run `sleep`, polling loops, or read Ekko ToDo\'s SQLite / plugin-data files to check progress. After `run_build` / `run_review` the todo is watched automatically (nothing else is needed: you are woken only for cards your topic manages), then briefly report status and END your turn — you will be woken automatically when a watched todo reaches a gate, finishes, or fails. Use `list_todos`, `get_todo_conversation`, `get_todo_diff` for on-demand status. Busy-polling is detected and the turn is stopped automatically.',
    '10. Deferred tools (`tool_search` / `tool_describe` / `tool_call`): load a schema ONCE, then act. After one `tool_describe` returns the schema of the tool you need, your very next step must IMMEDIATELY call that tool with real arguments. NEVER describe the same tool twice in one turn — the schema you already received is still valid. NEVER announce a next action (e.g. "现在合并 #18") and then describe again instead of executing it. If a call is refused or you are unsure, say so in one sentence and END your turn; do not repeat the same sentence. Repeating one sentence or reading schemas without executing is detected and the turn is stopped automatically.',
    `11. The Ekko ToDo tools are deferred, but you already know their names: call them straight through \`tool_call\` without searching or describing first — e.g. \`${chiefToolName('list_todos')}\` (args {}), \`${chiefToolName('get_todo_conversation')}\` / \`${chiefToolName('get_todo_diff')}\` (args {"todo_id": "td-…"}). NEVER end a turn on a sentence that only says what you are about to do ("我先查一下…", "让我看看…"): either make the call in the same turn or answer from what the notification already says. Such a turn is detected and resumed automatically.`,
  )

  return sections.join('\n')
}

export function buildWorkerPrompt({ todo, project, withPlan, memories = [], repoGuidelines = '', linkedDeps = [] }) {
  // 0.9.55: research / content cards deliver text; the final reply is collected as the result.
  const textTask = !withPlan && (todo.kind === 'question' || todo.kind === 'content')
  const deployTask = !withPlan && todo.kind === 'deploy'
  const header = withPlan
    ? `Prepare an implementation plan ONLY (do not modify repository files yet) for Todo #${todo.number}: "${todo.title}".`
    : textTask
      ? `Complete ${todo.kind === 'content' ? 'the writing task' : 'the research / investigation task'} Todo #${todo.number}: "${todo.title}".`
      : `Implement Todo #${todo.number}: "${todo.title}".`

  const memBlock = formatMemoryBlock(memories, 1800)

  return [
    header,
    '',
    `Project: ${project.name} (default branch: ${project.defaultBranch}${project.githubRepo ? `, GitHub: ${project.githubRepo}` : ''})`,
    `Isolated Worktree Branch: ${todo.branch}`,
    `Working Directory: ${todo.worktreePath}`,
    linkedDeps.length ? `Bootstrapped local dependencies (symlinked from main repo): ${linkedDeps.join(', ')}` : '',
    project.testCommand ? `Configured Test Gate: ${project.testCommand}` : '',
    '',
    'Task Specification:',
    todo.spec || todo.title,
    todo.plan ? `\nApproved Plan:\n${todo.plan}` : '',
    repoGuidelines ? `\nRepository Guidelines (AGENTS.md / CLAUDE.md):\n${repoGuidelines}` : '',
    memBlock ? `\nProject & Agent Memories:\n${memBlock}` : '',
    '',
    'Execution Rules:',
    '- Work strictly inside the assigned isolated worktree directory.',
    withPlan
      ? '- Produce a concise step-by-step plan listing exact files to edit, edge cases, and verification commands. Stop after presenting the plan.'
      : deployTask
        ? '- This is a deployment task. Commit only if the specification asks for a repository change; a deployment that changes nothing in the repository is a valid result. Actually run the deployment with your tools (do not stop after describing it). Your FINAL reply is collected as the deployment report: target, exact commands run, and the live verification output (HTTP status, version / commit served).'
      : textTask
        ? '- This task does NOT require code changes; do not modify repository files unless the specification explicitly asks for a file. Your FINAL reply is collected verbatim as the deliverable: put the complete findings / text in it (conclusions first, then evidence with sources), not a status line.'
        : '- Implement cleanly, run targeted tests, and report exact changed files, test commands, exit codes, and any caveats.',
    '- If a genuine business fork requires user clarification before proceeding, call `ask_user` on the `ekko-todo` MCP server (or clearly state the blocking question and stop).',
  ].filter(Boolean).join('\n')
}

// #107: the heading under which a follow-up instruction is quoted in the prompt of a new round.
export const FOLLOW_UP_HEADING = '## 本轮追加要求（必须逐条完成）'
export const FOLLOW_UP_REPORT_HEADING = '## 上一轮执行报告（摘要）'
export const FOLLOW_UP_SPEC_HEADING = '## 原任务书（供对照）'
const FOLLOW_UP_REPORT_MAX_CHARS = 3000
// Which entry sent the instruction, by kind (todo_queue kinds).
export const FOLLOW_UP_TRIGGERS = { message: 'message_todo', changes: 'request_changes', answer: 'answer_question', plan: 'confirm_plan' }

/**
 * #107: the prompt of a round that an instruction (message_todo / request_changes) starts on a card that had
 * stopped at a gate. Three parts, all present: the instruction (first, so the stored copy of the prompt on the
 * card shows it), the report of the round before, and the full task prompt (`basePrompt`, buildWorkerPrompt).
 */
export function buildFollowUpPrompt({ todo, basePrompt, message, previousReport = '', trigger = 'message_todo' }) {
  const report = String(previousReport || '').trim()
  const cut = report.length > FOLLOW_UP_REPORT_MAX_CHARS
  return [
    `本轮是 Todo #${todo.number} 的续跑，由 ${trigger} 触发，不是一张新任务：上一轮已停在关口，现在收到了追加要求。`,
    '',
    FOLLOW_UP_HEADING,
    String(message || '').trim(),
    '',
    '执行约定：',
    '- 追加要求必须逐条完成；最终回复里逐条写明每一条做了什么、怎么验证的。做不到的写清原因，不得跳过。',
    '- 不得以「上一轮已经做完」为由不处理追加要求：追加要求就是本轮的工作内容。',
    '- 上一轮已完成、且追加要求没有要求改动的部分不要重做。',
    '',
    FOLLOW_UP_REPORT_HEADING,
    report
      ? `${cut ? report.slice(0, FOLLOW_UP_REPORT_MAX_CHARS) : report}${cut ? `\n…（报告共 ${report.length} 字，此处只引用前 ${FOLLOW_UP_REPORT_MAX_CHARS} 字）` : ''}`
      : '（没有记录到上一轮的报告；以工作树里的实际改动为准。）',
    '',
    FOLLOW_UP_SPEC_HEADING,
    basePrompt,
  ].join('\n')
}

// #77: limits of what the review prompt quotes. Anything cut is announced in the prompt, never silent.
const REVIEW_REPORT_MAX_CHARS = 6000
const REVIEW_DIFF_FILES = 8
const REVIEW_HUNK_MAX_CHARS = 6000
// Build-session replies are stored in todo.buildChat as role '开发 Agent' (orchestrator chatOf); a review
// settle overwrites buildChat with the review session ('审查 Agent'), which is never the worker's report.
const WORKER_CHAT_ROLES = new Set(['开发 Agent', 'assistant'])

/**
 * The build agent's final reply of this round. Priority: `override` (read fresh from the build session at
 * review dispatch) → `evidence.workerReport` (reset at every build dispatch, so it is this round's) →
 * buildChat, searched only after the last '任务指令' entry so an older round's report is never taken.
 */
export function workerFinalReport(todo, override = '') {
  const fresh = String(override ?? '').trim()
  if (fresh) return fresh
  const stored = String(todo?.evidence?.workerReport ?? '').trim()
  if (stored) return stored
  const chat = Array.isArray(todo?.buildChat) ? todo.buildChat : []
  // Only entries after the last instruction belong to this round (-1: no instruction in the window).
  let lastInstruction = -1
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (chat[i]?.role === '任务指令') { lastInstruction = i; break }
  }
  for (let i = chat.length - 1; i > lastInstruction; i -= 1) {
    const entry = chat[i]
    if (!entry || typeof entry !== 'object' || !WORKER_CHAT_ROLES.has(entry.role)) continue
    const text = String(entry.text ?? '').trim()
    if (text) return text
  }
  return ''
}

const REPORT_SOURCE_NOTES = {
  session: "(source: this round's full build-session reply)",
  stored: '(source: stored copy — may be cut at the storage cap; the full report is in the build session)',
  'stored-read-failed': '(source: stored copy — may be cut at the storage cap; the full report is in the build session; reading the build session for this review failed)',
}

/** The report fenced as data, with an explicit end marker so its own headings cannot blur the prompt sections. */
function fencedReport(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}text\n${text}\n${fence}\n--- end of worker report ---`
}

function headTail(text, max) {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n... [truncated ${text.length - max} chars] ...\n${text.slice(text.length - (max - half))}`
}

function reviewDiffPreview(diffs) {
  const list = (Array.isArray(diffs) ? diffs : []).filter(d => d && typeof d === 'object')
  const stat = d => `(+${Number(d.additions) || 0}/-${Number(d.deletions) || 0})`
  const shown = list.slice(0, REVIEW_DIFF_FILES).map(d => {
    const hunk = String(d.hunk ?? '')
    const body = hunk.length > REVIEW_HUNK_MAX_CHARS
      ? `${hunk.slice(0, REVIEW_HUNK_MAX_CHARS)}\n... [hunk truncated, ${hunk.length - REVIEW_HUNK_MAX_CHARS} chars] ...`
      : hunk
    return `### ${String(d.path ?? '(unknown path)')} ${stat(d)}\n\`\`\`diff\n${body}\n\`\`\``
  })
  const rest = list.slice(REVIEW_DIFF_FILES)
  if (rest.length) {
    shown.push(`... and ${rest.length} more changed files (run git diff yourself in the worktree) — files: ${rest.map(d => `${String(d.path ?? '(unknown path)')} ${stat(d)}`).join(', ')}`)
  }
  return shown.join('\n\n')
}

export function buildReviewPrompt({ todo, project, memories = [], workerReport = '', workerReportSource = 'stored' }) {
  const diffPreview = reviewDiffPreview(todo.diffs)
  const report = workerFinalReport(todo, workerReport)
  // A fresh session read is labelled as such only when it is what is quoted; anything else is a stored copy.
  const reportSource = String(workerReport ?? '').trim() && workerReportSource === 'session'
    ? 'session'
    : workerReportSource === 'stored-read-failed' ? 'stored-read-failed' : 'stored'
  const memBlock = formatMemoryBlock(memories, 1200)

  return [
    `Perform an independent READ-ONLY code review for Todo #${todo.number}: "${todo.title}".`,
    'DO NOT edit any files or run destructive commands.',
    '',
    `Project: ${project.name} (base: ${project.defaultBranch}, branch: ${todo.branch}, snapshot: ${todo.snapshotSha || 'HEAD'})`,
    `Test Gate Result: rc=${todo.evidence?.testRc ?? -1} | ${todo.evidence?.testSummary || 'not run'}`,
    '',
    'Task Specification:',
    todo.spec || todo.title,
    memBlock ? `\nRelevant Project & Review Memories:\n${memBlock}` : '',
    '',
    "Worker's Final Report (the build agent's own account of this round — self-reported, verify it, do not trust it):",
    report ? REPORT_SOURCE_NOTES[reportSource] : '',
    report
      ? fencedReport(headTail(report, REVIEW_REPORT_MAX_CHARS))
      : `(none — the build agent delivered no report this round)${reportSource === 'stored-read-failed' ? ' (reading the build session for this review failed)' : ''}`,
    '',
    'Changed Files & Unified Diff:',
    diffPreview || '(No file diffs recorded; inspect the worktree directly if needed.)',
    '',
    'Review Checklist:',
    '1. Functional correctness against specification & edge cases.',
    '2. Regression risk, security boundaries, and test coverage.',
    '3. Do not commit, edit or leave files in the worktree: the merge takes exactly the commit this review started on, and a worktree that changed during the review cannot be merged on your verdict.',
    '4. End your response with an explicit standalone verdict line. It counts only as the very last line, alone on that line: no backticks, quotes, code fence, list marker or added condition (a condition means CHANGES_REQUESTED):',
    '   VERDICT: APPROVED',
    '   or',
    '   VERDICT: CHANGES_REQUESTED',
  ].filter(Boolean).join('\n')
}

// The "Since your last turn" block of a Chief turn: '' when there is nothing to report.
export function formatTodoDigest(rows) {
  const list = Array.isArray(rows) ? rows : []
  return list.length
    ? `Since your last turn:\n${list.map(r => `- #${r.number} ${r.title}: phase=${r.phase} (wait=${r.gate_owner}/${r.gate_kind})`).join('\n')}\n\n`
    : ''
}

export function buildAutomatedWakePrompt({ topic, todo, project, reason, recentDigest }) {
  const digestBlock = formatTodoDigest(recentDigest)

  const autoAuthorized = Boolean(
    topic.autopilot
    && todo.gateKind !== 'deploy'
    && !todo.question?.active
    && (todo.phase === 'review' || todo.phase === 'confirm'),
  )

  const autopilotGuidance = todo.gateKind === 'deliverable'
    ? (autoAuthorized
        ? `Autopilot is ON: this ${todo.kind === 'deploy' ? 'deployment card reported its deployment (no repository change)' : 'research / content card delivered its report'} (above). Check it against the spec; if it answers the task call complete_todo(todo_id="${todo.id}") and report the conclusions to the user, otherwise send what is missing with message_todo(todo_id="${todo.id}", message=...). Do NOT call run_review or merge_build: there is no code change.`
        : `This research / content card delivered its report (above) and waits for the user's acceptance. Summarize the conclusions for the user; do not call merge_build.`)
    : autoAuthorized && todo.gateKind === 'changes'
    ? [
        'Autopilot is ON for this topic: the independent review REQUESTED CHANGES.',
        `The review findings are quoted above (open get_todo_conversation(todo_id="${todo.id}") only if they are cut off), then send concrete rework instructions to the builder with message_todo(todo_id="${todo.id}", message=...).`,
        'Do NOT call merge_build for this todo until a new build passes a fresh run_review with VERDICT: APPROVED.',
      ].join(' ')
    : autoAuthorized
    ? [
        'Autopilot is ON for this topic: this gate is yours to advance without waiting on the user.',
        `The worker's final report is quoted above; check it and the change list with get_todo_diff(todo_id="${todo.id}") (get_todo_conversation only if the report is missing or cut off).`,
        todo.phase === 'confirm'
          ? `If the plan matches the user's goal, call confirm_plan(todo_id="${todo.id}") to start implementation.`
          : project.autopilot.autoMergeAfterReview
            ? `If independent review is not yet approved, call run_review(todo_id="${todo.id}"). If review is already APPROVED and test gate passed, call merge_build(todo_id="${todo.id}") and proceed with any follow-up steps.`
            : `Run independent review via run_review(todo_id="${todo.id}") if not yet done. Note: auto-merge is OFF for ${project.name}, so after review passes, summarize the verified result clearly for the user to approve merge.`,
      ].join(' ')
    : `This item is parked for human attention (${todo.gateKind}) or settled (${todo.phase}). Update the topic brief via update_topic_brief if relevant and summarize concisely for the user.`

  // 0.9.57: a Chief re-dispatched the same failing card seven times in six minutes with nothing changed.
  const failStreak = consecutiveFailedRounds(todo)
  const streakGuidance = todo.phase === 'failed' && failStreak >= 2
    ? `This card has now failed ${failStreak} rounds in a row (last error above). Do NOT call run_build again unchanged: first read the build conversation (get_todo_conversation), then change what caused it (a valid model in configure_agent, a smaller or clearer spec, another agent), or ask the user.`
    : ''

  return [
    digestBlock + 'Automated notice (not typed by the user): a watched todo changed state:',
    `- #${todo.number} "${todo.title}" (todo_id=${todo.id}, project=${project.name}): phase=${todo.phase}, gate=${todo.gateOwner}/${todo.gateKind}, reason=${reason}`,
    todo.evidence?.testSummary ? `- Deterministic test gate: ${todo.evidence.testSummary}` : '',
    todo.evidence?.reviewVerdict && todo.evidence.reviewVerdict !== 'none' ? `- Independent review verdict: ${todo.evidence.reviewVerdict}` : '',
    todo.lastError ? `- Last error: ${todo.lastError}` : '',
    // 0.9.58: hand the sub-agent's own last words back with the notice, so the Chief does not open the
    // whole conversation just to learn what happened (supervisor hand-back).
    todo.gateKind !== 'deliverable' && String(todo.evidence?.workerReport || '').trim()
      ? `- Worker's final report (this round${todo.evidence.workerReport.length >= 3000 ? ', cut at 3000 chars' : ''}):\n${quoteBlock(todo.evidence.workerReport)}`
      : '',
    ['changes_requested', 'approved', 'inconclusive'].includes(todo.evidence?.reviewVerdict) && String(todo.evidence?.reviewSummary || '').trim()
      ? `- Review findings (${todo.evidence.reviewSummary.length >= 1200 ? 'first 1200 chars' : 'full'}):\n${quoteBlock(todo.evidence.reviewSummary)}`
      : '',
    todo.gateKind === 'deliverable' && todo.evidence?.deliverable
      ? `- Deliverable (text task, no code change expected; ${todo.evidence.deliverableChars || todo.evidence.deliverable.length} chars):\n${String(todo.evidence.deliverable).slice(0, 6000)}`
      : '',
    '',
    autopilotGuidance,
    streakGuidance,
  ].filter(Boolean).join('\n')
}

/** Indented so a report's own headings and list markers stay inside the notice item. */
function quoteBlock(text) {
  return String(text).trim().split('\n').map(l => `  > ${l}`).join('\n')
}

/** Failed rounds since the last round that completed (timeline entries written by the settle). */
export function consecutiveFailedRounds(todo) {
  const tl = Array.isArray(todo?.timeline) ? todo.timeline : []
  let n = 0
  for (let i = tl.length - 1; i >= 0; i -= 1) {
    const ev = String(tl[i]?.event || '')
    if (/^(构建完成|成果已交付|部署已执行|已合并|实施方案已生成)/.test(ev)) break
    if (/^(构建失败|启动失败)/.test(ev)) n += 1
  }
  return n
}

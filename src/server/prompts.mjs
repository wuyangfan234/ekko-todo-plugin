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

  const todoLines = activeTodos.length
    ? activeTodos.slice(0, 15).map(t => `- #${t.number} (${t.id}) [${t.phase} | wait=${t.gateOwner}/${t.gateKind}] ${t.title}`).join('\n')
    : '- （当前无进行中的任务）'

  const auth = settings?.chiefAuthority || {}
  const charter = String(settings?.charter || '').trim()
  const briefBlock = formatTopicBrief(topic?.brief)
  const memoryBlock = chiefAgent?.memoryEnabled !== false ? formatMemoryBlock(memories, 3600) : ''

  const sections = [
    chiefAgent?.systemPrompt || 'You are the Chief Orchestrator inside Ekko ToDo.',
    'Act as the user\'s single point of contact across projects. Respond in the user\'s language.',
    settings?.chiefStrictOrchestration !== false
      ? [
          'IRON LAW — YOU ARE A DISPATCHER, NOT A WORKER (enforced at runtime, not optional):',
          '- Your whole job is a five-step loop: understand the intent → write the task spec → dispatch → read the result and accept/reject → report to the user. Nothing else.',
          '- You MUST NOT call write/patch/edit tools, terminal/shell/execute_code, browser automation, or delegate_task/sub-agents. The runtime watches every tool call: the first such call stops your turn on the spot, the call does not take effect, and you are told to dispatch instead. Trying it only wastes a turn.',
          '- Do NOT investigate code yourself. Do not read source files line by line, trace bugs, run tests or reproduce issues — that is the Worker\'s job. For repository state use only the read-only `inspect_project_repo(project_id=...)` tool.',
          '- Dispatch rule: as soon as you can state the user\'s goal and how to verify it is done, create the Todo (`create_todo`) and dispatch it (`run_build`) to the project\'s owner agent (`ownerAgentId`). Missing details go into the spec as open questions for the Worker, not into more research by you. The runtime cuts a turn that keeps reading without dispatching.',
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
    'Current Active Todos:',
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
    'Available MCP tools (`ekko-todo` server — 32 tools):',
    '1. Task orchestration & read-only repo inspection: `list_projects`, `inspect_project_repo` (READ-ONLY git status/branches/unmerged commits/recent log — use this instead of shell!), `list_agents`, `list_todos`, `create_todo`, `update_todo`, `run_build` (auto-queues cleanly into `queued` if concurrency slots are full!), `get_todo_conversation`, `get_todo_diff`, `run_review`, `ask_user`, `confirm_plan`, `message_todo`, `merge_build`, `retry_merge` (only for a card that stopped in `failed` because its merge failed: puts it back at the merge gate with the review verdict kept; it does not merge), `watch_todos`, `cancel_build`, `complete_todo`.',
    '2. Topic governance & human decision gates: `rename_topic` (give concise title when userNamed=false or requested), `update_topic_brief` (maintain goal/progress/next/waiting_on_you/waiting_recommendation/waiting_options/blocked). Whenever you need the user to make a decision or approval without an existing todo, ALWAYS set `waiting_on_you`, a concrete executable `waiting_recommendation` (which is pre-filled as the default decision in the user approval box!), AND 2-4 concise `waiting_options` (or call `ask_user` with `topic_id` & `recommendation`) so an actionable approval card immediately surfaces in the Kanban "待你处理" column.',
    '3. Scheduled recurring/one-shot runs (Todos Schedules parity): `list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule`. Whenever the user explicitly asks to schedule a task (e.g. "每天早上9点跑一次", "每周二检查", "今晚20:00发布"), create the Todo first if needed, call `create_schedule` immediately, and summarize the saved rule (frequency, time, timezone, next run). Never create unrequested schedules without asking first.',
    '4. Chief super-admin configuration: `get_system_config`, `configure_chief`, `configure_agent` (supports custom `role_label`, `role: "custom"`, humanized Notion `avatar` seeds, primary + fallback `model_configs`, `auto_fallback`, and `max_turns` where `0` = unlimited / inherit engine default up to 2000), `delete_agent`, `configure_project` (supports `display_name` alias & `accent`), `import_github_project`, `list_memories`, `manage_memory`.',
    '5. Whenever the user asks you to create a custom Agent (e.g. for new media, copywriting, research, data analysis, operations, or specialized coding), help them design a clear name, custom `role_label`, tailored `system_prompt`, and suitable engine/model (omit `avatar` to auto-assign a unique fresh Notion portrait), then immediately call `configure_agent` and report the created Agent cleanly.',
    '6. When the user uploads files/images or uses `@AgentName`, read the attached local file paths and honor the user\'s @-mentioned Agent preference when dispatching or configuring.',
    '6. Whenever the user asks to tweak an agent\'s model, fallback chain, reasoning effort, charter, project alias/display name, GitHub repo binding, concurrency limit, or remember/forget a durable rule, apply it immediately via MCP and report exact updated fields.',
    '7. When autopilot is ON and the project permits auto-merge, you may call `confirm_plan` / `merge_build` autonomously after verification; NEVER bypass a locked deployment redline or unanswered human question.',
    '8. Keep replies concise, factual, and formatted in clean Markdown.',
    '9. NEVER busy-wait. Do not run `sleep`, polling loops, or read Ekko ToDo\'s SQLite / plugin-data files to check progress. After `run_build` / `run_review` the todo is watched automatically (call `watch_todos` for anything else), then briefly report status and END your turn — you will be woken automatically when a watched todo reaches a gate, finishes, or fails. Use `list_todos`, `get_todo_conversation`, `get_todo_diff` for on-demand status. Busy-polling is detected and the turn is stopped automatically.',
    '10. Deferred tools (`tool_search` / `tool_describe` / `tool_call`): load a schema ONCE, then act. After one `tool_describe` returns the schema of the tool you need, your very next step must IMMEDIATELY call that tool with real arguments. NEVER describe the same tool twice in one turn — the schema you already received is still valid. NEVER announce a next action (e.g. "现在合并 #18") and then describe again instead of executing it. If a call is refused or you are unsure, say so in one sentence and END your turn; do not repeat the same sentence. Repeating one sentence or reading schemas without executing is detected and the turn is stopped automatically.',
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

export function buildReviewPrompt({ todo, project, memories = [] }) {
  const diffPreview = (todo.diffs || [])
    .slice(0, 8)
    .map(d => `### ${d.path} (+${d.additions}/-${d.deletions})\n\`\`\`diff\n${d.hunk}\n\`\`\``)
    .join('\n\n')
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
    'Changed Files & Unified Diff:',
    diffPreview || '(No file diffs recorded; inspect the worktree directly if needed.)',
    '',
    'Review Checklist:',
    '1. Functional correctness against specification & edge cases.',
    '2. Regression risk, security boundaries, and test coverage.',
    '3. End your response with an explicit standalone verdict line:',
    '   VERDICT: APPROVED',
    '   or',
    '   VERDICT: CHANGES_REQUESTED',
  ].filter(Boolean).join('\n')
}

export function buildAutomatedWakePrompt({ topic, todo, project, reason, recentDigest }) {
  const digestBlock = recentDigest.length
    ? `Since your last turn:\n${recentDigest.map(r => `- #${r.number} ${r.title}: phase=${r.phase} (wait=${r.gate_owner}/${r.gate_kind})`).join('\n')}\n\n`
    : ''

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

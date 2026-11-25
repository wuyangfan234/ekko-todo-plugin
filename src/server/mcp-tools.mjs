import { formatScheduleRuleLabel } from './schedule-engine.mjs'

/**
 * Registers 32 MCP tools on the dedicated `ekko-todo` MCP server:
 * - 18 core Todos-grade task orchestration + read-only repo inspection tools
 * - 2 topic governance tools (`rename_topic`, `update_topic_brief`)
 * - 8 Chief Super-Admin tools for full Agent (with primary/fallback chains), Charter, GitHub Project, and Memory governance
 * - 4 Schedules management tools (`list_schedules`, `create_schedule`, `update_schedule`, `delete_schedule`)
 */
export function registerMcpTools(ctx, { db, orchestrator }) {
  if (!ctx.extensions?.tools?.register) return []
  const disposers = []

  const reg = def => {
    disposers.push(ctx.extensions.tools.register(def))
  }

  const assertAuthority = (run, permKey, label) => {
    const settings = db.getSettings(run.identity.userId, run.identity.profile)
    if (settings.chiefAuthority && settings.chiefAuthority[permKey] === false) {
      throw new Error(`总管权限「${label}」已在设置中关闭，如需执行请让用户在「总管与记忆」中开启。`)
    }
    return settings
  }

  // Project autopilot switches enforced server-side for Chief-initiated actions (UI actions are the user's own).
  const assertProjectPolicy = (run, todoId, policy) => {
    const todo = db.getTodo(run.identity.userId, run.identity.profile, todoId)
    if (!todo) return null
    const project = db.getProject(run.identity.userId, run.identity.profile, todo.projectId)
    if (!project) return todo
    if (policy === 'dispatch' && project.autopilot.autoDispatch === false) {
      throw new Error(`项目 ${project.name} 已关闭「允许总管直接派工」，请告诉用户在看板上手动开始 #${todo.number}。`)
    }
    if (policy === 'answer' && todo.question?.active && project.autopilot.autoAnswerRoutine === false) {
      throw new Error(`项目 ${project.name} 已关闭「允许总管代答待确认的问题」，#${todo.number} 的问题需要用户本人答复。`)
    }
    return todo
  }

  reg({
    name: 'list_projects',
    description: 'List all registered Git/GitHub projects, local paths, default branches, test gates, and autopilot policies.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_input, run) {
      const projects = db.listProjects(run.identity.userId, run.identity.profile)
      if (!projects.length) {
        return { ok: true, content: '尚未登记任何项目。请调用 import_github_project 或引导用户添加 Git 仓库。', data: { projects: [] } }
      }
      const lines = projects.map(p => {
        const label = p.displayName ? `${p.displayName} (${p.name})` : p.name
        return `${p.id} | ${label}${p.githubRepo ? ` (${p.githubRepo})` : ''} | branch=${p.defaultBranch} | repo=${p.repoPath} | autoDispatch=${p.autopilot.autoDispatch !== false} | autoAnswer=${p.autopilot.autoAnswerRoutine !== false} | autoMerge=${p.autopilot.autoMergeAfterReview}`
      })
      return { ok: true, content: lines.join('\n'), data: { projects } }
    },
  })

  reg({
    name: 'inspect_project_repo',
    description: 'Read-only Git repository inspection for Chief: returns current branch, HEAD, working-tree cleanliness, recent 12 commits, unmerged local branches, and AGENTS.md/CLAUDE.md guidelines without running shell commands in the repo.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Registered Project ID.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const info = await orchestrator.inspectProjectRepo(run, { projectId: input.project_id })
      const lines = [
        `项目：${info.projectName} (${info.projectId})`,
        `路径：${info.repoPath} · 当前分支：${info.currentBranch} @ ${info.headSha} · 默认分支：${info.defaultBranch}`,
        `工作树状态：${info.isClean ? '干净 (clean)' : `有 ${info.dirtyFiles.length} 项未提交改动`}`,
        info.dirtyFiles.length ? `未提交文件：\n${info.dirtyFiles.slice(0, 15).map(f => `  ${f}`).join('\n')}` : '',
        `未合入分支 (${info.unmergedBranches.length})：${info.unmergedBranches.length ? '\n' + info.unmergedBranches.map(b => `  - ${b.branch} (+${b.aheadCount} commits · ${b.tip})`).join('\n') : '无'}`,
        `最近提交：\n${info.recentCommits.slice(0, 8).map(c => `  ${c}`).join('\n')}`,
      ].filter(Boolean)
      return { ok: true, content: lines.join('\n'), data: info }
    },
  })

  reg({
    name: 'list_agents',
    description: 'List dispatchable agents with custom role labels, avatars, primary/fallback model chains, reasoning effort, failover status, sandbox, and memory settings.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_input, run) {
      const snap = await orchestrator.getSnapshot(run)
      const lines = snap.agents.map(a => {
        const fbCount = Math.max(0, (a.modelConfigs?.length || 1) - 1)
        return `${a.id} | ${a.name} | 职责=${a.roleLabel || a.role}(${a.role}) | engine=${a.engine}/${a.mode} | model=${a.provider ? `${a.provider}/` : ''}${a.model || 'default'} | effort=${a.reasoningEffort || 'default'} | fallbacks=${fbCount}(auto=${a.autoFallback}) | sandbox=${a.sandboxMode}`
      })
      return { ok: true, content: lines.join('\n'), data: { agents: snap.agents, liveEngines: snap.runtime.liveEngines } }
    },
  })

  reg({
    name: 'list_todos',
    description: 'List todos across projects or filter by project_id, topic_id, or phase.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional project ID filter.' },
        topic_id: { type: 'string', description: 'Optional topic ID filter.' },
        phase: { type: 'string', description: 'Optional phase filter (todo/confirm/building/reviewing/review/failed/done/closed).' },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(input, run) {
      const rows = db.listTodos(run.identity.userId, run.identity.profile, {
        projectId: input?.project_id,
        topicId: input?.topic_id,
        phase: input?.phase,
      })
      const lines = rows.map(t => `#${t.number} (${t.id}) [${t.phase} | wait=${t.gateOwner}/${t.gateKind} | ${t.engine}] ${t.title}`)
      return { ok: true, content: lines.join('\n') || '暂无匹配的任务。', data: { count: rows.length, todos: rows.map(r => ({ id: r.id, number: r.number, title: r.title, phase: r.phase, gateOwner: r.gateOwner, gateKind: r.gateKind })) } }
    },
  })

  reg({
    name: 'create_todo',
    description: 'Create a backlog todo in a registered project. Does not start building unless run_build is called.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Target project ID from list_projects.' },
        topic_id: { type: 'string', maxLength: 120, description: 'Optional topic ID to link and watch. When omitted, the topic of the Chief session making this call is used (identified from the caller session, from the Chief session that has just started this tool, or from the Chief run under way). If data.topicResolvedBy in the answer is "unattended", or the answer says that several Chief sessions are running, the caller could not be identified: pass topic_id explicitly.' },
        title: { type: 'string', maxLength: 200, description: 'Actionable todo title (at most 200 characters).' },
        spec: { type: 'string', maxLength: 20000, description: 'Detailed specification with verified facts and constraints (at most 20,000 characters).' },
        kind: { type: 'string', enum: ['feature', 'bug', 'question', 'deploy', 'content'], description: "Task type. Use 'question' for research / investigation / evaluation / decision memos that deliver a written report and need no code change (the worker's final reply is the deliverable; a round without commits is NOT a failure for it). 'content' = written content. When omitted, a research-style title becomes 'question', otherwise 'feature'." },
        with_plan: { type: 'boolean', description: 'If true, worker prepares a plan for confirmation before editing files.' },
        agent_id: { type: 'string', maxLength: 120, description: 'Optional builder agent ID.' },
      },
      required: ['project_id', 'title'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const { todo, topicResolvedBy, topicCandidates = 0 } = await orchestrator.createTodo(run, {
        projectId: input.project_id,
        topicId: input.topic_id || '',
        title: input.title,
        spec: input.spec || '',
        kind: input.kind || '',
        withPlan: Boolean(input.with_plan),
        agentId: input.agent_id || '',
        startImmediately: false,
        actor: 'chief',
      })
      // Said in the answer itself, not only in the topic: a card in a topic without a Chief wakes nobody.
      const unattendedHint = topicResolvedBy === 'unattended'
        ? `\n未能识别调用方话题，卡片挂在没有总管会话的话题 ${todo.topicId}，进展不会唤醒总管。请显式传 topic_id 重新指定。`
        : ''
      // Several Chiefs were running and none could be identified as the caller: the topic is a guess.
      const ambiguousHint = topicResolvedBy === 'active-run' && topicCandidates > 1
        ? `\n当前有 ${topicCandidates} 个总管会话在运行，无法确定建卡归属，请显式传 topic_id。卡片暂挂在话题 ${todo.topicId}（取最近开始的总管运行），可能不是你的话题。`
        : ''
      return {
        ok: true,
        content: `Created #${todo.number} (${todo.id}): ${todo.title}${unattendedHint}${ambiguousHint}`,
        data: { id: todo.id, number: todo.number, phase: todo.phase, topicId: todo.topicId, topicResolvedBy },
      }
    },
  })

  reg({
    name: 'update_todo',
    description: 'Update title, specification, or kind on an existing todo.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Todo ID.' },
        title: { type: 'string', maxLength: 200, description: 'Updated title (at most 200 characters).' },
        spec: { type: 'string', maxLength: 20000, description: 'Updated specification (at most 20,000 characters).' },
        kind: { type: 'string', enum: ['feature', 'bug', 'question', 'deploy', 'content'], description: "Updated task type ('question' = research / no code change, see create_todo)." },
      },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const updated = db.updateTodo(run.identity.userId, run.identity.profile, input.todo_id, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.spec !== undefined ? { spec: input.spec } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
      })
      return { ok: true, content: `Updated #${updated.number} (${updated.id})`, data: { id: updated.id, revision: updated.revision } }
    },
  })

  reg({
    name: 'run_build',
    description: 'Dispatch an agent to execute a todo inside an isolated Git worktree (supports selecting a saved fallback config_id or starting fresh).',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Todo ID to build.' },
        agent_id: { type: 'string', description: 'Optional agent ID override.' },
        config_id: { type: 'string', description: 'Optional model config ID from the agent\'s modelConfigs list.' },
        with_plan: { type: 'boolean', description: 'If true, pause at plan confirmation before coding.' },
        fresh: { type: 'boolean', description: 'If true, discard old worktree and start a fresh build from default branch.' },
      },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      assertProjectPolicy(run, input.todo_id, 'dispatch')
      const todo = await orchestrator.startBuild(run, {
        todoId: input.todo_id,
        agentId: input.agent_id,
        configId: input.config_id,
        withPlan: input.with_plan,
        fresh: Boolean(input.fresh),
      })
      // 0.9.49: the card was deleted while the dispatch waited (a taken-over dispatch answers with the stored card).
      if (!todo) return { ok: true, content: '卡片已不存在，本次派发已丢弃', data: { id: input.todo_id, discarded: true } }
      return {
        ok: true,
        content: `Dispatched #${todo.number} (${todo.id}) on branch ${todo.branch} (${todo.engine}).`,
        data: { id: todo.id, phase: todo.phase, branch: todo.branch, worktreePath: todo.worktreePath, activeConfigId: todo.activeConfigId },
      }
    },
  })

  reg({
    name: 'get_todo_conversation',
    description: 'Read a todo\'s worker/reviewer conversation transcript and latest status.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { todo_id: { type: 'string', description: 'Todo ID.' } },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const todo = db.getTodo(run.identity.userId, run.identity.profile, input.todo_id)
      if (!todo) return { ok: false, content: `Todo not found: ${input.todo_id}`, error: 'NOT_FOUND' }
      const chat = (todo.buildChat || []).map(c => `[${c.time}] ${c.role}: ${c.text}`).join('\n\n')
      return {
        ok: true,
        content: chat || '(No worker messages yet.)',
        data: { id: todo.id, phase: todo.phase, plan: todo.plan, lastError: todo.lastError, fallbackHistory: todo.fallbackHistory },
      }
    },
  })

  reg({
    name: 'get_todo_diff',
    description: 'Capture fresh shadow-index worktree snapshot and return file stats, unified diff, and test gate evidence.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { todo_id: { type: 'string', description: 'Todo ID.' } },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const todo = await orchestrator.refreshTodoDiff(run, { todoId: input.todo_id })
      const summary = [
        `#${todo.number} (${todo.branch} @ ${todo.snapshotSha || 'HEAD'})`,
        `Files: ${todo.evidence.filesChanged} (+${todo.evidence.additions}/-${todo.evidence.deletions})`,
        `Test Gate: rc=${todo.evidence.testRc} | ${todo.evidence.testSummary || 'not run'}`,
        '',
        ...(todo.diffs || []).map(d => `--- ${d.path} (+${d.additions}/-${d.deletions}) ---\n${d.hunk}`),
      ].join('\n')
      return { ok: true, content: summary, data: { evidence: todo.evidence, fileCount: todo.diffs.length } }
    },
  })

  reg({
    name: 'run_review',
    description: 'Dispatch an independent read-only review agent to audit a todo\'s exact diff and test results.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Todo ID to review.' },
        reviewer_agent_id: { type: 'string', description: 'Optional reviewer agent ID.' },
      },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const todo = await orchestrator.runIndependentReview(run, { todoId: input.todo_id, reviewerAgentId: input.reviewer_agent_id })
      if (!todo) return { ok: true, content: '卡片已不存在，本次审查派发已丢弃', data: { id: input.todo_id, discarded: true } }
      return { ok: true, content: `Dispatched independent review for #${todo.number} (${todo.id}).`, data: { id: todo.id, phase: todo.phase } }
    },
  })

    reg({
    name: 'ask_user',
    description: 'Park a todo OR a Chief topic at the human decision gate with a structured multi-choice card (2-4 options, recommendation first) visible in the "待你处理" Kanban column.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Optional Todo ID (for task-level decisions).' },
        topic_id: { type: 'string', description: 'Optional Topic ID (for topic-level decisions when no todo exists yet).' },
        title: { type: 'string', maxLength: 2000, description: 'Clear standalone question (at most 2,000 characters).' },
        why: { type: 'string', maxLength: 2000, description: 'Why this choice matters (at most 2,000 characters).' },
        recommendation: { type: 'string', maxLength: 2000, description: 'Chief concrete recommended decision text, pre-filled directly into the user approval box for one-click confirmation (at most 2,000 characters).' },
        options: {
          type: 'array',
          description: '2-4 concrete options, recommendation first.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 120, description: 'Option key (at most 120 characters).' },
              label: { type: 'string', maxLength: 2000, description: 'Option label (at most 2,000 characters).' },
              recommended: { type: 'boolean', description: 'Whether recommended.' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'options'],
      additionalProperties: false,
    },
    async execute(input, run) {
      if (!input.todo_id && !input.topic_id) {
        return { ok: false, content: '请至少提供 todo_id 或 topic_id 之一。', error: 'MISSING_TARGET' }
      }
      const res = await orchestrator.askUserQuestion(run, {
        todoId: input.todo_id || '',
        topicId: input.topic_id || '',
        title: input.title,
        why: input.why || '',
        recommendation: input.recommendation || '',
        options: input.options,
      })
      if (!input.todo_id) {
        return { ok: true, content: `已在话题 ${input.topic_id} 及看板「待你处理」列发布待批复决策卡片。`, data: res }
      }
      return { ok: true, content: `Posted question card for #${res.number} and parked at human confirmation gate.`, data: { id: res.id, phase: res.phase } }
    },
  })

  reg({
    name: 'confirm_plan',
    description: 'Approve a todo\'s plan at the confirm gate and start full implementation.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Todo ID.' },
        note: { type: 'string', description: 'Optional guidance.' },
      },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      assertProjectPolicy(run, input.todo_id, 'dispatch')
      const todo = await orchestrator.confirmPlan(run, { todoId: input.todo_id, note: input.note || '' })
      if (todo.queued) return { ok: true, content: `Plan confirmation for #${todo.number} is queued: the worker session is busy and gets it when its current turn ends.`, data: { id: todo.id, phase: todo.phase, queued: true } }
      if (todo.duplicate) return { ok: true, content: `#${todo.number}: the same confirmation was already accepted moments ago; nothing was sent again.`, data: { id: todo.id, phase: todo.phase, duplicate: true } }
      if (todo.launchPending) return { ok: true, content: `Confirmed plan for #${todo.number}. The worker run is still starting in the background; do not send it again.`, data: { id: todo.id, phase: todo.phase, starting: true } }
      return { ok: true, content: `Confirmed plan and started build for #${todo.number}.`, data: { id: todo.id, phase: todo.phase } }
    },
  })

  reg({
    name: 'message_todo',
    description: 'Send a follow-up instruction or clarification to a todo\'s worker session.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Todo ID.' },
        message: { type: 'string', description: 'Follow-up instruction.' },
      },
      required: ['todo_id', 'message'],
      additionalProperties: false,
    },
    async execute(input, run) {
      assertProjectPolicy(run, input.todo_id, 'answer')
      const todo = await orchestrator.messageTodo(run, { todoId: input.todo_id, note: input.message, caller: 'chief' })
      // The host can take minutes to accept a run into a busy session; the call does not wait for that.
      if (todo.queued) {
        return { ok: true, content: `Message for #${todo.number} queued: the worker session is busy and gets it when its current turn ends. Do not send it again.`, data: { id: todo.id, phase: todo.phase, accepted: true, starting: false, queued: true } }
      }
      if (todo.duplicate) {
        return { ok: true, content: `#${todo.number}: the same message was already accepted moments ago; nothing was sent again.`, data: { id: todo.id, phase: todo.phase, accepted: true, starting: Boolean(todo.launchPending), duplicate: true } }
      }
      if (todo.launchPending) {
        return { ok: true, content: `Message for #${todo.number} accepted. The worker run is still starting in the background; do not send it again. The card timeline shows whether it was delivered.`, data: { id: todo.id, phase: todo.phase, accepted: true, starting: true } }
      }
      return { ok: true, content: `Sent message to #${todo.number} and resumed execution.`, data: { id: todo.id, phase: todo.phase, accepted: true, starting: false } }
    },
  })

  reg({
    name: 'merge_build',
    description: 'Merge a verified todo worktree branch into the project default branch and clean up the worktree.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Todo ID.' },
        commit_message: { type: 'string', description: 'Optional merge commit message.' },
      },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      let todo
      try {
        todo = await orchestrator.mergeBuild(run, {
          todoId: input.todo_id,
          commitMessage: input.commit_message || '',
          caller: 'chief',
          asyncMode: false,
        })
      } catch (err) {
        return { ok: false, content: err?.message || String(err), error: 'MERGE_REFUSED' }
      }
      return { ok: true, content: `Merged #${todo.number} (${todo.snapshotSha}) and marked done.`, data: { id: todo.id, phase: todo.phase, commitSha: todo.snapshotSha } }
    },
  })

  reg({
    name: 'retry_merge',
    description: 'Put a todo whose merge failed back at the merge gate, keeping its review verdict, branch and worktree (no rebuild, no second review). 仅当卡片因合并失败而停在 failed 时可用：phase=failed 且 lastError 以「合并失败」开头、任务分支与工作树仍在。构建失败、没有产出的任务不适用，请用 run_build。It does not merge: fix the cause first (resolve the conflict on the task branch, or clean the main checkout), call retry_merge, then merge_build, which runs all of its checks again.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { todo_id: { type: 'string', description: 'Todo ID.' } },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      let todo
      try {
        todo = await orchestrator.retryMerge(run, { todoId: input.todo_id, caller: 'chief' })
      } catch (err) {
        return { ok: false, content: err?.message || String(err), error: 'RETRY_MERGE_REFUSED' }
      }
      const verdict = todo.evidence?.reviewVerdict || 'none'
      return {
        ok: true,
        content: `#${todo.number} is back at the merge gate (review verdict kept: ${verdict}; gate held by ${todo.gateOwner}). Nothing was merged: call merge_build, or hand it to the user when the gate is theirs.`,
        data: { id: todo.id, phase: todo.phase, gateOwner: todo.gateOwner, reviewVerdict: verdict },
      }
    },
  })

  reg({
    name: 'watch_todos',
    description: 'Subscribe a topic to wake automatically when a todo reaches a gate or settles.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: 'Topic ID.' },
        todo_id: { type: 'string', description: 'Todo ID.' },
        reason: { type: 'string', description: 'Why watching.' },
      },
      required: ['topic_id', 'todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      db.watchTodo(run.identity.userId, run.identity.profile, input.topic_id, input.todo_id, input.reason || 'Watched by chief')
      return { ok: true, content: `Watching ${input.todo_id} from topic ${input.topic_id}.` }
    },
  })

  reg({
    name: 'cancel_build',
    description: 'Stop an active build/review session and return the todo to a resting state.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Todo ID.' },
        discard: { type: 'boolean', description: 'If true, remove the isolated worktree and branch.' },
      },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const todo = await orchestrator.cancelBuild(run, { todoId: input.todo_id, discard: Boolean(input.discard) })
      if (!todo) return { ok: true, content: '卡片已不存在，本次停止已丢弃', data: { id: input.todo_id, discarded: true } }
      return { ok: true, content: `Cancelled #${todo.number} (phase=${todo.phase}).`, data: { id: todo.id, phase: todo.phase } }
    },
  })

  reg({
    name: 'complete_todo',
    description: 'Mark a non-code or already accepted todo as done.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { todo_id: { type: 'string', description: 'Todo ID.' } },
      required: ['todo_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const todo = await orchestrator.completeTodo(run, { todoId: input.todo_id })
      if (!todo) return { ok: true, content: '卡片已不存在，本次标记完成已丢弃', data: { id: input.todo_id, discarded: true } }
      return { ok: true, content: `Completed #${todo.number}.`, data: { id: todo.id, phase: todo.phase } }
    },
  })

  // ===== 2 TOPIC GOVERNANCE TOOLS =====

  reg({
    name: 'rename_topic',
    description: 'Rename a Chief topic concisely (never overwrites a user-named topic unless force=true per user request).',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: 'Topic ID.' },
        title: { type: 'string', maxLength: 160, description: 'Concise topic title (4-14 Chinese chars or 2-5 English words; at most 160 characters).' },
        force: { type: 'boolean', description: 'Set true only when the user explicitly asked to rename.' },
      },
      required: ['topic_id', 'title'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const cur = db.getTopic(run.identity.userId, run.identity.profile, input.topic_id)
      if (!cur) return { ok: false, content: `Topic not found: ${input.topic_id}`, error: 'NOT_FOUND' }
      if (cur.isUserNamed && !input.force) {
        return { ok: true, content: `保留用户手动命名的话题标题「${cur.title}」。` }
      }
      await orchestrator.renameTopic(run, { topicId: input.topic_id, title: input.title, isUserNamed: Boolean(input.force) })
      return { ok: true, content: `已更新话题标题为「${input.title}」` }
    },
  })

  reg({
    name: 'update_topic_brief',
    description: 'Update the structured Topic Brief card (goal, progress, next, waiting_on_you, waiting_options, blocked). Any non-empty waiting_on_you automatically surfaces as an actionable approval card in the Kanban "待你处理" column.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        topic_id: { type: 'string', description: 'Topic ID.' },
        goal: { type: 'string', maxLength: 2000, description: 'Concise overall goal of the topic.' },
        progress: { type: 'string', maxLength: 2000, description: 'What is currently running or accomplished.' },
        next: { type: 'string', maxLength: 2000, description: 'Planned next step.' },
        waiting_title: { type: 'string', maxLength: 2000, description: 'Optional short headline for the pending user decision.' },
        waiting_on_you: { type: 'string', maxLength: 2000, description: 'Genuine blockers requiring the user\'s decision/approval (empty string clears it). Automatically appears in Kanban "待你处理".' },
        waiting_recommendation: { type: 'string', maxLength: 2000, description: 'Chief concrete recommended decision text, pre-filled directly into the user approval box so the user can confirm in one click or tweak it.' },
        waiting_options: {
          type: 'array',
          description: 'Optional 2-4 concise decision buttons so the user can approve in one click.',
          items: { type: 'string', maxLength: 2000 },
        },
        blocked: { type: 'string', maxLength: 2000, description: 'Waiting on an agent, external dependency, or another topic.' },
      },
      required: ['topic_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const patch = {}
      if (input.goal !== undefined) patch.goal = String(input.goal)
      if (input.progress !== undefined) patch.progress = String(input.progress)
      if (input.next !== undefined) patch.next = String(input.next)
      if (input.waiting_title !== undefined) patch.waitingTitle = String(input.waiting_title)
      if (input.waiting_on_you !== undefined) patch.waitingOnYou = String(input.waiting_on_you)
      if (input.waiting_recommendation !== undefined) patch.waitingRecommendation = String(input.waiting_recommendation)
      if (input.waiting_options !== undefined) patch.waitingOptions = input.waiting_options
      if (input.blocked !== undefined) patch.blocked = String(input.blocked)
      await orchestrator.updateTopicMeta(run, { topicId: input.topic_id, brief: patch })
      return { ok: true, content: `已更新话题 ${input.topic_id} 的主题简报。` }
    },
  })

  // ===== 8 CHIEF SUPER-ADMIN CONFIGURATION & MEMORY TOOLS =====

  reg({
    name: 'get_system_config',
    description: 'Inspect complete Ekko ToDo configuration: Chief settings, Charter, authority flags, Agents with primary/fallback model chains, projects, enabled memories, and live engines.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute(_input, run) {
      const snap = await orchestrator.getSnapshot(run)
      const chief = snap.agents.find(a => a.id === snap.settings.chiefAgentId) || snap.agents[0]
      const lines = [
        `Chief: ${chief?.name || 'none'} (${chief?.id || ''}) · engine=${chief?.engine || ''} · model=${chief?.model || 'default'} · effort=${chief?.reasoningEffort || 'default'} · fallbacks=${Math.max(0, (chief?.modelConfigs?.length || 1) - 1)}`,
        `Concurrency: ${snap.concurrency.active}/${snap.concurrency.limit}`,
        `Charter: ${snap.settings.charter ? `${snap.settings.charter.length} chars` : 'empty'}`,
        `Authority: ${JSON.stringify(snap.settings.chiefAuthority)}`,
        `Agents (${snap.agents.length}): ${snap.agents.map(a => `${a.name}[${a.id}:${a.engine}/${a.model || 'default'}/${a.reasoningEffort || 'default'}+${Math.max(0, (a.modelConfigs?.length || 1) - 1)}fb]`).join(', ')}`,
        `Projects (${snap.projects.length}): ${snap.projects.map(p => `${p.name}[${p.id}${p.githubRepo ? `:${p.githubRepo}` : ''}]`).join(', ') || 'none'}`,
        `Memories (${snap.memories.length}, enabled=${snap.counts.memories})`,
      ]
      return {
        ok: true,
        content: lines.join('\n'),
        data: {
          settings: snap.settings,
          agents: snap.agents,
          projects: snap.projects,
          memories: snap.memories,
          liveEngines: snap.runtime.liveEngines,
        },
      }
    },
  })

  reg({
    name: 'configure_chief',
    description: 'Chief super-admin: update Chief agent binding, primary/fallback model configs, reasoning effort, Charter, memory injection, concurrency limit, or clone root.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        chief_agent_id: { type: 'string', maxLength: 120, description: 'Optional agent ID to bind as Chief (at most 120 characters).' },
        engine: { type: 'string', description: 'Optional primary engine ID.' },
        mode: { type: 'string', enum: ['global', 'scoped'], description: 'Optional launch mode.' },
        provider: { type: 'string', maxLength: 160, description: 'Optional provider key.' },
        model: { type: 'string', maxLength: 240, description: 'Optional model ID.' },
        api_mode: { type: 'string', maxLength: 60, description: 'Optional wire API mode.' },
        base_url: { type: 'string', maxLength: 500, description: 'Optional custom gateway base URL.' },
        custom_model: { type: 'boolean', description: 'Mark model as custom manual entry.' },
        reasoning_effort: { type: 'string', maxLength: 40, description: 'Reasoning effort level.' },
        model_configs: { type: 'array', description: 'Ordered primary + fallback run configurations (max 8).', items: { type: 'object', properties: {}, required: [], additionalProperties: true } },
        auto_fallback: { type: 'boolean', description: 'Enable automatic failover to next model config on provider fault.' },
        memory_enabled: { type: 'boolean', description: 'Enable/disable persistent memory injection for Chief.' },
        charter: { type: 'string', maxLength: 20000, description: 'Standing team Charter instructions injected into Chief every turn (at most 20,000 characters).' },
        system_prompt: { type: 'string', description: 'Updated Chief system prompt.' },
        max_concurrent_builds: { type: 'integer', description: 'Max concurrent worktree builds (1-8).' },
        default_clone_root: { type: 'string', maxLength: 1000, description: 'Default local directory for GitHub clones (at most 1,000 characters).' },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(input, run) {
      if (input.model !== undefined || input.provider !== undefined || input.reasoning_effort !== undefined || input.engine !== undefined || input.model_configs !== undefined) {
        assertAuthority(run, 'canSwitchModels', '切换模型与思考等级')
      }
      if (input.max_concurrent_builds !== undefined) {
        assertAuthority(run, 'canAdjustConcurrency', '调整并发上限')
      }
      const next = await orchestrator.quickConfigureChief(run, {
        chiefAgentId: input.chief_agent_id,
        engine: input.engine,
        mode: input.mode,
        provider: input.provider,
        model: input.model,
        apiMode: input.api_mode,
        baseUrl: input.base_url,
        customModel: input.custom_model,
        reasoningEffort: input.reasoning_effort,
        modelConfigs: input.model_configs,
        autoFallback: input.auto_fallback,
        memoryEnabled: input.memory_enabled,
        charter: input.charter,
        systemPrompt: input.system_prompt,
        maxConcurrentBuilds: input.max_concurrent_builds,
        defaultCloneRoot: input.default_clone_root,
      })
      const chief = next.agents.find(a => a.id === next.settings.chiefAgentId) || next.agents[0]
      return {
        ok: true,
        content: `已更新总管配置：${chief.name} (${chief.engine}/${chief.model || 'default'} · effort=${chief.reasoningEffort || 'default'} · 备选=${Math.max(0, (chief.modelConfigs?.length || 1) - 1)} · 并发=${next.settings.maxConcurrentBuilds})`,
        data: { chief, settings: next.settings },
      }
    },
  })

  reg({
    name: 'configure_agent',
    description: 'Chief super-admin: create or update any agent\'s custom role label (`role_label`), avatar preset (`avatar`), primary & fallback model chain (`model_configs`), automatic failover (`auto_fallback`), reasoning effort, approval policy, sandbox, memory flag, and system prompt.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', maxLength: 120, description: 'Existing agent ID to update; omit to create a new agent (at most 120 characters).' },
        name: { type: 'string', description: 'Agent display name.' },
        role: { type: 'string', enum: ['chief', 'builder', 'reviewer', 'qa', 'custom'], description: 'Execution capability role type (use custom for non-coding roles like new media, copywriting, research).' },
        role_label: { type: 'string', description: 'Custom human-facing role title (e.g. 新媒体运营, 文案主笔, 产品策划, 数据分析, 开发执行).' },
        avatar: { type: 'string', description: 'Optional humanized Notion avatar seed (e.g. notion:designer-01); omit to auto-generate a unique portrait.' },
        description: { type: 'string', description: 'Short role summary.' },
        engine: { type: 'string', description: 'Primary engine ID.' },
        mode: { type: 'string', enum: ['global', 'scoped'], description: 'Primary launch mode.' },
        provider: { type: 'string', maxLength: 160, description: 'Optional provider key.' },
        model: { type: 'string', maxLength: 240, description: 'Optional model ID.' },
        api_mode: { type: 'string', maxLength: 60, description: 'Optional wire API mode.' },
        base_url: { type: 'string', maxLength: 500, description: 'Optional custom gateway base URL.' },
        custom_model: { type: 'boolean', description: 'Whether model ID is custom.' },
        reasoning_effort: { type: 'string', maxLength: 40, description: 'Reasoning effort level.' },
        model_configs: { type: 'array', description: 'Ordered array of primary (index 0) and fallback (index 1..7) model configs.', items: { type: 'object', properties: {}, required: [], additionalProperties: true } },
        auto_fallback: { type: 'boolean', description: 'Auto-switch to next fallback config when model/provider fails.' },
        approval_policy: { type: 'string', enum: ['never', 'on-failure', 'on-request', 'untrusted'], description: 'Approval policy.' },
        sandbox_mode: { type: 'string', enum: ['read-only', 'workspace-write', 'full-access'], description: 'Filesystem sandbox mode.' },
        memory_enabled: { type: 'boolean', description: 'Inject Ekko ToDo memories into this agent.' },
        max_turns: { type: 'integer', description: 'Max agent turns: 0 = unlimited / inherit engine default (e.g. Hermes 500), or explicit 1-2000.' },
        system_prompt: { type: 'string', description: 'Agent system instructions.' },
        read_only: { type: 'boolean', description: 'Strict read-only flag.' },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(input, run) {
      assertAuthority(run, 'canConfigureAgents', '配置 Agent')
      if (input.model !== undefined || input.provider !== undefined || input.reasoning_effort !== undefined || input.model_configs !== undefined) {
        assertAuthority(run, 'canSwitchModels', '切换模型与思考等级')
      }
      const { agent } = await orchestrator.saveAgent(run, {
        id: input.agent_id || '',
        name: input.name,
        role: input.role,
        roleLabel: input.role_label,
        avatar: input.avatar,
        description: input.description,
        engine: input.engine,
        mode: input.mode,
        provider: input.provider,
        model: input.model,
        apiMode: input.api_mode,
        baseUrl: input.base_url,
        customModel: input.custom_model,
        reasoningEffort: input.reasoning_effort,
        modelConfigs: input.model_configs,
        autoFallback: input.auto_fallback,
        approvalPolicy: input.approval_policy,
        sandboxMode: input.sandbox_mode,
        memoryEnabled: input.memory_enabled,
        maxTurns: input.max_turns,
        systemPrompt: input.system_prompt,
        readOnly: input.read_only,
      })
      return {
        ok: true,
        content: `已保存 Agent「${agent.name}」(${agent.id}, 职责=${agent.roleLabel}): ${agent.engine}/${agent.model || 'default'} · effort=${agent.reasoningEffort || 'default'} · 备选=${Math.max(0, agent.modelConfigs.length - 1)} · autoFallback=${agent.autoFallback}`,
        data: { agent },
      }
    },
  })

  reg({
    name: 'delete_agent',
    description: 'Chief super-admin: remove an agent from configuration.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: 'Agent ID to delete.' } },
      required: ['agent_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      assertAuthority(run, 'canConfigureAgents', '配置 Agent')
      await orchestrator.removeAgent(run, input.agent_id)
      return { ok: true, content: `已删除 Agent ${input.agent_id}` }
    },
  })

  reg({
    name: 'configure_project',
    description: 'Chief super-admin: update an existing project\'s display alias (`display_name`), accent color, GitHub binding, default branch, test gate, assigned agents, or autopilot policy.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID.' },
        name: { type: 'string', maxLength: 120, description: 'Repository base name.' },
        display_name: { type: 'string', description: 'Friendly display alias shown in sidebar and Kanban (e.g. Web Portal).' },
        accent: { type: 'string', enum: ['blue', 'amber', 'emerald', 'violet', 'rose', 'teal'], description: 'Project badge accent color.' },
        repo_path: { type: 'string', maxLength: 1000, description: 'Local Git repository path.' },
        github_repo: { type: 'string', maxLength: 200, description: 'GitHub owner/repo.' },
        default_branch: { type: 'string', maxLength: 120, description: 'Base branch.' },
        test_command: { type: 'string', maxLength: 500, description: 'Deterministic pre-gate test command.' },
        owner_agent_id: { type: 'string', maxLength: 120, description: 'Default builder agent ID.' },
        reviewer_agent_id: { type: 'string', maxLength: 120, description: 'Default reviewer agent ID.' },
        auto_dispatch: { type: 'boolean', description: 'Allow auto dispatch.' },
        auto_answer_routine: { type: 'boolean', description: 'Allow answering routine clarifications.' },
        auto_merge_after_review: { type: 'boolean', description: 'Allow auto-merge after review approval.' },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      assertAuthority(run, 'canManageProjects', '管理项目与仓库')
      const autopilot = {}
      if (input.auto_dispatch !== undefined) autopilot.autoDispatch = Boolean(input.auto_dispatch)
      if (input.auto_answer_routine !== undefined) autopilot.autoAnswerRoutine = Boolean(input.auto_answer_routine)
      if (input.auto_merge_after_review !== undefined) autopilot.autoMergeAfterReview = Boolean(input.auto_merge_after_review)
      const { project } = await orchestrator.updateProject(run, {
        id: input.project_id,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
        ...(input.accent !== undefined ? { accent: input.accent } : {}),
        ...(input.repo_path !== undefined ? { repoPath: input.repo_path } : {}),
        ...(input.github_repo !== undefined ? { githubRepo: input.github_repo } : {}),
        ...(input.default_branch !== undefined ? { defaultBranch: input.default_branch } : {}),
        ...(input.test_command !== undefined ? { testCommand: input.test_command } : {}),
        ...(input.owner_agent_id !== undefined ? { ownerAgentId: input.owner_agent_id } : {}),
        ...(input.reviewer_agent_id !== undefined ? { reviewerAgentId: input.reviewer_agent_id } : {}),
        ...(Object.keys(autopilot).length ? { autopilot } : {}),
      })
      const label = project.displayName ? `${project.displayName} (${project.name})` : project.name
      return { ok: true, content: `已更新项目 ${label} (${project.id})`, data: { project } }
    },
  })

  reg({
    name: 'import_github_project',
    description: 'Chief super-admin: import a GitHub repository (clone into a local directory or link an existing local checkout) and register it in Ekko ToDo with an optional display alias.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        github_repo: { type: 'string', description: 'GitHub repo identifier (`owner/repo` or HTTPS/SSH URL).' },
        mode: { type: 'string', enum: ['link', 'clone'], description: '`link` associates an existing local directory; `clone` clones into clone_parent_dir.' },
        repo_path: { type: 'string', description: 'Existing local Git repository path (for mode=link).' },
        clone_parent_dir: { type: 'string', description: 'Local parent directory to clone into (for mode=clone).' },
        name: { type: 'string', description: 'Optional repository name.' },
        display_name: { type: 'string', description: 'Optional friendly display alias (e.g. Web Portal).' },
        default_branch: { type: 'string', description: 'Optional base branch.' },
        test_command: { type: 'string', description: 'Optional deterministic test command.' },
      },
      required: ['github_repo', 'mode'],
      additionalProperties: false,
    },
    async execute(input, run) {
      assertAuthority(run, 'canManageProjects', '管理项目与仓库')
      const { project } = await orchestrator.importGithubProject(run, {
        githubRepo: input.github_repo,
        mode: input.mode,
        repoPath: input.repo_path || '',
        cloneParentDir: input.clone_parent_dir || '',
        name: input.name || '',
        displayName: input.display_name || '',
        defaultBranch: input.default_branch || '',
        testCommand: input.test_command || '',
      })
      const label = project.displayName ? `${project.displayName} (${project.name})` : project.name
      return {
        ok: true,
        content: `已导入并关联 GitHub 项目 ${label} (${project.githubRepo || project.remoteUrl}) -> ${project.repoPath}`,
        data: { project },
      }
    },
  })

  reg({
    name: 'list_memories',
    description: 'List persistent Ekko ToDo memories filtered by scope (chief/project/agent), category, or search query.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'chief', 'project', 'agent'], description: 'Memory scope filter.' },
        scope_id: { type: 'string', description: 'Optional project_id or agent_id.' },
        category: { type: 'string', enum: ['all', 'preference', 'convention', 'architecture', 'pitfall', 'decision'], description: 'Category filter.' },
        query: { type: 'string', description: 'Optional keyword search.' },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(input, run) {
      const items = db.listMemories(run.identity.userId, run.identity.profile, {
        scope: input?.scope || 'all',
        scopeId: input?.scope_id || '',
        category: input?.category || 'all',
        query: input?.query || '',
      })
      const lines = items.map(m => `${m.id} | ${m.pinned ? '[置顶]' : ''}[${m.scope}/${m.category}] ${m.title}: ${m.content} (${m.enabled ? '启用' : '停用'})`)
      return { ok: true, content: lines.join('\n') || '暂无记忆条目。', data: { memories: items } }
    },
  })

  reg({
    name: 'manage_memory',
    description: 'Chief super-admin: create, update, pin/unpin, enable/disable, or delete a persistent memory entry.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['upsert', 'delete'], description: 'Action to perform.' },
        memory_id: { type: 'string', maxLength: 120, description: 'Memory ID (required for delete; optional for upsert to update existing).' },
        scope: { type: 'string', enum: ['chief', 'project', 'agent'], description: 'Memory scope.' },
        scope_id: { type: 'string', maxLength: 120, description: 'Target project_id or agent_id when scope is project/agent.' },
        category: { type: 'string', enum: ['preference', 'convention', 'architecture', 'pitfall', 'decision'], description: 'Memory category.' },
        title: { type: 'string', maxLength: 160, description: 'Concise memory title (at most 160 characters).' },
        content: { type: 'string', maxLength: 4000, description: 'Durable fact, preference, convention, or pitfall (at most 4,000 characters).' },
        pinned: { type: 'boolean', description: 'Pin memory to top of prompt injection.' },
        enabled: { type: 'boolean', description: 'Whether memory is active.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(input, run) {
      assertAuthority(run, 'canManageMemories', '读写持久记忆')
      if (input.action === 'delete') {
        if (!input.memory_id) return { ok: false, content: '删除记忆需要提供 memory_id', error: 'INVALID_INPUT' }
        await orchestrator.removeMemory(run, input.memory_id)
        return { ok: true, content: `已删除记忆 ${input.memory_id}` }
      }
      const { memory } = await orchestrator.saveMemory(run, {
        id: input.memory_id || '',
        scope: input.scope || 'chief',
        scopeId: input.scope_id || '',
        category: input.category || 'convention',
        title: input.title,
        content: input.content,
        pinned: input.pinned,
        enabled: input.enabled,
        source: 'chief',
      })
      return {
        ok: true,
        content: `已保存记忆「${memory.title}」(${memory.id} · ${memory.scope}/${memory.category})`,
        data: { memory },
      }
    },
  })

  /* ---------- v0.8.0: Schedules Management Tools (4 tools -> 32 MCP tools) ---------- */

  reg({
    name: 'list_schedules',
    description: 'List all configured recurring or one-shot task schedules (hourly/daily/weekly/once) with next run time and last outcome.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Optional project ID filter.' },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(input, run) {
      const schedules = db.listSchedules(run.identity.userId, run.identity.profile, input?.project_id || '')
      const todos = db.listTodos(run.identity.userId, run.identity.profile)
      const todoById = new Map(todos.map(t => [t.id, t]))
      const lines = schedules.map(s => {
        const td = todoById.get(s.todoId)
        const nextTxt = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString('zh-CN', { timeZone: s.timezone || 'Asia/Shanghai' }) : '未启用'
        return `${s.id} | ${s.enabled ? '启用' : '暂停'} | #${td?.number || '?'} ${td?.title || s.todoId} | ${formatScheduleRuleLabel(s)} (${s.timezone}) | 下次=${nextTxt} | 上次=${s.lastStatus || '未运行'}${s.lastMessage ? ` (${s.lastMessage})` : ''}`
      })
      return {
        ok: true,
        content: lines.join('\n') || '当前暂无定时规则。',
        data: { schedules },
      }
    },
  })

  reg({
    name: 'create_schedule',
    description: 'Create a recurring or one-shot schedule for a Todo so it automatically starts a fresh build at wall-clock time (hourly/daily/weekly/once). Only create when the user explicitly requests a schedule; immediately summarize the saved rule.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Target Todo ID to run on schedule (create the Todo first if needed).' },
        frequency: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'once'], description: 'Schedule frequency.' },
        hour: { type: 'integer', description: 'Wall-clock hour 0-23 (for daily/weekly). Defaults to 9.' },
        minute: { type: 'integer', description: 'Wall-clock minute 0-59 (for hourly/daily/weekly). Defaults to 0.' },
        weekday: { type: 'integer', description: 'Day of week 0=Sun..6=Sat (for weekly). Defaults to 1 (Mon).' },
        run_at: { type: 'string', maxLength: 80, description: 'ISO or YYYY-MM-DDTHH:mm wall-clock time (required when frequency=once).' },
        timezone: { type: 'string', description: 'IANA timezone (e.g. Asia/Shanghai). Defaults to host local timezone.' },
        agent_id: { type: 'string', maxLength: 120, description: 'Optional Agent ID override; leave empty to follow the Todo assigned agent.' },
        note: { type: 'string', description: 'Optional concise description of why this schedule exists.' },
      },
      required: ['todo_id', 'frequency'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const { schedule } = await orchestrator.saveSchedule(run, {
        todoId: input.todo_id,
        frequency: input.frequency,
        hour: input.hour,
        minute: input.minute,
        weekday: input.weekday,
        runAtIso: input.run_at || '',
        timezone: input.timezone || '',
        agentId: input.agent_id || '',
        note: input.note || '',
        enabled: true,
      }, 'chief')
      const td = db.getTodo(run.identity.userId, run.identity.profile, schedule.todoId)
      const nextStr = schedule.nextRunAt
        ? new Date(schedule.nextRunAt).toLocaleString('zh-CN', { timeZone: schedule.timezone || 'Asia/Shanghai' })
        : '—'
      return {
        ok: true,
        content: `已为任务 #${td?.number || '?'}「${td?.title || schedule.todoId}」创建定时规则 (${schedule.id})：${formatScheduleRuleLabel(schedule)} · 时区 ${schedule.timezone}，下次运行：${nextStr}。`,
        data: { schedule },
      }
    },
  })

  reg({
    name: 'update_schedule',
    description: 'Update an existing schedule rule (frequency, time, timezone, agent override, or enable/pause toggle).',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: 'Schedule ID to update.' },
        frequency: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'once'] },
        hour: { type: 'integer' },
        minute: { type: 'integer' },
        weekday: { type: 'integer' },
        run_at: { type: 'string', maxLength: 80 },
        timezone: { type: 'string' },
        agent_id: { type: 'string', maxLength: 120 },
        enabled: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['schedule_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      const { schedule } = await orchestrator.saveSchedule(run, {
        id: input.schedule_id,
        ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
        ...(input.hour !== undefined ? { hour: input.hour } : {}),
        ...(input.minute !== undefined ? { minute: input.minute } : {}),
        ...(input.weekday !== undefined ? { weekday: input.weekday } : {}),
        ...(input.run_at !== undefined ? { runAtIso: input.run_at } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      }, 'chief')
      return {
        ok: true,
        content: `已更新定时规则 ${schedule.id}：${formatScheduleRuleLabel(schedule)} · ${schedule.enabled ? '启用中' : '已暂停'}`,
        data: { schedule },
      }
    },
  })

  reg({
    name: 'delete_schedule',
    description: 'Delete a recurring or one-shot task schedule.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'string', description: 'Schedule ID to delete.' },
      },
      required: ['schedule_id'],
      additionalProperties: false,
    },
    async execute(input, run) {
      await orchestrator.deleteSchedule(run, { id: input.schedule_id })
      return { ok: true, content: `已删除定时规则 ${input.schedule_id}` }
    },
  })

  return disposers
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'

function makeFakeHost({ failModels = new Set(), generatedTitle = '乘法函数实现' } = {}) {
  let seq = 0
  const sessions = new Map()
  const runs = []

  return {
    sessions,
    runs,
    host: {
      agents: {
        async list() {
          return {
            agents: [
              { id: 'claude-code', name: 'Claude Code', status: { installed: true, version: '2.1.0' }, modes: ['global', 'scoped'] },
              { id: 'codex', name: 'Codex', status: { installed: true, version: '0.170.0' }, modes: ['global', 'scoped'] },
              { id: 'grok', name: 'Grok', status: { installed: true, version: '1.0.0' }, modes: ['global'] },
            ],
          }
        },
        async models(agentId) {
          if (agentId === 'codex') {
            return {
              status: 'ready',
              source: 'app-server',
              models: [
                { id: 'gpt-6.2-sol', name: 'GPT-6.2-Sol', isDefault: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
              ],
            }
          }
          return { status: 'ready', source: 'cli', models: [] }
        },
      },
      models: {
        async list() {
          return {
            data: [
              { id: 'openai/gpt-6-astra', owned_by: 'openai', display_name: 'GPT-6 Astra', api_mode: 'codex_responses' },
            ],
          }
        },
        async respond() {
          return { output_text: generatedTitle }
        },
      },
      async request(path) {
        if (path === '/api/hermes/memory') {
          return { memory: 'Use strict TDD and verify diffs.', user: 'Demo user', soul: '' }
        }
        return null
      },
      sessions: {
        async create(input) {
          const id = `sess-${++seq}`
          sessions.set(id, { id, ...input, workspace: '', messages: [], is_running: false })
          return { session: { id, ...input } }
        },
        async setWorkspace(id, ws) {
          const s = sessions.get(id)
          if (s) s.workspace = ws
          return { ok: true }
        },
        async setModel(id, payload) {
          const s = sessions.get(id)
          if (s) s.modelPayload = payload
          return { ok: true }
        },
        async run(id, input, options) {
          if (options?.model && failModels.has(options.model)) {
            throw new Error(`HTTP 429 rate limit exceeded for ${options.model}`)
          }
          const runId = `run-${++seq}`
          const s = sessions.get(id)
          if (s) {
            s.is_running = true
            s.messages.push({ id: `u-${seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) })
          }
          runs.push({ sessionId: id, runId, input, options })
          return { ok: true, status: 'started', session_id: id, run_id: runId }
        },
        async stop(id) {
          const s = sessions.get(id)
          if (s) s.is_running = false
          return { ok: true }
        },
        async get(id) {
          const s = sessions.get(id)
          return s ? { session: s, is_running: s.is_running } : null
        },
        async messages(id) {
          const s = sessions.get(id)
          return { session: s, messages: s?.messages || [] }
        },
      },
    },
  }
}

test('full Chief -> auto-title -> worktree build with AGENTS.md -> test gate -> auto-wake -> review -> merge pipeline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-e2e-'))
  try {
    const repoPath = join(root, 'repo')
    mkdirSync(repoPath, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
    writeFileSync(join(repoPath, 'calc.mjs'), 'export const add = (a, b) => a + b\n', 'utf8')
    writeFileSync(join(repoPath, 'AGENTS.md'), 'Always keep calc.mjs pure ESM.\n', 'utf8')
    execFileSync('git', ['add', 'calc.mjs', 'AGENTS.md'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath })

    const db = createDatabase(join(root, 'data'), { maxConcurrentBuilds: 1 })
    const orch = createOrchestrator({ db, dataDir: join(root, 'data'), config: { maxConcurrentBuilds: 1 } })
    const fake = makeFakeHost({ generatedTitle: '为计算库新增乘法函数' })
    const emitted = []
    const run = {
      identity: { userId: 1, profile: 'default' },
      host: fake.host,
      messages: { emit(type, data) { emitted.push({ type, data }) } },
    }

    const { project } = await orch.addProject(run, {
      name: 'CalcLib',
      repoPath,
      testCommand: 'node -e "import(\'./calc.mjs\').then(m => { if (m.add(2,3) !== 5 || m.mul(2,3) !== 6) process.exit(1) })"',
    })
    assert.equal(project.defaultBranch, 'main')

    // Zero-modal empty topic -> sending first message auto-generates title via model!
    const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: true })
    assert.equal(topic.title, '新话题')
    assert.equal(topic.isUserNamed, false)

    await orch.sendTopicMessage(run, { topicId: topic.id, text: 'Add mul(a, b) to calc.mjs' })
    await new Promise(r => setTimeout(r, 40))
    const topicTitled = db.getTopic(1, 'default', topic.id)
    assert.equal(topicTitled.title, '为计算库新增乘法函数')
    assert.equal(topicTitled.isUserNamed, false)

    const chiefSess = fake.sessions.get(topicTitled.chiefSessionId)
    chiefSess.is_running = false
    chiefSess.messages.push({ id: 'chief-1', role: 'assistant', content: '已派发 #1 给开发 Agent。', timestamp: Math.floor(Date.now() / 1000) })
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: topicTitled.chiefSessionId } }, run)
    assert.equal(db.getTopic(1, 'default', topic.id).isRunning, false)

    const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'Implement mul(a, b)', spec: 'Export mul' })
    const building = await orch.startBuild(run, { todoId: todo.id })
    assert.equal(building.phase, 'building')
    assert.ok(fake.runs.at(-1).input.includes('Always keep calc.mjs pure ESM'), 'AGENTS.md must auto-load into worker prompt')

    const { todo: todo2 } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'Second queued task' })
    const queuedTodo = await orch.startBuild(run, { todoId: todo2.id })
    assert.equal(queuedTodo.phase, 'queued', 'Overflow build must cleanly enter queued phase instead of throwing')

    writeFileSync(join(building.worktreePath, 'calc.mjs'), 'export const add = (a, b) => a + b\nexport const mul = (a, b) => a * b\n', 'utf8')
    const workerSess = fake.sessions.get(building.buildSessionId)
    workerSess.is_running = false
    workerSess.messages.push({ id: 'w-1', role: 'assistant', content: 'Added mul(a, b).', timestamp: Math.floor(Date.now() / 1000) })

    const chiefRunsBefore = fake.runs.filter(r => r.sessionId === topicTitled.chiefSessionId).length
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: building.buildSessionId } }, run)

    const afterBuild = db.getTodo(1, 'default', todo.id)
    assert.equal(afterBuild.phase, 'review')
    assert.equal(afterBuild.evidence.testRc, 0)
    assert.equal(afterBuild.evidence.filesChanged, 1)

    const chiefRunsAfter = fake.runs.filter(r => r.sessionId === topicTitled.chiefSessionId)
    assert.equal(chiefRunsAfter.length, chiefRunsBefore + 1)
    assert.ok(chiefRunsAfter.at(-1).input.includes('Automated notice'))

    const asked = await orch.askUserQuestion(run, {
      todoId: todo2.id,
      title: 'Keep zero return?',
      why: 'Edge case behavior',
      options: [{ id: 'yes', label: 'Yes, return 0', recommended: true }],
    })
    assert.equal(asked.phase, 'confirm')
    // The worker ended its turn after asking (0.9.42: an answer to a still-running session is queued instead).
    const todo2Sid = db.getTodo(1, 'default', todo2.id).buildSessionId
    if (todo2Sid && fake.sessions.get(todo2Sid)) fake.sessions.get(todo2Sid).is_running = false
    const answered = await orch.answerQuestion(run, { todoId: todo2.id, optionId: 'yes', note: '' })
    assert.equal(answered.phase, 'building')
    await orch.cancelBuild(run, { todoId: todo2.id, discard: true })

    const reviewing = await orch.runIndependentReview(run, { todoId: todo.id })
    const revSess = fake.sessions.get(reviewing.reviewSessionId)
    revSess.is_running = false
    revSess.messages.push({ id: 'rev-1', role: 'assistant', content: 'Looks clean.\nVERDICT: APPROVED', timestamp: Math.floor(Date.now() / 1000) })
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: reviewing.reviewSessionId } }, run)

    const merged = await orch.mergeBuild(run, { todoId: todo.id })
    assert.equal(merged.phase, 'done')
    assert.ok(readFileSync(join(repoPath, 'calc.mjs'), 'utf8').includes('export const mul'))
    assert.ok(emitted.some(e => e.type === 'board.updated'))

    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Agent primary->fallback automatic failover on rate-limit/quota fault, Chief Charter, Topic Brief, and 26 MCP tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-failover-'))
  try {
    const repoPath = join(root, 'repo')
    mkdirSync(repoPath, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath })
    writeFileSync(join(repoPath, 'README.md'), '# Demo\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath })

    const db = createDatabase(join(root, 'data'))
    const orch = createOrchestrator({ db, dataDir: join(root, 'data') })
    const fake = makeFakeHost({ failModels: new Set(['primary-429-model']) })
    const tools = new Map()
    registerMcpTools({
      extensions: {
        tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
      },
    }, { db, orchestrator: orch })

    const run = {
      identity: { userId: 1, profile: 'default' },
      host: fake.host,
      messages: { emit() {}, notify() {} },
    }

    // 1. Configure Agent with primary (will 429) + fallback (healthy) + auto_fallback=true
    const createdAgent = await tools.get('configure_agent').execute({
      name: '全栈工程 Agent',
      role: 'builder',
      engine: 'claude-code',
      auto_fallback: true,
      model_configs: [
        { id: 'cfg-p', label: '主力模型', engine: 'claude-code', mode: 'scoped', provider: 'p1', model: 'primary-429-model', customModel: true, reasoningEffort: 'xhigh' },
        { id: 'cfg-b', label: '备选模型', engine: 'codex', mode: 'scoped', provider: 'p2', model: 'gpt-6.2-sol', customModel: false, reasoningEffort: 'high' },
      ],
    }, run)
    assert.equal(createdAgent.ok, true)
    assert.equal(createdAgent.data.agent.modelConfigs.length, 2)
    assert.equal(createdAgent.data.agent.autoFallback, true)

    // 2. Chief sets Standing Charter + concurrency
    const chiefUpdated = await tools.get('configure_chief').execute({
      provider: 'openai',
      model: 'gpt-6-astra',
      reasoning_effort: 'max',
      charter: '所有前端变更必须经过多端分辨率截图验收。',
      max_concurrent_builds: 4,
    }, run)
    assert.equal(chiefUpdated.ok, true)
    assert.equal(chiefUpdated.data.settings.charter, '所有前端变更必须经过多端分辨率截图验收。')

    // 3. Import GitHub project & dispatch build -> primary 429 -> auto-switches to fallback cfg-b!
    const imported = await tools.get('import_github_project').execute({
      github_repo: 'acme/demo-app',
      mode: 'link',
      repo_path: repoPath,
      name: 'DemoApp',
    }, run)
    const { todo } = await orch.createTodo(run, {
      projectId: imported.data.project.id,
      title: 'Verify failover build',
      agentId: createdAgent.data.agent.id,
    })
    const built = await orch.startBuild(run, { todoId: todo.id })
    assert.equal(built.phase, 'building')
    assert.equal(built.activeConfigId, 'cfg-b', 'must automatically switch from primary-429-model to cfg-b')
    assert.equal(built.engine, 'codex')
    assert.equal(built.fallbackHistory.length, 1)
    assert.equal(built.fallbackHistory[0].category, 'rate_limited')
    assert.equal(db.listAgentCooldowns(createdAgent.data.agent.id).length, 1)

    // 4. Async failure on fallback (no more healthy fallbacks) -> parks in `failed` phase cleanly
    await orch.handleHostEvent({
      type: 'chat.run.failed',
      data: { session_id: built.buildSessionId, error: '503 Service Unavailable' },
    }, run)
    const failedTodo = db.getTodo(1, 'default', todo.id)
    assert.equal(failedTodo.phase, 'failed')
    assert.equal(failedTodo.gateKind, 'failed')

    // 5. Topic Brief waitingOptions + Kanban humanAttention count + topic-level ask_user + structured approval reply
    const { topic } = await orch.createTopic(run, { projectId: imported.data.project.id, title: '用户自定义标题', isUserNamed: true })
    const briefRes = await tools.get('update_topic_brief').execute({
      topic_id: topic.id,
      goal: '验证主备切换',
      waiting_title: '是否上线',
      waiting_on_you: '确认上线窗口',
      waiting_options: ['立即上线', '延后至周末'],
    }, run)
    assert.equal(briefRes.ok, true)
    const briefTopic = db.getTopic(1, 'default', topic.id)
    assert.equal(briefTopic.brief.waitingOnYou, '确认上线窗口')
    assert.equal(briefTopic.brief.waitingOptions.length, 2)

    const snapWithWait = await orch.getSnapshot(run)
    assert.equal(snapWithWait.counts.waitingTopics, 1)
    assert.ok(snapWithWait.counts.humanAttention >= 1, 'waiting topic must count toward humanAttention badge')

    // Approving clears waiting state AND sends structured 【批复确认】 reply to Chief
    const afterApprove = await orch.markBriefWaitingDone(run, {
      topicId: topic.id,
      optionId: 'opt-1',
      note: '先灰度 10%',
      notifyChief: true,
    })
    assert.equal(afterApprove.counts.waitingTopics, 0)
    assert.equal(db.getTopic(1, 'default', topic.id).brief.waitingOnYou, '')
    const approvePrompt = fake.runs.at(-1).input
    assert.ok(approvePrompt.includes('【批复确认】立即上线') && approvePrompt.includes('先灰度 10%'))

    // Topic-level ask_user (without todo_id) pins directly into Topic Brief & waitingTopics
    const askRes = await tools.get('ask_user').execute({
      topic_id: topic.id,
      title: '旧分支处置确认',
      why: '旧分支还有 2 个未合并提交',
      options: [{ id: 'drop', label: '弃用旧分支', recommended: true }, { id: 'reapply', label: '重新提交' }],
    }, run)
    assert.equal(askRes.ok, true)
    const afterAskTopic = db.getTopic(1, 'default', topic.id)
    assert.equal(afterAskTopic.brief.waitingTitle, '旧分支处置确认')
    assert.equal(afterAskTopic.brief.waitingOptions.length, 2)

    // Auto rename without force must NOT overwrite user-named topic!
    await tools.get('rename_topic').execute({ topic_id: topic.id, title: '模型试图覆盖' }, run)
    assert.equal(db.getTopic(1, 'default', topic.id).title, '用户自定义标题')

    // Settle the previous Chief approval turn so the next message runs immediately (instead of entering serialized queue)
    const activeChiefSid = db.getTopic(1, 'default', topic.id).chiefSessionId
    if (activeChiefSid && fake.sessions.has(activeChiefSid)) {
      fake.sessions.get(activeChiefSid).is_running = false
    }
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: activeChiefSid } }, run)

    // Verify Charter & Topic Brief injected into Chief prompt
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '汇报当前进度' })
    const chiefRun = fake.runs.at(-1)
    assert.ok(chiefRun.options.instructions.includes('所有前端变更必须经过多端分辨率截图验收'))
    assert.ok(chiefRun.options.instructions.includes('旧分支处置确认'))

    // 6. Legacy English & old v0.2 default agent names migrate cleanly
    db.upsertAgent(2, 'default', { id: 'legacy-1', name: 'Chief Orchestrator', role: 'chief', engine: 'hermes', mode: 'scoped', systemPrompt: 'Coordinate projects, decompose requirements...' })
    db.upsertAgent(2, 'default', { id: 'legacy-2', name: '核心主程', role: 'builder', engine: 'claude-code', mode: 'global', systemPrompt: '你是核心主程...' })
    const migrated = db.ensureDefaultAgents(2, 'default', [])
    assert.equal(migrated[0].name, '大总管')
    assert.equal(migrated[1].name, '开发 Agent')

    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

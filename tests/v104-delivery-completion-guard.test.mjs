// #104 (audit #95 P1-3, P1-4, P0-3): what counts as a delivered report, when a card may be marked done, and
// what is left behind when it is.
//   - A text round was "delivered" at 40 characters: a research card ending with "接下来我去读代码" went to
//     acceptance, and a deploy card wrote 「部署已执行」 without anything having been run.
//   - complete_todo marked a card at the merge gate done: shown as finished, never merged.
//   - A finished card kept its watches (66 on a real board): a re-dispatch woke old topics again; and every
//     wake queued while the Chief was busy carried the same "Since your last turn" batch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import * as mcpTools from '../src/server/mcp-tools.mjs'
import { judgeTextDeliverable } from '../src/server/text-deliverable.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-104-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const calls = { inputs: [], sessions: [] }
  // chiefRunFails: sessions.run of the Chief session rejects (the wake is not delivered).
  const flags = { chiefRunFails: false }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        if (id === 'sess-chief' && flags.chiefRunFails) throw new Error('host is restarting')
        calls.inputs.push(String(input))
        calls.sessions.push(id)
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false } },
      async connect(id, cb) {
        const timer = setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(sessions.get(id)?.is_running), runStartedAt: 0, queueLength: 0 }), 0)
        return { close() { clearTimeout(timer) } }
      },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {}, notify() {} } }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, calls, flags, sessions, cleanup }
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim()

function makeRepo(root, name = 'repo') {
  const repoPath = join(root, name)
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
  return repoPath
}

const CONFIGS = [{ id: 'cfg-1', label: '主力', engine: 'codex', mode: 'global', provider: 'p1', model: 'model-one', reasoningEffort: 'high' }]
const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const watches = (ctx, id) => ctx.db.getActiveWatchesForTodo(1, 'default', id)
// #117: the schema refuses a second watching topic. A database stored before it has no such rule; these
// tests about left-over watches put it back into that state first.
const dropManagingTopicRule = ctx => {
  const raw = new DatabaseSync(join(ctx.root, 'data', 'ekko-todo.sqlite'))
  try { raw.exec('DROP INDEX IF EXISTS idx_todo_watches_one_active; DROP TRIGGER IF EXISTS trg_todo_watch_manager_insert; DROP TRIGGER IF EXISTS trg_todo_watch_manager_update; DROP TRIGGER IF EXISTS trg_todo_topic_moves_watch;') } finally { raw.close() }
}
const topicOf = (ctx, id) => ctx.db.getTopic(1, 'default', id)

async function buildingTodo(ctx, { kind, title = 'T', autopilot = false } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '交付守卫测试 Agent', role: 'builder', engine: 'codex', autoFallback: false, modelConfigs: CONFIGS })
  const agent = db.listAgents(1, 'default').find(a => a.name === '交付守卫测试 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title, kind, agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id, withPlan: false })
  assert.equal(built.phase, 'building')
  return { todo: built, agent, project, topic }
}

// The worker's turn ends normally with a last assistant line; `toolCalls` is what the host counted on it.
async function endRound(ctx, todoId, text, toolCalls = 0) {
  const sessionId = get(ctx, todoId).buildSessionId
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  if (toolCalls > 0) s.messages.push({ id: `tc-${s.messages.length}`, role: 'assistant', content: '', tool_calls: Array.from({ length: toolCalls }, (_, i) => ({ id: `call-${i}`, name: 'terminal' })), timestamp: Math.floor(Date.now() / 1000) })
  s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: text, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)
  return get(ctx, todoId)
}

// A code card at the merge gate with one committed change on its branch.
async function reviewCard(ctx, opts = {}) {
  const made = await buildingTodo(ctx, opts)
  writeFileSync(join(made.todo.worktreePath, 'a.txt'), 'feature side\n')
  git(made.todo.worktreePath, 'commit', '-am', 'work')
  const after = await endRound(ctx, made.todo.id, 'done')
  assert.equal(after.phase, 'review')
  return { ...made, todo: after }
}

function attachChief(ctx, topicId, patch = {}) {
  ctx.sessions.set('sess-chief', { id: 'sess-chief', messages: [], is_running: false })
  ctx.db.updateTopic(1, 'default', topicId, { chiefSessionId: 'sess-chief', isRunning: false, ...patch })
}
const chiefInputs = ctx => ctx.calls.inputs.filter((_, i) => ctx.calls.sessions[i] === 'sess-chief')
const count = (text, needle) => String(text).split(needle).length - 1

// ---- 2. what counts as a delivered report ----------------------------------------------------------------

const INTENT_ROUND = '已经看过任务书和目录结构，三个候选方案的仓库地址也都找到了，信息基本齐了。接下来我去逐个读它们的源码和发布记录。'
const RESEARCH_REPORT = '## 结论\n选型推荐 A 方案：社区活跃、许可证 MIT、和现有栈兼容。\n\n## 依据\n- A：近 30 天 120 次提交，issue 响应中位 1 天\n- B：已半年无发布\n\n## 风险\nA 的插件接口在 2.x 有破坏性变更，接入需锁版本。'
const DEPLOY_CLAIM = '部署目标是生产环境的 web 容器，镜像已经按最新的 main 重新构建并替换，服务现在跑的是新版本，没有改动仓库里的任何文件。'
const DEPLOY_REPORT = `${DEPLOY_CLAIM}\n线上校验：curl -s -o /dev/null -w '%{http_code}' https://example.test/health 返回 HTTP 200。`

test('#104 judge: a round that ends with an intent sentence is not a deliverable, whatever its length or tool calls', () => {
  const v = judgeTextDeliverable({ text: INTENT_ROUND, kind: 'question', toolCalls: 5 })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'intent_tail')
  assert.match(v.hint, /打算/)
  for (const tail of ['我先看一下 orchestrator 的实现', '让我先把相关文件都读一遍', '接下来要核对三处调用点', '我将去确认线上的版本号', "I'll read the remaining files next"]) {
    const text = `${RESEARCH_REPORT}\n\n${tail}。`
    assert.equal(judgeTextDeliverable({ text, kind: 'question', toolCalls: 3 }).reason, 'intent_tail', tail)
  }
})

test('#104 judge: a research report needs a tool call or a concrete reference; length alone is not enough', () => {
  assert.equal(judgeTextDeliverable({ text: RESEARCH_REPORT, kind: 'question', toolCalls: 2 }).ok, true)
  const bare = judgeTextDeliverable({ text: RESEARCH_REPORT, kind: 'question', toolCalls: 0 })
  assert.equal(bare.ok, false)
  assert.equal(bare.reason, 'no_evidence')
  // No tool call counted by the host, but the report names a file with a line, or quotes command output.
  assert.equal(judgeTextDeliverable({ text: `${RESEARCH_REPORT}\n见 src/server/orchestrator.mjs:4744。`, kind: 'question', toolCalls: 0 }).ok, true)
  assert.equal(judgeTextDeliverable({ text: `${RESEARCH_REPORT}\n\n\`\`\`\n$ npm test\n# pass 12\n\`\`\``, kind: 'question', toolCalls: 0 }).ok, true)
  assert.equal(judgeTextDeliverable({ text: '好的，已完成。', kind: 'question', toolCalls: 4 }).reason, 'too_short')
  // A report that closes with advice to the reader is a report, not an announcement.
  assert.equal(judgeTextDeliverable({ text: `${RESEARCH_REPORT}\n\n建议下一步由用户确认是否采用 A 方案。`, kind: 'question', toolCalls: 2 }).ok, true)
  // Written content is prose: no tool call or file reference is asked of it, an intent tail still is.
  assert.equal(judgeTextDeliverable({ text: RESEARCH_REPORT, kind: 'content', toolCalls: 0 }).ok, true)
  assert.equal(judgeTextDeliverable({ text: INTENT_ROUND, kind: 'content', toolCalls: 0 }).reason, 'intent_tail')
})

test('#104 judge: a deploy report needs command output, an HTTP status or a named check result', () => {
  const claim = judgeTextDeliverable({ text: DEPLOY_CLAIM, kind: 'deploy', toolCalls: 6 })
  assert.equal(claim.ok, false)
  assert.equal(claim.reason, 'no_deploy_proof')
  assert.match(claim.hint, /命令输出|HTTP 状态码/)
  assert.equal(judgeTextDeliverable({ text: DEPLOY_REPORT, kind: 'deploy', toolCalls: 6 }).ok, true)
  assert.equal(judgeTextDeliverable({ text: `${DEPLOY_CLAIM}\n\`\`\`\n$ docker ps\nweb   Up 12 seconds\n\`\`\``, kind: 'deploy', toolCalls: 6 }).ok, true)
  assert.equal(judgeTextDeliverable({ text: `${DEPLOY_CLAIM}\n部署后健康检查通过，/health 回读版本号与本次构建一致。`, kind: 'deploy', toolCalls: 6 }).ok, true)
})

// ---- review rework: three holes of the first version ------------------------------------------------------

const DEPLOY_PLAN = '部署目标是生产环境的 web 容器，步骤是重新构建镜像、替换容器、切换流量，回滚办法是把镜像标签改回上一个版本号。'
const judge = (text, kind, toolCalls = 3) => judgeTextDeliverable({ text, kind, toolCalls })

test('#104 rework: a Markdown heading or a quote is not command output', () => {
  const heading = judge(`# 部署报告\n${DEPLOY_PLAN}\n部署方案已整理完毕，尚未执行，等你确认后再动手部署上线。`, 'deploy', 1)
  assert.equal(heading.ok, false, 'a heading line is not a shell prompt')
  assert.equal(heading.reason, 'no_deploy_proof')
  // The same heading on a plan that does not even say it was not run.
  assert.equal(judge(`# 部署报告\n${DEPLOY_PLAN}\n以上是这次上线的全部内容，没有改动仓库里的任何文件。`, 'deploy', 1).reason, 'no_deploy_proof')
  const quote = judge(`> 说明\n${DEPLOY_PLAN}\n以上是这次上线的全部内容，没有改动仓库里的任何文件。`, 'deploy', 1)
  assert.equal(quote.ok, false, 'a quote line is not a shell prompt')
  assert.equal(quote.reason, 'no_deploy_proof')
  // A real prompt line still counts.
  assert.equal(judge(`${DEPLOY_PLAN}\n$ docker compose up -d web\nContainer web  Started`, 'deploy').ok, true)
})

test('#104 rework: a check that is still to come is not a check result', () => {
  const waiting = judge(`${DEPLOY_PLAN}\n按 deploy.sh 执行后，等健康检查通过再切流量即可。`, 'deploy')
  assert.equal(waiting.ok, false)
  assert.equal(waiting.reason, 'no_deploy_proof')
  // A code block that lists what would be run, in a report that says nothing was run.
  const notRun = judge(`${DEPLOY_PLAN}\n\`\`\`\ndocker compose pull web\ndocker compose up -d web\n\`\`\`\n以上命令尚未执行，线上还是旧版本。`, 'deploy')
  assert.equal(notRun.ok, false)
  assert.equal(notRun.reason, 'no_deploy_proof')
  // The same check, reported as done.
  assert.equal(judge(`${DEPLOY_PLAN}\n部署后健康检查通过，/health 回读版本号 0.9.71 与本次构建一致。`, 'deploy').ok, true)
  // An earlier clause with 然后 does not make the measured result an announcement.
  assert.equal(judge(`${DEPLOY_PLAN}\n先构建然后重启，服务返回 HTTP 200。`, 'deploy').ok, true)
})

test('#104 rework: a result named in an earlier clause does not excuse an intent tail', () => {
  const a = judge(`${RESEARCH_REPORT}\n\n初步分析已完成，接下来我将去读 orchestrator 的结算路径。`, 'question')
  assert.equal(a.ok, false)
  assert.equal(a.reason, 'intent_tail')
  const b = judge(`${RESEARCH_REPORT}\n\n方案已整理，稍后我会执行。`, 'question')
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'intent_tail')
  // A reply that states what was done is a result.
  assert.equal(judge(`${RESEARCH_REPORT}\n\n已完成合并，main 现在是 3c352dc。`, 'question').ok, true)
})

test('#104 rework card: a deploy plan under a Markdown heading is not recorded as deployed', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'deploy', title: '部署到生产' })
    const after = await endRound(ctx, todo.id, `# 部署报告\n${DEPLOY_PLAN}\n部署方案已整理完毕，尚未执行，等你确认后再动手部署上线。`, 1)
    assert.equal(after.phase, 'building')
    assert.notEqual(after.gateKind, 'deliverable')
    assert.ok(!timeline(ctx, todo.id).some(e => e.includes('部署已执行')), 'no line says the deployment was carried out')
  } finally { ctx.cleanup() }
})

test('#104 card: a research round that ends with an intent sentence is nudged, not delivered', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研三个开源方案' })
    const after = await endRound(ctx, todo.id, INTENT_ROUND, 4)
    assert.equal(after.phase, 'building', 'the card is not at the acceptance gate')
    assert.notEqual(after.gateKind, 'deliverable')
    assert.ok(!after.evidence.deliverable, 'nothing was stored as the deliverable')
    const lines = timeline(ctx, todo.id)
    assert.ok(!lines.some(e => e.includes('成果已交付')), 'no line says a report was delivered')
    assert.ok(lines.some(e => e.includes('不算交付') && e.includes('打算')), lines.join(' | '))
  } finally { ctx.cleanup() }
})

test('#104 card: a research round with tool calls and a conclusion is delivered for acceptance', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研三个开源方案' })
    const after = await endRound(ctx, todo.id, RESEARCH_REPORT, 3)
    assert.equal(after.phase, 'review')
    assert.equal(after.gateKind, 'deliverable')
    assert.equal(after.evidence.deliverable, RESEARCH_REPORT)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('成果已交付')))
  } finally { ctx.cleanup() }
})

test('#104 card: a deploy card without any output is not recorded as deployed, and is asked for the evidence', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'deploy', title: '部署到生产' })
    const after = await endRound(ctx, todo.id, DEPLOY_CLAIM, 6)
    assert.equal(after.phase, 'building')
    assert.notEqual(after.gateKind, 'deliverable')
    const lines = timeline(ctx, todo.id)
    assert.ok(!lines.some(e => e.includes('部署已执行')), 'no line says the deployment was carried out')
    assert.ok(lines.some(e => e.includes('不算交付') && e.includes('证据')), lines.join(' | '))
    const nudge = ctx.calls.inputs.at(-1)
    assert.match(nudge, /命令输出|HTTP 状态码/, 'the worker is told what evidence is missing')
  } finally { ctx.cleanup() }
})

test('#104 card: a deploy card whose report shows HTTP 200 is delivered', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'deploy', title: '部署到生产' })
    const after = await endRound(ctx, todo.id, DEPLOY_REPORT, 6)
    assert.equal(after.phase, 'review')
    assert.equal(after.gateKind, 'deliverable')
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('部署已执行')))
  } finally { ctx.cleanup() }
})

// ---- 1. the completion guard -----------------------------------------------------------------------------

test('#104 guard: a code card at the merge gate with an unmerged branch cannot be marked done, by the Chief or the user', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    const mainBefore = git(project.repoPath, 'rev-parse', 'main')
    for (const caller of ['chief', 'user']) {
      await assert.rejects(ctx.orch.completeTodo(ctx.run, { todoId: todo.id, caller }), /有未合并改动，请走合并或先取消/)
    }
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'review', 'the card stays at its gate')
    assert.equal(after.gateKind, todo.gateKind)
    assert.equal(after.branch, todo.branch)
    assert.ok(existsSync(after.worktreePath), 'the worktree is kept')
    assert.ok(!timeline(ctx, todo.id).includes('标记完成'))
    assert.equal(git(project.repoPath, 'rev-parse', 'main'), mainBefore)
    assert.ok(watches(ctx, todo.id).length > 0, 'a refusal clears nothing')
  } finally { ctx.cleanup() }
})

test('#104 guard: uncommitted changes in the worktree count as unmerged', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    git(project.repoPath, 'merge', '--no-ff', '-m', 'merge by hand', todo.branch)
    writeFileSync(join(todo.worktreePath, 'a.txt'), 'edited after the merge\n')
    await assert.rejects(ctx.orch.completeTodo(ctx.run, { todoId: todo.id, caller: 'chief' }), /有未合并改动，请走合并或先取消/)
    assert.equal(get(ctx, todo.id).phase, 'review')
  } finally { ctx.cleanup() }
})

test('#104 guard: once the branch is in main (ancestor check) the card can be completed, and the actor is the real caller', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    git(project.repoPath, 'merge', '--no-ff', '-m', 'merge by hand', todo.branch)
    const done = await ctx.orch.completeTodo(ctx.run, { todoId: todo.id, caller: 'chief' })
    assert.equal(done.phase, 'done')
    const entry = done.timeline.find(e => String(e.event).includes('标记完成'))
    assert.ok(entry, 'the completion is on the timeline')
    assert.equal(entry.actor, 'chief', 'a completion by the Chief is not recorded as the user\'s')
    assert.match(entry.event, /总管/)
  } finally { ctx.cleanup() }
})

test('#104 guard: a completion by the user is recorded as the user\'s; a question card needs no merge', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研三个开源方案' })
    const delivered = await endRound(ctx, todo.id, RESEARCH_REPORT, 3)
    assert.equal(delivered.gateKind, 'deliverable')
    const done = await ctx.orch.completeTodo(ctx.run, { todoId: todo.id })
    assert.equal(done.phase, 'done')
    const entry = done.timeline.find(e => String(e.event).includes('标记完成'))
    assert.equal(entry.actor, 'user')
    assert.doesNotMatch(entry.event, /总管/)
  } finally { ctx.cleanup() }
})

test('#104 guard: a question card is completed by the Chief as before', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研三个开源方案', autopilot: true })
    await endRound(ctx, todo.id, RESEARCH_REPORT, 3)
    const done = await ctx.orch.completeTodo(ctx.run, { todoId: todo.id, caller: 'chief' })
    assert.equal(done.phase, 'done')
  } finally { ctx.cleanup() }
})

test('#104 guard: a card waiting for the user\'s answer or plan approval is not completed', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    await ctx.orch.askUserQuestion(ctx.run, { todoId: todo.id, title: '用哪个方案？', why: '两个都可行', options: ['A', 'B'] })
    const waiting = get(ctx, todo.id)
    assert.equal(waiting.phase, 'confirm')
    for (const caller of ['chief', 'user']) {
      await assert.rejects(ctx.orch.completeTodo(ctx.run, { todoId: todo.id, caller }), /等待.*(答复|确认)/)
    }
    assert.equal(get(ctx, todo.id).phase, 'confirm')
    assert.equal(get(ctx, todo.id).question.active, true)
  } finally { ctx.cleanup() }
})

test('#104 tool: complete_todo calls as the Chief and answers a refusal with ok:false instead of "Completed"', async () => {
  const tools = new Map()
  const seen = []
  const orchestrator = {
    async completeTodo(run, args) {
      seen.push(args)
      if (args.todoId === 'gate') throw Object.assign(new Error('#7 有未合并改动，请走合并或先取消'), { completeRefused: true })
      return { id: args.todoId, number: 7, phase: 'done' }
    },
  }
  mcpTools.registerMcpTools(
    { extensions: { tools: { register(def) { tools.set(def.name, def); return () => {} } } } },
    { db: { getSettings: () => ({}), getTodo: () => null }, orchestrator },
  )
  const tool = tools.get('complete_todo')
  const run = { identity: { userId: 1, profile: 'default' } }
  const ok = await tool.execute({ todo_id: 't1' }, run)
  assert.equal(ok.ok, true)
  assert.equal(seen[0].caller, 'chief')
  const refused = await tool.execute({ todo_id: 'gate' }, run)
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'COMPLETE_REFUSED')
  assert.match(refused.content, /有未合并改动/)
  assert.doesNotMatch(refused.content, /Completed/)
})

// ---- 3. watches and the digest clock ---------------------------------------------------------------------

test('#104 watches: completing a card ends its watches', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { kind: 'question', title: '调研三个开源方案' })
    await endRound(ctx, todo.id, RESEARCH_REPORT, 3)
    assert.ok(watches(ctx, todo.id).length > 0, 'the card is watched while it is open')
    await ctx.orch.completeTodo(ctx.run, { todoId: todo.id })
    assert.deepEqual(watches(ctx, todo.id), [])
  } finally { ctx.cleanup() }
})

test('#104 watches: a merge ends every watch of the card, also one that could not be notified', async () => {
  const ctx = setup()
  try {
    const { todo, project } = await reviewCard(ctx)
    // A second topic of the same project that was archived: its watch is never delivered, so never cleared.
    dropManagingTopicRule(ctx)
    const { topic: other } = await ctx.orch.createTopic(ctx.run, { projectId: project.id, autopilot: false })
    ctx.db.watchTodo(1, 'default', other.id, todo.id, 'old watch')
    ctx.db.updateTopic(1, 'default', other.id, { archived: true })
    assert.equal(watches(ctx, todo.id).length, 2)
    ctx.db.updateTodo(1, 'default', todo.id, { reviewedSha: git(todo.worktreePath, 'rev-parse', 'HEAD'), evidence: { reviewVerdict: 'approved', reviewSummary: 'VERDICT: APPROVED' } })
    const done = await ctx.orch.mergeBuild(ctx.run, { todoId: todo.id, caller: 'user' })
    assert.equal(done.phase, 'done')
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual(watches(ctx, todo.id), [])
  } finally { ctx.cleanup() }
})

test('#104 watches: closing a card ends its watches', async () => {
  const ctx = setup()
  try {
    const { todo } = await reviewCard(ctx)
    assert.ok(watches(ctx, todo.id).length > 0)
    await ctx.orch.closeTodo(ctx.run, { todoId: todo.id })
    assert.equal(get(ctx, todo.id).phase, 'closed')
    assert.deepEqual(watches(ctx, todo.id), [])
  } finally { ctx.cleanup() }
})

test('#104 watches: a build stopped by the user ends its watches, and the next dispatch watches again', async () => {
  const ctx = setup()
  try {
    const { todo, topic } = await buildingTodo(ctx)
    assert.equal(watches(ctx, todo.id).length, 1)
    const stopped = await ctx.orch.cancelBuild(ctx.run, { todoId: todo.id, discard: false })
    assert.equal(stopped.phase, 'todo')
    assert.deepEqual(watches(ctx, todo.id), [])
    await ctx.orch.startBuild(ctx.run, { todoId: todo.id })
    assert.deepEqual(watches(ctx, todo.id).map(w => w.topicId), [topic.id])
  } finally { ctx.cleanup() }
})

test('#104 watches: a finished card that is dispatched again starts with its own topic only', async () => {
  const ctx = setup()
  try {
    const { todo, project, topic } = await buildingTodo(ctx, { kind: 'question', title: '调研三个开源方案' })
    await endRound(ctx, todo.id, RESEARCH_REPORT, 3)
    await ctx.orch.completeTodo(ctx.run, { todoId: todo.id })
    // What a real board had: watches of a finished card that stayed active, one from another project's topic.
    const { project: otherProject } = await ctx.orch.addProject(ctx.run, { name: 'Q', repoPath: makeRepo(ctx.root, 'repo-q'), testCommand: 'true' })
    const { topic: foreign } = await ctx.orch.createTopic(ctx.run, { projectId: otherProject.id, autopilot: true })
    const { topic: sibling } = await ctx.orch.createTopic(ctx.run, { projectId: project.id, autopilot: true })
    dropManagingTopicRule(ctx)
    ctx.db.watchTodo(1, 'default', foreign.id, todo.id, 'left over')
    ctx.db.watchTodo(1, 'default', sibling.id, todo.id, 'left over')
    assert.equal(watches(ctx, todo.id).length, 2)
    const again = await ctx.orch.startBuild(ctx.run, { todoId: todo.id })
    assert.equal(again.phase, 'building')
    assert.deepEqual(watches(ctx, todo.id).map(w => w.topicId), [topic.id])
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('旧订阅') && e.includes('2')), timeline(ctx, todo.id).join(' | '))
  } finally { ctx.cleanup() }
})

test('#104 digest: wakes queued while the Chief is busy carry no digest; the delivered turn carries it once', async () => {
  const ctx = setup()
  try {
    const { todo, topic } = await reviewCard(ctx, { autopilot: true })
    attachChief(ctx, topic.id, { isRunning: true, lastDigestAt: 1 })
    ctx.sessions.get('sess-chief').is_running = true
    const project = ctx.db.getProject(1, 'default', todo.projectId)
    // Two different events of the card while the Chief's turn is under way.
    await ctx.orch.maybeWakeChief(ctx.run, 1, 'default', get(ctx, todo.id), project, 'build_completed')
    ctx.db.appendTimeline(1, 'default', todo.id, 'something else happened', 'system')
    await ctx.orch.maybeWakeChief(ctx.run, 1, 'default', get(ctx, todo.id), project, 'review_approved')
    const queued = ctx.db.listTopicQueue(1, 'default', topic.id).filter(q => q.kind === 'wake')
    assert.equal(queued.length, 2)
    for (const q of queued) assert.equal(count(q.text, 'Since your last turn'), 0, 'a queued wake does not freeze a digest')
    assert.equal(topicOf(ctx, topic.id).lastDigestAt, 1, 'nothing was delivered: the clock did not move')
    assert.equal(chiefInputs(ctx).length, 0)

    // The Chief's turn ends: the queue is delivered as one turn.
    ctx.sessions.get('sess-chief').is_running = false
    ctx.db.updateTopic(1, 'default', topic.id, { isRunning: false, activeRunId: '' })
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const sent = chiefInputs(ctx)
    assert.equal(sent.length, 1, 'one consolidated wake')
    assert.equal(count(sent[0], 'Since your last turn'), 1, 'the same batch is not repeated per queued wake')
    assert.equal((sent[0].match(/^- #\d+ .*: phase=\w+ \(wait=/gm) || []).length, 1, 'one digest row for the one card')
    assert.ok(topicOf(ctx, topic.id).lastDigestAt > 1, 'delivered: the clock moved')
    assert.equal(ctx.db.listTopicQueue(1, 'default', topic.id).length, 0)
  } finally { ctx.cleanup() }
})

test('#104 digest: a wake that could not be launched does not move the clock; the retry delivers the batch once', async () => {
  const ctx = setup()
  try {
    const { todo, topic } = await reviewCard(ctx, { autopilot: true })
    attachChief(ctx, topic.id, { lastDigestAt: 1 })
    const project = ctx.db.getProject(1, 'default', todo.projectId)
    ctx.flags.chiefRunFails = true
    await ctx.orch.maybeWakeChief(ctx.run, 1, 'default', get(ctx, todo.id), project, 'build_completed')
    assert.equal(chiefInputs(ctx).length, 0, 'the launch failed')
    assert.equal(topicOf(ctx, topic.id).lastDigestAt, 1, 'not delivered: the clock did not move')
    const queued = ctx.db.listTopicQueue(1, 'default', topic.id)
    assert.equal(queued.length, 1, 'the wake is kept')
    assert.equal(count(queued[0].text, 'Since your last turn'), 0)

    ctx.flags.chiefRunFails = false
    ctx.db.updateTopic(1, 'default', topic.id, { isRunning: false, activeRunId: '' })
    await ctx.orch.reconcileActiveRuns(ctx.run)
    const sent = chiefInputs(ctx)
    assert.equal(sent.length, 1)
    assert.equal(count(sent[0], 'Since your last turn'), 1)
    const clock = topicOf(ctx, topic.id).lastDigestAt
    assert.ok(clock > 1)

    // The Chief's turn ends. Nothing changed since: the next wake has no digest to repeat.
    const chief = ctx.sessions.get('sess-chief')
    chief.is_running = false
    chief.messages.push({ id: 'chief-a-1', role: 'assistant', content: '已阅。', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
    await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: 'sess-chief', finish_reason: 'stop' } }, ctx.run)
    assert.equal(topicOf(ctx, topic.id).isRunning, false)
    await new Promise(r => setTimeout(r, 5))
    await ctx.orch.maybeWakeChief(ctx.run, 1, 'default', get(ctx, todo.id), project, 'review_approved')
    const second = chiefInputs(ctx)
    assert.equal(second.length, 2)
    assert.equal(count(second[1], 'Since your last turn'), 0, 'the batch already delivered is not sent again')
    assert.ok(topicOf(ctx, topic.id).lastDigestAt >= clock)
  } finally { ctx.cleanup() }
})

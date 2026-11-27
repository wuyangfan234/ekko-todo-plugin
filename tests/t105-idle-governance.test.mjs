// #105 (audit #95 P1-5 / P1-6 / idle leftovers): idle governance.
//  - Worker: the idle count (evidence.idleNudges) is reset only by a productive round or when the chain ends
//    (the card fails as idle). A queued instruction, an idle rerun on another config and the nudge itself keep it.
//  - Chief: a round of only read-only / probing tools without a verifiable conclusion is an idle round, like an
//    announce-only one. The count lives in topics.chief_idle_json (survives a reload); 3 → hint, 4 → breaker.
//  - Resumes used up: one line in the topic and one on the card. Chief-owned gate waiting too long: one reminder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { CHIEF_IDLE_BREAK_AT, CHIEF_IDLE_HINT_AT, classifyChiefRound, hasVerifiableConclusion, isReadOnlyProbeTool } from '../src/shared/chief-guard.mjs'
import { DESCRIBE_ONLY_LIMIT } from '../src/shared/loop-guard.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function makeHost(state) {
  const { sessions, calls } = state
  return {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { calls.create += 1; const id = `sess-${++state.seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        calls.run += 1
        calls.inputs.push(String(input))
        calls.sessions.push(id)
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++state.seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++state.seq}` }
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
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t105-'))
  const dataDir = join(root, 'data')
  const state = { seq: 0, sessions: new Map(), calls: { create: 0, run: 0, inputs: [], sessions: [] }, offsetMs: 0 }
  const log = { warn() {}, info() {}, error() {} }
  const ctx = { root, dataDir, state, log, sessions: state.sessions, calls: state.calls }
  ctx.db = createDatabase(dataDir, {})
  ctx.newOrch = () => createOrchestrator({ db: ctx.db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], clock: () => Date.now() + state.offsetMs })
  ctx.orch = ctx.newOrch()
  ctx.run = { identity: { userId: 1, profile: 'default' }, host: makeHost(state), messages: { emit() {}, notify() {} } }
  // #105 reload: a new orchestrator instance on the same database (what a dev reload does).
  ctx.reload = () => { try { ctx.orch.dispose?.() } catch {} ctx.orch = ctx.newOrch() }
  ctx.cleanup = () => { try { ctx.orch.dispose?.() } catch {} try { ctx.db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return ctx
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim()

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
  return repoPath
}

const ONE = [{ id: 'cfg-1', label: '主力', engine: 'codex', mode: 'global', provider: 'p1', model: 'model-one', reasoningEffort: 'high' }]
const TWO = [...ONE, { id: 'cfg-2', label: '备选', engine: 'codex', mode: 'global', provider: 'p2', model: 'model-two', reasoningEffort: 'high' }]

async function buildingTodo(ctx, { configs = ONE } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: 'T105 Agent', role: 'builder', engine: 'codex', autoFallback: true, modelConfigs: configs })
  const agent = db.listAgents(1, 'default').find(a => a.name === 'T105 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root) })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id })
  assert.equal(built.phase, 'building')
  assert.ok(built.worktreePath && existsSync(built.worktreePath))
  return { todo: built, agent, project, topic }
}

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const IDLE_WORDS = 'Base is current. Now set up the plan and read code.'

// The worker's turn ends normally with a last assistant line.
async function workerSays(ctx, todoId, text = IDLE_WORDS) {
  const sessionId = get(ctx, todoId).buildSessionId
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: text, finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)
  return get(ctx, todoId)
}
const nudgeLines = (ctx, id) => timeline(ctx, id).filter(e => /已在同一会话催促它实际执行/.test(e))

// ---- worker: dispatch / message / queue do not reset the count ------------------------------------------

test('#105 worker: a queued instruction delivered after an idle round does not reset the idle count', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    let after = await workerSays(ctx, todo.id)
    assert.equal(after.phase, 'building')
    assert.equal(after.evidence.idleNudges, 1, 'first nudge counted')
    // The Chief / user queues an instruction while the nudged round runs; the round ends idle again.
    ctx.db.enqueueTodoItem(1, 'default', todo.id, { kind: 'message', text: '补充：先读 README' })
    after = await workerSays(ctx, todo.id)
    assert.ok(timeline(ctx, todo.id).some(e => /送达排队的指令/.test(e)), 'the queued instruction was delivered')
    assert.equal(after.phase, 'building')
    assert.equal(after.evidence.idleNudges, 1, 'delivering a queued instruction is a dispatch, not output: count kept')
    after = await workerSays(ctx, todo.id)
    assert.equal(after.evidence.idleNudges, 2, 'the next idle round is nudge 2, not nudge 1 again')
    assert.match(nudgeLines(ctx, todo.id).at(-1), /（2\/3）/)
  } finally { ctx.cleanup() }
})

test('#105 worker: the idle rerun on another config keeps the count (no fresh 3 nudges); the chain end resets it with a timeline line', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { configs: TWO })
    let after = todo
    for (let i = 0; i < 3; i += 1) after = await workerSays(ctx, todo.id)
    assert.equal(after.evidence.idleNudges, 3)
    assert.equal(nudgeLines(ctx, todo.id).length, 3)
    // 4th idle round: no nudge left → idle rerun on cfg-2 (a dispatch without the nudge flag).
    after = await workerSays(ctx, todo.id)
    assert.equal(after.phase, 'building', 'rerun on the fallback config')
    assert.equal(after.activeConfigId, 'cfg-2')
    assert.equal(after.evidence.idleNudges, 3, 'the idle rerun does not hand out a fresh nudge budget')
    // The rerun idles too: no nudge (count is at 3), the card fails, the count expires and is logged.
    after = await workerSays(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.equal(nudgeLines(ctx, todo.id).length, 3, 'still 3 nudges in total over 5 idle rounds (was 6 before #105)')
    assert.equal(after.evidence.idleNudges, 0, 'the chain ended: count cleared')
    assert.ok(timeline(ctx, todo.id).some(e => /空转计数已到期（3\/3）/.test(e)), 'expiry is on the timeline')
  } finally { ctx.cleanup() }
})

test('#105 worker control: a round with a commit resets the count, with a timeline line', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    let after = await workerSays(ctx, todo.id)
    assert.equal(after.evidence.idleNudges, 1)
    writeFileSync(join(todo.worktreePath, 'b.txt'), 'work\n')
    git(todo.worktreePath, 'add', '.'); git(todo.worktreePath, 'commit', '-m', 'work')
    after = await workerSays(ctx, todo.id, '已提交 b.txt')
    assert.equal(after.phase, 'review')
    assert.equal(after.evidence.idleNudges, 0, 'productive round: count reset')
    assert.ok(timeline(ctx, todo.id).some(e => /本轮有产出，空转计数（1\/3）清零/.test(e)))
  } finally { ctx.cleanup() }
})

test('#105 worker: the idle count survives a plugin reload (new orchestrator on the same database)', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    await workerSays(ctx, todo.id)
    assert.equal(get(ctx, todo.id).evidence.idleNudges, 1)
    ctx.reload()
    const after = await workerSays(ctx, todo.id)
    assert.equal(after.evidence.idleNudges, 2, 'continues at 2 after the reload')
    assert.match(nudgeLines(ctx, todo.id).at(-1), /（2\/3）/)
  } finally { ctx.cleanup() }
})

// ---- chief: read-only rounds count as idle ---------------------------------------------------------------

const userTurn = (...rest) => [{ role: 'user', content: '看一下进度' }, ...rest]
const probe = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: 't', function: { name, arguments: args ?? '{}' } }] })

test('#105 chief: read-only / probing tools without a conclusion are an idle round; dispatches and conclusions are productive', () => {
  for (const n of ['tool_search', 'tool_describe', 'read_file', 'search_files', 'mcp__ekko_todo__ekko_todo__list_utodos', 'mcp__ekko_todo__ekko_todo__inspect_uproject_urepo', 'mcp__ekko_todo__ekko_todo__get_utodo_udiff'])
    assert.ok(isReadOnlyProbeTool(n), n)
  assert.equal(isReadOnlyProbeTool('mcp__ekko_todo__ekko_todo__run_ubuild'), false)
  assert.equal(isReadOnlyProbeTool('terminal'), false)
  assert.ok(isReadOnlyProbeTool('tool_call', '{"calls":[{"name":"mcp__ekko_todo__ekko_todo__list_utodos","arguments":{}}]}'))
  assert.equal(isReadOnlyProbeTool('tool_call', '{"calls":[{"name":"mcp__ekko_todo__ekko_todo__run_ubuild"}]}'), false)
  assert.equal(isReadOnlyProbeTool('tool_call', '{}'), false, 'unreadable wrapper is not concluded to be read-only')

  // Incident #22 shape: schema reads only, a short non-answer (fewer than DESCRIBE_ONLY_LIMIT, so the in-turn guard is silent).
  const schemaOnly = userTurn(probe('tool_search'), { role: 'tool', content: '{}' }, probe('tool_describe'), { role: 'tool', content: '{}' }, { role: 'assistant', content: '好的。' })
  assert.ok(2 < DESCRIBE_ONLY_LIMIT)
  assert.deepEqual(classifyChiefRound(schemaOnly).kind, 'idle')
  assert.equal(classifyChiefRound(schemaOnly).reason, 'read-only')
  // An announcement after probing is idle too, even when it names a card and a state word.
  assert.equal(classifyChiefRound(userTurn(probe('tool_describe'), { role: 'tool', content: '{}' }, { role: 'assistant', content: '我先查一下 #27 的部署记录。' })).kind, 'idle')
  // Empty reply after probing.
  assert.equal(classifyChiefRound(userTurn(probe('mcp__ekko_todo__ekko_todo__list_utodos'), { role: 'tool', content: '[]' })).kind, 'idle')
  // Productive: a dispatch (also through tool_call) or a verifiable conclusion.
  assert.deepEqual(classifyChiefRound(userTurn(probe('tool_call', '{"calls":[{"name":"mcp__ekko_todo__ekko_todo__run_ubuild"}]}'), { role: 'tool', content: '{}' }, { role: 'assistant', content: '好的。' })), { kind: 'productive', reason: 'dispatch' })
  assert.deepEqual(classifyChiefRound(userTurn(probe('mcp__ekko_todo__ekko_todo__list_utodos'), { role: 'tool', content: '[]' }, { role: 'assistant', content: '#12 已进入审查，门禁 rc=0。' })), { kind: 'productive', reason: 'conclusion' })
  for (const t of ['src/server/orchestrator.mjs:3683 归零', '提交 c97b445 已在 main', '# pass 812，0 failed', '```\nok\n```'])
    assert.ok(hasVerifiableConclusion(t), t)
  assert.equal(hasVerifiableConclusion('好的，我明白了'), false)
  // Neutral: a question to the user, a plain answer without tools, other tools.
  assert.equal(classifyChiefRound(userTurn(probe('tool_describe'), { role: 'tool', content: '{}' }, { role: 'assistant', content: '你说的是哪个项目？' })).kind, 'neutral')
  assert.equal(classifyChiefRound(userTurn({ role: 'assistant', content: '明白了。' })).kind, 'neutral')
  assert.equal(classifyChiefRound(userTurn(probe('memory'), { role: 'tool', content: '{}' }, { role: 'assistant', content: '记下了。' })).kind, 'neutral')
})

// #105 review (CHANGES_REQUESTED): what a schema-reading Chief says must not count as a conclusion.
// Each negative names the loose rule it used to hit; each positive is the kind of output that must still count.
const LOOSE_NEGATIVES = [
  ['count word (\\d+ 个/张/分钟)', '我查看了 3 个工具的 schema，参数已经清楚了。…'],
  ['hex id taken for a sha', '我看了项目 proj-9af059e7 的配置。…'],
  ['bare file path', '我读了 docs/CONTRACTS.md 的说明。…'],
  ['card + 待', '#12 待我再确认一下。…'],
]
const REAL_POSITIVES = [
  ['commit sha', 'git log -1 输出：\ncommit 3c352dc feat(ekko-todo): 修复跨项目串台'],
  ['file:line', '问题在 src/server/db.mjs:2102，listTodos 没带项目过滤。'],
  ['test result', '`npm test` 1146 条全过，fail 0。'],
  ['card + final state', '#97 已合并至 main。'],
]

test('#105 review: loose mentions after read-only probing are not a conclusion (idle); real output still is (productive)', () => {
  for (const [rule, text] of LOOSE_NEGATIVES) {
    assert.equal(hasVerifiableConclusion(text), false, `${rule}: ${text}`)
    const round = classifyChiefRound(userTurn(probe('tool_describe'), { role: 'tool', content: '{}' }, { role: 'assistant', content: text }))
    assert.notEqual(round.kind, 'productive', `${rule}: must not reset the idle count`)
    assert.equal(round.kind, 'idle', `${rule}: read-only round with this reply is idle`)
  }
  for (const [rule, text] of REAL_POSITIVES) {
    assert.equal(hasVerifiableConclusion(text), true, `${rule}: ${text}`)
    assert.deepEqual(classifyChiefRound(userTurn(probe('mcp__ekko_todo__ekko_todo__list_utodos'), { role: 'tool', content: '[]' }, { role: 'assistant', content: text })), { kind: 'productive', reason: 'conclusion' }, rule)
  }
  // Other non-conclusions of the same family: a duration, an agent id, a path inside a sentence, an open state.
  for (const t of ['等了 5 分钟还没结果。', '我看了 agent-8bd7cd30 的配置。', '参考 src/server/db.mjs 的写法。', '#12 还在进行中，阶段是构建。'])
    assert.equal(hasVerifiableConclusion(t), false, t)
})

// #110: an identifier inside an intent / future / conditional sentence is not a conclusion, and a real
// conclusion next to ordinary report wording still is. Two corpora, every row asserted, locked both ways:
// saysIntent ≡ false turns the negatives red, saysIntent ≡ true turns the positives red.
const INTENT_NEGATIVES = [
  // Task spec.
  '合并 deadbeef 之前我再确认',
  '等合并 abcdef12 完成后我再派工',
  '准备去跑 npm test 拿 rc=0',
  '我会把 #12 已合并的情况再核一遍',
  // Review corpus.
  '应该会是 rc=0',
  '如果 #12 已合并就关单',
  'I will merge abc1234 once the gate passes',
  '#12 已合并，我再去派 #13',
  '稍后确认 rc=0',
  'Before merging abc1234 I need a check',
  // The two English rows above carry no CONCLUSION hit at all (「merge」 is not a sha keyword); these do.
  'I will merge commit abc1234 once the gate passes',
  'Before merging commit abc1234 I need a check',
  // Same family (review suggestion 3): 以前 / 才能 / 需要…后.
  '要跑一下才能拿到 rc=0',
  '合并 deadbeef 以前先确认一下',
  '需要合并 deadbeef 后确认',
  // Plan or condition in the neighbouring clause; waiting before the hit; a guess in the hit's own clause.
  '我会去跑测试，拿到 rc=0',
  '#12 已合并，这个情况我再核一遍',
  '等门禁跑完，合并 abc1234',
  '我先去确认 rc=0',
  '问题应该在 src/a.mjs:12',
]
const INTENT_POSITIVES = [
  ...REAL_POSITIVES.map(([, text]) => text),
  // Review corpus: report wording that looked like a marker.
  '我先看了日志，问题在 src/a.mjs:12。',
  '我去跑了测试，rc=0。',
  '根因确认在 src/a.mjs:12，应该改成 x',
  'Merged #12 (commit abc1234). Next I will dispatch #13.',
  '#12 已合并至 main\n下一步：派 #13',
  '跑完 rc=0',
  'exit code 0 已确认',
  '之前的提交 c97b445 已回滚',
  // Review suggestion 1: handing a finished result over to the user.
  '#12 审查通过，等待合并',
  '测试跑完 rc=0，等你拍板合并',
  '#12 审查通过等用户拍板',
  // Same family.
  '测试 rc=0',
  '#5 已进入待合并',
  '权限等级调整后门禁 rc=0',
  '准备工作已完成，#12 已合并至 main',
  '我会继续跟进。#97 已合并至 main。',
  'HEAD is 3c352dc. I will dispatch #13 next.',
]

test('#110 negatives: an identifier inside an intent / future / conditional sentence is not a conclusion', () => {
  assert.ok(INTENT_NEGATIVES.length >= 10)
  assert.deepEqual(INTENT_NEGATIVES.filter(t => hasVerifiableConclusion(t) !== false), [], 'judged as a conclusion')
  for (const text of INTENT_NEGATIVES.slice(0, 4)) {
    const round = classifyChiefRound(userTurn(probe('tool_describe'), { role: 'tool', content: '{}' }, { role: 'assistant', content: text }))
    assert.ok(['idle', 'neutral'].includes(round.kind), `${text}: ${round.kind} must not reset the idle count`)
  }
})

test('#110 positives: a real conclusion next to report wording (我先…了 / 应该改成 / 等你拍板 / "Next I will" in the next sentence) still counts', () => {
  assert.ok(INTENT_POSITIVES.length >= 12)
  assert.deepEqual(INTENT_POSITIVES.filter(t => hasVerifiableConclusion(t) !== true), [], 'judged as idle')
  for (const text of ['我先看了日志，问题在 src/a.mjs:12。', '我去跑了测试，rc=0。', '根因确认在 src/a.mjs:12，应该改成 x', 'Merged #12 (commit abc1234). Next I will dispatch #13.', '#12 审查通过，等待合并'])
    assert.deepEqual(classifyChiefRound(userTurn(probe('mcp__ekko_todo__ekko_todo__list_utodos'), { role: 'tool', content: '[]' }, { role: 'assistant', content: text })), { kind: 'productive', reason: 'conclusion' }, text)
})

async function chiefTopic(ctx) {
  const { db, orch, run, root } = ctx
  db.getSettings(1, 'default'); db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root) })
  const { topic } = await orch.createTopic(run, { projectId: project.id })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: '链上的卡' })
  // The AUTO chain is about this card: the progress notice that woke the Chief names it.
  db.addTopicMessage(1, 'default', topic.id, { kind: 'system', text: `关注的任务有进展：#${todo.number} ${todo.title}`, todoId: todo.id })
  return { topic, todo, project }
}

// One Chief round: read-only probing (tool_describe + list_todos), then a non-answer.
async function chiefProbes(ctx, topicId, reply = '好的。') {
  const sid = ctx.db.getTopic(1, 'default', topicId).chiefSessionId
  const s = ctx.sessions.get(sid)
  s.is_running = false
  const n = s.messages.length
  s.messages.push({ id: `a-${n}`, role: 'assistant', content: '', tool_calls: [{ id: `c-${n}`, function: { name: 'tool_describe', arguments: '{}' } }] })
  s.messages.push({ id: `t-${n}`, role: 'tool', content: '{}' })
  s.messages.push({ id: `b-${n}`, role: 'assistant', content: '', tool_calls: [{ id: `d-${n}`, function: { name: 'mcp__ekko_todo__ekko_todo__list_utodos', arguments: '{}' } }] })
  s.messages.push({ id: `r-${n}`, role: 'tool', content: '[]' })
  s.messages.push({ id: `f-${n}`, role: 'assistant', content: reply, finish_reason: 'stop' })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid, finish_reason: 'stop' } }, ctx.run)
  return sid
}
const chiefRuns = (ctx, sid) => ctx.calls.inputs.filter((_, i) => ctx.calls.sessions[i] === sid)
const systemTexts = (ctx, topicId) => (ctx.db.getTopic(1, 'default', topicId).messages || []).filter(m => m.kind === 'system').map(m => m.text)
const idleOf = (ctx, topicId) => ctx.db.getTopic(1, 'default', topicId).chiefIdle

test('#105 chief: 3 read-only rounds in a row → hint (and resumes used up → topic + card); 4th → breaker, no resume', async () => {
  const ctx = setup()
  try {
    assert.equal(CHIEF_IDLE_HINT_AT, 3)
    assert.equal(CHIEF_IDLE_BREAK_AT, 4)
    const { topic, todo } = await chiefTopic(ctx)
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '看一下进度' })
    const sid = ctx.db.getTopic(1, 'default', topic.id).chiefSessionId
    assert.equal(chiefRuns(ctx, sid).length, 1)

    await chiefProbes(ctx, topic.id)
    assert.equal(idleOf(ctx, topic.id).count, 1)
    assert.equal(chiefRuns(ctx, sid).length, 2, 'read-only round resumed (counts as only announcing)')
    assert.match(chiefRuns(ctx, sid)[1], /只调用了只读\/查询工具/)
    await chiefProbes(ctx, topic.id)
    assert.equal(idleOf(ctx, topic.id).count, 2)
    assert.equal(chiefRuns(ctx, sid).length, 3, 'second resume')
    assert.ok(!systemTexts(ctx, topic.id).some(t => t.startsWith('提示：总管已连续')), 'no hint before 3')

    await chiefProbes(ctx, topic.id)
    assert.equal(idleOf(ctx, topic.id).count, 3)
    assert.ok(systemTexts(ctx, topic.id).some(t => t.startsWith('提示：总管已连续 3 轮没有产出')), 'hint at 3')
    assert.equal(chiefRuns(ctx, sid).length, 3, 'resumes used up: no third resume')
    assert.ok(systemTexts(ctx, topic.id).some(t => t.startsWith('本链续跑次数已用尽，需要人工介入')), 'exhausted: topic line')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('本链续跑次数已用尽，需要人工介入')), 'exhausted: card line')
    assert.ok(!systemTexts(ctx, topic.id).some(t => t.startsWith('已熔断')), 'no breaker yet')

    // A user message re-arms the resumes but does not reset the count.
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '继续' })
    assert.equal(idleOf(ctx, topic.id).count, 3, 'a message is not output')
    const runsBefore = chiefRuns(ctx, sid).length
    await chiefProbes(ctx, topic.id)
    assert.equal(idleOf(ctx, topic.id).count, 4)
    const breaker = systemTexts(ctx, topic.id).find(t => t.startsWith('已熔断：总管连续 4 轮没有产出'))
    assert.ok(breaker, 'breaker at 4')
    assert.match(breaker, /建议：/)
    assert.equal(chiefRuns(ctx, sid).length, runsBefore, 'breaker: no automatic resume')
  } finally { ctx.cleanup() }
})

test('#105 chief control: a productive round resets the count (with a topic line); a neutral one does not', async () => {
  const ctx = setup()
  try {
    const { topic } = await chiefTopic(ctx)
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '看一下进度' })
    await chiefProbes(ctx, topic.id)
    await chiefProbes(ctx, topic.id)
    assert.equal(idleOf(ctx, topic.id).count, 2)
    await chiefProbes(ctx, topic.id, '你说的是哪张卡？')
    assert.equal(idleOf(ctx, topic.id).count, 2, 'a question to the user is neutral: count kept')
    await chiefProbes(ctx, topic.id, '#1 仍在 todo 阶段，没有分支；门禁 rc=-1 未运行。')
    assert.equal(idleOf(ctx, topic.id).count, 0, 'verifiable conclusion: reset')
    assert.equal(idleOf(ctx, topic.id).resumes, 0)
    assert.ok(systemTexts(ctx, topic.id).some(t => /空转计数（2）清零/.test(t)))
  } finally { ctx.cleanup() }
})

test('#105 chief: the idle count and the resume budget survive a plugin reload', async () => {
  const ctx = setup()
  try {
    const { topic } = await chiefTopic(ctx)
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '看一下进度' })
    const sid = ctx.db.getTopic(1, 'default', topic.id).chiefSessionId
    await chiefProbes(ctx, topic.id)
    await chiefProbes(ctx, topic.id)
    assert.deepEqual([idleOf(ctx, topic.id).count, idleOf(ctx, topic.id).resumes], [2, 2])
    ctx.reload()
    const runsBefore = chiefRuns(ctx, sid).length
    await chiefProbes(ctx, topic.id)
    assert.equal(idleOf(ctx, topic.id).count, 3, 'continues at 3 after the reload')
    assert.ok(systemTexts(ctx, topic.id).some(t => t.startsWith('提示：总管已连续 3 轮')), 'hint reached across the reload')
    assert.equal(chiefRuns(ctx, sid).length, runsBefore, 'the reload did not hand out a fresh resume budget')
  } finally { ctx.cleanup() }
})

// ---- gate owned by the Chief: one reminder after the threshold -------------------------------------------

test('#105 gate: a card at a Chief-owned gate past chiefGateStaleMs (default 20 min) gets one reminder in topic and card', async () => {
  const ctx = setup()
  try {
    const { topic, todo } = await chiefTopic(ctx)
    assert.equal(ctx.db.getSettings(1, 'default').chiefGateStaleMs, 1200000, 'default 20 minutes')
    ctx.db.updateTodo(1, 'default', todo.id, { phase: 'review', gateOwner: 'chief', gateKind: 'merge' })
    const reminders = () => timeline(ctx, todo.id).filter(e => e.startsWith('关口提醒：'))
    const topicReminders = () => systemTexts(ctx, topic.id).filter(t => t.startsWith('关口提醒：'))
    ctx.state.offsetMs = 10 * 60000
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(reminders().length, 0, 'under the threshold: nothing')
    ctx.state.offsetMs = 21 * 60000
    const runsBefore = ctx.calls.run
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(reminders().length, 1, 'card reminded once')
    assert.equal(topicReminders().length, 1, 'topic told once')
    assert.match(reminders()[0], /已停留约 2\d 分钟/)
    assert.equal(ctx.calls.run, runsBefore, 'no Chief run was started: a reminder, not a nudge')
    ctx.state.offsetMs = 90 * 60000
    await ctx.orch.reconcileActiveRuns(ctx.run)
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.equal(reminders().length, 1, 'never repeated for the same gate')
    assert.equal(topicReminders().length, 1)
  } finally { ctx.cleanup() }
})

test('#105 gate: chiefGateStaleMs = 0 turns the reminder off; a human-owned gate is never reminded', async () => {
  const ctx = setup()
  try {
    const { todo } = await chiefTopic(ctx)
    ctx.db.updateSettings(1, 'default', { chiefGateStaleMs: 0 })
    assert.equal(ctx.db.getSettings(1, 'default').chiefGateStaleMs, 0)
    ctx.db.updateTodo(1, 'default', todo.id, { phase: 'review', gateOwner: 'chief', gateKind: 'merge' })
    ctx.state.offsetMs = 120 * 60000
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('关口提醒：')), 'off')
    ctx.db.updateSettings(1, 'default', { chiefGateStaleMs: 1200000 })
    ctx.db.updateTodo(1, 'default', todo.id, { gateOwner: 'human' })
    await ctx.orch.reconcileActiveRuns(ctx.run)
    assert.ok(!timeline(ctx, todo.id).some(e => e.startsWith('关口提醒：')), 'human gate: not the Chief to remind')
    // Clamp: below 5 minutes is raised to 5 minutes.
    assert.equal(ctx.db.updateSettings(1, 'default', { chiefGateStaleMs: 1000 }).chiefGateStaleMs, 300000)
  } finally { ctx.cleanup() }
})

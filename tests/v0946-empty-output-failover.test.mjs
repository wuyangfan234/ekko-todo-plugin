// v0.9.46 (Todo #35): a build that fails because the model returned nothing switches to the next model
// config, and the card always carries the real cause instead of the bare「执行会话异常结束」.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { classifyModelFailure } from '../src/server/failover.mjs'
import { assertReleaseMetadata } from './helpers/release-metadata.mjs'

// Texts copied from ~/.hermes/logs/errors.log.
const BACKFILL = 'response.output is empty after stream backfill (status=completed, incomplete_details=None, model=magpie-jp/claude/claude-fable-5-2). api_mode=codex_responses provider=custom'
const RETRY = 'Invalid API response (retry 1/3): response.output is empty | Provider: model=magpie-jp/claude/claude-fable-5-2'
const AFTER_RETRIES = 'Invalid API response after 3 retries.'
const GENERIC = '执行会话异常结束'

// ---- 1. classifier: positive cases ----------------------------------------------------------------------

for (const text of [
  BACKFILL,
  `Codex ${BACKFILL}`,
  RETRY,
  AFTER_RETRIES,
  'Empty response (no content or reasoning) — retry 1/3 in 2.0s (model=deepseek/deepseek-flash)',
  'Empty response (reasoning but no visible content) — retry 2/3 in 4.0s (model=kimi-coding/k2.5-pro)',
  'the model returned no content',
  'empty output from provider',
  'empty message',
  'empty completion',
  '模型无输出',
  '模型返回空响应',
]) {
  test(`v0.9.46 classify: switchable empty_output: ${text.slice(0, 60)}`, () => {
    const c = classifyModelFailure(text)
    assert.equal(c.switchable, true)
    assert.equal(c.category, 'empty_output')
    assert.equal(c.label, '模型返回空响应')
  })
}

// ---- 2. classifier: negative cases ----------------------------------------------------------------------

for (const [text, category] of [
  [GENERIC, 'non_model'],
  ['审查会话异常结束', 'non_model'],
  ['  执行会话异常结束。 ', 'non_model'],
  ['merge conflict in dist/server.mjs', 'non_model'],
  ['uncommitted changes', 'non_model'],
  ['test gate failed (rc=1)', 'non_model'],
  ['aborted by user', 'non_model'],
  ['stopped by user', 'non_model'],
  ['worktree is missing', 'non_model'],
  // An empty-output text never overrides a non-model cause in the same message.
  ['merge conflict in dist/server.mjs; response.output is empty', 'non_model'],
  ['test gate failed (rc=1): empty response', 'non_model'],
  ['', 'unknown'],
  ['something unexpected happened', 'unknown'],
]) {
  test(`v0.9.46 classify: not switchable: ${JSON.stringify(text)}`, () => {
    const c = classifyModelFailure(text)
    assert.equal(c.switchable, false)
    assert.equal(c.category, category)
  })
}

test('v0.9.46 classify: the categories that existed before are unchanged', () => {
  assert.equal(classifyModelFailure('429 Too Many Requests').category, 'rate_limited')
  assert.equal(classifyModelFailure('503 Service Unavailable').category, 'upstream_fault')
  assert.equal(classifyModelFailure('401 unauthorized').category, 'auth_failed')
  assert.equal(classifyModelFailure('Invalid API response after 3 retries: 429 rate limit').category, 'rate_limited')
})

// ---- orchestrator harness -------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-empty-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, inputs: [], get: 0 }
  // sessionDetail: what sessions.get answers for a session id (null = the host has nothing).
  // messagesFail: sessions.messages rejects (the host transcript cannot be read).
  const flags = { sessionDetail: null, messagesFail: false }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { calls.create += 1; const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        calls.run += 1
        calls.inputs.push(String(input))
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) {
        calls.get += 1
        if (typeof flags.sessionDetail === 'function') return flags.sessionDetail(id)
        const s = sessions.get(id)
        return s ? { session: s, is_running: s.is_running } : null
      },
      async messages(id) {
        if (flags.messagesFail) throw new Error('host transcript unavailable')
        return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false }
      },
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

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
  g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
  return repoPath
}

const CONFIGS = [
  { id: 'cfg-1', label: '主力', engine: 'codex', mode: 'global', provider: 'p1', model: 'model-one', reasoningEffort: 'high' },
  { id: 'cfg-2', label: '备选', engine: 'codex', mode: 'global', provider: 'p2', model: 'model-two', reasoningEffort: 'high' },
]

async function buildingTodo(ctx, { configs = CONFIGS, autoFallback = true } = {}) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '空响应测试 Agent', role: 'builder', engine: 'codex', autoFallback, modelConfigs: configs })
  const agent = db.listAgents(1, 'default').find(a => a.name === '空响应测试 Agent')
  assert.ok(agent, 'agent saved')
  assert.equal(agent.modelConfigs.length, configs.length)
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id })
  assert.equal(built.phase, 'building')
  assert.equal(built.activeConfigId || 'cfg-1', 'cfg-1')
  return { todo: built, agent }
}

const get = (ctx, id) => ctx.db.getTodo(1, 'default', id)
const timeline = (ctx, id) => (get(ctx, id).timeline || []).map(e => String(e.event || ''))
const fail = (ctx, sessionId, data = {}) => ctx.orch.handleHostEvent({ type: 'chat.run.failed', data: { session_id: sessionId, ...data } }, ctx.run)

// ---- 3. runtime switch -----------------------------------------------------------------------------------

test('v0.9.46: a build run that ends with an empty model response switches to the next config', async () => {
  const ctx = setup()
  try {
    const { todo, agent } = await buildingTodo(ctx)
    const firstSession = todo.buildSessionId
    const createsBefore = ctx.calls.create
    const runsBefore = ctx.calls.run
    await fail(ctx, firstSession, { error: BACKFILL })
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'building', 'not parked as failed')
    assert.equal(after.activeConfigId, 'cfg-2')
    assert.equal(after.fallbackHistory.length, 1)
    assert.equal(after.fallbackHistory[0].category, 'empty_output')
    assert.equal(after.fallbackHistory[0].fromConfigId, 'cfg-1')
    assert.equal(after.fallbackHistory[0].toConfigId, 'cfg-2')
    // startBuild was called again with forceNewSession: a new host session and a new run.
    assert.equal(ctx.calls.create, createsBefore + 1)
    assert.equal(ctx.calls.run, runsBefore + 1)
    assert.notEqual(after.buildSessionId, firstSession)
    assert.ok(after.buildSessionId)
    assert.match(ctx.calls.inputs.at(-1), /previous model configuration encountered a service error \(模型返回空响应\)/)
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('模型返回空响应') && e.includes('已自动切换')))
    const cds = ctx.db.listAgentCooldowns(agent.id)
    assert.equal(cds.length, 1)
    assert.equal(cds[0].configId, 'cfg-1')
  } finally { ctx.cleanup() }
})

// ---- 4. the event carries no error: the host session still knows ----------------------------------------

for (const [name, detail] of [
  ['session.lastError', id => ({ session: { id, lastError: 'response.output is empty' } })],
  ['session.last_error', id => ({ session: { id, last_error: AFTER_RETRIES } })],
  ['top-level error object', id => ({ id, error: { message: RETRY } })],
]) {
  test(`v0.9.46: chat.run.failed without an error: the cause is read from the host session (${name})`, async () => {
    const ctx = setup()
    try {
      const { todo } = await buildingTodo(ctx)
      ctx.flags.sessionDetail = detail
      await fail(ctx, todo.buildSessionId, { error: '' })
      const after = get(ctx, todo.id)
      assert.equal(after.phase, 'building')
      assert.equal(after.activeConfigId, 'cfg-2')
      assert.equal(after.fallbackHistory.length, 1)
      assert.equal(after.fallbackHistory[0].category, 'empty_output')
    } finally { ctx.cleanup() }
  })
}

test('v0.9.46: no error anywhere and the turn produced no assistant text: treated as an empty model response', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    // The host session has no error field; its transcript holds only the instruction and a tool result.
    ctx.sessions.get(todo.buildSessionId).messages.push({ id: 't-1', role: 'tool', content: 'ok', timestamp: 1 })
    await fail(ctx, todo.buildSessionId, {})
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'building')
    assert.equal(after.activeConfigId, 'cfg-2')
    assert.equal(after.fallbackHistory[0].category, 'empty_output')
  } finally { ctx.cleanup() }
})

test('v0.9.46: the bare fallback wording in the event is not taken as the cause', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    ctx.flags.sessionDetail = id => ({ session: { id, lastError: 'response.output is empty' } })
    await fail(ctx, todo.buildSessionId, { error: GENERIC })
    assert.equal(get(ctx, todo.id).activeConfigId, 'cfg-2')
  } finally { ctx.cleanup() }
})

test('v0.9.46: no error and the model did write text this turn: not an empty response, no switch', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    ctx.sessions.get(todo.buildSessionId).messages.push({ id: 'a-1', role: 'assistant', content: '我改了 a.txt', timestamp: 1 })
    await fail(ctx, todo.buildSessionId, {})
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.equal((after.fallbackHistory || []).length, 0)
    assert.notEqual(after.lastError, GENERIC)
    assert.match(after.lastError, /未能取到模型侧原始错误/)
  } finally { ctx.cleanup() }
})

test('v0.9.46: an interrupted run without an error is not treated as an empty model response', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    await fail(ctx, todo.buildSessionId, { interrupted: true, stop_reason: 'user' })
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.equal((after.fallbackHistory || []).length, 0)
    assert.equal(after.activeConfigId || 'cfg-1', 'cfg-1')
  } finally { ctx.cleanup() }
})

// ---- 5. nothing can be read back -------------------------------------------------------------------------

test('v0.9.46: no error in the event and nothing readable on the host: failed, with session id and config label', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    const sid = todo.buildSessionId
    ctx.flags.sessionDetail = () => null
    ctx.flags.messagesFail = true
    await fail(ctx, sid, { error: '', code: 'run_failed' })
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.equal(after.gateKind, 'failed')
    assert.equal((after.fallbackHistory || []).length, 0)
    assert.notEqual(after.lastError, GENERIC)
    assert.match(after.lastError, /未能取到模型侧原始错误/)
    assert.ok(after.lastError.includes(sid), 'session id')
    assert.ok(after.lastError.includes('model-one') && after.lastError.includes('主力'), 'config label')
    assert.ok(after.lastError.includes('run_failed'), 'the host code is kept')
    assert.ok(timeline(ctx, todo.id).some(e => e.startsWith('构建失败：') && e.includes(sid)))
  } finally { ctx.cleanup() }
})

// ---- 6. both configs return nothing ----------------------------------------------------------------------

test('v0.9.46: both configs answer empty: failed with the original cause, history kept, no-alternative line', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx)
    await fail(ctx, todo.buildSessionId, { error: BACKFILL })
    const mid = get(ctx, todo.id)
    assert.equal(mid.activeConfigId, 'cfg-2')
    await fail(ctx, mid.buildSessionId, { error: RETRY })
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.equal(after.fallbackHistory.length, 1)
    assert.equal(after.fallbackHistory[0].category, 'empty_output')
    assert.notEqual(after.lastError, GENERIC)
    assert.ok(after.lastError.startsWith('模型服务异常'), after.lastError)
    assert.ok(after.lastError.includes('response.output is empty'), after.lastError)
    const lines = timeline(ctx, todo.id)
    assert.ok(lines.some(e => e.includes('model-two') && e.includes('服务异常（模型返回空响应），但没有可用备选配置')), lines.join('\n'))
    assert.ok(lines.some(e => e.startsWith('构建失败：') && e.includes('response.output is empty')))
  } finally { ctx.cleanup() }
})

test('v0.9.46: a single config answering empty: failed, cause kept, no-alternative line', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { configs: [CONFIGS[0]] })
    await fail(ctx, todo.buildSessionId, { error: AFTER_RETRIES })
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.equal((after.fallbackHistory || []).length, 0)
    assert.ok(after.lastError.includes('Invalid API response after 3 retries'))
    assert.ok(timeline(ctx, todo.id).some(e => e.includes('但没有可用备选配置')))
  } finally { ctx.cleanup() }
})

test('v0.9.46: a long error is stored as a summary of at most 400 characters of the original', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { configs: [CONFIGS[0]] })
    await fail(ctx, todo.buildSessionId, { error: `response.output is empty ${'x'.repeat(5000)}` })
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.ok(after.lastError.includes('response.output is empty'))
    assert.ok(after.lastError.length <= 440, `lastError length ${after.lastError.length}`)
  } finally { ctx.cleanup() }
})

// ---- 7. a non-model failure never switches ---------------------------------------------------------------

for (const error of ['merge conflict in dist/server.mjs', 'test gate failed (rc=1)', 'aborted by user']) {
  test(`v0.9.46: a non-model failure never switches models: ${error}`, async () => {
    const ctx = setup()
    try {
      const { todo, agent } = await buildingTodo(ctx)
      const runsBefore = ctx.calls.run
      await fail(ctx, todo.buildSessionId, { error })
      const after = get(ctx, todo.id)
      assert.equal(after.phase, 'failed')
      assert.equal(after.activeConfigId || 'cfg-1', 'cfg-1')
      assert.equal((after.fallbackHistory || []).length, 0)
      assert.equal(ctx.calls.run, runsBefore, 'no new run')
      assert.equal(after.lastError, error, 'the original text, without a model-fault prefix')
      assert.equal(ctx.db.listAgentCooldowns(agent.id).length, 0)
      assert.ok(!timeline(ctx, todo.id).some(e => e.includes('没有可用备选配置')))
    } finally { ctx.cleanup() }
  })
}

test('v0.9.46: autoFallback off: an empty response fails the card with the cause and no switch', async () => {
  const ctx = setup()
  try {
    const { todo } = await buildingTodo(ctx, { autoFallback: false })
    await fail(ctx, todo.buildSessionId, { error: BACKFILL })
    const after = get(ctx, todo.id)
    assert.equal(after.phase, 'failed')
    assert.equal((after.fallbackHistory || []).length, 0)
    assert.ok(after.lastError.includes('response.output is empty'))
  } finally { ctx.cleanup() }
})

// ---- 8. release metadata and bundle ----------------------------------------------------------------------

test('v0.9.46: the shipped server bundle carries the change, versions agree, the changelog has the section', () => {
  const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
  const server = read('dist/server.mjs')
  for (const literal of ['empty_output', 'empty after stream backfill', 'resolveBuildFailure']) assert.ok(server.includes(literal), `server bundle has ${literal}`)
  // #112: format + the five places, stated once in tests/helpers/release-metadata.mjs (no fixed 0.9.x).
  assertReleaseMetadata()
  const changelog = read('CHANGELOG.md')
  const start = changelog.indexOf('## [0.9.46]')
  assert.ok(start >= 0)
  const section = changelog.slice(start, changelog.indexOf('\n## [', start + 1))
  assert.match(section, /empty_output/)
  assert.match(section, /未能取到模型侧原始错误/)
  for (const v of ['0.9.44', '0.9.43', '0.9.42', '0.9.41', '0.9.40']) assert.ok(changelog.includes(`## [${v}]`), `section ${v} is kept`)
})

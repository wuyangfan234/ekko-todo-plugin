import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transitionTodoPhase, canTransition } from '../src/server/state-machine.mjs'
import { createDatabase } from '../src/server/db.mjs'
import { runDeterministicTestGate } from '../src/server/gate-runner.mjs'
import { classifyModelFailure, selectNextFallbackConfig, normalizeModelConfigs } from '../src/server/failover.mjs'
import { distillProvisionalTitle, generateTopicTitleWithModel } from '../src/server/title-generator.mjs'

test('XState v5 todo lifecycle enforces legal transitions including reversible failed state', () => {
  assert.equal(transitionTodoPhase('todo', 'START_BUILD'), 'building')
  assert.equal(transitionTodoPhase('building', 'PLAN_READY'), 'confirm')
  assert.equal(transitionTodoPhase('confirm', 'CONFIRM_PLAN'), 'building')
  assert.equal(transitionTodoPhase('building', 'BUILD_FAILED'), 'failed')
  assert.equal(transitionTodoPhase('failed', 'RETRY_CONTINUE'), 'building')
  assert.equal(transitionTodoPhase('building', 'BUILD_COMPLETED'), 'review')
  assert.equal(transitionTodoPhase('review', 'START_REVIEW'), 'reviewing')
  assert.equal(transitionTodoPhase('reviewing', 'REVIEW_APPROVED'), 'review')
  assert.equal(transitionTodoPhase('review', 'APPROVE_MERGE'), 'done')
  assert.equal(transitionTodoPhase('done', 'REOPEN'), 'todo')

  assert.equal(canTransition('todo', 'APPROVE_MERGE'), false)
  assert.throws(() => transitionTodoPhase('todo', 'APPROVE_MERGE'), /not allowed/)
  assert.throws(() => transitionTodoPhase('done', 'APPROVE_MERGE'), /not allowed/)
})

test('failover classifier switches only on genuine model/provider faults and respects 1-hour cooldown', () => {
  assert.equal(classifyModelFailure('HTTP 429 rate limit exceeded').switchable, true)
  assert.equal(classifyModelFailure('insufficient_quota: billing balance empty').category, 'quota_spent')
  assert.equal(classifyModelFailure('401 Invalid API key').category, 'auth_failed')
  assert.equal(classifyModelFailure('503 Service Unavailable upstream').category, 'upstream_fault')
  assert.equal(classifyModelFailure('ETIMEDOUT fetch failed').category, 'network_cutoff')
  assert.equal(classifyModelFailure('reasoning_effort xhigh not supported').category, 'incompatible_request')

  // Non-model faults must NEVER trigger automatic model switching
  assert.equal(classifyModelFailure('Stopped by user').switchable, false)
  assert.equal(classifyModelFailure('Merge conflict merging branch into main').switchable, false)
  assert.equal(classifyModelFailure('Test gate failed rc=1').switchable, false)

  const configs = normalizeModelConfigs([
    { id: 'cfg-1', engine: 'claude-code', model: 'claude-opus-5-5', reasoningEffort: 'high' },
    { id: 'cfg-2', engine: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' },
    { id: 'cfg-3', engine: 'grok', model: 'grok-4.7', reasoningEffort: 'medium' },
  ])
  const agent = { modelConfigs: configs }
  const now = 1_700_000_000_000

  // cfg-1 failed -> picks cfg-2
  const next1 = selectNextFallbackConfig({ agent, failedConfigId: 'cfg-1', cooldowns: [], nowMs: now })
  assert.equal(next1?.config.id, 'cfg-2')

  // cfg-2 already failed 10 mins ago (still within 1h cooldown) -> skips straight to cfg-3
  const next2 = selectNextFallbackConfig({
    agent,
    failedConfigId: 'cfg-1',
    cooldowns: [{ configId: 'cfg-2', failedAt: now - 10 * 60 * 1000 }],
    nowMs: now,
  })
  assert.equal(next2?.config.id, 'cfg-3')

  // cfg-2 failed 2 hours ago (cooldown expired) -> eligible again
  const next3 = selectNextFallbackConfig({
    agent,
    failedConfigId: 'cfg-1',
    cooldowns: [{ configId: 'cfg-2', failedAt: now - 120 * 60 * 1000 }],
    nowMs: now,
  })
  assert.equal(next3?.config.id, 'cfg-2')
})

test('topic title generator distills clean provisional titles and calls host model cleanly', async () => {
  assert.equal(distillProvisionalTitle('请帮我修复侧边栏在移动端打开白屏的问题，顺便检查一下响应式样式'), '修复侧边栏在移动端打开白屏的问题')
  const fakeRun = {
    host: {
      models: {
        async list() { return { data: [{ id: 'fast-flash' }] } },
        async respond() { return { output_text: '「修复移动端侧栏白屏」' } },
      },
    },
  }
  const res = await generateTopicTitleWithModel(fakeRun, { userText: '修复移动端侧边栏点开白屏的问题' })
  assert.equal(res.generatedByModel, true)
  assert.equal(res.title, '修复移动端侧栏白屏')
})

test('SQLite WAL store isolates users/profiles and deduplicates wake keys idempotently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-todo-db-'))
  try {
    const db = createDatabase(dir)
    const agents = db.ensureDefaultAgents(1, 'default', [
      { id: 'claude-code', installed: true },
      { id: 'codex', installed: true },
      { id: 'grok', installed: true },
    ])
    assert.equal(agents.length, 3)
    const builder = agents.find(a => a.role === 'builder')
    assert.equal(builder.engine, 'claude-code')
    assert.ok(builder.modelConfigs.length >= 2, 'builder auto-configures a fallback engine when multiple engines installed')

    const proj = db.createProject(1, 'default', { name: 'Alpha', repoPath: '/tmp/alpha' })
    const t1 = db.createTodo(1, 'default', { projectId: proj.id, title: 'First task' })
    const t2 = db.createTodo(1, 'default', { projectId: proj.id, title: 'Second task' })
    assert.equal(t1.number, 1)
    assert.equal(t2.number, 2)

    assert.equal(db.listProjects(2, 'default').length, 0)
    assert.equal(db.listTodos(1, 'other-profile').length, 0)

    assert.equal(db.claimWakeKey('wake:t1:2:review', t1.id, 'topic-1'), true)
    assert.equal(db.claimWakeKey('wake:t1:2:review', t1.id, 'topic-1'), false)

    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deterministic test gate captures pass, fail exit code, and skips when empty', async () => {
  const skipped = await runDeterministicTestGate({ cwd: tmpdir(), command: '' })
  assert.equal(skipped.executed, false)
  assert.equal(skipped.exitCode, -1)

  const pass = await runDeterministicTestGate({ cwd: tmpdir(), command: 'node -e "console.log(\'ALL_OK\')"' })
  assert.equal(pass.executed, true)
  assert.equal(pass.exitCode, 0)
  assert.ok(pass.summary.includes('rc=0'))

  const fail = await runDeterministicTestGate({ cwd: tmpdir(), command: 'node -e "console.error(\'BOOM\'); process.exit(2)"' })
  assert.equal(fail.executed, true)
  assert.equal(fail.exitCode, 2)
  assert.ok(fail.summary.includes('rc=2'))
})

test('resolveWaitingOptions and getTodoCardStateMeta cover explicit/inferred choices and all card phases', async () => {
  const { resolveWaitingOptions, getTodoCardStateMeta } = await import('../src/client/utils.js')

  // 1. Explicit options take precedence
  const explicit = resolveWaitingOptions({
    waitingOnYou: '选择发布策略',
    waitingOptions: [{ id: 'a', label: '灰度发布', recommended: true }, { id: 'b', label: '全量发布' }],
  })
  assert.equal(explicit.inferred, false)
  assert.equal(explicit.options.length, 2)
  assert.equal(explicit.options[0].label, '灰度发布')

  // 2. Natural Chinese binary decision phrase cleanly extracts quick options
  const inferred = resolveWaitingOptions({
    waitingOnYou: '旧分支 fix/sample-branch（2 个提交）未合入 main，是弃用还是重新提交由你定',
  })
  assert.equal(inferred.inferred, true)
  assert.deepEqual(inferred.options.map(o => o.label), ['弃用', '重新提交'])

  // 3. Card lifecycle state metadata covers running, review-ready, failed, and done
  assert.equal(getTodoCardStateMeta({ phase: 'building' }).running, true)
  assert.equal(getTodoCardStateMeta({ phase: 'reviewing' }).tone, 'reviewing')
  assert.equal(getTodoCardStateMeta({ phase: 'review', gateOwner: 'human', evidence: { testRc: 0 } }).tone, 'ready')
  assert.equal(getTodoCardStateMeta({ phase: 'review', gateOwner: 'chief' }).tone, 'chief')
  assert.equal(getTodoCardStateMeta({ phase: 'failed' }).tone, 'failed')
  assert.equal(getTodoCardStateMeta({ phase: 'done', evidence: { commitSha: 'abc123' } }).statusText, '已合并完成')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  listProjectBranches,
  listProjectTree,
  readProjectFile,
  listProjectCommits,
  readProjectCommitDiff,
} from '../src/server/git-engine.mjs'
import {
  computeNextRunAt,
  formatScheduleRuleLabel,
  normalizeScheduleInput,
} from '../src/server/schedule-engine.mjs'
import {
  parseKimiUsagePayload,
  maskSecret,
  maskAccountHint,
  readLocalTokenUsageSummary,
} from '../src/server/quota-engine.mjs'
import { detectCompletionEvents } from '../src/client/notifications.js'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'

function initTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-v080-repo-'))
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# Demo Project\n\nHello from main.\n')
  writeFileSync(join(dir, 'src', 'index.js'), 'export const answer = 42\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: dir })
  // Create a feature branch with a different file without leaving main dirty
  execFileSync('git', ['checkout', '-b', 'ekko-todo/td-demo'], { cwd: dir })
  writeFileSync(join(dir, 'src', 'feature.js'), 'export const feature = true\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'feat: add feature module'], { cwd: dir })
  execFileSync('git', ['checkout', 'main'], { cwd: dir })
  return dir
}

test('v0.8.0: Read-only project browser reads branches, trees, files, commits & diffs without touching working tree', async () => {
  const repoDir = initTempGitRepo()
  try {
    const todos = [{ id: 'td-demo', number: 7, title: '新增特征模块', branch: 'ekko-todo/td-demo', phase: 'review' }]
    const br = await listProjectBranches(repoDir, 'main', todos)
    assert.equal(br.currentBranch, 'main')
    assert.equal(br.branches.length, 2)
    const featBr = br.branches.find(b => b.name === 'ekko-todo/td-demo')
    assert.equal(featBr?.todoNumber, 7)
    assert.equal(featBr?.todoTitle, '新增特征模块')

    // Read root tree on main: folders first (`src`), then files (`README.md`)
    const rootTree = await listProjectTree(repoDir, 'main', '')
    assert.equal(rootTree.entries[0].type, 'dir')
    assert.equal(rootTree.entries[0].name, 'src')
    assert.equal(rootTree.entries[1].type, 'file')
    assert.equal(rootTree.entries[1].name, 'README.md')

    // Read feature file purely from feature branch while checkout stays on main!
    const featFile = await readProjectFile(repoDir, 'ekko-todo/td-demo', 'src/feature.js')
    assert.equal(featFile.kind, 'text')
    assert.match(featFile.content, /feature = true/)

    // Path traversal must be rejected
    await assert.rejects(() => readProjectFile(repoDir, 'main', '../etc/passwd'), /Invalid repository path/)

    // Read commits and diff on feature branch
    const logRes = await listProjectCommits(repoDir, 'ekko-todo/td-demo', 10)
    assert.equal(logRes.commits.length, 2)
    assert.equal(logRes.commits[0].subject, 'feat: add feature module')
    const diffRes = await readProjectCommitDiff(repoDir, logRes.commits[0].sha)
    assert.equal(diffRes.files.length, 1)
    assert.equal(diffRes.files[0].path, 'src/feature.js')
    assert.match(diffRes.patch, /\+export const feature = true/)

    // Verify main checkout is completely untouched
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }).trim()
    assert.equal(status, '')
    const curBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim()
    assert.equal(curBranch, 'main')
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('v0.8.0: Wall-clock Schedule Engine computes next runs accurately and orchestrator/MCP manage & trigger schedules', async () => {
  // 1) Pure wall-clock unit checks
  const baseMs = Date.parse('2026-11-23T00:30:00Z') // 08:30 Asia/Shanghai
  const dailyNext = computeNextRunAt(
    normalizeScheduleInput({ frequency: 'daily', hour: 9, minute: 0, timezone: 'Asia/Shanghai', enabled: true }),
    baseMs,
  )
  assert.equal(new Date(dailyNext).toISOString(), '2026-11-23T01:00:00.000Z') // 09:00 CST

  const hourlyNext = computeNextRunAt(
    normalizeScheduleInput({ frequency: 'hourly', minute: 15, timezone: 'Asia/Shanghai', enabled: true }),
    baseMs,
  )
  assert.equal(new Date(hourlyNext).toISOString(), '2026-11-23T01:15:00.000Z')

  const label = formatScheduleRuleLabel({ frequency: 'weekly', weekday: 2, hour: 9, minute: 5 })
  assert.equal(label, '每周二 09:05')

  // 2) Full DB + Orchestrator + Chief MCP integration
  const dataDir = mkdtempSync(join(tmpdir(), 'ekko-v080-sched-'))
  const repoDir = initTempGitRepo()
  try {
    const db = createDatabase(dataDir)
    let startedRuns = 0
    const ctx = {
      paths: { dataDir },
      config: { maxConcurrentBuilds: 2 },
      log: { info() {}, warn() {}, error() {} },
      messages: { emit() {} },
      extensions: { tools: { register(def) { registeredTools.set(def.name, def); return () => {} } } },
    }
    const registeredTools = new Map()
    const run = {
      identity: { userId: 1, profile: 'default' },
      host: {
        agents: { list: async () => [{ id: 'hermes', name: 'Hermes Agent', installed: true }] },
        sessions: {
          create: async () => ({ session_id: `sess-${++startedRuns}` }),
          setWorkspace: async () => {},
          setModel: async () => {},
          run: async () => ({ run_id: `run-${startedRuns}` }),
          stop: async () => {},
          messages: async () => ({ messages: [] }),
        },
      },
    }
    const orchestrator = createOrchestrator({ ctx, db, dataDir, config: { maxConcurrentBuilds: 2 } })
    registerMcpTools(ctx, { db, orchestrator })

    const { project } = await orchestrator.addProject(run, { name: 'Demo', repoPath: repoDir })
    const { todo } = await orchestrator.createTodo(run, { projectId: project.id, title: '每日巡检任务', spec: '检查核心测试' })

    // Chief creates schedule via MCP tool `create_schedule`
    const createRes = await registeredTools.get('create_schedule').execute({
      todo_id: todo.id,
      frequency: 'daily',
      hour: 9,
      minute: 0,
      timezone: 'Asia/Shanghai',
    }, run)
    assert.equal(createRes.ok, true)
    assert.match(createRes.content, /每天 09:00/)
    const schId = createRes.data.schedule.id

    // Chief lists schedules
    const listRes = await registeredTools.get('list_schedules').execute({}, run)
    assert.equal(listRes.ok, true)
    assert.equal(listRes.data.schedules.length, 1)

    // Simulate due schedule on a closed todo -> must skip deliberately & record reason
    await orchestrator.closeTodo(run, { todoId: todo.id })
    db.updateSchedule(1, 'default', schId, { nextRunAt: Date.now() - 5000 })
    const tickedSkip = await orchestrator.tickDueSchedules(run)
    assert.equal(tickedSkip, 1)
    const afterSkip = db.getSchedule(1, 'default', schId)
    assert.equal(afterSkip.lastStatus, 'skipped')
    assert.match(afterSkip.lastMessage, /已关闭/)
    assert.ok(afterSkip.nextRunAt > Date.now(), 'missed cycle must advance to future slot without backfill')

    // Reopen todo and fire a due one-shot schedule -> must start fresh build and auto-disable one-shot rule
    await orchestrator.reopenTodo(run, { todoId: todo.id })
    const onceCreated = await orchestrator.saveSchedule(run, {
      todoId: todo.id,
      frequency: 'once',
      runAtIso: '2026-11-23T01:00:00Z',
      timezone: 'Asia/Shanghai',
    })
    const onceId = onceCreated.schedule.id
    db.updateSchedule(1, 'default', onceId, { nextRunAt: Date.now() - 2000 })
    const tickedOnce = await orchestrator.tickDueSchedules(run)
    assert.equal(tickedOnce, 1)
    const afterOnce = db.getSchedule(1, 'default', onceId)
    assert.equal(afterOnce.lastStatus, 'triggered')
    assert.equal(afterOnce.enabled, false)
    assert.equal(afterOnce.nextRunAt, 0)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'building')

    // Chief deletes schedule via MCP
    const delRes = await registeredTools.get('delete_schedule').execute({ schedule_id: schId }, run)
    assert.equal(delRes.ok, true)
    assert.equal(db.getSchedule(1, 'default', schId), null)

    db.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('v0.8.0: Quota engine parses Kimi dual formats honestly, masks secrets in DB snapshots, and detects completion notifications', async () => {
  // 1) Kimi empty reply must NEVER fake 0% used / 100% remaining
  const emptyParsed = parseKimiUsagePayload({})
  assert.equal(emptyParsed.empty, true)
  assert.equal(emptyParsed.windows.length, 0)

  // 2) Kimi mixed legacy + new quota model: protects non-zero legacy counter from contradictory zero ratio
  const mixed = parseKimiUsagePayload({
    usage: { limit: '100', used: '45', resetTime: '2026-11-30T00:00:00Z' },
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '51', resetTime: '2026-11-23T12:00:00Z' } }],
    usages: {
      limit_7d: { used_ratio: 0, reset_time: '2026-11-30T00:00:00Z' },
      limit_month_total: { used_ratio: 0.25, reset_time: '2026-12-01T00:00:00Z' },
    },
    user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
  })
  assert.equal(mixed.empty, false)
  const w5h = mixed.windows.find(w => w.id === 'kimi-5h')
  const w7d = mixed.windows.find(w => w.id === 'kimi-7d')
  const wMo = mixed.windows.find(w => w.id === 'kimi-month')
  assert.equal(w5h?.remainingPct, 51)
  assert.equal(w7d?.usedPct, 45, 'must not overwrite valid legacy 45% with contradictory 0 ratio')
  assert.equal(wMo?.usedPct, 25)

  // 3) Secret & account redaction + DB persistence masking
  assert.equal(maskSecret('sk-deepseek-secret-99887766'), 'sk-d••••7766')
  assert.equal(maskAccountHint('alice@example.com'), 'al***@ex***.com')

  const dataDir = mkdtempSync(join(tmpdir(), 'ekko-v080-quota-'))
  try {
    const db = createDatabase(dataDir)
    const defaults = db.listQuotaProviders(1, 'default')
    assert.equal(defaults.length, 7)
    assert.equal(defaults.some(p => p.id === 'magpie'), false, 'magpie provider must be removed')
    assert.deepEqual(
      defaults.filter(p => p.enabled).map(p => p.id),
      ['kimi', 'grok', 'deepseek', 'antigravity'],
    )
    const updated = db.upsertQuotaProvider(1, 'default', {
      id: 'deepseek',
      secretValue: 'sk-test-secret-123456',
      sourceMode: 'direct',
    })
    assert.equal(updated.hasSecret, true)
    assert.equal(updated.secretPreview, 'sk-t••••3456')
    assert.equal(updated.secretValue, undefined, 'public provider view must NEVER expose raw secretValue')
    const raw = db.getQuotaProviderRaw(1, 'default', 'deepseek')
    assert.equal(raw.secretValue, 'sk-test-secret-123456')

    // Local token usage summary returns clean schema
    const summary = readLocalTokenUsageSummary('7d', { totalTodos: 5, doneTodos: 3, activeTodos: 1, topicCount: 2 })
    assert.equal(summary.ekkoActivity.doneTodos, 3)
    assert.equal(typeof summary.totals.cacheHitRate, 'number')
    db.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }

  // 4) Completion & human-gate notification detector
  const prevState = {
    todos: [
      { id: 'td-1', number: 1, title: '构建任务', phase: 'merging', gateOwner: 'none', revision: 3 },
      { id: 'td-2', number: 2, title: '方案审批', phase: 'building', gateOwner: 'none', revision: 2 },
    ],
    topics: [{ id: 'tp-1', title: '总管话题', isRunning: true, brief: { waitingOnYou: '' }, messages: [] }],
  }
  const nextState = {
    todos: [
      { id: 'td-1', number: 1, title: '构建任务', phase: 'done', gateOwner: 'none', revision: 4 },
      { id: 'td-2', number: 2, title: '方案审批', phase: 'confirm', gateOwner: 'human', gateKind: 'plan', revision: 3 },
    ],
    topics: [{ id: 'tp-1', title: '总管话题', isRunning: false, brief: { waitingOnYou: '请确认上线时间' }, messages: [] }],
  }
  const evs = detectCompletionEvents(prevState, nextState)
  assert.equal(evs.length, 3)
  assert.equal(evs[0].tone, 'success')
  assert.match(evs[0].title, /#1 已完成/)
  assert.equal(evs[1].tone, 'attention')
  assert.match(evs[1].title, /#2 方案已就绪/)
  assert.equal(evs[2].tone, 'attention')
  assert.match(evs[2].title, /大总管待你确认/)
})

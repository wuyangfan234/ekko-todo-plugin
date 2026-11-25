import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { transitionTodoPhase } from '../src/server/state-machine.mjs'
import { generateRandomNotionAvatar, validateAvatarValue } from '../src/server/avatars.mjs'
import {
  resolveChiefRecommendation,
  getTodoCardStateMeta,
  formatShortClock,
  formatMessageTimeDivider,
  shouldShowTimeDivider,
} from '../src/client/utils.js'

function initTempRepo(rootDir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: rootDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rootDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: rootDir, stdio: 'ignore' })
  writeFileSync(join(rootDir, 'README.md'), '# Sample Repo\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: rootDir, stdio: 'ignore' })
}

test('v0.6.0: Notion-style humanized avatars validate seeds, generate non-repeating IDs, and block SVG XSS', () => {
  const generated = new Set()
  for (let i = 0; i < 30; i += 1) {
    const id = generateRandomNotionAvatar('agent')
    assert.match(id, /^notion:agent-[a-f0-9]{10}$/)
    assert.equal(validateAvatarValue(id, { allowPreset: true }), id)
    generated.add(id)
  }
  assert.equal(generated.size, 30, '30 generated avatars must all be unique')

  assert.equal(validateAvatarValue('preset:chief-compass', { allowPreset: true }), 'preset:chief-compass')
  assert.throws(() => validateAvatarValue('notion:bad seed with space!', { allowPreset: true }), /头像标识格式不合法/)
  assert.throws(() => validateAvatarValue('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', { allowPreset: true }), /不支持 SVG/)

  // Todos-style message time divider & clock formatting
  const now = Date.now()
  assert.match(formatShortClock(now), /^\d{2}:\d{2}$/)
  assert.match(formatMessageTimeDivider(now), /^\d{2}:\d{2}$/)
  assert.match(formatMessageTimeDivider(now - 24 * 60 * 60 * 1000), /^昨天 \d{2}:\d{2}$/)
  assert.equal(shouldShowTimeDivider(0, now), true)
  assert.equal(shouldShowTimeDivider(now - 60 * 1000, now), false)
  assert.equal(shouldShowTimeDivider(now - 6 * 60 * 1000, now), true)
})

test('v0.6.0: XState merging phase, idempotent async merge lock, no Chief self-wake deadlock, and 500+ maxTurns', async () => {
  assert.equal(transitionTodoPhase('review', 'START_MERGE'), 'merging')
  assert.equal(transitionTodoPhase('merging', 'MERGE_COMPLETED'), 'done')
  assert.equal(transitionTodoPhase('merging', 'MERGE_FAILED'), 'failed')
  assert.equal(getTodoCardStateMeta({ phase: 'merging' }).running, true)

  const workDir = mkdtempSync(join(tmpdir(), 'ekko-v060-'))
  const repoDir = join(workDir, 'repo')
  const dataDir = join(workDir, 'data')
  try {
    execFileSync('mkdir', ['-p', repoDir])
    initTempRepo(repoDir)

    const db = createDatabase(dataDir)
    const orchestrator = createOrchestrator({ db, dataDir })

    const sessionRuns = []
    const sessionCategories = []
    const sessionCategoryAssignments = []
    const archivedSessions = []
    const workingState = new Map()
    const hostMessagesBySession = new Map()
    let sessionSeq = 0

    const run = {
      identity: { userId: 1, profile: 'default' },
      messages: { emit() {} },
      host: {
        agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } } },
        async request(path, opts = {}) {
          if (path === '/api/studio/session-categories' && (!opts.method || opts.method === 'GET')) {
            return { categories: sessionCategories }
          }
          if (path === '/api/studio/session-categories' && opts.method === 'POST') {
            const cat = { id: sessionCategories.length + 1, name: opts.body.name }
            sessionCategories.push(cat)
            return { category: cat }
          }
          const catMatch = path.match(/^\/api\/studio\/sessions\/([^/]+)\/category$/)
          if (catMatch && opts.method === 'POST') {
            sessionCategoryAssignments.push({ sid: decodeURIComponent(catMatch[1]), categoryId: opts.body.categoryId })
            return { ok: true, category_id: opts.body.categoryId }
          }
          return {}
        },
        sessions: {
          async create(body) {
            sessionSeq += 1
            const id = `sess-${sessionSeq}`
            hostMessagesBySession.set(id, [])
            return { session: { id, title: body.title } }
          },
          async setWorkspace() {},
          async setModel() {},
          async archive(sid, flag) { archivedSessions.push({ sid, flag }) },
          async get(sid) {
            // Mirror real Studio response: intentionally NO `is_running` field!
            return { session: { id: sid, ended_at: null } }
          },
          async connect(sid, cb) {
            setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(workingState.get(sid)), runStartedAt: Date.now() - 5000 }), 5)
            return { close() {} }
          },
          async run(sid, input, opts) {
            sessionRuns.push({ sid, input, opts })
            workingState.set(sid, true)
            return { run_id: `run-${sessionRuns.length}` }
          },
          async stop(sid) { workingState.set(sid, false) },
          async messages(sid) { return { messages: hostMessagesBySession.get(sid) || [] } },
        },
      },
    }

    // 1. Agent maxTurns supports 0 (unlimited -> omits max_turns) AND 650 (> 100!)
    const { agent: unlimitedAgent } = await orchestrator.saveAgent(run, {
      name: '深度重构主程',
      role: 'builder',
      roleLabel: '深度开发',
      engine: 'hermes',
      mode: 'scoped',
      maxTurns: 0,
    })
    assert.equal(unlimitedAgent.maxTurns, 0)
    assert.match(unlimitedAgent.avatar, /^notion:/)

    const { agent: heavyAgent } = await orchestrator.saveAgent(run, {
      id: unlimitedAgent.id,
      name: '深度重构主程',
      role: 'builder',
      engine: 'hermes',
      mode: 'scoped',
      maxTurns: 650,
    })
    assert.equal(heavyAgent.maxTurns, 650)

    // 2. Project + Topic + external Web-UI run sync + fail-closed reconcile
    const { project } = await orchestrator.addProject(run, { name: 'demo-repo', repoPath: repoDir })
    const { topic } = await orchestrator.createTopic(run, { projectId: project.id, autopilot: true })
    await orchestrator.sendTopicMessage(run, { topicId: topic.id, text: '先检查分支情况' })

    // Verify automatic Studio Web-UI category isolation created 'Ekko ToDo' and assigned Chief session!
    assert.equal(sessionCategories.length, 1)
    assert.equal(sessionCategories[0].name, 'Ekko ToDo')
    assert.ok(sessionCategoryAssignments.some(a => a.sid === 'sess-1' && a.categoryId === 1))

    // Reconcile while Chief is ACTUALLY working (despite GET /sessions/:id lacking is_running!) must NOT mark isRunning=false
    const recWhileWorking = await orchestrator.reconcileActiveRuns(run)
    assert.equal(recWhileWorking.syncedCount, 0)
    assert.equal(db.getTopic(1, 'default', topic.id).isRunning, true)

    // Simulate external run in Web-UI: mark DB isRunning=0, keep host workingState=true + external user message
    db.updateTopic(1, 'default', topic.id, { isRunning: false })
    hostMessagesBySession.get('sess-1').push(
      { id: 'h-1', role: 'user', content: '在 Web-UI 直接发的消息', timestamp: Math.floor(Date.now() / 1000) },
      { id: 'h-2', role: 'assistant', content: '结论先说：建议直接清理旧分支', timestamp: Math.floor(Date.now() / 1000) + 1 },
    )
    const syncedSnap = await orchestrator.syncTopicSession(run, { topicId: topic.id })
    const syncedTopic = syncedSnap.topics.find(t => t.id === topic.id)
    assert.equal(syncedTopic.isRunning, true, 'syncTopicSession must detect active Web-UI run via live isWorking probe')
    assert.ok(syncedTopic.messages.some(m => m.kind === 'human' && m.text.includes('在 Web-UI 直接发的消息')))
    assert.ok(syncedTopic.messages.some(m => m.kind === 'chief' && m.text.includes('建议直接清理旧分支')))

    // Simulate live tool event -> liveActivity appears on snapshot!
    // (0.9.54: a Chief `terminal` call is now stopped by the strict guard, so a read-only tool is used here.)
    await orchestrator.handleHostEvent({ type: 'chat.tool.started', data: { session_id: 'sess-1', name: 'read_file' } }, run)
    const snapWithTool = await orchestrator.getSnapshot(run)
    assert.equal(snapWithTool.topics[0].liveActivity?.activeTool, 'read_file')
    assert.equal(snapWithTool.topics[0].liveActivity?.toolCount, 1)

    // 3. Test hidden isolation mode returns immediately (non-blocking!) and archives existing sessions in background
    const tIso0 = Date.now()
    const hiddenSnap = await orchestrator.saveSettings(run, { sessionIsolationMode: 'hidden', sessionCategoryName: 'Ekko ToDo' })
    assert.equal(hiddenSnap.settings.sessionIsolationMode, 'hidden')
    assert.ok(Date.now() - tIso0 < 500, 'mode switch must return immediately without blocking on session sync')
    for (let i = 0; i < 40; i += 1) {
      if (archivedSessions.some(a => a.sid === 'sess-1' && a.flag === true)) break
      await new Promise(r => setTimeout(r, 20))
    }
    assert.ok(archivedSessions.some(a => a.sid === 'sess-1' && a.flag === true))

    // 4. Create todo -> build -> pass max_turns: 650 -> settle review (empty review output must NOT auto-approve!)
    const { todo } = await orchestrator.createTodo(run, {
      projectId: project.id,
      topicId: topic.id,
      title: '测试并发加固合并',
      agentId: heavyAgent.id,
      startImmediately: true,
    })
    const workerRunCall = sessionRuns.find(r => r.sid === todo.buildSessionId)
    assert.equal(workerRunCall?.opts?.max_turns, 650, 'explicit maxTurns > 0 must forward max_turns')

    // Write a change inside worktree so merge does real git work
    writeFileSync(join(todo.worktreePath, 'added.txt'), 'hello v0.6.0\n', 'utf8')
    workingState.set(todo.buildSessionId, false)
    await orchestrator.reconcileActiveRuns(run)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'review')

    // Dispatch review, settle with EMPTY assistant message -> never approved. Since 0.9.49 (#47) it is not a
    // rejection either: the reviewer is asked once for the verdict, a second empty turn is `inconclusive`.
    const revTodo = await orchestrator.runIndependentReview(run, { todoId: todo.id })
    await orchestrator.settleWorkerRun(run, 1, 'default', revTodo.id, { sessionId: revTodo.reviewSessionId, outcome: 'completed' })
    assert.equal(db.getTodo(1, 'default', revTodo.id).evidence.reviewVerdict, 'pending')
    assert.equal(db.getTodo(1, 'default', revTodo.id).phase, 'reviewing')
    await orchestrator.settleWorkerRun(run, 1, 'default', revTodo.id, { sessionId: revTodo.reviewSessionId, outcome: 'completed' })
    assert.equal(db.getTodo(1, 'default', revTodo.id).evidence.reviewVerdict, 'inconclusive')
    assert.equal(db.getTodo(1, 'default', revTodo.id).gateOwner, 'human')

    // Move back to review & test idempotent async merge (moves immediately to 'merging', no duplicate Chief wake!)
    db.updateTodo(1, 'default', todo.id, { phase: 'review', gateOwner: 'human', gateKind: 'merge' })
    workingState.set('sess-1', false)
    db.updateTopic(1, 'default', topic.id, { isRunning: false })
    const runsBeforeMerge = sessionRuns.length

    const firstMerge = await orchestrator.mergeBuild(run, { todoId: todo.id, caller: 'user', asyncMode: true })
    assert.equal(firstMerge.phase, 'merging', 'UI merge must transition immediately to merging (执行中)')

    // Concurrent second click while merging is a safe idempotent no-op
    const secondMerge = await orchestrator.mergeBuild(run, { todoId: todo.id, caller: 'user', asyncMode: true })
    assert.equal(secondMerge.phase, 'merging')

    // Wait briefly for background git merge to finish
    for (let i = 0; i < 160; i += 1) {
      if (db.getTodo(1, 'default', todo.id).phase === 'done') break
      await new Promise(r => setTimeout(r, 50))
    }
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'done')
    // Wait briefly for async wake deduplication
    await new Promise(r => setTimeout(r, 100))
    const wakeRunsAdded = sessionRuns.length - runsBeforeMerge
    assert.ok(wakeRunsAdded <= 1, `merge must wake Chief at most ONCE, got ${wakeRunsAdded}`)

    // 5. Verify Chief recommendation default extraction & waitingRecommendation
    const rec1 = resolveChiefRecommendation({
      waitingOnYou: '旧分支 fix/x 建议直接弃用删除（无合并价值）；是否挑两行加固',
      waitingRecommendation: '直接删除旧分支 fix/x，并单独建单落地两行加固',
    })
    assert.equal(rec1, '直接删除旧分支 fix/x，并单独建单落地两行加固')

    const rec2 = resolveChiefRecommendation({
      waitingOnYou: '旧分支 fix/old 建议直接弃用删除（无合并价值）；是否保留由你定',
    })
    assert.ok(rec2.includes('直接弃用删除'))

    db.close()
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

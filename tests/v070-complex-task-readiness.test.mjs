import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { ensureWorktree, removeWorktree, inspectProjectRepoReadOnly } from '../src/server/git-engine.mjs'
import { transitionTodoPhase } from '../src/server/state-machine.mjs'
import { isImeComposingEvent, getTodoCardStateMeta } from '../src/client/utils.js'

function initRepoWithIgnoredDeps(repoDir) {
  mkdirSync(repoDir, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' })
  writeFileSync(join(repoDir, '.gitignore'), '.venv/\nbackend/.venv/\nnode_modules/\n.env\n', 'utf8')
  writeFileSync(join(repoDir, 'app.py'), 'print("ok")\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' })

  // Create gitignored local dependencies (.venv & node_modules) in main repo
  mkdirSync(join(repoDir, 'backend', '.venv', 'bin'), { recursive: true })
  writeFileSync(join(repoDir, 'backend', '.venv', 'bin', 'python'), '#!/bin/sh\necho py\n', 'utf8')
  mkdirSync(join(repoDir, 'node_modules', 'demo-pkg'), { recursive: true })
  writeFileSync(join(repoDir, 'node_modules', 'demo-pkg', 'index.js'), 'export const x = 1\n', 'utf8')
}

test('v0.7.0: CJK/English IME guard blocks composing Enter and 120ms WebKit post-composition race', () => {
  const compRef = { current: true }
  const endRef = { current: 0 }
  assert.equal(isImeComposingEvent({ key: 'Enter' }, compRef, endRef), true)
  compRef.current = false
  assert.equal(isImeComposingEvent({ key: 'Enter', nativeEvent: { isComposing: true } }, compRef, endRef), true)
  assert.equal(isImeComposingEvent({ key: 'Enter', keyCode: 229 }, compRef, endRef), true)
  assert.equal(isImeComposingEvent({ key: 'Process' }, compRef, endRef), true)
  endRef.current = Date.now() - 40
  assert.equal(isImeComposingEvent({ key: 'Enter' }, compRef, endRef), true)
  endRef.current = Date.now() - 250
  assert.equal(isImeComposingEvent({ key: 'Enter' }, compRef, endRef), false)
  assert.equal(getTodoCardStateMeta({ phase: 'queued' }).tone, 'queued')
})

test('v0.7.0: Worktree auto-symlinks gitignored .venv/node_modules and safely unlinks on cleanup without touching main repo', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ekko-v070-wt-'))
  const repoDir = join(workDir, 'repo')
  const wtRoot = join(workDir, 'worktrees')
  try {
    initRepoWithIgnoredDeps(repoDir)
    const wt = await ensureWorktree({
      repoPath: repoDir,
      worktreesDir: wtRoot,
      worktreeName: 'proj-1',
      branchName: 'ekko-todo/proj-1',
      baseBranch: 'main',
    })
    assert.ok(wt.linkedDeps.includes('backend/.venv'), 'backend/.venv must be auto-symlinked')
    assert.ok(wt.linkedDeps.includes('node_modules'), 'node_modules must be auto-symlinked')
    assert.ok(lstatSync(join(wt.worktreePath, 'backend', '.venv')).isSymbolicLink())
    assert.ok(existsSync(join(wt.worktreePath, 'backend', '.venv', 'bin', 'python')))

    // Worktree git status remains 100% clean despite bootstrapped symlinks
    const wtStatus = execFileSync('git', ['status', '--porcelain'], { cwd: wt.worktreePath }).toString().trim()
    assert.equal(wtStatus, '')

    // Removing worktree MUST NOT touch or delete main repo's real .venv or node_modules!
    await removeWorktree({ repoPath: repoDir, worktreePath: wt.worktreePath, branchName: wt.branchName, deleteBranch: true })
    assert.equal(existsSync(wt.worktreePath), false)
    assert.equal(readFileSync(join(repoDir, 'backend', '.venv', 'bin', 'python'), 'utf8').trim(), '#!/bin/sh\necho py')
    assert.equal(readFileSync(join(repoDir, 'node_modules', 'demo-pkg', 'index.js'), 'utf8').trim(), 'export const x = 1')

    // Read-only project repo inspector works cleanly
    const report = await inspectProjectRepoReadOnly(repoDir, 'main')
    assert.equal(report.currentBranch, 'main')
    assert.equal(report.isClean, true)
    assert.equal(report.recentCommits.length, 1)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('v0.7.0: Serialized Chief queue prevents concurrent overlap, isolates Chief workspace, audits violations, and auto-drains queued todos & wakes', async () => {
  assert.equal(transitionTodoPhase('todo', 'ENQUEUE'), 'queued')
  assert.equal(transitionTodoPhase('queued', 'START_BUILD'), 'building')

  const workDir = mkdtempSync(join(tmpdir(), 'ekko-v070-orch-'))
  const repoDir = join(workDir, 'repo')
  const dataDir = join(workDir, 'data')
  try {
    initRepoWithIgnoredDeps(repoDir)
    const db = createDatabase(dataDir, { maxConcurrentBuilds: 1 })
    const orchestrator = createOrchestrator({ db, dataDir })

    const sessionRuns = []
    const sessionWorkspaces = new Map()
    const workingState = new Map()
    const hostMessages = new Map()
    let seq = 0

    const run = {
      identity: { userId: 1, profile: 'default' },
      messages: { emit() {} },
      host: {
        agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } } },
        sessions: {
          async create(body) {
            seq += 1
            const id = `s-${seq}`
            hostMessages.set(id, [])
            return { session: { id, title: body.title } }
          },
          async setWorkspace(sid, ws) { sessionWorkspaces.set(sid, ws) },
          async setModel() {},
          async get(sid) { return { session: { id: sid, ended_at: null } } },
          async connect(sid, cb) {
            setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(workingState.get(sid)), runStartedAt: Date.now() }), 4)
            return { close() {} }
          },
          async run(sid, input, opts) {
            sessionRuns.push({ sid, input, opts })
            workingState.set(sid, true)
            return { run_id: `r-${sessionRuns.length}` }
          },
          async stop(sid) { workingState.set(sid, false) },
          async messages(sid) { return { messages: hostMessages.get(sid) || [] } },
        },
      },
    }

    const { project } = await orchestrator.addProject(run, { name: 'complex-app', repoPath: repoDir })
    const { topic } = await orchestrator.createTopic(run, { projectId: project.id, autopilot: true })

    // 1. Send Msg #1 -> Chief starts in isolated chief-workspace (NOT project.repoPath!)
    await orchestrator.sendTopicMessage(run, { topicId: topic.id, text: '先评估复杂任务方案' })
    const chiefSid = db.getTopic(1, 'default', topic.id).chiefSessionId
    assert.equal(sessionRuns.length, 1)
    assert.ok(sessionWorkspaces.get(chiefSid).endsWith('chief-workspace'), 'Chief workspace must be physically isolated from project repo')
    assert.notEqual(sessionWorkspaces.get(chiefSid), project.repoPath)

    // 2. Send Msg #2 while Turn #1 is STILL running -> MUST queue, NOT fire a 2nd concurrent run!
    const snapQueued = await orchestrator.sendTopicMessage(run, { topicId: topic.id, text: '补充约束：不能改数据库表结构' })
    assert.equal(sessionRuns.length, 1, 'Second message while Chief is busy must NOT execute immediately')
    const topicView = snapQueued.topics.find(t => t.id === topic.id)
    assert.equal(topicView.queuedItems.length, 1)
    assert.ok(topicView.queuedItems[0].text.includes('不能改数据库表结构'))

    // 4. Concurrency limit = 1: create & start Todo #1 (building) + Todo #2 (auto-queued, NO error!)
    const { todo: td1 } = await orchestrator.createTodo(run, {
      projectId: project.id,
      topicId: topic.id,
      title: '子任务 A：后端加固',
      startImmediately: true,
    })
    const { todo: td2 } = await orchestrator.createTodo(run, {
      projectId: project.id,
      topicId: topic.id,
      title: '子任务 B：前端状态条',
      startImmediately: true,
    })
    assert.equal(td1.phase, 'building')
    assert.equal(td2.phase, 'queued', 'Overflow build must cleanly enter queued phase instead of throwing')

    // 5. Settle Todo #1 while Chief is STILL busy -> wake is queued (NOT dropped!) AND Todo #2 auto-launches into freed slot!
    workingState.set(td1.buildSessionId, false)
    await orchestrator.settleWorkerRun(run, 1, 'default', td1.id, { sessionId: td1.buildSessionId, outcome: 'completed' })
    // Allow async drainQueuedTodos microtask to complete
    for (let i = 0; i < 40; i += 1) {
      if (db.getTodo(1, 'default', td2.id).phase === 'building') break
      await new Promise(r => setTimeout(r, 25))
    }
    assert.equal(db.getTodo(1, 'default', td2.id).phase, 'building', 'Queued Todo #2 must auto-start once Todo #1 frees slot')
    const queueAfterWake = db.listTopicQueue(1, 'default', topic.id)
    assert.equal(queueAfterWake.length, 2, 'Both user follow-up AND automated wake must be preserved in topic_queue')
    assert.equal(queueAfterWake[0].kind, 'user')
    assert.equal(queueAfterWake[1].kind, 'wake')

    // 6. Finish Chief Turn #1 -> drainTopicQueue automatically pops Msg #2 (strict FIFO) and starts Turn #2!
    const runsBeforeDrain = sessionRuns.filter(r => r.sid === chiefSid).length
    workingState.set(chiefSid, false)
    await orchestrator.handleHostEvent({ type: 'chat.run.completed', data: { session_id: chiefSid } }, run)
    const runsAfterDrain = sessionRuns.filter(r => r.sid === chiefSid).length
    assert.equal(runsAfterDrain, runsBeforeDrain + 1, 'Finishing Turn #1 must automatically drain queued Msg #2')
    assert.equal(db.listTopicQueue(1, 'default', topic.id).length, 1, 'Only the wake item should remain queued for Turn #3')

    // 7. Read-only inspectProjectRepo works via orchestrator
    const repoInspect = await orchestrator.inspectProjectRepo(run, { projectId: project.id })
    assert.equal(repoInspect.currentBranch, 'main')
    assert.equal(repoInspect.isClean, true)

    // 8. 0.9.54 strict orchestration: the Chief writing ANY file (scratch dir or repo) stops the turn on the spot,
    //    leaves a notice and queues one correction telling it to dispatch instead. (Before 0.9.54 this was a
    //    warning only, and only for paths inside a project repo.)
    await orchestrator.handleHostEvent({
      type: 'chat.tool.started',
      data: { session_id: chiefSid, name: 'write_file', arguments: { path: join(tmpdir(), 'ekko-scratch', 'deploy.sh') } },
    }, run)
    const afterGuard = db.getTopic(1, 'default', topic.id)
    assert.ok(afterGuard.messages.some(m => m.text.startsWith('总管越界，已中止本轮') && m.text.includes('write_file')), 'Chief write_file must stop the turn with a notice')

    db.close()
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

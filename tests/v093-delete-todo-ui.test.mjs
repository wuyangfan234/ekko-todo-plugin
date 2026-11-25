// v0.9.3: user can delete a todo card; composer UI standards.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'

function fakeHost() {
  let n = 0
  const sessions = new Map()
  const stopped = []
  return {
    stopped,
    host: {
      agents: { list: async () => ({ agents: [] }) }, request: async () => null,
      sessions: {
        create: async () => { const id = `s${++n}`; sessions.set(id, { id, messages: [], is_running: false }); return { session: { id } } },
        setWorkspace: async () => {}, setModel: async () => {},
        run: async id => { sessions.get(id).is_running = true; return { run_id: `r${n}` } },
        stop: async id => { stopped.push(id); return { ok: true } },
        messages: async id => ({ messages: sessions.get(id)?.messages || [] }),
        get: async id => ({ session: { id, is_running: sessions.get(id)?.is_running || false } }),
      },
    },
  }
}

test('v0.9.3: deleting a todo stops its run, removes worktree, keeps unmerged branch, drops watches/schedules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-del-'))
  try {
    const repoPath = join(root, 'repo'); mkdirSync(repoPath)
    const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
    g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
    writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
    const db = createDatabase(join(root, 'data'), { maxConcurrentBuilds: 2 })
    const orch = createOrchestrator({ db, dataDir: join(root, 'data'), config: { maxConcurrentBuilds: 2 } })
    const fake = fakeHost()
    const run = { identity: { userId: 1, profile: 'default' }, host: fake.host, messages: { emit() {} } }
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    const { topic } = await orch.createTopic(run, { projectId: project.id })

    // Running todo with an unmerged commit on its branch
    const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: '要删的任务' })
    const building = await orch.startBuild(run, { todoId: todo.id })
    assert.equal(building.phase, 'building')
    writeFileSync(join(building.worktreePath, 'b.txt'), 'wip\n')
    execFileSync('git', ['add', '.'], { cwd: building.worktreePath }); execFileSync('git', ['commit', '-m', 'wip'], { cwd: building.worktreePath })
    db.watchTodo(1, 'default', topic.id, todo.id, 'test')
    db.createSchedule(1, 'default', { projectId: project.id, todoId: todo.id, frequency: 'daily', hour: 9, minute: 0 })

    const out = await orch.deleteTodo(run, { todoId: todo.id })
    assert.equal(db.getTodo(1, 'default', todo.id), null)
    assert.ok(fake.stopped.includes(building.buildSessionId), 'live build session stopped')
    assert.equal(existsSync(building.worktreePath), false, 'worktree removed')
    assert.equal(out.branchKept, true, 'unmerged branch kept')
    assert.ok(g('branch', '--list', building.branch).length > 0)
    assert.equal(db.getActiveWatchesForTodo(1, 'default', todo.id).length, 0)
    assert.equal(db.listSchedules(1, 'default').filter(s => s.todoId === todo.id).length, 0)

    // Merged branch is cleaned up
    const { todo: t2 } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: '已合并' })
    assert.equal(t2.number, todo.number + 1, 'numbers are never reused after delete')
    const b2 = await orch.startBuild(run, { todoId: t2.id })
    assert.notEqual(b2.branch, building.branch)
    const out2 = await orch.deleteTodo(run, { todoId: t2.id })
    assert.equal(out2.branchKept, false, 'branch with no extra commits is deleted')
    assert.equal(g('branch', '--list', b2.branch), '')

    // A merging todo cannot be deleted
    const { todo: t3 } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: '合并中' })
    db.updateTodo(1, 'default', t3.id, { phase: 'merging' })
    await assert.rejects(() => orch.deleteTodo(run, { todoId: t3.id }), /合并/)
    db.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('v0.9.3: todo-action contract and UI expose delete; composer has no inner ring and auto-grows', () => {
  const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
  assert.ok(contract.models.todoActionInput.properties.action.enum.includes('delete'))
  const drawer = readFileSync(new URL('../src/client/components/TodoDrawer.jsx', import.meta.url), 'utf8')
  assert.match(drawer, /btn-drawer-delete-confirm/)
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.ot-composer textarea:focus-visible \{[\s\S]*?outline: none;[\s\S]*?border-radius: 0;|\.ot-composer textarea:focus-visible \{[\s\S]*?border-radius: 0;[\s\S]*?outline: none;/)
  const chat = readFileSync(new URL('../src/client/components/ChatPane.jsx', import.meta.url), 'utf8')
  assert.match(chat, /Auto-grow the composer/)
})

// Regression tests for the Todo #11 adversarial audit: unbounded growth and real lifecycle bugs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { fitSnapshotBudget, HOST_JSON_LIMIT, SNAPSHOT_BUDGET } from '../src/server/diff-budget.mjs'

const L = x => Buffer.byteLength(JSON.stringify(x))

function makeFakeHost() {
  let seq = 0
  const sessions = new Map()
  const stops = []
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${seq}` }
      },
      async stop(id) { stops.push(id); const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { const s = sessions.get(id); return { messages: s?.messages || [] } },
    },
  }
  return { host, sessions, stops }
}

async function setup({ maxConcurrentBuilds = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit11-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds }, log: { warn() {}, info() {} } })
  const fake = makeFakeHost()
  const run = { identity: { userId: 1, profile: 'default' }, host: fake.host, messages: { emit() {} } }
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0, maxConcurrentBuilds })
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
  g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
  const { project } = await orch.addProject(run, { name: 'P', repoPath, testCommand: 'true' })
  const cleanup = () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, fake, run, project, repoPath, g, cleanup }
}

function finish(fake, sid, text = 'done') {
  const s = fake.sessions.get(sid)
  s.is_running = false
  s.messages.push({ id: `a-${Math.random().toString(36).slice(2, 8)}`, role: 'assistant', content: text, timestamp: Math.floor(Date.now() / 1000) })
}

async function buildToReview(ctx, { title = 'T', commit = true } = {}) {
  const { db, orch, fake, run, project } = ctx
  const { todo } = await orch.createTodo(run, { projectId: project.id, title })
  const b = await orch.startBuild(run, { todoId: todo.id })
  writeFileSync(join(b.worktreePath, 'a.txt'), `change ${title}\n`)
  if (commit) {
    const wg = (...a) => execFileSync('git', a, { cwd: b.worktreePath, stdio: 'pipe' })
    wg('add', '-A'); wg('-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-m', 'work')
  }
  finish(fake, b.buildSessionId)
  await orch.reconcileActiveRuns(run)
  return { todo: db.getTodo(1, 'default', todo.id), build: b }
}

/* ---------- Snapshot size: the board must load however much history has piled up ---------- */

test('audit#11 snapshot stays under the host limit when many finished todos pile up', () => {
  const todos = Array.from({ length: 200 }, (_, i) => ({
    id: `td-${i}`, number: i + 1, phase: 'done', updatedAt: i, spec: 's'.repeat(1300), diffs: [], timeline: [],
    buildChat: Array.from({ length: 12 }, () => ({ role: '开发 Agent', text: 'c'.repeat(1200) })),
  }))
  const active = { id: 'td-live', number: 999, phase: 'building', updatedAt: 10_000, spec: 'live', diffs: [], timeline: [], buildChat: [{ role: '执行进度', text: 'working' }] }
  const snap = { topics: [], todos: [...todos, active] }
  assert.ok(L(snap) > HOST_JSON_LIMIT, 'fixture is genuinely oversized')
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.snapshotTrimmed, true)
  // A running card whose content is already small comes through unchanged (larger ones are shortened, never left out).
  assert.deepEqual(fitted.todos.find(t => t.id === 'td-live'), active)
  // Every card is still on the board with its spec; only finished worker chat was shortened, oldest first.
  assert.equal(fitted.todos.length, 201)
  assert.ok(fitted.todos.every(t => t.spec))
  const newest = fitted.todos.find(t => t.id === 'td-199')
  const oldest = fitted.todos.find(t => t.id === 'td-0')
  assert.equal(oldest.buildChatTrimmed, true)
  assert.ok(oldest.buildChat.length < 12)
  assert.ok(newest.buildChat.length >= oldest.buildChat.length, 'newer finished todos keep at least as much chat')
})

test('audit#11 snapshot stays under the host limit when topic conversations grow', () => {
  const mk = (id, updatedAt, archived, n) => ({
    id, updatedAt, archived,
    messages: Array.from({ length: n }, (_, k) => ({ id: `${id}-m${k}`, kind: k % 2 ? 'chief' : 'human', text: '字'.repeat(600), createdAt: k })),
  })
  const topics = [
    mk('t-archived', 5000, true, 300),
    ...Array.from({ length: 8 }, (_, i) => mk(`t-old-${i}`, 100 + i, false, 150)),
    mk('t-current', 9000, false, 150),
  ]
  const snap = { topics, todos: [] }
  assert.ok(L(snap) > HOST_JSON_LIMIT, 'fixture is genuinely oversized')
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.snapshotTrimmed, true)
  // The conversation the user touched last is the last one to lose anything.
  const current = fitted.topics.find(t => t.id === 't-current')
  assert.equal(current.messages.length, 150, 'most recently active topic is intact')
  assert.equal(current.messagesOmitted, undefined)
  // Trimmed topics keep their newest messages, in order, and report how many older ones were left out.
  const archived = fitted.topics.find(t => t.id === 't-archived')
  assert.ok(archived.messagesOmitted > 0)
  assert.equal(archived.messages.length + archived.messagesOmitted, 300)
  assert.equal(archived.messages[archived.messages.length - 1].id, 't-archived-m299')
  assert.ok(archived.messages.length >= 1)
  for (const t of fitted.topics) {
    const src = topics.find(x => x.id === t.id)
    assert.deepEqual(t.messages, src.messages.slice(src.messages.length - t.messages.length), `${t.id} keeps a contiguous newest tail`)
  }
})

test('audit#11 snapshot within budget is returned untouched', () => {
  const snap = { topics: [{ id: 't', updatedAt: 1, messages: [{ id: 'm', text: 'hi' }] }], todos: [{ id: 'x', phase: 'done', diffs: [], buildChat: [{ text: 'a' }] }] }
  assert.equal(fitSnapshotBudget(snap), snap)
})

/* ---------- Worktrees: finishing a card must not leave a full checkout on disk forever ---------- */

test('audit#11 marking a todo done removes its clean worktree and keeps the branch', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, g } = ctx
    const { todo, build } = await buildToReview(ctx, { commit: true })
    assert.equal(todo.phase, 'review')
    assert.ok(existsSync(build.worktreePath))
    const done = await orch.completeTodo(run, { todoId: todo.id })
    assert.equal(done.phase, 'done')
    assert.equal(existsSync(build.worktreePath), false, 'checkout is removed from disk')
    assert.equal(done.worktreePath, '')
    assert.equal(g('worktree', 'list').split('\n').length, 1, 'git no longer tracks the worktree')
    assert.ok(g('branch', '--list', todo.branch).includes(todo.branch), 'unmerged branch is kept')
    assert.equal(g('show', `${todo.branch}:a.txt`), 'change T', 'committed work is still on the branch')
    assert.equal(done.branch, todo.branch)
    // The card can be picked up again: the worktree is recreated from the kept branch.
    const again = await orch.startBuild(run, { todoId: todo.id })
    assert.equal(again.phase, 'building')
    assert.ok(existsSync(again.worktreePath))
    assert.equal(execFileSync('git', ['show', 'HEAD:a.txt'], { cwd: again.worktreePath }).toString().trim(), 'change T')
    void db
  } finally { ctx.cleanup() }
})

test('audit#11 a worktree with uncommitted changes is kept when the todo is marked done or closed', async () => {
  const ctx = await setup()
  try {
    const { orch, run } = ctx
    const a = await buildToReview(ctx, { title: 'A', commit: false })
    const done = await orch.completeTodo(run, { todoId: a.todo.id })
    assert.equal(done.phase, 'done')
    assert.ok(existsSync(a.build.worktreePath), 'uncommitted work is never deleted')
    assert.equal(done.worktreePath, a.build.worktreePath)
    const b = await buildToReview(ctx, { title: 'B', commit: false })
    const closed = await orch.closeTodo(run, { todoId: b.todo.id })
    assert.equal(closed.phase, 'closed')
    assert.ok(existsSync(b.build.worktreePath))
  } finally { ctx.cleanup() }
})

test('audit#11 closing a todo removes its clean worktree', async () => {
  const ctx = await setup()
  try {
    const { orch, run, g } = ctx
    const { todo, build } = await buildToReview(ctx, { commit: true })
    const closed = await orch.closeTodo(run, { todoId: todo.id })
    assert.equal(closed.phase, 'closed')
    assert.equal(existsSync(build.worktreePath), false)
    assert.equal(closed.worktreePath, '')
    assert.ok(g('branch', '--list', todo.branch).includes(todo.branch))
  } finally { ctx.cleanup() }
})

/* ---------- Closing a running card must stop the agent that is still working on it ---------- */

test('audit#11 closing a todo while it is building stops the worker session and frees the slot', async () => {
  const ctx = await setup({ maxConcurrentBuilds: 1 })
  try {
    const { db, orch, fake, run, project } = ctx
    const { todo: t1 } = await orch.createTodo(run, { projectId: project.id, title: 'running' })
    const b1 = await orch.startBuild(run, { todoId: t1.id })
    assert.equal(b1.phase, 'building')
    const { todo: t2 } = await orch.createTodo(run, { projectId: project.id, title: 'waiting' })
    const q = await orch.startBuild(run, { todoId: t2.id })
    assert.equal(q.phase, 'queued')

    const closed = await orch.closeTodo(run, { todoId: t1.id })
    assert.equal(closed.phase, 'closed')
    assert.ok(fake.stops.includes(b1.buildSessionId), 'worker session is stopped')
    assert.equal(fake.sessions.get(b1.buildSessionId).is_running, false)
    // The queued todo takes the freed slot without waiting for a reconcile tick.
    for (let i = 0; i < 50 && db.getTodo(1, 'default', t2.id).phase !== 'building'; i += 1) await new Promise(r => setTimeout(r, 20))
    assert.equal(db.getTodo(1, 'default', t2.id).phase, 'building')
  } finally { ctx.cleanup() }
})

test('audit#11 snapshot drops only the oldest finished cards when nothing else is left to trim', () => {
  const todos = Array.from({ length: 2500 }, (_, i) => ({
    id: `td-${i}`, number: i + 1, phase: i % 2 ? 'done' : 'closed', updatedAt: i, spec: 's'.repeat(900), diffs: [], timeline: [], buildChat: [],
  }))
  const live = Array.from({ length: 5 }, (_, i) => ({ id: `live-${i}`, number: 9000 + i, phase: ['todo', 'queued', 'building', 'review', 'failed'][i], updatedAt: 1, spec: 'x'.repeat(900), diffs: [], timeline: [], buildChat: [] }))
  const snap = { topics: [], todos: [...live, ...todos] }
  assert.ok(L(snap) > HOST_JSON_LIMIT, 'fixture is genuinely oversized')
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.ok(fitted.todosOmitted > 0)
  assert.equal(fitted.todos.length + fitted.todosOmitted, 2505)
  for (const td of live) assert.deepEqual(fitted.todos.find(t => t.id === td.id), td, 'unfinished cards always stay')
  // Exactly the oldest finished cards are the ones left out.
  const keptFinished = fitted.todos.filter(t => t.phase === 'done' || t.phase === 'closed').map(t => t.updatedAt)
  assert.equal(Math.min(...keptFinished), fitted.todosOmitted)
  assert.equal(keptFinished.length, 2500 - fitted.todosOmitted)
})

test('audit#11 a trimmed snapshot from getSnapshot passes the stateSnapshot contract', async () => {
  const { readFileSync } = await import('node:fs')
  const { validateModel } = await import('../sdk/harness/contracts.mjs')
  const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
  const ctx = await setup()
  try {
    const { db, orch, run, project } = ctx
    const hunk = Array.from({ length: 500 }, (_, k) => `+${k} ${'b'.repeat(60)}`).join('\n')
    for (let i = 0; i < 20; i += 1) {
      const t = db.createTodo(1, 'default', { projectId: project.id, title: `T${i}` })
      db.updateTodo(1, 'default', t.id, { phase: 'done', diffs: Array.from({ length: 4 }, (_, j) => ({ path: `src/f${j}.js`, additions: 500, deletions: 0, hunk })) })
    }
    const snap = await orch.getSnapshot(run)
    assert.equal(snap.snapshotTrimmed, true, 'fixture triggers trimming')
    assert.ok(L(snap) <= SNAPSHOT_BUDGET)
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
    // The last-resort flag is declared too.
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', { ...snap, todosOmitted: 3 }))
  } finally { ctx.cleanup() }
})

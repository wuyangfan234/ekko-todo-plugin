// Todo #11 review rework: unfinished cards take part in snapshot trimming, and free-text todo
// fields are capped where they are written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { fitSnapshotBudget, HOST_JSON_LIMIT, SNAPSHOT_BUDGET } from '../src/server/diff-budget.mjs'

const L = x => Buffer.byteLength(JSON.stringify(x))
const KB100 = 100 * 1024

const reviewCard = (i, phase = 'review') => ({
  id: `td-${i}`, number: i + 1, phase, updatedAt: 1000 + i, spec: `spec ${i}`, diffs: [], lastError: '',
  plan: 'p'.repeat(20_000),
  timeline: Array.from({ length: 30 }, (_, k) => ({ time: k, event: `event ${k}`, actor: 'system' })),
  buildChat: Array.from({ length: 24 }, (_, k) => ({ role: '开发 Agent', time: '', text: `${k} `.padEnd(4000, 'c') })),
})

function setup(dbOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit11b-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, dbOptions)
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {} } })
  const host = { agents: { async list() { return { agents: [] } }, async models() { return { models: [] } } }, models: { async list() { return { data: [] } } }, async request() { return null }, sessions: {} }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const project = db.createProject(1, 'default', { name: 'P', repoPath: root, defaultBranch: 'main' })
  const cleanup = () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { root, dataDir, db, orch, run, project, cleanup }
}

/* ---------- Must-fix 1: unfinished cards ---------- */

test('audit#11 rework: 17 review cards with full worker chat and plans fit the snapshot budget', () => {
  const todos = Array.from({ length: 17 }, (_, i) => reviewCard(i))
  const snap = { topics: [], todos }
  assert.ok(L(snap) > SNAPSHOT_BUDGET, `fixture is oversized (${L(snap)})`)
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.todos.length, 17, 'every review card is still on the board')
  assert.equal(fitted.todosOmitted, undefined)
  const trimmed = fitted.todos.filter(t => t.buildChatTrimmed === true)
  assert.ok(trimmed.length > 0, 'worker chat of unfinished cards was shortened')
  // Oldest cards are shortened first, and the newest entries are the ones kept.
  assert.equal(fitted.todos.find(t => t.id === 'td-0').buildChatTrimmed, true)
  for (const t of trimmed) {
    const src = todos.find(x => x.id === t.id)
    assert.deepEqual(t.buildChat, src.buildChat.slice(src.buildChat.length - t.buildChat.length))
  }
})

test('audit#11 rework: 25 review cards still fit, shortening timeline and reporting how much was left out', () => {
  const todos = Array.from({ length: 25 }, (_, i) => ({ ...reviewCard(i), plan: 'p'.repeat(60_000) }))
  const snap = { topics: [], todos }
  assert.ok(L(snap) > HOST_JSON_LIMIT)
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.todos.length, 25)
  for (const t of fitted.todos) {
    if (t.timelineOmitted !== undefined) {
      assert.equal(t.timeline.length + t.timelineOmitted, 30)
      assert.equal(t.timeline[t.timeline.length - 1].event, 'event 29', 'newest timeline entries are kept')
    }
    if (t.planTrimmed) assert.ok(Buffer.byteLength(t.plan) <= 50_000)
  }
})

test('audit#11 rework: when trimming is not enough, the oldest idle cards are left out first; running and gate cards stay on the board', () => {
  const big = (id, phase, updatedAt) => ({ id, phase, updatedAt, diffs: [], timeline: [], buildChat: [], plan: '', lastError: '', spec: 's'.repeat(20_000) })
  const idle = Array.from({ length: 120 }, (_, i) => big(`idle-${i}`, ['todo', 'queued', 'failed'][i % 3], i))
  const keep = ['building', 'reviewing', 'merging', 'review', 'confirm'].map((phase, i) => big(`keep-${phase}`, phase, i))
  const snap = { topics: [], todos: [...keep, ...idle] }
  assert.ok(L(snap) > HOST_JSON_LIMIT)
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.ok(fitted.todosOmitted > 0)
  assert.equal(fitted.todos.length + fitted.todosOmitted, 125)
  // Running and gate cards stay on the board; their content may be shortened by other stages (see audit-spec-running-memories).
  for (const td of keep) assert.ok(fitted.todos.some(t => t.id === td.id && t.phase === td.phase), `${td.phase} card is still on the board`)
  const keptIdle = fitted.todos.filter(t => t.id.startsWith('idle-')).map(t => t.updatedAt)
  assert.equal(Math.min(...keptIdle), fitted.todosOmitted, 'exactly the oldest idle cards are left out')
})

/* ---------- Must-fix 2: write-side caps ---------- */

test('audit#11 rework: lastError, timeline events, plan and worker chat are capped when stored', async () => {
  const warnings = []
  const ctx = setup({ log: { warn: (msg, meta) => warnings.push({ msg, meta }) } })
  try {
    const { db, orch, run, project, dataDir } = ctx
    const hugeError = `ENGINE FAILURE ${'e'.repeat(KB100)} TAIL`
    const ids = []
    for (let i = 0; i < 20; i += 1) {
      const t = db.createTodo(1, 'default', { projectId: project.id, title: `T${i}` })
      ids.push(t.id)
      db.updateTodo(1, 'default', t.id, { phase: 'failed', lastError: hugeError })
      db.appendTimeline(1, 'default', t.id, `构建失败：${'x'.repeat(KB100)}`, 'system')
    }
    const first = db.getTodo(1, 'default', ids[0])
    assert.ok(first.lastError.length <= 2000, `stored lastError length ${first.lastError.length}`)
    assert.ok(first.lastError.startsWith('ENGINE FAILURE'), 'the head of the error is kept')
    assert.ok(first.timeline.every(e => e.event.length <= 600), 'every timeline event is capped')
    assert.equal(first.timeline[first.timeline.length - 1].event.slice(0, 5), '构建失败：')

    // The raw row is bounded too, not just the mapped view.
    db.updateTodo(1, 'default', ids[0], {
      plan: '计'.repeat(60_000),
      buildChat: Array.from({ length: 40 }, (_, k) => ({ role: 'r', time: '', text: `${k} `.padEnd(9000, 'c') })),
      timeline: Array.from({ length: 120 }, (_, k) => ({ time: k, event: `e${k}`, actor: 'system' })),
    })
    const raw = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'), { readOnly: true })
    const row = raw.prepare('SELECT last_error, plan, build_chat_json, timeline_json FROM todos WHERE id = ?').get(ids[0])
    raw.close()
    assert.ok(row.last_error.length <= 2000)
    assert.ok(Buffer.byteLength(row.plan) <= 50_000, `stored plan bytes ${Buffer.byteLength(row.plan)}`)
    assert.ok(!row.plan.includes('\uFFFD'), 'plan is cut on a character boundary')
    const chat = JSON.parse(row.build_chat_json)
    assert.equal(chat.length, 24)
    assert.ok(chat.every(m => m.text.length <= 4000))
    assert.ok(chat[23].text.startsWith('39 '), 'newest chat entries are kept')
    const timeline = JSON.parse(row.timeline_json)
    assert.equal(timeline.length, 80)
    assert.equal(timeline[79].event, 'e119')

    // The log gets the head of the error and its original length, not the whole text (see audit-id-fields-log-bound).
    assert.ok(warnings.some(w => String(w.meta?.head || '').startsWith('ENGINE FAILURE') && w.meta.length > KB100), 'the truncation is logged')
    assert.ok(!warnings.some(w => JSON.stringify(w).includes('TAIL')))

    const snap = await orch.getSnapshot(run)
    assert.ok(L(snap) <= SNAPSHOT_BUDGET, `snapshot size ${L(snap)}`)
    assert.equal(snap.todos.length, 20)
  } finally { ctx.cleanup() }
})

test('audit#11 rework: an oversized lastError already in the database is shortened in the snapshot view only', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, dataDir } = ctx
    const t = db.createTodo(1, 'default', { projectId: project.id, title: 'legacy' })
    const small = db.createTodo(1, 'default', { projectId: project.id, title: 'small' })
    db.updateTodo(1, 'default', small.id, { lastError: 'short error' })
    const raw = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'))
    raw.prepare('UPDATE todos SET last_error = ? WHERE id = ?').run(`LEGACY ${'z'.repeat(KB100)}`, t.id)
    raw.close()
    const snap = await orch.getSnapshot(run)
    const legacy = snap.todos.find(x => x.id === t.id)
    assert.ok(legacy.lastError.length <= 2000, `view lastError length ${legacy.lastError.length}`)
    assert.ok(legacy.lastError.startsWith('LEGACY '))
    assert.equal(legacy.lastErrorTrimmed, true)
    const untouched = snap.todos.find(x => x.id === small.id)
    assert.equal(untouched.lastError, 'short error')
    assert.equal(untouched.lastErrorTrimmed, undefined)
    // Reading the board does not rewrite the stored row.
    const check = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'), { readOnly: true })
    assert.ok(check.prepare('SELECT length(last_error) AS n FROM todos WHERE id = ?').get(t.id).n > KB100)
    check.close()
  } finally { ctx.cleanup() }
})

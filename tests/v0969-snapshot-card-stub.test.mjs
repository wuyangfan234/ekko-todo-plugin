// Todo #73: the board snapshot budget used to drop the oldest finished cards outright (stage 8), so the
// "done" column shrank as the board grew, and todosOmitted was never shown. Cards are now reduced to
// stubs first (stubbed: true, details loaded on demand through get-todo-detail) and dropped only when even
// the stubs do not fit; the board then says how many cards were not loaded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fitSnapshotBudget, SNAPSHOT_BUDGET } from '../src/server/diff-budget.mjs'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'

const L = x => Buffer.byteLength(JSON.stringify(x))
const hunk = n => ['@@ -0,0 +1,200 @@', ...Array.from({ length: 200 }, (_, k) => `+${n} line ${k} ${'d'.repeat(90)}`)].join('\n')

function doneCard(i, extra = {}) {
  return {
    id: `td-${i}`, number: i + 1, title: `done card ${i}`, kind: 'feature', phase: 'done',
    gateOwner: 'none', gateKind: '', projectId: 'p1', topicId: 'tp1', agentId: 'ag1', reviewerId: 'rv1',
    tags: ['ui'], lastError: '', createdAt: i, updatedAt: 1000 + i,
    // Real boards stay large after stages 1-7 (diff bodies, old chat and timeline gone): long specs, the
    // newest worker reports and review summaries. This residue is what used to push whole cards out.
    spec: `spec ${i} ${'s'.repeat(12_000)}`, plan: `plan ${i}`,
    diffs: [{ path: `src/f${i}.js`, additions: 200, deletions: 0, hunk: hunk(i) }],
    buildChat: Array.from({ length: 30 }, (_, k) => ({ role: 'agent', time: '', text: `step ${k} ${'c'.repeat(3900)}` })),
    timeline: Array.from({ length: 40 }, (_, k) => ({ event: `event ${k} ${'t'.repeat(200)}`, actor: 'system', time: k })),
    evidence: { commitSha: `sha${i}`, testRc: 0, reviewVerdict: 'approved', filesChanged: 1, additions: 200, deletions: 0, reviewSummary: 'r'.repeat(3000) },
    question: { active: false, options: [] },
    ...extra,
  }
}
const bigBoard = (n = 150) => ({ settings: {}, counts: {}, topics: [], todos: Array.from({ length: n }, (_, i) => doneCard(i)) })

test('#73 A: every finished card stays on the board when the snapshot is over budget (count is right)', () => {
  const snap = bigBoard(150)
  assert.ok(L(snap) > SNAPSHOT_BUDGET, `fixture is over budget (${L(snap)})`)
  const out = fitSnapshotBudget(snap)
  console.log(`[A] before=${L(snap)} after=${L(out)} todos=${out.todos.length} done=${out.todos.filter(t => t.phase === 'done').length} todosOmitted=${out.todosOmitted}`)
  assert.ok(L(out) <= SNAPSHOT_BUDGET)
  assert.equal(out.todos.length, 150)
  assert.equal(out.todos.filter(t => t.phase === 'done').length, 150)
  assert.ok(out.todosOmitted === undefined || out.todosOmitted === 0)
})

test('#73 B: a stubbed card keeps its identifying fields and empties the bodies', () => {
  const out = fitSnapshotBudget(bigBoard(150))
  const stubs = out.todos.filter(t => t.stubbed)
  assert.ok(stubs.length > 0, 'some cards were stubbed')
  const s = stubs[0]
  const src = doneCard(Number(s.id.slice(3)))
  for (const key of ['id', 'number', 'title', 'kind', 'phase', 'gateOwner', 'gateKind', 'projectId', 'topicId', 'agentId', 'updatedAt', 'createdAt']) {
    assert.deepEqual(s[key], src[key], `stub keeps ${key}`)
  }
  assert.equal(s.stubbed, true)
  assert.deepEqual(s.diffs, [])
  assert.deepEqual(s.buildChat, [])
  assert.deepEqual(s.timeline, [])
  assert.equal(s.spec, '')
  assert.ok(Array.isArray(s.stubbedFields) && s.stubbedFields.includes('diffs') && s.stubbedFields.includes('spec'))
  assert.equal(typeof s.evidence, 'object', 'evidence stays an object so the drawer never reads a property of undefined')
  // The oldest finished cards are the ones reduced; the newest keep their details when they fit.
  const newest = out.todos.find(t => t.id === 'td-149')
  assert.notEqual(newest.stubbed, true)
})

test('#73 C: get-todo-detail returns the full details of a stubbed card, identical to storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-stub-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  const run = { identity: { userId: 1, profile: 'default' }, signal: new AbortController().signal, host: {} }
  try {
    const created = db.createTodo(1, 'default', { projectId: 'p1', title: 'stored done card' })
    const src = doneCard(0)
    db.updateTodo(1, 'default', created.id, { spec: src.spec, plan: src.plan, diffs: src.diffs, buildChat: src.buildChat, timeline: src.timeline, evidence: src.evidence })
    const stored = db.getTodo(1, 'default', created.id)
    // Same card reduced to a stub by the budget (tiny budget so even one card is over it).
    const out = fitSnapshotBudget({ todos: [stored] }, 2000)
    assert.equal(out.todos[0]?.stubbed, true, 'card is stubbed in the snapshot')
    assert.ok(typeof orch.getTodoDetail === 'function', 'orchestrator exposes getTodoDetail')
    const detail = await orch.getTodoDetail(run, { todoId: created.id })
    assert.equal(detail.todoId, created.id)
    assert.equal(detail.spec, stored.spec)
    assert.ok(detail.spec.length > 0)
    assert.equal(detail.diffs.length, stored.diffs.length)
    assert.deepEqual(detail.diffs, stored.diffs)
    assert.deepEqual(detail.buildChat, stored.buildChat)
    assert.deepEqual(detail.timeline, stored.timeline)
    assert.equal(detail.evidence.commitSha, 'sha0')
    assert.ok(L(detail) <= 400_000)
    // Partitioned by identity: another profile cannot read it.
    await assert.rejects(async () => orch.getTodoDetail({ ...run, identity: { userId: 1, profile: 'other' } }, { todoId: created.id }), /not found/i)
    // The RPC is declared in the contract.
    const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
    assert.ok(contract.rpc['get-todo-detail'], 'get-todo-detail declared in contracts/plugin.json')
    assert.ok(contract.rpc['get-todo-diffs'], 'get-todo-diffs kept for existing clients')
  } finally {
    try { orch.dispose?.() } catch {}
    try { db.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

test('#73 C2: an oversized card detail is clamped to about 400 KB and says what was trimmed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-stub-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {}, error() {} }, settleDelaysMs: [0, 0, 0, 0] })
  const run = { identity: { userId: 1, profile: 'default' }, signal: new AbortController().signal, host: {} }
  try {
    const created = db.createTodo(1, 'default', { projectId: 'p1', title: 'huge card' })
    const diffs = Array.from({ length: 6 }, (_, j) => ({ path: `src/g${j}.js`, additions: 900, deletions: 0, hunk: ['@@', ...Array.from({ length: 900 }, (_, k) => `+${k} ${'b'.repeat(60)}`)].join('\n') }))
    db.updateTodo(1, 'default', created.id, {
      plan: 'p'.repeat(49_000),
      diffs,
      buildChat: Array.from({ length: 24 }, (_, k) => ({ role: 'agent', text: `${k} ${'c'.repeat(3990)}` })),
      timeline: Array.from({ length: 80 }, (_, k) => ({ event: 'e'.repeat(590), actor: 'system', time: k })),
      evidence: { reviewSummary: 'r'.repeat(150_000), testSummary: 't'.repeat(150_000) },
    })
    const detail = await orch.getTodoDetail(run, { todoId: created.id })
    console.log(`[C2] detail bytes=${L(detail)} trimmed=${JSON.stringify(detail.trimmed)}`)
    assert.ok(L(detail) <= 400_000)
    assert.ok(Array.isArray(detail.trimmed) && detail.trimmed.length > 0)
  } finally {
    try { orch.dispose?.() } catch {}
    try { db.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

test('#73 D: when even the stubs do not fit, cards are left out, todosOmitted says how many, and the board shows it', () => {
  const snap = bigBoard(150)
  const budget = 20_000
  const out = fitSnapshotBudget(snap, budget)
  console.log(`[D] after=${L(out)} todos=${out.todos.length} todosOmitted=${out.todosOmitted}`)
  assert.ok(out.todosOmitted > 0)
  assert.equal(out.todos.length + out.todosOmitted, 150)
  assert.ok(out.todos.every(t => t.stubbed), 'every kept card was reduced before any card was left out')
  assert.ok(L(out) <= budget)

  const board = readFileSync(new URL('../src/client/components/KanbanBoard.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/client/App.jsx', import.meta.url), 'utf8')
  assert.match(board, /todosOmitted/, 'KanbanBoard reads todosOmitted')
  assert.match(board, /data-testid="lane-todos-omitted"/, 'the notice has a test id')
  assert.match(board, /还有 \{todosOmitted\} 张卡未加载/, 'the notice names the count')
  assert.match(app, /todosOmitted=\{state\.todosOmitted/, 'App passes state.todosOmitted to the board')
})

test('#73 E: running cards are never stubbed or left out, and a todo card within budget is not stubbed', () => {
  const running = ['building', 'reviewing', 'merging'].map((phase, k) => doneCard(500 + k, { phase, updatedAt: 1 }))
  const todoCard = doneCard(600, { phase: 'todo', updatedAt: 2 })
  const snap = { settings: {}, topics: [], todos: [...running, todoCard, ...bigBoard(150).todos] }
  assert.ok(L(snap) > SNAPSHOT_BUDGET)
  const out = fitSnapshotBudget(snap)
  for (const phase of ['building', 'reviewing', 'merging']) {
    const c = out.todos.find(t => t.phase === phase)
    assert.ok(c, `${phase} card kept`)
    assert.notEqual(c.stubbed, true, `${phase} card not stubbed`)
  }
  const t = out.todos.find(x => x.id === 'td-600')
  assert.ok(t)
  assert.notEqual(t.stubbed, true, 'todo card within budget keeps its details')
  assert.ok(t.spec.length > 0)
  assert.equal(out.todos.length, 154)

  // Even with a budget so small that stubs are dropped, running cards stay.
  const tiny = fitSnapshotBudget(snap, 20_000)
  for (const phase of ['building', 'reviewing', 'merging']) {
    const c = tiny.todos.find(x => x.phase === phase)
    assert.ok(c, `${phase} card kept under a tiny budget`)
    assert.notEqual(c.stubbed, true)
  }
})

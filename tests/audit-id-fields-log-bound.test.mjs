// Todo #11 seventh review rework: todo / memory id fields are refused when over-long (legacy rows are
// shortened in the board view only), and what is written to the host log about truncated text is bounded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import { validateModel } from '../sdk/harness/contracts.mjs'
import { SNAPSHOT_BUDGET } from '../src/server/diff-budget.mjs'

const L = x => Buffer.byteLength(JSON.stringify(x))
const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const MB12 = 1_200_000

function setup(dbOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit11h-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, dbOptions)
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {} } })
  const host = { agents: { async list() { return { agents: [] } }, async models() { return { models: [] } } }, models: { async list() { return { data: [] } } }, async request() { return null }, sessions: {} }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const project = db.createProject(1, 'default', { name: 'P', repoPath: root, defaultBranch: 'main' })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const rawWrite = fn => { const raw = new DatabaseSync(sqlitePath); try { return fn(raw) } finally { raw.close() } }
  const rawRead = fn => { const raw = new DatabaseSync(sqlitePath, { readOnly: true }); try { return fn(raw) } finally { raw.close() } }
  const cleanup = () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, project, tools, rawWrite, rawRead, cleanup }
}

const loadFull = async (ctx, label) => {
  const snap = await ctx.orch.getSnapshot(ctx.run)
  assert.equal(snap.snapshotOverflow, undefined, `${label}: not a degraded snapshot`)
  assert.ok(L(snap) <= SNAPSHOT_BUDGET, `${label}: snapshot size ${L(snap)}`)
  assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
  return snap
}

/* ---------- Must-fix 1: id fields ---------- */

test('audit#11 r7: create_todo with a 1.2 MB agent_id or topic_id is refused and leaves nothing behind', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, tools } = ctx
    await orch.getSnapshot(run)
    const props = tools.get('create_todo').inputSchema.properties
    assert.deepEqual([props.topic_id.maxLength, props.agent_id.maxLength], [120, 120])
    const existing = db.createTodo(1, 'default', { projectId: project.id, title: 'existing card' })
    const topicsBefore = db.listTopics(1, 'default').length
    await assert.rejects(tools.get('create_todo').execute({ project_id: project.id, title: 'bad agent', agent_id: 'a'.repeat(MB12) }, run), /agentId.*120/)
    await assert.rejects(tools.get('create_todo').execute({ project_id: project.id, title: 'bad topic', topic_id: 't'.repeat(MB12) }, run), /topicId.*120/)
    assert.throws(() => db.createTodo(1, 'default', { projectId: project.id, title: 'bad reviewer', reviewerId: 'r'.repeat(500) }), /reviewerId.*120/)
    assert.equal(db.listTodos(1, 'default').length, 1, 'no card was stored')
    assert.equal(db.listTopics(1, 'default').length, topicsBefore, 'no topic was created for a refused card')
    // The refused attempts did not consume card numbers.
    const next = db.createTodo(1, 'default', { projectId: project.id, title: 'next card' })
    assert.equal(next.number, existing.number + 1)
    const snap = await loadFull(ctx, 'refused ids')
    assert.equal(snap.todos.length, 2)
  } finally { ctx.cleanup() }
})

test('audit#11 r7: cards already stored with 1.2 MB agent / topic ids stay on the board, shortened in the view only', async () => {
  const ctx = setup()
  try {
    const { db, project } = ctx
    const cards = [0, 1].map(i => db.createTodo(1, 'default', { projectId: project.id, title: `legacy ${i}` }))
    const fresh = db.createTodo(1, 'default', { projectId: project.id, title: 'fresh' })
    ctx.rawWrite(raw => {
      raw.prepare('UPDATE todos SET agent_id = ? WHERE id = ?').run(`AG ${'a'.repeat(MB12)}`, cards[0].id)
      raw.prepare('UPDATE todos SET agent_id = ?, reviewer_id = ?, topic_id = ? WHERE id = ?').run(`AG ${'a'.repeat(MB12)}`, `RV ${'r'.repeat(5000)}`, `TP ${'t'.repeat(5000)}`, cards[1].id)
    })
    const snap = await loadFull(ctx, 'legacy todo ids')
    assert.equal(snap.todos.length, 3, 'every card is listed')
    assert.equal(snap.todosOmitted, undefined)
    const a = snap.todos.find(t => t.id === cards[0].id)
    assert.ok(a.agentId.length <= 120 && a.agentId.startsWith('AG '))
    assert.deepEqual(a.trimmedFields, ['agentId'])
    const b = snap.todos.find(t => t.id === cards[1].id)
    assert.ok(b.agentId.length <= 120 && b.reviewerId.length <= 120 && b.topicId.length <= 120)
    assert.deepEqual([...b.trimmedFields].sort(), ['agentId', 'reviewerId', 'topicId'])
    assert.equal(snap.todos.find(t => t.id === fresh.id).trimmedFields, undefined)
    db.appendTimeline(1, 'default', cards[0].id, 'unrelated', 'system')
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT length(agent_id) AS n FROM todos WHERE id = ?').get(cards[0].id).n) > MB12, 'the stored id is not rewritten')
  } finally { ctx.cleanup() }
})

test('audit#11 r7: manage_memory with a 1.2 MB scope_id or memory_id is refused and existing memories stay listed', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, tools } = ctx
    await orch.getSnapshot(run)
    const props = tools.get('manage_memory').inputSchema.properties
    assert.deepEqual([props.memory_id.maxLength, props.scope_id.maxLength], [120, 120])
    const kept = db.upsertMemory(1, 'default', { title: 'kept', content: 'c' })
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(tools.get('manage_memory').execute({ action: 'upsert', scope: 'project', scope_id: 's'.repeat(MB12), title: `m${i}`, content: 'c' }, run), /scopeId.*120/)
    }
    await assert.rejects(tools.get('manage_memory').execute({ action: 'upsert', memory_id: 'i'.repeat(MB12), title: 'm', content: 'c' }, run), /id.*120/)
    assert.equal(db.listMemories(1, 'default').length, 1, 'nothing was stored')
    const snap = await loadFull(ctx, 'refused memory ids')
    assert.deepEqual(snap.memories.map(m => m.id), [kept.id])
  } finally { ctx.cleanup() }
})

test('audit#11 r7: memories already stored with 1.2 MB ids are listed, shortened in the view only, and can still be edited and deleted from it', async () => {
  const ctx = setup()
  try {
    const { db, orch, run } = ctx
    const ids = [0, 1].map(i => db.upsertMemory(1, 'default', { title: `m${i}`, content: 'c', scope: 'project', scopeId: 'p' }).id)
    const longId = `LEGACY-ID ${'i'.repeat(MB12)}`
    const longScope = `SC ${'s'.repeat(MB12)}`
    ctx.rawWrite(raw => {
      raw.prepare('UPDATE memories SET scope_id = ?').run(longScope)
      raw.prepare('UPDATE memories SET id = ? WHERE id = ?').run(longId, ids[0])
    })
    const snap = await loadFull(ctx, 'legacy memory ids')
    assert.equal(snap.memories.length, 2, 'memories are still listed')
    assert.equal(snap.memoriesOmitted, undefined)
    const view = snap.memories.find(m => m.id.startsWith('LEGACY-ID '))
    assert.ok(view.id.length <= 120 && view.scopeId.length <= 120)
    assert.deepEqual([...view.trimmedFields].sort(), ['id', 'scopeId'])
    assert.deepEqual(snap.memories.find(m => m.id === ids[1]).trimmedFields, ['scopeId'])
    // Saving from the board sends the shortened id and scope back: the stored row is updated in place.
    db.upsertMemory(1, 'default', { id: view.id, scope: 'project', scopeId: view.scopeId, title: 'edited', content: 'c' })
    const rows = ctx.rawRead(raw => raw.prepare('SELECT id, title, length(scope_id) AS s FROM memories ORDER BY title').all())
    assert.equal(rows.length, 2, 'no duplicate row was created')
    const edited = rows.find(r => r.title === 'edited')
    assert.equal(edited.id, longId)
    assert.ok(edited.s > MB12, 'the stored scope id is kept')
    // Deleting from the board works with the shortened id too.
    await orch.removeMemory(run, view.id)
    assert.deepEqual(db.listMemories(1, 'default').map(m => m.id), [ids[1]])
  } finally { ctx.cleanup() }
})

/* ---------- Must-fix 2: bounded log ---------- */

test('audit#11 r7: truncating a 1 MB lastError, timeline event or spec logs at most its first 2000 characters', () => {
  const calls = []
  const ctx = setup({ log: { warn: (...args) => calls.push(args) } })
  try {
    const { db, project } = ctx
    const t = db.createTodo(1, 'default', { projectId: project.id, title: 'x' })
    const mb = 1024 * 1024
    db.updateTodo(1, 'default', t.id, { lastError: `ERR-HEAD ${'e'.repeat(mb)} ERR-TAIL` })
    db.appendTimeline(1, 'default', t.id, `EVT-HEAD ${'v'.repeat(mb)} EVT-TAIL`, 'system')
    db.updateTodo(1, 'default', t.id, { spec: `SPEC-HEAD ${'规'.repeat(mb)} SPEC-TAIL` })
    assert.equal(calls.length, 3, 'one log line per truncated field')
    for (const args of calls) {
      const text = JSON.stringify(args)
      assert.ok(text.length < 4096, `logged ${text.length} characters`)
      const meta = args[1]
      assert.deepEqual(Object.keys(meta).sort(), ['head', 'length', 'todoId'])
      assert.equal(meta.todoId, t.id)
      assert.ok(meta.length > mb)
      assert.ok(meta.head.length <= 2000)
      assert.ok(!text.includes('-TAIL'))
    }
    assert.ok(Buffer.byteLength(JSON.stringify(calls[0])) < 4096)
    assert.deepEqual(calls.map(c => c[1].head.split(' ')[0]), ['ERR-HEAD', 'EVT-HEAD', 'SPEC-HEAD'])
  } finally { ctx.cleanup() }
})

test('audit#11 r7: a log implementation that throws does not fail the write', () => {
  const ctx = setup({ log: { warn() { throw new Error('log sink is down') } } })
  try {
    const { db, project } = ctx
    const t = db.createTodo(1, 'default', { projectId: project.id, title: 'x' })
    assert.doesNotThrow(() => db.updateTodo(1, 'default', t.id, { lastError: 'e'.repeat(50_000), spec: 's'.repeat(50_000) }))
    assert.doesNotThrow(() => db.appendTimeline(1, 'default', t.id, 'v'.repeat(50_000), 'system'))
    const row = db.getTodo(1, 'default', t.id)
    assert.ok(row.lastError.length <= 2000 && row.spec.length <= 20_000)
    assert.ok(row.timeline[row.timeline.length - 1].event.length <= 600)
  } finally { ctx.cleanup() }
})

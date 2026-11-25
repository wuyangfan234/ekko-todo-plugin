// Todo #11 second review rework: spec/title caps, running cards take part in snapshot trimming,
// last-resort stages with an explicit error, and memories / avatars are trimmed in the board view.
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
import { fitSnapshotBudget, HOST_JSON_LIMIT, SNAPSHOT_BUDGET } from '../src/server/diff-budget.mjs'

const L = x => Buffer.byteLength(JSON.stringify(x))
const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit11c-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {} } })
  const host = { agents: { async list() { return { agents: [] } }, async models() { return { models: [] } } }, models: { async list() { return { data: [] } } }, async request() { return null }, sessions: {} }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const project = db.createProject(1, 'default', { name: 'P', repoPath: root, defaultBranch: 'main' })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const cleanup = () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { root, dataDir, db, orch, run, project, tools, cleanup }
}

// A card filled to the plugin's own write caps, in CJK so every character costs 3 bytes.
const fullCard = (id, phase, updatedAt) => ({
  id, phase, updatedAt, diffs: [], lastError: '',
  spec: '规'.repeat(20_000),
  plan: '计'.repeat(16_000),
  timeline: Array.from({ length: 80 }, (_, k) => ({ time: k, event: `${k} `.padEnd(600, '事'), actor: 'system' })),
  buildChat: Array.from({ length: 24 }, (_, k) => ({ role: '执行进度', time: '', text: `${k} `.padEnd(4000, '聊') })),
})
// A card whose only weight is a plan at the 50,000-byte cap: nothing on it can be shortened further.
const planCard = (id, phase, updatedAt) => ({ id, phase, updatedAt, diffs: [], lastError: '', spec: 's', plan: 'p'.repeat(49_000), timeline: [], buildChat: [] })

/* ---------- Must-fix 1: spec and title ---------- */

test('audit#11 r2: four gate cards created with 200000-character specs fit the snapshot budget', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, dataDir } = ctx
    const phases = ['review', 'confirm', 'building', 'reviewing']
    const ids = []
    for (const phase of phases) {
      const { todo } = await orch.createTodo(run, { projectId: project.id, title: `T ${phase} ${'长'.repeat(500)}`, spec: `HEAD ${'规'.repeat(200_000)}` })
      db.updateTodo(1, 'default', todo.id, { phase })
      ids.push(todo.id)
    }
    const snap = await orch.getSnapshot(run)
    assert.ok(L(snap) <= SNAPSHOT_BUDGET, `snapshot size ${L(snap)}`)
    assert.equal(snap.todos.length, 4)
    for (const td of snap.todos) {
      assert.ok(td.spec.length <= 20_000, `view spec length ${td.spec.length}`)
      assert.ok(td.spec.startsWith('HEAD '), 'the head of the spec is kept')
      assert.ok(td.title.length <= 200, `view title length ${td.title.length}`)
    }
    // Stored rows are bounded, on create and on update.
    db.updateTodo(1, 'default', ids[0], { spec: `UPDATED ${'规'.repeat(200_000)}`, title: `U ${'长'.repeat(500)}` })
    const raw = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'), { readOnly: true })
    const rows = raw.prepare('SELECT id, length(spec) AS s, length(title) AS t, spec, title FROM todos').all()
    raw.close()
    assert.equal(rows.length, 4)
    for (const r of rows) {
      assert.ok(r.s <= 20_000, `stored spec length ${r.s}`)
      assert.ok(r.t <= 200, `stored title length ${r.t}`)
      assert.ok(r.spec.endsWith('…') && r.title.endsWith('…'), 'cut text ends with an ellipsis')
    }
    assert.ok(rows.find(r => r.id === ids[0]).spec.startsWith('UPDATED '))
  } finally { ctx.cleanup() }
})

test('audit#11 r2: an oversized spec already in the database is shortened in the board view only', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, dataDir } = ctx
    const ids = ['review', 'confirm', 'building', 'reviewing'].map(phase => {
      const t = db.createTodo(1, 'default', { projectId: project.id, title: `legacy ${phase}`, spec: 'short spec' })
      db.updateTodo(1, 'default', t.id, { phase })
      return t.id
    })
    const raw = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'))
    for (const id of ids.slice(0, 3)) raw.prepare('UPDATE todos SET spec = ? WHERE id = ?').run(`LEGACY ${'规'.repeat(200_000)}`, id)
    raw.close()
    const snap = await orch.getSnapshot(run)
    assert.ok(L(snap) <= SNAPSHOT_BUDGET, `snapshot size ${L(snap)}`)
    for (const id of ids.slice(0, 3)) {
      const td = snap.todos.find(t => t.id === id)
      assert.ok(td.spec.length <= 20_000 && td.spec.startsWith('LEGACY '))
      assert.equal(td.specTrimmed, true)
    }
    const small = snap.todos.find(t => t.id === ids[3])
    assert.equal(small.spec, 'short spec')
    assert.equal(small.specTrimmed, undefined)
    const check = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'), { readOnly: true })
    assert.ok(check.prepare('SELECT length(spec) AS n FROM todos WHERE id = ?').get(ids[0]).n > 200_000, 'reading the board does not rewrite the row')
    check.close()
    // Workers still get the full stored spec.
    assert.ok(db.getTodo(1, 'default', ids[0]).spec.length > 200_000)
  } finally { ctx.cleanup() }
})

test('audit#11 r2: MCP create_todo and update_todo declare the same spec and title limits', () => {
  const ctx = setup()
  try {
    for (const name of ['create_todo', 'update_todo']) {
      const props = ctx.tools.get(name).inputSchema.properties
      assert.equal(props.spec.maxLength, 20_000, `${name}.spec`)
      assert.equal(props.title.maxLength, 200, `${name}.title`)
    }
  } finally { ctx.cleanup() }
})

/* ---------- Must-fix 2: running cards, last-resort stages, explicit error ---------- */

test('audit#11 r2: five building cards filled to the write caps fit the snapshot budget', () => {
  const todos = Array.from({ length: 5 }, (_, i) => fullCard(`b-${i}`, 'building', i))
  const snap = { topics: [], todos }
  assert.ok(L(snap) > HOST_JSON_LIMIT, `fixture is oversized (${L(snap)})`)
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.snapshotTrimmed, true)
  assert.equal(fitted.todos.length, 5, 'running cards are never left out')
  assert.equal(fitted.todosOmitted, undefined)
  const trimmed = fitted.todos.filter(t => t.buildChatTrimmed === true)
  assert.ok(trimmed.length > 0, 'running cards had their worker chat shortened')
  for (const t of fitted.todos) {
    const src = todos.find(x => x.id === t.id)
    assert.ok(t.buildChat.length >= 2 && t.timeline.length >= 6, 'the newest progress always stays')
    assert.deepEqual(t.buildChat, src.buildChat.slice(src.buildChat.length - t.buildChat.length), 'newest chat entries are kept')
    assert.deepEqual(t.timeline, src.timeline.slice(src.timeline.length - t.timeline.length), 'newest timeline entries are kept')
    if (t.timelineOmitted !== undefined) assert.equal(t.timeline.length + t.timelineOmitted, 80)
  }
  // The source snapshot is not mutated.
  assert.equal(todos[0].buildChat.length, 24)
})

test('audit#11 r2: when ordinary trimming is not enough, specs are cut to 4000 characters before any gate card is left out', () => {
  const card = (id, phase, updatedAt) => ({ id, phase, updatedAt, diffs: [], lastError: '', spec: '规'.repeat(20_000), plan: '', timeline: [], buildChat: [] })
  const todos = [
    ...Array.from({ length: 14 }, (_, i) => card(`rv-${i}`, 'review', i)),
    ...Array.from({ length: 14 }, (_, i) => card(`cf-${i}`, 'confirm', i)),
    ...Array.from({ length: 4 }, (_, i) => card(`bd-${i}`, 'building', i)),
  ]
  const snap = { topics: [], todos }
  assert.ok(L(snap) > SNAPSHOT_BUDGET, `fixture is oversized (${L(snap)})`)
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.todos.length, 32, 'no card is left out while a spec can still be shortened')
  assert.equal(fitted.todosOmitted, undefined)
  const cut = fitted.todos.filter(t => t.specTrimmed === true)
  assert.ok(cut.length > 0)
  for (const t of cut) assert.ok(t.spec.length <= 4000 && t.spec.endsWith('…'))
})

test('audit#11 r2: last resort leaves out the oldest failed and then the oldest confirm cards; review and running cards stay', () => {
  const todos = [
    ...Array.from({ length: 3 }, (_, i) => planCard(`bd-${i}`, ['building', 'reviewing', 'merging'][i], i)),
    ...Array.from({ length: 6 }, (_, i) => planCard(`rv-${i}`, 'review', i)),
    ...Array.from({ length: 4 }, (_, i) => planCard(`fl-${i}`, 'failed', 500 + i)),
    ...Array.from({ length: 30 }, (_, i) => planCard(`cf-${i}`, 'confirm', 100 + i)),
  ]
  const snap = { topics: [], todos }
  assert.ok(L(snap) > HOST_JSON_LIMIT, `fixture is oversized (${L(snap)})`)
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.todos.length + fitted.todosOmitted, 43)
  for (const td of todos.filter(t => /^(bd|rv)-/.test(t.id))) assert.ok(fitted.todos.some(t => t.id === td.id), `${td.id} (${td.phase}) stays`)
  assert.equal(fitted.todos.filter(t => t.phase === 'failed').length, 0, 'failed cards go before any confirm card')
  const keptConfirm = fitted.todos.filter(t => t.phase === 'confirm').map(t => t.updatedAt)
  assert.ok(keptConfirm.length > 0 && keptConfirm.length < 30)
  assert.equal(Math.min(...keptConfirm), 100 + (30 - keptConfirm.length), 'exactly the oldest confirm cards are left out')
})

test('audit#11 r2: a snapshot that cannot be brought under the host limit is returned degraded, never thrown and never oversized', () => {
  // Running cards are never left out, so enough of them cannot be trimmed under the limit.
  const todos = Array.from({ length: 45 }, (_, i) => planCard(`bd-${i}`, 'building', i))
  const snap = { topics: [], todos }
  assert.ok(L(snap) > HOST_JSON_LIMIT)
  const fitted = fitSnapshotBudget(snap)
  assert.equal(fitted.snapshotOverflow, true)
  assert.ok(fitted.overflowBytes > HOST_JSON_LIMIT)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET)
  // The degraded board names every card without its body.
  assert.equal(fitted.todos.length, 45)
  assert.ok(fitted.todos.every(t => t.stub === true && t.phase === 'building' && t.plan === undefined))
  assert.equal(fitted.todosOmitted, undefined)
})

/* ---------- Must-fix 3: memories and avatars ---------- */

test('audit#11 r2: 170 full-size memories fit the snapshot budget and report how many were left out', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, dataDir } = ctx
    for (let i = 0; i < 170; i += 1) {
      db.upsertMemory(1, 'default', { title: `M${i}`, content: '忆'.repeat(4000), scope: 'chief', pinned: i === 3 })
    }
    // Deterministic recency: M0 is the oldest, M169 the newest.
    const raw = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'))
    raw.exec("UPDATE memories SET updated_at = 1000 + CAST(substr(title, 2) AS INTEGER)")
    raw.close()
    const snap = await orch.getSnapshot(run)
    assert.ok(L(snap) <= SNAPSHOT_BUDGET, `snapshot size ${L(snap)}`)
    assert.equal(snap.snapshotTrimmed, true)
    assert.equal(snap.memories.length, 100)
    assert.equal(snap.memoriesOmitted, 70)
    const titles = new Set(snap.memories.map(m => m.title))
    assert.ok(titles.has('M3'), 'a pinned memory stays even though it is old')
    assert.ok(titles.has('M169') && titles.has('M71') && !titles.has('M70') && !titles.has('M0'), 'the newest ones are kept')
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
    assert.equal(db.listMemories(1, 'default').length, 170, 'nothing is deleted from storage')
  } finally { ctx.cleanup() }
})

test('audit#11 r2: a snapshot within budget keeps every memory and has no memoriesOmitted', () => {
  const snap = { topics: [], todos: [], memories: Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, title: 't', content: 'c', updatedAt: i })) }
  const fitted = fitSnapshotBudget(snap)
  assert.equal(fitted, snap)
  assert.equal(fitted.memoriesOmitted, undefined)
})

test('audit#11 r2: uploaded agent avatars are swapped for the default marker only as a last resort', () => {
  const upload = `data:image/png;base64,${'A'.repeat(120_000)}`
  const agents = [
    { id: 'agent-1', role: 'chief', avatar: upload },
    { id: 'agent-2', role: 'builder', avatar: upload },
    { id: 'agent-3', role: 'reviewer', avatar: upload },
    { id: 'agent-4', role: 'qa', avatar: 'notion:qa-keep-01' },
  ]
  const todos = Array.from({ length: 26 }, (_, i) => planCard(`rv-${i}`, 'review', i))
  const snap = { topics: [], todos, agents }
  assert.ok(L(snap) > SNAPSHOT_BUDGET, `fixture is oversized (${L(snap)})`)
  const fitted = fitSnapshotBudget(snap)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `fitted size ${L(fitted)}`)
  assert.equal(fitted.todos.length, 26, 'avatars go before any card is left out')
  const swapped = fitted.agents.filter(a => a.avatarOmitted === true)
  assert.ok(swapped.length >= 1, 'at least one uploaded avatar was swapped')
  for (const a of swapped) assert.match(a.avatar, /^notion:[a-zA-Z0-9_-]{2,48}$/)
  for (const a of fitted.agents.slice(0, 3)) if (!a.avatarOmitted) assert.equal(a.avatar, upload, 'trimming stops as soon as the snapshot fits')
  assert.deepEqual(fitted.agents[3], agents[3], 'built-in avatars are left alone')
  assert.equal(agents[0].avatar, upload, 'the source snapshot is not mutated')
  // Avatars survive when ordinary trimming is enough.
  const light = fitSnapshotBudget({ topics: [], agents, todos: Array.from({ length: 5 }, (_, i) => fullCard(`b-${i}`, 'building', i)) })
  assert.ok(L(light) <= SNAPSHOT_BUDGET)
  assert.equal(light.agents[0].avatar, upload)
})

test('audit#11 r2: saving an agent with the stand-in avatar does not overwrite its stored upload', async () => {
  const ctx = setup()
  try {
    const { db } = ctx
    const upload = `data:image/png;base64,${'A'.repeat(2000)}`
    const agent = db.upsertAgent(1, 'default', { name: 'A', role: 'builder', engine: 'hermes', avatar: upload })
    const fitted = fitSnapshotBudget({ topics: [], agents: [{ ...agent, avatar: `data:image/png;base64,${'A'.repeat(120_000)}` }], todos: Array.from({ length: 31 }, (_, i) => planCard(`rv-${i}`, 'review', i)) })
    const standIn = fitted.agents[0].avatar
    assert.match(standIn, /^notion:/)
    db.upsertAgent(1, 'default', { ...agent, avatar: standIn, name: 'A renamed' })
    const after = db.getAgent(1, 'default', agent.id)
    assert.equal(after.name, 'A renamed')
    assert.equal(after.avatar, upload, 'the uploaded avatar is still stored')
    // Choosing a different built-in avatar still replaces it.
    db.upsertAgent(1, 'default', { ...agent, avatar: 'notion:builder-other-99' })
    assert.equal(db.getAgent(1, 'default', agent.id).avatar, 'notion:builder-other-99')
  } finally { ctx.cleanup() }
})

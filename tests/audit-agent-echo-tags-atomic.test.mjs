// Todo #11 sixth review rework: saving an agent from a shortened board keeps its longer stored model
// config, tags / topic titles / agent references / schedule fields are bounded, and a refused write
// leaves nothing half-saved.
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit11g-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
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

/* ---------- Must-fix 1: agent saved from a shortened board ---------- */

const LONG_URL = `https://gateway.example/v1/${'k'.repeat(3000)}/tail-of-the-real-address`
const legacyConfigs = () => JSON.stringify([
  { id: 'cfg-primary', label: `Primary ${'L'.repeat(200)}`, engine: 'hermes', mode: 'scoped', provider: 'p', model: 'm', apiMode: '', baseUrl: LONG_URL, customModel: false, reasoningEffort: '' },
  { id: 'cfg-backup', label: 'backup', engine: 'hermes', mode: 'scoped', provider: 'p2', model: `model-${'m'.repeat(600)}`, apiMode: '', baseUrl: '', customModel: false, reasoningEffort: '' },
])

async function legacyAgent(ctx) {
  const before = await ctx.orch.getSnapshot(ctx.run)
  const id = before.agents[0].id
  const json = legacyConfigs()
  ctx.rawWrite(raw => raw.prepare('UPDATE agents SET model_configs_json = ?, base_url = ? WHERE id = ?').run(json, LONG_URL, id))
  const view = (await ctx.orch.getSnapshot(ctx.run)).agents.find(a => a.id === id)
  const stored = () => ctx.rawRead(raw => raw.prepare('SELECT name, base_url, model_configs_json FROM agents WHERE id = ?').get(id))
  return { id, json, view, stored }
}

test('audit#11 r6: renaming an agent with the values the board shows keeps a longer stored baseUrl and model configs byte for byte', async () => {
  const ctx = setup()
  try {
    const { id, json, view, stored } = await legacyAgent(ctx)
    assert.ok(LONG_URL.length > 3000)
    assert.equal(view.baseUrl.length, 500, 'the board shows the shortened address')
    assert.equal(view.modelConfigs[0].baseUrl.length, 500)
    // The UI save payload: every field of the board view, with a new name.
    const { cooldowns: _c, modelConfigsTrimmed: _t, createdAt: _a, updatedAt: _u, ...payload } = view
    await ctx.orch.saveAgent(ctx.run, { ...payload, name: 'renamed by ui' })
    let row = stored()
    assert.equal(row.name, 'renamed by ui')
    assert.equal(row.base_url, LONG_URL, 'stored base_url is unchanged')
    assert.equal(row.model_configs_json, json, 'stored model_configs_json is unchanged')
    // The flat single-config path (no modelConfigs array) behaves the same.
    ctx.db.upsertAgent(1, 'default', { id, name: 'renamed flat', baseUrl: view.baseUrl, model: view.model, provider: view.provider })
    row = stored()
    assert.equal(row.name, 'renamed flat')
    assert.equal(row.base_url, LONG_URL)
    assert.equal(row.model_configs_json, json)
    // Running the agent still uses the full address.
    assert.equal(ctx.db.getAgent(1, 'default', id).baseUrl, LONG_URL)
  } finally { ctx.cleanup() }
})

test('audit#11 r6: a model config field is written only when it really changes to a different valid value', async () => {
  const ctx = setup()
  try {
    const { id, view, stored } = await legacyAgent(ctx)
    const { cooldowns: _c, modelConfigsTrimmed: _t, createdAt: _a, updatedAt: _u, ...payload } = view
    const configs = payload.modelConfigs.map((c, i) => (i === 0 ? { ...c, baseUrl: 'https://new.example/v1' } : c))
    await ctx.orch.saveAgent(ctx.run, { ...payload, baseUrl: 'https://new.example/v1', modelConfigs: configs })
    const row = stored()
    assert.equal(row.base_url, 'https://new.example/v1')
    const saved = JSON.parse(row.model_configs_json)
    assert.equal(saved[0].baseUrl, 'https://new.example/v1', 'the changed field is written')
    assert.equal(saved[0].label, `Primary ${'L'.repeat(200)}`, 'the untouched long label next to it is kept')
    assert.equal(saved[1].model, `model-${'m'.repeat(600)}`, 'the untouched long model of the other config is kept')
    // A different over-long value is still refused, and nothing changes.
    await assert.rejects(ctx.orch.saveAgent(ctx.run, { ...payload, modelConfigs: configs.map((c, i) => (i === 0 ? { ...c, baseUrl: `https://other/${'z'.repeat(600)}` } : c)) }), /baseUrl.*500/)
    assert.equal(stored().model_configs_json, row.model_configs_json)
    void id
  } finally { ctx.cleanup() }
})

/* ---------- Must-fix 2: tags, topic titles, agent references, schedule fields ---------- */

test('audit#11 r6: eight 300000-character tags are stored within 40 characters each and every card stays on the board', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project } = ctx
    await orch.getSnapshot(run)
    const tagsSchema = contract.models.createTodoInput.properties.tags
    assert.equal(tagsSchema.items.maxLength, 40)
    const other = db.createTodo(1, 'default', { projectId: project.id, title: 'another card' })
    const tags = Array.from({ length: 10 }, (_, i) => `T${i} ${'签'.repeat(300_000)}`)
    const { todo } = await orch.createTodo(run, { projectId: project.id, title: 'tagged card', tags })
    const stored = JSON.parse(ctx.rawRead(raw => raw.prepare('SELECT tags_json FROM todos WHERE id = ?').get(todo.id).tags_json))
    assert.equal(stored.length, 8)
    assert.ok(stored.every(t => t.length <= 40), `stored tag length ${stored[0].length}`)
    assert.ok(stored[0].startsWith('T0 '))
    db.updateTodo(1, 'default', other.id, { tags })
    assert.ok(db.getTodo(1, 'default', other.id).tags.every(t => t.length <= 40))
    const snap = await loadFull(ctx, 'tags')
    assert.equal(snap.todos.length, 2, 'every card is listed')
    assert.equal(snap.todosOmitted, undefined)
  } finally { ctx.cleanup() }
})

test('audit#11 r6: oversized tags already in the database are shortened in the board view only', async () => {
  const ctx = setup()
  try {
    const { db, project } = ctx
    const a = db.createTodo(1, 'default', { projectId: project.id, title: 'legacy tags' })
    const b = db.createTodo(1, 'default', { projectId: project.id, title: 'other' })
    const legacy = JSON.stringify(Array.from({ length: 8 }, (_, i) => `L${i} ${'签'.repeat(300_000)}`))
    ctx.rawWrite(raw => raw.prepare('UPDATE todos SET tags_json = ? WHERE id = ?').run(legacy, a.id))
    const snap = await loadFull(ctx, 'legacy tags')
    assert.equal(snap.todos.length, 2)
    const view = snap.todos.find(t => t.id === a.id)
    assert.ok(view.tags.length === 8 && view.tags.every(t => t.length <= 40))
    assert.equal(view.tagsTrimmed, true)
    assert.equal(snap.todos.find(t => t.id === b.id).tagsTrimmed, undefined)
    db.appendTimeline(1, 'default', a.id, 'unrelated', 'system')
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT tags_json FROM todos WHERE id = ?').get(a.id).tags_json), legacy)
  } finally { ctx.cleanup() }
})

test('audit#11 r6: a 1.2 MB topic title is stored within 160 characters; older rows are shortened in the view only', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, tools } = ctx
    await orch.getSnapshot(run)
    assert.equal(tools.get('rename_topic').inputSchema.properties.title.maxLength, 160)
    const huge = `TITLE ${'题'.repeat(1_200_000)}`
    const t1 = db.createTopic(1, 'default', { title: huge })
    const t2 = db.createTopic(1, 'default', { title: 'short' })
    await tools.get('rename_topic').execute({ topic_id: t2.id, title: huge, force: true }, run)
    const rows = ctx.rawRead(raw => raw.prepare('SELECT title FROM topics').all())
    for (const r of rows) assert.ok(r.title.length <= 160 && r.title.startsWith('TITLE '), `stored topic title length ${r.title.length}`)
    let snap = await loadFull(ctx, 'topic titles')
    assert.equal(snap.topics.length, 2, 'both topics are listed')
    // Legacy rows.
    ctx.rawWrite(raw => raw.prepare('UPDATE topics SET title = ?').run(`LEGACY ${'题'.repeat(1_200_000)}`))
    snap = await loadFull(ctx, 'legacy topic titles')
    assert.equal(snap.topics.length, 2)
    for (const t of snap.topics) {
      assert.ok(t.title.length <= 160 && t.title.startsWith('LEGACY '))
      assert.equal(t.titleTrimmed, true)
    }
    db.updateTopic(1, 'default', t1.id, { pinned: true })
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT length(title) AS n FROM topics WHERE id = ?').get(t1.id).n > 1_200_000), 'an unrelated update does not rewrite the stored title')
  } finally { ctx.cleanup() }
})

test('audit#11 r6: a 1.2 MB owner_agent_id or reviewer_agent_id is refused and nothing is stored', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, tools } = ctx
    await orch.getSnapshot(run)
    const props = tools.get('configure_project').inputSchema.properties
    assert.deepEqual([props.owner_agent_id.maxLength, props.reviewer_agent_id.maxLength], [120, 120])
    const before = db.getProject(1, 'default', project.id)
    await assert.rejects(tools.get('configure_project').execute({ project_id: project.id, display_name: 'half', owner_agent_id: 'o'.repeat(1_200_000) }, run), /ownerAgentId.*120/)
    await assert.rejects(tools.get('configure_project').execute({ project_id: project.id, reviewer_agent_id: 'r'.repeat(1_200_000) }, run), /reviewerAgentId.*120/)
    const after = db.getProject(1, 'default', project.id)
    assert.deepEqual([after.ownerAgentId, after.reviewerAgentId, after.displayName], [before.ownerAgentId, before.reviewerAgentId, before.displayName])
    assert.throws(() => db.createProject(1, 'default', { name: 'X', repoPath: ctx.root, ownerAgentId: 'o'.repeat(500) }), /ownerAgentId.*120/)
    assert.equal(db.listProjects(1, 'default').length, 1)
    await loadFull(ctx, 'agent references')
  } finally { ctx.cleanup() }
})

test('audit#11 r6: a 1.2 MB run_at or agent_id on a schedule is refused and the schedule list stays', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, tools } = ctx
    await orch.getSnapshot(run)
    for (const name of ['create_schedule', 'update_schedule']) {
      const props = tools.get(name).inputSchema.properties
      assert.deepEqual([props.run_at.maxLength, props.agent_id.maxLength], [80, 120], name)
    }
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'scheduled' })
    await assert.rejects(tools.get('create_schedule').execute({ todo_id: card.id, frequency: 'daily', run_at: `2030-01-01T09:00${'9'.repeat(1_200_000)}` }, run), /runAtIso.*80/)
    await assert.rejects(tools.get('create_schedule').execute({ todo_id: card.id, frequency: 'daily', agent_id: 'a'.repeat(1_200_000) }, run), /agentId.*120/)
    assert.equal(db.listSchedules(1, 'default').length, 0)
    const ok = await tools.get('create_schedule').execute({ todo_id: card.id, frequency: 'daily', hour: 9 }, run)
    assert.equal(ok.ok, true)
    const [sch] = db.listSchedules(1, 'default')
    await assert.rejects(tools.get('update_schedule').execute({ schedule_id: sch.id, hour: 10, run_at: 'x'.repeat(1_200_000) }, run), /runAtIso.*80/)
    assert.equal(db.getSchedule(1, 'default', sch.id).hour, 9, 'the refused update changed nothing')
    const snap = await loadFull(ctx, 'schedules')
    assert.equal(snap.schedules.length, 1)
  } finally { ctx.cleanup() }
})

/* ---------- Must-fix 3: a refused write saves nothing ---------- */

test('audit#11 r6: configure_chief with a new charter and an over-long model saves neither', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, tools } = ctx
    await orch.getSnapshot(run)
    db.updateSettings(1, 'default', { charter: 'original charter', maxConcurrentBuilds: 2 })
    const chiefBefore = JSON.stringify(db.listAgents(1, 'default'))
    await assert.rejects(tools.get('configure_chief').execute({ charter: 'new charter', max_concurrent_builds: 5, model: 'm'.repeat(300) }, run), /model.*240/)
    const s = db.getSettings(1, 'default')
    assert.equal(s.charter, 'original charter', 'the charter is not half-saved')
    assert.equal(s.maxConcurrentBuilds, 2)
    assert.equal(JSON.stringify(db.listAgents(1, 'default')), chiefBefore)
    // The other way round: a valid model with an over-long clone root.
    await assert.rejects(tools.get('configure_chief').execute({ model: 'valid-model', default_clone_root: `/tmp/${'d'.repeat(2000)}` }, run), /defaultCloneRoot.*1000/)
    assert.equal(JSON.stringify(db.listAgents(1, 'default')), chiefBefore, 'the model is not half-saved either')
    // When everything is valid, everything is saved.
    const ok = await tools.get('configure_chief').execute({ charter: 'new charter', model: 'valid-model' }, run)
    assert.equal(ok.ok, true)
    assert.equal(db.getSettings(1, 'default').charter, 'new charter')
    assert.ok(db.listAgents(1, 'default').some(a => a.model === 'valid-model'))
  } finally { ctx.cleanup() }
})

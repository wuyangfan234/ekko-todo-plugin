// Todo #13: an agent row stored before the 120-character id limit (only reachable through an older
// database) can still be assigned, and deleting it from the board by its shortened id clears the Chief
// binding and its cooldowns. New over-long ids are still refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'

const MB12 = 1_200_000

function makeFakeHost() {
  let seq = 0
  const sessions = new Map()
  return {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id) { const s = sessions.get(id); if (s) s.is_running = true; return { run_id: `run-${++seq}` } },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { return { messages: sessions.get(id)?.messages || [] } },
    },
  }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-v0922-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {} } })
  const run = { identity: { userId: 1, profile: 'default' }, host: makeFakeHost(), messages: { emit() {} } }
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
  g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
  const { project } = await orch.addProject(run, { name: 'P', repoPath, testCommand: 'true' })
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const rawWrite = fn => { const raw = new DatabaseSync(sqlitePath); try { return fn(raw) } finally { raw.close() } }
  const rawRead = fn => { const raw = new DatabaseSync(sqlitePath, { readOnly: true }); try { return fn(raw) } finally { raw.close() } }
  const cleanup = () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, project, rawWrite, rawRead, cleanup }
}

/** Give an existing agent row an over-long id, as an older database could hold it. */
function makeLegacy(ctx, agentId, longId, { chief = false } = {}) {
  ctx.rawWrite(raw => {
    raw.prepare('UPDATE agents SET id = ? WHERE id = ?').run(longId, agentId)
    if (chief) raw.prepare('UPDATE settings SET chief_agent_id = ?').run(longId)
  })
}

const boardId = async (ctx, longId) => {
  const snap = await ctx.orch.getSnapshot(ctx.run)
  const view = snap.agents.find(a => longId.startsWith(a.id.replace(/…$/, '')) && a.id !== longId)
  assert.ok(view && view.id.length <= 120, 'the board shows the legacy agent with a shortened id')
  return view.id
}

test('v0.9.22: a legacy over-long builder can be assigned by its stored id and by its board id', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project } = ctx
    const builder = db.listAgents(1, 'default').find(a => a.role === 'builder')
    const longId = `LEGACY-BUILDER ${'b'.repeat(300)}`
    makeLegacy(ctx, builder.id, longId)

    // Internal callers pass the full stored id.
    const { todo: t1 } = await orch.createTodo(run, { projectId: project.id, title: 'one' })
    const b1 = await orch.startBuild(run, { todoId: t1.id, agentId: longId })
    assert.equal(b1.agentId, longId)
    assert.equal(db.getTodo(1, 'default', t1.id).agentId, longId)

    // The board sends the shortened id; it resolves to the stored row, not to some other builder.
    const shortId = await boardId(ctx, longId)
    const { todo: t2 } = await orch.createTodo(run, { projectId: project.id, title: 'two' })
    const b2 = await orch.startBuild(run, { todoId: t2.id, agentId: shortId })
    assert.equal(db.getTodo(1, 'default', b2.id).agentId, longId)

    // Direct writes of stored ids work for the reviewer reference as well.
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'card' })
    db.updateTodo(1, 'default', card.id, { reviewerId: longId })
    assert.equal(db.getTodo(1, 'default', card.id).reviewerId, longId)
    db.updateTodo(1, 'default', card.id, { agentId: shortId })
    assert.equal(db.getTodo(1, 'default', card.id).agentId, longId)
  } finally { ctx.cleanup() }
})

test('v0.9.22: new over-long agent ids are still refused, including a 1.2 MB id', async () => {
  const ctx = await setup()
  try {
    const { db, project } = ctx
    const builder = db.listAgents(1, 'default').find(a => a.role === 'builder')
    makeLegacy(ctx, builder.id, `LEGACY-BUILDER ${'b'.repeat(300)}`)
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'card' })
    const before = db.getTodo(1, 'default', card.id)
    assert.throws(() => db.updateTodo(1, 'default', card.id, { agentId: 'n'.repeat(MB12) }), /agentId.*120/)
    assert.throws(() => db.updateTodo(1, 'default', card.id, { reviewerId: `LEGACY-BUILDER ${'b'.repeat(301)}` }), /reviewerId.*120/)
    assert.throws(() => db.upsertAgent(1, 'default', { id: 'n'.repeat(MB12), name: 'huge' }), /id.*120/)
    assert.throws(() => db.updateSettings(1, 'default', { chiefAgentId: 'c'.repeat(MB12) }), /chiefAgentId.*120/)
    const after = db.getTodo(1, 'default', card.id)
    assert.deepEqual([after.agentId, after.reviewerId, after.revision], [before.agentId, before.reviewerId, before.revision])
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT COUNT(*) AS n FROM agents WHERE length(id) > 1000000').get().n), 0)
  } finally { ctx.cleanup() }
})

test('v0.9.22: deleting a legacy over-long Chief by its board id moves the Chief binding off the deleted row', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run } = ctx
    const chief = db.listAgents(1, 'default').find(a => a.role === 'chief')
    const longId = `LEGACY-CHIEF ${'c'.repeat(300)}`
    makeLegacy(ctx, chief.id, longId, { chief: true })
    const shortId = await boardId(ctx, longId)
    await orch.removeAgent(run, shortId)
    const ids = db.listAgents(1, 'default').map(a => a.id)
    assert.ok(!ids.includes(longId), 'the legacy row is deleted')
    const stored = ctx.rawRead(raw => raw.prepare('SELECT chief_agent_id FROM settings').get().chief_agent_id)
    assert.notEqual(stored, longId, 'the Chief binding no longer points at the deleted row')
    assert.ok(ids.includes(stored), 'the Chief binding points at a remaining agent')
  } finally { ctx.cleanup() }
})

test('v0.9.22: deleting the Chief hands the binding to a remaining legacy over-long Chief', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run } = ctx
    const chief = db.listAgents(1, 'default').find(a => a.role === 'chief')
    const other = db.upsertAgent(1, 'default', { name: 'second chief', role: 'chief' })
    const otherLong = `LEGACY-CHIEF-2 ${'d'.repeat(300)}`
    makeLegacy(ctx, other.id, otherLong)
    await orch.removeAgent(run, chief.id)
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT chief_agent_id FROM settings').get().chief_agent_id), otherLong)
  } finally { ctx.cleanup() }
})

test('v0.9.22: clearing cooldowns by the board id of a legacy over-long agent clears its records', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run } = ctx
    const builder = db.listAgents(1, 'default').find(a => a.role === 'builder')
    const longId = `LEGACY-BUILDER ${'b'.repeat(300)}`
    makeLegacy(ctx, builder.id, longId)
    db.recordConfigFailure(longId, 'cfg-primary', 'quota', 'limit')
    assert.equal(db.listAgentCooldowns(longId).length, 1)
    await orch.clearAgentCooldowns(run, await boardId(ctx, longId))
    assert.equal(db.listAgentCooldowns(longId).length, 0)
  } finally { ctx.cleanup() }
})

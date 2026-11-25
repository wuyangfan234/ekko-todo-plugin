// Todo #11 ninth review rework: agent ids and the Chief agent id are bounded (legacy rows shortened in the
// view only), a degraded board never exceeds the host limit, and an older long system prompt survives a
// save from the board.
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
const MB12 = 1_200_000

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit11i-'))
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
  assert.ok(L(snap) <= HOST_JSON_LIMIT, `${label}: snapshot ${L(snap)} bytes exceeds the host limit`)
  assert.equal(snap.snapshotOverflow, undefined, `${label}: not a degraded snapshot`)
  assert.ok(L(snap) <= SNAPSHOT_BUDGET, `${label}: snapshot size ${L(snap)}`)
  assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', snap))
  return snap
}
const viewPayload = view => {
  const { cooldowns: _c, trimmedFields: _t, systemPromptTrimmed: _s, modelConfigsTrimmed: _m, createdAt: _a, updatedAt: _u, ...payload } = view
  return payload
}

/* ---------- Must-fix 1: agent ids ---------- */

test('audit#11 r8: two agents stored with 1.2 MB ids still load within the host limit and stay listed with shortened ids', async () => {
  const ctx = setup()
  try {
    const { db, orch, run } = ctx
    const before = await orch.getSnapshot(run)
    const victims = before.agents.filter(a => a.role !== 'chief').slice(0, 2)
    assert.equal(victims.length, 2)
    const longIds = victims.map((a, i) => `LONG-AGENT-${i} ${'a'.repeat(MB12)}`)
    ctx.rawWrite(raw => victims.forEach((a, i) => raw.prepare('UPDATE agents SET id = ? WHERE id = ?').run(longIds[i], a.id)))
    const snap = await loadFull(ctx, 'legacy agent ids')
    assert.equal(snap.agents.length, before.agents.length, 'every agent is listed')
    for (let i = 0; i < 2; i += 1) {
      const view = snap.agents.find(a => a.id.startsWith(`LONG-AGENT-${i} `))
      assert.ok(view, `agent ${i} is listed`)
      assert.ok(view.id.length <= 120)
      assert.ok(view.trimmedFields.includes('id'))
    }
    // Saving from the board with the shortened id updates the stored row in place.
    const view0 = snap.agents.find(a => a.id.startsWith('LONG-AGENT-0 '))
    await orch.saveAgent(run, { ...viewPayload(view0), name: 'renamed from board' })
    const rows = ctx.rawRead(raw => raw.prepare('SELECT id, name FROM agents').all())
    assert.equal(rows.length, before.agents.length, 'no duplicate agent was created')
    assert.equal(rows.find(r => r.name === 'renamed from board').id, longIds[0], 'the stored id is unchanged')
    // Internal callers that pass the full stored id (e.g. configure_chief re-saving the Chief) still address the row.
    db.upsertAgent(1, 'default', { id: longIds[0], name: 'renamed internally' })
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT name FROM agents WHERE id = ?').get(longIds[0]).name), 'renamed internally')
    // Deleting from the board with the shortened id removes the stored row.
    db.deleteAgent(1, 'default', snap.agents.find(a => a.id.startsWith('LONG-AGENT-1 ')).id)
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT COUNT(*) AS n FROM agents WHERE id = ?').get(longIds[1]).n), 0)
  } finally { ctx.cleanup() }
})

test('audit#11 r8: configure_agent with a 1.2 MB agent_id is refused and nothing is stored; todo agent references are bounded too', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, tools } = ctx
    const before = await orch.getSnapshot(run)
    assert.equal(tools.get('configure_agent').inputSchema.properties.agent_id.maxLength, 120)
    await assert.rejects(tools.get('configure_agent').execute({ agent_id: 'x'.repeat(MB12), name: 'huge', role: 'custom' }, run), /id.*120/)
    assert.equal(db.listAgents(1, 'default').length, before.agents.length, 'no agent was created')
    assert.throws(() => db.upsertAgent(1, 'default', { id: 'y'.repeat(121), name: 'n' }), /id.*120/)
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'card' })
    const cardBefore = db.getTodo(1, 'default', card.id)
    assert.throws(() => db.updateTodo(1, 'default', card.id, { agentId: 'a'.repeat(MB12), title: 'half' }), /agentId.*120/)
    assert.throws(() => db.updateTodo(1, 'default', card.id, { reviewerId: 'r'.repeat(500) }), /reviewerId.*120/)
    const cardAfter = db.getTodo(1, 'default', card.id)
    assert.deepEqual([cardAfter.agentId, cardAfter.reviewerId, cardAfter.title, cardAfter.revision], [cardBefore.agentId, cardBefore.reviewerId, cardBefore.title, cardBefore.revision])
    db.updateTodo(1, 'default', card.id, { agentId: before.agents[1].id })
    assert.equal(db.getTodo(1, 'default', card.id).agentId, before.agents[1].id)
    // A legacy over-long reference survives unrelated updates and an echo of its board form.
    const legacy = `LEG ${'l'.repeat(5000)}`
    ctx.rawWrite(raw => raw.prepare('UPDATE todos SET agent_id = ? WHERE id = ?').run(legacy, card.id))
    db.updateTodo(1, 'default', card.id, { agentId: legacy.slice(0, 119) + '…', phase: 'todo' })
    assert.equal(db.getTodo(1, 'default', card.id).agentId, legacy)
    await loadFull(ctx, 'agent references')
  } finally { ctx.cleanup() }
})

test('audit#11 r8: degraded stubs shorten agent and project ids, and the board never exceeds the host limit', () => {
  const huge = 'x'.repeat(300_000)
  const agents = [0, 1].map(i => ({ id: `AG-${i} ${'a'.repeat(MB12)}`, name: `Agent ${i}`, role: 'builder', avatar: '', systemPrompt: huge }))
  const projects = [0, 1].map(i => ({ id: `PJ-${i} ${'p'.repeat(5000)}`, name: `Project ${i}`, monogram: 'P', accent: 'blue', description: huge }))
  const base = { settings: {}, concurrency: {}, counts: {}, memories: [], schedules: [], quotaProviders: [], runtime: {}, topics: [], todos: [] }
  const fitted = fitSnapshotBudget({ ...base, agents, projects })
  assert.equal(fitted.snapshotOverflow, true)
  assert.ok(L(fitted) <= HOST_JSON_LIMIT, `degraded size ${L(fitted)}`)
  assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', fitted))
  assert.equal(fitted.agents.length, 2, 'agents are still listed')
  assert.ok(fitted.agents.every(a => a.id.length <= 120 && a.stub === true))
  assert.equal(fitted.projects.length, 2)
  assert.ok(fitted.projects.every(p => p.id.length <= 120 && p.stub === true))
  // Even when nothing else can be cut (here: oversized settings, counts and agent names), the result is bounded.
  const worst = fitSnapshotBudget({
    ...base,
    settings: { charter: 'c'.repeat(1_500_000), maxConcurrentBuilds: 2 },
    counts: { note: 'n'.repeat(700_000), done: 3 },
    agents: Array.from({ length: 20_000 }, (_, i) => ({ id: `a${i}`, name: `Agent number ${i} ${'n'.repeat(100)}`, role: 'builder' })),
    projects: Array.from({ length: 20_000 }, (_, i) => ({ id: `p${i}`, name: `Project number ${i} ${'n'.repeat(100)}`, monogram: 'P', accent: 'blue' })),
  })
  assert.equal(worst.snapshotOverflow, true)
  assert.ok(worst.overflowBytes > HOST_JSON_LIMIT)
  assert.ok(L(worst) <= HOST_JSON_LIMIT, `worst-case size ${L(worst)}`)
  assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', worst))
  assert.deepEqual([worst.agents, worst.projects], [[], []])
  assert.equal(worst.settings.maxConcurrentBuilds, 2, 'small settings values are kept')
  assert.equal(worst.counts.done, 3)
})

/* ---------- Must-fix 2: Chief agent id ---------- */

test('audit#11 r8: a 1.2 MB chief_agent_id is refused and the settings keep their previous values', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, tools } = ctx
    await orch.getSnapshot(run)
    assert.equal(tools.get('configure_chief').inputSchema.properties.chief_agent_id.maxLength, 120)
    db.updateSettings(1, 'default', { charter: 'original charter' })
    const before = db.getSettings(1, 'default')
    await assert.rejects(tools.get('configure_chief').execute({ chief_agent_id: 'c'.repeat(MB12), charter: 'new charter' }, run), /chiefAgentId.*120/)
    assert.throws(() => db.updateSettings(1, 'default', { chiefAgentId: 'c'.repeat(121) }), /chiefAgentId.*120/)
    const after = db.getSettings(1, 'default')
    assert.equal(after.chiefAgentId, before.chiefAgentId)
    assert.equal(after.charter, 'original charter')
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT length(chief_agent_id) AS n FROM settings').get().n) <= 120)
    await loadFull(ctx, 'chief agent id')
  } finally { ctx.cleanup() }
})

test('audit#11 r8: an oversized chiefAgentId already stored is shortened in the board view only', async () => {
  const ctx = setup()
  try {
    const { db, orch, run } = ctx
    await orch.getSnapshot(run)
    const legacy = `LEGACY-CHIEF ${'c'.repeat(MB12)}`
    ctx.rawWrite(raw => raw.prepare('UPDATE settings SET chief_agent_id = ?').run(legacy))
    const snap = await loadFull(ctx, 'legacy chief id')
    assert.ok(snap.settings.chiefAgentId.length <= 120 && snap.settings.chiefAgentId.startsWith('LEGACY-CHIEF '))
    assert.equal(snap.settings.chiefAgentIdTrimmed, true)
    // An unrelated settings save, and one that echoes the shortened id back, keep the stored value.
    db.updateSettings(1, 'default', { notifySound: false })
    db.updateSettings(1, 'default', { chiefAgentId: snap.settings.chiefAgentId, notifyPopup: false })
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT chief_agent_id FROM settings').get().chief_agent_id), legacy)
  } finally { ctx.cleanup() }
})

/* ---------- Must-fix 3: system prompt ---------- */

test('audit#11 r8: renaming an agent with the board values keeps an older 1.8 MB system prompt byte for byte', async () => {
  const ctx = setup()
  try {
    const { db, orch, run } = ctx
    const before = await orch.getSnapshot(run)
    const id = before.agents[0].id
    const legacy = `PROMPT-HEAD ${'提'.repeat(1_800_000)} PROMPT-TAIL`
    ctx.rawWrite(raw => raw.prepare('UPDATE agents SET system_prompt = ? WHERE id = ?').run(legacy, id))
    const snap = await loadFull(ctx, 'legacy system prompt')
    const view = snap.agents.find(a => a.id === id)
    assert.ok(view.systemPrompt.length <= 20_000 && view.systemPrompt.startsWith('PROMPT-HEAD '))
    assert.equal(view.systemPromptTrimmed, true)
    const stored = () => ctx.rawRead(raw => raw.prepare('SELECT name, system_prompt FROM agents WHERE id = ?').get(id))
    await orch.saveAgent(run, { ...viewPayload(view), name: 'renamed with prompt echo' })
    assert.equal(stored().name, 'renamed with prompt echo')
    assert.equal(stored().system_prompt, legacy, 'the stored prompt is unchanged')
    // A save that does not carry the prompt at all keeps it too.
    db.upsertAgent(1, 'default', { id, name: 'renamed without prompt' })
    assert.equal(stored().system_prompt, legacy)
    // Workers still get the full prompt.
    assert.equal(db.getAgent(1, 'default', id).systemPrompt, legacy)
    // A real change is written, within 20,000 characters.
    db.upsertAgent(1, 'default', { id, systemPrompt: `NEW ${'n'.repeat(30_000)}` })
    const changed = stored().system_prompt
    assert.ok(changed.startsWith('NEW ') && changed.length <= 20_000)
  } finally { ctx.cleanup() }
})

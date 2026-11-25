// Todo #11 fifth review rework: option ids and labels are capped after normalisation, model configs /
// clone root / project text are bounded, and a degraded board still lists agents and projects.
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
  const root = mkdtempSync(join(tmpdir(), 'ekko-audit11f-'))
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
const hugeIds = () => ['a', 'b', 'c', 'd'].map(p => ({ id: `${p}-${'i'.repeat(900_000)}`, label: `Label ${p}` }))

/* ---------- Must-fix 1: option ids and labels ---------- */

test('audit#11 r5: ask_user with four 900000-character option ids keeps the card at the gate and its options answerable', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, tools } = ctx
    await orch.getSnapshot(run)
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'needs a decision' })
    const idSchema = tools.get('ask_user').inputSchema.properties.options.items.properties.id
    assert.equal(idSchema.maxLength, 120)
    const res = await tools.get('ask_user').execute({ todo_id: card.id, title: 'Q', options: hugeIds() }, run)
    assert.equal(res.ok, true)
    const stored = JSON.parse(ctx.rawRead(raw => raw.prepare('SELECT question_json FROM todos WHERE id = ?').get(card.id).question_json))
    assert.equal(stored.options.length, 4)
    assert.ok(stored.options.every(o => o.id.length <= 120), `stored option id length ${stored.options[0].id.length}`)
    assert.equal(new Set(stored.options.map(o => o.id)).size, 4, 'ids stay distinct')
    const snap = await loadFull(ctx, 'ask_user ids')
    const view = snap.todos.find(t => t.id === card.id)
    assert.ok(view, 'the card waiting for a decision is still on the board')
    assert.equal(view.question.options.length, 4)
    assert.deepEqual(view.question.options.map(o => o.label), ['Label a', 'Label b', 'Label c', 'Label d'])
  } finally { ctx.cleanup() }
})

test('audit#11 r5: topic-level ask_user with four 900000-character option ids does not degrade the board', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, tools } = ctx
    await orch.getSnapshot(run)
    const topic = db.createTopic(1, 'default', { title: 'decision' })
    const res = await tools.get('ask_user').execute({ topic_id: topic.id, title: 'Pick one', options: hugeIds() }, run)
    assert.equal(res.ok, true)
    const brief = JSON.parse(ctx.rawRead(raw => raw.prepare('SELECT brief_json FROM topics WHERE id = ?').get(topic.id).brief_json))
    assert.ok(brief.waitingOptions.every(o => o.id.length <= 120), `stored waiting option id length ${brief.waitingOptions[0].id.length}`)
    const snap = await loadFull(ctx, 'topic ask_user ids')
    const view = snap.topics.find(t => t.id === topic.id)
    assert.equal(view.brief.waitingTitle, 'Pick one')
    assert.equal(view.brief.waitingOptions.length, 4)
  } finally { ctx.cleanup() }
})

test('audit#11 r5: a 400000-character waiting option saved through update_topic_brief is stored within 2000 characters', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, tools } = ctx
    await orch.getSnapshot(run)
    const topic = db.createTopic(1, 'default', { title: 'brief' })
    await tools.get('update_topic_brief').execute({ topic_id: topic.id, waiting_on_you: 'choose', waiting_options: [`HEAD ${'选'.repeat(400_000)}`, 'B'] }, run)
    let brief = JSON.parse(ctx.rawRead(raw => raw.prepare('SELECT brief_json FROM topics WHERE id = ?').get(topic.id).brief_json))
    assert.equal(brief.waitingOptions.length, 2)
    assert.ok(brief.waitingOptions[0].label.length <= 2000 && brief.waitingOptions[0].label.startsWith('HEAD '), `stored label length ${brief.waitingOptions[0].label.length}`)
    // Object options through the db layer: label and id are both capped.
    db.updateTopic(1, 'default', topic.id, { brief: { waitingOptions: [{ id: 'x'.repeat(5000), label: 'y'.repeat(5000) }] } })
    brief = JSON.parse(ctx.rawRead(raw => raw.prepare('SELECT brief_json FROM topics WHERE id = ?').get(topic.id).brief_json))
    assert.ok(brief.waitingOptions[0].id.length <= 120 && brief.waitingOptions[0].label.length <= 2000)
    await loadFull(ctx, 'waiting option')
  } finally { ctx.cleanup() }
})

test('audit#11 r5: oversized option ids already in the database are shortened in the board view only and can still be answered', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project } = ctx
    const card = db.createTodo(1, 'default', { projectId: project.id, title: 'legacy options' })
    db.updateTodo(1, 'default', card.id, { phase: 'confirm', gateOwner: 'human', gateKind: 'question' })
    const options = hugeIds()
    const legacyQuestion = JSON.stringify({ active: true, version: 1, title: 'Q', why: '', options, answeredText: '' })
    const topic = db.createTopic(1, 'default', { title: 'legacy brief' })
    const legacyBrief = JSON.stringify({ goal: '', progress: '', next: '', waitingOnYou: 'choose', waitingTitle: 'choose', waitingRecommendation: '', waitingOptions: options, blocked: '', updatedAt: 1 })
    ctx.rawWrite(raw => {
      raw.prepare('UPDATE todos SET question_json = ? WHERE id = ?').run(legacyQuestion, card.id)
      raw.prepare('UPDATE topics SET brief_json = ? WHERE id = ?').run(legacyBrief, topic.id)
    })
    const snap = await loadFull(ctx, 'legacy option ids')
    const view = snap.todos.find(t => t.id === card.id)
    assert.ok(view, 'the card is not left out')
    assert.ok(view.question.options.every(o => o.id.length <= 120))
    assert.equal(new Set(view.question.options.map(o => o.id)).size, 4)
    assert.equal(view.questionTrimmed, true)
    const topicView = snap.topics.find(t => t.id === topic.id)
    assert.ok(topicView.brief.waitingOptions.every(o => o.id.length <= 120))
    assert.equal(topicView.briefTrimmed, true)
    // Unrelated updates leave the stored options alone.
    db.appendTimeline(1, 'default', card.id, 'unrelated', 'system')
    db.updateTopic(1, 'default', topic.id, { pinned: true })
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT question_json FROM todos WHERE id = ?').get(card.id).question_json), legacyQuestion)
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT brief_json FROM topics WHERE id = ?').get(topic.id).brief_json), legacyBrief)
    // The shortened id the board shows still selects the right stored option.
    const { findOptionById } = await import('../src/server/diff-budget.mjs')
    assert.equal(findOptionById(options, view.question.options[2].id).label, 'Label c')
    assert.equal(findOptionById(options, options[1].id).label, 'Label b', 'the full id still works')
    assert.equal(findOptionById(options, 'nope'), undefined)
  } finally { ctx.cleanup() }
})

/* ---------- Must-fix 2: model configs, clone root, project text, degraded lists ---------- */

test('audit#11 r5: a 1.2 MB baseUrl in model_configs is refused, nothing is stored, agents and projects stay listed', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, tools } = ctx
    const before = await orch.getSnapshot(run)
    const agent = before.agents[0]
    await assert.rejects(
      tools.get('configure_agent').execute({ agent_id: agent.id, model_configs: [{ id: 'cfg-a', engine: 'hermes', provider: 'p', model: 'm', baseUrl: `https://x/${'u'.repeat(1_200_000)}` }] }, run),
      /baseUrl.*500/,
    )
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT MAX(length(model_configs_json)) AS n, MAX(length(base_url)) AS b FROM agents').get()).n < 20_000)
    // The flat single-config fields are bounded the same way.
    await assert.rejects(tools.get('configure_agent').execute({ agent_id: agent.id, base_url: 'u'.repeat(600) }, run), /baseUrl.*500/)
    await assert.rejects(tools.get('configure_agent').execute({ agent_id: agent.id, model: 'm'.repeat(300) }, run), /model.*240/)
    // A long label is descriptive text: it is shortened, not refused.
    await tools.get('configure_agent').execute({ agent_id: agent.id, model_configs: [{ id: 'cfg-a', label: 'L'.repeat(500), engine: 'hermes', provider: 'p', model: 'm' }] }, run)
    assert.ok(db.getAgent(1, 'default', agent.id).modelConfigs[0].label.length <= 80)
    const snap = await loadFull(ctx, 'model configs')
    assert.equal(snap.agents.length, before.agents.length)
    assert.equal(snap.projects.length, 1)
  } finally { ctx.cleanup() }
})

test('audit#11 r5: oversized model configs already in the database are shortened in the board view only', async () => {
  const ctx = setup()
  try {
    const { db, orch, run } = ctx
    const before = await orch.getSnapshot(run)
    const agent = before.agents[0]
    const legacy = JSON.stringify([{ id: 'cfg-legacy', label: 'x', engine: 'hermes', mode: 'scoped', provider: 'p', model: 'm', apiMode: '', baseUrl: `https://legacy/${'u'.repeat(1_200_000)}`, customModel: false, reasoningEffort: '' }])
    ctx.rawWrite(raw => raw.prepare('UPDATE agents SET model_configs_json = ?, base_url = ? WHERE id = ?').run(legacy, `https://legacy/${'u'.repeat(1_200_000)}`, agent.id))
    const snap = await loadFull(ctx, 'legacy model configs')
    assert.equal(snap.agents.length, before.agents.length)
    assert.equal(snap.projects.length, 1)
    const view = snap.agents.find(a => a.id === agent.id)
    assert.ok(view.modelConfigs[0].baseUrl.length <= 500 && view.modelConfigs[0].baseUrl.startsWith('https://legacy/'))
    assert.ok(view.baseUrl.length <= 500)
    assert.equal(view.modelConfigsTrimmed, true)
    // Renaming the agent does not rewrite its stored configs.
    db.upsertAgent(1, 'default', { id: agent.id, name: 'renamed' })
    assert.equal(ctx.rawRead(raw => raw.prepare('SELECT model_configs_json FROM agents WHERE id = ?').get(agent.id).model_configs_json), legacy)
  } finally { ctx.cleanup() }
})

test('audit#11 r5: a 1.2 MB default_clone_root is refused and the stored value stays within 1000 characters', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, tools } = ctx
    await orch.getSnapshot(run)
    assert.equal(tools.get('configure_chief').inputSchema.properties.default_clone_root.maxLength, 1000)
    await assert.rejects(tools.get('configure_chief').execute({ default_clone_root: `/tmp/${'d'.repeat(1_200_000)}` }, run), /defaultCloneRoot.*1000/)
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT length(default_clone_root) AS n FROM settings').get().n) <= 1000)
    await tools.get('configure_chief').execute({ default_clone_root: '/tmp/clones' }, run)
    assert.equal(db.getSettings(1, 'default').defaultCloneRoot, '/tmp/clones')
    // Legacy rows: view only.
    ctx.rawWrite(raw => raw.prepare('UPDATE settings SET default_clone_root = ?').run(`/legacy/${'d'.repeat(1_200_000)}`))
    const snap = await loadFull(ctx, 'legacy clone root')
    assert.ok(snap.settings.defaultCloneRoot.length <= 1000 && snap.settings.defaultCloneRoot.startsWith('/legacy/'))
    assert.equal(snap.settings.defaultCloneRootTrimmed, true)
    db.updateSettings(1, 'default', { notifySound: false })
    assert.ok(ctx.rawRead(raw => raw.prepare('SELECT length(default_clone_root) AS n FROM settings').get().n) > 1_200_000)
  } finally { ctx.cleanup() }
})

test('audit#11 r5: a 1.1 MB project name is shortened, a 1.1 MB test command is refused, and projects stay listed', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project, tools } = ctx
    const before = await orch.getSnapshot(run)
    const props = tools.get('configure_project').inputSchema.properties
    assert.deepEqual([props.name.maxLength, props.repo_path.maxLength, props.github_repo.maxLength, props.default_branch.maxLength, props.test_command.maxLength], [120, 1000, 200, 120, 500])
    const res = await tools.get('configure_project').execute({ project_id: project.id, name: `NAME ${'n'.repeat(1_100_000)}` }, run)
    assert.equal(res.ok, true)
    const stored = db.getProject(1, 'default', project.id)
    assert.ok(stored.name.length <= 120 && stored.name.startsWith('NAME '), `stored name length ${stored.name.length}`)
    // A command that would be executed is never cut short: it is refused and the old one stays.
    await assert.rejects(tools.get('configure_project').execute({ project_id: project.id, test_command: `echo ${'t'.repeat(1_100_000)}` }, run), /testCommand.*500/)
    assert.equal(db.getProject(1, 'default', project.id).testCommand, '')
    assert.throws(() => db.createProject(1, 'default', { name: 'X', repoPath: ctx.root, description: 'ok', remoteUrl: 'r'.repeat(600) }), /remoteUrl.*500/)
    const made = db.createProject(1, 'default', { name: 'N'.repeat(500), repoPath: ctx.root, description: 'D'.repeat(5000) })
    assert.ok(made.name.length <= 120 && made.description.length <= 2000)
    const snap = await loadFull(ctx, 'project text')
    assert.equal(snap.projects.length, 2)
    assert.equal(snap.agents.length, before.agents.length)
  } finally { ctx.cleanup() }
})

test('audit#11 r5: oversized project text already in the database is shortened in the board view only and survives a save from that view', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, project } = ctx
    const before = await orch.getSnapshot(run)
    const legacyCmd = `npm test -- ${'t'.repeat(1_100_000)} TAIL`
    ctx.rawWrite(raw => raw.prepare('UPDATE projects SET name = ?, test_command = ?, description = ? WHERE id = ?').run(`LEGACY ${'n'.repeat(1_100_000)}`, legacyCmd, 'D'.repeat(50_000), project.id))
    const snap = await loadFull(ctx, 'legacy project text')
    assert.equal(snap.agents.length, before.agents.length)
    const view = snap.projects.find(p => p.id === project.id)
    assert.ok(view.name.length <= 120 && view.name.startsWith('LEGACY '))
    assert.ok(view.testCommand.length <= 500 && view.description.length <= 2000)
    assert.deepEqual([...view.trimmedFields].sort(), ['description', 'name', 'testCommand'])
    // The project form sends the shortened values back; the stored command must not be replaced by its cut form.
    db.updateProject(1, 'default', project.id, { displayName: 'alias', name: view.name, testCommand: view.testCommand, description: view.description })
    const row = ctx.rawRead(raw => raw.prepare('SELECT display_name, test_command, length(name) AS n, length(description) AS d FROM projects WHERE id = ?').get(project.id))
    assert.equal(row.display_name, 'alias')
    assert.equal(row.test_command, legacyCmd)
    assert.ok(row.n > 1_100_000 && row.d === 50_000)
    // The gate still runs the full stored command, never the shortened view.
    assert.equal(db.getProject(1, 'default', project.id).testCommand, legacyCmd)
  } finally { ctx.cleanup() }
})

test('audit#11 r5: a degraded board lists every agent and project by name instead of emptying both lists', () => {
  const big = 'x'.repeat(300_000)
  const agents = Array.from({ length: 6 }, (_, i) => ({ id: `agent-${i}`, name: `Agent ${i}`, role: i ? 'builder' : 'chief', avatar: 'notion:a-1', systemPrompt: big, modelConfigs: [] }))
  const projects = Array.from({ length: 6 }, (_, i) => ({ id: `proj-${i}`, name: `Project ${i}`, monogram: 'P', accent: 'blue', avatar: '', description: big }))
  const snap = { settings: {}, concurrency: {}, counts: {}, memories: [], schedules: [{ id: 's' }], quotaProviders: [], runtime: {}, topics: [], todos: [], agents, projects }
  assert.ok(L(snap) > HOST_JSON_LIMIT)
  const fitted = fitSnapshotBudget(snap)
  assert.equal(fitted.snapshotOverflow, true)
  assert.ok(L(fitted) <= SNAPSHOT_BUDGET, `degraded size ${L(fitted)}`)
  assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', fitted))
  assert.deepEqual(fitted.agents, agents.map(a => ({ id: a.id, name: a.name, role: a.role, stub: true })))
  assert.deepEqual(fitted.projects, projects.map(p => ({ id: p.id, name: p.name, monogram: 'P', accent: 'blue', stub: true })))
})

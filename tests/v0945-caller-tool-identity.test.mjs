// Todo #42: with two Chief runs under way, a card created without a topic id went to the run that started
// last, which says nothing about who is calling. The host announces every tool before running it
// (chat.tool.started), so the Chief session that has just started the create-todo tool is the caller.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import { assertReleaseMetadata } from './helpers/release-metadata.mjs'

const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const CREATE_TOOL = 'mcp__ekko_todo__ekko_todo__create_utodo'

function initRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test User')
  writeFileSync(join(repoDir, 'app.txt'), 'ok\n', 'utf8')
  git('add', '.')
  git('commit', '-m', 'init')
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-caller-tool-'))
  const repoDir = join(root, 'repo')
  const dataDir = join(root, 'data')
  initRepo(repoDir)
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  // The clock that dates tool events; a test moves it to make an event old.
  const time = { offsetMs: 0 }
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn() {}, info() {} }, clock: () => Date.now() + time.offsetMs })
  const working = new Map()
  const hostMessages = new Map()
  let seq = 0
  let runs = 0
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(body) { seq += 1; const id = `s-${seq}`; hostMessages.set(id, []); return { session: { id, title: body?.title } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async get(sid) { return { session: { id: sid, ended_at: null }, is_running: Boolean(working.get(sid)) } },
      async connect(sid, cb) {
        setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(working.get(sid)), runStartedAt: Date.now() }), 2)
        return { close() {} }
      },
      async run(sid) { runs += 1; working.set(sid, true); return { run_id: `r-${runs}` } },
      async stop(sid) { working.set(sid, false) },
      async messages(sid) { return { messages: hostMessages.get(sid) || [] } },
    },
  }
  // The MCP tool call carries no identity.sessionId (the reason #33 and this card exist).
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const { project } = await orch.addProject(run, { name: 'demo', repoPath: repoDir })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const chiefTopic = async (sessionId, input = {}) => {
    // #97: a card is only ever linked to a topic of its own project, so the fixture topic is of the fixture project.
    const { topic } = await orch.createTopic(run, { projectId: project.id, ...input })
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  const hostEvent = (type, sessionId) => orch.handleHostEvent({ type, data: { session_id: sessionId } }, run)
  // The shape the host really sends: the session in subject, the tool name in summary, no arguments.
  const toolEvent = (type, sessionId, toolName) => orch.handleHostEvent({ type, subject: { session_id: sessionId }, summary: { tool_name: toolName } }, run)
  const createCard = title => tools.get('create_todo').execute({ project_id: project.id, title }, run)
  const tick = () => new Promise(r => setTimeout(r, 4))
  // Two Chief runs under way; the one that is NOT the caller started last, as in the live case.
  const twoChiefs = async () => {
    const caller = await chiefTopic('sess-caller', { title: '调用方话题' })
    await tick()
    const other = await chiefTopic('sess-other', { title: '另一个项目' })
    await hostEvent('chat.run.started', 'sess-caller')
    await tick()
    await hostEvent('chat.run.started', 'sess-other')
    return { caller, other }
  }
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, project, tools, time, chiefTopic, hostEvent, toolEvent, createCard, twoChiefs, tick, cleanup }
}

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const timelineOf = (db, id) => db.getTodo(1, 'default', id).timeline.map(e => e.event)

test('#42 L1.6: with two Chiefs running, the one that started the create-todo tool gets the card, though the other started later', async () => {
  const ctx = await setup()
  try {
    const { db, toolEvent, createCard, twoChiefs } = ctx
    const { caller, other } = await twoChiefs()
    await toolEvent('chat.tool.started', 'sess-caller', CREATE_TOOL)

    const res = await createCard('两个总管并跑，调用方靠工具事件识别')
    assert.equal(res.ok, true)
    assert.equal(res.data.topicResolvedBy, 'caller-tool')
    assert.equal(res.data.topicId, caller.id, 'the card lands in the topic of the calling Chief')
    assert.notEqual(res.data.topicId, other.id, 'not in the topic of the Chief that merely started later')
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', res.data.id).map(w => w.topicId), [caller.id])
    const lines = timelineOf(db, res.data.id)
    assert.ok(lines.includes('建单未指定话题：按调用中的工具定位到话题「调用方话题」'), `timeline: ${JSON.stringify(lines)}`)
    assert.equal(lines.some(l => /活跃总管运行/.test(l)), false, 'not reported as a guess')
    assert.doesNotMatch(res.content, /无法确定建卡归属/, 'no warning when the caller is known')
  } finally { ctx.cleanup() }
})

test('#42 L1.6: a tool event older than 120 seconds is not trusted', async () => {
  const ctx = await setup()
  try {
    const { time, toolEvent, createCard, twoChiefs } = ctx
    const { caller, other } = await twoChiefs()
    await toolEvent('chat.tool.started', 'sess-caller', CREATE_TOOL)

    time.offsetMs = 119 * 1000
    const fresh = await createCard('119 秒内仍算调用方')
    assert.equal(fresh.data.topicResolvedBy, 'caller-tool')
    assert.equal(fresh.data.topicId, caller.id)

    time.offsetMs = 10 * 60 * 1000
    const stale = await createCard('十分钟前的工具事件')
    assert.notEqual(stale.data.topicResolvedBy, 'caller-tool', 'an event from 10 minutes ago does not identify the caller')
    assert.equal(stale.data.topicResolvedBy, 'active-run', 'the running-Chief guess takes over')
    assert.equal(stale.data.topicId, other.id)
  } finally { ctx.cleanup() }
})

test('#42 L1.6: a tool that does not create a card does not make its Chief the caller', async () => {
  const ctx = await setup()
  try {
    const { toolEvent, createCard, twoChiefs } = ctx
    const { caller, other } = await twoChiefs()
    // 0.9.54: no write/execute tool here — the strict chief guard would stop that turn (covered in v0954 tests).
    for (const name of ['search_files', 'read_file', 'tool_call', 'mcp__ekko_todo__ekko_todo__update_utodo', 'mcp__ekko_todo__ekko_todo__list_utodos', 'mcp__ekko_todo__ekko_todo__complete_utodo']) {
      await toolEvent('chat.tool.started', 'sess-caller', name)
      const res = await createCard(`非建卡工具 ${name}`)
      assert.equal(res.data.topicResolvedBy, 'active-run', `${name} is not a create-todo call`)
      assert.equal(res.data.topicId, other.id)
    }
    // The same session then really calls the tool.
    await toolEvent('chat.tool.started', 'sess-caller', CREATE_TOOL)
    const res = await createCard('随后真的调用建卡工具')
    assert.equal(res.data.topicResolvedBy, 'caller-tool')
    assert.equal(res.data.topicId, caller.id)
  } finally { ctx.cleanup() }
})

test('#42 L1.6: a build session that starts the create-todo tool is not taken for the caller', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, hostEvent, toolEvent, createCard, twoChiefs } = ctx
    const { caller, other } = await twoChiefs()
    const first = await orch.createTodo(run, { projectId: project.id, topicId: caller.id, title: '先有一张在构建的卡' })
    const started = await orch.startBuild(run, { todoId: first.todo.id })
    assert.ok(started.buildSessionId)
    assert.equal(db.findTopicBySessionId(started.buildSessionId), null, 'the build session is no topic\'s Chief session')
    await hostEvent('chat.run.started', started.buildSessionId)
    await toolEvent('chat.tool.started', started.buildSessionId, CREATE_TOOL)
    await toolEvent('chat.tool.started', 'sess-plain-chat', CREATE_TOOL)

    const res = await createCard('构建会话发了建卡工具事件')
    assert.notEqual(res.data.topicResolvedBy, 'caller-tool')
    assert.equal(res.data.topicResolvedBy, 'active-run')
    assert.equal(res.data.topicId, other.id)
    assert.match(res.content, /无法确定建卡归属/, 'with two Chiefs running and no caller found, the answer says so')
  } finally { ctx.cleanup() }
})

test('#42 L1.5: two Chiefs running and no create-todo tool event: still the latest start, but the answer asks for topic_id and the timeline calls it a guess', async () => {
  const ctx = await setup()
  try {
    const { db, createCard, twoChiefs } = ctx
    const { other } = await twoChiefs()
    const res = await createCard('多总管且无工具事件')
    assert.equal(res.data.topicResolvedBy, 'active-run')
    assert.equal(res.data.topicId, other.id, 'the last started run, as before')
    assert.match(res.content, /当前有 2 个总管会话在运行，无法确定建卡归属，请显式传 topic_id/)
    const line = timelineOf(db, res.data.id).find(l => /活跃总管运行/.test(l))
    assert.ok(line, 'the guess is on the timeline')
    assert.match(line, /2 个总管在跑，无法确定调用方，取最近开始的/)
  } finally { ctx.cleanup() }
})

test('#42 L1.5: a single running Chief needs no warning', async () => {
  const ctx = await setup()
  try {
    const { db, chiefTopic, hostEvent, createCard } = ctx
    const only = await chiefTopic('sess-only')
    await hostEvent('chat.run.started', 'sess-only')
    const res = await createCard('只有一个总管在跑')
    assert.equal(res.data.topicResolvedBy, 'active-run')
    assert.equal(res.data.topicId, only.id)
    assert.doesNotMatch(res.content, /无法确定建卡归属/)
    assert.equal(timelineOf(db, res.data.id).some(l => /活跃总管运行/.test(l)), false)
  } finally { ctx.cleanup() }
})

test('#42 L1.6: every tool-name form and every event field the name may arrive in is recognised', async () => {
  const ctx = await setup()
  try {
    const { orch, run, createCard, twoChiefs, hostEvent } = ctx
    const { caller } = await twoChiefs()
    const names = [
      'mcp__ekko_todo__ekko_todo__create_utodo',
      'mcp__ekko_todo__ekko_todo__create_todo',
      'mcp_ekko_todo_ekko_todo__create_utodo',
      'ekko_todo__create_utodo',
      'ekko-todo.create_todo',
      'create_utodo',
      'create_todo',
      'create-todo',
      'create-utodo',
      'createTodo',
      'CREATE_UTODO',
    ]
    for (const name of names) {
      await orch.handleHostEvent({ type: 'chat.tool.started', subject: { session_id: 'sess-caller' }, summary: { tool_name: name } }, run)
      const res = await createCard(`工具名形态 ${name}`)
      assert.equal(res.data.topicResolvedBy, 'caller-tool', `tool name ${name}`)
      assert.equal(res.data.topicId, caller.id, `tool name ${name}`)
      // A new run forgets the call, so the next name is judged on its own.
      await hostEvent('chat.run.started', 'sess-caller')
      await hostEvent('chat.run.started', 'sess-other')
    }
    const carriers = [
      { data: { session_id: 'sess-caller', toolName: CREATE_TOOL, arguments: { project_id: 'p', title: 't' } } },
      { data: { session_id: 'sess-caller', name: CREATE_TOOL } },
      { data: { session_id: 'sess-caller', tool: CREATE_TOOL } },
      { data: { sessionId: 'sess-caller', summary: { tool_name: CREATE_TOOL } } },
      { payload: { session_id: 'sess-caller', tool_name: CREATE_TOOL } },
      { subject: { session_id: 'sess-caller' }, summary: { tool_name: CREATE_TOOL } },
    ]
    for (const carrier of carriers) {
      await orch.handleHostEvent({ type: 'chat.tool.started', ...carrier }, run)
      const res = await createCard('事件字段形态')
      assert.equal(res.data.topicResolvedBy, 'caller-tool', `event shape ${JSON.stringify(carrier)}`)
      assert.equal(res.data.topicId, caller.id)
      await hostEvent('chat.run.started', 'sess-caller')
      await hostEvent('chat.run.started', 'sess-other')
    }
  } finally { ctx.cleanup() }
})

test('#42 L1.6: of two Chiefs that both started the tool the later call wins; a finished call and an ended run are forgotten', async () => {
  const ctx = await setup()
  try {
    const { hostEvent, toolEvent, createCard, twoChiefs, tick } = ctx
    const { caller, other } = await twoChiefs()
    await toolEvent('chat.tool.started', 'sess-other', CREATE_TOOL)
    await tick()
    await toolEvent('chat.tool.started', 'sess-caller', CREATE_TOOL)
    const latest = await createCard('两个总管都发了建卡工具事件')
    assert.equal(latest.data.topicResolvedBy, 'caller-tool')
    assert.equal(latest.data.topicId, caller.id, 'the most recent call')

    // The caller's call ends: the other Chief's call is the one still open.
    await toolEvent('chat.tool.completed', 'sess-caller', CREATE_TOOL)
    const afterDone = await createCard('调用方的建卡已结束')
    assert.equal(afterDone.data.topicResolvedBy, 'caller-tool')
    assert.equal(afterDone.data.topicId, other.id)

    // The other Chief's run ends: nothing identifies a caller any more, one Chief is left running.
    await hostEvent('chat.run.completed', 'sess-other')
    const afterRun = await createCard('另一个总管的运行已结束')
    assert.equal(afterRun.data.topicResolvedBy, 'active-run')
    assert.equal(afterRun.data.topicId, caller.id)
  } finally { ctx.cleanup() }
})

test('#42 L1.6: tools started in one batch with the create-todo call do not hide it', async () => {
  const ctx = await setup()
  try {
    const { toolEvent, createCard, twoChiefs } = ctx
    const { caller } = await twoChiefs()
    await toolEvent('chat.tool.started', 'sess-caller', CREATE_TOOL)
    await toolEvent('chat.tool.started', 'sess-caller', 'mcp__ekko_todo__ekko_todo__list_utodos')
    const res = await createCard('同一批并行工具')
    assert.equal(res.data.topicResolvedBy, 'caller-tool')
    assert.equal(res.data.topicId, caller.id)
  } finally { ctx.cleanup() }
})

test('#42 L1.6: a Chief of another account or of an archived topic is not the caller, and identity.sessionId still outranks the tool event', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic, hostEvent, toolEvent, createCard } = ctx
    const otherRun = { ...run, identity: { userId: 2, profile: 'default' } }
    const { topic: foreign } = await orch.createTopic(otherRun, {})
    db.updateTopic(2, 'default', foreign.id, { chiefSessionId: 'sess-foreign' })
    await hostEvent('chat.run.started', 'sess-foreign')
    await toolEvent('chat.tool.started', 'sess-foreign', CREATE_TOOL)
    const archived = await chiefTopic('sess-archived')
    await hostEvent('chat.run.started', 'sess-archived')
    await toolEvent('chat.tool.started', 'sess-archived', CREATE_TOOL)
    db.updateTopic(1, 'default', archived.id, { archived: true })
    const res = await createCard('不串账号也不进归档话题')
    assert.notEqual(res.data.topicId, foreign.id)
    assert.notEqual(res.data.topicId, archived.id)
    assert.equal(res.data.topicResolvedBy, 'unattended')

    const a = await chiefTopic('sess-a')
    const b = await chiefTopic('sess-b')
    await hostEvent('chat.run.started', 'sess-b')
    await toolEvent('chat.tool.started', 'sess-b', CREATE_TOOL)
    const explicit = await orch.createTodo(run, { projectId: project.id, topicId: a.id, title: '显式话题' })
    assert.equal(explicit.topicResolvedBy, 'explicit')
    assert.equal(explicit.todo.topicId, a.id)
    const viaSession = await orch.createTodo({ ...run, identity: { ...run.identity, sessionId: 'sess-a' } }, { projectId: project.id, title: '宿主给了会话' })
    assert.equal(viaSession.topicResolvedBy, 'caller-session')
    assert.equal(viaSession.todo.topicId, a.id)
    const viaTool = await orch.createTodo(run, { projectId: project.id, title: '宿主没给会话' })
    assert.equal(viaTool.topicResolvedBy, 'caller-tool')
    assert.equal(viaTool.todo.topicId, b.id)
  } finally { ctx.cleanup() }
})

test('#42: the contract, the tool description and the docs name caller-tool', () => {
  assert.match(contract.models.createTodoInput.properties.topicId.description, /caller-tool/)
  assert.match(contract.tools.create_todo.description, /caller-tool/)
  assert.match(read('src/server/mcp-tools.mjs'), /无法确定建卡归属/)
  const docs = read('docs/CONTRACTS.md')
  assert.match(docs, /caller-tool/)
  assert.match(docs, /chiefToolCalls/)
})

test('#42: shipped bundle carries the change and the release metadata stays consistent', () => {
  const server = read('dist/server.mjs')
  for (const literal of ['chiefToolCalls', 'identifyCallerByTool', 'caller-tool']) assert.ok(server.includes(literal), `server bundle has ${literal}`)
  // #112: format + the five places, stated once in tests/helpers/release-metadata.mjs (no fixed 0.9.x).
  assertReleaseMetadata()
  const changelog = read('CHANGELOG.md')
  const start = changelog.indexOf('## [0.9.45]')
  assert.ok(start >= 0)
  const section = changelog.slice(start, changelog.indexOf('\n## [', start + 1))
  assert.match(section, /caller-tool/)
  for (const v of ['0.9.44', '0.9.43', '0.9.42', '0.9.41', '0.9.40', '0.9.38']) assert.ok(changelog.includes(`## [${v}]`), `section ${v} is kept`)
})

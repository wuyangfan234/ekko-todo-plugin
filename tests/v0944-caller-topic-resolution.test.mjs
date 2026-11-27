// Todo #33: a card created without a topic id never reached the caller's Chief topic. The MCP tool call carries
// no identity.sessionId, and the project fallback only looked at topics of the same project in sidebar order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'
import { validateModel } from '../sdk/harness/contracts.mjs'
import * as clientUtils from '../src/client/utils.js'
import { assertReleaseMetadata } from './helpers/release-metadata.mjs'

const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const PROGRESS = /^关注的任务有进展：#\d+/

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
  const root = mkdtempSync(join(tmpdir(), 'ekko-caller-topic-'))
  const repoDir = join(root, 'repo')
  const dataDir = join(root, 'data')
  initRepo(repoDir)
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  const warnings = []
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn(message, data) { warnings.push({ message, data }) }, info() {} } })
  const sessionRuns = []
  const working = new Map()
  const hostMessages = new Map()
  let seq = 0
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
      async run(sid, input, opts) { sessionRuns.push({ sid, input, opts }); working.set(sid, true); return { run_id: `r-${sessionRuns.length}` } },
      async stop(sid) { working.set(sid, false) },
      async messages(sid) { return { messages: hostMessages.get(sid) || [] } },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  // A tool call made from inside a host session carries that session in identity.sessionId.
  const runFrom = sessionId => ({ ...run, identity: { ...run.identity, sessionId } })
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const { project } = await orch.addProject(run, { name: 'demo', repoPath: repoDir })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const wakeRows = todoId => {
    const raw = new DatabaseSync(sqlitePath, { readOnly: true })
    try { return raw.prepare('SELECT wake_key, topic_id FROM wake_log WHERE todo_id = ?').all(todoId) } finally { raw.close() }
  }
  const chiefTopic = async (sessionId, input = {}) => {
    // #97: a card is only ever linked to a topic of its own project, so the fixture topic is of the fixture project.
    const { topic } = await orch.createTopic(run, { projectId: project.id, ...input })
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  // Runs the card's build to the end, the same way a finished host run is settled.
  const finishBuild = async todoId => {
    const started = await orch.startBuild(run, { todoId })
    assert.equal(started.phase, 'building')
    working.set(started.buildSessionId, false)
    hostMessages.set(started.buildSessionId, [{ id: 'm1', role: 'assistant', content: '完成。', timestamp: 1 }])
    return orch.settleWorkerRun(run, 1, 'default', todoId, { sessionId: started.buildSessionId, outcome: 'completed' })
  }
  const progressNotices = topicId => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'system' && PROGRESS.test(m.text))
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  const addRepo = async name => {
    const dir = join(root, name)
    initRepo(dir)
    return (await orch.addProject(run, { name, repoPath: dir })).project
  }
  const hostEvent = (type, sessionId) => orch.handleHostEvent({ type, data: { session_id: sessionId } }, run)
  const unattendedNotices = topicId => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'system' && /无人值守话题/.test(m.text))
  const tick = () => new Promise(r => setTimeout(r, 4))
  return { db, orch, run, runFrom, project, tools, sessionRuns, warnings, wakeRows, chiefTopic, finishBuild, progressNotices, addRepo, hostEvent, unattendedNotices, tick, cleanup }
}

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('#33 L1.5: no identity.sessionId, but the Chief session of a topic is running: the card lands in that topic', async () => {
  const ctx = await setup()
  try {
    const { db, tools, run, project, chiefTopic, hostEvent, unattendedNotices, tick } = ctx
    // The caller topic is not the most recently active one, so "the newest Chief topic" does not find it.
    // #97: both are topics of the card's project; a running Chief of another project never takes the card
    // (see tests/v0972-topic-project-ownership.test.mjs).
    const home = await chiefTopic('sess-chief')
    await tick()
    const newer = await chiefTopic('sess-idle')
    db.addTopicMessage(1, 'default', newer.id, { kind: 'human', text: '更晚的活动' })
    await hostEvent('chat.run.started', 'sess-chief')

    assert.equal(run.identity.sessionId, undefined, 'the tool call carries no session id')
    const res = await tools.get('create_todo').execute({ project_id: project.id, title: '探针卡：不带话题' }, run)
    assert.equal(res.ok, true)
    const todo = db.getTodo(1, 'default', res.data.id)
    assert.equal(todo.topicId, home.id, 'the card belongs to the topic whose Chief session is running')
    assert.equal(res.data.topicId, home.id)
    assert.equal(res.data.topicResolvedBy, 'active-run')
    assert.equal(db.listTopics(1, 'default').length, 2, 'no extra topic is created')
    assert.equal(unattendedNotices(home.id).length, 0, 'not reported as unattended')
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', todo.id).map(w => w.topicId), [home.id])
  } finally { ctx.cleanup() }
})

test('#33 L1.5: a run that ended is no longer the caller; with two running Chiefs the latest start wins and the timeline says so', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic, hostEvent, tick } = ctx
    const a = await chiefTopic('sess-a')
    await tick()
    const b = await chiefTopic('sess-b')
    await hostEvent('chat.run.started', 'sess-a')
    await tick()
    await hostEvent('chat.run.started', 'sess-b')
    const both = await orch.createTodo(run, { projectId: project.id, title: '两个总管都在跑', actor: 'chief' })
    assert.equal(both.todo.topicId, b.id, 'the run that started last')
    assert.equal(both.topicResolvedBy, 'active-run')
    assert.ok(both.todo.timeline.some(e => /活跃总管运行/.test(e.event) && e.event.includes('2')), 'the timeline records that it was inferred among 2 running Chiefs')

    await hostEvent('chat.run.stopped', 'sess-b')
    const one = await orch.createTodo(run, { projectId: project.id, title: '只剩一个总管在跑', actor: 'chief' })
    assert.equal(one.todo.topicId, a.id)
    assert.equal(one.topicResolvedBy, 'active-run')
    assert.equal(one.todo.timeline.some(e => /活跃总管运行/.test(e.event)), false, 'a single running Chief needs no note')
  } finally { ctx.cleanup() }
})

test('#33 L1.5: a running Chief of another account, or of an archived topic, is not used', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic, hostEvent } = ctx
    const otherRun = { ...run, identity: { userId: 2, profile: 'default' } }
    const { topic: foreign } = await orch.createTopic(otherRun, {})
    db.updateTopic(2, 'default', foreign.id, { chiefSessionId: 'sess-foreign' })
    await hostEvent('chat.run.started', 'sess-foreign')
    const archived = await chiefTopic('sess-archived')
    await hostEvent('chat.run.started', 'sess-archived')
    db.updateTopic(1, 'default', archived.id, { archived: true })
    const res = await orch.createTodo(run, { projectId: project.id, title: '不串账号也不进归档话题' })
    assert.notEqual(res.todo.topicId, foreign.id)
    assert.notEqual(res.todo.topicId, archived.id)
    assert.equal(res.topicResolvedBy, 'unattended')
  } finally { ctx.cleanup() }
})

test('#33 L1.5: a running build session is not taken for a caller topic', async () => {
  const ctx = await setup()
  try {
    const { db, orch, tools, run, project, hostEvent, unattendedNotices } = ctx
    const first = await orch.createTodo(run, { projectId: project.id, title: '先有一张在构建的卡' })
    const shellId = first.todo.topicId
    const started = await orch.startBuild(run, { todoId: first.todo.id })
    assert.ok(started.buildSessionId)
    await hostEvent('chat.run.started', started.buildSessionId)
    await hostEvent('chat.tool.started', started.buildSessionId)
    await hostEvent('chat.run.started', 'sess-plain-chat')

    const res = await tools.get('create_todo').execute({ project_id: project.id, title: '构建会话在跑时建的卡' }, run)
    const todo = db.getTodo(1, 'default', res.data.id)
    assert.equal(res.data.topicResolvedBy, 'unattended', 'the tool result says that no caller topic was found')
    assert.match(res.content, /topic_id/, 'and tells the caller to pass topic_id')
    assert.equal(todo.topicId, shellId)
    assert.equal(db.getTopic(1, 'default', todo.topicId).chiefSessionId, '')
    assert.equal(unattendedNotices(shellId).length, 2, 'still announced in the topic')
  } finally { ctx.cleanup() }
})

test('#33 L2 (#97): with no caller and no Chief topic in the project, a Chief topic of another project does not take the card', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic, unattendedNotices } = ctx
    const other = await ctx.addRepo('tianji')
    const elsewhere = await chiefTopic('sess-elsewhere', { projectId: other.id, title: '三线改造' })
    const res = await orch.createTodo(run, { projectId: project.id, title: '跨项目兜底' })
    assert.notEqual(res.todo.topicId, elsewhere.id, 'never linked to a topic of another project')
    assert.equal(res.topicResolvedBy, 'unattended')
    const home = db.getTopic(1, 'default', res.todo.topicId)
    assert.equal(home.projectId, project.id, 'a topic of the card\'s project is created instead')
    assert.equal(home.autopilot, false)
    assert.equal(db.listTopics(1, 'default').length, 2)
    assert.equal(unattendedNotices(elsewhere.id).length, 0)
    assert.equal(unattendedNotices(home.id).length, 1)
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', res.todo.id).map(w => w.topicId), [home.id])

    // Same project: nothing to explain.
    const same = await chiefTopic('sess-same', { projectId: project.id })
    db.addTopicMessage(1, 'default', same.id, { kind: 'human', text: '最新活动' })
    const res2 = await orch.createTodo(run, { projectId: project.id, title: '同项目' })
    assert.equal(res2.todo.topicId, same.id)
    assert.equal(res2.todo.timeline.some(e => /与建卡项目/.test(e.event)), false)
  } finally { ctx.cleanup() }
})

test('#33 L2: among several Chief topics the most recently updated one is taken, not the pinned one', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic, tick } = ctx
    const pinned = await chiefTopic('sess-pinned', { projectId: project.id, title: '置顶但更旧' })
    db.updateTopic(1, 'default', pinned.id, { pinned: true })
    await tick()
    const recent = await chiefTopic('sess-recent', { projectId: project.id, title: '最近活动' })
    const listed = db.listTopics(1, 'default', { includeArchived: false })
    assert.equal(listed[0].id, pinned.id, 'the sidebar order puts the pinned topic first')
    assert.ok(db.getTopic(1, 'default', recent.id).updatedAt > db.getTopic(1, 'default', pinned.id).updatedAt)
    const res = await orch.createTodo(run, { projectId: project.id, title: '按活跃度排序' })
    assert.equal(res.todo.topicId, recent.id)
    assert.equal(res.topicResolvedBy, 'chief-topic')
  } finally { ctx.cleanup() }
})

test('#33 degradation: when the host sent no run.started, tool events still mark the Chief as running; with no event at all the card goes to a Chief topic (L2), never silently to an unattended one', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic, hostEvent, tick, unattendedNotices } = ctx
    const home = await chiefTopic('sess-chief')
    await tick()
    const newer = await chiefTopic('sess-newer')
    const none = await orch.createTodo(run, { projectId: project.id, title: '一个事件都没收到', actor: 'chief' })
    assert.equal(none.topicResolvedBy, 'chief-topic')
    assert.equal(none.todo.topicId, newer.id)
    assert.equal(unattendedNotices(newer.id).length, 0)

    await hostEvent('chat.tool.started', 'sess-chief')
    const viaTool = await orch.createTodo(run, { projectId: project.id, title: '只收到工具事件', actor: 'chief' })
    assert.equal(viaTool.topicResolvedBy, 'active-run')
    assert.equal(viaTool.todo.topicId, home.id)
  } finally { ctx.cleanup() }
})

test('#33: an explicit topic and the caller session keep their priority and are reported', async () => {
  const ctx = await setup()
  try {
    const { orch, run, runFrom, project, chiefTopic, hostEvent } = ctx
    const a = await chiefTopic('sess-a')
    const b = await chiefTopic('sess-b')
    await hostEvent('chat.run.started', 'sess-b')
    const explicit = await orch.createTodo(run, { projectId: project.id, topicId: a.id, title: '显式话题' })
    assert.equal(explicit.todo.topicId, a.id)
    assert.equal(explicit.topicResolvedBy, 'explicit')
    const caller = await orch.createTodo(runFrom('sess-a'), { projectId: project.id, title: '宿主给了会话' })
    assert.equal(caller.todo.topicId, a.id, 'identity.sessionId outranks the running-Chief guess')
    assert.equal(caller.topicResolvedBy, 'caller-session')
  } finally { ctx.cleanup() }
})

test('#33: create-todo over RPC still answers a contract-valid stateSnapshot', async () => {
  const ctx = await setup()
  try {
    const { orch, run, project } = ctx
    const res = await orch.createTodo(run, { projectId: project.id, title: '快照仍合规' })
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', res.state))
  } finally { ctx.cleanup() }
})

test('#33: update-topic moves a topic to a project, detaches it with an empty id, and refuses a project that does not exist', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic } = ctx
    const other = await ctx.addRepo('other')
    const topic = await chiefTopic('sess-chief', { projectId: other.id })
    const { todo } = await orch.createTodo(run, { projectId: other.id, topicId: topic.id, title: '话题里的卡' })
    const moved = await orch.updateTopicMeta(run, { topicId: topic.id, projectId: project.id })
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', moved))
    assert.equal(db.getTopic(1, 'default', topic.id).projectId, project.id)
    await orch.updateTopicMeta(run, { topicId: topic.id, projectId: '' })
    const detached = db.getTopic(1, 'default', topic.id)
    assert.equal(detached.projectId, '')
    assert.equal(detached.chiefSessionId, 'sess-chief', 'the Chief session is kept')
    assert.equal(db.getTodo(1, 'default', todo.id).projectId, other.id, 'cards keep their own project')
    assert.deepEqual(detached.watchedTodoIds, [todo.id])
    await assert.rejects(() => orch.updateTopicMeta(run, { topicId: topic.id, projectId: 'proj-missing' }), /项目不存在/)
    assert.equal(db.getTopic(1, 'default', topic.id).projectId, '')
    // A topic made without a project stays without one.
    const { topic: fresh } = await orch.createTopic(run, {})
    assert.equal(fresh.projectId, '')
  } finally { ctx.cleanup() }
})

test('#33: the contract and the tool tell a caller to pass topic_id when it cannot be identified', () => {
  const desc = contract.models.createTodoInput.properties.topicId.description
  assert.match(desc, /topic_id/)
  assert.match(desc, /active-run|running/i)
  assert.match(contract.tools.create_todo.description, /topicResolvedBy/)
  const tools = read('src/server/mcp-tools.mjs')
  assert.match(tools, /topicResolvedBy/)
})

test('#33: a new topic is not tied to the first project, and a topic can be moved to a project or to none from its menu', () => {
  const app = read('src/client/App.jsx')
  assert.doesNotMatch(app, /create-topic'[^\n]*\n?[^\n]*projects\??\.?\[0\]/, 'create-topic does not default to the first project')
  assert.doesNotMatch(app, /const projId = contextProjectId \|\| \(state\?\.projects\?\.\[0\]\?\.id/)
  assert.match(app, /newTopicProjectId/)
  const dialogs = read('src/client/components/Dialogs.jsx')
  assert.match(dialogs, /export function CreateTopicDialog[\s\S]{0,200}useState\(defaultProjectId \|\| ''\)/)
  assert.match(dialogs, /不归属项目（可跨项目使用）/)
  assert.match(dialogs, /export function TopicProjectDialog/)
  const pane = read('src/client/components/ChatPane.jsx')
  assert.match(pane, /data-testid="btn-topic-project"/)
  assert.match(pane, /改挂项目/)
  assert.match(pane, /onUpdateTopicMeta\?\.\(topic\.id, \{ projectId/)
})

test('#33: shipped bundles carry the change and the release metadata stays consistent', () => {
  const server = read('dist/server.mjs')
  for (const literal of ['activeChiefRuns', 'inferCallerTopicId', 'topicResolvedBy']) assert.ok(server.includes(literal), `server bundle has ${literal}`)
  const client = read('dist/client.mjs')
  // The client bundle escapes non-ASCII text, so it is checked by its test ids.
  for (const literal of ['btn-topic-project', 'topic-project-dialog', 'topic-project-select', 'btn-topic-project-save']) assert.ok(client.includes(literal), `client bundle has ${literal}`)
  // #112: format + the five places, stated once in tests/helpers/release-metadata.mjs (no fixed 0.9.x).
  assertReleaseMetadata()
  const changelog = read('CHANGELOG.md')
  const start = changelog.indexOf('## [0.9.44]')
  assert.ok(start >= 0)
  const section = changelog.slice(start, changelog.indexOf('\n## [', start + 1))
  assert.match(section, /调用方/)
  for (const v of ['0.9.43', '0.9.42', '0.9.41', '0.9.40', '0.9.38']) assert.ok(changelog.includes(`## [${v}]`), `section ${v} is kept`)
})

// Todo #28: cards created without a topic id were bound to a new topic that had no Chief session, and
// the wake for such a topic was skipped without a notice, a wake_log row or a timeline entry.
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
  const root = mkdtempSync(join(tmpdir(), 'ekko-notify-'))
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
    const { topic } = await orch.createTopic(run, input)
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  // Runs the card's build to the end, the same way a finished host run is settled.
  const finishBuild = async todoId => {
    const started = await orch.startBuild(run, { todoId })
    assert.equal(started.phase, 'building')
    // 0.9.47: a finished build has output. A round that leaves the worktree as it was is an idle round now.
    writeFileSync(join(started.worktreePath, 'built.txt'), 'built\n')
    working.set(started.buildSessionId, false)
    hostMessages.set(started.buildSessionId, [{ id: 'm1', role: 'assistant', content: '完成。', timestamp: 1 }])
    return orch.settleWorkerRun(run, 1, 'default', todoId, { sessionId: started.buildSessionId, outcome: 'completed' })
  }
  const progressNotices = topicId => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'system' && PROGRESS.test(m.text))
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, project, tools, sessionRuns, warnings, wakeRows, chiefTopic, finishBuild, progressNotices, cleanup }
}

test('#28: create_todo without topic_id, called from a Chief session, lands in that Chief\'s topic and its completion is notified', async () => {
  const ctx = await setup()
  try {
    const { db, tools, runFrom, project, chiefTopic, finishBuild, progressNotices, wakeRows, sessionRuns } = ctx
    // The live case: the Chief's topic is not tied to the project, so "first topic of the project" finds nothing.
    const home = await chiefTopic('sess-chief')
    const res = await tools.get('create_todo').execute({ project_id: project.id, title: '聊天区围栅代码块长行不换行' }, runFrom('sess-chief'))
    assert.equal(res.ok, true)
    const todo = db.getTodo(1, 'default', res.data.id)

    assert.equal(db.listTopics(1, 'default').length, 1, 'no extra topic is created for the card')
    assert.equal(todo.topicId, home.id, 'the card belongs to the topic of the calling Chief session')
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', todo.id).map(w => w.topicId), [home.id])
    for (const tp of db.listTopics(1, 'default')) {
      if (tp.watchedTodoIds.includes(todo.id)) assert.ok(tp.chiefSessionId, 'the watching topic has a Chief session')
    }

    const settled = await finishBuild(todo.id)
    assert.equal(settled.phase, 'review')
    assert.equal(progressNotices(home.id).length, 1, 'the Chief topic gets the progress notice')
    assert.equal(wakeRows(todo.id).length, 1, 'the wake is recorded in wake_log')
    assert.equal(wakeRows(todo.id)[0].topic_id, home.id)
    assert.ok(sessionRuns.some(r => r.sid === 'sess-chief'), 'the Chief session is woken')
  } finally { ctx.cleanup() }
})

test('#28: a Chief session of another account or profile is not used as the caller topic', async () => {
  const ctx = await setup()
  try {
    const { db, orch, tools, runFrom, project } = ctx
    const otherRun = { ...ctx.run, identity: { userId: 2, profile: 'default' } }
    const { topic: foreign } = await orch.createTopic(otherRun, {})
    db.updateTopic(2, 'default', foreign.id, { chiefSessionId: 'sess-foreign' })
    const res = await tools.get('create_todo').execute({ project_id: project.id, title: '跨账号不串话题' }, runFrom('sess-foreign'))
    const todo = db.getTodo(1, 'default', res.data.id)
    assert.notEqual(todo.topicId, foreign.id)
    assert.equal(db.getTopic(1, 'default', todo.topicId)?.id, todo.topicId, 'the card stays in a topic of its own account')
  } finally { ctx.cleanup() }
})

test('#28: without a caller session the card prefers a project topic that has a Chief session over one that has none', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic } = ctx
    const attended = await chiefTopic('sess-project-chief', { projectId: project.id })
    await new Promise(r => setTimeout(r, 3))
    // Newer, same project, no Chief session: the old code picked this one because it sorts first.
    const { topic: shell } = await orch.createTopic(run, { projectId: project.id, title: '空壳' })
    assert.equal(db.listTopics(1, 'default', { includeArchived: false }).find(t => t.projectId === project.id).id, shell.id)
    const { todo } = await orch.createTodo(run, { projectId: project.id, title: '页面上新建的卡片' })
    assert.equal(todo.topicId, attended.id)
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', todo.id).map(w => w.topicId), [attended.id])
  } finally { ctx.cleanup() }
})

test('#28: when no topic can be determined the new topic says it is unattended, and progress is still written and logged', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, finishBuild, progressNotices, wakeRows, sessionRuns, warnings } = ctx
    const { todo, state } = await orch.createTodo(run, { projectId: project.id, title: '没有任何话题时建的卡片' })
    assert.doesNotThrow(() => validateModel(contract, 'stateSnapshot', state))
    const topic = db.getTopic(1, 'default', todo.topicId)
    assert.equal(topic.chiefSessionId, '')
    assert.equal(topic.autopilot, false, 'gates of an unattended topic wait for the user, not for a Chief that does not exist')
    assert.ok(topic.messages.some(m => m.kind === 'system' && /无人值守话题/.test(m.text) && m.text.includes(`#${todo.number}`)), 'the topic states that nobody attends it')
    const view = state.topics.find(t => t.id === topic.id)
    assert.equal(clientUtils.isUnattendedTopic(view), true, 'the board can tell this topic apart')

    const before = sessionRuns.length
    const settled = await finishBuild(todo.id)
    assert.equal(settled.gateOwner, 'human')
    const notices = progressNotices(topic.id)
    assert.equal(notices.length, 1, 'the progress notice is stored even though no Chief can be woken')
    assert.match(notices[0].progressNotice, /未唤醒总管/)
    assert.equal(wakeRows(todo.id).length, 1, 'wake_log records the attempt')
    assert.ok(db.getTodo(1, 'default', todo.id).timeline.some(e => /没有总管会话/.test(e.event)), 'the card timeline names the reason')
    assert.ok(warnings.some(w => /without a Chief session/.test(w.message)), 'the host log has a warning')
    assert.equal(sessionRuns.length, before + 1, 'only the build session ran; no wake was sent to an empty session id')

    // A second card for the same project reuses the unattended topic instead of adding one more.
    const again = await orch.createTodo(run, { projectId: project.id, title: '第二张' })
    assert.equal(again.todo.topicId, topic.id)
    assert.equal(db.listTopics(1, 'default').length, 1)
    assert.equal(db.getTopic(1, 'default', topic.id).messages.filter(m => /无人值守话题/.test(m.text)).length, 2, 'each card is announced')
  } finally { ctx.cleanup() }
})

test('#28: a card watched by a topic without a Chief session and by the Chief\'s topic still wakes the Chief', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic, finishBuild, progressNotices, wakeRows, sessionRuns } = ctx
    // The stored state of the live case after the one-off repair: the card sits in the topic made for it,
    // and the Chief's topic watches it as well.
    const { todo } = await orch.createTodo(run, { projectId: project.id, title: '空壳话题里的旧卡片' })
    const shellId = todo.topicId
    const home = await chiefTopic('sess-chief')
    db.watchTodo(1, 'default', home.id, todo.id, 'Watched by chief')
    await finishBuild(todo.id)
    assert.equal(progressNotices(home.id).length, 1)
    assert.equal(progressNotices(shellId).length, 1)
    assert.ok(sessionRuns.some(r => r.sid === 'sess-chief'), 'the topic without a Chief session did not take the wake')
    assert.deepEqual(wakeRows(todo.id).map(r => r.topic_id).sort(), [home.id, shellId].sort())
  } finally { ctx.cleanup() }
})

test('#28: a wake for an archived or deleted topic leaves a timeline entry and a warning instead of nothing', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, project, chiefTopic, finishBuild, progressNotices, wakeRows, warnings } = ctx
    const home = await chiefTopic('sess-chief')
    const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: home.id, title: '话题随后被归档' })
    db.updateTopic(1, 'default', home.id, { archived: true })
    await finishBuild(todo.id)
    assert.equal(progressNotices(home.id).length, 0, 'an archived topic is not written to')
    assert.ok(db.getTodo(1, 'default', todo.id).timeline.some(e => /进展通知未送达.*已归档/.test(e.event)))
    assert.equal(wakeRows(todo.id).length, 1)
    assert.ok(warnings.some(w => /archived or missing/.test(w.message)))
  } finally { ctx.cleanup() }
})

test('#28: the sidebar marks a topic that watches cards but has no Chief session', () => {
  const { isUnattendedTopic } = clientUtils
  assert.equal(typeof isUnattendedTopic, 'function')
  assert.equal(isUnattendedTopic({ chiefSessionId: '', watchedTodoIds: ['td-1'] }), true)
  assert.equal(isUnattendedTopic({ chiefSessionId: 's-1', watchedTodoIds: ['td-1'] }), false)
  assert.equal(isUnattendedTopic({ chiefSessionId: '', watchedTodoIds: [] }), false, 'a new empty topic is not flagged')
  assert.equal(isUnattendedTopic({ chiefSessionId: '', watchedTodoIds: ['td-1'], isRunning: true }), false, 'a first turn that is starting is not flagged')
  assert.equal(isUnattendedTopic(null), false)
  const sidebar = readFileSync(new URL('../src/client/components/Sidebar.jsx', import.meta.url), 'utf8')
  assert.match(sidebar, /isUnattendedTopic\(tp\)/)
  assert.match(sidebar, /topic-unattended-\$\{tp\.id\}/)
  assert.match(sidebar, /无人值守/)
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.ot-nav-unattended-tag\s*\{/)
})

test('#28: the changelog has a section for this fix', () => {
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  // Found by its own wording, not by a version number: later releases add sections above it.
  const mine = changelog.split(/^(?=## \[)/m).filter(sec => /^## \[\d+\.\d+\.\d+\]/.test(sec) && sec.includes('无人值守话题'))
  assert.ok(mine.length >= 1)
})

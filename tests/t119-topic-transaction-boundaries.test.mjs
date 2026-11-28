// Todo #119: two writes about topics were outside the transaction of the result they belong to.
//   1. update-topic (updateTopicMeta) wrote the topic-adopt row and then the topic, without a transaction: a
//      topic that does not exist, or a topic write that fails, left the row behind. For a topic whose project
//      was never decided the row means "decided" (#97 / #118), so that topic stayed without a project and could
//      no longer be bound by the first card of its Chief.
//   2. create-todo created the topic of a project that has none before the transaction that writes the card:
//      a card that was not stored left an empty topic without a Chief session behind, one per failed call.
// Both are now one transaction with the rest of the call. Each test below fails a write on purpose (the db
// layer is a plain object, the orchestrator reads its methods by name) and reads the stored state through a
// second, read-only connection, which sees committed rows only.
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
import { assertReleaseMetadata } from './helpers/release-metadata.mjs'

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

// alpha: a project with a Chief topic (sess-alpha). gamma: a project without any topic. fresh: a Chief topic
// (sess-fresh) made without a project and never touched by update-topic, so it has no topic-adopt row.
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t119-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn() {}, info() {} } })
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create() { return { session: { id: 's-1' } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async get(sid) { return { session: { id: sid, ended_at: null }, is_running: false } },
      async connect() { return { close() {} } },
      async run(sid) { return { run_id: `r-${sid}` } },
      async stop() {},
      async messages() { return { messages: [] } },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const runFrom = sessionId => ({ ...run, identity: { ...run.identity, sessionId } })
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const addRepo = async name => {
    const dir = join(root, name)
    initRepo(dir)
    return (await orch.addProject(run, { name, repoPath: dir })).project
  }
  const alpha = await addRepo('alpha')
  const gamma = await addRepo('gamma')
  const chiefTopic = async (sessionId, input = {}) => {
    const { topic } = await orch.createTopic(run, input)
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  const topicA = await chiefTopic('sess-alpha', { projectId: alpha.id, title: '甲项目话题' })
  const fresh = await chiefTopic('sess-fresh', { title: '新话题' })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const call = async (name, input, from = run) => {
    try { return await tools.get(name).execute(input, from) } catch (err) { return { ok: false, thrown: err?.message || String(err) } }
  }
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const scalar = (text, ...params) => {
    const raw = new DatabaseSync(sqlitePath, { readOnly: true })
    try { return raw.prepare(text).get(...params).n } finally { raw.close() }
  }
  const counts = () => ({
    todos: scalar('SELECT COUNT(*) AS n FROM todos'),
    watches: scalar('SELECT COUNT(*) AS n FROM todo_watches'),
    topics: scalar('SELECT COUNT(*) AS n FROM topics'),
    messages: scalar('SELECT COUNT(*) AS n FROM topic_messages'),
    wakes: scalar('SELECT COUNT(*) AS n FROM wake_log'),
  })
  const adoptRows = topicId => scalar('SELECT COUNT(*) AS n FROM wake_log WHERE wake_key = ?', `topic-adopt:${topicId}`)
  const topicOf = id => db.getTopic(1, 'default', id)
  const topicsOf = project => db.listTopics(1, 'default', { includeArchived: true }).filter(t => t.projectId === project.id)
  // Replaces one db method by one that throws, for the duration of fn; `hits` counts how often it was reached.
  const failing = async (method, fn) => {
    const real = db[method]
    const probe = { hits: 0 }
    db[method] = () => { probe.hits += 1; throw new Error(`disk I/O error (injected in ${method})`) }
    try { probe.result = await fn() } catch (err) { probe.thrown = err?.message || String(err) } finally { db[method] = real }
    return probe
  }
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, alpha, gamma, topicA, fresh, call, counts, adoptRows, topicOf, topicsOf, failing, chiefTopic, cleanup }
}

// ── 1. update-topic: the topic-adopt row and the topic are one transaction ───────────────────────────

test('#119 update-topic: a topic that does not exist is refused and leaves no topic-adopt row', async () => {
  const ctx = await setup()
  try {
    const { orch, run, alpha, counts, adoptRows } = ctx
    const before = counts()
    await assert.rejects(() => orch.updateTopicMeta(run, { topicId: 'topic-gone', projectId: alpha.id }), /Topic not found: topic-gone/)
    await assert.rejects(() => orch.updateTopicMeta(run, { topicId: 'topic-gone', projectId: '' }), /Topic not found: topic-gone/)
    assert.equal(adoptRows('topic-gone'), 0, 'no row for a topic that is not there')
    assert.deepEqual(counts(), before)
  } finally { ctx.cleanup() }
})

test('#119 update-topic: when the topic write fails the topic-adopt row is not stored, so the topic is still bound by the first card', async () => {
  const ctx = await setup()
  try {
    const { orch, run, runFrom, alpha, gamma, fresh, call, counts, adoptRows, topicOf, failing } = ctx
    assert.equal(adoptRows(fresh.id), 0, 'fixture: the project of this topic was never decided')
    const before = counts()
    const probe = await failing('updateTopic', () => orch.updateTopicMeta(run, { topicId: fresh.id, projectId: alpha.id }))
    assert.equal(probe.hits, 1, 'the injected failure was reached')
    assert.match(probe.thrown, /disk I\/O error \(injected in updateTopic\)/)
    assert.deepEqual(counts(), before, 'nothing was stored')
    assert.equal(adoptRows(fresh.id), 0, 'the row did not stay behind')
    assert.equal(topicOf(fresh.id).projectId, '')
    // What the row left behind used to break: a topic without a project that counts as decided.
    assert.equal(orch.topicBindsOnFirstCard(topicOf(fresh.id)), true)
    const card = await call('create_todo', { project_id: gamma.id, title: '改挂失败后的第一张卡' }, runFrom('sess-fresh'))
    assert.equal(card.ok, true, card.thrown)
    assert.equal(card.data.topicBoundProjectId, gamma.id)
    assert.equal(card.data.topicId, fresh.id)
    assert.equal(topicOf(fresh.id).projectId, gamma.id)
  } finally { ctx.cleanup() }
})

test('#119 update-topic: the call that failed can be repeated; a call that succeeds stores project and row as before', async () => {
  const ctx = await setup()
  try {
    const { orch, run, alpha, fresh, counts, adoptRows, topicOf, failing } = ctx
    const before = counts()
    await failing('updateTopic', () => orch.updateTopicMeta(run, { topicId: fresh.id, projectId: '' }))
    assert.equal(adoptRows(fresh.id), 0, 'detaching failed: not counted as a decision of the user')
    // Fields other than the project never write the row.
    await orch.updateTopicMeta(run, { topicId: fresh.id, title: '改了标题', pinned: true })
    assert.equal(adoptRows(fresh.id), 0)
    assert.equal(topicOf(fresh.id).title, '改了标题')
    assert.deepEqual(counts(), before)
    const snap = await orch.updateTopicMeta(run, { topicId: fresh.id, projectId: alpha.id })
    assert.equal(snap.topics.find(t => t.id === fresh.id).projectId, alpha.id, 'the answer is the snapshot, with the new project')
    assert.equal(adoptRows(fresh.id), 1)
    await orch.updateTopicMeta(run, { topicId: fresh.id, projectId: '' })
    assert.equal(topicOf(fresh.id).projectId, '')
    assert.equal(adoptRows(fresh.id), 1, 'written once')
    assert.equal(orch.topicBindsOnFirstCard(topicOf(fresh.id)), false, 'a topic the user detached is never bound (#118 G4)')
    assert.deepEqual(counts(), { ...before, wakes: before.wakes + 1 })
  } finally { ctx.cleanup() }
})

// ── 2. create-todo: the topic made for the card is in the transaction of the card ────────────────────

test('#119 create-todo: when the card is not stored, the topic that was to be created for it is not left behind', async () => {
  const ctx = await setup()
  try {
    const { orch, run, gamma, counts, topicsOf, failing } = ctx
    assert.equal(topicsOf(gamma).length, 0, 'fixture: the project has no topic, so one has to be created')
    const before = counts()
    // The first write after the topic.
    const probe = await failing('createTodo', () => orch.createTodo(run, { projectId: gamma.id, title: '写卡失败' }))
    assert.equal(probe.hits, 1, 'the injected failure was reached')
    assert.match(probe.thrown, /disk I\/O error \(injected in createTodo\)/)
    assert.deepEqual(counts(), before, 'no topic, card, watch or message')
    assert.equal(topicsOf(gamma).length, 0)
  } finally { ctx.cleanup() }
})

test('#119 create-todo: when the last write (the notice in the new topic) fails nothing is stored; the next call creates one topic and card #1', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, gamma, counts, topicsOf, failing } = ctx
    const before = counts()
    for (const title of ['第一次失败', '第二次失败']) {
      const probe = await failing('addTopicMessage', () => orch.createTodo(run, { projectId: gamma.id, title }))
      assert.equal(probe.hits, 1, 'the injected failure was reached')
      assert.match(probe.thrown, /disk I\/O error \(injected in addTopicMessage\)/)
      assert.deepEqual(counts(), before, 'failed calls do not pile up empty topics')
    }
    const title = '无人值守话题里的第一张卡，标题超过三十二个字符时话题标题只取前三十二个字符为止'
    const made = await orch.createTodo(run, { projectId: gamma.id, title })
    assert.equal(made.todo.number, 1, 'the card number of the failed calls was not used up')
    assert.equal(made.topicResolvedBy, 'unattended')
    assert.equal(made.topicRedirectedFrom, null)
    const topics = topicsOf(gamma)
    assert.equal(topics.length, 1, 'exactly one topic')
    const topic = db.getTopic(1, 'default', topics[0].id)
    assert.equal(made.todo.topicId, topic.id)
    assert.equal(topic.title, title.slice(0, 32))
    assert.equal(topic.autopilot, false)
    assert.equal(topic.chiefSessionId, '')
    assert.deepEqual(topic.watchedTodoIds, [made.todo.id])
    assert.deepEqual(topic.messages.filter(m => m.kind === 'system').map(m => m.text), [
      '无人值守话题：#1 建单时没有指定话题，也无法从调用方会话确定话题，已挂到本话题。本话题没有总管会话，任务进展只会记录在这里，不会唤醒总管；在这里发一条消息即可让总管接手。',
    ])
    assert.deepEqual(counts(), { ...before, todos: before.todos + 1, watches: before.watches + 1, topics: before.topics + 1, messages: before.messages + 1 })
    // The topic exists now: the next card takes it and no second one is created.
    const next = await orch.createTodo(run, { projectId: gamma.id, title: '第二张' })
    assert.equal(next.todo.topicId, topic.id)
    assert.equal(topicsOf(gamma).length, 1)
  } finally { ctx.cleanup() }
})

test('#119 create_todo tool: a card sent on from a topic of another project leaves no topic when its watch fails; repeated, timeline and answer name the new topic', async () => {
  const ctx = await setup()
  try {
    const { db, runFrom, gamma, topicA, call, counts, topicsOf, failing } = ctx
    const before = counts()
    const probe = await failing('watchTodo', () => call('create_todo', { project_id: gamma.id, title: '跨项目的卡' }, runFrom('sess-alpha')))
    assert.equal(probe.hits, 1, 'the injected failure was reached')
    assert.match(probe.result.thrown, /disk I\/O error \(injected in watchTodo\)/)
    assert.deepEqual(counts(), before)
    assert.equal(topicsOf(gamma).length, 0)
    const res = await call('create_todo', { project_id: gamma.id, title: '跨项目的卡' }, runFrom('sess-alpha'))
    assert.equal(res.ok, true, res.thrown)
    assert.equal(res.data.number, 1)
    assert.equal(res.data.topicResolvedBy, 'unattended')
    assert.equal(res.data.topicRedirectedFrom, topicA.id)
    const topics = topicsOf(gamma)
    assert.equal(topics.length, 1)
    assert.equal(res.data.topicId, topics[0].id)
    const todo = db.getTodo(1, 'default', res.data.id)
    assert.ok(todo.timeline.some(e => e.event === '当前话题「甲项目话题」属于项目 alpha，已转到项目 gamma 的话题「跨项目的卡」'), 'the timeline names the topic that was created')
    assert.deepEqual(db.getTopic(1, 'default', topics[0].id).messages.filter(m => m.kind === 'system').map(m => m.text), [
      '无人值守话题：#1 建单的话题「甲项目话题」不属于项目 gamma，卡片已转到本话题。本话题没有总管会话，任务进展只会记录在这里，不会唤醒总管；在这里发一条消息即可让总管接手。',
    ])
  } finally { ctx.cleanup() }
})

// ── 3. the contract ──────────────────────────────────────────────────────────────────────────────────

test('#119 contract: update-topic and create-todo declare the transaction; CONTRACTS.md no longer says the topic is created before it', () => {
  const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
  assert.match(contract.rpc['update-topic'].description, /topic-adopt:<topicId>.*one transaction \(#119/)
  assert.match(contract.rpc['create-todo'].description, /the topic created for the card.*one transaction.*#119/)
  const docs = readFileSync(new URL('../docs/CONTRACTS.md', import.meta.url), 'utf8')
  assert.match(docs, /Since #119 \(0\.9\.75\) so is the topic a call has to create/)
  assert.match(docs, /Since #119 \(0\.9\.75\) the `wake_log` row `topic-adopt:<topicId>`/)
  assert.equal(docs.includes('is still created before it'), false)
  assertReleaseMetadata()
})

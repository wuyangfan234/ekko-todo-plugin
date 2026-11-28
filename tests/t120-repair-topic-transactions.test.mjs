// Todo #120: the two repair calls of #97 wrote without a transaction.
//   1. repair-todo-topic created the topic of a project that has none, then wrote the card, its watches, the
//      timeline line and the two topic messages one by one: a write that failed left an empty topic behind
//      (one per failed call), or a card that was moved without the messages that say so.
//   2. repair-topic-todos moved the cards one by one and wrote the topic messages last: a write that failed
//      in between left some cards moved and no message in any topic. The call can be repeated, but the cards
//      already moved are not foreign any more, so the repeated call never names them.
// Both are now one transaction. Each test below fails a write on purpose (the db layer is a plain object, the
// orchestrator reads its methods by name) and reads the stored state through a second, read-only connection,
// which sees committed rows only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
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

// alpha and beta: projects with a Chief topic each (topicA, topicB). gamma: a project without any topic.
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t120-'))
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
  const emitted = []
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit(name, data) { emitted.push(data?.reason || name) } } }
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const addRepo = async name => {
    const dir = join(root, name)
    initRepo(dir)
    return (await orch.addProject(run, { name, repoPath: dir })).project
  }
  const alpha = await addRepo('alpha')
  const beta = await addRepo('beta')
  const gamma = await addRepo('gamma')
  const chiefTopic = async (sessionId, input) => {
    const { topic } = await orch.createTopic(run, input)
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  const topicA = await chiefTopic('sess-alpha', { projectId: alpha.id, title: '甲项目话题' })
  const topicB = await chiefTopic('sess-beta', { projectId: beta.id, title: '乙项目话题' })
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const sql = (text, ...params) => {
    const raw = new DatabaseSync(sqlitePath)
    try { return raw.prepare(text).run(...params) } finally { raw.close() }
  }
  const committed = (text, ...params) => {
    const raw = new DatabaseSync(sqlitePath, { readOnly: true })
    try { return raw.prepare(text).all(...params) } finally { raw.close() }
  }
  // Everything a repair writes, as committed: the row counts, every card (topic, revision; the timeline is
  // part of the card row, so a new line raises the revision) and every watch.
  const stored = () => ({
    topics: committed('SELECT COUNT(*) AS n FROM topics')[0].n,
    messages: committed('SELECT COUNT(*) AS n FROM topic_messages')[0].n,
    wakes: committed('SELECT COUNT(*) AS n FROM wake_log')[0].n,
    cards: committed('SELECT id, topic_id, revision FROM todos ORDER BY id').map(r => `${r.id}|${r.topic_id}|${r.revision}`),
    watches: committed('SELECT topic_id, todo_id, active FROM todo_watches ORDER BY topic_id, todo_id').map(r => `${r.topic_id}|${r.todo_id}|${r.active}`),
  })
  const storedTopicOf = todo => committed('SELECT topic_id FROM todos WHERE id = ?', todo.id)[0].topic_id
  // Stored state from before #97, written straight into the tables: a card of `project` that sits in `topic`
  // (a topic of another project) and is watched by it.
  const dirtyCard = async (project, topic, title, phase = '') => {
    const { todo } = await orch.createTodo(run, { projectId: project.id, title })
    const made = todo.topicId
    sql('UPDATE todos SET topic_id = ? WHERE id = ?', topic.id, todo.id)
    sql('DELETE FROM todo_watches WHERE todo_id = ?', todo.id)
    if (phase) sql('UPDATE todos SET phase = ? WHERE id = ?', phase, todo.id)
    db.watchTodo(1, 'default', topic.id, todo.id, 'stored before #97')
    return { todo: db.getTodo(1, 'default', todo.id), madeTopicId: made }
  }
  // A card of gamma in `topic`, gamma itself left without any topic (the one made for the card is removed).
  const gammaCard = async (topic, title) => {
    const { todo, madeTopicId } = await dirtyCard(gamma, topic, title)
    if (db.getTopic(1, 'default', madeTopicId)) await orch.deleteTopic(run, madeTopicId)
    sql('UPDATE todos SET topic_id = ? WHERE id = ?', topic.id, todo.id)
    db.watchTodo(1, 'default', topic.id, todo.id, 'stored before #97')
    return db.getTodo(1, 'default', todo.id)
  }
  const topicsOf = project => db.listTopics(1, 'default', { includeArchived: true }).filter(t => t.projectId === project.id)
  const systemTexts = topicId => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'system').map(m => m.text)
  // Replaces one db method for the duration of fn: its `nth` call throws, the calls before it are the real
  // ones. `hits` counts how often the method was reached.
  const failing = async (method, fn, { nth = 1 } = {}) => {
    const real = db[method]
    const probe = { hits: 0 }
    db[method] = (...args) => {
      probe.hits += 1
      if (probe.hits === nth) throw new Error(`disk I/O error (injected in ${method})`)
      return real(...args)
    }
    try { probe.result = await fn() } catch (err) { probe.thrown = err?.message || String(err) } finally { db[method] = real }
    return probe
  }
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, emitted, alpha, beta, gamma, topicA, topicB, stored, storedTopicOf, dirtyCard, gammaCard, topicsOf, systemTexts, failing, cleanup }
}

// ── 1. repair-todo-topic ─────────────────────────────────────────────────────────────────────────────

test('#120 repair-todo-topic: when the card write fails, the topic that was to be created for it is not left behind', async () => {
  const ctx = await setup()
  try {
    const { orch, run, gamma, topicA, gammaCard, stored, topicsOf, failing } = ctx
    const todo = await gammaCard(topicA, '丙项目的串台卡')
    assert.equal(topicsOf(gamma).length, 0, 'fixture: the project has no topic, so one has to be created')
    const before = stored()
    // The first write after the topic.
    const probe = await failing('setTodoTopic', () => orch.repairTodoTopic(run, { todoId: todo.id }))
    assert.equal(probe.hits, 1, 'the injected failure was reached')
    assert.match(probe.thrown, /disk I\/O error \(injected in setTodoTopic\)/)
    assert.equal(stored().topics, before.topics, 'no empty topic stays')
    assert.equal(topicsOf(gamma).length, 0)
    assert.deepEqual(stored(), before, 'nothing was stored')
  } finally { ctx.cleanup() }
})

test('#120 repair-todo-topic: with a topic to move to, a failure of the last write (the message in the new topic) stores nothing; repeated, the card is moved and both topics are told once', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, emitted, beta, topicA, topicB, dirtyCard, stored, storedTopicOf, systemTexts, failing } = ctx
    const { todo } = await dirtyCard(beta, topicA, '乙项目的串台卡')
    const before = stored()
    emitted.length = 0
    // No topic is created here: only the transaction keeps the earlier writes from staying.
    const probe = await failing('addTopicMessage', () => orch.repairTodoTopic(run, { todoId: todo.id }), { nth: 2 })
    assert.equal(probe.hits, 2, 'the message of the old topic was written, the one of the new topic failed')
    assert.match(probe.thrown, /disk I\/O error \(injected in addTopicMessage\)/)
    assert.equal(storedTopicOf(todo), topicA.id, 'the card was not moved without the messages that say so')
    assert.deepEqual(stored(), before, 'card, watches, timeline and the message of the old topic are rolled back')
    assert.equal(emitted.some(r => String(r).startsWith('todo.topic.repaired')), false, 'no update is announced for a repair that was not stored')
    assert.deepEqual(db.getTodo(1, 'default', todo.id).topicProjectMismatch ?? null, null, 'getTodo never carries the derived field')
    assert.equal((await orch.getSnapshot(run)).todos.find(t => t.id === todo.id).topicProjectMismatch.repairable, true, 'the card is still flagged and can be repaired')

    const res = await orch.repairTodoTopic(run, { todoId: todo.id })
    assert.equal(res.repaired, true)
    assert.equal(res.fromTopicId, topicA.id)
    assert.equal(res.toTopicId, topicB.id)
    assert.equal(res.todo.topicId, topicB.id)
    assert.equal(storedTopicOf(todo), topicB.id)
    assert.deepEqual(systemTexts(topicA.id).filter(t => t.startsWith('归属修复：')), [
      `归属修复：#${todo.number} 乙项目的串台卡 属于项目 beta，已转到该项目的话题「乙项目话题」。本话题不再收到它的进展；历史消息保留。`,
    ])
    assert.deepEqual(systemTexts(topicB.id).filter(t => t.startsWith('归属修复：')), [
      `归属修复：#${todo.number} 乙项目的串台卡 从话题「甲项目话题」（属于项目 alpha）转入本话题。之后它的进展通知到这里。`,
    ])
    assert.equal(res.todo.timeline.filter(e => e.event === '归属修复：从话题「甲项目话题」（属于项目 alpha）转到项目 beta 的话题「乙项目话题」').length, 1)
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', todo.id).map(w => w.topicId), [topicB.id])
    assert.equal(emitted.filter(r => r === `todo.topic.repaired:${todo.id}`).length, 1)
    const after = stored()
    assert.equal(after.topics, before.topics)
    assert.equal(after.messages, before.messages + 2)
  } finally { ctx.cleanup() }
})

test('#120 repair-todo-topic: whichever write fails, nothing is stored and failed calls do not pile up topics; the next call creates one topic', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, gamma, topicA, gammaCard, stored, topicsOf, systemTexts, failing } = ctx
    const todo = await gammaCard(topicA, '丙项目的串台卡，标题超过三十二个字符时话题标题只取前三十二个字符为止')
    const before = stored()
    // clearWatch is not among them: since #117 a trigger ends the watches of other topics when todos.topic_id
    // is written, so the repair finds none left to end.
    for (const [method, nth] of [['setTodoTopic', 1], ['watchTodo', 1], ['appendTimeline', 1], ['addTopicMessage', 1], ['addTopicMessage', 2]]) {
      const probe = await failing(method, () => orch.repairTodoTopic(run, { todoId: todo.id }), { nth })
      assert.equal(probe.hits, nth, `${method} #${nth}: the injected failure was reached`)
      assert.match(probe.thrown, new RegExp(`injected in ${method}`))
      assert.deepEqual(stored(), before, `${method} #${nth}: nothing was stored`)
    }
    const res = await orch.repairTodoTopic(run, { todoId: todo.id })
    assert.equal(res.repaired, true)
    const topics = topicsOf(gamma)
    assert.equal(topics.length, 1, 'exactly one topic')
    const home = db.getTopic(1, 'default', topics[0].id)
    assert.equal(res.toTopicId, home.id)
    assert.equal(home.title, todo.title.slice(0, 32))
    assert.equal(home.autopilot, false)
    assert.equal(home.chiefSessionId, '')
    assert.deepEqual(systemTexts(home.id), [
      `归属修复：#${todo.number} ${todo.title} 从话题「甲项目话题」（属于项目 alpha）转入本话题。之后它的进展通知到这里；本话题没有总管会话，进展只记录不唤醒，在这里发一条消息即可让总管接手。`,
    ])
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', todo.id).map(w => w.topicId), [home.id])
    assert.equal(stored().topics, before.topics + 1)
    // Repeated: the card is where it belongs, nothing more is written.
    const settled = stored()
    assert.equal((await orch.repairTodoTopic(run, { todoId: todo.id })).repaired, false)
    assert.deepEqual(stored(), settled)
  } finally { ctx.cleanup() }
})

// ── 2. repair-topic-todos ────────────────────────────────────────────────────────────────────────────

// topicA (alpha) holds two cards of beta, one card of gamma (no topic) and a card of beta that is building.
async function batchFixture(ctx) {
  const { topicA, beta, dirtyCard, gammaCard } = ctx
  const x1 = (await dirtyCard(beta, topicA, '乙卡一')).todo
  const x2 = (await dirtyCard(beta, topicA, '乙卡二')).todo
  const g1 = await gammaCard(topicA, '丙卡')
  const busy = (await dirtyCard(beta, topicA, '构建中的乙卡', 'building')).todo
  return { x1, x2, g1, busy }
}

test('#120 repair-topic-todos: a failure at the second card does not leave the first one moved (no half-finished migration)', async () => {
  const ctx = await setup()
  try {
    const { orch, run, emitted, topicA, stored, storedTopicOf, failing } = ctx
    const { x1, x2, g1 } = await batchFixture(ctx)
    const before = stored()
    emitted.length = 0
    const probe = await failing('setTodoTopic', () => orch.repairTopicTodos(run, { topicId: topicA.id }), { nth: 2 })
    assert.equal(probe.hits, 2, 'the first card was written, the second failed')
    assert.match(probe.thrown, /disk I\/O error \(injected in setTodoTopic\)/)
    assert.deepEqual([x1, x2, g1].map(storedTopicOf), [topicA.id, topicA.id, topicA.id], 'no card was moved')
    assert.deepEqual(stored(), before, 'no card, watch, timeline line or message was stored')
    assert.equal(emitted.some(r => String(r).startsWith('topic.todos.repaired')), false)
  } finally { ctx.cleanup() }
})

test('#120 repair-topic-todos: a failure of the last message stores nothing, also not the topic created for a project; repeated, every card is moved and named in the messages', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, emitted, beta, gamma, topicA, topicB, stored, storedTopicOf, topicsOf, systemTexts, failing } = ctx
    const { x1, x2, g1, busy } = await batchFixture(ctx)
    assert.equal(topicsOf(gamma).length, 0, 'fixture: a topic has to be created for gamma')
    const before = stored()
    // Messages: the topic itself, topicB, the topic created for gamma. Failed calls are repeated to show that
    // they do not pile up topics.
    for (const nth of [1, 3, 3]) {
      const probe = await failing('addTopicMessage', () => orch.repairTopicTodos(run, { topicId: topicA.id }), { nth })
      assert.equal(probe.hits, nth, 'the injected failure was reached')
      assert.match(probe.thrown, /disk I\/O error \(injected in addTopicMessage\)/)
      assert.deepEqual(stored(), before, `message #${nth} failed: nothing was stored`)
      assert.equal(topicsOf(gamma).length, 0)
    }
    // dryRun still says the whole job is to be done.
    const dry = await orch.repairTopicTodos(run, { topicId: topicA.id, dryRun: true })
    assert.deepEqual(dry.moved.map(e => e.id), [x1.id, x2.id, g1.id])
    assert.deepEqual(stored(), before, 'dryRun stores nothing')

    emitted.length = 0
    const done = await orch.repairTopicTodos(run, { topicId: topicA.id })
    assert.equal(done.dryRun, false)
    assert.deepEqual(done.moved.map(e => e.id), [x1.id, x2.id, g1.id])
    assert.deepEqual(done.skipped.map(e => [e.id, e.reason]), [[busy.id, '任务正在执行（构建 / 审查 / 合并中），先等当前轮结束或停止后再修']])
    const homes = topicsOf(gamma)
    assert.equal(homes.length, 1, 'exactly one topic for gamma')
    const home = db.getTopic(1, 'default', homes[0].id)
    assert.equal(home.title, 'gamma')
    assert.equal(home.autopilot, false)
    assert.deepEqual(done.topics, [
      { id: topicB.id, title: '乙项目话题', projectId: beta.id, created: false, unattended: false, count: 2 },
      { id: home.id, title: 'gamma', projectId: gamma.id, created: true, unattended: true, count: 1 },
    ])
    assert.deepEqual([x1, x2, g1, busy].map(storedTopicOf), [topicB.id, topicB.id, home.id, topicA.id])
    // What a half-finished run used to lose: the cards moved before the failure were never named again.
    assert.deepEqual(systemTexts(topicA.id).filter(t => t.startsWith('归属修复：')), [
      `归属修复：本话题有 3 张不属于本话题项目的卡片已转到各自项目的话题：#${x1.number}、#${x2.number} → 项目 beta 的话题「乙项目话题」；#${g1.number} → 项目 gamma 的话题「gamma」。本话题不再收到它们的进展；历史消息保留。另有 1 张未迁移（#${busy.number}），原因见修复结果。`,
    ])
    assert.deepEqual(systemTexts(topicB.id).filter(t => t.startsWith('归属修复：')), [
      `归属修复：2 张卡片（#${x1.number}、#${x2.number}）从话题「甲项目话题」（属于项目 alpha）转入本话题。之后它们的进展通知到这里。`,
    ])
    assert.deepEqual(systemTexts(home.id), [
      `归属修复：1 张卡片（#${g1.number}）从话题「甲项目话题」（属于项目 alpha）转入本话题。之后它们的进展通知到这里；本话题没有总管会话，进展只记录不唤醒，在这里发一条消息即可让总管接手。`,
    ])
    assert.deepEqual(db.getActiveWatchesForTodo(1, 'default', x1.id).map(w => w.topicId), [topicB.id])
    assert.equal(emitted.filter(r => r === `topic.todos.repaired:${topicA.id}`).length, 1)
    const after = stored()
    assert.equal(after.topics, before.topics + 1)
    assert.equal(after.messages, before.messages + 3)
    // Repeated: nothing more.
    const again = await orch.repairTopicTodos(run, { topicId: topicA.id })
    assert.deepEqual(again.moved, [])
    assert.deepEqual(again.topics, [])
    assert.deepEqual(stored(), after)
  } finally { ctx.cleanup() }
})

// ── 3. the contract ──────────────────────────────────────────────────────────────────────────────────

test('#120 contract: repair-todo-topic and repair-topic-todos declare the transaction', () => {
  const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
  assert.match(contract.rpc['repair-todo-topic'].description, /one transaction \(#120/)
  assert.match(contract.rpc['repair-topic-todos'].description, /one transaction \(#120/)
  const docs = readFileSync(new URL('../docs/CONTRACTS.md', import.meta.url), 'utf8')
  assert.match(docs, /Since #120 \(0\.9\.76\) every write of one `repair-todo-topic` call/)
  assert.match(docs, /Since #120 \(0\.9\.76\) every write of one `repair-topic-todos` run/)
  assertReleaseMetadata()
})

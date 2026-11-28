// Todo #121: set_topic_project. The Chief binds (or rebinds) its own topic to a registered project itself, so
// the user no longer has to open the topic menu (改挂项目). #118 only covered "the first card of a topic whose
// project was never decided"; work on an existing card, a topic on the wrong project and a topic the user
// detached still needed the menu.
//   G1  MCP tool only: no RPC of that name; the page keeps update-topic.
//   G2  only the topic's own Chief: identity.sessionId is its Chief session, or, without a session id, exactly
//       one Chief session has set_topic_project open under its own name and no other session has. A tool_call
//       wrapper, a Chief that is merely running, several candidates, a session that is no Chief: refused.
//   G3  the project must exist.
//   G4  the topic-adopt row, topics.project_id and the system message are one transaction.
//   G5  a topic that has a project is moved only when every card stored in it is of the target project.
//   G6  the topic-adopt row is written, so #118 never binds the topic again.
// A refusal writes nothing at all.
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
import { registerAllRpcs } from '../src/server/rpc-handlers.mjs'
import { buildChiefInstructions } from '../src/server/prompts.mjs'

const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const MISMATCH = 'TOPIC_PROJECT_MISMATCH'
const SET_TOOL = 'mcp__ekko_todo__ekko_todo__set_utopic_uproject'
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

// Two projects, alpha and beta, each with a Chief topic (sess-alpha / sess-beta), and `fresh`: a Chief topic
// (sess-fresh) made without a project and without a topic-adopt row.
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t121-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  const infos = []
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn() {}, info(message, data) { infos.push({ message, data }) } } })
  const working = new Map()
  let seq = 0
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(body) { seq += 1; return { session: { id: `s-${seq}`, title: body?.title } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async get(sid) { return { session: { id: sid, ended_at: null }, is_running: Boolean(working.get(sid)) } },
      async connect(sid, cb) {
        setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(working.get(sid)), runStartedAt: Date.now() }), 2)
        return { close() {} }
      },
      async run(sid) { working.set(sid, true); return { run_id: `r-${sid}` } },
      async stop(sid) { working.set(sid, false) },
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
  const beta = await addRepo('beta')
  const chiefTopic = async (sessionId, input = {}) => {
    const { topic } = await orch.createTopic(run, input)
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  const topicA = await chiefTopic('sess-alpha', { projectId: alpha.id, title: '甲项目话题' })
  const topicB = await chiefTopic('sess-beta', { projectId: beta.id, title: '乙项目话题' })
  const fresh = await chiefTopic('sess-fresh', { title: '新话题' })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const call = async (name, input, from = run) => {
    try { return await tools.get(name).execute(input, from) } catch (err) { return { ok: false, thrown: err?.message || String(err) } }
  }
  const sqlitePath = join(dataDir, 'ekko-todo.sqlite')
  const sql = (text, ...params) => {
    const raw = new DatabaseSync(sqlitePath)
    try { return raw.prepare(text).run(...params) } finally { raw.close() }
  }
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
  const hostEvent = (type, sessionId, data = {}) => orch.handleHostEvent({ type, data: { session_id: sessionId, ...data } }, run)
  const systemTexts = topicId => topicOf(topicId).messages.filter(m => m.kind === 'system').map(m => m.text)
  const gamma = await addRepo('gamma')
  // A card of `project` stored in `topic` (todos.topic_id), whatever the topic's project is now: made while
  // the topic is of that project, the way such a card comes to be on a real board.
  const cardIn = async (topic, project, title) => {
    const was = topicOf(topic.id).projectId
    if (was !== project.id) db.updateTopic(1, 'default', topic.id, { projectId: project.id })
    const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title })
    if (was !== project.id) db.updateTopic(1, 'default', topic.id, { projectId: was })
    return db.getTodo(1, 'default', todo.id)
  }
  const emitted = []
  run.messages.emit = (...args) => { emitted.push(args) }
  // Everything a refusal must leave alone: row counts, the topic row and the cards.
  const frozen = topicId => JSON.stringify({ counts: counts(), topic: (({ id, projectId, archived, messages, watchedTodoIds }) => ({ id, projectId, archived, messages: messages.length, watchedTodoIds }))(topicOf(topicId)), cards: db.listTodos(1, 'default').map(t => [t.id, t.projectId, t.topicId, t.phase]), key: adoptRows(topicId), emitted: emitted.length })
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, alpha, beta, gamma, topicA, topicB, fresh, tools, call, sql, scalar, counts, adoptRows, topicOf, hostEvent, systemTexts, cardIn, frozen, emitted, chiefTopic, addRepo, infos, cleanup }
}

const set = (ctx, topic, project, from, extra = {}) => ctx.call('set_topic_project', { topic_id: topic.id, project_id: typeof project === 'string' ? project : project.id, ...extra }, from)

// ── allowed ──────────────────────────────────────────────────────────────────────────────────────────

test('#121 allow: a topic without a project (no topic-adopt row) is bound by its own Chief session; one row, one message, nothing else', async () => {
  const ctx = await setup()
  try {
    const { runFrom, alpha, fresh, counts, adoptRows, topicOf, systemTexts, infos, emitted } = ctx
    assert.equal(adoptRows(fresh.id), 0, 'fixture: project never decided')
    const before = counts()
    const res = await set(ctx, fresh, alpha, runFrom('sess-fresh'), { reason: '用户要处理 alpha 的已有卡' })
    assert.equal(res.ok, true, res.thrown || res.content)
    assert.deepEqual(res.data, { topicId: fresh.id, projectId: alpha.id, previousProjectId: '', changed: true })
    assert.equal(topicOf(fresh.id).projectId, alpha.id)
    assert.equal(adoptRows(fresh.id), 1, 'G6: the topic-adopt row is written')
    assert.deepEqual(counts(), { ...before, messages: before.messages + 1, wakes: before.wakes + 1 })
    assert.deepEqual(systemTexts(fresh.id), ['话题已绑定到项目 alpha（由总管调用 set_topic_project 绑定；原因：用户要处理 alpha 的已有卡）。之后本话题只处理该项目的卡片；如挂错，可让总管再次改绑，或在话题菜单「改挂项目」更换。'])
    // This turn's instructions still say "no project": the answer names the project, its id and repository.
    assert.match(res.content, /已把话题「新话题」绑定到项目 alpha（/)
    assert.ok(res.content.includes(alpha.id) && res.content.includes(alpha.repoPath))
    assert.equal(ctx.orch.topicBindsOnFirstCard(topicOf(fresh.id)), false)
    assert.ok(infos.some(i => i.message === 'Topic project set by its Chief' && i.data.topicId === fresh.id && i.data.projectId === alpha.id && i.data.previousProjectId === ''))
    assert.ok(emitted.length >= 1, 'the page is told')
    // What it is for: the topic can list the project's cards in the same turn.
    const listed = await ctx.call('list_todos', {}, runFrom('sess-fresh'))
    assert.equal(listed.ok, true, listed.content)
  } finally { ctx.cleanup() }
})

test('#121 allow: without a session id, the one Chief session that has set_topic_project open under its own name is the caller', async () => {
  const ctx = await setup()
  try {
    const { run, beta, fresh, hostEvent, topicOf, adoptRows } = ctx
    await hostEvent('chat.tool.started', 'sess-fresh', { name: SET_TOOL })
    const caller = ctx.orch.resolveChiefCaller(run, 'set_topic_project')
    assert.deepEqual({ by: caller.by, tier: caller.tier, ids: caller.topics.map(t => t.id) }, { by: 'caller-tool', tier: 'by-name', ids: [fresh.id] })
    const res = await set(ctx, fresh, beta)
    assert.equal(res.ok, true, res.thrown || res.content)
    assert.equal(topicOf(fresh.id).projectId, beta.id)
    assert.equal(adoptRows(fresh.id), 1)
  } finally { ctx.cleanup() }
})

test('#121 allow: a topic the user detached (topic-adopt row present) is bound; the row is not written twice', async () => {
  const ctx = await setup()
  try {
    const { orch, run, runFrom, alpha, counts, adoptRows, topicOf, chiefTopic } = ctx
    const detached = await chiefTopic('sess-detached', { projectId: alpha.id, title: '摘除过的话题' })
    await orch.updateTopicMeta(run, { topicId: detached.id, projectId: '' })
    assert.equal(adoptRows(detached.id), 1)
    assert.equal(orch.topicBindsOnFirstCard(topicOf(detached.id)), false, '#118 never binds it')
    const before = counts()
    const res = await set(ctx, detached, alpha, runFrom('sess-detached'))
    assert.equal(res.ok, true, res.thrown || res.content)
    assert.equal(topicOf(detached.id).projectId, alpha.id)
    assert.equal(adoptRows(detached.id), 1)
    assert.deepEqual(counts(), { ...before, messages: before.messages + 1 }, 'one message; no second row')
  } finally { ctx.cleanup() }
})

test('#121 allow: a topic of project X that holds no card is moved to Y', async () => {
  const ctx = await setup()
  try {
    const { runFrom, alpha, beta, topicA, topicOf, adoptRows, systemTexts } = ctx
    const res = await set(ctx, topicA, beta, runFrom('sess-alpha'))
    assert.equal(res.ok, true, res.thrown || res.content)
    assert.deepEqual(res.data, { topicId: topicA.id, projectId: beta.id, previousProjectId: alpha.id, changed: true })
    assert.equal(topicOf(topicA.id).projectId, beta.id)
    assert.equal(adoptRows(topicA.id), 1)
    assert.deepEqual(systemTexts(topicA.id), ['话题已从项目 alpha 改绑到项目 beta（由总管调用 set_topic_project 改绑）。之后本话题只处理该项目的卡片；如挂错，可让总管再次改绑，或在话题菜单「改挂项目」更换。'])
    assert.match(res.content, /已把话题「甲项目话题」从项目 alpha 改绑到项目 beta（/)
  } finally { ctx.cleanup() }
})

test('#121 allow: a topic of project X whose cards are all of Y is moved to Y; the cards are then managed by it, none is orphaned', async () => {
  const ctx = await setup()
  try {
    const { db, orch, runFrom, alpha, beta, topicA, topicOf, cardIn } = ctx
    const one = await cardIn(topicA, beta, '乙的卡一')
    const two = await cardIn(topicA, beta, '乙的卡二')
    assert.equal(topicOf(topicA.id).projectId, alpha.id, 'fixture: the topic is of alpha, its cards of beta')
    assert.equal(orch.topicManagesTodo(topicOf(topicA.id), one), false)
    const res = await set(ctx, topicA, beta, runFrom('sess-alpha'))
    assert.equal(res.ok, true, res.thrown || res.content)
    const now = topicOf(topicA.id)
    assert.equal(now.projectId, beta.id)
    for (const card of [one, two]) {
      const stored = db.getTodo(1, 'default', card.id)
      assert.equal(stored.topicId, topicA.id, 'the card did not move')
      assert.equal(orch.topicManagesTodo(now, stored), true, 'topic and card agree (#117)')
    }
    const snap = await orch.getSnapshot(ctx.run)
    assert.equal(snap.topics.find(t => t.id === topicA.id).topicScopeReason ?? null, null, 'no scope warning is left')
  } finally { ctx.cleanup() }
})

test('#121 same project: answers "already", writes no row and no message', async () => {
  const ctx = await setup()
  try {
    const { runFrom, alpha, topicA, frozen } = ctx
    const before = frozen(topicA.id)
    const res = await set(ctx, topicA, alpha, runFrom('sess-alpha'), { reason: '再说一遍' })
    assert.equal(res.ok, true, res.thrown || res.content)
    assert.deepEqual(res.data, { topicId: topicA.id, projectId: alpha.id, previousProjectId: alpha.id, changed: false })
    assert.match(res.content, /已经是项目 alpha/)
    assert.equal(frozen(topicA.id), before, 'nothing written, nothing emitted')
  } finally { ctx.cleanup() }
})

// ── refused: every refusal leaves the store as it was ───────────────────────────────────────────────

test('#121 G5: a topic of X that holds a card of X is not moved to Y; the answer says which cards and what to do', async () => {
  const ctx = await setup()
  try {
    const { runFrom, alpha, beta, topicA, cardIn, frozen } = ctx
    const own = await cardIn(topicA, alpha, '甲的卡')
    await cardIn(topicA, beta, '乙的卡')
    const before = frozen(topicA.id)
    const res = await set(ctx, topicA, beta, runFrom('sess-alpha'))
    assert.equal(res.ok, false)
    assert.equal(res.error, 'TOPIC_HAS_OTHER_CARDS')
    assert.equal(frozen(topicA.id), before)
    assert.match(res.content, /未做任何改动/)
    assert.ok(res.content.includes(`#${own.number}`), 'names the card in the way')
    assert.match(res.content, /修复话题归属/)
    // Control: the same topic and target without the card of X is the allowed row of the matrix (see above).
  } finally { ctx.cleanup() }
})

test('#121 G5: a card of a third project in a topic of X refuses the move to Y as well', async () => {
  const ctx = await setup()
  try {
    const { runFrom, beta, gamma, topicA, cardIn, frozen } = ctx
    await cardIn(topicA, beta, '乙的卡')
    const third = await cardIn(topicA, gamma, '丙的卡')
    const before = frozen(topicA.id)
    const res = await set(ctx, topicA, beta, runFrom('sess-alpha'))
    assert.equal(res.error, 'TOPIC_HAS_OTHER_CARDS')
    assert.equal(frozen(topicA.id), before)
    assert.ok(res.content.includes(`#${third.number}`))
    assert.match(res.content, /修复话题归属/)
  } finally { ctx.cleanup() }
})

test('#121 archived: an archived topic is refused, with or without a project', async () => {
  const ctx = await setup()
  try {
    const { db, runFrom, alpha, beta, fresh, topicA, frozen } = ctx
    for (const [topic, session, target] of [[fresh, 'sess-fresh', alpha], [topicA, 'sess-alpha', beta]]) {
      db.updateTopic(1, 'default', topic.id, { archived: true })
      const before = frozen(topic.id)
      const res = await set(ctx, topic, target, runFrom(session))
      assert.equal(res.ok, false)
      assert.equal(res.error, 'TOPIC_ARCHIVED')
      assert.equal(frozen(topic.id), before)
      assert.match(res.content, /已归档/)
      // Control: restored, the same call is allowed.
      db.updateTopic(1, 'default', topic.id, { archived: false })
      assert.equal((await set(ctx, topic, target, runFrom(session))).ok, true)
    }
  } finally { ctx.cleanup() }
})

test('#121 G2: a Chief cannot set the project of another topic; a session that is no Chief and a caller without identity cannot either', async () => {
  const ctx = await setup()
  try {
    const { run, runFrom, alpha, beta, fresh, topicB, frozen } = ctx
    const before = frozen(fresh.id)
    const beforeB = frozen(topicB.id)
    const other = await set(ctx, fresh, alpha, runFrom('sess-alpha'))
    assert.equal(other.ok, false)
    assert.equal(other.error, 'NOT_TOPIC_CHIEF')
    assert.match(other.content, /只能改自己所在话题/)
    const onto = await set(ctx, topicB, alpha, runFrom('sess-alpha'))
    assert.equal(onto.error, 'NOT_TOPIC_CHIEF', 'nor that of a topic that has a project')
    const worker = await set(ctx, fresh, alpha, runFrom('sess-worker'))
    assert.equal(worker.error, 'NOT_TOPIC_CHIEF', 'a build / review / plain chat session')
    const nobody = await set(ctx, fresh, alpha, run)
    assert.equal(nobody.ok, false)
    assert.equal(nobody.error, 'CALLER_AMBIGUOUS', 'no session id and no Chief seen calling')
    const missing = await ctx.call('set_topic_project', { topic_id: 'topic-nope', project_id: beta.id }, runFrom('sess-fresh'))
    assert.equal(missing.error, 'NOT_TOPIC_CHIEF', 'a topic id that does not exist is not the caller\'s topic')
    assert.equal(frozen(fresh.id), before)
    assert.equal(frozen(topicB.id), beforeB)
    // Control: the topic's own Chief, same arguments.
    assert.equal((await set(ctx, fresh, alpha, runFrom('sess-fresh'))).ok, true)
  } finally { ctx.cleanup() }
})

test('#121 G3: a project that does not exist, and an empty project_id, are refused', async () => {
  const ctx = await setup()
  try {
    const { runFrom, fresh, topicA, alpha, frozen } = ctx
    const before = frozen(fresh.id)
    const beforeA = frozen(topicA.id)
    const res = await set(ctx, fresh, 'proj-nope', runFrom('sess-fresh'))
    assert.equal(res.ok, false)
    assert.equal(res.error, 'PROJECT_NOT_FOUND')
    assert.ok(res.content.includes('proj-nope') && res.content.includes(alpha.id), 'names the id and lists the registered ones')
    const moved = await set(ctx, topicA, 'proj-nope', runFrom('sess-alpha'))
    assert.equal(moved.error, 'PROJECT_NOT_FOUND')
    const empty = await set(ctx, topicA, '', runFrom('sess-alpha'))
    assert.equal(empty.error, 'PROJECT_NOT_FOUND', 'the tool binds; it never detaches a topic')
    assert.equal(frozen(fresh.id), before)
    assert.equal(frozen(topicA.id), beforeA)
    assert.equal(ctx.orch.topicBindsOnFirstCard(ctx.topicOf(fresh.id)), true, 'the refused call did not use up #118')
  } finally { ctx.cleanup() }
})

test('#121 G2: a tool_call wrapper and a Chief that is merely running are guesses: refused', async () => {
  const ctx = await setup()
  try {
    const { orch, run, alpha, fresh, hostEvent, frozen } = ctx
    await hostEvent('chat.run.started', 'sess-fresh')
    const before = frozen(fresh.id)
    const running = orch.resolveChiefCaller(run, 'set_topic_project')
    assert.deepEqual({ tier: running.tier, ids: running.topics.map(t => t.id), ambiguous: running.ambiguous }, { tier: 'active-run', ids: [fresh.id], ambiguous: false }, 'one candidate, not ambiguous: only the tier refuses')
    const guessed = await set(ctx, fresh, alpha)
    assert.equal(guessed.ok, false)
    assert.equal(guessed.error, 'CALLER_AMBIGUOUS')
    assert.equal(frozen(fresh.id), before)
    await hostEvent('chat.tool.started', 'sess-fresh', { name: 'tool_call' })
    const wrapped = orch.resolveChiefCaller(run, 'set_topic_project')
    assert.deepEqual({ tier: wrapped.tier, ids: wrapped.topics.map(t => t.id), ambiguous: wrapped.ambiguous }, { tier: 'wrapper', ids: [fresh.id], ambiguous: false })
    const beforeWrapped = frozen(fresh.id) // the host event above is itself reported to the page
    const res = await set(ctx, fresh, alpha)
    assert.equal(res.ok, false)
    assert.equal(res.error, 'CALLER_AMBIGUOUS')
    assert.match(res.content, /按工具名直接调用 set_topic_project（不要经 tool_call 包装）/)
    assert.equal(frozen(fresh.id), beforeWrapped)
  } finally { ctx.cleanup() }
})

test('#121 G2: two Chief sessions, or a Chief and a session that is no Chief, with the tool open by name: refused; alone it is allowed', async () => {
  const ctx = await setup()
  try {
    const { orch, run, alpha, fresh, hostEvent, frozen, chiefTopic } = ctx
    const second = await chiefTopic('sess-fresh-2', { title: '另一个新话题' })
    await hostEvent('chat.tool.started', 'sess-fresh', { name: SET_TOOL })
    await hostEvent('chat.tool.started', 'sess-fresh-2', { name: SET_TOOL })
    const before = frozen(fresh.id)
    const beforeSecond = frozen(second.id)
    assert.equal(orch.resolveChiefCaller(run, 'set_topic_project').topics.length, 2)
    const two = await set(ctx, fresh, alpha)
    assert.equal(two.error, 'CALLER_AMBIGUOUS')
    await hostEvent('chat.tool.completed', 'sess-fresh-2', { name: SET_TOOL })
    await hostEvent('chat.tool.started', 'sess-worker', { name: SET_TOOL })
    const mixed = orch.resolveChiefCaller(run, 'set_topic_project')
    assert.deepEqual({ tier: mixed.tier, ids: mixed.topics.map(t => t.id), ambiguous: mixed.ambiguous }, { tier: 'by-name', ids: [fresh.id], ambiguous: true })
    const again = await set(ctx, fresh, alpha)
    assert.equal(again.error, 'CALLER_AMBIGUOUS')
    assert.equal(frozen(fresh.id), before)
    assert.equal(frozen(second.id), beforeSecond)
    await hostEvent('chat.tool.completed', 'sess-worker', { name: SET_TOOL })
    assert.equal((await set(ctx, fresh, alpha)).ok, true, 'control')
  } finally { ctx.cleanup() }
})

test('#121 refusals of the other tools: a Chief of a topic without a project is told to call set_topic_project, with the ids', async () => {
  const ctx = await setup()
  try {
    const { runFrom, alpha, fresh, topicA, cardIn, frozen } = ctx
    const card = await cardIn(topicA, alpha, '甲的已有卡')
    const before = frozen(fresh.id)
    const listed = await ctx.call('list_todos', {}, runFrom('sess-fresh'))
    assert.equal(listed.error, MISMATCH)
    assert.match(listed.content, /请调用 set_topic_project 把本话题绑定到一个项目/)
    assert.doesNotMatch(listed.content, /请让用户在话题菜单/)
    const acted = await ctx.call('run_build', { todo_id: card.id }, runFrom('sess-fresh'))
    assert.equal(acted.error, MISMATCH)
    assert.ok(acted.content.includes(`也可以直接调用 set_topic_project（topic_id ${fresh.id}，project_id ${alpha.id}）把本话题绑定到项目 alpha`))
    assert.doesNotMatch(acted.content, /也可以让用户在话题菜单/)
    assert.equal(frozen(fresh.id), before)
  } finally { ctx.cleanup() }
})

// ── G4 / G6 / G1 ─────────────────────────────────────────────────────────────────────────────────────

test('#121 G4: when the last write fails nothing is stored (no row, no project, no message, no event), and the next call binds', async () => {
  const ctx = await setup()
  try {
    const { db, runFrom, alpha, fresh, frozen, adoptRows, topicOf } = ctx
    const before = frozen(fresh.id)
    const real = db.addTopicMessage
    let failed = 0
    db.addTopicMessage = () => { failed += 1; throw new Error('disk I/O error (injected)') }
    const res = await set(ctx, fresh, alpha, runFrom('sess-fresh'))
    db.addTopicMessage = real
    assert.equal(failed, 1, 'the injected failure was reached')
    assert.match(res.thrown, /disk I\/O error \(injected\)/)
    assert.equal(frozen(fresh.id), before)
    assert.equal(adoptRows(fresh.id), 0, 'the row alone would say "decided" about a topic that was not changed')
    assert.equal(ctx.orch.topicBindsOnFirstCard(topicOf(fresh.id)), true, '#118 still works for it')
    const retry = await set(ctx, fresh, alpha, runFrom('sess-fresh'))
    assert.equal(retry.ok, true, retry.thrown || retry.content)
    assert.equal(topicOf(fresh.id).projectId, alpha.id)
    assert.equal(adoptRows(fresh.id), 1)
  } finally { ctx.cleanup() }
})

test('#121 G6: after the tool decided the project, a first card never binds the topic elsewhere', async () => {
  const ctx = await setup()
  try {
    const { orch, run, runFrom, alpha, beta, fresh, topicOf, adoptRows } = ctx
    assert.equal((await set(ctx, fresh, alpha, runFrom('sess-fresh'))).ok, true)
    // The page path that makes the row matter: the user detaches the topic afterwards.
    ctx.sql('UPDATE topics SET project_id = ? WHERE id = ?', '', fresh.id)
    assert.equal(adoptRows(fresh.id), 1)
    assert.equal(orch.topicBindsOnFirstCard(topicOf(fresh.id)), false)
    const card = await ctx.call('create_todo', { project_id: beta.id, title: '之后的第一张卡' }, runFrom('sess-fresh'))
    assert.equal(card.ok, true, card.thrown)
    assert.equal('topicBoundProjectId' in card.data, false)
    assert.equal(topicOf(fresh.id).projectId, '')
    void run
  } finally { ctx.cleanup() }
})

test('#121 G1: there is no RPC for it; the page keeps update-topic, which is not restricted by the tool\'s rules', async () => {
  const ctx = await setup()
  try {
    const { orch, run, alpha, beta, topicA, topicOf, cardIn } = ctx
    const handlers = new Map()
    registerAllRpcs({ extensions: { rpc: { register(name, handler) { handlers.set(name, handler); return () => {} } } } }, contract, orch)
    for (const name of [...handlers.keys(), ...Object.keys(contract.rpc)]) assert.doesNotMatch(name, /set[-_]topic[-_]project/)
    assert.equal(typeof ctx.tools.get('set_topic_project')?.execute, 'function')
    // The user's own menu still moves a topic that holds cards of its project (the tool refuses that).
    await cardIn(topicA, alpha, '甲的卡')
    await handlers.get('update-topic')({ topicId: topicA.id, projectId: beta.id }, run)
    assert.equal(topicOf(topicA.id).projectId, beta.id)
  } finally { ctx.cleanup() }
})

// ── instructions, contract, version ──────────────────────────────────────────────────────────────────

test('#121 instructions: every branch names set_topic_project and none sends the user to the topic menu', async () => {
  const ctx = await setup()
  try {
    const { orch, run, fresh, topicA, alpha, chiefTopic } = ctx
    const detached = await chiefTopic('sess-detached', { title: '摘除过的话题' })
    await orch.updateTopicMeta(run, { topicId: detached.id, projectId: '' })
    const prompt = topic => buildChiefInstructions({ topic, firstCardBinds: orch.topicBindsOnFirstCard(topic), projects: [alpha], agents: [], activeTodos: [], chiefAgent: {}, settings: {}, memories: [] })
    const scope = text => text.split('\n').find(line => line.startsWith('PROJECT SCOPE:'))
    const open = scope(prompt(ctx.topicOf(fresh.id)))
    const closed = scope(prompt(ctx.topicOf(detached.id)))
    const owned = scope(prompt(ctx.topicOf(topicA.id)))
    for (const [name, text, topic] of [['undecided', open, fresh], ['detached', closed, detached], ['owned', owned, topicA]]) {
      assert.match(text, /set_topic_project/, name)
      assert.ok(text.includes(`topic_id ${topic.id}`), `${name}: names its own topic id`)
      assert.doesNotMatch(text, /ask the user to give (this topic|it) a project/i, name)
      assert.doesNotMatch(text, /改挂项目/, name)
    }
    assert.match(open, /bind this topic yourself/)
    assert.match(open, /work on an existing card.*set_topic_project first/)
    assert.match(open, /ask the user only when (it is unclear|you cannot tell) which project is meant/)
    assert.match(open, /The first card you create here fixes it/, '#118 stays')
    assert.match(closed, /call set_topic_project/)
    assert.doesNotMatch(closed, /The first card you create here fixes it/, 'a detached topic is not bound by a card')
    assert.match(owned, /actually belongs to another project, call set_topic_project/)
    assert.match(owned, /refused/)
    const whole = prompt(ctx.topicOf(topicA.id))
    assert.match(whole, /`ekko-todo` server — 34 tools/)
    assert.match(whole, /`rename_topic`[^\n]*`set_topic_project`[^\n]*`update_topic_brief`|`rename_topic`[^\n]*`update_topic_brief`[^\n]*`set_topic_project`/, 'listed with the topic governance tools')
  } finally { ctx.cleanup() }
})

test('#121 contract: the tool, its schema, the documents, the server bundle and the version', async () => {
  const ctx = await setup()
  try {
    const tool = ctx.tools.get('set_topic_project')
    assert.ok(tool, 'registered')
    assert.equal(tool.readOnly, false)
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['project_id', 'reason', 'topic_id'], 'no caller_topic_id: the caller is never taken from its own word')
    assert.deepEqual(tool.inputSchema.required, ['topic_id', 'project_id'])
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(ctx.tools.size, Object.keys(contract.tools).length)
  } finally { ctx.cleanup() }
  // 33 with set_topic_project (#121); #125 (0.9.81) added get_todo_detail.
  assert.equal(Object.keys(contract.tools).length, 34)
  const declared = contract.tools.set_topic_project
  assert.ok(declared, 'declared in contracts/plugin.json')
  for (const word of ['#121', 'CALLER_AMBIGUOUS', 'NOT_TOPIC_CHIEF', 'PROJECT_NOT_FOUND', 'TOPIC_ARCHIVED', 'TOPIC_HAS_OTHER_CARDS', 'topic-adopt', 'previousProjectId', 'changed']) assert.ok(declared.description.includes(word), `contract description has ${word}`)
  const contracts = read('docs/CONTRACTS.md')
  assert.match(contracts, /`set_topic_project` \(#121/)
  for (const word of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'TOPIC_HAS_OTHER_CARDS', 'NOT_TOPIC_CHIEF']) assert.ok(contracts.includes(word), `CONTRACTS.md has ${word}`)
  assert.match(read('docs/FIELD_REFERENCE.md'), /set_topic_project/)
  const bundle = read('dist/server.mjs')
  for (const literal of ['set_topic_project', 'setTopicProject', 'TOPIC_HAS_OTHER_CARDS', 'NOT_TOPIC_CHIEF']) assert.ok(bundle.includes(literal), `server bundle has ${literal}`)
  const { classifyChiefTool } = await import('../src/shared/chief-guard.mjs')
  assert.equal(classifyChiefTool(SET_TOOL), classifyChiefTool('mcp__ekko_todo__ekko_todo__rename_utopic'), 'the Chief guard counts it as a board tool')
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  assert.ok(major > 0 || minor > 9 || (minor === 9 && patch >= 77), `version ${pkg.version} is 0.9.77 or later`)
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(contract.description.includes(`v${pkg.version} `))
  assert.match(read('CHANGELOG.md'), /## \[0\.9\.77\][\s\S]*?#121/)
})

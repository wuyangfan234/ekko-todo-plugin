// Todo #125: get_todo_detail. A Chief could take a card of another topic over (#117 / #123) but could not
// read what had happened to it: no tool returned the spec, the timeline or what the previous topic had been
// told about the card. The tool only reads, and it is bounded:
//   G1 project scope   every Chief topic of the card's project may read; another project is refused
//   G2 message filter  only topic messages whose todo_id is this card
//   G3 caps            at most 50 timeline events and 40 topic messages, with the real totals
//   G4 spec cut        a spec longer than 20,000 characters is cut and reported as cut
// Each guard is exercised through the registered tool (the wrapper of registerMcpTools included).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools, TODO_DETAIL_LIMITS } from '../src/server/mcp-tools.mjs'
import { buildChiefInstructions } from '../src/server/prompts.mjs'
import { assertReleaseMetadata } from './helpers/release-metadata.mjs'

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const contract = JSON.parse(read('contracts/plugin.json'))

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

// Project alpha with two Chief topics, A (sess-a, manages the cards) and B (sess-b); project beta with
// topic C (sess-c).
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t125-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn() {}, info() {} } })
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create() { throw new Error('get_todo_detail must not create a session') },
      async run() { throw new Error('get_todo_detail must not start a run') },
      async get(sid) { return { session: { id: sid, ended_at: null }, is_running: false } },
      async connect() { return { close() {} } },
      async stop() {},
      async messages() { return { messages: [] } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const runFrom = sessionId => ({ ...run, identity: { ...run.identity, sessionId } })
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const project = async name => {
    const dir = join(root, name)
    initRepo(dir)
    return (await orch.addProject(run, { name, repoPath: dir })).project
  }
  const alpha = await project('alpha')
  const beta = await project('beta')
  const chiefTopic = async (proj, sessionId, title) => {
    const { topic } = await orch.createTopic(run, { projectId: proj.id, title })
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId, autopilot: true })
    return db.getTopic(1, 'default', topic.id)
  }
  const topicA = await chiefTopic(alpha, 'sess-a', '话题甲')
  const topicB = await chiefTopic(alpha, 'sess-b', '话题乙')
  const topicC = await chiefTopic(beta, 'sess-c', '话题丙')
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
  // Every row of every table, to prove that a call wrote nothing.
  const fingerprint = () => {
    const raw = new DatabaseSync(sqlitePath, { readOnly: true })
    try {
      const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name)
      return JSON.stringify(names.map(name => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]))
    } finally { raw.close() }
  }
  const mk = async (topic, title, extra = {}) => (await orch.createTodo(run, { projectId: topic.projectId, topicId: topic.id, title, ...extra })).todo
  const say = (topic, kind, text, todoId = '', createdAt = undefined) => db.addTopicMessage(1, 'default', topic.id, { kind, text, todoId, ...(createdAt ? { createdAt } : {}) })
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, alpha, beta, topicA, topicB, topicC, tools, call, sql, fingerprint, mk, say, cleanup }
}

// A card of topic A with a spec, three topic messages about it and one that is not about it.
async function seeded(ctx) {
  const { mk, say, topicA, db } = ctx
  const card = await mk(topicA, '回测延迟修复', { spec: '把回测延迟降到 200ms 以内。\n验收：p95 < 200ms。', kind: 'bug' })
  db.appendTimeline(1, 'default', card.id, '派工给 Hermes', 'chief')
  say(topicA, 'human', '把这个延迟降到 200ms 以内', card.id, 1000)
  say(topicA, 'chief', '已建卡并派工', card.id, 2000)
  say(topicA, 'system', '关注的任务有进展：#1 进入构建', card.id, 3000)
  say(topicA, 'human', '顺便问一下今天天气怎么样（与本卡无关）', '', 4000)
  return db.getTodo(1, 'default', card.id)
}

// ── allowed ──────────────────────────────────────────────────────────────────────────────────────────

test('#125 managing topic: the answer carries the card, its spec, its managing topic, its timeline and the topic messages about it', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, topicA, alpha, fingerprint } = ctx
    const card = await seeded(ctx)
    const before = fingerprint()
    const res = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-a'))
    assert.equal(res.ok, true, res.content || res.thrown)
    assert.equal(fingerprint(), before, 'read only: no row of any table changed')
    const d = res.data
    assert.deepEqual(
      { id: d.id, number: d.number, title: d.title, kind: d.kind, phase: d.phase, gateOwner: d.gateOwner, gateKind: d.gateKind, projectId: d.projectId, projectName: d.projectName, agentId: d.agentId, reviewerId: d.reviewerId, tags: d.tags, withPlan: d.withPlan, createdAt: d.createdAt, updatedAt: d.updatedAt },
      { id: card.id, number: card.number, title: '回测延迟修复', kind: 'bug', phase: card.phase, gateOwner: card.gateOwner, gateKind: card.gateKind, projectId: alpha.id, projectName: 'alpha', agentId: card.agentId, reviewerId: card.reviewerId, tags: card.tags, withPlan: false, createdAt: card.createdAt, updatedAt: card.updatedAt },
    )
    assert.equal(d.spec, card.spec)
    assert.equal(d.specLength, card.spec.length)
    assert.equal(d.specTruncated, false)
    assert.deepEqual(d.managingTopic, { id: topicA.id, title: '话题甲', archived: false })
    assert.deepEqual(d.timeline.map(e => e.event), card.timeline.map(e => e.event), 'oldest first, newest last')
    assert.equal(d.timeline.at(-1).event, '派工给 Hermes')
    assert.equal(d.timelineTotal, card.timeline.length)
    assert.equal(d.timelineTruncated, false)
    assert.deepEqual(d.topicMessages.map(m => [m.kind, m.text]), [['human', '把这个延迟降到 200ms 以内'], ['chief', '已建卡并派工'], ['system', '关注的任务有进展：#1 进入构建']], 'ascending by time, every kind')
    assert.ok(d.topicMessages.every(m => m.topicId === topicA.id && m.topicTitle === '话题甲'))
    assert.equal(d.topicMessagesTotal, 3)
    assert.equal(d.topicMessagesTruncated, false)
    assert.equal('question' in d, false, 'no open question: left out')
    assert.equal('lastError' in d, false, 'no error: left out')
    // content is what the Chief reads: the four things are all in it, as text.
    assert.ok(res.content.startsWith(`#${card.number} 回测延迟修复（${card.id}）[${card.phase} | wait=${card.gateOwner}/${card.gateKind} | alpha]`), res.content)
    assert.ok(res.content.includes(`管理话题：话题「话题甲」（${topicA.id}）`), res.content)
    assert.ok(res.content.includes('把回测延迟降到 200ms 以内。\n验收：p95 < 200ms。'), 'the whole spec')
    assert.match(res.content, /时间线（\d+ 条）：/)
    assert.ok(res.content.includes('派工给 Hermes'))
    assert.ok(res.content.includes('话题里针对本卡的对话（3 条）：'), res.content)
    assert.ok(res.content.includes('[human] 把这个延迟降到 200ms 以内'))
    assert.ok(res.content.includes('[chief] 已建卡并派工'))
    assert.doesNotMatch(res.content, /^\s*[{[]/, 'not a JSON dump')
  } finally { ctx.cleanup() }
})

test('#125 G1 another topic of the same project reads the same detail (the reason for the tool), before and after taking the card over', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, topicA, topicB, fingerprint, db } = ctx
    const card = await seeded(ctx)
    // Control: topic B does not manage the card, a write is refused.
    assert.equal((await call('run_build', { todo_id: card.id }, runFrom('sess-b'))).error, 'TODO_TOPIC_NOT_MANAGER')
    const before = fingerprint()
    const own = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-a'))
    const other = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(other.ok, true, other.content || other.thrown)
    assert.equal(fingerprint(), before, 'read only')
    assert.deepEqual(other.data, own.data)
    assert.equal(other.content, own.content)
    assert.equal(other.data.managingTopic.id, topicA.id)
    assert.equal(other.data.topicMessagesTotal, 3)
    // A caller that is no Chief (the page, a plain chat) is not restricted, as for the other read tools.
    assert.equal((await call('get_todo_detail', { todo_id: card.id }, ctx.run)).ok, true)
    // After the take-over the messages of the previous topic about the card are still read.
    const taken = await call('watch_todos', { topic_id: topicB.id, todo_id: card.id, take_over: true }, runFrom('sess-b'))
    assert.equal(taken.ok, true, taken.content || taken.thrown)
    const after = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(after.data.managingTopic.id, topicB.id)
    const fromA = after.data.topicMessages.filter(m => m.topicId === topicA.id).map(m => m.text)
    for (const text of ['把这个延迟降到 200ms 以内', '已建卡并派工']) assert.ok(fromA.includes(text), text)
    assert.ok(after.data.timeline.some(e => /管理话题变更/.test(e.event)), 'the take-over is in the timeline')
    assert.equal(after.data.topicMessagesTotal, db.getTopic(1, 'default', topicA.id).messages.concat(db.getTopic(1, 'default', topicB.id).messages).filter(m => m.todoId === card.id).length)
  } finally { ctx.cleanup() }
})

// ── refused ──────────────────────────────────────────────────────────────────────────────────────────

test('#125 G1 a Chief of another project is refused with TOPIC_PROJECT_MISMATCH and nothing of the card is returned or written', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, fingerprint } = ctx
    const card = await seeded(ctx)
    const before = fingerprint()
    const res = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-c'))
    assert.equal(res.ok, false)
    assert.equal(res.error, 'TOPIC_PROJECT_MISMATCH', res.content || res.thrown)
    assert.ok(res.content.includes(`话题「话题丙」属于项目 beta`), res.content)
    assert.ok(res.content.includes(`不能操作项目 alpha 的卡片 #${card.number}（${card.id}）`), res.content)
    assert.equal(res.data, undefined, 'no data')
    assert.equal(res.content.includes('200ms'), false, 'neither the spec nor a message leaks into the refusal')
    assert.equal(fingerprint(), before, 'nothing written')
    // The same wording as the other read tools of the card (the existing text is reused).
    const sibling = await call('get_todo_conversation', { todo_id: card.id }, runFrom('sess-c'))
    assert.equal(res.content, sibling.content)
  } finally { ctx.cleanup() }
})

test('#125 an unknown card answers NOT_FOUND, for a Chief and for a caller that is none, and writes nothing', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, say, topicA, fingerprint } = ctx
    // A message without a card must never be matched by an empty or unknown id.
    say(topicA, 'human', '普通聊天', '', 1000)
    const before = fingerprint()
    for (const from of [runFrom('sess-a'), runFrom('sess-c'), ctx.run]) {
      for (const id of ['td-does-not-exist', '']) {
        const res = await call('get_todo_detail', { todo_id: id }, from)
        assert.equal(res.ok, false)
        assert.equal(res.error, 'NOT_FOUND', res.content || res.thrown)
        assert.equal(res.data, undefined)
        assert.equal(String(res.content).includes('普通聊天'), false)
      }
    }
    assert.equal(fingerprint(), before)
    // The query itself never matches ordinary chat (todo_id '') by an empty id.
    assert.deepEqual(ctx.db.listTopicMessagesForTodo(1, 'default', '', 40), { total: 0, messages: [] })
  } finally { ctx.cleanup() }
})

// ── boundaries ───────────────────────────────────────────────────────────────────────────────────────

test('#125 G2 only the topic messages of this card: ordinary chat of the topic and messages about another card are not returned', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, mk, say, topicA, topicB } = ctx
    const card = await seeded(ctx)
    const sibling = await mk(topicA, '另一张卡')
    say(topicA, 'human', '另一张卡的专属要求XSIB', sibling.id, 5000)
    say(topicA, 'chief', '话题里的普通回复XCHAT', '', 6000)
    say(topicB, 'human', '乙话题的普通聊天XB', '', 7000)
    const res = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(res.ok, true, res.content || res.thrown)
    assert.equal(res.data.topicMessagesTotal, 3)
    assert.equal(res.data.topicMessages.length, 3)
    const whole = JSON.stringify(res)
    for (const leak of ['与本卡无关', 'XSIB', 'XCHAT', 'XB']) assert.equal(whole.includes(leak), false, `${leak} must not be returned`)
    // Control: the other card gets its own message, and only that one.
    const other = await call('get_todo_detail', { todo_id: sibling.id }, runFrom('sess-b'))
    assert.deepEqual(other.data.topicMessages.map(m => m.text), ['另一张卡的专属要求XSIB'])
    // A card nobody talked about: an empty list, said in the text.
    const quiet = await mk(topicA, '没人提过的卡')
    const none = await call('get_todo_detail', { todo_id: quiet.id }, runFrom('sess-b'))
    assert.deepEqual(none.data.topicMessages, [])
    assert.equal(none.data.topicMessagesTotal, 0)
    assert.ok(none.content.includes('话题里针对本卡的对话（0 条）'), none.content)
    assert.ok(none.content.includes('Spec: （空）'), none.content)
  } finally { ctx.cleanup() }
})

test('#125 G3 caps: 60 timeline events and 60 topic messages come back as the latest 50 and 40, with the real totals', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, mk, say, topicA, db } = ctx
    assert.deepEqual(TODO_DETAIL_LIMITS, { timeline: 50, topicMessages: 40, specChars: 20000, messageChars: 2000 })
    const card = await mk(topicA, '很热闹的卡')
    for (let i = 1; i <= 59; i += 1) db.appendTimeline(1, 'default', card.id, `事件 ${i}`, 'system')
    for (let i = 1; i <= 60; i += 1) say(topicA, i % 2 ? 'human' : 'chief', `消息 ${i}`, card.id, 10_000 + i)
    assert.equal(db.getTodo(1, 'default', card.id).timeline.length, 60, 'the creation event and 59 more')
    const res = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(res.ok, true, res.content || res.thrown)
    const d = res.data
    assert.equal(d.timeline.length, 50)
    assert.equal(d.timelineTotal, 60)
    assert.equal(d.timelineTruncated, true)
    assert.equal(d.timeline[0].event, '事件 10', 'the oldest ten are dropped')
    assert.equal(d.timeline.at(-1).event, '事件 59', 'the newest is last')
    assert.equal(d.topicMessages.length, 40)
    assert.equal(d.topicMessagesTotal, 60)
    assert.equal(d.topicMessagesTruncated, true)
    assert.deepEqual(d.topicMessages.map(m => m.text), Array.from({ length: 40 }, (_, i) => `消息 ${i + 21}`), 'the latest 40, ascending')
    assert.ok(res.content.includes('时间线（共 60 条，显示最近 50 条）：'), res.content)
    assert.ok(res.content.includes('话题里针对本卡的对话（共 60 条，显示最近 40 条）：'), res.content)
    assert.equal(res.content.includes('事件 9\n'), false)
    assert.equal(res.content.includes('消息 20\n'), false)
    // One very long message is cut, in data and in content, and says so.
    const long = await mk(topicA, '长消息的卡')
    say(topicA, 'human', '长'.repeat(5000), long.id, 99_000)
    const cut = (await call('get_todo_detail', { todo_id: long.id }, runFrom('sess-b')))
    assert.equal(cut.data.topicMessages[0].text.length, 2000)
    assert.equal(cut.data.topicMessages[0].textLength, 5000)
    assert.equal(cut.data.topicMessages[0].textTruncated, true)
    assert.ok(cut.content.length < 3000, 'content shortens each message further')
  } finally { ctx.cleanup() }
})

test('#125 G4 a spec longer than 20,000 characters (a row stored before the write cap) is cut and reported as cut', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, mk, sql, topicA } = ctx
    const card = await mk(topicA, '超长任务书的卡', { spec: '短任务书' })
    const huge = `${'任'.repeat(24_990)}尾巴XTAIL`
    sql('UPDATE todos SET spec = ? WHERE id = ?', huge, card.id)
    const res = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(res.ok, true, res.content || res.thrown)
    assert.equal(res.data.specTruncated, true)
    assert.equal(res.data.specLength, huge.length)
    assert.equal(res.data.spec.length, 20_000)
    assert.equal(res.data.spec, huge.slice(0, 20_000))
    assert.equal(JSON.stringify(res).includes('XTAIL'), false)
    assert.ok(res.content.includes(`（任务书共 ${huge.length} 字，已截断，只显示前 20000 字）`), res.content.slice(-400))
    // Exactly at the limit: whole, not marked.
    sql('UPDATE todos SET spec = ? WHERE id = ?', '满'.repeat(20_000), card.id)
    const full = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(full.data.specTruncated, false)
    assert.equal(full.data.specLength, 20_000)
    assert.equal(full.data.spec.length, 20_000)
    assert.equal(full.content.includes('已截断'), false)
  } finally { ctx.cleanup() }
})

test('#125 an open question and the last error are carried; an archived or missing managing topic is said', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, mk, db, topicA, sql } = ctx
    const card = await mk(topicA, '在等答复的卡')
    const asked = await call('ask_user', { todo_id: card.id, title: '用方案甲还是方案乙？', why: '影响接口', options: [{ label: '方案甲', recommended: true }, { label: '方案乙' }] }, runFrom('sess-a'))
    assert.equal(asked.ok, true, asked.content || asked.thrown)
    db.updateTodo(1, 'default', card.id, { lastError: '门禁失败：npm test rc=1' })
    const res = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(res.ok, true, res.content || res.thrown)
    assert.equal(res.data.question.title, '用方案甲还是方案乙？')
    assert.equal(res.data.question.why, '影响接口')
    assert.deepEqual(res.data.question.options.map(o => o.label), ['方案甲', '方案乙'])
    assert.equal(res.data.lastError, '门禁失败：npm test rc=1')
    assert.ok(res.content.includes('在等用户答复：用方案甲还是方案乙？'), res.content)
    assert.ok(res.content.includes('最近错误：门禁失败：npm test rc=1'), res.content)
    db.updateTopic(1, 'default', topicA.id, { archived: true })
    const archived = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-b'))
    assert.deepEqual(archived.data.managingTopic, { id: topicA.id, title: '话题甲', archived: true })
    assert.ok(archived.content.includes(`管理话题：话题「话题甲」（${topicA.id}，已归档）`), archived.content)
    sql("UPDATE todos SET topic_id = 'topic-gone' WHERE id = ?", card.id)
    const gone = await call('get_todo_detail', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(gone.ok, true, gone.content || gone.thrown)
    assert.equal(gone.data.managingTopic, null)
    assert.ok(gone.content.includes('管理话题：无（原话题 topic-gone 已不存在）'), gone.content)
  } finally { ctx.cleanup() }
})

// ── the Chief is told ────────────────────────────────────────────────────────────────────────────────

test('#125 prompt and refusal text: the tool is listed, named before a take-over, and named in the read-only note of TODO_TOPIC_NOT_MANAGER', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, db, topicB, alpha } = ctx
    const card = await seeded(ctx)
    const prompt = topic => buildChiefInstructions({ topic, firstCardBinds: ctx.orch.topicBindsOnFirstCard(topic), projects: [alpha], agents: [], activeTodos: [], chiefAgent: {}, settings: {}, memories: [] })
    const owned = prompt(db.getTopic(1, 'default', topicB.id))
    assert.match(owned, /`ekko-todo` server — 34 tools/)
    assert.match(owned, /`get_todo_conversation`, `get_todo_diff`, `get_todo_detail`/)
    assert.match(owned, /Before taking a card over, call get_todo_detail/)
    assert.match(owned, /never guess from the title/)
    // The sentence belongs to the chain for existing cards, so a topic without a project gets it too.
    const { topic: loose } = await ctx.orch.createTopic(ctx.run, { title: '无项目话题' })
    const open = prompt(db.getTopic(1, 'default', loose.id))
    assert.match(open, /take_over: true\)[^\n]*Before taking a card over, call get_todo_detail/)
    const refused = await call('run_build', { todo_id: card.id }, runFrom('sess-b'))
    assert.equal(refused.error, 'TODO_TOPIC_NOT_MANAGER')
    assert.ok(refused.content.includes('对它只读（可用 get_todo_detail / get_todo_conversation / get_todo_diff 查看）'), refused.content)
  } finally { ctx.cleanup() }
})

test('#125 contract: the tool, its schema, the documents, the server bundle and the version', async () => {
  const ctx = await setup()
  try {
    const tool = ctx.tools.get('get_todo_detail')
    assert.ok(tool, 'registered')
    assert.equal(tool.readOnly, true)
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['caller_topic_id', 'todo_id'])
    assert.deepEqual(tool.inputSchema.required, ['todo_id'])
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(ctx.tools.size, Object.keys(contract.tools).length)
    // The outputs of the two older read tools are as they were.
    const card = await seeded(ctx)
    const conv = await ctx.call('get_todo_conversation', { todo_id: card.id }, ctx.runFrom('sess-b'))
    assert.deepEqual(Object.keys(conv.data).sort(), ['fallbackHistory', 'id', 'lastError', 'phase', 'plan'])
    assert.equal(conv.content, '(No worker messages yet.)')
  } finally { ctx.cleanup() }
  assert.equal(Object.keys(contract.tools).length, 34)
  const declared = contract.tools.get_todo_detail
  assert.ok(declared, 'declared in contracts/plugin.json')
  for (const word of ['#125', 'read-only', 'TOPIC_PROJECT_MISMATCH', 'NOT_FOUND', 'specTruncated', 'specLength', 'managingTopic', 'timelineTotal', 'timelineTruncated', 'topicMessagesTotal', 'topicMessagesTruncated', 'todo_id', '50', '40', '20,000']) assert.ok(declared.description.includes(word), `contract description has ${word}`)
  const contracts = read('docs/CONTRACTS.md')
  assert.match(contracts, /`get_todo_detail` \(#125/)
  assert.match(read('docs/FIELD_REFERENCE.md'), /### get_todo_detail 工具输出 data/)
  for (const file of ['README.md', 'README.en.md', 'INSTALL.md']) assert.doesNotMatch(read(file), /33 (个工具|tools|Tools)/, file)
  assert.match(read('README.md'), /共 34 个工具/)
  assert.match(read('README.en.md'), /34 Tools/)
  assert.match(read('INSTALL.md'), /共 34 个工具/)
  assert.match(read('src/shared/chief-guard.mjs'), /'get_todo_detail'/)
  const bundle = read('dist/server.mjs')
  for (const word of ["name: 'get_todo_detail'", 'TODO_DETAIL_LIMITS', 'listTopicMessagesForTodo', 'Before taking a card over, call get_todo_detail']) assert.ok(bundle.includes(word) || bundle.includes(word.replace(/'/g, '"')), `dist/server.mjs has ${word}`)
  const version = assertReleaseMetadata()
  const [major, minor, patch] = version.split('.').map(Number)
  assert.ok(major > 0 || minor > 9 || (minor === 9 && patch >= 81), `version ${version} is 0.9.81 or later`)
  assert.match(read('CHANGELOG.md'), /get_todo_detail/)
})

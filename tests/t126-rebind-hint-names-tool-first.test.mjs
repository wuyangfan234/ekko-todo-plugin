// Todo #126: the last two texts that named the topic menu (改挂项目) as the first thing to do now name
// set_topic_project first. #124 changed NO_PROJECT_HINT; two texts of the same kind were left:
//   1. topicScopeReason.message of `foreign-todos` when every card of the topic is of one other project
//      (the topic was most likely given the wrong project): it only said "use the topic menu";
//   2. the refusal of a new card whose explicit topic_id names a topic without a project: same.
// Words only: no rule, no guard and no tool is changed. The menu stays, as the last, optional sentence.
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

const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const count = (text, part) => text.split(part).length - 1
const MENU = '话题菜单'
const TOOL = 'set_topic_project'
const MENU_LAST = '用户本人也可以在话题菜单「改挂项目」操作。'

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

// Projects alpha and beta, each with a Chief topic (sess-alpha / sess-beta); `wrong` (sess-wrong): a Chief
// topic of alpha that holds two cards of beta and nothing else (stored state from before #97); `detached`
// (sess-detached): a Chief topic the user took the project away from, so the first card does not bind it.
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t126-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 4 })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 4 }, log: { warn() {}, info() {} } })
  let seq = 0
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(body) { seq += 1; return { session: { id: `s-${seq}`, title: body?.title } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async get(sid) { return { session: { id: sid, ended_at: null }, is_running: false } },
      async connect(sid, cb) { setTimeout(() => cb({ event: 'resumed', isWorking: false, runStartedAt: Date.now() }), 2); return { close() {} } },
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
  const beta = await addRepo('beta')
  const chiefTopic = async (sessionId, input = {}) => {
    const { topic } = await orch.createTopic(run, input)
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  const topicA = await chiefTopic('sess-alpha', { projectId: alpha.id, title: '甲项目话题' })
  const topicB = await chiefTopic('sess-beta', { projectId: beta.id, title: '乙项目话题' })
  const wrong = await chiefTopic('sess-wrong', { projectId: alpha.id, title: '挂错项目的话题' })
  const detached = await chiefTopic('sess-detached', { title: '摘除过的话题' })
  await orch.updateTopicMeta(run, { topicId: detached.id, projectId: '' })
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
  const scalar = text => {
    const raw = new DatabaseSync(sqlitePath, { readOnly: true })
    try { return raw.prepare(text).get().n } finally { raw.close() }
  }
  const counts = () => ({
    todos: scalar('SELECT COUNT(*) AS n FROM todos'),
    watches: scalar('SELECT COUNT(*) AS n FROM todo_watches'),
    topics: scalar('SELECT COUNT(*) AS n FROM topics'),
    messages: scalar('SELECT COUNT(*) AS n FROM topic_messages'),
    wakes: scalar('SELECT COUNT(*) AS n FROM wake_log'),
  })
  // Stored state from before #97, written straight into the tables: the card sits in `topic` and is watched by it.
  const moveRaw = (todo, topic) => {
    sql('UPDATE todos SET topic_id = ? WHERE id = ?', topic.id, todo.id)
    sql('DELETE FROM todo_watches WHERE todo_id = ?', todo.id)
    db.watchTodo(1, 'default', topic.id, todo.id, 'stored before #97')
  }
  const mk = async (project, topic, title) => (await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title })).todo
  const strays = []
  for (const title of ['乙一', '乙二']) { const td = await mk(beta, topicB, title); moveRaw(td, wrong); strays.push(td) }
  const topicOf = id => db.getTopic(1, 'default', id)
  const reason = async id => (await orch.getSnapshot(run)).topics.find(t => t.id === id).topicScopeReason
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, alpha, beta, topicA, topicB, wrong, detached, strays, mk, moveRaw, chiefTopic, call, counts, topicOf, reason, cleanup }
}

const wrongProjectMessage = (topic, target) => `本话题属于项目 alpha，但其中 2 张卡片全部属于项目 beta：更可能是话题挂错了项目。由本话题的总管调用 set_topic_project 把本话题改绑到 beta（topic_id ${topic.id}，project_id ${target.id}），改绑后这些卡片立即恢复正常；也可用「修复话题归属」（repair-topic-todos）把卡片迁到 beta 的其他话题。${MENU_LAST}`
const refusedCardMessage = (topic, project) => `话题「${topic.title}」未归属任何项目，不能创建项目 ${project.name} 的卡片；请改用项目 ${project.name} 的话题或省略 topic_id；该话题自己的总管也可以调用 set_topic_project（topic_id ${topic.id}，project_id ${project.id}）把它绑定到项目 ${project.name} 后再建卡。${MENU_LAST}`

// ── 1. foreign-todos: the topic was given the wrong project ──────────────────────────────────────────

test('#126 foreign-todos (every card is of one other project): set_topic_project is the first thing named, the menu the last and optional', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, alpha, beta, wrong, reason, topicOf } = ctx
    const found = await reason(wrong.id)
    assert.equal(found.message, wrongProjectMessage(wrong, beta))
    const at = part => found.message.indexOf(part)
    assert.ok(at(TOOL) > 0, found.message)
    assert.ok(at(TOOL) < at('修复话题归属'), 'the tool comes before the second way')
    assert.ok(at('修复话题归属') < at(MENU), 'the second way (moving the cards) is kept, before the menu')
    assert.ok(at(TOOL) < at(MENU), 'the menu is named after the tool')
    assert.equal(count(found.message, MENU), 1, 'the menu is named once')
    assert.ok(found.message.endsWith(MENU_LAST), 'as the last sentence, something the user may also do')
    assert.doesNotMatch(found.message, /建议在话题菜单/, 'not as the suggestion any more')
    // The ids to pass are both in the sentence.
    assert.ok(found.message.includes(`topic_id ${wrong.id}`) && found.message.includes(`project_id ${beta.id}`), found.message)
    // Nothing but the sentence changed.
    assert.deepEqual({ ...found, message: '' }, { code: 'foreign-todos', message: '', projectId: alpha.id, todoCount: 2, foreignTodoCount: 2, suggestedProjectId: beta.id })
    // It reaches the Chief: data and content of list_todos.
    const listed = await call('list_todos', {}, runFrom('sess-wrong'))
    assert.equal(listed.ok, true, listed.content || listed.thrown)
    assert.deepEqual(listed.data.topicScopeReason, found)
    assert.ok(listed.content.includes(found.message), listed.content)
    assert.equal(topicOf(wrong.id).projectId, alpha.id, 'a project that was set is never changed automatically')
  } finally { ctx.cleanup() }
})

test('#126 control: foreign-todos with cards of the topic\'s own project too keeps its text, word for word', async () => {
  const ctx = await setup()
  try {
    const { alpha, topicA, wrong, mk, moveRaw, reason } = ctx
    moveRaw(await mk(alpha, topicA, '甲卡'), wrong)
    const found = await reason(wrong.id)
    assert.deepEqual(found, {
      code: 'foreign-todos',
      message: '本话题属于项目 alpha，其中 2 张卡片属于其他项目，不在这里处理；可用「修复话题归属」（repair-topic-todos）把它们迁到各自项目的话题。',
      projectId: alpha.id,
      todoCount: 3,
      foreignTodoCount: 2,
    })
  } finally { ctx.cleanup() }
})

test('#126 end to end: the Chief of a topic on the wrong project does what the reason says and its cards are in order', async () => {
  const ctx = await setup()
  try {
    const { orch, run, call, runFrom, beta, wrong, strays, topicOf, reason } = ctx
    const chief = runFrom('sess-wrong')
    const before = await call('list_todos', {}, chief)
    assert.deepEqual(before.data.todos, [], 'its two cards are of another project and are not listed')
    const named = before.data.topicScopeReason.message.match(/调用 (set_topic_project) 把本话题改绑到 beta（topic_id ([^，]+)，project_id ([^）]+)）/)
    assert.ok(named, before.data.topicScopeReason.message)
    assert.equal(named[2], wrong.id)
    assert.equal(named[3], beta.id)
    const bound = await call(named[1], { topic_id: named[2], project_id: named[3] }, chief)
    assert.equal(bound.ok, true, bound.content || bound.thrown)
    assert.equal(topicOf(wrong.id).projectId, beta.id)
    assert.equal(await reason(wrong.id), undefined, 'the reason is gone')
    const after = await call('list_todos', {}, chief)
    assert.deepEqual(after.data.todos.map(t => t.id).sort(), strays.map(t => t.id).sort(), 'the cards are listed without having been moved')
    assert.equal((await orch.getSnapshot(run)).todos.filter(t => t.topicId === wrong.id && t.topicProjectMismatch).length, 0)
  } finally { ctx.cleanup() }
})

// ── 2. a new card whose topic_id names a topic without a project ─────────────────────────────────────

test('#126 create_todo refused for a topic without a project: the answer names set_topic_project with both ids, the menu last', async () => {
  const ctx = await setup()
  try {
    const { orch, run, call, runFrom, alpha, detached, counts, topicOf } = ctx
    const want = refusedCardMessage(detached, alpha)
    const before = counts()
    // The tool, called by the topic's own Chief (the user detached it, so #118 does not bind it).
    const viaTool = await call('create_todo', { project_id: alpha.id, topic_id: detached.id, title: '指定无项目话题' }, runFrom('sess-detached'))
    assert.equal(viaTool.ok, false)
    assert.equal(viaTool.thrown, want)
    // The page RPC path and a caller that is not known get the same sentence.
    await assert.rejects(() => orch.createTodo(run, { projectId: alpha.id, topicId: detached.id, title: '页面指定无项目话题' }), err => { assert.equal(err.message, want); return true })
    const at = part => want.indexOf(part)
    assert.ok(want.includes(TOOL), 'no longer the menu alone')
    assert.ok(want.includes(`topic_id ${detached.id}`) && want.includes(`project_id ${alpha.id}`), 'topic id and the id of the card\'s project')
    assert.ok(at('省略 topic_id') < at(TOOL) && at(TOOL) < at(MENU), 'another topic or no topic_id, then the tool, then the menu')
    assert.equal(count(want, MENU), 1)
    assert.ok(want.endsWith(MENU_LAST))
    assert.doesNotMatch(want, /也可以在话题菜单「改挂项目」把它挂到项目/, 'the old bracket is gone')
    assert.deepEqual(counts(), before, 'a refusal stores nothing')
    assert.equal(topicOf(detached.id).projectId, '')
  } finally { ctx.cleanup() }
})

test('#126 control: a topic of another project is refused as before, with no tool and no menu named', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, alpha, topicB } = ctx
    const res = await call('create_todo', { project_id: alpha.id, topic_id: topicB.id, title: '指定别的项目的话题' }, runFrom('sess-beta'))
    assert.equal(res.thrown, '话题「乙项目话题」属于项目 beta，不能创建项目 alpha 的卡片；请改用项目 alpha 的话题或省略 topic_id')
    const missing = await call('create_todo', { project_id: alpha.id, topic_id: 'topic-none', title: '话题不存在' }, runFrom('sess-beta'))
    assert.equal(missing.thrown, '话题不存在：topic-none；请改用项目 alpha 的话题或省略 topic_id')
  } finally { ctx.cleanup() }
})

test('#126 end to end: create_todo is refused, the Chief calls set_topic_project as told, and the same call then makes the card', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, alpha, detached, topicOf } = ctx
    const chief = runFrom('sess-detached')
    const input = { project_id: alpha.id, topic_id: detached.id, title: '绑定后再建的卡' }
    const refused = await call('create_todo', input, chief)
    assert.equal(refused.ok, false)
    const named = refused.thrown.match(/调用 (set_topic_project)（topic_id ([^，]+)，project_id ([^）]+)）把它绑定到项目 alpha 后再建卡/)
    assert.ok(named, refused.thrown)
    assert.equal(named[2], detached.id)
    assert.equal(named[3], alpha.id)
    const bound = await call(named[1], { topic_id: named[2], project_id: named[3], reason: '用户要在本话题建 alpha 的卡' }, chief)
    assert.equal(bound.ok, true, bound.content || bound.thrown)
    assert.equal(topicOf(detached.id).projectId, alpha.id)
    const made = await call('create_todo', input, chief)
    assert.equal(made.ok, true, made.content || made.thrown)
    assert.equal(made.data.topicId, detached.id)
    assert.equal(made.data.topicResolvedBy, 'explicit')
    assert.deepEqual(topicOf(detached.id).watchedTodoIds, [made.data.id])
  } finally { ctx.cleanup() }
})

test('#126 control: set_topic_project is still refused for a topic that is not the caller\'s own (the text says whose Chief may call it)', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, alpha, detached, topicOf } = ctx
    const refused = await call('create_todo', { project_id: alpha.id, topic_id: detached.id, title: '别的话题的总管来指定' }, runFrom('sess-beta'))
    assert.ok(refused.thrown.includes('该话题自己的总管也可以调用 set_topic_project'), refused.thrown)
    const other = await call('set_topic_project', { topic_id: detached.id, project_id: alpha.id }, runFrom('sess-beta'))
    assert.equal(other.error, 'NOT_TOPIC_CHIEF', other.content || other.thrown)
    assert.equal(topicOf(detached.id).projectId, '')
  } finally { ctx.cleanup() }
})

// ── 3. what was deliberately left as it is ───────────────────────────────────────────────────────────

// Texts that name the menu and are right to: read by the user as something they may also do, or the only
// way left when the tool refuses. Each is in the source once, word for word.
const KEPT = [
  ['adoptOrphanTopics system message', "如需更换，在话题菜单「改挂项目」。`,"],
  ['set_topic_project: caller not known', "const direct = '请按工具名直接调用 set_topic_project（不要经 tool_call 包装），topic_id 填你自己所在话题的 id（指令里 Current Topic 的 topic_id）；仍被拒绝时再请用户在话题菜单「改挂项目」操作。'"],
  ['set_topic_project: NOT_TOPIC_CHIEF', "throw codedError('NOT_TOPIC_CHIEF', '未做任何改动：话题的项目归属只能由该话题自己的总管会话修改，本次调用方不是任何话题的总管会话。用户本人可在话题菜单「改挂项目」操作。')"],
  ['TOPIC_HAS_OTHER_CARDS: step', "先由项目 ${previousName} 的另一个话题接管（在那个话题里调用 watch_todos，take_over: true），或由用户在话题菜单「改挂项目」改到 ${project.name} 后再点「修复话题归属」`)"],
  ['TOPIC_HAS_OTHER_CARDS: text', "throw codedError('TOPIC_HAS_OTHER_CARDS', `未做任何改动：话题「${topic.title}」属于项目 ${previousName}，其中有 ${others.length} 张卡片不属于目标项目 ${project.name}，改绑会让它们留在一个不属于自己项目的话题里。下一步：${steps.join('；')}。卡片迁走后再调用 set_topic_project；如果只是要处理项目 ${project.name} 的事，也可以不改绑。${projectTopicHint(userId, profile, project.id)}。`)"],
  ['set_topic_project: system message', "text: `${lead}（${how}）。之后本话题只处理该项目的卡片；${stray}如挂错，可让总管再次改绑，或在话题菜单「改挂项目」更换。`,"],
  ['first card binds: system message', "text: `话题已绑定到项目 ${project.name}（依据总管在本话题创建的第一张卡 #${todo.number}）。之后本话题只处理该项目的卡片；如挂错，在话题菜单「改挂项目」更换。`,"],
]

test('#126 control: the texts that were to stay are in the source once each, word for word', () => {
  const source = read('src/server/orchestrator.mjs')
  for (const [name, literal] of KEPT) assert.equal(count(source, literal), 1, name)
  // 改挂项目 in the server: six of the seven kept above (the TOPIC_HAS_OTHER_CARDS text itself does not
  // have the word) and the two new last sentences, nothing else.
  assert.equal(count(source, '改挂项目'), 8)
  assert.equal(count(source, '话题菜单'), 8)
  assert.equal(count(source, MENU_LAST), 2)
  // The menu itself.
  assert.equal(count(read('src/client/components/ChatPane.jsx'), '改挂项目'), 1)
  assert.equal(count(read('src/client/components/Dialogs.jsx'), '改挂项目'), 1)
})

test('#126 control: the kept texts are still what is said (adopted topic, tool without a known caller, bound topic)', async () => {
  const ctx = await setup()
  try {
    const { db, orch, run, call, runFrom, alpha, beta, topicA, topicB, mk, moveRaw, chiefTopic } = ctx
    const systemTexts = id => db.getTopic(1, 'default', id).messages.filter(m => m.kind === 'system').map(m => m.text)
    // adoptOrphanTopics.
    const orphan = await chiefTopic('sess-orphan', { title: '老话题' })
    moveRaw(await mk(beta, topicB, '乙三'), orphan)
    await orch.getSnapshot(run)
    assert.deepEqual(systemTexts(orphan.id), ['话题已归属到项目 beta（按其中卡片多数）：本话题 1 张卡片中 1 张属于该项目。如需更换，在话题菜单「改挂项目」。'])
    // set_topic_project from no session at all.
    const unknown = await call('set_topic_project', { topic_id: topicA.id, project_id: beta.id })
    assert.equal(unknown.error, 'CALLER_AMBIGUOUS', unknown.content || unknown.thrown)
    assert.ok(unknown.content.endsWith('请按工具名直接调用 set_topic_project（不要经 tool_call 包装），topic_id 填你自己所在话题的 id（指令里 Current Topic 的 topic_id）；仍被拒绝时再请用户在话题菜单「改挂项目」操作。'), unknown.content)
    // set_topic_project from a session that is no Chief.
    const stranger = await call('set_topic_project', { topic_id: topicA.id, project_id: beta.id }, runFrom('sess-nobody'))
    assert.equal(stranger.error, 'NOT_TOPIC_CHIEF', stranger.content || stranger.thrown)
    assert.equal(stranger.content, '未做任何改动：话题的项目归属只能由该话题自己的总管会话修改，本次调用方不是任何话题的总管会话。用户本人可在话题菜单「改挂项目」操作。')
    // TOPIC_HAS_OTHER_CARDS: a card of the topic's own project is in the way.
    const own = await mk(alpha, topicA, '甲卡')
    const held = await call('set_topic_project', { topic_id: topicA.id, project_id: beta.id }, runFrom('sess-alpha'))
    assert.equal(held.error, 'TOPIC_HAS_OTHER_CARDS', held.content || held.thrown)
    assert.ok(held.content.startsWith(`未做任何改动：话题「甲项目话题」属于项目 alpha，其中有 1 张卡片不属于目标项目 beta，改绑会让它们留在一个不属于自己项目的话题里。下一步：#${own.number} 属于本话题当前的项目 alpha，「修复话题归属」不会迁它们（它只迁不属于话题项目的卡）：先由项目 alpha 的另一个话题接管（在那个话题里调用 watch_todos，take_over: true），或由用户在话题菜单「改挂项目」改到 beta 后再点「修复话题归属」。卡片迁走后再调用 set_topic_project；如果只是要处理项目 beta 的事，也可以不改绑。`), held.content)
    // Bound by the tool, and bound by the first card.
    const fresh = await chiefTopic('sess-fresh', { title: '新话题' })
    assert.equal((await call('set_topic_project', { topic_id: fresh.id, project_id: alpha.id }, runFrom('sess-fresh'))).ok, true)
    assert.deepEqual(systemTexts(fresh.id), ['话题已绑定到项目 alpha（由总管调用 set_topic_project 绑定）。之后本话题只处理该项目的卡片；如挂错，可让总管再次改绑，或在话题菜单「改挂项目」更换。'])
    const first = await chiefTopic('sess-first', { title: '第一张卡的话题' })
    const made = await call('create_todo', { project_id: alpha.id, title: '第一张卡' }, runFrom('sess-first'))
    assert.equal(made.ok, true, made.content || made.thrown)
    const number = db.getTodo(1, 'default', made.data.id).number
    assert.deepEqual(systemTexts(first.id), [`话题已绑定到项目 alpha（依据总管在本话题创建的第一张卡 #${number}）。之后本话题只处理该项目的卡片；如挂错，在话题菜单「改挂项目」更换。`])
  } finally { ctx.cleanup() }
})

// ── 4. contract, documents, bundle, version ──────────────────────────────────────────────────────────

test('#126: the documents, the server bundle and the version carry the new texts', () => {
  const docs = read('docs/CONTRACTS.md')
  assert.match(docs, /#126, since 0\.9\.82/)
  assert.ok(docs.includes(`更可能是话题挂错了项目。由本话题的总管调用 set_topic_project 把本话题改绑到 <Y>（topic_id <topicId>，project_id <Y 的 id>），改绑后这些卡片立即恢复正常；也可用「修复话题归属」（repair-topic-todos）把卡片迁到 <Y> 的其他话题。${MENU_LAST}`), 'CONTRACTS.md quotes the new foreign-todos message')
  assert.ok(docs.includes(`请改用项目 <Z> 的话题或省略 topic_id；该话题自己的总管也可以调用 set_topic_project（topic_id <topicId>，project_id <Z 的 id>）把它绑定到项目 <Z> 后再建卡。${MENU_LAST}`), 'CONTRACTS.md quotes the new create_todo refusal')
  assert.equal(count(docs, '建议在话题菜单「改挂项目」把本话题改挂到 <Y>'), 1, 'the old suggestion is quoted once, as what it was before #126')
  assert.equal(count(docs, '（也可以在话题菜单「改挂项目」把它挂到项目 <Z>）'), 1, 'the old bracket is quoted once, as what it was before #126')
  const bundle = read('dist/server.mjs')
  // Chinese literals are written as \uXXXX in the bundle: count both forms.
  const esc = text => [...text].map(c => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('')
  const has = text => bundle.includes(text) || bundle.toLowerCase().includes(esc(text).toLowerCase())
  assert.ok(has('看板') || has('话题'), 'control: the way of counting finds a text that is surely there')
  for (const literal of ['由本话题的总管调用 set_topic_project 把本话题改绑到', '该话题自己的总管也可以调用 set_topic_project（topic_id', MENU_LAST]) assert.ok(has(literal), `server bundle has ${literal}`)
  for (const literal of ['建议在话题菜单', '把它挂到项目']) assert.equal(has(literal), false, `server bundle no longer has ${literal}`)
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  assert.ok(major > 0 || minor > 9 || (minor === 9 && patch >= 82), `version ${pkg.version} is 0.9.82 or later`)
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(contract.description.includes(`v${pkg.version} `))
  const log = read('CHANGELOG.md')
  const section = version => (log.split(/^## \[/m).find(part => part.startsWith(`${version}]`)) || '')
  assert.match(section('0.9.82'), /#126/)
  assert.doesNotMatch(section('0.9.82'), /#125/)
  assert.match(section('0.9.81'), /#125/)
  assert.doesNotMatch(section('0.9.81'), /#126/)
  assert.match(section('0.9.80'), /#124/)
  assert.ok(log.indexOf('## [0.9.82]') < log.indexOf('## [0.9.81]') && log.indexOf('## [0.9.81]') < log.indexOf('## [0.9.80]'))
})

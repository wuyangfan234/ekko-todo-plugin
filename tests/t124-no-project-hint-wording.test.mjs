// Todo #124: the texts for a topic without a project no longer send anyone to the topic menu first.
// #121 and #123 made the Chief bind its own topic (set_topic_project), but NO_PROJECT_HINT still opened
// every such text with 请先改挂项目（话题菜单「改挂项目」）, and the list_todos refusal said "use the menu" and
// "no need for the menu" in one sentence. This card changes words only: no rule, no guard and no tool is
// changed, and the menu entry (update-topic) stays as it is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'

const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const MISMATCH = 'TOPIC_PROJECT_MISMATCH'
const HINT = '本话题还没有绑定项目'
const OLD = [/请先改挂项目/, /改挂项目/, /话题菜单/, /改挂前/]

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

// Project alpha with a Chief topic that manages one card (sess-owner), fresh (sess-fresh): a Chief topic
// whose project was never decided, and detached (sess-detached): a Chief topic the user took the project
// away from.
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-t124-'))
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
  const dir = join(root, 'alpha')
  initRepo(dir)
  const alpha = (await orch.addProject(run, { name: 'alpha', repoPath: dir })).project
  const chiefTopic = async (sessionId, input = {}) => {
    const { topic } = await orch.createTopic(run, input)
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: sessionId })
    return db.getTopic(1, 'default', topic.id)
  }
  const owner = await chiefTopic('sess-owner', { projectId: alpha.id, title: '原管理话题' })
  const fresh = await chiefTopic('sess-fresh', { title: '新话题' })
  const detached = await chiefTopic('sess-detached', { title: '摘除过的话题' })
  await orch.updateTopicMeta(run, { topicId: detached.id, projectId: '' })
  const tools = new Map()
  registerMcpTools({ extensions: { tools: { register(d) { tools.set(d.name, d); return () => {} } } } }, { db, orchestrator: orch })
  const call = async (name, input, from = run) => {
    try { return await tools.get(name).execute(input, from) } catch (err) { return { ok: false, thrown: err?.message || String(err) } }
  }
  const card = (await orch.createTodo(run, { projectId: alpha.id, topicId: owner.id, title: '已有的卡' })).todo
  const topicOf = id => db.getTopic(1, 'default', id)
  const reason = async id => (await orch.getSnapshot(run)).topics.find(t => t.id === id).topicScopeReason
  const cleanup = () => { try { orch.dispose?.() } catch {} ; try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, runFrom, alpha, owner, fresh, detached, card, topicOf, reason, call, cleanup }
}

const count = (text, part) => text.split(part).length - 1

// ── the constant ─────────────────────────────────────────────────────────────────────────────────────

test('#124 NO_PROJECT_HINT states the fact and names no menu', () => {
  const source = read('src/server/orchestrator.mjs')
  const found = source.match(/const NO_PROJECT_HINT = '([^']*)'/)
  assert.ok(found, 'the constant is one plain string literal')
  assert.equal(found[1], HINT)
  for (const old of OLD) assert.doesNotMatch(found[1], old)
  assert.equal(count(source, '请先改挂项目'), 0, 'no text of the server tells anyone to use the menu first')
})

// ── for the Chief ────────────────────────────────────────────────────────────────────────────────────

test('#124 a tool that names a card, from a topic without a project: the first thing the Chief reads is set_topic_project', async () => {
  const ctx = await setup()
  try {
    const { orch, call, runFrom, alpha, fresh, detached, card, topicOf } = ctx
    for (const [session, topic] of [['sess-fresh', fresh], ['sess-detached', detached]]) {
      const lead = `${HINT}：由你调用 set_topic_project 绑定到卡片所在的项目（topic_id ${topic.id}，project_id ${alpha.id}），不必让用户去操作。`
      const check = orch.chiefTodoScopeCheck(runFrom(session), 'run_build', card.id)
      assert.equal(check.code, MISMATCH)
      assert.ok(check.text.startsWith(lead), check.text)
      for (const old of OLD) assert.doesNotMatch(check.text, old, session)
      // The tool is named before the sentence that points at another topic.
      assert.ok(check.text.indexOf('set_topic_project') < check.text.indexOf('请到项目 alpha 的话题'), check.text)
      const res = await call('run_build', { todo_id: card.id }, runFrom(session))
      assert.equal(res.error, MISMATCH, res.content || res.thrown)
      assert.ok(res.content.startsWith(lead), res.content)
      for (const old of OLD) assert.doesNotMatch(res.content, old, session)
      // What #121 and #123 wrote at the end is still there, word for word.
      assert.ok(res.content.includes(`也可以直接调用 set_topic_project（topic_id ${topic.id}，project_id ${alpha.id}）把本话题绑定到项目 alpha`), res.content)
      assert.ok(res.content.includes('take_over: true'), res.content)
      assert.equal(topicOf(topic.id).projectId, '', 'a refusal binds nothing')
    }
  } finally { ctx.cleanup() }
})

test('#124 control: a topic that has a project gets no such lead', async () => {
  const ctx = await setup()
  try {
    const { orch, run, runFrom, card } = ctx
    const dir = join(tmpdir(), `ekko-t124-beta-${process.pid}-${Date.now()}`)
    initRepo(dir)
    try {
      const beta = (await orch.addProject(run, { name: 'beta', repoPath: dir })).project
      const { topic } = await orch.createTopic(run, { projectId: beta.id, title: '乙项目话题' })
      ctx.db.updateTopic(1, 'default', topic.id, { chiefSessionId: 'sess-beta' })
      const check = orch.chiefTodoScopeCheck(runFrom('sess-beta'), 'run_build', card.id)
      assert.equal(check.code, MISMATCH)
      assert.ok(check.text.startsWith('话题「乙项目话题」属于项目 beta，不能操作项目 alpha 的卡片'), check.text)
      assert.doesNotMatch(check.text, /set_topic_project/)
      assert.equal(check.text.includes(HINT), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  } finally { ctx.cleanup() }
})

test('#124 list_todos from a topic without a project: one instruction, not two that contradict each other', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, fresh, detached, topicOf } = ctx
    for (const [session, topic] of [['sess-fresh', fresh], ['sess-detached', detached]]) {
      const res = await call('list_todos', {}, runFrom(session))
      assert.equal(res.ok, false)
      assert.equal(res.error, MISMATCH, res.content || res.thrown)
      assert.equal(
        res.content,
        `${HINT}：话题「${topic.title}」未归属任何项目，看不到任何项目的卡片；请调用 set_topic_project 把本话题绑定到一个项目（topic_id ${topic.id}，project_id 见 list_projects 或项目清单），不必让用户去操作。`,
      )
      // Neither half of the old pair is left: "use the menu first" and "no need for the menu".
      for (const old of OLD) assert.doesNotMatch(res.content, old, session)
      assert.equal(count(res.content, 'set_topic_project'), 1, 'said once')
      assert.equal(res.data.topicScopeReason.code, 'no-project')
      assert.equal(topicOf(topic.id).projectId, '', 'a refusal binds nothing')
    }
  } finally { ctx.cleanup() }
})

// ── for the user ─────────────────────────────────────────────────────────────────────────────────────

test('#124 topicScopeReason.message: what the page shows no longer opens with the menu', async () => {
  const ctx = await setup()
  try {
    const { fresh, detached, owner, reason } = ctx
    const open = await reason(fresh.id)
    const closed = await reason(detached.id)
    assert.equal(open.code, 'no-project')
    assert.equal(closed.code, 'no-project')
    assert.equal(open.message, `${HINT}，总管会根据你说的事判断项目并自动绑定；也可以直接在总管那里说要绑定到哪个项目，或直接让总管建第一张卡，话题会自动固定到该卡的项目。绑定前总管不能在这里列卡、派工、审查或合并，也不会被卡片进展唤醒。`)
    assert.equal(closed.message, `${HINT}，总管会根据你说的事判断项目并自动绑定；也可以直接在总管那里说要绑定到哪个项目。绑定前总管不能在这里列卡、派工、审查或合并，也不会被卡片进展唤醒。`)
    for (const message of [open.message, closed.message]) {
      assert.doesNotMatch(message, /^本话题未归属项目，请先改挂项目/)
      for (const old of OLD) assert.doesNotMatch(message, old)
    }
    // Nothing but the sentence changed.
    assert.deepEqual({ ...open, message: '' }, { code: 'no-project', message: '', projectId: '', todoCount: 0, foreignTodoCount: 0 })
    assert.equal(await reason(owner.id), undefined, 'absent on a topic that is in order')
  } finally { ctx.cleanup() }
})

// ── end to end ───────────────────────────────────────────────────────────────────────────────────────

test('#124 end to end: refused by list_todos, the Chief does what the answer says and lists its cards', async () => {
  const ctx = await setup()
  try {
    const { call, runFrom, alpha, fresh, card, topicOf, reason } = ctx
    const chief = runFrom('sess-fresh')
    const refused = await call('list_todos', {}, chief)
    assert.equal(refused.error, MISMATCH, refused.content || refused.thrown)
    // Nothing in the answer sends the user to the menu, so there is one thing to do and the Chief does it.
    for (const old of OLD) assert.doesNotMatch(refused.content, old)
    // The answer names the tool and the topic id to pass; the project id comes from list_projects.
    const named = refused.content.match(/请调用 (set_topic_project) 把本话题绑定到一个项目（topic_id ([^，]+)，project_id 见 (list_projects)/)
    assert.ok(named, refused.content)
    assert.equal(named[2], fresh.id)
    const projects = await call(named[3], {}, chief)
    assert.equal(projects.ok, true, projects.content || projects.thrown)
    assert.ok(projects.content.includes(alpha.id), 'list_projects gives the project id')
    const bound = await call(named[1], { topic_id: named[2], project_id: alpha.id, reason: '用户要看 alpha 的卡' }, chief)
    assert.equal(bound.ok, true, bound.content || bound.thrown)
    assert.equal(topicOf(fresh.id).projectId, alpha.id)
    const listed = await call('list_todos', {}, chief)
    assert.equal(listed.ok, true, listed.content || listed.thrown)
    assert.equal(listed.error, undefined)
    assert.equal(listed.content.includes(HINT), false, 'not refused for this any more')
    assert.ok(listed.data.todos.some(t => t.id === card.id), 'the cards of the project are listed')
    assert.equal(await reason(fresh.id), undefined, 'the notice on the page is gone')
  } finally { ctx.cleanup() }
})

// ── what did not change ──────────────────────────────────────────────────────────────────────────────

test('#124 control: the menu entry is untouched and still binds a topic', async () => {
  const ctx = await setup()
  try {
    const { orch, run, alpha, detached, topicOf, reason } = ctx
    assert.match(read('src/client/components/ChatPane.jsx'), /改挂项目/)
    assert.match(read('src/client/components/Dialogs.jsx'), /改挂项目/)
    await orch.updateTopicMeta(run, { topicId: detached.id, projectId: alpha.id })
    assert.equal(topicOf(detached.id).projectId, alpha.id)
    assert.equal(await reason(detached.id), undefined)
    // Texts that describe the menu as something the user may also use are kept.
    const source = read('src/server/orchestrator.mjs')
    assert.ok(source.includes('如挂错，可让总管再次改绑，或在话题菜单「改挂项目」更换。'))
    assert.ok(source.includes('用户本人可在话题菜单「改挂项目」操作。'))
  } finally { ctx.cleanup() }
})

// ── contract, documents, bundle, version ─────────────────────────────────────────────────────────────

test('#124: the contract, the documents, the server bundle and the version carry the new texts', () => {
  const list = contract.tools.list_todos.description
  assert.ok(list.includes(`starts with ${HINT}`), 'list_todos contract quotes the new opening')
  assert.equal(list.includes('请先改挂项目'), false)
  const docs = read('docs/CONTRACTS.md')
  assert.match(docs, /#124/)
  assert.ok(docs.includes(`${HINT}，总管会根据你说的事判断项目并自动绑定；也可以直接在总管那里说要绑定到哪个项目。绑定前总管不能在这里列卡、派工、审查或合并，也不会被卡片进展唤醒。`), 'CONTRACTS.md quotes the new topicScopeReason message')
  assert.ok(docs.includes('project_id 见 list_projects 或项目清单），不必让用户去操作'), 'CONTRACTS.md quotes the new list_todos text')
  assert.ok(docs.includes('#124, since 0.9.80'))
  assert.equal(docs.includes('#124, since 0.9.79'), false)
  assert.equal(count(docs, '请先改挂项目（话题菜单「改挂项目」）'), 1, 'the old opening is quoted once, as what it was before #124')
  const bundle = read('dist/server.mjs')
  // Chinese literals may be written as \uXXXX in the bundle: count both forms.
  const esc = text => [...text].map(c => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('')
  const has = text => bundle.includes(text) || bundle.toLowerCase().includes(esc(text).toLowerCase())
  assert.ok(has('看板') || has('话题'), 'control: the way of counting finds a text that is surely there')
  for (const literal of [HINT, '总管会根据你说的事判断项目并自动绑定', '由你调用 set_topic_project 绑定到卡片所在的项目', '或项目清单），不必让用户去操作']) assert.ok(has(literal), `server bundle has ${literal}`)
  assert.equal(has('请先改挂项目'), false, 'the server bundle no longer has the old opening')
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  assert.ok(major > 0 || minor > 9 || (minor === 9 && patch >= 80), `version ${pkg.version} is 0.9.80 or later`)
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(contract.description.includes(`v${pkg.version} `))
  // #124 is 0.9.80: 0.9.79 was taken by #122, whose section stays as it was, below this one.
  const log = read('CHANGELOG.md')
  const section = version => (log.split(/^## \[/m).find(part => part.startsWith(`${version}]`)) || '')
  assert.match(section('0.9.80'), /#124/)
  assert.doesNotMatch(section('0.9.80'), /#122/)
  assert.match(section('0.9.79'), /#122/)
  assert.doesNotMatch(section('0.9.79'), /#124/)
  assert.ok(log.indexOf('## [0.9.80]') < log.indexOf('## [0.9.79]') && log.indexOf('## [0.9.79]') < log.indexOf('## [0.9.78]'))
})

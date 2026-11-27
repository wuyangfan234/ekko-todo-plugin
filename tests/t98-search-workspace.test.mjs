// Todo #98: search must find what the user remembers. One server RPC (search-workspace) searches every
// field (title, #number, branch, tags, Agent, project, topic, spec, timeline, worker chat; topic brief and
// messages; project name / alias / repo; memory title / content) with a literal substring rule, ranks the
// hits and returns snippets; the command palette, board filter, project workspace and memory search use
// it or the same matching function.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { fitSnapshotBudget } from '../src/server/diff-budget.mjs'
import { SEARCH_FIELD_SCORES as S } from '../src/server/search.mjs'
import { highlightSegments, makeSnippet, matchesQuery, normalizeSearchQuery, parseNumberQuery, todoSearchFields } from '../src/shared/search-text.mjs'
import { createSearchRunner, localWorkspaceSearch } from '../src/client/workspace-search-core.js'
import { validateModel } from '../sdk/harness/contracts.mjs'

const contract = JSON.parse(readFileSync(new URL('../contracts/plugin.json', import.meta.url), 'utf8'))
const src = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const dirs = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const U = 1
const PF = 'default'
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-search-'))
  dirs.push(dir)
  const db = createDatabase(join(dir, 'data'), {})
  return { db, dir }
}
const S1 = (db, query, extra = {}) => db.searchWorkspace(U, PF, { query, scope: 'todos', ...extra })
const hits = (db, query, extra) => S1(db, query, extra).groups[0].items
const numbers = (db, query, extra) => hits(db, query, extra).map(i => i.number)

function seed() {
  const { db, dir } = fresh()
  const p1 = db.createProject(U, PF, { name: 'ekko-todo', repoPath: '/tmp/r1', displayName: '工作台' })
  const p2 = db.createProject(U, PF, { name: 'zen-repo', repoPath: '/tmp/r2', githubRepo: 'acme/zen-repo' })
  const agent = db.upsertAgent(U, PF, { name: '搜索专员', role: 'builder', engine: 'codex' })
  const topic = db.createTopic(U, PF, { title: '会展排期讨论', projectId: p1.id })
  const mk = (title, patch = {}, projectId = p1.id) => {
    const t = db.createTodo(U, PF, { projectId, title, topicId: patch.topicId || '' })
    const { topicId, ...rest } = patch
    if (Object.keys(rest).length) db.updateTodo(U, PF, t.id, rest)
    return db.getTodo(U, PF, t.id)
  }
  const cards = {
    cross: mk('修复跨项目串台问题'),
    watchdog: mk('WATCHDOG 收紧误杀边界'),
    spec: mk('普通卡片甲', { spec: '这里写着任务书专有词：琥珀色按钮' }),
    timeline: mk('普通卡片乙', { timeline: [{ time: 1, event: '审查通过：时间线专有词青柠', actor: 'system' }] }),
    chat: mk('普通卡片丙', { buildChat: [{ role: 'agent', time: '', text: '会话里提到了独角鲸方案' }] }),
    branch: mk('普通卡片丁', { branch: 'ekko-todo/feature-narwhal' }),
    tags: mk('普通卡片戊', { tags: ['性能', '前端'] }),
    agent: mk('普通卡片己', { agentId: agent.id }),
    topic: mk('普通卡片庚', { topicId: topic.id }),
    pct: mk('进度 100% 完成'),
    under: mk('snake_case 字段'),
    slash: mk('路径 C:\\temp 处理'),
    other: mk('别的项目卡', {}, p2.id),
  }
  return { db, dir, p1, p2, agent, topic, cards }
}

// ── Unit: matching rules ─────────────────────────────────────────────────────

test('#98 unit: Chinese substring, partial word and case-insensitivity', () => {
  const { db, cards } = seed()
  assert.deepEqual(numbers(db, '跨项目'), [cards.cross.number], '「跨项目」 hits 「修复跨项目串台问题」')
  assert.deepEqual(numbers(db, '串台'), [cards.cross.number], 'partial Chinese word')
  assert.deepEqual(numbers(db, 'watchdog'), [cards.watchdog.number], 'lower case finds upper case')
  assert.deepEqual(numbers(db, 'WaTcH'), [cards.watchdog.number], 'mixed-case prefix')
  assert.equal(hits(db, 'watchdog')[0].matchedField, 'title_prefix')
})

test('#98 unit: #N is an exact card number and ranks first; full-width ＃ and digits work', () => {
  const { db, cards } = seed()
  const n = cards.spec.number
  const res = hits(db, `#${n}`)
  assert.equal(res[0].number, n)
  assert.equal(res[0].matchedField, 'number_hash')
  assert.equal(res[0].score, S.number_hash)
  assert.equal(hits(db, `＃${String(n).replace(/\d/g, d => String.fromCharCode(0xff10 + Number(d)))}`)[0].number, n, 'full-width ＃３')
  assert.equal(parseNumberQuery('#12'), 12)
  assert.equal(parseNumberQuery('12a'), null)
  // Bare digits still match the number (ranked after title hits).
  assert.ok(hits(db, String(n)).some(i => i.number === n && i.matchedField === 'number'))
})

test('#98 unit: % _ and \\ are literal characters, not wildcards, and never throw', () => {
  const { db, cards } = seed()
  assert.deepEqual(numbers(db, '%'), [cards.pct.number], '% only matches the card with a percent sign')
  assert.deepEqual(numbers(db, '_'), [cards.under.number], '_ only matches the card with an underscore')
  assert.deepEqual(numbers(db, '\\'), [cards.slash.number], 'backslash only matches the card with a backslash')
  assert.deepEqual(numbers(db, '100%'), [cards.pct.number])
  for (const q of ["'", '"', ')', '(*', '[', '$q', ':x', '?', '%_\\', '--', ';DROP TABLE todos;']) {
    assert.doesNotThrow(() => db.searchWorkspace(U, PF, { query: q }), `query ${q}`)
  }
  assert.ok(db.listTodos(U, PF).length > 0, 'nothing was dropped')
})

test('#98 unit: empty query → recent, whitespace → nothing, very long query → cut, no result → total 0', () => {
  const { db } = seed()
  const recent = db.searchWorkspace(U, PF, { query: '' })
  assert.equal(recent.recent, true)
  assert.deepEqual(recent.groups.map(g => g.type), ['todos', 'topics', 'projects', 'memories'])
  const t = recent.groups[0].items
  assert.ok(t.length > 0)
  for (let i = 1; i < t.length; i++) assert.ok(t[i - 1].updatedAt >= t[i].updatedAt, 'recent todos newest first')
  const blank = db.searchWorkspace(U, PF, { query: '   \t ' })
  assert.equal(blank.total, 0)
  assert.ok(blank.groups.every(g => g.items.length === 0))
  const long = db.searchWorkspace(U, PF, { query: '跨'.repeat(5000) })
  assert.equal(long.truncated, true)
  assert.equal(long.query.length, 200)
  const none = db.searchWorkspace(U, PF, { query: '完全不存在的词组xyz' })
  assert.equal(none.total, 0)
  assert.equal(none.hasMore, false)
  for (const r of [recent, blank, long, none]) assert.doesNotThrow(() => validateModel(contract, 'searchWorkspaceOutput', r))
})

test('#98 unit: limit / hasMore / hard cap 100 / scope all totals at most 50', () => {
  const { db, p1 } = seed()
  for (let i = 0; i < 130; i++) db.createTodo(U, PF, { projectId: p1.id, title: `批量卡 ${i}` })
  const r10 = S1(db, '批量卡', { limit: 10 })
  assert.equal(r10.groups[0].items.length, 10)
  assert.equal(r10.groups[0].total, 130)
  assert.equal(r10.groups[0].hasMore, true)
  assert.equal(r10.hasMore, true)
  const rMax = db.searchWorkspace(U, PF, { query: '批量卡', scope: 'todos', limit: 5000 })
  assert.equal(rMax.groups[0].items.length, 100, 'hard cap 100')
  const all = db.searchWorkspace(U, PF, { query: '批量卡' })
  assert.ok(all.groups.reduce((n, g) => n + g.items.length, 0) <= 50)
  assert.equal(all.groups[0].items.length, 20, 'default 20 per group')
  assert.throws(() => validateModel(contract, 'searchWorkspaceInput', { query: 'x', limit: 101 }), 'contract rejects limit > 100')
})

test('#98 unit: ranking exact title > prefix > substring > number > spec > timeline > chat, ties newest first', async () => {
  const { db, p1 } = seed()
  const mk = (title, patch) => { const t = db.createTodo(U, PF, { projectId: p1.id, title }); if (patch) db.updateTodo(U, PF, t.id, patch); return t }
  const chat = mk('甲 c', { buildChat: [{ role: 'agent', text: '含有 星辰 的对话' }] })
  const tl = mk('甲 t', { timeline: [{ time: 1, event: '时间线 星辰', actor: 's' }] })
  const spec = mk('甲 s', { spec: '任务书里 星辰 出现' })
  const sub = mk('关于星辰的卡')
  const prefix = mk('星辰大海')
  const exact = mk('星辰')
  const order = hits(db, '星辰').map(i => i.id)
  assert.deepEqual(order, [exact.id, prefix.id, sub.id, spec.id, tl.id, chat.id])
  assert.deepEqual(hits(db, '星辰').map(i => i.matchedField), ['title_exact', 'title_prefix', 'title', 'spec', 'timeline', 'chat'])
  // Same score: newest update first.
  const a = mk('同分 卡 A')
  const b = mk('同分 卡 B')
  await new Promise(r => setTimeout(r, 5))
  db.updateTodo(U, PF, a.id, { title: '同分 卡 A' })
  const same = hits(db, '同分').map(i => i.id)
  assert.equal(same[0], a.id, 'most recently updated first among equal scores')
  assert.ok(same.includes(b.id))
})

test('#98 unit: every remembered field is searchable and shows why it matched', () => {
  const { db, cards, topic } = seed()
  const why = q => { const h = hits(db, q); return h.length ? [h[0].number, h[0].matchedField, h[0].snippet] : null }
  assert.deepEqual(why('琥珀色')?.slice(0, 2), [cards.spec.number, 'spec'])
  assert.match(why('琥珀色')[2], /琥珀色按钮/)
  assert.deepEqual(why('青柠')?.slice(0, 2), [cards.timeline.number, 'timeline'])
  assert.deepEqual(why('独角鲸')?.slice(0, 2), [cards.chat.number, 'chat'])
  assert.deepEqual(why('narwhal')?.slice(0, 2), [cards.branch.number, 'branch'])
  assert.deepEqual(why('前端')?.slice(0, 2), [cards.tags.number, 'tags'])
  assert.deepEqual(why('搜索专员')?.slice(0, 2), [cards.agent.number, 'agent'])
  assert.deepEqual(why('会展排期')?.slice(0, 2), [cards.topic.number, 'topic'])
  assert.ok(hits(db, '工作台').every(i => i.matchedField === 'project'), 'project alias')
  // Multi-term: every term somewhere, ranked as terms.
  const multi = hits(db, '普通卡片甲 琥珀')
  assert.equal(multi[0].number, cards.spec.number)
  assert.equal(multi[0].matchedField, 'terms')
  const inTitle = hits(db, '卡片甲 普通')
  assert.equal(inTitle[0].number, cards.spec.number)
  assert.equal(inTitle[0].matchedField, 'title_terms', 'every term in the title ranks as a title hit')
  assert.equal(inTitle[0].score, S.title_terms)
  // Topics: title, brief, messages. Projects: name, alias, repo. Memories: title, content, scope filter.
  db.updateTopic(U, PF, topic.id, { brief: { goal: '目标是减少串台', progress: '', next: '' } })
  db.addTopicMessage(U, PF, topic.id, { kind: 'user', text: '我在对话里说过 蜂鸟计划 这个词' })
  const t1 = db.searchWorkspace(U, PF, { query: '减少串台', scope: 'topics' }).groups[0].items[0]
  assert.equal(t1?.matchedField, 'brief_goal')
  const t2 = db.searchWorkspace(U, PF, { query: '蜂鸟计划', scope: 'topics' }).groups[0].items[0]
  assert.equal(t2?.matchedField, 'messages')
  assert.match(t2.snippet, /蜂鸟计划/)
  assert.equal(db.searchWorkspace(U, PF, { query: 'acme/zen', scope: 'projects' }).groups[0].items[0]?.matchedField, 'repo')
  assert.equal(db.searchWorkspace(U, PF, { query: '工作台', scope: 'projects' }).groups[0].items[0]?.matchedField, 'title_exact')
  db.upsertMemory(U, PF, { scope: 'chief', category: 'pitfall', title: '合并前先拉主干', content: '否则 dist 冲突会让卡片返工' })
  db.upsertMemory(U, PF, { scope: 'agent', category: 'pitfall', title: '另一条', content: 'dist 冲突也写在这' })
  const mem = db.searchWorkspace(U, PF, { query: 'dist 冲突', scope: 'memories' }).groups[0]
  assert.equal(mem.total, 2)
  assert.equal(mem.items[0].matchedField, 'content')
  assert.equal(db.searchWorkspace(U, PF, { query: 'dist 冲突', scope: 'memories', memoryScope: 'chief' }).groups[0].total, 1)
  assert.equal(db.listMemories(U, PF, { query: '冲突 返工' }).length, 1, 'listMemories uses the same rule (multi-term)')
})

test('#98 unit: snippets are short windows, never the whole body', () => {
  const { db, p1 } = seed()
  const body = `${'前'.repeat(5000)}关键片段${'后'.repeat(5000)}`
  const t = db.createTodo(U, PF, { projectId: p1.id, title: '长任务书' })
  db.updateTodo(U, PF, t.id, { spec: body, timeline: [{ time: 1, event: body.slice(0, 3000), actor: 's' }] })
  const h = hits(db, '关键片段')[0]
  assert.equal(h.matchedField, 'spec')
  assert.ok(h.snippet.length < 140, `snippet ${h.snippet.length} chars`)
  assert.match(h.snippet, /^…前+关键片段后+…$/)
  assert.ok(JSON.stringify(db.searchWorkspace(U, PF, { query: '关键片段' })).length < 4000)
})

test('#98 unit: identity and project scope never leak', () => {
  const { db, cards, p2 } = seed()
  assert.equal(db.searchWorkspace(U, 'other', { query: '跨项目' }).total, 0, 'other profile sees nothing')
  assert.equal(db.searchWorkspace(2, PF, { query: '跨项目' }).total, 0, 'other user sees nothing')
  const scoped = S1(db, '卡', { projectId: p2.id })
  assert.deepEqual(scoped.groups[0].items.map(i => i.id), [cards.other.id])
  assert.ok(hits(db, '卡').some(i => i.id === cards.other.id), 'unscoped search includes it')
})

test('#98 unit: highlight / snippet helpers handle Chinese and special characters', () => {
  assert.deepEqual(highlightSegments('修复跨项目串台', '跨项目'), [{ text: '修复', hit: false }, { text: '跨项目', hit: true }, { text: '串台', hit: false }])
  assert.deepEqual(highlightSegments('a.b*c', '.b*'), [{ text: 'a', hit: false }, { text: '.b*', hit: true }, { text: 'c', hit: false }])
  assert.deepEqual(highlightSegments('Watchdog 收紧', 'WATCH').filter(s => s.hit).map(s => s.text), ['Watch'])
  assert.equal(highlightSegments('看板与搜索', '看板 搜索').filter(s => s.hit).length, 2, 'each term highlighted')
  assert.equal(normalizeSearchQuery('  多  空格 \n'), '多 空格')
  assert.equal(matchesQuery(['修复看板的搜索'], '看板 搜索'), true)
  assert.equal(matchesQuery(['修复看板'], '看板 搜索'), false)
  assert.equal(makeSnippet('abc', 'zz'), 'abc')
})

// ── Integration ──────────────────────────────────────────────────────────────

test('#98 integration: the palette search finds cards after the 12th (regression of slice-before-filter)', async () => {
  const { db, dir, p1 } = seed()
  const made = []
  for (let i = 0; i < 40; i++) made.push(db.createTodo(U, PF, { projectId: p1.id, title: `回归卡 ${String(i).padStart(2, '0')} 编号${i}` }))
  const orch = createOrchestrator({ db, dataDir: join(dir, 'data'), config: {}, log: { warn() {}, info() {}, error() {} }, settleDelaysMs: [0, 0, 0, 0] })
  const run = { identity: { userId: U, profile: PF }, signal: new AbortController().signal, host: {} }
  for (const i of [13, 25, 39]) {
    const r = await orch.searchWorkspace(run, { query: `编号${i}`, scope: 'todos' })
    assert.deepEqual(r.groups[0].items.map(x => x.id), [made[i].id], `card #${i + 1} of 40 found`)
    assert.doesNotThrow(() => validateModel(contract, 'searchWorkspaceOutput', r))
  }
  // The local fallback (same shape) over a snapshot of 40 cards also finds the 40th.
  const state = { todos: db.listTodos(U, PF), topics: [], projects: db.listProjects(U, PF), agents: [], memories: [] }
  assert.equal(localWorkspaceSearch(state, { query: '编号39', scope: 'todos' }).groups[0].items[0]?.id, made[39].id)
  // And the palette no longer slices the lists before filtering, nor lets cmdk re-filter server hits.
  const palette = src('src/client/components/CommandPalette.jsx')
  assert.equal(/state\.(todos|topics)[^\n]*\.slice\(/.test(palette), false, 'no state.todos/topics.slice(...) in the palette')
  assert.match(palette, /shouldFilter=\{false\}/)
  assert.match(palette, /onSearch/)
  assert.match(src('src/client/App.jsx'), /ctx\.rpc\.call\('search-workspace', input\)/)
  assert.ok(contract.rpc['search-workspace'], 'search-workspace declared in the contract')
  assert.match(src('src/server/rpc-handlers.mjs'), /'search-workspace'/)
})

test('#98 integration: a stubbed card (spec cut from the snapshot) is still found by its spec', () => {
  const { db, p1 } = seed()
  const t = db.createTodo(U, PF, { projectId: p1.id, title: '被降级的卡' })
  db.updateTodo(U, PF, t.id, { phase: 'done', spec: `只在任务书里的词：珊瑚礁 ${'x'.repeat(30000)}` })
  const stub = fitSnapshotBudget({ todos: [db.getTodo(U, PF, t.id)] }, 2000).todos[0]
  assert.equal(stub.stubbed, true)
  assert.equal(stub.spec, '')
  assert.equal(matchesQuery(todoSearchFields(stub), '珊瑚礁'), false, 'the board alone cannot see it')
  assert.deepEqual(hits(db, '珊瑚礁').map(i => i.id), [t.id], 'the server finds it')
})

test('#98 integration: board filter fields agree with the RPC on loaded cards', () => {
  const { db, agent, topic } = seed()
  const todos = db.listTodos(U, PF)
  const projects = db.listProjects(U, PF)
  const agents = [agent]
  const topics = [topic]
  const fieldsOf = td => {
    const p = projects.find(x => x.id === td.projectId)
    return todoSearchFields(td, {
      agentName: agents.find(a => a.id === td.agentId)?.name || '',
      projectLabel: p ? `${p.name} ${p.displayName}` : '',
      topicTitle: topics.find(x => x.id === td.topicId)?.title || '',
    })
  }
  // Chat is server-only (the board keeps no chat text per card), so 独角鲸 is excluded here.
  for (const q of ['跨项目', 'WATCHDOG', '琥珀色', '青柠', 'narwhal', '前端', '搜索专员', '会展排期', '工作台', '%', '_', '\\', '普通卡片 琥珀', '#3', '不存在']) {
    const local = todos.filter(td => matchesQuery(fieldsOf(td), q)).map(td => td.id).sort()
    const server = hits(db, q, { limit: 100 }).map(i => i.id).sort()
    if (q === '#3') {
      // '#3' as a substring also hits cards whose number starts with 3; the exact card must be in both.
      const n3 = todos.find(td => td.number === 3)?.id
      assert.ok(local.includes(n3) && server.includes(n3), '#3 in both')
      continue
    }
    assert.deepEqual(local, server, `same cards for ${q}`)
  }
  const kanban = src('src/client/components/KanbanBoard.jsx')
  assert.match(kanban, /useWorkspaceSearch\(onSearch, \{[\s\S]*?scope: 'todos'/)
  assert.match(kanban, /todoSearchFields\(td/)
  assert.equal(/`#\$\{td\.number\} \$\{td\.title \|\| ''\} \$\{td\.spec \|\| ''\}`/.test(kanban), false, 'old title+spec-only haystack removed')
})

test('#98 integration: project workspace searches its own project only; branches by number, author, date', () => {
  const ws = src('src/client/components/ProjectWorkspace.jsx')
  assert.match(ws, /scope: 'todos',\s*\n\s*projectId: project\?\.id/)
  assert.match(ws, /h\.projectId === project\?\.id/, 'server hits of other projects are ignored')
  assert.match(ws, /b\.author/)
  assert.match(ws, /day\(b\.committedAt\)/)
  assert.match(src('src/server/git-engine.mjs'), /%\(authorname\)/)
})

// Todo #112: the branch annotation is called, not read. Two projects, each with its own repository; both
// repositories have a branch of the same name (a worktree branch name is only unique inside one project).
function gitRepo(dir, branches) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  mkdirSync(dir, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=Tester', '-c', 'user.email=tester@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init')
  for (const b of branches) git('branch', b)
}
function twoProjects() {
  const { db, dir } = fresh()
  const repoA = join(dir, 'repo-a')
  const repoB = join(dir, 'repo-b')
  gitRepo(repoA, ['feature/shared', 'feature/a-only', 'feature/claimed-by-b', 'feature/no-card'])
  gitRepo(repoB, ['feature/shared', 'feature/claimed-by-b'])
  const pA = db.createProject(U, PF, { name: 'proj-a', repoPath: repoA, defaultBranch: 'main' })
  const pB = db.createProject(U, PF, { name: 'proj-b', repoPath: repoB, defaultBranch: 'main' })
  const card = (projectId, title, branch) => {
    const t = db.createTodo(U, PF, { projectId, title })
    db.updateTodo(U, PF, t.id, { branch })
    return db.getTodo(U, PF, t.id)
  }
  // Creation order alternates so neither "first wins" nor "last wins" hides a card of the other project.
  const cards = {
    aShared: card(pA.id, 'A 的共享名分支卡', 'feature/shared'),
    bShared: card(pB.id, 'B 的共享名分支卡', 'feature/shared'),
    bClaimed: card(pB.id, 'B 独占的分支卡', 'feature/claimed-by-b'),
    aOnly: card(pA.id, 'A 独有分支卡', 'feature/a-only'),
  }
  const orch = createOrchestrator({ db, dataDir: join(dir, 'data'), config: {}, log: { warn() {}, info() {}, error() {} }, settleDelaysMs: [0, 0, 0, 0] })
  const run = { identity: { userId: U, profile: PF }, signal: new AbortController().signal, host: {} }
  const annotated = async projectId => {
    const out = await orch.browseProjectBranches(run, { projectId })
    return Object.fromEntries(out.branches.map(b => [b.name, { id: b.todoId, number: b.todoNumber, title: b.todoTitle }]))
  }
  return { db, pA, pB, cards, annotated }
}

test('#98 (#112) behaviour: a project\'s branches are never annotated with a card of another project', async () => {
  const { pA, pB, cards, annotated } = twoProjects()
  const a = await annotated(pA.id)
  const foreign = new Set([cards.bShared.id, cards.bClaimed.id])
  assert.deepEqual(Object.values(a).filter(x => foreign.has(x.id)), [], 'no branch of project A carries a card of project B')
  assert.equal(a['feature/shared'].id, cards.aShared.id, 'a branch name used by both projects shows A\'s own card')
  assert.deepEqual(a['feature/claimed-by-b'], { id: '', number: 0, title: '' }, 'a branch only B\'s card names stays unannotated in A')
  // And the same from the other side.
  const b = await annotated(pB.id)
  const foreignB = new Set([cards.aShared.id, cards.aOnly.id])
  assert.deepEqual(Object.values(b).filter(x => foreignB.has(x.id)), [])
  assert.equal(b['feature/shared'].id, cards.bShared.id)
  assert.equal(b['feature/claimed-by-b'].id, cards.bClaimed.id)
})

test('#98 (#112) control: every card of the project annotates its own branch, with number and title', async () => {
  const { pA, cards, annotated } = twoProjects()
  const a = await annotated(pA.id)
  assert.deepEqual(a['feature/shared'], { id: cards.aShared.id, number: cards.aShared.number, title: 'A 的共享名分支卡' })
  assert.deepEqual(a['feature/a-only'], { id: cards.aOnly.id, number: cards.aOnly.number, title: 'A 独有分支卡' })
  assert.deepEqual(a['feature/no-card'], { id: '', number: 0, title: '' }, 'a branch without a card has no annotation')
  assert.deepEqual(a.main, { id: '', number: 0, title: '' })
  assert.deepEqual(Object.values(a).map(x => x.id).filter(Boolean).sort(), [cards.aShared.id, cards.aOnly.id].sort(), 'exactly the two cards of A')
})

test('#98 integration: IME composition sends nothing; debounce collapses keystrokes; stale answers are dropped', async () => {
  const calls = []
  const states = []
  const timers = []
  let state = {}
  const runner = createSearchRunner({
    call: input => new Promise(res => calls.push({ input, res })),
    onState: s => { state = typeof s === 'function' ? s(state) : s; states.push(state.status) },
    schedule: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t },
    cancel: t => { t.live = false },
  })
  const flush = () => { for (const t of timers.splice(0)) if (t.live) t.fn() }
  const input = q => ({ query: q, scope: 'todos' })
  // Composition: 「kua」→「跨」 while composing → no timer, no call.
  runner.update({ query: 'k', paused: true, input: input('k') })
  runner.update({ query: 'kua', paused: true, input: input('kua') })
  flush()
  assert.equal(calls.length, 0, 'nothing sent during IME composition')
  // Composition ends → one debounced call with the final text.
  runner.update({ query: '跨', input: input('跨') })
  runner.update({ query: '跨项', input: input('跨项') })
  runner.update({ query: '跨项目', input: input('跨项目') })
  assert.equal(timers.filter(t => t.live).length, 1, 'only the last keystroke has a live timer')
  assert.equal(timers.at(-1).ms, 300)
  flush()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(calls.map(c => c.input.query), ['跨项目'])
  // A newer request starts before the old one answers → the old answer is ignored.
  runner.update({ query: '跨项目串台', input: input('跨项目串台') })
  flush()
  await new Promise(r => setImmediate(r))
  calls[0].res({ query: '跨项目', groups: [] })
  await new Promise(r => setImmediate(r))
  assert.notEqual(state.query, '跨项目', 'stale answer dropped')
  calls[1].res({ query: '跨项目串台', groups: [] })
  await new Promise(r => setImmediate(r))
  assert.equal(state.status, 'ready')
  assert.equal(state.query, '跨项目串台')
  const palette = src('src/client/components/CommandPalette.jsx')
  assert.match(palette, /onCompositionStart=\{\(\) => \{ composingRef\.current = true; setComposing\(true\) \}\}/)
  assert.match(palette, /paused: composing/)
  assert.match(palette, /isImeComposingEvent\(e, composingRef, compEndRef\)\) e\.preventDefault\(\)/)
})

// ── Performance ──────────────────────────────────────────────────────────────
//
// The gate asserts structure, not wall-clock luck. Main assertions (deterministic, independent of CPU load):
//   - one SQL statement per searched group (4 for scope all, 1 per single scope), whatever the board size —
//     so no N+1 and no per-row queries;
//   - EXPLAIN QUERY PLAN of every statement the search actually ran (captured from node:sqlite, same SQL and
//     parameters) reaches its base table through the (user_id, profile) scope index and never full-scans a
//     table (`SCAN t` / `SCAN todos` / …). The only SCANs allowed are json_each (per matched row), the CTEs
//     and subqueries the statement builds itself.
// Timing is only a loose fallback against a catastrophic regression: 20 untimed warm-up searches, then ONE
// pass of 30 timed searches, p95 < 1000 ms. Idle p95 is ~30 ms (see the delivery report), so the bound is
// ~30x idle and still holds with the whole test suite and a busy-loop running alongside.

const PERF_QUERIES = ['性能卡 5', '修复看板', '#500', '任务书 777', '第999卡事件9', '第3卡汇报2', '不存在的词', 'perf-42', '说明文字', '构建 通过']
const PERF_P95_LIMIT_MS = 1000
let perfBoard = null
function perfFixture() {
  if (perfBoard) return perfBoard
  const { db, dir } = fresh()
  const p = db.createProject(U, PF, { name: 'perf', repoPath: '/tmp/perf' })
  db.createTopic(U, PF, { title: '性能话题', projectId: p.id })
  db.upsertMemory(U, PF, { scope: 'chief', category: 'pitfall', title: '性能记忆', content: '修复看板' })
  // Bulk insert straight into SQLite (createTodo per card would dominate the test time).
  const raw = new DatabaseSync(join(dir, 'data', 'ekko-todo.sqlite'))
  const ins = raw.prepare(`INSERT INTO todos (id, user_id, profile, project_id, number, title, spec, timeline_json, build_chat_json, tags_json, branch, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  raw.exec('BEGIN')
  for (let i = 0; i < 1000; i++) {
    const timeline = Array.from({ length: 10 }, (_, k) => ({ time: k, event: `第${i}卡事件${k} 构建通过 ${'记录'.repeat(20)}`, actor: 'system' }))
    const chat = Array.from({ length: 4 }, (_, k) => ({ role: 'agent', text: `第${i}卡汇报${k} ${'内容'.repeat(200)}` }))
    ins.run(`perf-${i}`, U, PF, p.id, i + 1, `性能卡 ${i} 修复看板`, `任务书 ${i} ${'说明文字'.repeat(300)}`, JSON.stringify(timeline), JSON.stringify(chat), '["perf"]', `ekko/perf-${i}`, i, 1_000_000 + i)
  }
  raw.exec('COMMIT')
  perfBoard = { db, raw }
  return perfBoard
}

// Every statement run while `fn` executes: { sql, params, method }.
function captureStatements(fn) {
  const seen = []
  const methods = ['all', 'get', 'iterate', 'run']
  const orig = Object.fromEntries(methods.map(m => [m, StatementSync.prototype[m]]))
  for (const m of methods) {
    StatementSync.prototype[m] = function (...args) {
      seen.push({ sql: this.sourceSQL, params: args[0], method: m })
      return orig[m].apply(this, args)
    }
  }
  try { fn() } finally { for (const m of methods) StatementSync.prototype[m] = orig[m] }
  return seen
}

const BASE_TABLES = { todos: ['t', 'idx_todos_scope'], topics: ['tp', 'idx_topics_scope'], projects: ['p', 'idx_projects_scope'], memories: ['m', 'idx_memories_scope'] }

test('#98 performance (structural): 1000 cards + 10000 timeline rows — one statement per group, scope index, no table scan', () => {
  const { db, raw } = perfFixture()
  assert.equal(raw.prepare('SELECT count(*) AS n FROM todos t, json_each(t.timeline_json)').get().n, 10000, '10000 timeline rows')
  assert.equal(raw.prepare('SELECT count(*) AS n FROM todos').get().n, 1000, '1000 cards')
  let printed = false
  const counts = []
  for (const scope of ['all', 'todos', 'topics', 'projects', 'memories']) {
    const groups = scope === 'all' ? Object.keys(BASE_TABLES) : [scope]
    for (const query of [...PERF_QUERIES, '']) {
      let res
      const stmts = captureStatements(() => { res = db.searchWorkspace(U, PF, { query, scope }) })
      assert.equal(res.groups.length, groups.length)
      counts.push(`${scope}:${stmts.length}`)
      assert.equal(stmts.length, groups.length, `${scope} "${query}": ${stmts.length} statements for ${groups.length} groups (no N+1)`)
      assert.ok(stmts.every(s => s.method === 'all'), 'one .all() per group, no per-row get()')
      stmts.forEach((s, k) => {
        const [alias, index] = BASE_TABLES[groups[k]]
        const plan = raw.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(s.params || {}).map(r => r.detail)
        if (!printed && groups[k] === 'todos' && query === '修复看板') {
          console.log(`[#98 EXPLAIN QUERY PLAN todos "${query}"]\n  ${plan.join('\n  ')}`)
          printed = true
        }
        assert.ok(plan.some(d => d.startsWith(`SEARCH ${alias} USING INDEX ${index} (user_id=? AND profile=?)`)), `${groups[k]} base rows via ${index}: ${plan.join(' | ')}`)
        const scans = plan.filter(d => /^SCAN /.test(d))
        const tableScans = scans.filter(d => !/^SCAN (json_each VIRTUAL TABLE|base\b|top\b|\(subquery-\d+\))/.test(d))
        assert.deepEqual(tableScans, [], `${groups[k]} "${query}": no full table scan`)
      })
    }
  }
  const per = {}
  for (const c of counts) { const [s, n] = c.split(':'); per[s] = [...new Set([...(per[s] || []), Number(n)])] }
  console.log(`[#98 SQL count] ${counts.length} searches; statements per search by scope: ${Object.entries(per).map(([s, n]) => `${s}=${n.join('/')}`).join(' ')}`)
})

test('#98 performance (timing fallback): 20 warm-up, then one pass of 30 searches, p95 < 1000 ms', () => {
  const { db } = perfFixture()
  for (let k = 0; k < 20; k++) db.searchWorkspace(U, PF, { query: PERF_QUERIES[k % PERF_QUERIES.length] })
  const times = []
  for (let k = 0; k < 30; k++) {
    const t0 = performance.now()
    db.searchWorkspace(U, PF, { query: PERF_QUERIES[k % PERF_QUERIES.length] })
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length * 0.5)]
  const p95 = times[Math.ceil(times.length * 0.95) - 1]
  console.log(`[#98 perf] n=30 (after 20 warm-up) p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${times.at(-1).toFixed(1)}ms limit=${PERF_P95_LIMIT_MS}ms`)
  assert.ok(p95 < PERF_P95_LIMIT_MS, `p95 ${p95.toFixed(1)} ms`)
  // Correctness at scale: a timeline-only word of the last card, and a chat-only word.
  assert.equal(hits(db, '第999卡事件9')[0]?.id, 'perf-999')
  assert.equal(hits(db, '第999卡事件9')[0]?.matchedField, 'timeline')
  assert.equal(hits(db, '第3卡汇报2')[0]?.matchedField, 'chat')
})

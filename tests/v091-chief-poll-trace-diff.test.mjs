// Regression tests for v0.9.1: Chief busy-poll guard, run-start timeout recovery, session trace & diff parsing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { buildChiefInstructions } from '../src/server/prompts.mjs'
import { parseDiffHunk } from '../src/client/diff-parse.js'

function makeFakeHost({ runImpl } = {}) {
  let seq = 0
  const sessions = new Map()
  const stopped = []
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input, options) {
        const s = sessions.get(id)
        if (runImpl) return runImpl(s, id, input, options)
        if (s) s.is_running = true
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { stopped.push(id); const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: { ...s, model: 'deepseek-flash', provider: 'deepseek', input_tokens: 1200, output_tokens: 300 }, is_running: s.is_running } : null },
      async messages(id, opts = {}) {
        const s = sessions.get(id)
        const list = s?.messages || []
        return { messages: opts.limit ? list.slice(-opts.limit) : list }
      },
    },
  }
  return { host, sessions, stopped }
}

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
  g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
  return repoPath
}

function setup(fakeOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-v091-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 2 })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 2 }, log: { warn() {}, info() {} } })
  const fake = makeFakeHost(fakeOpts)
  const run = { identity: { userId: 1, profile: 'default' }, host: fake.host, messages: { emit() {} } }
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  return { root, db, orch, fake, run, cleanup: () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) } }
}

test('v0.9.1: Chief busy-poll (sleep / direct sqlite reads) is warned once then the turn is stopped and todos are watched', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run, root } = ctx
    // 0.9.54: with strict orchestration on, any Chief terminal call is refused outright by the chief guard.
    // The busy-poll heuristics below are what still applies when the user turns strict orchestration off.
    db.updateSettings(1, 'default', { chiefStrictOrchestration: false })
    const repoPath = makeRepo(root)
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    const { topic } = await orch.createTopic(run, { projectId: project.id })
    const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: '长任务' })
    fake.sessions.set('sess-chief', {
      id: 'sess-chief',
      is_running: true,
      messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: JSON.stringify({ command: "sleep 240; python3 - <<'PY'\nsqlite3.connect('ekko-todo.sqlite')\nPY" }) } }], timestamp: Math.floor(Date.now() / 1000) }],
    })
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: 'sess-chief', isRunning: true })

    const ev = { type: 'chat.tool.started', subject: { session_id: 'sess-chief' }, summary: { tool_name: 'terminal' } }
    // Topic has an unfinished todo, so the first sleep ends the turn at once and the todo is watched
    await orch.handleHostEvent(ev, run)
    let t = db.getTopic(1, 'default', topic.id)
    assert.equal(t.isRunning, false, 'pending todo: first sleep stops the turn')
    assert.deepEqual(fake.stopped, ['sess-chief'])
    assert.ok(t.messages.some(m => m.kind === 'system' && /自动结束大总管的轮询等待/.test(m.text)))
    assert.ok(db.getActiveWatchesForTodo(1, 'default', todo.id).some(w => w.topicId === topic.id), 'todo auto-watched for wake')

    // One-off reads (worktree git/grep, a single sqlite query) are not busy-waits
    db.updateTopic(1, 'default', topic.id, { isRunning: true })
    db.addTopicMessage(1, 'default', topic.id, { kind: 'system', text: '关注的任务有进展：#1' })
    fake.stopped.length = 0
    for (const command of [
      'cd ~/.hermes-web-ui/plugins/global/plugin-data/ekko-todo/worktrees/p-2 && git log --oneline -3 && grep -n gold a.css',
      "cd ~/.hermes-web-ui/plugins/global/plugin-data/ekko-todo && python3 -c 'import sqlite3; sqlite3.connect(\"ekko-todo.sqlite\")'",
    ]) {
      fake.sessions.get('sess-chief').messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'c3', function: { name: 'terminal', arguments: JSON.stringify({ command }) } }] }]
      await orch.handleHostEvent(ev, run)
    }
    assert.deepEqual(fake.stopped, [])
    assert.equal(db.getTopic(1, 'default', topic.id).isRunning, true)

    // With no unfinished todos: first sleep only warns; a second one (even a short sleep loop) stops.
    db.updateTodo(1, 'default', todo.id, { phase: 'done' })
    fake.sessions.get('sess-chief').messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'c4', function: { name: 'terminal', arguments: JSON.stringify({ command: 'sleep 60' }) } }] }]
    await orch.handleHostEvent(ev, run)
    assert.deepEqual(fake.stopped, [], 'no pending todo: first strike only warns')
    assert.ok(db.getTopic(1, 'default', topic.id).messages.at(-1).text.startsWith('⚠️ 大总管正在轮询等待'))
    // Strikes survive plugin reloads within the same turn
    const orch2 = createOrchestrator({ db, dataDir: join(root, 'data'), config: { maxConcurrentBuilds: 2 }, log: { warn() {}, info() {} } })
    fake.sessions.get('sess-chief').messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'c5', function: { name: 'terminal', arguments: JSON.stringify({ command: 'while true; do git log -1; sleep 5; done' }) } }] }]
    await orch2.handleHostEvent(ev, run)
    assert.deepEqual(fake.stopped, ['sess-chief'], 'second strike after reload stops')

    // A new turn resets the count: first poll only warns
    db.updateTopic(1, 'default', topic.id, { isRunning: true })
    db.addTopicMessage(1, 'default', topic.id, { kind: 'human', text: '继续' })
    fake.stopped.length = 0
    await orch2.handleHostEvent(ev, run)
    assert.deepEqual(fake.stopped, [], 'old warnings from a previous turn do not stop a fresh turn')

    // Normal short commands are never flagged
    fake.sessions.get('sess-chief').messages = [{ role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'terminal', arguments: JSON.stringify({ command: 'git status && sleep 2' }) } }] }]
    db.updateTopic(1, 'default', topic.id, { isRunning: true })
    await orch.handleHostEvent({ ...ev, subject: { session_id: 'sess-chief' } }, run)
    assert.equal(db.getTopic(1, 'default', topic.id).isRunning, true)
  } finally { ctx.cleanup() }
})

test('v0.9.1: Chief prompt forbids busy-waiting and tells the Chief to end its turn after dispatch', () => {
  const src = readFileSync(new URL('../src/server/prompts.mjs', import.meta.url), 'utf8')
  assert.match(src, /NEVER busy-wait/)
  assert.match(src, /END your turn/)
  assert.equal(typeof buildChiefInstructions, 'function')
})

test('v0.9.1: a run-start client timeout is recovered when the host session is actually working (no false "failed")', async () => {
  const ctx = setup({
    runImpl(s) {
      if (s) s.is_running = true
      throw new Error('The operation was aborted due to timeout')
    },
  })
  try {
    const { db, orch, run, root } = ctx
    const repoPath = makeRepo(root)
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    const { todo } = await orch.createTodo(run, { projectId: project.id, title: 'T' })
    await orch.startBuild(run, { todoId: todo.id })
    const t = db.getTodo(1, 'default', todo.id)
    assert.equal(t.phase, 'building')
    assert.equal(t.lastError, '')
    assert.ok(!t.timeline.some(e => /启动失败/.test(e.event)))
  } finally { ctx.cleanup() }
})

test('v0.9.1: a genuine run-start timeout (session idle) still fails cleanly', async () => {
  const ctx = setup({ runImpl() { throw new Error('The operation was aborted due to timeout') } })
  try {
    const { db, orch, run, root } = ctx
    const repoPath = makeRepo(root)
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    const { todo } = await orch.createTodo(run, { projectId: project.id, title: 'T' })
    await assert.rejects(orch.startBuild(run, { todoId: todo.id }))
    assert.notEqual(db.getTodo(1, 'default', todo.id).phase, 'building')
  } finally { ctx.cleanup() }
})

test('v0.9.1: session trace lists only owned sessions and pairs tool calls with results, durations and failures', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run, root } = ctx
    const repoPath = makeRepo(root)
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    const { topic } = await orch.createTopic(run, { projectId: project.id })
    const t0 = Math.floor(Date.now() / 1000) - 100
    fake.sessions.set('sess-chief', {
      id: 'sess-chief',
      is_running: false,
      messages: [
        { role: 'user', content: '做人生K线', timestamp: t0 },
        { role: 'assistant', content: '', reasoning_content: '先看看仓库', tool_calls: [{ id: 'a', function: { name: 'list_todos', arguments: '{"project_id":"p1"}' } }, { id: 'b', function: { name: 'terminal', arguments: '{"command":"false"}' } }], timestamp: t0 + 5 },
        { role: 'tool', tool_call_id: 'a', content: '[]', timestamp: t0 + 7 },
        { role: 'tool', tool_call_id: 'b', content: '{"output":"","exit_code":1}', timestamp: t0 + 9 },
        { role: 'assistant', content: '已派发 #2', token_count: 42, timestamp: t0 + 60 },
      ],
    })
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: 'sess-chief' })

    const list = await orch.getSessionTrace(run, {})
    assert.equal(list.trace, null)
    assert.ok(list.sessions.some(s => s.sessionId === 'sess-chief' && s.kind === 'chief'))
    await assert.rejects(orch.getSessionTrace(run, { sessionId: 'someone-elses-session' }), /只能查看/)

    const { trace } = await orch.getSessionTrace(run, { sessionId: 'sess-chief' })
    assert.equal(trace.model, 'deepseek-flash')
    assert.equal(trace.toolCalls, 2)
    assert.equal(trace.toolErrors, 1)
    const kinds = trace.steps.map(s => s.kind)
    assert.deepEqual(kinds, ['user', 'reasoning', 'tool', 'tool', 'assistant'])
    const [okTool, badTool] = trace.steps.filter(s => s.kind === 'tool')
    assert.equal(okTool.name, 'list_todos')
    assert.equal(okTool.durationSec, 2)
    assert.equal(okTool.failed, false)
    assert.match(okTool.args.text, /"project_id": "p1"/)
    assert.equal(badTool.failed, true)
    assert.equal(trace.steps.at(-1).gapSec, 51)
  } finally { ctx.cleanup() }
})

test('v0.9.1: diff hunks parse into old/new line numbers with hunk headers and truncation notes', () => {
  const rows = parseDiffHunk('@@ -3,3 +3,4 @@ def main():\n ctx\n-old\n+new\n+extra\n ctx2\n... (12 more lines truncated)')
  assert.deepEqual(rows.map(r => r.type), ['hunk', 'ctx', 'del', 'add', 'add', 'ctx', 'note'])
  assert.equal(rows[0].ctx, 'def main():')
  assert.deepEqual([rows[1].oldNo, rows[1].newNo], [3, 3])
  assert.deepEqual([rows[2].oldNo, rows[2].newNo], [4, null])
  assert.deepEqual([rows[3].oldNo, rows[3].newNo], [null, 4])
  assert.deepEqual([rows[5].oldNo, rows[5].newNo], [5, 6])
  assert.equal(rows[6].text, '其余 12 行已省略')
})

test('v0.9.1: brand palette tokens drive cards, AUTO pill and avatars (no gradients on cards, distinct AUTO on/off)', () => {
  const css = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8')
  for (const token of ['--ek-brand', '--ek-sage', '--ek-ochre', '--ek-brick', '--ek-wisteria', '--ek-teal', '--ek-slate', '--ek-auto-on']) {
    assert.match(css, new RegExp(`${token}:`), `palette token ${token}`)
  }
  const cardRules = css.split('\n').filter(l => /^\.ot-card--(doing|reviewing|failed|human|ready|chief|done) /.test(l))
  assert.ok(cardRules.length >= 7)
  for (const r of cardRules) assert.doesNotMatch(r, /gradient/, r)
  assert.match(css, /\.ot-auto-pill\.is-on \{[^}]*background: var\(--ot-bg-2\)[^}]*color: var\(--ek-brand\)[^}]*border: 1\.5px solid var\(--ek-brand\)/)
  assert.match(css, /\.ot-auto-pill \{[^}]*dashed/)
  const chat = readFileSync(new URL('../src/client/components/ChatPane.jsx', import.meta.url), 'utf8')
  assert.match(chat, /AUTO 开/)
  assert.match(chat, /AUTO 关/)
  const avatar = readFileSync(new URL('../src/client/components/AvatarKit.jsx', import.meta.url), 'utf8')
  assert.match(avatar, /'#d6e5f5', \/\/ 天青/)
})

test('v0.9.1: a Chief turn that ends on a tool result (model returned empty replies) posts a visible notice', async () => {
  const ctx = setup()
  const { db, orch, fake, run } = ctx
  try {
    const topic = db.createTopic(1, 'default', { title: 'T' })
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: 'sess-chief', isRunning: true })
    fake.sessions.set('sess-chief', { id: 'sess-chief', messages: [
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{"command":"git log -1"}' } }] },
      { role: 'tool', content: '{"output":"ok"}' },
    ] })
    await orch.handleHostEvent({ type: 'chat.run.completed', subject: { session_id: 'sess-chief' }, data: { model: 'deepseek-flash' } }, run)
    const msgs = db.getTopic(1, 'default', topic.id).messages
    assert.ok(msgs.some(m => m.kind === 'system' && /总管模型返回了空回复（deepseek-flash）/.test(m.text)))

    // A normal turn that ends with an assistant reply posts nothing
    const before = db.getTopic(1, 'default', topic.id).messages.length
    fake.sessions.get('sess-chief').messages.push({ role: 'assistant', content: '已派发，等待审查。' })
    await orch.handleHostEvent({ type: 'chat.run.completed', subject: { session_id: 'sess-chief' }, data: {} }, run)
    const after = db.getTopic(1, 'default', topic.id).messages
    assert.ok(!after.slice(before).some(m => /空回复/.test(m.text || '')))
  } finally { ctx.cleanup() }
})

test('v0.9.2: repo-mutation audit only blames the Chief for repos its own tool calls touched', async () => {
  const ctx = setup()
  const { db, orch, fake, run, root } = ctx
  try {
    const repoPath = makeRepo(root)
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    const { topic } = await orch.createTopic(run, { projectId: project.id })
    const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' })
    const turn = async (toolArgs, change) => {
      await orch.sendTopicMessage(run, { topicId: topic.id, text: '继续' })
      const sid = db.getTopic(1, 'default', topic.id).chiefSessionId
      const s = fake.sessions.get(sid)
      s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'terminal', arguments: JSON.stringify({ command: toolArgs }) } }] })
      s.messages.push({ role: 'tool', content: 'ok' })
      s.messages.push({ role: 'assistant', content: '完成' })
      change()
      await orch.handleHostEvent({ type: 'chat.run.completed', subject: { session_id: sid }, data: {} }, run)
      return db.getTopic(1, 'default', topic.id).messages.filter(m => /总管治理审计/.test(m.text || '')).length
    }
    // Someone else commits to the repo while the Chief only ran unrelated commands: no warning
    let n = 0
    n = await turn('git -C /tmp/other log -1', () => { writeFileSync(join(repoPath, 'b.txt'), 'x\n'); g('add', '.'); g('commit', '-m', 'user commit') })
    assert.equal(n, 0, 'user commit during Chief turn is not a Chief violation')
    // The Chief itself edits the repo: warning
    n = await turn(`cd ${repoPath} && echo y >> a.txt`, () => { writeFileSync(join(repoPath, 'a.txt'), 'changed\n') })
    assert.equal(n, 1, 'Chief touching the repo is flagged')
  } finally { ctx.cleanup() }
})

test('v0.9.6: run_build on a todo whose build session is still running re-attaches instead of double-dispatching', async () => {
  let runs = 0
  const ctx = setup({ runImpl(s) { runs += 1; if (s.is_running) throw new Error('The operation was aborted due to timeout'); s.is_running = true; return { run_id: `r${runs}` } } })
  try {
    const { db, orch, run, root } = ctx
    const repoPath = makeRepo(root)
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    const { todo } = await orch.createTodo(run, { projectId: project.id, title: 'T' })
    const first = await orch.startBuild(run, { todoId: todo.id })
    assert.equal(first.phase, 'building')
    assert.equal(runs, 1)

    // Chief calls run_build again while the worker is still busy: no second sessions.run, no failure.
    const again = await orch.startBuild(run, { todoId: todo.id })
    assert.equal(runs, 1, 'no duplicate run sent into a busy session')
    assert.equal(again.phase, 'building')
    assert.ok(again.timeline.some(t => /忽略重复派发/.test(t.event)))

    // Even if a stale state marked it failed, a live session is re-attached, not re-run.
    db.updateTodo(1, 'default', todo.id, { phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError: 'x' })
    const back = await orch.startBuild(run, { todoId: todo.id })
    assert.equal(runs, 1)
    assert.equal(back.phase, 'building')
    assert.equal(back.lastError, '')
  } finally { ctx.cleanup() }
})

test('v0.9.6: host "session is already running" is treated as in-progress, not a failed start', async () => {
  const ctx = setup({ runImpl() { throw new Error('{"ok":false,"status":"failed","event":"run.failed","error":"session sess-1 is already running"}') } })
  try {
    const { db, orch, run, root } = ctx
    const repoPath = makeRepo(root)
    const { project } = await orch.addProject(run, { name: 'P', repoPath })
    const { todo } = await orch.createTodo(run, { projectId: project.id, title: 'T' })
    const res = await orch.startBuild(run, { todoId: todo.id })
    assert.equal(res.phase, 'building')
    assert.notEqual(db.getTodo(1, 'default', todo.id).phase, 'failed')
  } finally { ctx.cleanup() }
})

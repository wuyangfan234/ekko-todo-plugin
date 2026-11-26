// #78: the names of the failed tests survive. The gate summary (what the Chief reads) names up to 3 of them,
// bounded; and a redispatch that clears `testFailures` first writes the names of the round before into the
// card's timeline, so a flaky red can still be traced after the card has been sent back to work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { MAX_SUMMARY_CHARS, runDeterministicTestGate } from '../src/server/gate-runner.mjs'

// ---- gate-runner: the summary ---------------------------------------------------------------------------

// Runs the real gate on a shell script that prints the given lines and exits with `rc`.
async function gate(lines, rc) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-gate-names-'))
  try {
    const script = join(root, 'gate.sh')
    writeFileSync(script, lines.map(l => `printf '%s\\n' '${l.replace(/'/g, `'\\''`)}'`).join('\n') + `\nexit ${rc}\n`)
    return await runDeterministicTestGate({ cwd: root, command: `sh "${script}"`, timeoutMs: 20000 })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('#78 a: a failed gate with one failed test names it in the summary', async () => {
  const r = await gate(['ok 1 - fine', 'not ok 2 - v0942-todo-instructions › keeps the order', '# fail 1'], 1)
  assert.equal(r.exitCode, 1)
  assert.match(r.summary, /失败用例 1 条：v0942-todo-instructions › keeps the order/)
})

test('#78 b: five failed tests: the summary lists the first 3 and says 另有 2 条', async () => {
  const r = await gate(['not ok 1 - n-one', 'not ok 2 - n-two', 'not ok 3 - n-three', 'not ok 4 - n-four', 'not ok 5 - n-five', '# fail 5'], 1)
  assert.equal(r.failureCount, 5)
  assert.match(r.summary, /失败用例 5 条：n-one；n-two；n-three（另有 2 条）/)
  assert.doesNotMatch(r.summary, /n-four|n-five/)
})

test('#78 c: a name over 80 characters is cut to 80 with an ellipsis', async () => {
  const long = 'x'.repeat(150)
  const r = await gate([`not ok 1 - ${long}`, '# fail 1'], 1)
  const shown = r.summary.match(/失败用例 1 条：(x+…)/)
  assert.ok(shown, r.summary)
  assert.equal([...shown[1]].length, 80)
  assert.ok(!r.summary.includes(long), 'the full name is not in the summary')
  assert.deepEqual(r.failures, [long], 'the card keeps the full name')
})

test('#78 d: the whole summary stays within MAX_SUMMARY_CHARS, whatever the output holds', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `${i}-${'测'.repeat(190)}`)
  const r = await gate([...names.map((n, i) => `not ok ${i + 1} - ${n}`), 'z'.repeat(500)], 1)
  assert.equal(r.failureCount, 12)
  assert.ok(r.summary.length <= MAX_SUMMARY_CHARS, `summary length ${r.summary.length} > ${MAX_SUMMARY_CHARS}`)
  assert.match(r.summary, /失败用例 12 条：.+（另有 9 条）/)
})

test('#78 e: a passing gate names no test, even if its output has a not-ok line', async () => {
  const r = await gate(['not ok 1 - looks-broken', 'ok 2 - fine'], 0)
  assert.equal(r.exitCode, 0)
  assert.doesNotMatch(r.summary, /looks-broken|失败用例/)
})

test('#78 real shape: a long real TAP name, summary printed with its length', async () => {
  const r = await gate([
    'ok 115 - dist/server.mjs is built from src',
    'not ok 116 - dist/client.mjs is self-contained: no bare imports, no host source paths, no node: builtins left in the browser bundle',
    '  ---',
    '  duration_ms: 12.3',
    '  ...',
    '# tests 812',
    '# pass 811',
    '# fail 1',
  ], 1)
  console.log(`[real-shape] summary (${r.summary.length} chars): ${r.summary}`)
  assert.match(r.summary, /失败用例 1 条：dist\/client\.mjs is self-contained/)
  assert.ok(r.summary.length <= MAX_SUMMARY_CHARS)
})

// ---- orchestrator: the redispatch -----------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-gate-names-card-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false } },
      async connect(id, cb) {
        const timer = setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(sessions.get(id)?.is_running), runStartedAt: 0, queueLength: 0 }), 0)
        return { close() { clearTimeout(timer) } }
      },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {}, notify() {} } }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, sessions, cleanup }
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim()

async function complete(ctx, todoId) {
  const sessionId = ctx.db.getTodo(1, 'default', todoId).buildSessionId
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: 'done', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)
  return ctx.db.getTodo(1, 'default', todoId)
}

// One card whose first round ends on a gate that prints `gateLines` and exits with `rc`.
async function cardAfterFirstGate(ctx, gateLines, rc) {
  const { root, db, orch, run } = ctx
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath)
  git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n')
  git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
  const gateScript = join(root, 'gate.sh')
  writeFileSync(gateScript, gateLines.map(l => `echo "${l}"`).join('\n') + `\nexit ${rc}\n`)
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  await orch.saveAgent(run, { name: '门禁测试 Agent', role: 'builder', engine: 'codex', modelConfigs: [{ id: 'cfg-1', label: '主力', engine: 'codex', mode: 'global', provider: 'p1', model: 'model-one', reasoningEffort: 'high' }] })
  const agent = db.listAgents(1, 'default').find(a => a.name === '门禁测试 Agent')
  const { project } = await orch.addProject(run, { name: 'P', repoPath, testCommand: `sh "${gateScript}"` })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
  const built = await orch.startBuild(run, { todoId: todo.id })
  writeFileSync(join(built.worktreePath, 'a.txt'), 'round one\n')
  git(built.worktreePath, 'commit', '-am', 'one')
  const settled = await complete(ctx, todo.id)
  return { todo, settled }
}

const gateNotes = card => card.timeline.filter(e => e.event.startsWith('上一次门禁失败'))

test('#78 f: red gate → redispatch: testFailures is cleared, the timeline keeps the names', async () => {
  const ctx = setup()
  try {
    const { todo, settled } = await cardAfterFirstGate(ctx, ['ok 1 - fine', 'not ok 2 - flaky clock case', 'not ok 3 - second red', '# fail 2'], 1)
    assert.equal(settled.evidence.testRc, 1)
    assert.deepEqual(settled.evidence.testFailures, ['flaky clock case', 'second red'])
    const sha = settled.evidence.commitSha
    const again = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, extraMessage: '修掉失败的用例' })
    assert.deepEqual(again.evidence.testFailures, [], 'the card field is still cleared')
    const notes = gateNotes(again)
    assert.equal(notes.length, 1, JSON.stringify(again.timeline.map(e => e.event)))
    assert.equal(notes[0].actor, 'system')
    assert.match(notes[0].event, /^上一次门禁失败（第 1 轮/)
    assert.ok(notes[0].event.includes('flaky clock case、second red'), notes[0].event)
    assert.ok(notes[0].event.includes('共 2 条；本轮重新构建，结果待定'), notes[0].event)
    if (sha) assert.ok(notes[0].event.includes(sha.slice(0, 7)), 'names the commit the gate ran on')
  } finally { ctx.cleanup() }
})

test('#78 f2: more than 5 names: 5 listed, each cut at 120, 等 M 条; a second red is round 2', async () => {
  const ctx = setup()
  try {
    const long = 'L'.repeat(200)
    const lines = [`not ok 1 - ${long}`, ...[2, 3, 4, 5, 6, 7].map(i => `not ok ${i} - name-${i}`)]
    const { todo } = await cardAfterFirstGate(ctx, lines, 1)
    const again = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, extraMessage: '再来' })
    const note = gateNotes(again)[0].event
    assert.ok(note.includes(`${'L'.repeat(119)}…、name-2`), note)
    assert.ok(!note.includes('L'.repeat(121)))
    assert.ok(note.includes('name-5') && !note.includes('name-6'), note)
    assert.ok(note.includes('等 7 条'), note)
    // The second round goes red as well: its note is round 2.
    writeFileSync(join(again.worktreePath, 'a.txt'), 'round two\n')
    git(again.worktreePath, 'commit', '-am', 'two')
    await complete(ctx, todo.id)
    const third = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, extraMessage: '第三次' })
    const notes = gateNotes(third)
    assert.equal(notes.length, 2)
    assert.match(notes[1].event, /^上一次门禁失败（第 2 轮/)
  } finally { ctx.cleanup() }
})

test('#78 g: a passing gate then redispatch writes no gate-failure line', async () => {
  const ctx = setup()
  try {
    const { todo, settled } = await cardAfterFirstGate(ctx, ['ok 1 - fine', '# fail 0'], 0)
    assert.equal(settled.evidence.testRc, 0)
    const before = settled.timeline.length
    const again = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, extraMessage: '继续' })
    assert.equal(gateNotes(again).length, 0)
    assert.ok(!again.timeline.slice(before).some(e => /门禁失败/.test(e.event)), 'no noise')
  } finally { ctx.cleanup() }
})

test('#78 h: the redispatch still resets testRc to -1 and empties testSummary', async () => {
  const ctx = setup()
  try {
    const { todo, settled } = await cardAfterFirstGate(ctx, ['not ok 1 - red one', '# fail 1'], 1)
    assert.equal(settled.evidence.testRc, 1)
    assert.match(settled.evidence.testSummary, /^Failed \(rc=1, .*失败用例 1 条：red one/)
    const again = await ctx.orch.startBuild(ctx.run, { todoId: todo.id, extraMessage: '修' })
    assert.equal(again.phase, 'building')
    assert.equal(again.evidence.testRc, -1)
    assert.equal(again.evidence.testSummary, '')
    assert.equal(again.evidence.testFailureCount, 0)
    assert.equal(again.evidence.reviewVerdict, 'none')
  } finally { ctx.cleanup() }
})

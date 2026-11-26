// #68 (C07 + G01): the dev-linked plugin is reloaded whenever its source changes; the old instance is disposed
// and its database closed (index.mjs cleanup: disposers → orchestrator.dispose() → db.close()). Before #68
// dispose() only cleared pendingSettles: a running test gate (detached process group) kept running, an async
// merge went on and wrote the card, and the old settle wrote a closed database ("database is not open",
// ekko-todo.json 1795655689075). The new instance then settled the same card again: one gate ran twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { runDeterministicTestGate } from '../src/server/gate-runner.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(20) } return cond() }
const answersWithin = (promise, ms) => Promise.race([
  promise.then(v => ({ state: 'returned', value: v }), e => ({ state: 'rejected', error: e })),
  sleep(ms).then(() => ({ state: 'blocked' })),
])
// Gone only on ESRCH. macOS answers EPERM while the group still has a zombie nobody reaped yet: not gone.
const groupAlive = pgid => { try { process.kill(-pgid, 0); return true } catch (err) { if (err.code === 'ESRCH') return false; if (err.code === 'EPERM') return true; throw err } }
const psLine = pgid => { try { return execFileSync('ps', ['-o', 'pid=,pgid=,etime=,command=', '-g', String(pgid)], { stdio: 'pipe' }).toString().trim() || '(none)' } catch { return '(none)' } }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim()

// Counts every call the orchestrator makes on the database, and which of them came after `close()`.
function countingDb(raw) {
  const counter = { total: 0, afterClose: 0, closed: false, names: [] }
  const proxy = new Proxy(raw, {
    get(obj, key) {
      const v = obj[key]
      if (typeof v !== 'function') return v
      return (...args) => {
        counter.total += 1
        if (counter.closed) { counter.afterClose += 1; counter.names.push(String(key)) }
        return v.apply(obj, args)
      }
    },
  })
  return { proxy, counter }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-dispose-'))
  const dataDir = join(root, 'data')
  const raw = createDatabase(dataDir, {})
  const { proxy: db, counter } = countingDb(raw)
  const logs = []
  const log = {
    warn(msg, data) { logs.push({ level: 'warn', msg: String(msg), data }) },
    info(msg, data) { logs.push({ level: 'info', msg: String(msg), data }) },
    error(msg, data) { logs.push({ level: 'error', msg: String(msg), data }) },
  }
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
  // index.mjs cleanup, in its order.
  const shutdown = () => { orch.dispose(); raw.close(); counter.closed = true }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { raw.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { root, dataDir, raw, db, counter, orch, run, sessions, logs, host, shutdown, cleanup }
}

async function buildingCard(ctx, testCommand) {
  const { root, db, orch, run } = ctx
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath)
  git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const { project } = await orch.addProject(run, { name: 'P', repoPath, testCommand })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T' })
  const built = await orch.startBuild(run, { todoId: todo.id })
  assert.equal(built.phase, 'building')
  writeFileSync(join(built.worktreePath, 'a.txt'), 'changed\n')
  git(built.worktreePath, 'commit', '-am', 'work')
  return { todo: built, project, topic, repoPath }
}

// The turn ended: delivered the way index.mjs does, including its catch-and-warn.
function endTurn(ctx, todoId, orch = ctx.orch) {
  const sessionId = ctx.raw.getTodo(1, 'default', todoId).buildSessionId
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: 'done', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  return orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)
    .catch(err => { ctx.logs.push({ level: 'warn', msg: 'Event reconciliation error', data: { error: err?.message } }) })
}

const mentions = (entry, re) => re.test(entry.msg) || re.test(JSON.stringify(entry.data ?? ''))
const closedDbWarns = ctx => ctx.logs.filter(e => mentions(e, /database is not open|statement has been finalized/))
const discardLogs = ctx => ctx.logs.filter(e => /已废弃/.test(e.msg))

test('#68 C07 (A): dispose ends the running test gate: its process group is gone (ESRCH) within 2 s', async () => {
  const ctx = setup()
  const pidFile = join(ctx.root, 'gate.pid')
  let pgid = 0
  try {
    const { todo } = await buildingCard(ctx, `echo $$ > "${pidFile}"; sleep 97`)
    const settling = endTurn(ctx, todo.id)
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()), 'the gate started')
    pgid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(groupAlive(pgid), 'the gate group is alive before dispose')
    console.log(`[C07] before dispose: ${psLine(pgid)}`)
    ctx.shutdown()
    const gone = await until(() => !groupAlive(pgid), 2000)
    console.log(`[C07] 2 s after dispose: ${psLine(pgid)} | kill(-pgid, 0) → ${gone ? 'ESRCH' : 'alive'}`)
    assert.ok(gone, 'the gate process group was terminated by dispose')
    // The settle that was waiting on the gate ends: nothing is left hanging.
    const done = await answersWithin(settling, 8000)
    assert.notEqual(done.state, 'blocked', 'the settle waiting on the aborted gate returned')
  } finally {
    if (pgid) { try { process.kill(-pgid, 'SIGKILL') } catch {} }
    ctx.cleanup()
  }
})

test('#68 G01 (B): after dispose + close the old settle writes nothing and says so, instead of "database is not open"', async () => {
  const ctx = setup()
  const pidFile = join(ctx.root, 'gate.pid')
  let pgid = 0
  try {
    // A short gate: without #68 it ends on its own after the database is closed and the settle goes on writing.
    const { todo } = await buildingCard(ctx, `echo $$ > "${pidFile}"; sleep 1`)
    const settling = endTurn(ctx, todo.id)
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()), 'the gate started')
    pgid = Number(readFileSync(pidFile, 'utf8').trim())
    ctx.shutdown()
    const done = await answersWithin(settling, 8000)
    assert.notEqual(done.state, 'blocked')
    await sleep(300)
    console.log(`[G01] closed-db warnings: ${closedDbWarns(ctx).length} | discard logs: ${discardLogs(ctx).map(e => e.msg).join(' / ') || '(none)'} | db calls after close: ${ctx.counter.afterClose} ${[...new Set(ctx.counter.names)].join(',')}`)
    assert.deepEqual(closedDbWarns(ctx).map(e => e.msg), [], 'no write reached the closed database')
    assert.ok(discardLogs(ctx).length >= 1, 'the dropped settle left an explicit "已废弃" log line')
    assert.ok(discardLogs(ctx).some(e => /#1 的构建结算/.test(e.msg)), 'the line names the settle whose gate result was dropped')
    assert.deepEqual(ctx.logs.filter(e => e.msg === 'Event reconciliation error').map(e => e.data?.error), [], 'nothing was thrown out of the event entry')
    assert.equal(ctx.counter.afterClose, 0, 'the old instance made no database call after close')
  } finally {
    if (pgid) { try { process.kill(-pgid, 'SIGKILL') } catch {} }
    ctx.cleanup()
  }
})

test('#68 C07 (C): a merge still running when the instance is disposed writes nothing to the database', async () => {
  const ctx = setup()
  try {
    const { db, orch, run } = ctx
    const { todo, repoPath } = await buildingCard(ctx, '')
    db.updateTodo(1, 'default', todo.id, { phase: 'review', gateOwner: 'human', gateKind: 'merge' })
    const branchHead = git(todo.worktreePath, 'rev-parse', 'HEAD')
    const returned = await orch.mergeBuild(run, { todoId: todo.id, caller: 'user', asyncMode: true })
    assert.equal(returned.phase, 'merging', 'the merge is in flight')
    orch.dispose()
    const callsAtDispose = ctx.counter.total
    // git is not interrupted (a half-done merge is worse): wait for it to land on main.
    const merged = await until(() => { try { git(repoPath, 'merge-base', '--is-ancestor', branchHead, 'main'); return true } catch { return false } }, 5000)
    await sleep(500)
    const after = ctx.counter.total - callsAtDispose
    console.log(`[C07-merge] git merged=${merged} | db calls after dispose: ${after} | discard logs: ${discardLogs(ctx).map(e => e.msg).join(' / ') || '(none)'}`)
    assert.equal(after, 0, 'the abandoned merge made no database call')
    assert.ok(discardLogs(ctx).some(e => /合并/.test(e.msg)), 'the abandoned merge is logged as 已废弃')
    assert.equal(ctx.raw.getTodo(1, 'default', todo.id).phase, 'merging', 'the card is left for the next instance (its reconcile heals a stuck merge)')
  } finally { ctx.cleanup() }
})

test('#68 C07: across a reload the gate of one round completes once: the old one is aborted, the new instance settles', async () => {
  const ctx = setup()
  const marks = join(ctx.root, 'gate-runs.log')
  let db2 = null
  let orch2 = null
  try {
    const { todo } = await buildingCard(ctx, `echo start >> "${marks}"; sleep 2; echo end >> "${marks}"; exit 0`)
    const settling = endTurn(ctx, todo.id)
    assert.ok(await until(() => existsSync(marks)), 'the old instance started the gate')
    ctx.shutdown()
    await answersWithin(settling, 8000)
    // The reloaded instance on the same data directory.
    db2 = createDatabase(ctx.dataDir, {})
    orch2 = createOrchestrator({ db: db2, dataDir: ctx.dataDir, config: {}, log: { warn() {}, info() {}, error() {} }, settleDelaysMs: [0, 0, 0, 0] })
    assert.equal(db2.getTodo(1, 'default', todo.id).phase, 'building', 'the old instance did not settle the card')
    for (let i = 0; i < 10 && db2.getTodo(1, 'default', todo.id).phase === 'building'; i += 1) {
      await orch2.reconcileActiveRuns(ctx.run)
      await sleep(100)
    }
    const settled = db2.getTodo(1, 'default', todo.id)
    await sleep(3000)
    const lines = readFileSync(marks, 'utf8').trim().split('\n')
    console.log(`[C07-reload] gate marks: ${lines.join(',')} | phase=${settled.phase} testRc=${settled.evidence.testRc} | ${settled.evidence.testSummary}`)
    assert.equal(settled.phase, 'review', 'the new instance settled the card')
    assert.equal(settled.evidence.testRc, 0, 'with the result of its own gate')
    assert.equal(lines.filter(l => l === 'end').length, 1, 'exactly one gate ran to the end')
  } finally {
    try { orch2?.dispose() } catch {}
    try { db2?.close() } catch {}
    ctx.cleanup()
  }
})

test('#68 C07: runDeterministicTestGate stops on its signal, kills the group and resolves (no hang)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-gate-abort-'))
  const pidFile = join(root, 'pid')
  let pgid = 0
  try {
    const controller = new AbortController()
    const started = Date.now()
    const gate = runDeterministicTestGate({ cwd: root, command: `echo $$ > "${pidFile}"; trap '' TERM; sleep 97`, timeoutMs: 60000, signal: controller.signal })
    assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()))
    pgid = Number(readFileSync(pidFile, 'utf8').trim())
    controller.abort()
    const r = await answersWithin(gate, 8000)
    assert.equal(r.state, 'returned', 'the gate resolved after abort')
    console.log(`[gate-abort] rc=${r.value.exitCode} aborted=${r.value.aborted} in ${Date.now() - started} ms | ${r.value.summary}`)
    assert.equal(r.value.aborted, true)
    assert.equal(r.value.exitCode, 130)
    assert.match(r.value.summary, /中止/)
    // The shell ignores SIGTERM; SIGKILL after the grace period still takes the whole group.
    assert.ok(await until(() => !groupAlive(pgid), 5000), 'the group is gone even when SIGTERM is ignored')
    // Aborted before it starts: nothing is spawned.
    const early = await runDeterministicTestGate({ cwd: root, command: `touch "${join(root, 'ran')}"`, signal: AbortSignal.abort() })
    assert.equal(early.executed, false)
    assert.equal(early.aborted, true)
    assert.equal(existsSync(join(root, 'ran')), false)
  } finally {
    if (pgid) { try { process.kill(-pgid, 'SIGKILL') } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
})

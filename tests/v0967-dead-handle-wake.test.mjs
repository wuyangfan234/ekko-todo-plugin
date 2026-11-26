// #64 (C06 + C08): the host handle of an RPC / event call is valid only while that call runs. Work that outlives
// it (the wake after an async merge, a queued card launched after a long gate, the first-message title) used to
// keep using the dead handle: `sessions.run` was refused, the live probe was refused too and answered
// `{ known: false, isWorking: true }` (fail-open), so the refused wake counted as started and was never queued,
// and a queued card launched after the handle died was written `failed`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (cond, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(25) } return cond() }

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-deadhandle-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const logs = []
  const log = {
    warn(msg, data) { logs.push({ level: 'warn', msg, data }) },
    info(msg, data) { logs.push({ level: 'info', msg, data }) },
    error(msg, data) { logs.push({ level: 'error', msg, data }) },
  }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const runsBySession = new Map()
  const flags = { respondDelayMs: 0 }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: {
      async list() { return { data: [{ id: 'fast-mini' }] } },
      async respond() {
        if (flags.respondDelayMs) await sleep(flags.respondDelayMs)
        return { output_text: '模型生成的标题' }
      },
    },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        runsBySession.set(id, (runsBySession.get(id) || 0) + 1)
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
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { root, db, orch, run, host, sessions, runsBySession, flags, logs, cleanup }
}

// A run whose host behaves like the real one: once the handle is aborted every host call is refused, and calls
// still in flight at that moment are refused too. `lifeMs` aborts on a timer (a call that outlives its budget);
// otherwise the handle dies when `fn` returns.
async function hostCall(ctx, fn, { lifeMs = 0 } = {}) {
  const controller = new AbortController()
  const rejected = []
  const abortedError = () => new Error('This operation was aborted')
  const guard = (target, path) => new Proxy(target, {
    get(obj, key) {
      const v = obj[key]
      const name = path ? `${path}.${String(key)}` : String(key)
      if (typeof v === 'function') return (...args) => {
        if (controller.signal.aborted) { rejected.push(name); return Promise.reject(abortedError()) }
        const p = Promise.resolve(v.apply(obj, args))
        return new Promise((resolve, reject) => {
          const onAbort = () => { rejected.push(`${name}(in-flight)`); reject(abortedError()) }
          controller.signal.addEventListener('abort', onAbort, { once: true })
          p.then(val => { controller.signal.removeEventListener('abort', onAbort); resolve(val) },
            err => { controller.signal.removeEventListener('abort', onAbort); reject(err) })
        })
      }
      if (v && typeof v === 'object') return guard(v, name)
      return v
    },
  })
  const scoped = { ...ctx.run, host: guard(ctx.run.host, 'host'), signal: controller.signal }
  const timer = lifeMs ? setTimeout(() => controller.abort(), lifeMs) : null
  try { return { value: await fn(scoped), rejected } } finally { if (!lifeMs) controller.abort() ; void timer }
}

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
  g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
  return repoPath
}
const commitIn = (dir, file, text) => {
  writeFileSync(join(dir, file), text)
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' })
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-m', `add ${file}`], { cwd: dir, stdio: 'pipe' })
}

test('#64 C06: the wake after an async merge is not lost when the merge call has already returned', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, root, sessions, runsBySession } = ctx
    db.getSettings(1, 'default')
    db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
    const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
    const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: true })
    // An idle Chief session the wake should reach.
    const chief = (await run.host.sessions.create({ title: 'chief' })).session.id
    db.updateTopic(1, 'default', topic.id, { chiefSessionId: chief, isRunning: false })
    const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T' })
    const built = await orch.startBuild(run, { todoId: todo.id })
    sessions.get(built.buildSessionId).is_running = false
    commitIn(built.worktreePath, 'b.txt', 'b\n')
    db.updateTodo(1, 'default', todo.id, { phase: 'review', gateOwner: 'human', gateKind: 'merge' })
    db.watchTodo(1, 'default', topic.id, todo.id, 'test')

    const chiefRunsBefore = runsBySession.get(chief) || 0
    const { rejected } = await hostCall(ctx, r => orch.mergeBuild(r, { todoId: todo.id, caller: 'user', asyncMode: true }))
    assert.ok(await until(() => db.getTodo(1, 'default', todo.id).phase === 'done'), 'the merge finished')
    await sleep(300)
    const wakes = db.listTopicQueue(1, 'default', topic.id).filter(i => i.kind === 'wake')
    console.log(`[C06] rejected host calls: ${[...new Set(rejected)].join(', ') || '(none)'} | wake items=${wakes.length} | isRunning=${db.getTopic(1, 'default', topic.id).isRunning}`)

    // Next scheduler tick with a fresh handle: the Chief is idle, so the queued wake is delivered.
    for (let i = 0; i < 3 && (runsBySession.get(chief) || 0) === chiefRunsBefore; i += 1) await orch.reconcileActiveRuns(run)
    const chiefRuns = (runsBySession.get(chief) || 0) - chiefRunsBefore
    console.log(`[C06] chief runs after a fresh tick: ${chiefRuns}`)
    assert.ok(wakes.length >= 1 || chiefRuns >= 1, `the wake was queued (${wakes.length}) or delivered on the next tick (${chiefRuns})`)
    assert.equal(chiefRuns, 1, 'the Chief is woken exactly once, with the fresh handle')
  } finally { ctx.cleanup() }
})

test('#64 C06: a queued card launched after the handle died stays queued instead of failed', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, root, sessions } = ctx
    db.getSettings(1, 'default')
    db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0, maxConcurrentBuilds: 1 })
    // The gate takes 2 s, the handle of the settling call lives 1 s.
    const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'sleep 2' })
    const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
    const { todo: t1 } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T1' })
    const b1 = await orch.startBuild(run, { todoId: t1.id })
    assert.equal(b1.phase, 'building')
    const { todo: t2 } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T2' })
    const q2 = await orch.startBuild(run, { todoId: t2.id })
    assert.equal(q2.phase, 'queued')

    commitIn(b1.worktreePath, 'b.txt', 'b\n')
    sessions.get(b1.buildSessionId).is_running = false
    await hostCall(ctx, r => orch.settleWorkerRun(r, 1, 'default', t1.id, { sessionId: b1.buildSessionId, outcome: 'completed' }), { lifeMs: 1000 })
    const after = db.getTodo(1, 'default', t2.id)
    console.log(`[C06-B] T2 phase=${after.phase} gate=${after.gateKind} timeline=${JSON.stringify(after.timeline.map(e => e.event).slice(-3))}`)
    assert.notEqual(after.phase, 'failed', 'a refused launch does not fail the queued card')
    assert.equal(after.phase, 'queued')

    // The next tick with a fresh handle starts it.
    await orch.reconcileActiveRuns(run)
    const started = db.getTodo(1, 'default', t2.id)
    console.log(`[C06-B] T2 after a fresh tick: phase=${started.phase}`)
    assert.equal(started.phase, 'building')
  } finally { ctx.cleanup() }
})

test('#64 C08: the first-message title survives a send call that ended while the model was answering', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, flags, logs } = ctx
    const topic = db.createTopic(1, 'default', {})
    flags.respondDelayMs = 200
    const { rejected } = await hostCall(ctx, r => orch.sendTopicMessage(r, { topicId: topic.id, text: '请帮我整理会展排期', clientNonce: 'cn-title-1' }))
    await sleep(400)
    console.log(`[C08] rejected: ${[...new Set(rejected)].join(', ') || '(none)'}`)
    // The settle tick (scheduler action, fresh handle) finishes the title.
    flags.respondDelayMs = 0
    for (let i = 0; i < 3; i += 1) await orch.settlePendingTopics(run)
    const t = db.getTopic(1, 'default', topic.id)
    const degradeLog = logs.find(l => /标题/.test(l.msg) && /调用已结束/.test(l.msg))
    console.log(`[C08] title=${t.title} isUserNamed=${t.isUserNamed} log=${degradeLog?.msg || '(none)'}`)
    assert.ok(degradeLog, 'the cancelled title request is named in the log, not swallowed')
    assert.equal(t.title, '模型生成的标题', 'the title is finished with a fresh handle')
    assert.equal(t.isUserNamed, false)
  } finally { ctx.cleanup() }
})

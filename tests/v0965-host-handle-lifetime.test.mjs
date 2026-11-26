// 0.9.65: the host handle of an RPC/tool call is valid only until that call returns (SDK STUDIO_CTX: host and
// signal are bound to the call; afterwards host calls are cancelled). Before 0.9.65 a send answered after
// 800 ms (an instruction after 1500 ms) and went on starting the run in the background with that expired
// handle: the host cancelled it and the plugin logged "sessions.run rejected" (topic-6ca3e1d9, 2026-11-25).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { registerMcpTools } from '../src/server/mcp-tools.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(20) } return cond() }
// 'returned' when the call answers inside `ms`, 'blocked' when it is still waiting.
const answersWithin = (promise, ms) => Promise.race([
  promise.then(v => ({ state: 'returned', value: v }), e => ({ state: 'rejected', error: e })),
  sleep(ms).then(() => ({ state: 'blocked' })),
])

const rejections = []
process.on('unhandledRejection', err => { rejections.push(err) })

function setup({ orchOpts = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-nonblock-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const warns = []
  const log = { warn(msg, data) { warns.push({ msg, data }) }, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0], ...orchOpts })
  let seq = 0
  const sessions = new Map()
  const calls = { run: 0, runDone: 0, connect: 0 }
  // hold: the host keeps `sessions.run` open until release() (stands for the 120 s block).
  const flags = { runDelayMs: 0, runFails: false, hold: null, connectDelayMs: 0 }
  const emitted = []
  const hold = () => { let release; const promise = new Promise(r => { release = r }); flags.hold = { promise, release: () => { flags.hold = null; release() } }; return flags.hold }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create(input) { const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input) {
        calls.run += 1
        if (flags.hold) await flags.hold.promise
        if (flags.runDelayMs) await sleep(flags.runDelayMs)
        if (flags.runFails) throw new Error('{"ok":false,"status":"failed","event":"run.failed","error":"engine exploded while starting","session_id":"' + id + '","output":""}')
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        calls.runDone += 1
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { return { messages: sessions.get(id)?.messages || [], total: 0, offset: 0, limit: 80, hasMore: false } },
      // The live probe: answers `resumed` with the session's working flag after connectDelayMs.
      async connect(id, cb) {
        calls.connect += 1
        const timer = setTimeout(() => cb({ event: 'resumed', isWorking: Boolean(sessions.get(id)?.is_running), runStartedAt: 0, queueLength: 0 }), flags.connectDelayMs)
        return { close() { clearTimeout(timer) } }
      },
    },
  }
  const run = {
    identity: { userId: 1, profile: 'default' },
    host,
    messages: { emit(name, payload) { emitted.push({ name, reason: payload?.reason, at: Date.now() }) } },
  }
  const cleanup = () => { flags.hold?.release(); try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  const humans = topicId => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'human')
  const queue = topicId => db.listTopicQueue(1, 'default', topicId)
  return { root, db, orch, run, emitted, calls, flags, sessions, cleanup, humans, queue, warns, hold, dataDir }
}


function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repoPath, stdio: 'pipe' }).toString().trim()
  g('init', '-b', 'main'); g('config', 'user.name', 'T'); g('config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); g('add', '.'); g('commit', '-m', 'init')
  return repoPath
}

async function buildingTodo(ctx) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const { project } = await orch.addProject(run, { name: 'P', repoPath: makeRepo(root), testCommand: 'true' })
  const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: true })
  const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T' })
  const built = await orch.startBuild(run, { todoId: todo.id })
  assert.equal(built.phase, 'building')
  // The first turn is over: the session is idle, so an instruction is sent instead of queued.
  ctx.sessions.get(built.buildSessionId).is_running = false
  return { todo: built }
}

// Calls `fn` the way the host does: with a run whose host refuses everything once the call has returned.
async function hostCall(ctx, fn) {
  const controller = new AbortController()
  const guard = target => new Proxy(target, {
    get(obj, key) {
      const v = obj[key]
      if (typeof v === 'function') return (...args) => {
        if (controller.signal.aborted) return Promise.reject(new Error('This operation was aborted'))
        return v.apply(obj, args)
      }
      if (v && typeof v === 'object') return guard(v)
      return v
    },
  })
  const scoped = { ...ctx.run, host: guard(ctx.run.host), signal: controller.signal }
  try { return await fn(scoped) } finally { controller.abort() }
}
const rejectedWarns = ctx => ctx.warns.filter(w => /sessions\.run rejected/.test(w.msg))

test('0.9.65: a send whose host takes 1.5 s to accept is delivered inside the call, not cancelled after it', async () => {
  const ctx = setup()
  try {
    const { db, orch, calls, flags, humans } = ctx
    const topic = db.createTopic(1, 'default', {})
    flags.runDelayMs = 1500
    await hostCall(ctx, run => orch.sendTopicMessage(run, { topicId: topic.id, text: '慢启动', clientNonce: 'cn-life-1' })).catch(() => {})
    await sleep(200)
    assert.equal(calls.runDone, 1, 'the host accepted the run')
    assert.equal(rejectedWarns(ctx).length, 0, 'no run was cancelled')
    assert.equal(humans(topic.id)[0].sendError, undefined)
    assert.equal(db.getTopic(1, 'default', topic.id).isRunning, true)
  } finally { ctx.cleanup() }
})

test('0.9.65: an instruction whose host takes 2 s is delivered inside the call and the card keeps building', async () => {
  const ctx = setup()
  try {
    const { db, orch, calls, flags } = ctx
    const { todo } = await buildingTodo(ctx)
    const before = calls.runDone
    flags.runDelayMs = 2000
    await hostCall(ctx, run => orch.messageTodo(run, { todoId: todo.id, note: '慢启动指令' })).catch(() => {})
    await sleep(200)
    assert.equal(calls.runDone, before + 1, 'the host accepted the run')
    assert.equal(rejectedWarns(ctx).length, 0)
    assert.equal(db.getTodo(1, 'default', todo.id).phase, 'building', 'not failed by a cancelled launch')
  } finally { ctx.cleanup() }
})

test('0.9.65: "run now" on a queued message whose host takes 1.5 s is delivered inside the call', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, calls, flags, queue } = ctx
    const topic = db.createTopic(1, 'default', {})
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '第一轮', clientNonce: 'cn-life-a' })
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '排队的', clientNonce: 'cn-life-b' })
    const item = queue(topic.id)[0]
    assert.ok(item, 'queued behind the running turn')
    const before = calls.runDone
    flags.runDelayMs = 1500
    await hostCall(ctx, r => orch.promoteTopicQueueItem(r, { topicId: topic.id, itemId: item.id })).catch(() => {})
    await sleep(200)
    assert.equal(calls.runDone, before + 1, 'the host accepted the run')
    assert.equal(rejectedWarns(ctx).length, 0)
    assert.equal(queue(topic.id).length, 0, 'not put back in the queue')
  } finally { ctx.cleanup() }
})

test('0.9.65: a refused run names the reason in the log message text (the host log keeps only the text)', async () => {
  const ctx = setup()
  try {
    const { db, orch, run, flags } = ctx
    const topic = db.createTopic(1, 'default', {})
    flags.runFails = true
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '会失败', clientNonce: 'cn-life-log' }).catch(() => {})
    const w = rejectedWarns(ctx)
    assert.ok(w.length >= 1)
    assert.match(w[0].msg, /engine exploded/, 'the reason is in the message itself')
  } finally { ctx.cleanup() }
})

test('0.9.65: the page sends without taking the page-wide busy lock', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/App.jsx', import.meta.url), 'utf8')
  const i = src.indexOf("'send-topic-message',\n")
  assert.ok(i > 0)
  assert.match(src.slice(i, i + 1200), /free: true/, 'send-topic-message is a free call')
  assert.match(src, /if \(busy && !free\) return null/)
})

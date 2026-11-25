// The Chief's final answer of a turn must reach the plugin's own message list without a browser polling
// for it: the host stores that message a moment after it reports the run as finished.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'

// Mirrors the real host: `messages` returns the newest `limit` rows (tool rows included), oldest first,
// and `offset` pages further back.
function makeFakeHost() {
  let seq = 0
  const sessions = new Map()
  const flags = { messagesFail: false, probeUnknown: false, messageCalls: 0, messageDelayMs: 0 }
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
        if (s) { s.is_running = true; s.messages.push({ id: String(++seq), role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) {
        const s = sessions.get(id)
        if (!s) return null
        return flags.probeUnknown ? { session: { id } } : { session: s, is_running: s.is_running }
      },
      async messages(id, query = {}) {
        flags.messageCalls += 1
        if (flags.messageDelayMs) await new Promise(r => setTimeout(r, flags.messageDelayMs))
        if (flags.messagesFail) throw new Error('This operation was aborted')
        const all = sessions.get(id)?.messages || []
        const limit = Math.max(1, Number(query.limit) || 150)
        const offset = Math.max(0, Number(query.offset) || 0)
        const end = Math.max(0, all.length - offset)
        const page = all.slice(Math.max(0, end - limit), end)
        return { messages: page, total: all.length, offset, limit, hasMore: offset + page.length < all.length }
      },
    },
  }
  const push = (sid, role, content) => {
    const id = String(++seq)
    sessions.get(sid).messages.push({ id, role, content, timestamp: Math.floor(Date.now() / 1000) })
    return id
  }
  return { host, sessions, flags, push }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-settle-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const orch = createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {} }, settleDelaysMs: [0, 0, 0, 0] })
  const fake = makeFakeHost()
  const emitted = []
  const run = {
    identity: { userId: 1, profile: 'default' },
    host: fake.host,
    messages: { emit(name, payload) { emitted.push({ name, payload }) } },
  }
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { db, orch, fake, run, emitted, cleanup }
}

// Runs the background settle action the way the host scheduler does. On code without the action this is a
// no-op, so the assertions below fail on missing behaviour rather than on a missing function.
async function driveSettle(orch, run, passes = 6) {
  for (let i = 0; i < passes; i += 1) await orch.settlePendingTopics?.(run)
}

async function startTurn(ctx, text = 'hi') {
  const { topic } = await ctx.orch.createTopic(ctx.run, {})
  await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text })
  const sid = ctx.db.getTopic(1, 'default', topic.id).chiefSessionId
  return { topicId: topic.id, sid }
}

const chiefTexts = (db, topicId) => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'chief').map(m => m.text)

test('the final answer stored after the run-finished event still reaches the plugin, once, with no browser polling', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx)
    // The host reports the run as finished before the last assistant message is stored.
    fake.sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    assert.deepEqual(chiefTexts(db, topicId).filter(t => t === 'FINAL ANSWER'), [])
    fake.push(sid, 'assistant', 'FINAL ANSWER')

    await driveSettle(orch, run)
    assert.deepEqual(chiefTexts(db, topicId).filter(t => t === 'FINAL ANSWER'), ['FINAL ANSWER'], 'final answer is in the plugin list')
    const tp = db.getTopic(1, 'default', topicId)
    assert.equal(tp.isRunning, false)
    assert.equal(tp.activeRunId, '')

    // Running everything again must not add a second copy.
    await driveSettle(orch, run)
    await orch.syncTopicSession(run, { topicId })
    await orch.syncTopicSession(run, { topicId })
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    await driveSettle(orch, run)
    assert.equal(chiefTexts(db, topicId).filter(t => t === 'FINAL ANSWER').length, 1, 'no duplicate')
  } finally { ctx.cleanup() }
})

test('a failed message read at the end of a run does not leave the topic marked as running', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx)
    fake.sessions.get(sid).is_running = false
    fake.push(sid, 'assistant', 'DONE')
    fake.flags.messagesFail = true
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    fake.flags.messagesFail = false

    await driveSettle(orch, run)
    const tp = db.getTopic(1, 'default', topicId)
    assert.equal(tp.isRunning, false, 'running flag cleared by the settle pass')
    assert.equal(tp.activeRunId, '')
    assert.deepEqual(chiefTexts(db, topicId), ['DONE'])
  } finally { ctx.cleanup() }
})

test('a topic still marked running while the host is idle is corrected on sync', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx)
    fake.sessions.get(sid).is_running = false
    db.updateTopic(1, 'default', topicId, { isRunning: true, activeRunId: 'stale-run' })
    await orch.syncTopicSession(run, { topicId })
    const tp = db.getTopic(1, 'default', topicId)
    assert.equal(tp.isRunning, false)
    assert.equal(tp.activeRunId, '')
  } finally { ctx.cleanup() }
})

test('the background pass copies new messages even when the host cannot say whether the session is working', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx)
    fake.flags.probeUnknown = true
    fake.push(sid, 'assistant', 'ANSWER WHILE STATE UNKNOWN')
    await orch.reconcileActiveRuns(run)
    assert.deepEqual(chiefTexts(db, topicId), ['ANSWER WHILE STATE UNKNOWN'])
    // Unknown is not idle: the running flag is left alone.
    assert.equal(db.getTopic(1, 'default', topicId).isRunning, true)
  } finally { ctx.cleanup() }
})

test('an answer pushed out of the newest 80 host rows by tool calls is still copied', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx)
    fake.push(sid, 'assistant', 'first narration')
    await orch.syncTopicSession(run, { topicId })
    assert.deepEqual(chiefTexts(db, topicId), ['first narration'])

    fake.push(sid, 'assistant', 'ANSWER A')
    for (let i = 0; i < 100; i += 1) {
      fake.push(sid, 'assistant', '')
      fake.push(sid, 'tool', `tool output ${i}`)
    }
    fake.push(sid, 'assistant', 'ANSWER B')
    await orch.syncTopicSession(run, { topicId })
    assert.deepEqual(chiefTexts(db, topicId), ['first narration', 'ANSWER A', 'ANSWER B'])

    await orch.syncTopicSession(run, { topicId })
    assert.equal(chiefTexts(db, topicId).length, 3, 'paging back does not duplicate')
  } finally { ctx.cleanup() }
})

test('a long history with nothing new is read in one page', async () => {
  const ctx = setup()
  try {
    const { orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx)
    for (let i = 0; i < 300; i += 1) fake.push(sid, i % 2 ? 'tool' : 'assistant', i % 2 ? 'out' : `note ${i}`)
    await orch.syncTopicSession(run, { topicId })
    fake.flags.messageCalls = 0
    await orch.syncTopicSession(run, { topicId })
    assert.equal(fake.flags.messageCalls, 1)
  } finally { ctx.cleanup() }
})

test('three turns in one session: every host answer with text is in the plugin list', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx, 'round 1')
    for (let round = 1; round <= 3; round += 1) {
      if (round > 1) await orch.sendTopicMessage(run, { topicId, text: `round ${round}` })
      fake.push(sid, 'assistant', `narration ${round}`)
      for (let i = 0; i < 45; i += 1) { fake.push(sid, 'assistant', ''); fake.push(sid, 'tool', 'out') }
      fake.sessions.get(sid).is_running = false
      await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
      // Rounds 1 and 2 end with the same sentence (a different host message each time); round 3 differs.
      fake.push(sid, 'assistant', round < 3 ? '好的。' : 'final 3')
      await driveSettle(orch, run)

      const hostAnswers = fake.sessions.get(sid).messages.filter(m => m.role === 'assistant' && String(m.content).trim()).map(m => m.content)
      assert.equal(chiefTexts(db, topicId).length, hostAnswers.length, `round ${round}: host answer count == plugin chief count`)
      assert.deepEqual(chiefTexts(db, topicId), hostAnswers, `round ${round}: host answers == plugin chief messages`)
      assert.equal(db.getTopic(1, 'default', topicId).isRunning, false, `round ${round}: not left running`)
    }
    assert.equal(chiefTexts(db, topicId).length, 6)
  } finally { ctx.cleanup() }
})

test('a settle pass does not clear a turn that started in the meantime', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx)
    fake.sessions.get(sid).is_running = false
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    await orch.sendTopicMessage(run, { topicId, text: 'next question' })
    assert.equal(db.getTopic(1, 'default', topicId).isRunning, true)
    await driveSettle(orch, run)
    assert.equal(db.getTopic(1, 'default', topicId).isRunning, true, 'the new turn keeps its running flag')
  } finally { ctx.cleanup() }
})

test('two turns that end with the same text are two host messages and both are kept', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx, 'go on')
    const ids = []
    for (let round = 1; round <= 2; round += 1) {
      if (round > 1) await orch.sendTopicMessage(run, { topicId, text: 'go on' })
      fake.sessions.get(sid).is_running = false
      await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
      ids.push(fake.push(sid, 'assistant', 'SAME ANSWER'))
      await driveSettle(orch, run)
    }
    const chiefs = db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'chief')
    assert.deepEqual(chiefs.map(m => m.text), ['SAME ANSWER', 'SAME ANSWER'])
    assert.deepEqual(chiefs.map(m => m.hostMessageId), ids, 'one row per host message id')
    await driveSettle(orch, run)
    await orch.syncTopicSession(run, { topicId })
    assert.equal(chiefTexts(db, topicId).length, 2, 'repeating the sync adds nothing')
  } finally { ctx.cleanup() }
})

test('a settle pass copies messages but keeps the running flag when the host cannot say whether the session is idle', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx)
    fake.push(sid, 'assistant', 'ANSWER')
    // The sync at the finished event fails, so the flag is still set when the settle pass runs.
    fake.flags.messagesFail = true
    await orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid } }, run)
    fake.flags.messagesFail = false
    fake.flags.probeUnknown = true
    await driveSettle(orch, run)
    assert.deepEqual(chiefTexts(db, topicId), ['ANSWER'], 'messages are still copied')
    assert.equal(db.getTopic(1, 'default', topicId).isRunning, true, 'unknown is not idle: flag kept')
  } finally { ctx.cleanup() }
})

test('overlapping syncs of the same topic store each host message once', async () => {
  const ctx = setup()
  try {
    const { db, orch, fake, run } = ctx
    const { topicId, sid } = await startTurn(ctx)
    fake.push(sid, 'assistant', 'ONLY ONCE')
    fake.sessions.get(sid).is_running = false
    // Every sync reads its list of known messages, then waits on the host: all four are in that wait together.
    fake.flags.messageDelayMs = 20
    await Promise.all([
      orch.syncTopicSession(run, { topicId }),
      orch.syncTopicSession(run, { topicId }),
      orch.syncChiefTranscript(run, 1, 'default', topicId, false),
      orch.reconcileActiveRuns(run),
    ])
    assert.deepEqual(chiefTexts(db, topicId), ['ONLY ONCE'])
  } finally { ctx.cleanup() }
})

test('opening a database that already holds duplicate host messages removes the extra copies and then refuses new ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-settle-db-'))
  try {
    const dataDir = join(root, 'data')
    let db = createDatabase(dataDir, {})
    const topicId = db.createTopic(1, 'default', {}).id
    db.addTopicMessage(1, 'default', topicId, { kind: 'chief', text: 'kept', hostMessageId: '7', createdAt: 1000 })
    db.addTopicMessage(1, 'default', topicId, { kind: 'human', text: 'typed here, no host id', createdAt: 1500 })
    db.addTopicMessage(1, 'default', topicId, { kind: 'human', text: 'typed here, no host id', createdAt: 1600 })
    db.close()
    // Put the file into the older shape: no unique index, one host message stored twice.
    const raw = new DatabaseSync(join(dataDir, 'ekko-todo.sqlite'))
    raw.exec('DROP INDEX IF EXISTS idx_topic_msgs_host')
    raw.prepare("INSERT INTO topic_messages (id, topic_id, user_id, profile, kind, text, host_message_id, created_at) VALUES ('dup-1', ?, 1, 'default', 'chief', 'kept', '7', 2000)").run(topicId)
    raw.close()

    db = createDatabase(dataDir, {})
    const msgs = () => db.getTopic(1, 'default', topicId).messages
    assert.deepEqual(msgs().filter(m => m.hostMessageId === '7').map(m => m.createdAt), [1000], 'the first copy stays')
    assert.equal(msgs().filter(m => !m.hostMessageId).length, 2, 'messages without a host id are never merged')
    assert.equal(db.addTopicMessage(1, 'default', topicId, { kind: 'chief', text: 'again', hostMessageId: '7', createdAt: 3000 }), '', 'a second copy is refused')
    assert.equal(msgs().length, 3)
    db.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

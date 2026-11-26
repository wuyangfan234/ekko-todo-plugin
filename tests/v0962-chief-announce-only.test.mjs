// 0.9.62 — the Chief "announced and stopped": on 2026-11-25 18:13 the Chief answered 「部署进度如何」 with
// 「我先查一下 #27 的最新状态。」 (16 chars, 0 tool calls, finish_reason=stop) and the host ended the turn.
// The user saw a reply that promised work and then nothing. The plugin now resumes such a turn once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { detectChiefAnnounceOnly, formatChiefAnnounceNudge, chiefToolName } from '../src/shared/chief-guard.mjs'
import { buildChiefInstructions } from '../src/server/prompts.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-v0962-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
  const calls = { create: 0, run: 0, inputs: [], options: [], sessions: [] }
  // onStop: called inside sessions.stop (the host reports the stop before stop() returns).
  // createFails: sessions.create rejects. alreadyRunning: sessions.run is refused as "already running".
  const flags = { onStop: null, createFails: false, alreadyRunning: false }
  const host = {
    agents: { async list() { return { agents: [{ id: 'codex', name: 'Codex', status: { installed: true }, modes: ['global'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request(path) { return path === '/api/hermes/available-models' && flags.catalog ? flags.catalog : null },
    sessions: {
      async create(input) { if (flags.createFails) throw new Error('host refused to create a session'); calls.create += 1; const id = `sess-${++seq}`; sessions.set(id, { id, ...input, messages: [], is_running: false }); return { session: { id } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run(id, input, options) {
        calls.run += 1
        calls.inputs.push(String(input))
        calls.options.push(options || {})
        calls.sessions.push(id)
        if (flags.alreadyRunning) throw new Error('Session ' + id + ' is already running')
        const s = sessions.get(id)
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; if (flags.onStop) await flags.onStop(id); return { ok: true } },
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
  // The test gate appends one line to a file outside the repo: its line count is how often the gate ran.
  const gateLog = join(root, 'gate.log')
  return { root, db, orch, run, calls, flags, sessions, cleanup, gateLog }
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim()

function makeRepo(root) {
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'base\n'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
  return repoPath
}


const ts = () => Math.floor(Date.now() / 1000)
const turn = (...rest) => [{ role: 'user', content: '部署进度如何' }, ...rest]

test('0.9.62: detects a short intent sentence with no tool call as announce-only (real incident text)', () => {
  assert.deepEqual(detectChiefAnnounceOnly(turn({ role: 'assistant', content: '我先查一下 #27 的最新状态。' })), { text: '我先查一下 #27 的最新状态。' })
  // The other two hits found when every Chief session on the real board was scanned (479 turns).
  for (const s of ['让我看看 #18 的 diff', '稍等，我去读一下执行对话。', "Let me check todo #27's status.", '现在去核对部署记录', "I'll find the failed todos and mark them complete.", "The ekko tools aren't directly callable in this session, so I'll locate them through the deferred-tool search."])
    assert.ok(detectChiefAnnounceOnly(turn({ role: 'assistant', content: s })), s)
})

test('0.9.62: real answers, questions, tool turns and empty replies are not announce-only', () => {
  const tooled = turn({ role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'tool_call' } }] }, { role: 'tool', content: '{}' }, { role: 'assistant', content: '我先查一下。' })
  assert.equal(detectChiefAnnounceOnly(tooled), null, 'turn that already used tools')
  assert.equal(detectChiefAnnounceOnly(turn({ role: 'assistant', content: '#27 已部署完成，NAS 18340 返回 200，等你验收。' })), null, 'a status answer')
  assert.equal(detectChiefAnnounceOnly(turn({ role: 'assistant', content: '我先查一下哪个项目？请告诉我名字？' })), null, 'a question to the user')
  assert.equal(detectChiefAnnounceOnly(turn({ role: 'assistant', content: '' })), null, 'empty reply has its own notice')
  // The one false positive of the first rule on the real board: a status report ending on a later promise.
  assert.equal(detectChiefAnnounceOnly(turn({ role: 'assistant', content: '旁路只读摸底被中途打断了，没有形成可引用的结论，不影响已经派出的三张单。\n\n#10、#11、#12 仍由平台主程在各自隔离分支里做。做完我会逐张验收。' })), null, 'paragraph report')
  assert.equal(detectChiefAnnounceOnly(turn({ role: 'assistant', content: '三张单都在跑，做完我会逐张验收。' })), null, 'a promise about later work')
  assert.equal(detectChiefAnnounceOnly(turn({ role: 'assistant', content: '我先查一下。'.repeat(30) })), null, 'long reply')
  assert.equal(detectChiefAnnounceOnly([{ role: 'assistant', content: '我先查一下。' }]), null, 'no user message in view')
})

test('0.9.62: the nudge names the exact deferred tool names so the Chief can call tool_call directly', () => {
  assert.equal(chiefToolName('get_todo_conversation'), 'mcp__ekko_todo__ekko_todo__get_utodo_uconversation')
  assert.equal(chiefToolName('list_todos'), 'mcp__ekko_todo__ekko_todo__list_utodos')
  const n = formatChiefAnnounceNudge('我先查一下 #27 的最新状态。')
  assert.match(n, /我先查一下 #27 的最新状态。/)
  assert.match(n, /mcp__ekko_todo__ekko_todo__list_utodos/)
  assert.match(n, /tool_call/)
  const ins = buildChiefInstructions({ settings: { chiefStrictOrchestration: true }, agents: [], projects: [], activeTodos: [], memories: [], chiefAgent: {}, topic: {} })
  assert.match(ins, /mcp__ekko_todo__ekko_todo__list_utodos/, 'the charter lists the exact names too')
  assert.match(ins, /NEVER end a turn on a sentence that only says what you are about to do/)
})

async function chiefTopic(ctx) {
  const { root, db, orch, run } = ctx
  db.getSettings(1, 'default'); db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const repoPath = join(root, 'repo'); mkdirSync(repoPath, { recursive: true })
  git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
  writeFileSync(join(repoPath, 'a.txt'), 'x\n'); git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
  const { project } = await orch.addProject(run, { name: 'P', repoPath })
  const { topic } = await orch.createTopic(run, { projectId: project.id })
  return topic
}
async function chiefSays(ctx, topicId, content) {
  const sid = ctx.db.getTopic(1, 'default', topicId).chiefSessionId
  const s = ctx.sessions.get(sid)
  s.is_running = false
  s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content, finish_reason: 'stop', timestamp: ts() })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid, finish_reason: 'stop' } }, ctx.run)
  return sid
}
const chiefRuns = (ctx, sid) => ctx.calls.inputs.filter((_, i) => ctx.calls.sessions[i] === sid)
const systemTexts = (ctx, topicId) => (ctx.db.getTopic(1, 'default', topicId).messages || []).filter(m => m.kind === 'system').map(m => m.text)

test('0.9.62/0.9.64: an announce-only Chief turn is resumed up to twice in the same session, then left alone', async () => {
  const ctx = setup()
  try {
    const topic = await chiefTopic(ctx)
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '部署进度如何' })
    const sid = ctx.db.getTopic(1, 'default', topic.id).chiefSessionId
    assert.ok(sid, 'chief session started')
    assert.equal(chiefRuns(ctx, sid).length, 1)
    await chiefSays(ctx, topic.id, '我先查一下 #27 的最新状态。')
    const runs = chiefRuns(ctx, sid)
    assert.equal(runs.length, 2, 'resumed once')
    assert.match(runs[1], /自动续跑/)
    assert.match(runs[1], /我先查一下 #27 的最新状态。/)
    assert.ok(systemTexts(ctx, topic.id).some(t => /只说了打算/.test(t)), 'the user sees why it continued')
    assert.doesNotMatch(runs[1], /第一个动作必须是一次工具调用/)
    // Same announcement again: second resume, which fixes the first action.
    await chiefSays(ctx, topic.id, '我先查一下 #27 的最新状态。')
    assert.equal(chiefRuns(ctx, sid).length, 3, 'second automatic resume')
    assert.match(chiefRuns(ctx, sid)[2], /第 2 次续跑.*第一个动作必须是一次工具调用/s)
    // Third time: left alone.
    await chiefSays(ctx, topic.id, '我先查一下 #27 的最新状态。')
    assert.equal(chiefRuns(ctx, sid).length, 3, 'at most two automatic resumes per user message')
    // A new user message re-arms it.
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '那 #26 呢' })
    assert.equal(chiefRuns(ctx, sid).length, 4)
    await chiefSays(ctx, topic.id, '让我看看 #26。')
    assert.equal(chiefRuns(ctx, sid).length, 5, 're-armed by the new user message')
  } finally { ctx.cleanup() }
})

test('0.9.62: a real answer ends the turn without any automatic resume', async () => {
  const ctx = setup()
  try {
    const topic = await chiefTopic(ctx)
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '部署进度如何' })
    const sid = ctx.db.getTopic(1, 'default', topic.id).chiefSessionId
    await chiefSays(ctx, topic.id, '#27 正在执行部署（phase=building），完成后会自动通知你。')
    assert.equal(chiefRuns(ctx, sid).length, 1)
    assert.ok(!systemTexts(ctx, topic.id).some(t => /只说了打算/.test(t)))
  } finally { ctx.cleanup() }
})

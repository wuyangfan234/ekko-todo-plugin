// 0.9.63 — on another machine the Web UI wrote the Ekko ToDo MCP entry but could not hot-reload it into the agent
// (`WorkerProcess.request() got an unexpected keyword argument 'start_if_needed'`). Every board call then came back
// "is not a known tool name", the model produced only reasoning, and the host ended the turn with "(empty)".
// The topic now says what is wrong and what to do, and does not resume a turn that would hit the same wall.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { detectEkkoToolsMissing, isHostEmptyPlaceholder } from '../src/shared/chief-guard.mjs'

// ---- harness ---------------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-v0963-'))
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
// Verbatim from the other machine's agent.log (2026-11-26 10:59:27).
const NOT_KNOWN = (n) => JSON.stringify({ error: `'${n}' is not a known tool name. Deferred tools must be invoked through tool_call by the exact name tool_search returns (e.g. mcp__<server>__{tool}). Use tool_search to find it.` })

test('0.9.63: an unloaded Ekko ToDo tool in this turn is detected; other errors and earlier turns are not', () => {
  const turn = [
    { role: 'user', content: '对aitrader项目配置专属开发和审计agent' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'tool_call' } }] },
    { role: 'tool', content: NOT_KNOWN('mcp__ekko_todo__ekko_todo__list_agents') },
    { role: 'user', content: '[System: Continue now. Execute the required tool calls and only send your final answer after completing the task.]' },
    { role: 'assistant', content: '(empty)' },
  ]
  assert.equal(detectEkkoToolsMissing(turn), null, 'a misspelt name (list_agents for list_uagents) does not prove the tools are missing')
  turn[2] = { role: 'tool', content: NOT_KNOWN('mcp__ekko_todo__ekko_todo__inspect_uproject_urepo') }
  assert.deepEqual(detectEkkoToolsMissing(turn), { tool: 'mcp__ekko_todo__ekko_todo__inspect_uproject_urepo' }, 'host continuation nudges do not start a new turn')
  assert.equal(detectEkkoToolsMissing([{ role: 'user', content: 'x' }, { role: 'tool', content: NOT_KNOWN('mcp__magpie__terminal') }]), null, 'another server')
  assert.equal(detectEkkoToolsMissing([{ role: 'user', content: 'x' }, { role: 'tool', content: '{"error":"Transition COMPLETE is not allowed"}' }]), null, 'a normal tool error')
  assert.equal(detectEkkoToolsMissing([{ role: 'tool', content: NOT_KNOWN('mcp__ekko_todo__ekko_todo__list_utodos') }, { role: 'user', content: '新问题' }, { role: 'assistant', content: '好的' }]), null, 'earlier turn only')
  for (const t of ['', '  ', '(empty)', '[SILENT]']) assert.equal(isHostEmptyPlaceholder(t), true, JSON.stringify(t))
  assert.equal(isHostEmptyPlaceholder('(empty) 其实有内容'), false)
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


async function endTurn(ctx, topicId, rows) {
  const sid = ctx.db.getTopic(1, 'default', topicId).chiefSessionId
  const s = ctx.sessions.get(sid)
  s.is_running = false
  for (const r of rows) s.messages.push({ id: `m-${s.messages.length}`, timestamp: ts(), ...r })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sid, finish_reason: 'stop' } }, ctx.run)
  return sid
}
const MISSING_TURN = [
  { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'tool_call' } }] },
  { role: 'tool', content: NOT_KNOWN('mcp__ekko_todo__ekko_todo__inspect_uproject_urepo') },
  { role: 'assistant', content: '(empty)', finish_reason: 'stop' },
]

test('0.9.63: the topic says the tools are not loaded and how to fix it, once per user message, with no resume', async () => {
  const ctx = setup()
  try {
    const topic = await chiefTopic(ctx)
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '派单 review 仓库' })
    const sid = ctx.db.getTopic(1, 'default', topic.id).chiefSessionId
    await endTurn(ctx, topic.id, MISSING_TURN)
    let notes = systemTexts(ctx, topic.id)
    assert.equal(notes.filter(t => t.startsWith('Ekko ToDo 工具没有加载到总管会话')).length, 1)
    assert.match(notes.find(t => t.startsWith('Ekko ToDo')), /mcp__ekko_todo__ekko_todo__inspect_uproject_urepo/)
    assert.match(notes.find(t => t.startsWith('Ekko ToDo')), /重启 Hermes Web UI/)
    assert.match(notes.find(t => t.startsWith('Ekko ToDo')), /更新到与 Web UI 配套的版本/)
    assert.ok(!notes.some(t => /没有结论|空回复/.test(t)), 'no generic empty-reply notice on top')
    assert.equal(chiefRuns(ctx, sid).length, 1, 'no automatic resume')
    // A wake in the same user message does not repeat the notice.
    await endTurn(ctx, topic.id, MISSING_TURN)
    assert.equal(systemTexts(ctx, topic.id).filter(t => t.startsWith('Ekko ToDo 工具没有加载')).length, 1)
    // The user tries again after restarting: if it still fails, they are told again.
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '重启了，再试' })
    await endTurn(ctx, topic.id, MISSING_TURN)
    assert.equal(systemTexts(ctx, topic.id).filter(t => t.startsWith('Ekko ToDo 工具没有加载')).length, 2)
  } finally { ctx.cleanup() }
})

test('0.9.63: a turn the host closed with "(empty)" gets the empty-reply notice (it was taken as a reply before)', async () => {
  const ctx = setup()
  try {
    const topic = await chiefTopic(ctx)
    await ctx.orch.sendTopicMessage(ctx.run, { topicId: topic.id, text: '部署进度如何' })
    await endTurn(ctx, topic.id, [{ role: 'assistant', content: '(empty)', finish_reason: 'stop' }])
    const notes = systemTexts(ctx, topic.id)
    assert.ok(notes.some(t => /没有结论/.test(t)), notes.join(' | '))
    assert.ok(!notes.some(t => t.startsWith('Ekko ToDo 工具没有加载')))
  } finally { ctx.cleanup() }
})

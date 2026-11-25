// Todo #22: the Chief repeated one sentence and re-read tool schemas for 7 minutes without calling the tool.
// The plugin now recognises that shape, stops the turn, writes a visible notice and frees the topic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { buildChiefInstructions } from '../src/server/prompts.mjs'

const pkgRoot = new URL('../', import.meta.url).pathname
const NOTICE = /^检测到重复输出，已中止本轮/

function makeFakeHost() {
  const sessions = new Map()
  const stopped = []
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create() { return { session: { id: 'unused' } } },
      async setWorkspace() { return { ok: true } },
      async setModel() { return { ok: true } },
      async run() { return { run_id: 'run-x' } },
      async stop(id) { stopped.push(id); const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id, opts = {}) {
        const list = sessions.get(id)?.messages || []
        return { messages: opts.limit ? list.slice(-opts.limit) : list }
      },
    },
  }
  return { host, sessions, stopped }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-loop-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 2 })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 2 }, log: { warn() {}, info() {} } })
  const fake = makeFakeHost()
  const run = { identity: { userId: 1, profile: 'default' }, host: fake.host, messages: { emit() {} } }
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
  const { topic } = await orch.createTopic(run, {})
  const session = { id: 'sess-chief', is_running: true, messages: [{ id: 'u1', role: 'user', content: '合并 #18', timestamp: 1 }] }
  fake.sessions.set('sess-chief', session)
  db.updateTopic(1, 'default', topic.id, { chiefSessionId: 'sess-chief', isRunning: true })
  let seq = 100
  // One model step as the host stores it: optional narration + one tool call, then the tool event.
  const step = async (narration, toolName, args = {}) => {
    session.messages.push({ id: `a${++seq}`, role: 'assistant', content: narration, tool_calls: [{ id: `c${seq}`, function: { name: toolName, arguments: JSON.stringify(args) } }], timestamp: seq })
    await orch.handleHostEvent({ type: 'chat.tool.started', subject: { session_id: 'sess-chief' }, summary: { tool_name: toolName } }, run)
    session.messages.push({ id: `t${++seq}`, role: 'tool', tool_name: toolName, content: '{}', timestamp: seq })
    await orch.handleHostEvent({ type: 'chat.tool.completed', subject: { session_id: 'sess-chief' }, summary: { tool_name: toolName } }, run)
  }
  const topicNow = () => db.getTopic(1, 'default', topic.id)
  const notices = () => topicNow().messages.filter(m => m.kind === 'system' && NOTICE.test(m.text))
  return { db, orch, fake, run, topic, session, step, topicNow, notices, cleanup: () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) } }
}

test('loop guard: the same sentence 3 times in a row with only schema reads stops the turn and leaves a notice', async () => {
  const ctx = await setup()
  try {
    const { fake, step, topicNow, notices, orch, run } = ctx
    const say = '审查通过，主仓已干净。现在合并 #18。'
    await step(say, 'tool_describe', { names: ['mcp__ekko_todo__merge_build'] })
    await step('', 'tool_describe', { names: ['ekko_studio_update_plan'] })
    await step(say, 'tool_describe', { names: ['mcp__ekko_todo__merge_build'] })
    assert.deepEqual(fake.stopped, [], 'two repeats are tolerated')
    assert.equal(notices().length, 0)

    await step(say, 'tool_describe', { names: ['mcp__ekko_todo__merge_build'] })
    assert.deepEqual(fake.stopped, ['sess-chief'], 'third repeat stops the host run')
    assert.equal(notices().length, 1, 'one system notice is stored in the topic')
    assert.match(notices()[0].text, /同一句话连续出现 3 次/)
    assert.match(notices()[0].text, /现在合并 #18/)
    assert.equal(topicNow().isRunning, false, 'topic is free to continue')
    assert.equal(topicNow().activeRunId, '')

    // Events of the stopped run that are still in flight neither revive the topic nor repeat the notice.
    await step(say, 'tool_describe', { names: ['mcp__ekko_todo__merge_build'] })
    await orch.handleHostEvent({ type: 'chat.message.created', subject: { session_id: 'sess-chief' } }, run)
    assert.equal(topicNow().isRunning, false)
    assert.equal(notices().length, 1)
    await orch.handleHostEvent({ type: 'chat.run.stopped', subject: { session_id: 'sess-chief' } }, run)
    assert.equal(topicNow().isRunning, false)
    assert.equal(notices().length, 1)

    // Plugin reloaded while the stopped run is still winding down: no second notice for the same turn.
    const orch2 = createOrchestrator({ db: ctx.db, dataDir: join(tmpdir(), 'ekko-loop-reload-unused'), config: {}, log: { warn() {}, info() {} } })
    await orch2.handleHostEvent({ type: 'chat.tool.started', subject: { session_id: 'sess-chief' }, summary: { tool_name: 'tool_describe' } }, run)
    assert.equal(notices().length, 1)
    assert.equal(topicNow().isRunning, false)
  } finally { ctx.cleanup() }
})

test('loop guard: 5 schema reads in a row with nothing executed end the turn; the loop cannot run on', async () => {
  const ctx = await setup()
  try {
    const { fake, orch, run, topicNow, notices } = ctx
    // Host tool events carry only the tool name; the transcript is not consulted for this path.
    const describe = () => orch.handleHostEvent({ type: 'chat.tool.started', subject: { session_id: 'sess-chief' }, summary: { tool_name: 'tool_describe' } }, run)
    for (let i = 0; i < 4; i += 1) await describe()
    assert.deepEqual(fake.stopped, [], 'four reads in a row are still allowed')
    await describe()
    assert.deepEqual(fake.stopped, ['sess-chief'], 'fifth read stops the turn')
    assert.equal(topicNow().isRunning, false)
    assert.match(notices()[0].text, /连续 5 次只读取工具说明、没有实际执行/)

    // The incident ran 101 reads. Replaying them after the stop changes nothing more.
    for (let i = 0; i < 96; i += 1) await describe()
    assert.equal(notices().length, 1, 'still exactly one notice')
    assert.equal(topicNow().isRunning, false, 'never flips back to running')

    // A new turn starts clean and is guarded again.
    ctx.session.messages.push({ id: 'u2', role: 'user', content: '继续', timestamp: 999 })
    await orch.handleHostEvent({ type: 'chat.run.started', subject: { session_id: 'sess-chief' } }, run)
    assert.equal(topicNow().isRunning, true)
    for (let i = 0; i < 5; i += 1) await describe()
    assert.equal(notices().length, 2)
    assert.equal(topicNow().isRunning, false)
  } finally { ctx.cleanup() }
})

test('loop guard: normal work is never stopped (read a schema, then call the tool)', async () => {
  const ctx = await setup()
  try {
    const { fake, step, topicNow, notices } = ctx
    for (let i = 0; i < 12; i += 1) {
      await step(`处理第 ${i + 1} 张卡。`, 'tool_describe', { names: ['mcp__ekko_todo__list_todos'] })
      await step('', 'tool_call', { calls: [{ name: 'mcp__ekko_todo__list_todos' }] })
    }
    // Four different schemas loaded up front, then real calls: still fine.
    for (const n of ['a', 'b', 'c', 'd']) await step('', 'tool_describe', { names: [n] })
    await step('', 'mcp__ekko_todo__merge_build', { todo_id: 't1' })
    // The same short status line while real tools run in between is not a stall.
    for (let i = 0; i < 4; i += 1) await step('继续核对下一项。', 'mcp__ekko_todo__get_todo_diff', { todo_id: `t${i}` })
    assert.deepEqual(fake.stopped, [])
    assert.equal(notices().length, 0)
    assert.equal(topicNow().isRunning, true)
  } finally { ctx.cleanup() }
})

test('loop guard: pure detection on the recorded incident shape', async () => {
  const g = await import('../src/shared/loop-guard.mjs')
  const a = (content, name) => ({ role: 'assistant', content, tool_calls: name ? [{ function: { name } }] : [] })
  const tool = { role: 'tool', content: '{}' }
  const say = '审查通过，主仓已干净。现在合并 #18。'
  const cycle = [a(say, 'tool_describe'), tool, a('', 'tool_describe'), tool, a('', 'tool_describe'), tool]
  assert.equal(g.detectChiefLoop([{ role: 'user', content: 'go' }, ...cycle]), null)
  // Whitespace differences do not hide a repeat.
  const v = g.detectChiefLoop([{ role: 'user', content: 'go' }, a(say, 'tool_search'), a(` ${say}\n`, 'tool_search'), a(say.replace('。现', '。 现'), 'tool_search')])
  assert.deepEqual({ kind: v.kind, count: v.count }, { kind: 'repeat-narration', count: 3 })
  // Only schema reads, no repeated sentence.
  assert.deepEqual(g.detectChiefLoop([...cycle, ...cycle.map(m => ({ ...m, content: m.role === 'tool' ? m.content : '' }))]), { kind: 'describe-only', count: 6 })
  // A user message starts a new turn: earlier repeats do not count.
  assert.equal(g.detectChiefLoop([a(say, 'tool_describe'), a(say, 'tool_describe'), { role: 'user', content: '继续' }, a(say, 'tool_describe')]), null)
  // With real calls in between the limit is higher, but still finite.
  const busy = n => Array.from({ length: n }, () => a('继续核对下一项。', 'terminal'))
  assert.equal(g.detectChiefLoop(busy(5)), null)
  assert.equal(g.detectChiefLoop(busy(6)).kind, 'repeat-narration')
  // Acknowledgements are too short to be an announcement.
  assert.equal(g.detectChiefLoop([a('好的', 'tool_describe'), a('好的', 'tool_describe'), a('好的', 'tool_describe')]), null)
  // MCP-prefixed bridge names are recognised.
  assert.equal(g.isSchemaOnlyTool('mcp__magpie__tool_describe'), true)
  assert.equal(g.isSchemaOnlyTool('tool_call'), false)

  // Client live stream: same rule over (text since last tool, tool) rounds.
  const tracker = g.createStreamLoopTracker()
  let text = ''
  let verdict = null
  for (let i = 0; i < 3; i += 1) { text += say; verdict = g.observeStreamTool(tracker, text, 'tool_describe') }
  assert.equal(verdict.kind, 'repeat-narration')
})

test('loop guard: Chief instructions carry the describe-then-call rule', () => {
  const text = buildChiefInstructions({
    topic: { id: 't', title: 'T', autopilot: true, isUserNamed: false },
    projects: [], agents: [], activeTodos: [], chiefAgent: {}, settings: {},
  })
  assert.match(text, /tool_describe/)
  assert.match(text, /IMMEDIATELY call that tool/)
  assert.match(text, /NEVER describe the same tool twice/)
  assert.match(text, /announc/i)
})

test('loop guard: the stop notice and the live warning render as visible rows and are wired into the chat pane', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ekko-loop-ui-'))
  try {
    const entry = join(workDir, 'entry.jsx')
    writeFileSync(entry, [
      `import React from 'react'`,
      `import { renderToStaticMarkup } from 'react-dom/server'`,
      `import { LoopStoppedNotice, LoopLiveNotice } from ${JSON.stringify(join(pkgRoot, 'src/client/components/LoopNotice.jsx'))}`,
      `export const stopped = text => renderToStaticMarkup(React.createElement(LoopStoppedNotice, { text }))`,
      `export const live = () => renderToStaticMarkup(React.createElement(LoopLiveNotice))`,
    ].join('\n'))
    const out = join(workDir, 'bundle.mjs')
    await build({
      entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
      nodePaths: [join(pkgRoot, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    })
    const ui = await import(pathToFileURL(out).href)
    const notice = '检测到重复输出，已中止本轮：同一句话连续出现 3 次（「现在合并 #18。」），没有新进展。发「继续」可让总管接着做。'
    const stopRow = ui.stopped(notice)
    assert.match(stopRow, /^<div class="ot-loop-notice" role="alert" data-testid="loop-stopped-notice">/)
    assert.ok(stopRow.includes('同一句话连续出现 3 次'))
    const liveRow = ui.live()
    assert.match(liveRow, /role="status" data-testid="loop-live-notice"/)
    assert.ok(liveRow.includes('检测到重复输出，正在中止本轮'))

    const pane = readFileSync(join(pkgRoot, 'src/client/components/ChatPane.jsx'), 'utf8')
    assert.match(pane, /message\.kind === 'system' && isLoopStopNotice\(message\.text\)[\s\S]{0,80}<LoopStoppedNotice text=\{message\.text\}/, 'stored notice gets its own row')
    assert.match(pane, /liveStream\?\.loop && <LoopLiveNotice \/>/, 'live warning sits in the streaming block')
    const app = readFileSync(join(pkgRoot, 'src/client/App.jsx'), 'utf8')
    // Since 0.9.50 the stream events are folded in stream-events.js; App.jsx calls it for live and replayed events.
    const events = readFileSync(join(pkgRoot, 'src/client/stream-events.js'), 'utf8')
    assert.match(events, /buf\.loop = observeStreamTool\(buf\.loopTracker, buf\.text, name\)/, 'the live stream is checked on every tool start')
    assert.match(app, /import \{ applyStreamEvent \} from '\.\/stream-events\.js'/, 'App.jsx uses that reducer')
    assert.equal(app.split('applyStreamEvent(buf, ').length - 1, 2, 'for live events and for the replay on resume')
    assert.match(app, /loop: cur\.loop/, 'the verdict reaches the rendered stream state')
    const css = readFileSync(join(pkgRoot, 'src/client/styles.css'), 'utf8')
    assert.match(css, /\.ot-loop-notice\s*\{/)
  } finally { rmSync(workDir, { recursive: true, force: true }) }
})

test('loop guard: release metadata is aligned and this change has its own changelog section', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(JSON.parse(read('contracts/plugin.json')).description.includes(`v${pkg.version}`))
  const changelog = read('CHANGELOG.md')
  const heads = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map(m => m[1])
  assert.equal(heads[0], pkg.version, 'newest changelog entry is the package version')
  assert.equal(new Set(heads).size, heads.length, 'no duplicated version heading')
  // Found by its own text, not by "newest version": later releases add their sections above this one.
  const mine = changelog.split(/^(?=## \[)/m).filter(sec => /^## \[\d+\.\d+\.\d+\]/.test(sec) && sec.includes('检测到重复输出，已中止本轮'))
  assert.ok(mine.length >= 1, 'a released changelog section describes the loop guard')
})

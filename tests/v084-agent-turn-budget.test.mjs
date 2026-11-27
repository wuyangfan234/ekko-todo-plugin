// #84 「不限」必须真不限: maxTurns 0 is sent as max_turns: 0 (never omitted), every explicit value is
// sent as-is, and the Agent editor shows the cap the host really enforces instead of implying that
// 「不限」 = "inherit the host default".
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator, readHostHermesMaxTurns } from '../src/server/orchestrator.mjs'
import {
  HOST_BRIDGE_DEFAULT_TURNS,
  MAX_AGENT_TURNS,
  TURN_PRESETS,
  clampAgentTurns,
  hostTurnBudget,
  turnBudgetNote,
  turnPresetLabel,
  turnRunOptions,
  turnSummary,
} from '../src/shared/turn-budget.mjs'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('turnRunOptions: max_turns is always present; 0 means unlimited and is sent, not omitted', () => {
  assert.deepEqual(turnRunOptions({ maxTurns: 0 }), { max_turns: 0 })
  assert.deepEqual(turnRunOptions({ maxTurns: 7 }), { max_turns: 7 })
  assert.deepEqual(turnRunOptions({ maxTurns: 650 }), { max_turns: 650 })
  assert.deepEqual(turnRunOptions({ maxTurns: 2000 }), { max_turns: 2000 })
  // missing agent / bad values fall to 0 (unlimited), over-range clamps to the stored maximum
  assert.deepEqual(turnRunOptions(null), { max_turns: 0 })
  assert.deepEqual(turnRunOptions({ maxTurns: 'abc' }), { max_turns: 0 })
  assert.deepEqual(turnRunOptions({ maxTurns: 5000 }), { max_turns: MAX_AGENT_TURNS })
  assert.equal(clampAgentTurns(-3), 0)
  assert.equal(clampAgentTurns(7.6), 8)
})

test('hostTurnBudget mirrors the Web UI bridge rule (env > positive config > 90); config 0 is NOT unlimited', () => {
  assert.deepEqual(hostTurnBudget({ configured: 500 }), { effective: 500, source: 'config', configured: 500 })
  assert.deepEqual(hostTurnBudget({ configured: 150 }), { effective: 150, source: 'config', configured: 150 })
  // bridge: int(agent.max_turns or max_turns or 90) -> 0 and absent both become 90
  assert.deepEqual(hostTurnBudget({ configured: 0 }), { effective: HOST_BRIDGE_DEFAULT_TURNS, source: 'bridge-default', configured: 0 })
  assert.deepEqual(hostTurnBudget({ configured: null }), { effective: 90, source: 'bridge-default' })
  assert.deepEqual(hostTurnBudget({ configured: 500, envOverride: '7' }), { effective: 7, source: 'env', configured: 500 })
  assert.deepEqual(hostTurnBudget({ configured: 500, envOverride: '0' }).source, 'config')
})

test('UI copy: 「不限」 is just 不限, summary shows the real cap, the note says how to change it', () => {
  assert.deepEqual(TURN_PRESETS, [0, 100, 300, 500, 1000, 2000])
  assert.equal(turnPresetLabel(0), '不限')
  assert.equal(turnPresetLabel(2000), '2000')
  const b500 = hostTurnBudget({ configured: 500 })
  assert.equal(turnSummary(0, b500), '轮次不限（实际 500）')
  assert.equal(turnSummary(7, b500), '7 轮（实际 500）')
  assert.equal(turnSummary(500, b500), '500 轮')
  assert.equal(turnSummary(0, null), '轮次不限')
  const note = turnBudgetNote(hostTurnBudget({ configured: 150 }))
  assert.match(note, /宿主实际生效上限：150 轮/)
  assert.match(note, /agent\.max_turns/)
  assert.match(note, /写 0 会被当成 90/)
  assert.equal(turnBudgetNote(null), '')
})

function initTempRepo(rootDir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: rootDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: rootDir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: rootDir, stdio: 'ignore' })
  writeFileSync(join(rootDir, 'README.md'), '# Sample Repo\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: rootDir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: rootDir, stdio: 'ignore' })
}

test('build dispatch sends max_turns 0 / 7 / 650 / 2000 exactly; stored value clamps to 0..2000', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ekko-v084-'))
  const repoDir = join(workDir, 'repo')
  try {
    execFileSync('mkdir', ['-p', repoDir])
    initTempRepo(repoDir)
    const db = createDatabase(join(workDir, 'data'))
    const orchestrator = createOrchestrator({ db, dataDir: join(workDir, 'data') })
    const runs = []
    let seq = 0
    const run = {
      identity: { userId: 1, profile: 'default' },
      messages: { emit() {} },
      host: {
        agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } } },
        async request() { return {} },
        sessions: {
          async create(body) { seq += 1; return { session: { id: `s-${seq}`, title: body.title } } },
          async setWorkspace() {}, async setModel() {}, async archive() {},
          async get(sid) { return { session: { id: sid, ended_at: null } } },
          async connect() { return { close() {} } },
          async run(sid, input, opts) { runs.push({ sid, opts }); return { run_id: `r-${runs.length}` } },
          async stop() {},
          async messages() { return { messages: [] } },
        },
      },
    }
    const { project } = await orchestrator.addProject(run, { name: 'demo', repoPath: repoDir })
    db.updateSettings(1, 'default', { maxConcurrentBuilds: 8 })

    // db clamp boundaries
    const { agent: clampHi } = await orchestrator.saveAgent(run, { name: 'clamp-hi', role: 'builder', engine: 'hermes', mode: 'scoped', maxTurns: 99999 })
    assert.equal(clampHi.maxTurns, 2000)
    const { agent: clampLo } = await orchestrator.saveAgent(run, { name: 'clamp-lo', role: 'builder', engine: 'hermes', mode: 'scoped', maxTurns: -5 })
    assert.equal(clampLo.maxTurns, 0)

    for (const maxTurns of [0, 7, 650, 2000]) {
      const { agent } = await orchestrator.saveAgent(run, { name: `turns-${maxTurns}`, role: 'builder', engine: 'hermes', mode: 'scoped', maxTurns })
      assert.equal(agent.maxTurns, maxTurns)
      const { todo } = await orchestrator.createTodo(run, { projectId: project.id, title: `t-${maxTurns}`, agentId: agent.id, startImmediately: true })
      const call = runs.find(r => r.sid === todo.buildSessionId)
      assert.ok(call, `build run dispatched for maxTurns=${maxTurns}`)
      assert.ok(Object.hasOwn(call.opts, 'max_turns'), `max_turns present for maxTurns=${maxTurns}`)
      assert.equal(call.opts.max_turns, maxTurns)
    }

    const snap = await orchestrator.getSnapshot(run)
    const b = snap.runtime.hostTurnBudget
    assert.ok(b && Number.isInteger(b.effective) && b.effective >= 1, 'snapshot reports the enforced host cap')
    assert.ok(['env', 'config', 'bridge-default'].includes(b.source))
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

// ── Real component render of the presets block ──
let workDir = ''
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })
async function renderPresets(props) {
  workDir = workDir || mkdtempSync(join(tmpdir(), 'ekko-v084-ui-'))
  const entry = join(workDir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import { TurnBudgetPresets } from ${JSON.stringify(join(pkgRoot, 'src/client/components/AgentManager.jsx'))}`,
    `export function render(props) { return renderToStaticMarkup(React.createElement(TurnBudgetPresets, { onPick() {}, ...props })) }`,
  ].join('\n'))
  const out = join(workDir, `bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'text' }, nodePaths: [join(pkgRoot, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  return (await import(pathToFileURL(out).href)).render(props)
}

test('Agent editor presets render: 不限 without the host default folded in, 2000 chip, real cap line', async () => {
  const html = await renderPresets({ value: 0, budget: { effective: 500, source: 'config', configured: 500 } })
  for (const v of [0, 100, 300, 500, 1000, 2000]) assert.match(html, new RegExp(`data-testid="btn-max-turns-${v}"`))
  assert.match(html, /data-testid="btn-max-turns-0">不限<\/button>/)
  assert.doesNotMatch(html, /不限（默认/)
  assert.match(html, /class="ot-role-chip is-active"[^>]*data-testid="btn-max-turns-0"/)
  assert.match(html, /data-testid="agent-host-turn-budget">宿主实际生效上限：500 轮/)
  const noBudget = await renderPresets({ value: 2000 })
  assert.match(noBudget, /class="ot-role-chip is-active"[^>]*data-testid="btn-max-turns-2000"/)
  assert.doesNotMatch(noBudget, /agent-host-turn-budget/)
  // the editor wires the shared helpers (no inline label that folds the host default into 不限)
  const jsx = readFileSync(join(pkgRoot, 'src/client/components/AgentManager.jsx'), 'utf8')
  assert.match(jsx, /<TurnBudgetPresets[\s\S]*?budget=\{state\?\.runtime\?\.hostTurnBudget\}/)
  assert.match(jsx, /turnSummary\(draft\.maxTurns, state\?\.runtime\?\.hostTurnBudget\)/)
})

test('readHostHermesMaxTurns reads HERMES_HOME first and accepts quoted values', () => {
  const home = mkdtempSync(join(tmpdir(), 'ekko-v084-hh-'))
  const prev = process.env.HERMES_HOME
  try {
    process.env.HERMES_HOME = home
    const cfg = body => writeFileSync(join(home, 'config.yaml'), body, 'utf8')
    cfg('model:\n  default: x\nagent:\n  max_turns: "500"\n  reasoning_effort: high\nother:\n  max_turns: 9\n')
    assert.equal(readHostHermesMaxTurns('default'), 500, 'double-quoted value')
    cfg("agent:\n  max_turns: '150'  # fresh install\n")
    assert.equal(readHostHermesMaxTurns('default'), 150, 'single-quoted value with comment')
    cfg('agent:\n  max_turns: 77\n')
    assert.equal(readHostHermesMaxTurns('default'), 77, 'bare value')
    cfg('agent:\n  max_turns: 0\n')
    assert.equal(readHostHermesMaxTurns('default'), 0, '0 is reported as configured 0')
    assert.deepEqual(hostTurnBudget({ configured: readHostHermesMaxTurns('default') }), { effective: 90, source: 'bridge-default', configured: 0 })
    cfg('agent:\n  max_turns: "5x"\n')
    assert.equal(readHostHermesMaxTurns('default'), null, 'malformed value is not guessed')
    // a profile config under HERMES_HOME wins over the root config
    mkdirSync(join(home, 'profiles', 'work'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'work', 'config.yaml'), 'agent:\n  max_turns: 321\n', 'utf8')
    assert.equal(readHostHermesMaxTurns('work'), 321)
    cfg('model:\n  default: x\n')
    assert.equal(readHostHermesMaxTurns('default'), null, 'absent key -> null')
  } finally {
    if (prev === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

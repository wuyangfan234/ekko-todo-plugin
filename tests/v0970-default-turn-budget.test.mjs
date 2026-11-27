// #92 插件默认轮次预算改为 500: an Agent created without maxTurns (editor draft, save-agent /
// configure_agent without the field, preset chief/builder/reviewer, team-preset workers) gets 500.
// Stored values — including an explicit 0 = 不限 — are never migrated. Plugin default only: the
// host config is not read for it and not written.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { DEFAULT_AGENT_TURNS, TURN_PRESETS } from '../src/shared/turn-budget.mjs'

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const read = rel => readFileSync(join(pkgRoot, rel), 'utf8')

function fakeRun() {
  return {
    identity: { userId: 1, profile: 'default' },
    messages: { emit() {}, notify() {} },
    host: {
      agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } } },
      async request() { return {} },
      sessions: {
        async create() { return { session: { id: 's-1' } } },
        async setWorkspace() {}, async setModel() {}, async run() { return { run_id: 'r-1' } }, async stop() {},
        async messages() { return { messages: [] } },
      },
    },
  }
}

test('#92 DEFAULT_AGENT_TURNS is 500 and the presets still offer 0 (不限) and 100/300/500/1000/2000', () => {
  assert.equal(DEFAULT_AGENT_TURNS, 500)
  assert.deepEqual(TURN_PRESETS, [0, 100, 300, 500, 1000, 2000])
})

test('#92 new Agent saved without maxTurns gets 500; explicit 0 (不限) is kept; update without the field keeps the stored value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-v092-'))
  try {
    const db = createDatabase(join(dir, 'data'))
    const orchestrator = createOrchestrator({ db, dataDir: join(dir, 'data') })
    const run = fakeRun()
    const { agent: fresh } = await orchestrator.saveAgent(run, { name: 'no-turns', role: 'builder', engine: 'hermes', mode: 'scoped' })
    assert.equal(fresh.maxTurns, 500)
    const { agent: unlimited } = await orchestrator.saveAgent(run, { name: 'unlimited', role: 'builder', engine: 'hermes', mode: 'scoped', maxTurns: 0 })
    assert.equal(unlimited.maxTurns, 0, 'chip 0 = 不限 can still be chosen')
    const { agent: renamed } = await orchestrator.saveAgent(run, { id: unlimited.id, name: 'unlimited-renamed', role: 'builder', engine: 'hermes', mode: 'scoped' })
    assert.equal(renamed.maxTurns, 0, 'updating without maxTurns keeps the stored 0')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#92 preset chief / builder / reviewer and team-preset workers default to 500', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-v092-preset-'))
  try {
    const db = createDatabase(join(dir, 'data'))
    const agents = db.ensureDefaultAgents(1, 'default', ['hermes'])
    for (const role of ['chief', 'builder', 'reviewer']) {
      const a = agents.find(x => x.role === role)
      assert.ok(a, `preset ${role} exists`)
      assert.equal(a.maxTurns, 500, `preset ${role} maxTurns`)
    }
    const orchestrator = createOrchestrator({ db, dataDir: join(dir, 'data') })
    const snap = await orchestrator.completeOnboarding(fakeRun(), { chiefEngine: 'hermes', teamPreset: 'newmedia', applyTeamPreset: true })
    const workers = snap.agents.filter(a => a.role === 'custom')
    assert.ok(workers.length > 0, 'team preset added workers')
    for (const w of workers) assert.equal(w.maxTurns, 500, `team worker ${w.name}`)
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#92 stored max_turns = 0 is not migrated when the database is reopened; column default is 500', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ekko-v092-mig-'))
  try {
    const dataDir = join(dir, 'data')
    const db = createDatabase(dataDir)
    const agents = db.ensureDefaultAgents(1, 'default', ['hermes'])
    const file = join(dataDir, 'ekko-todo.sqlite')
    let raw = new DatabaseSync(file)
    raw.prepare('UPDATE agents SET max_turns = 0 WHERE id = ?').run(agents[0].id)
    const zeroBefore = raw.prepare('SELECT COUNT(*) AS n FROM agents WHERE max_turns = 0').get().n
    raw.close()
    db.close()
    assert.equal(zeroBefore, 1)

    const reopened = createDatabase(dataDir) // runs CREATE TABLE IF NOT EXISTS + ensureColumn again
    raw = new DatabaseSync(file)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM agents WHERE max_turns = 0').get().n, zeroBefore, 'no 0 row rewritten')
    const col = raw.prepare('PRAGMA table_info(agents)').all().find(c => c.name === 'max_turns')
    assert.equal(String(col.dflt_value), '500')
    raw.close()
    assert.equal(reopened.listAgents(1, 'default').find(a => a.id === agents[0].id).maxTurns, 0)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

let uiDir = ''
after(() => { if (uiDir) rmSync(uiDir, { recursive: true, force: true }) })

test('#92 Agent editor: new-agent draft defaults to 500 and the 500 chip renders as selected', async () => {
  const jsx = read('src/client/components/AgentManager.jsx')
  const draft = jsx.slice(jsx.indexOf("description: '',\n      engine: configs[0].engine"), jsx.indexOf('setEditingCfgIndex(0)'))
  assert.match(draft, /maxTurns: DEFAULT_AGENT_TURNS,/, 'new-agent draft uses the shared default')
  uiDir = mkdtempSync(join(tmpdir(), 'ekko-v092-ui-'))
  const entry = join(uiDir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import { TurnBudgetPresets } from ${JSON.stringify(join(pkgRoot, 'src/client/components/AgentManager.jsx'))}`,
    `import { DEFAULT_AGENT_TURNS } from ${JSON.stringify(join(pkgRoot, 'src/shared/turn-budget.mjs'))}`,
    `export function render() { return renderToStaticMarkup(React.createElement(TurnBudgetPresets, { value: DEFAULT_AGENT_TURNS, onPick() {} })) }`,
  ].join('\n'))
  const out = join(uiDir, 'bundle.mjs')
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'text' }, nodePaths: [join(pkgRoot, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  const html = (await import(pathToFileURL(out).href)).render()
  assert.match(html, /class="ot-role-chip is-active"[^>]*data-testid="btn-max-turns-500"/)
  assert.equal((html.match(/is-active/g) || []).length, 1, 'only one chip selected')
  assert.match(html, /data-testid="btn-max-turns-0">不限<\/button>/)
})

test('#92 shipped bundles and contract carry the 500 default', () => {
  const server = read('dist/server.mjs')
  assert.match(server, /DEFAULT_AGENT_TURNS\s*=\s*500/)
  assert.match(server, /max_turns INTEGER NOT NULL DEFAULT 500/)
  assert.doesNotMatch(server, /max_turns INTEGER NOT NULL DEFAULT 24/)
  assert.match(read('dist/client.mjs'), /DEFAULT_AGENT_TURNS\s*=\s*500|=\s*500[,;]/)
  const contract = read('contracts/plugin.json')
  JSON.parse(contract)
  const desc = contract.match(/"maxTurns": \{ "type": "integer", "description": "([^"]+)"/)[1]
  assert.match(desc, /default 500 since 0\.9\.70 #92/)
  assert.match(desc, /never migrated/)
  assert.doesNotMatch(desc, /default 0\b/)
})

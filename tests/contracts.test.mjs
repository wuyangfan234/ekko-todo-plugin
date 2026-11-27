import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELEASE_VERSION_PATTERN, assertReleaseMetadata, checkReleaseMetadata, readReleaseMetadata } from './helpers/release-metadata.mjs'

// Patterns here describe the *shape* of a leak. The literal names of the maintainer's own machines, projects and
// accounts belong in an untracked `.private-denylist.json` (see .gitignore): a tracked list of real names would
// publish exactly what it exists to protect. Entries: [{ "label": "…", "pattern": "regex source" }], matched
// case-insensitively because they are names; the shape patterns below stay case-sensitive so an ordinary URL
// segment such as `/users/me/balance` is not read as a home directory. `me` / `user` / `example` are the
// placeholder user names the fixtures use, so a path built from one of those is not treated as a real account.
function loadPrivateMarkers(rootDir) {
  const markers = [
    /\/Users\/(?!me\b|user\b|example\b)[A-Za-z0-9_-]+/,
    /\/home\/(?!me\b|user\b|example\b)[A-Za-z0-9_-]+/,
    /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
    /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/,
  ]
  const file = join(rootDir, '.private-denylist.json')
  if (!existsSync(file)) return markers
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(raw), '.private-denylist.json must be an array')
  for (const entry of raw) {
    assert.equal(typeof entry?.pattern, 'string', '.private-denylist.json entries need a string pattern')
    markers.push(new RegExp(entry.pattern, 'i'))
  }
  return markers
}

test('the private marker list grows from an untracked file, and that file is kept out of the repository', () => {
  const pkgRoot = new URL('../', import.meta.url).pathname
  assert.match(readFileSync(join(pkgRoot, '.gitignore'), 'utf8'), /^\.private-denylist\.json$/m, 'the list must stay untracked')

  const dir = mkdtempSync(join(tmpdir(), 'ekko-todo-denylist-'))
  try {
    const base = loadPrivateMarkers(dir)
    assert.equal(base.length, 5, 'the shape patterns work without the file')
    assert.ok(base[0].test('/Users/someone/project'), 'a home path is caught')
    assert.ok(!base[0].test('/usr/local/share'), 'a system path is not')
    assert.ok(base[2].test('192.168.1.20') && !base[2].test('8.8.8.8'), 'private ranges only')

    writeFileSync(join(dir, '.private-denylist.json'), JSON.stringify([{ label: 'a maintainer-only name', pattern: 'acme-internal-\\d+' }]))
    const grown = loadPrivateMarkers(dir)
    assert.equal(grown.length, 6, 'an entry adds exactly one pattern')
    assert.ok(grown[5].test('acme-internal-42'))
    assert.ok(!grown[5].test('acme-public'), 'the entry is a real expression, not a substring match')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Todo #112: the only place that states what a consistent release is. No test compares the version to a
// fixed 0.9.x any more; tests of past releases call assertReleaseMetadata() from the same helper.
test('release metadata: the version is MAJOR.MINOR.PATCH and the five places agree', () => {
  const meta = readReleaseMetadata()
  const version = assertReleaseMetadata()
  assert.equal(version, meta.package)
  // The five places are really read from the repository (a helper that read nothing would pass above).
  for (const key of ['package', 'plugin', 'lock', 'lockRootPackage']) assert.equal(typeof meta[key], 'string', `${key} was read`)
  assert.ok(meta.contractDescription.length > 0)
  assert.equal('versionFile' in meta, existsSync(new URL('../VERSION', import.meta.url)), 'VERSION is compared exactly when the file exists')
})

test('release metadata: the check rejects each place that disagrees and every malformed version, and accepts any later release', () => {
  const ok = v => ({ package: v, plugin: v, lock: v, lockRootPackage: v, contractDescription: `Ekko ToDo v${v} contract.` })
  // Not tied to 0.9.x: the next minor, the next major and a pre-release all pass.
  for (const v of ['0.9.71', '0.10.0', '1.0.0', '12.34.56', '1.0.0-rc.1']) assert.equal(checkReleaseMetadata(ok(v)), v)
  // One place out of step at a time.
  const base = ok('0.10.0')
  assert.throws(() => checkReleaseMetadata({ ...base, plugin: '0.9.71' }), /plugin\.json/)
  assert.throws(() => checkReleaseMetadata({ ...base, lock: '0.9.71' }), /package-lock\.json version/)
  assert.throws(() => checkReleaseMetadata({ ...base, lockRootPackage: '0.9.71' }), /packages\[""\]/)
  assert.throws(() => checkReleaseMetadata({ ...base, contractDescription: 'Ekko ToDo v0.9.71 contract.' }), /contracts\/plugin\.json/)
  assert.throws(() => checkReleaseMetadata({ ...base, contractDescription: 'Ekko ToDo v0.10.01 contract.' }), /contracts\/plugin\.json/, 'a longer number is not a mention')
  assert.throws(() => checkReleaseMetadata({ ...ok('0.9.71'), package: '0.10.0' }), /plugin\.json/, 'package.json alone moved')
  assert.throws(() => checkReleaseMetadata({ ...base, versionFile: '0.9.71' }), /VERSION/)
  assert.equal(checkReleaseMetadata({ ...base, versionFile: '0.10.0' }), '0.10.0')
  assert.throws(() => checkReleaseMetadata({ ...base, lockRootPackage: undefined }), /packages\[""\]/, 'a missing place is a disagreement')
  // Malformed versions, even when every place agrees on them.
  for (const bad of ['0.10', '0.9.71.1', 'v0.9.71', '0.09.71', '0.9.x', '', ' 0.9.71', '0.9.71+build']) {
    assert.throws(() => checkReleaseMetadata(ok(bad)), /MAJOR\.MINOR\.PATCH|has a version/, `"${bad}" is rejected`)
    assert.equal(RELEASE_VERSION_PATTERN.test(bad), false)
  }
  assert.throws(() => checkReleaseMetadata(ok(undefined)), /has a version/)
})

// A test that pins the version to the number of the day it was written turns red on the next minor. Past
// releases assert a floor of nothing: they call assertReleaseMetadata().
test('release metadata: no test file pins the version to a fixed major or minor', () => {
  const dir = new URL('.', import.meta.url)
  const offenders = []
  for (const name of readdirSync(dir).filter(n => n.endsWith('.test.mjs') && n !== 'contracts.test.mjs')) {
    const lines = readFileSync(new URL(name, dir), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/\bmajor === \d+ && minor === \d+ &&/.test(line)) offenders.push(`${name}:${i + 1}`)
    })
  }
  assert.deepEqual(offenders, [], 'use assertReleaseMetadata() from tests/helpers/release-metadata.mjs')
})

test('dist/server.mjs loads standalone without node_modules and registers all 49 RPCs, 32 MCP tools, events, and scheduler', async () => {
  const pkgRoot = new URL('../', import.meta.url).pathname
  const isolated = mkdtempSync(join(tmpdir(), 'ekko-todo-standalone-'))
  try {
    for (const entry of ['plugin.json', 'package.json', 'assets', 'contracts', 'dist', 'sdk']) {
      cpSync(join(pkgRoot, entry), join(isolated, entry), { recursive: true })
    }
    const manifest = JSON.parse(readFileSync(join(isolated, 'plugin.json'), 'utf8'))
    assert.equal(manifest.icon, 'assets/logo.png')
    assert.equal(manifest.navigation.main[0].icon, 'assets/logo.png')
    const logoBytes = readFileSync(join(isolated, manifest.icon))
    assert.ok(logoBytes.length > 500 && logoBytes.length < 256000, 'logo PNG must exist and be under 256 KB Studio limit')
    assert.deepEqual([...logoBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'assets/logo.png must have valid PNG magic bytes')
    const { apply } = await import(join(isolated, 'dist/server.mjs'))
    assert.equal(typeof apply, 'function')

    const rpcs = new Map()
    const tools = new Map()
    const actions = new Map()
    const schedules = []
    const events = []

    const dispose = apply({
      paths: { dataDir: join(isolated, 'data') },
      config: { maxConcurrentBuilds: 2, reconcileIntervalMs: 5000 },
      extensions: {
        rpc: { register(name, fn) { rpcs.set(name, fn); return () => rpcs.delete(name) } },
        tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
        actions: { register(def) { actions.set(def.name, def); return () => actions.delete(def.name) } },
      },
      events: { on(pat, fn) { events.push(pat); return () => {} } },
      scheduler: { every(id, ms, action) { schedules.push({ id, ms, action }); return () => {} } },
      lifecycle: { add() {} },
      log: { info() {}, warn() {}, error() {} },
    })

    for (const rpcName of [
      'get-state',
      'get-model-catalog',
      'get-host-memory',
      'github-auth-status',
      'github-auth-start-device',
      'github-auth-save-token',
      'github-auth-logout',
      'list-github-repos',
      'upload-chat-file',
      'complete-onboarding',
      'sync-topic-session',
      'sync-session-isolation',
      'inspect-repo',
      'project-branches',
      'project-tree',
      'project-file',
      'project-commits',
      'project-commit-diff',
      'save-quota-provider',
      'delete-quota-provider',
      'refresh-quota-provider',
      'refresh-all-quotas',
      'get-token-usage',
      'save-schedule',
      'delete-schedule',
      'trigger-schedule',
      'add-project',
      'import-github-project',
      'save-agent',
      'clear-agent-cooldowns',
      'quick-configure-chief',
      'save-memory',
      'delete-memory',
      'create-topic',
      'update-topic',
      'clear-topic-waiting',
      'send-topic-message',
      'cancel-topic-queue-item',
      'promote-topic-queue-item',
      'todo-action',
    ]) {
      assert.ok(rpcs.has(rpcName), `missing RPC ${rpcName}`)
    }
    assert.equal(tools.size, 32, `expected 32 MCP tools, got ${tools.size}`)
    for (const adminTool of [
      'inspect_project_repo',
      'rename_topic',
      'update_topic_brief',
      'get_system_config',
      'configure_chief',
      'configure_agent',
      'delete_agent',
      'configure_project',
      'import_github_project',
      'list_memories',
      'manage_memory',
      'list_schedules',
      'create_schedule',
      'update_schedule',
      'delete_schedule',
    ]) {
      assert.ok(tools.has(adminTool), `missing Chief MCP tool ${adminTool}`)
    }
    assert.ok(actions.has('reconcile'))
    assert.ok(actions.has('settle'))
    assert.equal(schedules.length, 2)
    assert.equal(events[0], 'chat.*')

    const run = {
      identity: { userId: 1, profile: 'default' },
      host: { agents: { async list() { return { agents: [] } } } },
      messages: { emit() {}, notify() {} },
    }
    const snap = await rpcs.get('get-state')(null, run)
    assert.equal(snap.projects.length, 0, 'fresh install must have zero fake/mock projects')
    assert.equal(snap.todos.length, 0, 'fresh install must have zero fake/mock todos')
    assert.equal(snap.agents.length, 3, 'fresh install auto-creates clean engineering Agent set')
    assert.deepEqual(snap.agents.map(a => a.name), ['大总管', '开发 Agent', '审查 Agent'])
    assert.equal(snap.settings.chiefAuthority.canConfigureAgents, true)
    assert.ok(Array.isArray(snap.agents[0].modelConfigs) && snap.agents[0].modelConfigs.length >= 1)

    const toolRes = await tools.get('get_system_config').execute({}, run)
    assert.equal(toolRes.ok, true)
    assert.equal(typeof toolRes.content, 'string')
    assert.ok(toolRes.content.includes('大总管'))

    await assert.rejects(rpcs.get('get-state')({ extra: 1 }, run), /expected null/)
    dispose?.()
  } finally {
    rmSync(isolated, { recursive: true, force: true })
  }
})

test('dist/client.mjs is self-contained without relative imports and source tree contains zero personal paths or private markers', () => {
  const pkgRoot = new URL('../', import.meta.url).pathname
  const clientSrc = readFileSync(join(pkgRoot, 'dist/client.mjs'), 'utf8')
  assert.ok(!/^\s*import\s+.*from\s+['"]\./m.test(clientSrc), 'dist/client.mjs must be self-contained for Blob loading')
  assert.ok(/export\s*\{[^}]*\bmount\b/.test(clientSrc) || /export\s+async\s+function\s+mount\b/.test(clientSrc))

  const forbidden = loadPrivateMarkers(pkgRoot)
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.git', 'dist', 'sdk'].includes(name)) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else if (/\.(mjs|js|jsx|ts|css|json|md|yml)$/.test(name) && !full.endsWith('contracts.test.mjs') && !full.endsWith('package-lock.json') && !full.endsWith('.private-denylist.json')) {
        const text = readFileSync(full, 'utf8')
        for (const rx of forbidden) {
          assert.ok(!rx.test(text), `Personal/private pattern ${rx} leaked in ${full}`)
        }
      }
    }
  }
  walk(pkgRoot)
})

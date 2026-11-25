import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { readableLaunchFailure } from '../src/server/launch-failure.mjs'

const pkgRoot = new URL('../', import.meta.url).pathname
const read = rel => readFileSync(join(pkgRoot, rel), 'utf8')
const manifest = JSON.parse(read('plugin.json'))
const pkg = JSON.parse(read('package.json'))

// The exact envelope a Studio host without a usable engine runtime returned for the first Chief message.
const HOST_RUNTIME_ENVELOPE = '{"ok":false,"status":"failed","event":"run.failed","error":"Hermes Runtime is unavailable: Hermes Runtime is not installed or is incomplete. Open Runtime Manager to repair or download a Runtime.","session_id":"00000000-0000-4000-8000-000000000000","output":""}'

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: pkgRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean)
  } catch {
    return null // not a git checkout (for example a released archive)
  }
}

test('a missing engine runtime is explained in plain words instead of the raw host JSON', () => {
  const text = readableLaunchFailure(HOST_RUNTIME_ENVELOPE)
  assert.match(text, /^大总管没有启动/)
  assert.match(text, /Agent 管理/, 'points at the Studio page where the engine is installed')
  assert.match(text, /「Agent」页/, 'points at the plugin page where the Chief engine is changed')
  assert.match(text, /Hermes Runtime is unavailable/, 'keeps the host wording for support')
  for (const noise of ['"ok"', '"status"', 'session_id', 'run.failed', '{', '}']) {
    assert.ok(!text.includes(noise), `must not leak envelope noise ${noise}`)
  }
})

test('unknown launch errors keep the host wording and are never replaced by a guess', () => {
  assert.equal(readableLaunchFailure('HTTP 429 rate limit exceeded for some-model'), 'HTTP 429 rate limit exceeded for some-model')
  assert.equal(readableLaunchFailure('{"ok":false,"error":"Workspace must be an absolute path"}'), 'Workspace must be an absolute path')
  assert.equal(readableLaunchFailure('API Error 500: {"error":"boom"}'), 'boom')
  assert.equal(readableLaunchFailure('{not json'), '{not json')
  assert.match(readableLaunchFailure(''), /没有给出原因/)
  assert.match(readableLaunchFailure(undefined), /没有给出原因/)
  const long = readableLaunchFailure('x'.repeat(5000))
  assert.ok(long.length <= 301 && long.endsWith('…'), 'very long host text is clipped')
})

test('first Chief message on a host without a runtime stores and throws the readable text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-first-run-'))
  try {
    const db = createDatabase(join(root, 'data'))
    const orch = createOrchestrator({ db, dataDir: join(root, 'data') })
    let seq = 0
    const run = {
      identity: { userId: 1, profile: 'default' },
      messages: { emit() {}, notify() {} },
      host: {
        agents: { async list() { return { agents: [] } }, async models() { return { status: 'empty', models: [] } } },
        models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
        async request() { return null },
        sessions: {
          async create(input) { return { session: { id: `sess-${++seq}`, ...input } } },
          async setWorkspace() { return { ok: true } },
          async setModel() { return { ok: true } },
          async run() { throw new Error(HOST_RUNTIME_ENVELOPE) },
          async stop() { return { ok: true } },
          async get() { return null },
          async messages() { return { messages: [] } },
        },
      },
    }
    const created = await orch.createTopic(run, {})
    const topicId = created.state.topics[0].id
    await assert.rejects(
      () => orch.sendTopicMessage(run, { topicId, text: '你好' }),
      err => {
        assert.match(err.message, /^大总管没有启动/)
        assert.ok(!err.message.includes('"ok"'))
        assert.ok(err.cause instanceof Error && err.cause.message === HOST_RUNTIME_ENVELOPE, 'original host error is kept as cause')
        return true
      },
    )
    const topic = db.listTopics(1, 'default').find(t => t.id === topicId)
    assert.match(topic.lastError, /^大总管没有启动/)
    assert.ok(!topic.lastError.includes('{'), 'the chat banner never shows the JSON envelope')
    assert.equal(topic.isRunning, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the files a recipient gets (git-tracked only, no node_modules) pass the host install checks and load', async t => {
  const files = trackedFiles()
  if (!files) return t.skip('not a git checkout')
  // A bare `node_modules` entry is what a symlink to a shared install looks like in the index: `.gitignore` with
  // a trailing slash only matches directories, so such a link gets committed and then breaks this copy on a
  // machine where `node_modules` is a real directory.
  assert.ok(!files.some(f => f.split('/')[0] === 'node_modules'), 'node_modules must never be tracked, not even as a symlink')
  const handover = mkdtempSync(join(tmpdir(), 'ekko-todo-handover-'))
  try {
    for (const rel of files) {
      if (!existsSync(join(pkgRoot, rel))) continue // deleted in the working tree, not yet committed
      mkdirSync(dirname(join(handover, rel)), { recursive: true })
      cpSync(join(pkgRoot, rel), join(handover, rel))
    }
    assert.ok(!existsSync(join(handover, 'node_modules')))

    // Same checks the Studio 0.8.30 installer runs on a local directory before copying it.
    const m = JSON.parse(readFileSync(join(handover, 'plugin.json'), 'utf8'))
    const p = JSON.parse(readFileSync(join(handover, 'package.json'), 'utf8'))
    assert.equal(m.apiVersion, 1)
    assert.match(m.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
    assert.equal(p.version, m.version, 'Package and plugin versions must match')
    for (const entry of [m.server, m.client]) {
      assert.match(entry, /^[\w./-]+\.(?:mjs|js)$/)
      assert.ok(!isAbsolute(entry) && !entry.split('/').includes('..'))
      assert.ok(statSync(join(handover, entry)).isFile(), `${entry} must be committed, the host never builds an installed plugin`)
    }
    const icons = [m.icon, ...(m.views || []).map(v => v.icon), ...(m.navigation?.main || []).map(n => n.icon), ...(m.navigation?.settings || []).map(n => n.icon)]
      .filter(icon => typeof icon === 'string' && icon.includes('/'))
    assert.ok(icons.length > 0)
    for (const icon of icons) assert.ok(statSync(join(handover, icon)).size <= 256000, `${icon} exceeds the host 256 KB icon limit`)

    const server = await import(pathToFileURL(join(handover, m.server)).href)
    assert.equal(typeof server.apply, 'function')
    const client = readFileSync(join(handover, m.client), 'utf8')
    assert.ok(/export\s*\{[^}]*\bmount\b/.test(client) || /export\s+async\s+function\s+mount\b/.test(client))
    assert.ok(!/(?:^|[;\n])\s*import\s*(?:[\w${},*\s]+from\s*)?["'][^"']+["']/.test(client), 'client bundle must not import anything: the host loads it as a Blob module')
    const serverImports = [...readFileSync(join(handover, m.server), 'utf8').matchAll(/^import\s[^'"]*["']([^"']+)["']/gm)].map(x => x[1])
    assert.ok(serverImports.length > 0)
    for (const spec of serverImports) assert.match(spec, /^node:/, `server bundle imports ${spec}; only Node built-ins exist on the recipient machine`)
  } finally {
    rmSync(handover, { recursive: true, force: true })
  }
})

test('README and INSTALL agree with the manifest a recipient installs', () => {
  const install = read('INSTALL.md')
  const readme = read('README.md')
  assert.match(readme, /\(\.\/INSTALL\.md\)/, 'README links to the one install guide')
  assert.ok(!existsSync(join(pkgRoot, 'docs/INSTALL.md')), 'no parallel install guide')

  const nodeFloor = pkg.engines.node.replace(/^>=\s*/, '')
  for (const doc of [install, readme]) assert.ok(doc.includes(nodeFloor), `Node floor ${nodeFloor} from package.json must be stated`)
  for (const permission of manifest.permissions) assert.ok(install.includes(`\`${permission}\``), `INSTALL must list permission ${permission}`)

  const pageView = manifest.views.find(v => v.slot === 'page')
  const settingsView = manifest.views.find(v => v.slot === 'settings')
  assert.ok(install.includes(`/#/studio/plugins/${manifest.id}/${pageView.id}`))
  assert.ok(install.includes(`/#/studio/plugin-settings/${manifest.id}/${settingsView.id}`))
  assert.ok(install.includes(manifest.server) && install.includes(manifest.client))

  const contract = JSON.parse(read('contracts/plugin.json'))
  const toolCount = Object.keys(contract.tools || {}).length
  assert.ok(toolCount > 0)
  assert.ok(String(contract.description).includes(`${toolCount} MCP tools`), `contract description must state the real MCP tool count (${toolCount} MCP tools)`)
  assert.match(readme, new RegExp(`\\b${toolCount} tools\\b`, 'i'), `README must state the real MCP tool count (${toolCount})`)
  assert.ok(install.includes(`${toolCount} 个工具`), `INSTALL must state the real MCP tool count (${toolCount})`)

  // Every failure the guide tells the reader to recognise is quoted exactly as the host words it.
  for (const hostText of [
    'Local plugin source must be a directory',
    'Installing executable plugins requires a super administrator login',
    'Package and plugin versions must match',
    '此插件已禁用，请在插件中心启用。',
    '此页面不可用，请检查插件状态或页面地址。',
  ]) assert.ok(install.includes(hostText), `INSTALL must quote: ${hostText}`)
  for (const section of ['需要什么', '安装', '第一眼', '排查', '做不到', '卸载']) assert.ok(install.includes(section), `INSTALL section missing: ${section}`)
})

test('user-facing guides contain no machine-specific or private content', () => {
  const guides = ['README.md', 'INSTALL.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']
  const forbidden = [
    [/\/Users\/(?!you\b|<)[A-Za-z0-9._-]+/, 'macOS home directory'],
    [/\/home\/(?!you\b|user\b|<)[A-Za-z0-9._-]+/, 'Linux home directory'],
    [/[A-Za-z]:\\Users\\(?!you\b|<)[A-Za-z0-9._-]+/, 'Windows home directory'],
    [/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(?!:8648)/, 'private or loopback IP'],
    [/\b192\.168\.\d{1,3}\.\d{1,3}\b/, 'LAN IP'],
    [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, 'LAN IP'],
    [/\b(?:topic|proj|agent|todo|sess)-[0-9a-f]{8}\b/, 'private runtime id'],
    [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/, 'GitHub token'],
    [/\bsk-[A-Za-z0-9_-]{20,}/, 'API key'],
    [/Bearer\s+[A-Za-z0-9._-]{20,}/, 'bearer token'],
    [/\.hermes-web-ui\/plugins\/global\/versions\/[0-9a-f-]{36}/, 'installed-copy path of one machine'],
  ]
  for (const file of guides) {
    const lines = read(file).split('\n')
    lines.forEach((line, i) => {
      for (const [rx, label] of forbidden) assert.ok(!rx.test(line), `${file}:${i + 1} contains ${label}: ${line.slice(0, 120)}`)
    })
  }
})

test('a Chief message that failed to start takes back the optimistic running state', () => {
  // Structural check only: the behaviour itself was verified in a real Studio (spinner gone after the
  // failure banner appears). It guards the one branch that resets the live stream.
  const app = read('src/client/App.jsx')
  const start = app.indexOf('const handleSendTopicMessage = async payload => {')
  const end = app.indexOf('const handleAskChiefCreateAgent', start)
  assert.ok(start > 0 && end > start)
  const body = app.slice(start, end)
  assert.match(body, /const sent = await callRpc\(\s*'send-topic-message'/)
  const reset = body.slice(body.indexOf('if (sent === null && !alreadyRunning)'))
  assert.ok(reset.startsWith('if (sent === null && !alreadyRunning)'), 'failed send must reset the stream; an interrupt must not')
  assert.match(reset, /setLiveStream\(\{ \.\.\.EMPTY_STREAM, connected: streamBufRef\.current\.connected \}\)/)
  assert.ok(!/isWorking: true/.test(reset), 'the reset must not mark the stream as working')
})

test('listing GitHub repositories never leaves a non-JSON value in the board state', async () => {
  // Opening the "添加项目" dialog lists repositories. The result is cached into runtime.githubCli of the
  // next get-state snapshots; an explicit `undefined` there makes the host reject every snapshot
  // ("expected JSON data") for the 30 s the cache lives, which freezes the board for a first-time user.
  const root = mkdtempSync(join(tmpdir(), 'ekko-todo-gh-json-'))
  const savedPath = process.env.PATH
  try {
    const emptyBin = join(root, 'bin')
    mkdirSync(emptyBin, { recursive: true })
    process.env.PATH = emptyBin // no `gh` on PATH: unauthenticated answer, no network involved
    const db = createDatabase(join(root, 'data'))
    const orch = createOrchestrator({ db, dataDir: join(root, 'data') })
    const run = {
      identity: { userId: 1, profile: 'default' },
      messages: { emit() {}, notify() {} },
      host: { agents: { async list() { return { agents: [] } } }, async request() { return null } },
    }
    const listed = await orch.listGithubRepos(run, {})
    assert.ok(Array.isArray(listed.repos), 'the RPC answer itself still carries the list')
    const state = await orch.getSnapshot(run)
    const cli = state.runtime.githubCli
    const undefinedKeys = Object.keys(cli).filter(key => cli[key] === undefined)
    assert.deepEqual(undefinedKeys, [], 'optional JSON fields are omitted, never set to undefined')
    assert.ok(!('repos' in cli), 'the repository list is not part of the board state')
    assert.deepStrictEqual(JSON.parse(JSON.stringify(state.runtime)), state.runtime, 'runtime survives a JSON round trip unchanged')
  } finally {
    process.env.PATH = savedPath
    rmSync(root, { recursive: true, force: true })
  }
})

// 0.9.54 — three user reports:
//  A. Clean machine, no gh: saving a GitHub token blanked the plugin and nothing was saved.
//  B. Quota/subscription credentials only worked with macOS layouts; Windows/Linux users found nothing.
//  C. The Chief kept doing the work itself (and thinking at max effort) instead of dispatching.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { buildChiefInstructions } from '../src/server/prompts.mjs'
import {
  credentialCandidates, discoverStudioCredential, hermesHomes, readJsonFirst, usesMacKeychain,
} from '../src/server/credential-paths.mjs'
import { buildAugmentedEnv, resolveBinary } from '../src/server/git-engine.mjs'
import {
  CHIEF_INVESTIGATION_LIMIT, capReasoningEffort, classifyChiefTool, classifyChiefToolCall, createChiefTurnTracker, observeChiefTool,
} from '../src/shared/chief-guard.mjs'

const src = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

/* ───────────────────────── A. GitHub token on a clean machine ───────────────────────── */

test('A: the PAT box is not a <form> (it sits inside the import dialog form; nested forms submit natively = blank page)', () => {
  const card = src('src/client/components/GithubAuthCard.jsx')
  const code = card.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.equal((code.match(/<form\b/g) || []).length, 0, 'GithubAuthCard must not render a <form>')
  assert.match(card, /type="button"\s+onClick=\{handleSavePat\}/, 'submit is an explicit button click')
  assert.match(card, /e\.key === 'Enter'[^\n]*handleSavePat\(e\)/, 'Enter still saves')
  assert.match(card, /e\?\.stopPropagation\?\.\(\)/, 'the save never reaches an enclosing form')
  // The import dialog really does wrap the card in its own form — the reason this matters.
  const dialogs = src('src/client/components/Dialogs.jsx')
  const githubForm = dialogs.slice(dialogs.indexOf('<form onSubmit={submitGithub}'), dialogs.indexOf('</form>', dialogs.indexOf('<form onSubmit={submitGithub}')))
  assert.ok(githubForm.includes('<GithubAuthCard'), 'card is rendered inside the dialog form')
})

test('A: a render error shows an error panel instead of a blank plugin', () => {
  const index = src('src/client/index.jsx')
  assert.match(index, /class PluginErrorBoundary extends React\.Component/)
  assert.match(index, /static getDerivedStateFromError/)
  assert.match(index, /<PluginErrorBoundary><App ctx=\{wrapClientContext\(ctx\)\} \/><\/PluginErrorBoundary>/)
})

test('A: saving a PAT stores it, returns plain JSON and never echoes the token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-gh-'))
  const realFetch = globalThis.fetch
  globalThis.fetch = async url => {
    if (String(url) === 'https://api.github.com/user') return new Response(JSON.stringify({ login: 'octo' }), { status: 200 })
    return new Response('[]', { status: 200 })
  }
  try {
    const db = createDatabase(join(root, 'data'))
    const orch = createOrchestrator({ db, dataDir: join(root, 'data') })
    const run = { identity: { userId: 1, profile: 'default' }, host: { async request() { return null } }, messages: { emit() {} } }
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const res = await orch.saveGithubToken(run, { token })
    assert.equal(res.authenticated, true)
    assert.equal(res.authSource, 'pat')
    assert.equal(res.username, 'octo')
    assert.deepEqual(JSON.parse(JSON.stringify(res)), res, 'no undefined / non-JSON values')
    assert.ok(!JSON.stringify(res).includes(token), 'token not echoed')
    assert.equal(db.getGithubToken(1, 'default').token, token)
    const snap = await orch.getSnapshot(run)
    assert.ok(!JSON.stringify(snap).includes(token), 'token not in the board snapshot')
    db.close()
  } finally {
    globalThis.fetch = realFetch
    rmSync(root, { recursive: true, force: true })
  }
})

/* ───────────────────────── B. Cross-platform credentials ───────────────────────── */

const WIN = { platform: 'win32', home: 'C:\\Users\\example', env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local', APPDATA: 'C:\\Users\\example\\AppData\\Roaming' } }
const LINUX = { platform: 'linux', home: '/home/example', env: { XDG_CONFIG_HOME: '/home/example/.cfg' } }
const MAC = { platform: 'darwin', home: '/Users/example', env: {} }

test('B: per-OS candidate paths use the native separators and each CLI\'s env override', () => {
  assert.deepEqual(credentialCandidates('codex', WIN), ['C:\\Users\\example\\.codex\\auth.json'])
  assert.deepEqual(credentialCandidates('codex', { ...LINUX, env: { CODEX_HOME: '/opt/codex' } }), ['/opt/codex/auth.json', '/home/example/.codex/auth.json'])
  assert.deepEqual(credentialCandidates('claude', LINUX), ['/home/example/.claude/.credentials.json', '/home/example/.cfg/claude/.credentials.json'])
  assert.deepEqual(credentialCandidates('claude', { ...WIN, env: { ...WIN.env, CLAUDE_CONFIG_DIR: 'D:\\cc' } }), ['D:\\cc\\.credentials.json', 'C:\\Users\\example\\.claude\\.credentials.json'])
  assert.deepEqual(credentialCandidates('grok', MAC), ['/Users/example/.grok/auth.json'])
  assert.ok(credentialCandidates('kimi-config', WIN).includes('C:\\Users\\example\\AppData\\Roaming\\kimi\\config.toml'))
  assert.deepEqual(credentialCandidates('gemini', WIN), ['C:\\Users\\example\\.gemini\\oauth_creds.json'])
})

test('B: the macOS keychain is only consulted on darwin', () => {
  assert.equal(usesMacKeychain(MAC), true)
  assert.equal(usesMacKeychain(WIN), false)
  assert.equal(usesMacKeychain(LINUX), false)
  const engine = src('src/server/quota-engine.mjs')
  const at = engine.indexOf("'find-generic-password'")
  assert.ok(engine.lastIndexOf('if (usesMacKeychain()) {', at) > engine.lastIndexOf('async function discoverClaudeLocalAuth', at), '`security` only runs behind the darwin check')
})

test('B: Hermes (Ekko Studio) home follows Hermes itself: HERMES_HOME, %LOCALAPPDATA%\\hermes on Windows, profiles', () => {
  assert.deepEqual(hermesHomes(WIN), ['C:\\Users\\example\\AppData\\Local\\hermes', 'C:\\Users\\example\\.hermes'])
  assert.deepEqual(hermesHomes({ ...LINUX, env: { HERMES_HOME: '/srv/h' } }), ['/srv/h', '/home/example/.hermes'])
  assert.deepEqual(hermesHomes({ ...MAC, profile: 'work' }), ['/Users/example/.hermes/profiles/work', '/Users/example/.hermes'])
  assert.deepEqual(hermesHomes({ ...MAC, profile: 'default' }), ['/Users/example/.hermes'])
})

test('B: unreadable or malformed files are skipped, never thrown', () => {
  const files = { '/a.json': '{oops', '/b.json': '{"ok":1}' }
  const io = { exists: p => p in files, read: p => files[p] }
  assert.deepEqual(readJsonFirst(['/missing.json', '/a.json', '/b.json'], io), { path: '/b.json', data: { ok: 1 } })
  assert.equal(readJsonFirst(['/a.json'], { exists: () => true, read: () => { throw new Error('EACCES') } }), null)
})

test('B: Ekko Studio fallback reads the credential pool / provider state and rejects token types the quota API cannot use', () => {
  const home = 'C:\\Users\\example\\AppData\\Local\\hermes'
  const files = {
    [`${home}\\auth.json`]: JSON.stringify({
      providers: { 'openai-codex': { tokens: { access_token: 'eyJcodex', account_id: 'acc-1' } } },
      credential_pool: {
        'xai-oauth': [{ priority: 2, access_token: 'second' }, { priority: 0, access_token: 'eyJxai' }],
        anthropic: [{ access_token: 'sk-ant-api03-console-key' }],
        gemini: [{ access_token: 'AIza-api-key' }],
      },
    }),
    [`${home}\\.env`]: 'export DEEPSEEK_API_KEY="sk-ds"\nKIMI_API_KEY=\n',
  }
  const io = { exists: p => p in files, read: p => files[p] }
  const opts = { ...WIN, io }
  assert.deepEqual(discoverStudioCredential('codex', opts), { secret: 'eyJcodex', accountId: 'acc-1', sourceLabel: 'Ekko Studio 凭据' })
  assert.equal(discoverStudioCredential('grok', opts).secret, 'eyJxai', 'lowest priority number wins')
  assert.equal(discoverStudioCredential('claude', opts), null, 'console API key is not an OAuth token')
  assert.equal(discoverStudioCredential('antigravity', opts), null, 'Gemini API key is not a Google OAuth token')
  assert.equal(discoverStudioCredential('deepseek', opts).secret, 'sk-ds')
  assert.equal(discoverStudioCredential('kimi', opts), null, 'empty value is not a key')
  assert.equal(discoverStudioCredential('openrouter', opts), null)
})

test('B: quota probe falls back to Ekko Studio when no CLI login exists (any OS), and says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-quota-'))
  const saved = { HOME: process.env.HOME, HERMES_HOME: process.env.HERMES_HOME, USERPROFILE: process.env.USERPROFILE }
  const realFetch = globalThis.fetch
  const seen = []
  try {
    mkdirSync(join(root, 'home'), { recursive: true })
    mkdirSync(join(root, 'hermes'), { recursive: true })
    writeFileSync(join(root, 'hermes', 'auth.json'), JSON.stringify({ credential_pool: { 'xai-oauth': [{ access_token: 'eyJstudio' }] } }))
    process.env.HOME = join(root, 'home')
    process.env.USERPROFILE = join(root, 'home')
    process.env.HERMES_HOME = join(root, 'hermes')
    globalThis.fetch = async (url, opts = {}) => {
      seen.push({ url: String(url), auth: opts.headers?.Authorization || '' })
      if (String(url).includes('/v1/billing')) return new Response(JSON.stringify({ config: { creditUsagePercent: 12 } }), { status: 200 })
      return new Response(JSON.stringify({ email: 'x@example.com' }), { status: 200 })
    }
    const { probeSingleQuotaProvider } = await import(`../src/server/quota-engine.mjs?t=${Date.now()}`)
    const res = await probeSingleQuotaProvider({ id: 'grok', providerType: 'grok', name: 'Grok', sourceMode: 'auto', secretValue: '', endpoint: '' })
    assert.equal(res.sourceLabel, 'Ekko Studio 凭据')
    assert.ok(seen.some(s => s.auth === 'Bearer eyJstudio'), 'the Studio token was used')

    // Nothing anywhere: a clear message instead of a blank card or a throw.
    rmSync(join(root, 'hermes', 'auth.json'))
    const none = await probeSingleQuotaProvider({ id: 'codex', providerType: 'codex', name: 'Codex', sourceMode: 'local', secretValue: '', endpoint: '' })
    assert.equal(none.status, 'unconfigured')
    assert.match(none.error, /Ekko Studio/)
  } finally {
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(root, { recursive: true, force: true })
  }
})

test('B: git/gh PATH handling works on Windows (`;`, `Path` key, .exe)', () => {
  const env = buildAugmentedEnv({}, { platform: 'win32', env: { Path: 'C:\\Windows;C:\\Windows\\System32' }, home: 'C:\\Users\\example' })
  assert.equal(env.PATH, undefined, 'no second PATH key next to Path')
  assert.ok(env.Path.startsWith('C:\\Windows;C:\\Windows\\System32;'), 'existing entries kept intact')
  assert.ok(env.Path.split(';').includes('C:\\Program Files\\Git\\cmd'))
  assert.ok(!env.Path.split(';').some(p => p === 'C' || p === '\\Windows'), 'drive letters are not split off')
  const bin = resolveBinary('git', { platform: 'win32', env: {}, home: 'C:\\Users\\example', exists: p => p === 'C:\\Program Files\\Git\\cmd\\git.exe' })
  assert.equal(bin, 'C:\\Program Files\\Git\\cmd\\git.exe')
  const posix = buildAugmentedEnv({}, { platform: 'linux', env: { PATH: '/usr/bin' }, home: '/home/example' })
  assert.ok(posix.PATH.split(':').includes('/home/example/.local/bin'))
})

/* ───────────────────────── C. Chief only dispatches ───────────────────────── */

test('C: tool classification — board tools are orchestration, code work is forbidden, wrappers are seen through', () => {
  assert.equal(classifyChiefTool('mcp__ekko_todo__ekko_todo__create_utodo'), 'dispatch')
  assert.equal(classifyChiefTool('mcp__ekko_todo__ekko_todo__run_ubuild'), 'dispatch')
  assert.equal(classifyChiefTool('mcp__ekko_todo__ekko_todo__list_utodos'), 'orchestrate')
  assert.equal(classifyChiefTool('mcp__ekko_todo__inspect_project_repo'), 'orchestrate')
  for (const n of ['write_file', 'mcp__magpie__patch', 'apply_patch']) assert.equal(classifyChiefTool(n), 'write', n)
  for (const n of ['terminal', 'mcp__magpie__execute_code', 'browser_exec', 'Bash']) assert.equal(classifyChiefTool(n), 'execute', n)
  for (const n of ['delegate_task', 'mcp__magpie__delegate_task', 'Task']) assert.equal(classifyChiefTool(n), 'delegate', n)
  for (const n of ['read_file', 'search_files', 'web_search']) assert.equal(classifyChiefTool(n), 'read', n)
  assert.equal(classifyChiefTool('tool_describe'), 'meta')
  assert.deepEqual(classifyChiefToolCall('tool_call', JSON.stringify({ calls: [{ name: 'mcp__magpie__terminal' }] })), { category: 'execute', tool: 'terminal' })
  assert.deepEqual(classifyChiefToolCall('tool_call', JSON.stringify({ calls: [{ name: 'mcp__ekko_todo__ekko_todo__create_utodo' }] })), { category: 'dispatch', tool: 'create_utodo' })
})

test('C: investigation budget counts only code/web reads and resets on dispatch', () => {
  const t = createChiefTurnTracker()
  for (let i = 0; i < 30; i += 1) assert.equal(observeChiefTool(t, 'mcp__ekko_todo__ekko_todo__list_utodos'), null)
  for (let i = 0; i < CHIEF_INVESTIGATION_LIMIT; i += 1) assert.equal(observeChiefTool(t, 'read_file'), null)
  assert.equal(observeChiefTool(t, 'mcp__ekko_todo__ekko_todo__create_utodo'), null)
  for (let i = 0; i < CHIEF_INVESTIGATION_LIMIT; i += 1) assert.equal(observeChiefTool(t, 'search_files'), null)
  assert.deepEqual(observeChiefTool(t, 'read_file'), { kind: 'over-investigation', count: CHIEF_INVESTIGATION_LIMIT + 1 })
  assert.deepEqual(observeChiefTool(createChiefTurnTracker(), 'patch'), { kind: 'forbidden', tool: 'patch', category: 'write' })
})

test('C: reasoning effort cap', () => {
  assert.equal(capReasoningEffort('max', 'medium'), 'medium')
  assert.equal(capReasoningEffort('xhigh', 'high'), 'high')
  assert.equal(capReasoningEffort('low', 'medium'), 'low')
  assert.equal(capReasoningEffort('', 'medium'), 'medium', 'engine default is pinned to the cap')
  assert.equal(capReasoningEffort('max', ''), 'max', 'no cap')
})

function makeFakeHost() {
  const sessions = new Map()
  const stopped = []
  const runs = []
  const models = []
  const host = {
    agents: { async list() { return { agents: [{ id: 'hermes', name: 'Hermes', status: { installed: true }, modes: ['scoped'] }] } }, async models() { return { models: [] } } },
    models: { async list() { return { data: [] } }, async respond() { return { output_text: '' } } },
    async request() { return null },
    sessions: {
      async create() { return { session: { id: 'sess-new' } } },
      async setWorkspace() { return { ok: true } },
      async setModel(id, payload) { models.push({ id, ...payload }); return { ok: true } },
      async run(id, input, options) { runs.push({ id, input: String(input), options }); const s = sessions.get(id); if (s) s.is_running = true; return { run_id: `run-${runs.length}` } },
      async stop(id) { stopped.push(id); const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
      async get(id) { const s = sessions.get(id); return s ? { session: s, is_running: s.is_running } : null },
      async messages(id) { return { messages: sessions.get(id)?.messages || [] } },
    },
  }
  return { host, sessions, stopped, runs, models }
}

async function chiefSetup({ strict = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-guard-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, { maxConcurrentBuilds: 2 })
  const orch = createOrchestrator({ db, dataDir, config: { maxConcurrentBuilds: 2 }, log: { warn() {}, info() {} } })
  const fake = makeFakeHost()
  const run = { identity: { userId: 1, profile: 'default' }, host: fake.host, messages: { emit() {} } }
  db.getSettings(1, 'default')
  db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0, chiefStrictOrchestration: strict })
  const { topic } = await orch.createTopic(run, {})
  fake.sessions.set('sess-chief', { id: 'sess-chief', is_running: true, messages: [{ id: 'u1', role: 'user', content: '修一下登录 bug', timestamp: 1 }] })
  db.updateTopic(1, 'default', topic.id, { chiefSessionId: 'sess-chief', isRunning: true })
  const tool = (name, args) => orch.handleHostEvent({ type: 'chat.tool.started', subject: { session_id: 'sess-chief' }, summary: { tool_name: name }, data: args ? { arguments: args } : {} }, run)
  const topicNow = () => db.getTopic(1, 'default', topic.id)
  const guardNotices = () => topicNow().messages.filter(m => m.kind === 'system' && m.text.startsWith('总管越界，已中止本轮'))
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(r => setTimeout(r, 5)) }
  return { db, orch, fake, run, topic, tool, topicNow, guardNotices, settle, cleanup: () => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) } }
}

test('C: a Chief terminal/write call stops the turn and the Chief is sent back to dispatch', async () => {
  const ctx = await chiefSetup()
  try {
    const { fake, tool, topicNow, guardNotices, settle, orch, run } = ctx
    await tool('mcp__ekko_todo__ekko_todo__list_utodos')
    await tool('read_file')
    assert.deepEqual(fake.stopped, [], 'reading is allowed')
    await tool('terminal')
    await settle()
    assert.deepEqual(fake.stopped, ['sess-chief'], 'the run is stopped on the first forbidden call')
    assert.equal(guardNotices().length, 1)
    assert.match(guardNotices()[0].text, /terminal（自己跑命令\/代码）/)
    const correction = fake.runs.find(r => r.input.includes('[系统约束 · 自动纠偏]'))
    assert.ok(correction, 'a correction turn was launched')
    assert.match(correction.input, /create_todo/)
    assert.match(correction.input, /run_build/)
    assert.equal(topicNow().messages.filter(m => m.kind === 'human').length, 0, 'the correction is not shown as a user message')
    // Trailing events of the stopped run change nothing.
    await tool('write_file')
    assert.equal(guardNotices().length, 1)
    void orch; void run
  } finally { ctx.cleanup() }
})

test('C: automatic corrections are capped per user message; a new user message resets the count', async () => {
  const ctx = await chiefSetup()
  try {
    const { fake, tool, guardNotices, settle, orch, run, db, topic } = ctx
    const violate = async name => {
      await orch.handleHostEvent({ type: 'chat.run.started', subject: { session_id: 'sess-chief' } }, run)
      await tool(name)
      await settle()
      await orch.handleHostEvent({ type: 'chat.run.stopped', subject: { session_id: 'sess-chief' } }, run)
      await settle()
    }
    await violate('write_file')
    await violate('delegate_task')
    await violate('execute_code')
    const corrections = () => fake.runs.filter(r => r.input.includes('[系统约束 · 自动纠偏]')).length
    assert.equal(corrections(), 2, 'third violation is stopped without another automatic retry')
    assert.match(guardNotices().at(-1).text, /发「继续」/)
    // The user speaks again: the Chief gets a fresh allowance.
    db.updateTopic(1, 'default', topic.id, { isRunning: false })
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '按规矩派工' })
    await settle()
    await violate('patch')
    assert.equal(corrections(), 3)
  } finally { ctx.cleanup() }
})

test('C: reading on and on without dispatching is cut off; board reads and dispatches do not count', async () => {
  const ctx = await chiefSetup()
  try {
    const { fake, tool, guardNotices, settle } = ctx
    for (let i = 0; i < 20; i += 1) await tool('mcp__ekko_todo__ekko_todo__get_utodo_udiff')
    for (let i = 0; i < 8; i += 1) await tool('read_file')
    await tool('mcp__ekko_todo__ekko_todo__create_utodo')
    for (let i = 0; i < 8; i += 1) await tool('search_files')
    assert.deepEqual(fake.stopped, [])
    await tool('read_file')
    await settle()
    assert.deepEqual(fake.stopped, ['sess-chief'])
    assert.match(guardNotices()[0].text, /连续 9 次只读调查还没派工/)
    assert.ok(fake.runs.some(r => r.input.includes('调查到能写出验收标准就够了')))
  } finally { ctx.cleanup() }
})

test('C: strict orchestration off restores the old behaviour (nothing is stopped)', async () => {
  const ctx = await chiefSetup({ strict: false })
  try {
    const { fake, tool, guardNotices } = ctx
    await tool('write_file')
    await tool('terminal')
    for (let i = 0; i < 20; i += 1) await tool('read_file')
    assert.deepEqual(fake.stopped, [])
    assert.equal(guardNotices().length, 0)
  } finally { ctx.cleanup() }
})

test('C: the Chief run is launched with the effort cap (default medium) and the setting round-trips', async () => {
  const ctx = await chiefSetup()
  try {
    const { db, orch, run, fake, topic } = ctx
    assert.equal(db.getSettings(1, 'default').chiefEffortCap, 'medium')
    assert.equal(db.getSettings(1, 'default').chiefInvestigationLimit, 8)
    const chief = db.listAgents(1, 'default').find(a => a.role === 'chief') || db.ensureDefaultAgents(1, 'default', [{ id: 'hermes', installed: true }]).find(a => a.role === 'chief')
    db.upsertAgent(1, 'default', { ...chief, model: 'some-model', reasoningEffort: 'max', modelConfigs: [] })
    db.updateTopic(1, 'default', topic.id, { isRunning: false })
    fake.sessions.get('sess-chief').is_running = false
    await orch.sendTopicMessage(run, { topicId: topic.id, text: '看一下进度' })
    for (let i = 0; i < 20; i += 1) await new Promise(r => setTimeout(r, 5))
    const launched = fake.runs.at(-1)
    assert.ok(launched, 'chief run launched')
    assert.equal(launched.options.reasoning_effort, 'medium', 'max is capped to medium')
    assert.ok(fake.models.every(m => m.reasoning_effort !== 'max'), 'the session model is never set to max either')

    db.updateSettings(1, 'default', { chiefEffortCap: 'off', chiefInvestigationLimit: 99 })
    assert.equal(db.getSettings(1, 'default').chiefEffortCap, '')
    assert.equal(db.getSettings(1, 'default').chiefInvestigationLimit, 40, 'clamped')
    db.updateSettings(1, 'default', { chiefEffortCap: 'bogus' })
    assert.equal(db.getSettings(1, 'default').chiefEffortCap, 'medium')
  } finally { ctx.cleanup() }
})

test('C: the prompt states the dispatcher contract and the runtime enforcement', () => {
  const text = buildChiefInstructions({ settings: { chiefStrictOrchestration: true }, agents: [], projects: [], activeTodos: [], memories: [], chiefAgent: {}, topic: {} })
  assert.match(text, /YOU ARE A DISPATCHER, NOT A WORKER/)
  assert.match(text, /first such call stops your turn/)
  assert.match(text, /as soon as you can state the user's goal and how to verify it is done/)
  assert.match(text, /Keep reasoning short/)
  const loose = buildChiefInstructions({ settings: { chiefStrictOrchestration: false }, agents: [], projects: [], activeTodos: [], memories: [], chiefAgent: {}, topic: {} })
  assert.doesNotMatch(loose, /DISPATCHER, NOT A WORKER/)
})

test('C: settings contract accepts the two new fields', () => {
  const c = JSON.parse(src('contracts/plugin.json'))
  const p = c.models.saveSettingsInput.properties
  assert.ok(p.chiefEffortCap.enum.includes('medium') && p.chiefEffortCap.enum.includes(''))
  assert.equal(p.chiefInvestigationLimit.type, 'integer')
})

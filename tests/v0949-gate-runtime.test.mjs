// v0.9.49 (#45): the deterministic test gate runs on the node the worktree declares in `.node-version`, not on
// whichever `node` comes first on the PATH of the plugin host. The verdict names the node it ran on, a declared
// runtime that cannot be found is an explicit failure, and the names of the failed tests are kept on the card.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'
import { runDeterministicTestGate } from '../src/server/gate-runner.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- harness ---------------------------------------------------------------------------------------------

// A fake `node`: answers `--version` with the given version, anything else with a line naming itself.
// `broken` makes it die the way a node with a missing dylib does (rc=134, nothing on stdout).
function stubNode(root, name, version, { broken = false } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'node')
  writeFileSync(file, broken
    ? '#!/bin/sh\necho "dyld: Library not loaded" >&2\nexit 134\n'
    : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho "STUB ${version} $*"\n`)
  chmodSync(file, 0o755)
  return dir
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-gate-rt-'))
  const cwd = join(root, 'work')
  mkdirSync(cwd)
  const declare = text => writeFileSync(join(cwd, '.node-version'), text)
  // Only the stub directories and the three tools the commands use: no real node is reachable (a CI image may
  // have one in /usr/bin).
  const tools = join(root, 'tools')
  mkdirSync(tools)
  for (const name of ['cat', 'touch', 'sleep']) {
    const real = ['/bin', '/usr/bin'].map(d => join(d, name)).find(existsSync)
    assert.ok(real, `${name} exists on this machine`)
    symlinkSync(real, join(tools, name))
  }
  const gate = (dirs, command, extra = {}) => runDeterministicTestGate({
    cwd,
    command,
    timeoutMs: 20000,
    env: { PATH: [...dirs, tools].join(':'), HOME: root },
    nodeSearchDirs: [],
    ...extra,
  })
  return { root, cwd, declare, gate, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const tapFile = (root, lines) => {
  const file = join(root, 'out.tap')
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

// ---- 1. the declared runtime is the one that runs, wherever it sits on PATH -------------------------------

test('v0.9.49: the gate runs on the node declared in .node-version, not on the first node on PATH', async () => {
  const s = sandbox()
  try {
    const first = stubNode(s.root, 'bin26', 'v26.1.0')
    const declared = stubNode(s.root, 'bin22', 'v22.99.0')
    s.declare('22\n')
    const r = await s.gate([first, declared], 'node whoami')
    assert.equal(r.exitCode, 0)
    assert.match(r.outputTail, /STUB v22\.99\.0 whoami/, 'the command ran on the declared node')
    assert.doesNotMatch(r.outputTail, /STUB v26/, 'not on the first node on PATH')
    assert.equal(r.nodeVersion, 'v22.99.0')
    assert.equal(r.nodePath, join(declared, 'node'))
    assert.equal(r.nodeExpected, 'v22.x')
  } finally { s.cleanup() }
})

test('v0.9.49: the verdict names the node it ran on, for a pass, a failure and a timeout', async () => {
  const s = sandbox()
  try {
    const first = stubNode(s.root, 'bin26', 'v26.1.0')
    const declared = stubNode(s.root, 'bin22', 'v22.99.0')
    s.declare('v22.99\n')
    const pass = await s.gate([first, declared], 'echo fine')
    assert.match(pass.summary, /^Passed \(rc=0, \d+\.\ds, node v22\.99\.0\)/)
    const fail = await s.gate([first, declared], 'echo nope; exit 3')
    assert.match(fail.summary, /^Failed \(rc=3, \d+\.\ds, node v22\.99\.0\)/)
    const slow = await s.gate([first, declared], 'sleep 30', { timeoutMs: 5000 })
    assert.equal(slow.exitCode, 124)
    assert.match(slow.summary, /^Timed out after \d+s \(rc=124, node v22\.99\.0\)/)
  } finally { s.cleanup() }
})

test('v0.9.49: a node that cannot start is skipped; an exact declaration picks that exact version', async () => {
  const s = sandbox()
  try {
    const dead = stubNode(s.root, 'dead', 'v22.5.0', { broken: true })
    const near = stubNode(s.root, 'bin2298', 'v22.98.0')
    const exact = stubNode(s.root, 'bin2299', 'v22.99.0')
    s.declare('22.99.0')
    const r = await s.gate([dead, near, exact], 'node whoami')
    assert.equal(r.exitCode, 0)
    assert.match(r.outputTail, /STUB v22\.99\.0 whoami/)
    assert.equal(r.nodePath, join(exact, 'node'))
  } finally { s.cleanup() }
})

test('v0.9.49: the declared node is also found in the extra search directories when PATH has none', async () => {
  const s = sandbox()
  try {
    const first = stubNode(s.root, 'bin26', 'v26.1.0')
    const elsewhere = stubNode(s.root, 'opt22', 'v22.99.0')
    s.declare('22')
    const r = await s.gate([first], 'node whoami', { nodeSearchDirs: [elsewhere] })
    assert.equal(r.exitCode, 0)
    assert.match(r.outputTail, /STUB v22\.99\.0 whoami/)
    assert.match(r.summary, /node v22\.99\.0\)/)
  } finally { s.cleanup() }
})

// ---- 2. a declared runtime that is not there: explicit failure, no fallback -------------------------------

test('v0.9.49: a declared node that is not installed fails the gate with expected and found, and runs nothing', async () => {
  const s = sandbox()
  try {
    const first = stubNode(s.root, 'bin26', 'v26.1.0')
    const dead = stubNode(s.root, 'dead', 'v7.0.0', { broken: true })
    s.declare('7\n')
    const marker = join(s.root, 'ran')
    const r = await s.gate([dead, first], `touch "${marker}"`)
    assert.equal(r.executed, false)
    assert.equal(r.exitCode, 127)
    assert.ok(!existsSync(marker), 'the command was not run on some other node')
    assert.match(r.summary, /^Failed \(rc=127/)
    assert.match(r.summary, /期望 node v7\.x/, 'the summary names what was declared')
    assert.match(r.summary, /v26\.1\.0/, 'and what was found on PATH')
    assert.ok(r.summary.includes(join(first, 'node')), 'with the path it was found at')
    assert.match(r.summary, /无法启动/, 'a node that could not start is reported as such')
    assert.equal(r.nodeVersion, '')
    assert.deepEqual(r.failures, [])
  } finally { s.cleanup() }
})

test('v0.9.49: no node on PATH at all still says what was expected', async () => {
  const s = sandbox()
  try {
    s.declare('7')
    const r = await s.gate([], 'echo ran')
    assert.equal(r.exitCode, 127)
    assert.match(r.summary, /期望 node v7\.x/)
    assert.match(r.summary, /PATH 里没有 node/)
  } finally { s.cleanup() }
})

test('v0.9.49: a declaration that is empty or is not a plain version fails the gate instead of falling back to PATH', async () => {
  const s = sandbox()
  try {
    const first = stubNode(s.root, 'bin26', 'v26.1.0')
    const marker = join(s.root, 'ran')
    for (const text of ['', '\n# nothing here\n', 'lts/*\n', '>=22\n']) {
      s.declare(text)
      const r = await s.gate([first], `touch "${marker}"`)
      assert.equal(r.exitCode, 127, `declaration ${JSON.stringify(text)}`)
      assert.equal(r.executed, false)
      assert.match(r.summary, /\.node-version/)
      assert.match(r.summary, /没有声明可用的 node 版本/)
      assert.match(r.summary, /v26\.1\.0/, 'what PATH offers is still reported')
      assert.ok(!existsSync(marker))
    }
  } finally { s.cleanup() }
})

// ---- 2b. rework: a declaration that exists but cannot be read is not "no declaration" ---------------------

// Runs a gate against a sandbox whose .node-version was put in place by `place(file)`; one stub node (another
// line) is on PATH. The command must not run.
async function unreadableGate(s, place) {
  const first = stubNode(s.root, 'bin26', 'v26.1.0')
  place(join(s.cwd, '.node-version'))
  const marker = join(s.root, 'ran')
  const r = await s.gate([first], `touch "${marker}"`)
  assert.equal(r.exitCode, 127)
  assert.equal(r.executed, false)
  assert.ok(!existsSync(marker), 'the command was not run')
  assert.equal(r.nodeVersion, '', 'no node is reported as the one the gate ran on')
  assert.match(r.summary, /^Failed \(rc=127/)
  assert.match(r.summary, /\.node-version 存在但无法读取/)
  assert.doesNotMatch(r.summary, /未声明/, 'a declaration that is there is never reported as undeclared')
  assert.match(r.summary, /v26\.1\.0/, 'what PATH offers is still reported')
  return r
}

test('v0.9.49: a .node-version that is a directory fails the gate and runs nothing', async () => {
  const s = sandbox()
  try {
    const r = await unreadableGate(s, file => mkdirSync(file))
    assert.match(r.summary, /EISDIR/)
  } finally { s.cleanup() }
})

test('v0.9.49: a .node-version that is a dangling link fails the gate and runs nothing', async () => {
  const s = sandbox()
  try {
    const r = await unreadableGate(s, file => symlinkSync(join(s.root, 'not-there'), file))
    assert.match(r.summary, /链接指向的文件不存在/)
  } finally { s.cleanup() }
})

test('v0.9.49: a .node-version without read permission fails the gate and runs nothing', async t => {
  const s = sandbox()
  try {
    const probe = join(s.root, 'probe')
    writeFileSync(probe, '22\n')
    chmodSync(probe, 0o000)
    let readable = true
    try { readFileSync(probe, 'utf8') } catch { readable = false }
    // root and Windows read the file whatever its mode says.
    if (readable) { t.skip('this account reads a mode 000 file'); return }
    const r = await unreadableGate(s, file => { writeFileSync(file, '22\n'); chmodSync(file, 0o000) })
    assert.match(r.summary, /EACCES/)
  } finally { s.cleanup() }
})

// ---- 2c. rework: a declaration with a minor does not take a lower minor of the same major ------------------

test('v0.9.49: a major.minor declaration refuses a lower minor of the same major', async () => {
  const s = sandbox()
  try {
    const low = stubNode(s.root, 'bin225', 'v22.5.0')
    s.declare('22.13\n')
    const marker = join(s.root, 'ran')
    const r = await s.gate([low], `touch "${marker}"`)
    assert.equal(r.exitCode, 127)
    assert.equal(r.executed, false)
    assert.ok(!existsSync(marker))
    assert.match(r.summary, /期望 node v22\.13\.x/)
    assert.match(r.summary, /v22\.5\.0/)
  } finally { s.cleanup() }
})

// ---- 2d. rework: the selected node is an absolute path whatever PATH holds ---------------------------------

test('v0.9.49: a relative PATH entry gives an absolute node path, and the command runs on it', async () => {
  const s = sandbox()
  try {
    // Relative to the directory the command runs in (what the shell would do with it).
    stubNode(s.cwd, 'relbin', 'v22.99.0')
    s.declare('22\n')
    const r = await s.gate(['relbin'], 'node whoami')
    assert.equal(r.exitCode, 0)
    assert.ok(isAbsolute(r.nodePath), `absolute: ${r.nodePath}`)
    assert.ok(r.nodePath.endsWith(join('relbin', 'node')))
    assert.match(r.outputTail, /STUB v22\.99\.0 whoami/, 'the link put on PATH points at a node that runs')

    // Relative to the directory of the plugin host process.
    const hostSide = stubNode(s.root, 'hostbin', 'v22.98.0')
    s.declare('22.98\n')
    const rel = relative(process.cwd(), hostSide)
    assert.ok(!isAbsolute(rel))
    const h = await s.gate([rel], 'node whoami')
    assert.equal(h.exitCode, 0)
    assert.ok(isAbsolute(h.nodePath), `absolute: ${h.nodePath}`)
    assert.ok(h.nodePath.endsWith(join('hostbin', 'node')))
    assert.match(h.outputTail, /STUB v22\.98\.0 whoami/)
  } finally { s.cleanup() }
})

// ---- 2e. rework: resolving the node is bounded -------------------------------------------------------------

// A `node` that never answers: a wrapper script whose child keeps the output pipe open.
function hangingNode(root, name) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'node')
  writeFileSync(file, '#!/bin/sh\n/bin/sleep 20\n')
  chmodSync(file, 0o755)
  return dir
}

test('v0.9.49: resolving the node stops at its total budget: the gate fails with rc 127 instead of waiting on every node', async () => {
  const s = sandbox()
  try {
    const hung = ['h1', 'h2', 'h3'].map(n => hangingNode(s.root, n))
    const declared = stubNode(s.root, 'bin22', 'v22.99.0')
    s.declare('22\n')
    const marker = join(s.root, 'ran')
    const started = Date.now()
    const r = await s.gate([...hung, declared], `touch "${marker}"`, { nodeResolveTimeoutMs: 1500 })
    const took = Date.now() - started
    assert.ok(took < 5000, `returned in ${took} ms`)
    assert.equal(r.exitCode, 127)
    assert.equal(r.executed, false)
    assert.ok(!existsSync(marker))
    assert.match(r.summary, /^Failed \(rc=127, \d+\.\ds, node 未找到\) \| 期望 node v22\.x（\.node-version），解析超时：/)
    assert.match(r.summary, /未响应/)
    assert.ok(r.summary.length <= 600)
  } finally { s.cleanup() }
})

test('v0.9.49: two nodes that hang for 5 s each end in rc 127 well inside 20 s', async () => {
  const s = sandbox()
  try {
    const hung = ['h1', 'h2'].map(n => hangingNode(s.root, n))
    s.declare('22\n')
    const started = Date.now()
    const r = await s.gate(hung, 'echo should-not-run')
    const took = Date.now() - started
    assert.ok(took < 20000, `returned in ${took} ms`)
    assert.equal(r.exitCode, 127)
    assert.equal(r.executed, false)
    assert.match(r.summary, /期望 node v22\.x/)
    assert.match(r.summary, /未响应（/)
  } finally { s.cleanup() }
})

// ---- 2f. rework: a command that cannot be spawned still names the node -------------------------------------

test('v0.9.49: a command that fails to spawn names the node and keeps the summary inside its limit', async () => {
  const s = sandbox()
  try {
    const first = stubNode(s.root, 'bin26', 'v26.1.0')
    const r = await s.gate([first], 'echo x', { cwd: join(s.root, 'gone', 'x'.repeat(200), 'y'.repeat(200), 'z'.repeat(200), 'w'.repeat(200)) })
    assert.equal(r.exitCode, 127)
    assert.match(r.summary, /^Test command failed to spawn \(node v26\.1\.0 未声明\): /)
    assert.ok(r.summary.length <= 600, `summary is ${r.summary.length} characters`)
    assert.deepEqual(r.failures, [])
  } finally { s.cleanup() }
})

// Control: a project that declares nothing (most non-node projects) runs as before, and the verdict says so.
test('v0.9.49: without a .node-version file the command runs on PATH as before and the verdict says it is undeclared', async () => {
  const s = sandbox()
  try {
    const first = stubNode(s.root, 'bin26', 'v26.1.0')
    const second = stubNode(s.root, 'bin22', 'v22.99.0')
    const r = await s.gate([first, second], 'node whoami')
    assert.equal(r.exitCode, 0)
    assert.match(r.outputTail, /STUB v26\.1\.0 whoami/)
    assert.match(r.summary, /^Passed \(rc=0, \d+\.\ds, node v26\.1\.0 未声明\)/)
    assert.equal(r.nodeExpected, '')
    const none = await s.gate([], 'echo ok')
    assert.equal(none.exitCode, 0)
    assert.match(none.summary, /^Passed \(rc=0, \d+\.\ds, node 未声明\)/)
  } finally { s.cleanup() }
})

// ---- 3. failed test names ---------------------------------------------------------------------------------

test('v0.9.49: the names of the failed TAP tests are returned once each, in order', async () => {
  const s = sandbox()
  try {
    const out = tapFile(s.root, [
      'TAP version 13',
      'ok 1 - starts',
      '# Subtest: suite',
      '    not ok 1 - audit#11 answers in time',
      '      ---',
      "      error: 'not ok 9 - this is inside a YAML block'",
      '      ...',
      'not ok 2 - v0.9.42: message-todo answers inside its budget',
      'not ok 3 - skipped on purpose # SKIP no network',
      'not ok 4 - known gap # TODO later',
      'not ok 5 - v0.9.42: the same instruction twice',
      'not ok 6 - audit#11 answers in time',
      '1..6',
      '# fail 3',
    ])
    const r = await s.gate([], `cat "${out}"; exit 1`)
    assert.equal(r.exitCode, 1)
    assert.deepEqual(r.failures, [
      'audit#11 answers in time',
      'v0.9.42: message-todo answers inside its budget',
      'v0.9.42: the same instruction twice',
    ])
    assert.equal(r.failureCount, 3)
    assert.match(r.summary, /^Failed \(rc=1, .*\) \| 失败用例 3 条 \| # fail 3$/)
  } finally { s.cleanup() }
})

test('v0.9.49: spec reporter failures are read too, and the repeated "failing tests" section adds nothing', async () => {
  const s = sandbox()
  try {
    const out = tapFile(s.root, [
      '✔ starts (1.2ms)',
      '▶ suite',
      '  ✖ inner fails (3.4ms)',
      '✖ suite (5.6ms)',
      '\u001b[31m✖ coloured one (0.5ms)\u001b[39m',
      'ℹ fail 3',
      '',
      '✖ failing tests:',
      '',
      '✖ inner fails (3.4ms)',
      '  AssertionError: boom',
      '✖ coloured one (0.5ms)',
    ])
    const r = await s.gate([], `cat "${out}"; exit 1`)
    assert.deepEqual(r.failures, ['inner fails', 'suite', 'coloured one'])
    assert.equal(r.failureCount, 3)
  } finally { s.cleanup() }
})

test('v0.9.49: more than 8 failed tests keep the first 8 and count the rest; names early in a long output survive', async () => {
  const s = sandbox()
  try {
    const lines = []
    for (let i = 1; i <= 11; i += 1) {
      lines.push(`not ok ${i} - case ${i}`)
      // 4 KB of noise after each: the 24 KB capture window alone would have lost the first names.
      for (let j = 0; j < 40; j += 1) lines.push(`# ${'x'.repeat(100)}`)
    }
    const out = tapFile(s.root, lines)
    const r = await s.gate([], `cat "${out}"; exit 1`)
    assert.deepEqual(r.failures, [1, 2, 3, 4, 5, 6, 7, 8].map(i => `case ${i}`))
    assert.equal(r.failureCount, 11)
    assert.match(r.summary, /失败用例 11 条（列出前 8 条，另有 3 条）/)
  } finally { s.cleanup() }
})

test('v0.9.49: a passing command has no failed tests, even when its output mentions some', async () => {
  const s = sandbox()
  try {
    const out = tapFile(s.root, ['ok 1 - a', 'not ok 2 - printed by a test about TAP', 'ok 3 - c'])
    const r = await s.gate([], `cat "${out}"`)
    assert.equal(r.exitCode, 0)
    assert.deepEqual(r.failures, [])
    assert.equal(r.failureCount, 0)
    assert.doesNotMatch(r.summary, /失败用例/)
    const skipped = await runDeterministicTestGate({ cwd: s.cwd, command: '' })
    assert.deepEqual(skipped.failures, [])
  } finally { s.cleanup() }
})

// ---- 4. on the card ---------------------------------------------------------------------------------------

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-gate-card-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  let seq = 0
  const sessions = new Map()
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
        if (s) { s.is_running = true; s.messages.push({ id: `u-${++seq}`, role: 'user', content: input, timestamp: Math.floor(Date.now() / 1000) }) }
        return { run_id: `run-${++seq}` }
      },
      async stop(id) { const s = sessions.get(id); if (s) s.is_running = false; return { ok: true } },
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
  return { root, db, orch, run, sessions, cleanup }
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim()

async function complete(ctx, todoId) {
  const sessionId = ctx.db.getTodo(1, 'default', todoId).buildSessionId
  const s = ctx.sessions.get(sessionId)
  s.is_running = false
  s.messages.push({ id: `a-${s.messages.length}`, role: 'assistant', content: 'done', finish_reason: 'stop', timestamp: Math.floor(Date.now() / 1000) })
  await ctx.orch.handleHostEvent({ type: 'chat.run.completed', data: { session_id: sessionId, finish_reason: 'stop' } }, ctx.run)
  return ctx.db.getTodo(1, 'default', todoId)
}

test('v0.9.49: the card keeps the failed test names of a failed gate and drops them on the next dispatch and on a pass', async () => {
  const ctx = setup()
  const savedPath = process.env.PATH
  try {
    const { root, db, orch, run } = ctx
    // The repo under test declares a node line; a stub of that line sits behind a stub of another line on PATH.
    const first = stubNode(root, 'bin26', 'v26.1.0')
    const declared = stubNode(root, 'bin22', 'v22.99.0')
    process.env.PATH = [first, declared, savedPath].join(':')
    const repoPath = join(root, 'repo')
    mkdirSync(repoPath)
    git(repoPath, 'init', '-b', 'main'); git(repoPath, 'config', 'user.name', 'T'); git(repoPath, 'config', 'user.email', 't@e.x')
    writeFileSync(join(repoPath, 'a.txt'), 'base\n')
    writeFileSync(join(repoPath, '.node-version'), '22\n')
    git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'init')
    const gateScript = join(root, 'gate.sh')
    writeFileSync(gateScript, [
      'node whoami',
      'echo "not ok 1 - first broken"',
      'echo "ok 2 - fine"',
      'echo "not ok 3 - second broken"',
      'echo "not ok 4 - third broken"',
      'echo "not ok 5 - first broken"',
      'exit 1',
    ].join('\n') + '\n')

    db.getSettings(1, 'default')
    db.updateSettings(1, 'default', { quotaAutoRefreshMin: 0 })
    await orch.saveAgent(run, { name: '门禁测试 Agent', role: 'builder', engine: 'codex', modelConfigs: [{ id: 'cfg-1', label: '主力', engine: 'codex', mode: 'global', provider: 'p1', model: 'model-one', reasoningEffort: 'high' }] })
    const agent = db.listAgents(1, 'default').find(a => a.name === '门禁测试 Agent')
    const { project } = await orch.addProject(run, { name: 'P', repoPath, testCommand: `sh "${gateScript}"` })
    const { topic } = await orch.createTopic(run, { projectId: project.id, autopilot: false })
    const { todo } = await orch.createTodo(run, { projectId: project.id, topicId: topic.id, title: 'T', agentId: agent.id })
    assert.deepEqual(todo.evidence.testFailures, [], 'a new card has no failed tests')

    const built = await orch.startBuild(run, { todoId: todo.id })
    writeFileSync(join(built.worktreePath, 'a.txt'), 'round one\n')
    git(built.worktreePath, 'commit', '-am', 'one')
    const failed = await complete(ctx, todo.id)
    assert.equal(failed.phase, 'review')
    assert.equal(failed.gateOwner, 'human')
    assert.equal(failed.evidence.testRc, 1)
    assert.deepEqual(failed.evidence.testFailures, ['first broken', 'second broken', 'third broken'])
    assert.equal(failed.evidence.testFailureCount, 3)
    assert.match(failed.evidence.testSummary, /^Failed \(rc=1, \d+\.\ds, node v22\.99\.0\) \| 失败用例 3 条/)

    // The next dispatch clears them together with the verdict of the round before.
    const again = await orch.startBuild(run, { todoId: todo.id, extraMessage: '修掉失败的用例' })
    assert.equal(again.phase, 'building')
    assert.deepEqual(again.evidence.testFailures, [])
    assert.equal(again.evidence.testFailureCount, 0)

    // Put the old names back by hand: only the passing gate itself can remove them now.
    db.updateTodo(1, 'default', todo.id, { evidence: { testFailures: ['left over'], testFailureCount: 1 } })
    writeFileSync(gateScript, 'node whoami\necho "ok 1 - fine"\n')
    writeFileSync(join(again.worktreePath, 'a.txt'), 'round two\n')
    git(again.worktreePath, 'commit', '-am', 'two')
    const passed = await complete(ctx, todo.id)
    assert.equal(passed.phase, 'review')
    assert.equal(passed.evidence.testRc, 0)
    assert.deepEqual(passed.evidence.testFailures, [], 'nothing is left from the round before')
    assert.equal(passed.evidence.testFailureCount, 0)
    assert.match(passed.evidence.testSummary, /^Passed \(rc=0, \d+\.\ds, node v22\.99\.0\)/)
  } finally { process.env.PATH = savedPath; ctx.cleanup() }
})

// ---- 5. declaration, documents, version -------------------------------------------------------------------

test('v0.9.49: this repository declares one node line, not below the engines floor, and CI reads the same file', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const declared = readFileSync(join(repoRoot, '.node-version'), 'utf8').trim()
  assert.match(declared, /^\d+(\.\d+){0,2}$/, 'a plain version: major, major.minor or exact')
  const floor = pkg.engines.node.match(/^>=\s*(\d+)\.(\d+)\.(\d+)/)
  assert.ok(floor, 'engines.node keeps a >= floor (the Studio host process, not the test runtime)')
  // The declaration must not admit a version below the floor: `22` would match v22.5.0 while engines says
  // >=22.13.0, so the minor has to be written and is compared, and the patch too when it decides.
  const parts = declared.split('.').map(Number)
  const [fMajor, fMinor, fPatch] = floor.slice(1).map(Number)
  assert.ok(parts.length >= 2, 'the declaration names major.minor at least')
  assert.ok(parts[0] >= fMajor, 'the declared major is not below the floor')
  if (parts[0] === fMajor) {
    assert.ok(parts[1] >= fMinor, `the declared minor ${parts[1]} is not below the floor ${fMinor}`)
    if (parts[1] === fMinor && fPatch > 0) {
      assert.ok(parts.length === 3 && parts[2] >= fPatch, 'on the floor minor the patch must be named and not below the floor')
    }
  }
  const ci = readFileSync(join(repoRoot, '.github/workflows/check.yml'), 'utf8')
  assert.match(ci, /node-version-file:\s*\.node-version/)
  assert.doesNotMatch(ci, /node-version:\s*\d/, 'CI does not name a second version of its own')
})

test('v0.9.49: the runtime rule and the new evidence keys are documented', () => {
  const contracts = readFileSync(join(repoRoot, 'docs/CONTRACTS.md'), 'utf8')
  for (const word of ['since 0.9.49', '.node-version', 'testFailures', 'testFailureCount', '另有', 'dangling', '存在但无法读取', '解析超时', 'not below the floor']) {
    assert.ok(contracts.includes(word), `docs/CONTRACTS.md mentions ${word}`)
  }
  const install = readFileSync(join(repoRoot, 'INSTALL.md'), 'utf8')
  assert.ok(install.includes('.node-version'))
})

test('v0.9.49: version is 0.9.49 or later and agrees across the five places, changelog keeps its order', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugin.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'))
  const contract = JSON.parse(readFileSync(join(repoRoot, 'contracts/plugin.json'), 'utf8'))
  const [major, minor, patchNo] = pkg.version.split('.').map(Number)
  assert.ok(major > 0 || minor > 9 || (minor === 9 && patchNo >= 49), `version ${pkg.version} is 0.9.49 or later`)
  assert.equal(manifest.version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(contract.description.includes(`v${pkg.version} `))
  const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8')
  assert.ok(changelog.includes(`## [${pkg.version}]`))
  assert.ok(changelog.indexOf('## [0.9.49]') > 0)
  assert.ok(changelog.indexOf('## [0.9.49]') < changelog.indexOf('## [0.9.48]'))
  assert.ok(changelog.indexOf('## [0.9.48]') < changelog.indexOf('## [0.9.47]'))
})

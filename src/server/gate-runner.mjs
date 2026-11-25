import { execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

const MAX_CAPTURE_BYTES = 24 * 1024
// 0.9.49: failed test names kept on the card, and how many distinct names are tracked before counting stops.
export const MAX_TEST_FAILURES = 8
const MAX_TRACKED_FAILURES = 1000
const MAX_FAILURE_NAME_CHARS = 200
const MAX_SUMMARY_CHARS = 600
const NODE_DECLARATION_FILE = '.node-version'
const NODE_PROBE_TIMEOUT_MS = 5000
// Total time for finding the declared node, every `--version` call included.
const NODE_RESOLVE_TIMEOUT_MS = 15000

function killTree(child, signal) {
  if (!child?.pid) return
  // The command runs in its own process group (detached), so a negative pid reaches every
  // grandchild that may still hold stdout/stderr open (servers, watchers, `sleep`, test runners).
  try { process.kill(-child.pid, signal) } catch {
    try { child.kill(signal) } catch {}
  }
}

/**
 * 0.9.49: what the worktree declares in `.node-version`.
 * Returns null only when there is no such directory entry (the project pins nothing), otherwise
 * `{ parts, label }` for `22`, `22.13`, `22.13.0` (a leading `v` and a trailing `.x` are accepted),
 * `{ invalid: <first line> }` when the file is empty or holds anything else (`lts/*`, a range),
 * or `{ unreadable: <why> }` when the entry is there but cannot be read (a directory, no permission,
 * a dangling link).
 */
export function readNodeDeclaration(cwd) {
  const file = join(String(cwd || ''), NODE_DECLARATION_FILE)
  const why = err => String(err?.code || err?.message || 'unknown').slice(0, 80)
  // lstat, not stat: a dangling link is an entry that exists. Only "no such entry" means nothing is declared.
  try { lstatSync(file) } catch (err) {
    if (err?.code === 'ENOENT') return null
    return { unreadable: why(err) }
  }
  let text
  try { text = readFileSync(file, 'utf8') } catch (err) {
    // The entry is there (lstat succeeded), so ENOENT here is a link whose target is gone.
    return { unreadable: err?.code === 'ENOENT' ? '链接指向的文件不存在，ENOENT' : why(err) }
  }
  const line = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) || ''
  const m = line.match(/^v?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/i)
  if (!m) return { invalid: line.slice(0, 40) }
  const parts = [Number(m[1])]
  if (m[2] && m[2].toLowerCase() !== 'x') {
    parts.push(Number(m[2]))
    if (m[3] && m[3].toLowerCase() !== 'x') parts.push(Number(m[3]))
  }
  const label = `v${parts.join('.')}${parts.length < 3 ? '.x' : ''}`
  return { parts, label }
}

function versionMatches(version, parts) {
  const m = String(version).match(/^v(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  return parts.every((p, i) => Number(m[i + 1]) === p)
}

// Asks one node for its version. Resolves on its own timer: a wrapper script whose child keeps the output
// pipe open would otherwise hold the callback back long after the kill.
function probeNode(file, timeoutMs = NODE_PROBE_TIMEOUT_MS) {
  return new Promise(resolvePromise => {
    let done = false
    let child = null
    let timer = null
    const settle = result => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    timer = setTimeout(() => {
      killTree(child, 'SIGKILL')
      try { child?.stdout?.destroy() } catch {}
      try { child?.stderr?.destroy() } catch {}
      settle({ file, version: '', broken: true, timedOut: true })
    }, Math.max(1, timeoutMs))
    try {
      child = execFile(file, ['--version'], { windowsHide: true, detached: process.platform !== 'win32' }, (err, stdout) => {
        const version = String(stdout || '').trim().split('\n')[0] || ''
        if (!err && /^v\d+\.\d+\.\d+/.test(version)) settle({ file, version })
        else settle({ file, version: '', broken: true })
      })
    } catch {
      settle({ file, version: '', broken: true })
    }
  })
}

const nodeFileName = () => (process.platform === 'win32' ? 'node.exe' : 'node')

function pathDirs(env) {
  return String(env?.PATH ?? env?.Path ?? '').split(delimiter).filter(Boolean)
}

/**
 * Where a declared node may live besides PATH: the usual install locations of Homebrew and of the version
 * managers, for the declared major only. The host PATH of a desktop app often lacks them.
 */
function defaultNodeSearchDirs(env, major) {
  const home = String(env?.HOME || env?.USERPROFILE || homedir() || '')
  const dirs = [
    `/opt/homebrew/opt/node@${major}/bin`,
    `/usr/local/opt/node@${major}/bin`,
  ]
  const versioned = (base, suffix) => {
    let names = []
    try { names = readdirSync(base) } catch { return }
    names
      .filter(n => new RegExp(`^v?${major}\\.`).test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .forEach(n => dirs.push(join(base, n, suffix)))
  }
  if (home) {
    versioned(join(String(env?.NVM_DIR || join(home, '.nvm')), 'versions', 'node'), 'bin')
    versioned(join(home, '.volta', 'tools', 'image', 'node'), 'bin')
    versioned(join(home, '.local', 'share', 'fnm', 'node-versions'), join('installation', 'bin'))
    versioned(join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), join('installation', 'bin'))
    versioned(join(home, '.asdf', 'installs', 'nodejs'), 'bin')
    versioned(join(home, '.local', 'share', 'mise', 'installs', 'node'), 'bin')
    dirs.push(join(home, '.local', 'bin'))
  }
  dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  return dirs
}

/**
 * 0.9.49: pick the node the gate runs on.
 * - no `.node-version`: `{ declared: false }` plus the first node on PATH (version only, for the verdict);
 * - declared and found: `{ declared: true, expected, file, version }`, the first match on PATH, then in the
 *   search directories;
 * - declared and not found, the declaration is unusable or unreadable, or the search ran out of its total
 *   budget (`resolveTimeoutMs`): `{ declared: true, error }`. Never a fallback.
 * `file` is always an absolute path. It is not the realpath: a version manager's `node` may be a link to a
 * launcher that decides by the name it is called with.
 */
export async function resolveGateNode({ cwd, env = process.env, nodeSearchDirs, resolveTimeoutMs = NODE_RESOLVE_TIMEOUT_MS } = {}) {
  const declaration = readNodeDeclaration(cwd)
  const budgetMs = Math.max(0, Number(resolveTimeoutMs) || 0)
  const deadline = Date.now() + budgetMs
  // A relative PATH entry means "relative to where the command runs"; the host's own directory is tried too.
  const bases = [...new Set([resolve(String(cwd || '.')), process.cwd()])]
  const seen = new Set()
  const candidates = dirs => {
    const out = []
    for (const dir of dirs) {
      for (const base of (isAbsolute(dir) ? [''] : bases)) {
        const file = resolve(base, dir, nodeFileName())
        if (!existsSync(file)) continue
        // The same binary reached through two entries is asked once: the key is where it really is.
        let real = file
        try { real = realpathSync(file) } catch {}
        if (seen.has(real)) continue
        seen.add(real)
        out.push(file)
      }
    }
    return out
  }
  let checked = 0
  let outOfTime = false
  // null: the total budget is used up, nothing more is asked.
  const probe = async file => {
    const left = deadline - Date.now()
    if (left <= 0) { outOfTime = true; return null }
    checked += 1
    return probeNode(file, Math.min(NODE_PROBE_TIMEOUT_MS, left))
  }
  const onPath = candidates(pathDirs(env))

  if (!declaration) {
    // Only for the label in the verdict: the command runs on PATH whatever this finds.
    for (const file of onPath) {
      const probed = await probe(file)
      if (!probed) break
      if (!probed.broken) return { declared: false, expected: '', file, version: probed.version }
    }
    return { declared: false, expected: '', file: '', version: '' }
  }

  const found = []
  const describeFound = () => {
    if (!found.length) return 'PATH 里没有 node'
    const shown = found.slice(0, 3).map(p => `${p.timedOut ? '未响应' : p.broken ? '无法启动' : p.version}（${p.file}）`).join('、')
    return `当前 PATH 里找到的是 ${shown}${found.length > 3 ? ` 等 ${found.length} 个` : ''}`
  }
  for (const file of onPath) {
    const probed = await probe(file)
    if (!probed) break
    if (declaration.parts && !probed.broken && versionMatches(probed.version, declaration.parts)) {
      return { declared: true, expected: declaration.label, file, version: probed.version }
    }
    found.push(probed)
  }
  if (declaration.unreadable) {
    return {
      declared: true,
      expected: '',
      error: `${NODE_DECLARATION_FILE} 存在但无法读取（${declaration.unreadable}），未执行验收命令；${describeFound()}`,
    }
  }
  if (!declaration.parts) {
    return {
      declared: true,
      expected: '',
      error: `${NODE_DECLARATION_FILE} 没有声明可用的 node 版本（读到「${declaration.invalid}」，应为 22、22.13 或 22.13.0 这样的版本号）；${describeFound()}`,
    }
  }
  if (!outOfTime) {
    const extra = Array.isArray(nodeSearchDirs) ? nodeSearchDirs : defaultNodeSearchDirs(env, declaration.parts[0])
    for (const file of candidates(extra)) {
      const probed = await probe(file)
      if (!probed) break
      if (!probed.broken && versionMatches(probed.version, declaration.parts)) {
        return { declared: true, expected: declaration.label, file, version: probed.version }
      }
    }
  }
  if (outOfTime) {
    return {
      declared: true,
      expected: declaration.label,
      error: `期望 node ${declaration.label}（${NODE_DECLARATION_FILE}），解析超时：${Math.round(budgetMs / 1000)}s 内检查了 ${checked} 个 node 都不符合，其余未检查；${describeFound()}，未执行验收命令`,
    }
  }
  return {
    declared: true,
    expected: declaration.label,
    error: `期望 node ${declaration.label}（${NODE_DECLARATION_FILE}），${describeFound()}；常见安装目录里也没有 ${declaration.label}，未执行验收命令`,
  }
}

/**
 * 0.9.49: collects the names of failed tests from the output as it streams (the capture buffer keeps only the
 * tail). Reads TAP `not ok N - name` (`# SKIP` / `# TODO` are not failures) and the spec reporter's `✖ name`.
 * Names are deduplicated in order of first appearance; a trailing duration `(1.2ms)` is dropped.
 */
function createFailureCollector() {
  const names = []
  const seen = new Set()
  let pending = ''
  const readLine = raw => {
    const line = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r$/, '')
    let name = ''
    const tap = line.match(/^\s*not ok\b(?:\s+\d+)?(?:\s+-)?\s*(.*)$/)
    if (tap) {
      if (/\s#\s*(skip|todo)\b/i.test(tap[1])) return
      name = tap[1]
    } else {
      const spec = line.match(/^\s*✖\s+(.+)$/)
      if (!spec || /^failing tests:?$/.test(spec[1].trim())) return
      name = spec[1]
    }
    name = name.replace(/\s+\(\d+(?:\.\d+)?m?s\)\s*$/, '').trim().slice(0, MAX_FAILURE_NAME_CHARS)
    if (!name || seen.has(name) || seen.size >= MAX_TRACKED_FAILURES) return
    seen.add(name)
    if (names.length < MAX_TEST_FAILURES) names.push(name)
  }
  return {
    push(text) {
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() || ''
      // A line without a newline for this long is not a test result line.
      if (pending.length > 8192) pending = ''
      for (const l of lines) readLine(l)
    },
    end() {
      if (pending) readLine(pending)
      pending = ''
      return { failures: names.slice(), failureCount: seen.size }
    },
  }
}

/**
 * Zero-token deterministic pre-gate runner.
 * Executes a project's configured test command inside the isolated worktree with bounded timeout.
 * On timeout the whole process group is terminated and the promise resolves even if some
 * descendant keeps the pipes open, so a hung test can never pin a todo in 'building'.
 *
 * 0.9.49: the command runs on the node declared by `<cwd>/.node-version` (see resolveGateNode): a directory
 * holding only a `node` link to it is put first on the command's PATH. The result names that node
 * (`nodeVersion`, `nodePath`, and in `summary`), and carries the failed test names (`failures`, at most
 * MAX_TEST_FAILURES; `failureCount` is the number of distinct names). Finding the node has its own total
 * budget (NODE_RESOLVE_TIMEOUT_MS) and is counted in `durationMs`. `env`, `nodeSearchDirs` and
 * `nodeResolveTimeoutMs` exist for tests; callers leave them out.
 */
export async function runDeterministicTestGate({ cwd, command, timeoutMs = 180000, env = process.env, nodeSearchDirs, nodeResolveTimeoutMs }) {
  const trimmed = String(command || '').trim()
  if (!trimmed) {
    return {
      executed: false,
      exitCode: -1,
      durationMs: 0,
      summary: 'No test command configured for this project.',
      outputTail: '',
      failures: [],
      failureCount: 0,
      nodeVersion: '',
      nodePath: '',
      nodeExpected: '',
    }
  }

  const startedAt = Date.now()
  const runtime = await resolveGateNode({ cwd, env, nodeSearchDirs, ...(nodeResolveTimeoutMs === undefined ? {} : { resolveTimeoutMs: nodeResolveTimeoutMs }) })
  const nodeInfo = { nodeVersion: runtime.version || '', nodePath: runtime.file || '', nodeExpected: runtime.expected || '' }
  if (runtime.error) {
    const durationMs = Date.now() - startedAt
    return {
      executed: false,
      exitCode: 127,
      durationMs,
      summary: `Failed (rc=127, ${(durationMs / 1000).toFixed(1)}s, node 未找到) | ${runtime.error}`.slice(0, MAX_SUMMARY_CHARS),
      outputTail: runtime.error,
      failures: [],
      failureCount: 0,
      ...nodeInfo,
    }
  }
  const nodeLabel = runtime.declared
    ? `node ${runtime.version}`
    : `node ${runtime.version ? `${runtime.version} ` : ''}未声明`

  // Only the chosen node goes in front of PATH, not its whole directory: /usr/local/bin in front would also
  // reorder python, git and everything else the command resolves.
  let shimDir = ''
  const childEnv = { ...env, CI: '1' }
  if (runtime.declared) {
    try {
      shimDir = mkdtempSync(join(tmpdir(), 'ekko-gate-node-'))
      symlinkSync(runtime.file, join(shimDir, nodeFileName()))
      const pathKey = Object.keys(childEnv).find(k => k.toUpperCase() === 'PATH') || 'PATH'
      childEnv[pathKey] = [shimDir, childEnv[pathKey]].filter(Boolean).join(delimiter)
    } catch (err) {
      if (shimDir) { try { rmSync(shimDir, { recursive: true, force: true }) } catch {} }
      const durationMs = Date.now() - startedAt
      const why = `期望 node ${runtime.expected}（${NODE_DECLARATION_FILE}），已找到 ${runtime.version}（${runtime.file}），但无法把它放到命令的 PATH 最前：${err.message}`
      return {
        executed: false,
        exitCode: 127,
        durationMs,
        summary: `Failed (rc=127, ${(durationMs / 1000).toFixed(1)}s, node 未就绪) | ${why}`.slice(0, MAX_SUMMARY_CHARS),
        outputTail: why,
        failures: [],
        failureCount: 0,
        ...nodeInfo,
      }
    }
  }

  return new Promise(resolvePromise => {
    const child = spawn(trimmed, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    })

    let buf = ''
    let timedOut = false
    let settled = false
    const timers = []
    const collector = createFailureCollector()
    const append = chunk => {
      const text = chunk.toString('utf8')
      collector.push(text)
      buf += text
      if (buf.length > MAX_CAPTURE_BYTES) {
        buf = buf.slice(-MAX_CAPTURE_BYTES)
      }
    }

    const finish = result => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      try { child.stdout?.destroy() } catch {}
      try { child.stderr?.destroy() } catch {}
      if (shimDir) { try { rmSync(shimDir, { recursive: true, force: true }) } catch {} }
      resolvePromise(result)
    }

    const summarize = code => {
      const durationMs = Date.now() - startedAt
      const exitCode = timedOut ? 124 : (typeof code === 'number' ? code : 1)
      const lines = buf.trim().split('\n').filter(Boolean)
      const lastLine = lines[lines.length - 1] || ''
      // A command that passed has no failed tests, whatever its output printed.
      const collected = collector.end()
      const failures = exitCode === 0 ? [] : collected.failures
      const failureCount = exitCode === 0 ? 0 : collected.failureCount
      const more = failureCount - failures.length
      const failureNote = failureCount
        ? ` | 失败用例 ${failureCount} 条${more > 0 ? `（列出前 ${failures.length} 条，另有 ${more} 条）` : ''}`
        : ''
      const tail = lastLine ? ` | ${lastLine.slice(0, 140)}` : ''
      const seconds = (durationMs / 1000).toFixed(1)
      const summary = timedOut
        ? `Timed out after ${Math.round(durationMs / 1000)}s (rc=124, ${nodeLabel})${failureNote}`
        : exitCode === 0
          ? `Passed (rc=0, ${seconds}s, ${nodeLabel})${tail}`
          : `Failed (rc=${exitCode}, ${seconds}s, ${nodeLabel})${failureNote}${tail}`
      return { executed: true, exitCode, durationMs, summary, outputTail: buf.slice(-3000), failures, failureCount, ...nodeInfo }
    }

    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    timers.push(setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGTERM')
      timers.push(setTimeout(() => killTree(child, 'SIGKILL'), 3000))
      // Last resort: resolve even if a descendant escaped the group and still holds the pipes.
      timers.push(setTimeout(() => finish(summarize(124)), 5000))
    }, Math.max(5000, timeoutMs)))

    child.on('error', err => {
      finish({
        executed: true,
        exitCode: 127,
        durationMs: Date.now() - startedAt,
        summary: `Test command failed to spawn (${nodeLabel}): ${err.message}`.slice(0, MAX_SUMMARY_CHARS),
        outputTail: buf.slice(-2000),
        failures: [],
        failureCount: 0,
        ...nodeInfo,
      })
    })

    child.on('close', code => finish(summarize(code)))
    // The shell exited but a background descendant still holds the pipes: give it 2s to flush,
    // then reap the group and report the shell's own exit code.
    child.on('exit', code => {
      timers.push(setTimeout(() => {
        if (settled) return
        killTree(child, 'SIGKILL')
        finish(summarize(code))
      }, 2000))
    })
  })
}

import { spawn } from 'node:child_process'

const MAX_CAPTURE_BYTES = 24 * 1024

function killTree(child, signal) {
  if (!child?.pid) return
  // The command runs in its own process group (detached), so a negative pid reaches every
  // grandchild that may still hold stdout/stderr open (servers, watchers, `sleep`, test runners).
  try { process.kill(-child.pid, signal) } catch {
    try { child.kill(signal) } catch {}
  }
}

/**
 * Zero-token deterministic pre-gate runner.
 * Executes a project's configured test command inside the isolated worktree with bounded timeout.
 * On timeout the whole process group is terminated and the promise resolves even if some
 * descendant keeps the pipes open, so a hung test can never pin a todo in 'building'.
 */
export async function runDeterministicTestGate({ cwd, command, timeoutMs = 180000 }) {
  const trimmed = String(command || '').trim()
  if (!trimmed) {
    return {
      executed: false,
      exitCode: -1,
      durationMs: 0,
      summary: 'No test command configured for this project.',
      outputTail: '',
    }
  }

  const startedAt = Date.now()
  return new Promise(resolvePromise => {
    const child = spawn(trimmed, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    })

    let buf = ''
    let timedOut = false
    let settled = false
    const timers = []
    const append = chunk => {
      buf += chunk.toString('utf8')
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
      resolvePromise(result)
    }

    const summarize = code => {
      const durationMs = Date.now() - startedAt
      const exitCode = timedOut ? 124 : (typeof code === 'number' ? code : 1)
      const lines = buf.trim().split('\n').filter(Boolean)
      const lastLine = lines[lines.length - 1] || ''
      const summary = timedOut
        ? `Timed out after ${Math.round(durationMs / 1000)}s (rc=124)`
        : exitCode === 0
          ? `Passed (rc=0, ${(durationMs / 1000).toFixed(1)}s)${lastLine ? ` | ${lastLine.slice(0, 140)}` : ''}`
          : `Failed (rc=${exitCode}, ${(durationMs / 1000).toFixed(1)}s)${lastLine ? ` | ${lastLine.slice(0, 140)}` : ''}`
      return { executed: true, exitCode, durationMs, summary, outputTail: buf.slice(-3000) }
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
        summary: `Test command failed to spawn: ${err.message}`,
        outputTail: buf.slice(-2000),
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

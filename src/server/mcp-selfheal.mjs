// #122: self-heal of the plugin's own MCP server after a Web UI restart.
//
// The host's MCP bridge asks the plugin host for the tool catalogue with a 5 s timeout while the Web UI is
// still starting; on a timeout it answers an empty list and never asks again (no tools/list_changed). The
// `ekko-todo` server then stays connected with 0 tools until somebody reloads it by hand. The plugin cannot
// change that code, but it may call the host API: once it is up it looks at its own server and, when that
// exact signature shows (connected, no error, 0 tools), reloads this one server. Nothing else is reloaded.
//
// Bounded on purpose: one check chain per activation, a 90 s window, at most 2 reloads, 60 s apart.

export const MCP_SERVER_NAME = 'ekko-todo'
export const MCP_SERVERS_PATH = '/api/hermes/mcp/servers'
export const MCP_RELOAD_PATH = '/api/hermes/mcp/reload'
export const MCP_SELFHEAL_ENV = 'EKKO_TODO_MCP_SELFHEAL'
export const MCP_SELFHEAL_LOG_PREFIX = '[mcp-selfheal]'

export const MCP_SELFHEAL_FIRST_CHECK_MS = 5000
export const MCP_SELFHEAL_POLL_MS = 5000
export const MCP_SELFHEAL_WINDOW_MS = 90000
export const MCP_SELFHEAL_MAX_RELOADS = 2
export const MCP_SELFHEAL_RELOAD_COOLDOWN_MS = 60000
export const MCP_SELFHEAL_RECHECK_MS = 2000

/** `EKKO_TODO_MCP_SELFHEAL=0` turns the self-heal off entirely; anything else (or unset) leaves it on. */
export function isMcpSelfHealEnabled(env = process.env) {
  return env?.[MCP_SELFHEAL_ENV] !== '0'
}

function serverList(servers) {
  if (Array.isArray(servers)) return servers
  if (servers && typeof servers === 'object' && Array.isArray(servers.servers)) return servers.servers
  return []
}

/** Tools the host reports for a server entry: the largest of the counters it carries (number or name list). */
export function mcpToolCount(entry) {
  if (!entry || typeof entry !== 'object') return 0
  let count = 0
  for (const key of ['tools', 'tools_registered', 'tool_names', 'tool_names_registered']) {
    const value = entry[key]
    const n = Array.isArray(value) ? value.length : Number(value)
    if (Number.isFinite(n) && n > count) count = n
  }
  return count
}

/**
 * What to do about the `ekko-todo` MCP server, given the host's server list.
 * @param {unknown} servers answer of GET /api/hermes/mcp/servers: an array, or `{ servers: [] }`
 * @param {{ reloads?: number, lastReloadAt?: number | null }} state reloads already sent in this activation
 * @param {number} now ms
 * @returns {{ action: 'wait' | 'reload' | 'stop', reason: string }}
 */
export function decideMcpSelfHeal(servers, state, now) {
  const entry = serverList(servers).find(s => s && typeof s === 'object' && s.name === MCP_SERVER_NAME)
  // A reload does not create a server that is not configured: keep looking until the window ends.
  if (!entry) return { action: 'wait', reason: 'server-missing' }
  if (mcpToolCount(entry) > 0) return { action: 'stop', reason: 'tools-present' }
  // Another fault (the transport failed, the runtime has no MCP module...): a reload is not known to cure it,
  // and reloading would hide it. Report and leave it alone.
  if (entry.error !== undefined && entry.error !== null && String(entry.error).trim() !== '') return { action: 'stop', reason: 'server-error' }
  // Still starting or not connected yet: the tools may simply not have been listed. Not the fault we heal.
  if (entry.connected !== true) return { action: 'wait', reason: 'not-connected' }
  // The signature: connected, no error, 0 tools.
  const reloads = Number(state?.reloads) || 0
  if (reloads >= MCP_SELFHEAL_MAX_RELOADS) return { action: 'wait', reason: 'reload-limit' }
  const last = state?.lastReloadAt
  if (reloads > 0 && Number.isFinite(last) && now - last < MCP_SELFHEAL_RELOAD_COOLDOWN_MS) return { action: 'wait', reason: 'reload-cooldown' }
  return { action: 'reload', reason: 'connected-without-tools' }
}

function defaultSchedule(fn, ms) {
  const timer = setTimeout(fn, ms)
  timer?.unref?.()
  return () => clearTimeout(timer)
}

// Only the status and a short message of a failed request are logged: the answer of the servers endpoint
// carries every server's raw configuration, which never goes to the log.
function errorInfo(err) {
  const info = { error: String(err?.message || err || 'unknown').slice(0, 200) }
  if (Number.isFinite(err?.status)) info.status = err.status
  return info
}

/**
 * Starts the bounded check chain. Returns a disposer; after it ran no timer fires and no request is sent.
 * @param {{ request: (path: string, options?: object) => Promise<unknown>, log?: object,
 *   schedule?: (fn: () => void, ms: number) => () => void, now?: () => number, enabled?: boolean }} options
 */
export function startMcpSelfHeal({ request, log, schedule = defaultSchedule, now = Date.now, enabled = isMcpSelfHealEnabled() } = {}) {
  if (!enabled || typeof request !== 'function') return () => {}

  const state = { reloads: 0, lastReloadAt: null }
  const startedAt = now()
  let disposed = false
  let cancelTimer = null

  const say = (level, text, data) => {
    try { log?.[level]?.(`${MCP_SELFHEAL_LOG_PREFIX} ${text}`, data) } catch {}
  }
  const plan = (ms) => {
    if (disposed) return
    cancelTimer = schedule(() => { cancelTimer = null; void tick() }, ms)
  }
  const finish = () => { disposed = true }
  // After a check that asks to wait: poll again, or give up when the next poll would fall outside the window.
  const waitOrGiveUp = (reason) => {
    if (disposed) return
    if (now() - startedAt + MCP_SELFHEAL_POLL_MS > MCP_SELFHEAL_WINDOW_MS) {
      say('warn', `giving up: ${MCP_SERVER_NAME} still has no tools after ${Math.round(MCP_SELFHEAL_WINDOW_MS / 1000)}s`, { reason, reloads: state.reloads })
      finish()
      return
    }
    plan(MCP_SELFHEAL_POLL_MS)
  }

  async function tick() {
    if (disposed) return
    let servers
    try {
      servers = await request(MCP_SERVERS_PATH)
    } catch (err) {
      if (disposed) return
      say('warn', 'check failed', errorInfo(err))
      waitOrGiveUp('check-failed')
      return
    }
    if (disposed) return
    let decision
    try {
      decision = decideMcpSelfHeal(servers, state, now())
    } catch (err) {
      say('warn', 'check failed', errorInfo(err))
      waitOrGiveUp('check-failed')
      return
    }
    if (decision.action === 'stop') {
      if (decision.reason === 'tools-present') {
        say('info', state.reloads > 0 ? `recovered: ${MCP_SERVER_NAME} lists its tools again` : `ok: ${MCP_SERVER_NAME} lists its tools`, { reloads: state.reloads })
      } else {
        say('warn', `stopping: ${MCP_SERVER_NAME} reports an error a reload is not known to fix`, { reason: decision.reason, reloads: state.reloads })
      }
      finish()
      return
    }
    if (decision.action === 'wait') {
      say('info', `check: waiting (${decision.reason})`, { reloads: state.reloads })
      waitOrGiveUp(decision.reason)
      return
    }
    // reload: counted before it is sent, so a request that fails or never answers still uses up an attempt.
    state.reloads += 1
    state.lastReloadAt = now()
    say('warn', `reload ${state.reloads}/${MCP_SELFHEAL_MAX_RELOADS}: ${MCP_SERVER_NAME} is connected with 0 tools`, { reason: decision.reason })
    try {
      const answer = await request(MCP_RELOAD_PATH, { method: 'POST', query: { server: MCP_SERVER_NAME } })
      if (disposed) return
      if (answer && typeof answer === 'object' && answer.ok === false) {
        // The host answers 200 with ok:false when the server is not in the profile's configuration.
        say('warn', 'stopping: the host refused the reload', { error: String(answer.error || '').slice(0, 200) })
        finish()
        return
      }
    } catch (err) {
      if (disposed) return
      say('warn', 'reload failed', errorInfo(err))
    }
    plan(MCP_SELFHEAL_RECHECK_MS)
  }

  plan(MCP_SELFHEAL_FIRST_CHECK_MS)

  return () => {
    disposed = true
    if (cancelTimer) {
      try { cancelTimer() } catch {}
      cancelTimer = null
    }
  }
}

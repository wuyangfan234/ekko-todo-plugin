// #122: after a Web UI restart the host's MCP bridge may list 0 tools for the plugin's `ekko-todo` server and
// never ask again. The plugin looks at its own server for a short while after it starts and reloads only that
// server when it is connected, reports no error and has 0 tools.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { inspect } from 'node:util'
import { join } from 'node:path'
import {
  MCP_RELOAD_PATH,
  MCP_SELFHEAL_ENV,
  MCP_SERVER_NAME,
  MCP_SERVERS_PATH,
  decideMcpSelfHeal,
  isMcpSelfHealEnabled,
  mcpToolCount,
  startMcpSelfHeal,
} from '../src/server/mcp-selfheal.mjs'
import { apply } from '../src/server/index.mjs'

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise(r => setImmediate(r)) }

// The entry the host builds for a server (bridge_server.py `_build_server_entry`): it carries `raw_config`, the
// server's whole configuration (command, env, headers), and `managed`.
const SECRET = 'sk-RAWCONFIG-SECRET-TOKEN-122'
const rawConfig = (name) => ({
  command: '/usr/local/bin/node', args: ['bridge.mjs', `--token=${SECRET}`],
  env: { STUDIO_TOKEN: SECRET, SERVER: name }, headers: { Authorization: `Bearer ${SECRET}` },
  url: `https://example.invalid/mcp?key=${SECRET}`,
})
const entry = (over = {}) => ({
  name: 'ekko-todo', transport: 'stdio', connected: true, tools: 0, tools_registered: 0,
  tool_names: [], tool_names_registered: [], tool_details: [], error: null,
  raw_config: rawConfig('ekko-todo'), managed: true, ...over,
})
const other = { name: 'memory', transport: 'stdio', connected: true, tools: 9, tools_registered: 9, error: null, raw_config: rawConfig('memory'), managed: false }
const BROKEN = entry()
const HEALTHY = entry({ tools: 32, tools_registered: 32 })
const STARTING = entry({ connected: false })
const fresh = { reloads: 0, lastReloadAt: null }

// ---- decision table ------------------------------------------------------------------------------------

test('#122 decide: connected, no error, 0 tools is the fault and asks for a reload', () => {
  assert.deepEqual(decideMcpSelfHeal({ servers: [other, BROKEN], total_tools: 9, ok: true }, fresh, 1000), { action: 'reload', reason: 'connected-without-tools' })
})

test('#122 decide: both answer shapes are read (an array, or { servers: [] })', () => {
  assert.equal(decideMcpSelfHeal([other, BROKEN], fresh, 0).action, 'reload')
  assert.equal(decideMcpSelfHeal({ servers: [other, BROKEN] }, fresh, 0).action, 'reload')
  assert.equal(decideMcpSelfHeal([other, HEALTHY], fresh, 0).action, 'stop')
  assert.equal(decideMcpSelfHeal({ servers: [other, HEALTHY] }, fresh, 0).action, 'stop')
})

test('#122 decide: a server that lists tools stops the check (success)', () => {
  assert.deepEqual(decideMcpSelfHeal({ servers: [HEALTHY] }, fresh, 0), { action: 'stop', reason: 'tools-present' })
  // Any of the host's counters counts: registered tools, or only the name list.
  assert.equal(decideMcpSelfHeal([entry({ tools: 0, tools_registered: 3 })], fresh, 0).reason, 'tools-present')
  assert.equal(decideMcpSelfHeal([entry({ tools: undefined, tool_names: ['a', 'b'] })], fresh, 0).reason, 'tools-present')
  assert.equal(mcpToolCount(entry({ tools: ['a', 'b', 'c'] })), 3)
  assert.equal(mcpToolCount(null), 0)
})

test('#122 decide: not connected (still starting) waits and never reloads', () => {
  assert.deepEqual(decideMcpSelfHeal({ servers: [STARTING] }, fresh, 0), { action: 'wait', reason: 'not-connected' })
  // Only `true` is "connected": a missing or non-boolean value is not the fault signature.
  assert.equal(decideMcpSelfHeal([entry({ connected: undefined })], fresh, 0).action, 'wait')
  assert.equal(decideMcpSelfHeal([entry({ connected: 'true' })], fresh, 0).action, 'wait')
})

test('#122 decide: a server that reports an error stops without a reload (another fault is not hidden)', () => {
  assert.deepEqual(decideMcpSelfHeal({ servers: [entry({ error: 'spawn ENOENT' })] }, fresh, 0), { action: 'stop', reason: 'server-error' })
  assert.equal(decideMcpSelfHeal([entry({ connected: false, error: 'Hermes Runtime MCP module is unavailable' })], fresh, 0).action, 'stop')
  // An empty error is no error.
  assert.equal(decideMcpSelfHeal([entry({ error: '' })], fresh, 0).action, 'reload')
  assert.equal(decideMcpSelfHeal([entry({ error: '  ' })], fresh, 0).action, 'reload')
})

test('#122 decide: a missing server waits (a reload does not create an unconfigured server)', () => {
  assert.deepEqual(decideMcpSelfHeal({ servers: [other] }, fresh, 0), { action: 'wait', reason: 'server-missing' })
  for (const answer of [[], { servers: [] }, null, undefined, 'nope', { servers: 'x' }, {}]) {
    assert.deepEqual(decideMcpSelfHeal(answer, fresh, 0), { action: 'wait', reason: 'server-missing' })
  }
  // The name is matched exactly.
  assert.equal(decideMcpSelfHeal([entry({ name: 'ekko-todo-2' })], fresh, 0).reason, 'server-missing')
})

test('#122 decide: at most 2 reloads in one activation, however long ago the last one was', () => {
  assert.equal(decideMcpSelfHeal([BROKEN], { reloads: 1, lastReloadAt: 0 }, 10 * 60000).action, 'reload')
  assert.deepEqual(decideMcpSelfHeal([BROKEN], { reloads: 2, lastReloadAt: 0 }, 10 * 60000), { action: 'wait', reason: 'reload-limit' })
  assert.equal(decideMcpSelfHeal([BROKEN], { reloads: 3, lastReloadAt: 0 }, 10 * 60000).action, 'wait')
})

test('#122 decide: the second reload waits 60 s after the first', () => {
  const state = { reloads: 1, lastReloadAt: 100000 }
  assert.deepEqual(decideMcpSelfHeal([BROKEN], state, 100000 + 2000), { action: 'wait', reason: 'reload-cooldown' })
  assert.equal(decideMcpSelfHeal([BROKEN], state, 100000 + 59999).action, 'wait')
  assert.equal(decideMcpSelfHeal([BROKEN], state, 100000 + 60000).action, 'reload')
})

// ---- bounded runner (request / schedule / now injected) ------------------------------------------------

function harness(respond, { enabled = true } = {}) {
  const t0 = 5_000_000
  let t = t0
  const timers = []
  const calls = []
  const logs = []
  const schedule = (fn, ms) => {
    const item = { at: t + ms, ms, fn, cancelled: false, done: false }
    timers.push(item)
    return () => { item.cancelled = true }
  }
  const request = (path, options) => {
    const call = { at: t - t0, path, options }
    calls.push(call)
    return respond(call, calls)
  }
  const log = {
    info(msg, data) { logs.push({ level: 'info', msg, data }) },
    warn(msg, data) { logs.push({ level: 'warn', msg, data }) },
    error(msg, data) { logs.push({ level: 'error', msg, data }) },
  }
  const dispose = startMcpSelfHeal({ request, log, schedule, now: () => t, enabled })
  const advance = async (ms) => {
    const end = t + ms
    for (;;) {
      const next = timers.filter(i => !i.cancelled && !i.done && i.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      t = next.at
      next.done = true
      next.fn()
      await flush()
    }
    t = end
    await flush()
  }
  return {
    dispose, advance, calls, logs, timers,
    gets: () => calls.filter(c => c.path === MCP_SERVERS_PATH),
    posts: () => calls.filter(c => c.options?.method === 'POST'),
    pending: () => timers.filter(i => !i.cancelled && !i.done).length,
  }
}
const answerWith = (list) => async (call) => (call.options?.method === 'POST' ? { ok: true, message: 'MCP servers reloaded' } : { servers: list, ok: true })

test('#122 run: the first check comes 5 s after the start, then one every 5 s', async () => {
  const h = harness(answerWith([other, STARTING]))
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].ms, 5000)
  await h.advance(4999)
  assert.equal(h.calls.length, 0, 'nothing is asked before 5 s')
  await h.advance(1)
  assert.deepEqual(h.calls, [{ at: 5000, path: '/api/hermes/mcp/servers', options: undefined }])
  await h.advance(15000)
  assert.deepEqual(h.gets().map(c => c.at), [5000, 10000, 15000, 20000])
  assert.equal(h.posts().length, 0, 'a server that is not connected yet is never reloaded')
  h.dispose()
})

test('#122 run: the fault is answered with a reload of this one server (path and query, verbatim), then a recheck after 2 s', async () => {
  let reloaded = false
  const h = harness(async (call) => {
    if (call.options?.method === 'POST') { reloaded = true; return { ok: true, message: 'MCP servers reloaded' } }
    return { servers: [other, reloaded ? HEALTHY : BROKEN], ok: true }
  })
  await h.advance(5000)
  assert.equal(h.calls.length, 2)
  const post = h.calls[1]
  assert.equal(post.path, '/api/hermes/mcp/reload')
  assert.equal(post.path, MCP_RELOAD_PATH)
  assert.ok(!post.path.includes('?'), 'the query is not glued to the path')
  assert.deepEqual(post.options, { method: 'POST', query: { server: 'ekko-todo' } })
  assert.equal(post.options.query.server, MCP_SERVER_NAME)
  assert.equal(post.at, 5000)
  await h.advance(1999)
  assert.equal(h.calls.length, 2)
  await h.advance(1)
  assert.deepEqual(h.calls[2], { at: 7000, path: '/api/hermes/mcp/servers', options: undefined })
  // Recovered: the chain ends, nothing is scheduled or asked any more.
  assert.equal(h.pending(), 0)
  await h.advance(10 * 60000)
  assert.equal(h.calls.length, 3)
  assert.equal(h.posts().length, 1)
  assert.equal(h.logs.filter(l => /recovered/.test(l.msg)).length, 1)
  assert.ok(h.logs.every(l => l.msg.startsWith('[mcp-selfheal] ')), 'every line carries the prefix')
})

test('#122 run: a healthy server ends the chain at the first check without any reload', async () => {
  const h = harness(answerWith([HEALTHY]))
  await h.advance(10 * 60000)
  assert.deepEqual(h.calls.map(c => [c.at, c.path]), [[5000, '/api/hermes/mcp/servers']])
  assert.equal(h.pending(), 0)
  assert.equal(h.logs.length, 1)
  assert.match(h.logs[0].msg, /^\[mcp-selfheal\] ok: /)
})

test('#122 run: a fault that stays gets 2 reloads at most, 60 s apart, and one "giving up" line at the end of the 90 s window', async () => {
  const h = harness(answerWith([BROKEN]))
  await h.advance(60 * 60000)
  const posts = h.posts()
  assert.equal(posts.length, 2, `reloads: ${posts.map(p => p.at).join(',')}`)
  assert.equal(posts[0].at, 5000)
  assert.ok(posts[1].at - posts[0].at >= 60000, `second reload ${posts[1].at - posts[0].at} ms after the first`)
  for (const p of posts) assert.deepEqual([p.path, p.options], ['/api/hermes/mcp/reload', { method: 'POST', query: { server: 'ekko-todo' } }])
  // No request after the window, and the chain is over.
  assert.ok(h.calls.every(c => c.at <= 90000), `last request at ${Math.max(...h.calls.map(c => c.at))}`)
  assert.equal(h.pending(), 0)
  assert.equal(h.logs.filter(l => /giving up/.test(l.msg)).length, 1)
  assert.equal(h.logs.filter(l => /^\[mcp-selfheal\] reload /.test(l.msg)).length, 2)
})

test('#122 run: a server that never connects is polled until the window ends, never reloaded, and reported once', async () => {
  const h = harness(answerWith([other]))
  await h.advance(60 * 60000)
  assert.deepEqual(h.gets().map(c => c.at), Array.from({ length: 18 }, (_, i) => 5000 * (i + 1)))
  assert.equal(h.posts().length, 0)
  assert.equal(h.logs.filter(l => /giving up/.test(l.msg)).length, 1)
  assert.equal(h.pending(), 0)
})

test('#122 run: a server error ends the chain with one line and no reload', async () => {
  const h = harness(answerWith([entry({ error: 'spawn ENOENT' })]))
  await h.advance(60 * 60000)
  assert.equal(h.calls.length, 1)
  assert.equal(h.posts().length, 0)
  assert.equal(h.logs.length, 1)
  assert.match(h.logs[0].msg, /^\[mcp-selfheal\] stopping: /)
  assert.ok(!JSON.stringify(h.logs).includes('ENOENT'), 'the server error text is not copied to the log')
})

test('#122 run: a rejected request never throws; a rejected reload still uses up one of the 2 attempts', async () => {
  const unhandled = []
  const onUnhandled = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  try {
    const h = harness(async (call, calls) => {
      if (call.options?.method === 'POST') throw Object.assign(new Error('Failed to reload MCP'), { status: 503 })
      if (calls.filter(c => !c.options).length === 1) throw Object.assign(new Error('MCP bridge not available'), { status: 503 })
      return { servers: [BROKEN], ok: true }
    })
    await h.advance(5000)
    assert.equal(h.calls.length, 1)
    assert.equal(h.logs.filter(l => /check failed/.test(l.msg)).length, 1)
    assert.deepEqual(h.logs[0].data, { error: 'MCP bridge not available', status: 503 })
    await h.advance(60 * 60000)
    assert.deepEqual(h.gets().slice(0, 2).map(c => c.at), [5000, 10000], 'the chain goes on after a failed check')
    assert.equal(h.posts().length, 2)
    assert.equal(h.logs.filter(l => /reload failed/.test(l.msg)).length, 2)
    assert.equal(h.logs.filter(l => /giving up/.test(l.msg)).length, 1)
    assert.equal(h.pending(), 0)
    await flush()
    assert.deepEqual(unhandled, [])
    // A request that throws synchronously is no different.
    const h2 = harness(() => { throw new Error('boom') })
    await h2.advance(60 * 60000)
    assert.equal(h2.gets().length, 18)
    assert.deepEqual(unhandled, [])
  } finally { process.off('unhandledRejection', onUnhandled) }
})

test('#122 run: when the host refuses the reload (200 with ok:false) the chain stops', async () => {
  const h = harness(async (call) => (call.options?.method === 'POST' ? { ok: false, error: "server 'ekko-todo' not found in config" } : { servers: [BROKEN] }))
  await h.advance(60 * 60000)
  assert.equal(h.calls.length, 2)
  assert.equal(h.pending(), 0)
  assert.equal(h.logs.filter(l => /the host refused the reload/.test(l.msg)).length, 1)
})

test('#122 run: after dispose no timer fires and no request is sent, also when a request was in flight', async () => {
  const h = harness(answerWith([other, STARTING]))
  await h.advance(10000)
  assert.equal(h.calls.length, 2)
  h.dispose()
  assert.equal(h.pending(), 0, 'the pending timer was cancelled')
  await h.advance(60 * 60000)
  assert.equal(h.calls.length, 2)

  // Disposed while the check is in flight: the reload it would have asked for is not sent.
  let release
  const h2 = harness((call) => (call.options?.method === 'POST' ? Promise.resolve({ ok: true }) : new Promise(r => { release = () => r({ servers: [BROKEN] }) })))
  await h2.advance(5000)
  assert.equal(h2.calls.length, 1)
  h2.dispose()
  release()
  await flush()
  await h2.advance(60 * 60000)
  assert.equal(h2.calls.length, 1)
  assert.equal(h2.posts().length, 0)
  assert.equal(h2.pending(), 0)
})

test('#122 run: the kill switch starts nothing at all', async () => {
  const h = harness(answerWith([BROKEN]), { enabled: false })
  assert.equal(h.timers.length, 0)
  await h.advance(60 * 60000)
  assert.equal(h.calls.length, 0)
  assert.equal(typeof h.dispose, 'function')
  h.dispose()
  assert.equal(isMcpSelfHealEnabled({ [MCP_SELFHEAL_ENV]: '0' }), false)
  assert.equal(isMcpSelfHealEnabled({ [MCP_SELFHEAL_ENV]: '1' }), true)
  assert.equal(isMcpSelfHealEnabled({}), true)
  assert.equal(MCP_SELFHEAL_ENV, 'EKKO_TODO_MCP_SELFHEAL')
})

test('#122 run: the default timer is unref()ed, so it never keeps the process alive', (t) => {
  const made = []
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    const timer = { fn, ms, unrefs: 0, unref() { this.unrefs += 1; return this } }
    made.push(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer) => { if (timer) timer.cleared = true })
  const dispose = startMcpSelfHeal({ request: async () => ({ servers: [] }), enabled: true })
  assert.equal(made.length, 1)
  assert.equal(made[0].ms, 5000)
  assert.equal(made[0].unrefs, 1)
  dispose()
  assert.equal(made[0].cleared, true)
})

// ---- wiring in apply(ctx) ------------------------------------------------------------------------------

function fakeCtx(dataDir) {
  const requests = []
  const cleanups = []
  const logs = []
  const ctx = {
    paths: { dataDir },
    config: {},
    extensions: {
      rpc: { register() { return () => {} } },
      tools: { register() { return () => {} } },
      actions: { register() { return () => {} } },
    },
    events: { on() { return () => {} } },
    scheduler: { every() { return () => {} } },
    lifecycle: { add(fn) { cleanups.push(fn) } },
    log: {
      info(msg, data) { logs.push({ level: 'info', msg, data }) },
      warn(msg, data) { logs.push({ level: 'warn', msg, data }) },
      error(msg, data) { logs.push({ level: 'error', msg, data }) },
    },
    host: {
      async request(path, options) {
        requests.push({ path, options })
        return options?.method === 'POST' ? { ok: true } : { servers: [BROKEN], ok: true }
      },
    },
  }
  return { ctx, requests, cleanups, logs }
}

async function withApply(t, env, body) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-mcp-selfheal-'))
  const before = process.env[MCP_SELFHEAL_ENV]
  if (env === undefined) delete process.env[MCP_SELFHEAL_ENV]
  else process.env[MCP_SELFHEAL_ENV] = env
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fakeCtx(join(root, 'data'))
  let dispose
  try {
    dispose = apply(f.ctx)
    await body(f, dispose)
  } finally {
    try { dispose?.() } catch {}
    t.mock.timers.reset()
    if (before === undefined) delete process.env[MCP_SELFHEAL_ENV]
    else process.env[MCP_SELFHEAL_ENV] = before
    rmSync(root, { recursive: true, force: true })
  }
}

// The answer of the servers endpoint carries every server's `raw_config`. Whatever the chain does with the
// answer (wait, reload, recover, stop on an error, give up), nothing of it reaches the log or a request.
test('#122 run: raw_config (a token in args, env, headers and url) never reaches a log line or a request, on every path of the chain', async (t) => {
  const leaks = (value) => JSON.stringify(value ?? null).includes(SECRET) || inspect(value, { depth: null, maxStringLength: null, maxArrayLength: null }).includes(SECRET)
  const check = (label, logs, calls, wanted) => {
    assert.ok(JSON.stringify(wanted.fixture).includes(SECRET), `${label}: the fixture really carries the token`)
    for (const re of wanted.lines) assert.ok(logs.some(l => re.test(l.msg)), `${label}: expected a line ${re}; got ${logs.map(l => l.msg).join(' | ')}`)
    for (const l of logs) {
      assert.ok(!leaks(l.msg), `${label}: token in the text of: ${l.msg}`)
      assert.ok(!leaks(l.data), `${label}: token in the data of: ${l.msg}`)
    }
    for (const c of calls) assert.ok(!leaks([c.path, c.options]), `${label}: token in a request to ${c.path}`)
  }

  // 1. fault -> reload -> recovered
  let reloaded = false
  const h1 = harness(async (call) => {
    if (call.options?.method === 'POST') { reloaded = true; return { ok: true, message: 'MCP servers reloaded', servers: [BROKEN] } }
    return { servers: [other, reloaded ? HEALTHY : BROKEN], total_tools: 9, ok: true }
  })
  await h1.advance(60 * 60000)
  assert.equal(h1.posts().length, 1)
  check('recovered', h1.logs, h1.calls, { fixture: [other, BROKEN, HEALTHY], lines: [/reload 1\/2/, /recovered/] })

  // 2. fault that stays -> 2 reloads -> giving up
  const h2 = harness(answerWith([other, BROKEN]))
  await h2.advance(60 * 60000)
  assert.equal(h2.posts().length, 2)
  check('gave up', h2.logs, h2.calls, { fixture: [other, BROKEN], lines: [/reload 2\/2/, /check: waiting \(reload-cooldown\)/, /giving up/] })

  // 3. not connected until the window ends
  const h3 = harness(answerWith([other, STARTING]))
  await h3.advance(60 * 60000)
  check('never connected', h3.logs, h3.calls, { fixture: [other, STARTING], lines: [/check: waiting \(not-connected\)/, /giving up/] })

  // 4. the server reports an error (its text may quote the configuration: it is not copied either)
  const failing = entry({ connected: false, error: `spawn failed: node bridge.mjs --token=${SECRET}` })
  const h4 = harness(answerWith([other, failing]))
  await h4.advance(60 * 60000)
  check('server error', h4.logs, h4.calls, { fixture: [failing], lines: [/stopping: /] })

  // 5. the same through apply(ctx): what the plugin hands to ctx.log and to ctx.host.request
  const root = mkdtempSync(join(tmpdir(), 'ekko-mcp-selfheal-'))
  // Date is mocked too: the 60 s between two reloads is measured with Date.now.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fakeCtx(join(root, 'data'))
  let dispose
  try {
    dispose = apply(f.ctx)
    for (let i = 0; i < 40; i += 1) { t.mock.timers.tick(5000); await flush() }
    assert.equal(f.requests.filter(r => r.options?.method === 'POST').length, 2)
    check('apply', f.logs, f.requests, { fixture: [BROKEN], lines: [/reload 2\/2/, /giving up/] })
  } finally {
    try { dispose?.() } catch {}
    t.mock.timers.reset()
    rmSync(root, { recursive: true, force: true })
  }
})

test('#122 apply: the self-heal runs on the plugin-level host, is cleaned up through ctx.lifecycle, and is silent after dispose', async (t) => {
  await withApply(t, undefined, async (f) => {
    assert.equal(f.requests.length, 0, 'apply itself sends nothing and does not wait for the check')
    assert.equal(f.cleanups.length, 1)
    assert.equal(typeof f.cleanups[0], 'function')
    t.mock.timers.tick(4999)
    await flush()
    assert.equal(f.requests.length, 0)
    t.mock.timers.tick(1)
    await flush()
    assert.deepEqual(f.requests, [
      { path: '/api/hermes/mcp/servers', options: undefined },
      { path: '/api/hermes/mcp/reload', options: { method: 'POST', query: { server: 'ekko-todo' } } },
    ])
    assert.ok(f.logs.some(l => l.msg.startsWith('[mcp-selfheal] reload 1/2')))
    // The cleanup the host holds stops it: the 2 s recheck that was pending never asks.
    f.cleanups[0]()
    t.mock.timers.tick(10 * 60000)
    await flush()
    assert.equal(f.requests.length, 2)
  })
})

test('#122 apply: EKKO_TODO_MCP_SELFHEAL=0 turns it off; a context without host.request starts nothing either', async (t) => {
  await withApply(t, '0', async (f) => {
    t.mock.timers.tick(10 * 60000)
    await flush()
    assert.equal(f.requests.length, 0)
    assert.ok(!f.logs.some(l => String(l.msg).includes('[mcp-selfheal]')))
  })
  // Any other value leaves it on.
  await withApply(t, '1', async (f) => {
    t.mock.timers.tick(5000)
    await flush()
    assert.equal(f.requests.length, 2)
  })
})

test('#122 apply: a host whose request throws does not break apply or the chain', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-mcp-selfheal-'))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fakeCtx(join(root, 'data'))
  let n = 0
  f.ctx.host.request = () => { n += 1; throw new Error('Plugin is not active') }
  let dispose
  try {
    dispose = apply(f.ctx)
    t.mock.timers.tick(5000)
    await flush()
    t.mock.timers.tick(5000)
    await flush()
    assert.equal(n, 2)
    assert.equal(f.logs.filter(l => /\[mcp-selfheal\] check failed/.test(l.msg)).length, 2)
    // No host API at all (older host, tests): nothing is started.
    const g = fakeCtx(join(root, 'data2'))
    delete g.ctx.host
    const d2 = apply(g.ctx)
    t.mock.timers.tick(60000)
    await flush()
    assert.ok(!g.logs.some(l => String(l.msg).includes('[mcp-selfheal]')))
    d2()
  } finally {
    try { dispose?.() } catch {}
    t.mock.timers.reset()
    rmSync(root, { recursive: true, force: true })
  }
})

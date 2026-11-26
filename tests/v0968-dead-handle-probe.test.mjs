// #64 (C06) core fix, locked directly: once the calling handle has ended, the live probe must not answer
// "working" (fail-open) and a refused launch must throw HOST_CALL_ENDED instead of probing with the dead handle.
// The #64 scenario tests (v0967-dead-handle-wake) reach these functions only through other paths (deferRun,
// sessions.create), so without these cases the core fix could be reverted with every test still green.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import { createOrchestrator } from '../src/server/orchestrator.mjs'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ekko-deadprobe-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const log = { warn() {}, info() {}, error() {} }
  const orch = createOrchestrator({ db, dataDir, config: {}, log, settleDelaysMs: [0, 0, 0, 0] })
  const cleanup = () => { try { orch.dispose?.() } catch {} try { db.close() } catch {} rmSync(root, { recursive: true, force: true }) }
  return { orch, cleanup }
}

const abortedSignal = () => { const c = new AbortController(); c.abort(); return c.signal }
const abortedError = () => new Error('This operation was aborted')

test('#64 D: the probe with an ended handle answers not-working, not fail-open', async () => {
  const ctx = setup()
  try {
    const calls = { connect: 0, get: 0 }
    const run = {
      identity: { userId: 1, profile: 'default' },
      signal: abortedSignal(),
      host: { sessions: {
        async connect() { calls.connect += 1; throw abortedError() },
        async get() { calls.get += 1; throw abortedError() },
      } },
    }
    const probe = await ctx.orch.probeSessionWorking(run, 'sid', { timeoutMs: 300 })
    console.log(`[D] probe=${JSON.stringify(probe)} calls=${JSON.stringify(calls)}`)
    assert.equal(probe.isWorking, false, 'an ended handle never reports the session as working')
    assert.equal(probe.known, false)
    assert.equal(probe.handleEnded, true)
  } finally { ctx.cleanup() }
})

test('#64 D2: a live handle whose sessions.get is refused still assumes working (duplicate-dispatch guard kept)', async () => {
  const ctx = setup()
  try {
    const run = {
      identity: { userId: 1, profile: 'default' },
      signal: new AbortController().signal,
      host: { sessions: { async get() { throw new Error('host busy') } } },
    }
    const probe = await ctx.orch.probeSessionWorking(run, 'sid', { timeoutMs: 300 })
    console.log(`[D2] probe=${JSON.stringify(probe)}`)
    assert.equal(probe.known, false)
    assert.equal(probe.isWorking, true)
    assert.notEqual(probe.handleEnded, true)
  } finally { ctx.cleanup() }
})

test('#64 E: a launch refused because the calling handle ended throws HOST_CALL_ENDED without probing again', async () => {
  const ctx = setup()
  try {
    const calls = { run: 0, connect: 0, get: 0 }
    const run = {
      identity: { userId: 1, profile: 'default' },
      signal: abortedSignal(),
      host: { sessions: {
        async run() { calls.run += 1; throw abortedError() },
        async connect() { calls.connect += 1; throw abortedError() },
        async get() { calls.get += 1; throw abortedError() },
      } },
    }
    let returned
    let thrown
    try { returned = await ctx.orch.launchSessionRun(run, 'sid', 'hello', { wait: false }) } catch (err) { thrown = err }
    console.log(`[E] returned=${JSON.stringify(returned)} thrown.code=${thrown?.code} calls=${JSON.stringify(calls)}`)
    assert.equal(returned, undefined, 'no success object is returned')
    assert.ok(thrown, 'the launch throws')
    assert.equal(thrown.code, 'HOST_CALL_ENDED')
    assert.equal(calls.run, 1)
    assert.equal(calls.connect, 0, 'the dead handle is not used to probe (connect)')
    assert.equal(calls.get, 0, 'the dead handle is not used to probe (get)')
  } finally { ctx.cleanup() }
})

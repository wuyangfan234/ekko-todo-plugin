import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withEdgeRetry, isEdgeMiss, wrapClientContext } from '../src/client/rpc-retry.js'

test('v0.9.4: tunnel edge "404 page not found" is retried, then surfaces a Chinese message', async () => {
  let n = 0
  const flaky = withEdgeRetry(async x => { n += 1; if (n < 3) throw new Error('API Error 404: 404 page not found'); return x * 2 }, { sleep: async () => {} })
  assert.equal(await flaky(21), 42)
  assert.equal(n, 3)

  let m = 0
  const dead = withEdgeRetry(async () => { m += 1; throw new Error('API Error 404: 404 page not found') }, { retries: 2, sleep: async () => {} })
  await assert.rejects(dead, /网络连接短暂中断/)
  assert.equal(m, 3)
})

test('v0.9.4: real plugin errors are never retried', async () => {
  let n = 0
  const real = withEdgeRetry(async () => { n += 1; throw new Error('Todo not found: td-1') }, { sleep: async () => {} })
  await assert.rejects(real, /Todo not found/)
  assert.equal(n, 1)
  assert.equal(isEdgeMiss(new Error('API Error 404: Not Found')), false, 'Studio own 404 is a real error')
  assert.equal(isEdgeMiss(new Error('API Error 429: <html>429 Too Many Requests</html>')), true, 'rate-limited requests were never applied')
  assert.equal(isEdgeMiss(new Error('Failed to fetch')), false, 'dropped connections are not retried (write may have landed)')
})

test('v0.9.4: wrapClientContext keeps other ctx members and wraps rpc.call once', async () => {
  const ctx = { ui: { notify() {} }, rpc: { call: async (name, input) => ({ name, input }) } }
  const w = wrapClientContext(ctx)
  assert.equal(w.ui, ctx.ui)
  assert.deepEqual(await w.rpc.call('get-state', { a: 1 }), { name: 'get-state', input: { a: 1 } })
  assert.equal(wrapClientContext(w), w)
})

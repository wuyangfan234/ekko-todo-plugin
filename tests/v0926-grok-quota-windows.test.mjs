import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseGrokBillingPayload } from '../src/server/quota-engine.mjs'

// Fixed response shaped like the real cli-chat-proxy.grok.com /v1/billing?format=credits
// reply (field names verified against a live call on 2026-11-25), but with several products,
// a non-zero total and an on-demand cap so every reading has to surface.
const MULTI = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-20T18:34:58.645880+00:00', end: '2026-11-27T18:34:58.645880+00:00' },
    creditUsagePercent: 42,
    onDemandCap: { val: 5000 },
    onDemandUsed: { val: 1250 },
    productUsage: [
      { product: 'GrokBuild', usagePercent: 30 },
      { product: 'GrokChat', usagePercent: 55 },
    ],
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    billingPeriodStart: '2026-11-20T18:34:58.645880+00:00',
    billingPeriodEnd: '2026-11-27T18:34:58.645880+00:00',
  },
}
const LEGACY_ZERO = {
  config: {
    monthlyLimit: { val: 0 },
    used: { val: 0 },
    onDemandCap: { val: 0 },
    billingPeriodStart: '2026-11-01T00:00:00+00:00',
    billingPeriodEnd: '2026-12-01T00:00:00+00:00',
  },
}

test('v0.9.26: Grok credits reply with a total, several products and on-demand usage yields every window', () => {
  const r = parseGrokBillingPayload(MULTI, LEGACY_ZERO, { hasGrokCodeAccess: true })
  assert.equal(r.empty, false)
  const byId = Object.fromEntries(r.windows.map(w => [w.id, w]))
  assert.equal(r.windows.length, 4, `expected total + 2 products + on-demand, got ${r.windows.map(w => w.id).join(',')}`)
  assert.equal(r.windows[0].id, 'grok-7d', 'total stays first and keeps its stable id')
  assert.equal(byId['grok-7d'].usedPct, 42)
  assert.equal(byId['grok-7d'].remainingPct, 58)
  assert.equal(byId['grok-7d'].usageReported, true)
  assert.equal(byId['grok-7d-GrokBuild'].usedPct, 30)
  assert.match(byId['grok-7d-GrokBuild'].name, /GrokBuild/)
  assert.equal(byId['grok-7d-GrokChat'].usedPct, 55)
  assert.equal(byId['grok-on-demand'].usedPct, 25)
  assert.equal(byId['grok-on-demand'].display, '$12.50 / $50.00')
  for (const w of r.windows) assert.equal(w.resetsAt, '2026-11-27T18:34:58.645880+00:00')
  assert.match(r.note, /官方只返回这一个周期/)
  assert.match(r.note, /不包含本地对话用量/)
})

test('v0.9.26: the live single-product reply (17% used) is no longer read as 0% used', () => {
  const live = structuredClone(MULTI)
  live.config.creditUsagePercent = 17
  live.config.productUsage = [{ product: 'GrokBuild', usagePercent: 17 }]
  live.config.onDemandCap = { val: 0 }
  live.config.onDemandUsed = { val: 0 }
  const r = parseGrokBillingPayload(live, LEGACY_ZERO, null)
  assert.deepEqual(r.windows.map(w => [w.id, w.usedPct]), [['grok-7d', 17], ['grok-7d-GrokBuild', 17]])
  assert.equal(r.windows[0].remainingPct, 83)
})

test('v0.9.26: a period without any usage number is marked as not reported, with the source spelled out', () => {
  const r = parseGrokBillingPayload({
    config: {
      isUnifiedBillingUser: true,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-11-20T18:34:58Z', end: '2026-11-27T18:34:58Z' },
    },
  }, null, null)
  assert.equal(r.windows.length, 1)
  const w = r.windows[0]
  assert.equal(w.usageReported, false, 'no usage number from the vendor must be flagged, not passed off as 0% used')
  assert.doesNotMatch(w.display, /剩余\s*100%|100% 剩余/)
  assert.match(w.display, /官方未返回已用量/)
  assert.match(r.note, /官方只返回这一个周期/)
  assert.match(r.note, /未给出已用量/)
  assert.match(r.note, /不包含本地对话用量/)
})

test('v0.9.26: quota card renders every window and the vendor note, and labels unreported usage', async () => {
  const { describeQuotaWindow } = await import('../src/client/quota-window-label.mjs')
  assert.deepEqual(
    describeQuotaWindow({ usedPct: 0, remainingPct: 100, usageReported: false, display: '官方未返回已用量' }),
    { reported: false, label: '官方未返回已用量', remaining: null },
  )
  assert.deepEqual(
    describeQuotaWindow({ usedPct: 17, remainingPct: 83, usageReported: true }),
    { reported: true, label: '剩余 83%', remaining: 83 },
  )
  // Snapshots from older versions carry no usageReported flag: keep showing them as before.
  assert.deepEqual(describeQuotaWindow({ usedPct: 36.5 }), { reported: true, label: '剩余 63.5%', remaining: 63.5 })

  const hub = readFileSync(new URL('../src/client/components/QuotaHub.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(hub, /windows\.slice\(0,\s*4\)/, 'card must not drop windows beyond the fourth')
  assert.match(hub, /describeQuotaWindow\(/)
  assert.match(hub, /snap\.note/)
})

test('v0.9.26: release metadata is aligned in every place and this fix has its own changelog section', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(JSON.parse(read('plugin.json')).version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.ok(JSON.parse(read('contracts/plugin.json')).description.includes(`v${pkg.version}`))
  const changelog = read('CHANGELOG.md')
  const heads = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map(m => m[1])
  assert.equal(heads[0], pkg.version, 'newest changelog entry is the package version')
  // Located by content, not by number, so a renumbering at merge time does not break this test.
  const sections = changelog.split(/^(?=## \[)/m)
  assert.equal(sections.filter(sec => sec.includes('creditUsagePercent')).length, 1, 'exactly one section describes this Grok fix')
})

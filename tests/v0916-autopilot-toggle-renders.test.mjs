import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeStateFingerprint } from '../src/client/state-fingerprint.js'

const topic = (over = {}) => ({
  id: 'topic-1', title: 'T', updatedAt: 100, createdAt: 50, pinned: false, archived: false, isRunning: false,
  autopilot: true, projectId: 'p1', activeConfigId: '', chiefSessionId: 's', activeRunId: '', lastDigestAt: 0,
  isUserNamed: false, lastError: '', liveActivity: null, messages: [], brief: { updatedAt: 0 }, ...over,
})

test('v0.9.16: topic settings that keep updatedAt still re-render (AUTO switch, project, model config)', () => {
  const base = computeStateFingerprint({ topics: [topic()] })
  for (const [field, value] of [['autopilot', false], ['projectId', 'p2'], ['activeConfigId', 'cfg-2'], ['chiefSessionId', 's2'], ['activeRunId', 'r1'], ['isUserNamed', true]]) {
    assert.notEqual(computeStateFingerprint({ topics: [topic({ [field]: value })] }), base, `${field} change must re-render`)
  }
  assert.equal(computeStateFingerprint({ topics: [topic()] }), base, 'identical snapshot does not re-render')
  assert.equal(computeStateFingerprint({ topics: [topic({ liveActivity: { activeTool: 'x' }, messages: [] })] }) === base, false)
})

test('v0.9.16: a background read that started before a write cannot overwrite the write on screen', async () => {
  const { readFileSync } = await import('node:fs')
  const app = readFileSync(new URL('../src/client/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /const stateEpochRef = useRef\(0\)/)
  assert.match(app, /const epoch = stateEpochRef\.current\s*\n\s*const next = await ctx\.rpc\.call\('get-state'\)\s*\n\s*if \(epoch !== stateEpochRef\.current\) gate\.queued = true\s*\n\s*else applyNextState\(next\)/)
  assert.match(app, /if \(epoch === stateEpochRef\.current\) applyNextState\(next\)/, 'topic sync is guarded too')
  assert.equal((app.match(/stateEpochRef\.current \+= 1/g) || []).length, 4, 'both write paths bump before and after')
})

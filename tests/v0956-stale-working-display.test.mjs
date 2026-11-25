// 0.9.56: on a clean machine the Chief bar kept showing "大总管正在响应…" for minutes while the host was idle
// (run records showed no active session) and Stop changed nothing. The page's own "working" flag is only
// cleared by host run-finished events, which never come when the host did not run the turn.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { STALE_WORKING_MS, shouldClearStaleWorking } from '../src/client/stream-watchdog.js'

const src = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const base = { isWorking: true, topicRunning: false, topicLaunching: false, lastEventAt: 1_000, now: 1_000 + STALE_WORKING_MS }

test('0.9.56: a silent "working" display with an idle topic is stale', () => {
  assert.equal(shouldClearStaleWorking(base), true)
  assert.equal(shouldClearStaleWorking({ ...base, now: base.now - 1 }), false, 'within the grace period')
  assert.equal(shouldClearStaleWorking({ ...base, topicRunning: true }), false, 'board says the Chief runs')
  assert.equal(shouldClearStaleWorking({ ...base, topicLaunching: true }), false, 'a launch is in flight')
  assert.equal(shouldClearStaleWorking({ ...base, isWorking: false }), false)
  assert.equal(shouldClearStaleWorking({ ...base, lastEventAt: 0, now: 5 }), false, 'no timestamp yet and no time passed')
})

test('0.9.56: the page stamps every host event and the optimistic send, asks the host before clearing, and Stop clears', () => {
  const app = src('src/client/App.jsx')
  assert.match(app, /buf\.lastEventAt = Date\.now\(\)/)
  assert.match(app, /startedAt: Date\.now\(\), lastEventAt: Date\.now\(\), connected: streamBufRef\.current\.connected, isWorking: true/)
  const watchdog = app.slice(app.indexOf('if (!liveStream.isWorking) return undefined'))
  const ask = watchdog.indexOf('await syncActiveTopic(topic.id)')
  const clear = watchdog.indexOf('if (probe()) clearLiveWorking()')
  assert.ok(ask >= 0 && clear > ask, 'the host is asked before the display is cleared')
  assert.match(app, /const next = await callRpc\('stop-topic-run'[\s\S]{0,400}clearLiveWorking\(\)/)
  assert.match(app, /holdFinalReply\(\{ topicId: tid, streamText: buf\.text/, 'a streamed but unsaved answer is kept')
})

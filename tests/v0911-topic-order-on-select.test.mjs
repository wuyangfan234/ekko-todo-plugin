import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase } from '../src/server/db.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const order = db => db.listTopics(1, 'default', { includeArchived: false }).map(t => t.title)

test('v0.9.11: opening a topic (run-state sync) never moves it to the top; real activity still does', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-topic-order-'))
  const db = createDatabase(join(root, 'data'))
  try {
    const a = db.createTopic(1, 'default', { title: 'A', isUserNamed: true })
    await sleep(5)
    const b = db.createTopic(1, 'default', { title: 'B', isUserNamed: true })
    await sleep(5)
    db.createTopic(1, 'default', { title: 'C', isUserNamed: true })
    assert.deepEqual(order(db), ['C', 'B', 'A'])

    // What sync-topic-session does when a topic is clicked: run-state bookkeeping.
    await sleep(5)
    db.updateTopic(1, 'default', a.id, { isRunning: false, activeRunId: '' })
    db.updateTopic(1, 'default', a.id, { isRunning: true })
    db.updateTopic(1, 'default', a.id, { activeConfigId: 'cfg-2', chiefSessionId: 's-1', lastDigestAt: Date.now(), lastError: '' })
    // Housekeeping does not reorder either.
    db.updateTopic(1, 'default', b.id, { title: 'B2', isUserNamed: true })
    assert.deepEqual(order(db), ['C', 'B2', 'A'])

    // Back-filling an old host message must not jump the topic forward or backward.
    db.addTopicMessage(1, 'default', a.id, { kind: 'chief', text: 'old', createdAt: 1 })
    assert.deepEqual(order(db), ['C', 'B2', 'A'])

    // Real activity: a new message, a new decision, a new error.
    await sleep(5)
    db.addTopicMessage(1, 'default', a.id, { kind: 'human', text: 'hi' })
    assert.deepEqual(order(db), ['A', 'C', 'B2'])
    await sleep(5)
    db.updateTopic(1, 'default', b.id, { brief: { waitingOnYou: '请确认' } })
    assert.deepEqual(order(db), ['B2', 'A', 'C'])
    await sleep(5)
    db.updateTopic(1, 'default', a.id, { lastError: 'boom' })
    assert.deepEqual(order(db), ['A', 'B2', 'C'])
  } finally {
    db.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

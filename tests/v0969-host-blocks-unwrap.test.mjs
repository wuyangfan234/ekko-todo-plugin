// #75: a message sent to the Chief with attachments goes to the host as a content-block array; the host
// stores it as the serialized JSON string. Reading the transcript back, the user branch must see the text
// inside the blocks, or both duplicate guards miss it and the raw JSON is stored as a second human bubble.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../src/server/db.mjs'
import * as O from '../src/server/orchestrator.mjs'

const hostMessageText = (raw) => O.hostMessageText(raw)

const blocks = (text) => JSON.stringify([
  { type: 'text', text },
  { type: 'image', name: 'a.png', path: '/x', media_type: 'image/png' },
])

test('a. serialized blocks string → text block content', () => {
  assert.equal(hostMessageText(blocks('Since your last turn:\n- #1 x')), 'Since your last turn:\n- #1 x')
})

test('b. plain text is returned byte-for-byte', () => {
  const s = '  1、手机端UI还是有问题，[截图]看一下 {"a":1}\n第二行  '
  const out = hostMessageText(s)
  assert.equal(out, s)
  assert.ok(Buffer.from(out).equals(Buffer.from(s)))
})

test('c. a JSON array the user really typed (no text field) is returned as is', () => {
  assert.equal(hostMessageText('[{"foo":1}]'), '[{"foo":1}]')
})

test('d. malformed JSON is returned as is and does not throw', () => {
  assert.equal(hostMessageText('[not json'), '[not json')
})

test('e. an empty array is returned as is', () => {
  assert.equal(hostMessageText('[]'), '[]')
})

function setup(hostRows) {
  const root = mkdtempSync(join(tmpdir(), 'ekko-unwrap-'))
  const dataDir = join(root, 'data')
  const db = createDatabase(dataDir, {})
  const orch = O.createOrchestrator({ db, dataDir, config: {}, log: { warn() {}, info() {} }, settleDelaysMs: [0, 0, 0, 0] })
  const host = {
    sessions: {
      async messages() { return { messages: hostRows, total: hostRows.length, hasMore: false } },
    },
  }
  const run = { identity: { userId: 1, profile: 'default' }, host, messages: { emit() {} } }
  const topic = db.createTopic(1, 'default', {})
  db.updateTopic(1, 'default', topic.id, { chiefSessionId: 'sess-chief' })
  assert.equal(db.getTopic(1, 'default', topic.id).chiefSessionId, 'sess-chief')
  const cleanup = () => { orch.dispose(); db.close(); rmSync(root, { recursive: true, force: true }) }
  return { db, orch, run, topicId: topic.id, cleanup }
}

const humans = (db, topicId) => db.getTopic(1, 'default', topicId).messages.filter(m => m.kind === 'human')

test('f. a digest wake sent with attachments is not stored as a human message', async () => {
  const ts = Math.floor(Date.now() / 1000)
  const ctx = setup([{ id: 'h1', role: 'user', content: blocks('Since your last turn:\n- #1 x\n\n用户：看图'), timestamp: ts }])
  try {
    await ctx.orch.syncChiefTranscript(ctx.run, 1, 'default', ctx.topicId, false)
    assert.deepEqual(humans(ctx.db, ctx.topicId).map(m => m.text), [])
  } finally { ctx.cleanup() }
})

test('g. a real user message with attachments and no stored bubble is still added, as plain text', async () => {
  const ts = Math.floor(Date.now() / 1000)
  const ctx = setup([{ id: 'h2', role: 'user', content: blocks('1、手机端UI还是有问题'), timestamp: ts }])
  try {
    await ctx.orch.syncChiefTranscript(ctx.run, 1, 'default', ctx.topicId, false)
    assert.deepEqual(humans(ctx.db, ctx.topicId).map(m => m.text), ['1、手机端UI还是有问题'])
  } finally { ctx.cleanup() }
})

test('h. a real user message with attachments whose clean bubble is already stored is not duplicated', async () => {
  const ts = Math.floor(Date.now() / 1000)
  const ctx = setup([{ id: 'h3', role: 'user', content: blocks('1、手机端UI还是有问题'), timestamp: ts }])
  try {
    ctx.db.addTopicMessage(1, 'default', ctx.topicId, { kind: 'human', text: '1、手机端UI还是有问题', createdAt: ts * 1000 - 400 })
    await ctx.orch.syncChiefTranscript(ctx.run, 1, 'default', ctx.topicId, false)
    assert.deepEqual(humans(ctx.db, ctx.topicId).map(m => m.text), ['1、手机端UI还是有问题'])
  } finally { ctx.cleanup() }
})

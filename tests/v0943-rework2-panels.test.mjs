// v0.9.43 rework 2 (Todo #29 review): the @ button closes the slash panel (the two panels never open together on
// any path), a slash pick re-reads the "/" token at the caret, run.completed moves the capsule, and a slow host
// (probe timeout) does not disable the compress button for good.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as cmds from '../src/client/chief-commands.js'

const root = new URL('../', import.meta.url).pathname
const read = rel => readFileSync(join(root, rel), 'utf8')
const chatPaneSrc = read('src/client/components/ChatPane.jsx')

// Body of `const <name> = (...) => { ... }` up to the next top-level `  const ` declaration.
function fnBody(src, name) {
  const start = src.indexOf(`const ${name} = `)
  assert.ok(start >= 0, `${name} exists`)
  const next = src.indexOf('\n  const ', start + 10)
  return src.slice(start, next > 0 ? next : undefined)
}

// Name of the `const x = (...) =>` function that contains `index` (nearest preceding declaration at 2 spaces).
function enclosingFn(src, index) {
  const before = src.slice(0, index)
  const m = [...before.matchAll(/\n  const (\w+) = /g)].pop()
  return m ? m[1] : ''
}

// ---- 必改: @ button --------------------------------------------------------------------------------------

test('rework2: the @ button closes the slash panel before it opens the @ picker', () => {
  const body = fnBody(chatPaneSrc, 'triggerMentionButton')
  assert.match(body, /setSlashQuery\(null\)/)
  assert.match(body, /setSlashStart\(-1\)/)
  const closeAt = body.indexOf('setSlashQuery(null)')
  const openAt = body.indexOf("setMentionQuery('')")
  assert.ok(closeAt > 0 && openAt > 0 && closeAt < openAt, 'slash closed before the picker opens')
  // 0.9.41 semantics unchanged: the button still goes through pressMentionButton with the picker state.
  assert.match(body, /pressMentionButton\(draft, pos, mentionQuery !== null\)/)
})

test('rework2: every place that opens one panel closes the other one', () => {
  // Opening the @ picker: only syncMentionTrigger (reached only through syncComposerTriggers, after the
  // slash panel was closed) and triggerMentionButton (closes it itself).
  const mentionOpens = [...chatPaneSrc.matchAll(/setMentionQuery\((?!null\))/g)].map(m => enclosingFn(chatPaneSrc, m.index))
  assert.deepEqual(mentionOpens.sort(), ['syncMentionTrigger', 'triggerMentionButton'])
  const mentionSyncCalls = [...chatPaneSrc.matchAll(/syncMentionTrigger\(/g)].map(m => enclosingFn(chatPaneSrc, m.index))
  assert.deepEqual(mentionSyncCalls, ['syncComposerTriggers'], 'syncMentionTrigger has no other caller')
  const sync = fnBody(chatPaneSrc, 'syncComposerTriggers')
  assert.ok(sync.lastIndexOf('setSlashQuery(null)') < sync.indexOf('syncMentionTrigger('), 'slash closed before the @ trigger is synced')
  // Opening the slash panel: only syncComposerTriggers, which closes the @ picker in the same branch.
  const slashOpens = [...chatPaneSrc.matchAll(/setSlashQuery\((?!null\))/g)].map(m => enclosingFn(chatPaneSrc, m.index))
  assert.deepEqual(slashOpens, ['syncComposerTriggers'])
  const branch = sync.slice(sync.indexOf('if (slash)'), sync.indexOf('return'))
  assert.match(branch, /setMentionQuery\(null\)/)
})

// ---- 建议 5: slash pick re-reads the token at the caret ------------------------------------------------

test('rework2: a slash pick uses the "/" token at the caret now, not the one the panel opened with', () => {
  const compress = { name: 'compress' }
  assert.deepEqual(cmds.resolveSlashPick('/co', 3, compress), { text: '/compress', cursor: 9 })
  // Caret moved to the start (Home) after the panel opened: no token there, nothing is inserted.
  assert.equal(cmds.resolveSlashPick('/co', 0, compress), null)
  assert.notEqual(cmds.applySlashCommand('/co', 0, 0, compress).text, '/compress', 'the old start gives the broken draft this guards against')
  assert.deepEqual(cmds.resolveSlashPick('  /ti', 5, { name: 'title', args: '新标题' }), { text: '  /title ', cursor: 9 })
  assert.equal(cmds.resolveSlashPick('/co x', 5, compress), null)
  const pick = fnBody(chatPaneSrc, 'pickSlashCommand')
  assert.match(pick, /resolveSlashPick\(draft, curPos, cmd\)/)
  assert.doesNotMatch(pick, /slashStart/, 'the stored start is no longer used to insert')
})

// ---- 建议 1: run.completed --------------------------------------------------------------------------------

test('rework2: run.completed carries the context tokens into the capsule', () => {
  assert.equal(cmds.contextTokensOf({ event: 'run.completed', contextTokens: 531000, output: 'x' }), 531000)
  assert.equal(cmds.contextTokensOf({ event: 'run.completed', contextTokens: 531000, error: 'boom' }), undefined)
  assert.equal(cmds.contextTokensOf({ event: 'run.completed' }), undefined)
  assert.equal(cmds.contextTokensOf({ event: 'run.completed', contextTokens: 0 }), undefined)
  const next = cmds.reduceContextEvent({ tokens: 500000, window: 1000000, phase: 'idle', startedAt: 0 }, { event: 'run.completed', contextTokens: 531000 }, { now: 1 })
  assert.equal(next.tokens, 531000)
})

// ---- 建议 2: a timeout is not "unsupported" ----------------------------------------------------------------

test('rework2: a /context probe that times out is a failed attempt, not an unsupported session', async () => {
  const runner = { sent: [], async run(text) { this.sent.push(text); return { ok: false, outcome: 'timeout', message: '8 秒内没有收到宿主回包' } } }
  const recs = []
  const r = await cmds.runManualCompress({ runner, topicId: 't1', beginLock: async () => recs.push('begin'), record: async p => recs.push(p) })
  assert.deepEqual(runner.sent, ['/context'])
  assert.equal(r.outcome, 'timeout')
  assert.notEqual(r.outcome, 'unsupported')
  assert.equal(recs[0].outcome, 'timeout')
  assert.match(recs[0].message, /本次未压缩，可重试/)
  assert.equal(recs.includes('begin'), false)
  assert.equal(cmds.compressResultText(r), '压缩超时，上下文未变，可重试')
  // The server's later answer is taken again unless the host really passed a command to the model.
  assert.deepEqual(cmds.mergeServerChannel({ channel: 'unsupported', reason: 'x', channelSticky: false }, { commandChannel: 'ready', reason: '' }), { channel: 'ready', reason: '', channelSticky: false })
  assert.deepEqual(cmds.mergeServerChannel({ channel: 'unsupported', reason: 'passthrough', channelSticky: true }, { commandChannel: 'ready', reason: '' }), { channel: 'unsupported', reason: 'passthrough', channelSticky: true })
  assert.deepEqual(cmds.mergeServerChannel({ channel: 'unknown', reason: '', channelSticky: false }, { commandChannel: 'unsupported', reason: '来源是 coding_agent' }), { channel: 'unsupported', reason: '来源是 coding_agent', channelSticky: false })
  const hook = read('src/client/use-chief-context.js')
  assert.match(hook, /mergeServerChannel\(/)
  assert.match(hook, /channelSticky: true/)
})

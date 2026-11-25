import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Todo #19 (v0.9.41): "@" in the chat composer must open the agent picker both when typed and when the @ button is pressed.
// Before: the trigger only fired at the start of a line or after a space, the @ button's picker was closed again
// by the textarea's 160 ms blur timer, and an empty match list rendered nothing at all.

const root = new URL('../', import.meta.url)
const mention = await import(new URL('src/client/mention.js', root).href)
const { findMentionTrigger, filterMentionCandidates, applyMention, insertMentionTrigger, emptyMentionHint, mentionEnterAction, pressMentionButton } = mention
const chatPaneSrc = readFileSync(new URL('src/client/components/ChatPane.jsx', root), 'utf8')

const at = text => findMentionTrigger(text, text.length)

test('typed @ opens the picker at line start, after spaces, after Chinese, after a newline', () => {
  assert.deepEqual(at('@'), { start: 0, query: '' })
  assert.deepEqual(at('请 @平'), { start: 2, query: '平' })
  assert.deepEqual(at('你好@'), { start: 2, query: '' }, 'right after Chinese text')
  assert.deepEqual(at('交给@平台'), { start: 2, query: '平台' })
  assert.deepEqual(at('你好\u3000@'), { start: 3, query: '' }, 'after a full-width space')
  assert.deepEqual(at('第一行\n@审'), { start: 4, query: '审' }, 'after a newline')
  assert.deepEqual(at('第一行\r\n@'), { start: 5, query: '' })
})

test('typed @ also opens after Chinese and English punctuation', () => {
  for (const p of ['，', '。', '：', '；', '！', '？', '、', '（', '「', '“', ',', '.', ':', ';', '!', '?', '(', '[', '"', "'"]) {
    const text = `看一下${p}@`
    assert.deepEqual(at(text), { start: text.length - 1, query: '' }, `after ${JSON.stringify(p)}`)
  }
})

test('typed @ does not open inside an e-mail address and closes once the name is finished', () => {
  assert.equal(at('me@example'), null)
  assert.equal(at('abc123@'), null)
  assert.equal(at('@平台主程 '), null, 'a space after the name closes the picker')
  assert.equal(at('没有艾特'), null)
  assert.equal(at('@' + 'x'.repeat(25)), null, 'filters longer than 24 chars stop matching')
})

test('the trigger follows the caret, not the end of the text', () => {
  const text = '先 @平 后面还有字'
  assert.deepEqual(findMentionTrigger(text, 4), { start: 2, query: '平' })
  assert.equal(findMentionTrigger(text, text.length), null)
})

test('typed letters filter the candidates (「@平」 finds 平台主程)', () => {
  const agents = [{ id: 'a1', name: '平台主程' }, { id: 'a2', name: '审查员' }, { id: 'a3', name: 'Planner' }]
  assert.deepEqual(filterMentionCandidates(agents, '平').map(a => a.id), ['a1'])
  assert.deepEqual(filterMentionCandidates(agents, 'plan').map(a => a.id), ['a3'])
  assert.deepEqual(filterMentionCandidates(agents, '').map(a => a.id), ['a1', 'a2', 'a3'])
  assert.deepEqual(filterMentionCandidates(agents, '开发', a => [a.id === 'a2' ? '开发 Agent' : '']).map(a => a.id), ['a2'])
  assert.deepEqual(filterMentionCandidates(agents, '不存在'), [])
})

test('picking an agent inserts "@名字 " in place of the typed filter', () => {
  assert.deepEqual(applyMention('你好@平', 2, 4, '平台主程'), { text: '你好@平台主程 ', cursor: 8 })
  assert.deepEqual(applyMention('a @x b', 2, 4, 'Planner'), { text: 'a @Planner  b', cursor: 11 })
  assert.deepEqual(applyMention('无触发', -1, 3, '审查员'), { text: '无触发 @审查员 ', cursor: 9 })
})

test('the @ button inserts one @ at the caret and keeps it as the open trigger', () => {
  assert.deepEqual(insertMentionTrigger('', 0), { text: '@', cursor: 1, start: 0 })
  assert.deepEqual(insertMentionTrigger('你好', 2), { text: '你好 @', cursor: 4, start: 3 })
  assert.deepEqual(insertMentionTrigger('你好 @', 4), { text: '你好 @', cursor: 4, start: 3 }, 'second press does not add another @')
  const r = insertMentionTrigger('你好', 2)
  assert.deepEqual(findMentionTrigger(r.text, r.cursor), { start: r.start, query: '' }, 'typing after the button keeps the picker')
})

test('empty match list shows a readable hint', () => {
  assert.match(emptyMentionHint(0, ''), /还没有 Agent/)
  assert.match(emptyMentionHint(3, '张三'), /没有名字含「张三」的 Agent/)
})

test('ChatPane uses the shared trigger and the @ button keeps the picker open', () => {
  assert.match(chatPaneSrc, /from '\.\.\/mention\.js'/)
  assert.doesNotMatch(chatPaneSrc, /\(\?:\^\|\[\\s\\u3000\]\)@/, 'old start-of-line/space-only regex is gone')
  assert.doesNotMatch(chatPaneSrc, /onBlur=\{\(\) => setTimeout\(\(\) => setMentionQuery\(null\), 160\)\}/, 'blur no longer closes the picker unconditionally')
  const btn = chatPaneSrc.slice(chatPaneSrc.indexOf('data-testid="btn-chat-mention"') - 600, chatPaneSrc.indexOf('data-testid="btn-chat-mention"'))
  assert.match(btn, /onMouseDown=\{e => e\.preventDefault\(\)\}/, '@ button does not steal focus from the textarea')
  assert.match(chatPaneSrc, /mentionQuery !== null && \(/, 'picker renders whenever a trigger is open, even with no match')
  assert.match(chatPaneSrc, /data-testid="agent-mention-empty"/)
})

test('typed @ opens after a half-width space, a tab and inside later lines', () => {
  assert.deepEqual(at('hello @'), { start: 6, query: '' }, 'after a half-width space')
  assert.deepEqual(at('hello\t@pl'), { start: 6, query: 'pl' })
  assert.deepEqual(at('第一行\n第二行，@平'), { start: 8, query: '平' })
  assert.deepEqual(at('邮箱 me@example.com，@'), { start: 18, query: '' }, 'an earlier e-mail does not block a later @')
})

test('Esc closes the picker even when nothing matches, and ↑↓/Enter/Tab stay wired', () => {
  const keydown = chatPaneSrc.slice(chatPaneSrc.indexOf('onKeyDown={e => {', chatPaneSrc.indexOf('data-testid="chat-input"')))
  const escAt = keydown.indexOf("e.key === 'Escape'")
  const guardedAt = keydown.indexOf('mentionQuery !== null && mentionCandidates.length > 0')
  assert.ok(escAt > 0 && guardedAt > 0)
  assert.ok(escAt < guardedAt, 'Escape is handled before the "has candidates" branch')
  const guarded = keydown.slice(guardedAt, keydown.indexOf('submit()', guardedAt))
  for (const key of ['ArrowDown', 'ArrowUp', 'Tab']) assert.match(guarded, new RegExp(`e\\.key === '${key}'`))
  assert.match(guarded, /enterAction === 'insert' \|\| e\.key === 'Tab'/)
  assert.match(guarded, /insertAgentMention\(/)
  assert.match(keydown, /mentionEnterAction\(\{ open: mentionQuery !== null, count: mentionCandidates\.length, shiftKey: e\.shiftKey \}\)/)
})

test('picking records the agent id and the send payload is unchanged', () => {
  assert.match(chatPaneSrc, /setMentionedIds\(prev => \(prev\.includes\(agent\.id\) \? prev : \[\.\.\.prev, agent\.id\]\)\)/)
  assert.match(chatPaneSrc, /mentionedAgentIds: activeMentions,/)
})

test('the empty hint has its own style and the bundle ships the fix', () => {
  const read = p => readFileSync(new URL(p, root), 'utf8')
  assert.match(read('src/client/styles.css'), /\.ot-mention-empty \{/)
  const bundle = read('dist/client.mjs')
  assert.ok(bundle.includes('agent-mention-empty'), 'dist/client.mjs was rebuilt')
  assert.ok(bundle.includes('.ot-mention-empty'))
})

test('release metadata: versions agree and the changelog describes this fix once', () => {
  const read = p => readFileSync(new URL(p, root), 'utf8')
  const version = JSON.parse(read('package.json')).version
  assert.equal(JSON.parse(read('plugin.json')).version, version)
  const lock = JSON.parse(read('package-lock.json'))
  assert.equal(lock.version, version)
  assert.equal(lock.packages[''].version, version)
  assert.ok(JSON.parse(read('contracts/plugin.json')).description.includes(`v${version} `))
  // Found by its own wording, not by the current version: later releases add sections above it.
  const sections = read('CHANGELOG.md').split(/^(?=## \[)/m)
  const mine = sections.filter(sec => sec.includes("Pressing the composer's `@` button opened the picker"))
  assert.equal(mine.length, 1)
  const headings = sections.map(s => (s.match(/^## \[([^\]]+)\]/) || [])[1]).filter(Boolean)
  assert.equal(new Set(headings).size, headings.length, 'no duplicate version headings')
})

// ---- Review round 2 ----

test('Enter with the picker open: inserts when there are candidates, is swallowed when there are none, never sends', () => {
  const table = [
    // open, count, shiftKey, expected
    [false, 0, false, 'send'],
    [false, 3, false, 'send'],
    [false, 0, true, 'newline'],
    [false, 3, true, 'newline'],
    [true, 3, false, 'insert'],
    [true, 1, false, 'insert'],
    [true, 3, true, 'insert'],
    [true, 0, false, 'swallow'],
    [true, 0, true, 'swallow'],
  ]
  assert.equal(typeof mentionEnterAction, 'function')
  for (const [open, count, shiftKey, expected] of table) {
    assert.equal(mentionEnterAction({ open, count, shiftKey }), expected, JSON.stringify({ open, count, shiftKey }))
  }
  // The reported case: "@zhang" matches nobody, Enter must not send the draft.
  const agents = [{ id: 'a1', name: '平台主程' }, { id: 'a2', name: '审查员' }]
  const hit = findMentionTrigger('@zhang', 6)
  const count = filterMentionCandidates(agents, hit.query).length
  assert.equal(count, 0)
  assert.notEqual(mentionEnterAction({ open: hit !== null, count, shiftKey: false }), 'send')
})

test('the picker head does not advertise "回车插入" when nothing matches', () => {
  assert.match(chatPaneSrc, /mentionCandidates\.length > 0 \? '选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）' : '没有匹配的 Agent（Esc 关闭）'/)
  const keydown = chatPaneSrc.slice(chatPaneSrc.indexOf('onKeyDown={e => {', chatPaneSrc.indexOf('data-testid="chat-input"')))
  const swallowAt = keydown.indexOf("enterAction === 'swallow'")
  const sendAt = keydown.indexOf("enterAction === 'send'")
  assert.ok(swallowAt > 0 && sendAt > swallowAt && keydown.indexOf('submit()') > sendAt, 'swallow is decided before the only submit()')
  assert.equal(keydown.slice(0, keydown.indexOf('/>')).split('submit()').length - 1, 1)
})

test('pressing the @ button while the picker is open changes nothing (no second @, whatever was typed after it)', () => {
  assert.equal(typeof pressMentionButton, 'function')
  assert.equal(pressMentionButton('hello @平', 8, true), null, 'open picker with a filter: keep it, insert nothing')
  assert.equal(pressMentionButton('你好 @', 4, true), null)
  assert.deepEqual(pressMentionButton('你好', 2, false), { text: '你好 @', cursor: 4, start: 3 })
  assert.deepEqual(pressMentionButton('你好 @', 4, false), { text: '你好 @', cursor: 4, start: 3 }, 'closed with Esc, caret after a bare @: reopen without adding one')
  assert.match(chatPaneSrc, /pressMentionButton\(draft, pos, mentionQuery !== null\)/)
})

test('full-width ＠ (U+FF20, what a Chinese IME types) opens the picker and is replaced by a half-width @', () => {
  assert.deepEqual(at('你好＠'), { start: 2, query: '' })
  assert.deepEqual(at('＠平'), { start: 0, query: '平' })
  assert.deepEqual(at('看一下，＠审查'), { start: 4, query: '审查' })
  assert.equal(at('me＠example'), null, 'still not after an ASCII letter')
  assert.equal(at('＠平台主程 '), null)
  assert.deepEqual(at('@平＠审'), { start: 2, query: '审' }, 'a second trigger character starts a new filter')
  assert.equal(at('@a＠b'), null, 'after an ASCII letter it is blocked like the half-width one')
  // Picking replaces the full-width trigger in place: it must not fall into the "no trigger → append" branch.
  assert.deepEqual(applyMention('你好＠平', 2, 4, '平台主程'), { text: '你好@平台主程 ', cursor: 8 })
  assert.deepEqual(applyMention('＠', 0, 1, '审查员'), { text: '@审查员 ', cursor: 5 })
  assert.ok(!applyMention('你好＠平', 2, 4, '平台主程').text.includes('＠'))
  // The button does not add a second trigger after a bare full-width one.
  assert.deepEqual(insertMentionTrigger('你好＠', 3), { text: '你好＠', cursor: 3, start: 2 })
})

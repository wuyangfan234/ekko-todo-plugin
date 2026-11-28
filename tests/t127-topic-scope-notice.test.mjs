// #127 (client only): the chat pane says at its top that a topic has no project, or holds cards of other
// projects (stateSnapshot.topics[].topicScopeReason). A topic without that field gets no extra row.
//  1. topicScopeNotice: the pure copy of the two codes, null for everything else.
//  2. TopicScopeNotice: rendered text, the action, closing it (per topic and code, page memory).
//  3. ChatPane: renders it for the open topic only; a topic without a reason has no notice in the markup.
//  4. wiring: App hands ChatPane a repair handler that calls repair-topic-todos, and the state fingerprint
//     changes when the reason changes.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { byTestId, cleanupClient, loadClient, mountElement, pkgRoot } from './helpers/mini-dom.mjs'
import { computeStateFingerprint } from '../src/client/state-fingerprint.js'
import {
  dismissScopeNotice, isScopeNoticeDismissed, repairScopeCopy, repairScopeResult, resetScopeNoticeDismissals, topicScopeNotice,
} from '../src/client/topic-scope.js'

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
// Assertions compare strings and booleans, never DOM nodes: a failed comparison of two nodes makes node:test
// print the whole tree.
const attr = (el, name) => (el ? el.getAttribute(name) : null)
const txt = el => (el ? el.textContent : null)

const PROJECTS = [{ id: 'proj-a', name: '天机阁' }, { id: 'proj-b', name: '绿洲排序' }]
const NO_PROJECT = { code: 'no-project', message: '服务端的长句，不拿来当界面文案', projectId: '', todoCount: 0, foreignTodoCount: 0 }
const FOREIGN_ONE = { code: 'foreign-todos', message: '服务端的长句', projectId: 'proj-a', todoCount: 3, foreignTodoCount: 3, suggestedProjectId: 'proj-b' }
const FOREIGN_MIXED = { code: 'foreign-todos', message: '服务端的长句', projectId: 'proj-a', todoCount: 5, foreignTodoCount: 2 }
const topicOf = (id, reason, extra = {}) => ({ id, title: `话题 ${id}`, messages: [], autopilot: true, projectId: reason?.projectId || (reason ? '' : 'proj-a'), createdAt: 1, updatedAt: 1, isRunning: false, ...(reason ? { topicScopeReason: reason } : {}), ...extra })

// ── 1. pure copy ─────────────────────────────────────────────────────────────────────────────────────

test('#127 topicScopeNotice: no reason, no topic or an unknown code give null', () => {
  assert.equal(topicScopeNotice(topicOf('t-ok', null), PROJECTS), null)
  assert.equal(topicScopeNotice(null, PROJECTS), null)
  assert.equal(topicScopeNotice(undefined, undefined), null)
  assert.equal(topicScopeNotice({ id: 't', topicScopeReason: null }, PROJECTS), null)
  assert.equal(topicScopeNotice({ id: 't', topicScopeReason: 'no-project' }, PROJECTS), null)
  assert.equal(topicScopeNotice({ id: 't', topicScopeReason: { code: 'something-new' } }, PROJECTS), null)
  assert.equal(topicScopeNotice({ id: '', topicScopeReason: NO_PROJECT }, PROJECTS), null)
})

test('#127 topicScopeNotice: no-project says the Chief binds the topic and offers the project list', () => {
  const n = topicScopeNotice(topicOf('t-1', NO_PROJECT), PROJECTS)
  assert.deepEqual(n, {
    key: 't-1:no-project',
    code: 'no-project',
    main: '本话题还没有绑定项目',
    note: '直接说要做什么，总管会自己判断项目并绑定',
    action: 'projects',
    actionLabel: '看看有哪些项目',
  })
  assert.equal(JSON.stringify(n).includes('服务端的长句'), false, 'the server sentence is not the page copy')
})

test('#127 topicScopeNotice: foreign-todos names the projects and counts the cards', () => {
  const one = topicScopeNotice(topicOf('t-2', FOREIGN_ONE), PROJECTS)
  assert.equal(one.main, '本话题属于项目 天机阁，但其中 3 张卡属于项目 绿洲排序')
  assert.equal(one.note, '需要修复话题归属')
  assert.deepEqual([one.key, one.code, one.action, one.actionLabel], ['t-2:foreign-todos', 'foreign-todos', 'repair', '修复话题归属'])
  // Cards of several other projects: counted as the foreign ones, not as every card of the topic.
  assert.equal(topicScopeNotice(topicOf('t-3', FOREIGN_MIXED), PROJECTS).main, '本话题属于项目 天机阁，但其中 2 张卡属于其他项目')
  // A project that is not in the list is shown by its id.
  assert.equal(topicScopeNotice(topicOf('t-4', FOREIGN_ONE), []).main, '本话题属于项目 proj-a，但其中 3 张卡属于项目 proj-b')
  assert.equal(topicScopeNotice(topicOf('t-4', FOREIGN_ONE), undefined).main, '本话题属于项目 proj-a，但其中 3 张卡属于项目 proj-b')
  // An older snapshot without foreignTodoCount falls back to todoCount.
  assert.equal(topicScopeNotice(topicOf('t-5', { code: 'foreign-todos', projectId: 'proj-a', todoCount: 4 }), PROJECTS).main, '本话题属于项目 天机阁，但其中 4 张卡属于其他项目')
})

test('#127 dismissal store: one entry per topic and code', () => {
  resetScopeNoticeDismissals()
  dismissScopeNotice('t-1:no-project')
  assert.equal(isScopeNoticeDismissed('t-1:no-project'), true)
  assert.equal(isScopeNoticeDismissed('t-2:no-project'), false)
  assert.equal(isScopeNoticeDismissed('t-1:foreign-todos'), false)
  resetScopeNoticeDismissals()
  assert.equal(isScopeNoticeDismissed('t-1:no-project'), false)
})

test('#127 repair copy and result sentence', () => {
  const topic = topicOf('t-2', FOREIGN_ONE)
  const copy = repairScopeCopy(topic, topicScopeNotice(topic, PROJECTS))
  assert.equal(copy.title, '修复话题归属')
  assert.equal(copy.name, '话题 t-2')
  assert.equal(copy.tone, 'primary')
  assert.equal(copy.body[0], '本话题属于项目 天机阁，但其中 3 张卡属于项目 绿洲排序。')
  assert.match(copy.body.join(''), /转到各自项目的话题/)
  assert.match(copy.body.join(''), /正在构建、审查或合并的卡片会跳过/)
  assert.equal(repairScopeResult({ moved: [{}, {}], skipped: [] }), '已转移 2 张卡片')
  assert.equal(repairScopeResult({ moved: [{}], skipped: [{ reason: '任务正在执行' }] }), '已转移 1 张卡片，1 张未转移（任务正在执行）')
  assert.equal(repairScopeResult({ moved: [], skipped: [] }), '没有需要转移的卡片')
})

// ── 2. the component ─────────────────────────────────────────────────────────────────────────────────

test('#127 TopicScopeNotice: nothing for a topic without a reason; text, note and action for the two codes', async () => {
  resetScopeNoticeDismissals()
  const mod = await loadClient({ TopicScopeNotice: 'components/TopicScopeNotice.jsx' })
  try {
    const { React, TopicScopeNotice } = mod
    const calls = []
    const el = topic => React.createElement(TopicScopeNotice, { topic, projects: PROJECTS, onOpenProjects: t => calls.push(['projects', t.id]), onRepair: t => calls.push(['repair', t.id]) })
    const view = await mountElement(mod, el(topicOf('t-ok', null)))
    assert.equal(Boolean(view.q('topic-scope-notice')), false, 'a topic without topicScopeReason renders no notice')
    assert.equal(view.container.textContent, '', 'and no other text or wrapper')
    assert.equal(view.container.childNodes.length, 0)

    await view.rerender(el(topicOf('t-1', NO_PROJECT)))
    assert.equal(attr(view.q('topic-scope-notice'), 'data-code'), 'no-project')
    assert.equal(attr(view.q('topic-scope-notice'), 'data-topic-id'), 't-1')
    assert.equal(txt(view.q('topic-scope-main')), '本话题还没有绑定项目')
    assert.equal(txt(view.q('topic-scope-note')), '直接说要做什么，总管会自己判断项目并绑定')
    assert.equal(txt(view.q('btn-topic-scope-action')), '看看有哪些项目')
    assert.equal(String(txt(view.q('topic-scope-notice'))).includes('服务端的长句'), false)
    await view.click(view.q('btn-topic-scope-action'))
    assert.deepEqual(calls, [['projects', 't-1']])

    await view.rerender(el(topicOf('t-2', FOREIGN_ONE)))
    assert.equal(attr(view.q('topic-scope-notice'), 'data-code'), 'foreign-todos')
    assert.equal(txt(view.q('topic-scope-main')), '本话题属于项目 天机阁，但其中 3 张卡属于项目 绿洲排序')
    assert.equal(txt(view.q('topic-scope-note')), '需要修复话题归属')
    assert.equal(txt(view.q('btn-topic-scope-action')), '修复话题归属')
    await view.click(view.q('btn-topic-scope-action'))
    assert.deepEqual(calls, [['projects', 't-1'], ['repair', 't-2']])

    // Back to a topic without a reason: the row is gone again.
    await view.rerender(el(topicOf('t-ok', null)))
    assert.equal(Boolean(view.q('topic-scope-notice')), false)
    assert.equal(view.container.childNodes.length, 0)

    // No handler, no button: the notice never shows an action that does nothing.
    await view.rerender(React.createElement(TopicScopeNotice, { topic: topicOf('t-1', NO_PROJECT), projects: PROJECTS }))
    assert.equal(Boolean(view.q('topic-scope-notice')), true)
    assert.equal(Boolean(view.q('btn-topic-scope-action')), false)
    await view.rerender(React.createElement(TopicScopeNotice, { topic: topicOf('t-2', FOREIGN_ONE), projects: PROJECTS, onOpenProjects() {} }))
    assert.equal(Boolean(view.q('btn-topic-scope-action')), false, 'the repair action needs the repair handler')
    await view.unmount()
  } finally { cleanupClient(); resetScopeNoticeDismissals() }
})

test('#127 TopicScopeNotice: closed stays closed for that topic, the next topic without a project shows it again', async () => {
  resetScopeNoticeDismissals()
  const mod = await loadClient({ TopicScopeNotice: 'components/TopicScopeNotice.jsx' })
  try {
    const { React, TopicScopeNotice } = mod
    const el = topic => React.createElement(TopicScopeNotice, { topic, projects: PROJECTS, onOpenProjects() {}, onRepair() {} })
    const view = await mountElement(mod, el(topicOf('t-1', NO_PROJECT)))
    assert.equal(Boolean(view.q('topic-scope-notice')), true)
    await view.click(view.q('btn-topic-scope-dismiss'))
    assert.equal(Boolean(view.q('topic-scope-notice')), false, 'closed at once')
    assert.equal(view.container.childNodes.length, 0)
    // A new snapshot of the same topic (new object, same reason) keeps it closed.
    await view.rerender(el(topicOf('t-1', { ...NO_PROJECT })))
    assert.equal(Boolean(view.q('topic-scope-notice')), false)
    // The next topic without a project shows its own notice.
    await view.rerender(el(topicOf('t-9', NO_PROJECT)))
    assert.equal(attr(view.q('topic-scope-notice'), 'data-topic-id'), 't-9')
    // Back on the first topic it is still closed.
    await view.rerender(el(topicOf('t-1', NO_PROJECT)))
    assert.equal(Boolean(view.q('topic-scope-notice')), false)
    // A remount (leaving the chat for another view and coming back) keeps it closed too.
    await view.unmount()
    const again = await mountElement(mod, el(topicOf('t-1', NO_PROJECT)))
    assert.equal(Boolean(again.q('topic-scope-notice')), false)
    // The same topic with another reason says so: closing "no project" does not hide "cards of other projects".
    await again.rerender(el(topicOf('t-1', FOREIGN_ONE)))
    assert.equal(attr(again.q('topic-scope-notice'), 'data-code'), 'foreign-todos')
    await again.unmount()
  } finally { cleanupClient(); resetScopeNoticeDismissals() }
})

// ── 3. ChatPane ──────────────────────────────────────────────────────────────────────────────────────

class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) { this.map.set(k, String(v)) }
  removeItem(k) { this.map.delete(k) }
}
let renderPane = null
let workDir = ''
async function loadRenderer() {
  if (renderPane) return renderPane
  workDir = mkdtempSync(join(tmpdir(), 'ekko-t127-'))
  const entry = join(workDir, 'entry.jsx')
  writeFileSync(entry, [
    `import React from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `import { ChatPane } from ${JSON.stringify(join(pkgRoot, 'src/client/components/ChatPane.jsx'))}`,
    `export function render(props) { return renderToStaticMarkup(React.createElement(ChatPane, props)) }`,
  ].join('\n'))
  const out = join(workDir, 'bundle.mjs')
  const purifyStub = join(workDir, 'purify-stub.mjs')
  writeFileSync(purifyStub, 'export default { sanitize: html => html, addHook() {}, removeHook() {} }\n')
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
    loader: { '.css': 'text' }, nodePaths: [join(pkgRoot, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', alias: { dompurify: purifyStub },
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  })
  renderPane = (await import(pathToFileURL(out).href)).render
  return renderPane
}
after(() => { if (workDir) rmSync(workDir, { recursive: true, force: true }) })

const paneHtml = async (topic, extra = {}) => {
  globalThis.localStorage = new MemoryStorage()
  try {
    const render = await loadRenderer()
    return render({
      ctx: { ui: { notify() {} } },
      state: { agents: [], projects: PROJECTS, todos: [], topics: [topic], settings: {} },
      topic, projects: PROJECTS, todos: [],
      liveStream: { isWorking: false, tools: [], text: '', reasoning: '' },
      busy: false, composerFocusSeq: 0, onSendMessage() {},
      onOpenSettingsTab() {}, onRepairTopicTodos() {},
      ...extra,
    })
  } finally { delete globalThis.localStorage }
}
const text = html => html.replace(/<[^>]+>/g, '')

test('#127 ChatPane: a topic without topicScopeReason has no notice; the two codes show theirs above the stream', async () => {
  const normal = await paneHtml(topicOf('t-ok', null))
  assert.equal(normal.includes('topic-scope-notice'), false, 'no notice for a normal topic')
  assert.equal(normal.includes('ot-scope-notice'), false, 'and no wrapper row either')
  assert.equal(text(normal).includes('还没有绑定项目'), false)

  const none = await paneHtml(topicOf('t-1', NO_PROJECT))
  assert.equal((none.match(/data-testid="topic-scope-notice"/g) || []).length, 1)
  assert.match(none, /data-testid="topic-scope-notice" data-code="no-project" data-topic-id="t-1"/)
  assert.ok(text(none).includes('本话题还没有绑定项目直接说要做什么，总管会自己判断项目并绑定看看有哪些项目'))
  assert.ok(none.indexOf('topic-scope-notice') < none.indexOf('data-testid="chat-stream"'), 'above the message stream')
  assert.ok(none.indexOf('topic-scope-notice') > none.indexOf('</header>'), 'below the header, not inside it')

  const foreign = await paneHtml(topicOf('t-2', FOREIGN_ONE))
  assert.match(foreign, /data-code="foreign-todos"/)
  assert.ok(text(foreign).includes('本话题属于项目 天机阁，但其中 3 张卡属于项目 绿洲排序需要修复话题归属修复话题归属'))

  // The welcome screen (no topic open) has no notice.
  assert.equal((await paneHtml(null)).includes('topic-scope-notice'), false)
  // Without the handlers the pane still says it, without a button.
  const bare = await paneHtml(topicOf('t-1', NO_PROJECT), { onOpenSettingsTab: undefined, onRepairTopicTodos: undefined })
  assert.ok(bare.includes('topic-scope-notice'))
  assert.equal(bare.includes('btn-topic-scope-action'), false)
})

// ── 4. wiring and style ──────────────────────────────────────────────────────────────────────────────

test('#127 wiring: ChatPane gets the open topic only; App calls repair-topic-todos and reads the state again', () => {
  const pane = read('src/client/components/ChatPane.jsx')
  assert.match(pane, /<TopicScopeNotice\s+topic=\{topic\}\s+projects=\{projects\}/)
  assert.match(pane, /onOpenProjects=\{onOpenSettingsTab \? \(\) => onOpenSettingsTab\('projects'\) : undefined\}/)
  assert.match(pane, /onRepair=\{onRepairTopicTodos \? \(t, notice\) => askConfirm\(repairScopeCopy\(t, notice\), \(\) => onRepairTopicTodos\(t\.id\)\) : undefined\}/)
  const app = read('src/client/App.jsx')
  assert.match(app, /onRepairTopicTodos=\{repairTopicTodos\}/)
  const at = app.indexOf('const repairTopicTodos = useCallback(')
  assert.ok(at > 0)
  const body = app.slice(at, app.indexOf('}, [ctx, callRpc, loadState])', at))
  const call = body.indexOf("callRpc('repair-topic-todos', { topicId }, undefined, { onError: err => { refused = err } })")
  const rethrow = body.indexOf('if (refused) throw refused')
  const reload = body.indexOf('void loadState({ urgent: true })')
  assert.ok(call >= 0 && rethrow >= 0 && reload >= 0, 'call, rethrow and reload are all there')
  assert.ok(call < rethrow && rethrow < reload)
  // The server is as it was: the RPC this calls is the one that already exists.
  assert.match(read('src/server/rpc-handlers.mjs'), /registerRpc\(ctx, contract, 'repair-topic-todos'/)
})

test('#127 fingerprint: a reason that appears, changes or disappears re-renders the page', () => {
  const snap = reason => ({ topics: [topicOf('t-1', null, { projectId: 'proj-a', ...(reason ? { topicScopeReason: reason } : {}) })] })
  const none = computeStateFingerprint(snap(null))
  const one = computeStateFingerprint(snap(FOREIGN_ONE))
  assert.notEqual(none, one)
  assert.notEqual(one, computeStateFingerprint(snap({ ...FOREIGN_ONE, todoCount: 4, foreignTodoCount: 4 })))
  assert.notEqual(one, computeStateFingerprint(snap({ ...FOREIGN_ONE, suggestedProjectId: '' })))
  assert.notEqual(one, computeStateFingerprint(snap({ ...FOREIGN_ONE, code: 'no-project' })))
  assert.equal(one, computeStateFingerprint(snap({ ...FOREIGN_ONE, message: '只换了句子' })), 'the sentence is not shown, so it does not re-render')
})

test('#127 style: the notice reuses .ot-loop-notice and its text is one run that wraps (no overflow on a phone)', () => {
  const css = read('src/client/styles.css')
  const rule = sel => { const m = new RegExp(`\\n${sel.replace(/[.\\-_]/g, '\\$&')} \\{([^}]*)\\}`).exec(css); return m ? m[1] : '' }
  assert.match(read('src/client/components/TopicScopeNotice.jsx'), /className="ot-loop-notice ot-scope-notice"/)
  assert.match(rule('.ot-scope-notice-wrap'), /flex: none/)
  assert.match(rule('.ot-scope-notice-wrap'), /min-width: 0/)
  assert.match(rule('.ot-scope-notice__text'), /flex: 1 1 auto; min-width: 0/)
  assert.match(rule('.ot-scope-notice__close'), /flex: none/)
  // Sentence, note and link are one inline text run: no nowrap, no fixed width, no flex row of their own.
  const run = rule('.ot-scope-notice__text') + rule('.ot-scope-notice__text > strong') + rule('.ot-scope-notice__note') + rule('.ot-scope-notice .ot-scope-notice__action')
  assert.equal(/white-space: nowrap|(^|[; ])width:|display: (inline-)?flex/.test(run), false)
  assert.match(rule('.ot-loop-notice'), /overflow-wrap: anywhere/, 'the reused class breaks a long project name')
})

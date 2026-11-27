// Todo #100: clicks dropped by the busy lock, shortcuts firing while typing, cmdk vs global double trigger,
// destructive actions without a second confirmation, and failures shown as success / as an empty list.
//
// Three layers: the rules in src/client/interaction.js called directly, the real components mounted in the
// minimal DOM (tests/helpers/mini-dom.mjs) and clicked, and the wiring of each call site read from source.
// Todo #112: the busy lock (src/client/rpc-gate.js) is no longer checked by reading App.jsx: the whole page is
// mounted and its buttons are clicked, so bypassing the lock in App.callRpc turns the mounted cases red.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ACTION_NOT_DONE, BUSY_HINT_DUPLICATE, BUSY_HINT_QUEUED, SHORTCUTS_ALLOWED_WHILE_TYPING, copyText, copyWithNotice,
  createRpcGate, dangerCopy, hasPrimaryModifier, isMacPlatform, isTypingTarget, loadErrorText, paletteVimBindings,
  quickConfirmPlan, resolveGlobalShortcut, rpcCallKey, runQuickConfirm, settleAction,
} from '../src/client/interaction.js'
import * as rpcGateModule from '../src/client/rpc-gate.js'
import { FakeElement, cleanupClient, document, installPageEnvironment, loadClient, mountElement, walk } from './helpers/mini-dom.mjs'

const { busyHint, runGatedRpc } = rpcGateModule

after(cleanupClient)

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const code = rel => read(rel).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(r => setTimeout(r, 0))
const key = (k, extra = {}) => ({ key: k, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra })
const el = (tag, attrs = {}, parent = null) => {
  const node = new FakeElement(document, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  if (parent) parent.appendChild(node)
  return node
}
const TOPICS = [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }, { id: 't3', title: 'C', archived: true }]
const TODOS = [{ id: 'd1', number: 7, title: '修复登录', phase: 'review', gateKind: 'merge', projectId: 'p1' }]
const base = { mac: true, typing: false, cmdkOpen: false, cmdkMode: 'all', overlayOpen: false, decisionOpen: false, selectedTodoId: '', selectedTopicId: 't1', activeView: 'workbench', topics: TOPICS, todos: TODOS }

// ── 1. busy lock ──────────────────────────────────────────────────────────

test('#100-1a: a click during another call is announced and still runs afterwards', async () => {
  const blocked = []
  const busy = []
  const gate = createRpcGate({ onBusyChange: v => busy.push(v), onBlocked: b => blocked.push(b) })
  const first = deferred()
  const ran = []
  const p1 = gate.run('save:1', async () => { ran.push('save'); return first.promise })
  const p2 = gate.run('delete:2', async () => { ran.push('delete'); return 'deleted' })
  assert.deepEqual(ran, ['save'], 'the second call waits for the first')
  assert.deepEqual(blocked, [{ key: 'delete:2', duplicate: false }], 'the blocked click produced a hint')
  first.resolve('saved')
  assert.equal(await p1, 'saved')
  assert.equal(await p2, 'deleted', 'the last action was not swallowed')
  assert.deepEqual(ran, ['save', 'delete'])
  assert.deepEqual(busy, [true, false], 'busy stays on across the queued call')
  assert.equal(gate.busy, false)
})

test('#100-1b: a repeat of the call in flight is the only thing discarded; the newest waiting action wins', async () => {
  const blocked = []
  const gate = createRpcGate({ onBlocked: b => blocked.push(b) })
  const first = deferred()
  const ran = []
  const p1 = gate.run('create:x', () => { ran.push('create'); return first.promise })
  assert.equal(await gate.run('create:x', () => { ran.push('create-again'); return 1 }), null, 'double click → null')
  const pA = gate.run('a', () => { ran.push('a'); return 'A' })
  const pB = gate.run('b', () => { ran.push('b'); return 'B' })
  assert.equal(await gate.run('b', () => { ran.push('b-again'); return 2 }), null, 'repeat of the waiting call → null')
  first.resolve('ok')
  assert.equal(await p1, 'ok')
  assert.equal(await pA, null, 'the superseded waiting call resolves null')
  assert.equal(await pB, 'B')
  assert.deepEqual(ran, ['create', 'b'])
  assert.deepEqual(blocked.map(b => b.duplicate), [true, false, false, true])
})

test('#100-1c: a failing call releases the lock', async () => {
  const busy = []
  const gate = createRpcGate({ onBusyChange: v => busy.push(v) })
  await assert.rejects(gate.run('x', async () => { throw new Error('boom') }), /boom/)
  assert.deepEqual(busy, [true, false])
  assert.equal(await gate.run('y', async () => 5), 5)
})

test('#100-1d (#112): runGatedRpc keys a call by name + input; a free call never takes or waits for the lock', async () => {
  const blocked = []
  const gate = createRpcGate({ onBlocked: b => blocked.push(b) })
  const first = deferred()
  const ran = []
  const p1 = runGatedRpc(gate, { name: 'todo-action', input: { todoId: 'a', action: 'start_build' } }, () => { ran.push('a'); return first.promise })
  // The same action again: announced as a repeat, never executed.
  assert.equal(await runGatedRpc(gate, { name: 'todo-action', input: { todoId: 'a', action: 'start_build' } }, () => { ran.push('a-again'); return 1 }), null)
  assert.deepEqual(blocked, [{ key: rpcCallKey('todo-action', { todoId: 'a', action: 'start_build' }), duplicate: true }])
  // The same RPC with another input is another action: it waits.
  const p2 = runGatedRpc(gate, { name: 'todo-action', input: { todoId: 'b', action: 'start_build' } }, () => { ran.push('b'); return 'B' })
  assert.equal(blocked[1].duplicate, false)
  // A free call runs at once while the lock is held, without a hint.
  assert.equal(await runGatedRpc(gate, { name: 'send-topic-message', input: { text: 'hi' }, free: true }, async () => { ran.push('free'); return 'sent' }), 'sent')
  assert.equal(blocked.length, 2, 'the free call produced no hint')
  assert.deepEqual(ran, ['a', 'free'])
  first.resolve('A')
  assert.equal(await p1, 'A')
  assert.equal(await p2, 'B')
  assert.deepEqual(ran, ['a', 'free', 'b'])
  assert.equal(gate.busy, false)
  // exec throwing through runGatedRpc releases the lock too.
  await assert.rejects(runGatedRpc(gate, { name: 'x', input: null }, async () => { throw new Error('boom') }), /boom/)
  assert.equal(gate.busy, false)
  assert.equal(await runGatedRpc(gate, { name: 'y', input: null }, async () => 5), 5)
})

test('#100-1e (#112): the two hints, the call key, and one gate shared by interaction.js and rpc-gate.js', () => {
  assert.equal(BUSY_HINT_DUPLICATE, '正在处理上一个操作，请稍候')
  assert.match(BUSY_HINT_QUEUED, /完成后继续执行/)
  assert.equal(busyHint({ duplicate: true }), BUSY_HINT_DUPLICATE)
  assert.equal(busyHint({ duplicate: false }), BUSY_HINT_QUEUED)
  assert.notEqual(rpcCallKey('a', { id: 1 }), rpcCallKey('a', { id: 2 }))
  assert.equal(rpcCallKey('a', { id: 1 }), rpcCallKey('a', { id: 1 }))
  assert.equal(createRpcGate, rpcGateModule.createRpcGate, 'interaction.js re-exports the module, it has no second copy')
  assert.equal(runGatedRpc, rpcGateModule.runGatedRpc)
})

// The whole page mounted: App.callRpc itself is exercised, not read. Two schedules give two different
// actions behind buttons the busy flag does not disable (「立即运行」).
async function mountPage({ onRpc } = {}) {
  const restore = installPageEnvironment()
  const mod = await loadClient({ App: 'App.jsx' })
  const state = {
    settings: { onboardingCompleted: true }, concurrency: {}, counts: {}, projects: [], agents: [], memories: [], topics: [],
    todos: [], quotaProviders: [], runtime: {},
    schedules: [
      { id: 's1', todoId: '', enabled: true, timezone: 'Asia/Shanghai', nextRunAt: 0 },
      { id: 's2', todoId: '', enabled: true, timezone: 'Asia/Shanghai', nextRunAt: 0 },
    ],
  }
  const sent = []
  const notes = []
  const ctx = {
    slot: 'page', view: 'main', locale: 'zh-CN', host: {}, messages: { on: () => () => {} },
    ui: { notify: (message, level) => notes.push({ message, level }) },
    rpc: {
      call: (name, input) => {
        if (name === 'get-state') return Promise.resolve(state)
        const entry = { name, input, ...deferred() }
        sent.push(entry)
        onRpc?.(entry)
        return entry.promise
      },
    },
  }
  const view = await mountElement(mod, mod.React.createElement(mod.App, { ctx }))
  await view.click(view.q('btn-open-schedules'))
  const triggers = () => sent.filter(c => c.name === 'trigger-schedule')
  const close = async () => { await view.unmount(); restore() }
  return { view, sent, notes, triggers, close }
}

test('#100-1f (#112) mounted App: the second click on the same button sends no RPC and shows the hint; another button waits and then runs', async () => {
  const page = await mountPage()
  const { view, notes, triggers } = page
  try {
    const s1 = view.q('btn-trigger-schedule-s1')
    const s2 = view.q('btn-trigger-schedule-s2')
    assert.ok(s1 && s2, 'both 「立即运行」 buttons are rendered')
    await view.click(s1)
    assert.deepEqual(triggers().map(c => c.input.id), ['s1'], 'the first click is sent')
    assert.equal(s1.disabled, false, 'the button is not disabled while busy, so only the lock can stop a repeat')

    await view.click(s1)
    assert.deepEqual(triggers().map(c => c.input.id), ['s1'], 'the repeated click sent nothing')
    assert.deepEqual(notes, [{ message: BUSY_HINT_DUPLICATE, level: 'info' }], 'and the user was told why')

    await view.click(s2)
    assert.deepEqual(triggers().map(c => c.input.id), ['s1'], 'another action waits for the call in flight')
    assert.deepEqual(notes[1], { message: BUSY_HINT_QUEUED, level: 'info' })

    triggers()[0].resolve(null)
    await view.settle()
    assert.deepEqual(triggers().map(c => c.input.id), ['s1', 's2'], 'the waiting action ran once the first call ended')
    triggers()[1].resolve(null)
    await view.settle()

    await view.click(s1)
    assert.deepEqual(triggers().map(c => c.input.id), ['s1', 's2', 's1'], 'the lock is released: the same button works again')
    triggers()[2].resolve(null)
    await view.settle()
    assert.deepEqual(notes.filter(n => n.level === 'info').length, 2, 'no hint for calls that were not blocked')
  } finally { await page.close() }
})

test('#100-1g (#112) mounted App: a failing RPC releases the lock, the next click is sent', async () => {
  const page = await mountPage()
  const { view, notes, triggers } = page
  try {
    const s1 = view.q('btn-trigger-schedule-s1')
    await view.click(s1)
    triggers()[0].reject(new Error('调度服务不可用'))
    await view.settle()
    assert.deepEqual(notes, [{ message: '调度服务不可用', level: 'error' }])
    await view.click(s1)
    assert.equal(triggers().length, 2, 'the click after the failure is sent, not treated as a repeat')
    assert.equal(notes.length, 1, 'and no busy hint is shown')
    triggers()[1].resolve(null)
    await view.settle()
  } finally { await page.close() }
})

// ── 2. new-task dialog ────────────────────────────────────────────────────

test('#100-2: a failed create keeps the dialog open with everything typed and shows the reason', async () => {
  const mod = await loadClient({ CreateTaskDialog: 'components/Dialogs.jsx' })
  let closed = 0
  const calls = []
  let fail = true
  const pending = []
  const onCreate = input => {
    calls.push(input)
    const d = deferred()
    pending.push(d)
    return d.promise
  }
  const props = {
    open: true, busy: false,
    projects: [{ id: 'p1', name: 'demo' }], agents: [], topics: [{ id: 't1', projectId: 'p1' }],
    defaultProjectId: 'p1', defaultTopicId: 't1',
    onClose: () => { closed += 1 }, onCreate, onNeedProject() {},
  }
  const v = await mountElement(mod, mod.React.createElement(mod.CreateTaskDialog, props))
  try {
    const title = v.q('input-task-title')
    const spec = v.q('input-task-spec')
    await v.input(title, '修复登录超时')
    await v.input(spec, '只改 auth.js')
    const form = walk(v.container).find(n => n.localName === 'form')
    await v.submit(form)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].title, '修复登录超时')
    assert.equal(closed, 0, 'not closed before the server answered')
    assert.equal(v.q('btn-submit-task').disabled, true, 'submit is disabled while creating')
    assert.equal(v.q('btn-submit-task').textContent, '创建中…')
    assert.equal(v.q('input-task-title').value, '修复登录超时', 'input kept while creating')

    await mod.React.act(async () => { pending[0].reject(new Error('项目仓库不可用')) })
    await v.settle()
    assert.equal(closed, 0, 'a failure does not close the dialog')
    assert.equal(v.q('input-task-title').value, '修复登录超时')
    assert.equal(v.q('input-task-spec').value, '只改 auth.js')
    assert.match(v.q('create-task-error').textContent, /项目仓库不可用/)
    assert.equal(v.q('btn-submit-task').disabled, false, 'the user can retry')

    fail = false
    await v.submit(form)
    await mod.React.act(async () => { pending[1].resolve({ projects: [] }) })
    await v.settle()
    assert.equal(calls.length, 2)
    assert.equal(closed, 1, 'closed once the card exists')
    assert.equal(v.q('input-task-title').value, '', 'form cleared after success')
    assert.equal(v.q('create-task-error'), null)
    assert.equal(fail, false)
  } finally { await v.unmount() }
})

test('#100-2b: callRpc resolving null (error already toasted) also counts as not created', async () => {
  assert.deepEqual(await settleAction(async () => null, '任务没有创建成功，请重试。'), { ok: false, error: '任务没有创建成功，请重试。' })
  assert.deepEqual(await settleAction(async () => false), { ok: false, error: ACTION_NOT_DONE })
  assert.deepEqual(await settleAction(async () => { throw new Error('超时') }), { ok: false, error: '超时' })
  assert.deepEqual(await settleAction(async () => ({ a: 1 })), { ok: true, value: { a: 1 } })
  // App hands the server's reason to the dialog instead of swallowing it in callRpc.
  // Since #101 the create goes through createTaskWithTopic (topic first, then the card); the re-throw lives there.
  assert.match(code('src/client/App.jsx'), /onCreate=\{\(input, hooks\) => createTaskWithTopic\(\{ input, topics: state\.topics, callRpc, onTopicCreated: hooks\?\.onTopicCreated \}\)\}/)
  const src = code('src/client/trust-view.js')
  const i = src.indexOf('export async function createTaskWithTopic')
  assert.ok(i > 0)
  assert.match(src.slice(i, i + 700), /onError: err => \{ refused = err \}[\s\S]*if \(refused\) throw refused[\s\S]*call\('create-todo'/)
})

// ── 3. shortcuts while typing ─────────────────────────────────────────────

test('#100-3a: ⌥↑/⌥↓ and ⌘[ do nothing while typing, in every kind of text target', () => {
  const rich = el('div', { contenteditable: 'true' })
  const targets = {
    input: el('input'),
    textarea: el('textarea'),
    select: el('select'),
    'contenteditable host': rich,
    'node inside rich text': el('span', {}, el('p', {}, rich)),
    'role=textbox': el('div', { role: 'textbox' }),
    'input inside a popover': el('input', {}, el('div', { 'data-radix-popper-content-wrapper': '' })),
  }
  for (const [name, target] of Object.entries(targets)) {
    assert.equal(isTypingTarget(target), true, `${name} is a typing target`)
    const s = { ...base, typing: isTypingTarget(target), activeView: 'project' }
    assert.equal(resolveGlobalShortcut(key('ArrowUp', { altKey: true }), s), null, `⌥↑ in ${name}`)
    assert.equal(resolveGlobalShortcut(key('ArrowDown', { altKey: true }), s), null, `⌥↓ in ${name}`)
    assert.equal(resolveGlobalShortcut(key('[', { metaKey: true }), s), null, `⌘[ in ${name}`)
  }
  const button = el('button', {}, el('div'))
  assert.equal(isTypingTarget(button), false)
  assert.equal(isTypingTarget(null), false)
  const s = { ...base, typing: false, activeView: 'project' }
  assert.deepEqual(resolveGlobalShortcut(key('ArrowDown', { altKey: true }), s), { id: 'switch-topic', topicId: 't2' })
  assert.deepEqual(resolveGlobalShortcut(key('ArrowUp', { altKey: true }), s), { id: 'switch-topic', topicId: 't2' }, 'wraps over the two live topics')
  assert.deepEqual(resolveGlobalShortcut(key('[', { metaKey: true }), s), { id: 'back' })
})

test('#100-3b: every shortcut is gated by typing; only the listed modifier chords stay available', () => {
  const s = { ...base, selectedTodoId: 'd1', activeView: 'project' }
  const cases = [
    ['palette', key('k', { metaKey: true })],
    ['palette', key('p', { metaKey: true })],
    ['palette', key('j', { metaKey: true })],
    ['new-task', key('n', { metaKey: true })],
    ['back', key('[', { metaKey: true })],
    ['settings', key(',', { metaKey: true })],
    ['shortcuts', key('/', { metaKey: true })],
    ['toggle-board', key('b', { metaKey: true, altKey: true })],
    ['toggle-sidebar', key('b', { metaKey: true })],
    ['expand-board', key('Enter', { metaKey: true, shiftKey: true })],
    ['switch-topic', key('ArrowDown', { altKey: true })],
    ['refresh-diff', key('s', { metaKey: true, altKey: true })],
    ['quick-confirm', key('Enter', { metaKey: true, altKey: true })],
  ]
  for (const [id, e] of cases) {
    assert.equal(resolveGlobalShortcut(e, s)?.id, id, `${id} resolves when not typing`)
    const typed = resolveGlobalShortcut(e, { ...s, typing: true })
    if (SHORTCUTS_ALLOWED_WHILE_TYPING.has(id)) assert.equal(typed?.id, id, `${id} still works while typing`)
    else assert.equal(typed, null, `${id} is ignored while typing`)
  }
  for (const id of ['back', 'switch-topic', 'refresh-diff', 'quick-confirm', 'escape-home']) {
    assert.equal(SHORTCUTS_ALLOWED_WHILE_TYPING.has(id), false, `${id} must not be allowed while typing`)
  }
  const idle = { ...base, activeView: 'project' }
  assert.equal(resolveGlobalShortcut(key('n'), idle)?.id, 'new-task')
  assert.equal(resolveGlobalShortcut(key('n'), { ...idle, typing: true }), null, 'plain N types an n')
  assert.equal(resolveGlobalShortcut(key('Escape'), idle)?.id, 'escape-home')
  assert.equal(resolveGlobalShortcut(key('Escape'), { ...idle, typing: true }), null)
  assert.equal(resolveGlobalShortcut(key('n'), { ...idle, overlayOpen: true }), null)
  assert.equal(resolveGlobalShortcut({ ...key('k', { metaKey: true }), isComposing: true }, idle), null, 'IME composing')
  // App uses the shared rule and no longer keeps its own copy.
  const src = code('src/client/App.jsx')
  assert.match(src, /resolveGlobalShortcut\(e, \{/)
  assert.match(src, /typing: isTypingTarget\(e\.target\)/)
  assert.doesNotMatch(src, /const isTypingTarget = /)
  assert.doesNotMatch(src, /e\.metaKey \|\| e\.ctrlKey/)
})

// ── 4. cmdk vs global ─────────────────────────────────────────────────────

test('#100-4: with the palette open Ctrl+J/K/N/P never triggers both cmdk navigation and a global shortcut', () => {
  // cmdk moves the selection on these keys only when `vimBindings && e.ctrlKey` (read from the shipped build).
  const cmdk = read('node_modules/cmdk/dist/index.mjs')
  const flag = /vimBindings:(\w+)=!0/.exec(cmdk)?.[1]
  assert.ok(flag, 'cmdk has a vimBindings prop that defaults to true')
  assert.ok(cmdk.includes(`case"n":case"j":{${flag}&&e.ctrlKey&&`), 'next: n / j')
  assert.ok(cmdk.includes(`case"p":case"k":{${flag}&&e.ctrlKey&&`), 'previous: p / k')
  const cmdkHandles = (e, mac) => paletteVimBindings(mac) && e.ctrlKey
  for (const mac of [true, false]) {
    for (const k of ['j', 'k', 'n', 'p']) {
      const e = key(k, { ctrlKey: true })
      const global = resolveGlobalShortcut(e, { ...base, mac, cmdkOpen: true, typing: true })
      assert.equal(Boolean(global) && Boolean(cmdkHandles(e, mac)), false, `Ctrl+${k} mac=${mac} is not handled twice`)
      assert.equal(Boolean(global) || Boolean(cmdkHandles(e, mac)), true, `Ctrl+${k} mac=${mac} still does one thing`)
    }
  }
  // macOS: Ctrl is the text-editing / list-navigation key, ⌘ is the global one.
  assert.equal(resolveGlobalShortcut(key('n', { ctrlKey: true }), base), null)
  assert.equal(resolveGlobalShortcut(key('b', { ctrlKey: true }), base), null)
  assert.equal(resolveGlobalShortcut(key('k', { metaKey: true }), base)?.id, 'palette')
  assert.equal(paletteVimBindings(true), true)
  // Elsewhere Ctrl is the global modifier, so cmdk's Ctrl navigation is switched off.
  const win = { ...base, mac: false }
  assert.equal(resolveGlobalShortcut(key('k', { ctrlKey: true }), win)?.id, 'palette')
  assert.equal(resolveGlobalShortcut(key('k', { metaKey: true }), win), null, 'the Windows key is not a modifier')
  assert.equal(paletteVimBindings(false), false)
  assert.deepEqual(resolveGlobalShortcut(key('k', { ctrlKey: true }), { ...win, cmdkOpen: true }), { id: 'palette', mode: 'all', close: true })
  assert.equal(hasPrimaryModifier({ metaKey: true }, true), true)
  assert.equal(hasPrimaryModifier({ ctrlKey: true }, true), false)
  assert.equal(isMacPlatform({ platform: 'MacIntel' }), true)
  assert.equal(isMacPlatform({ userAgentData: { platform: 'macOS' } }), true)
  assert.equal(isMacPlatform({ platform: 'Win32' }), false)
  assert.equal(isMacPlatform({ platform: 'Linux x86_64' }), false)
  assert.match(code('src/client/components/CommandPalette.jsx'), /<Command\s+label="Ekko ToDo 快捷命令"\s+vimBindings=\{paletteVimBindings\(isMacPlatform\(\)\)\}[\s>]/)
})

// ── 5. destructive actions ────────────────────────────────────────────────

test('#100-5a: the confirm copy of each destructive action names the target and its consequence', () => {
  const samples = {
    agent: [{ id: 'a1', name: '后端主程' }, '后端主程'],
    memory: [{ id: 'm1', title: '发版口径', content: '…' }, '发版口径'],
    schedule: [{ name: '#3 周报 · 每天 09:00' }, '#3 周报 · 每天 09:00'],
    topic: [{ id: 't1', title: '登录重构' }, '登录重构'],
    quota: [{ id: 'q1', name: '自建网关' }, '自建网关'],
  }
  for (const [kind, [target, name]] of Object.entries(samples)) {
    const copy = dangerCopy(kind, target)
    assert.match(copy.title, /^删除/, `${kind} title`)
    assert.equal(copy.name, name, `${kind} names its target`)
    assert.ok(copy.body.length >= 1 && copy.body.some(l => /无法恢复/.test(l)), `${kind} states the consequence`)
    assert.equal(copy.action, '确认删除')
    assert.equal(copy.pending, '删除中…')
    assert.equal(copy.tone, 'danger')
  }
  assert.throws(() => dangerCopy('nope', {}), /unknown danger kind/)
})

test('#100-5b: none of the five delete entries calls its handler straight from the click', () => {
  const sites = [
    ['src/client/components/AgentManager.jsx', /onClick=\{\(\) => askConfirm\(dangerCopy\('agent', draft\), \(\) => onDeleteAgent\(draft\.id\)\)\}/, /onClick=\{\(\) => onDeleteAgent\(/],
    ['src/client/components/SettingsPanel.jsx', /onClick=\{\(\) => askConfirm\(dangerCopy\('memory', mem\), \(\) => onDeleteMemory\(mem\.id\)\)\}/, /onClick=\{\(\) => onDeleteMemory\(/],
    ['src/client/components/SchedulesView.jsx', /askConfirm\(\s*dangerCopy\('schedule', [^\n]+\),\s*\(\) => onDeleteSchedule\?\.\(s\.id\),\s*\)/, /onClick=\{\(\) => onDeleteSchedule\?\.\(/],
    ['src/client/components/ChatPane.jsx', /askConfirm\(dangerCopy\('topic', topic\), \(\) => onDeleteTopic\?\.\(topic\.id\)\)/, /setMenuOpen\(false\); onDeleteTopic\?\.\(/],
    ['src/client/components/QuotaHub.jsx', /onClick=\{\(\) => askConfirm\(dangerCopy\('quota', provider\), async \(\) => \{/, /onClick=\{async \(\) => \{ await onDelete\(/],
  ]
  for (const [file, wired, direct] of sites) {
    const src = code(file)
    assert.match(src, wired, `${file} asks first`)
    assert.doesNotMatch(src, direct, `${file} has no one-click delete`)
    assert.match(src, /\{confirmNode\}/, `${file} renders the confirm dialog`)
    assert.match(src, /useConfirm\(\)/)
  }
})

test('#100-5c: deleting a schedule needs the confirm click; cancel deletes nothing', async () => {
  const mod = await loadClient({ SchedulesView: 'components/SchedulesView.jsx' })
  const deleted = []
  const schedules = [{ id: 's1', todoId: 'd1', projectId: 'p1', enabled: true, kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' }]
  const v = await mountElement(mod, mod.React.createElement(mod.SchedulesView, {
    schedules, projects: [{ id: 'p1', name: 'demo' }], agents: [],
    todos: [{ id: 'd1', number: 3, title: '周报', projectId: 'p1' }],
    onDeleteSchedule: async id => { deleted.push(id); return { projects: [] } },
  }))
  try {
    assert.equal(v.q('confirm-dialog'), null)
    await v.click(v.q('btn-delete-schedule-s1'))
    assert.deepEqual(deleted, [], 'the first click deletes nothing')
    assert.equal(v.q('confirm-dialog-title').textContent, '删除定时规则')
    assert.match(v.q('confirm-dialog-name').textContent, /#3 周报/)
    assert.match(v.q('confirm-dialog-body').textContent, /不再触发，无法恢复/)
    await v.click(v.q('btn-confirm-cancel'))
    assert.equal(v.q('confirm-dialog'), null)
    assert.deepEqual(deleted, [], 'cancel deletes nothing')
    await v.click(v.q('btn-delete-schedule-s1'))
    await v.click(v.q('btn-confirm-action'))
    assert.deepEqual(deleted, ['s1'], 'deleted once after the confirm click')
    assert.equal(v.q('confirm-dialog'), null, 'closed after success')
  } finally { await v.unmount() }
})

test('#100-5d: the confirm dialog is disabled while deleting and keeps a failure on screen for a retry', async () => {
  const mod = await loadClient({ ConfirmDialog: 'components/ConfirmDialog.jsx' })
  const runs = []
  let closed = 0
  const request = { copy: dangerCopy('agent', { id: 'a1', name: '后端主程' }), run: () => { const d = deferred(); runs.push(d); return d.promise } }
  const v = await mountElement(mod, mod.React.createElement(mod.ConfirmDialog, { request, onClose: () => { closed += 1 } }))
  try {
    assert.equal(v.q('btn-confirm-action').textContent, '确认删除')
    assert.equal(v.q('btn-confirm-action').disabled, false)
    await v.click(v.q('btn-confirm-action'))
    assert.equal(runs.length, 1)
    assert.equal(v.q('btn-confirm-action').disabled, true, 'disabled while deleting')
    assert.equal(v.q('btn-confirm-cancel').disabled, true)
    assert.equal(v.q('btn-confirm-action').textContent, '删除中…')
    await v.click(v.q('btn-confirm-action'))
    assert.equal(runs.length, 1, 'a second click while pending does not run it again')

    await mod.React.act(async () => { runs[0].resolve(null) })
    await v.settle()
    assert.equal(closed, 0, 'a failed delete does not close the dialog')
    assert.match(v.q('confirm-dialog-error').textContent, /操作没有完成/)
    assert.equal(v.q('btn-confirm-action').disabled, false)
    assert.equal(v.q('btn-confirm-action').textContent, '重试：确认删除')

    await v.click(v.q('btn-confirm-action'))
    await mod.React.act(async () => { runs[1].reject(new Error('至少需要保留一个 Agent')) })
    await v.settle()
    assert.match(v.q('confirm-dialog-error').textContent, /至少需要保留一个 Agent/)
    assert.equal(closed, 0)

    await v.click(v.q('btn-confirm-action'))
    await mod.React.act(async () => { runs[2].resolve({ projects: [] }) })
    await v.settle()
    assert.equal(closed, 1, 'closed after the delete succeeded')

    await v.rerender(mod.React.createElement(mod.ConfirmDialog, { request: null, onClose() {} }))
    assert.equal(v.q('confirm-dialog'), null, 'no request → nothing rendered')
  } finally { await v.unmount() }
})

// ── 6. ⌘⌥↵ ────────────────────────────────────────────────────────────────

test('#100-6a: ⌘⌥↵ on a review card asks before merging and nothing is sent until confirmed', async () => {
  const todo = TODOS[0]
  const plan = quickConfirmPlan(todo, { id: 'p1', defaultBranch: 'main' })
  assert.equal(plan.action, 'approve_merge')
  assert.equal(plan.confirm.title, '合并 #7 到 main')
  assert.equal(plan.confirm.action, '合并 #7 到 main')
  assert.equal(plan.confirm.name, '修复登录')
  assert.match(plan.confirm.body.join(''), /立即合并进 main/)
  assert.equal(quickConfirmPlan(todo, { defaultBranch: 'develop' }).confirm.title, '合并 #7 到 develop')
  assert.match(quickConfirmPlan({ ...todo, gateKind: 'changes' }, null).confirm.body.join(''), /不采纳该意见/)

  const sent = []
  const asked = []
  const outcome = runQuickConfirm({ plan, call: async () => { sent.push(plan.action); return {} }, ask: (copy, run) => asked.push({ copy, run }) })
  await tick()
  assert.equal(outcome, 'asked')
  assert.deepEqual(sent, [], 'not merged before the confirmation')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].copy.title, '合并 #7 到 main')
  await asked[0].run()
  assert.deepEqual(sent, ['approve_merge'], 'merged once confirmed')
})

test('#100-6b: the toast names the action that ran; actions without a merge run directly', async () => {
  const plans = {
    confirm_plan: quickConfirmPlan({ number: 4, phase: 'confirm', gateKind: 'plan' }),
    complete: quickConfirmPlan({ number: 5, phase: 'review', gateKind: 'deliverable' }),
    approve_merge: quickConfirmPlan({ number: 6, phase: 'review', gateKind: 'merge' }),
    start_build: quickConfirmPlan({ number: 8, phase: 'todo' }),
  }
  for (const [action, plan] of Object.entries(plans)) assert.equal(plan.action, action)
  assert.match(plans.confirm_plan.success, /已批准 #4 的方案/)
  assert.match(plans.complete.success, /已验收 #5/)
  assert.match(plans.approve_merge.success, /已开始合并 #6 到 main/)
  assert.match(plans.start_build.success, /已启动 #8/)
  assert.equal(new Set(Object.values(plans).map(p => p.success.replace(/#\d+/, ''))).size, 4, 'four different messages')
  assert.deepEqual(Object.values(plans).map(p => Boolean(p.confirm)), [false, false, true, false], 'only the merge asks')
  assert.equal(quickConfirmPlan({ number: 6, phase: 'review', gateKind: 'deploy' }).confirm.title, '批准放行部署 #6')
  assert.equal(quickConfirmPlan({ number: 9, phase: 'building' }), null)
  assert.equal(quickConfirmPlan(null), null)

  const sent = []
  let asked = 0
  assert.equal(runQuickConfirm({ plan: plans.confirm_plan, call: async () => { sent.push('confirm_plan') }, ask: () => { asked += 1 } }), 'called')
  await tick()
  assert.deepEqual(sent, ['confirm_plan'])
  assert.equal(asked, 0)
  const errors = []
  runQuickConfirm({ plan: plans.start_build, call: async () => { throw new Error('仓库被占用') }, ask() {}, onError: e => errors.push(e.message) })
  await tick()
  assert.deepEqual(errors, ['仓库被占用'], 'a failure is reported, not swallowed')
  assert.equal(runQuickConfirm({ plan: null, call() { throw new Error('never') }, ask() {} }), 'none')

  const src = code('src/client/App.jsx')
  assert.doesNotMatch(src, /已执行快捷确认操作/)
  assert.match(src, /runQuickConfirm\(\{\s*plan,\s*ask: askConfirm,/)
  assert.match(src, /notify\(plan\.success, 'success'\)/)
})

// ── 7. copy ───────────────────────────────────────────────────────────────

test('#100-7: copy reports the real outcome', async () => {
  const written = []
  const ok = { clipboard: { writeText: async t => { written.push(t) } } }
  const denied = { clipboard: { writeText: async () => { throw new Error('NotAllowedError') } } }
  assert.equal(await copyText('abc', ok), true)
  assert.deepEqual(written, ['abc'])
  assert.equal(await copyText('abc', denied), false, 'a rejected write is a failure')
  assert.equal(await copyText('abc', {}), false, 'no clipboard API is a failure')
  assert.equal(await copyText('abc', null), false)

  const notes = []
  const notify = (msg, level) => notes.push([msg, level])
  assert.equal(await copyWithNotice('id-1', notify, { success: '已复制 Agent ID', failure: '复制 Agent ID 失败' }, ok), true)
  assert.equal(await copyWithNotice('id-1', notify, { success: '已复制 Agent ID', failure: '复制 Agent ID 失败' }, denied), false)
  assert.equal(await copyWithNotice('x', notify, undefined, {}), false)
  assert.deepEqual(notes, [['已复制 Agent ID', 'success'], ['复制 Agent ID 失败', 'error'], ['复制失败，请手动选择文本复制', 'error']])

  const agent = code('src/client/components/AgentManager.jsx')
  assert.match(agent, /const ok = await copyWithNotice\(draft\.id, ctx\?\.ui\?\.notify,[^\n]+\)\s*if \(!ok\) return\s*setCopiedId\(true\)/, 'the check mark needs a real success')
  assert.doesNotMatch(agent, /writeText\?\.\(draft\.id\)\.catch\(\(\) => \{\}\)/)
  const ws = code('src/client/components/ProjectWorkspace.jsx')
  assert.match(ws, /const ok = await copyWithNotice\(filePreview\.content, ctx\.ui\?\.notify,[^\n]+\)\s*if \(!ok\) return\s*setCopiedFile\(true\)/)
  for (const file of ['src/client/components/ChatPane.jsx', 'src/client/components/SessionTraceView.jsx']) {
    assert.doesNotMatch(code(file), /writeText\?\.\([^)]*\)\.catch\(\(\) => \{\}\)/, `${file} no longer ignores the result`)
  }
})

// ── 8. silent failures ────────────────────────────────────────────────────

test('#100-8a: a failed load renders its reason and a retry button, never an empty state', async () => {
  assert.equal(loadErrorText(new Error('git 不可用'), '读取分支失败'), '读取分支失败：git 不可用')
  assert.equal(loadErrorText(null, '读取分支失败'), '读取分支失败')
  assert.equal(loadErrorText('', '读取提交记录失败'), '读取提交记录失败')
  const mod = await loadClient({ LoadError: 'components/LoadError.jsx' })
  let retried = 0
  const v = await mountElement(mod, mod.React.createElement(mod.LoadError, { message: '读取分支失败：git 不可用', testId: 'branch-load-error', onRetry: () => { retried += 1 } }))
  try {
    const box = v.q('branch-load-error')
    assert.equal(box.getAttribute('role'), 'alert')
    assert.match(box.textContent, /读取分支失败：git 不可用/)
    assert.doesNotMatch(box.textContent, /暂无/)
    await v.click(v.q('branch-load-error-retry'))
    assert.equal(retried, 1)
    await v.rerender(mod.React.createElement(mod.LoadError, { message: '', testId: 'branch-load-error' }))
    assert.equal(v.q('branch-load-error'), null, 'nothing when there is no error')
  } finally { await v.unmount() }
})

test('#100-8b: the six silent catches now surface the error with a way to retry', () => {
  const app = code('src/client/App.jsx')
  const i = app.indexOf("action: 'refresh_diff' })")
  assert.match(app.slice(i, i + 320), /\.catch\(err => notify\(`\$\{loadErrorText\(err, '刷新 Diff 失败'\)\}（可再按 ⌘⌥S 重试）`, 'error'\)\)/)
  assert.doesNotMatch(app.slice(i, i + 320), /\.catch\(\(\) => \{\}\)/)

  const ws = code('src/client/components/ProjectWorkspace.jsx')
  assert.match(ws, /catch \(err\) \{\s*setBranchError\(loadErrorText\(err, '读取分支失败'\)\)/)
  assert.match(ws, /catch \(err\) \{\s*setCommits\(\[\]\)\s*setCommitsError\(loadErrorText\(err, '读取提交记录失败'\)\)/)
  assert.match(ws, /\{branchError \? \(\s*<LoadError message=\{branchError\} onRetry=\{\(\) => \{ void loadBranches\(\) \}\}[^\n]+\/>\s*\) : filteredBranches\.length === 0 \?/, 'the error comes before 暂无匹配分支')
  assert.match(ws, /\) : commitsError \? \(\s*<LoadError message=\{commitsError\} onRetry=\{\(\) => \{ void loadCommits\(\) \}\}[^\n]+\/>\s*\) : commits\.length === 0 \?/, 'the error comes before 暂无提交记录')

  const wiz = code('src/client/components/OnboardingWizard.jsx')
  assert.match(wiz, /\.catch\(err => \{ if \(active\) \{ setCatalog\(null\); setCatalogError\(loadErrorText\(err, '读取模型列表失败'\)\) \} \}\)/)
  assert.match(wiz, /catalogError \? '读取失败' :/)
  assert.match(wiz, /<LoadError message=\{catalogError\} onRetry=\{\(\) => setCatalogTry\(n => n \+ 1\)\}/)

  const settings = code('src/client/components/SettingsPanel.jsx')
  assert.match(settings, /\.catch\(err => \{ if \(active\) setChiefCatalogError\(loadErrorText\(err, '读取模型列表失败'\)\) \}\)/)
  assert.match(settings, /<LoadError\s+message=\{chiefCatalogError\}\s+onRetry=\{\(\) => setChiefCatalogTry\(n => n \+ 1\)\}/)
  assert.match(settings, /\.catch\(err => \{ ctx\.ui\?\.notify\?\.\(loadErrorText\(err, '打开模型选择器失败'\), 'error'\); return null \}\)/)
  assert.match(settings, /ctx\.ui\?\.notify\?\.\('模型选择器不可用', 'error'\)/)
  for (const [name, src] of [['OnboardingWizard', wiz], ['SettingsPanel', settings]]) {
    assert.doesNotMatch(src, /\.catch\(\(\) => \{\}\)/, `${name} has no empty catch left`)
    assert.doesNotMatch(src, /\.catch\(\(\) => null\)/, `${name} has no silent null catch left`)
  }
})

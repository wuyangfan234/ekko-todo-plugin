// Todo #100 (client only): the page's interaction rules as plain functions, so tests call them directly.
// Nothing here is sent or stored; no contract model, RPC or column changes.
//
//  - createRpcGate: the page-wide busy lock. A click that arrives while another call is in flight is no
//    longer dropped in silence: the user gets a hint, and the latest different action runs when the current
//    one ends. A repeat of the action already in flight (double click) is the only thing discarded.
//  - resolveGlobalShortcut: every global shortcut in one decision, gated by "is the user typing".
//  - quickConfirmPlan / runQuickConfirm: what ⌘⌥↵ does to a card; a merge needs a second confirmation.
//  - dangerCopy: title, target name and consequence of each destructive action (one confirm dialog).
//  - settleAction / copyText: report what really happened instead of assuming success.

// The busy lock lives in rpc-gate.js (Todo #112); re-exported so existing imports keep working.
export { BUSY_HINT_DUPLICATE, BUSY_HINT_QUEUED, busyHint, createRpcGate, rpcCallKey, runGatedRpc } from './rpc-gate.js'

// ── keyboard ──────────────────────────────────────────────────────────────

export function isMacPlatform(nav = globalThis.navigator) {
  const raw = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '')
  return /mac|iphone|ipad|ipod/i.test(raw)
}

// The one "command" modifier of the platform: ⌘ on macOS, Ctrl elsewhere. On macOS Ctrl+N/P/K/B/J are the
// text-editing keys of every input (next/previous line, kill line, back) and cmdk's list navigation, so they
// are never treated as global shortcuts there.
export function hasPrimaryModifier(e, mac) {
  return mac ? Boolean(e?.metaKey) : Boolean(e?.ctrlKey)
}

// cmdk moves the selection on Ctrl+J/N/K/P when vimBindings is on. Where Ctrl is the global modifier those
// same keys open/switch the palette, so the bindings are only enabled where Ctrl is not global (macOS).
export function paletteVimBindings(mac) {
  return Boolean(mac)
}

const TYPING_SELECTOR = [
  'input', 'textarea', 'select',
  '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
  '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
].join(',')

/** True when the key event comes from somewhere the user enters text (also inside a rich-text node). */
export function isTypingTarget(target) {
  if (!target) return false
  const tag = String(target.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (target.isContentEditable) return true
  if (typeof target.closest === 'function') {
    try { return Boolean(target.closest(TYPING_SELECTOR)) } catch { return false }
  }
  return false
}

// Shortcuts that still work while typing: all need the command modifier and none is a text-editing key.
// Everything else (⌘[, ⌥↑/⌥↓, ⌘⌥S, ⌘⌥↵, N, Esc) is ignored while the user is typing.
export const SHORTCUTS_ALLOWED_WHILE_TYPING = new Set([
  'palette', 'new-task', 'settings', 'shortcuts', 'toggle-board', 'toggle-sidebar', 'expand-board',
])

function matchShortcut(e, s) {
  const mod = hasPrimaryModifier(e, s.mac)
  const key = String(e.key || '')
  const keyLower = key.toLowerCase()
  const plainMod = mod && !e.altKey && !e.shiftKey
  if (plainMod && keyLower === 'k') return { id: 'palette', mode: 'all', close: Boolean(s.cmdkOpen && s.cmdkMode === 'all') }
  if (plainMod && keyLower === 'p') return { id: 'palette', mode: 'tasks', close: false }
  if (plainMod && keyLower === 'j') return { id: 'palette', mode: 'topics', close: false }
  if (plainMod && keyLower === 'n') return { id: 'new-task' }
  if (plainMod && (key === '[' || e.code === 'BracketLeft')) return { id: 'back' }
  if (mod && !e.altKey && key === ',') return { id: 'settings' }
  if (mod && !e.altKey && (key === '/' || e.code === 'Slash')) return { id: 'shortcuts' }
  if (mod && e.altKey && keyLower === 'b') return { id: 'toggle-board' }
  if (mod && !e.altKey && keyLower === 'b') return { id: 'toggle-sidebar' }
  if (mod && e.shiftKey && key === 'Enter') return { id: 'expand-board' }
  if (e.altKey && !mod && !e.metaKey && !e.ctrlKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
    const live = (s.topics || []).filter(t => !t.archived)
    if (live.length < 2) return null
    const idx = Math.max(0, live.findIndex(t => t.id === s.selectedTopicId))
    const nextIdx = key === 'ArrowUp' ? (idx - 1 + live.length) % live.length : (idx + 1) % live.length
    return { id: 'switch-topic', topicId: live[nextIdx].id }
  }
  // `e.code` too: with ⌥ held macOS can report "ß" as e.key.
  if (mod && e.altKey && (keyLower === 's' || e.code === 'KeyS') && s.selectedTodoId) return { id: 'refresh-diff', todoId: s.selectedTodoId }
  if (mod && e.altKey && key === 'Enter' && s.selectedTodoId) {
    const todo = (s.todos || []).find(t => t.id === s.selectedTodoId)
    return todo ? { id: 'quick-confirm', todoId: todo.id } : null
  }
  if (!mod && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && keyLower === 'n' && !s.overlayOpen && !s.selectedTodoId) return { id: 'new-task' }
  if (key === 'Escape' && !s.overlayOpen && !s.selectedTodoId && !s.decisionOpen && s.activeView !== 'workbench') return { id: 'escape-home' }
  return null
}

/**
 * The global shortcut a keydown stands for, or null. `s`: { mac, typing, cmdkOpen, cmdkMode, overlayOpen,
 * decisionOpen, selectedTodoId, selectedTopicId, activeView, topics, todos }.
 */
export function resolveGlobalShortcut(e, s = {}) {
  if (!e || e.isComposing || e.keyCode === 229) return null
  const hit = matchShortcut(e, s)
  if (!hit) return null
  const viaPlainKey = hit.id === 'new-task' && !hasPrimaryModifier(e, s.mac)
  if (s.typing && (viaPlainKey || !SHORTCUTS_ALLOWED_WHILE_TYPING.has(hit.id))) return null
  return hit
}

// ── ⌘⌥↵ ───────────────────────────────────────────────────────────────────

/** What the quick-confirm shortcut does to this card: { action, label, success, confirm? } or null. */
export function quickConfirmPlan(todo, project) {
  if (!todo) return null
  const n = `#${todo.number}`
  if (todo.phase === 'confirm' && todo.gateKind === 'plan') {
    return { action: 'confirm_plan', label: '批准方案', success: `已批准 ${n} 的方案并开始实施` }
  }
  if (todo.phase === 'review' && todo.gateKind === 'deliverable') {
    return { action: 'complete', label: '验收', success: `已验收 ${n}` }
  }
  if (todo.phase === 'review') {
    const branch = project?.defaultBranch || 'main'
    const deploy = todo.gateKind === 'deploy'
    const title = deploy ? `批准放行部署 ${n}` : `合并 ${n} 到 ${branch}`
    return {
      action: 'approve_merge',
      label: deploy ? '放行部署' : '合并',
      success: deploy ? `已批准放行 ${n}` : `已开始合并 ${n} 到 ${branch}`,
      confirm: {
        title,
        name: todo.title || '',
        body: [
          deploy
            ? `确认后 ${n} 立即放行，无法从这里撤回。`
            : `确认后 ${n} 的分支会立即合并进 ${branch}，无法从这里撤回。`,
          todo.gateKind === 'changes' ? '这张卡的审查意见是「需要修改」，合并等于不采纳该意见。' : '',
        ].filter(Boolean),
        action: title,
        pending: deploy ? '放行中…' : '合并中…',
        tone: 'primary',
      },
    }
  }
  if (todo.phase === 'todo') return { action: 'start_build', label: '开工', success: `已启动 ${n} 的隔离 Worktree 构建` }
  return null
}

/** Runs a quick-confirm plan. A plan with `confirm` is only handed to `ask`; `call` runs when the user confirms. */
export function runQuickConfirm({ plan, call, ask, onError }) {
  if (!plan) return 'none'
  if (plan.confirm) {
    ask(plan.confirm, call)
    return 'asked'
  }
  Promise.resolve().then(call).catch(err => { onError?.(err) })
  return 'called'
}

// ── destructive actions ───────────────────────────────────────────────────

const DANGER_COPY = {
  agent: t => ({
    title: '删除 Agent',
    name: t?.name || t?.id || '',
    body: ['删除后这个 Agent 的配置、主备模型链和故障冷却记录一并清除，无法恢复。', '已指派给它的任务不会被删除。'],
  }),
  memory: t => ({
    title: '删除记忆',
    name: String(t?.title || t?.content || '').slice(0, 60),
    body: ['删除后总管不再读到这条记忆，无法恢复。'],
  }),
  schedule: t => ({
    title: '删除定时规则',
    name: t?.name || t?.title || '',
    body: ['删除后这条规则不再触发，无法恢复。', '它已经创建的任务不受影响。'],
  }),
  topic: t => ({
    title: '删除话题',
    name: t?.title || '',
    body: ['删除后话题的对话、排队消息和关注关系一并清除，无法恢复。', '话题里的任务卡片保留在看板上。'],
  }),
  quota: t => ({
    title: '删除配额源',
    name: t?.name || t?.id || '',
    body: ['删除后这个自定义配额源的配置和已保存的密钥一并清除，无法恢复。'],
  }),
}

/** Copy of the confirm dialog for one destructive action: { title, name, body[], action, pending, tone }. */
export function dangerCopy(kind, target) {
  const make = DANGER_COPY[kind]
  if (!make) throw new Error(`unknown danger kind: ${kind}`)
  return { action: '确认删除', pending: '删除中…', tone: 'danger', ...make(target) }
}

export const ACTION_NOT_DONE = '操作没有完成，可重试或取消。'

/** Awaits `run` and says what happened: null / false / a throw are failures (callRpc resolves null on error). */
export async function settleAction(run, fallback = ACTION_NOT_DONE) {
  try {
    const res = await run()
    if (res === null || res === false) return { ok: false, error: fallback }
    return { ok: true, value: res }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) || fallback }
  }
}

/** Writes to the clipboard and resolves true only when the browser accepted it. */
export async function copyText(text, nav = globalThis.navigator) {
  try {
    if (typeof nav?.clipboard?.writeText !== 'function') return false
    await nav.clipboard.writeText(String(text ?? ''))
    return true
  } catch {
    return false
  }
}

/** copyText plus the toast for both outcomes; resolves the real result. */
export async function copyWithNotice(text, notify, { success = '已复制', failure = '复制失败，请手动选择文本复制' } = {}, nav) {
  const ok = await copyText(text, nav)
  notify?.(ok ? success : failure, ok ? 'success' : 'error')
  return ok
}

/** Message of a failed load, never empty (an empty list must not stand in for an error). */
export function loadErrorText(err, fallback) {
  const msg = String(err?.message || err || '').trim()
  return msg ? `${fallback}：${msg}` : fallback
}

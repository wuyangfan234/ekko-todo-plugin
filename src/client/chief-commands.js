// v0.9.43 (Todo #29): Chief context capsule, manual compression and the slash-command panel, kept free of JSX
// so `node --test` can load them.
//
// The plugin implements no command itself. Every command is the host's own: the page sends the text over the
// live Chief session handle (`ctx.host.sessions.connect(...).run('/compress')`), and the host answers with a
// `session.command` event (plus `compression.started` / `compression.completed` for /compress). This module
// only recognizes commands, decides when a button may be pressed, and reads the host events.

// Mirror of the host's command table (chat-run socket): typed name -> canonical action.
export const HOST_COMMANDS = Object.freeze({
  usage: 'usage', status: 'status', yolo: 'yolo', abort: 'abort', queue: 'queue', skill: 'skill', bundles: 'bundles',
  learn: 'learn', plan: 'plan', moa: 'moa', goal: 'goal', subgoal: 'subgoal', clear: 'clear', title: 'title',
  compress: 'compress', compact: 'compress', context: 'context', fork: 'branch', steer: 'steer', destroy: 'destroy',
  'reload-mcp': 'reload-mcp', 'reload-skills': 'reload-skills', reload_skills: 'reload-skills',
})

// Commands migrated into the Chief composer. `when`: idle = only while the Chief is not running,
// running = only while it runs, any = always. `args`: the command needs text after it.
export const SLASH_COMMANDS = Object.freeze([
  { name: 'status', label: '查看大总管会话状态', when: 'any' },
  { name: 'context', label: '查看上下文用量', when: 'any' },
  { name: 'usage', label: '查看本会话 token 用量', when: 'any' },
  { name: 'compress', label: '手动压缩上下文（会丢历史细节）', when: 'idle', confirm: true },
  { name: 'compact', label: '同 /compress', when: 'idle', confirm: true },
  { name: 'clear', label: '清空当前显示（宿主历史保留）', when: 'idle', confirm: true },
  { name: 'title', label: '改宿主会话标题', when: 'any', args: '新标题' },
  { name: 'abort', label: '中止当前这一轮', when: 'running' },
  { name: 'queue', label: '运行中追加一条排队消息', when: 'running', args: '内容' },
  { name: 'steer', label: '运行中插话引导', when: 'running', args: '指令' },
].map(c => Object.freeze(c)))

// Host commands that belong to Hermes Agent itself and are not opened in the Chief session.
export const CLOSED_COMMANDS = Object.freeze(['plan', 'moa', 'goal', 'subgoal', 'skill', 'bundles', 'learn', 'yolo', 'fork', 'destroy', 'reload-mcp', 'reload-skills', 'reload_skills'])

// Confirmation copy of the commands that ask first. It describes what the host does with the exact text that
// is sent: `/compress`, and `/clear` without `--history` (host: "Cleared the current display. History in the
// database was not deleted."). The dialog renders this, so the copy and the sent text cannot drift apart.
export const COMMAND_CONFIRM_COPY = Object.freeze({
  compress: Object.freeze({
    title: '压缩大总管上下文？',
    body: Object.freeze([
      '较早的对话会被浓缩成一段摘要，历史细节会丢失。',
      '大约需要 10–30 秒，最长等 120 秒；期间发给大总管的消息会排队，完成后自动送达。',
      '只压缩大总管会话，不影响正在执行的任务卡片（开发 / 审查会话）。',
    ]),
    action: '压缩',
  }),
  clear: Object.freeze({
    title: '清空当前显示？',
    body: Object.freeze([
      '只清空宿主当前显示的对话；数据库历史保留，大总管仍记得之前的对话。',
      '插件的聊天记录和任务卡片保留不动。',
    ]),
    action: '清空显示',
  }),
})

export const COMPRESS_TIMEOUT_MS = 120000
export const COMMAND_TIMEOUT_MS = 15000
export const PROBE_TIMEOUT_MS = 8000
// Used when the host's compression threshold could not be read (the value configured on this machine).
export const DEFAULT_COMPRESS_THRESHOLD = 0.65
// The capsule warns from this share of the host's auto-compress trigger (window × threshold).
export const AUTO_COMPRESS_WARN_RATIO = 0.9

const SLASH_TRIGGER_RE = /^\s*[/／]([A-Za-z0-9_-]{0,24})$/
// Same shape as the host parser: "/name", then a space, a colon/comma, CJK text or the end.
const HOST_COMMAND_RE = /^\/([a-zA-Z][\w-]*)(?:\s+|[:：、,，]\s*|(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])|$)([\s\S]*)$/u

function commandMeta(name) {
  return SLASH_COMMANDS.find(c => c.name === name) || null
}

/**
 * Parse a composer text the way the host does. Returns null when the host would not treat it as a command
 * (then it is a normal message). A full-width "／" at the start counts as "/".
 * @returns {{ rawName: string, action: string, args: string, open: boolean, text: string } | null}
 */
export function parseSlashCommand(text) {
  const value = String(text ?? '').trim().replace(/^／/, '/')
  if (!value.startsWith('/')) return null
  const match = value.match(HOST_COMMAND_RE)
  if (!match) return null
  const rawName = match[1].toLowerCase()
  const action = HOST_COMMANDS[rawName]
  if (!action) return null
  const args = (match[2] || '').trim()
  return { rawName, action, args, open: Boolean(commandMeta(rawName)), text: `/${rawName}${args ? ` ${args}` : ''}` }
}

/**
 * The "/query" the caret is in, when the composer text up to the caret is only that command token.
 * @returns {{ start: number, query: string } | null}
 */
export function findSlashTrigger(text, cursorPos) {
  const value = String(text ?? '')
  const pos = typeof cursorPos === 'number' && cursorPos >= 0 ? Math.min(cursorPos, value.length) : value.length
  const before = value.slice(0, pos)
  const match = before.match(SLASH_TRIGGER_RE)
  if (!match) return null
  return { start: before.length - match[1].length - 1, query: match[1] }
}

/** Migrated commands whose name starts with the query first, then those containing it. */
export function filterSlashCommands(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return [...SLASH_COMMANDS]
  const starts = SLASH_COMMANDS.filter(c => c.name.startsWith(q))
  const contains = SLASH_COMMANDS.filter(c => !c.name.startsWith(q) && (c.name.includes(q) || c.label.includes(q)))
  return [...starts, ...contains]
}

/** Replace the "/query" token with the picked command (a trailing space when it takes text). */
export function applySlashCommand(text, start, cursorPos, command) {
  const value = String(text ?? '')
  const pos = typeof cursorPos === 'number' && cursorPos >= 0 ? Math.min(cursorPos, value.length) : value.length
  const token = `/${command.name}${command.args ? ' ' : ''}`
  const from = start >= 0 && start <= pos ? start : 0
  const next = value.slice(0, from) + token + value.slice(pos)
  return { text: next, cursor: from + token.length }
}

/**
 * The picked command applied to the "/" token at the caret now, or null when the caret is no longer in one
 * (moved with Home / arrows / a click after the panel opened): then nothing is inserted.
 */
export function resolveSlashPick(text, cursorPos, command) {
  const hit = findSlashTrigger(text, cursorPos)
  if (!hit) return null
  return applySlashCommand(text, hit.start, cursorPos, command)
}

/**
 * The server's command channel (get-topic-context) merged into the page state. `unsupported` set by the page
 * itself sticks only when the host really handed a command to the model (`channelSticky`); otherwise the
 * server's newer answer wins.
 */
export function mergeServerChannel(prev, res) {
  if (prev?.channelSticky && prev.channel === 'unsupported') return { channel: prev.channel, reason: prev.reason, channelSticky: true }
  return { channel: res?.commandChannel || 'unknown', reason: res?.reason || '', channelSticky: false }
}

/**
 * What Enter does while the slash panel is open. Same rules as the @ picker (mentionEnterAction): with no
 * candidate the key is swallowed so the draft is never sent by accident. A typed name that matches a command
 * taking no text is sent right away.
 * @returns {'insert' | 'swallow' | 'send' | 'newline'}
 */
export function slashEnterAction({ open, count, query = '', shiftKey = false } = {}) {
  if (!open) return shiftKey ? 'newline' : 'send'
  if (!count) return 'swallow'
  const exact = commandMeta(String(query).toLowerCase())
  if (exact && !exact.args) return 'send'
  return 'insert'
}

/** One-line hint shown in the panel when nothing matches. */
export function emptySlashHint(query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (q && (CLOSED_COMMANDS.includes(q) || CLOSED_COMMANDS.some(c => c.startsWith(q)))) return `/${q} 是 Hermes Agent 专有命令，大总管会话未开放`
  return q ? `没有以「/${q}」开头的命令` : '没有可用命令'
}

/**
 * Whether a parsed command may be sent now, and why not. Mirrors the host's own refusals so the user does
 * not press something the host rejects (the host only compresses an idle session).
 * @returns {{ ok: boolean, reason: string }}
 */
export function commandGate(parsed, { channel = 'unknown', connected = false, running = false, compressing = false, hasSession = false, reason = '' } = {}) {
  if (!parsed) return { ok: false, reason: '不是命令' }
  if (!parsed.open) return { ok: false, reason: `/${parsed.rawName} 是 Hermes Agent 专有命令，大总管会话未开放` }
  if (!hasSession) return { ok: false, reason: '这个话题还没有大总管会话，先发一条消息' }
  if (channel === 'unsupported') return { ok: false, reason: reason || '宿主没有为这个会话分发斜杠命令（版本或引擎不兼容）' }
  if (!connected) return { ok: false, reason: '实时通道未连接，稍后再试' }
  if (compressing) return { ok: false, reason: '上下文正在压缩，请等它完成' }
  const meta = commandMeta(parsed.rawName)
  if (meta?.when === 'idle' && running) return { ok: false, reason: '大总管正在运行，等这一轮结束后再执行' }
  if (meta?.when === 'running' && !running) return { ok: false, reason: '大总管没有在运行，直接发消息即可' }
  if (meta?.args && !parsed.args) return { ok: false, reason: `用法：/${parsed.rawName} <${meta.args}>` }
  if (parsed.rawName === 'clear' && parsed.args) return { ok: false, reason: '/clear 只清空当前显示，不删除宿主历史（大总管会话不开放 /clear --history）' }
  return { ok: true, reason: '' }
}

/** The manual-compress button: enabled, or the reason it is greyed out. */
export function compressGate(state = {}) {
  return commandGate(parseSlashCommand('/compress'), state)
}

/** 8191 -> "8191"; 123456 -> "12.3万". */
export function formatTokenCount(value) {
  const n = Math.max(0, Math.floor(Number(value) || 0))
  if (n < 10000) return String(n)
  const wan = Math.round(n / 1000) / 10
  return `${String(wan).replace(/\.0$/, '')}万`
}

/**
 * Text and level of the context capsule. Tokens are the host's own context number (the one its automatic
 * compression compares, from resumed / usage.updated / compression.completed `contextTokens`); the window
 * from the host's context-length. `threshold` is the host's `compression.threshold` (0.65 when unknown); the
 * capsule warns from 90 % of the trigger (window × threshold), i.e. shortly before the host compresses itself.
 */
export function contextCapsule({ tokens, window: windowTokens, threshold } = {}) {
  const used = Number(tokens)
  const win = Number(windowTokens)
  const ratio = Number(threshold) > 0 && Number(threshold) < 1 ? Number(threshold) : DEFAULT_COMPRESS_THRESHOLD
  const hasUsed = Number.isFinite(used) && used > 0
  const hasWin = Number.isFinite(win) && win > 0
  if (!hasUsed && !hasWin) return { label: '上下文 —', percent: null, level: 'unknown', triggerTokens: 0 }
  if (!hasWin) return { label: `上下文 ${formatTokenCount(used)}`, percent: null, level: 'unknown', triggerTokens: 0 }
  const triggerTokens = Math.floor(win * ratio)
  const usedText = hasUsed ? formatTokenCount(used) : '—'
  const percent = hasUsed ? Math.round((used / win) * 1000) / 10 : null
  const label = `上下文 ${usedText} / ${formatTokenCount(win)}${percent === null ? '' : ` (${String(percent).replace(/\.0$/, '')}%)`}`
  const level = percent === null ? 'unknown' : (used >= triggerTokens * AUTO_COMPRESS_WARN_RATIO ? 'warn' : 'ok')
  return { label, percent, level, triggerTokens }
}

// The host's Ekko-agent command path answers /compress with action "compact"; the Hermes path with "compress".
export const sameCommandAction = (a, b) => {
  const norm = x => (x === 'compact' ? 'compress' : String(x || ''))
  return norm(a) === norm(b)
}

const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : undefined)

/**
 * The host's context number carried by a live-session event, or undefined. Only the number the host's own
 * automatic compression uses: `/context` (input + output) and `/compress` answers are a different measure and
 * never move the capsule.
 */
export function contextTokensOf(evt) {
  if (!evt || typeof evt !== 'object') return undefined
  const type = String(evt.event || '')
  if (type === 'resumed' || type === 'app.resumed' || type === 'usage.updated') {
    const n = num(evt.contextTokens)
    return n && n > 0 ? n : undefined
  }
  if (type === 'compression.completed' && !evt.failed && !evt.error) return num(evt.contextTokens)
  // The host ends every turn with the session's context number.
  if (type === 'run.completed' && !evt.error) {
    const n = num(evt.contextTokens)
    return n && n > 0 ? n : undefined
  }
  return undefined
}

/**
 * Capsule state after a live-session event: tokens, window, and the compression phase. An automatic
 * compression keeps the time it started; `resumed` (a reconnect, which may have missed the completion) ends an
 * automatic phase, never the manual one this page runs (`manualBusy`). Returns `prev` when nothing changed.
 */
export function reduceContextEvent(prev, evt, { manualBusy = false, now = Date.now() } = {}) {
  if (!evt || typeof evt !== 'object') return prev
  const type = String(evt.event || '')
  const next = { ...prev }
  let changed = false
  const set = (k, v) => { if (next[k] !== v) { next[k] = v; changed = true } }
  const tokens = contextTokensOf(evt)
  if (tokens !== undefined) set('tokens', tokens)
  if (type === 'session.command' && evt.action === 'context' && Number(evt.contextWindow) > 0) set('window', Math.floor(Number(evt.contextWindow)))
  if (type === 'compression.started') {
    if (prev.phase !== 'compressing' || !prev.startedAt) set('startedAt', now)
    set('phase', 'compressing')
  } else if ((type === 'compression.completed' || type === 'resumed' || type === 'app.resumed') && !manualBusy && prev.phase === 'compressing') {
    set('phase', 'idle')
    set('startedAt', 0)
  }
  return changed ? next : prev
}

/** Ends an automatic compression phase whose completion never arrived within COMPRESS_TIMEOUT_MS. */
export function expireAutoCompress(prev, { manualBusy = false, now = Date.now() } = {}) {
  if (prev?.phase !== 'compressing' || manualBusy || !prev.startedAt) return prev
  if (now - prev.startedAt <= COMPRESS_TIMEOUT_MS) return prev
  return { ...prev, phase: 'idle', startedAt: 0 }
}

/** Readable outcome of a `session.command` event. */
export function readCommandOutcome(evt) {
  const ok = evt?.ok !== false
  const out = {
    ok,
    outcome: ok ? 'completed' : 'failed',
    command: String(evt?.command || ''),
    action: String(evt?.action || ''),
    message: typeof evt?.message === 'string' ? evt.message.slice(0, 2000) : '',
  }
  const before = num(evt?.beforeTokens)
  const after = num(evt?.afterTokens)
  if (before !== undefined) out.beforeTokens = before
  if (after !== undefined) out.afterTokens = after
  if (typeof evt?.compressed === 'boolean') out.compressed = evt.compressed
  if (evt?.action === 'context') {
    // The Ekko-agent path names its total `contextTokens`.
    const total = num(evt.totalTokens ?? evt.contextTokens)
    const win = num(evt.contextWindow)
    if (total !== undefined) out.totalTokens = total
    if (win !== undefined) out.contextWindow = win
  }
  return out
}

/** Toast / notice text for a compress outcome. */
export function compressResultText(result) {
  if (result?.outcome === 'detached') return '实时通道已断开，压缩结果未知'
  if (result?.ok && result.compressed === false) return '上下文没有可压缩的内容，宿主未改动'
  if (result?.ok && result.beforeTokens > 0 && result.afterTokens >= 0) return `上下文已压缩：${result.beforeTokens} → ${result.afterTokens} tokens`
  if (result?.ok) return '上下文已压缩'
  if (result?.outcome === 'timeout') return '压缩超时，上下文未变，可重试'
  if (result?.outcome === 'unsupported') return `当前大总管会话不支持手动压缩：${result.message || '宿主没有分发命令'}`
  return `压缩失败，上下文未变，可重试${result?.message ? `：${result.message}` : ''}`
}

/**
 * One command at a time over a live session handle. `handleEvent` is fed every event of that session; `run`
 * sends a command and settles with the host's `session.command` answer, a timeout, or `unsupported` when the
 * host started a model run instead (it did not treat the text as a command — the caller stops that run).
 */
export function createCommandRunner({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let handle = null
  let sessionId = ''
  let pending = null

  const settle = result => {
    const p = pending
    if (!p) return
    pending = null
    clearTimer(p.timer)
    p.resolve(result)
  }

  // The host keeps running a command after the page's socket is gone, so a detach never means "failed".
  // The same session attaching again (the subscription is rebuilt on re-render) keeps waiting for the answer;
  // another session attaching, or the timer firing while detached, settles as `detached` (outcome unknown).
  const DETACHED = { ok: false, outcome: 'detached', detached: true, message: '实时通道已断开，命令结果未知' }
  return {
    attach(sid, h) {
      const next = String(sid || '')
      if (pending && pending.sessionId !== next) settle({ ...DETACHED })
      sessionId = next
      handle = h || null
    },
    detach(sid) {
      if (sid && sid !== sessionId) return
      handle = null
    },
    get connected() { return Boolean(handle) },
    get sessionId() { return sessionId },
    get busy() { return Boolean(pending) },
    handleEvent(evt) {
      const p = pending
      if (!p || !evt || typeof evt !== 'object') return
      if (evt.session_id && evt.session_id !== p.sessionId) return
      const type = String(evt.event || '')
      if (type === 'session.command') {
        const action = String(evt.action || '')
        const command = String(evt.command || '')
        if (p.action && action && !sameCommandAction(action, p.action) && action !== 'error' && !(p.command && command === p.command)) return
        settle(readCommandOutcome(evt))
      } else if (type === 'compression.started') {
        p.onProgress?.('started', evt)
      } else if (type === 'compression.completed') {
        p.onProgress?.('completed', evt)
      } else if ((type === 'run.started' || type === 'run.queued') && !p.expectsRun) {
        settle({ ok: false, outcome: 'unsupported', passthrough: true, message: '宿主把命令当成普通消息交给了模型（命令通道被拦截）' })
      }
    },
    run(text, { action = '', command = '', timeoutMs = COMMAND_TIMEOUT_MS, onProgress, expectsRun = false } = {}) {
      if (!handle) return Promise.resolve({ ok: false, outcome: 'failed', message: '实时通道未连接，稍后再试' })
      if (pending) return Promise.resolve({ ok: false, outcome: 'failed', message: '上一条命令还没结束' })
      const h = handle
      return new Promise(resolve => {
        pending = { resolve, action, command, onProgress, expectsRun, sessionId, timer: null }
        pending.timer = setTimer(() => settle(handle
          ? { ok: false, outcome: 'timeout', message: `${Math.round(timeoutMs / 1000)} 秒内没有收到宿主回包` }
          : { ...DETACHED }), timeoutMs)
        Promise.resolve()
          .then(() => h.run(text))
          .catch(err => settle({ ok: false, outcome: 'failed', message: `命令没有发出去：${err?.message || String(err)}` }))
      })
    },
  }
}

/**
 * Manual compression, end to end. Steps (each injected, so tests drive it with fakes):
 * 1. `/context` first, every time: it proves the host dispatches commands for this session (a passthrough is
 *    stopped and reported, no answer within 8 s means the host does not support it) and gives the token
 *    baseline in the same unit the self-check below reads;
 * 2. take the server lock (begin-topic-compress) — refused while the Chief runs; it answers a `lockId`;
 * 3. send the host's /compress and wait up to 120 s (a passthrough is stopped like in step 1);
 * 4. no terminal event in time: ask /context again and count a drop below 80 % of the baseline as success;
 * 5. report the outcome with the `lockId` (record-topic-command), which releases the lock.
 * A detach (the page left the session) at any step reports nothing: the host may still be compressing, so the
 * lock stays until it expires by itself (135 s) and no "failed" message is written.
 * @returns {Promise<{ ok: boolean, outcome: string, message: string, beforeTokens?: number, afterTokens?: number }>}
 */
export async function runManualCompress({ runner, topicId, beginLock, record, stopRun, onProbe, onProgress, timeoutMs = COMPRESS_TIMEOUT_MS }) {
  const detached = r => ({ ok: false, outcome: 'detached', detached: true, message: r?.message || '实时通道已断开，压缩结果未知' })
  const stop = () => Promise.resolve(stopRun?.()).catch(() => {})
  const probe = await runner.run('/context', { action: 'context', timeoutMs: PROBE_TIMEOUT_MS })
  if (probe.detached) return detached(probe)
  if (probe.passthrough) await stop()
  if (!probe.ok) {
    // Only a passthrough proves the host does not dispatch commands here; a timeout is one slow answer.
    const result = {
      ok: false,
      outcome: probe.passthrough ? 'unsupported' : (probe.outcome === 'timeout' ? 'timeout' : 'failed'),
      message: probe.outcome === 'timeout' ? '宿主 8 秒内没有回应 /context，本次未压缩，可重试' : probe.message,
    }
    // No lock was taken, so no lockId: this record cannot release anyone else's lock.
    await record({ topicId, command: 'compress', ok: false, outcome: result.outcome, message: result.message })
    return { ...result, probeFailed: true }
  }
  onProbe?.(probe)
  const baseline = Number(probe.totalTokens) || 0
  const lock = await beginLock({ topicId })
  const lockId = typeof lock?.lockId === 'string' ? lock.lockId : ''
  let result
  try {
    result = await runner.run('/compress', { action: 'compress', timeoutMs, onProgress })
    if (result.detached) return detached(result)
    if (result.passthrough) await stop()
    if (result.outcome === 'timeout') {
      const check = await runner.run('/context', { action: 'context', timeoutMs: PROBE_TIMEOUT_MS })
      if (check.detached) return detached(check)
      if (check.ok && baseline > 0 && check.totalTokens >= 0 && check.totalTokens < baseline * 0.8) {
        result = { ok: true, outcome: 'completed', message: '超时后核对：上下文已下降', beforeTokens: baseline, afterTokens: check.totalTokens }
      }
    }
  } catch (err) {
    result = { ok: false, outcome: 'failed', message: err?.message || String(err) }
  }
  const outcome = result.ok ? 'completed' : (['timeout', 'unsupported'].includes(result.outcome) ? result.outcome : 'failed')
  const payload = { topicId, command: 'compress', ok: Boolean(result.ok), outcome }
  if (lockId) payload.lockId = lockId
  if (result.message) payload.message = result.message.slice(0, 2000)
  if (result.beforeTokens !== undefined) payload.beforeTokens = result.beforeTokens
  if (result.afterTokens !== undefined) payload.afterTokens = result.afterTokens
  if (typeof result.compressed === 'boolean') payload.compressed = result.compressed
  await record(payload)
  return { ...result, outcome }
}

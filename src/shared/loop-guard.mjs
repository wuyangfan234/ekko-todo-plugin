/**
 * Chief loop guard — pure detection shared by the server (host transcript) and the client (live stream).
 *
 * A stalled Chief turn looks like this: the model keeps announcing the same next step and keeps loading
 * tool schemas (`tool_describe`) without ever calling the tool. The host only annotates the repeats, so
 * the turn spins for minutes. These helpers recognise that shape from a list of messages of ONE turn.
 *
 * No imports: this file is bundled into both dist/server.mjs and dist/client.mjs.
 */

/** Every notice written when a looping turn is stopped starts with this text (the client keys on it). */
export const LOOP_STOP_PREFIX = '检测到重复输出，已中止本轮'
/** Shown by the client while the live stream already looks like a loop and the stop has not landed yet. */
export const LOOP_LIVE_NOTICE = '检测到重复输出，正在中止本轮…'

/** Same sentence this many times in a row, with no real tool call in between, stops the turn. */
export const REPEAT_NARRATION_LIMIT = 3
/** Same sentence this many times in a row stops the turn even when real tools ran in between. */
export const REPEAT_NARRATION_HARD_LIMIT = 6
/** This many schema reads in a row without calling any real tool stops the turn. */
export const DESCRIBE_ONLY_LIMIT = 5
/** Shorter sentences ("好的", "OK") are acknowledgements, not a repeated announcement. */
export const MIN_NARRATION_CHARS = 4

const SCHEMA_ONLY_TOOL = /(?:^|__)tool_(?:describe|search)$/
const DESCRIBE_TOOL = /(?:^|__)tool_describe$/

/** Tools that only look tools up or load their schema; calling them executes nothing. */
export function isSchemaOnlyTool(name) {
  return SCHEMA_ONLY_TOOL.test(String(name || '').trim())
}

export function isDescribeTool(name) {
  return DESCRIBE_TOOL.test(String(name || '').trim())
}

/** Whitespace-insensitive form used to compare two narrations. */
export function normalizeNarration(text) {
  return String(text || '').replace(/\s+/g, '')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => (typeof block === 'string' ? block : (block?.text || block?.content || '')))
      .filter(v => typeof v === 'string' && v)
      .join('\n')
  }
  return ''
}

function toolNamesOf(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
  return calls.map(c => String(c?.function?.name || c?.name || '')).filter(Boolean)
}

function roleOf(message) {
  return String(message?.display_role || message?.role || '')
}

/** Messages after the last user message: the turn that is running now. */
export function currentTurnMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  let start = 0
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (roleOf(list[i]) === 'user') { start = i + 1; break }
  }
  return list.slice(start)
}

/**
 * Inspect the messages of the running turn (host transcript shape: role, content, tool_calls[].function.name).
 * Returns null when the turn looks healthy, otherwise
 *   { kind: 'repeat-narration', count, sample }  — the same sentence repeated
 *   { kind: 'describe-only', count }             — schema reads in a row, nothing executed
 */
export function detectChiefLoop(messages) {
  const turn = currentTurnMessages(messages)
  let lastNarration = ''
  let sample = ''
  let repeats = 0
  let executedInStreak = false
  let describeStreak = 0

  for (const message of turn) {
    if (roleOf(message) !== 'assistant') continue
    const raw = textOf(message.content).trim()
    const narration = normalizeNarration(raw)
    if (narration.length >= MIN_NARRATION_CHARS) {
      if (narration === lastNarration) {
        repeats += 1
      } else {
        lastNarration = narration
        sample = raw
        repeats = 1
        executedInStreak = false
      }
    }
    for (const name of toolNamesOf(message)) {
      if (isSchemaOnlyTool(name)) {
        if (isDescribeTool(name)) describeStreak += 1
      } else {
        describeStreak = 0
        executedInStreak = true
      }
    }
  }

  if (repeats >= REPEAT_NARRATION_HARD_LIMIT || (repeats >= REPEAT_NARRATION_LIMIT && !executedInStreak)) {
    return { kind: 'repeat-narration', count: repeats, sample }
  }
  if (describeStreak >= DESCRIBE_ONLY_LIMIT) {
    return { kind: 'describe-only', count: describeStreak }
  }
  return null
}

/** The notice stored in the topic when a looping turn is stopped. */
export function formatLoopStopNotice(verdict) {
  if (verdict?.kind === 'repeat-narration') {
    const one = String(verdict.sample || '').replace(/\s+/g, ' ').trim()
    const quoted = one.length > 40 ? `${one.slice(0, 40)}…` : one
    return `${LOOP_STOP_PREFIX}：同一句话连续出现 ${verdict.count} 次${quoted ? `（「${quoted}」）` : ''}，没有新进展。发「继续」可让总管接着做。`
  }
  return `${LOOP_STOP_PREFIX}：连续 ${verdict?.count || DESCRIBE_ONLY_LIMIT} 次只读取工具说明、没有实际执行。发「继续」可让总管接着做。`
}

export function isLoopStopNotice(text) {
  return String(text || '').startsWith(LOOP_STOP_PREFIX)
}

/**
 * Client side: the live stream delivers one growing text plus tool events. Each tool start closes a
 * "round" (the text written since the previous tool start + the tool that follows it), and the rounds
 * are judged with the same rule the server applies to the host transcript.
 */
export function createStreamLoopTracker() {
  return { rounds: [], textOffset: 0 }
}

export function observeStreamTool(tracker, fullText, toolName) {
  const text = String(fullText || '')
  const offset = Math.min(tracker.textOffset, text.length)
  tracker.rounds.push({
    role: 'assistant',
    content: text.slice(offset),
    tool_calls: [{ function: { name: String(toolName || '') } }],
  })
  tracker.textOffset = text.length
  if (tracker.rounds.length > 120) tracker.rounds.splice(0, tracker.rounds.length - 120)
  return detectChiefLoop(tracker.rounds)
}

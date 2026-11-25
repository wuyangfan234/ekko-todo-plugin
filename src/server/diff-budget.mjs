// Size budgets for diff payloads and board snapshots.
// The Studio host rejects any plugin RPC value above 2,000,000 bytes of JSON
// ("Plugin value exceeds the JSON size limit"), so every diff we store or ship is clamped,
// and the board snapshot is kept under a safety budget by dropping diff bodies first.

import { defaultAvatarForRole } from './avatars.mjs'

export const HOST_JSON_LIMIT = 2_000_000
export const SNAPSHOT_BUDGET = 1_500_000

const MAX_LINE_CHARS = 500
const MAX_HUNK_CHARS = 40_000
const MAX_TOTAL_HUNK_CHARS = 160_000
const GENERATED_PATH = /(^|\/)(dist|build|out|vendor|node_modules)\/|\.min\.(js|css)$|\.map$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock)$/i

const byteLen = value => Buffer.byteLength(JSON.stringify(value ?? null))

function isGeneratedDiff(path, hunk) {
  if (GENERATED_PATH.test(path)) return true
  // Minified / bundled output: any single changed line far longer than source code ever is.
  return String(hunk || '').split('\n').some(l => l.length > 4000)
}

/** Clamp one file entry: drop generated/minified bodies, cap line length and hunk size. */
export function clampDiffEntry(entry, remaining = MAX_HUNK_CHARS) {
  if (!entry || typeof entry !== 'object') return entry
  const path = String(entry.path || '')
  const hunk = String(entry.hunk || '')
  if (!hunk) return { ...entry, hunk: '' }
  if (isGeneratedDiff(path, hunk)) {
    return { ...entry, hunk: '', generated: true, note: '生成或压缩文件，差异不展示' }
  }
  const budget = Math.max(0, Math.min(MAX_HUNK_CHARS, remaining))
  const out = []
  let used = 0
  const lines = hunk.split('\n')
  let i = 0
  for (; i < lines.length; i += 1) {
    let line = lines[i]
    const truncatedLine = line.match(/…\(line truncated, (\d+) chars\)$/)
    if (line.length > MAX_LINE_CHARS) {
      line = truncatedLine
        ? `${line.slice(0, MAX_LINE_CHARS)}…(line truncated, ${truncatedLine[1]} chars)`
        : `${line.slice(0, MAX_LINE_CHARS)} …`
    }
    if (used + line.length + 1 > budget) break
    out.push(line)
    used += line.length + 1
  }
  if (i < lines.length) {
    const rest = lines.slice(i).filter(l => !/^\.\.\. \(\d+ more lines truncated\)$/.test(l)).length
    const already = Number((hunk.match(/\.\.\. \((\d+) more lines truncated\)$/) || [])[1] || 0)
    out.push(`... (${rest + already} more lines truncated)`)
  }
  return { ...entry, hunk: out.join('\n') }
}

/** Clamp a todo's diff list (per-line, per-file and total budgets). */
export function clampDiffs(diffs) {
  if (!Array.isArray(diffs)) return []
  let remaining = MAX_TOTAL_HUNK_CHARS
  return diffs.map(entry => {
    const next = clampDiffEntry(entry, remaining)
    remaining = Math.max(0, remaining - String(next?.hunk || '').length)
    return next
  })
}

// Caps for free-text todo fields. Applied where the row is written (db.updateTodo), so an engine
// error dump or a runaway plan can never grow the database row or every later board snapshot.
export const MAX_LAST_ERROR_CHARS = 2000
export const MAX_TIMELINE_EVENT_CHARS = 600
export const MAX_TIMELINE_ENTRIES = 80
export const MAX_PLAN_BYTES = 50_000
export const MAX_CHAT_ENTRY_CHARS = 4000
export const MAX_CHAT_ENTRIES = 24
export const MAX_SPEC_CHARS = 20_000
export const MAX_TITLE_CHARS = 200
export const MAX_CHARTER_CHARS = 20_000
export const MAX_TOPIC_MESSAGE_CHARS = 20_000
// The board view carries at most this many queued follow-ups per topic (the newest ones).
export const MAX_QUEUED_ITEMS_IN_VIEW = 20

/**
 * Stand-in shown instead of an uploaded project avatar in a size-trimmed board. It is not an image,
 * so the UI falls back to the project monogram; db.updateProject treats it as "keep the stored avatar".
 */
export const omittedProjectAvatarMarker = projectId => `omitted:${projectId}`

/** Keep the head of a string within `maxChars` UTF-16 units; a cut string ends with "…". */
export function clampText(value, maxChars) {
  const text = String(value ?? '')
  if (text.length <= maxChars) return text
  let head = text.slice(0, maxChars - 1)
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  return `${head}…`
}

/** Keep the head of a string within `maxBytes` of UTF-8, cut on a character boundary; ends with "…". */
export function clampUtf8(value, maxBytes) {
  const text = String(value ?? '')
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = Math.max(0, maxBytes - 3)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  return `${buf.subarray(0, end).toString('utf8')}…`
}

/** Newest 80 timeline entries, each event at most 600 chars. */
export function clampTimeline(timeline) {
  if (!Array.isArray(timeline)) return []
  return timeline.slice(-MAX_TIMELINE_ENTRIES).map(entry => (
    entry && typeof entry === 'object' && String(entry.event ?? '').length > MAX_TIMELINE_EVENT_CHARS
      ? { ...entry, event: clampText(entry.event, MAX_TIMELINE_EVENT_CHARS) }
      : entry
  ))
}

/** Newest 24 worker chat entries, each text at most 4000 chars. */
export function clampBuildChat(chat) {
  if (!Array.isArray(chat)) return []
  return chat.slice(-MAX_CHAT_ENTRIES).map(entry => (
    entry && typeof entry === 'object' && String(entry.text ?? '').length > MAX_CHAT_ENTRY_CHARS
      ? { ...entry, text: clampText(entry.text, MAX_CHAT_ENTRY_CHARS) }
      : entry
  ))
}

export const MAX_MEMORY_CONTENT_CHARS = 4000
export const MAX_MEMORY_TITLE_CHARS = 160
export const MAX_QUESTION_TEXT_CHARS = 2000
export const MAX_BRIEF_TEXT_CHARS = 2000
export const MAX_QUEUED_TEXT_CHARS = 12_000

const QUESTION_TEXT_KEYS = ['title', 'why', 'answeredText']
const BRIEF_TEXT_KEYS = ['goal', 'progress', 'next', 'waitingOnYou', 'waitingTitle', 'waitingRecommendation', 'blocked']

export const MAX_OPTION_ID_CHARS = 120
// Model config strings. `label` is descriptive and is shortened; the others select an engine, a model
// or an endpoint, so an over-long value is refused instead of being cut into a different one.
export const MODEL_CONFIG_LIMITS = Object.freeze({ id: 120, label: 80, engine: 80, provider: 160, model: 240, apiMode: 60, baseUrl: 500, reasoningEffort: 40 })
export const MAX_CLONE_ROOT_CHARS = 1000
export const MAX_TAG_CHARS = 40
export const MAX_TAGS = 8
export const MAX_TOPIC_TITLE_CHARS = 160
// Ids and timestamps are used as given: over-long values are refused, never cut.
export const MAX_AGENT_REF_CHARS = 120
export const MAX_RUN_AT_CHARS = 80
// How much of a truncated field is written to the host log.
export const MAX_LOGGED_HEAD_CHARS = 2000
export const MAX_SYSTEM_PROMPT_CHARS = 20_000

/** At most 8 non-empty tags, each at most 40 characters. */
export function clampTags(tags) {
  if (!Array.isArray(tags)) return []
  return tags.map(t => String(t || '').trim()).filter(Boolean).slice(0, MAX_TAGS).map(t => clampText(t, MAX_TAG_CHARS))
}

/**
 * True when `incoming` is just the shortened board form of an over-long stored value. Such a value
 * was not edited by anyone, so the stored text must be kept instead of being replaced by its cut form.
 */
export function echoesShortenedView(stored, incoming, maxChars) {
  const full = String(stored ?? '')
  return full.length > maxChars && String(incoming ?? '') === clampText(full, maxChars)
}
// Project text. `name` and `description` are descriptive and are shortened; paths, refs, URLs and the
// test command are used as given, so an over-long value is refused.
export const PROJECT_TEXT_LIMITS = Object.freeze({ name: 120, repoPath: 1000, githubRepo: 200, remoteUrl: 500, defaultBranch: 120, testCommand: 500, description: 2000 })
export const PROJECT_DESCRIPTIVE_FIELDS = Object.freeze(['name', 'description'])

/** Refuse a value that is used as given (path, command, URL, model id) when it is over its limit. */
export function assertMaxLength(field, value, maxChars) {
  const text = String(value ?? '')
  if (text.length > maxChars) throw new Error(`${field} 超过 ${maxChars} 字符上限（当前 ${text.length} 字符），未保存`)
  return text
}

/**
 * Cap decision options: each label at `maxLabelChars`, each id at 120 characters. An id that only
 * collides with another one because it was cut falls back to its positional `opt-N`. Plain string
 * options keep their type. The same array comes back when nothing was cut.
 */
export function clampOptions(options, maxLabelChars = MAX_QUESTION_TEXT_CHARS) {
  if (!Array.isArray(options)) return options
  let changed = false
  const seen = new Set()
  const next = options.map((opt, idx) => {
    if (typeof opt === 'string') {
      if (opt.length <= maxLabelChars) return opt
      changed = true
      return clampText(opt, maxLabelChars)
    }
    if (!opt || typeof opt !== 'object') return opt
    let out = opt
    if (String(opt.label ?? '').length > maxLabelChars) out = { ...out, label: clampText(opt.label, maxLabelChars) }
    const rawId = String(opt.id ?? '')
    if (rawId.length > MAX_OPTION_ID_CHARS) {
      let id = clampText(rawId, MAX_OPTION_ID_CHARS)
      if (seen.has(id)) id = `opt-${idx + 1}`
      out = { ...out, id }
    }
    seen.add(String(out.id ?? ''))
    if (out !== opt) changed = true
    return out
  })
  return changed ? next : options
}

/**
 * Find a stored option by the id a client sent. Rows written before the caps may hold over-long ids
 * that the board shows shortened, so the shortened form selects the same option as the full one.
 */
export function findOptionById(options, optionId) {
  if (!Array.isArray(options) || !optionId) return undefined
  const exact = options.find(o => o && o.id === optionId)
  if (exact) return exact
  const idx = clampOptions(options).findIndex(o => o && o.id === optionId)
  return idx >= 0 ? options[idx] : undefined
}

function clampTextKeys(obj, keys, optionsKey, maxChars) {
  if (!obj || typeof obj !== 'object') return obj
  let next = obj
  for (const key of keys) {
    if (typeof obj[key] === 'string' && obj[key].length > maxChars) {
      if (next === obj) next = { ...obj }
      next[key] = clampText(obj[key], maxChars)
    }
  }
  const options = clampOptions(obj[optionsKey], maxChars)
  if (options !== obj[optionsKey]) {
    if (next === obj) next = { ...obj }
    next[optionsKey] = options
  }
  return next
}

/**
 * Cap the text fields a decision question carries (title, why, answeredText, option labels) at 2,000
 * characters and option ids at 120. Only keys present on the object are touched; the same object comes back when nothing was cut.
 */
export function clampQuestion(question) {
  return clampTextKeys(question, QUESTION_TEXT_KEYS, 'options', MAX_QUESTION_TEXT_CHARS)
}

/** Same for a Topic Brief: every text field and each waiting option label at most 2,000 characters, option ids 120. */
export function clampBrief(brief) {
  return clampTextKeys(brief, BRIEF_TEXT_KEYS, 'waitingOptions', MAX_BRIEF_TEXT_CHARS)
}

// Later trimming stages, applied only while the snapshot is still over budget.
// Topic conversations keep their newest messages; the first pass keeps 60 per topic, the second 20.
const TOPIC_MESSAGE_KEEP_STEPS = [60, 20]
// Finished todos keep this many newest worker chat entries once the 12-entry pass was not enough.
const FINISHED_CHAT_KEEP = 2
// Cards that are not running: worker chat keeps the newest 12 and then 2 entries, timeline the newest 12 and then 6.
const CARD_CHAT_KEEP_STEPS = [12, 2]
const CARD_TIMELINE_KEEP_STEPS = [12, 6]
// The board view carries at most this many memories once it is over budget (pinned first, then newest).
const MEMORIES_KEEP = 100
// Last resort: specs in the view are cut to this many characters.
const LAST_RESORT_SPEC_CHARS = 4000
// Last resort: topic conversations keep the newest 5 and then only the newest message.
const LAST_RESORT_TOPIC_MESSAGE_KEEP_STEPS = [5, 1]
// Queued follow-ups stay listed (so they can still be withdrawn); their text in the view is cut to
// 2,000 and then 200 characters.
const QUEUED_TEXT_KEEP_STEPS = [2000, 200]
const TOPIC_TITLE_STUB_CHARS = 160
// In the last-resort minimal board, a settings / concurrency / counts value is kept only if it is this small.
const MINIMAL_VALUE_BYTES = 1000
// Top-level flags added to a trimmed snapshot (snapshotTrimmed, todosOmitted, memoriesOmitted).
const FLAG_RESERVE_BYTES = 128

/**
 * Keep a board snapshot under budget. Nothing is deleted from storage; only this view is trimmed,
 * least valuable first, and every stage stops as soon as the snapshot fits:
 * 1. diff bodies (finished todos, then the oldest others), marked `hunkOmitted` so the drawer
 *    fetches them on demand;
 * 2. worker chat of finished todos down to the newest 12 entries (`buildChatTrimmed`);
 * 3. older messages of topic conversations, archived topics first and then the least recently
 *    active, keeping the newest 60 and then 20 per topic (`messagesOmitted` = how many were left out);
 * 4. worker chat of finished todos down to the newest 2 entries, oldest todos first;
 * 5. memories down to 100, pinned first and then the newest (`memoriesOmitted` = how many were left out);
 * 6. text of queued follow-ups cut to 2,000 and then 200 characters (`queuedItems[].textTrimmed`); the
 *    items themselves stay listed;
 * 7. every card, finished first and then oldest first: worker chat down to the newest 12 and then 2
 *    entries (`buildChatTrimmed`), timeline down to the newest 12 and then 6 entries
 *    (`timelineOmitted` = how many were left out), and the plan cut to 50,000 bytes (`planTrimmed`);
 * 8. the oldest finished todos themselves, then the oldest idle ones (todo / queued / failed);
 *    `todosOmitted` = how many cards were left out;
 * 9. last resort, in this order: uploaded agent avatars replaced by the built-in default marker and
 *    uploaded project avatars by the monogram stand-in (`avatarOmitted`), specs cut to 4,000
 *    characters (`specTrimmed`), topic conversations down to the newest 5 and then 1 message, whole
 *    topics left out, archived first and then the least recently active (`topicsOmitted`; the most
 *    recently active topic always stays), and finally the oldest failed, confirm and review cards
 *    left out (`todosOmitted`).
 * Cards that are building, reviewing or merging are never left out, and the most recently active
 * topic is trimmed last. When the result still exceeds the host limit, a degraded snapshot is
 * returned instead of an error: settings, concurrency and counts are kept, memories are empty,
 * agents and projects stay listed (as stubs with id / name / role or monogram / accent when they are
 * what is too large), and
 * every topic and card is reduced to a stub that only names it (id, title, phase / gate, updatedAt)
 * so the board can still list them; `snapshotOverflow: true` with `overflowBytes` says how large the
 * trimmed board was.
 */
export function fitSnapshotBudget(snapshot, budget = SNAPSHOT_BUDGET) {
  if (!snapshot || !Array.isArray(snapshot.todos)) return snapshot
  let size = byteLen(snapshot)
  if (size <= budget) return snapshot
  size += FLAG_RESERVE_BYTES
  const finished = td => td.phase === 'done' || td.phase === 'closed'
  const order = [...snapshot.todos.keys()].sort((a, b) => {
    const ta = snapshot.todos[a]
    const tb = snapshot.todos[b]
    if (finished(ta) !== finished(tb)) return finished(ta) ? -1 : 1
    return (ta.updatedAt || 0) - (tb.updatedAt || 0)
  })
  const todos = [...snapshot.todos]
  for (const idx of order) {
    if (size <= budget) break
    const td = todos[idx]
    if (!Array.isArray(td.diffs) || !td.diffs.some(d => d?.hunk)) continue
    const before = byteLen(td)
    todos[idx] = { ...td, diffs: td.diffs.map(d => (d?.hunk ? { ...d, hunk: '', hunkOmitted: true } : d)) }
    size -= before - byteLen(todos[idx])
  }
  for (const idx of order) {
    if (size <= budget) break
    const td = todos[idx]
    if (!finished(td) || !Array.isArray(td.buildChat) || td.buildChat.length <= 12) continue
    const before = byteLen(td)
    todos[idx] = { ...td, buildChat: td.buildChat.slice(-12), buildChatTrimmed: true }
    size -= before - byteLen(todos[idx])
  }

  const hasTopics = Array.isArray(snapshot.topics)
  const topics = hasTopics ? [...snapshot.topics] : []
  const topicOrder = [...topics.keys()].sort((a, b) => {
    const ta = topics[a] || {}
    const tb = topics[b] || {}
    if (Boolean(ta.archived) !== Boolean(tb.archived)) return ta.archived ? -1 : 1
    return (ta.updatedAt || 0) - (tb.updatedAt || 0)
  })
  const trimTopicMessages = keepSteps => {
    for (const keep of keepSteps) {
      for (const idx of topicOrder) {
        if (size <= budget) break
        const tp = topics[idx]
        if (!tp || !Array.isArray(tp.messages) || tp.messages.length <= keep) continue
        const before = byteLen(tp)
        const dropped = tp.messages.length - keep
        topics[idx] = { ...tp, messages: tp.messages.slice(-keep), messagesOmitted: Number(tp.messagesOmitted || 0) + dropped }
        size -= before - byteLen(topics[idx])
      }
    }
  }
  trimTopicMessages(TOPIC_MESSAGE_KEEP_STEPS)

  for (const idx of order) {
    if (size <= budget) break
    const td = todos[idx]
    if (!finished(td) || !Array.isArray(td.buildChat) || td.buildChat.length <= FINISHED_CHAT_KEEP) continue
    const before = byteLen(td)
    todos[idx] = { ...td, buildChat: td.buildChat.slice(-FINISHED_CHAT_KEEP), buildChatTrimmed: true }
    size -= before - byteLen(todos[idx])
  }

  const hasMemories = Array.isArray(snapshot.memories)
  let memories = hasMemories ? snapshot.memories : []
  let memoriesOmitted = 0
  if (size > budget && memories.length > MEMORIES_KEEP) {
    const ranked = [...memories.keys()].sort((a, b) => {
      const ma = memories[a] || {}
      const mb = memories[b] || {}
      if (Boolean(ma.pinned) !== Boolean(mb.pinned)) return ma.pinned ? -1 : 1
      return (mb.updatedAt || 0) - (ma.updatedAt || 0) || a - b
    })
    const keepIdx = new Set(ranked.slice(0, MEMORIES_KEEP))
    const kept = memories.filter((_, i) => keepIdx.has(i))
    memoriesOmitted = memories.length - kept.length
    size -= byteLen(memories) - byteLen(kept)
    memories = kept
  }

  for (const maxChars of QUEUED_TEXT_KEEP_STEPS) {
    for (const idx of topicOrder) {
      if (size <= budget) break
      const tp = topics[idx]
      if (!tp || !Array.isArray(tp.queuedItems) || !tp.queuedItems.some(q => String(q?.text || '').length > maxChars)) continue
      const before = byteLen(tp)
      topics[idx] = {
        ...tp,
        queuedItems: tp.queuedItems.map(q => (String(q?.text || '').length > maxChars ? { ...q, text: clampText(q.text, maxChars), textTrimmed: true } : q)),
      }
      size -= before - byteLen(topics[idx])
    }
  }

  const idle = td => td.phase === 'todo' || td.phase === 'queued' || td.phase === 'failed'
  const replaceTodo = (idx, next) => {
    const before = byteLen(todos[idx])
    todos[idx] = next
    size -= before - byteLen(next)
  }
  for (const keep of CARD_CHAT_KEEP_STEPS) {
    for (const idx of order) {
      if (size <= budget) break
      const td = todos[idx]
      if (!Array.isArray(td.buildChat) || td.buildChat.length <= keep) continue
      replaceTodo(idx, { ...td, buildChat: td.buildChat.slice(-keep), buildChatTrimmed: true })
    }
  }
  for (const keep of CARD_TIMELINE_KEEP_STEPS) {
    for (const idx of order) {
      if (size <= budget) break
      const td = todos[idx]
      if (!Array.isArray(td.timeline) || td.timeline.length <= keep) continue
      const dropped = td.timeline.length - keep
      replaceTodo(idx, { ...td, timeline: td.timeline.slice(-keep), timelineOmitted: Number(td.timelineOmitted || 0) + dropped })
    }
  }
  for (const idx of order) {
    if (size <= budget) break
    const td = todos[idx]
    if (typeof td.plan !== 'string' || Buffer.byteLength(td.plan) <= MAX_PLAN_BYTES) continue
    replaceTodo(idx, { ...td, plan: clampUtf8(td.plan, MAX_PLAN_BYTES), planTrimmed: true })
  }

  const omittedTodoIdx = new Set()
  for (const omittable of [finished, idle]) {
    for (const idx of order) {
      if (size <= budget) break
      if (omittedTodoIdx.has(idx) || !omittable(todos[idx])) continue
      size -= byteLen(todos[idx]) + 1
      omittedTodoIdx.add(idx)
    }
  }

  // Last resort, only while the snapshot is still over budget.
  const hasAgents = Array.isArray(snapshot.agents)
  const agents = hasAgents ? [...snapshot.agents] : []
  for (let i = 0; i < agents.length; i += 1) {
    if (size <= budget) break
    const ag = agents[i]
    if (!ag || !String(ag.avatar || '').startsWith('data:')) continue
    const before = byteLen(ag)
    agents[i] = { ...ag, avatar: defaultAvatarForRole(ag.role, { seedHint: ag.id }), avatarOmitted: true }
    size -= before - byteLen(agents[i])
  }
  const hasProjects = Array.isArray(snapshot.projects)
  const projects = hasProjects ? [...snapshot.projects] : []
  const swapProjectAvatar = pj => ({ ...pj, avatar: omittedProjectAvatarMarker(pj.id), avatarOmitted: true })
  for (let i = 0; i < projects.length; i += 1) {
    if (size <= budget) break
    const pj = projects[i]
    if (!pj || !String(pj.avatar || '').startsWith('data:')) continue
    const before = byteLen(pj)
    projects[i] = swapProjectAvatar(pj)
    size -= before - byteLen(projects[i])
  }
  for (const idx of order) {
    if (size <= budget) break
    const td = todos[idx]
    if (omittedTodoIdx.has(idx) || typeof td.spec !== 'string' || td.spec.length <= LAST_RESORT_SPEC_CHARS) continue
    replaceTodo(idx, { ...td, spec: clampText(td.spec, LAST_RESORT_SPEC_CHARS), specTrimmed: true })
  }
  trimTopicMessages(LAST_RESORT_TOPIC_MESSAGE_KEEP_STEPS)
  // Whole topics, archived first and then the least recently active. The most recently active one stays.
  // They go before any card waiting for the user: a topic left out is still stored and listed again
  // once the board shrinks, while a gate card is something the user has to act on.
  const omittedTopicIdx = new Set()
  for (const idx of topicOrder.slice(0, -1)) {
    if (size <= budget) break
    size -= byteLen(topics[idx]) + 1
    omittedTopicIdx.add(idx)
  }
  for (const phase of ['failed', 'confirm', 'review']) {
    for (const idx of order) {
      if (size <= budget) break
      if (omittedTodoIdx.has(idx) || todos[idx].phase !== phase) continue
      size -= byteLen(todos[idx]) + 1
      omittedTodoIdx.add(idx)
    }
  }

  const out = { ...snapshot, todos: omittedTodoIdx.size ? todos.filter((_, i) => !omittedTodoIdx.has(i)) : todos, snapshotTrimmed: true }
  if (hasTopics) out.topics = omittedTopicIdx.size ? topics.filter((_, i) => !omittedTopicIdx.has(i)) : topics
  if (omittedTopicIdx.size) out.topicsOmitted = omittedTopicIdx.size
  if (hasAgents) out.agents = agents
  if (hasProjects) out.projects = projects
  if (memoriesOmitted) {
    out.memories = memories
    out.memoriesOmitted = memoriesOmitted
  }
  if (omittedTodoIdx.size) out.todosOmitted = omittedTodoIdx.size
  // Never hand the host a value it will reject, and never fail the call either: a write that already
  // succeeded must not look like an error. Return a degraded board that still opens.
  const finalBytes = byteLen(out)
  if (finalBytes <= HOST_JSON_LIMIT) return out
  // The degraded board carries no bodies, but it still names every topic and card so the user can see
  // what exists and remove whatever is causing the overflow. Empty collections keep the UI's shape.
  const topicStub = tp => ({
    id: tp.id,
    title: clampText(tp.title, TOPIC_TITLE_STUB_CHARS),
    archived: Boolean(tp.archived),
    updatedAt: tp.updatedAt,
    stub: true,
    messages: [],
    queuedItems: [],
    brief: {},
  })
  const todoStub = td => ({
    id: td.id,
    number: td.number,
    title: clampText(td.title, MAX_TITLE_CHARS),
    phase: td.phase,
    gateOwner: td.gateOwner,
    gateKind: td.gateKind,
    updatedAt: td.updatedAt,
    projectId: td.projectId,
    topicId: td.topicId,
    stub: true,
    tags: [],
    diffs: [],
    buildChat: [],
    timeline: [],
    fallbackHistory: [],
    evidence: {},
    question: { active: false, options: [] },
  })
  const degraded = { ...snapshot, todos: [], topics: [], memories: [], snapshotTrimmed: true, snapshotOverflow: true, overflowBytes: finalBytes }
  if (hasAgents) {
    degraded.agents = snapshot.agents.map(ag => (ag && String(ag.avatar || '').startsWith('data:')
      ? { ...ag, avatar: defaultAvatarForRole(ag.role, { seedHint: ag.id }), avatarOmitted: true }
      : ag))
  }
  if (hasProjects) degraded.projects = snapshot.projects.map(pj => (pj && String(pj.avatar || '').startsWith('data:') ? swapProjectAvatar(pj) : pj))
  if (hasMemories && snapshot.memories.length) degraded.memoriesOmitted = snapshot.memories.length
  // Still too large: agents and projects are reduced to stubs that only name them, so the lists can
  // still point at the entry that has to be fixed; schedules and quota providers are left out.
  if (byteLen(degraded) > budget) {
    if (hasAgents) degraded.agents = snapshot.agents.filter(Boolean).map(ag => ({ id: clampText(ag.id, MAX_AGENT_REF_CHARS), name: clampText(ag.name, 120), role: ag.role, stub: true }))
    if (hasProjects) degraded.projects = snapshot.projects.filter(Boolean).map(pj => ({ id: clampText(pj.id, MAX_AGENT_REF_CHARS), name: clampText(pj.name, PROJECT_TEXT_LIMITS.name), monogram: clampText(pj.monogram, 4), accent: pj.accent, stub: true }))
    for (const key of ['schedules', 'quotaProviders']) {
      if (Array.isArray(degraded[key])) degraded[key] = []
    }
  }
  // Add as many stubs as fit, most recently updated first. Normally that is all of them.
  let room = budget - byteLen(degraded) - FLAG_RESERVE_BYTES
  const takeStubs = (items, makeStub) => {
    const kept = new Map()
    const newestFirst = [...items.keys()].sort((a, b) => (items[b]?.updatedAt || 0) - (items[a]?.updatedAt || 0))
    for (const idx of newestFirst) {
      const stub = makeStub(items[idx])
      const cost = byteLen(stub) + 1
      if (cost > room) break
      room -= cost
      kept.set(idx, stub)
    }
    return items.map((_, i) => kept.get(i)).filter(Boolean)
  }
  degraded.todos = takeStubs(snapshot.todos, todoStub)
  if (degraded.todos.length < snapshot.todos.length) degraded.todosOmitted = snapshot.todos.length - degraded.todos.length
  if (hasTopics) {
    degraded.topics = takeStubs(snapshot.topics, topicStub)
    if (degraded.topics.length < snapshot.topics.length) degraded.topicsOmitted = snapshot.topics.length - degraded.topics.length
  }
  // Final guarantee: the returned value never exceeds the host limit. Drop the agent and project lists
  // first; if that is still not enough, keep only settings, concurrency and counts (their small values).
  if (byteLen(degraded) > HOST_JSON_LIMIT) {
    if (hasAgents) degraded.agents = []
    if (hasProjects) degraded.projects = []
  }
  if (byteLen(degraded) <= HOST_JSON_LIMIT) return degraded
  const smallValues = obj => {
    const out = {}
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined && byteLen(value) <= MINIMAL_VALUE_BYTES) out[key] = value
    }
    return out
  }
  const minimal = {
    settings: smallValues(snapshot.settings),
    concurrency: smallValues(snapshot.concurrency),
    counts: smallValues(snapshot.counts),
    projects: [],
    agents: [],
    memories: [],
    topics: [],
    todos: [],
    schedules: [],
    quotaProviders: [],
    runtime: {},
    snapshotTrimmed: true,
    snapshotOverflow: true,
    overflowBytes: finalBytes,
  }
  if (snapshot.todos.length) minimal.todosOmitted = snapshot.todos.length
  if (hasTopics && snapshot.topics.length) minimal.topicsOmitted = snapshot.topics.length
  if (hasMemories && snapshot.memories.length) minimal.memoriesOmitted = snapshot.memories.length
  if (byteLen(minimal) > HOST_JSON_LIMIT) {
    minimal.settings = {}
    minimal.concurrency = {}
    minimal.counts = {}
  }
  return minimal
}

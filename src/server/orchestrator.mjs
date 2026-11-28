import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { transitionTodoPhase, canTransition } from './state-machine.mjs'
import {
  inspectRepo,
  parseGithubRepoInput,
  probeGithubCli,
  probeGithubAuth,
  verifyGithubToken,
  startGithubDeviceLogin,
  getGithubDeviceLoginStatus,
  cancelGithubDeviceLogin,
  logoutGithubCli,
  listGithubRepos as listGithubReposRaw,
  cloneGithubRepo,
  ensureWorktree,
  captureWorktreeSnapshot,
  readWorktreeState,
  mergeWorktreeBranch,
  commitWorktreeChanges,
  readReviewBinding,
  reviewBindingProblem,
  removeWorktree,
  isWorktreeClean,
  deleteMergedBranch,
  captureRepoFingerprint,
  inspectProjectRepoReadOnly,
  listProjectBranches,
  listProjectTree,
  readProjectFile,
  listProjectCommits,
  readProjectCommitDiff,
  isCommitMergedInto,
} from './git-engine.mjs'
import {
  MAX_CHARTER_CHARS, MAX_CHAT_ENTRIES, MAX_CHAT_ENTRY_CHARS, MAX_LAST_ERROR_CHARS, MAX_PLAN_BYTES, MAX_QUEUED_ITEMS_IN_VIEW,
  MAX_MEMORY_CONTENT_CHARS, MAX_MEMORY_TITLE_CHARS, MAX_QUESTION_TEXT_CHARS, MAX_QUEUED_TEXT_CHARS,
  MAX_AGENT_REF_CHARS, MAX_SYSTEM_PROMPT_CHARS, assertMaxLength, MAX_CLONE_ROOT_CHARS, MAX_TAG_CHARS, MAX_TAGS, MAX_TOPIC_TITLE_CHARS, clampTags, MAX_SPEC_CHARS, MAX_TITLE_CHARS, MAX_TOPIC_MESSAGE_CHARS, PROJECT_TEXT_LIMITS, clampBrief, clampOptions, findOptionById, clampBuildChat, clampQuestion, clampText, clampUtf8, fitSnapshotBudget, fitTodoDetail,
} from './diff-budget.mjs'
import { collectPluginSessions, readHermesSessionUsage, sessionUsageToRecords } from './session-usage.mjs'
import { computeNextRunAt, formatScheduleRuleLabel } from './schedule-engine.mjs'
import { probeSingleQuotaProvider, readLocalTokenUsageSummary } from './quota-engine.mjs'
import { getTeamPreset } from './team-presets.mjs'
import { AVATAR_UPLOAD_SPEC } from './avatars.mjs'
import { clipChars, runDeterministicTestGate } from './gate-runner.mjs'
import { readableLaunchFailure } from './launch-failure.mjs'
import { DESCRIBE_ONLY_LIMIT, detectChiefLoop, formatLoopStopNotice, isDescribeTool, isLoopStopNotice, isSchemaOnlyTool } from '../shared/loop-guard.mjs'
import { checkModelInCatalog, normalizeModelRef } from '../shared/model-ref.mjs'
import { DEFAULT_AGENT_TURNS, hostTurnBudget, turnRunOptions } from '../shared/turn-budget.mjs'
import { MAX_DELIVERABLE_CHARS, hasTextDeliverable, inferTodoKind, isNoCodeKind, isSubstantiveReport } from '../shared/todo-kind.mjs'
import { judgeTextDeliverable } from './text-deliverable.mjs'
import { CHIEF_IDLE_BREAK_AT, CHIEF_IDLE_HINT_AT, classifyChiefRound, formatChiefIdleBreak, formatChiefIdleHint, formatChiefReadOnlyNudge, formatChiefResumeExhausted } from '../shared/chief-guard.mjs'
import { CHIEF_MAX_ANNOUNCE_NUDGES, baseToolName, capReasoningEffort, createChiefTurnTracker, detectEkkoToolsMissing, formatChiefAnnounceNotice, formatChiefAnnounceNudge, formatChiefGuardNotice, formatEkkoToolsMissingNotice, isHostEmptyPlaceholder, observeChiefTool } from '../shared/chief-guard.mjs'
import {
  classifyModelFailure,
  resolveActiveConfig,
  selectNextFallbackConfig,
  formatConfigLabel,
  clampModelConfigForView,
} from './failover.mjs'
import {
  distillProvisionalTitle,
  generateTopicTitleWithModel,
} from './title-generator.mjs'
import {
  buildChiefInstructions,
  buildWorkerPrompt,
  buildFollowUpPrompt,
  FOLLOW_UP_TRIGGERS,
  workerFinalReport,
  buildReviewPrompt,
  buildAutomatedWakePrompt,
  formatTodoDigest,
} from './prompts.mjs'

let sqliteProbeCache = null
async function probeSqlite() {
  if (sqliteProbeCache !== null) return sqliteProbeCache
  try {
    await import('node:sqlite')
    sqliteProbeCache = true
  } catch {
    sqliteProbeCache = false
  }
  return sqliteProbeCache
}

function readRepoGuidelines(worktreePath, maxChars = 2400) {
  if (!worktreePath) return ''
  for (const fname of ['AGENTS.md', 'CLAUDE.md']) {
    const p = join(worktreePath, fname)
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf8').trim()
        if (raw) return `[${fname}]\n${raw.slice(0, maxChars)}`
      } catch {
        // ignore unreadable guideline file
      }
    }
  }
  return ''
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => (typeof block === 'string' ? block : (block?.text || block?.content || '')))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * #75: a message sent with attachments goes to the host as a content-block array, and the host hands it
 * back as that array serialized to a string. Return the text blocks joined by newlines. Anything that is
 * not such a string (plain text, other JSON, malformed JSON, no text) comes back unchanged.
 */
export function hostMessageText(raw) {
  if (typeof raw !== 'string') return raw
  if (!raw.trim().startsWith('[')) return raw
  let parsed
  try { parsed = JSON.parse(raw) } catch { return raw }
  if (!Array.isArray(parsed)) return raw
  const text = parsed.filter(block => block && typeof block.text === 'string').map(block => block.text).join('\n')
  return text.trim() ? text : raw
}

// 0.9.57: the row Hermes writes to close a turn that failed (agent/turn_failure_copy.py). It is not the
// model's answer: counted as one, a failed research round was "delivered" and a 404 read as "empty reply".
const HOST_FAILED_TURN_TEXTS = [
  'Your request was not processed. Send it again if you still want me to carry it out.',
  'This turn did not complete. Some actions may already have run; verify their effects before resending.',
  'An automated delivery was interrupted and was not run again.',
]
function isHostFailedTurnRow(m) {
  const kind = String(m?.display_kind || m?.displayKind || '')
  if (kind === 'failed_turn') return true
  const text = extractTextFromContent(m?.content).trim()
  return Boolean(text) && HOST_FAILED_TURN_TEXTS.some(t => text.startsWith(t))
}

function normalizeHostMessages(res) {
  const list = Array.isArray(res?.messages) ? res.messages : []
  return list.map(m => {
    const failedTurn = isHostFailedTurnRow(m)
    return {
      id: String(m.id ?? ''),
      // A failed-turn row keeps its own role so it is never read as the model's text.
      role: failedTurn ? 'failed_turn' : String(m.display_role || m.role || ''),
      content: extractTextFromContent(m.content),
      timestamp: Number(m.timestamp || 0),
      toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls.length : 0,
    }
  })
}

// 0.9.46: the fallback wording of a failed worker run, alone. It names no cause.
const BARE_FAILURE_TEXT = /^\s*(执行|审查)会话异常结束[\s。.!！]*$/
const WORKER_ERROR_SUMMARY_MAX = 400

// Text of an error value of a host event or session record: a string, a number, or an object with
// message / error / detail. Anything else is ''.
function hostErrorText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value && typeof value === 'object') {
    for (const key of ['message', 'error', 'detail']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
    }
  }
  return ''
}

function clipWorkerError(text) {
  const clean = String(text || '').trim()
  return clean.length > WORKER_ERROR_SUMMARY_MAX ? `${clean.slice(0, WORKER_ERROR_SUMMARY_MAX)}…` : clean
}

// 0.9.49 (#47): wording of a turn that ends to wait for a later one (a progress report, "I will continue
// once the tests finish"). The host does not start that later turn by itself.
// 0.9.52 (#50): the bare words YET and LATER are no longer in the list ("has yet to be covered", "can be
// handled later" sit in real verdicts). What is kept of them is the part that defers: `not yet`, a negation
// and `yet` in one sentence ("not APPROVED yet", which the bare token rule would otherwise read as approved),
// and `will` / `I'll` and `later` in one sentence, in either order.
const REVIEW_DEFERRAL_RE = new RegExp([
  '稍后', '稍候', '待会', '等会', '回头再', '随后(?:再|继续|给|补)', '下一轮', '下一回合', '下个回合',
  '等[^。！？\\n]{0,60}?再', '待[^。！？\\n]{0,60}?(?:后|完)[^。！？\\n]{0,10}?再',
  '(?:还在|仍在|正在)(?:跑|运行|执行|进行|等)', '尚未(?:跑完|完成|结束)', '还没(?:跑完|完成|结束)',
  '(?:然后|之后|再|才)(?:再)?给(?:出)?结论',
  'WILL\\s+(?:THEN\\s+)?CONTINUE', 'I\\S?LL\\s+CONTINUE', 'TO\\s+BE\\s+CONTINUED', 'CONTINUE\\s+(?:ONCE|AFTER|WHEN)',
  'STILL\\s+(?:RUNNING|IN\\s+PROGRESS|WAITING|PENDING)', 'IN\\s+PROGRESS', 'NEXT\\s+TURN', 'NOT\\s+YET',
  '(?:\\bNOT\\b|N[\'’]T\\b|\\bNO\\b|\\bCANNOT\\b)[^.!?\\n]{0,60}?\\bYET\\b',
  '(?:\\bWILL\\b|\\bI\\S?LL\\b)[^.!?\\n]{0,60}?\\bLATER\\b', '\\bLATER\\b[^.!?\\n]{0,60}?(?:\\bWILL\\b|\\bI\\S?LL\\b)',
  '(?:ONCE|AFTER|WHEN|UNTIL)\\s+(?:IT|THEY|THE|THAT|THIS)\\b[^.\\n]{0,60}?(?:FINISH|COMPLETE|DONE|END)',
  'VERDICT\\s+(?:WILL|TO)\\s+FOLLOW',
].join('|'))

/**
 * What the last assistant message of a review turn says: 'approved', 'changes_requested' or 'inconclusive'
 * ('review_failed', the fourth outcome, is a failed run and is not decided here).
 *
 * #103: only a verdict line that stands alone as the LAST line can approve. Before, the last `VERDICT:`
 * anywhere in the text decided (in a sentence, in a code block, followed by a condition), and a text with
 * no verdict line was approved by the bare word APPROVED.
 *  0. Code is not read: fenced blocks (``` / ~~~, an unclosed one runs to the end) and inline `code` spans
 *     are taken out first. A verdict quoted there is an example, not a verdict.
 *  1. The last line (trailing blank lines and lines of punctuation only are skipped) is a sole verdict line
 *     when, with emphasis marks, a heading mark and trailing punctuation removed, the whole line is
 *     `VERDICT:` (ASCII or full-width colon, any case) plus exactly one verdict word (soleVerdictKind):
 *     a. APPROVED -> 'approved', unless a rejecting verdict stands anywhere else in the text (on a line of
 *        its own, in a sentence, or in code: this one check reads the whole text, code included; e.g.
 *        `VERDICT: CHANGES_REQUESTED … 修好后可改成` + last line APPROVED) -> 'inconclusive'. One-sided on
 *        purpose: a rejection read as approved can be merged, an approval read as unclear is asked once.
 *     b. a rejecting word (CHANGES_REQUESTED, NOT APPROVED, 不通过, 驳回, 需修改, 需要修改, 不可合并, or a
 *        negation in front of APPROVED) -> 'changes_requested'.
 *     Anything else on that line (`VERDICT: APPROVED，前提是…`, `VERDICT: APPROVED but must fix X`,
 *     `结论：VERDICT: APPROVED`, a quote mark, a list or quote prefix) makes it no sole verdict line.
 *  2. No sole verdict line as the last line -> never 'approved':
 *     a. text that waits for a later turn (REVIEW_DEFERRAL_RE) -> 'inconclusive';
 *     b. the line of the last `VERDICT:` in the text (any position outside code) names both verdicts ->
 *        'inconclusive' (a template or a question);
 *     c. that last `VERDICT:` rejects -> 'changes_requested' (the reviewer said no and went on writing);
 *        it approves or is negated into nothing -> 'inconclusive';
 *     d. no such `VERDICT:` at all: a rejecting line of its own (`VERDICT: 驳回`) or the bare token
 *        CHANGES_REQUESTED -> 'changes_requested'; anything else, the bare word APPROVED and empty text
 *        included -> 'inconclusive' (the reviewer is asked once).
 */
export function parseReviewVerdict(text) {
  const clean = String(text || '').trim()
  if (!clean) return 'inconclusive'
  const upper = stripCodeForVerdict(clean).toUpperCase()
  const rows = upper.split('\n')
  while (rows.length && !/[\p{L}\p{N}]/u.test(rows.at(-1))) rows.pop()
  const soleKinds = rows.map(soleVerdictKind)
  const last = soleKinds.at(-1) || ''
  // The last line, alone, decides.
  if (last === 'approved') {
    // Asked of the whole text, code included: a rejection the reviewer wrapped in backticks is still one.
    const rejectedSomewhere = verdictMentions(clean.toUpperCase()).some(m => m.kind === 'rejected') || soleKinds.slice(0, -1).includes('rejected')
    return rejectedSomewhere ? 'inconclusive' : 'approved'
  }
  if (last === 'rejected') return 'changes_requested'
  if (REVIEW_DEFERRAL_RE.test(upper)) return 'inconclusive'
  const mentions = verdictMentions(upper)
  const lastMention = mentions.at(-1)
  if (lastMention) {
    const lineStart = upper.lastIndexOf('\n', lastMention.index) + 1
    const lineEndAt = upper.indexOf('\n', lastMention.index)
    const line = upper.slice(lineStart, lineEndAt === -1 ? upper.length : lineEndAt)
    // A line that names both verdicts is a template or a question, not a verdict.
    if (/CHANGES_REQUESTED/.test(line) && /\bAPPROVED\b/.test(line)) return 'inconclusive'
    return lastMention.kind === 'rejected' ? 'changes_requested' : 'inconclusive'
  }
  if (soleKinds.includes('rejected') || /CHANGES_REQUESTED/.test(upper)) return 'changes_requested'
  return 'inconclusive'
}

// Every `VERDICT: <word>` of `upper`, wherever it stands. A negation right before the token turns it (#69):
// `VERDICT: NOT APPROVED` is a rejection, `VERDICT: NOT CHANGES_REQUESTED` says nothing.
function verdictMentions(upper) {
  return [...upper.matchAll(VERDICT_LINE_RE)].map(m => {
    const negated = negatedBefore(upper, m.index + m[0].length - m[1].length)
    return { index: m.index, kind: m[1] === 'APPROVED' ? (negated ? 'rejected' : 'approved') : (negated ? 'unclear' : 'rejected') }
  })
}

// #103: the text without code. Each fenced block (a fence line starts with ``` or ~~~; an unclosed fence
// runs to the end), fence lines included, becomes one line `CODE`, and each inline `code` span the word
// CODE. Code is never deleted to nothing: a blank line would be skipped as trailing, and a verdict line
// before code (`VERDICT: APPROVED` + `` `必改` ``) would wrongly become the last line.
const CODE_PLACEHOLDER = 'CODE'
function stripCodeForVerdict(text) {
  const kept = []
  let fence = ''
  for (const line of String(text).split(/\r?\n/)) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0] || ''
    if (fence) {
      if (mark === fence) fence = ''
      continue
    }
    if (mark) { fence = mark; kept.push(CODE_PLACEHOLDER); continue }
    kept.push(line)
  }
  return kept.join('\n').replace(/`[^`\n]*`/g, CODE_PLACEHOLDER)
}

const VERDICT_REJECT_WORDS = ['不通过', '驳回', '需要修改', '需修改', '不可合并']
const SOLE_NEGATED_APPROVED_RE = /^(?:NOT|NEVER|CANNOT|CAN['’]T|DON['’]T|WON['’]T|ISN['’]T|不予|不能|无法|暂不|拒绝|未|不)[\s_-]*APPROVED$/
// #103: 'approved' / 'rejected' when `line` (upper-cased) is nothing but a verdict line, else ''. Allowed
// around it: spaces, a heading mark (`## `), emphasis marks attached to the text (`**…**`, `__…__`) and
// trailing full stops / exclamation marks. Not allowed: any other word, a quote mark, a list or quote prefix.
function soleVerdictKind(line) {
  let row = String(line || '').trim().replace(/^#{1,6}\s+/, '')
  const trimMarks = () => { row = row.replace(/[.。!！\s]+$/, '').replace(/^[*_]{1,3}(?=\S)/, '').replace(/(?<=\S)[*_]{1,3}$/, '') }
  trimMarks()
  trimMarks()
  const m = /^VERDICT\s*[:：]\s*(\S.*)$/.exec(row)
  if (!m) return ''
  const word = m[1].trim()
  if (word === 'APPROVED') return 'approved'
  if (/^CHANGES[ _-]REQUESTED$/.test(word) || SOLE_NEGATED_APPROVED_RE.test(word) || VERDICT_REJECT_WORDS.includes(word)) return 'rejected'
  return ''
}

// #69 (C01): a verdict line may hold a negation between the colon and the token (`VERDICT: NOT APPROVED`).
const VERDICT_LINE_RE = /VERDICT\s*[:：]\s*(?:(?:NOT|NEVER|CANNOT|CAN['’]T|DON['’]T|WON['’]T|ISN['’]T|不予|不能|无法|暂不|拒绝|未|不)\s*)?(APPROVED|CHANGES[ _-]REQUESTED)/g
const VERDICT_NEGATION_RE = /\bNOT\b|\bCANNOT\b|N['’]T\b|\bNEVER\b|不|未|无法|拒绝/
const VERDICT_NEGATION_WINDOW = 48
// Whether the clause right before `index` negates the token there. Only that clause counts (at most 48
// characters, cut at the last sentence or clause mark, colons included): a negation elsewhere in the report
// ("the first draft was not approved … VERDICT: APPROVED") does not reach the verdict.
// A line break does not cut: LLM prose is hard-wrapped, and "not\napproved" is still a negation.
function negatedBefore(upper, index) {
  const head = upper.slice(Math.max(0, index - VERDICT_NEGATION_WINDOW), index)
  let cut = -1
  for (const mark of '.!?。！？,，;；:：') cut = Math.max(cut, head.lastIndexOf(mark))
  return VERDICT_NEGATION_RE.test(head.slice(cut + 1))
}

// #103: longest text of `evidence.reviewDrift` (two full shas and a few file names fit).
const REVIEW_DRIFT_MAX = 600
// 0.9.49 (#47): sent once, into the same review session, when a review turn ended without a verdict.
const MAX_REVIEW_INCONCLUSIVE_RETRIES = 1
const REVIEW_VERDICT_NUDGE = [
  '你上一条回复没有给出审查结论。平台只读取每个回合的最后一条回复，回合结束后不会再自动叫醒你继续。',
  '请现在就给出结论：需要的检查在本回合内做完；还在后台跑的命令请在本回合内等它结束，或按已有证据判断。',
  '若结论是需修改，请把必须修改的问题逐条写在本条回复里（下一步只会读到这一条）。',
  '最后一行必须只写 VERDICT: APPROVED 或 VERDICT: CHANGES_REQUESTED（二选一，独占最后一行）。',
  '这一行不要加反引号、引号、代码块、列表符号或任何附加说明（例如「前提是…」）：结论行不是独占的最后一行时，平台不会记为通过。',
  '本条回复里只写这一行结论，不要再引用或复述另一种结论行：两种结论行同时出现时平台不会记为通过。',
].join('\n')

// #84: honour HERMES_HOME (the host's own config root) before ~/.hermes, so the panel reports the cap
// of the config the host really reads. Returns null when no agent.max_turns is found.
export function readHostHermesMaxTurns(profile = 'default') {
  const base = String(process.env.HERMES_HOME || '').trim() || join(homedir(), '.hermes')
  const candidates = [
    join(base, 'profiles', String(profile || 'default'), 'config.yaml'),
    join(base, 'config.yaml'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, 'utf8')
      const block = raw.match(/(?:^|\n)agent:\s*\n([\s\S]*?)(?:\n[a-zA-Z0-9_-]+:|\s*$)/)
      if (block) {
        // accepts 500, "500" and '500' (YAML quoted scalars), optionally followed by a comment
        const m = block[1].match(/^\s+max_turns:\s*(["']?)(\d+)\1\s*(?:#.*)?$/m)
        if (m) return Number(m[2]) || 0
      }
    } catch {
      // ignore unreadable config
    }
  }
  return null
}

const DEFAULT_EFFORT_SPECTRUM = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
const MAX_CHAT_UPLOAD_BYTES = 50 * 1024 * 1024
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i

function isImageAttachment(name, mediaType) {
  return String(mediaType || '').toLowerCase().startsWith('image/') || IMAGE_EXT_RE.test(String(name || ''))
}

function isPathInside(targetPath, parentDir) {
  const absTarget = resolve(targetPath)
  const absParent = resolve(parentDir)
  return absTarget === absParent || absTarget.startsWith(`${absParent}/`) || absTarget.startsWith(`${absParent}\\`)
}

function sanitizeChatAttachments(rawList, dataDir) {
  if (!Array.isArray(rawList) || !rawList.length) return []
  const allowedRoots = [
    resolve(join(dataDir, 'uploads')),
    resolve(join(homedir(), '.hermes-web-ui', 'upload')),
  ]
  if (process.env.UPLOAD_DIR) allowedRoots.push(resolve(process.env.UPLOAD_DIR))

  const clean = []
  for (const item of rawList.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue
    const rawPath = String(item.path || '').trim()
    if (!rawPath) continue
    const absPath = resolve(rawPath)
    const allowed = allowedRoots.some(root => isPathInside(absPath, root))
    if (!allowed || !existsSync(absPath)) continue
    let size = Number(item.size || 0)
    try {
      const st = statSync(absPath)
      if (!st.isFile()) continue
      if (!size) size = st.size
    } catch {
      continue
    }
    const name = basename(String(item.name || absPath)).slice(0, 200) || basename(absPath)
    const mediaType = String(item.mediaType || item.media_type || '').trim().slice(0, 120)
    const type = (item.type === 'image' || isImageAttachment(name, mediaType)) ? 'image' : 'file'
    clean.push({
      id: String(item.id || `att-${randomUUID().slice(0, 8)}`),
      type,
      name,
      path: absPath,
      mediaType: mediaType || (type === 'image' ? 'image/png' : 'application/octet-stream'),
      size,
    })
  }
  return clean
}

function formatAttachmentsAsText(attachments) {
  return attachments
    .map(att => (att.type === 'image'
      ? `[Attached image: ${att.name}]\nLocal image path for tools: ${att.path}`
      : `[Attached file: ${att.name}]\nLocal file path for tools: ${att.path}`))
    .join('\n\n')
}

function buildHostSessionInput(promptText, attachments, activeCfg) {
  if (!Array.isArray(attachments) || !attachments.length) return promptText
  // Hermes-WebUI native multimodal array contract (XM/pF in host server)
  if (!activeCfg?.engine || activeCfg.engine === 'hermes' || activeCfg.mode === 'scoped') {
    return [
      { type: 'text', text: promptText },
      ...attachments.map(att => ({
        type: att.type,
        name: att.name,
        path: att.path,
        media_type: att.mediaType,
      })),
    ]
  }
  return `${promptText}\n\n${formatAttachmentsAsText(attachments)}`
}

// #68 (C07 + G01): after dispose() the instance must not touch the database any more: index.mjs closes it right
// after, and node:sqlite then throws "database is not open" / "statement has been finalized" from any closure
// that is still running (a settle waiting on its gate, an async merge, a void wake). Every database call of a
// disposed instance is refused with this error, before it reaches the closed handle; the background entries
// (event, reconcile, settle) turn it into one "已废弃" log line instead of an error.
const DISPOSED_CODE = 'EKKO_TODO_DISPOSED'

function disposedError(what) {
  const err = new Error(`插件实例已卸载（dispose），${what}已废弃`)
  err.code = DISPOSED_CODE
  return err
}

function guardDisposedDb(db, isDisposed) {
  return new Proxy(db, {
    get(obj, key) {
      const value = obj[key]
      if (typeof value !== 'function') return value
      return (...args) => {
        if (isDisposed()) throw disposedError(`数据库调用 ${String(key)} `)
        return value.apply(obj, args)
      }
    },
  })
}

export function createOrchestrator({ db: hostDb, dataDir, config = {}, log = console, settleDelaysMs = null, sendBudgetMs = 800, messageTodoBudgetMs = 1500, slowLaunchWarnMs = 3000, instructionDedupeMs = 60000, busyProbeMs = 700, clock = Date.now, stallStopTimeoutMs = 5000, mergeWorktreeBranchImpl = mergeWorktreeBranch }) {
  // #68: lifecycle of this instance. `disposeController` aborts the test gates it started; `inflightMerges`
  // holds a token per merge that is still running, marked `abandoned` by dispose() so it writes nothing.
  let disposed = false
  const disposeController = new AbortController()
  const inflightMerges = new Set()
  const db = guardDisposedDb(hostDb, () => disposed)
  const worktreesDir = join(dataDir, 'worktrees')
  const uploadsDir = join(dataDir, 'uploads')
  const chiefWorkspaceDir = join(dataDir, 'chief-workspace')
  const testGateTimeoutMs = Number(config.testGateTimeoutMs) || 180000
  const settlingTodos = new Set()
  // 0.9.52 (#50): review settles of a repeated turn that are asking the host / reading the transcript again.
  // todoId -> { sessionId, lateEnd: { outcome, errorText, stopped } | null }. In memory only.
  const repeatReviewSettles = new Map()
  const mergingTodos = new Set()
  const startingTodos = new Set()
  // 0.9.48: one write at a time per card. todoId -> { owner, acquiredAt, label }, taken by build dispatch,
  // review dispatch, merge, retry-merge, complete and delete for as long as the call runs (a merge: until the
  // merge has ended). A second write is refused with the holder's label, it does not wait, so no call can
  // block another. In memory only: empty after a restart. A lock older than the TTL is taken over.
  // 0.9.49: stop (cancelBuild), close and reopen take it too; a holder that was taken over does not write the
  // card when it returns (stillOwnsWrite).
  const TODO_WRITE_LOCK_TTL_MS = 10 * 60 * 1000
  const todoWriteLocks = new Map()
  let todoWriteLockSeq = 0
  // 0.9.49 (#46): review dispatches whose launch call is still out. todoId -> { lock, sessionId, earlySettle }.
  // A host event that reports the end of that review run in this window is kept in `earlySettle` and settled
  // once the dispatch has finished its last write and released its lock (see runIndependentReview).
  const reviewLaunches = new Map()
  // Build-slot reservations: todos that passed the concurrency check but are still awaiting
  // worktree/session setup (not yet written as 'building'). Closes the check-then-act race.
  const buildSlotReservations = new Map()
  // Topics whose Chief turn is being launched right now (claim taken synchronously before any await).
  const launchingTopics = new Set()
  // 0.9.42: a send call answers after at most this long; the launch goes on in the background. The host can
  // hold `sessions.run` for 120 s (a run sent into a busy session) and the caller's own RPC times out first.
  // 0.9.65: sendBudgetMs is no longer used (the send waits for its delivery); accepted for old callers.
  void sendBudgetMs
  const MESSAGE_TODO_BUDGET_MS = Math.max(0, Number(messageTodoBudgetMs) || 0)
  const SLOW_LAUNCH_WARN_MS = Math.max(0, Number(slowLaunchWarnMs) || 0)
  // Sends being handled right now, `${topicId}:${clientNonce}`: a retry of the same send is answered at once.
  const inflightSends = new Set()
  // topicId -> id of the user message whose Chief turn is being started right now.
  const launchingMessages = new Map()
  // #125: topicId -> id of the user message that started the Chief turn of the topic (see turnMessageOf).
  // Kept after the launch, until the next turn of the topic: a wake turn removes it, a user turn replaces it.
  const turnMessages = new Map()
  const TURN_MESSAGES_MAX = 400
  // Worker instructions (message / changes / answer / plan) being handled right now, todoId -> idempotency key.
  // Covers the busy probe and the launch, so a second instruction cannot slip in between.
  const startingNotes = new Map()
  // 0.9.42: `${todoId}:${digest of kind+text}` -> time the instruction was accepted. The same instruction
  // arriving again inside INSTRUCTION_DEDUPE_MS (a caller that timed out and retried) is not dispatched again,
  // also after its run was started. A failed dispatch drops its key so a real retry goes through.
  const INSTRUCTION_DEDUPE_MS = Math.max(0, Number(instructionDedupeMs) || 0)
  const recentInstructions = new Map()
  // How long the busy probe of a todo's build session may take before an instruction (capped at 700 ms).
  const BUSY_PROBE_MS = Math.min(700, Math.max(50, Number(busyProbeMs) || 700))
  // Topics whose finished Chief turn still needs follow-up syncs (see requestChiefSettle). In-memory only:
  // after a reload the reconcile loop covers recent topics. First pass after ~1s, then 3 retries ~2s apart.
  const SETTLE_DELAYS_MS = Array.isArray(settleDelaysMs) && settleDelaysMs.length ? settleDelaysMs.map(n => Math.max(0, Number(n) || 0)) : [1000, 2000, 2000, 2000]
  const MAX_PENDING_SETTLES = 200
  const HOST_TAIL_PAGE_ROWS = 80
  const HOST_TAIL_MAX_PAGES = 12
  const pendingSettles = new Map()
  // #64 (C08): topicId -> { userId, profile, userText, activeCfg }: first-message titles left for the settle action.
  const pendingTitleJobs = new Map()
  // Queue delivery retry bookkeeping (in-memory; a restart simply retries from attempt 0).
  const MAX_QUEUE_DELIVERY_ATTEMPTS = 3
  const queueAttempts = new Map()
  const queueRetryAfter = new Map()
  const drainingQueuedProfiles = new Set()
  const drainingTopics = new Set()
  const modelCatalogCache = new Map()
  const ghProbeCache = new Map()
  const liveEnginesCache = new Map() // profile -> { ts, value }
  const warmingRuntimeProfiles = new Set()
  const sessionActivity = new Map() // sessionId -> { running, startedAt, updatedAt, activeTool, toolCount, stage }
  const todoMergeActivity = new Map() // todoId -> { running, startedAt, updatedAt, activeTool, toolCount, stage }
  const chiefRepoFingerprints = new Map() // topicId -> Map<projectId, { head, status, name }>
  const chiefViolationTurnGuard = new Set() // `${sessionId}:${startedAt}`
  const lastActivityEmitAt = new Map() // key -> timestamp
  const categoryIdCache = new Map() // `${profile}::${name}` -> number
  const isolatedSessions = new Map() // sessionId -> `${mode}::${categoryName}`
  const isolationSyncState = new Map() // `${userId}:${profile}` -> { running, mode, categoryName, total, done, generation, lastFinishedAt }
  // 0.9.43: topics whose Chief session runs the host `/compress` command right now, topicId -> { since, until }.
  // In-memory on purpose: a reload drops the lock and the topic is usable again (fail open). While a lock is
  // held no Chief turn is started for the topic; sends and wakes are queued and drained after it ends.
  const compressLocks = new Map()
  const COMPRESS_LOCK_MS = 135000

  function ensureChiefWorkspace() {
    try {
      mkdirSync(chiefWorkspaceDir, { recursive: true })
      const readmePath = join(chiefWorkspaceDir, 'CHIEF-GOVERNANCE-HUB.md')
      if (!existsSync(readmePath)) {
        writeFileSync(
          readmePath,
          '# Ekko ToDo Chief Governance Hub\n\nThis directory is the isolated orchestration workspace for Chief.\nChief does NOT hold direct write access to project repositories.\nUse `ekko-todo` MCP tools (`inspect_project_repo`, `create_todo`, `run_build`, `run_review`, `merge_build`) to inspect repositories and dispatch work to dedicated Worker Agents in isolated Git worktrees.\n',
          'utf8',
        )
      }
    } catch {
      // ignore if read-only fs
    }
    return chiefWorkspaceDir
  }

  // Runs `fn` and never rejects: { ok: true, value } or { ok: false, error }. Work that may outlive the call
  // that started it is wrapped in this, so a late failure cannot become an unhandled rejection.
  function settled(fn) {
    return (async () => {
      try { return { ok: true, value: await fn() } } catch (error) { return { ok: false, error } }
    })()
  }

  // The result of `work` (a `settled` promise), or null when it is still running after `budgetMs`.
  async function withinBudget(work, budgetMs) {
    let timer = null
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), budgetMs) })
    try { return await Promise.race([work, timeout]) } finally { clearTimeout(timer) }
  }

  function warnSlowLaunch(what, startedAt, data) {
    const ms = Date.now() - startedAt
    if (ms > SLOW_LAUNCH_WARN_MS) log?.warn?.(`Slow launch: ${what}`, { ...data, ms })
  }

  function emitUpdated(run, reason) {
    try {
      run?.messages?.emit?.('board.updated', { at: Date.now(), reason }, { audience: 'plugin' })
    } catch {
      // ignore outside UI contexts
    }
  }

  function emitActivityThrottled(run, key, reason, minIntervalMs = 450) {
    const now = Date.now()
    const prev = lastActivityEmitAt.get(key) || 0
    if (now - prev < minIntervalMs) return
    lastActivityEmitAt.set(key, now)
    emitUpdated(run, reason)
  }

  async function ensureStudioCategory(run, categoryName = 'Ekko ToDo') {
    const req = run?.host?.request
    if (typeof req !== 'function') return null
    const cleanName = String(categoryName || '').trim() || 'Ekko ToDo'
    const profile = run?.identity?.profile || 'default'
    const cacheKey = `${profile}::${cleanName.toLowerCase()}`
    if (categoryIdCache.has(cacheKey)) return categoryIdCache.get(cacheKey)
    try {
      const listed = await req('/api/studio/session-categories', { method: 'GET' }).catch(() => null)
      const cats = Array.isArray(listed?.categories) ? listed.categories : []
      const existing = cats.find(c => String(c?.name || '').trim().toLowerCase() === cleanName.toLowerCase())
      if (existing?.id) {
        categoryIdCache.set(cacheKey, Number(existing.id))
        return Number(existing.id)
      }
      const created = await req('/api/studio/session-categories', {
        method: 'POST',
        body: { name: cleanName },
      }).catch(() => null)
      const createdId = Number(created?.category?.id || created?.id || 0)
      if (createdId > 0) {
        categoryIdCache.set(cacheKey, createdId)
        return createdId
      }
    } catch {
      // best-effort on non-Studio mock hosts
    }
    return null
  }

  async function applySessionIsolation(run, sessionId, settings, { force = false, resolvedCategoryId } = {}) {
    if (!sessionId || typeof run?.host?.request !== 'function') return false
    const mode = settings?.sessionIsolationMode || 'category'
    const catName = String(settings?.sessionCategoryName || 'Ekko ToDo').trim() || 'Ekko ToDo'
    const sig = `${mode}::${catName}`
    if (!force && isolatedSessions.get(sessionId) === sig) return true

    try {
      if (mode === 'category' || mode === 'hidden') {
        const categoryId = resolvedCategoryId !== undefined
          ? resolvedCategoryId
          : await ensureStudioCategory(run, catName)
        const ops = []
        if (categoryId) {
          ops.push(
            run.host.request(`/api/studio/sessions/${encodeURIComponent(sessionId)}/category`, {
              method: 'POST',
              body: { categoryId },
            }).catch(() => {}),
          )
        }
        ops.push(
          Promise.resolve(run.host.sessions?.archive?.(sessionId, mode === 'hidden')).catch(() => {}),
        )
        await Promise.all(ops)
      } else {
        await Promise.all([
          run.host.request(`/api/studio/sessions/${encodeURIComponent(sessionId)}/category`, {
            method: 'POST',
            body: { categoryId: null },
          }).catch(() => {}),
          Promise.resolve(run.host.sessions?.archive?.(sessionId, false)).catch(() => {}),
        ])
      }
      isolatedSessions.set(sessionId, sig)
      return true
    } catch {
      return false
    }
  }

  function scheduleBackgroundSessionIsolation(run, { userId, profile, settings, wait = false } = {}) {
    const stateKey = `${userId}:${profile}`
    const topics = db.listTopics(userId, profile, { includeArchived: true })
    const todos = db.listTodos(userId, profile)
    const sessionIds = new Set()
    for (const tp of topics) {
      if (tp.chiefSessionId) sessionIds.add(tp.chiefSessionId)
    }
    for (const td of todos) {
      if (td.buildSessionId) sessionIds.add(td.buildSessionId)
      if (td.reviewSessionId) sessionIds.add(td.reviewSessionId)
    }
    const list = [...sessionIds]
    const prev = isolationSyncState.get(stateKey)
    const generation = (prev?.generation || 0) + 1
    const mode = settings.sessionIsolationMode || 'category'
    const categoryName = String(settings.sessionCategoryName || 'Ekko ToDo').trim() || 'Ekko ToDo'

    if (list.length === 0) {
      isolationSyncState.set(stateKey, {
        running: false,
        mode,
        categoryName,
        total: 0,
        done: 0,
        generation,
        lastFinishedAt: Date.now(),
      })
      return {
        generation,
        total: 0,
        promise: Promise.resolve(0),
      }
    }

    isolationSyncState.set(stateKey, {
      running: true,
      mode,
      categoryName,
      total: list.length,
      done: 0,
      generation,
      lastFinishedAt: prev?.lastFinishedAt || 0,
    })

    const runBg = async () => {
      let updatedCount = 0
      try {
        const resolvedCategoryId = (mode === 'category' || mode === 'hidden')
          ? await ensureStudioCategory(run, categoryName)
          : null
        const CHUNK = 6
        for (let i = 0; i < list.length; i += CHUNK) {
          // If a newer mode switch arrived while we were processing, yield immediately
          if (isolationSyncState.get(stateKey)?.generation !== generation) return updatedCount
          const slice = list.slice(i, i + CHUNK)
          const results = await Promise.all(
            slice.map(sid => applySessionIsolation(run, sid, settings, { force: true, resolvedCategoryId })),
          )
          updatedCount += results.filter(Boolean).length
          if (isolationSyncState.get(stateKey)?.generation === generation) {
            isolationSyncState.set(stateKey, {
              running: i + CHUNK < list.length,
              mode,
              categoryName,
              total: list.length,
              done: Math.min(list.length, i + slice.length),
              generation,
              lastFinishedAt: i + CHUNK < list.length ? (prev?.lastFinishedAt || 0) : Date.now(),
            })
          }
        }
        if (isolationSyncState.get(stateKey)?.generation === generation) {
          isolationSyncState.set(stateKey, {
            running: false,
            mode,
            categoryName,
            total: list.length,
            done: updatedCount,
            generation,
            lastFinishedAt: Date.now(),
          })
          emitUpdated(run, `sessions.isolated:${updatedCount}`)
        }
      } catch (err) {
        log?.warn?.('Background session isolation sync failed', { error: err?.message || String(err) })
        if (isolationSyncState.get(stateKey)?.generation === generation) {
          isolationSyncState.set(stateKey, {
            running: false,
            mode,
            categoryName,
            total: list.length,
            done: updatedCount,
            generation,
            lastFinishedAt: Date.now(),
          })
          emitUpdated(run, 'sessions.isolation_done')
        }
      }
      return updatedCount
    }

    const promise = runBg()
    if (!wait) {
      void promise
    }
    return { generation, total: list.length, promise }
  }

  async function syncSessionIsolation(run, { wait = false } = {}) {
    const { userId, profile } = run.identity
    const settings = db.getSettings(userId, profile, config)
    const job = scheduleBackgroundSessionIsolation(run, { userId, profile, settings, wait })
    const updatedCount = wait ? await job.promise : 0
    return {
      ok: true,
      queued: !wait && job.total > 0,
      mode: settings.sessionIsolationMode,
      categoryName: settings.sessionCategoryName,
      sessionCount: job.total,
      updatedCount,
      state: await getSnapshot(run),
    }
  }

  /**
   * Start a host session run (wait:false). The host RPC can abort with a client-side timeout even though
   * the run was actually accepted. On timeout/abort we probe the live session: if it is working, treat the
   * launch as successful instead of marking the todo/topic as a terminal failure.
   */
  async function launchSessionRun(run, sessionId, input, options) {
    const startedAt = Date.now()
    try {
      return await run.host.sessions.run(sessionId, input, options)
    } catch (err) {
      const msg = String(err?.message || err || '')
      // 0.9.65: the reason goes into the message text too: the host log keeps only the text, not the data.
      const callEnded = Boolean(run?.signal?.aborted)
      log?.warn?.(`sessions.run rejected: ${msg.slice(0, 300)}${callEnded ? '（发起这次启动的插件调用已结束）' : ''}`, { sessionId, ms: Date.now() - startedAt, error: msg.slice(0, 300), callEnded })
      // The host refused because this session already has a live run: the work is in progress, not failed.
      if (/already running/i.test(msg)) return { run_id: '', recoveredFromTimeout: true, alreadyRunning: true }
      if (!/abort|timed?\s*out|timeout/i.test(msg)) throw err
      // #64 (C06): the call that started this launch has ended, so the host cancelled the run with it. Nothing
      // was started and probing with the same dead handle can only be refused too (it answered "unknown,
      // assume working" and the refused launch passed for a started one). Throw: every caller then takes
      // its failure path (a wake is queued, a queued card stays queued) and a fresh handle retries.
      if (callEnded) {
        const ended = new Error(`${msg || 'aborted'}（发起这次启动的插件调用已结束，本次没有启动）`)
        ended.code = 'HOST_CALL_ENDED'
        ended.cause = err
        throw ended
      }
      if (sessionActivity.get(sessionId)?.running) return { run_id: '', recoveredFromTimeout: true }
      const probe = await probeSessionWorking(run, sessionId, { timeoutMs: 2500 }).catch(() => null)
      // Fail closed toward "still working" when the host cannot tell: the reconcile loop settles real
      // failures later, while a false "failed" invites a duplicate dispatch onto a busy session.
      if (probe && (probe.isWorking || Number(probe.queueLength || 0) > 0)) {
        return { run_id: '', recoveredFromTimeout: true }
      }
      throw err
    }
  }

  async function probeSessionWorking(run, sessionId, { timeoutMs = 1800 } = {}) {
    if (!sessionId) return { known: false, isWorking: false, runStartedAt: 0 }
    // #64 (C06): a handle whose call has ended can tell nothing; its refusals are not "the host cannot tell".
    if (run?.signal?.aborted) return { known: false, isWorking: false, runStartedAt: 0, handleEnded: true }

    // 1. Live socket `resumed` probe — exact authoritative source of `sessionMap.get(id).isWorking` on Ekko Studio
    if (typeof run?.host?.sessions?.connect === 'function') {
      const socketProbe = await new Promise(resolveProbe => {
        let settled = false
        let handle = null
        const finish = result => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { handle?.close?.() } catch {}
          resolveProbe(result)
        }
        const timer = setTimeout(() => finish(null), timeoutMs)
        Promise.resolve(run.host.sessions.connect(sessionId, evt => {
          const ev = String(evt?.event || '')
          if (ev === 'resumed' || ev === 'app.resumed') {
            finish({
              known: true,
              isWorking: Boolean(evt.isWorking),
              runStartedAt: Number(evt.runStartedAt || 0),
              queueLength: Number(evt.queueLength || 0),
            })
          }
        })).then(h => {
          if (settled) {
            try { h?.close?.() } catch {}
          } else {
            handle = h
          }
        }).catch(() => finish(null))
      })
      if (socketProbe && socketProbe.known) return socketProbe
    }

    // 2. Fallback HTTP detail check (used in unit tests / mock hosts that expose explicit running booleans)
    const detail = await run?.host?.sessions?.get?.(sessionId).catch(() => null)
    if (run?.signal?.aborted) return { known: false, isWorking: false, runStartedAt: 0, handleEnded: true }
    if (!detail || typeof detail !== 'object') {
      return { known: false, isWorking: true, runStartedAt: 0 }
    }
    const explicitRunning = detail.is_running
      ?? detail.running
      ?? detail.isWorking
      ?? detail.is_working
      ?? detail.session?.is_running
      ?? detail.session?.running
      ?? detail.session?.isWorking
      ?? detail.session?.is_working
    if (typeof explicitRunning === 'boolean') {
      return { known: true, isWorking: explicitRunning, runStartedAt: 0 }
    }
    if (detail.ended_at || detail.session?.ended_at) {
      return { known: true, isWorking: false, runStartedAt: 0 }
    }
    // Real Studio GET /api/studio/sessions/:id omits running state -> fail-closed (do NOT falsely mark finished!)
    return { known: false, isWorking: true, runStartedAt: 0 }
  }

  async function probeLiveEngines(run, force = false) {
    const profile = String(run?.identity?.profile || 'default')
    const cached = liveEnginesCache.get(profile)
    if (!force && cached && Date.now() - cached.ts < 45000) {
      return cached.value
    }
    try {
      const res = await run?.host?.agents?.list?.()
      const agents = Array.isArray(res?.agents) ? res.agents : []
      const mapped = agents.map(a => ({
        id: String(a.id || ''),
        name: String(a.name || a.id || ''),
        vendor: String(a.vendor || ''),
        installed: Boolean(a.status?.installed),
        version: String(a.status?.version || ''),
        modes: Array.isArray(a.modes) ? a.modes.map(String) : ['global'],
      })).filter(a => a.id)
      liveEnginesCache.set(profile, { ts: Date.now(), value: mapped })
      return mapped
    } catch {
      return cached?.value || []
    }
  }

  async function getGithubStatusCached(userId, profile, force = false) {
    const cacheKey = `${userId}:${profile}`
    const cached = ghProbeCache.get(cacheKey)
    if (!force && cached && Date.now() - cached.ts < 30000 && !getGithubDeviceLoginStatus().active) {
      return cached.value
    }
    const stored = db.getGithubToken(userId, profile)
    const val = await probeGithubAuth({ pat: stored.token, patUser: stored.username })
      .catch(() => ({ ghAvailable: false, authenticated: false, username: '', authSource: 'none', deviceFlow: getGithubDeviceLoginStatus() }))
    ghProbeCache.set(cacheKey, { ts: Date.now(), value: val })
    return val
  }

  function invalidateGithubCache(userId, profile) {
    ghProbeCache.delete(`${userId}:${profile}`)
  }

  async function getGithubAuthStatus(run, { refresh = true } = {}) {
    const { userId, profile } = run.identity
    return getGithubStatusCached(userId, profile, Boolean(refresh))
  }

  async function startGithubDeviceAuth(run) {
    const { userId, profile } = run.identity
    invalidateGithubCache(userId, profile)
    const flow = await startGithubDeviceLogin()
    const status = await getGithubStatusCached(userId, profile, true)
    return { ...status, deviceFlow: flow }
  }

  async function saveGithubToken(run, { token }) {
    const { userId, profile } = run.identity
    const verified = await verifyGithubToken(token)
    db.setGithubToken(userId, profile, { token: String(token).trim(), username: verified.username })
    invalidateGithubCache(userId, profile)
    emitUpdated(run, 'github.token_saved')
    const status = await getGithubStatusCached(userId, profile, true)
    return { ...status, verifiedUser: verified }
  }

  async function logoutGithub(run, { includeCli = false } = {}) {
    const { userId, profile } = run.identity
    cancelGithubDeviceLogin()
    db.setGithubToken(userId, profile, { token: '', username: '' })
    if (includeCli) {
      await logoutGithubCli()
    }
    invalidateGithubCache(userId, profile)
    emitUpdated(run, 'github.logged_out')
    return getGithubStatusCached(userId, profile, true)
  }

  async function listGithubRepos(run, input = {}) {
    const { userId, profile } = run.identity
    const stored = db.getGithubToken(userId, profile)
    const res = await listGithubReposRaw({
      query: input.query || '',
      limit: input.limit || 50,
      pat: stored.token,
      patUser: stored.username,
    })
    // Cache the auth status only. The list is dropped by omission: an explicit `repos: undefined` would
    // travel into get-state, where it is not JSON and makes the host reject the whole snapshot.
    const { repos: _repos, ...authStatus } = res
    ghProbeCache.set(`${userId}:${profile}`, { ts: Date.now(), value: authStatus })
    return res
  }

  async function uploadChatFile(run, { name, mediaType = '', dataBase64 }) {
    const profile = String(run?.identity?.profile || 'default').replace(/[^A-Za-z0-9._-]/g, '_') || 'default'
    const rawName = basename(String(name || '').trim()).slice(0, 200)
    if (!rawName) throw new Error('文件名不能为空')
    const rawB64 = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '').trim()
    if (!rawB64) throw new Error('文件内容不能为空')
    const buf = Buffer.from(rawB64, 'base64')
    if (!buf.length) throw new Error('上传的文件为空')
    if (buf.length > MAX_CHAT_UPLOAD_BYTES) {
      throw new Error(`文件体积超过 ${Math.round(MAX_CHAT_UPLOAD_BYTES / 1024 / 1024)} MB 上限`)
    }
    const ext = extname(rawName)
    const safeExt = /^\.[A-Za-z0-9]{1,20}$/.test(ext) ? ext : ''
    const dir = join(uploadsDir, profile)
    mkdirSync(dir, { recursive: true })
    const storedName = `${randomBytes(8).toString('hex')}${safeExt}`
    const fullPath = join(dir, storedName)
    writeFileSync(fullPath, buf)
    const type = isImageAttachment(rawName, mediaType) ? 'image' : 'file'
    return {
      id: `att-${randomUUID().slice(0, 8)}`,
      type,
      name: rawName,
      path: fullPath,
      mediaType: String(mediaType || '').trim() || (type === 'image' ? 'image/png' : 'application/octet-stream'),
      size: buf.length,
    }
  }

  async function getModelCatalog(run, { engine = 'hermes', refresh = false } = {}) {
    const profile = run?.identity?.profile || 'default'
    const cleanEngine = String(engine || 'hermes').trim()
    const cacheKey = `${profile}::${cleanEngine}`
    const cached = modelCatalogCache.get(cacheKey)
    if (!refresh && cached && Date.now() - cached.ts < 60000) {
      return cached.data
    }

    let result = {
      engine: cleanEngine,
      status: 'empty',
      source: 'none',
      defaultProvider: '',
      defaultModel: '',
      providers: [],
      models: [],
    }

    try {
      if (cleanEngine === 'hermes' || cleanEngine === 'ekko-agent' || cleanEngine === 'studio') {
        const providersMap = new Map()
        const models = []
        let defaultProvider = ''
        let defaultModel = ''

        const avail = await run?.host?.request?.('/api/hermes/available-models', { method: 'GET' }).catch(() => null)
        if (avail && Array.isArray(avail.groups)) {
          defaultProvider = String(avail.default_provider || '')
          defaultModel = String(avail.default || '')
          for (const g of avail.groups) {
            const pKey = String(g.provider || g.provider_key || '')
            if (!pKey) continue
            const label = String(g.label || pKey)
            const apiMode = String(g.api_mode || '')
            const list = Array.isArray(g.models) ? g.models : []
            providersMap.set(pKey, { id: pKey, label, apiMode, modelCount: list.length })
            for (const m of list) {
              const mid = typeof m === 'string' ? m : String(m?.id || m?.model || '')
              if (!mid) continue
              models.push({
                id: mid,
                name: typeof m === 'object' && m?.name ? String(m.name) : mid,
                provider: pKey,
                providerLabel: label,
                apiMode,
                isDefault: pKey === defaultProvider && mid === defaultModel,
                reasoningEfforts: Array.isArray(m?.reasoningEfforts) && m.reasoningEfforts.length
                  ? m.reasoningEfforts.map(String)
                  : DEFAULT_EFFORT_SPECTRUM,
              })
            }
          }
        }

        if (!models.length && run?.host?.models?.list) {
          const listed = await run.host.models.list().catch(() => null)
          const data = Array.isArray(listed?.data) ? listed.data : []
          for (const item of data) {
            const rawId = String(item.id || '')
            const ownedBy = String(item.owned_by || '')
            const slashIdx = rawId.indexOf('/')
            const provider = ownedBy || (slashIdx > 0 ? rawId.slice(0, slashIdx) : '')
            const modelId = slashIdx > 0 ? rawId.slice(slashIdx + 1) : rawId
            if (!modelId) continue
            if (provider && !providersMap.has(provider)) {
              providersMap.set(provider, { id: provider, label: provider, apiMode: String(item.api_mode || ''), modelCount: 0 })
            }
            models.push({
              id: modelId,
              name: String(item.display_name || modelId),
              provider,
              providerLabel: provider,
              apiMode: String(item.api_mode || ''),
              isDefault: false,
              reasoningEfforts: DEFAULT_EFFORT_SPECTRUM,
            })
          }
        }

        result = {
          engine: cleanEngine,
          status: models.length ? 'ready' : 'empty',
          source: avail?.groups ? 'hermes-available-models' : 'host-models',
          defaultProvider,
          defaultModel,
          providers: [...providersMap.values()],
          models,
        }
      } else if (run?.host?.agents?.models) {
        const res = await run.host.agents.models(cleanEngine, Boolean(refresh))
        const rawModels = Array.isArray(res?.models) ? res.models : []
        const models = rawModels
          .filter(m => !m.hidden)
          .map(m => ({
            id: String(m.id || ''),
            name: String(m.name || m.id || ''),
            provider: String(m.provider || ''),
            providerLabel: String(m.provider || cleanEngine),
            apiMode: '',
            isDefault: Boolean(m.isDefault),
            reasoningEfforts: Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length
              ? m.reasoningEfforts.map(String)
              : DEFAULT_EFFORT_SPECTRUM,
          }))
          .filter(m => m.id)
        const def = models.find(m => m.isDefault)
        result = {
          engine: cleanEngine,
          status: String(res?.status || (models.length ? 'ready' : 'empty')),
          source: String(res?.source || 'agent-catalog'),
          defaultProvider: def?.provider || '',
          defaultModel: def?.id || '',
          providers: [],
          models,
        }
      }
    } catch (err) {
      result.status = 'error'
      result.error = err?.message || '读取模型目录失败'
    }

    modelCatalogCache.set(cacheKey, { ts: Date.now(), data: result })
    return result
  }

  async function readHostMemory(run) {
    try {
      const res = await run?.host?.request?.('/api/hermes/memory', { method: 'GET' })
      if (!res || typeof res !== 'object') {
        return { available: false, memory: '', user: '', soul: '', entryCount: 0 }
      }
      const memory = String(res.memory || '')
      const user = String(res.user || '')
      const soul = String(res.soul || '')
      const entryCount = memory ? memory.split(/\n§\n/).filter(Boolean).length : 0
      return { available: true, memory, user, soul, entryCount }
    } catch {
      return { available: false, memory: '', user: '', soul: '', entryCount: 0 }
    }
  }

  async function getSnapshot(run) {
    return fitSnapshotBudget(await buildSnapshot(run))
  }

  /** Full (clamped) diffs for one todo; the drawer loads these when the snapshot omitted bodies. */
  function getTodoDiffs(run, { todoId }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    return { todoId: todo.id, diffs: todo.diffs || [] }
  }

  /** Detail bodies of one todo (spec, plan, diffs, worker chat, timeline, evidence, question), at most about 400 KB;
   *  the drawer loads these for a card the board snapshot reduced to a stub (stubbed: true). */
  // Todo #98: search-workspace (read-only, partitioned by run.identity).
  function searchWorkspace(run, input = {}) {
    const { userId, profile } = run.identity
    return db.searchWorkspace(userId, profile, input)
  }

  function getTodoDetail(run, { todoId }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const detail = fitTodoDetail(todo)
    const mismatch = todoTopicMismatch(userId, profile, todo)
    return mismatch ? { ...detail, topicProjectMismatch: mismatch } : detail
  }

  async function buildSnapshot(run) {
    const { userId, profile } = run.identity
    const sqliteBuiltin = await probeSqlite()
    const engCached = liveEnginesCache.get(profile)
    const ghCached = ghProbeCache.get(`${userId}:${profile}`)
    const warmKey = `${userId}:${profile}`

    // Non-blocking cold-start acceleration: never stall initial UI boot on 500-900ms CLI probes!
    const needWarm = (!engCached || Date.now() - engCached.ts >= 45000) || (!ghCached || Date.now() - ghCached.ts >= 30000)
    if (needWarm && !warmingRuntimeProfiles.has(warmKey)) {
      warmingRuntimeProfiles.add(warmKey)
      void Promise.all([
        probeLiveEngines(run, false),
        getGithubStatusCached(userId, profile, false),
      ]).then(() => {
        emitUpdated(run, 'runtime.warmed')
      }).catch(() => {}).finally(() => {
        warmingRuntimeProfiles.delete(warmKey)
      })
    }

    const liveEngines = engCached?.value || [
      { id: 'hermes', name: 'Hermes Agent', vendor: 'Nous', installed: true, version: '', modes: ['scoped'] },
    ]
    const githubCli = ghCached?.value || {
      ghAvailable: false,
      authenticated: false,
      username: '',
      authSource: 'none',
      deviceFlow: getGithubDeviceLoginStatus(),
    }

    const settings = db.getSettings(userId, profile, config)
    // Agents and projects written before the limits may hold over-long strings; shorten the view only.
    const agents = db.ensureDefaultAgents(userId, profile, liveEngines).map(a => {
      const view = { ...a, cooldowns: db.listAgentCooldowns(a.id) }
      // Older rows may hold an over-long id or system prompt: shorten them in the view only.
      if (String(a.id || '').length > MAX_AGENT_REF_CHARS) {
        view.id = clampText(a.id, MAX_AGENT_REF_CHARS)
        view.trimmedFields = ['id']
        view.cooldowns = view.cooldowns.map(cd => ({ ...cd, agentId: view.id }))
      }
      if (String(a.systemPrompt || '').length > MAX_SYSTEM_PROMPT_CHARS) {
        view.systemPrompt = clampText(a.systemPrompt, MAX_SYSTEM_PROMPT_CHARS)
        view.systemPromptTrimmed = true
      }
      const configs = Array.isArray(a.modelConfigs) ? a.modelConfigs.map(clampModelConfigForView) : a.modelConfigs
      const flat = clampModelConfigForView({ engine: a.engine, provider: a.provider, model: a.model, apiMode: a.apiMode, baseUrl: a.baseUrl, reasoningEffort: a.reasoningEffort })
      const configsCut = Array.isArray(configs) && configs.some((c, i) => c !== a.modelConfigs[i])
      if (configsCut || flat.baseUrl !== a.baseUrl || flat.model !== a.model || flat.provider !== a.provider || flat.apiMode !== a.apiMode || flat.reasoningEffort !== a.reasoningEffort || flat.engine !== a.engine) {
        Object.assign(view, flat, { modelConfigs: configs, modelConfigsTrimmed: true })
      }
      return view
    })
    const projects = db.listProjects(userId, profile).map(pj => {
      const trimmedFields = Object.keys(PROJECT_TEXT_LIMITS).filter(key => String(pj[key] || '').length > PROJECT_TEXT_LIMITS[key])
      if (!trimmedFields.length) return pj
      const view = { ...pj, trimmedFields }
      for (const key of trimmedFields) view[key] = clampText(pj[key], PROJECT_TEXT_LIMITS[key])
      return view
    })
    // Memories written before the caps may be oversized; shorten the view only.
    const memories = db.listMemories(userId, profile).map(m => {
      const longContent = String(m.content || '').length > MAX_MEMORY_CONTENT_CHARS
      const longTitle = String(m.title || '').length > MAX_MEMORY_TITLE_CHARS
      const longId = String(m.id || '').length > MAX_AGENT_REF_CHARS
      const longScopeId = String(m.scopeId || '').length > MAX_AGENT_REF_CHARS
      if (!longContent && !longTitle && !longId && !longScopeId) return m
      const view = { ...m }
      if (longId || longScopeId) {
        view.trimmedFields = []
        if (longId) { view.id = clampText(m.id, MAX_AGENT_REF_CHARS); view.trimmedFields.push('id') }
        if (longScopeId) { view.scopeId = clampText(m.scopeId, MAX_AGENT_REF_CHARS); view.trimmedFields.push('scopeId') }
      }
      if (longContent) { view.content = clampText(m.content, MAX_MEMORY_CONTENT_CHARS); view.contentTrimmed = true }
      if (longTitle) { view.title = clampText(m.title, MAX_MEMORY_TITLE_CHARS); view.titleTrimmed = true }
      return view
    })
    // #97: topics without a project that hold cards get their project here at the latest (first load).
    adoptOrphanTopics(run, userId, profile)
    const topicTally = topicTodoTally(userId, profile)
    const topics = db.listTopics(userId, profile).map(t => {
      const act = t.chiefSessionId ? (sessionActivity.get(t.chiefSessionId) || null) : null
      const queuedItems = db.listTopicQueue(userId, profile, t.id)
      const view = {
        ...t,
        isRunning: Boolean(t.isRunning || act?.running),
        liveActivity: act,
        queuedItems,
      }
      // #97: present only when the topic has no project or holds cards of other projects.
      const scopeReason = topicScopeReasonOf(userId, profile, t, topicTally)
      if (scopeReason) view.topicScopeReason = scopeReason
      // Present only while a Chief turn for this topic is being started.
      if (launchingTopics.has(t.id)) view.launching = true
      // 0.9.43: present only while the host compresses this topic's Chief session (manual /compress).
      const compressLock = compressLockOf(t.id)
      if (compressLock) view.compressingSince = compressLock.since
      if (launchingMessages.has(t.id)) view.launchingMessageId = launchingMessages.get(t.id)
      // View-only limits; stored rows are never rewritten here.
      if (queuedItems.length > MAX_QUEUED_ITEMS_IN_VIEW) {
        view.queuedItems = queuedItems.slice(-MAX_QUEUED_ITEMS_IN_VIEW)
        view.queuedItemsOmitted = queuedItems.length - MAX_QUEUED_ITEMS_IN_VIEW
      }
      if (String(t.lastError || '').length > MAX_LAST_ERROR_CHARS) {
        view.lastError = clampText(t.lastError, MAX_LAST_ERROR_CHARS)
        view.lastErrorTrimmed = true
      }
      if (String(t.title || '').length > MAX_TOPIC_TITLE_CHARS) {
        view.title = clampText(t.title, MAX_TOPIC_TITLE_CHARS)
        view.titleTrimmed = true
      }
      const briefView = clampBrief(t.brief)
      if (briefView !== t.brief) {
        view.brief = briefView
        view.briefTrimmed = true
      }
      if (view.queuedItems.some(q => String(q?.text || '').length > MAX_QUEUED_TEXT_CHARS)) {
        view.queuedItems = view.queuedItems.map(q => (String(q?.text || '').length > MAX_QUEUED_TEXT_CHARS
          ? { ...q, text: clampText(q.text, MAX_QUEUED_TEXT_CHARS), textTrimmed: true }
          : q))
      }
      if (Array.isArray(t.messages) && t.messages.some(m => String(m?.text || '').length > MAX_TOPIC_MESSAGE_CHARS)) {
        view.messages = t.messages.map(m => (String(m?.text || '').length > MAX_TOPIC_MESSAGE_CHARS
          ? { ...m, text: clampText(m.text, MAX_TOPIC_MESSAGE_CHARS), textTrimmed: true }
          : m))
      }
      return view
    })
    // #97: project of every topic, to flag cards that sit in a topic of another project.
    const topicProjectIds = new Map(db.listTopicProjectIds(userId, profile).map(t => [t.id, t.projectId]))
    const todos = db.listTodos(userId, profile).map(td => {
      let act = null
      if (td.phase === 'merging') {
        act = todoMergeActivity.get(td.id) || { running: true, stage: 'merging', activeTool: 'git merge', toolCount: 0, startedAt: td.updatedAt }
      } else if (td.phase === 'reviewing' && td.reviewSessionId) {
        act = sessionActivity.get(td.reviewSessionId) || { running: true, stage: 'reviewing', activeTool: '', toolCount: 0, startedAt: td.updatedAt }
      } else if (td.phase === 'building' && td.buildSessionId) {
        act = sessionActivity.get(td.buildSessionId) || { running: true, stage: 'building', activeTool: '', toolCount: 0, startedAt: td.updatedAt }
      }
      // Rows written before the storage caps may still hold an oversized error or spec; shorten the view only.
      const view = { ...td, liveActivity: act }
      const mismatch = todoTopicMismatch(userId, profile, td, topicProjectIds)
      if (mismatch) view.topicProjectMismatch = mismatch
      // 0.9.70 (#85): derived, read-only, never stored: how long the card has been silent.
      if (act && (td.phase === 'building' || td.phase === 'reviewing')) {
        const stall = stallView(td.id)
        if (stall) view.stall = stall
      }
      if (String(td.lastError || '').length > MAX_LAST_ERROR_CHARS) {
        view.lastError = clampText(td.lastError, MAX_LAST_ERROR_CHARS)
        view.lastErrorTrimmed = true
      }
      if (String(td.spec || '').length > MAX_SPEC_CHARS) {
        view.spec = clampText(td.spec, MAX_SPEC_CHARS)
        view.specTrimmed = true
      }
      const longIdFields = ['agentId', 'reviewerId', 'topicId'].filter(key => String(td[key] || '').length > MAX_AGENT_REF_CHARS)
      if (longIdFields.length) {
        for (const key of longIdFields) view[key] = clampText(td[key], MAX_AGENT_REF_CHARS)
        view.trimmedFields = longIdFields
      }
      if (Array.isArray(td.tags) && (td.tags.length > MAX_TAGS || td.tags.some(tag => String(tag || '').length > MAX_TAG_CHARS))) {
        view.tags = clampTags(td.tags)
        view.tagsTrimmed = true
      }
      const questionView = clampQuestion(td.question)
      if (questionView !== td.question) {
        view.question = questionView
        view.questionTrimmed = true
      }
      if (Buffer.byteLength(String(td.plan || '')) > MAX_PLAN_BYTES) {
        view.plan = clampUtf8(td.plan, MAX_PLAN_BYTES)
        view.planTrimmed = true
      }
      if (String(td.title || '').length > MAX_TITLE_CHARS) {
        view.title = clampText(td.title, MAX_TITLE_CHARS)
        view.titleTrimmed = true
      }
      if (Array.isArray(td.buildChat) && (td.buildChat.length > MAX_CHAT_ENTRIES || td.buildChat.some(m => String(m?.text || '').length > MAX_CHAT_ENTRY_CHARS))) {
        view.buildChat = clampBuildChat(td.buildChat)
        view.buildChatTrimmed = true
      }
      return view
    })

    const waitingTopics = topics.filter(t => !t.archived && String(t.brief?.waitingOnYou || '').trim()).length
    const humanAttention = todos.filter(t => t.gateOwner === 'human' && t.phase !== 'done' && t.phase !== 'closed').length + waitingTopics
    const chiefTracked = todos.filter(t => t.gateOwner === 'chief' && t.phase !== 'done' && t.phase !== 'closed').length
    const building = todos.filter(t => t.phase === 'building' || t.phase === 'reviewing').length
    const queued = todos.filter(t => t.phase === 'queued').length
    const merging = todos.filter(t => t.phase === 'merging').length
    const done = todos.filter(t => t.phase === 'done').length
    const schedules = db.listSchedules(userId, profile)
    const quotaProviders = db.listQuotaProviders(userId, profile)
    const hostConfiguredTurns = readHostHermesMaxTurns(profile)
    const hostMaxTurns = hostConfiguredTurns || 0
    const turnBudget = hostTurnBudget({ configured: hostConfiguredTurns, envOverride: process.env.HERMES_BRIDGE_MAX_TURNS })
    // Only auto-open Onboarding Wizard for brand-new empty workspaces (never interrupt existing active users)
    const needsOnboarding = !settings.onboardingCompleted && projects.length === 0 && topics.length === 0

    let settingsView = String(settings.charter || '').length > MAX_CHARTER_CHARS
      ? { ...settings, charter: clampText(settings.charter, MAX_CHARTER_CHARS), charterTrimmed: true }
      : settings
    if (String(settings.chiefAgentId || '').length > MAX_AGENT_REF_CHARS) {
      settingsView = { ...settingsView, chiefAgentId: clampText(settings.chiefAgentId, MAX_AGENT_REF_CHARS), chiefAgentIdTrimmed: true }
    }
    if (String(settings.defaultCloneRoot || '').length > MAX_CLONE_ROOT_CHARS) {
      settingsView = { ...settingsView, defaultCloneRoot: clampText(settings.defaultCloneRoot, MAX_CLONE_ROOT_CHARS), defaultCloneRootTrimmed: true }
    }

    return {
      settings: settingsView,
      concurrency: { active: building, limit: settings.maxConcurrentBuilds, queued },
      counts: {
        humanAttention,
        waitingTopics,
        chiefTracked,
        building: building + merging,
        queued,
        done,
        total: todos.length,
        memories: memories.filter(m => m.enabled).length,
        schedules: schedules.filter(s => s.enabled).length,
      },
      projects,
      agents,
      memories,
      topics,
      todos,
      schedules,
      quotaProviders,
      runtime: {
        nodeVersion: process.version,
        sqliteBuiltin,
        profile,
        mcpServer: 'ekko-todo',
        mcpToolCount: 31,
        dataDir,
        chiefWorkspaceDir: ensureChiefWorkspace(),
        liveEngines,
        githubCli,
        needsOnboarding,
        hostMaxTurns,
        hostTurnBudget: turnBudget,
        isolationSync: isolationSyncState.get(`${userId}:${profile}`) || {
          running: false,
          mode: settings.sessionIsolationMode,
          categoryName: settings.sessionCategoryName,
          total: 0,
          done: 0,
          generation: 0,
          lastFinishedAt: 0,
        },
        avatarSpec: AVATAR_UPLOAD_SPEC,
        maxUploadBytes: MAX_CHAT_UPLOAD_BYTES,
      },
    }
  }

  async function addProject(run, input) {
    const { userId, profile } = run.identity
    const liveEngines = await probeLiveEngines(run)
    db.ensureDefaultAgents(userId, profile, liveEngines)
    const inspected = await inspectRepo(input.repoPath)
    const parsedGh = parseGithubRepoInput(input.githubRepo || inspected.githubRepo || input.remoteUrl || inspected.remoteUrl)
    const project = db.createProject(userId, profile, {
      ...input,
      repoPath: inspected.repoPath,
      githubRepo: parsedGh?.nameWithOwner || input.githubRepo || inspected.githubRepo || '',
      remoteUrl: input.remoteUrl || inspected.remoteUrl || parsedGh?.httpsUrl || '',
      sourceType: input.sourceType || (parsedGh ? 'github-linked' : 'local'),
      defaultBranch: input.defaultBranch?.trim() || inspected.defaultBranch,
    })
    emitUpdated(run, `project.created:${project.id}`)
    return { project, inspected, state: await getSnapshot(run) }
  }

  async function importGithubProject(run, input) {
    const { userId, profile } = run.identity
    const liveEngines = await probeLiveEngines(run)
    db.ensureDefaultAgents(userId, profile, liveEngines)

    const parsed = parseGithubRepoInput(input.githubRepo || input.remoteUrl)
    if (!parsed && !input.remoteUrl) {
      throw new Error('请提供有效的 GitHub 仓库（如 owner/repo 或完整 URL）')
    }

    let inspected
    let sourceType = 'github-linked'
    if (input.mode === 'clone') {
      const baseDir = String(input.cloneParentDir || input.repoPath || '').trim()
      if (!baseDir) throw new Error('请选择克隆目标目录')
      const repoFolderName = parsed?.repo || String(input.name || 'repo').replace(/[^a-zA-Z0-9._-]/g, '-')
      const targetPath = input.useExactPath ? baseDir : join(baseDir, repoFolderName)
      const storedGh = db.getGithubToken(userId, profile)
      inspected = await cloneGithubRepo({
        githubRepo: parsed?.nameWithOwner || input.githubRepo || '',
        cloneUrl: input.remoteUrl || parsed?.httpsUrl || '',
        targetPath,
        branch: input.defaultBranch || '',
        pat: storedGh.token,
      })
      sourceType = inspected.cloned ? 'github-cloned' : 'github-linked'
    } else {
      if (!input.repoPath?.trim()) throw new Error('请选择或输入要关联的本地 Git 目录')
      inspected = await inspectRepo(input.repoPath)
      sourceType = 'github-linked'
    }

    const repoBaseName = String(input.name || '').trim() || parsed?.repo || inspected.repoPath.split(/[\\/]/).filter(Boolean).pop() || 'GitHub Project'
    const project = db.createProject(userId, profile, {
      ...input,
      name: repoBaseName,
      displayName: String(input.displayName || '').trim(),
      avatar: input.avatar || '',
      repoPath: inspected.repoPath,
      githubRepo: parsed?.nameWithOwner || inspected.githubRepo || '',
      remoteUrl: input.remoteUrl || inspected.remoteUrl || parsed?.httpsUrl || '',
      sourceType,
      isPrivate: Boolean(input.isPrivate),
      defaultBranch: input.defaultBranch?.trim() || inspected.defaultBranch,
    })
    emitUpdated(run, `project.github_imported:${project.id}`)
    return { project, inspected, state: await getSnapshot(run) }
  }

  async function updateProject(run, input) {
    const { userId, profile } = run.identity
    if (input.repoPath) await inspectRepo(input.repoPath)
    const project = db.updateProject(userId, profile, input.id, input)
    emitUpdated(run, `project.updated:${project.id}`)
    return { project, state: await getSnapshot(run) }
  }

  async function deleteProject(run, projectId) {
    const { userId, profile } = run.identity
    const project = db.getProject(userId, profile, projectId)
    if (project) {
      // Stop live runs and drop plugin-owned worktrees first; branches and snapshot refs in the
      // user's repository are left untouched so no unmerged work is destroyed.
      for (const todo of db.listTodos(userId, profile, projectId)) {
        for (const sid of [todo.buildSessionId, todo.reviewSessionId]) {
          if (!sid) continue
          if (['building', 'reviewing'].includes(todo.phase)) await run.host.sessions.stop(sid).catch(() => {})
          sessionActivity.delete(sid)
        }
        todoMergeActivity.delete(todo.id)
        if (todo.worktreePath) {
          await removeWorktree({ repoPath: project.repoPath, worktreePath: todo.worktreePath, branchName: todo.branch, deleteBranch: false }).catch(() => {})
        }
      }
    }
    db.deleteProjectCascade(userId, profile, projectId)
    emitUpdated(run, `project.deleted:${projectId}`)
    await drainQueuedTodos(run, userId, profile).catch(() => {})
    return getSnapshot(run)
  }

  // 0.9.57: provider/model pairs are normalized (repeated provider prefix, `custom` + `custom:<pool>/…`) and,
  // for Hermes configs, checked against the host model catalog before they are stored. A pair the host does
  // not serve fails every run with 404 model_not_found; it is refused here with the closest valid ids.
  async function normalizeAgentModels(run, input, existing) {
    const out = { ...input }
    const engineOf = cfg => String(cfg?.engine || input.engine || existing?.engine || 'hermes')
    const pairs = []
    if (out.model !== undefined || out.provider !== undefined) {
      const n = normalizeModelRef({ provider: out.provider ?? existing?.provider, model: out.model ?? existing?.model })
      if (out.provider !== undefined || n.provider !== String(existing?.provider || '')) out.provider = n.provider
      if (out.model !== undefined || n.model !== String(existing?.model || '')) out.model = n.model
      if (n.model && engineOf(null) === 'hermes' && !out.customModel) pairs.push({ label: '主配置', ...n })
    }
    if (Array.isArray(out.modelConfigs)) {
      out.modelConfigs = out.modelConfigs.map((cfg, i) => {
        if (!cfg || typeof cfg !== 'object') return cfg
        const n = normalizeModelRef({ provider: cfg.provider, model: cfg.model })
        if (n.model && engineOf(cfg) === 'hermes' && !cfg.customModel) pairs.push({ label: i === 0 ? '首选配置' : `备选 #${i}`, ...n })
        return { ...cfg, provider: n.provider, model: n.model }
      })
    }
    if (!pairs.length) return out
    const catalog = await getModelCatalog(run, { engine: 'hermes' }).catch(() => null)
    const bad = []
    for (const pair of pairs) {
      const check = checkModelInCatalog(catalog, pair)
      if (check.known && !check.ok) bad.push(`${pair.label} ${pair.provider ? `${pair.provider}/` : ''}${pair.model}${check.suggestions.length ? `（可选：${check.suggestions.join('、')}）` : ''}`)
    }
    if (bad.length) {
      throw new Error(`模型不在 Studio 可用模型目录中，保存后每次运行都会 404：${bad.join('；')}。请用 get_system_config 或配置中心里列出的 provider + model 组合。`)
    }
    return out
  }

  async function saveAgent(run, rawInput) {
    const { userId, profile } = run.identity
    if (!db.listAgents(userId, profile).length) {
      const liveEngines = await probeLiveEngines(run)
      db.ensureDefaultAgents(userId, profile, liveEngines)
    }
    const existingId = rawInput?.id ? db.resolveAgentId(userId, profile, rawInput.id) : ''
    const existing = existingId ? db.getAgent(userId, profile, existingId) : null
    const input = await normalizeAgentModels(run, rawInput, existing)
    const agent = db.upsertAgent(userId, profile, input)
    const settings = db.getSettings(userId, profile, config)
    if (agent.id === settings.chiefAgentId && agent.provider && agent.model) {
      const topics = db.listTopics(userId, profile, { includeArchived: false })
      for (const tp of topics.slice(0, 6)) {
        if (!tp.chiefSessionId) continue
        const payload = { provider: agent.provider, model: agent.model }
        if (agent.reasoningEffort) payload.reasoning_effort = agent.reasoningEffort
        if (agent.apiMode) payload.api_mode = agent.apiMode
        await run.host?.sessions?.setModel?.(tp.chiefSessionId, payload).catch(() => {})
      }
    }
    emitUpdated(run, `agent.saved:${agent.id}`)
    return { agent, state: await getSnapshot(run) }
  }

  async function clearAgentCooldowns(run, agentId) {
    const { userId, profile } = run.identity
    db.clearAgentCooldowns(agentId, userId, profile)
    emitUpdated(run, `agent.cooldowns_cleared:${agentId}`)
    return getSnapshot(run)
  }

  async function removeAgent(run, agentId) {
    const { userId, profile } = run.identity
    const agents = db.listAgents(userId, profile)
    if (agents.length <= 1) throw new Error('至少需要保留一个 Agent')
    const settings = db.getSettings(userId, profile, config)
    // The board shows an older over-long id shortened: compare the stored id with the Chief binding.
    const storedId = db.resolveAgentId(userId, profile, agentId)
    db.deleteAgent(userId, profile, storedId)
    if (settings.chiefAgentId === storedId) {
      const remaining = db.listAgents(userId, profile)
      const fallbackChief = remaining.find(a => a.role === 'chief') || remaining[0]
      db.updateSettings(userId, profile, { chiefAgentId: fallbackChief ? fallbackChief.id : '' })
    }
    emitUpdated(run, `agent.deleted:${agentId}`)
    return getSnapshot(run)
  }

  async function saveSettings(run, input) {
    const { userId, profile } = run.identity
    const prev = db.getSettings(userId, profile, config)
    const updated = db.updateSettings(userId, profile, input)
    if (
      updated.sessionIsolationMode !== prev.sessionIsolationMode
      || updated.sessionCategoryName !== prev.sessionCategoryName
    ) {
      // Never block settings switch: apply isolation to historical sessions asynchronously in background
      scheduleBackgroundSessionIsolation(run, { userId, profile, settings: updated, wait: false })
    }
    if (updated.maxConcurrentBuilds > prev.maxConcurrentBuilds) {
      await drainQueuedTodos(run, userId, profile).catch(() => {})
    }
    emitUpdated(run, 'settings.updated')
    return getSnapshot(run)
  }

  async function inspectProjectRepo(run, { projectId }) {
    const { userId, profile } = run.identity
    const project = db.getProject(userId, profile, projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    const report = await inspectProjectRepoReadOnly(project.repoPath, project.defaultBranch)
    const guidelines = readRepoGuidelines(project.repoPath, 1600)
    return {
      projectId: project.id,
      projectName: project.displayName || project.name,
      githubRepo: project.githubRepo || '',
      ...report,
      guidelines,
    }
  }

  async function completeOnboarding(run, input = {}) {
    const { userId, profile } = run.identity
    const liveEngines = await probeLiveEngines(run)
    const agents = db.ensureDefaultAgents(userId, profile, liveEngines)
    const settings = db.getSettings(userId, profile, config)

    if (input.skip) {
      db.updateSettings(userId, profile, { onboardingCompleted: true })
      emitUpdated(run, 'onboarding.skipped')
      return getSnapshot(run)
    }

    const chiefEngine = String(input.chiefEngine || '').trim() || 'hermes'
    const chiefMode = input.chiefMode === 'scoped' || input.chiefMode === 'global'
      ? input.chiefMode
      : (chiefEngine === 'hermes' ? 'scoped' : 'global')
    const chiefProvider = String(input.chiefProvider || '').trim()
    const chiefModel = String(input.chiefModel || '').trim()
    const chiefEffort = String(input.chiefReasoningEffort || 'high').trim()
    const fallbackEngine = String(input.fallbackEngine || '').trim()
    const presetId = String(input.teamPreset || 'engineering').trim()
    const preset = getTeamPreset(presetId)

    const chief = resolveChiefAgent(userId, profile, liveEngines)
    if (chief) {
      const nextConfigs = [
        {
          id: 'cfg-primary',
          label: '主力大总管',
          engine: chiefEngine,
          mode: chiefMode,
          provider: chiefProvider,
          model: chiefModel,
          apiMode: '',
          baseUrl: '',
          customModel: false,
          reasoningEffort: chiefEffort,
        },
        ...(fallbackEngine && fallbackEngine !== chiefEngine
          ? [{
              id: 'cfg-fallback-1',
              label: '备选引擎',
              engine: fallbackEngine,
              mode: fallbackEngine === 'hermes' ? 'scoped' : 'global',
              provider: '',
              model: '',
              apiMode: '',
              baseUrl: '',
              customModel: false,
              reasoningEffort: chiefEffort,
            }]
          : []),
      ]
      db.upsertAgent(userId, profile, {
        ...chief,
        name: String(input.chiefName || chief.name || '大总管').trim(),
        avatar: input.chiefAvatar || chief.avatar || 'preset:chief-compass',
        engine: chiefEngine,
        mode: chiefMode,
        provider: chiefProvider,
        model: chiefModel,
        reasoningEffort: chiefEffort,
        modelConfigs: nextConfigs,
        autoFallback: true,
      })
    }

    // Apply team scenario preset workers non-destructively (never erase existing custom agents)
    if (preset && input.applyTeamPreset !== false) {
      const existingByName = new Set(agents.map(a => a.name))
      const workerEngine = chiefEngine
      const workerMode = chiefMode
      const altEngine = fallbackEngine && fallbackEngine !== workerEngine ? fallbackEngine : ''
      for (const spec of preset.workers) {
        if (existingByName.has(spec.name)) continue
        const chosenEngine = spec.readOnly && altEngine ? altEngine : workerEngine
        const chosenMode = chosenEngine === 'hermes' ? 'scoped' : (chosenEngine === workerEngine ? workerMode : 'global')
        db.upsertAgent(userId, profile, {
          name: spec.name,
          role: spec.role,
          roleLabel: spec.roleLabel,
          avatar: spec.avatar,
          description: spec.description,
          engine: chosenEngine,
          mode: chosenMode,
          reasoningEffort: 'high',
          autoFallback: true,
          approvalPolicy: 'never',
          sandboxMode: spec.sandboxMode,
          memoryEnabled: true,
          maxTurns: DEFAULT_AGENT_TURNS,
          systemPrompt: spec.systemPrompt,
          readOnly: spec.readOnly,
        })
      }
    }

    const nextCharter = String(settings.charter || '').trim()
      ? settings.charter
      : (preset?.charter || '')

    db.updateSettings(userId, profile, {
      onboardingCompleted: true,
      teamPreset: preset?.id || presetId,
      charter: nextCharter,
    })

    emitUpdated(run, `onboarding.completed:${preset?.id || presetId}`)
    return getSnapshot(run)
  }

  async function quickConfigureChief(run, input) {
    const { userId, profile } = run.identity
    const liveEngines = await probeLiveEngines(run)
    const hasSettingsPatch = input.chiefAgentId !== undefined
      || input.maxConcurrentBuilds !== undefined
      || input.chiefAuthority !== undefined
      || input.defaultCloneRoot !== undefined
      || input.charter !== undefined
    const settingsPatch = {
      ...(input.chiefAgentId !== undefined ? { chiefAgentId: input.chiefAgentId } : {}),
      ...(input.maxConcurrentBuilds !== undefined ? { maxConcurrentBuilds: input.maxConcurrentBuilds } : {}),
      ...(input.chiefAuthority !== undefined ? { chiefAuthority: input.chiefAuthority } : {}),
      ...(input.defaultCloneRoot !== undefined ? { defaultCloneRoot: input.defaultCloneRoot } : {}),
      ...(input.charter !== undefined ? { charter: input.charter } : {}),
    }
    const hasAgentPatch = input.engine !== undefined
      || input.mode !== undefined
      || input.provider !== undefined
      || input.model !== undefined
      || input.apiMode !== undefined
      || input.baseUrl !== undefined
      || input.customModel !== undefined
      || input.reasoningEffort !== undefined
      || input.modelConfigs !== undefined
      || input.autoFallback !== undefined
      || input.memoryEnabled !== undefined
      || input.systemPrompt !== undefined
    const agentInputFor = chief => {
      const { modelConfigs: _existingConfigs, cooldowns: _cd, ...chiefRest } = chief
      return {
        ...chiefRest,
        ...(input.engine !== undefined ? { engine: input.engine } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.apiMode !== undefined ? { apiMode: input.apiMode } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.customModel !== undefined ? { customModel: Boolean(input.customModel) } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.modelConfigs !== undefined ? { modelConfigs: input.modelConfigs } : {}),
        ...(input.autoFallback !== undefined ? { autoFallback: Boolean(input.autoFallback) } : {}),
        ...(input.memoryEnabled !== undefined ? { memoryEnabled: Boolean(input.memoryEnabled) } : {}),
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      }
    }

    // Validate everything first, write afterwards: when any field is refused, nothing is saved.
    if (hasSettingsPatch) db.updateSettings(userId, profile, settingsPatch, { dryRun: true })
    if (hasAgentPatch) {
      const agentsNow = db.ensureDefaultAgents(userId, profile, liveEngines)
      const chiefId = input.chiefAgentId !== undefined ? String(input.chiefAgentId) : db.getSettings(userId, profile, config).chiefAgentId
      const prospective = agentsNow.find(a => a.id === chiefId) || agentsNow.find(a => a.role === 'chief') || agentsNow[0]
      if (prospective) db.upsertAgent(userId, profile, agentInputFor(prospective), { dryRun: true })
    }

    if (hasSettingsPatch) db.updateSettings(userId, profile, settingsPatch)
    const chief = resolveChiefAgent(userId, profile, liveEngines)
    if (chief && hasAgentPatch) {
      await saveAgent(run, agentInputFor(chief))
    } else {
      emitUpdated(run, 'chief.configured')
    }
    return getSnapshot(run)
  }

  async function saveMemory(run, input) {
    const { userId, profile } = run.identity
    const memory = db.upsertMemory(userId, profile, input)
    emitUpdated(run, `memory.saved:${memory.id}`)
    return { memory, state: await getSnapshot(run) }
  }

  async function removeMemory(run, memoryId) {
    const { userId, profile } = run.identity
    db.deleteMemory(userId, profile, memoryId)
    emitUpdated(run, `memory.deleted:${memoryId}`)
    return getSnapshot(run)
  }

  async function createTopic(run, input = {}) {
    const { userId, profile } = run.identity
    const topic = db.createTopic(userId, profile, input)
    emitUpdated(run, `topic.created:${topic.id}`)
    return { topic, state: await getSnapshot(run) }
  }

  async function renameTopic(run, { topicId, title, isUserNamed = true }) {
    const { userId, profile } = run.identity
    const clean = String(title || '').trim()
    if (!clean) throw new Error('话题标题不能为空')
    db.updateTopic(userId, profile, topicId, { title: clean, isUserNamed: Boolean(isUserNamed) })
    emitUpdated(run, `topic.renamed:${topicId}`)
    return getSnapshot(run)
  }

  async function updateTopicMeta(run, input) {
    const { userId, profile } = run.identity
    const patch = {}
    if (input.title !== undefined) { patch.title = String(input.title).trim(); patch.isUserNamed = true }
    if (input.pinned !== undefined) patch.pinned = Boolean(input.pinned)
    if (input.archived !== undefined) patch.archived = Boolean(input.archived)
    if (input.autopilot !== undefined) patch.autopilot = Boolean(input.autopilot)
    if (input.projectId !== undefined) {
      // '' detaches the topic from any project. A project id that does not exist is refused, so a topic is
      // never tied to nothing by a stale page.
      const nextProjectId = String(input.projectId)
      if (nextProjectId && !db.getProject(userId, profile, nextProjectId)) throw new Error(`项目不存在：${nextProjectId}`)
      patch.projectId = nextProjectId
    }
    if (input.activeConfigId !== undefined) patch.activeConfigId = String(input.activeConfigId)
    if (input.brief !== undefined) patch.brief = input.brief
    // #119: the topic-adopt row and the topic are one transaction. A topic that does not exist, or a topic
    // write that fails, stores no row: the row alone would say "decided" about a topic that was not changed.
    db.transaction(() => {
      // #97: the user decided the project of this topic (or that it has none): it is never auto-adopted.
      if (patch.projectId !== undefined) db.claimWakeKey(topicAdoptKey(String(input.topicId)), '', String(input.topicId))
      db.updateTopic(userId, profile, input.topicId, patch)
    })
    emitUpdated(run, `topic.updated:${input.topicId}`)
    return getSnapshot(run)
  }

  async function markBriefWaitingDone(run, { topicId, optionId = '', optionLabel = '', note = '', notifyChief = true }) {
    const { userId, profile } = run.identity
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic) throw new Error(`Topic not found: ${topicId}`)
    const prevWaiting = String(topic.brief?.waitingOnYou || '').trim()
    const prevOpts = Array.isArray(topic.brief?.waitingOptions) ? topic.brief.waitingOptions : []
    const picked = findOptionById(prevOpts, optionId)
    const chosenLabel = String(optionLabel || picked?.label || '').trim()
    const cleanNote = String(note || '').trim()

    db.updateTopic(userId, profile, topicId, {
      brief: { ...topic.brief, waitingOnYou: '', waitingTitle: '', waitingRecommendation: '', waitingOptions: [] },
    })

    if (notifyChief !== false) {
      const compactCtx = prevWaiting.length > 160 ? `${prevWaiting.slice(0, 158)}…` : prevWaiting
      let msg = ''
      if (chosenLabel && cleanNote) {
        msg = cleanNote.includes(chosenLabel)
          ? `【批复确认】${cleanNote}`
          : `【批复确认】${chosenLabel}\n决策细则：${cleanNote}`
      } else if (chosenLabel) {
        const ctxRef = compactCtx ? `（针对：${compactCtx}）` : ''
        msg = `【批复确认】${chosenLabel}${ctxRef}，请按此决定继续推进。`
      } else if (cleanNote) {
        const ctxRef = compactCtx && !cleanNote.includes(compactCtx.slice(0, 20)) ? `（针对：${compactCtx}）` : ''
        msg = `【批复确认】${cleanNote}${ctxRef}`
      } else {
        msg = compactCtx ? `【批复确认】已确认处理：${compactCtx}，请继续推进。` : '【批复确认】已处理待确认事项，请继续推进。'
      }
      return sendTopicMessage(run, { topicId, text: msg })
    }

    db.addTopicMessage(userId, profile, topicId, {
      kind: 'system',
      text: chosenLabel || cleanNote
        ? `已关闭待确认项：${chosenLabel || cleanNote}`
        : '已手动关闭待你确认提示。',
      progressNotice: '已关闭「等你」待确认项',
    })
    emitUpdated(run, `topic.brief_cleared:${topicId}`)
    return getSnapshot(run)
  }

  async function setTopicAutopilot(run, { topicId, autopilot }) {
    return updateTopicMeta(run, { topicId, autopilot })
  }

  async function deleteTopic(run, topicId) {
    const { userId, profile } = run.identity
    db.deleteTopic(userId, profile, topicId)
    emitUpdated(run, `topic.deleted:${topicId}`)
    return getSnapshot(run)
  }

  // 0.9.57: configs stored before normalization (e.g. model `kimi-coding/k3.1-pro` under provider
  // `kimi-coding`) are cleaned at use time too, so an existing agent works without being re-saved.
  function cleanModelCfg(cfg) {
    if (!cfg || typeof cfg !== 'object' || (cfg.engine && cfg.engine !== 'hermes') || cfg.customModel) return cfg
    const n = normalizeModelRef({ provider: cfg.provider, model: cfg.model })
    return n.provider === (cfg.provider || '') && n.model === (cfg.model || '') ? cfg : { ...cfg, ...n }
  }

  function buildRunModelOptions(rawCfg, agent = null) {
    const cfg = cleanModelCfg(rawCfg)
    const opts = {}
    if (cfg.engine && cfg.engine !== 'hermes') {
      opts.mode = cfg.mode === 'scoped' ? 'scoped' : 'global'
    }
    if (cfg.model) {
      opts.model = cfg.model
      if (cfg.provider) opts.provider = cfg.provider
    }
    if (cfg.reasoningEffort) opts.reasoning_effort = cfg.reasoningEffort
    if (cfg.apiMode) opts.apiMode = cfg.apiMode
    if (cfg.baseUrl) opts.baseUrl = cfg.baseUrl
    // #84: always send max_turns, 0 included. 0 = unlimited, matching Hermes `resolve_turn_limit`
    // (hermes_cli/config.py: 0/-1/none/unlimited -> sys.maxsize). Omitting it used to mean
    // "inherit the host cap" (150 on a fresh install), which is not unlimited. Today's Web UI drops
    // this option and applies config.yaml agent.max_turns; see src/shared/turn-budget.mjs.
    Object.assign(opts, turnRunOptions(agent))
    return opts
  }

  async function ensureSessionForConfig(run, { existingSessionId, title, cfg: rawCfg, workspace, forceNew = false }) {
    const cfg = cleanModelCfg(rawCfg)
    const { userId, profile } = run.identity
    const settings = db.getSettings(userId, profile, config)
    if (existingSessionId && !forceNew) {
      if (workspace) await run.host.sessions.setWorkspace(existingSessionId, workspace).catch(() => {})
      if (cfg.model) {
        const modelPayload = { model: cfg.model }
        if (cfg.provider) modelPayload.provider = cfg.provider
        if (cfg.reasoningEffort) modelPayload.reasoning_effort = cfg.reasoningEffort
        await run.host.sessions.setModel(existingSessionId, modelPayload).catch(() => {})
      }
      await applySessionIsolation(run, existingSessionId, settings)
      return existingSessionId
    }
    const createBody = {
      title: String(title || 'Ekko ToDo Session').slice(0, 480),
      agent: cfg.engine || 'hermes',
    }
    if (cfg.engine && cfg.engine !== 'hermes') {
      createBody.mode = cfg.mode === 'scoped' ? 'scoped' : 'global'
    }
    const created = await run.host.sessions.create(createBody)
    const sessionId = String(created?.session?.id || created?.id || created?.session_id || '')
    if (!sessionId) throw new Error('Host did not return a valid session ID')
    if (workspace) await run.host.sessions.setWorkspace(sessionId, workspace).catch(() => {})
    if (cfg.model) {
      const modelPayload = { model: cfg.model }
      if (cfg.provider) modelPayload.provider = cfg.provider
      if (cfg.reasoningEffort) modelPayload.reasoning_effort = cfg.reasoningEffort
      await run.host.sessions.setModel(sessionId, modelPayload).catch(() => {})
    }
    await applySessionIsolation(run, sessionId, settings, { force: true })
    return sessionId
  }

  function resolveChiefAgent(userId, profile, liveEngines = []) {
    const agents = db.ensureDefaultAgents(userId, profile, liveEngines)
    const settings = db.getSettings(userId, profile, config)
    return agents.find(a => a.id === settings.chiefAgentId)
      || agents.find(a => a.role === 'chief')
      || agents[0]
  }

  function collectRelevantMemories(userId, profile, { projectId = '', agentId = '', includeChief = false } = {}) {
    const all = db.listMemories(userId, profile, { onlyEnabled: true })
    return all.filter(m => {
      if (includeChief && m.scope === 'chief') return true
      if (projectId && m.scope === 'project' && (!m.scopeId || m.scopeId === projectId)) return true
      if (agentId && m.scope === 'agent' && m.scopeId === agentId) return true
      return false
    })
  }

  async function maybeAutoGenerateTopicTitle(run, userId, profile, topicId, userText, activeCfg, { retried = false } = {}) {
    const cur = db.getTopic(userId, profile, topicId)
    if (!cur || cur.isUserNamed) return
    const result = await generateTopicTitleWithModel(run, {
      userText,
      preferredModel: activeCfg?.model || '',
      preferredProvider: activeCfg?.provider || '',
    }).catch(() => null)
    // #64 (C08): the title is generated after the send call returned; when that call ends while the model is
    // still answering, the host cancels the request and only the provisional title comes back. The job is
    // handed to the `settle` scheduler action, which retries it once with its own handle. A second
    // cancellation keeps the provisional title, and the log says so.
    if (!result?.generatedByModel && run?.signal?.aborted) {
      if (!retried && pendingTitleJobs.size < MAX_PENDING_SETTLES) {
        pendingTitleJobs.set(topicId, { userId, profile, userText, activeCfg })
        log?.warn?.('话题标题生成被取消：发起它的插件调用已结束，已交给定时动作用新连接重试', { topicId })
        return
      }
      log?.warn?.('话题标题生成被取消：发起它的插件调用已结束，重试也未完成，保留临时标题', { topicId })
    }
    if (!result?.title) return
    const latest = db.getTopic(userId, profile, topicId)
    if (!latest || latest.isUserNamed) return
    if (latest.title !== result.title) {
      db.updateTopic(userId, profile, topicId, { title: result.title, isUserNamed: false })
      emitUpdated(run, `topic.auto_titled:${topicId}`)
    }
  }

  async function snapshotProjectFingerprintsForAudit(userId, profile, topicId) {
    const projects = db.listProjects(userId, profile)
    const map = new Map()
    await Promise.all(projects.slice(0, 8).map(async p => {
      if (!p.repoPath) return
      const fp = await captureRepoFingerprint(p.repoPath)
      if (fp) map.set(p.id, { ...fp, name: p.displayName || p.name })
    }))
    chiefRepoFingerprints.set(topicId, map)
  }

  async function readChiefTurnToolArgs(run, sessionId) {
    if (!sessionId) return ''
    const res = await run.host.sessions.messages(sessionId, { limit: 300 }).catch(() => null)
    const list = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : [])
    let start = 0
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.role === 'user') { start = i; break }
    }
    const out = []
    for (const m of list.slice(start)) {
      for (const c of (Array.isArray(m?.tool_calls) ? m.tool_calls : [])) {
        const raw = c?.function?.arguments ?? c?.arguments ?? ''
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
        out.push(text)
        try { out.push(JSON.stringify(JSON.parse(text))) } catch {}
      }
    }
    return out.join('\n')
  }

  async function auditChiefRepoMutation(run, userId, profile, topicId) {
    const settings = db.getSettings(userId, profile, config)
    if (settings.chiefStrictOrchestration === false) return
    const beforeMap = chiefRepoFingerprints.get(topicId)
    if (!beforeMap || beforeMap.size === 0) return
    chiefRepoFingerprints.delete(topicId)
    // Skip flagging if a legitimate merge_build ran in the last 30s
    const recentMerged = db.listTodos(userId, profile).some(t => t.phase === 'done' && Date.now() - t.updatedAt < 30000)
    // Only blame the Chief for repos its own tool calls in this turn referenced; changes made by the user
    // or other sessions during the turn are not Chief violations.
    const turnArgs = await readChiefTurnToolArgs(run, db.getTopic(userId, profile, topicId)?.chiefSessionId)
    const dirtied = []
    for (const [pid, before] of beforeMap.entries()) {
      const home = homedir()
      const tildePath = before.repoPath?.startsWith(home) ? `~${before.repoPath.slice(home.length)}` : ''
      if (!before.repoPath || !(turnArgs.includes(before.repoPath) || (tildePath && turnArgs.includes(tildePath)))) continue
      const after = await captureRepoFingerprint(before.repoPath)
      if (!after) continue
      const statusChanged = after.status !== before.status && Boolean(after.status)
      const headChanged = !recentMerged && after.head && before.head && after.head !== before.head
      if (statusChanged || headChanged) {
        dirtied.push(before.name)
      }
    }
    if (dirtied.length > 0) {
      const notice = `⚠️ 总管治理审计：检测到项目「${dirtied.join('、')}」主工作树在大总管回合内被直接改动。请确保实际开发/分支操作始终建单派给专属 Agent 在隔离 Worktree 中执行。`
      db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: notice, progressNotice: notice })
      emitUpdated(run, `chief.audit_violation:${topicId}`)
    }
  }

  async function launchChiefRunWithFailover(run, { userId, profile, topic, chiefAgent, promptText, attachments = [], instructions, activeProject, forceNewSession = false, digestAsOf = 0 }) {
    const settings = db.getSettings(userId, profile, config)
    // Layer 1 Hard Constraint (Todos architecture): physically isolate Chief in its own governance hub
    // instead of dropping Chief inside any project Git repository!
    const chiefWorkspace = settings.chiefStrictOrchestration !== false
      ? ensureChiefWorkspace()
      : (activeProject?.repoPath || '')

    if (settings.chiefStrictOrchestration !== false) {
      await snapshotProjectFingerprintsForAudit(userId, profile, topic.id)
    }

    let { config: activeCfg, index: cfgIdx } = resolveActiveConfig(chiefAgent, topic.activeConfigId)
    let sessionId = topic.chiefSessionId
    let needFreshSession = forceNewSession
    // Strict orchestration also caps how hard the Chief thinks: routing work does not need max effort,
    // and long deliberation is exactly where it starts doing the Worker's job itself.
    const capChiefCfg = cfg => (settings.chiefStrictOrchestration !== false && settings.chiefEffortCap
      ? { ...cfg, reasoningEffort: capReasoningEffort(cfg.reasoningEffort, settings.chiefEffortCap) }
      : cfg)

    for (let attempt = 0; attempt < Math.max(1, chiefAgent.modelConfigs.length); attempt += 1) {
      try {
        sessionId = await ensureSessionForConfig(run, {
          existingSessionId: sessionId,
          title: `[Ekko ToDo] ${topic.title}`,
          cfg: capChiefCfg(activeCfg),
          workspace: chiefWorkspace,
          forceNew: needFreshSession,
        })
        const runOptions = {
          wait: false,
          instructions,
          ...buildRunModelOptions(capChiefCfg(activeCfg), chiefAgent),
        }
        if (chiefWorkspace) runOptions.workspace = chiefWorkspace
        const hostInput = buildHostSessionInput(promptText, attachments, activeCfg)
        const launched = await launchSessionRun(run, sessionId, hostInput, runOptions)
        const runId = String(launched?.run_id || launched?.queue_id || '')
        const now = Date.now()
        sessionActivity.set(sessionId, {
          running: true,
          startedAt: now,
          updatedAt: now,
          activeTool: '',
          toolCount: 0,
          stage: 'thinking',
        })
        db.updateTopic(userId, profile, topic.id, {
          chiefSessionId: sessionId,
          activeRunId: runId,
          activeConfigId: activeCfg.id,
          isRunning: true,
          lastError: '',
          // #104: the digest clock moves only when a digest was really sent with this launch, and to the
          // moment that digest was read (not to the launch time: what changed in between is still unsent).
          ...(digestAsOf ? { lastDigestAt: digestAsOf } : {}),
        })
        return { sessionId, runId, activeCfg, cfgIdx }
      } catch (err) {
        const errText = err?.message || String(err)
        const classified = classifyModelFailure(errText)
        if (!chiefAgent.autoFallback || !classified.switchable) {
          // Failover decisions above use the raw host text; what the user reads is the readable form.
          const readable = readableLaunchFailure(errText)
          db.updateTopic(userId, profile, topic.id, { isRunning: false, activeRunId: '', lastError: readable })
          throw new Error(readable, { cause: err })
        }
        db.recordConfigFailure(chiefAgent.id, activeCfg.id, classified.category, errText)
        const next = selectNextFallbackConfig({
          agent: chiefAgent,
          failedConfigId: activeCfg.id,
          cooldowns: db.listAgentCooldowns(chiefAgent.id),
        })
        if (!next) {
          const readable = readableLaunchFailure(errText)
          db.updateTopic(userId, profile, topic.id, { isRunning: false, activeRunId: '', lastError: `主备模型均不可用：${readable}` })
          throw new Error(readable, { cause: err })
        }
        const notice = `${formatConfigLabel(activeCfg, cfgIdx)} 异常（${classified.label}），已自动切换至 ${formatConfigLabel(next.config, next.index)} 继续执行。`
        db.addTopicMessage(userId, profile, topic.id, { kind: 'system', text: notice, progressNotice: notice })
        activeCfg = next.config
        cfgIdx = next.index
        sessionId = ''
        needFreshSession = true
      }
    }
    throw new Error('总管所有主备模型配置均已耗尽')
  }

  async function isTopicCurrentlyBusy(run, topic) {
    if (!topic) return false
    const sid = topic.chiefSessionId
    if (topic.isRunning || (sid && sessionActivity.get(sid)?.running)) {
      if (sid && typeof run?.host?.sessions?.connect === 'function') {
        const live = await probeSessionWorking(run, sid, { timeoutMs: 700 }).catch(() => null)
        if (live?.known && !live.isWorking) {
          sessionActivity.delete(sid)
          db.updateTopic(run.identity.userId, run.identity.profile, topic.id, { isRunning: false, activeRunId: '' })
          return false
        }
      }
      return true
    }
    if (sid && typeof run?.host?.sessions?.connect === 'function') {
      const live = await probeSessionWorking(run, sid, { timeoutMs: 500 }).catch(() => null)
      if (live?.known && live.isWorking) {
        sessionActivity.set(sid, {
          running: true,
          startedAt: live.runStartedAt || Date.now(),
          updatedAt: Date.now(),
          activeTool: '',
          toolCount: 0,
          stage: 'running',
        })
        db.updateTopic(run.identity.userId, run.identity.profile, topic.id, { isRunning: true })
        return true
      }
    }
    return false
  }

  // ---- 0.9.43: Chief context view, manual compression and slash-command bookkeeping ----
  // The plugin never compresses anything itself: the page sends the host's own `/compress` (or any other
  // migrated command) over its live session handle. The server only answers what the page needs to decide
  // (context window, whether the host dispatches commands for this session), holds a lock so no Chief turn
  // starts mid-compression, and writes the command result into the topic.

  // Host session sources whose input the chat-run socket parses as slash commands (host `lbt`).
  const COMMAND_SOURCES = new Set(['cli', 'global_agent', 'workflow', 'group_chat'])
  const COMPRESS_COMMANDS = new Set(['compress', 'compact'])
  // Capsule threshold when the host config cannot be read (the value configured on this machine).
  const DEFAULT_COMPRESS_THRESHOLD = 0.65

  function compressLockOf(topicId) {
    const lock = compressLocks.get(topicId)
    if (!lock) return null
    if (lock.until <= Date.now()) {
      compressLocks.delete(topicId)
      return null
    }
    return lock
  }

  function isTopicCompressing(topicId) {
    return Boolean(compressLockOf(topicId))
  }

  // The promise's value, or `fallback` after `ms` (the call never waits longer than that).
  async function valueWithin(promise, ms, fallback) {
    const result = await withinBudget(settled(() => promise), ms)
    return result && result.ok ? result.value : fallback
  }

  function commandChannelOf(sessionDetail) {
    const rec = sessionDetail?.session && typeof sessionDetail.session === 'object' ? sessionDetail.session : sessionDetail
    const source = typeof rec?.source === 'string' ? rec.source : ''
    if (!source) return { channel: 'unknown', reason: '宿主没有返回会话来源，首次使用时会先发 /context 探测' }
    if (COMMAND_SOURCES.has(source)) return { channel: 'ready', reason: '' }
    // Ekko-agent sessions get their own host command path (it answered /status, /compress, /context in a
    // live probe); the page still probes with /context before compressing.
    if (source === 'builtin_agent') return { channel: 'unknown', reason: '' }
    return { channel: 'unsupported', reason: `大总管会话来源是 ${source}，宿主只对 Hermes 会话解析斜杠命令` }
  }

  async function getTopicContext(run, { topicId }) {
    const { userId, profile } = run.identity
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic) throw new Error(`Topic not found: ${topicId}`)
    const lock = compressLockOf(topic.id)
    const out = {
      topicId: topic.id,
      sessionId: topic.chiefSessionId || '',
      contextWindow: 0,
      model: '',
      provider: '',
      commandChannel: 'unknown',
      reason: '',
      compressionThreshold: DEFAULT_COMPRESS_THRESHOLD,
      thresholdSource: 'fallback',
      compressingSince: lock ? lock.since : 0,
    }
    if (!topic.chiefSessionId) {
      out.commandChannel = 'unsupported'
      out.reason = '这个话题还没有大总管会话，先发一条消息'
      return out
    }
    const detail = await valueWithin(run.host.sessions.get(topic.chiefSessionId), 3000, null)
    const rec = detail?.session && typeof detail.session === 'object' ? detail.session : detail
    out.model = typeof rec?.model === 'string' ? rec.model.slice(0, 200) : ''
    out.provider = typeof rec?.provider === 'string' ? rec.provider.slice(0, 200) : ''
    const channel = commandChannelOf(detail)
    out.commandChannel = channel.channel
    out.reason = channel.reason
    if (typeof run.host.request === 'function') {
      const query = {}
      if (out.model) query.model = out.model
      if (out.provider) query.provider = out.provider
      // Only the `compression` section of the host config is read (no other section, no secrets).
      const [res, cfg] = await Promise.all([
        valueWithin(run.host.request('/api/studio/sessions/context-length', { query }), 3000, null),
        valueWithin(run.host.request('/api/hermes/config', { query: { section: 'compression' } }), 3000, null),
      ])
      const len = Number(res?.context_length ?? res?.contextLength ?? 0)
      if (Number.isFinite(len) && len > 0) out.contextWindow = Math.floor(len)
      const section = cfg?.compression
      if (section && typeof section === 'object' && !Array.isArray(section)) {
        // Same reading as the host: a missing or non-numeric threshold is 0.5, the value is kept in 0.05–0.95.
        const t = Number(section.threshold)
        out.compressionThreshold = Number.isFinite(t) && section.threshold !== null && section.threshold !== '' ? Math.min(0.95, Math.max(0.05, t)) : 0.5
        out.thresholdSource = 'host'
      }
    }
    return out
  }

  // Take the lock for a manual compression. Refused (with the reason) whenever the host would refuse it too:
  // the host only compresses an idle session (`isWorking || isCompressing`).
  async function beginTopicCompress(run, { topicId }) {
    const { userId, profile } = run.identity
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic) throw new Error(`Topic not found: ${topicId}`)
    if (!topic.chiefSessionId) throw new Error('这个话题还没有大总管会话，没有可压缩的上下文')
    if (isTopicCompressing(topic.id)) throw new Error('上下文正在压缩，请等它完成')
    if (launchingTopics.has(topic.id) || drainingTopics.has(topic.id)) throw new Error('大总管正在启动新一轮，结束后再压缩')
    const busy = await valueWithin(isTopicCurrentlyBusy(run, topic), 1500, true)
    if (busy) throw new Error('大总管正在运行，等这一轮结束后再压缩')
    // The probe awaited: check again before taking the lock.
    if (isTopicCompressing(topic.id) || launchingTopics.has(topic.id)) throw new Error('大总管正在启动新一轮，结束后再压缩')
    const now = Date.now()
    const lock = { since: now, until: now + COMPRESS_LOCK_MS, lockId: randomBytes(8).toString('hex') }
    compressLocks.set(topic.id, lock)
    emitUpdated(run, `topic.compress.started:${topic.id}`)
    return { ok: true, topicId: topic.id, since: lock.since, until: lock.until, lockId: lock.lockId }
  }

  function describeCommandResult({ command, ok, outcome, message, beforeTokens, afterTokens, compressed }) {
    const name = `/${command}`
    const detail = String(message || '').trim()
    if (COMPRESS_COMMANDS.has(command)) {
      if (ok && compressed === false) return '上下文没有可压缩的内容，宿主未改动'
      if (ok && Number(beforeTokens) > 0 && Number(afterTokens) >= 0) {
        return `上下文已压缩：${Number(beforeTokens)} → ${Number(afterTokens)} tokens`
      }
      if (ok) return detail ? `上下文已压缩：${detail}` : '上下文已压缩'
      if (outcome === 'timeout') return '压缩超时，上下文未变，可重试'
      if (outcome === 'unsupported') return `当前大总管会话不支持手动压缩：${detail || '宿主没有分发命令'}`
      return detail ? `压缩失败，上下文未变，可重试：${detail}` : '压缩失败，上下文未变，可重试'
    }
    if (outcome === 'unsupported') return `${name} 不可用：${detail || '宿主没有分发命令'}`
    if (outcome === 'timeout') return `${name} 没有收到宿主回包`
    return ok ? `${name}：${detail || '已执行'}` : `${name} 失败：${detail || '宿主拒绝了这条命令'}`
  }

  // Write the outcome of a slash command into the topic as a system message; a compress outcome also ends
  // the lock. Safe to call more than once for the same compression (the lock is just gone the second time).
  async function recordTopicCommand(run, input) {
    const { userId, profile } = run.identity
    const topic = db.getTopic(userId, profile, input.topicId)
    if (!topic) throw new Error(`Topic not found: ${input.topicId}`)
    const command = String(input.command || '').toLowerCase()
    // Only the holder releases the lock: a record without the lockId (a probe that failed before any lock was
    // taken) or with an older one (a stale tab, a late answer) leaves it to its holder or to its expiry.
    const held = compressLocks.get(topic.id)
    if (COMPRESS_COMMANDS.has(command) && held && input.lockId && input.lockId === held.lockId) compressLocks.delete(topic.id)
    const text = describeCommandResult({
      command,
      ok: Boolean(input.ok),
      outcome: input.outcome || (input.ok ? 'completed' : 'failed'),
      message: String(input.message || '').slice(0, 2000),
      beforeTokens: input.beforeTokens,
      afterTokens: input.afterTokens,
      compressed: input.compressed,
    })
    db.addTopicMessage(userId, profile, topic.id, { kind: 'system', text, progressNotice: text })
    emitUpdated(run, `topic.command.recorded:${topic.id}`)
    return getSnapshot(run)
  }

  async function executeTopicTurnNow(run, { userId, profile, topic, cleanText, attachments = [], mentionedAgentIds = [], isWake = false, recordHumanBubble = true, clientNonce = '', firstMessage = null, bubbleRef = null }) {
    const launchStartedAt = Date.now()
    try {
      return await executeTopicTurnInner(run, { userId, profile, topic, cleanText, attachments, mentionedAgentIds, isWake, recordHumanBubble, clientNonce, firstMessage, bubbleRef })
    } finally {
      launchingMessages.delete(topic.id)
      warnSlowLaunch('Chief turn', launchStartedAt, { topicId: topic.id })
    }
  }

  // `bubbleRef.id` gets the id of the user bubble stored here ('' when none was stored), also when the launch
  // then fails, so the caller can take the bubble back or write the reason on it.
  async function executeTopicTurnInner(run, { userId, profile, topic, cleanText, attachments = [], mentionedAgentIds = [], isWake = false, recordHumanBubble = true, clientNonce = '', firstMessage = null, bubbleRef = null }) {
    // `firstMessage` is given by a caller that stored the user bubble itself before calling.
    const isFirstMessage = typeof firstMessage === 'boolean' ? firstMessage : (!isWake && topic.messages.length === 0)
    // 0.9.42: the user's message is stored and announced before anything slow (engine probe, host memory,
    // session launch), so the page shows it at once and a failed launch cannot lose it.
    // #105: a user message re-arms the automatic resumes, but never resets the idle count (only output does).
    if (!isWake) { db.setTopicChiefIdle(userId, profile, topic.id, { resumes: 0, exhaustedNoticed: false }); chiefToolsMissingNoticed.delete(topic.id) }
    if (!isWake && recordHumanBubble) {
      const storedId = db.addTopicMessage(userId, profile, topic.id, { kind: 'human', text: cleanText, attachments, clientNonce })
      if (bubbleRef) bubbleRef.id = storedId
      if (storedId) launchingMessages.set(topic.id, storedId)
      if (storedId) emitUpdated(run, `topic.message.accepted:${topic.id}`)
    }
    // #125: the message this turn answers: the bubble stored above, or the one the caller stored itself
    // (both leave their id in launchingMessages). A wake turn answers no user message.
    setTurnMessage(topic.id, isWake ? '' : launchingMessages.get(topic.id))
    if (!isWake && !topic.isUserNamed && (isFirstMessage || topic.title === '新话题')) {
      const provisional = distillProvisionalTitle(cleanText)
      topic = db.updateTopic(userId, profile, topic.id, { title: provisional, isUserNamed: false })
    }

    const liveEngines = await probeLiveEngines(run)
    const settings = db.getSettings(userId, profile, config)
    const chiefAgent = resolveChiefAgent(userId, profile, liveEngines)
    const projects = db.listProjects(userId, profile)
    const agents = db.listAgents(userId, profile)
    const activeProject = projects.find(p => p.id === topic.projectId) || projects[0] || null

    let promptToSend = cleanText
    const digest = collectTopicDigest(userId, profile, topic)
    if (!isWake) {
      // Resolve explicitly @-mentioned Agents (from picker IDs + inline @Name detection)
      const mentionedSet = new Set(Array.isArray(mentionedAgentIds) ? mentionedAgentIds.map(String) : [])
      for (const ag of agents) {
        if (ag.name && cleanText.includes(`@${ag.name}`)) mentionedSet.add(ag.id)
      }
      const mentionedAgents = agents.filter(a => mentionedSet.has(a.id))
      const mentionPrefix = mentionedAgents.length
        ? `[用户 @ 提及的 Agent：${mentionedAgents.map(a => `${a.name}(id=${a.id}, 职责=${a.roleLabel || a.role}, 引擎=${a.engine}${a.model ? `/${a.model}` : ''})`).join('；')}]\n请按用户意图优先派工、协同或调整上述被 @ 的 Agent。\n\n`
        : ''

      promptToSend = formatTodoDigest(digest.rows) + mentionPrefix + cleanText
    } else {
      // #104: a queued wake carries no digest of its own (see maybeWakeChief); the turn that delivers the
      // queue gets the digest once, however many wakes were merged into it.
      promptToSend = formatTodoDigest(digest.rows) + cleanText
    }

    const activeTodos = todosManagedByTopic(topic, db.listTodos(userId, profile)).filter(t => t.phase !== 'done' && t.phase !== 'closed')
    const memories = collectRelevantMemories(userId, profile, {
      projectId: activeProject?.id || '',
      agentId: chiefAgent.id,
      includeChief: true,
    })
    let hostMemorySnippet = ''
    if (settings.chiefAuthority?.injectHostMemory && chiefAgent.memoryEnabled) {
      const hm = await readHostMemory(run)
      if (hm.available && hm.memory) hostMemorySnippet = hm.memory.slice(0, 1200)
    }

    const instructions = buildChiefInstructions({
      topic,
      firstCardBinds: topicBindsOnFirstCard(topic),
      projects,
      agents,
      activeTodos,
      chiefAgent,
      settings,
      memories,
      hostMemorySnippet,
    })

    const { activeCfg } = await launchChiefRunWithFailover(run, {
      userId,
      profile,
      topic,
      chiefAgent,
      promptText: promptToSend,
      attachments,
      instructions,
      activeProject,
      digestAsOf: digest.asOf,
    })

    if (!isWake && !topic.isUserNamed && isFirstMessage) {
      void maybeAutoGenerateTopicTitle(run, userId, profile, topic.id, cleanText, activeCfg).catch(err => {
        log?.warn?.(`话题标题生成失败，保留临时标题：${err?.message || String(err)}`, { topicId: topic.id })
      })
    }
    emitUpdated(run, `topic.run.started:${topic.id}`)
  }

  async function drainTopicQueue(run, userId, profile, topicId) {
    if (!topicId || drainingTopics.has(topicId) || launchingTopics.has(topicId)) return false
    // 0.9.43: queued items wait until a manual compression of this Chief session has ended.
    if (isTopicCompressing(topicId)) return false
    drainingTopics.add(topicId)
    launchingTopics.add(topicId)
    try {
      const topic = db.getTopic(userId, profile, topicId)
      if (!topic || topic.archived) return false
      if (topic.isRunning || (topic.chiefSessionId && sessionActivity.get(topic.chiefSessionId)?.running)) {
        return false
      }
      const queued = db.listTopicQueue(userId, profile, topicId)
      if (!queued.length) return false

      const first = queued[0]
      const retryAfter = queueRetryAfter.get(first.id) || 0
      if (retryAfter > Date.now()) return false

      // Coalesce consecutive automated wake prompts into a single clean Chief wake turn
      const batch = []
      if (first.kind === 'wake') {
        for (const q of queued) {
          if (q.kind !== 'wake') break
          batch.push(q)
        }
      } else {
        batch.push(first)
      }
      // Take the items out while launching (so a concurrent tick cannot double-send them),
      // and put them back with their original order if the launch fails.
      for (const q of batch) db.removeTopicQueueItem(userId, profile, topicId, q.id)

      const attempts = queueAttempts.get(first.id) || 0
      const bubbleRef = { id: '' }
      try {
        if (first.kind === 'wake') {
          const mergedWakeText = batch.length === 1
            ? batch[0].text
            : `Automated consolidated wake notices (${batch.length} task updates arrived while you were busy):\n\n${batch.map((w, i) => `--- Update #${i + 1} ---\n${w.text}`).join('\n\n')}`
          await executeTopicTurnNow(run, {
            userId,
            profile,
            topic,
            cleanText: mergedWakeText,
            attachments: [],
            mentionedAgentIds: [],
            isWake: true,
          })
        } else {
          await executeTopicTurnNow(run, {
            userId,
            profile,
            topic,
            cleanText: first.text,
            attachments: first.attachments || [],
            mentionedAgentIds: first.mentionedAgentIds || [],
            isWake: false,
            // Written on every attempt: a failed attempt takes its bubble back (see the catch below).
            recordHumanBubble: true,
            clientNonce: first.clientNonce || '',
            bubbleRef,
          })
        }
        for (const q of batch) { queueAttempts.delete(q.id); queueRetryAfter.delete(q.id) }
        return true
      } catch (err) {
        const errText = err?.message || String(err)
        const nextAttempt = attempts + 1
        const preview = first.kind === 'wake' ? '任务进度通知' : `「${String(first.text).slice(0, 40)}」`
        // 0.9.42: a message is a bubble or a queued follow-up, never both. Going back to the queue takes the
        // bubble of this attempt away; giving up keeps the bubble and writes the reason on it.
        if (bubbleRef.id) {
          if (nextAttempt < MAX_QUEUE_DELIVERY_ATTEMPTS) db.removeTopicMessage(userId, profile, topicId, bubbleRef.id)
          else db.setTopicMessageSendError(userId, profile, topicId, bubbleRef.id, errText)
        }
        if (nextAttempt < MAX_QUEUE_DELIVERY_ATTEMPTS) {
          for (const q of batch) {
            db.enqueueTopicItem(userId, profile, topicId, { ...q, createdAt: q.createdAt })
            queueAttempts.set(q.id, nextAttempt)
            queueRetryAfter.set(q.id, Date.now() + 30000 * nextAttempt)
          }
          db.addTopicMessage(userId, profile, topicId, {
            kind: 'system',
            text: `排队中的${preview}没能发给大总管（${errText.slice(0, 120)}），已放回队首，${30 * nextAttempt} 秒后重试。`,
            progressNotice: `排队消息发送失败，第 ${nextAttempt} 次`,
          })
        } else {
          for (const q of batch) { queueAttempts.delete(q.id); queueRetryAfter.delete(q.id) }
          db.addTopicMessage(userId, profile, topicId, {
            kind: 'system',
            text: `排队中的${preview}连续 ${MAX_QUEUE_DELIVERY_ATTEMPTS} 次没能发给大总管（${errText.slice(0, 120)}），已移出队列，请检查模型配置后重新发送。`,
            progressNotice: '排队消息未送达',
          })
        }
        emitUpdated(run, `topic.queue.delivery_failed:${topicId}`)
        log?.warn?.('drainTopicQueue launch failed', { topicId, attempt: nextAttempt, error: errText })
        return false
      }
    } catch (err) {
      log?.warn?.('drainTopicQueue failed', { topicId, error: err?.message || String(err) })
      return false
    } finally {
      drainingTopics.delete(topicId)
      launchingTopics.delete(topicId)
    }
  }

  async function sendTopicMessage(run, { topicId, text = '', attachments: rawAttachments = [], mentionedAgentIds = [], interrupt = false, clientNonce = '' }) {
    const { userId, profile } = run.identity
    adoptOrphanTopics(run, userId, profile)
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic) throw new Error(`Topic not found: ${topicId}`)

    const attachments = sanitizeChatAttachments(rawAttachments, dataDir)
    const rawText = String(text || '').trim()
    const cleanText = rawText || (attachments.length
      ? `请查看我上传的 ${attachments.length} 个附件（${attachments.map(a => a.name).join('、')}）`
      : '')
    if (!cleanText) throw new Error('Message text or attachment is required')

    // The same send delivered twice (edge retry, caller timeout, double submit) is stored and executed once:
    // while the first delivery is still being handled, and after it was stored.
    const nonce = String(clientNonce || '')
    const inflightKey = nonce ? `${topic.id}:${nonce}` : ''
    if (inflightKey && inflightSends.has(inflightKey)) return getSnapshot(run)
    if (nonce && db.hasTopicSendNonce(userId, profile, topic.id, nonce)) return getSnapshot(run)

    const enqueue = () => {
      const stored = db.enqueueTopicItem(userId, profile, topic.id, {
        kind: 'user',
        text: cleanText,
        attachments,
        mentionedAgentIds: Array.isArray(mentionedAgentIds) ? mentionedAgentIds.map(String) : [],
        clientNonce: nonce,
      })
      // null: this topic already queues that nonce, nothing new to announce.
      if (stored) emitUpdated(run, `topic.message.queued:${topic.id}`)
    }

    // 0.9.43: the host is compressing this Chief session: no turn may start, the message waits in the queue
    // (also with interrupt: stopping does not abort a compression) and is drained once the lock ends.
    if (isTopicCompressing(topic.id)) {
      enqueue()
      return getSnapshot(run)
    }

    // Another send/drain for this topic is mid-launch: queue behind it instead of opening a second Chief run.
    if (launchingTopics.has(topic.id) && !interrupt) {
      enqueue()
      return getSnapshot(run)
    }
    const claimed = !launchingTopics.has(topic.id)
    if (claimed) launchingTopics.add(topic.id)
    if (inflightKey) inflightSends.add(inflightKey)
    let bubbleId = ''
    // False when the topic already holds this nonce as a message: someone else stored it, nothing to start.
    const storeBubble = () => {
      bubbleId = db.addTopicMessage(userId, profile, topic.id, { kind: 'human', text: cleanText, attachments, clientNonce: nonce })
      if (bubbleId) launchingMessages.set(topic.id, bubbleId)
      if (bubbleId) emitUpdated(run, `topic.message.accepted:${topic.id}`)
      return Boolean(bubbleId)
    }
    // 0.9.65: the call waits for the whole delivery. The host handle in `run` is valid only until this call
    // returns (SDK: RunContext host/signal are bound to the call); a launch left running after the answer
    // reached the host with an expired handle and was cancelled ("sessions.run rejected"). The page does not
    // wait on this call (it draws the bubble at once and keeps the composer free).
    const result = await settled(() => deliverSend())
    if (!result.ok) throw result.error
    return getSnapshot(run)

    async function deliverSend() {
      try {
        const isFirstMessage = topic.messages.length === 0
        // 0.9.42: store and announce the user's message before any probe. A topic this process already knows
        // as running is the exception: there the message will most likely be queued, and a queued follow-up
        // is shown in the queue tray, never as a bubble, so the bubble waits for the probe's answer.
        const knownRunning = Boolean(topic.isRunning || (topic.chiefSessionId && sessionActivity.get(topic.chiefSessionId)?.running))
        if ((!knownRunning || interrupt) && !storeBubble()) return

        const busyNow = await isTopicCurrentlyBusy(run, topic)
        // The probe can take 700 ms: check again that nobody stored this send meanwhile.
        if (!bubbleId && nonce && db.hasTopicSendNonce(userId, profile, topic.id, nonce)) return
        if (busyNow && !interrupt) {
          // Serialized queue: never fire a second concurrent Chief command while turn 1 is still executing.
          // A run started outside this plugin was found by the probe: the bubble becomes a queued follow-up.
          if (bubbleId) db.removeTopicMessage(userId, profile, topic.id, bubbleId)
          launchingMessages.delete(topic.id)
          enqueue()
          return
        }

        if (busyNow && interrupt) {
          if (topic.chiefSessionId) {
            await run.host.sessions.stop(topic.chiefSessionId).catch(() => {})
            sessionActivity.delete(topic.chiefSessionId)
          }
          db.updateTopic(userId, profile, topic.id, { isRunning: false, activeRunId: '' })
        }

        if (!bubbleId && !storeBubble()) return
        const freshTopic = db.getTopic(userId, profile, topic.id)
        try {
          await executeTopicTurnNow(run, {
            userId,
            profile,
            topic: freshTopic,
            cleanText,
            attachments,
            mentionedAgentIds,
            isWake: false,
            recordHumanBubble: false,
            firstMessage: isFirstMessage,
          })
        } catch (err) {
          // The message stays; the reason the Chief did not get it is written on it.
          const errText = err?.message || String(err)
          db.setTopicMessageSendError(userId, profile, topic.id, bubbleId, errText)
          emitUpdated(run, `topic.message.failed:${topic.id}`)
          log?.warn?.('Chief launch failed for a sent message', { topicId: topic.id, error: errText })
          throw err
        }
      } finally {
        if (claimed) launchingTopics.delete(topic.id)
        if (inflightKey) inflightSends.delete(inflightKey)
        if (bubbleId && launchingMessages.get(topic.id) === bubbleId) launchingMessages.delete(topic.id)
      }
    }
  }

  async function cancelTopicQueueItem(run, { topicId, itemId }) {
    const { userId, profile } = run.identity
    db.removeTopicQueueItem(userId, profile, topicId, itemId)
    emitUpdated(run, `topic.queue.cancelled:${topicId}`)
    return getSnapshot(run)
  }

  async function promoteTopicQueueItem(run, { topicId, itemId }) {
    const { userId, profile } = run.identity
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic) throw new Error(`Topic not found: ${topicId}`)
    const queued = db.listTopicQueue(userId, profile, topicId)
    const target = queued.find(q => q.id === itemId)
    if (!target) return getSnapshot(run)
    if (isTopicCompressing(topic.id)) throw new Error('上下文正在压缩，压缩完成后会自动执行排队消息')
    db.removeTopicQueueItem(userId, profile, topicId, itemId)
    const claimed = !launchingTopics.has(topic.id)
    if (claimed) launchingTopics.add(topic.id)
    const bubbleRef = { id: '' }
    // Same budget as a send: the call answers, the launch goes on and reports through board.updated.
    const work = settled(async () => {
      try {
        if (topic.chiefSessionId) {
          await run.host.sessions.stop(topic.chiefSessionId).catch(() => {})
          sessionActivity.delete(topic.chiefSessionId)
        }
        db.updateTopic(userId, profile, topic.id, { isRunning: false, activeRunId: '' })
        const fresh = db.getTopic(userId, profile, topic.id)
        await executeTopicTurnNow(run, {
          userId,
          profile,
          topic: fresh,
          cleanText: target.text,
          attachments: target.attachments || [],
          mentionedAgentIds: target.mentionedAgentIds || [],
          isWake: target.kind === 'wake',
          clientNonce: target.clientNonce || '',
          bubbleRef,
        })
      } catch (err) {
        // Back to the queue so the user's message is not lost, and only there: the bubble of this attempt
        // is taken away first.
        if (bubbleRef.id) db.removeTopicMessage(userId, profile, topic.id, bubbleRef.id)
        db.enqueueTopicItem(userId, profile, topic.id, { ...target, createdAt: target.createdAt })
        if (target.kind !== 'wake') queueAttempts.set(target.id, Math.max(1, queueAttempts.get(target.id) || 0))
        emitUpdated(run, `topic.queue.delivery_failed:${topic.id}`)
        log?.warn?.('Chief launch failed for a promoted queue item', { topicId: topic.id, error: err?.message || String(err) })
        throw err
      } finally {
        if (claimed) launchingTopics.delete(topic.id)
      }
    })
    // 0.9.65: waited for in full, like a send (the host handle ends with this call).
    const result = await work
    if (!result.ok) throw result.error
    return getSnapshot(run)
  }

  const chiefPollStrikes = new Map() // `${sessionId}:${turnStartedAt}` -> count
  const CHIEF_POLL_WARN_PREFIX = '⚠️ 大总管正在轮询等待'
  const CHIEF_POLL_STOP_PREFIX = '已自动结束大总管的轮询等待'

  function isShellToolName(toolName) {
    const lower = String(toolName || '').toLowerCase()
    return /^(terminal|bash|shell|exec|execute_code|process)$/.test(lower) || lower.includes('terminal')
  }

  async function readLatestToolCallArgs(run, sessionId) {
    const res = await run.host.sessions.messages(sessionId, { limit: 4 }).catch(() => null)
    const list = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : [])
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const calls = list[i]?.tool_calls
      if (Array.isArray(calls) && calls.length) {
        return calls.map(c => String(c?.function?.arguments || c?.arguments || '')).join('\n')
      }
    }
    return ''
  }

  function isChiefBusyPollCall(toolName, rawArgs) {
    const args = String(rawArgs || '')
    if (!isShellToolName(toolName)) return false
    // Only real waiting counts: a long sleep, a sleep inside a loop, or watch / tail -f.
    // One-off reads (git log, grep, a quick sqlite query) are not busy-waits.
    const sleeps = [...args.matchAll(/\bsleep\s+(\d+)/g)].map(m => Number(m[1]))
    if (sleeps.some(n => n >= 20)) return true
    if (sleeps.length && /\b(while|until|for)\b[\s\S]*\bdo\b/.test(args)) return true
    if (/\bwatch\s+-n\b|\btail\s+-[A-Za-z]*f\b/.test(args)) return true
    return false
  }

  const CHIEF_EMPTY_REPLY_PREFIX = '总管模型返回了空回复'

  // A completed turn whose transcript ends on a tool result (or an empty assistant message) means the
  // model gave up — e.g. repeated empty responses from the provider. Surface it instead of going silent.
  async function chiefTurnEndedWithoutReply(run, sessionId) {
    const res = await run.host.sessions.messages(sessionId, { limit: 6 }).catch(() => null)
    const list = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : [])
    if (!list.length) return false
    const last = list[list.length - 1]
    if (last?.role === 'tool') return true
    if (last?.role === 'assistant') {
      const hasCalls = Array.isArray(last.tool_calls) && last.tool_calls.length > 0
      return !hasCalls && isHostEmptyPlaceholder(last.content)
    }
    return false
  }

  async function handleChiefBusyPoll(run, matchedTopic, sessionId, turnStartedAt) {
    const key = `${sessionId}:${turnStartedAt}`
    const { userId, profile, topicId } = matchedTopic
    // Strikes survive plugin reloads: count the warnings at the tail of the topic. Any other message
    // (user input, wake notice, stop notice) marks a new turn and resets the count.
    const msgs = db.getTopic(userId, profile, topicId)?.messages || []
    let persistedWarnings = 0
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (!String(msgs[i]?.text || '').startsWith(CHIEF_POLL_WARN_PREFIX)) break
      persistedWarnings += 1
    }
    const strikes = Math.max((chiefPollStrikes.get(key) || 0), persistedWarnings) + 1
    chiefPollStrikes.set(key, strikes)
    if (chiefPollStrikes.size > 200) chiefPollStrikes.delete(chiefPollStrikes.keys().next().value)
    // If the topic has unfinished todos, a wake is guaranteed (they get auto-watched below), so waiting
    // gains nothing: end the turn on the first sleep. Only warn when there is nothing to wake on.
    const hasPendingTodos = db.listTodos(userId, profile).some(td => td.topicId === topicId && !['done', 'closed'].includes(td.phase))
    if (strikes < 2 && !hasPendingTodos) {
      const msg = `${CHIEF_POLL_WARN_PREFIX}（sleep 循环），会长时间占用对话。任务有进展会自动唤醒总管；再轮询一次将自动结束本轮。`
      db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: msg, progressNotice: msg })
      emitUpdated(run, `chief.poll.warn:${topicId}`)
      return
    }
    // Stop the busy-wait turn; watched todos will wake the Chief on change.
    if (String(msgs[msgs.length - 1]?.text || '').startsWith(CHIEF_POLL_STOP_PREFIX)) {
      await run.host.sessions.stop(sessionId).catch(() => {})
      return
    }
    const topic = db.getTopic(userId, profile, topicId)
    for (const td of db.listTodos(userId, profile)) {
      if (td.topicId === topicId && !['done', 'closed'].includes(td.phase)) {
        watchOwnTopic(userId, profile, td, 'Auto-watch after stopping Chief busy-poll')
      }
    }
    await run.host.sessions.stop(sessionId).catch(() => {})
    sessionActivity.delete(sessionId)
    db.updateTopic(userId, profile, topicId, { isRunning: false, activeRunId: '' })
    const msg = `${CHIEF_POLL_STOP_PREFIX}：不必干等，任务有进展会自动唤醒总管继续。`
    db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: msg, progressNotice: msg })
    chiefPollStrikes.delete(key)
    emitUpdated(run, `chief.poll.stopped:${topic?.id || topicId}`)
    await drainTopicQueue(run, userId, profile, topicId).catch(() => {})
  }

  // ── Chief loop guard ────────────────────────────────────────────────────────────────────────────
  // The host annotates repeated tool results but does not end the turn, so a Chief that keeps announcing
  // the same step while only re-reading tool schemas spins for minutes. Detection lives in
  // ../shared/loop-guard.mjs; here the turn is stopped, a notice is stored and the topic is freed.
  const chiefDescribeStreak = new Map() // sessionId -> schema reads in a row seen through tool events
  const chiefLoopStopped = new Map() // sessionId -> stoppedAt; cleared when that session starts or ends a run
  const chiefRunStartSeen = new Set() // sessions whose current run started while this process was loaded

  // 0.9.44 (#33): Chief sessions with a run under way, as seen through host chat events. A create_todo tool
  // call carries no identity.sessionId, so the topic of the calling Chief is taken from here. Only sessions
  // that are a topic's chiefSessionId are recorded (build, review and plain chat sessions never are). In
  // memory only: after a plugin reload the next tool event of a running Chief records it again.
  const activeChiefRuns = new Map() // sessionId -> { startedAt, lastSeenAt }
  const ACTIVE_CHIEF_RUN_TTL_MS = 6 * 60 * 60 * 1000
  const ACTIVE_CHIEF_RUN_MAX = 200

  function noteChiefRunActive(sessionId, now, started) {
    const prev = activeChiefRuns.get(sessionId)
    activeChiefRuns.delete(sessionId)
    activeChiefRuns.set(sessionId, { startedAt: started || !prev ? now : prev.startedAt, lastSeenAt: now })
    if (activeChiefRuns.size > ACTIVE_CHIEF_RUN_MAX) activeChiefRuns.delete(activeChiefRuns.keys().next().value)
  }

  // 0.9.45 (#42): the tool each running Chief session started last, from chat.tool.started. With several
  // Chiefs running, "which run started last" says nothing about who is calling; the session that has just
  // started the create-todo tool is the caller. Chief sessions only, in memory only. `at` is read from
  // `clock` (Date.now unless a test supplies one).
  const chiefToolCalls = new Map() // sessionId -> { toolName, at }
  const CALLER_TOOL_WINDOW_MS = 120 * 1000
  // mcp__ekko_todo__ekko_todo__create_utodo, …create_todo, a bare create_utodo / create-todo.
  const CREATE_TODO_TOOL = /create[-_]?utodo|create[-_]?todo/i

  function noteChiefToolCall(sessionId, toolName) {
    const at = clock()
    const prev = chiefToolCalls.get(sessionId)
    // Tools of one batch are announced one after another: a create-todo call that is still open is not
    // replaced by a sibling tool. It goes when the call ends, the run ends or the window passes.
    if (prev && CREATE_TODO_TOOL.test(prev.toolName) && !CREATE_TODO_TOOL.test(toolName) && at - prev.at <= CALLER_TOOL_WINDOW_MS) return
    chiefToolCalls.delete(sessionId)
    chiefToolCalls.set(sessionId, { toolName, at })
    if (chiefToolCalls.size > ACTIVE_CHIEF_RUN_MAX) chiefToolCalls.delete(chiefToolCalls.keys().next().value)
  }

  // #97: tools each session has open, from chat.tool.started / completed / failed of every session (Chief or
  // not). A tool call carries no identity.sessionId, so "is a Chief calling, and which one" is read from here.
  // In memory only; an entry leaves when its call ends, its run starts or ends, or after 120 seconds.
  const openToolCalls = new Map() // sessionId -> Map(toolName -> startedAt)
  const OPEN_TOOL_SESSIONS_MAX = 400

  function noteToolOpened(sessionId, toolName) {
    const tools = openToolCalls.get(sessionId) || new Map()
    openToolCalls.delete(sessionId)
    tools.delete(toolName)
    tools.set(toolName, clock())
    if (tools.size > 32) tools.delete(tools.keys().next().value)
    openToolCalls.set(sessionId, tools)
    if (openToolCalls.size > OPEN_TOOL_SESSIONS_MAX) openToolCalls.delete(openToolCalls.keys().next().value)
  }

  function noteToolClosed(sessionId, toolName) {
    const tools = openToolCalls.get(sessionId)
    if (!tools) return
    if (toolName) tools.delete(toolName)
    else tools.clear()
    if (!tools.size) openToolCalls.delete(sessionId)
  }

  // ── #97 topic / project ownership ────────────────────────────────────────────────────────────────────
  // The invariant: a topic handles cards of its own project only. Every check goes through this predicate.
  // A topic without a project (project_id '') owns no project.
  function topicOwnsProject(topic, projectId) {
    return Boolean(topic && projectId && topic.projectId === projectId)
  }

  // ── #117 one managing topic per card ─────────────────────────────────────────────────────────────────
  // The managing topic of a card is todos.topic_id, and only when that topic is of the card's project (#97).
  // It alone is told about the card (task list, digest, progress notices, wakes) and may act on it. Every
  // other topic of the project reads only. Every check goes through this predicate.
  function topicManagesTodo(topic, todo) {
    const todoTopicId = todo ? (todo.topicId ?? todo.topic_id ?? '') : ''
    return Boolean(topic && todoTopicId && topic.id === todoTopicId && topicOwnsProject(topic, todo.projectId ?? todo.project_id))
  }

  const NOT_MANAGER = 'TODO_TOPIC_NOT_MANAGER'
  // Tools that name a card and stay open to every Chief topic of its project: the three that only read
  // (#125: get_todo_detail, read before a take-over), and watch_todos, which decides in its own handler (it
  // is how a topic takes a card over).
  const TODO_PROJECT_SCOPED_TOOLS = new Set(['get_todo_conversation', 'get_todo_diff', 'get_todo_detail', 'watch_todos'])

  // Refusal text for a topic of the card's project that is not its managing topic.
  function notManagerText(userId, profile, topic, todo) {
    const manager = todo.topicId ? db.getTopic(userId, profile, todo.topicId) : null
    const usable = manager && !manager.archived && topicOwnsProject(manager, todo.projectId)
    const who = usable
      ? `由话题「${manager.title}」（${manager.id}）管理`
      : (manager ? `的管理话题「${manager.title}」（${manager.id}）${manager.archived ? '已归档' : '不属于卡片的项目'}` : (todo.topicId ? `的管理话题 ${todo.topicId} 已不存在` : '还没有管理话题'))
    // #123: the answer names the next call instead of sending the user to the managing topic. A topic that
    // gets this answer is of the card's project already (a topic without a project gets
    // TOPIC_PROJECT_MISMATCH, see takeOverAfterBinding), so set_topic_project is named as not needed.
    const tell = usable ? `只告知它由话题「${manager.title}」管理` : '只告知它目前的管理情况'
    return `卡片 #${todo.number}（${todo.id}）${who}。一张卡同一时刻只有一个管理话题：话题「${topic.title}」（${topic.id}）对它只读（可用 get_todo_detail / get_todo_conversation / get_todo_diff 查看），不能派工、停止、审查、合并、提问或修改，本次未做任何改动。用户在本话题明确要求处理这张卡时：本话题已属于卡片的项目 ${projectLabel(userId, profile, todo.projectId)}，不必再调用 set_topic_project，直接调用 ${takeOverCall(topic, todo)}接管，然后再行动。不得主动接管：用户只是提到这张卡、没有要求在本话题处理它时不要接管，${tell}。接管后管理权转到本话题，原话题不再收到它的进展。`
  }

  // ── #125 the user message a card comes from ──────────────────────────────────────────────────────────
  // topic_messages.todo_id of a user message says which card the message is about, so get_todo_detail can
  // return what the user asked for. It is written from what is known, never guessed from time or wording:
  //   - the message is the one that started the Chief turn of the topic (turnMessages; a wake turn has none);
  //   - the caller of the tool is known to be that topic's Chief: identity.sessionId, or exactly one Chief
  //     session with this tool open under its own name (the standard of #118; a tool_call wrapper, a Chief
  //     that is merely running and several candidates link nothing);
  //   - the card is managed by that same topic (a card that went to another topic is not linked);
  //   - the message is of kind human and not about a card yet (db.linkTopicMessageToTodo).
  // Ordinary chat is never written. Rows stored before this are not touched.
  function setTurnMessage(topicId, messageId) {
    turnMessages.delete(topicId)
    if (!messageId) return
    turnMessages.set(topicId, String(messageId))
    if (turnMessages.size > TURN_MESSAGES_MAX) turnMessages.delete(turnMessages.keys().next().value)
  }

  // The topic and message a card touched by this tool call may be linked to, or null. Reads only.
  function turnMessageOf(run, toolName, callerTopicId = '') {
    const caller = resolveChiefCaller(run, toolName, callerTopicId)
    if (caller.tier !== 'session' && caller.tier !== 'by-name') return null
    if (caller.ambiguous || caller.topics.length !== 1) return null
    const topicId = caller.topics[0].id
    const messageId = turnMessages.get(topicId) || ''
    return messageId ? { topicId, messageId } : null
  }

  // Links the turn's user message to a card the Chief acted on (message_todo: a later instruction of the
  // user for an existing card). Returns the message id when a row was written, else ''.
  function linkTurnMessageToTodo(run, toolName, todoId, callerTopicId = '') {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, String(todoId || ''))
    if (!todo || !todo.topicId) return ''
    const link = turnMessageOf(run, toolName, callerTopicId)
    if (!link || link.topicId !== todo.topicId) return ''
    return db.linkTopicMessageToTodo(userId, profile, link.topicId, link.messageId, todo.id) ? link.messageId : ''
  }

  // #123: the take-over call, written out with the ids to use.
  function takeOverCall(topic, todo) {
    return `watch_todos（topic_id 填 ${topic.id}，todo_id 填 ${todo.id}，take_over: true）`
  }

  // #123: what follows set_topic_project for a topic without a project that was asked to work on a card.
  function takeOverAfterBinding(topic, todo) {
    return `；绑定后这张卡若仍由别的话题管理（${NOT_MANAGER}），且用户确实是在本话题要求处理它，再调用 ${takeOverCall(topic, todo)}接管，然后行动。不得主动接管：用户只是提到这张卡时不要接管；接管后原话题不再收到它的进展`
  }

  function projectLabel(userId, profile, projectId) {
    if (!projectId) return ''
    const p = db.getProject(userId, profile, projectId)
    return p?.name || projectId
  }

  // "属于项目 X" / "未归属任何项目", for messages about a topic.
  function topicProjectPhrase(userId, profile, topic) {
    return topic?.projectId ? `属于项目 ${projectLabel(userId, profile, topic.projectId)}` : '未归属任何项目'
  }

  const TOPIC_REPAIR_BUSY_PHASES = new Set(['building', 'reviewing', 'merging'])
  const TOPIC_REPAIR_BUSY_REASON = '任务正在执行（构建 / 审查 / 合并中），先等当前轮结束或停止后再修'
  // #124: states the fact only. What to do next is said where it is used, by who reads it: the Chief is
  // told to call set_topic_project, the user is told the Chief binds the topic. Neither is sent to the menu.
  const NO_PROJECT_HINT = '本话题还没有绑定项目'

  // Cards of each project in each topic: Map(topicId -> Map(projectId -> { count, latest })).
  function topicTodoTally(userId, profile) {
    const byTopic = new Map()
    for (const row of db.tallyTopicTodoProjects(userId, profile)) {
      if (!byTopic.has(row.topicId)) byTopic.set(row.topicId, new Map())
      byTopic.get(row.topicId).set(row.projectId, { count: row.count, latest: row.latest })
    }
    return byTopic
  }

  // wake_log key that says "the project of this topic was decided once": written when a topic is adopted and
  // when the user sets or clears its project. A topic that has it is never adopted again.
  const topicAdoptKey = topicId => `topic-adopt:${topicId}`

  /**
   * Upgrade path of #97: a topic without a project that holds cards is given the project most of its cards
   * belong to (ties: the project of the card updated last; cards of removed projects do not count), once.
   * One system message is stored in the topic. A topic without cards stays without a project. Called on every
   * snapshot and before every decision that depends on a topic's project, so no stored topic stops working
   * with the upgrade. Returns the adopted topics.
   */
  // The project a topic without a project would be adopted by, from the cards it holds: { best: { project,
  // count, latest }, total }, or null when it holds no card of an existing project. Reads only.
  function plannedAdoption(userId, profile, topicId, tally) {
    const counts = tally.get(topicId)
    if (!counts) return null
    let best = null
    let total = 0
    for (const [projectId, entry] of counts) {
      total += entry.count
      const project = projectId ? db.getProject(userId, profile, projectId) : null
      if (!project) continue
      if (!best || entry.count > best.count || (entry.count === best.count && entry.latest > best.latest)) best = { project, count: entry.count, latest: entry.latest }
    }
    return best ? { best, total } : null
  }

  function adoptOrphanTopics(run, userId, profile) {
    const orphans = db.listTopicProjectIds(userId, profile).filter(t => !t.projectId)
    if (!orphans.length) return []
    const tally = topicTodoTally(userId, profile)
    const adopted = []
    for (const orphan of orphans) {
      const planned = plannedAdoption(userId, profile, orphan.id, tally)
      if (!planned) continue
      const { best, total } = planned
      const rest = total - best.count
      // #108: the one-time key, the topic's project and the system message are written in one transaction.
      // Before, the key was written first: when the topic write then failed the key stayed and the topic was
      // never adopted. Now a failure writes nothing, the topic stays without a project and the next call
      // tries again; the other topics of this call are not held up by it.
      let claimed = false
      try {
        claimed = db.transaction(() => {
          if (!db.claimWakeKey(topicAdoptKey(orphan.id), '', orphan.id)) return false
          db.updateTopic(userId, profile, orphan.id, { projectId: best.project.id })
          db.addTopicMessage(userId, profile, orphan.id, {
            kind: 'system',
            text: `话题已归属到项目 ${best.project.name}（按其中卡片多数）：本话题 ${total} 张卡片中 ${best.count} 张属于该项目。${rest ? `其余 ${rest} 张属于其他项目，不在本话题处理，可用「修复话题归属」迁到各自项目的话题。` : ''}如需更换，在话题菜单「改挂项目」。`,
            progressNotice: `话题已归属到项目 ${best.project.name}`,
          })
          return true
        })
      } catch (err) {
        log?.warn?.('Adopting a topic without a project failed; nothing was written, it is tried again on the next call', { topicId: orphan.id, projectId: best.project.id, error: err?.message || String(err) })
        continue
      }
      if (!claimed) continue
      log?.info?.('Topic without a project adopted the project of most of its cards', { topicId: orphan.id, projectId: best.project.id, cards: best.count, total })
      adopted.push({ topicId: orphan.id, projectId: best.project.id, cards: best.count, total })
    }
    if (adopted.length && run) emitUpdated(run, `topic.adopted:${adopted[0].topicId}`)
    return adopted
  }

  // Why a topic shows or handles fewer cards than it holds, for the page and for tool answers. null when the
  // topic has a project and every card in it is of that project.
  function topicScopeReasonOf(userId, profile, topic, tally) {
    const counts = tally.get(topic.id) || new Map()
    let todoCount = 0
    let foreignTodoCount = 0
    const foreignProjects = []
    for (const [projectId, entry] of counts) {
      todoCount += entry.count
      if (!topicOwnsProject(topic, projectId)) { foreignTodoCount += entry.count; foreignProjects.push(projectId) }
    }
    if (!topic.projectId) {
      // #118: a topic whose project was never decided is also fixed by the first card its Chief creates.
      const firstCard = topicBindsOnFirstCard(topic) ? `，或直接让总管建第一张卡，话题会自动固定到该卡的项目` : ''
      // #124: read by the user on the page. The Chief binds the topic itself (#121); the menu still works
      // and is no longer what the user is told to do first.
      return { code: 'no-project', message: `${NO_PROJECT_HINT}，总管会根据你说的事判断项目并自动绑定；也可以直接在总管那里说要绑定到哪个项目${firstCard}。绑定前总管不能在这里列卡、派工、审查或合并，也不会被卡片进展唤醒。`, projectId: '', todoCount, foreignTodoCount }
    }
    // Every card in the topic is of one other project: the topic itself was most likely given the wrong
    // project. Said as a suggestion; a project the user set is never changed automatically.
    // #126: the message goes back to the Chief with list_todos, so the first thing named is the tool the
    // Chief calls itself (#121); moving the cards is the second way, the topic menu the last, optional one.
    if (foreignTodoCount && foreignTodoCount === todoCount && foreignProjects.length === 1 && db.getProject(userId, profile, foreignProjects[0])) {
      const other = projectLabel(userId, profile, foreignProjects[0])
      return {
        code: 'foreign-todos',
        message: `本话题属于项目 ${projectLabel(userId, profile, topic.projectId)}，但其中 ${todoCount} 张卡片全部属于项目 ${other}：更可能是话题挂错了项目。由本话题的总管调用 set_topic_project 把本话题改绑到 ${other}（topic_id ${topic.id}，project_id ${foreignProjects[0]}），改绑后这些卡片立即恢复正常；也可用「修复话题归属」（repair-topic-todos）把卡片迁到 ${other} 的其他话题。用户本人也可以在话题菜单「改挂项目」操作。`,
        projectId: topic.projectId,
        todoCount,
        foreignTodoCount,
        suggestedProjectId: foreignProjects[0],
      }
    }
    if (foreignTodoCount) {
      return { code: 'foreign-todos', message: `本话题属于项目 ${projectLabel(userId, profile, topic.projectId)}，其中 ${foreignTodoCount} 张卡片属于其他项目，不在这里处理；可用「修复话题归属」（repair-topic-todos）把它们迁到各自项目的话题。`, projectId: topic.projectId, todoCount, foreignTodoCount }
    }
    return null
  }

  // Read-only view of a card whose topic is not a topic of its project (stored before #97, or the topic was
  // moved to another project or deleted). null when the card is where it belongs.
  function todoTopicMismatch(userId, profile, todo, topicProjectIds = null) {
    if (!todo) return null
    let topicProjectId = ''
    let topicExists = false
    if (todo.topicId) {
      if (topicProjectIds) {
        topicExists = topicProjectIds.has(todo.topicId)
        topicProjectId = topicProjectIds.get(todo.topicId) || ''
      } else {
        const topic = db.getTopic(userId, profile, todo.topicId)
        topicExists = Boolean(topic)
        topicProjectId = topic?.projectId || ''
      }
    }
    if (topicExists && topicOwnsProject({ projectId: topicProjectId }, todo.projectId)) return null
    const busy = TOPIC_REPAIR_BUSY_PHASES.has(todo.phase)
    return {
      todoProjectId: todo.projectId,
      topicProjectId,
      topicId: todo.topicId || '',
      topicExists,
      repairable: !busy,
      reason: busy ? TOPIC_REPAIR_BUSY_REASON : '',
    }
  }

  // pickProjectTopic without creating anything: topicId is '' when a topic would have to be created.
  function planProjectTopic(userId, profile, project, titleSeed) {
    const own = db.listTopics(userId, profile, { includeArchived: false }).filter(t => topicOwnsProject(t, project.id))
    const attended = own.filter(t => t.chiefSessionId).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
    if (attended) return { topicId: attended.id, title: attended.title, unattended: false, created: false }
    if (own[0]) return { topicId: own[0].id, title: own[0].title, unattended: true, created: false }
    return { topicId: '', title: String(titleSeed || project.name || '').slice(0, 32) || '新话题', unattended: true, created: true }
  }

  // A topic of the project for a card: the most recently updated one with a Chief session, else one without,
  // else a new one (Autopilot off). Topics of other projects and topics without a project are never taken.
  function pickProjectTopic(userId, profile, project, titleSeed) {
    const own = db.listTopics(userId, profile, { includeArchived: false }).filter(t => topicOwnsProject(t, project.id))
    const attended = own.filter(t => t.chiefSessionId).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
    if (attended) return { topicId: attended.id, title: attended.title, unattended: false, created: false }
    if (own[0]) return { topicId: own[0].id, title: own[0].title, unattended: true, created: false }
    const made = db.createTopic(userId, profile, { projectId: project.id, title: String(titleSeed || project.name || '').slice(0, 32), autopilot: false })
    return { topicId: made.id, title: made.title, unattended: true, created: true }
  }

  // Watches a card from its own topic; a card whose topic is not of its project is not watched (see maybeWakeChief).
  function watchOwnTopic(userId, profile, todo, reason) {
    if (!todo?.topicId) return false
    if (!topicOwnsProject(db.getTopic(userId, profile, todo.topicId), todo.projectId)) return false
    db.watchTodo(userId, profile, todo.topicId, todo.id, reason)
    return true
  }

  // What a Chief is told about (task list in its instructions, "Since your last turn" digest). #117: the
  // cards its topic manages, not every card of the project: a Chief that is shown another topic's card acts
  // on it. Rows are todos (projectId / topicId) or digest rows (project_id / topic_id). The project's other
  // cards stay readable on demand through list_todos.
  function todosManagedByTopic(topic, rows) {
    return rows.filter(row => topicManagesTodo(topic, row))
  }

  // #104: the digest of a Chief turn and the time it was read. topics.lastDigestAt is set to `asOf` only by
  // the launch that really sent these rows, so a wake that was queued or failed to launch neither loses a
  // batch nor sends it twice. The clock is read from the stored topic (the caller's copy may be older).
  function collectTopicDigest(userId, profile, topic) {
    const asOf = Date.now()
    const since = db.getTopic(userId, profile, topic.id)?.lastDigestAt ?? topic.lastDigestAt
    const rows = todosManagedByTopic(topic, db.getRecentTodoUpdatesSince(userId, profile, since))
    return { rows, asOf }
  }

  const toolNamePattern = toolName => new RegExp(String(toolName).split('_').map(part => part.replace(/[^a-z0-9]/gi, '')).filter(Boolean).join('[-_]?u?'), 'i')

  // #108: whether this session has the tool of the current call open, read from openToolCalls only: under its
  // own name, started at most 120 seconds ago. A tool_call wrapper is no evidence: it shows that the session
  // is calling some tool, not which one, so a Chief busy with another tool behind a wrapper would pass.
  function sessionHasToolOpen(sessionId, pattern, now = clock()) {
    const tools = sessionId ? openToolCalls.get(String(sessionId)) : null
    if (!tools) return false
    for (const [name, at] of tools) {
      if (now - at > CALLER_TOOL_WINDOW_MS) continue
      if (pattern && pattern.test(name)) return true
    }
    return false
  }

  // Which Chief topics may be making this tool call. { by, topics }: topics is empty when the caller is not a
  // Chief (the user, the page, a build / review / plain chat session).
  //   caller-session  identity.sessionId is a topic's Chief session: exactly that topic.
  //   not-chief       identity.sessionId is some other session, or a non-Chief session has this tool open.
  //   caller-tool     no session id: the Chief sessions that have this tool open (by name, else a tool_call wrapper).
  //   active-run      no session id and no open tool seen: the Chief sessions with a run under way.
  // Without a session id several topics can qualify; the caller is then one of them, which one is not known.
  // `tier` (#118) names the evidence the answer rests on: 'session' (identity.sessionId), 'by-name' (this
  // tool open under its own name), 'wrapper' (a tool_call wrapper open: some tool, not known which),
  // 'active-run' (a Chief run under way) or 'none'. `by` is 'caller-tool' for both by-name and wrapper.
  function resolveChiefCaller(run, toolName = '', declaredTopicId = '') {
    const { userId, profile } = run.identity
    adoptOrphanTopics(run, userId, profile)
    const callerSessionId = String(run.identity?.sessionId || '')
    if (callerSessionId) {
      const hit = db.findTopicBySessionId(callerSessionId)
      const topic = hit && hit.userId === userId && hit.profile === profile ? db.getTopic(userId, profile, hit.topicId) : null
      return topic ? { by: 'caller-session', topics: [topic], ambiguous: false, tier: 'session' } : { by: 'not-chief', topics: [], ambiguous: false, tier: 'session' }
    }
    // Without a session id the caller is one of `topics`. `ambiguous`: more than one Chief qualifies, or a
    // Chief and a session that is no Chief do; nothing then says which.
    // #108: caller_topic_id (declared) is the caller's own statement, so it is believed only with evidence
    // that does not come from the caller. It settles the call when the named topic (a) is one of the
    // candidates of this call and (b) its Chief session has this very tool open (openToolCalls). Any other
    // declaration is refused (`declaredUnknown`, `declaredRefusal`: 'not-candidate' | 'no-open-tool') and
    // the call with it — also when the candidates come from tool_call wrappers (the wrapper hides which tool
    // is open) or from running Chiefs only (active-run), where nothing shows who holds this tool, and when
    // there is no candidate at all. So a declaration is believed in the by-name tier only.
    const declared = String(declaredTopicId || '')
    const now = clock()
    const pattern = toolName ? toolNamePattern(toolName) : null
    const settle = (by, topics, other = false, tier = 'none') => {
      if (declared) {
        const named = topics.find(t => t.id === declared)
        const open = Boolean(named) && sessionHasToolOpen(named.chiefSessionId, pattern, now)
        if (named && open) return { by: 'declared', topics: [named], ambiguous: false, tier }
        return { by, topics, ambiguous: true, declaredUnknown: declared, declaredRefusal: named ? 'no-open-tool' : 'not-candidate', tier }
      }
      return { by, topics, ambiguous: topics.length > 1 || (other && topics.length > 0), tier }
    }
    const tiers = { exact: { chiefs: [], other: false }, wrapper: { chiefs: [], other: false } }
    for (const [sessionId, tools] of [...openToolCalls]) {
      let exactAt = 0
      let wrapperAt = 0
      for (const [name, at] of [...tools]) {
        if (now - at > CALLER_TOOL_WINDOW_MS) { tools.delete(name); continue }
        if (pattern && pattern.test(name)) exactAt = Math.max(exactAt, at)
        else if (baseToolName(name) === 'tool_call') wrapperAt = Math.max(wrapperAt, at)
      }
      if (!tools.size) openToolCalls.delete(sessionId)
      if (!exactAt && !wrapperAt) continue
      const tier = exactAt ? tiers.exact : tiers.wrapper
      const hit = db.findTopicBySessionId(sessionId)
      if (!hit) { tier.other = true; continue }
      if (hit.userId !== userId || hit.profile !== profile) continue
      const topic = db.getTopic(userId, profile, hit.topicId)
      if (!topic || topic.archived) continue
      tier.chiefs.push({ topic, at: exactAt || wrapperAt })
    }
    for (const [tierName, tier] of [['by-name', tiers.exact], ['wrapper', tiers.wrapper]]) {
      if (tier.chiefs.length) return settle('caller-tool', tier.chiefs.sort((a, b) => b.at - a.at).map(c => c.topic), tier.other, tierName)
      if (tier.other) return settle('not-chief', [], false, tierName)
    }
    const running = []
    for (const [sessionId, entry] of [...activeChiefRuns]) {
      if (Date.now() - entry.lastSeenAt > ACTIVE_CHIEF_RUN_TTL_MS) continue
      const hit = db.findTopicBySessionId(sessionId)
      if (!hit || hit.userId !== userId || hit.profile !== profile) continue
      const topic = db.getTopic(userId, profile, hit.topicId)
      if (!topic || topic.archived || !topic.isRunning) continue
      running.push({ topic, at: entry.startedAt })
    }
    return settle(running.length ? 'active-run' : 'not-chief', running.sort((a, b) => b.at - a.at).map(c => c.topic), false, running.length ? 'active-run' : 'none')
  }

  // #118: whether the first card created in this topic fixes the topic's project. Only a topic whose project
  // was never decided: not archived, no project, and no topic-adopt row (written when the user sets or
  // clears the project and when the topic is adopted), so a topic the user detached is never bound again.
  function topicBindsOnFirstCard(topic) {
    return Boolean(topic && !topic.archived && !topic.projectId && !db.hasWakeKey(topicAdoptKey(topic.id)))
  }

  // #118: the calling topic a create_todo tool call may bind to the card's project, or null. The caller has
  // to be known, not guessed, because the answer is written into topics.project_id:
  //   - identity.sessionId is that topic's Chief session (tier 'session'); or
  //   - no session id, and exactly one Chief session has create_todo open under its own name while no
  //     session that is no Chief has it open in the same tier (tier 'by-name', not ambiguous).
  // A tool_call wrapper (which tool is open is not known), a Chief that is merely running (active-run) and
  // several candidates never bind; the card then takes the usual way to a topic of its project.
  function firstCardBindTopic(run) {
    const caller = resolveChiefCaller(run, 'create_todo')
    if (caller.tier !== 'session' && caller.tier !== 'by-name') return null
    if (caller.ambiguous || caller.topics.length !== 1) return null
    const topic = caller.topics[0]
    if (!topicBindsOnFirstCard(topic)) return null
    return { topic, resolvedBy: caller.by }
  }

  // #121: set_topic_project. The Chief of a topic binds that topic to a registered project, or moves it to
  // another one, so the user does not have to open the topic menu. #118 binds on the first card only; this
  // covers work on an existing card, a topic on the wrong project and a topic the user detached.
  // Tool path only (no RPC; the page keeps update-topic). Throws a coded error and writes nothing when:
  //   CALLER_AMBIGUOUS       the caller is not known: no session id and not exactly one Chief session with
  //                          this tool open under its own name (a tool_call wrapper, a Chief that is merely
  //                          running, several candidates, a Chief and a session that is no Chief).
  //   NOT_TOPIC_CHIEF        the caller is no Chief session, or topicId is not the caller's own topic.
  //   TOPIC_ARCHIVED         the topic is archived.
  //   PROJECT_NOT_FOUND      projectId is empty or names no registered project (the tool never detaches).
  //   TOPIC_HAS_OTHER_CARDS  the topic has a project and holds a card that is not of the target project:
  //                          moving it would leave that card in a topic that is not of its project.
  // The same project again changes nothing ({ changed: false }). Otherwise one transaction writes the
  // topic-adopt row (kept when it exists: the project of this topic is decided, #118 never binds it again),
  // topics.project_id and one system message. A topic without a project is bound whatever cards it holds:
  // none of them is of the topic's project now, so none is made worse; the message counts those that are
  // not of the new project.
  function setTopicProject(run, { topicId, projectId, reason = '' }) {
    const { userId, profile } = run.identity
    const wantTopicId = String(topicId || '')
    const wantProjectId = String(projectId || '')
    const caller = resolveChiefCaller(run, 'set_topic_project')
    const direct = '请按工具名直接调用 set_topic_project（不要经 tool_call 包装），topic_id 填你自己所在话题的 id（指令里 Current Topic 的 topic_id）；仍被拒绝时再请用户在话题菜单「改挂项目」操作。'
    if (caller.tier !== 'session' && caller.tier !== 'by-name') {
      const why = caller.tier === 'wrapper'
        ? '本次调用经 tool_call 包装发出，包装看不出里面是哪个工具，不能当作调用方的证据'
        : caller.tier === 'active-run' ? '调用未带会话身份，仅凭「有总管正在运行」不能确定是谁在调用' : '调用未带会话身份，也没有看到任何总管会话正开着本工具'
      throw codedError('CALLER_AMBIGUOUS', `无法确定调用方话题，未做任何改动：${why}。话题的项目归属只能由该话题自己的总管修改。${direct}`)
    }
    if (caller.ambiguous || caller.topics.length > 1) {
      const names = caller.topics.slice(0, 6).map(t => `「${t.title}」（${t.id}）`).join('、')
      throw codedError('CALLER_AMBIGUOUS', `无法确定调用方话题，未做任何改动：调用未带会话身份，同时有多个会话正开着本工具（${names}${caller.topics.length > 1 ? '' : ' 与一个非总管会话'}），分不清是谁在调用。请稍后单独重试一次；${direct}`)
    }
    const own = caller.topics[0]
    if (!own) throw codedError('NOT_TOPIC_CHIEF', '未做任何改动：话题的项目归属只能由该话题自己的总管会话修改，本次调用方不是任何话题的总管会话。用户本人可在话题菜单「改挂项目」操作。')
    if (own.id !== wantTopicId) {
      throw codedError('NOT_TOPIC_CHIEF', `未做任何改动：总管只能改自己所在话题的项目归属。你在话题「${own.title}」（${own.id}），不能替话题 ${wantTopicId || '（空）'} 修改；如要改本话题，topic_id 填 ${own.id}。`)
    }
    const topic = own
    if (topic.archived) throw codedError('TOPIC_ARCHIVED', `未做任何改动：话题「${topic.title}」已归档，不能绑定或改绑项目。请让用户先取消归档，或在一个未归档的话题里继续。`)
    const project = wantProjectId ? db.getProject(userId, profile, wantProjectId) : null
    if (!project) {
      const known = db.listProjects(userId, profile).slice(0, 20).map(p => `${p.id}（${p.name}）`).join('、')
      throw codedError('PROJECT_NOT_FOUND', `未做任何改动：项目不存在：${wantProjectId || '（空）'}。project_id 必须是已登记项目的 id${known ? `：${known}` : '，当前还没有登记任何项目'}；可用 list_projects 核对，判断不出是哪个项目时问用户一句。`)
    }
    const previous = topic.projectId ? db.getProject(userId, profile, topic.projectId) : null
    const previousName = topic.projectId ? (previous?.name || topic.projectId) : ''
    if (topic.projectId === project.id) return { topic, project, previousProjectId: topic.projectId, changed: false, foreignTodoCount: 0 }
    const others = db.listTodos(userId, profile)
      .filter(td => td.topicId === topic.id && td.projectId !== project.id)
      .sort((a, b) => a.number - b.number)
    if (topic.projectId && others.length) {
      const numbers = list => `${list.slice(0, 20).map(td => `#${td.number}`).join('、')}${list.length > 20 ? ` 等 ${list.length} 张` : ''}`
      const current = others.filter(td => td.projectId === topic.projectId)
      const third = others.filter(td => td.projectId !== topic.projectId)
      const steps = []
      if (third.length) steps.push(`${numbers(third)} 不属于本话题当前的项目 ${previousName}，请让用户在本话题点「修复话题归属」，把它们迁到各自项目的话题`)
      if (current.length) steps.push(`${numbers(current)} 属于本话题当前的项目 ${previousName}，「修复话题归属」不会迁它们（它只迁不属于话题项目的卡）：先由项目 ${previousName} 的另一个话题接管（在那个话题里调用 watch_todos，take_over: true），或由用户在话题菜单「改挂项目」改到 ${project.name} 后再点「修复话题归属」`)
      throw codedError('TOPIC_HAS_OTHER_CARDS', `未做任何改动：话题「${topic.title}」属于项目 ${previousName}，其中有 ${others.length} 张卡片不属于目标项目 ${project.name}，改绑会让它们留在一个不属于自己项目的话题里。下一步：${steps.join('；')}。卡片迁走后再调用 set_topic_project；如果只是要处理项目 ${project.name} 的事，也可以不改绑。${projectTopicHint(userId, profile, project.id)}。`)
    }
    const why = String(reason || '').trim().slice(0, 500)
    const how = `由总管调用 set_topic_project ${topic.projectId ? '改绑' : '绑定'}${why ? `；原因：${why}` : ''}`
    const lead = topic.projectId ? `话题已从项目 ${previousName} 改绑到项目 ${project.name}` : `话题已绑定到项目 ${project.name}`
    const stray = topic.projectId ? '' : (others.length ? `本话题有 ${others.length} 张卡片不属于该项目，不在本话题处理，可用「修复话题归属」迁到各自项目的话题。` : '')
    // G4: the row, the topic and the message are one transaction; a failure stores none of them.
    db.transaction(() => {
      db.claimWakeKey(topicAdoptKey(topic.id), '', topic.id)
      db.updateTopic(userId, profile, topic.id, { projectId: project.id })
      db.addTopicMessage(userId, profile, topic.id, {
        kind: 'system',
        text: `${lead}（${how}）。之后本话题只处理该项目的卡片；${stray}如挂错，可让总管再次改绑，或在话题菜单「改挂项目」更换。`,
        progressNotice: lead,
      })
    })
    log?.info?.('Topic project set by its Chief', { topicId: topic.id, projectId: project.id, previousProjectId: topic.projectId || '', resolvedBy: caller.by })
    emitUpdated(run, `topic.project.set:${topic.id}`)
    return { topic: db.getTopic(userId, profile, topic.id), project, previousProjectId: topic.projectId || '', previousName, changed: true, foreignTodoCount: topic.projectId ? 0 : others.length }
  }

  // Refusal text when the calling Chief cannot be told apart (see resolveChiefCaller).
  function ambiguousCallerText(caller) {
    const names = caller.topics.slice(0, 6).map(t => `「${t.title}」（${t.id}）`).join('、')
    // #108: a declaration that was not believed. Sending it again changes nothing, so the text does not ask for it.
    if (caller.declaredUnknown) {
      // no-open-tool with candidates from open tools: they come from tool_call wrappers (by-name candidates
      // always have the tool open by name).
      const why = caller.declaredRefusal === 'no-open-tool'
        ? (caller.by === 'caller-tool'
            ? `caller_topic_id ${caller.declaredUnknown} 无法核实：该话题的总管会话是经 tool_call 包装调用的，包装看不出里面是哪个工具，不能当作开着本工具的证据`
            : `caller_topic_id ${caller.declaredUnknown} 无法核实：没有看到该话题的总管会话正开着本工具，仅凭「总管正在运行」不接受自报`)
        : `caller_topic_id ${caller.declaredUnknown} 不是当前可能在调用的总管话题`
      const who = names ? `当前可能的调用方：${names}` : '当前没有可核实的总管调用方'
      return `无法确定调用方话题：${why}。${who}；调用未带会话身份，为避免跨项目、跨话题误操作已拒绝，未做任何改动。caller_topic_id 只能填你自己所在话题的 id（指令里 Current Topic 的 topic_id），且只在看到你的会话按工具名直接开着本工具时才被采信（经 tool_call 包装调用不算）；请改为直呼工具名后重试，仍被拒绝请让用户在页面上操作。`
    }
    return `无法确定调用方话题，请显式传 topic_id（参数 caller_topic_id，填你所在话题的 id，即指令里 Current Topic 的 topic_id）。当前有 ${caller.topics.length} 个总管会话可能是调用方：${names}；调用未带会话身份，为避免跨项目、跨话题误操作已拒绝，未做任何改动。caller_topic_id 只在你的会话按工具名直接开着本工具时才被采信，经 tool_call 包装调用时请改为直呼工具名。`
  }

  // Where a Chief should go for a card of this project: the card's own topic when it is of the project, else
  // the project's most recent topic.
  function projectTopicHint(userId, profile, projectId, todo = null) {
    const own = todo?.topicId ? db.getTopic(userId, profile, todo.topicId) : null
    const target = own && !own.archived && topicOwnsProject(own, projectId)
      ? own
      : db.listTopics(userId, profile, { includeArchived: false })
        .filter(t => topicOwnsProject(t, projectId))
        .sort((a, b) => (Number(Boolean(b.chiefSessionId)) - Number(Boolean(a.chiefSessionId))) || ((b.updatedAt || 0) - (a.updatedAt || 0)))[0]
    const name = projectLabel(userId, profile, projectId)
    return target
      ? `请到项目 ${name} 的话题「${target.title}」（${target.id}）操作`
      : `项目 ${name} 还没有话题，请让用户在该项目下新建话题后在那里操作`
  }

  const uncertainCallerNote = caller => caller.by === 'caller-session' ? '' : '（调用未带会话身份，按正在运行的总管会话判定）'

  // Guard of every Chief tool that names a card: the calling Chief's topic must be a topic of the card's
  // project. Returns '' when allowed, else the refusal text. Non-Chief callers are never refused; an unknown
  // card is left to the tool itself.
  function chiefTodoScopeViolation(run, toolName, todoId, callerTopicId = '') {
    return chiefTodoScopeCheck(run, toolName, todoId, callerTopicId)?.text || ''
  }

  // The same check with its error code: null when allowed, else { code, text }. code is CALLER_AMBIGUOUS
  // when the caller cannot be told apart and not every candidate may act on the card (fail-closed: a call is
  // let through only when every Chief that may be making it owns the card's project), and when the call
  // carries a caller_topic_id that was not believed (#108); else TOPIC_PROJECT_MISMATCH.
  function chiefTodoScopeCheck(run, toolName, todoId, callerTopicId = '') {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, String(todoId || ''))
    if (!todo) return null
    const caller = resolveChiefCaller(run, toolName, callerTopicId)
    // #108: a declared topic that was not believed refuses the call, whatever the candidates own.
    if (caller.declaredUnknown) return { code: 'CALLER_AMBIGUOUS', text: ambiguousCallerText(caller) }
    if (!caller.topics.length) return null
    const owners = caller.topics.filter(topic => topicOwnsProject(topic, todo.projectId))
    if (caller.ambiguous && owners.length !== caller.topics.length) return { code: 'CALLER_AMBIGUOUS', text: ambiguousCallerText(caller) }
    if (owners.length) {
      // #117: of the card's project, but only the managing topic acts on the card. Fail-closed like above:
      // with several possible callers the call passes only when every one of them manages the card.
      if (TODO_PROJECT_SCOPED_TOOLS.has(String(toolName))) return null
      const managers = caller.topics.filter(topic => topicManagesTodo(topic, todo))
      if (managers.length === caller.topics.length) return null
      if (caller.ambiguous) return { code: 'CALLER_AMBIGUOUS', text: ambiguousCallerText(caller) }
      return { code: NOT_MANAGER, text: `${notManagerText(userId, profile, caller.topics[0], todo)}${uncertainCallerNote(caller)}` }
    }
    const topic = caller.topics[0]
    const target = projectLabel(userId, profile, todo.projectId)
    // #124: read by the Chief, so the first thing it is told is the call it makes itself.
    const lead = topic.projectId ? '' : `${NO_PROJECT_HINT}：由你调用 set_topic_project 绑定到卡片所在的项目（topic_id ${topic.id}，project_id ${todo.projectId}），不必让用户去操作。`
    // #121: the Chief binds its own topic itself; it is not sent to the user for it.
    const rebind = topic.projectId ? '' : `；也可以直接调用 set_topic_project（topic_id ${topic.id}，project_id ${todo.projectId}）把本话题绑定到项目 ${target}${takeOverAfterBinding(topic, todo)}`
    return {
      code: 'TOPIC_PROJECT_MISMATCH',
      text: `${lead}话题「${topic.title}」${topicProjectPhrase(userId, profile, topic)}，不能操作项目 ${target} 的卡片 #${todo.number}（${todo.id}）。${projectTopicHint(userId, profile, todo.projectId, todo)}${rebind}。${uncertainCallerNote(caller)}`,
    }
  }

  // Scope of list_todos. A Chief sees cards of its topic's project only; another project (by project_id or by
  // topic_id) and the cross-project overview (all_projects) are refused with the reason. A non-Chief caller
  // gets what it asked for. Returns { error } or { filter: { projectId, topicId, phase } }.
  function chiefListScope(run, toolName, { projectId = '', topicId = '', phase = '', allProjects = false, callerTopicId = '' } = {}) {
    const { userId, profile } = run.identity
    const caller = resolveChiefCaller(run, toolName, callerTopicId)
    // #108: a declared topic that was not believed refuses the call, with or without candidates.
    if (caller.declaredUnknown) return { error: ambiguousCallerText(caller), code: 'CALLER_AMBIGUOUS' }
    if (!caller.topics.length) return { filter: { projectId: allProjects ? '' : projectId, topicId, phase }, chief: false }
    // Fail-closed: candidates of more than one project cannot be told apart, so nothing is listed.
    if (caller.ambiguous && new Set(caller.topics.map(t => t.projectId || '')).size > 1) {
      return { error: ambiguousCallerText(caller), code: 'CALLER_AMBIGUOUS' }
    }
    const topic = caller.topics[0]
    const scopeReason = topicScopeReasonOf(userId, profile, topic, topicTodoTally(userId, profile))
    const refuse = error => ({ error, code: 'TOPIC_PROJECT_MISMATCH', ...(scopeReason ? { topicScopeReason: scopeReason } : {}) })
    const where = `话题「${topic.title}」${topicProjectPhrase(userId, profile, topic)}`
    const note = uncertainCallerNote(caller)
    if (allProjects) return refuse(`${where}，总管会话不能使用跨项目总览（all_projects）；跨项目总览只供用户界面与非总管会话使用。${note}`)
    if (topicId) {
      const target = db.getTopic(userId, profile, topicId)
      if (!target) return refuse(`话题不存在：${topicId}`)
      if (!topicOwnsProject(topic, target.projectId)) {
        return refuse(`${where}，不能查看话题「${target.title}」（${topicProjectPhrase(userId, profile, target)}）的卡片。${target.projectId ? projectTopicHint(userId, profile, target.projectId) : '请只查看本话题所属项目的卡片'}。${note}`)
      }
      if (projectId && projectId !== target.projectId) return refuse(`话题「${target.title}」${topicProjectPhrase(userId, profile, target)}，与 project_id ${projectId} 不一致`)
      return { filter: { projectId: target.projectId, topicId, phase }, chief: true, topic, topicScopeReason: scopeReason }
    }
    if (projectId) {
      if (!topicOwnsProject(topic, projectId)) {
        return refuse(`${where}，不能查看项目 ${projectLabel(userId, profile, projectId)} 的卡片。${projectTopicHint(userId, profile, projectId)}。${note}`)
      }
      return { filter: { projectId, topicId: '', phase }, chief: true, topic, topicScopeReason: scopeReason }
    }
    // #124: one instruction for the Chief; the opening used to say "use the topic menu first" before it.
    if (!topic.projectId) return refuse(`${NO_PROJECT_HINT}：${where}，看不到任何项目的卡片；请调用 set_topic_project 把本话题绑定到一个项目（topic_id ${topic.id}，project_id 见 list_projects 或项目清单），不必让用户去操作。${note}`)
    return { filter: { projectId: topic.projectId, topicId: '', phase }, chief: true, topic, topicScopeReason: scopeReason }
  }

  // An Error that carries the tool error code (mcp-tools answers ok: false, error: code).
  function codedError(code, message) {
    const err = new Error(message)
    err.code = code
    return err
  }

  // watch_todos. #97: only from a topic of the card's project. #117: a card is watched from its managing topic
  // only. From another topic of the project the call is refused (NOT_MANAGER) and nothing is stored, unless
  // takeOver is set: then the management of the card moves to that topic (see transferTodoTopic). A Chief can
  // take a card over into its own topic only; a caller that is no Chief (the user, the page) into any topic
  // of the project.
  function watchTodoFromTopic(run, { topicId, todoId, reason = '', takeOver = false, callerTopicId = '' }) {
    const { userId, profile } = run.identity
    adoptOrphanTopics(run, userId, profile)
    const todo = db.getTodo(userId, profile, String(todoId || ''))
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const topic = db.getTopic(userId, profile, String(topicId || ''))
    if (!topic) throw new Error(`话题不存在：${topicId}`)
    if (!topicOwnsProject(topic, todo.projectId)) {
      throw codedError('TOPIC_PROJECT_MISMATCH', `话题「${topic.title}」${topicProjectPhrase(userId, profile, topic)}，不能关注项目 ${projectLabel(userId, profile, todo.projectId)} 的卡片 #${todo.number}；一张卡只能由它的管理话题关注。${projectTopicHint(userId, profile, todo.projectId, todo)}。`)
    }
    if (topicManagesTodo(topic, todo)) {
      db.watchTodo(userId, profile, topic.id, todo.id, reason || 'Watched by chief')
      return { topicId: topic.id, todoId: todo.id, tookOver: false, fromTopicId: topic.id }
    }
    if (!takeOver) throw codedError(NOT_MANAGER, `未关注。${notManagerText(userId, profile, topic, todo)}`)
    if (topic.archived) throw codedError(NOT_MANAGER, `话题「${topic.title}」已归档，不能接管卡片 #${todo.number}；未做任何改动。`)
    const caller = resolveChiefCaller(run, 'watch_todos', callerTopicId)
    if (caller.declaredUnknown || (caller.topics.length && caller.ambiguous)) throw codedError('CALLER_AMBIGUOUS', ambiguousCallerText(caller))
    if (caller.topics.length && caller.topics[0].id !== topic.id) {
      throw codedError(NOT_MANAGER, `总管只能把卡片接管到自己所在的话题：你在话题「${caller.topics[0].title}」（${caller.topics[0].id}），不能替话题「${topic.title}」（${topic.id}）接管卡片 #${todo.number}；未做任何改动。${uncertainCallerNote(caller)}`)
    }
    const project = db.getProject(userId, profile, todo.projectId)
    const oldTopic = todo.topicId ? db.getTopic(userId, profile, todo.topicId) : null
    transferTodoTopic(userId, profile, todo, project, oldTopic, topic, reason)
    log?.info?.('Management of a card moved to another topic', { todoId: todo.id, fromTopicId: todo.topicId, toTopicId: topic.id })
    emitUpdated(run, `todo.topic.transferred:${todo.id}`)
    return { topicId: topic.id, todoId: todo.id, tookOver: true, fromTopicId: todo.topicId || '' }
  }

  // #117: moves the management of a card to `topic` (a topic of the card's project). One transaction:
  // todos.topic_id (the schema ends the watches of every other topic with it), the new topic's watch for an
  // unfinished card, a timeline line and one system message in the old and in the new topic. Messages already
  // in the old topic stay; it only stops receiving the card's progress. Any phase: the topic of a card is read
  // when a round settles, so a round in flight reports to the new topic.
  function transferTodoTopic(userId, profile, todo, project, oldTopic, topic, reason = '') {
    const from = oldTopic ? `话题「${oldTopic.title}」` : (todo.topicId ? `已不存在的话题 ${todo.topicId}` : '无管理话题')
    db.transaction(() => {
      db.setTodoTopic(userId, profile, todo.id, topic.id)
      if (todo.phase !== 'done' && todo.phase !== 'closed') db.watchTodo(userId, profile, topic.id, todo.id, reason || 'Took over the card')
      db.appendTimeline(userId, profile, todo.id, `管理话题变更：从${from}转到话题「${topic.title}」；此后只有该话题收到进展并可操作这张卡`, 'system')
      if (oldTopic && oldTopic.id !== topic.id) {
        db.addTopicMessage(userId, profile, oldTopic.id, {
          kind: 'system',
          text: `管理权转移：#${todo.number} ${todo.title} 已由话题「${topic.title}」接管。本话题不再收到它的进展，也不能再操作它；历史消息保留。`,
          todoId: todo.id,
          progressNotice: `管理权转移：#${todo.number} 已由话题「${topic.title}」接管`,
        })
      }
      db.addTopicMessage(userId, profile, topic.id, {
        kind: 'system',
        text: `管理权转移：#${todo.number} ${todo.title} 从${from}转入本话题，此后由本话题管理：进展只通知到这里${project ? `（项目 ${project.name}）` : ''}。`,
        todoId: todo.id,
        progressNotice: `管理权转移：#${todo.number} 已转入本话题`,
      })
    })
  }

  // The topic of the Chief session that is calling the create-todo tool right now: among the Chief sessions
  // of this account and profile whose last started tool is a create-todo tool no older than 120 seconds,
  // whose topic is not archived and still marked running, the one that started it last. null when none.
  function identifyCallerByTool(userId, profile, projectId = '') {
    const now = clock()
    let best = null
    for (const [sessionId, entry] of [...chiefToolCalls]) {
      if (now - entry.at > CALLER_TOOL_WINDOW_MS) { chiefToolCalls.delete(sessionId); continue }
      if (!CREATE_TODO_TOOL.test(entry.toolName)) continue
      const hit = db.findTopicBySessionId(sessionId)
      if (!hit) { chiefToolCalls.delete(sessionId); continue }
      if (hit.userId !== userId || hit.profile !== profile) continue
      const topic = db.getTopic(userId, profile, hit.topicId)
      if (!topic || topic.archived || !topic.isRunning) continue
      // #97: with a project given, only Chief topics of that project qualify.
      if (projectId && !topicOwnsProject(topic, projectId)) continue
      if (!best || entry.at >= best.at) best = { topicId: topic.id, title: topic.title, at: entry.at, topic }
    }
    return best ? { topicId: best.topicId, title: best.title, topic: best.topic } : null
  }

  // The topic of the Chief run that most probably made a call without identity.sessionId: among the running
  // Chief sessions of this account and profile whose topic is not archived and still marked running, the one
  // that started last. `candidates` is how many qualified. null when there is none.
  function inferCallerTopicId(userId, profile, projectId = '') {
    const now = Date.now()
    let best = null
    let candidates = 0
    for (const [sessionId, entry] of [...activeChiefRuns]) {
      if (now - entry.lastSeenAt > ACTIVE_CHIEF_RUN_TTL_MS) { activeChiefRuns.delete(sessionId); continue }
      const hit = db.findTopicBySessionId(sessionId)
      if (!hit) { activeChiefRuns.delete(sessionId); continue }
      if (hit.userId !== userId || hit.profile !== profile) continue
      const topic = db.getTopic(userId, profile, hit.topicId)
      if (!topic || topic.archived || !topic.isRunning) continue
      if (projectId && !topicOwnsProject(topic, projectId)) continue
      candidates += 1
      if (!best || entry.startedAt >= best.startedAt) best = { topicId: topic.id, title: topic.title, startedAt: entry.startedAt, topic }
    }
    return best ? { topicId: best.topicId, title: best.title, candidates, topic: best.topic } : null
  }

  function trackChiefToolForLoop(sessionId, toolName) {
    if (isDescribeTool(toolName)) chiefDescribeStreak.set(sessionId, (chiefDescribeStreak.get(sessionId) || 0) + 1)
    else if (!isSchemaOnlyTool(toolName)) chiefDescribeStreak.delete(sessionId)
    if (chiefDescribeStreak.size > 200) chiefDescribeStreak.delete(chiefDescribeStreak.keys().next().value)
    return chiefDescribeStreak.get(sessionId) || 0
  }

  function clearChiefLoopState(sessionId) {
    chiefDescribeStreak.delete(sessionId)
    chiefLoopStopped.delete(sessionId)
    chiefTurnTrackers.delete(sessionId)
  }

  // ── Chief orchestration boundary (0.9.63: notify only) ───────────────────────────────────────────────
  // With strict orchestration on, a write / execute / delegate call by the Chief is reported in the topic,
  // once per category per turn. The turn is never stopped and nothing is queued: a cut-off turn left the user
  // with no answer at all, which is worse than a flagged call they can stop themselves.
  const chiefTurnTrackers = new Map() // sessionId -> tracker for the running turn
  const chiefToolsMissingNoticed = new Set() // topicIds told about unloaded Ekko ToDo tools since the last user message
  // #105: the announce-only resumes since the last user message live in the topic row (topics.chief_idle_json,
  // field `resumes`), next to the idle-round count: a plugin reload no longer hands out a fresh budget.

  // #105 (audit #95 P1-6): classify the Chief round that just ended and keep the persisted idle count.
  // Productive (a dispatch, or a reply with a verifiable conclusion) → count, resumes and the exhausted flag go
  // back to 0, with one topic line when there was a count. Idle (announce-only, or only read-only / probing
  // tools and no conclusion) → count + 1; at CHIEF_IDLE_HINT_AT a warning, at CHIEF_IDLE_BREAK_AT the breaker:
  // no automatic resume from then on (until a productive round) and the advice is written once.
  // Neutral rounds leave everything as it is. Returns { verdict, broken }.
  async function settleChiefIdleRound(run, matchedTopic, sessionId) {
    const { userId, profile, topicId } = matchedTopic
    const res = await run.host.sessions.messages(sessionId, { limit: 60 }).catch(() => null)
    const list = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : [])
    const verdict = classifyChiefRound(list)
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic) return { verdict, broken: false }
    const state = topic.chiefIdle || { count: 0, resumes: 0, exhaustedNoticed: false }
    if (verdict.kind === 'productive') {
      if (state.count > 0) {
        const msg = `总管本轮有产出（${verdict.reason === 'dispatch' ? '已派工' : '给出了可核验的结论'}），空转计数（${state.count}）清零`
        db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: msg })
      }
      if (state.count > 0 || state.resumes > 0 || state.exhaustedNoticed) db.setTopicChiefIdle(userId, profile, topicId, { count: 0, resumes: 0, exhaustedNoticed: false })
      return { verdict, broken: false }
    }
    if (verdict.kind !== 'idle') return { verdict, broken: state.count >= CHIEF_IDLE_BREAK_AT }
    const count = state.count + 1
    db.setTopicChiefIdle(userId, profile, topicId, { count })
    if (count >= CHIEF_IDLE_BREAK_AT) {
      if (count === CHIEF_IDLE_BREAK_AT) {
        const msg = formatChiefIdleBreak(count, verdict)
        db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: msg, progressNotice: msg })
        try { log?.warn?.('Chief idle breaker tripped', { topicId, count, reason: verdict.reason }) } catch {}
      }
      return { verdict, broken: true }
    }
    if (count === CHIEF_IDLE_HINT_AT) {
      const msg = formatChiefIdleHint(count, verdict)
      db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: msg, progressNotice: msg })
    }
    return { verdict, broken: false }
  }

  // 0.9.62: a Chief turn that only said what it was about to do (no tool call) is resumed; #105: a round of
  // read-only probing without a conclusion too. At most CHIEF_MAX_ANNOUNCE_NUDGES per user message; when they
  // are used up the topic and the card the chain is about each get one visible line, instead of stopping silently.
  async function resumeAnnounceOnlyChiefTurn(run, matchedTopic, sessionId, verdict) {
    const { userId, profile, topicId } = matchedTopic
    if (verdict?.kind !== 'idle') return false
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic) return false
    const state = topic.chiefIdle || { count: 0, resumes: 0, exhaustedNoticed: false }
    const used = state.resumes
    if (used >= CHIEF_MAX_ANNOUNCE_NUDGES) {
      if (!state.exhaustedNoticed) {
        const cardMsg = [...(topic.messages || [])].reverse().find(m => m.todoId)
        const card = cardMsg ? db.getTodo(userId, profile, cardMsg.todoId) : null
        const msg = formatChiefResumeExhausted(used, card ? `#${card.number}` : '')
        db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: msg, progressNotice: msg, todoId: card?.id || '' })
        if (card) db.appendTimeline(userId, profile, card.id, `${msg}（话题「${topic.title}」）`, 'orchestrator')
        db.setTopicChiefIdle(userId, profile, topicId, { exhaustedNoticed: true })
        try { log?.warn?.('Chief automatic resumes used up', { topicId, used, todoId: card?.id || '' }) } catch {}
      }
      return false
    }
    db.setTopicChiefIdle(userId, profile, topicId, { resumes: used + 1 })
    const announce = verdict.reason === 'announce'
    const notice = announce
      ? formatChiefAnnounceNotice(verdict.text)
      : `总管只做了只读查询、没有结论也没有派工（${(verdict.tools || []).slice(0, 4).join('、')}），已自动让它接着做一次。`
    db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: notice, progressNotice: notice })
    db.enqueueTopicItem(userId, profile, topicId, { kind: 'wake', text: announce ? formatChiefAnnounceNudge(verdict.text, used + 1) : formatChiefReadOnlyNudge(verdict, used + 1) })
    try { log?.warn?.('Chief turn idle; resumed', { topicId, reason: verdict.reason, attempt: used + 1 }) } catch {}
    return true
  }

  function notifyChiefGuard(run, matchedTopic, verdict) {
    const { userId, profile, topicId } = matchedTopic
    const notice = formatChiefGuardNotice(verdict)
    db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: notice, progressNotice: notice })
    try { log?.warn?.('Chief used a worker tool (flagged, not stopped)', { topicId, tool: verdict.tool || '', category: verdict.category || '' }) } catch {}
    emitUpdated(run, `chief.guard.flagged:${topicId}`)
  }

  // 0.9.63: the host did not load the Ekko ToDo tools into this Chief session; say so instead of "empty reply".
  async function noticeEkkoToolsMissing(run, matchedTopic, sessionId) {
    const { userId, profile, topicId } = matchedTopic
    const res = await run.host.sessions.messages(sessionId, { limit: 60 }).catch(() => null)
    const list = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : [])
    const hit = detectEkkoToolsMissing(list)
    if (!hit) return false
    if (chiefToolsMissingNoticed.has(topicId)) return true
    chiefToolsMissingNoticed.add(topicId)
    if (chiefToolsMissingNoticed.size > 400) chiefToolsMissingNoticed.delete(chiefToolsMissingNoticed.values().next().value)
    const notice = formatEkkoToolsMissingNotice(hit.tool)
    db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: notice, progressNotice: notice })
    try { log?.warn?.(`Ekko ToDo tools are not loaded in the Chief session (${hit.tool})`, { topicId }) } catch {}
    return true
  }


  // Returns true when the turn was stopped (or had already been stopped) for looping.
  async function checkChiefLoop(run, matchedTopic, sessionId, eventDescribeStreak = 0) {
    if (chiefLoopStopped.has(sessionId)) return true
    const res = await run.host.sessions.messages(sessionId, { limit: 60 }).catch(() => null)
    const list = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : [])
    let verdict = detectChiefLoop(list)
    // Tool events alone are enough for the schema-read streak when the transcript is behind or unreadable.
    if (!verdict && eventDescribeStreak >= DESCRIBE_ONLY_LIMIT) verdict = { kind: 'describe-only', count: eventDescribeStreak }
    if (!verdict) return false

    const { userId, profile, topicId } = matchedTopic
    chiefLoopStopped.set(sessionId, Date.now())
    if (chiefLoopStopped.size > 200) chiefLoopStopped.delete(chiefLoopStopped.keys().next().value)
    chiefDescribeStreak.delete(sessionId)
    await run.host.sessions.stop(sessionId).catch(() => {})
    sessionActivity.delete(sessionId)
    db.updateTopic(userId, profile, topicId, { isRunning: false, activeRunId: '' })
    // A plugin reload in the middle of a stopped run loses the marker above; the notice at the tail of the
    // topic then stands in for it. A run this process saw starting is a new turn and always gets its notice.
    const tail = db.getTopic(userId, profile, topicId)?.messages || []
    const alreadyNoticed = !chiefRunStartSeen.has(sessionId) && isLoopStopNotice(tail[tail.length - 1]?.text)
    if (!alreadyNoticed) {
      const msg = formatLoopStopNotice(verdict)
      db.addTopicMessage(userId, profile, topicId, { kind: 'system', text: msg, progressNotice: msg })
      try { log?.warn?.('Chief loop stopped', { topicId, kind: verdict.kind, count: verdict.count }) } catch {}
    }
    emitUpdated(run, `chief.loop.stopped:${topicId}`)
    await drainTopicQueue(run, userId, profile, topicId).catch(() => {})
    return true
  }

  async function stopTopicRun(run, topicId) {
    const { userId, profile } = run.identity
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic) throw new Error(`Topic not found: ${topicId}`)
    if (topic.chiefSessionId) {
      await run.host.sessions.stop(topic.chiefSessionId).catch(() => {})
      sessionActivity.delete(topic.chiefSessionId)
    }
    db.updateTopic(userId, profile, topic.id, { isRunning: false, activeRunId: '' })
    emitUpdated(run, `topic.run.stopped:${topic.id}`)
    return getSnapshot(run)
  }

  function isInternalWakeUserPrompt(text) {
    const t = String(text || '').trim()
    return t.startsWith('Automated notice (not typed by the user):')
      || t.startsWith('Since your last turn:\n')
  }

  /**
   * Read the tail of a host session, oldest first. The host returns the newest `limit` rows (tool rows
   * included) and pages further back with `offset`. One page is enough when it reaches a message the plugin
   * already holds; otherwise keep paging back, so an answer followed by more than a page of tool rows is not
   * skipped for good. Bounded: at most HOST_TAIL_MAX_PAGES pages, and only while the host reports more rows.
   */
  async function readHostTranscriptTail(run, sessionId, knownIds) {
    const pages = []
    let offset = 0
    let total = 0
    for (let i = 0; i < HOST_TAIL_MAX_PAGES; i += 1) {
      const query = offset > 0 ? { limit: HOST_TAIL_PAGE_ROWS, offset } : { limit: HOST_TAIL_PAGE_ROWS }
      const res = await run.host.sessions.messages(sessionId, query).catch(() => null)
      if (!res) {
        if (i === 0) return null
        break
      }
      const page = normalizeHostMessages(res)
      if (i === 0) total = Number(res.total || page.length) || 0
      pages.unshift(page)
      if (!page.length || res.hasMore !== true) break
      if (page.some(m => m.id && knownIds.has(m.id))) break
      offset += page.length
    }
    const seen = new Set()
    const messages = []
    for (const m of pages.flat()) {
      if (m.id) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
      }
      messages.push(m)
    }
    const last = messages[messages.length - 1]
    return { messages, tail: `${total}:${last?.id || ''}:${last?.timestamp || 0}` }
  }

  async function syncChiefTranscript(run, userId, profile, topicId, markDone = false) {
    return (await syncChiefTranscriptDetailed(run, userId, profile, topicId, markDone)).added
  }

  /**
   * Copy new host user/assistant messages into the topic. Safe to repeat and safe to overlap: the host message
   * id is the only idempotency key, and the store refuses a second row for the same (topic, host message id).
   * Returns { ok: host read succeeded, added, tail: fingerprint of the host tail, cleared: running flag reset }.
   */
  async function syncChiefTranscriptDetailed(run, userId, profile, topicId, markDone = false) {
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic || !topic.chiefSessionId) return { ok: false, added: false, tail: '', cleared: false }
    const existingIds = new Set(topic.messages.map(m => m.hostMessageId).filter(Boolean))
    const read = await readHostTranscriptTail(run, topic.chiefSessionId, existingIds)
    if (!read) return { ok: false, added: false, tail: '', cleared: false }
    const hostMsgs = read.messages
    const existingHumans = topic.messages.filter(m => m.kind === 'human')
    const existingChiefs = topic.messages.filter(m => m.kind === 'chief')
    let added = false

    for (const hm of hostMsgs) {
      const content = hm.content.trim()
      if (!content) continue
      const msgTs = hm.timestamp > 0 ? (hm.timestamp < 1e12 ? hm.timestamp * 1000 : hm.timestamp) : Date.now()
      const key = hm.id || `ts:${hm.timestamp}:${hm.role}:${content.slice(0, 32)}`
      if (existingIds.has(key)) continue

      if (hm.role === 'assistant') {
        // Text matching is only a fallback against a stored Chief message that has no host id. Two host
        // messages with the same text (the Chief answering "好的。" twice) are two messages.
        const dupChief = existingChiefs.some(m => !m.hostMessageId && m.text.trim() === content && Math.abs((m.createdAt || 0) - msgTs) < 120000)
        if (dupChief) {
          existingIds.add(key)
          continue
        }
        const actStart = sessionActivity.get(topic.chiefSessionId)?.startedAt || 0
        const prevHumanTs = existingHumans.length ? (existingHumans[existingHumans.length - 1].createdAt || 0) : 0
        const refStart = actStart > 0 && msgTs >= actStart ? actStart : (prevHumanTs > 0 && msgTs >= prevHumanTs ? prevHumanTs : 0)
        const computedDurationMs = refStart > 0 && (msgTs - refStart) > 500 && (msgTs - refStart) < 30 * 60 * 1000
          ? (msgTs - refStart)
          : 0
        // '' = another sync stored this host message while this one was waiting on the host.
        const insertedId = db.addTopicMessage(userId, profile, topic.id, {
          kind: 'chief',
          text: content,
          durationMs: computedDurationMs,
          hostMessageId: key,
          createdAt: msgTs,
        })
        existingIds.add(key)
        existingChiefs.push({ text: content, createdAt: msgTs, hostMessageId: key })
        if (insertedId) added = true
      } else if (hm.role === 'failed_turn') {
        // 0.9.57: the host's own "request not processed" row is shown as a system line, not as the Chief's words.
        const insertedId = db.addTopicMessage(userId, profile, topic.id, {
          kind: 'system',
          text: `大总管这一轮没有执行：宿主判定请求失败（${content.slice(0, 120)}）。常见原因是大总管的模型名无效或凭据失效，可在 Agent 设置里检查后重发。`,
          hostMessageId: key,
          createdAt: msgTs,
        })
        existingIds.add(key)
        if (insertedId) added = true
      } else if (hm.role === 'user') {
        // #75: a message sent with attachments comes back as serialized content blocks; check its text.
        const userText = hostMessageText(content).trim()
        if (isInternalWakeUserPrompt(userText)) continue
        // Strip internal digest/mention prefixes if any, and deduplicate against plugin-originated human bubbles
        const dupHuman = existingHumans.some(m => {
          const prev = m.text.trim()
          return (prev === userText || userText.endsWith(prev)) && Math.abs((m.createdAt || 0) - msgTs) < 180000
        })
        if (dupHuman) {
          existingIds.add(key)
          continue
        }
        const insertedId = db.addTopicMessage(userId, profile, topic.id, {
          kind: 'human',
          text: userText,
          hostMessageId: key,
          createdAt: msgTs,
        })
        existingIds.add(key)
        existingHumans.push({ text: userText, createdAt: msgTs })
        if (insertedId) added = true
      }
    }

    let cleared = false
    if (markDone) {
      sessionActivity.delete(topic.chiefSessionId)
      if (topic.isRunning || topic.activeRunId) {
        db.updateTopic(userId, profile, topic.id, { isRunning: false, activeRunId: '' })
        cleared = true
      }
    }
    return { ok: true, added, tail: read.tail, cleared }
  }

  /**
   * Ask for follow-up syncs after a Chief turn was seen finished. The host stores the last assistant message
   * a moment after it reports the run as finished, so the sync done at that instant can miss it. Nothing is
   * awaited here and no timer is created: the `settle` scheduler action picks the entry up with its own run.
   */
  function requestChiefSettle(userId, profile, topicId) {
    if (!topicId || pendingSettles.has(topicId)) return
    if (pendingSettles.size >= MAX_PENDING_SETTLES) pendingSettles.delete(pendingSettles.keys().next().value)
    pendingSettles.set(topicId, { userId, profile, attempt: 0, lastTail: null, dueAt: Date.now() + SETTLE_DELAYS_MS[0] })
  }

  async function settleChiefTopic(run, entry, topicId) {
    const topic = db.getTopic(entry.userId, entry.profile, topicId)
    if (!topic || !topic.chiefSessionId) return { ok: true, added: false, tail: '', cleared: false, busy: true }
    const sid = topic.chiefSessionId
    // A new turn may have started since the request (queued follow-up, user message): copy messages, but
    // leave its running flag alone. The flag is cleared only when the host says the session is idle; when it
    // cannot say, messages are still copied and the flag stays (clearing it would let a second turn start on
    // a session that may still be working).
    let busy = Boolean(launchingTopics.has(topicId) || sessionActivity.get(sid)?.running)
    let idle = false
    if (!busy) {
      const probe = await probeSessionWorking(run, sid, { timeoutMs: 1200 }).catch(() => null)
      busy = Boolean(probe?.known && probe.isWorking)
      idle = Boolean(probe?.known && !probe.isWorking)
    }
    const res = await syncChiefTranscriptDetailed(run, entry.userId, entry.profile, topicId, idle)
    return { ...res, busy }
  }

  /**
   * Body of the `settle` scheduler action. Each due entry is synced with this call's own host handle; an
   * entry is retried (first pass + 3 retries) until a pass adds nothing and the host tail stopped changing.
   */
  async function settlePendingTopics(run) {
    const now = Date.now()
    let settled = 0
    // #64 (C08): titles whose first attempt was cancelled with the send call's handle, retried with this one.
    for (const [topicId, job] of [...pendingTitleJobs]) {
      if (run?.signal?.aborted) break
      if (job.profile !== run.identity.profile) continue
      pendingTitleJobs.delete(topicId)
      await maybeAutoGenerateTopicTitle(run, job.userId, job.profile, topicId, job.userText, job.activeCfg, { retried: true }).catch(err => {
        log?.warn?.(`话题标题重试失败，保留临时标题：${err?.message || String(err)}`, { topicId })
      })
    }
    for (const [topicId, entry] of [...pendingSettles]) {
      if (run?.signal?.aborted) break
      if (entry.profile !== run.identity.profile || entry.dueAt > now || entry.inFlight) continue
      entry.inFlight = true
      let res = null
      try {
        res = await settleChiefTopic(run, entry, topicId)
      } catch {
        res = null
      } finally {
        entry.inFlight = false
      }
      entry.attempt += 1
      const stable = Boolean(res?.ok && !res.added && entry.attempt > 1 && res.tail === entry.lastTail)
      if (res?.ok) entry.lastTail = res.tail
      if (res?.added || res?.cleared) {
        settled += 1
        emitUpdated(run, `chief.settle:${topicId}`)
      }
      if (res?.busy || stable || entry.attempt >= SETTLE_DELAYS_MS.length) pendingSettles.delete(topicId)
      else entry.dueAt = Date.now() + SETTLE_DELAYS_MS[entry.attempt]
    }
    return { ok: true, pending: pendingSettles.size, settled }
  }


  async function syncTopicSession(run, { topicId = '' } = {}) {
    const { userId, profile } = run.identity
    const topic = topicId
      ? db.getTopic(userId, profile, topicId)
      : db.listTopics(userId, profile, { includeArchived: false })[0]
    if (!topic || !topic.chiefSessionId) return getSnapshot(run)

    const probe = await probeSessionWorking(run, topic.chiefSessionId, { timeoutMs: 1200 })
    if (probe.known) {
      if (probe.isWorking) {
        const curAct = sessionActivity.get(topic.chiefSessionId)
        sessionActivity.set(topic.chiefSessionId, {
          running: true,
          startedAt: curAct?.startedAt || probe.runStartedAt || Date.now(),
          updatedAt: Date.now(),
          activeTool: curAct?.activeTool || '',
          toolCount: curAct?.toolCount || 0,
          stage: curAct?.stage || 'running',
        })
        if (!topic.isRunning) {
          db.updateTopic(userId, profile, topic.id, { isRunning: true })
        }
        await syncChiefTranscript(run, userId, profile, topic.id, false)
      } else {
        // Host idle: copy what is there, correct a stale running flag, and ask for follow-up passes when
        // a turn just ended (the last message may not be stored yet).
        const wasRunning = Boolean(topic.isRunning || topic.activeRunId)
        await syncChiefTranscript(run, userId, profile, topic.id, true)
        if (wasRunning) requestChiefSettle(userId, profile, topic.id)
      }
    } else {
      await syncChiefTranscript(run, userId, profile, topic.id, false)
    }
    return getSnapshot(run)
  }

  async function handleChiefFailureWithFailover(run, userId, profile, topicId, errorText) {
    const topic = db.getTopic(userId, profile, topicId)
    if (!topic) return false
    const liveEngines = await probeLiveEngines(run)
    const chiefAgent = resolveChiefAgent(userId, profile, liveEngines)
    const classified = classifyModelFailure(errorText)

    if (chiefAgent.autoFallback && classified.switchable) {
      const { config: failedCfg, index: failedIdx } = resolveActiveConfig(chiefAgent, topic.activeConfigId)
      db.recordConfigFailure(chiefAgent.id, failedCfg.id, classified.category, errorText)
      const next = selectNextFallbackConfig({
        agent: chiefAgent,
        failedConfigId: failedCfg.id,
        cooldowns: db.listAgentCooldowns(chiefAgent.id),
      })
      if (next) {
        const lastHuman = [...topic.messages].reverse().find(m => m.kind === 'human')
        if (lastHuman) {
          const notice = `${formatConfigLabel(failedCfg, failedIdx)} 异常（${classified.label}），已自动切换至 ${formatConfigLabel(next.config, next.index)} 重试。`
          db.addTopicMessage(userId, profile, topic.id, { kind: 'system', text: notice, progressNotice: notice })
          const projects = db.listProjects(userId, profile)
          const activeProject = projects.find(p => p.id === topic.projectId) || projects[0] || null
          const settings = db.getSettings(userId, profile, config)
          const instructions = buildChiefInstructions({
            topic,
            firstCardBinds: topicBindsOnFirstCard(topic),
            projects,
            agents: db.listAgents(userId, profile),
            activeTodos: todosManagedByTopic(topic, db.listTodos(userId, profile)).filter(t => t.phase !== 'done' && t.phase !== 'closed'),
            chiefAgent,
            settings,
            memories: collectRelevantMemories(userId, profile, { projectId: activeProject?.id || '', agentId: chiefAgent.id, includeChief: true }),
          })
          const updatedTopic = db.updateTopic(userId, profile, topic.id, { activeConfigId: next.config.id })
          await launchChiefRunWithFailover(run, {
            userId,
            profile,
            topic: updatedTopic,
            chiefAgent,
            promptText: lastHuman.text,
            instructions,
            activeProject,
            forceNewSession: true,
          })
          emitUpdated(run, `chief.failover:${topic.id}`)
          return true
        }
      }
    }

    db.updateTopic(userId, profile, topic.id, {
      isRunning: false,
      activeRunId: '',
      lastError: errorText || '总管会话异常中断',
    })
    emitUpdated(run, `chief.failed:${topic.id}`)
    return false
  }

  // Topic of a new card. #97: only a topic of the card's project is ever chosen. In this order (resolvedBy in
  // brackets): the given topic id, refused when it is missing or not of the project [explicit]; the topic whose
  // Chief session made the call, identity.sessionId [caller-session]; the topic of the Chief session that has
  // just started the create-todo tool, see identifyCallerByTool [caller-tool]; the topic of the Chief run under
  // way, see inferCallerTopicId, a guess when several are running [active-run]; the most recently updated topic
  // of the project that has a Chief session [chief-topic]; a topic of the project without one, a new one being
  // created with Autopilot off [unattended]. When the caller's own topic is of another project (or of none) the
  // card goes to the project's topic and `redirectedFrom` names the caller topic. `notes` are timeline lines.
  // #118, `allowBind` only (the create_todo tool; never the page RPC): when the caller is known to be a topic
  // whose project was never decided (see firstCardBindTopic), the card stays in that topic and `bind: true`
  // asks createTodo to give the topic the card's project. An explicit topic id that names this same topic
  // binds too; any other topic id of no project is refused as before.
  // #119: the last two ways are not taken here. `{ pick }` is returned instead and pickTodoTopic, called by
  // createTodo inside the transaction that writes the card, chooses the topic and creates it when the project
  // has none: a card that is not stored leaves no empty topic behind.
  function resolveTodoTopic(run, userId, profile, project, input, { allowBind = false } = {}) {
    adoptOrphanTopics(run, userId, profile)
    const binding = allowBind ? firstCardBindTopic(run) : null
    if (input.topicId) {
      const given = db.getTopic(userId, profile, input.topicId)
      if (!given) throw new Error(`话题不存在：${input.topicId}；请改用项目 ${project.name} 的话题或省略 topic_id`)
      if (!topicOwnsProject(given, project.id)) {
        if (binding && binding.topic.id === given.id) return { topicId: given.id, unattended: false, resolvedBy: 'explicit', notes: [], bind: true }
        // #126: read by the Chief that made the call. The tool comes first (only that topic's own Chief
        // may call it, see setTopicProject), the topic menu last.
        const rebind = given.projectId ? '' : `；该话题自己的总管也可以调用 set_topic_project（topic_id ${given.id}，project_id ${project.id}）把它绑定到项目 ${project.name} 后再建卡。用户本人也可以在话题菜单「改挂项目」操作。`
        throw new Error(`话题「${given.title}」${topicProjectPhrase(userId, profile, given)}，不能创建项目 ${project.name} 的卡片；请改用项目 ${project.name} 的话题或省略 topic_id${rebind}`)
      }
      return { topicId: given.id, unattended: false, resolvedBy: 'explicit', notes: [] }
    }
    if (binding) return { topicId: binding.topic.id, unattended: false, resolvedBy: binding.resolvedBy, notes: [], bind: true }
    // The caller's own topic when it cannot take the card (another project, or no project). `guessed`: taken
    // from the open tool call or the running Chief instead of identity.sessionId; only a Chief's call (actor
    // chief) is attributed that way, a card the user makes on the page is not blamed on a running Chief.
    let foreign = null
    let guessed = false
    const guessForeign = found => { if (found?.topic && input.actor === 'chief') { foreign = found.topic; guessed = true } }
    const callerSessionId = String(run.identity?.sessionId || '')
    const hit = callerSessionId ? db.findTopicBySessionId(callerSessionId) : null
    if (hit && hit.userId === userId && hit.profile === profile) {
      const callerTopic = db.getTopic(userId, profile, hit.topicId)
      if (callerTopic && !callerTopic.archived) {
        if (topicOwnsProject(callerTopic, project.id)) return { topicId: callerTopic.id, unattended: false, resolvedBy: 'caller-session', notes: [] }
        foreign = callerTopic
      }
    }
    if (!foreign) {
      const byTool = identifyCallerByTool(userId, profile, project.id)
      if (byTool) {
        return { topicId: byTool.topicId, unattended: false, resolvedBy: 'caller-tool', notes: [`建单未指定话题：按调用中的工具定位到话题「${byTool.title}」`] }
      }
      guessForeign(identifyCallerByTool(userId, profile))
    }
    if (!foreign) {
      const inferred = inferCallerTopicId(userId, profile, project.id)
      if (inferred) {
        // With several Chiefs running this is a guess, and the timeline says so.
        const notes = inferred.candidates > 1
          ? [`建单未指定话题：按活跃总管运行推断，挂到话题「${inferred.title}」（${inferred.candidates} 个总管在跑，无法确定调用方，取最近开始的）`]
          : []
        return { topicId: inferred.topicId, unattended: false, resolvedBy: 'active-run', notes, candidates: inferred.candidates }
      }
      guessForeign(inferCallerTopicId(userId, profile))
    }
    return { pick: { foreign, guessed } }
  }

  // The [chief-topic] / [unattended] end of resolveTodoTopic. Creates a topic when the project has none, so
  // it is called inside the transaction of the card only (#119).
  function pickTodoTopic(userId, profile, project, input, { foreign, guessed }) {
    const picked = pickProjectTopic(userId, profile, project, input.title)
    const notes = foreign
      ? [`${guessed ? '建单未指定话题：推断调用方为话题' : '当前话题'}「${foreign.title}」${guessed ? '，它' : ''}${topicProjectPhrase(userId, profile, foreign)}，已转到项目 ${project.name} 的话题「${picked.title}」`]
      : []
    return {
      topicId: picked.topicId,
      unattended: picked.unattended,
      resolvedBy: picked.unattended ? 'unattended' : 'chief-topic',
      notes,
      redirectedFrom: foreign ? { topicId: foreign.id, title: foreign.title, projectId: foreign.projectId || '' } : null,
    }
  }

  // `bindCallerTopic` (#118) is set by the create_todo tool only; it is not part of createTodoInput, so the
  // page RPC cannot ask for it. With it, the first card a Chief creates in a topic whose project was never
  // decided gives that topic the card's project (see resolveTodoTopic / firstCardBindTopic).
  // `linkTurnMessage` (#125) is set by the create_todo tool only too: the user message that started the
  // calling Chief's turn is marked as being about the new card (see turnMessageOf), in the card's transaction.
  async function createTodo(run, input, { bindCallerTopic = false, linkTurnMessage = false } = {}) {
    const { userId, profile } = run.identity
    const project = db.getProject(userId, profile, input.projectId)
    if (!project) throw new Error(`Project not found: ${input.projectId}`)
    // Checked before a topic is created for the card, so a refused card leaves nothing behind.
    for (const key of ['agentId', 'reviewerId', 'topicId']) assertMaxLength(key, String(input[key] || ''), MAX_AGENT_REF_CHARS)

    const VALID_KINDS = ['feature', 'bug', 'question', 'deploy', 'content']
    const kind = VALID_KINDS.includes(input.kind) ? input.kind : inferTodoKind(input.title)
    // One transaction (#118): the topic-adopt row and the topic's project of a binding, the card, its watch,
    // the timeline notes and the topic messages; since #119 also the topic that is created for the card when
    // its project has none. A failure stores none of them and the call can be repeated.
    // null: the topic-adopt row was taken between the check and the write, so the topic is not bound.
    const turnLink = linkTurnMessage ? turnMessageOf(run, 'create_todo') : null
    const store = pending => db.transaction(() => {
      const resolved = pending.pick ? pickTodoTopic(userId, profile, project, input, pending.pick) : pending
      const { topicId, unattended, notes, redirectedFrom = null, bind = false } = resolved
      if (bind) {
        if (!db.claimWakeKey(topicAdoptKey(topicId), '', topicId)) return null
        db.updateTopic(userId, profile, topicId, { projectId: project.id })
      }
      const todo = db.createTodo(userId, profile, {
        ...input,
        kind,
        projectId: project.id,
        topicId,
        actor: input.actor || 'user',
      })
      db.watchTodo(userId, profile, topicId, todo.id, 'Created todo')
      // #125: only when the card stays in the caller's own topic.
      if (turnLink && turnLink.topicId === topicId) db.linkTopicMessageToTodo(userId, profile, turnLink.topicId, turnLink.messageId, todo.id)
      for (const note of notes) db.appendTimeline(userId, profile, todo.id, note, 'system')
      if (bind) {
        db.appendTimeline(userId, profile, todo.id, `本卡是话题里的第一张卡：话题已绑定到项目 ${project.name}`, 'system')
        db.addTopicMessage(userId, profile, topicId, {
          kind: 'system',
          text: `话题已绑定到项目 ${project.name}（依据总管在本话题创建的第一张卡 #${todo.number}）。之后本话题只处理该项目的卡片；如挂错，在话题菜单「改挂项目」更换。`,
          todoId: todo.id,
          progressNotice: `话题已绑定到项目 ${project.name}`,
        })
      }
      if (unattended) {
        // Said in the topic itself, so a topic nobody attends never looks like a normal one.
        const why = redirectedFrom
          ? `建单的话题「${redirectedFrom.title}」不属于项目 ${project.name}，卡片已转到本话题`
          : '建单时没有指定话题，也无法从调用方会话确定话题，已挂到本话题'
        const notice = `无人值守话题：#${todo.number} ${why}。本话题没有总管会话，任务进展只会记录在这里，不会唤醒总管；在这里发一条消息即可让总管接手。`
        db.addTopicMessage(userId, profile, topicId, {
          kind: 'system',
          text: notice,
          todoId: todo.id,
          progressNotice: `无人值守话题：#${todo.number} 挂在本话题，没有总管会话，进展只记录不唤醒`,
        })
      }
      return { todo, resolved }
    })

    // #97: throws for a topic of another project before anything is stored.
    let stored = store(resolveTodoTopic(run, userId, profile, project, input, { allowBind: bindCallerTopic }))
    // Nothing was written. The topic is decided by now, so the card takes the usual way.
    if (!stored) stored = store(resolveTodoTopic(run, userId, profile, project, input, { allowBind: false }))
    const { todo, resolved } = stored
    const { topicId, unattended, resolvedBy, candidates = 0, redirectedFrom = null, bind = false } = resolved
    if (unattended) log?.warn?.('Todo created in a topic without a Chief session', { todoId: todo.id, topicId })
    if (bind) log?.info?.('Topic without a project bound to the project of the first card its Chief created', { topicId, projectId: project.id, todoId: todo.id, resolvedBy })

    if (input.startImmediately) {
      await startBuild(run, { todoId: todo.id, agentId: todo.agentId, withPlan: Boolean(input.withPlan) })
    } else {
      emitUpdated(run, `todo.created:${todo.id}`)
    }
    // topicCandidates: running Chiefs the active-run guess chose among (0 for every other way of resolving).
    // topicRedirectedFrom (#97): the caller's topic when it is not of the card's project and the card went elsewhere.
    // topicBoundProject (#118): the project the calling topic was bound to by this card, else null.
    return {
      todo: db.getTodo(userId, profile, todo.id),
      state: await getSnapshot(run),
      topicResolvedBy: resolvedBy,
      topicCandidates: candidates,
      topicRedirectedFrom: redirectedFrom,
      topicBoundProject: bind ? { id: project.id, name: project.name, repoPath: project.repoPath || '' } : null,
    }
  }

  /**
   * #97 repair-todo-topic: moves a card whose topic is not of its project to a topic of its project (the most
   * recently updated one with a Chief session, else one without, else a new one with Autopilot off). Writes
   * todos.topic_id, moves the watch, and leaves one system message in the old and in the new topic plus a
   * timeline line. Nothing else is touched: messages, build / review sessions, branch, worktree and diffs stay.
   * A card that is where it belongs is left as it is (repaired: false), so the call can be repeated. Refused
   * while the card is building, reviewing or merging: a round in flight would report to the wrong topic.
   * #120: the topic that is created when the project has none, the card, its watches, the timeline line and
   * both topic messages are one transaction. A write that fails stores none of them (no empty topic, no card
   * moved without its messages) and the call can be repeated.
   */
  async function repairTodoTopic(run, { todoId }) {
    const { userId, profile } = run.identity
    adoptOrphanTopics(run, userId, profile)
    const todo = db.getTodo(userId, profile, String(todoId || ''))
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const mismatch = todoTopicMismatch(userId, profile, todo)
    if (!mismatch) return { todo, repaired: false, fromTopicId: todo.topicId, toTopicId: todo.topicId, state: await getSnapshot(run) }
    const project = db.getProject(userId, profile, todo.projectId)
    if (!project) throw new Error(`#${todo.number} 所属项目 ${todo.projectId} 已不存在，无法修复话题归属`)
    if (!mismatch.repairable) throw new Error(`#${todo.number} ${mismatch.reason}`)
    const oldTopic = todo.topicId ? db.getTopic(userId, profile, todo.topicId) : null
    const picked = db.transaction(() => {
      // Creates a topic when the project has none, so it is called inside the transaction only (#120).
      const picked = pickProjectTopic(userId, profile, project, todo.title)
      const from = moveTodoToTopic(userId, profile, todo, project, oldTopic, picked)
      if (oldTopic) {
        db.addTopicMessage(userId, profile, oldTopic.id, {
          kind: 'system',
          text: `归属修复：#${todo.number} ${todo.title} 属于项目 ${project.name}，已转到该项目的话题「${picked.title}」。本话题不再收到它的进展；历史消息保留。`,
          todoId: todo.id,
          progressNotice: `归属修复：#${todo.number} 已转到项目 ${project.name} 的话题`,
        })
      }
      db.addTopicMessage(userId, profile, picked.topicId, {
        kind: 'system',
        text: `归属修复：#${todo.number} ${todo.title} 从${from}转入本话题。之后它的进展通知到这里${picked.unattended ? '；本话题没有总管会话，进展只记录不唤醒，在这里发一条消息即可让总管接手' : ''}。`,
        todoId: todo.id,
        progressNotice: `归属修复：#${todo.number} 已转入本话题`,
      })
      return picked
    })
    log?.info?.('Todo moved to a topic of its project', { todoId: todo.id, fromTopicId: todo.topicId, toTopicId: picked.topicId })
    emitUpdated(run, `todo.topic.repaired:${todo.id}`)
    return { todo: db.getTodo(userId, profile, todo.id), repaired: true, fromTopicId: todo.topicId, toTopicId: picked.topicId, state: await getSnapshot(run) }
  }

  // The stored part of a repair: todos.topic_id, the watches and the timeline line. Returns the phrase that
  // names where the card came from. Topic messages are written by the caller.
  function moveTodoToTopic(userId, profile, todo, project, oldTopic, picked) {
    db.setTodoTopic(userId, profile, todo.id, picked.topicId)
    // Watches from topics that are not of the card's project end; the new topic watches an unfinished card.
    for (const w of db.getActiveWatchesForTodo(userId, profile, todo.id)) {
      if (!topicOwnsProject(db.getTopic(userId, profile, w.topicId), todo.projectId)) db.clearWatch(w.topicId, todo.id)
    }
    if (todo.phase !== 'done' && todo.phase !== 'closed') db.watchTodo(userId, profile, picked.topicId, todo.id, 'Topic repaired: card moved to a topic of its project')
    const from = oldTopic ? `话题「${oldTopic.title}」（${topicProjectPhrase(userId, profile, oldTopic)}）` : (todo.topicId ? `已不存在的话题 ${todo.topicId}` : '无话题')
    db.appendTimeline(userId, profile, todo.id, `归属修复：从${from}转到项目 ${project.name} 的话题「${picked.title}」`, 'system')
    return from
  }

  /**
   * #97 repair-topic-todos: every card of one topic that is not of the topic's project is moved to a topic of
   * its own project (the same choice as repair-todo-topic; a new topic is titled with the project name).
   * dryRun: nothing is stored, the answer says what would be done (newTopicId '' for a topic that would be
   * created). Cards that are building, reviewing or merging, and cards whose project was removed, are skipped
   * with the reason. One system message per topic concerned (not one per card) plus a timeline line per card.
   * Repeating the call moves nothing more.
   * #120: a run (not dryRun) is one transaction: the topics created for projects that have none, every card
   * with its watches and timeline line, and the topic messages. A write that fails stores none of them, so
   * no card is left moved without the messages that name it, and the call can be repeated.
   */
  async function repairTopicTodos(run, { topicId, dryRun = false }) {
    const { userId, profile } = run.identity
    // A topic stored without a project is adopted before its cards are judged: judged as it is stored, every
    // card would count as foreign, the whole topic would be emptied and, holding no card, never be adopted.
    if (!dryRun) adoptOrphanTopics(run, userId, profile)
    let topic = db.getTopic(userId, profile, String(topicId || ''))
    if (!topic) throw new Error(`话题不存在：${topicId}`)
    // dryRun stores nothing, so the adoption is only assumed: the answer is what the run would do after it.
    if (dryRun && !topic.projectId && !db.hasWakeKey(topicAdoptKey(topic.id))) {
      const planned = plannedAdoption(userId, profile, topic.id, topicTodoTally(userId, profile))
      if (planned) topic = { ...topic, projectId: planned.best.project.id }
    }
    const cards = db.listTodos(userId, profile)
      .filter(td => td.topicId === topic.id && !topicOwnsProject(topic, td.projectId))
      .sort((a, b) => ((a.createdAt || 0) - (b.createdAt || 0)) || (a.number - b.number))
    const moved = []
    const skipped = []
    const targets = new Map() // projectId -> { id, title, projectId, created, unattended, count, numbers }
    const entry = (td, newTopicId, reason) => ({ id: td.id, number: td.number, title: td.title, projectId: td.projectId, oldTopicId: topic.id, newTopicId, reason })
    const listNumbers = numbers => `${numbers.slice(0, 40).map(n => `#${n}`).join('、')}${numbers.length > 40 ? ` 等 ${numbers.length} 张` : ''}`
    // Fills moved, skipped and targets; with dryRun it writes nothing.
    const migrate = () => {
      for (const td of cards) {
        const project = db.getProject(userId, profile, td.projectId)
        if (!project) { skipped.push(entry(td, '', `所属项目 ${td.projectId || '（空）'} 已不存在`)); continue }
        if (TOPIC_REPAIR_BUSY_PHASES.has(td.phase)) { skipped.push(entry(td, '', TOPIC_REPAIR_BUSY_REASON)); continue }
        let target = targets.get(project.id)
        if (!target) {
          const picked = dryRun ? planProjectTopic(userId, profile, project, project.name) : pickProjectTopic(userId, profile, project, project.name)
          target = { id: picked.topicId, title: picked.title, projectId: project.id, created: picked.created, unattended: picked.unattended, count: 0, numbers: [] }
          targets.set(project.id, target)
        }
        if (!dryRun) moveTodoToTopic(userId, profile, td, project, topic, { topicId: target.id, title: target.title })
        target.count += 1
        target.numbers.push(td.number)
        moved.push(entry(td, target.id, ''))
      }
      if (!dryRun && moved.length) {
        const parts = [...targets.values()].map(t => `${listNumbers(t.numbers)} → 项目 ${projectLabel(userId, profile, t.projectId)} 的话题「${t.title}」`)
        db.addTopicMessage(userId, profile, topic.id, {
          kind: 'system',
          text: `归属修复：本话题有 ${moved.length} 张不属于本话题项目的卡片已转到各自项目的话题：${parts.join('；')}。本话题不再收到它们的进展；历史消息保留。${skipped.length ? `另有 ${skipped.length} 张未迁移（${listNumbers(skipped.map(e => e.number))}），原因见修复结果。` : ''}`,
          progressNotice: `归属修复：${moved.length} 张卡片已转到各自项目的话题`,
        })
        for (const t of targets.values()) {
          db.addTopicMessage(userId, profile, t.id, {
            kind: 'system',
            text: `归属修复：${t.count} 张卡片（${listNumbers(t.numbers)}）从话题「${topic.title}」（${topicProjectPhrase(userId, profile, topic)}）转入本话题。之后它们的进展通知到这里${t.unattended ? '；本话题没有总管会话，进展只记录不唤醒，在这里发一条消息即可让总管接手' : ''}。`,
            progressNotice: `归属修复：${t.count} 张卡片已转入本话题`,
          })
        }
      }
    }
    if (dryRun) migrate()
    else db.transaction(migrate)
    if (!dryRun && moved.length) {
      log?.info?.('Cards of a topic moved to topics of their projects', { topicId: topic.id, moved: moved.length, skipped: skipped.length })
      emitUpdated(run, `topic.todos.repaired:${topic.id}`)
    }
    return {
      topicId: topic.id,
      dryRun: Boolean(dryRun),
      moved,
      skipped,
      topics: [...targets.values()].map(t => ({ id: t.id, title: t.title, projectId: t.projectId, created: t.created, unattended: t.unattended, count: t.count })),
    }
  }

  async function drainQueuedTodos(run, userId, profile) {
    const key = `${userId}:${profile}`
    if (drainingQueuedProfiles.has(key)) return 0
    drainingQueuedProfiles.add(key)
    try {
      const settings = db.getSettings(userId, profile, config)
      let active = db.countActiveBuilds(userId, profile)
      if (active >= settings.maxConcurrentBuilds) return 0
      const queued = db.listQueuedTodos(userId, profile)
      let launched = 0
      for (const qTodo of queued) {
        if (active >= settings.maxConcurrentBuilds) break
        if (startingTodos.has(qTodo.id)) continue
        try {
          await startBuild(run, {
            todoId: qTodo.id,
            agentId: qTodo.agentId,
            configId: qTodo.activeConfigId,
            withPlan: qTodo.withPlan,
          })
          active += 1
          launched += 1
        } catch (err) {
          log?.warn?.('drainQueuedTodos skipped todo', { todoId: qTodo.id, error: err?.message || String(err) })
        }
      }
      return launched
    } finally {
      drainingQueuedProfiles.delete(key)
    }
  }

  /**
   * 0.9.48: refuse a write on a card. `note` writes the reason on the card timeline (the dispatching entries);
   * without it nothing on the card changes. The error carries `todoFailureRecorded` when the note was written,
   * so callers that record launch failures do not write a second line.
   */
  function refuseTodoWrite(run, todo, text, { note = false } = {}) {
    if (note) {
      const { userId, profile } = run.identity
      db.appendTimeline(userId, profile, todo.id, text, 'system')
      emitUpdated(run, `todo.write.refused:${todo.id}`)
    }
    const err = new Error(`${text}，请稍后再试。`)
    err.code = 'TODO_BUSY'
    if (note) err.todoFailureRecorded = true
    throw err
  }

  /**
   * 0.9.48: take the write lock of a card or refuse. Never waits. `label` names the operation for whoever is
   * refused while it runs; `outcome` ends the refusal text (「本次派发没有发出」). Returns the lock object:
   * the caller releases exactly that object in a `finally` (dropTodoWriteLock), so a holder whose lock expired
   * and was taken over does not release the next holder's lock.
   */
  function lockTodoForWrite(run, todo, label, outcome, { note = false } = {}) {
    const now = clock()
    const held = todoWriteLocks.get(todo.id)
    if (held && now - Number(held.acquiredAt || 0) < TODO_WRITE_LOCK_TTL_MS) {
      refuseTodoWrite(run, todo, `#${todo.number} 正在执行「${held.label}」，本次${outcome}`, { note })
    }
    const lock = { owner: `${label}#${++todoWriteLockSeq}`, acquiredAt: now, label }
    todoWriteLocks.set(todo.id, lock)
    return lock
  }

  function dropTodoWriteLock(todoId, lock) {
    if (lock && todoWriteLocks.get(todoId) === lock) todoWriteLocks.delete(todoId)
  }

  /**
   * 0.9.49: does this operation still hold the write lock of the card? False once the lock expired and another
   * write took the card over. A holder releases its lock only in its own `finally`, after its last write, so a
   * lock that is released normally is never seen as taken over. Asked after every long await, before the card
   * is written.
   */
  function stillOwnsWrite(todoId, lock) {
    return Boolean(lock) && todoWriteLocks.get(todoId) === lock
  }

  const WRITE_DISCARDED_NOTE = '本轮结果已丢弃：这张卡在等待期间被另一个写操作接管'

  /**
   * 0.9.49: what an operation does instead of writing a card it no longer owns: one timeline line (`detail`
   * says what was dropped) and the card as it really is now. Returns null when the card is gone.
   */
  function discardStaleWrite(run, userId, profile, todoId, detail = '') {
    db.appendTimeline(userId, profile, todoId, `${WRITE_DISCARDED_NOTE}${detail ? `（${detail}）` : ''}`, 'system')
    emitUpdated(run, `todo.write.discarded:${todoId}`)
    return db.getTodo(userId, profile, todoId) || null
  }

  /**
   * 0.9.49: a settle takes no write lock (it must not block stop / close / an instruction while a test gate
   * runs), so it asks the card instead. `seen` is the card as the settle read it when it started. The settle
   * is superseded when the card is gone, left the phase it is settling, got another session or run, or when
   * another write holds the card right now (its lock is in the table and not expired).
   */
  function settleSuperseded(userId, profile, seen) {
    const cur = db.getTodo(userId, profile, seen.id)
    if (!cur) return true
    if (cur.phase !== seen.phase
      || cur.buildSessionId !== seen.buildSessionId || cur.buildRunId !== seen.buildRunId
      || cur.reviewSessionId !== seen.reviewSessionId || cur.reviewRunId !== seen.reviewRunId) return true
    const held = todoWriteLocks.get(seen.id)
    return Boolean(held) && clock() - Number(held.acquiredAt || 0) < TODO_WRITE_LOCK_TTL_MS
  }

  async function startBuild(run, { todoId, agentId, configId, withPlan, extraMessage, instructionKind = '', fresh = false, forceNewSession = false, idleNudge = false }) {
    const { userId, profile } = run.identity
    let todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    // 0.9.42: a second start while one is under way is refused with a reason instead of answering with the
    // unchanged card (which callers took for "dispatched").
    if (startingTodos.has(todoId)) {
      throw new Error(`#${todo.number} 的构建还在启动中，这次操作没有发出，请稍后再试。`)
    }
    // 0.9.48: nothing is dispatched into a card that is being merged (a fresh restart would remove the
    // worktree under the merge), and one write at a time per card.
    if (todo.phase === 'merging' || mergingTodos.has(todoId)) {
      refuseTodoWrite(run, todo, `#${todo.number} 正在合并，本次派发没有发出`, { note: true })
    }
    const writeLock = lockTodoForWrite(run, todo, '构建派发', '派发没有发出', { note: true })
    startingTodos.add(todoId)
    const launchStartedAt = Date.now()
    try {
      return await startBuildInner(run, { userId, profile, todo, agentId, configId, withPlan, extraMessage, instructionKind, fresh, forceNewSession, writeLock, idleNudge })
    } finally {
      startingTodos.delete(todoId)
      dropTodoWriteLock(todoId, writeLock)
      buildSlotReservations.get(`${userId}:${profile}`)?.delete(todoId)
      warnSlowLaunch('worker run', launchStartedAt, { todoId })
    }
  }

  /**
   * #107: `extraMessage` is the instruction this dispatch carries (message_todo, request_changes, a queued
   * instruction, an internal nudge); `instructionKind` names the entry that sent it (todo_queue kinds) and is
   * empty for internal nudges. An instruction is never dropped on the way: a dispatch that has to wait for a
   * build slot stores it in `todo_queue` and the start out of `queued` takes it from there; a `message` /
   * `changes` instruction to a card that is not `building` is sent as buildFollowUpPrompt (instruction + report
   * of the round before + full task prompt), not as the bare text.
   */
  async function startBuildInner(run, { userId, profile, todo, agentId, configId, withPlan, extraMessage, instructionKind = '', fresh = false, forceNewSession = false, writeLock, idleNudge = false }) {
    const project = db.getProject(userId, profile, todo.projectId)
    if (!project) throw new Error(`Project not found: ${todo.projectId}`)

    // Idempotent dispatch: if this todo's build session is still running, re-attach instead of sending a
    // second run into a busy session (the host blocks it until timeout and then reports a false failure).
    if (todo.buildSessionId && !fresh && !forceNewSession && !extraMessage
      && ['building', 'failed', 'queued', 'todo'].includes(todo.phase)) {
      let live = Boolean(sessionActivity.get(todo.buildSessionId)?.running)
      if (!live) {
        const probe = await probeSessionWorking(run, todo.buildSessionId, { timeoutMs: 2500 }).catch(() => null)
        live = Boolean(probe?.known && probe.isWorking)
        if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '构建派发')
      }
      if (live) {
        const wasPhase = todo.phase
        db.updateTodo(userId, profile, todo.id, {
          phase: 'building', gateOwner: 'chief', gateKind: 'none', lastError: '',
        })
        db.appendTimeline(userId, profile, todo.id,
          wasPhase === 'building' ? '构建仍在运行，忽略重复派发' : '构建会话仍在运行，已接回（不重复派发）', 'orchestrator')
        emitUpdated(run, `todo.reattached:${todo.id}`)
        return db.getTodo(userId, profile, todo.id)
      }
    }

    // 0.9.49: the state machine decides before anything is parked, removed or cleared. A dispatch it refuses
    // (a card that is being reviewed) throws here and leaves worktree, branch, snapshot and diffs as they were;
    // earlier a `fresh` restart removed the worktree and the branch first, and a full queue parked the card.
    const eventType = todo.phase === 'confirm' && !todo.question?.active
      ? 'CONFIRM_PLAN'
      : todo.phase === 'failed'
        ? (fresh ? 'RETRY_FRESH' : 'RETRY_CONTINUE')
        : 'START_BUILD'
    const nextPhase = todo.phase === 'building' ? 'building' : transitionTodoPhase(todo.phase, eventType)
    // #104: a finished card that is dispatched again starts without the watches it had (before the round is
    // parked or launched); the dispatch below watches it from its own topic only.
    clearStaleWatches(userId, profile, todo)

    const settings = db.getSettings(userId, profile, config)
    const slotKey = `${userId}:${profile}`
    if (!buildSlotReservations.has(slotKey)) buildSlotReservations.set(slotKey, new Set())
    const reservedSlots = buildSlotReservations.get(slotKey)
    const occupied = new Set([...db.listActiveBuildTodoIds(userId, profile), ...reservedSlots])
    occupied.delete(todo.id)
    const activeCount = occupied.size
    if (todo.phase !== 'building' && activeCount >= settings.maxConcurrentBuilds) {
      // Todos-grade concurrency queue: park cleanly in 'queued' instead of throwing and aborting Chief!
      const liveEngines = await probeLiveEngines(run)
      const agents = db.ensureDefaultAgents(userId, profile, liveEngines)
      const assignedAgent = agents.find(a => a.id === db.resolveAgentId(userId, profile, agentId || todo.agentId || project.ownerAgentId))
        || agents.find(a => a.role === 'builder')
        || agents[0]
      if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '构建派发（排队）')
      // #107: the instruction of this dispatch waits with the card. It was dropped here before: the card left
      // the queue with the task prompt only and the worker never saw the instruction.
      const parkedText = extraMessage ? String(extraMessage) : ''
      if (parkedText.length > MAX_QUEUED_TEXT_CHARS) {
        const reason = `并发槽位已满（${activeCount}/${settings.maxConcurrentBuilds}），指令需要排队，但内容 ${parkedText.length} 字超过排队上限 ${MAX_QUEUED_TEXT_CHARS} 字`
        db.appendTimeline(userId, profile, todo.id, `指令没有送达：${reason}。卡片未改动，请精简后重发，或等有空槽位时再发`, 'system')
        emitUpdated(run, `todo.message.failed:${todo.id}`)
        const err = new Error(`#${todo.number} 的指令没有送达：${reason}。请精简后重发，或等有空槽位时再发。`)
        err.todoFailureRecorded = true
        throw err
      }
      if (parkedText) db.enqueueTodoItem(userId, profile, todo.id, { kind: instructionKind || 'message', text: parkedText })
      const queuedPhase = canTransition(todo.phase, 'ENQUEUE') ? transitionTodoPhase(todo.phase, 'ENQUEUE') : 'queued'
      const queuedTodo = db.updateTodo(userId, profile, todo.id, {
        phase: queuedPhase,
        gateOwner: 'chief',
        gateKind: 'queued',
        withPlan: withPlan !== undefined ? Boolean(withPlan) : Boolean(todo.withPlan),
        agentId: assignedAgent.id,
        ...(configId ? { activeConfigId: configId } : {}),
        lastError: '',
      })
      db.appendTimeline(
        userId,
        profile,
        todo.id,
        `并发槽位已满（${activeCount}/${settings.maxConcurrentBuilds}），已进入排队队列，空出槽位后自动启动${parkedText ? `；本次指令（${parkedText.length} 字）已随卡片保存，启动时与原任务书一并下达` : ''}`,
        'orchestrator',
      )
      emitUpdated(run, `todo.queued:${todo.id}`)
      return queuedTodo
    }
    // Claim the slot synchronously (no await since the check) so parallel dispatches see it.
    reservedSlots.add(todo.id)

    if (fresh && todo.worktreePath) {
      await removeWorktree({ repoPath: project.repoPath, worktreePath: todo.worktreePath, branchName: todo.branch, deleteBranch: true }).catch(() => {})
      // 0.9.49: taken over while the old worktree was being removed. The removal cannot be undone; the card
      // is not written, the line says what is gone.
      if (!stillOwnsWrite(todo.id, writeLock)) {
        return discardStaleWrite(run, userId, profile, todo.id, `构建派发（全新重试）：旧工作树 ${todo.worktreePath}${todo.branch ? ` 与分支 ${todo.branch}` : ''} 已删除但未记入卡片`)
      }
      todo = db.updateTodo(userId, profile, todo.id, {
        worktreePath: '',
        branch: '',
        baseCommit: '',
        snapshotSha: '',
        buildSessionId: '',
        buildRunId: '',
        diffs: [],
        lastError: '',
      })
    }

    const liveEngines = await probeLiveEngines(run)
    // 0.9.49: the engine probe can hang in the host. Taken over meanwhile: nothing has been created yet.
    if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '构建派发')
    const agents = db.ensureDefaultAgents(userId, profile, liveEngines)
    // A shortened board id of an older over-long agent resolves to its stored row.
    const assignedAgent = agents.find(a => a.id === db.resolveAgentId(userId, profile, agentId || todo.agentId || project.ownerAgentId))
      || agents.find(a => a.role === 'builder')
      || agents[0]

    const branchName = todo.branch || `ekko-todo/${project.id.replace(/[^a-z0-9-]/gi, '')}-${todo.number}`
    const wtName = `${project.id}-${todo.number}-${todo.id.slice(-4)}`
    const wt = await ensureWorktree({
      repoPath: project.repoPath,
      worktreesDir,
      worktreeName: wtName,
      branchName,
      baseBranch: project.defaultBranch,
    })

    const effectiveWithPlan = withPlan !== undefined ? Boolean(withPlan) : Boolean(todo.withPlan)
    let { config: activeCfg, index: cfgIdx } = resolveActiveConfig(assignedAgent, configId || todo.activeConfigId)
    let needFreshSession = forceNewSession || fresh || (todo.engine && todo.engine !== activeCfg.engine)

    // 0.9.47: where the worktree stands as this round starts (HEAD + the tree of the files on disk). The
    // settle of the round compares against it to tell a round that produced nothing. Read twice at most;
    // when it cannot be read the round carries no baseline and its output is not judged.
    let roundBase = null
    for (let attempt = 0; attempt < 2 && !roundBase; attempt += 1) {
      const state = await readWorktreeState({ worktreePath: wt.worktreePath }).catch(() => null)
      if (state?.headSha && state?.treeSha) roundBase = state
    }

    // 0.9.49: the write below moves the card to `building` and resets verdict, gate and question. Taken over
    // while the worktree was created or read: the card is not written; the worktree stays on disk (it may be
    // the card's own, reused) and the line names it.
    if (!stillOwnsWrite(todo.id, writeLock)) {
      return discardStaleWrite(run, userId, profile, todo.id, `构建派发：工作树 ${wt.worktreePath} 已建好但未记入卡片，分支 ${wt.branchName}`)
    }
    // #78: the write below empties `testFailures`. The names of the round before go to the timeline first, so a
    // flaky red stays traceable after the card is sent back to work. Nothing is written when there were none.
    const prevFailures = Array.isArray(todo.evidence?.testFailures) ? todo.evidence.testFailures.filter(Boolean) : []
    if (prevFailures.length) {
      const total = Math.max(Number(todo.evidence.testFailureCount) || 0, prevFailures.length)
      const listed = prevFailures.slice(0, 5).map(n => clipChars(n, 120)).join('、')
      const round = (db.getTodo(userId, profile, todo.id)?.timeline || []).filter(e => String(e?.event || '').startsWith('上一次门禁失败')).length + 1
      const sha = String(todo.evidence.commitSha || '').slice(0, 7)
      db.appendTimeline(userId, profile, todo.id,
        `上一次门禁失败（第 ${round} 轮${sha ? `，提交 ${sha}` : ''}）：${listed}${total > 5 ? ` 等 ${total} 条` : ''}（共 ${total} 条；本轮重新构建，结果待定）`,
        'system')
    }
    const updatedPre = db.updateTodo(userId, profile, todo.id, {
      phase: nextPhase,
      gateOwner: 'chief',
      gateKind: 'none',
      withPlan: effectiveWithPlan,
      agentId: assignedAgent.id,
      engine: activeCfg.engine,
      activeConfigId: activeCfg.id,
      branch: wt.branchName,
      worktreePath: wt.worktreePath,
      baseCommit: todo.baseCommit || wt.baseCommit,
      lastError: '',
      question: { ...todo.question, active: false },
      // #103: the commit the last review was bound to goes with its verdict.
      reviewedSha: '',
      // Any new build run invalidates the previous review verdict; merge gates re-check it.
      evidence: {
        reviewVerdict: 'none',
        reviewDrift: '',
        unreviewedMergeAsk: '',
        reviewInconclusiveRetries: 0,
        reviewInconclusiveTurn: '',
        roundBaseSha: roundBase?.headSha || '',
        roundBaseTree: roundBase?.treeSha || '',
        gateSkipped: '',
        // The report of an earlier text round is not this round's.
        deliverable: '',
        deliverableChars: 0,
        workerReport: '',
        // #105 (audit #95 P1-5): `idleNudges` is NOT reset by a dispatch. A manual run_build, a queued
        // instruction, an idle rerun on another config and the nudge itself all keep it; only a productive
        // round (commit / changed tree, plan, deliverable, evidence report) or the end of the chain (the card
        // fails as idle) sets it back to 0, with a timeline line (see idleCountReset).
        // The test result of the round before is not this round's: the card shows "not run" until it is.
        testRc: -1,
        testSummary: '',
        testFailures: [],
        testFailureCount: 0,
      },
    })
    if (!roundBase) db.appendTimeline(userId, profile, todo.id, '本轮无法确定基线，跳过产出校验', 'orchestrator')

    const memories = assignedAgent.memoryEnabled
      ? collectRelevantMemories(userId, profile, { projectId: project.id, agentId: assignedAgent.id })
      : []
    const repoGuidelines = readRepoGuidelines(wt.worktreePath)

    // #107: what this round is told. `parked`: instructions stored while the card waited for a build slot
    // (they leave todo_queue only after the launch is accepted, so a failed launch does not lose them).
    let instructionText = extraMessage ? String(extraMessage) : ''
    let instructionOrigin = instructionKind
    const parked = !instructionText && todo.phase === 'queued' ? db.listTodoQueue(userId, profile, todo.id) : []
    if (parked.length) {
      instructionText = parked.map(i => i.text).join('\n\n---\n\n')
      instructionOrigin = parked[parked.length - 1].kind || 'message'
    }
    // The report of the round before, read from the card as it was before the write above emptied it.
    const previousReport = String(todo.evidence?.workerReport || todo.evidence?.deliverable || '').trim() || workerFinalReport(todo)
    const basePrompt = () => buildWorkerPrompt({
      todo: updatedPre,
      project,
      withPlan: effectiveWithPlan,
      memories,
      repoGuidelines,
      linkedDeps: wt.linkedDeps || [],
    })
    const followUpPrompt = () => buildFollowUpPrompt({
      todo: updatedPre,
      basePrompt: basePrompt(),
      message: instructionText,
      previousReport,
      trigger: FOLLOW_UP_TRIGGERS[instructionOrigin] || 'message_todo',
    })
    // The bare text is enough only for a worker that is in the middle of this task in the same session.
    let followUp = Boolean(instructionText) && (parked.length > 0
      || (['message', 'changes'].includes(instructionOrigin) && (todo.phase !== 'building' || Boolean(needFreshSession))))
    let prompt = !instructionText ? basePrompt() : followUp ? followUpPrompt() : instructionText

    let sessionId = updatedPre.buildSessionId
    let launched = null
    for (let attempt = 0; attempt < Math.max(1, assignedAgent.modelConfigs.length); attempt += 1) {
      try {
        sessionId = await ensureSessionForConfig(run, {
          existingSessionId: sessionId,
          title: `[Ekko ToDo #${todo.number}] ${todo.title}`,
          cfg: activeCfg,
          workspace: wt.worktreePath,
          forceNew: needFreshSession,
        })
        const runOptions = {
          wait: false,
          workspace: wt.worktreePath,
          // 0.9.57: an agent without a system prompt sent `instructions: undefined`, which the host refuses
          // ("value.instructions: expected JSON data") and the card failed at launch.
          ...(assignedAgent.systemPrompt ? { instructions: assignedAgent.systemPrompt } : {}),
          ...buildRunModelOptions(activeCfg, assignedAgent),
        }
        launched = await launchSessionRun(run, sessionId, prompt, runOptions)
        break
      } catch (err) {
        const errText = err?.message || String(err)
        // 0.9.49: the launch hung past the lock TTL and another write took the card over: nothing is recorded.
        if (!stillOwnsWrite(todo.id, writeLock)) {
          return discardStaleWrite(run, userId, profile, todo.id, `构建派发未成功：${clipQueued(errText)}`)
        }
        // #64 (C06): a queued card launched with a handle whose call has ended (a drain after a long gate).
        // The host refused because the handle is gone, not because the build cannot start: the card goes back
        // to the queue and the next scheduler tick (reconcile → drainQueuedTodos) starts it with a fresh handle.
        if (todo.phase === 'queued' && run?.signal?.aborted) {
          db.updateTodo(userId, profile, todo.id, { phase: 'queued', gateOwner: 'chief', gateKind: 'queued', lastError: '' })
          db.appendTimeline(userId, profile, todo.id, '排队启动未发出：发起这次启动的插件调用已结束，卡片仍在排队，下一次调度时用新连接启动', 'system')
          log?.warn?.(`Queued todo launch refused because the calling handle ended; kept queued: ${errText.slice(0, 200)}`, { todoId: todo.id })
          err.todoFailureRecorded = true
          throw err
        }
        const classified = classifyModelFailure(errText)
        if (!assignedAgent.autoFallback || !classified.switchable) {
          db.updateTodo(userId, profile, todo.id, { phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError: errText })
          db.appendTimeline(userId, profile, todo.id, `启动失败：${errText}`, 'system')
          throw err
        }
        db.recordConfigFailure(assignedAgent.id, activeCfg.id, classified.category, errText)
        const next = selectNextFallbackConfig({
          agent: assignedAgent,
          failedConfigId: activeCfg.id,
          cooldowns: db.listAgentCooldowns(assignedAgent.id),
        })
        if (!next) {
          db.updateTodo(userId, profile, todo.id, { phase: 'failed', gateOwner: 'human', gateKind: 'failed', lastError: `主备模型均失败：${errText}` })
          db.appendTimeline(userId, profile, todo.id, `主备配置均不可用：${errText}`, 'system')
          throw err
        }
        const curFresh = db.getTodo(userId, profile, todo.id)
        const hist = [...(curFresh.fallbackHistory || []), {
          at: Date.now(),
          fromConfigId: activeCfg.id,
          toConfigId: next.config.id,
          category: classified.category,
          reason: classified.label,
        }].slice(-12)
        db.updateTodo(userId, profile, todo.id, {
          engine: next.config.engine,
          activeConfigId: next.config.id,
          fallbackHistory: hist,
        })
        db.appendTimeline(
          userId,
          profile,
          todo.id,
          `${formatConfigLabel(activeCfg, cfgIdx)} 触发「${classified.label}」，已自动切换至 ${formatConfigLabel(next.config, next.index)}`,
          'failover',
        )
        activeCfg = next.config
        cfgIdx = next.index
        sessionId = ''
        needFreshSession = true
        // #107: the next attempt opens a new session, which knows nothing of the task: the bare instruction
        // is not enough there.
        if (instructionText && instructionOrigin && !followUp) { followUp = true; prompt = followUpPrompt() }
      }
    }

    // 0.9.49: same as above for a launch that came back late: session, run id and dispatch line are not written.
    if (!stillOwnsWrite(todo.id, writeLock)) {
      return discardStaleWrite(run, userId, profile, todo.id, '构建派发')
    }

    // 0.9.42: the host refused an instruction because the session already runs a turn. The text never reached
    // the worker: that is a failed delivery, not "already working".
    if (launched?.alreadyRunning && instructionText) {
      const errText = '宿主拒绝了这条指令：执行者会话已有运行中的轮次（already running），指令没有送达，请等本轮结束后再发。'
      // 0.9.47: no round was started, so the turn that is still running keeps the baseline it started with.
      db.updateTodo(userId, profile, todo.id, {
        buildSessionId: sessionId,
        lastError: errText,
        evidence: { roundBaseSha: todo.evidence?.roundBaseSha || '', roundBaseTree: todo.evidence?.roundBaseTree || '' },
      })
      db.appendTimeline(userId, profile, todo.id, `指令没有送达：${errText}`, 'system')
      emitUpdated(run, `todo.message.failed:${todo.id}`)
      const err = new Error(errText)
      err.todoFailureRecorded = true
      throw err
    }

    const buildRunId = String(launched?.run_id || launched?.queue_id || '')
    const now = Date.now()
    sessionActivity.set(sessionId, {
      running: true,
      startedAt: now,
      updatedAt: now,
      activeTool: '',
      toolCount: 0,
      stage: effectiveWithPlan ? 'planning' : 'building',
    })
    db.updateTodo(userId, profile, todo.id, {
      engine: activeCfg.engine,
      activeConfigId: activeCfg.id,
      buildSessionId: sessionId,
      buildRunId,
    })
    db.appendTimeline(
      userId,
      profile,
      todo.id,
      `派发${effectiveWithPlan ? '方案规划' : '构建'}至 ${assignedAgent.name} · ${formatConfigLabel(activeCfg, cfgIdx)} · 分支 ${wt.branchName}`,
      'orchestrator',
    )
    // #107: the launch was accepted, so the parked instructions are delivered and leave the queue; the card
    // says what started this round and quotes the instruction, so user and Chief see that it arrived.
    for (const item of parked) db.removeTodoQueueItem(userId, profile, todo.id, item.id)
    if (instructionText && instructionOrigin) {
      db.appendTimeline(userId, profile, todo.id,
        `本轮由 ${FOLLOW_UP_TRIGGERS[instructionOrigin] || 'message_todo'} 触发，追加要求 ${instructionText.length} 字${followUp ? '，已与原任务书、上一轮报告一并下达' : '，已投递到当前会话（未重启）'}${parked.length ? `（排队期间保存的 ${parked.length} 条）` : ''}：${clipInstruction(instructionText)}`,
        'orchestrator')
    }

    watchOwnTopic(userId, profile, todo, 'Dispatched build: wake at gate or settlement')
    emitUpdated(run, `todo.build.started:${todo.id}`)
    return db.getTodo(userId, profile, todo.id)
  }

  async function runIndependentReview(run, { todoId, reviewerAgentId }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    // 0.9.48: one write at a time per card (see todoWriteLocks); held until the review run is launched.
    const writeLock = lockTodoForWrite(run, todo, '审查派发', '审查派发没有发出', { note: true })
    try {
      return await runIndependentReviewInner(run, { userId, profile, todo, reviewerAgentId, writeLock })
    } finally {
      dropTodoWriteLock(todoId, writeLock)
      // 0.9.49 (#46): the review run ended while its launch call was still out. The event could not be
      // settled then (this dispatch held the card and had not written the run yet), so it is settled now,
      // from the start, on the card as the dispatch left it. The settle checks the card itself: after a
      // launch that failed and was rolled back, or a takeover, it finds no `reviewing` card with this
      // session and writes nothing.
      const launch = reviewLaunches.get(todoId)
      if (launch && launch.lock === writeLock) {
        reviewLaunches.delete(todoId)
        if (launch.earlySettle) {
          void settleWorkerRun(run, userId, profile, todoId, launch.earlySettle).catch(err => {
            log?.warn?.('Review run that ended during its launch was not settled', { todoId, error: err?.message || String(err) })
          })
        }
      }
    }
  }

  async function runIndependentReviewInner(run, { userId, profile, todo, reviewerAgentId, writeLock }) {
    const project = db.getProject(userId, profile, todo.projectId)
    if (!project) throw new Error(`Project not found: ${todo.projectId}`)

    const nextPhase = transitionTodoPhase(todo.phase, 'START_REVIEW')

    // #103: a review is bound to a commit, so what the worktree holds uncommitted is committed first (the
    // merge used to do this itself, after the review). The reviewer then reads, and the merge takes, one
    // and the same commit. A commit that fails is reported below: such a card cannot be merged on the review.
    let precommit = null
    if (todo.worktreePath) {
      precommit = await commitWorktreeChanges({
        worktreePath: todo.worktreePath,
        message: `chore(ekko-todo): #${todo.number} commit pending changes before review`,
      }).catch(err => ({ committed: false, count: 0, headSha: '', error: String(err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 200) }))
      if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '审查派发')
      if (precommit.committed) {
        db.appendTimeline(userId, profile, todo.id, `派审查前工作树有 ${precommit.count} 项未提交改动，已提交为 ${precommit.headSha.slice(0, 12)}（审查与合并都以这个提交为准）`, 'system')
      }
    }

    if (todo.worktreePath) {
      const snap = await captureWorktreeSnapshot({
        repoPath: project.repoPath,
        worktreePath: todo.worktreePath,
        baseCommit: todo.baseCommit,
        baseBranch: project.defaultBranch,
        snapshotRefName: todo.id,
      }).catch(() => null)
      if (snap && stillOwnsWrite(todo.id, writeLock)) {
        db.updateTodo(userId, profile, todo.id, {
          snapshotSha: snap.snapshotSha,
          diffs: snap.diffs,
          evidence: {
            commitSha: snap.snapshotSha,
            filesChanged: snap.filesChanged,
            additions: snap.additions,
            deletions: snap.deletions,
          },
        })
      }
    }
    // #103: the review is bound to the commit the worktree stands on now. The reviewer works in this same
    // worktree, so the merge gate later asks whether the branch is still this commit, with nothing uncommitted.
    let reviewedSha = ''
    let dirtyAtDispatch = 0
    if (todo.worktreePath) {
      const binding = await readReviewBinding({ repoPath: project.repoPath, worktreePath: todo.worktreePath, branchName: todo.branch }).catch(() => null)
      reviewedSha = binding?.headSha || ''
      dirtyAtDispatch = binding?.dirtyCount || 0
    }
    // 0.9.49: taken over while the snapshot was read: no review is launched for a card somebody else owns.
    if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '审查派发')

    const fresh = db.getTodo(userId, profile, todo.id)
    const agents = db.listAgents(userId, profile)
    const reviewer = agents.find(a => a.id === (reviewerAgentId || fresh.reviewerId || project.reviewerAgentId))
      || agents.find(a => a.role === 'reviewer')
      || agents.find(a => a.id !== fresh.agentId)
      || agents[0]

    const { config: revCfg } = resolveActiveConfig(reviewer)
    const sessionId = await ensureSessionForConfig(run, {
      existingSessionId: fresh.reviewSessionId,
      title: `[Ekko ToDo 审查 #${fresh.number}] ${fresh.title}`,
      cfg: revCfg,
      workspace: fresh.worktreePath || project.repoPath,
    })

    const memories = reviewer.memoryEnabled
      ? collectRelevantMemories(userId, profile, { projectId: project.id, agentId: reviewer.id })
      : []

    // #77: the stored copies are capped (buildChat 4000/entry, workerReport 3000), so the report the
    // reviewer needs — evidence tables, conclusions — was cut before it was ever stored. Read this
    // round's final reply from the build session instead of quoting the cut copy.
    let workerReport = ''
    let workerReportSource = 'stored'
    try {
      const res = fresh.buildSessionId
        ? await run.host.sessions.messages(fresh.buildSessionId, { limit: 60 })
        : null
      const full = res ? currentTurnOutput(normalizeHostMessages(res)) : ''
      if (full) { workerReport = full; workerReportSource = 'session' }
    } catch (err) {
      try { log?.warn?.('build transcript read for review prompt failed; using the stored copy', { todoId: fresh.id, error: String(err?.message || err).slice(0, 200) }) } catch {}
      workerReportSource = 'stored-read-failed'
    }
    const prompt = buildReviewPrompt({ todo: fresh, project, memories, workerReport, workerReportSource })
    const runOptions = {
      wait: false,
      workspace: fresh.worktreePath || project.repoPath,
      ...(reviewer.systemPrompt ? { instructions: reviewer.systemPrompt } : {}),
      ...buildRunModelOptions(revCfg, reviewer),
    }

    // 0.9.49 (#46): creating the session is a host call. Taken over meanwhile: nothing is written or launched.
    if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '审查派发')
    // 0.9.49 (#46): the card is `reviewing` with its review session BEFORE the run is launched. Written after
    // the launch (as before), a review that ended at once was reported while the card was still `review`
    // (and, for a first review, had no review session to be found by): the report was ignored and only the
    // reconcile could settle the card. `before` is what a failed launch puts back.
    const before = {
      phase: fresh.phase,
      gateOwner: fresh.gateOwner,
      gateKind: fresh.gateKind,
      reviewerId: fresh.reviewerId,
      reviewSessionId: fresh.reviewSessionId,
      reviewRunId: fresh.reviewRunId,
      reviewedSha: fresh.reviewedSha || '',
      evidence: {
        reviewVerdict: fresh.evidence?.reviewVerdict || 'none',
        reviewDrift: String(fresh.evidence?.reviewDrift || ''),
        // #47's ask-once count is reset by the write below; a failed launch puts the old count back too.
        reviewInconclusiveRetries: Number(fresh.evidence?.reviewInconclusiveRetries) || 0,
        reviewInconclusiveTurn: String(fresh.evidence?.reviewInconclusiveTurn || ''),
      },
    }
    db.updateTodo(userId, profile, todo.id, {
      phase: nextPhase,
      gateOwner: 'chief',
      gateKind: 'review',
      reviewerId: reviewer.id,
      reviewSessionId: sessionId,
      reviewRunId: '',
      reviewedSha,
      // 0.9.49 (#47): every review dispatch may ask once for a missing verdict.
      evidence: { reviewVerdict: 'pending', reviewInconclusiveRetries: 0, reviewInconclusiveTurn: '', reviewDrift: '', unreviewedMergeAsk: '' },
    })
    const launch = { lock: writeLock, sessionId, earlySettle: null }
    reviewLaunches.set(todo.id, launch)
    emitUpdated(run, `todo.review.launching:${todo.id}`)

    let launched
    try {
      launched = await launchSessionRun(run, sessionId, prompt, runOptions)
    } catch (err) {
      const errText = String(err?.message || err).replace(/\s+/g, ' ').trim()
      // Taken over while the launch was out: the card is the new holder's and is not put back.
      if (!stillOwnsWrite(todo.id, writeLock)) {
        discardStaleWrite(run, userId, profile, todo.id, `审查派发未成功：${clipQueued(errText)}`)
        throw err
      }
      // No review runs: the card goes back to where it was (phase, gate, reviewer, session, verdict).
      db.updateTodo(userId, profile, todo.id, before)
      db.appendTimeline(userId, profile, todo.id, `审查派发未成功，卡片保持原状：${errText.slice(0, 300)}`, 'system')
      emitUpdated(run, `todo.review.launch_failed:${todo.id}`)
      throw err
    }
    // 0.9.49: the launch hung past the lock TTL and another write took the card over. The card is the new
    // holder's: neither the run id nor the dispatch line is written. The review run that did start settles
    // only if the card is still `reviewing` with this session.
    if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '审查派发')
    const reviewRunId = String(launched?.run_id || launched?.queue_id || '')
    // A run that was already reported as ended is not shown as running.
    if (!launch.earlySettle) {
      const now = Date.now()
      sessionActivity.set(sessionId, {
        running: true,
        startedAt: now,
        updatedAt: now,
        activeTool: '',
        toolCount: 0,
        stage: 'reviewing',
      })
    }

    db.updateTodo(userId, profile, todo.id, { reviewRunId })
    db.appendTimeline(userId, profile, todo.id, `派发独立只读审查至 ${reviewer.name} (${revCfg.engine})${reviewedSha ? `，被审提交 ${reviewedSha.slice(0, 12)}` : ''}`, 'orchestrator')
    if (dirtyAtDispatch > 0) {
      db.appendTimeline(userId, profile, todo.id, `派审查时工作树有 ${dirtyAtDispatch} 项未提交改动没能提交${precommit?.error ? `（${precommit.error}）` : ''}：审查只绑定已提交的 ${reviewedSha.slice(0, 12)}，这些改动不在被审提交里，提交并重新审查前不能合并`, 'system')
    }
    watchOwnTopic(userId, profile, todo, 'Dispatched independent review')
    emitUpdated(run, `todo.review.started:${todo.id}`)
    return db.getTodo(userId, profile, todo.id)
  }

  // 0.9.46: what a failed build run is recorded and classified with. The text of the host event is used when
  // it names a cause. When it is empty or only the plugin's own fallback wording, the cause is looked up:
  // the error fields of the host session, then the transcript of the turn (no assistant text at all since
  // the last instruction = the model answered with nothing, a switchable model fault). When neither gives
  // anything the run stays an unknown failure whose text names the session and the config that was used.
  async function resolveBuildFailure(run, { sessionId, errorText, failureHint, interrupted, msgRes, hostMsgs, configLabel, activeConfig = null }) {
    const given = hostErrorText(errorText)
    if (given && !BARE_FAILURE_TEXT.test(given)) return { text: given, classified: classifyModelFailure(given) }
    const hint = failureHint ? `，宿主事件 ${failureHint}` : ''
    if (interrupted) {
      return {
        text: `运行被中断，宿主没有给出错误信息（会话 ${sessionId || '未知'}${hint}）`,
        classified: { switchable: false, category: 'non_model', label: '非模型服务异常' },
      }
    }
    if (sessionId) {
      const detail = await valueWithin(Promise.resolve().then(() => run.host.sessions.get(sessionId)), 3000, null)
      const rec = detail?.session && typeof detail.session === 'object' ? detail.session : null
      for (const source of [rec, detail]) {
        if (!source || typeof source !== 'object') continue
        for (const key of ['lastError', 'last_error', 'error', 'errorMessage', 'error_message', 'failureReason', 'failure_reason']) {
          const found = hostErrorText(source[key])
          if (found && !BARE_FAILURE_TEXT.test(found)) return { text: found, classified: classifyModelFailure(found) }
        }
      }
      // An empty or unreadable transcript proves nothing: only a turn that is there and holds no assistant
      // text counts as an empty answer.
      if (msgRes && hostMsgs.length) {
        let lastUser = -1
        hostMsgs.forEach((m, i) => { if (m.role === 'user') lastUser = i })
        const turn = hostMsgs.slice(lastUser + 1)
        const answered = turn.some(m => m.role === 'assistant' && m.content.trim())
        // 0.9.57: before calling it an empty reply, ask whether the model is one the host serves at all.
        // A pair outside the catalog fails every run with 404 model_not_found and reads exactly like this.
        if (!answered && activeConfig && (!activeConfig.engine || activeConfig.engine === 'hermes') && !activeConfig.customModel) {
          const pair = normalizeModelRef({ provider: activeConfig.provider, model: activeConfig.model })
          const catalog = pair.model ? await valueWithin(getModelCatalog(run, { engine: 'hermes' }), 4000, null) : null
          const check = checkModelInCatalog(catalog, pair)
          if (check.known && !check.ok) {
            return {
              text: `模型 ${pair.provider ? `${pair.provider}/` : ''}${pair.model} 不在 Studio 可用模型目录中（宿主请求返回 404 model_not_found），本轮没有执行${check.suggestions.length ? `；目录里相近的有：${check.suggestions.join('、')}` : ''}。请在 Agent 设置里改成目录中的模型（会话 ${sessionId}）`,
              classified: { switchable: true, category: 'model_unavailable', label: '模型不在可用目录' },
            }
          }
        }
        if (!answered && turn.some(m => m.role === 'failed_turn')) {
          return {
            text: `宿主判定本轮请求失败，模型没有给出任何输出（宿主写入「Your request was not processed」，未附原因；常见原因是模型名无效、凭据失效或上游拒绝；会话 ${sessionId}${hint}）`,
            classified: { switchable: true, category: 'host_failed_turn', label: '宿主拒绝本轮请求' },
          }
        }
        if (!answered) {
          return {
            text: `宿主没有给出错误信息，本轮会话没有任何助手文本输出（空响应；会话 ${sessionId}${hint}）`,
            classified: classifyModelFailure('空响应'),
          }
        }
      }
    }
    return {
      text: `未能取到模型侧原始错误（会话 ${sessionId || '未知'}，配置 ${configLabel}${hint}）`,
      classified: { switchable: false, category: 'unknown', label: '运行异常' },
    }
  }

  // 0.9.47 (#36): a build round that ended normally but left HEAD and the worktree tree exactly as they were
  // when it started. This is not a model fault and is never classified by classifyModelFailure: the switch
  // decision uses this fixed object. One automatic rerun per card (evidence.idleRetries), on another config.
  const IDLE_CLASSIFIED = { switchable: true, category: 'idle_build', label: '构建会话空转（无产出）' }
  const MAX_IDLE_RETRIES = 1

  // Settles an idle round: rerun once on the next config when the agent allows switching and one is free,
  // otherwise the card fails. The test gate is not run and no test result is recorded: it would only have
  // tested the code that was already there.
  //
  // `stopped`: the round ended with chat.run.stopped (the user, or cancel / close / delete, stopped it). Such
  // a round is never rerun and records no cooldown and no fallbackHistory entry: the card fails saying it was
  // stopped, and the Chief is not woken for a stop somebody asked for.
  // 0.9.64: up to 3 nudges in a row, each more concrete (1 → 3). The count resets after any productive round, so it
  // limits consecutive idle rounds, not nudges per card. Nudges are sent at once: the model has ended its turn and
  // is not waiting on anything, so a delay would only stall the card.
  const MAX_IDLE_NUDGES = 3
  const WORKER_REPORT_MAX = 3000

  // #105: the idle count of a card goes back to 0 only here. `why`: 'output' (a productive round) or 'expired'
  // (the chain ended: the card failed as idle). Writes one timeline line when there was something to reset.
  function idleCountReset(userId, profile, todo, why) {
    const n = Number(todo.evidence?.idleNudges) || 0
    if (n > 0) {
      db.appendTimeline(userId, profile, todo.id, why === 'expired'
        ? `空转计数已到期（${n}/${MAX_IDLE_NUDGES}），本链结束，计数清零`
        : `本轮有产出，空转计数（${n}/${MAX_IDLE_NUDGES}）清零`, 'orchestrator')
    }
    return { idleNudges: 0 }
  }

  function currentTurnToolCalls(hostMsgs) {
    const list = Array.isArray(hostMsgs) ? hostMsgs : []
    let lastUser = -1
    list.forEach((m, i) => { if (m.role === 'user') lastUser = i })
    return list.slice(lastUser + 1).reduce((n, m) => n + (Number(m.toolCalls) || 0), 0)
  }

  // `attempt`: 1-based number of this nudge. The first one is the 0.9.57 text; later ones add a concrete step.
  // `missing` (#104): the verdict of judgeTextDeliverable when the round did answer but the answer was not
  // accepted as the deliverable; the nudge then names what is missing instead of 「只说明了打算」.
  function idleNudgeText(todo, attempt = 1, missing = null) {
    const base = missing && missing.reason !== 'too_short' && missing.reason !== 'intent_tail'
      ? (todo.kind === 'deploy'
        ? `[平台自动催促] 上一轮的部署报告没有被接受：${missing.hint}。请补证据：把实际执行的命令和它的输出片段原样贴出来，并给出部署后的线上校验结果（如 HTTP 状态码、版本号、健康检查输出）。如果部署其实还没执行，现在直接执行，不要只描述。`
        : `[平台自动催促] 上一轮的回复没有被接受为成果：${missing.hint}。请实际查证后重写：写明看了哪些文件、跑了哪些命令或引用了哪些来源，先结论后依据，不要以「接下来 / 我会」结束。`)
      : idleNudgeBase(todo)
    if (attempt <= 1) return base
    const tail = todo.withPlan
      ? (attempt === 2
        ? '这是第 2 次催促：先只列出要改的文件和每个文件改什么，一行一条，写完就结束这一轮。'
        : '这是最后一次催促：哪怕只能写出三五行的粗略方案也直接写出来，不确定的地方标成「待确认」，不要再查资料。')
      : todo.kind === 'deploy'
        ? (attempt === 2
          ? '这是第 2 次催促：现在只做第一步——执行构建命令，拿到它的输出再继续。'
          : '这是最后一次催促：把已经执行到哪一步、每一步的真实输出原样写进回复；做不下去就写清卡在哪条命令、报了什么错。')
        : isNoCodeKind(todo.kind)
          ? (attempt === 2
            ? '这是第 2 次催促：先给出结论和三条以内的依据，细节可以后补。'
            : '这是最后一次催促：把你目前已经知道的内容直接写成成果，缺的部分标成「未核实」，不要再说打算。')
          : (attempt === 2
            ? '这是第 2 次催促：现在只做一件事——打开任务书列出的第一个要改的文件，改完立刻 git commit，再继续下一个。'
            : '这是最后一次催促：已经改好的部分立刻 git commit；如果你确认这张卡不需要再改代码，不要为了提交而提交，直接写明理由和依据（相关提交号、命令和退出码），会交给总管验收。')
    return `${base}\n${tail}`
  }

  function idleNudgeBase(todo) {
    if (todo.withPlan) {
      return '[平台自动催促] 上一轮没有给出实施方案。现在直接写出方案（要改的文件、步骤、边界情况、验证命令），完整写在这一轮的最后一条回复里；这一轮不要修改仓库文件。'
    }
    if (todo.kind === 'deploy') {
      return '[平台自动催促] 上一轮你只说明了打算，没有实际执行，部署没有发生。现在直接执行部署：调用工具完成构建、上传/重启和线上验证，不要先复述计划。结束时在回复里写清部署目标、实际执行的命令、线上验证的输出（如 HTTP 状态码、版本号）。'
    }
    if (isNoCodeKind(todo.kind)) {
      return '[平台自动催促] 上一轮你只说明了打算，还没有给出成果。现在直接完成任务，并把完整成果写在这一轮的最后一条回复里（先结论，后依据与来源），不要以「接下来 / 我会」结束。'
    }
    return '[平台自动催促] 上一轮你只说明了打算，没有实际改动：工作树和分支 HEAD 与开工时完全一样。现在立刻动手：直接调用工具修改文件并 git commit（可以先提交一个能编译的中间版本），不要先复述计划，不要以「接下来 / 我会 / 然后提交」结束回合。完成后汇报改动的文件、提交号、验证命令和退出码。如果查下来确实不需要改代码，就写明理由和依据，不要提交空改动。'
  }

  // One resume of the same session (same model, same context) before the idle round is failed. Returns the
  // card when the nudge was dispatched, null when it could not be (the caller then settles the round as idle).
  async function nudgeIdleRound(run, userId, profile, todo, { updatedChat, turnOutput, nudges, turnToolCalls, missing = null }) {
    const preview = turnOutput.replace(/\s+/g, ' ').slice(0, 120)
    db.updateTodo(userId, profile, todo.id, { buildChat: updatedChat, evidence: { idleNudges: nudges + 1 } })
    db.appendTimeline(userId, profile, todo.id,
      `本轮没有任何改动，只回复了「${preview}${turnOutput.length > 120 ? '…' : ''}」（本轮工具调用 ${turnToolCalls} 次）；已在同一会话催促它实际执行（${nudges + 1}/${MAX_IDLE_NUDGES}）`, 'orchestrator')
    settlingTodos.delete(todo.id)
    try {
      return await startBuild(run, { todoId: todo.id, withPlan: Boolean(todo.withPlan), extraMessage: idleNudgeText(todo, nudges + 1, missing), idleNudge: true })
    } catch (err) {
      const reason = String(err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 200)
      db.appendTimeline(userId, profile, todo.id, `催促没有发出（${reason}），按空转结算`, 'orchestrator')
      settlingTodos.add(todo.id)
      return null
    }
  }

  // The assistant text written after the last instruction of the round (not an older round's reply).
  function currentTurnOutput(hostMsgs) {
    const list = Array.isArray(hostMsgs) ? hostMsgs : []
    let lastUser = -1
    list.forEach((m, i) => { if (m.role === 'user') lastUser = i })
    const answer = list.slice(lastUser + 1).filter(m => m.role === 'assistant' && String(m.content || '').trim())
    return answer.length ? String(answer[answer.length - 1].content).trim() : ''
  }

  // 0.9.55: a research / content card whose round changed no file but answered with a report. The report is
  // the result: the card waits for acceptance (gate `deliverable`); no test gate (no code changed), no merge.
  async function settleTextDeliverable(run, userId, profile, todo, project, { snap, updatedChat, topic, text, handback = '' }) {
    const nextPhase = transitionTodoPhase('building', 'BUILD_COMPLETED')
    const idleReset = idleCountReset(userId, profile, todo, 'output')
    const deliverable = text.length > MAX_DELIVERABLE_CHARS ? `${text.slice(0, MAX_DELIVERABLE_CHARS)}\n…（已截断，全文见执行对话）` : text
    db.updateTodo(userId, profile, todo.id, {
      phase: nextPhase,
      // A deploy report goes to a person unless the project lets the Chief accept deploys.
      gateOwner: topic?.autopilot && !(todo.kind === 'deploy' && project.autopilot?.requireHumanForDeploy !== false) ? 'chief' : 'human',
      gateKind: 'deliverable',
      buildRunId: '',
      snapshotSha: snap?.snapshotSha || todo.snapshotSha,
      diffs: [],
      buildChat: updatedChat,
      lastError: '',
      evidence: {
        deliverable,
        deliverableChars: text.length,
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        testRc: -1,
        testSummary: '',
        testFailures: [],
        testFailureCount: 0,
        gateSkipped: handback ? 'no-new-commit' : 'no-code-task',
        ...idleReset,
        ...(handback ? { workerReport: text.slice(0, WORKER_REPORT_MAX) } : {}),
      },
    })
    if (handback) {
      db.appendTimeline(userId, profile, todo.id, handback === 'merged'
        ? `分支已合并进 ${project.defaultBranch || 'main'}，本轮是回答问题，不需要新提交（回复 ${text.length} 字），交验收`
        : `本轮没有新提交，执行方给出了带依据的说明（${text.length} 字），交验收：确认不需要改代码就「验收完成」，需要改就「退回修改」`, 'builder')
      const handed = db.getTodo(userId, profile, todo.id)
      await maybeWakeChief(run, userId, profile, handed, project, 'deliverable_ready')
      emitUpdated(run, `todo.deliverable.ready:${todo.id}`)
      return handed
    }
    const kindLabel = todo.kind === 'content' ? '内容' : todo.kind === 'deploy' ? '部署' : '调研'
    db.appendTimeline(userId, profile, todo.id, todo.kind === 'deploy'
      ? `部署已执行，未改仓库代码（部署报告 ${text.length} 字），待验收线上结果`
      : `成果已交付（${kindLabel}类任务，不要求改代码；成果 ${text.length} 字），待验收`, 'builder')
    const settled = db.getTodo(userId, profile, todo.id)
    await maybeWakeChief(run, userId, profile, settled, project, 'deliverable_ready')
    emitUpdated(run, `todo.deliverable.ready:${todo.id}`)
    return settled
  }

  async function settleIdleBuild(run, userId, profile, todo, project, { snap, updatedChat, stopped = false, turnOutput = '' }) {
    const shortHead = snap.headSha.slice(0, 12)
    // The snapshot is a synthetic commit only when the files on disk differ from HEAD.
    const dirty = snap.snapshotFullSha !== snap.headSha
    const idleText = stopped
      ? `本轮被停止，没有产出（HEAD 仍为 ${shortHead}${dirty ? '，未提交的改动与开工时相同' : ''}）`
      : dirty
        ? `有改动未提交，且 HEAD 未前进（${shortHead}）`
        : `本轮没有产生任何提交（HEAD 仍为 ${shortHead}），任务未推进`
    const retries = Number(todo.evidence?.idleRetries) || 0
    const assignedAgent = todo.agentId ? db.getAgent(userId, profile, todo.agentId) : null
    const notes = []
    // 0.9.55: the reply is not thrown away. A code card that only answered in text says so, and says how a
    // research task should be filed so its report counts.
    if (!stopped && hasTextDeliverable(turnOutput)) {
      const preview = turnOutput.replace(/\s+/g, ' ').slice(0, 160)
      db.appendTimeline(userId, profile, todo.id, `本轮未改代码，但留下了 ${turnOutput.length} 字文字输出（「${preview}${turnOutput.length > 160 ? '…' : ''}」，全文见执行对话）。如果这张卡本来就是调研/方案，请把类型改为「调研 / 方案」(kind=question) 后重派，文字成果会直接交付验收`, 'failover')
    }
    let failText = idleText
    let rerunNotStarted = false
    if (!stopped && assignedAgent && assignedAgent.autoFallback && retries < MAX_IDLE_RETRIES) {
      const { config: idleCfg, index: idleIdx } = resolveActiveConfig(assignedAgent, todo.activeConfigId)
      const next = selectNextFallbackConfig({
        agent: assignedAgent,
        failedConfigId: idleCfg.id,
        cooldowns: db.listAgentCooldowns(assignedAgent.id),
      })
      if (next) {
        // The cooldown is recorded only when the card really switches: a lone config that idled once stays
        // usable for the agent's other cards.
        db.recordConfigFailure(assignedAgent.id, idleCfg.id, IDLE_CLASSIFIED.category, idleText)
        const hist = [...(todo.fallbackHistory || []), {
          at: Date.now(),
          fromConfigId: idleCfg.id,
          toConfigId: next.config.id,
          category: IDLE_CLASSIFIED.category,
          reason: IDLE_CLASSIFIED.label,
        }].slice(-12)
        const switchNote = `${formatConfigLabel(idleCfg, idleIdx)} ${IDLE_CLASSIFIED.label}：${idleText}；已自动切换至 ${formatConfigLabel(next.config, next.index)} 重跑一次。`
        db.updateTodo(userId, profile, todo.id, {
          engine: next.config.engine,
          activeConfigId: next.config.id,
          fallbackHistory: hist,
          buildSessionId: '',
          buildRunId: '',
          buildChat: [...updatedChat, { role: '故障切换', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), text: switchNote }],
          evidence: { idleRetries: retries + 1 },
        })
        db.appendTimeline(userId, profile, todo.id, switchNote, 'failover')
        settlingTodos.delete(todo.id)
        try {
          return await startBuild(run, {
            todoId: todo.id,
            agentId: assignedAgent.id,
            configId: next.config.id,
            withPlan: todo.withPlan,
            forceNewSession: true,
            extraMessage: `上一轮构建会话正常结束，但没有任何产出：${idleText}。工作树 ${todo.worktreePath} 里的文件与分支 HEAD 都和开工时一样。请检查该工作树，把 Todo #${todo.number}「${todo.title}」实际做完并提交；只读代码或只写计划不算完成。\n\n任务说明：\n${todo.spec || todo.title}`,
          })
        } catch (err) {
          // The session was already cleared for the switch: without this the card would stay `building` with
          // no session. It fails with both causes, and the rerun that never started is not counted.
          const reason = String(err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 300)
          failText = `${idleText}；自动重跑未能启动：${reason}`
          notes.push(`自动重跑未能启动：${reason}`)
          rerunNotStarted = true
        }
      } else {
        notes.push(`${formatConfigLabel(idleCfg, idleIdx)} ${IDLE_CLASSIFIED.label}，但没有可用备选配置（未配置备选，或备选都在冷却中），不自动重跑`)
      }
    } else if (!stopped && retries >= MAX_IDLE_RETRIES) {
      notes.push(`本卡已因空转自动重跑过 ${retries} 次，不再自动重跑`)
    }

    db.updateTodo(userId, profile, todo.id, {
      phase: transitionTodoPhase('building', 'BUILD_FAILED'),
      gateOwner: 'human',
      gateKind: 'failed',
      buildRunId: '',
      snapshotSha: snap.snapshotSha || todo.snapshotSha,
      diffs: snap.diffs || todo.diffs,
      evidence: {
        commitSha: snap.snapshotSha || todo.evidence.commitSha || '',
        filesChanged: snap.filesChanged ?? 0,
        additions: snap.additions ?? 0,
        deletions: snap.deletions ?? 0,
        testCmd: project.testCommand || todo.evidence.testCmd || '',
        // Not run this round. A result left from an earlier round would read as "this code passed".
        testRc: -1,
        testSummary: '',
        testFailures: [],
        testFailureCount: 0,
        gateSkipped: 'no-new-commit',
        workerReport: String(turnOutput || '').slice(0, WORKER_REPORT_MAX),
        ...(rerunNotStarted ? { idleRetries: retries } : {}),
        ...idleCountReset(userId, profile, todo, 'expired'),
      },
      buildChat: updatedChat,
      lastError: failText,
    })
    for (const note of notes) db.appendTimeline(userId, profile, todo.id, note, 'failover')
    db.appendTimeline(userId, profile, todo.id, `构建失败：${failText}（未运行验收命令）`, 'system')
    const settled = db.getTodo(userId, profile, todo.id)
    if (!stopped) await maybeWakeChief(run, userId, profile, settled, project, 'build_failed')
    emitUpdated(run, `todo.build.failed:${todo.id}`)
    return settled
  }

  // #71: failed transcript reads in a row of one card's settle, in memory only (todoId -> { sessionId, count,
  // noted, escalated }). A settle that reads its transcript, or is not deferred, deletes the entry; a new
  // session of the card starts at 0. Bounded like pendingSettles: past MAX_PENDING_SETTLES the oldest goes.
  // After READ_FAILURE_NOTE_AFTER failures (one event + two ticks, ~12-18 s at reconcileIntervalMs=6000) the
  // card's timeline says why it is not settled; after READ_FAILURE_ERROR_AFTER (~3 min) the reason is also
  // put in lastError. The phase is never changed: a read that works again settles the card as usual.
  const READ_FAILURE_NOTE_AFTER = 3
  const READ_FAILURE_ERROR_AFTER = READ_FAILURE_NOTE_AFTER * 10
  const transcriptReadFailures = new Map()
  const readFailureError = n => `会话记录连续 ${n} 次读取失败，仍未结算；卡片保持当前阶段，读取恢复后自动结算`

  // A transcript that could not be read is not an empty reply: nothing is settled, the next end event or
  // tick settles it. Counts the failure and writes it on the card at the thresholds above.
  function deferUnreadTranscript(userId, profile, todo, sessionId, warning) {
    log?.warn?.(warning, { todoId: todo.id, sessionId })
    let entry = transcriptReadFailures.get(todo.id)
    if (!entry || entry.sessionId !== sessionId) {
      // A lastError written for the card's previous session is still the one to clear once a read works.
      entry = { sessionId, count: 0, noted: false, escalated: false, errorNote: entry?.errorNote || '' }
      transcriptReadFailures.delete(todo.id)
      if (transcriptReadFailures.size >= MAX_PENDING_SETTLES) transcriptReadFailures.delete(transcriptReadFailures.keys().next().value)
      transcriptReadFailures.set(todo.id, entry)
    }
    entry.count += 1
    if (entry.count >= READ_FAILURE_NOTE_AFTER && !entry.noted) {
      entry.noted = true
      db.appendTimeline(userId, profile, todo.id, `会话记录连续 ${entry.count} 次读取失败，仍未结算，将在下一次调度重试`, 'system')
      log?.warn?.(`Transcript could not be read ${entry.count} reads in a row; settle still deferred`, { todoId: todo.id, sessionId })
    }
    // Not while another write holds the card (a dispatch, a stop): tried again at the next failure.
    if (entry.count >= READ_FAILURE_ERROR_AFTER && !entry.escalated && !settleSuperseded(userId, profile, todo)) {
      entry.escalated = true
      const note = readFailureError(entry.count)
      entry.errorNote = note
      db.updateTodo(userId, profile, todo.id, { lastError: note })
      db.appendTimeline(userId, profile, todo.id, note, 'system')
      log?.warn?.(`Transcript could not be read ${entry.count} reads in a row; reason written on the card`, { todoId: todo.id, sessionId })
    }
    return db.getTodo(userId, profile, todo.id)
  }

  // The settle of the counted session goes on (its transcript was read, or a failed / stopped run is settled
  // without it): the count starts again, and the lastError written for the failures (only that one) goes.
  function clearUnreadTranscript(userId, profile, todo, sessionId) {
    const entry = transcriptReadFailures.get(todo.id)
    if (!entry || entry.sessionId !== sessionId) return
    transcriptReadFailures.delete(todo.id)
    if (entry.errorNote && todo.lastError === entry.errorNote) db.updateTodo(userId, profile, todo.id, { lastError: '' })
  }

  async function settleWorkerRunInner(run, userId, profile, todoId, { sessionId, outcome = 'completed', errorText = '', failureHint = '', interrupted = false, stopped = false }) {
    if (settlingTodos.has(todoId)) {
      // 0.9.52 (#50): a settle of a repeated review turn is asking the host and reading the transcript again.
      // The end of the requested run that arrives meanwhile is kept for it, so that settle writes that outcome
      // instead of reading only the text. A kept end only goes up (completed < stopped < failed): a stop is
      // not replaced by a later completed report, a failure by nothing.
      const waiting = repeatReviewSettles.get(todoId)
      if (waiting && sessionId && sessionId === waiting.sessionId && !(waiting.lateEnd?.outcome === 'failed' || (waiting.lateEnd?.stopped && outcome !== 'failed'))) {
        waiting.lateEnd = { outcome, errorText, stopped }
      }
      return null
    }
    settlingTodos.add(todoId)
    try {
      const todo = db.getTodo(userId, profile, todoId)
      if (!todo) return null
      // 0.9.49 (#46): the end of a review run reported while its dispatch is still inside the launch call.
      // The dispatch holds the card and has not written the run yet, so settling now would be dropped as
      // superseded. The report is kept and settled when the dispatch is through (runIndependentReview).
      const reviewLaunch = reviewLaunches.get(todoId)
      if (reviewLaunch && sessionId && sessionId === reviewLaunch.sessionId && stillOwnsWrite(todoId, reviewLaunch.lock)) {
        reviewLaunch.earlySettle = { sessionId, outcome, errorText, failureHint, interrupted, stopped }
        return todo
      }
      const project = db.getProject(userId, profile, todo.projectId)
      if (!project) return null
      const topic = todo.topicId ? db.getTopic(userId, profile, todo.topicId) : null

      // 0.9.42: instructions queued while the build session was busy are delivered when one of its turns ends
      // as completed, whatever the card's phase (building, confirm, review, failed …), one run per finished
      // turn, in order, before anything else is settled. After a failed turn they are removed with the reason
      // written on the card (see settleWorkerRun), never replayed later.
      // 0.9.49: not into a card that is finished (done / closed). Delivering starts a build, and
      // `closed` and `done` may start one, so a card the user had just closed was built again (worktree and
      // branch recreated). settleWorkerRun drops the queue of such a card with the reason on the timeline.
      // #107: nor into a card that waits for a build slot (`queued`): its instructions go out with the start
      // out of the queue (startBuildInner), with the task prompt.
      if (outcome !== 'failed' && sessionId && sessionId === todo.buildSessionId && todo.phase !== 'queued'
        && !TODO_QUEUE_HOLD_PHASES.has(todo.phase) && !TODO_QUEUE_DROP_PHASES.has(todo.phase)) {
        const pending = db.listTodoQueue(userId, profile, todo.id)
        if (pending.length) {
          const next = pending[0]
          db.removeTodoQueueItem(userId, profile, todo.id, next.id)
          db.appendTimeline(userId, profile, todo.id,
            `本轮已结束，送达排队的指令${pending.length > 1 ? `（之后还有 ${pending.length - 1} 条）` : ''}`, 'orchestrator')
          settlingTodos.delete(todoId)
          try {
            return await startBuild(run, { todoId: todo.id, withPlan: false, extraMessage: next.text, instructionKind: next.kind || 'message' })
          } catch (err) {
            const errText = err?.message || String(err)
            // The item has left the queue: say so on the card instead of dropping it silently.
            const note = `排队的指令没有送达，已移出队列：${errText}`
            if (!err?.todoFailureRecorded) {
              db.appendTimeline(userId, profile, todo.id, `${note}（${clipQueued(next.text)}）`, 'system')
              const cur = db.getTodo(userId, profile, todo.id)
              if (cur && !cur.lastError) db.updateTodo(userId, profile, todo.id, { lastError: note })
            }
            emitUpdated(run, `todo.message.failed:${todo.id}`)
            log?.warn?.('Queued worker instruction was not delivered', { todoId: todo.id, error: errText })
            return db.getTodo(userId, profile, todo.id)
          }
        }
      }

      const msgRes = sessionId
        ? await run.host.sessions.messages(sessionId, { limit: 60 }).catch(() => null)
        : null
      // #69 (C03): a review transcript that could not be read is not an empty reply. Read as one, it was
      // settled as inconclusive and spent the one request for a verdict on a reviewer that may have given
      // one. Nothing is written, as when the second reading fails below; the next end event or tick settles
      // it. A failed or stopped run needs no text and is settled now: a stop is known only to this event, and
      // the next settle would read it as a normal end and ask a stopped reviewer again (#47).
      if (sessionId && !msgRes && todo.phase === 'reviewing' && sessionId === todo.reviewSessionId && outcome !== 'failed' && !stopped) {
        return deferUnreadTranscript(userId, profile, todo, sessionId, 'Review transcript could not be read; settle deferred')
      }
      // #71: the same for the card's build session. Read as empty, a round that reported with evidence (or
      // planned, or committed) was settled as idle: nudged, rerun or failed. A failed run is settled now (its
      // reason comes from the event; resolveBuildFailure reads no further text without msgRes), and a stop
      // too: it is known only to this event, the next settle would read it as a normal end and nudge it.
      if (sessionId && !msgRes && todo.phase === 'building' && sessionId === todo.buildSessionId && outcome !== 'failed' && !stopped) {
        return deferUnreadTranscript(userId, profile, todo, sessionId, 'Build transcript could not be read; settle deferred')
      }
      clearUnreadTranscript(userId, profile, todo, sessionId)
      const hostMsgs = msgRes ? normalizeHostMessages(msgRes) : []
      // 0.9.57: only the reply of the turn being settled counts. The review session is reused across review
      // rounds: a round that ended with no text (empty reply, the host's failed-turn row) used to be read as
      // the previous round's answer, so an old "VERDICT: APPROVED" approved code nobody reviewed.
      const turnOf = msgs => {
        let lastUser = -1
        msgs.forEach((m, i) => { if (m.role === 'user') lastUser = i })
        return msgs.slice(lastUser + 1)
      }
      // While a review is being asked for its verdict (reviewInconclusiveTurn), the asked-about message is
      // still the reference: the #50 repeat detection compares against it.
      const lastAssistantOf = msgs => [...turnOf(msgs)].reverse().find(m => m.role === 'assistant' && m.content.trim())
        || (todo.evidence?.reviewInconclusiveTurn && !String(todo.evidence.reviewInconclusiveTurn).startsWith('empty:')
          ? [...msgs].reverse().find(m => m.role === 'assistant' && m.content.trim())
          : undefined)
      let lastAssistant = lastAssistantOf(hostMsgs)
      let workerOutput = lastAssistant?.content?.trim() || ''

      const chatOf = msgs => (msgs.length
        ? msgs.slice(-24).map(m => ({
            // 0.9.58: tool output rows were labelled as instructions (「任务指令: {"output": …}」).
            role: m.role === 'assistant' ? (todo.phase === 'reviewing' ? '审查 Agent' : '开发 Agent') : m.role === 'tool' ? '工具结果' : '任务指令',
            time: m.timestamp > 0 ? new Date(m.timestamp < 1e12 ? m.timestamp * 1000 : m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
            text: m.content.slice(0, 4000),
          }))
        : todo.buildChat)
      let updatedChat = chatOf(hostMsgs)

      if (todo.phase === 'reviewing' && sessionId === todo.reviewSessionId) {
        // 0.9.49: the card was completed / closed / taken by another write while the transcript was read.
        if (settleSuperseded(userId, profile, todo)) return discardStaleWrite(run, userId, profile, todo.id, '审查结论')
        // 0.9.49 (#47): four outcomes. A run that failed is `review_failed`; a turn that ended without a
        // verdict is `inconclusive`. Neither is a rejection: nobody read the code and said no.
        let verdict = outcome === 'failed' ? 'review_failed' : parseReviewVerdict(workerOutput)
        const inconclusiveRetries = Number(todo.evidence?.reviewInconclusiveRetries) || 0
        // 0.9.52 (#50): the message this settle reads is the one the request for a verdict was already sent
        // for. Either the end of that turn was reported again while the requested run is working (nothing
        // to settle: the end of the requested run decides), or the requested run has ended and wrote no
        // text (two turns without a verdict: the human gate below). The host says which. A message without
        // an id is never taken as seen, and a stop is an event of the requested run, not a repeat.
        // A turn without text is keyed by the instruction that started it (0.9.57: replies are turn-scoped).
        const lastUserMsg = [...hostMsgs].reverse().find(m => m.role === 'user')
        const turnKey = lastAssistant ? String(lastAssistant.id || '') : (lastUserMsg?.id ? `empty:${lastUserMsg.id}` : '')
        const askedKey = String(todo.evidence?.reviewInconclusiveTurn || '')
        const repeatOfAsked = Boolean(turnKey && askedKey && (askedKey === turnKey || (turnKey.startsWith('empty:') && askedKey.startsWith('empty:'))))
        if (verdict === 'inconclusive' && !stopped && repeatOfAsked) {
          // The end of the requested run that arrives during the probe or the second reading is refused at
          // the entry of this function (one settle per card at a time) and kept here instead.
          const waiting = { sessionId, lateEnd: null }
          repeatReviewSettles.set(todo.id, waiting)
          try {
            const probe = await probeSessionWorking(run, sessionId, { timeoutMs: 1200 }).catch(() => null)
            if (settleSuperseded(userId, profile, todo)) return discardStaleWrite(run, userId, profile, todo.id, '审查结论')
            // A run in the host's queue has not started yet (`queueLength` > 0): working, as for the launch and
            // the reconcile.
            if (!waiting.lateEnd && (!probe || !probe.known || probe.isWorking || Number(probe.queueLength || 0) > 0)) return db.getTodo(userId, profile, todo.id)
            // Known idle, or the requested run has reported its end. It may have written its answer and ended
            // while the host was asked, so the transcript is read again and the settle goes on with what it
            // ends with now. Same message: the requested run wrote nothing. Another message: that one is
            // settled like the end of any review turn. A reading that fails says neither, and nothing is
            // written (unless the requested run failed: that needs no text).
            const againRes = await run.host.sessions.messages(sessionId, { limit: 60 }).catch(() => null)
            if (settleSuperseded(userId, profile, todo)) return discardStaleWrite(run, userId, profile, todo.id, '审查结论')
            if (!againRes && waiting.lateEnd?.outcome !== 'failed') return db.getTodo(userId, profile, todo.id)
            if (againRes) {
              const againMsgs = normalizeHostMessages(againRes)
              const againLast = lastAssistantOf(againMsgs)
              if (String(againLast?.id || '') !== turnKey) {
                lastAssistant = againLast
                workerOutput = lastAssistant?.content?.trim() || ''
                updatedChat = chatOf(againMsgs)
                verdict = parseReviewVerdict(workerOutput)
              }
            }
            // The kept end event decides how the run ended: a failure stays `review_failed` with its reason,
            // whatever text the transcript ends with; a stop is a stop.
            const lateEnd = waiting.lateEnd
            if (lateEnd?.outcome === 'failed') {
              outcome = 'failed'
              errorText = lateEnd.errorText
              verdict = 'review_failed'
            } else if (lateEnd?.stopped) {
              stopped = true
            }
          } finally {
            if (repeatReviewSettles.get(todo.id) === waiting) repeatReviewSettles.delete(todo.id)
          }
        }
        // Why an inconclusive review ends at the human gate (the timeline line).
        let inconclusiveLine = `审查两次都没有给出结论，需要人工判断或重派审查`
        if (verdict === 'inconclusive' && stopped) {
          // A stop somebody asked for is not answered with a new run.
          inconclusiveLine = '审查被停止，没有给出结论，需要人工判断或重派审查'
        } else if (verdict === 'inconclusive' && inconclusiveRetries < MAX_REVIEW_INCONCLUSIVE_RETRIES) {
          // First time in this review round: ask once for the verdict in the same session (its context is
          // kept). The card stays `reviewing`; the settle of that run decides.
          try {
            const reviewer = todo.reviewerId ? db.getAgent(userId, profile, todo.reviewerId) : null
            const revCfg = reviewer ? resolveActiveConfig(reviewer).config : null
            const launched = await launchSessionRun(run, sessionId, REVIEW_VERDICT_NUDGE, {
              wait: false,
              workspace: todo.worktreePath || project.repoPath,
              ...(reviewer?.systemPrompt ? { instructions: reviewer.systemPrompt } : {}),
              ...(revCfg ? buildRunModelOptions(revCfg, reviewer) : {}),
            })
            // The card was stopped / closed / taken by another write while the request was sent: nothing is
            // written. The run that did start settles into nothing (the card is not reviewing with it).
            if (settleSuperseded(userId, profile, todo)) return discardStaleWrite(run, userId, profile, todo.id, '审查续跑')
            // 0.9.52 (#50): the host refused the request because the session already has a run. Nothing was
            // sent: not counted, not written as asked. The card stays as it is and the end of that run
            // settles it (the request is still available then). The rule is the host's answer, not an empty
            // run id: a launch that timed out but was taken has no run id either, and that one was sent.
            if (launched?.alreadyRunning) return db.getTodo(userId, profile, todo.id)
            const now = Date.now()
            sessionActivity.set(sessionId, { running: true, startedAt: now, updatedAt: now, activeTool: '', toolCount: 0, stage: 'reviewing' })
            db.updateTodo(userId, profile, todo.id, {
              reviewRunId: String(launched?.run_id || launched?.queue_id || ''),
              buildChat: updatedChat,
              evidence: {
                reviewVerdict: 'pending',
                reviewSummary: workerOutput.slice(0, 1200),
                reviewInconclusiveRetries: inconclusiveRetries + 1,
                reviewInconclusiveTurn: turnKey,
              },
            })
            db.appendTimeline(userId, profile, todo.id,
              `审查未给出结论，已要求它收口（同一审查会话续跑，自动催促 ${inconclusiveRetries + 1}/${MAX_REVIEW_INCONCLUSIVE_RETRIES}）`, 'orchestrator')
            emitUpdated(run, `todo.review.nudged:${todo.id}`)
            return db.getTodo(userId, profile, todo.id)
          } catch (err) {
            // Not sent, so not counted. The card must not stay `reviewing` with no run.
            if (settleSuperseded(userId, profile, todo)) return discardStaleWrite(run, userId, profile, todo.id, '审查续跑')
            const reason = String(err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 300)
            inconclusiveLine = `审查未给出结论，催促也没有发出（${reason}），需要人工判断或重派审查`
          }
        }
        // A rejected review parks the todo at the review gate (gateKind=changes) instead of jumping to
        // 'building' with no worker run: the next reconcile tick would otherwise settle the OLD build
        // session as freshly completed and silently flip the rejected change back to "ready to merge".
        // Rework is dispatched explicitly via request_changes / message_todo.
        // #103: the reviewer worked in the worktree the change lives in. When the worktree is no longer the
        // commit the review was dispatched on (HEAD moved, or something is uncommitted), what was judged and
        // what a merge would take are two things: the verdict is kept, but the card may not be merged on it.
        let reviewDrift = ''
        if (todo.reviewedSha && todo.worktreePath) {
          const binding = await readReviewBinding({ repoPath: project.repoPath, worktreePath: todo.worktreePath, branchName: todo.branch }).catch(() => null)
          if (settleSuperseded(userId, profile, todo)) return discardStaleWrite(run, userId, profile, todo.id, '审查结论')
          if (binding) reviewDrift = reviewBindingProblem(todo.reviewedSha, binding)
        }
        const nextPhase = transitionTodoPhase('reviewing', 'REVIEW_APPROVED')
        const testFailed = Boolean(project.testCommand) && Number(todo.evidence?.testRc ?? -1) !== 0
        // No verdict (inconclusive after the one request, or a failed run): a person decides, also in an
        // AUTO topic, and the Chief is not run. There are no findings it could turn into rework.
        const noVerdict = verdict === 'inconclusive' || verdict === 'review_failed'

        let gateOwner = 'human'
        let gateKind = todo.kind === 'deploy' ? 'deploy' : 'merge'
        if (noVerdict) {
          gateKind = verdict === 'review_failed' ? 'review_failed' : 'review_inconclusive'
        } else if (verdict !== 'approved') {
          gateKind = 'changes'
          gateOwner = topic?.autopilot ? 'chief' : 'human'
        } else if (
          todo.kind !== 'deploy'
          && topic?.autopilot
          && project.autopilot.autoMergeAfterReview
          && !testFailed
          && !reviewDrift
        ) {
          gateOwner = 'chief'
        }

        const failedReviewText = outcome === 'failed' ? (hostErrorText(errorText) || '审查会话异常结束') : ''
        db.updateTodo(userId, profile, todo.id, {
          phase: nextPhase,
          gateOwner,
          gateKind,
          reviewRunId: '',
          buildChat: updatedChat,
          evidence: { reviewVerdict: verdict, reviewSummary: workerOutput.slice(0, 1200), reviewDrift: reviewDrift.slice(0, REVIEW_DRIFT_MAX) },
          lastError: failedReviewText,
        })
        if (verdict === 'review_failed') {
          db.appendTimeline(userId, profile, todo.id, `审查运行失败：${clipWorkerError(failedReviewText)}（没有审查结论，需要人工判断或重派审查）`, 'system')
        } else if (verdict === 'inconclusive') {
          db.appendTimeline(userId, profile, todo.id, inconclusiveLine, 'system')
        } else {
          db.appendTimeline(userId, profile, todo.id, `独立审查结论：${verdict === 'approved' ? '通过' : '需修改'}`, 'reviewer')
        }
        if (reviewDrift) {
          db.appendTimeline(userId, profile, todo.id, `警告：审查期间工作树被改动（${reviewDrift.slice(0, REVIEW_DRIFT_MAX)}）。本次审查结论不能直接用于合并，请提交改动后重新派发审查`, 'system')
        }
        const settled = db.getTodo(userId, profile, todo.id)
        // The watching topic gets its progress notice either way; without a verdict the Chief is not run.
        await maybeWakeChief(run, userId, profile, settled, project, `review_${verdict}`, { skipRun: noVerdict })
        emitUpdated(run, `todo.review.settled:${todo.id}`)
        return settled
      }

      if (todo.phase !== 'building') return todo
      // Only the todo's current build session may settle a build; stale review/older sessions never can.
      if (sessionId && todo.buildSessionId && sessionId !== todo.buildSessionId) return todo
      // 0.9.49: from here on the settle writes the card, after awaits that can take minutes (transcript,
      // failure lookup, snapshot, test gate). After each of them it asks whether the card is still the one it
      // started on (settleSuperseded); if not, the result is dropped with one timeline line.
      const dropSettle = () => discardStaleWrite(run, userId, profile, todo.id, outcome === 'failed' ? '构建失败结算' : '构建结算')
      if (settleSuperseded(userId, profile, todo)) return dropSettle()
      // failedText / failedNotes: what the failed card and its timeline say (see resolveBuildFailure).
      let failedText = ''
      const failedNotes = []
      if (outcome === 'failed') {
        const assignedAgent = todo.agentId ? db.getAgent(userId, profile, todo.agentId) : null
        const active = assignedAgent ? resolveActiveConfig(assignedAgent, todo.activeConfigId) : null
        const configLabel = active ? formatConfigLabel(active.config, active.index) : (todo.engine || '默认配置')
        const failure = await resolveBuildFailure(run, { sessionId, errorText, failureHint, interrupted, msgRes, hostMsgs, configLabel, activeConfig: active?.config || null })
        if (settleSuperseded(userId, profile, todo)) return dropSettle()
        const classified = failure.classified
        failedText = classified.switchable
          ? `模型服务异常（${classified.label}）：${clipWorkerError(failure.text)}`
          : clipWorkerError(failure.text)
        if (assignedAgent && assignedAgent.autoFallback && classified.switchable) {
          const { config: failedCfg, index: failedIdx } = active
          db.recordConfigFailure(assignedAgent.id, failedCfg.id, classified.category, failure.text)
          const next = selectNextFallbackConfig({
            agent: assignedAgent,
            failedConfigId: failedCfg.id,
            cooldowns: db.listAgentCooldowns(assignedAgent.id),
          })
          if (next) {
            const hist = [...(todo.fallbackHistory || []), {
              at: Date.now(),
              fromConfigId: failedCfg.id,
              toConfigId: next.config.id,
              category: classified.category,
              reason: classified.label,
            }].slice(-12)
            const switchNote = `${formatConfigLabel(failedCfg, failedIdx)} 运行失败（${classified.label}），已自动切换至 ${formatConfigLabel(next.config, next.index)} 原地继续。`
            db.updateTodo(userId, profile, todo.id, {
              engine: next.config.engine,
              activeConfigId: next.config.id,
              fallbackHistory: hist,
              buildSessionId: '',
              buildRunId: '',
              buildChat: [...updatedChat, { role: '故障切换', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), text: switchNote }],
            })
            db.appendTimeline(userId, profile, todo.id, switchNote, 'failover')
            settlingTodos.delete(todoId)
            return startBuild(run, {
              todoId: todo.id,
              agentId: assignedAgent.id,
              configId: next.config.id,
              withPlan: todo.withPlan,
              forceNewSession: true,
              extraMessage: `The previous model configuration encountered a service error (${classified.label}). Inspect the current worktree at ${todo.worktreePath} and continue completing Todo #${todo.number}: "${todo.title}".\n\nSpecification:\n${todo.spec || todo.title}`,
            })
          }
          // Nothing to switch to: the card fails, and says which model failed and that a fallback is missing.
          failedNotes.push(`模型 ${formatConfigLabel(failedCfg, failedIdx)} 服务异常（${classified.label}），但没有可用备选配置（未配置备选，或备选都在冷却中）；请在 Agent 设置里添加备选模型配置`)
        }
      }

      let snap = null
      if (todo.worktreePath) {
        snap = await captureWorktreeSnapshot({
          repoPath: project.repoPath,
          worktreePath: todo.worktreePath,
          baseCommit: todo.baseCommit,
          baseBranch: project.defaultBranch,
          snapshotRefName: todo.id,
        }).catch(err => {
          log?.warn?.('Snapshot failed', { todoId: todo.id, error: err.message })
          return null
        })
      }
      if (settleSuperseded(userId, profile, todo)) return dropSettle()

      // 0.9.47 (#36): did this round produce anything? Judged before the test gate, which would otherwise
      // pass on the code that was already there. Idle = HEAD and the worktree tree both equal the baseline
      // written when the round started. Without a snapshot or a baseline nothing is concluded. Only planning
      // rounds (no code by design) are not judged; deploy cards need output like any other card. A stopped
      // round (chat.run.stopped) is compared too, but settleIdleBuild never reruns it.
      // gateSkippedWhy: the test command is not run without a snapshot (the directory may be gone).
      let gateSkippedWhy = ''
      let deliverableNote = ''
      if (outcome !== 'failed' && !todo.withPlan) {
        const roundBaseSha = String(todo.evidence?.roundBaseSha || '')
        const roundBaseTree = String(todo.evidence?.roundBaseTree || '')
        if (!snap) {
          db.appendTimeline(userId, profile, todo.id, '取不到工作树快照，跳过产出校验', 'orchestrator')
          if (project.testCommand) gateSkippedWhy = 'no-snapshot'
        } else if (!roundBaseSha || !roundBaseTree || !snap.headSha || !snap.worktreeTreeSha) {
          db.appendTimeline(userId, profile, todo.id, '本轮没有可用的开工基线，跳过产出校验', 'orchestrator')
        } else if (snap.headSha === roundBaseSha && snap.worktreeTreeSha === roundBaseTree) {
          // 0.9.55: research / content cards deliver text, not commits. Their round is finished when the
          // worker's reply of THIS round holds a report; it goes to acceptance instead of failing as idle.
          const turnOutput = currentTurnOutput(hostMsgs)
          // 0.9.57: deploy cards are judged by their report too (a deploy changes the server, not the repo).
          // A text card whose branch already carries commits from an earlier round is not settled as text:
          // those commits would never be merged; it goes through the normal build gate below.
          const branchChanged = Number(snap.filesChanged || 0) > 0
          const textKind = isNoCodeKind(todo.kind) || todo.kind === 'deploy'
          // #104: length alone no longer makes a reply the deliverable (see text-deliverable.mjs). A reply that
          // is long enough but ends with a plan, shows nothing that can be checked, or (deploy) carries no
          // output of the deployment is not delivered: the card says why and the worker is asked for it.
          const turnToolCalls = currentTurnToolCalls(hostMsgs)
          const delivery = textKind ? judgeTextDeliverable({ text: turnOutput, kind: todo.kind, toolCalls: turnToolCalls }) : null
          const delivered = Boolean(delivery?.ok)
          if (!stopped && textKind && !delivered && delivery.reason !== 'too_short' && !branchChanged) {
            db.appendTimeline(userId, profile, todo.id, `本轮回复（${turnOutput.length} 字，工具调用 ${turnToolCalls} 次）不算交付：${delivery.hint}${todo.kind === 'deploy' ? '；部署未记为已执行，请补充证据' : ''}`, 'orchestrator')
          }
          if (!stopped && textKind && delivered && !branchChanged) {
            return await settleTextDeliverable(run, userId, profile, todo, project, { snap, updatedChat, topic, text: turnOutput })
          }
          if (!stopped && textKind && delivered && branchChanged) {
            db.appendTimeline(userId, profile, todo.id, '本轮没有新提交，但分支上已有之前各轮的改动：按普通构建结果送验收（含本轮文字报告）', 'orchestrator')
            deliverableNote = turnOutput
          } else if (!stopped && !textKind && hasTextDeliverable(turnOutput) && await (async () => {
            // 0.9.66: a code card whose branch is already merged was sent a follow-up (usually the Chief asking
            // why something happened). Nothing is left to commit: the answer goes to acceptance, no nudge.
            const head = String(snap.headSha || '')
            const base = String(todo.baseCommit || '')
            const ownCommits = head && base && !head.startsWith(base) && !base.startsWith(head)
            return Boolean(ownCommits) && isCommitMergedInto(project.repoPath, head, project.defaultBranch || 'main')
          })()) {
            return await settleTextDeliverable(run, userId, profile, todo, project, { snap, updatedChat, topic, text: turnOutput, handback: 'merged' })
          } else if (!stopped && !textKind && isSubstantiveReport(turnOutput, currentTurnToolCalls(hostMsgs))) {
            // 0.9.66: no commit, but a report with evidence (commands, commit ids, exit codes) rather than a plan.
            // Nudging it to "commit anything" would ask for a fake commit; the Chief / user decides instead.
            return await settleTextDeliverable(run, userId, profile, todo, project, { snap, updatedChat, topic, text: turnOutput, handback: 'report' })
          } else {
            // 0.9.57: the worker ended the round with words only ("接下来…然后提交"), a common way models stop
            // early. Before failing or switching models, the same session is told once to actually do it.
            const nudges = Number(todo.evidence?.idleNudges) || 0
            if (!stopped && nudges < MAX_IDLE_NUDGES && turnOutput.trim()) {
              const nudged = await nudgeIdleRound(run, userId, profile, todo, { updatedChat, turnOutput, nudges, turnToolCalls, missing: delivery && !delivery.ok ? delivery : null })
              if (nudged) return nudged
            }
            return await settleIdleBuild(run, userId, profile, todo, project, { snap, updatedChat, stopped, turnOutput })
          }
        }
      }

      let testGate = null
      if (outcome !== 'failed' && !todo.withPlan && snap && todo.worktreePath && project.testCommand) {
        testGate = await runDeterministicTestGate({
          cwd: todo.worktreePath,
          command: project.testCommand,
          timeoutMs: testGateTimeoutMs,
          signal: disposeController.signal,
        })
        // #68: disposed while the gate ran (it was aborted with this instance): the result is dropped, the card
        // stays `building` and the next instance settles it with a gate of its own.
        if (disposed) return noteDisposedDrop(`#${todo.number} 的构建结算（${testGate.summary}）`, { todoId: todo.id })
        if (settleSuperseded(userId, profile, todo)) return dropSettle()
      }

      const evidencePatch = {
        // 0.9.58: the worker's own final reply of this round travels with the card to the Chief's wake
        // (supervisor hand-back, as LangGraph supervisor / OpenAI Agents SDK return the sub-agent's last
        // message). On a real board 18 of 27 wakes began with get_todo_conversation just to read it.
        workerReport: currentTurnOutput(hostMsgs).slice(0, WORKER_REPORT_MAX),
        commitSha: snap?.snapshotSha || todo.evidence.commitSha || '',
        filesChanged: snap?.filesChanged ?? todo.evidence.filesChanged ?? 0,
        additions: snap?.additions ?? todo.evidence.additions ?? 0,
        deletions: snap?.deletions ?? todo.evidence.deletions ?? 0,
        testCmd: project.testCommand || todo.evidence.testCmd || '',
        // 0.9.49: the failed test names are written on every gate run (empty on a pass), never left over.
        ...(testGate ? {
          testRc: testGate.exitCode,
          testSummary: testGate.summary,
          testFailures: testGate.failures || [],
          testFailureCount: testGate.failureCount || 0,
        } : {}),
        ...(gateSkippedWhy ? { gateSkipped: gateSkippedWhy, testRc: -1, testSummary: '', testFailures: [], testFailureCount: 0 } : {}),
        ...(deliverableNote ? { deliverable: deliverableNote.slice(0, MAX_DELIVERABLE_CHARS), deliverableChars: deliverableNote.length } : {}),
        // 0.9.57: a productive round restores the one automatic idle rerun; it used to be spent for good.
        ...(outcome !== 'failed' ? { idleRetries: 0 } : {}),
      }
      // #105: a productive round (it reaches the plan gate or the build gate below) resets the idle count.
      // Not a failed run: a model error is no output, the count stays.
      const productiveReset = () => (outcome !== 'failed' ? idleCountReset(userId, profile, todo, 'output') : {})

      if (outcome === 'failed') {
        const nextPhase = transitionTodoPhase('building', 'BUILD_FAILED')
        db.updateTodo(userId, profile, todo.id, {
          phase: nextPhase,
          gateOwner: 'human',
          gateKind: 'failed',
          buildRunId: '',
          snapshotSha: snap?.snapshotSha || todo.snapshotSha,
          diffs: snap?.diffs || todo.diffs,
          evidence: evidencePatch,
          buildChat: updatedChat,
          lastError: failedText,
        })
        for (const note of failedNotes) db.appendTimeline(userId, profile, todo.id, note, 'failover')
        db.appendTimeline(userId, profile, todo.id, `构建失败：${failedText}`, 'system')
        const settled = db.getTodo(userId, profile, todo.id)
        await maybeWakeChief(run, userId, profile, settled, project, 'build_failed')
        emitUpdated(run, `todo.build.failed:${todo.id}`)
        return settled
      }

      // 0.9.57: a planning round that ended without a plan went to the approval gate with an empty plan (or the
      // plan of an earlier round), and approving it started coding from nothing. It is nudged once, then fails.
      if (todo.withPlan && String(workerOutput || '').replace(/\s+/g, '').length < 10) {
        const nudges = Number(todo.evidence?.idleNudges) || 0
        if (!stopped && nudges < MAX_IDLE_NUDGES && sessionId) {
          const nudged = await nudgeIdleRound(run, userId, profile, todo, { updatedChat, turnOutput: workerOutput || '（无文字输出）', nudges, turnToolCalls: currentTurnToolCalls(hostMsgs) })
          if (nudged) return nudged
        }
        const noPlan = stopped ? '方案轮被停止，没有给出方案' : '方案轮结束了，但没有给出实施方案（本轮最后一条回复为空或只有一句话）'
        db.updateTodo(userId, profile, todo.id, {
          phase: transitionTodoPhase('building', 'BUILD_FAILED'),
          gateOwner: 'human',
          gateKind: 'failed',
          buildRunId: '',
          buildChat: updatedChat,
          lastError: noPlan,
          evidence: idleCountReset(userId, profile, todo, 'expired'),
        })
        db.appendTimeline(userId, profile, todo.id, `构建失败：${noPlan}`, 'system')
        const settled = db.getTodo(userId, profile, todo.id)
        if (!stopped) await maybeWakeChief(run, userId, profile, settled, project, 'build_failed')
        emitUpdated(run, `todo.build.failed:${todo.id}`)
        return settled
      }

      if (todo.withPlan) {
        const nextPhase = transitionTodoPhase('building', 'PLAN_READY')
        db.updateTodo(userId, profile, todo.id, {
          phase: nextPhase,
          gateOwner: topic?.autopilot ? 'chief' : 'human',
          gateKind: 'plan',
          withPlan: false,
          buildRunId: '',
          plan: workerOutput || todo.plan,
          buildChat: updatedChat,
          evidence: { ...evidencePatch, ...productiveReset() },
        })
        db.appendTimeline(userId, profile, todo.id, '实施方案已生成，等待确认', 'builder')
        const settled = db.getTodo(userId, profile, todo.id)
        await maybeWakeChief(run, userId, profile, settled, project, 'plan_ready')
        emitUpdated(run, `todo.plan.ready:${todo.id}`)
        return settled
      }

      const nextPhase = transitionTodoPhase('building', 'BUILD_COMPLETED')
      const isDeploy = todo.kind === 'deploy'
      const humanGate = mergeGateNeedsHuman({ todo, topic, project, testFailed: Boolean(testGate && testGate.exitCode !== 0), gateSkipped: gateSkippedWhy })
      db.updateTodo(userId, profile, todo.id, {
        phase: nextPhase,
        gateOwner: humanGate ? 'human' : 'chief',
        gateKind: isDeploy ? 'deploy' : 'merge',
        buildRunId: '',
        snapshotSha: snap?.snapshotSha || todo.snapshotSha,
        diffs: snap?.diffs || todo.diffs,
        evidence: { ...evidencePatch, ...productiveReset() },
        buildChat: updatedChat,
      })
      db.appendTimeline(
        userId,
        profile,
        todo.id,
        `构建完成（${snap ? `${snap.filesChanged} 文件 +${snap.additions}/-${snap.deletions}` : '无变更'}${testGate ? ` · 测试 rc=${testGate.exitCode}` : ''}）`,
        'gate',
      )
      const settled = db.getTodo(userId, profile, todo.id)
      await maybeWakeChief(run, userId, profile, settled, project, 'build_completed')
      emitUpdated(run, `todo.build.settled:${todo.id}`)
      return settled
    } finally {
      settlingTodos.delete(todoId)
    }
  }

  // Phases in which queued instructions wait: the card is being reviewed or merged, the build session is not the
  // one that runs next.
  const TODO_QUEUE_HOLD_PHASES = new Set(['reviewing', 'merging'])
  // Phases in which queued instructions are removed: the card is finished. Only phases of the state machine
  // (TODO_PHASES). 0.9.49 (#46): `cancelled` was listed here and is no phase; a stopped card is `todo` or
  // `review`.
  const TODO_QUEUE_DROP_PHASES = new Set(['done', 'closed'])
  // A queued instruction older than this whose session never went idle is removed with a note (reconcile).
  const TODO_QUEUE_STALE_MS = 30 * 60 * 1000
  const clipQueued = text => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > 80 ? `${t.slice(0, 80)}…` : t }
  // #107: how much of an instruction the timeline quotes, and the longest follow-up message accepted.
  const INSTRUCTION_ECHO_CHARS = 300
  const MAX_TODO_MESSAGE_CHARS = 20000
  const clipInstruction = text => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > INSTRUCTION_ECHO_CHARS ? `${t.slice(0, INSTRUCTION_ECHO_CHARS)}…（共 ${t.length} 字）` : t }

  // Removes every queued instruction of a card and writes why on the timeline and in lastError.
  function dropTodoQueue(run, userId, profile, todoId, reason) {
    const pending = db.listTodoQueue(userId, profile, todoId)
    if (!pending.length) return 0
    for (const item of pending) db.removeTodoQueueItem(userId, profile, todoId, item.id)
    const note = `排队的 ${pending.length} 条指令没有送达，已移出队列（${reason}）`
    db.appendTimeline(userId, profile, todoId, `${note}：${pending.map(i => clipQueued(i.text)).join(' / ')}`, 'system')
    const cur = db.getTodo(userId, profile, todoId)
    if (cur) db.updateTodo(userId, profile, todoId, { lastError: cur.lastError ? `${cur.lastError}；${note}` : note })
    emitUpdated(run, `todo.message.failed:${todoId}`)
    log?.warn?.('Queued worker instructions dropped', { todoId, count: pending.length, reason })
    return pending.length
  }

  async function settleWorkerRun(run, userId, profile, todoId, opts) {
    const before = db.getTodo(userId, profile, todoId)
    const res = await settleWorkerRunInner(run, userId, profile, todoId, opts)
    // A failed build turn (or a card that is finished) does not get its queued instructions later: the user
    // decides again instead of the plugin replaying a stale instruction after a newer one.
    if (before && opts?.sessionId && opts.sessionId === before.buildSessionId) {
      const after = db.getTodo(userId, profile, todoId)
      if (opts.outcome === 'failed') dropTodoQueue(run, userId, profile, todoId, '上一轮以失败结束')
      else if (after && TODO_QUEUE_DROP_PHASES.has(after.phase)) dropTodoQueue(run, userId, profile, todoId, '任务已结束')
    }
    await drainQueuedTodos(run, userId, profile).catch(() => {})
    return res
  }

  function wakeStatusLabel(phase) {
    if (phase === 'done') return '已完成'
    if (phase === 'failed') return '运行失败'
    if (phase === 'review' || phase === 'confirm') return '待你处理'
    if (phase === 'building' || phase === 'reviewing' || phase === 'merging') return '执行中'
    if (phase === 'queued') return '排队中'
    return phase
  }

  async function maybeWakeChief(run, userId, profile, todo, project, reason, { skipRun = false, deferRun = false } = {}) {
    adoptOrphanTopics(run, userId, profile)
    const watches = db.getActiveWatchesForTodo(userId, profile, todo.id)
    // Terminal merge/done events deduplicate without revision suffix so retries never emit duplicate notices
    const wakeKey = reason === 'merged'
      ? `wake:${todo.id}:merged`
      : `wake:${todo.id}:${todo.revision}:${todo.phase}:${reason}`
    for (const w of watches) {
      const topic = db.getTopic(userId, profile, w.topicId)
      // A watch that cannot wake a Chief is never skipped without a trace. Its wake_log key carries the
      // topic id, so it does not take the key of a watching topic that does have a Chief session.
      if (!topic || topic.archived) {
        if (!db.claimWakeKey(`${wakeKey}:undelivered:${w.topicId}`, todo.id, w.topicId)) continue
        const why = topic ? `话题「${topic.title}」已归档` : `话题 ${w.topicId} 已不存在`
        db.appendTimeline(userId, profile, todo.id, `进展通知未送达：${why}`, 'system')
        log?.warn?.('Todo progress notice not delivered: watching topic is archived or missing', { todoId: todo.id, topicId: w.topicId, reason })
        continue
      }
      // #97: a card watched from a topic that is not of its project (stored before the ownership check) wakes
      // nobody. Said once per card and topic: on the card timeline and as a system message in that topic.
      if (!topicOwnsProject(topic, todo.projectId)) {
        if (!db.claimWakeKey(`wake:${todo.id}:topic-mismatch:${topic.id}`, todo.id, topic.id)) continue
        const cardProject = project?.name || projectLabel(userId, profile, todo.projectId)
        db.appendTimeline(userId, profile, todo.id, `归属异常：卡片属于项目 ${cardProject}，话题「${topic.title}」${topicProjectPhrase(userId, profile, topic)}；进展通知不再投递到该话题，未唤醒任何总管。请修复卡片归属。`, 'system')
        db.addTopicMessage(userId, profile, topic.id, {
          kind: 'system',
          text: `归属异常：#${todo.number} ${todo.title} 属于项目 ${cardProject}，不属于本话题的项目。它的进展不再通知本话题，也不会唤醒总管；请在卡片上修复归属（转到项目 ${cardProject} 的话题）。`,
          todoId: todo.id,
          progressNotice: `归属异常：#${todo.number} 属于项目 ${cardProject}，未唤醒总管`,
        })
        log?.warn?.('Todo progress not delivered: watching topic belongs to another project; no Chief was woken', { todoId: todo.id, topicId: topic.id, reason })
        emitUpdated(run, `chief.wake.mismatch:${topic.id}`)
        continue
      }
      // #117: only the managing topic of a card is told about it. A watch of another topic of the project
      // (stored before the rule; the schema refuses new ones) ends here: no notice in that topic, no wake.
      if (!topicManagesTodo(topic, todo)) {
        db.clearWatch(topic.id, todo.id)
        if (db.claimWakeKey(`wake:${todo.id}:not-manager:${topic.id}`, todo.id, topic.id)) {
          db.appendTimeline(userId, profile, todo.id, `话题「${topic.title}」不是这张卡的管理话题，它的关注已结束：进展不投递到该话题，未唤醒其总管`, 'system')
          log?.warn?.('Todo progress not delivered: watching topic is not the managing topic of the card', { todoId: todo.id, topicId: topic.id, reason })
        }
        continue
      }
      if (!topic.chiefSessionId) {
        if (!db.claimWakeKey(`${wakeKey}:unattended:${topic.id}`, todo.id, topic.id)) continue
        db.addTopicMessage(userId, profile, topic.id, {
          kind: 'system',
          text: `关注的任务有进展：#${todo.number} ${todo.title}`,
          todoId: todo.id,
          questionTodoId: todo.question?.active ? todo.id : '',
          progressNotice: `关注的任务有进展：#${todo.number} → ${wakeStatusLabel(todo.phase)}（本话题没有总管会话，未唤醒总管）`,
        })
        db.appendTimeline(userId, profile, todo.id, `进展已记入话题「${topic.title}」，但该话题没有总管会话，未唤醒总管`, 'system')
        log?.warn?.('Todo progress recorded in a topic without a Chief session; no Chief was woken', { todoId: todo.id, topicId: topic.id, reason })
        if (todo.phase === 'done' || todo.phase === 'closed') db.clearWatch(topic.id, todo.id)
        emitUpdated(run, `chief.wake.unattended:${topic.id}`)
        continue
      }
      if (!db.claimWakeKey(wakeKey, todo.id, topic.id)) continue

      const statusLabel = wakeStatusLabel(todo.phase)

      db.addTopicMessage(userId, profile, topic.id, {
        kind: 'system',
        text: `关注的任务有进展：#${todo.number} ${todo.title}`,
        todoId: todo.id,
        questionTodoId: todo.question?.active ? todo.id : '',
        progressNotice: `关注的任务有进展：#${todo.number} → ${statusLabel}`,
      })

      if (todo.phase === 'done' || todo.phase === 'closed') {
        db.clearWatch(topic.id, todo.id)
      }

      if (skipRun) continue

      if (topic.autopilot || reason === 'build_failed') {
        // #104: the digest goes only into a wake that is launched right here. A wake that is queued is stored
        // without it: the turn that later delivers the queue reads the digest once (executeTopicTurnInner).
        // Before, every queued wake froze the same batch and the merged turn repeated it per wake.
        const digest = collectTopicDigest(userId, profile, topic)
        const wakePrompt = buildAutomatedWakePrompt({ topic, todo, project, reason, recentDigest: digest.rows })
        const queuedWake = digest.rows.length ? buildAutomatedWakePrompt({ topic, todo, project, reason, recentDigest: [] }) : wakePrompt
        if (isTopicCompressing(topic.id) || deferRun || run?.signal?.aborted) {
          // 0.9.43: compression in progress: keep the wake for later without marking the topic as running.
          // #64 (C06): same when the calling handle is (or will be) gone: queued, delivered by the next tick.
          db.enqueueTopicItem(userId, profile, topic.id, { kind: 'wake', text: queuedWake })
          emitUpdated(run, `chief.wake.queued:${topic.id}`)
          continue
        }
        const act = sessionActivity.get(topic.chiefSessionId)
        const liveProbe = (!topic.isRunning && !act?.running)
          ? await probeSessionWorking(run, topic.chiefSessionId, { timeoutMs: 700 }).catch(() => null)
          : null
        const chiefBusy = Boolean(launchingTopics.has(topic.id) || topic.isRunning || act?.running || (liveProbe?.known && liveProbe.isWorking))

        if (chiefBusy) {
          // NEVER drop wakes when Chief is busy: persist in topic_queue so complex multi-todo runs never stall!
          if (!topic.isRunning) db.updateTopic(userId, profile, topic.id, { isRunning: true })
          db.enqueueTopicItem(userId, profile, topic.id, { kind: 'wake', text: queuedWake })
          emitUpdated(run, `chief.wake.queued:${topic.id}`)
          continue
        }

        try {
          // #125: a wake turn answers no user message.
          setTurnMessage(topic.id, '')
          const launched = await launchSessionRun(run, topic.chiefSessionId, wakePrompt, { wait: false })
          const now = Date.now()
          sessionActivity.set(topic.chiefSessionId, {
            running: true,
            startedAt: now,
            updatedAt: now,
            activeTool: '',
            toolCount: 0,
            stage: 'thinking',
          })
          db.updateTopic(userId, profile, topic.id, {
            isRunning: true,
            activeRunId: String(launched?.run_id || launched?.queue_id || ''),
            // #104: delivered, so the clock moves to the moment this digest was read.
            lastDigestAt: digest.asOf,
          })
        } catch (err) {
          // Keep the wake instead of dropping it: the queue drain retries it with bounded back-off.
          // Not delivered: lastDigestAt is not moved, and the queued copy carries no digest.
          db.enqueueTopicItem(userId, profile, topic.id, { kind: 'wake', text: queuedWake })
          log?.warn?.(`Chief auto-wake failed, queued for retry: ${String(err?.message || err).slice(0, 200)}`, { topicId: topic.id, error: err.message })
        }
      }
    }
    // #104: a finished card keeps no watch, also not the ones that could not be notified above (archived or
    // missing topic, topic of another project).
    if (todo.phase === 'done' || todo.phase === 'closed') db.clearWatchesForTodo(userId, profile, todo.id)
  }

  async function askUserQuestion(run, { todoId = '', topicId = '', title: rawTitle, why: rawWhy, options, recommendation: rawRecommendation = '' }) {
    const { userId, profile } = run.identity
    // Question text is capped at the door, so neither the stored row nor the tool result can be oversized.
    const title = clampText(String(rawTitle || '').trim(), MAX_QUESTION_TEXT_CHARS)
    const why = clampText(String(rawWhy || '').trim(), MAX_QUESTION_TEXT_CHARS)
    const recommendation = clampText(String(rawRecommendation || '').trim(), MAX_QUESTION_TEXT_CHARS)
    // Normalise first, then cap (label 2,000, id 120): the capped list is the one stored and returned.
    const cleanOptions = clampOptions((options || []).slice(0, 4).map((opt, idx) => ({
      id: String((typeof opt === 'object' ? opt.id : '') || `opt-${idx + 1}`).trim(),
      label: String(typeof opt === 'string' ? opt : (opt?.label || '')).trim(),
      recommended: Boolean(typeof opt === 'object' ? opt.recommended : idx === 0),
    })).filter(o => o.label), MAX_QUESTION_TEXT_CHARS)
    const defaultRec = String(recommendation || '').trim()
      || (cleanOptions.find(o => o.recommended)?.label || cleanOptions[0]?.label || '')

    // Topic-level decision gate (no todoId): pins directly into Topic Brief AND Kanban "待你处理" column
    if (!todoId && topicId) {
      const topic = db.getTopic(userId, profile, topicId)
      if (!topic) throw new Error(`Topic not found: ${topicId}`)
      const summary = clampText(why ? `${title} — ${why}` : title, MAX_QUESTION_TEXT_CHARS)
      // db.updateTopic merges into the stored brief, so only the decision fields are sent (and capped).
      db.updateTopic(userId, profile, topic.id, {
        brief: {
          waitingTitle: String(title || '').trim(),
          waitingOnYou: summary,
          waitingRecommendation: defaultRec,
          waitingOptions: cleanOptions,
        },
      })
      emitUpdated(run, `topic.decision.asked:${topic.id}`)
      return { topicId: topic.id, phase: 'waiting_human', waitingOnYou: summary, waitingRecommendation: defaultRec, waitingOptions: cleanOptions }
    }

    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const nextPhase = canTransition(todo.phase, 'ASK_QUESTION')
      ? transitionTodoPhase(todo.phase, 'ASK_QUESTION')
      : 'confirm'
    const nextVersion = (todo.question?.version || 0) + 1

    db.updateTodo(userId, profile, todo.id, {
      phase: nextPhase,
      kind: 'question',
      gateOwner: 'human',
      gateKind: 'question',
      question: {
        active: true,
        version: nextVersion,
        title: String(title || '').trim(),
        why: String(why || '').trim(),
        options: cleanOptions,
        answeredText: '',
      },
    })
    db.appendTimeline(userId, profile, todo.id, `发起决策提问 v${nextVersion}：${title}`, 'chief')

    if (todo.topicId && !todoTopicMismatch(userId, profile, todo)) {
      db.addTopicMessage(userId, profile, todo.topicId, {
        kind: 'chief',
        text: `需要你拍板 **#${todo.number}**：${title}`,
        todoId: todo.id,
        questionTodoId: todo.id,
        progressNotice: `等待确认：#${todo.number} → 待你处理`,
      })
    }
    emitUpdated(run, `todo.question.asked:${todo.id}`)
    return db.getTodo(userId, profile, todo.id)
  }

  function instructionKey(todoId, kind, text) {
    return `${todoId}:${createHash('sha256').update(`${kind}\n${text}`).digest('hex').slice(0, 24)}`
  }

  function pruneRecentInstructions(now) {
    for (const [key, at] of recentInstructions) {
      if (now - at >= INSTRUCTION_DEDUPE_MS) recentInstructions.delete(key)
    }
  }

  // True when the todo's build session is known to be running a turn or to hold queued input.
  async function isBuildSessionBusy(run, todo) {
    if (!todo.buildSessionId) return false
    const probe = await probeSessionWorking(run, todo.buildSessionId, { timeoutMs: BUSY_PROBE_MS }).catch(() => null)
    return Boolean(probe?.known && (probe.isWorking || Number(probe.queueLength || 0) > 0))
  }

  /**
   * 0.9.42: start a worker run for at most `budgetMs`. Inside the budget the call returns the started card
   * (or fails with the launch error); after it, the card with `launchPending: true` while the launch goes on in
   * the background. A late failure is written on the card and announced with `todo.message.failed:<id>`.
   */
  async function startBuildBudgeted(run, args, budgetMs, { failNote = '指令没有送达', pendingNote = '指令已接受，正在后台启动（宿主尚未确认）', onDone, onFail } = {}) {
    const { userId, profile } = run.identity
    const todoId = args.todoId
    const work = settled(async () => {
      try {
        return await startBuild(run, args)
      } catch (err) {
        const errText = err?.message || String(err)
        // A refused run is written on the card by startBuild itself; any other failure is written here.
        const cur = db.getTodo(userId, profile, todoId)
        if (cur && cur.phase !== 'failed' && !err?.todoFailureRecorded) {
          db.appendTimeline(userId, profile, todoId, `${failNote}：${errText}`, 'system')
        }
        emitUpdated(run, `todo.message.failed:${todoId}`)
        log?.warn?.('Worker launch failed for an instruction', { todoId, error: errText })
        try { onFail?.(err) } catch {}
        throw err
      } finally {
        try { onDone?.() } catch {}
      }
    })
    // 0.9.65: the call waits for the launch in full. Answering early left the launch running on a host
    // handle that expires with the call, so the host cancelled it. `budgetMs`/`pendingNote` are kept for callers.
    void budgetMs; void pendingNote
    const result = await work
    if (!result.ok) throw result.error
    return result.value
  }

  /**
   * 0.9.42: the one path for instructions to a todo's worker (message-todo, request-changes, answer-question,
   * confirm-plan). Order: (1) the same instruction inside INSTRUCTION_DEDUPE_MS answers the current card with
   * `duplicate: true` and does nothing else; (2) another instruction or a start already under way for this card
   * is refused with a reason written on the timeline; (3) `record()` writes the instruction on the card;
   * (4) a busy build session gets it in `todo_queue` (delivered when the run ends, `queued: true`);
   * (5) otherwise the run is started within the remaining budget (see startBuildBudgeted).
   */
  async function dispatchInstruction(run, todo, { kind, text, prompt, label, record, pendingNote }) {
    const { userId, profile } = run.identity
    const startedAt = Date.now()
    pruneRecentInstructions(startedAt)
    const key = instructionKey(todo.id, kind, text)
    if (recentInstructions.has(key)) {
      const cur = db.getTodo(userId, profile, todo.id)
      return { ...cur, duplicate: true, ...(startingNotes.get(todo.id) === key || startingTodos.has(todo.id) ? { launchPending: true } : {}) }
    }
    if (startingNotes.has(todo.id) || startingTodos.has(todo.id)) {
      const reason = startingNotes.has(todo.id) ? '上一条指令还在送达中' : '构建还在启动中'
      db.appendTimeline(userId, profile, todo.id, `${label}没有发出：${reason}，请稍后再发`, 'system')
      emitUpdated(run, `todo.message.failed:${todo.id}`)
      throw new Error(`#${todo.number} 的${reason}，这条${label}没有发出，请稍后再发。`)
    }
    recentInstructions.set(key, startedAt)
    startingNotes.set(todo.id, key)
    const release = () => { if (startingNotes.get(todo.id) === key) startingNotes.delete(todo.id) }
    try {
      record?.()
      if (await isBuildSessionBusy(run, todo)) {
        // #107: todo_queue cuts a text at MAX_QUEUED_TEXT_CHARS; a longer one is refused instead of delivered cut.
        if (String(prompt).length > MAX_QUEUED_TEXT_CHARS) {
          const reason = `执行者会话正忙，${label}需要排队，但内容 ${String(prompt).length} 字超过排队上限 ${MAX_QUEUED_TEXT_CHARS} 字`
          db.appendTimeline(userId, profile, todo.id, `${label}没有送达：${reason}，请精简后重发，或等本轮结束后再发`, 'system')
          emitUpdated(run, `todo.message.failed:${todo.id}`)
          throw new Error(`#${todo.number} 的${label}没有送达：${reason}。请精简后重发，或等本轮结束后再发。`)
        }
        db.enqueueTodoItem(userId, profile, todo.id, { kind, text: prompt })
        db.appendTimeline(userId, profile, todo.id, `${label}已排队，本轮结束后自动送达`, 'orchestrator')
        emitUpdated(run, `todo.message.queued:${todo.id}`)
        release()
        return { ...db.getTodo(userId, profile, todo.id), queued: true }
      }
    } catch (err) {
      release()
      recentInstructions.delete(key)
      throw err
    }
    const budget = Math.max(0, MESSAGE_TODO_BUDGET_MS - (Date.now() - startedAt))
    return startBuildBudgeted(run, { todoId: todo.id, withPlan: false, extraMessage: prompt, instructionKind: kind }, budget, {
      failNote: `${label}没有送达`,
      ...(pendingNote ? { pendingNote } : {}),
      onDone: release,
      onFail: () => recentInstructions.delete(key),
    })
  }

  async function answerQuestion(run, { todoId, optionId, note }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const picked = findOptionById(todo.question?.options || [], optionId)
    const answer = String(note || '').trim() || picked?.label || '按推荐方案推进'

    const resumed = await dispatchInstruction(run, todo, {
      kind: 'answer',
      text: answer,
      label: '用户决策',
      prompt: `The user answered your blocking question:\n"${answer}"\n\nContinue implementing Todo #${todo.number} in ${todo.worktreePath} based on this decision.`,
      record: () => {
        db.updateTodo(userId, profile, todo.id, {
          kind: todo.kind === 'question' ? 'feature' : todo.kind,
          question: { ...todo.question, active: false, answeredText: answer },
          spec: `${todo.spec}\n\nUser Decision (v${todo.question?.version || 1}): ${answer}`.trim(),
        })
        db.appendTimeline(userId, profile, todo.id, `用户决策：${answer}`, 'user')
      },
    })
    if (todo.topicId && !resumed.duplicate && !todoTopicMismatch(userId, profile, todo)) {
      db.addTopicMessage(userId, profile, todo.topicId, {
        kind: 'system',
        text: resumed.queued
          ? `已记下你对 #${todo.number} 的决定，执行者本轮结束后自动送达。`
          : resumed.launchPending
            ? `已记下你对 #${todo.number} 的决定，正在后台恢复构建。`
            : `已将你对 #${todo.number} 的决定同步给执行者并恢复构建。`,
        todoId: todo.id,
        progressNotice: `关注的任务有进展：#${todo.number} → 执行中`,
      })
    }
    return resumed
  }

  async function confirmPlan(run, { todoId, note }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const text = String(note || '').trim()
    return dispatchInstruction(run, todo, {
      kind: 'plan',
      text,
      label: '方案确认',
      prompt: text
        ? `Plan approved with note: ${text}\nProceed with full implementation and testing now.`
        : 'Plan approved. Proceed with full implementation and testing inside the isolated worktree now.',
      record: () => db.appendTimeline(userId, profile, todo.id, `方案已确认${text ? `：${text}` : ''}`, 'user'),
    })
  }

  async function requestChanges(run, { todoId, note }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const reviewFindings = todo.evidence?.reviewVerdict === 'changes_requested'
      ? String(todo.evidence?.reviewSummary || '').trim()
      : ''
    const feedback = String(note || '').trim()
      || (reviewFindings ? `独立审查要求修改：\n${reviewFindings}` : '请按审查意见修改并重新验证测试。')
    return dispatchInstruction(run, todo, {
      kind: 'changes',
      text: feedback,
      label: '退回修改',
      prompt: `Changes requested for Todo #${todo.number}:\n${feedback}\n\nFix the issues in the worktree and re-run tests.`,
      record: () => db.appendTimeline(userId, profile, todo.id, `退回修改：${feedback.slice(0, 100)}`, 'user'),
    })
  }

  async function messageTodo(run, { todoId, note, caller = 'user' }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const text = String(note || '').trim()
    // #107: an empty or over-long message is refused with a reason on the card; nothing is sent, nothing cut.
    if (!text) {
      db.appendTimeline(userId, profile, todo.id, '补充指令没有发出：内容为空', 'system')
      emitUpdated(run, `todo.message.failed:${todo.id}`)
      throw new Error(`#${todo.number} 的补充指令没有发出：内容为空（Follow-up message is required）。`)
    }
    if (text.length > MAX_TODO_MESSAGE_CHARS) {
      db.appendTimeline(userId, profile, todo.id, `补充指令没有发出：内容 ${text.length} 字，超过上限 ${MAX_TODO_MESSAGE_CHARS} 字（未截断、未送达）`, 'system')
      emitUpdated(run, `todo.message.failed:${todo.id}`)
      throw new Error(`#${todo.number} 的补充指令没有发出：内容 ${text.length} 字，超过上限 ${MAX_TODO_MESSAGE_CHARS} 字。请精简后重发，或用 update_todo 写进任务书后再 run_build。`)
    }
    return dispatchInstruction(run, todo, {
      kind: 'message',
      text,
      label: '补充指令',
      prompt: text,
      pendingNote: '补充指令已接受，正在后台启动（宿主尚未确认）',
      // 0.9.57: the Chief's message_todo was recorded as the user's.
      record: () => db.appendTimeline(userId, profile, todo.id, caller === 'chief' ? '总管发送补充指令' : '发送补充指令', caller === 'chief' ? 'chief' : 'user'),
    })
  }

  /**
   * Server-side merge gate. Merging is only legal from the review gate ('review').
   * Humans (UI) may merge anything parked there, including overriding a rejected review or approving a deploy.
   * The Chief (MCP merge_build) additionally needs: topic AUTO on, project auto-merge on, an APPROVED
   * independent review of the current build, a passing test gate (when configured), and no deploy redline.
   */
  function assertMergeAllowed(userId, profile, todo, project, caller) {
    if (todo.phase !== 'review') {
      throw new Error(`#${todo.number} 当前阶段为「${todo.phase}」，只有构建完成、停在待合并关口的任务才能合并。`)
    }
    // 0.9.55: a delivered report has no branch change to merge; acceptance is complete_todo.
    if (todo.gateKind === 'deliverable') {
      throw new Error(`#${todo.number} 是调研 / 内容类任务，成果是文字报告、没有代码可合并；请阅读成果后用「验收完成」（complete_todo）结束。`)
    }
    if (caller !== 'chief') return
    const topic = todo.topicId ? db.getTopic(userId, profile, todo.topicId) : null
    const verdict = todo.evidence?.reviewVerdict || 'none'
    const testRc = Number(todo.evidence?.testRc ?? -1)
    const reasons = []
    if (todo.kind === 'deploy' && project.autopilot.requireHumanForDeploy !== false) reasons.push('部署类任务必须由用户放行')
    if (!topic?.autopilot) reasons.push('所在话题未开启 AUTO')
    if (!project.autopilot.autoMergeAfterReview) reasons.push(`项目 ${project.name} 未允许审查通过后由总管合并`)
    if (verdict !== 'approved') reasons.push(`独立审查结论为「${verdict}」，需先 run_review 且结论为 APPROVED`)
    // #103: an approval given while the worktree was changing is not an approval of what would be merged.
    if (todo.evidence?.reviewDrift) reasons.push(`审查期间工作树被改动（${todo.evidence.reviewDrift}），需重新 run_review`)
    if (project.testCommand && testRc !== 0) reasons.push(`验收命令未通过（rc=${testRc}）`)
    if (todo.question?.active) reasons.push('存在未答复的用户问题')
    if (reasons.length) {
      throw new Error(`拒绝合并 #${todo.number}：${reasons.join('；')}。请总结结果交给用户在看板上确认合并。`)
    }
  }

  /**
   * #68: what a disposed instance does instead of a write: one warn line naming what was dropped. Returns null.
   */
  function noteDisposedDrop(what, data = {}) {
    log?.warn?.(`写入已废弃：插件实例已卸载（dispose），丢弃${what}`, data)
    return null
  }

  /**
   * #68: a background entry of this instance. Called after dispose it does nothing; an error that surfaces after
   * dispose (the refused database call, an aborted host call) is logged as dropped instead of thrown.
   */
  function disposedSafe(label, fn) {
    return async (...args) => {
      if (disposed) return noteDisposedDrop(`${label}调用`)
      try {
        return await fn(...args)
      } catch (err) {
        if (!disposed && err?.code !== DISPOSED_CODE) throw err
        return noteDisposedDrop(label, { error: err?.message || String(err) })
      }
    }
  }

  /**
   * #68: end what this instance started. Aborts the running test gates (their process groups get SIGTERM, then
   * SIGKILL), ends a `gh auth login` device flow, marks the merges still running as abandoned, and from here on
   * refuses every database call (see guardDisposedDb). index.mjs closes the database right after. Idempotent.
   */
  function dispose() {
    if (disposed) return
    disposed = true
    pendingSettles.clear()
    disposeController.abort()
    try { cancelGithubDeviceLogin() } catch (err) { log?.warn?.(`dispose: 结束 gh auth login 失败：${err?.message || String(err)}`) }
    for (const token of inflightMerges) {
      token.abandoned = true
      log?.warn?.(`合并已废弃：插件实例已卸载（dispose），#${token.number} 的在途合并不再写卡片`, { todoId: token.todoId })
    }
  }

  async function mergeBuild(run, { todoId, commitMessage, caller = 'user', asyncMode = false }) {
    const { userId, profile } = run.identity
    let todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const project = db.getProject(userId, profile, todo.projectId)
    if (!project) throw new Error(`Project not found: ${todo.projectId}`)

    // Strict idempotency guard: prevent double-click / concurrent duplicate merges & duplicate Chief commands
    if (todo.phase === 'done' || todo.phase === 'merging' || mergingTodos.has(todoId)) {
      return todo
    }
    // First check, outside the lock: a merge that is not allowed costs no lock and writes no busy line.
    assertMergeAllowed(userId, profile, todo, project, caller)

    // 0.9.48: one write at a time per card. Held together with mergingTodos until the merge has ended.
    const writeLock = lockTodoForWrite(run, todo, '合并', '合并没有执行', { note: true })
    const releaseMerge = () => {
      mergingTodos.delete(todoId)
      todoMergeActivity.delete(todoId)
      dropTodoWriteLock(todoId, writeLock)
    }
    let mergingPhase
    try {
      // 0.9.49 (#46): second check, inside the lock, on the card as it is stored now. The first check read
      // the card before the lock was held; whatever is decided from here on (phase, verdict, test result,
      // branch, worktree) is decided on a card no other write entry can change any more.
      todo = db.getTodo(userId, profile, todoId)
      if (!todo) throw new Error(`Todo not found: ${todoId}`)
      assertMergeAllowed(userId, profile, todo, project, caller)
      mergingPhase = canTransition(todo.phase, 'START_MERGE')
        ? transitionTodoPhase(todo.phase, 'START_MERGE')
        : 'merging'
      // Validate terminal transition up front before locking
      transitionTodoPhase(mergingPhase, 'MERGE_COMPLETED')

      mergingTodos.add(todoId)
      const startedAt = Date.now()
      todoMergeActivity.set(todoId, {
        running: true,
        startedAt,
        updatedAt: startedAt,
        activeTool: `git merge → ${project.defaultBranch}`,
        toolCount: 1,
        stage: 'merging',
      })

      // Immediately move card to "执行中" (phase = 'merging') so user sees instant feedback with zero lag
      db.updateTodo(userId, profile, todo.id, {
        phase: mergingPhase,
        gateOwner: 'chief',
        gateKind: 'merge',
        lastError: '',
      })
      db.appendTimeline(userId, profile, todo.id, `开始合并分支至 ${project.defaultBranch}`, caller === 'chief' ? 'chief' : 'user')
      emitUpdated(run, `todo.merging:${todo.id}`)
    } catch (err) {
      releaseMerge()
      throw err
    }

    // #68: dispose() marks this token abandoned; from then on the merge writes nothing (git is not interrupted:
    // a half-done merge is worse). The next instance's reconcile puts a card left in `merging` back at the gate.
    const mergeToken = { todoId, number: todo.number, abandoned: false }
    inflightMerges.add(mergeToken)
    const abandonMerge = (detail, err = null) => {
      noteDisposedDrop(`#${todo.number} 的合并结果（${detail}）`, { todoId, ...(err ? { error: err?.message || String(err) } : {}) })
      if (!asyncMode) throw disposedError('合并')
      return null
    }
    const executeMerge = async () => {
      try {
        // #103: what is merged must be the commit that was reviewed. Asked of git as the first step of the
        // merge (the card already shows `merging`; entering it stays synchronous). A refusal is not a failed
        // merge: the card goes back to the gate it came from (state event CANCEL), handed to the user, with
        // the reason on `lastError` and the timeline. Nothing was merged, so retry_merge has nothing to do.
        const refusal = await reviewBindingRefusal({ userId, profile, todo, project, caller })
        if (mergeToken.abandoned) return abandonMerge('合并前核对审查快照')
        if (!stillOwnsWrite(todoId, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '合并前核对审查快照')
        if (refusal?.refused) {
          db.updateTodo(userId, profile, todo.id, {
            phase: transitionTodoPhase(mergingPhase, 'CANCEL'),
            gateOwner: 'human',
            gateKind: todo.gateKind,
            lastError: refusal.message,
            evidence: refusal.evidence,
          })
          db.appendTimeline(userId, profile, todo.id, refusal.line, 'system')
          emitUpdated(run, `todo.merge.refused:${todo.id}`)
          throw Object.assign(new Error(refusal.message), { mergeRefused: true })
        }
        if (refusal?.note) db.appendTimeline(userId, profile, todo.id, refusal.note, refusal.actor)
        // #102: there is no merge without a branch and a worktree, and no `done` without the proof
        // mergeWorktreeBranch returns (the card's commit is an ancestor of the base branch). mergedSha is
        // read after that proof; a MergeVerificationError lands in the catch below with everything kept.
        // #109: the commit that was checked above is handed down as a hard parameter (`expectedHeadSha`): the
        // reviewed commit, or for a card without one the HEAD the binding read (the one the user confirmed).
        // With it, or with a snapshot, the merge refuses a worktree that holds uncommitted changes and never
        // commits them; only a card that has neither keeps the automatic commit, written on the timeline the
        // moment it is made.
        const merged = await mergeWorktreeBranchImpl({
          repoPath: project.repoPath,
          worktreePath: todo.worktreePath,
          branchName: todo.branch,
          baseBranch: project.defaultBranch,
          commitMessage: commitMessage || `feat(ekko-todo): #${todo.number} ${todo.title}`,
          snapshotSha: todo.snapshotSha || '',
          expectedHeadSha: todo.reviewedSha || refusal?.expectedHeadSha || '',
          onAutoCommit: ({ count, headSha }) => {
            if (mergeToken.abandoned || !stillOwnsWrite(todoId, writeLock)) return
            db.appendTimeline(userId, profile, todo.id, `为无审查快照的卡自动提交了 ${count} 个文件（提交 ${String(headSha || '').slice(0, 12) || '未知'}），这些改动没有经过审查，随本次合并进入 ${project.defaultBranch}`, 'system')
          },
        })
        const mergedSha = merged.mergedSha
        if (mergeToken.abandoned) return abandonMerge(`git 已合并，${project.defaultBranch} 上为 ${mergedSha || '未知提交'}`)
        // 0.9.49: the merge outlived the lock TTL and another write took the card over. The branch is merged
        // (git cannot be undone here), but the card is the new holder's: only the fact is put on the timeline.
        if (!stillOwnsWrite(todoId, writeLock)) {
          return discardStaleWrite(run, userId, profile, todo.id, `合并已执行，${project.defaultBranch} 上为 ${mergedSha || '未知提交'}`)
        }

        const donePhase = transitionTodoPhase(mergingPhase, 'MERGE_COMPLETED')
        db.updateTodo(userId, profile, todo.id, {
          phase: donePhase,
          gateOwner: 'none',
          gateKind: 'none',
          worktreePath: '',
          snapshotSha: mergedSha,
          evidence: {
            commitSha: mergedSha,
            mergedSha,
            mergeKind: merged.mergeKind,
            mergeVerifiedSha: merged.verifiedSha,
            mergeSnapshotSha: todo.snapshotSha || '',
            mergeVerify: 'passed',
          },
          lastError: '',
        })
        db.appendTimeline(userId, profile, todo.id, mergedTimelineText(project.defaultBranch, merged), caller === 'chief' ? 'chief' : 'user')
        const settled = db.getTodo(userId, profile, todo.id)
        emitUpdated(run, `todo.merged:${todo.id}`)
        // Never block merge or self-wake Chief when Chief itself called merge_build (prevents 120s timeout & duplicate wakes)
        // #64 (C06): in async mode the RPC has already returned, so its handle is gone: the wake is queued
        // and the `reconcile` scheduler action delivers it with its own handle on the next tick.
        void maybeWakeChief(run, userId, profile, settled, project, 'merged', { skipRun: caller === 'chief', deferRun: asyncMode }).catch(err => {
          log?.warn?.(`Wake after merge failed: ${err?.message || String(err)}`, { todoId: todo.id })
        })
        // #104: the wake above has read its watch list (synchronously, before its first await); the merged
        // card keeps none.
        db.clearWatchesForTodo(userId, profile, todo.id)
        return settled
      } catch (err) {
        // #103: refused before git merged anything; the card is already back at its gate.
        if (err?.mergeRefused) throw err
        const errText = err?.message || String(err)
        if (mergeToken.abandoned) return abandonMerge(`合并失败：${clipQueued(errText)}`, err)
        if (!stillOwnsWrite(todoId, writeLock)) {
          discardStaleWrite(run, userId, profile, todo.id, `合并失败：${clipQueued(errText)}`)
          throw err
        }
        const failPhase = canTransition(mergingPhase, 'MERGE_FAILED')
          ? transitionTodoPhase(mergingPhase, 'MERGE_FAILED')
          : 'failed'
        // 0.9.48: only the phase, the gate and the error are written. branch, worktreePath, snapshotSha, diffs
        // and evidence (review verdict included) stay as they are: retry_merge needs them. The way back and
        // the conflicting files come first in the text, so a long git error cannot cut them off.
        // #102: a merge that could not be proven is its own kind of failure. The text starts with 「合并失败」
        // (retry_merge reads that) and carries the marker `merge_verify_failed`; the worktree and the branch
        // were not touched, and the card is not `done`.
        const verifyFailed = err?.code === 'MERGE_VERIFY_FAILED'
        const conflictFiles = verifyFailed ? [] : extractConflictFiles(errText)
        const failText = verifyFailed
          ? `合并失败（merge_verify_failed：合并校验未通过，未标记完成，工作树与分支已保留；核实后可调用 retry_merge 回到合并关口，审查结论保留）：${errText}`
          : `合并失败（${conflictFiles.length ? `冲突文件：${conflictFiles.join('、')}；` : ''}处理后可调用 retry_merge 回到合并关口，审查结论保留）：${errText}`
        db.updateTodo(userId, profile, todo.id, {
          phase: failPhase,
          gateOwner: 'human',
          gateKind: 'failed',
          lastError: failText,
          ...(verifyFailed ? { evidence: { mergeVerify: 'failed' } } : {}),
        })
        db.appendTimeline(userId, profile, todo.id, failText, 'system')
        emitUpdated(run, `todo.merge_failed:${todo.id}`)
        throw err
      } finally {
        inflightMerges.delete(mergeToken)
        releaseMerge()
      }
    }

    if (asyncMode) {
      void executeMerge().catch(err => {
        log?.warn?.('Async merge failed', { todoId, error: err?.message || String(err) })
      })
      return db.getTodo(userId, profile, todo.id)
    }

    return executeMerge()
  }

  /**
   * #103: the review binding of a merge. Read-only: asks git where the task branch stands and answers
   *  - null: merge (the branch is the reviewed commit, or the card has no branch / worktree to ask about);
   *  - `{ note, actor, expectedHeadSha }`: merge, and write this line first (a card without a review snapshot
   *    that the user confirmed, or that the setting lets through). #109: `expectedHeadSha` is the HEAD this
   *    check read when the card has a snapshot ('' when it has none: only then the merge may still commit
   *    what is uncommitted);
   *  - `{ refused: true, line, message, evidence }`: do not merge (mergeBuild writes the card).
   * The card has `reviewedSha`: the worktree HEAD and the branch tip must equal it and `git status
   * --porcelain` must be empty, for the user and the Chief alike; both shas are in the refusal.
   * The card has none (stored before #103, never reviewed, or reviewed before the last build dispatch): with
   * the setting `confirmUnreviewedMerge` on (default) the Chief is refused, and the user is asked once: the
   * first call is refused with `evidence.unreviewedMergeAsk` = the HEAD asked about; a second call by the
   * user on that same HEAD is the confirmation and merges. With the setting off the merge goes on with a line
   * saying so. #109: such a card that has a snapshot (`snapshotSha`) and uncommitted changes is refused first,
   * for both callers and whatever the setting (the changes came after the snapshot; they are not committed by
   * the merge any more). Only a card without snapshot still has them committed by the merge.
   */
  async function reviewBindingRefusal({ userId, profile, todo, project, caller }) {
    if (!todo.branch || !todo.worktreePath) return null
    let state = null
    let readError = ''
    try {
      state = await readReviewBinding({ repoPath: project.repoPath, worktreePath: todo.worktreePath, branchName: todo.branch })
    } catch (err) {
      readError = String(err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 200)
    }
    if (todo.reviewedSha) {
      const problem = state
        ? reviewBindingProblem(todo.reviewedSha, state)
        : `读不到工作树的当前状态（${readError}），无法确认它仍是被审提交 ${todo.reviewedSha}`
      if (!problem) return null
      const text = problem.slice(0, REVIEW_DRIFT_MAX)
      return {
        refused: true,
        line: `合并未执行：${text}。合并的必须是审查过的那一版，请提交改动后重新派发审查`,
        message: `拒绝合并 #${todo.number}：${text}。合并的必须是审查过的那一版，请重新派发审查（run_review）后再合并。`,
        evidence: { reviewDrift: text },
      }
    }
    const head = state?.headSha || state?.branchSha || ''
    const shortHead = head.slice(0, 12) || '未知'
    const why = (todo.evidence?.reviewVerdict || 'none') === 'none'
      ? '这一版没有经过独立审查'
      : '审查结论是旧版本记下的，没有记录被审的是哪个提交'
    // #109: the card has a snapshot, so the merge commits nothing itself (the files may be the ones the
    // snapshot was taken of, or later ones: git status cannot tell, and nobody reviewed either). Refused
    // here, before anyone is asked to confirm a merge that mergeWorktreeBranch would refuse anyway.
    if (todo.snapshotSha && state?.dirtyCount) {
      const names = (state.dirtyPaths || []).slice(0, 5).join('、')
      const text = `工作树有 ${state.dirtyCount} 项未提交改动（${names}${state.dirtyCount > 5 ? ' 等' : ''}）`.slice(0, REVIEW_DRIFT_MAX)
      return {
        refused: true,
        line: `合并未执行：${text}，合并不会自动提交它们，请先提交或清理再合并；也可以派发独立审查（派审查时会先提交这些改动）`,
        message: `拒绝合并 #${todo.number}：${text}，合并不会自动提交它们。请先提交或清理再合并；也可以 run_review（派审查时会先提交这些改动并记录被审提交）。`,
        evidence: {},
      }
    }
    const expectedHeadSha = todo.snapshotSha ? head : ''
    const dirtyNote = state?.dirtyCount ? `，另有 ${state.dirtyCount} 项未提交改动会随合并一并提交` : ''
    if (db.getSettings(userId, profile, config).confirmUnreviewedMerge === false) {
      return { note: `无审查快照（${why}），按设置不要求确认，直接合并 HEAD ${shortHead}${dirtyNote}`, actor: 'system', expectedHeadSha }
    }
    if (caller === 'chief') {
      return {
        refused: true,
        line: `合并未执行：无审查快照（${why}），总管不能合并，需要用户在看板确认合并，或重新派发审查`,
        message: `拒绝合并 #${todo.number}：没有审查快照（${why}）。请重新 run_review（会记录被审提交），或交给用户在看板上确认合并。`,
        evidence: {},
      }
    }
    if (head && todo.evidence?.unreviewedMergeAsk === head) {
      return { note: `用户已确认合并无审查快照的分支（HEAD ${shortHead}${dirtyNote}）`, actor: 'user', expectedHeadSha }
    }
    return {
      refused: true,
      line: `合并未执行：无审查快照（${why}），需要你确认。再点一次合并即确认按当前 HEAD ${shortHead} 合并${dirtyNote}；也可以先派发独立审查`,
      message: `#${todo.number} 没有审查快照（${why}），合并前需要你确认：再点一次合并即按当前 HEAD ${shortHead} 合并${dirtyNote}；也可以先派发独立审查。`,
      evidence: { unreviewedMergeAsk: head },
    }
  }

  // #102: the timeline line of a proven merge; one wording per mergeKind, each naming the proven commit.
  function mergedTimelineText(baseBranch, merged) {
    const proven = String(merged.verifiedSha || '').slice(0, 12)
    if (merged.mergeKind === 'already_merged') {
      return `分支提交 ${proven} 已在 ${baseBranch} 中（${baseBranch}=${merged.mergedSha}），无需再次合并；已验证它是 ${baseBranch} 的祖先`
    }
    if (merged.mergeKind === 'fast_forward') {
      return `已合并至 ${baseBranch}（${merged.mergedSha}，快进，未产生合并提交；已验证 ${proven} 是 ${baseBranch} 的祖先）`
    }
    return `已合并至 ${baseBranch}（${merged.mergedSha}，新合并提交；已验证 ${proven} 是 ${baseBranch} 的祖先）`
  }

  // 0.9.48: file names out of a git merge error (`CONFLICTS: a.txt:content, b/c.js:add/add`). At most 20.
  function extractConflictFiles(errText) {
    const m = /CONFLICTS?:\s*([^\n]+)/.exec(String(errText || ''))
    if (!m) return []
    const files = []
    for (const part of m[1].split(/,\s*/)) {
      const cut = part.lastIndexOf(':')
      const file = (cut > 0 ? part.slice(0, cut) : part).trim()
      if (file && !files.includes(file)) files.push(file)
      if (files.length >= 20) break
    }
    return files
  }

  /**
   * 0.9.48: who holds the merge gate of a card parked in `review`, read from the settings as they are now.
   * The same conditions the build settle and assertMergeAllowed use: a deploy card, a topic without AUTO, a
   * project without auto-merge, a test gate that did not pass (when one is configured), a skipped gate
   * (`evidence.gateSkipped`) or an open question leave the gate with the user. The value only tells the board
   * and the Chief whose turn it is: merge_build checks every condition again when it is called.
   */
  function mergeGateOwner(userId, profile, todo, project) {
    const topic = todo.topicId ? db.getTopic(userId, profile, todo.topicId) : null
    const testRc = Number(todo.evidence?.testRc ?? -1)
    return mergeGateNeedsHuman({
      todo,
      topic,
      project,
      testFailed: Boolean(project.testCommand && testRc !== 0),
      gateSkipped: todo.evidence?.gateSkipped,
      openQuestion: todo.question?.active,
    }) ? 'human' : 'chief'
  }

  /**
   * 0.9.49: the one rule for "the user holds the merge gate", shared by the build settle and retry_merge.
   * The callers supply what differs between them: the build settle passes the result of the test gate it just
   * ran and why it was skipped; retry_merge passes what the card's evidence says, plus an open question.
   * Not used by assertMergeAllowed, which on purpose lets the user merge a card whose gate was skipped.
   */
  function mergeGateNeedsHuman({ todo, topic, project, testFailed = false, gateSkipped = '', openQuestion = false }) {
    return todo.kind === 'deploy'
      || !topic?.autopilot
      // #97: a topic that is not of the card's project gives no Chief the gate; it is the user's.
      || !topicOwnsProject(topic, todo.projectId)
      || !project.autopilot.autoMergeAfterReview
      || Boolean(testFailed)
      || Boolean(gateSkipped)
      || Boolean(openQuestion)
  }

  /**
   * 0.9.48: put a card whose merge failed back at the merge gate. Only for `failed` + gateKind `failed` with
   * a lastError that starts with 「合并失败」, a branch and a worktree that still exists on disk (it is never
   * recreated: that would lose the changes). Writes phase, gate and lastError only; evidence (review verdict,
   * test result, gateSkipped) is carried over untouched. Does not merge: merge_build runs its checks again.
   * A refusal is written on the timeline and changes nothing else.
   * 0.9.49: `caller` ('user' | 'chief', default 'user') is the actor of the timeline line, as in mergeBuild;
   * the worktree path must be a directory (a file at that path is refused like a missing one).
   */
  async function retryMerge(run, { todoId, caller = 'user' }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const writeLock = lockTodoForWrite(run, todo, '重试合并', '重试合并没有执行', { note: true })
    try {
      const project = db.getProject(userId, profile, todo.projectId)
      let why = ''
      if (!project) {
        why = '所属项目已不存在'
      } else if (todo.phase !== 'failed' || todo.gateKind !== 'failed') {
        why = `当前阶段为「${todo.phase}」，retry_merge 只处理因合并失败而停在 failed 的任务`
      } else if (!String(todo.lastError || '').startsWith('合并失败')) {
        why = '上次失败不是合并失败，retry_merge 只处理合并失败；构建失败或没有产出的任务请重新构建'
      } else if (!todo.branch || !todo.worktreePath) {
        why = '任务分支或工作树记录已清空，无法原样重试，请重新构建'
      } else if (!isExistingDirectory(todo.worktreePath)) {
        why = `工作树 ${todo.worktreePath} 已不存在或不是目录；不会自动重建（重建会丢失未合并的改动），请重新构建`
      }
      if (why) {
        db.appendTimeline(userId, profile, todo.id, `重试合并没有执行：${why}`, 'system')
        emitUpdated(run, `todo.merge_retry.refused:${todo.id}`)
        throw new Error(`#${todo.number} 不能重试合并：${why}。`)
      }
      const nextPhase = transitionTodoPhase(todo.phase, 'RETRY_MERGE')
      db.updateTodo(userId, profile, todo.id, {
        phase: nextPhase,
        gateOwner: mergeGateOwner(userId, profile, todo, project),
        gateKind: todo.kind === 'deploy' ? 'deploy' : 'merge',
        lastError: '',
      })
      db.appendTimeline(userId, profile, todo.id, '重新进入合并关口（保留上次审查结论）', caller === 'chief' ? 'chief' : 'user')
      emitUpdated(run, `todo.merge_retry:${todo.id}`)
      return db.getTodo(userId, profile, todo.id)
    } finally {
      dropTodoWriteLock(todoId, writeLock)
    }
  }

  function isExistingDirectory(path) {
    try { return statSync(path).isDirectory() } catch { return false }
  }

  // 0.9.49 (#46): `done` and `closed` are the phases a stop is refused in; every other phase keeps what it did.
  const UNSTOPPABLE_PHASES = new Map([
    ['done', '已完成'],
    ['closed', '已关闭'],
  ])
  function assertStoppable(todo) {
    const state = UNSTOPPABLE_PHASES.get(todo.phase)
    if (!state) return
    throw new Error(`#${todo.number} ${state}，没有可停止的运行，本次停止没有执行。需要再做请重新打开或重新派发。`)
  }

  /**
   * Stop what runs on a card (`discard`: also remove its worktree and branch).
   * 0.9.49: takes the card's write lock, and is refused with 「任务正在合并，完成后再操作」 before anything is
   * stopped or removed when a merge is running in this process (stopping a session does not stop a git merge)
   * or, with `discard`, when the card is in `merging` at all (the merge reads that branch and worktree). A
   * card left in `merging` with no merge running is still freed by a stop without discard (-> `review`).
   */
  // 0.9.70 (#85): `reason` (internal callers only, not an RPC / tool input): the stall watchdog stops a card
  // with a readable cause. It becomes the card's lastError and the timeline line (actor system) instead of the
  // user's 「已停止当前运行」.
  // 0.9.70 (#91): `stoppedSessionId` (internal, the watchdog): that session was already stopped and the host
  // confirmed it; it is not stopped a second time (a second stop without a timeout could hang the reconcile).
  async function cancelBuild(run, { todoId, discard = false }, { reason = '', stoppedSessionId = '' } = {}) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    if (mergingTodos.has(todo.id) || (discard && todo.phase === 'merging')) {
      throw new Error('任务正在合并，完成后再操作')
    }
    // 0.9.49 (#46): a finished card has nothing to stop. Before, CANCEL had no exit from `done` / `closed`
    // and the fallback wrote the card back to `todo` (a merged card reappeared as open work; with `discard`
    // the worktree and branch a closed card had kept were removed). Refused before anything is stopped.
    assertStoppable(todo)
    const writeLock = lockTodoForWrite(run, todo, discard ? '停止并清理' : '停止', '停止没有执行')
    try {
      const project = db.getProject(userId, profile, todo.projectId)
      if (todo.buildSessionId) {
        if (todo.buildSessionId !== stoppedSessionId) await run.host.sessions.stop(todo.buildSessionId).catch(() => {})
        sessionActivity.delete(todo.buildSessionId)
      }
      if (todo.reviewSessionId) {
        if (todo.reviewSessionId !== stoppedSessionId) await run.host.sessions.stop(todo.reviewSessionId).catch(() => {})
        sessionActivity.delete(todo.reviewSessionId)
      }
      if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '停止')
      // No merge runs on this card (checked above, and none can start while this lock is held): what is left
      // in the table belongs to a merge that is gone.
      todoMergeActivity.delete(todo.id)
      const nextPhase = canTransition(todo.phase, 'CANCEL') ? transitionTodoPhase(todo.phase, 'CANCEL') : 'todo'
      if (discard && project && todo.worktreePath) {
        await removeWorktree({ repoPath: project.repoPath, worktreePath: todo.worktreePath, branchName: todo.branch, deleteBranch: true })
        // Removing a large worktree takes time. Taken over meanwhile: the card is not written (its
        // worktreePath / branch still name what is gone, which is what the line says).
        if (!stillOwnsWrite(todo.id, writeLock)) {
          return discardStaleWrite(run, userId, profile, todo.id, `停止并清理：工作树 ${todo.worktreePath}${todo.branch ? ` 与分支 ${todo.branch}` : ''} 已删除但未记入卡片`)
        }
      }
      db.updateTodo(userId, profile, todo.id, {
        phase: nextPhase,
        gateOwner: 'none',
        gateKind: 'none',
        buildRunId: '',
        reviewRunId: '',
        ...(discard ? { worktreePath: '', branch: '', diffs: [] } : {}),
        ...(reason ? { lastError: reason } : {}),
      })
      forgetStall(todo.id)
      if (reason) db.appendTimeline(userId, profile, todo.id, reason, 'system')
      else db.appendTimeline(userId, profile, todo.id, discard ? '已停止构建并清理工作树' : '已停止当前运行', 'user')
      // 0.9.49: what waited for the stopped turn is dropped now, with the reason on the card, instead of being
      // delivered (and starting the card again) when the host reports the stop. Nothing queued: no line.
      dropTodoQueue(run, userId, profile, todo.id, '任务已停止')
      // #104: a card somebody stopped back to `todo` is watched again by its next dispatch. A stop with a
      // `reason` (the platform's own) and a stopped review (the card stays at its gate) keep their watches.
      if (!reason && nextPhase === 'todo') db.clearWatchesForTodo(userId, profile, todo.id)
      emitUpdated(run, `todo.cancelled:${todo.id}`)
      await drainQueuedTodos(run, userId, profile).catch(() => {})
      return db.getTodo(userId, profile, todo.id)
    } finally {
      dropTodoWriteLock(todoId, writeLock)
    }
  }

  /**
   * A finished (done / closed) card no longer needs its checkout. Remove the plugin-owned worktree
   * when it holds nothing but committed work; the task branch is kept, so unmerged commits survive
   * and a restart recreates the worktree from that branch. A worktree with uncommitted or untracked
   * changes is left untouched. Never throws: cleanup must not block the phase change.
   * 0.9.49: `lock` is the caller's write lock (complete, close). The cleanup asks for it after each await: a
   * card taken over while git ran is neither cleaned nor written.
   */
  async function releaseCleanWorktree(run, userId, profile, todoId, lock) {
    try {
      const todo = db.getTodo(userId, profile, todoId)
      if (!todo?.worktreePath) return false
      const project = db.getProject(userId, profile, todo.projectId)
      if (!project?.repoPath) return false
      if (!(await isWorktreeClean(todo.worktreePath))) return false
      if (!stillOwnsWrite(todoId, lock)) {
        discardStaleWrite(run, userId, profile, todoId, '工作树清理未执行')
        return false
      }
      await removeWorktree({ repoPath: project.repoPath, worktreePath: todo.worktreePath, branchName: todo.branch, deleteBranch: false })
      if (existsSync(todo.worktreePath)) return false
      if (!stillOwnsWrite(todoId, lock)) {
        discardStaleWrite(run, userId, profile, todoId, `工作树清理：${todo.worktreePath} 已删除但未记入卡片，分支保留`)
        return false
      }
      db.updateTodo(userId, profile, todo.id, { worktreePath: '' })
      db.appendTimeline(userId, profile, todo.id, '已清理工作树（改动均已提交，分支保留）', 'orchestrator')
      return true
    } catch (err) {
      log?.warn?.('Worktree cleanup skipped', { todoId, error: err?.message || String(err) })
      return false
    }
  }

  // #104: watches a finished (done / closed) card still has when it is opened or dispatched again. Cards
  // finished before #104 kept them, and a re-dispatch woke those topics (also topics of other projects).
  function clearStaleWatches(userId, profile, todo) {
    if (todo.phase !== 'done' && todo.phase !== 'closed') return 0
    const stale = db.clearWatchesForTodo(userId, profile, todo.id)
    if (stale) db.appendTimeline(userId, profile, todo.id, `已清理 ${stale} 条旧订阅：卡片结束时留下的关注不再生效，之后只通知本卡所属话题`, 'orchestrator')
    return stale
  }

  // Kinds whose result is a change on a branch (a deploy card can carry one too).
  const CODE_KINDS = new Set(['feature', 'bug', 'deploy'])

  // #104: why a card may not be marked done right now; '' when it may. Read-only.
  //  - A card waiting for the user's answer or plan approval (`confirm`, or an active question) is not done.
  //  - A code card (feature / bug / deploy with a branch or a snapshot) at a gate (phase `review`: the
  //    review, merge, deploy and deliverable gates) is done only when nothing of it is left outside the
  //    default branch: the worktree is clean, and the snapshot, the branch tip and the worktree HEAD are
  //    ancestors of the default branch (the proof #102 asks of a merge). A text round on an untouched branch
  //    passes: its snapshot is the base commit. What cannot be read is treated as unmerged.
  //  - question / content cards, and cards in `todo` or `failed`, are not checked here.
  async function completeRefusal(userId, profile, todo) {
    if (todo.question?.active) return `#${todo.number} 正在等待用户答复提问，不能直接标记完成：请先答复，或先取消 / 关闭这张卡。本次标记完成没有执行。`
    if (todo.phase === 'confirm') return `#${todo.number} 的方案正在等待用户确认，不能直接标记完成：请先确认方案，或先取消 / 关闭这张卡。本次标记完成没有执行。`
    if (todo.phase !== 'review' || !CODE_KINDS.has(todo.kind)) return ''
    if (!todo.branch && !todo.snapshotSha) return ''
    const refuse = why => `#${todo.number} 有未合并改动，请走合并或先取消（${why}）。本次标记完成没有执行。`
    const project = db.getProject(userId, profile, todo.projectId)
    const base = project?.defaultBranch || 'main'
    if (!project?.repoPath) return refuse('读不到项目仓库，无法确认改动已在主干')
    let state
    try {
      state = await readReviewBinding({ repoPath: project.repoPath, worktreePath: todo.worktreePath, branchName: todo.branch })
    } catch (err) {
      return refuse(`读不到任务分支状态：${String(err?.message || err).replace(/\s+/g, ' ').slice(0, 120)}`)
    }
    if (state.dirtyCount > 0) return refuse(`工作树有 ${state.dirtyCount} 项未提交改动`)
    const shas = [...new Set([todo.snapshotSha, state.branchSha, state.headSha].map(sha => String(sha || '')).filter(Boolean))]
    for (const sha of shas) {
      if (!(await isCommitMergedInto(project.repoPath, sha, base))) return refuse(`提交 ${sha.slice(0, 12)} 不在 ${base} 中`)
    }
    return ''
  }

  // `caller`: 'user' (the page) or 'chief' (the tool complete_todo); it is the actor written on the timeline.
  async function completeTodo(run, { todoId, caller = 'user' }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    // 0.9.48: same guard as delete, and one write at a time per card. A refusal changes nothing on the card.
    if (todo.phase === 'merging' || mergingTodos.has(todo.id)) {
      throw new Error('任务正在合并，完成后再操作')
    }
    const byChief = caller === 'chief'
    const writeLock = lockTodoForWrite(run, todo, '标记完成', '标记完成没有执行')
    try {
      // #104: the gate check. Before, a card at the merge gate could be marked done without being merged.
      const refusal = await completeRefusal(userId, profile, todo)
      if (refusal) {
        log?.info?.('complete_todo refused', { todoId: todo.id, caller: byChief ? 'chief' : 'user', phase: todo.phase, gateKind: todo.gateKind })
        throw Object.assign(new Error(refusal), { completeRefused: true })
      }
      // The check awaited git: a card taken over meanwhile is not written.
      if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '标记完成')
      const nextPhase = transitionTodoPhase(todo.phase, 'COMPLETE')
      db.updateTodo(userId, profile, todo.id, { phase: nextPhase, gateOwner: 'none', gateKind: 'none' })
      db.appendTimeline(userId, profile, todo.id, byChief ? '总管标记完成' : '标记完成', byChief ? 'chief' : 'user')
      // #104: a finished card wakes nobody any more.
      db.clearWatchesForTodo(userId, profile, todo.id)
      await releaseCleanWorktree(run, userId, profile, todo.id, writeLock)
      emitUpdated(run, `todo.completed:${todo.id}`)
      return db.getTodo(userId, profile, todo.id)
    } finally {
      dropTodoWriteLock(todoId, writeLock)
    }
  }

  async function closeTodo(run, { todoId }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    // 0.9.49: same guard and lock as complete. `merging` never had a CLOSE exit; the refusal now says why.
    if (todo.phase === 'merging' || mergingTodos.has(todo.id)) {
      throw new Error('任务正在合并，完成后再操作')
    }
    // 0.9.49 (#46): `done` has no CLOSE exit (the work is merged or was marked done; closing is for a card
    // that is given up). The refusal says so instead of `Transition CLOSE is not allowed from phase "done"`.
    if (todo.phase === 'done') {
      throw new Error(`#${todo.number} 已完成（已合并或已标记完成），不需要关闭，本次关闭没有执行。需要再做请重新打开。`)
    }
    const writeLock = lockTodoForWrite(run, todo, '关闭', '关闭没有执行')
    try {
      const nextPhase = transitionTodoPhase(todo.phase, 'CLOSE')
      // A card closed mid-run must not leave its agent working (and spending) in the background.
      const wasRunning = todo.phase === 'building' || todo.phase === 'reviewing'
      if (wasRunning) {
        for (const sid of [todo.buildSessionId, todo.reviewSessionId]) {
          if (!sid) continue
          await run.host.sessions.stop(sid).catch(() => {})
          sessionActivity.delete(sid)
        }
        if (!stillOwnsWrite(todo.id, writeLock)) return discardStaleWrite(run, userId, profile, todo.id, '关闭')
      }
      db.updateTodo(userId, profile, todo.id, {
        phase: nextPhase,
        gateOwner: 'none',
        gateKind: 'none',
        ...(wasRunning ? { buildRunId: '', reviewRunId: '' } : {}),
      })
      db.appendTimeline(userId, profile, todo.id, '已关闭', 'user')
      // 0.9.49: a closed card takes no instruction any more: the queue is emptied at once, not at the next
      // reconcile. Before the cleanup below, which awaits git.
      dropTodoQueue(run, userId, profile, todo.id, '任务已结束')
      // #104: a closed card wakes nobody any more.
      db.clearWatchesForTodo(userId, profile, todo.id)
      await releaseCleanWorktree(run, userId, profile, todo.id, writeLock)
      emitUpdated(run, `todo.closed:${todo.id}`)
      if (wasRunning) await drainQueuedTodos(run, userId, profile).catch(() => {})
      return db.getTodo(userId, profile, todo.id)
    } finally {
      dropTodoWriteLock(todoId, writeLock)
    }
  }

  /**
   * User-initiated delete of a todo card. Stops any live build/review, removes the plugin-owned
   * worktree, deletes the task branch only when it is already merged (`git branch -d`, never -D),
   * and drops the card with its watches and schedules. Unmerged branches stay in the repo.
   */
  async function deleteTodo(run, { todoId }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    if (todoMergeActivity.has(todo.id) || todo.phase === 'merging') {
      throw new Error('任务正在合并，完成后再删除')
    }
    // 0.9.48: one write at a time per card: no delete while a build or review is being dispatched into it.
    const writeLock = lockTodoForWrite(run, todo, '删除', '删除没有执行')
    try {
      for (const sid of [todo.buildSessionId, todo.reviewSessionId]) {
        if (!sid) continue
        if (['building', 'reviewing', 'planning'].includes(todo.phase)) await run.host.sessions.stop(sid).catch(() => {})
        sessionActivity.delete(sid)
      }
      // 0.9.49: taken over while a session was being stopped: the card and its worktree are not removed.
      if (!stillOwnsWrite(todo.id, writeLock)) {
        discardStaleWrite(run, userId, profile, todo.id, '删除')
        return { branchKept: Boolean(todo.branch), branch: todo.branch || '', discarded: true }
      }
      const project = db.getProject(userId, profile, todo.projectId)
      let branchKept = false
      if (project?.repoPath) {
        if (todo.worktreePath) {
          await removeWorktree({ repoPath: project.repoPath, worktreePath: todo.worktreePath, branchName: todo.branch, deleteBranch: false }).catch(() => {})
        }
        if (todo.branch) {
          branchKept = !(await deleteMergedBranch(project.repoPath, todo.branch))
        }
      }
      if (!stillOwnsWrite(todo.id, writeLock)) {
        discardStaleWrite(run, userId, profile, todo.id, `删除：工作树 ${todo.worktreePath || '（无）'} 已移除但卡片未删除`)
        return { branchKept, branch: todo.branch || '', discarded: true }
      }
      db.deleteTodoCascade(userId, profile, todo.id)
      emitUpdated(run, `todo.deleted:${todo.id}`)
      await drainQueuedTodos(run, userId, profile).catch(() => {})
      return { branchKept, branch: todo.branch || '' }
    } finally {
      dropTodoWriteLock(todoId, writeLock)
    }
  }

  async function reopenTodo(run, { todoId }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    // 0.9.49: one write at a time per card.
    const writeLock = lockTodoForWrite(run, todo, '重新打开', '重新打开没有执行')
    try {
      const nextPhase = transitionTodoPhase(todo.phase, 'REOPEN')
      db.updateTodo(userId, profile, todo.id, { phase: nextPhase, gateOwner: 'none', gateKind: 'none', lastError: '' })
      db.appendTimeline(userId, profile, todo.id, '重新打开', 'user')
      // #104: `todo` is the card as it was (done / closed) before this write.
      clearStaleWatches(userId, profile, todo)
      emitUpdated(run, `todo.reopened:${todo.id}`)
      return db.getTodo(userId, profile, todo.id)
    } finally {
      dropTodoWriteLock(todoId, writeLock)
    }
  }

  async function refreshTodoDiff(run, { todoId }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const project = db.getProject(userId, profile, todo.projectId)
    if (!project || !todo.worktreePath) return todo
    const snap = await captureWorktreeSnapshot({
      repoPath: project.repoPath,
      worktreePath: todo.worktreePath,
      baseCommit: todo.baseCommit,
      baseBranch: project.defaultBranch,
      snapshotRefName: todo.id,
    })
    db.updateTodo(userId, profile, todo.id, {
      snapshotSha: snap.snapshotSha,
      diffs: snap.diffs,
      evidence: {
        commitSha: snap.snapshotSha,
        filesChanged: snap.filesChanged,
        additions: snap.additions,
        deletions: snap.deletions,
      },
    })
    emitUpdated(run, `todo.diff.refreshed:${todo.id}`)
    return db.getTodo(userId, profile, todo.id)
  }

  async function handleHostEvent(event, run) {
    const data = event?.data && typeof event.data === 'object' ? event.data : {}
    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
    const subject = event?.subject && typeof event.subject === 'object' ? event.subject : {}
    const sessionId = String(
      data.session_id
      || data.sessionId
      || data.subject?.session_id
      || subject.session_id
      || payload.session_id
      || '',
    )
    if (!sessionId) return
    const type = String(event?.type || '')
    // 0.9.70 (#85): a host event of a watched build / review session is activity of its card.
    // #91: except a pure status heartbeat (STALL_HEARTBEAT_EVENTS), which says nothing about the model.
    const watchedTodoId = stallSessions.get(sessionId)
    if (watchedTodoId && !isStallHeartbeat(type)) noteStallActivity(watchedTodoId, sessionId)
    const now = Date.now()

    if (type === 'chat.run.started' || type === 'chat.run.queued') {
      clearChiefLoopState(sessionId)
      chiefRunStartSeen.add(sessionId)
      if (chiefRunStartSeen.size > 400) chiefRunStartSeen.delete(chiefRunStartSeen.values().next().value)
      const prev = sessionActivity.get(sessionId)
      sessionActivity.set(sessionId, {
        running: true,
        startedAt: prev?.running ? prev.startedAt : now,
        updatedAt: now,
        activeTool: prev?.activeTool || '',
        toolCount: prev?.running ? prev.toolCount : 0,
        stage: type === 'chat.run.queued' ? 'queued' : 'thinking',
      })
      const matchedTopic = db.findTopicBySessionId(sessionId)
      if (matchedTopic) {
        if (type === 'chat.run.started') {
          noteChiefRunActive(sessionId, now, true)
          chiefToolCalls.delete(sessionId)
          openToolCalls.delete(sessionId)
        }
        db.updateTopic(matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId, { isRunning: true })
        emitUpdated(run, `chief.started:${matchedTopic.topicId}`)
        return
      }
      const matchedTodo = db.findTodoBySessionId(sessionId)
      if (matchedTodo) {
        emitActivityThrottled(run, sessionId, `todo.activity:${matchedTodo.todo.id}`, 350)
      }
      return
    }

    if (type === 'chat.tool.started' || type === 'chat.tool.completed' || type === 'chat.tool.failed') {
      // A run stopped for looping may still deliver a few tool events; they must not mark the topic running again.
      if (chiefLoopStopped.has(sessionId)) return
      const prev = sessionActivity.get(sessionId) || {
        running: true,
        startedAt: now,
        updatedAt: now,
        activeTool: '',
        toolCount: 0,
        stage: 'thinking',
      }
      const toolName = String(data.name || data.tool || data.toolName || payload.tool_name || payload.name || event?.summary?.tool_name || data.summary?.tool_name || '')
      if (type === 'chat.tool.started') {
        sessionActivity.set(sessionId, {
          ...prev,
          running: true,
          updatedAt: now,
          activeTool: toolName || 'tool',
          toolCount: (prev.toolCount || 0) + 1,
          stage: 'tool',
        })
      } else {
        sessionActivity.set(sessionId, {
          ...prev,
          running: true,
          updatedAt: now,
          activeTool: '',
          stage: 'thinking',
        })
      }
      // #97: recorded for every session, Chief or not (see resolveChiefCaller).
      if (type === 'chat.tool.started') { if (toolName) noteToolOpened(sessionId, toolName) } else noteToolClosed(sessionId, toolName)
      const matchedTopic = db.findTopicBySessionId(sessionId)
      if (matchedTopic) {
        // A run whose run.started was not delivered (or arrived before a plugin reload) is recorded here.
        noteChiefRunActive(sessionId, now, false)
        // Recorded before anything below can return: the create-todo call itself arrives right after this event.
        if (type === 'chat.tool.started') {
          if (toolName) noteChiefToolCall(sessionId, toolName)
        } else {
          const open = chiefToolCalls.get(sessionId)
          if (open && (!toolName || toolName === open.toolName)) chiefToolCalls.delete(sessionId)
        }
        if (!db.getTopic(matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId)?.isRunning) {
          db.updateTopic(matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId, { isRunning: true })
        }
        // Layer 3 Hard Runtime Governance Audit: warn immediately if Chief invokes code-mutating tools directly!
        if (type === 'chat.tool.started') {
          let pollArgs = JSON.stringify(data.arguments || data.args || payload.arguments || '')
          if (pollArgs.length <= 2 && isShellToolName(toolName)) {
            // Host lifecycle events only carry the tool name; read the latest tool call arguments from the transcript.
            pollArgs = await readLatestToolCallArgs(run, sessionId)
          }
          if (isChiefBusyPollCall(toolName, pollArgs)) {
            await handleChiefBusyPoll(run, matchedTopic, sessionId, prev.startedAt || now)
            return
          }
        }
        if (type === 'chat.tool.started') {
          const describeStreak = trackChiefToolForLoop(sessionId, toolName)
          if (await checkChiefLoop(run, matchedTopic, sessionId, describeStreak)) return
        }
        // Orchestration boundary: a write / execute / delegate call is flagged to the user (see notifyChiefGuard).
        if (type === 'chat.tool.started') {
          const settings = db.getSettings(matchedTopic.userId, matchedTopic.profile, config)
          if (settings.chiefStrictOrchestration !== false) {
            let rawArgs = ''
            if (baseToolName(toolName) === 'tool_call') {
              rawArgs = JSON.stringify(data.arguments || data.args || payload.arguments || '')
              if (rawArgs.length <= 2) rawArgs = await readLatestToolCallArgs(run, sessionId)
            }
            const tracker = chiefTurnTrackers.get(sessionId) || createChiefTurnTracker()
            chiefTurnTrackers.set(sessionId, tracker)
            if (chiefTurnTrackers.size > 200) chiefTurnTrackers.delete(chiefTurnTrackers.keys().next().value)
            const verdict = observeChiefTool(tracker, toolName, { rawArgs })
            if (verdict) notifyChiefGuard(run, matchedTopic, verdict)
          }
        }
        emitActivityThrottled(run, sessionId, `chief.tool:${matchedTopic.topicId}`, 450)
        return
      }
      const matchedTodo = db.findTodoBySessionId(sessionId)
      if (matchedTodo) {
        emitActivityThrottled(run, sessionId, `todo.tool:${matchedTodo.todo.id}`, 450)
      }
      return
    }

    if (type === 'chat.message.created') {
      const matchedTopic = db.findTopicBySessionId(sessionId)
      if (matchedTopic) {
        const added = await syncChiefTranscript(run, matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId, false)
        if (added) emitActivityThrottled(run, `msg:${sessionId}`, `chief.msg:${matchedTopic.topicId}`, 300)
        if (!chiefLoopStopped.has(sessionId) && sessionActivity.get(sessionId)?.running) {
          await checkChiefLoop(run, matchedTopic, sessionId, chiefDescribeStreak.get(sessionId) || 0)
        }
      }
      return
    }

    if (type === 'chat.usage.updated' || type === 'chat.run.usage.updated') {
      const u = data.usage || payload.usage || data.run_usage || data
      const inp = Number(u?.inputTokens ?? u?.input_tokens ?? 0) || 0
      const out = Number(u?.outputTokens ?? u?.output_tokens ?? 0) || 0
      if (inp + out > 0) {
        const matchedTopic = db.findTopicBySessionId(sessionId)
        const matchedTodo = matchedTopic ? null : db.findTodoBySessionId(sessionId)
        const scope = matchedTopic || matchedTodo
        if (scope) {
          sessionActivity.set(`usage:${sessionId}`, {
            userId: scope.userId,
            profile: scope.profile,
            model: String(u?.model || data?.model || payload?.model || ''),
            inputTokens: inp,
            outputTokens: out,
            cacheReadTokens: Number(u?.cacheReadTokens ?? u?.cache_read_tokens ?? 0) || 0,
            cacheWriteTokens: Number(u?.cacheWriteTokens ?? u?.cache_write_tokens ?? 0) || 0,
            reasoningTokens: Number(u?.reasoningTokens ?? u?.reasoning_tokens ?? 0) || 0,
            costUsd: Number(u?.costUsd ?? u?.cost_usd ?? 0) || 0,
          })
        }
      }
      return
    }

    if (type === 'chat.run.completed' || type === 'chat.run.failed' || type === 'chat.run.stopped') {
      activeChiefRuns.delete(sessionId)
      chiefToolCalls.delete(sessionId)
      openToolCalls.delete(sessionId)
      sessionActivity.delete(sessionId)
      clearChiefLoopState(sessionId)
      const pendingUsage = sessionActivity.get(`usage:${sessionId}`)
      if (pendingUsage) {
        sessionActivity.delete(`usage:${sessionId}`)
        try {
          db.recordUsage(pendingUsage.userId, pendingUsage.profile, { ...pendingUsage, sessionId })
        } catch {}
      } else {
        const u = data.usage || payload.usage || data.run_usage || null
        if (u && (Number(u.inputTokens ?? u.input_tokens ?? 0) + Number(u.outputTokens ?? u.output_tokens ?? 0) > 0)) {
          const scope = db.findTopicBySessionId(sessionId) || db.findTodoBySessionId(sessionId)
          if (scope) {
            try {
              db.recordUsage(scope.userId, scope.profile, {
                sessionId,
                model: String(u.model || data.model || payload.model || ''),
                inputTokens: Number(u.inputTokens ?? u.input_tokens ?? 0) || 0,
                outputTokens: Number(u.outputTokens ?? u.output_tokens ?? 0) || 0,
                cacheReadTokens: Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0) || 0,
                cacheWriteTokens: Number(u.cacheWriteTokens ?? u.cache_write_tokens ?? 0) || 0,
                reasoningTokens: Number(u.reasoningTokens ?? u.reasoning_tokens ?? 0) || 0,
                costUsd: Number(u.costUsd ?? u.cost_usd ?? 0) || 0,
              })
            } catch {}
          }
        }
      }
      const outcome = type === 'chat.run.failed' ? 'failed' : 'completed'
      const errorText = hostErrorText(data.error) || hostErrorText(data.message) || hostErrorText(payload.error)
      // 0.9.46: the other fields of a failed run event, kept for a card whose event carries no error text.
      const failureHint = outcome === 'failed'
        ? ['code', 'stop_reason'].map(k => (hostErrorText(data[k] ?? payload[k]) ? `${k}=${hostErrorText(data[k] ?? payload[k]).slice(0, 80)}` : '')).filter(Boolean).join(' ')
        : ''
      const interrupted = outcome === 'failed' && (data.interrupted === true || payload.interrupted === true)

      const matchedTopic = db.findTopicBySessionId(sessionId)
      if (matchedTopic) {
        if (outcome === 'failed') {
          await handleChiefFailureWithFailover(run, matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId, errorText)
        } else {
          await syncChiefTranscript(run, matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId, true)
          requestChiefSettle(matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId)
          await auditChiefRepoMutation(run, matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId)
          if (type === 'chat.run.completed' && await noticeEkkoToolsMissing(run, matchedTopic, sessionId)) {
            // The specific notice replaces the generic empty-reply one; resuming would hit the same wall.
          } else if (type === 'chat.run.completed') {
            // #105: every completed round is classified and counted first (an empty reply after read-only
            // probing is an idle round too); the breaker suppresses the automatic resume.
            const idle = await settleChiefIdleRound(run, matchedTopic, sessionId)
            if (await chiefTurnEndedWithoutReply(run, sessionId)) {
              const model = String(data.model || payload.model || '')
              const msg = `${CHIEF_EMPTY_REPLY_PREFIX}${model ? `（${model}）` : ''}，本轮没有结论。可发「继续」重试，或在设置里换总管模型。`
              db.addTopicMessage(matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId, { kind: 'system', text: msg, progressNotice: msg })
            } else if (!idle.broken) {
              await resumeAnnounceOnlyChiefTurn(run, matchedTopic, sessionId, idle.verdict)
            }
          }
          emitUpdated(run, `chief.settled:${matchedTopic.topicId}`)
        }
        // Strictly serialized queue: immediately drain the next waiting follow-up / wake once turn ends!
        if (type !== 'chat.run.stopped') {
          await drainTopicQueue(run, matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId)
        }
        return
      }

      const matchedTodo = db.findTodoBySessionId(sessionId)
      if (matchedTodo) {
        await settleWorkerRun(run, matchedTodo.userId, matchedTodo.profile, matchedTodo.todo.id, {
          sessionId,
          outcome,
          errorText,
          failureHint,
          interrupted,
          // 0.9.47: a stopped run settles as completed, but must never be rerun as an idle round.
          stopped: type === 'chat.run.stopped',
        })
      }
    }
  }

  async function syncLiveWorkerChat(run, userId, profile, todo, sessionId) {
    try {
      const res = await run.host.sessions.messages(sessionId, { limit: 20 }).catch(() => null)
      if (!res) return false
      const hostMsgs = normalizeHostMessages(res).filter(m => m.role === 'assistant' && m.content.trim())
      if (!hostMsgs.length) return false
      const latest = hostMsgs[hostMsgs.length - 1]
      const preview = latest.content.trim().slice(0, 1400)
      const prevChat = todo.buildChat || []
      const lastEntry = prevChat[prevChat.length - 1]
      if (lastEntry && lastEntry.hostId === latest.id && lastEntry.text === preview) return false
      const label = todo.phase === 'reviewing' ? '独立审查(实时)' : '执行进度'
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const nextChat = lastEntry?.hostId === latest.id
        ? [...prevChat.slice(0, -1), { ...lastEntry, text: preview, time: timeStr }]
        : [...prevChat.slice(-24), { role: label, time: timeStr, text: preview, hostId: latest.id }]
      db.updateTodo(userId, profile, todo.id, { buildChat: nextChat })
      return true
    } catch {
      return false
    }
  }

  // 0.9.42: cards whose queued instructions were not drained by a host event (an event lost, or the card left
  // `building` while its session was still running): deliver when the build session is idle, drop with a note
  // when the card is finished or the oldest item waited longer than TODO_QUEUE_STALE_MS.
  async function reconcileTodoQueues(run) {
    let n = 0
    for (const item of db.listTodosWithQueue()) {
      if (item.profile !== run.identity.profile) continue
      const todo = db.getTodo(item.userId, item.profile, item.todoId)
      if (!todo || TODO_QUEUE_HOLD_PHASES.has(todo.phase) || settlingTodos.has(todo.id) || startingTodos.has(todo.id)) continue
      // #107: a card that waits for a build slot keeps its instructions until it is started (drainQueuedTodos).
      if (todo.phase === 'queued') continue
      if (TODO_QUEUE_DROP_PHASES.has(todo.phase) || !todo.buildSessionId) {
        n += dropTodoQueue(run, item.userId, item.profile, todo.id, TODO_QUEUE_DROP_PHASES.has(todo.phase) ? '任务已结束' : '没有执行者会话')
        continue
      }
      const probe = await probeSessionWorking(run, todo.buildSessionId, { timeoutMs: 1200 }).catch(() => null)
      if (!probe?.known) continue
      if (!probe.isWorking && !Number(probe.queueLength || 0)) {
        await settleWorkerRun(run, item.userId, item.profile, todo.id, { sessionId: todo.buildSessionId, outcome: 'completed' })
        n += 1
      } else if (Date.now() - Number(item.oldest || 0) > TODO_QUEUE_STALE_MS) {
        n += dropTodoQueue(run, item.userId, item.profile, todo.id, `执行者会话超过 ${Math.round(TODO_QUEUE_STALE_MS / 60000)} 分钟仍在运行`)
      }
    }
    return n
  }

  // 0.9.49 (#46): is a review dispatch of this process still inside its launch call for this card? True while
  // its entry is in reviewLaunches and its write lock is still the card's lock and not expired.
  function reviewLaunchInFlight(todoId) {
    const launch = reviewLaunches.get(todoId)
    return Boolean(launch) && stillOwnsWrite(todoId, launch.lock)
      && clock() - Number(launch.lock.acquiredAt || 0) < TODO_WRITE_LOCK_TTL_MS
  }

  // A `reviewing` card without a review run that was not written for this long is taken as left behind.
  const REVIEW_UNLAUNCHED_HEAL_MS = 2 * 60 * 1000
  // 0.9.49 (#46): todoId -> { since: clock() of the first probe in a row that could not tell the state of the
  // review session of a `reviewing` card without a run, updatedAt: the card's updatedAt then }. Cleared by a
  // probe that knows the state or when the card is no longer such a card; a card written since (updatedAt
  // differs) starts the count again. In memory only: after a restart the count starts again.
  const reviewUnknownSince = new Map()

  /**
   * 0.9.49 (#46): a card that is `reviewing` with an empty `reviewRunId` and an idle review session, with no
   * launch of this process in flight: the process ended between the write of `reviewing` and the launch, or a
   * launch hung past the lock TTL. No review of this round is known to have run, so no verdict is written:
   * the card goes back to the merge gate with `reviewVerdict: none` and can be reviewed again. The review
   * session is kept (the next dispatch reuses it). Takes the write lock like any other write (an expired
   * holder is taken over and then drops its result); refused while another write holds the card or a settle
   * is running. The caller has probed the review session as known and not working, or as unknown in every
   * probe for REVIEW_UNLAUNCHED_HEAL_MS. Returns true when the card was written.
   */
  function healUnlaunchedReview(run, userId, profile, todoId) {
    if (settlingTodos.has(todoId)) return false
    const seen = db.getTodo(userId, profile, todoId)
    if (!seen || seen.phase !== 'reviewing' || seen.reviewRunId) return false
    // Measured on the injected clock, like the write lock and the reconcile (tests move it on its own).
    if (clock() - Number(seen.updatedAt || 0) < REVIEW_UNLAUNCHED_HEAL_MS) return false
    let writeLock
    try {
      writeLock = lockTodoForWrite(run, seen, '审查恢复', '审查恢复没有执行')
    } catch {
      return false
    }
    try {
      writeReviewBackToGate(run, userId, profile, seen, {
        note: '上次派发审查时服务中断或启动一直没有返回，卡片上没有这一轮审查的运行记录，已回到待合并关口，可重新派发审查。',
        line: '检测到未启动的审查（没有运行记录），已自动回到待合并关口，审查结论清空',
      })
      emitUpdated(run, `todo.review.unlaunched_healed:${todoId}`)
      return true
    } finally {
      dropTodoWriteLock(todoId, writeLock)
    }
  }

  /**
   * The one write that puts a `reviewing` card back to the merge gate with no verdict (healUnlaunchedReview,
   * 0.9.49 #46; healStalledReview, 0.9.70 #85). `reviewVerdict` goes to `none`: no review of this round gave a
   * verdict, so none is written. The caller holds the card's write lock. `clearRun` also empties reviewRunId
   * (a stalled review had a run on the card).
   */
  function writeReviewBackToGate(run, userId, profile, seen, { note, line, clearRun = false, event = 'unlaunched_healed' }) {
    const todoId = seen.id
    const topic = seen.topicId ? db.getTopic(userId, profile, seen.topicId) : null
    const project = db.getProject(userId, profile, seen.projectId)
    db.updateTodo(userId, profile, todoId, {
      phase: transitionTodoPhase('reviewing', 'CANCEL'),
      // The one rule for who holds the merge gate (#44). The test gate counts as failed like in the build
      // settle: only when the project has a test command and testRc is not 0. The Chief is not woken here,
      // so a card the Chief may not merge must not read `chief`.
      gateOwner: mergeGateNeedsHuman({
        todo: seen,
        topic,
        project,
        testFailed: Boolean(project?.testCommand) && Number(seen.evidence?.testRc ?? -1) !== 0,
        gateSkipped: seen.evidence?.gateSkipped,
        openQuestion: seen.question?.active,
      }) ? 'human' : 'chief',
      gateKind: seen.kind === 'deploy' ? 'deploy' : 'merge',
      // The review text of the round before goes with its verdict: no `none` next to an old verdict text.
      // #103: so does the commit that round was bound to (no review of it gave a verdict).
      reviewedSha: '',
      evidence: { reviewVerdict: 'none', reviewSummary: '', reviewDrift: '' },
      ...(clearRun ? { reviewRunId: '' } : {}),
      lastError: note,
    })
    db.appendTimeline(userId, profile, todoId, line, 'system')
    sessionActivity.delete(seen.reviewSessionId)
    forgetStall(todoId)
    emitUpdated(run, `todo.review.${event}:${todoId}`)
  }

  /* ---------- 0.9.70 (#85): stall watchdog for building / reviewing cards ---------- */
  //
  // The host does not always report the end of a run (#83: the model request hung, no event came for 50+
  // minutes, the probe kept answering "working"). Before, such a card stayed `building` forever: reconcile only
  // settles a session the probe reports idle, and skips one it cannot tell. The watchdog measures the silence of
  // each building / reviewing card on the injected clock and acts in two steps:
  //   soft (buildStallWarnMs, default 10 min): one timeline line + `stall.suspicious` in the snapshot. Nothing
  //     is stopped (a long tool may be running).
  //   hard (buildStallHealMs, default 30 min; 2x that while a tool is open; or the probe unknown for 3 minutes
  //     in a row with no event in those 3 minutes and no tool open): probed once more, then a building card is
  //     stopped with cancelBuild(discard:false) (back to `todo`, worktree and branch kept), a reviewing card
  //     goes back to the merge gate with no verdict. At most one card per reconcile pass.
  //   #91: and only when the old executor is known to be gone: the session is stopped first and the host must
  //     confirm it within 5 s (otherwise one timeline line 「宿主未确认已停止，保留运行状态」 and nothing
  //     moves); and at most one automatic stop per buildStallCooldownMs (default 5 min) over all cards.
  // Activity: a host event of the card's session other than a status heartbeat (STALL_HEARTBEAT_EVENTS), a
  // card write (timeline, phase, live chat: updatedAt changed), a settle / test gate / dispatch of the card in
  // this process. In memory only: after a restart / plugin reload the silence (and the cooldown) is counted
  // again from the first pass that sees the card. `planning` cards are not watched.
  const STALL_UNKNOWN_HEAL_MS = 3 * 60 * 1000
  const STALL_TOOL_HEAL_FACTOR = 2
  const STALL_DEFAULTS = Object.freeze({ warnMs: 600000, healMs: 1800000, cooldownMs: 300000 })
  // 0.9.70 (#91): host events that are not activity. They carry a state, not progress of the model: the host
  // sends `status.update` while it retries / falls back (#81: a hung model request is retried on a 900 s
  // cycle, so each retry line would push the silence back and the hard threshold would never be reached),
  // `thinking.delta` is the host's own "thinking…" placeholder (the model's text comes as `reasoning.delta`),
  // `transport.*` is the connection of the relay. Matched with or without the `chat.` / `group.` prefix.
  // Everything else (reasoning / message deltas, message.interim, tool.started / completed, run.*) is activity.
  const STALL_HEARTBEAT_EVENTS = new Set(['status.update', 'thinking.delta', 'transport.connected', 'transport.disconnected'])
  const isStallHeartbeat = type => {
    const bare = String(type || '').replace(/^(chat|group)\./, '')
    return STALL_HEARTBEAT_EVENTS.has(bare) || bare.startsWith('transport.')
  }
  // 0.9.70 (#91): clock() of the last automatic stop (any card, any profile). A host outage makes every card
  // look stuck at once; the cooldown (buildStallCooldownMs) lets at most one card go back per window.
  let lastAutoHealAt = 0
  // 0.9.70 (#91 review): true while one watchdog heal (confirmation probe, stop, write) is running, in any pass.
  let autoHealInFlight = false
  // todoId -> { sessionId, phase, lastActivityAt, seenUpdatedAt, unknownSince, suspicious, warnedAt,
  //   stopFailedAt, stopRetryAt, stopFailNoted }
  const buildActivity = new Map()
  // sessionId -> todoId of the sessions watched above (a host event refreshes its card without a DB read).
  const stallSessions = new Map()

  function clampStallMs(v, min, max, dflt) {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : dflt
  }

  /** The watchdog settings in effect. The hard threshold is at least one minute above the soft one. */
  function stallSettings(settings) {
    const warnMs = clampStallMs(settings?.buildStallWarnMs, 60000, 14400000, STALL_DEFAULTS.warnMs)
    const healMs = Math.max(clampStallMs(settings?.buildStallHealMs, 300000, 43200000, STALL_DEFAULTS.healMs), warnMs + 60000)
    const cooldownMs = clampStallMs(settings?.buildStallCooldownMs, 60000, 3600000, STALL_DEFAULTS.cooldownMs)
    return { enabled: settings?.buildStallWatchdog !== false, warnMs, healMs, cooldownMs }
  }

  /**
   * 0.9.70 (#91): stops a stalled session and says whether the host confirmed it. A throw, an `ok: false`
   * answer or no answer within stallStopTimeoutMs (5 s) is "not confirmed": the old executor may still be
   * running in the worktree, so the card must not go back (a new dispatch would race it).
   */
  async function stopStalledSession(run, sid) {
    let timer = null
    try {
      const res = await Promise.race([
        Promise.resolve().then(() => run.host.sessions.stop(sid)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${Math.max(1, Math.round(stallStopTimeoutMs / 1000))} 秒内没有答复`)), stallStopTimeoutMs)
        }),
      ])
      if (res && typeof res === 'object' && res.ok === false) {
        return { ok: false, error: String(res.error || res.message || '宿主答复 ok:false').slice(0, 160) }
      }
      return { ok: true, error: '' }
    } catch (err) {
      return { ok: false, error: String(err?.message || err || '停止失败').slice(0, 160) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function forgetStall(todoId) {
    const e = buildActivity.get(todoId)
    if (!e) return
    if (stallSessions.get(e.sessionId) === todoId) stallSessions.delete(e.sessionId)
    buildActivity.delete(todoId)
  }

  function noteStallActivity(todoId, sessionId) {
    const e = buildActivity.get(todoId)
    if (e && (!sessionId || e.sessionId === sessionId)) e.lastActivityAt = clock()
  }

  /** Read-only view for the snapshot: null when the card is not watched. */
  function stallView(todoId) {
    const e = buildActivity.get(todoId)
    if (!e) return null
    return { silentMs: Math.max(0, clock() - e.lastActivityAt), suspicious: Boolean(e.suspicious), since: e.lastActivityAt }
  }

  function stallEntryFor(todo, sid) {
    let e = buildActivity.get(todo.id)
    if (!e || e.sessionId !== sid || e.phase !== todo.phase) {
      if (e && stallSessions.get(e.sessionId) === todo.id) stallSessions.delete(e.sessionId)
      e = { sessionId: sid, phase: todo.phase, lastActivityAt: clock(), seenUpdatedAt: todo.updatedAt, unknownSince: 0, suspicious: false, warnedAt: 0 }
      buildActivity.set(todo.id, e)
      stallSessions.set(sid, todo.id)
    }
    return e
  }

  function stallBusyHere(todoId) {
    if (settlingTodos.has(todoId) || startingTodos.has(todoId) || reviewLaunches.has(todoId)) return true
    const held = todoWriteLocks.get(todoId)
    return Boolean(held) && clock() - Number(held.acquiredAt || 0) < TODO_WRITE_LOCK_TTL_MS
  }

  const stallMinutes = ms => Math.max(1, Math.round(ms / 60000))

  /**
   * One watchdog step for a building / reviewing card whose session the probe reported working or could not
   * tell. `budget.healed` counts the cards stopped in this reconcile pass (at most one). Returns true when the
   * card was written (soft line or heal).
   */
  async function watchStalledRun(run, ownerId, profile, todo, sid, probe, budget) {
    if (todo.phase !== 'building' && todo.phase !== 'reviewing') return false
    const cfg = stallSettings(db.getSettings(ownerId, profile, config))
    if (!cfg.enabled) {
      forgetStall(todo.id)
      return false
    }
    const e = stallEntryFor(todo, sid)
    e.profile = profile
    const now = clock()
    if (todo.updatedAt !== e.seenUpdatedAt) {
      e.seenUpdatedAt = todo.updatedAt
      e.lastActivityAt = now
    }
    // A settle (with its test gate), a dispatch or another write of this card in this process is activity.
    if (stallBusyHere(todo.id)) e.lastActivityAt = now
    if (probe?.known) e.unknownSince = 0
    else if (!e.unknownSince) e.unknownSince = now
    const silentMs = Math.max(0, now - e.lastActivityAt)
    if (silentMs < cfg.warnMs) {
      e.suspicious = false
      e.warnedAt = 0
    }
    // #91: activity after an unconfirmed stop ends that episode (a new stall may try and note again).
    if (e.stopFailedAt && e.lastActivityAt > e.stopFailedAt) {
      e.stopFailedAt = 0
      e.stopRetryAt = 0
      e.stopFailNoted = false
    }
    const act = sessionActivity.get(sid)
    const toolOpen = Boolean(act?.running && act?.activeTool)
    let wrote = false
    if (silentMs >= cfg.warnMs && !e.suspicious) {
      e.suspicious = true
      e.warnedAt = now
      db.appendTimeline(ownerId, profile, todo.id,
        `检测到该卡已 ${stallMinutes(silentMs)} 分钟没有任何事件，疑似卡住（未打断运行${toolOpen ? `，工具「${String(act.activeTool).slice(0, 60)}」仍未返回` : ''}）`, 'system')
      // The line just written is not activity.
      e.seenUpdatedAt = db.getTodo(ownerId, profile, todo.id)?.updatedAt ?? e.seenUpdatedAt
      emitUpdated(run, `todo.stall.suspected:${todo.id}`)
      wrote = true
    }
    const hardMs = toolOpen ? cfg.healMs * STALL_TOOL_HEAL_FACTOR : cfg.healMs
    const silentStall = silentMs >= hardMs
    const unknownStall = !probe?.known && e.unknownSince > 0 && now - e.unknownSince >= STALL_UNKNOWN_HEAL_MS
      && silentMs >= STALL_UNKNOWN_HEAL_MS && !toolOpen
    if (!silentStall && !unknownStall) return wrote
    if (budget.healed >= 1) return wrote
    // #91: at most one automatic stop per cooldown window over all cards (a host outage or reload makes every
    // card unknown and silent at once; one per pass would return them all within seconds).
    if (lastAutoHealAt && now - lastAutoHealAt < cfg.cooldownMs) return wrote
    // #91: the host did not confirm the last stop of this card: not asked again before the retry time.
    if (e.stopRetryAt && now < e.stopRetryAt) return wrote
    // #91 (review): at most one automatic stop attempt per pass, confirmed or not. Counting only confirmed stops
    // let an outage stop every card of the pass (a host that queues the requests may run them all once it is
    // back, stopping sessions that were fine) and made one pass last N x (probe 1.2 s + stop 5 s).
    if (budget.stopAttempts >= 1) return wrote
    // #91 (review): one automatic heal at a time over all reconcile passes. Passes can overlap (the scheduler
    // and the `reconcile` action); `lastAutoHealAt` is written only after the probe, the stop and the write, so
    // a second pass would see the cooldown free and stop another card. Taken synchronously, before any await,
    // and released in `finally` on every path.
    if (autoHealInFlight) return wrote
    autoHealInFlight = true
    try {
      // Ask once more before stopping anything.
      const again = await probeSessionWorking(run, sid, { timeoutMs: 1200 }).catch(() => null)
      const fresh = db.getTodo(ownerId, profile, todo.id)
      const freshSid = fresh?.phase === 'reviewing' ? fresh.reviewSessionId : fresh?.buildSessionId
      if (!fresh || fresh.phase !== todo.phase || freshSid !== sid || fresh.updatedAt !== e.seenUpdatedAt || stallBusyHere(todo.id)) return wrote
      // Activity since the first look (an event while the confirmation probe asked): nothing is stopped. The
      // silence path needs no activity inside the soft window, the unknown path none inside its 3 minutes.
      const silentAfter = Math.max(0, clock() - e.lastActivityAt)
      if (silentAfter < (silentStall ? cfg.warnMs : STALL_UNKNOWN_HEAL_MS)) return wrote
      // Now idle: the normal settle of the next pass takes it (a finished run is settled, not stopped).
      if (again?.known && !again.isWorking) return wrote
      // The probe that was unknown now answers: only the silence threshold may stop the card.
      if (again?.known && !silentStall) return wrote
      const why = silentStall
        ? `已 ${stallMinutes(silentAfter)} 分钟无事件`
        : `宿主连续 ${stallMinutes(clock() - e.unknownSince)} 分钟答不出会话状态，期间没有任何事件`
      // #91: the card goes back only when the old executor is known to be gone. The confirmation probe saying
      // "idle" is handled above (the next pass settles it normally); otherwise the host must confirm the stop.
      // Not confirmed (throw / ok:false / no answer in 5 s) = unknown: the card stays where it is, one timeline
      // line per stall, the stop is tried again after the cooldown.
      budget.stopAttempts += 1
      const stopped = await stopStalledSession(run, sid)
      if (!stopped.ok) {
        e.stopFailedAt = clock()
        e.stopRetryAt = e.stopFailedAt + cfg.cooldownMs
        log?.warn?.(`Stall watchdog kept #${fresh.number}: the host did not confirm the stop (${stopped.error})`, { todoId: todo.id, sessionId: sid })
        if (e.stopFailNoted) return wrote
        e.stopFailNoted = true
        db.appendTimeline(ownerId, profile, todo.id,
          `宿主未确认已停止，保留运行状态：看门狗没有退回该卡（${why}；停止请求${stopped.error ? `：${stopped.error}` : '没有成功'}），${stallMinutes(cfg.cooldownMs)} 分钟后再试`, 'system')
        e.seenUpdatedAt = db.getTodo(ownerId, profile, todo.id)?.updatedAt ?? e.seenUpdatedAt
        emitUpdated(run, `todo.stall.stop_unconfirmed:${todo.id}`)
        return true
      }
      try {
        if (fresh.phase === 'building') {
          const reason = `疑似卡住（${why}），已退回待派发；工作树与分支保留，可直接重新派发续跑`
          const owner = Object.create(run, { identity: { value: { ...run.identity, userId: ownerId, profile } } })
          await cancelBuild(owner, { todoId: todo.id, discard: false }, { reason, stoppedSessionId: sid })
          budget.healed += 1
          lastAutoHealAt = clock()
          log?.warn?.(`Stall watchdog stopped #${fresh.number}: ${why}`, { todoId: todo.id, sessionId: sid })
          return true
        }
        const healed = await healStalledReview(run, ownerId, profile, todo.id, sid, why)
        if (healed) {
          budget.healed += 1
          lastAutoHealAt = clock()
          log?.warn?.(`Stall watchdog returned review #${fresh.number} to the merge gate: ${why}`, { todoId: todo.id, sessionId: sid })
        }
        return healed || wrote
      } catch (err) {
        log?.warn?.(`Stall watchdog could not stop #${fresh.number}: ${String(err?.message || err).slice(0, 200)}`, { todoId: todo.id })
        return wrote
      }
    } finally {
      autoHealInFlight = false
    }
  }

  /**
   * 0.9.70 (#85): a `reviewing` card whose review run went silent: the review session is stopped and the card
   * goes back to the merge gate like healUnlaunchedReview (no verdict written, reviewVerdict `none`). Takes the
   * write lock; a settle that ends meanwhile is superseded by it.
   */
  async function healStalledReview(run, userId, profile, todoId, sid, why) {
    if (settlingTodos.has(todoId) || reviewLaunchInFlight(todoId)) return false
    const seen = db.getTodo(userId, profile, todoId)
    if (!seen || seen.phase !== 'reviewing' || seen.reviewSessionId !== sid) return false
    let writeLock
    try {
      writeLock = lockTodoForWrite(run, seen, '审查卡住恢复', '审查卡住恢复没有执行')
    } catch {
      return false
    }
    try {
      // #91: the caller (watchStalledRun) already stopped the session and the host confirmed it.
      if (!stillOwnsWrite(todoId, writeLock) || settlingTodos.has(todoId)) return false
      const cur = db.getTodo(userId, profile, todoId)
      if (!cur || cur.phase !== 'reviewing' || cur.reviewSessionId !== sid) return false
      writeReviewBackToGate(run, userId, profile, cur, {
        note: `审查疑似卡住（${why}），已停止该审查并回到待合并关口，没有写入任何审查结论；可重新派发审查。`,
        line: `审查疑似卡住（${why}），已自动回到待合并关口，审查结论清空`,
        clearRun: true,
        event: 'stall_healed',
      })
      return true
    } finally {
      dropTodoWriteLock(todoId, writeLock)
    }
  }

  // #105: a card at a gate owned by the Chief (phase review / confirm, gateOwner chief) for longer than
  // settings.chiefGateStaleMs (default 20 min, 0 = off) gets one timeline line and one topic message. The wait is
  // measured from the card's updatedAt (any write to the card restarts it); the reminder is written once per
  // gate, keyed by phase:gateKind:snapshotSha in evidence.chiefGateRemindedKey, so a new gate can be reminded
  // again but the same one never is. The Chief is not woken and nothing is queued: a reminder, not a nudge.
  function remindStaleChiefGates(run) {
    const { userId, profile } = run.identity
    const staleMs = db.getSettings(userId, profile, config).chiefGateStaleMs
    if (!staleMs) return 0
    let reminded = 0
    for (const row of db.listChiefGateTodos()) {
      if (row.user_id !== userId || row.profile !== profile) continue
      const waited = clock() - Number(row.updated_at || 0)
      if (waited < staleMs) continue
      const todo = db.getTodo(userId, profile, row.id)
      if (!todo || todo.gateOwner !== 'chief' || !['review', 'confirm'].includes(todo.phase)) continue
      const key = `${todo.phase}:${todo.gateKind}:${todo.snapshotSha || ''}`
      if (todo.evidence?.chiefGateRemindedKey === key) continue
      const minutes = Math.max(1, Math.round(waited / 60000))
      const msg = `关口提醒：#${todo.number}「${todo.title}」在总管关口（${todo.phase}/${todo.gateKind}）已停留约 ${minutes} 分钟，没有被处理。请总管或人工决定下一步（合并 / 退回 / 验收 / 确认方案）；本提醒只写一次。`
      db.updateTodo(userId, profile, todo.id, { evidence: { chiefGateRemindedKey: key } })
      db.appendTimeline(userId, profile, todo.id, msg, 'orchestrator')
      const topic = todo.topicId ? db.getTopic(userId, profile, todo.topicId) : null
      if (topic && !topic.archived) db.addTopicMessage(userId, profile, topic.id, { kind: 'system', text: msg, progressNotice: msg, todoId: todo.id })
      try { log?.warn?.('Card waiting at a Chief gate; reminded once', { todoId: todo.id, minutes }) } catch {}
      reminded += 1
    }
    return reminded
  }

  async function reconcileActiveRuns(run) {
    const {
      activeTodos,
      mergingTodosRows = [],
      activeTopics,
      recentTopics = [],
      topicsWithQueue = [],
    } = db.listActiveRuntimeItems()
    let syncedCount = 0
    const checkedTopicIds = new Set()

    // Check active topics, recent topics (catches Web-UI-started runs), and any topic holding queued follow-ups!
    const candidateTopics = [...activeTopics]
    for (const rt of [...recentTopics, ...topicsWithQueue]) {
      if (!candidateTopics.some(t => t.id === rt.id)) candidateTopics.push(rt)
    }

    for (const tp of candidateTopics) {
      if (tp.profile !== run.identity.profile) continue
      if (checkedTopicIds.has(tp.id)) continue
      checkedTopicIds.add(tp.id)
      const topic = db.getTopic(tp.user_id, tp.profile, tp.id)
      if (!topic) continue

      if (!topic.chiefSessionId) {
        if (!topic.isRunning) {
          const drained = await drainTopicQueue(run, tp.user_id, tp.profile, tp.id)
          if (drained) syncedCount += 1
        }
        continue
      }

      const probe = await probeSessionWorking(run, topic.chiefSessionId, { timeoutMs: 1200 })
      if (!probe.known) {
        // Working state unknown: leave the running flag alone, but still copy new messages.
        const added = await syncChiefTranscript(run, tp.user_id, tp.profile, tp.id, false)
        if (added) syncedCount += 1
        continue
      }

      if (probe.isWorking) {
        const curAct = sessionActivity.get(topic.chiefSessionId)
        sessionActivity.set(topic.chiefSessionId, {
          running: true,
          startedAt: curAct?.startedAt || probe.runStartedAt || Date.now(),
          updatedAt: Date.now(),
          activeTool: curAct?.activeTool || '',
          toolCount: curAct?.toolCount || 0,
          stage: curAct?.stage || 'running',
        })
        if (!topic.isRunning) {
          db.updateTopic(tp.user_id, tp.profile, tp.id, { isRunning: true })
          syncedCount += 1
        }
        const added = await syncChiefTranscript(run, tp.user_id, tp.profile, tp.id, false)
        if (added) syncedCount += 1
      } else {
        const wasRunning = Boolean(topic.isRunning)
        const added = await syncChiefTranscript(run, tp.user_id, tp.profile, tp.id, wasRunning)
        if (wasRunning) {
          requestChiefSettle(tp.user_id, tp.profile, tp.id)
          await auditChiefRepoMutation(run, tp.user_id, tp.profile, tp.id)
        }
        const drained = await drainTopicQueue(run, tp.user_id, tp.profile, tp.id)
        if (wasRunning || added || drained) {
          syncedCount += 1
        }
      }
    }

    // Crash self-healing for stuck 'merging' todos (e.g. if Studio restarted mid-merge)
    for (const mt of mergingTodosRows) {
      if (mt.profile !== run.identity.profile) continue
      if (mergingTodos.has(mt.id)) continue
      if (Date.now() - Number(mt.updated_at || 0) < 30000) continue
      const stuck = db.getTodo(mt.user_id, mt.profile, mt.id)
      if (!stuck || stuck.phase !== 'merging') continue
      db.updateTodo(mt.user_id, mt.profile, stuck.id, {
        phase: 'review',
        gateOwner: 'human',
        gateKind: 'merge',
        lastError: '上次合并过程中服务重启，已自动恢复至待验收状态，可重新点击合并。',
      })
      db.appendTimeline(mt.user_id, mt.profile, stuck.id, '检测到中断的合并状态，已自动恢复至待验收', 'system')
      syncedCount += 1
    }

    // 0.9.70 (#85): at most one card is stopped by the stall watchdog per pass.
    // #91 (review): and at most one automatic stop is attempted per pass (stopAttempts).
    const stallBudget = { healed: 0, stopAttempts: 0 }
    const watchedNow = new Set()
    for (const td of activeTodos) {
      if (td.profile !== run.identity.profile) continue
      const todo = db.getTodo(td.user_id, td.profile, td.id)
      if (!todo) continue
      watchedNow.add(todo.id)
      // 0.9.49 (#46): a review dispatch writes `reviewing` and the review session before it launches the run.
      // Until the launch returned, that session is idle because nothing was started in it, not because a
      // review ended: it is not probed and not settled (a settle found an empty or an older transcript and
      // wrote a verdict no review of this round gave).
      const unlaunchedReview = todo.phase === 'reviewing' && !todo.reviewRunId
      if (!unlaunchedReview) reviewUnknownSince.delete(todo.id)
      if (unlaunchedReview && reviewLaunchInFlight(todo.id)) {
        reviewUnknownSince.delete(todo.id)
        continue
      }
      const sid = todo.phase === 'reviewing' ? todo.reviewSessionId : todo.buildSessionId
      if (!sid) continue
      const probe = await probeSessionWorking(run, sid, { timeoutMs: 1200 })
      if (!probe.known) {
        // 0.9.49 (#46): the host cannot tell the state of the review session (it no longer knows it after a
        // restart, or the probe keeps failing). One such probe is not taken as idle: the review may be
        // running. Unknown in every probe for the whole quiet window: the card goes back to the merge gate.
        if (unlaunchedReview) {
          const seen = reviewUnknownSince.get(todo.id)
          if (!seen || seen.updatedAt !== todo.updatedAt) {
            reviewUnknownSince.set(todo.id, { since: clock(), updatedAt: todo.updatedAt })
          } else if (clock() - seen.since >= REVIEW_UNLAUNCHED_HEAL_MS
            && healUnlaunchedReview(run, td.user_id, td.profile, todo.id)) {
            reviewUnknownSince.delete(todo.id)
            syncedCount += 1
          }
          continue
        }
        // 0.9.70 (#85): a run the host cannot tell about is watched for silence like a working one.
        if (await watchStalledRun(run, td.user_id, td.profile, todo, sid, probe, stallBudget)) syncedCount += 1
        continue
      }
      reviewUnknownSince.delete(todo.id)
      if (!probe.isWorking) {
        // No run of this review round is on the card and none is working: there is nothing to settle. Once
        // the card has been quiet long enough it goes back to the merge gate (healUnlaunchedReview).
        if (unlaunchedReview) {
          if (healUnlaunchedReview(run, td.user_id, td.profile, todo.id)) syncedCount += 1
          continue
        }
        sessionActivity.delete(sid)
        await settleWorkerRun(run, td.user_id, td.profile, td.id, { sessionId: sid, outcome: 'completed' })
        syncedCount += 1
      } else {
        if (!sessionActivity.has(sid)) {
          sessionActivity.set(sid, {
            running: true,
            startedAt: probe.runStartedAt || todo.updatedAt || Date.now(),
            updatedAt: Date.now(),
            activeTool: '',
            toolCount: 0,
            stage: todo.phase === 'reviewing' ? 'reviewing' : 'building',
          })
        }
        // Stream live worker progress messages into TodoDrawer while running!
        const chatUpdated = await syncLiveWorkerChat(run, td.user_id, td.profile, todo, sid)
        if (chatUpdated) syncedCount += 1
        // 0.9.70 (#85): the host says it is working; is anything happening at all?
        const watched = db.getTodo(td.user_id, td.profile, td.id)
        if (watched && !unlaunchedReview && await watchStalledRun(run, td.user_id, td.profile, watched, sid, probe, stallBudget)) syncedCount += 1
      }
    }
    // Cards no longer building / reviewing (settled, stopped, deleted) leave the watchdog.
    for (const [todoId, entry] of [...buildActivity.entries()]) {
      if (entry.profile === run.identity.profile && !watchedNow.has(todoId)) forgetStall(todoId)
    }

    // #105: cards waiting too long at a gate the Chief owns get one reminder (no wake, no repeat).
    syncedCount += remindStaleChiefGates(run)

    // Drain any queued todos if concurrency slots are available
    const drainedTodos = await drainQueuedTodos(run, run.identity.userId, run.identity.profile)
    if (drainedTodos > 0) syncedCount += drainedTodos

    // Tick any due recurring/one-shot schedules (Todos wall-clock schedule semantics)
    const triggeredSchedules = await tickDueSchedules(run)
    if (triggeredSchedules > 0) syncedCount += triggeredSchedules

    // Background auto-refresh for stale enabled quota providers (non-blocking)
    void maybeAutoRefreshStaleQuotas(run).catch(() => {})

    if (syncedCount > 0) emitUpdated(run, `reconciled:${syncedCount}`)
    syncedCount += await reconcileTodoQueues(run).catch(err => {
      log?.warn?.('Todo queue reconcile failed', { error: String(err?.message || err).slice(0, 300) })
      return 0
    })
    return { ok: true, checkedTopics: checkedTopicIds.size, checkedTodos: activeTodos.length, syncedCount }
  }

  /* ---------- v0.8.0: Pure Read-Only Project Browser (Branches / Files / Commits) ---------- */

  async function browseProjectBranches(run, { projectId }) {
    const { userId, profile } = run.identity
    const project = db.getProject(userId, profile, projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    // Only this project's cards annotate its branches (the filter object was a bare id before Todo #98,
    // which listed every project's cards).
    const todos = db.listTodos(userId, profile, { projectId: project.id })
    return listProjectBranches(project.repoPath, project.defaultBranch, todos)
  }

  async function browseProjectTree(run, { projectId, ref = '', path = '' }) {
    const { userId, profile } = run.identity
    const project = db.getProject(userId, profile, projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return listProjectTree(project.repoPath, ref || project.defaultBranch || 'HEAD', path || '')
  }

  async function browseProjectFile(run, { projectId, ref = '', path = '' }) {
    const { userId, profile } = run.identity
    const project = db.getProject(userId, profile, projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return readProjectFile(project.repoPath, ref || project.defaultBranch || 'HEAD', path || '')
  }

  async function browseProjectCommits(run, { projectId, ref = '', limit = 30 }) {
    const { userId, profile } = run.identity
    const project = db.getProject(userId, profile, projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return listProjectCommits(project.repoPath, ref || project.defaultBranch || 'HEAD', limit)
  }

  async function browseProjectCommitDiff(run, { projectId, sha }) {
    const { userId, profile } = run.identity
    const project = db.getProject(userId, profile, projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return readProjectCommitDiff(project.repoPath, sha)
  }

  /* ---------- v0.8.0: Quota & Token Usage Hub ---------- */

  const quotaRefreshingKeys = new Set()

  async function saveQuotaProvider(run, input) {
    const { userId, profile } = run.identity
    const provider = db.upsertQuotaProvider(userId, profile, input)
    emitUpdated(run, `quota.saved:${provider.id}`)
    return { provider, state: await getSnapshot(run) }
  }

  async function deleteQuotaProvider(run, { id }) {
    const { userId, profile } = run.identity
    db.deleteQuotaProvider(userId, profile, id)
    emitUpdated(run, `quota.deleted:${id}`)
    return getSnapshot(run)
  }

  async function refreshQuotaProvider(run, { id }) {
    const { userId, profile } = run.identity
    const raw = db.getQuotaProviderRaw(userId, profile, id)
    if (!raw) throw new Error(`Quota provider not found: ${id}`)
    const lockKey = `${userId}:${profile}:${id}`
    if (quotaRefreshingKeys.has(lockKey)) {
      return { provider: db.listQuotaProviders(userId, profile).find(p => p.id === id), state: await getSnapshot(run) }
    }
    quotaRefreshingKeys.add(lockKey)
    try {
      const snap = await probeSingleQuotaProvider(raw, { profile })
      const provider = db.saveQuotaProviderSnapshot(userId, profile, id, snap)
      emitUpdated(run, `quota.refreshed:${id}`)
      return { provider, state: await getSnapshot(run) }
    } finally {
      quotaRefreshingKeys.delete(lockKey)
    }
  }

  async function refreshAllQuotas(run, { onlyEnabled = true } = {}) {
    const { userId, profile } = run.identity
    const list = db.listQuotaProviders(userId, profile)
    const targets = onlyEnabled ? list.filter(p => p.enabled) : list
    await Promise.all(targets.map(async p => {
      const lockKey = `${userId}:${profile}:${p.id}`
      if (quotaRefreshingKeys.has(lockKey)) return
      quotaRefreshingKeys.add(lockKey)
      try {
        const raw = db.getQuotaProviderRaw(userId, profile, p.id)
        if (!raw) return
        const snap = await probeSingleQuotaProvider(raw, { profile })
        db.saveQuotaProviderSnapshot(userId, profile, p.id, snap)
      } catch (err) {
        db.saveQuotaProviderSnapshot(userId, profile, p.id, {
          status: 'error',
          source: p.sourceMode || 'auto',
          sourceLabel: '检测异常',
          windows: [],
          balance: '',
          error: String(err?.message || err).slice(0, 180),
          checkedAt: Date.now(),
        })
      } finally {
        quotaRefreshingKeys.delete(lockKey)
      }
    }))
    emitUpdated(run, 'quota.refreshed.all')
    return getSnapshot(run)
  }

  async function maybeAutoRefreshStaleQuotas(run) {
    const { userId, profile } = run.identity
    const settings = db.getSettings(userId, profile, config)
    const mins = Number(settings.quotaAutoRefreshMin || 0)
    if (mins <= 0) return
    const threshold = mins * 60 * 1000
    const now = Date.now()
    const enabled = db.listQuotaProviders(userId, profile).filter(p => p.enabled)
    const stale = enabled.filter(p => !p.lastCheckedAt || (now - p.lastCheckedAt) >= threshold)
    if (stale.length === 0) return
    for (const p of stale.slice(0, 4)) {
      const lockKey = `${userId}:${profile}:${p.id}`
      if (quotaRefreshingKeys.has(lockKey)) continue
      quotaRefreshingKeys.add(lockKey)
      void (async () => {
        try {
          const raw = db.getQuotaProviderRaw(userId, profile, p.id)
          if (!raw) return
          const snap = await probeSingleQuotaProvider(raw, { profile })
          db.saveQuotaProviderSnapshot(userId, profile, p.id, snap)
          emitUpdated(run, `quota.auto:${p.id}`)
        } catch {
          // ignore silent background errors
        } finally {
          quotaRefreshingKeys.delete(lockKey)
        }
      })()
    }
  }

  /* ---------- Session Trace: full model call / tool / reasoning timeline for one owned session ---------- */

  function listOwnedTraceSessions(userId, profile) {
    const out = []
    for (const tp of db.listTopics(userId, profile)) {
      if (tp.chiefSessionId) out.push({ sessionId: tp.chiefSessionId, kind: 'chief', label: `总管 · ${tp.title}`, topicId: tp.id, updatedAt: tp.updatedAt || 0, running: Boolean(tp.isRunning) })
    }
    for (const td of db.listTodos(userId, profile)) {
      if (td.buildSessionId) out.push({ sessionId: td.buildSessionId, kind: 'build', label: `#${td.number} 构建 · ${td.title}`, todoId: td.id, updatedAt: td.updatedAt || 0, running: ['building', 'merging'].includes(td.phase) })
      if (td.reviewSessionId) out.push({ sessionId: td.reviewSessionId, kind: 'review', label: `#${td.number} 审查 · ${td.title}`, todoId: td.id, updatedAt: td.updatedAt || 0, running: td.phase === 'reviewing' })
    }
    return out.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
  }

  function clipText(v, max) {
    const t = typeof v === 'string' ? v : (v === undefined || v === null ? '' : JSON.stringify(v, null, 2))
    return t.length > max ? { text: t.slice(0, max), truncated: true, length: t.length } : { text: t, truncated: false, length: t.length }
  }

  function normalizeTraceContent(content) {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return part.text || ''
        if (part?.type === 'image' || part?.type === 'image_url') return `[图片 ${part.name || ''}]`
        if (part?.type === 'file') return `[文件 ${part.name || part.path || ''}]`
        return ''
      }).filter(Boolean).join('\n')
    }
    return content ? JSON.stringify(content) : ''
  }

  async function getSessionTrace(run, { sessionId = '', limit = 400 } = {}) {
    const { userId, profile } = run.identity
    const sessions = listOwnedTraceSessions(userId, profile)
    const sid = String(sessionId || '').trim()
    if (!sid) return { sessions, trace: null }
    const owned = sessions.find(x => x.sessionId === sid)
    if (!owned) throw new Error('只能查看 Ekko ToDo 自己创建的会话')

    const [detail, msgRes] = await Promise.all([
      run.host.sessions.get(sid).catch(() => null),
      run.host.sessions.messages(sid, { limit: Math.max(20, Math.min(1000, Number(limit) || 400)) }).catch(() => null),
    ])
    const meta = detail?.session || detail || {}
    const rawMsgs = Array.isArray(msgRes?.messages) ? msgRes.messages
      : Array.isArray(msgRes) ? msgRes
        : (Array.isArray(meta.messages) ? meta.messages : [])

    const toSec = t => { const n = Number(t || 0); return n > 1e12 ? n / 1000 : n }
    const resultsByCallId = new Map()
    for (const m of rawMsgs) {
      if (m?.role === 'tool' && m.tool_call_id) resultsByCallId.set(String(m.tool_call_id), m)
    }

    const steps = []
    let toolCalls = 0
    let toolErrors = 0
    let prevTs = 0
    for (const m of rawMsgs) {
      if (!m || typeof m !== 'object') continue
      const ts = toSec(m.timestamp)
      const gapSec = prevTs && ts ? Math.max(0, Math.round(ts - prevTs)) : 0
      if (ts) prevTs = ts
      if (m.role === 'tool') continue // folded into its call
      const text = normalizeTraceContent(m.display_content || m.content).trim()
      const reasoning = String(m.reasoning_content || m.reasoning || '').trim()
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
      if (m.role === 'user' || m.role === 'system') {
        if (!text) continue
        steps.push({ kind: m.role === 'system' ? 'system' : (isInternalWakeUserPrompt(text) ? 'wake' : 'user'), at: ts, gapSec, text: clipText(text, 12000) })
        continue
      }
      if (m.role === 'assistant') {
        if (reasoning) steps.push({ kind: 'reasoning', at: ts, gapSec, text: clipText(reasoning, 12000) })
        if (text) steps.push({ kind: 'assistant', at: ts, gapSec: reasoning ? 0 : gapSec, text: clipText(text, 20000), tokens: Number(m.token_count || 0), finishReason: String(m.finish_reason || '') })
        for (const c of calls) {
          toolCalls += 1
          const callId = String(c?.id || c?.call_id || '')
          const res = callId ? resultsByCallId.get(callId) : null
          const resText = res ? normalizeTraceContent(res.content) : ''
          const failed = /"(error|is_error)"\s*:\s*(true|"[^"]+")|\bTraceback\b|exit_code"\s*:\s*[1-9]/.test(resText.slice(0, 4000))
          if (failed) toolErrors += 1
          const resTs = res ? toSec(res.timestamp) : 0
          let argsText = String(c?.function?.arguments ?? c?.arguments ?? '')
          try { argsText = JSON.stringify(JSON.parse(argsText), null, 2) } catch {}
          steps.push({
            kind: 'tool',
            at: ts,
            gapSec: (text || reasoning) ? 0 : gapSec,
            name: String(c?.function?.name || c?.name || res?.tool_name || 'tool'),
            args: clipText(argsText, 8000),
            result: clipText(resText, 12000),
            durationSec: resTs && ts ? Math.max(0, Math.round(resTs - ts)) : null,
            pending: !res,
            failed,
          })
        }
      }
    }

    const live = await probeSessionWorking(run, sid, { timeoutMs: 900 }).catch(() => null)
    const firstTs = steps.find(x => x.at)?.at || toSec(meta.started_at)
    const lastTs = prevTs || toSec(meta.last_active)
    return {
      sessions,
      trace: {
        sessionId: sid,
        kind: owned.kind,
        label: owned.label,
        topicId: owned.topicId || '',
        todoId: owned.todoId || '',
        model: String(meta.model || ''),
        provider: String(meta.provider || meta.billing_provider || ''),
        agent: String(meta.agent || ''),
        running: Boolean(live?.known ? live.isWorking : owned.running),
        startedAt: firstTs || 0,
        lastActiveAt: lastTs || 0,
        endReason: String(meta.end_reason || ''),
        messageCount: Number(meta.message_count || rawMsgs.length),
        toolCalls,
        toolErrors,
        inputTokens: Number(meta.input_tokens || 0),
        outputTokens: Number(meta.output_tokens || 0) || rawMsgs.reduce((acc, m) => acc + (m?.role === 'assistant' ? Number(m.token_count || 0) : 0), 0),
        cacheReadTokens: Number(meta.cache_read_tokens || 0),
        reasoningTokens: Number(meta.reasoning_tokens || 0),
        costUsd: Number(meta.actual_cost_usd ?? meta.estimated_cost_usd ?? 0) || 0,
        steps,
      },
    }
  }

  async function getTokenUsage(run, { range = '7d' } = {}) {
    const { userId, profile } = run.identity
    const todos = db.listTodos(userId, profile)
    const topics = db.listTopics(userId, profile)
    // Session totals come from the Hermes engine ledger; the plugin's own usage_records only add sessions the
    // ledger does not know (other engines), so nothing is counted twice.
    const sessions = collectPluginSessions(db.listTopics(userId, profile, { includeArchived: true }), todos)
    const usageMap = readHermesSessionUsage(sessions.map(x => x.sessionId), { profile })
    const ledger = sessionUsageToRecords(sessions, usageMap)
    const own = db.listUsageRecords(userId, profile).filter(r => !usageMap.has(String(r.session_id || '')))
    const records = [...ledger, ...own]
    const summary = readLocalTokenUsageSummary(range, {
      totalTodos: todos.length,
      doneTodos: todos.filter(t => t.phase === 'done').length,
      activeTodos: todos.filter(t => ['building', 'reviewing', 'queued', 'merging'].includes(t.phase)).length,
      topicCount: topics.filter(t => !t.archived).length,
    }, records)
    summary.sources = [
      ...(ledger.length ? [`Hermes 会话记录（${ledger.length}/${sessions.length} 个会话）`] : []),
      ...(own.length ? ['插件运行记录'] : []),
    ]
    summary.sessionCoverage = { tracked: sessions.length, withUsage: ledger.length }
    return summary
  }

  /* ---------- v0.8.0: Schedules (Wall-Clock Recurring & One-Shot Task Runs) ---------- */

  const tickingScheduleIds = new Set()

  async function listSchedules(run, { projectId = '' } = {}) {
    const { userId, profile } = run.identity
    return db.listSchedules(userId, profile, projectId)
  }

  async function saveSchedule(run, input, actor = 'user') {
    const { userId, profile } = run.identity
    const schedule = input?.id
      ? db.updateSchedule(userId, profile, input.id, input)
      : db.createSchedule(userId, profile, input, actor)
    emitUpdated(run, `schedule.saved:${schedule.id}`)
    return { schedule, state: await getSnapshot(run) }
  }

  async function deleteSchedule(run, { id }) {
    const { userId, profile } = run.identity
    db.deleteSchedule(userId, profile, id)
    emitUpdated(run, `schedule.deleted:${id}`)
    return getSnapshot(run)
  }

  async function executeScheduleItem(run, schedule, { manual = false } = {}) {
    if (!schedule || tickingScheduleIds.has(schedule.id)) return { status: 'busy' }
    tickingScheduleIds.add(schedule.id)
    const now = Date.now()
    const userId = schedule.userId || run.identity.userId
    const profile = schedule.profile || run.identity.profile
    const scopedRun = {
      ...run,
      identity: { ...run.identity, userId, profile },
    }
    const advanceRecurring = () => (
      schedule.frequency === 'once'
        ? { enabled: false, nextRunAt: 0 }
        : { nextRunAt: computeNextRunAt(schedule, now) }
    )

    try {
      const todo = db.getTodo(userId, profile, schedule.todoId)
      if (!todo) {
        db.updateSchedule(userId, profile, schedule.id, {
          ...advanceRecurring(),
          lastRunAt: now,
          lastStatus: 'skipped',
          lastMessage: '目标任务已被删除，本轮跳过',
        })
        return { status: 'skipped', reason: 'todo_missing' }
      }

      if (!manual && todo.phase === 'closed') {
        db.updateSchedule(userId, profile, schedule.id, {
          ...advanceRecurring(),
          lastRunAt: now,
          lastStatus: 'skipped',
          lastMessage: '任务已关闭，定时规则不自动恢复（手动重跑不受此限）',
        })
        return { status: 'skipped', reason: 'todo_closed' }
      }

      const effectiveAgentId = schedule.agentId || todo.agentId
      if (!effectiveAgentId) {
        db.updateSchedule(userId, profile, schedule.id, {
          ...advanceRecurring(),
          lastRunAt: now,
          lastStatus: 'skipped',
          lastMessage: '任务未指派执行 Agent，本轮跳过',
        })
        return { status: 'skipped', reason: 'no_agent' }
      }

      // Todos spec: "周期优先于遗留" — cancel any in-flight or parked previous run cleanly before starting fresh
      if (todo.phase === 'building' || todo.phase === 'reviewing') {
        await cancelBuild(scopedRun, { todoId: todo.id, discard: false }).catch(() => {})
      } else if (todo.phase === 'closed' && manual) {
        await reopenTodo(scopedRun, { todoId: todo.id }).catch(() => {})
      }

      if (schedule.agentId && schedule.agentId !== todo.agentId) {
        const ag = db.getAgent(userId, profile, db.resolveAgentId(userId, profile, schedule.agentId))
        if (ag && ag.id !== todo.agentId) {
          db.updateTodo(userId, profile, todo.id, { agentId: ag.id, engine: ag.engine })
        }
      }

      const ruleText = formatScheduleRuleLabel(schedule)
      db.appendTimeline(
        userId,
        profile,
        todo.id,
        manual ? `⏰ 手动触发定时规则（${ruleText}）开始全新运行` : `⏰ 定时规则到点触发（${ruleText}）开始全新运行`,
        'schedule',
      )

      const started = await startBuild(scopedRun, {
        todoId: todo.id,
        withPlan: Boolean(todo.withPlan),
        fresh: true,
      })

      const isQueued = started?.phase === 'queued'
      db.updateSchedule(userId, profile, schedule.id, {
        ...(schedule.frequency === 'once' ? { enabled: false, nextRunAt: 0 } : { nextRunAt: computeNextRunAt(schedule, now) }),
        lastRunAt: now,
        lastStatus: isQueued ? 'queued' : 'triggered',
        lastMessage: isQueued
          ? `已触发，当前并发槽位已满，任务 #${todo.number} 进入排队等待空槽`
          : `已触发任务 #${todo.number} 全新运行（${ruleText}）`,
      })
      emitUpdated(scopedRun, `schedule.triggered:${schedule.id}`)
      return { status: isQueued ? 'queued' : 'triggered', todo: started }
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 220)
      // One-shot rules retry every minute until they actually start (per Todos spec)
      const nextPatch = schedule.frequency === 'once'
        ? { nextRunAt: now + 60_000 }
        : { nextRunAt: computeNextRunAt(schedule, now) }
      db.updateSchedule(userId, profile, schedule.id, {
        ...nextPatch,
        lastRunAt: now,
        lastStatus: 'failed',
        lastMessage: `触发失败：${msg}`,
      })
      emitUpdated(scopedRun, `schedule.failed:${schedule.id}`)
      return { status: 'failed', error: msg }
    } finally {
      tickingScheduleIds.delete(schedule.id)
    }
  }

  async function triggerScheduleNow(run, { id }) {
    const { userId, profile } = run.identity
    const schedule = db.getSchedule(userId, profile, id)
    if (!schedule) throw new Error(`Schedule not found: ${id}`)
    await executeScheduleItem(run, schedule, { manual: true })
    return getSnapshot(run)
  }

  async function tickDueSchedules(run) {
    const now = Date.now()
    const due = db.listDueSchedules(now).filter(s => s.profile === run.identity.profile)
    let count = 0
    for (const s of due) {
      const res = await executeScheduleItem(run, s, { manual: false })
      if (res && res.status !== 'busy') count += 1
    }
    return count
  }

  return {
    getSnapshot,
    getModelCatalog,
    readHostMemory,
    getGithubAuthStatus,
    startGithubDeviceAuth,
    saveGithubToken,
    logoutGithub,
    listGithubRepos,
    uploadChatFile,
    completeOnboarding,
    syncSessionIsolation,
    // #64: exposed so tests can lock the dead-handle behaviour of the probe and the launch directly.
    probeSessionWorking,
    launchSessionRun,
    syncTopicSession,
    getTopicContext,
    beginTopicCompress,
    recordTopicCommand,
    inspectRepo,
    inspectProjectRepo,
    browseProjectBranches,
    browseProjectTree,
    browseProjectFile,
    browseProjectCommits,
    browseProjectCommitDiff,
    saveQuotaProvider,
    deleteQuotaProvider,
    refreshQuotaProvider,
    refreshAllQuotas,
    getTokenUsage,
    getSessionTrace,
    listSchedules,
    saveSchedule,
    deleteSchedule,
    triggerScheduleNow,
    tickDueSchedules,
    addProject,
    importGithubProject,
    updateProject,
    deleteProject,
    deleteTodo,
    getTodoDiffs,
    getTodoDetail,
    searchWorkspace,
    saveAgent,
    clearAgentCooldowns,
    removeAgent,
    saveSettings,
    quickConfigureChief,
    saveMemory,
    removeMemory,
    createTopic,
    renameTopic,
    updateTopicMeta,
    markBriefWaitingDone,
    setTopicAutopilot,
    deleteTopic,
    sendTopicMessage,
    cancelTopicQueueItem,
    promoteTopicQueueItem,
    stopTopicRun,
    syncChiefTranscript,
    createTodo,
    // #97: topic / project ownership.
    repairTodoTopic,
    repairTopicTodos,
    adoptOrphanTopics,
    chiefTodoScopeCheck,
    topicManagesTodo,
    chiefTodoScopeViolation,
    chiefListScope,
    watchTodoFromTopic,
    linkTurnMessageToTodo,
    resolveChiefCaller,
    topicBindsOnFirstCard,
    firstCardBindTopic,
    setTopicProject,
    startBuild,
    runIndependentReview,
    settleWorkerRun: disposedSafe('构建结算', settleWorkerRun),
    askUserQuestion,
    maybeWakeChief,
    answerQuestion,
    confirmPlan,
    requestChanges,
    messageTodo,
    startBuildBudgeted,
    mergeBuild,
    retryMerge,
    todoWriteLocks,
    TODO_WRITE_LOCK_TTL_MS,
    TODO_QUEUE_DROP_PHASES,
    cancelBuild,
    completeTodo,
    closeTodo,
    reopenTodo,
    refreshTodoDiff,
    // #68: the background entries of an old instance end with one "已废弃" log line once it is disposed.
    handleHostEvent: disposedSafe('事件结算', handleHostEvent),
    reconcileActiveRuns: disposedSafe('定时对账', reconcileActiveRuns),
    settlePendingTopics: disposedSafe('话题收尾', settlePendingTopics),
    dispose,
  }
}

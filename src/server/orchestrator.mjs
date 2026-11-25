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
} from './git-engine.mjs'
import {
  MAX_CHARTER_CHARS, MAX_CHAT_ENTRIES, MAX_CHAT_ENTRY_CHARS, MAX_LAST_ERROR_CHARS, MAX_PLAN_BYTES, MAX_QUEUED_ITEMS_IN_VIEW,
  MAX_MEMORY_CONTENT_CHARS, MAX_MEMORY_TITLE_CHARS, MAX_QUESTION_TEXT_CHARS, MAX_QUEUED_TEXT_CHARS,
  MAX_AGENT_REF_CHARS, MAX_SYSTEM_PROMPT_CHARS, assertMaxLength, MAX_CLONE_ROOT_CHARS, MAX_TAG_CHARS, MAX_TAGS, MAX_TOPIC_TITLE_CHARS, clampTags, MAX_SPEC_CHARS, MAX_TITLE_CHARS, MAX_TOPIC_MESSAGE_CHARS, PROJECT_TEXT_LIMITS, clampBrief, clampOptions, findOptionById, clampBuildChat, clampQuestion, clampText, clampUtf8, fitSnapshotBudget,
} from './diff-budget.mjs'
import { collectPluginSessions, readHermesSessionUsage, sessionUsageToRecords } from './session-usage.mjs'
import { computeNextRunAt, formatScheduleRuleLabel } from './schedule-engine.mjs'
import { probeSingleQuotaProvider, readLocalTokenUsageSummary } from './quota-engine.mjs'
import { getTeamPreset } from './team-presets.mjs'
import { AVATAR_UPLOAD_SPEC } from './avatars.mjs'
import { runDeterministicTestGate } from './gate-runner.mjs'
import { readableLaunchFailure } from './launch-failure.mjs'
import { DESCRIBE_ONLY_LIMIT, detectChiefLoop, formatLoopStopNotice, isDescribeTool, isLoopStopNotice, isSchemaOnlyTool } from '../shared/loop-guard.mjs'
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
  buildReviewPrompt,
  buildAutomatedWakePrompt,
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

function normalizeHostMessages(res) {
  const list = Array.isArray(res?.messages) ? res.messages : []
  return list.map(m => ({
    id: String(m.id ?? ''),
    role: String(m.display_role || m.role || ''),
    content: extractTextFromContent(m.content),
    timestamp: Number(m.timestamp || 0),
  }))
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
 * What the last assistant message of a review turn says. Three values since 0.9.49 (#47):
 *  1. The text has verdict lines (`VERDICT: APPROVED` / `VERDICT: CHANGES_REQUESTED`; case, spaces around
 *     the colon and markup around it do not matter; the colon may be ASCII `:` or full-width `：`). The
 *     LAST one is the candidate, as the review prompt asks for the verdict on the last line.
 *     a. The line of that last one names both verdicts ("VERDICT: APPROVED or CHANGES_REQUESTED"): a
 *        template or a question, not a verdict -> 'inconclusive'.
 *     b. The last one is APPROVED and a `VERDICT: CHANGES_REQUESTED` line is anywhere in the text ->
 *        'inconclusive'. Such a text is either an approval that quotes the rejection line or a rejection
 *        followed by "once fixed this becomes VERDICT: APPROVED"; nothing here tries to tell them apart,
 *        and the reviewer is asked for one verdict. The check is one-sided on purpose: reading a rejection
 *        as approved lets the Chief merge it, reading an approval as rejected only stops the card.
 *     c. Otherwise the last one decides. A text with a single verdict line is judged as it always was.
 *     Nothing below is asked once a verdict line was found.
 *  2. No verdict line: text that waits for a later turn (REVIEW_DEFERRAL_RE) -> 'inconclusive', whatever
 *     else it names; otherwise the bare token CHANGES_REQUESTED -> 'changes_requested', the bare word
 *     APPROVED -> 'approved'.
 *  3. Anything else, empty text included -> 'inconclusive'. It used to be 'changes_requested'.
 * Only the token CHANGES_REQUESTED counts as a rejection: no wording in prose does ("没有发现必须修改的地方"
 * would read as one).
 * 0.9.52 (#50): directly after `VERDICT:` the rejection may also be written `CHANGES REQUESTED` or
 * `CHANGES-REQUESTED` (found as a verdict line, and counted by 1b). Anywhere else these two spellings stay
 * prose: "no changes requested" is not a rejection.
 */
export function parseReviewVerdict(text) {
  const clean = String(text || '').trim()
  if (!clean) return 'inconclusive'
  const upper = clean.toUpperCase()
  let last = null
  for (const m of upper.matchAll(/VERDICT\s*[:：]\s*(APPROVED|CHANGES[ _-]REQUESTED)/g)) last = m
  if (last) {
    const lineStart = upper.lastIndexOf('\n', last.index) + 1
    const lineEndAt = upper.indexOf('\n', last.index)
    const line = upper.slice(lineStart, lineEndAt === -1 ? upper.length : lineEndAt)
    // Bare tokens, so this does not depend on which colon the line uses.
    if (/CHANGES_REQUESTED/.test(line) && /\bAPPROVED\b/.test(line)) return 'inconclusive'
    if (last[1] === 'APPROVED' && /VERDICT\s*[:：]\s*CHANGES[ _-]REQUESTED/.test(upper)) return 'inconclusive'
    return last[1] === 'APPROVED' ? 'approved' : 'changes_requested'
  }
  if (REVIEW_DEFERRAL_RE.test(upper)) return 'inconclusive'
  if (/CHANGES_REQUESTED/.test(upper)) return 'changes_requested'
  if (/\bAPPROVED\b/.test(upper)) return 'approved'
  return 'inconclusive'
}

// 0.9.49 (#47): sent once, into the same review session, when a review turn ended without a verdict.
const MAX_REVIEW_INCONCLUSIVE_RETRIES = 1
const REVIEW_VERDICT_NUDGE = [
  '你上一条回复没有给出审查结论。平台只读取每个回合的最后一条回复，回合结束后不会再自动叫醒你继续。',
  '请现在就给出结论：需要的检查在本回合内做完；还在后台跑的命令请在本回合内等它结束，或按已有证据判断。',
  '若结论是需修改，请把必须修改的问题逐条写在本条回复里（下一步只会读到这一条）。',
  '最后一行必须写 `VERDICT: APPROVED` 或 `VERDICT: CHANGES_REQUESTED`（二选一，单独成行）。',
  '本条回复里只写这一行结论，不要再引用或复述另一种结论行：两种结论行同时出现时平台不会记为通过。',
].join('\n')

function readHostHermesMaxTurns(profile = 'default') {
  const candidates = [
    join(homedir(), '.hermes', 'profiles', String(profile || 'default'), 'config.yaml'),
    join(homedir(), '.hermes', 'config.yaml'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const raw = readFileSync(p, 'utf8')
      const block = raw.match(/(?:^|\n)agent:\s*\n([\s\S]*?)(?:\n[a-zA-Z0-9_-]+:|\s*$)/)
      if (block) {
        const m = block[1].match(/^\s+max_turns:\s*(\d+)/m)
        if (m) return Number(m[1]) || 0
      }
    } catch {
      // ignore unreadable config
    }
  }
  return 0
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

export function createOrchestrator({ db, dataDir, config = {}, log = console, settleDelaysMs = null, sendBudgetMs = 800, messageTodoBudgetMs = 1500, slowLaunchWarnMs = 3000, instructionDedupeMs = 60000, busyProbeMs = 700, clock = Date.now }) {
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
  const SEND_BUDGET_MS = Math.max(0, Number(sendBudgetMs) || 0)
  const MESSAGE_TODO_BUDGET_MS = Math.max(0, Number(messageTodoBudgetMs) || 0)
  const SLOW_LAUNCH_WARN_MS = Math.max(0, Number(slowLaunchWarnMs) || 0)
  // Sends being handled right now, `${topicId}:${clientNonce}`: a retry of the same send is answered at once.
  const inflightSends = new Set()
  // topicId -> id of the user message whose Chief turn is being started right now.
  const launchingMessages = new Map()
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
      log?.warn?.('sessions.run rejected', { sessionId, ms: Date.now() - startedAt, error: msg.slice(0, 300) })
      // The host refused because this session already has a live run: the work is in progress, not failed.
      if (/already running/i.test(msg)) return { run_id: '', recoveredFromTimeout: true, alreadyRunning: true }
      if (!/abort|timed?\s*out|timeout/i.test(msg)) throw err
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
    const topics = db.listTopics(userId, profile).map(t => {
      const act = t.chiefSessionId ? (sessionActivity.get(t.chiefSessionId) || null) : null
      const queuedItems = db.listTopicQueue(userId, profile, t.id)
      const view = {
        ...t,
        isRunning: Boolean(t.isRunning || act?.running),
        liveActivity: act,
        queuedItems,
      }
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
    const hostMaxTurns = readHostHermesMaxTurns(profile)
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
    void drainQueuedTodos(run, userId, profile).catch(() => {})
    return getSnapshot(run)
  }

  async function saveAgent(run, input) {
    const { userId, profile } = run.identity
    if (!db.listAgents(userId, profile).length) {
      const liveEngines = await probeLiveEngines(run)
      db.ensureDefaultAgents(userId, profile, liveEngines)
    }
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
      void drainQueuedTodos(run, userId, profile).catch(() => {})
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
          maxTurns: 0,
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
    db.updateTopic(userId, profile, input.topicId, patch)
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

  function buildRunModelOptions(cfg, agent = null) {
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
    // maxTurns === 0 means unrestricted (inherit engine/host native turn limit, e.g. Hermes 500)
    const maxTurns = Number(agent?.maxTurns || 0)
    if (Number.isFinite(maxTurns) && maxTurns > 0) {
      opts.max_turns = maxTurns
    }
    return opts
  }

  async function ensureSessionForConfig(run, { existingSessionId, title, cfg, workspace, forceNew = false }) {
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

  async function maybeAutoGenerateTopicTitle(run, userId, profile, topicId, userText, activeCfg) {
    const cur = db.getTopic(userId, profile, topicId)
    if (!cur || cur.isUserNamed) return
    const result = await generateTopicTitleWithModel(run, {
      userText,
      preferredModel: activeCfg?.model || '',
      preferredProvider: activeCfg?.provider || '',
    }).catch(() => null)
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

  async function launchChiefRunWithFailover(run, { userId, profile, topic, chiefAgent, promptText, attachments = [], instructions, activeProject, forceNewSession = false }) {
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

    for (let attempt = 0; attempt < Math.max(1, chiefAgent.modelConfigs.length); attempt += 1) {
      try {
        sessionId = await ensureSessionForConfig(run, {
          existingSessionId: sessionId,
          title: `[Ekko ToDo] ${topic.title}`,
          cfg: activeCfg,
          workspace: chiefWorkspace,
          forceNew: needFreshSession,
        })
        const runOptions = {
          wait: false,
          instructions,
          ...buildRunModelOptions(activeCfg, chiefAgent),
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
          lastDigestAt: now,
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
    if (!isWake && recordHumanBubble) {
      const storedId = db.addTopicMessage(userId, profile, topic.id, { kind: 'human', text: cleanText, attachments, clientNonce })
      if (bubbleRef) bubbleRef.id = storedId
      if (storedId) launchingMessages.set(topic.id, storedId)
      if (storedId) emitUpdated(run, `topic.message.accepted:${topic.id}`)
    }
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

      const recentUpdates = db.getRecentTodoUpdatesSince(userId, profile, topic.lastDigestAt)
      const digestPrefix = recentUpdates.length
        ? `Since your last turn:\n${recentUpdates.map(u => `- #${u.number} ${u.title}: phase=${u.phase} (wait=${u.gate_owner}/${u.gate_kind})`).join('\n')}\n\n`
        : ''
      promptToSend = digestPrefix + mentionPrefix + cleanText
    }

    const activeTodos = db.listTodos(userId, profile).filter(t => t.phase !== 'done' && t.phase !== 'closed')
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
    })

    if (!isWake && !topic.isUserNamed && isFirstMessage) {
      void maybeAutoGenerateTopicTitle(run, userId, profile, topic.id, cleanText, activeCfg)
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
    // Everything after this runs as `work`. The call waits for it for SEND_BUDGET_MS and then answers with
    // the current state; `work` goes on and reports through board.updated.
    const work = settled(() => deliverSend())
    const result = await withinBudget(work, SEND_BUDGET_MS)
    // Still starting: the message is stored (or the busy probe is still open).
    if (result === null) {
      void work.then(() => emitUpdated(run, `topic.launch.settled:${topic.id}`))
      return getSnapshot(run)
    }
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
    const result = await withinBudget(work, SEND_BUDGET_MS)
    if (result === null) {
      void work.then(() => emitUpdated(run, `topic.launch.settled:${topic.id}`))
      return getSnapshot(run)
    }
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
      return !hasCalls && !String(last.content || '').trim()
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
        db.watchTodo(userId, profile, topicId, td.id, 'Auto-watch after stopping Chief busy-poll')
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

  // The topic of the Chief session that is calling the create-todo tool right now: among the Chief sessions
  // of this account and profile whose last started tool is a create-todo tool no older than 120 seconds,
  // whose topic is not archived and still marked running, the one that started it last. null when none.
  function identifyCallerByTool(userId, profile) {
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
      if (!best || entry.at >= best.at) best = { topicId: topic.id, title: topic.title, at: entry.at }
    }
    return best ? { topicId: best.topicId, title: best.title } : null
  }

  // The topic of the Chief run that most probably made a call without identity.sessionId: among the running
  // Chief sessions of this account and profile whose topic is not archived and still marked running, the one
  // that started last. `candidates` is how many qualified. null when there is none.
  function inferCallerTopicId(userId, profile) {
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
      candidates += 1
      if (!best || entry.startedAt >= best.startedAt) best = { topicId: topic.id, title: topic.title, startedAt: entry.startedAt }
    }
    return best ? { topicId: best.topicId, title: best.title, candidates } : null
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
      } else if (hm.role === 'user') {
        if (isInternalWakeUserPrompt(content)) continue
        // Strip internal digest/mention prefixes if any, and deduplicate against plugin-originated human bubbles
        const dupHuman = existingHumans.some(m => {
          const prev = m.text.trim()
          return (prev === content || content.endsWith(prev)) && Math.abs((m.createdAt || 0) - msgTs) < 180000
        })
        if (dupHuman) {
          existingIds.add(key)
          continue
        }
        const insertedId = db.addTopicMessage(userId, profile, topic.id, {
          kind: 'human',
          text: content,
          hostMessageId: key,
          createdAt: msgTs,
        })
        existingIds.add(key)
        existingHumans.push({ text: content, createdAt: msgTs })
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
            projects,
            agents: db.listAgents(userId, profile),
            activeTodos: db.listTodos(userId, profile).filter(t => t.phase !== 'done' && t.phase !== 'closed'),
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

  // Topic of a new card, in this order (resolvedBy in brackets): the given topic id [explicit]; the topic whose
  // Chief session made the call, identity.sessionId [caller-session]; the topic of the Chief session that has
  // just started the create-todo tool, see identifyCallerByTool [caller-tool]; the topic of the Chief run
  // under way, see inferCallerTopicId, a guess when several are running [active-run]; the most recently updated topic of this account that has a Chief
  // session, whatever its project [chief-topic]; a topic of the project without one, a new one being created
  // with Autopilot off [unattended]. `notes` are lines for the card timeline.
  function resolveTodoTopic(run, userId, profile, project, input) {
    if (input.topicId) return { topicId: input.topicId, unattended: false, resolvedBy: 'explicit', notes: [] }
    const callerSessionId = String(run.identity?.sessionId || '')
    const hit = callerSessionId ? db.findTopicBySessionId(callerSessionId) : null
    if (hit && hit.userId === userId && hit.profile === profile) {
      const callerTopic = db.getTopic(userId, profile, hit.topicId)
      if (callerTopic && !callerTopic.archived) return { topicId: callerTopic.id, unattended: false, resolvedBy: 'caller-session', notes: [] }
    }
    const byTool = identifyCallerByTool(userId, profile)
    if (byTool) {
      return { topicId: byTool.topicId, unattended: false, resolvedBy: 'caller-tool', notes: [`建单未指定话题：按调用中的工具定位到话题「${byTool.title}」`] }
    }
    const inferred = inferCallerTopicId(userId, profile)
    if (inferred) {
      // With several Chiefs running this is a guess, and the timeline says so.
      const notes = inferred.candidates > 1
        ? [`建单未指定话题：按活跃总管运行推断，挂到话题「${inferred.title}」（${inferred.candidates} 个总管在跑，无法确定调用方，取最近开始的）`]
        : []
      return { topicId: inferred.topicId, unattended: false, resolvedBy: 'active-run', notes, candidates: inferred.candidates }
    }
    const topics = db.listTopics(userId, profile, { includeArchived: false })
    // Sorted here by last activity: listTopics puts pinned topics first.
    const attended = topics.filter(t => t.chiefSessionId).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
    if (attended) {
      const notes = []
      if (attended.projectId && attended.projectId !== project.id) {
        const owner = db.getProject(userId, profile, attended.projectId)
        notes.push(`卡片挂在话题「${attended.title}」（属于项目 ${owner?.name || attended.projectId}），与建卡项目 ${project.name} 不同`)
      }
      return { topicId: attended.id, unattended: false, resolvedBy: 'chief-topic', notes }
    }
    const shell = topics.find(t => t.projectId === project.id)
      || db.createTopic(userId, profile, { projectId: project.id, title: input.title.slice(0, 32), autopilot: false })
    return { topicId: shell.id, unattended: true, resolvedBy: 'unattended', notes: [] }
  }

  async function createTodo(run, input) {
    const { userId, profile } = run.identity
    const project = db.getProject(userId, profile, input.projectId)
    if (!project) throw new Error(`Project not found: ${input.projectId}`)
    // Checked before a topic is created for the card, so a refused card leaves nothing behind.
    for (const key of ['agentId', 'reviewerId', 'topicId']) assertMaxLength(key, String(input[key] || ''), MAX_AGENT_REF_CHARS)

    const { topicId, unattended, resolvedBy, notes, candidates = 0 } = resolveTodoTopic(run, userId, profile, project, input)

    const todo = db.createTodo(userId, profile, {
      ...input,
      projectId: project.id,
      topicId,
      actor: input.actor || 'user',
    })
    db.watchTodo(userId, profile, topicId, todo.id, 'Created todo')
    for (const note of notes) db.appendTimeline(userId, profile, todo.id, note, 'system')
    if (unattended) {
      // Said in the topic itself, so a topic nobody attends never looks like a normal one.
      const notice = `无人值守话题：#${todo.number} 建单时没有指定话题，也无法从调用方会话确定话题，已挂到本话题。本话题没有总管会话，任务进展只会记录在这里，不会唤醒总管；在这里发一条消息即可让总管接手。`
      db.addTopicMessage(userId, profile, topicId, {
        kind: 'system',
        text: notice,
        todoId: todo.id,
        progressNotice: `无人值守话题：#${todo.number} 挂在本话题，没有总管会话，进展只记录不唤醒`,
      })
      log?.warn?.('Todo created in a topic without a Chief session', { todoId: todo.id, topicId })
    }

    if (input.startImmediately) {
      await startBuild(run, { todoId: todo.id, agentId: todo.agentId, withPlan: Boolean(input.withPlan) })
    } else {
      emitUpdated(run, `todo.created:${todo.id}`)
    }
    // topicCandidates: running Chiefs the active-run guess chose among (0 for every other way of resolving).
    return { todo: db.getTodo(userId, profile, todo.id), state: await getSnapshot(run), topicResolvedBy: resolvedBy, topicCandidates: candidates }
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

  async function startBuild(run, { todoId, agentId, configId, withPlan, extraMessage, fresh = false, forceNewSession = false }) {
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
      return await startBuildInner(run, { userId, profile, todo, agentId, configId, withPlan, extraMessage, fresh, forceNewSession, writeLock })
    } finally {
      startingTodos.delete(todoId)
      dropTodoWriteLock(todoId, writeLock)
      buildSlotReservations.get(`${userId}:${profile}`)?.delete(todoId)
      warnSlowLaunch('worker run', launchStartedAt, { todoId })
    }
  }

  async function startBuildInner(run, { userId, profile, todo, agentId, configId, withPlan, extraMessage, fresh = false, forceNewSession = false, writeLock }) {
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
        `并发槽位已满（${activeCount}/${settings.maxConcurrentBuilds}），已进入排队队列，空出槽位后自动启动`,
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
      // Any new build run invalidates the previous review verdict; merge gates re-check it.
      evidence: {
        reviewVerdict: 'none',
        reviewInconclusiveRetries: 0,
        reviewInconclusiveTurn: '',
        roundBaseSha: roundBase?.headSha || '',
        roundBaseTree: roundBase?.treeSha || '',
        gateSkipped: '',
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

    const prompt = extraMessage
      ? extraMessage
      : buildWorkerPrompt({
          todo: updatedPre,
          project,
          withPlan: effectiveWithPlan,
          memories,
          repoGuidelines,
          linkedDeps: wt.linkedDeps || [],
        })

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
          instructions: assignedAgent.systemPrompt || undefined,
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
      }
    }

    // 0.9.49: same as above for a launch that came back late: session, run id and dispatch line are not written.
    if (!stillOwnsWrite(todo.id, writeLock)) {
      return discardStaleWrite(run, userId, profile, todo.id, '构建派发')
    }

    // 0.9.42: the host refused an instruction because the session already runs a turn. The text never reached
    // the worker: that is a failed delivery, not "already working".
    if (launched?.alreadyRunning && extraMessage) {
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

    if (todo.topicId) {
      db.watchTodo(userId, profile, todo.topicId, todo.id, 'Dispatched build: wake at gate or settlement')
    }
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

    const prompt = buildReviewPrompt({ todo: fresh, project, memories })
    const runOptions = {
      wait: false,
      workspace: fresh.worktreePath || project.repoPath,
      instructions: reviewer.systemPrompt || undefined,
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
      evidence: {
        reviewVerdict: fresh.evidence?.reviewVerdict || 'none',
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
      // 0.9.49 (#47): every review dispatch may ask once for a missing verdict.
      evidence: { reviewVerdict: 'pending', reviewInconclusiveRetries: 0, reviewInconclusiveTurn: '' },
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
    db.appendTimeline(userId, profile, todo.id, `派发独立只读审查至 ${reviewer.name} (${revCfg.engine})`, 'orchestrator')
    if (todo.topicId) db.watchTodo(userId, profile, todo.topicId, todo.id, 'Dispatched independent review')
    emitUpdated(run, `todo.review.started:${todo.id}`)
    return db.getTodo(userId, profile, todo.id)
  }

  // 0.9.46: what a failed build run is recorded and classified with. The text of the host event is used when
  // it names a cause. When it is empty or only the plugin's own fallback wording, the cause is looked up:
  // the error fields of the host session, then the transcript of the turn (no assistant text at all since
  // the last instruction = the model answered with nothing, a switchable model fault). When neither gives
  // anything the run stays an unknown failure whose text names the session and the config that was used.
  async function resolveBuildFailure(run, { sessionId, errorText, failureHint, interrupted, msgRes, hostMsgs, configLabel }) {
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
        const answered = hostMsgs.slice(lastUser + 1).some(m => m.role === 'assistant' && m.content.trim())
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
  async function settleIdleBuild(run, userId, profile, todo, project, { snap, updatedChat, stopped = false }) {
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
        ...(rerunNotStarted ? { idleRetries: retries } : {}),
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
      if (outcome !== 'failed' && sessionId && sessionId === todo.buildSessionId
        && !TODO_QUEUE_HOLD_PHASES.has(todo.phase) && !TODO_QUEUE_DROP_PHASES.has(todo.phase)) {
        const pending = db.listTodoQueue(userId, profile, todo.id)
        if (pending.length) {
          const next = pending[0]
          db.removeTodoQueueItem(userId, profile, todo.id, next.id)
          db.appendTimeline(userId, profile, todo.id,
            `本轮已结束，送达排队的指令${pending.length > 1 ? `（之后还有 ${pending.length - 1} 条）` : ''}`, 'orchestrator')
          settlingTodos.delete(todoId)
          try {
            return await startBuild(run, { todoId: todo.id, withPlan: false, extraMessage: next.text })
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
      const hostMsgs = msgRes ? normalizeHostMessages(msgRes) : []
      const lastAssistantOf = msgs => [...msgs].reverse().find(m => m.role === 'assistant' && m.content.trim())
      let lastAssistant = lastAssistantOf(hostMsgs)
      let workerOutput = lastAssistant?.content?.trim() || ''

      const chatOf = msgs => (msgs.length
        ? msgs.slice(-24).map(m => ({
            role: m.role === 'assistant' ? (todo.phase === 'reviewing' ? '审查 Agent' : '开发 Agent') : '任务指令',
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
        const turnKey = String(lastAssistant?.id || '')
        if (verdict === 'inconclusive' && !stopped && turnKey && todo.evidence?.reviewInconclusiveTurn === turnKey) {
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
              instructions: reviewer?.systemPrompt || undefined,
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
          evidence: { reviewVerdict: verdict, reviewSummary: workerOutput.slice(0, 1200) },
          lastError: failedReviewText,
        })
        if (verdict === 'review_failed') {
          db.appendTimeline(userId, profile, todo.id, `审查运行失败：${clipWorkerError(failedReviewText)}（没有审查结论，需要人工判断或重派审查）`, 'system')
        } else if (verdict === 'inconclusive') {
          db.appendTimeline(userId, profile, todo.id, inconclusiveLine, 'system')
        } else {
          db.appendTimeline(userId, profile, todo.id, `独立审查结论：${verdict === 'approved' ? '通过' : '需修改'}`, 'reviewer')
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
        const failure = await resolveBuildFailure(run, { sessionId, errorText, failureHint, interrupted, msgRes, hostMsgs, configLabel })
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
      if (outcome !== 'failed' && !todo.withPlan) {
        const roundBaseSha = String(todo.evidence?.roundBaseSha || '')
        const roundBaseTree = String(todo.evidence?.roundBaseTree || '')
        if (!snap) {
          db.appendTimeline(userId, profile, todo.id, '取不到工作树快照，跳过产出校验', 'orchestrator')
          if (project.testCommand) gateSkippedWhy = 'no-snapshot'
        } else if (!roundBaseSha || !roundBaseTree || !snap.headSha || !snap.worktreeTreeSha) {
          db.appendTimeline(userId, profile, todo.id, '本轮没有可用的开工基线，跳过产出校验', 'orchestrator')
        } else if (snap.headSha === roundBaseSha && snap.worktreeTreeSha === roundBaseTree) {
          return await settleIdleBuild(run, userId, profile, todo, project, { snap, updatedChat, stopped })
        }
      }

      let testGate = null
      if (outcome !== 'failed' && !todo.withPlan && snap && todo.worktreePath && project.testCommand) {
        testGate = await runDeterministicTestGate({
          cwd: todo.worktreePath,
          command: project.testCommand,
          timeoutMs: testGateTimeoutMs,
        })
        if (settleSuperseded(userId, profile, todo)) return dropSettle()
      }

      const evidencePatch = {
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
      }

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
          evidence: evidencePatch,
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
        evidence: evidencePatch,
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

  async function maybeWakeChief(run, userId, profile, todo, project, reason, { skipRun = false } = {}) {
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
        const recentDigest = db.getRecentTodoUpdatesSince(userId, profile, topic.lastDigestAt)
        const wakePrompt = buildAutomatedWakePrompt({ topic, todo, project, reason, recentDigest })
        if (isTopicCompressing(topic.id)) {
          // 0.9.43: compression in progress: keep the wake for later without marking the topic as running.
          db.enqueueTopicItem(userId, profile, topic.id, { kind: 'wake', text: wakePrompt })
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
          db.enqueueTopicItem(userId, profile, topic.id, { kind: 'wake', text: wakePrompt })
          emitUpdated(run, `chief.wake.queued:${topic.id}`)
          continue
        }

        try {
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
            lastDigestAt: now,
          })
        } catch (err) {
          // Keep the wake instead of dropping it: the queue drain retries it with bounded back-off.
          db.enqueueTopicItem(userId, profile, topic.id, { kind: 'wake', text: wakePrompt })
          log?.warn?.('Chief auto-wake failed, queued for retry', { topicId: topic.id, error: err.message })
        }
      }
    }
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

    if (todo.topicId) {
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
    const result = await withinBudget(work, budgetMs)
    if (result === null) {
      db.appendTimeline(userId, profile, todoId, pendingNote, 'orchestrator')
      emitUpdated(run, `todo.message.accepted:${todoId}`)
      emitUpdated(run, `todo.launch.pending:${todoId}`)
      void work.then(() => emitUpdated(run, `todo.launch.settled:${todoId}`))
      return { ...db.getTodo(userId, profile, todoId), launchPending: true }
    }
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
    return startBuildBudgeted(run, { todoId: todo.id, withPlan: false, extraMessage: prompt }, budget, {
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
    if (todo.topicId && !resumed.duplicate) {
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

  async function messageTodo(run, { todoId, note }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    const text = String(note || '').trim()
    if (!text) throw new Error('Follow-up message is required')
    return dispatchInstruction(run, todo, {
      kind: 'message',
      text,
      label: '补充指令',
      prompt: text,
      pendingNote: '补充指令已接受，正在后台启动（宿主尚未确认）',
      record: () => db.appendTimeline(userId, profile, todo.id, '发送补充指令', 'user'),
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
    if (caller !== 'chief') return
    const topic = todo.topicId ? db.getTopic(userId, profile, todo.topicId) : null
    const verdict = todo.evidence?.reviewVerdict || 'none'
    const testRc = Number(todo.evidence?.testRc ?? -1)
    const reasons = []
    if (todo.kind === 'deploy' && project.autopilot.requireHumanForDeploy !== false) reasons.push('部署类任务必须由用户放行')
    if (!topic?.autopilot) reasons.push('所在话题未开启 AUTO')
    if (!project.autopilot.autoMergeAfterReview) reasons.push(`项目 ${project.name} 未允许审查通过后由总管合并`)
    if (verdict !== 'approved') reasons.push(`独立审查结论为「${verdict}」，需先 run_review 且结论为 APPROVED`)
    if (project.testCommand && testRc !== 0) reasons.push(`验收命令未通过（rc=${testRc}）`)
    if (todo.question?.active) reasons.push('存在未答复的用户问题')
    if (reasons.length) {
      throw new Error(`拒绝合并 #${todo.number}：${reasons.join('；')}。请总结结果交给用户在看板上确认合并。`)
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

    const executeMerge = async () => {
      try {
        let mergedSha = todo.snapshotSha || todo.evidence.commitSha || ''
        if (todo.branch && todo.worktreePath) {
          const merged = await mergeWorktreeBranch({
            repoPath: project.repoPath,
            worktreePath: todo.worktreePath,
            branchName: todo.branch,
            baseBranch: project.defaultBranch,
            commitMessage: commitMessage || `feat(ekko-todo): #${todo.number} ${todo.title}`,
          })
          mergedSha = merged.mergedSha
        }
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
          evidence: { commitSha: mergedSha },
          lastError: '',
        })
        db.appendTimeline(userId, profile, todo.id, `已合并至 ${project.defaultBranch}（${mergedSha}）`, caller === 'chief' ? 'chief' : 'user')
        const settled = db.getTodo(userId, profile, todo.id)
        emitUpdated(run, `todo.merged:${todo.id}`)
        // Never block merge or self-wake Chief when Chief itself called merge_build (prevents 120s timeout & duplicate wakes)
        void maybeWakeChief(run, userId, profile, settled, project, 'merged', { skipRun: caller === 'chief' }).catch(() => {})
        return settled
      } catch (err) {
        const errText = err?.message || String(err)
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
        const conflictFiles = extractConflictFiles(errText)
        const failText = `合并失败（${conflictFiles.length ? `冲突文件：${conflictFiles.join('、')}；` : ''}处理后可调用 retry_merge 回到合并关口，审查结论保留）：${errText}`
        db.updateTodo(userId, profile, todo.id, {
          phase: failPhase,
          gateOwner: 'human',
          gateKind: 'failed',
          lastError: failText,
        })
        db.appendTimeline(userId, profile, todo.id, failText, 'system')
        emitUpdated(run, `todo.merge_failed:${todo.id}`)
        throw err
      } finally {
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
  async function cancelBuild(run, { todoId, discard = false }) {
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
        await run.host.sessions.stop(todo.buildSessionId).catch(() => {})
        sessionActivity.delete(todo.buildSessionId)
      }
      if (todo.reviewSessionId) {
        await run.host.sessions.stop(todo.reviewSessionId).catch(() => {})
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
      })
      db.appendTimeline(userId, profile, todo.id, discard ? '已停止构建并清理工作树' : '已停止当前运行', 'user')
      // 0.9.49: what waited for the stopped turn is dropped now, with the reason on the card, instead of being
      // delivered (and starting the card again) when the host reports the stop. Nothing queued: no line.
      dropTodoQueue(run, userId, profile, todo.id, '任务已停止')
      emitUpdated(run, `todo.cancelled:${todo.id}`)
      void drainQueuedTodos(run, userId, profile).catch(() => {})
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

  async function completeTodo(run, { todoId }) {
    const { userId, profile } = run.identity
    const todo = db.getTodo(userId, profile, todoId)
    if (!todo) throw new Error(`Todo not found: ${todoId}`)
    // 0.9.48: same guard as delete, and one write at a time per card. A refusal changes nothing on the card.
    if (todo.phase === 'merging' || mergingTodos.has(todo.id)) {
      throw new Error('任务正在合并，完成后再操作')
    }
    const writeLock = lockTodoForWrite(run, todo, '标记完成', '标记完成没有执行')
    try {
      const nextPhase = transitionTodoPhase(todo.phase, 'COMPLETE')
      db.updateTodo(userId, profile, todo.id, { phase: nextPhase, gateOwner: 'none', gateKind: 'none' })
      db.appendTimeline(userId, profile, todo.id, '标记完成', 'user')
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
      await releaseCleanWorktree(run, userId, profile, todo.id, writeLock)
      emitUpdated(run, `todo.closed:${todo.id}`)
      if (wasRunning) void drainQueuedTodos(run, userId, profile).catch(() => {})
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
      void drainQueuedTodos(run, userId, profile).catch(() => {})
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
        if (type === 'chat.tool.started') {
          const settings = db.getSettings(matchedTopic.userId, matchedTopic.profile, config)
          if (settings.chiefStrictOrchestration !== false) {
            const lowerTool = toolName.toLowerCase()
            let rawArgs = JSON.stringify(data.arguments || data.args || payload.arguments || '')
            if (rawArgs.length <= 2) rawArgs = await readLatestToolCallArgs(run, sessionId)
            const projects = db.listProjects(matchedTopic.userId, matchedTopic.profile)
            const hitsProjectPath = projects.some(p => p.repoPath && rawArgs.includes(p.repoPath))
            // File writes count only when the target path is inside a project repo (main worktree). Scratch
            // files, deploy scripts and evidence written elsewhere are not code mutations.
            const writePaths = []
            try {
              const parsed = JSON.parse(rawArgs)
              const obj = typeof parsed === 'string' ? JSON.parse(parsed) : parsed
              for (const k of ['path', 'file_path', 'filePath', 'target', 'filename']) {
                if (obj && typeof obj[k] === 'string') writePaths.push(obj[k])
              }
            } catch {}
            const home = homedir()
            const expand = p => (p.startsWith('~/') ? join(home, p.slice(2)) : p)
            const inRepo = p => projects.some(pr => pr.repoPath && (expand(p) === pr.repoPath || expand(p).startsWith(`${pr.repoPath}/`)))
            const isMutatingCodeTool = /^(write_file|patch|edit|edit_file|apply_patch|multi_edit)$/.test(lowerTool)
              && (writePaths.length ? writePaths.some(inRepo) : hitsProjectPath)
            // Running tests / gates for verification is read-only and allowed; only flag real mutations.
            const isMutatingRepoShell = /^(terminal|bash|shell|exec)$/.test(lowerTool)
              && hitsProjectPath
              && /\b(git\s+(commit|push|checkout|merge|rebase|reset|branch\s+-[dD])|rm\s|mv\s|sed\s+-i|npm\s+run\s+build)/i.test(rawArgs)
            if (isMutatingCodeTool || isMutatingRepoShell) {
              const guardKey = `${sessionId}:${prev.startedAt || now}`
              if (!chiefViolationTurnGuard.has(guardKey)) {
                chiefViolationTurnGuard.add(guardKey)
                const warnMsg = `⚠️ 治理约束告警：大总管尝试直接调用 ${toolName} 操作项目代码/仓库；具体执行应建单派给专属 Agent 在隔离 Worktree 完成。`
                db.addTopicMessage(matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId, {
                  kind: 'system',
                  text: warnMsg,
                  progressNotice: warnMsg,
                })
                emitUpdated(run, `chief.violation:${matchedTopic.topicId}`)
              }
            }
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
          if (type === 'chat.run.completed' && await chiefTurnEndedWithoutReply(run, sessionId)) {
            const model = String(data.model || payload.model || '')
            const msg = `${CHIEF_EMPTY_REPLY_PREFIX}${model ? `（${model}）` : ''}，本轮没有结论。可发「继续」重试，或在设置里换总管模型。`
            db.addTopicMessage(matchedTopic.userId, matchedTopic.profile, matchedTopic.topicId, { kind: 'system', text: msg, progressNotice: msg })
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
      const topic = seen.topicId ? db.getTopic(userId, profile, seen.topicId) : null
      const project = db.getProject(userId, profile, seen.projectId)
      const note = '上次派发审查时服务中断或启动一直没有返回，卡片上没有这一轮审查的运行记录，已回到待合并关口，可重新派发审查。'
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
        evidence: { reviewVerdict: 'none', reviewSummary: '' },
        lastError: note,
      })
      db.appendTimeline(userId, profile, todoId, '检测到未启动的审查（没有运行记录），已自动回到待合并关口，审查结论清空', 'system')
      sessionActivity.delete(seen.reviewSessionId)
      emitUpdated(run, `todo.review.unlaunched_healed:${todoId}`)
      return true
    } finally {
      dropTodoWriteLock(todoId, writeLock)
    }
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

    for (const td of activeTodos) {
      if (td.profile !== run.identity.profile) continue
      const todo = db.getTodo(td.user_id, td.profile, td.id)
      if (!todo) continue
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
        }
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
      }
    }

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
    const todos = db.listTodos(userId, profile, project.id)
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
      const snap = await probeSingleQuotaProvider(raw)
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
        const snap = await probeSingleQuotaProvider(raw)
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
          const snap = await probeSingleQuotaProvider(raw)
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
    startBuild,
    runIndependentReview,
    settleWorkerRun,
    askUserQuestion,
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
    handleHostEvent,
    reconcileActiveRuns,
    settlePendingTopics,
    dispose() { pendingSettles.clear() },
  }
}

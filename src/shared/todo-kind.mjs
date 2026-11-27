/**
 * Task kinds that do not require a commit. Research / investigation / decision memos ('question') and
 * written content ('content') deliver text: the worker's final reply is the result. A round of such a card
 * that leaves the worktree untouched is not "idle" when that reply is there.
 *
 * No imports: bundled into both dist/server.mjs and dist/client.mjs.
 */
export const NO_CODE_KINDS = new Set(['question', 'content'])

export function isNoCodeKind(kind) {
  return NO_CODE_KINDS.has(String(kind || ''))
}

/** Replies this short are a status line ("好的" / "Done."), not a report. */
export const MIN_DELIVERABLE_CHARS = 40
/** Stored on the card and sent to the Chief; the full text stays in the build conversation. */
export const MAX_DELIVERABLE_CHARS = 20000

export function hasTextDeliverable(text) {
  return String(text || '').replace(/\s+/g, '').length >= MIN_DELIVERABLE_CHARS
}

// 0.9.66: a reply that reports findings is not an announcement. It is long enough, carries evidence (a code
// span, a commit id, an exit code) and does not end by promising the next step. Such a round without a commit
// goes to acceptance instead of being nudged to commit something (a worker asked a question was nudged to
// "commit anything, even incomplete" three times and then failed).
export const MIN_REPORT_CHARS = 200
const REPORT_EVIDENCE = /`[^`\n]+`|```|\b[0-9a-f]{7,40}\b|\b(?:rc|exit(?:\s*code)?|GATE_RC)\s*[=:]\s*-?\d|退出码/i
const ENDS_WITH_INTENT = /(接下来|下一步|我会|我将|我先|让我|将去|然后|稍后|马上|即将|现在开始|准备|开始(?:修改|动手|实现)|let me|i(?:'ll| will)|next,? i)[^。.!！]{0,60}[。.!！…：:]?\s*$/i

/** #104: true when the reply ends by announcing the next step (its last 120 characters). */
export function endsWithIntent(text) {
  return ENDS_WITH_INTENT.test(String(text || '').trim().slice(-120))
}

export function isSubstantiveReport(text, toolCalls = 0) {
  const t = String(text || '').trim()
  if (Number(toolCalls) < 1) return false
  if (t.replace(/\s+/g, '').length < MIN_REPORT_CHARS) return false
  if (!REPORT_EVIDENCE.test(t)) return false
  return !endsWithIntent(t)
}

/** Kind for a card created without one: research-style titles become 'question', everything else 'feature'. */
const RESEARCH_TITLE = /调研|研究|评估|选型|可行性|对比分析|竞品|摸底|\bresearch\b|\binvestigat|\bsurvey\b|\bevaluat/i

export function inferTodoKind(title) {
  return RESEARCH_TITLE.test(String(title || '')) ? 'question' : 'feature'
}

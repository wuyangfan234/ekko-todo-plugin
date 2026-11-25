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

/** Kind for a card created without one: research-style titles become 'question', everything else 'feature'. */
const RESEARCH_TITLE = /调研|研究|评估|选型|可行性|对比分析|竞品|摸底|\bresearch\b|\binvestigat|\bsurvey\b|\bevaluat/i

export function inferTodoKind(title) {
  return RESEARCH_TITLE.test(String(title || '')) ? 'question' : 'feature'
}

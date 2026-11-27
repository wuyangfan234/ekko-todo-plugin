/**
 * #104: when the last reply of a round that changed no file counts as the card's deliverable.
 *
 * Until #104 the only test was length (40 non-space characters, `hasTextDeliverable`): a research card that
 * ended with "接下来我去读代码" went to acceptance, and a deploy card wrote 「部署已执行」 on its timeline
 * without anything having been run. Length is still required, but no longer decides alone.
 *
 * The rules, in the order they are checked (also in docs/CONTRACTS.md):
 *   1. too_short        fewer than MIN_DELIVERABLE_CHARS non-space characters.
 *   2. intent_tail      the reply ends by announcing the next step (`endsWithIntent`, shared with
 *                       isSubstantiveReport), unless the closing clause of the last sentence states a result
 *                       or advises the reader and the sentence holds no plan of the worker's own.
 *   3. no_evidence      kind question / deploy: no tool call in the round and no concrete reference in the
 *                       text (code span or block, file path, URL, commit id, exit code). Not asked of
 *                       kind content: written copy is prose.
 *   4. no_deploy_proof  kind deploy only: no command output (fenced block or `$ cmd` line), and no clause that
 *                       reports an HTTP status, exit code or check result as done (a clause about what is
 *                       still to come or conditional does not count); or the report says nothing was run.
 */
import { MIN_DELIVERABLE_CHARS, endsWithIntent } from '../shared/todo-kind.mjs'

// A last sentence that reports a result or hands the next step to the reader is not the worker's own plan:
// "建议下一步由用户确认方案 A。" / "先构建然后重启，服务返回 HTTP 200。".
// Each mark is tested on one small clause (see statesResultOrAdvice), never across the whole sentence.
// The closing clause opens with advice to the reader (an optional connective first).
const ADVICE_LEAD = /^(?:因此|所以|综上|故|最后|然后|下一步|接下来|后续)?[\s：:]*(?:建议|推荐|请(?:你|您|用户|总管|确认|决定|验收|查看)|由(?:你|您|用户|总管)|待(?:你|您|用户|总管)?(?:确认|拍板|决定|验收))/
// The closing clause states something done or measured.
const RESULT_MARK = /已(?:经)?(?:完成|部署|上线|发布|合并|修复|验证|通过|生效)|HTTP(?:\/[\d.]+)?\s*[:：=]?\s*[1-5]\d\d|返回\s*[1-5]\d\d\b|\b(?:rc|exit(?:\s*code)?|GATE_RC)\s*[=:]\s*-?\d|退出码/i
// The worker's own next step, anywhere in the sentence: no result or advice mark excuses it.
const OWN_PLAN = /我(?:将|会|先|去|来|再|准备|打算|马上|接着)|让我|将去|\bI(?:'ll| will| am going to)\b|\blet me\b|\bgoing to\b/i
// Future words that, anywhere in the sentence, keep a result mark from making it a conclusion.
const FUTURE_WORD = /接下来|下一步|稍后|随后|马上|即将|将要|将会|准备|打算|再去|现在开始|开始(?:修改|动手|实现)|\bwill\b/i

const CODE_REFERENCE = /`[^`\n]+`|```/
const FILE_REFERENCE = /(?:[\w.@~-]+\/){2,}[\w.@-]+|(?:[\w.@~-]+\/)+[\w@-]+\.\w{1,6}\b|[\w@-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|py|sh|ya?ml|toml|sql|css|html|go|rs|java|kt|swift|vue|txt|log|conf|env|lock)(?::\d+)?\b/
const URL_REFERENCE = /https?:\/\/[^\s)）]+/i
const COMMIT_OR_EXIT = /\b[0-9a-f]{7,40}\b|\b(?:rc|exit(?:\s*code)?|GATE_RC)\s*[=:]\s*-?\d|退出码/i

// What shows that a deployment was carried out and checked, not only described.
// A fenced block with content, or a shell prompt line (`$ cmd`). `#` and `>` are not prompts here: they are
// Markdown headings and quotes, and a plan under a heading passed as a deployment (review of #104).
const COMMAND_OUTPUT = /```[\s\S]*?\S[\s\S]*?```|^\s*\$\s+\S+/m
// The report itself says nothing was run: no block or status in it is the output of this deployment.
const NOT_EXECUTED = /(?:尚未|还没有?|暂未)(?:真正|实际)?(?:执行|部署|上线|动手|发布|运行)|\bnot\s+(?:yet\s+)?(?:been\s+)?(?:deployed|executed|run|applied)\b|\bhaven'?t\s+(?:yet\s+)?(?:deployed|run|executed)\b/i
// A clause that speaks of what is still to come or of a condition: "等健康检查通过再切流量即可" names a check,
// not its result. Tested per small clause, so "部署后健康检查通过，待你验收" keeps its first clause.
const NOT_YET = /(?:^|[要需先得须])\s*等(?![于等级])|等[^，,。]*?(?:再|才|后)|等待|有待|待(?:你|您|用户|总管|确认|验证|校验|检查|部署|上线|执行|健康|冒烟)|后(?:再|才|即可|就可以)|如果|假如|倘若|一旦|若(?!干)|(?<!不)需要|需(?=先|等|再)|应该|应当|即将|将要|将会|将在|将于|才会|就会|我会|我将|稍后|随后|接下来|下一步|准备|打算|计划|即可|才能|方可|尚未|还没|暂未|\b(?:should|will|would|once|until|if|pending|tbd)\b|\bneeds?\s+to\b|\bgoing\s+to\b|\bto\s+be\b/i
const HTTP_STATUS = /\bHTTP(?:\/[\d.]+)?\s*[:：=]?\s*[1-5]\d\d\b|(?:状态码|status(?:\s*code)?|http_code)\s*[:：=]?\s*[1-5]\d\d\b|\b[1-5]\d\d\s+(?:OK|Created|Accepted|No Content|Moved|Found|Not Modified|Bad Request|Unauthorized|Forbidden|Not Found|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i
// "curl http://host/ 返回 200" / "returned 200": a status code named as what a request answered.
const REQUEST_ANSWER = /(?:返回|响应|回了|returns?|returned|responded(?:\s+with)?|->|=>|→)\s*(?:了|码|状态)?\s*[:：]?\s*(?:HTTP\s*)?[1-5]\d\d\b/i
const EXIT_CODE = /\b(?:rc|exit(?:\s*code)?|GATE_RC)\s*[=:]\s*-?\d|退出码\s*[:：=]?\s*-?\d/i
const CHECK_RESULT = /(?:健康检查|health\s*check|冒烟|smoke|探活|回读|部署后[^。\n]{0,8}(?:校验|验证|检查)|线上[^。\n]{0,8}(?:校验|验证|检查)|校验|验证)[^。\n]{0,40}(?:通过|成功|正常|一致|未通过|失败|异常|不一致|\bok\b|\bpass(?:ed)?\b|\bfail(?:ed)?\b)/i

const HINTS = {
  too_short: '回复太短，只是一句状态，不是成果',
  intent_tail: '回复以「接下来 / 我先 / 让我…」这类打算句结尾，说的是还没做的事',
  no_evidence: '本轮没有任何工具调用，回复里也没有引用具体文件、命令输出或来源，无法核对',
  no_deploy_proof: '部署报告里没有命令输出片段、HTTP 状态码或明确的部署后校验结果，缺少部署确实发生的证据',
}

// The last sentence of the reply: what follows the last 。！!？? or line break before the end.
function lastSentence(text) {
  const t = String(text || '').trim().replace(/[。！!？?…\s]+$/, '')
  const cut = Math.max(t.lastIndexOf('。'), t.lastIndexOf('！'), t.lastIndexOf('!'), t.lastIndexOf('？'), t.lastIndexOf('?'), t.lastIndexOf('\n'))
  return t.slice(cut + 1)
}

// Small clauses: cut at commas and semicolons too, not only at sentence ends.
function clauses(text) {
  return String(text || '').split(/[。！!？?\n，,；;]+/).map(part => part.trim()).filter(Boolean)
}

const MEASURED = [HTTP_STATUS, REQUEST_ANSWER, EXIT_CODE, CHECK_RESULT]

// Whether the last sentence, although it trips `endsWithIntent`, reports a result or hands the next step to
// the reader. Looked at per small clause: only the closing clause can make it so, and never when the
// sentence states the worker's own plan. (The first version tested the whole sentence, so "初步分析已完成，
// 接下来我将去读 X" passed on 已完成.)
function statesResultOrAdvice(sentence) {
  if (OWN_PLAN.test(sentence)) return false
  const parts = clauses(sentence)
  const tail = parts[parts.length - 1] || ''
  if (ADVICE_LEAD.test(tail)) return true
  return RESULT_MARK.test(tail) && !FUTURE_WORD.test(sentence)
}

export function hasConcreteReference(text) {
  const t = String(text || '')
  return CODE_REFERENCE.test(t) || FILE_REFERENCE.test(t) || URL_REFERENCE.test(t) || COMMIT_OR_EXIT.test(t)
}

export function hasDeployProof(text) {
  const t = String(text || '')
  if (NOT_EXECUTED.test(t)) return false
  if (COMMAND_OUTPUT.test(t)) return true
  // A status code, an exit code or a check result counts in the clause that states it, and only when that
  // clause reports it as done.
  return clauses(t).some(c => MEASURED.some(re => re.test(c)) && !NOT_YET.test(c))
}

/**
 * @param {{ text: string, kind?: string, toolCalls?: number }} input the last reply of the round, the card's
 *   kind and the tool calls the host counted in the round.
 * @returns {{ ok: boolean, reason: ''|'too_short'|'intent_tail'|'no_evidence'|'no_deploy_proof', hint: string }}
 *   `hint` is the Chinese sentence written on the card and sent to the worker; '' when ok.
 */
export function judgeTextDeliverable({ text, kind = '', toolCalls = 0 } = {}) {
  const t = String(text || '').trim()
  const fail = reason => ({ ok: false, reason, hint: HINTS[reason] })
  if (t.replace(/\s+/g, '').length < MIN_DELIVERABLE_CHARS) return fail('too_short')
  if (endsWithIntent(t) && !statesResultOrAdvice(lastSentence(t))) return fail('intent_tail')
  if (kind !== 'content' && Number(toolCalls) < 1 && !hasConcreteReference(t)) return fail('no_evidence')
  if (kind === 'deploy' && !hasDeployProof(t)) return fail('no_deploy_proof')
  return { ok: true, reason: '', hint: '' }
}

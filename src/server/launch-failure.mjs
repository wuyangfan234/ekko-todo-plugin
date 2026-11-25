// Turns the raw error the host returns when a Chief run cannot start into a sentence a first-time
// user can act on. The host usually answers with a JSON envelope such as
// {"ok":false,"status":"failed","event":"run.failed","error":"…","session_id":"…","output":""};
// showing that verbatim tells a new user nothing about what to do next.

const MAX_HOST_TEXT = 300

// Only failures that were actually observed on a host are mapped to advice. Anything else keeps the
// host's own wording, so an unknown error is never replaced by a guess.
const KNOWN_FAILURES = [
  {
    // Fresh Studio without a usable runtime for the engine the Chief is set to.
    pattern: /runtime is unavailable|runtime is not installed|not installed or is incomplete/i,
    advice: '大总管没有启动：Studio 里这个引擎的运行时还没有装好。请在 Studio 的「Agent 管理」里安装或修复它，或者在本插件的「Agent」页把大总管换成一个已就绪的引擎，然后重新发送。',
  },
]

function unwrapHostEnvelope(text) {
  const start = text.indexOf('{')
  if (start < 0) return text
  try {
    const parsed = JSON.parse(text.slice(start))
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim()
    }
  } catch {
    // Not a JSON envelope; keep the original text.
  }
  return text
}

/**
 * @param {unknown} raw Error text as thrown by the host (`err.message`).
 * @returns {string} Text safe to store in `lastError` and to show in the chat banner and toast.
 */
export function readableLaunchFailure(raw) {
  const original = String(raw ?? '').trim()
  if (!original) return '大总管没有启动，Studio 没有给出原因。请稍后重试。'
  const hostText = unwrapHostEnvelope(original)
  const clipped = hostText.length > MAX_HOST_TEXT ? `${hostText.slice(0, MAX_HOST_TEXT)}…` : hostText
  const known = KNOWN_FAILURES.find(item => item.pattern.test(hostText))
  return known ? `${known.advice}（Studio 原文：${clipped}）` : clipped
}

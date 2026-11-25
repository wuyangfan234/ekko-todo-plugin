/**
 * Zero-latency automatic topic title generator.
 * Uses Ekko Studio's `host.models.respond()` asynchronously with clean fallback distillation.
 */

export function distillProvisionalTitle(rawText, maxLen = 18) {
  const firstLine = String(rawText || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*`~\[\]()]/g, ' ')
    .split(/\r?\n/)
    .map(s => s.trim())
    .find(Boolean) || ''

  const clean = firstLine
    .replace(/^(请帮我|能不能帮我|麻烦帮我|请帮忙|帮我|帮忙|请|麻烦|我想|能不能|可以)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!clean) return '新话题'
  const sentence = clean.split(/[。！？!?;；，,]/)[0]?.trim() || clean
  const chars = [...sentence]
  if (chars.length <= maxLen) return sentence
  return chars.slice(0, maxLen).join('').trim()
}

function sanitizeGeneratedTitle(raw) {
  let text = String(raw || '').trim()
  if (!text) return ''
  // Take first non-empty line and strip quotes/markdown/trailing punctuation
  text = text
    .split(/\r?\n/)
    .map(s => s.trim())
    .find(Boolean) || ''
  text = text
    .replace(/^["'“”‘’《》【】「」`\-\*\d\.\s]+/, '')
    .replace(/["'“”‘’《》【】「」`。.!！?？:：;；\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...text]
  if (chars.length < 2) return ''
  if (chars.length > 26) return chars.slice(0, 26).join('').trim()
  return text
}

function extractResponseText(res) {
  if (!res || typeof res !== 'object') return ''
  if (typeof res.output_text === 'string' && res.output_text.trim()) return res.output_text
  if (typeof res.text === 'string' && res.text.trim()) return res.text
  if (Array.isArray(res.output)) {
    const parts = []
    for (const item of res.output) {
      if (typeof item === 'string') parts.push(item)
      else if (typeof item?.text === 'string') parts.push(item.text)
      else if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (typeof c?.text === 'string') parts.push(c.text)
          else if (typeof c?.output_text === 'string') parts.push(c.output_text)
        }
      }
    }
    return parts.join('\n')
  }
  return ''
}

async function resolveFastTitleModel(run, preferredModel, preferredProvider) {
  if (preferredModel) {
    if (preferredModel.includes('/')) return preferredModel
    if (preferredProvider) {
      const cleanProv = preferredProvider.replace(/^custom:/, '')
      return `${cleanProv}/${preferredModel}`
    }
    return preferredModel
  }
  try {
    const listed = await run?.host?.models?.list?.()
    const data = Array.isArray(listed?.data) ? listed.data : []
    if (!data.length) return ''
    // Prefer fast / flash / mini / haiku models for instant title generation
    const fast = data.find(m => /flash|mini|haiku|fast/i.test(String(m.id || '')))
    return String(fast?.id || data[0]?.id || '')
  } catch {
    return ''
  }
}

export async function generateTopicTitleWithModel(run, { userText, preferredModel = '', preferredProvider = '', timeoutMs = 8000 } = {}) {
  const provisional = distillProvisionalTitle(userText)
  if (!run?.host?.models?.respond) {
    return { title: provisional, generatedByModel: false }
  }
  const modelId = await resolveFastTitleModel(run, preferredModel, preferredProvider)
  if (!modelId) {
    return { title: provisional, generatedByModel: false }
  }

  const prompt = [
    'Generate a concise, concrete topic title (4-14 Chinese characters or 2-5 English words) summarizing the user request below.',
    'Rules: Match the user language. Return ONLY the plain title text with NO quotes, NO prefix, NO markdown, and NO trailing punctuation.',
    '',
    `User request: ${String(userText || '').slice(0, 600)}`,
  ].join('\n')

  try {
    const res = await Promise.race([
      run.host.models.respond({
        model: modelId,
        input: prompt,
        max_output_tokens: 48,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('title timeout')), timeoutMs)),
    ])
    const generated = sanitizeGeneratedTitle(extractResponseText(res))
    if (generated) {
      return { title: generated, generatedByModel: true, modelId }
    }
  } catch {
    // Graceful fallback to provisional title
  }
  return { title: provisional, generatedByModel: false }
}

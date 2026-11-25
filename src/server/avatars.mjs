import { randomBytes } from 'node:crypto'

/**
 * Avatar specification, Notion-style humanized portrait seed validation,
 * and strict server-side upload validation for both Agent and Project avatars.
 *
 * Security & portability rules:
 * - Built-in avatars use deterministic alphanumeric seeds (`notion:<seed>`) rendered
 *   purely client-side via bundled vector portraits (millions of unique combinations,
 *   zero external network calls, zero user-supplied SVG).
 * - Legacy `preset:*` IDs remain accepted for backwards compatibility and render as
 *   humanized Notion portraits on the client.
 * - Custom user uploads allow ONLY sanitized raster data URLs (`png`, `jpeg`, `webp`)
 *   capped at 128 KB serialized (clients auto-crop & compress <= 2 MB input to 128x128).
 * - Raw user SVG uploads are strictly rejected to eliminate XSS vectors.
 */

export const AGENT_AVATAR_PRESETS = Object.freeze([
  'preset:chief-compass',
  'preset:dev-terminal',
  'preset:reviewer-shield',
  'preset:qa-flask',
  'preset:media-spark',
  'preset:editor-quill',
  'preset:analyst-chart',
  'preset:designer-palette',
  'preset:researcher-owl',
  'preset:assistant-bot',
])

const PRESET_SET = new Set(AGENT_AVATAR_PRESETS)

export const NOTION_AVATAR_RE = /^notion:[a-zA-Z0-9_-]{2,48}$/

export const PASTEL_AVATAR_BACKGROUNDS = Object.freeze([
  'b8f2d6', // 薄荷绿
  'dfd3ff', // 淡薰衣草紫
  'd9f49c', // 浅青绿
  'bde0fe', // 浅天蓝
  'ffd6e7', // 浅樱花粉
  'bbf0f3', // 浅冰青蓝
  'ffe7b8', // 奶油杏黄
  'd8f3dc', // 嫩芽绿
])

export const PROJECT_ACCENTS = Object.freeze([
  'blue',
  'amber',
  'emerald',
  'violet',
  'rose',
  'teal',
])

export const AVATAR_UPLOAD_SPEC = Object.freeze({
  allowedMimes: ['image/png', 'image/jpeg', 'image/webp'],
  maxInputBytes: 2 * 1024 * 1024,
  targetSizePx: 128,
  maxDataUrlBytes: 131072,
})

const RASTER_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/

export function generateRandomNotionAvatar(prefix = 'u') {
  const safePrefix = String(prefix || 'u').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'u'
  const token = randomBytes(5).toString('hex')
  return `notion:${safePrefix}-${token}`
}

export function defaultAvatarForRole(role, { randomize = false, seedHint = '' } = {}) {
  const cleanRole = String(role || 'custom').toLowerCase().replace(/[^a-z0-9]/g, '') || 'custom'
  if (randomize) return generateRandomNotionAvatar(cleanRole)
  const cleanHint = String(seedHint || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
  if (cleanHint) return `notion:${cleanRole}-${cleanHint}`
  switch (cleanRole) {
    case 'chief': return 'notion:chief-orbit-01'
    case 'builder': return 'notion:builder-craft-02'
    case 'reviewer': return 'notion:reviewer-lens-03'
    case 'qa': return 'notion:qa-spark-04'
    default: return generateRandomNotionAvatar(cleanRole)
  }
}

export function defaultRoleLabelForRole(role) {
  switch (String(role || '').toLowerCase()) {
    case 'chief': return '总管编排'
    case 'builder': return '开发执行'
    case 'reviewer': return '代码审查'
    case 'qa': return '测试验证'
    default: return '自定义协作者'
  }
}

/**
 * Validates and normalizes an avatar value (empty string, `notion:<seed>`,
 * legacy `preset:<id>`, or raster data URL).
 * Throws an explicit user-facing Chinese error if the avatar violates upload policy.
 */
export function validateAvatarValue(raw, { allowPreset = true } = {}) {
  if (raw === undefined || raw === null) return ''
  const val = String(raw).trim()
  if (!val) return ''

  if (val.startsWith('notion:')) {
    if (!allowPreset || !NOTION_AVATAR_RE.test(val)) {
      throw new Error('头像标识格式不合法，请重新随机选择或上传照片')
    }
    return val
  }

  if (val.startsWith('preset:')) {
    if (!allowPreset || !PRESET_SET.has(val)) {
      throw new Error('不支持的默认头像编号，请从头像库重新选择')
    }
    return val
  }

  if (val.startsWith('data:image/svg')) {
    throw new Error('出于安全规范，头像不支持 SVG 文件，请上传 PNG、JPG 或 WebP 图片')
  }

  if (!RASTER_DATA_URL_RE.test(val)) {
    throw new Error('头像格式不合规范：仅支持 PNG、JPG、WebP 图片（自动裁切为 1:1 头像）')
  }

  if (val.length > AVATAR_UPLOAD_SPEC.maxDataUrlBytes) {
    throw new Error('头像体积超出 128 KB 规范上限，请重新上传或压缩后再试')
  }

  return val
}

/**
 * Extracts a clean 1-char monogram from a project display alias or repository name.
 * Chinese / CJK characters are preserved as-is; Latin letters are uppercased.
 */
export function extractMonogram(label) {
  const clean = String(label || '').trim()
  if (!clean) return 'P'
  const chars = Array.from(clean)
  const firstMeaningful = chars.find(ch => /[\p{L}\p{N}]/u.test(ch)) || chars[0] || 'P'
  return /[a-z]/.test(firstMeaningful) ? firstMeaningful.toUpperCase() : firstMeaningful
}

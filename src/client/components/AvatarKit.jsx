import React, { useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { createAvatar } from '@dicebear/core'
import * as notionists from '@dicebear/notionists'
import {
  UploadSimple,
  ArrowCounterClockwise,
  Check,
  WarningCircle,
  Shuffle,
  X,
  PencilSimple,
} from '@phosphor-icons/react'
import { getProjectMonogram, PROJECT_ACCENTS } from '../utils.js'

/**
 * Avatar backgrounds are soft tints of the Ekko ToDo brand palette (天青 / 松绿 / 赭黄 / 紫藤 / 青碧 / 石板灰),
 * so portraits sit inside one coherent color system instead of random pastels.
 */
export const PASTEL_BACKGROUNDS = [
  '#d6e5f5', // 天青
  '#d7ebe2', // 松绿
  '#f1e3cf', // 赭黄
  '#e3def1', // 紫藤
  '#d2e8e6', // 青碧
  '#e3e5ea', // 石板灰
]

/**
 * Legacy `preset:*` IDs smoothly map to distinct humanized Notion portraits
 * so existing workspaces immediately transition from robotic icons to fresh portraits.
 */
const LEGACY_PRESET_TO_SEED = {
  'preset:chief-compass': 'chief-mint-orbit',
  'preset:dev-terminal': 'dev-sky-craft',
  'preset:reviewer-shield': 'review-sage-calm',
  'preset:qa-flask': 'qa-apricot-check',
  'preset:media-spark': 'media-blush-spark',
  'preset:editor-quill': 'editor-lavender-pen',
  'preset:analyst-chart': 'analyst-aqua-lens',
  'preset:designer-palette': 'design-lime-studio',
  'preset:researcher-owl': 'research-sky-owl',
  'preset:assistant-bot': 'assist-mint-friend',
}

export const AVATAR_SPEC = Object.freeze({
  allowedMimes: ['image/png', 'image/jpeg', 'image/webp'],
  maxInputBytes: 2 * 1024 * 1024,
  targetSizePx: 128,
  maxDataUrlBytes: 120000,
  acceptAttr: 'image/png,image/jpeg,image/webp',
  ruleHint: '支持 PNG / JPG / WebP · ≤ 2 MB · 自动居中裁切为 1:1（128×128）',
})

function hashString(str) {
  let h = 2166136261
  const s = String(str || 'ekko')
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function generateRandomNotionAvatar(prefix = 'p') {
  const safePrefix = String(prefix || 'p').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 10) || 'p'
  let token = ''
  try {
    const bytes = new Uint8Array(5)
    window.crypto.getRandomValues(bytes)
    token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    token = Math.random().toString(36).slice(2, 12)
  }
  return `notion:${safePrefix}-${token}`
}

export function generateAvatarBatch(count = 9, exclude = []) {
  const seen = new Set(exclude)
  const batch = []
  let guard = 0
  while (batch.length < count && guard < 100) {
    guard += 1
    const next = generateRandomNotionAvatar('u')
    if (seen.has(next)) continue
    seen.add(next)
    batch.push(next)
  }
  return batch
}

export function defaultPresetForRole(role) {
  switch (String(role || '').toLowerCase()) {
    case 'chief': return 'notion:chief-orbit-01'
    case 'builder': return 'notion:builder-craft-02'
    case 'reviewer': return 'notion:reviewer-lens-03'
    case 'qa': return 'notion:qa-spark-04'
    default: return generateRandomNotionAvatar('u')
  }
}

function resolveNotionSeed(raw, fallbackRole, fallbackName) {
  const val = String(raw || '').trim()
  if (val.startsWith('notion:')) return val.slice(7) || 'ekko-friend'
  if (val.startsWith('preset:') && LEGACY_PRESET_TO_SEED[val]) return LEGACY_PRESET_TO_SEED[val]
  if (fallbackName) return `${fallbackRole || 'agent'}-${fallbackName}`
  const def = defaultPresetForRole(fallbackRole)
  return def.startsWith('notion:') ? def.slice(7) : def
}

function resolvePastelBg(seed) {
  const idx = hashString(seed) % PASTEL_BACKGROUNDS.length
  return PASTEL_BACKGROUNDS[idx]
}

const SVG_CACHE = new Map()

function getNotionAvatarDataUri(seed) {
  const key = String(seed || 'ekko-default')
  if (SVG_CACHE.has(key)) return SVG_CACHE.get(key)
  try {
    const svg = createAvatar(notionists, {
      seed: key,
      size: 128,
      scale: 108,
      translateY: 4,
      backgroundColor: ['transparent'],
    }).toString()
    const uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    if (SVG_CACHE.size > 400) {
      const firstKey = SVG_CACHE.keys().next().value
      SVG_CACHE.delete(firstKey)
    }
    SVG_CACHE.set(key, uri)
    return uri
  } catch {
    return ''
  }
}

/**
 * Client-side engineering pipeline for custom avatar uploads:
 * 1. Enforces MIME whitelist (PNG/JPEG/WebP only — blocks SVG XSS & huge GIFs)
 * 2. Enforces 2 MB raw input cap
 * 3. Center-crops to 1:1 square & downscales cleanly to 128x128 WebP/PNG <= 120 KB
 */
export function processAvatarFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('未选择图片文件'))
      return
    }
    const mime = String(file.type || '').toLowerCase()
    if (!AVATAR_SPEC.allowedMimes.includes(mime)) {
      reject(new Error('仅支持 PNG、JPG、WebP 格式的静态图片（不支持 SVG/GIF）'))
      return
    }
    if (file.size > AVATAR_SPEC.maxInputBytes) {
      reject(new Error('图片大小超过 2 MB 上限，请压缩后再上传'))
      return
    }
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const size = AVATAR_SPEC.targetSizePx
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height)
        const sx = Math.max(0, Math.floor(((img.naturalWidth || img.width) - side) / 2))
        const sy = Math.max(0, Math.floor(((img.naturalHeight || img.height) - side) / 2))
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)

        let dataUrl = canvas.toDataURL('image/webp', 0.88)
        if (!dataUrl.startsWith('data:image/webp')) {
          dataUrl = canvas.toDataURL('image/png')
        }
        if (dataUrl.length > AVATAR_SPEC.maxDataUrlBytes) {
          dataUrl = canvas.toDataURL('image/jpeg', 0.82)
        }
        if (dataUrl.length > AVATAR_SPEC.maxDataUrlBytes) {
          reject(new Error('处理后头像体积仍超过上限，请换一张更简洁的图片'))
          return
        }
        resolve(dataUrl)
      } catch (err) {
        reject(new Error(err?.message || '图片处理失败，请重试'))
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('无法读取该图片，请确认文件未损坏'))
    }
    img.src = objectUrl
  })
}

/**
 * Renders a fresh humanized Notion-style illustrated circular portrait
 * (or custom uploaded raster photo) at any size 14px..80px.
 */
export function AgentAvatar({ agent, avatar, role, size = 24, className = '', title = '' }) {
  const [imgFailed, setImgFailed] = useState(false)
  const raw = String(avatar ?? agent?.avatar ?? '').trim()
  const seed = resolveNotionSeed(raw, role || agent?.role, agent?.id || agent?.name)
  const pastelBg = resolvePastelBg(seed)
  const svgUri = useMemo(() => (
    raw && raw.startsWith('data:image/') ? '' : getNotionAvatarDataUri(seed)
  ), [raw, seed])

  if (raw && raw.startsWith('data:image/') && !imgFailed) {
    return (
      <img
        src={raw}
        alt={agent?.name || 'Agent'}
        title={title || agent?.name || ''}
        className={`ot-avatar-img ot-avatar-circle ${className}`}
        style={{ width: size, height: size, borderRadius: '999px' }}
        onError={() => setImgFailed(true)}
      />
    )
  }

  return (
    <span
      className={`ot-avatar-notion ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: pastelBg,
      }}
      title={title || agent?.name || ''}
      aria-hidden="true"
    >
      {svgUri && (
        <img
          src={svgUri}
          alt=""
          className="ot-avatar-notion-svg"
          draggable={false}
        />
      )}
    </span>
  )
}

export function ProjectAvatar({ project, avatar, accent, monogram, size = 20, className = '', title = '' }) {
  const [imgFailed, setImgFailed] = useState(false)
  const raw = String(avatar ?? project?.avatar ?? '').trim()
  const radius = Math.max(4, Math.round(size * 0.26))
  const effectiveAccent = accent || project?.accent || 'blue'
  const effectiveMono = monogram || getProjectMonogram(project)

  if (raw && raw.startsWith('data:image/') && !imgFailed) {
    return (
      <img
        src={raw}
        alt={project?.displayName || project?.name || 'Project'}
        title={title || project?.displayName || project?.name || ''}
        className={`ot-avatar-img ${className}`}
        style={{ width: size, height: size, borderRadius: radius }}
        onError={() => setImgFailed(true)}
      />
    )
  }

  return (
    <span
      className={`ot-proj-chip ot-proj-chip--${effectiveAccent} ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.max(12, Math.round(size * 0.6)),
      }}
      title={title || project?.displayName || project?.name || ''}
    >
      {effectiveMono}
    </span>
  )
}

/**
 * Warm-paper "更换头像" Modal faithfully aligned with the Notion-style Avatar Gallery:
 * - 2-row 9-avatar grid (5 + 4) inside beige fine-border rounded-square tiles
 * - "换一批" blue link to roll 9 fresh non-repeating portraits from millions of combinations
 * - Crisp divider + prominent "上传照片" blue link with size/format guardrails
 */
export function AvatarGalleryModal({ open, value = '', onClose, onSelect, onUploadFile, uploading = false, error = '' }) {
  const [batch, setBatch] = useState(() => generateAvatarBatch(9))
  const fileRef = useRef(null)

  const rollNextBatch = () => {
    setBatch(prev => generateAvatarBatch(9, prev))
  }

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!v) onClose?.() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-avatar-modal-paper" data-testid="avatar-gallery-modal" onOpenAutoFocus={e => e.preventDefault()}>
          <div className="ot-avatar-modal-head">
            <Dialog.Title className="ot-avatar-modal-title">更换头像</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="ot-icon-btn" aria-label="关闭">
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>

          <div className="ot-avatar-modal-grid" data-testid="avatar-gallery-grid">
            {batch.map((seedId, idx) => {
              const active = value === seedId
              const seed = seedId.slice(7)
              const bg = resolvePastelBg(seed)
              const uri = getNotionAvatarDataUri(seed)
              return (
                <button
                  key={seedId}
                  type="button"
                  className={`ot-avatar-paper-tile ${active ? 'is-active' : ''}`}
                  onClick={() => { onSelect?.(seedId); onClose?.() }}
                  data-testid={`avatar-gallery-item-${idx}`}
                  title="选择此头像"
                >
                  <span className="ot-avatar-paper-disc" style={{ backgroundColor: bg }}>
                    <img src={uri} alt="" className="ot-avatar-paper-portrait" draggable={false} />
                  </span>
                  {active && <Check size={11} weight="bold" className="ot-avatar-preset-check" />}
                </button>
              )
            })}
          </div>

          <div className="ot-avatar-modal-refresh-row">
            <button
              type="button"
              className="ot-avatar-link-sm"
              onClick={rollNextBatch}
              data-testid="btn-avatar-shuffle-batch"
            >
              换一批
            </button>
          </div>

          <div className="ot-avatar-modal-divider" />

          <div className="ot-avatar-modal-upload-row">
            <input
              ref={fileRef}
              type="file"
              accept={AVATAR_SPEC.acceptAttr}
              style={{ display: 'none' }}
              onChange={e => onUploadFile?.(e, () => onClose?.())}
              data-testid="input-avatar-modal-upload"
            />
            <button
              type="button"
              className="ot-avatar-link-lg"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
              data-testid="btn-avatar-modal-upload"
            >
              {uploading ? '正在裁切压缩照片…' : '上传照片'}
            </button>
            <div className="ot-avatar-spec-hint" style={{ marginTop: 4 }}>{AVATAR_SPEC.ruleHint}</div>
            {error && (
              <div className="ot-avatar-spec-err" style={{ marginTop: 6 }}>
                <WarningCircle size={12} weight="fill" />
                <span>{error}</span>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Unified Avatar Picker & Spec-Validated Uploader for both Agents and Projects.
 * - For Agents: fresh Notion-style humanized portraits + 1-click "更换头像" 9-grid modal + quick "换一个" + photo upload.
 * - For Projects: 6-color monogram swatch picker + custom photo upload.
 */
export function AvatarPicker({
  mode = 'agent',
  value = '',
  role = 'custom',
  accent = 'blue',
  monogram = 'P',
  compact = false,
  inlineStrip = false,
  onChange,
  onAccentChange,
}) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [stripSeeds, setStripSeeds] = useState(() => generateAvatarBatch(inlineStrip ? 7 : 6))

  const handleFile = async (e, onSuccess) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const dataUrl = await processAvatarFile(file)
      onChange?.(dataUrl)
      onSuccess?.()
    } catch (err) {
      setError(err?.message || '头像处理失败')
    } finally {
      setUploading(false)
    }
  }

  const isCustomUpload = String(value || '').startsWith('data:image/')

  return (
    <div className={`ot-avatar-picker ${compact ? 'is-compact' : ''}`} data-testid={`avatar-picker-${mode}`}>
      <div className="ot-avatar-picker-top">
        {mode === 'agent' ? (
          <button
            type="button"
            className="ot-avatar-trigger-btn"
            onClick={() => setModalOpen(true)}
            title="点击打开「更换头像」"
            data-testid="btn-open-avatar-gallery"
          >
            <AgentAvatar avatar={value} role={role} size={compact ? 40 : 48} />
            <span className="ot-avatar-trigger-edit"><PencilSimple size={10} weight="bold" /></span>
          </button>
        ) : (
          <ProjectAvatar avatar={value} accent={accent} monogram={monogram} size={compact ? 36 : 44} />
        )}

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <input
              ref={inputRef}
              type="file"
              accept={AVATAR_SPEC.acceptAttr}
              style={{ display: 'none' }}
              onChange={e => handleFile(e)}
              data-testid={`input-avatar-upload-${mode}`}
            />
            {mode === 'agent' && (
              <>
                <button
                  type="button"
                  className="ot-btn ot-btn--sm"
                  onClick={() => setModalOpen(true)}
                  data-testid="btn-avatar-open-modal"
                >
                  <span>更换头像</span>
                </button>
                <button
                  type="button"
                  className="ot-btn ot-btn--sm"
                  onClick={() => {
                    setError('')
                    onChange?.(generateRandomNotionAvatar(role || 'u'))
                  }}
                  title="随机生成不重复清新拟人头像"
                  data-testid="btn-avatar-quick-shuffle"
                >
                  <Shuffle size={12} />
                  <span>随机换一个</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="ot-btn ot-btn--sm"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              data-testid={`btn-avatar-upload-${mode}`}
            >
              <UploadSimple size={12} />
              <span>{uploading ? '裁切压缩中…' : '上传照片'}</span>
            </button>
            {isCustomUpload && (
              <button
                type="button"
                className="ot-btn ot-btn--sm"
                onClick={() => {
                  setError('')
                  onChange?.(mode === 'agent' ? generateRandomNotionAvatar(role || 'u') : '')
                }}
              >
                <ArrowCounterClockwise size={12} />
                <span>{mode === 'agent' ? '换回手绘头像' : '恢复首字色块'}</span>
              </button>
            )}
          </div>
          <div className="ot-avatar-spec-hint">{AVATAR_SPEC.ruleHint}</div>
          {error && (
            <div className="ot-avatar-spec-err">
              <WarningCircle size={12} weight="fill" />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>

      {mode === 'agent' ? (
        <div className="ot-avatar-inline-strip-wrap" data-testid="agent-avatar-presets">
          <div className="ot-avatar-notion-strip">
            {stripSeeds.map((seedId, idx) => {
              const active = value === seedId
              return (
                <button
                  key={seedId}
                  type="button"
                  className={`ot-avatar-strip-tile ${active ? 'is-active' : ''}`}
                  title="点选此头像"
                  onClick={() => { setError(''); onChange?.(seedId) }}
                  data-testid={`avatar-preset-${idx}`}
                >
                  <AgentAvatar avatar={seedId} size={inlineStrip ? 28 : 32} />
                  {active && <Check size={9} weight="bold" className="ot-avatar-preset-check" />}
                </button>
              )
            })}
            <button
              type="button"
              className="ot-avatar-strip-more"
              onClick={() => setStripSeeds(prev => generateAvatarBatch(inlineStrip ? 7 : 6, prev))}
              title="换一批新头像"
              data-testid="btn-avatar-strip-shuffle"
            >
              换一批
            </button>
          </div>
          <AvatarGalleryModal
            open={modalOpen}
            value={value}
            uploading={uploading}
            error={error}
            onClose={() => setModalOpen(false)}
            onSelect={next => { setError(''); onChange?.(next) }}
            onUploadFile={handleFile}
          />
        </div>
      ) : (
        <div className="ot-accent-row">
          <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>默认色块：</span>
          {PROJECT_ACCENTS.map(c => (
            <button
              key={c.id}
              type="button"
              className={`ot-accent-dot ot-proj-chip--${c.id} ${accent === c.id ? 'is-active' : ''}`}
              title={c.label}
              onClick={() => onAccentChange?.(c.id)}
              data-testid={`project-accent-${c.id}`}
            >
              {accent === c.id ? <Check size={10} weight="bold" /> : monogram.slice(0, 1)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// v0.9.9 — render images and open files that live on the plugin host, from any access path.
//
// Chat text from agents references host files as `![x](/Users/…/a.png)`, `[a](file:///…)`,
// host download links or bare paths. A bare path resolves against the page origin (404 over LAN,
// tunnels and VPS proxies alike), and the host download endpoint needs a login token. Instead the
// bytes come through the plugin RPC `read-local-file` (works wherever the plugin UI works) in
// ≤1 MB chunks and become a Blob URL inside the plugin iframe.

export const OPEN_LOCAL_FILE_EVENT = 'ekko-todo:open-local-file'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|heic)$/i
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
}
const KNOWN_ROOT = /^\/(Users|home|root|tmp|private|var|Volumes|opt|mnt|srv|data|etc)\//
// Bare host paths inside prose / inline code. Stops at whitespace, quotes, brackets and CJK punctuation.
const BARE_PATH_RE = /(?:~\/|\/(?:Users|home|root|tmp|private|var|Volumes|opt|mnt|srv|data)\/|[A-Za-z]:[\\/])[^\s<>"'`()[\]{}，。；：！？、“”‘’（）【】《》]*\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g

let rpcCall = null
export function setLocalFileRpc(call) { rpcCall = typeof call === 'function' ? call : null }

export function isImagePath(p) { return IMAGE_EXT.test(String(p || '').split(/[?#]/)[0]) }

export function guessMime(p) {
  const ext = String(p || '').split(/[?#]/)[0].split('.').pop()?.toLowerCase() || ''
  return MIME_BY_EXT[ext] || ''
}

export function fileNameOf(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '')
}

function safeDecode(s) { try { return decodeURIComponent(s) } catch { return s } }

/** Returns a host path for href/src values that point at a local file, otherwise ''. */
export function toLocalPath(raw) {
  let v = String(raw || '').trim()
  if (!v) return ''
  if (v.startsWith('<') && v.endsWith('>')) v = v.slice(1, -1).trim()
  if (/^(?:https?:)?\/\/[^/]*\/api\/(?:studio\/files|hermes)\/download\?/i.test(v) || /^\/api\/(?:studio\/files|hermes)\/download\?/i.test(v)) {
    try { return new URL(v, 'http://x').searchParams.get('path') || '' } catch { return '' }
  }
  if (/^file:\/\//i.test(v)) {
    try { return safeDecode(new URL(v).pathname).replace(/^\/([A-Za-z]:\/)/, '$1') } catch { return '' }
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(v) && !/^[A-Za-z]:[\\/]/.test(v)) return ''
  v = safeDecode(v.split('#')[0])
  if (v === '~' || v.startsWith('~/')) return v
  if (/^[A-Za-z]:[\\/]/.test(v)) return v.replace(/\\/g, '/')
  if (!v.startsWith('/') || v.startsWith('/api/')) return ''
  if (KNOWN_ROOT.test(v) || /\.[A-Za-z0-9]{1,8}$/.test(v)) return v
  return ''
}

/* ---------- loading (chunked RPC → Blob URL, with cache) ---------- */

const blobCache = new Map() // path → Promise<{url, meta}>
const MAX_CACHE = 80

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// At most two file reads in flight: a burst of thumbnails must not trip a proxy rate limit (nginx limit_req → 429)
// or starve the board's own RPCs on a slow tunnel.
const MAX_INFLIGHT = 2
let inflight = 0
const waiting = []
async function call(input) {
  if (!rpcCall) throw new Error('插件通道尚未就绪')
  if (inflight >= MAX_INFLIGHT) await new Promise(r => waiting.push(r))
  inflight++
  try {
    return await rpcCall('read-local-file', input)
  } finally {
    inflight--
    waiting.shift()?.()
  }
}

export function loadLocalBlob(path) {
  const key = String(path || '')
  if (blobCache.has(key)) {
    const hit = blobCache.get(key)
    blobCache.delete(key); blobCache.set(key, hit)
    return hit
  }
  const p = (async () => {
    const parts = []
    let offset = 0
    let meta = null
    for (let guard = 0; guard < 80; guard++) {
      const res = await call({ path: key, mode: 'bytes', offset })
      meta = meta || res
      parts.push(b64ToBytes(res.dataBase64 || ''))
      offset = (res.offset || 0) + (res.length || 0)
      if (res.eof || !res.length) break
    }
    const blob = new Blob(parts, { type: meta?.mime || guessMime(key) || 'application/octet-stream' })
    return { url: URL.createObjectURL(blob), meta: { ...meta, dataBase64: undefined } }
  })()
  p.catch(() => blobCache.delete(key))
  blobCache.set(key, p)
  while (blobCache.size > MAX_CACHE) {
    const [oldKey, oldVal] = blobCache.entries().next().value
    blobCache.delete(oldKey)
    oldVal.then(v => setTimeout(() => URL.revokeObjectURL(v.url), 60_000)).catch(() => {})
  }
  return p
}

export function loadLocalMeta(path) { return call({ path, mode: 'meta' }) }
export function loadLocalText(path) { return call({ path, mode: 'text' }) }

/* ---------- opening (event bus → LocalFilePreview modal) ---------- */

export function openLocalFile(path, gallery = []) {
  if (!path || typeof window === 'undefined') return
  const list = gallery.length ? gallery : [path]
  window.dispatchEvent(new CustomEvent(OPEN_LOCAL_FILE_EVENT, { detail: { path, gallery: list } }))
}

/* ---------- DOM enhancement for rendered markdown / plain text ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** Plain text → safe HTML (line breaks kept by CSS pre-wrap). */
export function plainTextToHtml(text) { return escapeHtml(text || '') }

function trimTrailing(p) {
  return p.replace(/[.,;:!?)\]}>]+$/, '')
}

function makeFileLink(doc, path) {
  const a = doc.createElement('a')
  a.href = '#'
  a.className = `ot-local-file${isImagePath(path) ? ' is-image' : ''}`
  a.setAttribute('data-local-path', path)
  a.title = `预览：${path}`
  a.textContent = path
  return a
}

function linkifyTextNodes(root) {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest('a, pre, button, .ot-local-thumbs')) return NodeFilter.FILTER_REJECT
      BARE_PATH_RE.lastIndex = 0
      return BARE_PATH_RE.test(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    const text = node.nodeValue || ''
    const frag = doc.createDocumentFragment()
    let last = 0
    BARE_PATH_RE.lastIndex = 0
    let m
    while ((m = BARE_PATH_RE.exec(text))) {
      const path = trimTrailing(m[0])
      if (!path) continue
      if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)))
      frag.appendChild(makeFileLink(doc, path))
      last = m.index + path.length
      BARE_PATH_RE.lastIndex = last
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)))
    node.parentNode.replaceChild(frag, node)
  }
}

function hydrateImage(img, path) {
  img.classList.add('ot-local-img', 'is-loading')
  img.setAttribute('data-local-path', path)
  if (!img.getAttribute('alt')) img.setAttribute('alt', fileNameOf(path))
  img.removeAttribute('src')
  // Over slow tunnels only fetch what scrolls into view.
  const IO = typeof window !== 'undefined' ? window.IntersectionObserver : null
  if (IO && !img.__ekkoSeen) {
    const io = new IO(entries => {
      if (entries.some(en => en.isIntersecting)) {
        io.disconnect()
        img.__ekkoSeen = true
        hydrateImage(img, path)
      }
    }, { rootMargin: '400px' })
    io.observe(img)
    return
  }
  loadLocalBlob(path).then(({ url }) => {
    if (!img.isConnected && !img.parentNode) return
    img.src = url
    img.classList.remove('is-loading')
  }).catch(err => {
    const doc = img.ownerDocument
    const box = doc.createElement('span')
    box.className = 'ot-local-img-error'
    box.setAttribute('data-local-path', path)
    box.title = String(err?.message || err || '加载失败')
    box.textContent = `图片加载失败：${fileNameOf(path)}（${String(err?.message || err || '').replace(/^API Error \d+:\s*/, '')}）`
    img.replaceWith(box)
  })
}

/**
 * Turn local references inside a rendered container into working media:
 * - <img data-local-src|src=local> → Blob URL image (click = preview)
 * - <a data-local-path|href=local> and bare paths in text → preview links
 * - bare image paths without an inline image → thumbnail strip at the end (max 8)
 * Returns a cleanup function that removes the click handler.
 */
export function enhanceLocalMedia(root, { thumbnails = true } = {}) {
  if (!root) return () => {}
  for (const img of root.querySelectorAll('img')) {
    const path = img.getAttribute('data-local-src') || toLocalPath(img.getAttribute('src') || '')
    if (path) hydrateImage(img, path)
  }
  for (const a of root.querySelectorAll('a')) {
    if (a.hasAttribute('data-local-path')) continue
    const path = toLocalPath(a.getAttribute('href') || '')
    if (!path) continue
    a.setAttribute('data-local-path', path)
    a.setAttribute('href', '#')
    a.classList.add('ot-local-file')
    if (isImagePath(path)) a.classList.add('is-image')
    a.title = `预览：${path}`
  }
  linkifyTextNodes(root)

  root.querySelector(':scope > .ot-local-thumbs')?.remove()
  const inlineImages = new Set([...root.querySelectorAll('img[data-local-path]')].map(i => i.getAttribute('data-local-path')))
  const imageLinks = [...new Set([...root.querySelectorAll('a.ot-local-file.is-image')].map(a => a.getAttribute('data-local-path')))]
    .filter(p => !inlineImages.has(p))
  if (thumbnails && imageLinks.length) {
    const doc = root.ownerDocument
    const strip = doc.createElement('div')
    strip.className = 'ot-local-thumbs'
    strip.setAttribute('data-testid', 'local-image-thumbs')
    for (const p of imageLinks.slice(0, 8)) {
      const btn = doc.createElement('button')
      btn.type = 'button'
      btn.className = 'ot-local-thumb'
      btn.setAttribute('data-local-path', p)
      btn.title = p
      const img = doc.createElement('img')
      img.setAttribute('data-local-src', p)
      img.alt = fileNameOf(p)
      btn.appendChild(img)
      strip.appendChild(btn)
      hydrateImage(img, p)
    }
    if (imageLinks.length > 8) {
      const more = doc.createElement('span')
      more.className = 'ot-local-thumbs-more'
      more.textContent = `+${imageLinks.length - 8}`
      strip.appendChild(more)
    }
    root.appendChild(strip)
  }

  const onClick = e => {
    const target = e.target instanceof Element ? e.target.closest('[data-local-path]') : null
    if (!target || !root.contains(target)) return
    e.preventDefault()
    e.stopPropagation()
    const path = target.getAttribute('data-local-path')
    const gallery = [...new Set([...root.querySelectorAll('[data-local-path]')]
      .map(el => el.getAttribute('data-local-path'))
      .filter(isImagePath))]
    openLocalFile(path, isImagePath(path) ? gallery : [path])
  }
  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}

/* ---------- external links (v0.9.23) ---------- */
//
// The plugin page lives in a host iframe. A link without target opens e.g. GitHub inside that
// iframe, which refuses to be framed ("无法访问"). External http(s) links therefore always open a
// new browser page; links to host files stay in-page and keep opening the preview modal.

export const EXTERNAL_LINK_TARGET = '_blank'
export const EXTERNAL_LINK_REL = 'noopener noreferrer'

/** True for http(s) URLs that leave the plugin (host file download links are local, not external). */
export function isExternalHttpUrl(raw) {
  const v = String(raw || '').trim()
  return /^https?:\/\//i.test(v) && !toLocalPath(v)
}

const hookedPurifiers = new WeakSet()

/**
 * DOMPurify drops `target` by default and raw HTML may carry `target="_top"` (which would navigate
 * the host page). After sanitizing, every external <a> gets target="_blank" + rel, every other <a>
 * loses its target. Idempotent per DOMPurify instance.
 */
export function installExternalLinkHook(purify) {
  if (!purify || typeof purify.addHook !== 'function' || hookedPurifiers.has(purify)) return
  hookedPurifiers.add(purify)
  purify.addHook('afterSanitizeAttributes', node => {
    if (String(node?.tagName || node?.nodeName || '').toUpperCase() !== 'A') return
    if (isExternalHttpUrl(node.getAttribute('href'))) {
      node.setAttribute('target', EXTERNAL_LINK_TARGET)
      node.setAttribute('rel', EXTERNAL_LINK_REL)
    } else {
      node.removeAttribute('target')
    }
  })
}

function encodeHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%') } catch { return null }
}

/**
 * marked extension: local images/links are emitted without a fetchable src so the browser never
 * requests `/Users/…` from the page origin; enhanceLocalMedia() hydrates them. External http(s)
 * links are emitted with target="_blank" rel="noopener noreferrer".
 */
/**
 * Puts every rendered table in `<div class="ot-md-table">` so a table wider than the chat bubble scrolls inside
 * that container. Table markup written inside a code block is already escaped and is left alone.
 */
export function wrapMarkdownTables(html) {
  return String(html || '')
    .replace(/<table(?=[\s>])/gi, '<div class="ot-md-table"><table')
    .replace(/<\/table>/gi, '</table></div>')
}

export const localMarkedExtension = {
  hooks: {
    postprocess: wrapMarkdownTables,
  },
  renderer: {
    image(token) {
      const path = toLocalPath(token?.href)
      if (!path) return false
      const alt = escapeHtml(token?.text || fileNameOf(path))
      return `<img data-local-src="${escapeHtml(path)}" alt="${alt}">`
    },
    link(token) {
      if (!isExternalHttpUrl(token?.href)) return false
      const href = encodeHref(String(token.href).trim())
      if (href === null) return false
      const inner = token.autolink || !Array.isArray(token.tokens)
        ? escapeHtml(token.text || '')
        : this.parser.parseInline(token.tokens)
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      return `<a href="${escapeHtml(href)}" target="${EXTERNAL_LINK_TARGET}" rel="${EXTERNAL_LINK_REL}"${title}>${inner}</a>`
    },
  },
}

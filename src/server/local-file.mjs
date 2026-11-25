// v0.9.9 — read files that live on the plugin host so the chat can render images and open files.
//
// Why an RPC instead of an <img src="/Users/...">: the browser may sit on another machine (LAN, a
// tunnel such as 节点小宝 / FRP, or a VPS reverse proxy). A bare local path resolves against the page
// origin and 404s, and the host's own download endpoint needs a login token the plugin must not hold.
// The plugin RPC channel already works wherever the plugin UI works, so the bytes ride that channel
// in chunks that stay under the host's 2,000,000-byte JSON limit and become an iframe Blob URL.
import { openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'

export const LOCAL_FILE_CHUNK_BYTES = 1_000_000 // base64 ≈ 1.34 MB, well under the 2 MB host limit
export const LOCAL_FILE_TEXT_BYTES = 400_000
export const LOCAL_FILE_MAX_BYTES = 60 * 1024 * 1024

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf', json: 'application/json', html: 'text/html', htm: 'text/html', css: 'text/css',
  md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', txt: 'text/plain', log: 'text/plain',
  xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py',
  'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash',
  'sql', 'graphql', 'proto', 'diff', 'patch', 'tex', 'rst', 'svg', 'gitignore', 'dockerfile', 'makefile',
])

// Secrets never leave the host through this channel, whatever the path looks like.
const DENY_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.password-store', 'secrets', 'keychains', '.docker'])
const DENY_FILE = [
  /^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^auth\.json$/i, /^credentials(\..*)?$/i, /token/i,
  /\.(db|sqlite|sqlite3)(-wal|-shm)?$/i,
]

export function mimeForPath(p) {
  const ext = extname(String(p || '')).slice(1).toLowerCase()
  return MIME[ext] || ''
}

export function kindForPath(p, mime = mimeForPath(p)) {
  const ext = extname(String(p || '')).slice(1).toLowerCase()
  const name = basename(String(p || '')).toLowerCase()
  if (mime.startsWith('image/') && ext !== 'svg') return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (TEXT_EXT.has(ext) || TEXT_EXT.has(name)) return 'text'
  return 'binary'
}

// Accepts absolute paths, ~/ paths, file:// URLs and host download links (/api/studio/files/download?path=…).
export function normalizeLocalPath(raw) {
  let p = String(raw || '').trim()
  if (!p) return ''
  if (/^\/api\/(studio\/files|hermes)\/download\?/.test(p)) {
    try { p = new URL(p, 'http://x').searchParams.get('path') || '' } catch { return '' }
  }
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname) } catch { return '' }
  }
  if (p.startsWith('<') && p.endsWith('>')) p = p.slice(1, -1)
  if (/%[0-9A-Fa-f]{2}/.test(p)) { try { p = decodeURIComponent(p) } catch {} }
  if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1)
  if (/^[A-Za-z]:[\\/]/.test(p)) return p.replace(/\\/g, '/')
  return isAbsolute(p) ? resolve(p) : ''
}

function within(child, root) {
  if (!root) return false
  const r = root.endsWith(sep) ? root : root + sep
  return child === root || child.startsWith(r)
}

export function defaultAllowRoots(extra = []) {
  const roots = [homedir(), tmpdir(), '/tmp', '/private/tmp', '/private/var/folders', '/var/folders', '/Volumes', '/mnt', '/srv', '/opt', '/data', ...extra]
  const out = []
  for (const r of roots) {
    if (!r) continue
    try { out.push(realpathSync(r)) } catch { out.push(resolve(r)) }
  }
  return [...new Set(out)]
}

export function checkLocalPathAllowed(realPath, allowRoots) {
  if (!allowRoots.some(root => within(realPath, root))) {
    return '该路径不在允许预览的目录内'
  }
  const parts = realPath.split(/[\\/]+/).filter(Boolean)
  for (const seg of parts.slice(0, -1)) {
    if (DENY_SEGMENTS.has(seg.toLowerCase())) return '出于安全考虑，不允许预览密钥/凭证目录中的文件'
  }
  const name = parts[parts.length - 1] || ''
  if (DENY_FILE.some(re => re.test(name))) return '出于安全考虑，不允许预览密钥/凭证/数据库类文件'
  return ''
}

/**
 * Read a slice of a host file.
 * mode=meta  → only metadata
 * mode=text  → UTF-8 text (first LOCAL_FILE_TEXT_BYTES, truncated flag)
 * mode=bytes → base64 chunk starting at offset (≤ LOCAL_FILE_CHUNK_BYTES)
 */
export function readLocalFile({ path, offset = 0, length = LOCAL_FILE_CHUNK_BYTES, mode = 'bytes' } = {}, { allowRoots = defaultAllowRoots() } = {}) {
  const normalized = normalizeLocalPath(path)
  if (!normalized) throw new Error('只能预览本机绝对路径（如 /Users/…、~/…、C:/…）')
  let real
  try {
    real = realpathSync(normalized)
  } catch {
    throw new Error(`文件不存在：${normalized}（若 Studio 部署在另一台机器，文件需位于插件所在主机上）`)
  }
  const denied = checkLocalPathAllowed(real, allowRoots)
  if (denied) throw new Error(denied)
  const st = statSync(real)
  if (st.isDirectory()) throw new Error('这是一个目录，不是文件')
  if (!st.isFile()) throw new Error('不是普通文件')
  const mime = mimeForPath(real) || 'application/octet-stream'
  const kind = kindForPath(real, mimeForPath(real))
  const meta = { path: real, name: basename(real), size: st.size, mtimeMs: Math.round(st.mtimeMs), mime, kind }
  if (mode === 'meta') return meta
  if (st.size > LOCAL_FILE_MAX_BYTES && mode !== 'text') {
    throw new Error(`文件过大（${(st.size / 1024 / 1024).toFixed(1)} MB），超过 ${LOCAL_FILE_MAX_BYTES / 1024 / 1024} MB 预览上限`)
  }
  const start = Math.max(0, Math.min(Number(offset) || 0, st.size))
  const cap = mode === 'text' ? LOCAL_FILE_TEXT_BYTES : LOCAL_FILE_CHUNK_BYTES
  const want = Math.max(0, Math.min(Number(length) || cap, cap, st.size - start))
  const buf = Buffer.alloc(want)
  if (want > 0) {
    const fd = openSync(real, 'r')
    try {
      let got = 0
      while (got < want) {
        const n = readSync(fd, buf, got, want - got, start + got)
        if (!n) break
        got += n
      }
    } finally {
      closeSync(fd)
    }
  }
  if (mode === 'text') {
    let isBinary = false
    for (let i = 0; i < Math.min(buf.length, 4096); i++) { if (buf[i] === 0) { isBinary = true; break } }
    if (isBinary) return { ...meta, kind: 'binary', text: '', truncated: false, binary: true }
    return { ...meta, text: buf.toString('utf8'), truncated: st.size > want, binary: false }
  }
  return { ...meta, offset: start, length: want, eof: start + want >= st.size, dataBase64: buf.toString('base64') }
}

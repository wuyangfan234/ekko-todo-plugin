import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { CaretLeft, CaretRight, CircleNotch, Copy, DownloadSimple, X } from '@phosphor-icons/react'
import {
  OPEN_LOCAL_FILE_EVENT,
  enhanceLocalMedia,
  fileNameOf,
  installExternalLinkHook,
  loadLocalBlob,
  loadLocalMeta,
  loadLocalText,
  localMarkedExtension,
} from '../local-files.js'
import { formatFileSize } from '../utils.js'

const md = new Marked({ gfm: true, breaks: true }, localMarkedExtension)
// External http(s) links open a new page (the plugin runs in a host iframe); see local-files.js.
installExternalLinkHook(DOMPurify)

export function renderChatMarkdown(text) {
  return DOMPurify.sanitize(md.parse(String(text || '')))
}

/** Sanitized HTML container whose local images / file paths become previewable. */
export function LocalAwareHtml({ html, className, style, thumbnails = true, ...rest }) {
  const ref = useRef(null)
  useLayoutEffect(() => enhanceLocalMedia(ref.current, { thumbnails }), [html, thumbnails])
  return <div ref={ref} className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} {...rest} />
}

/** Plain text (pre-wrap) whose bare host paths become previewable links. */
export function LocalAwareText({ text, className, style, ...rest }) {
  const html = useMemo(() => DOMPurify.sanitize(String(text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))), [text])
  return <LocalAwareHtml html={html} className={className} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...style }} {...rest} />
}

function triggerDownload(url, name) {
  const a = document.createElement('a')
  a.href = url
  a.download = name || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Global preview modal; opened by openLocalFile() from anywhere in the plugin. */
export function LocalFilePreview({ notify }) {
  const [state, setState] = useState(null) // { gallery, index }
  const [view, setView] = useState({ status: 'idle' })

  useEffect(() => {
    const onOpen = e => {
      const { path, gallery } = e.detail || {}
      const list = Array.isArray(gallery) && gallery.length ? gallery : [path]
      setState({ gallery: list, index: Math.max(0, list.indexOf(path)) })
    }
    window.addEventListener(OPEN_LOCAL_FILE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_LOCAL_FILE_EVENT, onOpen)
  }, [])

  const path = state ? state.gallery[state.index] : ''

  useEffect(() => {
    if (!path) return undefined
    let alive = true
    setView({ status: 'loading' })
    ;(async () => {
      try {
        const meta = await loadLocalMeta(path)
        if (!alive) return
        if (meta.kind === 'text') {
          const res = await loadLocalText(path)
          if (!alive) return
          if (res.binary) { setView({ status: 'ready', meta: { ...meta, kind: 'binary' } }); return }
          setView({ status: 'ready', meta, text: res.text, truncated: res.truncated })
          return
        }
        if (meta.kind === 'binary') { setView({ status: 'ready', meta }); return }
        const { url } = await loadLocalBlob(path)
        if (alive) setView({ status: 'ready', meta, url })
      } catch (err) {
        if (alive) setView({ status: 'error', error: String(err?.message || err).replace(/^API Error \d+:\s*/, '') })
      }
    })()
    return () => { alive = false }
  }, [path])

  const step = d => setState(s => (s && s.gallery.length > 1 ? { ...s, index: (s.index + d + s.gallery.length) % s.gallery.length } : s))

  useEffect(() => {
    if (!state || state.gallery.length < 2) return undefined
    const onKey = e => {
      if (e.key === 'ArrowLeft') step(-1)
      if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  const download = async () => {
    try {
      const { url, meta } = view.url ? { url: view.url, meta: view.meta } : await loadLocalBlob(path)
      triggerDownload(url, meta?.name || fileNameOf(path))
    } catch (err) {
      notify?.(String(err?.message || err), 'error')
    }
  }
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(path); notify?.('已复制路径', 'success') } catch { notify?.('复制失败', 'error') }
  }

  const meta = view.meta
  const isMd = meta && /\.(md|markdown)$/i.test(meta.name || '')
  const mdHtml = useMemo(() => (isMd && view.text ? renderChatMarkdown(view.text) : ''), [isMd, view.text])

  let body = null
  if (view.status === 'loading') {
    body = <div className="ot-lfp-center"><CircleNotch size={20} className="ot-spin" /> 正在读取…</div>
  } else if (view.status === 'error') {
    body = <div className="ot-lfp-center ot-lfp-error" data-testid="local-file-error">{view.error}</div>
  } else if (meta?.kind === 'image') {
    body = <img className="ot-lfp-image" src={view.url} alt={meta.name} data-testid="local-file-image" />
  } else if (meta?.kind === 'video') {
    body = <video className="ot-lfp-media" src={view.url} controls playsInline />
  } else if (meta?.kind === 'audio') {
    body = <div className="ot-lfp-center"><audio src={view.url} controls /></div>
  } else if (meta?.kind === 'pdf') {
    body = <iframe className="ot-lfp-pdf" src={view.url} title={meta.name} />
  } else if (meta?.kind === 'text') {
    body = (
      <div className="ot-lfp-textwrap">
        {view.truncated && <div className="ot-lfp-note">文件较大，仅显示前 400 KB，完整内容请下载。</div>}
        {isMd
          ? <LocalAwareHtml className="ot-md ot-lfp-md" html={mdHtml} />
          : <pre className="ot-lfp-text" data-testid="local-file-text">{view.text}</pre>}
      </div>
    )
  } else if (meta) {
    body = (
      <div className="ot-lfp-center ot-lfp-binary">
        <div>此类型文件无法在页面内预览（{meta.mime}）。</div>
        <button type="button" className="ot-btn ot-btn--primary" onClick={download}><DownloadSimple size={14} /> 下载 {formatFileSize(meta.size)}</button>
      </div>
    )
  }

  return (
    <Dialog.Root open={Boolean(state)} onOpenChange={o => { if (!o) { setState(null); setView({ status: 'idle' }) } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay ot-lfp-overlay" />
        <Dialog.Content className="ot-modal ot-lfp" aria-describedby={undefined} data-testid="local-file-preview">
          <div className="ot-dialog-head ot-lfp-head">
            <div style={{ minWidth: 0 }}>
              <Dialog.Title className="ot-dialog-title ot-lfp-title">{meta?.name || fileNameOf(path)}</Dialog.Title>
              <div className="ot-dialog-sub ot-lfp-path" title={path}>
                {path}{meta ? ` · ${formatFileSize(meta.size)}` : ''}
                {state?.gallery.length > 1 ? ` · ${state.index + 1}/${state.gallery.length}` : ''}
              </div>
            </div>
            <div className="ot-lfp-actions">
              <button type="button" className="ot-icon-btn" onClick={copyPath} title="复制路径" aria-label="复制路径"><Copy size={15} /></button>
              <button type="button" className="ot-icon-btn" onClick={download} title="下载" aria-label="下载" disabled={view.status !== 'ready'}><DownloadSimple size={15} /></button>
              <Dialog.Close asChild>
                <button type="button" className="ot-icon-btn" aria-label="关闭"><X size={15} /></button>
              </Dialog.Close>
            </div>
          </div>
          <div className="ot-lfp-body">
            {state?.gallery.length > 1 && (
              <button type="button" className="ot-lfp-nav is-prev" onClick={() => step(-1)} aria-label="上一张"><CaretLeft size={18} /></button>
            )}
            {body}
            {state?.gallery.length > 1 && (
              <button type="button" className="ot-lfp-nav is-next" onClick={() => step(1)} aria-label="下一张"><CaretRight size={18} /></button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

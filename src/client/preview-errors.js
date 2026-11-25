// Short, user-facing text for a failed file preview. RPC failures arrive wrapped by the host
// ("API Error 500: ...") and may carry git command lines, absolute paths or "fatal:" text from
// older servers; none of that is shown in the preview pane.

export const PREVIEW_UNREADABLE = '这个文件打不开'
export const PREVIEW_UNSUPPORTED = '这个文件不支持预览'

export function previewErrorText(err) {
  const raw = typeof err === 'string' ? err : String(err?.message || '')
  return raw.includes(PREVIEW_UNSUPPORTED) ? PREVIEW_UNSUPPORTED : PREVIEW_UNREADABLE
}

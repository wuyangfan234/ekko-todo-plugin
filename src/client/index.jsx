import React from 'react'
import { createRoot } from 'react-dom/client'
import stylesText from './styles.css'
import { App } from './App.jsx'
import { wrapClientContext } from './rpc-retry.js'

function ensureStyles() {
  let el = document.getElementById('ekko-todo-styles')
  if (!el) {
    el = document.createElement('style')
    el.id = 'ekko-todo-styles'
    document.head.appendChild(el)
  }
  el.textContent = stylesText
}

/**
 * Last-resort boundary (same shape as react-error-boundary): a render error anywhere in the board used to unmount
 * the whole tree and leave a blank plugin page. Now the error text and a retry button stay on screen instead.
 */
export class PluginErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null, resetKey: 0 }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    try { console.error('[ekko-todo] render error', error, info?.componentStack || '') } catch {}
  }

  render() {
    const { error, resetKey } = this.state
    if (!error) return <React.Fragment key={resetKey}>{this.props.children}</React.Fragment>
    return (
      <div role="alert" data-testid="plugin-error-boundary" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640 }}>
        <strong>Ekko ToDo 界面出错了，数据没有丢失。</strong>
        <code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, opacity: 0.8 }}>
          {String(error?.message || error).slice(0, 600)}
        </code>
        <div>
          <button type="button" className="ot-btn ot-btn--sm ot-btn--primary" onClick={() => this.setState(s => ({ error: null, resetKey: s.resetKey + 1 }))}>
            重新加载界面
          </button>
        </div>
      </div>
    )
  }
}

/** @param {HTMLElement} root @param {import('@ekko-studio/plugin-sdk').ClientContext} ctx */
export async function mount(root, ctx) {
  ensureStyles()
  root.lang = 'zh-CN'
  const reactRoot = createRoot(root)
  reactRoot.render(<PluginErrorBoundary><App ctx={wrapClientContext(ctx)} /></PluginErrorBoundary>)
  return () => {
    try { reactRoot.unmount() } catch {}
    root.innerHTML = ''
  }
}

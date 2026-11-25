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

/** @param {HTMLElement} root @param {import('@ekko-studio/plugin-sdk').ClientContext} ctx */
export async function mount(root, ctx) {
  ensureStyles()
  root.lang = 'zh-CN'
  const reactRoot = createRoot(root)
  reactRoot.render(<App ctx={wrapClientContext(ctx)} />)
  return () => {
    try { reactRoot.unmount() } catch {}
    root.innerHTML = ''
  }
}

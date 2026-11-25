import React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, Keyboard } from '@phosphor-icons/react'

const SHORTCUT_ROWS = [
  { label: '搜索', keys: '⌘K' },
  { label: '搜索任务', keys: '⌘P' },
  { label: '搜索话题', keys: '⌘J' },
  { label: '新建任务', keys: '⌘N' },
  { label: '返回', keys: '⌘[' },
  { label: '显示或隐藏侧边栏', keys: '⌘B' },
  { label: '上一个话题（工作台）', keys: '⌥↑' },
  { label: '下一个话题（工作台）', keys: '⌥↓' },
  { label: '显示或隐藏右侧栏', keys: '⌘⌥B' },
  { label: '最大化或还原右侧栏', keys: '⌘⇧Enter' },
  { label: '新建任务（未输入时）', keys: 'N' },
  { label: '刷新任务 Diff', keys: '⌘⌥S' },
  { label: '确认 / 合并任务', keys: '⌘⌥Enter' },
  { label: '打开设置', keys: '⌘,' },
  { label: '快捷键', keys: '⌘/' },
  { label: '关闭', keys: 'Esc' },
]

export function ShortcutsDialog({ open, onOpenChange }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content
          className="ot-modal ot-shortcuts-modal"
          aria-label="快捷键一览"
          data-testid="shortcuts-dialog"
        >
          <div className="ot-shortcuts-head">
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <Keyboard size={16} weight="duotone" style={{ color: 'var(--ot-text-2)' }} />
              <Dialog.Title className="ot-dialog-title" style={{ fontSize: 'var(--ot-fs-md)' }}>快捷键</Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="ot-icon-btn" aria-label="关闭">
                <X size={15} />
              </button>
            </Dialog.Close>
          </div>
          <div className="ot-shortcuts-card" role="list">
            {SHORTCUT_ROWS.map((row, idx) => (
              <div key={idx} className="ot-shortcuts-row" role="listitem">
                <span className="ot-shortcuts-label">{row.label}</span>
                <kbd className="ot-shortcuts-badge">{row.keys}</kbd>
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

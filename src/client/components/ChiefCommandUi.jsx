// v0.9.43 (Todo #29): context capsule, manual-compress button, confirm dialog and slash-command panel of the
// Chief chat. Pure presentation: decisions come from ../chief-commands.js, actions from the props.
import React, { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowsInSimple, CircleNotch, TerminalWindow, X } from '@phosphor-icons/react'
import { COMMAND_CONFIRM_COPY, contextCapsule, compressGate, emptySlashHint, formatTokenCount } from '../chief-commands.js'

function useSecondsSince(startedAt) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!startedAt) return undefined
    const timer = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0
}

/**
 * "上下文 12.3万 / 25.6万 (48%)" plus the compress button. While a compression runs (this page's or the
 * host's automatic one) the capsule shows the elapsed seconds and the button is disabled.
 */
// Below this composer width the capsule shows the percent only and the button its icon only (the chat column
// is about 400px wide next to the board at 1440).
export const CAPSULE_COMPACT_BELOW = 560

function useCompactHeader(ref) {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const el = ref.current?.closest('.ot-composer-bar')
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => { const w = el.clientWidth; if (w > 0) setCompact(w < CAPSULE_COMPACT_BELOW) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return compact
}

export function ChiefContextCapsule({ info, gateState, compressing, compressStartedAt, onCompress }) {
  const rootRef = useRef(null)
  const compact = useCompactHeader(rootRef)
  const capsule = contextCapsule({ tokens: info?.tokens, window: info?.window, threshold: info?.threshold })
  const gate = compressGate(gateState)
  // A compression without a known start (automatic, or after a reload) counts from when it was first shown.
  const shownSinceRef = useRef(0)
  if (!compressing) shownSinceRef.current = 0
  else if (!shownSinceRef.current) shownSinceRef.current = Date.now()
  const since = compressing ? (compressStartedAt || shownSinceRef.current) : 0
  const shortLabel = capsule.percent === null ? '上下文' : `${Math.round(capsule.percent)}%`
  const seconds = useSecondsSince(since)
  const thresholdPct = Math.round((Number(info?.threshold) || 0) * 100)
  const title = compressing
    ? '宿主正在压缩大总管上下文'
    : `${capsule.label}。宿主在约 ${capsule.triggerTokens ? formatTokenCount(capsule.triggerTokens) : '—'}（${thresholdPct}%）时自动压缩；也可以手动压缩。`
  return (
    <div ref={rootRef} className={`ot-ctx-capsule is-${compressing ? 'busy' : capsule.level}${compact ? ' is-compact' : ''}`} data-testid="chief-context-capsule">
      <span className="ot-ctx-capsule-label" title={title} data-testid="chief-context-label">
        {compressing ? (
          <>
            <CircleNotch size={12} className="ot-spin" />
            <span>压缩中 {seconds}s</span>
          </>
        ) : (
          <>
            <span className="ot-ctx-capsule-long">{capsule.label}</span>
            <span className="ot-ctx-capsule-short">{shortLabel}</span>
          </>
        )}
      </span>
      <button
        type="button"
        className="ot-ctx-compress-btn"
        onClick={onCompress}
        disabled={compressing || !gate.ok}
        title={compressing ? '正在压缩' : (gate.ok ? '手动压缩大总管上下文' : gate.reason)}
        aria-label={compressing ? '正在压缩上下文' : (gate.ok ? '压缩上下文' : `压缩不可用：${gate.reason}`)}
        data-testid="btn-compress-context"
      >
        <ArrowsInSimple size={13} weight="bold" />
        <span className="ot-ctx-compress-text">压缩</span>
        {/* Phone: the whole capsule is this one 40px button, so the percent sits inside it. */}
        {!compressing && <span className="ot-ctx-compress-pct">{shortLabel}</span>}
      </button>
    </div>
  )
}

export function CommandConfirmDialog({ command, onCancel, onConfirm }) {
  const copy = command ? (COMMAND_CONFIRM_COPY[command.action] || null) : null
  return (
    <Dialog.Root open={Boolean(copy)} onOpenChange={v => { if (!v) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-modal ot-modal--sm" onOpenAutoFocus={e => e.preventDefault()} data-testid="command-confirm-dialog">
          <div className="ot-dialog-head">
            <Dialog.Title className="ot-dialog-title">{copy?.title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="ot-icon-btn" aria-label="关闭"><X size={16} /></button>
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <div className="ot-dialog-body ot-cmd-confirm-body">
              {copy?.body.map(line => <p key={line}>{line}</p>)}
            </div>
          </Dialog.Description>
          <div className="ot-dialog-foot">
            <button type="button" className="ot-btn" onClick={onCancel} data-testid="btn-command-cancel">取消</button>
            <button type="button" className="ot-btn ot-btn--primary" onClick={onConfirm} data-testid="btn-command-confirm">{copy?.action}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The panel that opens when the composer starts with "/". Rows are pressed with the mouse or Enter. */
export function SlashCommandPanel({ query, candidates, activeIndex, onPick, onHover }) {
  return (
    <div className="ot-mention-popover ot-slash-popover" data-testid="slash-command-panel" role="listbox" aria-label="选择命令">
      <div className="ot-mention-head" data-testid="slash-command-head">
        {candidates.length > 0 ? '宿主斜杠命令（↑↓ 切换 · 回车选择 · Esc 关闭）' : '没有匹配的命令（Esc 关闭）'}
      </div>
      <div className="ot-mention-list">
        {candidates.length === 0 && (
          <div className="ot-mention-empty" data-testid="slash-command-empty">{emptySlashHint(query)}</div>
        )}
        {candidates.map((cmd, idx) => (
          <button
            key={cmd.name}
            type="button"
            role="option"
            aria-selected={idx === activeIndex}
            className={`ot-mention-item ot-slash-item ${idx === activeIndex ? 'is-active' : ''}`}
            onMouseDown={e => { e.preventDefault(); onPick(cmd) }}
            onMouseEnter={() => onHover(idx)}
            data-testid={`slash-opt-${cmd.name}`}
          >
            <TerminalWindow size={16} weight="regular" />
            <span className="ot-slash-name">/{cmd.name}{cmd.args ? ` <${cmd.args}>` : ''}</span>
            <span className="ot-slash-label">{cmd.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

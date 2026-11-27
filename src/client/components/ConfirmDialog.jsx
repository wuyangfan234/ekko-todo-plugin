import React, { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, WarningCircle } from '@phosphor-icons/react'
import { settleAction } from '../interaction.js'

/**
 * Todo #100: the one confirmation step of every destructive action (delete agent / memory / schedule /
 * topic / quota source) and of the ⌘⌥↵ merge. `request` = { copy, run } or null (closed); copy comes from
 * dangerCopy() / quickConfirmPlan().confirm. The action button is disabled while `run` is in flight; a
 * failure stays in the dialog with its reason so the user can retry or cancel.
 */
export function ConfirmDialog({ request, onClose }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setPending(false); setError('') }, [request])

  const copy = request?.copy || null
  const confirm = async () => {
    if (!request || pending) return
    setPending(true)
    setError('')
    const out = await settleAction(request.run)
    setPending(false)
    if (out.ok) onClose()
    else setError(out.error)
  }

  return (
    <Dialog.Root open={Boolean(copy)} onOpenChange={v => { if (!v && !pending) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-modal ot-modal--sm" onOpenAutoFocus={e => e.preventDefault()} data-testid="confirm-dialog">
          <div className="ot-dialog-head">
            <Dialog.Title className="ot-dialog-title" data-testid="confirm-dialog-title">{copy?.title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="ot-icon-btn" aria-label="关闭" disabled={pending}><X size={16} /></button>
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <div className="ot-dialog-body ot-cmd-confirm-body" data-testid="confirm-dialog-body">
              {copy?.name && <p><strong data-testid="confirm-dialog-name">「{copy.name}」</strong></p>}
              {(copy?.body || []).map(line => <p key={line}>{line}</p>)}
              {error && (
                <div className="ot-delete-confirm" role="alert" style={{ margin: 0 }} data-testid="confirm-dialog-error">
                  <span><WarningCircle size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />{error}</span>
                </div>
              )}
            </div>
          </Dialog.Description>
          <div className="ot-dialog-foot">
            <button type="button" className="ot-btn" onClick={onClose} disabled={pending} data-testid="btn-confirm-cancel">取消</button>
            <button
              type="button"
              className={`ot-btn ${copy?.tone === 'primary' ? 'ot-btn--primary' : 'ot-btn--danger'}`}
              onClick={confirm}
              disabled={pending}
              data-testid="btn-confirm-action"
            >
              {pending ? copy?.pending : error ? `重试：${copy?.action}` : copy?.action}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** [ask, node, open]: `ask(copy, run)` opens the dialog; render `node` once in the component. */
export function useConfirm() {
  const [request, setRequest] = useState(null)
  const ask = useCallback((copy, run) => setRequest({ copy, run }), [])
  const close = useCallback(() => setRequest(null), [])
  return [ask, <ConfirmDialog key="ot-confirm" request={request} onClose={close} />, Boolean(request)]
}

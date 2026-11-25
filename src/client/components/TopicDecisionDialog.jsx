import React, { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X, ArrowLeft, CheckCircle, Circle, PaperPlaneTilt, BellRinging, ChatCircleText, Sparkle } from '@phosphor-icons/react'
import { ProjectAvatar } from './AvatarKit.jsx'
import { resolveWaitingOptions, resolveChiefRecommendation, formatRelativeTime, getProjectLabel, isImeComposingEvent } from '../utils.js'

/**
 * Interactive approval modal for Topic-level "waitingOnYou" decisions
 * surfaced both in the Kanban "待你处理" column and in the Topic Brief card.
 * Automatically pre-selects Chief's recommended option and pre-fills Chief's advice
 * directly into the decision textarea so users can confirm in one click or refine.
 */
export function TopicDecisionDialog({ topic, project, busy, onClose, onSubmitDecision }) {
  const [selectedOptId, setSelectedOptId] = useState('')
  const [note, setNote] = useState('')
  const [userEditedNote, setUserEditedNote] = useState(false)
  const composingRef = useRef(false)
  const compEndRef = useRef(0)

  const open = Boolean(topic && topic.brief?.waitingOnYou)
  const { options, inferred } = resolveWaitingOptions(topic?.brief)
  const defaultRecommendation = resolveChiefRecommendation(topic?.brief, topic?.messages)

  useEffect(() => {
    if (open) {
      const recOpt = options.find(o => o.recommended) || options[0] || null
      setSelectedOptId(recOpt?.id || '')
      setNote(defaultRecommendation)
      setUserEditedNote(false)
    }
  }, [open, topic?.id, topic?.brief?.waitingOnYou, topic?.brief?.waitingRecommendation])

  const selectedOpt = options.find(o => o.id === selectedOptId) || null
  const canSubmit = !busy && Boolean(selectedOpt || note.trim())

  const handleSelectOption = opt => {
    const nextId = selectedOptId === opt.id ? '' : opt.id
    setSelectedOptId(nextId)
    if (!userEditedNote) {
      if (!nextId) {
        setNote(defaultRecommendation)
      } else if (opt.recommended && defaultRecommendation) {
        setNote(defaultRecommendation)
      } else {
        setNote(opt.label)
      }
    }
  }

  const handleConfirm = async () => {
    if (!topic || busy) return
    await onSubmitDecision?.({
      topicId: topic.id,
      optionId: selectedOpt?.id || '',
      optionLabel: selectedOpt?.label || '',
      note: note.trim(),
      notifyChief: true,
    })
    onClose?.()
  }

  const handleDismissOnly = async () => {
    if (!topic || busy) return
    await onSubmitDecision?.({
      topicId: topic.id,
      optionId: selectedOpt?.id || '',
      optionLabel: selectedOpt?.label || '',
      note: note.trim(),
      notifyChief: false,
    })
    onClose?.()
  }

  const keys = ['A', 'B', 'C', 'D']

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!v) onClose?.() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-modal ot-modal--sm ot-decision-modal" style={{ width: 'min(540px, 94vw)' }} data-testid="topic-decision-dialog">
          {topic && (
            <>
              <div className="ot-dialog-head">
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0, flex: 1 }}>
                  <button
                    type="button"
                    className="ot-mobile-back-btn"
                    onClick={() => onClose?.()}
                    aria-label="返回"
                  >
                    <ArrowLeft size={16} weight="bold" />
                    <span>返回</span>
                  </button>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span className="ot-decision-badge">
                        <BellRinging size={11} weight="fill" />
                        <span>待你批复</span>
                      </span>
                      {project && (
                        <ProjectAvatar project={project} size={18} title={getProjectLabel(project)} />
                      )}
                      <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ChatCircleText size={12} />
                        <span>{topic.title}</span>
                      </span>
                      {topic.brief?.updatedAt > 0 && (
                        <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                          · {formatRelativeTime(topic.brief.updatedAt)}
                        </span>
                      )}
                    </div>
                    <Dialog.Title className="ot-dialog-title">
                      {topic.brief?.waitingTitle || '大总管正在等待你的决策确认'}
                    </Dialog.Title>
                  </div>
                </div>
                <Dialog.Close asChild>
                  <button type="button" className="ot-icon-btn ot-desktop-only" style={{ marginRight: -4 }} aria-label="关闭">
                    <X size={16} />
                  </button>
                </Dialog.Close>
              </div>

              <div className="ot-dialog-body">
                <div className="ot-decision-callout" data-testid="decision-prompt-text">
                  <div className="ot-decision-callout-label">待拍板事项</div>
                  <div className="ot-decision-callout-body">{topic.brief?.waitingOnYou}</div>
                </div>

                {(topic.brief?.goal || topic.brief?.progress) && (
                  <div className="ot-decision-ctx">
                    {topic.brief.goal && (
                      <div className="ot-brief-row">
                        <span className="ot-brief-label">目标</span>
                        <span style={{ color: 'var(--ot-text-2)' }}>{topic.brief.goal}</span>
                      </div>
                    )}
                    {topic.brief.progress && (
                      <div className="ot-brief-row">
                        <span className="ot-brief-label">当前</span>
                        <span style={{ color: 'var(--ot-text-2)' }}>{topic.brief.progress}</span>
                      </div>
                    )}
                  </div>
                )}

                {options.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                      <span style={{ fontWeight: 600 }}>选择你的决定</span>
                      {inferred && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                          <Sparkle size={11} />
                          <span>已从问题自动提炼选项</span>
                        </span>
                      )}
                    </div>
                    <div className="ot-qbox-opts">
                      {options.map((opt, idx) => {
                        const active = selectedOptId === opt.id
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            className={`ot-qopt ${active ? 'is-selected' : ''}`}
                            onClick={() => handleSelectOption(opt)}
                            data-testid={`decision-opt-${opt.id}`}
                          >
                            <span className="ot-qopt-left">
                              <span className={`ot-qopt-idx ${active ? 'is-selected' : ''}`}>{keys[idx] || idx + 1}</span>
                              <span>{opt.label}</span>
                            </span>
                            {active ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
                                {opt.recommended && <span className="ot-qopt-rec">大总管推荐</span>}
                                <CheckCircle size={16} weight="fill" style={{ color: 'var(--ot-dot-confirm)', flex: 'none' }} />
                              </span>
                            ) : (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
                                {opt.recommended && <span className="ot-qopt-rec">大总管推荐</span>}
                                <Circle size={15} weight="regular" style={{ color: 'var(--ot-border)' }} />
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                <label className="ot-field-label">
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span>批复决定内容</span>
                      {defaultRecommendation && !userEditedNote && (
                        <span className="ot-qopt-rec" data-testid="decision-prefilled-badge">已默认填入大总管建议</span>
                      )}
                    </span>
                    <kbd className="ot-kbd ot-desktop-only">⌘↵ 提交</kbd>
                  </span>
                  <textarea
                    className="ot-input ot-textarea-v ot-decision-textarea"
                    rows={3}
                    value={note}
                    onChange={e => { setNote(e.target.value); setUserEditedNote(true) }}
                    onCompositionStart={() => { composingRef.current = true }}
                    onCompositionEnd={() => { composingRef.current = false; compEndRef.current = Date.now() }}
                    placeholder="已自动填入大总管建议，可直接提交或按需修改…"
                    data-testid="decision-note-input"
                    onKeyDown={e => {
                      if (isImeComposingEvent(e, composingRef, compEndRef)) return
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) {
                        e.preventDefault()
                        void handleConfirm()
                      }
                    }}
                  />
                </label>
              </div>

              <div className="ot-dialog-foot ot-decision-foot" style={{ justifyContent: 'space-between' }}>
                <button
                  type="button"
                  className="ot-ghost-link"
                  style={{ whiteSpace: 'nowrap' }}
                  disabled={busy}
                  onClick={handleDismissOnly}
                  title="从「待你处理」看板移除此条待办，不向大总管发消息"
                  data-testid="btn-decision-dismiss"
                >
                  <span className="ot-desktop-only">忽略此待办（不通知总管）</span>
                  <span className="ot-mobile-only">忽略待办</span>
                </button>
                <div style={{ display: 'inline-flex', gap: 8, flex: 'none' }}>
                  <Dialog.Close asChild>
                    <button type="button" className="ot-btn">稍后决定</button>
                  </Dialog.Close>
                  <button
                    type="button"
                    className="ot-btn ot-btn--primary"
                    disabled={!canSubmit}
                    onClick={handleConfirm}
                    data-testid="btn-decision-submit"
                  >
                    <PaperPlaneTilt size={13} weight="fill" />
                    <span className="ot-desktop-only">提交批复并通知总管</span>
                    <span className="ot-mobile-only">提交批复</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

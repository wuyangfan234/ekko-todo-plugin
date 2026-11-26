import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import * as Popover from '@radix-ui/react-popover'
import { m } from 'motion/react'
import { LocalAwareHtml, LocalAwareText, renderChatMarkdown } from './LocalFilePreview.jsx'
import { openLocalFile, isImagePath } from '../local-files.js'
import { LoopLiveNotice, LoopStoppedNotice } from './LoopNotice.jsx'
import { isLoopStopNotice } from '../../shared/loop-guard.mjs'
import { mergeOptimisticMessages, messageKey, sendStateOf } from '../optimistic-send.js'
import { clearDraft, getDraftStorage, loadDraft, makeImageThumb, REUPLOAD_LABEL, saveDraft, sendableAttachments } from '../composer-draft.js'
import { applyMention, emptyMentionHint, filterMentionCandidates, findMentionTrigger, mentionEnterAction, pressMentionButton } from '../mention.js'
import { commandGate, filterSlashCommands, findSlashTrigger, parseSlashCommand, resolveSlashPick, SLASH_COMMANDS, slashEnterAction } from '../chief-commands.js'
import { ChiefContextCapsule, CommandConfirmDialog, SlashCommandPanel } from './ChiefCommandUi.jsx'
import { TopicProjectDialog } from './Dialogs.jsx'
import {
  SidebarSimple,
  Robot,
  Kanban,
  ArrowUp,
  Plus,
  Stop,
  CheckCircle,
  Copy,
  Check,
  FolderPlus,
  GithubLogo,
  Brain,
  CaretDown,
  CaretRight,
  CaretUp,
  Wrench,
  WarningCircle,
  CircleNotch,
  NoteBlank,
  DotsThree,
  PencilSimple,
  PushPin,
  Archive,
  FolderSimple,
  Trash,
  X,
  PaperPlaneTilt,
  BellRinging,
  Paperclip,
  At,
  FileText,
  FileCode,
  FileImage,
  FileVideo,
  FileArchive,
  LinkSimple,
  Compass,
  Export,
  Queue,
  Lightning,
  ShieldCheck,
  ListMagnifyingGlass,
} from '@phosphor-icons/react'
import { QuickChiefPopover } from './QuickChiefPopover.jsx'
import { BrandLogo } from './BrandLogo.jsx'
import { AgentAvatar } from './AvatarKit.jsx'
import { briefStartsCollapsed, pickBriefSummaryRow, PHONE_MAX_WIDTH } from '../layout.js'
import {
  formatDuration,
  formatLiveClock,
  formatShortClock,
  formatMessageTimeDivider,
  shouldShowTimeDivider,
  isImeComposingEvent,
  formatTokens,
  formatFileSize,
  resolveWaitingOptions,
  resolveChiefRecommendation,
  getAgentRoleLabel,
  ENGINE_LABEL,
} from '../utils.js'

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const CODE_EXT_RE = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|zsh|bash|sql|json|yaml|yml|toml|xml|html|css|scss|vue|svelte|dockerfile|env|ini|conf|log)$/i
const MEDIA_EXT_RE = /\.(mp4|mov|webm|mkv|avi|mp3|wav|m4a|flac|ogg|aac)$/i
const ARCHIVE_EXT_RE = /\.(zip|tar|gz|tgz|rar|7z)$/i
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i

function AttachmentIcon({ att, size = 14 }) {
  const name = String(att?.name || '')
  const mime = String(att?.mediaType || att?.media_type || '').toLowerCase()
  if (att?.type === 'image' || mime.startsWith('image/') || IMAGE_EXT_RE.test(name)) {
    return <FileImage size={size} weight="duotone" />
  }
  if (mime.startsWith('video/') || mime.startsWith('audio/') || MEDIA_EXT_RE.test(name)) {
    return <FileVideo size={size} weight="duotone" />
  }
  if (CODE_EXT_RE.test(name)) {
    return <FileCode size={size} weight="duotone" />
  }
  if (ARCHIVE_EXT_RE.test(name)) {
    return <FileArchive size={size} weight="duotone" />
  }
  return <FileText size={size} weight="duotone" />
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const str = String(reader.result || '')
      const idx = str.indexOf(',')
      resolve(idx >= 0 ? str.slice(idx + 1) : str)
    }
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

function renderMarkdown(md) {
  return renderChatMarkdown(md)
}

function InlineQuestionCard({ todo, onAnswer, busy }) {
  const [custom, setCustom] = useState('')
  const composingRef = useRef(false)
  const compEndRef = useRef(0)
  const keys = ['A', 'B', 'C', 'D']
  useEffect(() => {
    if (!todo?.question?.active) return
    const rec = (todo.question.options || []).find(o => o.recommended) || (todo.question.options || [])[0]
    setCustom(rec?.label || '')
  }, [todo?.id, todo?.question?.active, todo?.question?.version])
  if (!todo?.question?.active) return null

  return (
    <m.div
      className="ot-qbox"
      data-testid={`question-card-${todo.id}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <div className="ot-qbox-title">#{todo.number} {todo.question.title}</div>
      {todo.question.why && <div className="ot-qbox-why">{todo.question.why}</div>}
      <div className="ot-qbox-opts">
        {todo.question.options.map((opt, idx) => (
          <button
            key={opt.id}
            type="button"
            className="ot-qopt"
            disabled={busy}
            data-testid={`qopt-${todo.id}-${opt.id}`}
            onClick={() => onAnswer(todo.id, opt.id, '')}
          >
            <span className="ot-qopt-left">
              <span className="ot-qopt-idx">{keys[idx] || idx + 1}</span>
              <span>{opt.label}</span>
            </span>
            {opt.recommended && <span className="ot-qopt-rec">推荐</span>}
          </button>
        ))}
      </div>
      <div className="ot-qbox-custom">
        <input
          type="text"
          className="ot-input"
          value={custom}
          onChange={e => setCustom(e.target.value)}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false; compEndRef.current = Date.now() }}
          placeholder="输入自定义意见..."
          onKeyDown={e => {
            if (isImeComposingEvent(e, composingRef, compEndRef)) return
            if (e.key === 'Enter' && custom.trim()) {
              onAnswer(todo.id, '', custom.trim())
              setCustom('')
            }
          }}
        />
        <button
          type="button"
          className="ot-btn ot-btn--primary"
          disabled={busy || !custom.trim()}
          onClick={() => {
            if (!custom.trim()) return
            onAnswer(todo.id, '', custom.trim())
            setCustom('')
          }}
        >
          提交
        </button>
      </div>
    </m.div>
  )
}

function TopicBriefCard({ topic, busy, onClearWaiting, onOpenDecision }) {
  const b = topic?.brief || {}
  const { options } = resolveWaitingOptions(b)
  const defaultAdvice = useMemo(
    () => resolveChiefRecommendation(b, topic?.messages),
    [b.waitingOnYou, b.waitingRecommendation, b.waitingOptions, topic?.messages?.length],
  )
  const [reply, setReply] = useState('')
  const [replyEdited, setReplyEdited] = useState(false)
  const briefComposingRef = useRef(false)
  const briefCompEndRef = useRef(0)
  // Phone: the pinned brief folds to one line so the conversation keeps the screen; a pending decision opens it.
  const startsCollapsed = () => briefStartsCollapsed({
    phone: typeof window !== 'undefined' && window.innerWidth <= PHONE_MAX_WIDTH,
    waiting: Boolean(b.waitingOnYou),
  })
  const [collapsed, setCollapsed] = useState(startsCollapsed)
  useEffect(() => {
    setCollapsed(startsCollapsed())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic?.id])
  useEffect(() => {
    if (b.waitingOnYou) setCollapsed(false)
  }, [b.waitingOnYou])

  useEffect(() => {
    if (b.waitingOnYou) {
      setReply(defaultAdvice)
      setReplyEdited(false)
    } else {
      setReply('')
      setReplyEdited(false)
    }
  }, [topic?.id, b.waitingOnYou, b.waitingRecommendation, defaultAdvice])

  const rows = [
    ['目标', b.goal],
    ['当前', b.progress],
    ['下一步', b.next],
    ['等你', b.waitingOnYou],
    ['卡住', b.blocked],
  ].filter(([, val]) => Boolean(val))
  if (!rows.length) return null

  const submitReply = (opt = null) => {
    const clean = reply.trim()
    if (!opt && !clean) {
      onOpenDecision?.(topic.id)
      return
    }
    setReply('')
    setReplyEdited(false)
    onClearWaiting?.({
      topicId: topic.id,
      optionId: opt?.id || '',
      optionLabel: opt?.label || '',
      note: opt ? '' : clean,
      notifyChief: true,
    })
  }

  const summaryRow = pickBriefSummaryRow(rows)

  return (
    <div className={`ot-brief-card ${b.waitingOnYou ? 'has-waiting' : ''} ${collapsed ? 'is-collapsed' : ''}`} data-testid="topic-brief-card">
      <button
        type="button"
        className="ot-brief-toggle"
        onClick={() => setCollapsed(v => !v)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开话题简报' : '收起话题简报'}
        title={collapsed ? '展开话题简报' : '收起话题简报'}
        data-testid="btn-brief-toggle"
      >
        {collapsed && summaryRow && (
          <>
            <span className={`ot-brief-label ${summaryRow[0] === '等你' ? 'is-waiting' : ''}`}>{summaryRow[0]}</span>
            <span className="ot-brief-summary-text">{summaryRow[1]}</span>
          </>
        )}
        {collapsed ? <CaretDown size={12} /> : <CaretUp size={12} />}
      </button>
      {!collapsed && rows.map(([label, val]) => (
        <div key={label} className={`ot-brief-row ${label === '等你' ? 'is-waiting' : ''}`}>
          <span className="ot-brief-label">
            {label === '等你' && <BellRinging size={11} weight="fill" style={{ marginRight: 3, verticalAlign: '-1px' }} />}
            {label}
          </span>
          <div className="ot-brief-val">
            <span>{val}</span>
          </div>
        </div>
      ))}
      {!collapsed && b.waitingOnYou && (
        <div className="ot-brief-approve" data-testid="brief-waiting-actions">
          {options.length > 0 && (
            <div className="ot-brief-opt-row">
              {options.map((opt, idx) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`ot-brief-opt-chip ${opt.recommended ? 'is-rec' : ''}`}
                  disabled={busy}
                  onClick={() => submitReply(opt)}
                  data-testid={`brief-opt-${opt.id}`}
                  title={`一键批复选择「${opt.label}」并通知大总管`}
                >
                  <span className="ot-brief-opt-key">{['A', 'B', 'C', 'D'][idx] || idx + 1}</span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          )}
          <div className="ot-brief-input-row">
            <input
              type="text"
              className="ot-input ot-input--sm"
              style={{ flex: 1, minHeight: 28, height: 28, fontSize: 'var(--ot-fs-xs)' }}
              value={reply}
              onChange={e => { setReply(e.target.value); setReplyEdited(true) }}
              onCompositionStart={() => { briefComposingRef.current = true }}
              onCompositionEnd={() => { briefComposingRef.current = false; briefCompEndRef.current = Date.now() }}
              placeholder="已填入大总管建议，可直接回车批复或修改…"
              title={!replyEdited && defaultAdvice ? '已默认填入大总管建议，可直接发送或按需修改' : ''}
              data-testid="brief-reply-input"
              onKeyDown={e => {
                if (isImeComposingEvent(e, briefComposingRef, briefCompEndRef)) return
                if (e.key === 'Enter' && reply.trim()) {
                  e.preventDefault()
                  submitReply(null)
                }
              }}
            />
            <button
              type="button"
              className="ot-btn ot-btn--primary ot-btn--sm"
              style={{ height: 28, padding: '0 9px', fontSize: 'var(--ot-fs-xs)' }}
              disabled={busy}
              onClick={() => submitReply(null)}
              data-testid="btn-brief-approve"
              title={reply.trim() ? '提交批复并唤醒大总管' : '打开完整批复确认弹窗'}
            >
              <PaperPlaneTilt size={11} weight="fill" />
              <span>{reply.trim() ? '批复发送' : '批复确认'}</span>
            </button>
            <button
              type="button"
              className="ot-btn ot-btn--sm"
              style={{ height: 28, padding: '0 8px', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}
              disabled={busy}
              onClick={() => onClearWaiting?.({ topicId: topic.id, note: '', notifyChief: false })}
              title="忽略此待确认提示（不通知总管）"
              data-testid="btn-brief-dismiss"
            >
              忽略
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const ChiefMessage = memo(function ChiefMessage({ message, chiefAgent, topicTitle, todos, onOpenTodo, onAnswerQuestion, busy }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [exported, setExported] = useState(false)
  const html = useMemo(() => renderMarkdown(message.text), [message.text])
  const isLong = String(message.text || '').length > 420 && !message.questionTodoId
  const linkedQuestionTodo = message.questionTodoId
    ? todos.find(t => t.id === message.questionTodoId)
    : null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.text || '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {}
  }

  const handleExportMd = () => {
    try {
      const slug = String(topicTitle || 'ekko-todo').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 32) || 'ekko-todo'
      const stamp = formatShortClock(message.createdAt).replace(':', '') || 'msg'
      const blob = new Blob([String(message.text || '')], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}-${stamp}.md`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExported(true)
      setTimeout(() => setExported(false), 1500)
    } catch {}
  }

  if (message.kind === 'system' && isLoopStopNotice(message.text)) {
    return <LoopStoppedNotice text={message.text} />
  }

  if (message.kind === 'system') {
    return (
      <div className="ot-msg-meta" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="ot-progress-trace"
          onClick={() => message.todoId && onOpenTodo(message.todoId)}
        >
          <CheckCircle size={13} weight="regular" />
          <span>{message.progressNotice || message.text}</span>
        </button>
      </div>
    )
  }

  const clockStr = formatShortClock(message.createdAt)
  const durationStr = message.durationMs > 0 ? formatDuration(message.durationMs) : ''
  const statusLabel = durationStr
    ? `完成 ${durationStr}${clockStr ? ` · ${clockStr}` : ''}`
    : (clockStr ? `完成 · ${clockStr}` : '完成')

  return (
    <m.div
      className="ot-msg-chief-row"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
    >
      <div className="ot-msg-chief-avatar">
        <AgentAvatar agent={chiefAgent} role="chief" size={26} />
      </div>
      <div className="ot-msg-chief">
        <div className={`ot-md-wrap ${isLong && !expanded ? 'is-clamped' : ''}`}>
          <LocalAwareHtml className="ot-md" html={html} />
          {isLong && !expanded && <div className="ot-md-fade" aria-hidden="true" />}
        </div>

        {linkedQuestionTodo && (
          <InlineQuestionCard todo={linkedQuestionTodo} onAnswer={onAnswerQuestion} busy={busy} />
        )}

        <div className="ot-msg-actionbar" data-testid={`msg-actionbar-${message.id}`}>
          <div className="ot-msg-actionbar-left">
            <button
              type="button"
              className={`ot-msg-act-btn ${copied ? 'is-done' : ''}`}
              onClick={handleCopy}
              title={copied ? '已复制到剪贴板' : '复制完整消息'}
              aria-label="复制消息"
              data-testid={`btn-copy-msg-${message.id}`}
            >
              {copied ? <Check size={13} weight="bold" /> : <Copy size={13} weight="regular" />}
            </button>
            <button
              type="button"
              className={`ot-msg-act-btn ${exported ? 'is-done' : ''}`}
              onClick={handleExportMd}
              title={exported ? '已导出 Markdown' : '导出为 Markdown 文件'}
              aria-label="导出消息"
              data-testid={`btn-export-msg-${message.id}`}
            >
              {exported ? <Check size={13} weight="bold" /> : <Export size={13} weight="regular" />}
            </button>
            {isLong && (
              <button
                type="button"
                className="ot-msg-expand-link"
                onClick={() => setExpanded(v => !v)}
                data-testid={`btn-expand-msg-${message.id}`}
              >
                {expanded ? '收起消息' : '展开完整消息'}
              </button>
            )}
            <span className="ot-msg-act-sep" aria-hidden="true" />
            <span className="ot-msg-act-status" title={formatMessageTimeDivider(message.createdAt)} data-testid={`msg-status-${message.id}`}>
              {statusLabel}
            </span>
          </div>
          {message.progressNotice && (
            <button
              type="button"
              className="ot-progress-trace"
              onClick={() => message.todoId && onOpenTodo(message.todoId)}
            >
              <CheckCircle size={13} weight="regular" />
              <span>{message.progressNotice}</span>
            </button>
          )}
        </div>
      </div>
    </m.div>
  )
})

// The streamed answer of a turn that already ended but is not in the saved message list yet. The server
// saves it on its own (it polls the host transcript); this copy only bridges the gap so the answer does not
// vanish for a few seconds. After 8s it says the page keeps retrying and offers "sync now".
// `sync`: result of the last manual sync { state: 'saving' | 'saved' | 'still-unsaved' | 'failed', reason }.
// 'saved' is shown briefly as a slim note after the held copy is gone (the answer is in the list by then).
function HeldReplyBlock({ held, sync, onRetry }) {
  const html = useMemo(() => (held?.text ? renderMarkdown(held.text) : ''), [held?.text])
  const syncState = sync?.state || ''
  if (!html) {
    if (syncState !== 'saved') return null
    return (
      <div className="ot-held-reply-note ot-held-reply-synced" role="status" data-testid="held-reply-sync-result" data-sync-state="saved">
        <CheckCircle size={13} weight="regular" />
        <span>已同步</span>
      </div>
    )
  }
  const pending = held.status === 'pending'
  const saving = syncState === 'saving'
  const showButton = pending || saving || syncState === 'still-unsaved' || syncState === 'failed'
  let note = pending ? '这条回复还在同步，页面会自动重试' : '正在保存这条回复…'
  if (saving) note = '正在同步…'
  else if (syncState === 'still-unsaved') note = '还没同步上，稍后会自动再试'
  else if (syncState === 'failed') note = `同步失败：${sync?.reason || ''}`
  const showReason = syncState === 'still-unsaved' && sync?.reason
  return (
    <div className="ot-msg-chief ot-live-block ot-held-reply" data-testid="held-reply" data-status={held.status} data-sync-state={syncState || 'idle'}>
      <div className="ot-md">
        <LocalAwareHtml html={html} thumbnails />
      </div>
      <div className="ot-held-reply-note" role="status">
        {syncState && syncState !== 'saving' && syncState !== 'saved'
          ? (
            <span data-testid="held-reply-sync-result" data-sync-state={syncState}>
              {note}
              {showReason && <span className="ot-held-reply-reason">（{sync.reason}）</span>}
            </span>
          )
          : <span>{note}</span>}
        {showButton && (
          <button type="button" className="ot-btn ot-btn--sm" data-testid="held-reply-retry" title="重试同步" disabled={saving} aria-busy={saving || undefined} onClick={saving ? undefined : onRetry}>
            {saving ? '同步中…' : '立即同步'}
          </button>
        )}
      </div>
    </div>
  )
}

function LiveStreamBlock({ liveStream, isRunning }) {
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const [elapsedMs, setElapsedMs] = useState(0)
  const hasOutputText = Boolean(liveStream?.text)
  const hasReasoning = Boolean(liveStream?.reasoning)
  // The host's one-line status of the turn (`thinking.delta`); shown in the status bar below, never in the thinking box.
  const statusLine = liveStream?.status || ''
  const tools = liveStream?.tools || []
  const usage = liveStream?.usage || null

  useEffect(() => {
    if (hasOutputText && hasReasoning) setThinkingOpen(false)
  }, [hasOutputText, hasReasoning])

  useEffect(() => {
    if (!isRunning) return
    const started = liveStream?.startedAt || Date.now()
    const id = setInterval(() => setElapsedMs(Date.now() - started), 250)
    return () => clearInterval(id)
  }, [isRunning, liveStream?.startedAt])

  const renderedHtml = useMemo(
    () => (liveStream?.text ? renderMarkdown(liveStream.text) : ''),
    [liveStream?.text],
  )

  return (
    <m.div
      className="ot-msg-chief ot-live-block"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16 }}
      data-testid="live-stream-block"
    >
      {hasReasoning && (
        <Collapsible.Root open={thinkingOpen} onOpenChange={setThinkingOpen} className="ot-thinking-box">
          <Collapsible.Trigger asChild>
            <button type="button" className="ot-thinking-trigger">
              <span className="ot-thinking-left">
                <Brain size={13} weight="duotone" className={isRunning && !hasOutputText ? 'ot-pulse-icon' : ''} />
                <span>{isRunning && !hasOutputText ? '正在深度思考' : '思考过程'}</span>
                <span className="ot-thinking-meta">
                  {liveStream.reasoning.length} 字{elapsedMs > 0 ? ` · ${formatDuration(elapsedMs)}` : ''}
                </span>
              </span>
              {thinkingOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
            </button>
          </Collapsible.Trigger>
          <Collapsible.Content className="ot-thinking-content">
            <pre className="ot-thinking-pre">{liveStream.reasoning}</pre>
          </Collapsible.Content>
        </Collapsible.Root>
      )}

      {tools.length > 0 && (
        <div className="ot-tool-strip">
          {tools.slice(-6).map(t => (
            <div key={t.callId} className={`ot-tool-pill is-${t.status}`}>
              {t.status === 'running' ? (
                <CircleNotch size={12} className="ot-spin" />
              ) : t.status === 'failed' ? (
                <WarningCircle size={12} />
              ) : (
                <CheckCircle size={12} />
              )}
              <Wrench size={11} style={{ opacity: 0.65 }} />
              <span className="ot-tool-name">{t.name}</span>
            </div>
          ))}
        </div>
      )}

      {renderedHtml ? (
        <div className="ot-md ot-md--streaming">
          <LocalAwareHtml html={renderedHtml} thumbnails={!isRunning} />
          {isRunning && <span className="ot-caret" aria-hidden="true" />}
        </div>
      ) : null}

      {liveStream?.loop && <LoopLiveNotice />}

      {isRunning && (
        <div className="ot-streaming-bar">
          <span className="ot-pulse-dot" />
          <span>
            {tools.some(t => t.status === 'running')
              ? `正在调用工具 ${tools.find(t => t.status === 'running')?.name}...`
              : statusLine
                ? statusLine
                : hasReasoning && !hasOutputText
                  ? '正在推理与拆解方案...'
                  : '大总管正在响应...'}
          </span>
          {elapsedMs > 0 && <span className="ot-stream-stat">{formatDuration(elapsedMs)}</span>}
          {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) && (
            <span className="ot-stream-stat">
              ↑{formatTokens(usage.inputTokens)} ↓{formatTokens(usage.outputTokens)}
            </span>
          )}
        </div>
      )}
    </m.div>
  )
}

export function ChatPane({
  ctx,
  onOpenTrace,
  state,
  topic,
  projects,
  todos,
  liveStream,
  pendingSends,
  heldReply,
  heldSync,
  onRetryHeldSync,
  showSidebarTrigger,
  boardHidden,
  busy,
  composerFocusSeq,
  onToggleSidebar,
  onToggleBoard,
  onSendMessage,
  onCancelQueueItem,
  onPromoteQueueItem,
  onUploadFile,
  onStopRun,
  onToggleAutopilot,
  onRenameTopic,
  onUpdateTopicMeta,
  onDeleteTopic,
  onClearTopicWaiting,
  onOpenTopicDecision,
  onOpenTodo,
  onAnswerQuestion,
  onOpenCreateTask,
  onAddProject,
  onNewTopic,
  onQuickConfigureChief,
  onFetchModelCatalog,
  onOpenSettingsTab,
  onOpenAgents,
  onOpenOnboarding,
  chiefContext,
  onCompressContext,
  onRunSlashCommand,
}) {
  // v0.9.27: the composer is restored from a per-topic localStorage draft, so leaving the chat page
  // (board, quota, settings…) or reloading no longer wipes unsent text and uploaded files.
  const draftStorage = useMemo(() => getDraftStorage(), [])
  const draftTopicId = topic?.id || ''
  const [initialDraft] = useState(() => loadDraft(draftStorage, draftTopicId))
  const [draft, setDraft] = useState(initialDraft.text)
  const [attachedCards, setAttachedCards] = useState(initialDraft.cards)
  const [attachedFiles, setAttachedFiles] = useState(initialDraft.files)
  const [uploadingCount, setUploadingCount] = useState(0)
  const [mentionQuery, setMentionQuery] = useState(null) // null = closed, string = open filter
  const [mentionStart, setMentionStart] = useState(-1)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [mentionedIds, setMentionedIds] = useState([])
  // v0.9.43: slash-command panel (null = closed) and the command waiting for confirmation.
  const [slashQuery, setSlashQuery] = useState(null)
  // Start of the "/" token when the panel opened; a pick re-reads it at the caret (resolveSlashPick).
  const [, setSlashStart] = useState(-1)
  const [slashIdx, setSlashIdx] = useState(0)
  const [confirmCommand, setConfirmCommand] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [briefOpen, setBriefOpen] = useState(true)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [projectDialogTopicId, setProjectDialogTopicId] = useState('')

  const streamRef = useRef(null)
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)
  const autoScrollRef = useRef(true)
  const composerComposingRef = useRef(false)
  const composerCompEndRef = useRef(0)
  const titleComposingRef = useRef(false)
  const titleCompEndRef = useRef(0)
  const draftTopicRef = useRef(draftTopicId)
  const sendableFileCount = attachedFiles.filter(f => !f.needsReupload).length
  const pendingSendRef = useRef(null)
  const mentionBlurTimerRef = useRef(null)

  // Switching topics: load that topic's own draft (never carry the previous topic's text over).
  useLayoutEffect(() => {
    if (draftTopicRef.current === draftTopicId) return
    draftTopicRef.current = draftTopicId
    const next = loadDraft(draftStorage, draftTopicId)
    setDraft(next.text)
    setAttachedCards(next.cards)
    setAttachedFiles(next.files)
    setMentionedIds([])
  }, [draftTopicId, draftStorage])

  // Save on every change, under the topic the composer currently shows. While a send is in flight the
  // stored draft is kept until the send is confirmed (cleared on success, restored on failure).
  useEffect(() => {
    const pending = pendingSendRef.current
    const empty = !draft && !attachedFiles.length && !attachedCards.length
    if (pending && pending.topicId === draftTopicRef.current && empty) return
    saveDraft(draftStorage, draftTopicRef.current, { text: draft, files: attachedFiles, cards: attachedCards })
  }, [draft, attachedFiles, attachedCards, draftStorage])

  // 0.9.42: stored messages plus the sends of this topic the server has not confirmed yet.
  const shownMessages = useMemo(() => mergeOptimisticMessages(topic, pendingSends), [topic, pendingSends])

  const allAgents = state?.agents || []
  const chiefAgent = useMemo(() => (
    allAgents.find(a => a.id === state?.settings?.chiefAgentId)
    || allAgents.find(a => a.role === 'chief')
    || allAgents[0]
    || null
  ), [allAgents, state?.settings?.chiefAgentId])

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return []
    return filterMentionCandidates(allAgents, mentionQuery, a => [getAgentRoleLabel(a), ENGINE_LABEL[a.engine] || a.engine || ''])
  }, [mentionQuery, allAgents])

  useEffect(() => () => clearTimeout(mentionBlurTimerRef.current), [])

  const slashCandidates = useMemo(() => (slashQuery === null ? [] : filterSlashCommands(slashQuery)), [slashQuery])
  useEffect(() => { setSlashIdx(0) }, [slashQuery])

  useEffect(() => {
    setMentionIdx(0)
  }, [mentionQuery])

  useEffect(() => {
    if (composerFocusSeq > 0) {
      textareaRef.current?.focus()
    }
  }, [composerFocusSeq])

  // v0.9.15: opening a topic lands on the newest message at once. The old code reused the previous topic's
  // scroll position, then animated (CSS smooth scroll) ~1000 px down, and stopped short because messages that
  // finished rendering after the animation (images, entrance animations, synced replies) were not followed.
  // Now: jump instantly before paint, then stay pinned while content keeps growing, unless the user scrolls up.
  const pinToBottom = () => {
    const el = streamRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' })
  }

  const handleScroll = () => {
    const el = streamRef.current
    if (!el) return
    autoScrollRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 80
  }

  useLayoutEffect(() => {
    autoScrollRef.current = true
    pinToBottom()
  }, [topic?.id])

  useLayoutEffect(() => {
    if (autoScrollRef.current) pinToBottom()
  }, [shownMessages.length, liveStream?.text, liveStream?.reasoning, liveStream?.tools?.length, heldReply?.text, heldReply?.status])

  // Content that grows after render (lazy images, entrance animations, expanded blocks) keeps the view pinned.
  useEffect(() => {
    const el = streamRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => { if (autoScrollRef.current) pinToBottom() })
    const observeChildren = () => { for (const child of el.children) ro.observe(child) }
    observeChildren()
    const mo = new MutationObserver(observeChildren)
    mo.observe(el, { childList: true })
    return () => { ro.disconnect(); mo.disconnect() }
  }, [])

  // Upload any mainstream file following Hermes-WebUI /api/studio/uploads spec (50MB),
  // with seamless fallback to plugin RPC `upload-chat-file`.
  const uploadFilesList = async rawFileList => {
    const files = Array.from(rawFileList || []).filter(Boolean)
    if (!files.length) return
    const remainingSlots = Math.max(0, 10 - attachedFiles.length)
    if (remainingSlots <= 0) {
      ctx?.ui?.notify?.('单条消息最多附加 10 个文件', 'error')
      return
    }
    const batch = files.slice(0, remainingSlots)
    setUploadingCount(c => c + batch.length)

    for (const file of batch) {
      try {
        if (file.size > MAX_UPLOAD_BYTES) {
          ctx?.ui?.notify?.(`文件「${file.name}」超过 50 MB 上限`, 'error')
          continue
        }
        const isImg = String(file.type || '').startsWith('image/') || IMAGE_EXT_RE.test(file.name)
        const previewUrl = isImg ? URL.createObjectURL(file) : ''

        let uploaded = null
        // Primary: native Hermes-WebUI /api/studio/uploads (identical storage & 50MB policy)
        try {
          const fd = new FormData()
          fd.append('file', file, file.name)
          const headers = {}
          const apiKey = typeof localStorage !== 'undefined' ? localStorage.getItem('hermes_api_key') : ''
          const prof = typeof localStorage !== 'undefined' ? (localStorage.getItem('hermes_active_profile_name') || 'default') : 'default'
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`
          if (prof) headers['X-Hermes-Profile'] = prof
          const resp = await fetch('/api/studio/uploads', { method: 'POST', headers, body: fd })
          if (resp.ok) {
            const json = await resp.json()
            const first = json?.files?.[0]
            if (first?.path) {
              uploaded = {
                id: `att-${Math.random().toString(36).slice(2, 10)}`,
                type: isImg ? 'image' : 'file',
                name: first.name || file.name,
                path: first.path,
                mediaType: file.type || (isImg ? 'image/png' : 'application/octet-stream'),
                size: file.size,
                previewUrl,
              }
            }
          }
        } catch {
          // fall through to plugin RPC upload
        }

        // Fallback: plugin RPC upload-chat-file (ensures 100% reliability in any host/sandbox)
        if (!uploaded && onUploadFile) {
          const dataBase64 = await readFileAsBase64(file)
          const res = await onUploadFile({
            name: file.name,
            mediaType: file.type || '',
            dataBase64,
          })
          if (res?.path) {
            uploaded = { ...res, previewUrl }
          }
        }

        if (uploaded) {
          if (isImg) {
            const thumb = await makeImageThumb(file)
            if (thumb) uploaded = { ...uploaded, thumb }
          }
          setAttachedFiles(prev => [...prev, uploaded])
        } else {
          if (previewUrl) URL.revokeObjectURL(previewUrl)
          ctx?.ui?.notify?.(`上传文件「${file.name}」失败`, 'error')
        }
      } catch (err) {
        ctx?.ui?.notify?.(err?.message || `上传「${file.name}」失败`, 'error')
      } finally {
        setUploadingCount(c => Math.max(0, c - 1))
      }
    }
  }

  const removeAttachedFile = id => {
    setAttachedFiles(prev => {
      const target = prev.find(f => f.id === id)
      if (target?.previewUrl && String(target.previewUrl).startsWith('blob:')) {
        try { URL.revokeObjectURL(target.previewUrl) } catch {}
      }
      return prev.filter(f => f.id !== id)
    })
  }

  // v0.9.43: a composer that starts with "/" shows the command panel instead of the @ picker; anything else
  // goes to the @ picker exactly as before.
  const syncComposerTriggers = (nextText, cursorPos) => {
    const slash = findSlashTrigger(nextText, cursorPos)
    if (slash) {
      setSlashStart(slash.start)
      setSlashQuery(slash.query)
      setMentionQuery(null)
      setMentionStart(-1)
      return
    }
    setSlashQuery(null)
    setSlashStart(-1)
    syncMentionTrigger(nextText, cursorPos)
  }

  const pickSlashCommand = cmd => {
    const el = textareaRef.current
    const curPos = el ? el.selectionStart : draft.length
    // The "/" token is read again at the caret: the caret may have moved since the panel opened.
    const picked = resolveSlashPick(draft, curPos, cmd)
    setSlashQuery(null)
    setSlashStart(-1)
    if (!picked) return
    const { text: nextDraft, cursor } = picked
    setDraft(nextDraft)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      try { ta.setSelectionRange(cursor, cursor) } catch {}
    })
  }

  // v0.9.41: "@" opens the picker anywhere (line start, spaces, newline, Chinese text, punctuation); see mention.js.
  const syncMentionTrigger = (nextText, cursorPos) => {
    const hit = findMentionTrigger(nextText, cursorPos)
    if (hit) {
      setMentionStart(hit.start)
      setMentionQuery(hit.query)
    } else {
      setMentionQuery(null)
      setMentionStart(-1)
    }
  }

  // Auto-grow the composer so long input is never hidden behind a fixed 2-row box.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = Math.max(120, Math.round(window.innerHeight * 0.4))
    el.style.height = `${Math.min(el.scrollHeight + 2, max)}px`
    el.style.overflowY = el.scrollHeight + 2 > max ? 'auto' : 'hidden'
  }, [draft])

  const insertAgentMention = agent => {
    if (!agent) return
    const el = textareaRef.current
    const curPos = el?.selectionStart ?? draft.length
    const { text: nextDraft, cursor: nextCursor } = applyMention(draft, mentionStart, curPos, agent.name)
    setDraft(nextDraft)
    setMentionedIds(prev => (prev.includes(agent.id) ? prev : [...prev, agent.id]))
    setMentionQuery(null)
    setMentionStart(-1)
    requestAnimationFrame(() => {
      if (el) {
        el.focus()
        el.setSelectionRange(nextCursor, nextCursor)
      }
    })
  }

  // v0.9.41: the button keeps the textarea focused (onMouseDown preventDefault), and any pending blur-close is
  // cancelled here, so the picker it opens stays open instead of vanishing 160 ms later.
  const triggerMentionButton = () => {
    clearTimeout(mentionBlurTimerRef.current)
    const el = textareaRef.current
    const pos = el?.selectionStart ?? draft.length
    // v0.9.41: with the picker already open the button only keeps it open — it never adds a second "@".
    const pressed = pressMentionButton(draft, pos, mentionQuery !== null)
    if (!pressed) {
      el?.focus()
      return
    }
    const { text: nextDraft, cursor: nextPos, start } = pressed
    if (nextDraft !== draft) setDraft(nextDraft)
    // v0.9.43: the two panels never show together; the button path closes the slash panel too.
    setSlashQuery(null)
    setSlashStart(-1)
    setMentionStart(start)
    setMentionQuery('')
    requestAnimationFrame(() => {
      if (el) {
        el.focus()
        el.setSelectionRange(nextPos, nextPos)
      }
    })
  }

  const submit = ({ interrupt = false } = {}) => {
    const el = textareaRef.current
    const liveVal = typeof el?.value === 'string' ? el.value : draft
    const text = String(liveVal || '').trim()
    const payloadAttachments = sendableAttachments(attachedFiles)
    if ((!text && !attachedCards.length && !payloadAttachments.length) || busy || uploadingCount > 0) return
    // v0.9.43: a host slash command goes over the live session, never as a chat turn (see chief-commands.js).
    const command = !attachedCards.length && !payloadAttachments.length ? parseSlashCommand(text) : null
    if (command) {
      const gate = commandGate(command, commandGateState)
      setSlashQuery(null)
      setSlashStart(-1)
      if (!gate.ok) {
        ctx?.ui?.notify?.(gate.reason, 'error')
        return
      }
      if (SLASH_COMMANDS.find(c => c.name === command.rawName)?.confirm) {
        setConfirmCommand(command)
        return
      }
      clearComposerForCommand()
      void onRunSlashCommand?.(command)
      return
    }
    const refPrefix = attachedCards.length
      ? `${attachedCards.map(c => `[参考任务 #${c.number} (${c.id}): ${c.title}]`).join('\n')}\n`
      : ''
    const activeMentions = mentionedIds.filter(id => {
      const ag = allAgents.find(a => a.id === id)
      return ag && text.includes(`@${ag.name}`)
    })
    autoScrollRef.current = true
    composerComposingRef.current = false
    const sentTopicId = draftTopicRef.current
    const snapshot = { text: String(liveVal || ''), files: attachedFiles, cards: attachedCards }
    const pending = { topicId: sentTopicId }
    pendingSendRef.current = pending
    setDraft('')
    setAttachedCards([])
    setAttachedFiles([])
    setMentionedIds([])
    setMentionQuery(null)
    // Explicitly flush native textarea value & defer post-IME sweep so mixed CJK/English text never lingers
    if (el) {
      el.value = ''
      requestAnimationFrame(() => {
        if (textareaRef.current && !composerComposingRef.current && textareaRef.current.value) {
          textareaRef.current.value = ''
          setDraft('')
        }
      })
    }
    const settle = ok => {
      if (pendingSendRef.current === pending) pendingSendRef.current = null
      if (ok) {
        // Sent: this topic's draft is done. Only clear it if nothing new was typed there meanwhile.
        if (draftTopicRef.current !== sentTopicId || !textareaRef.current?.value) clearDraft(draftStorage, sentTopicId)
        return
      }
      // Not sent: keep the draft so nothing typed or uploaded is lost.
      saveDraft(draftStorage, sentTopicId, snapshot)
      if (draftTopicRef.current === sentTopicId && !textareaRef.current?.value) {
        setDraft(snapshot.text)
        setAttachedFiles(snapshot.files)
        setAttachedCards(snapshot.cards)
      }
    }
    let result
    try {
      result = onSendMessage({
        text: `${refPrefix}${text}`.trim(),
        attachments: payloadAttachments,
        mentionedAgentIds: activeMentions,
        interrupt,
      })
    } catch {
      settle(false)
      return
    }
    Promise.resolve(result).then(
      res => settle(res === undefined || res === true || Boolean(res?.ok)),
      () => settle(false),
    )
  }

  const clearComposerForCommand = () => {
    const el = textareaRef.current
    setDraft('')
    if (el) el.value = ''
    clearDraft(draftStorage, draftTopicRef.current)
  }

  const confirmPendingCommand = () => {
    const command = confirmCommand
    setConfirmCommand(null)
    if (!command) return
    const gate = commandGate(command, commandGateState)
    if (!gate.ok) {
      ctx?.ui?.notify?.(gate.reason, 'error')
      return
    }
    clearComposerForCommand()
    if (command.action === 'compress') void onCompressContext?.()
    else void onRunSlashCommand?.(command)
  }

  const handleDrop = e => {
    e.preventDefault()
    setDragOver(false)
    // 1. OS file drop (images, code, documents, media)
    if (e.dataTransfer?.files?.length) {
      void uploadFilesList(e.dataTransfer.files)
      return
    }
    // 2. Kanban todo card drop
    const raw = e.dataTransfer?.getData('application/x-ekko-todo-card')
    if (!raw) return
    try {
      const card = JSON.parse(raw)
      if (card?.id) {
        setAttachedCards(prev => (prev.some(c => c.id === card.id) ? prev : [...prev, card]))
        textareaRef.current?.focus()
      }
    } catch {}
  }

  const handlePaste = e => {
    const items = Array.from(e.clipboardData?.items || [])
    const pastedFiles = items
      .filter(it => it.kind === 'file')
      .map(it => it.getAsFile())
      .filter(Boolean)
    if (pastedFiles.length > 0) {
      e.preventDefault()
      void uploadFilesList(pastedFiles)
    }
  }

  const startTitleEdit = () => {
    if (!topic) return
    setTitleDraft(topic.title || '')
    setEditingTitle(true)
  }

  const commitTitleEdit = () => {
    setEditingTitle(false)
    const clean = titleDraft.trim()
    if (topic && clean && clean !== topic.title) {
      onRenameTopic?.(topic.id, clean)
    }
  }

  const chiefRunning = Boolean(topic?.isRunning || liveStream?.isWorking)
  const contextCompressing = Boolean(chiefContext?.phase === 'compressing' || topic?.compressingSince)
  const commandGateState = {
    channel: chiefContext?.channel || 'unknown',
    reason: chiefContext?.reason || '',
    connected: Boolean(chiefContext?.connected),
    running: Boolean(chiefRunning || topic?.launching),
    compressing: contextCompressing,
    hasSession: Boolean(topic?.chiefSessionId),
  }
  const isStreaming = Boolean(chiefRunning || liveStream?.text || liveStream?.reasoning || liveStream?.tools?.length)
  const hasBrief = Boolean(
    topic?.brief && (topic.brief.goal || topic.brief.progress || topic.brief.next || topic.brief.waitingOnYou || topic.brief.blocked),
  )

  const [chiefTick, setChiefTick] = useState(0)
  useEffect(() => {
    if (!chiefRunning) return
    const timer = setInterval(() => setChiefTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [chiefRunning])
  void chiefTick

  const chiefStartedAt = liveStream?.startedAt || topic?.liveActivity?.startedAt || (chiefRunning ? topic?.updatedAt : 0)
  const chiefLiveClock = chiefRunning && chiefStartedAt ? formatLiveClock(chiefStartedAt) : ''
  const liveActiveTool = liveStream?.tools?.find(t => t.status === 'running')?.name || topic?.liveActivity?.activeTool || ''
  const liveToolCount = Math.max(liveStream?.tools?.length || 0, topic?.liveActivity?.toolCount || 0)
  const chiefStatusHeadline = liveActiveTool
    ? `正在调用工具 ${liveActiveTool}${liveToolCount > 0 ? `（第 ${liveToolCount} 次）` : ''}`
    : liveStream?.reasoning && !liveStream?.text
      ? '正在深度思考与拆解方案…'
      : liveStream?.text
        ? '正在输出回复…'
        : liveToolCount > 0
          ? `运行中 · 已完成 ${liveToolCount} 次工具调用`
          : '大总管运行中…'

  return (
    <section className="ot-chat" data-testid="todos-chat">
      <header className="ot-col-bar">
        <div className="ot-chat-head-left">
          {showSidebarTrigger && (
            <button
              type="button"
              className="ot-icon-btn"
              onClick={onToggleSidebar}
              title="展开侧栏 (⌘B)"
              aria-label="展开侧栏"
              data-testid="btn-chat-open-sidebar"
            >
              <SidebarSimple size={16} weight="regular" />
            </button>
          )}
          <BrandLogo size={20} />
          {editingTitle && topic ? (
            <input
              className="ot-input ot-input--sm"
              style={{ width: 190, height: 26 }}
              value={titleDraft}
              autoFocus
              onChange={e => setTitleDraft(e.target.value)}
              onBlur={commitTitleEdit}
              onCompositionStart={() => { titleComposingRef.current = true }}
              onCompositionEnd={() => { titleComposingRef.current = false; titleCompEndRef.current = Date.now() }}
              onKeyDown={e => {
                if (isImeComposingEvent(e, titleComposingRef, titleCompEndRef)) return
                if (e.key === 'Enter') commitTitleEdit()
                else if (e.key === 'Escape') setEditingTitle(false)
              }}
              data-testid="input-inline-topic-title"
            />
          ) : (
            <button
              type="button"
              className="ot-chat-title-btn"
              onDoubleClick={startTitleEdit}
              title={topic ? `${topic.title}（双击重命名）` : 'Ekko ToDo'}
              data-testid="chat-topic-title"
            >
              <span className="ot-chat-title">{topic?.title || 'Ekko ToDo'}</span>
              {topic && <PencilSimple size={11} className="ot-title-edit-ico" onClick={e => { e.stopPropagation(); startTitleEdit() }} />}
            </button>
          )}
          {liveStream?.connected && topic?.chiefSessionId && (
            <span className="ot-live-dot" title="已建立实时流式通道" />
          )}
        </div>

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {onOpenTrace && topic?.chiefSessionId && (
            <button
              type="button"
              className="ot-icon-btn"
              onClick={() => onOpenTrace(topic.chiefSessionId)}
              title="总管调用明细（模型、工具、推理过程）"
              aria-label="调用明细"
              data-testid="btn-chat-open-trace"
            >
              <ListMagnifyingGlass size={15} weight="regular" />
            </button>
          )}
          {hasBrief && (
            <button
              type="button"
              className={`ot-icon-btn ${briefOpen ? 'is-active' : ''}`}
              onClick={() => setBriefOpen(v => !v)}
              title="展开或收起主题简报"
              aria-label="主题简报"
              style={{ position: 'relative' }}
            >
              <NoteBlank size={15} weight="regular" />
              {topic?.brief?.waitingOnYou && <span className="ot-icon-badge-dot" />}
            </button>
          )}

          {topic && (
            <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <Popover.Trigger asChild>
                <button type="button" className="ot-icon-btn" title="话题操作" aria-label="话题操作" data-testid="btn-topic-menu">
                  <DotsThree size={16} weight="bold" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="ot-menu-popover ot-menu-popover--paper" align="end" sideOffset={6} data-testid="topic-action-menu">
                  <button type="button" className="ot-menu-item" onClick={() => { setMenuOpen(false); startTitleEdit() }}>
                    <PencilSimple size={15} />
                    <span>重命名话题</span>
                  </button>
                  <button
                    type="button"
                    className="ot-menu-item"
                    onClick={() => { setMenuOpen(false); onUpdateTopicMeta?.(topic.id, { pinned: !topic.pinned }) }}
                  >
                    <PushPin size={15} weight={topic.pinned ? 'fill' : 'regular'} />
                    <span>{topic.pinned ? '取消置顶' : '置顶话题'}</span>
                  </button>
                  <button
                    type="button"
                    className="ot-menu-item"
                    onClick={() => {
                      setMenuOpen(false)
                      const url = `${window.location.origin}${window.location.pathname}${window.location.hash.split('?')[0]}?topic=${topic.id}`
                      navigator.clipboard?.writeText?.(url).catch(() => {})
                      ctx?.ui?.notify?.('已复制话题链接', 'success')
                    }}
                  >
                    <Copy size={15} />
                    <span>复制链接</span>
                  </button>
                  <button
                    type="button"
                    className="ot-menu-item"
                    data-testid="btn-topic-project"
                    onClick={() => { setMenuOpen(false); setProjectDialogTopicId(topic.id) }}
                  >
                    <FolderSimple size={15} />
                    <span>改挂项目</span>
                  </button>
                  <button
                    type="button"
                    className="ot-menu-item"
                    onClick={() => { setMenuOpen(false); onUpdateTopicMeta?.(topic.id, { archived: !topic.archived }) }}
                  >
                    <Archive size={15} />
                    <span>{topic.archived ? '取消归档' : '归档话题'}</span>
                  </button>
                  <button
                    type="button"
                    className="ot-menu-item is-danger"
                    onClick={() => { setMenuOpen(false); onDeleteTopic?.(topic.id) }}
                  >
                    <Trash size={15} />
                    <span>删除话题</span>
                  </button>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}

          <button
            type="button"
            className={`ot-icon-btn ot-desktop-only ${!boardHidden ? 'is-active' : ''}`}
            onClick={onToggleBoard}
            title={boardHidden ? '显示右侧看板 (⌘⌥B)' : '隐藏右侧看板 (⌘⌥B)'}
            aria-label="切换右侧看板"
          >
            <Kanban size={15} weight="regular" />
          </button>
        </div>
      </header>

      {chiefRunning && topic && (
        <div className="ot-chief-run-banner" data-testid="chief-running-banner">
          <div className="ot-chief-run-left">
            <span className="ot-chief-run-avatar-wrap">
              <AgentAvatar agent={chiefAgent} role="chief" size={20} />
              <span className="ot-chief-run-ring" aria-hidden="true" />
            </span>
            <CircleNotch size={13} weight="bold" className="ot-spin" style={{ color: 'var(--ot-dot-doing)', flex: 'none' }} />
            <span className="ot-chief-run-text">{chiefStatusHeadline}</span>
          </div>
          <div className="ot-chief-run-right">
            {chiefLiveClock && <span className="ot-live-clock" data-testid="chief-running-clock">{chiefLiveClock}</span>}
            {liveStream?.usage && (liveStream.usage.inputTokens > 0 || liveStream.usage.outputTokens > 0) && (
              <span className="ot-stream-stat ot-desktop-only">
                ↑{formatTokens(liveStream.usage.inputTokens)} ↓{formatTokens(liveStream.usage.outputTokens)}
              </span>
            )}
            <button
              type="button"
              className="ot-btn ot-btn--sm ot-btn--danger"
              style={{ height: 22, padding: '0 7px', fontSize: 'var(--ot-fs-xs)' }}
              onClick={() => onStopRun(topic.id)}
              title="停止当前大总管运行"
              data-testid="btn-banner-stop-chief"
            >
              <Stop size={10} weight="fill" />
              <span>停止</span>
            </button>
          </div>
          <div className="ot-run-progress-track" aria-hidden="true">
            <span className="ot-run-progress-fill" />
          </div>
        </div>
      )}

      {hasBrief && briefOpen && (
        <div style={{ padding: '8px 14px 0', flex: 'none' }}>
          <TopicBriefCard
            topic={topic}
            busy={busy}
            onClearWaiting={onClearTopicWaiting}
            onOpenDecision={onOpenTopicDecision}
          />
        </div>
      )}

      <div className="ot-chat-stream" ref={streamRef} onScroll={handleScroll} data-testid="chat-stream">
        {!topic ? (
          <m.div
            className="ot-welcome-hero"
            data-testid="chat-onboarding"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22 }}
          >
            <div className="ot-welcome-glow" aria-hidden="true" />
            <div className="ot-welcome-brand-ring">
              <BrandLogo size={46} />
            </div>
            <div className="ot-welcome-title">Ekko ToDo</div>
            <div className="ot-welcome-sub">
              {projects.length === 0
                ? '添加项目后，直接告诉大总管你的目标。'
                : '说出目标，大总管拆解派工，进度见右侧看板。'}
            </div>
            <div className="ot-welcome-pillars">
              <span className="ot-welcome-pillar"><ShieldCheck size={13} weight="duotone" /> 总管不直接改代码</span>
              <span className="ot-welcome-pillar"><Lightning size={13} weight="duotone" /> 独立工作树执行</span>
              <span className="ot-welcome-pillar"><Queue size={13} weight="duotone" /> 自动排队调度</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
              {projects.length === 0 && (
                <>
                  {onOpenOnboarding && (
                    <button
                      type="button"
                      className="ot-btn ot-btn--primary"
                      onClick={onOpenOnboarding}
                      data-testid="btn-onboarding-start-wizard"
                    >
                      <Compass size={14} weight="duotone" />
                      <span>1 分钟配置我的团队</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="ot-btn"
                    onClick={() => onAddProject('github')}
                    data-testid="btn-onboarding-import-github"
                  >
                    <GithubLogo size={14} weight="bold" />
                    <span>从 GitHub 导入</span>
                  </button>
                  <button
                    type="button"
                    className="ot-btn"
                    onClick={() => onAddProject('local')}
                    data-testid="btn-onboarding-add-project"
                  >
                    <FolderPlus size={14} />
                    <span>添加本地项目</span>
                  </button>
                </>
              )}
              {projects.length > 0 && (
                <button type="button" className="ot-btn ot-btn--primary" onClick={onNewTopic}>
                  <Plus size={14} />
                  <span>新建话题</span>
                </button>
              )}
            </div>
          </m.div>
        ) : (
          <>
            {topic.lastError && (
              <div className="ot-pre" style={{ borderColor: 'var(--ot-diff-del-edge)', color: 'var(--ot-tag-bug-fg)', fontSize: 'var(--ot-fs-xs)' }}>
                上轮运行异常：{topic.lastError}
              </div>
            )}

            {shownMessages.length === 0 && !isStreaming && !heldReply?.text && (
              <div className="ot-empty-center">
                {chiefAgent && <AgentAvatar agent={chiefAgent} size={36} />}
                <div style={{ fontSize: 'var(--ot-fs-sm)', color: 'var(--ot-text-2)', maxWidth: 300, lineHeight: 1.6, textWrap: 'balance' }}>
                  输入目标开始，支持 <code className="ot-inline-code">@</code> 指定 Agent、上传文件或拖入任务卡片。
                </div>
              </div>
            )}

            {shownMessages.map((msg, idx) => {
              const prevMsg = idx > 0 ? shownMessages[idx - 1] : null
              const showTime = msg.kind !== 'system' && shouldShowTimeDivider(prevMsg?.createdAt, msg.createdAt)
              const timeDividerText = showTime ? formatMessageTimeDivider(msg.createdAt) : ''

              if (msg.kind === 'human') {
                return (
                  <React.Fragment key={messageKey(msg)}>
                    {timeDividerText && (
                      <div className="ot-msg-time-divider" data-testid={`msg-time-${msg.id}`}>
                        {timeDividerText}
                      </div>
                    )}
                    <div
                      className={`ot-msg-human-wrap${msg.pending ? ' is-pending' : ''}${msg.sendError ? ' is-failed' : ''}`}
                      data-testid="msg-human"
                      data-msg-id={msg.id}
                      data-send-state={sendStateOf(msg, topic.launchingMessageId)}
                    >
                      <div className="ot-msg-human" title={formatMessageTimeDivider(msg.createdAt)}>
                        {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
                          <div className="ot-msg-attachments" data-testid={`msg-attachments-${msg.id}`}>
                            {msg.attachments.map(att => (
                              <span
                                key={att.id || att.path}
                                className={`ot-msg-att-chip${att.path ? ' is-openable' : ''}`}
                                title={att.path ? `预览：${att.path}` : att.name}
                                role={att.path ? 'button' : undefined}
                                tabIndex={att.path ? 0 : undefined}
                                onClick={att.path ? () => openLocalFile(att.path, isImagePath(att.path) ? msg.attachments.map(a => a.path).filter(isImagePath) : [att.path]) : undefined}
                                onKeyDown={att.path ? e => { if (e.key === 'Enter') openLocalFile(att.path) } : undefined}
                              >
                                <AttachmentIcon att={att} size={13} />
                                <span className="ot-msg-att-name">{att.name}</span>
                                {att.size > 0 && <span className="ot-msg-att-size">{formatFileSize(att.size)}</span>}
                              </span>
                            ))}
                          </div>
                        )}
                        <LocalAwareText text={msg.text} thumbnails={false} />
                      </div>
                      {msg.pending && !msg.sendError && (
                        <div className="ot-msg-send-state" data-testid="msg-send-pending">发送中…</div>
                      )}
                      {sendStateOf(msg, topic.launchingMessageId) === 'starting' && (
                        <div className="ot-msg-send-state" data-testid="msg-send-starting">已收到，正在启动大总管…</div>
                      )}
                      {msg.sendError && (
                        <div className="ot-msg-send-state is-error" role="alert" data-testid="msg-send-error">
                          {msg.pending === false && String(msg.id).startsWith('pending-') ? '未发送：' : '大总管没有收到：'}{msg.sendError}
                        </div>
                      )}
                    </div>
                  </React.Fragment>
                )
              }
              return (
                <React.Fragment key={msg.id}>
                  {timeDividerText && (
                    <div className="ot-msg-time-divider" data-testid={`msg-time-${msg.id}`}>
                      {timeDividerText}
                    </div>
                  )}
                  <ChiefMessage
                    message={msg}
                    chiefAgent={chiefAgent}
                    topicTitle={topic.title}
                    todos={todos}
                    onOpenTodo={onOpenTodo}
                    onAnswerQuestion={onAnswerQuestion}
                    busy={busy}
                  />
                </React.Fragment>
              )
            })}

            {(heldReply?.text || heldSync?.state === 'saved') && (
              <HeldReplyBlock held={heldReply} sync={heldSync} onRetry={onRetryHeldSync} />
            )}

            {isStreaming && (
              <LiveStreamBlock liveStream={liveStream} isRunning={chiefRunning} />
            )}
          </>
        )}
      </div>

      <div className="ot-composer-wrap">
        {/* Serialized Chief Follow-up Queue Tray (Todos-grade: never interrupts active turn!) */}
        {topic && Array.isArray(topic.queuedItems) && topic.queuedItems.length > 0 && (
          <div className="ot-queue-tray" data-testid="chief-queue-tray">
            <div className="ot-queue-tray-head">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Queue size={13} weight="duotone" style={{ color: 'var(--ot-dot-doing)' }} />
                <strong>排队等待本轮执行完毕（{topic.queuedItems.length} 条）</strong>
              </span>
              <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>当前回合结束后按序自动送达</span>
            </div>
            <div className="ot-queue-tray-list">
              {topic.queuedItems.map((qItem, idx) => (
                <div key={qItem.id} className="ot-queue-item" data-testid={`queue-item-${qItem.id}`}>
                  <span className="ot-queue-idx">#{idx + 1}</span>
                  <span className="ot-queue-text" title={qItem.text}>
                    {qItem.kind === 'wake' ? '进度通知：' : ''}{qItem.text}
                  </span>
                  <div className="ot-queue-actions">
                    <button
                      type="button"
                      className="ot-queue-act-btn"
                      onClick={() => onPromoteQueueItem?.(topic.id, qItem.id)}
                      title="中止当前运行并立即执行此条消息"
                      data-testid={`btn-queue-promote-${qItem.id}`}
                    >
                      <Lightning size={11} weight="fill" />
                      <span>立即执行</span>
                    </button>
                    <button
                      type="button"
                      className="ot-queue-act-btn is-cancel"
                      onClick={() => onCancelQueueItem?.(topic.id, qItem.id)}
                      title="撤回此条排队消息"
                      aria-label="撤回排队消息"
                      data-testid={`btn-queue-cancel-${qItem.id}`}
                    >
                      <span>撤回</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="ot-composer-context" data-testid="composer-context">
          <QuickChiefPopover
            ctx={ctx}
            state={state}
            onQuickConfigureChief={onQuickConfigureChief}
            onFetchModelCatalog={onFetchModelCatalog}
            onOpenSettingsTab={onOpenSettingsTab}
            onOpenAgents={onOpenAgents}
          />
          <button
            type="button"
            className={`ot-auto-pill ${topic ? (topic.autopilot ? 'is-on' : '') : 'is-on'}`}
            onClick={() => topic && onToggleAutopilot(topic.id, !topic.autopilot)}
            disabled={!topic}
            title={topic?.autopilot ? 'AUTO 开启：总管自动推进（部署仍需人工确认）' : '手动把关：方案与合并前暂停确认'}
            data-testid="btn-toggle-auto"
            aria-pressed={topic ? Boolean(topic.autopilot) : true}
          >
            {(topic ? topic.autopilot : true) ? 'AUTO 开' : 'AUTO 关'}
          </button>
        </div>

        <div
          className={`ot-composer ${dragOver ? 'is-dragover' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {slashQuery !== null && (
            <SlashCommandPanel
              query={slashQuery}
              candidates={slashCandidates}
              activeIndex={slashIdx}
              onPick={pickSlashCommand}
              onHover={setSlashIdx}
            />
          )}
          {/* @Agent Mention Popup */}
          {mentionQuery !== null && (
            <div className="ot-mention-popover" data-testid="agent-mention-popover" role="listbox" aria-label="选择要 @ 的 Agent">
              <div className="ot-mention-head" data-testid="agent-mention-head">{mentionCandidates.length > 0 ? '选择要 @ 的 Agent（↑↓ 切换 · 回车插入 · Esc 关闭）' : '没有匹配的 Agent（Esc 关闭）'}</div>
              <div className="ot-mention-list">
                {mentionCandidates.length === 0 && (
                  <div className="ot-mention-empty" data-testid="agent-mention-empty">{emptyMentionHint(allAgents.length, mentionQuery)}</div>
                )}
                {mentionCandidates.map((ag, idx) => (
                  <button
                    key={ag.id}
                    type="button"
                    role="option"
                    aria-selected={idx === mentionIdx}
                    className={`ot-mention-item ${idx === mentionIdx ? 'is-active' : ''}`}
                    onMouseDown={e => { e.preventDefault(); insertAgentMention(ag) }}
                    onMouseEnter={() => setMentionIdx(idx)}
                    data-testid={`mention-opt-${ag.id}`}
                  >
                    <AgentAvatar agent={ag} size={22} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>{ag.name}</strong>
                        <span className="ot-pill-soft" style={{ fontSize: 'var(--ot-fs-xs)' }}>{getAgentRoleLabel(ag)}</span>
                      </div>
                      <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ENGINE_LABEL[ag.engine] || ag.engine}{ag.description ? ` · ${ag.description}` : ''}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Attached Kanban Cards + Uploaded Files Preview */}
          {(attachedCards.length > 0 || attachedFiles.length > 0 || uploadingCount > 0) && (
            <div className="ot-attached-chips" data-testid="composer-attachments">
              {attachedCards.map(c => (
                <span key={c.id} className="ot-attached-chip is-card" title={`#${c.number} ${c.title || ''}`} data-testid={`composer-card-${c.id}`}>
                  <span className="ot-attached-chip-label">#{c.number} {c.title}</span>
                  <button
                    type="button"
                    aria-label="移除引用"
                    onClick={() => setAttachedCards(prev => prev.filter(x => x.id !== c.id))}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {attachedFiles.map(att => (
                <span
                  key={att.id}
                  className={`ot-attached-chip ${att.type === 'image' ? 'is-image' : 'is-file'}${att.needsReupload ? ' is-stale' : ''}`}
                  title={att.needsReupload ? `${att.name}：${REUPLOAD_LABEL}` : att.name}
                  data-testid={att.needsReupload ? 'chip-needs-reupload' : undefined}
                >
                  {att.needsReupload ? (
                    <WarningCircle size={13} />
                  ) : att.previewUrl ? (
                    <img src={att.previewUrl} alt={att.name} className="ot-attached-thumb" />
                  ) : (
                    <AttachmentIcon att={att} size={13} />
                  )}
                  <span className="ot-attached-chip-label is-file">{att.needsReupload ? `${att.name} · ${REUPLOAD_LABEL}` : att.name}</span>
                  {att.size > 0 && !att.needsReupload && <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>{formatFileSize(att.size)}</span>}
                  <button
                    type="button"
                    aria-label={`移除文件 ${att.name}`}
                    onClick={() => removeAttachedFile(att.id)}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {uploadingCount > 0 && (
                <span className="ot-attached-chip">
                  <CircleNotch size={11} className="ot-spin" />
                  <span>正在上传 {uploadingCount} 个文件…</span>
                </span>
              )}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={e => {
              const list = e.target.files
              if (list?.length) void uploadFilesList(list)
              e.target.value = ''
            }}
            data-testid="input-chat-file-upload"
          />

          <textarea
            ref={textareaRef}
            value={draft}
            onCompositionStart={() => {
              composerComposingRef.current = true
            }}
            onCompositionEnd={e => {
              composerComposingRef.current = false
              composerCompEndRef.current = Date.now()
              const nextVal = e.currentTarget.value
              setDraft(nextVal)
              syncComposerTriggers(nextVal, e.currentTarget.selectionStart)
            }}
            onChange={e => {
              const nextVal = e.target.value
              setDraft(nextVal)
              if (!composerComposingRef.current && !e.nativeEvent?.isComposing) {
                syncComposerTriggers(nextVal, e.target.selectionStart)
              }
            }}
            onClick={e => {
              if (!composerComposingRef.current) {
                syncComposerTriggers(e.target.value, e.target.selectionStart)
              }
            }}
            onFocus={() => clearTimeout(mentionBlurTimerRef.current)}
            onBlur={() => {
              // Close the picker only if focus really left the composer (clicking the @ button or a picker row
              // keeps the textarea focused, so they never close it).
              clearTimeout(mentionBlurTimerRef.current)
              mentionBlurTimerRef.current = setTimeout(() => {
                if (typeof document !== 'undefined' && document.activeElement === textareaRef.current) return
                setMentionQuery(null)
                setMentionStart(-1)
                setSlashQuery(null)
                setSlashStart(-1)
              }, 160)
            }}
            onPaste={handlePaste}
            placeholder={chiefRunning
              ? '运行中，发送将自动排队'
              : '输入目标，@ 指定 Agent，/ 输入命令，可拖入文件'}
            rows={2}
            data-testid="chat-input"
            onKeyDown={e => {
              if (isImeComposingEvent(e, composerComposingRef, composerCompEndRef)) return
              // v0.9.43: the slash panel handles its own keys; with no match Enter does nothing (chief-commands.js).
              if (slashQuery !== null) {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSlashQuery(null)
                  setSlashStart(-1)
                  return
                }
                if (slashCandidates.length > 0 && e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSlashIdx(i => (i + 1) % slashCandidates.length)
                  return
                }
                if (slashCandidates.length > 0 && e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashIdx(i => (i - 1 + slashCandidates.length) % slashCandidates.length)
                  return
                }
                // 'send' (a typed name that needs no text) falls through to the normal send below.
                const slashAction = e.key === 'Enter'
                  ? slashEnterAction({ open: true, count: slashCandidates.length, query: slashQuery, shiftKey: e.shiftKey })
                  : null
                if (slashAction === 'insert' || slashAction === 'swallow') {
                  e.preventDefault()
                  if (slashAction === 'insert') pickSlashCommand(slashCandidates[slashIdx] || slashCandidates[0])
                  return
                }
              }
              if (mentionQuery !== null && e.key === 'Escape') {
                e.preventDefault()
                setMentionQuery(null)
                setMentionStart(-1)
                return
              }
              // v0.9.41: Enter never sends while the picker is open — with no match it does nothing (see mention.js).
              const enterAction = e.key === 'Enter'
                ? mentionEnterAction({ open: mentionQuery !== null, count: mentionCandidates.length, shiftKey: e.shiftKey })
                : null
              if (mentionQuery !== null && mentionCandidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIdx(i => (i + 1) % mentionCandidates.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIdx(i => (i - 1 + mentionCandidates.length) % mentionCandidates.length)
                  return
                }
                if (enterAction === 'insert' || e.key === 'Tab') {
                  e.preventDefault()
                  insertAgentMention(mentionCandidates[mentionIdx] || mentionCandidates[0])
                  return
                }
              }
              if (enterAction === 'swallow') {
                e.preventDefault()
                return
              }
              if (enterAction === 'send') {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="ot-composer-bar">
            <div className="ot-composer-tools">
              <button
                type="button"
                className="ot-icon-btn"
                onClick={() => fileInputRef.current?.click()}
                title="上传文件（最大 50MB）"
                aria-label="上传文件"
                data-testid="btn-chat-upload"
              >
                <Paperclip size={15} weight="regular" />
              </button>
              <button
                type="button"
                className={`ot-icon-btn ${mentionQuery !== null ? 'is-active' : ''}`}
                onMouseDown={e => e.preventDefault()}
                onClick={triggerMentionButton}
                title="@ 指定 Agent"
                aria-label="@提及 Agent"
                data-testid="btn-chat-mention"
              >
                <At size={15} weight="regular" />
              </button>
              <button
                type="button"
                className="ot-icon-btn"
                onClick={onOpenCreateTask}
                title="新建任务"
                aria-label="新建任务"
              >
                <Plus size={14} weight="regular" />
              </button>
            {/* v0.9.43: context of this Chief session + manual compress, right-aligned next to send. */}
            {topic?.chiefSessionId && (
              <ChiefContextCapsule
                info={chiefContext}
                gateState={commandGateState}
                compressing={contextCompressing}
                compressStartedAt={chiefContext?.startedAt || topic?.compressingSince || 0}
                onCompress={() => setConfirmCommand(parseSlashCommand('/compress'))}
              />
            )}
            </div>

            {chiefRunning ? (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
                {(draft.trim() || attachedCards.length > 0 || sendableFileCount > 0) && (
                  <m.button
                    whileTap={{ scale: 0.94 }}
                    type="button"
                    className="ot-queue-send-pill"
                    disabled={busy || uploadingCount > 0}
                    onClick={() => submit()}
                    title="加入队列，本轮结束后执行"
                    data-testid="btn-queue-send-chat"
                  >
                    <Queue size={12} weight="bold" />
                    <span>排队</span>
                  </m.button>
                )}
                <m.button
                  whileTap={{ scale: 0.92 }}
                  type="button"
                  className="ot-send-circle is-ready is-compact-stop"
                  onClick={() => onStopRun(topic.id)}
                  title="停止当前运行"
                  aria-label="停止"
                  data-testid="btn-stop-chat"
                >
                  <Stop size={11} weight="fill" />
                </m.button>
              </div>
            ) : (
              <m.button
                whileTap={{ scale: 0.92 }}
                type="button"
                className={`ot-send-circle ${draft.trim() || attachedCards.length || sendableFileCount ? 'is-ready' : ''}`}
                disabled={(!draft.trim() && !attachedCards.length && !sendableFileCount) || busy || uploadingCount > 0}
                onClick={submit}
                title="发送给大总管"
                aria-label="发送"
                data-testid="btn-send-chat"
              >
                <ArrowUp size={14} weight="bold" />
              </m.button>
            )}
          </div>
        </div>
      </div>
      <CommandConfirmDialog command={confirmCommand} onCancel={() => setConfirmCommand(null)} onConfirm={confirmPendingCommand} />
      {topic && projectDialogTopicId === topic.id && (
        <TopicProjectDialog
          topic={topic}
          projects={projects}
          onClose={() => setProjectDialogTopicId('')}
          onSave={projectId => onUpdateTopicMeta?.(topic.id, { projectId })}
        />
      )}
    </section>
  )
}

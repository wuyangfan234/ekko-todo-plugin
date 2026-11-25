import React, { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { X, ListMagnifyingGlass, ArrowLeft, ArrowRight, GitBranch, TerminalWindow, ArrowsClockwise, Stop, GithubLogo, ArrowsLeftRight, CircleNotch, Wrench, Clock, Trash } from '@phosphor-icons/react'
import { AgentAvatar, ProjectAvatar } from './AvatarKit.jsx'
import { DiffViewer } from './DiffViewer.jsx'
import { LocalAwareText } from './LocalFilePreview.jsx'
import { ENGINE_LABEL, KIND_LABEL, formatModelShort, formatRelativeTime, formatLiveClock, getProjectLabel, getTodoCardStateMeta, isImeComposingEvent } from '../utils.js'

export function TodoDrawer({ todo, project, agents = [], busy, onClose, onAction, onOpenSchedule, onOpenTrace, onLoadDiffs }) {
  const [tab, setTab] = useState('spec')
  const [followUp, setFollowUp] = useState('')
  const [customAnswer, setCustomAnswer] = useState('')
  const [changeFeedback, setChangeFeedback] = useState('')
  const [selectedConfigId, setSelectedConfigId] = useState('')
  const [pendingAction, setPendingAction] = useState('')
  const [liveTick, setLiveTick] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [fullDiffs, setFullDiffs] = useState(null)
  const diffsOmitted = Boolean(todo?.diffs?.some(d => d?.hunkOmitted))
  // The board snapshot drops diff bodies when it would exceed the host size limit; load them on demand.
  useEffect(() => {
    setFullDiffs(null)
    if (!todo?.id || !diffsOmitted || tab !== 'diff' || !onLoadDiffs) return
    let alive = true
    Promise.resolve(onLoadDiffs(todo.id)).then(res => { if (alive && Array.isArray(res?.diffs)) setFullDiffs(res.diffs) }).catch(() => {})
    return () => { alive = false }
  }, [todo?.id, todo?.revision, diffsOmitted, tab])

  const open = Boolean(todo)
  const assignedAgent = todo ? agents.find(a => a.id === todo.agentId) : null
  const modelConfigs = assignedAgent?.modelConfigs || []
  const stateMeta = getTodoCardStateMeta(todo)
  const isRunning = stateMeta.running

  // Pre-fill recommended choice directly into question decision input
  useEffect(() => {
    if (todo?.question?.active) {
      const rec = (todo.question.options || []).find(o => o.recommended) || (todo.question.options || [])[0]
      setCustomAnswer(rec?.label || '')
    } else {
      setCustomAnswer('')
    }
  }, [todo?.id, todo?.question?.active, todo?.question?.version])

  // Clear local optimistic action lock when phase changes or drawer closes
  useEffect(() => {
    setPendingAction('')
  }, [todo?.id, todo?.phase, todo?.revision, open])

  useEffect(() => { setConfirmDelete(false) }, [todo?.id, open])

  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => setLiveTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [isRunning])

  const triggerAction = async (action, note = '', optionId = '', withPlan = false, configId = '') => {
    if (!todo || busy || pendingAction) return
    setPendingAction(action)
    try {
      await onAction?.(todo.id, action, note, optionId, withPlan, configId)
    } finally {
      setPendingAction('')
    }
  }

  const actionsDisabled = busy || Boolean(pendingAction)
  const liveClock = isRunning ? formatLiveClock(todo?.liveActivity?.startedAt || todo?.updatedAt) : ''
  void liveTick

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!v) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-drawer ot-drawer--task" data-testid="todo-drawer" onOpenAutoFocus={e => e.preventDefault()}>
          {todo && (
            <>
              <div className="ot-dialog-head ot-task-head">
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0, flex: 1 }}>
                  <button
                    type="button"
                    className="ot-mobile-back-btn"
                    onClick={onClose}
                    aria-label="返回看板"
                    data-testid="btn-drawer-mobile-back"
                  >
                    <ArrowLeft size={16} weight="bold" />
                    <span>返回</span>
                  </button>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, flexWrap: 'wrap' }}>
                      <ProjectAvatar project={project} size={18} title={getProjectLabel(project)} />
                      {project && <span style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 500, color: 'var(--ot-text-2)' }}>{getProjectLabel(project)}</span>}
                      <span style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>#{todo.number}</span>
                      <span className={`ot-tag ot-tag--${todo.phase === 'failed' ? 'bug' : (todo.kind || 'feature')}`}>
                        {todo.phase === 'failed' ? '失败' : (KIND_LABEL[todo.kind] || todo.kind || '功能')}
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                        {assignedAgent && <AgentAvatar agent={assignedAgent} size={15} />}
                        <span>{assignedAgent?.name || ''}{assignedAgent ? ' · ' : ''}{ENGINE_LABEL[todo.engine] || todo.engine}</span>
                      </span>
                      {project?.githubRepo && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', fontFamily: 'var(--ot-mono)' }}>
                          <GithubLogo size={11} />
                          {project.githubRepo}
                        </span>
                      )}
                    </div>
                    <Dialog.Title className="ot-dialog-title">{todo.title}</Dialog.Title>
                  </div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}>
                  {onOpenTrace && (todo.buildSessionId || todo.reviewSessionId) && (
                    <button
                      type="button"
                      className="ot-btn ot-btn--sm"
                      onClick={() => onOpenTrace(todo.phase === 'reviewing' && todo.reviewSessionId ? todo.reviewSessionId : (todo.buildSessionId || todo.reviewSessionId))}
                      title="查看模型调用、工具调用与推理过程"
                      data-testid="btn-drawer-open-trace"
                    >
                      <ListMagnifyingGlass size={14} />
                      <span>调用明细</span>
                    </button>
                  )}
                  {onOpenSchedule && (
                    <button
                      type="button"
                      className="ot-icon-btn"
                      onClick={() => onOpenSchedule(todo)}
                      title="为此任务设置定时重跑"
                      aria-label="设置定时"
                      data-testid="btn-drawer-schedule"
                    >
                      <Clock size={16} weight="regular" />
                    </button>
                  )}
                  <button
                    type="button"
                    className={`ot-icon-btn ot-icon-btn--danger ${confirmDelete ? 'is-active' : ''}`}
                    onClick={() => setConfirmDelete(v => !v)}
                    title="删除任务"
                    aria-label="删除任务"
                    aria-expanded={confirmDelete}
                    data-testid="btn-drawer-delete"
                  >
                    <Trash size={16} weight="regular" />
                  </button>
                  <Dialog.Close asChild>
                    <button type="button" className="ot-icon-btn ot-desktop-only" aria-label="关闭">
                      <X size={16} weight="regular" />
                    </button>
                  </Dialog.Close>
                </div>
              </div>
              {confirmDelete && (
                <div className="ot-delete-confirm" role="alert" data-testid="drawer-delete-confirm">
                  <span>
                    删除后卡片、定时规则和工作树一并清除，无法恢复。
                    {todo.branch ? ' 已合并的分支会删掉，未合并的分支保留在仓库里。' : ''}
                    {isRunning ? ' 正在运行的构建/审查会先停止。' : ''}
                  </span>
                  <div className="ot-delete-confirm-actions">
                    <button type="button" className="ot-btn ot-btn--sm" onClick={() => setConfirmDelete(false)}>取消</button>
                    <button
                      type="button"
                      className="ot-btn ot-btn--sm ot-btn--danger"
                      disabled={actionsDisabled || todo.phase === 'merging'}
                      data-testid="btn-drawer-delete-confirm"
                      onClick={() => triggerAction('delete', '', '')}
                    >
                      {pendingAction === 'delete' ? '删除中…' : todo.phase === 'merging' ? '合并中，稍后再删' : '确认删除'}
                    </button>
                  </div>
                </div>
              )}

              {isRunning && (
                <div className={`ot-drawer-run-bar ot-drawer-run-bar--${stateMeta.tone}`} data-testid="drawer-running-bar">
                  <div className="ot-run-bar-main">
                    <CircleNotch size={14} weight="bold" className="ot-spin" style={{ flex: 'none' }} />
                    <strong>{stateMeta.statusText}</strong>
                    {todo.liveActivity?.activeTool ? (
                      <span className="ot-run-bar-tool">
                        <Wrench size={11} />
                        <span>{todo.liveActivity.activeTool}</span>
                        {todo.liveActivity.toolCount > 0 && <span>· 第 {todo.liveActivity.toolCount} 次调用</span>}
                      </span>
                    ) : todo.liveActivity?.toolCount > 0 ? (
                      <span className="ot-run-bar-tool">已执行 {todo.liveActivity.toolCount} 次工具调用</span>
                    ) : (
                      <span className="ot-run-bar-sub">
                        {todo.phase === 'merging' ? '正在执行 Git 合并并清理工作树，卡片已移至「执行中」…' : '正在后台隔离环境持续推进…'}
                      </span>
                    )}
                  </div>
                  <div className="ot-run-bar-right">
                    {liveClock && <span className="ot-live-clock">{liveClock}</span>}
                  </div>
                  <div className="ot-run-progress-track" aria-hidden="true">
                    <span className="ot-run-progress-fill" />
                  </div>
                </div>
              )}

              <Tabs.Root value={tab} onValueChange={setTab} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <Tabs.List className="ot-tabs-list">
                  <Tabs.Trigger value="spec" className="ot-tabs-trigger">概览与方案</Tabs.Trigger>
                  <Tabs.Trigger value="chat" className="ot-tabs-trigger">执行对话 ({todo.buildChat?.length || 0})</Tabs.Trigger>
                  <Tabs.Trigger value="diff" className="ot-tabs-trigger" data-testid="drawer-tab-diff">代码 Diff ({todo.diffs?.length || 0})</Tabs.Trigger>
                  <Tabs.Trigger value="timeline" className="ot-tabs-trigger">状态记录</Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="spec" className="ot-dialog-body">
                  {todo.lastError && (
                    <div className="ot-pre" style={{ borderColor: 'var(--ot-diff-del-edge)', color: 'var(--ot-tag-bug-fg)' }}>
                      {todo.lastError}
                    </div>
                  )}

                  {(todo.fallbackHistory?.length || 0) > 0 && (
                    <div className="ot-setting-card" style={{ padding: '10px 12px', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--ot-fs-xs)', fontWeight: 600 }}>
                        <ArrowsLeftRight size={13} style={{ color: 'var(--ot-dot-confirm)' }} />
                        <span>已触发模型故障自动切换（{todo.fallbackHistory.length} 次）</span>
                      </div>
                      {todo.fallbackHistory.map((h, idx) => (
                        <div key={idx} style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                          {h.reason}：{h.fromConfigId} → {h.toConfigId} · {formatRelativeTime(h.at)}
                        </div>
                      ))}
                    </div>
                  )}

                  {todo.question?.active && (
                    <div className="ot-qbox">
                      <div className="ot-qbox-title">{todo.question.title}</div>
                      {todo.question.why && <div className="ot-qbox-why">{todo.question.why}</div>}
                      <div className="ot-qbox-opts">
                        {todo.question.options.map((opt, idx) => (
                          <button
                            key={opt.id}
                            type="button"
                            className="ot-qopt"
                            disabled={busy}
                            onClick={() => onAction(todo.id, 'answer_question', '', opt.id)}
                          >
                            <span className="ot-qopt-left">
                              <span className="ot-qopt-idx">{['A', 'B', 'C', 'D'][idx] || idx + 1}</span>
                              <span>{opt.label}</span>
                            </span>
                            {opt.recommended && <span className="ot-qopt-rec">推荐</span>}
                          </button>
                        ))}
                      </div>
                      <div className="ot-qbox-custom">
                        <input
                          className="ot-input"
                          value={customAnswer}
                          onChange={e => setCustomAnswer(e.target.value)}
                          placeholder="输入自定义意见..."
                        />
                        <button
                          type="button"
                          className="ot-btn ot-btn--primary"
                          disabled={busy || !customAnswer.trim()}
                          onClick={() => {
                            if (!customAnswer.trim()) return
                            onAction(todo.id, 'answer_question', customAnswer.trim(), '')
                            setCustomAnswer('')
                          }}
                        >
                          提交
                        </button>
                      </div>
                    </div>
                  )}

                  {modelConfigs.length > 1 && (todo.phase === 'todo' || todo.phase === 'failed') && (
                    <label className="ot-field-label">
                      <span>本次运行指定模型配置（默认按主备顺序）</span>
                      <select
                        className="ot-input ot-input--sm"
                        value={selectedConfigId}
                        onChange={e => setSelectedConfigId(e.target.value)}
                      >
                        <option value="">自动沿用首选与故障切换链</option>
                        {modelConfigs.map((cfg, idx) => (
                          <option key={cfg.id} value={cfg.id}>
                            {idx === 0 ? '首选' : `备选 #${idx}`} · {ENGINE_LABEL[cfg.engine] || cfg.engine} / {formatModelShort(cfg.model)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <div>
                    <div style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 600, color: 'var(--ot-text-2)', marginBottom: 6 }}>任务规格</div>
                    <LocalAwareText className="ot-pre" text={todo.spec || '（无详细规格说明）'} thumbnails={false} />
                  </div>
                  {todo.evidence?.deliverable && (
                    <div data-testid="todo-deliverable">
                      <div style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 600, color: 'var(--ot-text-2)', marginBottom: 6 }}>交付成果（文字报告）</div>
                      <LocalAwareText className="ot-pre" text={todo.evidence.deliverable} thumbnails={false} />
                    </div>
                  )}
                  {todo.plan && (
                    <div>
                      <div style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 600, color: 'var(--ot-text-2)', marginBottom: 6 }}>实施方案</div>
                      <LocalAwareText className="ot-pre" text={todo.plan} thumbnails={false} />
                    </div>
                  )}
                </Tabs.Content>

                <Tabs.Content value="chat" className="ot-dialog-body">
                  {todo.buildChat?.length ? todo.buildChat.map((entry, idx) => (
                    <div key={idx} className="ot-setting-card" style={{ gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                        <strong style={{ color: 'var(--ot-text)', fontWeight: 600 }}>{entry.role}</strong>
                        <span>{entry.time}</span>
                      </div>
                      <LocalAwareText text={entry.text} style={{ fontSize: 'var(--ot-fs-sm)' }} />
                    </div>
                  )) : (
                    <div style={{ color: 'var(--ot-muted)', fontSize: 'var(--ot-fs-sm)' }}>尚未产生执行会话记录。</div>
                  )}

                  <div className="ot-qbox-custom" style={{ marginTop: 4 }}>
                    <input
                      className="ot-input"
                      value={followUp}
                      onChange={e => setFollowUp(e.target.value)}
                      placeholder="向执行 Agent 补充约束或追问..."
                      onKeyDown={e => {
                        if (isImeComposingEvent(e)) return
                        if (e.key === 'Enter' && followUp.trim()) {
                          onAction(todo.id, 'message_todo', followUp.trim(), '')
                          setFollowUp('')
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ot-btn ot-btn--primary"
                      disabled={busy || !followUp.trim()}
                      onClick={() => {
                        if (!followUp.trim()) return
                        onAction(todo.id, 'message_todo', followUp.trim(), '')
                        setFollowUp('')
                      }}
                    >
                      发送
                    </button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="diff" className="ot-dialog-body">
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="ot-btn"
                      disabled={busy || !todo.worktreePath}
                      onClick={() => onAction(todo.id, 'refresh_diff', '', '')}
                    >
                      <ArrowsClockwise size={13} />
                      <span>刷新快照 Diff</span>
                    </button>
                  </div>

                  <div className="ot-meta-strip">
                    <div className="ot-meta-cell">
                      <small>快照 / 提交</small>
                      <strong>{todo.evidence.commitSha || todo.snapshotSha || 'pending'}</strong>
                    </div>
                    <div className="ot-meta-cell">
                      <small>变更</small>
                      <strong>
                        {todo.evidence.filesChanged} 文件{' '}
                        <span style={{ color: 'var(--ot-diff-add-edge)' }}>+{todo.evidence.additions}</span>/
                        <span style={{ color: 'var(--ot-diff-del-edge)' }}>-{todo.evidence.deletions}</span>
                      </strong>
                    </div>
                    <div className="ot-meta-cell">
                      <small>测试门禁</small>
                      <strong style={{ color: todo.evidence.testRc === 0 ? 'var(--ot-diff-add-edge)' : todo.evidence.testRc > 0 ? 'var(--ot-diff-del-edge)' : 'var(--ot-text-2)' }}>
                        {todo.evidence.testRc === 0 ? 'rc=0 通过' : todo.evidence.testRc > 0 ? `rc=${todo.evidence.testRc} 失败` : '未配置/未运行'}
                      </strong>
                    </div>
                    <div className="ot-meta-cell">
                      <small>独立审查</small>
                      <strong style={{ color: todo.evidence.reviewVerdict === 'approved' ? 'var(--ot-diff-add-edge)' : 'var(--ot-text-2)' }}>
                        {todo.evidence.reviewVerdict === 'approved' ? '已通过' : todo.evidence.reviewVerdict === 'pending' ? '审查中' : todo.evidence.reviewVerdict === 'changes_requested' ? '需修改' : '未发起'}
                      </strong>
                    </div>
                  </div>

                  {(todo.evidence.testCmd || todo.evidence.testSummary) && (
                    <div className="ot-pre">
                      {todo.evidence.testCmd && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ot-text-2)', marginBottom: 4 }}>
                          <TerminalWindow size={13} />
                          <span>{todo.evidence.testCmd}</span>
                        </div>
                      )}
                      <div>{todo.evidence.testSummary}</div>
                    </div>
                  )}

                  {todo.evidence.reviewSummary && (
                    <div className="ot-pre">{todo.evidence.reviewSummary}</div>
                  )}

                  <DiffViewer key={fullDiffs ? 'full' : 'snap'} diffs={fullDiffs || todo.diffs || []} />

                  {todo.phase === 'review' && (
                    <div className="ot-qbox-custom">
                      <input
                        className="ot-input"
                        value={changeFeedback}
                        onChange={e => setChangeFeedback(e.target.value)}
                        placeholder="退回修改原因（可选）..."
                      />
                    </div>
                  )}
                </Tabs.Content>

                <Tabs.Content value="timeline" className="ot-dialog-body">
                  <div className="ot-setting-card" style={{ gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--ot-fs-xs)', fontFamily: 'var(--ot-mono)' }}>
                      <GitBranch size={14} />
                      <span>{todo.branch || '未创建分支'}</span>
                      {todo.snapshotSha && <span style={{ color: 'var(--ot-muted)' }}>({todo.snapshotSha})</span>}
                    </div>
                    <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)', fontFamily: 'var(--ot-mono)', wordBreak: 'break-all' }}>
                      {todo.worktreePath || '尚未分配隔离 Worktree'}
                    </div>
                  </div>

                  {todo.timeline?.map((ev, idx) => (
                    <div key={idx} className="ot-setting-row" style={{ borderTop: idx === 0 ? 0 : undefined }}>
                      <span>{ev.event}</span>
                      <span style={{ color: 'var(--ot-muted)', fontSize: 'var(--ot-fs-xs)', whiteSpace: 'nowrap' }}>
                        {ev.actor} · {formatRelativeTime(ev.time)}
                      </span>
                    </div>
                  ))}
                </Tabs.Content>
              </Tabs.Root>

              <div className="ot-dialog-foot">
                {todo.phase === 'todo' && (
                  <>
                    <button type="button" className="ot-btn" disabled={actionsDisabled} onClick={() => triggerAction('start_build', '', '', true, selectedConfigId)}>
                      先出方案
                    </button>
                    <button type="button" className="ot-btn ot-btn--primary" disabled={actionsDisabled} onClick={() => triggerAction('start_build', '', '', false, selectedConfigId)}>
                      <span>{pendingAction === 'start_build' ? '派发中…' : '开始执行'}</span>
                      <ArrowRight size={13} />
                    </button>
                  </>
                )}

                {todo.phase === 'failed' && (
                  <>
                    <button type="button" className="ot-btn" disabled={actionsDisabled} onClick={() => triggerAction('retry_fresh', '', '', false, selectedConfigId)}>
                      从头重跑
                    </button>
                    <button type="button" className="ot-btn ot-btn--primary" disabled={actionsDisabled} onClick={() => triggerAction('retry_continue', '', '', false, selectedConfigId)} data-testid="btn-retry-continue">
                      <span>{pendingAction === 'retry_continue' ? '启动中…' : '原地继续重试'}</span>
                      <ArrowRight size={13} />
                    </button>
                  </>
                )}

                {(todo.phase === 'building' || todo.phase === 'reviewing') && (
                  <button type="button" className="ot-btn ot-btn--danger" disabled={actionsDisabled} onClick={() => triggerAction('cancel_build', '', '')}>
                    <Stop size={13} />
                    <span>{pendingAction === 'cancel_build' ? '停止中…' : '停止当前运行'}</span>
                  </button>
                )}

                {todo.phase === 'merging' && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-dot-confirm)', fontWeight: 500 }} data-testid="drawer-merging-footer">
                    <CircleNotch size={13} className="ot-spin" />
                    <span>正在合并分支至 {project?.defaultBranch || 'main'}，完成后将自动移入「已完成」…</span>
                  </div>
                )}

                {todo.phase === 'confirm' && !todo.question?.active && (
                  <button type="button" className="ot-btn ot-btn--primary" disabled={actionsDisabled} onClick={() => triggerAction('confirm_plan', '', '')}>
                    {pendingAction === 'confirm_plan' ? '提交中…' : '批准方案并开工'}
                  </button>
                )}

                {todo.phase === 'review' && todo.gateKind === 'deliverable' && (
                  <>
                    <button
                      type="button"
                      className="ot-btn"
                      style={{ marginRight: 'auto' }}
                      disabled={actionsDisabled}
                      onClick={() => {
                        const fb = changeFeedback.trim()
                        setChangeFeedback('')
                        void triggerAction('request_changes', fb, '')
                      }}
                    >
                      补充调研
                    </button>
                    <button type="button" className="ot-btn ot-btn--primary" disabled={actionsDisabled} data-testid="btn-accept-deliverable" onClick={() => triggerAction('complete', '', '')}>
                      {pendingAction === 'complete' ? '提交中…' : '验收完成'}
                    </button>
                  </>
                )}

                {todo.phase === 'review' && todo.gateKind !== 'deliverable' && (
                  <>
                    <button type="button" className="ot-btn" style={{ marginRight: 'auto' }} disabled={actionsDisabled} onClick={() => triggerAction('request_review', '', '')}>
                      {pendingAction === 'request_review' ? '派发审查中…' : '独立审查'}
                    </button>
                    <button
                      type="button"
                      className={todo.gateKind === 'changes' ? 'ot-btn ot-btn--primary' : 'ot-btn ot-btn--danger'}
                      disabled={actionsDisabled}
                      onClick={() => {
                        const fb = changeFeedback.trim()
                        setChangeFeedback('')
                        void triggerAction('request_changes', fb, '')
                      }}
                    >
                      {todo.gateKind === 'changes' ? '按审查意见返工' : '退回修改'}
                    </button>
                    <button
                      type="button"
                      className={todo.gateKind === 'changes' ? 'ot-btn ot-btn--danger' : 'ot-btn ot-btn--primary'}
                      disabled={actionsDisabled}
                      data-testid="btn-approve-merge"
                      onClick={() => triggerAction('approve_merge', '', '')}
                    >
                      {pendingAction === 'approve_merge' && <CircleNotch size={12} className="ot-spin" />}
                      <span>
                        {pendingAction === 'approve_merge'
                          ? '正在合并…'
                          : todo.gateKind === 'deploy'
                            ? '批准放行部署'
                            : todo.gateKind === 'changes'
                              ? '不采纳意见，直接合并'
                              : '批准并合并'}
                      </span>
                    </button>
                  </>
                )}

                {todo.phase === 'queued' && (
                  <button type="button" className="ot-btn" disabled={actionsDisabled} onClick={() => triggerAction('cancel_build', '', '')}>
                    {pendingAction === 'cancel_build' ? '取消中…' : '取消排队'}
                  </button>
                )}

                {(todo.phase === 'done' || todo.phase === 'closed') && (
                  <>
                    <button type="button" className="ot-btn" disabled={actionsDisabled} onClick={() => triggerAction('retry_fresh', '', '')}>
                      从头重跑
                    </button>
                    <button type="button" className="ot-btn" disabled={actionsDisabled} onClick={() => triggerAction('reopen', '', '')}>
                      重新打开
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

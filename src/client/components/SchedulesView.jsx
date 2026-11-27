import React, { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import {
  CaretLeft,
  CaretRight,
  CaretDown,
  Clock,
  Plus,
  X,
  Play,
  Trash,
  PencilSimple,
  ArrowSquareOut,
  Robot,
  CheckCircle,
  WarningCircle,
  SkipForward,
  Sparkle,
} from '@phosphor-icons/react'
import { AgentAvatar, ProjectAvatar } from './AvatarKit.jsx'
import { formatRelativeTime, getProjectLabel } from '../utils.js'
import { dangerCopy } from '../interaction.js'
import { useConfirm } from './ConfirmDialog.jsx'

const FREQ_OPTIONS = [
  ['hourly', '每小时'],
  ['daily', '每天'],
  ['weekly', '每周'],
  ['once', '单次'],
]

const WEEKDAYS = [
  [1, '周一'],
  [2, '周二'],
  [3, '周三'],
  [4, '周四'],
  [5, '周五'],
  [6, '周六'],
  [0, '周日'],
]

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)

function getLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

function defaultOnceDateParts() {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: d.getHours(),
    minute: 0,
  }
}

function formatRuleHuman(s) {
  const hh = String(s.hour ?? 9).padStart(2, '0')
  const mm = String(s.minute ?? 0).padStart(2, '0')
  if (s.frequency === 'hourly') return `每小时第 ${mm} 分`
  if (s.frequency === 'daily') return `每天 ${hh}:${mm}`
  if (s.frequency === 'weekly') {
    const wd = WEEKDAYS.find(([v]) => v === Number(s.weekday))?.[1] || '周一'
    return `每${wd} ${hh}:${mm}`
  }
  if (s.frequency === 'once') {
    return `单次 ${String(s.runAtIso || '').replace('T', ' ').slice(0, 16)}`
  }
  return `每天 ${hh}:${mm}`
}

function formatNextRunTime(ms, tz) {
  if (!ms) return '未排程'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz || getLocalTimezone(),
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toLocaleString('zh-CN')
  }
}

/**
 * 1:1 Todos "新建定时" Modal (matches reference screenshot 1377dba97e3c1440.png)
 */
export function ScheduleModal({
  open,
  onOpenChange,
  projects = [],
  todos = [],
  agents = [],
  initialSchedule = null,
  preselectTodo = null,
  preselectProjectId = '',
  onSave,
  onOpenCreateTask,
}) {
  const localTz = useMemo(() => getLocalTimezone(), [])
  const [projectId, setProjectId] = useState('')
  const [todoId, setTodoId] = useState('')
  const [frequency, setFrequency] = useState('daily')
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [weekday, setWeekday] = useState(1)
  const [onceDate, setOnceDate] = useState(() => defaultOnceDateParts().date)
  const [timezone, setTimezone] = useState(localTz)
  const [agentId, setAgentId] = useState('')
  const [saving, setSaving] = useState(false)

  const workerAgents = useMemo(() => agents.filter(a => a.role !== 'chief'), [agents])

  useEffect(() => {
    if (!open) return
    if (initialSchedule) {
      setProjectId(initialSchedule.projectId || projects[0]?.id || '')
      setTodoId(initialSchedule.todoId || '')
      setFrequency(initialSchedule.frequency || 'daily')
      setHour(Number(initialSchedule.hour ?? 9))
      setMinute(Number(initialSchedule.minute ?? 0))
      setWeekday(Number(initialSchedule.weekday ?? 1))
      setTimezone(initialSchedule.timezone || localTz)
      setAgentId(initialSchedule.agentId || '')
      if (initialSchedule.runAtIso) {
        const m = String(initialSchedule.runAtIso).match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}):(\d{2})/)
        if (m) {
          setOnceDate(m[1])
          setHour(Number(m[2]))
          setMinute(Number(m[3]))
        }
      }
      return
    }
    const defProj = preselectTodo?.projectId || preselectProjectId || projects[0]?.id || ''
    setProjectId(defProj)
    const projTodos = todos.filter(t => t.projectId === defProj)
    setTodoId(preselectTodo?.id || projTodos[0]?.id || '')
    setFrequency('daily')
    const defOnce = defaultOnceDateParts()
    setOnceDate(defOnce.date)
    setHour(9)
    setMinute(0)
    setWeekday(1)
    setTimezone(localTz)
    setAgentId('')
  }, [open, initialSchedule, preselectTodo?.id, preselectProjectId])

  const projectTodos = useMemo(
    () => todos.filter(t => !projectId || t.projectId === projectId),
    [todos, projectId],
  )

  useEffect(() => {
    if (!open) return
    if (todoId && projectTodos.some(t => t.id === todoId)) return
    setTodoId(projectTodos[0]?.id || '')
  }, [projectId, projectTodos, open])

  const selectedProject = projects.find(p => p.id === projectId) || null
  const selectedTodo = projectTodos.find(t => t.id === todoId) || null
  const selectedAgent = workerAgents.find(a => a.id === agentId) || null

  const handleSubmit = async e => {
    e?.preventDefault?.()
    if (!todoId) return
    setSaving(true)
    try {
      const pad = n => String(n).padStart(2, '0')
      const runAtIso = frequency === 'once' ? `${onceDate}T${pad(hour)}:${pad(minute)}` : ''
      await onSave?.({
        ...(initialSchedule?.id ? { id: initialSchedule.id } : {}),
        projectId: selectedTodo?.projectId || projectId,
        todoId,
        frequency,
        hour: Number(hour),
        minute: Number(minute),
        weekday: Number(weekday),
        runAtIso,
        timezone,
        agentId,
        enabled: initialSchedule ? initialSchedule.enabled : true,
      })
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-modal ot-sch-modal" data-testid="schedule-modal">
          <div className="ot-sch-modal-head">
            <Dialog.Title className="ot-sch-modal-title">
              {initialSchedule ? '编辑定时' : '新建定时'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="ot-icon-btn" aria-label="关闭">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <form onSubmit={handleSubmit} className="ot-sch-form">
            {/* Project selector row (pixel-perfect Todos inline icon+label right-aligned) */}
            <label className="ot-sch-row-field ot-sch-row-overlay-host">
              <span className="ot-sch-row-label">项目</span>
              <span className="ot-sch-row-display">
                {selectedProject && <ProjectAvatar project={selectedProject} size={17} />}
                <span className="ot-sch-row-display-txt">{selectedProject ? getProjectLabel(selectedProject) : '暂无项目'}</span>
                <CaretRight size={13} className="ot-sch-chevron" />
              </span>
              <select
                className="ot-sch-overlay-select"
                value={projectId}
                onChange={e => setProjectId(e.target.value)}
                data-testid="select-schedule-project"
              >
                {projects.length === 0 && <option value="">暂无项目</option>}
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{getProjectLabel(p)}</option>
                ))}
              </select>
            </label>

            {/* Task selector row with clean ellipsis & generous gap */}
            <label className="ot-sch-row-field ot-sch-row-overlay-host">
              <span className="ot-sch-row-label">任务</span>
              <span className="ot-sch-row-display">
                <span className="ot-sch-row-display-txt">
                  {selectedTodo ? `#${selectedTodo.number} ${selectedTodo.title}` : '该项目暂无任务（请先新建任务）'}
                </span>
                <CaretRight size={13} className="ot-sch-chevron" />
              </span>
              <select
                className="ot-sch-overlay-select"
                value={todoId}
                onChange={e => setTodoId(e.target.value)}
                data-testid="select-schedule-todo"
              >
                {projectTodos.length === 0 && <option value="">该项目暂无任务（请先新建任务）</option>}
                {projectTodos.map(t => (
                  <option key={t.id} value={t.id}>#{t.number} {t.title}</option>
                ))}
              </select>
            </label>

            {projectTodos.length === 0 && onOpenCreateTask && (
              <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>该项目下还没有任务卡片。</span>
                <button
                  type="button"
                  className="ot-link-btn"
                  onClick={() => { onOpenChange(false); onOpenCreateTask(projectId) }}
                >
                  + 先新建任务
                </button>
              </div>
            )}

            {/* 4-way Frequency Segmented Bar */}
            <div className="ot-sch-freq-bar" role="radiogroup" aria-label="频率" data-testid="schedule-freq-bar">
              {FREQ_OPTIONS.map(([val, lbl]) => (
                <button
                  key={val}
                  type="button"
                  role="radio"
                  aria-checked={frequency === val}
                  className={`ot-sch-freq-tab ${frequency === val ? 'is-active' : ''}`}
                  onClick={() => setFrequency(val)}
                  data-testid={`schedule-freq-${val}`}
                >
                  {lbl}
                </button>
              ))}
            </div>

            {/* Wall-Clock Time Section with unified thin CaretDown + ":" separator */}
            <div className="ot-sch-section">
              <div className="ot-sch-sec-label">时间</div>
              <div className="ot-sch-time-row">
                {frequency === 'weekly' && (
                  <span className="ot-sch-time-wrap">
                    <select
                      className="ot-sch-time-select"
                      value={weekday}
                      onChange={e => setWeekday(Number(e.target.value))}
                      data-testid="select-schedule-weekday"
                    >
                      {WEEKDAYS.map(([v, lbl]) => <option key={v} value={v}>每{lbl}</option>)}
                    </select>
                    <CaretDown size={11} className="ot-select-caret" />
                  </span>
                )}

                {frequency === 'once' && (
                  <input
                    type="date"
                    className="ot-sch-time-select is-date"
                    value={onceDate}
                    onChange={e => setOnceDate(e.target.value)}
                    data-testid="input-schedule-date"
                  />
                )}

                {frequency !== 'hourly' && (
                  <span className="ot-sch-time-wrap">
                    <select
                      className="ot-sch-time-select"
                      value={hour}
                      onChange={e => setHour(Number(e.target.value))}
                      data-testid="select-schedule-hour"
                    >
                      {HOURS.map(h => <option key={h} value={h}>{String(h).padStart(2, '0')}</option>)}
                    </select>
                    <CaretDown size={11} className="ot-select-caret" />
                  </span>
                )}

                {frequency !== 'hourly' && <span className="ot-sch-time-colon">:</span>}

                <span className="ot-sch-time-wrap">
                  <select
                    className="ot-sch-time-select"
                    value={minute}
                    onChange={e => setMinute(Number(e.target.value))}
                    data-testid="select-schedule-minute"
                  >
                    {MINUTES.map(m => (
                      <option key={m} value={m}>
                        {frequency === 'hourly' ? `每小时第 ${String(m).padStart(2, '0')} 分` : String(m).padStart(2, '0')}
                      </option>
                    ))}
                  </select>
                  <CaretDown size={11} className="ot-select-caret" />
                </span>
              </div>
              <div className="ot-sch-tz-hint">按你的本地时区运行（{timezone}）</div>
            </div>

            {/* Agent Section (warm beige filled box matching Screenshot 4) */}
            <div className="ot-sch-section">
              <div className="ot-sch-sec-label">Agent</div>
              <label className="ot-sch-agent-box ot-sch-row-overlay-host">
                <span className="ot-sch-agent-ico">
                  {selectedAgent ? <AgentAvatar agent={selectedAgent} size={22} /> : <span className="ot-sch-dashed-face" />}
                </span>
                <span className="ot-sch-row-display-txt is-left">
                  {selectedAgent ? `${selectedAgent.name} (${selectedAgent.roleLabel || selectedAgent.role})` : '跟随任务'}
                </span>
                <CaretRight size={13} className="ot-sch-chevron" />
                <select
                  className="ot-sch-overlay-select"
                  value={agentId}
                  onChange={e => setAgentId(e.target.value)}
                  data-testid="select-schedule-agent"
                >
                  <option value="">跟随任务</option>
                  {workerAgents.map(a => (
                    <option key={a.id} value={a.id}>{a.name} ({a.roleLabel || a.role})</option>
                  ))}
                </select>
              </label>
            </div>

            {/* Machine Row (aligned with Todos Screenshot 4, consistent font-weight 500 & clear section gap) */}
            <div className="ot-sch-row-field is-static" style={{ marginTop: 4 }}>
              <span className="ot-sch-row-label">机器</span>
              <span className="ot-sch-row-value">
                <span>自动（本机 Ekko Studio 引擎）</span>
                <CaretRight size={13} className="ot-sch-chevron" />
              </span>
            </div>

            {/* Footer Actions */}
            <div className="ot-sch-modal-foot">
              <Dialog.Close asChild>
                <button type="button" className="ot-btn">取消</button>
              </Dialog.Close>
              <button
                type="submit"
                className="ot-btn ot-btn--indigo"
                disabled={!todoId || saving}
                data-testid="btn-save-schedule"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Full Schedules View (matches Screenshot 5 empty state + active rules management)
 */
export function SchedulesView({
  schedules = [],
  projects = [],
  todos = [],
  agents = [],
  onBack,
  onOpenNewModal,
  onEditSchedule,
  onToggleSchedule,
  onDeleteSchedule,
  onTriggerSchedule,
  onOpenTodo,
}) {
  const projectById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects])
  const todoById = useMemo(() => new Map(todos.map(t => [t.id, t])), [todos])
  const agentById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents])
  const [askConfirm, confirmNode] = useConfirm()

  return (
    <section className="ot-sch-view" data-testid="schedules-view">
      <header className="ot-proj-topbar">
        <div className="ot-proj-topbar-left">
          <button
            type="button"
            className="ot-icon-btn"
            onClick={onBack}
            title="返回工作台 (⌘[)"
            data-testid="btn-schedules-back"
          >
            <CaretLeft size={16} weight="bold" />
          </button>
          <Clock size={16} weight="duotone" style={{ color: 'var(--ot-text-2)' }} />
          <strong className="ot-proj-topbar-name">定时任务</strong>
          <span className="ot-hub-count-pill">{schedules.length} / 50</span>
        </div>

        <div className="ot-proj-topbar-right">
          {schedules.length > 0 && (
            <button
              type="button"
              className="ot-btn ot-btn--indigo ot-btn--sm"
              onClick={() => onOpenNewModal?.()}
              data-testid="btn-header-new-schedule"
            >
              <Plus size={13} weight="bold" />
              <span>新建定时</span>
            </button>
          )}
        </div>
      </header>

      <div className="ot-sch-scroll">
        {schedules.length === 0 ? (
          /* 1:1 Todos Screenshot 5 Empty State */
          <div className="ot-sch-empty" data-testid="schedules-empty-state">
            <div className="ot-sch-empty-icon">
              <Clock size={22} weight="regular" />
            </div>
            <h2 className="ot-sch-empty-title">还没有定时任务</h2>
            <p className="ot-sch-empty-desc">
              按周期或指定时间重跑任务（未合并改动将被重置，关键关口会暂停确认）。
            </p>
            <div className="ot-sch-empty-acts">
              <button
                type="button"
                className="ot-btn ot-btn--indigo"
                onClick={() => onOpenNewModal?.()}
                data-testid="btn-empty-new-schedule"
              >
                新建定时
              </button>
            </div>
            <div className="ot-sch-empty-chief-tip">
              <Sparkle size={14} weight="regular" style={{ flex: 'none' }} />
              <span>也可直接在对话里让大总管设置定时。</span>
            </div>
          </div>
        ) : (
          <div className="ot-sch-list" data-testid="schedules-list">
            <div className="ot-sch-list-tip">
              <Robot size={14} style={{ flex: 'none', color: 'var(--ot-auto-fg)' }} />
              <span>到点自动重跑；也可在对话里直接说「每天 9 点跑 #1」。</span>
            </div>
            {schedules.map(s => {
              const proj = projectById.get(s.projectId)
              const todo = todoById.get(s.todoId)
              const ag = s.agentId ? agentById.get(s.agentId) : (todo?.agentId ? agentById.get(todo.agentId) : null)
              const statusIcon = s.lastStatus === 'triggered' || s.lastStatus === 'queued'
                ? <CheckCircle size={12} style={{ color: 'var(--ot-dot-done)' }} />
                : s.lastStatus === 'skipped'
                  ? <SkipForward size={12} style={{ color: 'var(--ot-dot-confirm)' }} />
                  : s.lastStatus === 'failed'
                    ? <WarningCircle size={12} style={{ color: 'var(--ot-dot-fail)' }} />
                    : null

              return (
                <article key={s.id} className={`ot-sch-card ${!s.enabled ? 'is-paused' : ''}`} data-testid={`schedule-card-${s.id}`}>
                  <div className="ot-sch-card-main">
                    <div className="ot-sch-card-top">
                      <Switch.Root
                        className="ot-switch"
                        checked={s.enabled}
                        onCheckedChange={checked => onToggleSchedule?.(s.id, checked)}
                      >
                        <Switch.Thumb className="ot-switch-thumb" />
                      </Switch.Root>
                      {proj && <ProjectAvatar project={proj} size={18} />}
                      <button
                        type="button"
                        className="ot-sch-todo-link"
                        onClick={() => todo && onOpenTodo?.(todo.id)}
                      >
                        <span className="ot-sch-todo-num">#{todo?.number || '?'}</span>
                        <span>{todo?.title || '（原任务已删除）'}</span>
                      </button>
                      <span className="ot-sch-cadence-pill">
                        <Clock size={11} />
                        <span>{formatRuleHuman(s)}</span>
                      </span>
                    </div>

                    <div className="ot-sch-card-meta">
                      <span>时区：{s.timezone}</span>
                      <span>·</span>
                      <span>下次运行：<strong>{s.enabled ? formatNextRunTime(s.nextRunAt, s.timezone) : '已暂停'}</strong></span>
                      <span>·</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        Agent：{s.agentId && ag ? ag.name : `跟随任务${ag ? `（${ag.name}）` : ''}`}
                      </span>
                      {s.createdBy === 'chief' && <span className="ot-quota-plan-pill">大总管创建</span>}
                    </div>

                    {(s.lastStatus || s.lastMessage) && (
                      <div className="ot-sch-card-last">
                        {statusIcon}
                        <span>上次（{s.lastRunAt ? formatRelativeTime(s.lastRunAt) : '—'}）：{s.lastMessage || s.lastStatus}</span>
                      </div>
                    )}
                  </div>

                  <div className="ot-sch-card-acts">
                    <button
                      type="button"
                      className="ot-btn ot-btn--sm"
                      onClick={() => onTriggerSchedule?.(s.id)}
                      title="立即执行一次"
                      data-testid={`btn-trigger-schedule-${s.id}`}
                    >
                      <Play size={12} weight="fill" />
                      <span>立即运行</span>
                    </button>
                    <button
                      type="button"
                      className="ot-icon-btn"
                      onClick={() => onEditSchedule?.(s)}
                      title="编辑定时规则"
                    >
                      <PencilSimple size={14} />
                    </button>
                    <button
                      type="button"
                      className="ot-icon-btn"
                      onClick={() => askConfirm(
                        dangerCopy('schedule', { name: `${todo ? `#${todo.number} ${todo.title} · ` : ''}${formatRuleHuman(s)}` }),
                        () => onDeleteSchedule?.(s.id),
                      )}
                      title="删除定时规则"
                      data-testid={`btn-delete-schedule-${s.id}`}
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
      {confirmNode}
    </section>
  )
}

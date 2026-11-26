import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { AnimatePresence, LayoutGroup, m } from 'motion/react'
import {
  Funnel,
  ArrowsOutSimple,
  ArrowsInSimple,
  Plus,
  Tray,
  CircleDashed,
  CheckCircle,
  Clock,
  ChatText,
  X,
  GithubLogo,
  ArrowsLeftRight,
  CircleNotch,
  WarningCircle,
  BellRinging,
  ArrowRight,
  ArrowLeft,
  UserCircle,
  Robot,
  CaretRight,
  CaretLeft,
  Check,
  MagnifyingGlass,
} from '@phosphor-icons/react'
import { AgentAvatar, ProjectAvatar } from './AvatarKit.jsx'
import { HomeQuotaStrip } from './HomeQuotaStrip.jsx'
import {
  formatRelativeTime,
  formatSidebarAge,
  formatLiveClock,
  getTodoCardStateMeta,
  getProjectLabel,
  KIND_LABEL,
  sortLaneCards,
} from '../utils.js'
import { resolveLaneModes, pickInitialLane, laneIndexFromScroll, PHONE_MAX_WIDTH } from '../layout.js'

const COLUMNS = [
  { id: 'todo', label: '待开始', dot: 'todo', emptyIcon: Tray },
  { id: 'doing', label: '执行中', dot: 'doing', emptyIcon: CircleDashed },
  { id: 'confirm', label: '待你处理', dot: 'confirm', emptyIcon: Clock },
  { id: 'done', label: '已完成', dot: 'done', emptyIcon: CheckCircle },
]
const LANE_IDS = COLUMNS.map(c => c.id)

const CARD_SPRING = {
  type: 'spring',
  stiffness: 420,
  damping: 30,
  mass: 0.85,
}

const DEFAULT_FILTERS = Object.freeze({
  creator: 'all',
  waitOwner: 'all', // 'all' | 'human' | 'chief' | 'none'
  stage: 'all',     // 'all' | 'todo' | 'confirm' | 'building' | 'reviewing' | 'review' | 'failed' | 'done'
  agentId: 'all',
  topicId: 'all',
  kind: 'all',
  artifact: 'all',  // 'all' | 'has_plan' | 'has_diff' | 'has_error' | 'test_passed'
  tag: 'all',
  search: '',
})

const CREATOR_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'human', label: '我创建的' },
  { value: 'chief', label: '大总管拆解' },
]

const WAIT_OWNER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'human', label: '等我拍板' },
  { value: 'chief', label: '大总管跟进中' },
  { value: 'none', label: '无需确认' },
]

const STAGE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'todo', label: '待开始' },
  { value: 'queued', label: '排队中' },
  { value: 'confirm', label: '方案待确认' },
  { value: 'building', label: '编码构建中' },
  { value: 'reviewing', label: '独立审查中' },
  { value: 'merging', label: '合并分支中' },
  { value: 'review', label: '待验收合并' },
  { value: 'failed', label: '执行失败' },
  { value: 'done', label: '已完成' },
]

const KIND_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'feature', label: '功能' },
  { value: 'bug', label: '缺陷' },
  { value: 'content', label: '内容 / 运营' },
  { value: 'question', label: '调研 / 方案' },
  { value: 'deploy', label: '部署' },
]

const ARTIFACT_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'has_plan', label: '含实施方案' },
  { value: 'has_diff', label: '含代码变更 Diff' },
  { value: 'test_passed', label: '已通过自动验收' },
  { value: 'has_error', label: '含运行异常' },
]

export function mapPhaseToColumn(todo) {
  if (todo.phase === 'done' || todo.phase === 'closed') return 'done'
  if (todo.phase === 'todo' || todo.phase === 'queued') return 'todo'
  if (todo.phase === 'failed' || todo.gateOwner === 'human' || todo.phase === 'confirm' || todo.phase === 'review') return 'confirm'
  return 'doing'
}

function ProgressRing({ done, total }) {
  const pct = total > 0 ? done / total : 0
  const r = 6.5
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - pct)
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--ot-ring-track)" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="var(--ot-dot-done)"
        strokeWidth="2"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
        style={{ transition: 'stroke-dashoffset 280ms cubic-bezier(0.22, 1, 0.36, 1)' }}
      />
    </svg>
  )
}

/**
 * Actionable Topic Decision card surfaced directly at the top of "待你处理"
 * whenever Chief's Topic Brief carries an unhandled `waitingOnYou` decision.
 */
const TopicDecisionCard = memo(function TopicDecisionCard({ topic, proj, isCurrentTopic, onOpenDecision }) {
  const headline = topic.brief?.waitingTitle || topic.brief?.waitingOnYou || ''
  return (
    <m.button
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.985 }}
      type="button"
      className={`ot-card ot-decision-card ${isCurrentTopic ? 'is-current-topic' : ''}`}
      onClick={() => onOpenDecision?.(topic.id)}
      title="点击打开批复确认窗口，选择或填写决定并通知大总管"
      data-testid={`waiting-topic-card-${topic.id}`}
    >
      <div className="ot-decision-card-top">
        <span className="ot-decision-badge">
          <span className="ot-amber-beacon" />
          <span>待你批复</span>
        </span>
        <span className="ot-decision-topic-name" title={topic.title}>
          {topic.title}
        </span>
      </div>

      <div className="ot-decision-card-body">{headline}</div>

      <div className="ot-card-row3">
        <span className="ot-decision-cta">
          <BellRinging size={11} weight="fill" style={{ flex: 'none' }} />
          <span>去批复</span>
          <ArrowRight size={10.5} weight="bold" style={{ flex: 'none' }} />
        </span>
        <span className="ot-decision-meta-right">
          <span className="ot-card-time">{formatRelativeTime(topic.brief?.updatedAt || topic.updatedAt)}</span>
          {proj && <ProjectAvatar project={proj} size={18} title={getProjectLabel(proj)} />}
        </span>
      </div>
    </m.button>
  )
})

const KanbanCard = memo(function KanbanCard({
  td,
  proj,
  assignedAgent,
  colId,
  isSelected,
  justMovedCol,
  liveTick,
  onOpenTodo,
}) {
  const stateMeta = getTodoCardStateMeta(td)
  const isFailed = td.phase === 'failed'
  const isRunning = stateMeta.running
  const isDone = td.phase === 'done'
  const tagKey = td.kind || 'feature'
  const tagLabel = KIND_LABEL[td.kind] || td.kind || '功能'
  const chatCount = td.buildChat?.length || 0
  const switched = (td.fallbackHistory?.length || 0) > 0
  const liveClock = isRunning ? formatLiveClock(td.liveActivity?.startedAt || td.updatedAt) : ''
  const liveDetailText = td.liveActivity?.activeTool
    ? `执行 ${td.liveActivity.activeTool}${td.liveActivity.toolCount > 0 ? ` · #${td.liveActivity.toolCount}` : ''}`
    : td.liveActivity?.toolCount > 0
      ? `运行中 · 已调 ${td.liveActivity.toolCount} 次工具`
      : td.phase === 'merging'
        ? '正在合并并清理工作树…'
        : td.phase === 'reviewing'
          ? '独立只读审计 Diff 中…'
          : '隔离工作树持续执行中…'
  void liveTick

  const cardClasses = [
    'ot-card',
    `ot-card--${stateMeta.tone}`,
    isSelected ? 'is-selected' : '',
    isRunning ? 'is-running' : '',
    isFailed ? 'is-failed' : '',
    isDone ? 'is-done' : '',
    justMovedCol ? `is-just-moved is-landed--${justMovedCol}` : '',
  ].filter(Boolean).join(' ')

  return (
    <m.button
      layout
      layoutId={`todo-card-${td.id}`}
      initial={{ opacity: 0, scale: 0.94, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.92, y: -6 }}
      transition={{
        layout: CARD_SPRING,
        opacity: { duration: 0.18 },
        scale: { duration: 0.2 },
      }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.985 }}
      type="button"
      draggable
      onDragStart={e => {
        e.dataTransfer?.setData('application/x-ekko-todo-card', JSON.stringify({ id: td.id, number: td.number, title: td.title }))
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
      }}
      className={cardClasses}
      onClick={() => onOpenTodo(td.id)}
      title="点击查看详情/审批，或直接拖入左侧对话输入框引用给总管"
      data-testid={`card-${td.id}`}
      data-phase={td.phase}
      data-col={colId}
    >
      {isRunning && (
        <span
          className={`ot-card-shimmer ${td.phase === 'reviewing' ? 'is-reviewing' : td.phase === 'merging' ? 'is-merging' : ''}`}
          aria-hidden="true"
        />
      )}

      <div className="ot-card-row1">
        <span className="ot-card-title">{td.title}</span>
        <span className="ot-card-num">#{td.number}</span>
      </div>

      {isRunning && (
        <div className={`ot-card-run-strip ot-card-run-strip--${stateMeta.tone}`} data-testid={`card-run-strip-${td.id}`}>
          <div className="ot-card-run-top">
            <span className="ot-card-run-label">
              <CircleNotch size={11} weight="bold" className="ot-spin" style={{ flex: 'none' }} />
              <span className="ot-card-run-text">{liveDetailText}</span>
            </span>
            {liveClock && <span className="ot-live-clock">{liveClock}</span>}
          </div>
          <div className="ot-run-progress-track" aria-hidden="true">
            <span className="ot-run-progress-fill" />
          </div>
        </div>
      )}

      <div className="ot-card-row2">
        <span className="ot-card-badges">
          <span className={`ot-tag ot-tag--${tagKey}`}>{tagLabel}</span>
          <span className={`ot-state-pill ot-state-pill--${stateMeta.tone}`} data-testid={`card-status-${td.id}`}>
            {isRunning ? (
              <span className="ot-pulse-dot" style={{ width: 5, height: 5 }} />
            ) : isFailed ? (
              <WarningCircle size={10.5} weight="fill" />
            ) : isDone ? (
              <CheckCircle size={10.5} weight="fill" />
            ) : stateMeta.tone === 'human' ? (
              <UserCircle size={10.5} weight="fill" />
            ) : stateMeta.tone === 'chief' ? (
              <Robot size={10.5} weight="fill" />
            ) : stateMeta.tone === 'ready' ? (
              <CheckCircle size={10.5} weight="bold" />
            ) : null}
            <span>{stateMeta.statusText}</span>
          </span>
        </span>
      </div>

      <div className="ot-card-row3">
        <span className="ot-card-meta-left">
          {!isRunning && (
            <span className="ot-card-time">{formatSidebarAge(td.updatedAt)}</span>
          )}
          {assignedAgent && (
            <span className="ot-card-agent" title={`负责 Agent：${assignedAgent.name}`}>
              <AgentAvatar agent={assignedAgent} size={14} />
              <span>{assignedAgent.name}</span>
            </span>
          )}
          {switched && <ArrowsLeftRight size={11} style={{ color: 'var(--ot-dot-confirm)', flex: 'none' }} title="已自动切换备选模型" />}
          {chatCount > 0 && !isRunning && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none' }}>
              <ChatText size={11} weight="regular" />
              <span>{chatCount}</span>
            </span>
          )}
        </span>
        <ProjectAvatar project={proj} size={18} title={getProjectLabel(proj)} />
      </div>
    </m.button>
  )
})

/**
 * Todos-authentic 9-dimension drill-down Filter Popover
 * matching the minimalist warm-paper multi-row layout from the reference screenshot.
 */
function TodosFilterPopover({
  open,
  onOpenChange,
  filters,
  selectedProjectId,
  projects,
  agents,
  topics,
  allTags,
  activeCount,
  onUpdateFilter,
  onSelectProject,
  onResetAll,
}) {
  const [drill, setDrill] = useState(null) // null | dimension key

  useEffect(() => {
    if (!open) setDrill(null)
  }, [open])

  const projectLabel = selectedProjectId === 'all'
    ? '全部'
    : (getProjectLabel(projects.find(p => p.id === selectedProjectId)) || '已选')
  const agentLabel = filters.agentId === 'all'
    ? '全部'
    : (agents.find(a => a.id === filters.agentId)?.name || '已选')
  const topicLabel = filters.topicId === 'all'
    ? '全部'
    : (topics.find(t => t.id === filters.topicId)?.title || '已选')

  const findLabel = (list, val) => list.find(i => i.value === val)?.label || '全部'

  const dimensions = [
    { key: 'creator', label: '创建者', valueText: findLabel(CREATOR_OPTIONS, filters.creator), active: filters.creator !== 'all' },
    { key: 'waitOwner', label: '等谁确认', valueText: findLabel(WAIT_OWNER_OPTIONS, filters.waitOwner), active: filters.waitOwner !== 'all' },
    { key: 'stage', label: '阶段', valueText: findLabel(STAGE_OPTIONS, filters.stage), active: filters.stage !== 'all' },
    { key: 'project', label: '项目', valueText: projectLabel, active: selectedProjectId !== 'all' },
    { key: 'agent', label: 'Agent', valueText: agentLabel, active: filters.agentId !== 'all' },
    { key: 'topic', label: '话题', valueText: topicLabel, active: filters.topicId !== 'all' },
    { key: 'kind', label: '类型', valueText: findLabel(KIND_OPTIONS, filters.kind), active: filters.kind !== 'all' },
    { key: 'artifact', label: '方案与变更', valueText: findLabel(ARTIFACT_OPTIONS, filters.artifact), active: filters.artifact !== 'all' },
    {
      key: 'tag',
      label: '标签与关键词',
      valueText: filters.search.trim()
        ? `“${filters.search.trim().slice(0, 8)}”`
        : (filters.tag !== 'all' ? `#${filters.tag}` : '全部'),
      active: Boolean(filters.search.trim()) || filters.tag !== 'all',
    },
  ]

  const renderDrillContent = () => {
    const dim = dimensions.find(d => d.key === drill)
    if (!dim) return null

    const renderOptionList = (items, currentVal, onPick) => (
      <div className="ot-filter-sublist">
        {items.map(item => {
          const picked = currentVal === item.value
          return (
            <button
              key={item.value}
              type="button"
              className={`ot-filter-subitem ${picked ? 'is-active' : ''}`}
              onClick={() => { onPick(item.value); setDrill(null) }}
              data-testid={`filter-opt-${drill}-${item.value}`}
            >
              <span className="ot-filter-subitem-left">
                {item.avatar}
                <span>{item.label}</span>
              </span>
              {picked && <Check size={13} weight="bold" style={{ flex: 'none' }} />}
            </button>
          )
        })}
      </div>
    )

    let body = null
    if (drill === 'creator') {
      body = renderOptionList(CREATOR_OPTIONS, filters.creator, v => onUpdateFilter('creator', v))
    } else if (drill === 'waitOwner') {
      body = renderOptionList(WAIT_OWNER_OPTIONS, filters.waitOwner, v => onUpdateFilter('waitOwner', v))
    } else if (drill === 'stage') {
      body = renderOptionList(STAGE_OPTIONS, filters.stage, v => onUpdateFilter('stage', v))
    } else if (drill === 'project') {
      body = renderOptionList(
        [
          { value: 'all', label: '全部项目' },
          ...projects.map(p => ({
            value: p.id,
            label: getProjectLabel(p),
            avatar: <ProjectAvatar project={p} size={16} />,
          })),
        ],
        selectedProjectId,
        v => onSelectProject?.(v),
      )
    } else if (drill === 'agent') {
      body = renderOptionList(
        [
          { value: 'all', label: '全部 Agent' },
          ...agents.map(a => ({
            value: a.id,
            label: a.name,
            avatar: <AgentAvatar agent={a} size={16} />,
          })),
        ],
        filters.agentId,
        v => onUpdateFilter('agentId', v),
      )
    } else if (drill === 'topic') {
      body = renderOptionList(
        [
          { value: 'all', label: '全部话题' },
          ...topics.filter(t => !t.archived).slice(0, 30).map(t => ({
            value: t.id,
            label: t.title,
          })),
        ],
        filters.topicId,
        v => onUpdateFilter('topicId', v),
      )
    } else if (drill === 'kind') {
      body = renderOptionList(KIND_OPTIONS, filters.kind, v => onUpdateFilter('kind', v))
    } else if (drill === 'artifact') {
      body = renderOptionList(ARTIFACT_OPTIONS, filters.artifact, v => onUpdateFilter('artifact', v))
    } else if (drill === 'tag') {
      body = (
        <div style={{ padding: '4px 8px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <MagnifyingGlass size={13} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--ot-muted)' }} />
            <input
              className="ot-input ot-input--sm"
              style={{ paddingLeft: 28 }}
              placeholder="搜索任务标题、编号或规格…"
              value={filters.search}
              onChange={e => onUpdateFilter('search', e.target.value)}
              autoFocus
              data-testid="input-board-search"
            />
          </div>
          {allTags.length > 0 ? (
            renderOptionList(
              [{ value: 'all', label: '全部标签' }, ...allTags.map(t => ({ value: t, label: `#${t}` }))],
              filters.tag,
              v => onUpdateFilter('tag', v),
            )
          ) : (
            <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', padding: '2px 4px' }}>
              输入关键词筛选卡片。
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="ot-filter-drill">
        <button type="button" className="ot-filter-drill-head" onClick={() => setDrill(null)}>
          <CaretLeft size={13} />
          <span>{dim.label}</span>
        </button>
        {body}
      </div>
    )
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`ot-icon-btn ot-filter-trigger ${(activeCount > 0 || open) ? 'is-active' : ''}`}
          title="多维度筛选看板"
          aria-label="筛选看板"
          data-testid="btn-board-filter"
        >
          <Funnel size={15} weight={activeCount > 0 ? 'fill' : 'regular'} />
          {activeCount > 0 && <span className="ot-filter-count-badge">{activeCount}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="ot-todos-filter-popover"
          align="end"
          sideOffset={10}
          data-testid="todos-filter-popover"
        >
          {drill ? (
            renderDrillContent()
          ) : (
            <div className="ot-filter-dim-list">
              {dimensions.map(dim => (
                <button
                  key={dim.key}
                  type="button"
                  className="ot-filter-dim-row"
                  onClick={() => setDrill(dim.key)}
                  data-testid={`filter-dim-${dim.key}`}
                >
                  <span className="ot-filter-dim-name">{dim.label}</span>
                  <span className={`ot-filter-dim-val ${dim.active ? 'is-active' : ''}`}>
                    <span>{dim.valueText}</span>
                    <CaretRight size={12} weight="regular" />
                  </span>
                </button>
              ))}
              {activeCount > 0 && (
                <div className="ot-filter-reset-bar">
                  <button
                    type="button"
                    className="ot-filter-reset-btn"
                    onClick={() => { onResetAll(); onOpenChange(false) }}
                    data-testid="btn-filter-reset-all"
                  >
                    重置全部筛选 ({activeCount})
                  </button>
                </div>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export const KanbanBoard = memo(function KanbanBoard({
  projects,
  agents = [],
  topics = [],
  todos,
  quotaProviders = [],
  quotaRefreshing = false,
  selectedProjectId,
  activeTopicId,
  selectedTodoId,
  onlyHumanAttention,
  boardExpanded,
  onToggleOnlyHuman,
  onSelectProject,
  onClearProjectFilter,
  onToggleExpand,
  onOpenTodo,
  onOpenTopicDecision,
  onOpenCreateTask,
  onOpenQuotaHub,
  onRefreshQuotas,
  // Todo #73: cards the board snapshot left out because even their stubs did not fit (state.todosOmitted).
  todosOmitted = 0,
}) {
  const [collapsedCols, setCollapsedCols] = useState({})
  const [recentMoves, setRecentMoves] = useState({})
  const [liveTick, setLiveTick] = useState(0)
  const [filterOpen, setFilterOpen] = useState(false)
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const prevStateMapRef = useRef(new Map())
  const moveTimersRef = useRef(new Map())
  const gridRef = useRef(null)
  const laneScrollRafRef = useRef(0)
  // Measured width of the lane area (0 = not laid out yet, e.g. the board pane is hidden on a phone).
  const [boardWidth, setBoardWidth] = useState(0)
  const [isPhone, setIsPhone] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= PHONE_MAX_WIDTH : false))
  // Phone: the lane currently on screen (one lane per page).
  const [phoneLane, setPhoneLane] = useState('')

  useEffect(() => {
    const mq = window.matchMedia?.(`(max-width: ${PHONE_MAX_WIDTH}px)`)
    if (!mq) return
    const sync = () => setIsPhone(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])

  useEffect(() => {
    const el = gridRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => setBoardWidth(Math.round(el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => () => {
    if (laneScrollRafRef.current) cancelAnimationFrame(laneScrollRafRef.current)
  }, [])

  // Keep external `onlyHumanAttention` prop synchronized with `waitOwner`
  useEffect(() => {
    setFilters(prev => {
      if (onlyHumanAttention && prev.waitOwner !== 'human') return { ...prev, waitOwner: 'human' }
      if (!onlyHumanAttention && prev.waitOwner === 'human') return { ...prev, waitOwner: 'all' }
      return prev
    })
  }, [onlyHumanAttention])

  const updateFilter = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }))
    if (key === 'waitOwner') {
      onToggleOnlyHuman?.(value === 'human')
    }
  }

  const resetAllFilters = () => {
    setFilters(DEFAULT_FILTERS)
    onToggleOnlyHuman?.(false)
    onClearProjectFilter?.()
  }

  const activeProject = projects.find(p => p.id === selectedProjectId)

  const allTags = useMemo(() => {
    const set = new Set()
    for (const td of todos) {
      for (const tg of td.tags || []) {
        if (tg) set.add(tg)
      }
    }
    return [...set]
  }, [todos])

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase()
    return todos.filter(td => {
      if (selectedProjectId !== 'all' && td.projectId !== selectedProjectId) return false
      if (filters.creator !== 'all' && (td.createdBy || 'chief') !== filters.creator) return false
      if (filters.waitOwner === 'human' && td.gateOwner !== 'human') return false
      if (filters.waitOwner === 'chief' && td.gateOwner !== 'chief') return false
      if (filters.waitOwner === 'none' && td.gateOwner !== 'none') return false
      if (filters.stage !== 'all' && td.phase !== filters.stage) return false
      if (filters.agentId !== 'all' && td.agentId !== filters.agentId && td.reviewerId !== filters.agentId) return false
      if (filters.topicId !== 'all' && td.topicId !== filters.topicId) return false
      if (filters.kind !== 'all' && td.kind !== filters.kind) return false
      // A stubbed card (todos[].stubbed) carries hasPlan / diffCount instead of its plan and diff list.
      if (filters.artifact === 'has_plan' && !td.plan && !td.hasPlan) return false
      if (filters.artifact === 'has_diff' && !(td.diffs?.length > 0) && !(td.diffCount > 0)) return false
      if (filters.artifact === 'test_passed' && td.evidence?.testRc !== 0) return false
      if (filters.artifact === 'has_error' && !td.lastError && td.phase !== 'failed') return false
      if (filters.tag !== 'all' && !(td.tags || []).includes(filters.tag)) return false
      if (q) {
        const hay = `#${td.number} ${td.title || ''} ${td.spec || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [todos, selectedProjectId, filters])

  // Actionable Topic-level decisions (`waitingOnYou`) surfaced directly in "待你处理"
  const waitingTopics = useMemo(() => {
    if (filters.waitOwner === 'chief' || filters.waitOwner === 'none') return []
    if (filters.stage !== 'all' && filters.stage !== 'confirm') return []
    const q = filters.search.trim().toLowerCase()
    return (topics || [])
      .filter(tp => !tp.archived && String(tp.brief?.waitingOnYou || '').trim())
      .filter(tp => selectedProjectId === 'all' || !tp.projectId || tp.projectId === selectedProjectId)
      .filter(tp => filters.topicId === 'all' || tp.id === filters.topicId)
      .filter(tp => !q || `${tp.title} ${tp.brief?.waitingTitle || ''} ${tp.brief?.waitingOnYou || ''}`.toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.id === activeTopicId) return -1
        if (b.id === activeTopicId) return 1
        return Number(b.brief?.updatedAt || b.updatedAt || 0) - Number(a.brief?.updatedAt || a.updatedAt || 0)
      })
  }, [topics, selectedProjectId, activeTopicId, filters])

  const activeFilterChips = useMemo(() => {
    const chips = []
    if (activeProject) {
      chips.push({ key: 'project', label: getProjectLabel(activeProject), hasGh: Boolean(activeProject.githubRepo), onClear: () => onClearProjectFilter?.() })
    }
    if (filters.waitOwner !== 'all') {
      chips.push({ key: 'waitOwner', label: WAIT_OWNER_OPTIONS.find(o => o.value === filters.waitOwner)?.label || filters.waitOwner, onClear: () => updateFilter('waitOwner', 'all') })
    }
    if (filters.creator !== 'all') {
      chips.push({ key: 'creator', label: CREATOR_OPTIONS.find(o => o.value === filters.creator)?.label, onClear: () => updateFilter('creator', 'all') })
    }
    if (filters.stage !== 'all') {
      chips.push({ key: 'stage', label: STAGE_OPTIONS.find(o => o.value === filters.stage)?.label, onClear: () => updateFilter('stage', 'all') })
    }
    if (filters.agentId !== 'all') {
      const ag = agents.find(a => a.id === filters.agentId)
      chips.push({ key: 'agent', label: `Agent: ${ag?.name || '已选'}`, onClear: () => updateFilter('agentId', 'all') })
    }
    if (filters.topicId !== 'all') {
      const tp = topics.find(t => t.id === filters.topicId)
      chips.push({ key: 'topic', label: `话题: ${tp?.title?.slice(0, 12) || '已选'}`, onClear: () => updateFilter('topicId', 'all') })
    }
    if (filters.kind !== 'all') {
      chips.push({ key: 'kind', label: KIND_OPTIONS.find(o => o.value === filters.kind)?.label, onClear: () => updateFilter('kind', 'all') })
    }
    if (filters.artifact !== 'all') {
      chips.push({ key: 'artifact', label: ARTIFACT_OPTIONS.find(o => o.value === filters.artifact)?.label, onClear: () => updateFilter('artifact', 'all') })
    }
    if (filters.tag !== 'all') {
      chips.push({ key: 'tag', label: `#${filters.tag}`, onClear: () => updateFilter('tag', 'all') })
    }
    if (filters.search.trim()) {
      chips.push({ key: 'search', label: `搜: ${filters.search.trim()}`, onClear: () => updateFilter('search', '') })
    }
    return chips
  }, [activeProject, filters, agents, topics])

  const hasAnyRunning = useMemo(
    () => filtered.some(td => td.phase === 'building' || td.phase === 'reviewing' || td.phase === 'merging'),
    [filtered],
  )

  useEffect(() => {
    if (!hasAnyRunning) return
    const timer = setInterval(() => setLiveTick(t => t + 1), 1000)
    return () => clearInterval(timer)
  }, [hasAnyRunning])

  useEffect(() => {
    const prev = prevStateMapRef.current
    const changed = []
    const nextMap = new Map()

    for (const td of todos) {
      const col = mapPhaseToColumn(td)
      const sig = `${col}:${td.phase}:${td.gateOwner}`
      nextMap.set(td.id, sig)
      const old = prev.get(td.id)
      if (old && old !== sig) {
        changed.push({ id: td.id, col })
      }
    }
    prevStateMapRef.current = nextMap

    if (changed.length > 0) {
      setRecentMoves(cur => {
        const next = { ...cur }
        for (const c of changed) next[c.id] = c.col
        return next
      })
      for (const c of changed) {
        const existing = moveTimersRef.current.get(c.id)
        if (existing) clearTimeout(existing)
        const handle = setTimeout(() => {
          moveTimersRef.current.delete(c.id)
          setRecentMoves(cur => {
            if (!(c.id in cur)) return cur
            const copy = { ...cur }
            delete copy[c.id]
            return copy
          })
        }, 1700)
        moveTimersRef.current.set(c.id, handle)
      }
    }
  }, [todos])

  useEffect(() => () => {
    for (const h of moveTimersRef.current.values()) clearTimeout(h)
    moveTimersRef.current.clear()
  }, [])

  const doneCount = filtered.filter(td => mapPhaseToColumn(td) === 'done').length
  const totalRingCount = filtered.length + waitingTopics.length

  const lanes = COLUMNS.map(col => {
    let cards = sortLaneCards(filtered.filter(td => mapPhaseToColumn(td) === col.id), col.id)
    const laneWaitingTopics = col.id === 'confirm' ? waitingTopics : []
    let humanCount = cards.length
    let chiefPlusCount = 0
    if (col.id === 'confirm') {
      // Stable sort keeps the creation order inside each group.
      cards = [...cards].sort((a, b) => Number(b.gateOwner === 'human') - Number(a.gateOwner === 'human'))
      humanCount = cards.filter(td => td.gateOwner === 'human').length + laneWaitingTopics.length
      chiefPlusCount = cards.length - cards.filter(td => td.gateOwner === 'human').length
    }
    const totalInLane = cards.length + laneWaitingTopics.length
    return {
      col,
      cards,
      laneWaitingTopics,
      humanCount,
      chiefPlusCount,
      totalInLane,
      shownCount: col.id === 'confirm' ? humanCount : totalInLane,
      hasRunningInLane: col.id === 'doing' && cards.length > 0,
    }
  })
  const laneCounts = Object.fromEntries(lanes.map(l => [l.col.id, l.totalInLane]))
  const attentionCounts = { ...laneCounts, confirm: lanes.find(l => l.col.id === 'confirm')?.humanCount || 0 }

  // Empty lanes fold into a rail when four open lanes do not fit, so lanes holding cards stay on screen.
  // A lane the user folded or reopened keeps that state; a phone shows one full-width lane per page.
  const laneModes = resolveLaneModes({ laneIds: LANE_IDS, counts: laneCounts, userCollapsed: collapsedCols, boardWidth, phone: isPhone })

  const toggleCol = id => {
    setCollapsedCols(prev => ({ ...prev, [id]: laneModes[id] !== 'rail' }))
  }

  // Always stretch open columns to fill 100% of available board width (no dead right whitespace);
  // keep a 216px floor so cards never squish when the pane narrows, scrolling horizontally only when needed.
  const gridTemplate = COLUMNS.map(c => (
    laneModes[c.id] === 'rail' ? '44px' : 'minmax(216px, 1fr)'
  )).join(' ')

  // Phone: land on the lane that matters (or the one last shown) whenever the board becomes visible.
  // A hidden pane loses its scroll offset, so the position is restored from state before paint.
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!isPhone || boardWidth <= 0 || !el) return
    const id = phoneLane || pickInitialLane({ laneIds: LANE_IDS, counts: attentionCounts })
    if (id !== phoneLane) setPhoneLane(id)
    el.scrollTo({ left: Math.max(0, LANE_IDS.indexOf(id)) * el.clientWidth, behavior: 'instant' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPhone, boardWidth])

  const goToLane = id => {
    const el = gridRef.current
    setPhoneLane(id)
    if (el) el.scrollTo({ left: Math.max(0, LANE_IDS.indexOf(id)) * el.clientWidth, behavior: 'smooth' })
  }

  const handleLaneScroll = () => {
    if (!isPhone || laneScrollRafRef.current) return
    laneScrollRafRef.current = requestAnimationFrame(() => {
      laneScrollRafRef.current = 0
      const el = gridRef.current
      if (!el || el.clientWidth <= 0) return
      const id = LANE_IDS[laneIndexFromScroll(el.scrollLeft, el.clientWidth, LANE_IDS.length)]
      setPhoneLane(prev => (prev === id ? prev : id))
    })
  }

  return (
    <section className={`ot-board-pane ${boardExpanded ? 'is-expanded' : ''}`} data-testid="todos-board">
      <header className="ot-col-bar">
        <div className="ot-board-head-left">
          {boardExpanded && (
            <button
              type="button"
              className="ot-btn ot-btn--sm ot-desktop-only"
              onClick={onToggleExpand}
              title="返回对话与看板同屏 (⌘⇧↵)"
              data-testid="btn-board-back-to-chat"
            >
              <ArrowLeft size={12} />
              <span>返回对话</span>
            </button>
          )}
          <ProgressRing done={doneCount} total={totalRingCount} />
          <span className="ot-board-title">看板</span>
          <div className="ot-board-chips-scroll">
            {activeFilterChips.map(ch => (
              <button key={ch.key} type="button" className="ot-board-filter-chip" onClick={ch.onClear} title={`清除筛选：${ch.label}`}>
                {ch.hasGh && <GithubLogo size={11} />}
                <span>{ch.label}</span>
                <X size={10.5} />
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none' }}>
          <TodosFilterPopover
            open={filterOpen}
            onOpenChange={setFilterOpen}
            filters={filters}
            selectedProjectId={selectedProjectId}
            projects={projects}
            agents={agents}
            topics={topics}
            allTags={allTags}
            activeCount={activeFilterChips.length}
            onUpdateFilter={updateFilter}
            onSelectProject={onSelectProject}
            onResetAll={resetAllFilters}
          />

          <button
            type="button"
            className="ot-icon-btn"
            onClick={onOpenCreateTask}
            title="新建任务"
            aria-label="新建任务"
            data-testid="btn-board-new"
          >
            <Plus size={15} weight="regular" />
          </button>

          <button
            type="button"
            className={`ot-icon-btn ot-desktop-only ${boardExpanded ? 'is-active' : ''}`}
            onClick={onToggleExpand}
            title={boardExpanded ? '恢复同屏 (⌘⇧↵)' : '全屏看板 (⌘⇧↵)'}
            aria-label={boardExpanded ? '恢复同屏' : '全屏看板'}
            data-testid="btn-board-expand"
          >
            {boardExpanded ? <ArrowsInSimple size={15} weight="regular" /> : <ArrowsOutSimple size={15} weight="regular" />}
          </button>
        </div>
      </header>

      <HomeQuotaStrip
        providers={quotaProviders}
        refreshing={quotaRefreshing}
        onOpenQuotaHub={onOpenQuotaHub}
        onRefreshAll={onRefreshQuotas}
        className="ot-home-quota-strip--desktop"
        testId="desktop-home-quota-strip"
      />

      {/* Phone only (hidden by CSS above 780px): one lane per screen, switched here or by swiping. */}
      <div className="ot-lane-tabs" role="tablist" aria-label="看板列" data-testid="board-lane-tabs">
        {lanes.map(({ col, humanCount, shownCount, hasRunningInLane }) => (
          <button
            key={col.id}
            type="button"
            role="tab"
            aria-selected={phoneLane === col.id}
            className={`ot-lane-tab ${phoneLane === col.id ? 'is-active' : ''} ${col.id === 'confirm' && humanCount > 0 ? 'is-attention' : ''}`}
            onClick={() => goToLane(col.id)}
            data-testid={`board-lane-tab-${col.id}`}
          >
            <span className={`ot-dot ot-dot--${col.dot} ${hasRunningInLane ? 'is-pulsing' : ''}`} />
            <span className="ot-lane-tab-label">{col.label}</span>
            <span className="ot-lane-tab-count">{shownCount}</span>
          </button>
        ))}
      </div>

      <LayoutGroup id="ekko-kanban-board">
        <div
          ref={gridRef}
          className="ot-board-grid"
          style={{ gridTemplateColumns: gridTemplate }}
          onScroll={handleLaneScroll}
          data-testid="kanban-scroll-container"
        >
          {lanes.map(({ col, cards, laneWaitingTopics, humanCount, chiefPlusCount, totalInLane, hasRunningInLane }) => {
            const isCollapsed = laneModes[col.id] === 'rail'
            const EmptyIcon = col.emptyIcon

            if (isCollapsed) {
              return (
                <button
                  key={col.id}
                  type="button"
                  className="ot-lane ot-lane--collapsed"
                  onClick={() => toggleCol(col.id)}
                  title={`${col.label} · ${col.id === 'confirm' ? humanCount : totalInLane}（点击展开）`}
                  aria-label={`展开「${col.label}」列，${col.id === 'confirm' ? humanCount : totalInLane} 项`}
                  data-testid={`lane-${col.id}`}
                >
                  <span className={`ot-dot ot-dot--${col.dot} ${hasRunningInLane ? 'is-pulsing' : ''}`} />
                  <span className="ot-lane-count ot-lane-rail-count">{col.id === 'confirm' ? humanCount : totalInLane}</span>
                </button>
              )
            }

            return (
              <div
                key={col.id}
                className={`ot-lane ${col.id === 'confirm' && humanCount > 0 ? 'ot-lane--attention' : ''} ${hasRunningInLane ? 'ot-lane--active' : ''}`}
                data-testid={`lane-${col.id}`}
              >
                <button
                  type="button"
                  className="ot-lane-head"
                  onClick={() => toggleCol(col.id)}
                  title={`点击折叠「${col.label}」列`}
                >
                  <span className="ot-lane-title">
                    <span className={`ot-dot ot-dot--${col.dot} ${hasRunningInLane ? 'is-pulsing' : ''}`} />
                    <span>{col.label}</span>
                    <span
                      className={`ot-lane-count ${col.id === 'confirm' && humanCount > 0 ? 'is-amber-count' : ''}`}
                      data-testid={`lane-count-${col.id}`}
                    >
                      {col.id === 'confirm' ? humanCount : totalInLane}
                    </span>
                    {col.id === 'confirm' && chiefPlusCount > 0 && (
                      <span className="ot-lane-plus" title={`另有 ${chiefPlusCount} 个由大总管跟进中`}>
                        +{chiefPlusCount}
                      </span>
                    )}
                  </span>
                </button>

                <div className="ot-lane-body">
                  {totalInLane === 0 ? (
                    <div className="ot-lane-empty">
                      <span className="ot-lane-empty-icon">
                        <EmptyIcon size={16} weight="regular" />
                      </span>
                      <span>{activeFilterChips.length > 0 ? '无匹配任务' : '暂无任务'}</span>
                    </div>
                  ) : (
                    <>
                      {laneWaitingTopics.map(tp => {
                        const proj = projects.find(p => p.id === tp.projectId) || projects[0] || null
                        return (
                          <TopicDecisionCard
                            key={`wait-${tp.id}`}
                            topic={tp}
                            proj={proj}
                            isCurrentTopic={tp.id === activeTopicId}
                            onOpenDecision={onOpenTopicDecision}
                          />
                        )
                      })}
                      {cards.map(td => {
                        const proj = projects.find(p => p.id === td.projectId)
                        const assigned = agents.find(a => a.id === (td.phase === 'reviewing' ? td.reviewerId : td.agentId)) || null
                        return (
                          <KanbanCard
                            key={td.id}
                            td={td}
                            proj={proj}
                            assignedAgent={assigned}
                            colId={col.id}
                            isSelected={selectedTodoId === td.id}
                            justMovedCol={recentMoves[td.id] || ''}
                            liveTick={liveTick}
                            onOpenTodo={onOpenTodo}
                          />
                        )
                      })}
                    </>
                  )}
                  {col.id === 'done' && todosOmitted > 0 && (
                    <div
                      className="ot-lane-empty"
                      role="note"
                      data-testid="lane-todos-omitted"
                      title="看板数据超出宿主单次传输上限，最早的卡片未随本次刷新载入；卡片本身仍保存在库里，没有被删除"
                    >
                      <span>还有 {todosOmitted} 张卡未加载（超出快照预算）</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </LayoutGroup>
    </section>
  )
})

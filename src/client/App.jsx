import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { LazyMotion, MotionConfig, domMax } from 'motion/react'
import { List, GearSix, X, ShieldCheck, Lightning, Queue, Bell, CheckCircle, WarningCircle, MagnifyingGlass } from '@phosphor-icons/react'
import { Sidebar } from './components/Sidebar.jsx'
import { ChatPane } from './components/ChatPane.jsx'
import { KanbanBoard } from './components/KanbanBoard.jsx'
import { TodoDrawer } from './components/TodoDrawer.jsx'
import { TopicDecisionDialog } from './components/TopicDecisionDialog.jsx'
import { SettingsContent } from './components/SettingsPanel.jsx'
import { AddProjectDialog, CreateTaskDialog } from './components/Dialogs.jsx'
import { CommandPalette } from './components/CommandPalette.jsx'
import { OnboardingWizard } from './components/OnboardingWizard.jsx'
import { BrandLogo } from './components/BrandLogo.jsx'
import { ProjectWorkspace } from './components/ProjectWorkspace.jsx'
import { QuotaHub } from './components/QuotaHub.jsx'
import { SessionTraceView } from './components/SessionTraceView.jsx'
import { AgentsView } from './components/AgentsView.jsx'
import { HomeQuotaStrip } from './components/HomeQuotaStrip.jsx'
import { SchedulesView, ScheduleModal } from './components/SchedulesView.jsx'
import { ShortcutsDialog } from './components/ShortcutsDialog.jsx'
import { useConfirm } from './components/ConfirmDialog.jsx'
import { LocalFilePreview } from './components/LocalFilePreview.jsx'
import { computeStateFingerprint } from './state-fingerprint.js'
import {
  isMacPlatform, isTypingTarget, loadErrorText, quickConfirmPlan, resolveGlobalShortcut, runQuickConfirm,
} from './interaction.js'
import { busyHint, createRpcGate, runGatedRpc } from './rpc-gate.js'
import { useChiefContext } from './use-chief-context.js'
import { applyStreamEvent } from './stream-events.js'
import { STALE_WORKING_MS, WATCHDOG_TICK_MS, shouldClearStaleWorking } from './stream-watchdog.js'
import { SIDEBAR_WIDTH, SIDEBAR_RAIL_WIDTH, readSidebarMode, writeSidebarMode } from './layout.js'
import { setLocalFileRpc } from './local-files.js'
import { chiefEffortToast, createTaskWithTopic } from './trust-view.js'
import { repairScopeResult } from './topic-scope.js'
import {
  HELD_REPLY_PENDING_AFTER_MS, HELD_SYNC_SAVED_FLASH_MS, clearHeldReply, runHeldSync, createStreamDebug, holdFinalReply, hostBoundaryOf, loadHeldReply, resolveHeldReply, saveHeldReply,
} from './stream-settle.js'
import {
  addPendingSend, createClientNonce, createPendingSend, isUserMessageUpdate, markPendingFailed, prunePendingSends, refreshWaitMs,
} from './optimistic-send.js'
import {
  detectCompletionEvents,
  playNotificationChime,
  showBrowserNotification,
} from './notifications.js'

function readHostScheme() {
  const cs = getComputedStyle(document.documentElement)
  const raw = cs.getPropertyValue('--studio-color-scheme').trim()
  if (raw === 'dark' || raw === 'light') return raw
  if (document.documentElement.classList.contains('dark')) return 'dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readSavedChatWidth() {
  try {
    const n = Number(localStorage.getItem('ekko_todo_chat_width'))
    if (Number.isFinite(n) && n >= 320 && n <= 640) return n
  } catch {}
  return 396
}

const EMPTY_STREAM = Object.freeze({
  text: '',
  reasoning: '',
  status: '',
  tools: [],
  usage: null,
  startedAt: 0,
  connected: false,
  isWorking: false,
  queueLength: 0,
  loop: null,
})

const BOOT_CACHE_KEY = 'ekko_todo_boot_cache_v1'

function heldReplyStorage() {
  try { return window.localStorage } catch { return null }
}

function sidebarStorage() {
  try { return window.localStorage } catch { return null }
}

// Off unless localStorage['ekko_todo_debug_stream'] === '1'; keeps the newest 200 entries on window.__ekkoStreamLog.
const streamDebug = createStreamDebug(
  heldReplyStorage(),
  typeof window !== 'undefined' ? (window.__ekkoStreamLog = window.__ekkoStreamLog || []) : [],
  typeof console !== 'undefined' ? console : null,
)

function readBootCache() {
  try {
    const raw = localStorage.getItem(BOOT_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.settings || !Array.isArray(parsed.topics) || !Array.isArray(parsed.todos)) return null
    if (Date.now() - Number(parsed._cachedAt || 0) > 24 * 60 * 60 * 1000) return null
    return parsed
  } catch {
    return null
  }
}

function writeBootCache(snap) {
  if (!snap || !snap.settings) return
  try {
    // Store lightweight trimmed snapshot (zero secrets, bounded size < 200KB) for instant window-switch paint!
    const compact = {
      _cachedAt: Date.now(),
      settings: snap.settings,
      concurrency: snap.concurrency,
      counts: snap.counts,
      projects: (snap.projects || []).slice(0, 30),
      agents: (snap.agents || []).slice(0, 30),
      memories: (snap.memories || []).slice(0, 40),
      topics: (snap.topics || []).slice(0, 20).map(t => ({
        ...t,
        messages: (t.messages || []).slice(-30),
        queuedItems: (t.queuedItems || []).slice(0, 12),
      })),
      todos: (snap.todos || []).slice(0, 60).map(td => ({
        ...td,
        diffs: [],
        buildChat: (td.buildChat || []).slice(-4),
      })),
      schedules: (snap.schedules || []).slice(0, 50),
      quotaProviders: (snap.quotaProviders || []).slice(0, 20),
      runtime: snap.runtime,
    }
    const serialized = JSON.stringify(compact)
    if (serialized.length < 320000) {
      localStorage.setItem(BOOT_CACHE_KEY, serialized)
    }
  } catch {
    // ignore storage quota errors
  }
}

function BootSplash() {
  return (
    <div className="ot-shell ot-splash-shell" data-testid="ekko-boot-splash">
      <div className="ot-splash-card">
        <div className="ot-splash-ambient" aria-hidden="true" />
        <div className="ot-splash-logo-ring">
          <BrandLogo size={52} />
        </div>
        <h1 className="ot-splash-title">Ekko ToDo</h1>
        <p className="ot-splash-sub">和大总管说目标，Agent 在独立工作树里干活</p>
        <div className="ot-splash-pills">
          <span><ShieldCheck size={12} weight="duotone" /> 总管不直接改代码</span>
          <span><Lightning size={12} weight="duotone" /> 独立工作树</span>
          <span><Queue size={12} weight="duotone" /> 消息排队执行</span>
        </div>
        <div className="ot-splash-bar" aria-label="正在加载工作台">
          <span className="ot-splash-bar-fill" />
        </div>
      </div>
    </div>
  )
}

export function App({ ctx }) {
  // Host files (images, reports) are read through the plugin RPC so they render over LAN, tunnels and VPS proxies alike.
  // Set synchronously: children hydrate local images in layout effects, which run before this component's effects.
  setLocalFileRpc((...args) => ctx.rpc.call(...args))
  const isSettingsSlot = ctx.slot === 'settings' || ctx.view === 'settings'

  // Stale-while-revalidate instant hydration when switching back from another Studio tab!
  const [state, setState] = useState(() => readBootCache())
  const [busy, setBusy] = useState(false)
  // #100: the page-wide lock. A click during another call is no longer dropped in silence (see rpc-gate.js).
  const busyNotifyRef = useRef(null)
  busyNotifyRef.current = ctx.ui?.notify
  const rpcGateRef = useRef(null)
  if (!rpcGateRef.current) {
    rpcGateRef.current = createRpcGate({
      onBusyChange: setBusy,
      onBlocked: blocked => busyNotifyRef.current?.(busyHint(blocked), 'info'),
    })
  }
  const [askConfirm, confirmNode, confirmOpen] = useConfirm()
  const [activeView, setActiveView] = useState('workbench') // 'workbench' | 'project' | 'hub' | 'schedules' | 'trace' | 'agents'
  const [agentsFocus, setAgentsFocus] = useState({ id: '', create: 0, key: 0 })
  const [traceSessionId, setTraceSessionId] = useState('')
  const openTrace = useCallback((sid = '') => {
    setTraceSessionId(sid || '')
    setSelectedTodoId('')
    setActiveView('trace')
  }, [])
  // selectedProjectId = which repository page is open (sidebar / ⌘K). boardProjectId = the board's own project
  // filter, changed only from the board's filter menu. v0.9.13: opening a repo no longer filters the board, so a
  // topic from another repo never lands on a board with its tasks hidden.
  const [selectedProjectId, setSelectedProjectId] = useState('all')
  const [boardProjectId, setBoardProjectId] = useState('all')
  const [selectedTopicId, setSelectedTopicId] = useState('')
  // Default project for "new task / new topic / schedule": the open repo page, else the current topic's repo,
  // else the board filter. Never a repo page that was merely visited earlier.
  const contextProjectId = (() => {
    if (activeView === 'project' && selectedProjectId !== 'all') return selectedProjectId
    const tp = state?.topics?.find(t => t.id === selectedTopicId)
    if (tp?.projectId) return tp.projectId
    return boardProjectId !== 'all' ? boardProjectId : ''
  })()
  // 0.9.44: a new topic belongs to a project only when it is made from that project's page. It no longer takes
  // the first project of the list, nor the project of the topic that happens to be open.
  const newTopicProjectId = (() => {
    if (activeView !== 'project' || selectedProjectId === 'all') return ''
    return selectedProjectId
  })()
  const [selectedTodoId, setSelectedTodoId] = useState('')
  const [decisionTopicId, setDecisionTopicId] = useState('')
  const [onlyHumanAttention, setOnlyHumanAttention] = useState(false)
  // Desktop sidebar: expanded or folded into the icon rail. Remembered in localStorage only (no RPC, no settings).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarMode(sidebarStorage()) === 'rail')
  const [boardExpanded, setBoardExpanded] = useState(false)
  const [boardHidden, setBoardHidden] = useState(false)
  const [chatWidth, setChatWidth] = useState(readSavedChatWidth)
  const [isNarrow, setIsNarrow] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= 980 : false))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState('projects')
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [addProjectMode, setAddProjectMode] = useState('github')
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingAutoChecked, setOnboardingAutoChecked] = useState(false)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newTaskProjectId, setNewTaskProjectId] = useState('')
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [cmdkMode, setCmdkMode] = useState('all')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(null)
  const [schedulePreselectTodo, setSchedulePreselectTodo] = useState(null)
  const [schedulePreselectProjectId, setSchedulePreselectProjectId] = useState('')
  const [notifyPopups, setNotifyPopups] = useState([])
  const [mobilePane, setMobilePane] = useState('chat')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [composerFocusSeq, setComposerFocusSeq] = useState(0)
  const [liveStream, setLiveStream] = useState(EMPTY_STREAM)
  const [refreshingHomeQuotas, setRefreshingHomeQuotas] = useState(false)

  const fingerprintRef = useRef('')
  const prevLiveStateRef = useRef(null)
  const seenNotifyIdsRef = useRef(new Set())
  const streamBufRef = useRef({ ...EMPTY_STREAM, tools: [] })
  // The streamed answer of a turn that just ended, kept on screen until the saved message list has it.
  const [heldReply, setHeldReply] = useState(null)
  // Result of the last manual "sync now" of a held reply: { topicId, endedAt, state, reason } (#76).
  const [heldSync, setHeldSync] = useState(null)
  const heldSyncTimerRef = useRef(null)
  const heldSyncBusyRef = useRef(false)
  // 0.9.42: sends drawn in the chat before the server confirmed them (see optimistic-send.js).
  const [pendingSends, setPendingSends] = useState([])
  const pendingSeqRef = useRef(0)
  const [heldClock, setHeldClock] = useState(0)
  const topicMessagesRef = useRef([])
  // Largest host message id saved before the current turn started (null until a turn start is seen).
  const turnBoundaryRef = useRef(null)
  const rafIdRef = useRef(0)
  const swipeTouchRef = useRef(null)

  useEffect(() => { writeSidebarMode(sidebarStorage(), sidebarCollapsed ? 'rail' : 'expanded') }, [sidebarCollapsed])

  // Responsive viewport tracker so narrow desktop & mobile always expose a working sidebar drawer
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 980px)')
    if (!mq) return
    const sync = () => setIsNarrow(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])

  // Reactive theme sync with Ekko Studio host CSS variables (zero polling!)
  useEffect(() => {
    const syncScheme = () => {
      const next = readHostScheme()
      if (document.documentElement.dataset.scheme !== next) {
        document.documentElement.dataset.scheme = next
      }
    }
    syncScheme()
    const obs = new MutationObserver(syncScheme)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener?.('change', syncScheme)
    const onThemeMessage = ev => {
      if (ev?.data?.type === 'theme' || ev?.data?.type === 'studio.plugin.init') {
        requestAnimationFrame(syncScheme)
      }
    }
    window.addEventListener('message', onThemeMessage)
    return () => {
      obs.disconnect()
      mq?.removeEventListener?.('change', syncScheme)
      window.removeEventListener('message', onThemeMessage)
    }
  }, [])

  const pushNotificationPopup = useCallback(ev => {
    if (!ev) return
    const id = ev.id || `pop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setNotifyPopups(prev => [...prev.filter(x => x.id !== id), { ...ev, id, at: Date.now() }].slice(-3))
    setTimeout(() => {
      setNotifyPopups(prev => prev.filter(x => x.id !== id))
    }, 7500)
  }, [])

  const applyNextState = useCallback(next => {
    if (!next) return
    const prev = prevLiveStateRef.current
    if (prev && !isSettingsSlot) {
      const events = detectCompletionEvents(prev, next)
      const s = next.settings || {}
      for (const ev of events) {
        if (seenNotifyIdsRef.current.has(ev.id)) continue
        seenNotifyIdsRef.current.add(ev.id)
        if (seenNotifyIdsRef.current.size > 120) {
          seenNotifyIdsRef.current = new Set([...seenNotifyIdsRef.current].slice(-60))
        }
        if (s.notifySound !== false) playNotificationChime(ev.tone)
        if (s.notifyPopup !== false) pushNotificationPopup(ev)
        if (s.notifyBrowser !== false) {
          showBrowserNotification({
            title: ev.title,
            body: ev.body,
            tag: ev.id,
            onClick: () => {
              if (ev.todoId) setSelectedTodoId(ev.todoId)
              else if (ev.topicId) { setSelectedTopicId(ev.topicId); setActiveView('workbench') }
            },
          })
        }
      }
    }
    prevLiveStateRef.current = next

    const fp = computeStateFingerprint(next)
    if (fp !== fingerprintRef.current) {
      fingerprintRef.current = fp
      setState(next)
      writeBootCache(next)
    }
    setSelectedTopicId(prevId => {
      if (prevId && next.topics.some(t => t.id === prevId)) return prevId
      const firstLive = next.topics.find(t => !t.archived) || next.topics[0]
      return firstLive?.id || ''
    })
  }, [isSettingsSlot, pushNotificationPopup])

  // Coalesce refreshes: a running build emits board.updated many times per second; one get-state in flight plus
  // at most one queued, spaced ≥ 800 ms, keeps tunnels/VPS proxies below their rate limits (nginx limit_req → 429).
  const loadGate = useRef({ inflight: false, queued: false, last: 0 })
  // Bumped when a write starts and when it finishes. A background read (get-state / sync) that started before
  // a write landed carries an older value; applying it after the write's own snapshot reverted the change on
  // screen (AUTO switch "bounced back"). Such reads are dropped and re-run.
  const stateEpochRef = useRef(0)
  // 0.9.42: `urgent` (the user's own message was stored, queued or refused) skips the 800 ms wait. The
  // window only spaces out the refreshes caused by build output and activity ticks.
  const loadState = useCallback(async ({ urgent = false } = {}) => {
    const gate = loadGate.current
    if (gate.inflight) { gate.queued = true; if (urgent) gate.urgent = true; return }
    gate.inflight = true
    try {
      const wait = urgent ? refreshWaitMs({ urgent }) : gate.last + 800 - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      gate.last = Date.now()
      const epoch = stateEpochRef.current
      const next = await ctx.rpc.call('get-state')
      if (epoch !== stateEpochRef.current) gate.queued = true
      else applyNextState(next)
    } catch {
      // swallow transient reconnect poll errors
    } finally {
      gate.inflight = false
      if (gate.queued) {
        const nextUrgent = Boolean(gate.urgent)
        gate.queued = false
        gate.urgent = false
        void loadState({ urgent: nextUrgent })
      }
    }
  }, [ctx, applyNextState])

  // Full Todos Keyboard Shortcuts: ⌘K, ⌘P, ⌘J, ⌘N, ⌘[, ⌘B, ⌥↑/⌥↓, ⌘⌥B, ⌘⇧↵, N, ⌘⌥S, ⌘⌥↵, ⌘,, ⌘/, Esc
  // #100: which shortcut a key stands for (platform modifier, typing gate) is decided in interaction.js.
  useEffect(() => {
    if (isSettingsSlot) return
    const mac = isMacPlatform()
    const notify = (msg, level) => ctx.ui?.notify?.(msg, level)
    const onKeyDown = e => {
      const hit = resolveGlobalShortcut(e, {
        mac,
        typing: isTypingTarget(e.target),
        cmdkOpen,
        cmdkMode,
        overlayOpen: settingsOpen || cmdkOpen || shortcutsOpen || scheduleModalOpen || newTaskOpen || addProjectOpen || confirmOpen,
        decisionOpen: Boolean(decisionTopicId),
        selectedTodoId,
        selectedTopicId,
        activeView,
        topics: state?.topics,
        todos: state?.todos,
      })
      if (!hit) return
      e.preventDefault()
      if (hit.id === 'palette') {
        if (hit.close) setCmdkOpen(false)
        else { setCmdkMode(hit.mode); setCmdkOpen(true) }
      } else if (hit.id === 'new-task') {
        setNewTaskProjectId(contextProjectId)
        setNewTaskOpen(true)
      } else if (hit.id === 'back') {
        if (selectedTodoId) setSelectedTodoId('')
        else if (activeView !== 'workbench') setActiveView('workbench')
      } else if (hit.id === 'settings') {
        setSettingsOpen(v => !v)
      } else if (hit.id === 'shortcuts') {
        setShortcutsOpen(v => !v)
      } else if (hit.id === 'toggle-board') {
        setActiveView('workbench')
        setBoardExpanded(false)
        setBoardHidden(v => !v)
      } else if (hit.id === 'toggle-sidebar') {
        if (isNarrow) setMobileNavOpen(v => !v)
        else setSidebarCollapsed(v => !v)
      } else if (hit.id === 'expand-board') {
        setActiveView('workbench')
        setBoardHidden(false)
        setBoardExpanded(v => !v)
      } else if (hit.id === 'switch-topic') {
        setActiveView('workbench')
        setSelectedTopicId(hit.topicId)
      } else if (hit.id === 'refresh-diff') {
        void ctx.rpc.call('todo-action', { todoId: hit.todoId, action: 'refresh_diff' })
          .then(next => { applyNextState(next); notify('已刷新任务快照 Diff', 'success') })
          .catch(err => notify(`${loadErrorText(err, '刷新 Diff 失败')}（可再按 ⌘⌥S 重试）`, 'error'))
      } else if (hit.id === 'quick-confirm') {
        const td = state?.todos?.find(t => t.id === hit.todoId)
        const plan = quickConfirmPlan(td, state?.projects?.find(p => p.id === td?.projectId))
        runQuickConfirm({
          plan,
          ask: askConfirm,
          call: async () => {
            const next = await ctx.rpc.call('todo-action', { todoId: hit.todoId, action: plan.action })
            applyNextState(next)
            notify(plan.success, 'success')
            return next
          },
          onError: err => notify(loadErrorText(err, `${plan.label}失败`), 'error'),
        })
      } else if (hit.id === 'escape-home') {
        setActiveView('workbench')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    isSettingsSlot, isNarrow, state?.topics, state?.todos, state?.projects, selectedTopicId, selectedTodoId,
    selectedProjectId, contextProjectId, activeView, cmdkOpen, cmdkMode, settingsOpen, shortcutsOpen,
    scheduleModalOpen, newTaskOpen, addProjectOpen, decisionTopicId, confirmOpen, askConfirm, ctx, applyNextState,
  ])

  const hasActiveRuntime = useMemo(() => {
    if (!state) return false
    return Boolean(liveStream.isWorking)
      || state.topics.some(t => t.isRunning || t.launching)
      || state.todos.some(td => td.phase === 'building' || td.phase === 'reviewing' || td.phase === 'merging')
  }, [state, liveStream.isWorking])

  const activeTopic = state?.topics?.find(t => t.id === selectedTopicId)
    || state?.topics?.find(t => !t.archived)
    || state?.topics?.[0]
    || null

  // v0.9.43: Chief context capsule, manual /compress and slash commands (fed by the live subscription below).
  const chiefContext = useChiefContext({
    ctx,
    topic: activeTopic,
    applyNextState,
    running: Boolean(activeTopic?.isRunning || activeTopic?.launching || liveStream.isWorking),
  })
  const chiefContextEventRef = useRef(null)
  chiefContextEventRef.current = chiefContext

  // Resolves to { applied, next, error } and never throws: background callers ignore it (a failed poll is
  // retried by the next one); the held-reply "sync now" button judges it (#76).
  const syncActiveTopic = useCallback(async (tid = '') => {
    const target = tid || activeTopic?.id || ''
    if (!target) return { applied: false, next: null, error: null }
    try {
      const epoch = stateEpochRef.current
      const next = await ctx.rpc.call('sync-topic-session', { topicId: target })
      if (epoch === stateEpochRef.current) applyNextState(next)
      // Not applied = a write landed meanwhile; the caller still gets the snapshot to judge.
      return { applied: epoch === stateEpochRef.current, next, error: null }
    } catch (error) {
      // ignore transient reconnect sync errors
      return { applied: false, next: null, error }
    }
  }, [ctx, activeTopic?.id, applyNextState])

  useEffect(() => {
    void loadState()
    const offMsg = ctx.messages?.on?.('board.updated', ev => {
      const reason = ev?.data?.reason ?? ev?.payload?.reason ?? ev?.reason
      void loadState({ urgent: isUserMessageUpdate(reason) })
    })
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void loadState()
        if (activeTopic?.id) void syncActiveTopic(activeTopic.id)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      try { offMsg?.() } catch {}
    }
  }, [ctx, loadState, syncActiveTopic, activeTopic?.id])

  useEffect(() => {
    const intervalMs = hasActiveRuntime ? 3000 : 12000
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadState()
    }, intervalMs)
    return () => clearInterval(timer)
  }, [hasActiveRuntime, loadState])

  // Sync live host session messages & working state whenever user switches topic
  useEffect(() => {
    if (activeTopic?.id && activeTopic?.chiefSessionId) {
      void syncActiveTopic(activeTopic.id)
    }
  }, [activeTopic?.id, activeTopic?.chiefSessionId, syncActiveTopic])

  // RAF-batched real-time stream subscription for active Chief session (including external Web-UI runs!)
  useEffect(() => {
    const sid = activeTopic?.chiefSessionId
    const tid = activeTopic?.id || ''
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
    streamBufRef.current = { ...EMPTY_STREAM, tools: [] }
    setLiveStream(EMPTY_STREAM)
    // A reply still waiting to be saved when the page was reloaded or the topic was left comes back here.
    setHeldReply(tid ? loadHeldReply(heldReplyStorage(), tid) : null)
    turnBoundaryRef.current = null
    if (!sid || !ctx.host?.sessions?.connect) return

    let closed = false
    let handle = null

    const scheduleFlush = () => {
      if (rafIdRef.current || closed) return
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = 0
        if (closed) return
        const cur = streamBufRef.current
        setLiveStream({
          text: cur.text,
          reasoning: cur.reasoning,
          status: cur.status || '',
          tools: [...cur.tools],
          usage: cur.usage ? { ...cur.usage } : null,
          startedAt: cur.startedAt,
          connected: cur.connected,
          isWorking: cur.isWorking,
          queueLength: cur.queueLength,
          loop: cur.loop || null,
        })
      })
    }

    Promise.resolve(ctx.host.sessions.connect(sid, evt => {
      if (closed || !evt) return
      // v0.9.43: command answers, compression events and context tokens (see use-chief-context.js).
      try { chiefContextEventRef.current?.onSessionEvent(evt) } catch {}
      const buf = streamBufRef.current
      const type = String(evt.event || '')
      // 0.9.56: any host event proves the subscription is alive (see stream-watchdog.js).
      buf.lastEventAt = Date.now()

      if (type === 'transport.connected') {
        buf.connected = true
        scheduleFlush()
      } else if (type === 'transport.disconnected' || type === 'transport.closed') {
        buf.connected = false
        scheduleFlush()
      } else if (type === 'run.started' || type === 'run.queued') {
        buf.text = ''
        buf.reply = null
        buf.reasoning = ''
        buf.status = ''
        buf.tools = []
        buf.usage = null
        buf.loopTracker = null
        buf.loop = null
        buf.startedAt = Number(evt.runStartedAt || 0) || Date.now()
        buf.isWorking = true
        turnBoundaryRef.current = hostBoundaryOf(topicMessagesRef.current)
        scheduleFlush()
      } else if (type === 'resumed' || type === 'app.resumed') {
        buf.connected = true
        buf.isWorking = Boolean(evt.isWorking)
        buf.queueLength = Number(evt.queueLength || 0)
        if (evt.runStartedAt) buf.startedAt = Number(evt.runStartedAt)
        else if (buf.isWorking && !buf.startedAt) buf.startedAt = Date.now()
        if (buf.isWorking && turnBoundaryRef.current == null) turnBoundaryRef.current = hostBoundaryOf(topicMessagesRef.current)
        if (evt.inputTokens || evt.outputTokens) {
          buf.usage = {
            inputTokens: Number(evt.inputTokens || 0),
            outputTokens: Number(evt.outputTokens || 0),
          }
        }
        if (buf.isWorking && Array.isArray(evt.events) && evt.events.length) {
          buf.text = ''
          buf.reply = null
          buf.reasoning = ''
          buf.status = ''
          buf.tools = []
          buf.loopTracker = null
          buf.loop = null
          for (const histEvt of evt.events) {
            applyStreamEvent(buf, histEvt)
          }
        } else {
          if (typeof evt.output === 'string' && evt.output && !buf.text) buf.text = evt.output
          if (typeof evt.reasoning === 'string' && evt.reasoning && !buf.reasoning) buf.reasoning = evt.reasoning
        }
        scheduleFlush()
        if (tid) void syncActiveTopic(tid)
      } else if (type === 'message.created' || type === 'peer.user.message') {
        if (tid) void syncActiveTopic(tid)
      } else if (type === 'run.completed' || type === 'run.failed' || type === 'abort.completed' || type === 'abort') {
        // Do not drop the streamed answer here: the saved list may not have it yet. Keep the unsaved part
        // as a held reply (same render pass as the stream reset, so nothing flashes away).
        const held = holdFinalReply({ topicId: tid, streamText: buf.text, startedAt: buf.startedAt, hostBoundary: turnBoundaryRef.current, messages: topicMessagesRef.current })
        streamDebug.record('turn.end', { type, topicId: tid, streamChars: buf.text.length, savedAlready: !held, heldChars: held ? held.text.length : 0, hostBoundary: turnBoundaryRef.current })
        turnBoundaryRef.current = null
        if (held) {
          saveHeldReply(heldReplyStorage(), held)
          setHeldReply(held)
        }
        streamBufRef.current = { ...EMPTY_STREAM, tools: [], connected: buf.connected, isWorking: false }
        setLiveStream({ ...EMPTY_STREAM, connected: buf.connected, isWorking: false })
        if (tid) void syncActiveTopic(tid)
        else void loadState()
      } else if (applyStreamEvent(buf, evt)) {
        scheduleFlush()
      }
    })).then(h => {
      if (closed) { h?.close?.() } else {
        handle = h
        chiefContextEventRef.current?.attach(sid, h)
      }
    }).catch(() => {})

    return () => {
      closed = true
      chiefContextEventRef.current?.detach(sid)
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
      try { handle?.close?.() } catch {}
    }
  }, [activeTopic?.chiefSessionId, activeTopic?.id, ctx.host, loadState, syncActiveTopic])

  topicMessagesRef.current = activeTopic?.messages || []
  const activeTopicRef = useRef(null)
  activeTopicRef.current = activeTopic

  // 0.9.56: end a "working" display the host will never end itself. Same hand-off as run.completed: an
  // answer that was streamed but is not saved yet is kept as a held reply, then the stream is reset.
  const clearLiveWorking = useCallback(() => {
    const buf = streamBufRef.current
    if (!buf.isWorking) return
    const tid = activeTopicRef.current?.id || ''
    const held = buf.text
      ? holdFinalReply({ topicId: tid, streamText: buf.text, startedAt: buf.startedAt, hostBoundary: turnBoundaryRef.current, messages: topicMessagesRef.current })
      : null
    streamDebug.record('turn.end', { type: 'stale-working', topicId: tid, streamChars: buf.text.length, heldChars: held ? held.text.length : 0 })
    turnBoundaryRef.current = null
    if (held) {
      saveHeldReply(heldReplyStorage(), held)
      setHeldReply(held)
    }
    streamBufRef.current = { ...EMPTY_STREAM, tools: [], connected: buf.connected, isWorking: false }
    setLiveStream({ ...EMPTY_STREAM, connected: buf.connected, isWorking: false })
  }, [])

  useEffect(() => {
    if (!liveStream.isWorking) return undefined
    let checking = false
    const timer = setInterval(async () => {
      if (checking || document.visibilityState !== 'visible') return
      const topic = activeTopicRef.current
      const probe = () => shouldClearStaleWorking({
        isWorking: streamBufRef.current.isWorking,
        topicRunning: Boolean(activeTopicRef.current?.isRunning),
        topicLaunching: Boolean(activeTopicRef.current?.launching),
        lastEventAt: streamBufRef.current.lastEventAt || streamBufRef.current.startedAt,
        now: Date.now(),
        graceMs: STALE_WORKING_MS,
      })
      if (!topic?.id || !probe()) return
      checking = true
      try {
        // Ask the host once more (sync-topic-session probes it and corrects the board), then decide.
        await syncActiveTopic(topic.id)
        if (probe()) clearLiveWorking()
      } finally {
        checking = false
      }
    }, WATCHDOG_TICK_MS)
    return () => clearInterval(timer)
  }, [liveStream.isWorking, syncActiveTopic, clearLiveWorking])

  const heldView = useMemo(
    () => resolveHeldReply(heldReply && heldReply.topicId === activeTopic?.id ? heldReply : null, activeTopic?.messages, Math.max(heldClock, Date.now())),
    [heldReply, activeTopic?.id, activeTopic?.messages, heldClock],
  )

  // Remove the held copy only once the saved list has the reply.
  useEffect(() => {
    if (!heldReply || heldReply.topicId !== activeTopic?.id || heldView.status !== 'saved') return
    streamDebug.record('held.cleared', { topicId: heldReply.topicId, savedHit: true, waitedMs: Date.now() - heldReply.endedAt })
    clearHeldReply(heldReplyStorage(), heldReply.topicId)
    setHeldReply(null)
    // After a manual sync, show "已同步" for a moment so the click has a visible result.
    setHeldSync(prev => (prev && prev.topicId === heldReply.topicId ? { ...prev, state: 'saved', reason: '' } : prev))
  }, [heldReply, heldView.status, activeTopic?.id])

  useEffect(() => {
    if (heldSync?.state !== 'saved') return
    clearTimeout(heldSyncTimerRef.current)
    heldSyncTimerRef.current = setTimeout(() => setHeldSync(prev => (prev?.state === 'saved' ? null : prev)), HELD_SYNC_SAVED_FLASH_MS)
    return () => clearTimeout(heldSyncTimerRef.current)
  }, [heldSync])

  // While a reply is held: ask the server again twice, then mark it as waiting (retry button) at 8s.
  useEffect(() => {
    if (!heldReply) return
    const tid = heldReply.topicId
    const waited = Date.now() - heldReply.endedAt
    const timers = [2500, 6000].filter(ms => ms > waited).map(ms => setTimeout(() => { void syncActiveTopic(tid) }, ms - waited))
    timers.push(setTimeout(() => {
      streamDebug.record('held.pending', { topicId: tid, savedHit: false, waitedMs: Date.now() - heldReply.endedAt })
      setHeldClock(Date.now())
    }, Math.max(0, HELD_REPLY_PENDING_AFTER_MS - waited)))
    return () => timers.forEach(clearTimeout)
  }, [heldReply, syncActiveTopic])

  const retryHeldSync = useCallback(async () => {
    if (!heldReply || heldSyncBusyRef.current) return
    const sync = () => syncActiveTopic(heldReply.topicId)
    const held = heldReply
    heldSyncBusyRef.current = true
    streamDebug.record('held.retry', { topicId: held.topicId })
    const mark = s => setHeldSync({ topicId: held.topicId, endedAt: held.endedAt, state: s.state, reason: s.reason || '' })
    try {
      const outcome = await runHeldSync({ held, before: topicMessagesRef.current, sync, onState: mark })
      streamDebug.record('held.retry.result', { topicId: held.topicId, state: outcome.state, reason: outcome.reason })
      // The snapshot was dropped (another write landed meanwhile): fetch a fresh one.
      if (/快照已过期/.test(outcome.reason)) void loadState()
    } finally {
      heldSyncBusyRef.current = false
    }
  }, [heldReply, syncActiveTopic, loadState])

  // `free`: the call does not take the page-wide busy lock (0.9.65 send: the server now waits for the whole
  // delivery, so holding the lock would freeze every button for those seconds).
  const callRpc = useCallback(async (name, input, toastMsg, { onError, free = false } = {}) => {
    const exec = async () => {
      stateEpochRef.current += 1
      try {
        const next = await ctx.rpc.call(name, input)
        stateEpochRef.current += 1
        if (next && typeof next === 'object' && Array.isArray(next.projects)) applyNextState(next)
        if (toastMsg) ctx.ui?.notify?.(toastMsg, 'success')
        return next
      } catch (err) {
        ctx.ui?.notify?.(err?.message || String(err), 'error')
        try { onError?.(err) } catch {}
        return null
      }
    }
    return runGatedRpc(rpcGateRef.current, { name, input, free }, exec)
  }, [ctx, applyNextState])

  // Todo #98: one search for the palette, the board filter, the project workspace and memory search.
  const searchWorkspace = useCallback(input => ctx.rpc.call('search-workspace', input), [ctx])

  const callQuickRpc = useCallback(async (name, input, toastMsg) => {
    stateEpochRef.current += 1
    try {
      const next = await ctx.rpc.call(name, input)
      stateEpochRef.current += 1
      if (next && typeof next === 'object' && Array.isArray(next.projects)) applyNextState(next)
      if (toastMsg) ctx.ui?.notify?.(toastMsg, 'success')
      return next
    } catch (err) {
      ctx.ui?.notify?.(err?.message || String(err), 'error')
      return null
    }
  }, [ctx, applyNextState])

  // Todo #127: the notice at the top of a topic. The answer is a repair report, not a snapshot, so the state
  // is read again; a refusal is thrown so the confirm dialog shows the server's reason and stays open.
  const repairTopicTodos = useCallback(async topicId => {
    let refused = null
    const result = await callRpc('repair-topic-todos', { topicId }, undefined, { onError: err => { refused = err } })
    if (refused) throw refused
    if (!result) return null
    ctx.ui?.notify?.(repairScopeResult(result), 'success')
    void loadState({ urgent: true })
    return result
  }, [ctx, callRpc, loadState])

  const fetchModelCatalog = useCallback((engine, refresh = false) => ctx.rpc.call('get-model-catalog', { engine, refresh }), [ctx])
  const fetchHostMemory = useCallback(() => ctx.rpc.call('get-host-memory'), [ctx])
  const listGithubRepos = useCallback(opts => ctx.rpc.call('list-github-repos', opts || {}), [ctx])
  const refreshGithubAuth = useCallback(opts => ctx.rpc.call('github-auth-status', opts || { refresh: true }), [ctx])
  const startGithubDevice = useCallback(() => ctx.rpc.call('github-auth-start-device'), [ctx])
  const saveGithubToken = useCallback(async input => {
    const res = await ctx.rpc.call('github-auth-save-token', input)
    if (res?.authenticated) {
      ctx.ui?.notify?.(`已连接 GitHub：@${res.username}`, 'success')
      void loadState()
    }
    return res
  }, [ctx, loadState])
  const logoutGithub = useCallback(async opts => {
    const res = await ctx.rpc.call('github-auth-logout', opts || {})
    ctx.ui?.notify?.('已断开 GitHub 授权连接', 'success')
    void loadState()
    return res
  }, [ctx, loadState])
  const syncSessionIsolation = useCallback(async () => {
    try {
      const res = await ctx.rpc.call('sync-session-isolation')
      if (res?.state) applyNextState(res.state)
      const count = Number(res?.sessionCount || 0)
      const msg = res?.queued
        ? `已开始后台整理 ${count} 个会话`
        : count === 0
          ? '当前暂无需要整理的历史会话'
          : `已整理 ${res.updatedCount || count} 个会话`
      ctx.ui?.notify?.(msg, 'success')
      return res
    } catch (err) {
      ctx.ui?.notify?.(err?.message || String(err), 'error')
      return null
    }
  }, [ctx, applyNextState])

  const handleRefreshHomeQuotas = useCallback(async () => {
    if (refreshingHomeQuotas) return
    setRefreshingHomeQuotas(true)
    try {
      await callQuickRpc('refresh-all-quotas', { onlyEnabled: true })
    } finally {
      setRefreshingHomeQuotas(false)
    }
  }, [refreshingHomeQuotas, callQuickRpc])

  const uploadChatFile = useCallback(input => ctx.rpc.call('upload-chat-file', input), [ctx])
  const inspectRepo = useCallback(repoPath => ctx.rpc.call('inspect-repo', { repoPath }), [ctx])

  // Auto-open First-Run Onboarding Wizard ONLY for brand-new empty workspaces
  useEffect(() => {
    if (isSettingsSlot || !state || onboardingAutoChecked) return
    setOnboardingAutoChecked(true)
    if (state.runtime?.needsOnboarding) {
      setOnboardingOpen(true)
    }
  }, [isSettingsSlot, state, onboardingAutoChecked])

  // Mobile horizontal swipe gesture: swipe left in Chat -> Board; swipe right at left edge of Board -> Chat
  const handleTouchStart = e => {
    if (typeof window === 'undefined' || window.innerWidth > 780) return
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    const scrollContainer = e.target?.closest?.('[data-testid="kanban-scroll-container"]')
    swipeTouchRef.current = {
      x: t.clientX,
      y: t.clientY,
      t: Date.now(),
      boardScrollLeft: scrollContainer ? scrollContainer.scrollLeft : 0,
      inBoardScroll: Boolean(scrollContainer),
    }
  }

  const handleTouchEnd = e => {
    const start = swipeTouchRef.current
    swipeTouchRef.current = null
    if (!start || !e.changedTouches?.length) return
    const end = e.changedTouches[0]
    const dx = end.clientX - start.x
    const dy = end.clientY - start.y
    const dt = Date.now() - start.t
    if (dt > 700 || Math.abs(dx) < 62 || Math.abs(dx) < Math.abs(dy) * 1.45) return

    if (mobilePane === 'chat' && dx < -62) {
      setMobilePane('board')
    } else if (mobilePane === 'board' && dx > 62) {
      // Avoid hijacking horizontal scroll inside Kanban columns unless at the leftmost edge or header
      if (!start.inBoardScroll || start.boardScrollLeft <= 6) {
        setMobilePane('chat')
      }
    }
  }

  const openAddProject = useCallback((mode = 'github') => {
    setAddProjectMode(mode)
    setAddProjectOpen(true)
  }, [])

  const openAgents = useCallback((agentId = '', create = false) => {
    setSettingsOpen(false)
    setSelectedTodoId('')
    setMobileNavOpen(false)
    setAgentsFocus(prev => ({ id: agentId || '', create: create ? 1 : 0, key: prev.key + 1 }))
    setActiveView('agents')
  }, [])

  const openSettingsWithTab = useCallback((tabName = 'projects') => {
    if (tabName === 'agents' && !isSettingsSlot) { openAgents(); return }
    setSettingsTab(tabName)
    setSettingsOpen(true)
  }, [isSettingsSlot, openAgents])

  // Zero-modal instant New Topic (Todos style: title is auto-generated by model on first message!)
  const handleInstantNewTopic = useCallback(async () => {
    setActiveView('workbench')
    setMobileNavOpen(false)
    setMobilePane('chat')
    setBoardExpanded(false)
    const next = await callQuickRpc('create-topic', { projectId: newTopicProjectId, autopilot: true })
    if (next?.topics?.length) {
      const newest = [...next.topics].sort((a, b) => b.createdAt - a.createdAt)[0]
      if (newest) setSelectedTopicId(newest.id)
    }
    setComposerFocusSeq(n => n + 1)
  }, [newTopicProjectId, callQuickRpc])

  const openScheduleModal = useCallback(({ schedule = null, todo = null, projectId = '' } = {}) => {
    setEditingSchedule(schedule)
    setSchedulePreselectTodo(todo)
    setSchedulePreselectProjectId(projectId || todo?.projectId || contextProjectId)
    setScheduleModalOpen(true)
  }, [contextProjectId])

  const openNewTaskForProject = useCallback((projectId = '') => {
    setNewTaskProjectId(projectId || contextProjectId)
    setNewTaskOpen(true)
  }, [contextProjectId])

  // Resizable vertical divider drag handler between Chief Chat and Kanban Board
  const startSplitResize = e => {
    e.preventDefault()
    const startX = e.clientX
    const startW = chatWidth
    const onMove = ev => {
      const next = Math.max(320, Math.min(640, startW + (ev.clientX - startX)))
      setChatWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      try { localStorage.setItem('ekko_todo_chat_width', String(chatWidth)) } catch {}
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  useEffect(() => {
    try { localStorage.setItem('ekko_todo_chat_width', String(chatWidth)) } catch {}
  }, [chatWidth])

  // A send the server now holds (as a message or a queued follow-up) leaves the unconfirmed list.
  useEffect(() => {
    setPendingSends(prev => {
      const next = prunePendingSends(prev, state?.topics)
      if (next !== prev) {
        const kept = new Set(next.map(p => p.nonce))
        for (const p of prev) if (!kept.has(p.nonce)) streamDebug.record('send.settled', { topicId: p.topicId, nonce: p.nonce, afterMs: Date.now() - p.createdAt })
      }
      return next
    })
  }, [state?.topics])

  // 0.9.42: the send call can answer while the Chief is still being started (`topic.launching`). If that
  // launch then ends without a run, the "running" state drawn at send time is taken back here; the reason is
  // on the message.
  const launchWatchRef = useRef({ id: '', launching: false })
  useEffect(() => {
    const prev = launchWatchRef.current
    const now = { id: activeTopic?.id || '', launching: Boolean(activeTopic?.launching) }
    launchWatchRef.current = now
    if (prev.id === now.id && prev.launching && !now.launching && !activeTopic?.isRunning) {
      streamBufRef.current = { ...EMPTY_STREAM, tools: [], connected: streamBufRef.current.connected }
      setLiveStream({ ...EMPTY_STREAM, connected: streamBufRef.current.connected })
    }
  }, [activeTopic?.id, activeTopic?.launching, activeTopic?.isRunning])

  if (!state) {
    return <BootSplash />
  }

  const handleSendTopicMessage = async payload => {
    const req = typeof payload === 'string'
      ? { text: payload, attachments: [], mentionedAgentIds: [], interrupt: false }
      : (payload || { text: '', attachments: [], mentionedAgentIds: [], interrupt: false })
    let targetTopicId = activeTopic?.id || ''
    if (!targetTopicId) {
      const created = await callQuickRpc('create-topic', {
        projectId: newTopicProjectId,
        autopilot: true,
      })
      const newest = created?.topics?.length ? [...created.topics].sort((a, b) => b.createdAt - a.createdAt)[0] : null
      targetTopicId = newest?.id || ''
      if (targetTopicId) setSelectedTopicId(targetTopicId)
    }
    if (!targetTopicId) return { ok: false, topicId: '' }
    const targetTopic = state.topics.find(t => t.id === targetTopicId)
    const alreadyRunning = Boolean(targetTopic?.isRunning || (targetTopicId === activeTopic?.id && liveStream.isWorking))
    if (!alreadyRunning || req.interrupt) {
      streamBufRef.current = { ...EMPTY_STREAM, tools: [], startedAt: Date.now(), lastEventAt: Date.now(), connected: streamBufRef.current.connected, isWorking: true }
      setLiveStream({ ...EMPTY_STREAM, startedAt: Date.now(), connected: streamBufRef.current.connected, isWorking: true })
    }
    // Drawn in the chat now, in the same render as the cleared composer; the server answer replaces it
    // by nonce. 0.9.65: the send does not take the busy lock (free call), so every press is drawn and sent.
    const nonce = createClientNonce()
    if (nonce) {
      pendingSeqRef.current += 1
      const entry = createPendingSend({ nonce, topicId: targetTopicId, text: req.text || '', attachments: req.attachments || [], seq: pendingSeqRef.current })
      streamDebug.record('send.drawn', { topicId: targetTopicId, nonce })
      setPendingSends(prev => addPendingSend(prev, entry))
    }
    const sent = await callRpc(
      'send-topic-message',
      {
        topicId: targetTopicId,
        text: req.text || '',
        ...(req.attachments?.length ? { attachments: req.attachments } : {}),
        ...(req.mentionedAgentIds?.length ? { mentionedAgentIds: req.mentionedAgentIds } : {}),
        ...(req.interrupt ? { interrupt: true } : {}),
        ...(nonce ? { clientNonce: nonce } : {}),
      },
      alreadyRunning && !req.interrupt ? '大总管运行中，已加入排队队列（本轮结束后自动执行）' : '',
      {
        free: true,
        onError: err => {
          // Keep the bubble with the reason on it. If the server did store the message, the refresh below
          // brings the stored copy (with its own reason) and this one is dropped by nonce.
          if (nonce) setPendingSends(prev => markPendingFailed(prev, nonce, err?.message || String(err)))
          void loadState({ urgent: true })
        },
      },
    )
    // The Chief never started (callRpc already showed why): take back the optimistic "running" state set
    // above, otherwise the spinner keeps running next to the failure banner. An interrupted run is left
    // alone because the previous run may still be alive.
    if (sent === null && !alreadyRunning) {
      streamBufRef.current = { ...EMPTY_STREAM, tools: [], connected: streamBufRef.current.connected }
      setLiveStream({ ...EMPTY_STREAM, connected: streamBufRef.current.connected })
    }
    // v0.9.27: tell the composer whether the message went through, so it clears or keeps the topic draft.
    return { ok: sent !== null, topicId: targetTopicId }
  }

  const handleAskChiefCreateAgent = async requirementText => {
    setSettingsOpen(false)
    setActiveView('workbench')
    setBoardExpanded(false)
    setMobilePane('chat')
    const created = await callQuickRpc('create-topic', {
      projectId: newTopicProjectId,
      autopilot: true,
    })
    const newest = created?.topics?.length ? [...created.topics].sort((a, b) => b.createdAt - a.createdAt)[0] : null
    const targetTopicId = newest?.id || activeTopic?.id || ''
    if (!targetTopicId) return
    setSelectedTopicId(targetTopicId)
    const prompt = requirementText
      ? `请帮我创建一个新的专属 Agent 并通过 configure_agent 立即配置生效：\n需求描述：${requirementText}\n请为它起清晰的名称、自定义职责定位（role_label）、合适的内置头像预设、系统提示词与适配的模型配置，创建完成后向我汇报详细配置。`
      : '请帮我创建一个新的自定义 Agent。先简短问我 2–3 个问题确认它的业务领域（比如软件开发、新媒体运营、内容写作、数据分析等）、职责边界和期望风格，然后帮我直接通过 configure_agent 创建并配置好。'
    streamBufRef.current = { ...EMPTY_STREAM, tools: [], startedAt: Date.now(), connected: streamBufRef.current.connected }
    setLiveStream({ ...EMPTY_STREAM, startedAt: Date.now(), connected: streamBufRef.current.connected })
    await callRpc('send-topic-message', { topicId: targetTopicId, text: prompt })
  }

  const settingsProps = {
    ctx,
    state,
    busy,
    initialTab: settingsTab,
    onAddProject: openAddProject,
    onUpdateProject: (id, patch) => callRpc('update-project', { id, ...patch }, '项目配置已更新'),
    onDeleteProject: id => callRpc('delete-project', { id }, '已移除项目'),
    onSaveAgent: input => callRpc('save-agent', input, 'Agent 配置已保存'),
    onDeleteAgent: id => callRpc('delete-agent', { id }, 'Agent 已删除'),
    onClearAgentCooldowns: id => callQuickRpc('clear-agent-cooldowns', { id }, '已清除故障冷却记录'),
    onSaveSettings: input => callQuickRpc('save-settings', input, '设置已保存'),
    onQuickConfigureChief: input => callQuickRpc('quick-configure-chief', input, '总管配置已更新'),
    onSaveMemory: input => callQuickRpc('save-memory', input, '记忆已保存'),
    onDeleteMemory: id => callRpc('delete-memory', { id }, '记忆已删除'),
    onFetchModelCatalog: fetchModelCatalog,
    onFetchHostMemory: fetchHostMemory,
    onRefreshGithubAuth: refreshGithubAuth,
    onStartGithubDevice: startGithubDevice,
    onSaveGithubToken: saveGithubToken,
    onLogoutGithub: logoutGithub,
    onOpenOnboarding: isSettingsSlot ? undefined : () => { setSettingsOpen(false); setOnboardingOpen(true) },
    onAskChiefCreateAgent: isSettingsSlot ? undefined : handleAskChiefCreateAgent,
    onOpenAgents: isSettingsSlot ? undefined : () => openAgents(),
    onSyncSessionIsolation: syncSessionIsolation,
    onTestNotification: () => {
      pushNotificationPopup({
        id: `test-${Date.now()}`,
        tone: 'success',
        title: '完成通知测试成功',
        body: '任务完成、进入待你处理关口或执行失败时将以弹窗 + 提示音提醒你。',
      })
      showBrowserNotification({
        title: 'Ekko ToDo 通知测试',
        body: '桌面弹窗与提示音均已就绪。',
      })
    },
    onOpenShortcuts: isSettingsSlot ? undefined : () => { setSettingsOpen(false); setShortcutsOpen(true) },
  }

  if (isSettingsSlot) {
    return (
      <MotionConfig reducedMotion="user">
        <LazyMotion features={domMax}>
          <Tooltip.Provider delayDuration={300}>
            <div className="ot-shell" data-testid="ekko-todo-settings-page">
              <div className="ot-settings-page">
                <div className="ot-settings-inner">
                  <div>
                    <h2 style={{ margin: 0, fontSize: 'var(--ot-fs-md)', fontWeight: 600 }}>Ekko ToDo 配置中心</h2>
                    <p style={{ margin: '4px 0 0', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                      项目、Agent、总管与通知设置
                    </p>
                  </div>
                  <SettingsContent {...settingsProps} />
                </div>
              </div>
              <AddProjectDialog
                open={addProjectOpen}
                initialMode={addProjectMode}
                defaultCloneRoot={state.settings?.defaultCloneRoot || ''}
                githubStatus={state.runtime?.githubCli}
                ctx={ctx}
                busy={busy}
                onClose={() => setAddProjectOpen(false)}
                onInspectRepo={inspectRepo}
                onListGithubRepos={listGithubRepos}
                onRefreshGithubAuth={refreshGithubAuth}
                onStartGithubDevice={startGithubDevice}
                onSaveGithubToken={saveGithubToken}
                onLogoutGithub={logoutGithub}
                onCreateLocal={input => callRpc('add-project', input, '项目已添加')}
                onImportGithub={input => callRpc('import-github-project', input, 'GitHub 项目已导入并关联')}
              />
            </div>
          </Tooltip.Provider>
        </LazyMotion>
      </MotionConfig>
    )
  }

  const drawerTodo = state.todos.find(t => t.id === selectedTodoId) || null
  const drawerProject = drawerTodo ? state.projects.find(p => p.id === drawerTodo.projectId) : null
  const decisionTopic = state.topics.find(t => t.id === decisionTopicId) || null
  const decisionProject = decisionTopic
    ? (state.projects.find(p => p.id === decisionTopic.projectId) || state.projects[0] || null)
    : null

  const handleClearTopicWaiting = async payload => {
    const req = typeof payload === 'object' && payload
      ? payload
      : { topicId: String(payload || ''), note: '', notifyChief: true }
    if (!req.topicId) return
    if (req.notifyChief !== false) {
      setSelectedTopicId(req.topicId)
      setMobilePane('chat')
    }
    await callRpc(
      'clear-topic-waiting',
      {
        topicId: req.topicId,
        ...(req.optionId ? { optionId: req.optionId } : {}),
        ...(req.optionLabel ? { optionLabel: req.optionLabel } : {}),
        ...(req.note ? { note: req.note } : {}),
        notifyChief: req.notifyChief !== false,
      },
      req.notifyChief !== false ? '批复已提交并通知大总管' : '已关闭待确认提示',
    )
  }

  const handleOpenTopicDecision = tid => {
    if (!tid) return
    setSelectedTopicId(tid)
    setDecisionTopicId(tid)
  }

  const activeProjectForWs = state.projects.find(p => p.id === selectedProjectId) || state.projects[0] || null
  const isFullMainView = activeView !== 'workbench'

  const wbClasses = ['ot-workbench']
  if (sidebarCollapsed) wbClasses.push('ot-workbench--sidebar-collapsed')
  if (isFullMainView) wbClasses.push('ot-workbench--subview')
  else if (boardExpanded) wbClasses.push('ot-workbench--board-expanded')
  else if (boardHidden) wbClasses.push('ot-workbench--board-hidden')

  const showResizer = !isFullMainView && !isNarrow && !boardExpanded && !boardHidden
  // The sidebar track follows the aside's own (animated) width: SIDEBAR_WIDTH expanded, SIDEBAR_RAIL_WIDTH folded.
  // It never goes below the rail, so folding keeps every entry on screen instead of collapsing the column to nothing.
  const sidebarTrack = `minmax(${SIDEBAR_RAIL_WIDTH}px, auto)`
  const sidebarVars = { '--ot-sidebar-w': `${SIDEBAR_WIDTH}px`, '--ot-sidebar-rail-w': `${SIDEBAR_RAIL_WIDTH}px` }
  const wbStyle = isFullMainView
    ? (!isNarrow ? { ...sidebarVars, gridTemplateColumns: `${sidebarTrack} minmax(0, 1fr)` } : undefined)
    : (!isNarrow && !boardExpanded && !boardHidden
      ? { ...sidebarVars, gridTemplateColumns: `${sidebarTrack} ${chatWidth}px 6px minmax(0, 1fr)` }
      : undefined)

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domMax}>
        <Tooltip.Provider delayDuration={300}>
          <div className="ot-shell" data-testid="ekko-todo-app">
            <div className="ot-mobile-bar" data-testid="mobile-switcher">
              <button
                type="button"
                className="ot-icon-btn"
                onClick={() => setMobileNavOpen(true)}
                aria-label="打开项目与话题"
                data-testid="btn-mobile-sidebar"
              >
                <List size={17} />
              </button>
              <div className="ot-seg">
                <button
                  type="button"
                  className={`ot-seg-btn ${activeView === 'workbench' && mobilePane === 'chat' ? 'is-active' : ''}`}
                  onClick={() => { setActiveView('workbench'); setMobilePane('chat') }}
                >
                  总管对话
                </button>
                <button
                  type="button"
                  className={`ot-seg-btn ${activeView === 'workbench' && mobilePane === 'board' ? 'is-active' : ''}`}
                  onClick={() => { setActiveView('workbench'); setMobilePane('board') }}
                >
                  看板 ({state.counts.humanAttention})
                </button>
              </div>
              <button
                type="button"
                className="ot-icon-btn"
                onClick={() => { setCmdkMode('all'); setCmdkOpen(true) }}
                aria-label="搜索项目、话题和任务"
                title="搜索"
                data-testid="btn-mobile-search"
              >
                <MagnifyingGlass size={17} />
              </button>
              <button type="button" className="ot-icon-btn" onClick={() => openSettingsWithTab('projects')} aria-label="设置">
                <GearSix size={17} />
              </button>
            </div>

            {activeView === 'workbench' && (
              <HomeQuotaStrip
                providers={state.quotaProviders || []}
                refreshing={refreshingHomeQuotas}
                onOpenQuotaHub={() => setActiveView('hub')}
                onRefreshAll={handleRefreshHomeQuotas}
                className="ot-home-quota-strip--mobile"
                testId="mobile-home-quota-strip"
              />
            )}

            <div
              className={wbClasses.join(' ')}
              style={wbStyle}
              data-mobile-pane={mobilePane}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              <Sidebar
                projects={state.projects}
                topics={state.topics}
                todos={state.todos}
                schedules={state.schedules || []}
                quotaProviders={state.quotaProviders || []}
                rail={sidebarCollapsed}
                activeView={activeView}
                selectedProjectId={selectedProjectId}
                selectedTopicId={activeView === 'workbench' ? (activeTopic?.id || '') : ''}
                onSelectProject={pid => {
                  setSelectedProjectId(pid)
                  setActiveView(pid === 'all' ? 'workbench' : 'project')
                }}
                onSelectTopic={tid => {
                  setSelectedTopicId(tid)
                  setActiveView('workbench')
                }}
                onRenameTopic={(topicId, title) => callQuickRpc('update-topic', { topicId, title }, '话题已重命名')}
                onNewTopic={handleInstantNewTopic}
                onNewTask={() => openNewTaskForProject()}
                onAddProject={openAddProject}
                onNewAgent={() => openAgents('', true)}
                onNewSchedule={() => openScheduleModal()}
                onOpenQuotaHub={() => setActiveView('hub')}
                onOpenSchedules={() => setActiveView('schedules')}
                onOpenTrace={() => openTrace('')}
                onOpenAgents={() => openAgents()}
                onOpenShortcuts={() => setShortcutsOpen(true)}
                onOpenSettings={openSettingsWithTab}
                onOpenCommandPalette={() => { setCmdkMode('all'); setCmdkOpen(true) }}
                onCollapse={() => setSidebarCollapsed(v => !v)}
              />

              {activeView === 'project' && activeProjectForWs ? (
                <ProjectWorkspace
                  ctx={ctx}
                  project={activeProjectForWs}
                  todos={state.todos}
                  agents={state.agents}
                  schedules={state.schedules || []}
                  onBack={() => setActiveView('workbench')}
                  onOpenTodo={tid => setSelectedTodoId(tid)}
                  onCreateTask={pid => openNewTaskForProject(pid)}
                  onOpenScheduleForTodo={td => openScheduleModal({ todo: td })}
                  onOpenProjectSettings={() => openSettingsWithTab('projects')}
                  onStartBuild={todoId => callRpc('todo-action', { todoId, action: 'start_build' }, '已启动隔离 Worktree 构建')}
                />
              ) : activeView === 'hub' ? (
                <QuotaHub
                  ctx={ctx}
                  providers={state.quotaProviders || []}
                  settings={state.settings}
                  onBack={() => setActiveView('workbench')}
                  onSaveProvider={input => callQuickRpc('save-quota-provider', input, '配额源配置已保存')}
                  onDeleteProvider={id => callQuickRpc('delete-quota-provider', { id }, '已删除自定义配额源')}
                  onRefreshProvider={id => callQuickRpc('refresh-quota-provider', { id })}
                  onRefreshAll={opts => callQuickRpc('refresh-all-quotas', opts || { onlyEnabled: true })}
                  onUpdateAutoRefresh={mins => callQuickRpc('save-settings', { quotaAutoRefreshMin: mins }, mins > 0 ? `已开启每 ${mins} 分钟自动刷新` : '已切换为仅手动刷新')}
                />
              ) : activeView === 'agents' ? (
                <AgentsView
                  key={agentsFocus.key}
                  ctx={ctx}
                  state={state}
                  busy={busy}
                  initialAgentId={agentsFocus.id}
                  initialCreate={agentsFocus.create}
                  onBack={() => setActiveView('workbench')}
                  onSaveAgent={settingsProps.onSaveAgent}
                  onDeleteAgent={settingsProps.onDeleteAgent}
                  onClearCooldowns={settingsProps.onClearAgentCooldowns}
                  onFetchModelCatalog={fetchModelCatalog}
                  onAskChiefCreateAgent={handleAskChiefCreateAgent}
                />
              ) : activeView === 'trace' ? (
                <SessionTraceView
                  ctx={ctx}
                  initialSessionId={traceSessionId}
                  onBack={() => setActiveView('workbench')}
                />
              ) : activeView === 'schedules' ? (
                <SchedulesView
                  schedules={state.schedules || []}
                  projects={state.projects}
                  todos={state.todos}
                  agents={state.agents}
                  onBack={() => setActiveView('workbench')}
                  onOpenNewModal={() => openScheduleModal()}
                  onEditSchedule={sc => openScheduleModal({ schedule: sc })}
                  onToggleSchedule={(id, enabled) => callQuickRpc('save-schedule', { id, enabled }, enabled ? '定时规则已启用' : '定时规则已暂停')}
                  onDeleteSchedule={id => callQuickRpc('delete-schedule', { id }, '定时规则已删除')}
                  onTriggerSchedule={id => callRpc('trigger-schedule', { id }, '已手动触发一次定时运行')}
                  onOpenTodo={tid => setSelectedTodoId(tid)}
                />
              ) : (
                <>
                  <ChatPane
                    ctx={ctx}
                    onOpenTrace={openTrace}
                    state={state}
                    topic={activeTopic}
                    projects={state.projects}
                    todos={state.todos}
                    liveStream={liveStream}
                    pendingSends={pendingSends}
                    heldReply={heldView.status === 'saved' ? null : heldView}
                    heldSync={heldSync && heldSync.topicId === activeTopic?.id && (heldSync.state === 'saved' || heldSync.endedAt === heldReply?.endedAt) ? heldSync : null}
                    onRetryHeldSync={retryHeldSync}
                    showSidebarTrigger={isNarrow}
                    boardHidden={boardHidden}
                    busy={busy}
                    composerFocusSeq={composerFocusSeq}
                    onToggleSidebar={() => setMobileNavOpen(true)}
                    onToggleBoard={() => {
                      setBoardExpanded(false)
                      setBoardHidden(v => !v)
                    }}
                    onSendMessage={handleSendTopicMessage}
                    onCancelQueueItem={(topicId, itemId) => callQuickRpc('cancel-topic-queue-item', { topicId, itemId }, '已撤回排队消息')}
                    onPromoteQueueItem={(topicId, itemId) => callRpc('promote-topic-queue-item', { topicId, itemId }, '已中止当前回合，立即执行排队消息')}
                    onUploadFile={uploadChatFile}
                    onStopRun={async topicId => {
                      const next = await callRpc('stop-topic-run', { topicId }, '已停止运行')
                      // The host sends no event when the session was already idle: clear the display here.
                      if (next && topicId === activeTopicRef.current?.id) clearLiveWorking()
                      return next
                    }}
                    chiefContext={chiefContext.info}
                    onCompressContext={chiefContext.compress}
                    onRunSlashCommand={chiefContext.runCommand}
                    onToggleAutopilot={(topicId, autopilot) => callQuickRpc('set-topic-autopilot', { topicId, autopilot })}
                    onRenameTopic={(topicId, title) => callQuickRpc('update-topic', { topicId, title }, '话题已重命名')}
                    onUpdateTopicMeta={(topicId, patch) => callQuickRpc('update-topic', { topicId, ...patch }, patch?.projectId !== undefined ? '话题项目归属已更新' : undefined)}
                    onRepairTopicTodos={repairTopicTodos}
                    onDeleteTopic={topicId => callRpc('delete-topic', { id: topicId }, '话题已删除')}
                    onClearTopicWaiting={handleClearTopicWaiting}
                    onOpenTopicDecision={handleOpenTopicDecision}
                    onOpenTodo={tid => setSelectedTodoId(tid)}
                    onAnswerQuestion={(todoId, optionId, note) => callRpc('todo-action', { todoId, action: 'answer_question', optionId, note }, '已提交决策并恢复执行')}
                    onOpenCreateTask={() => openNewTaskForProject()}
                    onAddProject={openAddProject}
                    onNewTopic={handleInstantNewTopic}
                    onQuickConfigureChief={input => callQuickRpc('quick-configure-chief', input, '总管配置已更新')}
                    onFetchModelCatalog={fetchModelCatalog}
                    onOpenSettingsTab={openSettingsWithTab}
                    onOpenAgents={openAgents}
                    onOpenOnboarding={() => setOnboardingOpen(true)}
                  />

                  {showResizer && (
                    <div
                      className="ot-split-handle"
                      role="separator"
                      aria-orientation="vertical"
                      title="拖动调整对话与看板宽度"
                      onPointerDown={startSplitResize}
                    />
                  )}

                  <KanbanBoard
                    onSearch={searchWorkspace}
                    projects={state.projects}
                    agents={state.agents}
                    topics={state.topics}
                    todos={state.todos}
                    quotaProviders={state.quotaProviders || []}
                    quotaRefreshing={refreshingHomeQuotas}
                    selectedProjectId={boardProjectId}
                    activeTopicId={activeTopic?.id || ''}
                    selectedTodoId={selectedTodoId}
                    onlyHumanAttention={onlyHumanAttention}
                    boardExpanded={boardExpanded}
                    onToggleOnlyHuman={setOnlyHumanAttention}
                    onSelectProject={pid => setBoardProjectId(pid || 'all')}
                    onClearProjectFilter={() => setBoardProjectId('all')}
                    onToggleExpand={() => {
                      setBoardHidden(false)
                      setBoardExpanded(v => !v)
                    }}
                    onOpenTodo={tid => setSelectedTodoId(tid)}
                    onOpenTopicDecision={handleOpenTopicDecision}
                    onOpenCreateTask={() => openNewTaskForProject()}
                    onOpenQuotaHub={() => setActiveView('hub')}
                    onRefreshQuotas={handleRefreshHomeQuotas}
                    todosOmitted={state.todosOmitted || 0}
                  />
                </>
              )}
            </div>

            {/* Bottom-right Completion & Human-Attention Popup Notification Stack */}
            {notifyPopups.length > 0 && (
              <div className="ot-notify-stack" data-testid="completion-notify-stack" role="status" aria-live="polite">
                {notifyPopups.map(pop => (
                  <div
                    key={pop.id}
                    className={`ot-notify-toast is-${pop.tone || 'success'}`}
                    onClick={() => {
                      if (pop.todoId) setSelectedTodoId(pop.todoId)
                      else if (pop.topicId) { setSelectedTopicId(pop.topicId); setActiveView('workbench') }
                      setNotifyPopups(prev => prev.filter(x => x.id !== pop.id))
                    }}
                  >
                    <span className="ot-notify-ico">
                      {pop.tone === 'error'
                        ? <WarningCircle size={16} weight="fill" />
                        : pop.tone === 'attention'
                          ? <Bell size={16} weight="fill" />
                          : <CheckCircle size={16} weight="fill" />}
                    </span>
                    <div className="ot-notify-copy">
                      <strong>{pop.title}</strong>
                      {pop.body && <p>{pop.body}</p>}
                    </div>
                    <button
                      type="button"
                      className="ot-icon-btn"
                      style={{ flex: 'none' }}
                      onClick={e => { e.stopPropagation(); setNotifyPopups(prev => prev.filter(x => x.id !== pop.id)) }}
                      aria-label="关闭通知"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <TopicDecisionDialog
              topic={decisionTopic}
              project={decisionProject}
              busy={busy}
              onClose={() => setDecisionTopicId('')}
              onSubmitDecision={handleClearTopicWaiting}
            />

            <LocalFilePreview notify={(msg, kind) => ctx.ui?.notify?.(msg, kind)} />

            <TodoDrawer
              todo={drawerTodo}
              project={drawerProject}
              topics={state.topics}
              agents={state.agents}
              busy={busy}
              onClose={() => setSelectedTodoId('')}
              onOpenSchedule={td => openScheduleModal({ todo: td })}
              onOpenTrace={openTrace}
              onLoadDiffs={todoId => ctx.rpc.call('get-todo-diffs', { todoId })}
              onLoadDetail={todoId => ctx.rpc.call('get-todo-detail', { todoId })}
              onRetryMerge={async todoId => {
                let refused = null
                const next = await callRpc('retry-merge', { todoId }, '已回到合并关口，审查结论保留', { onError: err => { refused = err } })
                if (refused) throw refused
                return next
              }}
              onAction={(todoId, action, note = '', optionId = '', withPlan = false, configId = '') => {
                const toasts = {
                  start_build: withPlan ? '已派发方案规划' : '已启动隔离 Worktree 构建',
                  retry_continue: '已原地恢复构建重试',
                  retry_fresh: '已清理工作树并从头重跑',
                  confirm_plan: '方案已批准并开始实施',
                  answer_question: '已同步决策并恢复执行',
                  request_review: '已派发独立只读审查',
                  approve_merge: '已开始合并，卡片已移至「执行中」',
                  request_changes: '已退回修改',
                  message_todo: '已发送补充指令',
                  cancel_build: '已停止当前运行',
                  reopen: '已重新打开任务',
                  refresh_diff: '已刷新工作树快照 Diff',
                  delete: '任务已删除',
                }
                if (action === 'delete') {
                  return callRpc('todo-action', { todoId, action }, toasts.delete).then(next => {
                    if (next) setSelectedTodoId('')
                    return next
                  })
                }
                return callRpc('todo-action', {
                  todoId,
                  action,
                  note,
                  optionId,
                  withPlan,
                  ...(configId ? { configId } : {}),
                }, toasts[action])
              }}
            />

            <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
              <Dialog.Portal>
                <Dialog.Overlay className="ot-overlay" />
                <Dialog.Content className="ot-modal ot-modal--xl" data-testid="settings-modal" onOpenAutoFocus={e => e.preventDefault()}>
                  <div className="ot-dialog-head">
                    <div>
                      <Dialog.Title className="ot-dialog-title">配置中心</Dialog.Title>
                      <p className="ot-dialog-sub">项目、Agent、总管与通知设置</p>
                    </div>
                    <Dialog.Close asChild>
                      <button type="button" className="ot-icon-btn" aria-label="关闭"><X size={16} /></button>
                    </Dialog.Close>
                  </div>
                  <SettingsContent {...settingsProps} />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>

            {/* Drawer Sidebar for Narrow Desktop (<= 980px) & Mobile (<= 780px) — guaranteed populated! */}
            <Dialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <Dialog.Portal>
                <Dialog.Overlay className="ot-overlay" />
                <Dialog.Content
                  className="ot-drawer ot-drawer--left"
                  aria-label="项目与话题侧边栏"
                  onOpenAutoFocus={e => e.preventDefault()}
                  data-testid="sidebar-drawer-content"
                >
                  <Dialog.Title className="ot-sr-only">项目与话题</Dialog.Title>
                  <Sidebar
                    inDrawer
                    projects={state.projects}
                    topics={state.topics}
                    todos={state.todos}
                    schedules={state.schedules || []}
                    quotaProviders={state.quotaProviders || []}
                    activeView={activeView}
                    selectedProjectId={selectedProjectId}
                    selectedTopicId={activeView === 'workbench' ? (activeTopic?.id || '') : ''}
                    onSelectProject={pid => { setSelectedProjectId(pid); setActiveView(pid === 'all' ? 'workbench' : 'project'); setMobileNavOpen(false) }}
                    onSelectTopic={tid => { setSelectedTopicId(tid); setActiveView('workbench'); setMobilePane('chat'); setMobileNavOpen(false) }}
                    onRenameTopic={(topicId, title) => callQuickRpc('update-topic', { topicId, title }, '话题已重命名')}
                    onNewTopic={handleInstantNewTopic}
                    onNewTask={() => { setMobileNavOpen(false); openNewTaskForProject() }}
                    onAddProject={mode => { setMobileNavOpen(false); openAddProject(mode) }}
                    onNewAgent={() => openAgents('', true)}
                    onNewSchedule={() => { setMobileNavOpen(false); openScheduleModal() }}
                    onOpenQuotaHub={() => { setMobileNavOpen(false); setActiveView('hub') }}
                    onOpenSchedules={() => { setMobileNavOpen(false); setActiveView('schedules') }}
                    onOpenTrace={() => { setMobileNavOpen(false); openTrace('') }}
                    onOpenAgents={() => openAgents()}
                    onOpenShortcuts={() => { setMobileNavOpen(false); setShortcutsOpen(true) }}
                    onOpenSettings={t => { setMobileNavOpen(false); openSettingsWithTab(t) }}
                    onOpenCommandPalette={() => { setMobileNavOpen(false); setCmdkMode('all'); setCmdkOpen(true) }}
                    onCollapse={() => setMobileNavOpen(false)}
                  />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>

            <CommandPalette
              open={cmdkOpen}
              mode={cmdkMode}
              onOpenChange={setCmdkOpen}
              onSwitchMode={setCmdkMode}
              state={state}
              onSearch={searchWorkspace}
              onSelectProject={pid => { setSelectedProjectId(pid); setActiveView('project') }}
              onSelectTopic={tid => { setSelectedTopicId(tid); setActiveView('workbench') }}
              onOpenTodo={tid => setSelectedTodoId(tid)}
              onOpenAddProject={openAddProject}
              onOpenNewTopic={handleInstantNewTopic}
              onOpenNewTask={() => openNewTaskForProject()}
              onOpenNewSchedule={() => openScheduleModal()}
              onOpenQuotaHub={() => setActiveView('hub')}
              onOpenSchedules={() => setActiveView('schedules')}
              onOpenShortcuts={() => setShortcutsOpen(true)}
              onOpenSettingsTab={openSettingsWithTab}
              onOpenOnboarding={() => setOnboardingOpen(true)}
              onSetChiefEffort={lvl => callQuickRpc('quick-configure-chief', { reasoningEffort: lvl }, chiefEffortToast(state.settings, lvl))}
            />

            <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
            {confirmNode}

            <ScheduleModal
              open={scheduleModalOpen}
              onOpenChange={setScheduleModalOpen}
              projects={state.projects}
              todos={state.todos}
              agents={state.agents}
              initialSchedule={editingSchedule}
              preselectTodo={schedulePreselectTodo}
              preselectProjectId={schedulePreselectProjectId}
              onSave={input => callQuickRpc('save-schedule', input, input.id ? '定时规则已更新' : '定时规则已创建')}
              onOpenCreateTask={pid => openNewTaskForProject(pid)}
            />

            <OnboardingWizard
              open={onboardingOpen}
              state={state}
              busy={busy}
              onClose={() => setOnboardingOpen(false)}
              onComplete={input => callRpc('complete-onboarding', input, input?.skip ? '' : '团队与主力大总管已配置完成')}
              onFetchModelCatalog={fetchModelCatalog}
              onRefreshGithubAuth={refreshGithubAuth}
              onStartGithubDevice={startGithubDevice}
              onSaveGithubToken={saveGithubToken}
              onLogoutGithub={logoutGithub}
              onOpenAddProject={openAddProject}
            />

            <AddProjectDialog
              open={addProjectOpen}
              initialMode={addProjectMode}
              defaultCloneRoot={state.settings?.defaultCloneRoot || ''}
              githubStatus={state.runtime?.githubCli}
              ctx={ctx}
              busy={busy}
              onClose={() => setAddProjectOpen(false)}
              onInspectRepo={inspectRepo}
              onListGithubRepos={listGithubRepos}
              onRefreshGithubAuth={refreshGithubAuth}
              onStartGithubDevice={startGithubDevice}
              onSaveGithubToken={saveGithubToken}
              onLogoutGithub={logoutGithub}
              onCreateLocal={input => callRpc('add-project', input, '项目已添加')}
              onImportGithub={input => callRpc('import-github-project', input, 'GitHub 项目已导入并关联')}
            />

            <CreateTaskDialog
              open={newTaskOpen}
              projects={state.projects}
              agents={state.agents}
              topics={state.topics}
              defaultProjectId={newTaskProjectId || contextProjectId || state.projects[0]?.id || ''}
              defaultTopicId={activeTopic?.id || ''}
              busy={busy}
              onClose={() => setNewTaskOpen(false)}
              onCreate={(input, hooks) => createTaskWithTopic({ input, topics: state.topics, callRpc, onTopicCreated: hooks?.onTopicCreated })}
              onNeedProject={() => openAddProject('github')}
            />
          </div>
        </Tooltip.Provider>
      </LazyMotion>
    </MotionConfig>
  )
}

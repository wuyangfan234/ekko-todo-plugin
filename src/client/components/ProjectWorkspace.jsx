import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  CaretLeft,
  CaretDown,
  CaretRight,
  Folder,
  FolderOpen,
  FileText,
  List as ListIcon,
  Table as TableIcon,
  SquaresFour,
  GitBranch,
  Plus,
  DownloadSimple,
  Clock,
  SlidersHorizontal,
  MagnifyingGlass,
  FunnelSimple,
  ArrowsDownUp,
  Copy,
  Check,
  CircleNotch,
  GitCommit,
  Eye,
  Code,
  Play,
  ArrowClockwise,
  X,
} from '@phosphor-icons/react'
import { AgentAvatar, ProjectAvatar } from './AvatarKit.jsx'
import { previewErrorText } from '../preview-errors.js'
import {
  KIND_LABEL,
  formatRelativeTime,
  getProjectLabel,
  getTodoCardStateMeta,
  isImeComposingEvent,
} from '../utils.js'
import { installExternalLinkHook } from '../local-files.js'

// Links in rendered repo Markdown open a new page instead of the host iframe.
installExternalLinkHook(DOMPurify)

function formatBytes(n) {
  const b = Number(n) || 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(2)} MB`
}

function renderDiffLines(patch) {
  return String(patch || '').split('\n').map((line, idx) => {
    let cls = 'ot-diff-line'
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) cls += ' ot-diff-meta'
    else if (line.startsWith('@@')) cls += ' ot-diff-hunk'
    else if (line.startsWith('+')) cls += ' ot-diff-add'
    else if (line.startsWith('-')) cls += ' ot-diff-del'
    return <div key={idx} className={cls}>{line || ' '}</div>
  })
}

const PHASE_FILTER_OPTIONS = [
  ['all', '全部状态'],
  ['active', '执行中 / 排队'],
  ['human', '待你处理'],
  ['todo', '待开始'],
  ['done', '已完成'],
  ['failed', '失败'],
  ['closed', '已关闭'],
]

const SORT_OPTIONS = [
  ['updated_desc', '最近更新'],
  ['number_desc', '编号降序 (#N → #1)'],
  ['number_asc', '编号升序 (#1 → #N)'],
  ['priority', '执行中 / 待你处理优先'],
  ['created_desc', '最新创建'],
]

function phaseSortWeight(td) {
  if (td.phase === 'building' || td.phase === 'reviewing' || td.phase === 'merging') return 0
  if (td.gateOwner === 'human' && td.phase !== 'done' && td.phase !== 'closed') return 1
  if (td.phase === 'queued') return 2
  if (td.phase === 'failed') return 3
  if (td.phase === 'todo') return 4
  if (td.phase === 'done') return 5
  return 6
}

export function ProjectWorkspace({
  ctx,
  project,
  todos = [],
  agents = [],
  schedules = [],
  onBack,
  onOpenTodo,
  onCreateTask,
  onOpenScheduleForTodo,
  onOpenProjectSettings,
  onStartBuild,
}) {
  const [subView, setSubView] = useState('files') // 'files' | 'tasks'
  const [explorerTab, setExplorerTab] = useState('files') // 'files' | 'history'

  // Branch & Repo File Explorer state
  const [branches, setBranches] = useState([])
  const [activeRef, setActiveRef] = useState(project?.defaultBranch || 'main')
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [branchQuery, setBranchQuery] = useState('')
  const [treeByDir, setTreeByDir] = useState({})
  const [expandedDirs, setExpandedDirs] = useState({})
  const [loadingTree, setLoadingTree] = useState(false)
  const [fileFilter, setFileFilter] = useState('')
  const [selectedFilePath, setSelectedFilePath] = useState('')
  const [filePreview, setFilePreview] = useState(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const [mdRenderMode, setMdRenderMode] = useState('rendered') // 'rendered' | 'source'
  const [copiedFile, setCopiedFile] = useState(false)

  // Commit history state
  const [commits, setCommits] = useState([])
  const [loadingCommits, setLoadingCommits] = useState(false)
  const [selectedCommitSha, setSelectedCommitSha] = useState('')
  const [commitDiff, setCommitDiff] = useState(null)
  const [loadingCommitDiff, setLoadingCommitDiff] = useState(false)

  // Project Tasks Management state (Screenshot 2: search, filter, sort, table vs card view)
  const [taskQuery, setTaskQuery] = useState('')
  const [phaseFilter, setPhaseFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState('all')
  const [agentFilter, setAgentFilter] = useState('all')
  const [sortBy, setSortBy] = useState('updated_desc')
  const [taskLayout, setTaskLayout] = useState('table') // 'table' | 'cards'
  const [filterOpen, setFilterOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)

  const searchComposingRef = useRef(false)
  const searchCompEndRef = useRef(0)

  const projectTodos = useMemo(
    () => todos.filter(td => td.projectId === project?.id),
    [todos, project?.id],
  )
  const agentById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents])
  const scheduleCountByTodo = useMemo(() => {
    const m = new Map()
    for (const s of schedules) {
      if (s.enabled) m.set(s.todoId, (m.get(s.todoId) || 0) + 1)
    }
    return m
  }, [schedules])

  // Reset state when switching project
  useEffect(() => {
    if (!project) return
    setActiveRef(project.defaultBranch || 'main')
    setTreeByDir({})
    setExpandedDirs({})
    setSelectedFilePath('')
    setFilePreview(null)
    setSelectedCommitSha('')
    setCommitDiff(null)
    setCommits([])
    setBranches([])
    setFileFilter('')
  }, [project?.id])

  // Load branches for project
  const loadBranches = useCallback(async () => {
    if (!project?.id) return
    try {
      const res = await ctx.rpc.call('project-branches', { projectId: project.id })
      if (res && Array.isArray(res.branches)) {
        setBranches(res.branches)
        if (!activeRef && res.defaultBranch) setActiveRef(res.defaultBranch)
      }
    } catch {
      // ignore offline repo errors
    }
  }, [ctx, project?.id, activeRef])

  // Load root directory tree for activeRef
  const loadDir = useCallback(async (dirPath = '', refOverride = '') => {
    if (!project?.id) return
    const ref = refOverride || activeRef || project.defaultBranch || 'HEAD'
    if (dirPath === '') setLoadingTree(true)
    try {
      const res = await ctx.rpc.call('project-tree', { projectId: project.id, ref, path: dirPath })
      if (res && Array.isArray(res.entries)) {
        setTreeByDir(prev => ({ ...prev, [dirPath]: res.entries }))
      }
    } catch (err) {
      if (dirPath === '') setTreeByDir({ '': [] })
      ctx.ui?.notify?.(err?.message || '读取目录树失败', 'error')
    } finally {
      if (dirPath === '') setLoadingTree(false)
    }
  }, [ctx, project?.id, project?.defaultBranch, activeRef])

  const loadCommits = useCallback(async (refOverride = '') => {
    if (!project?.id) return
    const ref = refOverride || activeRef || project.defaultBranch || 'HEAD'
    setLoadingCommits(true)
    try {
      const res = await ctx.rpc.call('project-commits', { projectId: project.id, ref, limit: 35 })
      setCommits(Array.isArray(res?.commits) ? res.commits : [])
    } catch {
      setCommits([])
    } finally {
      setLoadingCommits(false)
    }
  }, [ctx, project?.id, project?.defaultBranch, activeRef])

  useEffect(() => {
    if (!project?.id || subView !== 'files') return
    void loadBranches()
    setTreeByDir({})
    setExpandedDirs({})
    setSelectedFilePath('')
    setFilePreview(null)
    setSelectedCommitSha('')
    setCommitDiff(null)
    void loadDir('', activeRef)
    void loadCommits(activeRef)
  }, [project?.id, activeRef, subView])

  const handleToggleDir = async dirPath => {
    const nextOpen = !expandedDirs[dirPath]
    setExpandedDirs(prev => ({ ...prev, [dirPath]: nextOpen }))
    if (nextOpen && !treeByDir[dirPath]) {
      await loadDir(dirPath)
    }
  }

  const handleOpenFile = async filePath => {
    if (!project?.id) return
    setSelectedFilePath(filePath)
    setSelectedCommitSha('')
    setCommitDiff(null)
    setLoadingFile(true)
    try {
      const res = await ctx.rpc.call('project-file', {
        projectId: project.id,
        ref: activeRef || project.defaultBranch || 'HEAD',
        path: filePath,
      })
      setFilePreview(res)
      setMdRenderMode(res?.kind === 'markdown' ? 'rendered' : 'source')
    } catch (err) {
      setFilePreview({ error: previewErrorText(err), path: filePath })
    } finally {
      setLoadingFile(false)
    }
  }

  const handleOpenCommit = async sha => {
    if (!project?.id || !sha) return
    setSelectedCommitSha(sha)
    setSelectedFilePath('')
    setFilePreview(null)
    setLoadingCommitDiff(true)
    try {
      const res = await ctx.rpc.call('project-commit-diff', { projectId: project.id, sha })
      setCommitDiff(res)
    } catch (err) {
      setCommitDiff({ error: err?.message || String(err), sha })
    } finally {
      setLoadingCommitDiff(false)
    }
  }

  const handleCopyFile = async () => {
    if (!filePreview?.content) return
    try {
      await navigator.clipboard.writeText(filePreview.content)
      setCopiedFile(true)
      setTimeout(() => setCopiedFile(false), 1600)
    } catch {}
  }

  const handleDownloadFile = () => {
    if (!filePreview || filePreview.error) return
    const filename = (filePreview.path || 'file.txt').split('/').pop() || 'file.txt'
    let href = ''
    let shouldRevoke = false
    if (filePreview.kind === 'image' && filePreview.dataUrl) {
      href = filePreview.dataUrl
    } else if (filePreview.content !== undefined) {
      const blob = new Blob([filePreview.content], { type: 'text/plain;charset=utf-8' })
      href = URL.createObjectURL(blob)
      shouldRevoke = true
    } else {
      return
    }
    const a = document.createElement('a')
    a.href = href
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    if (shouldRevoke) setTimeout(() => URL.revokeObjectURL(href), 1000)
  }

  // Filtered & sorted tasks for Tasks view
  const filteredTasks = useMemo(() => {
    const q = taskQuery.trim().toLowerCase()
    const list = projectTodos.filter(td => {
      if (phaseFilter === 'active' && !['building', 'reviewing', 'merging', 'queued'].includes(td.phase)) return false
      if (phaseFilter === 'human' && !(td.gateOwner === 'human' && td.phase !== 'done' && td.phase !== 'closed')) return false
      if (phaseFilter === 'todo' && td.phase !== 'todo') return false
      if (phaseFilter === 'done' && td.phase !== 'done') return false
      if (phaseFilter === 'failed' && td.phase !== 'failed') return false
      if (phaseFilter === 'closed' && td.phase !== 'closed') return false
      if (kindFilter !== 'all' && td.kind !== kindFilter) return false
      if (agentFilter !== 'all' && td.agentId !== agentFilter) return false
      if (q) {
        const ag = agentById.get(td.agentId)?.name || ''
        const hay = `#${td.number} ${td.title} ${td.spec || ''} ${td.branch || ''} ${ag} ${(td.tags || []).join(' ')}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    return [...list].sort((a, b) => {
      if (sortBy === 'number_desc') return (b.number || 0) - (a.number || 0)
      if (sortBy === 'number_asc') return (a.number || 0) - (b.number || 0)
      if (sortBy === 'created_desc') return (b.createdAt || 0) - (a.createdAt || 0)
      if (sortBy === 'priority') {
        const d = phaseSortWeight(a) - phaseSortWeight(b)
        if (d !== 0) return d
        return (b.updatedAt || 0) - (a.updatedAt || 0)
      }
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })
  }, [projectTodos, taskQuery, phaseFilter, kindFilter, agentFilter, sortBy, agentById])

  const activeFilterCount = (phaseFilter !== 'all' ? 1 : 0) + (kindFilter !== 'all' ? 1 : 0) + (agentFilter !== 'all' ? 1 : 0)
  const activeRunningCount = useMemo(
    () => projectTodos.filter(td => ['building', 'reviewing', 'merging', 'queued'].includes(td.phase)).length,
    [projectTodos],
  )

  const filteredBranches = useMemo(() => {
    const q = branchQuery.trim().toLowerCase()
    if (!q) return branches
    return branches.filter(b => `${b.name} ${b.todoTitle || ''} #${b.todoNumber || ''}`.toLowerCase().includes(q))
  }, [branches, branchQuery])

  const renderedMarkdownHtml = useMemo(() => {
    if (!filePreview || filePreview.kind !== 'markdown' || !filePreview.content) return ''
    try {
      return DOMPurify.sanitize(marked.parse(filePreview.content, { breaks: true, gfm: true }))
    } catch {
      return ''
    }
  }, [filePreview])

  const renderTreeNodes = (dirPath = '', depth = 0) => {
    const entries = treeByDir[dirPath] || []
    const q = fileFilter.trim().toLowerCase()
    const visible = q && depth === 0
      ? entries.filter(e => e.name.toLowerCase().includes(q))
      : entries

    return visible.map(entry => {
      const isDir = entry.type === 'dir'
      const isOpen = Boolean(expandedDirs[entry.path])
      const isSelected = !isDir && selectedFilePath === entry.path
      return (
        <React.Fragment key={entry.path}>
          <button
            type="button"
            className={`ot-tree-row ${isSelected ? 'is-selected' : ''}`}
            style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() => (isDir ? handleToggleDir(entry.path) : handleOpenFile(entry.path))}
            data-testid={`tree-node-${entry.path}`}
          >
            <span className="ot-tree-row-main">
              {isDir ? (
                isOpen ? <FolderOpen size={14} weight="regular" className="ot-tree-ico" /> : <Folder size={14} weight="regular" className="ot-tree-ico" />
              ) : (
                <FileText size={14} weight="regular" className="ot-tree-ico is-file" />
              )}
              <span className="ot-tree-name">{entry.name}</span>
            </span>
            {isDir && (
              <span className="ot-tree-caret">
                {isOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}
              </span>
            )}
          </button>
          {isDir && isOpen && renderTreeNodes(entry.path, depth + 1)}
        </React.Fragment>
      )
    })
  }

  if (!project) return null
  const label = getProjectLabel(project)

  return (
    <section className="ot-proj-ws" data-testid="project-workspace">
      {/* Top Contextual Bar matching Todos Screenshots 1 & 2 */}
      <header className="ot-proj-topbar">
        <div className="ot-proj-topbar-left">
          <button
            type="button"
            className="ot-icon-btn"
            onClick={onBack}
            title="返回大总管工作台 (⌘[)"
            aria-label="返回工作台"
            data-testid="btn-project-back"
          >
            <CaretLeft size={16} weight="bold" />
          </button>
          {subView === 'files' && <Folder size={15} style={{ color: 'var(--ot-text-2)', flex: 'none' }} />}
          <span className="ot-proj-topbar-id">
            <ProjectAvatar project={project} size={20} />
            <strong className="ot-proj-topbar-name">{label}</strong>
          </span>

          {/* Git Branch Switcher (Screenshot 1 red box) */}
          {subView === 'files' && (
            <Popover.Root open={branchMenuOpen} onOpenChange={setBranchMenuOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className="ot-branch-trigger"
                  title="切换浏览分支（只读，不改动本地工作树）"
                  data-testid="btn-branch-picker"
                >
                  <GitBranch size={13} weight="regular" />
                  <span className="ot-branch-trigger-name">{activeRef}</span>
                  <CaretDown size={11} style={{ opacity: 0.6 }} />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="ot-menu-popover ot-menu-popover--paper ot-branch-popover" align="start" sideOffset={6} data-testid="branch-picker-menu">
                  <div className="ot-branch-search">
                    <MagnifyingGlass size={12} style={{ color: 'var(--ot-muted)' }} />
                    <input
                      className="ot-branch-search-input"
                      placeholder="筛选分支或任务编号…"
                      value={branchQuery}
                      onChange={e => setBranchQuery(e.target.value)}
                    />
                  </div>
                  <div className="ot-branch-list">
                    {filteredBranches.length === 0 ? (
                      <div className="ot-branch-empty">暂无匹配分支</div>
                    ) : filteredBranches.map(b => (
                      <button
                        key={b.name}
                        type="button"
                        className={`ot-branch-item ${b.name === activeRef ? 'is-active' : ''}`}
                        onClick={() => { setActiveRef(b.name); setBranchMenuOpen(false) }}
                        data-testid={`branch-opt-${b.name}`}
                      >
                        <div className="ot-branch-item-top">
                          <span className="ot-branch-item-name">
                            <GitBranch size={12} />
                            <span>{b.name}</span>
                          </span>
                          {b.isDefault && <span className="ot-branch-tag">基准</span>}
                          {b.todoNumber > 0 && <span className="ot-branch-tag is-todo">#{b.todoNumber}</span>}
                        </div>
                        {b.todoTitle ? (
                          <div className="ot-branch-item-sub">{b.todoTitle}</div>
                        ) : b.subject ? (
                          <div className="ot-branch-item-sub">{b.subject}</div>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}
        </div>

        {/* Center View Switcher: Folder (Files) vs List (Tasks) — Screenshot 1 & 2 center red box */}
        <div className="ot-proj-view-seg" role="tablist" aria-label="项目视图切换" data-testid="project-view-switcher">
          <button
            type="button"
            role="tab"
            aria-selected={subView === 'files'}
            className={`ot-proj-view-btn ${subView === 'files' ? 'is-active' : ''}`}
            onClick={() => setSubView('files')}
            title="文件与提交历史预览"
            data-testid="tab-project-files"
          >
            <Folder size={15} weight={subView === 'files' ? 'fill' : 'regular'} />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subView === 'tasks'}
            className={`ot-proj-view-btn ${subView === 'tasks' ? 'is-active' : ''}`}
            onClick={() => setSubView('tasks')}
            title="项目任务管理（表格 / 卡片 / 筛选 / 排序）"
            data-testid="tab-project-tasks"
          >
            <ListIcon size={15} weight={subView === 'tasks' ? 'bold' : 'regular'} />
          </button>
        </div>

        {/* Right Quick Actions */}
        <div className="ot-proj-topbar-right">
          <button
            type="button"
            className="ot-icon-btn is-accent"
            onClick={() => onCreateTask?.(project.id)}
            title="在本项目新建任务 (⌘N)"
            data-testid="btn-project-new-task"
          >
            <Plus size={15} weight="bold" />
          </button>
          {subView === 'files' && (
            <button
              type="button"
              className="ot-icon-btn"
              onClick={handleDownloadFile}
              disabled={!filePreview || Boolean(filePreview.error) || filePreview.kind === 'binary'}
              title="下载当前预览文件"
            >
              <DownloadSimple size={15} />
            </button>
          )}
          <button
            type="button"
            className="ot-icon-btn"
            onClick={() => {
              if (subView === 'files') {
                void loadBranches()
                void loadDir('', activeRef)
                void loadCommits(activeRef)
              }
            }}
            title="刷新仓库状态"
          >
            <ArrowClockwise size={14} />
          </button>
          <button
            type="button"
            className="ot-icon-btn"
            onClick={() => onOpenProjectSettings?.()}
            title="项目设置"
          >
            <SlidersHorizontal size={15} />
          </button>
        </div>
      </header>

      {/* SUBVIEW 1: FILES & HISTORY EXPLORER (Screenshot 1) */}
      {subView === 'files' ? (
        <div className="ot-proj-files-body" data-testid="project-files-view">
          <aside className="ot-proj-tree-col">
            <div className="ot-proj-tree-head">
              <div className="ot-proj-seg-text" role="tablist" data-testid="files-history-tabs">
                <button
                  type="button"
                  role="tab"
                  aria-selected={explorerTab === 'files'}
                  className={`ot-proj-seg-tab ${explorerTab === 'files' ? 'is-active' : ''}`}
                  onClick={() => setExplorerTab('files')}
                  data-testid="tab-explorer-files"
                >
                  文件
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={explorerTab === 'history'}
                  className={`ot-proj-seg-tab ${explorerTab === 'history' ? 'is-active' : ''}`}
                  onClick={() => setExplorerTab('history')}
                  data-testid="tab-explorer-history"
                >
                  历史
                </button>
              </div>
              {explorerTab === 'files' && (
                <div className="ot-tree-filter-wrap">
                  <MagnifyingGlass size={12} style={{ color: 'var(--ot-muted)', flex: 'none' }} />
                  <input
                    className="ot-tree-filter-input"
                    placeholder="过滤根目录…"
                    value={fileFilter}
                    onChange={e => setFileFilter(e.target.value)}
                  />
                  {fileFilter && (
                    <button type="button" className="ot-tree-filter-clear" onClick={() => setFileFilter('')} aria-label="清空">
                      <X size={11} />
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="ot-proj-tree-scroll">
              {explorerTab === 'files' ? (
                loadingTree ? (
                  <div className="ot-tree-empty"><CircleNotch size={14} className="ot-spin" /> 正在读取目录…</div>
                ) : (treeByDir[''] || []).length === 0 ? (
                  <div className="ot-tree-empty">当前分支暂无可浏览文件</div>
                ) : (
                  renderTreeNodes('', 0)
                )
              ) : (
                loadingCommits ? (
                  <div className="ot-tree-empty"><CircleNotch size={14} className="ot-spin" /> 正在读取提交历史…</div>
                ) : commits.length === 0 ? (
                  <div className="ot-tree-empty">暂无提交记录</div>
                ) : (
                  <div className="ot-commit-list">
                    {commits.map(c => (
                      <button
                        key={c.sha}
                        type="button"
                        className={`ot-commit-row ${selectedCommitSha === c.sha ? 'is-selected' : ''}`}
                        onClick={() => handleOpenCommit(c.sha)}
                        data-testid={`commit-row-${c.shortSha}`}
                      >
                        <div className="ot-commit-subj">{c.subject || '(无提交说明)'}</div>
                        <div className="ot-commit-meta">
                          <span className="ot-commit-sha"><GitCommit size={11} /> {c.shortSha}</span>
                          <span>{c.author}</span>
                          <span>{formatRelativeTime(c.committedAt)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
          </aside>

          <main className="ot-proj-preview-pane" data-testid="project-file-preview">
            {loadingFile || loadingCommitDiff ? (
              <div className="ot-proj-preview-empty">
                <CircleNotch size={20} className="ot-spin" style={{ color: 'var(--ot-muted)' }} />
                <span>正在加载内容…</span>
              </div>
            ) : commitDiff ? (
              commitDiff.error ? (
                <div className="ot-proj-preview-empty">{commitDiff.error}</div>
              ) : (
                <div className="ot-preview-doc">
                  <div className="ot-preview-doc-bar">
                    <div className="ot-preview-doc-meta">
                      <span className="ot-commit-sha">{commitDiff.shortSha}</span>
                      <strong>{commitDiff.subject}</strong>
                    </div>
                    <span className="ot-preview-doc-sub">
                      {commitDiff.author} · {formatRelativeTime(commitDiff.committedAt)} · {commitDiff.files?.length || 0} 个文件
                    </span>
                  </div>
                  {commitDiff.files?.length > 0 && (
                    <div className="ot-commit-files-strip">
                      {commitDiff.files.map(f => (
                        <span key={f.path} className="ot-commit-file-chip">
                          <code>{f.path}</code>
                          <span className="is-add">+{f.additions}</span>
                          <span className="is-del">-{f.deletions}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="ot-preview-code-scroll">
                    <div className="ot-diff-box">{renderDiffLines(commitDiff.patch)}</div>
                  </div>
                </div>
              )
            ) : filePreview ? (
              filePreview.error ? (
                <div className="ot-proj-preview-empty" data-testid="project-file-error" role="status">{filePreview.error}</div>
              ) : (
                <div className="ot-preview-doc">
                  <div className="ot-preview-doc-bar">
                    <div className="ot-preview-doc-meta">
                      <FileText size={14} style={{ color: 'var(--ot-muted)', flex: 'none' }} />
                      <code className="ot-preview-path">{filePreview.path}</code>
                      <span className="ot-preview-size">
                        {formatBytes(filePreview.size)}{filePreview.lineCount ? ` · ${filePreview.lineCount} 行` : ''}
                      </span>
                    </div>
                    <div className="ot-preview-doc-actions">
                      {filePreview.kind === 'markdown' && (
                        <div className="ot-seg">
                          <button type="button" className={`ot-seg-btn ${mdRenderMode === 'rendered' ? 'is-active' : ''}`} onClick={() => setMdRenderMode('rendered')}>
                            <Eye size={12} /> 预览
                          </button>
                          <button type="button" className={`ot-seg-btn ${mdRenderMode === 'source' ? 'is-active' : ''}`} onClick={() => setMdRenderMode('source')}>
                            <Code size={12} /> 源码
                          </button>
                        </div>
                      )}
                      {filePreview.content !== undefined && filePreview.kind !== 'binary' && (
                        <button type="button" className="ot-btn ot-btn--sm" onClick={handleCopyFile}>
                          {copiedFile ? <Check size={12} /> : <Copy size={12} />}
                          <span>{copiedFile ? '已复制' : '复制'}</span>
                        </button>
                      )}
                      {filePreview.kind !== 'binary' && (
                        <button type="button" className="ot-btn ot-btn--sm" onClick={handleDownloadFile}>
                          <DownloadSimple size={12} />
                          <span>下载</span>
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="ot-preview-code-scroll">
                    {filePreview.kind === 'image' && filePreview.dataUrl ? (
                      <div className="ot-preview-image-box">
                        <img src={filePreview.dataUrl} alt={filePreview.path} />
                      </div>
                    ) : filePreview.kind === 'binary' ? (
                      <div className="ot-proj-preview-empty">
                        <div className="ot-preview-empty-badge"><FileText size={24} /></div>
                        <strong>这个文件不支持预览</strong>
                        <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>二进制或超大文件（{formatBytes(filePreview.size)}）</span>
                      </div>
                    ) : filePreview.kind === 'markdown' && mdRenderMode === 'rendered' ? (
                      <div className="ot-md ot-preview-md" dangerouslySetInnerHTML={{ __html: renderedMarkdownHtml }} />
                    ) : (
                      <pre className="ot-code-viewer">
                        {(filePreview.content || '').split('\n').map((ln, idx) => (
                          <div key={idx} className="ot-code-line">
                            <span className="ot-code-ln">{idx + 1}</span>
                            <span className="ot-code-txt">{ln || ' '}</span>
                          </div>
                        ))}
                      </pre>
                    )}
                    {filePreview.truncated && (
                      <div className="ot-preview-trunc">文件超过 512 KB，当前仅展示前 512 KB 内容。</div>
                    )}
                  </div>
                </div>
              )
            ) : (
              /* Exact Empty State matching Todos Screenshot 1 */
              <div className="ot-proj-preview-empty" data-testid="project-file-empty">
                <div className="ot-preview-empty-badge">
                  <FileText size={26} weight="regular" />
                </div>
                <span className="ot-preview-empty-title">请选择一个文件查看</span>
              </div>
            )}
          </main>
        </div>
      ) : (
        /* SUBVIEW 2: PROJECT TASKS TABLE & CARD VIEW (Screenshot 2) */
        <div className="ot-proj-tasks-body" data-testid="project-tasks-view">
          <div className="ot-proj-tasks-toolbar">
            <div className="ot-proj-search-box">
              <MagnifyingGlass size={14} style={{ color: 'var(--ot-muted)', flex: 'none' }} />
              <input
                className="ot-proj-search-input"
                placeholder="搜索任务..."
                value={taskQuery}
                onChange={e => setTaskQuery(e.target.value)}
                onCompositionStart={() => { searchComposingRef.current = true }}
                onCompositionEnd={() => { searchComposingRef.current = false; searchCompEndRef.current = Date.now() }}
                onKeyDown={e => {
                  if (isImeComposingEvent(e, searchComposingRef, searchCompEndRef)) return
                  if (e.key === 'Escape') setTaskQuery('')
                }}
                data-testid="input-project-task-search"
              />
              {taskQuery && (
                <button type="button" className="ot-tree-filter-clear" onClick={() => setTaskQuery('')}>
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Quick "执行中" pill for instant filtering in complex multi-task projects */}
            <button
              type="button"
              className={`ot-proj-tool-btn ${phaseFilter === 'active' ? 'is-active' : ''}`}
              onClick={() => setPhaseFilter(v => (v === 'active' ? 'all' : 'active'))}
              data-testid="btn-filter-running-tasks"
            >
              <span className="ot-dot-live" />
              <span>执行中{activeRunningCount > 0 ? ` (${activeRunningCount})` : ''}</span>
            </button>

            {/* Filter Dropdown */}
            <Popover.Root open={filterOpen} onOpenChange={setFilterOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className={`ot-proj-tool-btn ${activeFilterCount > 0 ? 'is-active' : ''}`}
                  data-testid="btn-project-task-filter"
                >
                  <FunnelSimple size={13} />
                  <span>筛选{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}</span>
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="ot-menu-popover ot-menu-popover--paper ot-proj-filter-pop" align="end" sideOffset={6}>
                  <div className="ot-proj-pop-sec">
                    <div className="ot-proj-pop-label">任务状态</div>
                    <div className="ot-proj-pop-chips">
                      {PHASE_FILTER_OPTIONS.map(([val, lbl]) => (
                        <button
                          key={val}
                          type="button"
                          className={`ot-chip-btn ${phaseFilter === val ? 'is-active' : ''}`}
                          onClick={() => setPhaseFilter(val)}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="ot-proj-pop-sec">
                    <div className="ot-proj-pop-label">任务类型</div>
                    <div className="ot-proj-pop-chips">
                      {[['all', '全部'], ['feature', '功能'], ['bug', '缺陷'], ['question', '调研'], ['deploy', '发布'], ['content', '内容']].map(([val, lbl]) => (
                        <button
                          key={val}
                          type="button"
                          className={`ot-chip-btn ${kindFilter === val ? 'is-active' : ''}`}
                          onClick={() => setKindFilter(val)}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>
                  {agents.length > 0 && (
                    <div className="ot-proj-pop-sec">
                      <div className="ot-proj-pop-label">负责 Agent</div>
                      <select
                        className="ot-select ot-input--sm"
                        value={agentFilter}
                        onChange={e => setAgentFilter(e.target.value)}
                      >
                        <option value="all">全部 Agent</option>
                        {agents.filter(a => a.role !== 'chief').map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      className="ot-btn ot-btn--sm"
                      onClick={() => { setPhaseFilter('all'); setKindFilter('all'); setAgentFilter('all') }}
                    >
                      清空筛选条件
                    </button>
                  )}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {/* Sort Dropdown */}
            <Popover.Root open={sortOpen} onOpenChange={setSortOpen}>
              <Popover.Trigger asChild>
                <button type="button" className="ot-proj-tool-btn" data-testid="btn-project-task-sort">
                  <ArrowsDownUp size={13} />
                  <span>排序</span>
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="ot-menu-popover ot-menu-popover--paper" align="end" sideOffset={6} style={{ width: 200 }}>
                  {SORT_OPTIONS.map(([val, lbl]) => (
                    <button
                      key={val}
                      type="button"
                      className={`ot-menu-item ${sortBy === val ? 'is-active' : ''}`}
                      onClick={() => { setSortBy(val); setSortOpen(false) }}
                    >
                      <span style={{ flex: 1, textAlign: 'left' }}>{lbl}</span>
                      {sortBy === val && <Check size={12} />}
                    </button>
                  ))}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {/* Table vs Card Layout Segmented Toggle (Screenshot 2 right end) */}
            <div className="ot-proj-view-seg is-compact" role="tablist" aria-label="表格或卡片视图">
              <button
                type="button"
                className={`ot-proj-view-btn ${taskLayout === 'table' ? 'is-active' : ''}`}
                onClick={() => setTaskLayout('table')}
                title="表格视图"
                data-testid="btn-layout-table"
              >
                <TableIcon size={14} />
              </button>
              <button
                type="button"
                className={`ot-proj-view-btn ${taskLayout === 'cards' ? 'is-active' : ''}`}
                onClick={() => setTaskLayout('cards')}
                title="卡片视图"
                data-testid="btn-layout-cards"
              >
                <SquaresFour size={14} />
              </button>
            </div>
          </div>

          <div className="ot-proj-tasks-content">
            {filteredTasks.length === 0 ? (
              <div className="ot-proj-tasks-empty" data-testid="project-tasks-empty">
                <p>无符合当前筛选条件的任务。</p>
                <div style={{ display: 'inline-flex', gap: 8, marginTop: 8 }}>
                  {(activeFilterCount > 0 || taskQuery) && (
                    <button
                      type="button"
                      className="ot-btn ot-btn--sm"
                      onClick={() => { setTaskQuery(''); setPhaseFilter('all'); setKindFilter('all'); setAgentFilter('all') }}
                    >
                      重置筛选
                    </button>
                  )}
                  <button type="button" className="ot-btn ot-btn--primary ot-btn--sm" onClick={() => onCreateTask?.(project.id)}>
                    <Plus size={12} /> 新建任务
                  </button>
                </div>
              </div>
            ) : taskLayout === 'table' ? (
              <div className="ot-task-table-wrap" data-testid="project-tasks-table">
                <table className="ot-task-table">
                  <thead>
                    <tr>
                      <th style={{ width: 64 }}>编号</th>
                      <th style={{ width: 130 }}>状态</th>
                      <th>任务标题</th>
                      <th style={{ width: 150 }}>分支</th>
                      <th style={{ width: 136 }}>负责 Agent</th>
                      <th style={{ width: 92 }}>更新</th>
                      <th style={{ width: 108, textAlign: 'right' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTasks.map(td => {
                      const sm = getTodoCardStateMeta(td)
                      const ag = agentById.get(td.agentId)
                      const schCount = scheduleCountByTodo.get(td.id) || 0
                      return (
                        <tr key={td.id} className="ot-task-tr" onClick={() => onOpenTodo?.(td.id)} data-testid={`table-todo-${td.id}`}>
                          <td className="ot-task-td-num">#{td.number}</td>
                          <td>
                            <span className={`ot-state-pill ot-state-pill--${sm.tone}`}>
                              {sm.running && <CircleNotch size={10} className="ot-spin" />}
                              <span>{sm.badge || sm.statusText || '待处理'}</span>
                            </span>
                          </td>
                          <td>
                            <div className="ot-task-td-title-wrap">
                              <span className={`ot-tag ot-tag--${td.phase === 'failed' ? 'bug' : (td.kind || 'feature')}`}>
                                {KIND_LABEL[td.kind] || '功能'}
                              </span>
                              <span className="ot-task-td-title">{td.title}</span>
                              {schCount > 0 && (
                                <span className="ot-sch-mini-tag" title={`已配置 ${schCount} 条定时规则`}>
                                  <Clock size={10} /> 定时
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="ot-task-td-branch">
                            {td.branch ? <code>{td.branch}</code> : <span style={{ color: 'var(--ot-muted)' }}>—</span>}
                          </td>
                          <td>
                            {ag ? (
                              <span className="ot-task-td-agent">
                                <AgentAvatar agent={ag} size={16} />
                                <span>{ag.name}</span>
                              </span>
                            ) : <span style={{ color: 'var(--ot-muted)' }}>未指派</span>}
                          </td>
                          <td className="ot-task-td-time">{formatRelativeTime(td.updatedAt)}</td>
                          <td className="ot-task-td-acts" onClick={e => e.stopPropagation()}>
                            {(td.phase === 'todo' || td.phase === 'failed') && (
                              <button
                                type="button"
                                className="ot-icon-btn"
                                title="启动执行"
                                onClick={() => onStartBuild?.(td.id)}
                              >
                                <Play size={12} weight="fill" />
                              </button>
                            )}
                            <button
                              type="button"
                              className="ot-icon-btn"
                              title="为此任务配置定时运行"
                              onClick={() => onOpenScheduleForTodo?.(td)}
                            >
                              <Clock size={12} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="ot-proj-card-grid" data-testid="project-tasks-cards">
                {filteredTasks.map(td => {
                  const sm = getTodoCardStateMeta(td)
                  const ag = agentById.get(td.agentId)
                  const schCount = scheduleCountByTodo.get(td.id) || 0
                  return (
                    <div
                      key={td.id}
                      className={`ot-proj-card ${sm.running ? 'is-running' : ''}`}
                      onClick={() => onOpenTodo?.(td.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter') onOpenTodo?.(td.id) }}
                    >
                      <div className="ot-proj-card-top">
                        <span className={`ot-state-pill ot-state-pill--${sm.tone}`}>
                          {sm.running && <CircleNotch size={10} className="ot-spin" />}
                          <span>{sm.badge || sm.statusText || '待处理'}</span>
                        </span>
                        <span style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>#{td.number}</span>
                      </div>
                      <div className="ot-proj-card-title">{td.title}</div>
                      <div className="ot-proj-card-meta">
                        <span className={`ot-tag ot-tag--${td.phase === 'failed' ? 'bug' : (td.kind || 'feature')}`}>
                          {KIND_LABEL[td.kind] || '功能'}
                        </span>
                        {td.branch && <code className="ot-proj-card-branch">{td.branch}</code>}
                        {schCount > 0 && <span className="ot-sch-mini-tag"><Clock size={10} /> 定时</span>}
                      </div>
                      <div className="ot-proj-card-foot">
                        {ag ? (
                          <span className="ot-task-td-agent">
                            <AgentAvatar agent={ag} size={16} />
                            <span>{ag.name}</span>
                          </span>
                        ) : <span style={{ color: 'var(--ot-muted)', fontSize: 'var(--ot-fs-xs)' }}>未指派</span>}
                        <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>{formatRelativeTime(td.updatedAt)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

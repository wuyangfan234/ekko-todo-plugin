import React, { memo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import * as Tooltip from '@radix-ui/react-tooltip'
import {
  Plus,
  SidebarSimple,
  CaretDown,
  CaretRight,
  ChatCircle,
  FolderPlus,
  GithubLogo,
  MagnifyingGlass,
  PushPin,
  Archive,
  X,
  Kanban,
  Robot,
  Gauge,
  Clock,
  Keyboard,
  ListMagnifyingGlass,
  GearSix,
  Folders,
  ChatsCircle,
} from '@phosphor-icons/react'
import { formatSidebarAge, getProjectLabel, isImeComposingEvent, isUnattendedTopic } from '../utils.js'
import { ProjectAvatar } from './AvatarKit.jsx'

/**
 * Tooltip for an entry on the folded icon rail: to the right, 8px away, after 200ms. It only opens while the
 * sidebar is a rail; expanded rows show their label instead. The Root stays mounted in both states so toggling
 * does not remount (and unfocus) the button.
 */
function RailTip({ enabled, label, children }) {
  const [open, setOpen] = useState(false)
  return (
    <Tooltip.Root open={enabled && open} onOpenChange={setOpen} delayDuration={200}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="ot-rail-tip" side="right" sideOffset={8} data-testid="rail-tooltip">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

export const Sidebar = memo(function Sidebar({
  projects,
  topics,
  todos,
  schedules = [],
  quotaProviders = [],
  activeView = 'workbench',
  selectedProjectId,
  selectedTopicId,
  inDrawer = false,
  onSelectProject,
  onSelectTopic,
  onRenameTopic,
  onNewTopic,
  onNewTask,
  onAddProject,
  onNewAgent,
  onNewSchedule,
  onOpenQuotaHub,
  onOpenSchedules,
  onOpenTrace,
  onOpenAgents,
  onOpenShortcuts,
  onOpenSettings,
  onOpenCommandPalette,
  onCollapse,
  rail = false,
}) {
  // Desktop only: the drawer (phone / narrow desktop) always shows the full sidebar.
  const isRail = rail && !inDrawer
  const [railMenu, setRailMenu] = useState('')
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [topicsOpen, setTopicsOpen] = useState(true)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [renamingId, setRenamingId] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const renameComposingRef = useRef(false)
  const renameCompEndRef = useRef(0)

  // v0.9.12: topics are independent of the selected repository. Picking a repo opens its workspace and
  // filters the board, but the topic list always shows every topic (a topic may span several repos).
  const liveTopics = topics.filter(t => !t.archived)
  const archivedTopics = topics.filter(t => t.archived)
  const waitingTopics = liveTopics.filter(t => String(t.brief?.waitingOnYou || '').trim()).length
  const deskBtn = inDrawer ? '' : ' ot-rail-btn'
  const tipTitle = text => (isRail ? undefined : text)

  const commitRename = tid => {
    const clean = renameDraft.trim()
    setRenamingId('')
    if (clean) onRenameTopic?.(tid, clean)
  }

  const navGroups = (
      <div className="ot-left-scroll" aria-hidden={isRail || undefined} inert={isRail || undefined}>
        <div>
          <div className="ot-nav-group-head">
            <button
              type="button"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={() => setProjectsOpen(v => !v)}
            >
              {projectsOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}
              <span>项目 {projects.length}</span>
            </button>
            <button
              type="button"
              className="ot-icon-btn"
              onClick={() => onAddProject('github')}
              title="添加项目"
              aria-label="添加项目"
              data-testid="btn-sidebar-add-project"
            >
              <Plus size={13} />
            </button>
          </div>
          {projectsOpen && (
            <div className="ot-nav-list">
              {projects.length === 0 ? (
                <button type="button" className="ot-nav-item" onClick={() => onAddProject('github')}>
                  <span className="ot-nav-item-main">
                    <FolderPlus size={14} />
                    <span className="ot-nav-item-label">导入 GitHub / 本地项目</span>
                  </span>
                </button>
              ) : (
                projects.map(p => {
                  const active = activeView === 'project' && selectedProjectId === p.id
                  const label = getProjectLabel(p)
                  const pendingTodos = todos.filter(td => td.projectId === p.id && td.gateOwner === 'human' && td.phase !== 'done' && td.phase !== 'closed').length
                  const pendingTopicWaits = topics.filter(tp => !tp.archived && tp.projectId === p.id && String(tp.brief?.waitingOnYou || '').trim()).length
                  const pending = pendingTodos + pendingTopicWaits
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`ot-nav-item ${active ? 'is-active' : ''}`}
                      onClick={() => onSelectProject(p.id)}
                      title={p.githubRepo ? `${label} · ${p.githubRepo}（点击进入项目文件与任务视图）` : `${label} · ${p.repoPath}（点击进入项目文件与任务视图）`}
                      data-testid={`project-nav-${p.id}`}
                    >
                      <span className="ot-nav-item-main">
                        <ProjectAvatar project={p} size={18} />
                        <span className="ot-nav-item-label">{label}</span>
                        {p.githubRepo && <GithubLogo size={11} style={{ color: 'var(--ot-muted)', flex: 'none' }} />}
                      </span>
                      {pending > 0 && <span className="ot-nav-item-badge">{pending}</span>}
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>

        <div>
          <div className="ot-nav-group-head">
            <button
              type="button"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={() => setTopicsOpen(v => !v)}
            >
              {topicsOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}
              <span>话题 {liveTopics.length}</span>
            </button>
          </div>
          {topicsOpen && (
            <div className="ot-nav-list">
              {liveTopics.length === 0 ? (
                <div style={{ padding: '6px 8px', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>暂无话题</div>
              ) : (
                liveTopics.map(tp => {
                  const active = tp.id === selectedTopicId
                  const hasWaiting = Boolean(tp.brief?.waitingOnYou)
                  const hasError = Boolean(tp.lastError)
                  if (renamingId === tp.id) {
                    return (
                      <div key={tp.id} style={{ padding: '2px 4px' }}>
                        <input
                          className="ot-input ot-input--sm"
                          value={renameDraft}
                          autoFocus
                          onChange={e => setRenameDraft(e.target.value)}
                          onBlur={() => commitRename(tp.id)}
                          onCompositionStart={() => { renameComposingRef.current = true }}
                          onCompositionEnd={() => { renameComposingRef.current = false; renameCompEndRef.current = Date.now() }}
                          onKeyDown={e => {
                            if (isImeComposingEvent(e, renameComposingRef, renameCompEndRef)) return
                            if (e.key === 'Enter') commitRename(tp.id)
                            else if (e.key === 'Escape') setRenamingId('')
                          }}
                        />
                      </div>
                    )
                  }
                  return (
                    <button
                      key={tp.id}
                      type="button"
                      className={`ot-nav-item ${active ? 'is-active' : ''} ${tp.isRunning ? 'is-topic-running' : ''}`}
                      onClick={() => onSelectTopic(tp.id)}
                      onDoubleClick={() => { setRenamingId(tp.id); setRenameDraft(tp.title) }}
                      title={`${tp.title}${tp.isRunning ? ' · 运行中' : ''}${hasWaiting ? ' · 待你处理' : ''}${hasError ? ' · 上轮出错' : ''}${isUnattendedTopic(tp) ? ' · 无人值守：没有总管会话，任务进展只记录不唤醒' : ''}（双击重命名）`}
                      data-testid={`topic-nav-${tp.id}`}
                    >
                      <span className="ot-nav-item-main">
                        {tp.isRunning ? (
                          <span className="ot-pulse-dot" style={{ width: 7, height: 7 }} />
                        ) : hasError ? (
                          <span className="ot-topic-dot ot-topic-dot--err" title="上轮运行出错" />
                        ) : hasWaiting ? (
                          <span className="ot-topic-dot ot-topic-dot--wait" title="待你处理" />
                        ) : (
                          <ChatCircle size={13} weight="regular" style={{ flex: 'none', opacity: active ? 0.9 : 0.55 }} />
                        )}
                        <span className={`ot-nav-item-label ${hasWaiting ? 'is-bold' : ''}`}>{tp.title}</span>
                      </span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}>
                        {tp.isRunning ? (
                          <span className="ot-nav-running-tag" data-testid={`topic-running-pill-${tp.id}`}>运行中</span>
                        ) : (
                          <>
                            {isUnattendedTopic(tp) && (
                              <span className="ot-nav-unattended-tag" data-testid={`topic-unattended-${tp.id}`} title="本话题没有总管会话：任务进展只记录在这里，不会唤醒总管。发一条消息即可让总管接手。">无人值守</span>
                            )}
                            {tp.pinned && <PushPin size={10} weight="fill" style={{ color: 'var(--ot-muted)' }} />}
                            <span className="ot-nav-item-time">{formatSidebarAge(tp.updatedAt)}</span>
                          </>
                        )}
                      </span>
                    </button>
                  )
                })
              )}

              {archivedTopics.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="ot-nav-item"
                    style={{ height: 28, fontSize: 'var(--ot-fs-xs)' }}
                    onClick={() => setArchivedOpen(v => !v)}
                  >
                    <span className="ot-nav-item-main">
                      <Archive size={12} />
                      <span>已归档 ({archivedTopics.length})</span>
                    </span>
                    {archivedOpen ? <CaretDown size={11} /> : <CaretRight size={11} />}
                  </button>
                  {archivedOpen && archivedTopics.map(tp => (
                    <button
                      key={tp.id}
                      type="button"
                      className={`ot-nav-item ${tp.id === selectedTopicId ? 'is-active' : ''}`}
                      style={{ opacity: 0.72 }}
                      onClick={() => onSelectTopic(tp.id)}
                    >
                      <span className="ot-nav-item-main">
                        <Archive size={12} />
                        <span className="ot-nav-item-label">{tp.title}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
  )

  return (
    <aside
      className={`ot-left ${inDrawer ? 'ot-left--drawer' : 'ot-left--desk'}${isRail ? ' ot-left--rail' : ''}`}
      data-testid={inDrawer ? 'todos-sidebar-drawer' : 'todos-sidebar'}
      data-rail={isRail ? 'true' : undefined}
    >
      <Popover.Root open={createMenuOpen} onOpenChange={setCreateMenuOpen}>
        {inDrawer ? (
          <div className="ot-col-bar">
            <Popover.Trigger asChild>
              <button
                type="button"
                className="ot-new-topic-btn ot-unified-new-btn"
                title="统一新建入口：话题、任务、项目或专属 Agent"
                data-testid="btn-unified-new"
              >
                <Plus size={14} weight="bold" />
                <span>新建</span>
                <CaretDown size={11} style={{ opacity: 0.65, marginLeft: 1 }} />
              </button>
            </Popover.Trigger>

            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <button
                type="button"
                className="ot-icon-btn"
                onClick={onOpenCommandPalette}
                title="快捷命令面板 (⌘K)"
                aria-label="快捷命令面板"
                data-testid="btn-open-cmdk"
              >
                <MagnifyingGlass size={14} weight="regular" />
              </button>
              <button
                type="button"
                className="ot-icon-btn"
                onClick={onCollapse}
                title="关闭侧栏"
                aria-label="关闭侧栏"
              >
                <X size={15} weight="regular" />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="ot-col-bar ot-rail-head">
              <RailTip enabled={isRail} label="展开侧栏 (⌘B)">
                <button
                  type="button"
                  className="ot-rail-btn ot-rail-toggle"
                  onClick={onCollapse}
                  title={tipTitle('收起侧栏 (⌘B)')}
                  aria-label={isRail ? '展开侧栏' : '收起侧栏'}
                  aria-expanded={!isRail}
                  data-testid="btn-sidebar-toggle"
                >
                  <SidebarSimple size={17} weight="regular" />
                </button>
              </RailTip>
              <span className="ot-rail-brand ot-rail-label" aria-hidden={isRail}>Ekko ToDo</span>
            </div>
            <div className="ot-rail-top">
              <RailTip enabled={isRail && !createMenuOpen} label="新建">
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className="ot-rail-btn ot-rail-btn--primary"
                    title={tipTitle('统一新建入口：话题、任务、项目或专属 Agent')}
                    aria-label="新建"
                    data-testid="btn-unified-new"
                  >
                    <Plus size={16} weight="bold" />
                    <span className="ot-rail-label">新建</span>
                    <CaretDown size={11} className="ot-rail-extra" />
                  </button>
                </Popover.Trigger>
              </RailTip>
              <RailTip enabled={isRail} label="搜索 ⌘K">
                <button
                  type="button"
                  className="ot-rail-btn"
                  onClick={onOpenCommandPalette}
                  title={tipTitle('快捷命令面板 (⌘K)')}
                  aria-label="快捷命令面板"
                  data-testid="btn-open-cmdk"
                >
                  <MagnifyingGlass size={16} weight="regular" />
                  <span className="ot-rail-label">搜索</span>
                  <kbd className="ot-kbd ot-rail-extra">⌘K</kbd>
                </button>
              </RailTip>
            </div>
          </>
        )}
        <Popover.Portal>
          <Popover.Content
            className="ot-menu-popover ot-menu-popover--paper ot-unified-new-menu"
            side={isRail ? 'right' : 'bottom'}
            align="start"
            sideOffset={isRail ? 8 : 6}
            data-testid="unified-new-menu"
          >
              <button
                type="button"
                className="ot-menu-item ot-unified-new-item"
                onClick={() => { setCreateMenuOpen(false); onNewTopic?.() }}
                data-testid="btn-new-topic"
              >
                <ChatCircle size={15} weight="duotone" />
                <strong>新建话题</strong>
              </button>
              <button
                type="button"
                className="ot-menu-item ot-unified-new-item"
                onClick={() => { setCreateMenuOpen(false); onNewTask?.() }}
                data-testid="btn-unified-new-task"
              >
                <Kanban size={15} weight="duotone" />
                <strong>新建任务</strong>
              </button>
              <button
                type="button"
                className="ot-menu-item ot-unified-new-item"
                onClick={() => { setCreateMenuOpen(false); onAddProject?.('github') }}
                data-testid="btn-unified-new-project"
              >
                <FolderPlus size={15} weight="duotone" />
                <strong>新建项目</strong>
              </button>
              <button
                type="button"
                className="ot-menu-item ot-unified-new-item"
                onClick={() => { setCreateMenuOpen(false); (onNewAgent ? onNewAgent() : onOpenSettings?.('agents')) }}
                data-testid="btn-unified-new-agent"
              >
                <Robot size={15} weight="duotone" />
                <strong>新建 Agent</strong>
              </button>
              <button
                type="button"
                className="ot-menu-item ot-unified-new-item"
                onClick={() => { setCreateMenuOpen(false); onNewSchedule?.() }}
                data-testid="btn-unified-new-schedule"
              >
                <Clock size={15} weight="duotone" />
                <strong>新建定时</strong>
              </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {inDrawer ? navGroups : (
        <div className="ot-left-mid">
          {navGroups}

          <div className="ot-rail-mid" aria-hidden={!isRail}>
            <Popover.Root open={railMenu === 'projects'} onOpenChange={o => setRailMenu(o ? 'projects' : '')}>
              <RailTip enabled={isRail && railMenu !== 'projects'} label={`项目 ${projects.length}`}>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className={`ot-rail-btn ${activeView === 'project' ? 'is-active' : ''}`}
                    aria-label={`项目（${projects.length}）`}
                    tabIndex={isRail ? 0 : -1}
                    data-testid="btn-rail-projects"
                  >
                    <Folders size={17} weight={activeView === 'project' ? 'duotone' : 'regular'} />
                  </button>
                </Popover.Trigger>
              </RailTip>
              <Popover.Portal>
                <Popover.Content className="ot-menu-popover ot-rail-pop" side="right" align="start" sideOffset={8} data-testid="rail-projects-popover">
                  <div className="ot-rail-pop-head">
                    <span>项目 {projects.length}</span>
                    <button
                      type="button"
                      className="ot-icon-btn"
                      onClick={() => { setRailMenu(''); onAddProject('github') }}
                      title="添加项目"
                      aria-label="添加项目"
                      data-testid="btn-rail-add-project"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  <div className="ot-rail-pop-list">
                    {projects.length === 0 ? (
                      <button type="button" className="ot-menu-item" onClick={() => { setRailMenu(''); onAddProject('github') }}>
                        <FolderPlus size={14} />
                        <span>导入 GitHub / 本地项目</span>
                      </button>
                    ) : projects.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        className={`ot-menu-item ${activeView === 'project' && selectedProjectId === p.id ? 'is-active' : ''}`}
                        onClick={() => { setRailMenu(''); onSelectProject(p.id) }}
                        data-testid={`rail-project-${p.id}`}
                      >
                        <ProjectAvatar project={p} size={18} />
                        <span className="ot-rail-pop-label">{getProjectLabel(p)}</span>
                      </button>
                    ))}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <Popover.Root open={railMenu === 'topics'} onOpenChange={o => setRailMenu(o ? 'topics' : '')}>
              <RailTip enabled={isRail && railMenu !== 'topics'} label={waitingTopics > 0 ? `话题 ${liveTopics.length} · ${waitingTopics} 个待你处理` : `话题 ${liveTopics.length}`}>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className={`ot-rail-btn ${activeView === 'workbench' ? 'is-active' : ''}`}
                    aria-label={waitingTopics > 0 ? `话题（${liveTopics.length}），${waitingTopics} 个待你处理` : `话题（${liveTopics.length}）`}
                    tabIndex={isRail ? 0 : -1}
                    data-testid="btn-rail-topics"
                  >
                    <ChatsCircle size={17} weight={activeView === 'workbench' ? 'duotone' : 'regular'} />
                    {waitingTopics > 0 && <span className="ot-rail-dot" data-testid="rail-topics-waiting-dot" />}
                  </button>
                </Popover.Trigger>
              </RailTip>
              <Popover.Portal>
                <Popover.Content className="ot-menu-popover ot-rail-pop" side="right" align="start" sideOffset={8} data-testid="rail-topics-popover">
                  <div className="ot-rail-pop-head">
                    <span>话题 {liveTopics.length}</span>
                    <button
                      type="button"
                      className="ot-icon-btn"
                      onClick={() => { setRailMenu(''); onNewTopic?.() }}
                      title="新建话题"
                      aria-label="新建话题"
                      data-testid="btn-rail-new-topic"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  <div className="ot-rail-pop-list">
                    {liveTopics.length === 0 ? (
                      <div className="ot-rail-pop-empty">暂无话题</div>
                    ) : liveTopics.map(tp => {
                      const hasWaiting = Boolean(String(tp.brief?.waitingOnYou || '').trim())
                      return (
                        <button
                          key={tp.id}
                          type="button"
                          className={`ot-menu-item ${tp.id === selectedTopicId ? 'is-active' : ''}`}
                          onClick={() => { setRailMenu(''); onSelectTopic(tp.id) }}
                          data-testid={`rail-topic-${tp.id}`}
                        >
                          {tp.isRunning ? (
                            <span className="ot-pulse-dot" style={{ width: 7, height: 7 }} />
                          ) : tp.lastError ? (
                            <span className="ot-topic-dot ot-topic-dot--err" />
                          ) : hasWaiting ? (
                            <span className="ot-topic-dot ot-topic-dot--wait" />
                          ) : (
                            <ChatCircle size={13} weight="regular" style={{ flex: 'none', opacity: 0.55 }} />
                          )}
                          <span className={`ot-rail-pop-label ${hasWaiting ? 'is-bold' : ''}`}>{tp.title}</span>
                          {tp.isRunning
                            ? <span className="ot-nav-running-tag">运行中</span>
                            : <span className="ot-nav-item-time">{formatSidebarAge(tp.updatedAt)}</span>}
                        </button>
                      )
                    })}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </div>
      )}

      <div className={`ot-left-foot ${inDrawer ? 'ot-left-foot--tabs' : ''}`}>
        <RailTip enabled={isRail} label="用量与配额">
          <button
            type="button"
            className={`ot-nav-item${deskBtn} ${activeView === 'hub' ? 'is-active' : ''}`}
            onClick={() => onOpenQuotaHub?.()}
            title={tipTitle('用量与配额（订阅余量、API 余额与 Token 消耗）')}
            aria-label="用量与配额"
            data-testid="btn-open-quota-hub"
          >
            <span className="ot-nav-item-main">
              <Gauge size={inDrawer ? 15 : 16} weight={activeView === 'hub' ? 'duotone' : 'regular'} />
              <span className="ot-nav-item-label" data-short="配额">{inDrawer ? '配额' : '用量与配额'}</span>
            </span>
            {quotaProviders.filter(q => q.enabled).length > 0 && (
              <span className="ot-nav-subtle-pill">{quotaProviders.filter(q => q.enabled).length}</span>
            )}
          </button>
        </RailTip>

        <RailTip enabled={isRail} label="定时任务">
          <button
            type="button"
            className={`ot-nav-item${deskBtn} ${activeView === 'schedules' ? 'is-active' : ''}`}
            onClick={() => onOpenSchedules?.()}
            title={tipTitle('定时任务（按周期或定时自动重跑任务）')}
            aria-label="定时任务"
            data-testid="btn-open-schedules"
          >
            <span className="ot-nav-item-main">
              <Clock size={inDrawer ? 15 : 16} weight={activeView === 'schedules' ? 'duotone' : 'regular'} />
              <span className="ot-nav-item-label" data-short="定时">{inDrawer ? '定时' : '定时任务'}</span>
            </span>
            {schedules.filter(s => s.enabled).length > 0 && (
              <span className="ot-nav-subtle-pill">{schedules.filter(s => s.enabled).length}</span>
            )}
          </button>
        </RailTip>

        <RailTip enabled={isRail} label="运行记录">
          <button
            type="button"
            className={`ot-nav-item${deskBtn} ${activeView === 'trace' ? 'is-active' : ''}`}
            onClick={() => onOpenTrace?.()}
            title={tipTitle('运行记录（模型与工具调用明细）')}
            aria-label="运行记录"
            data-testid="btn-open-trace"
          >
            <span className="ot-nav-item-main">
              <ListMagnifyingGlass size={inDrawer ? 15 : 16} weight={activeView === 'trace' ? 'duotone' : 'regular'} />
              <span className="ot-nav-item-label" data-short="记录">{inDrawer ? '记录' : '运行记录'}</span>
            </span>
          </button>
        </RailTip>

        {onOpenAgents && (
          <RailTip enabled={isRail} label="Agent 配置">
            <button
              type="button"
              className={`ot-nav-item${deskBtn} ${activeView === 'agents' ? 'is-active' : ''}`}
              onClick={() => onOpenAgents()}
              title={tipTitle('Agent 配置（模型、提示词、备选与权限）')}
              aria-label="Agent"
              data-testid="btn-open-agents"
            >
              <span className="ot-nav-item-main">
                <Robot size={inDrawer ? 15 : 16} weight={activeView === 'agents' ? 'duotone' : 'regular'} />
                <span className="ot-nav-item-label">Agent</span>
              </span>
            </button>
          </RailTip>
        )}

        <div className="ot-left-foot-row">
          <RailTip enabled={isRail} label="配置中心 ⌘,">
            <button
              type="button"
              className={`ot-nav-item${deskBtn}`}
              style={inDrawer ? { flex: 1, minWidth: 0 } : undefined}
              onClick={() => onOpenSettings('projects')}
              title={tipTitle('配置中心（项目、总管章程、记忆与运行环境）')}
              aria-label="配置中心"
              data-testid="btn-open-settings"
            >
              <span className="ot-nav-item-main">
                <GearSix size={inDrawer ? 15 : 16} weight="regular" />
                <span className="ot-nav-item-label" data-short="设置">{inDrawer ? '设置' : '配置中心'}</span>
              </span>
              <kbd className="ot-kbd ot-desktop-only">⌘,</kbd>
            </button>
          </RailTip>
          <RailTip enabled={isRail} label="快捷键 ⌘/">
            <button
              type="button"
              className={inDrawer ? 'ot-icon-btn ot-desktop-only' : 'ot-nav-item ot-rail-btn'}
              style={inDrawer ? { flex: 'none' } : undefined}
              onClick={() => onOpenShortcuts?.()}
              title={tipTitle('快捷键 (⌘/)')}
              aria-label="快捷键"
              data-testid="btn-open-shortcuts"
            >
              {inDrawer ? <Keyboard size={14} weight="regular" /> : (
                <>
                  <span className="ot-nav-item-main">
                    <Keyboard size={16} weight="regular" />
                    <span className="ot-nav-item-label">快捷键</span>
                  </span>
                  <kbd className="ot-kbd">⌘/</kbd>
                </>
              )}
            </button>
          </RailTip>
        </div>
      </div>
    </aside>
  )
})

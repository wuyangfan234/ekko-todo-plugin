import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Command } from 'cmdk'
import {
  MagnifyingGlass,
  GitBranch,
  Plus,
  GearSix,
  Brain,
  BookmarkSimple,
  Cpu,
  ChatCircle,
  Kanban,
  GithubLogo,
  Check,
  Compass,
  Gauge,
  Clock,
  Keyboard,
  X,
  ArrowClockwise,
  Notebook,
} from '@phosphor-icons/react'
import { ProjectAvatar } from './AvatarKit.jsx'
import { getProjectLabel, isImeComposingEvent } from '../utils.js'
import { EFFORT_LEVELS, chiefEffortView, effortLabel, isTouchDevice, paletteHints } from '../trust-view.js'
import { isMacPlatform, paletteVimBindings } from '../interaction.js'
import { matchesQuery, normalizeSearchQuery } from '../../shared/search-text.mjs'
import { Highlight, MATCHED_FIELD_LABELS, PHASE_LABELS, groupItems, groupMeta, localWorkspaceSearch, useWorkspaceSearch } from '../workspace-search.jsx'

const MODE_SCOPE = { all: 'all', tasks: 'todos', topics: 'topics' }
const MODE_TITLE = { all: '快捷命令面板', tasks: '搜索任务', topics: '搜索话题' }
const TITLE_FIELDS = new Set(['title_exact', 'title_prefix', 'title', 'title_terms', 'number', 'number_hash', ''])
export const SEARCHED_FIELDS_HINT = '已搜索：标题、#编号、任务书、时间线、Agent 对话、分支、标签、Agent、项目、话题标题与简报、话题对话、记忆。'

/**
 * ⌘K / ⌘P / ⌘J command palette. Since Todo #98 the task / topic / project / memory rows come from the
 * server's search-workspace (every card, every field — no client-side slice before filtering); only the
 * action rows are filtered locally. cmdk's own fuzzy filter is off (shouldFilter={false}): it scores
 * Chinese multi-word queries 0 and would hide server hits.
 */
export function CommandPalette({
  open,
  mode = 'all', // 'all' | 'tasks' | 'topics'
  onOpenChange,
  onSwitchMode,
  state,
  onSearch,
  onSelectProject,
  onSelectTopic,
  onOpenTodo,
  onOpenAddProject,
  onOpenNewTopic,
  onOpenNewTask,
  onOpenNewSchedule,
  onOpenQuotaHub,
  onOpenSchedules,
  onOpenShortcuts,
  onOpenSettingsTab,
  onOpenOnboarding,
  onSetChiefEffort,
  touch,
}) {
  const [input, setInput] = useState('')
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)
  const compEndRef = useRef(0)
  const inputRef = useRef(null)

  useEffect(() => { if (open) setInput('') }, [open, mode])

  const scope = MODE_SCOPE[mode] || 'all'
  const q = normalizeSearchQuery(input)
  const call = useMemo(() => {
    if (typeof onSearch === 'function') return onSearch
    // No host RPC (tests / preview): same rules, over the loaded snapshot.
    return async payload => localWorkspaceSearch(state, payload)
  }, [onSearch, state])
  const search = useWorkspaceSearch(call, {
    query: q ? input : '',
    scope,
    limit: mode === 'all' ? 8 : 50,
    enabled: Boolean(open && state),
    paused: composing,
    allowEmpty: true,
  })

  if (!state) return null

  const chief = (state.agents || []).find(a => a.id === state.settings?.chiefAgentId) || state.agents?.[0]
  const curEffort = String(chief?.reasoningEffort || '').toLowerCase()
  // #101: the level that really runs (cap), and hints without ⌘ on touch screens.
  const effort = chiefEffortView(state.settings, curEffort)
  const isTouch = touch === undefined ? isTouchDevice() : Boolean(touch)
  const hints = paletteHints({ touch: isTouch, mode })

  const runAndClose = fn => () => {
    onOpenChange(false)
    fn?.()
  }

  const actions = mode !== 'all' ? [] : [
    { id: 'new-topic', group: 'ops', icon: <Plus size={14} />, label: '新建总管话题（模型自动命名）', run: onOpenNewTopic },
    { id: 'new-task', group: 'ops', icon: <Kanban size={14} />, label: '新建任务卡片', run: onOpenNewTask },
    onOpenNewSchedule && { id: 'new-schedule', group: 'ops', icon: <Clock size={14} />, label: '新建定时任务', run: onOpenNewSchedule },
    onOpenQuotaHub && { id: 'quota', group: 'ops', icon: <Gauge size={14} />, label: '打开用量与配额（订阅余量 / API 余额）', run: onOpenQuotaHub },
    onOpenSchedules && { id: 'schedules', group: 'ops', icon: <Clock size={14} />, label: '查看全部定时规则', run: onOpenSchedules },
    { id: 'gh-import', group: 'ops', icon: <GithubLogo size={14} />, label: '从 GitHub 导入并关联本地目录', run: () => onOpenAddProject('github') },
    { id: 'local-repo', group: 'ops', icon: <GitBranch size={14} />, label: '添加本地 Git 仓库', run: () => onOpenAddProject('local') },
    onOpenShortcuts && { id: 'shortcuts', group: 'ops', icon: <Keyboard size={14} />, label: isTouch ? '快捷键一览' : '快捷键一览 (⌘/)', run: onOpenShortcuts },
    { id: 'cfg-agents', group: 'config', icon: <Cpu size={14} />, label: 'Agent 管理与主备模型链', run: () => onOpenSettingsTab('agents') },
    { id: 'cfg-chief', group: 'config', icon: <BookmarkSimple size={14} />, label: '总管章程、最高权限与持久记忆', run: () => onOpenSettingsTab('chief') },
    { id: 'cfg-projects', group: 'config', icon: <GearSix size={14} />, label: '项目仓库、别称与 GitHub 授权', run: () => onOpenSettingsTab('projects') },
    onOpenOnboarding && { id: 'onboarding', group: 'config', icon: <Compass size={14} />, label: '运行新手引导与主力大总管向导', run: onOpenOnboarding },
  ].filter(Boolean)
  const shownActions = q ? actions.filter(a => matchesQuery([a.label, a.desc || '', a.keywords || ''], q)) : actions
  const actionGroups = [
    ['ops', '常用操作'],
    ['config', '配置中心'],
  ].map(([id, heading]) => [id, heading, shownActions.filter(a => a.group === id)]).filter(([, , list]) => list.length)
  // Effort levels (#101 wording), filtered locally with the same rule as the other actions.
  const effortItems = mode !== 'all' ? [] : EFFORT_LEVELS
    .filter(([lvl, label, desc]) => !q || matchesQuery([label, desc, `思考等级 推理 effort ${lvl}`], q))

  const result = search.result
  const todos = groupItems(result, 'todos')
  const topics = groupItems(result, 'topics')
  const projects = groupItems(result, 'projects')
  const memories = groupItems(result, 'memories')
  const projectById = new Map((state.projects || []).map(p => [p.id, p]))
  const serverCount = todos.length + topics.length + projects.length + memories.length
  const firstLoad = search.status === 'loading' && !result
  const showEmpty = Boolean(q) && search.status === 'ready' && serverCount === 0 && shownActions.length === 0 && effortItems.length === 0
  const isRecent = Boolean(result?.recent)

  const clear = () => {
    setInput('')
    inputRef.current?.focus()
  }

  const snippetLine = it => {
    if (!q || !it.snippet || TITLE_FIELDS.has(it.matchedField)) return null
    return (
      <span className="ot-cmdk-snippet" data-testid="cmdk-snippet">
        <span className="ot-cmdk-field">{MATCHED_FIELD_LABELS[it.matchedField] || it.matchedField}</span>
        <Highlight text={it.snippet} query={q} />
      </span>
    )
  }

  const moreRow = (type, heading, toMode) => {
    const meta = groupMeta(result, type)
    if (!q || !meta.hasMore || !onSwitchMode || mode !== 'all' || !toMode) return null
    return (
      <Command.Item value={`more:${type}`} className="ot-cmdk-item ot-cmdk-more" onSelect={() => onSwitchMode(toMode)}>
        <MagnifyingGlass size={13} />
        <span>查看全部 {meta.total} 条{heading}</span>
      </Command.Item>
    )
  }

  const groupHeading = (label, type) => {
    const meta = groupMeta(result, type)
    if (isRecent) return `最近${label}`
    return meta.total ? `${label} · ${meta.total}` : label
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-cmdk-modal" aria-label={MODE_TITLE[mode] || MODE_TITLE.all} data-testid="command-palette" data-mode={mode}>
          <Dialog.Title className="ot-sr-only">{MODE_TITLE[mode] || MODE_TITLE.all}</Dialog.Title>
          {/* #100: Ctrl+J/K/N/P list navigation only where Ctrl is not the global modifier (see interaction.js). */}
          <Command
            label="Ekko ToDo 快捷命令"
            vimBindings={paletteVimBindings(isMacPlatform())}
            shouldFilter={false}
            loop
            onKeyDown={e => {
              // Safari sends the IME's confirming Enter right after compositionend: do not select a row with it.
              if (e.key === 'Enter' && !e.nativeEvent?.isComposing && isImeComposingEvent(e, composingRef, compEndRef)) e.preventDefault()
            }}
          >
            <div className="ot-cmdk-input-wrap">
              <MagnifyingGlass size={15} style={{ color: 'var(--ot-text-2)', flex: 'none' }} />
              <Command.Input
                ref={inputRef}
                className="ot-cmdk-input"
                placeholder={hints.placeholder}
                value={input}
                onValueChange={setInput}
                onCompositionStart={() => { composingRef.current = true; setComposing(true) }}
                onCompositionEnd={e => {
                  composingRef.current = false
                  compEndRef.current = Date.now()
                  setComposing(false)
                  setInput(e.currentTarget.value)
                }}
                autoFocus
                data-testid="cmdk-input"
              />
              {search.status === 'loading' && result && <span className="ot-cmdk-busy" aria-live="polite">搜索中…</span>}
              {input && (
                <button type="button" className="ot-cmdk-clear" onClick={clear} aria-label="清空搜索" data-testid="cmdk-clear">
                  <X size={12} />
                </button>
              )}
              {!isTouch && <kbd className="ot-kbd">ESC</kbd>}
            </div>

            <Command.List className="ot-cmdk-list" data-testid="cmdk-list">
              {firstLoad && (
                <div className="ot-cmdk-skeleton" aria-label="正在搜索" data-testid="cmdk-loading">
                  <span /><span /><span />
                </div>
              )}

              {search.status === 'error' && (
                <div className="ot-cmdk-state is-error" role="alert" data-testid="cmdk-error">
                  <div>搜索失败：{search.error}</div>
                  <button type="button" className="ot-btn ot-btn--sm" onClick={search.retry} data-testid="cmdk-retry">
                    <ArrowClockwise size={12} />
                    <span>重试</span>
                  </button>
                </div>
              )}

              {showEmpty && (
                <div className="ot-cmdk-state" data-testid="cmdk-empty">
                  <div className="ot-cmdk-state-title">没有找到“{q}”</div>
                  <div className="ot-cmdk-state-hint">{SEARCHED_FIELDS_HINT}{mode !== 'all' && !isTouch ? ' 也可以按 ⌘K 在全部范围里搜。' : ''}</div>
                  <div className="ot-cmdk-state-hint">下一步：换一个更短的关键词，或直接新建。</div>
                  <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button type="button" className="ot-btn ot-btn--sm ot-btn--primary" onClick={runAndClose(onOpenNewTask)} data-testid="cmdk-empty-new-task">
                      <Plus size={12} />
                      <span>新建任务</span>
                    </button>
                    <button type="button" className="ot-btn ot-btn--sm" onClick={runAndClose(onOpenNewTopic)} data-testid="cmdk-empty-new-topic">
                      <ChatCircle size={12} />
                      <span>对总管说一句目标</span>
                    </button>
                    <button type="button" className="ot-btn ot-btn--sm" onClick={clear} data-testid="cmdk-empty-clear">
                      <X size={12} />
                      <span>清空关键词</span>
                    </button>
                  </span>
                </div>
              )}

              {todos.length > 0 && (
                <Command.Group heading={groupHeading('任务', 'todos')} className="ot-cmdk-group" data-testid="cmdk-group-todos">
                  {todos.map(it => {
                    const p = projectById.get(it.projectId)
                    const projLabel = p ? getProjectLabel(p) : it.projectName
                    return (
                      <Command.Item key={it.id} value={`todo:${it.id}`} className="ot-cmdk-item ot-cmdk-item--result" onSelect={runAndClose(() => onOpenTodo(it.id))} data-testid={`cmdk-todo-${it.number}`}>
                        <span className="ot-cmdk-num">#{it.number}</span>
                        <span className="ot-cmdk-main">
                          <span className="ot-cmdk-title"><Highlight text={it.title} query={q} /></span>
                          {snippetLine(it)}
                        </span>
                        <span className="ot-cmdk-meta">
                          {projLabel && <span className="ot-cmdk-proj">{projLabel}</span>}
                          {it.phase && <span className={`ot-cmdk-phase is-${it.phase}`}>{PHASE_LABELS[it.phase] || it.phase}</span>}
                        </span>
                      </Command.Item>
                    )
                  })}
                  {moreRow('todos', '任务 (⌘P)', 'tasks')}
                </Command.Group>
              )}

              {topics.length > 0 && (
                <Command.Group heading={groupHeading('话题', 'topics')} className="ot-cmdk-group" data-testid="cmdk-group-topics">
                  {topics.map(it => (
                    <Command.Item key={it.id} value={`topic:${it.id}`} className="ot-cmdk-item ot-cmdk-item--result" onSelect={runAndClose(() => onSelectTopic(it.id))} data-testid={`cmdk-topic-${it.id}`}>
                      <ChatCircle size={14} style={{ flex: 'none' }} />
                      <span className="ot-cmdk-main">
                        <span className="ot-cmdk-title"><Highlight text={it.title} query={q} /></span>
                        {snippetLine(it)}
                      </span>
                      <span className="ot-cmdk-meta">
                        {it.projectName && <span className="ot-cmdk-proj">{it.projectName}</span>}
                        {it.archived && <span className="ot-cmdk-phase">已归档</span>}
                      </span>
                    </Command.Item>
                  ))}
                  {moreRow('topics', '话题 (⌘J)', 'topics')}
                </Command.Group>
              )}

              {projects.length > 0 && mode === 'all' && (
                <Command.Group heading={isRecent ? '打开项目工作区（文件 / 分支 / 任务）' : groupHeading('项目', 'projects')} className="ot-cmdk-group" data-testid="cmdk-group-projects">
                  {projects.map(it => {
                    const p = projectById.get(it.id)
                    return (
                      <Command.Item key={it.id} value={`project:${it.id}`} className="ot-cmdk-item ot-cmdk-item--result" onSelect={runAndClose(() => onSelectProject(it.id))}>
                        {p ? <ProjectAvatar project={p} size={18} /> : <GitBranch size={14} />}
                        <span className="ot-cmdk-main">
                          <span className="ot-cmdk-title"><Highlight text={it.title} query={q} /></span>
                          {snippetLine(it)}
                        </span>
                        {p?.githubRepo && <span className="ot-cmdk-sub">{p.githubRepo}</span>}
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              )}

              {memories.length > 0 && mode === 'all' && Boolean(q) && (
                <Command.Group heading={groupHeading('记忆', 'memories')} className="ot-cmdk-group" data-testid="cmdk-group-memories">
                  {memories.map(it => (
                    <Command.Item key={it.id} value={`memory:${it.id}`} className="ot-cmdk-item ot-cmdk-item--result" onSelect={runAndClose(() => onOpenSettingsTab('chief'))}>
                      <Notebook size={14} style={{ flex: 'none' }} />
                      <span className="ot-cmdk-main">
                        <span className="ot-cmdk-title"><Highlight text={it.title} query={q} /></span>
                        {snippetLine(it)}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {actionGroups.filter(([id]) => id === 'ops').map(([id, heading, list]) => (
                <Command.Group key={id} heading={heading} className="ot-cmdk-group">
                  {list.map(a => (
                    <Command.Item key={a.id} value={`action:${a.id}`} className="ot-cmdk-item" onSelect={runAndClose(a.run)}>
                      {a.icon}
                      {a.strong ? <strong style={{ fontWeight: 600 }}><Highlight text={a.label} query={q} /></strong> : <span><Highlight text={a.label} query={q} /></span>}
                      {a.desc && <span className="ot-cmdk-desc">{a.desc}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
              {effortItems.length > 0 && (
                <Command.Group heading={`快速切换总管思考等级 · ${effort.text}`} className="ot-cmdk-group">
                  {effortItems.map(([lvl, label, desc]) => {
                    const picked = curEffort === lvl
                    const inEffect = effort.effective === lvl
                    const over = chiefEffortView(state.settings, lvl).limited
                    return (
                      <Command.Item key={lvl} value={`effort:${lvl}`} className="ot-cmdk-item" onSelect={runAndClose(() => onSetChiefEffort(lvl))} data-testid={`cmdk-effort-${lvl}`}>
                        <Brain size={14} style={{ opacity: picked || inEffect ? 1 : 0.7 }} />
                        <strong style={{ fontWeight: 600 }}><Highlight text={label} query={q} /></strong>
                        <span className="ot-cmdk-desc">{over ? `超出思考上限，选了也只按「${effortLabel(effort.cap)}」运行` : desc}</span>
                        {(picked || inEffect) && (
                          <span className="ot-cmdk-active">
                            <Check size={11} weight="bold" />
                            <span>{picked && inEffect ? '已选 · 生效' : picked ? '已选（未生效）' : '实际生效'}</span>
                          </span>
                        )}
                      </Command.Item>
                    )
                  })}
                  {effort.limited && (
                    <Command.Item className="ot-cmdk-item" onSelect={runAndClose(() => onOpenSettingsTab('chief'))} data-testid="cmdk-effort-cap-link">
                      <GearSix size={14} />
                      <span>修改思考上限（设置 → 总管与章程）</span>
                      <span className="ot-cmdk-desc">{effort.reason}</span>
                    </Command.Item>
                  )}
                </Command.Group>
              )}

              {actionGroups.filter(([id]) => id === 'config').map(([id, heading, list]) => (
                <Command.Group key={id} heading={heading} className="ot-cmdk-group">
                  {list.map(a => (
                    <Command.Item key={a.id} value={`action:${a.id}`} className="ot-cmdk-item" onSelect={runAndClose(a.run)}>
                      {a.icon}
                      {a.strong ? <strong style={{ fontWeight: 600 }}><Highlight text={a.label} query={q} /></strong> : <span><Highlight text={a.label} query={q} /></span>}
                      {a.desc && <span className="ot-cmdk-desc">{a.desc}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>

            <div className="ot-cmdk-foot" data-testid="cmdk-foot">
              {hints.foot.map(text => <span key={text}>{text}</span>)}
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

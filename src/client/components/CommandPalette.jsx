import React from 'react'
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
} from '@phosphor-icons/react'
import { ProjectAvatar } from './AvatarKit.jsx'
import { getProjectLabel } from '../utils.js'

/**
 * Raycast / Linear / Todos-style ⌘K / ⌘P / ⌘J Command Palette backed by `cmdk` + Radix Dialog.
 */
export function CommandPalette({
  open,
  mode = 'all', // 'all' | 'tasks' | 'topics'
  onOpenChange,
  state,
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
}) {
  if (!state) return null

  const chief = (state.agents || []).find(a => a.id === state.settings?.chiefAgentId) || state.agents?.[0]
  const curEffort = String(chief?.reasoningEffort || '').toLowerCase()
  const placeholder = mode === 'tasks'
    ? '搜索任务标题、编号或分支 (⌘P)…'
    : mode === 'topics'
      ? '搜索大总管话题 (⌘J)…'
      : '搜索项目、话题、任务，或执行快捷操作 (⌘K)…'

  const runAndClose = fn => () => {
    onOpenChange(false)
    fn?.()
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-cmdk-modal" aria-label="快捷命令面板" data-testid="command-palette">
          <Dialog.Title className="ot-sr-only">快捷命令面板</Dialog.Title>
          <Command label="Ekko ToDo 快捷命令">
            <div className="ot-cmdk-input-wrap">
              <MagnifyingGlass size={15} style={{ color: 'var(--ot-text-2)', flex: 'none' }} />
              <Command.Input
                className="ot-cmdk-input"
                placeholder={placeholder}
                autoFocus
              />
              <kbd className="ot-kbd">ESC</kbd>
            </div>

            <Command.List className="ot-cmdk-list">
              <Command.Empty className="ot-cmdk-empty">未找到匹配项</Command.Empty>

              {mode === 'all' && (
                <Command.Group heading="常用操作" className="ot-cmdk-group">
                  <Command.Item className="ot-cmdk-item" onSelect={runAndClose(onOpenNewTopic)}>
                    <Plus size={14} />
                    <span>新建总管话题（模型自动命名）</span>
                  </Command.Item>
                  <Command.Item className="ot-cmdk-item" onSelect={runAndClose(onOpenNewTask)}>
                    <Kanban size={14} />
                    <span>新建任务卡片</span>
                  </Command.Item>
                  {onOpenNewSchedule && (
                    <Command.Item className="ot-cmdk-item" onSelect={runAndClose(onOpenNewSchedule)}>
                      <Clock size={14} />
                      <span>新建定时任务</span>
                    </Command.Item>
                  )}
                  {onOpenQuotaHub && (
                    <Command.Item className="ot-cmdk-item" onSelect={runAndClose(onOpenQuotaHub)}>
                      <Gauge size={14} />
                      <span>打开用量与配额（订阅余量 / API 余额）</span>
                    </Command.Item>
                  )}
                  {onOpenSchedules && (
                    <Command.Item className="ot-cmdk-item" onSelect={runAndClose(onOpenSchedules)}>
                      <Clock size={14} />
                      <span>查看全部定时规则</span>
                    </Command.Item>
                  )}
                  <Command.Item className="ot-cmdk-item" onSelect={runAndClose(() => onOpenAddProject('github'))}>
                    <GithubLogo size={14} />
                    <span>从 GitHub 导入并关联本地目录</span>
                  </Command.Item>
                  <Command.Item className="ot-cmdk-item" onSelect={runAndClose(() => onOpenAddProject('local'))}>
                    <GitBranch size={14} />
                    <span>添加本地 Git 仓库</span>
                  </Command.Item>
                  {onOpenShortcuts && (
                    <Command.Item className="ot-cmdk-item" onSelect={runAndClose(onOpenShortcuts)}>
                      <Keyboard size={14} />
                      <span>快捷键一览 (⌘/)</span>
                    </Command.Item>
                  )}
                </Command.Group>
              )}

              {mode === 'all' && (
                <Command.Group heading="快速切换总管思考等级" className="ot-cmdk-group">
                  {[
                    ['low', '低', '快速响应与常规协调'],
                    ['medium', '中', '均衡主力档位'],
                    ['high', '高', '深度推理与复杂拆单'],
                    ['xhigh', '极高', '跨文件架构与严苛审查'],
                    ['max', '最大', '释放模型最高思考预算'],
                  ].map(([lvl, label, desc]) => {
                    const active = curEffort === lvl
                    return (
                      <Command.Item key={lvl} className="ot-cmdk-item" onSelect={runAndClose(() => onSetChiefEffort(lvl))}>
                        <Brain size={14} style={{ opacity: active ? 1 : 0.7 }} />
                        <strong style={{ fontWeight: 600 }}>{label}</strong>
                        <span className="ot-cmdk-desc">{desc}</span>
                        {active && (
                          <span className="ot-cmdk-active">
                            <Check size={11} weight="bold" />
                            <span>当前</span>
                          </span>
                        )}
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              )}

              {mode === 'all' && (
                <Command.Group heading="配置中心" className="ot-cmdk-group">
                  <Command.Item className="ot-cmdk-item" onSelect={runAndClose(() => onOpenSettingsTab('agents'))}>
                    <Cpu size={14} />
                    <span>Agent 管理与主备模型链</span>
                  </Command.Item>
                  <Command.Item className="ot-cmdk-item" onSelect={runAndClose(() => onOpenSettingsTab('chief'))}>
                    <BookmarkSimple size={14} />
                    <span>总管章程、最高权限与持久记忆</span>
                  </Command.Item>
                  <Command.Item className="ot-cmdk-item" onSelect={runAndClose(() => onOpenSettingsTab('projects'))}>
                    <GearSix size={14} />
                    <span>项目仓库、别称与 GitHub 授权</span>
                  </Command.Item>
                  {onOpenOnboarding && (
                    <Command.Item className="ot-cmdk-item" onSelect={runAndClose(onOpenOnboarding)}>
                      <Compass size={14} />
                      <span>运行新手引导与主力大总管向导</span>
                    </Command.Item>
                  )}
                </Command.Group>
              )}

              {mode === 'all' && state.projects.length > 0 && (
                <Command.Group heading="打开项目工作区（文件 / 分支 / 任务）" className="ot-cmdk-group">
                  {state.projects.map(p => (
                    <Command.Item key={p.id} className="ot-cmdk-item" onSelect={runAndClose(() => onSelectProject(p.id))}>
                      <ProjectAvatar project={p} size={18} />
                      <span>{getProjectLabel(p)}</span>
                      {p.githubRepo && <span className="ot-cmdk-sub">{p.githubRepo}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {(mode === 'all' || mode === 'topics') && state.topics.filter(t => !t.archived).length > 0 && (
                <Command.Group heading="切换话题" className="ot-cmdk-group">
                  {state.topics.filter(t => !t.archived).slice(0, mode === 'topics' ? 40 : 10).map(tp => (
                    <Command.Item key={tp.id} className="ot-cmdk-item" onSelect={runAndClose(() => onSelectTopic(tp.id))}>
                      <ChatCircle size={14} />
                      <span>{tp.title}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {(mode === 'all' || mode === 'tasks') && state.todos.length > 0 && (
                <Command.Group heading="打开任务" className="ot-cmdk-group">
                  {state.todos.slice(0, mode === 'tasks' ? 60 : 12).map(td => (
                    <Command.Item key={td.id} className="ot-cmdk-item" onSelect={runAndClose(() => onOpenTodo(td.id))}>
                      <span style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>#{td.number}</span>
                      <span>{td.title}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>

            <div className="ot-cmdk-foot">
              <span>↑↓ 导航</span>
              <span>↵ 执行</span>
              <span>⌘P 任务</span>
              <span>⌘J 话题</span>
              <span>⌘/ 快捷键</span>
              <span>ESC 关闭</span>
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

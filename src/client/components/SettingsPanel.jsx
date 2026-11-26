import React, { useEffect, useMemo, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import * as Switch from '@radix-ui/react-switch'
import * as Slider from '@radix-ui/react-slider'
import * as Collapsible from '@radix-ui/react-collapsible'
import {
  LockSimple,
  Plus,
  Trash,
  FolderOpen,
  Sliders,
  GithubLogo,
  PushPin,
  BookmarkSimple,
  ShieldCheck,
  MagnifyingGlass,
  PencilSimple,
  CaretDown,
  CaretRight,
  CaretUp,
  DownloadSimple,
  Sparkle,
  Scroll,
  ArrowsLeftRight,
  Minus,
  Compass,
  Check,
  CircleNotch,
  Bell,
  SpeakerHigh,
  Keyboard,
} from '@phosphor-icons/react'
import {
  getBrowserNotificationPermission,
  requestBrowserNotificationPermission,
  playNotificationChime,
} from '../notifications.js'
import { ReasoningSlider } from './ReasoningSlider.jsx'
import { AgentManager } from './AgentManager.jsx'
import { AgentAvatar, ProjectAvatar, AvatarPicker } from './AvatarKit.jsx'
import { GithubAuthCard } from './GithubAuthCard.jsx'
import {
  ENGINE_LABEL,
  MEMORY_SCOPE_LABEL,
  MEMORY_CATEGORY_LABEL,
  formatModelShort,
  getProjectLabel,
  getProjectMonogram,
  getAgentRoleLabel,
  isImeComposingEvent,
} from '../utils.js'

const BLANK_MEMORY = {
  id: '',
  scope: 'chief',
  scopeId: '',
  category: 'convention',
  title: '',
  content: '',
  pinned: false,
  enabled: true,
}

export function SettingsContent({
  ctx,
  state,
  busy,
  initialTab = 'projects',
  onAddProject,
  onUpdateProject,
  onDeleteProject,
  onSaveAgent,
  onDeleteAgent,
  onClearAgentCooldowns,
  onSaveSettings,
  onQuickConfigureChief,
  onSaveMemory,
  onDeleteMemory,
  onFetchModelCatalog,
  onFetchHostMemory,
  onRefreshGithubAuth,
  onStartGithubDevice,
  onSaveGithubToken,
  onLogoutGithub,
  onOpenOnboarding,
  onAskChiefCreateAgent,
  onOpenAgents,
  onSyncSessionIsolation,
  onTestNotification,
  onOpenShortcuts,
}) {
  const [tab, setTab] = useState(initialTab)
  const [chiefCatalog, setChiefCatalog] = useState(null)
  const [charterDraft, setCharterDraft] = useState(state.settings?.charter || '')
  const [concurrencyDraft, setConcurrencyDraft] = useState(Number(state.settings?.maxConcurrentBuilds) || 2)
  const [cloneRootDraft, setCloneRootDraft] = useState(state.settings?.defaultCloneRoot || '')
  const [isoModeDraft, setIsoModeDraft] = useState(state.settings?.sessionIsolationMode || 'category')
  const [isoCatDraft, setIsoCatDraft] = useState(state.settings?.sessionCategoryName || 'Ekko ToDo')
  const [syncingIso, setSyncingIso] = useState(false)
  const [editingProjId, setEditingProjId] = useState('')
  const [projDraft, setProjDraft] = useState(null)
  const [confirmDeleteProjId, setConfirmDeleteProjId] = useState('')
  const [hostMemory, setHostMemory] = useState(null)
  const [hostMemOpen, setHostMemOpen] = useState(false)
  const [loadingHostMem, setLoadingHostMem] = useState(false)
  const [memScopeFilter, setMemScopeFilter] = useState('all')
  const [memSearch, setMemSearch] = useState('')
  const [editingMemory, setEditingMemory] = useState(null)

  useEffect(() => { setTab(initialTab) }, [initialTab])
  useEffect(() => { setCharterDraft(state.settings?.charter || '') }, [state.settings?.charter])
  useEffect(() => { setConcurrencyDraft(Number(state.settings?.maxConcurrentBuilds) || 2) }, [state.settings?.maxConcurrentBuilds])
  useEffect(() => { setCloneRootDraft(state.settings?.defaultCloneRoot || '') }, [state.settings?.defaultCloneRoot])
  useEffect(() => { setIsoModeDraft(state.settings?.sessionIsolationMode || 'category') }, [state.settings?.sessionIsolationMode])
  useEffect(() => { setIsoCatDraft(state.settings?.sessionCategoryName || 'Ekko ToDo') }, [state.settings?.sessionCategoryName])

  const commitConcurrency = nextVal => {
    const clamped = Math.max(1, Math.min(8, Math.round(Number(nextVal) || 2)))
    setConcurrencyDraft(clamped)
    if (clamped !== Number(state.settings?.maxConcurrentBuilds)) {
      onSaveSettings({ maxConcurrentBuilds: clamped })
    }
  }

  const startEditProject = p => {
    if (editingProjId === p.id) {
      setEditingProjId('')
      setProjDraft(null)
      return
    }
    setEditingProjId(p.id)
    setProjDraft({
      id: p.id,
      name: p.name || '',
      displayName: p.displayName || '',
      avatar: p.avatar || '',
      accent: p.accent || 'blue',
      defaultBranch: p.defaultBranch || 'main',
      testCommand: p.testCommand || '',
      description: p.description || '',
    })
  }

  const saveProjectProfile = async () => {
    if (!projDraft) return
    await onUpdateProject(projDraft.id, {
      displayName: projDraft.displayName.trim(),
      avatar: projDraft.avatar,
      accent: projDraft.accent,
      defaultBranch: projDraft.defaultBranch.trim() || 'main',
      testCommand: projDraft.testCommand.trim(),
      description: projDraft.description.trim(),
    })
    setEditingProjId('')
    setProjDraft(null)
  }

  const rt = state.runtime || {}
  const liveEngines = useMemo(() => {
    const base = [
      { id: 'hermes', name: 'Hermes Agent', installed: true, version: '宿主原生' },
      ...(rt.liveEngines || []),
    ]
    const seen = new Set()
    return base
      .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true })
      .sort((a, b) => Number(b.installed) - Number(a.installed))
  }, [rt.liveEngines])

  const installedEngineOptions = liveEngines.filter(e => e.installed)

  const chiefAgent = useMemo(() => {
    const list = state.agents || []
    return list.find(a => a.id === state.settings?.chiefAgentId)
      || list.find(a => a.role === 'chief')
      || list[0]
      || null
  }, [state.agents, state.settings?.chiefAgentId])

  useEffect(() => {
    if (tab !== 'chief' || !chiefAgent?.engine) return
    let active = true
    Promise.resolve(onFetchModelCatalog?.(chiefAgent.engine, false))
      .then(res => { if (active) setChiefCatalog(res || null) })
      .catch(() => {})
    return () => { active = false }
  }, [tab, chiefAgent?.engine, onFetchModelCatalog])

  const chiefCatalogModel = useMemo(() => {
    if (!chiefAgent || !chiefCatalog?.models?.length) return null
    return chiefCatalog.models.find(
      m => m.id === chiefAgent.model && (!chiefAgent.provider || !m.provider || m.provider === chiefAgent.provider),
    ) || chiefCatalog.models.find(m => m.isDefault) || null
  }, [chiefAgent, chiefCatalog])

  const pickCloneRoot = async () => {
    try {
      const picked = await ctx.ui?.selectWorkspace?.({ current: state.settings?.defaultCloneRoot || '' })
      if (picked?.workspace) onSaveSettings({ defaultCloneRoot: picked.workspace })
    } catch (err) {
      ctx.ui?.notify?.(err?.message || '目录选择器不可用', 'error')
    }
  }

  const loadHostMemoryNow = async () => {
    setLoadingHostMem(true)
    try {
      const res = await onFetchHostMemory?.()
      setHostMemory(res || { available: false, memory: '', user: '', soul: '', entryCount: 0 })
    } finally {
      setLoadingHostMem(false)
    }
  }

  const filteredMemories = useMemo(() => {
    const q = memSearch.trim().toLowerCase()
    return (state.memories || []).filter(mem => {
      if (memScopeFilter !== 'all' && mem.scope !== memScopeFilter) return false
      if (q && !mem.title.toLowerCase().includes(q) && !mem.content.toLowerCase().includes(q)) return false
      return true
    })
  }, [state.memories, memScopeFilter, memSearch])

  const auth = state.settings?.chiefAuthority || {}
  const workers = (state.agents || []).filter(a => a.role !== 'chief')
  const chiefFallbackCount = Math.max(0, (chiefAgent?.modelConfigs?.length || 1) - 1)

  return (
    <Tabs.Root value={tab} onValueChange={setTab} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <Tabs.List className="ot-tabs-list">
        <Tabs.Trigger value="projects" className="ot-tabs-trigger" data-testid="settings-tab-projects">项目仓库</Tabs.Trigger>
        {!onOpenAgents && <Tabs.Trigger value="agents" className="ot-tabs-trigger" data-testid="settings-tab-agents">Agent 管理</Tabs.Trigger>}
        <Tabs.Trigger value="chief" className="ot-tabs-trigger" data-testid="settings-tab-chief">总管与章程</Tabs.Trigger>
        <Tabs.Trigger value="runtime" className="ot-tabs-trigger" data-testid="settings-tab-runtime">运行环境</Tabs.Trigger>
      </Tabs.List>

      {/* ===== TAB 1: PROJECTS & GITHUB ===== */}
      <Tabs.Content value="projects" className="ot-dialog-body">
        <GithubAuthCard
          compact
          status={rt.githubCli}
          onRefreshStatus={onRefreshGithubAuth}
          onStartDeviceLogin={onStartGithubDevice}
          onSaveToken={onSaveGithubToken}
          onLogout={onLogoutGithub}
        />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 'var(--ot-fs-sm)', color: 'var(--ot-text-2)' }}>
            共 {state.projects.length} 个项目
          </span>
          <div style={{ display: 'inline-flex', gap: 6 }}>
            <button
              type="button"
              className="ot-btn ot-btn--primary"
              onClick={() => onAddProject('github')}
              data-testid="btn-settings-import-github"
            >
              <GithubLogo size={14} weight="bold" />
              <span>从 GitHub 导入</span>
            </button>
            <button
              type="button"
              className="ot-btn"
              onClick={() => onAddProject('local')}
              data-testid="btn-settings-add-project"
            >
              <Plus size={13} />
              <span>添加本地项目</span>
            </button>
          </div>
        </div>

        {state.projects.length === 0 ? (
          <div className="ot-setting-card" style={{ alignItems: 'center', textAlign: 'center', padding: '26px 18px' }}>
            <FolderOpen size={22} style={{ color: 'var(--ot-muted)' }} />
            <div style={{ fontSize: 'var(--ot-fs-sm)', fontWeight: 500 }}>尚未关联项目</div>
            <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)', maxWidth: 380 }}>
              可导入 GitHub 或关联本地仓库；非开发任务可直接使用。
            </div>
          </div>
        ) : (
          state.projects.map(p => {
            const label = getProjectLabel(p)
            const isEditing = editingProjId === p.id && projDraft
            const confirmDel = confirmDeleteProjId === p.id
            return (
              <div key={p.id} className="ot-setting-card" data-testid={`settings-project-${p.id}`}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0, flexWrap: 'wrap' }}>
                    <ProjectAvatar project={p} size={26} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>{label}</strong>
                        {p.displayName && p.displayName !== p.name && (
                          <span className="ot-pill-mono" title="原始仓库名称">{p.name}</span>
                        )}
                        {p.githubRepo && (
                          <span className="ot-gh-badge">
                            <GithubLogo size={11} />
                            <span>{p.githubRepo}</span>
                            {p.isPrivate && <LockSimple size={10} />}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>{p.defaultBranch}</span>
                    <button
                      type="button"
                      className={`ot-btn ot-btn--sm ${isEditing ? 'ot-btn--primary' : ''}`}
                      style={{ height: 26, padding: '0 8px', fontSize: 'var(--ot-fs-xs)' }}
                      onClick={() => startEditProject(p)}
                      data-testid={`btn-edit-project-${p.id}`}
                    >
                      {isEditing ? <CaretUp size={12} /> : <PencilSimple size={12} />}
                      <span>{isEditing ? '收起' : '编辑别称/头像'}</span>
                    </button>
                    {confirmDel ? (
                      <div style={{ display: 'inline-flex', gap: 4 }}>
                        <button
                          type="button"
                          className="ot-btn ot-btn--sm ot-btn--danger"
                          style={{ height: 26, padding: '0 8px', fontSize: 'var(--ot-fs-xs)' }}
                          onClick={() => { setConfirmDeleteProjId(''); onDeleteProject(p.id) }}
                          title="同时删除该项目的任务和定时，并停止正在运行的构建；仓库里的分支不动"
                        >
                          确认移除（含任务与定时）
                        </button>
                        <button
                          type="button"
                          className="ot-btn ot-btn--sm"
                          style={{ height: 26, padding: '0 7px', fontSize: 'var(--ot-fs-xs)' }}
                          onClick={() => setConfirmDeleteProjId('')}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="ot-icon-btn"
                        title="移除项目（不删除磁盘文件）"
                        onClick={() => setConfirmDeleteProjId(p.id)}
                      >
                        <Trash size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {isEditing && (
                  <div className="ot-agent-editor" data-testid={`project-editor-${p.id}`}>
                    <AvatarPicker
                      mode="project"
                      compact
                      value={projDraft.avatar}
                      accent={projDraft.accent}
                      monogram={getProjectMonogram({ displayName: projDraft.displayName, name: projDraft.name })}
                      onChange={val => setProjDraft({ ...projDraft, avatar: val })}
                      onAccentChange={acc => setProjDraft({ ...projDraft, accent: acc })}
                    />
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 8 }}>
                      <label className="ot-field-label">
                        <span>显示别称（如：星海官网，留空显示原仓库名）</span>
                        <input
                          className="ot-input ot-input--sm"
                          value={projDraft.displayName}
                          onChange={e => setProjDraft({ ...projDraft, displayName: e.target.value })}
                          placeholder={`例如：${p.name} 的中文别称`}
                          data-testid={`input-project-alias-${p.id}`}
                        />
                      </label>
                      <label className="ot-field-label">
                        <span>默认分支</span>
                        <input
                          className="ot-input ot-input--sm"
                          value={projDraft.defaultBranch}
                          onChange={e => setProjDraft({ ...projDraft, defaultBranch: e.target.value })}
                        />
                      </label>
                    </div>
                    <label className="ot-field-label">
                      <span>验收命令（可选，构建后运行）</span>
                      <input
                        className="ot-input ot-input--sm"
                        value={projDraft.testCommand}
                        onChange={e => setProjDraft({ ...projDraft, testCommand: e.target.value })}
                        placeholder="例如：npm test"
                      />
                    </label>
                    <label className="ot-field-label">
                      <span>项目简介（可选）</span>
                      <input
                        className="ot-input ot-input--sm"
                        value={projDraft.description}
                        onChange={e => setProjDraft({ ...projDraft, description: e.target.value })}
                        placeholder="一句话说明项目定位"
                      />
                    </label>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                      <button type="button" className="ot-btn ot-btn--sm" onClick={() => { setEditingProjId(''); setProjDraft(null) }}>取消</button>
                      <button
                        type="button"
                        className="ot-btn ot-btn--sm ot-btn--primary"
                        disabled={busy}
                        onClick={saveProjectProfile}
                        data-testid={`btn-save-project-${p.id}`}
                      >
                        <Check size={12} />
                        <span>保存项目信息</span>
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)', wordBreak: 'break-all' }}>
                  本地目录：{p.repoPath}
                </div>
                {p.testCommand && !isEditing && (
                  <div style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                    自动验收：{p.testCommand}
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, paddingTop: 4 }}>
                  <label className="ot-field-label">
                    <span>默认执行 Agent</span>
                    <select
                      className="ot-input ot-input--sm"
                      disabled={busy}
                      value={p.ownerAgentId || ''}
                      onChange={e => onUpdateProject(p.id, { ownerAgentId: e.target.value })}
                    >
                      {workers.map(a => (
                        <option key={a.id} value={a.id}>{a.name} · {getAgentRoleLabel(a)} ({ENGINE_LABEL[a.engine] || a.engine})</option>
                      ))}
                    </select>
                  </label>
                  <label className="ot-field-label">
                    <span>默认审查 Agent</span>
                    <select
                      className="ot-input ot-input--sm"
                      disabled={busy}
                      value={p.reviewerAgentId || ''}
                      onChange={e => onUpdateProject(p.id, { reviewerAgentId: e.target.value })}
                    >
                      <option value="">自动跨引擎挑选</option>
                      {workers.map(a => (
                        <option key={a.id} value={a.id}>{a.name} · {getAgentRoleLabel(a)} ({ENGINE_LABEL[a.engine] || a.engine})</option>
                      ))}
                    </select>
                  </label>
                </div>

                {[
                  ['autoDispatch', '允许总管自动派工'],
                  ['autoAnswerRoutine', '允许总管代答待确认问题'],
                  ['autoMergeAfterReview', '审查与验收通过后允许总管合并'],
                ].map(([field, txt]) => (
                  <div key={field} className="ot-setting-row">
                    <span>{txt}</span>
                    <Switch.Root
                      className="ot-switch"
                      disabled={busy}
                      checked={Boolean(p.autopilot[field])}
                      onCheckedChange={checked => onUpdateProject(p.id, { autopilot: { ...p.autopilot, [field]: checked } })}
                    >
                      <Switch.Thumb className="ot-switch-thumb" />
                    </Switch.Root>
                  </div>
                ))}

                <div className="ot-setting-row" style={{ color: 'var(--ot-text-2)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <LockSimple size={13} />
                    <span>部署任务永久人工确认</span>
                  </span>
                  <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>已锁定</span>
                </div>
              </div>
            )
          })
        )}
      </Tabs.Content>

      {/* ===== TAB 2: MASTER-DETAIL ENGINEERING AGENT MANAGER ===== */}
      <Tabs.Content value="agents" className="ot-dialog-body" style={{ paddingTop: 12 }}>
        {onOpenAgents ? (
          <div className="ot-setting-card ot-agents-moved" data-testid="settings-agents-moved">
            <strong>Agent 配置已移到独立页面</strong>
            <span>空间更大，列表和编辑区并排显示。左侧栏「Agent」也能进入。</span>
            <button type="button" className="ot-btn ot-btn--indigo" onClick={() => onOpenAgents()} data-testid="btn-settings-open-agents">
              打开 Agent 配置
            </button>
          </div>
        ) : (
        <AgentManager
          ctx={ctx}
          state={state}
          liveEngines={liveEngines}
          installedEngineOptions={installedEngineOptions}
          busy={busy}
          onSaveAgent={onSaveAgent}
          onDeleteAgent={onDeleteAgent}
          onClearCooldowns={onClearAgentCooldowns}
          onFetchModelCatalog={onFetchModelCatalog}
          onAskChiefCreateAgent={onAskChiefCreateAgent}
        />
        )}
      </Tabs.Content>

      {/* ===== TAB 3: CHIEF, CHARTER, AUTHORITY & MEMORY ===== */}
      <Tabs.Content value="chief" className="ot-dialog-body">
        {chiefAgent && (
          <div className="ot-setting-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <AgentAvatar agent={chiefAgent} size={22} />
                <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>大总管核心模型与思考等级</strong>
                <span className={chiefFallbackCount > 0 ? 'ot-fb-count' : 'ot-pill-soft'} data-testid="chief-fallback-badge">
                  <ArrowsLeftRight size={10} />
                  <span>{chiefFallbackCount > 0 ? `已配 ${chiefFallbackCount} 套备选` : '未配备选'}</span>
                </span>
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <select
                  className="ot-input ot-input--sm"
                  style={{ width: 180 }}
                  value={chiefAgent.id}
                  onChange={e => onQuickConfigureChief({ chiefAgentId: e.target.value })}
                >
                  {state.agents.map(a => (
                    <option key={a.id} value={a.id}>{a.name} ({ENGINE_LABEL[a.engine] || a.engine})</option>
                  ))}
                </select>
                <button type="button" className="ot-btn ot-btn--sm" onClick={() => setTab('agents')}>
                  配主备链
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end' }}>
              <label className="ot-field-label">
                <span>总管首选模型</span>
                <select
                  className="ot-input ot-input--sm"
                  value={chiefAgent.model ? `${chiefAgent.provider || ''}::${chiefAgent.model}` : ''}
                  onChange={e => {
                    const val = e.target.value
                    if (!val) { onQuickConfigureChief({ provider: '', model: '', customModel: false }); return }
                    const sep = val.indexOf('::')
                    onQuickConfigureChief({
                      provider: sep >= 0 ? val.slice(0, sep) : '',
                      model: sep >= 0 ? val.slice(sep + 2) : val,
                      customModel: false,
                    })
                  }}
                >
                  <option value="">
                    使用引擎默认{chiefCatalog?.defaultModel ? `（${formatModelShort(chiefCatalog.defaultModel)}）` : ''}
                  </option>
                  {(chiefCatalog?.models || []).slice(0, 100).map(m => (
                    <option key={`${m.provider || ''}::${m.id}`} value={`${m.provider || ''}::${m.id}`}>
                      {m.providerLabel && m.providerLabel !== chiefAgent.engine ? `[${m.providerLabel}] ` : ''}{m.name || m.id}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ot-btn ot-btn--sm"
                onClick={async () => {
                  const picked = await ctx.ui?.selectModel?.({
                    current: chiefAgent.model ? { provider: chiefAgent.provider || '', model: chiefAgent.model } : undefined,
                  }).catch(() => null)
                  if (picked) {
                    onQuickConfigureChief({
                      provider: picked.provider || '',
                      model: picked.model || '',
                      apiMode: picked.apiMode || '',
                      customModel: false,
                      mode: 'scoped',
                    })
                  }
                }}
              >
                <Sliders size={12} />
                <span>原生选型</span>
              </button>
            </div>

            <ReasoningSlider
              compact
              value={chiefAgent.reasoningEffort || ''}
              supportedEfforts={chiefCatalogModel?.reasoningEfforts || []}
              testId="settings-chief-effort-slider"
              onChange={nextEffort => onQuickConfigureChief({ reasoningEffort: nextEffort })}
            />
          </div>
        )}

        {/* Chief Strict Orchestration Boundary */}
        <div className="ot-setting-card" data-testid="chief-strict-orchestration-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <LockSimple size={15} weight="duotone" style={{ color: 'var(--ot-dot-confirm)' }} />
                <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>总管不直接改代码</strong>
              </div>
              <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                总管只理解需求、写任务书、派工和验收，读项目资料不限次数。它若自己改文件、跑命令或开子代理，会在对话里提醒你，但不会中止这一轮。
              </div>
            </div>
            <Switch.Root
              className="ot-switch"
              checked={state.settings?.chiefStrictOrchestration !== false}
              onCheckedChange={checked => onSaveSettings({ chiefStrictOrchestration: checked })}
              data-testid="switch-chief-strict-orchestration"
            >
              <Switch.Thumb className="ot-switch-thumb" />
            </Switch.Root>
          </div>
          {state.settings?.chiefStrictOrchestration !== false && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }} data-testid="chief-guard-limits">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                思考上限
                <select
                  className="ot-input ot-input--sm"
                  style={{ width: 'auto' }}
                  value={state.settings?.chiefEffortCap ?? 'medium'}
                  onChange={e => onSaveSettings({ chiefEffortCap: e.target.value })}
                  data-testid="select-chief-effort-cap"
                >
                  <option value="low">低</option>
                  <option value="medium">中（推荐）</option>
                  <option value="high">高</option>
                  <option value="xhigh">极高</option>
                  <option value="">不限制</option>
                </select>
              </label>
            </div>
          )}
        </div>

        {/* Standing Charter */}
        <div className="ot-setting-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Scroll size={15} weight="duotone" />
              <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>总管章程</strong>
            </div>
            <button
              type="button"
              className="ot-btn ot-btn--sm ot-btn--primary"
              disabled={charterDraft === (state.settings?.charter || '')}
              onClick={() => onQuickConfigureChief({ charter: charterDraft })}
              data-testid="btn-save-charter"
            >
              保存
            </button>
          </div>
          <textarea
            className="ot-input ot-textarea-v"
            rows={3}
            placeholder="填写团队规则、分工偏好或发布纪律（可选）"
            value={charterDraft}
            onChange={e => setCharterDraft(e.target.value)}
            data-testid="input-chief-charter"
          />
        </div>

        {/* Chief Super-Admin Authority Matrix */}
        <div className="ot-setting-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <ShieldCheck size={15} weight="duotone" />
            <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>总管权限</strong>
          </div>
          <div className="ot-auth-matrix-grid">
            {[
              ['canConfigureAgents', '管理 Agent', '增删改成员配置'],
              ['canSwitchModels', '切换模型与思考等级', '按需调整模型档位'],
              ['canManageMemories', '读写持久记忆', '记录规范与偏好'],
              ['canManageProjects', '管理项目与策略', '导入仓库与设置'],
              ['canAdjustConcurrency', '调整并发上限', '1–8 槽并发控制'],
              ['injectHostMemory', '参考宿主记忆', '只读同步偏好'],
            ].map(([key, title, desc]) => (
              <div key={key} className="ot-auth-matrix-cell">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 500 }}>{title}</div>
                  <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>{desc}</div>
                </div>
                <Switch.Root
                  className="ot-switch"
                  checked={auth[key] !== false}
                  onCheckedChange={checked => onQuickConfigureChief({ chiefAuthority: { [key]: checked } })}
                >
                  <Switch.Thumb className="ot-switch-thumb" />
                </Switch.Root>
              </div>
            ))}
          </div>
        </div>

        {/* Structured Persistent Memory Store */}
        <div className="ot-setting-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <BookmarkSimple size={15} weight="duotone" />
              <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>持久记忆库（{(state.memories || []).length} 条）</strong>
            </div>
            <button
              type="button"
              className="ot-btn ot-btn--primary ot-btn--sm"
              data-testid="btn-add-memory"
              onClick={() => setEditingMemory({ ...BLANK_MEMORY })}
            >
              <Plus size={12} />
              <span>新增记忆</span>
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="ot-seg">
              {[
                ['all', '全部'],
                ['chief', '总管全局'],
                ['project', '项目专属'],
                ['agent', 'Agent 专属'],
              ].map(([sc, lbl]) => (
                <button
                  key={sc}
                  type="button"
                  className={`ot-seg-btn ${memScopeFilter === sc ? 'is-active' : ''}`}
                  onClick={() => setMemScopeFilter(sc)}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <div style={{ position: 'relative', flex: 1, minWidth: 160 }}>
              <MagnifyingGlass size={13} style={{ position: 'absolute', left: 9, top: 8, color: 'var(--ot-muted)' }} />
              <input
                className="ot-input ot-input--sm"
                style={{ paddingLeft: 28 }}
                placeholder="搜索记忆标题或正文..."
                value={memSearch}
                onChange={e => setMemSearch(e.target.value)}
              />
            </div>
          </div>

          {editingMemory && (
            <div className="ot-agent-editor" data-testid="memory-editor-form">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <label className="ot-field-label">
                  <span>作用域</span>
                  <select
                    className="ot-input ot-input--sm"
                    value={editingMemory.scope}
                    onChange={e => setEditingMemory({ ...editingMemory, scope: e.target.value, scopeId: '' })}
                  >
                    {Object.entries(MEMORY_SCOPE_LABEL).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
                  </select>
                </label>
                <label className="ot-field-label">
                  <span>分类</span>
                  <select
                    className="ot-input ot-input--sm"
                    value={editingMemory.category}
                    onChange={e => setEditingMemory({ ...editingMemory, category: e.target.value })}
                  >
                    {Object.entries(MEMORY_CATEGORY_LABEL).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
                  </select>
                </label>
                {editingMemory.scope === 'project' ? (
                  <label className="ot-field-label">
                    <span>归属项目</span>
                    <select
                      className="ot-input ot-input--sm"
                      value={editingMemory.scopeId}
                      onChange={e => setEditingMemory({ ...editingMemory, scopeId: e.target.value })}
                    >
                      <option value="">所有项目</option>
                      {state.projects.map(p => <option key={p.id} value={p.id}>{getProjectLabel(p)}</option>)}
                    </select>
                  </label>
                ) : editingMemory.scope === 'agent' ? (
                  <label className="ot-field-label">
                    <span>归属 Agent</span>
                    <select
                      className="ot-input ot-input--sm"
                      value={editingMemory.scopeId}
                      onChange={e => setEditingMemory({ ...editingMemory, scopeId: e.target.value })}
                    >
                      <option value="">请选择 Agent</option>
                      {state.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </label>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--ot-fs-xs)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(editingMemory.pinned)}
                        onChange={e => setEditingMemory({ ...editingMemory, pinned: e.target.checked })}
                      />
                      <span>置顶优先注入</span>
                    </label>
                  </div>
                )}
              </div>

              <input
                className="ot-input"
                placeholder="记忆标题"
                value={editingMemory.title}
                onChange={e => setEditingMemory({ ...editingMemory, title: e.target.value })}
                data-testid="input-memory-title"
              />
              <textarea
                className="ot-input"
                rows={3}
                placeholder="需要长期记住的规则或偏好..."
                value={editingMemory.content}
                onChange={e => setEditingMemory({ ...editingMemory, content: e.target.value })}
                data-testid="input-memory-content"
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                <button type="button" className="ot-btn ot-btn--sm" onClick={() => setEditingMemory(null)}>取消</button>
                <button
                  type="button"
                  className="ot-btn ot-btn--sm ot-btn--primary"
                  disabled={!editingMemory.title.trim() || !editingMemory.content.trim() || busy}
                  data-testid="btn-save-memory"
                  onClick={() => { onSaveMemory(editingMemory); setEditingMemory(null) }}
                >
                  保存记忆
                </button>
              </div>
            </div>
          )}

          {filteredMemories.length === 0 ? (
            <div style={{ padding: '12px 0', textAlign: 'center', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
              暂无记忆
            </div>
          ) : (
            filteredMemories.map(mem => (
              <div key={mem.id} className={`ot-mem-item ${mem.enabled ? '' : 'is-disabled'}`}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {mem.pinned && <PushPin size={12} weight="fill" style={{ color: 'var(--ot-dot-confirm)' }} />}
                    <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>{mem.title}</strong>
                    <span className="ot-pill-soft">{MEMORY_SCOPE_LABEL[mem.scope] || mem.scope}</span>
                    <span className="ot-pill-soft">{MEMORY_CATEGORY_LABEL[mem.category] || mem.category}</span>
                    {mem.source === 'chief' && <span className="ot-pill-mono">总管沉淀</span>}
                  </div>
                  <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)', marginTop: 3, whiteSpace: 'pre-wrap' }}>
                    {mem.content}
                  </div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}>
                  <button
                    type="button"
                    className={`ot-icon-btn ${mem.pinned ? 'is-active' : ''}`}
                    title={mem.pinned ? '取消置顶' : '置顶优先注入'}
                    onClick={() => onSaveMemory({ ...mem, pinned: !mem.pinned })}
                  >
                    <PushPin size={12} weight={mem.pinned ? 'fill' : 'regular'} />
                  </button>
                  <Switch.Root
                    className="ot-switch"
                    checked={mem.enabled}
                    onCheckedChange={checked => onSaveMemory({ ...mem, enabled: checked })}
                  >
                    <Switch.Thumb className="ot-switch-thumb" />
                  </Switch.Root>
                  <button
                    type="button"
                    className="ot-icon-btn"
                    title="编辑记忆"
                    onClick={() => setEditingMemory({ ...mem })}
                  >
                    <PencilSimple size={12} />
                  </button>
                  <button
                    type="button"
                    className="ot-icon-btn"
                    title="删除记忆"
                    onClick={() => onDeleteMemory(mem.id)}
                  >
                    <Trash size={12} />
                  </button>
                </div>
              </div>
            ))
          )}

          <Collapsible.Root
            open={hostMemOpen}
            onOpenChange={v => { setHostMemOpen(v); if (v && !hostMemory) void loadHostMemoryNow() }}
            style={{ borderTop: '1px solid var(--ot-border-soft)', paddingTop: 10 }}
          >
            <Collapsible.Trigger asChild>
              <button type="button" className="ot-thinking-trigger" style={{ padding: '4px 2px' }}>
                <span className="ot-thinking-left">
                  <DownloadSimple size={13} />
                  <span>宿主 Hermes 记忆桥接参考（只读）</span>
                  {hostMemory?.available && <span className="ot-thinking-meta">共 {hostMemory.entryCount} 条</span>}
                </span>
                {hostMemOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
              </button>
            </Collapsible.Trigger>
            <Collapsible.Content style={{ paddingTop: 8 }}>
              {loadingHostMem ? (
                <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>正在读取宿主记忆摘要...</div>
              ) : !hostMemory?.available ? (
                <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>仅使用本插件记忆库</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <pre className="ot-pre" style={{ maxHeight: 160, overflowY: 'auto', fontSize: 'var(--ot-fs-xs)' }}>
                    {hostMemory.memory ? hostMemory.memory.slice(0, 1600) : '（宿主记忆为空）'}
                  </pre>
                  {hostMemory.memory && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="ot-btn ot-btn--sm"
                        onClick={() => onSaveMemory({
                          scope: 'chief',
                          scopeId: '',
                          category: 'preference',
                          title: '宿主核心记忆摘录',
                          content: hostMemory.memory.slice(0, 1200),
                          pinned: false,
                          enabled: true,
                          source: 'host-import',
                        })}
                      >
                        <DownloadSimple size={12} />
                        <span>摘录导入到总管记忆库</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </Collapsible.Content>
          </Collapsible.Root>
        </div>
      </Tabs.Content>

      {/* ===== TAB 4: RUNTIME & CONCURRENCY ===== */}
      <Tabs.Content value="runtime" className="ot-dialog-body">
        <div className="ot-setting-card" data-testid="concurrency-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 'var(--ot-fs-sm)', fontWeight: 600 }}>最大并发任务数</div>
              <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                同时运行的工作树数量上限
              </div>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                className="ot-icon-btn"
                style={{ border: '1px solid var(--ot-border)' }}
                disabled={concurrencyDraft <= 1}
                onClick={() => commitConcurrency(concurrencyDraft - 1)}
                aria-label="减少并发槽位"
                data-testid="btn-concurrency-dec"
              >
                <Minus size={12} />
              </button>
              <span className="ot-effort-pill ot-effort-pill--balanced" data-testid="concurrency-value-badge">
                {concurrencyDraft} 槽并行
              </span>
              <button
                type="button"
                className="ot-icon-btn"
                style={{ border: '1px solid var(--ot-border)' }}
                disabled={concurrencyDraft >= 8}
                onClick={() => commitConcurrency(concurrencyDraft + 1)}
                aria-label="增加并发槽位"
                data-testid="btn-concurrency-inc"
              >
                <Plus size={12} />
              </button>
            </div>
          </div>
          <div style={{ padding: '10px 0 2px' }}>
            <div style={{ padding: '0 calc(100% / 16)' }}>
              <Slider.Root
                className="ot-slider-root"
                min={1}
                max={8}
                step={1}
                value={[concurrencyDraft]}
                onValueChange={vals => {
                  const n = vals?.[0]
                  if (n) setConcurrencyDraft(n)
                }}
                onValueCommit={vals => {
                  const n = vals?.[0]
                  if (n) commitConcurrency(n)
                }}
                aria-label="最大并发构建槽位"
                data-testid="slider-max-concurrency"
              >
                <Slider.Track className="ot-slider-track">
                  <Slider.Range className="ot-slider-range" />
                </Slider.Track>
                <Slider.Thumb className="ot-slider-thumb" />
              </Slider.Root>
            </div>
            <div className="ot-concurrency-ticks">
              {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                <button
                  key={n}
                  type="button"
                  className={`ot-concurrency-tick ${concurrencyDraft === n ? 'is-active' : ''}`}
                  onClick={() => commitConcurrency(n)}
                  data-testid={`btn-concurrency-${n}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="ot-setting-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', paddingTop: 12 }}>
            <label className="ot-field-label" style={{ flex: 1, minWidth: 220 }}>
              <span style={{ fontSize: 'var(--ot-fs-sm)', fontWeight: 600, color: 'var(--ot-text)' }}>默认 GitHub 克隆根目录</span>
              <input
                className="ot-input ot-input--sm"
                placeholder="例如：/path/to/projects（导入克隆时自动填入）"
                value={cloneRootDraft}
                onChange={e => setCloneRootDraft(e.target.value)}
                onBlur={() => {
                  if (cloneRootDraft.trim() !== (state.settings.defaultCloneRoot || '')) {
                    onSaveSettings({ defaultCloneRoot: cloneRootDraft.trim() })
                  }
                }}
                onKeyDown={e => {
                  if (isImeComposingEvent(e)) return
                  if (e.key === 'Enter') {
                    onSaveSettings({ defaultCloneRoot: cloneRootDraft.trim() })
                  }
                }}
              />
            </label>
            <button type="button" className="ot-btn ot-btn--sm" onClick={pickCloneRoot}>
              <FolderOpen size={13} />
              <span>选择目录</span>
            </button>
            <button
              type="button"
              className="ot-btn ot-btn--sm ot-btn--primary"
              disabled={cloneRootDraft.trim() === (state.settings.defaultCloneRoot || '')}
              onClick={() => onSaveSettings({ defaultCloneRoot: cloneRootDraft.trim() })}
            >
              保存路径
            </button>
          </div>
        </div>

        <div className="ot-setting-card" data-testid="session-isolation-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 'var(--ot-fs-sm)', fontWeight: 600 }}>会话归类</div>
              <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                切换即生效，历史会话后台整理
              </div>
            </div>
            {onSyncSessionIsolation && (
              <button
                type="button"
                className="ot-btn ot-btn--sm"
                disabled={syncingIso || Boolean(rt.isolationSync?.running)}
                onClick={async () => {
                  setSyncingIso(true)
                  try { await onSyncSessionIsolation() } finally { setSyncingIso(false) }
                }}
                data-testid="btn-sync-session-isolation"
              >
                {syncingIso || rt.isolationSync?.running ? (
                  <CircleNotch size={12} className="ot-spin" />
                ) : (
                  <Check size={12} />
                )}
                <span>
                  {rt.isolationSync?.running
                    ? `整理中 (${rt.isolationSync.done}/${rt.isolationSync.total})`
                    : '整理历史会话'}
                </span>
              </button>
            )}
          </div>

          <div className="ot-iso-mode-grid">
            {[
              {
                id: 'category',
                title: '归入独立分类',
                desc: '放入单独分类，不与日常对话混杂',
              },
              {
                id: 'hidden',
                title: '主列表隐藏',
                desc: '仅插件内可见，不占主会话列表',
              },
              {
                id: 'default',
                title: '默认列表',
                desc: '显示在 Web-UI 默认列表中',
              },
            ].map(opt => {
              const active = isoModeDraft === opt.id
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`ot-iso-mode-card ${active ? 'is-active' : ''}`}
                  onClick={() => {
                    if (isoModeDraft === opt.id) return
                    setIsoModeDraft(opt.id)
                    void onSaveSettings({
                      sessionIsolationMode: opt.id,
                      sessionCategoryName: isoCatDraft.trim() || 'Ekko ToDo',
                    })
                  }}
                  data-testid={`btn-iso-mode-${opt.id}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>{opt.title}</strong>
                    {active && <span className="ot-pill-soft">当前</span>}
                  </div>
                  <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>{opt.desc}</span>
                </button>
              )
            })}
          </div>

          {rt.isolationSync?.running ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-auto-fg)' }} data-testid="iso-bg-status">
              <CircleNotch size={12} className="ot-spin" />
              <span>整理中（{rt.isolationSync.done}/{rt.isolationSync.total}）…</span>
            </div>
          ) : rt.isolationSync?.lastFinishedAt > 0 && rt.isolationSync?.total > 0 ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-done-fg)' }} data-testid="iso-bg-status">
              <Check size={12} weight="bold" />
              <span>
                已整理 {rt.isolationSync.done}/{rt.isolationSync.total} 个会话
              </span>
            </div>
          ) : null}

          {isoModeDraft !== 'default' && (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              <label className="ot-field-label" style={{ flex: 1, minWidth: 200 }}>
                <span>分类名称</span>
                <input
                  className="ot-input ot-input--sm"
                  value={isoCatDraft}
                  onChange={e => setIsoCatDraft(e.target.value)}
                  placeholder="Ekko ToDo"
                  data-testid="input-session-category-name"
                />
              </label>
              <button
                type="button"
                className="ot-btn ot-btn--sm ot-btn--primary"
                disabled={(isoCatDraft.trim() || 'Ekko ToDo') === (state.settings.sessionCategoryName || 'Ekko ToDo')}
                onClick={() => void onSaveSettings({ sessionCategoryName: isoCatDraft.trim() || 'Ekko ToDo' })}
              >
                保存
              </button>
            </div>
          )}
        </div>

        {/* Notification Popup, Sound & Browser Desktop Alerts */}
        <div className="ot-setting-card" data-testid="notifications-settings-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Bell size={16} weight="duotone" style={{ color: 'var(--ot-auto-fg)' }} />
              <div>
                <div style={{ fontSize: 'var(--ot-fs-sm)', fontWeight: 600 }}>完成通知</div>
                <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                  完成、待处理或失败时提醒
                </div>
              </div>
            </div>
            <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ot-btn ot-btn--sm"
                onClick={() => {
                  playNotificationChime('success')
                  onTestNotification?.()
                }}
                data-testid="btn-test-notification"
              >
                <SpeakerHigh size={12} />
                <span>测试提醒</span>
              </button>
              {onOpenShortcuts && (
                <button
                  type="button"
                  className="ot-btn ot-btn--sm"
                  onClick={onOpenShortcuts}
                >
                  <Keyboard size={12} />
                  <span>快捷键 (⌘/)</span>
                </button>
              )}
            </div>
          </div>

          <div className="ot-auth-matrix-grid">
            <div className="ot-auth-matrix-cell">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 500 }}>应用内弹窗</div>
                <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>右下角提示卡片</div>
              </div>
              <Switch.Root
                className="ot-switch"
                checked={state.settings?.notifyPopup !== false}
                onCheckedChange={checked => onSaveSettings({ notifyPopup: checked })}
                data-testid="switch-notify-popup"
              >
                <Switch.Thumb className="ot-switch-thumb" />
              </Switch.Root>
            </div>
            <div className="ot-auth-matrix-cell">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 500 }}>提示音</div>
                <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>按状态播放提示音</div>
              </div>
              <Switch.Root
                className="ot-switch"
                checked={state.settings?.notifySound !== false}
                onCheckedChange={checked => onSaveSettings({ notifySound: checked })}
                data-testid="switch-notify-sound"
              >
                <Switch.Thumb className="ot-switch-thumb" />
              </Switch.Root>
            </div>
            <div className="ot-auth-matrix-cell">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 500 }}>系统桌面通知</div>
                <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                  {getBrowserNotificationPermission() === 'granted' ? '已授权' : getBrowserNotificationPermission() === 'denied' ? '已拒绝' : '未授权'}
                </div>
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {getBrowserNotificationPermission() === 'default' && (
                  <button
                    type="button"
                    className="ot-btn ot-btn--sm"
                    onClick={() => void requestBrowserNotificationPermission().then(() => onSaveSettings({ notifyBrowser: true }))}
                  >
                    授权
                  </button>
                )}
                <Switch.Root
                  className="ot-switch"
                  checked={state.settings?.notifyBrowser !== false}
                  onCheckedChange={checked => {
                    if (checked && getBrowserNotificationPermission() === 'default') {
                      void requestBrowserNotificationPermission()
                    }
                    onSaveSettings({ notifyBrowser: checked })
                  }}
                  data-testid="switch-notify-browser"
                >
                  <Switch.Thumb className="ot-switch-thumb" />
                </Switch.Root>
              </div>
            </div>
          </div>
        </div>

        {onOpenOnboarding && (
          <div className="ot-setting-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Compass size={18} weight="duotone" style={{ color: 'var(--ot-auto-fg)' }} />
                <div>
                  <div style={{ fontSize: 'var(--ot-fs-sm)', fontWeight: 600 }}>初始化向导</div>
                  <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                    重新选择引擎、团队模板或连接 GitHub
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="ot-btn ot-btn--sm"
                onClick={onOpenOnboarding}
                data-testid="btn-relaunch-onboarding"
              >
                <Sparkle size={12} weight="duotone" />
                <span>重新引导</span>
              </button>
            </div>
          </div>
        )}

        <div className="ot-meta-strip">
          <div className="ot-meta-cell">
            <small>Node 运行时</small>
            <strong>{rt.nodeVersion || 'v22+'}</strong>
          </div>
          <div className="ot-meta-cell">
            <small>SQLite 引擎</small>
            <strong>{rt.sqliteBuiltin ? '内置 WAL' : '不可用'}</strong>
          </div>
          <div className="ot-meta-cell">
            <small>MCP 总管工具</small>
            <strong>{rt.mcpServer || 'ekko-todo'} ({rt.mcpToolCount || 26})</strong>
          </div>
          <div className="ot-meta-cell">
            <small>GitHub 连接</small>
            <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span className={`ot-dot ${rt.githubCli?.authenticated ? 'ot-dot--done' : 'ot-dot--todo'}`} />
              <span>{rt.githubCli?.authenticated ? `@${rt.githubCli.username}` : '未登录'}</span>
            </strong>
          </div>
        </div>
      </Tabs.Content>
    </Tabs.Root>
  )
}

import React, { useEffect, useMemo, useState } from 'react'
import * as Switch from '@radix-ui/react-switch'
import * as Collapsible from '@radix-ui/react-collapsible'
import {
  Plus,
  Trash,
  Sliders,
  ArrowsClockwise,
  PencilSimple,
  CaretUp,
  ArrowLineUp,
  ArrowUp,
  ArrowDown,
  ArrowsLeftRight,
  Copy,
  Check,
  Brain,
  WarningCircle,
  Cpu,
  IdentificationCard,
  Sparkle,
  PaperPlaneTilt,
  CaretLeft,
  CaretDown,
} from '@phosphor-icons/react'
import { ReasoningSlider } from './ReasoningSlider.jsx'
import { AgentAvatar, AvatarPicker, generateRandomNotionAvatar } from './AvatarKit.jsx'
import {
  ENGINE_LABEL,
  ROLE_LABEL,
  ROLE_PRESET_LABELS,
  MODE_LABEL,
  SANDBOX_LABEL,
  APPROVAL_LABEL,
  API_MODE_LABEL,
  formatModelShort,
  getEffortMeta,
  getAgentRoleLabel,
  isImeComposingEvent,
} from '../utils.js'
import { PHONE_MAX_WIDTH, agentSectionsDefaultOpen } from '../layout.js'
import { copyWithNotice, dangerCopy } from '../interaction.js'
import { useConfirm } from './ConfirmDialog.jsx'
import { DEFAULT_AGENT_TURNS, MAX_AGENT_TURNS, TURN_PRESETS, clampAgentTurns, turnBudgetNote, turnPresetLabel, turnSummary } from '../../shared/turn-budget.mjs'

const MAX_CONFIGS = 8

function makeEmptyConfig(engine = 'hermes', label = '备选配置') {
  return {
    id: `cfg-${Math.random().toString(36).slice(2, 10)}`,
    label,
    engine,
    mode: engine === 'hermes' ? 'scoped' : 'global',
    provider: '',
    model: '',
    apiMode: '',
    baseUrl: '',
    customModel: false,
    reasoningEffort: 'high',
  }
}

/** True at or below the phone breakpoint; follows rotation and window resizes. */
function useIsPhone() {
  const [phone, setPhone] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= PHONE_MAX_WIDTH : false))
  useEffect(() => {
    const mq = typeof window !== 'undefined' ? window.matchMedia?.(`(max-width: ${PHONE_MAX_WIDTH}px)`) : null
    if (!mq) return undefined
    const sync = () => setPhone(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return phone
}

/**
 * One block of the Agent editor. Desktop: the heading and its fields, always shown.
 * Phone: the heading is a 44px fold button with a one-line summary of the values inside,
 * so the whole Agent reads on one screen and only the part being edited is expanded.
 */
export function AmSection({ id, phone, open, onToggle, icon, phoneTitle, summary, desktopHead, phoneLead, testId, children }) {
  if (!phone) {
    return (
      <div className="ot-am-section" data-testid={testId}>
        {desktopHead}
        {children}
      </div>
    )
  }
  return (
    <div className={`ot-am-section ot-am-section--fold ${open ? 'is-open' : 'is-collapsed'}`} data-testid={testId}>
      <button
        type="button"
        className="ot-am-section-toggle"
        aria-expanded={open}
        aria-controls={`ot-am-sec-${id}`}
        onClick={onToggle}
        data-testid={`btn-am-section-${id}`}
      >
        <span className="ot-am-section-toggle-main">
          {icon}
          <span className="ot-form-section-title">{phoneTitle}</span>
        </span>
        <CaretDown size={14} weight="bold" className="ot-am-section-caret" />
        {!open && summary ? <span className="ot-am-section-summary">{summary}</span> : null}
      </button>
      {open && (
        <div className="ot-am-section-body" id={`ot-am-sec-${id}`}>
          {phoneLead}
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * Turn budget presets + the truth about what the host enforces (#84).
 * 「不限」 is only "unlimited"; the host cap is shown on its own line, never folded into the label.
 */
export function TurnBudgetPresets({ value, budget, onPick }) {
  const current = clampAgentTurns(value)
  const note = turnBudgetNote(budget)
  return (
    <>
      <div className="ot-turns-preset-row" data-testid="agent-max-turns-presets">
        <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>轮次：</span>
        {TURN_PRESETS.map(val => (
          <button
            key={val}
            type="button"
            className={`ot-role-chip ${current === val ? 'is-active' : ''}`}
            onClick={() => onPick(val)}
            data-testid={`btn-max-turns-${val}`}
          >
            {turnPresetLabel(val)}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
        0 为不限，范围 1–{MAX_AGENT_TURNS}。
      </div>
      {note && (
        <div
          style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}
          data-testid="agent-host-turn-budget"
        >
          {note}
        </div>
      )}
    </>
  )
}

/**
 * Software-engineering-grade Master-Detail Agent Manager aligned with Todos:
 * - Left list: all Agents with role tag, primary model, "+N 备选" indicator, and "+ 新建 Agent"
 * - Right detail: Identity + Ordered Primary/Fallback Model Chain (up to 8) + Auto-Failover switch +
 *   Inline Run Config Editor (Catalog / Custom Model + ReasoningSlider) + Permissions & Prompt
 */
export function AgentManager({
  ctx,
  state,
  liveEngines,
  installedEngineOptions,
  busy,
  onSaveAgent,
  onDeleteAgent,
  onClearCooldowns,
  onFetchModelCatalog,
  onAskChiefCreateAgent,
  layout = 'dialog',
  initialAgentId = '',
  createSignal = 0,
}) {
  const agents = state.agents || []
  const isPage = layout === 'page'
  const [selectedId, setSelectedId] = useState(() => (initialAgentId && agents.some(a => a.id === initialAgentId) ? initialAgentId : (agents[0]?.id || '')))
  // Phone page layout is master → detail: the list shows first, picking an Agent opens its editor.
  const [mobileDetail, setMobileDetail] = useState(Boolean(initialAgentId))
  const [draft, setDraft] = useState(null)
  const [editingCfgIndex, setEditingCfgIndex] = useState(-1)
  const [catalogByEngine, setCatalogByEngine] = useState({})
  const [loadingEngine, setLoadingEngine] = useState('')
  const [copiedId, setCopiedId] = useState(false)
  const [askConfirm, confirmNode] = useConfirm()
  const [chiefAssistOpen, setChiefAssistOpen] = useState(false)
  const [chiefAssistText, setChiefAssistText] = useState('')
  const phone = useIsPhone()
  const [openSections, setOpenSections] = useState(() => agentSectionsDefaultOpen({ phone, isNew: false }))
  const toggleSection = id => setOpenSections(prev => ({ ...prev, [id]: !prev[id] }))

  // Each Agent opens with the phone defaults again; a new Agent also shows its name fields.
  useEffect(() => {
    setOpenSections(agentSectionsDefaultOpen({ phone, isNew: selectedId === '__new__' }))
  }, [selectedId, phone])

  // Keep draft synchronized when selected Agent changes
  useEffect(() => {
    if (selectedId === '__new__') return
    const target = agents.find(a => a.id === selectedId) || agents[0]
    if (target) {
      setSelectedId(target.id)
      setDraft({
        ...target,
        modelConfigs: (target.modelConfigs || []).map(c => ({ ...c })),
      })
      setEditingCfgIndex(-1)
    }
  }, [selectedId, agents.map(a => `${a.id}:${a.updatedAt}`).join(',')])

  const activeCfg = editingCfgIndex >= 0 ? draft?.modelConfigs?.[editingCfgIndex] : null

  const ensureCatalog = async (engine, refresh = false) => {
    if (!engine) return
    if (!refresh && catalogByEngine[engine]) return
    setLoadingEngine(engine)
    try {
      const res = await onFetchModelCatalog?.(engine, refresh)
      if (res) setCatalogByEngine(prev => ({ ...prev, [engine]: res }))
    } catch {} finally {
      setLoadingEngine('')
    }
  }

  useEffect(() => {
    if (activeCfg?.engine) void ensureCatalog(activeCfg.engine, false)
  }, [activeCfg?.engine])

  useEffect(() => {
    if (createSignal > 0) startCreateAgent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal])

  useEffect(() => {
    if (initialAgentId && agents.some(a => a.id === initialAgentId)) { setSelectedId(initialAgentId); setMobileDetail(true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAgentId])

  const activeCatalog = activeCfg?.engine ? catalogByEngine[activeCfg.engine] : null
  const activeCatalogModel = useMemo(() => {
    if (!activeCfg || !activeCatalog?.models?.length) return null
    return activeCatalog.models.find(
      m => m.id === activeCfg.model && (!activeCfg.provider || !m.provider || m.provider === activeCfg.provider),
    ) || activeCatalog.models.find(m => m.isDefault) || null
  }, [activeCfg, activeCatalog])

  const startCreateAgent = () => {
    const defaultEng = installedEngineOptions[0]?.id || 'hermes'
    const altEng = installedEngineOptions.find(e => e.id !== defaultEng)?.id
    const configs = [
      makeEmptyConfig(defaultEng, '首选配置'),
      ...(altEng ? [makeEmptyConfig(altEng, '备选配置')] : []),
    ]
    setSelectedId('__new__')
    setMobileDetail(true)
    setDraft({
      id: '',
      name: '',
      role: 'custom',
      roleLabel: '',
      avatar: generateRandomNotionAvatar('agent'),
      description: '',
      engine: configs[0].engine,
      mode: configs[0].mode,
      modelConfigs: configs,
      autoFallback: true,
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      memoryEnabled: true,
      maxTurns: DEFAULT_AGENT_TURNS,
      systemPrompt: '',
      readOnly: false,
      cooldowns: [],
    })
    setEditingCfgIndex(0)
  }

  const updateConfigAt = (idx, patch) => {
    setDraft(prev => {
      if (!prev) return prev
      const next = prev.modelConfigs.map((c, i) => (i === idx ? { ...c, ...patch } : c))
      const p0 = next[0] || prev
      return { ...prev, engine: p0.engine, mode: p0.mode, modelConfigs: next }
    })
  }

  const promoteToPrimary = idx => {
    if (idx <= 0) return
    setDraft(prev => {
      if (!prev) return prev
      const copy = [...prev.modelConfigs]
      const [picked] = copy.splice(idx, 1)
      copy.unshift(picked)
      return { ...prev, engine: copy[0].engine, mode: copy[0].mode, modelConfigs: copy }
    })
    setEditingCfgIndex(0)
  }

  const moveConfig = (idx, delta) => {
    const target = idx + delta
    if (!draft || target < 0 || target >= draft.modelConfigs.length) return
    setDraft(prev => {
      const copy = [...prev.modelConfigs]
      const tmp = copy[idx]
      copy[idx] = copy[target]
      copy[target] = tmp
      return { ...prev, engine: copy[0].engine, mode: copy[0].mode, modelConfigs: copy }
    })
    if (editingCfgIndex === idx) setEditingCfgIndex(target)
  }

  const removeConfig = idx => {
    if (!draft || draft.modelConfigs.length <= 1) return
    setDraft(prev => {
      const next = prev.modelConfigs.filter((_, i) => i !== idx)
      return { ...prev, engine: next[0].engine, mode: next[0].mode, modelConfigs: next }
    })
    if (editingCfgIndex === idx) setEditingCfgIndex(-1)
    else if (editingCfgIndex > idx) setEditingCfgIndex(editingCfgIndex - 1)
  }

  const addFallbackConfig = () => {
    if (!draft || draft.modelConfigs.length >= MAX_CONFIGS) return
    const usedEngines = new Set(draft.modelConfigs.map(c => c.engine))
    const nextEngine = installedEngineOptions.find(e => !usedEngines.has(e.id))?.id
      || draft.modelConfigs[0]?.engine
      || 'hermes'
    const nextIdx = draft.modelConfigs.length
    const newCfg = makeEmptyConfig(nextEngine, `备选 #${nextIdx}`)
    setDraft(prev => ({ ...prev, modelConfigs: [...prev.modelConfigs, newCfg] }))
    setEditingCfgIndex(nextIdx)
  }

  const pickStudioModelForConfig = async idx => {
    const cur = draft?.modelConfigs?.[idx]
    if (!cur) return
    try {
      const picked = await ctx.ui?.selectModel?.({
        current: cur.model ? { provider: cur.provider || '', model: cur.model } : undefined,
      })
      if (picked) {
        updateConfigAt(idx, {
          provider: picked.provider || '',
          model: picked.model || '',
          apiMode: picked.apiMode || cur.apiMode || '',
          customModel: false,
          mode: 'scoped',
        })
      }
    } catch (err) {
      ctx.ui?.notify?.(err?.message || '模型选择器不可用', 'error')
    }
  }

  const handleSave = async () => {
    if (!draft || !draft.name.trim()) return
    const descVal = String(draft.description || '').trim()
    const promptVal = String(draft.systemPrompt || '')
    const roleLabelVal = String(draft.roleLabel || '').trim()
    if (descVal.length > 4000) {
      ctx.ui?.notify?.(`职责说明超过 4000 字上限（当前 ${descVal.length} 字）`, 'error')
      return
    }
    if (promptVal.length > 20000) {
      ctx.ui?.notify?.(`系统提示词超过 20000 字上限（当前 ${promptVal.length} 字）`, 'error')
      return
    }
    if (roleLabelVal.length > 80) {
      ctx.ui?.notify?.(`自定义职责名称超过 80 字上限（当前 ${roleLabelVal.length} 字）`, 'error')
      return
    }
    const p0 = draft.modelConfigs[0]
    const payload = {
      id: draft.id || '',
      name: draft.name.trim().slice(0, 120),
      role: draft.role || 'custom',
      roleLabel: roleLabelVal,
      avatar: draft.avatar || defaultPresetForRole(draft.role),
      description: descVal,
      engine: p0.engine,
      mode: p0.mode,
      provider: p0.provider || '',
      model: p0.model || '',
      apiMode: p0.apiMode || '',
      baseUrl: p0.baseUrl || '',
      customModel: Boolean(p0.customModel),
      reasoningEffort: p0.reasoningEffort || '',
      modelConfigs: draft.modelConfigs,
      autoFallback: Boolean(draft.autoFallback),
      approvalPolicy: draft.approvalPolicy,
      sandboxMode: draft.sandboxMode,
      memoryEnabled: draft.memoryEnabled !== false,
      maxTurns: draft.maxTurns,
      systemPrompt: promptVal,
      readOnly: Boolean(draft.readOnly),
    }
    const nextState = await onSaveAgent(payload)
    if (nextState?.agents && !draft.id) {
      const newest = nextState.agents[nextState.agents.length - 1]
      if (newest) setSelectedId(newest.id)
    }
  }

  const submitAskChiefCreate = () => {
    const desc = chiefAssistText.trim()
    setChiefAssistText('')
    setChiefAssistOpen(false)
    onAskChiefCreateAgent?.(desc)
  }

  const isChief = Boolean(draft?.id && draft.id === state.settings?.chiefAgentId)
  const activeCooldowns = (draft?.cooldowns || []).filter(cd => (Date.now() - Number(cd.failedAt || 0)) < 3600000)
  const primaryCfg = draft?.modelConfigs?.[0]
  const primarySummary = primaryCfg
    ? [ENGINE_LABEL[primaryCfg.engine] || primaryCfg.engine, formatModelShort(primaryCfg.model, primaryCfg.provider)].filter(Boolean).join(' · ')
    : ''
  const autoFallbackSwitch = draft ? (
    <Switch.Root
      className="ot-switch"
      checked={Boolean(draft.autoFallback)}
      onCheckedChange={checked => setDraft({ ...draft, autoFallback: checked })}
      data-testid="switch-agent-autofallback"
    >
      <Switch.Thumb className="ot-switch-thumb" />
    </Switch.Root>
  ) : null

  return (
    <div className={`ot-am-wrap ${isPage ? 'ot-am-wrap--page' : ''} ${mobileDetail ? 'is-detail' : 'is-list'}`} data-testid="agent-manager">
      {/* Compact Live Engines Bar */}
      <Collapsible.Root className="ot-engine-strip">
        <Collapsible.Trigger asChild>
          <button type="button" className="ot-engine-strip-trigger">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
              <span className="ot-dot ot-dot--done" />
              <strong style={{ fontSize: 'var(--ot-fs-xs)' }}>本机运行引擎 {installedEngineOptions.length} / {liveEngines.length} 就绪</strong>
              <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                {installedEngineOptions.map(e => ENGINE_LABEL[e.id] || e.name).join(' · ')}
              </span>
            </span>
            <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', flex: 'none' }}>查看全部</span>
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content style={{ padding: '0 12px 12px' }}>
          <div className="ot-engine-grid">
            {liveEngines.map(e => (
              <div key={e.id} className={`ot-engine-item ${e.installed ? '' : 'is-off'}`}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--ot-fs-xs)', fontWeight: 500 }}>
                  <span>{e.name}</span>
                  <span className={`ot-dot ${e.installed ? 'ot-dot--done' : 'ot-dot--todo'}`} />
                </div>
                <div style={{ fontFamily: 'var(--ot-mono)', fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                  {e.installed ? (e.version || '已安装') : '未安装'}
                </div>
              </div>
            ))}
          </div>
        </Collapsible.Content>
      </Collapsible.Root>

      {/* Master-Detail Two-Column Engineering Workspace */}
      <div className="ot-am-grid">
        {/* Left Master List */}
        <div className="ot-am-list">
          <div className="ot-am-list-head">
            <span>Agent 列表 ({agents.length})</span>
            <button
              type="button"
              className="ot-icon-btn"
              onClick={startCreateAgent}
              title="新建 Agent"
              data-testid="btn-add-agent"
            >
              <Plus size={13} />
            </button>
          </div>
          <div className="ot-am-list-items">
            {agents.map(a => {
              const active = selectedId === a.id
              const fbCount = Math.max(0, (a.modelConfigs?.length || 1) - 1)
              const chiefFlag = a.id === state.settings?.chiefAgentId
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`ot-am-item ${active ? 'is-active' : ''}`}
                  onClick={() => { setSelectedId(a.id); setMobileDetail(true) }}
                  data-testid={`agent-item-${a.id}`}
                >
                  <div className="ot-am-item-row1">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      <AgentAvatar agent={a} size={22} />
                      <span className="ot-am-item-name">{a.name}</span>
                    </span>
                    <span className={`ot-role-badge ot-role-badge--${a.role || 'custom'}`}>
                      {chiefFlag ? '当前总管' : getAgentRoleLabel(a)}
                    </span>
                  </div>
                  <div className="ot-am-item-row2">
                    <span className="ot-am-item-meta">
                      {ENGINE_LABEL[a.engine] || a.engine}
                      {a.model ? ` · ${formatModelShort(a.model)}` : ''}
                    </span>
                    {fbCount > 0 && (
                      <span className="ot-fb-count" title={`已配置 ${fbCount} 套备选模型（${a.autoFallback ? '故障自动切换开' : '仅手动切换'}）`}>
                        +{fbCount} 备选
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <button type="button" className="ot-btn ot-btn--sm" style={{ width: '100%' }} onClick={startCreateAgent}>
              <Plus size={12} />
              <span>手动新建 Agent</span>
            </button>
            {onAskChiefCreateAgent && (
              <button
                type="button"
                className={`ot-btn ot-btn--sm ${chiefAssistOpen ? '' : 'ot-btn--primary'}`}
                style={{ width: '100%' }}
                onClick={() => setChiefAssistOpen(v => !v)}
                data-testid="btn-chief-create-agent"
              >
                <Sparkle size={12} weight={chiefAssistOpen ? 'duotone' : 'fill'} />
                <span>{chiefAssistOpen ? '收起大总管代建' : '让大总管帮我创建'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Right Structured Detail Editor */}
        <div className="ot-am-detail-col">
          {isPage && (
            <button type="button" className="ot-btn ot-btn--sm ot-am-mobile-back" onClick={() => setMobileDetail(false)} data-testid="btn-agent-mobile-back">
              <CaretLeft size={13} weight="bold" />
              <span>全部 Agent</span>
            </button>
          )}
          {chiefAssistOpen && onAskChiefCreateAgent && (
            <div className="ot-chief-assist-box" data-testid="chief-create-agent-box">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--ot-fs-sm)', fontWeight: 600 }}>
                  <Sparkle size={14} weight="duotone" style={{ color: 'var(--ot-auto-fg)' }} />
                  <span>描述需要的 Agent</span>
                </span>
                <button type="button" className="ot-btn ot-btn--sm" onClick={() => setChiefAssistOpen(false)}>
                  收起
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="ot-input ot-input--sm"
                  style={{ flex: 1 }}
                  value={chiefAssistText}
                  onChange={e => setChiefAssistText(e.target.value)}
                  placeholder="例如：小红书选题与排版 Agent（留空由大总管引导）"
                  data-testid="input-chief-create-agent"
                  onKeyDown={e => { if (!isImeComposingEvent(e) && e.key === 'Enter') submitAskChiefCreate() }}
                />
                <button
                  type="button"
                  className="ot-btn ot-btn--sm ot-btn--accent"
                  onClick={submitAskChiefCreate}
                  data-testid="btn-submit-chief-create-agent"
                >
                  <PaperPlaneTilt size={12} weight="fill" />
                  <span>发给大总管</span>
                </button>
              </div>
            </div>
          )}

          {draft && (
            <div className="ot-am-detail" data-testid="agent-editor-form">
              <div className="ot-am-detail-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                  <AgentAvatar avatar={draft.avatar} role={draft.role} size={30} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>{draft.id ? draft.name || '未命名 Agent' : '新建 Agent'}</strong>
                      {draft.id && (
                        <button
                          type="button"
                          className="ot-pill-mono"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          title="复制 Agent ID"
                          data-testid="btn-copy-agent-id"
                          onClick={async () => {
                            const ok = await copyWithNotice(draft.id, ctx?.ui?.notify, { success: '已复制 Agent ID', failure: '复制 Agent ID 失败，请手动选择复制' })
                            if (!ok) return
                            setCopiedId(true)
                            setTimeout(() => setCopiedId(false), 1200)
                          }}
                        >
                          <span>{draft.id}</span>
                          {copiedId ? <Check size={10} /> : <Copy size={10} />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {draft.id && agents.length > 1 && !isChief && (
                    <button
                      type="button"
                      className="ot-btn ot-btn--sm ot-btn--danger"
                      data-testid="btn-delete-agent"
                      onClick={() => askConfirm(dangerCopy('agent', draft), () => onDeleteAgent(draft.id))}
                    >
                      <Trash size={12} />
                      <span>删除</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="ot-btn ot-btn--sm ot-btn--primary"
                    disabled={!draft.name.trim() || busy}
                    onClick={handleSave}
                    data-testid="btn-save-agent"
                  >
                    保存配置
                  </button>
                </div>
              </div>

              {/* 1. Identity, Avatar & Flexible Custom Role */}
              <AmSection
                id="identity"
                phone={phone}
                open={openSections.identity}
                onToggle={() => toggleSection('identity')}
                icon={<IdentificationCard size={16} weight="duotone" />}
                phoneTitle="头像与职责"
                summary={[draft.name || '未命名', (draft.roleLabel || '').trim() || ROLE_LABEL[draft.role] || '']
                  .filter(Boolean).join(' · ')}
                desktopHead={(
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <IdentificationCard size={14} weight="duotone" />
                    <span className="ot-form-section-title">1. 头像与职责定位（支持任意行业自定义）</span>
                  </div>
                )}
              >

                <AvatarPicker
                  mode="agent"
                  compact
                  role={draft.role}
                  value={draft.avatar || ''}
                  onChange={nextAvatar => setDraft({ ...draft, avatar: nextAvatar })}
                />

                <div className="ot-am-fields ot-am-fields--3">
                  <label className="ot-field-label">
                    <span>Agent 名称</span>
                    <input
                      className="ot-input ot-input--sm"
                      placeholder="例如：小红书主编 / 前端主程"
                      value={draft.name}
                      onChange={e => setDraft({ ...draft, name: e.target.value })}
                      data-testid="input-agent-name"
                    />
                  </label>
                  <label className="ot-field-label">
                    <span>职责定位（可自由填写）</span>
                    <input
                      className="ot-input ot-input--sm"
                      placeholder="例如：新媒体运营、开发执行..."
                      value={draft.roleLabel || ''}
                      onChange={e => setDraft({ ...draft, roleLabel: e.target.value })}
                      data-testid="input-agent-role-label"
                    />
                  </label>
                  <label className="ot-field-label ot-am-field--wide">
                    <span>底层执行类型</span>
                    <select
                      className="ot-input ot-input--sm"
                      value={draft.role}
                      onChange={e => {
                        const nextRole = e.target.value
                        const isRev = nextRole === 'reviewer'
                        setDraft({
                          ...draft,
                          role: nextRole,
                          readOnly: isRev,
                          sandboxMode: isRev ? 'read-only' : draft.sandboxMode,
                        })
                      }}
                    >
                      <option value="custom">通用自定义（内容/运营/调研）</option>
                      <option value="chief">总管编排（统筹多项目）</option>
                      <option value="builder">开发执行（代码与分支）</option>
                      <option value="reviewer">独立审查（只读把关）</option>
                      <option value="qa">测试验证（质量与回归）</option>
                    </select>
                  </label>
                </div>

                <div className="ot-role-chip-bar" data-testid="role-preset-chips">
                  <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', alignSelf: 'center', marginRight: 2 }}>常用岗位快选：</span>
                  {ROLE_PRESET_LABELS.map(preset => {
                    const active = (draft.roleLabel || '').trim() === preset.label
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        className={`ot-role-chip ${active ? 'is-active' : ''}`}
                        onClick={() => {
                          setDraft({
                            ...draft,
                            role: isChief ? 'chief' : preset.role,
                            roleLabel: preset.label,
                            sandboxMode: preset.sandbox,
                            readOnly: preset.sandbox === 'read-only',
                          })
                        }}
                      >
                        {preset.label}
                      </button>
                    )
                  })}
                </div>

                <label className="ot-field-label">
                  <span>职责说明</span>
                  <textarea
                    className="ot-input ot-input--sm ot-textarea-v"
                    rows={2}
                    placeholder="负责领域与边界（派单时自动带上）"
                    value={draft.description || ''}
                    onChange={e => setDraft({ ...draft, description: e.target.value })}
                  />
                </label>
              </AmSection>

            {/* 2. Primary + Fallback Model Chain (Todos runPresets + Auto-Failover) */}
            <AmSection
              id="models"
              testId="agent-model-chain"
              phone={phone}
              open={openSections.models}
              onToggle={() => toggleSection('models')}
              icon={<ArrowsLeftRight size={16} weight="duotone" />}
              phoneTitle={`模型配置（${draft.modelConfigs.length} / ${MAX_CONFIGS}）`}
              summary={primarySummary}
              desktopHead={(
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <ArrowsLeftRight size={14} weight="duotone" />
                    <span className="ot-form-section-title">2. 模型配置（{draft.modelConfigs.length} / {MAX_CONFIGS}）</span>
                  </div>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                    <span>故障自动切换</span>
                    {autoFallbackSwitch}
                  </label>
                </div>
              )}
              phoneLead={(
                <label className="ot-setting-row ot-am-switch-row">
                  <span>故障自动切换</span>
                  {autoFallbackSwitch}
                </label>
              )}
            >

              <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>
                按顺序执行，限流或异常时自动切换下一套。
              </div>

              {activeCooldowns.length > 0 && draft.id && (
                <div className="ot-cooldown-banner">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <WarningCircle size={13} />
                    <span>当前有 {activeCooldowns.length} 套配置处于 1 小时故障冷却期</span>
                  </span>
                  <button type="button" className="ot-btn ot-btn--sm" onClick={() => onClearCooldowns?.(draft.id)}>
                    清除冷却
                  </button>
                </div>
              )}

              <div className="ot-cfg-chain">
                {draft.modelConfigs.map((cfg, idx) => {
                  const isEditing = editingCfgIndex === idx
                  const effort = getEffortMeta(cfg.reasoningEffort)
                  const cooling = activeCooldowns.find(cd => cd.configId === cfg.id)

                  return (
                    <div key={cfg.id} className={`ot-cfg-row ${idx === 0 ? 'is-primary' : ''} ${isEditing ? 'is-editing' : ''}`} data-testid={`model-config-row-${idx}`}>
                      <div className="ot-cfg-row-top">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
                          {/* Two groups: transparent on desktop (one wrapping row as before), two fixed lines on a phone. */}
                          <span className="ot-cfg-line ot-cfg-line--id">
                            <span className={`ot-cfg-rank ${idx === 0 ? 'is-primary' : ''}`}>
                              {idx === 0 ? '首选' : `备选 #${idx}`}
                            </span>
                            <span style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 500 }}>
                              {ENGINE_LABEL[cfg.engine] || cfg.engine}
                            </span>
                            <span className="ot-pill-mono" title={formatModelShort(cfg.model, cfg.provider)}>
                              {cfg.customModel ? '自定义: ' : ''}{formatModelShort(cfg.model, cfg.provider)}
                            </span>
                          </span>
                          <span className="ot-cfg-line ot-cfg-line--meta">
                            <span className={`ot-effort-pill ot-effort-pill--${effort.tone}`}>
                              <Brain size={10} />
                              <span>{effort.short}</span>
                            </span>
                            <span className="ot-pill-soft">{MODE_LABEL[cfg.mode] || cfg.mode}</span>
                            {cooling && <span className="ot-tag ot-tag--bug">冷却中</span>}
                          </span>
                        </div>

                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none' }}>
                          {!phone && idx > 0 && (
                            <button
                              type="button"
                              className="ot-icon-btn"
                              title="设为首选"
                              onClick={() => promoteToPrimary(idx)}
                              data-testid={`btn-promote-config-${idx}`}
                            >
                              <ArrowLineUp size={12} />
                            </button>
                          )}
                          {!phone && idx > 0 && (
                            <button
                              type="button"
                              className="ot-icon-btn"
                              title="上移优先级"
                              onClick={() => moveConfig(idx, -1)}
                            >
                              <ArrowUp size={12} />
                            </button>
                          )}
                          {!phone && idx < draft.modelConfigs.length - 1 && (
                            <button
                              type="button"
                              className="ot-icon-btn"
                              title="下移优先级"
                              onClick={() => moveConfig(idx, 1)}
                            >
                              <ArrowDown size={12} />
                            </button>
                          )}
                          <button
                            type="button"
                            className={`ot-btn ot-btn--sm ${isEditing ? 'ot-btn--primary' : ''}`}
                            style={{ height: 24, padding: '0 7px', fontSize: 'var(--ot-fs-xs)' }}
                            onClick={() => setEditingCfgIndex(isEditing ? -1 : idx)}
                            data-testid={`btn-edit-config-${idx}`}
                          >
                            {isEditing ? <CaretUp size={11} /> : <PencilSimple size={11} />}
                            <span>{isEditing ? '收起' : '编辑'}</span>
                          </button>
                          {!phone && draft.modelConfigs.length > 1 && (
                            <button
                              type="button"
                              className="ot-icon-btn"
                              title="移除此配置"
                              onClick={() => removeConfig(idx)}
                            >
                              <Trash size={12} />
                            </button>
                          )}
                        </div>
                      </div>

                      {isEditing && (
                        <div className="ot-cfg-inline-editor" data-testid="config-inline-editor">
                          {/* Phone: order and remove live here as labelled buttons, so the row above stays one tidy line. */}
                          {phone && (idx > 0 || draft.modelConfigs.length > 1) && (
                            <div className="ot-cfg-editor-actions" data-testid={`config-actions-${idx}`}>
                              {idx > 0 && (
                                <button type="button" className="ot-btn ot-btn--sm" onClick={() => promoteToPrimary(idx)} data-testid={`btn-promote-config-${idx}`}>
                                  <ArrowLineUp size={13} />
                                  <span>设为首选</span>
                                </button>
                              )}
                              {idx > 0 && (
                                <button type="button" className="ot-btn ot-btn--sm" onClick={() => moveConfig(idx, -1)}>
                                  <ArrowUp size={13} />
                                  <span>上移</span>
                                </button>
                              )}
                              {idx < draft.modelConfigs.length - 1 && (
                                <button type="button" className="ot-btn ot-btn--sm" onClick={() => moveConfig(idx, 1)}>
                                  <ArrowDown size={13} />
                                  <span>下移</span>
                                </button>
                              )}
                              {draft.modelConfigs.length > 1 && (
                                <button type="button" className="ot-btn ot-btn--sm ot-btn--danger" onClick={() => removeConfig(idx)}>
                                  <Trash size={13} />
                                  <span>移除</span>
                                </button>
                              )}
                            </div>
                          )}
                          <div className="ot-am-fields ot-am-fields--3 ot-am-fields--tight">
                            <label className="ot-field-label ot-am-field--wide">
                              <span>配置名称</span>
                              <input
                                className="ot-input ot-input--sm"
                                placeholder={idx === 0 ? '首选配置' : `备选 #${idx}`}
                                value={cfg.label || ''}
                                onChange={e => updateConfigAt(idx, { label: e.target.value })}
                              />
                            </label>
                            <label className="ot-field-label">
                              <span>运行引擎</span>
                              <select
                                className="ot-input ot-input--sm"
                                value={cfg.engine}
                                onChange={e => updateConfigAt(idx, {
                                  engine: e.target.value,
                                  mode: e.target.value === 'hermes' ? 'scoped' : cfg.mode,
                                })}
                              >
                                {liveEngines.map(e => (
                                  <option key={e.id} value={e.id}>
                                    {e.name}{e.installed ? '' : '（未安装）'}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="ot-field-label">
                              <span>运行模式</span>
                              <select
                                className="ot-input ot-input--sm"
                                value={cfg.mode}
                                onChange={e => updateConfigAt(idx, { mode: e.target.value })}
                              >
                                <option value="scoped">Studio 代理</option>
                                <option value="global">CLI 原生</option>
                              </select>
                            </label>
                          </div>

                          <div className="ot-model-mode-bar">
                            <div className="ot-seg">
                              <button
                                type="button"
                                className={`ot-seg-btn ${!cfg.customModel ? 'is-active' : ''}`}
                                onClick={() => updateConfigAt(idx, { customModel: false })}
                                data-testid="btn-model-mode-catalog"
                              >
                                目录选型
                              </button>
                              <button
                                type="button"
                                className={`ot-seg-btn ${cfg.customModel ? 'is-active' : ''}`}
                                onClick={() => updateConfigAt(idx, { customModel: true })}
                                data-testid="btn-model-mode-custom"
                              >
                                自定义模型
                              </button>
                            </div>
                            <div style={{ display: 'inline-flex', gap: 5 }}>
                              <button type="button" className="ot-btn ot-btn--sm" onClick={() => pickStudioModelForConfig(idx)}>
                                <Sliders size={12} />
                                <span>原生选择器</span>
                              </button>
                              <button
                                type="button"
                                className="ot-icon-btn"
                                title="刷新目录"
                                onClick={() => ensureCatalog(cfg.engine, true)}
                              >
                                <ArrowsClockwise size={12} className={loadingEngine === cfg.engine ? 'ot-spin' : ''} />
                              </button>
                            </div>
                          </div>

                          {!cfg.customModel ? (
                            <label className="ot-field-label">
                              <span>模型（已探测 {activeCatalog?.models?.length || 0} 个）</span>
                              <select
                                className="ot-input ot-input--sm"
                                disabled={loadingEngine === cfg.engine}
                                value={cfg.model ? `${cfg.provider || ''}::${cfg.model}` : ''}
                                onChange={e => {
                                  const val = e.target.value
                                  if (!val) { updateConfigAt(idx, { provider: '', model: '', apiMode: '' }); return }
                                  const sep = val.indexOf('::')
                                  const prov = sep >= 0 ? val.slice(0, sep) : ''
                                  const mod = sep >= 0 ? val.slice(sep + 2) : val
                                  const found = (activeCatalog?.models || []).find(m => m.id === mod && (m.provider || '') === prov)
                                  updateConfigAt(idx, { provider: prov, model: mod, apiMode: found?.apiMode || '' })
                                }}
                              >
                                <option value="">
                                  {loadingEngine === cfg.engine
                                    ? '正在拉取模型目录...'
                                    : `引擎默认${activeCatalog?.defaultModel ? `（${formatModelShort(activeCatalog.defaultModel)}）` : ''}`}
                                </option>
                                {(activeCatalog?.models || []).slice(0, 120).map(m => (
                                  <option key={`${m.provider || ''}::${m.id}`} value={`${m.provider || ''}::${m.id}`}>
                                    {m.providerLabel && m.providerLabel !== cfg.engine ? `[${m.providerLabel}] ` : ''}{m.name || m.id}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <div className="ot-am-fields ot-am-fields--2 ot-am-fields--tight">
                              <label className="ot-field-label">
                                <span>Provider Key（可选）</span>
                                <input
                                  className="ot-input ot-input--sm"
                                  placeholder="openai / anthropic / custom:xxx"
                                  value={cfg.provider || ''}
                                  onChange={e => updateConfigAt(idx, { provider: e.target.value })}
                                  data-testid="input-agent-custom-provider"
                                />
                              </label>
                              <label className="ot-field-label ot-am-field--wide">
                                <span>自定义模型 ID</span>
                                <input
                                  className="ot-input ot-input--sm"
                                  placeholder="例如：claude-opus-5-5 或 gpt-6.2-sol"
                                  value={cfg.model || ''}
                                  onChange={e => updateConfigAt(idx, { model: e.target.value })}
                                  data-testid="input-agent-custom-model"
                                />
                              </label>
                              <label className="ot-field-label">
                                <span>API 协议模式</span>
                                <select
                                  className="ot-input ot-input--sm"
                                  value={cfg.apiMode || ''}
                                  onChange={e => updateConfigAt(idx, { apiMode: e.target.value })}
                                >
                                  {Object.entries(API_MODE_LABEL).map(([k, lbl]) => (
                                    <option key={k || '__auto'} value={k}>{lbl}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="ot-field-label ot-am-field--wide">
                                <span>自定义网关 Base URL（可选）</span>
                                <input
                                  className="ot-input ot-input--sm"
                                  placeholder="留空走 Studio 托管网关"
                                  value={cfg.baseUrl || ''}
                                  onChange={e => updateConfigAt(idx, { baseUrl: e.target.value })}
                                />
                              </label>
                            </div>
                          )}

                          <ReasoningSlider
                            compact
                            value={cfg.reasoningEffort || ''}
                            supportedEfforts={activeCatalogModel?.reasoningEfforts || []}
                            onChange={nextEffort => updateConfigAt(idx, { reasoningEffort: nextEffort })}
                            testId="agent-editor-effort-slider"
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {draft.modelConfigs.length < MAX_CONFIGS && (
                <button
                  type="button"
                  className="ot-btn ot-btn--sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={addFallbackConfig}
                  data-testid="btn-add-fallback-config"
                >
                  <Plus size={12} />
                  <span>添加备选模型配置</span>
                </button>
              )}
            </AmSection>

            {/* 3. Permissions, Sandbox & Memory */}
            <AmSection
              id="perms"
              phone={phone}
              open={openSections.perms}
              onToggle={() => toggleSection('perms')}
              icon={<Sliders size={16} weight="duotone" />}
              phoneTitle="权限、轮次与提示词"
              summary={[
                SANDBOX_LABEL[draft.sandboxMode || 'workspace-write'],
                APPROVAL_LABEL[draft.approvalPolicy || 'on-request'],
                turnSummary(draft.maxTurns, state?.runtime?.hostTurnBudget),
              ].filter(Boolean).join(' · ')}
              desktopHead={<div className="ot-form-section-title">3. 权限边界、沙箱与轮次上限</div>}
            >
              <div className="ot-am-fields ot-am-fields--perm">
                <label className="ot-field-label">
                  <span>文件沙箱</span>
                  <select
                    className="ot-input ot-input--sm"
                    value={draft.sandboxMode || 'workspace-write'}
                    onChange={e => setDraft({ ...draft, sandboxMode: e.target.value, readOnly: e.target.value === 'read-only' })}
                  >
                    {Object.entries(SANDBOX_LABEL).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
                  </select>
                </label>
                <label className="ot-field-label">
                  <span>审批策略</span>
                  <select
                    className="ot-input ot-input--sm"
                    value={draft.approvalPolicy || 'on-request'}
                    onChange={e => setDraft({ ...draft, approvalPolicy: e.target.value })}
                  >
                    {Object.entries(APPROVAL_LABEL).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
                  </select>
                </label>
                <label className="ot-field-label ot-am-field--wide">
                  <span>最大轮次（0=不限）</span>
                  <input
                    type="number"
                    min={0}
                    max={MAX_AGENT_TURNS}
                    className="ot-input ot-input--sm"
                    value={draft.maxTurns ?? 0}
                    data-testid="input-agent-max-turns"
                    onChange={e => {
                      const v = Number(e.target.value)
                      setDraft({ ...draft, maxTurns: Number.isFinite(v) ? clampAgentTurns(v) : 0 })
                    }}
                  />
                </label>
              </div>
              <TurnBudgetPresets
                value={draft.maxTurns}
                budget={state?.runtime?.hostTurnBudget}
                onPick={val => setDraft({ ...draft, maxTurns: val })}
              />
              <div className="ot-setting-row" style={{ borderTop: 0, padding: '2px 0' }}>
                <span style={{ fontSize: 'var(--ot-fs-xs)' }}>注入持久记忆与 AGENTS.md</span>
                <Switch.Root
                  className="ot-switch"
                  checked={draft.memoryEnabled !== false}
                  onCheckedChange={checked => setDraft({ ...draft, memoryEnabled: checked })}
                >
                  <Switch.Thumb className="ot-switch-thumb" />
                </Switch.Root>
              </div>
              <label className="ot-field-label">
                <span>系统提示词</span>
                <textarea
                  className="ot-input"
                  rows={3}
                  placeholder="自定义工作风格与输出要求（可选）"
                  value={draft.systemPrompt || ''}
                  onChange={e => setDraft({ ...draft, systemPrompt: e.target.value })}
                />
              </label>
            </AmSection>
          </div>
          )}
        </div>
      </div>
      {confirmNode}
    </div>
  )
}

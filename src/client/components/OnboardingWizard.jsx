import React, { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  X,
  ArrowRight,
  ArrowLeft,
  WarningCircle,
  Check,
  Sparkle,
  Code,
  Megaphone,
  Binoculars,
  UserCircle,
  GithubLogo,
  FolderPlus,
  Cpu,
  CheckCircle,
} from '@phosphor-icons/react'
import { BrandLogo } from './BrandLogo.jsx'
import { AgentAvatar, AvatarPicker, generateRandomNotionAvatar } from './AvatarKit.jsx'
import { GithubAuthCard } from './GithubAuthCard.jsx'
import { ReasoningSlider } from './ReasoningSlider.jsx'
import { ENGINE_LABEL, formatModelShort } from '../utils.js'
import { onboardingEngineGate } from '../trust-view.js'
import { loadErrorText } from '../interaction.js'
import { LoadError } from './LoadError.jsx'

const TEAM_SCENARIOS = [
  {
    id: 'engineering',
    title: '软件研发团队',
    tag: '软件研发',
    desc: '大总管拆任务，开发 Agent 写代码，审查 Agent 只读复核',
    Icon: Code,
    members: [
      { name: '代码开发', role: '开发执行', avatar: 'notion:eng-builder-a1' },
      { name: '代码审查', role: '代码审查', avatar: 'notion:eng-reviewer-b2' },
    ],
  },
  {
    id: 'newmedia',
    title: '新媒体与内容团队',
    tag: '自媒体 / 运营',
    desc: '大总管排期，策划、主笔和审校分工写稿',
    Icon: Megaphone,
    members: [
      { name: '选题策划', role: '选题策划', avatar: 'notion:media-planner-c3' },
      { name: '文案主笔', role: '内容主编', avatar: 'notion:media-writer-d4' },
      { name: '审校排版', role: '审校把关', avatar: 'notion:media-editor-e5' },
    ],
  },
  {
    id: 'research',
    title: '产品与研究分析',
    tag: '调研 / 咨询',
    desc: '大总管定题，调研、数据分析和核查分工完成',
    Icon: Binoculars,
    members: [
      { name: '深度调研', role: '深度调研', avatar: 'notion:research-scout-f6' },
      { name: '数据分析', role: '数据分析', avatar: 'notion:research-data-g7' },
      { name: '方案核查', role: '逻辑核查', avatar: 'notion:research-check-h8' },
    ],
  },
  {
    id: 'assistant',
    title: '个人全能助理',
    tag: '轻量',
    desc: '大总管处理日常事务，执行助手整理文档，以后可以再加人',
    Icon: UserCircle,
    members: [
      { name: '执行助手', role: '通用助理', avatar: 'notion:assist-helper-k9' },
    ],
  },
]

const ENGINE_HINTS = {
  hermes: 'Studio 内置宿主引擎',
  'claude-code': '复杂架构与长文主力',
  codex: 'OpenAI 推理与执行',
  grok: '响应快，检索分析佳',
  dsh: '高性价比中文深度思考',
  qwen: '中文生态工具链友好',
  antigravity: '多模态与全栈协同',
  cursor: '复用本机 Cursor 能力',
}

/**
 * First-run universal Onboarding Wizard:
 * - Never forces Hermes: lets ANY newcomer pick whichever installed engine (Claude Code, Codex, Hermes, etc.) as their primary Chief
 * - Lets non-coding users (new media, research, personal assistant) pick a matching team template
 * - Provides optional GitHub auth or local project binding with zero-friction skip
 */
export function OnboardingWizard({
  open,
  state,
  busy,
  onClose,
  onComplete,
  onFetchModelCatalog,
  onRefreshGithubAuth,
  onStartGithubDevice,
  onSaveGithubToken,
  onLogoutGithub,
  onOpenAddProject,
}) {
  const [step, setStep] = useState(0)
  const [chiefName, setChiefName] = useState('大总管')
  const [chiefAvatar, setChiefAvatar] = useState(() => generateRandomNotionAvatar('chief'))
  const [chiefEngine, setChiefEngine] = useState('hermes')
  const [chiefMode, setChiefMode] = useState('scoped')
  const [chiefProvider, setChiefProvider] = useState('')
  const [chiefModel, setChiefModel] = useState('')
  const [chiefEffort, setChiefEffort] = useState('high')
  const [fallbackEngine, setFallbackEngine] = useState('')
  const [teamPreset, setTeamPreset] = useState('engineering')
  const [catalog, setCatalog] = useState(null)
  const [loadingCat, setLoadingCat] = useState(false)
  // #100: a failed catalog load is shown with a retry, not as "可选 0 个".
  const [catalogError, setCatalogError] = useState('')
  const [catalogTry, setCatalogTry] = useState(0)
  // The uninstalled engine the user explicitly chose to keep ("仍要继续"). Any other engine resets it.
  const [uninstalledAck, setUninstalledAck] = useState('')
  const [saving, setSaving] = useState(false)

  const liveEngines = useMemo(() => {
    const base = [
      { id: 'hermes', name: 'Hermes Agent', installed: true, version: 'Studio 内置' },
      ...(state?.runtime?.liveEngines || []),
    ]
    const seen = new Set()
    return base
      .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true })
      .sort((a, b) => Number(b.installed) - Number(a.installed))
  }, [state?.runtime?.liveEngines])

  const installedEngines = useMemo(() => liveEngines.filter(e => e.installed), [liveEngines])

  // Sync current Chief defaults when wizard opens
  useEffect(() => {
    if (!open) return
    setStep(0)
    setUninstalledAck('')
    const curChief = (state?.agents || []).find(a => a.id === state?.settings?.chiefAgentId)
      || (state?.agents || []).find(a => a.role === 'chief')
    if (curChief) {
      setChiefName(curChief.name || '大总管')
      setChiefAvatar(curChief.avatar || 'preset:chief-compass')
      setChiefEngine(curChief.engine || 'hermes')
      setChiefMode(curChief.mode || (curChief.engine === 'hermes' ? 'scoped' : 'global'))
      setChiefProvider(curChief.provider || '')
      setChiefModel(curChief.model || '')
      setChiefEffort(curChief.reasoningEffort || 'high')
      const fb = curChief.modelConfigs?.[1]?.engine || ''
      setFallbackEngine(fb)
    }
    if (state?.settings?.teamPreset) setTeamPreset(state.settings.teamPreset)
  }, [open])

  useEffect(() => {
    if (!open || !chiefEngine || !onFetchModelCatalog) return
    let active = true
    setLoadingCat(true)
    setCatalogError('')
    Promise.resolve()
      .then(() => onFetchModelCatalog(chiefEngine, catalogTry > 0))
      .then(res => { if (active) setCatalog(res || null) })
      .catch(err => { if (active) { setCatalog(null); setCatalogError(loadErrorText(err, '读取模型列表失败')) } })
      .finally(() => { if (active) setLoadingCat(false) })
    return () => { active = false }
  }, [open, chiefEngine, onFetchModelCatalog, catalogTry])

  const selectEngine = engId => {
    setChiefEngine(engId)
    setChiefMode(engId === 'hermes' ? 'scoped' : 'global')
    setChiefProvider('')
    setChiefModel('')
    if (fallbackEngine === engId) setFallbackEngine('')
    setUninstalledAck('')
    setCatalogTry(0)
  }

  const engineGate = onboardingEngineGate({ engines: liveEngines, engineId: chiefEngine, acknowledgedId: uninstalledAck })
  const goNext = () => {
    // Guarded here as well as on the button: the stepper must not walk past an unaccepted uninstalled engine.
    if (engineGate.blocked) return
    setStep(s => s + 1)
  }

  const finishOnboarding = async (skip = false) => {
    setSaving(true)
    try {
      await onComplete?.(skip
        ? { skip: true }
        : {
            skip: false,
            chiefName: chiefName.trim() || '大总管',
            chiefAvatar,
            chiefEngine,
            chiefMode,
            chiefProvider,
            chiefModel,
            chiefReasoningEffort: chiefEffort,
            fallbackEngine,
            teamPreset,
            applyTeamPreset: true,
          })
      onClose?.()
    } finally {
      setSaving(false)
    }
  }

  const steps = [
    { id: 0, label: '选择主力大总管' },
    { id: 1, label: '选择协作场景' },
    { id: 2, label: '连接项目（可选）' },
  ]
  const activeScenario = TEAM_SCENARIOS.find(s => s.id === teamPreset) || TEAM_SCENARIOS[0]

  return (
    <Dialog.Root open={open} onOpenChange={v => { if (!v) onClose?.() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay" />
        <Dialog.Content className="ot-modal ot-modal--lg ot-onboard-modal" data-testid="onboarding-wizard" onOpenAutoFocus={e => e.preventDefault()}>
          <div className="ot-dialog-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <BrandLogo size={32} />
              <div>
                <Dialog.Title className="ot-dialog-title">欢迎使用 Ekko ToDo</Dialog.Title>
                <p className="ot-dialog-sub">选好大总管和团队模板即可开始。</p>
              </div>
            </div>
            <button
              type="button"
              className="ot-icon-btn"
              onClick={() => finishOnboarding(true)}
              title="跳过引导并标记为已完成（以后可在 设置 → 运行环境 重新引导）"
              aria-label="跳过引导并标记为已完成"
              data-testid="btn-onboarding-close"
            >
              <X size={16} />
            </button>
          </div>

          <div className="ot-onboard-stepper">
            {steps.map(s => (
              <button
                key={s.id}
                type="button"
                className={`ot-onboard-step ${step === s.id ? 'is-active' : step > s.id ? 'is-done' : ''}`}
                onClick={() => { if (s.id <= step || !engineGate.blocked) setStep(s.id) }}
                disabled={s.id > step && engineGate.blocked}
              >
                <span className="ot-onboard-step-dot">{step > s.id ? <Check size={10} weight="bold" /> : s.id + 1}</span>
                <span>{s.label}</span>
              </button>
            ))}
          </div>

          <div className="ot-dialog-body">
            {/* STEP 1: CHOOSE ANY PRIMARY ENGINE AS CHIEF */}
            {step === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="onboarding-step-1">
                <div className="ot-onboard-tip">
                  <Cpu size={15} style={{ flex: 'none', color: 'var(--ot-auto-fg)' }} />
                  <span>可任选已安装的引擎作为大总管（Hermes / Claude Code / Codex / Grok 等）。</span>
                </div>

                <div>
                  <div className="ot-form-section-title" style={{ marginBottom: 8 }}>
                    选择大总管主力引擎（已检测到 {installedEngines.length} 个就绪）
                  </div>
                  <div className="ot-onboard-engine-grid">
                    {liveEngines.slice(0, 8).map(eng => {
                      const picked = chiefEngine === eng.id
                      return (
                        <button
                          key={eng.id}
                          type="button"
                          className={`ot-onboard-engine-card ${picked ? 'is-selected' : ''} ${!eng.installed ? 'is-uninstalled' : ''}`}
                          onClick={() => selectEngine(eng.id)}
                          data-testid={`onboard-engine-${eng.id}`}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                            <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>{ENGINE_LABEL[eng.id] || eng.name}</strong>
                            <span className={`ot-pill-soft ${eng.installed ? 'is-ready-pill' : ''}`} style={{ fontSize: 'var(--ot-fs-xs)' }}>
                              {eng.installed ? '已就绪' : '未安装'}
                            </span>
                          </div>
                          <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', lineHeight: 1.45 }}>
                            {ENGINE_HINTS[eng.id] || (eng.version ? `版本 ${eng.version}` : '外部 CLI 引擎')}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  {!engineGate.installed && (
                    <div className="ot-engine-gate" role="alert" data-testid="onboard-engine-gate">
                      <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <WarningCircle size={14} />
                        <span>「{ENGINE_LABEL[chiefEngine] || chiefEngine}」还没有安装</span>
                      </strong>
                      <span>{engineGate.guide}</span>
                      <span>{engineGate.consequence}</span>
                      {engineGate.acknowledged ? (
                        <span data-testid="onboard-engine-ack-done">你已选择仍要继续：可以点「下一步」，但总管要等这个引擎装好才能工作。</span>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                          {installedEngines[0] && (
                            <button type="button" className="ot-btn ot-btn--sm ot-btn--primary" onClick={() => selectEngine(installedEngines[0].id)} data-testid="btn-onboard-use-installed">
                              改用已就绪的 {ENGINE_LABEL[installedEngines[0].id] || installedEngines[0].name}
                            </button>
                          )}
                          <button type="button" className="ot-btn ot-btn--sm" onClick={() => setUninstalledAck(chiefEngine)} data-testid="btn-onboard-engine-ack">
                            我知道后果，仍要继续
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="ot-setting-card" style={{ gap: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <label className="ot-field-label">
                      <span>大总管称呼</span>
                      <input
                        className="ot-input ot-input--sm"
                        value={chiefName}
                        onChange={e => setChiefName(e.target.value)}
                        placeholder="大总管 / 首席助理 / 绿洲"
                      />
                    </label>
                    <label className="ot-field-label">
                      <span>运行方式</span>
                      <select
                        className="ot-input ot-input--sm"
                        value={chiefMode}
                        onChange={e => setChiefMode(e.target.value)}
                      >
                        <option value="scoped">Studio 托管（复用 Studio 模型配置）</option>
                        <option value="global">本地 CLI 原生（复用本机登录态）</option>
                      </select>
                    </label>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <label className="ot-field-label">
                      <span data-testid="onboard-catalog-status">首选模型（{loadingCat ? '读取中…' : catalogError ? '读取失败' : `可选 ${catalog?.models?.length || 0} 个`}）</span>
                      <LoadError message={catalogError} onRetry={() => setCatalogTry(n => n + 1)} className="ot-field-label" testId="onboarding-catalog-error" />
                      <select
                        className="ot-input ot-input--sm"
                        value={chiefModel ? `${chiefProvider}::${chiefModel}` : ''}
                        onChange={e => {
                          const val = e.target.value
                          if (!val) { setChiefProvider(''); setChiefModel(''); return }
                          const idx = val.indexOf('::')
                          setChiefProvider(idx >= 0 ? val.slice(0, idx) : '')
                          setChiefModel(idx >= 0 ? val.slice(idx + 2) : val)
                        }}
                      >
                        <option value="">
                          自动使用引擎默认{catalog?.defaultModel ? `（${formatModelShort(catalog.defaultModel)}）` : ''}
                        </option>
                        {(catalog?.models || []).slice(0, 80).map(m => (
                          <option key={`${m.provider || ''}::${m.id}`} value={`${m.provider || ''}::${m.id}`}>
                            {m.providerLabel && m.providerLabel !== chiefEngine ? `[${m.providerLabel}] ` : ''}{m.name || m.id}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="ot-field-label">
                      <span>故障自动切换备选引擎（可选）</span>
                      <select
                        className="ot-input ot-input--sm"
                        value={fallbackEngine}
                        onChange={e => setFallbackEngine(e.target.value)}
                      >
                        <option value="">暂不设置备选（以后可随时配最多 8 套）</option>
                        {installedEngines.filter(e => e.id !== chiefEngine).map(e => (
                          <option key={e.id} value={e.id}>
                            主模型限流/异常时切到 {ENGINE_LABEL[e.id] || e.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <ReasoningSlider
                    compact
                    value={chiefEffort}
                    onChange={setChiefEffort}
                    testId="onboard-effort-slider"
                  />

                  <AvatarPicker
                    mode="agent"
                    compact
                    inlineStrip
                    role="chief"
                    value={chiefAvatar}
                    onChange={setChiefAvatar}
                  />
                </div>
              </div>
            )}

            {/* STEP 2: TEAM SCENARIO PRESET */}
            {step === 1 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="onboarding-step-2">
                <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)' }}>
                  选择初始团队模板，成员随时可增删修改。
                </div>

                <div className="ot-onboard-scenario-grid">
                  {TEAM_SCENARIOS.map(sc => {
                    const active = teamPreset === sc.id
                    const Icon = sc.Icon
                    return (
                      <button
                        key={sc.id}
                        type="button"
                        className={`ot-onboard-scenario-card ${active ? 'is-selected' : ''}`}
                        onClick={() => setTeamPreset(sc.id)}
                        data-testid={`onboard-preset-${sc.id}`}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 'var(--ot-fs-sm)' }}>
                            <Icon size={16} weight="duotone" />
                            <span>{sc.title}</span>
                          </span>
                          <span className={`ot-pill-soft ${active ? 'is-active-tag' : ''}`} style={{ fontSize: 'var(--ot-fs-xs)' }}>
                            {active ? '✓ 已选' : sc.tag}
                          </span>
                        </div>
                        <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-text-2)', lineHeight: 1.5 }}>{sc.desc}</div>
                        <div className="ot-onboard-members">
                          {sc.members.map(mb => (
                            <span key={mb.name} className="ot-onboard-member-chip">
                              <AgentAvatar avatar={mb.avatar} size={18} />
                              <span>{mb.name}</span>
                            </span>
                          ))}
                        </div>
                      </button>
                    )
                  })}
                </div>

                {/* Live Team Topology Preview Bar (eliminates bottom whitespace & shows Chief + Workers together) */}
                <div className="ot-setting-card" style={{ gap: 8, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'var(--ot-fs-xs)', fontWeight: 600, color: 'var(--ot-text)' }}>
                      即将为你组建的团队架构（{activeScenario.title}）
                    </span>
                    <span style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>进入工作台后可随时增删成员</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="ot-onboard-member-chip is-chief-chip">
                      <AgentAvatar avatar={chiefAvatar} role="chief" size={20} />
                      <strong>{chiefName.trim() || '大总管'}</strong>
                      <span style={{ color: 'var(--ot-muted)', fontSize: 'var(--ot-fs-xs)' }}>({ENGINE_LABEL[chiefEngine] || chiefEngine})</span>
                    </span>
                    <ArrowRight size={13} style={{ color: 'var(--ot-muted)', flex: 'none' }} />
                    {activeScenario.members.map(mb => (
                      <span key={mb.name} className="ot-onboard-member-chip">
                        <AgentAvatar avatar={mb.avatar} size={18} />
                        <span>{mb.name}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* STEP 3: OPTIONAL GITHUB / PROJECT LINKING */}
            {step === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="onboarding-step-3">
                <div className="ot-onboard-tip">
                  <Sparkle size={15} weight="duotone" style={{ flex: 'none', color: 'var(--ot-auto-fg)' }} />
                  <span>此步可选：研发项目可现在关联仓库，其他场景直接点右下角完成。</span>
                </div>

                <GithubAuthCard
                  status={state?.runtime?.githubCli}
                  onRefreshStatus={onRefreshGithubAuth}
                  onStartDeviceLogin={onStartGithubDevice}
                  onSaveToken={onSaveGithubToken}
                  onLogout={onLogoutGithub}
                />

                <div className="ot-setting-card" style={{ gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 'var(--ot-fs-sm)', fontWeight: 600 }}>
                        关联项目（已关联 {state?.projects?.length || 0} 个）
                      </div>
                    </div>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      <button
                        type="button"
                        className="ot-btn ot-btn--sm ot-btn--primary"
                        onClick={() => onOpenAddProject?.('github')}
                      >
                        <GithubLogo size={13} weight="bold" />
                        <span>从 GitHub 导入</span>
                      </button>
                      <button
                        type="button"
                        className="ot-btn ot-btn--sm"
                        onClick={() => onOpenAddProject?.('local')}
                      >
                        <FolderPlus size={13} />
                        <span>关联本地目录</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="ot-dialog-foot" style={{ justifyContent: 'space-between' }}>
            <button
              type="button"
              className="ot-btn ot-btn--sm"
              style={{ color: 'var(--ot-muted)' }}
              onClick={() => finishOnboarding(true)}
              disabled={saving || busy}
              data-testid="btn-onboarding-skip"
            >
              跳过引导，以后再说
            </button>

            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {step > 0 && (
                <button type="button" className="ot-btn" onClick={() => setStep(s => s - 1)}>
                  <ArrowLeft size={13} />
                  <span>上一步</span>
                </button>
              )}
              {step < 2 ? (
                <button
                  type="button"
                  className="ot-btn ot-btn--primary"
                  onClick={goNext}
                  disabled={engineGate.blocked}
                  title={engineGate.blocked ? '所选引擎还没有安装：先改选已就绪的引擎，或在上方确认「仍要继续」' : undefined}
                  data-testid="btn-onboarding-next"
                >
                  <span>下一步</span>
                  <ArrowRight size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  className="ot-btn ot-btn--primary"
                  disabled={saving || busy || engineGate.blocked}
                  onClick={() => { if (!engineGate.blocked) void finishOnboarding(false) }}
                  data-testid="btn-onboarding-finish"
                >
                  <CheckCircle size={14} weight="fill" />
                  <span>{saving ? '正在初始化…' : '完成配置，进入工作台'}</span>
                </button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

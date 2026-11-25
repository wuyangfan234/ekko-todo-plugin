import React, { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import {
  SlidersHorizontal,
  Cpu,
  BookmarkSimple,
  ShieldCheck,
  GearSix,
  Sparkle,
  Check,
  ArrowsClockwise,
  CaretDown,
  ArrowsLeftRight,
  Brain,
  X,
} from '@phosphor-icons/react'
import { ReasoningSlider } from './ReasoningSlider.jsx'
import { AgentAvatar } from './AvatarKit.jsx'
import { ENGINE_LABEL, formatModelShort, getEffortMeta } from '../utils.js'

/**
 * Chief quick configuration. The trigger is a full-width line above the composer (model + effort are
 * never squeezed), and the panel opens as a side sheet on desktop / bottom sheet on phones so every
 * control is fully visible and scrollable.
 */
export function QuickChiefPopover({
  ctx,
  state,
  onQuickConfigureChief,
  onFetchModelCatalog,
  onOpenSettingsTab,
  onOpenAgents,
}) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [customModel, setCustomModel] = useState('')
  const [customProvider, setCustomProvider] = useState('')

  const chief = useMemo(() => {
    const list = state?.agents || []
    return list.find(a => a.id === state?.settings?.chiefAgentId)
      || list.find(a => a.role === 'chief')
      || list[0]
      || null
  }, [state])

  useEffect(() => {
    if (!open || !chief) return
    setCustomMode(Boolean(chief.customModel))
    setCustomModel(chief.model || '')
    setCustomProvider(chief.provider || '')
    let active = true
    setLoadingCatalog(true)
    Promise.resolve(onFetchModelCatalog?.(chief.engine || 'hermes', false))
      .then(res => { if (active) setCatalog(res || null) })
      .catch(() => {})
      .finally(() => { if (active) setLoadingCatalog(false) })
    return () => { active = false }
  }, [open, chief?.id, chief?.engine, onFetchModelCatalog])

  if (!chief) return null

  const activeCatalogModel = (catalog?.models || []).find(
    m => m.id === chief.model && (!chief.provider || !m.provider || m.provider === chief.provider),
  ) || (catalog?.models || []).find(m => m.isDefault)
  const supportedEfforts = activeCatalogModel?.reasoningEfforts || []
  const effortMeta = getEffortMeta(chief.reasoningEffort)
  const auth = state.settings?.chiefAuthority || {}
  const activeMemCount = state.counts?.memories ?? (state.memories || []).filter(m => m.enabled).length
  const fbCount = Math.max(0, (chief.modelConfigs?.length || 1) - 1)

  const handlePickStudioModel = async () => {
    try {
      const picked = await ctx.ui?.selectModel?.({
        current: chief.model ? { provider: chief.provider || '', model: chief.model } : undefined,
      })
      if (picked) {
        await onQuickConfigureChief({
          provider: picked.provider || '',
          model: picked.model || '',
          apiMode: picked.apiMode || '',
          customModel: false,
          mode: 'scoped',
        })
      }
    } catch (err) {
      ctx.ui?.notify?.(err?.message || '模型选择器不可用', 'error')
    }
  }

  const handleApplyCustom = () => {
    onQuickConfigureChief({
      provider: customProvider.trim(),
      model: customModel.trim(),
      customModel: Boolean(customModel.trim()),
    })
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={`ot-chief-line ${open ? 'is-open' : ''}`}
          title={`总管：${chief.name} · ${chief.model || ENGINE_LABEL[chief.engine] || chief.engine} · 思考${effortMeta.label}（点击调整）`}
          data-testid="btn-chief-quick-config"
        >
          <AgentAvatar agent={chief} size={18} />
          <span className="ot-chief-line-name">{chief.name}</span>
          <span className="ot-chief-line-sep" aria-hidden="true">·</span>
          <span className="ot-chief-line-model">
            {chief.model ? formatModelShort(chief.model) : (ENGINE_LABEL[chief.engine] || chief.engine)}
          </span>
          <span className={`ot-chief-line-effort ot-effort-text--${effortMeta.tone}`}>
            <Brain size={12} weight="duotone" style={{ flex: 'none' }} />
            <span>{effortMeta.label}</span>
          </span>
          <CaretDown size={11} className="ot-chief-line-caret" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="ot-overlay ot-chief-sheet-overlay" />
        <Dialog.Content
          className="ot-chief-sheet"
          data-testid="chief-quick-popover"
          aria-describedby={undefined}
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <div className="ot-chief-sheet-head">
            <Dialog.Title className="ot-qp-title-row">
              <SlidersHorizontal size={15} weight="duotone" />
              <span>总管配置</span>
            </Dialog.Title>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <button
                type="button"
                className="ot-qp-link"
                onClick={() => { setOpen(false); onOpenSettingsTab?.('chief') }}
              >
                <GearSix size={13} />
                <span>章程与记忆</span>
              </button>
              <Dialog.Close asChild>
                <button type="button" className="ot-icon-btn" aria-label="关闭"><X size={16} /></button>
              </Dialog.Close>
            </div>
          </div>
          <div className="ot-chief-sheet-body">

          <div className="ot-qp-section">
            <div className="ot-qp-label-row">
              <span className="ot-qp-label"><Cpu size={12} /> 总管 Agent 与模型</span>
              <div style={{ display: 'inline-flex', gap: 4 }}>
                <button type="button" className={`ot-chip-btn ${!customMode ? 'is-active' : ''}`} onClick={() => setCustomMode(false)}>
                  目录
                </button>
                <button type="button" className={`ot-chip-btn ${customMode ? 'is-active' : ''}`} onClick={() => setCustomMode(true)}>
                  自定义
                </button>
              </div>
            </div>

            <div className="ot-qp-control-row">
              <select
                className="ot-input ot-input--sm"
                value={chief.id}
                onChange={e => onQuickConfigureChief({ chiefAgentId: e.target.value })}
              >
                {(state.agents || []).map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({ENGINE_LABEL[a.engine] || a.engine})
                  </option>
                ))}
              </select>
              <button type="button" className="ot-btn ot-btn--sm ot-qp-side-btn" onClick={handlePickStudioModel}>
                原生选型
              </button>
            </div>

            {!customMode ? (
              <div className="ot-qp-control-row">
                <select
                  className="ot-input ot-input--sm"
                  disabled={loadingCatalog}
                  value={chief.model ? `${chief.provider || ''}::${chief.model}` : ''}
                  onChange={e => {
                    const val = e.target.value
                    if (!val) { onQuickConfigureChief({ provider: '', model: '', customModel: false }); return }
                    const sep = val.indexOf('::')
                    const prov = sep >= 0 ? val.slice(0, sep) : ''
                    const mod = sep >= 0 ? val.slice(sep + 2) : val
                    const found = (catalog?.models || []).find(m => m.id === mod && (m.provider || '') === prov)
                    onQuickConfigureChief({ provider: prov, model: mod, apiMode: found?.apiMode || '', customModel: false })
                  }}
                >
                  <option value="">
                    {loadingCatalog ? '正在探测模型目录...' : `引擎默认${catalog?.defaultModel ? `（${formatModelShort(catalog.defaultModel)}）` : ''}`}
                  </option>
                  {(catalog?.models || []).slice(0, 80).map(m => (
                    <option key={`${m.provider || ''}::${m.id}`} value={`${m.provider || ''}::${m.id}`}>
                      {m.providerLabel && m.providerLabel !== chief.engine ? `[${m.providerLabel}] ` : ''}{m.name || m.id}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ot-btn ot-btn--sm ot-qp-side-btn"
                  title="刷新该引擎模型列表"
                  onClick={() => {
                    setLoadingCatalog(true)
                    Promise.resolve(onFetchModelCatalog?.(chief.engine || 'hermes', true))
                      .then(res => setCatalog(res || null))
                      .finally(() => setLoadingCatalog(false))
                  }}
                >
                  <ArrowsClockwise size={12} className={loadingCatalog ? 'ot-spin' : ''} />
                  <span>刷新</span>
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 6 }}>
                  <input className="ot-input ot-input--sm" placeholder="Provider（可选）" value={customProvider} onChange={e => setCustomProvider(e.target.value)} />
                  <input className="ot-input ot-input--sm" placeholder="自定义模型 ID" value={customModel} onChange={e => setCustomModel(e.target.value)} />
                </div>
                <button type="button" className="ot-btn ot-btn--sm ot-btn--primary" onClick={handleApplyCustom}>
                  <Check size={12} />
                  <span>应用自定义模型</span>
                </button>
              </div>
            )}
          </div>

          <ReasoningSlider
            compact
            value={chief.reasoningEffort || ''}
            supportedEfforts={supportedEfforts}
            testId="chief-quick-effort-slider"
            onChange={nextEffort => onQuickConfigureChief({ reasoningEffort: nextEffort })}
          />

          <div className="ot-qp-section">
            <div className="ot-qp-row">
              <span className="ot-qp-label">
                <ArrowsLeftRight size={12} />
                <span>故障自动切备选（{fbCount} 套备选）</span>
              </span>
              <Switch.Root
                className="ot-switch"
                checked={Boolean(chief.autoFallback)}
                onCheckedChange={checked => onQuickConfigureChief({ autoFallback: checked })}
              >
                <Switch.Thumb className="ot-switch-thumb" />
              </Switch.Root>
            </div>

            <div className="ot-qp-row">
              <span className="ot-qp-label">
                <BookmarkSimple size={12} />
                <span>注入持久记忆（{activeMemCount} 条生效）</span>
              </span>
              <Switch.Root
                className="ot-switch"
                checked={chief.memoryEnabled !== false}
                onCheckedChange={checked => onQuickConfigureChief({ memoryEnabled: checked })}
              >
                <Switch.Thumb className="ot-switch-thumb" />
              </Switch.Root>
            </div>

            <div className="ot-qp-divider" />

            <div className="ot-qp-label">
              <ShieldCheck size={12} />
              <span>总管最高权限（点击即时启停）</span>
            </div>
            <div className="ot-auth-pills-grid">
              {[
                ['canConfigureAgents', '配 Agent'],
                ['canSwitchModels', '切模型'],
                ['canManageMemories', '管记忆'],
                ['canManageProjects', '管项目'],
                ['canAdjustConcurrency', '调并发'],
                ['injectHostMemory', '读宿主'],
              ].map(([key, label]) => {
                const on = auth[key] !== false
                return (
                  <button
                    key={key}
                    type="button"
                    className={`ot-auth-pill ${on ? 'is-on' : ''}`}
                    onClick={() => onQuickConfigureChief({ chiefAuthority: { [key]: !on } })}
                  >
                    {on && <Check size={10} weight="bold" />}
                    <span>{label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          </div>
          <div className="ot-qp-foot">
            <button
              type="button"
              className="ot-qp-foot-btn"
              data-testid="btn-chief-sheet-agents"
              onClick={() => { setOpen(false); onOpenAgents ? onOpenAgents(chief.id) : onOpenSettingsTab?.('agents') }}
            >
              <Cpu size={13} />
              <span>全部 Agent 配置</span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

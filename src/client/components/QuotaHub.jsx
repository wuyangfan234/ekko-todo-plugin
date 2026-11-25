import React, { useCallback, useEffect, useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import { describeQuotaWindow } from '../quota-window-label.mjs'
import {
  CaretLeft,
  ArrowsClockwise,
  SlidersHorizontal,
  Key,
  Plus,
  Check,
  WarningCircle,
  Sparkle,
  Gauge,
  Coin,
  CloudCheck,
  CaretDown,
  CaretUp,
  Trash,
  Clock,
  PushPin,
  X,
  ChartBar,
} from '@phosphor-icons/react'
import { formatRelativeTime } from '../utils.js'

const SOURCE_MODE_OPTIONS = [
  ['auto', '自动检测'],
  ['direct', '密钥直连'],
  ['local', '本机检测'],
]

const AUTO_REFRESH_OPTIONS = [
  [0, '仅手动刷新'],
  [5, '每 5 分钟'],
  [15, '每 15 分钟'],
  [30, '每 30 分钟'],
  [60, '每 1 小时'],
]

const PROVIDER_MONOGRAM = {
  kimi: { letter: 'K', tone: 'kimi' },
  grok: { letter: 'X', tone: 'grok' },
  deepseek: { letter: 'D', tone: 'deepseek' },
  antigravity: { letter: 'A', tone: 'antigravity' },
  codex: { letter: 'O', tone: 'codex' },
  claude: { letter: 'C', tone: 'claude' },
  openrouter: { letter: 'R', tone: 'openrouter' },
}

function formatResetCountdown(isoStr) {
  if (!isoStr) return ''
  const target = Date.parse(isoStr)
  if (!Number.isFinite(target)) return ''
  const diffMs = target - Date.now()
  if (diffMs <= 0) return '即将重置'
  const mins = Math.round(diffMs / 60000)
  if (mins < 60) return `${mins} 分钟后重置`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hours < 24) return remMins > 0 ? `${hours} 小时 ${remMins} 分后重置` : `${hours} 小时后重置`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `${days} 天 ${remHours} 小时后重置` : `${days} 天后重置`
}

function formatCompactTokens(n) {
  const v = Number(n || 0)
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

function localizePaceZh(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const mRes = s.match(/(\d+(?:\.\d+)?)%\s*in\s*reserve/i)
  const mExp = s.match(/Expected\s+(\d+(?:\.\d+)?)%\s*used/i)
  const mAhead = s.match(/(\d+(?:\.\d+)?)%\s*ahead/i)
  const lasts = /lasts\s+until\s+reset/i.test(s)
  const runsOut = /runs\s+out/i.test(s)
  const parts = []
  if (mRes) parts.push(`较周期节奏结余 ${mRes[1]}%`)
  else if (mAhead) parts.push(`消耗超前周期节奏 ${mAhead[1]}%`)
  if (mExp) parts.push(`按当前进度预期已用 ${mExp[1]}%`)
  if (lasts) parts.push('预计可持续至重置')
  else if (runsOut) parts.push('按当前速率可能提前耗尽')
  return parts.length > 0 ? parts.join(' · ') : s
}

function meterToneClass(remainingPct) {
  if (remainingPct <= 15) return 'is-danger'
  if (remainingPct <= 40) return 'is-warn'
  return 'is-ok'
}

function QuotaCardConfigPopover({ provider, highlight = false, openExternal = false, onOpenChangeExternal, onSave, onRefresh, onDelete }) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = onOpenChangeExternal ? openExternal : internalOpen
  const setOpen = onOpenChangeExternal || setInternalOpen
  const [enabled, setEnabled] = useState(provider.enabled)
  const [pinned, setPinned] = useState(provider.pinned)
  const [sourceMode, setSourceMode] = useState(provider.sourceMode || 'auto')
  const [endpoint, setEndpoint] = useState(provider.endpoint || '')
  const [secretDraft, setSecretDraft] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setEnabled(provider.enabled)
      setPinned(provider.pinned)
      setSourceMode(provider.sourceMode || 'auto')
      setEndpoint(provider.endpoint || '')
      setSecretDraft('')
    }
  }, [open, provider])

  const handleSaveAndTest = async () => {
    setSaving(true)
    try {
      await onSave({
        id: provider.id,
        enabled,
        pinned,
        sourceMode,
        endpoint: endpoint.trim(),
        ...(secretDraft.trim() ? { secretValue: secretDraft.trim() } : {}),
      })
      setSecretDraft('')
      await onRefresh(provider.id)
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const handleClearSecret = async () => {
    setSaving(true)
    try {
      await onSave({ id: provider.id, clearSecret: true })
    } finally {
      setSaving(false)
    }
  }

  const isCustom = !PROVIDER_MONOGRAM[provider.id]

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`ot-icon-btn ${highlight ? 'ot-quota-key-warn' : ''}`}
          title={`配置 ${provider.name}`}
          data-testid={`btn-config-quota-${provider.id}`}
        >
          <Key size={14} weight={provider.hasSecret || highlight ? 'fill' : 'regular'} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="ot-menu-popover ot-menu-popover--paper ot-quota-cfg-pop"
          align="end"
          sideOffset={6}
          data-testid={`quota-config-popover-${provider.id}`}
        >
          <div className="ot-quota-cfg-head">
            <strong>{provider.name}</strong>
            <button type="button" className="ot-icon-btn" onClick={() => setOpen(false)} aria-label="关闭">
              <X size={13} />
            </button>
          </div>

          <div className="ot-quota-cfg-switches">
            <label className="ot-quota-cfg-switch-row">
              <span>启用监控</span>
              <Switch.Root className="ot-switch" checked={enabled} onCheckedChange={setEnabled}>
                <Switch.Thumb className="ot-switch-thumb" />
              </Switch.Root>
            </label>
            <label className="ot-quota-cfg-switch-row">
              <span>首页置顶</span>
              <Switch.Root className="ot-switch" checked={pinned} onCheckedChange={setPinned}>
                <Switch.Thumb className="ot-switch-thumb" />
              </Switch.Root>
            </label>
          </div>

          <div className="ot-field">
            <label className="ot-label">检测方式</label>
            <div className="ot-seg" style={{ width: '100%' }}>
              {SOURCE_MODE_OPTIONS.map(([mode, lbl]) => (
                <button
                  key={mode}
                  type="button"
                  className={`ot-seg-btn ${sourceMode === mode ? 'is-active' : ''}`}
                  style={{ flex: 1 }}
                  onClick={() => setSourceMode(mode)}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <div className="ot-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="ot-label">{provider.credentialLabel || 'API Key / Token'}</label>
              {provider.hasSecret && (
                <span className="ot-quota-secret-badge">
                  已存 {provider.secretPreview}
                  <button type="button" onClick={handleClearSecret} title="清除已保存密钥">清除</button>
                </span>
              )}
            </div>
            <input
              type="password"
              className="ot-input ot-input--sm"
              autoComplete="off"
              placeholder={provider.hasSecret ? '留空保持当前密钥' : (provider.credentialPlaceholder || '粘贴 API Key / Token')}
              value={secretDraft}
              onChange={e => setSecretDraft(e.target.value)}
            />
          </div>

          <div className="ot-field">
            <label className="ot-label">接口地址（可选）</label>
            <input
              className="ot-input ot-input--sm"
              placeholder="默认使用官方接口"
              value={endpoint}
              onChange={e => setEndpoint(e.target.value)}
            />
          </div>

          <div className="ot-quota-cfg-foot">
            {isCustom && onDelete && (
              <button
                type="button"
                className="ot-btn ot-btn--sm ot-btn--danger"
                onClick={async () => { await onDelete(provider.id); setOpen(false) }}
              >
                <Trash size={12} /> 删除
              </button>
            )}
            <button
              type="button"
              className="ot-btn ot-btn--primary ot-btn--sm"
              style={{ marginLeft: 'auto' }}
              disabled={saving}
              onClick={handleSaveAndTest}
              data-testid={`btn-save-test-quota-${provider.id}`}
            >
              <ArrowsClockwise size={12} className={saving ? 'ot-spin' : ''} />
              <span>{saving ? '检测中…' : '保存并检测'}</span>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function QuotaHub({
  ctx,
  providers = [],
  settings,
  onBack,
  onSaveProvider,
  onDeleteProvider,
  onRefreshProvider,
  onRefreshAll,
  onUpdateAutoRefresh,
}) {
  const [expandedAll, setExpandedAll] = useState(false)
  const [refreshingIds, setRefreshingIds] = useState(() => new Set())
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const [openConfigId, setOpenConfigId] = useState('')
  const [customDraft, setCustomDraft] = useState({ name: '', endpoint: '', secretValue: '' })
  const [usageRange, setUsageRange] = useState('7d')
  const [tokenUsage, setTokenUsage] = useState(null)
  const [loadingUsage, setLoadingUsage] = useState(false)

  const enabledProviders = useMemo(() => providers.filter(p => p.enabled), [providers])
  const visibleProviders = useMemo(
    () => (expandedAll ? enabledProviders : enabledProviders.slice(0, 4)),
    [enabledProviders, expandedAll],
  )
  const hiddenCount = Math.max(0, enabledProviders.length - visibleProviders.length)
  const autoMin = Number(settings?.quotaAutoRefreshMin ?? 15)

  const loadTokenUsage = useCallback(async (range = usageRange) => {
    setLoadingUsage(true)
    try {
      const res = await ctx.rpc.call('get-token-usage', { range })
      setTokenUsage(res)
    } catch {
      setTokenUsage(null)
    } finally {
      setLoadingUsage(false)
    }
  }, [ctx, usageRange])

  useEffect(() => {
    void loadTokenUsage(usageRange)
  }, [usageRange])

  // Auto-probe enabled providers once on first visit if none have been checked yet
  useEffect(() => {
    const unchecked = enabledProviders.some(p => !p.lastCheckedAt)
    if (unchecked && !refreshingAll) {
      setRefreshingAll(true)
      void onRefreshAll?.({ onlyEnabled: true }).finally(() => setRefreshingAll(false))
    }
  }, [])

  // Client-side auto-refresh timer coexisting with manual refresh
  useEffect(() => {
    if (!autoMin || autoMin <= 0) return
    const timer = setInterval(() => {
      void onRefreshAll?.({ onlyEnabled: true })
      void loadTokenUsage(usageRange)
    }, autoMin * 60 * 1000)
    return () => clearInterval(timer)
  }, [autoMin, usageRange, onRefreshAll, loadTokenUsage])

  const handleSingleRefresh = async id => {
    setRefreshingIds(prev => new Set([...prev, id]))
    try {
      await onRefreshProvider?.(id)
    } finally {
      setRefreshingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleRefreshAll = async () => {
    setRefreshingAll(true)
    try {
      await Promise.all([
        onRefreshAll?.({ onlyEnabled: true }),
        loadTokenUsage(usageRange),
      ])
    } finally {
      setRefreshingAll(false)
    }
  }

  const handleAddCustomProvider = async () => {
    if (!customDraft.name.trim() || !customDraft.endpoint.trim()) return
    await onSaveProvider?.({
      name: customDraft.name.trim(),
      providerType: 'custom',
      subtitle: '自定义 API 余额接口',
      kind: 'balance',
      enabled: true,
      pinned: false,
      sourceMode: 'direct',
      endpoint: customDraft.endpoint.trim(),
      secretValue: customDraft.secretValue.trim(),
    })
    setCustomDraft({ name: '', endpoint: '', secretValue: '' })
  }

  const maxDailyTokens = useMemo(() => {
    const arr = tokenUsage?.daily || []
    return Math.max(1, ...arr.map(d => Number(d.totalTokens || 0)))
  }, [tokenUsage])

  return (
    <section className="ot-hub-view" data-testid="quota-hub-view">
      {/* Header Bar */}
      <header className="ot-proj-topbar">
        <div className="ot-proj-topbar-left">
          <button
            type="button"
            className="ot-icon-btn"
            onClick={onBack}
            title="返回工作台 (⌘[)"
            data-testid="btn-hub-back"
          >
            <CaretLeft size={16} weight="bold" />
          </button>
          <Gauge size={16} weight="duotone" style={{ color: 'var(--ot-auto-fg)' }} />
          <strong className="ot-proj-topbar-name">用量与配额</strong>
          <span className="ot-hub-count-pill">已开启 {enabledProviders.length} / {providers.length}</span>
        </div>

        <div className="ot-proj-topbar-right" style={{ gap: 6 }}>
          <div className="ot-hub-auto-select" title="自动刷新周期与手动刷新并存">
            <Clock size={12} style={{ color: 'var(--ot-muted)', flex: 'none' }} />
            <select
              className="ot-hub-select"
              value={autoMin}
              onChange={e => onUpdateAutoRefresh?.(Number(e.target.value))}
              data-testid="select-quota-auto-refresh"
            >
              {AUTO_REFRESH_OPTIONS.map(([val, lbl]) => (
                <option key={val} value={val}>{lbl}</option>
              ))}
            </select>
            <CaretDown size={11} className="ot-select-caret" />
          </div>

          <button
            type="button"
            className="ot-btn ot-btn--sm"
            onClick={handleRefreshAll}
            disabled={refreshingAll}
            data-testid="btn-refresh-all-quotas"
          >
            <ArrowsClockwise size={13} className={refreshingAll ? 'ot-spin' : ''} />
            <span>{refreshingAll ? '刷新中…' : '全部刷新'}</span>
          </button>

          <button
            type="button"
            className="ot-btn ot-btn--sm ot-btn--primary"
            onClick={() => setManagerOpen(true)}
            data-testid="btn-manage-quota-providers"
          >
            <SlidersHorizontal size={13} />
            <span>管理订阅源</span>
          </button>
        </div>
      </header>

      <div className="ot-hub-scroll">
        {/* SECTION 1: Native Subscription & Balance Quota Grid (default 4 cards + Expand All) */}
        <div className="ot-hub-section-head">
          <div>
            <h3>订阅余量与 API 余额</h3>
            <p>内置原生检测，置顶前 4 项同步显示在首页。</p>
          </div>
          {enabledProviders.length > 4 ? (
            <button
              type="button"
              className="ot-btn ot-btn--sm"
              onClick={() => setExpandedAll(v => !v)}
              data-testid="btn-toggle-expand-quotas"
            >
              {expandedAll ? <CaretUp size={12} /> : <CaretDown size={12} />}
              <span>{expandedAll ? '收起至 4 项' : `展开全部 (${enabledProviders.length})`}</span>
            </button>
          ) : (
            <button
              type="button"
              className="ot-btn ot-btn--sm"
              onClick={() => setManagerOpen(true)}
              data-testid="btn-expand-more-providers"
            >
              <Plus size={12} />
              <span>全部平台 ({providers.length})</span>
            </button>
          )}
        </div>

        {enabledProviders.length === 0 ? (
          <div className="ot-hub-empty">
            <Gauge size={26} style={{ color: 'var(--ot-muted)' }} />
            <strong>尚未启用监控源</strong>
            <p>点击「管理订阅源」按需开启。</p>
            <button type="button" className="ot-btn ot-btn--primary ot-btn--sm" onClick={() => setManagerOpen(true)}>
              管理订阅源
            </button>
          </div>
        ) : (
          <div className="ot-quota-grid" data-testid="quota-cards-grid">
            {visibleProviders.map(p => {
              const snap = p.lastSnapshot && Object.keys(p.lastSnapshot).length > 0 ? p.lastSnapshot : null
              const isProbing = refreshingIds.has(p.id) || refreshingAll
              const badge = PROVIDER_MONOGRAM[p.providerType] || PROVIDER_MONOGRAM[p.id] || { letter: (p.name || '?')[0], tone: 'custom' }
              const status = snap?.status || 'idle'
              const windows = Array.isArray(snap?.windows) ? snap.windows : []

              return (
                <article
                  key={p.id}
                  className={`ot-quota-card is-${status}`}
                  data-testid={`quota-card-${p.id}`}
                >
                  <div className="ot-quota-card-head">
                    <div className="ot-quota-card-id">
                      <span className={`ot-quota-emblem ot-quota-emblem--${badge.tone}`}>{badge.letter}</span>
                      <div style={{ minWidth: 0 }}>
                        <div className="ot-quota-title-row">
                          <strong>{p.name}</strong>
                          {snap?.plan && <span className="ot-quota-plan-pill">{snap.plan}</span>}
                        </div>
                        <div className="ot-quota-sub">{p.subtitle}</div>
                      </div>
                    </div>
                    <div className="ot-quota-card-acts">
                      <button
                        type="button"
                        className="ot-icon-btn"
                        onClick={() => handleSingleRefresh(p.id)}
                        disabled={isProbing}
                        title={`检测 ${p.name}`}
                        data-testid={`btn-refresh-quota-${p.id}`}
                      >
                        <ArrowsClockwise size={14} className={isProbing ? 'ot-spin' : ''} />
                      </button>
                      <QuotaCardConfigPopover
                        provider={p}
                        highlight={status === 'unconfigured'}
                        openExternal={openConfigId === p.id}
                        onOpenChangeExternal={v => setOpenConfigId(v ? p.id : '')}
                        onSave={onSaveProvider}
                        onRefresh={handleSingleRefresh}
                        onDelete={onDeleteProvider}
                      />
                    </div>
                  </div>

                  <div className="ot-quota-card-body">
                    {!snap ? (
                      <div className="ot-quota-status-msg">
                        <Sparkle size={14} />
                        <span>等待检测，点击刷新或配置密钥</span>
                      </div>
                    ) : status === 'ok' ? (
                      <>
                        {snap.balance && (
                          <div className="ot-quota-balance-block">
                            <div className="ot-quota-balance-val">{snap.balance}</div>
                            {snap.balanceDetail && <div className="ot-quota-balance-sub">{snap.balanceDetail}</div>}
                          </div>
                        )}
                        {windows.length > 0 && (
                          <div className="ot-quota-windows">
                            {windows.map((w, idx) => {
                              const info = describeQuotaWindow(w)
                              const rem = info.remaining ?? 0
                              const resetStr = formatResetCountdown(w.resetsAt)
                              return (
                                <div key={w.id || idx} className={`ot-quota-win${info.reported ? '' : ' is-unreported'}`}>
                                  <div className="ot-quota-win-row">
                                    <span className="ot-quota-win-name">{w.name}</span>
                                    <span className="ot-quota-win-pct">
                                      <strong>{info.label}</strong>
                                      {info.reported && /^\$/.test(String(w.display || '')) && <small> · {w.display}</small>}
                                      {resetStr && <small> · {resetStr}</small>}
                                    </span>
                                  </div>
                                  <div className="ot-quota-meter">
                                    {info.reported && (
                                      <span
                                        className={`ot-quota-meter-fill ${meterToneClass(rem)}`}
                                        style={{ width: `${Math.max(2, Math.min(100, rem))}%` }}
                                      />
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                        {snap.note && (
                          <div className="ot-quota-pace" data-testid={`quota-note-${p.id}`}>{snap.note}</div>
                        )}
                        {snap.paceSummary && (
                          <div className="ot-quota-pace">{localizePaceZh(snap.paceSummary)}</div>
                        )}
                      </>
                    ) : (
                      <div className={`ot-quota-status-msg is-${status === 'error' ? 'error' : 'warn'}`}>
                        <WarningCircle size={14} style={{ flex: 'none', marginTop: 2 }} />
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <span>{snap.error || '暂未获取到额度读数'}</span>
                          <div>
                            <button
                              type="button"
                              className="ot-btn ot-btn--sm"
                              onClick={() => setOpenConfigId(p.id)}
                              data-testid={`btn-inline-config-${p.id}`}
                            >
                              <Key size={12} />
                              <span>配置密钥</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="ot-quota-card-foot">
                    <span className="ot-quota-source-tag">
                      <CloudCheck size={12} />
                      <span>{snap?.sourceLabel || (p.sourceMode === 'direct' ? '密钥直连' : p.sourceMode === 'local' ? '本机检测' : '自动检测')}</span>
                    </span>
                    <span className="ot-quota-checked-at">
                      {status === 'unconfigured'
                        ? '待配置'
                        : p.lastCheckedAt
                          ? `${formatRelativeTime(p.lastCheckedAt)}检测`
                          : '未检测'}
                    </span>
                  </div>
                </article>
              )
            })}
          </div>
        )}

        {hiddenCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
            <button type="button" className="ot-btn ot-btn--sm" onClick={() => setExpandedAll(true)}>
              <CaretDown size={12} /> 展开其余 {hiddenCount} 项
            </button>
          </div>
        )}

        {/* SECTION 2: Native Ekko ToDo Token Usage & Activity Overview */}
        <div className="ot-hub-section-head" style={{ marginTop: 24 }}>
          <div>
            <h3>用量与执行概览</h3>
            <p>
              统计 Ekko ToDo 任务交付与会话 Token 消耗。
              {tokenUsage?.sources?.length ? <span className="ot-usage-source" data-testid="token-usage-source"> 数据来源：{tokenUsage.sources.join('、')}</span> : null}
            </p>
          </div>
          <div className="ot-seg" data-testid="token-usage-range">
            {[['today', '今日'], ['7d', '7 天'], ['30d', '30 天'], ['all', '全部']].map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                className={`ot-seg-btn ${usageRange === val ? 'is-active' : ''}`}
                onClick={() => setUsageRange(val)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="ot-usage-kpi-grid" data-testid="token-usage-kpis">
          <div className="ot-usage-kpi-card">
            <span className="ot-usage-kpi-label"><ChartBar size={13} /> 累计 Token</span>
            <strong className="ot-usage-kpi-val">
              {loadingUsage ? '…' : formatCompactTokens(tokenUsage?.totals?.totalTokens || 0)}
            </strong>
            <small>
              输入 {formatCompactTokens(tokenUsage?.totals?.inputTokens || 0)} · 输出 {formatCompactTokens(tokenUsage?.totals?.outputTokens || 0)}
            </small>
          </div>
          <div className="ot-usage-kpi-card">
            <span className="ot-usage-kpi-label"><Sparkle size={13} /> 缓存命中率</span>
            <strong className="ot-usage-kpi-val">
              {loadingUsage ? '…' : `${tokenUsage?.totals?.cacheHitRate ?? 0}%`}
            </strong>
            <small>缓存读取 {formatCompactTokens(tokenUsage?.totals?.cacheReadTokens || 0)}</small>
          </div>
          <div className="ot-usage-kpi-card">
            <span className="ot-usage-kpi-label"><Coin size={13} /> 会话调用</span>
            <strong className="ot-usage-kpi-val">
              {loadingUsage ? '…' : `${tokenUsage?.totals?.requests || 0} 次`}
            </strong>
            <small>
              推理 {formatCompactTokens(tokenUsage?.totals?.reasoningTokens || 0)}
              {tokenUsage?.totals?.costUsd > 0 ? ` · $${tokenUsage.totals.costUsd.toFixed(2)}` : ''}
            </small>
          </div>
          <div className="ot-usage-kpi-card">
            <span className="ot-usage-kpi-label"><Check size={13} /> 任务交付</span>
            <strong className="ot-usage-kpi-val">
              {tokenUsage?.ekkoActivity?.doneTodos ?? 0} / {tokenUsage?.ekkoActivity?.totalTodos ?? 0}
            </strong>
            <small>
              运行中 {tokenUsage?.ekkoActivity?.activeTodos ?? 0} · 话题 {tokenUsage?.ekkoActivity?.topicCount ?? 0}
            </small>
          </div>
        </div>

        <div className="ot-usage-detail-grid" data-testid="token-usage-charts">
          <div className="ot-usage-panel">
            <div className="ot-usage-panel-head">
              <span>每日 Token 趋势</span>
              {!tokenUsage?.hasTokenLedger && tokenUsage?.allTimeRequests > 0 && usageRange !== 'all' && (
                <button type="button" className="ot-link-btn" onClick={() => setUsageRange('all')}>
                  查看全部 ({tokenUsage.allTimeRequests} 次)
                </button>
              )}
            </div>
            {tokenUsage?.hasTokenLedger && tokenUsage.daily?.length > 0 ? (
              <div className="ot-usage-bars">
                {tokenUsage.daily.map(d => {
                  const h = Math.max(8, Math.round((Number(d.totalTokens || 0) / maxDailyTokens) * 100))
                  return (
                    <div key={d.day} className="ot-usage-bar-col" title={`${d.day}: ${formatCompactTokens(d.totalTokens)} tokens (${d.requests} 次)`}>
                      <div className="ot-usage-bar-track">
                        <span className="ot-usage-bar-fill" style={{ height: `${h}%` }} />
                      </div>
                      <span className="ot-usage-bar-lbl">{d.day.slice(5)}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="ot-usage-empty-chart">
                <span>
                  {tokenUsage?.allTimeRequests > 0
                    ? '当前窗口暂无记录，可切换至「全部」查看。'
                    : '运行大总管或任务后自动汇总趋势。'}
                </span>
              </div>
            )}
          </div>

          <div className="ot-usage-panel">
            <div className="ot-usage-panel-head"><span>按模型分布</span></div>
            {tokenUsage?.hasTokenLedger && tokenUsage.byModel?.length > 0 ? (
              <div className="ot-usage-model-list">
                {tokenUsage.byModel.map(m => (
                  <div key={m.model} className="ot-usage-model-row">
                    <code className="ot-usage-model-name">{m.model}</code>
                    <span className="ot-usage-model-meta">{m.requests} 次</span>
                    <strong>{formatCompactTokens(m.totalTokens)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ot-usage-empty-chart">
                <span>暂无按模型消耗数据。</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Manage All Providers Modal */}
      <Dialog.Root open={managerOpen} onOpenChange={setManagerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="ot-overlay" />
          <Dialog.Content className="ot-modal" style={{ width: 'min(580px, 94vw)' }} data-testid="quota-manager-modal">
            <div className="ot-dialog-head">
              <div>
                <Dialog.Title className="ot-dialog-title">管理订阅源</Dialog.Title>
                <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)', marginTop: 2 }}>
                  置顶前 4 项将同步展示在首页与概览。
                </div>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="ot-icon-btn" aria-label="关闭"><X size={15} /></button>
              </Dialog.Close>
            </div>

            <div className="ot-dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="ot-quota-mgr-list">
                {providers.map(p => (
                  <div key={p.id} className="ot-quota-mgr-row">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>{p.name}</strong>
                        <span className="ot-quota-plan-pill">{p.sourceMode === 'direct' ? '直连' : p.sourceMode === 'local' ? '本机' : '自动'}</span>
                        {p.hasSecret && <span className="ot-quota-secret-badge">已配密钥</span>}
                      </div>
                      <div style={{ fontSize: 'var(--ot-fs-xs)', color: 'var(--ot-muted)' }}>{p.subtitle}</div>
                    </div>
                    <button
                      type="button"
                      className={`ot-icon-btn ${p.pinned ? 'is-accent' : ''}`}
                      title={p.pinned ? '已置顶' : '置顶到首页'}
                      onClick={() => onSaveProvider?.({ id: p.id, pinned: !p.pinned })}
                    >
                      <PushPin size={14} weight={p.pinned ? 'fill' : 'regular'} />
                    </button>
                    <Switch.Root
                      className="ot-switch"
                      checked={p.enabled}
                      onCheckedChange={checked => onSaveProvider?.({ id: p.id, enabled: checked })}
                      data-testid={`switch-quota-enable-${p.id}`}
                    >
                      <Switch.Thumb className="ot-switch-thumb" />
                    </Switch.Root>
                  </div>
                ))}
              </div>

              <div className="ot-setting-card" style={{ gap: 8 }}>
                <strong style={{ fontSize: 'var(--ot-fs-sm)' }}>+ 新增自定义余额接口</strong>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 8 }}>
                  <input
                    className="ot-input ot-input--sm"
                    placeholder="名称（如 中转站余额）"
                    value={customDraft.name}
                    onChange={e => setCustomDraft(d => ({ ...d, name: e.target.value }))}
                  />
                  <input
                    className="ot-input ot-input--sm"
                    placeholder="余额查询接口 URL"
                    value={customDraft.endpoint}
                    onChange={e => setCustomDraft(d => ({ ...d, endpoint: e.target.value }))}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="password"
                    className="ot-input ot-input--sm"
                    style={{ flex: 1 }}
                    placeholder="可选：API Key / Bearer Token"
                    value={customDraft.secretValue}
                    onChange={e => setCustomDraft(d => ({ ...d, secretValue: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="ot-btn ot-btn--primary ot-btn--sm"
                    disabled={!customDraft.name.trim() || !customDraft.endpoint.trim()}
                    onClick={handleAddCustomProvider}
                  >
                    <Plus size={12} /> 添加
                  </button>
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}

import React, { memo, useMemo } from 'react'
import { Gauge, ArrowsClockwise, CaretRight } from '@phosphor-icons/react'

const SHORT_NAMES = {
  kimi: 'Kimi',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  antigravity: '反重力',
  codex: 'Codex',
  claude: 'Claude',
  openrouter: 'OpenRouter',
}

function summarizeProvider(p) {
  const shortName = SHORT_NAMES[p.providerType] || SHORT_NAMES[p.id] || p.name
  const snap = p.lastSnapshot && Object.keys(p.lastSnapshot).length > 0 ? p.lastSnapshot : null
  if (!snap) {
    return { shortName, metric: '待检测', pct: null, tone: 'muted', tooltip: `${p.name} · 点击查看详情` }
  }
  if (snap.status === 'ok') {
    const wins = Array.isArray(snap.windows) ? snap.windows : []
    if (snap.balance && wins.length === 0) {
      return {
        shortName,
        metric: snap.balance,
        pct: null,
        tone: 'ok',
        tooltip: `${p.name} · ${snap.balanceDetail || snap.balance}`,
      }
    }
    if (wins.length > 0) {
      // Surface the tightest remaining window so low quota is spotted immediately
      const scored = wins.map(w => ({
        name: w.name,
        rem: Number(w.remainingPct ?? Math.max(0, 100 - Number(w.usedPct || 0))),
      }))
      const tightest = scored.reduce((a, b) => (b.rem < a.rem ? b : a), scored[0])
      const rounded = Math.round(tightest.rem)
      const tone = rounded <= 15 ? 'danger' : rounded <= 40 ? 'warn' : 'ok'
      const detail = scored.map(w => `${w.name} 剩余 ${Math.round(w.rem)}%`).join(' · ')
      return {
        shortName,
        metric: `${rounded}%`,
        pct: rounded,
        tone,
        tooltip: `${p.name}${snap.plan ? ` (${snap.plan})` : ''} · ${detail}`,
      }
    }
    if (snap.balance) {
      return { shortName, metric: snap.balance, pct: null, tone: 'ok', tooltip: `${p.name} · ${snap.balance}` }
    }
  }
  if (snap.status === 'error') {
    return { shortName, metric: '异常', pct: null, tone: 'danger', tooltip: `${p.name} · ${snap.error || '检测失败'}` }
  }
  return { shortName, metric: '待配置', pct: null, tone: 'muted', tooltip: `${p.name} · ${snap.error || '点击配置'}` }
}

export const HomeQuotaStrip = memo(function HomeQuotaStrip({
  providers = [],
  refreshing = false,
  onOpenQuotaHub,
  onRefreshAll,
  className = '',
  testId = 'home-quota-strip',
}) {
  const items = useMemo(() => {
    const enabled = (providers || []).filter(p => p.enabled)
    return {
      visible: enabled.slice(0, 4).map(p => ({ id: p.id, ...summarizeProvider(p) })),
      extraCount: Math.max(0, enabled.length - 4),
    }
  }, [providers])

  return (
    <div className={`ot-home-quota-strip ${className}`} data-testid={testId}>
      <button
        type="button"
        className="ot-home-quota-lead"
        onClick={onOpenQuotaHub}
        title="查看用量与配额详情"
        data-testid={`${testId}-open`}
      >
        <Gauge size={14} weight="duotone" />
        <span>配额</span>
      </button>

      <div className="ot-home-quota-chips">
        {items.visible.length === 0 ? (
          <button
            type="button"
            className="ot-home-quota-chip is-muted"
            onClick={onOpenQuotaHub}
          >
            <span>未开启监控源</span>
          </button>
        ) : (
          items.visible.map(it => (
            <button
              key={it.id}
              type="button"
              className={`ot-home-quota-chip is-${it.tone}`}
              onClick={onOpenQuotaHub}
              title={it.tooltip}
              data-testid={`home-quota-chip-${it.id}`}
            >
              <span className={`ot-home-quota-dot is-${it.tone}`} />
              <span className="ot-home-quota-name">{it.shortName}</span>
              <strong className="ot-home-quota-val">{it.metric}</strong>
              {it.pct !== null && (
                <span className="ot-home-quota-mini-bar" aria-hidden="true">
                  <span
                    className={`ot-home-quota-mini-fill is-${it.tone}`}
                    style={{ width: `${Math.max(4, Math.min(100, it.pct))}%` }}
                  />
                </span>
              )}
            </button>
          ))
        )}
        {items.extraCount > 0 && (
          <button
            type="button"
            className="ot-home-quota-chip is-muted"
            onClick={onOpenQuotaHub}
            title="展开查看全部配额"
          >
            <span>+{items.extraCount}</span>
          </button>
        )}
      </div>

      <div className="ot-home-quota-acts">
        {onRefreshAll && (
          <button
            type="button"
            className="ot-icon-btn ot-home-quota-refresh"
            onClick={onRefreshAll}
            disabled={refreshing}
            title="刷新配额余量"
            aria-label="刷新配额余量"
            data-testid={`${testId}-refresh`}
          >
            <ArrowsClockwise size={13} className={refreshing ? 'ot-spin' : ''} />
          </button>
        )}
        <button
          type="button"
          className="ot-home-quota-more"
          onClick={onOpenQuotaHub}
          title="进入用量与配额页"
        >
          <span>详情</span>
          <CaretRight size={12} />
        </button>
      </div>
    </div>
  )
})

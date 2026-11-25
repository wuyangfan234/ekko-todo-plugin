import React, { useEffect, useState } from 'react'
import * as Slider from '@radix-ui/react-slider'
import { Brain } from '@phosphor-icons/react'
import { getEffortMeta, normalizeEffortStops } from '../utils.js'
import { effortTickColumns, EFFORT_PHONE_MAX_COLUMNS } from '../layout.js'

/**
 * Precision discrete Reasoning / Thinking Effort slider backed by @radix-ui/react-slider.
 * - Mathematically aligns track endpoints (0%..100%) to the exact pixel centers of the first & last tick columns.
 * - Uses 0ms optimistic local index while dragging, committing once on pointer release / keyboard step / direct click.
 */
export function ReasoningSlider({
  value = '',
  supportedEfforts = [],
  onChange,
  disabled = false,
  compact = false,
  testId = 'reasoning-slider',
}) {
  const stops = normalizeEffortStops(supportedEfforts, value)
  const normalizedVal = String(value || '').toLowerCase()
  const propIndex = Math.max(0, stops.indexOf(normalizedVal))
  const [localIndex, setLocalIndex] = useState(propIndex)

  useEffect(() => {
    setLocalIndex(propIndex)
  }, [propIndex])

  const clampedIndex = Math.max(0, Math.min(stops.length - 1, localIndex))
  const currentKey = stops[clampedIndex] ?? ''
  const meta = getEffortMeta(currentKey)
  const maxIndex = Math.max(1, stops.length - 1)
  // Aligns 0% to center of first column (0.5 / N) and 100% to center of last column ((N - 0.5) / N)
  const edgeInsetPct = 50 / stops.length

  const commitIndex = idx => {
    const safeIdx = Math.max(0, Math.min(stops.length - 1, idx))
    setLocalIndex(safeIdx)
    const next = stops[safeIdx] ?? ''
    if (next !== normalizedVal) onChange?.(next)
  }

  return (
    <div
      className={`ot-effort-box ${compact ? 'is-compact' : ''} ${stops.length > EFFORT_PHONE_MAX_COLUMNS ? 'has-tick-rows' : ''} ot-effort-tone--${meta.tone}`}
      data-testid={testId}
      data-effort={currentKey || 'default'}
    >
      <div className="ot-effort-head">
        <span className="ot-effort-title">
          <Brain size={compact ? 13 : 14} weight="duotone" />
          <span>思考等级</span>
        </span>
        <span className={`ot-effort-pill ot-effort-pill--${meta.tone}`} data-testid={`${testId}-value`}>
          {meta.label}
        </span>
      </div>

      <div className="ot-effort-slider-wrap">
        <div className="ot-effort-track" style={{ paddingLeft: `${edgeInsetPct}%`, paddingRight: `${edgeInsetPct}%` }}>
          <Slider.Root
            className="ot-slider-root"
            min={0}
            max={maxIndex}
            step={1}
            value={[clampedIndex]}
            disabled={disabled}
            onValueChange={vals => setLocalIndex(vals?.[0] ?? 0)}
            onValueCommit={vals => commitIndex(vals?.[0] ?? 0)}
            aria-label="模型思考等级"
          >
            <Slider.Track className="ot-slider-track">
              <Slider.Range className="ot-slider-range" />
            </Slider.Track>
            <Slider.Thumb className="ot-slider-thumb" aria-label={`思考等级：${meta.label}`} />
          </Slider.Root>
        </div>

        <div
          className="ot-effort-ticks"
          style={{
            '--ot-effort-cols': effortTickColumns(stops.length, { phone: false }),
            '--ot-effort-cols-phone': effortTickColumns(stops.length, { phone: true }),
          }}
        >
          {stops.map((stop, idx) => {
            const m = getEffortMeta(stop)
            const isSelected = idx === clampedIndex
            return (
              <button
                key={stop || '__default'}
                type="button"
                disabled={disabled}
                className={`ot-effort-tick ${isSelected ? 'is-active' : ''}`}
                onClick={() => commitIndex(idx)}
                data-testid={`${testId}-stop-${stop || 'default'}`}
              >
                <span className="ot-effort-tick-dot" />
                <span>{m.short}</span>
              </button>
            )
          })}
        </div>
      </div>

      {!compact && (
        <div className="ot-effort-desc">{meta.desc}</div>
      )}
    </div>
  )
}

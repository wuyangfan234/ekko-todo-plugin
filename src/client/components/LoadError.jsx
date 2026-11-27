import React from 'react'
import { ArrowsClockwise, WarningCircle } from '@phosphor-icons/react'

/**
 * Todo #100: a failed load shown as an error with a retry button, never as an empty list.
 * `className` reuses the empty-state class of the place it stands in (ot-tree-empty / ot-branch-empty).
 */
export function LoadError({ message, onRetry, className = 'ot-tree-empty', testId, inline = false }) {
  if (!message) return null
  const Tag = inline ? 'span' : 'div'
  return (
    <Tag
      className={className}
      role="alert"
      data-testid={testId}
      style={{ display: inline ? 'inline-flex' : 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap', color: 'var(--ek-brick)' }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, overflowWrap: 'anywhere' }}>
        <WarningCircle size={13} style={{ flex: 'none' }} />
        <span>{message}</span>
      </span>
      {onRetry && (
        <button type="button" className="ot-btn ot-btn--sm" onClick={onRetry} data-testid={testId ? `${testId}-retry` : undefined}>
          <ArrowsClockwise size={12} />
          <span>重试</span>
        </button>
      )}
    </Tag>
  )
}

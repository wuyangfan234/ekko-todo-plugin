import React from 'react'
import { WarningCircle } from '@phosphor-icons/react'
import { LOOP_LIVE_NOTICE } from '../../shared/loop-guard.mjs'

/** Stored system notice: a looping Chief turn was stopped by the server. */
export function LoopStoppedNotice({ text }) {
  return (
    <div className="ot-loop-notice" role="alert" data-testid="loop-stopped-notice">
      <WarningCircle size={15} weight="fill" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}

/** Live warning: the stream already repeats itself, the stop is on its way. */
export function LoopLiveNotice() {
  return (
    <div className="ot-loop-notice ot-loop-notice--live" role="status" data-testid="loop-live-notice">
      <WarningCircle size={15} weight="fill" aria-hidden="true" />
      <span>{LOOP_LIVE_NOTICE}</span>
    </div>
  )
}

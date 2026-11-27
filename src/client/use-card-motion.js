// Todo #99: motion state of one board card (entrance, landing, drag). The numbers are in motion.js.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { cardMotionClasses, cardMotionProps } from './motion.js'

/** Attribute set on `.ot-shell` while a card is dragged, so the real drop target (the composer) can show itself. */
export const CARD_DRAG_ATTR = 'data-card-dragging'

/**
 * @param {{ enterDelayMs?: number, justMovedCol?: string, doneFlash?: boolean }} input
 * @returns {{ motionProps: object, motionClass: string, dragging: boolean, onDragStart: Function, onDragEnd: Function, onAnimationComplete: Function }}
 */
export function useCardMotion({ enterDelayMs = -1, justMovedCol = '', doneFlash = false } = {}) {
  const reduced = Boolean(useReducedMotion())
  // The entrance belongs to the mount: a later render must neither replay it nor change its delay.
  const [mountDelay] = useState(enterDelayMs)
  const [entered, setEntered] = useState(mountDelay < 0)
  const [dragging, setDragging] = useState(false)
  const shellRef = useRef(null)

  const clearShell = useCallback(() => {
    shellRef.current?.removeAttribute?.(CARD_DRAG_ATTR)
    shellRef.current = null
  }, [])
  // A card removed in the middle of a drag never gets dragend.
  useEffect(() => clearShell, [clearShell])

  const onDragStart = useCallback(e => {
    setDragging(true)
    const shell = e?.currentTarget?.closest?.('.ot-shell') || null
    shellRef.current = shell
    shell?.setAttribute?.(CARD_DRAG_ATTR, '')
  }, [])
  const onDragEnd = useCallback(() => {
    setDragging(false)
    clearShell()
  }, [clearShell])
  const onAnimationComplete = useCallback(() => setEntered(true), [])

  return {
    motionProps: cardMotionProps({ enterDelayMs: mountDelay, entered, landing: Boolean(justMovedCol), dragging, reduced }),
    motionClass: cardMotionClasses({ justMovedCol, dragging, doneFlash }),
    dragging,
    onDragStart,
    onDragEnd,
    onAnimationComplete,
  }
}

// Todo #99: completion confetti. CSS-only particles (transform + opacity), no dependency; numbers in motion.js.
import React, { memo, useEffect, useMemo } from 'react'
import { CONFETTI, makeConfettiParticles } from '../motion.js'

/** One burst at (x, y) of the layer. Removes itself through `onDone(id)` after CONFETTI.lifeMs. */
export const ConfettiBurst = memo(function ConfettiBurst({ id, x = 0, y = 0, seed = 1, count = CONFETTI.particles, onDone }) {
  const particles = useMemo(() => makeConfettiParticles({ count, seed }), [count, seed])

  useEffect(() => {
    const timer = setTimeout(() => onDone?.(id), CONFETTI.lifeMs)
    return () => clearTimeout(timer)
  }, [id, onDone])

  return (
    <span className="ot-confetti-burst" style={{ transform: `translate(${x}px, ${y}px)` }} data-testid="confetti-burst" data-burst={id}>
      {particles.map(p => (
        <span key={p.i} className="ot-confetti-x" style={{ '--dx': `${p.dx}px`, '--d': `${p.delay}ms` }}>
          <span
            className={`ot-confetti-p ot-confetti-p--${p.tone} ot-confetti-p--${p.shape}${p.soft ? ' is-soft' : ''}`}
            style={{ '--rise': `${p.rise}px`, '--fall': `${p.fall}px`, '--rot': `${p.rot}deg`, '--d': `${p.delay}ms` }}
          />
        </span>
      ))}
    </span>
  )
})

/** Particle layer of the board: covers the pane, never takes a pointer event, clips what leaves it. */
export const ConfettiLayer = memo(function ConfettiLayer({ bursts = [], onDone }) {
  if (bursts.length === 0) return null
  return (
    <div className="ot-confetti-layer" aria-hidden="true" data-testid="confetti-layer">
      {bursts.map(b => (
        <ConfettiBurst key={b.id} id={b.id} x={b.x} y={b.y} seed={b.seed} onDone={onDone} />
      ))}
    </div>
  )
})

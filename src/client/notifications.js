/**
 * Completion & Human-Attention Notification Engine (Popup Toast + Browser Notification + Web Audio Chime).
 * Zero external audio assets — uses Web Audio API harmonic chime synthesis.
 */

let sharedAudioCtx = null

function getAudioContext() {
  if (typeof window === 'undefined') return null
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  if (!sharedAudioCtx) {
    try { sharedAudioCtx = new Ctx() } catch { return null }
  }
  if (sharedAudioCtx.state === 'suspended') {
    void sharedAudioCtx.resume().catch(() => {})
  }
  return sharedAudioCtx
}

/**
 * Play a crisp, non-intrusive synthesized notification tone.
 * @param {'success' | 'attention' | 'error'} tone
 */
export function playNotificationChime(tone = 'success') {
  const ctx = getAudioContext()
  if (!ctx) return false
  try {
    const now = ctx.currentTime
    const presets = {
      // Warm ascending major triad (C5 -> E5 -> G5)
      success: [
        { freq: 523.25, start: 0, dur: 0.16, gain: 0.09 },
        { freq: 659.25, start: 0.08, dur: 0.18, gain: 0.09 },
        { freq: 783.99, start: 0.16, dur: 0.3, gain: 0.08 },
      ],
      // Gentle two-note chime (D5 -> A5) for human decision/review
      attention: [
        { freq: 587.33, start: 0, dur: 0.18, gain: 0.085 },
        { freq: 880.0, start: 0.11, dur: 0.28, gain: 0.085 },
      ],
      // Low subtle double pulse (G4 -> Eb4) for error/failure
      error: [
        { freq: 392.0, start: 0, dur: 0.16, gain: 0.09 },
        { freq: 311.13, start: 0.14, dur: 0.26, gain: 0.09 },
      ],
    }
    const notes = presets[tone] || presets.success
    for (const n of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = tone === 'error' ? 'triangle' : 'sine'
      osc.frequency.setValueAtTime(n.freq, now + n.start)
      gain.gain.setValueAtTime(0.0001, now + n.start)
      gain.gain.exponentialRampToValueAtTime(n.gain, now + n.start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + n.start)
      osc.stop(now + n.start + n.dur + 0.02)
    }
    return true
  } catch {
    return false
  }
}

export function getBrowserNotificationPermission() {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported'
  return window.Notification.permission || 'default'
}

export async function requestBrowserNotificationPermission() {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported'
  try {
    return await window.Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

export function showBrowserNotification({ title, body, tag = '', onClick } = {}) {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return false
  if (window.Notification.permission !== 'granted') return false
  try {
    const n = new window.Notification(title || 'Ekko ToDo', {
      body: body || '',
      tag: tag || undefined,
      silent: true, // sound is handled cleanly by our chime controller
    })
    n.onclick = () => {
      try { window.focus() } catch {}
      onClick?.()
      n.close()
    }
    setTimeout(() => { try { n.close() } catch {} }, 8000)
    return true
  } catch {
    return false
  }
}

/**
 * Diff previous and next workbench snapshots to detect newly completed, failed,
 * or human-attention-requiring Todos and Topics.
 */
export function detectCompletionEvents(prevState, nextState) {
  if (!prevState || !nextState) return []
  const events = []

  const prevTodos = new Map((prevState.todos || []).map(td => [td.id, td]))
  for (const td of (nextState.todos || [])) {
    const old = prevTodos.get(td.id)
    if (!old) continue
    if (old.phase !== 'done' && td.phase === 'done') {
      events.push({
        id: `done:${td.id}:${td.revision}`,
        tone: 'success',
        title: `任务 #${td.number} 已完成`,
        body: td.title,
        todoId: td.id,
        projectId: td.projectId,
      })
    } else if (old.phase !== 'failed' && td.phase === 'failed') {
      events.push({
        id: `failed:${td.id}:${td.revision}`,
        tone: 'error',
        title: `任务 #${td.number} 执行失败`,
        body: td.lastError ? `${td.title} — ${td.lastError.slice(0, 80)}` : td.title,
        todoId: td.id,
        projectId: td.projectId,
      })
    } else if (
      !(old.gateOwner === 'human' && (old.phase === 'confirm' || old.phase === 'review'))
      && td.gateOwner === 'human'
      && (td.phase === 'confirm' || td.phase === 'review')
    ) {
      const gateLabel = td.gateKind === 'merge'
        ? '审查通过，待你合并验收'
        : td.gateKind === 'deliverable'
          ? '调研成果已交付，待你验收'
          : td.gateKind === 'plan'
          ? '方案已就绪，待你确认'
          : td.gateKind === 'question'
            ? '执行中遇到决策问题，等你回复'
            : '待你处理'
      events.push({
        id: `gate:${td.id}:${td.revision}`,
        tone: 'attention',
        title: `任务 #${td.number} ${gateLabel}`,
        body: td.title,
        todoId: td.id,
        projectId: td.projectId,
      })
    }
  }

  const prevTopics = new Map((prevState.topics || []).map(tp => [tp.id, tp]))
  for (const tp of (nextState.topics || [])) {
    const old = prevTopics.get(tp.id)
    if (!old) continue
    const oldWait = String(old.brief?.waitingOnYou || '').trim()
    const newWait = String(tp.brief?.waitingOnYou || '').trim()
    if (!oldWait && newWait) {
      events.push({
        id: `topic-wait:${tp.id}:${tp.brief?.updatedAt || tp.updatedAt}`,
        tone: 'attention',
        title: `大总管待你确认 · ${tp.title}`,
        body: newWait.slice(0, 120),
        topicId: tp.id,
      })
    } else if (old.isRunning && !tp.isRunning && !tp.lastError && !newWait) {
      // Only chime softly when a Chief turn finishes cleanly with a new assistant message
      if ((tp.messages?.length || 0) > (old.messages?.length || 0)) {
        const lastMsg = tp.messages[tp.messages.length - 1]
        if (lastMsg?.kind === 'chief') {
          events.push({
            id: `chief-done:${tp.id}:${lastMsg.id}`,
            tone: 'success',
            title: `大总管已完成回复 · ${tp.title}`,
            body: String(lastMsg.text || '').replace(/[#*`>\n]+/g, ' ').trim().slice(0, 100),
            topicId: tp.id,
          })
        }
      }
    }
  }

  return events.slice(0, 3)
}

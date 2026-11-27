// 0.9.70 (#85): the card's stall hint, read from the snapshot's derived `todo.stall` ({ silentMs, suspicious,
// since }). Only cards the server marked as possibly stuck (soft threshold passed) get a hint; nothing is
// stored on the card. Returns null or { minutes, text, title }.
export function stallHint(todo) {
  const stall = todo?.stall
  if (!stall || !stall.suspicious) return null
  if (todo.phase !== 'building' && todo.phase !== 'reviewing') return null
  const minutes = Math.max(1, Math.floor((Number(stall.silentMs) || 0) / 60000))
  return {
    minutes,
    text: `已静默 ${minutes} 分钟`,
    title: `这张卡已 ${minutes} 分钟没有任何事件，疑似卡住。运行没有被打断；超过硬阈值仍无事件时会自动退回（工作树与分支保留）。`,
  }
}

// 0.9.70 (#91): the watchdog thresholds the server actually uses (orchestrator stallSettings): soft clamped to
// 1 min – 4 h, hard to 5 min – 12 h and kept at least one minute above the soft one, cooldown 1 min – 1 h.
// `raised` is true when the hard threshold in effect is above the one the user saved (the lower bound applied).
const clampMs = (v, min, max, dflt) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : dflt
}
export function effectiveStallThresholds(settings) {
  const warnMs = clampMs(settings?.buildStallWarnMs, 60000, 14400000, 600000)
  const savedHealMs = clampMs(settings?.buildStallHealMs, 300000, 43200000, 1800000)
  const healMs = Math.max(savedHealMs, warnMs + 60000)
  const cooldownMs = clampMs(settings?.buildStallCooldownMs, 60000, 3600000, 300000)
  const min = ms => Math.round(ms / 60000)
  const raised = healMs > savedHealMs
  return {
    warnMin: min(warnMs),
    healMin: min(healMs),
    cooldownMin: min(cooldownMs),
    raised,
    text: `实际生效：提示 ${min(warnMs)} 分钟 / 退回 ${min(healMs)} 分钟${raised ? '（已按下限调整：退回阈值至少比提示阈值多 1 分钟）' : ''}`,
  }
}

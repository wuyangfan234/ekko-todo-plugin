// Pure label helper for one quota window on a Quota Hub card.
// A window with usageReported === false means the vendor confirmed the period but sent no
// usage number; it must not be shown as "剩余 100%". Snapshots written before v0.9.26 carry
// no flag and keep their previous rendering.
export function describeQuotaWindow(w) {
  if (w && w.usageReported === false) {
    return { reported: false, label: String(w.display || '官方未返回已用量'), remaining: null }
  }
  const rem = Number(w?.remainingPct ?? Math.max(0, 100 - Number(w?.usedPct || 0)))
  return { reported: true, label: `剩余 ${rem}%`, remaining: rem }
}

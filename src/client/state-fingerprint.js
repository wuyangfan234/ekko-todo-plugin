// Decides whether a new board snapshot must re-render. Kept free of JSX so node --test can cover it.

export function topicScalarKey(t) {
  if (!t || typeof t !== 'object') return ''
  return Object.keys(t).sort()
    .filter(k => t[k] === null || ['string', 'number', 'boolean'].includes(typeof t[k]))
    .map(k => `${k}=${t[k]}`)
    .join('|')
}

export function computeStateFingerprint(s) {
  if (!s) return ''
  return JSON.stringify([
    s.settings?.updatedAt,
    s.settings?.maxConcurrentBuilds,
    s.settings?.onboardingCompleted,
    s.settings?.sessionIsolationMode,
    s.settings?.sessionCategoryName,
    s.settings?.chiefStrictOrchestration,
    s.settings?.notifyPopup,
    s.settings?.notifySound,
    s.settings?.notifyBrowser,
    s.settings?.quotaAutoRefreshMin,
    s.runtime?.isolationSync?.running,
    s.runtime?.isolationSync?.done,
    s.runtime?.isolationSync?.lastFinishedAt,
    s.runtime?.githubCli?.authenticated,
    s.runtime?.githubCli?.username,
    s.counts,
    s.projects?.map(p => `${p.id}:${p.updatedAt}:${p.displayName || ''}:${(p.avatar || '').length}:${p.accent}`),
    s.agents?.map(a => `${a.id}:${a.updatedAt}:${a.roleLabel || ''}:${a.avatar || ''}:${a.maxTurns}:${a.modelConfigs?.length}:${a.cooldowns?.length || 0}`),
    s.memories?.map(m => `${m.id}:${m.updatedAt}:${m.enabled}:${m.pinned}`),
    // Every scalar topic field takes part: since v0.9.11 settings such as autopilot, project or model config no
    // longer bump updatedAt, so listing fields by hand made those changes invisible (AUTO switch looked dead).
    s.topics?.map(t => [
      topicScalarKey(t),
      t.queuedItems?.length || 0,
      t.liveActivity?.activeTool || '',
      t.liveActivity?.toolCount || 0,
      t.messages?.length,
      // 0.9.42: a launch that fails after the send call answered writes its reason on a message that is
      // already in the list, so the length alone does not change.
      t.messages?.reduce((n, m) => n + (m?.sendError ? 1 : 0), 0) || 0,
      t.brief?.updatedAt || 0,
      t.brief?.waitingRecommendation || '',
    ].join(':')),
    s.todos?.map(td => `${td.id}:${td.revision}:${td.liveActivity?.activeTool || ''}:${td.liveActivity?.toolCount || 0}:${td.buildChat?.length || 0}:${td.stall?.suspicious ? Math.floor((td.stall.silentMs || 0) / 60000) : ''}`),
    s.schedules?.map(sc => `${sc.id}:${sc.updatedAt}:${sc.enabled}:${sc.nextRunAt}:${sc.lastRunAt}:${sc.lastStatus}`),
    s.quotaProviders?.map(qp => `${qp.id}:${qp.updatedAt}:${qp.enabled}:${qp.pinned}:${qp.sourceMode}:${qp.hasSecret}:${qp.lastCheckedAt}`),
  ])
}

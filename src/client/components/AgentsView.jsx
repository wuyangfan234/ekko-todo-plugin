import React, { useMemo, useState } from 'react'
import { CaretLeft, Robot, Plus } from '@phosphor-icons/react'
import { AgentManager } from './AgentManager.jsx'

/** Full-page Agent configuration (list on the left, full-width editor on the right). */
export function AgentsView({
  ctx,
  state,
  busy,
  initialAgentId = '',
  initialCreate = 0,
  onBack,
  onSaveAgent,
  onDeleteAgent,
  onClearCooldowns,
  onFetchModelCatalog,
  onAskChiefCreateAgent,
}) {
  const [createSignal, setCreateSignal] = useState(initialCreate)
  const rt = state.runtime || {}
  const liveEngines = useMemo(() => {
    const base = [
      { id: 'hermes', name: 'Hermes Agent', installed: true, version: '宿主原生' },
      ...(rt.liveEngines || []),
    ]
    const seen = new Set()
    return base
      .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true })
      .sort((a, b) => Number(b.installed) - Number(a.installed))
  }, [rt.liveEngines])
  const installedEngineOptions = liveEngines.filter(e => e.installed)
  const count = (state.agents || []).length

  return (
    <section className="ot-sch-view ot-agents-view" data-testid="agents-view">
      <header className="ot-proj-topbar">
        <div className="ot-proj-topbar-left">
          <button type="button" className="ot-icon-btn" onClick={onBack} title="返回工作台 (⌘[)" aria-label="返回工作台" data-testid="btn-agents-back">
            <CaretLeft size={16} weight="bold" />
          </button>
          <Robot size={16} weight="duotone" style={{ color: 'var(--ot-text-2)' }} />
          <strong className="ot-proj-topbar-name">Agent</strong>
          <span className="ot-hub-count-pill">{count}</span>
        </div>
        <div className="ot-proj-topbar-right">
          <button
            type="button"
            className="ot-btn ot-btn--indigo ot-btn--sm"
            onClick={() => setCreateSignal(n => n + 1)}
            data-testid="btn-agents-new"
          >
            <Plus size={13} weight="bold" />
            <span>新建 Agent</span>
          </button>
        </div>
      </header>
      <div className="ot-agents-scroll">
        <AgentManager
          ctx={ctx}
          state={state}
          liveEngines={liveEngines}
          installedEngineOptions={installedEngineOptions}
          busy={busy}
          layout="page"
          initialAgentId={initialAgentId}
          createSignal={createSignal}
          onSaveAgent={onSaveAgent}
          onDeleteAgent={onDeleteAgent}
          onClearCooldowns={onClearCooldowns}
          onFetchModelCatalog={onFetchModelCatalog}
          onAskChiefCreateAgent={onAskChiefCreateAgent}
        />
      </div>
    </section>
  )
}

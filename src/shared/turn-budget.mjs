// Agent turn budget (#84): what `maxTurns` means, what is sent to the host, and what the host
// actually enforces.
//
// Host facts (Hermes Web UI 0.8.31, verified by reading the installed host):
// - `run.host.sessions.run(id, input, options)` posts `options` to `/api/studio/chat-run/runs`;
//   the chat-run handler forwards only storage_message/model/provider/workspace/
//   background_delegation_enabled/reasoning_effort to the agent bridge. `max_turns` is dropped.
// - The bridge builds every agent with `max_iterations = _cfg_max_turns(cfg, 90)`:
//   env HERMES_BRIDGE_MAX_TURNS (> 0) wins, else `agent.max_turns || max_turns || 90`
//   from ~/.hermes/config.yaml. A `0` there is falsy and becomes 90, not "unlimited".
// - Hermes itself (`hermes_cli/config.py resolve_turn_limit`) reads 0 as unlimited, so the plugin
//   always sends `max_turns` (0 included) for hosts that start honouring it.
// So the per-agent value is sent but not enforced; the real cap is the host value computed below.

/** Server-side clamp for stored `maxTurns` (db.mjs saveAgent). */
export const MAX_AGENT_TURNS = 2000
/**
 * Default `maxTurns` for an agent created without one (#92): new agents, the preset chief / builder /
 * reviewer and team-preset workers. Plugin-only default; the host config is never touched. Stored
 * values (including an explicit 0 = unlimited) are never rewritten to it.
 */
export const DEFAULT_AGENT_TURNS = 500
/** Fallback the Web UI agent bridge uses when config.yaml gives no positive agent.max_turns. */
export const HOST_BRIDGE_DEFAULT_TURNS = 90
/** Preset chips in the Agent editor. 0 = unlimited. */
export const TURN_PRESETS = [0, 100, 300, 500, 1000, MAX_AGENT_TURNS]

/** Clamp any input to the stored range 0..2000 (non-numbers become 0 = unlimited). */
export function clampAgentTurns(raw) {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_AGENT_TURNS, Math.round(n))) : 0
}

/** Run option sent with every sessions.run: always present, 0 meaning unlimited. */
export function turnRunOptions(agent) {
  return { max_turns: clampAgentTurns(agent?.maxTurns) }
}

function positiveInt(v) {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * The turn cap the host really applies to a plugin session.
 * @param {{ configured?: number|null, envOverride?: string|number|null }} input
 *   configured = agent.max_turns read from config.yaml (null when absent),
 *   envOverride = HERMES_BRIDGE_MAX_TURNS.
 * @returns {{ effective: number, source: 'env'|'config'|'bridge-default', configured?: number }}
 *   configured is omitted when config.yaml has no agent.max_turns.
 */
export function hostTurnBudget({ configured = null, envOverride = null } = {}) {
  const raw = Number.isInteger(configured) && configured >= 0 ? { configured } : {}
  const env = positiveInt(envOverride)
  if (env) return { effective: env, source: 'env', ...raw }
  const cfg = positiveInt(configured)
  if (cfg) return { effective: cfg, source: 'config', ...raw }
  return { effective: HOST_BRIDGE_DEFAULT_TURNS, source: 'bridge-default', ...raw }
}

/** Preset chip label: 0 is just "不限"; the host value is never folded into it. */
export function turnPresetLabel(val) {
  return val === 0 ? '不限' : String(val)
}

/** Collapsed-section summary, showing the real cap when the host value is known. */
export function turnSummary(maxTurns, budget) {
  const n = clampAgentTurns(maxTurns)
  const base = n > 0 ? `${n} 轮` : '轮次不限'
  const eff = budget?.effective
  return eff && eff !== n ? `${base}（实际 ${eff}）` : base
}

const SOURCE_TEXT = {
  env: '来自宿主环境变量 HERMES_BRIDGE_MAX_TURNS',
  config: '来自 ~/.hermes/config.yaml 的 agent.max_turns',
  'bridge-default': 'config.yaml 未设正整数 agent.max_turns，宿主按默认 90',
}

/** One-line truth about the effective cap plus how to change it. */
export function turnBudgetNote(budget) {
  if (!budget?.effective) return ''
  return `宿主实际生效上限：${budget.effective} 轮（${SOURCE_TEXT[budget.source] || '宿主设置'}）。`
    + '当前宿主不接受单个 Agent 的轮次设置：这里的值会随请求发送，但实际以宿主上限为准。'
    + '要放宽，把 ~/.hermes/config.yaml 的 agent.max_turns 改成更大的正整数（如 100000），新建的会话生效；'
    + '注意经 Web UI 运行的会话里写 0 会被当成 90，不是不限。'
}

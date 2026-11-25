import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaretLeft,
  CaretDown,
  CaretRight,
  ArrowsClockwise,
  ListMagnifyingGlass,
  ChatCircleText,
  Wrench,
  Brain,
  User,
  BellRinging,
  WarningCircle,
  CheckCircle,
  CircleNotch,
  Copy,
  Check,
} from '@phosphor-icons/react'
import { formatModelShort } from '../utils.js'

const KIND_LABEL = { chief: '总管', build: '构建', review: '审查' }
const FILTERS = [
  ['all', '全部'],
  ['assistant', '回复'],
  ['tool', '工具调用'],
  ['reasoning', '推理'],
  ['error', '仅异常'],
]

function fmtClock(sec) {
  if (!sec) return '--:--:--'
  return new Date(sec * 1000).toLocaleTimeString('zh-CN', { hour12: false })
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`
}

function fmtTokens(n) {
  const v = Number(n || 0)
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return String(v)
}

function CopyBtn({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="ot-icon-btn ek-trace-copy"
      title="复制"
      onClick={e => {
        e.stopPropagation()
        navigator.clipboard?.writeText?.(text).catch(() => {})
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

function ClipNote({ clip }) {
  if (!clip?.truncated) return null
  return <div className="ek-trace-clip">内容较长，仅显示前 {clip.text.length} / {clip.length} 字</div>
}

function ToolStep({ step, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  const firstArgLine = useMemo(() => {
    const t = step.args?.text || ''
    try {
      const obj = JSON.parse(t)
      const key = ['command', 'path', 'query', 'todo_id', 'url', 'code', 'pattern'].find(k => obj?.[k])
      if (key) return String(obj[key]).split('\n')[0].slice(0, 140)
    } catch {}
    return t.replace(/\s+/g, ' ').slice(0, 140)
  }, [step.args])
  const status = step.pending ? 'pending' : step.failed ? 'error' : 'ok'
  return (
    <div className={`ek-trace-tool is-${status}`}>
      <button type="button" className="ek-trace-tool-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <Wrench size={13} className="ek-trace-tool-ico" />
        <code className="ek-trace-tool-name">{step.name}</code>
        <span className="ek-trace-tool-arg">{firstArgLine}</span>
        <span className="ek-trace-tool-meta">
          {step.pending ? (
            <><CircleNotch size={12} className="ot-spin" /> 执行中</>
          ) : step.failed ? (
            <><WarningCircle size={12} /> 异常</>
          ) : (
            <><CheckCircle size={12} /> {step.durationSec != null ? fmtDuration(step.durationSec) : '完成'}</>
          )}
        </span>
      </button>
      {open && (
        <div className="ek-trace-tool-body">
          <div className="ek-trace-io">
            <div className="ek-trace-io-head"><span>参数</span><CopyBtn text={step.args?.text || ''} /></div>
            <pre className="ek-trace-pre">{step.args?.text || '（无参数）'}</pre>
            <ClipNote clip={step.args} />
          </div>
          <div className="ek-trace-io">
            <div className="ek-trace-io-head"><span>结果</span>{step.result?.text ? <CopyBtn text={step.result.text} /> : null}</div>
            <pre className="ek-trace-pre">{step.pending ? '等待返回…' : (step.result?.text || '（无输出）')}</pre>
            <ClipNote clip={step.result} />
          </div>
        </div>
      )}
    </div>
  )
}

function TextStep({ step }) {
  const [open, setOpen] = useState(step.kind !== 'reasoning' && step.kind !== 'wake')
  const Icon = step.kind === 'assistant' ? ChatCircleText : step.kind === 'reasoning' ? Brain : step.kind === 'wake' ? BellRinging : User
  const label = { assistant: '模型回复', reasoning: '推理过程', user: '输入指令', wake: '系统唤醒', system: '系统消息' }[step.kind] || step.kind
  const text = step.text?.text || ''
  const preview = text.replace(/\s+/g, ' ').slice(0, 160)
  return (
    <div className={`ek-trace-text is-${step.kind}`}>
      <button type="button" className="ek-trace-text-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <Icon size={13} />
        <strong>{label}</strong>
        {!open && <span className="ek-trace-preview">{preview}</span>}
        {step.tokens > 0 && <span className="ek-trace-chip">{fmtTokens(step.tokens)} tok</span>}
        <CopyBtn text={text} />
      </button>
      {open && (
        <>
          <div className="ek-trace-body">{text}</div>
          <ClipNote clip={step.text} />
        </>
      )}
    </div>
  )
}

export function SessionTraceView({ ctx, initialSessionId = '', onBack }) {
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState(initialSessionId)
  const [trace, setTrace] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const bodyRef = useRef(null)
  const stickBottomRef = useRef(true)

  useEffect(() => { if (initialSessionId) setSelectedId(initialSessionId) }, [initialSessionId])

  const load = useCallback(async (sid, { silent = false } = {}) => {
    if (!silent) setLoading(true)
    try {
      const res = await ctx.rpc.call('get-session-trace', sid ? { sessionId: sid } : {})
      setSessions(res?.sessions || [])
      setTrace(res?.trace || null)
      setError('')
      if (!sid && res?.sessions?.length) setSelectedId(cur => cur || res.sessions[0].sessionId)
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [ctx])

  useEffect(() => { void load(selectedId) }, [selectedId, load])

  // Live refresh while the selected session is running
  useEffect(() => {
    if (!trace?.running) return
    const timer = setInterval(() => { void load(selectedId, { silent: true }) }, 4000)
    return () => clearInterval(timer)
  }, [trace?.running, selectedId, load])

  useEffect(() => {
    const el = bodyRef.current
    if (el && stickBottomRef.current) el.scrollTop = el.scrollHeight
  }, [trace?.steps?.length])

  const steps = useMemo(() => {
    const all = trace?.steps || []
    if (filter === 'all') return all
    if (filter === 'error') return all.filter(s => s.kind === 'tool' && s.failed)
    if (filter === 'assistant') return all.filter(s => s.kind === 'assistant' || s.kind === 'user' || s.kind === 'wake')
    return all.filter(s => s.kind === filter)
  }, [trace, filter])

  const grouped = useMemo(() => {
    const g = { chief: [], build: [], review: [] }
    for (const s of sessions) (g[s.kind] || (g[s.kind] = [])).push(s)
    return g
  }, [sessions])

  const lastIdx = steps.length - 1
  const elapsed = trace ? Math.max(0, (trace.lastActiveAt || 0) - (trace.startedAt || 0)) : 0

  return (
    <section className="ot-hub-view ek-trace-view" data-testid="session-trace-view">
      <header className="ot-proj-topbar">
        <div className="ot-proj-topbar-left">
          <button type="button" className="ot-icon-btn" onClick={onBack} title="返回工作台 (⌘[)" data-testid="btn-trace-back">
            <CaretLeft size={16} weight="bold" />
          </button>
          <ListMagnifyingGlass size={16} weight="duotone" style={{ color: 'var(--ek-brand)' }} />
          <strong className="ot-proj-topbar-name">运行记录</strong>
          <span className="ot-hub-count-pill">{sessions.length} 个会话</span>
        </div>
        <div className="ot-proj-topbar-right" style={{ gap: 6 }}>
          <button type="button" className="ot-btn ot-btn--sm" onClick={() => load(selectedId)} disabled={loading} data-testid="btn-trace-refresh">
            <ArrowsClockwise size={13} className={loading ? 'ot-spin' : ''} />
            <span>刷新</span>
          </button>
        </div>
      </header>

      <div className="ek-trace-grid">
        <aside className="ek-trace-list" aria-label="会话列表">
          {['chief', 'build', 'review'].map(kind => (
            grouped[kind]?.length ? (
              <div key={kind} className="ek-trace-group">
                <div className="ek-trace-group-head">{KIND_LABEL[kind]}</div>
                {grouped[kind].map(s => (
                  <button
                    key={s.sessionId}
                    type="button"
                    className={`ek-trace-session ${selectedId === s.sessionId ? 'is-active' : ''}`}
                    onClick={() => { stickBottomRef.current = true; setSelectedId(s.sessionId) }}
                    title={s.label}
                    data-testid={`trace-session-${s.sessionId}`}
                  >
                    <span className={`ek-trace-dot ${s.running ? 'is-running' : ''}`} />
                    <span className="ek-trace-session-label">{s.label}</span>
                  </button>
                ))}
              </div>
            ) : null
          ))}
          {!sessions.length && !loading && <div className="ek-trace-empty-side">暂无会话记录</div>}
        </aside>

        <div className="ek-trace-main">
          {error && <div className="ek-trace-error"><WarningCircle size={14} /> {error}</div>}
          {!trace ? (
            <div className="ek-trace-placeholder">{loading ? '加载中…' : '选择左侧会话查看调用明细'}</div>
          ) : (
            <>
              <div className="ek-trace-head">
                <div className="ek-trace-head-top">
                  <span className={`ek-trace-kind is-${trace.kind}`}>{KIND_LABEL[trace.kind] || trace.kind}</span>
                  <strong className="ek-trace-title">{trace.label}</strong>
                  <span className={`ek-trace-state ${trace.running ? 'is-running' : ''}`}>
                    {trace.running ? <><CircleNotch size={12} className="ot-spin" /> 运行中</> : (trace.endReason === 'complete' || !trace.endReason ? '已结束' : trace.endReason)}
                  </span>
                </div>
                <div className="ek-trace-stats">
                  <div><small>模型</small><strong title={trace.model}>{formatModelShort(trace.model) || '—'}</strong></div>
                  <div><small>提供方</small><strong>{trace.provider || '—'}</strong></div>
                  <div><small>耗时</small><strong>{fmtDuration(elapsed)}</strong></div>
                  <div><small>工具调用</small><strong>{trace.toolCalls}{trace.toolErrors ? <span className="ek-trace-err-count"> · {trace.toolErrors} 异常</span> : null}</strong></div>
                  <div><small>输入 / 输出 Token</small><strong>{trace.inputTokens ? fmtTokens(trace.inputTokens) : '—'} / {trace.outputTokens ? fmtTokens(trace.outputTokens) : '—'}</strong></div>
                  <div><small>开始</small><strong>{fmtClock(trace.startedAt)}</strong></div>
                </div>
                <div className="ot-seg ek-trace-filter" role="tablist">
                  {FILTERS.map(([val, lbl]) => (
                    <button
                      key={val}
                      type="button"
                      role="tab"
                      aria-selected={filter === val}
                      className={`ot-seg-btn ${filter === val ? 'is-active' : ''}`}
                      onClick={() => setFilter(val)}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>

              <div
                className="ek-trace-timeline"
                ref={bodyRef}
                onScroll={e => {
                  const el = e.currentTarget
                  stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                }}
                data-testid="trace-timeline"
              >
                {steps.length === 0 ? (
                  <div className="ek-trace-placeholder">此筛选下没有记录</div>
                ) : steps.map((st, i) => (
                  <div key={i} className="ek-trace-row">
                    <div className="ek-trace-rail">
                      <span className="ek-trace-time">{fmtClock(st.at)}</span>
                      {st.gapSec >= 30 && <span className="ek-trace-gap">+{fmtDuration(st.gapSec)}</span>}
                    </div>
                    <div className="ek-trace-card">
                      {st.kind === 'tool'
                        ? <ToolStep step={st} defaultOpen={Boolean(st.pending || st.failed || (trace.running && i === lastIdx))} />
                        : <TextStep step={st} />}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

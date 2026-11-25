// v0.9.43 (Todo #29): page-side state for the Chief context capsule, manual compression and slash commands.
// The live session subscription stays in App.jsx; it feeds every event to `onSessionEvent` and hands the
// handle to `attach` / `detach`. Command semantics stay in the host (see chief-commands.js).
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  COMMAND_TIMEOUT_MS,
  compressResultText,
  COMPRESS_TIMEOUT_MS,
  createCommandRunner,
  DEFAULT_COMPRESS_THRESHOLD,
  expireAutoCompress,
  mergeServerChannel,
  reduceContextEvent,
  runManualCompress,
} from './chief-commands.js'

const EMPTY = { sessionId: '', tokens: 0, window: 0, threshold: DEFAULT_COMPRESS_THRESHOLD, channel: 'unknown', reason: '', channelSticky: false, connected: false, phase: 'idle', startedAt: 0 }

export function useChiefContext({ ctx, topic, applyNextState, running }) {
  const runnerRef = useRef(null)
  if (!runnerRef.current) runnerRef.current = createCommandRunner()
  const [info, setInfo] = useState(EMPTY)
  const sid = topic?.chiefSessionId || ''
  const topicId = topic?.id || ''
  const sidRef = useRef(sid)
  sidRef.current = sid

  // Read the context window and the command channel whenever the Chief session changes.
  const refreshContext = useCallback(async () => {
    if (!topicId || !sid) return
    try {
      const res = await ctx.rpc.call('get-topic-context', { topicId })
      if (res?.sessionId !== sid) return
      setInfo(prev => (prev.sessionId === sid ? {
        ...prev,
        window: res.contextWindow || prev.window,
        threshold: res.compressionThreshold || prev.threshold,
        ...mergeServerChannel(prev, res),
      } : prev))
    } catch {
      // the capsule simply keeps showing "—"
    }
  }, [ctx, topicId, sid])

  useEffect(() => {
    setInfo(prev => (prev.sessionId === sid ? prev : { ...EMPTY, sessionId: sid, connected: runnerRef.current.connected && runnerRef.current.sessionId === sid }))
    void refreshContext()
  }, [sid, refreshContext])

  const onSessionEvent = useCallback(evt => {
    runnerRef.current.handleEvent(evt)
    if (!evt || (evt.session_id && evt.session_id !== sidRef.current)) return
    // Automatic compressions (source bridge) show up here too; reduceContextEvent returns prev when unchanged.
    setInfo(prev => reduceContextEvent(prev, evt, { manualBusy: runnerRef.current.busy, now: Date.now() }))
  }, [])

  // An automatic compression whose completion was missed (and no resumed came) ends after 120 s.
  useEffect(() => {
    if (info.phase !== 'compressing' || !info.startedAt) return undefined
    const wait = Math.max(0, info.startedAt + COMPRESS_TIMEOUT_MS + 1 - Date.now())
    const timer = setTimeout(() => {
      setInfo(prev => expireAutoCompress(prev, { manualBusy: runnerRef.current.busy, now: Date.now() }))
    }, wait)
    return () => clearTimeout(timer)
  }, [info.phase, info.startedAt])

  const attach = useCallback((sessionId, handle) => {
    runnerRef.current.attach(sessionId, handle)
    setInfo(prev => (prev.sessionId === sessionId ? { ...prev, connected: true } : prev))
  }, [])

  const detach = useCallback(sessionId => {
    runnerRef.current.detach(sessionId)
    setInfo(prev => (prev.sessionId === sessionId ? { ...prev, connected: false } : prev))
  }, [])

  const record = useCallback(async payload => {
    try {
      const next = await ctx.rpc.call('record-topic-command', payload)
      if (next && typeof next === 'object' && Array.isArray(next.projects)) applyNextState?.(next)
    } catch {
      // the toast still tells the user; the server lock expires by itself
    }
  }, [ctx, applyNextState])

  const stopRun = useCallback(() => {
    if (topicId) return ctx.rpc.call('stop-topic-run', { topicId }).catch(() => {})
    return null
  }, [ctx, topicId])

  const compress = useCallback(async () => {
    if (!topicId || !sid || runnerRef.current.busy) return null
    const startedAt = Date.now()
    setInfo(prev => ({ ...prev, phase: 'compressing', startedAt }))
    let result
    try {
      result = await runManualCompress({
        runner: runnerRef.current,
        topicId,
        beginLock: input => ctx.rpc.call('begin-topic-compress', input),
        record,
        stopRun,
        onProbe: probe => {
          // The probe proves the channel; its token total is another measure and does not move the capsule.
          setInfo(prev => (prev.sessionId === sid ? { ...prev, channel: 'ready', reason: '', channelSticky: false, window: probe.contextWindow || prev.window } : prev))
        },
      })
    } catch (err) {
      // begin-topic-compress refused: the server's reason, nothing was sent to the host.
      result = { ok: false, outcome: 'failed', message: err?.message || String(err), refused: true }
    }
    // New tokens arrive as compression.completed / usage.updated contextTokens. A detach leaves the capsule of
    // whatever session is shown now alone; the server lock of this topic expires by itself.
    setInfo(prev => (prev.sessionId === sid ? {
      ...prev,
      phase: 'idle',
      startedAt: 0,
      // unsupported only comes from a passthrough now (the host handed the command to the model): it sticks.
      ...(result.outcome === 'unsupported' ? { channel: 'unsupported', reason: result.message, channelSticky: true } : {}),
    } : prev))
    ctx.ui?.notify?.(result.refused ? result.message : compressResultText(result), result.ok ? 'success' : (result.detached ? 'info' : 'error'))
    void refreshContext()
    return result
  }, [ctx, topicId, sid, record, stopRun, refreshContext])

  // Any other migrated command: sent as is, the host's answer is written into the topic.
  const runCommand = useCallback(async parsed => {
    if (!topicId || !sid || !parsed) return { ok: false }
    if (parsed.action === 'compress') return compress()
    const res = await runnerRef.current.run(parsed.text, { action: parsed.action, command: parsed.rawName, timeoutMs: COMMAND_TIMEOUT_MS, expectsRun: Boolean(running) })
    if (res.detached) {
      // The page left the session before the answer: the outcome is unknown, nothing is written.
      ctx.ui?.notify?.(`/${parsed.rawName}：实时通道已断开，结果未知`, 'info')
      return res
    }
    if (res.passthrough) {
      await stopRun()
      setInfo(prev => ({ ...prev, channel: 'unsupported', reason: res.message, channelSticky: true }))
    }
    const payload = { topicId, command: parsed.action === 'branch' ? parsed.rawName : parsed.action, ok: Boolean(res.ok), outcome: res.passthrough ? 'unsupported' : res.outcome }
    if (res.message) payload.message = res.message.slice(0, 2000)
    await record(payload)
    if (!res.ok) ctx.ui?.notify?.(res.message || `/${parsed.rawName} 失败`, 'error')
    return res
  }, [ctx, topicId, sid, running, compress, record, stopRun])

  return { info, attach, detach, onSessionEvent, compress, runCommand, refreshContext }
}

// Todo #98: client side of search-workspace — debounced RPC with stale-response discard, plus the
// highlight component and labels shared by the command palette, board filter and project workspace.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { highlightSegments, normalizeSearchQuery } from '../shared/search-text.mjs'
import { SEARCH_DEBOUNCE_MS, createSearchRunner } from './workspace-search-core.js'

export { SEARCH_DEBOUNCE_MS, createSearchRunner, groupItems, groupMeta, localWorkspaceSearch } from './workspace-search-core.js'


/** Chinese label of a matchedField returned by search-workspace. */
export const MATCHED_FIELD_LABELS = {
  number_hash: '编号',
  number: '编号',
  title_exact: '标题',
  title_prefix: '标题',
  title: '标题',
  title_terms: '标题',
  branch: '分支',
  tags: '标签',
  agent: 'Agent',
  project: '项目',
  topic: '话题',
  brief_goal: '简报·目标',
  brief_progress: '简报·进展',
  brief_next: '简报·下一步',
  brief_waiting: '简报·待你处理',
  repo: '仓库',
  description: '描述',
  spec: '任务书',
  content: '正文',
  last_error: '错误信息',
  timeline: '时间线',
  chat: 'Agent 对话',
  messages: '话题对话',
  terms: '多词命中',
}

export const PHASE_LABELS = {
  todo: '待办', queued: '排队', building: '构建中', reviewing: '审查中', merging: '合并中',
  review: '待验收', confirm: '待确认', done: '已完成', failed: '失败', closed: '已关闭',
}

/** Text with every hit of `query` wrapped in <mark className="ot-mark">. */
export function Highlight({ text, query }) {
  const segs = highlightSegments(text, query)
  return (
    <>
      {segs.map((s, i) => (s.hit ? <mark key={i} className="ot-mark">{s.text}</mark> : <React.Fragment key={i}>{s.text}</React.Fragment>))}
    </>
  )
}

/**
 * Debounced search-workspace (300 ms). `call(input)` must return a promise of the RPC result. While
 * `paused` (IME composition) nothing is sent; stale answers are dropped (see createSearchRunner).
 *
 * Returns { status: 'idle'|'loading'|'ready'|'error', result, error, retry, query }.
 */
export function useWorkspaceSearch(call, { query, scope = 'all', projectId = '', topicId = '', memoryScope = '', limit, enabled = true, paused = false, allowEmpty = false, debounceMs = SEARCH_DEBOUNCE_MS } = {}) {
  const [state, setState] = useState({ status: 'idle', result: null, error: '', query: '' })
  const [nonce, setNonce] = useState(0)
  const callRef = useRef(call)
  callRef.current = call
  const runnerRef = useRef(null)
  if (!runnerRef.current) {
    runnerRef.current = createSearchRunner({ call: input => callRef.current(input), onState: setState, debounceMs })
  }
  const normalized = normalizeSearchQuery(query)
  const raw = String(query ?? '')
  const active = Boolean(enabled && typeof call === 'function' && (normalized || (allowEmpty && raw === '')))

  useEffect(() => {
    const input = { query: normalized, scope }
    if (projectId) input.projectId = projectId
    if (topicId) input.topicId = topicId
    if (memoryScope) input.memoryScope = memoryScope
    if (limit) input.limit = limit
    runnerRef.current.update({ query: normalized, paused, active, input })
  }, [active, normalized, scope, projectId, topicId, memoryScope, limit, paused, nonce])

  useEffect(() => () => runnerRef.current?.dispose(), [])
  const retry = useCallback(() => setNonce(n => n + 1), [])
  return { ...state, retry }
}

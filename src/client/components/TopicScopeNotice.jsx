import React, { useState } from 'react'
import { WarningCircle, X } from '@phosphor-icons/react'
import { dismissScopeNotice, isScopeNoticeDismissed, topicScopeNotice } from '../topic-scope.js'

/**
 * Todo #127: one line at the top of the chat pane for a topic without a project or holding cards of other
 * projects. Renders nothing for any other topic, and nothing once closed (page memory, per topic and code).
 * The action is rendered only when its handler is given.
 */
export function TopicScopeNotice({ topic, projects, onOpenProjects, onRepair }) {
  const [, setClosedSeq] = useState(0)
  const notice = topicScopeNotice(topic, projects)
  if (!notice || isScopeNoticeDismissed(notice.key)) return null
  const run = notice.action === 'projects' ? onOpenProjects : notice.action === 'repair' ? onRepair : null
  return (
    <div className="ot-scope-notice-wrap">
      <div
        className="ot-loop-notice ot-scope-notice"
        role="status"
        data-testid="topic-scope-notice"
        data-code={notice.code}
        data-topic-id={topic.id}
      >
        <WarningCircle size={15} weight="fill" aria-hidden="true" />
        <span className="ot-scope-notice__text">
          <strong data-testid="topic-scope-main">{notice.main}</strong>
          <span className="ot-scope-notice__note" data-testid="topic-scope-note">{notice.note}</span>
          {run && (
            <button type="button" className="ot-link-btn ot-scope-notice__action" onClick={() => run(topic, notice)} data-testid="btn-topic-scope-action">
              {notice.actionLabel}
            </button>
          )}
        </span>
        <button
          type="button"
          className="ot-scope-notice__close"
          onClick={() => { dismissScopeNotice(notice.key); setClosedSeq(n => n + 1) }}
          title="关闭提示（本话题不再显示）"
          aria-label="关闭提示"
          data-testid="btn-topic-scope-dismiss"
        >
          <X size={13} weight="bold" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

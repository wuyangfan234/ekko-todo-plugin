// Todo #127 (client only): what the chat pane says at its top about stateSnapshot.topics[].topicScopeReason.
//  - topicScopeNotice: null for a topic without a reason (nothing is rendered), else the short page copy of
//    one of the two codes. The server's `message` is a sentence for tool answers and is not shown here.
//  - the dismissal store: page memory only (lost on reload), one entry per topic and code, so closing the
//    notice of one topic hides nothing in another topic and a topic whose reason changes says so again.

export const SCOPE_NO_PROJECT = 'no-project'
export const SCOPE_FOREIGN_TODOS = 'foreign-todos'

const projectName = (projects, id) => {
  const found = (projects || []).find(p => p?.id === id)
  return String(found?.name || '').trim() || String(id || '')
}

const count = value => (Number.isInteger(value) && value > 0 ? value : 0)

/**
 * { key, code, main, note, action, actionLabel } or null.
 * action: 'projects' (open the project list) | 'repair' (repair-topic-todos for this topic).
 */
export function topicScopeNotice(topic, projects) {
  const reason = topic?.topicScopeReason
  if (!topic?.id || !reason || typeof reason !== 'object') return null
  if (reason.code === SCOPE_NO_PROJECT) {
    return {
      key: `${topic.id}:${SCOPE_NO_PROJECT}`,
      code: SCOPE_NO_PROJECT,
      main: '本话题还没有绑定项目',
      note: '直接说要做什么，总管会自己判断项目并绑定',
      action: 'projects',
      actionLabel: '看看有哪些项目',
    }
  }
  if (reason.code === SCOPE_FOREIGN_TODOS) {
    const own = projectName(projects, reason.projectId || topic.projectId)
    // suggestedProjectId is set only when every card of the topic is of one other project.
    const other = reason.suggestedProjectId ? `项目 ${projectName(projects, reason.suggestedProjectId)}` : '其他项目'
    const n = count(reason.foreignTodoCount) || count(reason.todoCount)
    return {
      key: `${topic.id}:${SCOPE_FOREIGN_TODOS}`,
      code: SCOPE_FOREIGN_TODOS,
      main: `本话题属于项目 ${own}，但其中 ${n} 张卡属于${other}`,
      note: '需要修复话题归属',
      action: 'repair',
      actionLabel: '修复话题归属',
    }
  }
  return null
}

const dismissed = new Set()
export const isScopeNoticeDismissed = key => dismissed.has(key)
export const dismissScopeNotice = key => { if (key) dismissed.add(key) }
export const resetScopeNoticeDismissals = () => { dismissed.clear() }

/** Copy of the confirm dialog shown before repair-topic-todos is called from the notice. */
export function repairScopeCopy(topic, notice) {
  return {
    title: '修复话题归属',
    name: topic?.title || '',
    body: [
      `${notice?.main || ''}。`,
      '确认后，不属于本话题项目的卡片会转到各自项目的话题，本话题不再收到它们的进展；本话题自己的项目不变。',
      '正在构建、审查或合并的卡片会跳过，等它们结束后可以再修一次。',
    ],
    action: '确认修复',
    pending: '修复中…',
    tone: 'primary',
  }
}

/** One sentence for the toast after repair-topic-todos answered. */
export function repairScopeResult(result) {
  const moved = Array.isArray(result?.moved) ? result.moved.length : 0
  const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0
  if (!moved && !skipped) return '没有需要转移的卡片'
  return `已转移 ${moved} 张卡片${skipped ? `，${skipped} 张未转移（${result.skipped[0]?.reason || '原因见话题消息'}）` : ''}`
}

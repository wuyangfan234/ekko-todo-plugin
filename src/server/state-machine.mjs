import { createMachine, getNextSnapshot } from 'xstate'

export const TODO_PHASES = ['todo', 'queued', 'confirm', 'building', 'reviewing', 'merging', 'review', 'failed', 'done', 'closed']

export const todoMachine = createMachine({
  id: 'ekkoTodoLifecycle',
  initial: 'todo',
  states: {
    todo: {
      on: {
        ENQUEUE: 'queued',
        START_BUILD: 'building',
        PLAN_READY: 'confirm',
        ASK_QUESTION: 'confirm',
        CLOSE: 'closed',
        COMPLETE: 'done',
      },
    },
    queued: {
      on: {
        START_BUILD: 'building',
        ASK_QUESTION: 'confirm',
        CANCEL: 'todo',
        CLOSE: 'closed',
      },
    },
    confirm: {
      on: {
        ENQUEUE: 'queued',
        CONFIRM_PLAN: 'building',
        ANSWER_QUESTION: 'building',
        START_BUILD: 'building',
        REQUEST_CHANGES: 'building',
        CANCEL: 'todo',
        CLOSE: 'closed',
      },
    },
    building: {
      on: {
        ASK_QUESTION: 'confirm',
        PLAN_READY: 'confirm',
        BUILD_COMPLETED: 'review',
        START_REVIEW: 'reviewing',
        BUILD_FAILED: 'failed',
        CANCEL: 'todo',
        CLOSE: 'closed',
      },
    },
    reviewing: {
      on: {
        REVIEW_APPROVED: 'review',
        START_MERGE: 'merging',
        APPROVE_MERGE: 'done',
        REVIEW_CHANGES_REQUESTED: 'building',
        REQUEST_CHANGES: 'building',
        ASK_QUESTION: 'confirm',
        BUILD_FAILED: 'failed',
        CANCEL: 'review',
        CLOSE: 'closed',
      },
    },
    merging: {
      on: {
        MERGE_COMPLETED: 'done',
        APPROVE_MERGE: 'done',
        MERGE_FAILED: 'failed',
        BUILD_FAILED: 'failed',
        CANCEL: 'review',
      },
    },
    review: {
      on: {
        ENQUEUE: 'queued',
        START_REVIEW: 'reviewing',
        START_MERGE: 'merging',
        APPROVE_MERGE: 'done',
        COMPLETE: 'done',
        REQUEST_CHANGES: 'building',
        START_BUILD: 'building',
        ASK_QUESTION: 'confirm',
        CLOSE: 'closed',
      },
    },
    failed: {
      on: {
        ENQUEUE: 'queued',
        START_BUILD: 'building',
        RETRY_CONTINUE: 'building',
        RETRY_FRESH: 'building',
        // 0.9.48: a card whose merge failed goes back to the merge gate with its review verdict (retry_merge).
        RETRY_MERGE: 'review',
        REOPEN: 'todo',
        CLOSE: 'closed',
      },
    },
    done: {
      on: {
        ENQUEUE: 'queued',
        REOPEN: 'todo',
        START_BUILD: 'building',
      },
    },
    closed: {
      on: {
        ENQUEUE: 'queued',
        REOPEN: 'todo',
        START_BUILD: 'building',
      },
    },
  },
})

/**
 * Validate and resolve the next lifecycle phase using XState v5.
 * Throws if the requested transition is illegal from the current phase.
 */
export function transitionTodoPhase(currentPhase, eventType) {
  if (!TODO_PHASES.includes(currentPhase)) {
    throw new Error(`Invalid todo phase: ${currentPhase}`)
  }
  const stateConfig = todoMachine.config.states?.[currentPhase]
  if (!stateConfig?.on?.[eventType]) {
    throw new Error(`Transition ${eventType} is not allowed from phase "${currentPhase}"`)
  }
  const currentSnapshot = todoMachine.resolveState({ value: currentPhase, context: {} })
  const nextSnapshot = getNextSnapshot(todoMachine, currentSnapshot, { type: eventType })
  return String(nextSnapshot.value)
}

export function canTransition(currentPhase, eventType) {
  const stateConfig = todoMachine.config.states?.[currentPhase]
  return Boolean(stateConfig?.on?.[eventType])
}

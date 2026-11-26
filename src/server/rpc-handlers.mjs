import { registerRpc } from '../../sdk/harness/contracts.mjs'
import { readLocalFile } from './local-file.mjs'

export function registerAllRpcs(ctx, contract, orchestrator) {
  return [
    registerRpc(ctx, contract, 'get-state', async (_input, run) => orchestrator.getSnapshot(run)),
    registerRpc(ctx, contract, 'get-model-catalog', async (input, run) => orchestrator.getModelCatalog(run, input || {})),
    registerRpc(ctx, contract, 'get-host-memory', async (_input, run) => orchestrator.readHostMemory(run)),
    registerRpc(ctx, contract, 'github-auth-status', async (input, run) => orchestrator.getGithubAuthStatus(run, input || {})),
    registerRpc(ctx, contract, 'github-auth-start-device', async (_input, run) => orchestrator.startGithubDeviceAuth(run)),
    registerRpc(ctx, contract, 'github-auth-save-token', async (input, run) => orchestrator.saveGithubToken(run, input)),
    registerRpc(ctx, contract, 'github-auth-logout', async (input, run) => orchestrator.logoutGithub(run, input || {})),
    registerRpc(ctx, contract, 'list-github-repos', async (input, run) => orchestrator.listGithubRepos(run, input || {})),
    registerRpc(ctx, contract, 'upload-chat-file', async (input, run) => orchestrator.uploadChatFile(run, input)),
    registerRpc(ctx, contract, 'complete-onboarding', async (input, run) => orchestrator.completeOnboarding(run, input || {})),
    registerRpc(ctx, contract, 'sync-topic-session', async (input, run) => orchestrator.syncTopicSession(run, input || {})),
    registerRpc(ctx, contract, 'get-topic-context', async (input, run) => orchestrator.getTopicContext(run, input)),
    registerRpc(ctx, contract, 'begin-topic-compress', async (input, run) => orchestrator.beginTopicCompress(run, input)),
    registerRpc(ctx, contract, 'record-topic-command', async (input, run) => orchestrator.recordTopicCommand(run, input)),
    registerRpc(ctx, contract, 'sync-session-isolation', async (_input, run) => orchestrator.syncSessionIsolation(run)),
    registerRpc(ctx, contract, 'inspect-repo', async (input) => orchestrator.inspectRepo(input.repoPath)),
    registerRpc(ctx, contract, 'project-branches', async (input, run) => orchestrator.browseProjectBranches(run, input)),
    registerRpc(ctx, contract, 'project-tree', async (input, run) => orchestrator.browseProjectTree(run, input)),
    registerRpc(ctx, contract, 'project-file', async (input, run) => orchestrator.browseProjectFile(run, input)),
    registerRpc(ctx, contract, 'project-commits', async (input, run) => orchestrator.browseProjectCommits(run, input)),
    registerRpc(ctx, contract, 'project-commit-diff', async (input, run) => orchestrator.browseProjectCommitDiff(run, input)),
    registerRpc(ctx, contract, 'save-quota-provider', async (input, run) => (await orchestrator.saveQuotaProvider(run, input)).state),
    registerRpc(ctx, contract, 'delete-quota-provider', async (input, run) => orchestrator.deleteQuotaProvider(run, input)),
    registerRpc(ctx, contract, 'refresh-quota-provider', async (input, run) => (await orchestrator.refreshQuotaProvider(run, input)).state),
    registerRpc(ctx, contract, 'refresh-all-quotas', async (input, run) => orchestrator.refreshAllQuotas(run, input || {})),
    registerRpc(ctx, contract, 'get-token-usage', async (input, run) => orchestrator.getTokenUsage(run, input || {})),
    registerRpc(ctx, contract, 'get-session-trace', async (input, run) => orchestrator.getSessionTrace(run, input || {})),
    registerRpc(ctx, contract, 'save-schedule', async (input, run) => (await orchestrator.saveSchedule(run, input, 'user')).state),
    registerRpc(ctx, contract, 'delete-schedule', async (input, run) => orchestrator.deleteSchedule(run, input)),
    registerRpc(ctx, contract, 'trigger-schedule', async (input, run) => orchestrator.triggerScheduleNow(run, input)),
    registerRpc(ctx, contract, 'add-project', async (input, run) => (await orchestrator.addProject(run, input)).state),
    registerRpc(ctx, contract, 'import-github-project', async (input, run) => (await orchestrator.importGithubProject(run, input)).state),
    registerRpc(ctx, contract, 'update-project', async (input, run) => (await orchestrator.updateProject(run, input)).state),
    registerRpc(ctx, contract, 'delete-project', async (input, run) => orchestrator.deleteProject(run, input.id)),
    registerRpc(ctx, contract, 'save-agent', async (input, run) => (await orchestrator.saveAgent(run, input)).state),
    registerRpc(ctx, contract, 'clear-agent-cooldowns', async (input, run) => orchestrator.clearAgentCooldowns(run, input.id)),
    registerRpc(ctx, contract, 'delete-agent', async (input, run) => orchestrator.removeAgent(run, input.id)),
    registerRpc(ctx, contract, 'save-settings', async (input, run) => orchestrator.saveSettings(run, input)),
    registerRpc(ctx, contract, 'quick-configure-chief', async (input, run) => orchestrator.quickConfigureChief(run, input)),
    registerRpc(ctx, contract, 'save-memory', async (input, run) => (await orchestrator.saveMemory(run, input)).state),
    registerRpc(ctx, contract, 'delete-memory', async (input, run) => orchestrator.removeMemory(run, input.id)),
    registerRpc(ctx, contract, 'create-topic', async (input, run) => (await orchestrator.createTopic(run, input || {})).state),
    registerRpc(ctx, contract, 'update-topic', async (input, run) => orchestrator.updateTopicMeta(run, input)),
    registerRpc(ctx, contract, 'clear-topic-waiting', async (input, run) => orchestrator.markBriefWaitingDone(run, input)),
    registerRpc(ctx, contract, 'set-topic-autopilot', async (input, run) => orchestrator.setTopicAutopilot(run, input)),
    registerRpc(ctx, contract, 'delete-topic', async (input, run) => orchestrator.deleteTopic(run, input.id)),
    registerRpc(ctx, contract, 'read-local-file', async (input, run) => readLocalFile(input, { identity: run?.identity })),
    registerRpc(ctx, contract, 'get-todo-diffs', async (input, run) => orchestrator.getTodoDiffs(run, input)),
    registerRpc(ctx, contract, 'send-topic-message', async (input, run) => orchestrator.sendTopicMessage(run, input)),
    registerRpc(ctx, contract, 'cancel-topic-queue-item', async (input, run) => orchestrator.cancelTopicQueueItem(run, input)),
    registerRpc(ctx, contract, 'promote-topic-queue-item', async (input, run) => orchestrator.promoteTopicQueueItem(run, input)),
    registerRpc(ctx, contract, 'stop-topic-run', async (input, run) => orchestrator.stopTopicRun(run, input.topicId)),
    registerRpc(ctx, contract, 'retry-merge', async (input, run) => {
      await orchestrator.retryMerge(run, { todoId: input.todoId })
      return orchestrator.getSnapshot(run)
    }),
    registerRpc(ctx, contract, 'create-todo', async (input, run) => (await orchestrator.createTodo(run, input)).state),
    registerRpc(ctx, contract, 'todo-action', async (input, run) => {
      switch (input.action) {
        case 'start_build':
          await orchestrator.startBuild(run, { todoId: input.todoId, configId: input.configId, withPlan: Boolean(input.withPlan) })
          break
        case 'retry_continue':
          await orchestrator.startBuild(run, { todoId: input.todoId, configId: input.configId, withPlan: false, fresh: false })
          break
        case 'retry_fresh':
          await orchestrator.startBuild(run, { todoId: input.todoId, configId: input.configId, withPlan: false, fresh: true })
          break
        case 'confirm_plan':
          await orchestrator.confirmPlan(run, { todoId: input.todoId, note: input.note })
          break
        case 'answer_question':
          await orchestrator.answerQuestion(run, { todoId: input.todoId, optionId: input.optionId, note: input.note })
          break
        case 'request_review':
          await orchestrator.runIndependentReview(run, { todoId: input.todoId })
          break
        case 'approve_merge':
          await orchestrator.mergeBuild(run, { todoId: input.todoId, commitMessage: input.note, caller: 'user', asyncMode: true })
          break
        case 'request_changes':
          await orchestrator.requestChanges(run, { todoId: input.todoId, note: input.note })
          break
        case 'message_todo':
          await orchestrator.messageTodo(run, { todoId: input.todoId, note: input.note })
          break
        case 'cancel_build':
          await orchestrator.cancelBuild(run, { todoId: input.todoId, discard: false })
          break
        case 'complete':
          await orchestrator.completeTodo(run, { todoId: input.todoId })
          break
        case 'close':
          await orchestrator.closeTodo(run, { todoId: input.todoId })
          break
        case 'delete':
          await orchestrator.deleteTodo(run, { todoId: input.todoId })
          break
        case 'reopen':
          await orchestrator.reopenTodo(run, { todoId: input.todoId })
          break
        case 'refresh_diff':
          await orchestrator.refreshTodoDiff(run, { todoId: input.todoId })
          break
        default:
          throw new Error(`Unsupported todo action: ${input.action}`)
      }
      return orchestrator.getSnapshot(run)
    }),
  ]
}

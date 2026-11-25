/**
 * 0.9.56: the page marks the Chief as "working" the moment a message is sent (optimistic), and the host
 * subscription marks it on run.started / run.queued. Only run.completed / run.failed / abort events clear it.
 * When the host never runs the turn (queued item dropped, launch refused, run ended while the subscription
 * was down, stop on an already idle session — the host then sends nothing), the flag stayed on for good:
 * "大总管正在响应…" kept counting, sending only queued, and Stop changed nothing on screen.
 *
 * Rule: the board snapshot (corrected by sync-topic-session, which asks the host) says the topic is neither
 * running nor launching, and the live stream has been silent for STALE_WORKING_MS → the live flag is stale.
 */
export const STALE_WORKING_MS = 20000
export const WATCHDOG_TICK_MS = 5000

export function shouldClearStaleWorking({ isWorking, topicRunning, topicLaunching, lastEventAt, now, graceMs = STALE_WORKING_MS }) {
  if (!isWorking) return false
  if (topicRunning || topicLaunching) return false
  const last = Number(lastEventAt) || 0
  return Number(now) - last >= graceMs
}

/**
 * Wall-clock Schedule Engine for Ekko ToDo (aligned with Todos Schedules semantics).
 *
 * - Supports 4 schedule frequencies: 'hourly', 'daily', 'weekly', 'once'.
 * - Computes next_run_at strictly in the user's chosen IANA wall-clock timezone (DST-safe).
 * - Missed cycles never pile up or backfill; schedules realign to the next future slot.
 * - One-shot ('once') rules retry every minute until their run starts, then auto-complete.
 */

import { MAX_AGENT_REF_CHARS, MAX_RUN_AT_CHARS, assertMaxLength } from './diff-budget.mjs'

export const MAX_SCHEDULES = 50

export const VALID_FREQUENCIES = Object.freeze(['hourly', 'daily', 'weekly', 'once'])

const WEEKDAY_NAMES_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const WEEKDAY_EN_TO_NUM = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

export function getDefaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

export function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date())
    return true
  } catch {
    return false
  }
}

export function getZonedParts(ms, timeZone) {
  const tz = isValidTimezone(timeZone) ? timeZone : 'UTC'
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  })
  const parts = {}
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  const hourNum = Number(parts.hour)
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: hourNum === 24 ? 0 : hourNum,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_EN_TO_NUM[parts.weekday] ?? 0,
  }
}

/**
 * Convert a target wall-clock date/time in an IANA timezone to exact UTC milliseconds.
 * Iteratively corrects timezone offset (handles DST transitions accurately).
 */
export function zonedWallClockToUtcMs({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const tz = isValidTimezone(timeZone) ? timeZone : 'UTC'
  let guess = Date.UTC(year, month - 1, day, hour, minute, second)
  for (let i = 0; i < 4; i++) {
    const p = getZonedParts(guess, tz)
    const renderedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second)
    const diff = targetAsUtc - renderedAsUtc
    if (diff === 0) break
    guess += diff
  }
  return guess
}

function addCalendarDays({ year, month, day }, deltaDays) {
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays))
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  }
}

export function parseRunAtToMs(runAtIso, timeZone) {
  const raw = String(runAtIso || '').trim()
  if (!raw) return 0
  // If string explicitly includes Z or +/-HH:MM offset, parse directly
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : 0
  }
  // Interpret YYYY-MM-DDTHH:mm(:ss) in the schedule's wall-clock timezone
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (m) {
    return zonedWallClockToUtcMs(
      {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: Number(m[4]),
        minute: Number(m[5]),
        second: Number(m[6] || 0),
      },
      timeZone,
    )
  }
  const fallback = Date.parse(raw)
  return Number.isFinite(fallback) ? fallback : 0
}

export function normalizeScheduleInput(input = {}, existing = null) {
  const frequency = VALID_FREQUENCIES.includes(input.frequency)
    ? input.frequency
    : (existing?.frequency || 'daily')

  const clampInt = (val, min, max, fallback) => {
    const n = Number(val)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, Math.floor(n)))
  }

  const hour = clampInt(input.hour !== undefined ? input.hour : existing?.hour, 0, 23, 9)
  const minute = clampInt(input.minute !== undefined ? input.minute : existing?.minute, 0, 59, 0)
  const weekday = clampInt(input.weekday !== undefined ? input.weekday : existing?.weekday, 0, 6, 1)
  const rawTz = String(input.timezone !== undefined ? input.timezone : (existing?.timezone || getDefaultTimezone())).trim()
  const timezone = isValidTimezone(rawTz) ? rawTz : getDefaultTimezone()
  const runAtIso = String(input.runAtIso !== undefined ? input.runAtIso : (input.runAt !== undefined ? input.runAt : (existing?.runAtIso || ''))).trim()
  const agentId = String(input.agentId !== undefined ? input.agentId : (existing?.agentId || '')).trim()
  // A timestamp and an agent id are used as given, so an over-long new value is refused, not cut.
  // Values carried over from the stored rule are not re-validated.
  if (runAtIso !== String(existing?.runAtIso || '')) assertMaxLength('runAtIso', runAtIso, MAX_RUN_AT_CHARS)
  if (agentId !== String(existing?.agentId || '')) assertMaxLength('agentId', agentId, MAX_AGENT_REF_CHARS)
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : (existing ? Boolean(existing.enabled) : true)
  const note = String(input.note !== undefined ? input.note : (existing?.note || '')).trim().slice(0, 200)

  if (frequency === 'once' && !runAtIso) {
    throw new Error('单次定时必须指定运行日期与时间（runAtIso）')
  }
  if (frequency === 'once' && !parseRunAtToMs(runAtIso, timezone)) {
    throw new Error(`无法解析单次定时时间：${runAtIso}`)
  }

  return {
    projectId: String(input.projectId !== undefined ? input.projectId : (existing?.projectId || '')).trim(),
    todoId: String(input.todoId !== undefined ? input.todoId : (existing?.todoId || '')).trim(),
    frequency,
    hour,
    minute,
    weekday,
    runAtIso,
    timezone,
    agentId,
    enabled,
    note,
  }
}

/**
 * Compute next wall-clock execution UTC timestamp strictly after `fromMs` (for recurring rules).
 * Missed occurrences are never backfilled; returns the next upcoming wall-clock slot.
 */
export function computeNextRunAt(schedule, fromMs = Date.now()) {
  if (!schedule || !schedule.enabled) return 0
  const tz = isValidTimezone(schedule.timezone) ? schedule.timezone : getDefaultTimezone()
  const frequency = schedule.frequency || 'daily'
  const minute = Math.max(0, Math.min(59, Number(schedule.minute) || 0))
  const hour = Math.max(0, Math.min(23, Number(schedule.hour) || 0))
  const weekday = Math.max(0, Math.min(6, Number(schedule.weekday) || 0))

  if (frequency === 'once') {
    const target = parseRunAtToMs(schedule.runAtIso, tz)
    if (!target) return 0
    return target
  }

  // Round base up to at least 1 second past fromMs so we never re-trigger the exact same minute
  const probeMs = fromMs + 1000
  const nowParts = getZonedParts(probeMs, tz)

  if (frequency === 'hourly') {
    let candidate = zonedWallClockToUtcMs(
      { year: nowParts.year, month: nowParts.month, day: nowParts.day, hour: nowParts.hour, minute, second: 0 },
      tz,
    )
    if (candidate <= fromMs) {
      // Advance by 1 hour wall-clock safely
      const nextHourMs = probeMs + 60 * 60 * 1000
      const p2 = getZonedParts(nextHourMs, tz)
      candidate = zonedWallClockToUtcMs(
        { year: p2.year, month: p2.month, day: p2.day, hour: p2.hour, minute, second: 0 },
        tz,
      )
      if (candidate <= fromMs) {
        candidate += 60 * 60 * 1000
      }
    }
    return candidate
  }

  if (frequency === 'daily') {
    let candidate = zonedWallClockToUtcMs(
      { year: nowParts.year, month: nowParts.month, day: nowParts.day, hour, minute, second: 0 },
      tz,
    )
    if (candidate <= fromMs) {
      const tomorrow = addCalendarDays(nowParts, 1)
      candidate = zonedWallClockToUtcMs({ ...tomorrow, hour, minute, second: 0 }, tz)
    }
    return candidate
  }

  if (frequency === 'weekly') {
    let deltaDays = (weekday - nowParts.weekday + 7) % 7
    let dateParts = addCalendarDays(nowParts, deltaDays)
    let candidate = zonedWallClockToUtcMs({ ...dateParts, hour, minute, second: 0 }, tz)
    if (candidate <= fromMs) {
      dateParts = addCalendarDays(nowParts, deltaDays === 0 ? 7 : deltaDays + 7)
      candidate = zonedWallClockToUtcMs({ ...dateParts, hour, minute, second: 0 }, tz)
    }
    return candidate
  }

  return 0
}

export function formatScheduleRuleLabel(schedule) {
  if (!schedule) return ''
  const hh = String(schedule.hour ?? 9).padStart(2, '0')
  const mm = String(schedule.minute ?? 0).padStart(2, '0')
  switch (schedule.frequency) {
    case 'hourly':
      return `每小时 :${mm}`
    case 'daily':
      return `每天 ${hh}:${mm}`
    case 'weekly':
      return `每${WEEKDAY_NAMES_ZH[schedule.weekday] || '周一'} ${hh}:${mm}`
    case 'once': {
      const raw = String(schedule.runAtIso || '').replace('T', ' ').slice(0, 16)
      return raw ? `单次 ${raw}` : '单次执行'
    }
    default:
      return `每天 ${hh}:${mm}`
  }
}

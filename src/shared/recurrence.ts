import { addDays, weekdayOf } from './time'
import { WEEKDAYS, type RecurrenceRule, type Weekday } from './types'

const DAY_MS = 86_400_000
const SEARCH_LIMIT_DAYS = 366 * 12 // monthly every 12 months, with room to spare

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS)
}

function parts(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number)
  return { y, m, d }
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Validate and clean a rule from untrusted input; null if it isn't a usable rule. */
export function normalizeRule(input: unknown): RecurrenceRule | null {
  if (!input || typeof input !== 'object') return null
  const r = input as Partial<RecurrenceRule>
  if (r.freq !== 'daily' && r.freq !== 'weekly' && r.freq !== 'monthly') return null
  const interval = Number(r.interval)
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return null
  const rule: RecurrenceRule = { freq: r.freq, interval }
  if (r.freq === 'weekly' && Array.isArray(r.byday)) {
    const days = WEEKDAYS.filter((d) => r.byday!.includes(d))
    if (days.length) rule.byday = days
  }
  return rule
}

export function parseRule(json: string | null): RecurrenceRule | null {
  if (!json) return null
  try {
    return normalizeRule(JSON.parse(json))
  } catch {
    return null
  }
}

/** Monday-based index of the week containing `day`, counted in days from an epoch Monday. */
function weekIndex(day: string): number {
  const n = dayNumber(day)
  return Math.floor((n + 3) / 7) // 1970-01-01 was a Thursday
}

/**
 * The first occurrence strictly after `max(anchorDay, notBefore)`. The series is defined relative
 * to the anchor: every N days, every N weeks on the chosen weekdays, or every N months on the
 * anchor's day of the month (clamped to month end).
 */
export function nextOccurrence(rule: RecurrenceRule, anchorDay: string, notBefore: string): string {
  const floor = notBefore > anchorDay ? notBefore : anchorDay
  const anchor = parts(anchorDay)
  const byday: Weekday[] = rule.byday?.length ? rule.byday : [weekdayOf(anchorDay)]

  const matches = (day: string): boolean => {
    if (rule.freq === 'daily') return (dayNumber(day) - dayNumber(anchorDay)) % rule.interval === 0
    if (rule.freq === 'weekly') {
      return (
        (weekIndex(day) - weekIndex(anchorDay)) % rule.interval === 0 &&
        byday.includes(weekdayOf(day))
      )
    }
    const p = parts(day)
    const months = (p.y - anchor.y) * 12 + (p.m - anchor.m)
    return months % rule.interval === 0 && p.d === Math.min(anchor.d, daysInMonth(p.y, p.m))
  }

  let candidate = addDays(floor, 1)
  for (let i = 0; i < SEARCH_LIMIT_DAYS; i++, candidate = addDays(candidate, 1)) {
    if (matches(candidate)) return candidate
  }
  throw new Error('No next occurrence found')
}

const WEEKDAY_SET = new Set<Weekday>(['mo', 'tu', 'we', 'th', 'fr'])
const LABEL: Record<Weekday, string> = {
  su: 'Sun',
  mo: 'Mon',
  tu: 'Tue',
  we: 'Wed',
  th: 'Thu',
  fr: 'Fri',
  sa: 'Sat'
}

/** Short human description, e.g. "Every weekday", "Every 2 weeks on Mon, Wed". */
export function describeRule(rule: RecurrenceRule): string {
  const n = rule.interval
  if (rule.freq === 'daily') return n === 1 ? 'Every day' : `Every ${n} days`
  if (rule.freq === 'monthly') return n === 1 ? 'Every month' : `Every ${n} months`
  const days = rule.byday ?? []
  const isWeekdays = n === 1 && days.length === 5 && days.every((d) => WEEKDAY_SET.has(d))
  if (isWeekdays) return 'Every weekday'
  const on = days.length ? ` on ${days.map((d) => LABEL[d]).join(', ')}` : ''
  return `${n === 1 ? 'Every week' : `Every ${n} weeks`}${on}`
}

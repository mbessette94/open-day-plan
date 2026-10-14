import { TZDate } from '@date-fns/tz'
import { WEEKDAYS, type Context, type UserSettings } from './types'

export type When = 'today' | 'tomorrow'
export interface Tab {
  context: Context
  when: When
}

export interface TimeWindow {
  start: string // HH:MM
  end: string
}

/** YYYY-MM-DD of `now` in `tz`. */
export function localDay(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now)
}

/** Minutes since local midnight of `now` in `tz`. */
export function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

function parseDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number)
  return { y, m, d }
}

export function addDays(day: string, n: number): string {
  const { y, m, d } = parseDay(day)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function weekdayOf(day: string): (typeof WEEKDAYS)[number] {
  const { y, m, d } = parseDay(day)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

export function isWorkDay(day: string, s: Pick<UserSettings, 'work_days'>): boolean {
  return s.work_days.includes(weekdayOf(day))
}

export function nextWorkDay(day: string, s: Pick<UserSettings, 'work_days'>): string {
  if (s.work_days.length === 0) return addDays(day, 1)
  let next = addDays(day, 1)
  for (let i = 0; i < 7 && !isWorkDay(next, s); i++) next = addDays(next, 1)
  return next
}

/** The calendar day a tab shows. "tomorrow" is the next work day for work, the next day for personal. */
export function targetDay(tab: Tab, now: Date, s: UserSettings): string {
  const today = localDay(now, s.timezone)
  if (tab.when === 'today') return today
  return tab.context === 'work' ? nextWorkDay(today, s) : addDays(today, 1)
}

/**
 * Agenda window for a tab's day. Work on a non-work day has no window.
 * Personal on a non-work day absorbs the work hours.
 */
export function windowFor(context: Context, day: string, s: UserSettings): TimeWindow | null {
  const workDay = isWorkDay(day, s)
  if (context === 'work') {
    return workDay ? { start: s.work_time_start, end: s.work_time_end } : null
  }
  if (workDay) return { start: s.personal_time_start, end: s.personal_time_end }
  return {
    start: s.personal_time_start < s.work_time_start ? s.personal_time_start : s.work_time_start,
    end: s.personal_time_end > s.work_time_end ? s.personal_time_end : s.work_time_end
  }
}

/** ISO UTC instant for `hhmm` on local `day` in `tz`. */
export function zonedInstant(day: string, hhmm: string, tz: string): string {
  const { y, m, d } = parseDay(day)
  const [h, mi] = hhmm.split(':').map(Number)
  // TZDate.toISOString() prints in the zone's offset; we store true UTC so strings compare chronologically
  return new Date(new TZDate(y, m - 1, d, h, mi, 0, tz).getTime()).toISOString()
}

/** [start, end) ISO UTC bounds of local `day`. */
export function dayBounds(day: string, tz: string): { start: string; end: string } {
  return { start: zonedInstant(day, '00:00', tz), end: zonedInstant(addDays(day, 1), '00:00', tz) }
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export const SLOT_MIN = 15

export interface AgendaGrid {
  start: number // minutes from local midnight, hour-aligned
  end: number
  slots: number
}

/** The agenda grid for a window: whole hours, in SLOT_MIN columns. */
export function gridFor(w: TimeWindow): AgendaGrid {
  const start = Math.floor(toMinutes(w.start) / 60) * 60
  const end = Math.max(start + 60, Math.ceil(toMinutes(w.end) / 60) * 60)
  return { start, end, slots: (end - start) / SLOT_MIN }
}

export function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** The most recent work day strictly before `day` (yesterday if there are no work days). */
export function prevWorkDay(day: string, s: Pick<UserSettings, 'work_days'>): string {
  if (s.work_days.length === 0) return addDays(day, -1)
  let prev = addDays(day, -1)
  for (let i = 0; i < 7 && !isWorkDay(prev, s); i++) prev = addDays(prev, -1)
  return prev
}

import { SLOT_MIN, toMinutes, type TimeWindow } from './time'
import type { CalendarEvent, Task } from './types'

export interface Interval {
  start: number // minutes from local midnight
  end: number
}

export interface Capacity {
  windowMin: number
  meetingMin: number // union of timed events inside the window
  plannedMin: number // union of scheduled, unfinished tasks inside the window
  overlapMin: number // time that is both a meeting and a planned task (double-booked)
  freeMin: number
  needMin: number // time the unscheduled do-now / decide items would take
  conflictTaskIds: string[] // scheduled tasks that overlap a meeting
  gaps: Interval[] // free stretches of at least one slot
}

/** Sort and merge overlapping or touching intervals. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const i of sorted) {
    const last = out[out.length - 1]
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end)
    else out.push({ ...i })
  }
  return out
}

const length = (list: Interval[]): number => list.reduce((n, i) => n + (i.end - i.start), 0)

function clip(i: Interval, w: Interval): Interval {
  return { start: Math.max(i.start, w.start), end: Math.min(i.end, w.end) }
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(x.start, y.start)
      const e = Math.min(x.end, y.end)
      if (e > s) out.push({ start: s, end: e })
    }
  }
  return mergeIntervals(out)
}

/**
 * Meeting / planned / free time for one agenda day. `dayStartIso` is local midnight of the day
 * (ISO UTC), so intervals are measured the same way the agenda draws them. All-day events are
 * informational and ignored. Every timed event counts as busy, declined or not.
 */
export function computeCapacity(
  window: TimeWindow,
  dayStartIso: string,
  events: CalendarEvent[],
  scheduled: Task[], // unfinished tasks with a scheduled_at
  unscheduledNeeds: Task[] = []
): Capacity {
  const w: Interval = { start: toMinutes(window.start), end: toMinutes(window.end) }
  const dayStartMs = Date.parse(dayStartIso)
  const minutes = (iso: string): number => (Date.parse(iso) - dayStartMs) / 60_000

  const meetings = mergeIntervals(
    events
      .filter((e) => !e.all_day)
      .map((e) => clip({ start: minutes(e.start_at), end: minutes(e.end_at) }, w))
  )
  const taskIntervals = scheduled
    .filter((t) => t.scheduled_at)
    .map((t) => ({
      id: t.id,
      i: clip(
        { start: minutes(t.scheduled_at!), end: minutes(t.scheduled_at!) + t.duration_min },
        w
      )
    }))
  const planned = mergeIntervals(taskIntervals.map((t) => t.i))
  const busy = mergeIntervals([...meetings, ...planned])

  const gaps: Interval[] = []
  let cursor = w.start
  for (const b of busy) {
    if (b.start - cursor >= SLOT_MIN) gaps.push({ start: cursor, end: b.start })
    cursor = Math.max(cursor, b.end)
  }
  if (w.end - cursor >= SLOT_MIN) gaps.push({ start: cursor, end: w.end })

  const meetingMin = length(meetings)
  const plannedMin = length(planned)
  return {
    windowMin: w.end - w.start,
    meetingMin,
    plannedMin,
    overlapMin: length(intersect(meetings, planned)),
    freeMin: w.end - w.start - length(busy),
    needMin: unscheduledNeeds.reduce((n, t) => n + t.duration_min, 0),
    conflictTaskIds: taskIntervals
      .filter((t) => intersect([t.i], meetings).length > 0)
      .map((t) => t.id),
    gaps
  }
}

/** Earliest slot-aligned start, at or after `notBefore`, in a gap that fits `durationMin`. */
export function findFreeSlot(gaps: Interval[], durationMin: number, notBefore = 0): number | null {
  for (const g of gaps) {
    const start = Math.ceil(Math.max(g.start, notBefore) / SLOT_MIN) * SLOT_MIN
    if (start + durationMin <= g.end) return start
  }
  return null
}

/** "2h 45m", "45m", "3h". */
export function formatMinutes(min: number): string {
  const m = Math.round(Math.max(0, min))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r}m`
  return r === 0 ? `${h}h` : `${h}h ${r}m`
}

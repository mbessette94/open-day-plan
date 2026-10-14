import { describe, expect, it } from 'vitest'
import { computeCapacity, findFreeSlot, formatMinutes, mergeIntervals } from './capacity'
import type { CalendarEvent, Task } from './types'

const DAY = '2026-10-14T00:00:00.000Z' // treat the test timezone as UTC
const at = (hhmm: string): string => `2026-10-14T${hhmm}:00.000Z`
const event = (id: string, start: string, end: string, all_day = false): CalendarEvent => ({
  id,
  integration_id: 'i',
  calendar_id: 'c',
  title: id,
  start_at: all_day ? '2026-10-14' : at(start),
  end_at: all_day ? '2026-10-15' : at(end),
  all_day,
  location: null,
  url: null,
  context: 'work'
})
const task = (id: string, start: string, duration: number): Task =>
  ({ id, scheduled_at: at(start), duration_min: duration }) as Task

const window = { start: '09:00', end: '17:00' }

describe('computeCapacity', () => {
  it('sums meetings, planned and free time, ignoring all-day events', () => {
    const c = computeCapacity(
      window,
      DAY,
      [event('standup', '10:00', '10:30'), event('offsite', '', '', true)],
      [task('a', '13:00', 60)]
    )
    expect(c).toMatchObject({
      windowMin: 480,
      meetingMin: 30,
      plannedMin: 60,
      overlapMin: 0,
      freeMin: 390
    })
    expect(c.gaps).toEqual([
      { start: 540, end: 600 },
      { start: 630, end: 780 },
      { start: 840, end: 1020 }
    ])
  })

  it('flags double-booking and conflicting tasks', () => {
    const c = computeCapacity(
      window,
      DAY,
      [event('review', '14:00', '15:00')],
      [task('clash', '14:30', 60), task('fine', '09:00', 30)]
    )
    expect(c.overlapMin).toBe(30)
    expect(c.conflictTaskIds).toEqual(['clash'])
    expect(c.freeMin).toBe(480 - 60 - 30 - 60 + 30) // busy = 09:00-09:30 + 14:00-15:30
  })

  it('merges overlapping meetings and clips to the window', () => {
    const c = computeCapacity(
      window,
      DAY,
      [event('a', '08:00', '10:00'), event('b', '09:30', '11:00'), event('late', '16:30', '18:00')],
      []
    )
    expect(c.meetingMin).toBe(120 + 30) // 09:00-11:00 and 16:30-17:00
  })

  it('totals the time the unscheduled items need', () => {
    const c = computeCapacity(
      window,
      DAY,
      [],
      [],
      [{ duration_min: 90 } as Task, { duration_min: 45 } as Task]
    )
    expect(c.needMin).toBe(135)
  })
})

describe('findFreeSlot', () => {
  const gaps = [
    { start: 540, end: 570 },
    { start: 630, end: 780 }
  ]
  it('finds the first gap that fits, aligned to 15 minutes and not in the past', () => {
    expect(findFreeSlot(gaps, 30)).toBe(540)
    expect(findFreeSlot(gaps, 60)).toBe(630)
    expect(findFreeSlot(gaps, 30, 545)).toBe(630) // 09:15 start leaves only 15 minutes
    expect(findFreeSlot(gaps, 60, 641)).toBe(645)
    expect(findFreeSlot(gaps, 200)).toBeNull()
  })
})

describe('helpers', () => {
  it('merges touching intervals and formats minutes', () => {
    expect(
      mergeIntervals([
        { start: 10, end: 20 },
        { start: 20, end: 30 },
        { start: 50, end: 60 }
      ])
    ).toEqual([
      { start: 10, end: 30 },
      { start: 50, end: 60 }
    ])
    expect([formatMinutes(165), formatMinutes(45), formatMinutes(180), formatMinutes(-5)]).toEqual([
      '2h 45m',
      '45m',
      '3h',
      '0m'
    ])
  })
})

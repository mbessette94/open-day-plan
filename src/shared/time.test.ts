import { describe, expect, it } from 'vitest'
import {
  addDays,
  dayBounds,
  gridFor,
  hhmm,
  isWorkDay,
  localDay,
  nextWorkDay,
  prevWorkDay,
  targetDay,
  weekdayOf,
  windowFor,
  zonedInstant
} from './time'
import type { UserSettings } from './types'

const settings: UserSettings = {
  timezone: 'America/Los_Angeles',
  work_days: ['mo', 'tu', 'we', 'th', 'fr'],
  work_time_start: '09:00',
  work_time_end: '17:00',
  personal_time_start: '07:00',
  personal_time_end: '22:00',
  sync_minutes: 15,
  notify_enabled: true,
  notify_lead_min: 5,
  digest_time: '08:30',
  shutdown_time: '17:00',
  quick_hotkey: 'Control+Alt+Space',
  launch_at_login: false,
  backup_dir: null,
  backup_keep: 14
}

describe('day math', () => {
  it('computes weekdays and day arithmetic', () => {
    expect(weekdayOf('2026-10-13')).toBe('tu')
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
  })

  it('skips the weekend to the next work day', () => {
    expect(nextWorkDay('2026-10-16', settings)).toBe('2026-10-19') // Fri -> Mon
    expect(nextWorkDay('2026-10-17', settings)).toBe('2026-10-19') // Sat -> Mon
  })

  it('finds the previous work day, skipping the weekend', () => {
    expect(prevWorkDay('2026-10-19', settings)).toBe('2026-10-16') // Mon -> Fri
    expect(prevWorkDay('2026-10-14', settings)).toBe('2026-10-13')
    expect(prevWorkDay('2026-10-14', { work_days: [] })).toBe('2026-10-13')
  })

  it('falls back to tomorrow when there are no work days', () => {
    expect(nextWorkDay('2026-10-13', { work_days: [] })).toBe('2026-10-14')
  })

  it('uses the settings timezone for the local day', () => {
    const now = new Date('2026-10-14T03:00:00Z') // still Oct 13 in LA
    expect(localDay(now, 'America/Los_Angeles')).toBe('2026-10-13')
    expect(localDay(now, 'UTC')).toBe('2026-10-14')
  })

  it('returns true UTC instants (not zone-offset strings) so they compare chronologically', () => {
    expect(zonedInstant('2026-10-14', '09:00', 'America/Los_Angeles')).toBe(
      '2026-10-14T16:00:00.000Z'
    )
    const b = dayBounds('2026-10-14', 'America/Los_Angeles')
    // an evening completion (03:00Z next day = 20:00 local) belongs to the day, not the next one
    expect('2026-10-15T03:00:00.000Z' >= b.start && '2026-10-15T03:00:00.000Z' < b.end).toBe(true)
  })

  it('returns 23h/25h days across DST changes', () => {
    const b = dayBounds('2026-11-01', 'America/Los_Angeles') // fall back
    expect((Date.parse(b.end) - Date.parse(b.start)) / 3_600_000).toBe(25)
  })
})

describe('tabs', () => {
  const fri = new Date('2026-10-16T19:00:00Z')
  it('work tomorrow is the next work day, personal tomorrow is the next day', () => {
    expect(targetDay({ context: 'work', when: 'tomorrow' }, fri, settings)).toBe('2026-10-19')
    expect(targetDay({ context: 'personal', when: 'tomorrow' }, fri, settings)).toBe('2026-10-17')
    expect(targetDay({ context: 'work', when: 'today' }, fri, settings)).toBe('2026-10-16')
  })

  it('has no work window on a non-work day', () => {
    expect(isWorkDay('2026-10-17', settings)).toBe(false)
    expect(windowFor('work', '2026-10-17', settings)).toBeNull()
  })

  it('widens personal to cover work hours on a non-work day', () => {
    const wide = { ...settings, personal_time_start: '10:00', personal_time_end: '16:00' }
    expect(windowFor('personal', '2026-10-17', wide)).toEqual({ start: '09:00', end: '17:00' })
    expect(windowFor('personal', '2026-10-16', wide)).toEqual({ start: '10:00', end: '16:00' })
  })
})

describe('agenda grid', () => {
  it('aligns to whole hours with 15 minute slots', () => {
    expect(gridFor({ start: '09:30', end: '17:10' })).toEqual({ start: 540, end: 1080, slots: 36 })
    expect(hhmm(615)).toBe('10:15')
  })
})

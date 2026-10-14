import { describe, expect, it } from 'vitest'
import { defaultContext, parseCapture } from './capture'
import type { UserSettings } from './types'

const s: UserSettings = {
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
const wedMorning = new Date('2026-10-14T17:00:00Z') // Wed 10:00 in LA
const tueEvening = new Date('2026-10-14T03:00:00Z') // Tue 20:00 in LA
const friNoon = new Date('2026-10-16T19:00:00Z') // Fri 12:00 in LA

describe('defaultContext', () => {
  it('is work during work hours on a work day, otherwise personal', () => {
    expect(defaultContext(wedMorning, s)).toBe('work')
    expect(defaultContext(tueEvening, s)).toBe('personal')
    expect(defaultContext(new Date('2026-10-17T19:00:00Z'), s)).toBe('personal') // Saturday
  })
})

describe('parseCapture', () => {
  it('treats plain text as a note and ignores empty input', () => {
    expect(parseCapture('  talked to Sam about the launch ', wedMorning, s)).toEqual({
      kind: 'note',
      text: 'talked to Sam about the launch'
    })
    expect(parseCapture('   ', wedMorning, s)).toBeNull()
  })

  it('makes a task from a leading + and consumes the tokens', () => {
    const c = parseCapture(
      '+ !1 #personal call the dentist @3:30pm tomorrow due:fri',
      wedMorning,
      s
    )
    expect(c).toMatchObject({
      kind: 'task',
      title: 'call the dentist',
      context: 'personal',
      priority: 1,
      assigned_date: '2026-10-15',
      scheduled_at: '2026-10-15T22:30:00.000Z', // Thu 15:30 LA
      due_date: '2026-10-16'
    })
  })

  it('lands on today with no schedule when there is no time', () => {
    const c = parseCapture('+write report', wedMorning, s)
    expect(c).toMatchObject({
      kind: 'task',
      context: 'work',
      assigned_date: '2026-10-14',
      scheduled_at: null
    })
  })

  it('sends work tomorrow to the next work day and personal tomorrow to the next day', () => {
    const work = parseCapture('+ plan sprint #work tomorrow', friNoon, s)
    const personal = parseCapture('+ groceries #personal tomorrow', friNoon, s)
    if (work?.kind !== 'task' || personal?.kind !== 'task') throw new Error('expected tasks')
    expect(work.assigned_date).toBe('2026-10-19') // Monday
    expect(personal.assigned_date).toBe('2026-10-17') // Saturday
  })

  it('resolves weekday names to the next occurrence and honours the caller defaults', () => {
    const c = parseCapture('+ review PRs monday', wedMorning, s)
    if (c?.kind !== 'task') throw new Error('expected task')
    expect(c.assigned_date).toBe('2026-10-19')
    const d = parseCapture('+ from the tab', wedMorning, s, {
      context: 'personal',
      day: '2026-10-15'
    })
    if (d?.kind !== 'task') throw new Error('expected task')
    expect(d.context).toBe('personal')
    expect(d.assigned_date).toBe('2026-10-15')
  })

  it('ignores invalid tokens and returns null when no title is left', () => {
    expect(parseCapture('+ !1 #work today', wedMorning, s)).toBeNull()
    const c = parseCapture('+ ship it @25:00 due:someday !9', wedMorning, s)
    expect(c).toMatchObject({
      kind: 'task',
      title: 'ship it @25:00 due:someday !9',
      scheduled_at: null,
      due_date: null
    })
  })

  it('parses due dates in several forms', () => {
    const due = (token: string): string | null => {
      const c = parseCapture(`+ x due:${token}`, wedMorning, s)
      return c?.kind === 'task' ? c.due_date : null
    }
    expect(due('2026-12-01')).toBe('2026-12-01')
    expect(due('12-25')).toBe('2026-12-25')
    expect(due('01-05')).toBe('2027-01-05')
    expect(due('tomorrow')).toBe('2026-10-15')
  })
})

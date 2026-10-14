import { describe, expect, it } from 'vitest'
import { computeDue, type NotifyInput, type NotifyTask } from './notify'
import type { UserSettings } from './types'

const s: UserSettings = {
  timezone: 'UTC',
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
const at = (hhmm: string, day = '2026-10-14'): Date => new Date(`${day}T${hhmm}:00Z`) // Wednesday
const base = (now: Date, over: Partial<NotifyInput> = {}): NotifyInput => ({
  now,
  settings: s,
  scheduled: [],
  dueTasks: [],
  events: [],
  reviewedToday: false,
  fired: new Set(),
  ...over
})
const task = (id: string, scheduled_at: string, due_date: string | null = null): NotifyTask => ({
  id,
  title: `Task ${id}`,
  scheduled_at,
  duration_min: 30,
  due_date
})

describe('computeDue: scheduled tasks and events', () => {
  const t = task('a', '2026-10-14T10:00:00.000Z')

  it('fires inside the lead window, not before', () => {
    expect(computeDue(base(at('09:54'), { scheduled: [t] }))).toEqual([])
    const due = computeDue(base(at('09:56'), { scheduled: [t] }))
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({
      key: 'task:a:2026-10-14T10:00:00.000Z',
      title: 'Task a',
      body: 'Starts 10:00 · 30 min',
      action: { type: 'task', id: 'a' }
    })
  })

  it('still fires just after the start but skips stale ones (no flood after sleep)', () => {
    expect(computeDue(base(at('10:01'), { scheduled: [t] }))).toHaveLength(1)
    expect(computeDue(base(at('10:10'), { scheduled: [t] }))).toEqual([])
  })

  it('does not repeat a notification that already fired', () => {
    const fired = new Set(['task:a:2026-10-14T10:00:00.000Z'])
    expect(computeDue(base(at('09:58'), { scheduled: [t], fired }))).toEqual([])
    // rescheduling changes the key, so it can fire again for the new time
    const moved = task('a', '2026-10-14T11:00:00.000Z')
    expect(computeDue(base(at('10:58'), { scheduled: [moved], fired }))).toHaveLength(1)
  })

  it('notifies for events with their location', () => {
    const due = computeDue(
      base(at('09:57'), {
        events: [
          {
            key: 'i:c:e:2026-10-14T10:00:00.000Z',
            title: 'Review',
            start_at: '2026-10-14T10:00:00.000Z',
            location: 'Room 4'
          }
        ]
      })
    )
    expect(due[0]).toMatchObject({
      key: 'event:i:c:e:2026-10-14T10:00:00.000Z',
      body: 'Starts 10:00 · Room 4',
      action: null
    })
  })

  it('respects the master switch and a custom lead time', () => {
    expect(
      computeDue(base(at('09:58'), { scheduled: [t], settings: { ...s, notify_enabled: false } }))
    ).toEqual([])
    expect(
      computeDue(base(at('09:45'), { scheduled: [t], settings: { ...s, notify_lead_min: 20 } }))
    ).toHaveLength(1)
  })
})

describe('computeDue: digest and shutdown', () => {
  const dueTasks = [
    task('d1', '', '2026-10-14'),
    task('d2', '', '2026-10-14'),
    task('o1', '', '2026-10-10')
  ]

  it('sends one morning digest of what is due, only in its window and only if something is due', () => {
    expect(computeDue(base(at('08:00'), { dueTasks }))).toEqual([])
    const due = computeDue(base(at('08:45'), { dueTasks }))
    expect(due).toEqual([
      {
        key: 'digest:2026-10-14',
        title: 'Today',
        body: '2 due today, 1 overdue',
        action: { type: 'standup' }
      }
    ])
    expect(
      computeDue(base(at('08:45'), { dueTasks, fired: new Set(['digest:2026-10-14']) }))
    ).toEqual([])
    expect(computeDue(base(at('09:45'), { dueTasks }))).toEqual([]) // too late
    expect(computeDue(base(at('08:45'), { dueTasks: [] }))).toEqual([])
  })

  it('nudges to wrap up at shutdown time on work days, unless already wrapped up', () => {
    expect(computeDue(base(at('16:59')))).toEqual([])
    expect(computeDue(base(at('17:05')))[0]).toMatchObject({
      key: 'shutdown:2026-10-14',
      action: { type: 'wrapup' }
    })
    expect(computeDue(base(at('17:05'), { reviewedToday: true }))).toEqual([])
    expect(computeDue(base(at('17:05', '2026-10-17')))).toEqual([]) // Saturday
    expect(computeDue(base(at('18:45')))).toEqual([]) // outside the window
  })
})

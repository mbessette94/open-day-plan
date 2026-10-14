import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import {
  addDays,
  dayBounds,
  localDay,
  nextWorkDay,
  prevWorkDay,
  zonedInstant
} from '../shared/time'
import { listActivity } from './db/activity'
import { getDb, openDb } from './db'
import { applyReview, getReview } from './db/review'
import { getSettings, updateSettings } from './db/settings'
import {
  createTask,
  getTaskDetail,
  scheduleTask,
  setCompleted,
  setPriority,
  updateTask
} from './db/tasks'
import { addComment } from './dayloopTestUtils'
import { buildStandup } from './standup'

const now = new Date()
const tz = 'UTC'
const today = (): string => localDay(now, tz)

beforeEach(() => {
  openDb(':memory:')
  updateSettings({ timezone: tz })
})

function completeAt(id: string, day: string): void {
  // completed at noon UTC on `day`
  getDb().prepare('UPDATE task SET completed_at = ? WHERE id = ?').run(`${day}T12:00:00.000Z`, id)
}

describe('buildStandup', () => {
  it('collects yesterday, today and blockers for a context', () => {
    const s = getSettings()
    const prev = prevWorkDay(today(), s)
    const done = createTask({ context: 'work', title: 'Shipped report', assigned_date: null })
    setCompleted(done.id, true)
    completeAt(done.id, prev)
    const other = createTask({ context: 'personal', title: 'Personal done', assigned_date: null })
    setCompleted(other.id, true)
    completeAt(other.id, prev)
    const noted = createTask({ context: 'work', title: 'Migration', assigned_date: null })
    addComment(noted.id, 'rolled back', `${prev}T13:00:00.000Z`)

    const now0 = createTask({
      context: 'work',
      title: 'Fix login',
      assigned_date: today()
    })
    setPriority(now0.id, 3)
    const sched = createTask({
      context: 'work',
      title: 'Planning',
      assigned_date: today()
    })
    scheduleTask(sched.id, zonedInstant(today(), '10:30', tz))
    const wait = createTask({
      context: 'work',
      title: 'Vendor quote',
      assigned_date: today()
    })
    setPriority(wait.id, 1)
    const late = createTask({ context: 'work', title: 'Tax forms', assigned_date: null })
    updateTask(late.id, { due_date: addDays(today(), -3) })

    const d = buildStandup('work', now)
    expect(d.previousDay).toBe(prev)
    expect(d.done).toEqual(['Shipped report'])
    expect(d.comments).toEqual([{ task: 'Migration', text: 'rolled back' }])
    expect(d.todayItems.map((i) => [i.title, i.time])).toEqual([
      ['Planning', '10:30'],
      ['Fix login', null],
      ['Tax forms', null] // due items are listed too
    ])
    expect(d.blockers).toEqual([
      { title: 'Vendor quote', reason: 'delegated', due: null },
      { title: 'Tax forms', reason: 'overdue', due: addDays(today(), -3) }
    ])
    expect(buildStandup('personal', now).done).toEqual(['Personal done'])
  })
})

describe('end-of-day review', () => {
  const open = (context: 'work' | 'personal', title: string): string =>
    createTask({ context, title, assigned_date: today() }).id

  it('lists unfinished tasks from both contexts and counts what was completed', () => {
    open('work', 'A')
    open('personal', 'B')
    const c = createTask({
      context: 'work',
      title: 'C',
      assigned_date: today()
    })
    setCompleted(c.id, true)
    const r = getReview(now)
    expect(r.tasks.map((t) => t.title).sort()).toEqual(['A', 'B'])
    expect(r.completedCount).toBe(1)
    expect(r.reviewedAt).toBeNull()
  })

  it('applies keep / tomorrow / backlog / done and records the day', () => {
    const s = getSettings()
    const keep = open('work', 'keep')
    const roll = open('work', 'roll')
    const sched = open('work', 'sched')
    scheduleTask(sched, zonedInstant(today(), '14:30', tz))
    const park = open('work', 'park')
    setPriority(park, 2)
    scheduleTask(park, zonedInstant(today(), '11:00', tz))
    const finish = open('work', 'finish')
    const home = open('personal', 'home')

    applyReview(
      [
        { id: keep, choice: 'keep' },
        { id: roll, choice: 'tomorrow' },
        { id: sched, choice: 'tomorrow' },
        { id: park, choice: 'backlog' },
        { id: finish, choice: 'done' },
        { id: home, choice: 'tomorrow' }
      ],
      now
    )

    const nextWork = nextWorkDay(today(), s)
    expect(getTaskDetail(roll).task.assigned_date).toBe(nextWork)
    expect(getTaskDetail(sched).task.scheduled_at).toBe(zonedInstant(nextWork, '14:30', tz))
    expect(getTaskDetail(sched).task.assigned_date).toBe(nextWork)
    expect(getTaskDetail(home).task.assigned_date).toBe(addDays(today(), 1))
    expect(getTaskDetail(park).task).toMatchObject({ priority: null, scheduled_at: null })
    expect(getTaskDetail(finish).task.completed_at).not.toBeNull()
    expect(getTaskDetail(keep).task.assigned_date).toBe(today())

    const b = dayBounds(today(), tz)
    expect(b.start).toBeTruthy()
    const rec = getDb().prepare('SELECT * FROM day_record WHERE day = ?').get(today()) as {
      reviewed_at: string | null
      completed_count: number
      carried_count: number
    }
    expect(rec.reviewed_at).not.toBeNull()
    expect(rec.completed_count).toBe(1)
    expect(rec.carried_count).toBe(1) // only "keep" is still on today's lists
    expect(getReview(now).reviewedAt).not.toBeNull()
    expect(
      listActivity().some((a) =>
        a.action_taken.startsWith(
          `Wrapped up ${today()}: 1 done, 3 rolled to tomorrow, 1 to backlog`
        )
      )
    ).toBe(true)
  })
})

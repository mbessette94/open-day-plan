import { ACTIVITY } from '../../shared/activity'
import {
  addDays,
  dayBounds,
  hhmm,
  localDay,
  localMinutes,
  nextWorkDay,
  zonedInstant
} from '../../shared/time'
import type { Context, ReviewAction, ReviewData, Task } from '../../shared/types'
import { addActivity } from './activity'
import { recordToday } from './dayRecords'
import { getDb } from './index'
import { getSettings } from './settings'
import { listTasks, setCompleted } from './tasks'

const CONTEXTS: Context[] = ['work', 'personal']
const COMPLETED_TODAY = `completed_at >= ? AND completed_at < ?
  AND (parent IS NULL OR parent IN (SELECT id FROM task WHERE is_project = 1))`

function openToday(now: Date): { tasks: Task[]; today: string } {
  const s = getSettings()
  const today = localDay(now, s.timezone)
  const b = dayBounds(today, s.timezone)
  const tasks = CONTEXTS.flatMap((context) =>
    listTasks({
      context,
      day: today,
      dayStart: b.start,
      dayEnd: b.end,
      includeCarryover: true,
      includeCompleted: false
    })
  ).filter((t) => t.completed_at === null)
  return { tasks, today }
}

export function getReview(now = new Date()): ReviewData {
  const s = getSettings()
  const db = getDb()
  const { tasks, today } = openToday(now)
  const b = dayBounds(today, s.timezone)
  const completedCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM task WHERE ${COMPLETED_TODAY}`).get(b.start, b.end) as {
      n: number
    }
  ).n
  const rec = db.prepare('SELECT reviewed_at FROM day_record WHERE day = ?').get(today) as
    { reviewed_at: string | null } | undefined
  return { day: today, completedCount, reviewedAt: rec?.reviewed_at ?? null, tasks }
}

interface ReviewRow {
  id: string
  context: Context
  title: string
  scheduled_at: string | null
}

/** Apply the end-of-day choices in one transaction and record the day's summary. */
export function applyReview(actions: ReviewAction[], now = new Date()): void {
  const s = getSettings()
  const db = getDb()
  const today = localDay(now, s.timezone)
  const getRow = db.prepare('SELECT id, context, title, scheduled_at FROM task WHERE id = ?')

  let tomorrow = 0
  let backlog = 0
  const parked = new Set<string>() // sent to the backlog this time, so not "carried"
  db.transaction(() => {
    for (const a of actions) {
      const t = getRow.get(a.id) as ReviewRow | undefined
      if (!t || a.choice === 'keep') continue
      if (a.choice === 'done') {
        setCompleted(t.id, true)
      } else if (a.choice === 'backlog') {
        db.prepare('UPDATE task SET priority = NULL, scheduled_at = NULL WHERE id = ?').run(t.id)
        addActivity(ACTIVITY.taskMoved, `Moved '${t.title}' to the backlog`, t.id, { to: null })
        backlog++
        parked.add(t.id)
      } else {
        const next = t.context === 'work' ? nextWorkDay(today, s) : addDays(today, 1)
        // a scheduled task keeps its time of day on the new date
        const scheduled = t.scheduled_at
          ? zonedInstant(next, hhmm(localMinutes(new Date(t.scheduled_at), s.timezone)), s.timezone)
          : null
        db.prepare('UPDATE task SET assigned_date = ?, scheduled_at = ? WHERE id = ?').run(
          next,
          scheduled,
          t.id
        )
        addActivity(ACTIVITY.taskRolled, `Rolled '${t.title}' to tomorrow (${next})`, t.id, {
          date: next
        })
        tomorrow++
      }
    }

    recordToday(now)
    const b = dayBounds(today, s.timezone)
    const completed = (
      db.prepare(`SELECT COUNT(*) AS n FROM task WHERE ${COMPLETED_TODAY}`).get(b.start, b.end) as {
        n: number
      }
    ).n
    const carried = openToday(now).tasks.filter((t) => !parked.has(t.id)).length
    db.prepare(
      'UPDATE day_record SET reviewed_at = ?, completed_count = ?, carried_count = ? WHERE day = ?'
    ).run(new Date().toISOString(), completed, carried, today)
    addActivity(
      ACTIVITY.reviewWrapped,
      `Wrapped up ${today}: ${completed} done, ${tomorrow} rolled to tomorrow, ${backlog} to backlog, ${carried} still open`,
      null,
      { day: today, completed, tomorrow, backlog, carried }
    )
  })()
}

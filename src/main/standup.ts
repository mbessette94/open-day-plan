import { addDays, dayBounds, hhmm, localDay, localMinutes, prevWorkDay } from '../shared/time'
import type { Context, StandupData } from '../shared/types'
import { getDb } from './db'
import { getSettings } from './db/settings'
import { listTasks } from './db/tasks'
import { listEvents } from './integrations/calendarSync'

// top-level tasks and subtasks of projects; checklist subtasks are noise in a standup
const LISTABLE = `(parent IS NULL OR parent IN (SELECT id FROM task WHERE is_project = 1))`

export function buildStandup(context: Context, now = new Date()): StandupData {
  const s = getSettings()
  const db = getDb()
  const today = localDay(now, s.timezone)
  const previousDay = context === 'work' ? prevWorkDay(today, s) : addDays(today, -1)
  const prev = dayBounds(previousDay, s.timezone)
  const cur = dayBounds(today, s.timezone)

  const done = (
    db
      .prepare(
        `SELECT title FROM task WHERE context = ? AND ${LISTABLE}
           AND completed_at >= ? AND completed_at < ? ORDER BY completed_at`
      )
      .all(context, prev.start, prev.end) as { title: string }[]
  ).map((r) => r.title)

  const comments = (
    db
      .prepare(
        `SELECT t.title AS task, a.action_taken AS text FROM activity_log a
         JOIN task t ON t.id = a.ref_id
         WHERE a.type = 'comment' AND t.context = ? AND a.created_at >= ? AND a.created_at < ?
         ORDER BY a.created_at`
      )
      .all(context, prev.start, prev.end) as { task: string; text: string }[]
  ).map((c) => ({
    task: c.task,
    text: c.text.length > 140 ? `${c.text.slice(0, 137)}...` : c.text
  }))

  const open = listTasks({
    context,
    day: today,
    dayStart: cur.start,
    dayEnd: cur.end,
    includeCarryover: true,
    includeCompleted: false
  }).filter((t) => t.completed_at === null)
  const timeOf = (iso: string): string => hhmm(localMinutes(new Date(iso), s.timezone))
  const todayItems = open
    .filter(
      (t) =>
        t.scheduled_at !== null ||
        t.priority === 3 ||
        t.priority === 2 ||
        (t.due_date !== null && t.due_date <= today)
    )
    .sort(
      (a, b) =>
        (a.scheduled_at ? 0 : 1) - (b.scheduled_at ? 0 : 1) ||
        (a.scheduled_at ?? '').localeCompare(b.scheduled_at ?? '') ||
        (b.priority ?? -1) - (a.priority ?? -1)
    )
    .map((t) => ({
      title: t.title,
      time: t.scheduled_at ? timeOf(t.scheduled_at) : null,
      priority: t.priority,
      due: t.due_date
    }))

  // personal commitments are synthesized busy time, not meetings
  const timed = listEvents(context, today, cur.start, cur.end).filter((e) => !e.all_day && !e.block)
  const meetings = {
    count: timed.length,
    first: timed.length ? timeOf(timed.map((e) => e.start_at).sort()[0]) : null
  }

  const delegated = open
    .filter((t) => t.priority === 1)
    .map((t) => ({ title: t.title, reason: 'delegated' as const, due: t.due_date }))
  const overdue = (
    db
      .prepare(
        `SELECT title, due_date FROM task WHERE context = ? AND ${LISTABLE}
           AND completed_at IS NULL AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date`
      )
      .all(context, today) as { title: string; due_date: string }[]
  ).map((t) => ({ title: t.title, reason: 'overdue' as const, due: t.due_date }))

  return {
    context,
    today,
    previousDay,
    done,
    comments,
    todayItems,
    meetings,
    blockers: [...delegated, ...overdue]
  }
}

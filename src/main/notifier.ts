import { Notification } from 'electron'
import {
  computeDue,
  type DueNotification,
  type NotifyEvent,
  type NotifyInput,
  type NotifyTask
} from '../shared/notify'
import { hhmm, localDay, localMinutes } from '../shared/time'
import type { UiAction } from '../shared/types'
import { getDb } from './db'
import { getSettings } from './db/settings'

const TICK_MS = 30_000
const LOOKBEHIND_MS = 5 * 60_000
const KEEP_MS = 7 * 24 * 3600_000

// top-level tasks and subtasks of projects
const LISTABLE = `(parent IS NULL OR parent IN (SELECT id FROM task WHERE is_project = 1))`

export function collectNotifyInput(now: Date): NotifyInput {
  const s = getSettings()
  const db = getDb()
  const from = new Date(now.getTime() - LOOKBEHIND_MS).toISOString()
  const to = new Date(now.getTime() + s.notify_lead_min * 60_000 + LOOKBEHIND_MS).toISOString()
  const today = localDay(now, s.timezone)

  const scheduled = db
    .prepare(
      `SELECT id, title, scheduled_at, duration_min, due_date FROM task
       WHERE completed_at IS NULL AND scheduled_at >= ? AND scheduled_at < ?`
    )
    .all(from, to) as NotifyTask[]
  const dueTasks = db
    .prepare(
      `SELECT id, title, scheduled_at, duration_min, due_date FROM task
       WHERE completed_at IS NULL AND due_date IS NOT NULL AND due_date <= ? AND ${LISTABLE}`
    )
    .all(today) as NotifyTask[]
  const events = (
    db
      .prepare(
        `SELECT e.integration_id, e.calendar_id, e.external_id, e.title, e.start_at, e.location
         FROM calendar_event e JOIN integration i ON i.id = e.integration_id AND i.enabled = 1
         WHERE e.start_at >= ? AND e.start_at < ?`
      )
      .all(from, to) as {
      integration_id: string
      calendar_id: string
      external_id: string
      title: string
      start_at: string
      location: string | null
    }[]
  ).map((e): NotifyEvent => ({
    key: `${e.integration_id}:${e.calendar_id}:${e.external_id}:${e.start_at}`,
    title: e.title,
    start_at: e.start_at,
    location: e.location
  }))
  const reviewed = db.prepare('SELECT reviewed_at FROM day_record WHERE day = ?').get(today) as
    { reviewed_at: string | null } | undefined
  const fired = new Set(
    (db.prepare('SELECT key FROM notification_log').all() as { key: string }[]).map((r) => r.key)
  )
  return {
    now,
    settings: s,
    scheduled,
    dueTasks,
    events,
    reviewedToday: Boolean(reviewed?.reviewed_at),
    fired
  }
}

/** One pass: work out what is due, record it as fired, and hand each to `show`. */
export function runNotifierTick(now: Date, show: (n: DueNotification) => void): void {
  const due = computeDue(collectNotifyInput(now))
  const db = getDb()
  const mark = db.prepare('INSERT OR IGNORE INTO notification_log (key, fired_at) VALUES (?, ?)')
  for (const n of due) {
    mark.run(n.key, now.toISOString())
    show(n)
  }
}

export function startNotifier(onAction: (a: UiAction) => void): () => void {
  getDb()
    .prepare('DELETE FROM notification_log WHERE fired_at < ?')
    .run(new Date(Date.now() - KEEP_MS).toISOString())

  const show = (n: DueNotification): void => {
    if (!Notification.isSupported()) return
    const note = new Notification({ title: n.title, body: n.body })
    if (n.action) {
      const action = n.action
      note.on('click', () => onAction(action))
    }
    note.show()
  }
  const tick = (): void => {
    try {
      runNotifierTick(new Date(), show)
    } catch (e) {
      console.error('notifier tick failed', e)
    }
  }
  tick()
  const timer = setInterval(tick, TICK_MS)
  return () => clearInterval(timer)
}

/** The next scheduled task or timed meeting today (still ahead of `now`), for the menu-bar title. */
export function nextUp(now: Date): { at: string; title: string } | null {
  const s = getSettings()
  const db = getDb()
  const end = new Date(now.getTime() + 24 * 3600_000).toISOString()
  const task = db
    .prepare(
      `SELECT scheduled_at AS at, title FROM task
       WHERE completed_at IS NULL AND scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at LIMIT 1`
    )
    .get(now.toISOString(), end) as { at: string; title: string } | undefined
  const event = db
    .prepare(
      `SELECT e.start_at AS at, e.title FROM calendar_event e
       JOIN integration i ON i.id = e.integration_id AND i.enabled = 1
       WHERE e.start_at >= ? AND e.start_at < ? ORDER BY e.start_at LIMIT 1`
    )
    .get(now.toISOString(), end) as { at: string; title: string } | undefined
  const best = [task, event].filter(Boolean).sort((a, b) => a!.at.localeCompare(b!.at))[0]
  if (!best || localDay(new Date(best.at), s.timezone) !== localDay(now, s.timezone)) return null
  return best
}

export function nextUpLabel(now: Date): string {
  const n = nextUp(now)
  if (!n) return 'Plan'
  const time = hhmm(localMinutes(new Date(n.at), getSettings().timezone))
  const title = n.title.length > 22 ? `${n.title.slice(0, 21)}…` : n.title
  return `${time} ${title}`
}

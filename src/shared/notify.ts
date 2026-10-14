import { hhmm, isWorkDay, localDay, localMinutes, toMinutes } from './time'
import type { UiAction, UserSettings } from './types'

export interface NotifyTask {
  id: string
  title: string
  scheduled_at: string | null
  duration_min: number
  due_date: string | null
}
export interface NotifyEvent {
  key: string // stable across syncs: integration:calendar:external:start
  title: string
  start_at: string
  location: string | null
}
export interface NotifyInput {
  now: Date
  settings: UserSettings
  scheduled: NotifyTask[] // unfinished tasks with a scheduled_at near now
  dueTasks: NotifyTask[] // unfinished tasks with a due date on or before today
  events: NotifyEvent[] // timed events near now
  reviewedToday: boolean
  fired: Set<string>
}
export interface DueNotification {
  key: string
  title: string
  body: string
  action: UiAction | null
}

const GRACE_MS = 2 * 60_000 // still notify if we only noticed just after the start
const DIGEST_WINDOW_MIN = 60
const SHUTDOWN_WINDOW_MIN = 90

/** Which notifications should fire right now. Pure: the caller records the keys it fires. */
export function computeDue(i: NotifyInput): DueNotification[] {
  const s = i.settings
  if (!s.notify_enabled) return []
  const nowMs = i.now.getTime()
  const leadMs = s.notify_lead_min * 60_000
  const today = localDay(i.now, s.timezone)
  const minutes = localMinutes(i.now, s.timezone)
  const inLead = (iso: string): boolean => {
    const delta = Date.parse(iso) - nowMs
    return delta <= leadMs && delta >= -GRACE_MS
  }
  const at = (iso: string): string => hhmm(localMinutes(new Date(iso), s.timezone))
  const out: DueNotification[] = []

  for (const t of i.scheduled) {
    const key = `task:${t.id}:${t.scheduled_at}`
    if (t.scheduled_at && inLead(t.scheduled_at) && !i.fired.has(key)) {
      out.push({
        key,
        title: t.title,
        body: `Starts ${at(t.scheduled_at)} · ${t.duration_min} min`,
        action: { type: 'task', id: t.id }
      })
    }
  }
  for (const e of i.events) {
    const key = `event:${e.key}`
    if (inLead(e.start_at) && !i.fired.has(key)) {
      out.push({
        key,
        title: e.title,
        body: `Starts ${at(e.start_at)}${e.location ? ` · ${e.location}` : ''}`,
        action: null
      })
    }
  }

  const digestAt = toMinutes(s.digest_time)
  const digestKey = `digest:${today}`
  if (minutes >= digestAt && minutes < digestAt + DIGEST_WINDOW_MIN && !i.fired.has(digestKey)) {
    const dueToday = i.dueTasks.filter((t) => t.due_date === today).length
    const overdue = i.dueTasks.filter((t) => t.due_date !== null && t.due_date < today).length
    if (dueToday + overdue > 0) {
      out.push({
        key: digestKey,
        title: 'Today',
        body: [dueToday ? `${dueToday} due today` : '', overdue ? `${overdue} overdue` : '']
          .filter(Boolean)
          .join(', '),
        action: { type: 'standup' }
      })
    }
  }

  const shutdownAt = toMinutes(s.shutdown_time)
  const shutdownKey = `shutdown:${today}`
  if (
    isWorkDay(today, s) &&
    !i.reviewedToday &&
    minutes >= shutdownAt &&
    minutes < shutdownAt + SHUTDOWN_WINDOW_MIN &&
    !i.fired.has(shutdownKey)
  ) {
    out.push({
      key: shutdownKey,
      title: 'Wrap up the day?',
      body: 'Review what is left and roll it to tomorrow.',
      action: { type: 'wrapup' }
    })
  }
  return out
}

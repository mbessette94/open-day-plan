import { v7 as uuidv7 } from 'uuid'
import type { CalendarConfig, CalendarEvent, Context } from '../../shared/types'
import { addDays, dayBounds, isWorkDay, localDay, zonedInstant } from '../../shared/time'
import { getDb } from '../db'
import { getSettings } from '../db/settings'
import { fetchCalendarEvents } from './providers'
import { listRecords, type IntegrationRecord } from './registry'

// four weeks: far enough that a trip or OOO stretch shows on the work calendar well in advance
export const DAYS_AHEAD = 28
export const PERSONAL_COMMITMENT = 'Personal commitment'

/** Replace this integration's stored events with today through today+DAYS_AHEAD (in the user's timezone). */
export async function syncCalendar(rec: IntegrationRecord, now = new Date()): Promise<void> {
  const tz = getSettings().timezone
  const today = localDay(now, tz)
  const start = new Date(dayBounds(today, tz).start)
  const end = new Date(dayBounds(addDays(today, DAYS_AHEAD + 1), tz).start)
  const events = await fetchCalendarEvents(rec, start, end) // throws first: keep old events on failure

  const db = getDb()
  const insert = db.prepare(
    `INSERT OR REPLACE INTO calendar_event
       (id, integration_id, calendar_id, external_id, title, start_at, end_at, start_date, end_date,
        location, url, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const syncedAt = now.toISOString()
  let skipped = 0
  db.transaction(() => {
    db.prepare('DELETE FROM calendar_event WHERE integration_id = ?').run(rec.id)
    for (const e of events) {
      try {
        // all-day events carry plain dates, timed events carry UTC instants
        insert.run(
          uuidv7(),
          rec.id,
          e.calendar_id,
          e.external_id,
          e.title,
          e.all_day ? null : e.start_at,
          e.all_day ? null : e.end_at,
          e.all_day ? e.start_at : null,
          e.all_day ? e.end_at : null,
          e.location,
          e.url,
          syncedAt
        )
      } catch {
        skipped++ // one malformed event must not stop the rest from syncing
      }
    }
  })()
  if (skipped) console.warn(`calendar sync (${rec.name}): skipped ${skipped} malformed event(s)`)
}

interface EventRow {
  id: string
  integration_id: string
  calendar_id: string
  title: string
  start_at: string | null
  end_at: string | null
  start_date: string | null
  end_date: string | null
  location: string | null
  url: string | null
}

/** `${integration}|${calendar}` -> context, for the enabled calendar integrations. */
export function calendarContexts(): Map<string, Context> {
  const contextOf = new Map<string, Context>()
  for (const rec of listRecords()) {
    if (!rec.enabled || (rec.kind !== 'google_calendar' && rec.kind !== 'caldav')) continue
    for (const c of (rec.config as unknown as CalendarConfig).calendars ?? []) {
      contextOf.set(`${rec.id}|${c.id}`, c.context)
    }
  }
  return contextOf
}

export interface PersonalCommitment {
  event_id: string // the stored personal event this was clipped from
  integration_id: string
  calendar_id: string
  external_id: string
  day: string // the work day it falls on
  start_at: string // UTC instants, clipped to that day's work window
  end_at: string
}

/**
 * Timed personal-calendar events that overlap the work window of `day`, clipped to it. Empty on
 * non-work days. All-day personal events are not commitments. The app agenda and the blocks pushed
 * to the work calendar both come from here, so they always agree.
 */
export function listPersonalCommitments(
  day: string,
  contextOf = calendarContexts() // pass one map when looping over many days
): PersonalCommitment[] {
  const s = getSettings()
  if (!isWorkDay(day, s)) return []
  const winStart = zonedInstant(day, s.work_time_start, s.timezone)
  const winEnd = zonedInstant(day, s.work_time_end, s.timezone)
  if (winEnd <= winStart) return []
  const rows = getDb()
    .prepare(
      `SELECT id, integration_id, calendar_id, external_id, start_at, end_at
       FROM calendar_event
       WHERE start_at IS NOT NULL AND start_at < @winEnd AND end_at > @winStart
       ORDER BY start_at, id`
    )
    .all({ winStart, winEnd }) as {
    id: string
    integration_id: string
    calendar_id: string
    external_id: string
    start_at: string
    end_at: string
  }[]
  return rows
    .filter((r) => contextOf.get(`${r.integration_id}|${r.calendar_id}`) === 'personal')
    .map((r) => ({
      event_id: r.id,
      integration_id: r.integration_id,
      calendar_id: r.calendar_id,
      external_id: r.external_id,
      day,
      start_at: r.start_at > winStart ? r.start_at : winStart,
      end_at: r.end_at < winEnd ? r.end_at : winEnd
    }))
}

/**
 * Stored events for one local day, for calendars tagged with `context`. The work list also carries
 * a "Personal commitment" for each personal event that lands in work hours.
 */
export function listEvents(
  context: Context,
  day: string, // YYYY-MM-DD
  dayStart: string, // UTC instant
  dayEnd: string
): CalendarEvent[] {
  const contextOf = calendarContexts()
  const rows = getDb()
    .prepare(
      `SELECT id, integration_id, calendar_id, title, start_at, end_at, start_date, end_date, location, url
       FROM calendar_event
       WHERE (start_at IS NOT NULL AND start_at < @dayEnd AND end_at > @dayStart)
          OR (start_date IS NOT NULL AND start_date <= @day AND end_date > @day)
       ORDER BY start_date IS NULL, COALESCE(start_at, start_date), id`
    )
    .all({ day, dayStart, dayEnd }) as EventRow[]
  const events: CalendarEvent[] = rows
    // all-day events (holidays, OOO banners, "Offsite") are noise on a timed agenda: not shown
    .filter((r) => r.start_date === null)
    .filter((r) => contextOf.get(`${r.integration_id}|${r.calendar_id}`) === context)
    .map((r) => ({
      id: r.id,
      integration_id: r.integration_id,
      calendar_id: r.calendar_id,
      title: r.title,
      // the renderer sees one shape: all-day events carry dates in start_at / end_at
      start_at: (r.start_at ?? r.start_date) as string,
      end_at: (r.end_at ?? r.end_date) as string,
      all_day: r.start_date !== null,
      location: r.location,
      url: r.url,
      context,
      block: null
    }))
  if (context !== 'work') return events

  const commitments: CalendarEvent[] = listPersonalCommitments(day).map((c) => ({
    id: `personal:${c.event_id}`,
    integration_id: c.integration_id,
    calendar_id: c.calendar_id,
    title: PERSONAL_COMMITMENT,
    start_at: c.start_at,
    end_at: c.end_at,
    all_day: false,
    location: null,
    url: null,
    context,
    block: 'personal'
  }))
  return [...events, ...commitments].sort((a, b) => a.start_at.localeCompare(b.start_at))
}

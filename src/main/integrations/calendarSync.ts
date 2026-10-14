import { v7 as uuidv7 } from 'uuid'
import type { CalendarConfig, CalendarEvent, Context } from '../../shared/types'
import { addDays, dayBounds, localDay } from '../../shared/time'
import { getDb } from '../db'
import { getSettings } from '../db/settings'
import { fetchCalendarEvents } from './providers'
import { listRecords, type IntegrationRecord } from './registry'

const DAYS_AHEAD = 7

/** Replace this integration's stored events with today through today+7 (in the user's timezone). */
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

/** Stored events for one local day, for calendars tagged with `context`. */
export function listEvents(
  context: Context,
  day: string, // YYYY-MM-DD
  dayStart: string, // UTC instant
  dayEnd: string
): CalendarEvent[] {
  const contextOf = new Map<string, Context>() // `${integration}|${calendar}` -> context
  for (const rec of listRecords()) {
    if (!rec.enabled || (rec.kind !== 'google_calendar' && rec.kind !== 'caldav')) continue
    for (const c of (rec.config as unknown as CalendarConfig).calendars ?? []) {
      contextOf.set(`${rec.id}|${c.id}`, c.context)
    }
  }
  const rows = getDb()
    .prepare(
      `SELECT id, integration_id, calendar_id, title, start_at, end_at, start_date, end_date, location, url
       FROM calendar_event
       WHERE (start_at IS NOT NULL AND start_at < @dayEnd AND end_at > @dayStart)
          OR (start_date IS NOT NULL AND start_date <= @day AND end_date > @day)
       ORDER BY start_date IS NULL, COALESCE(start_at, start_date), id`
    )
    .all({ day, dayStart, dayEnd }) as EventRow[]
  return rows
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
      context
    }))
}

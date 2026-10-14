import { createDAVClient } from 'tsdav'
import type { CalendarConfig } from '../../../shared/types'
import { IntegrationError } from '../http'
import { parseIcs, type ParsedEvent } from '../ics'
import type { IntegrationRecord } from '../registry'

function cfg(rec: IntegrationRecord): CalendarConfig {
  return rec.config as unknown as CalendarConfig
}

async function connect(
  rec: IntegrationRecord
): Promise<Awaited<ReturnType<typeof createDAVClient>>> {
  const c = cfg(rec)
  if (!c.server_url || !c.username)
    throw new IntegrationError('Server URL and username are required')
  try {
    return await createDAVClient({
      serverUrl: c.server_url,
      credentials: { username: c.username, password: rec.secret ?? '' },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })
  } catch (e) {
    throw new IntegrationError(
      `CalDAV connection failed: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

export async function listCalendars(
  rec: IntegrationRecord
): Promise<{ id: string; name: string }[]> {
  const client = await connect(rec)
  const cals = await client.fetchCalendars()
  return cals.map((c) => ({
    id: c.url,
    name: typeof c.displayName === 'string' && c.displayName ? c.displayName : c.url
  }))
}

export async function test(rec: IntegrationRecord): Promise<{ message: string }> {
  const cals = await listCalendars(rec)
  return { message: `Connected. Found ${cals.length} calendar${cals.length === 1 ? '' : 's'}` }
}

export async function fetchEvents(
  rec: IntegrationRecord,
  start: Date,
  end: Date
): Promise<(ParsedEvent & { calendar_id: string })[]> {
  const selected = cfg(rec).calendars ?? []
  if (selected.length === 0) return []
  const client = await connect(rec)
  const cals = await client.fetchCalendars()
  const out: (ParsedEvent & { calendar_id: string })[] = []
  for (const sel of selected) {
    const cal = cals.find((c) => c.url === sel.id)
    if (!cal) continue
    const objs = await client.fetchCalendarObjects({
      calendar: cal,
      timeRange: { start: start.toISOString(), end: end.toISOString() }
    })
    for (const o of objs) {
      if (typeof o.data !== 'string') continue
      for (const ev of parseIcs(o.data, start, end)) out.push({ ...ev, calendar_id: sel.id })
    }
  }
  return out
}

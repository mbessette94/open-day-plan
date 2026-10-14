import { createDAVClient } from 'tsdav'
import type { CalendarConfig } from '../../../shared/types'
import { IntegrationError } from '../http'
import { buildBlockIcs, parseIcs, type BlockWrite, type ParsedEvent } from '../ics'
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

function assertOk(res: Response, what: string): void {
  if (res.ok) return
  throw new IntegrationError(
    res.status === 401 || res.status === 403
      ? `Authentication failed (HTTP ${res.status}); the calendar may be read-only`
      : `CalDAV ${what} failed (HTTP ${res.status})`
  )
}

/** Create the block as `<id>.ics` in the calendar, or overwrite it. Returns the object URL. */
export async function upsertBlock(
  rec: IntegrationRecord,
  calendarId: string,
  b: BlockWrite
): Promise<string> {
  const client = await connect(rec)
  const cal = (await client.fetchCalendars()).find((c) => c.url === calendarId)
  if (!cal) throw new IntegrationError('Calendar not found on the server')
  const iCalString = buildBlockIcs(b)
  if (b.remote_id) {
    const res = await client.updateCalendarObject({
      calendarObject: { url: b.remote_id, data: iCalString }
    })
    if (res.status !== 404) {
      assertOk(res, 'update')
      return b.remote_id
    } // deleted by hand: recreate below
  }
  const filename = `${b.id}.ics`
  assertOk(await client.createCalendarObject({ calendar: cal, filename, iCalString }), 'create')
  return new URL(filename, cal.url.endsWith('/') ? cal.url : `${cal.url}/`).href
}

/** Delete the block. Already gone counts as deleted. */
export async function deleteBlock(rec: IntegrationRecord, remoteId: string): Promise<void> {
  const client = await connect(rec)
  const res = await client.deleteCalendarObject({ calendarObject: { url: remoteId } })
  if (res.status !== 404 && res.status !== 410) assertOk(res, 'delete')
}

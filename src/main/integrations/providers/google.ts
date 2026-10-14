import type { CalendarConfig } from '../../../shared/types'
import { IntegrationError, request } from '../http'
import type { BlockWrite, ParsedEvent } from '../ics'
import { parseGoogleSecret, type IntegrationRecord } from '../registry'

const API = 'https://www.googleapis.com/calendar/v3'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'

function cfg(rec: IntegrationRecord): CalendarConfig {
  return rec.config as unknown as CalendarConfig
}

async function accessToken(rec: IntegrationRecord): Promise<string> {
  const secret = parseGoogleSecret(rec.secret)
  if (!cfg(rec).client_id || !secret.client_secret) {
    throw new IntegrationError('Client ID and client secret are required')
  }
  if (!secret.refresh_token) throw new IntegrationError('Not connected: use "Connect with Google"')
  const res = await request<{ access_token: string }>(TOKEN_URL, {
    form: {
      client_id: cfg(rec).client_id!,
      client_secret: secret.client_secret,
      refresh_token: secret.refresh_token,
      grant_type: 'refresh_token'
    }
  })
  return res.access_token
}

export async function listCalendars(
  rec: IntegrationRecord
): Promise<{ id: string; name: string }[]> {
  const token = await accessToken(rec)
  const res = await request<{ items: { id: string; summary: string; summaryOverride?: string }[] }>(
    `${API}/users/me/calendarList?minAccessRole=reader`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  // the provisioned Focus time calendar is ours: not something to pick as a source
  return res.items
    .filter((c) => c.id !== cfg(rec).focus_calendar_id)
    .map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary }))
}

export async function test(rec: IntegrationRecord): Promise<{ message: string }> {
  const cals = await listCalendars(rec)
  return { message: `Connected. Found ${cals.length} calendar${cals.length === 1 ? '' : 's'}` }
}

interface GEvent {
  id: string
  status?: string
  summary?: string
  location?: string
  htmlLink?: string
  extendedProperties?: { private?: Record<string, string> }
  start: { date?: string; dateTime?: string }
  end: { date?: string; dateTime?: string }
}

export function mapGoogleEvent(e: GEvent): ParsedEvent | null {
  if (e.status === 'cancelled') return null
  // a block this app wrote: reading it back would double-count it as a meeting
  if (e.extendedProperties?.private?.odp_block) return null
  const allDay = Boolean(e.start.date)
  const start = e.start.date ?? e.start.dateTime
  const end = e.end.date ?? e.end.dateTime
  if (!start || !end) return null
  return {
    external_id: e.id,
    title: e.summary || '(No title)',
    start_at: allDay ? start : new Date(start).toISOString(),
    end_at: allDay ? end : new Date(end).toISOString(),
    all_day: allDay,
    location: e.location ?? null,
    url: e.htmlLink ?? null
  }
}

export async function fetchEvents(
  rec: IntegrationRecord,
  start: Date,
  end: Date
): Promise<(ParsedEvent & { calendar_id: string })[]> {
  const selected = cfg(rec).calendars ?? []
  if (selected.length === 0) return []
  const token = await accessToken(rec)
  const out: (ParsedEvent & { calendar_id: string })[] = []
  for (const sel of selected) {
    let pageToken: string | undefined
    do {
      const qs = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        timeMin: start.toISOString(),
        timeMax: end.toISOString()
      })
      if (pageToken) qs.set('pageToken', pageToken)
      const res = await request<{ items: GEvent[]; nextPageToken?: string }>(
        `${API}/calendars/${encodeURIComponent(sel.id)}/events?${qs}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      for (const e of res.items) {
        const ev = mapGoogleEvent(e)
        if (ev) out.push({ ...ev, calendar_id: sel.id })
      }
      pageToken = res.nextPageToken
    } while (pageToken)
  }
  return out
}

const RECONNECT = 'Reconnect with Google to allow writing calendar blocks'

/** A token granted before v1.1.0 is read-only: Google answers writes with 401/403. */
function blockError(e: unknown): unknown {
  return e instanceof IntegrationError && /HTTP (401|403)/.test(e.message)
    ? new IntegrationError(RECONNECT)
    : e
}

const isGone = (e: unknown): boolean =>
  e instanceof IntegrationError && /HTTP (404|410)/.test(e.message)

/** Create the block, or update it in place. Returns the Google event id. */
export async function upsertBlock(
  rec: IntegrationRecord,
  calendarId: string,
  b: BlockWrite
): Promise<string> {
  const token = await accessToken(rec)
  const headers = { Authorization: `Bearer ${token}` }
  const body = {
    summary: b.title,
    start: { dateTime: b.start_at },
    end: { dateTime: b.end_at },
    transparency: 'opaque',
    reminders: { useDefault: false },
    extendedProperties: { private: { odp_block: b.kind, odp_id: b.id } }
  }
  const base = `${API}/calendars/${encodeURIComponent(calendarId)}/events`
  try {
    if (b.remote_id) {
      try {
        const res = await request<{ id: string }>(`${base}/${encodeURIComponent(b.remote_id)}`, {
          method: 'PATCH',
          headers,
          body
        })
        return res.id
      } catch (e) {
        if (!isGone(e)) throw e // deleted on the calendar by hand: fall through and recreate
      }
    }
    return (await request<{ id: string }>(base, { method: 'POST', headers, body })).id
  } catch (e) {
    throw blockError(e)
  }
}

/** Delete the block. Already gone counts as deleted. */
export async function deleteBlock(
  rec: IntegrationRecord,
  calendarId: string,
  remoteId: string
): Promise<void> {
  const token = await accessToken(rec)
  try {
    await request<void>(
      `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    )
  } catch (e) {
    if (!isGone(e)) throw blockError(e)
  }
}

/** The id of the calendar named `name` that we own, creating it if it does not exist. */
export async function ensureCalendar(
  rec: IntegrationRecord,
  name: string,
  timeZone: string
): Promise<string> {
  const token = await accessToken(rec)
  const headers = { Authorization: `Bearer ${token}` }
  try {
    const list = await request<{ items: { id: string; summary: string }[] }>(
      `${API}/users/me/calendarList?minAccessRole=owner`,
      { headers }
    )
    const found = list.items.find((c) => c.summary === name)
    if (found) return found.id
    const created = await request<{ id: string }>(`${API}/calendars`, {
      method: 'POST',
      headers,
      body: { summary: name, description: 'Created by Open Day Plan', timeZone }
    })
    return created.id
  } catch (e) {
    throw blockError(e)
  }
}

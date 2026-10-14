import type { CalendarConfig } from '../../../shared/types'
import { IntegrationError, request } from '../http'
import type { ParsedEvent } from '../ics'
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
  return res.items.map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary }))
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
  start: { date?: string; dateTime?: string }
  end: { date?: string; dateTime?: string }
}

export function mapGoogleEvent(e: GEvent): ParsedEvent | null {
  if (e.status === 'cancelled') return null
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
    const qs = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
      timeMin: start.toISOString(),
      timeMax: end.toISOString()
    })
    const res = await request<{ items: GEvent[] }>(
      `${API}/calendars/${encodeURIComponent(sel.id)}/events?${qs}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    for (const e of res.items) {
      const ev = mapGoogleEvent(e)
      if (ev) out.push({ ...ev, calendar_id: sel.id })
    }
  }
  return out
}

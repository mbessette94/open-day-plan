import type { ExternalIssue, LinkPreview } from '../../../shared/types'
import type { LinkRef } from '../../../shared/links'
import { IntegrationError } from '../http'
import type { BlockWrite, ParsedEvent } from '../ics'
import type { IntegrationRecord } from '../registry'
import * as caldav from './caldav'
import * as github from './github'
import * as google from './google'
import * as jira from './jira'
import * as linear from './linear'

export async function testProvider(
  rec: IntegrationRecord
): Promise<{ message: string; configPatch?: Record<string, unknown> }> {
  switch (rec.kind) {
    case 'jira':
      return jira.test(rec)
    case 'linear':
      return linear.test(rec)
    case 'github':
      return github.test(rec)
    case 'google_calendar':
      return google.test(rec)
    case 'caldav':
      return caldav.test(rec)
  }
}

export async function previewProvider(
  rec: IntegrationRecord,
  ref: LinkRef
): Promise<Omit<LinkPreview, 'integration_name'> | null> {
  if (rec.kind === 'jira' && ref.kind === 'jira') return jira.preview(rec, ref)
  if (rec.kind === 'linear' && ref.kind === 'linear') return linear.preview(rec, ref)
  if (rec.kind === 'github' && ref.kind === 'github') return github.preview(rec, ref)
  return null
}

export async function listProvider(
  rec: IntegrationRecord
): Promise<Omit<ExternalIssue, 'added'>[]> {
  if (rec.kind === 'jira') return jira.list(rec)
  if (rec.kind === 'linear') return linear.list(rec)
  if (rec.kind === 'github') return github.list(rec)
  throw new IntegrationError('This integration has no issue list')
}

export async function listCalendarsProvider(
  rec: IntegrationRecord
): Promise<{ id: string; name: string }[]> {
  if (rec.kind === 'google_calendar') return google.listCalendars(rec)
  if (rec.kind === 'caldav') return caldav.listCalendars(rec)
  throw new IntegrationError('Not a calendar integration')
}

export async function fetchCalendarEvents(
  rec: IntegrationRecord,
  start: Date,
  end: Date
): Promise<(ParsedEvent & { calendar_id: string })[]> {
  if (rec.kind === 'google_calendar') return google.fetchEvents(rec, start, end)
  if (rec.kind === 'caldav') return caldav.fetchEvents(rec, start, end)
  throw new IntegrationError('Not a calendar integration')
}

/** Create or update a busy block on a calendar. Returns the remote id to keep for later edits. */
export async function upsertBlockProvider(
  rec: IntegrationRecord,
  calendarId: string,
  block: BlockWrite
): Promise<string> {
  if (rec.kind === 'google_calendar') return google.upsertBlock(rec, calendarId, block)
  if (rec.kind === 'caldav') return caldav.upsertBlock(rec, calendarId, block)
  throw new IntegrationError('Not a calendar integration')
}

/**
 * A calendar of our own on the same account, created on first use. Null where the provider cannot
 * create one (CalDAV servers differ too much), and the caller falls back to the work calendar.
 */
export async function ensureCalendarProvider(
  rec: IntegrationRecord,
  name: string,
  timeZone: string
): Promise<string | null> {
  if (rec.kind === 'google_calendar') return google.ensureCalendar(rec, name, timeZone)
  return null
}

export async function deleteBlockProvider(
  rec: IntegrationRecord,
  calendarId: string,
  remoteId: string
): Promise<void> {
  if (rec.kind === 'google_calendar') return google.deleteBlock(rec, calendarId, remoteId)
  if (rec.kind === 'caldav') return caldav.deleteBlock(rec, remoteId)
  throw new IntegrationError('Not a calendar integration')
}

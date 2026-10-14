import { v7 as uuidv7 } from 'uuid'
import type { CalendarConfig } from '../../shared/types'
import { addDays, dayBounds, localDay } from '../../shared/time'
import { getDb } from '../db'
import { getSettings } from '../db/settings'
import {
  DAYS_AHEAD,
  PERSONAL_COMMITMENT,
  calendarContexts,
  listPersonalCommitments
} from './calendarSync'
import { errorMessage } from './http'
import { deleteBlockProvider, ensureCalendarProvider, upsertBlockProvider } from './providers'
import { listRecords, patchConfig, setSyncStatus, type IntegrationRecord } from './registry'

export const FOCUS_TIME = 'Focus time'
export const FOCUS_CALENDAR = 'Open Day Plan: Focus time' // the calendar we provision for them
const ERROR_PREFIX = 'Calendar blocks: '
const DEBOUNCE_MS = 5000

type Kind = 'focus' | 'personal'
const TITLE: Record<Kind, string> = { focus: FOCUS_TIME, personal: PERSONAL_COMMITMENT }

export interface DesiredBlock {
  kind: Kind
  source_key: string // focus: the task id; personal: `${integration}|${calendar}|${event}|${day}`
  start_at: string
  end_at: string
}

/**
 * Every busy block the work calendar should carry, today through today+7. Titles are generic on
 * purpose: nothing about the task or the personal event leaves the app.
 */
export function desiredBlocks(now = new Date()): DesiredBlock[] {
  const tz = getSettings().timezone
  const today = localDay(now, tz)
  const windowStart = dayBounds(today, tz).start
  const windowEnd = dayBounds(addDays(today, DAYS_AHEAD + 1), tz).start

  const tasks = getDb()
    .prepare(
      `SELECT id, scheduled_at, duration_min FROM task
       WHERE context = 'work' AND completed_at IS NULL AND duration_min > 0
         AND scheduled_at >= ? AND scheduled_at < ?
       ORDER BY scheduled_at, id`
    )
    .all(windowStart, windowEnd) as { id: string; scheduled_at: string; duration_min: number }[]
  const out: DesiredBlock[] = tasks.map((t) => ({
    kind: 'focus',
    source_key: t.id,
    start_at: t.scheduled_at,
    end_at: new Date(Date.parse(t.scheduled_at) + t.duration_min * 60_000).toISOString()
  }))

  const contextOf = calendarContexts() // once: reading it decrypts every integration's secret
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    for (const c of listPersonalCommitments(addDays(today, i), contextOf)) {
      out.push({
        kind: 'personal',
        source_key: `${c.integration_id}|${c.calendar_id}|${c.external_id}|${c.day}`,
        start_at: c.start_at,
        end_at: c.end_at
      })
    }
  }
  return out
}

/**
 * Where Focus time goes: a calendar of our own, provisioned on the target's account the first time
 * a focus block is needed and remembered in its config. Providers that cannot create calendars use
 * the work calendar. Null when provisioning failed: focus blocks wait for the next pass rather
 * than landing on the work calendar by accident.
 */
async function focusCalendar(
  target: { rec: IntegrationRecord; calendarId: string },
  needed: boolean,
  fail: (integrationId: string, e: unknown) => void
): Promise<string | null> {
  const known = (target.rec.config as unknown as CalendarConfig).focus_calendar_id
  if (known) return known
  if (!needed) return target.calendarId
  try {
    const id = await ensureCalendarProvider(target.rec, FOCUS_CALENDAR, getSettings().timezone)
    if (!id) return target.calendarId
    patchConfig(target.rec.id, { focus_calendar_id: id })
    return id
  } catch (e) {
    fail(target.rec.id, e)
    return null
  }
}

/** The one work calendar flagged to receive blocks, or null when the feature is off. */
export function findTarget(): { rec: IntegrationRecord; calendarId: string } | null {
  for (const rec of listRecords()) {
    if (!rec.enabled || (rec.kind !== 'google_calendar' && rec.kind !== 'caldav')) continue
    const cal = ((rec.config as unknown as CalendarConfig).calendars ?? []).find(
      (c) => c.block_target && c.context === 'work'
    )
    if (cal) return { rec, calendarId: cal.id }
  }
  return null
}

interface BlockRow {
  id: string
  kind: Kind
  source_key: string
  integration_id: string
  calendar_id: string
  remote_id: string | null
  start_at: string
  end_at: string
}

// auth failures hit every block alike: stop after the first instead of repeating the request
const isFatal = (e: unknown): boolean => /Reconnect|Authentication failed/.test(errorMessage(e))

async function reconcileOnce(now: Date): Promise<void> {
  const db = getDb()
  const target = findTarget()
  const records = new Map(listRecords().map((r) => [r.id, r]))
  const rows = db.prepare('SELECT * FROM calendar_block').all() as BlockRow[]
  const nowIso = now.toISOString()
  const failures = new Map<string, string>() // integration id -> first error message
  const fail = (integrationId: string, e: unknown): void => {
    if (!failures.has(integrationId)) failures.set(integrationId, errorMessage(e))
  }
  const drop = (id: string): void => {
    db.prepare('DELETE FROM calendar_block WHERE id = ?').run(id)
  }
  // Remove a block from the calendar. One that has already ended stays there as history.
  const remove = async (row: BlockRow): Promise<boolean> => {
    const rec = records.get(row.integration_id)
    if (!rec || !row.remote_id || row.end_at <= nowIso) {
      drop(row.id)
      return true
    }
    try {
      await deleteBlockProvider(rec, row.calendar_id, row.remote_id)
      drop(row.id)
      return true
    } catch (e) {
      fail(rec.id, e)
      return !isFatal(e)
    }
  }

  const desired = target ? desiredBlocks(now) : []
  const focusCal = target
    ? await focusCalendar(
        target,
        desired.some((d) => d.kind === 'focus'),
        fail
      )
    : null
  // personal commitments live on the work calendar, focus time on its own calendar
  const calendarFor = (kind: Kind): string | null =>
    kind === 'focus' ? focusCal : (target?.calendarId ?? null)

  const mine = new Map<string, BlockRow>() // `${kind}|${source_key}` where it belongs now
  let stopped = false
  for (const row of rows) {
    if (row.kind === 'focus' && target && focusCal === null) continue // unknown: leave it be
    const onTarget =
      target && row.integration_id === target.rec.id && row.calendar_id === calendarFor(row.kind)
    if (onTarget) mine.set(`${row.kind}|${row.source_key}`, row)
    else if (!stopped && !(await remove(row))) stopped = true
  }

  if (target) {
    const wanted = new Set<string>()
    stopped = false
    for (const d of desired) {
      const key = `${d.kind}|${d.source_key}`
      wanted.add(key)
      const calendarId = calendarFor(d.kind)
      if (calendarId === null) continue // focus calendar not available this pass
      const row = mine.get(key)
      if (row?.remote_id && row.start_at === d.start_at && row.end_at === d.end_at) continue
      if (stopped) continue
      const id = row?.id ?? uuidv7()
      try {
        const remoteId = await upsertBlockProvider(target.rec, calendarId, {
          id,
          kind: d.kind,
          title: TITLE[d.kind],
          start_at: d.start_at,
          end_at: d.end_at,
          remote_id: row?.remote_id ?? null
        })
        db.prepare(
          `INSERT INTO calendar_block
             (id, kind, source_key, integration_id, calendar_id, remote_id, start_at, end_at, pushed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET remote_id = excluded.remote_id,
             start_at = excluded.start_at, end_at = excluded.end_at, pushed_at = excluded.pushed_at`
        ).run(
          id,
          d.kind,
          d.source_key,
          target.rec.id,
          calendarId,
          remoteId,
          d.start_at,
          d.end_at,
          nowIso
        )
      } catch (e) {
        fail(target.rec.id, e)
        if (isFatal(e)) stopped = true
      }
    }
    stopped = false
    for (const [key, row] of mine) {
      if (wanted.has(key)) continue
      if (!stopped && !(await remove(row))) stopped = true
    }
  }

  for (const rec of records.values()) {
    const message = failures.get(rec.id)
    if (message) setSyncStatus(rec.id, { error: ERROR_PREFIX + message })
    else if (rec.last_error?.startsWith(ERROR_PREFIX)) setSyncStatus(rec.id, { error: null })
  }
}

let running = false
let rerun = false

/**
 * Bring the work calendar in line with the app: create, move and delete blocks. Runs never
 * overlap; a request that arrives mid-run triggers one more pass when it finishes.
 */
export async function reconcileBlocks(now = new Date()): Promise<void> {
  if (running) {
    rerun = true
    return
  }
  running = true
  try {
    let at = now
    do {
      rerun = false
      await reconcileOnce(at)
      at = new Date()
    } while (rerun)
  } catch (e) {
    console.warn(`calendar blocks: ${errorMessage(e)}`)
  } finally {
    running = false
  }
}

let timer: ReturnType<typeof setTimeout> | null = null

/** Reconcile soon, collapsing a burst of edits (dragging a task around) into one pass. */
export function scheduleReconcile(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void reconcileBlocks()
  }, DEBOUNCE_MS)
}

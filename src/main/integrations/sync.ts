import { getSettings } from '../db/settings'
import { syncCalendar } from './calendarSync'
import { syncGithub } from './githubSync'
import { errorMessage } from './http'
import { getRecord, listRecords, setSyncStatus } from './registry'

const SYNC_KINDS = new Set(['github', 'google_calendar', 'caldav'])
const TICK_MS = 60_000

const inflight = new Set<string>()
const lastAttempt = new Map<string, number>() // throttles retries of failing integrations

/** Run one integration's sync now. Never overlaps itself; records success or the error. */
export async function runSync(id: string): Promise<void> {
  if (inflight.has(id)) return
  inflight.add(id)
  lastAttempt.set(id, Date.now())
  try {
    const rec = getRecord(id)
    if (rec.kind === 'github') await syncGithub(rec)
    else if (rec.kind === 'google_calendar' || rec.kind === 'caldav') await syncCalendar(rec)
    setSyncStatus(id, { synced: true, error: null })
  } catch (e) {
    setSyncStatus(id, { error: errorMessage(e) })
  } finally {
    inflight.delete(id)
  }
}

/** Syncs due integrations every minute. `onChanged` fires after each completed sync. */
export function startScheduler(onChanged: () => void): () => void {
  const tick = async (): Promise<void> => {
    const intervalMs = getSettings().sync_minutes * 60_000
    const now = Date.now()
    const due = listRecords().filter((r) => {
      if (!r.enabled || !SYNC_KINDS.has(r.kind) || inflight.has(r.id)) return false
      const last = Math.max(
        r.last_sync_at ? Date.parse(r.last_sync_at) : 0,
        lastAttempt.get(r.id) ?? 0
      )
      return now - last >= intervalMs
    })
    for (const r of due) {
      await runSync(r.id)
      onChanged()
    }
  }
  tick()
  const timer = setInterval(tick, TICK_MS)
  return () => clearInterval(timer)
}

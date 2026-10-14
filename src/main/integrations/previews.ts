import type { LinkPreview } from '../../shared/types'
import { matchIntegration, parseLinkRef } from '../../shared/links'
import { getDb } from '../db'
import { previewProvider } from './providers'
import { listRecords } from './registry'

const TTL_MS = 10 * 60_000

/** Rich preview for a link, or null when no enabled integration handles it (or the lookup fails). */
export async function getPreview(url: string, force = false): Promise<LinkPreview | null> {
  const ref = parseLinkRef(url)
  if (!ref) return null
  const records = listRecords()
  const id = matchIntegration(ref, records)
  const rec = records.find((r) => r.id === id)
  if (!rec) return null

  const db = getDb()
  if (!force) {
    const cached = db
      .prepare('SELECT data, fetched_at FROM link_preview WHERE url = ?')
      .get(url) as { data: string; fetched_at: string } | undefined
    if (cached && Date.now() - Date.parse(cached.fetched_at) < TTL_MS) {
      return JSON.parse(cached.data) as LinkPreview
    }
  }
  try {
    const p = await previewProvider(rec, ref)
    if (!p) return null
    const full: LinkPreview = { ...p, integration_name: rec.name }
    db.prepare(
      `INSERT INTO link_preview (url, integration_id, data, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET integration_id = excluded.integration_id,
         data = excluded.data, fetched_at = excluded.fetched_at`
    ).run(url, rec.id, JSON.stringify(full), new Date().toISOString())
    return full
  } catch {
    // fall back to a stale cache entry rather than showing nothing
    const stale = db.prepare('SELECT data FROM link_preview WHERE url = ?').get(url) as
      { data: string } | undefined
    return stale ? (JSON.parse(stale.data) as LinkPreview) : null
  }
}

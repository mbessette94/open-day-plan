import { v7 as uuidv7 } from 'uuid'
import type { ActivityType } from '../../shared/activity'
import type { ActivityEntry } from '../../shared/types'
import { getDb } from './index'

export function addActivity(
  type: ActivityType,
  text: string,
  refId: string | null = null,
  data: Record<string, unknown> | null = null
): void {
  getDb()
    .prepare(
      'INSERT INTO activity_log (id, created_at, type, action_taken, data, ref_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(uuidv7(), new Date().toISOString(), type, text, data ? JSON.stringify(data) : null, refId)
}

const SELECT = `SELECT a.id, a.created_at, a.type, a.action_taken, a.data, a.ref_id, t.title AS ref_title
  FROM activity_log a LEFT JOIN task t ON t.id = a.ref_id`

interface Row extends Omit<ActivityEntry, 'data'> {
  data: string | null
}
const toEntry = (r: Row): ActivityEntry => ({ ...r, data: r.data ? JSON.parse(r.data) : null })

export function listActivity(limit = 200): ActivityEntry[] {
  return (
    getDb().prepare(`${SELECT} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(limit) as Row[]
  ).map(toEntry)
}

/** Activity referencing any of the given task ids, newest first. */
export function listActivityFor(taskIds: string[]): ActivityEntry[] {
  if (taskIds.length === 0) return []
  const marks = taskIds.map(() => '?').join(',')
  return (
    getDb()
      .prepare(`${SELECT} WHERE a.ref_id IN (${marks}) ORDER BY a.created_at DESC, a.id DESC`)
      .all(...taskIds) as Row[]
  ).map(toEntry)
}

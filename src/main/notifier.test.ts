import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, Notification: class {} }))

import { getDb, openDb } from './db'
import { updateSettings } from './db/settings'
import { createTask, scheduleTask, setCompleted, updateTask } from './db/tasks'
import { nextUp, nextUpLabel, runNotifierTick } from './notifier'

const now = new Date('2026-10-14T09:56:00Z') // Wednesday, 09:56 UTC

beforeEach(() => {
  openDb(':memory:')
  updateSettings({ timezone: 'UTC' })
})

function addTask(title: string, scheduled: string | null): string {
  const t = createTask({ context: 'work', title, assigned_date: null })
  if (scheduled) scheduleTask(t.id, scheduled)
  return t.id
}

describe('runNotifierTick', () => {
  it('fires a scheduled task once, records it, and skips finished tasks', () => {
    addTask('Standup prep', '2026-10-14T10:00:00.000Z')
    const done = addTask('Already done', '2026-10-14T10:00:00.000Z')
    setCompleted(done, true)
    const shown: string[] = []
    runNotifierTick(now, (n) => shown.push(n.title))
    runNotifierTick(now, (n) => shown.push(n.title)) // second tick: already in notification_log
    expect(shown).toEqual(['Standup prep'])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM notification_log').get()).toEqual({ n: 1 })
  })

  it('fires calendar events with a key that survives a re-sync', () => {
    const db = getDb()
    db.prepare(
      "INSERT INTO integration (id, kind, name, config, enabled, created_at) VALUES ('i1', 'caldav', 'C', '{}', 1, '2026-10-01T00:00:00.000Z')"
    ).run()
    const insert = db.prepare(
      `INSERT INTO calendar_event (id, integration_id, calendar_id, external_id, title, start_at, end_at, synced_at)
       VALUES (?, 'i1', 'cal', 'ev1', 'Design review', '2026-10-14T10:00:00.000Z', '2026-10-14T11:00:00.000Z', '2026-10-14T00:00:00.000Z')`
    )
    insert.run('row-1')
    const shown: string[] = []
    runNotifierTick(now, (n) => shown.push(n.title))
    // a sync replaces rows with new ids; it must not notify again
    db.prepare('DELETE FROM calendar_event').run()
    insert.run('row-2')
    runNotifierTick(now, (n) => shown.push(n.title))
    expect(shown).toEqual(['Design review'])
  })

  it('sends the digest for due items', () => {
    const t = createTask({ context: 'work', title: 'File taxes', assigned_date: null })
    updateTask(t.id, { due_date: '2026-10-14' })
    const shown: string[] = []
    runNotifierTick(new Date('2026-10-14T08:45:00Z'), (n) => shown.push(`${n.title}: ${n.body}`))
    expect(shown).toEqual(['Today: 1 due today'])
  })
})

describe('nextUp', () => {
  it('picks the earliest upcoming task or meeting today and builds the menu-bar label', () => {
    expect(nextUp(now)).toBeNull()
    expect(nextUpLabel(now)).toBe('Plan')
    addTask('Write report', '2026-10-14T14:00:00.000Z')
    addTask('Sync with design team about the roadmap', '2026-10-14T11:30:00.000Z')
    expect(nextUp(now)?.title).toBe('Sync with design team about the roadmap')
    expect(nextUpLabel(now)).toBe('11:30 Sync with design team…')
    expect(nextUp(new Date('2026-10-14T15:00:00Z'))).toBeNull() // nothing left today
  })
})

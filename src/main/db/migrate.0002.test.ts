import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, migrationsUpTo } from './migrate'

describe('0002_calendar_block', () => {
  it('adds calendar_block without touching existing data', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db, { migrations: migrationsUpTo(1) })
    db.exec(`INSERT INTO integration (id, kind, name, config, enabled, created_at)
             VALUES ('i1', 'caldav', 'C', '{}', 1, '2026-10-13T00:00:00.000Z')`)
    migrate(db)
    expect(db.prepare('SELECT id, name FROM integration').all()).toEqual([{ id: 'i1', name: 'C' }])

    const ins = (id: string, kind = 'focus', start = '2026-10-13T15:00:00.000Z'): void => {
      db.prepare(
        `INSERT INTO calendar_block (id, kind, source_key, integration_id, calendar_id, start_at, end_at)
         VALUES (?, ?, 'k', 'i1', 'w', ?, '2026-10-13T16:00:00.000Z')`
      ).run(id, kind, start)
    }
    ins('b1')
    expect(() => ins('b2')).toThrow() // one block per source on a calendar
    expect(() => ins('b3', 'other')).toThrow() // kind is a stable enum
    expect(() => ins('b4', 'personal', '2026-10-13T17:00:00.000Z')).toThrow() // ends before it starts

    db.prepare("DELETE FROM integration WHERE id = 'i1'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM calendar_block').get()).toEqual({ n: 0 }) // cascades
  })
})

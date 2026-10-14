import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { APPLICATION_ID } from './constants'
import { closeDb, getDb, openDb } from './index'
import { detectLegacy, importLegacy, setAsideLegacy, setAsideLegacyIfNeeded } from './legacy'
import { DatabaseTooNewError } from './migrate'

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'legacy-v7.sql'), 'utf8')

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'odp-legacy-'))
  path = join(dir, 'open-day-plan.db')
})
afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

function makeLegacy(file = path): void {
  const d = new Database(file)
  d.pragma('journal_mode = WAL')
  d.exec(FIXTURE)
  d.close()
}

describe('detectLegacy', () => {
  it('recognises an old-layout database by user_version and the missing application_id', () => {
    makeLegacy()
    expect(detectLegacy(path)).toBe(7)
  })

  it('ignores missing, empty, foreign and current-layout files', () => {
    expect(detectLegacy(path)).toBeNull()
    writeFileSync(path, '')
    expect(detectLegacy(path)).toBeNull()
    writeFileSync(path, 'not sqlite at all')
    expect(detectLegacy(path)).toBeNull()
    rmSync(path)
    openDb(path)
    closeDb()
    expect(detectLegacy(path)).toBeNull()
    const other = join(dir, 'other.db')
    const d = new Database(other)
    d.exec('CREATE TABLE unrelated (x); PRAGMA user_version = 3;')
    d.close()
    expect(detectLegacy(other)).toBeNull() // no task table
  })
})

describe('setAsideLegacy', () => {
  it('renames the file (never deletes it), keeps its data, and leaves no stray WAL files', () => {
    makeLegacy()
    const dest = setAsideLegacy(path, 7, new Date(2026, 9, 14, 10, 30, 5))
    expect(dest).toBe(join(dir, 'open-day-plan.legacy-v7-20261014-103005.db'))
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir).filter((f) => f.endsWith('-wal') || f.endsWith('-shm'))).toEqual([])
    const d = new Database(dest, { readonly: true })
    expect(d.prepare('SELECT title FROM task').all()).toEqual([{ title: 'a legacy task' }])
    d.close()
  })

  it('setAsideLegacyIfNeeded leaves a current database alone', () => {
    openDb(path)
    closeDb()
    expect(setAsideLegacyIfNeeded(path)).toBeNull()
    expect(existsSync(path)).toBe(true)
  })
})

describe('importLegacy', () => {
  it('carries over settings and integrations (secrets byte for byte), nothing else', () => {
    makeLegacy()
    const aside = setAsideLegacy(path, 7)
    const db = openDb(path) // creates the fresh database
    // openDb already imported once (it found the set-aside file only if it did the rename itself),
    // so import explicitly into a clean database here
    db.exec('DELETE FROM integration; DELETE FROM user_settings; DELETE FROM app_state;')
    const summary = importLegacy(aside, db)
    expect(summary).toEqual({ settings: true, integrations: 2 })

    expect(db.prepare('SELECT * FROM user_settings').get()).toMatchObject({
      timezone: 'America/New_York',
      work_days: 'mo,tu,we,th',
      work_time_start: '08:30',
      work_time_end: '16:30',
      sync_minutes: 30,
      notify_lead_min: 10,
      shutdown_time: '16:45',
      quick_hotkey: 'Alt+Shift+Space',
      backup_dir: '/Users/me/backups',
      backup_keep: 7
    })
    expect(db.prepare("SELECT value FROM app_state WHERE key = 'last_backup_at'").get()).toEqual({
      value: '2026-10-13T20:00:00.000Z'
    })
    const gh = db.prepare("SELECT * FROM integration WHERE id = 'int-1'").get() as {
      secret: Buffer
      config: string
      last_sync_at: string
    }
    expect([...gh.secret]).toEqual([1, 2, 3, 4, 5, 255])
    expect(JSON.parse(gh.config)).toEqual({ pr_filter: 'review-requested:@me' })
    expect(gh.last_sync_at).toBe('2026-10-13T19:00:00.000Z')
    // an unreadable config and malformed timestamps are cleaned up rather than failing the import
    expect(
      db
        .prepare(
          "SELECT config, enabled, last_sync_at, last_error FROM integration WHERE id = 'int-2'"
        )
        .get()
    ).toEqual({
      config: '{}',
      enabled: 0,
      last_sync_at: null,
      last_error: 'boom'
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM task').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM calendar_event').get()).toEqual({ n: 0 })
  })

  it('is safe to run on a file with no settings or integrations tables', () => {
    const bare = join(dir, 'bare.db')
    const d = new Database(bare)
    d.exec('CREATE TABLE task (id TEXT); PRAGMA user_version = 2;')
    d.close()
    const db = openDb(path)
    expect(importLegacy(bare, db)).toEqual({ settings: false, integrations: 0 })
  })
})

describe('openDb with a legacy file in place', () => {
  it('sets it aside, starts fresh, and imports settings and integrations in one go', () => {
    makeLegacy()
    const db = openDb(path)
    const aside = readdirSync(dir).filter((f) => /^open-day-plan\.legacy-v7-.*\.db$/.test(f))
    expect(aside).toHaveLength(1)
    expect(db.pragma('application_id', { simple: true })).toBe(APPLICATION_ID)
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(1)
    expect(db.prepare('SELECT timezone FROM user_settings').get()).toEqual({
      timezone: 'America/New_York'
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM integration').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM task').get()).toEqual({ n: 0 })
    // the old file is untouched and still readable
    const old = new Database(join(dir, aside[0]), { readonly: true })
    expect(old.prepare('SELECT COUNT(*) AS n FROM task').get()).toEqual({ n: 1 })
    old.close()
    // reopening does nothing further
    closeDb()
    openDb(path)
    expect(readdirSync(dir).filter((f) => /^open-day-plan\.legacy-.*\.db$/.test(f))).toHaveLength(1)
  })

  it('refuses a database from a newer version without modifying it', () => {
    const d = new Database(path)
    d.pragma(`application_id = ${APPLICATION_ID}`)
    d.exec('CREATE TABLE task (id TEXT); PRAGMA user_version = 99;')
    d.close()
    const before = readFileSync(path)
    expect(() => openDb(path)).toThrow(DatabaseTooNewError)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('takes a safety copy only when an existing current-layout database needs migrating', () => {
    openDb(path)
    expect(existsSync(join(dir, 'migration-backups'))).toBe(false)
    expect(getDb().pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(1)
  })
})

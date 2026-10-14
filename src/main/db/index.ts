import Database from 'better-sqlite3'
import { app } from 'electron'
import { dirname, join } from 'path'
import { APPLICATION_ID } from './constants'
import { importLegacy, setAsideLegacyIfNeeded } from './legacy'
import { assertCompatible, migrate } from './migrate'

export { APPLICATION_ID }
export { SCHEMA_VERSION } from './migrate'

let db: Database.Database | null = null
let dbPath = ''

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised')
  return db
}

const LINK_PREVIEW_KEEP_MS = 30 * 24 * 3600_000

/**
 * Open (creating if needed) the database and bring it to the latest schema.
 * An old-layout file from before v1 is renamed aside and its settings and integrations imported.
 * Throws DatabaseTooNewError / MigrationChecksumError / UnrecognisedDatabaseError for files this
 * version must not touch; the caller shows the message and quits.
 */
export function openDb(
  path = join(app.getPath('userData'), 'open-day-plan.db')
): Database.Database {
  const onDisk = path !== ':memory:'
  const legacy = onDisk ? setAsideLegacyIfNeeded(path) : null
  const d = new Database(path)
  try {
    assertCompatible(d) // before any pragma that would write to the file
    d.pragma('journal_mode = WAL')
    d.pragma('synchronous = NORMAL')
    d.pragma('foreign_keys = ON')
    d.pragma('busy_timeout = 5000')
    migrate(d, { backupDir: onDisk ? join(dirname(path), 'migration-backups') : null })
  } catch (e) {
    d.close()
    throw e
  }
  dbPath = path
  db = d

  if (legacy) {
    try {
      const summary = importLegacy(legacy, d)
      console.info(`imported from ${legacy}:`, summary)
    } catch (e) {
      console.warn('legacy import failed; starting fresh', e)
    }
  }
  d.prepare('DELETE FROM link_preview WHERE fetched_at < ?').run(
    new Date(Date.now() - LINK_PREVIEW_KEEP_MS).toISOString()
  )
  return d
}

export function getDbPath(): string {
  return dbPath
}

/** Let SQLite refresh its query-planner statistics where it thinks that helps. Cheap. */
export function optimizeDb(): void {
  db?.pragma('optimize')
}

/** Close the open database (used before swapping the file during a restore, and on quit). */
export function closeDb(): void {
  if (!db) return
  try {
    db.pragma('optimize')
  } finally {
    db.close()
    db = null
  }
}

/// <reference types="vite/client" />
import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { APPLICATION_ID } from './constants'

export interface Migration {
  version: number
  name: string
  sql: string
  checksum: string
  foreignKeysOff: boolean // the SQLite table-rebuild recipe needs foreign keys off while it runs
}

export class DatabaseTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number
  ) {
    super(
      `This data was written by a newer version of Open Day Plan (schema v${found}; this version understands up to v${supported}). Update the app, or restore an older backup.`
    )
    this.name = 'DatabaseTooNewError'
  }
}

export class MigrationChecksumError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationChecksumError'
  }
}

export class UnrecognisedDatabaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnrecognisedDatabaseError'
  }
}

const FILE = /(?:^|\/)(\d{4})_([a-z0-9_]+)\.sql$/
const MAX_BACKUPS = 5

const sha256 = (text: string): string =>
  createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')

/** Turn `{ path: sql }` into ordered migrations. Versions must run 1, 2, 3 with no gaps. */
export function parseMigrations(files: Record<string, string>): Migration[] {
  const list = Object.entries(files).map(([path, sql]): Migration => {
    const m = FILE.exec(path)
    if (!m) throw new Error(`Migration file name must look like 0001_name.sql: ${path}`)
    return {
      version: Number(m[1]),
      name: m[2],
      sql,
      checksum: sha256(sql),
      foreignKeysOff: /^--\s*migrate:\s*foreign_keys=off\s*$/m.test(sql)
    }
  })
  list.sort((a, b) => a.version - b.version)
  list.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(
        `Migrations must be numbered 1..n without gaps (found ${m.version} at position ${i + 1})`
      )
  })
  return list
}

const files = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

export const MIGRATIONS: Migration[] = parseMigrations(files)
/** The shipped migrations up to and including `version`: build an old schema in a migration test. */
export function migrationsUpTo(version: number): Migration[] {
  return MIGRATIONS.filter((m) => m.version <= version)
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export interface MigrateOptions {
  migrations?: Migration[]
  backupDir?: string | null // where to put the pre-migration safety copy; null = don't
  now?: Date
}
export interface MigrateResult {
  from: number
  to: number
  backup: string | null
}

const stamp = (d: Date): string =>
  d.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')

/** Safety copy taken before a migration touches existing data (VACUUM INTO is synchronous). */
function backupBeforeMigration(
  db: Database.Database,
  dir: string,
  from: number,
  to: number,
  now: Date
): string {
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${stamp(now)}-pre-v${from}-to-v${to}.db`)
  rmSync(dest, { force: true })
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  const old = readdirSync(dir)
    .filter((n) => /^\d{8}-\d{6}-pre-v\d+-to-v\d+\.db$/.test(n))
    .sort()
    .reverse()
    .slice(MAX_BACKUPS)
  for (const n of old) rmSync(join(dir, n), { force: true })
  return dest
}

function applyMigration(db: Database.Database, m: Migration, now: Date): void {
  // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched around it
  if (m.foreignKeysOff) db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.exec(m.sql)
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
      ).run(m.version, m.name, m.checksum, now.toISOString())
      if (m.foreignKeysOff) {
        const bad = db.pragma('foreign_key_check') as unknown[]
        if (bad.length) throw new Error(`left ${bad.length} foreign key violation(s)`)
      }
      db.pragma(`user_version = ${m.version}`)
    })()
  } catch (e) {
    throw new Error(
      `Migration ${m.version} (${m.name}) failed: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    )
  } finally {
    if (m.foreignKeysOff) db.pragma('foreign_keys = ON')
  }
}

/**
 * Throw unless this database is one the running app may open: ours (or brand new), not from a
 * newer version, not an old layout. Reads only, so nothing is modified on refusal. Returns the
 * current schema version.
 */
export function assertCompatible(
  db: Database.Database,
  migrations: Migration[] = MIGRATIONS
): number {
  const latest = migrations[migrations.length - 1]?.version ?? 0
  const current = db.pragma('user_version', { simple: true }) as number
  const appId = db.pragma('application_id', { simple: true }) as number
  if (appId !== 0 && appId !== APPLICATION_ID) {
    throw new UnrecognisedDatabaseError(
      'This file is a SQLite database from a different application'
    )
  }
  if (appId === 0 && current > 0) {
    throw new UnrecognisedDatabaseError(
      'This database uses an old layout and must be set aside before opening'
    )
  }
  if (current > latest) throw new DatabaseTooNewError(current, latest)
  return current
}

/**
 * Bring a database up to the latest schema.
 *  - refuses a database from a newer app, a non-Open-Day-Plan file, or an old-layout file
 *  - refuses to run if a shipped migration was edited after it was applied
 *  - takes a safety copy before changing existing data
 *  - runs each migration in its own transaction and records it in schema_migrations
 */
export function migrate(db: Database.Database, opts: MigrateOptions = {}): MigrateResult {
  const migrations = opts.migrations ?? MIGRATIONS
  const latest = migrations[migrations.length - 1]?.version ?? 0
  const now = opts.now ?? new Date()

  const current = assertCompatible(db, migrations)

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  const applied = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as {
    version: number
    name: string
    checksum: string
  }[]
  for (const a of applied) {
    const shipped = migrations.find((m) => m.version === a.version)
    if (!shipped)
      throw new MigrationChecksumError(
        `Migration ${a.version} (${a.name}) was applied but is not part of this version`
      )
    if (shipped.checksum !== a.checksum) {
      throw new MigrationChecksumError(
        `Migration ${a.version} (${a.name}) was edited after it was applied. Shipped migrations must never change; add a new migration instead.`
      )
    }
  }

  const pending = migrations.filter((m) => m.version > current)
  if (pending.length === 0) return { from: current, to: current, backup: null }

  const backup =
    current > 0 && opts.backupDir
      ? backupBeforeMigration(db, opts.backupDir, current, latest, now)
      : null
  if (current === 0) db.pragma(`application_id = ${APPLICATION_ID}`)
  for (const m of pending) applyMigration(db, m, now)
  return { from: current, to: latest, backup }
}

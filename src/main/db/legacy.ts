import Database from 'better-sqlite3'
import { existsSync, renameSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'

/** The pre-release layout used PRAGMA user_version 1..7 and never set application_id. */
export const LEGACY_MAX_VERSION = 7

const INSTANT = /^\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d{3}Z$/

/** The legacy schema version if `path` is an old-layout Open Day Plan database, else null. */
export function detectLegacy(path: string): number | null {
  if (!existsSync(path) || statSync(path).size === 0) return null
  let db: Database.Database | null = null
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
    const appId = db.pragma('application_id', { simple: true }) as number
    const version = db.pragma('user_version', { simple: true }) as number
    const hasTask = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task'")
      .get()
    return appId === 0 && version >= 1 && version <= LEGACY_MAX_VERSION && hasTask ? version : null
  } catch {
    return null
  } finally {
    db?.close()
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Rename an old-layout database aside (never delete it). Returns its new path. */
export function setAsideLegacy(path: string, version: number, now = new Date()): string {
  // fold the write-ahead log into the main file so the renamed copy is self-contained
  const db = new Database(path)
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const dest = join(dirname(path), `open-day-plan.legacy-v${version}-${stamp}.db`)
  renameSync(path, dest)
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  return dest
}

/** If `path` holds an old-layout database, set it aside and return where it went; else null. */
export function setAsideLegacyIfNeeded(path: string, now = new Date()): string | null {
  const version = detectLegacy(path)
  return version === null ? null : setAsideLegacy(path, version, now)
}

export interface ImportSummary {
  settings: boolean
  integrations: number
}

// settings carried over; anything the old file lacks keeps the new column default
const SETTINGS_COLUMNS = [
  'timezone',
  'work_days',
  'work_time_start',
  'work_time_end',
  'personal_time_start',
  'personal_time_end',
  'sync_minutes',
  'notify_enabled',
  'notify_lead_min',
  'digest_time',
  'shutdown_time',
  'quick_hotkey',
  'launch_at_login',
  'backup_dir',
  'backup_keep'
]

/**
 * One-time import of settings and integrations from a set-aside legacy database. Tasks and
 * caches are not imported. Integration secrets are copied as the opaque encrypted blobs; they
 * are bound to this machine's keychain, so they stay valid here. Each part is independent: a
 * failure in one is logged and the rest still imports.
 */
export function importLegacy(legacyPath: string, target: Database.Database): ImportSummary {
  const old = new Database(legacyPath, { readonly: true, fileMustExist: true })
  const summary: ImportSummary = { settings: false, integrations: 0 }
  const tableExists = (name: string): boolean =>
    old.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  try {
    try {
      const row = tableExists('user_settings')
        ? (old.prepare('SELECT * FROM user_settings WHERE id = 1').get() as
            Record<string, unknown> | undefined)
        : undefined
      if (row) {
        const cols = SETTINGS_COLUMNS.filter((c) => row[c] !== undefined && row[c] !== null)
        target.transaction(() => {
          target
            .prepare(
              `INSERT INTO user_settings (id, ${cols.join(', ')}) VALUES (1, ${cols.map(() => '?').join(', ')})`
            )
            .run(...cols.map((c) => row[c]))
          const last = row.last_backup_at
          if (typeof last === 'string' && INSTANT.test(last)) {
            target
              .prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('last_backup_at', ?)")
              .run(last)
          }
        })()
        summary.settings = true
      }
    } catch (e) {
      console.warn('legacy import: settings skipped', e)
    }

    try {
      if (tableExists('integration')) {
        const rows = old
          .prepare(
            'SELECT id, kind, name, config, secret, enabled, last_sync_at, last_error, created_at FROM integration'
          )
          .all() as Record<string, unknown>[]
        const insert = target.prepare(
          `INSERT OR IGNORE INTO integration (id, kind, name, config, secret, enabled, last_sync_at, last_error, created_at)
           VALUES (@id, @kind, @name, @config, @secret, @enabled, @last_sync_at, @last_error, @created_at)`
        )
        for (const r of rows) {
          try {
            const valid = (v: unknown): string | null =>
              typeof v === 'string' && INSTANT.test(v) ? v : null
            let config = '{}'
            try {
              JSON.parse(String(r.config))
              config = String(r.config)
            } catch {
              // unreadable config: import the integration with an empty one
            }
            const result = insert.run({
              id: r.id,
              kind: r.kind,
              name: r.name,
              config,
              secret: r.secret ?? null,
              enabled: r.enabled === 0 ? 0 : 1,
              last_sync_at: valid(r.last_sync_at),
              last_error: r.last_error ?? null,
              created_at: valid(r.created_at) ?? new Date().toISOString()
            })
            summary.integrations += result.changes
          } catch (e) {
            console.warn(`legacy import: integration ${String(r.name)} skipped`, e)
          }
        }
      }
    } catch (e) {
      console.warn('legacy import: integrations skipped', e)
    }
  } finally {
    old.close()
  }
  return summary
}

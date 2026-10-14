import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { parseLink } from '../shared/links'
import { hhmm, localDay, localMinutes } from '../shared/time'
import type { BackupInfo, Task, UserSettings } from '../shared/types'
import { APPLICATION_ID, SCHEMA_VERSION, closeDb, getDb, getDbPath } from './db'
import { getLastBackup, getSettings, setLastBackup } from './db/settings'

const BACKUP_NAME = /^open-day-plan-\d{8}-\d{6}\.db$/
const DAY_MS = 24 * 3600_000
const CHECK_MS = 3600_000

let lastError: string | null = null

const pad = (n: number): string => String(n).padStart(2, '0')

export function backupFileName(now: Date): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `open-day-plan-${d}-${t}.db`
}

/** Delete all but the newest `keep` backups in `dir`. Returns the names removed. */
export function pruneBackups(dir: string, keep: number): string[] {
  const names = readdirSync(dir)
    .filter((n) => BACKUP_NAME.test(n))
    .sort()
    .reverse()
  const stale = names.slice(Math.max(1, keep))
  for (const n of stale) rmSync(join(dir, n), { force: true })
  return stale
}

/** Consistent copy of the live database (SQLite online backup), then prune old copies. */
export async function backupNow(dir: string, keep: number, now = new Date()): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, backupFileName(now))
  await getDb().backup(dest)
  pruneBackups(dir, keep)
  setLastBackup(now.toISOString())
  lastError = null
  return dest
}

export function isBackupDue(s: UserSettings, lastBackupAt: string | null, now: Date): boolean {
  if (!s.backup_dir) return false
  return !lastBackupAt || now.getTime() - Date.parse(lastBackupAt) >= DAY_MS
}

/** Back up once a day, once a folder has been chosen. Checks at start and hourly. */
export function startBackupScheduler(): () => void {
  const check = (): void => {
    const s = getSettings()
    if (!isBackupDue(s, getLastBackup(), new Date())) return
    backupNow(s.backup_dir!, s.backup_keep).catch((e) => {
      lastError = e instanceof Error ? e.message : String(e)
      console.error('automatic backup failed', e)
    })
  }
  check()
  const timer = setInterval(check, CHECK_MS)
  return () => clearInterval(timer)
}

export function backupInfo(): BackupInfo {
  const s = getSettings()
  let files: BackupInfo['files'] = []
  if (s.backup_dir && existsSync(s.backup_dir)) {
    files = readdirSync(s.backup_dir)
      .filter((n) => BACKUP_NAME.test(n))
      .sort()
      .reverse()
      .slice(0, 10)
      .map((name) => {
        const st = statSync(join(s.backup_dir!, name))
        return { name, size: st.size, modified: st.mtime.toISOString() }
      })
  }
  return {
    dir: s.backup_dir,
    keep: s.backup_keep,
    lastBackupAt: getLastBackup(),
    lastError,
    files
  }
}

export function recordBackupError(message: string): void {
  lastError = message
}

/** Is this file a usable Open Day Plan database this version can open? */
export function validateBackup(
  file: string
): { ok: true; version: number } | { ok: false; error: string } {
  let db: Database.Database | null = null
  try {
    db = new Database(file, { readonly: true, fileMustExist: true })
    const appId = db.pragma('application_id', { simple: true }) as number
    if (appId !== APPLICATION_ID) {
      const hasTask = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task'")
        .get()
      return {
        ok: false,
        error: hasTask
          ? 'This backup uses the pre-release layout and cannot be restored'
          : 'This is not an Open Day Plan backup'
      }
    }
    const version = db.pragma('user_version', { simple: true }) as number
    if (version > SCHEMA_VERSION) {
      return { ok: false, error: 'This backup was made by a newer version of the app' }
    }
    if (
      db.pragma('quick_check', { simple: true }) !== 'ok' ||
      (db.pragma('foreign_key_check') as unknown[]).length > 0
    ) {
      return { ok: false, error: 'This backup file is damaged' }
    }
    return { ok: true, version }
  } catch {
    return { ok: false, error: 'This is not a readable SQLite database' }
  } finally {
    db?.close()
  }
}

/** Replace the database file with a backup. The caller must have closed the database. */
export function swapDatabase(dbPath: string, backupFile: string): void {
  copyFileSync(backupFile, dbPath)
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
}

/**
 * Validate, keep a safety copy of the current data, then swap in the backup. The app must be
 * relaunched afterwards. Returns the safety copy's path.
 */
export async function restoreBackup(
  file: string,
  safetyDir: string,
  now = new Date()
): Promise<string> {
  const v = validateBackup(file)
  if (!v.ok) throw new Error(v.error)
  mkdirSync(safetyDir, { recursive: true })
  const safety = join(safetyDir, `pre-restore-${backupFileName(now).replace('open-day-plan-', '')}`)
  await getDb().backup(safety)
  const path = getDbPath()
  closeDb()
  swapDatabase(path, file)
  return safety
}

// ---- exports ----

interface Row {
  [key: string]: unknown
}

/** Everything worth keeping as portable JSON. Integration credentials are never included. */
export function exportData(now = new Date()): Record<string, unknown> {
  const db = getDb()
  const all = (sql: string): Row[] => db.prepare(sql).all() as Row[]
  const settings = getSettings()
  return {
    app: 'open-day-plan',
    exported_at: now.toISOString(),
    schema_version: SCHEMA_VERSION,
    settings,
    tasks: all('SELECT * FROM task ORDER BY created_at, id'),
    task_links: all('SELECT * FROM task_link ORDER BY created_at, id'),
    activity_log: all(
      'SELECT id, created_at, type, action_taken, data, ref_id FROM activity_log ORDER BY created_at, id'
    ),
    day_records: all('SELECT * FROM day_record ORDER BY day'),
    integrations: all(
      'SELECT id, kind, name, config, enabled, created_at FROM integration ORDER BY created_at, id'
    )
  }
}

const QUADRANTS: [number, string][] = [
  [3, 'Do immediately'],
  [2, 'Decide when to do'],
  [1, 'Delegate'],
  [0, 'Do later']
]

type MdTask = Task

/** Readable Markdown: open tasks by quadrant, the backlog, and the last 30 days of completions. */
export function exportMarkdown(now = new Date()): string {
  const db = getDb()
  const tz = getSettings().timezone
  const day = localDay(now, tz)
  const rows = (sql: string, ...args: unknown[]): MdTask[] =>
    db.prepare(sql).all(...args) as MdTask[]
  const kids = db.prepare('SELECT * FROM task WHERE parent = ? ORDER BY created_at, id')
  const links = db.prepare('SELECT url FROM task_link WHERE task_id = ? ORDER BY created_at, id')

  const line = (t: MdTask, indent: string): string[] => {
    const meta: string[] = []
    if (t.context === 'personal') meta.push('personal')
    if (t.due_date) meta.push(`due ${t.due_date}`)
    if (t.scheduled_at) {
      meta.push(
        `${localDay(new Date(t.scheduled_at), tz)} ${hhmm(localMinutes(new Date(t.scheduled_at), tz))}`
      )
    }
    const out = [
      `${indent}- [${t.completed_at ? 'x' : ' '}] ${t.title}${meta.length ? ` _(${meta.join(', ')})_` : ''}`
    ]
    for (const l of links.all(t.id) as { url: string }[])
      out.push(`${indent}  - [${parseLink(l.url).label}](${l.url})`)
    if (t.description) out.push(...t.description.split('\n').map((x) => `${indent}  > ${x}`))
    for (const c of kids.all(t.id) as MdTask[]) out.push(...line(c, `${indent}  `))
    return out
  }

  const out: string[] = [`# Open Day Plan (${day})`, '']
  const open = rows(
    'SELECT * FROM task WHERE parent IS NULL AND completed_at IS NULL ORDER BY created_at, id'
  )
  for (const [p, label] of QUADRANTS) {
    const group = open.filter((t) => t.priority === p)
    if (!group.length) continue
    out.push(`## ${label}`, '', ...group.flatMap((t) => line(t, '')), '')
  }
  const backlog = open.filter((t) => t.priority === null)
  if (backlog.length) out.push('## Backlog', '', ...backlog.flatMap((t) => line(t, '')), '')
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString()
  const done = rows(
    'SELECT * FROM task WHERE parent IS NULL AND completed_at >= ? ORDER BY completed_at DESC',
    since
  )
  if (done.length) {
    out.push('## Completed (last 30 days)', '')
    for (const t of done) out.push(...line(t, ''))
    out.push('')
  }
  if (out.length === 2) out.push('_No tasks._', '')
  return out.join('\n').trimEnd() + '\n'
}

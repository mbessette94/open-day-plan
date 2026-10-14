import type { UserSettings, Weekday } from '../../shared/types'
import { getState, setState } from './appState'
import { getDb } from './index'

type Row = Omit<UserSettings, 'work_days' | 'notify_enabled' | 'launch_at_login'> & {
  work_days: string
  notify_enabled: number
  launch_at_login: number
}

export const DEFAULTS: UserSettings = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  work_days: ['mo', 'tu', 'we', 'th', 'fr'],
  work_time_start: '09:00',
  work_time_end: '17:00',
  personal_time_start: '07:00',
  personal_time_end: '22:00',
  sync_minutes: 15,
  notify_enabled: true,
  notify_lead_min: 5,
  digest_time: '08:30',
  shutdown_time: '17:00',
  quick_hotkey: 'Control+Alt+Space',
  launch_at_login: false,
  backup_dir: null,
  backup_keep: 14
}

function fromRow(r: Row): UserSettings {
  return {
    timezone: r.timezone,
    work_days: r.work_days ? (r.work_days.split(',') as Weekday[]) : [],
    work_time_start: r.work_time_start,
    work_time_end: r.work_time_end,
    personal_time_start: r.personal_time_start,
    personal_time_end: r.personal_time_end,
    sync_minutes: r.sync_minutes,
    notify_enabled: r.notify_enabled !== 0,
    notify_lead_min: r.notify_lead_min,
    digest_time: r.digest_time,
    shutdown_time: r.shutdown_time,
    quick_hotkey: r.quick_hotkey,
    launch_at_login: r.launch_at_login !== 0,
    backup_dir: r.backup_dir,
    backup_keep: r.backup_keep
  }
}

export function getSettings(): UserSettings {
  const db = getDb()
  const row = db.prepare('SELECT * FROM user_settings WHERE id = 1').get() as Row | undefined
  if (row) return fromRow(row)
  db.prepare(
    `INSERT INTO user_settings (id, timezone, work_days, work_time_start, work_time_end,
       personal_time_start, personal_time_end, sync_minutes)
     VALUES (1, @timezone, @work_days, @work_time_start, @work_time_end,
       @personal_time_start, @personal_time_end, @sync_minutes)`
  ).run({ ...DEFAULTS, work_days: DEFAULTS.work_days.join(',') })
  return { ...DEFAULTS }
}

/** Merges a (possibly partial) patch over the stored settings. */
export function updateSettings(patch: Partial<UserSettings>): UserSettings {
  const next = { ...getSettings(), ...patch }
  getDb()
    .prepare(
      `UPDATE user_settings SET timezone=@timezone, work_days=@work_days,
         work_time_start=@work_time_start, work_time_end=@work_time_end,
         personal_time_start=@personal_time_start, personal_time_end=@personal_time_end,
         sync_minutes=@sync_minutes, notify_enabled=@notify_enabled,
         notify_lead_min=@notify_lead_min, digest_time=@digest_time,
         shutdown_time=@shutdown_time, quick_hotkey=@quick_hotkey,
         launch_at_login=@launch_at_login, backup_dir=@backup_dir, backup_keep=@backup_keep
       WHERE id = 1`
    )
    .run({
      timezone: next.timezone,
      work_days: next.work_days.join(','),
      work_time_start: next.work_time_start,
      work_time_end: next.work_time_end,
      personal_time_start: next.personal_time_start,
      personal_time_end: next.personal_time_end,
      sync_minutes: next.sync_minutes,
      notify_enabled: next.notify_enabled ? 1 : 0,
      notify_lead_min: next.notify_lead_min,
      digest_time: next.digest_time,
      shutdown_time: next.shutdown_time,
      quick_hotkey: next.quick_hotkey,
      launch_at_login: next.launch_at_login ? 1 : 0,
      backup_dir: next.backup_dir,
      backup_keep: next.backup_keep
    })
  return next
}

const LAST_BACKUP = 'last_backup_at'
export function getLastBackup(): string | null {
  return getState(LAST_BACKUP)
}
export function setLastBackup(at: string): void {
  setState(LAST_BACKUP, at)
}

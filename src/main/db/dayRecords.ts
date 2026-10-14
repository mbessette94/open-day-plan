import { localDay } from '../../shared/time'
import { getDb } from './index'
import { getSettings } from './settings'

/** Snapshot today's settings into day_record (history). Idempotent per day. */
export function recordToday(now = new Date()): void {
  const s = getSettings()
  getDb()
    .prepare(
      `INSERT INTO day_record (day, timezone, work_days, work_time_start, work_time_end,
         personal_time_start, personal_time_end)
       VALUES (@day, @timezone, @work_days, @work_time_start, @work_time_end,
         @personal_time_start, @personal_time_end)
       ON CONFLICT(day) DO UPDATE SET timezone=excluded.timezone, work_days=excluded.work_days,
         work_time_start=excluded.work_time_start, work_time_end=excluded.work_time_end,
         personal_time_start=excluded.personal_time_start,
         personal_time_end=excluded.personal_time_end`
    )
    .run({ ...s, work_days: s.work_days.join(','), day: localDay(now, s.timezone) })
}

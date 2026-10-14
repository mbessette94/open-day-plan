import Database from 'better-sqlite3'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './migrate'
import { schemaDump } from './schemaDump'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
})

const NOW = '2026-10-14T10:00:00.000Z'
let n = 0
function task(over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    id: `t${++n}`,
    parent: null,
    context: 'work',
    title: 'a task',
    created_at: NOW,
    updated_at: NOW,
    ...over
  }
  const cols = Object.keys(row)
  db.prepare(
    `INSERT INTO task (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`
  ).run(row)
  return row.id as string
}
const update = (id: string, set: Record<string, unknown>): void => {
  const cols = Object.keys(set)
  db.prepare(`UPDATE task SET ${cols.map((c) => `${c} = @${c}`).join(',')} WHERE id = @id`).run({
    ...set,
    id
  })
}
const get = (id: string): Record<string, unknown> =>
  db.prepare('SELECT * FROM task WHERE id = ?').get(id) as Record<string, unknown>
const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('schema snapshot', () => {
  it('matches schema.snapshot.sql (regenerate deliberately with: npm run db:snapshot)', () => {
    const file = join(__dirname, 'schema.snapshot.sql')
    const actual = schemaDump(db)
    if (process.env.UPDATE_SCHEMA_SNAPSHOT === '1') writeFileSync(file, actual)
    expect(existsSync(file)).toBe(true)
    expect(actual).toBe(readFileSync(file, 'utf8'))
  })

  it('passes the SQLite integrity and foreign key checks on a fresh database', () => {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})

describe('task constraints', () => {
  it('rejects blank titles, bad priorities and bad contexts', () => {
    expect(() => task({ title: '   ' })).toThrow(/CHECK/)
    expect(() => task({ priority: 4 })).toThrow(/CHECK/)
    expect(() => task({ context: 'home' })).toThrow(/CHECK/)
    expect(() => task({ is_project: 2 })).toThrow(/CHECK/)
  })

  it('only accepts UTC instants with milliseconds and a Z, and plain YYYY-MM-DD dates', () => {
    for (const bad of [
      '2026-10-14T10:00:00-07:00',
      '2026-10-14T10:00:00Z',
      '2026-10-14 10:00:00.000Z',
      'tomorrow'
    ]) {
      expect(() => task({ scheduled_at: bad })).toThrow(/CHECK/)
      expect(() => task({ completed_at: bad })).toThrow(/CHECK/)
    }
    expect(() => task({ created_at: '2026-10-14T10:00:00-07:00' })).toThrow(/CHECK/)
    for (const bad of ['2026-10-14T10:00:00.000Z', '10/14/2026', '2026-10-1']) {
      expect(() => task({ assigned_date: bad })).toThrow(/CHECK/)
      expect(() => task({ due_date: bad })).toThrow(/CHECK/)
    }
    task({
      scheduled_at: NOW,
      completed_at: NOW,
      assigned_date: '2026-10-14',
      due_date: '2026-10-20'
    })
    task({ scheduled_at: null, assigned_date: null, due_date: null, completed_at: null })
  })

  it('durations are positive multiples of 15 up to a day', () => {
    for (const bad of [0, 10, 20, 1455, -15])
      expect(() => task({ duration_min: bad })).toThrow(/CHECK/)
    task({ duration_min: 15 })
    task({ duration_min: 1440 })
  })

  it('recurrence must be valid JSON', () => {
    expect(() => task({ recurrence: 'every day' })).toThrow(/CHECK/)
    task({ recurrence: '{"freq":"daily","interval":1}' })
  })

  it('touches updated_at when a write forgets to, and respects an explicit one', () => {
    const id = task({ updated_at: '2020-01-01T00:00:00.000Z' })
    update(id, { title: 'renamed' })
    expect(get(id).updated_at).not.toBe('2020-01-01T00:00:00.000Z')
    expect(get(id).updated_at as string).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    update(id, { title: 'again', updated_at: '2021-02-03T04:05:06.789Z' })
    expect(get(id).updated_at).toBe('2021-02-03T04:05:06.789Z')
  })
})

describe('subtasks', () => {
  it('are leaves: never projects, never recurring, one level deep', () => {
    const p = task()
    expect(() => task({ parent: p, is_project: 1 })).toThrow(/CHECK/)
    expect(() => task({ parent: p, recurrence: '{"freq":"daily","interval":1}' })).toThrow(/CHECK/)
    const c = task({ parent: p })
    expect(() => task({ parent: c })).toThrow(/top-level/)
  })

  it("must share their parent's context", () => {
    const p = task({ context: 'work' })
    expect(() => task({ parent: p, context: 'personal' })).toThrow(/context must match/)
    const c = task({ parent: p, context: 'work' })
    expect(() => update(c, { context: 'personal' })).toThrow(/context must match/)
  })

  it('follow their parent when its context changes', () => {
    const p = task({ context: 'work' })
    const c = task({ parent: p, context: 'work' })
    update(p, { context: 'personal' })
    expect(get(c).context).toBe('personal')
  })

  it('cannot adopt a task that already has subtasks, or move under a non-top-level task', () => {
    const a = task()
    task({ parent: a })
    const b = task()
    expect(() => update(a, { parent: b })).toThrow(/has subtasks/)
    const c = task({ parent: b })
    const d = task()
    expect(() => update(d, { parent: c })).toThrow(/top-level/)
  })

  it('are deleted with their parent', () => {
    const p = task()
    task({ parent: p })
    task({ parent: p })
    db.prepare('DELETE FROM task WHERE id = ?').run(p)
    expect(count('task')).toBe(0)
  })
})

describe('links, activity and external items', () => {
  it('task_link: no duplicate URLs per task, removed with the task', () => {
    const t = task()
    const link = (id: string, url: string): unknown =>
      db
        .prepare('INSERT INTO task_link (id, task_id, url, created_at) VALUES (?, ?, ?, ?)')
        .run(id, t, url, NOW)
    link('l1', 'https://a.example')
    link('l2', 'https://b.example')
    expect(() => link('l3', 'https://a.example')).toThrow(/UNIQUE/)
    db.prepare('DELETE FROM task WHERE id = ?').run(t)
    expect(count('task_link')).toBe(0)
  })

  it('activity_log: valid JSON data, a type, and history that outlives the task', () => {
    const t = task()
    const log = (id: string, type: string, data: string | null): unknown =>
      db
        .prepare(
          'INSERT INTO activity_log (id, created_at, type, action_taken, data, ref_id) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(id, NOW, type, 'did a thing', data, t)
    expect(() => log('a1', '', null)).toThrow(/CHECK/)
    expect(() => log('a2', 'task.moved', '{not json')).toThrow(/CHECK/)
    log('a3', 'task.moved', '{"to":3}')
    db.prepare('DELETE FROM task WHERE id = ?').run(t)
    expect(db.prepare('SELECT ref_id FROM activity_log WHERE id = ?').get('a3')).toEqual({
      ref_id: null
    })
  })

  it('external_item: one tracking row per task, removed with the task; marker rows have no task', () => {
    db.prepare(
      "INSERT INTO integration (id, kind, name, created_at) VALUES ('i', 'jira', 'J', ?)"
    ).run(NOW)
    const ins = (ext: string, taskId: string | null): unknown =>
      db
        .prepare(
          "INSERT INTO external_item (integration_id, external_id, task_id, state, created_at) VALUES ('i', ?, ?, 'open', ?)"
        )
        .run(ext, taskId, NOW)
    const t = task()
    ins('A-1', t)
    expect(() => ins('A-2', t)).toThrow(/UNIQUE/)
    ins('M-1', null)
    ins('M-2', null) // several "seen" markers are fine
    db.prepare('DELETE FROM task WHERE id = ?').run(t)
    expect(db.prepare('SELECT external_id FROM external_item ORDER BY external_id').all()).toEqual([
      { external_id: 'M-1' },
      { external_id: 'M-2' }
    ])
  })

  it('integration: config must be JSON, and any kind string is allowed (no frozen enum)', () => {
    const ins = (id: string, kind: string, config: string): unknown =>
      db
        .prepare(
          'INSERT INTO integration (id, kind, name, config, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(id, kind, 'n', config, NOW)
    expect(() => ins('x', 'slack', 'nope')).toThrow(/CHECK/)
    ins('y', 'slack', '{}')
    expect(() => ins('z', '', '{}')).toThrow(/CHECK/)
  })
})

describe('calendar_event', () => {
  beforeEach(() => {
    db.prepare(
      "INSERT INTO integration (id, kind, name, created_at) VALUES ('i', 'caldav', 'C', ?)"
    ).run(NOW)
  })
  const ev = (over: Record<string, unknown>): unknown => {
    const row = {
      id: `e${++n}`,
      integration_id: 'i',
      calendar_id: 'c',
      external_id: 'x',
      title: 'Event',
      synced_at: NOW,
      start_at: null,
      end_at: null,
      start_date: null,
      end_date: null,
      ...over
    }
    const cols = Object.keys(row)
    return db
      .prepare(
        `INSERT INTO calendar_event (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`
      )
      .run(row)
  }

  it('is either timed or all-day, never both or neither', () => {
    ev({ start_at: NOW, end_at: '2026-10-14T11:00:00.000Z' })
    ev({ external_id: 'y', start_date: '2026-10-14', end_date: '2026-10-15' })
    expect(() => ev({ external_id: 'z' })).toThrow(/CHECK/)
    expect(() =>
      ev({
        external_id: 'z',
        start_at: NOW,
        end_at: NOW,
        start_date: '2026-10-14',
        end_date: '2026-10-15'
      })
    ).toThrow(/CHECK/)
    expect(() => ev({ external_id: 'z', start_at: NOW })).toThrow(/CHECK/)
    expect(() =>
      ev({ external_id: 'z', start_date: '2026-10-14T00:00:00.000Z', end_date: '2026-10-15' })
    ).toThrow(/CHECK/)
  })

  it('does not store the same event twice, timed or all-day', () => {
    ev({ start_at: NOW, end_at: '2026-10-14T11:00:00.000Z' })
    expect(() => ev({ start_at: NOW, end_at: '2026-10-14T12:00:00.000Z' })).toThrow(/UNIQUE/)
    ev({ external_id: 'd', start_date: '2026-10-14', end_date: '2026-10-15' })
    expect(() =>
      ev({ external_id: 'd', start_date: '2026-10-14', end_date: '2026-10-16' })
    ).toThrow(/UNIQUE/)
    ev({ external_id: 'd', start_date: '2026-10-21', end_date: '2026-10-22' }) // a later occurrence is fine
  })
})

describe('settings and small tables', () => {
  const settings = (over: Record<string, unknown> = {}): unknown => {
    const row = {
      id: 1,
      timezone: 'UTC',
      work_days: 'mo',
      work_time_start: '09:00',
      work_time_end: '17:00',
      personal_time_start: '07:00',
      personal_time_end: '22:00',
      ...over
    }
    const cols = Object.keys(row)
    return db
      .prepare(
        `INSERT INTO user_settings (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`
      )
      .run(row)
  }

  it('user_settings is a validated singleton', () => {
    expect(() => settings({ id: 2 })).toThrow(/CHECK/)
    for (const bad of ['24:00', '9:00', '09:60', 'noon'])
      expect(() => settings({ work_time_start: bad })).toThrow(/CHECK/)
    expect(() => settings({ sync_minutes: 0 })).toThrow(/CHECK/)
    expect(() => settings({ notify_enabled: 2 })).toThrow(/CHECK/)
    expect(() => settings({ backup_keep: 0 })).toThrow(/CHECK/)
    expect(() => settings({ timezone: '' })).toThrow(/CHECK/)
    settings()
    expect(
      db
        .prepare('SELECT notify_lead_min, digest_time, quick_hotkey, backup_dir FROM user_settings')
        .get()
    ).toEqual({
      notify_lead_min: 5,
      digest_time: '08:30',
      quick_hotkey: 'Control+Alt+Space',
      backup_dir: null
    })
  })

  it('day_record and notification_log validate their date and instant columns', () => {
    const rec = (day: string): unknown =>
      db
        .prepare(
          "INSERT INTO day_record (day, timezone, work_days, work_time_start, work_time_end, personal_time_start, personal_time_end) VALUES (?, 'UTC', 'mo', '09:00', '17:00', '07:00', '22:00')"
        )
        .run(day)
    expect(() => rec('2026-10-14T00:00:00.000Z')).toThrow(/CHECK/)
    rec('2026-10-14')
    expect(() =>
      db.prepare('INSERT INTO notification_log (key, fired_at) VALUES (?, ?)').run('k', 'yesterday')
    ).toThrow(/CHECK/)
    db.prepare('INSERT INTO notification_log (key, fired_at) VALUES (?, ?)').run('k', NOW)
  })
})

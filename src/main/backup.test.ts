import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { electronMock } from './integrations/testUtils'

vi.mock('electron', () => electronMock)

import {
  backupFileName,
  backupNow,
  exportData,
  exportMarkdown,
  isBackupDue,
  pruneBackups,
  restoreBackup,
  validateBackup
} from './backup'
import { APPLICATION_ID, closeDb, getDb, openDb } from './db'
import { getLastBackup, getSettings, updateSettings } from './db/settings'
import { addLink, createTask, setCompleted, setPriority, updateTask } from './db/tasks'
import { saveIntegration } from './integrations/registry'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'odp-backup-'))
  openDb(join(dir, 'live.db'))
  updateSettings({ timezone: 'UTC' })
})
afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const titles = (file: string): string[] => {
  const d = new Database(file, { readonly: true })
  try {
    return (
      d.prepare('SELECT title FROM task ORDER BY created_at, id').all() as { title: string }[]
    ).map((r) => r.title)
  } finally {
    d.close()
  }
}

describe('backups', () => {
  it('names files by local time and keeps only the newest N', () => {
    expect(backupFileName(new Date(2026, 9, 14, 8, 5, 9))).toBe('open-day-plan-20261014-080509.db')
    const out = join(dir, 'out')
    mkdirSync(out)
    for (const n of ['20261010', '20261011', '20261012', '20261013']) {
      writeFileSync(join(out, `open-day-plan-${n}-120000.db`), 'x')
    }
    writeFileSync(join(out, 'notes.txt'), 'keep me')
    expect(pruneBackups(out, 2).sort()).toEqual([
      'open-day-plan-20261010-120000.db',
      'open-day-plan-20261011-120000.db'
    ])
    expect(readdirSync(out).sort()).toEqual([
      'notes.txt',
      'open-day-plan-20261012-120000.db',
      'open-day-plan-20261013-120000.db'
    ])
  })

  it('writes a consistent, valid copy of the live database and records when', async () => {
    createTask({ context: 'work', title: 'before backup', assigned_date: null })
    const out = join(dir, 'backups')
    const file = await backupNow(out, 5, new Date('2026-10-14T10:00:00Z'))
    expect(existsSync(file)).toBe(true)
    expect(validateBackup(file)).toMatchObject({ ok: true })
    expect(titles(file)).toEqual(['before backup'])
    expect(getLastBackup()).toBe('2026-10-14T10:00:00.000Z')
  })

  it('is due daily, and only once a folder is chosen', () => {
    const now = new Date('2026-10-14T10:00:00Z')
    const s = getSettings()
    expect(isBackupDue(s, null, now)).toBe(false) // no folder: off
    const on = { ...s, backup_dir: '/x' }
    expect(isBackupDue(on, null, now)).toBe(true)
    expect(isBackupDue(on, '2026-10-14T01:00:00.000Z', now)).toBe(false)
    expect(isBackupDue(on, '2026-10-13T09:00:00.000Z', now)).toBe(true)
  })
})

describe('restore', () => {
  it('swaps in the backup, keeps a safety copy of the current data, and reopens cleanly', async () => {
    createTask({ context: 'work', title: 'A', assigned_date: null })
    const backup = await backupNow(join(dir, 'backups'), 5)
    createTask({ context: 'work', title: 'B (after the backup)', assigned_date: null })

    const safety = await restoreBackup(backup, join(dir, 'safety'))
    expect(titles(safety)).toEqual(['A', 'B (after the backup)']) // nothing lost
    expect(existsSync(join(dir, 'live.db-wal'))).toBe(false)

    openDb(join(dir, 'live.db')) // what the relaunched app does
    expect(titles(join(dir, 'live.db'))).toEqual(['A'])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM task').get()).toEqual({ n: 1 })
  })

  it('refuses files that are not usable backups', async () => {
    const junk = join(dir, 'junk.db')
    writeFileSync(junk, 'this is not sqlite')
    const empty = join(dir, 'empty.db')
    new Database(empty).exec('CREATE TABLE other (x)')
    const future = join(dir, 'future.db')
    new Database(future).exec(
      `CREATE TABLE task (id); PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 999;`
    )

    const oldLayout = join(dir, 'old.db')
    new Database(oldLayout).exec('CREATE TABLE task (id); PRAGMA user_version = 7;')
    expect(validateBackup(oldLayout)).toEqual({
      ok: false,
      error: 'This backup uses the pre-release layout and cannot be restored'
    })
    expect(validateBackup(junk)).toMatchObject({ ok: false })
    expect(validateBackup(empty)).toEqual({
      ok: false,
      error: 'This is not an Open Day Plan backup'
    })
    expect(validateBackup(future)).toEqual({
      ok: false,
      error: 'This backup was made by a newer version of the app'
    })
    expect(validateBackup(join(dir, 'missing.db'))).toMatchObject({ ok: false })
    await expect(restoreBackup(junk, join(dir, 'safety'))).rejects.toThrow()
    // a failed restore leaves the live database open and untouched
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM task').get()).toEqual({ n: 0 })
  })
})

describe('exports', () => {
  it('JSON has the data but never an integration credential', () => {
    saveIntegration({
      kind: 'linear',
      name: 'Linear',
      config: { workspace: 'acme' },
      secret: 'lin_api_SUPERSECRET'
    })
    createTask({ context: 'work', title: 'exported task', assigned_date: null })
    const data = exportData(new Date('2026-10-14T10:00:00Z'))
    const json = JSON.stringify(data)
    expect(json).not.toContain('SUPERSECRET')
    expect(json).not.toContain('"secret"')
    expect(data).toMatchObject({ app: 'open-day-plan', exported_at: '2026-10-14T10:00:00.000Z' })
    expect((data.tasks as { title: string }[]).map((t) => t.title)).toEqual(['exported task'])
    expect((data.integrations as { name: string }[]).map((i) => i.name)).toEqual(['Linear'])
    expect(data.settings).not.toHaveProperty('last_backup_at')
  })

  it('Markdown groups open tasks by quadrant, nests subtasks, and lists recent completions', () => {
    const now = new Date()
    const a = createTask({ context: 'work', title: 'Ship report', assigned_date: null })
    setPriority(a.id, 3)
    updateTask(a.id, { description: 'line one\nline two', due_date: '2026-10-20' })
    addLink(a.id, 'https://github.com/acme/api/pull/12', { quiet: true })
    createTask({ context: 'work', title: 'draft intro', assigned_date: null, parent: a.id })
    createTask({ context: 'personal', title: 'Buy gift', assigned_date: null })
    const done = createTask({ context: 'work', title: 'Old win', assigned_date: null })
    setCompleted(done.id, true)

    const md = exportMarkdown(now)
    expect(md).toContain('## Do immediately')
    expect(md).toContain('- [ ] Ship report _(due 2026-10-20)_')
    expect(md).toContain('  - [api#12](https://github.com/acme/api/pull/12)')
    expect(md).toContain('  > line one\n  > line two')
    expect(md).toContain('  - [ ] draft intro')
    expect(md).toContain('## Backlog')
    expect(md).toContain('- [ ] Buy gift _(personal)_')
    expect(md).toContain('## Completed (last 30 days)')
    expect(md).toContain('- [x] Old win')
  })
})

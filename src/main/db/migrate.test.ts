import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPLICATION_ID } from './constants'
import {
  DatabaseTooNewError,
  MIGRATIONS,
  MigrationChecksumError,
  SCHEMA_VERSION,
  UnrecognisedDatabaseError,
  migrate,
  parseMigrations
} from './migrate'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'odp-migrate-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const files = (...sqls: string[]): Record<string, string> =>
  Object.fromEntries(
    sqls.map((s, i) => [`./migrations/${String(i + 1).padStart(4, '0')}_step${i + 1}.sql`, s])
  )

describe('parseMigrations', () => {
  it('orders migrations, checksums them, and reads the foreign_keys=off directive', () => {
    const m = parseMigrations({
      './migrations/0002_b.sql': '-- migrate: foreign_keys=off\nSELECT 2;',
      './migrations/0001_a.sql': 'SELECT 1;'
    })
    expect(m.map((x) => [x.version, x.name, x.foreignKeysOff])).toEqual([
      [1, 'a', false],
      [2, 'b', true]
    ])
    expect(m[0].checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(parseMigrations({ './migrations/0001_a.sql': 'a\r\nb' })[0].checksum).toBe(
      parseMigrations({ './migrations/0001_a.sql': 'a\nb' })[0].checksum
    )
  })

  it('rejects bad names and gaps', () => {
    expect(() => parseMigrations({ './migrations/init.sql': '' })).toThrow('0001_name.sql')
    expect(() =>
      parseMigrations({ './migrations/0001_a.sql': '', './migrations/0003_c.sql': '' })
    ).toThrow('gaps')
  })

  it('the shipped migrations load and start at the baseline', () => {
    expect(MIGRATIONS[0]).toMatchObject({ version: 1, name: 'init' })
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length)
  })
})

describe('migrate', () => {
  const set = parseMigrations(
    files(
      'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);',
      "ALTER TABLE a ADD COLUMN w TEXT DEFAULT 'x';"
    )
  )

  it('initialises an empty database, stamps application_id, and records what it applied', () => {
    const db = new Database(':memory:')
    expect(migrate(db, { migrations: set })).toEqual({ from: 0, to: 2, backup: null })
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    expect(db.pragma('application_id', { simple: true })).toBe(APPLICATION_ID)
    expect(
      db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
    ).toEqual([
      { version: 1, name: 'step1' },
      { version: 2, name: 'step2' }
    ])
    expect(migrate(db, { migrations: set })).toMatchObject({ from: 2, to: 2 }) // idempotent
  })

  it('applies only pending migrations and takes a safety copy first', () => {
    const path = join(dir, 'live.db')
    const db = new Database(path)
    migrate(db, {
      migrations: parseMigrations(files('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);'))
    })
    db.prepare("INSERT INTO a (v) VALUES ('keep me')").run()

    const backupDir = join(dir, 'migration-backups')
    const r = migrate(db, { migrations: set, backupDir, now: new Date('2026-10-14T10:00:00Z') })
    expect(r).toMatchObject({ from: 1, to: 2 })
    expect(r.backup).toBe(join(backupDir, '20261014-100000-pre-v1-to-v2.db'))

    // the copy is the pre-migration state: v1 data, no column w yet
    const copy = new Database(r.backup!, { readonly: true })
    expect(copy.pragma('user_version', { simple: true })).toBe(1)
    expect(copy.pragma('application_id', { simple: true })).toBe(APPLICATION_ID)
    expect(copy.prepare('SELECT v FROM a').all()).toEqual([{ v: 'keep me' }])
    expect(() => copy.prepare('SELECT w FROM a').all()).toThrow()
    copy.close()
    expect(db.prepare('SELECT v, w FROM a').all()).toEqual([{ v: 'keep me', w: 'x' }])
  })

  it('does not back up a brand-new database, and keeps only the newest 5 safety copies', () => {
    const path = join(dir, 'live.db')
    const db = new Database(path)
    const backupDir = join(dir, 'mb')
    expect(
      migrate(db, { migrations: parseMigrations(files('SELECT 1;')), backupDir }).backup
    ).toBeNull()
    expect(existsSync(backupDir)).toBe(false)

    let sqls = ['SELECT 1;']
    for (let i = 0; i < 7; i++) {
      sqls = [...sqls, `CREATE TABLE t${i} (x);`]
      migrate(db, {
        migrations: parseMigrations(files(...sqls)),
        backupDir,
        now: new Date(2026, 9, 14, 10, 0, i)
      })
    }
    expect(readdirSync(backupDir)).toHaveLength(5)
  })

  it('rolls a failed migration back completely and leaves the version unchanged', () => {
    const db = new Database(':memory:')
    migrate(db, { migrations: parseMigrations(files('CREATE TABLE a (id INTEGER PRIMARY KEY);')) })
    const bad = parseMigrations(
      files(
        'CREATE TABLE a (id INTEGER PRIMARY KEY);',
        'CREATE TABLE b (x); INSERT INTO nope VALUES (1);'
      )
    )
    expect(() => migrate(db, { migrations: bad })).toThrow(/Migration 2 \(step2\) failed/)
    expect(db.pragma('user_version', { simple: true })).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'b'").get()).toEqual({
      n: 0
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 })
  })

  it('refuses a database written by a newer version', () => {
    const db = new Database(':memory:')
    migrate(db, { migrations: set })
    const older = parseMigrations(files('CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);'))
    let err: unknown
    try {
      migrate(db, { migrations: older })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DatabaseTooNewError)
    expect((err as DatabaseTooNewError).message).toContain('newer version')
  })

  it('refuses to run when an applied migration was edited afterwards', () => {
    const db = new Database(':memory:')
    migrate(db, { migrations: set })
    const edited = parseMigrations(
      files(
        'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT, sneaky TEXT);',
        "ALTER TABLE a ADD COLUMN w TEXT DEFAULT 'x';"
      )
    )
    expect(() => migrate(db, { migrations: edited })).toThrow(MigrationChecksumError)
    expect(() => migrate(db, { migrations: edited })).toThrow(/never change/)
  })

  it("refuses another application's database and an old-layout one", () => {
    const other = new Database(':memory:')
    other.pragma('application_id = 12345')
    expect(() => migrate(other, { migrations: set })).toThrow(UnrecognisedDatabaseError)

    const legacy = new Database(':memory:')
    legacy.pragma('user_version = 3')
    expect(() => migrate(legacy, { migrations: set })).toThrow(/old layout/)
  })

  it('supports the table-rebuild recipe: foreign keys off, then checked afterwards', () => {
    const base = [
      'CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);',
      'CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id) ON DELETE CASCADE);'
    ]
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db, { migrations: parseMigrations(files(base.join('\n'))) })
    db.exec("INSERT INTO parent VALUES (1, 'a'); INSERT INTO child VALUES (1, 1);")

    const rebuild = `-- migrate: foreign_keys=off
CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', extra TEXT);
INSERT INTO parent_new (id, name) SELECT id, name FROM parent;
DROP TABLE parent;
ALTER TABLE parent_new RENAME TO parent;`
    migrate(db, { migrations: parseMigrations(files(base.join('\n'), rebuild)) })
    expect(db.prepare('SELECT * FROM child').all()).toEqual([{ id: 1, p: 1 }]) // child rows survived the drop
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1) // restored afterwards
    expect(db.pragma('foreign_key_check')).toEqual([])

    // a rebuild that orphans rows is rolled back
    const broken = `-- migrate: foreign_keys=off
DELETE FROM parent;`
    expect(() =>
      migrate(db, { migrations: parseMigrations(files(base.join('\n'), rebuild, broken)) })
    ).toThrow(/foreign key/)
    expect(db.prepare('SELECT COUNT(*) AS n FROM parent').get()).toEqual({ n: 1 })
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })
})

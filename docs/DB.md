# Database

SQLite via better-sqlite3, opened only in the main process (`src/main/db/`). One file,
`open-day-plan.db` in the app's user-data folder, in WAL mode.

The schema is defined by the SQL files in `src/main/db/migrations/`. `schema.snapshot.sql` is a
generated, checked-in rendering of the schema those files produce, so every schema change is
visible in review.

## Conventions

| Suffix / shape | Meaning |
|---|---|
| `*_at` | a UTC instant, `YYYY-MM-DDTHH:MM:SS.sssZ`. Always milliseconds, always the trailing `Z` (never an offset). Enforced by a `CHECK`. |
| `*_date`, `day` | a local calendar date, `YYYY-MM-DD`. Enforced by a `CHECK`. Dates never move when the timezone setting changes. |
| `id` | uuid v7 text. |
| booleans | `INTEGER` 0 or 1 with a `CHECK`. |
| JSON columns | `json_valid(...)` `CHECK`; parsed in code. |

Use `CHECK`s for **stable** enums (`context`, `priority`). Do **not** freeze **extensible** ones in
a `CHECK` (`integration.kind`, `activity_log.type`, `external_item.state`): SQLite can't alter a
`CHECK`, so adding a value would need a table rebuild. Validate those in code.

## Invariants the database enforces

- Subtasks are leaves: never projects, never recurring, one level deep, same `context` as the
  parent (CHECK plus triggers). Changing a parent's context moves its subtasks.
- `task.updated_at` is touched by a trigger if a write forgets it.
- `task_link` has no duplicate URL per task; one `external_item` tracks a task at most.
- Deleting a task cascades to its subtasks, links and external tracking. The activity log keeps
  its rows (`ref_id` becomes NULL).
- A calendar event is either timed (`start_at`/`end_at`) or all-day (`start_date`/`end_date`).

## Migrations

**Rules. Read before touching the schema.**

1. **Never edit, rename or reorder a migration that has shipped.** The runner records a checksum
   for each applied migration and refuses to start if one changed.
2. A schema change is a **new** file: `migrations/000N_what_it_does.sql`, numbered without gaps.
3. Prefer **additive** changes (`ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`). A new `NOT NULL`
   column needs a `DEFAULT`.
4. Anything destructive (dropping or retyping a column, changing a `CHECK`) uses SQLite's
   table-rebuild recipe: put `-- migrate: foreign_keys=off` on its own line in the file, create the
   new table, copy, drop the old one, rename, recreate indexes and triggers. The runner turns
   foreign keys off around the transaction and fails the migration if `PRAGMA foreign_key_check`
   is not empty afterwards.
5. Separate schema changes from data fixes where you can, and keep each migration small.
6. Every migration ships with a test (see below) and a regenerated snapshot.

**What the runner does** (`migrate.ts`): refuses a database from a newer app (never silently runs
old code on a newer schema), refuses another app's file or an old-layout file, verifies the
checksums, takes a safety copy before changing a non-empty database
(`<user-data>/migration-backups/<stamp>-pre-vA-to-vB.db`, newest 5 kept), runs each migration in
its own transaction, and records it in `schema_migrations`.

**Adding a migration**

1. Write `migrations/0002_<name>.sql`.
2. Add a test that builds the previous schema, seeds representative rows, migrates, and checks the
   data survived:

   ```ts
   const db = new Database(':memory:')
   migrate(db, { migrations: migrationsUpTo(1) })   // the schema as it was
   db.exec("INSERT INTO task ...")                 // realistic rows
   migrate(db)                                      // apply everything newer
   expect(db.prepare('SELECT ...').all()).toEqual([...])
   ```
3. Run `npm run db:snapshot`, review the diff of `schema.snapshot.sql`, and commit it with the
   migration.

## Indexes

Every index serves a named query. Measured on a synthetic 20k-task / 100k-activity database,
none of these queries was slow before (0.5-6 ms); the indexes keep the recurring and cascading
ones from growing with history.

| Index | Serves |
|---|---|
| `task_open_day(context, assigned_date) WHERE completed_at IS NULL` | day lists (open branch), carry-over, backlog, end-of-day review |
| `task_completed(completed_at) WHERE completed_at IS NOT NULL` | "completed in a time range": day lists, standup, review counts, export |
| `task_open_scheduled(scheduled_at) WHERE open AND scheduled` | the notifier (every 30 s) and the menu-bar "next up" (every 60 s) |
| `task_open_due(due_date) WHERE open AND due` | morning digest, overdue blockers |
| `task_parent(parent)` | subtasks and the delete cascade |
| `activity_log_feed(created_at, id)` | the global feed, newest first |
| `activity_log_ref(ref_id, created_at, id)` | one task's history, and the scan `ON DELETE SET NULL` does when a task is deleted |
| `task_link UNIQUE(task_id, url)` | link lists and the duplicate guard |
| `external_item_task UNIQUE(task_id)` | one tracking row per task |
| `link_preview_integration`, `calendar_event_*` | cascades; per-day agenda and notifier queries |

Add an index only for a concrete query, and say which in the migration. `PRAGMA optimize` runs
hourly and on quit.

## Retention

- `notification_log` rows older than 7 days and `link_preview` rows older than 30 days are purged
  at startup.
- `activity_log` is history and is kept.
- `calendar_event` is replaced wholesale on each calendar sync.

## Pre-release layout

Before v1 the schema grew through seven migrations with a different layout (`assigned_to` instants,
`content` JSON, ...). On first launch of v1, if the data file is that layout it is renamed to
`open-day-plan.legacy-v7-<stamp>.db` (never deleted), a fresh database is created, and settings and
integrations (with their encrypted tokens) are imported once (`legacy.ts`). Tasks were not carried
over. The legacy importer can be deleted once nobody has such a file.

## Backups and restore

`db.backup()` produces consistent copies while the app runs. `validateBackup` checks
`PRAGMA application_id`, the schema version, and integrity before a restore; a restored older
backup is migrated forward on the next start (with its own safety copy).

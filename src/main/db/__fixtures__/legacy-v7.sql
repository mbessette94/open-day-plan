-- The pre-release layout (user_version 7, no application_id), frozen as a fixture for the
-- legacy importer tests. Do not edit.
CREATE TABLE user_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    timezone TEXT NOT NULL,
    work_days TEXT NOT NULL,
    work_time_start TEXT NOT NULL,
    work_time_end TEXT NOT NULL,
    personal_time_start TEXT NOT NULL,
    personal_time_end TEXT NOT NULL
  , sync_minutes INTEGER NOT NULL DEFAULT 15, notify_enabled INTEGER NOT NULL DEFAULT 1, notify_lead_min INTEGER NOT NULL DEFAULT 5, digest_time TEXT NOT NULL DEFAULT '08:30', shutdown_time TEXT NOT NULL DEFAULT '17:00', quick_hotkey TEXT NOT NULL DEFAULT 'Control+Alt+Space', launch_at_login INTEGER NOT NULL DEFAULT 0, backup_dir TEXT, backup_keep INTEGER NOT NULL DEFAULT 14, last_backup_at TEXT);
CREATE TABLE day_record (
    day TEXT PRIMARY KEY, timezone TEXT NOT NULL, work_days TEXT NOT NULL, work_time_start TEXT NOT NULL,
    work_time_end TEXT NOT NULL, personal_time_start TEXT NOT NULL, personal_time_end TEXT NOT NULL
  , reviewed_at TEXT, completed_count INTEGER, carried_count INTEGER);
CREATE TABLE task (
    id TEXT PRIMARY KEY,
    parent TEXT REFERENCES task(id) ON DELETE SET NULL,
    context TEXT NOT NULL CHECK (context IN ('work', 'personal')),
    title TEXT NOT NULL,
    content TEXT,
    priority INTEGER CHECK (priority IN (0, 1, 2, 3)),
    completed_on TEXT,
    assigned_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  , scheduled_at TEXT, duration_min INTEGER NOT NULL DEFAULT 15, due_date TEXT, is_project INTEGER NOT NULL DEFAULT 0, recurrence TEXT);
CREATE INDEX task_assigned_to ON task(assigned_to);
CREATE TABLE activity_log (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, action_taken TEXT NOT NULL,
    ref_id TEXT REFERENCES task(id) ON DELETE SET NULL
  , kind TEXT NOT NULL DEFAULT 'event');
CREATE INDEX activity_log_created_at ON activity_log(created_at);
CREATE TABLE task_link (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    url TEXT NOT NULL, created_at TEXT NOT NULL
  );
CREATE INDEX task_link_task_id ON task_link(task_id);
CREATE INDEX task_parent ON task(parent);
CREATE TABLE integration (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('jira', 'linear', 'github', 'google_calendar', 'caldav')),
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    secret BLOB,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_sync_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
CREATE TABLE link_preview (
    url TEXT PRIMARY KEY, integration_id TEXT NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
    data TEXT NOT NULL, fetched_at TEXT NOT NULL
  );
CREATE TABLE external_item (
    integration_id TEXT NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
    state TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (integration_id, external_id)
  );
CREATE TABLE calendar_event (
    id TEXT PRIMARY KEY, integration_id TEXT NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
    start_at TEXT NOT NULL, end_at TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
    location TEXT, url TEXT, synced_at TEXT NOT NULL,
    UNIQUE (integration_id, calendar_id, external_id, start_at)
  );
CREATE TABLE notification_log (key TEXT PRIMARY KEY, fired_at TEXT NOT NULL);

INSERT INTO user_settings (id, timezone, work_days, work_time_start, work_time_end, personal_time_start,
  personal_time_end, sync_minutes, notify_lead_min, shutdown_time, quick_hotkey, backup_dir, backup_keep, last_backup_at)
VALUES (1, 'America/New_York', 'mo,tu,we,th', '08:30', '16:30', '07:00', '22:00', 30, 10, '16:45',
  'Alt+Shift+Space', '/Users/me/backups', 7, '2026-10-13T20:00:00.000Z');
INSERT INTO task (id, context, title, assigned_to, created_at, updated_at)
VALUES ('0198f3a2-7b1c-7d4e-9a10-3f5b6c7d8e9f', 'work', 'a legacy task', '2026-10-14T13:00:00.000Z',
  '2026-10-13T12:00:00.000Z', '2026-10-13T12:00:00.000Z');
INSERT INTO integration (id, kind, name, config, secret, enabled, last_sync_at, last_error, created_at) VALUES
  ('int-1', 'github', 'Work GitHub', '{"pr_filter":"review-requested:@me"}', X'0102030405FF', 1,
   '2026-10-13T19:00:00.000Z', NULL, '2026-10-01T10:00:00.000Z'),
  ('int-2', 'jira', 'Broken config', 'not json', X'AABB', 0, 'garbage', 'boom', 'also garbage');
INSERT INTO calendar_event (id, integration_id, calendar_id, external_id, title, start_at, end_at, synced_at)
VALUES ('ev1', 'int-1', 'c', 'e', 'Standup', '2026-10-14T14:00:00.000Z', '2026-10-14T14:30:00.000Z', '2026-10-14T00:00:00.000Z');
PRAGMA user_version = 7;

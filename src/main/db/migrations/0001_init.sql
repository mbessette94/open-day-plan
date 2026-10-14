-- Baseline schema, version 1.
--
-- Conventions (see docs/DB.md):
--   *_at    a UTC instant, 'YYYY-MM-DDTHH:MM:SS.sssZ' (always the trailing Z, always milliseconds)
--   *_date  a local calendar date, 'YYYY-MM-DD'
--   booleans are 0/1 with a CHECK; ids are uuid7 text
--   stable enums get a CHECK; extensible ones (integration kind, activity type, external state)
--   deliberately do not, so adding a value never needs a table rebuild. Code validates those.

CREATE TABLE user_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL CHECK (length(timezone) > 0),
  work_days TEXT NOT NULL,                       -- 'mo,tu,we,th,fr'; validated in code
  work_time_start TEXT NOT NULL CHECK (work_time_start GLOB '[01][0-9]:[0-5][0-9]' OR work_time_start GLOB '2[0-3]:[0-5][0-9]'),
  work_time_end TEXT NOT NULL CHECK (work_time_end GLOB '[01][0-9]:[0-5][0-9]' OR work_time_end GLOB '2[0-3]:[0-5][0-9]'),
  personal_time_start TEXT NOT NULL CHECK (personal_time_start GLOB '[01][0-9]:[0-5][0-9]' OR personal_time_start GLOB '2[0-3]:[0-5][0-9]'),
  personal_time_end TEXT NOT NULL CHECK (personal_time_end GLOB '[01][0-9]:[0-5][0-9]' OR personal_time_end GLOB '2[0-3]:[0-5][0-9]'),
  sync_minutes INTEGER NOT NULL DEFAULT 15 CHECK (sync_minutes BETWEEN 1 AND 1440),
  notify_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notify_enabled IN (0, 1)),
  notify_lead_min INTEGER NOT NULL DEFAULT 5 CHECK (notify_lead_min BETWEEN 0 AND 120),
  digest_time TEXT NOT NULL DEFAULT '08:30' CHECK (digest_time GLOB '[01][0-9]:[0-5][0-9]' OR digest_time GLOB '2[0-3]:[0-5][0-9]'),
  shutdown_time TEXT NOT NULL DEFAULT '17:00' CHECK (shutdown_time GLOB '[01][0-9]:[0-5][0-9]' OR shutdown_time GLOB '2[0-3]:[0-5][0-9]'),
  quick_hotkey TEXT NOT NULL DEFAULT 'Control+Alt+Space' CHECK (length(quick_hotkey) > 0),
  launch_at_login INTEGER NOT NULL DEFAULT 0 CHECK (launch_at_login IN (0, 1)),
  backup_dir TEXT,                               -- NULL: automatic backups are off
  backup_keep INTEGER NOT NULL DEFAULT 14 CHECK (backup_keep BETWEEN 1 AND 365)
);

-- Operational state the app writes itself (last_backup_at, ...), kept apart from user preferences
-- so saving settings can never overwrite it.
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per local day: the settings in force that day, plus the end-of-day review summary.
CREATE TABLE day_record (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  timezone TEXT NOT NULL,
  work_days TEXT NOT NULL,
  work_time_start TEXT NOT NULL,
  work_time_end TEXT NOT NULL,
  personal_time_start TEXT NOT NULL,
  personal_time_end TEXT NOT NULL,
  reviewed_at TEXT CHECK (reviewed_at IS NULL OR reviewed_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  completed_count INTEGER CHECK (completed_count IS NULL OR completed_count >= 0),
  carried_count INTEGER CHECK (carried_count IS NULL OR carried_count >= 0)
);

CREATE TABLE task (
  id TEXT PRIMARY KEY,
  parent TEXT REFERENCES task(id) ON DELETE CASCADE,
  context TEXT NOT NULL CHECK (context IN ('work', 'personal')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',          -- markdown
  priority INTEGER CHECK (priority IN (0, 1, 2, 3)),   -- Eisenhower quadrant; NULL = backlog
  assigned_date TEXT CHECK (assigned_date IS NULL OR assigned_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),    -- the local day it belongs to; NULL = no day
  scheduled_at TEXT CHECK (scheduled_at IS NULL OR scheduled_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),      -- planned start on the agenda
  duration_min INTEGER NOT NULL DEFAULT 15
    CHECK (duration_min BETWEEN 15 AND 1440 AND duration_min % 15 = 0),
  due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  completed_at TEXT CHECK (completed_at IS NULL OR completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  is_project INTEGER NOT NULL DEFAULT 0 CHECK (is_project IN (0, 1)),
  recurrence TEXT CHECK (recurrence IS NULL OR json_valid(recurrence)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  -- subtasks are leaves: they are never projects and never repeat
  CHECK (parent IS NULL OR (is_project = 0 AND recurrence IS NULL))
);

-- A subtask hangs off a top-level task and shares its context. CHECKs can't look at other rows,
-- so these are triggers.
CREATE TRIGGER task_parent_insert BEFORE INSERT ON task
WHEN NEW.parent IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'subtask parent must be a top-level task')
    WHERE (SELECT parent FROM task WHERE id = NEW.parent) IS NOT NULL;
  SELECT RAISE(ABORT, 'subtask context must match its parent')
    WHERE (SELECT context FROM task WHERE id = NEW.parent) <> NEW.context;
END;

CREATE TRIGGER task_parent_update BEFORE UPDATE OF parent, context ON task
WHEN NEW.parent IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'subtask parent must be a top-level task')
    WHERE (SELECT parent FROM task WHERE id = NEW.parent) IS NOT NULL;
  SELECT RAISE(ABORT, 'a task that has subtasks cannot become a subtask')
    WHERE EXISTS (SELECT 1 FROM task WHERE parent = NEW.id);
  SELECT RAISE(ABORT, 'subtask context must match its parent')
    WHERE (SELECT context FROM task WHERE id = NEW.parent) <> NEW.context;
END;

CREATE TRIGGER task_context_cascade AFTER UPDATE OF context ON task
WHEN NEW.context <> OLD.context
BEGIN
  UPDATE task SET context = NEW.context WHERE parent = NEW.id;
END;

-- Safety net: any write that forgets to bump updated_at still gets it.
CREATE TRIGGER task_touch AFTER UPDATE ON task
WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE task SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- day lists, carry-over, backlog and the end-of-day review (open tasks only)
CREATE INDEX task_open_day ON task(context, assigned_date) WHERE completed_at IS NULL;
-- "completed in a time range": standup, review counts, exports
CREATE INDEX task_completed ON task(completed_at) WHERE completed_at IS NOT NULL;
-- the notifier (every 30 s) and the menu-bar "next up" (every 60 s)
CREATE INDEX task_open_scheduled ON task(scheduled_at)
  WHERE completed_at IS NULL AND scheduled_at IS NOT NULL;
-- morning digest and overdue blockers
CREATE INDEX task_open_due ON task(due_date) WHERE completed_at IS NULL AND due_date IS NOT NULL;
-- subtasks, and the ON DELETE CASCADE
CREATE INDEX task_parent ON task(parent) WHERE parent IS NOT NULL;

CREATE TABLE task_link (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (length(url) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  UNIQUE (task_id, url)
);

-- type is a dotted name such as 'task.created' or 'comment'; action_taken is the readable text
-- rendered when it was written; data is optional structured detail. The history survives deleting
-- the task (ref_id becomes NULL).
CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  type TEXT NOT NULL CHECK (length(type) > 0),
  action_taken TEXT NOT NULL,
  data TEXT CHECK (data IS NULL OR json_valid(data)),
  ref_id TEXT REFERENCES task(id) ON DELETE SET NULL
);
-- the global feed, newest first
CREATE INDEX activity_log_feed ON activity_log(created_at, id);
-- one task's history, and the scan that ON DELETE SET NULL does when a task is deleted
CREATE INDEX activity_log_ref ON activity_log(ref_id, created_at, id) WHERE ref_id IS NOT NULL;

CREATE TABLE integration (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (length(kind) > 0),   -- jira, linear, github, ...; validated in code
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  secret BLOB,                                   -- encrypted with the OS keychain (safeStorage)
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_sync_at TEXT CHECK (last_sync_at IS NULL OR last_sync_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  last_error TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z')
);

CREATE TABLE link_preview (
  url TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK (json_valid(data)),
  fetched_at TEXT NOT NULL CHECK (fetched_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z')
);
CREATE INDEX link_preview_integration ON link_preview(integration_id);

-- Issues / pull requests we know about. task_id is set while a task tracks the item; a row with
-- no task is a "seen" marker (for example a merged PR that never had a task).
CREATE TABLE external_item (
  integration_id TEXT NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  task_id TEXT REFERENCES task(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  PRIMARY KEY (integration_id, external_id)
);
CREATE UNIQUE INDEX external_item_task ON external_item(task_id) WHERE task_id IS NOT NULL;

-- Timed events have start_at/end_at (UTC instants). All-day events have start_date/end_date
-- (local dates, end exclusive). Exactly one pair is set.
CREATE TABLE calendar_event (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at TEXT CHECK (start_at IS NULL OR start_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  end_at TEXT CHECK (end_at IS NULL OR end_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  start_date TEXT CHECK (start_date IS NULL OR start_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  end_date TEXT CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  location TEXT,
  url TEXT,
  synced_at TEXT NOT NULL CHECK (synced_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  CHECK (
    (start_at IS NOT NULL AND end_at IS NOT NULL AND start_date IS NULL AND end_date IS NULL)
    OR (start_at IS NULL AND end_at IS NULL AND start_date IS NOT NULL AND end_date IS NOT NULL)
  )
);
CREATE UNIQUE INDEX calendar_event_identity
  ON calendar_event(integration_id, calendar_id, external_id, COALESCE(start_at, start_date));
CREATE INDEX calendar_event_timed ON calendar_event(start_at) WHERE start_at IS NOT NULL;
CREATE INDEX calendar_event_all_day ON calendar_event(start_date) WHERE start_date IS NOT NULL;

CREATE TABLE notification_log (
  key TEXT PRIMARY KEY,
  fired_at TEXT NOT NULL CHECK (fired_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z')
);

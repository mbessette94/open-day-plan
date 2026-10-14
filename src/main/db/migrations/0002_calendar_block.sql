-- Version 2: calendar blocks the app has written to the work calendar.
--
-- "Focus time" (a scheduled work task) and "Personal commitment" (a personal event that lands in
-- work hours) are pushed to the calendar chosen as the block target. One row per pushed block, so
-- later syncs can update or delete exactly what we created and nothing else.

CREATE TABLE calendar_block (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('focus', 'personal')),
  source_key TEXT NOT NULL,                      -- focus: task id; personal: event|work day it was clipped for
  integration_id TEXT NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  remote_id TEXT,                                -- Google event id / CalDAV object URL; NULL until created
  start_at TEXT NOT NULL CHECK (start_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  end_at TEXT NOT NULL CHECK (end_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  pushed_at TEXT CHECK (pushed_at IS NULL OR pushed_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'),
  CHECK (end_at > start_at)
);
CREATE UNIQUE INDEX calendar_block_source
  ON calendar_block(integration_id, calendar_id, kind, source_key);

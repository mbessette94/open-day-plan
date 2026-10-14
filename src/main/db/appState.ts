import { getDb } from './index'

/** Operational state the app writes itself (last backup time, ...), separate from user settings. */
export function getState(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setState(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

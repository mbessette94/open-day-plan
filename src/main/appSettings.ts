import { app } from 'electron'
import type { UserSettings } from '../shared/types'

type Listener = (s: UserSettings) => void
const listeners: Listener[] = []

/** Subscribe to "settings were applied" (startup and every save). */
export function onSettingsApplied(cb: Listener): void {
  listeners.push(cb)
}

/** Push settings that have side effects outside the database. */
export function applySettings(s: UserSettings): void {
  // only a packaged app should register itself as a login item, never the dev Electron binary
  if (app.isPackaged) {
    try {
      // only touch the login item when it differs: macOS errors when removing one that isn't there
      if (app.getLoginItemSettings().openAtLogin !== s.launch_at_login) {
        app.setLoginItemSettings({ openAtLogin: s.launch_at_login })
      }
    } catch (e) {
      console.warn('could not update the login item', e)
    }
  }
  for (const cb of listeners) cb(s)
}

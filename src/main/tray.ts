import { Menu, Tray, app, nativeImage } from 'electron'
import { nextUpLabel } from './notifier'

export interface TrayHandlers {
  openPlanner: () => void
  standup: () => void
  wrapUp: () => void
  quickCapture?: () => void
  backupNow?: () => void
}

/** Title-only menu-bar item (macOS) showing the next scheduled item. */
export function startTray(h: TrayHandlers): { refresh: () => void; destroy: () => void } {
  if (process.platform !== 'darwin') return { refresh: () => {}, destroy: () => {} }
  const tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('Open Day Plan')

  const refresh = (): void => {
    try {
      tray.setTitle(nextUpLabel(new Date()))
    } catch {
      tray.setTitle('Plan')
    }
  }
  const items: Electron.MenuItemConstructorOptions[] = [
    ...(h.quickCapture ? [{ label: 'Quick capture…', click: h.quickCapture }] : []),
    { label: 'Open planner', click: h.openPlanner },
    { label: 'Standup', click: h.standup },
    { label: 'Wrap up the day', click: h.wrapUp },
    ...(h.backupNow ? [{ label: 'Back up now', click: h.backupNow }] : []),
    { type: 'separator' as const },
    { label: 'Quit', click: () => app.quit() }
  ]
  tray.setContextMenu(Menu.buildFromTemplate(items))
  refresh()
  const timer = setInterval(refresh, 60_000)
  return {
    refresh,
    destroy: () => {
      clearInterval(timer)
      tray.destroy()
    }
  }
}

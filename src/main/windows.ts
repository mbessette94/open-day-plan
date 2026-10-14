import { BrowserWindow } from 'electron'
import type { UiAction } from '../shared/types'

let factory: (() => BrowserWindow) | null = null
let main: BrowserWindow | null = null

/** index.ts registers how to build the planner window; other modules reuse it. */
export function registerMainWindow(create: () => BrowserWindow): void {
  factory = create
}

export function setMainWindow(w: BrowserWindow): void {
  main = w
  w.on('closed', () => {
    if (main === w) main = null
  })
}

export function getMainWindow(): BrowserWindow | null {
  return main && !main.isDestroyed() ? main : null
}

export function showMainWindow(): BrowserWindow {
  const w = getMainWindow() ?? factory?.()
  if (!w) throw new Error('Main window factory is not registered')
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  return w
}

/** Bring the planner forward and ask it to open something. */
export function sendUi(action: UiAction): void {
  const existing = getMainWindow()
  const w = showMainWindow()
  if (existing) w.webContents.send('ui:open', action)
  else w.webContents.once('did-finish-load', () => w.webContents.send('ui:open', action))
}

import { BrowserWindow, globalShortcut, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { HotkeyStatus } from '../shared/types'

const WIDTH = 640
const HEIGHT = 96
let win: BrowserWindow | null = null
let status: HotkeyStatus = { accelerator: '', ok: false, error: null }

function create(): BrowserWindow {
  const w = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  w.setAlwaysOnTop(true, 'floating')
  // show over full-screen apps too, without flickering the Dock icon
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  w.on('blur', () => {
    if (!w.webContents.isDevToolsOpened()) w.hide()
  })
  // same renderer bundle; main.tsx renders the capture view for the #capture hash
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#capture`)
  } else {
    w.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'capture' })
  }
  return w
}

function windowOrCreate(): BrowserWindow {
  if (!win || win.isDestroyed()) win = create()
  return win
}

/** Create the window hidden so the hotkey opens it instantly. */
export function prewarmCapture(): void {
  windowOrCreate()
}

export function showCapture(): void {
  const w = windowOrCreate()
  const { x, y, width, height } = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint()
  ).workArea
  w.setPosition(Math.round(x + (width - WIDTH) / 2), Math.round(y + height * 0.22))
  w.show()
  w.focus()
  w.webContents.send('capture:focus')
}

export function hideCapture(): void {
  if (win && !win.isDestroyed()) win.hide()
}

export function toggleCapture(): void {
  if (win && !win.isDestroyed() && win.isVisible()) hideCapture()
  else showCapture()
}

/** (Re)register the global shortcut. Reports failure instead of throwing, e.g. when another app owns it. */
export function registerHotkey(accelerator: string): HotkeyStatus {
  globalShortcut.unregisterAll()
  try {
    const ok = globalShortcut.register(accelerator, toggleCapture)
    status = {
      accelerator,
      ok,
      error: ok ? null : 'That shortcut is already in use by another app'
    }
  } catch (e) {
    status = { accelerator, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!status.ok) console.warn(`quick-capture hotkey ${accelerator}: ${status.error}`)
  return status
}

export function getHotkeyStatus(): HotkeyStatus {
  return status
}

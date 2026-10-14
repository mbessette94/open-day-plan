import { app, dialog, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { closeDb, openDb, optimizeDb } from './db'
import { recordToday } from './db/dayRecords'
import { broadcastDataChanged, registerIpc } from './ipc'
import { startScheduler } from './integrations/sync'
import { applySettings, onSettingsApplied } from './appSettings'
import { getSettings } from './db/settings'
import { backupNow, startBackupScheduler } from './backup'
import { startNotifier } from './notifier'
import { startTray } from './tray'
import { Notification } from 'electron'
import { handleUrl, type UrlDeps } from './urlHandler'
import { prewarmCapture, registerHotkey, showCapture } from './quickWindow'
import { registerMainWindow, sendUi, setMainWindow, showMainWindow } from './windows'

// one running instance owns the database, hotkey and tray; later launches hand over their URL
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

const urlDeps: UrlDeps = {
  showCapture,
  openUi: sendUi,
  notify: (body) => {
    if (Notification.isSupported()) new Notification({ title: 'Open Day Plan', body }).show()
  },
  changed: broadcastDataChanged
}
const pendingUrls: string[] = []
let ready = false
const onUrl = (url: string): void => {
  if (ready) handleUrl(url, urlDeps)
  else pendingUrls.push(url) // the app was launched by the URL: wait for the database
}
// must be registered before 'ready' or the launching URL is missed
app.on('open-url', (event, url) => {
  event.preventDefault()
  onUrl(url)
})
app.on('second-instance', (_e, argv) => {
  const url = argv.find((a) => a.startsWith('opendayplan://'))
  if (url) onUrl(url)
  else showMainWindow()
})

function createWindow(): BrowserWindow {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  setMainWindow(mainWindow)
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  if (!gotLock) return // a second instance is quitting; it only passes its URL along
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.opendayplan')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    openDb()
  } catch (e) {
    // a database this version must not touch (newer, edited migrations, ...): say why and stop
    dialog.showErrorBox(
      'Open Day Plan cannot open its data',
      e instanceof Error ? e.message : String(e)
    )
    app.exit(1)
    return
  }
  // keep the query planner's statistics fresh, and flush on the way out
  setInterval(optimizeDb, 3600_000)
  app.on('before-quit', () => closeDb())
  recordToday()
  registerIpc()
  startScheduler(broadcastDataChanged)

  registerMainWindow(createWindow)
  createWindow()

  startNotifier(sendUi)
  const tray = startTray({
    quickCapture: showCapture,
    openPlanner: () => showMainWindow(),
    standup: () => sendUi({ type: 'standup' }),
    wrapUp: () => sendUi({ type: 'wrapup' }),
    backupNow: () => {
      const s = getSettings()
      if (!s.backup_dir) {
        urlDeps.notify('Choose a backup folder in Settings first')
        showMainWindow()
        return
      }
      backupNow(s.backup_dir, s.backup_keep)
        .then(() => urlDeps.notify('Backup complete'))
        .catch((e) => urlDeps.notify(`Backup failed: ${e instanceof Error ? e.message : e}`))
    }
  })
  startBackupScheduler()
  onSettingsApplied((next) => {
    tray.refresh()
    registerHotkey(next.quick_hotkey)
  })
  applySettings(getSettings())
  prewarmCapture()

  // register as the handler for opendayplan:// (packaged builds only; a dev run would claim it for Electron)
  if (app.isPackaged) app.setAsDefaultProtocolClient('opendayplan')
  ready = true
  for (const url of pendingUrls.splice(0)) handleUrl(url, urlDeps)

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    showMainWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

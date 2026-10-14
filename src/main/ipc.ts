import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type {
  BackupResult,
  CalendarListResult,
  CaptureHint,
  ReviewAction,
  JiraSubtasksResult,
  Context,
  ExternalIssue,
  ExternalListResult,
  IntegrationInput,
  Priority,
  TaskCreate,
  TaskListQuery,
  TaskUpdate,
  TestOutcome,
  UserSettings
} from '../shared/types'
import { addActivity, listActivity } from './db/activity'
import { recordToday } from './db/dayRecords'
import { ACTIVITY } from '../shared/activity'
import { applySettings } from './appSettings'
import {
  backupInfo,
  backupNow,
  exportData,
  exportMarkdown,
  recordBackupError,
  restoreBackup,
  validateBackup
} from './backup'
import { submitCapture } from './capture'
import { getHotkeyStatus, hideCapture } from './quickWindow'
import { applyReview, getReview } from './db/review'
import { getSettings, updateSettings } from './db/settings'
import { buildStandup } from './standup'
import { scheduleReconcile } from './integrations/blocks'
import { listEvents } from './integrations/calendarSync'
import {
  addExternalAsTask,
  addJiraSubtasks,
  listExternal,
  listJiraSubtasks
} from './integrations/external'
import { errorMessage } from './integrations/http'
import { connectGoogle } from './integrations/googleOAuth'
import { getPreview } from './integrations/previews'
import { listCalendarsProvider, testProvider } from './integrations/providers'
import {
  getRecord,
  listIntegrations,
  patchConfig,
  removeIntegration,
  saveIntegration,
  setSyncStatus
} from './integrations/registry'
import { runSync } from './integrations/sync'
import { getMainWindow } from './windows'
import {
  addLink,
  createTask,
  deleteTask,
  getTaskDetail,
  listBacklog,
  listTasks,
  removeLink,
  scheduleTask,
  setCompleted,
  setDuration,
  setPriority,
  updateTask
} from './db/tasks'

/** Pass a task mutation's result through, then refresh the calendar blocks shortly after. */
function blocksMayChange<T>(result: T): T {
  scheduleReconcile()
  return result
}

export function broadcastDataChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('data:changed')
}

function showOpen(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  const w = getMainWindow()
  return w ? dialog.showOpenDialog(w, options) : dialog.showOpenDialog(options)
}

async function exportToFile(
  label: string,
  ext: string,
  build: () => string
): Promise<BackupResult> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const options = {
    title: `Export ${label}`,
    defaultPath: join(app.getPath('documents'), `open-day-plan-${stamp}.${ext}`),
    filters: [{ name: label, extensions: [ext] }]
  }
  const w = getMainWindow()
  const r = w ? await dialog.showSaveDialog(w, options) : await dialog.showSaveDialog(options)
  if (r.canceled || !r.filePath) return { ok: false, message: 'Cancelled' }
  try {
    writeFileSync(r.filePath, build(), 'utf8')
    return { ok: true, message: `Exported to ${r.filePath}` }
  } catch (e) {
    return { ok: false, message: `Export failed: ${errorMessage(e)}` }
  }
}

export function registerIpc(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<UserSettings>) => {
    const next = updateSettings(patch)
    recordToday()
    applySettings(next)
    return blocksMayChange(next) // work hours and timezone move the personal commitments
  })
  ipcMain.handle('tasks:list', (_e, q: TaskListQuery) => listTasks(q))
  ipcMain.handle('tasks:create', (_e, input: TaskCreate) => createTask(input))
  ipcMain.handle('tasks:backlog', (_e, context: Context) => listBacklog(context))
  ipcMain.handle('tasks:setPriority', (_e, id: string, p: Priority | null, assignTo?: string) =>
    blocksMayChange(setPriority(id, p, assignTo))
  )
  ipcMain.handle('tasks:setCompleted', (_e, id: string, done: boolean) =>
    blocksMayChange(setCompleted(id, done))
  )
  ipcMain.handle('tasks:schedule', (_e, id: string, at: string | null) =>
    blocksMayChange(scheduleTask(id, at))
  )
  ipcMain.handle('tasks:setDuration', (_e, id: string, minutes: number) =>
    blocksMayChange(setDuration(id, minutes))
  )
  ipcMain.handle('tasks:delete', (_e, id: string) => blocksMayChange(deleteTask(id)))
  ipcMain.handle('tasks:get', (_e, id: string) => getTaskDetail(id))
  ipcMain.handle('tasks:update', (_e, id: string, patch: TaskUpdate) =>
    blocksMayChange(updateTask(id, patch))
  )
  ipcMain.handle('links:add', (_e, taskId: string, url: string) => addLink(taskId, url))
  ipcMain.handle('links:remove', (_e, id: string) => removeLink(id))
  ipcMain.handle('activity:addComment', (_e, taskId: string, text: string) =>
    addActivity(ACTIVITY.comment, text, taskId)
  )
  ipcMain.handle('activity:list', (_e, limit?: number) => listActivity(limit))
  ipcMain.handle('activity:addNote', (_e, text: string) => addActivity(ACTIVITY.note, text))
  ipcMain.handle('days:recordToday', () => recordToday())

  ipcMain.handle('backup:info', () => backupInfo())
  ipcMain.handle('backup:chooseFolder', async () => {
    const r = await showOpen({
      title: 'Choose a backup folder',
      defaultPath: getSettings().backup_dir ?? app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (!r.canceled && r.filePaths[0]) updateSettings({ backup_dir: r.filePaths[0] })
    return backupInfo()
  })
  ipcMain.handle('backup:disable', () => {
    updateSettings({ backup_dir: null })
    return backupInfo()
  })
  ipcMain.handle('backup:setKeep', (_e, keep: number) => {
    updateSettings({ backup_keep: Math.max(1, Math.min(365, Math.floor(keep) || 14)) })
    return backupInfo()
  })
  ipcMain.handle('backup:now', async (): Promise<BackupResult> => {
    const s = getSettings()
    if (!s.backup_dir)
      return { ok: false, needsFolder: true, message: 'Choose a backup folder first' }
    try {
      return { ok: true, message: `Backed up to ${await backupNow(s.backup_dir, s.backup_keep)}` }
    } catch (e) {
      recordBackupError(errorMessage(e))
      return { ok: false, message: `Backup failed: ${errorMessage(e)}` }
    }
  })
  ipcMain.handle('backup:restore', async (): Promise<BackupResult> => {
    const picked = await showOpen({
      title: 'Choose a backup to restore',
      defaultPath: getSettings().backup_dir ?? app.getPath('documents'),
      properties: ['openFile'],
      filters: [{ name: 'Open Day Plan backup', extensions: ['db'] }]
    })
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return { ok: false, message: 'Cancelled' }
    const v = validateBackup(file)
    if (!v.ok) return { ok: false, message: v.error }
    const options = {
      type: 'warning' as const,
      buttons: ['Restore and restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Replace your current data with this backup?',
      detail:
        'A safety copy of your current data is saved first. Integration tokens are tied to this Mac, so a backup made elsewhere means re-entering them.'
    }
    const w = getMainWindow()
    const choice = w
      ? await dialog.showMessageBox(w, options)
      : await dialog.showMessageBox(options)
    if (choice.response !== 0) return { ok: false, message: 'Cancelled' }
    try {
      await restoreBackup(file, app.getPath('userData'))
    } catch (e) {
      return { ok: false, message: `Restore failed: ${errorMessage(e)}` }
    }
    app.relaunch()
    app.exit(0)
    return { ok: true, message: 'Restoring… the app is restarting' }
  })
  ipcMain.handle('backup:exportJson', () =>
    exportToFile('JSON', 'json', () => JSON.stringify(exportData(), null, 2))
  )
  ipcMain.handle('backup:exportMarkdown', () =>
    exportToFile('Markdown', 'md', () => exportMarkdown())
  )
  ipcMain.handle('capture:submit', (_e, text: string, hint?: CaptureHint) => {
    const result = submitCapture(text, hint)
    if (result) broadcastDataChanged()
    return blocksMayChange(result)
  })
  ipcMain.handle('capture:hide', () => hideCapture())
  ipcMain.handle('capture:hotkeyStatus', () => getHotkeyStatus())
  ipcMain.handle('standup:get', (_e, context: Context) => buildStandup(context))
  ipcMain.handle('review:get', () => getReview())
  ipcMain.handle('review:apply', (_e, actions: ReviewAction[]) =>
    blocksMayChange(applyReview(actions))
  )
  ipcMain.handle('links:preview', (_e, url: string, force?: boolean) => getPreview(url, force))

  ipcMain.handle('integrations:list', () => listIntegrations())
  ipcMain.handle('integrations:save', (_e, input: IntegrationInput) =>
    blocksMayChange(saveIntegration(input))
  )
  ipcMain.handle('integrations:remove', (_e, id: string) => blocksMayChange(removeIntegration(id)))
  ipcMain.handle('integrations:test', async (_e, id: string): Promise<TestOutcome> => {
    try {
      const result = await testProvider(getRecord(id))
      if (result.configPatch) patchConfig(id, result.configPatch)
      setSyncStatus(id, { error: null })
      return { ok: true, message: result.message }
    } catch (e) {
      setSyncStatus(id, { error: errorMessage(e) })
      return { ok: false, message: errorMessage(e) }
    }
  })
  ipcMain.handle('integrations:syncNow', async (_e, id: string) => {
    await runSync(id)
    broadcastDataChanged()
  })
  ipcMain.handle('integrations:googleConnect', async (_e, id: string): Promise<TestOutcome> => {
    try {
      await connectGoogle(id)
      setSyncStatus(id, { error: null })
      return { ok: true, message: 'Connected to Google' }
    } catch (e) {
      return { ok: false, message: errorMessage(e) }
    }
  })
  ipcMain.handle(
    'integrations:listCalendars',
    async (_e, id: string): Promise<CalendarListResult> => {
      try {
        return { ok: true, calendars: await listCalendarsProvider(getRecord(id)) }
      } catch (e) {
        return { ok: false, message: errorMessage(e) }
      }
    }
  )

  ipcMain.handle('external:list', async (_e, id: string): Promise<ExternalListResult> => {
    try {
      return { ok: true, items: await listExternal(id) }
    } catch (e) {
      return { ok: false, message: errorMessage(e) }
    }
  })
  ipcMain.handle(
    'external:jiraSubtasks',
    async (_e, taskId: string): Promise<JiraSubtasksResult> => {
      try {
        return await listJiraSubtasks(taskId)
      } catch (e) {
        return { ok: false, message: errorMessage(e) }
      }
    }
  )
  ipcMain.handle(
    'external:addJiraSubtasks',
    (
      _e,
      taskId: string,
      integrationId: string,
      items: Pick<ExternalIssue, 'external_id' | 'key' | 'title' | 'url' | 'due_date'>[]
    ) => addJiraSubtasks(taskId, integrationId, items)
  )
  ipcMain.handle(
    'external:addAsTask',
    (
      _e,
      id: string,
      item: Pick<ExternalIssue, 'external_id' | 'key' | 'title' | 'url'> &
        Partial<Pick<ExternalIssue, 'due_date'>>,
      context: Context
    ) => addExternalAsTask(id, item, context)
  )
  ipcMain.handle(
    'calendar:events',
    (_e, context: Context, day: string, dayStart: string, dayEnd: string) =>
      listEvents(context, day, dayStart, dayEnd)
  )
}

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Api, UiAction } from '../shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args)

const api: Api = {
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch)
  },
  tasks: {
    list: (q) => invoke('tasks:list', q),
    create: (input) => invoke('tasks:create', input),
    backlog: (context) => invoke('tasks:backlog', context),
    get: (id) => invoke('tasks:get', id),
    delete: (id) => invoke('tasks:delete', id),
    update: (id, patch) => invoke('tasks:update', id, patch),
    setPriority: (id, p, assignTo) => invoke('tasks:setPriority', id, p, assignTo),
    setCompleted: (id, done) => invoke('tasks:setCompleted', id, done),
    schedule: (id, at) => invoke('tasks:schedule', id, at),
    setDuration: (id, minutes) => invoke('tasks:setDuration', id, minutes)
  },
  links: {
    add: (taskId, url) => invoke('links:add', taskId, url),
    remove: (id) => invoke('links:remove', id),
    preview: (url, force) => invoke('links:preview', url, force)
  },
  activity: {
    list: (limit) => invoke('activity:list', limit),
    addNote: (text) => invoke('activity:addNote', text),
    addComment: (taskId, text) => invoke('activity:addComment', taskId, text)
  },
  days: {
    recordToday: () => invoke('days:recordToday')
  },
  integrations: {
    list: () => invoke('integrations:list'),
    save: (input) => invoke('integrations:save', input),
    remove: (id) => invoke('integrations:remove', id),
    test: (id) => invoke('integrations:test', id),
    syncNow: (id) => invoke('integrations:syncNow', id),
    googleConnect: (id) => invoke('integrations:googleConnect', id),
    listCalendars: (id) => invoke('integrations:listCalendars', id)
  },
  external: {
    list: (id) => invoke('external:list', id),
    jiraSubtasks: (taskId) => invoke('external:jiraSubtasks', taskId),
    addJiraSubtasks: (taskId, integrationId, items) =>
      invoke('external:addJiraSubtasks', taskId, integrationId, items),
    addAsTask: (id, item, context) => invoke('external:addAsTask', id, item, context)
  },
  calendar: {
    events: (context, day, dayStart, dayEnd) =>
      invoke('calendar:events', context, day, dayStart, dayEnd)
  },
  backup: {
    info: () => invoke('backup:info'),
    chooseFolder: () => invoke('backup:chooseFolder'),
    disable: () => invoke('backup:disable'),
    setKeep: (keep) => invoke('backup:setKeep', keep),
    now: () => invoke('backup:now'),
    restore: () => invoke('backup:restore'),
    exportJson: () => invoke('backup:exportJson'),
    exportMarkdown: () => invoke('backup:exportMarkdown')
  },
  capture: {
    submit: (text, hint) => invoke('capture:submit', text, hint),
    hide: () => invoke('capture:hide'),
    hotkeyStatus: () => invoke('capture:hotkeyStatus')
  },
  standup: {
    get: (context) => invoke('standup:get', context)
  },
  review: {
    get: () => invoke('review:get'),
    apply: (actions) => invoke('review:apply', actions)
  },
  onOpen: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, action: UiAction): void => cb(action)
    ipcRenderer.on('ui:open', handler)
    return () => {
      ipcRenderer.removeListener('ui:open', handler)
    }
  },
  onCaptureFocus: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('capture:focus', handler)
    return () => {
      ipcRenderer.removeListener('capture:focus', handler)
    }
  },
  onDataChanged: (cb) => {
    const handler = (): void => cb()
    ipcRenderer.on('data:changed', handler)
    return () => {
      ipcRenderer.removeListener('data:changed', handler)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

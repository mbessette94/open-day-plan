import { createRateLimiter, parseUrlAction } from '../shared/urlScheme'
import type { UiAction } from '../shared/types'
import { getTaskDetail } from './db/tasks'
import { submitCapture, submitNote } from './capture'

export interface UrlDeps {
  showCapture: () => void
  openUi: (a: UiAction) => void
  notify: (message: string) => void // small confirmation, e.g. an OS notification
  changed: () => void // tell windows to refetch
}

// any web page can open an opendayplan:// link, so cap how fast they can write
const allow = createRateLimiter(20, 60_000)

/** Handle an opendayplan:// URL. Returns true if it did something. */
export function handleUrl(url: string, deps: UrlDeps): boolean {
  const action = parseUrlAction(url)
  if (!action) return false
  if (action.type === 'capture') {
    deps.showCapture()
    return true
  }
  if (action.type === 'open') {
    try {
      getTaskDetail(action.id)
    } catch {
      return false // no such task
    }
    deps.openUi({ type: 'task', id: action.id })
    return true
  }
  if (!allow()) return false
  const result =
    action.type === 'note'
      ? submitNote(action.text, 'url')
      : submitCapture(
          action.text.startsWith('+') ? action.text : `+ ${action.text}`,
          undefined,
          'url'
        )
  if (!result) return false
  deps.changed()
  deps.notify(`${result.kind === 'task' ? 'Added task' : 'Logged note'}: ${result.label}`)
  return true
}

import { ACTIVITY } from '../shared/activity'
import { parseCapture, type Capture } from '../shared/capture'
import type { CaptureHint, CaptureResult } from '../shared/types'
import { addActivity } from './db/activity'
import { getDb } from './db'
import { getSettings } from './db/settings'
import { createTask, scheduleTask, setPriority, updateTask } from './db/tasks'

export type CaptureSource = 'app' | 'url'

/** Write a parsed capture: a log note, or a task with its priority, schedule and due date. */
export function applyCapture(c: Capture, source: CaptureSource = 'app'): CaptureResult {
  return getDb().transaction((): CaptureResult => {
    if (c.kind === 'note') {
      addActivity(
        ACTIVITY.note,
        source === 'url' ? `${c.text} (via URL)` : c.text,
        null,
        source === 'url' ? { source } : null
      )
      return { kind: 'note', label: c.text }
    }
    const task = createTask({ context: c.context, title: c.title, assigned_date: c.assigned_date })
    if (c.priority !== null) setPriority(task.id, c.priority)
    if (c.scheduled_at) scheduleTask(task.id, c.scheduled_at)
    if (c.due_date) updateTask(task.id, { due_date: c.due_date })
    if (source === 'url') {
      addActivity(ACTIVITY.captureViaUrl, `Added '${c.title}' via URL`, task.id, { source })
    }
    return { kind: 'task', label: c.title }
  })()
}

/** Parse and save quick-capture text. Plain text is a note; a leading + makes a task. */
export function submitCapture(
  text: string,
  hint?: CaptureHint,
  source: CaptureSource = 'app',
  now = new Date()
): CaptureResult | null {
  const parsed = parseCapture(text, now, getSettings(), hint ?? {})
  return parsed ? applyCapture(parsed, source) : null
}

/** Save text as a note even if it starts with "+". */
export function submitNote(text: string, source: CaptureSource = 'app'): CaptureResult | null {
  const t = text.trim()
  return t ? applyCapture({ kind: 'note', text: t }, source) : null
}

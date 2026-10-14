import { useCallback, useEffect, useState } from 'react'
import { describeRule } from '../../../shared/recurrence'
import {
  WEEKDAYS,
  type Priority,
  type RecurrenceRule,
  type Task,
  type TaskDetail,
  type Weekday
} from '../../../shared/types'
import { JiraSubtasks } from './JiraSubtasks'
import { LinkBadge } from './LinkBadge'

interface Props {
  taskId: string
  timezone: string
  onOpen: (id: string) => void // navigate to another task (e.g. a subtask or the parent)
  onChanged: () => void // tell the app to refresh its lists
  onClose: () => void
  // finds the earliest free slot for a task on the tab's day; null when nothing fits
  onFindSlot?: (task: Task) => string | null
  slotLabel?: string // e.g. "Wed, Oct 14", the day onFindSlot looks at
}

const PRIORITY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Backlog' },
  { value: '3', label: 'Do immediately' },
  { value: '2', label: 'Decide when' },
  { value: '1', label: 'Delegate' },
  { value: '0', label: 'Do later' }
]

type RepeatKind = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
const MON_TO_FRI: Weekday[] = ['mo', 'tu', 'we', 'th', 'fr']

function repeatKind(r: RecurrenceRule | null): RepeatKind {
  if (!r) return 'none'
  if (r.freq !== 'weekly') return r.freq
  const isWeekdays =
    r.interval === 1 && r.byday?.length === 5 && MON_TO_FRI.every((d) => r.byday!.includes(d))
  return isWeekdays ? 'weekdays' : 'weekly'
}

function RepeatSection({
  rule,
  onChange
}: {
  rule: RecurrenceRule | null
  onChange: (r: RecurrenceRule | null) => void
}): React.JSX.Element {
  const kind = repeatKind(rule)
  const interval = rule?.interval ?? 1
  const setKind = (k: RepeatKind): void => {
    if (k === 'none') onChange(null)
    else if (k === 'weekdays') onChange({ freq: 'weekly', interval: 1, byday: MON_TO_FRI })
    else if (k === 'weekly') {
      onChange({ freq: 'weekly', interval, byday: kind === 'weekly' ? rule?.byday : undefined })
    } else onChange({ freq: k, interval })
  }
  const toggleDay = (d: Weekday): void => {
    if (!rule) return
    const days = rule.byday ?? []
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d]
    onChange({ ...rule, byday: next.length ? next : undefined })
  }
  const unit = kind === 'daily' ? 'day(s)' : kind === 'weekly' ? 'week(s)' : 'month(s)'
  return (
    <section>
      <h3>Repeat</h3>
      <select value={kind} onChange={(e) => setKind(e.target.value as RepeatKind)}>
        <option value="none">Does not repeat</option>
        <option value="daily">Daily</option>
        <option value="weekdays">Every weekday</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
      {rule && kind !== 'weekdays' && (
        <label className="toggle">
          Every
          <input
            type="number"
            min={1}
            max={365}
            value={interval}
            style={{ width: 60 }}
            onChange={(e) => {
              const n = Math.max(1, Math.min(365, Math.floor(Number(e.target.value)) || 1))
              onChange({ ...rule, interval: n })
            }}
          />
          {unit}
        </label>
      )}
      {kind === 'weekly' && rule && (
        <div className="days">
          {WEEKDAYS.map((d) => (
            <button
              key={d}
              className={rule.byday?.includes(d) ? 'on' : ''}
              onClick={() => toggleDay(d)}
            >
              {d}
            </button>
          ))}
        </div>
      )}
      {rule && (
        <small className="hint">
          {describeRule(rule)}. Completing the task creates the next one
          {kind === 'weekly' && !rule.byday ? ' (same weekday).' : '.'}
        </small>
      )}
    </section>
  )
}

export function TaskEditor({
  taskId,
  timezone,
  onOpen,
  onChanged,
  onClose,
  onFindSlot,
  slotLabel
}: Props): React.JSX.Element | null {
  const [slotNote, setSlotNote] = useState<string | null>(null)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [subtaskText, setSubtaskText] = useState('')
  const [commentText, setCommentText] = useState('')
  const [linkText, setLinkText] = useState('')
  const [linkError, setLinkError] = useState(false)

  const reload = useCallback(async () => {
    setDetail(await window.api.tasks.get(taskId))
  }, [taskId])

  // load the task and reset the drafts whenever we navigate to a different one
  useEffect(() => {
    let cancelled = false
    window.api.tasks.get(taskId).then((d) => {
      if (cancelled) return
      setDetail(d)
      setTitle(d.task.title)
      setDescription(d.task.description)
      setSubtaskText('')
      setCommentText('')
      setLinkText('')
      setLinkError(false)
    })
    return () => {
      cancelled = true
    }
  }, [taskId])

  const mutate = async (fn: () => Promise<unknown>): Promise<void> => {
    await fn()
    await reload()
    onChanged()
  }

  /** Save pending title/description edits. */
  const flush = async (): Promise<void> => {
    if (!detail) return
    const patch: { title?: string; description?: string } = {}
    if (title.trim() && title.trim() !== detail.task.title) patch.title = title
    if (description !== detail.task.description) patch.description = description
    if (Object.keys(patch).length) await mutate(() => window.api.tasks.update(taskId, patch))
  }

  const close = async (): Promise<void> => {
    await flush()
    onClose()
  }

  const remove = async (): Promise<void> => {
    if (!detail) return
    const n = detail.subtasks.length
    const extra = n ? ` and its ${n} subtask${n === 1 ? '' : 's'}` : ''
    if (!window.confirm(`Delete '${detail.task.title}'${extra}? This can't be undone.`)) return
    const parent = detail.task.parent
    await window.api.tasks.delete(taskId)
    onChanged()
    if (parent) onOpen(parent)
    else onClose()
  }

  const navigate = async (id: string): Promise<void> => {
    await flush()
    onOpen(id)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, detail])

  if (!detail) return null
  const { task } = detail
  const fmt = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  const addLink = async (): Promise<void> => {
    if (!linkText.trim()) return
    try {
      await mutate(() => window.api.links.add(taskId, linkText))
      setLinkText('')
      setLinkError(false)
    } catch {
      setLinkError(true)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={close}>
      <div className="editor" onClick={(e) => e.stopPropagation()}>
        <div className="editor-head">
          {task.parent && (
            <button onClick={() => navigate(task.parent!)} title="Back to parent task">
              ← Parent
            </button>
          )}
          <input
            type="checkbox"
            checked={task.completed_at !== null}
            onChange={() =>
              mutate(() => window.api.tasks.setCompleted(taskId, task.completed_at === null))
            }
          />
          <input
            className="editor-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={flush}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          {task.is_project && <span className="pill">Project</span>}
          <button className="danger" onClick={remove}>
            Delete
          </button>
          <button onClick={close}>Close</button>
        </div>

        <div className="editor-body">
          <div className="editor-main">
            <section>
              <h3>Description</h3>
              <textarea
                value={description}
                placeholder="Add a description…"
                onChange={(e) => setDescription(e.target.value)}
                onBlur={flush}
              />
            </section>

            {!task.parent && (
              <section>
                <h3>
                  Subtasks{' '}
                  {detail.subtasks.length > 0 && (
                    <small>
                      {detail.subtasks.filter((s) => s.completed_at).length}/
                      {detail.subtasks.length}
                    </small>
                  )}
                </h3>
                {task.is_project && (
                  <small className="hint">
                    Subtasks of a project can be prioritized and scheduled.
                  </small>
                )}
                {detail.subtasks.map((s) => (
                  <div key={s.id} className={`subtask${s.completed_at ? ' done' : ''}`}>
                    <input
                      type="checkbox"
                      checked={s.completed_at !== null}
                      onChange={() =>
                        mutate(() => window.api.tasks.setCompleted(s.id, s.completed_at === null))
                      }
                    />
                    <button className="linkish" onClick={() => navigate(s.id)}>
                      {s.title}
                    </button>
                    {task.is_project && (
                      <>
                        {s.scheduled_at && (
                          <span className="muted">
                            {new Intl.DateTimeFormat(undefined, {
                              timeZone: timezone,
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit'
                            }).format(new Date(s.scheduled_at))}
                          </span>
                        )}
                        <select
                          value={s.priority === null ? '' : String(s.priority)}
                          onChange={(e) =>
                            mutate(() =>
                              window.api.tasks.setPriority(
                                s.id,
                                e.target.value === '' ? null : (Number(e.target.value) as Priority)
                              )
                            )
                          }
                        >
                          {PRIORITY_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                ))}
                <input
                  className="field"
                  value={subtaskText}
                  placeholder="Add a subtask and press Enter"
                  onChange={(e) => setSubtaskText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || !subtaskText.trim()) return
                    const text = subtaskText.trim()
                    setSubtaskText('')
                    mutate(() =>
                      window.api.tasks.create({
                        context: task.context,
                        title: text,
                        assigned_date: null,
                        parent: taskId
                      })
                    )
                  }}
                />
              </section>
            )}

            {!task.parent && (
              <JiraSubtasks
                taskId={taskId}
                linkKey={detail.links.map((l) => l.id).join(',')}
                onAdded={async () => {
                  await reload()
                  onChanged()
                }}
              />
            )}

            <section>
              <h3>Activity</h3>
              <input
                className="field"
                value={commentText}
                placeholder="Add a comment and press Enter"
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !commentText.trim()) return
                  const text = commentText.trim()
                  setCommentText('')
                  mutate(() => window.api.activity.addComment(taskId, text))
                }}
              />
              <div className="activity">
                {detail.activity.map((a) => (
                  <div key={a.id} className={`entry ${a.type === 'comment' ? 'comment' : 'event'}`}>
                    <span className="time">{fmt.format(new Date(a.created_at))}</span>
                    <span className="text">
                      {a.action_taken}
                      {a.ref_id !== taskId && a.type === 'comment' && a.ref_title && (
                        <small> on &lsquo;{a.ref_title}&rsquo;</small>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <aside className="editor-side">
            {!task.parent && (
              <section>
                <h3>Project</h3>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={task.is_project}
                    onChange={(e) =>
                      mutate(() =>
                        window.api.tasks.update(taskId, { is_project: e.target.checked })
                      )
                    }
                  />
                  Epic / project
                </label>
                <small className="hint">
                  {task.is_project
                    ? 'Subtasks are full tasks: they show up in the backlog and can be prioritized and scheduled.'
                    : 'Turn on to let subtasks be prioritized and scheduled on their own.'}
                </small>
              </section>
            )}
            {onFindSlot && task.completed_at === null && (
              <section>
                <h3>Schedule</h3>
                {task.scheduled_at && (
                  <div className="row">
                    <span>
                      {new Intl.DateTimeFormat(undefined, {
                        timeZone: timezone,
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      }).format(new Date(task.scheduled_at))}
                    </span>
                    <button onClick={() => mutate(() => window.api.tasks.schedule(taskId, null))}>
                      Clear
                    </button>
                  </div>
                )}
                <button
                  onClick={async () => {
                    const at = onFindSlot(task)
                    if (!at) {
                      setSlotNote(
                        `No free ${task.duration_min} min gap on ${slotLabel ?? 'this day'}`
                      )
                      return
                    }
                    try {
                      await mutate(() => window.api.tasks.schedule(taskId, at))
                      setSlotNote(null)
                    } catch {
                      setSlotNote('Only subtasks of a project can be scheduled')
                    }
                  }}
                >
                  Next free slot
                </button>
                <small className="hint">
                  {slotNote ??
                    `Books the first open ${task.duration_min} min gap on ${slotLabel ?? 'this day'}.`}
                </small>
              </section>
            )}

            {!task.parent && (
              <RepeatSection
                rule={task.recurrence}
                onChange={(r) => mutate(() => window.api.tasks.update(taskId, { recurrence: r }))}
              />
            )}

            <section>
              <h3>Due date</h3>
              <div className="row">
                <input
                  type="date"
                  value={task.due_date ?? ''}
                  onChange={(e) =>
                    mutate(() =>
                      window.api.tasks.update(taskId, { due_date: e.target.value || null })
                    )
                  }
                />
                {task.due_date && (
                  <button
                    onClick={() =>
                      mutate(() => window.api.tasks.update(taskId, { due_date: null }))
                    }
                  >
                    Clear
                  </button>
                )}
              </div>
            </section>

            <section>
              <h3>Links</h3>
              <div className="badges">
                {detail.links.map((l) => (
                  <LinkBadge
                    key={l.id}
                    url={l.url}
                    force
                    onRemove={() => mutate(() => window.api.links.remove(l.id))}
                  />
                ))}
              </div>
              <input
                className="field"
                value={linkText}
                placeholder="Paste a Jira, Linear or GitHub link"
                onChange={(e) => {
                  setLinkText(e.target.value)
                  setLinkError(false)
                }}
                onKeyDown={(e) => e.key === 'Enter' && addLink()}
              />
              {linkError && (
                <span className="error">
                  Couldn&rsquo;t add that link: use a full http(s) URL that isn&rsquo;t already
                  attached
                </span>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}

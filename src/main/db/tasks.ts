import { v7 as uuidv7 } from 'uuid'
import { ACTIVITY } from '../../shared/activity'
import { describeRule, nextOccurrence, normalizeRule, parseRule } from '../../shared/recurrence'
import { hhmm, localDay, localMinutes, zonedInstant } from '../../shared/time'
import type {
  Context,
  Priority,
  Task,
  TaskCreate,
  TaskDetail,
  TaskLink,
  TaskListQuery,
  TaskUpdate
} from '../../shared/types'
import { addActivity, listActivityFor } from './activity'
import { getDb } from './index'
import { getSettings } from './settings'

const QUADRANT_LABEL: Record<Priority, string> = {
  3: 'Do immediately',
  2: 'Decide when to do',
  1: 'Delegate',
  0: 'Do later'
}

const TASK_SELECT = `SELECT t.*,
  (SELECT p.title FROM task p WHERE p.id = t.parent) AS parent_title,
  (SELECT COUNT(*) FROM task s WHERE s.parent = t.id) AS subtask_total,
  (SELECT COUNT(*) FROM task s WHERE s.parent = t.id AND s.completed_at IS NOT NULL) AS subtask_done
  FROM task t`

type TaskRow = Omit<Task, 'is_project' | 'recurrence'> & {
  is_project: number
  recurrence: string | null
}

function toTask(row: TaskRow): Task {
  return { ...row, is_project: row.is_project !== 0, recurrence: parseRule(row.recurrence) }
}

function getTask(id: string): Task {
  const row = getDb().prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined
  if (!row) throw new Error(`Task not found: ${id}`)
  return toTask(row)
}

/** Subtasks are only prioritizable/schedulable when their parent is a project. */
function assertPlannable(t: Task): void {
  if (t.parent && !getTask(t.parent).is_project) {
    throw new Error('Only subtasks of a project can be prioritized or scheduled')
  }
}

// Top-level tasks, plus subtasks of projects (which behave as full tasks).
const LISTABLE = `(t.parent IS NULL OR EXISTS (SELECT 1 FROM task p WHERE p.id = t.parent AND p.is_project = 1))`

/**
 * Tasks for one day's lists. Two disjoint branches so each can use its own index: open tasks
 * (assigned to the day, plus, optionally, carried over from earlier days or never assigned) and,
 * optionally, tasks completed during the day.
 */
export function listTasks(q: TaskListQuery): Task[] {
  return (
    getDb()
      .prepare(
        `WITH picked(id) AS (
           SELECT t.id FROM task t
           WHERE ${LISTABLE} AND t.context = @context AND t.completed_at IS NULL
             AND (t.assigned_date = @day
                  OR (@carry = 1 AND (t.assigned_date IS NULL OR t.assigned_date < @day)))
           UNION ALL
           SELECT t.id FROM task t
           WHERE @completed = 1 AND ${LISTABLE} AND t.context = @context
             AND t.completed_at >= @dayStart AND t.completed_at < @dayEnd
         )
         ${TASK_SELECT}
         WHERE t.id IN (SELECT id FROM picked)
         ORDER BY t.created_at, t.id`
      )
      .all({
        context: q.context,
        day: q.day,
        dayStart: q.dayStart,
        dayEnd: q.dayEnd,
        carry: q.includeCarryover ? 1 : 0,
        completed: q.includeCompleted ? 1 : 0
      }) as TaskRow[]
  ).map(toTask)
}

/** Open, unprioritized tasks for a context, regardless of day. */
export function listBacklog(context: Context): Task[] {
  return (
    getDb()
      .prepare(
        `${TASK_SELECT}
         WHERE ${LISTABLE} AND t.context = ? AND t.priority IS NULL AND t.completed_at IS NULL
         ORDER BY t.created_at, t.id`
      )
      .all(context) as TaskRow[]
  ).map(toTask)
}

export function createTask(input: TaskCreate): Task {
  const db = getDb()
  const now = new Date().toISOString()
  const parent = input.parent ? getTask(input.parent) : null
  const id = uuidv7()
  db.transaction(() => {
    db.prepare(
      `INSERT INTO task (id, parent, context, title, assigned_date, created_at, updated_at)
       VALUES (@id, @parent, @context, @title, @assigned_date, @now, @now)`
    ).run({
      id,
      parent: parent?.id ?? null,
      context: parent?.context ?? input.context,
      title: input.title,
      assigned_date: input.assigned_date,
      now
    })
    addActivity(
      ACTIVITY.taskCreated,
      parent
        ? `Created subtask '${input.title}' under '${parent.title}'`
        : `Created '${input.title}'`,
      id,
      parent ? { parent: parent.id } : null
    )
  })()
  return getTask(id)
}

/** Set (or clear, with null) the Eisenhower quadrant. `assignDate` also moves the task onto that day. */
export function setPriority(id: string, priority: Priority | null, assignDate?: string): void {
  const db = getDb()
  db.transaction(() => {
    const t = getTask(id)
    if (priority !== null) assertPlannable(t)
    if (t.priority === priority) return
    db.prepare('UPDATE task SET priority = ?, assigned_date = ? WHERE id = ?').run(
      priority,
      assignDate ?? t.assigned_date,
      id
    )
    const dest = priority === null ? 'Backlog' : QUADRANT_LABEL[priority]
    addActivity(ACTIVITY.taskMoved, `Moved '${t.title}' → ${dest}`, id, {
      from: t.priority,
      to: priority
    })
  })()
}

export function setCompleted(id: string, completed: boolean): void {
  const db = getDb()
  db.transaction(() => {
    const t = getTask(id)
    db.prepare('UPDATE task SET completed_at = ? WHERE id = ?').run(
      completed ? new Date().toISOString() : null,
      id
    )
    addActivity(
      completed ? ACTIVITY.taskCompleted : ACTIVITY.taskReopened,
      `${completed ? 'Completed' : 'Reopened'} '${t.title}'`,
      id
    )
    if (completed && t.completed_at === null && t.recurrence) spawnNextOccurrence(t)
  })()
}

/**
 * Create the next occurrence of a repeating task. The rule moves to the new task, so completing
 * or reopening the old one can never create a second copy.
 */
function spawnNextOccurrence(t: Task): void {
  const db = getDb()
  const tz = getSettings().timezone
  const today = localDay(new Date(), tz)
  const anchor =
    t.due_date ??
    (t.scheduled_at ? localDay(new Date(t.scheduled_at), tz) : (t.assigned_date ?? today))
  const next = nextOccurrence(t.recurrence!, anchor, today)
  // keep the time of day, move to the next date
  const scheduled = t.scheduled_at
    ? zonedInstant(next, hhmm(localMinutes(new Date(t.scheduled_at), tz)), tz)
    : null

  const insert = db.prepare(
    `INSERT INTO task (id, parent, context, title, description, priority, assigned_date, scheduled_at,
       duration_min, due_date, is_project, recurrence, created_at, updated_at)
     VALUES (@id, @parent, @context, @title, @description, @priority, @assigned_date, @scheduled_at,
       @duration_min, @due_date, @is_project, @recurrence, @now, @now)`
  )
  const now = new Date().toISOString()
  const id = uuidv7()
  insert.run({
    id,
    parent: null,
    context: t.context,
    title: t.title,
    description: t.description,
    priority: t.priority,
    assigned_date: scheduled || t.assigned_date ? next : null,
    scheduled_at: scheduled,
    duration_min: t.duration_min,
    due_date: t.due_date ? next : null,
    is_project: t.is_project ? 1 : 0,
    recurrence: JSON.stringify(t.recurrence),
    now
  })

  const links = db.prepare('SELECT url FROM task_link WHERE task_id = ?').all(t.id) as {
    url: string
  }[]
  for (const l of links) {
    db.prepare('INSERT INTO task_link (id, task_id, url, created_at) VALUES (?, ?, ?, ?)').run(
      uuidv7(),
      id,
      l.url,
      now
    )
  }
  // subtasks come back as a fresh, incomplete checklist with no planning data
  const children = db
    .prepare(
      'SELECT context, title, description, duration_min FROM task WHERE parent = ? ORDER BY created_at, id'
    )
    .all(t.id) as Pick<Task, 'context' | 'title' | 'description' | 'duration_min'>[]
  for (const c of children) {
    insert.run({
      id: uuidv7(),
      parent: id,
      context: c.context,
      title: c.title,
      description: c.description,
      priority: null,
      assigned_date: null,
      scheduled_at: null,
      duration_min: c.duration_min,
      due_date: null,
      is_project: 0,
      recurrence: null,
      now
    })
  }

  db.prepare('UPDATE task SET recurrence = NULL WHERE id = ?').run(t.id)
  addActivity(
    ACTIVITY.taskRepeated,
    `Repeats (${describeRule(t.recurrence!)}): next '${t.title}' is on ${next}`,
    id,
    { previous: t.id, date: next }
  )
}

/** Schedule a task into a time slot (also moves it to that day), or clear its slot with null. */
export function scheduleTask(id: string, at: string | null): void {
  const db = getDb()
  db.transaction(() => {
    const t = getTask(id)
    if (at !== null) assertPlannable(t)
    if (t.scheduled_at === at) return
    if (at === null) {
      db.prepare('UPDATE task SET scheduled_at = NULL WHERE id = ?').run(id)
      addActivity(ACTIVITY.taskUnscheduled, `Unscheduled '${t.title}'`, id)
      return
    }
    const tz = getSettings().timezone
    db.prepare('UPDATE task SET scheduled_at = ?, assigned_date = ? WHERE id = ?').run(
      at,
      localDay(new Date(at), tz),
      id
    )
    const when = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(at))
    addActivity(ACTIVITY.taskScheduled, `Scheduled '${t.title}' for ${when}`, id, { at })
  })()
}

export function setDuration(id: string, minutes: number): void {
  const db = getDb()
  const mins = Math.min(1440, Math.max(15, Math.round(minutes / 15) * 15))
  db.transaction(() => {
    const t = getTask(id)
    if (t.duration_min === mins) return
    db.prepare('UPDATE task SET duration_min = ? WHERE id = ?').run(mins, id)
    addActivity(ACTIVITY.taskDuration, `Set '${t.title}' to ${mins} min`, id, { minutes: mins })
  })()
}

export function getTaskDetail(id: string): TaskDetail {
  const db = getDb()
  const task = getTask(id)
  const subtasks = db
    .prepare(`${TASK_SELECT} WHERE t.parent = ? ORDER BY t.created_at, t.id`)
    .all(id) as TaskRow[]
  const links = db
    .prepare('SELECT * FROM task_link WHERE task_id = ? ORDER BY created_at, id')
    .all(id) as TaskLink[]
  return {
    task,
    subtasks: subtasks.map(toTask),
    links,
    activity: listActivityFor([id, ...subtasks.map((s) => s.id)])
  }
}

export function updateTask(id: string, patch: TaskUpdate): void {
  const db = getDb()
  db.transaction(() => {
    const t = getTask(id)
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (title && title !== t.title) {
        db.prepare('UPDATE task SET title = ? WHERE id = ?').run(title, id)
        addActivity(ACTIVITY.taskRenamed, `Renamed '${t.title}' → '${title}'`, id, {
          from: t.title,
          to: title
        })
      }
    }
    if (patch.description !== undefined && patch.description !== t.description) {
      db.prepare('UPDATE task SET description = ? WHERE id = ?').run(patch.description, id)
      addActivity(ACTIVITY.taskDescribed, `Edited description of '${t.title}'`, id)
    }
    if (patch.recurrence !== undefined) {
      const rule = patch.recurrence === null ? null : normalizeRule(patch.recurrence)
      if (patch.recurrence !== null && !rule) throw new Error('Invalid repeat rule')
      if (rule && t.parent) throw new Error('A subtask cannot repeat')
      if (JSON.stringify(rule) !== JSON.stringify(t.recurrence)) {
        db.prepare('UPDATE task SET recurrence = ? WHERE id = ?').run(
          rule ? JSON.stringify(rule) : null,
          id
        )
        addActivity(
          ACTIVITY.taskRepeatSet,
          rule
            ? `Set '${t.title}' to repeat: ${describeRule(rule)}`
            : `Stopped repeating '${t.title}'`,
          id,
          { rule }
        )
      }
    }
    if (patch.due_date !== undefined && patch.due_date !== t.due_date) {
      db.prepare('UPDATE task SET due_date = ? WHERE id = ?').run(patch.due_date, id)
      addActivity(
        ACTIVITY.taskDue,
        patch.due_date
          ? `Set due date of '${t.title}' to ${patch.due_date}`
          : `Cleared due date of '${t.title}'`,
        id,
        { due_date: patch.due_date }
      )
    }
    if (patch.is_project !== undefined && patch.is_project !== t.is_project) {
      if (patch.is_project && t.parent) throw new Error('A subtask cannot be a project')
      db.prepare('UPDATE task SET is_project = ? WHERE id = ?').run(patch.is_project ? 1 : 0, id)
      if (!patch.is_project) {
        // its subtasks go back to being checklist items, so drop their planning data
        db.prepare('UPDATE task SET priority = NULL, scheduled_at = NULL WHERE parent = ?').run(id)
      }
      addActivity(
        ACTIVITY.taskProject,
        patch.is_project
          ? `Made '${t.title}' a project`
          : `Converted '${t.title}' back to a regular task`,
        id,
        { is_project: patch.is_project }
      )
    }
  })()
}

export function addLink(taskId: string, url: string, opts: { quiet?: boolean } = {}): void {
  const parsed = new URL(url.trim()) // throws on invalid input
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http(s) links are supported')
  }
  const db = getDb()
  db.transaction(() => {
    const t = getTask(taskId)
    const href = parsed.toString()
    const exists = db
      .prepare('SELECT 1 FROM task_link WHERE task_id = ? AND url = ?')
      .get(taskId, href)
    if (exists) throw new Error('That link is already attached to this task')
    db.prepare('INSERT INTO task_link (id, task_id, url, created_at) VALUES (?, ?, ?, ?)').run(
      uuidv7(),
      taskId,
      href,
      new Date().toISOString()
    )
    if (!opts.quiet)
      addActivity(ACTIVITY.linkAdded, `Linked ${href} to '${t.title}'`, taskId, { url: href })
  })()
}

export function removeLink(id: string): void {
  const db = getDb()
  db.transaction(() => {
    const link = db.prepare('SELECT * FROM task_link WHERE id = ?').get(id) as TaskLink | undefined
    if (!link) return
    const t = getTask(link.task_id)
    db.prepare('DELETE FROM task_link WHERE id = ?').run(id)
    addActivity(ACTIVITY.linkRemoved, `Removed link ${link.url} from '${t.title}'`, t.id, {
      url: link.url
    })
  })()
}

/**
 * Hard-delete a task. Its subtasks, links and external tracking go with it (ON DELETE CASCADE);
 * the activity log keeps its history with the reference cleared.
 */
export function deleteTask(id: string): void {
  const db = getDb()
  db.transaction(() => {
    const t = getTask(id)
    const subtasks = (
      db.prepare('SELECT COUNT(*) AS n FROM task WHERE parent = ?').get(id) as { n: number }
    ).n
    // log first, with no ref: the ref would be cleared by the delete anyway
    addActivity(
      ACTIVITY.taskDeleted,
      subtasks
        ? `Deleted '${t.title}' and ${subtasks} subtask${subtasks === 1 ? '' : 's'}`
        : `Deleted '${t.title}'`,
      null,
      { title: t.title, subtasks }
    )
    db.prepare('DELETE FROM task WHERE id = ?').run(id)
  })()
}

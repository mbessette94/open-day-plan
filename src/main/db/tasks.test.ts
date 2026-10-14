import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { localDay, addDays } from '../../shared/time'
import { listActivity } from './activity'
import { getDb, openDb } from './index'
import { updateSettings } from './settings'
import {
  addLink,
  createTask,
  deleteTask,
  getTaskDetail,
  listBacklog,
  listTasks,
  scheduleTask,
  setCompleted,
  setPriority,
  updateTask
} from './tasks'

const query = {
  context: 'work' as const,
  day: '2026-10-13',
  dayStart: '2026-10-13T00:00:00.000Z',
  dayEnd: '2026-10-14T00:00:00.000Z',
  includeCarryover: true,
  includeCompleted: true
}

describe('project subtasks', () => {
  beforeEach(() => {
    openDb(':memory:')
    updateSettings({ timezone: 'UTC' })
  })

  it('keeps subtasks of a regular task out of the lists and unplannable', () => {
    const parent = createTask({ context: 'work', title: 'parent', assigned_date: null })
    const sub = createTask({
      context: 'work',
      title: 'sub',
      assigned_date: null,
      parent: parent.id
    })
    expect(listBacklog('work').map((t) => t.title)).toEqual(['parent'])
    expect(listTasks(query).map((t) => t.title)).toEqual(['parent'])
    expect(() => setPriority(sub.id, 3)).toThrow()
    expect(() => scheduleTask(sub.id, '2026-10-13T14:00:00.000Z')).toThrow()
    expect(listBacklog('work')[0].subtask_total).toBe(1)
  })

  it('treats subtasks of a project as full tasks', () => {
    const parent = createTask({ context: 'work', title: 'epic', assigned_date: null })
    updateTask(parent.id, { is_project: true })
    const sub = createTask({
      context: 'work',
      title: 'sub',
      assigned_date: null,
      parent: parent.id
    })
    expect(
      listBacklog('work')
        .map((t) => t.title)
        .sort()
    ).toEqual(['epic', 'sub'])
    setPriority(sub.id, 3)
    scheduleTask(sub.id, '2026-10-13T14:00:00.000Z')
    const listed = listTasks(query).find((t) => t.id === sub.id)
    expect(listed).toMatchObject({ priority: 3, parent_title: 'epic' })
    expect(getTaskDetail(parent.id).task.is_project).toBe(true)
  })

  it('clears planning data when a project is turned back into a regular task', () => {
    const parent = createTask({ context: 'work', title: 'epic', assigned_date: null })
    updateTask(parent.id, { is_project: true })
    const sub = createTask({
      context: 'work',
      title: 'sub',
      assigned_date: null,
      parent: parent.id
    })
    setPriority(sub.id, 2)
    scheduleTask(sub.id, '2026-10-13T14:00:00.000Z')
    updateTask(parent.id, { is_project: false })
    const after = getTaskDetail(parent.id).subtasks[0]
    expect(after).toMatchObject({ priority: null, scheduled_at: null })
    expect(listBacklog('work').map((t) => t.title)).toEqual(['epic'])
  })

  it('does not allow a subtask to become a project', () => {
    const parent = createTask({ context: 'work', title: 'p', assigned_date: null })
    const sub = createTask({ context: 'work', title: 's', assigned_date: null, parent: parent.id })
    expect(() => updateTask(sub.id, { is_project: true })).toThrow()
  })

  it('deletes a task together with its subtasks and links, keeping the log', () => {
    const parent = createTask({ context: 'work', title: 'epic', assigned_date: null })
    updateTask(parent.id, { is_project: true })
    createTask({ context: 'work', title: 'sub', assigned_date: null, parent: parent.id })
    addLink(parent.id, 'https://example.com')
    deleteTask(parent.id)
    expect(listBacklog('work')).toEqual([])
    const db = getDb()
    expect(db.prepare('SELECT COUNT(*) AS n FROM task').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_link').get()).toEqual({ n: 0 })
    expect(listActivity().map((a) => a.action_taken)).toContain("Deleted 'epic' and 1 subtask")
  })

  it('deleting a subtask leaves its parent alone', () => {
    const parent = createTask({ context: 'work', title: 'p', assigned_date: null })
    const sub = createTask({ context: 'work', title: 's', assigned_date: null, parent: parent.id })
    deleteTask(sub.id)
    expect(getTaskDetail(parent.id).subtasks).toEqual([])
  })
})

describe('recurring tasks', () => {
  const FAR = '2099-03-10' // far-future anchor keeps these tests independent of today's date
  beforeEach(() => {
    openDb(':memory:')
    updateSettings({ timezone: 'UTC' })
  })
  const make = (title = 'Weekly report'): string =>
    createTask({ context: 'work', title, assigned_date: null }).id
  const all = (): { id: string; title: string; completed_at: string | null }[] =>
    getDb()
      .prepare(
        'SELECT id, title, completed_at FROM task WHERE parent IS NULL ORDER BY created_at, id'
      )
      .all() as never

  it('creates the next occurrence on completion and moves the rule to it', () => {
    const id = make()
    updateTask(id, { due_date: FAR, recurrence: { freq: 'weekly', interval: 1 } })
    setCompleted(id, true)
    const tasks = all()
    expect(tasks).toHaveLength(2)
    const old = getTaskDetail(id).task
    const next = getTaskDetail(tasks[1].id).task
    expect(old.recurrence).toBeNull()
    expect(next.recurrence).toEqual({ freq: 'weekly', interval: 1 })
    expect(next.due_date).toBe('2099-03-17')
    expect(next.completed_at).toBeNull()
    expect(
      listActivity().some((a) =>
        a.action_taken.startsWith("Repeats (Every week): next 'Weekly report'")
      )
    ).toBe(true)
  })

  it('does not duplicate when reopened and completed again', () => {
    const id = make()
    updateTask(id, { due_date: FAR, recurrence: { freq: 'daily', interval: 1 } })
    setCompleted(id, true)
    setCompleted(id, false)
    setCompleted(id, true)
    expect(all()).toHaveLength(2)
  })

  it('keeps priority, description, duration, links, scheduled time of day and resets subtasks', () => {
    const id = make()
    updateTask(id, {
      description: 'Do the thing',
      due_date: FAR,
      recurrence: { freq: 'daily', interval: 1 }
    })
    setPriority(id, 2)
    scheduleTask(id, `${FAR}T14:30:00.000Z`)
    addLink(id, 'https://example.com/x', { quiet: true })
    const sub = createTask({ context: 'work', title: 'step', assigned_date: null, parent: id })
    setCompleted(sub.id, true)
    setCompleted(id, true)

    const nextId = all()[1].id
    const d = getTaskDetail(nextId)
    expect(d.task).toMatchObject({ priority: 2, due_date: '2099-03-11', duration_min: 15 })
    expect(d.task.scheduled_at).toBe('2099-03-11T14:30:00.000Z')
    expect(d.task.assigned_date).toBe('2099-03-11')
    expect(d.task.description).toBe('Do the thing')
    expect(d.links.map((l) => l.url)).toEqual(['https://example.com/x'])
    expect(d.subtasks.map((s) => [s.title, s.completed_at])).toEqual([['step', null]])
  })

  it('skips missed occurrences when finished late', () => {
    const id = make()
    updateTask(id, { due_date: '2000-01-03', recurrence: { freq: 'daily', interval: 1 } })
    setCompleted(id, true)
    const today = localDay(new Date(), 'UTC')
    expect(getTaskDetail(all()[1].id).task.due_date).toBe(addDays(today, 1))
  })

  it('validates rules and refuses subtasks', () => {
    const id = make()
    expect(() => updateTask(id, { recurrence: { freq: 'daily', interval: 0 } })).toThrow('Invalid')
    const sub = createTask({ context: 'work', title: 's', assigned_date: null, parent: id })
    expect(() => updateTask(sub.id, { recurrence: { freq: 'daily', interval: 1 } })).toThrow(
      'subtask'
    )
    updateTask(id, { recurrence: { freq: 'daily', interval: 1 } })
    updateTask(id, { recurrence: null })
    expect(getTaskDetail(id).task.recurrence).toBeNull()
    setCompleted(id, true)
    expect(all()).toHaveLength(1)
  })
})

describe('v1 layout behaviours', () => {
  beforeEach(() => {
    openDb(':memory:')
    updateSettings({ timezone: 'UTC' })
  })

  const dayQuery = (day: string): Parameters<typeof listTasks>[0] => ({
    context: 'work',
    day,
    dayStart: `${day}T00:00:00.000Z`,
    dayEnd: `${day}T23:59:59.999Z`,
    includeCarryover: false,
    includeCompleted: false
  })

  it('keeps a task on its day when the timezone setting changes', () => {
    const t = createTask({ context: 'work', title: 'planned', assigned_date: '2026-10-14' })
    expect(listTasks(dayQuery('2026-10-14')).map((x) => x.id)).toEqual([t.id])
    updateSettings({ timezone: 'Pacific/Auckland' }) // a day boundary 12+ hours away
    expect(listTasks(dayQuery('2026-10-14')).map((x) => x.id)).toEqual([t.id])
    expect(listTasks(dayQuery('2026-10-15'))).toEqual([])
  })

  it('scheduling puts the task on the local date of the slot', () => {
    const t = createTask({ context: 'work', title: 'late slot', assigned_date: null })
    updateSettings({ timezone: 'America/Los_Angeles' })
    scheduleTask(t.id, '2026-10-15T03:30:00.000Z') // 20:30 on the 14th in Los Angeles
    expect(getTaskDetail(t.id).task.assigned_date).toBe('2026-10-14')
  })

  it('writes structured activity: a type, readable text, and optional data', () => {
    const t = createTask({ context: 'work', title: 'x', assigned_date: null })
    setPriority(t.id, 3)
    const moved = listActivity().find((a) => a.type === 'task.moved')
    expect(moved).toMatchObject({ ref_id: t.id, ref_title: 'x', data: { from: null, to: 3 } })
    expect(moved?.action_taken).toBe("Moved 'x' → Do immediately")
    expect(listActivity().find((a) => a.type === 'task.created')?.data).toBeNull()
  })

  it('refuses to attach the same link twice', () => {
    const t = createTask({ context: 'work', title: 'x', assigned_date: null })
    addLink(t.id, 'https://example.com/a')
    expect(() => addLink(t.id, 'https://example.com/a')).toThrow('already attached')
    expect(getTaskDetail(t.id).links).toHaveLength(1)
  })

  it('deleting a project removes its subtasks and external tracking in one statement', () => {
    const p = createTask({ context: 'work', title: 'p', assigned_date: null })
    createTask({ context: 'work', title: 's', assigned_date: null, parent: p.id })
    getDb()
      .prepare(
        "INSERT INTO integration (id, kind, name, created_at) VALUES ('i', 'jira', 'J', '2026-10-13T00:00:00.000Z')"
      )
      .run()
    getDb()
      .prepare(
        "INSERT INTO external_item (integration_id, external_id, task_id, state, created_at) VALUES ('i', 'K-1', ?, 'open', '2026-10-13T00:00:00.000Z')"
      )
      .run(p.id)
    deleteTask(p.id)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM task').get()).toEqual({ n: 0 })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM external_item').get()).toEqual({ n: 0 })
    expect(listActivity()[0]).toMatchObject({
      type: 'task.deleted',
      ref_id: null,
      data: { title: 'p', subtasks: 1 }
    })
  })
})

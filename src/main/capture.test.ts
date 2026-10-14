import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { listActivity } from './db/activity'
import { getDb, openDb } from './db'
import { updateSettings } from './db/settings'
import { getTaskDetail, listBacklog } from './db/tasks'
import { submitCapture, submitNote } from './capture'
import { handleUrl, type UrlDeps } from './urlHandler'

const wed10am = new Date('2026-10-14T17:00:00Z') // Wednesday 10:00 in Los Angeles

beforeEach(() => {
  openDb(':memory:')
  updateSettings({ timezone: 'America/Los_Angeles' })
})

describe('submitCapture', () => {
  it('logs plain text as a note', () => {
    expect(submitCapture('talked to Sam', undefined, 'app', wed10am)).toEqual({
      kind: 'note',
      label: 'talked to Sam'
    })
    expect(listActivity()[0]).toMatchObject({
      action_taken: 'talked to Sam',
      type: 'note',
      ref_id: null
    })
  })

  it('creates a task with priority, schedule and due date from the tokens', () => {
    const r = submitCapture(
      '+ !2 #personal call dentist @3pm tomorrow due:fri',
      undefined,
      'app',
      wed10am
    )
    expect(r).toEqual({ kind: 'task', label: 'call dentist' })
    // prioritised, so it is on the matrix rather than in the backlog
    const id = (getDb().prepare('SELECT id FROM task').get() as { id: string }).id
    const t = getTaskDetail(id).task
    expect(t).toMatchObject({ title: 'call dentist', priority: 2, due_date: '2026-10-16' })
    expect(t.scheduled_at).toBe('2026-10-15T22:00:00.000Z') // Thu 15:00 in LA
    expect(t.assigned_date).toBe('2026-10-15')
  })

  it('uses the caller hint for context and day', () => {
    submitCapture('+ from the tab', { context: 'personal', day: '2026-10-15' }, 'app', wed10am)
    const [t] = listBacklog('personal')
    expect(t.assigned_date).toBe('2026-10-15')
  })

  it('returns null for empty input or a task with no title', () => {
    expect(submitCapture('   ')).toBeNull()
    expect(submitCapture('+ !1 #work')).toBeNull()
    expect(listBacklog('work')).toEqual([])
  })

  it('submitNote keeps a leading + as literal text', () => {
    submitNote('+ not a task')
    expect(listActivity()[0].action_taken).toBe('+ not a task')
    expect(listBacklog('work')).toEqual([])
  })
})

describe('handleUrl', () => {
  const deps = (): UrlDeps & { calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      showCapture: () => calls.push('capture'),
      openUi: (a) => calls.push(`open:${a.type}`),
      notify: (m) => calls.push(`notify:${m}`),
      changed: () => calls.push('changed')
    }
  }

  it('adds notes and tasks, tags them as from a URL, and confirms', () => {
    const d = deps()
    expect(handleUrl('opendayplan://note?text=hello%20world', d)).toBe(true)
    expect(handleUrl('opendayplan://add?text=ship%20report%20%231', d)).toBe(true)
    expect(handleUrl('opendayplan://add?text=%2B%20already%20prefixed', d)).toBe(true)
    const log = listActivity().map((a) => a.action_taken)
    expect(log).toContain('hello world (via URL)')
    expect(log).toContain("Added 'ship report #1' via URL")
    expect(log).toContain("Added 'already prefixed' via URL")
    expect(d.calls.filter((c) => c.startsWith('notify:'))).toEqual([
      'notify:Logged note: hello world',
      'notify:Added task: ship report #1',
      'notify:Added task: already prefixed'
    ])
  })

  it('opens existing tasks only, and shows the capture window', () => {
    const d = deps()
    submitCapture('+ real task')
    const id = (getDb().prepare('SELECT id FROM task').get() as { id: string }).id
    expect(getTaskDetail(id).task.title).toBe('real task')
    expect(handleUrl(`opendayplan://open?task=${id}`, d)).toBe(true)
    expect(handleUrl('opendayplan://open?task=00000000-0000-0000-0000-000000000000', d)).toBe(false)
    expect(handleUrl('opendayplan://capture', d)).toBe(true)
    expect(d.calls).toEqual(['open:task', 'capture'])
  })

  it('ignores junk and stops writing past the rate limit', () => {
    const d = deps()
    expect(handleUrl('https://example.com', d)).toBe(false)
    expect(handleUrl('opendayplan://explode', d)).toBe(false)
    let accepted = 0
    for (let i = 0; i < 40; i++) if (handleUrl(`opendayplan://note?text=n${i}`, d)) accepted++
    expect(accepted).toBeLessThan(40)
    expect(accepted).toBeGreaterThan(0)
  })
})

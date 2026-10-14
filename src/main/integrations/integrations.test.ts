import { beforeEach, describe, expect, it, vi } from 'vitest'
import { electronMock } from './testUtils'

vi.mock('electron', () => electronMock)

import { openDb, getDb } from '../db'
import { listActivity } from '../db/activity'
import { addLink, createTask, deleteTask, getTaskDetail, listBacklog } from '../db/tasks'
import { listEvents } from './calendarSync'
import { addExternalAsTask, addJiraSubtasks, listExternal, listJiraSubtasks } from './external'
import { syncGithub, type GithubSyncDeps } from './githubSync'
import { list as githubList, stripStateTokens, type PrSummary } from './providers/github'
import {
  getRecord,
  listIntegrations,
  parseGoogleSecret,
  saveIntegration,
  setGoogleRefreshToken
} from './registry'

beforeEach(() => {
  openDb(':memory:')
})

describe('registry', () => {
  it('encrypts secrets, never exposes them, and keeps the stored one on a blank save', () => {
    const saved = saveIntegration({
      kind: 'linear',
      name: 'L',
      config: { workspace: 'acme' },
      secret: 'lin_key'
    })
    expect(saved).not.toHaveProperty('secret')
    expect(saved.has_secret).toBe(true)
    const raw = getDb().prepare('SELECT secret FROM integration WHERE id = ?').get(saved.id) as {
      secret: Buffer
    }
    expect(raw.secret.toString()).not.toBe('lin_key')
    expect(getRecord(saved.id).secret).toBe('lin_key')

    saveIntegration({ id: saved.id, kind: 'linear', name: 'L2', config: {}, secret: '' })
    expect(getRecord(saved.id)).toMatchObject({ name: 'L2', secret: 'lin_key' })
    expect(listIntegrations()).toHaveLength(1)
  })

  it('refuses to save a secret when secure storage is unavailable', () => {
    const spy = vi.spyOn(electronMock.safeStorage, 'isEncryptionAvailable').mockReturnValue(false)
    expect(() => saveIntegration({ kind: 'jira', name: 'J', config: {}, secret: 'x' })).toThrow()
    spy.mockRestore()
  })

  it('merges the Google client secret and refresh token without losing either', () => {
    const g = saveIntegration({
      kind: 'google_calendar',
      name: 'G',
      config: { client_id: 'cid' },
      secret: 'csecret'
    })
    expect(g.connected).toBe(false)
    setGoogleRefreshToken(g.id, 'refresh')
    saveIntegration({
      id: g.id,
      kind: 'google_calendar',
      name: 'G',
      config: { client_id: 'cid' },
      secret: 'csecret2'
    })
    expect(parseGoogleSecret(getRecord(g.id).secret)).toEqual({
      client_secret: 'csecret2',
      refresh_token: 'refresh'
    })
    expect(listIntegrations()[0].connected).toBe(true)
  })
})

describe('github PR sync', () => {
  const pr = (n: number): PrSummary => ({
    external_id: `acme/api#${n}`,
    repo: 'acme/api',
    number: n,
    title: `Change ${n}`,
    url: `https://github.com/acme/api/pull/${n}`,
    author: 'alice',
    draft: false
  })
  const item = (n: number): Parameters<typeof addExternalAsTask>[1] => ({
    external_id: `acme/api#${n}`,
    key: `api#${n}`,
    title: `Change ${n}`,
    url: `https://github.com/acme/api/pull/${n}`
  })
  const setup = (filter = 'review-requested:@me is:open'): ReturnType<typeof getRecord> => {
    const i = saveIntegration({
      kind: 'github',
      name: 'GH',
      config: { pr_filter: filter },
      secret: 'pat'
    })
    return getRecord(i.id)
  }
  type States = Record<string, { merged: boolean; open: boolean; by: string | null }>
  const deps = (
    merged: PrSummary[],
    states: States
  ): { d: GithubSyncDeps; queries: string[]; stateCalls: string[] } => {
    const queries: string[] = []
    const stateCalls: string[] = []
    return {
      queries,
      stateCalls,
      d: {
        searchPrs: async (q) => {
          queries.push(q)
          return merged
        },
        getPrState: async (repo, n) => {
          stateCalls.push(`${repo}#${n}`)
          const s = states[`${repo}#${n}`] ?? { merged: false, open: true, by: null }
          return { merged: s.merged, closed: !s.open, open: s.open, by: s.by }
        },
        getLogin: async () => 'Me'
      }
    }
  }
  const log = (): string[] => listActivity().map((a) => a.action_taken)

  it('strips state qualifiers from the user filter', () => {
    expect(stripStateTokens('is:open review-requested:@me state:closed  label:x')).toBe(
      'review-requested:@me label:x'
    )
  })

  it('never creates tasks on its own', async () => {
    const rec = setup()
    await syncGithub(rec, deps([pr(1)], {}).d)
    expect(listBacklog('work')).toEqual([])
  })

  it('lists open PRs for the filter without state qualifiers duplicated', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                number: 4,
                title: 'WIP thing',
                html_url: 'https://github.com/acme/api/pull/4',
                repository_url: 'https://api.github.com/repos/acme/api',
                user: { login: 'alice' },
                draft: true
              }
            ]
          })
        )
    )
    vi.stubGlobal('fetch', f)
    const items = await githubList(setup('review-requested:@me is:open'))
    vi.unstubAllGlobals()
    const url = decodeURIComponent((f.mock.calls[0] as unknown as [string])[0])
    expect(url).toContain('q=is:pr is:open review-requested:@me')
    expect(url).not.toContain('is:open is:open')
    expect(items[0]).toMatchObject({
      external_id: 'acme/api#4',
      key: 'api#4',
      status: 'Draft',
      tone: 'draft',
      assignee: 'alice'
    })
  })

  it('completes an added PR task and logs who merged it', async () => {
    const rec = setup()
    addExternalAsTask(rec.id, item(1), 'work')
    await syncGithub(rec, deps([], { 'acme/api#1': { merged: true, open: false, by: 'bob' } }).d)
    const row = getDb().prepare('SELECT completed_at FROM task').get() as {
      completed_at: string | null
    }
    expect(row.completed_at).not.toBeNull()
    expect(log()).toContain('PR acme/api#1 merged by @bob (task added by sync)')
  })

  it('logs a close without a merge as closed', async () => {
    const rec = setup()
    addExternalAsTask(rec.id, item(1), 'work')
    await syncGithub(rec, deps([], { 'acme/api#1': { merged: false, open: false, by: 'carol' } }).d)
    expect(log()).toContain('PR acme/api#1 closed by @carol (task added by sync)')
  })

  it('leaves a still-open tracked PR alone and keeps checking it', async () => {
    const rec = setup()
    addExternalAsTask(rec.id, item(1), 'work')
    await syncGithub(rec, deps([], {}).d)
    await syncGithub(rec, deps([], { 'acme/api#1': { merged: true, open: false, by: 'bob' } }).d)
    expect(log()).toContain('PR acme/api#1 merged by @bob (task added by sync)')
  })

  it('still resolves tracked PRs when no filter is configured, but skips the merged search', async () => {
    const rec = setup('  ')
    addExternalAsTask(rec.id, item(1), 'work')
    const { d, queries } = deps([], { 'acme/api#1': { merged: true, open: false, by: 'bob' } })
    await syncGithub(rec, d)
    expect(queries).toEqual([])
    expect(log()).toContain('PR acme/api#1 merged by @bob (task added by sync)')
  })

  it('does not log or recreate anything for a task the user deleted', async () => {
    const rec = setup()
    addExternalAsTask(rec.id, item(1), 'work')
    deleteTask(listBacklog('work')[0].id)
    await syncGithub(rec, deps([], { 'acme/api#1': { merged: true, open: false, by: 'bob' } }).d)
    expect(listBacklog('work')).toEqual([])
    expect(log().some((l) => l.includes('merged by'))).toBe(false)
  })

  it('logs an untracked PR only when I merged it, once', async () => {
    const rec = setup()
    const { d, queries } = deps([pr(7), pr(8)], {
      'acme/api#7': { merged: true, open: false, by: 'me' }, // case-insensitive match on "Me"
      'acme/api#8': { merged: true, open: false, by: 'someone-else' }
    })
    await syncGithub(rec, d)
    await syncGithub(rec, d)
    expect(listBacklog('work')).toEqual([])
    expect(log().filter((l) => l.includes('no task was created'))).toEqual([
      'PR acme/api#7 merged by @me, no task was created'
    ])
    expect(log().some((l) => l.includes('acme/api#8'))).toBe(false)
    expect(queries[0]).toMatch(/^is:pr is:merged merged:>=\d{4}-\d{2}-\d{2} review-requested:@me$/)
  })
})

describe('quick add + calendar events', () => {
  it('adds an external issue as a linked task only once', () => {
    const i = saveIntegration({
      kind: 'jira',
      name: 'J',
      config: { site: 'acme.atlassian.net' },
      secret: 't'
    })
    const item = {
      external_id: 'PROJ-1',
      key: 'PROJ-1',
      title: 'Fix it',
      url: 'https://acme.atlassian.net/browse/PROJ-1'
    }
    addExternalAsTask(i.id, item, 'personal')
    addExternalAsTask(i.id, item, 'personal')
    const tasks = listBacklog('personal')
    expect(tasks.map((t) => t.title)).toEqual(['PROJ-1 Fix it'])
    expect(getTaskDetail(tasks[0].id).links).toHaveLength(1)
    expect(tasks[0].due_date).toBeNull()
  })

  it('lets a deleted task be added again', async () => {
    const i = saveIntegration({
      kind: 'jira',
      name: 'J',
      config: { site: 'acme.atlassian.net', jql: 'x', jql_valid: true },
      secret: 't'
    })
    const issue = {
      key: 'PROJ-1',
      fields: { summary: 'Fix it', status: { name: 'To Do' }, assignee: null }
    }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ issues: [issue] })))
    const item = {
      external_id: 'PROJ-1',
      key: 'PROJ-1',
      title: 'Fix it',
      url: 'https://acme.atlassian.net/browse/PROJ-1'
    }
    addExternalAsTask(i.id, item, 'work')
    expect((await listExternal(i.id))[0].added).toBe(true)

    deleteTask(listBacklog('work')[0].id)
    expect((await listExternal(i.id))[0].added).toBe(false)
    addExternalAsTask(i.id, item, 'work')
    expect(listBacklog('work').map((t) => t.title)).toEqual(['PROJ-1 Fix it'])
    expect((await listExternal(i.id))[0].added).toBe(true)
    vi.unstubAllGlobals()
  })

  it('treats a leftover tracking row from an earlier deletion as not added', () => {
    const i = saveIntegration({
      kind: 'jira',
      name: 'J',
      config: { site: 'acme.atlassian.net' },
      secret: 't'
    })
    getDb()
      .prepare(
        "INSERT INTO external_item (integration_id, external_id, task_id, state, created_at) VALUES (?, 'PROJ-9', NULL, 'open', '2026-10-13T00:00:00.000Z')"
      )
      .run(i.id)
    addExternalAsTask(
      i.id,
      {
        external_id: 'PROJ-9',
        key: 'PROJ-9',
        title: 'Again',
        url: 'https://acme.atlassian.net/browse/PROJ-9'
      },
      'work'
    )
    expect(listBacklog('work').map((t) => t.title)).toEqual(['PROJ-9 Again'])
  })

  describe('jira subtasks of a linked task', () => {
    const jiraSetup = (): string =>
      saveIntegration({
        kind: 'jira',
        name: 'J',
        config: { site: 'acme.atlassian.net', email: 'a@b.c' },
        secret: 't'
      }).id
    const child = (key: string, due: string | null = null): object => ({
      key,
      fields: { summary: `Child ${key}`, status: { name: 'To Do' }, assignee: null, duedate: due }
    })

    it('finds the linked issue, queries its children, and flags the ones already added', async () => {
      const jira = jiraSetup()
      const task = createTask({ context: 'work', title: 'Epic work', assigned_date: null })
      addLink(task.id, 'https://acme.atlassian.net/browse/PROJ-1', { quiet: true })
      const f = vi.fn(
        async () =>
          new Response(JSON.stringify({ issues: [child('PROJ-2', '2026-11-05'), child('PROJ-3')] }))
      )
      vi.stubGlobal('fetch', f)
      const first = await listJiraSubtasks(task.id)
      expect(
        JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).jql
      ).toBe('parent = PROJ-1 ORDER BY created ASC')
      expect(first).toMatchObject({ ok: true, issue: { key: 'PROJ-1', integrationId: jira } })
      if (!first.ok) throw new Error('unreachable')
      expect(first.items.map((i) => [i.key, i.added, i.due_date])).toEqual([
        ['PROJ-2', false, '2026-11-05'],
        ['PROJ-3', false, null]
      ])

      addJiraSubtasks(task.id, jira, [first.items[0]])
      const second = await listJiraSubtasks(task.id)
      if (!second.ok) throw new Error('unreachable')
      expect(second.items.map((i) => i.added)).toEqual([true, false])
      vi.unstubAllGlobals()
    })

    it('returns no issue when the task has no Jira link or the link matches no integration', async () => {
      jiraSetup()
      const plain = createTask({ context: 'work', title: 'Plain', assigned_date: null })
      expect(await listJiraSubtasks(plain.id)).toEqual({ ok: true, issue: null, items: [] })
      const other = createTask({ context: 'work', title: 'Other site', assigned_date: null })
      addLink(other.id, 'https://elsewhere.atlassian.net/browse/PROJ-1', { quiet: true })
      expect(await listJiraSubtasks(other.id)).toEqual({ ok: true, issue: null, items: [] })
    })

    it('adds them as plannable subtasks and makes the parent a project', () => {
      const jira = jiraSetup()
      const task = createTask({ context: 'personal', title: 'Parent', assigned_date: null })
      const item = {
        external_id: 'PROJ-2',
        key: 'PROJ-2',
        title: 'Child PROJ-2',
        url: 'https://acme.atlassian.net/browse/PROJ-2',
        due_date: '2026-11-05'
      }
      addJiraSubtasks(task.id, jira, [item])
      addJiraSubtasks(task.id, jira, [item]) // adding again is a no-op
      const detail = getTaskDetail(task.id)
      expect(detail.task.is_project).toBe(true)
      expect(detail.subtasks).toHaveLength(1)
      expect(detail.subtasks[0]).toMatchObject({
        title: 'PROJ-2 Child PROJ-2',
        parent: task.id,
        context: 'personal',
        due_date: '2026-11-05'
      })
      expect(getTaskDetail(detail.subtasks[0].id).links[0].url).toBe(item.url)
      // as a project's subtask it shows up in the backlog, so it can be planned
      expect(
        listBacklog('personal')
          .map((t) => t.title)
          .sort()
      ).toEqual(['PROJ-2 Child PROJ-2', 'Parent'])
    })
  })

  it('sets the due date from Jira when quick-adding', () => {
    const i = saveIntegration({
      kind: 'jira',
      name: 'J',
      config: { site: 'acme.atlassian.net' },
      secret: 't'
    })
    addExternalAsTask(
      i.id,
      {
        external_id: 'PROJ-2',
        key: 'PROJ-2',
        title: 'Has a deadline',
        url: 'https://acme.atlassian.net/browse/PROJ-2',
        due_date: '2026-11-05'
      },
      'work'
    )
    expect(listBacklog('work')[0].due_date).toBe('2026-11-05')
  })

  it('lists stored events by day and calendar context', () => {
    const i = saveIntegration({
      kind: 'caldav',
      name: 'C',
      config: {
        calendars: [
          { id: 'w', name: 'Work', context: 'work' },
          { id: 'p', name: 'Home', context: 'personal' }
        ]
      },
      secret: 'pw'
    })
    const ins = getDb().prepare(
      `INSERT INTO calendar_event (id, integration_id, calendar_id, external_id, title,
         start_at, end_at, start_date, end_date, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-13T00:00:00.000Z')`
    )
    const timed = (
      id: string,
      cal: string,
      ext: string,
      title: string,
      start: string,
      end: string
    ): void => {
      ins.run(id, i.id, cal, ext, title, start, end, null, null)
    }
    timed('1', 'w', 'a', 'Standup', '2026-10-13T15:00:00.000Z', '2026-10-13T15:30:00.000Z')
    timed('2', 'p', 'b', 'Dentist', '2026-10-13T18:00:00.000Z', '2026-10-13T19:00:00.000Z')
    timed('3', 'w', 'c', 'Tomorrow', '2026-10-14T15:00:00.000Z', '2026-10-14T16:00:00.000Z')
    ins.run('4', i.id, 'w', 'd', 'Offsite', null, null, '2026-10-13', '2026-10-15') // all-day
    const day = ['2026-10-13', '2026-10-13T04:00:00.000Z', '2026-10-14T04:00:00.000Z'] as const
    expect(listEvents('work', ...day).map((e) => e.title)).toEqual(['Offsite', 'Standup'])
    expect(listEvents('personal', ...day).map((e) => e.title)).toEqual(['Dentist'])
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { electronMock } from './testUtils'

vi.mock('electron', () => electronMock)

import {
  deleteBlock,
  ensureCalendar,
  fetchEvents,
  listCalendars,
  mapGoogleEvent,
  upsertBlock
} from './providers/google'
import type { BlockWrite } from './ics'
import * as github from './providers/github'
import * as jira from './providers/jira'
import * as linear from './providers/linear'
import type { IntegrationRecord } from './registry'

const rec = (
  kind: IntegrationRecord['kind'],
  config: object,
  secret = 'tok'
): IntegrationRecord => ({
  id: 'i1',
  kind,
  name: 'N',
  config: config as Record<string, unknown>,
  secret,
  enabled: true,
  last_sync_at: null,
  last_error: null,
  created_at: '2026-01-01T00:00:00.000Z'
})

const mockFetch = (body: unknown, status = 200): ReturnType<typeof vi.fn> => {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('jira', () => {
  const r = rec('jira', {
    site: 'acme.atlassian.net',
    email: 'a@b.c',
    jql: 'assignee = currentUser()',
    jql_valid: true
  })
  const issue = {
    key: 'PROJ-7',
    fields: {
      duedate: '2026-11-05',
      summary: 'Fix login',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      assignee: { displayName: 'Ann' }
    }
  }

  it('maps an issue to a preview and sends basic auth', async () => {
    const f = mockFetch(issue)
    const p = await jira.preview(r, { kind: 'jira', host: 'acme.atlassian.net', key: 'PROJ-7' })
    expect(p).toMatchObject({
      key: 'PROJ-7',
      title: 'Fix login',
      status: 'In Progress',
      tone: 'progress',
      assignee: 'Ann',
      url: 'https://acme.atlassian.net/browse/PROJ-7'
    })
    expect(f.mock.calls[0][0]).toContain('duedate')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/rest/api/3/issue/PROJ-7')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('a@b.c:tok').toString('base64')}`
    )
  })

  it('lists JQL results, but only when the JQL has been validated', async () => {
    mockFetch({ issues: [issue] })
    const listed = await jira.list(r)
    expect(listed.map((i) => i.key)).toEqual(['PROJ-7'])
    expect(listed[0].due_date).toBe('2026-11-05')
    mockFetch({ issues: [{ ...issue, fields: { ...issue.fields, duedate: null } }] })
    expect((await jira.list(r))[0].due_date).toBeNull()
    mockFetch({ issues: [issue] })
    const f = mockFetch({ issues: [issue] })
    expect(await jira.list(rec('jira', { site: 'x', jql: 'a', jql_valid: false }))).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })

  it('records whether the JQL is valid when testing', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ displayName: 'Ann' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queries: [{ errors: ['bad field'] }] })))
    vi.stubGlobal('fetch', f)
    const res = await jira.test(r)
    expect(res.configPatch).toEqual({ jql_valid: false })
    expect(res.message).toContain('invalid')
  })
})

describe('linear', () => {
  const node = {
    identifier: 'ENG-42',
    title: 'Ship it',
    url: 'https://linear.app/acme/issue/ENG-42',
    state: { name: 'Todo', type: 'unstarted' },
    assignee: { name: 'Ann' },
    dueDate: '2026-11-09'
  }

  it('maps an issue to a preview', async () => {
    mockFetch({ data: { issue: node } })
    const p = await linear.preview(rec('linear', {}), {
      kind: 'linear',
      workspace: 'acme',
      key: 'ENG-42'
    })
    expect(p).toMatchObject({ key: 'ENG-42', status: 'Todo', tone: 'todo', assignee: 'Ann' })
  })

  it('lists my open issues and surfaces GraphQL errors', async () => {
    mockFetch({ data: { viewer: { assignedIssues: { nodes: [node] } } } })
    const listed = await linear.list(rec('linear', {}))
    expect(listed.map((i) => i.key)).toEqual(['ENG-42'])
    expect(listed[0].due_date).toBe('2026-11-09')
    mockFetch({
      data: { viewer: { assignedIssues: { nodes: [{ ...node, dueDate: null }] } } }
    })
    expect((await linear.list(rec('linear', {})))[0].due_date).toBeNull()
    mockFetch({ data: { viewer: { assignedIssues: { nodes: [node] } } } })
    mockFetch({ errors: [{ message: 'bad key' }] })
    await expect(linear.list(rec('linear', {}))).rejects.toThrow('bad key')
  })
})

describe('github', () => {
  const r = rec('github', {})

  it('previews PR states: draft, merged, closed', async () => {
    const base = { title: 'T', html_url: 'u', user: { login: 'al' } }
    const ref = {
      kind: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'api',
      type: 'pull',
      number: 3
    } as const
    mockFetch({ ...base, state: 'open', merged: false, draft: true })
    expect((await github.preview(r, ref))?.tone).toBe('draft')
    mockFetch({ ...base, state: 'closed', merged: true, draft: false })
    expect((await github.preview(r, ref))?.tone).toBe('merged')
    mockFetch({ ...base, state: 'closed', merged: false, draft: false })
    expect((await github.preview(r, ref))?.tone).toBe('closed')
  })

  it('uses the issues endpoint to find who closed an unmerged PR', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'closed', merged: false, merged_by: null }))
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ closed_by: { login: 'carol' } })))
    vi.stubGlobal('fetch', f)
    expect(await github.getPrState(r, 'acme/api', 3)).toMatchObject({
      merged: false,
      open: false,
      by: 'carol'
    })
  })

  it('maps authentication failures to a readable error', async () => {
    mockFetch({}, 401)
    await expect(github.test(r)).rejects.toThrow('Authentication failed')
  })
})

describe('google events', () => {
  it('maps timed, all-day and cancelled events', () => {
    expect(
      mapGoogleEvent({
        id: 'a',
        summary: 'Mtg',
        start: { dateTime: '2026-10-13T11:00:00-04:00' },
        end: { dateTime: '2026-10-13T12:00:00-04:00' }
      })
    ).toMatchObject({
      start_at: '2026-10-13T15:00:00.000Z',
      all_day: false
    })
    expect(
      mapGoogleEvent({ id: 'b', start: { date: '2026-10-14' }, end: { date: '2026-10-15' } })
    ).toMatchObject({ all_day: true, start_at: '2026-10-14', title: '(No title)' })
    expect(
      mapGoogleEvent({
        id: 'c',
        status: 'cancelled',
        start: { date: '2026-10-14' },
        end: { date: '2026-10-15' }
      })
    ).toBeNull()
  })
})

describe('google blocks', () => {
  const g = rec(
    'google_calendar',
    { client_id: 'cid', calendars: [] },
    JSON.stringify({ client_secret: 's', refresh_token: 'r' })
  )
  const block: BlockWrite = {
    id: 'b1',
    kind: 'focus',
    title: 'Focus time',
    start_at: '2026-10-13T18:00:00.000Z',
    end_at: '2026-10-13T18:30:00.000Z',
    remote_id: null
  }
  // the token endpoint answers; every events call gets `respond`
  const stub = (
    respond: (url: string, init: RequestInit) => Response
  ): ReturnType<typeof vi.fn> => {
    const fn = vi.fn(async (url: string, init: RequestInit = {}) =>
      url.includes('oauth2.googleapis.com')
        ? new Response(JSON.stringify({ access_token: 'at' }))
        : respond(url, init)
    )
    vi.stubGlobal('fetch', fn)
    return fn
  }
  const eventCalls = (f: ReturnType<typeof vi.fn>): [string, RequestInit][] =>
    f.mock.calls.filter((c) => !String(c[0]).includes('oauth2')) as [string, RequestInit][]

  it('creates a busy, tagged event with only the generic title', async () => {
    const f = stub(() => new Response(JSON.stringify({ id: 'gid' })))
    expect(await upsertBlock(g, 'work@x.com', block)).toBe('gid')
    const [url, init] = eventCalls(f)[0]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/work%40x.com/events')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      summary: 'Focus time',
      start: { dateTime: block.start_at },
      end: { dateTime: block.end_at },
      transparency: 'opaque',
      reminders: { useDefault: false },
      extendedProperties: { private: { odp_block: 'focus', odp_id: 'b1' } }
    })
  })

  it('patches an existing event, and recreates it if it was deleted by hand', async () => {
    let first = true
    const f = stub((_u, init) => {
      if (init.method === 'PATCH' && first) {
        first = false
        return new Response('{}', { status: 404 })
      }
      return new Response(JSON.stringify({ id: init.method === 'PATCH' ? 'same' : 'new' }))
    })
    expect(await upsertBlock(g, 'c', { ...block, remote_id: 'old' })).toBe('new')
    expect(eventCalls(f).map((c) => c[1].method)).toEqual(['PATCH', 'POST'])
  })

  it('asks to reconnect when the token is read-only', async () => {
    stub(() => new Response('{}', { status: 403 }))
    await expect(upsertBlock(g, 'c', block)).rejects.toThrow(
      'Reconnect with Google to allow writing calendar blocks'
    )
  })

  it('treats deleting an already-deleted event as done', async () => {
    stub(() => new Response('{}', { status: 410 }))
    await expect(deleteBlock(g, 'c', 'gone')).resolves.toBeUndefined()
    stub(() => new Response(null, { status: 204 }))
    await expect(deleteBlock(g, 'c', 'there')).resolves.toBeUndefined()
  })

  it('finds the Focus time calendar by name instead of creating a second one', async () => {
    const f = stub(
      () =>
        new Response(
          JSON.stringify({
            items: [
              { id: 'mine', summary: 'Cal' },
              { id: 'ours', summary: 'Open Day Plan: Focus time' }
            ]
          })
        )
    )
    expect(await ensureCalendar(g, 'Open Day Plan: Focus time', 'America/New_York')).toBe('ours')
    expect(eventCalls(f).map((c) => c[1].method ?? 'GET')).toEqual(['GET'])
  })

  it('creates the calendar, in the user timezone, when there is none', async () => {
    const f = stub((_u, init) =>
      init.method === 'POST'
        ? new Response(JSON.stringify({ id: 'new-cal' }))
        : new Response(JSON.stringify({ items: [] }))
    )
    expect(await ensureCalendar(g, 'Open Day Plan: Focus time', 'America/New_York')).toBe('new-cal')
    const [url, init] = eventCalls(f)[1]
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars')
    expect(JSON.parse(init.body as string)).toMatchObject({
      summary: 'Open Day Plan: Focus time',
      timeZone: 'America/New_York'
    })
  })

  it('asks to reconnect when it may not create calendars', async () => {
    stub(() => new Response('{}', { status: 403 }))
    await expect(ensureCalendar(g, 'x', 'UTC')).rejects.toThrow('Reconnect with Google')
  })

  it('does not offer the Focus time calendar as a calendar to read', async () => {
    const withFocus = rec(
      'google_calendar',
      { client_id: 'cid', calendars: [], focus_calendar_id: 'ours' },
      JSON.stringify({ client_secret: 's', refresh_token: 'r' })
    )
    stub(
      () =>
        new Response(
          JSON.stringify({
            items: [
              { id: 'mine', summary: 'Work' },
              { id: 'ours', summary: 'F' }
            ]
          })
        )
    )
    expect(await listCalendars(withFocus)).toEqual([{ id: 'mine', name: 'Work' }])
  })

  it('reads every page of a long window', async () => {
    const withCal = rec(
      'google_calendar',
      { client_id: 'cid', calendars: [{ id: 'w', name: 'W', context: 'work' }] },
      JSON.stringify({ client_secret: 's', refresh_token: 'r' })
    )
    const ev = (id: string): object => ({
      id,
      start: { dateTime: '2026-10-13T15:00:00Z' },
      end: { dateTime: '2026-10-13T16:00:00Z' }
    })
    const f = stub(
      (url) =>
        new Response(
          JSON.stringify(
            url.includes('pageToken=p2')
              ? { items: [ev('b')] }
              : { items: [ev('a')], nextPageToken: 'p2' }
          )
        )
    )
    const out = await fetchEvents(withCal, new Date('2026-10-13'), new Date('2026-11-10'))
    expect(out.map((e) => e.external_id)).toEqual(['a', 'b'])
    expect(eventCalls(f)).toHaveLength(2)
  })

  it('does not read our own blocks back as events', () => {
    expect(
      mapGoogleEvent({
        id: 'x',
        summary: 'Focus time',
        extendedProperties: { private: { odp_block: 'focus' } },
        start: { dateTime: '2026-10-13T18:00:00Z' },
        end: { dateTime: '2026-10-13T18:30:00Z' }
      })
    ).toBeNull()
  })
})

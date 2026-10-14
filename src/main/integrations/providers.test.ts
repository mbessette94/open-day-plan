import { afterEach, describe, expect, it, vi } from 'vitest'
import { electronMock } from './testUtils'

vi.mock('electron', () => electronMock)

import { mapGoogleEvent } from './providers/google'
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

import { describe, expect, it } from 'vitest'
import { parseLink } from './links'

describe('parseLink', () => {
  it('recognises GitHub PRs, issues and repos', () => {
    expect(parseLink('https://github.com/acme/api/pull/123')).toEqual({
      kind: 'github',
      label: 'api#123',
      detail: 'PR'
    })
    expect(parseLink('https://github.com/acme/api/issues/9#issuecomment-1')).toEqual({
      kind: 'github',
      label: 'api#9',
      detail: 'Issue'
    })
    expect(parseLink('https://github.com/acme/api')).toEqual({
      kind: 'github',
      label: 'acme/api',
      detail: null
    })
  })

  it('recognises Linear issues with or without a slug', () => {
    expect(parseLink('https://linear.app/acme/issue/ENG-42/fix-the-thing')).toEqual({
      kind: 'linear',
      label: 'ENG-42',
      detail: 'Issue'
    })
    expect(parseLink('https://linear.app/acme/issue/ENG-42').label).toBe('ENG-42')
  })

  it('recognises Jira browse and board URLs', () => {
    expect(parseLink('https://acme.atlassian.net/browse/PROJ-7').label).toBe('PROJ-7')
    expect(
      parseLink('https://acme.atlassian.net/jira/software/boards/1?selectedIssue=PROJ-8')
    ).toMatchObject({
      kind: 'jira',
      label: 'PROJ-8'
    })
  })

  it('falls back to a plain link', () => {
    expect(parseLink('https://example.com/docs/a')).toEqual({
      kind: 'link',
      label: 'example.com/docs/a',
      detail: null
    })
    expect(parseLink('not a url').kind).toBe('link')
  })
})

import { githubWebHost, matchIntegration, parseLinkRef } from './links'

describe('parseLinkRef + matchIntegration', () => {
  const integrations = [
    { id: 'j1', kind: 'jira', enabled: true, config: { site: 'https://Acme.atlassian.net/' } },
    { id: 'l1', kind: 'linear', enabled: true, config: { workspace: 'acme' } },
    { id: 'g1', kind: 'github', enabled: true, config: { owners: ['Acme'] } },
    { id: 'g2', kind: 'github', enabled: true, config: { apiBase: 'https://ghe.corp.io/api/v3' } },
    { id: 'off', kind: 'jira', enabled: false, config: { site: 'old.atlassian.net' } }
  ]
  const match = (url: string): string | null => {
    const ref = parseLinkRef(url)
    return ref ? matchIntegration(ref, integrations) : null
  }

  it('matches Jira by site host, ignoring disabled integrations', () => {
    expect(match('https://acme.atlassian.net/browse/PROJ-7')).toBe('j1')
    expect(match('https://other.atlassian.net/browse/PROJ-7')).toBeNull()
    expect(match('https://old.atlassian.net/browse/PROJ-7')).toBeNull()
  })

  it('matches Linear by workspace slug', () => {
    expect(match('https://linear.app/acme/issue/ENG-42/slug')).toBe('l1')
    expect(match('https://linear.app/else/issue/ENG-42')).toBeNull()
  })

  it('matches GitHub by host and owner allowlist, including Enterprise', () => {
    expect(match('https://github.com/acme/api/pull/3')).toBe('g1')
    expect(match('https://github.com/stranger/api/pull/3')).toBeNull()
    expect(match('https://ghe.corp.io/any/thing/issues/5')).toBe('g2')
    expect(githubWebHost(undefined)).toBe('github.com')
  })

  it('returns null for unrecognised links', () => {
    expect(parseLinkRef('https://example.com/a')).toBeNull()
  })
})

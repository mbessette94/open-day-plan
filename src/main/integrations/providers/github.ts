import type { ExternalIssue, GithubConfig, LinkPreview, StatusTone } from '../../../shared/types'
import type { GithubRef } from '../../../shared/links'
import { request } from '../http'
import type { IntegrationRecord } from '../registry'

export interface PrSummary {
  external_id: string // owner/repo#12
  repo: string
  number: number
  title: string
  url: string
  author: string | null
  draft: boolean
}

export interface PrState {
  merged: boolean
  closed: boolean
  by: string | null // merged_by for merges, closed_by otherwise
}

interface SearchItem {
  number: number
  title: string
  html_url: string
  repository_url: string
  user: { login: string } | null
  draft?: boolean
}

const STATE_TOKENS = /(^|\s)(is:(open|closed|merged)|state:(open|closed))(?=\s|$)/gi

/** The user's filter without any open/closed/merged qualifiers, so we can add our own. */
export function stripStateTokens(filter: string): string {
  return filter.replace(STATE_TOKENS, ' ').replace(/\s+/g, ' ').trim()
}

function cfg(rec: IntegrationRecord): GithubConfig {
  return rec.config as unknown as GithubConfig
}

export function apiBase(rec: IntegrationRecord): string {
  return (cfg(rec).apiBase || 'https://api.github.com').replace(/\/+$/, '')
}

function headers(rec: IntegrationRecord): Record<string, string> {
  return {
    Authorization: `Bearer ${rec.secret ?? ''}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
}

export async function test(rec: IntegrationRecord): Promise<{ message: string }> {
  const me = await request<{ login: string }>(`${apiBase(rec)}/user`, { headers: headers(rec) })
  return { message: `Connected as @${me.login}` }
}

export async function preview(
  rec: IntegrationRecord,
  ref: GithubRef
): Promise<Omit<LinkPreview, 'integration_name'> | null> {
  if (ref.number === null) return null
  const key = `${ref.repo}#${ref.number}`
  const root = `${apiBase(rec)}/repos/${ref.owner}/${ref.repo}`
  if (ref.type === 'pull') {
    const pr = await request<{
      title: string
      state: string
      merged: boolean
      draft: boolean
      html_url: string
      user: { login: string } | null
    }>(`${root}/pulls/${ref.number}`, { headers: headers(rec) })
    let status = 'Open'
    let tone: StatusTone = 'open'
    if (pr.merged) [status, tone] = ['Merged', 'merged']
    else if (pr.state === 'closed') [status, tone] = ['Closed', 'closed']
    else if (pr.draft) [status, tone] = ['Draft', 'draft']
    return {
      kind: 'github',
      key,
      type: 'PR',
      title: pr.title,
      status,
      tone,
      assignee: pr.user?.login ?? null,
      url: pr.html_url
    }
  }
  const issue = await request<{
    title: string
    state: string
    html_url: string
    user: { login: string } | null
  }>(`${root}/issues/${ref.number}`, { headers: headers(rec) })
  const closed = issue.state === 'closed'
  return {
    kind: 'github',
    key,
    type: 'Issue',
    title: issue.title,
    status: closed ? 'Closed' : 'Open',
    tone: closed ? 'closed' : 'open',
    assignee: issue.user?.login ?? null,
    url: issue.html_url
  }
}

/** Search pull requests with GitHub search qualifiers. */
export async function searchPrs(rec: IntegrationRecord, q: string): Promise<PrSummary[]> {
  const res = await request<{ items: SearchItem[] }>(
    `${apiBase(rec)}/search/issues?per_page=50&q=${encodeURIComponent(q)}`,
    { headers: headers(rec) }
  )
  return res.items.map((i) => {
    const repo = i.repository_url.split('/repos/')[1] ?? i.repository_url
    return {
      external_id: `${repo}#${i.number}`,
      repo,
      number: i.number,
      title: i.title,
      url: i.html_url,
      author: i.user?.login ?? null,
      draft: i.draft === true
    }
  })
}

export async function getPrState(
  rec: IntegrationRecord,
  repo: string,
  number: number
): Promise<PrState & { open: boolean }> {
  const root = `${apiBase(rec)}/repos/${repo}`
  const pr = await request<{
    state: string
    merged: boolean
    merged_by: { login: string } | null
  }>(`${root}/pulls/${number}`, { headers: headers(rec) })
  if (pr.merged) return { merged: true, closed: true, open: false, by: pr.merged_by?.login ?? null }
  if (pr.state === 'open') return { merged: false, closed: false, open: true, by: null }
  // closed without merging: only the issues endpoint knows who closed it
  const issue = await request<{ closed_by: { login: string } | null }>(`${root}/issues/${number}`, {
    headers: headers(rec)
  })
  return { merged: false, closed: true, open: false, by: issue.closed_by?.login ?? null }
}

/** Login of the token's owner. */
export async function getLogin(rec: IntegrationRecord): Promise<string> {
  const me = await request<{ login: string }>(`${apiBase(rec)}/user`, { headers: headers(rec) })
  return me.login
}

/** Open PRs matching the configured filter, for the "add to my tasks" list. */
export async function list(rec: IntegrationRecord): Promise<Omit<ExternalIssue, 'added'>[]> {
  const base = stripStateTokens(cfg(rec).pr_filter ?? '')
  if (!base) return []
  const prs = await searchPrs(rec, `is:pr is:open ${base}`)
  return prs.map((p) => ({
    external_id: p.external_id,
    key: `${p.repo.split('/')[1] ?? p.repo}#${p.number}`,
    title: p.title,
    status: p.draft ? 'Draft' : 'Open',
    tone: p.draft ? 'draft' : 'open',
    assignee: p.author,
    due_date: null,
    url: p.url
  }))
}

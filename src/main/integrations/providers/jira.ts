import type { ExternalIssue, JiraConfig, LinkPreview, StatusTone } from '../../../shared/types'
import type { JiraRef } from '../../../shared/links'
import { request } from '../http'
import type { IntegrationRecord } from '../registry'

interface JiraIssue {
  key: string
  fields: {
    summary: string
    status?: { name: string; statusCategory?: { key: string } }
    assignee?: { displayName: string } | null
    duedate?: string | null
  }
}

function cfg(rec: IntegrationRecord): JiraConfig {
  return rec.config as unknown as JiraConfig
}

function base(rec: IntegrationRecord): string {
  return `https://${cfg(rec)
    .site.replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')}`
}

function headers(rec: IntegrationRecord): Record<string, string> {
  const auth = Buffer.from(`${cfg(rec).email}:${rec.secret ?? ''}`).toString('base64')
  return { Authorization: `Basic ${auth}` }
}

export function jiraTone(categoryKey: string | undefined): StatusTone {
  if (categoryKey === 'done') return 'done'
  if (categoryKey === 'indeterminate') return 'progress'
  return 'todo'
}

function toIssue(rec: IntegrationRecord, i: JiraIssue): Omit<ExternalIssue, 'added'> {
  return {
    external_id: i.key,
    key: i.key,
    title: i.fields.summary,
    status: i.fields.status?.name ?? 'Unknown',
    tone: jiraTone(i.fields.status?.statusCategory?.key),
    assignee: i.fields.assignee?.displayName ?? null,
    due_date: i.fields.duedate ?? null,
    url: `${base(rec)}/browse/${i.key}`
  }
}

export async function validateJql(rec: IntegrationRecord): Promise<boolean> {
  const jql = cfg(rec).jql?.trim()
  if (!jql) return false
  const res = await request<{ queries: { errors?: string[] }[] }>(
    `${base(rec)}/rest/api/3/jql/parse?validation=strict`,
    { headers: headers(rec), body: { queries: [jql] } }
  )
  return (res.queries?.[0]?.errors ?? []).length === 0
}

export async function test(
  rec: IntegrationRecord
): Promise<{ message: string; configPatch?: Record<string, unknown> }> {
  const me = await request<{ displayName: string }>(`${base(rec)}/rest/api/3/myself`, {
    headers: headers(rec)
  })
  if (!cfg(rec).jql?.trim()) {
    return { message: `Connected as ${me.displayName}`, configPatch: { jql_valid: false } }
  }
  const valid = await validateJql(rec)
  return {
    message: `Connected as ${me.displayName}. JQL is ${valid ? 'valid' : 'invalid'}`,
    configPatch: { jql_valid: valid }
  }
}

export async function preview(
  rec: IntegrationRecord,
  ref: JiraRef
): Promise<Omit<LinkPreview, 'integration_name'>> {
  const i = await request<JiraIssue>(
    `${base(rec)}/rest/api/3/issue/${ref.key}?fields=summary,status,assignee,duedate`,
    { headers: headers(rec) }
  )
  const x = toIssue(rec, i)
  return {
    kind: 'jira',
    key: x.key,
    type: 'Issue',
    title: x.title,
    status: x.status,
    tone: x.tone,
    assignee: x.assignee,
    url: x.url
  }
}

export async function list(rec: IntegrationRecord): Promise<Omit<ExternalIssue, 'added'>[]> {
  const jql = cfg(rec).jql?.trim()
  if (!jql || !cfg(rec).jql_valid) return []
  const res = await request<{ issues: JiraIssue[] }>(`${base(rec)}/rest/api/3/search/jql`, {
    headers: headers(rec),
    body: { jql, fields: ['summary', 'status', 'assignee', 'duedate'], maxResults: 50 }
  })
  return res.issues.map((i) => toIssue(rec, i))
}

/** Child issues (subtasks, or an epic's children) of a Jira issue. `key` must be a validated issue key. */
export async function listSubtasks(
  rec: IntegrationRecord,
  key: string
): Promise<Omit<ExternalIssue, 'added'>[]> {
  const res = await request<{ issues: JiraIssue[] }>(`${base(rec)}/rest/api/3/search/jql`, {
    headers: headers(rec),
    body: {
      jql: `parent = ${key} ORDER BY created ASC`,
      fields: ['summary', 'status', 'assignee', 'duedate'],
      maxResults: 100
    }
  })
  return res.issues.map((i) => toIssue(rec, i))
}

import type { ExternalIssue, LinkPreview, StatusTone } from '../../../shared/types'
import type { LinearRef } from '../../../shared/links'
import { IntegrationError, request } from '../http'
import type { IntegrationRecord } from '../registry'

const ENDPOINT = 'https://api.linear.app/graphql'

interface LinearIssue {
  identifier: string
  title: string
  url: string
  state: { name: string; type: string }
  assignee: { name: string } | null
  dueDate: string | null
}

const ISSUE_FIELDS = 'identifier title url state { name type } assignee { name } dueDate'

async function gql<T>(rec: IntegrationRecord, query: string, variables?: object): Promise<T> {
  const res = await request<{ data?: T; errors?: { message: string }[] }>(ENDPOINT, {
    headers: { Authorization: rec.secret ?? '' },
    body: { query, variables }
  })
  if (res.errors?.length || !res.data) {
    throw new IntegrationError(res.errors?.[0]?.message ?? 'Linear returned no data')
  }
  return res.data
}

export function linearTone(type: string): StatusTone {
  if (type === 'completed') return 'done'
  if (type === 'canceled') return 'closed'
  if (type === 'started') return 'progress'
  return 'todo'
}

function toIssue(i: LinearIssue): Omit<ExternalIssue, 'added'> {
  return {
    external_id: i.identifier,
    key: i.identifier,
    title: i.title,
    status: i.state.name,
    tone: linearTone(i.state.type),
    assignee: i.assignee?.name ?? null,
    due_date: i.dueDate,
    url: i.url
  }
}

export async function test(rec: IntegrationRecord): Promise<{ message: string }> {
  const d = await gql<{ viewer: { name: string } }>(rec, '{ viewer { name } }')
  return { message: `Connected as ${d.viewer.name}` }
}

export async function preview(
  rec: IntegrationRecord,
  ref: LinearRef
): Promise<Omit<LinkPreview, 'integration_name'>> {
  const d = await gql<{ issue: LinearIssue }>(
    rec,
    `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
    { id: ref.key }
  )
  const x = toIssue(d.issue)
  return {
    kind: 'linear',
    key: x.key,
    type: 'Issue',
    title: x.title,
    status: x.status,
    tone: x.tone,
    assignee: x.assignee,
    url: x.url
  }
}

/** Open issues assigned to the token's user. */
export async function list(rec: IntegrationRecord): Promise<Omit<ExternalIssue, 'added'>[]> {
  const d = await gql<{ viewer: { assignedIssues: { nodes: LinearIssue[] } } }>(
    rec,
    `{ viewer { assignedIssues(first: 50, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        nodes { ${ISSUE_FIELDS} } } } }`
  )
  return d.viewer.assignedIssues.nodes.map(toIssue)
}

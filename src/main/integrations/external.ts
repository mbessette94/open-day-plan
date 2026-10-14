import { ACTIVITY } from '../../shared/activity'
import { matchIntegration, parseLinkRef } from '../../shared/links'
import type { Context, ExternalIssue, JiraSubtasksResult } from '../../shared/types'
import { addActivity } from '../db/activity'
import { getDb } from '../db'
import { addLink, createTask, getTaskDetail, updateTask } from '../db/tasks'
import { listProvider } from './providers'
import * as jira from './providers/jira'
import { getRecord, listRecords } from './registry'

/** Issues from an integration's filter (Jira JQL / Linear assigned to me), flagged if already added. */
export async function listExternal(integrationId: string): Promise<ExternalIssue[]> {
  const items = await listProvider(getRecord(integrationId))
  const known = new Set(
    (
      getDb()
        .prepare(
          'SELECT external_id FROM external_item WHERE integration_id = ? AND task_id IS NOT NULL'
        )
        .all(integrationId) as { external_id: string }[]
    ).map((r) => r.external_id)
  )
  return items.map((i) => ({ ...i, added: known.has(i.external_id) }))
}

/** Quick-add: create a backlog task for an external issue and remember it so it isn't added twice. */
export function addExternalAsTask(
  integrationId: string,
  item: Pick<ExternalIssue, 'external_id' | 'key' | 'title' | 'url'> &
    Partial<Pick<ExternalIssue, 'due_date'>>,
  context: Context,
  parentId?: string // add as a subtask of this planner task
): void {
  const db = getDb()
  const rec = getRecord(integrationId)
  db.transaction(() => {
    // a row with no task_id is left over from a deleted task: that issue can be added again
    const exists = db
      .prepare(
        'SELECT 1 FROM external_item WHERE integration_id = ? AND external_id = ? AND task_id IS NOT NULL'
      )
      .get(integrationId, item.external_id)
    if (exists) return
    const task = createTask({
      context,
      title: `${item.key} ${item.title}`,
      assigned_date: null,
      parent: parentId
    })
    addLink(task.id, item.url, { quiet: true })
    if (item.due_date) updateTask(task.id, { due_date: item.due_date })
    db.prepare(
      `INSERT INTO external_item (integration_id, external_id, task_id, state, url, created_at)
       VALUES (?, ?, ?, 'open', ?, ?)
       ON CONFLICT(integration_id, external_id) DO UPDATE SET
         task_id = excluded.task_id, state = 'open', url = excluded.url,
         created_at = excluded.created_at`
    ).run(integrationId, item.external_id, task.id, item.url, new Date().toISOString())
    addActivity(ACTIVITY.externalAdded, `Added ${item.key} from ${rec.name}`, task.id, {
      integration: rec.name,
      key: item.key
    })
  })()
}

/** The Jira issue a task is linked to (first link that matches an enabled Jira integration). */
function linkedJiraIssue(
  taskId: string
): { integrationId: string; key: string; url: string } | null {
  const records = listRecords()
  for (const link of getTaskDetail(taskId).links) {
    const ref = parseLinkRef(link.url)
    if (ref?.kind !== 'jira') continue
    const id = matchIntegration(ref, records)
    if (id) return { integrationId: id, key: ref.key, url: link.url }
  }
  return null
}

/** Jira subtasks of the issue linked to a task, flagged if they're already in the planner. */
export async function listJiraSubtasks(taskId: string): Promise<JiraSubtasksResult> {
  const issue = linkedJiraIssue(taskId)
  if (!issue) return { ok: true, issue: null, items: [] }
  const items = await jira.listSubtasks(getRecord(issue.integrationId), issue.key)
  const known = new Set(
    (
      getDb()
        .prepare(
          'SELECT external_id FROM external_item WHERE integration_id = ? AND task_id IS NOT NULL'
        )
        .all(issue.integrationId) as { external_id: string }[]
    ).map((r) => r.external_id)
  )
  return {
    ok: true,
    issue,
    items: items.map((i) => ({ ...i, added: known.has(i.external_id) }))
  }
}

/**
 * Add Jira subtasks as subtasks of a planner task. The parent becomes a project so the new
 * subtasks can be prioritized and scheduled.
 */
export function addJiraSubtasks(
  taskId: string,
  integrationId: string,
  items: Pick<ExternalIssue, 'external_id' | 'key' | 'title' | 'url' | 'due_date'>[]
): void {
  const db = getDb()
  db.transaction(() => {
    const { task } = getTaskDetail(taskId)
    if (items.length && !task.is_project) updateTask(taskId, { is_project: true })
    for (const item of items) addExternalAsTask(integrationId, item, task.context, taskId)
  })()
}

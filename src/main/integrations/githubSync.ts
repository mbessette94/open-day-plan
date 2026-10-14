import { ACTIVITY } from '../../shared/activity'
import type { GithubConfig } from '../../shared/types'
import { addActivity } from '../db/activity'
import { getDb } from '../db'
import { setCompleted } from '../db/tasks'
import * as gh from './providers/github'
import type { IntegrationRecord } from './registry'

export interface GithubSyncDeps {
  searchPrs: (q: string) => Promise<gh.PrSummary[]>
  getPrState: (repo: string, number: number) => Promise<gh.PrState & { open: boolean }>
  getLogin: () => Promise<string>
}

interface ItemRow {
  external_id: string
  task_id: string | null
}

/**
 * One GitHub sync pass. PRs only become tasks when the user adds them from the PR list, so this
 * never creates tasks. It:
 *  1. resolves tracked PRs that are no longer open: completes the task and logs who merged/closed it
 *  2. logs PRs matching the filter that the user merged themselves without having a task for them
 * Everyone else's untracked activity is ignored.
 */
export async function syncGithub(rec: IntegrationRecord, deps?: GithubSyncDeps): Promise<void> {
  const cfg = rec.config as unknown as GithubConfig
  const base = gh.stripStateTokens(cfg.pr_filter ?? '')
  const d: GithubSyncDeps = deps ?? {
    searchPrs: (q) => gh.searchPrs(rec, q),
    getPrState: (repo, n) => gh.getPrState(rec, repo, n),
    getLogin: () => gh.getLogin(rec)
  }
  const db = getDb()
  const since = (rec.last_sync_at ?? rec.created_at).slice(0, 10)

  const hasItem = (id: string): boolean =>
    db
      .prepare('SELECT 1 FROM external_item WHERE integration_id = ? AND external_id = ?')
      .get(rec.id, id) !== undefined
  const setState = (id: string, state: string): void => {
    db.prepare(
      'UPDATE external_item SET state = ? WHERE integration_id = ? AND external_id = ?'
    ).run(state, rec.id, id)
  }

  // 1. tracked PRs that closed
  const tracked = db
    .prepare(
      "SELECT external_id, task_id FROM external_item WHERE integration_id = ? AND state = 'open'"
    )
    .all(rec.id) as ItemRow[]
  for (const item of tracked) {
    const at = item.external_id.lastIndexOf('#')
    const s = await d.getPrState(
      item.external_id.slice(0, at),
      Number(item.external_id.slice(at + 1))
    )
    if (s.open) continue
    setState(item.external_id, s.merged ? 'merged' : 'closed')
    if (!item.task_id) continue // the user deleted the task: nothing to resolve
    const task = db.prepare('SELECT completed_at FROM task WHERE id = ?').get(item.task_id) as
      { completed_at: string | null } | undefined
    if (!task) continue
    if (task.completed_at === null) setCompleted(item.task_id, true)
    addActivity(
      ACTIVITY.externalResolved,
      `PR ${item.external_id} ${s.merged ? 'merged' : 'closed'} by @${s.by ?? 'unknown'} (task added by sync)`,
      item.task_id,
      { external_id: item.external_id, merged: s.merged, by: s.by }
    )
  }

  // 2. PRs I merged since the last sync that never had a task
  if (!base) return
  const merged = (await d.searchPrs(`is:pr is:merged merged:>=${since} ${base}`)).filter(
    (pr) => !hasItem(pr.external_id)
  )
  if (merged.length === 0) return
  const me = (await d.getLogin()).toLowerCase()
  for (const pr of merged) {
    const s = await d.getPrState(pr.repo, pr.number)
    // remember every merged PR we looked at so it isn't re-checked on the next sync
    db.prepare(
      `INSERT INTO external_item (integration_id, external_id, task_id, state, url, created_at)
       VALUES (?, ?, NULL, 'merged', ?, ?)`
    ).run(rec.id, pr.external_id, pr.url, new Date().toISOString())
    if (s.by?.toLowerCase() === me) {
      addActivity(
        ACTIVITY.externalMergedUntracked,
        `PR ${pr.external_id} merged by @${s.by}, no task was created`,
        null,
        { external_id: pr.external_id, by: s.by }
      )
    }
  }
}

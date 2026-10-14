import { useEffect, useState } from 'react'
import type { ExternalIssue, JiraSubtasksResult } from '../../../shared/types'

interface Props {
  taskId: string
  linkKey: string // changes when the task's links change, to refetch
  onAdded: () => Promise<void> // the planner task changed (new subtasks, now a project)
}

/** Subtasks of the Jira issue linked to a task, with one-click add. Renders nothing without one. */
export function JiraSubtasks({ taskId, linkKey, onAdded }: Props): React.JSX.Element | null {
  const [nonce, setNonce] = useState(0)
  const key = `${taskId}:${linkKey}:${nonce}`
  const [result, setResult] = useState<{ key: string; data: JiraSubtasksResult } | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.external.jiraSubtasks(taskId).then((data) => {
      if (!cancelled) setResult({ key, data })
    })
    return () => {
      cancelled = true
    }
  }, [taskId, key])

  const data = result?.key === key ? result.data : null
  if (data && data.ok && !data.issue) return null // no linked Jira issue

  const add = async (items: ExternalIssue[]): Promise<void> => {
    if (!data?.ok || !data.issue || items.length === 0) return
    await window.api.external.addJiraSubtasks(taskId, data.issue.integrationId, items)
    await onAdded()
    setNonce((n) => n + 1)
  }

  const pending = data?.ok ? data.items.filter((i) => !i.added) : []
  return (
    <section>
      <h3>
        Jira subtasks{' '}
        {data?.ok && data.issue && (
          <small>
            of{' '}
            <a href={data.issue.url} target="_blank" rel="noreferrer">
              {data.issue.key}
            </a>
          </small>
        )}
      </h3>
      {!data && <small className="muted">Loading…</small>}
      {data && !data.ok && <span className="error">{data.message}</span>}
      {data?.ok && data.items.length === 0 && (
        <small className="muted">This Jira issue has no subtasks.</small>
      )}
      {data?.ok && data.items.length > 0 && (
        <>
          <small className="hint">
            Adding makes this task a project, so each subtask can be prioritized and scheduled.
          </small>
          {data.items.map((i) => (
            <div key={i.external_id} className="external-row">
              <a href={i.url} target="_blank" rel="noreferrer" className="key">
                {i.key}
              </a>
              <span className="grow">{i.title}</span>
              {i.due_date && <span className="muted">due {i.due_date.slice(5)}</span>}
              <span className={`status ${i.tone}`}>{i.status}</span>
              <button disabled={i.added} onClick={() => add([i])}>
                {i.added ? 'Added' : '+ Add'}
              </button>
            </div>
          ))}
        </>
      )}
      <div className="row">
        {pending.length > 1 && (
          <button onClick={() => add(pending)}>Add all ({pending.length})</button>
        )}
        <button onClick={() => setNonce((n) => n + 1)}>Refresh</button>
      </div>
    </section>
  )
}

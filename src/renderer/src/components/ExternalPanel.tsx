import { useEffect, useState } from 'react'
import type { Context, ExternalIssue, Integration } from '../../../shared/types'

interface Props {
  title: string // "Jira" or "Linear"
  integrations: Integration[]
  context: Context // new tasks land in this context's backlog
  onAdded: () => void
  onClose: () => void
}

export function ExternalPanel({
  title,
  integrations,
  context,
  onAdded,
  onClose
}: Props): React.JSX.Element {
  const [activeId, setActiveId] = useState(integrations[0]?.id ?? '')
  const [nonce, setNonce] = useState(0)
  // results are keyed by the request that produced them, so a tab switch or refresh shows "Loading…"
  const key = `${activeId}:${nonce}`
  const [result, setResult] = useState<{
    key: string
    items: ExternalIssue[] | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    window.api.external.list(activeId).then((r) => {
      if (cancelled) return
      setResult(
        r.ok ? { key, items: r.items, error: null } : { key, items: null, error: r.message }
      )
    })
    return () => {
      cancelled = true
    }
  }, [activeId, key])

  const current = result?.key === key ? result : null
  const items = current?.items ?? null
  const error = current?.error ?? null

  const add = async (item: ExternalIssue): Promise<void> => {
    await window.api.external.addAsTask(activeId, item, context)
    setResult((r) =>
      r?.items
        ? {
            ...r,
            items: r.items.map((i) =>
              i.external_id === item.external_id ? { ...i, added: true } : i
            )
          }
        : r
    )
    onAdded()
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wide external" onClick={(e) => e.stopPropagation()}>
        <div className="row spread">
          <h2>{title}</h2>
          <span>
            <button onClick={() => setNonce((n) => n + 1)}>Refresh</button>{' '}
            <button onClick={onClose}>Close</button>
          </span>
        </div>
        {integrations.length > 1 && (
          <div className="tabs">
            {integrations.map((i) => (
              <button
                key={i.id}
                className={i.id === activeId ? 'active' : ''}
                onClick={() => setActiveId(i.id)}
              >
                {i.name}
              </button>
            ))}
          </div>
        )}
        <small className="muted">
          Adding creates a backlog task in {context === 'work' ? 'Work' : 'Personal'}.
        </small>
        {error && <div className="error">{error}</div>}
        {!error && !current && <div className="muted">Loading…</div>}
        {items?.length === 0 && <div className="muted">Nothing to show.</div>}
        <div className="external-list">
          {items?.map((i) => (
            <div key={i.external_id} className="external-row">
              <a href={i.url} target="_blank" rel="noreferrer" className="key">
                {i.key}
              </a>
              <span className="grow">{i.title}</span>
              {i.due_date && <span className="muted">due {i.due_date.slice(5)}</span>}
              <span className={`status ${i.tone}`}>{i.status}</span>
              <span className="muted assignee">{i.assignee ?? ''}</span>
              <button disabled={i.added} onClick={() => add(i)}>
                {i.added ? 'Added' : '+ Add'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

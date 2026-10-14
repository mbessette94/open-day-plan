import { useEffect, useState } from 'react'
import type { Context, ReviewChoice, ReviewData } from '../../../shared/types'

interface Props {
  timezone: string
  onApplied: () => void
  onClose: () => void
}

const CHOICES: { value: ReviewChoice; label: string }[] = [
  { value: 'keep', label: 'Keep' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'done', label: 'Done' }
]

export function ShutdownReview({ timezone, onApplied, onClose }: Props): React.JSX.Element {
  const [data, setData] = useState<ReviewData | null>(null)
  const [choices, setChoices] = useState<Record<string, ReviewChoice>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.review.get().then((d) => {
      if (!cancelled) setData(d)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const choiceOf = (id: string): ReviewChoice => choices[id] ?? 'keep'
  const changes = data ? data.tasks.filter((t) => choiceOf(t.id) !== 'keep').length : 0

  const apply = async (): Promise<void> => {
    if (!data) return
    setSaving(true)
    await window.api.review.apply(
      data.tasks
        .filter((t) => choiceOf(t.id) !== 'keep')
        .map((t) => ({ id: t.id, choice: choiceOf(t.id) }))
    )
    onApplied()
    onClose()
  }

  const group = (context: Context): React.JSX.Element | null => {
    const tasks = data?.tasks.filter((t) => t.context === context) ?? []
    if (tasks.length === 0) return null
    return (
      <section>
        <h3>{context === 'work' ? 'Work' : 'Personal'}</h3>
        {tasks.map((t) => (
          <div key={t.id} className="review-row">
            <span className="grow">{t.title}</span>
            <span className="choices">
              {CHOICES.map((c) => (
                <button
                  key={c.value}
                  className={choiceOf(t.id) === c.value ? 'on' : ''}
                  onClick={() => setChoices((prev) => ({ ...prev, [t.id]: c.value }))}
                >
                  {c.label}
                </button>
              ))}
            </span>
          </div>
        ))}
      </section>
    )
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <div className="row spread">
          <h2>Wrap up the day</h2>
          <button onClick={onClose}>Close</button>
        </div>
        {!data && <span className="muted">Loading…</span>}
        {data && (
          <>
            <div className="muted">
              Done today: {data.completedCount}
              {data.reviewedAt &&
                ` · wrapped up at ${new Intl.DateTimeFormat(undefined, {
                  timeZone: timezone,
                  hour: '2-digit',
                  minute: '2-digit'
                }).format(new Date(data.reviewedAt))}`}
            </div>
            {data.tasks.length === 0 && <div>Nothing left open. Nice.</div>}
            {data.tasks.length > 0 && (
              <div className="row">
                <button
                  onClick={() =>
                    setChoices(
                      Object.fromEntries(data.tasks.map((t) => [t.id, 'tomorrow' as const]))
                    )
                  }
                >
                  All to tomorrow
                </button>
                <button onClick={() => setChoices({})}>Reset</button>
              </div>
            )}
            <div className="review-list">
              {group('work')}
              {group('personal')}
            </div>
            <small className="muted">
              Tasks you keep stay on today and carry forward. &ldquo;Tomorrow&rdquo; moves work
              tasks to the next work day and personal tasks to the next day, keeping any scheduled
              time.
            </small>
            <div className="actions">
              <button onClick={onClose}>Cancel</button>
              <button disabled={saving} onClick={apply}>
                {changes > 0 ? `Wrap up (${changes} change${changes === 1 ? '' : 's'})` : 'Wrap up'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

import type { ActivityEntry } from '../../../shared/types'

interface Props {
  entries: ActivityEntry[]
  timezone: string
}

export function ActivityFeed({ entries, timezone }: Props): React.JSX.Element {
  const fmt = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  return (
    <div className="feed">
      {entries.map((e) => (
        <div key={e.id} className="row">
          <span className="time">{fmt.format(new Date(e.created_at))}</span>
          <span>
            {e.type === 'comment'
              ? `💬 ${e.ref_title ? `[${e.ref_title}] ` : ''}${e.action_taken}`
              : e.action_taken}
          </span>
        </div>
      ))}
    </div>
  )
}

import { formatMinutes, type Capacity } from '../../../shared/capacity'

export function CapacityBar({ capacity }: { capacity: Capacity }): React.JSX.Element {
  const c = capacity
  return (
    <div className="capacity-bar">
      <span>Meetings {formatMinutes(c.meetingMin)}</span>
      <span>Planned {formatMinutes(c.plannedMin)}</span>
      <span>
        Free {formatMinutes(c.freeMin)} of {formatMinutes(c.windowMin)}
      </span>
      {c.overlapMin > 0 && (
        <span className="bad">
          Double-booked {formatMinutes(c.overlapMin)} ({c.conflictTaskIds.length} task
          {c.conflictTaskIds.length === 1 ? '' : 's'} overlap a meeting)
        </span>
      )}
      {c.needMin > c.freeMin && (
        <span className="warn">
          Do-now and Decide items need {formatMinutes(c.needMin)}, only {formatMinutes(c.freeMin)}{' '}
          free
        </span>
      )}
    </div>
  )
}

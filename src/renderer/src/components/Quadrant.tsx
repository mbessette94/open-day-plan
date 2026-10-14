import { useDroppable } from '@dnd-kit/core'
import type { Task } from '../../../shared/types'
import { TaskCard } from './TaskCard'

interface Props {
  dropId: string
  className: string
  title: string
  subtitle?: string
  tasks: Task[]
  day: string // YYYY-MM-DD the list is for
  timezone: string
  showCarried?: boolean
  onToggle: (task: Task) => void
  onOpen: (task: Task) => void
}

/** A drop zone with a vertical task list. Used for the four matrix quadrants and the today list. */
export function Quadrant({
  dropId,
  className,
  title,
  subtitle,
  tasks,
  day,
  timezone,
  showCarried = true,
  onToggle,
  onOpen
}: Props): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })
  // open tasks first, completed at the bottom
  const sorted = [...tasks].sort(
    (a, b) => Number(a.completed_at !== null) - Number(b.completed_at !== null)
  )
  return (
    <section ref={setNodeRef} className={`zone ${className}${isOver ? ' over' : ''}`}>
      <h2>
        {title} {subtitle && <small>{subtitle}</small>}
      </h2>
      <div className="list">
        {sorted.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            carried={showCarried && (t.assigned_date === null || t.assigned_date < day)}
            timezone={timezone}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  )
}

import { useDraggable } from '@dnd-kit/core'
import { describeRule } from '../../../shared/recurrence'
import type { Task } from '../../../shared/types'

interface Props {
  task: Task
  carried?: boolean
  timezone: string
  onToggle: (task: Task) => void
  onOpen: (task: Task) => void
}

export function TaskCard({ task, carried, timezone, onToggle, onOpen }: Props): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id })
  const done = task.completed_at !== null
  return (
    <div
      ref={setNodeRef}
      className={`task${done ? ' done' : ''}${isDragging ? ' dragging' : ''}`}
      onClick={() => onOpen(task)}
      {...attributes}
      {...listeners}
    >
      <input
        type="checkbox"
        checked={done}
        onChange={() => onToggle(task)}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      />
      {task.parent_title && <span className="parent-tag">{task.parent_title} ›</span>}
      <span className="title">{task.title}</span>
      {task.is_project && <span className="pill">project</span>}
      {task.recurrence && (
        <span className="carry" title={describeRule(task.recurrence)}>
          ↻
        </span>
      )}
      {task.subtask_total > 0 && (
        <span className="carry">
          {task.subtask_done}/{task.subtask_total}
        </span>
      )}
      {task.due_date && !done && (
        <span
          className={`carry${task.due_date < new Date().toLocaleDateString('en-CA') ? ' overdue' : ''}`}
        >
          due {task.due_date.slice(5)}
        </span>
      )}
      {task.scheduled_at && (
        <span className="carry">
          {new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
          }).format(new Date(task.scheduled_at))}
        </span>
      )}
      {carried && !done && <span className="carry">carried</span>}
    </div>
  )
}

import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useRef, useState, type RefObject } from 'react'
import { SLOT_MIN, gridFor, hhmm, type AgendaGrid, type TimeWindow } from '../../../shared/time'
import type { CalendarEvent, Task } from '../../../shared/types'

interface Props {
  window: TimeWindow | null
  timezone: string
  tasks: Task[] // already filtered to tasks with a scheduled_at
  events: CalendarEvent[] // read-only calendar events for this tab's day
  conflictIds: string[] // scheduled tasks overlapping a meeting
  dayStartIso: string // local midnight of the tab's day, ISO UTC
  nowMinutes: number | null // null when the tab's day is not today
  hoverMinute: number | null // slot start highlighted while dragging over the agenda
  onUnschedule: (task: Task) => void
  onResize: (task: Task, minutes: number) => void
  onOpen: (task: Task) => void
}

export const CHIP_PREFIX = 'chip-'
export const AGENDA_DROP_ID = 'agenda'

function minutesOf(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(iso))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return get('hour') * 60 + get('minute')
}

interface Placed {
  task: Task
  startSlot: number
  len: number // in slots
  lane: number
}

/** Greedy lane assignment: each item goes in the first lane that is free at its start. */
function assignLanes<T extends { startSlot: number; len: number }>(
  items: T[]
): (T & { lane: number })[] {
  const laneEnds: number[] = []
  return [...items]
    .sort((a, b) => a.startSlot - b.startSlot)
    .map((i) => {
      let lane = laneEnds.findIndex((end) => end <= i.startSlot)
      if (lane === -1) lane = laneEnds.length
      laneEnds[lane] = i.startSlot + i.len
      return { ...i, lane }
    })
}

/** Place scheduled tasks on the grid, stacking overlapping ones into lanes. */
function place(tasks: Task[], grid: AgendaGrid, tz: string): Placed[] {
  const items = tasks
    .map((task) => {
      const startSlot = Math.floor((minutesOf(task.scheduled_at!, tz) - grid.start) / SLOT_MIN)
      const len = Math.max(1, Math.round(task.duration_min / SLOT_MIN))
      return { task, startSlot, len: Math.min(len, grid.slots - startSlot) }
    })
    .filter((i) => i.startSlot >= 0 && i.startSlot < grid.slots)
  return assignLanes(items)
}

/** Place calendar events, clamped to the visible grid. All-day events span the whole day. */
function placeEvents(
  events: CalendarEvent[],
  grid: AgendaGrid,
  dayStartIso: string
): { event: CalendarEvent; startSlot: number; len: number; lane: number }[] {
  const dayStartMs = Date.parse(dayStartIso)
  const items = events
    .map((event) => {
      if (event.all_day) return { event, startSlot: 0, len: grid.slots }
      const startMin = (Date.parse(event.start_at) - dayStartMs) / 60_000
      const endMin = (Date.parse(event.end_at) - dayStartMs) / 60_000
      const startSlot = Math.max(0, Math.floor((startMin - grid.start) / SLOT_MIN))
      const endSlot = Math.min(grid.slots, Math.ceil((endMin - grid.start) / SLOT_MIN))
      return { event, startSlot, len: Math.max(1, endSlot - startSlot) }
    })
    .filter((i) => i.startSlot < grid.slots && i.startSlot + i.len > 0)
  return assignLanes(items)
}

function Chip({
  p,
  slots,
  trackRef,
  rowOffset,
  conflict,
  onUnschedule,
  onResize,
  onOpen
}: {
  p: Placed
  rowOffset: number
  conflict: boolean
  slots: number
  trackRef: RefObject<HTMLDivElement | null>
  onUnschedule: (t: Task) => void
  onResize: (t: Task, minutes: number) => void
  onOpen: (t: Task) => void
}): React.JSX.Element {
  const { task } = p
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: CHIP_PREFIX + task.id
  })
  const [liveLen, setLiveLen] = useState<number | null>(null)
  const len = liveLen ?? p.len

  const startResize = (e: React.PointerEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    const track = trackRef.current
    if (!track) return
    const slotW = track.getBoundingClientRect().width / slots
    const startX = e.clientX
    const maxLen = slots - p.startSlot
    let current = p.len
    const move = (ev: PointerEvent): void => {
      current = Math.min(maxLen, Math.max(1, p.len + Math.round((ev.clientX - startX) / slotW)))
      setLiveLen(current)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setLiveLen(null)
      if (current !== p.len) onResize(task, current * SLOT_MIN)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={setNodeRef}
      className={`chip${task.completed_at ? ' done' : ''}${isDragging ? ' dragging' : ''}${conflict ? ' conflict' : ''}`}
      style={{ gridColumn: `${p.startSlot + 1} / span ${len}`, gridRow: p.lane + 2 + rowOffset }}
      title={`${task.title} (${len * SLOT_MIN} min)`}
      onClick={() => onOpen(task)}
      {...attributes}
      {...listeners}
    >
      <span className="chip-title">{task.title}</span>
      <button
        className="chip-x"
        aria-label="Unschedule"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onUnschedule(task)
        }}
      >
        ×
      </button>
      <span className="chip-resize" onPointerDown={startResize} />
    </div>
  )
}

export function Agenda({
  window,
  timezone,
  tasks,
  events,
  conflictIds,
  dayStartIso,
  nowMinutes,
  hoverMinute,
  onUnschedule,
  onResize,
  onOpen
}: Props): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: AGENDA_DROP_ID })
  const trackRef = useRef<HTMLDivElement | null>(null)
  if (!window) {
    return (
      <div className="agenda">
        <span className="empty">Not a work day</span>
      </div>
    )
  }
  const grid = gridFor(window)
  const placed = place(tasks, grid, timezone)
  const lanes = Math.max(1, ...placed.map((p) => p.lane + 1))
  const placedEvents = placeEvents(events, grid, dayStartIso)
  const eventLanes = placedEvents.length ? Math.max(...placedEvents.map((e) => e.lane + 1)) : 0
  const hours = Array.from({ length: (grid.end - grid.start) / 60 }, (_, i) => grid.start + i * 60)
  const pct = (min: number): number => ((min - grid.start) / (grid.end - grid.start)) * 100
  const nowPct =
    nowMinutes !== null && nowMinutes >= grid.start && nowMinutes <= grid.end
      ? pct(nowMinutes)
      : null

  return (
    <div className="agenda">
      <div
        ref={(el) => {
          setNodeRef(el)
          trackRef.current = el
        }}
        className={`track${isOver ? ' over' : ''}`}
        style={
          {
            '--slots': grid.slots,
            gridTemplateColumns: `repeat(${grid.slots}, 1fr)`,
            gridTemplateRows: `auto repeat(${eventLanes + lanes}, 24px)`
          } as React.CSSProperties
        }
      >
        {hours.map((h) => (
          <div
            key={h}
            className="hour-label"
            style={{
              gridColumn: `${(h - grid.start) / SLOT_MIN + 1} / span ${60 / SLOT_MIN}`,
              gridRow: 1
            }}
          >
            {hhmm(h)}
          </div>
        ))}
        {hoverMinute !== null && (
          <div
            className="hover-slot"
            style={{
              left: `${pct(hoverMinute)}%`,
              width: `${(SLOT_MIN / (grid.end - grid.start)) * 100}%`
            }}
          >
            <span>{hhmm(hoverMinute)}</span>
          </div>
        )}
        {placedEvents.map(({ event, startSlot, len, lane }) => {
          const style = { gridColumn: `${startSlot + 1} / span ${len}`, gridRow: lane + 2 }
          const when = event.all_day
            ? 'All day'
            : `${hhmm(Math.round((Date.parse(event.start_at) - Date.parse(dayStartIso)) / 60_000))}`
          const tip = `${event.title} (${when})${event.location ? ` @ ${event.location}` : ''}`
          const inner = <span className="chip-title">{event.title}</span>
          return event.url ? (
            <a
              key={event.id}
              className="event"
              style={style}
              href={event.url}
              target="_blank"
              rel="noreferrer"
              title={tip}
            >
              {inner}
            </a>
          ) : (
            <div key={event.id} className="event" style={style} title={tip}>
              {inner}
            </div>
          )
        })}
        {placed.map((p) => (
          <Chip
            rowOffset={eventLanes}
            conflict={conflictIds.includes(p.task.id)}
            key={p.task.id}
            p={p}
            slots={grid.slots}
            trackRef={trackRef}
            onUnschedule={onUnschedule}
            onResize={onResize}
            onOpen={onOpen}
          />
        ))}
        {nowPct !== null && <div className="now-line" style={{ left: `${nowPct}%` }} />}
      </div>
    </div>
  )
}

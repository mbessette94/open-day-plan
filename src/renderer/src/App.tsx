import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent
} from '@dnd-kit/core'
import { useEffect, useState } from 'react'
import {
  SLOT_MIN,
  dayBounds,
  gridFor,
  localDay,
  hhmm,
  localMinutes,
  targetDay,
  windowFor,
  zonedInstant
} from '../../shared/time'
import type {
  ActivityEntry,
  CalendarEvent,
  Integration,
  Priority,
  Task,
  UserSettings
} from '../../shared/types'
import { computeCapacity, findFreeSlot } from '../../shared/capacity'
import { ActivityFeed } from './components/ActivityFeed'
import { CapacityBar } from './components/CapacityBar'
import { AGENDA_DROP_ID, Agenda, CHIP_PREFIX } from './components/Agenda'
import { ExternalPanel } from './components/ExternalPanel'
import { Header } from './components/Header'
import { TaskEditor } from './components/TaskEditor'
import { Quadrant } from './components/Quadrant'
import { QuickInput } from './components/QuickInput'
import { SettingsDialog } from './components/SettingsDialog'
import { ShutdownReview } from './components/ShutdownReview'
import { StandupPanel } from './components/StandupPanel'
import { Tabs } from './components/Tabs'
import { TABS } from './tabs'

const QUADRANTS: { priority: Priority; title: string; subtitle: string }[] = [
  { priority: 3, title: 'Do immediately', subtitle: 'important + urgent' },
  { priority: 2, title: 'Decide when to do', subtitle: 'important, not urgent' },
  { priority: 1, title: 'Delegate', subtitle: 'urgent, not important' },
  { priority: 0, title: 'Do later', subtitle: 'neither' }
]

function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

function dropPriority(id: string): Priority | null | undefined {
  if (id === 'backlog') return null
  if (id.startsWith('q-')) return Number(id.slice(2)) as Priority
  return undefined
}

/** Minute-of-day of the agenda slot a drag is over, or null when not over the agenda. */
function agendaMinute(
  e: DragMoveEvent | DragEndEvent,
  gridStart: number,
  slots: number
): number | null {
  const over = e.over
  if (!over || over.id !== AGENDA_DROP_ID) return null
  const slotW = over.rect.width / slots
  const moved = e.active.rect.current.translated
  let slot: number
  if (String(e.active.id).startsWith(CHIP_PREFIX) && moved) {
    slot = Math.round((moved.left - over.rect.left) / slotW) // chip: follow its left edge
  } else {
    const x = (e.activatorEvent as PointerEvent).clientX + e.delta.x // card: follow the pointer
    slot = Math.floor((x - over.rect.left) / slotW)
  }
  return gridStart + Math.min(slots - 1, Math.max(0, slot)) * SLOT_MIN
}

export default function App(): React.JSX.Element {
  const now = useNow()
  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [tabIndex, setTabIndex] = useState(0)
  const [tasks, setTasks] = useState<Task[]>([])
  const [backlog, setBacklog] = useState<Task[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [overlay, setOverlay] = useState<'standup' | 'wrapup' | null>(null)
  const [panel, setPanel] = useState<'jira' | 'linear' | 'github' | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [version, setVersion] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [hoverMinute, setHoverMinute] = useState<number | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const { tab, label } = TABS[tabIndex]
  const tz = settings?.timezone ?? 'UTC'
  const today = settings ? localDay(now, tz) : ''
  const day = settings ? targetDay(tab, now, settings) : ''
  const bounds = settings ? dayBounds(day, tz) : { start: '', end: '' }

  useEffect(() => {
    window.api.settings.get().then(setSettings)
  }, [])

  const loadIntegrations = (): void => {
    window.api.integrations.list().then(setIntegrations)
  }
  useEffect(() => {
    loadIntegrations()
    // background syncs finish asynchronously: refetch when the main process says data changed
    const offData = window.api.onDataChanged(() => {
      loadIntegrations()
      setVersion((v) => v + 1)
    })
    // notification clicks and the menu-bar item ask us to open things
    const offOpen = window.api.onOpen((action) => {
      if (action.type === 'task') setEditingId(action.id)
      else setOverlay(action.type === 'standup' ? 'standup' : 'wrapup')
    })
    return () => {
      offData()
      offOpen()
    }
  }, [])

  // load on tab change, local-day rollover, settings change, or after a mutation (version bump)
  useEffect(() => {
    if (!settings) return
    let cancelled = false
    Promise.all([
      window.api.tasks.list({
        context: tab.context,
        day,
        dayStart: bounds.start,
        dayEnd: bounds.end,
        includeCarryover: tab.when === 'today',
        includeCompleted: tab.when === 'today'
      }),
      window.api.tasks.backlog(tab.context),
      window.api.activity.list(200),
      window.api.calendar.events(tab.context, day, bounds.start, bounds.end)
    ]).then(([t, b, a, ev]) => {
      if (cancelled) return
      setTasks(t)
      setBacklog(b)
      setEvents(ev)
      setActivity(a)
    })
    return () => {
      cancelled = true
    }
  }, [settings, tab, day, bounds.start, bounds.end, version])

  // snapshot settings into day_record at each local-day rollover
  useEffect(() => {
    if (today) window.api.days.recordToday()
  }, [today])

  if (!settings) return <div className="app" />

  const jiraList = integrations.filter(
    (i) => i.kind === 'jira' && i.enabled && i.config.jql_valid === true
  )
  const linearList = integrations.filter((i) => i.kind === 'linear' && i.enabled)
  const githubList = integrations.filter(
    (i) => i.kind === 'github' && i.enabled && String(i.config.pr_filter ?? '').trim() !== ''
  )
  const draggedTask = [...tasks, ...backlog].find((t) => t.id === dragging)
  const win = windowFor(tab.context, day, settings)
  const grid = win ? gridFor(win) : null

  const scheduledOpen = tasks.filter((t) => t.scheduled_at !== null && t.completed_at === null)
  const unscheduledNeeds = tasks.filter(
    (t) =>
      (t.priority === 3 || t.priority === 2) && t.scheduled_at === null && t.completed_at === null
  )
  const capacity = win
    ? computeCapacity(win, bounds.start, events, scheduledOpen, unscheduledNeeds)
    : null

  /** Earliest free slot on this tab's day for a task, ignoring the task's own current booking. */
  const findSlot = (task: Task): string | null => {
    if (!win) return null
    const others = scheduledOpen.filter((t) => t.id !== task.id)
    const gaps = computeCapacity(win, bounds.start, events, others).gaps
    const notBefore = day === today ? localMinutes(now, tz) : 0
    const minute = findFreeSlot(gaps, task.duration_min, notBefore)
    return minute === null ? null : zonedInstant(day, hhmm(minute), tz)
  }

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    await fn()
    setVersion((v) => v + 1)
  }

  const onSubmit = (text: string): void => {
    // same parser as the hotkey window; the current tab supplies the default context and day
    act(() => window.api.capture.submit(text, { context: tab.context, day }))
  }

  const onDragEnd = (e: DragEndEvent): void => {
    if (!e.over) return
    const activeId = String(e.active.id).replace(CHIP_PREFIX, '')
    const task = [...tasks, ...backlog].find((t) => t.id === activeId)
    if (!task) return
    const overId = String(e.over.id)
    if (overId === AGENDA_DROP_ID) {
      const minute = grid ? agendaMinute(e, grid.start, grid.slots) : null
      if (minute === null) return
      const at = zonedInstant(day, hhmm(minute), tz)
      if (task.scheduled_at !== at) act(() => window.api.tasks.schedule(task.id, at))
      return
    }
    const p = dropPriority(overId)
    if (p === undefined || task.priority === p) return
    // dropping into a quadrant brings the task onto this tab's day if it isn't already there
    const onDay = task.assigned_date === day
    const carried = tab.when === 'today' && task.assigned_date !== null && task.assigned_date < day
    const assignTo = p !== null && !onDay && !carried ? day : undefined
    act(() => window.api.tasks.setPriority(task.id, p, assignTo))
  }

  const onToggle = (t: Task): void => {
    act(() => window.api.tasks.setCompleted(t.id, t.completed_at === null))
  }

  return (
    <div className="app">
      <Header
        now={now}
        timezone={tz}
        tabLabel={label}
        targetLabel={tab.when === 'tomorrow' || day !== today ? day : null}
        onSettings={() => setShowSettings(true)}
        showJira={jiraList.length > 0}
        showLinear={linearList.length > 0}
        showGithub={githubList.length > 0}
        onJira={() => setPanel('jira')}
        onLinear={() => setPanel('linear')}
        onGithub={() => setPanel('github')}
        onStandup={() => setOverlay('standup')}
        onWrapUp={() => setOverlay('wrapup')}
      />
      <Tabs active={tabIndex} onChange={setTabIndex} />
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragMove={(e) => setHoverMinute(grid ? agendaMinute(e, grid.start, grid.slots) : null)}
        onDragStart={(e) => setDragging(String(e.active.id).replace(CHIP_PREFIX, ''))}
        onDragCancel={() => {
          setDragging(null)
          setHoverMinute(null)
        }}
        onDragEnd={(e) => {
          setDragging(null)
          setHoverMinute(null)
          onDragEnd(e)
        }}
      >
        <div className="agenda-wrap">
          <Agenda
            window={win}
            timezone={tz}
            tasks={tasks.filter((t) => t.scheduled_at !== null)}
            nowMinutes={day === today ? localMinutes(now, tz) : null}
            events={events}
            conflictIds={capacity?.conflictTaskIds ?? []}
            dayStartIso={bounds.start}
            hoverMinute={hoverMinute}
            onOpen={(t) => setEditingId(t.id)}
            onResize={(t, minutes) => act(() => window.api.tasks.setDuration(t.id, minutes))}
            onUnschedule={(t) => act(() => window.api.tasks.schedule(t.id, null))}
          />
          {capacity && <CapacityBar capacity={capacity} />}
        </div>
        <div className="middle">
          <div className="matrix">
            {QUADRANTS.map((q) => (
              <Quadrant
                key={q.priority}
                dropId={`q-${q.priority}`}
                className={`q${q.priority}`}
                title={q.title}
                subtitle={q.subtitle}
                tasks={tasks.filter((t) => t.priority === q.priority)}
                day={day}
                timezone={tz}
                onToggle={onToggle}
                onOpen={(t) => setEditingId(t.id)}
              />
            ))}
          </div>
          <Quadrant
            dropId="backlog"
            className="backlog"
            title="Backlog"
            subtitle="all unprioritized"
            showCarried={false}
            tasks={backlog}
            day={day}
            timezone={tz}
            onToggle={onToggle}
            onOpen={(t) => setEditingId(t.id)}
          />
        </div>
        <DragOverlay>
          {draggedTask && <div className="task overlay">{draggedTask.title}</div>}
        </DragOverlay>
      </DndContext>
      <div className="bottom">
        <ActivityFeed entries={activity} timezone={tz} />
        <QuickInput onSubmit={onSubmit} />
      </div>
      {editingId && (
        <TaskEditor
          taskId={editingId}
          timezone={tz}
          onOpen={setEditingId}
          onChanged={() => setVersion((v) => v + 1)}
          onClose={() => setEditingId(null)}
          onFindSlot={win ? findSlot : undefined}
          slotLabel={new Intl.DateTimeFormat(undefined, {
            timeZone: tz,
            weekday: 'short',
            month: 'short',
            day: 'numeric'
          }).format(new Date(bounds.start))}
        />
      )}
      {overlay === 'standup' && (
        <StandupPanel initialContext={tab.context} onClose={() => setOverlay(null)} />
      )}
      {overlay === 'wrapup' && (
        <ShutdownReview
          timezone={tz}
          onApplied={() => setVersion((v) => v + 1)}
          onClose={() => setOverlay(null)}
        />
      )}
      {panel && (
        <ExternalPanel
          title={{ jira: 'Jira', linear: 'Linear', github: 'GitHub pull requests' }[panel]}
          integrations={{ jira: jiraList, linear: linearList, github: githubList }[panel]}
          context={tab.context}
          onAdded={() => setVersion((v) => v + 1)}
          onClose={() => setPanel(null)}
        />
      )}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setShowSettings(false)}
          onIntegrationsChanged={() => {
            loadIntegrations()
            setVersion((v) => v + 1)
          }}
          onSave={async (s) => setSettings(await window.api.settings.update(s))}
        />
      )}
    </div>
  )
}

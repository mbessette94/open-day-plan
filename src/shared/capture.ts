import {
  addDays,
  isWorkDay,
  localDay,
  localMinutes,
  nextWorkDay,
  toMinutes,
  weekdayOf,
  zonedInstant
} from './time'
import type { Context, Priority, UserSettings, Weekday } from './types'

export interface CaptureDefaults {
  context?: Context // used when there is no #tag
  day?: string // YYYY-MM-DD a task lands on when no day word is given
}

export type Capture =
  | { kind: 'note'; text: string }
  | {
      kind: 'task'
      title: string
      context: Context
      priority: Priority | null
      assigned_date: string // YYYY-MM-DD: the local day it belongs to
      scheduled_at: string | null // ISO UTC, only when an @time was given
      due_date: string | null // YYYY-MM-DD
    }

const DAY_WORDS: Record<string, Weekday> = {
  mon: 'mo',
  monday: 'mo',
  tue: 'tu',
  tues: 'tu',
  tuesday: 'tu',
  wed: 'we',
  wednesday: 'we',
  thu: 'th',
  thur: 'th',
  thurs: 'th',
  thursday: 'th',
  fri: 'fr',
  friday: 'fr',
  sat: 'sa',
  saturday: 'sa',
  sun: 'su',
  sunday: 'su'
}

/** Work during work hours on a work day, otherwise personal. */
export function defaultContext(now: Date, s: UserSettings): Context {
  const day = localDay(now, s.timezone)
  const minutes = localMinutes(now, s.timezone)
  const inWork =
    isWorkDay(day, s) &&
    minutes >= toMinutes(s.work_time_start) &&
    minutes < toMinutes(s.work_time_end)
  return inWork ? 'work' : 'personal'
}

/** The next date strictly after `today` that falls on `weekday`. */
function nextWeekday(today: string, weekday: Weekday): string {
  let d = addDays(today, 1)
  for (let i = 0; i < 7 && weekdayOf(d) !== weekday; i++) d = addDays(d, 1)
  return d
}

function parseTime(token: string): string | null {
  const m = /^@(\d{1,2})(?::(\d{2}))?(am|pm)?$/i.exec(token)
  if (!m) return null
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const ampm = m[3]?.toLowerCase()
  if (ampm) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (ampm === 'pm' ? 12 : 0)
  }
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function parseDue(value: string, today: string): string | null {
  const v = value.toLowerCase()
  if (v === 'today') return today
  if (v === 'tomorrow') return addDays(today, 1)
  if (DAY_WORDS[v]) return nextWeekday(today, DAY_WORDS[v])
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v
  const md = /^(\d{2})-(\d{2})$/.exec(v)
  if (md) {
    const candidate = `${today.slice(0, 4)}-${md[1]}-${md[2]}`
    return candidate >= today ? candidate : `${Number(today.slice(0, 4)) + 1}-${md[1]}-${md[2]}`
  }
  return null
}

/**
 * Parse quick-capture text. Plain text is a note; a leading `+` makes a task. Task tokens are
 * consumed from the title: `!0`-`!3` priority, `#work`/`#personal`, `@15:00`/`@3pm`, `today`,
 * `tomorrow`, weekday names, and `due:<date|tomorrow|weekday>`. Returns null for empty input or a
 * task with no title left.
 */
export function parseCapture(
  input: string,
  now: Date,
  s: UserSettings,
  defaults: CaptureDefaults = {}
): Capture | null {
  const text = input.trim()
  if (!text) return null
  const plus = /^\+\s*/.exec(text)
  if (!plus) return { kind: 'note', text }

  const today = localDay(now, s.timezone)
  let context: Context | null = null
  let priority: Priority | null = null
  let time: string | null = null
  let dayWord: string | null = null
  let due: string | null = null
  const titleWords: string[] = []

  for (const word of text.slice(plus[0].length).split(/\s+/).filter(Boolean)) {
    const w = word.toLowerCase()
    if (/^![0-3]$/.test(w)) priority = Number(w[1]) as Priority
    else if (w === '#work' || w === '#personal') context = w.slice(1) as Context
    else if (parseTime(w)) time = parseTime(w)
    else if (w === 'today' || w === 'tomorrow' || DAY_WORDS[w]) dayWord = w
    else if (w.startsWith('due:') && parseDue(w.slice(4), today)) due = parseDue(w.slice(4), today)
    else titleWords.push(word)
  }
  const title = titleWords.join(' ')
  if (!title) return null

  const ctx = context ?? defaults.context ?? defaultContext(now, s)
  let day = defaults.day ?? today
  if (dayWord === 'today') day = today
  else if (dayWord === 'tomorrow') day = ctx === 'work' ? nextWorkDay(today, s) : addDays(today, 1)
  else if (dayWord) day = nextWeekday(today, DAY_WORDS[dayWord])

  return {
    kind: 'task',
    title,
    context: ctx,
    priority,
    assigned_date: day,
    scheduled_at: time ? zonedInstant(day, time, s.timezone) : null,
    due_date: due
  }
}

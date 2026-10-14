import ICAL from 'ical.js'

export interface ParsedEvent {
  external_id: string
  title: string
  start_at: string // ISO UTC, or YYYY-MM-DD for all-day
  end_at: string // exclusive
  all_day: boolean
  location: string | null
  url: string | null
}

const MAX_OCCURRENCES = 500

/** Expand an iCalendar document into the event instances overlapping [rangeStart, rangeEnd). */
export function parseIcs(data: string, rangeStart: Date, rangeEnd: Date): ParsedEvent[] {
  const root = new ICAL.Component(ICAL.parse(data))
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(tz)
  }
  const all = root.getAllSubcomponents('vevent').map((v) => new ICAL.Event(v))
  const masters = all.filter((e) => !e.isRecurrenceException())
  for (const ex of all.filter((e) => e.isRecurrenceException())) {
    masters.find((m) => m.uid === ex.uid)?.relateException(ex)
  }

  const out: ParsedEvent[] = []
  const push = (e: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurring: boolean): void => {
    if (e.component.getFirstPropertyValue('status') === 'CANCELLED') return
    const allDay = start.isDate
    const startAt = allDay ? start.toString() : start.toJSDate().toISOString()
    const endAt = allDay ? end.toString() : end.toJSDate().toISOString()
    const s = allDay ? Date.parse(`${startAt}T00:00:00Z`) : Date.parse(startAt)
    const en = allDay ? Date.parse(`${endAt}T00:00:00Z`) : Date.parse(endAt)
    if (!(en > rangeStart.getTime() && s < rangeEnd.getTime())) return
    const url = e.component.getFirstPropertyValue('url')
    out.push({
      external_id: recurring ? `${e.uid}@${startAt}` : e.uid,
      title: e.summary || '(No title)',
      start_at: startAt,
      end_at: endAt,
      all_day: allDay,
      location: e.location || null,
      url: typeof url === 'string' && /^https?:/.test(url) ? url : null
    })
  }

  for (const e of masters) {
    if (!e.isRecurring()) {
      push(e, e.startDate, e.endDate ?? e.startDate, false)
      continue
    }
    const it = e.iterator()
    for (let i = 0, next = it.next(); next && i < MAX_OCCURRENCES; i++, next = it.next()) {
      if (next.toJSDate() >= rangeEnd) break
      const d = e.getOccurrenceDetails(next)
      push(d.item, d.startDate, d.endDate, true)
    }
  }
  return out
}

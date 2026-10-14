import { describe, expect, it } from 'vitest'
import { buildBlockIcs, parseIcs } from './ics'

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:single@x
DTSTART:20261013T150000Z
DTEND:20261013T160000Z
SUMMARY:Standup
LOCATION:Room 1
END:VEVENT
BEGIN:VEVENT
UID:weekly@x
DTSTART:20261012T170000Z
DTEND:20261012T173000Z
RRULE:FREQ=WEEKLY;COUNT=4
SUMMARY:Weekly sync
END:VEVENT
BEGIN:VEVENT
UID:weekly@x
RECURRENCE-ID:20261019T170000Z
DTSTART:20261019T180000Z
DTEND:20261019T183000Z
SUMMARY:Weekly sync (moved)
END:VEVENT
BEGIN:VEVENT
UID:allday@x
DTSTART;VALUE=DATE:20261014
DTEND;VALUE=DATE:20261015
SUMMARY:Offsite
END:VEVENT
BEGIN:VEVENT
UID:cancelled@x
DTSTART:20261013T200000Z
DTEND:20261013T210000Z
STATUS:CANCELLED
SUMMARY:Gone
END:VEVENT
END:VCALENDAR`

describe('parseIcs', () => {
  const start = new Date('2026-10-12T00:00:00Z')
  const end = new Date('2026-10-27T00:00:00Z')
  const events = parseIcs(ICS, start, end)

  it('returns single events with their details', () => {
    expect(events.find((e) => e.title === 'Standup')).toMatchObject({
      start_at: '2026-10-13T15:00:00.000Z',
      end_at: '2026-10-13T16:00:00.000Z',
      all_day: false,
      location: 'Room 1'
    })
  })

  it('expands recurrences within the range and applies exceptions', () => {
    const weekly = events.filter((e) => e.title.startsWith('Weekly sync'))
    expect(weekly.map((e) => e.start_at)).toEqual([
      '2026-10-12T17:00:00.000Z',
      '2026-10-19T18:00:00.000Z',
      '2026-10-26T17:00:00.000Z'
    ])
    expect(weekly[1].title).toBe('Weekly sync (moved)')
    expect(new Set(weekly.map((e) => e.external_id)).size).toBe(3)
  })

  it('keeps all-day events as dates and skips cancelled ones', () => {
    expect(events.find((e) => e.title === 'Offsite')).toMatchObject({
      start_at: '2026-10-14',
      end_at: '2026-10-15',
      all_day: true
    })
    expect(events.some((e) => e.title === 'Gone')).toBe(false)
  })

  it('drops events outside the range', () => {
    expect(
      parseIcs(ICS, new Date('2027-01-01T00:00:00Z'), new Date('2027-02-01T00:00:00Z'))
    ).toEqual([])
  })
})

describe('calendar blocks', () => {
  const block = {
    id: 'b1',
    kind: 'personal' as const,
    title: 'Personal commitment',
    start_at: '2026-10-13T14:00:00.000Z',
    end_at: '2026-10-13T15:30:00.000Z',
    remote_id: null
  }

  it('builds a busy, tagged VEVENT', () => {
    const ics = buildBlockIcs(block, new Date('2026-10-13T12:00:00.000Z'))
    expect(ics).toContain('\r\nUID:b1@open-day-plan\r\n')
    expect(ics).toContain('DTSTART:20261013T140000Z')
    expect(ics).toContain('DTEND:20261013T153000Z')
    expect(ics).toContain('SUMMARY:Personal commitment')
    expect(ics).toContain('TRANSP:OPAQUE')
    expect(ics).toContain('X-ODP-BLOCK:personal')
  })

  it('is skipped when read back, so it is not counted as a meeting', () => {
    const range: [Date, Date] = [new Date('2026-10-13T00:00:00Z'), new Date('2026-10-14T00:00:00Z')]
    expect(parseIcs(buildBlockIcs(block), ...range)).toEqual([])
  })
})

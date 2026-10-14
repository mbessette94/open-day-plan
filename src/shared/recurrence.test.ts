import { describe, expect, it } from 'vitest'
import { describeRule, nextOccurrence, normalizeRule, parseRule } from './recurrence'
import type { RecurrenceRule } from './types'

describe('nextOccurrence', () => {
  it('daily and every-N-days follow the anchor', () => {
    expect(nextOccurrence({ freq: 'daily', interval: 1 }, '2026-10-13', '2026-10-13')).toBe(
      '2026-10-14'
    )
    expect(nextOccurrence({ freq: 'daily', interval: 3 }, '2026-10-13', '2026-10-13')).toBe(
      '2026-10-16'
    )
    // finishing late skips the missed occurrences: next one strictly after today, on the series
    expect(nextOccurrence({ freq: 'daily', interval: 3 }, '2026-10-01', '2026-10-13')).toBe(
      '2026-10-16'
    )
  })

  it('weekly uses the anchor weekday by default and honours byday and interval', () => {
    expect(nextOccurrence({ freq: 'weekly', interval: 1 }, '2026-10-13', '2026-10-13')).toBe(
      '2026-10-20'
    )
    const mwf: RecurrenceRule = { freq: 'weekly', interval: 1, byday: ['mo', 'we', 'fr'] }
    expect(nextOccurrence(mwf, '2026-10-12', '2026-10-12')).toBe('2026-10-14') // Mon -> Wed
    expect(nextOccurrence(mwf, '2026-10-16', '2026-10-16')).toBe('2026-10-19') // Fri -> Mon
    const biweekly: RecurrenceRule = { freq: 'weekly', interval: 2, byday: ['mo'] }
    expect(nextOccurrence(biweekly, '2026-10-12', '2026-10-12')).toBe('2026-10-26')
    expect(nextOccurrence(biweekly, '2026-10-12', '2026-10-20')).toBe('2026-10-26')
  })

  it('weekdays skips the weekend', () => {
    const weekdays: RecurrenceRule = {
      freq: 'weekly',
      interval: 1,
      byday: ['mo', 'tu', 'we', 'th', 'fr']
    }
    expect(nextOccurrence(weekdays, '2026-10-16', '2026-10-16')).toBe('2026-10-19')
  })

  it('monthly keeps the day of month and clamps to month end', () => {
    expect(nextOccurrence({ freq: 'monthly', interval: 1 }, '2026-10-13', '2026-10-13')).toBe(
      '2026-11-13'
    )
    const jan31: RecurrenceRule = { freq: 'monthly', interval: 1 }
    expect(nextOccurrence(jan31, '2026-01-31', '2026-01-31')).toBe('2026-02-28')
    expect(nextOccurrence(jan31, '2026-01-31', '2026-02-28')).toBe('2026-03-31') // back on the 31st
    expect(nextOccurrence({ freq: 'monthly', interval: 3 }, '2026-10-13', '2026-10-13')).toBe(
      '2027-01-13'
    )
    expect(nextOccurrence(jan31, '2027-12-31', '2027-12-31')).toBe('2028-01-31') // across a year
  })
})

describe('rules', () => {
  it('normalizes untrusted input', () => {
    expect(normalizeRule({ freq: 'weekly', interval: 2, byday: ['we', 'mo', 'xx'] })).toEqual({
      freq: 'weekly',
      interval: 2,
      byday: ['mo', 'we']
    })
    expect(normalizeRule({ freq: 'daily', interval: 0 })).toBeNull()
    expect(normalizeRule({ freq: 'yearly', interval: 1 })).toBeNull()
    expect(normalizeRule({ freq: 'daily', interval: 1.5 })).toBeNull()
    expect(normalizeRule(null)).toBeNull()
    expect(parseRule('not json')).toBeNull()
    expect(parseRule(JSON.stringify({ freq: 'daily', interval: 2 }))).toEqual({
      freq: 'daily',
      interval: 2
    })
  })

  it('describes rules for humans', () => {
    expect(describeRule({ freq: 'daily', interval: 1 })).toBe('Every day')
    expect(
      describeRule({ freq: 'weekly', interval: 1, byday: ['mo', 'tu', 'we', 'th', 'fr'] })
    ).toBe('Every weekday')
    expect(describeRule({ freq: 'weekly', interval: 2, byday: ['mo', 'we'] })).toBe(
      'Every 2 weeks on Mon, Wed'
    )
    expect(describeRule({ freq: 'monthly', interval: 3 })).toBe('Every 3 months')
  })
})

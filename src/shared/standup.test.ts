import { describe, expect, it } from 'vitest'
import { formatStandup } from './standup'
import type { StandupData } from './types'

const base: StandupData = {
  context: 'work',
  today: '2026-10-19', // Monday
  previousDay: '2026-10-16', // Friday
  done: [],
  comments: [],
  todayItems: [],
  meetings: { count: 0, first: null },
  blockers: []
}

describe('formatStandup', () => {
  it('formats the three sections with their empty states', () => {
    expect(formatStandup(base)).toBe(
      [
        '**Last work day (Fri, Oct 16)**',
        '- Nothing logged',
        '',
        '**Today (Mon, Oct 19)**',
        '- Nothing planned',
        '',
        '**Blockers**',
        '- None',
        ''
      ].join('\n')
    )
  })

  it('lists done items, notes, plan, meetings and blockers', () => {
    const out = formatStandup({
      ...base,
      done: ['Ship the report'],
      comments: [{ task: 'Migration', text: 'rolled back, retrying Monday' }],
      todayItems: [
        { title: 'Standup prep', time: '09:30', priority: null, due: null },
        { title: 'Fix login', time: null, priority: 3, due: '2026-10-19' },
        { title: 'Old thing', time: null, priority: 2, due: '2026-10-14' },
        { title: 'Someday', time: null, priority: 0, due: null }
      ],
      meetings: { count: 2, first: '10:00' },
      blockers: [
        { title: 'Vendor quote', reason: 'delegated', due: null },
        { title: 'Tax forms', reason: 'overdue', due: '2026-10-10' }
      ]
    })
    expect(out).toContain('- Done: Ship the report')
    expect(out).toContain('- Note on Migration: rolled back, retrying Monday')
    expect(out).toContain('- 09:30 Standup prep')
    expect(out).toContain('- Fix login (Do now, due today)')
    expect(out).toContain('- Old thing (Decide, overdue since 2026-10-14)')
    expect(out).toContain('- Someday\n')
    expect(out).toContain('- 2 meetings, first at 10:00')
    expect(out).toContain('- Waiting on: Vendor quote')
    expect(out).toContain('- Overdue: Tax forms (due 2026-10-10)')
  })

  it('says "Yesterday" for the personal context', () => {
    expect(formatStandup({ ...base, context: 'personal' })).toContain('**Yesterday (Fri, Oct 16)**')
  })
})

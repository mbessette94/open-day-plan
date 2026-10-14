import type { StandupData } from './types'

const PRIORITY_LABEL = ['Do later', 'Delegate', 'Decide', 'Do now']

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  }).format(new Date(`${day}T12:00:00Z`))
}

/** Markdown standup: yesterday / today / blockers. */
export function formatStandup(d: StandupData): string {
  const lines: string[] = []
  const section = (title: string, items: string[], empty: string): void => {
    lines.push(`**${title}**`)
    lines.push(...(items.length ? items.map((i) => `- ${i}`) : [`- ${empty}`]))
    lines.push('')
  }

  section(
    `${d.context === 'work' ? 'Last work day' : 'Yesterday'} (${dayLabel(d.previousDay)})`,
    [...d.done.map((t) => `Done: ${t}`), ...d.comments.map((c) => `Note on ${c.task}: ${c.text}`)],
    'Nothing logged'
  )

  const today = d.todayItems.map((i) => {
    const bits = [i.time ? `${i.time} ` : '', i.title]
    const tags: string[] = []
    if (i.priority === 3 || i.priority === 2) tags.push(PRIORITY_LABEL[i.priority])
    if (i.due && i.due <= d.today)
      tags.push(i.due === d.today ? 'due today' : `overdue since ${i.due}`)
    return bits.join('') + (tags.length ? ` (${tags.join(', ')})` : '')
  })
  if (d.meetings.count > 0) {
    today.push(
      `${d.meetings.count} meeting${d.meetings.count === 1 ? '' : 's'}${d.meetings.first ? `, first at ${d.meetings.first}` : ''}`
    )
  }
  section(`Today (${dayLabel(d.today)})`, today, 'Nothing planned')

  section(
    'Blockers',
    d.blockers.map((b) =>
      b.reason === 'delegated' ? `Waiting on: ${b.title}` : `Overdue: ${b.title} (due ${b.due})`
    ),
    'None'
  )
  return lines.join('\n').trimEnd() + '\n'
}

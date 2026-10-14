import type { Tab } from '../../shared/time'

export const TABS: { tab: Tab; label: string }[] = [
  { tab: { context: 'work', when: 'today' }, label: 'Work today' },
  { tab: { context: 'work', when: 'tomorrow' }, label: 'Work tomorrow' },
  { tab: { context: 'personal', when: 'today' }, label: 'Personal today' },
  { tab: { context: 'personal', when: 'tomorrow' }, label: 'Personal tomorrow' }
]

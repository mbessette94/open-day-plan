import { describe, expect, it } from 'vitest'
import { acceleratorFromEvent } from './hotkey'

type Mods = Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>>
type KeyEvent = Mods & { code: string }
const ev = (code: string, mods: Mods = {}): Required<KeyEvent> => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('acceleratorFromEvent', () => {
  it('builds accelerators from modifiers and a key', () => {
    expect(acceleratorFromEvent(ev('Space', { ctrlKey: true, altKey: true }))).toBe(
      'Control+Alt+Space'
    )
    expect(acceleratorFromEvent(ev('KeyN', { metaKey: true, shiftKey: true }))).toBe(
      'Shift+Command+N'
    )
    expect(acceleratorFromEvent(ev('Digit7', { ctrlKey: true }))).toBe('Control+7')
    expect(acceleratorFromEvent(ev('F5', { altKey: true }))).toBe('Alt+F5')
  })

  it('ignores modifier-only presses, unknown keys, and shortcuts with no modifier', () => {
    expect(acceleratorFromEvent(ev('ControlLeft', { ctrlKey: true }))).toBeNull()
    expect(acceleratorFromEvent(ev('KeyA'))).toBeNull()
    expect(acceleratorFromEvent(ev('Escape', { ctrlKey: true }))).toBeNull()
  })
})

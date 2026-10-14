/** Electron accelerator for a keydown, or null if it isn't a valid global shortcut yet. */
export function acceleratorFromEvent(e: {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  let key: string | null = null
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code
  else {
    const named: Record<string, string> = {
      Space: 'Space',
      Enter: 'Return',
      Tab: 'Tab',
      Backspace: 'Backspace',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Minus: '-',
      Equal: '=',
      Comma: ',',
      Period: '.',
      Slash: '/'
    }
    key = named[e.code] ?? null
  }
  if (!key) return null
  const mods = [
    e.ctrlKey ? 'Control' : '',
    e.altKey ? 'Alt' : '',
    e.shiftKey ? 'Shift' : '',
    e.metaKey ? 'Command' : ''
  ].filter(Boolean)
  // a global shortcut with no modifier would steal normal typing
  return mods.length ? [...mods, key].join('+') : null
}

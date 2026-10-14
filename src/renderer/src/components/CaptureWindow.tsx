import { useEffect, useRef, useState } from 'react'

/** The small floating quick-capture input shown by the global hotkey. */
export function CaptureWindow(): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    document.body.classList.add('capture-body')
    const focus = (): void => {
      setValue('')
      setMessage(null)
      input.current?.focus()
    }
    focus()
    return window.api.onCaptureFocus(focus)
  }, [])

  const submit = async (): Promise<void> => {
    const result = await window.api.capture.submit(value)
    if (!result) {
      setMessage({ ok: false, text: 'Nothing to add. A task needs a title after the +.' })
      return
    }
    setMessage({
      ok: true,
      text: `${result.kind === 'task' ? 'Task added' : 'Note logged'}: ${result.label}`
    })
    setTimeout(() => window.api.capture.hide(), 700)
  }

  return (
    <div className="capture-card">
      <input
        ref={input}
        className="capture-input"
        value={value}
        placeholder="Log a note…  or  + task !1 #personal @3pm tomorrow due:fri"
        onChange={(e) => {
          setValue(e.target.value)
          setMessage(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') window.api.capture.hide()
          else if (e.key === 'Enter' && value.trim()) submit()
        }}
      />
      <div className={`capture-hint${message ? (message.ok ? ' ok' : ' error') : ''}`}>
        {message?.text ?? 'Enter to save · Esc to close · plain text is a note, + makes a task'}
      </div>
    </div>
  )
}

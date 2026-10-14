import { useState } from 'react'

interface Props {
  onSubmit: (text: string) => void
}

export function QuickInput({ onSubmit }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  return (
    <input
      className="quick"
      value={value}
      placeholder="Type a note, or '+ task !1 @3pm tomorrow due:fri' to add a task"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || !value.trim()) return
        onSubmit(value.trim())
        setValue('')
      }}
    />
  )
}

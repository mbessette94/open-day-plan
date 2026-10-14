import { useEffect, useState } from 'react'
import { formatStandup } from '../../../shared/standup'
import type { Context } from '../../../shared/types'

interface Props {
  initialContext: Context
  onClose: () => void
}

export function StandupPanel({ initialContext, onClose }: Props): React.JSX.Element {
  const [context, setContext] = useState<Context>(initialContext)
  const [loaded, setLoaded] = useState<Context | null>(null)
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.standup.get(context).then((data) => {
      if (cancelled) return
      setText(formatStandup(data))
      setLoaded(context)
    })
    return () => {
      cancelled = true
    }
  }, [context])

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wide standup" onClick={(e) => e.stopPropagation()}>
        <div className="row spread">
          <h2>Standup</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="tabs">
          {(['work', 'personal'] as Context[]).map((c) => (
            <button key={c} className={c === context ? 'active' : ''} onClick={() => setContext(c)}>
              {c === 'work' ? 'Work' : 'Personal'}
            </button>
          ))}
        </div>
        <textarea
          className="standup-text"
          value={loaded === context ? text : 'Loading…'}
          disabled={loaded !== context}
          onChange={(e) => setText(e.target.value)}
        />
        <small className="muted">
          Built from last work day&rsquo;s completions and comments, today&rsquo;s plan and
          meetings, and your Delegate and overdue items. Edit before copying.
        </small>
        <div className="actions">
          <button
            disabled={loaded !== context}
            onClick={async () => {
              await navigator.clipboard.writeText(text)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { parseLink, type LinkKind } from '../../../shared/links'
import type { LinkPreview } from '../../../shared/types'

const GLYPH: Record<LinkKind, string> = { github: 'GH', jira: 'J', linear: 'L', link: '↗' }

// previews fetched this session, so re-renders and re-opened editors don't flicker
const cache = new Map<string, LinkPreview | null>()

interface Props {
  url: string
  force?: boolean // bypass the main-process cache once (e.g. when the editor opens)
  onRemove?: () => void
}

export function LinkBadge({ url, force, onRemove }: Props): React.JSX.Element {
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(cache.get(url))

  useEffect(() => {
    let cancelled = false
    window.api.links
      .preview(url, force)
      .then((p) => {
        cache.set(url, p)
        if (!cancelled) setPreview(p)
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
    return () => {
      cancelled = true
    }
  }, [url, force])

  const b = parseLink(url)
  const remove = onRemove && (
    <button aria-label="Remove link" onClick={onRemove}>
      ×
    </button>
  )

  if (preview) {
    return (
      <span className={`link-badge rich ${preview.kind}`}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title={`${preview.integration_name}: ${url}`}
        >
          <span className="glyph">{GLYPH[preview.kind]}</span>
          <span className="body">
            <span className="top">
              <span className="label">{preview.key}</span>
              {preview.type && <span className="detail">{preview.type}</span>}
              <span className={`status ${preview.tone}`}>{preview.status}</span>
            </span>
            <span className="title">{preview.title}</span>
            {preview.assignee && <span className="detail">{preview.assignee}</span>}
          </span>
        </a>
        {remove}
      </span>
    )
  }
  return (
    <span className={`link-badge ${b.kind}`}>
      <a href={url} target="_blank" rel="noreferrer" title={url}>
        <span className="glyph">{GLYPH[b.kind]}</span>
        <span className="label">{b.label}</span>
        {b.detail && <span className="detail">{b.detail}</span>}
      </a>
      {remove}
    </span>
  )
}

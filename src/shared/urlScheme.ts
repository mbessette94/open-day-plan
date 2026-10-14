export type UrlAction =
  | { type: 'add'; text: string }
  | { type: 'note'; text: string }
  | { type: 'open'; id: string }
  | { type: 'capture' }

export const MAX_URL_TEXT = 500
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parse an opendayplan:// URL. Input is untrusted (any web page can open one), so this only
 * recognises a few harmless actions and caps the text length.
 *   opendayplan://note?text=...   log a note
 *   opendayplan://add?text=...    add a task (supports !1 #personal @3pm tomorrow due:fri)
 *   opendayplan://open?task=<id>  open a task
 *   opendayplan://capture         show the quick-capture window
 */
export function parseUrlAction(raw: string): UrlAction | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'opendayplan:') return null
  const action = u.hostname.toLowerCase()
  if (action === 'capture') return { type: 'capture' }
  if (action === 'open') {
    const id = u.searchParams.get('task') ?? ''
    return ID.test(id) ? { type: 'open', id } : null
  }
  if (action === 'note' || action === 'add') {
    const text = (u.searchParams.get('text') ?? '').trim().slice(0, MAX_URL_TEXT).trim()
    return text ? { type: action, text } : null
  }
  return null
}

/** Allows at most `max` calls per `windowMs`. */
export function createRateLimiter(max: number, windowMs: number): (now?: number) => boolean {
  const hits: number[] = []
  return (now = Date.now()) => {
    while (hits.length && now - hits[0] >= windowMs) hits.shift()
    if (hits.length >= max) return false
    hits.push(now)
    return true
  }
}

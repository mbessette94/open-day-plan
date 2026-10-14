export class IntegrationError extends Error {}

interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown // objects are sent as JSON
  form?: Record<string, string> // sent as application/x-www-form-urlencoded
  timeoutMs?: number
}

/** fetch + JSON with a timeout and readable errors. Never logs request headers. */
export async function request<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers }
  let body: string | undefined
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(opts.form).toString()
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: opts.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000)
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    throw new IntegrationError(
      timedOut
        ? 'Request timed out'
        : `Network error: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new IntegrationError(`Authentication failed (HTTP ${res.status})`)
    }
    if (res.status === 404) throw new IntegrationError('Not found (HTTP 404)')
    const text = (await res.text().catch(() => '')).slice(0, 200)
    throw new IntegrationError(`HTTP ${res.status}${text ? `: ${text}` : ''}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

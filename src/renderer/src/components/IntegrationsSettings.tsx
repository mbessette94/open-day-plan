import { useCallback, useEffect, useState } from 'react'
import type {
  CalendarSelection,
  Context,
  Integration,
  IntegrationInput,
  IntegrationKind
} from '../../../shared/types'

const KIND_LABEL: Record<IntegrationKind, string> = {
  jira: 'Jira',
  linear: 'Linear',
  github: 'GitHub',
  google_calendar: 'Google Calendar',
  caldav: 'CalDAV'
}
const CALENDAR_KINDS: IntegrationKind[] = ['google_calendar', 'caldav']
const SYNCED_KINDS: IntegrationKind[] = ['github', 'google_calendar', 'caldav']

interface Props {
  onChanged: () => void // tell the app to reload integrations and data
}

export function IntegrationsSettings({ onChanged }: Props): React.JSX.Element {
  const [items, setItems] = useState<Integration[]>([])
  const [editing, setEditing] = useState<Integration | IntegrationKind | null>(null)
  const [notes, setNotes] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [newKind, setNewKind] = useState<IntegrationKind>('jira')

  const reload = useCallback(async () => {
    setItems(await window.api.integrations.list())
  }, [])
  useEffect(() => {
    let cancelled = false
    window.api.integrations.list().then((list) => {
      if (!cancelled) setItems(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const changed = async (): Promise<void> => {
    await reload()
    onChanged()
  }
  const note = (id: string, ok: boolean, message: string): void =>
    setNotes((n) => ({ ...n, [id]: { ok, message } }))

  if (editing) {
    return <IntegrationForm initial={editing} onSaved={changed} onClose={() => setEditing(null)} />
  }

  return (
    <div className="integrations">
      {items.length === 0 && <p className="muted">No integrations yet.</p>}
      {items.map((it) => (
        <div key={it.id} className="integration-row">
          <div className="info">
            <b>{it.name}</b> <span className="pill">{KIND_LABEL[it.kind]}</span>
            {!it.enabled && <span className="muted"> disabled</span>}
            <div className="muted">
              {it.last_error ? (
                <span className="error">{it.last_error}</span>
              ) : it.last_sync_at ? (
                `Last synced ${new Date(it.last_sync_at).toLocaleString()}`
              ) : it.connected ? (
                'Credentials saved'
              ) : (
                'Not connected'
              )}
            </div>
            {notes[it.id] && (
              <div className={notes[it.id].ok ? 'ok' : 'error'}>{notes[it.id].message}</div>
            )}
          </div>
          <div className="buttons">
            <button
              onClick={async () => {
                note(it.id, true, 'Testing…')
                const r = await window.api.integrations.test(it.id)
                note(it.id, r.ok, r.message)
                await changed()
              }}
            >
              Test
            </button>
            {SYNCED_KINDS.includes(it.kind) && (
              <button
                onClick={async () => {
                  note(it.id, true, 'Syncing…')
                  await window.api.integrations.syncNow(it.id)
                  note(it.id, true, 'Sync finished')
                  await changed()
                }}
              >
                Sync now
              </button>
            )}
            <button onClick={() => setEditing(it)}>Edit</button>
            <button
              className="danger"
              onClick={async () => {
                if (!window.confirm(`Remove '${it.name}'?`)) return
                await window.api.integrations.remove(it.id)
                await changed()
              }}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="row add-row">
        <select value={newKind} onChange={(e) => setNewKind(e.target.value as IntegrationKind)}>
          {(Object.keys(KIND_LABEL) as IntegrationKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <button onClick={() => setEditing(newKind)}>Add integration</button>
      </div>
    </div>
  )
}

type Config = Record<string, unknown>

function IntegrationForm({
  initial,
  onSaved,
  onClose
}: {
  initial: Integration | IntegrationKind
  onSaved: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const existing = typeof initial === 'string' ? null : initial
  const kind: IntegrationKind = typeof initial === 'string' ? initial : initial.kind
  const [id, setId] = useState<string | null>(existing?.id ?? null)
  const [name, setName] = useState(existing?.name ?? KIND_LABEL[kind])
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [config, setConfig] = useState<Config>(existing?.config ?? {})
  const [secret, setSecret] = useState('')
  const [hasSecret, setHasSecret] = useState(existing?.has_secret ?? false)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [available, setAvailable] = useState<{ id: string; name: string }[] | null>(null)

  const str = (k: string): string => (typeof config[k] === 'string' ? (config[k] as string) : '')
  const set = (k: string, v: unknown): void => setConfig((c) => ({ ...c, [k]: v }))
  const selected = (config.calendars as CalendarSelection[] | undefined) ?? []

  const save = async (): Promise<string | null> => {
    const input: IntegrationInput = {
      id: id ?? undefined,
      kind,
      name: name.trim() || KIND_LABEL[kind],
      config,
      secret: secret || undefined,
      enabled
    }
    try {
      const saved = await window.api.integrations.save(input)
      setId(saved.id)
      setHasSecret(saved.has_secret)
      setSecret('')
      await onSaved()
      return saved.id
    } catch (e) {
      setStatus({ ok: false, message: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  const saveAndTest = async (): Promise<void> => {
    const savedId = await save()
    if (!savedId) return
    setStatus({ ok: true, message: 'Saved. Testing…' })
    const r = await window.api.integrations.test(savedId)
    setStatus(r)
    // jql_valid is written by the test, so pull the fresh config back into the form
    const fresh = (await window.api.integrations.list()).find((i) => i.id === savedId)
    if (fresh) setConfig(fresh.config)
    await onSaved()
  }

  const loadCalendars = async (): Promise<void> => {
    const savedId = await save()
    if (!savedId) return
    const r = await window.api.integrations.listCalendars(savedId)
    if (r.ok) setAvailable(r.calendars)
    else setStatus({ ok: false, message: r.message })
  }

  const toggleCalendar = (cal: { id: string; name: string }, on: boolean): void =>
    set(
      'calendars',
      on
        ? [...selected, { id: cal.id, name: cal.name, context: 'work' as Context }]
        : selected.filter((c) => c.id !== cal.id)
    )
  const setContext = (calId: string, context: Context): void =>
    set(
      'calendars',
      selected.map((c) => (c.id === calId ? { ...c, context } : c))
    )

  const field = (label: string, k: string, placeholder = '', type = 'text'): React.JSX.Element => (
    <label>
      {label}
      <input
        type={type}
        value={str(k)}
        placeholder={placeholder}
        onChange={(e) => set(k, e.target.value)}
      />
    </label>
  )
  const secretField = (label: string): React.JSX.Element => (
    <label>
      {label}
      <input
        type="password"
        value={secret}
        placeholder={hasSecret ? '•••••• saved (leave blank to keep)' : ''}
        onChange={(e) => setSecret(e.target.value)}
      />
    </label>
  )

  return (
    <div className="integration-form">
      <h3>
        {existing ? 'Edit' : 'Add'} {KIND_LABEL[kind]}
      </h3>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      {kind === 'jira' && (
        <>
          {field('Site', 'site', 'acme.atlassian.net')}
          {field('Email', 'email', 'you@company.com')}
          {secretField('API token')}
          <label className="stack">
            JQL filter
            <textarea
              value={str('jql')}
              placeholder="assignee = currentUser() AND resolution = Unresolved"
              onChange={(e) => set('jql', e.target.value)}
            />
          </label>
          <small className="muted">
            The Jira button appears once Save &amp; test confirms the JQL is valid
            {config.jql_valid ? ' (currently valid).' : '.'}
          </small>
        </>
      )}
      {kind === 'linear' && (
        <>
          {field('Workspace (optional)', 'workspace', 'acme (from linear.app/acme)')}
          {secretField('Personal API key')}
          <small className="muted">Shows your open assigned issues.</small>
        </>
      )}
      {kind === 'github' && (
        <>
          {field('API base', 'apiBase', 'https://api.github.com')}
          {secretField('Personal access token')}
          <label>
            Preview only these owners
            <input
              value={((config.owners as string[] | undefined) ?? []).join(', ')}
              placeholder="blank = all"
              onChange={(e) =>
                set(
                  'owners',
                  e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                )
              }
            />
          </label>
          {field('Pull request filter', 'pr_filter', 'review-requested:@me org:acme')}
          <small className="muted">
            Open PRs matching this filter are listed under the GitHub button, where you choose which
            to add as tasks. Added tasks complete when their PR closes. PRs you merge yourself
            without a task are noted in the activity log. Leave blank to hide the list.
          </small>
        </>
      )}
      {kind === 'caldav' && (
        <>
          {field('Server URL', 'server_url', 'https://caldav.example.com')}
          {field('Username', 'username')}
          {secretField('Password / app password')}
        </>
      )}
      {kind === 'google_calendar' && (
        <>
          {field('OAuth client ID', 'client_id')}
          {secretField('OAuth client secret')}
          <small className="muted">
            Create a &ldquo;Desktop app&rdquo; OAuth client in Google Cloud and enable the Calendar
            API. Save, then connect.
          </small>
          <div className="row">
            <button
              disabled={!id && !hasSecret}
              onClick={async () => {
                const savedId = await save()
                if (!savedId) return
                setStatus({ ok: true, message: 'Complete the sign-in in your browser…' })
                setStatus(await window.api.integrations.googleConnect(savedId))
                await onSaved()
              }}
            >
              Connect with Google
            </button>
          </div>
        </>
      )}

      {CALENDAR_KINDS.includes(kind) && (
        <div className="calendars">
          <div className="row">
            <b>Calendars</b>
            <button onClick={loadCalendars}>Load calendars</button>
          </div>
          {(available ?? selected.map((c) => ({ id: c.id, name: c.name }))).map((cal) => {
            const sel = selected.find((c) => c.id === cal.id)
            return (
              <div key={cal.id} className="row">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(sel)}
                    onChange={(e) => toggleCalendar(cal, e.target.checked)}
                  />
                  {cal.name}
                </label>
                {sel && (
                  <select
                    value={sel.context}
                    onChange={(e) => setContext(cal.id, e.target.value as Context)}
                  >
                    <option value="work">Work</option>
                    <option value="personal">Personal</option>
                  </select>
                )}
              </div>
            )
          })}
        </div>
      )}

      {status && <div className={status.ok ? 'ok' : 'error'}>{status.message}</div>}
      <div className="actions">
        <button onClick={onClose}>Back</button>
        <button onClick={saveAndTest}>Save &amp; test</button>
        {CALENDAR_KINDS.includes(kind) && (
          <button
            onClick={async () => {
              if (await save()) setStatus({ ok: true, message: 'Saved' })
            }}
          >
            Save
          </button>
        )}
      </div>
    </div>
  )
}

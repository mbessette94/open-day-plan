import { useEffect, useState } from 'react'
import { acceleratorFromEvent } from '../../../shared/hotkey'
import { WEEKDAYS, type UserSettings, type Weekday } from '../../../shared/types'
import { BackupSettings } from './BackupSettings'
import { IntegrationsSettings } from './IntegrationsSettings'

interface Props {
  settings: UserSettings
  onSave: (patch: Partial<UserSettings>) => Promise<void>
  onClose: () => void
  onIntegrationsChanged: () => void
}

const TIME_FIELDS: { key: keyof UserSettings; label: string }[] = [
  { key: 'work_time_start', label: 'Work starts' },
  { key: 'work_time_end', label: 'Work ends' },
  { key: 'personal_time_start', label: 'Personal starts' },
  { key: 'personal_time_end', label: 'Personal ends' }
]

/** Backup settings are changed on the Backup tab, so a General save must not overwrite them. */
function withoutBackup(s: UserSettings): Partial<UserSettings> {
  const patch: Partial<UserSettings> = { ...s }
  delete patch.backup_dir
  delete patch.backup_keep
  return patch
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function SettingsDialog({
  settings,
  onSave,
  onClose,
  onIntegrationsChanged
}: Props): React.JSX.Element {
  const [draft, setDraft] = useState(settings)
  const [section, setSection] = useState<'general' | 'backup' | 'integrations'>('general')
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)

  // surface a hotkey that could not be registered (another app owns it)
  useEffect(() => {
    window.api.capture.hotkeyStatus().then((s) => setHotkeyError(s.ok ? null : s.error))
  }, [])
  const tzOk = validTimezone(draft.timezone)
  const toggle = (d: Weekday): void =>
    setDraft({
      ...draft,
      work_days: draft.work_days.includes(d)
        ? draft.work_days.filter((x) => x !== d)
        : [...draft.work_days, d]
    })
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <div className="tabs">
          <button
            className={section === 'general' ? 'active' : ''}
            onClick={() => setSection('general')}
          >
            General
          </button>
          <button
            className={section === 'backup' ? 'active' : ''}
            onClick={() => setSection('backup')}
          >
            Backup
          </button>
          <button
            className={section === 'integrations' ? 'active' : ''}
            onClick={() => setSection('integrations')}
          >
            Integrations
          </button>
        </div>

        {section === 'backup' ? (
          <>
            <BackupSettings />
            <div className="actions">
              <button onClick={onClose}>Close</button>
            </div>
          </>
        ) : section === 'integrations' ? (
          <>
            <IntegrationsSettings onChanged={onIntegrationsChanged} />
            <div className="actions">
              <button onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <>
            <label>
              Timezone
              <input
                value={draft.timezone}
                onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
              />
            </label>
            {!tzOk && <span className="error">Unknown timezone</span>}
            <div className="days">
              {WEEKDAYS.map((d) => (
                <button
                  key={d}
                  className={draft.work_days.includes(d) ? 'on' : ''}
                  onClick={() => toggle(d)}
                >
                  {d}
                </button>
              ))}
            </div>
            {TIME_FIELDS.map((f) => (
              <label key={f.key}>
                {f.label}
                <input
                  type="time"
                  value={draft[f.key] as string}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                />
              </label>
            ))}
            <label>
              Sync integrations every (minutes)
              <input
                type="number"
                min={1}
                max={1440}
                value={draft.sync_minutes}
                onChange={(e) =>
                  setDraft({ ...draft, sync_minutes: Math.max(1, Number(e.target.value) || 15) })
                }
              />
            </label>
            <h3 className="subhead">Reminders</h3>
            <label className="toggle">
              <input
                type="checkbox"
                checked={draft.notify_enabled}
                onChange={(e) => setDraft({ ...draft, notify_enabled: e.target.checked })}
              />
              Notify me
            </label>
            <label>
              Minutes of warning before a task or meeting
              <input
                type="number"
                min={0}
                max={120}
                value={draft.notify_lead_min}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    notify_lead_min: Math.max(0, Math.min(120, Number(e.target.value) || 0))
                  })
                }
              />
            </label>
            <label>
              Morning digest of what&rsquo;s due
              <input
                type="time"
                value={draft.digest_time}
                onChange={(e) => setDraft({ ...draft, digest_time: e.target.value })}
              />
            </label>
            <label>
              Nudge to wrap up the day
              <input
                type="time"
                value={draft.shutdown_time}
                onChange={(e) => setDraft({ ...draft, shutdown_time: e.target.value })}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={draft.launch_at_login}
                onChange={(e) => setDraft({ ...draft, launch_at_login: e.target.checked })}
              />
              Launch at login (packaged app only; keeps reminders running)
            </label>
            <h3 className="subhead">Quick capture</h3>
            <label>
              Global shortcut
              <input
                readOnly
                value={draft.quick_hotkey}
                title="Click here, then press the new key combination"
                onKeyDown={(e) => {
                  e.preventDefault()
                  const accel = acceleratorFromEvent(e)
                  if (accel) setDraft({ ...draft, quick_hotkey: accel })
                }}
              />
            </label>
            {hotkeyError && <span className="error">{hotkeyError}</span>}
            <small className="muted">
              Click the box and press a combination with at least one modifier. Notes by default;
              start with + for a task (!0-!3 priority, #work or #personal, @3pm, today, tomorrow, a
              weekday, due:fri).
            </small>
            <details className="help">
              <summary>Use it from Spotlight, Terminal or Raycast</summary>
              <p>
                Spotlight can&rsquo;t take typed text from an app directly, but it can run a
                Shortcut. In the Shortcuts app make one named <b>Log</b>: Ask for Input, then Open
                URLs with <code>opendayplan://note?text=</code> followed by the Provided Input. Then
                press ⌘Space and type &ldquo;Log&rdquo;.
              </p>
              <p>
                The same links work anywhere:{' '}
                <code>open &quot;opendayplan://note?text=hello&quot;</code>,{' '}
                <code>opendayplan://add?text=call%20vendor%20tomorrow</code>,{' '}
                <code>opendayplan://capture</code>. They only work in the packaged app.
              </p>
            </details>
            <div className="actions">
              <button onClick={onClose}>Cancel</button>
              <button
                disabled={!tzOk}
                onClick={async () => {
                  await onSave(withoutBackup(draft))
                  const status = await window.api.capture.hotkeyStatus()
                  if (!status.ok) {
                    setHotkeyError(status.error) // stay open so another shortcut can be chosen
                    return
                  }
                  onClose()
                }}
              >
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

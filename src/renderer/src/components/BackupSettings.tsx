import { useEffect, useState } from 'react'
import type { BackupInfo, BackupResult } from '../../../shared/types'

export function BackupSettings(): React.JSX.Element {
  const [info, setInfo] = useState<BackupInfo | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.backup.info().then((i) => {
      if (!cancelled) setInfo(i)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const run = async (fn: () => Promise<BackupResult>): Promise<void> => {
    setBusy(true)
    const r = await fn()
    if (r.message !== 'Cancelled') setMessage({ ok: r.ok, text: r.message })
    setInfo(await window.api.backup.info())
    setBusy(false)
  }
  const update = async (fn: () => Promise<BackupInfo>): Promise<void> => setInfo(await fn())

  if (!info) return <span className="muted">Loading…</span>
  const when = (iso: string): string => new Date(iso).toLocaleString()
  return (
    <div className="backup-settings">
      <section>
        <h3 className="subhead">Automatic backups</h3>
        <div className="row">
          <span className="grow">
            {info.dir ?? 'Off. Choose a folder to turn on daily backups.'}
          </span>
          <button disabled={busy} onClick={() => update(window.api.backup.chooseFolder)}>
            {info.dir ? 'Change folder…' : 'Choose folder…'}
          </button>
          {info.dir && (
            <button disabled={busy} onClick={() => update(window.api.backup.disable)}>
              Turn off
            </button>
          )}
        </div>
        <label>
          Keep the newest
          <input
            type="number"
            min={1}
            max={365}
            value={info.keep}
            onChange={(e) => update(() => window.api.backup.setKeep(Number(e.target.value)))}
          />
        </label>
        <div className="muted">
          {info.lastBackupAt ? `Last backup ${when(info.lastBackupAt)}` : 'No backup yet'}
        </div>
        {info.lastError && (
          <div className="error">Last automatic backup failed: {info.lastError}</div>
        )}
        <div className="row">
          <button disabled={busy} onClick={() => run(window.api.backup.now)}>
            Back up now
          </button>
          <button disabled={busy} onClick={() => run(window.api.backup.restore)}>
            Restore from a backup…
          </button>
        </div>
        {info.files.length > 0 && (
          <ul className="backup-files">
            {info.files.map((f) => (
              <li key={f.name}>
                {f.name} <span className="muted">{(f.size / 1024).toFixed(0)} KB</span>
              </li>
            ))}
          </ul>
        )}
        <small className="muted">
          Backups are plain database files, so choose a folder you trust. Integration tokens are
          tied to this Mac&rsquo;s Keychain and need re-entering after restoring on another machine.
        </small>
      </section>

      <section>
        <h3 className="subhead">Export</h3>
        <div className="row">
          <button disabled={busy} onClick={() => run(window.api.backup.exportJson)}>
            Export JSON…
          </button>
          <button disabled={busy} onClick={() => run(window.api.backup.exportMarkdown)}>
            Export Markdown…
          </button>
        </div>
        <small className="muted">
          JSON has everything except integration credentials. Markdown is a readable task list.
        </small>
      </section>

      {message && <div className={message.ok ? 'ok' : 'error'}>{message.text}</div>}
    </div>
  )
}

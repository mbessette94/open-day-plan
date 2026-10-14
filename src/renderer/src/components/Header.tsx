interface Props {
  now: Date
  timezone: string
  tabLabel: string
  targetLabel: string | null
  onSettings: () => void
  showJira: boolean
  showLinear: boolean
  showGithub: boolean
  onJira: () => void
  onLinear: () => void
  onGithub: () => void
  onStandup: () => void
  onWrapUp: () => void
}

export function Header({
  now,
  timezone,
  tabLabel,
  targetLabel,
  onSettings,
  showJira,
  showLinear,
  showGithub,
  onJira,
  onLinear,
  onGithub,
  onStandup,
  onWrapUp
}: Props): React.JSX.Element {
  const today = new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(now)
  return (
    <div className="header">
      <h1>{today}</h1>
      <span className="tab-name">
        {tabLabel}
        {targetLabel ? ` · ${targetLabel}` : ''}
      </span>
      <span className="spacer" />
      <button onClick={onStandup}>Standup</button>
      <button onClick={onWrapUp}>Wrap up</button>
      {showJira && <button onClick={onJira}>Jira</button>}
      {showLinear && <button onClick={onLinear}>Linear</button>}
      {showGithub && <button onClick={onGithub}>GitHub</button>}
      <button onClick={onSettings} aria-label="Settings">
        ⚙ Settings
      </button>
    </div>
  )
}

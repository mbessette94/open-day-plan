import { TABS } from '../tabs'

interface Props {
  active: number
  onChange: (i: number) => void
}

export function Tabs({ active, onChange }: Props): React.JSX.Element {
  return (
    <div className="tabs" role="tablist">
      {TABS.map((t, i) => (
        <button
          key={t.label}
          role="tab"
          aria-selected={i === active}
          className={i === active ? 'active' : ''}
          onClick={() => onChange(i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

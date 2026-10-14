export type LinkKind = 'github' | 'jira' | 'linear' | 'link'

export interface LinkBadge {
  kind: LinkKind
  label: string // e.g. "repo#123", "ENG-42"
  detail: string | null // e.g. "PR", "Issue"
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/

/** Turn a URL into a badge description. Pure string parsing: no integration calls. */
export function parseLink(url: string): LinkBadge {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { kind: 'link', label: url, detail: null }
  }
  const host = u.hostname.replace(/^www\./, '')
  const parts = u.pathname.split('/').filter(Boolean)

  if (host === 'github.com' && parts.length >= 2) {
    const [owner, repo, type, num] = parts
    if ((type === 'pull' || type === 'issues') && /^\d+$/.test(num ?? '')) {
      return { kind: 'github', label: `${repo}#${num}`, detail: type === 'pull' ? 'PR' : 'Issue' }
    }
    return { kind: 'github', label: `${owner}/${repo}`, detail: null }
  }

  if (host === 'linear.app') {
    const i = parts.indexOf('issue')
    if (i !== -1 && ISSUE_KEY.test(parts[i + 1] ?? '')) {
      return { kind: 'linear', label: parts[i + 1], detail: 'Issue' }
    }
  }

  // Jira: /browse/KEY-1 on any host, or a board/backlog URL carrying ?selectedIssue=KEY-1
  const browse = parts.indexOf('browse')
  if (browse !== -1 && ISSUE_KEY.test(parts[browse + 1] ?? '')) {
    return { kind: 'jira', label: parts[browse + 1], detail: 'Issue' }
  }
  const selected = u.searchParams.get('selectedIssue')
  if (host.endsWith('atlassian.net') && selected && ISSUE_KEY.test(selected)) {
    return { kind: 'jira', label: selected, detail: 'Issue' }
  }

  return { kind: 'link', label: host + (parts.length ? `/${parts.join('/')}` : ''), detail: null }
}

// ---- refs: structured link info used to match a URL to a configured integration ----

export interface JiraRef {
  kind: 'jira'
  host: string
  key: string
}
export interface LinearRef {
  kind: 'linear'
  workspace: string
  key: string
}
export interface GithubRef {
  kind: 'github'
  host: string
  owner: string
  repo: string
  type: 'pull' | 'issues' | null
  number: number | null
}
export type LinkRef = JiraRef | LinearRef | GithubRef

export function parseLinkRef(url: string): LinkRef | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const parts = u.pathname.split('/').filter(Boolean)

  if (host === 'linear.app') {
    const i = parts.indexOf('issue')
    if (i === 1 && ISSUE_KEY.test(parts[2] ?? '')) {
      return { kind: 'linear', workspace: parts[0].toLowerCase(), key: parts[2] }
    }
    return null
  }

  const browse = parts.indexOf('browse')
  if (browse !== -1 && ISSUE_KEY.test(parts[browse + 1] ?? '')) {
    return { kind: 'jira', host, key: parts[browse + 1] }
  }
  const selected = u.searchParams.get('selectedIssue')
  if (host.endsWith('atlassian.net') && selected && ISSUE_KEY.test(selected)) {
    return { kind: 'jira', host, key: selected }
  }

  if (
    parts.length >= 4 &&
    (parts[2] === 'pull' || parts[2] === 'issues') &&
    /^\d+$/.test(parts[3])
  ) {
    return {
      kind: 'github',
      host,
      owner: parts[0],
      repo: parts[1],
      type: parts[2],
      number: Number(parts[3])
    }
  }
  if (host === 'github.com' && parts.length >= 2) {
    return { kind: 'github', host, owner: parts[0], repo: parts[1], type: null, number: null }
  }
  return null
}

interface Matchable {
  id: string
  kind: string
  enabled: boolean
  config: Record<string, unknown>
}

function bareHost(site: unknown): string {
  return String(site ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
}

/** Web host for a GitHub API base: api.github.com -> github.com, ghe.example.com/api/v3 -> ghe.example.com. */
export function githubWebHost(apiBase: unknown): string {
  const host = bareHost(apiBase || 'https://api.github.com')
  return host === 'api.github.com' ? 'github.com' : host
}

/** Id of the first enabled integration that should handle this link, or null. */
export function matchIntegration(ref: LinkRef, integrations: Matchable[]): string | null {
  for (const it of integrations) {
    if (!it.enabled || it.kind !== ref.kind) continue
    if (ref.kind === 'jira' && bareHost(it.config.site) === ref.host) return it.id
    if (ref.kind === 'linear') {
      const ws = String(it.config.workspace ?? '')
        .trim()
        .toLowerCase()
      if (!ws || ws === ref.workspace) return it.id
    }
    if (ref.kind === 'github' && githubWebHost(it.config.apiBase) === ref.host) {
      const owners = ((it.config.owners as string[] | undefined) ?? []).map((o) => o.toLowerCase())
      if (owners.length === 0 || owners.includes(ref.owner.toLowerCase())) return it.id
    }
  }
  return null
}

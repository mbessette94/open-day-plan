export type Weekday = 'su' | 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa'
export const WEEKDAYS: Weekday[] = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']

export type Context = 'work' | 'personal'

export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly'
  interval: number // every N days / weeks / months, >= 1
  byday?: Weekday[] // weekly only; empty/undefined = the anchor's weekday
}
export type Priority = 0 | 1 | 2 | 3

export interface UserSettings {
  timezone: string
  work_days: Weekday[]
  work_time_start: string // HH:MM
  work_time_end: string
  personal_time_start: string
  personal_time_end: string
  sync_minutes: number // how often integrations sync
  notify_enabled: boolean
  notify_lead_min: number // minutes of warning before scheduled tasks and meetings
  digest_time: string // HH:MM morning digest of what's due
  shutdown_time: string // HH:MM nudge to wrap up the day
  quick_hotkey: string // Electron accelerator, e.g. Control+Alt+Space
  launch_at_login: boolean
  backup_dir: string | null // null = automatic backups are off
  backup_keep: number
}

export interface DayRecord extends UserSettings {
  day: string // YYYY-MM-DD in the settings timezone
}

export interface Task {
  id: string
  parent: string | null
  context: Context
  title: string
  description: string // markdown
  priority: Priority | null
  completed_at: string | null // UTC instant
  assigned_date: string | null // YYYY-MM-DD: the local day the task belongs to
  scheduled_at: string | null // UTC instant: the planned start on the agenda
  duration_min: number // length of the scheduled block, multiple of 15
  due_date: string | null // YYYY-MM-DD
  recurrence: RecurrenceRule | null // completing the task creates the next occurrence
  is_project: boolean // epic/project: its subtasks are full tasks (prioritizable, schedulable)
  parent_title: string | null // computed on read
  subtask_total: number // computed on read
  subtask_done: number // computed on read
  created_at: string
  updated_at: string
}

export interface ActivityEntry {
  id: string
  created_at: string
  type: string // dotted name such as 'task.created' or 'comment' (see shared/activity.ts)
  action_taken: string // readable text rendered when it was written; the comment text for comments
  data: Record<string, unknown> | null // optional structured detail
  ref_id: string | null
  ref_title: string | null // title of the referenced task, computed on read
}

export interface TaskLink {
  id: string
  task_id: string
  url: string
  created_at: string
}

export interface TaskDetail {
  task: Task
  subtasks: Task[]
  links: TaskLink[]
  activity: ActivityEntry[] // events and comments for the task and its subtasks, newest first
}

export interface TaskUpdate {
  title?: string
  description?: string
  due_date?: string | null
  is_project?: boolean
  recurrence?: RecurrenceRule | null
}

export interface TaskCreate {
  context: Context
  title: string
  assigned_date: string | null // YYYY-MM-DD
  parent?: string // creates a subtask; context is taken from the parent
}

export interface TaskListQuery {
  context: Context
  day: string // YYYY-MM-DD the list is for
  dayStart: string // UTC instant, inclusive: bounds of `day`, used for completion times
  dayEnd: string // UTC instant, exclusive
  includeCarryover: boolean // also return incomplete tasks assigned before dayStart
  includeCompleted: boolean // false on 'tomorrow' tabs: finished tasks stay on today
}

export interface Api {
  settings: {
    get(): Promise<UserSettings>
    update(patch: Partial<UserSettings>): Promise<UserSettings>
  }
  tasks: {
    list(q: TaskListQuery): Promise<Task[]>
    create(input: TaskCreate): Promise<Task>
    backlog(context: Context): Promise<Task[]>
    get(id: string): Promise<TaskDetail>
    update(id: string, patch: TaskUpdate): Promise<void>
    /** Deletes the task and, if it has any, its subtasks. */
    delete(id: string): Promise<void>
    /** assignTo, when given, also moves the task onto that day. */
    setPriority(id: string, priority: Priority | null, assignTo?: string): Promise<void>
    setCompleted(id: string, completed: boolean): Promise<void>
    schedule(id: string, at: string | null): Promise<void>
    setDuration(id: string, minutes: number): Promise<void>
  }
  links: {
    add(taskId: string, url: string): Promise<void>
    remove(id: string): Promise<void>
    preview(url: string, force?: boolean): Promise<LinkPreview | null>
  }
  activity: {
    list(limit?: number): Promise<ActivityEntry[]>
    addNote(text: string): Promise<void>
    addComment(taskId: string, text: string): Promise<void>
  }
  days: {
    recordToday(): Promise<void>
  }
  integrations: {
    list(): Promise<Integration[]>
    save(input: IntegrationInput): Promise<Integration>
    remove(id: string): Promise<void>
    test(id: string): Promise<TestOutcome>
    syncNow(id: string): Promise<void>
    googleConnect(id: string): Promise<TestOutcome>
    listCalendars(id: string): Promise<CalendarListResult>
  }
  external: {
    list(integrationId: string): Promise<ExternalListResult>
    jiraSubtasks(taskId: string): Promise<JiraSubtasksResult>
    addJiraSubtasks(
      taskId: string,
      integrationId: string,
      items: Pick<ExternalIssue, 'external_id' | 'key' | 'title' | 'url' | 'due_date'>[]
    ): Promise<void>
    addAsTask(
      integrationId: string,
      item: Pick<ExternalIssue, 'external_id' | 'key' | 'title' | 'url'> &
        Partial<Pick<ExternalIssue, 'due_date'>>,
      context: Context
    ): Promise<void>
  }
  calendar: {
    events(
      context: Context,
      day: string,
      dayStart: string,
      dayEnd: string
    ): Promise<CalendarEvent[]>
  }
  backup: {
    info(): Promise<BackupInfo>
    chooseFolder(): Promise<BackupInfo>
    disable(): Promise<BackupInfo>
    setKeep(keep: number): Promise<BackupInfo>
    now(): Promise<BackupResult>
    restore(): Promise<BackupResult>
    exportJson(): Promise<BackupResult>
    exportMarkdown(): Promise<BackupResult>
  }
  capture: {
    submit(text: string, hint?: CaptureHint): Promise<CaptureResult | null>
    hide(): Promise<void>
    hotkeyStatus(): Promise<HotkeyStatus>
  }
  standup: {
    get(context: Context): Promise<StandupData>
  }
  review: {
    get(): Promise<ReviewData>
    apply(actions: ReviewAction[]): Promise<void>
  }
  onDataChanged(cb: () => void): () => void
  onOpen(cb: (action: UiAction) => void): () => void
  onCaptureFocus(cb: () => void): () => void
}

// ---- integrations ----

export type IntegrationKind = 'jira' | 'linear' | 'github' | 'google_calendar' | 'caldav'

export interface JiraConfig {
  site: string // e.g. acme.atlassian.net
  email: string
  jql: string
  jql_valid: boolean
}
export interface LinearConfig {
  workspace: string // URL slug, e.g. "acme"; blank matches any workspace
}
export interface GithubConfig {
  apiBase: string // https://api.github.com, or https://ghe.example.com/api/v3
  owners: string[] // only preview links under these owners; empty = all
  pr_filter: string // search qualifiers, e.g. "review-requested:@me"; blank hides the PR list
}
export interface CalendarSelection {
  id: string
  name: string
  context: Context
  block_target?: boolean // work calendars only; at most one across integrations gets the blocks
}
export interface CalendarConfig {
  client_id?: string // google
  server_url?: string // caldav
  username?: string // caldav
  calendars: CalendarSelection[]
  focus_calendar_id?: string // google: the calendar provisioned for Focus time blocks
}

export interface Integration {
  id: string
  kind: IntegrationKind
  name: string
  config: Record<string, unknown>
  enabled: boolean
  has_secret: boolean
  connected: boolean // google: a refresh token is stored
  last_sync_at: string | null
  last_error: string | null
  created_at: string
}

export interface IntegrationInput {
  id?: string
  kind: IntegrationKind
  name: string
  config: Record<string, unknown>
  secret?: string // blank/undefined keeps the stored one
  enabled?: boolean
}

export interface TestOutcome {
  ok: boolean
  message: string
}

export type StatusTone = 'todo' | 'progress' | 'done' | 'closed' | 'merged' | 'open' | 'draft'

export interface LinkPreview {
  kind: 'jira' | 'linear' | 'github'
  key: string // ENG-42, repo#12
  type: string | null // Issue, PR
  title: string
  status: string
  tone: StatusTone
  assignee: string | null
  url: string
  integration_name: string
}

export interface ExternalIssue {
  external_id: string
  key: string
  title: string
  status: string
  tone: StatusTone
  assignee: string | null
  due_date: string | null // YYYY-MM-DD, when the source has one
  url: string
  added: boolean
}

export interface CalendarEvent {
  id: string
  integration_id: string
  calendar_id: string
  title: string
  start_at: string // ISO UTC, or YYYY-MM-DD when all_day
  end_at: string // end is exclusive
  all_day: boolean
  location: string | null
  url: string | null
  context: Context
  block: 'personal' | null // synthesized "Personal commitment" on the work agenda
}

export type CalendarListResult =
  { ok: true; calendars: { id: string; name: string }[] } | { ok: false; message: string }

export type ExternalListResult =
  { ok: true; items: ExternalIssue[] } | { ok: false; message: string }

export type JiraSubtasksResult =
  | {
      ok: true
      issue: { integrationId: string; key: string; url: string } | null // null: no linked Jira issue
      items: ExternalIssue[]
    }
  | { ok: false; message: string }

// ---- standup and end-of-day review ----

export interface StandupData {
  context: Context
  today: string // YYYY-MM-DD
  previousDay: string // the previous work day (work) or yesterday (personal)
  done: string[] // titles completed on previousDay
  comments: { task: string; text: string }[] // comments added on previousDay
  todayItems: {
    title: string
    time: string | null
    priority: Priority | null
    due: string | null
  }[]
  meetings: { count: number; first: string | null } // timed events today; first start as HH:MM
  blockers: { title: string; reason: 'delegated' | 'overdue'; due: string | null }[]
}

export type ReviewChoice = 'keep' | 'tomorrow' | 'backlog' | 'done'
export interface ReviewAction {
  id: string
  choice: ReviewChoice
}
export interface ReviewData {
  day: string
  completedCount: number
  reviewedAt: string | null // when today was last wrapped up
  tasks: Task[] // unfinished tasks on today's lists, both contexts
}

/** Something the main process asks the planner window to open (notification clicks, tray menu). */
export type UiAction = { type: 'task'; id: string } | { type: 'standup' } | { type: 'wrapup' }

export interface CaptureHint {
  context: Context // used when the text has no #tag
  day: string // YYYY-MM-DD a new task lands on when the text names no day
}
export interface CaptureResult {
  kind: 'note' | 'task'
  label: string // the note text or task title, for the confirmation
}
export interface HotkeyStatus {
  accelerator: string
  ok: boolean
  error: string | null
}

export interface BackupInfo {
  dir: string | null // null: automatic backups are off
  keep: number
  lastBackupAt: string | null
  lastError: string | null
  files: { name: string; size: number; modified: string }[] // newest first
}
export interface BackupResult {
  ok: boolean
  message: string
  needsFolder?: boolean // "back up now" was asked for with no folder chosen
}

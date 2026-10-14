/**
 * Activity log entry types. The log row also stores readable text, so these exist for filtering,
 * rename-safe display and analytics. Add new types here; the database does not constrain them.
 */
export const ACTIVITY = {
  note: 'note',
  comment: 'comment',
  taskCreated: 'task.created',
  taskRenamed: 'task.renamed',
  taskDescribed: 'task.described',
  taskDue: 'task.due',
  taskRepeatSet: 'task.repeat_set',
  taskRepeated: 'task.repeated',
  taskMoved: 'task.moved',
  taskCompleted: 'task.completed',
  taskReopened: 'task.reopened',
  taskScheduled: 'task.scheduled',
  taskUnscheduled: 'task.unscheduled',
  taskDuration: 'task.duration',
  taskProject: 'task.project',
  taskDeleted: 'task.deleted',
  taskRolled: 'task.rolled',
  linkAdded: 'link.added',
  linkRemoved: 'link.removed',
  reviewWrapped: 'review.wrapped',
  externalAdded: 'external.added',
  externalResolved: 'external.resolved',
  externalMergedUntracked: 'external.merged_untracked',
  captureViaUrl: 'capture.url'
} as const

export type ActivityType = (typeof ACTIVITY)[keyof typeof ACTIVITY]

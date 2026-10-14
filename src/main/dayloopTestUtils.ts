import { v7 as uuidv7 } from 'uuid'
import { getDb } from './db'

/** Insert a comment with a chosen timestamp (the real API stamps "now"). */
export function addComment(taskId: string, text: string, createdAt: string): void {
  getDb()
    .prepare(
      "INSERT INTO activity_log (id, created_at, type, action_taken, ref_id) VALUES (?, ?, 'comment', ?, ?)"
    )
    .run(uuidv7(), createdAt, text, taskId)
}

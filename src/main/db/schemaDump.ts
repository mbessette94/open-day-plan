import type Database from 'better-sqlite3'

const ORDER: Record<string, number> = { table: 0, index: 1, trigger: 2, view: 3 }

/** A stable text rendering of the schema (tables, indexes, triggers), for the snapshot test. */
export function schemaDump(db: Database.Database): string {
  const rows = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL"
    )
    .all() as { type: string; name: string; sql: string }[]
  rows.sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || a.name.localeCompare(b.name))
  return rows.map((r) => `-- ${r.type} ${r.name}\n${r.sql.trim()};\n`).join('\n')
}

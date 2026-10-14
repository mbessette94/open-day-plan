import { safeStorage } from 'electron'
import { v7 as uuidv7 } from 'uuid'
import type { Integration, IntegrationInput, IntegrationKind } from '../../shared/types'
import { getDb } from '../db'

/** An integration with its decrypted secret. Never sent to the renderer. */
export interface IntegrationRecord {
  id: string
  kind: IntegrationKind
  name: string
  config: Record<string, unknown>
  secret: string | null
  enabled: boolean
  last_sync_at: string | null
  last_error: string | null
  created_at: string
}

interface Row {
  id: string
  kind: IntegrationKind
  name: string
  config: string
  secret: Buffer | null
  enabled: number
  last_sync_at: string | null
  last_error: string | null
  created_at: string
}

function decrypt(blob: Buffer | null): string | null {
  if (!blob) return null
  try {
    return safeStorage.decryptString(blob)
  } catch {
    return null
  }
}

function toRecord(r: Row): IntegrationRecord {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    config: JSON.parse(r.config) as Record<string, unknown>,
    secret: decrypt(r.secret),
    enabled: r.enabled !== 0,
    last_sync_at: r.last_sync_at,
    last_error: r.last_error,
    created_at: r.created_at
  }
}

function toPublic(rec: IntegrationRecord): Integration {
  let connected = rec.secret !== null
  if (rec.kind === 'google_calendar')
    connected = Boolean(parseGoogleSecret(rec.secret).refresh_token)
  return {
    id: rec.id,
    kind: rec.kind,
    name: rec.name,
    config: rec.config,
    enabled: rec.enabled,
    has_secret: rec.secret !== null,
    connected,
    last_sync_at: rec.last_sync_at,
    last_error: rec.last_error,
    created_at: rec.created_at
  }
}

/** Google stores {client_secret, refresh_token} as JSON in the secret slot. */
export interface GoogleSecret {
  client_secret?: string
  refresh_token?: string
}
export function parseGoogleSecret(secret: string | null): GoogleSecret {
  if (!secret) return {}
  try {
    return JSON.parse(secret) as GoogleSecret
  } catch {
    return {}
  }
}

export function listRecords(): IntegrationRecord[] {
  const rows = getDb().prepare('SELECT * FROM integration ORDER BY created_at, id').all() as Row[]
  return rows.map(toRecord)
}

export function getRecord(id: string): IntegrationRecord {
  const row = getDb().prepare('SELECT * FROM integration WHERE id = ?').get(id) as Row | undefined
  if (!row) throw new Error(`Integration not found: ${id}`)
  return toRecord(row)
}

export function listIntegrations(): Integration[] {
  return listRecords().map(toPublic)
}

function encrypt(secret: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable, so credentials cannot be saved')
  }
  return safeStorage.encryptString(secret)
}

export function saveIntegration(input: IntegrationInput): Integration {
  const db = getDb()
  const existing = input.id ? getRecord(input.id) : null
  if (existing && existing.kind !== input.kind) throw new Error('Cannot change an integration kind')

  // blank secret keeps the stored one; google merges the new client secret into its JSON
  let secret: string | null = existing?.secret ?? null
  const provided = input.secret?.trim()
  if (provided) {
    secret =
      input.kind === 'google_calendar'
        ? JSON.stringify({ ...parseGoogleSecret(secret), client_secret: provided })
        : provided
  }
  const blob = secret === null ? null : encrypt(secret)
  const id = existing?.id ?? uuidv7()
  const config = JSON.stringify(input.config)
  const enabled = (input.enabled ?? existing?.enabled ?? true) ? 1 : 0
  if (existing) {
    db.prepare(
      'UPDATE integration SET name = ?, config = ?, secret = ?, enabled = ? WHERE id = ?'
    ).run(input.name, config, blob, enabled, id)
  } else {
    db.prepare(
      `INSERT INTO integration (id, kind, name, config, secret, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.kind, input.name, config, blob, enabled, new Date().toISOString())
  }
  return toPublic(getRecord(id))
}

export function setGoogleRefreshToken(id: string, refreshToken: string): void {
  const rec = getRecord(id)
  const secret = JSON.stringify({ ...parseGoogleSecret(rec.secret), refresh_token: refreshToken })
  getDb().prepare('UPDATE integration SET secret = ? WHERE id = ?').run(encrypt(secret), id)
}

export function patchConfig(id: string, patch: Record<string, unknown>): void {
  const rec = getRecord(id)
  getDb()
    .prepare('UPDATE integration SET config = ? WHERE id = ?')
    .run(JSON.stringify({ ...rec.config, ...patch }), id)
}

export function setSyncStatus(
  id: string,
  status: { synced?: boolean; error: string | null }
): void {
  getDb()
    .prepare(
      'UPDATE integration SET last_error = ?, last_sync_at = COALESCE(?, last_sync_at) WHERE id = ?'
    )
    .run(status.error, status.synced ? new Date().toISOString() : null, id)
}

export function removeIntegration(id: string): void {
  getDb().prepare('DELETE FROM integration WHERE id = ?').run(id)
}

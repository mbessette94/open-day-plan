import { beforeEach, describe, expect, it, vi } from 'vitest'
import { electronMock } from './testUtils'

vi.mock('electron', () => electronMock)

const upsert = vi.fn()
const del = vi.fn()
const ensure = vi.fn()
vi.mock('./providers', () => ({
  fetchCalendarEvents: vi.fn(),
  upsertBlockProvider: (...a: unknown[]) => upsert(...a),
  deleteBlockProvider: (...a: unknown[]) => del(...a),
  ensureCalendarProvider: (...a: unknown[]) => ensure(...a)
}))

import { getDb, openDb } from '../db'
import { updateSettings } from '../db/settings'
import { createTask, setCompleted } from '../db/tasks'
import { desiredBlocks, reconcileBlocks } from './blocks'
import { IntegrationError } from './http'
import { getRecord, saveIntegration } from './registry'

// Tuesday 2026-10-13, 08:00 New York (EDT). Work hours 09:00-17:00 = 13:00Z-21:00Z.
const NOW = new Date('2026-10-13T12:00:00.000Z')
const LATER = new Date('2026-10-13T23:00:00.000Z')

let integrationId: string
function setup(blockTarget = true): void {
  const i = saveIntegration({
    kind: 'caldav',
    name: 'C',
    config: {
      calendars: [
        { id: 'w', name: 'Work', context: 'work', block_target: blockTarget },
        { id: 'p', name: 'Home', context: 'personal' }
      ]
    },
    secret: 'pw'
  })
  integrationId = i.id
}

let n = 0
function event(
  cal: string,
  start: string | null,
  end: string | null,
  allDay?: [string, string]
): void {
  getDb()
    .prepare(
      `INSERT INTO calendar_event (id, integration_id, calendar_id, external_id, title,
         start_at, end_at, start_date, end_date, synced_at)
       VALUES (?, ?, ?, ?, 'x', ?, ?, ?, ?, '2026-10-13T00:00:00.000Z')`
    )
    .run(
      `e${++n}`,
      integrationId,
      cal,
      `ext${n}`,
      start,
      end,
      allDay?.[0] ?? null,
      allDay?.[1] ?? null
    )
}

function scheduled(at: string, minutes: number, context: 'work' | 'personal' = 'work'): string {
  const t = createTask({ context, title: 'secret task name', assigned_date: null })
  getDb()
    .prepare('UPDATE task SET scheduled_at = ?, duration_min = ? WHERE id = ?')
    .run(at, minutes, t.id)
  return t.id
}

beforeEach(() => {
  openDb(':memory:')
  updateSettings({ timezone: 'America/New_York' })
  upsert.mockReset().mockImplementation(async (_r, _c, b: { id: string }) => `remote-${b.id}`)
  del.mockReset().mockResolvedValue(undefined)
  ensure.mockReset().mockResolvedValue(null) // a provider that cannot create calendars
  setup()
})

describe('desiredBlocks', () => {
  it('makes a block from each scheduled, unfinished work task', () => {
    const open = scheduled('2026-10-13T18:00:00.000Z', 45)
    const done = scheduled('2026-10-13T19:00:00.000Z', 30)
    setCompleted(done, true)
    scheduled('2026-10-13T20:00:00.000Z', 30, 'personal')
    createTask({ context: 'work', title: 'not scheduled', assigned_date: null })
    expect(desiredBlocks(NOW)).toEqual([
      {
        kind: 'focus',
        source_key: open,
        start_at: '2026-10-13T18:00:00.000Z',
        end_at: '2026-10-13T18:45:00.000Z'
      }
    ])
  })

  it('clips personal events to work hours and ignores the rest', () => {
    event('p', '2026-10-13T12:00:00.000Z', '2026-10-13T14:00:00.000Z') // starts before 9am
    event('p', '2026-10-13T22:00:00.000Z', '2026-10-13T23:00:00.000Z') // after work
    event('p', '2026-10-17T15:00:00.000Z', '2026-10-17T16:00:00.000Z') // Saturday
    event('p', null, null, ['2026-10-14', '2026-10-15']) // all-day
    event('w', '2026-10-13T15:00:00.000Z', '2026-10-13T16:00:00.000Z') // a work meeting
    const blocks = desiredBlocks(NOW)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'personal',
      start_at: '2026-10-13T13:00:00.000Z',
      end_at: '2026-10-13T14:00:00.000Z'
    })
  })

  it('splits a personal event that spans two work days, one block per day', () => {
    event('p', '2026-10-13T20:00:00.000Z', '2026-10-14T14:00:00.000Z')
    const [a, b] = desiredBlocks(NOW)
    expect([a.start_at, a.end_at]).toEqual(['2026-10-13T20:00:00.000Z', '2026-10-13T21:00:00.000Z'])
    expect([b.start_at, b.end_at]).toEqual(['2026-10-14T13:00:00.000Z', '2026-10-14T14:00:00.000Z'])
    expect(a.source_key).not.toBe(b.source_key)
  })
})

describe('reconcileBlocks', () => {
  it('creates generic busy blocks once, then leaves unchanged ones alone', async () => {
    scheduled('2026-10-13T18:00:00.000Z', 30)
    event('p', '2026-10-13T14:00:00.000Z', '2026-10-13T15:00:00.000Z')
    await reconcileBlocks(NOW)
    const titles = upsert.mock.calls.map((c) => c[2].title).sort()
    expect(titles).toEqual(['Focus time', 'Personal commitment'])
    expect(upsert.mock.calls[0][1]).toBe('w')
    expect(JSON.stringify(upsert.mock.calls)).not.toContain('secret task name')
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM calendar_block').get()).toEqual({ n: 2 })

    upsert.mockClear()
    await reconcileBlocks(NOW)
    expect(upsert).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('moves a block when its task moves, and deletes it when the task is done early', async () => {
    const id = scheduled('2026-10-13T18:00:00.000Z', 30)
    await reconcileBlocks(NOW)
    const remote = upsert.mock.results[0] && (await upsert.mock.results[0].value)

    getDb()
      .prepare('UPDATE task SET scheduled_at = ? WHERE id = ?')
      .run('2026-10-13T19:00:00.000Z', id)
    upsert.mockClear()
    await reconcileBlocks(NOW)
    expect(upsert).toHaveBeenCalledOnce()
    expect(upsert.mock.calls[0][2]).toMatchObject({
      start_at: '2026-10-13T19:00:00.000Z',
      remote_id: remote
    })

    setCompleted(id, true)
    await reconcileBlocks(NOW)
    expect(del).toHaveBeenCalledWith(expect.anything(), 'w', remote)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM calendar_block').get()).toEqual({ n: 0 })
  })

  it('leaves a block that already ended on the calendar as history', async () => {
    const id = scheduled('2026-10-13T18:00:00.000Z', 30)
    await reconcileBlocks(NOW)
    setCompleted(id, true)
    await reconcileBlocks(LATER) // 7pm New York: the block ended at 2:30pm
    expect(del).not.toHaveBeenCalled()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM calendar_block').get()).toEqual({ n: 0 })
  })

  it('removes upcoming blocks when the target is turned off', async () => {
    scheduled('2026-10-13T18:00:00.000Z', 30)
    await reconcileBlocks(NOW)
    saveIntegration({
      id: integrationId,
      kind: 'caldav',
      name: 'C',
      config: { calendars: [{ id: 'w', name: 'Work', context: 'work' }] }
    })
    await reconcileBlocks(NOW)
    expect(del).toHaveBeenCalledOnce()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM calendar_block').get()).toEqual({ n: 0 })
  })

  it('writes nothing when no calendar is the target', async () => {
    saveIntegration({
      id: integrationId,
      kind: 'caldav',
      name: 'C',
      config: { calendars: [{ id: 'w', name: 'Work', context: 'work' }] }
    })
    scheduled('2026-10-13T18:00:00.000Z', 30)
    await reconcileBlocks(NOW)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('records a failure on the integration, keeps going, and clears it on success', async () => {
    scheduled('2026-10-13T18:00:00.000Z', 30)
    upsert.mockRejectedValue(new IntegrationError('Reconnect with Google to allow writing'))
    await reconcileBlocks(NOW)
    expect(getRecord(integrationId).last_error).toBe(
      'Calendar blocks: Reconnect with Google to allow writing'
    )
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM calendar_block').get()).toEqual({ n: 0 })

    upsert.mockImplementation(async (_r, _c, b: { id: string }) => `remote-${b.id}`)
    await reconcileBlocks(NOW)
    expect(getRecord(integrationId).last_error).toBeNull()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM calendar_block').get()).toEqual({ n: 1 })
  })

  it('stops after the first auth failure instead of repeating the request', async () => {
    scheduled('2026-10-13T16:00:00.000Z', 30)
    scheduled('2026-10-13T17:00:00.000Z', 30)
    scheduled('2026-10-13T18:00:00.000Z', 30)
    upsert.mockRejectedValue(new IntegrationError('Authentication failed (HTTP 403)'))
    await reconcileBlocks(NOW)
    expect(upsert).toHaveBeenCalledOnce()
  })
})

describe('horizon', () => {
  it('covers the next four weeks and no further', () => {
    const near = scheduled('2026-11-09T18:00:00.000Z', 30) // 27 days out
    scheduled('2026-11-20T18:00:00.000Z', 30) // 38 days out
    event('p', '2026-11-05T15:00:00.000Z', '2026-11-05T16:00:00.000Z') // a Thursday, 23 days out
    event('p', '2026-11-30T15:00:00.000Z', '2026-11-30T16:00:00.000Z')
    expect(desiredBlocks(NOW).map((b) => b.kind)).toEqual(['focus', 'personal'])
    expect(desiredBlocks(NOW)[0].source_key).toBe(near)
  })
})

describe('focus calendar', () => {
  it('provisions its own calendar once and sends focus there, personal to the work calendar', async () => {
    ensure.mockResolvedValue('focus-cal')
    scheduled('2026-10-13T18:00:00.000Z', 30)
    event('p', '2026-10-13T14:00:00.000Z', '2026-10-13T15:00:00.000Z')
    await reconcileBlocks(NOW)
    const where = Object.fromEntries(upsert.mock.calls.map((c) => [c[2].kind, c[1]]))
    expect(where).toEqual({ focus: 'focus-cal', personal: 'w' })
    expect(ensure).toHaveBeenCalledOnce()
    expect(ensure.mock.calls[0].slice(1)).toEqual(['Open Day Plan: Focus time', 'America/New_York'])
    expect(getRecord(integrationId).config.focus_calendar_id).toBe('focus-cal')

    scheduled('2026-10-13T19:00:00.000Z', 30)
    await reconcileBlocks(NOW)
    expect(ensure).toHaveBeenCalledOnce() // remembered, not created again
  })

  it('does not create the calendar until a focus block is needed', async () => {
    ensure.mockResolvedValue('focus-cal')
    event('p', '2026-10-13T14:00:00.000Z', '2026-10-13T15:00:00.000Z')
    await reconcileBlocks(NOW)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('keeps focus off the work calendar when provisioning fails, and retries', async () => {
    ensure.mockRejectedValue(new IntegrationError('Reconnect with Google to allow writing'))
    scheduled('2026-10-13T18:00:00.000Z', 30)
    event('p', '2026-10-13T14:00:00.000Z', '2026-10-13T15:00:00.000Z')
    await reconcileBlocks(NOW)
    expect(upsert.mock.calls.map((c) => c[2].kind)).toEqual(['personal'])
    expect(getRecord(integrationId).last_error).toContain('Reconnect')

    ensure.mockResolvedValue('focus-cal')
    await reconcileBlocks(NOW)
    expect(upsert.mock.calls.map((c) => [c[2].kind, c[1]])).toEqual([
      ['personal', 'w'],
      ['focus', 'focus-cal']
    ])
  })

  it('moves focus blocks that were on the work calendar over to the new calendar', async () => {
    scheduled('2026-10-13T18:00:00.000Z', 30)
    await reconcileBlocks(NOW) // no calendar creation available: lands on the work calendar
    expect(upsert.mock.calls[0][1]).toBe('w')
    const oldRemote = await upsert.mock.results[0].value

    ensure.mockResolvedValue('focus-cal')
    upsert.mockClear()
    await reconcileBlocks(NOW)
    expect(del).toHaveBeenCalledWith(expect.anything(), 'w', oldRemote)
    expect(upsert.mock.calls[0][1]).toBe('focus-cal') // and recreated there
  })

  it('keeps the provisioned id when the settings screen saves an older copy', () => {
    getDb()
      .prepare('UPDATE integration SET config = ? WHERE id = ?')
      .run(JSON.stringify({ calendars: [], focus_calendar_id: 'focus-cal' }), integrationId)
    saveIntegration({ id: integrationId, kind: 'caldav', name: 'C', config: { calendars: [] } })
    expect(getRecord(integrationId).config.focus_calendar_id).toBe('focus-cal')
  })
})

describe('block target', () => {
  it('keeps one target across integrations and only on work calendars', () => {
    const other = saveIntegration({
      kind: 'google_calendar',
      name: 'G',
      config: {
        calendars: [
          { id: 'a', name: 'A', context: 'work', block_target: true },
          { id: 'b', name: 'B', context: 'personal', block_target: true }
        ]
      }
    })
    const cals = (id: string): { id: string; block_target?: boolean }[] =>
      (getRecord(id).config.calendars as { id: string; block_target?: boolean }[]) ?? []
    expect(cals(other.id).find((c) => c.id === 'a')?.block_target).toBe(true)
    expect(cals(other.id).find((c) => c.id === 'b')?.block_target).toBeUndefined()
    expect(cals(integrationId).some((c) => c.block_target)).toBe(false) // moved off the first one
  })
})

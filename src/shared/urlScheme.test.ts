import { describe, expect, it } from 'vitest'
import { MAX_URL_TEXT, createRateLimiter, parseUrlAction } from './urlScheme'

describe('parseUrlAction', () => {
  it('parses note, add, capture and open', () => {
    expect(parseUrlAction('opendayplan://note?text=talked%20to%20Sam')).toEqual({
      type: 'note',
      text: 'talked to Sam'
    })
    expect(parseUrlAction('opendayplan://add?text=%21%31%20call%20vendor%20tomorrow')).toEqual({
      type: 'add',
      text: '!1 call vendor tomorrow'
    })
    expect(parseUrlAction('opendayplan://capture')).toEqual({ type: 'capture' })
    const id = '0198f3a2-7b1c-7d4e-9a10-3f5b6c7d8e9f'
    expect(parseUrlAction(`opendayplan://open?task=${id}`)).toEqual({ type: 'open', id })
  })

  it('rejects other schemes, unknown actions, empty text and malformed ids', () => {
    expect(parseUrlAction('https://example.com/note?text=hi')).toBeNull()
    expect(parseUrlAction('opendayplan://delete?text=hi')).toBeNull()
    expect(parseUrlAction('opendayplan://note?text=%20%20')).toBeNull()
    expect(parseUrlAction('opendayplan://note')).toBeNull()
    expect(parseUrlAction("opendayplan://open?task=1'%20OR%201=1")).toBeNull()
    expect(parseUrlAction('not a url')).toBeNull()
  })

  it('caps very long text', () => {
    const r = parseUrlAction(`opendayplan://note?text=${'a'.repeat(5000)}`)
    expect(r?.type === 'note' && r.text.length).toBe(MAX_URL_TEXT)
  })
})

describe('createRateLimiter', () => {
  it('allows N calls per window and recovers afterwards', () => {
    const allow = createRateLimiter(3, 1000)
    expect([allow(0), allow(100), allow(200), allow(300)]).toEqual([true, true, true, false])
    expect(allow(1001)).toBe(true) // the first hit has aged out
    expect(allow(1002)).toBe(false) // 200 and 300 still count, plus 1001
  })
})

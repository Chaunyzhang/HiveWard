import { describe, expect, it } from 'vitest'
import {
  formatHiveWardSessionAddress,
  isHiveWardSessionId,
  parseHiveWardSessionAddress
} from './hiveward-session-address'
import { testHiveWardSessionId } from './hiveward-session-address-test-fixture'

const SESSION_ID = testHiveWardSessionId('0b7e4c2a-5f1d-4e8a-9c3b-2d6f8a1e4b70')
const ADDRESS = `hiveward_session_id:${SESSION_ID}`

describe('HiveWard session address', () => {
  it('addresses an HiveWard session id as hiveward_session_id:<id> and parses the bare id back', () => {
    expect(formatHiveWardSessionAddress(SESSION_ID)).toBe(ADDRESS)
    expect(parseHiveWardSessionAddress(ADDRESS)).toBe(SESSION_ID)
    const parsed = parseHiveWardSessionAddress(ADDRESS)
    expect(parsed && formatHiveWardSessionAddress(parsed)).toBe(ADDRESS)
  })

  it('reads only the addressed spelling when parsing an address', () => {
    // A bare id is what the columns store, not an address.
    expect(parseHiveWardSessionAddress(SESSION_ID)).toBeNull()
    expect(parseHiveWardSessionAddress(null)).toBeNull()
    expect(parseHiveWardSessionAddress(undefined)).toBeNull()
    expect(parseHiveWardSessionAddress('')).toBeNull()
  })

  it.each([
    ['an unknown prefix', `pane:${SESSION_ID}`],
    ['the Run mailbox namespace', 'run:run_123'],
    ['the Dispatch mailbox namespace', 'dispatch:ctx_123'],
    ['an empty prefix', `:${SESSION_ID}`],
    ['an empty id', 'hiveward_session_id:'],
    ['an id with a separator', `hiveward_session_id:${SESSION_ID}:extra`],
    ['an id the session predicate rejects', 'hiveward_session_id:short'],
    ['a terminal handle', 'term_4f2c9a']
  ])('refuses %s', (_label, value) => {
    expect(parseHiveWardSessionAddress(value)).toBeNull()
  })

  it('no longer reads the retired session:<id> spelling as a session, as an address or a bare id', () => {
    expect(parseHiveWardSessionAddress(`session:${SESSION_ID}`)).toBeNull()
    expect(isHiveWardSessionId(`session:${SESSION_ID}`)).toBe(false)
  })

  it.each([
    ['a PTY terminal handle', 'term_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c'],
    ['a short PTY terminal handle', 'term_4f2c9a'],
    ['a structured-worker handle', 'structworker_4f2c9a1b-7d3e-4a5f-8b6c-9d0e1f2a3b4c']
  ])('never treats %s as an HiveWard session id', (_label, handle) => {
    // Handles share the session-id charset, so the session-record predicate alone would accept them.
    expect(isHiveWardSessionId(handle)).toBe(false)
    expect(parseHiveWardSessionAddress(`hiveward_session_id:${handle}`)).toBeNull()
  })

  it('validates an HiveWard session id with the session-record predicate', () => {
    expect(isHiveWardSessionId(SESSION_ID)).toBe(true)
    expect(isHiveWardSessionId('has space in it')).toBe(false)
    expect(isHiveWardSessionId('x'.repeat(129))).toBe(false)
  })
})

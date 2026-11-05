import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import {
  getHiveWardProfileDataFile,
  getHiveWardProfileStateDatabaseFile
} from '../../shared/profile-state-storage-paths'
import { serveProfileHasSshTargets } from './serve-profile-ssh-targets'

const TARGET = { id: 'ssh-1', label: 'box', host: 'box.example', port: 22, username: 'me' }
let userData = ''

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'hiveward-serve-ssh-targets-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

function writeIndex(profileId: string): void {
  writeFileSync(
    join(userData, 'hiveward-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
}

function writeSqliteProfile(profileId: string, state: Record<string, unknown>): void {
  mkdirSync(join(userData, 'profiles', profileId), { recursive: true })
  const opened = openProfileStateDatabase(
    getHiveWardProfileStateDatabaseFile(profileId, userData),
    profileId
  )
  importProfileStateJson(opened.db, JSON.stringify(state))
  opened.db.close()
}

describe('serveProfileHasSshTargets', () => {
  it('is false for a fresh install', () => {
    expect(serveProfileHasSshTargets(userData)).toBe(false)
  })

  it('reads the active SQLite profile', () => {
    writeIndex('work')
    writeSqliteProfile('work', { sshTargets: [TARGET] })
    expect(serveProfileHasSshTargets(userData)).toBe(true)
  })

  it('is false for an active SQLite profile with no targets', () => {
    writeIndex('work')
    writeSqliteProfile('work', { sshTargets: [], settings: {} })
    expect(serveProfileHasSshTargets(userData)).toBe(false)
  })

  it('reads an active JSON-only profile', () => {
    writeIndex('work')
    mkdirSync(join(userData, 'profiles', 'work'), { recursive: true })
    writeFileSync(
      getHiveWardProfileDataFile('work', userData),
      JSON.stringify({ sshTargets: [TARGET] })
    )
    expect(serveProfileHasSshTargets(userData)).toBe(true)
  })

  it('reads the legacy root profile when there is no profile index', () => {
    writeFileSync(join(userData, 'hiveward-data.json'), JSON.stringify({ sshTargets: [TARGET] }))
    expect(serveProfileHasSshTargets(userData)).toBe(true)
  })
})

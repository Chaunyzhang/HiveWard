import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hivewarddMigrationCutoverFixture as cutover } from './hivewardd-migration-cutover-fixture'
import {
  findHivewarddMigrationSourceCutoverForTarget,
  listHivewarddMigrationSourceCutovers,
  hivewarddMigrationCutoverJournalDirectory,
  removeHivewarddMigrationSourceCutover,
  writeHivewarddMigrationSourceCutover
} from './hivewardd-migration-cutover-journal'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'hivewardd-cutover-journal-'))
})
afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

const journalPath = (id: string) =>
  join(hivewarddMigrationCutoverJournalDirectory(userDataPath), `${id}.json`)

describe('migration cutover journal sidecar', () => {
  it('round-trips a cutover in an owner-only file', () => {
    writeHivewarddMigrationSourceCutover(userDataPath, cutover())
    expect(findHivewarddMigrationSourceCutoverForTarget(userDataPath, 'ssh-1')).toEqual(cutover())
    if (process.platform !== 'win32') {
      expect(statSync(journalPath('migration-1')).mode & 0o077).toBe(0)
    }
    removeHivewarddMigrationSourceCutover(userDataPath, 'migration-1')
    expect(listHivewarddMigrationSourceCutovers(userDataPath)).toEqual([])
  })

  it.each([
    ['corrupt JSON', '{not json'],
    ['a manifest bound to another target', JSON.stringify({ ...cutover(), sshTargetId: 'ssh-2' })],
    ['a tampered manifest', JSON.stringify({ ...cutover(), manifestSha256: 'f'.repeat(64) })],
    ['an unknown version', JSON.stringify({ ...cutover(), version: 2 })]
  ])('fails closed on %s', (_label, contents) => {
    mkdirSync(hivewarddMigrationCutoverJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('migration-1'), contents)
    expect(() => listHivewarddMigrationSourceCutovers(userDataPath)).toThrow('stays fenced')
  })

  it("reads a newer build's journal that adds an optional field", () => {
    mkdirSync(hivewarddMigrationCutoverJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('migration-1'), JSON.stringify({ ...cutover(), addedLater: true }))
    expect(listHivewarddMigrationSourceCutovers(userDataPath)).toEqual([cutover()])
  })

  it('serves repeat reads from cache yet sees a file rewritten behind its back', () => {
    writeHivewarddMigrationSourceCutover(userDataPath, cutover())
    const first = listHivewarddMigrationSourceCutovers(userDataPath)
    expect(listHivewarddMigrationSourceCutovers(userDataPath)[0]).toBe(first[0])
    writeFileSync(
      journalPath('migration-1'),
      JSON.stringify({ ...cutover(), phase: 'destination-staged' })
    )
    expect(listHivewarddMigrationSourceCutovers(userDataPath)[0]?.phase).toBe('destination-staged')
  })

  it('fails closed on a file whose name disagrees with its migration', () => {
    mkdirSync(hivewarddMigrationCutoverJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('other'), JSON.stringify(cutover()))
    expect(() => listHivewarddMigrationSourceCutovers(userDataPath)).toThrow('stays fenced')
  })

  it('ignores durable-write temporaries but refuses two journals for one target', () => {
    writeHivewarddMigrationSourceCutover(userDataPath, cutover())
    writeFileSync(join(hivewarddMigrationCutoverJournalDirectory(userDataPath), 'x.json.tmp'), '?')
    expect(listHivewarddMigrationSourceCutovers(userDataPath)).toHaveLength(1)
    writeHivewarddMigrationSourceCutover(userDataPath, cutover('migration-2'))
    expect(() => findHivewarddMigrationSourceCutoverForTarget(userDataPath, 'ssh-1')).toThrow(
      'journals name SSH target'
    )
  })

  it('bounds concurrent migrations but rewrites an existing one', () => {
    for (const index of [1, 2, 3, 4]) {
      writeHivewarddMigrationSourceCutover(userDataPath, cutover(`m-${index}`, `ssh-${index}`))
    }
    expect(() => writeHivewarddMigrationSourceCutover(userDataPath, cutover('m-5', 'ssh-5'))).toThrow(
      'capacity'
    )
    writeHivewarddMigrationSourceCutover(userDataPath, {
      ...cutover('m-1', 'ssh-1'),
      phase: 'destination-staged'
    })
    expect(findHivewarddMigrationSourceCutoverForTarget(userDataPath, 'ssh-1')?.phase).toBe(
      'destination-staged'
    )
  })
})

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { hashHivewarddLauncher } from './hivewardd-build-identity'

let directory = ''
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hiveward-entry-identity-'))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('preserves an older single-entry build identity for rollback', () => {
  const entry = join(directory, 'hivewardd.js')
  writeFileSync(entry, 'old-server')
  expect(hashHivewarddLauncher(entry)).toBe(
    createHash('sha256').update('old-server').digest('hex').slice(0, 16)
  )
})

it('keeps the launcher hash older clients expect for both split entry paths', () => {
  const launcher = join(directory, 'hivewardd.js')
  const server = join(directory, 'hivewardd-server.js')
  writeFileSync(launcher, 'launcher-a')
  writeFileSync(server, 'server-a')
  const first = hashHivewarddLauncher(launcher)
  expect(hashHivewarddLauncher(server)).toBe(first)
  expect(first).toBe(createHash('sha256').update('launcher-a').digest('hex').slice(0, 16))
  writeFileSync(launcher, 'launcher-b')
  expect(hashHivewarddLauncher(server)).not.toBe(first)
})

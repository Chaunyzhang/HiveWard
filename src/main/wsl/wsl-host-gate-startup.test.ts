import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeWslHostDeployment } from '../../shared/wsl-host-deployment-store'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { wslMoveJournalDirectory } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import { resetWslHostsGateForTests, wslHostsGateState } from './wsl-host-gate'
import { configureWslHostsGateFromDisk } from './wsl-host-gate-startup'

const STABLE = '1.4.2'

describe('WSL hosts gate startup promotion', () => {
  let userDataPath: string
  beforeEach(() => {
    vi.stubEnv('HIVEWARD_INTERNAL_WSL_HOSTS', undefined)
    userDataPath = mkdtempSync(join(tmpdir(), 'hiveward-wsl-gate-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    resetWslHostsGateForTests()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('stays closed and creates nothing for a profile that never had WSL work', () => {
    configureWslHostsGateFromDisk(userDataPath, STABLE)

    expect(wslHostsGateState()).toBe('closed')
    expect(existsSync(wslMoveJournalDirectory(userDataPath))).toBe(false)
  })

  it('serves a saved WSL host', () => {
    writeWslHostDeployment(userDataPath, 'wsl:ubuntu', {
      kind: 'wsl',
      distro: 'Ubuntu',
      localPort: 41000,
      remotePort: 6768,
      environmentId: 'wsl:ubuntu',
      createdAt: 1
    })
    configureWslHostsGateFromDisk(userDataPath, STABLE)

    expect(wslHostsGateState()).toBe('serve-only')
  })

  it('serves a committed move', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    configureWslHostsGateFromDisk(userDataPath, STABLE)

    expect(wslHostsGateState()).toBe('serve-only')
  })

  // Recovery must still reset an in-flight move whose host record is already gone.
  it('serves a move that never committed', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    configureWslHostsGateFromDisk(userDataPath, STABLE)

    expect(wslHostsGateState()).toBe('serve-only')
  })
})

it('删除的远程策略缓存不再阻断本地 WSL', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hiveward-policy-'))
  try {
    vi.stubEnv('HIVEWARD_INTERNAL_WSL_HOSTS', '1')
    writeFileSync(
      join(directory, 'wsl-hosts-policy-stable.json'),
      JSON.stringify({ version: 1, revision: 99, wslHosts: 'block', movedProjects: 'bring-back' })
    )
    configureWslHostsGateFromDisk(directory, '1.0.0')
    expect(wslHostsGateState()).toBe('open')
  } finally {
    vi.unstubAllEnvs()
    resetWslHostsGateForTests()
    rmSync(directory, { recursive: true, force: true })
  }
})

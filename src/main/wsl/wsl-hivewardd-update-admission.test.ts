import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { HivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import { recordHivewarddUpdateFailedThisLaunch } from '../managed-server/lifecycle/hivewardd-managed-update-failure-memory'
import type { ServeReadiness } from '../server/serve-readiness'

import type { HivewarddSlotOptions } from '../ssh/hivewardd-recovery-slot'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { admitWslHivewarddUpdate } from './wsl-hivewardd-update-admission'

const { adoptRunningHivewarddVersion, readHivewarddActivationRecord } = vi.hoisted(() => ({
  adoptRunningHivewarddVersion: vi.fn(),
  readHivewarddActivationRecord: vi.fn()
}))

vi.mock('../ssh/hivewardd-running-version-adoption', () => ({ adoptRunningHivewarddVersion }))
vi.mock('../managed-server/activation/hivewardd-activation-record-store', () => ({
  readHivewarddActivationRecord
}))

// Mixed versions between this desktop and a WSL distro's hivewardd: they update independently.
const OLDER = '1.5.0+aaaaaaaaaaaa'
const NEWER = '1.6.0+bbbbbbbbbbbb'
const slot: HivewarddSlotOptions = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
  conn: {} as HivewarddSlotOptions['conn'],
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/u',
  nodePath: '',
  userDataDir: '/home/u/.hiveward',
  bindHost: '127.0.0.1',
  port: 6768
}
const readiness: ServeReadiness = {
  runtimeId: 'wsl-runtime',
  boundEndpoint: '127.0.0.1:6768',
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled',
  pairing: { available: false, reason: 'disabled_by_operator', guidance: '' }
}
let hostSeq = 0

function running(version: string, appVersion: string): HivewarddActivationRecord {
  return {
    schemaVersion: 1,
    active: version,
    activeProduct: 'HiveWard',
    activeVersionFamily: 'hiveward',
    previous: null,
    activatedAt: '2026-10-01T00:00:00.000Z',
    snapshot: null,
    activeAppVersion: appVersion
  }
}

function admit(
  record: HivewarddActivationRecord,
  desktop: { candidateVersion: string; appVersion: string },
  options: { intent?: 'connect' | 'update' | 'force'; host?: { kind: 'wsl'; id: string } } = {}
) {
  return admitWslHivewarddUpdate({
    slot,
    record,
    ...desktop,
    host: options.host ?? { kind: 'wsl', id: `Ubuntu-${(hostSeq += 1)}` },
    intent: options.intent ?? 'connect'
  })
}

beforeEach(() => {
  adoptRunningHivewarddVersion.mockReset()
  readHivewarddActivationRecord.mockReset()
})

describe('WSL hivewardd admission across desktop and host versions', () => {
  describe('an older desktop meets the hivewardd a newer desktop deployed', () => {
    const olderDesktop = { candidateVersion: OLDER, appVersion: '1.5.0' }

    it('keeps the newer hivewardd serving its terminals, with no Update hint', async () => {
      adoptRunningHivewarddVersion.mockResolvedValue({ version: NEWER, readiness, reprobe: vi.fn() })
      for (const intent of ['connect', 'update'] as const) {
        expect(await admit(running(NEWER, '1.6.0'), olderDesktop, { intent })).toEqual({
          action: 'serve',
          version: NEWER,
          readiness,
          deferredUpdate: null
        })
      }
      expect(adoptRunningHivewarddVersion).toHaveBeenCalledWith(slot, running(NEWER, '1.6.0'), OLDER)
    })
  })

  describe('a newer desktop meets the hivewardd an older desktop deployed', () => {
    const newerDesktop = { candidateVersion: NEWER, appVersion: '1.6.0' }

    it('keeps the older hivewardd serving after a failed update, and offers Force', async () => {
      const host = { kind: 'wsl' as const, id: 'Ubuntu-failed' }
      recordHivewarddUpdateFailedThisLaunch(host, { code: 'hivewardd_activation_failed', reason: 'boom' })
      adoptRunningHivewarddVersion.mockResolvedValue({ version: OLDER, readiness, reprobe: vi.fn() })
      expect(await admit(running(OLDER, '1.5.0'), newerDesktop, { host })).toEqual({
        action: 'serve',
        version: OLDER,
        readiness,
        deferredUpdate: {
          candidateVersion: NEWER,
          code: 'hivewardd_activation_failed',
          reason: 'boom',
          forceable: true
        }
      })
    })
  })
})

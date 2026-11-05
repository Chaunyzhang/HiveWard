import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../ssh/remote-exec/remote-exec-command'

vi.mock('../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('../ssh/hivewardd-local-build-hash', () => ({
  computeLocalHivewarddBuildHash: () => 'abc123def4567890'
}))

import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'
import { emptyHivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import { HivewarddActiveReadinessError, probeActiveHivewarddReadiness } from '../ssh/hivewardd-active-readiness'
import { hivewarddLivenessProbeCommand } from '../managed-server/install/hivewardd-remote-launch'
import { readHivewarddReadinessNowCommand } from '../managed-server/install/hivewardd-remote-readiness-wait'
import { probeWslActiveHivewardd, wslHivewarddActiveProbeCommand } from './wsl-hivewardd-active-probe'

const mockExec = vi.mocked(execCommand)
const VERSION = '0.1.0+aa'
const END = '\n__HIVEWARD_WSL_ACTIVE_PROBE_END__\n'
const host = getRemoteHostPlatform('linux-x64')
const context = {
  activationRecord: emptyHivewarddActivationRecord(),
  serverTarget: 'linux-x64-glibc' as const,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked, so the transport is never used.
  connection: {} as HivewarddHostTransport,
  host,
  remoteHome: '/home/u',
  target: { kind: 'wsl' as const, id: 'wsl:u', distro: 'U', label: 'U' },
  userDataDir: '/home/u/.hiveward'
}
const READY = JSON.stringify({
  type: 'hiveward_server_ready',
  schemaVersion: 1,
  runtimeId: 'r1',
  boundEndpoint: 'ws://127.0.0.1:6790',
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled',
  pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
  health: {
    buildHash: 'abc123def4567890',
    buildVersion: VERSION,
    nodeVersion: '20.11.0',
    nodeAbi: '115',
    platform: 'linux',
    arch: 'x64',
    pid: 1,
    terminalDaemon: {
      state: 'live',
      ownsFreshSessions: true,
      pid: 2,
      buildVersion: VERSION,
      entryPath: '/x/daemon-entry.js',
      protocolVersion: 3,
      selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 5 }
    }
  }
})

const probe = () => probeWslActiveHivewardd(context, '/local/hivewardd', VERSION)

beforeEach(() => {
  mockExec.mockReset()
})

describe('probeWslActiveHivewardd', () => {
  it('reads liveness, readiness and the pid in one exec, in that order', async () => {
    mockExec.mockResolvedValueOnce(`LIVE\n${END}${READY}\n${END}4242\n`)
    await expect(probe()).resolves.toMatchObject({ readiness: { runtimeId: 'r1' }, pid: 4242 })
    expect(mockExec).toHaveBeenCalledOnce()
    const command = wslHivewarddActiveProbeCommand(context, VERSION)
    const at = (needle: string) => command.lastIndexOf(needle)
    expect(at('hivewardd_alive')).toBeLessThan(at('head -c'))
    expect(at('head -c')).toBeLessThan(at("cat '/home/u/.hiveward-remote/hivewardd-0.1.0+aa/.hivewardd-pid'"))
  })

  it('judges the answers as the separate probes do', async () => {
    mockExec.mockResolvedValueOnce(`DEAD\n${END}${END}\n`)
    await expect(probe()).rejects.toMatchObject({ verdict: 'exited' })
    mockExec.mockResolvedValueOnce(`UNKNOWN\n${END}${READY}\n${END}4242\n`)
    await expect(probe()).rejects.toMatchObject({ verdict: 'unverifiable' })
    mockExec.mockResolvedValueOnce(`LIVE\n${END}${READY.replace('abc123', 'fff123')}\n${END}1\n`)
    await expect(probe()).rejects.toMatchObject({ verdict: 'rejected' })
  })

  it('reports an answer of another shape as unverifiable, never exited', async () => {
    mockExec.mockResolvedValueOnce('LIVE\n')
    const error = await probe().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HivewarddActiveReadinessError)
    expect(error).toMatchObject({ verdict: 'unverifiable' })
  })

  it('leaves the SSH probe its two separate reads, byte for byte', async () => {
    const dir = '/home/u/.hiveward-remote/hivewardd-0.1.0+aa'
    mockExec.mockResolvedValueOnce('LIVE\n').mockResolvedValueOnce(`${READY}\n`)
    await probeActiveHivewarddReadiness(
      { conn: context.connection, host, remoteInstallDir: dir },
      { buildHash: 'abc123def4567890', fullVersion: VERSION }
    )
    expect(mockExec.mock.calls.map(([, command]) => command)).toEqual([
      hivewarddLivenessProbeCommand(host, dir),
      readHivewarddReadinessNowCommand(host, dir)
    ])
  })
})

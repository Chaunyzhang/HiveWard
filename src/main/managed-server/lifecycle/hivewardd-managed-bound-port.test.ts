import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const execHivewarddRemote = vi.hoisted(() => vi.fn())
vi.mock('../install/hivewardd-remote-runtime-control', () => ({ execHivewarddRemote }))
const resolveHivewarddRemoteContext = vi.hoisted(() => vi.fn())
vi.mock('../install/hivewardd-remote-context', () => ({ resolveHivewarddRemoteContext }))

import { resolveManagedHivewarddTunnelPort } from './hivewardd-managed-bound-port'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import { unusedHivewarddHostTransport } from '../../ssh/unused-host-transport.test-fixture'

function readinessLine(boundEndpoint: string | null): string {
  return `${JSON.stringify({ type: 'hiveward_server_ready', runtimeId: 'runtime-1', boundEndpoint })}\n`
}

describe('resolveManagedHivewarddTunnelPort', () => {
  const link = {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 1,
    localPort: 46_768,
    remotePort: 6_768
  }
  function input(kind: 'hivewarddDeployment' | 'sshAccess') {
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only the link fields.
      environment: { [kind]: link } as unknown as KnownRuntimeEnvironment,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to the mocked context.
      target: { id: 'ssh-1' } as SshTarget,
      connection: unusedHivewarddHostTransport()
    }
  }

  beforeEach(() => {
    execHivewarddRemote.mockReset()
    resolveHivewarddRemoteContext.mockReset()
  })

  it('reads the active slot of a managed server', async () => {
    resolveHivewarddRemoteContext.mockResolvedValue({
      activationRecord: { active: '1.0.0+abc' },
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/deploy'
    })
    execHivewarddRemote.mockResolvedValue(readinessLine('ws://127.0.0.1:58520'))
    await expect(resolveManagedHivewarddTunnelPort(input('hivewarddDeployment'))).resolves.toBe(58_520)
  })

  it.each([
    ['no readiness file', ''],
    ['a readiness without an endpoint', readinessLine(null)]
  ])('falls back to the preferred port for %s (older builds)', async (_label, output) => {
    resolveHivewarddRemoteContext.mockResolvedValue({
      activationRecord: { active: '1.0.0+abc' },
      connection: {},
      host: getRemoteHostPlatform('linux-x64'),
      remoteHome: '/home/deploy'
    })
    execHivewarddRemote.mockResolvedValue(output)
    await expect(resolveManagedHivewarddTunnelPort(input('hivewarddDeployment'))).resolves.toBe(6_768)
  })

  it('keeps the configured port for independent SSH access without touching the host', async () => {
    await expect(resolveManagedHivewarddTunnelPort(input('sshAccess'))).resolves.toBe(6_768)
    expect(resolveHivewarddRemoteContext).not.toHaveBeenCalled()
  })

  it('tries the preferred port when the host cannot be read; the identity check still guards it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveHivewarddRemoteContext.mockRejectedValue(new Error('platform probe failed'))
    await expect(resolveManagedHivewarddTunnelPort(input('hivewarddDeployment'))).resolves.toBe(6_768)
    warn.mockRestore()
  })
})

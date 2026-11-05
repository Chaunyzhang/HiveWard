import { describe, expect, it } from 'vitest'
import { hostMallocTunablesLaunchEnv } from '../memory/host-malloc-tunables'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'
import { withOwnBuildLaunchEnv } from './wsl-hivewardd-own-build-launch-env'

function transport(): HivewarddHostTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper reads only hivewarddLaunchEnv.
  return {
    hivewarddLaunchEnv: async () => [['HIVEWARD_WSL_DISTRO_GUID', 'g']]
  } as unknown as HivewarddHostTransport
}

describe('withOwnBuildLaunchEnv', () => {
  it('adds the malloc tunables when the launched slot is this build', async () => {
    const conn = withOwnBuildLaunchEnv(transport(), () => '0.1.0+own')
    await expect(conn.hivewarddLaunchEnv?.({ fullVersion: '0.1.0+own' })).resolves.toEqual([
      ['HIVEWARD_WSL_DISTRO_GUID', 'g'],
      ...hostMallocTunablesLaunchEnv()
    ])
  })

  it('withholds them from an older slot, which would leak them to user shells', async () => {
    const conn = withOwnBuildLaunchEnv(transport(), () => '0.1.0+own')
    await expect(conn.hivewarddLaunchEnv?.({ fullVersion: '0.1.0+older' })).resolves.toEqual([
      ['HIVEWARD_WSL_DISTRO_GUID', 'g']
    ])
  })

  it('withholds them before this build’s version is known', async () => {
    const conn = withOwnBuildLaunchEnv(transport(), () => null)
    await expect(conn.hivewarddLaunchEnv?.({ fullVersion: '0.1.0+own' })).resolves.toEqual([
      ['HIVEWARD_WSL_DISTRO_GUID', 'g']
    ])
  })

  it('keeps a class-based transport’s prototype methods', async () => {
    class ClassTransport {
      readonly prefix = 'ran:'
      describe(command: string): string {
        return `${this.prefix}${command}`
      }
    }
    // The wrapper only reads hivewarddLaunchEnv; a bare instance stands in for the full transport.
    const transport: HivewarddHostTransport & ClassTransport = Object.create(new ClassTransport())
    const conn = withOwnBuildLaunchEnv(transport, () => null)
    expect(conn.describe('true')).toBe('ran:true')
    await expect(conn.hivewarddLaunchEnv?.({ fullVersion: '0.1.0+own' })).resolves.toEqual([])
  })
})

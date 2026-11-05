import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { hivewardBeforeAgentLaunch } from './agent-launch-admission'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

it('HiveWard 原生启动准入共用执行端地区策略，并传入实际目录与远程标识', async () => {
  const module: { configureExitRegionGuard(guard: { beforeRpc: typeof beforeRpc }): void } =
    await import(
      /* @vite-ignore */ pathToFileURL(join(process.cwd(), 'hiveward/server/agent-exit-region.mjs'))
        .href
    )
  const beforeRpc = vi.fn().mockResolvedValue(undefined)
  module.configureExitRegionGuard({ beforeRpc })
  await hivewardBeforeAgentLaunch('codex', '/tmp/hiveward-target', false)
  expect(beforeRpc).toHaveBeenLastCalledWith('terminal.create', {
    launchAgent: 'codex',
    cwd: '/tmp/hiveward-target'
  })
  beforeRpc.mockRejectedValueOnce(
    Object.assign(new Error('执行端拒绝'), { code: 'exit_region_blocked' })
  )
  await expect(
    hivewardBeforeAgentLaunch('claude', '/tmp/hiveward-target', true)
  ).rejects.toMatchObject({ code: 'exit_region_blocked' })
  expect(beforeRpc).toHaveBeenLastCalledWith('terminal.create', {
    launchAgent: 'claude',
    cwd: '/tmp/hiveward-target',
    executionHostId: 'remote'
  })
})

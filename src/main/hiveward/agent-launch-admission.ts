import { app } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 与网页共用出口策略，原生定时和联邦派活也在执行端检查。
export async function hivewardBeforeAgentLaunch(
  agent: string | undefined,
  cwd: string,
  remote: boolean
): Promise<void> {
  // 不起 Agent 的普通终端不检查。
  if (!agent) {
    return
  }
  const root = app.isPackaged
    ? join(process.resourcesPath, 'hiveward')
    : join(app.getAppPath(), 'hiveward')
  const module: {
    exitRegionGuard(): { beforeRpc(method: string, params: Record<string, unknown>): Promise<void> }
  } = await import(
    /* @vite-ignore */ pathToFileURL(join(root, 'server/agent-exit-region.mjs')).href
  )
  await module.exitRegionGuard().beforeRpc('terminal.create', {
    launchAgent: agent,
    cwd,
    ...(remote ? { executionHostId: 'remote' } : {})
  })
}

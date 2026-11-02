import { captureLoginShellEnvironment } from '../startup/login-shell-environment'
import { resolveProfileLoadingShell } from '../startup/hydrate-shell-path'
import { mainProcessState } from '../startup/main-process-state'

export async function captureExitRegionEnvironment(): Promise<{
  env: NodeJS.ProcessEnv
  shell: string
}> {
  const settings = mainProcessState.store?.getSettings()
  const shell =
    process.platform === 'win32'
      ? resolveProfileLoadingShell()
      : settings?.terminalDefaultShell?.trim() || resolveProfileLoadingShell()
  if (!shell) {
    throw new Error('shell_environment_unavailable')
  }
  const captured = await captureLoginShellEnvironment({
    shellOverride: shell,
    startedAfter: Date.now(),
    timeoutMs: 6000
  })
  if (captured.status !== 'captured') {
    throw new Error('shell_environment_unavailable')
  }
  return { env: captured.env, shell }
}

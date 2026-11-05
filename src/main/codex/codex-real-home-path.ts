import { resolve } from 'node:path'
import { getSystemCodexHomePath } from './codex-home-paths'
import { readBashStartupEnvVar, readShellStartupEnvVar } from '../pty/shell-startup-env'
import { readPowerShellProfileEnvValues } from '../pty/powershell-profile-env'

export function hasCustomCodexHomeOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  const codexHome = env.CODEX_HOME?.trim()
  const hivewardCodexHome = env.HIVEWARD_CODEX_HOME?.trim()
  const normalizedCodexHome = codexHome ? normalizePathForComparison(codexHome) : undefined
  const normalizedHiveWardCodexHome = hivewardCodexHome
    ? normalizePathForComparison(hivewardCodexHome)
    : undefined
  // Custom native homes need ownership tracking before HiveWard can safely mutate and clean them.
  return Boolean(
    normalizedCodexHome &&
    normalizedCodexHome !== normalizedHiveWardCodexHome &&
    normalizedCodexHome !== normalizePathForComparison(getSystemCodexHomePath())
  )
}

export function hasCustomCodexHomeOverrideForLaunch(launchEnv?: NodeJS.ProcessEnv): boolean {
  if (
    hasCustomCodexHomeOverride({
      CODEX_HOME: getLaunchEnvValue(launchEnv, 'CODEX_HOME'),
      HIVEWARD_CODEX_HOME: getLaunchEnvValue(launchEnv, 'HIVEWARD_CODEX_HOME')
    })
  ) {
    return true
  }
  // PowerShell profiles use USERPROFILE, which Windows supplies even without HOME.
  const home = getLaunchEnvValue(launchEnv, process.platform === 'win32' ? 'USERPROFILE' : 'HOME')
  if (!home) {
    return false
  }
  // Windows panes may use either PowerShell edition or Git Bash.
  const shellCodexHomes =
    process.platform === 'win32'
      ? [
          ...readPowerShellProfileEnvValues('CODEX_HOME', home),
          readBashStartupEnvVar('CODEX_HOME', home)
        ]
      : [
          readShellStartupEnvVar(
            'CODEX_HOME',
            home,
            getLaunchEnvValue(launchEnv, 'SHELL'),
            getLaunchEnvValue(launchEnv, 'XDG_CONFIG_HOME')
          )
        ]
  return shellCodexHomes.some(
    (codexHome) => codexHome !== undefined && hasCustomCodexHomeOverride({ CODEX_HOME: codexHome })
  )
}

type LaunchEnvKey =
  | 'CODEX_HOME'
  | 'HIVEWARD_CODEX_HOME'
  | 'HOME'
  | 'USERPROFILE'
  | 'SHELL'
  | 'XDG_CONFIG_HOME'

function getLaunchEnvValue(
  launchEnv: NodeJS.ProcessEnv | undefined,
  key: LaunchEnvKey
): string | undefined {
  return launchEnv && Object.hasOwn(launchEnv, key) ? launchEnv[key] : process.env[key]
}

function normalizePathForComparison(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

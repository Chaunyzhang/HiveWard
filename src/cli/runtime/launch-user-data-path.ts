import {
  compatibleHiveWardPath,
  resolveHiveWardProfileOverride
} from '../../shared/hiveward-profile-paths'
import { hivewardProduct } from '../../shared/hiveward-policy'
import { dirname, join, resolve } from 'node:path'
import { SERVE_USER_DATA_PATH_ENV } from '../../shared/serve-user-data-path'
import { getPlatformUserDataPath } from './metadata'

/** Dev builds read HIVEWARD_DEV_USER_DATA_PATH rather than --user-data-dir. */
function launchesDevApp(env: NodeJS.ProcessEnv): boolean {
  return env.HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT === '1'
}

/** Resolve absolutely: the launched child runs from the app root, not the caller’s cwd. */
export function resolveLaunchUserDataPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HIVEWARD_USER_DATA_PATH || env.HIVEWARD_USER_DATA_PATH
  if (configured) {
    return resolveHiveWardProfileOverride(configured)
  }
  if (launchesDevApp(env)) {
    return resolve(
      env.HIVEWARD_DEV_USER_DATA_PATH ||
        compatibleHiveWardPath(
          join(dirname(getPlatformUserDataPath()), hivewardProduct.devDataDirectory),
          join(dirname(getPlatformUserDataPath()), 'OPC-Engine-Dev')
        )
    )
  }
  return getPlatformUserDataPath()
}

/** Pin the profile through both packaged and dev entry points. */
export function pinLaunchUserDataPath(
  args: string[],
  env: NodeJS.ProcessEnv,
  userDataPath: string
): { args: string[]; env: NodeJS.ProcessEnv } {
  const pinnedEnv: NodeJS.ProcessEnv = { ...env, HIVEWARD_USER_DATA_PATH: userDataPath }
  if (launchesDevApp(env)) {
    pinnedEnv.HIVEWARD_DEV_USER_DATA_PATH = userDataPath
  }
  return { args: [...args, `--user-data-dir=${userDataPath}`], env: pinnedEnv }
}

/** Serve checks this profile before acquiring its instance lock. */
export function pinServeUserDataPath(
  args: string[],
  env: NodeJS.ProcessEnv,
  userDataPath: string
): { args: string[]; env: NodeJS.ProcessEnv } {
  const pinned = pinLaunchUserDataPath(args, env, userDataPath)
  return { args: pinned.args, env: { ...pinned.env, [SERVE_USER_DATA_PATH_ENV]: userDataPath } }
}

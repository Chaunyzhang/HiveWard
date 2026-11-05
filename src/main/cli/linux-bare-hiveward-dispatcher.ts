import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  hasAppImagePathEnvironment,
  resolveAppImageRuntimeIdentity
} from '../appimage-runtime-identity'
import {
  ensureAppImageExtractedRoot,
  resolveAppImageCacheRootPath,
  resolveLegacyAppImageNamespacePath
} from './appimage-extracted-root'
import { pruneAppImageExtractedRoots } from './appimage-extraction-pruning'
import { resolveGenerationStableLauncherPath } from './appimage-generation-stable-launcher'
import { withAppImageRegistrationLock } from './appimage-registration-lock'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell-argument-quoting'

// Only marked dispatchers may be replaced; user-owned commands must survive repeat starts.
const DISPATCHER_MARKER = '# hiveward-cli-dispatcher'

export type LinuxBareHivewarddispatcherOptions = {
  /** Packaged app resources root; the bundled `hiveward` launcher lives under it. */
  resourcesPath: string
  homePath?: string
  /** Trusted caller override; production requires the complete AppImage runtime identity. */
  appImagePath?: string | null
  /** Test seam — defaults to $XDG_CACHE_HOME/hiveward/appimage. */
  appImageCacheRootPath?: string
  /** Test seam — defaults to running the AppImage's own `--appimage-extract`. */
  appImageExtractRunner?: (appImagePath: string, cwd: string) => Promise<void>
  /** Absolute time (ms) by which AppImage extraction and its lock wait must finish. */
  appImageDeadlineAt?: number
}

export type LinuxBareHivewarddispatcherState =
  | 'installed'
  | 'skipped-foreign'
  | 'skipped-launcher-missing'

export type LinuxBareHivewarddispatcherResult = {
  state: LinuxBareHivewarddispatcherState
  dispatcherPath: string
  target: string | null
}

// Team launchers invoke bare `hiveward`, and a login shell can drop HiveWard's PATH entry ahead of it.
// A regular file avoids the installer's legacy-symlink cleanup.
export async function installLinuxBareHivewarddispatcher(
  options: LinuxBareHivewarddispatcherOptions
): Promise<LinuxBareHivewarddispatcherResult> {
  const dispatcherPath = join(options.homePath ?? homedir(), '.local', 'bin', 'hiveward')
  if (existsSync(dispatcherPath) && !(await isOwnedDispatcher(dispatcherPath))) {
    return { state: 'skipped-foreign', dispatcherPath, target: null }
  }

  const launcher = await resolveStableLauncherPath(options)
  if (!launcher) {
    return { state: 'skipped-launcher-missing', dispatcherPath, target: null }
  }

  const installed = await publishDispatcher(
    dispatcherPath,
    insertDispatcherMarker(buildBareHivewarddispatcherScript(launcher))
  )
  return installed
    ? { state: 'installed', dispatcherPath, target: launcher }
    : { state: 'skipped-foreign', dispatcherPath, target: null }
}

export function buildBareHiveWardCliScript(launcherPath: string): string {
  return `#!/usr/bin/env bash\nexec ${quotePosixShellDoubleQuotedApostrophe(launcherPath)} "$@"\n`
}

/**
 * HiveWard's own children reach this app's CLI, or a clear error once it is gone, never another `hiveward`
 * (GNOME's screen reader shares the name). Anyone else gets the next real `hiveward` on PATH first.
 */
export function buildBareHivewarddispatcherScript(launcherPath: string): string {
  return [
    '#!/usr/bin/env bash',
    `launcher=${quotePosixShellDoubleQuotedApostrophe(launcherPath)}`,
    'gone() {',
    `  printf 'hiveward: HiveWard is no longer installed at %s. Remove %s to stop this message.\\n' "$launcher" "\${BASH_SOURCE[0]}" >&2`,
    '  exit 127',
    '}',
    // An agent's `hiveward …` must never start a talking screen reader, even once HiveWard is gone.
    'if [ -n "${HIVEWARD_CLI_BIN_DIR-}${HIVEWARD_PANE_KEY-}${HIVEWARD_USER_DATA_PATH-}" ]; then',
    '  [ -x "$launcher" ] && exec "$launcher" "$@"',
    '  gone',
    'fi',
    // Skip every HiveWard dispatcher, not just this one, so none can hand the call back to HiveWard;
    // the real target runs with nothing added to its environment. Relative entries depend on the
    // caller's folder, so only absolute ones count.
    'IFS=: read -r -a path_dirs <<< "${PATH-}"',
    'for dir in "${path_dirs[@]}"; do',
    '  case "$dir" in /*) ;; *) continue ;; esac',
    '  candidate="$dir/hiveward"',
    '  if [ -f "$candidate" ] && [ -x "$candidate" ] && ! [ "$candidate" -ef "${BASH_SOURCE[0]}" ]; then',
    '    marker=""',
    '    { IFS= read -r _ && IFS= read -r marker; } < "$candidate" 2>/dev/null',
    `    if [ "$marker" != ${quotePosixShellDoubleQuotedApostrophe(DISPATCHER_MARKER)} ]; then`,
    '      exec "$candidate" "$@"',
    '    fi',
    '  fi',
    'done',
    '[ -x "$launcher" ] && exec "$launcher" "$@"',
    'gone',
    ''
  ].join('\n')
}

/** Removes only HiveWard's own dispatcher; a user's `hiveward` at that path is left alone. */
export async function removeLinuxBareHivewarddispatcher(homePath = homedir()): Promise<boolean> {
  const dispatcherPath = join(homePath, '.local', 'bin', 'hiveward')
  if (!(await isOwnedDispatcher(dispatcherPath))) {
    return false
  }
  const displacedPath = join(
    dirname(dispatcherPath),
    `.hiveward-removed-dispatcher-${process.pid}-${randomUUID()}`
  )
  try {
    await rename(dispatcherPath, displacedPath)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
  if (await isOwnedDispatcher(displacedPath)) {
    await unlink(displacedPath)
    return true
  }
  // A foreign command replaced it between the check and the rename; put that one back.
  await restoreDisplacedDispatcher(displacedPath, dispatcherPath)
  return false
}

// AppImage resources live on an ephemeral FUSE mount; dispatch through a persistent copy.
async function resolveStableLauncherPath(
  options: LinuxBareHivewarddispatcherOptions
): Promise<string | null> {
  const hasExplicitAppImagePath = Object.hasOwn(options, 'appImagePath')
  const runtimeIdentity = resolveAppImageRuntimeIdentity({ resourcesPath: options.resourcesPath })
  if (!hasExplicitAppImagePath && hasAppImagePathEnvironment() && !runtimeIdentity) {
    return null
  }
  const appImagePath = hasExplicitAppImagePath
    ? (options.appImagePath ?? null)
    : (runtimeIdentity?.appImagePath ?? null)
  if (appImagePath) {
    const extractionOptions = {
      appImagePath,
      cacheRootPath: options.appImageCacheRootPath,
      runExtract: options.appImageExtractRunner,
      deadlineAt: options.appImageDeadlineAt
    }
    return withAppImageRegistrationLock(
      resolveAppImageCacheRootPath(extractionOptions),
      async () => {
        const extractedRoot = await ensureAppImageExtractedRoot(extractionOptions)
        if (extractedRoot) {
          await pruneAppImageExtractedRoots(
            extractedRoot.rootPath,
            resolveLegacyAppImageNamespacePath(extractionOptions)
          )
        }
        return extractedRoot?.stableLauncherPath ?? null
      },
      { deadlineAt: options.appImageDeadlineAt }
    )
  }
  const stableLauncher = resolveGenerationStableLauncherPath(options.resourcesPath)
  if (stableLauncher) {
    return stableLauncher
  }
  const launcher = getBundledLauncherPath('linux', options.resourcesPath)
  // Path resolution does not check existence; do not publish a broken dispatcher.
  return launcher && existsSync(launcher) ? launcher : null
}

function insertDispatcherMarker(script: string): string {
  return script.replace('\n', `\n${DISPATCHER_MARKER}\n`)
}

async function isOwnedDispatcher(dispatcherPath: string): Promise<boolean> {
  try {
    return (
      (await lstat(dispatcherPath)).isFile() &&
      (await readFile(dispatcherPath, 'utf8')).split('\n')[1] === DISPATCHER_MARKER
    )
  } catch {
    return false
  }
}

async function publishDispatcher(dispatcherPath: string, content: string): Promise<boolean> {
  const directoryPath = dirname(dispatcherPath)
  const temporaryPath = join(directoryPath, `.hiveward-dispatcher-${process.pid}-${randomUUID()}`)
  await mkdir(directoryPath, { recursive: true })
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o755 })
  try {
    if (await publishIfVacant(temporaryPath, dispatcherPath)) {
      return true
    }

    const displacedPath = join(
      directoryPath,
      `.hiveward-preserved-dispatcher-${process.pid}-${randomUUID()}`
    )
    try {
      await rename(dispatcherPath, displacedPath)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
      return await publishIfVacant(temporaryPath, dispatcherPath)
    }

    if (!(await isOwnedDispatcher(displacedPath))) {
      await restoreDisplacedDispatcher(displacedPath, dispatcherPath)
      return false
    }

    try {
      if (
        (await publishIfVacant(temporaryPath, dispatcherPath)) ||
        (await isExactExecutableDispatcher(dispatcherPath, content))
      ) {
        await unlink(displacedPath)
        return true
      }
      // A concurrently published foreign command owns the public path now.
      await unlink(displacedPath)
      return false
    } catch (error) {
      await restoreDisplacedDispatcher(displacedPath, dispatcherPath)
      throw error
    }
  } finally {
    await unlink(temporaryPath).catch(() => {})
  }
}

async function publishIfVacant(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await link(sourcePath, destinationPath)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false
    }
  }
  try {
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false
    }
    throw error
  }
}

async function restoreDisplacedDispatcher(
  displacedPath: string,
  dispatcherPath: string
): Promise<void> {
  if (await publishIfVacant(displacedPath, dispatcherPath)) {
    await unlink(displacedPath)
  }
}

async function isExactExecutableDispatcher(
  dispatcherPath: string,
  content: string
): Promise<boolean> {
  try {
    const [actual, metadata] = await Promise.all([
      readFile(dispatcherPath, 'utf8'),
      lstat(dispatcherPath)
    ])
    return metadata.isFile() && (metadata.mode & 0o111) !== 0 && actual === content
  } catch {
    return false
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

/** The app selects the local serve runtime; the CLI runs that selection. */
import { dirname, join } from 'node:path'
import { runProcess, spawnProcess } from '@hiveward/process-host'
import type { ProcessSpec } from '@hiveward/process-host/process-spec'
import {
  HIVEWARDD_LOCAL_SERVE_SELECTION_ENTRY,
  HIVEWARDD_LOCAL_SERVE_SELECTION_FLAGS as FLAGS,
  parseServeRuntimeSelection,
  type ServeRuntimeSelection
} from '../../shared/hivewardd-local-serve-selection'
import { waitForRecipeJson } from './serve-recipe-json'
import { superviseForegroundServe } from './serve-update-supervisor'
import { isSupervisedSpawnHeld } from './serve-supervised-stop'
import { redactingSpawn, shouldRedactSupervisedStdout } from './serve-pairing-redaction'
import { hivewarddServeArgs, type ServeHiveWardAppArgs } from '../../shared/hivewardd-serve-argv'
import { SPEECH_RECOGNIZER_DIR_ENV } from '../../shared/speech-recognizer-package'

/** A first run may download and verify the pinned Node; bound it well past that. */
const SELECTION_TIMEOUT_MS = 10 * 60_000

export async function resolveLocalServeRuntime(
  options: {
    executable: string
    appRoot: string
    userDataPath: string
    usesMacUpdateHandoff: boolean
  },
  run: typeof runProcess = runProcess
): Promise<ServeRuntimeSelection> {
  // hivewardd has no updater; keep Electron for packaged macOS update handoffs.
  if (options.usesMacUpdateHandoff) {
    return {
      kind: 'electron',
      reason:
        'packaged macOS serve stays on Electron so paired clients can still update it (hivewardd has no app updater)'
    }
  }
  const entry = join(options.appRoot, 'out', 'main', `${HIVEWARDD_LOCAL_SERVE_SELECTION_ENTRY}.js`)
  try {
    const result = await run({
      program: options.executable,
      args: [entry, FLAGS.userData, options.userDataPath, FLAGS.appRoot, options.appRoot],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // Show pinned-Node download progress so first-run selection does not appear hung.
      stdio: ['ignore', 'pipe', 'inherit'],
      timeoutMs: SELECTION_TIMEOUT_MS
    })
    return (
      parseServeRuntimeSelection(result.stdout) ?? {
        kind: 'electron',
        reason: `the app did not answer which serve host to use (exit ${String(result.code)})`
      }
    )
  } catch (error) {
    return {
      kind: 'electron',
      reason: `the app could not check hivewardd: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** Electron serve binds every interface (`exposeNetworkByDefault`); hivewardd does it on request. */
export function serveWithHivewardd(
  selection: Extract<ServeRuntimeSelection, { kind: 'hivewardd' }>,
  args: ServeHiveWardAppArgs,
  userDataPath: string,
  /** The caller's environment without `ELECTRON_RUN_AS_NODE`. */
  baseEnv: NodeJS.ProcessEnv,
  /** The app's browser client; the slot does not carry one, so hivewardd serves it from here. */
  webClientRoot?: string,
  /** hivewardd’s slot has no speech recognizer; use the app’s copy. */
  speechRecognizerDir?: string
): Promise<number> {
  const spec: ProcessSpec = {
    program: selection.runtime,
    args: [selection.entry, ...hivewarddServeArgs(args, webClientRoot)],
    detached: args.recipeJson === true,
    cwd: dirname(selection.entry),
    stdio: args.recipeJson === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: {
      ...baseEnv,
      // The desktop's profile: its instance lock makes the two refuse each other.
      HIVEWARD_USER_DATA: userDataPath,
      HIVEWARD_VERSION: selection.version,
      // Always set: a value inherited from an HiveWard terminal would name another install's copy.
      [SPEECH_RECOGNIZER_DIR_ENV]: speechRecognizerDir ?? ''
    }
  }
  const spawnChild = shouldRedactSupervisedStdout(args.supervise === true)
    ? redactingSpawn(spawnProcess)
    : spawnProcess
  if (isSupervisedSpawnHeld()) {
    return Promise.resolve(0)
  }
  const child = spawnChild(spec)
  if (args.recipeJson) {
    return waitForRecipeJson(child)
  }
  return superviseForegroundServe({
    spec,
    spawnChild,
    child,
    handoffPath: null,
    expectedHandoff: null
  })
}

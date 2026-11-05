import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preflightProfileStateRuntime } from '../persistence/profile-state/profile-state-runtime-preflight'
import {
  HIVEWARDD_STARTUP_PREFLIGHT_FLAG,
  HIVEWARDD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseHivewarddProfilePreflight,
  hivewarddProfilePreflightResponseSchema,
  type HivewarddProfilePreflightResponse
} from '../../shared/hivewardd-profile-preflight'
import { readHivewarddArtifactIdentity } from './hivewardd-artifact-identity'
import { HIVEWARDD_EXIT_CONFIGURATION } from './hivewardd-configuration-exit'
import { HIVEWARDD_SERVER_ENTRY_FILENAME, HIVEWARDD_VERSION_FILENAME } from '../../shared/hivewardd-artifacts'
import { HIVEWARDD_NODE_RUNTIME_IDENTITY } from '../../shared/hivewardd-node-runtime-identity'
import { runProcess } from '@hiveward/process-host'
import { preflightHivewarddNativeRuntime } from './hivewardd-runtime-native-preflight'
import { hivewarddCompileCacheEnv } from './hivewardd-compile-cache'
import {
  consumeHivewarddStartupQualification,
  discardHivewarddStartupQualification,
  isQualifiableHivewarddSlot,
  hivewarddStartupQualificationKey,
  recordHivewarddStartupQualification
} from './hivewardd-startup-qualification'
import {
  isRunningAsBundledHivewarddRuntime,
  HivewarddBundledRuntimeError,
  resolveBundledHivewarddSlot
} from './hivewardd-bundled-runtime'

let pendingQualification: { directory: string; key: string } | null = null
// The last marker write; recording fails open, so it never rejects.
let markerRecording: Promise<void> = Promise.resolve()

/** Qualify packaged startup before touching profile indexes, data-root locks or imports. */
export async function preflightBundledHivewarddStartup(): Promise<boolean> {
  const directory = resolveBundledHivewarddSlot()
  if (!isRunningAsBundledHivewarddRuntime(directory)) {
    return false
  }
  const identity = await readInstalledVersion(directory)
  // Windows' child also proves the process identity table, which depends on host services.
  const key =
    process.platform === 'win32' || !isQualifiableHivewarddSlot(directory)
      ? null
      : await hivewarddStartupQualificationKey(directory, identity).catch(() => null)
  if (key && (await consumeHivewarddStartupQualification(directory, key))) {
    pendingQualification = { directory, key }
    return true
  }
  try {
    await runStartupPreflightChild(directory, identity)
  } catch (error) {
    if (key) {
      await discardHivewarddStartupQualification(directory)
    }
    throw error
  }
  pendingQualification = key ? { directory, key } : null
  return false
}

/** node-pty failed to load at spawn: the next launch must re-probe and report why. */
export async function discardBundledHivewarddStartupQualification(): Promise<void> {
  pendingQualification = null
  // A record still renaming its marker into place would recreate it after an earlier unlink.
  await markerRecording
  const directory = resolveBundledHivewarddSlot()
  if (process.platform !== 'win32' && isQualifiableHivewarddSlot(directory)) {
    await discardHivewarddStartupQualification(directory)
  }
}

/** A launch whose node-pty probe did not pass must not let the next one skip either probe. */
export function forgetBundledHivewarddStartupQualification(): void {
  pendingQualification = null
}

async function runStartupPreflightChild(directory: string, identity: string): Promise<void> {
  const nonce = randomUUID()
  // Keep disposable SQLite ownership and native state out of the serving process.
  const result = await runProcess({
    program: process.execPath,
    args: [join(directory, HIVEWARDD_SERVER_ENTRY_FILENAME), HIVEWARDD_STARTUP_PREFLIGHT_FLAG, nonce],
    // Reuse the serving runtime code cache for this identical bundle.
    env: { ...process.env, HIVEWARD_BACKGROUND_LAUNCH: '1', ...hivewarddCompileCacheEnv(directory) },
    timeoutMs: HIVEWARDD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    terminationBarrier: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    const Failure = result.code === HIVEWARDD_EXIT_CONFIGURATION ? HivewarddBundledRuntimeError : Error
    throw new Failure(`The bundled HiveWard runtime failed readiness: ${result.stderr}`)
  }
  try {
    parseHivewarddProfilePreflight(result.stdout, nonce, HIVEWARDD_NODE_RUNTIME_IDENTITY, identity)
  } catch (cause) {
    throw new HivewarddBundledRuntimeError('The bundled runtime returned invalid readiness identity', {
      cause
    })
  }
}

/** Call once readiness is published: only a launch that got there lets the next one skip. */
export async function confirmBundledHivewarddStartupQualified(): Promise<void> {
  const qualified = pendingQualification
  pendingQualification = null
  if (qualified) {
    markerRecording = recordHivewarddStartupQualification(qualified.directory, qualified.key)
    await markerRecording
  }
}

export async function runHivewarddProfilePreflight(
  nonce: string | undefined,
  options: { nativeFeatures?: boolean; servedUserDataPath?: string } = {}
): Promise<void> {
  const checkedNonce = z.string().uuid().parse(nonce)
  const directory = resolveBundledHivewarddSlot()
  let artifactVersion: string
  try {
    artifactVersion = await readHivewarddArtifactIdentity(directory)
  } catch (cause) {
    throw new HivewarddBundledRuntimeError('The bundled HiveWard artifacts are incomplete or altered', {
      cause
    })
  }
  const result = await preflightProfileStateRuntime()
  // Host Node rollback launchers do not serve the bundled slot.
  if (isRunningAsBundledHivewarddRuntime(directory)) {
    await preflightHivewarddNativeRuntime(options)
  }
  const response: HivewarddProfilePreflightResponse = {
    type: 'hiveward_profile_state_ready',
    nonce: checkedNonce,
    runtime: 'node',
    runtimeVersion: process.versions.node,
    artifactVersion,
    ...result,
    ...(options.servedUserDataPath === undefined
      ? {}
      : { liveDaemonProtocols: await readServedDaemonProtocols(options.servedUserDataPath) })
  }
  console.log(JSON.stringify(response))
}

/** The served data root, never this probe's own, decides which daemons a restart must reach. */
async function readServedDaemonProtocols(servedUserDataPath: string): Promise<number[] | null> {
  // A failed probe leaves the crossing unverifiable; it must not fail the candidate itself.
  try {
    // Import lazily: startup preflight loads this module and needs no daemon code.
    const [{ listLiveDaemonProtocols }, { daemonRuntimeDirFor }, protocol] = await Promise.all([
      import('../daemon/daemon-generation-liveness'),
      import('../daemon/daemon-runtime-dir'),
      import('../daemon/daemon-protocol-version')
    ])
    return await listLiveDaemonProtocols(daemonRuntimeDirFor(servedUserDataPath), [
      protocol.PROTOCOL_VERSION,
      ...protocol.PREVIOUS_DAEMON_PROTOCOL_VERSIONS
    ])
  } catch {
    return null
  }
}

async function readInstalledVersion(directory: string): Promise<string> {
  try {
    return hivewarddProfilePreflightResponseSchema.shape.artifactVersion.parse(
      (await readFile(join(directory, HIVEWARDD_VERSION_FILENAME), 'utf8')).trim()
    )
  } catch (cause) {
    throw new HivewarddBundledRuntimeError(
      'The installed HiveWard artifact version is missing or invalid',
      {
        cause
      }
    )
  }
}

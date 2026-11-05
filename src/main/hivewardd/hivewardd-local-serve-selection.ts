// Run app-side to keep materializers out of the CLI bundle. Prefer a userData hivewardd slot;
// unsupported packaging/runtime/native conditions fall back to Electron with a diagnostic.
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess } from '@hiveward/process-host'
import { NODE_RUNTIME_ASSETS, type ServerTarget } from '../../shared/node-runtime-pin'
import {
  HIVEWARDD_SERVER_ENTRY_FILENAME,
  HIVEWARDD_VERSION_FILENAME,
  hivewarddNodeRuntimeRelativePath
} from '../../shared/hivewardd-artifacts'
import {
  HIVEWARDD_NATIVE_PREFLIGHT_FLAG,
  parseHivewarddNativePreflightReport
} from '../../shared/hivewardd-native-preflight-report'
import {
  SERVE_RUNTIME_ELECTRON,
  SERVE_RUNTIME_ENV,
  type ServeRuntimeSelection
} from '../../shared/hivewardd-local-serve-selection'
import { resolveBundledHivewarddRuntime } from './hivewardd-bundled-runtime'
import { detectNativeHostAbi, nativeSlotName } from './native-host-abi'
import { materializeHivewarddArtifact } from './hivewardd-artifact-materializer'
import { materializeCachedNodeRuntime } from '../node-runtime/pinned-runtime-materializer'
import {
  copyVerifiedAppImageNodeRuntime,
  type AppImageNodeRuntime
} from '../node-runtime/appimage-bundled-node-runtime'
import { serveProfileHasSshTargets } from './serve-profile-ssh-targets'
import { errorMessage } from '../../shared/error-message'

const NATIVE_PREFLIGHT_TIMEOUT_MS = 30_000

export type ServeRuntimeSelectionInput = {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  userDataPath: string
  templateDirs: readonly string[]
  hostTarget?: () => string
  materializeSlot?: typeof materializeHivewarddArtifact
  materializeRuntime?: typeof materializeCachedNodeRuntime
  /** Try the AppImage’s pinned Node before downloading. */
  bundledNodeRuntime?: AppImageNodeRuntime | null
  nativePreflight?: (runtime: string, entry: string) => Promise<string>
  profileHasSshTargets?: (userDataPath: string) => boolean
}

function isServerTarget(value: string): value is ServerTarget {
  return Object.keys(NODE_RUNTIME_ASSETS).includes(value)
}

function electron(reason: string): ServeRuntimeSelection {
  return { kind: 'electron', reason }
}

export async function selectServeRuntime(
  input: ServeRuntimeSelectionInput
): Promise<ServeRuntimeSelection> {
  const requested = input.env[SERVE_RUNTIME_ENV]
  if (requested === SERVE_RUNTIME_ELECTRON) {
    return { kind: 'electron', reason: null }
  }
  if (requested && requested !== 'hivewardd') {
    return electron(`${SERVE_RUNTIME_ENV}=${requested} is neither hivewardd nor electron`)
  }
  // Default to Electron for SSH targets until hivewardd supports them; explicit hivewardd selection overrides.
  const sshReason = requested ? null : profileSshReason(input)
  if (sshReason) {
    return electron(sshReason)
  }
  const target = (input.hostTarget ?? (() => nativeSlotName(detectNativeHostAbi())))()
  if (!isServerTarget(target)) {
    return electron(`no hivewardd build exists for this host (${target})`)
  }
  const templateDir = input.templateDirs.find((candidate) => existsSync(candidate))
  if (!templateDir) {
    return electron('this HiveWard install carries no hivewardd template')
  }
  const cacheRoot = join(input.userDataPath, 'hivewardd-artifacts')
  let slotDir: string
  try {
    slotDir = await (input.materializeSlot ?? materializeHivewarddArtifact)(target, {
      templateDir,
      cacheRoot
    })
    await placeSlotRuntime(slotDir, target, cacheRoot, input)
  } catch (error) {
    return electron(`the hivewardd slot for ${target} could not be prepared: ${errorMessage(error)}`)
  }
  let runtime: string | null
  try {
    runtime = resolveBundledHivewarddRuntime(slotDir)
  } catch (error) {
    return electron(`the hivewardd slot is incomplete: ${errorMessage(error)}`)
  }
  if (!runtime) {
    return electron('the hivewardd slot names no pinned runtime')
  }
  const entry = join(slotDir, HIVEWARDD_SERVER_ENTRY_FILENAME)
  const report = parseHivewarddNativePreflightReport(
    await (input.nativePreflight ?? runNativePreflight)(runtime, entry).catch(() => '')
  )
  if (!report) {
    return electron('hivewardd did not answer its native preflight')
  }
  if (report.status === 'blocked' || report.status === 'degraded') {
    return electron(
      `hivewardd cannot run terminals here (${report.status}: ${report.reason ?? 'unknown'})`
    )
  }
  return {
    kind: 'hivewardd',
    runtime,
    entry,
    version: readFileSync(join(slotDir, HIVEWARDD_VERSION_FILENAME), 'utf8').trim()
  }
}

function profileSshReason(input: ServeRuntimeSelectionInput): string | null {
  try {
    return (input.profileHasSshTargets ?? serveProfileHasSshTargets)(input.userDataPath)
      ? 'this profile has SSH targets, which hivewardd cannot serve yet'
      : null
  } catch (error) {
    // Unknown/old-schema profiles may contain saved SSH targets; preserve Electron reachability.
    return `could not tell whether this profile has SSH targets, which hivewardd cannot serve yet (${errorMessage(error)})`
  }
}

async function placeSlotRuntime(
  slotDir: string,
  target: ServerTarget,
  cacheRoot: string,
  {
    materializeRuntime = materializeCachedNodeRuntime,
    bundledNodeRuntime
  }: Pick<ServeRuntimeSelectionInput, 'materializeRuntime' | 'bundledNodeRuntime'>
): Promise<void> {
  const destination = join(
    slotDir,
    ...hivewarddNodeRuntimeRelativePath(target, NODE_RUNTIME_ASSETS[target].executableSha256)
  )
  if (existsSync(destination)) {
    return
  }
  if (bundledNodeRuntime?.target === target) {
    try {
      await copyVerifiedAppImageNodeRuntime(bundledNodeRuntime, destination)
      return
    } catch (error) {
      console.error(`hiveward serve: not using the bundled Node (${errorMessage(error)})`)
    }
  }
  const cached = await materializeRuntime(target, cacheRoot, { fetcher: fetch })
  mkdirSync(dirname(destination), { recursive: true })
  try {
    linkSync(cached, destination)
  } catch {
    copyFileSync(cached, destination)
    chmodSync(destination, 0o755)
  }
}

async function runNativePreflight(runtime: string, entry: string): Promise<string> {
  const result = await runProcess({
    program: runtime,
    args: [entry, HIVEWARDD_NATIVE_PREFLIGHT_FLAG],
    timeoutMs: NATIVE_PREFLIGHT_TIMEOUT_MS
  })
  return result.stdout
}

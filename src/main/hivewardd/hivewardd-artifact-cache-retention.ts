// Bound persistent artifact caches while retaining materialized, live-server and daemon slots.
// Unknown machine/boot ownership must preserve slots too.
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { nodeRuntimeAsset } from '../../shared/node-runtime-pin'
import { HIVEWARDD_LOCK_FILE_NAME, readHivewarddInstanceLockRecord } from './hivewardd-instance-lock'
import { hivewarddPeerPidIsJudgeableHere } from './hivewardd-lock-holder-locality'
import { materializedHivewarddArtifactVersions } from './hivewardd-artifact-materializer'
import { isProcessAlive } from '../daemon/daemon-process-inspection'
import {
  defaultHivewarddSlotPeerJudge,
  liveDaemonHivewarddSlots,
  type HivewarddSlotPeerJudge
} from './hivewardd-daemon-slot-pins'

/** In-use slot plus two others, or the newest three when none is in use. */
const HIVEWARDD_ARTIFACT_CACHE_KEEP = 3

const REPAIR_SUFFIX = /\.repair-\d+$/u

type HivewarddArtifactCachePruneOptions = {
  keep?: number
  inUseVersions?: ReadonlySet<string>
}

export async function pruneHivewarddArtifactCache(
  cacheRoot: string,
  options: HivewarddArtifactCachePruneOptions = {}
): Promise<string[]> {
  const keep = options.keep ?? HIVEWARDD_ARTIFACT_CACHE_KEEP
  const inUse = options.inUseVersions ?? new Set<string>()
  const removed: string[] = []
  for (const target of await listNames(cacheRoot)) {
    // Only target directories hold slots; `node/` is the runtime archive cache.
    if (!nodeRuntimeAsset(target)) {
      continue
    }
    const targetRoot = join(cacheRoot, target)
    const slots = await Promise.all(
      // Dot entries are staging directories another process may be filling right now.
      (await listNames(targetRoot))
        .filter((name) => !name.startsWith('.'))
        .map(async (name) => ({ name, mtimeMs: await mtimeOf(join(targetRoot, name)) }))
    )
    const present = slots.filter(
      (slot): slot is { name: string; mtimeMs: number } => slot.mtimeMs !== null
    )
    const isInUse = (name: string): boolean => inUse.has(name.replace(REPAIR_SUFFIX, ''))
    // The in-use version consumes one keep slot; otherwise retain the newest keep versions.
    const othersToKeep = present.some((slot) => isInUse(slot.name)) ? keep - 1 : keep
    const others = present
      .filter((slot) => !isInUse(slot.name))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
    for (const [index, slot] of others.entries()) {
      if (index < othersToKeep) {
        continue
      }
      const path = join(targetRoot, slot.name)
      try {
        await rm(path, { recursive: true, force: true })
        removed.push(path)
      } catch (error) {
        console.warn(`[hivewardd-artifacts] could not evict ${path}:`, error)
      }
    }
  }
  return removed
}

export function pruneDesktopHivewarddArtifactCache(
  userDataPath: string,
  alsoInUse: readonly string[] = []
): Promise<string[]> {
  const cacheRoot = join(userDataPath, 'hivewardd-artifacts')
  const judge = defaultHivewarddSlotPeerJudge()
  const daemonSlots = liveDaemonHivewarddSlots(userDataPath, cacheRoot, isProcessAlive, judge)
  if (!daemonSlots) {
    // An unreadable daemon record could name any slot; evicting nothing is the safe answer.
    return Promise.resolve([])
  }
  const live = liveLocalHivewarddServeVersion(userDataPath, isProcessAlive, judge)
  return pruneHivewarddArtifactCache(cacheRoot, {
    inUseVersions: new Set([
      ...materializedHivewarddArtifactVersions(),
      ...(live ? [live] : []),
      ...daemonSlots.map((slot) => slot.replace(REPAIR_SUFFIX, '')),
      ...alsoInUse
    ])
  })
}

/** Keep slots used by local servers, including unverifiable ownership from other machines/boots. */
export function liveLocalHivewarddServeVersion(
  userDataPath: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
  judge: HivewarddSlotPeerJudge = defaultHivewarddSlotPeerJudge()
): string | null {
  const record = readHivewarddInstanceLockRecord(join(userDataPath, HIVEWARDD_LOCK_FILE_NAME))
  if (!record || record.role === 'desktop') {
    return null
  }
  const judgeable = hivewarddPeerPidIsJudgeableHere(record, judge.self, () =>
    judge.dataRootIsOnLocalDisk(userDataPath)
  )
  return !judgeable || isAlive(record.pid) ? record.version : null
}

async function listNames(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path)
    return info.isDirectory() ? info.mtimeMs : null
  } catch {
    return null
  }
}

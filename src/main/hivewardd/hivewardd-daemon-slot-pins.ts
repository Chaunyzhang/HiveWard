// Daemons outlive instance locks; pin their entry/runtime slots separately.
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDaemonPidFile } from '../daemon/daemon-pid-file-parse'
import { hasErrorCode, isProcessAlive } from '../daemon/daemon-process-inspection'
import {
  currentHivewarddPeerMachine,
  hivewarddPeerPidIsJudgeableHere,
  type HivewarddPeerMachine
} from './hivewardd-lock-holder-locality'
import { hivewarddDataRootIsOnLocalDisk } from './hivewardd-data-root-locality'

export type HivewarddSlotPeerJudge = {
  self: HivewarddPeerMachine
  dataRootIsOnLocalDisk: (dataRoot: string) => boolean
}

export function defaultHivewarddSlotPeerJudge(): HivewarddSlotPeerJudge {
  return { self: currentHivewarddPeerMachine(), dataRootIsOnLocalDisk: hivewarddDataRootIsOnLocalDisk }
}

const DAEMON_PID_FILE = /^daemon-v\d+\.pid$/u

/** Null when live-daemon slot ownership cannot be established. */
export function liveDaemonHivewarddSlots(
  userDataPath: string,
  cacheRoot: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
  judge: HivewarddSlotPeerJudge = defaultHivewarddSlotPeerJudge()
): string[] | null {
  const runtimeDir = join(userDataPath, 'daemon')
  let names: string[]
  try {
    names = readdirSync(runtimeDir)
  } catch (error) {
    // Only ENOENT proves absence; other errors leave slot ownership unknown.
    return hasErrorCode(error, 'ENOENT') ? [] : null
  }
  const slots: string[] = []
  for (const name of names.filter((candidate) => DAEMON_PID_FILE.test(candidate))) {
    let record
    try {
      record = parseDaemonPidFile(readFileSync(join(runtimeDir, name), 'utf8'))
    } catch {
      return null
    }
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
      // Torn/incomplete records cannot prove that their process is gone.
      return null
    }
    // Shared-home records from another machine/boot remain unverifiable; keep their slots.
    const judgeable = hivewarddPeerPidIsJudgeableHere(
      { bootId: record.bootId ?? undefined },
      judge.self,
      () => judge.dataRootIsOnLocalDisk(userDataPath)
    )
    if (judgeable && !isAlive(record.pid)) {
      continue
    }
    for (const path of [record.entryPath, record.spawnerExecPath]) {
      const slot = path ? slotContaining(cacheRoot, path) : null
      if (slot) {
        slots.push(slot)
      }
    }
  }
  return slots
}

function slotContaining(cacheRoot: string, path: string): string | null {
  const rel = relative(resolve(cacheRoot), resolve(path))
  const [target, slot] = rel.split(sep)
  return rel && !isAbsolute(rel) && target !== '..' && target && slot ? slot : null
}

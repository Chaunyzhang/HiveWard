/** Use kernel boot ID and /proc start ticks for distro/process identity; wall-clock jumps after host sleep can misidentify live processes (microsoft/WSL#4179/#10006). */
import type { HivewarddProcessIncarnation } from '../hivewardd/hivewardd-process-start-time'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'

export type WslGuestIdentity = {
  /** `<boot_id>:<pid 1 start ticks>`; a distro restart (or a VM restart) changes it. */
  distroInstance: string
  /** hivewardd's `<pid>:<start ticks>`; null when no pid was asked for or the process is gone. */
  hivewardd: string | null
}

const SECTION = '--hiveward-identity--'
const IDENTITY_TIMEOUT_MS = 10_000

/** One exec, so a classification never mixes two distro incarnations. */
export function wslGuestIdentityCommand(hivewarddPid: number | null): string {
  return wslGuestIdentityShellCommand(
    hivewarddPid !== null && Number.isSafeInteger(hivewarddPid) && hivewarddPid > 0 ? String(hivewarddPid) : null
  )
}

/** `pidWord` is a digits-only word, literal or a shell expansion the caller has validated. */
export function wslGuestIdentityShellCommand(pidWord: string | null): string {
  const hivewardd = pidWord !== null ? `cat /proc/${pidWord}/stat 2>/dev/null; ` : ''
  return [
    `cat /proc/sys/kernel/random/boot_id; echo ${SECTION}; cat /proc/1/stat; echo ${SECTION}; `,
    `${hivewardd}echo ${SECTION}`
  ].join('')
}

/** Field 22 of `/proc/<pid>/stat`; the name in field 2 may hold spaces and parentheses. */
export function procStatStartTicks(stat: string): string | null {
  const nameEnd = stat.lastIndexOf(')')
  if (nameEnd === -1) {
    return null
  }
  const fields = stat
    .slice(nameEnd + 1)
    .trim()
    .split(/\s+/)
  // Fields after the name start at field 3 (state), so field 22 sits at index 19.
  const ticks = fields[19]
  return ticks && /^\d+$/.test(ticks) ? ticks : null
}

function procStatPid(stat: string): string | null {
  const pid = /^\s*(\d+)\s+\(/.exec(stat)?.[1]
  return pid ?? null
}

export function parseWslGuestIdentity(output: string): WslGuestIdentity | null {
  const sections = output.split(SECTION)
  if (sections.length < 4) {
    return null
  }
  const bootId = sections[0].trim().split(/\s+/).at(-1) ?? ''
  const initTicks = procStatStartTicks(sections[1])
  if (!/^[0-9a-f-]{36}$/i.test(bootId) || !initTicks) {
    return null
  }
  const hivewarddStat = sections[2].trim()
  const hivewarddPid = hivewarddStat ? procStatPid(hivewarddStat) : null
  const hivewarddTicks = hivewarddStat ? procStatStartTicks(hivewarddStat) : null
  return {
    distroInstance: `${bootId.toLowerCase()}:${initTicks}`,
    hivewardd: hivewarddPid && hivewarddTicks ? `${hivewarddPid}:${hivewarddTicks}` : null
  }
}

/** The asked-for PID's identity in the form hivewardd's instance lock records; null when it is gone. */
export function wslGuestHivewarddIncarnation(
  identity: WslGuestIdentity
): HivewarddProcessIncarnation | null {
  const linuxStartTicks = identity.hivewardd?.split(':')[1]
  const bootId = identity.distroInstance.split(':')[0]
  return linuxStartTicks && bootId ? { linuxStartTicks, bootId } : null
}

/** null when the guest could not answer: that is unverifiable, never evidence of an exit. */
export async function readWslGuestIdentity(
  conn: HivewarddHostTransport,
  hivewarddPid: number | null
): Promise<WslGuestIdentity | null> {
  try {
    return parseWslGuestIdentity(
      await execCommand(conn, wslGuestIdentityCommand(hivewarddPid), {
        timeoutMs: IDENTITY_TIMEOUT_MS
      })
    )
  } catch {
    return null
  }
}

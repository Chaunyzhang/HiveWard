/**
 * WSL reads an active slot's liveness, readiness and pid in one guest command; SSH keeps
 * `probeActiveHivewarddReadiness`'s separate reads. The answers are judged exactly as those are.
 */
import type { HivewarddHostTarget } from '../ssh/hivewardd-host-transport'
import type { HivewarddRemoteContext } from '../managed-server/install/hivewardd-remote-context'
import { hivewarddLivenessProbeCommand } from '../managed-server/install/hivewardd-remote-launch'
import { readHivewarddReadinessNowCommand } from '../managed-server/install/hivewardd-remote-readiness-wait'
import { execHivewarddRemote } from '../managed-server/install/hivewardd-remote-runtime-control'
import { HIVEWARDD_PID_FILENAME } from '../managed-server/install/hivewardd-remote-host-support'
import { managedHivewarddInstallDir } from '../managed-server/lifecycle/hivewardd-managed-runtime-context'
import {
  activeHivewarddReadinessFromOutput,
  assertActiveHivewarddLive,
  HivewarddActiveReadinessError
} from '../ssh/hivewardd-active-readiness'
import { computeLocalHivewarddBuildHash } from '../ssh/hivewardd-local-build-hash'
import type { ServeReadiness } from '../server/serve-readiness'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { joinRemotePath } from '../ssh/ssh-remote-platform'

const SECTION_END = '__HIVEWARD_WSL_ACTIVE_PROBE_END__'

type WslContext = HivewarddRemoteContext<HivewarddHostTarget>

function pidCommand(context: WslContext, fullVersion: string): string {
  const pidFile = joinRemotePath(
    context.host,
    managedHivewarddInstallDir(context, fullVersion),
    HIVEWARDD_PID_FILENAME
  )
  return `cat ${quotePosixShell(pidFile)} 2>/dev/null || true`
}

function parsePid(output: string): number | null {
  const pid = Number.parseInt(output, 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export async function readWslHivewarddPid(
  context: WslContext,
  fullVersion: string,
  signal?: AbortSignal
): Promise<number | null> {
  return parsePid(
    await execCommand(context.connection, pidCommand(context, fullVersion), { signal })
  )
}

/** Each section ends with a marker on its own line; the newline before it is the probe's own. */
export function wslHivewarddActiveProbeCommand(context: WslContext, fullVersion: string): string {
  const installDir = managedHivewarddInstallDir(context, fullVersion)
  const end = `printf '\\n%s\\n' ${SECTION_END}`
  return [
    hivewarddLivenessProbeCommand(context.host, installDir),
    end,
    readHivewarddReadinessNowCommand(context.host, installDir),
    end,
    pidCommand(context, fullVersion)
  ].join('\n')
}

export async function probeWslActiveHivewardd(
  context: WslContext,
  localHivewarddDir: string,
  fullVersion: string,
  signal?: AbortSignal
): Promise<{ readiness: ServeReadiness; pid: number | null }> {
  const output = await execHivewarddRemote(
    { conn: context.connection, host: context.host, signal },
    wslHivewarddActiveProbeCommand(context, fullVersion)
  )
  const sections = output.split(`\n${SECTION_END}\n`)
  if (sections.length !== 3) {
    throw new HivewarddActiveReadinessError(
      'unverifiable',
      `hivewardd ${fullVersion} process state is unverifiable.`
    )
  }
  const [liveness = '', readiness = '', pid = ''] = sections
  const expectation = { buildHash: computeLocalHivewarddBuildHash(localHivewarddDir), fullVersion }
  assertActiveHivewarddLive(liveness, expectation)
  return {
    readiness: activeHivewarddReadinessFromOutput(context.host, readiness, expectation),
    pid: parsePid(pid)
  }
}

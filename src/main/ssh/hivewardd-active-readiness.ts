import {
  evaluateHivewarddActivation,
  type HivewarddActivationExpectation
} from '../managed-server/activation/hivewardd-activation-gate'
import {
  hivewarddLivenessProbeCommand,
  parseHivewarddLiveness,
  type HivewarddLaunchSpec,
  type HivewarddReadinessParse
} from '../managed-server/install/hivewardd-remote-launch'
import {
  execHivewarddRemote,
  launchHivewarddAndAwaitReadiness,
  type HivewarddRemoteExecTarget
} from '../managed-server/install/hivewardd-remote-runtime-control'
import {
  parseHivewarddReadinessWaitOutput,
  readHivewarddReadinessNowCommand
} from '../managed-server/install/hivewardd-remote-readiness-wait'
import type { ServeReadiness } from '../server/serve-readiness'
import { withHivewarddLogTail } from '../managed-server/install/hivewardd-remote-log-tail'
import type { RemoteHostPlatform } from './ssh-remote-platform'

type HivewarddReadinessFailureVerdict = 'exited' | 'unverifiable' | 'rejected'

export class HivewarddActiveReadinessError extends Error {
  constructor(
    readonly verdict: HivewarddReadinessFailureVerdict,
    message: string
  ) {
    super(message)
    this.name = 'HivewarddActiveReadinessError'
  }
}

function gatedReadiness(
  parsed: HivewarddReadinessParse,
  expectation: HivewarddActivationExpectation,
  label: string
): ServeReadiness {
  const readiness = parsed.state === 'ready' ? parsed.readiness : null
  const verdict = evaluateHivewarddActivation(readiness, expectation)
  if (verdict.decision === 'reject') {
    throw new HivewarddActiveReadinessError(
      'rejected',
      `${label} failed its readiness check: ${verdict.reason}`
    )
  }
  if (!readiness) {
    throw new HivewarddActiveReadinessError(
      'rejected',
      `${label} passed activation without a readiness payload.`
    )
  }
  const coverage = hivewarddDaemonCoverageRefusal(readiness)
  if (coverage) {
    throw new HivewarddActiveReadinessError('rejected', `${label} ${coverage}`)
  }
  return readiness
}

/** Require PTY self-test coverage, or handshake on platforms that cannot spawn-probe. Older slots without coverage metadata retain the identity-only gate. */
function hivewarddDaemonCoverageRefusal(readiness: ServeReadiness): string | null {
  const health = readiness.health
  const coverage = health?.terminalDaemon?.selfTest?.coverage
  if (!health || coverage === undefined || coverage === 'pty-spawn') {
    return null
  }
  if (coverage === 'handshake' && health.platform === 'win32') {
    return null
  }
  return (
    `reported terminal-daemon coverage '${String(coverage)}', which does not prove a PTY can ` +
    `be created on ${health.platform}.`
  )
}

export async function probeActiveHivewarddReadiness(
  target: HivewarddRemoteExecTarget & { remoteInstallDir: string },
  expectation: HivewarddActivationExpectation
): Promise<ServeReadiness> {
  assertActiveHivewarddLive(
    await execHivewarddRemote(target, hivewarddLivenessProbeCommand(target.host, target.remoteInstallDir)),
    expectation
  )
  return activeHivewarddReadinessFromOutput(
    target.host,
    await execHivewarddRemote(
      target,
      readHivewarddReadinessNowCommand(target.host, target.remoteInstallDir)
    ),
    expectation
  )
}

/** Throws unless the liveness probe's answer proves the active slot's process is running. */
export function assertActiveHivewarddLive(
  livenessOutput: string,
  expectation: HivewarddActivationExpectation
): void {
  const liveness = parseHivewarddLiveness(livenessOutput)
  if (liveness === 'DEAD') {
    throw new HivewarddActiveReadinessError(
      'exited',
      `hivewardd ${expectation.fullVersion} is recorded active but its process has exited.`
    )
  }
  if (liveness === 'NEVER_LAUNCHED') {
    throw new HivewarddActiveReadinessError(
      'exited',
      `hivewardd ${expectation.fullVersion} is recorded active but was never started from its install directory.`
    )
  }
  if (liveness !== 'LIVE') {
    throw new HivewarddActiveReadinessError(
      'unverifiable',
      `hivewardd ${expectation.fullVersion} process state is unverifiable.`
    )
  }
}

export function activeHivewarddReadinessFromOutput(
  host: RemoteHostPlatform,
  readinessOutput: string,
  expectation: HivewarddActivationExpectation
): ServeReadiness {
  return gatedReadiness(
    parseHivewarddReadinessWaitOutput(host, readinessOutput),
    expectation,
    'The active hivewardd'
  )
}

/** Accept recovery/rollback launches only when they prove the expected build. */
export async function launchHivewarddSlotAndAwaitReadiness(
  target: HivewarddRemoteExecTarget & {
    readinessTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
  spec: HivewarddLaunchSpec,
  expectation: HivewarddActivationExpectation
): Promise<ServeReadiness> {
  const parsed = await launchHivewarddAndAwaitReadiness(target, spec)
  try {
    return gatedReadiness(parsed, expectation, `hivewardd ${spec.fullVersion}`)
  } catch (error) {
    if (!(error instanceof HivewarddActiveReadinessError)) {
      throw error
    }
    const message = await withHivewarddLogTail(target, spec.remoteInstallDir, error.message)
    throw new HivewarddActiveReadinessError(error.verdict, message)
  }
}

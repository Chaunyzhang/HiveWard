import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import type { WslGuestIdentity } from './wsl-guest-process-identity'
import type { Trigger } from './wsl-hivewardd-liveness-state'
import { nextWslLivenessProbe, type WslLivenessEvidence } from './wsl-hivewardd-liveness-verdict'
import type { WslHivewarddWatch } from './wsl-hivewardd-watch'

/** How long a failed exit waits before trusting a list that still shows its distro running. */
export const EXIT_SETTLE_MS = 500

export function failedExit(trigger: Trigger): boolean {
  return trigger !== 'heartbeat' && trigger.source !== 'verify' && trigger.code !== 0
}

export function confirmsRunning(running: WslRunningDistrosRead, key: string): boolean {
  return (
    running.status === 'confirmed' &&
    running.distros.some((candidate) => wslDistroHolderKey(candidate) === key)
  )
}

/** Asks only what the classifier still needs, in order: identity, then hivewardd's port. */
export async function gatherWslLivenessEvidence(
  evidence: WslLivenessEvidence,
  probes: {
    readIdentity: () => Promise<WslGuestIdentity | null>
    probePort: () => Promise<WslHivewarddWatch['signal']>
  }
): Promise<WslLivenessEvidence> {
  for (let probe = nextWslLivenessProbe(evidence); probe; probe = nextWslLivenessProbe(evidence)) {
    if (probe === 'identity') {
      evidence.identity = await probes.readIdentity()
    } else {
      evidence.hivewarddPort = await probes.probePort()
    }
  }
  return evidence
}

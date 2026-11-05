// Restart only proven-stopped slots; unverifiable serving state never proves terminal exit.
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import { hivewarddBoundPort } from './hivewardd-managed-bound-port'
import { managedHivewarddSlot } from './hivewardd-managed-runtime-context'
import { wakeStoppedManagedHivewardd } from './hivewardd-managed-wake'
import { resolveHivewarddRemoteContext } from '../install/hivewardd-remote-context'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'

export type HivewarddManagedServing =
  | { state: 'serving' }
  /** Forwards must follow the restarted server's bound port. */
  | { state: 'started'; boundPort: number | null }
  | { state: 'unverifiable'; detail: string }

export type HivewarddManagedServingInput = {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: HivewarddHostTransport
  remotePort: number
  probe: (environment: KnownRuntimeEnvironment, timeoutMs: number) => Promise<boolean>
  answeredAt?: (environmentId: string) => number | null
}

export const MANAGED_HIVEWARDD_FENCED_DETAIL =
  'An update, rollback or recovery holds this host; it was not started.'

export const MANAGED_HIVEWARDD_NOT_ACTIVATED_DETAIL =
  'This host has no activated HiveWard server to start.'

const PROBE_TIMEOUT_MS = 5_000
// Share connect/tunnel verdicts only for the same transport and port; reboots/rebinds need fresh checks.
const VERDICT_REUSE_MS = 5_000
// Recent control-socket pongs prove serving; stop/reboot/rebind closes that socket.
const LIVE_ANSWER_PROOF_MS = 20_000

type ServingTransport = { connection: HivewarddHostTransport; generation: number; remotePort: number }
// Reconnected transports need fresh checks instead of inheriting dropped-connection failures.
type ServingCheck = ServingTransport & { check: Promise<HivewarddManagedServing>; settledAt?: number }
const checks = new Map<string, ServingCheck>()

function sameTransport(a: ServingTransport, b: ServingTransport): boolean {
  return (
    a.connection === b.connection && a.generation === b.generation && a.remotePort === b.remotePort
  )
}
export type ManagedHivewarddStartListener = {
  starting: (target: SshTarget) => void
  /** Unverifiable results include the reason and log tail. */
  settled: (target: SshTarget, environmentId: string, serving: HivewarddManagedServing) => void
}

let startListener: ManagedHivewarddStartListener | null = null

export function setManagedHivewarddStartListener(listener: ManagedHivewarddStartListener | null): void {
  startListener = listener
}

export function ensureManagedHivewarddServing(
  input: HivewarddManagedServingInput,
  now: () => number = Date.now
): Promise<HivewarddManagedServing> {
  const id = input.environment.id
  const transport: ServingTransport = {
    connection: input.connection,
    generation: input.connection.getConnectGeneration(),
    remotePort: input.remotePort
  }
  const entry = checks.get(id)
  if (
    entry &&
    sameTransport(entry, transport) &&
    (entry.settledAt === undefined || now() - entry.settledAt < VERDICT_REUSE_MS)
  ) {
    return entry.check
  }
  const answeredAt = input.answeredAt?.(id) ?? null
  const answerAge = answeredAt === null ? null : now() - answeredAt
  // Clock rollback must not extend the proof window.
  if (answerAge !== null && answerAge >= 0 && answerAge < LIVE_ANSWER_PROOF_MS) {
    return Promise.resolve({ state: 'serving' })
  }
  const next: ServingCheck = { ...transport, check: checkAndStart(input) }
  checks.set(id, next)
  void next.check.then(
    () => {
      next.settledAt = now()
    },
    () => {
      next.settledAt = -Infinity
    }
  )
  return next.check
}

export function resetManagedHivewarddServingForTests(): void {
  checks.clear()
}

async function checkAndStart(input: HivewarddManagedServingInput): Promise<HivewarddManagedServing> {
  if (await input.probe(input.environment, PROBE_TIMEOUT_MS)) {
    return { state: 'serving' }
  }
  let starting = false
  const serving = await wakeIfStopped(input, () => {
    starting = true
    startListener?.starting(input.target)
  })
  if (starting) {
    startListener?.settled(input.target, input.environment.id, serving)
  }
  return serving
}

async function wakeIfStopped(
  input: HivewarddManagedServingInput,
  onStarting: () => void
): Promise<HivewarddManagedServing> {
  const label = input.target.label
  try {
    const context = await resolveHivewarddRemoteContext(input.target, input.connection)
    const wake = await wakeStoppedManagedHivewardd(
      managedHivewarddSlot(context, input.remotePort),
      onStarting
    )
    if (wake.outcome === 'started') {
      const idle = wake.readiness.health?.previousIdleStop
      const cause = idle
        ? `it had stopped after idling at ${idle.stoppedAt}`
        : 'it had stopped without an idle-stop record (crash, signal or host restart)'
      console.info(`[ssh] Started the managed HiveWard server on ${label}; ${cause}.`)
      return { state: 'started', boundPort: hivewarddBoundPort(wake.readiness) }
    }
    // A live unanswered process may still be starting; never restart it.
    if (wake.outcome === 'serving') {
      // A live PID alone does not prove the server answers.
      if (await input.probe(input.environment, PROBE_TIMEOUT_MS)) {
        return { state: 'serving' }
      }
      const detail = 'This host’s HiveWard server process is live but is not answering.'
      console.warn(`[ssh] The managed HiveWard server on ${label} is not answering: ${detail}`)
      return { state: 'unverifiable', detail }
    }
    const detail = wake.outcome === 'recovery-refused' ? wake.reason : wakeRefusal(wake.outcome)
    console.warn(`[ssh] The managed HiveWard server on ${label} is not answering: ${detail}`)
    return { state: 'unverifiable', detail }
  } catch (error) {
    console.warn(`[ssh] Could not start the managed HiveWard server on ${label}:`, error)
    return { state: 'unverifiable', detail: error instanceof Error ? error.message : String(error) }
  }
}

function wakeRefusal(outcome: 'not-activated' | 'unverifiable' | 'fenced'): string {
  switch (outcome) {
    case 'fenced':
      return MANAGED_HIVEWARDD_FENCED_DETAIL
    case 'not-activated':
      return MANAGED_HIVEWARDD_NOT_ACTIVATED_DETAIL
    case 'unverifiable':
      return 'Whether the server process is still running could not be proven, so it was not started.'
  }
}

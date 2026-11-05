/** Stop terminals by handle, then managed-decommission hivewardd/daemon. Claim stopped only with zero-session census, exact serving-hivewardd identity and retired daemon evidence. */
import { z } from 'zod'
import { errorMessage } from '../../shared/error-message'
import type { HivewarddDecommissionResult } from '../../shared/hivewardd-decommission'
import { HIVEWARDD_MANAGED_REMOTE_PORT } from '../../shared/hivewardd-managed-runtime'
import type { HivewarddTerminalCensus } from '../../shared/hivewardd-terminal-census'
import type { RuntimeTerminalListResult } from '../../shared/runtime-terminal-contracts'
import { wslHostServerStopReason } from '../../shared/wsl-host-failure-copy'
import type { WslHostServerStop } from '../../shared/wsl-host-types'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'
import { readRemoteHivewarddManagedStopTarget } from '../managed-server/lifecycle/hivewardd-managed-remote-stop'
import { managedHivewarddSlot } from '../managed-server/lifecycle/hivewardd-managed-runtime-context'
import { resolveHivewarddRemoteContext } from '../managed-server/install/hivewardd-remote-context'
import { decommissionRemoteHivewardd } from '../managed-server/install/hivewardd-remote-decommission'
import type { WslHivewarddHostTarget } from './wsl-hivewardd-host-target'
import { readWslHostPeerDesktops, type WslHostPeerDesktops } from './wsl-host-peer-desktops'

const CENSUS_ATTEMPTS = 20
const CENSUS_INTERVAL_MS = 250

/** A terminal HiveWard asked to close but that may still run, named so the user can find it. */
export type WslHostTerminalLeftover = { handle: string; worktreeId: string; reason: string }

export type WslHostServerStopSteps = {
  /** Which other desktops share this server; throws when it can't say. */
  peerDesktops: () => Promise<WslHostPeerDesktops>
  /** Closes every terminal hivewardd runs; returns the ones that refused instead of stopping. */
  endTerminals: () => Promise<WslHostTerminalLeftover[]>
  census: () => Promise<HivewarddTerminalCensus>
  /** The runtime id of the hivewardd the bridge is serving; read before the bridge closes. */
  servingRuntimeId: () => Promise<string | null>
  /** After the bridge closed: liveness must not see this exit as a crash to recover. */
  closeBridge: () => Promise<void>
  decommission: (
    census: HivewarddTerminalCensus,
    servingRuntimeId: string | null
  ) => Promise<HivewarddDecommissionResult>
  sleep?: (ms: number) => Promise<void>
  /** A census that already waits on its own needs no retries; default 20, 250 ms apart. */
  censusAttempts?: number
}

function describeLeftovers(leftovers: readonly WslHostTerminalLeftover[]): string {
  return leftovers
    .map((leftover) => `${leftover.handle} (${leftover.worktreeId}): ${leftover.reason}`)
    .join('; ')
}

export async function stopWslHostServer(steps: WslHostServerStopSteps): Promise<WslHostServerStop> {
  const sleep = steps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const problems: string[] = []
  // Anything proven still running makes the stop `live`; only doubt leaves it `unverifiable`.
  let provenLive = false
  // Another HiveWard using this server keeps it: only this desktop lets go (R39).
  let peers: WslHostPeerDesktops
  try {
    peers = await steps.peerDesktops()
  } catch (error) {
    await steps.closeBridge()
    return {
      stopped: false,
      verdict: 'unverifiable',
      ...wslHostServerStopReason('peerCheckFailed', { detail: errorMessage(error) })
    }
  }
  if (peers.kind === 'shared') {
    await steps.closeBridge()
    return { stopped: true, keptForOtherDesktops: peers.names }
  }
  if (peers.kind === 'unsupported') {
    console.warn(
      '[wsl-hosts] This WSL host’s server predates the shared-host check; removing it ends its terminals for every HiveWard using it.'
    )
  }
  let leftovers: WslHostTerminalLeftover[] = []
  try {
    leftovers = await steps.endTerminals()
  } catch (error) {
    problems.push(`HiveWard couldn’t list the host’s terminals: ${errorMessage(error)}`)
  }
  // PTY close is not shell-exit proof; wait for zero-session census.
  let census = await steps.census()
  const attempts = steps.censusAttempts ?? CENSUS_ATTEMPTS
  for (let attempt = 1; attempt < attempts && census.liveSessions !== 0; attempt += 1) {
    await sleep(CENSUS_INTERVAL_MS)
    census = await steps.census()
  }
  const servingRuntimeId = await steps.servingRuntimeId().catch(() => null)
  await steps.closeBridge()
  if (leftovers.length > 0) {
    provenLive = true
    problems.push(`Terminals that refused to close: ${describeLeftovers(leftovers)}`)
  }
  if (census.liveSessions !== null && census.liveSessions > 0) {
    provenLive = true
  }
  if (census.liveSessions !== 0) {
    problems.push(
      census.liveSessions === null
        ? 'The terminal daemon did not answer a session count.'
        : `${census.liveSessions} terminal session${census.liveSessions === 1 ? '' : 's'} kept running.`
    )
  }
  // Decommission still verifies/refuses live sessions; retain its evidence.
  const result = await steps.decommission(census, servingRuntimeId)
  if (result.outcome === 'refused') {
    provenLive ||= result.verdict === 'live'
    problems.push(`HiveWard’s server kept running: ${result.reason}`)
  } else if (result.retirement !== 'retired') {
    provenLive ||= result.retirement === 'live'
    problems.push('HiveWard’s server stopped, but its terminal daemon is still running.')
  }
  return problems.length === 0
    ? { stopped: true }
    : {
        stopped: false,
        reason: problems.join(' '),
        verdict: provenLive ? 'live' : 'unverifiable'
      }
}

/** Use saved environment pairing and routed RPC for removal, never the bridge's raw pairing offer. */
export type WslHostRuntimeAccess = {
  isReady?: (environmentId: string) => boolean
  call: (environmentId: string, method: string, params: unknown) => Promise<unknown>
  census: (environmentId: string) => Promise<HivewarddTerminalCensus>
}

// Only what removal reads from each live terminal.
const TerminalHandlesSchema = z.object({
  terminals: z.array(z.object({ handle: z.string().min(1), worktreeId: z.string() }))
}) satisfies z.ZodType<{
  terminals: Pick<RuntimeTerminalListResult['terminals'][number], 'handle' | 'worktreeId'>[]
}>

const RuntimeIdSchema = z.object({ runtimeId: z.string().min(1) })

/** Closing terminals, counting what is left and naming the serving hivewardd, all through its RPC. */
export function wslHostRuntimeStopSteps(
  access: WslHostRuntimeAccess,
  environmentId: string
): Pick<WslHostServerStopSteps, 'peerDesktops' | 'endTerminals' | 'census' | 'servingRuntimeId'> {
  return {
    peerDesktops: () =>
      readWslHostPeerDesktops((method, params) => access.call(environmentId, method, params)),
    endTerminals: async () => {
      const list = TerminalHandlesSchema.parse(
        await access.call(environmentId, 'terminal.list', { limit: 1000 })
      )
      const leftovers: WslHostTerminalLeftover[] = []
      // Close by handle so deleted-project terminals remain addressable; one refusal must not skip other terminals/server stop.
      for (const terminal of list.terminals) {
        try {
          await access.call(environmentId, 'terminal.close', { terminal: terminal.handle })
        } catch (error) {
          leftovers.push({ ...terminal, reason: errorMessage(error) })
        }
      }
      return leftovers
    },
    census: () => access.census(environmentId),
    servingRuntimeId: async () =>
      RuntimeIdSchema.parse(await access.call(environmentId, 'status.get', undefined)).runtimeId
  }
}

/** After bridge close, decommission via wsl.exe only if recorded active hivewardd matches the previously serving runtime; re-add may have adopted another instance. */
export function decommissionWslHostHivewardd(
  target: WslHivewarddHostTarget,
  transport: HivewarddHostTransport
): WslHostServerStopSteps['decommission'] {
  return async (census, servingRuntimeId) => {
    const context = await resolveHivewarddRemoteContext(target, transport)
    const slot = managedHivewarddSlot(context, HIVEWARDD_MANAGED_REMOTE_PORT)
    const active = context.activationRecord.active
    if (active) {
      const stopTarget = await readRemoteHivewarddManagedStopTarget(slot, active)
      const recordedRuntimeId = stopTarget.state === 'ready' ? stopTarget.context.runtimeId : null
      if (!servingRuntimeId || recordedRuntimeId !== servingRuntimeId) {
        return {
          outcome: 'refused',
          verdict: 'unverifiable',
          code: 'hivewardd_wsl_host_serving_instance_unproven',
          reason:
            'the hivewardd this computer was connected to is not the one the distro records as active, so HiveWard could not prove it stopped.'
        }
      }
    }
    return decommissionRemoteHivewardd({ ...slot, record: context.activationRecord, census })
  }
}

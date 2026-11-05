/** Prove each host gets only its required runtime without toolchain use, then either a live server or its expected classified refusal. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { expect } from 'vitest'
import { NODE_RUNTIME_ASSETS, pinnedNodeRuntimeAsset } from '../../../shared/node-runtime-pin'
import { HIVEWARDD_MANAGED_REMOTE_PORT } from '../../../shared/hivewardd-managed-runtime'
import { HIVEWARDD_RUNTIMES_DIRNAME } from '../../../shared/hivewardd-artifacts'
import type { SshTarget } from '../../../shared/ssh-types'
import { readHivewarddActivationRecord } from '../../managed-server/activation/hivewardd-activation-record-store'
import { classifyHivewarddHostUnavailable } from '../../hivewardd/hivewardd-host-unavailable'
import { managedHivewarddSlot } from '../../managed-server/lifecycle/hivewardd-managed-runtime-context'
import { hivewarddSlotDir, type HivewarddSlotOptions } from '../hivewardd-recovery-slot'
import { resolveHivewarddRemoteContext } from '../../managed-server/install/hivewardd-remote-context'
import { deployHivewardd } from '../hivewardd-remote-deploy'
import { getMainHttpClient, setMainHttpClient } from '../../network/http-client'
import {
  hivewarddLivenessProbeCommand,
  parseHivewarddLiveness
} from '../../managed-server/install/hivewardd-remote-launch'
import { execHivewarddRemote } from '../../managed-server/install/hivewardd-remote-runtime-control'
import {
  HIVEWARDD_PID_FILENAME,
  HIVEWARDD_READINESS_FILENAME
} from '../../managed-server/install/hivewardd-remote-host-support'
import { decommissionRemoteHivewardd } from '../../managed-server/install/hivewardd-remote-decommission'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  forbiddenToolActions,
  type HostileHostCellCore,
  type ManagedHivewarddExpectation
} from './ssh-hostile-host-cells'
import { connectHostileHost } from './ssh-hostile-host-test-harness'
import { hostExec, hostExecStatus, type HostileHostTarget } from './ssh-hostile-host-test-fixture'

const EMPTY_CENSUS = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }

export async function proveManagedHivewarddCell(
  cell: HostileHostCellCore,
  target: HostileHostTarget,
  sshTarget: SshTarget
): Promise<void> {
  const expected = cell.managed
  const conn = await connectHostileHost(sshTarget)
  try {
    const context = await resolveHivewarddRemoteContext(sshTarget, conn)
    expect(context.serverTarget).toBe(expected.runtime)
    const slot = managedHivewarddSlot(context, HIVEWARDD_MANAGED_REMOTE_PORT)
    const desktop = cell.desktopNoEgress ? refuseDesktopDownloads() : null
    const deploy = deployHivewardd({
      ...slot,
      target: context.serverTarget,
      census: EMPTY_CENSUS,
      recountCensus: async () => EMPTY_CENSUS,
      releaseIncumbentAdmission: async () => {},
      ...(desktop ? { runtimeCacheRoot: desktop.cacheRoot } : {})
    }).finally(() => desktop?.restore())
    if (expected.outcome === 'unavailable') {
      const failure = await deploy.then(
        (deployed) => new Error(`deploy did not fail: ${JSON.stringify(deployed)}`),
        (error: unknown) => error
      )
      expect(classifyHivewarddHostUnavailable(failure), String(failure)).toBe(expected.reason)
    } else {
      const deployed = await deploy
      const slotDir = hivewarddSlotDir(slot, deployed.fullVersion)
      await assertOnlyRuntimeUploaded(target, slotDir, expected)
      // The message carries the full reason, which toMatchObject's diff omits.
      expect(deployed, JSON.stringify(deployed)).toMatchObject({
        outcome: 'installed-and-activated'
      })
      await assertLiveThenDecommissioned(slot, slotDir, deployed.fullVersion)
    }
    if (desktop) {
      // With an empty cache and every fetch refused there was nothing to upload, so the host fetched it.
      expect(desktop.refusedUrls().length).toBeGreaterThan(0)
    }
    const toolLog = await hostExec(
      target,
      `cat ${quotePosixShell(target.forbiddenToolLog)} 2>/dev/null || true`
    )
    expect(forbiddenToolActions(toolLog)).toEqual([])
  } finally {
    await conn.disconnect().catch(() => {})
  }
}

/** A default runtime beside the expected one is the wrong upload this cell guards against. */
async function assertOnlyRuntimeUploaded(
  target: HostileHostTarget,
  slotDir: string,
  expected: ManagedHivewarddExpectation
): Promise<void> {
  const runtimes = posix.join(posix.dirname(slotDir), HIVEWARDD_RUNTIMES_DIRNAME)
  const runtimeDir = (sha: string): string => posix.join(runtimes, `node-${sha}`)
  const { executableSha256 } = pinnedNodeRuntimeAsset(expected.runtime)
  expect(await hostExecStatus(target, `test -x '${runtimeDir(executableSha256)}/bin/node'`)).toBe(0)
  for (const asset of Object.values(NODE_RUNTIME_ASSETS)) {
    if (asset.executableSha256 !== executableSha256) {
      expect(
        await hostExecStatus(target, `test -e '${runtimeDir(asset.executableSha256)}'`)
      ).not.toBe(0)
    }
  }
}

async function assertLiveThenDecommissioned(
  slot: HivewarddSlotOptions,
  slotDir: string,
  version: string
): Promise<void> {
  const liveness = async (): Promise<string> =>
    parseHivewarddLiveness(await execHivewarddRemote(slot, hivewarddLivenessProbeCommand(slot.host, slotDir)))
  expect(await liveness()).toBe('LIVE')
  await assertHivewarddRunsAtLoginUmask(slot, slotDir)
  const decommission = await decommissionRemoteHivewardd({
    ...slot,
    record: await readHivewarddActivationRecord(slot),
    census: EMPTY_CENSUS
  })
  expect(decommission, JSON.stringify(decommission)).toMatchObject({
    outcome: 'decommissioned',
    version
  })
  expect(await liveness()).toBe('DEAD')
}

/** #31125: inherit SSH login umask for user files while pairing-token readiness stays owner-only. Linux /proc exposes the daemon umask; macOS does not. */
async function assertHivewarddRunsAtLoginUmask(slot: HivewarddSlotOptions, slotDir: string): Promise<void> {
  if (slot.host.os !== 'linux') {
    return
  }
  const pidFile = quotePosixShell(posix.join(slotDir, HIVEWARDD_PID_FILENAME))
  const readiness = quotePosixShell(posix.join(slotDir, HIVEWARDD_READINESS_FILENAME))
  const [login, daemon, readinessMode] = (
    await execHivewarddRemote(
      slot,
      `umask; sed -n 's/^Umask:[[:space:]]*//p' "/proc/$(cat ${pidFile})/status"; stat -c %a ${readiness}`
    )
  )
    .trim()
    .split('\n')
    .map((line) => line.trim())
  expect(Number.parseInt(daemon ?? '', 8), `login ${login}, hivewardd ${daemon}`).toBe(
    Number.parseInt(login ?? '', 8)
  )
  expect(readinessMode).toBe('600')
}

function refuseDesktopDownloads(): {
  cacheRoot: string
  refusedUrls: () => string[]
  restore: () => void
} {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'hiveward-hostile-desktop-no-egress-'))
  const refused: string[] = []
  const previous = getMainHttpClient()
  setMainHttpClient({
    fetch: async (url) => {
      refused.push(url)
      throw new Error('net::ERR_CONNECTION_REFUSED')
    },
    proxySession: () => null
  })
  return {
    cacheRoot,
    refusedUrls: () => refused,
    restore: () => {
      setMainHttpClient(previous)
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  }
}

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/hivewardd-managed-launch-env'
import {
  HIVEWARDD_IDLE_TIMEOUT_ENV,
  WSL_HIVEWARDD_IDLE_EXIT_TIMEOUT_MS
} from '../../../shared/hivewardd-idle-exit'

import {
  HIVEWARDD_READINESS_FILENAME,
  HivewarddRemoteLaunchUnsupportedError
} from './hivewardd-remote-host-support'
import {
  hivewarddLaunchCommand,
  hivewarddLivenessBlocksGc,
  hivewarddLivenessProvenExited,
  hivewarddLivenessProbeCommand,
  parseHivewarddLiveness,
  parseHivewarddReadinessOutput
} from './hivewardd-remote-launch'
import {
  hivewarddStopFreedTheHost,
  parseHivewarddStopOutcome,
  stopHivewarddCommand
} from './hivewardd-remote-process-control'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')

const SPEC = {
  remoteInstallDir: '/home/u/.hiveward-remote/hivewardd-0.2.0+bb01',
  nodePath: '/usr/bin/node',
  fullVersion: '0.2.0+bb01',
  userDataDir: '/home/u/.hiveward',
  bindHost: '127.0.0.1',
  port: 7777,
  activationRoot: '/home/u/.hiveward-remote/.hivewardd-activation-transaction'
}

const READY_LINE = JSON.stringify({
  type: 'hiveward_server_ready',
  schemaVersion: 1,
  runtimeId: 'r1',
  boundEndpoint: 'ws://127.0.0.1:7777',
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled',
  pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
  health: { buildHash: 'abc', terminalDaemon: { state: 'live' } }
})

describe('hivewarddLaunchCommand', () => {
  it('states the bind posture rather than inheriting the build default', () => {
    expect(hivewarddLaunchCommand(posix, SPEC)).toContain("--bind '127.0.0.1'")
  })

  it('truncates the readiness file, so a stale line cannot be activated on', () => {
    const command = hivewarddLaunchCommand(posix, SPEC)
    const cd = command.indexOf(`cd '${SPEC.remoteInstallDir}'`)
    const truncate = command.indexOf(`: > '${HIVEWARDD_READINESS_FILENAME}'`)
    const launch = command.indexOf('nohup')
    expect(cd).toBeGreaterThan(-1)
    expect(truncate).toBeGreaterThan(cd)
    expect(truncate).toBeLessThan(launch)
  })

  it('exports the version and the shared data root the deploy decided on', () => {
    const command = hivewarddLaunchCommand(posix, SPEC)
    expect(command).toContain(`HIVEWARD_VERSION '${SPEC.fullVersion}'`.replace(' ', '='))
    expect(command).toContain(`HIVEWARD_USER_DATA='${SPEC.userDataDir}'`)
  })

  it('names the activation fence on every launch, which enables idle exit', () => {
    const command = hivewarddLaunchCommand(posix, SPEC)
    expect(command).toContain(`${HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV}='${SPEC.activationRoot}'`)
    expect(command.indexOf(HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV)).toBeLessThan(
      command.indexOf('nohup')
    )
  })

  describe('idle timeout', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('never forwards a shorter idle timeout to an SSH launch, even from the desktop env', () => {
      vi.stubEnv(HIVEWARDD_IDLE_TIMEOUT_ENV, String(WSL_HIVEWARDD_IDLE_EXIT_TIMEOUT_MS))

      expect(hivewarddLaunchCommand(posix, SPEC)).not.toContain(HIVEWARDD_IDLE_TIMEOUT_ENV)
    })

    it('carries the host-supplied idle timeout on a WSL (setsid) launch', () => {
      const command = hivewarddLaunchCommand(posix, SPEC, 'setsid', [
        [HIVEWARDD_IDLE_TIMEOUT_ENV, String(WSL_HIVEWARDD_IDLE_EXIT_TIMEOUT_MS)]
      ])

      expect(command).toContain(`${HIVEWARDD_IDLE_TIMEOUT_ENV}='300000'`)
    })
  })

  it('declares the Windows refusal instead of emitting a command that cannot work', () => {
    expect(() => hivewarddLaunchCommand(windows, SPEC)).toThrow(HivewarddRemoteLaunchUnsupportedError)
  })
})

describe('readiness parsing', () => {
  it('extracts the hiveward_server_ready payload', () => {
    const parsed = parseHivewarddReadinessOutput(`${READY_LINE}\n`)
    expect(parsed).toMatchObject({ state: 'ready' })
    expect(parsed.state === 'ready' && parsed.readiness.boundEndpoint).toBe('ws://127.0.0.1:7777')
  })

  it('treats an empty or half-written file as pending, not as a failure', () => {
    expect(parseHivewarddReadinessOutput('')).toEqual({ state: 'pending' })
    expect(parseHivewarddReadinessOutput('{"type":"hiveward_serv')).toEqual({ state: 'pending' })
  })

  it('reports a complete JSON line that is not a readiness payload as malformed', () => {
    expect(parseHivewarddReadinessOutput('{"type":"something_else"}')).toMatchObject({
      state: 'malformed'
    })
  })
})

describe('liveness', () => {
  it('reads the pid recorded in the version dir', () => {
    expect(hivewarddLivenessProbeCommand(posix, SPEC.remoteInstallDir)).toContain('.hivewardd-pid')
  })

  it.each([
    ['LIVE', 'LIVE', true],
    ['DEAD', 'DEAD', false],
    ['NEVER_LAUNCHED', 'NEVER_LAUNCHED', false],
    ['', 'UNKNOWN', true],
    ['garbage', 'UNKNOWN', true]
  ])('parses %s and blocks GC = %s', (output, expected, blocks) => {
    expect(parseHivewarddLiveness(output)).toBe(expected)
    expect(hivewarddLivenessBlocksGc(parseHivewarddLiveness(output))).toBe(blocks)
  })

  // Real host (win-lowspec): after a distro restart the probe's own shell took the recorded PID.
  describe.skipIf(process.platform === 'win32')(
    'a recorded PID after a restart (real shell)',
    () => {
      const probeIn = (script: string): string =>
        spawnSync('sh', ['-c', script], { encoding: 'utf8' }).stdout

      async function withSlot(run: (slot: string, probe: string) => Promise<void>): Promise<void> {
        const slot = mkdtempSync(join(tmpdir(), 'hivewardd-liveness-'))
        try {
          await run(slot, hivewarddLivenessProbeCommand(posix, slot))
        } finally {
          rmSync(slot, { recursive: true, force: true })
        }
      }

      async function waitForArgs(pid: number | undefined, needle: string): Promise<void> {
        for (let i = 0; i < 100; i++) {
          const args = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
          if (args.stdout.includes(needle)) {
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        throw new Error(`process ${pid} never showed ${needle}`)
      }

      it('calls dead a PID held by the probe shell or the shell wrapping it', async () => {
        await withSlot(async (slot, probe) => {
          const own = probeIn(`echo $$ > '${slot}/.hivewardd-pid'; ${probe}`)
          expect(parseHivewarddLiveness(own)).toBe('DEAD')
          // The trailing `:` stops dash and bash from exec'ing the inner shell into the outer's PID.
          const wrapped = probeIn(
            `echo $$ > '${slot}/.hivewardd-pid'; sh -c ${JSON.stringify(probe).replace(/\$/g, '\\$')}; :`
          )
          expect(parseHivewarddLiveness(wrapped)).toBe('DEAD')
        })
      })

      it('keeps a live hivewardd, and the waiting shell of an older launcher, live', async () => {
        await withSlot(async (slot, probe) => {
          const entry = join(slot, 'hivewardd.js')
          writeFileSync(entry, 'setInterval(() => {}, 1000)\n')
          const hivewardd = spawn(process.execPath, [entry], { stdio: 'ignore' })
          // Before `exec` landed in the launcher, the recorded PID was a shell waiting on node.
          const waiting = spawn('sh', ['-c', `'${process.execPath}' '${entry}'; :`], {
            stdio: 'ignore',
            // Own process group, so cleanup also reaches the node the shell waits on.
            detached: true
          })
          try {
            await waitForArgs(hivewardd.pid, 'hivewardd.js')
            writeFileSync(join(slot, '.hivewardd-pid'), `${hivewardd.pid}\n`)
            expect(parseHivewarddLiveness(probeIn(probe))).toBe('LIVE')
            await waitForArgs(waiting.pid, 'hivewardd.js')
            writeFileSync(join(slot, '.hivewardd-pid'), `${waiting.pid}\n`)
            expect(parseHivewarddLiveness(probeIn(probe))).toBe('LIVE')
          } finally {
            hivewardd.kill()
            if (waiting.pid !== undefined) {
              process.kill(-waiting.pid, 'SIGKILL')
            }
          }
        })
      })
    }
  )

  it.each([
    ['DEAD', true],
    ['NEVER_LAUNCHED', true],
    ['LIVE', false],
    ['UNKNOWN', false]
  ] as const)('%s is proven exit = %s', (liveness, exited) => {
    expect(hivewarddLivenessProvenExited(liveness)).toBe(exited)
  })
})

describe('stopping a running hivewardd', () => {
  it('sends SIGTERM and never SIGKILL', () => {
    const command = stopHivewarddCommand(posix, SPEC.remoteInstallDir, {
      waitSeconds: 20,
      nodePath: SPEC.nodePath
    })
    expect(command).toContain('kill -TERM')
    for (const kill of ['kill -9', 'kill -KILL', 'kill -SIGKILL', 'pkill']) {
      expect(command).not.toContain(kill)
    }
  })

  it.each([
    ['STOPPED', 'stopped', true],
    ['ALREADY_EXITED', 'already-exited', true],
    ['NO_PID', 'no-pid', false],
    ['STILL_RUNNING', 'still-running', false],
    ['SIGNAL_FAILED', 'signal-failed', false],
    ['UNKNOWN', 'unknown', false],
    ['SIGNALED\nUNKNOWN', 'unconfirmed', false],
    ['', 'unconfirmed', false]
  ])('parses %s and frees the host = %s', (output, expected, frees) => {
    expect(parseHivewarddStopOutcome(output)).toBe(expected)
    expect(hivewarddStopFreedTheHost(parseHivewarddStopOutcome(output))).toBe(frees)
  })
})

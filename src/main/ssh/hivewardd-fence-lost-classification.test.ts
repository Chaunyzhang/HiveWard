import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientChannel } from 'ssh2'
import { execHivewarddStateMutation } from '../managed-server/host-state/hivewardd-state-mutation-exec'
import {
  execHivewarddRemote,
  execHivewarddRemoteOr
} from '../managed-server/install/hivewardd-remote-runtime-control'
import {
  HIVEWARDD_FENCE_LOST_MARKER,
  HivewarddFenceLostError,
  posixHivewarddFenceGuard,
  runWithHivewarddFence
} from '../managed-server/activation/hivewardd-activation-fence-scope'

import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'

import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { HivewarddHostTransport } from './hivewardd-host-transport'

/** Model an exec channel whose unreachable host never acknowledges close. */
class HostChannel extends EventEmitter {
  readonly stderr = Object.assign(new EventEmitter(), { resume: () => {} })
  readonly stdin = this
  close(): void {}
  resume(): void {}
  exit(code: number, stdout: string): void {
    this.emit('data', Buffer.from(stdout))
    this.emit('close', code)
  }
}

let channel: HostChannel
const commands: string[] = []
const conn = {
  exec: async (command: string) => {
    commands.push(command)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand reads only the channel events, close() and resume() HostChannel implements.
    return channel as unknown as ClientChannel
  },
  usesSystemSshTransport: () => false
}
const target = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only exec and usesSystemSshTransport are read.
  conn: conn as unknown as HivewarddHostTransport,
  host: getRemoteHostPlatform('linux-x64')
}
const fence = {
  lockDir: '/home/u/.hiveward-remote/.hivewardd-activation-transaction/.install-lock',
  token: 't1'
}

const mutation = `${posixHivewarddFenceGuard(fence)} restore`

function fenced<T>(run: () => Promise<T>): Promise<T> {
  return runWithHivewarddFence(fence, run)
}

async function settledAfter(step: Promise<unknown>, answer: () => void): Promise<unknown> {
  const settled = step.catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  answer()
  return settled
}

beforeEach(() => {
  vi.useFakeTimers()
  channel = new HostChannel()
  commands.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

// Real exec errors quote commands that contain the guard marker; that alone must not imply fence loss.
describe('a fenced step through the real exec', () => {
  it('stays an ordinary failure when the step itself exits nonzero', async () => {
    const error = await settledAfter(
      fenced(() => execHivewarddRemote(target, 'false')),
      () => channel.exit(1, 'boom\n')
    )
    expect(commands[0]).toContain(HIVEWARDD_FENCE_LOST_MARKER)
    expect(error).not.toBeInstanceOf(HivewarddFenceLostError)
    expect(error).toMatchObject({ exitCode: 1, stdout: 'boom\n' })
  })

  it('keeps a timed-out step unconfirmed, so the fence is not released under it', async () => {
    const settled = fenced(() => execHivewarddRemoteOr(target, 'sleep 99', 'FALLBACK')).catch(
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const error = await settled
    expect(error).not.toBeInstanceOf(HivewarddFenceLostError)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(true)
  })

  it('reads the guard’s own exit as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execHivewarddRemote(target, 'true')),
      () => channel.exit(75, `${HIVEWARDD_FENCE_LOST_MARKER}\n`)
    )
    expect(error).toBeInstanceOf(HivewarddFenceLostError)
  })

  it('does not read a marker-free exit 75 as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execHivewarddRemote(target, 'true')),
      () => channel.exit(75, 'other\n')
    )
    expect(error).not.toBeInstanceOf(HivewarddFenceLostError)
  })
})

describe('a fenced state mutation through the real exec', () => {
  it('stays an ordinary failure when the mutation exits nonzero', async () => {
    const error = await settledAfter(
      fenced(() => execHivewarddStateMutation(target, mutation)),
      () => channel.exit(2, 'no snapshot\n')
    )
    expect(error).not.toBeInstanceOf(HivewarddFenceLostError)
    expect(isUnconfirmedSshCommandTermination(error)).toBe(false)
  })

  it('reads the guard’s own exit as a lost fence', async () => {
    const error = await settledAfter(
      fenced(() => execHivewarddStateMutation(target, mutation)),
      () => channel.exit(75, `${HIVEWARDD_FENCE_LOST_MARKER}\n`)
    )
    expect(error).toBeInstanceOf(HivewarddFenceLostError)
  })
})

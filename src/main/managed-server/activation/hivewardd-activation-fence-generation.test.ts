import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { unusedHivewarddHostTransport } from '../../ssh/unused-host-transport.test-fixture'

// Execute generated host guards in real local shells.
const shell = vi.hoisted((): { env: NodeJS.ProcessEnv | undefined } => ({ env: undefined }))
vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => {
  const { runProcess } = await import('@hiveward/process-host')
  return {
    ...(await importOriginal<typeof ExecCommandModule>()),
    execCommand: async (_conn: unknown, command: string) => {
      const result = await runProcess({ program: '/bin/sh', args: ['-c', command], env: shell.env })
      if (result.code !== 0) {
        const { sshCommandExitError } = await import('../../ssh/remote-exec/remote-exec-command')
        throw sshCommandExitError(command, result.code ?? 1, result.stdout)
      }
      return result.stdout
    }
  }
})

const { withHivewarddActivationLock } = await import('./hivewardd-activation-lock')
const { hivewarddActivationFenceRefusal } = await import('./hivewardd-activation-fence-hold')
const { execHivewarddRemote } = await import('../install/hivewardd-remote-runtime-control')
const { HivewarddFenceLostError, runWithHivewarddFence } = await import('./hivewardd-activation-fence-scope')
const { execHivewarddStateMutation } = await import('../host-state/hivewardd-state-mutation-exec')
const { clearHivewarddStateSnapshotMembersCommand } = await import('../host-state/hivewardd-state-snapshot')
const { getRemoteHostPlatform } = await import('../../ssh/ssh-remote-platform')

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('a superseded activation fence holder', () => {
  it('can neither act nor release once a successor took its fence over', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hivewardd-fence-gen-'))
    homes.push(home)
    const root = join(home, '.hiveward-remote', '.hivewardd-activation-transaction')
    const fence = join(root, '.install-lock')
    const journal = join(root, 'transaction.json')
    const launched = join(home, 'launched-by-stale-holder')
    const conn = unusedHivewarddHostTransport()
    const options = { conn, host: getRemoteHostPlatform('linux-x64'), remoteHome: home }

    let resumeStale!: () => void
    let staleEntered = false
    const stale = withHivewarddActivationLock(
      options,
      async () => {
        staleEntered = true
        await new Promise<void>((resolve) => (resumeStale = resolve))
        await execHivewarddRemote(options, `touch '${launched}'`)
        return 'acted'
      },
      () => 'held'
    )
    await vi.waitFor(() => expect(staleEntered).toBe(true))
    // Model a suspended holder by aging its unrefreshed fence.
    utimesSync(fence, new Date(0), new Date(0))
    expect(await hivewarddActivationFenceRefusal(options, 'update')).toMatchObject({ cleared: true })

    let resumeSuccessor!: () => void
    let successorEntered = false
    const successor = withHivewarddActivationLock(
      options,
      async () => {
        writeFileSync(
          journal,
          JSON.stringify({ phase: 'mid-update', fenceToken: 'successor' }, null, 2)
        )
        successorEntered = true
        await new Promise<void>((resolve) => (resumeSuccessor = resolve))
        return 'done'
      },
      () => 'held',
      'successor'
    )
    await vi.waitFor(() => expect(successorEntered).toBe(true))

    resumeStale()
    await expect(stale).rejects.toBeInstanceOf(HivewarddFenceLostError)
    expect(existsSync(launched)).toBe(false)
    expect(existsSync(fence)).toBe(true)
    expect(existsSync(journal)).toBe(true)

    resumeSuccessor()
    expect(await successor).toBe('done')
    expect(existsSync(fence)).toBe(false)
    expect(existsSync(journal)).toBe(false)
  })

  it('leaves a successor’s journal and lock when its own release resumes after a stall', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hivewardd-fence-release-'))
    homes.push(home)
    const root = join(home, '.hiveward-remote', '.hivewardd-activation-transaction')
    const fence = join(root, '.install-lock')
    const journal = join(root, 'transaction.json')
    const bin = join(home, 'bin')
    const ready = join(home, 'ready')
    const resume = join(home, 'resume')
    mkdirSync(bin)
    // Stall the journal move immediately after release checks its token.
    writeFileSync(
      join(bin, 'mv'),
      `#!/bin/sh\nif [ "$1" = '${journal}' ] && [ ! -f '${ready}' ]; then touch '${ready}'; while [ ! -f '${resume}' ]; do sleep 0.05; done; fi\nexec /bin/mv "$@"\n`
    )
    chmodSync(join(bin, 'mv'), 0o755)
    const conn = unusedHivewarddHostTransport()
    const options = { conn, host: getRemoteHostPlatform('linux-x64'), remoteHome: home }
    shell.env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
    let finishSuccessor: (() => void) | undefined
    let successor: Promise<unknown> | undefined
    const first = withHivewarddActivationLock(
      options,
      async () => 'first',
      () => 'held',
      'first'
    )
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true))
      utimesSync(fence, new Date(0), new Date(0))
      expect(await hivewarddActivationFenceRefusal(options, 'update')).toMatchObject({ cleared: true })
      successor = withHivewarddActivationLock(
        options,
        async () => {
          writeFileSync(journal, JSON.stringify({ fenceToken: 'successor' }, null, 2))
          await new Promise<void>((resolve) => (finishSuccessor = resolve))
          return 'done'
        },
        () => 'held',
        'successor'
      )
      await vi.waitFor(() => expect(finishSuccessor).toBeDefined())
      writeFileSync(resume, '')
      expect(await first).toBe('first')
      expect(readFileSync(join(fence, '.hiveward-fence-owner'), 'utf8')).toBe('successor')
      expect(readFileSync(journal, 'utf8')).toContain('"fenceToken": "successor"')
    } finally {
      writeFileSync(resume, '')
      await first.catch(() => {})
      finishSuccessor?.()
      await successor
      shell.env = undefined
    }
  })

  it('refuses a superseded run’s state mutation before it touches profile state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hivewardd-fence-mutation-'))
    homes.push(home)
    const base = join(home, '.hiveward-remote')
    const root = join(home, 'root')
    const lockDir = join(base, '.hivewardd-activation-transaction', '.install-lock')
    mkdirSync(lockDir, { recursive: true })
    mkdirSync(join(root, 'profiles'), { recursive: true })
    writeFileSync(join(lockDir, '.hiveward-fence-owner'), 'successor')
    writeFileSync(join(root, 'profiles', 'state.json'), 'successor-state')
    const conn = unusedHivewarddHostTransport()
    const options = { conn, host: getRemoteHostPlatform('linux-x64'), remoteHome: home }
    await expect(
      runWithHivewarddFence({ lockDir, token: 'stale' }, () =>
        execHivewarddStateMutation(
          options,
          clearHivewarddStateSnapshotMembersCommand(options.host, root, base)
        )
      )
    ).rejects.toBeInstanceOf(HivewarddFenceLostError)
    expect(readFileSync(join(root, 'profiles', 'state.json'), 'utf8')).toBe('successor-state')
  })
})

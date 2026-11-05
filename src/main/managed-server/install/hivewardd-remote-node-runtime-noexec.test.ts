import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '@hiveward/process-host'
import {
  createExecProbedStageCommand,
  ensureRemoteHivewarddNodeRuntime
} from './hivewardd-remote-node-runtime'
import {
  assertRemoteNodeRuntimeStoreExecutable,
  RemoteNodeRuntimeNoexecError,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_NOEXEC
} from '../../ssh/hivewardd-remote-node-runtime-report'
import { classifyHivewarddHostUnavailable } from '../../hivewardd/hivewardd-host-unavailable'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { uploadRemoteInstallDirectory } from './remote-install-transfers'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedHivewarddHostTransport } from '../../ssh/unused-host-transport.test-fixture'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('./remote-install-transfers', () => ({
  uploadRemoteInstallDirectory: vi.fn(async () => {})
}))

const conn = unusedHivewarddHostTransport()
const host = getRemoteHostPlatform('linux-x64')
// Captured dash output for executing from a noexec home filesystem.
const NOEXEC_PROBE_REPLY = [
  REMOTE_NODE_RUNTIME_NOEXEC,
  'HIVEWARD_RUNTIME_EXIT=126',
  '/bin/sh: 1: /root/.hiveward-remote/runtimes/.stage-node-x-1/.exec-probe: Permission denied'
].join('\n')

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.mocked(execCommand).mockReset()
  vi.mocked(uploadRemoteInstallDirectory).mockClear()
})

describe('pinned-Node runtime store on a host that refuses to run programs', () => {
  it.skipIf(process.platform === 'win32')(
    'reports nothing and leaves no probe behind where programs may run',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'hivewardd-runtime-noexec-'))
      directories.push(root)
      const stage = join(root, 'runtimes', '.stage-node-x-1')
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', createExecProbedStageCommand(host, stage)],
        timeoutMs: 30_000
      })
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('')
      expect(existsSync(stage)).toBe(true)
      expect(readdirSync(stage)).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'skips the probe when the stage can’t be written, leaving a full disk to the upload',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'hivewardd-runtime-noexec-'))
      directories.push(root)
      const stage = join(root, '.stage-node-x-1')
      mkdirSync(stage, { mode: 0o500 })
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', createExecProbedStageCommand(host, stage)],
        timeoutMs: 30_000
      })
      chmodSync(stage, 0o700)
      expect(result).toMatchObject({ code: 0, stdout: '' })
    }
  )

  it('names the noexec store before fetching or uploading the ~40 MiB runtime', async () => {
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes(REMOTE_NODE_RUNTIME_MISSING)) {
        return REMOTE_NODE_RUNTIME_MISSING
      }
      if (command.includes('.exec-probe')) {
        return NOEXEC_PROBE_REPLY
      }
      return ''
    })
    const archivePath = vi.fn(async () => '/never/fetched.tar.gz')

    const failure = await ensureRemoteHivewarddNodeRuntime({
      conn,
      host,
      slotDir: '/root/.hiveward-remote/hivewardd-0.1.0+abc',
      target: 'linux-x64-glibc',
      archivePath
    }).catch((error: unknown) => error)

    expect(classifyHivewarddHostUnavailable(failure)).toBe('runtime_noexec')
    expect(String(failure)).toContain('/root/.hiveward-remote/runtimes')
    expect(archivePath).not.toHaveBeenCalled()
    expect(uploadRemoteInstallDirectory).not.toHaveBeenCalled()
    const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    expect(commands.at(-1)).toMatch(/^rm -rf '\/root\/\.hiveward-remote\/runtimes\/\.stage-/)
  })

  it('reads exit 126 as noexec in any locale', () => {
    const localized = `${REMOTE_NODE_RUNTIME_NOEXEC}\nHIVEWARD_RUNTIME_EXIT=126\nsh: 1: .exec-probe: Keine Berechtigung`
    expect(() =>
      assertRemoteNodeRuntimeStoreExecutable(localized, '/root/.hiveward-remote/runtimes')
    ).toThrow(RemoteNodeRuntimeNoexecError)
  })

  it('leaves any other probe failure to the self-test after the upload', async () => {
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('tar -xzf')) {
        return 'HIVEWARD_NODE_RUNTIME_READY'
      }
      if (command.includes(REMOTE_NODE_RUNTIME_MISSING)) {
        return REMOTE_NODE_RUNTIME_MISSING
      }
      if (command.includes('.exec-probe')) {
        return `${REMOTE_NODE_RUNTIME_NOEXEC}\nHIVEWARD_RUNTIME_EXIT=127\n/bin/sh: bad interpreter`
      }
      return command.includes('2>/dev/null') ? 'OK' : ''
    })
    await ensureRemoteHivewarddNodeRuntime({
      conn,
      host,
      slotDir: '/root/.hiveward-remote/hivewardd-0.1.0+abc',
      target: 'linux-x64-glibc',
      archivePath: async () => archive()
    })
    expect(uploadRemoteInstallDirectory).toHaveBeenCalledTimes(1)
  })
})

function archive(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hivewardd-runtime-noexec-archive-'))
  directories.push(dir)
  writeFileSync(join(dir, 'node.tar.gz'), 'archive')
  return join(dir, 'node.tar.gz')
}

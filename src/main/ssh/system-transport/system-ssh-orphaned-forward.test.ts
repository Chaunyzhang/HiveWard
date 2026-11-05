import { describe, expect, it, vi } from 'vitest'
import {
  findOrphanedHiveWardSshForward,
  stopOrphanedHiveWardSshForward,
  type SshForwardProcessRow
} from './system-ssh-orphaned-forward'

const EXPECTED = [
  '-o',
  'BatchMode=no',
  '-T',
  '-N',
  '-o',
  'ExitOnForwardFailure=no',
  '-L',
  '127.0.0.1:47123:127.0.0.1:6768',
  '--',
  'devbox'
]
// What an earlier version spawned for the same forward: ExitOnForwardFailure=yes.
const HIVEWARD_FORWARD =
  '/usr/bin/ssh -o BatchMode=no -T -N -o ExitOnForwardFailure=yes -L 127.0.0.1:47123:127.0.0.1:6768 -- devbox'

function row(pid: number, ppid: number, command: string, creationTimeMs?: number) {
  return { pid, ppid, command, creationTimeMs } satisfies SshForwardProcessRow
}

describe('findOrphanedHiveWardSshForward', () => {
  it('finds one reparented to a systemd --user subreaper', () => {
    const rows = [row(50, 1, '/usr/lib/systemd/systemd --user'), row(900, 50, HIVEWARD_FORWARD)]
    expect(findOrphanedHiveWardSshForward(rows, EXPECTED, 'linux')?.pid).toBe(900)
  })

  it('matches across the LogLevel=INFO this version adds, in either direction', () => {
    const withLogLevel = ['-o', 'BatchMode=no', '-o', 'LogLevel=INFO', ...EXPECTED.slice(2)]
    expect(
      findOrphanedHiveWardSshForward([row(900, 1, HIVEWARD_FORWARD)], withLogLevel, 'darwin')?.pid
    ).toBe(900)
    const newOrphan = `/usr/bin/ssh ${withLogLevel.join(' ')}`
    expect(findOrphanedHiveWardSshForward([row(900, 1, newOrphan)], withLogLevel, 'darwin')?.pid).toBe(
      900
    )
    const extraLogLevel = HIVEWARD_FORWARD.replace(' -T ', ' -o LogLevel=INFO -o LogLevel=INFO -T ')
    expect(findOrphanedHiveWardSshForward([row(900, 1, extraLogLevel)], EXPECTED, 'darwin')).toBeNull()
  })

  it('matches an orphan an earlier version spawned without the unmultiplexing -S none', () => {
    const unmultiplexed = ['-o', 'BatchMode=no', '-T', '-S', 'none', ...EXPECTED.slice(3)]
    expect(
      findOrphanedHiveWardSshForward([row(900, 1, HIVEWARD_FORWARD)], unmultiplexed, 'darwin')?.pid
    ).toBe(900)
    const otherControlPath = HIVEWARD_FORWARD.replace(' -T ', ' -T -S /tmp/cm ')
    expect(
      findOrphanedHiveWardSshForward([row(900, 1, otherControlPath)], unmultiplexed, 'darwin')
    ).toBeNull()
  })

  it("never picks a forward whose HiveWard is still running (another instance's tunnel)", () => {
    const rows = [
      row(400, 1, '/Applications/HiveWard.app/Contents/MacOS/HiveWard'),
      row(900, 400, HIVEWARD_FORWARD)
    ]
    expect(findOrphanedHiveWardSshForward(rows, EXPECTED, 'darwin')).toBeNull()
  })

  it("never picks the user's own ssh on the port, even an orphaned daemon in HiveWard's flag order", () => {
    const rows = [
      row(900, 1, 'ssh -N -L 127.0.0.1:47123:127.0.0.1:6768 devbox'),
      row(
        901,
        1,
        'ssh -o BatchMode=yes -T -N -o ExitOnForwardFailure=yes -L 127.0.0.1:47123:127.0.0.1:5432 -- production-db'
      ),
      row(902, 1, HIVEWARD_FORWARD.replace('-- devbox', '-- otherbox')),
      row(903, 1, HIVEWARD_FORWARD.replace('/usr/bin/ssh ', '/usr/bin/ssh -f -F /home/u/.ssh/prod '))
    ]
    expect(findOrphanedHiveWardSshForward(rows, EXPECTED, 'darwin')).toBeNull()
  })

  it('never picks a forward for another port that shares a prefix', () => {
    const command = HIVEWARD_FORWARD.replace('127.0.0.1:47123:', '127.0.0.1:471230:')
    expect(findOrphanedHiveWardSshForward([row(900, 1, command)], EXPECTED, 'darwin')).toBeNull()
  })

  it('on Windows, treats a missing or younger parent as gone', () => {
    const command = `"C:\\Windows\\System32\\OpenSSH\\ssh.exe" ${HIVEWARD_FORWARD.slice('/usr/bin/ssh '.length)}`
    expect(
      findOrphanedHiveWardSshForward([row(900, 400, command, 1_000)], EXPECTED, 'win32')?.pid
    ).toBe(900)
    expect(
      findOrphanedHiveWardSshForward(
        [row(400, 4, 'C:\\Program Files\\Other\\other.exe', 2_000), row(900, 400, command, 1_000)],
        EXPECTED,
        'win32'
      )?.pid
    ).toBe(900)
    expect(
      findOrphanedHiveWardSshForward(
        [row(400, 4, 'C:\\HiveWard\\HiveWard.exe', 500), row(900, 400, command, 1_000)],
        EXPECTED,
        'win32'
      )
    ).toBeNull()
  })

  it('on posix, matches a spaced option value that itself holds a normalized option', () => {
    const proxy = 'ProxyCommand=ssh -o ExitOnForwardFailure=yes -W %h:%p jump'
    const expected = ['-o', proxy, ...EXPECTED]
    const command = `/usr/bin/ssh -o ${proxy} ${EXPECTED.join(' ')}`
    expect(findOrphanedHiveWardSshForward([row(900, 1, command)], expected, 'linux')?.pid).toBe(900)
  })

  it('on Windows, matches the quoted command line of an argument with spaces', () => {
    const keyPath = 'C:\\Users\\neil\\AppData\\Local\\Temp\\hiveward-a7c5-win12\\Jane Doe\\id_ed25519'
    const head = ['-o', 'BatchMode=no', '-o', 'LogLevel=INFO', '-T', '-S', 'none', '-p', '22']
    const tail = ['-o', 'IdentitiesOnly=yes', '-N', '-o', 'ExitOnForwardFailure=no']
    const forward = ['-L', '127.0.0.1:47123:127.0.0.1:6768', '--', '10.255.255.1']
    const expected = [...head, '-i', keyPath, ...tail, ...forward]
    // Win32_Process.CommandLine captured on Windows 11 for a Node spawn of `expected`.
    const command = `"C:\\Program Files\\OpenSSH\\ssh.exe" ${head.join(' ')} -i "${keyPath}" ${[...tail, ...forward].join(' ')}`
    expect(findOrphanedHiveWardSshForward([row(900, 400, command)], expected, 'win32')?.pid).toBe(900)
    const unquoted = command.replace(`"${keyPath}"`, keyPath)
    const otherKey = command.replace('Jane Doe', 'Jane Doe2')
    const extraArg = command.replace(' -i ', ' -v -i ')
    for (const other of [unquoted, otherKey, extraArg]) {
      expect(findOrphanedHiveWardSshForward([row(900, 400, other)], expected, 'win32')).toBeNull()
    }
  })
})

function esrch(): Error {
  return Object.assign(new Error('gone'), { code: 'ESRCH' })
}

describe('stopOrphanedHiveWardSshForward', () => {
  it('terminates the orphan and waits until it is gone', async () => {
    let alive = true
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0 && !alive) {
        throw esrch()
      }
      if (signal === 'SIGTERM') {
        alive = false
      }
    })
    const stopped = await stopOrphanedHiveWardSshForward(47123, EXPECTED, {
      listProcesses: async () => [row(900, 1, HIVEWARD_FORWARD)],
      kill,
      readStartTimeMs: async () => 1_000,
      platform: 'darwin'
    })
    expect(stopped).toBe(true)
    expect(kill).toHaveBeenCalledWith(900, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(900, 'SIGKILL')
  })

  it('escalates to SIGKILL only while the same orphan is still there', async () => {
    vi.useFakeTimers()
    try {
      const kill = vi.fn()
      const stopping = stopOrphanedHiveWardSshForward(47123, EXPECTED, {
        listProcesses: async () => [row(900, 1, HIVEWARD_FORWARD)],
        kill,
        readStartTimeMs: async () => 1_000,
        platform: 'darwin'
      })
      await vi.advanceTimersByTimeAsync(3_000)
      await expect(stopping).resolves.toBe(true)
      expect(kill).toHaveBeenCalledWith(900, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never SIGKILLs a pid that was reused after SIGTERM', async () => {
    vi.useFakeTimers()
    try {
      const kill = vi.fn()
      const listProcesses = vi
        .fn()
        .mockResolvedValueOnce([row(900, 1, HIVEWARD_FORWARD)])
        .mockResolvedValue([row(900, 77, '/usr/bin/vim notes.txt'), row(77, 1, '/bin/zsh')])
      const readStartTimeMs = vi.fn().mockResolvedValueOnce(1_000).mockResolvedValue(90_000)
      const stopping = stopOrphanedHiveWardSshForward(47123, EXPECTED, {
        listProcesses,
        kill,
        readStartTimeMs,
        platform: 'darwin'
      })
      await vi.advanceTimersByTimeAsync(3_000)
      await stopping
      expect(kill).toHaveBeenCalledWith(900, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(900, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never SIGKILLs when the start time cannot be read, even for the same command', async () => {
    vi.useFakeTimers()
    try {
      const kill = vi.fn()
      const stopping = stopOrphanedHiveWardSshForward(47123, EXPECTED, {
        listProcesses: async () => [row(900, 1, HIVEWARD_FORWARD)],
        kill,
        readStartTimeMs: async () => null,
        platform: 'darwin'
      })
      await vi.advanceTimersByTimeAsync(3_000)
      await stopping
      expect(kill).not.toHaveBeenCalledWith(900, 'SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it('touches nothing when no orphan holds the port, or the table cannot be read', async () => {
    const kill = vi.fn()
    await expect(
      stopOrphanedHiveWardSshForward(47123, EXPECTED, {
        listProcesses: async () => [],
        kill,
        readStartTimeMs: async () => 1_000,
        platform: 'darwin'
      })
    ).resolves.toBe(false)
    await expect(
      stopOrphanedHiveWardSshForward(47123, EXPECTED, {
        listProcesses: async () => {
          throw new Error('ps failed')
        },
        kill,
        readStartTimeMs: async () => 1_000,
        platform: 'darwin'
      })
    ).resolves.toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})

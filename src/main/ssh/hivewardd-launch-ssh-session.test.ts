/** Runs the session record and probe through a real `/bin/sh` against a fake `ps` table. */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureHivewarddLaunchSshSessionCommand,
  HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME,
  hivewarddLaunchSshSessionProbeCommand,
  hivewarddSshSessionAncestorShellFunction,
  parseHivewarddLaunchSshSession,
  writeHivewarddLaunchSshSessionCommand
} from './hivewardd-launch-ssh-session'
import { hivewarddLaunchCommand } from '../managed-server/install/hivewardd-remote-launch'
import { HIVEWARDD_PID_FILENAME } from '../managed-server/install/hivewardd-remote-host-support'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const mac = getRemoteHostPlatform('darwin-arm64')
const linux = getRemoteHostPlatform('linux-x64')

// Fake ps rows are pid|ppid|comm|lstart|args; FAKE_PS_GONE means absent, otherwise unlisted PIDs model the calling shell.
const FAKE_PS = `#!/bin/sh
[ -n "$FAKE_PS_BROKEN" ] && exit 1
field=; pid=
while [ $# -gt 0 ]; do case "$1" in -o) field=\${2%=}; shift 2;; -p) pid=$2; shift 2;; *) shift;; esac; done
for gone in $FAKE_PS_GONE; do [ "$gone" = "$pid" ] && exit 1; done
row=$(awk -F'|' -v p="$pid" '$1 == p' "$FAKE_PS_TABLE")
[ -n "$row" ] || row="$pid|$FAKE_PS_SHELL_PARENT|/bin/sh|Thu Oct 15 09:00:00 2026"
case "$field" in
  pid) echo "$row" | cut -d'|' -f1;;
  ppid) echo "  $(echo "$row" | cut -d'|' -f2)";;
  comm) echo "$row" | cut -d'|' -f3;;
  lstart) echo "$row" | cut -d'|' -f4;;
  args) echo "$row" | cut -d'|' -f5;;
esac
`

// macOS pads lstart's day of month; a later read must still match the recorded one.
const TABLE = [
  '500|400|/usr/libexec/sshd-session|Thu Oct  9 08:00:00 2026',
  '400|1|/usr/libexec/sshd-session|Thu Oct  9 07:59:59 2026',
  '300|1|/usr/sbin/cron|Thu Oct  1 00:00:00 2026'
].join('\n')

let dir: string

function sh(script: string, env: Record<string, string> = {}): string {
  const result = spawnSync('/bin/sh', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
      FAKE_PS_TABLE: join(dir, 'ps-table'),
      FAKE_PS_SHELL_PARENT: '500',
      ...env
    }
  })
  return result.stdout
}

function writeRecord(pid: string, record: string | null): void {
  writeFileSync(join(dir, HIVEWARDD_PID_FILENAME), `${pid}\n`)
  if (record !== null) {
    writeFileSync(join(dir, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME), `${record}\n`)
  }
}

function publishDaemon(pid: number, args: string): void {
  spawnSync('mkdir', [join(dir, 'daemon')])
  writeFileSync(join(dir, 'daemon', 'daemon-v1.pid'), JSON.stringify({ pid, startedAtMs: 1 }))
  writeFileSync(
    join(dir, 'ps-table'),
    `${TABLE}\n${pid}|1|/opt/homebrew/bin/node|Thu Oct 9 07:59:59 2026|${args}`
  )
}

function launchRecord(env: Record<string, string> = {}): string {
  const pidFile = join(dir, HIVEWARDD_PID_FILENAME)
  return sh(
    `${captureHivewarddLaunchSshSessionCommand()} sleep 0 & echo $! > '${pidFile}' && ` +
      `${writeHivewarddLaunchSshSessionCommand(mac, dir)} && cat '${pidFile}'`,
    env
  ).trim()
}

function probe(env: Record<string, string> = {}): string {
  return parseHivewarddLaunchSshSession(sh(hivewarddLaunchSshSessionProbeCommand(mac, dir, dir), env))
}

describe.skipIf(process.platform === 'win32')('hivewardd launch SSH session', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hivewardd-ssh-session-'))
    const bin = join(dir, 'bin')
    spawnSync('mkdir', [bin])
    writeFileSync(join(bin, 'ps'), FAKE_PS)
    writeFileSync(join(bin, 'sw_vers'), '#!/bin/sh\necho "${FAKE_MACOS:-27.0.1}"\n')
    chmodSync(join(bin, 'ps'), 0o755)
    chmodSync(join(bin, 'sw_vers'), 0o755)
    writeFileSync(join(dir, 'ps-table'), TABLE)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds the nearest sshd ancestor, skipping the shells between', () => {
    const fn = hivewarddSshSessionAncestorShellFunction()
    expect(sh(`${fn} hivewardd_ssh_session 12345`).trim()).toBe('500 Thu Oct 9 08:00:00 2026')
  })

  it('finds no session for a process outside SSH', () => {
    const fn = hivewarddSshSessionAncestorShellFunction()
    const out = sh(`${fn} hivewardd_ssh_session 12345 || echo NONE`, { FAKE_PS_SHELL_PARENT: '300' })
    expect(out.trim()).toBe('NONE')
  })

  it('records the launch and its session after the detached PID', () => {
    const pidFile = join(dir, HIVEWARDD_PID_FILENAME)
    const out = sh(
      `${captureHivewarddLaunchSshSessionCommand()} sleep 0 & echo $! > '${pidFile}' && ` +
        `${writeHivewarddLaunchSshSessionCommand(mac, dir)} && cat '${pidFile}'`
    )
    const pid = out.trim()
    expect(pid).toMatch(/^\d+$/)
    expect(readFileSync(join(dir, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME), 'utf8').trim()).toBe(
      `${pid} 500 Thu Oct 9 08:00:00 2026`
    )
    expect(probe()).toBe('live')
  })

  it('records the session from the full macOS launch, which still prints the runtime PID', () => {
    writeFileSync(join(dir, 'hivewardd.js'), 'setTimeout(() => {}, 200)')
    const command = hivewarddLaunchCommand(mac, {
      remoteInstallDir: dir,
      nodePath: process.execPath,
      fullVersion: '1.0.0',
      userDataDir: dir,
      bindHost: '127.0.0.1',
      port: 0,
      activationRoot: join(dir, 'activation')
    })
    const pid = sh(command).trim()
    expect(pid).toMatch(/^\d+$/)
    expect(readFileSync(join(dir, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME), 'utf8').trim()).toBe(
      `${pid} 500 Thu Oct 9 08:00:00 2026`
    )
    expect(probe()).toBe('live')
    expect(probe({ FAKE_PS_GONE: '500' })).toBe('exited')
  })

  it('carries the earlier session forward when the terminal daemon outlived hivewardd', () => {
    writeRecord('1', '1 400 Thu Oct 9 07:59:59 2026')
    publishDaemon(
      process.pid,
      `node /x/daemon-entry.js --socket ${join(dir, 'daemon')}/daemon.sock`
    )
    const pid = launchRecord()
    expect(readFileSync(join(dir, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME), 'utf8').trim()).toBe(
      `${pid} 400 Thu Oct 9 07:59:59 2026`
    )
    expect(probe({ FAKE_PS_GONE: '400' })).toBe('exited')
  })

  it('records nothing when a surviving daemon’s session was never recorded', () => {
    publishDaemon(
      process.pid,
      `node /x/daemon-entry.js --socket ${join(dir, 'daemon')}/daemon.sock`
    )
    launchRecord()
    expect(existsSync(join(dir, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME))).toBe(false)
  })

  it.each([
    ['a stale PID file naming another process', '/usr/sbin/cron'],
    ['another data root’s daemon', 'node /x/daemon-entry.js --socket /other/daemon/daemon.sock']
  ])('records this launch’s own session over %s', (_case, args) => {
    writeRecord('1', '1 400 Thu Oct 9 07:59:59 2026')
    publishDaemon(process.pid, args)
    const pid = launchRecord()
    expect(readFileSync(join(dir, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME), 'utf8').trim()).toBe(
      `${pid} 500 Thu Oct 9 08:00:00 2026`
    )
  })

  it('leaves the attribution unknown when a live daemon’s command line can’t be read', () => {
    writeRecord('1', '1 400 Thu Oct 9 07:59:59 2026')
    publishDaemon(process.pid, '')
    launchRecord()
    expect(existsSync(join(dir, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME))).toBe(false)
  })

  it('creates the data root on a first deploy before recording', () => {
    const data = join(dir, 'fresh', 'data')
    const pidFile = join(dir, HIVEWARDD_PID_FILENAME)
    sh(
      `${captureHivewarddLaunchSshSessionCommand()} sleep 0 & echo $! > '${pidFile}' && ` +
        `${writeHivewarddLaunchSshSessionCommand(mac, data)}`
    )
    expect(existsSync(join(data, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME))).toBe(true)
  })

  it('removes an earlier record when this launch finds no session', () => {
    writeRecord('1', '1 500 Thu Oct 9 08:00:00 2026')
    sh(
      `${captureHivewarddLaunchSshSessionCommand()} sleep 0 & ${writeHivewarddLaunchSshSessionCommand(mac, dir)}`,
      {
        FAKE_PS_SHELL_PARENT: '300'
      }
    )
    expect(existsSync(join(dir, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME))).toBe(false)
  })

  it('reports exited once the launching session is gone', () => {
    writeRecord('77', '77 500 Thu Oct 9 08:00:00 2026')
    expect(probe({ FAKE_PS_GONE: '500' })).toBe('exited')
  })

  it('reads a reused PID with another start time as exited', () => {
    writeRecord('77', '77 500 Wed Oct 8 08:00:00 2026')
    expect(probe()).toBe('exited')
  })

  it('is unverifiable when ps cannot answer, never exited', () => {
    writeRecord('77', '77 500 Thu Oct 9 08:00:00 2026')
    expect(probe({ FAKE_PS_BROKEN: '1', FAKE_PS_GONE: '500' })).toBe('unverifiable')
  })

  it('is not recorded for a launch without a record, or one by an older client', () => {
    writeRecord('77', null)
    expect(probe({ FAKE_PS_GONE: '500' })).toBe('not-recorded')
    writeRecord('78', '77 500 Thu Oct 9 08:00:00 2026')
    expect(probe({ FAKE_PS_GONE: '500' })).toBe('not-recorded')
  })

  it('does not apply before macOS 15 or off macOS', () => {
    writeRecord('77', '77 500 Thu Oct 9 08:00:00 2026')
    expect(probe({ FAKE_MACOS: '14.7', FAKE_PS_GONE: '500' })).toBe('not-applicable')
    // Hide system sw_vers so every test host exercises its absence.
    writeFileSync(join(dir, 'bin', 'sw_vers'), '#!/bin/sh\nexit 127\n')
    expect(probe({ FAKE_PS_GONE: '500' })).toBe('not-applicable')
  })
})

describe('hivewardd launch command session record', () => {
  const spec = {
    remoteInstallDir: '/home/u/.hiveward-remote/hivewardd-1',
    nodePath: '/usr/bin/node',
    fullVersion: '1.0.0',
    userDataDir: '/home/u/.hiveward',
    bindHost: '127.0.0.1',
    port: 7777,
    activationRoot: '/home/u/.hiveward-remote/activation'
  }

  it('records the session only on a macOS nohup launch', () => {
    expect(hivewarddLaunchCommand(mac, spec)).toContain(HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME)
    expect(hivewarddLaunchCommand(mac, spec)).toMatch(/hivewardd_session=.* exec nohup /u)
    expect(hivewarddLaunchCommand(linux, spec)).not.toContain('hivewardd_session')
    expect(hivewarddLaunchCommand(mac, spec, 'setsid')).not.toContain('hivewardd_session')
  })

  it('still prints the detached PID last', () => {
    const command = hivewarddLaunchCommand(mac, spec)
    expect(command).toMatch(/^hivewardd_pid='[^']+\/\.hivewardd-pid';/u)
    expect(command).toMatch(/&& cat "\$hivewardd_pid"$/u)
  })
})

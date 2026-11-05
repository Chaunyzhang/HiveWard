import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@hiveward/process-host'
import {
  HIVEWARDD_LOG_FILENAME,
  HIVEWARDD_PID_FILENAME,
  HIVEWARDD_READINESS_FILENAME
} from './hivewardd-remote-host-support'
import { hivewarddLaunchCommand } from './hivewardd-remote-launch'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Pairing tokens in readiness require owner-only launch artifacts even under login umask 022.

const posix = getRemoteHostPlatform('linux-x64')
const READY_LINE = '{"type":"hiveward_server_ready","pairing":{"url":"hiveward://pair#token"}}'

let home: string
let baseDir: string
let slotDir: string

function writeEntry(dir: string, before = ''): void {
  writeFileSync(join(dir, 'hivewardd.js'), `${before}console.log(${JSON.stringify(READY_LINE)})\n`)
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

async function launchUnderLoginUmask(): Promise<void> {
  const command = hivewarddLaunchCommand(posix, {
    remoteInstallDir: slotDir,
    // No runtime marker selects the legacy host runtime; /bin/sh rejects V8 flags, so a JS one stands in.
    nodePath: process.execPath,
    fullVersion: '0.2.0+bb01',
    userDataDir: join(home, '.hiveward'),
    bindHost: '127.0.0.1',
    port: 7777,
    activationRoot: join(baseDir, '.hivewardd-activation-transaction')
  })
  await runProcess({ program: '/bin/sh', args: ['-c', `umask 022; ${command}`], timeoutMs: 10_000 })
  const readiness = join(slotDir, HIVEWARDD_READINESS_FILENAME)
  const deadline = Date.now() + 5_000
  while (!readFileSync(readiness, 'utf8').includes(READY_LINE) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe.skipIf(process.platform === 'win32')('hivewardd launch file modes', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hivewardd-launch-modes-'))
    baseDir = join(home, '.hiveward-remote')
    slotDir = join(baseDir, 'hivewardd-0.2.0+bb01')
    mkdirSync(slotDir, { recursive: true, mode: 0o755 })
    chmodSync(baseDir, 0o755)
    chmodSync(slotDir, 0o755)
    writeEntry(slotDir)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('creates the readiness, pid and log files owner-only', async () => {
    await launchUnderLoginUmask()

    expect(readFileSync(join(slotDir, HIVEWARDD_READINESS_FILENAME), 'utf8')).toContain(READY_LINE)
    expect(mode(join(slotDir, HIVEWARDD_READINESS_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, HIVEWARDD_PID_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, HIVEWARDD_LOG_FILENAME))).toBe(0o600)
  })

  it('tightens files and directories an earlier build left readable', async () => {
    for (const name of [HIVEWARDD_READINESS_FILENAME, HIVEWARDD_PID_FILENAME, HIVEWARDD_LOG_FILENAME]) {
      writeFileSync(join(slotDir, name), 'old', { mode: 0o644 })
      chmodSync(join(slotDir, name), 0o644)
    }

    await launchUnderLoginUmask()

    expect(mode(join(slotDir, HIVEWARDD_READINESS_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, HIVEWARDD_PID_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, HIVEWARDD_LOG_FILENAME))).toBe(0o600)
    expect(mode(slotDir)).toBe(0o700)
    expect(mode(baseDir)).toBe(0o700)
  })

  // Daemon children create user files and must retain login umask (#31125).
  it('runs the daemon itself at the login umask', async () => {
    writeEntry(
      slotDir,
      "require('node:fs').mkdirSync('daemon-dir'); require('node:fs').writeFileSync('daemon-file', '');"
    )

    await launchUnderLoginUmask()

    expect(mode(join(slotDir, 'daemon-file'))).toBe(0o644)
    expect(mode(join(slotDir, 'daemon-dir'))).toBe(0o755)
    expect(mode(join(slotDir, HIVEWARDD_READINESS_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, HIVEWARDD_PID_FILENAME))).toBe(0o600)
    expect(mode(join(slotDir, HIVEWARDD_LOG_FILENAME))).toBe(0o600)
  })

  it('leaves a parent that is not ~/.hiveward-remote alone', async () => {
    slotDir = join(home, 'custom-slot')
    mkdirSync(slotDir, { mode: 0o755 })
    chmodSync(home, 0o755)
    writeEntry(slotDir)

    await launchUnderLoginUmask()

    expect(mode(home)).toBe(0o755)
    expect(mode(slotDir)).toBe(0o700)
  })
})

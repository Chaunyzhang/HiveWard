import { describe, expect, it } from 'vitest'

import {
  captureHivewarddStateSnapshotCommand,
  clearHivewarddStateSnapshotMembersCommand,
  compareHivewarddStateSnapshotCommand,
  hivewarddSnapshotDirName,
  parseHivewarddSnapshotCapture,
  parseHivewarddSnapshotPresence,
  parseHivewarddSnapshotRestore,
  probeHivewarddStateSnapshotCommand,
  restoreHivewarddStateSnapshotCommand,
  HIVEWARDD_STATE_MUTATION_DEADLINE_SECONDS
} from './hivewardd-state-snapshot'
import { newestStateMtimeCommand, parseNewestStateMtimeSeconds } from './hivewardd-state-newest-mtime'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { HIVEWARDD_SNAPSHOT_EXCLUDED, HIVEWARDD_SNAPSHOT_MEMBERS } from './hivewardd-state-snapshot-members'

const posix = getRemoteHostPlatform('linux-x64')
const windows = getRemoteHostPlatform('win32-x64')
const ROOT = '/home/u/.hiveward'
const SNAP = '/home/u/.hiveward-remote/hivewardd-state-snapshots/pre-0.2.0+bb01-1000'
const BASE = '/home/u/.hiveward-remote'

function memberLists(command: string): string[] {
  return [...command.matchAll(/for m in ([^;]+);/g)].map((match) => match[1])
}

function innerScript(command: string): string {
  return command.replaceAll(`'\\''`, `'`)
}

describe('capturing the pre-activation snapshot', () => {
  it('captures the profile state a rollback needs', () => {
    expect(memberLists(captureHivewarddStateSnapshotCommand(posix, ROOT, SNAP, BASE))).toEqual([
      HIVEWARDD_SNAPSHOT_MEMBERS.join(' ')
    ])
  })

  // Restoring daemon sockets, PID or auth tokens would break adoption of terminals surviving restart.
  it.each(HIVEWARDD_SNAPSHOT_EXCLUDED)('never captures, removes or restores over %s', (excluded) => {
    const commands = [
      captureHivewarddStateSnapshotCommand(posix, ROOT, SNAP, BASE),
      restoreHivewarddStateSnapshotCommand(posix, ROOT, SNAP, BASE),
      clearHivewarddStateSnapshotMembersCommand(posix, ROOT, BASE),
      compareHivewarddStateSnapshotCommand(posix, ROOT, SNAP, BASE)
    ]
    for (const list of commands.flatMap(memberLists)) {
      expect(list.split(' ')).not.toContain(excluded)
    }
  })

  it('writes the archive under a temp name and renames, so a killed deploy leaves no torn tar', () => {
    const command = captureHivewarddStateSnapshotCommand(posix, ROOT, SNAP, BASE)
    expect(command).toContain('.partial')
    expect(command.indexOf('tar -C')).toBeLessThan(command.indexOf('mv '))
  })

  it.each([
    ['CAPTURED', 'captured'],
    ['EMPTY', 'empty'],
    ['tar: broken', 'failed'],
    ['', 'failed'],
    // Gateways may append shell job notices after a valid verdict (#30491).
    ['CAPTURED\r\nsh: line 1:  2468 Terminated   ( while sleep 60 ... )\n', 'captured'],
    ['FAILED\nCAPTURED-looking noise', 'failed']
  ])('parses %j as %s', (output, expected) => {
    expect(parseHivewarddSnapshotCapture(output)).toBe(expected)
  })

  it('keys the snapshot dir on both version and time, so a retry cannot overwrite one', () => {
    expect(hivewarddSnapshotDirName('0.2.0+bb01', 1000)).not.toBe(
      hivewarddSnapshotDirName('0.2.0+bb01', 2000)
    )
  })
})

describe('the host-side guard around every state mutation', () => {
  it.each([
    ['capture', () => captureHivewarddStateSnapshotCommand(posix, ROOT, SNAP, BASE)],
    ['restore', () => restoreHivewarddStateSnapshotCommand(posix, ROOT, SNAP, BASE)],
    ['clear', () => clearHivewarddStateSnapshotMembersCommand(posix, ROOT, BASE)]
  ])('%s runs under the host lock and a host-enforced deadline', (_label, build) => {
    const command = build()
    expect(command).toContain(
      `hiveward_deadline="timeout -s KILL ${HIVEWARDD_STATE_MUTATION_DEADLINE_SECONDS}"`
    )
    expect(command).toContain('hiveward_state_group $hiveward_deadline sh -c')
    expect(innerScript(command)).toContain(`lock='${BASE}/hivewardd-state-mutation.lock'`)
    expect(command).toContain('echo STATE_MUTATION_DEADLINE')
  })
})

describe('restoring the snapshot', () => {
  it('proves the archive extracts before clearing the live members', () => {
    const command = innerScript(restoreHivewarddStateSnapshotCommand(posix, ROOT, SNAP, BASE))
    const extract = command.indexOf('tar -C "$stage" -xf "$archive"')
    expect(extract).toBeGreaterThan(-1)
    expect(extract).toBeLessThan(command.indexOf('rm -rf "$root/$m"'))
  })

  it('reports a missing archive instead of extracting nothing and claiming success', () => {
    expect(restoreHivewarddStateSnapshotCommand(posix, ROOT, SNAP, BASE)).toContain('echo MISSING')
    expect(parseHivewarddSnapshotRestore('MISSING')).toBe('missing')
    expect(parseHivewarddSnapshotRestore('RESTORED')).toBe('restored')
    expect(parseHivewarddSnapshotRestore('FAILED')).toBe('failed')
    expect(parseHivewarddSnapshotRestore('RESTORED\nsh: line 1: 13 Terminated')).toBe('restored')
  })

  it.each([
    ['PRESENT', 'present'],
    ['ABSENT', 'absent'],
    ['', 'unverifiable'],
    ['bash: tar: command not found', 'unverifiable']
  ])('reads snapshot presence %j as %s, never treating silence as absence', (out, expected) => {
    expect(parseHivewarddSnapshotPresence(out)).toBe(expected)
  })
})

describe('detecting writes since activation', () => {
  it.each([
    ['1700000000', 1_700_000_000],
    ['UNKNOWN', null],
    ['', null]
  ])('parses %s', (output, expected) => {
    expect(parseNewestStateMtimeSeconds(output)).toBe(expected)
  })

  it('looks at the same members the snapshot covers', () => {
    const command = newestStateMtimeCommand(posix, ROOT, BASE)
    for (const member of HIVEWARDD_SNAPSHOT_MEMBERS) {
      expect(command).toContain(`'${member}'`)
    }
  })
})

describe('Windows hosts', () => {
  const BASE = 'C:/Users/u/.hiveward-remote'
  it.each([
    [
      'capture',
      'snapshot-capture',
      (base: string) => captureHivewarddStateSnapshotCommand(windows, ROOT, SNAP, base)
    ],
    [
      'restore',
      'snapshot-restore',
      (base: string) => restoreHivewarddStateSnapshotCommand(windows, ROOT, SNAP, base)
    ],
    [
      'clear',
      'snapshot-clear',
      (base: string) => clearHivewarddStateSnapshotMembersCommand(windows, ROOT, base)
    ],
    [
      'presence',
      'snapshot-probe',
      (base: string) => probeHivewarddStateSnapshotCommand(windows, SNAP, base)
    ],
    [
      'compare',
      'snapshot-compare',
      (base: string) => compareHivewarddStateSnapshotCommand(windows, ROOT, SNAP, base)
    ],
    ['mtime', 'state-newest-mtime', (base: string) => newestStateMtimeCommand(windows, ROOT, base)]
  ])('%s runs the host script op %s with node.exe, never a POSIX command', (_label, op, build) => {
    const command = build(BASE)
    expect(command).toContain(` ${op} `)
    expect(command).toMatch(/^C:\\Users\\u\\\.hiveward-remote\\runtimes\\node-[0-9a-f]+\\node\.exe /u)
    expect(command).not.toMatch(/tar |find |diff |EncodedCommand|powershell/u)
  })
})

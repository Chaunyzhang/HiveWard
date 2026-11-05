import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hivewarddRipgrepArtifact } from '../../../shared/hivewardd-artifacts'
import {
  listRemoteInstallBaseDirsCommand,
  probeRemoteInstallCompleteCommand
} from '../../ssh/ssh-remote-commands'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

import {
  inventoryRemoteInstallDirs,
  HIVEWARDD_INSTALL_MODEL,
  RELAY_INSTALL_MODEL,
  remoteInstallDirName,
  remoteInstallDirOwner,
  remoteInstallGcPermits,
  remoteInstallListingRegexSource,
  remoteInstallVersionDirRegex
} from './remote-install-model'

const RELAY_DIRS = ['relay-0.1.0+abcdef123456', 'relay-v0.1.0', 'relay-1.2.3']
const HIVEWARDD_DIRS = ['hivewardd-0.1.0+abcdef123456', 'hivewardd-v0.1.0', 'hivewardd-1.2.3']

it.each(['linux-x64', 'darwin-arm64', 'win32-x64'] as const)(
  'requires the runtime reference, node-pty and both profile workers on %s',
  (platform) => {
    const isWindows = platform.startsWith('win32')
    const artifacts = HIVEWARDD_INSTALL_MODEL.requiredArtifacts(getRemoteHostPlatform(platform))
    expect(artifacts).toContain('.runtime-node')
    expect(artifacts).not.toContain('bun-runtime')
    expect(artifacts).not.toContain('bun-runtime.exe')
    expect(artifacts).toContain(
      `node_modules/node-pty/build/Release/${isWindows ? 'conpty.node' : 'pty.node'}`
    )
    expect(artifacts).toContain('profile-state-writer-worker-entry.js')
    expect(artifacts).toContain('profile-state-backup-worker-entry.js')
    expect(artifacts.includes('windows-process-tree.node')).toBe(isWindows)
  }
)

describe('remote install namespace', () => {
  it('names each model its own version dir', () => {
    expect(remoteInstallDirName(RELAY_INSTALL_MODEL, '0.1.0+aa')).toBe('relay-0.1.0+aa')
    expect(remoteInstallDirName(HIVEWARDD_INSTALL_MODEL, '0.1.0+aa')).toBe('hivewardd-0.1.0+aa')
  })

  it("requires the host's own search binary in a completed standalone runtime install", () => {
    for (const platform of ['linux-arm64', 'darwin-x64', 'win32-arm64'] as const) {
      expect(
        HIVEWARDD_INSTALL_MODEL.requiredArtifacts(getRemoteHostPlatform(platform)).filter(
          (file) => file.startsWith('ripgrep/') && !file.startsWith('ripgrep/licenses/')
        )
      ).toEqual([hivewarddRipgrepArtifact(platform)])
    }
  })

  it.skipIf(process.platform === 'win32')('rejects an install missing its search binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hivewardd-remote-probe-'))
    try {
      const host = getRemoteHostPlatform('linux-x64')
      const required = [...HIVEWARDD_INSTALL_MODEL.requiredArtifacts(host), '.install-complete']
      for (const filename of required) {
        const path = join(dir, filename)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, '')
      }
      const command = probeRemoteInstallCompleteCommand(host, dir, required)
      expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' }).trim()).toBe('OK')
      rmSync(join(dir, hivewarddRipgrepArtifact('linux-x64')))
      expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' }).trim()).toBe('MISSING')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the relay listing pattern byte-identical to the one it shipped with', () => {
    // Preserve the shipped listing scope: widening it changes which existing directories GC can see.
    expect(remoteInstallListingRegexSource(RELAY_INSTALL_MODEL)).toBe(
      String.raw`^relay-(v?[0-9]+\.[0-9]+\.[0-9]+(\+[0-9a-f]+)?)(\.gc-tombstone\.[0-9]+\.[0-9]+)?$`
    )
  })

  it('refuses a dir prefix that could escape a remote glob or quote', () => {
    const injected = { ...RELAY_INSTALL_MODEL, dirPrefix: "relay'; rm -rf ~" }
    expect(() => remoteInstallVersionDirRegex(injected)).toThrow('Unsafe remote install dir prefix')
  })
})

describe('GC ownership — each model collects only its own namespace', () => {
  it.each(HIVEWARDD_DIRS)('the relay never permits GC of %s', (dirName) => {
    expect(remoteInstallDirOwner(dirName)).toBe('hivewardd')
    expect(remoteInstallGcPermits(RELAY_INSTALL_MODEL, dirName)).toBe(false)
  })

  it.each(RELAY_DIRS)('hivewardd never permits GC of %s', (dirName) => {
    expect(remoteInstallDirOwner(dirName)).toBe('relay')
    expect(remoteInstallGcPermits(HIVEWARDD_INSTALL_MODEL, dirName)).toBe(false)
  })

  it('permits each model its own dirs and its own tombstones', () => {
    expect(remoteInstallGcPermits(RELAY_INSTALL_MODEL, 'relay-0.1.0+aa')).toBe(true)
    expect(remoteInstallGcPermits(HIVEWARDD_INSTALL_MODEL, 'hivewardd-0.1.0+aa')).toBe(true)
    expect(remoteInstallGcPermits(HIVEWARDD_INSTALL_MODEL, 'hivewardd-0.1.0+aa.gc-tombstone.12.34')).toBe(
      true
    )
  })

  it('claims nothing it did not create', () => {
    for (const name of ['.hiveward-remote', 'hivewardd', 'relayish-0.1.0', 'hivewardd-notaversion', 'node']) {
      expect(remoteInstallDirOwner(name)).toBeNull()
      expect(remoteInstallGcPermits(RELAY_INSTALL_MODEL, name)).toBe(false)
      expect(remoteInstallGcPermits(HIVEWARDD_INSTALL_MODEL, name)).toBe(false)
    }
  })

  it('groups a mixed listing without losing anything to the wrong owner', () => {
    const inventory = inventoryRemoteInstallDirs([...RELAY_DIRS, ...HIVEWARDD_DIRS, 'something-else'])
    expect(inventory.relay).toEqual(RELAY_DIRS)
    expect(inventory.hivewardd).toEqual(HIVEWARDD_DIRS)
    expect(inventory.unknown).toEqual(['something-else'])
  })

  it('gives the shared runtime store its own owner that no version-dir GC may take', () => {
    expect(remoteInstallDirOwner('runtimes')).toBe('runtimes')
    expect(remoteInstallGcPermits(RELAY_INSTALL_MODEL, 'runtimes')).toBe(false)
    expect(remoteInstallGcPermits(HIVEWARDD_INSTALL_MODEL, 'runtimes')).toBe(false)
    expect(inventoryRemoteInstallDirs(['runtimes', ...RELAY_DIRS]).runtimes).toEqual(['runtimes'])
  })

  it.skipIf(process.platform === 'win32')(
    'keeps runtimes/ out of every model listing, including older clients’ prefix scans',
    () => {
      const base = mkdtempSync(join(tmpdir(), 'install-listing-'))
      try {
        for (const name of ['runtimes', 'relay-0.1.0+aa', 'hivewardd-0.1.0+aa']) {
          mkdirSync(join(base, name))
        }
        mkdirSync(join(base, 'runtimes', `node-${'a'.repeat(64)}`))
        const host = getRemoteHostPlatform('linux-x64')
        for (const model of [RELAY_INSTALL_MODEL, HIVEWARDD_INSTALL_MODEL]) {
          const listed = execFileSync(
            '/bin/sh',
            ['-c', listRemoteInstallBaseDirsCommand(host, base, model)],
            { encoding: 'utf8' }
          )
          expect(listed.trim().split('\n')).toEqual([`${model.dirPrefix}-0.1.0+aa`])
        }
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    }
  )
})

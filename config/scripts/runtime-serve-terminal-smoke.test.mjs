import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveCli } from './runtime-serve-terminal-smoke.mjs'
import { NODE_RUNTIME_ASSETS } from '../../src/shared/node-runtime-pin.ts'
import { currentTarget } from './server-build-target.mjs'
import { HIVEWARDD_CLI_ENTRY_FILENAME } from '../../src/shared/hivewardd-artifacts.ts'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'hiveward-smoke-cli-'))
  roots.push(root)
  const emitted = join(root, 'out', 'cli', 'index.js')
  mkdirSync(dirname(emitted), { recursive: true })
  writeFileSync(emitted, '')
  return root
}

it('drives Hivewardd with its packaged CLI and pinned Node even when a desktop CLI exists', () => {
  const root = checkout()
  const directory = join(root, 'out', 'hivewardd')
  const bundled = join(directory, HIVEWARDD_CLI_ENTRY_FILENAME)
  mkdirSync(dirname(bundled), { recursive: true })
  writeFileSync(bundled, '')
  expect(resolveCli('hivewardd', root)).toEqual({
    command: join(
      root,
      'out',
      'runtimes',
      `node-${NODE_RUNTIME_ASSETS[currentTarget()].executableSha256}`,
      ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node'])
    ),
    prefix: [bundled]
  })
})

it('fails if the packaged CLI is missing instead of using a stale desktop CLI', () => {
  expect(() => resolveCli('hivewardd', checkout())).toThrow('Missing packaged Hivewardd CLI')
})

it('retains the built desktop CLI for the Electron smoke', () => {
  const root = checkout()
  expect(resolveCli('electron', root)).toEqual({
    command: process.execPath,
    prefix: [join(root, 'out', 'cli', 'index.js')]
  })
})

#!/usr/bin/env node
// Builds one hivewardd package for a server target and, for the build host's own target, places the
// pinned Node it references at `<out>/../runtimes/node-<sha256>/` (design D2).
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_PIN,
  SERVER_TARGETS
} from '../../src/shared/node-runtime-pin.ts'
import { hivewarddNodeRuntimeRelativePath } from '../../src/shared/hivewardd-artifacts.ts'
import { HIVEWARDD_PREBUILDS_DIR } from './build-hivewardd-prebuilds.mjs'
import { findSlotProblems, readManifest } from './hivewardd-prebuild-slot-contents.mjs'
import { ensurePinnedNodeExecutable } from './pinned-node-downloads.mjs'
import { runProcessSync } from '@hiveward/process-host'
import { currentTarget } from './server-build-target.mjs'

const root = resolve(import.meta.dirname, '../..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

/** Where a package in `outputDir` finds its runtime; mirrors the host store's layout. */
export function packagedNodeRuntimePath(outputDir, target) {
  return join(
    outputDir,
    ...hivewarddNodeRuntimeRelativePath(target, NODE_RUNTIME_ASSETS[target].executableSha256)
  )
}

async function placeRuntime(outputDir, target) {
  const source = await ensurePinnedNodeExecutable({ target })
  const destination = packagedNodeRuntimePath(outputDir, target)
  mkdirSync(dirname(destination), { recursive: true })
  if (resolve(source) !== resolve(destination)) {
    rmSync(destination, { force: true })
    copyFileSync(source, destination)
  }
  if (!target.startsWith('win32-')) {
    chmodSync(destination, 0o755)
  }
  const version = runProcessSync({ program: destination, args: ['--version'] })
  if (version.code !== 0 || version.stdout.trim() !== `v${NODE_RUNTIME_PIN.version}`) {
    throw new Error(
      `Expected Node v${NODE_RUNTIME_PIN.version} at ${destination}, got ${version.stdout.trim() || version.stderr.trim()}`
    )
  }
  return destination
}

/** A missing host slot is built here, so `pnpm build:hivewardd` needs no separate prebuild step. */
function ensurePrebuildSlot(target, isCurrent) {
  if (findSlotProblems(readManifest(HIVEWARDD_PREBUILDS_DIR), HIVEWARDD_PREBUILDS_DIR, [target]).length) {
    if (!isCurrent) {
      throw new Error(
        `No verified node-pty prebuild for ${target} in ${HIVEWARDD_PREBUILDS_DIR}; build it on a ${target} runner`
      )
    }
    const result = runProcessSync({
      program: process.execPath,
      args: [join(root, 'config/scripts/build-hivewardd-prebuilds.mjs'), `--slot=${target}`],
      cwd: root,
      stdio: 'inherit',
      timeoutMs: null
    })
    if (result.code !== 0) {
      throw new Error(`node-pty prebuild for ${target} failed with exit ${result.code}`)
    }
  }
}

async function main() {
  const target = argument('--target') ?? currentTarget()
  if (!SERVER_TARGETS.includes(target)) {
    throw new Error(`Unsupported server target: ${target}`)
  }
  const outputDir = resolve(argument('--out-dir') ?? join(root, 'out', 'hivewardd'))
  const isCurrent = target === currentTarget()
  ensurePrebuildSlot(target, isCurrent)
  const runtimePath = isCurrent ? await placeRuntime(outputDir, target) : null
  const result = runProcessSync({
    program: process.execPath,
    args: [join(root, 'config/scripts/build-hivewardd.mjs')],
    cwd: root,
    env: {
      ...process.env,
      HIVEWARDD_BUILD_TARGET: target,
      HIVEWARDD_OUT_DIR: outputDir,
      HIVEWARDD_PREBUILDS_DIR: HIVEWARDD_PREBUILDS_DIR,
      ...(runtimePath ? { HIVEWARDD_NODE_RUNTIME_PATH: runtimePath } : {})
    },
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    process.exit(result.code ?? 1)
  }
  if (runtimePath && !existsSync(runtimePath)) {
    throw new Error(`build-hivewardd removed the runtime at ${runtimePath}`)
  }
}

if (process.argv[1]?.endsWith('build-hivewardd-node.mjs')) {
  await main()
}

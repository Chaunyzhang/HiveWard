import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@hiveward/process-host'
import { describeProcessFailure } from './process-failure-message.mjs'
import { isDirectInvocation } from './script-entry-detection.mjs'
import { supportsTsrs } from './tsrs-typecheck-compiler.mjs'
import {
  resolveProjectCompiler,
  resolveTypecheckBunExecutable,
  runTypecheckProjects,
  selectTypecheckCompiler
} from './run-typecheck-projects-in-parallel.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const CONFIG = 'config/tsconfig.build.cli.json'

export async function buildCli({
  root = ROOT,
  outDir = 'out',
  check = runTypecheckProjects,
  execute = runProcess,
  compiler = process.env.HIVEWARD_CLI_BUILD_COMPILER ?? 'bun',
  resolveBunExecutable = resolveTypecheckBunExecutable
} = {}) {
  if (compiler !== 'bun' && compiler !== 'tsrs') {
    throw new Error(`Invalid HIVEWARD_CLI_BUILD_COMPILER: ${compiler}`)
  }
  const emitArguments = [
    '-p',
    CONFIG,
    '--outDir',
    outDir,
    '--composite',
    'false',
    '--incremental',
    'false'
  ]
  if (compiler === 'tsrs') {
    const manifest = createRequire(join(root, 'package.json')).resolve('tsrs/package.json')
    const result = await execute({
      program: process.execPath,
      args: [join(dirname(manifest), 'bin', 'tsrs'), ...emitArguments, '--noEmitOnError'],
      cwd: root,
      stdio: 'inherit',
      timeoutMs: null
    })
    if (result.code !== 0) {
      throw new Error(`CLI compilation failed: ${describeProcessFailure(result)}`)
    }
    copyHiveWardRuntimeModules(root, outDir)
    return
  }
  const selection = selectTypecheckCompiler('bun', {
    root,
    resolveBunExecutable,
    fallbackHint: supportsTsrs() ? 'set HIVEWARD_CLI_BUILD_COMPILER=tsrs' : null
  })
  const failures = await check({
    ...selection,
    root,
    projects: [{ config: CONFIG, heapGib: 2 }],
    bunThreads: availableParallelism()
  })
  if (failures.length > 0) {
    throw failures[0]
  }

  // Bun has checked this exact project; retain TypeScript's emitter without checking it twice.
  const result = await execute({
    program: process.execPath,
    args: [resolveProjectCompiler(CONFIG, root), ...emitArguments, '--noCheck'],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`CLI emission failed: ${describeProcessFailure(result)}`)
  }
  copyHiveWardRuntimeModules(root, outDir)
}

export function copyHiveWardRuntimeModules(root, outDir) {
  for (const name of ['hiveward-environment.mjs', 'hiveward-profile-storage.mjs']) {
    const source = join(root, 'src/shared', name)
    if (!existsSync(source)) {continue}
    const directory = resolve(root, outDir, 'shared')
    mkdirSync(directory, { recursive: true })
    copyFileSync(source, join(directory, name))
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  try {
    await buildCli()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

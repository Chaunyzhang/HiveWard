import { copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runProcessSync } from '@hiveward/process-host'
import { HIVEWARDD_WINDOWS_SECURITY_FILENAME } from '../../src/shared/hivewardd-artifacts.ts'
import { windowsSecurityAddonOutput } from './build-windows-security-addon.mjs'

const { PE_MACHINE, describePeMachine, readPeMachine } = createRequire(import.meta.url)(
  './windows-pe-machine.cjs'
)

// ACL addon is required: missing it makes hivewardd’s data-root privacy check fail closed before Windows startup.
export function stageHivewarddWindowsSecurity(
  root,
  outputDir,
  target,
  host = { platform: process.platform },
  compile = compileHivewarddWindowsSecurity,
  options = {}
) {
  if (!target.startsWith('win32-')) {
    return
  }
  const arch = target.slice('win32-'.length)
  const source = windowsSecurityAddonOutput(root, arch)
  if (!existsSync(source)) {
    if (host.platform !== 'win32') {
      throw new Error(
        `Hivewardd ${target} requires the Windows security addon. On Windows, run: ` +
          `node config/scripts/build-windows-security-addon.mjs --arch=${arch}`
      )
    }
    compile(root, arch, options)
  }
  const machine = readPeMachine(source)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(`Hivewardd ${target} Windows security addon has ${describePeMachine(machine)}`)
  }
  copyFileSync(source, join(outputDir, HIVEWARDD_WINDOWS_SECURITY_FILENAME))
}

function compileHivewarddWindowsSecurity(
  root,
  arch,
  { enabled = false, runtimePath, run = runProcessSync } = {}
) {
  const result = run({
    program: process.execPath,
    args: [
      join(root, 'config/scripts/build-windows-security-addon.mjs'),
      `--arch=${arch}`,
      ...(enabled && runtimePath
        ? ['--reuse-prepared-runtime', `--node-runtime=${runtimePath}`]
        : [])
    ],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`Windows security addon build for ${arch} failed with exit ${result.code}`)
  }
}

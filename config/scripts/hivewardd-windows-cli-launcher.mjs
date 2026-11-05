import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@hiveward/process-host'
import { HIVEWARDD_WINDOWS_CLI_LAUNCHER_FILENAME } from '../../src/shared/hivewardd-artifacts.ts'

const { PE_MACHINE, describePeMachine, readPeMachine } = createRequire(import.meta.url)(
  './windows-pe-machine.cjs'
)

export function hivewarddWindowsCliLauncherSource(root, arch) {
  return join(root, '.build', 'windows-cli-launcher', arch, 'hiveward.exe')
}

/** A Windows slot's `hiveward` command; a Windows build host compiles a missing one. */
export function stageHivewarddWindowsCliLauncher(
  root,
  outputDir,
  target,
  host = { platform: process.platform },
  compile = compileHivewarddWindowsCliLauncher
) {
  if (!target.startsWith('win32-')) {
    return
  }
  const arch = target.slice('win32-'.length)
  const source = hivewarddWindowsCliLauncherSource(root, arch)
  if (!existsSync(source)) {
    if (host.platform !== 'win32') {
      throw new Error(
        `Hivewardd ${target} requires the native CLI launcher. On Windows, run: ` +
          `node config/scripts/build-windows-cli-launcher.mjs --arch ${arch} --output ${source}`
      )
    }
    compile(root, arch, source)
  }
  const machine = readPeMachine(source)
  if (machine !== PE_MACHINE[arch]) {
    throw new Error(`Hivewardd ${target} CLI launcher has ${describePeMachine(machine)}`)
  }
  const destination = join(outputDir, ...HIVEWARDD_WINDOWS_CLI_LAUNCHER_FILENAME.split('/'))
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}

function compileHivewarddWindowsCliLauncher(root, arch, output) {
  const result = runProcessSync({
    program: process.execPath,
    args: [
      join(root, 'config/scripts/build-windows-cli-launcher.mjs'),
      '--arch',
      arch,
      '--output',
      output
    ],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`Windows CLI launcher build for ${arch} failed with exit ${result.code}`)
  }
}

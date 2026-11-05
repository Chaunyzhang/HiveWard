import { accessSync, constants, existsSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { hivewarddAgentBrowserNativeName } from '../../shared/hivewardd-agent-browser-name'
import { ensureDependencyBinaryExecutable } from '../browser/agent-browser/agent-browser-dependency-binary'

/** A slot carries only its own target's driver, so trying both libc names needs no libc probe. */
function hostDriverNames(): string[] {
  const names = [hivewarddAgentBrowserNativeName(platform(), arch())]
  if (platform() === 'linux') {
    names.push(hivewarddAgentBrowserNativeName('linux', arch(), 'musl'))
  }
  return names
}

export function resolveHivewarddAgentBrowserBinary(): string | null {
  const candidates = hostDriverNames().flatMap((name) => [
    { path: join(dirname(process.argv[1] ?? __filename), name), dependency: false },
    { path: join(process.cwd(), 'node_modules', 'agent-browser', 'bin', name), dependency: true }
  ])
  for (const { path: candidate, dependency } of candidates) {
    if (!existsSync(candidate)) {
      continue
    }
    try {
      if (dependency) {
        ensureDependencyBinaryExecutable(candidate)
      }
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch {
      // Keep searching; a copied but non-executable binary is not a provider.
    }
  }
  return null
}

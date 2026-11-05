#!/usr/bin/env node
import { hivewardEnvironment } from '../../src/shared/hiveward-environment.mjs'

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { prepareDevCliTerminalWrappers } from './dev-cli-terminal-wrapper.mjs'
import { resolveDevCliUserDataPath } from './dev-instance-isolation.mjs'

const scriptPath = realpathSync(import.meta.filename)
const scriptDir = path.dirname(scriptPath)
const repoRoot = path.resolve(scriptDir, '..', '..')
const cliEntry =
  process.env.HIVEWARD_DEV_CLI_ENTRY_PATH ?? path.join(repoRoot, 'out', 'cli', 'index.js')

if (!existsSync(cliEntry)) {
  console.error("hiveward-dev: CLI not built yet. Run 'pnpm run build:cli' first.")
  process.exit(1)
}

// Why: target the profile this checkout's `pnpm dev` uses (per-worktree in linked worktrees).
process.env.HIVEWARD_USER_DATA_PATH = resolveDevCliUserDataPath({ repoRoot })
// Why: custom dev profiles do not necessarily contain "hiveward-dev" in their path; carry explicit provenance into the CLI.
process.env.HIVEWARD_DEV_CLI_INVOCATION = '1'
hivewardEnvironment.HIVEWARD_USER_DATA_PATH = process.env.HIVEWARD_USER_DATA_PATH

const electronExecutable = getElectronExecutable()
if (!process.env.HIVEWARD_APP_EXECUTABLE && isRunnableFile(electronExecutable)) {
  process.env.HIVEWARD_APP_EXECUTABLE = electronExecutable
  process.env.HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT = '1'
}

// Why: headless `hiveward-dev serve` skips the Electron dev runner that normally installs terminal CLI shims.
prepareDevCliTerminalWrappers({
  repoRoot,
  userDataPath: process.env.HIVEWARD_USER_DATA_PATH,
  electronExecutable: process.env.HIVEWARD_APP_EXECUTABLE ?? electronExecutable
})

const result = spawnSync(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
})

if (result.signal) {
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? (result.error ? 1 : 0))

function getElectronExecutable() {
  if (process.platform === 'win32') {
    return path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
  return path.join(repoRoot, 'node_modules', '.bin', 'electron')
}

function isRunnableFile(candidate) {
  try {
    const stats = statSync(candidate)
    if (!stats.isFile()) {
      return false
    }
    if (process.platform === 'win32') {
      return true
    }
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

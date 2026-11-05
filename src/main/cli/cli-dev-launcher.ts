import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { DEV_COMMAND_NAME, DEV_LAUNCHER_DIR } from './cli-install-constants'
import { escapeWindowsBatchValue, isAbsoluteForPlatform } from './cli-install-path-format'
import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell-argument-quoting'

export async function ensureDevLauncher(args: {
  platform: NodeJS.Platform
  userDataPath: string
  execPath: string
  cliEntryPath: string
  commandName: string
}): Promise<string | null> {
  if (
    !isAbsoluteForPlatform(args.platform, args.execPath) ||
    !isAbsolute(args.cliEntryPath) ||
    !existsSync(args.cliEntryPath)
  ) {
    return null
  }

  const launcherPath = join(
    args.userDataPath,
    ...DEV_LAUNCHER_DIR,
    args.platform === 'win32' ? `${args.commandName}.cmd` : args.commandName
  )
  await mkdir(dirname(launcherPath), { recursive: true })

  // Why: dev builds lack the packaged resources/bin launcher, so generate one in userData to validate the flow.
  const content =
    args.platform === 'win32'
      ? buildWindowsDevLauncher(args.execPath, args.cliEntryPath, args.userDataPath)
      : buildUnixCliLauncher(args.execPath, args.cliEntryPath, args.userDataPath)
  await writeFile(launcherPath, content, {
    encoding: 'utf8',
    mode: args.platform === 'win32' ? undefined : 0o755
  })
  if (args.commandName === DEV_COMMAND_NAME && args.platform !== 'win32') {
    // Why: dev PTYs prepend this dir to PATH, so keep local `hiwd` / `hiveward` without claiming the global command.
    // hiwd sits at <app>/hiveward/server/hiwd.mjs and forwards engine commands to <app>/out/cli/index.js.
    const hiwdEntryPath = join(
      dirname(dirname(dirname(args.cliEntryPath))),
      'hiveward',
      'server',
      'hiwd.mjs'
    )
    const aliasContent = existsSync(hiwdEntryPath)
      ? buildUnixCliLauncher(args.execPath, hiwdEntryPath, args.userDataPath)
      : content
    for (const alias of ['hiwd', 'hiveward']) {
      await writeFile(join(dirname(launcherPath), alias), aliasContent, {
        encoding: 'utf8',
        mode: 0o755
      })
    }
  }
  return launcherPath
}

export function buildUnixCliLauncher(
  execPathValue: string,
  cliEntryPath: string,
  userDataPath: string,
  runtime: 'electron' | 'node' = 'electron'
): string {
  if (runtime === 'node') {
    return `#!/usr/bin/env sh
set -eu
export HIVEWARD_USER_DATA_PATH=${quotePosixShellDoubleQuotedApostrophe(userDataPath)}
unset NODE_OPTIONS NODE_REPL_EXTERNAL_MODULE ELECTRON_RUN_AS_NODE
exec ${quotePosixShellDoubleQuotedApostrophe(execPathValue)} ${quotePosixShellDoubleQuotedApostrophe(cliEntryPath)} "$@"
`
  }
  return `#!/usr/bin/env bash
set -euo pipefail
ELECTRON=${quotePosixShellDoubleQuotedApostrophe(execPathValue)}
CLI=${quotePosixShellDoubleQuotedApostrophe(cliEntryPath)}
export HIVEWARD_USER_DATA_PATH=${quotePosixShellDoubleQuotedApostrophe(userDataPath)}
if [ -z "\${HIVEWARD_APP_EXECUTABLE:-}" ]; then
  export HIVEWARD_APP_EXECUTABLE="$ELECTRON"
  export HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT=1
fi
export HIVEWARD_NODE_OPTIONS="\${NODE_OPTIONS-}"
export HIVEWARD_NODE_REPL_EXTERNAL_MODULE="\${NODE_REPL_EXTERNAL_MODULE-}"
unset NODE_OPTIONS
unset NODE_REPL_EXTERNAL_MODULE
ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$CLI" "$@"
`
}

export function buildWindowsDevLauncher(
  execPathValue: string,
  cliEntryPath: string,
  userDataPath: string
): string {
  return `@echo off
setlocal
set "ELECTRON=${escapeWindowsBatchValue(execPathValue)}"
set "CLI=${escapeWindowsBatchValue(cliEntryPath)}"
set "HIVEWARD_USER_DATA_PATH=${escapeWindowsBatchValue(userDataPath)}"
if not defined HIVEWARD_APP_EXECUTABLE (
  set "HIVEWARD_APP_EXECUTABLE=%ELECTRON%"
  set "HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT=1"
)
set "HIVEWARD_NODE_OPTIONS=%NODE_OPTIONS%"
set "HIVEWARD_NODE_REPL_EXTERNAL_MODULE=%NODE_REPL_EXTERNAL_MODULE%"
set NODE_OPTIONS=
set NODE_REPL_EXTERNAL_MODULE=
set ELECTRON_RUN_AS_NODE=1
"%ELECTRON%" "%CLI%" %*
`
}

export function buildWindowsForwarder(launcherPath: string): string {
  return `@echo off
setlocal
set "HIVEWARD_LAUNCHER=${escapeWindowsBatchValue(launcherPath)}"
"%HIVEWARD_LAUNCHER%" %*
`
}

export function extractManagedUnixLauncherTarget(content: string): string | null {
  if (content.split('\n')[1] === '# hiveward-cli-dispatcher') {
    return extractShellAssignment(content, 'launcher')
  }
  if (
    !content.includes('ELECTRON_RUN_AS_NODE=1') ||
    !content.includes('HIVEWARD_NODE_OPTIONS') ||
    !content.includes('NODE_REPL_EXTERNAL_MODULE')
  ) {
    return null
  }

  const cliPath = extractShellAssignment(content, 'CLI')
  if (!cliPath) {
    return null
  }

  // Why: only HiveWard's compiled CLI entrypoints count as managed; arbitrary Electron-launching scripts stay conflicts.
  return /(?:^|[/\\])(?:out|app\.asar\.unpacked[/\\]out)[/\\]cli[/\\]index\.js$/.test(cliPath)
    ? cliPath
    : null
}

export function extractShellAssignment(content: string, name: string): string | null {
  const match = new RegExp(`^${name}=('([^']*)'|"([^"]*)"|([^\\n]+))$`, 'm').exec(content)
  if (!match) {
    return null
  }
  return (match[2] ?? match[3] ?? match[4] ?? '').trim()
}

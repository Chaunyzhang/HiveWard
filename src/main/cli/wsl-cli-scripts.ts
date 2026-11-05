import { quotePosixShellDoubleQuotedApostrophe } from '../../shared/shell-argument-quoting'
import { quotePowerShellLiteral } from '../../shared/powershell-native-argument'

const MANAGED_MARKER = '# HiveWard managed WSL CLI launcher'
const BRIDGE_MANAGED_MARKER = '# HiveWard managed WSL CLI PowerShell bridge'

const FIND_INTEROP_POWERSHELL = `if command -v powershell.exe >/dev/null 2>&1; then
  HIVEWARD_POWERSHELL=powershell.exe
elif [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  HIVEWARD_POWERSHELL=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
else
  echo "HiveWard WSL CLI requires Windows interop and could not find powershell.exe." >&2
  exit 1
fi`

export function buildWslLauncher(
  windowsLauncherPath: string,
  bridgePath = '${XDG_DATA_HOME:-$HOME/.local/share}/hiveward/hiveward-wsl-bridge.ps1'
): string {
  return buildLauncher(
    windowsLauncherPath,
    quotePosixShellDoubleQuotedApostrophe(bridgePath),
    FIND_INTEROP_POWERSHELL
  )
}

/** Launcher that finds its bridge beside itself and PowerShell by Windows path, independent of guest PATH. */
export function buildColocatedWslLauncher(
  windowsLauncherPath: string,
  windowsPowerShellPath: string
): string {
  return buildLauncher(
    windowsLauncherPath,
    '"$(dirname -- "$0")/hiveward-wsl-bridge.ps1"',
    `HIVEWARD_POWERSHELL=$(wslpath -u ${quotePosixShellDoubleQuotedApostrophe(windowsPowerShellPath)})
if [ ! -x "$HIVEWARD_POWERSHELL" ]; then
  echo "HiveWard WSL CLI requires Windows interop and access to $HIVEWARD_POWERSHELL." >&2
  exit 1
fi`
  )
}

function buildLauncher(
  windowsLauncherPath: string,
  bridgePathExpression: string,
  resolvePowerShell: string
): string {
  const encodedTarget = Buffer.from(windowsLauncherPath, 'utf8').toString('base64')
  return `#!/usr/bin/env bash
set -euo pipefail
${MANAGED_MARKER}
# HIVEWARD_WIN_LAUNCHER_B64=${encodedTarget}
HIVEWARD_WIN_LAUNCHER=${quotePosixShellDoubleQuotedApostrophe(windowsLauncherPath)}
HIVEWARD_BRIDGE_PS1=${bridgePathExpression}
${resolvePowerShell}
# Why: a shell can outlive a deleted worktree; keep explicit CLI selectors and
# help usable, and repair cwd before any WSL interop tool tries to resolve it.
HIVEWARD_WSL_CWD=$(pwd -P 2>/dev/null) || {
  HIVEWARD_WSL_CWD=/
  cd /
}
HIVEWARD_BRIDGE_PS1_WIN=$(wslpath -w "$HIVEWARD_BRIDGE_PS1")
HIVEWARD_WSL_CWD_WIN=$(wslpath -w "$HIVEWARD_WSL_CWD")
if [ -n "\${WSL_DISTRO_NAME:-}" ]; then
  set -- -WslDistro "$WSL_DISTRO_NAME" "$@"
fi
exec "$HIVEWARD_POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$HIVEWARD_BRIDGE_PS1_WIN" "$HIVEWARD_WIN_LAUNCHER" -WslCwd "$HIVEWARD_WSL_CWD_WIN" "$@"
`
}

/** `app` pins the bridge to one HiveWard instance; the guest-registered bridge omits it. */
export function buildWslBridgeScript(app?: {
  userDataPath: string
  cliEntryPath?: string
}): string {
  const setAppEnv = app
    ? [
        `$env:HIVEWARD_USER_DATA_PATH = ${quotePowerShellLiteral(app.userDataPath)}`,
        // Why: WSLENV /p maps this guest-only dir back; an app the CLI starts must not inherit it.
        'Remove-Item Env:HIVEWARD_WSL_CLI_DIR -ErrorAction SilentlyContinue',
        ...(app.cliEntryPath ? buildDevCliEnv(app.cliEntryPath) : [])
      ]
    : []
  // Why the BOM: PowerShell 5.1 reads BOM-less scripts as ANSI, garbling non-ASCII embedded paths.
  return `${app ? '\uFEFF' : ''}${BRIDGE_MANAGED_MARKER}
function ConvertTo-NativeCommandLineArgument {
  param([AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\\s"]') {
    return $Value
  }

  $Quoted = [System.Text.StringBuilder]::new()
  [void]$Quoted.Append([char]'"')
  [int]$BackslashCount = 0
  foreach ($Character in $Value.ToCharArray()) {
    if ($Character -eq [char]'\\') {
      $BackslashCount += 1
      continue
    }
    if ($Character -eq [char]'"') {
      [void]$Quoted.Append([char]'\\', $BackslashCount * 2 + 1)
      [void]$Quoted.Append([char]'"')
    } else {
      [void]$Quoted.Append([char]'\\', $BackslashCount)
      [void]$Quoted.Append($Character)
    }
    $BackslashCount = 0
  }
  [void]$Quoted.Append([char]'\\', $BackslashCount * 2)
  [void]$Quoted.Append([char]'"')
  return $Quoted.ToString()
}

$exitCode = 0
try {
  # Why: a param block prefix-binds forwarded flags such as --for in PowerShell 5.1.
  if ($args.Count -lt 1) {
    throw 'Invalid HiveWard WSL CLI bridge invocation.'
  }
  [string]$HiveWardLauncher = $args[0]
  [string]$WslCwd = ''
  [string]$WslDistro = ''
  [int]$ForwardArgStart = 1
  if ($args.Count -ge 2 -and $args[1] -eq '-WslCwd') {
    if ($args.Count -lt 3) {
      throw 'Invalid HiveWard WSL CLI bridge invocation.'
    }
    $WslCwd = $args[2]
    $ForwardArgStart = 3
  }
  if ($ForwardArgStart -eq 3 -and $args.Count -ge 4 -and $args[3] -eq '-WslDistro') {
    if ($args.Count -lt 5) {
      throw 'Invalid HiveWard WSL CLI bridge invocation.'
    }
    $WslDistro = $args[4]
    $ForwardArgStart = 5
  }
  [string[]]$ForwardArgs = @()
  if ($args.Count -gt $ForwardArgStart) {
    $ForwardArgs = @($args[$ForwardArgStart..($args.Count - 1)])
  }
  if ([string]::IsNullOrEmpty($WslCwd)) {
    Remove-Item Env:HIVEWARD_CLI_CWD -ErrorAction SilentlyContinue
  } else {
    $env:HIVEWARD_CLI_CWD = $WslCwd
  }
  # Do not let an inherited Windows environment choose the caller's account location.
  if ([string]::IsNullOrEmpty($WslDistro)) {
    Remove-Item Env:HIVEWARD_CLI_WSL_DISTRO -ErrorAction SilentlyContinue
  } else {
    $env:HIVEWARD_CLI_WSL_DISTRO = $WslDistro
  }
  $LauncherDirectory = Split-Path -Parent $HiveWardLauncher
  Push-Location -LiteralPath $LauncherDirectory
  # Why: Windows PowerShell 5.1 cannot losslessly splat strings to native argv.
  $StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $StartInfo.FileName = $HiveWardLauncher
${bridgeLines(setAppEnv)}  $StartInfo.Arguments = (($ForwardArgs | ForEach-Object {
    ConvertTo-NativeCommandLineArgument $_
  }) -join ' ')
  $StartInfo.UseShellExecute = $false
  # Why (#16463): Push-Location moves the PowerShell provider location, not the
  # Win32 current directory, and an empty WorkingDirectory with UseShellExecute
  # disabled means "inherit the caller's". Launched from a WSL shell that is the
  # user's worktree on the 9P share, so without this the app stands in a
  # directory Linux can delete -- after which every CreateProcessW it makes
  # fails ERROR_PATH_NOT_FOUND, reported as: spawn wsl.exe ENOENT.
  $StartInfo.WorkingDirectory = $LauncherDirectory
  $Process = [System.Diagnostics.Process]::Start($StartInfo)
  if ($null -eq $Process) {
    throw 'Unable to start the HiveWard Windows CLI launcher.'
  }
  $Process.WaitForExit()
  $exitCode = $Process.ExitCode
  $Process.Dispose()
} catch {
  Write-Error $_
  $exitCode = 1
}
exit $exitCode
`
}

/** Runs the dev CLI directly (its .cmd launcher adds a cmd.exe quoting boundary) with that launcher's env. */
function buildDevCliEnv(cliEntryPath: string): string[] {
  return [
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    "if (-not $env:HIVEWARD_APP_EXECUTABLE) { $env:HIVEWARD_APP_EXECUTABLE = $HiveWardLauncher; $env:HIVEWARD_APP_EXECUTABLE_NEEDS_APP_ROOT = '1' }",
    '$env:HIVEWARD_NODE_OPTIONS = $env:NODE_OPTIONS',
    '$env:HIVEWARD_NODE_REPL_EXTERNAL_MODULE = $env:NODE_REPL_EXTERNAL_MODULE',
    'Remove-Item Env:NODE_OPTIONS, Env:NODE_REPL_EXTERNAL_MODULE -ErrorAction SilentlyContinue',
    `$ForwardArgs = @(${quotePowerShellLiteral(cliEntryPath)}) + $ForwardArgs`
  ]
}

function bridgeLines(lines: readonly string[]): string {
  return lines.map((line) => `  ${line}\n`).join('')
}

export function getBridgePathFromCommandPath(commandPath: string): string {
  // Current and legacy command names share one bridge under ~/.local/share/hiveward.
  return `${commandPath.replace(/\/\.local\/bin\/(?:hiveward|hiveward)$/, '/.local/share/hiveward')}/hiveward-wsl-bridge.ps1`
}

export function buildSafeReplaceGuard(path: string, managedMarker: string): string {
  const quotedPath = quotePosixShellDoubleQuotedApostrophe(path)
  const quotedMarker = quotePosixShellDoubleQuotedApostrophe(managedMarker)
  return [
    `if [ -L ${quotedPath} ]; then`,
    '  echo "__HIVEWARD_CONFLICT__"',
    '  exit 23',
    `elif [ -e ${quotedPath} ] && { [ ! -f ${quotedPath} ] || ! grep -Fq ${quotedMarker} ${quotedPath}; }; then`,
    '  echo "__HIVEWARD_CONFLICT__"',
    '  exit 23',
    'fi'
  ].join('\n')
}

export function buildRegistrationLockPrelude(commandPath: string): string {
  const lockDir = getPosixDirname(getBridgePathFromCommandPath(commandPath))
  // flock serializes separate HiveWard installs; the per-distro queue covers only this process.
  return [
    `if command -v flock >/dev/null 2>&1 && mkdir -p ${quotePosixShellDoubleQuotedApostrophe(lockDir)} 2>/dev/null; then`,
    `  exec 9>${quotePosixShellDoubleQuotedApostrophe(`${lockDir}/.hiveward-wsl-cli.lock`)}`,
    '  flock -x -w 30 9',
    'fi'
  ].join('\n')
}

export function buildManagedLegacyRemoveCommand(quotedLegacyCommandPath: string): string {
  // Preserve user-owned commands and symlinks when removing the managed legacy wrapper.
  return `if [ ! -L ${quotedLegacyCommandPath} ] && [ -f ${quotedLegacyCommandPath} ] && grep -Fq ${quotePosixShellDoubleQuotedApostrophe(MANAGED_MARKER)} ${quotedLegacyCommandPath}; then rm -f ${quotedLegacyCommandPath}; fi`
}

export function buildSafeRemoveCommand(commandPath: string, legacyCommandPath?: string): string {
  const bridgePath = getBridgePathFromCommandPath(commandPath)
  return [
    // Runs under sh; Ubuntu 20.04 dash lacks pipefail, and no pipeline here needs it.
    'set -eu',
    buildRegistrationLockPrelude(commandPath),
    buildSafeReplaceGuard(commandPath, MANAGED_MARKER),
    buildSafeReplaceGuard(bridgePath, BRIDGE_MANAGED_MARKER),
    `rm -f ${quotePosixShellDoubleQuotedApostrophe(commandPath)} ${quotePosixShellDoubleQuotedApostrophe(bridgePath)}`,
    // A leftover managed legacy command would let startup reconciliation undo removal.
    ...(legacyCommandPath
      ? [buildManagedLegacyRemoveCommand(quotePosixShellDoubleQuotedApostrophe(legacyCommandPath))]
      : [])
  ].join('\n')
}

export function parseManagedLauncherTarget(content: string): string | null {
  const encoded = content.match(/^# HIVEWARD_WIN_LAUNCHER_B64=([A-Za-z0-9+/=]+)$/m)?.[1]
  if (encoded) {
    try {
      return Buffer.from(encoded, 'base64').toString('utf8')
    } catch {
      return null
    }
  }

  const legacyTarget = content.match(/^HIVEWARD_WIN_LAUNCHER='((?:[^']|'"'"')*)'$/m)?.[1]
  return legacyTarget ? legacyTarget.replaceAll(`'"'"'`, "'") : null
}

export function getPosixDirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

export function getWslLauncherMarker(): string {
  return MANAGED_MARKER
}

export function getWslBridgeMarker(): string {
  return BRIDGE_MANAGED_MARKER
}

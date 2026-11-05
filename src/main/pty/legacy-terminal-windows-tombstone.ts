// Emitted rem lines must contain no percent signs: cmd expands them, even in comments inside blocks.
// Keep templates ASCII-only: multibyte comments broke cmd's byte-position tracking on Windows 11.

const WIN32_PASSTHROUGH_WRAPPER = String.raw`@echo off
rem Why explicit: bare setlocal inherits the caller's delayed-expansion state, and a parent shell
rem started with /V:ON made every PATH entry undergo ! expansion inside the loops below. A literal
rem !CD! entry then became the current directory and a planted git.cmd ran (exit 66), and a
rem legitimate directory whose name contains ! stopped resolving (exit 127). Both proven on
rem Windows 11; both disappear when the wrapper pins its own state.
setlocal DisableDelayedExpansion
set "hiveward_real=%HIVEWARD_REAL___HIVEWARD_UPPER_COMMAND__%"
set "hiveward_wrapper_dir=%~dp0"
set "hiveward_legacy_wrapper_dir=%HIVEWARD_ATTRIBUTION_SHIM_DIR%"
set "hiveward_clean_path="
rem Why: holds a single separator so the trailing-separator tests below need neither a literal
rem backslash before a quote (which breaks cmd parsing) nor a sentinel character (which would
rem corrupt any path containing it). Comparisons append a dot so the separator is never
rem adjacent to a closing quote, which would break the parser exactly as a literal would.
set "hiveward_sep=\"
rem Why a subroutine, not an "if defined ... " one-liner: cmd expands a whole line before it
rem evaluates the condition, so the substring syntax below still runs against an unset variable
rem and leaves the line mangled. A CALL body is only parsed once it is reached.
rem Why here: the value cannot change mid-run, so normalize once rather than per PATH entry.
set "hiveward_legacy_norm="
if defined hiveward_legacy_wrapper_dir call :hiveward_normalize_legacy_dir
rem Why: an empty PATH leaves the substitution below with an unbalanced quote, which
rem desynchronizes cmd parsing for the rest of the file. Skip the line entirely instead.
if not defined PATH goto :hiveward_path_walked
rem Why the variable: CALL re-expands its own command line, so a PATH entry naming the current
rem directory through a percent expression would become that directory before the rooted check
rem below ever saw it, and the cwd would then be searched for __HIVEWARD_COMMAND__. Proven on
rem Windows 11. The expression is spelled out only in the TypeScript comment above: cmd expands
rem percent signs inside rem, so writing one here would substitute a path into the comment.
for %%P in ("%PATH:;=" "%") do (
  set "hiveward_entry=%%~P"
  call :hiveward_append_path
)
:hiveward_path_walked
set "PATH=%hiveward_clean_path%"
set "HIVEWARD_ENABLE_GIT_ATTRIBUTION="
set "HIVEWARD_GIT_COMMIT_TRAILER="
set "HIVEWARD_GH_PR_FOOTER="
set "HIVEWARD_GH_ISSUE_FOOTER="
set "HIVEWARD_ATTRIBUTION_SHIM_DIR="
set "HIVEWARD_ATTRIBUTION_BYPASS="
set "HIVEWARD_REAL_GIT="
set "HIVEWARD_REAL_GH="
if defined hiveward_real for %%G in ("%hiveward_real%") do if /I "%%~dpG"=="%~dp0" set "hiveward_real="
rem Why: a captured path may be relative, and both "if exist" and the invocation resolve it
rem against the current directory, so an inherited .\__HIVEWARD_COMMAND__.exe would run from the repo.
set "hiveward_probe=%hiveward_real%"
if defined hiveward_real call :hiveward_check_rooted
if defined hiveward_real if not defined hiveward_rooted set "hiveward_real="
rem Why: clear a captured path that no longer exists, or the PATH walk below is skipped.
if defined hiveward_real if not exist "%hiveward_real%" set "hiveward_real="
if defined hiveward_real goto run
rem Why: an unqualified Windows command lookup searches the current directory before PATH, so a
rem repository-local __HIVEWARD_COMMAND__.exe would win. Walk the cleaned PATH ourselves instead.
if not defined hiveward_clean_path goto :hiveward_candidates_walked
for %%P in ("%hiveward_clean_path:;=" "%") do (
  set "hiveward_entry=%%~P"
  call :hiveward_try_candidate
)
:hiveward_candidates_walked
if not defined hiveward_real (
  echo HiveWard compatibility wrapper could not locate __HIVEWARD_COMMAND__ on PATH. 1>&2
  exit /b 127
)
:run
"%hiveward_real%" %*
exit /b %ERRORLEVEL%

:hiveward_normalize_legacy_dir
rem Why the rooted test first: full-path expansion resolves a relative value against the current
rem directory, so a
rem relative HIVEWARD_ATTRIBUTION_SHIM_DIR would let the cwd decide which PATH entry counts as the
rem legacy directory and get a legitimate one skipped. Leaving the normalized value unset makes
rem the reject subroutine below a no-op, which is the safe outcome.
set "hiveward_probe=%hiveward_legacy_wrapper_dir%"
call :hiveward_check_rooted
if not defined hiveward_rooted exit /b
for %%G in ("%hiveward_legacy_wrapper_dir%") do set "hiveward_legacy_norm=%%~fG"
rem Why: full-path expansion preserves a trailing separator; normalize before comparing.
if "%hiveward_legacy_norm:~-1%."=="%hiveward_sep%." set "hiveward_legacy_norm=%hiveward_legacy_norm:~0,-1%"
exit /b

:hiveward_check_rooted
rem Why: tested in pure batch on purpose. An external tool invoked here would itself be resolved
rem from the current directory, reintroducing the very hijack this guard exists to prevent.
rem Why hiveward_probe rather than an argument: see the CALL re-expansion note above.
set "hiveward_rooted="
rem Why: an unset probe would leave the substring syntax below unexpanded and mangle the line.
if not defined hiveward_probe exit /b
if "%hiveward_probe:~0,2%"=="\\" set "hiveward_rooted=1"
if "%hiveward_probe:~1,2%"==":\" set "hiveward_rooted=1"
if "%hiveward_probe:~1,2%"==":/" set "hiveward_rooted=1"
exit /b

:hiveward_try_candidate
if defined hiveward_real exit /b
if not defined hiveward_entry exit /b
rem Why: a relative entry resolves against the current directory, same exposure as an empty one.
set "hiveward_probe=%hiveward_entry%"
call :hiveward_check_rooted
if not defined hiveward_rooted exit /b
for %%G in ("%hiveward_entry%") do set "hiveward_candidate_dir=%%~fG"
rem Why: full-path expansion preserves a trailing separator, so without normalizing, the
rem self-exclusion below misses a wrapper-dir entry spelled with one and the wrapper resolves
rem to itself, looping forever.
if "%hiveward_candidate_dir:~-1%."=="%hiveward_sep%." set "hiveward_candidate_dir=%hiveward_candidate_dir:~0,-1%"
rem Why: the script-dir operator is rebound to this label inside CALL, so compare against the
rem cached wrapper dir captured at top level.
if /I "%hiveward_candidate_dir%\"=="%hiveward_wrapper_dir%" exit /b
if exist "%hiveward_candidate_dir%\__HIVEWARD_COMMAND__.exe" set "hiveward_real=%hiveward_candidate_dir%\__HIVEWARD_COMMAND__.exe"
if not defined hiveward_real if exist "%hiveward_candidate_dir%\__HIVEWARD_COMMAND__.cmd" set "hiveward_real=%hiveward_candidate_dir%\__HIVEWARD_COMMAND__.cmd"
if not defined hiveward_real if exist "%hiveward_candidate_dir%\__HIVEWARD_COMMAND__.bat" set "hiveward_real=%hiveward_candidate_dir%\__HIVEWARD_COMMAND__.bat"
exit /b

:hiveward_append_path
if not defined hiveward_entry exit /b
rem Why: the exported PATH is inherited by the real git and anything it spawns, so a relative
rem entry left here lets the current directory select those tools instead.
set "hiveward_probe=%hiveward_entry%"
call :hiveward_check_rooted
if not defined hiveward_rooted exit /b
for %%G in ("%hiveward_entry%") do set "hiveward_path_entry_dir=%%~fG"
rem Why: full-path expansion preserves a trailing separator; normalize before comparing.
if "%hiveward_path_entry_dir:~-1%."=="%hiveward_sep%." set "hiveward_path_entry_dir=%hiveward_path_entry_dir:~0,-1%"
set "hiveward_path_entry_dir=%hiveward_path_entry_dir%\"
if /I "%hiveward_path_entry_dir%"=="%hiveward_wrapper_dir%" exit /b
set "hiveward_skip_entry="
if defined hiveward_legacy_wrapper_dir call :hiveward_reject_legacy_dir
if defined hiveward_skip_entry exit /b
if defined hiveward_clean_path (set "hiveward_clean_path=%hiveward_clean_path%;%hiveward_entry%") else set "hiveward_clean_path=%hiveward_entry%"
exit /b

:hiveward_reject_legacy_dir
rem Why: an unrooted legacy dir leaves this unset, and comparing against a bare separator could
rem only ever misfire.
if not defined hiveward_legacy_norm exit /b
if /I "%hiveward_path_entry_dir%"=="%hiveward_legacy_norm%\" set "hiveward_skip_entry=1"
exit /b
`

const POWERSHELL_PASSTHROUGH_WRAPPER = String.raw`$ErrorActionPreference = 'Stop'
$commandName = '__HIVEWARD_COMMAND__'
$realCommand = [Environment]::GetEnvironmentVariable('HIVEWARD_REAL___HIVEWARD_UPPER_COMMAND__')
$wrapperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$legacyWrapperDir = $env:HIVEWARD_ATTRIBUTION_SHIM_DIR
# Why both separators: the rooted-path test below accepts forward slashes, so a directory
# spelled with a trailing / would miss this lexical exclusion and the wrapper could recurse.
$wrapperDirs = @($wrapperDir, $legacyWrapperDir) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\', '/') }
$env:PATH = (($env:PATH -split ';') | Where-Object {
  $pathEntry = $_
  # Why: the exported PATH is inherited by the real command and anything it spawns.
  $pathEntry -and ($pathEntry -match '^([A-Za-z]:[\\/]|\\\\)') -and -not ($wrapperDirs | Where-Object {
    [string]::Equals($_, $pathEntry.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)
  })
}) -join ';'
'HIVEWARD_ENABLE_GIT_ATTRIBUTION', 'HIVEWARD_GIT_COMMIT_TRAILER', 'HIVEWARD_GH_PR_FOOTER', 'HIVEWARD_GH_ISSUE_FOOTER', 'HIVEWARD_ATTRIBUTION_SHIM_DIR', 'HIVEWARD_REAL_GIT', 'HIVEWARD_REAL_GH', 'HIVEWARD_ATTRIBUTION_BYPASS' | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
# Why: a captured value may be relative, and Test-Path plus invocation resolve it against the cwd.
if ($realCommand -and $realCommand -notmatch '^([A-Za-z]:[\\/]|\\\\)') { $realCommand = $null }
if ($realCommand) {
  try {
    $capturedDir = Split-Path -Parent ([IO.Path]::GetFullPath($realCommand))
    if ([string]::Equals($capturedDir.TrimEnd('\', '/'), $wrapperDir.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
      $realCommand = $null
    }
  } catch {
    $realCommand = $null
  }
}
if (-not $realCommand -or -not (Test-Path -LiteralPath $realCommand)) {
  # Why: resolve only against the cleaned PATH directories. Ambient lookup could pick up a
  # repository-local git.exe/gh.exe from the current directory.
  $realCommand = $null
  foreach ($dir in ($env:PATH -split ';')) {
    if (-not $dir) { continue }
    # Why: a relative entry resolves against the current directory, same exposure as an empty one.
    # IsPathRooted is not enough: it accepts drive-relative 'C:foo', which resolves against the
    # current directory on that drive. IsPathFullyQualified is absent on Windows PowerShell 5.1,
    # so match the same prefixes the cmd wrapper accepts.
    if ($dir -notmatch '^([A-Za-z]:[\\/]|\\\\)') { continue }
    if ($wrapperDirs | Where-Object { [string]::Equals($_, $dir.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase) }) { continue }
    foreach ($ext in @('.exe', '.cmd', '.bat')) {
      $candidate = Join-Path $dir "$commandName$ext"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $realCommand = $candidate; break }
    }
    if ($realCommand) { break }
  }
}
if (-not $realCommand) {
  [Console]::Error.WriteLine("HiveWard compatibility wrapper could not locate $commandName on PATH.")
  exit 127
}
& $realCommand @args
exit $LASTEXITCODE
`

function renderWindowsWrapper(template: string, command: string, upperCommand: string): string {
  return template
    .replaceAll('__HIVEWARD_UPPER_COMMAND__', upperCommand)
    .replaceAll('__HIVEWARD_COMMAND__', command)
}

// cmd label seeks failed in longer LF-only wrappers; emit CRLF.
function toCrlf(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')
}

export function renderLegacyTerminalWindowsCmdTombstone(command: 'git' | 'gh'): string {
  return toCrlf(renderWindowsWrapper(WIN32_PASSTHROUGH_WRAPPER, command, command.toUpperCase()))
}

export function renderLegacyTerminalWindowsPowerShellTombstone(command: 'git' | 'gh'): string {
  return toCrlf(
    renderWindowsWrapper(POWERSHELL_PASSTHROUGH_WRAPPER, command, command.toUpperCase())
  )
}

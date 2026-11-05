// Typed OMP needs HiveWard's status extension explicitly; preserve PI_CODING_AGENT_DIR as the user's mutable auth/config/session home.

const OMP_SUBCOMMANDS = [
  '__complete',
  'acp',
  'agents',
  'auth-broker',
  'auth-gateway',
  'bench',
  'commit',
  'completions',
  'config',
  'dry-balance',
  'gallery',
  'grep',
  'grievances',
  'install',
  'join',
  'models',
  'plugin',
  'read',
  'say',
  'search',
  'setup',
  'shell',
  'ssh',
  'stats',
  'tiny-models',
  'token',
  'ttsr',
  'update',
  'usage',
  'worktree',
  'q',
  'wt'
] as const

export function getPosixOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.map((value) => `'${value}'`).join('|')
  return `# Why: OMP does not auto-load HiveWard's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
__hiveward_omp_should_skip_extension() {
  case "\${1:-}" in
    'help'|'--help'|'-h'|'--version'|'-v') return 0 ;;
    ${subcommands}) return 0 ;;
  esac
  return 1
}
__hiveward_omp_cwd_is_usable() {
  local __hiveward_physical_cwd
  [[ -x . ]] || return 1
  if [[ -n "\${PWD:-}" && -d "\${PWD:-}" ]]; then
    [[ "\${PWD}" -ef . ]]
  else
    # Why compare the path: shell builtins can print a cached path for a deleted cwd.
    __hiveward_physical_cwd="$(builtin pwd -P 2>/dev/null)" || return 1
    [[ -d "$__hiveward_physical_cwd" && "$__hiveward_physical_cwd" -ef . ]]
  fi
}
__hiveward_omp_invoke() {
  local __hiveward_use_extension="$1"
  shift
  if [[ $__hiveward_use_extension -eq 1 && -n "\${HIVEWARD_OMP_STATUS_EXTENSION:-}" && -f "\${HIVEWARD_OMP_STATUS_EXTENSION}" ]]; then
    if [[ "\${1:-}" == "launch" ]]; then
      shift
      command omp launch --extension "\${HIVEWARD_OMP_STATUS_EXTENSION}" "$@"
    else
      command omp --extension "\${HIVEWARD_OMP_STATUS_EXTENSION}" "$@"
    fi
  else
    command omp "$@"
  fi
}
__hiveward_omp() {
  local __hiveward_use_extension=1
  __hiveward_omp_should_skip_extension "\${1:-}" && __hiveward_use_extension=0
  if ! __hiveward_omp_cwd_is_usable; then
    local __hiveward_logical_cwd="\${PWD:-\${HIVEWARD_WORKTREE_PATH:-\${HIVEWARD_ROOT_PATH:-}}}"
    # Why: a restored shell can retain the deleted directory inode after its path is recreated.
    (
      if [[ -z "$__hiveward_logical_cwd" ]]; then
        printf 'HiveWard: OMP cannot start because no terminal working directory is available. Open a new terminal in an existing directory.\\n' >&2
        return 1
      fi
      if ! builtin cd -P -- "$__hiveward_logical_cwd" 2>/dev/null; then
        printf 'HiveWard: OMP cannot access the terminal working directory "%s". Open a new terminal in an existing directory.\\n' "$__hiveward_logical_cwd" >&2
        return 1
      fi
      __hiveward_omp_invoke "$__hiveward_use_extension" "$@"
    )
  else
    __hiveward_omp_invoke "$__hiveward_use_extension" "$@"
  fi
}
if [[ -n "\${HIVEWARD_OMP_STATUS_EXTENSION:-}" ]]; then
  # Why the function reserved word: it suppresses alias expansion of the name, which
  # an \`alias omp\` otherwise rewrites at parse time, aborting the rest of the file.
  function omp { __hiveward_omp "$@"; }
fi
`
}

export function getPowerShellOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.map((value) => `'${value}'`).join(', ')
  return `# Why: OMP does not auto-load HiveWard's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
function Global:__HiveWardOmpShouldSkipExtension {
    param([string]$Name)
    $skip = @("help", "--help", "-h", "--version", "-v") + @(${subcommands})
    return $skip -contains $Name
}
if ($env:HIVEWARD_OMP_STATUS_EXTENSION) {
    function Global:omp {
        $hivewardUseExtension = -not (__HiveWardOmpShouldSkipExtension -Name ([string]($args[0])))
        $hivewardStatus = 0
        $hivewardCommand = Get-Command omp -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $hivewardCommand) {
            Write-Error "omp executable not found"
            $hivewardStatus = 127
        } elseif ($hivewardUseExtension -and $env:HIVEWARD_OMP_STATUS_EXTENSION -and
            (Test-Path -LiteralPath $env:HIVEWARD_OMP_STATUS_EXTENSION)) {
            if ($args.Count -gt 0 -and $args[0] -eq "launch") {
                $hivewardLaunchArgs = @($args | Select-Object -Skip 1)
                & $hivewardCommand.Source launch --extension $env:HIVEWARD_OMP_STATUS_EXTENSION @hivewardLaunchArgs
            } else {
                & $hivewardCommand.Source --extension $env:HIVEWARD_OMP_STATUS_EXTENSION @args
            }
            $hivewardStatus = $LASTEXITCODE
        } else {
            & $hivewardCommand.Source @args
            $hivewardStatus = $LASTEXITCODE
        }

        $global:LASTEXITCODE = $hivewardStatus
    }
}
`
}

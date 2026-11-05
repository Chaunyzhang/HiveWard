import { HIVEWARD_CLI_POSIX_PATH_RESTORE } from '../shared/hiveward-cli-shell-path'
import { MANAGED_DATA_ACCOUNT_POSIX_RESTORE } from '../shared/managed-data-account-shell'
/** Restore ZDOTDIR before user startup; define functions first so .zshenv emulation cannot change their parsing. */
import { getPosixOmpShellWrapper } from './pty/omp-shell-wrapper'
import { WSL_MANAGED_CLI_PATH_RESTORE } from './wsl-managed-cli-path-restore'
import { getPosixCodexShellLaunchPreflight } from '../shared/codex-shell-function'
import { getPosixClaudeShellFunction } from '../shared/claude-shell-function'
import {
  ZSH_DEFERRED_LINE_INIT_BLOCK,
  ZSH_DEFERRED_LINE_INIT_CLEANUP_BLOCK,
  ZSH_DEFERRED_LINE_INIT_RETIRE_BLOCK
} from './zsh-deferred-startup-line-init'
import {
  getZshShellReadyMarkerRegistrationBlock,
  SHELL_STARTUP_IDENTITY_MARKER_BLOCK,
  ZSH_FEATURE_CHANNEL_BLOCK,
  ZSH_USER_ZSHENV_SOURCE_BLOCK,
  ZSH_ZDOTDIR_HANDBACK_BLOCK
} from './shell-templates'
import { ZSH_WSL_CWD_REPORT_BLOCK } from './wsl-shell-cwd-report'

export type ZshWrapperRestoreSpec = {
  /** Local-only PATH restore; inert outside WSL. */
  managedWslCli: boolean
  agentTeamsPath: boolean
  /** Relay-only CLI PATH restore. */
  remoteCliBinDir: boolean
  codexHome: boolean
}

export type ZshStartupHookSpec = {
  /** First generated line; omit the # prefix. */
  headerLabel: string
  readyMarkerEscaped: string
  /** OSC 133 command-lifecycle hooks (behind the `markers` feature). */
  osc133CommandMarkers: boolean
  /** Local-only command delivery from the first zle line editor. */
  startupCommandDelivery: boolean
  /** WSL bridge panes report their folder (OSC 7) at each prompt. */
  wslCwdReports?: boolean
  overlayRestoreComment: string
  restores: ZshWrapperRestoreSpec
}

const AGENT_TEAMS_PATH_RESTORE_BLOCK = `__hiveward_restore_agent_teams_path() {
  [[ -n "\${HIVEWARD_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${HIVEWARD_AGENT_TEAMS_SHIM_DIR}"|"\${HIVEWARD_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${HIVEWARD_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
__hiveward_restore_agent_teams_path`

const OPENCODE_CONFIG_DIR_RESTORE = `[[ -n "\${HIVEWARD_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${HIVEWARD_OPENCODE_CONFIG_DIR}"`
const MIMOCODE_CONFIG_DIR_RESTORE = `[[ -n "\${HIVEWARD_MIMOCODE_CONFIG_DIR:-}" ]] && export MIMOCODE_CONFIG_DIR="\${HIVEWARD_MIMOCODE_CONFIG_DIR}"`
const REMOTE_CLI_BIN_DIR_RESTORE = `[[ -n "\${HIVEWARD_REMOTE_CLI_BIN_DIR:-}" ]] && case ":$PATH:" in *:"\${HIVEWARD_REMOTE_CLI_BIN_DIR}":*) ;; *) export PATH="\${HIVEWARD_REMOTE_CLI_BIN_DIR}:$PATH" ;; esac`
const CODEX_HOME_RESTORE = `# Restore the runtime CODEX_HOME after user rc files.
[[ -n "\${HIVEWARD_CODEX_HOME:-}" ]] && export CODEX_HOME="\${HIVEWARD_CODEX_HOME}"`

const ZSH_OSC133_FUNCTION_BLOCK = `__hiveward_osc133_precmd() {
  local exit_code=$?
  if [[ -n "\${__hiveward_in_command:-}" ]]; then
    builtin printf "\\033]133;D;%s\\007" "$exit_code"
    builtin unset __hiveward_in_command
  fi
  builtin printf "\\033]133;A\\007"
}
__hiveward_osc133_preexec() {
  builtin printf "\\033]133;C\\007"
  # Declare explicitly to avoid warn_create_global output above every command.
  builtin typeset -g __hiveward_in_command=1
}`

function joinBlocks(blocks: (string | null)[]): string {
  return blocks.filter((block): block is string => block !== null).join('\n')
}

function indentBlock(block: string, indent: string): string {
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join('\n')
}

function featureGuard(name: string, body: (string | null)[]): string | null {
  const blocks = body.filter((block): block is string => block !== null)
  if (blocks.length === 0) {
    return null
  }
  return `  if __hiveward_has_feature ${name}; then\n${indentBlock(joinBlocks(blocks).replace(/\n$/, ''), '    ')}\n  fi`
}

function getOverlayRestoreBlocks(spec: ZshStartupHookSpec): (string | null)[] {
  return [
    spec.overlayRestoreComment,
    spec.restores.agentTeamsPath ? AGENT_TEAMS_PATH_RESTORE_BLOCK : null,
    OPENCODE_CONFIG_DIR_RESTORE,
    MANAGED_DATA_ACCOUNT_POSIX_RESTORE,
    MIMOCODE_CONFIG_DIR_RESTORE,
    spec.restores.remoteCliBinDir ? REMOTE_CLI_BIN_DIR_RESTORE : null,
    getPosixOmpShellWrapper(),
    spec.restores.codexHome ? CODEX_HOME_RESTORE : null
  ]
}

function buildDeferredInit(spec: ZshStartupHookSpec): string {
  // Keep the existing hook position for OSC 133; otherwise remove the one-shot hook without leaving a name behind.
  const permanentPrecmd = spec.osc133CommandMarkers
    ? `  if __hiveward_has_feature markers; then
    precmd_functions=(\${precmd_functions:/__hiveward_deferred_init/__hiveward_osc133_precmd})
    (( \${precmd_functions[(Ie)__hiveward_osc133_precmd]} )) || precmd_functions+=(__hiveward_osc133_precmd)
    preexec_functions=(__hiveward_osc133_preexec \${preexec_functions[@]})
  else
    precmd_functions=(\${precmd_functions:#__hiveward_deferred_init})
  fi`
    : `  precmd_functions=(\${precmd_functions:#__hiveward_deferred_init})`
  const lineInitRegistration = spec.startupCommandDelivery
    ? `  if __hiveward_has_feature ready || __hiveward_has_feature startup; then
    __hiveward_emit_ready_marker=""
    __hiveward_has_feature ready && __hiveward_emit_ready_marker=1
${indentBlock(getZshShellReadyMarkerRegistrationBlock(spec.readyMarkerEscaped, true), '    ')}
  fi`
    : featureGuard('ready', [
        indentBlock(getZshShellReadyMarkerRegistrationBlock(spec.readyMarkerEscaped), '')
      ])

  return `__hiveward_deferred_init() {
  # Reset user options: NO_UNSET can abort hooks and KSH_ARRAYS breaks the feature lookup.
  builtin emulate -L zsh
  # Startup files can invoke prompt hooks or nested editors before initialization ends.
  [[ ":$ZSH_EVAL_CONTEXT:" == *:file:* ]] && return 0
  (( $+_hiveward_deferred_init_done )) && return 0
  builtin typeset -g _hiveward_deferred_init_done=1
  builtin typeset -g precmd_functions
${ZSH_DEFERRED_LINE_INIT_RETIRE_BLOCK}
${permanentPrecmd}${
    spec.wslCwdReports
      ? `
  if [[ -n \${WSL_DISTRO_NAME:-} ]]; then
    (( \${precmd_functions[(Ie)__hiveward_wsl_cwd_report]} )) || precmd_functions+=(__hiveward_wsl_cwd_report)
    __hiveward_wsl_cwd_report
  fi`
      : ''
  }
${joinBlocks([
  spec.restores.managedWslCli ? indentBlock(WSL_MANAGED_CLI_PATH_RESTORE, '  ') : null,
  indentBlock(HIVEWARD_CLI_POSIX_PATH_RESTORE, '  ').replace(/\n$/, ''),
  featureGuard('overlay', getOverlayRestoreBlocks(spec)),
  // A system-default Codex home has no overlay key, but still needs the launch preflight.
  indentBlock(getPosixCodexShellLaunchPreflight() + getPosixClaudeShellFunction(), '  ').replace(
    /\n$/,
    ''
  ),
  `  if [[ -n "\${_hiveward_histfile:-}" ]]; then
    HISTFILE="$_hiveward_histfile"
  fi`,
  lineInitRegistration
])}
${
  spec.osc133CommandMarkers
    ? `  # The permanent hook was added during this sweep; run it now so the first prompt gets its mark.
  __hiveward_has_feature markers && __hiveward_osc133_precmd\n`
    : ''
}  builtin unset _hiveward_shell_features _hiveward_histfile
${ZSH_DEFERRED_LINE_INIT_CLEANUP_BLOCK}
  builtin unfunction __hiveward_deferred_init __hiveward_has_feature __hiveward_arm_deferred_line_init
}`
}

export function buildZshStartupHook(spec: ZshStartupHookSpec): string {
  return `${joinBlocks([
    `# ${spec.headerLabel}`,
    ZSH_ZDOTDIR_HANDBACK_BLOCK,
    ZSH_FEATURE_CHANNEL_BLOCK,
    SHELL_STARTUP_IDENTITY_MARKER_BLOCK,
    spec.osc133CommandMarkers ? ZSH_OSC133_FUNCTION_BLOCK : null,
    spec.wslCwdReports ? ZSH_WSL_CWD_REPORT_BLOCK : null,
    ZSH_DEFERRED_LINE_INIT_BLOCK,
    buildDeferredInit(spec),
    ZSH_USER_ZSHENV_SOURCE_BLOCK
  ])}\n`
}

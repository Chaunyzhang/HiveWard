import { getPosixOmpShellWrapper } from '../pty/omp-shell-wrapper'
import { HIVEWARD_CLI_POSIX_PATH_RESTORE } from '../../shared/hiveward-cli-shell-path'
import { MANAGED_DATA_ACCOUNT_POSIX_RESTORE } from '../../shared/managed-data-account-shell'
import { getPosixCodexShellLaunchPreflight } from '../../shared/codex-shell-function'
import { getPosixClaudeShellFunction } from '../../shared/claude-shell-function'
import { BASH_PROMPT_COMMAND_COMPOSITION_BLOCK } from '../bash-prompt-command-composition'
import { BASH_FEATURE_CHANNEL_BLOCK, SHELL_STARTUP_IDENTITY_MARKER_BLOCK } from '../shell-templates'

export function getDaemonBashShellReadyRcfileContent(): string {
  return `# HiveWard daemon bash shell-ready wrapper
${BASH_FEATURE_CHANNEL_BLOCK}
${SHELL_STARTUP_IDENTITY_MARKER_BLOCK}
# Consume the feature channel before profiles so child processes cannot inherit the selection.
__hiveward_ready_marker=""
__hiveward_has_feature ready && __hiveward_ready_marker=1
unset _hiveward_shell_features
unset -f __hiveward_has_feature
# A system bashrc may already run ble.sh; it never exports this state, so exported copies are inherited.
for __hiveward_ble_var in _ble_attached _ble_decode_bind_state; do
  [[ -n "\${!__hiveward_ble_var+set}" ]] || continue
  case "$(declare -p "$__hiveward_ble_var" 2>/dev/null)" in "declare -x"*) unset "$__hiveward_ble_var" ;; esac
done
unset __hiveward_ble_var
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Force bracketed paste on older readline so multiline startup prompts remain one literal paste.
[[ $- == *i* ]] && bind 'set enable-bracketed-paste on' 2>/dev/null
__hiveward_restore_agent_teams_path() {
  [[ -n "\${HIVEWARD_AGENT_TEAMS_SHIM_DIR:-}" ]] || return 0
  case "$PATH" in
    "\${HIVEWARD_AGENT_TEAMS_SHIM_DIR}"|"\${HIVEWARD_AGENT_TEAMS_SHIM_DIR}:"*) return 0 ;;
  esac
  export PATH="\${HIVEWARD_AGENT_TEAMS_SHIM_DIR}:$PATH"
}
__hiveward_restore_agent_teams_path
${HIVEWARD_CLI_POSIX_PATH_RESTORE}
# Restore the managed OpenCode config after user profiles may have replaced it.
[[ -n "\${HIVEWARD_OPENCODE_CONFIG_DIR:-}" ]] && export OPENCODE_CONFIG_DIR="\${HIVEWARD_OPENCODE_CONFIG_DIR}"
${MANAGED_DATA_ACCOUNT_POSIX_RESTORE}
[[ -n "\${HIVEWARD_MIMOCODE_CONFIG_DIR:-}" ]] && export MIMOCODE_CONFIG_DIR="\${HIVEWARD_MIMOCODE_CONFIG_DIR}"
${getPosixOmpShellWrapper()}
# Preserve the managed CODEX_HOME after user profiles.
[[ -n "\${HIVEWARD_CODEX_HOME:-}" ]] && export CODEX_HOME="\${HIVEWARD_CODEX_HOME}"
${getPosixCodexShellLaunchPreflight() + getPosixClaudeShellFunction()}
# OSC 133 C/D clears stale agent status when a CLI exits without a stop hook.
__hiveward_initializing_wrapper=1
__hiveward_osc133_precmd() {
  local exit_code=$?
  __hiveward_in_prompt_command=1
  if [[ -n "\${__hiveward_in_command:-}" ]]; then
    printf "\\033]133;D;%s\\007" "$exit_code"
    unset __hiveward_in_command
  fi
  printf "\\033]133;A\\007"
  return "$exit_code"
}
__hiveward_osc133_preexec() {
  if [[ -n "\${__hiveward_prompt_status_capture_command:-}" && "$BASH_COMMAND" == "$__hiveward_prompt_status_capture_command" ]]; then
    unset __hiveward_initial_prompt
    __hiveward_in_legacy_prompt_wrapper=1
    return 0
  fi
  if [[ -n "\${__hiveward_initializing_wrapper:-}\${__hiveward_in_debug_capture:-}\${__hiveward_initial_prompt:-}\${__hiveward_in_prompt_dispatch:-}\${__hiveward_in_legacy_prompt_wrapper:-}\${__hiveward_in_prompt_command:-}" ]]; then
    [[ -z "\${__hiveward_initializing_wrapper:-}\${__hiveward_in_debug_capture:-}" ]] || return 0
    if [[ -n "\${__hiveward_initial_prompt:-}" && "$BASH_COMMAND" == "__hiveward_osc133_precmd" ]]; then
      unset __hiveward_initial_prompt; return 0
    fi
    if [[ -n "\${__hiveward_in_prompt_dispatch:-}" ]]; then
      [[ -n "\${__hiveward_dispatching_user_prompt_command:-}" ]] || return 0
      if [[ "\${FUNCNAME[1]:-}" == "__hiveward_run_prompt_command_array" ]]; then
        case "$BASH_COMMAND" in
          '(( __hiveward_exit_code == 0 ))'|'__hiveward_restore_prompt_status "$__hiveward_exit_code"'|'eval "$__hiveward_prompt_part"'|'eval "$__hiveward_final_prompt_command"'|__hiveward_dispatching_user_prompt_command=*|__hiveward_osc133_precmd|__hiveward_osc133_epilogue) return 0 ;;
        esac
      fi
    elif [[ "\${FUNCNAME[1]:-}" == "__hiveward_run_prompt_command_array" || "$BASH_COMMAND" == "__hiveward_run_prompt_command_array" ]]; then
      return 0
    fi
    [[ -z "\${__hiveward_in_legacy_prompt_wrapper:-}" || -n "\${__hiveward_dispatching_user_prompt_command:-}" ]] || return 0
    if [[ -n "\${__hiveward_in_prompt_command:-}" && "$BASH_COMMAND" == "__hiveward_in_debug_capture=1" ]]; then
      return 0
    fi
  fi
  case "\${FUNCNAME[1]:-}" in
    __hiveward_osc133_*|__hiveward_restore_prompt_status|__bp_*) return 0 ;;
  esac
  case "$BASH_COMMAND" in
    __hiveward_osc133_precmd|__hiveward_osc133_epilogue) return 0 ;;
    # The prefix is only special while bash-preexec prompt hooks run.
    __bp_*) [[ -n "\${__hiveward_in_prompt_command:-}" ]] && return 0 ;;
  esac
  __hiveward_run_user_debug_trap
  # Chain the framework trap captured before each prompt's lifecycle re-arm.
  if [[ -n "\${__hiveward_chained_debug_trap:-}" ]]; then
    eval "$__hiveward_chained_debug_trap" || true
  fi
  [[ -z "\${__hiveward_in_prompt_command:-}" ]] || return 0
  # Emit C once per foreground command, excluding prompt hooks and repeated chained-trap calls.
  [[ -z "\${__hiveward_in_command:-}" ]] || return 0
  printf "\\033]133;C\\007"
  __hiveward_in_command=1
}
# Adopt the latest user trap before reclaiming lifecycle ownership.
__hiveward_osc133_epilogue() {
  unset __hiveward_in_prompt_command
  __hiveward_adopt_outer_debug_trap
  trap '__hiveward_osc133_preexec' DEBUG
  # Readline renders PS1 after entering raw mode; prompt hooks still run in cooked mode.
  if [[ -n "$__hiveward_ready_marker" ]]; then
    # Attached ble.sh (0.3+) discards Bash's own prompt output and owns the TTY, so print directly.
    if [[ -n "\${_ble_attached-}" ]]; then
      # Its first render runs this before the key decoder attaches; wait for a later prompt.
      if [[ "\${_ble_decode_bind_state:-none}" != none ]]; then
        printf "\\033]777;hiveward-shell-ready\\007"
        __hiveward_ready_marker=""
      fi
    else
      PS1="\${PS1-}"'\\[\\e]777;hiveward-shell-ready\\a\\]'
      __hiveward_ready_marker=""
    fi
  fi
}
${BASH_PROMPT_COMMAND_COMPOSITION_BLOCK}
__hiveward_prepend_prompt_command "__hiveward_osc133_precmd"
__hiveward_append_prompt_command '__hiveward_in_debug_capture=1; __hiveward_prompt_had_functrace=""; if [[ -o functrace ]]; then __hiveward_prompt_had_functrace=1; set +T; fi; __hiveward_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__hiveward_prompt_had_functrace" ]] || set -T; unset __hiveward_prompt_had_functrace __hiveward_in_debug_capture'
__hiveward_append_prompt_command "__hiveward_osc133_epilogue"
__hiveward_had_functrace=""
[[ -o functrace ]] && __hiveward_had_functrace=1
set +T
__hiveward_debug_trap_spec="$(trap -p DEBUG)"
[[ -z "$__hiveward_had_functrace" ]] || set -T
if [[ -n "$__hiveward_debug_trap_spec" && "$__hiveward_debug_trap_spec" != "trap -- '__hiveward_osc133_preexec' DEBUG" ]]; then
  __hiveward_debug_trap_command="\${__hiveward_debug_trap_spec#trap -- }"
  __hiveward_debug_trap_command="\${__hiveward_debug_trap_command% DEBUG}"
  eval "__hiveward_user_debug_trap=$__hiveward_debug_trap_command"
fi
unset __hiveward_debug_trap_spec __hiveward_debug_trap_command __hiveward_had_functrace
unset -f __hiveward_normalize_prompt_command_part __hiveward_normalize_prompt_command __hiveward_prepend_prompt_command __hiveward_append_prompt_command
unset __hiveward_prompt_command_normalized
# Arm DEBUG after setup so rcfile commands cannot emit a fake lifecycle before the first prompt.
__hiveward_initial_prompt=1
trap '__hiveward_osc133_preexec' DEBUG
unset __hiveward_initializing_wrapper
`
}

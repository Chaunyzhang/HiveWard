export const BASH_PROMPT_COMMAND_COMPOSITION_BLOCK = `__hiveward_normalize_prompt_command_part() {
  local __hiveward_value="$1" __hiveward_output_name="$2" __hiveward_character __hiveward_chunk
  local __hiveward_value_length=\${#1} __hiveward_suffix_length=0 __hiveward_backslash_length=0
  local __hiveward_output_length __hiveward_scan_start
  while (( __hiveward_value_length - __hiveward_suffix_length >= 1024 )); do
    __hiveward_scan_start=$(( __hiveward_value_length - __hiveward_suffix_length - 1024 ))
    __hiveward_chunk="\${__hiveward_value:__hiveward_scan_start:1024}"
    case "$__hiveward_chunk" in
      *[!$' \\t\\n;']*) break ;;
      *) __hiveward_suffix_length=$(( __hiveward_suffix_length + 1024 )) ;;
    esac
  done
  while (( __hiveward_suffix_length < __hiveward_value_length )); do
    __hiveward_character="\${__hiveward_value: -__hiveward_suffix_length - 1:1}"
    case "$__hiveward_character" in
      ' '|$'\\t'|$'\\n'|';') __hiveward_suffix_length=$(( __hiveward_suffix_length + 1 )) ;;
      *) break ;;
    esac
  done
  __hiveward_output_length=$(( \${#__hiveward_value} - __hiveward_suffix_length ))
  while (( __hiveward_output_length - __hiveward_backslash_length >= 1024 )); do
    __hiveward_scan_start=$(( __hiveward_output_length - __hiveward_backslash_length - 1024 ))
    __hiveward_chunk="\${__hiveward_value:__hiveward_scan_start:1024}"
    case "$__hiveward_chunk" in
      *[!\\\\]*) break ;;
      *) __hiveward_backslash_length=$(( __hiveward_backslash_length + 1024 )) ;;
    esac
  done
  while (( __hiveward_backslash_length < __hiveward_output_length )); do
    __hiveward_character="\${__hiveward_value:__hiveward_output_length - __hiveward_backslash_length - 1:1}"
    [[ "$__hiveward_character" == '\\' ]] || break
    __hiveward_backslash_length=$(( __hiveward_backslash_length + 1 ))
  done
  # Preserve the first separator when an odd backslash run escapes it.
  if (( __hiveward_suffix_length > 0 && __hiveward_backslash_length % 2 == 1 )); then
    __hiveward_suffix_length=$(( __hiveward_suffix_length - 1 ))
    __hiveward_backslash_length=0
  fi
  __hiveward_output_length=$(( \${#__hiveward_value} - __hiveward_suffix_length ))
  __hiveward_value="\${__hiveward_value:0:__hiveward_output_length}"
  # Bash 4.4-5.0 scalar prompt evaluation preserves an odd terminal backslash.
  if (( __hiveward_suffix_length == 0 && ((BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] == 0)) && __hiveward_backslash_length % 2 == 1 )); then
    __hiveward_value="$__hiveward_value\\\\"
  fi
  printf -v "$__hiveward_output_name" '%s' "$__hiveward_value"
}
__hiveward_restore_prompt_status() {
  return "$1"
}
__hiveward_update_user_debug_trap() {
  local __hiveward_debug_trap_spec="$1" __hiveward_unchanged_debug_trap_spec="$2"
  local __hiveward_debug_trap_command
  [[ "$__hiveward_debug_trap_spec" != "$__hiveward_unchanged_debug_trap_spec" ]] || return 0
  [[ "$__hiveward_debug_trap_spec" != "trap -- '__hiveward_osc133_preexec' DEBUG" ]] || return 0
  if [[ -z "$__hiveward_debug_trap_spec" ]]; then
    __hiveward_user_debug_trap=""
    unset __hiveward_chained_debug_trap
    return 0
  fi
  __hiveward_debug_trap_command="\${__hiveward_debug_trap_spec#trap -- }"
  __hiveward_debug_trap_command="\${__hiveward_debug_trap_command% DEBUG}"
  eval "__hiveward_user_debug_trap=$__hiveward_debug_trap_command"
  unset __hiveward_chained_debug_trap
}
__hiveward_run_user_debug_trap() {
  if [[ -n "\${__hiveward_user_debug_trap:-}" ]]; then
    eval "$__hiveward_user_debug_trap" || true
  fi
}
__hiveward_adopt_outer_debug_trap() {
  local __hiveward_debug_trap_spec="\${__hiveward_outer_debug_trap_spec:-}"
  unset __hiveward_outer_debug_trap_spec
  __hiveward_update_user_debug_trap "$__hiveward_debug_trap_spec" "trap -- '__hiveward_osc133_preexec' DEBUG"
}
__hiveward_run_prompt_command_array() {
  local __hiveward_exit_code="\${__hiveward_prompt_status:-$?}" __hiveward_prompt_part __hiveward_prompt_index __hiveward_user_count
  local __hiveward_suffix_part
  local __hiveward_final_prompt_command
  local __hiveward_in_prompt_dispatch=1 __hiveward_dispatching_user_prompt_command=""
  unset __hiveward_prompt_status
  __hiveward_adopt_outer_debug_trap
  trap '__hiveward_osc133_preexec' DEBUG
  for __hiveward_prompt_part in "\${__hiveward_prompt_command_prefix[@]+"\${__hiveward_prompt_command_prefix[@]}"}"; do
    if (( __hiveward_exit_code == 0 )); then
      eval "$__hiveward_prompt_part"
    else
      __hiveward_restore_prompt_status "$__hiveward_exit_code" || eval "$__hiveward_prompt_part"
    fi
  done
  __hiveward_user_count=0
  for __hiveward_prompt_part in "\${__hiveward_prompt_command_array[@]+"\${__hiveward_prompt_command_array[@]}"}"; do
    __hiveward_user_count=$(( __hiveward_user_count + 1 ))
  done
  for (( __hiveward_prompt_index = 0; __hiveward_prompt_index + 1 < __hiveward_user_count; __hiveward_prompt_index++ )); do
    __hiveward_prompt_part="\${__hiveward_prompt_command_array[__hiveward_prompt_index]}"
    __hiveward_dispatching_user_prompt_command=1
    if (( __hiveward_exit_code == 0 )); then
      eval "$__hiveward_prompt_part"
    else
      __hiveward_restore_prompt_status "$__hiveward_exit_code" || eval "$__hiveward_prompt_part"
    fi
    __hiveward_dispatching_user_prompt_command=""
  done
  if (( __hiveward_user_count > 0 )); then
    __hiveward_prompt_part="\${__hiveward_prompt_command_array[__hiveward_user_count - 1]}"
    # Why: keep the final user hook and HiveWard suffixes in one status-preserving eval.
    __hiveward_final_prompt_command='eval "$__hiveward_prompt_part"'
    for __hiveward_suffix_part in "\${__hiveward_prompt_command_suffix[@]+"\${__hiveward_prompt_command_suffix[@]}"}"; do
      __hiveward_final_prompt_command+=$'\\n'"$__hiveward_suffix_part"
    done
    __hiveward_dispatching_user_prompt_command=1
    if (( __hiveward_exit_code == 0 )); then
      eval "$__hiveward_final_prompt_command"
    else
      __hiveward_restore_prompt_status "$__hiveward_exit_code" || eval "$__hiveward_final_prompt_command"
    fi
    __hiveward_dispatching_user_prompt_command=""
  else
    for __hiveward_prompt_part in "\${__hiveward_prompt_command_suffix[@]+"\${__hiveward_prompt_command_suffix[@]}"}"; do
      if (( __hiveward_exit_code == 0 )); then
        eval "$__hiveward_prompt_part"
      else
        __hiveward_restore_prompt_status "$__hiveward_exit_code" || eval "$__hiveward_prompt_part"
      fi
    done
  fi
  return "$__hiveward_exit_code"
}
__hiveward_finish_legacy_prompt_dispatch() {
  local __hiveward_suffix_part
  if [[ -n "\${__hiveward_in_prompt_command:-}" ]]; then
    for __hiveward_suffix_part in "\${__hiveward_prompt_command_suffix[@]+"\${__hiveward_prompt_command_suffix[@]}"}"; do
      eval "$__hiveward_suffix_part"
    done
  fi
}
__hiveward_normalize_prompt_command() {
  [[ -z "\${__hiveward_prompt_command_normalized:-}" ]] || return 0
  local __hiveward_prompt_part
  local -a __hiveward_normalized=()
  for __hiveward_prompt_part in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
    __hiveward_normalize_prompt_command_part "$__hiveward_prompt_part" __hiveward_prompt_part
    [[ -n "$__hiveward_prompt_part" ]] && __hiveward_normalized+=("$__hiveward_prompt_part")
  done
  __hiveward_prompt_command_normalized=1
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("\${__hiveward_normalized[@]+"\${__hiveward_normalized[@]}"}")
  else
    __hiveward_prompt_command_array=("\${__hiveward_normalized[@]+"\${__hiveward_normalized[@]}"}")
    __hiveward_prompt_command_prefix=()
    __hiveward_prompt_command_suffix=()
    unset PROMPT_COMMAND
    # Why: PID scope distinguishes legacy prompt dispatch from ordinary user command text.
    __hiveward_prompt_status_variable="__hiveward_prompt_status_$$"
    __hiveward_prompt_status_capture_command="$__hiveward_prompt_status_variable=\\$?"
    __hiveward_prompt_status_value="\\\${$__hiveward_prompt_status_variable}"
    # Why: a changed DEBUG trap misses the capture command, and bash <= 4.3 reverts traps set in functions.
    PROMPT_COMMAND="$__hiveward_prompt_status_capture_command; __hiveward_in_legacy_prompt_wrapper=1; __hiveward_prompt_status=$__hiveward_prompt_status_value"'; __hiveward_prompt_had_functrace=""; if [[ -o functrace ]]; then __hiveward_prompt_had_functrace=1; set +T; fi; __hiveward_outer_debug_trap_spec="$(trap -p DEBUG)"; [[ -z "$__hiveward_prompt_had_functrace" ]] || set -T; unset __hiveward_prompt_had_functrace; __hiveward_run_prompt_command_array; __hiveward_finish_legacy_prompt_dispatch; trap __hiveward_osc133_preexec DEBUG; unset __hiveward_in_legacy_prompt_wrapper'
  fi
}
__hiveward_prepend_prompt_command() {
  local command="$1"
  __hiveward_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND=("$command" "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}")
  else
    __hiveward_prompt_command_prefix=("$command" "\${__hiveward_prompt_command_prefix[@]+"\${__hiveward_prompt_command_prefix[@]}"}")
  fi
}
__hiveward_append_prompt_command() {
  local command="$1"
  __hiveward_normalize_prompt_command
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
    PROMPT_COMMAND+=("$command")
  else
    __hiveward_prompt_command_suffix+=("$command")
  fi
}`

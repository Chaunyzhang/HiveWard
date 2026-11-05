import { basename, win32 as pathWin32 } from 'node:path'

export const POSIX_SHELL_STARTUP_COMMAND_ENV = 'HIVEWARD_POSIX_SHELL_STARTUP_COMMAND'

export function supportsPosixShellStartupCommand(shellPath: string): boolean {
  const shellName = pathWin32.basename(basename(shellPath)).toLowerCase()
  return shellName === 'bash' || shellName === 'zsh' || shellName === 'fish'
}

export function getBashStartupCommandPromptBlock(): string {
  return `if [[ \${${POSIX_SHELL_STARTUP_COMMAND_ENV}+present} == present ]]; then
  __hiveward_remove_startup_command_prompt_hook() {
    local __hiveward_item
    local -a __hiveward_remaining=()
    if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )); then
      for __hiveward_item in "\${PROMPT_COMMAND[@]+"\${PROMPT_COMMAND[@]}"}"; do
        [[ "$__hiveward_item" == "__hiveward_run_startup_command" ]] || __hiveward_remaining+=("$__hiveward_item")
      done
      PROMPT_COMMAND=("\${__hiveward_remaining[@]+"\${__hiveward_remaining[@]}"}")
    else
      for __hiveward_item in "\${__hiveward_prompt_command_suffix[@]+"\${__hiveward_prompt_command_suffix[@]}"}"; do
        [[ "$__hiveward_item" == "__hiveward_run_startup_command" ]] || __hiveward_remaining+=("$__hiveward_item")
      done
      __hiveward_prompt_command_suffix=("\${__hiveward_remaining[@]+"\${__hiveward_remaining[@]}"}")
    fi
  }
  __hiveward_run_startup_command() {
    local __hiveward_command="$${POSIX_SHELL_STARTUP_COMMAND_ENV}" __hiveward_status
    unset ${POSIX_SHELL_STARTUP_COMMAND_ENV}
    __hiveward_remove_startup_command_prompt_hook
    unset -f __hiveward_remove_startup_command_prompt_hook
    builtin history -s "$__hiveward_command" 2>/dev/null || true
    builtin printf '%s\n' "$__hiveward_command"
    eval "$__hiveward_command"
    __hiveward_status=$?
    unset -f __hiveward_run_startup_command
    return "$__hiveward_status"
  }
  __hiveward_append_prompt_command "__hiveward_run_startup_command"
fi`
}

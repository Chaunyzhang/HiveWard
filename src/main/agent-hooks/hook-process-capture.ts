/** Capture before HiveWard inserts its managed-script shell. */
export const HOOK_PARENT_CAPTURE =
  'HIVEWARD_HOOK_AGENT_PID="${PPID:-}"; export HIVEWARD_HOOK_AGENT_PID; '

// Uncached, as no builtin tells a reused PID from its old process: Linux reads /proc, macOS runs only ps.
export function buildHookProcessCapture(): string[] {
  return [
    'hiveward_agent_process=',
    // Field 20 after the command name is the start time in clock ticks since boot.
    'hiveward_agent_start_ticks() { hiveward_agent_start=${20-}; }',
    '[ -z "${HIVEWARD_PANE_KEY:-}" ] || case "${HIVEWARD_HOOK_AGENT_PID:-}" in ""|*[!0-9]*) ;; *)',
    '  if [ -r "/proc/$HIVEWARD_HOOK_AGENT_PID/stat" ]; then',
    '    hiveward_agent_stat= hiveward_agent_line= hiveward_agent_boot= hiveward_agent_start=',
    // Read to EOF: a command name may contain a newline, and the strip below takes the last ") ".
    '    while IFS= read -r hiveward_agent_line || [ -n "$hiveward_agent_line" ]; do hiveward_agent_stat="$hiveward_agent_stat$hiveward_agent_line "; hiveward_agent_line=; done 2>/dev/null < "/proc/$HIVEWARD_HOOK_AGENT_PID/stat"',
    '    IFS= read -r hiveward_agent_boot 2>/dev/null < /proc/sys/kernel/random/boot_id',
    '    hiveward_agent_start_ticks ${hiveward_agent_stat##*) }',
    '    case "$hiveward_agent_start" in ""|*[!0-9]*) ;; *)',
    '      [ -z "$hiveward_agent_boot" ] || hiveward_agent_process="{\\"pid\\":$HIVEWARD_HOOK_AGENT_PID,\\"platform\\":\\"linux\\",\\"startTime\\":\\"$hiveward_agent_boot:$hiveward_agent_start\\"}" ;; esac',
    // Bash sets OSTYPE on macOS; other shells still ask uname.
    '  elif case "${OSTYPE-}" in darwin*) ;; *) [ "$(uname -s 2>/dev/null)" = Darwin ] ;; esac; then',
    // Match the host probe's timezone when comparing local-time lstart strings.
    '    hiveward_agent_start=$(TZ=UTC0 LC_ALL=C exec /bin/ps -p "$HIVEWARD_HOOK_AGENT_PID" -o lstart= 2>/dev/null)',
    '    hiveward_agent_start=${hiveward_agent_start#"${hiveward_agent_start%%[! ]*}"}',
    '    hiveward_agent_start=${hiveward_agent_start%"${hiveward_agent_start##*[! ]}"}',
    '    [ -z "$hiveward_agent_start" ] || hiveward_agent_process="{\\"pid\\":$HIVEWARD_HOOK_AGENT_PID,\\"platform\\":\\"darwin\\",\\"startTime\\":\\"$hiveward_agent_start\\"}"',
    '  fi ;;',
    'esac',
    // A tmux pane's own server, socket and pane id; only a lookup hint for the host's attachment check.
    'hiveward_tmux_pane=',
    'case "${TMUX_PANE:-}" in %[0-9]*) [ -z "${TMUX:-}" ] || hiveward_tmux_pane="$TMUX_PANE ${TMUX%,*,*}" ;; esac'
  ]
}

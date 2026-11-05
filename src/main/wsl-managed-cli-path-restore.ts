/** Leads PATH with the managed WSL CLI after startup files ran; an unusable CLI only warns. */
export const WSL_MANAGED_CLI_PATH_RESTORE = `if [ -n "\${HIVEWARD_WSL_CLI_DIR:-}" ]; then
  if [ -x "$HIVEWARD_WSL_CLI_DIR/\${HIVEWARD_CLI_COMMAND:-}" ]; then
    export PATH="$HIVEWARD_WSL_CLI_DIR\${PATH:+:$PATH}"
  else
    printf 'HiveWard CLI unavailable: cannot run %s. Check WSL Windows-drive mount options.\\n' "$HIVEWARD_WSL_CLI_DIR/\${HIVEWARD_CLI_COMMAND:-}" >&2
  fi
fi`

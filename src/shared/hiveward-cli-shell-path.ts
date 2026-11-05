export const HIVEWARD_CLI_POSIX_PATH_RESTORE = `if [ -n "\${HIVEWARD_CLI_BIN_DIR:-}" ]; then
  case "\${PATH:-}" in
    "$HIVEWARD_CLI_BIN_DIR"|"$HIVEWARD_CLI_BIN_DIR":*) ;;
    *) export PATH="$HIVEWARD_CLI_BIN_DIR\${PATH:+:$PATH}" ;;
  esac
fi`

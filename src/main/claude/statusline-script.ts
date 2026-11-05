import {
  WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD,
  buildPosixClaudeBackgroundJobGuardLines
} from '../agent-hooks/claude-background-job-guard'
import { posixCurlCommand } from '../agent-hooks/hook-post-command'
import { WINDOWS_HOOK_STDIN_READER } from '../agent-hooks/hook-stdin-contract'
import {
  CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS,
  CLAUDE_STATUSLINE_PATHNAME
} from '../../shared/claude-statusline-rate-limits'
import { wrapWindowsDirectCmdHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
import { getManagedCommand } from './hook-settings'

const STATUSLINE_CLEANUP_LABEL = 'hiveward_statusline_cleanup'
const STATUSLINE_PROBE_LABEL = 'hiveward_statusline_probe'

// PowerShell needs a bare safe path; unsafe paths keep runtime HOME to avoid per-tick PowerShell spawns.
export function getManagedStatusLineCommand(scriptPath: string): string {
  return (
    (process.platform === 'win32' ? wrapWindowsDirectCmdHookCommand(scriptPath) : null) ??
    getManagedCommand(scriptPath)
  )
}

// Forward live usage without OAuth polling; emit no stdout to preserve the terminal statusline.
export function getManagedStatusLineScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD,
      // Endpoint refresh never sets the pane key, so this guard can precede stdin capture.
      'if "%HIVEWARD_PANE_KEY%"=="" exit /b 0',
      // UUID suffixes and sanitized legacy delimiters keep filenames safe.
      'set "HIVEWARD_STATUSLINE_PANE_ID=%HIVEWARD_PANE_KEY:~-36%"',
      'set "HIVEWARD_STATUSLINE_PANE_ID=%HIVEWARD_STATUSLINE_PANE_ID::=_%"',
      // Buffer before spawning curl; per-pane names avoid same-second %RANDOM% collisions.
      'set "HIVEWARD_STATUSLINE_PAYLOAD_FILE=%TEMP%\\hiveward-claude-statusline-%HIVEWARD_STATUSLINE_PANE_ID%.tmp"',
      `${WINDOWS_HOOK_STDIN_READER} >"%HIVEWARD_STATUSLINE_PAYLOAD_FILE%" 2>nul`,
      // Builtin throttling avoids findstr and curl spawns on streaming ticks.
      'set "HIVEWARD_STATUSLINE_STAMP_FILE=%TEMP%\\hiveward-claude-statusline-last-%HIVEWARD_STATUSLINE_PANE_ID%.tmp"',
      'set "HIVEWARD_STATUSLINE_NOW="',
      'set "HIVEWARD_STATUSLINE_TIME=%TIME: =0%"',
      'for /f "tokens=1-3 delims=:.," %%a in ("%HIVEWARD_STATUSLINE_TIME%") do set /a "HIVEWARD_STATUSLINE_NOW=(1%%a %% 100)*3600+(1%%b %% 100)*60+(1%%c %% 100)" 2>nul',
      'set "HIVEWARD_STATUSLINE_LAST="',
      'set "HIVEWARD_STATUSLINE_ELAPSED="',
      'if exist "%HIVEWARD_STATUSLINE_STAMP_FILE%" set /p HIVEWARD_STATUSLINE_LAST=<"%HIVEWARD_STATUSLINE_STAMP_FILE%"',
      'if defined HIVEWARD_STATUSLINE_LAST for /f "delims=0123456789" %%d in ("%HIVEWARD_STATUSLINE_LAST%") do set "HIVEWARD_STATUSLINE_LAST="',
      'if defined HIVEWARD_STATUSLINE_NOW if defined HIVEWARD_STATUSLINE_LAST set /a "HIVEWARD_STATUSLINE_ELAPSED=HIVEWARD_STATUSLINE_NOW-HIVEWARD_STATUSLINE_LAST" 2>nul',
      `if not defined HIVEWARD_STATUSLINE_ELAPSED goto :${STATUSLINE_PROBE_LABEL}`,
      `if %HIVEWARD_STATUSLINE_ELAPSED% GEQ 0 if %HIVEWARD_STATUSLINE_ELAPSED% LSS ${CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS} goto :${STATUSLINE_CLEANUP_LABEL}`,
      `:${STATUSLINE_PROBE_LABEL}`,
      // Non-subscriber payloads lack rate_limits; skip their endpoint lookup and curl spawn.
      // Escaped quotes match the JSON key, avoiding false matches in paths.
      '"%SystemRoot%\\System32\\findstr.exe" /c:\\"rate_limits\\" "%HIVEWARD_STATUSLINE_PAYLOAD_FILE%" >nul 2>nul',
      `if errorlevel 1 goto :${STATUSLINE_CLEANUP_LABEL}`,
      // Refresh stale endpoint coordinates after HiveWard restarts, falling back to PTY env.
      'if defined HIVEWARD_AGENT_HOOK_ENDPOINT if exist "%HIVEWARD_AGENT_HOOK_ENDPOINT%" call "%HIVEWARD_AGENT_HOOK_ENDPOINT%" 2>nul',
      `if "%HIVEWARD_AGENT_HOOK_PORT%"=="" goto :${STATUSLINE_CLEANUP_LABEL}`,
      `if "%HIVEWARD_AGENT_HOOK_TOKEN%"=="" goto :${STATUSLINE_CLEANUP_LABEL}`,
      // Stamp only eligible posts so skipped ticks never postpone the next post.
      'if defined HIVEWARD_STATUSLINE_NOW (>"%HIVEWARD_STATUSLINE_STAMP_FILE%" echo %HIVEWARD_STATUSLINE_NOW%)',
      // An always-defined field posts empty configDir when unset, rather than a literal %VAR%.
      'set "HIVEWARD_STATUSLINE_CONFIG_DIR_FIELD=configDir="',
      'if defined CLAUDE_CONFIG_DIR set "HIVEWARD_STATUSLINE_CONFIG_DIR_FIELD=configDir=%CLAUDE_CONFIG_DIR%"',
      [
        '"%SystemRoot%\\System32\\curl.exe" -sS -X POST',
        `"http://127.0.0.1:%HIVEWARD_AGENT_HOOK_PORT%${CLAUDE_STATUSLINE_PATHNAME}"`,
        '--connect-timeout 0.5 --max-time 1.5',
        '-H "Content-Type: application/x-www-form-urlencoded"',
        '-H "X-HiveWard-Agent-Hook-Token: %HIVEWARD_AGENT_HOOK_TOKEN%"',
        '--data-urlencode "paneKey=%HIVEWARD_PANE_KEY%"',
        '--data-urlencode "%HIVEWARD_STATUSLINE_CONFIG_DIR_FIELD%"',
        '--data-urlencode "env=%HIVEWARD_AGENT_HOOK_ENV%"',
        '--data-urlencode "version=%HIVEWARD_AGENT_HOOK_VERSION%"',
        '--data-urlencode "payload@%HIVEWARD_STATUSLINE_PAYLOAD_FILE%"',
        '>nul 2>&1'
      ].join(' '),
      `:${STATUSLINE_CLEANUP_LABEL}`,
      'del "%HIVEWARD_STATUSLINE_PAYLOAD_FILE%" >nul 2>nul',
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Builtin capture avoids per-tick cat spawns.
    'payload=',
    'while IFS= read -r hiveward_statusline_line || [ -n "$hiveward_statusline_line" ]; do',
    '  payload="${payload}${hiveward_statusline_line}\n"',
    'done',
    'payload=${payload%?}',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    ...buildPosixClaudeBackgroundJobGuardLines(),
    // Non-subscriber payloads lack rate_limits; avoid spawning curl for them.
    'case "$payload" in',
    '  *\'"rate_limits"\'*) ;;',
    '  *) exit 0 ;;',
    'esac',
    'if [ -n "$HIVEWARD_AGENT_HOOK_ENDPOINT" ] && [ -r "$HIVEWARD_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$HIVEWARD_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$HIVEWARD_AGENT_HOOK_PORT" ] || [ -z "$HIVEWARD_AGENT_HOOK_TOKEN" ] || [ -z "$HIVEWARD_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // The stable leaf UUID excludes path-unsafe and overlong tab IDs.
    'hiveward_statusline_pane_id=${HIVEWARD_PANE_KEY##*:}',
    // Legacy numeric leaf IDs were tab-local; include a safe tab ID to isolate their stamps.
    'case "$hiveward_statusline_pane_id" in',
    "  ''|*[!0-9]*) ;;",
    '  *)',
    '    hiveward_statusline_tab_id=${HIVEWARD_PANE_KEY%:*}',
    '    case "$hiveward_statusline_tab_id" in',
    "      ''|*[!A-Za-z0-9._-]*) ;;",
    '      *) hiveward_statusline_pane_id="${hiveward_statusline_tab_id}_${hiveward_statusline_pane_id}" ;;',
    '    esac',
    '    ;;',
    'esac',
    'hiveward_statusline_stamp="${TMPDIR:-/tmp}/hiveward-claude-statusline-last-${hiveward_statusline_pane_id}"',
    // Use the payload clock to avoid per-tick date spawns; fall back if the schema changes.
    'hiveward_statusline_now=',
    'case "$payload" in',
    '  *\'"total_duration_ms"\'*)',
    '    hiveward_statusline_duration=${payload#*\'"total_duration_ms"\'}',
    '    hiveward_statusline_duration=${hiveward_statusline_duration#*:}',
    '    hiveward_statusline_duration=${hiveward_statusline_duration#"${hiveward_statusline_duration%%[![:space:]]*}"}',
    '    hiveward_statusline_duration=${hiveward_statusline_duration%%[!0-9]*}',
    '    case "$hiveward_statusline_duration" in',
    '      0|[1-9]|[1-9][0-9]*)',
    '        if [ "${#hiveward_statusline_duration}" -le 15 ]; then',
    '          hiveward_statusline_now=$((hiveward_statusline_duration / 1000))',
    '        fi',
    '        ;;',
    '    esac',
    '    ;;',
    'esac',
    'if [ -z "$hiveward_statusline_now" ]; then',
    '  hiveward_statusline_now=$(date +%s 2>/dev/null) || hiveward_statusline_now=',
    'fi',
    // Canonical decimals avoid fatal dash octal errors (008); malformed stamps must fail open.
    'case "$hiveward_statusline_now" in 0|[1-9]|[1-9][0-9]*) ;; *) hiveward_statusline_now= ;; esac',
    'if [ -n "$hiveward_statusline_now" ] && [ -f "$hiveward_statusline_stamp" ]; then',
    '  hiveward_statusline_last=',
    '  IFS= read -r hiveward_statusline_last <"$hiveward_statusline_stamp" 2>/dev/null || :',
    '  case "$hiveward_statusline_last" in 0|[1-9]|[1-9][0-9]*) ;; *) hiveward_statusline_last= ;; esac',
    '  if [ "${#hiveward_statusline_last}" -gt 15 ]; then hiveward_statusline_last=; fi',
    '  if [ -n "$hiveward_statusline_last" ]; then',
    '    hiveward_statusline_elapsed=$((hiveward_statusline_now - hiveward_statusline_last))',
    `    if [ "$hiveward_statusline_elapsed" -ge 0 ] && [ "$hiveward_statusline_elapsed" -lt ${CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS} ]; then`,
    '      exit 0',
    '    fi',
    '  fi',
    'fi',
    'if [ -n "$hiveward_statusline_now" ]; then',
    '  printf \'%s\' "$hiveward_statusline_now" >"$hiveward_statusline_stamp" 2>/dev/null || :',
    'fi',
    `printf '%s' "$payload" | ${posixCurlCommand()} -sS -X POST "http://127.0.0.1:\${HIVEWARD_AGENT_HOOK_PORT}${CLAUDE_STATUSLINE_PATHNAME}" \\`,
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-HiveWard-Agent-Hook-Token: ${HIVEWARD_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${HIVEWARD_PANE_KEY}" \\',
    '  --data-urlencode "configDir=${CLAUDE_CONFIG_DIR}" \\',
    '  --data-urlencode "env=${HIVEWARD_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${HIVEWARD_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

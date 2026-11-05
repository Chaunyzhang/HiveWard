import { buildHookProcessCapture } from '../agent-hooks/hook-process-capture'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { buildWindowsAgentHookCurlPostCommand } from '../agent-hooks/installer-utils'
import {
  buildPosixAgentHookPostCommand,
  buildPosixHookMetadataCacheLines
} from '../agent-hooks/hook-post-command'
import {
  buildPosixScrubSafeEnvRestoreLines,
  buildWindowsScrubSafeEnvRestoreLines
} from '../../shared/agent-hook-scrub-safe-env'
import {
  buildPosixCursorReplayGuardLines,
  buildWindowsCursorReplayGuardLines
} from '../agent-hooks/cursor-replay-guard'
import {
  buildPosixGrokReplayGuardLines,
  buildWindowsGrokReplayGuardLines
} from '../agent-hooks/grok-replay-guard'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  POSIX_HOOK_STDIN_EXEC
} from '../agent-hooks/hook-stdin-contract'
import {
  WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD,
  buildPosixClaudeBackgroundJobGuardLines
} from '../agent-hooks/claude-background-job-guard'

export function getManagedScript(
  target: 'local' | 'posix' = 'local',
  options: {
    source?: AgentHookSource
    skipWhenDevinImportsClaude?: boolean
    skipWhenGrokImportsClaude?: boolean
    skipWhenCursorImportsClaude?: boolean
  } = {}
): string {
  const source = options.source ?? 'claude'
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Permission hooks fail closed on empty stdout, including skip paths.
      'echo {}',
      // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB drops HIVEWARD_PANE_KEY; restore it before any guard reads it.
      ...buildWindowsScrubSafeEnvRestoreLines(),
      // Refresh endpoint coordinates for PTYs surviving an HiveWard restart.
      'if defined HIVEWARD_AGENT_HOOK_ENDPOINT if exist "%HIVEWARD_AGENT_HOOK_ENDPOINT%" call "%HIVEWARD_AGENT_HOOK_ENDPOINT%" 2>nul',
      // Outside an HiveWard pane the caller may abandon stdin; exit before owning it (#11549).
      ...buildWindowsHookEnvironmentGuardLines(),
      WINDOWS_CLAUDE_BACKGROUND_JOB_GUARD,
      ...(options.skipWhenGrokImportsClaude ? buildWindowsGrokReplayGuardLines() : []),
      ...(options.skipWhenCursorImportsClaude ? buildWindowsCursorReplayGuardLines() : []),
      ...(options.skipWhenDevinImportsClaude
        ? [
            // Devin imports Claude hooks; skip duplicate posts to preserve Devin attribution.
            'if not "%DEVIN_PROJECT_DIR%"=="" exit /b 0'
          ]
        : []),
      // Avoid a PowerShell startup per hook.
      buildWindowsAgentHookCurlPostCommand(source),
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Permission hooks fail closed on empty stdout, including skip paths.
    'printf "{}\\n"',
    // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB drops HIVEWARD_PANE_KEY; restore it before any guard or spool reads it.
    ...buildPosixScrubSafeEnvRestoreLines(),
    ...buildPosixHookPayloadCapture('exit', POSIX_HOOK_STDIN_EXEC),
    ...(options.skipWhenGrokImportsClaude ? buildPosixGrokReplayGuardLines() : []),
    ...(options.skipWhenCursorImportsClaude ? buildPosixCursorReplayGuardLines() : []),
    ...buildPosixHookSpoolLines(source),
    ...(options.skipWhenDevinImportsClaude
      ? [
          // Devin imports Claude hooks; skip duplicate posts to preserve Devin attribution.
          'if [ -n "$DEVIN_PROJECT_DIR" ]; then',
          '  exit 0',
          'fi'
        ]
      : []),
    ...buildPosixClaudeBackgroundJobGuardLines(),
    ...(source === 'claude' ? buildHookProcessCapture() : []),
    // Surviving PTYs need fresh endpoint coordinates; suppress errors and survive outer set -e.
    'if [ -n "$HIVEWARD_AGENT_HOOK_ENDPOINT" ] && [ -r "$HIVEWARD_AGENT_HOOK_ENDPOINT" ]; then',
    '  unset HIVEWARD_AGENT_HOOK_TRANSPORT',
    '  . "$HIVEWARD_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$HIVEWARD_AGENT_HOOK_PORT" ] || [ -z "$HIVEWARD_AGENT_HOOK_TOKEN" ] || [ -z "$HIVEWARD_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    ...buildPosixHookMetadataCacheLines(),
    // Keep hook JSON off argv and avoid URL-encoded paths that trigger IDS rules.
    ...buildPosixAgentHookPostCommand(source, { cachedMetadata: true }).map((line, index, lines) =>
      index === lines.length - 1 ? `${line} >/dev/null 2>&1 || spool_hook_event` : line
    ),
    'exit 0',
    ''
  ].join('\n')
}

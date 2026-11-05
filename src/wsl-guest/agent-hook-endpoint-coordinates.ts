// Define hook endpoint paths and PTY env coordinates without IO; Windows pipe paths require flattening.
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

import {
  HIVEWARD_HOOK_PROTOCOL_VERSION,
  HIVEWARD_HOOK_RAW_JSON_TRANSPORT
} from '../shared/agent-hook-types'

// Use a per-user relay directory so shared hosts isolate endpoint files with mode 0700.
const RELAY_HOOKS_DIR_NAME = '.hiveward-relay'
const RELAY_HOOKS_SUBDIR = 'agent-hooks'

export function defaultEndpointDir(): string {
  return join(homedir(), RELAY_HOOKS_DIR_NAME, RELAY_HOOKS_SUBDIR)
}

function isWindowsNamedPipePath(sockPath: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(sockPath)
}

function windowsNamedPipeEndpointName(sockPath: string): string {
  return (
    sockPath
      .replace(/^\\\\[.?]\\pipe\\/i, '')
      .split(/[\\/]/)
      .findLast(Boolean) ?? 'relay'
  )
}

export function endpointDirForRelaySocket(sockPath: string): string {
  if (isWindowsNamedPipePath(sockPath)) {
    return join(defaultEndpointDir(), windowsNamedPipeEndpointName(sockPath))
  }
  return join(dirname(sockPath), RELAY_HOOKS_SUBDIR, basename(sockPath))
}

/** Env vars to inject into relay-spawned PTYs so the hook script/plugin POSTs back to the loopback server. */
export function buildRelayHookPtyEnv(coordinates: {
  port: number
  token: string
  env: string
  endpointFilePath: string
  endpointFileWritten: boolean
}): Record<string, string> {
  if (coordinates.port <= 0 || !coordinates.token) {
    return {}
  }
  const env: Record<string, string> = {
    HIVEWARD_AGENT_HOOK_PORT: String(coordinates.port),
    HIVEWARD_AGENT_HOOK_TOKEN: coordinates.token,
    HIVEWARD_AGENT_HOOK_ENV: coordinates.env,
    HIVEWARD_AGENT_HOOK_VERSION: HIVEWARD_HOOK_PROTOCOL_VERSION,
    HIVEWARD_AGENT_HOOK_OPENCODE_TUI: '1',
    HIVEWARD_AGENT_HOOK_TRANSPORT: HIVEWARD_HOOK_RAW_JSON_TRANSPORT
  }
  if (coordinates.endpointFileWritten) {
    env.HIVEWARD_AGENT_HOOK_ENDPOINT = coordinates.endpointFilePath
  }
  return env
}

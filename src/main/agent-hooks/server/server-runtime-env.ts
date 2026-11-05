import { join } from 'node:path'
import {
  getEndpointFileName,
  writeEndpointFile
} from '../../../shared/agent-hook-listener/endpoint-publication'
import {
  HIVEWARD_HOOK_PROTOCOL_VERSION,
  HIVEWARD_HOOK_RAW_JSON_TRANSPORT
} from '../../../shared/agent-hook-types'
import { AgentHookServerIngestRemote } from './server-ingest-remote'

export abstract class AgentHookServerRuntimeEnv extends AgentHookServerIngestRemote {
  buildPtyEnv(): Record<string, string> {
    if (!this.statusHooksEnabled || this.port <= 0 || !this.token) {
      return {}
    }
    const env: Record<string, string> = {
      HIVEWARD_AGENT_HOOK_PORT: String(this.port),
      HIVEWARD_AGENT_HOOK_TOKEN: this.token,
      HIVEWARD_AGENT_HOOK_ENV: this.env,
      HIVEWARD_AGENT_HOOK_VERSION: HIVEWARD_HOOK_PROTOCOL_VERSION,
      HIVEWARD_AGENT_HOOK_OPENCODE_TUI: '1',
      HIVEWARD_AGENT_HOOK_TRANSPORT: HIVEWARD_HOOK_RAW_JSON_TRANSPORT
    }
    // Hooks read the endpoint on invocation; dev instances must not steal each other's hooks.
    if (this.endpointFileWritten && this.endpointFilePathCache) {
      env.HIVEWARD_AGENT_HOOK_ENDPOINT = this.endpointFilePathCache
    }
    return env
  }

  get endpointFilePath(): string | null {
    return this.endpointFilePathCache
  }

  get lastStatusPath(): string | null {
    return this.lastStatusFilePath
  }

  protected maybeWriteEndpointFile(): void {
    if (!this.endpointDir || !this.endpointFilePathCache) {
      return
    }
    this.endpointFileWritten = false
    const ok = writeEndpointFile(this.endpointDir, this.endpointFilePathCache, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: HIVEWARD_HOOK_PROTOCOL_VERSION,
      openCodeTui: true,
      transport: HIVEWARD_HOOK_RAW_JSON_TRANSPORT
    })
    this.endpointFileWritten = ok
  }

  protected configureEndpointPaths(userDataPath: string, endpointNamespace?: string): void {
    // Dev endpoints are per instance; packaged endpoints stay stable for PTY reconnect.
    this.endpointDir = endpointNamespace
      ? join(userDataPath, 'agent-hooks', endpointNamespace)
      : join(userDataPath, 'agent-hooks')
    this.endpointFilePathCache = join(this.endpointDir, getEndpointFileName())
    this.lastStatusFilePath = join(this.endpointDir, 'last-status.json')
  }
}

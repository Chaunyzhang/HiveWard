import {
  AGENT_STATUS_STALE_AFTER_MS,
  pickHostTurnEnd,
  pickParsedAgentStatusPayload,
  type AgentStatusEntry,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload,
  type TurnEndDisposition
} from '../../shared/agent-status-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session/lifecycle/agent-session-resume'
import type { ProgramStatusFacet } from '../../shared/program-status/facet'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalLastAgentStatus
} from '../../shared/runtime-types'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from './runtime-worktree-status-projection'

/** One hook-server row projected into the shape the runtime's own readers consume. */
export type RuntimeAgentRowSnapshot = {
  paneKey: string
  worktreeId?: string
  tabId?: string
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  stateStartedAt: number
  turnEndedAt?: number
  turnEndDisposition?: TurnEndDisposition
  updatedAt: number
  evidenceObservedAt?: number
  providerSession?: AgentProviderSessionMetadata
  programStatus?: ProgramStatusFacet
}

function isLiveObservation(row: AgentStatusIpcPayload): boolean {
  // Restored rows cannot prove current liveness; resume-identity rows carry no status.
  return row.restoredUnconfirmed !== true && row.providerSessionOnly !== true
}

type HookRowJoin = {
  handles: Iterable<string>
  paneKeys: Iterable<string>
  hookRows: readonly AgentStatusIpcPayload[]
}

function isPermissionState(state: AgentStatusEntry['state']): boolean {
  return mapExplicitAgentStateToRuntimeTerminalStatus(state) === 'permission'
}

/** The freshest live hook row for a terminal, joined on any of its handles or pane keys. */
export function selectFreshExplicitAgentStatusRow(args: HookRowJoin): AgentStatusIpcPayload | null {
  const now = Date.now()
  const handles = new Set(args.handles)
  const paneKeys = new Set(args.paneKeys)
  let best: AgentStatusIpcPayload | null = null
  for (const row of args.hookRows) {
    if (!(row.terminalHandle && handles.has(row.terminalHandle)) && !paneKeys.has(row.paneKey)) {
      continue
    }
    if (!row.state || !isLiveObservation(row) || typeof row.receivedAt !== 'number') {
      continue
    }
    if (now - (row.evidenceObservedAt ?? row.receivedAt) > AGENT_STATUS_STALE_AFTER_MS) {
      continue
    }
    if (
      !best ||
      row.receivedAt > best.receivedAt ||
      (row.receivedAt === best.receivedAt && isPermissionState(row.state))
    ) {
      best = row
    }
  }
  return best
}

export type FreshExplicitAgentStatus = {
  status: NonNullable<RuntimeTerminalAgentStatus['status']>
  updatedAt: number
  stateStartedAt: number
  state?: NonNullable<RuntimeTerminalAgentStatus['state']>
  prompt?: string
  lastAssistantMessage?: string
  lastAssistantMessageIsToolOutput?: boolean
  interrupted?: boolean
  sessionBoundary?: boolean
  backgroundCommands?: number
}

function projectReportedAgentStatus(
  row: AgentStatusIpcPayload
): RuntimeTerminalLastAgentStatus | null {
  if (!row.state || typeof row.receivedAt !== 'number') {
    return null
  }
  return {
    updatedAt: row.receivedAt,
    stateStartedAt: typeof row.stateStartedAt === 'number' ? row.stateStartedAt : row.receivedAt,
    state: row.state,
    prompt: row.prompt,
    ...(row.lastAssistantMessage !== undefined
      ? { lastAssistantMessage: row.lastAssistantMessage }
      : {}),
    ...(row.lastAssistantMessageIsToolOutput !== undefined
      ? { lastAssistantMessageIsToolOutput: row.lastAssistantMessageIsToolOutput }
      : {}),
    ...(row.interrupted !== undefined ? { interrupted: row.interrupted } : {}),
    ...(row.sessionBoundary !== undefined ? { sessionBoundary: row.sessionBoundary } : {})
  }
}

/** The latest reported state remains historical evidence even after the live freshness window. */
export function selectLastReportedAgentStatus(args: {
  handle: string
  paneKey: string | null
  hookRows: readonly AgentStatusIpcPayload[]
}): RuntimeTerminalLastAgentStatus | null {
  const handles = new Set([args.handle])
  const paneKeys = new Set(args.paneKey ? [args.paneKey] : [])
  let best: AgentStatusIpcPayload | null = null
  for (const row of args.hookRows) {
    if (!(row.terminalHandle && handles.has(row.terminalHandle)) && !paneKeys.has(row.paneKey)) {
      continue
    }
    if (
      !row.state ||
      row.providerSessionOnly ||
      typeof row.receivedAt !== 'number' ||
      (best && row.receivedAt <= best.receivedAt)
    ) {
      continue
    }
    best = row
  }
  return best ? projectReportedAgentStatus(best) : null
}

/** The freshest explicit state for a terminal, matched on its handle or its pane key. */
export function selectFreshExplicitAgentStatus(args: {
  handle: string
  paneKey: string | null
  hookRows: readonly AgentStatusIpcPayload[]
}): FreshExplicitAgentStatus | null {
  const row = selectFreshExplicitAgentStatusRow({
    handles: [args.handle],
    paneKeys: args.paneKey ? [args.paneKey] : [],
    hookRows: args.hookRows
  })
  const reported = row ? projectReportedAgentStatus(row) : null
  return row && reported
    ? {
        status: mapExplicitAgentStateToRuntimeTerminalStatus(reported.state),
        ...reported,
        ...(row.backgroundCommands !== undefined
          ? { backgroundCommands: row.backgroundCommands }
          : {})
      }
    : null
}

/** Prefer the pane's own key, then its terminal binding when the pane key has moved. */
export function selectFreshAgentRowForMobileTab(args: {
  paneKey: string
  terminalHandle: string | null
  hookRows: readonly AgentStatusIpcPayload[]
}): RuntimeAgentRowSnapshot | null {
  let match: AgentStatusIpcPayload | null = null
  const now = Date.now()
  for (const row of args.hookRows) {
    if (
      !isLiveObservation(row) ||
      now - (row.evidenceObservedAt ?? row.receivedAt) > AGENT_STATUS_STALE_AFTER_MS
    ) {
      continue
    }
    if (row.paneKey === args.paneKey) {
      if (!match || match.paneKey !== args.paneKey || row.receivedAt > match.receivedAt) {
        match = row
      }
      continue
    }
    if (
      match?.paneKey !== args.paneKey &&
      args.terminalHandle !== null &&
      row.terminalHandle === args.terminalHandle &&
      (!match || row.receivedAt > match.receivedAt)
    ) {
      match = row
    }
  }
  if (!match) {
    return null
  }
  return {
    paneKey: match.paneKey,
    connectionId: match.connectionId ?? null,
    ...(match.worktreeId ? { worktreeId: match.worktreeId } : {}),
    ...(match.tabId ? { tabId: match.tabId } : {}),
    payload: pickParsedAgentStatusPayload(match),
    stateStartedAt: match.stateStartedAt ?? match.receivedAt,
    ...pickHostTurnEnd(match),
    updatedAt: match.receivedAt,
    ...(match.providerSession ? { providerSession: match.providerSession } : {}),
    ...(match.programStatus ? { programStatus: match.programStatus } : {}),
    ...(match.evidenceObservedAt !== undefined
      ? { evidenceObservedAt: match.evidenceObservedAt }
      : {})
  }
}

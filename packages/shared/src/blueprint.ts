import type { AgentPermissionProfile, RuntimeObjectRef, RuntimeObjectSource, RuntimeUsageFact } from "./runtime";
import { normalizeRuntimeAccessPolicy } from "./lifecycle";
import type {
  ApprovalDecision,
  ApprovalRequest,
  AgentHandoff,
  AgentHumanReport,
  Artifact,
  IterationRound,
  IterationSession,
  ManagerContextSnapshot,
  ManagerDispatchMode,
  ManagerLifecycleMode,
  ManagerMail,
  ReleaseReport,
  RunTimelineItem,
  RuntimeAccessPolicy
} from "./lifecycle";

export type AgentRuntimeId = "openclaw" | "codex" | "claude" | "google" | "cursor" | "opencode" | "hermes";

export type AgentBlueprintNodeType = "agent";

export type BlueprintNodeType =
  | AgentBlueprintNodeType
  | "manager"
  | "manager_slot"
  | "loop"
  | "condition"
  | "summary"
  | "note"
  | "group";

export type BlueprintRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "waiting_approval";

export type BlueprintNodeRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"
  | "waiting_approval";

export type BlueprintNodeResultRole = "auto" | "final" | "ignore";

export type ManagerSlotExecutionMode = "manual" | "parallel";

export type CrossRoundContextMode =
  | "off"
  | "node_history"
  | "node_history_with_upstream"
  | "node_history_with_upstream_and_manager_memory";

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface BlueprintNodeBaseConfig {
  label: string;
  description?: string;
  resultRole?: BlueprintNodeResultRole;
  crossRoundContextMode?: CrossRoundContextMode;
}

export interface AgentNodeConfig extends BlueprintNodeBaseConfig {
  openclawAgentId?: string;
  profileId?: string;
  agentName: string;
  prompt: string;
  userPrompt?: string;
  skillIds?: string[];
  modelId?: string;
  permissionProfile?: AgentPermissionProfile;
  runtimeAccessPolicy?: RuntimeAccessPolicy;
  workingDirectory?: string;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  approval?: AgentApprovalConfig;
  send?: AgentSendConfig;
  tools: string[];
}

export interface AgentApprovalConfig {
  enabled: boolean;
}

export interface AgentSendConfig {
  enabled: boolean;
  channelId: string;
  target: string;
  bodyTemplate: string;
}

export interface ManagerNodeConfig extends BlueprintNodeBaseConfig {
  portCount: number;
  maxHandoffs: number;
  instructions?: string;
  openclawAgentId?: string;
  profileId?: string;
  agentName?: string;
  modelId?: string;
  skillIds?: string[];
  permissionProfile?: AgentPermissionProfile;
  runtimeAccessPolicy?: RuntimeAccessPolicy;
  lifecycleMode?: ManagerLifecycleMode;
  dispatchMode?: ManagerDispatchMode;
  maxRounds?: number;
  researchAgentNodeId?: string;
  requirementAgentNodeId?: string;
  maxPreparationAttempts?: number;
  autoApproveRequirements?: boolean;
  autoApproveReleaseReports?: boolean;
  workingDirectory?: string;
  timeoutMs?: number;
  tools?: string[];
}

export interface ManagerSlotNodeConfig extends BlueprintNodeBaseConfig {
  managerNodeId: string;
  slot: number;
  executionMode?: ManagerSlotExecutionMode;
  parallelLaneCount?: number;
}

export interface LoopNodeConfig extends BlueprintNodeBaseConfig {
  maxIterations: number;
}

export interface ConditionNodeConfig extends BlueprintNodeBaseConfig {
  expression: string;
}

export interface SummaryNodeConfig extends BlueprintNodeBaseConfig {
  mode: "structured_merge" | "harness_summary";
  runtimeId?: AgentRuntimeId;
  profileId?: string;
  prompt?: string;
  modelId?: string;
  runtimeAccessPolicy?: RuntimeAccessPolicy;
}

export interface NoteNodeConfig extends BlueprintNodeBaseConfig {
  body: string;
}

export interface GroupNodeConfig extends BlueprintNodeBaseConfig {
  color: string;
}

export type BlueprintNodeConfig =
  | AgentNodeConfig
  | ManagerNodeConfig
  | ManagerSlotNodeConfig
  | LoopNodeConfig
  | ConditionNodeConfig
  | SummaryNodeConfig
  | NoteNodeConfig
  | GroupNodeConfig;

export function isAgentBlueprintNodeType(type: BlueprintNodeType): type is AgentBlueprintNodeType {
  return type === "agent";
}

export function isAgentBlueprintNode(node: BlueprintNode): node is BlueprintNode & {
  type: "agent";
  runtimeId: AgentRuntimeId;
  config: AgentNodeConfig;
} {
  return node.type === "agent";
}

export function resolveAgentRuntimeSource(runtimeId: AgentRuntimeId): RuntimeObjectSource {
  return runtimeId;
}

export interface BlueprintNode {
  id: string;
  type: BlueprintNodeType;
  runtimeId?: AgentRuntimeId;
  position: CanvasPosition;
  size?: CanvasSize;
  config: BlueprintNodeConfig;
  parentId?: string;
  disabled?: boolean;
}

export interface BlueprintEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  condition?: "true" | "false" | "success" | "failure";
}

export interface BlueprintDefinition {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  version: number;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  variables: Record<string, string>;
  display: {
    viewport?: {
      x: number;
      y: number;
      zoom: number;
    };
  };
  createdAt: string;
  updatedAt: string;
}

export const portableBlueprintPackageSchema = "hiveward.blueprint-package/v1";

export type PortableBlueprintDefinition = Pick<
  BlueprintDefinition,
  "id" | "name" | "description" | "version" | "nodes" | "edges" | "variables" | "display"
>;

export interface PortableBlueprintPackage {
  schema: typeof portableBlueprintPackageSchema;
  exportedAt: string;
  blueprints: PortableBlueprintDefinition[];
}

const portableBlueprintNodeTypes = new Set<BlueprintNodeType>([
  "agent",
  "manager",
  "manager_slot",
  "loop",
  "condition",
  "summary",
  "note",
  "group"
]);

const agentRuntimeIds = new Set<AgentRuntimeId>(["openclaw", "codex", "claude", "google", "cursor", "opencode", "hermes"]);

const blueprintEdgeConditions = new Set<NonNullable<BlueprintEdge["condition"]>>([
  "true",
  "false",
  "success",
  "failure"
]);

const blueprintNodeResultRoles = new Set<BlueprintNodeResultRole>(["auto", "final", "ignore"]);
const managerSlotExecutionModes = new Set<ManagerSlotExecutionMode>(["manual", "parallel"]);
const crossRoundContextModes = new Set<CrossRoundContextMode>([
  "off",
  "node_history",
  "node_history_with_upstream",
  "node_history_with_upstream_and_manager_memory"
]);
const managerInHandlePrefix = "manager-in-";
const managerOutHandlePrefix = "manager-out-";
const managerSlotInHandle = "manager-slot-in";
const managerSlotOutHandle = "manager-slot-out";
const managerSlotForwardOutHandle = "manager-slot-forward-out";
const managerSlotInnerOutHandle = "manager-slot-inner-out";
const managerSlotInnerInHandle = "manager-slot-inner-in";
const maxManagerPortCount = 8;
const maxManagerSlotParallelLaneCount = 16;
const managerSlotDefaultSize: CanvasSize = { width: 560, height: 300 };
const managerSlotMinSize: CanvasSize = { width: 420, height: 260 };

export function resolveManagerSlotExecutionMode(
  config: Pick<ManagerSlotNodeConfig, "executionMode" | "parallelLaneCount">
): ManagerSlotExecutionMode {
  return resolveManagerSlotParallelLaneCount(config) > 1 ? "parallel" : "manual";
}

export function resolveManagerSlotParallelLaneCount(
  config: Pick<ManagerSlotNodeConfig, "parallelLaneCount">
): number {
  if (typeof config.parallelLaneCount !== "number" || !Number.isFinite(config.parallelLaneCount)) return 1;
  return Math.min(maxManagerSlotParallelLaneCount, Math.max(1, Math.round(config.parallelLaneCount)));
}

export function resolveCrossRoundContextMode(
  config: Pick<BlueprintNodeBaseConfig, "crossRoundContextMode">
): CrossRoundContextMode {
  return config.crossRoundContextMode ?? "off";
}

export function managerSlotInnerOutHandleId(lane: number): string {
  return lane <= 1 ? managerSlotInnerOutHandle : `${managerSlotInnerOutHandle}-${lane}`;
}

export function managerSlotInnerInHandleId(lane: number): string {
  return lane <= 1 ? managerSlotInnerInHandle : `${managerSlotInnerInHandle}-${lane}`;
}

export function managerSlotForwardOutHandleId(): string {
  return managerSlotForwardOutHandle;
}

export function isManagerSlotInnerOutHandle(handle: string | null | undefined): boolean {
  return handle === managerSlotInnerOutHandle || Boolean(handle?.startsWith(`${managerSlotInnerOutHandle}-`));
}

export function isManagerSlotInnerInHandle(handle: string | null | undefined): boolean {
  return handle === managerSlotInnerInHandle || Boolean(handle?.startsWith(`${managerSlotInnerInHandle}-`));
}

export function isManagerSlotForwardOutHandle(handle: string | null | undefined): boolean {
  return handle === managerSlotForwardOutHandle;
}

export interface BlueprintImportDefaults {
  runtimeId?: AgentRuntimeId;
  openclawAgentId?: string;
  modelId?: string;
  modelIds?: Partial<Record<AgentRuntimeId, string>>;
  channelId?: string;
  replaceBlueprintId?: string;
}

export interface BlueprintRun {
  id: string;
  companyId: string;
  blueprintId: string;
  blueprintName?: string;
  blueprintVersion: number;
  status: BlueprintRunStatus;
  startedBy: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  runtimeRefs: RuntimeObjectRef[];
}

export interface BlueprintNodeRun {
  id: string;
  blueprintRunId: string;
  blueprintId: string;
  nodeId: string;
  nodeLabel: string;
  nodeType: BlueprintNodeType;
  iterationRoundId?: string;
  status: BlueprintNodeRunStatus;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  usage?: RuntimeUsageFact;
  runtimeRef?: RuntimeObjectRef;
}

export interface BlueprintNodeEvent {
  id: string;
  blueprintRunId: string;
  nodeRunId?: string;
  type:
    | "blueprint.run.started"
    | "node.run.queued"
    | "node.run.started"
    | "node.run.waiting_approval"
    | "node.run.completed"
    | "node.run.failed"
    | "node.run.cancelled"
    | "blueprint.run.completed"
    | "blueprint.run.cancelled"
    | "blueprint.run.failed";
  message: string;
  createdAt: string;
  runtimeRef?: RuntimeObjectRef;
}

export interface BlueprintRunView {
  run: BlueprintRunSummary;
  nodeRuns: BlueprintNodeRun[];
  events: BlueprintNodeEvent[];
  finalResult?: FinalRunResult | null;
  iterationSessions?: IterationSession[];
  iterationRounds?: IterationRound[];
  approvalRequests?: ApprovalRequest[];
  approvalDecisions?: ApprovalDecision[];
  artifacts?: Artifact[];
  releaseReports?: ReleaseReport[];
  agentHumanReports?: AgentHumanReport[];
  agentHandoffs?: AgentHandoff[];
  managerContextSnapshots?: ManagerContextSnapshot[];
  runTimeline?: RunTimelineItem[];
  managerMail?: ManagerMail[];
}

export interface BlueprintRunSummary extends BlueprintRun {
  blueprintName: string;
}

export const blueprintRunArchiveSchema = "hiveward.run-archive/v1";

export interface BlueprintRunArchive {
  schema: typeof blueprintRunArchiveSchema;
  run: BlueprintRunSummary;
  blueprintSnapshot: BlueprintDefinition;
  nodeRuns: BlueprintNodeRun[];
  events: BlueprintNodeEvent[];
  finalResult: FinalRunResult | null;
  iterationSessions?: IterationSession[];
  iterationRounds?: IterationRound[];
  approvalRequests?: ApprovalRequest[];
  approvalDecisions?: ApprovalDecision[];
  artifacts?: Artifact[];
  releaseReports?: ReleaseReport[];
  agentHumanReports?: AgentHumanReport[];
  agentHandoffs?: AgentHandoff[];
  managerContextSnapshots?: ManagerContextSnapshot[];
  runTimeline?: RunTimelineItem[];
}

export type FinalRunResultState = "available" | "failed" | "waiting_approval" | "empty";

export type FinalRunResultSelectionReason =
  | "explicit_final"
  | "terminal_result"
  | "latest_result";

export interface FinalRunResultCandidate {
  nodeRunId: string;
  blueprintRunId: string;
  blueprintId: string;
  nodeId: string;
  nodeLabel: string;
  nodeType: BlueprintNodeType;
  resultRole: BlueprintNodeResultRole;
  selectionReason: FinalRunResultSelectionReason;
  output: unknown;
  endedAt?: string;
  runtimeRef?: RuntimeObjectRef;
}

export interface FinalRunNodeContext {
  nodeRunId: string;
  blueprintRunId: string;
  blueprintId: string;
  nodeId: string;
  nodeLabel: string;
  nodeType: BlueprintNodeType;
  status: BlueprintNodeRunStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  endedAt?: string;
  runtimeRef?: RuntimeObjectRef;
}

export interface FinalRunResult {
  state: FinalRunResultState;
  candidates: FinalRunResultCandidate[];
  failedNode?: FinalRunNodeContext;
  waitingApprovalNode?: FinalRunNodeContext;
}

const resultProducingNodeTypes = new Set<BlueprintNodeType>([
  "agent",
  "manager",
  "summary"
]);

export function resolveFinalRunResult(
  blueprint: BlueprintDefinition,
  nodeRuns: BlueprintNodeRun[],
  runStatus?: BlueprintRunStatus
): FinalRunResult | null {
  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const indexedCandidates = nodeRuns
    .map((nodeRun, index) => {
      const node = nodesById.get(nodeRun.nodeId);
      return {
        index,
        nodeRun,
        node,
        nodeType: node?.type ?? nodeRun.nodeType,
        resultRole: node?.config.resultRole ?? "auto"
      };
    })
    .filter((candidate) => isSuccessfulResultCandidate(candidate.nodeType, candidate.nodeRun, candidate.resultRole));

  const explicitFinals = indexedCandidates
    .filter((candidate) => candidate.resultRole === "final")
    .filter((candidate, _index, finals) => !hasLaterSameNodeCandidate(candidate, finals));
  const selectedCandidates = explicitFinals.length > 0
    ? explicitFinals.map((candidate) => toFinalRunResultCandidate(candidate, "explicit_final"))
    : resolveAutomaticFinalCandidates(blueprint, indexedCandidates)
        .map(({ candidate, reason }) => toFinalRunResultCandidate(candidate, reason));

  const reversedNodeRuns = [...nodeRuns].reverse();
  const failedNode = runStatus === "succeeded"
    ? undefined
    : reversedNodeRuns.find((nodeRun) => nodeRun.status === "failed") ??
      reversedNodeRuns.find((nodeRun) => nodeRun.status === "cancelled");
  const waitingApprovalNode = [...nodeRuns]
    .reverse()
    .find((nodeRun) => nodeRun.status === "waiting_approval");
  const finalRunState = resolveFinalRunResultState(runStatus, selectedCandidates, failedNode, waitingApprovalNode);

  if (selectedCandidates.length === 0 && !failedNode && !waitingApprovalNode && !shouldReturnEmptyFinalResult(runStatus)) {
    return null;
  }

  return {
    state: finalRunState,
    candidates: selectedCandidates,
    failedNode: failedNode ? toFinalRunNodeContext(failedNode) : undefined,
    waitingApprovalNode: waitingApprovalNode ? toFinalRunNodeContext(waitingApprovalNode) : undefined
  };
}

interface IndexedFinalCandidate {
  index: number;
  nodeRun: BlueprintNodeRun;
  node?: BlueprintNode;
  nodeType: BlueprintNodeType;
  resultRole: BlueprintNodeResultRole;
}

function resolveAutomaticFinalCandidates(
  blueprint: BlueprintDefinition,
  candidates: IndexedFinalCandidate[]
): Array<{ candidate: IndexedFinalCandidate; reason: FinalRunResultSelectionReason }> {
  const automaticCandidates = candidates.filter(
    (candidate) => candidate.resultRole !== "final" && !isManagerInternalAutoCandidate(blueprint, candidate.node)
  );
  const terminalCandidates = automaticCandidates.filter(
    (candidate) =>
      !hasLaterSameNodeCandidate(candidate, automaticCandidates) &&
      !hasLaterDownstreamResultCandidate(blueprint, candidate, automaticCandidates)
  );

  if (terminalCandidates.length > 0) {
    return terminalCandidates.map((candidate) => ({ candidate, reason: "terminal_result" }));
  }

  const latestCandidate = automaticCandidates[automaticCandidates.length - 1];
  return latestCandidate ? [{ candidate: latestCandidate, reason: "latest_result" }] : [];
}

function isSuccessfulResultCandidate(
  nodeType: BlueprintNodeType,
  nodeRun: BlueprintNodeRun,
  resultRole: BlueprintNodeResultRole
): boolean {
  return (
    resultRole !== "ignore" &&
    (resultRole === "final" || resultProducingNodeTypes.has(nodeType)) &&
    nodeRun.status === "succeeded" &&
    nodeRun.output !== undefined
  );
}

function isManagerInternalAutoCandidate(blueprint: BlueprintDefinition, node: BlueprintNode | undefined): boolean {
  if (!node) return false;
  if (node.parentId) return true;

  return blueprint.edges.some((edge) => {
    if (edge.target !== node.id || !edge.sourceHandle?.startsWith(managerOutHandlePrefix)) return false;
    const source = blueprint.nodes.find((candidate) => candidate.id === edge.source);
    return source?.type === "manager";
  });
}

function hasLaterSameNodeCandidate(
  candidate: IndexedFinalCandidate,
  candidates: IndexedFinalCandidate[]
): boolean {
  return candidates.some((item) => item.nodeRun.nodeId === candidate.nodeRun.nodeId && item.index > candidate.index);
}

function hasLaterDownstreamResultCandidate(
  blueprint: BlueprintDefinition,
  candidate: IndexedFinalCandidate,
  candidates: IndexedFinalCandidate[]
): boolean {
  return candidates.some(
    (item) =>
      item.index > candidate.index &&
      item.nodeRun.id !== candidate.nodeRun.id &&
      isDownstreamNode(blueprint, candidate.nodeRun.nodeId, item.nodeRun.nodeId)
  );
}

function isDownstreamNode(blueprint: BlueprintDefinition, sourceNodeId: string, targetNodeId: string): boolean {
  const visited = new Set<string>();
  const queue = blueprint.edges.filter((edge) => edge.source === sourceNodeId).map((edge) => edge.target);

  while (queue.length > 0) {
    const nextNodeId = queue.shift()!;
    if (nextNodeId === targetNodeId) return true;
    if (visited.has(nextNodeId)) continue;

    visited.add(nextNodeId);
    queue.push(...blueprint.edges.filter((edge) => edge.source === nextNodeId).map((edge) => edge.target));
  }

  return false;
}

function toFinalRunResultCandidate(
  candidate: IndexedFinalCandidate,
  selectionReason: FinalRunResultSelectionReason
): FinalRunResultCandidate {
  return {
    nodeRunId: candidate.nodeRun.id,
    blueprintRunId: candidate.nodeRun.blueprintRunId,
    blueprintId: candidate.nodeRun.blueprintId,
    nodeId: candidate.nodeRun.nodeId,
    nodeLabel: candidate.nodeRun.nodeLabel,
    nodeType: candidate.nodeType,
    resultRole: candidate.resultRole,
    selectionReason,
    output: candidate.nodeRun.output,
    endedAt: candidate.nodeRun.endedAt,
    runtimeRef: readBlueprintNodeRunRuntimeRef(candidate.nodeRun)
  };
}

function toFinalRunNodeContext(nodeRun: BlueprintNodeRun): FinalRunNodeContext {
  return {
    nodeRunId: nodeRun.id,
    blueprintRunId: nodeRun.blueprintRunId,
    blueprintId: nodeRun.blueprintId,
    nodeId: nodeRun.nodeId,
    nodeLabel: nodeRun.nodeLabel,
    nodeType: nodeRun.nodeType,
    status: nodeRun.status,
    input: nodeRun.input,
    output: nodeRun.output,
    error: nodeRun.error,
    endedAt: nodeRun.endedAt,
    runtimeRef: readBlueprintNodeRunRuntimeRef(nodeRun)
  };
}

export function readBlueprintNodeRunRuntimeRef(nodeRun: Pick<BlueprintNodeRun, "runtimeRef">): RuntimeObjectRef | undefined {
  return nodeRun.runtimeRef;
}

export function readBlueprintNodeEventRuntimeRef(event: Pick<BlueprintNodeEvent, "runtimeRef">): RuntimeObjectRef | undefined {
  return event.runtimeRef;
}

export function readBlueprintRunRuntimeRefs(run: Pick<BlueprintRun, "runtimeRefs">): RuntimeObjectRef[] {
  return run.runtimeRefs;
}

function resolveFinalRunResultState(
  runStatus: BlueprintRunStatus | undefined,
  candidates: FinalRunResultCandidate[],
  failedNode: BlueprintNodeRun | undefined,
  waitingApprovalNode: BlueprintNodeRun | undefined
): FinalRunResultState {
  if (runStatus === "failed" || runStatus === "cancelled" || failedNode) return "failed";
  if (runStatus === "waiting_approval" || waitingApprovalNode) return "waiting_approval";
  return candidates.length > 0 ? "available" : "empty";
}

function shouldReturnEmptyFinalResult(runStatus: BlueprintRunStatus | undefined): boolean {
  return runStatus === "succeeded" || runStatus === "failed" || runStatus === "cancelled" || runStatus === "waiting_approval";
}

export function createStarterBlueprint(now: string, companyId = "company-hiveward-studio"): BlueprintDefinition {
  return {
    id: "starter-blueprint",
    companyId,
    name: "Multi-agent delivery review",
    description:
      "A governed Hiveward blueprint for requirements, architecture, test review, approval, and delivery through full agent harnesses.",
    version: 1,
    nodes: [
      {
        id: "requirements",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 80, y: 120 },
        config: {
          label: "Requirements Agent",
          openclawAgentId: "main",
          agentName: "requirements-analyst",
          prompt: "Analyze the requested change and produce crisp acceptance criteria.",
          tools: ["repo.search"]
        }
      },
      {
        id: "architecture",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 420, y: 36 },
        config: {
          label: "Architecture Agent",
          openclawAgentId: "main",
          agentName: "architect",
          prompt: "Check boundaries, data ownership, and integration shape.",
          tools: ["repo.search"]
        }
      },
      {
        id: "tests",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 420, y: 220 },
        config: {
          label: "Test Agent",
          openclawAgentId: "main",
          agentName: "test-engineer",
          prompt: "Define verification that proves behavior without coupling to runtime internals.",
          tools: ["repo.test"]
        }
      },
      {
        id: "summary",
        type: "summary",
        position: { x: 760, y: 132 },
        config: {
          label: "Merge Summary",
          mode: "structured_merge",
          description: "Merge upstream node outputs for review."
        }
      },
      {
        id: "delivery",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 1100, y: 132 },
        config: {
          label: "Delivery Agent",
          openclawAgentId: "main",
          agentName: "delivery-agent",
          prompt: "Prepare the approved delivery note from the merged summary.",
          approval: {
            enabled: true
          },
          send: {
            enabled: true,
            channelId: "slack",
            target: "#engineering",
            bodyTemplate: "Blueprint {{blueprint.name}} completed. Summary: {{summary}}"
          },
          tools: []
        }
      }
    ],
    edges: [
      { id: "e1", source: "requirements", target: "architecture", condition: "success" },
      { id: "e2", source: "requirements", target: "tests", condition: "success" },
      { id: "e3", source: "architecture", target: "summary", condition: "success" },
      { id: "e4", source: "tests", target: "summary", condition: "success" },
      { id: "e5", source: "summary", target: "delivery", condition: "success" }
    ],
    variables: {},
    display: {
      viewport: { x: 0, y: 0, zoom: 0.82 }
    },
    createdAt: now,
    updatedAt: now
  };
}

export function createRealThreeAgentBlueprint(now: string, companyId = "company-hiveward-studio"): BlueprintDefinition {
  return {
    id: "real-three-agent-blueprint",
    companyId,
    name: "Real 3-node OpenClaw agent chain",
    description:
      "A minimal executable Hiveward blueprint that calls the real OpenClaw agent configured as main. Each node receives upstream output from the previous node.",
    version: 1,
    nodes: [
      {
        id: "brief",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 120, y: 180 },
        config: {
          label: "1. Brief",
          openclawAgentId: "main",
          agentName: "main",
          prompt:
            "Summarize the user request in JSON with goal, constraints, and acceptance criteria. Keep it concise.",
          tools: []
        }
      },
      {
        id: "plan",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 500, y: 180 },
        config: {
          label: "2. Plan",
          openclawAgentId: "main",
          agentName: "main",
          prompt:
            "Using the upstream brief, propose exactly three implementation steps and one verification command. Return JSON.",
          tools: []
        }
      },
      {
        id: "verify",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 880, y: 180 },
        config: {
          label: "3. Verify",
          openclawAgentId: "main",
          agentName: "main",
          prompt:
            "Review the upstream plan. Return JSON with verified boolean, risks array, and final recommendation.",
          tools: []
        }
      }
    ],
    edges: [
      { id: "real-e1", source: "brief", target: "plan", condition: "success" },
      { id: "real-e2", source: "plan", target: "verify", condition: "success" }
    ],
    variables: {},
    display: {
      viewport: { x: 0, y: 0, zoom: 0.95 }
    },
    createdAt: now,
    updatedAt: now
  };
}

export function createMultiAgentCompatibilityBlueprint(
  now: string,
  companyId = "company-hiveward-studio",
  workingDirectory = ""
): BlueprintDefinition {
  const workspaceConfig = workingDirectory ? { workingDirectory } : {};

  return {
    id: "multi-agent-compatibility-blueprint",
    companyId,
    name: "Multi-agent compatibility smoke test",
    description:
      "A focused blueprint that validates OpenClaw, Codex, and Claude Code agent nodes through one shared upstream payload and one merged result.",
    version: 1,
    nodes: [
      {
        id: "compat-openclaw-brief",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 80, y: 180 },
        config: {
          label: "1. OpenClaw Brief",
          openclawAgentId: "main",
          agentName: "openclaw-compat-brief",
          prompt:
            "Create a concise JSON compatibility brief for this Hiveward blueprint. Return only JSON with keys: goal, inputContract, expectedNodeTypes, passCriteria.",
          tools: []
        }
      },
      {
        id: "compat-codex-check",
        type: "agent",
        runtimeId: "codex",
        position: { x: 480, y: 64 },
        config: {
          label: "2A. Codex Check",
          agentName: "codex-compat-check",
          prompt:
            "Read the upstream compatibility brief. Return only JSON with keys: runtime, upstreamReceived, contractAccepted, notes. runtime must be codex.",
          permissionProfile: "read_only",
          timeoutMs: 3600000,
          outputSchema: {
            type: "object",
            required: ["runtime", "upstreamReceived", "contractAccepted", "notes"],
            properties: {
              runtime: { type: "string" },
              upstreamReceived: { type: "boolean" },
              contractAccepted: { type: "boolean" },
              notes: { type: "array", items: { type: "string" } }
            }
          },
          ...workspaceConfig,
          tools: []
        }
      },
      {
        id: "compat-claude-check",
        type: "agent",
        runtimeId: "claude",
        position: { x: 480, y: 296 },
        config: {
          label: "2B. Claude Code Check",
          agentName: "claude-code-compat-check",
          prompt:
            "Read the upstream compatibility brief. Return only JSON with keys: runtime, upstreamReceived, contractAccepted, notes. runtime must be claude_code.",
          permissionProfile: "read_only",
          timeoutMs: 3600000,
          outputSchema: {
            type: "object",
            required: ["runtime", "upstreamReceived", "contractAccepted", "notes"],
            properties: {
              runtime: { type: "string" },
              upstreamReceived: { type: "boolean" },
              contractAccepted: { type: "boolean" },
              notes: { type: "array", items: { type: "string" } }
            }
          },
          ...workspaceConfig,
          tools: []
        }
      },
      {
        id: "compat-merge",
        type: "summary",
        position: { x: 880, y: 180 },
        config: {
          label: "3. Merge Compatibility Results",
          mode: "structured_merge",
          description: "Merge the Codex and Claude Code compatibility outputs."
        }
      },
      {
        id: "compat-openclaw-verify",
        type: "agent",
        runtimeId: "openclaw",
        position: { x: 1240, y: 180 },
        config: {
          label: "4. OpenClaw Verify",
          openclawAgentId: "main",
          agentName: "openclaw-compat-verifier",
          prompt:
            "Inspect the merged upstream outputs. Return only JSON with keys: passed, checkedRuntimes, missingRuntimes, recommendation.",
          tools: []
        }
      }
    ],
    edges: [
      { id: "compat-e1", source: "compat-openclaw-brief", target: "compat-codex-check", condition: "success" },
      { id: "compat-e2", source: "compat-openclaw-brief", target: "compat-claude-check", condition: "success" },
      { id: "compat-e3", source: "compat-codex-check", target: "compat-merge", condition: "success" },
      { id: "compat-e4", source: "compat-claude-check", target: "compat-merge", condition: "success" },
      { id: "compat-e5", source: "compat-merge", target: "compat-openclaw-verify", condition: "success" }
    ],
    variables: {},
    display: {
      viewport: { x: 0, y: 0, zoom: 0.78 }
    },
    createdAt: now,
    updatedAt: now
  };
}

export function createManagerDrivenHtmlBlueprint(now: string, companyId = "company-hiveward-studio"): BlueprintDefinition {
  return {
    id: "manager-driven-html-blueprint",
    companyId,
    name: "Manager-driven HTML delivery",
    description:
      "A manager coordinates two blueprint slots: news research plus an HTML execution document, then standalone HTML implementation.",
    version: 1,
    nodes: [
      {
        id: "html-manager",
        type: "manager",
        runtimeId: "openclaw",
        position: { x: 80, y: 420 },
        config: {
          label: "HTML Delivery Manager",
          dispatchMode: "self_dispatch",
          portCount: 2,
          maxHandoffs: 8,
          openclawAgentId: "main",
          agentName: "html-delivery-manager",
          timeoutMs: 3600000,
          tools: [],
          instructions:
            "先运行 Slot 1。Slot 1 中，Agent 1 收集具体新闻简报，Agent 2 把新闻简报整理成可执行的 HTML 页面制作说明。然后把 Slot 1 的输出交给 Slot 2。Slot 2 中，Agent 1 根据制作说明写出完整、可直接运行的独立 HTML 页面。Slot 2 完成后即可结束流程。"
        }
      },
      {
        id: "html-manager-slot-1",
        type: "manager_slot",
        position: { x: 480, y: 40 },
        size: { width: 760, height: 380 },
        config: {
          label: "Slot 1",
          managerNodeId: "html-manager",
          slot: 1
        }
      },
      {
        id: "html-manager-slot-1-agent-1",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "html-manager-slot-1",
        position: { x: 76, y: 154 },
        config: {
          label: "1. News Research",
          resultRole: "ignore",
          openclawAgentId: "main",
          agentName: "news-researcher",
          prompt:
            "为后续 HTML 页面收集一份具体新闻简报。根据管理器输入判断主题、受众、地区、时间范围和最终页面目标；如果输入没有指定主题，默认选择面向构建者和运营者的 AI agent 生产力新闻。不要向用户追问，不要留下占位符。请用清晰的中文结构输出，包含：主题、受众、时间范围、来源状态、3 到 5 条可直接用于页面创作的新闻要点、每条新闻为什么重要、适合页面呈现的角度、来源线索、页面核心主张和内容风险。",
          tools: []
        }
      },
      {
        id: "html-manager-slot-1-agent-2",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "html-manager-slot-1",
        position: { x: 424, y: 154 },
        config: {
          label: "2. HTML Execution Doc",
          resultRole: "ignore",
          openclawAgentId: "main",
          agentName: "execution-doc-writer",
          prompt:
            "使用上游新闻简报，写一份可直接交给 HTML 构建者执行的生产说明。不要要求更多上下文，不要出现 [fill in]、lorem ipsum、占位 logo、占位评价或未解决的 placeholder 文本。缺少细节时，请做具体、保守的编辑判断，并在假设中说明。请用中文写成清晰的制作文档，包含：页面标题、核心主张、分区结构、每个区块的真实标题和文案方向、CTA 文案、视觉约束、响应式要求、必须呈现的新闻事实、验收标准和假设。完成后自然交给下一个槽位继续制作页面，不需要输出 JSON。",
          tools: []
        }
      },
      {
        id: "html-manager-slot-2",
        type: "manager_slot",
        position: { x: 480, y: 460 },
        size: { width: 760, height: 320 },
        config: {
          label: "Slot 2",
          managerNodeId: "html-manager",
          slot: 2
        }
      },
      {
        id: "html-manager-slot-2-agent-1",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "html-manager-slot-2",
        position: { x: 264, y: 132 },
        config: {
          label: "3. HTML Builder",
          resultRole: "final",
          openclawAgentId: "main",
          agentName: "html-code-builder",
          prompt:
            "根据管理器 previousResults 中的 Slot 1 制作说明，写出一个完整的独立 HTML 文档，包含 inline CSS 和必要的 inline JavaScript。最终输出应当是可直接在浏览器运行的 HTML，不要包含 [fill in]、lorem ipsum、占位 logo、占位评价或泛泛的括号占位文案。保留新闻驱动的页面主张、真实标题、CTA 文案和制作说明中的具体内容。不需要包成 JSON。",
          tools: []
        }
      },
    ],
    edges: [
      {
        id: "html-manager-to-slot-1",
        source: "html-manager",
        sourceHandle: "manager-out-1",
        target: "html-manager-slot-1",
        targetHandle: "manager-slot-in",
        condition: "success"
      },
      {
        id: "html-slot-1-to-manager",
        source: "html-manager-slot-1",
        sourceHandle: "manager-slot-out",
        target: "html-manager",
        targetHandle: "manager-in-1",
        condition: "success"
      },
      {
        id: "html-manager-to-slot-2",
        source: "html-manager",
        sourceHandle: "manager-out-2",
        target: "html-manager-slot-2",
        targetHandle: "manager-slot-in",
        condition: "success"
      },
      {
        id: "html-slot-2-to-manager",
        source: "html-manager-slot-2",
        sourceHandle: "manager-slot-out",
        target: "html-manager",
        targetHandle: "manager-in-2",
        condition: "success"
      },
      {
        id: "html-slot-1-start",
        source: "html-manager-slot-1",
        sourceHandle: "manager-slot-inner-out",
        target: "html-manager-slot-1-agent-1",
        condition: "success"
      },
      {
        id: "html-slot-1-write-doc",
        source: "html-manager-slot-1-agent-1",
        target: "html-manager-slot-1-agent-2",
        condition: "success"
      },
      {
        id: "html-slot-1-finish",
        source: "html-manager-slot-1-agent-2",
        target: "html-manager-slot-1",
        targetHandle: "manager-slot-inner-in",
        condition: "success"
      },
      {
        id: "html-slot-2-start",
        source: "html-manager-slot-2",
        sourceHandle: "manager-slot-inner-out",
        target: "html-manager-slot-2-agent-1",
        condition: "success"
      },
      {
        id: "html-slot-2-finish",
        source: "html-manager-slot-2-agent-1",
        target: "html-manager-slot-2",
        targetHandle: "manager-slot-inner-in",
        condition: "success"
      }
    ],
    variables: {},
    display: {
      viewport: { x: 18, y: 22, zoom: 0.74 }
    },
    createdAt: now,
    updatedAt: now
  };
}

export function createActiveManagerNewsHtmlChaosBlueprint(
  now: string,
  companyId = "company-hiveward-studio"
): BlueprintDefinition {
  return {
    id: "active-manager-news-html-chaos-blueprint",
    companyId,
    name: "主动分发 Manager 测试机：乱序新闻 HTML",
    description:
      "一个中文压力测试蓝图：端口顺序被故意打乱，manager 必须先读下属职责，再主动把新闻研究、制作说明、HTML 构建和 QA 返工串起来。",
    version: 1,
    nodes: [
      {
        id: "chaos-manager",
        type: "manager",
        runtimeId: "openclaw",
        position: { x: 80, y: 380 },
        config: {
          label: "主动分发 Manager",
          description: "读取下属职责清单，主动选择下一个 slot，而不是按端口顺序执行。",
          portCount: 4,
          maxHandoffs: 10,
          openclawAgentId: "main",
          agentName: "active-dispatch-manager",
          dispatchMode: "self_dispatch",
          timeoutMs: 3600000,
          tools: [],
          instructions:
            [
              "你是 Hiveward 的公司架构 manager。你的任务不是自己写新闻或 HTML，而是根据 delegationRoster 选择应该委派给哪个 slot。",
              "这个蓝图故意把端口顺序打乱：Slot 1 是最终 HTML 构建，Slot 2 是 QA，Slot 3 是新闻研究，Slot 4 是制作说明。",
              "不要机械按 1、2、3、4 执行。你必须先让新闻研究完成，再让制作说明完成，再让 HTML 构建完成，最后让 QA 检查。",
              "如果 QA 输出指出需要返工，优先回到 Slot 1 修复 HTML；如果 QA 输出已经通过或 status 为 complete/completed/pass，则结束流程。",
              "每次只选择一个 slot。只返回 JSON，不要返回 markdown。",
              "可用输出格式：{\"status\":\"continue\",\"nextSlot\":3,\"reason\":\"先收集新闻事实\"} 或 {\"status\":\"complete\",\"reason\":\"QA 已通过\"}。"
            ].join("\n")
        }
      },
      {
        id: "chaos-slot-build",
        type: "manager_slot",
        position: { x: 520, y: 454 },
        size: { width: 640, height: 320 },
        config: {
          label: "Slot 1 - HTML 构建（乱序放在最前）",
          description: "根据新闻简报和制作说明生成最终独立 HTML；若 QA 要求返工，则修复 HTML。",
          managerNodeId: "chaos-manager",
          slot: 1
        }
      },
      {
        id: "chaos-html-builder",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "chaos-slot-build",
        position: { x: 154, y: 142 },
        config: {
          label: "HTML 构建 Agent",
          resultRole: "final",
          openclawAgentId: "main",
          agentName: "html-builder",
          description: "把已核定的新闻研究和制作说明转成完整可运行的单文件 HTML。",
          prompt:
            [
              "你是 HTML 构建 Agent。请根据 manager previousResults 中的新闻研究和制作说明输出完整、可直接保存运行的单文件 HTML。",
              "必须包含 inline CSS 和必要的 inline JavaScript，不要使用外部依赖，不要输出 markdown 代码围栏。",
              "页面主题聚焦“AI agent 和多 agent 工作流进入企业运营”。",
              "验收硬要求：包含 hero、新闻要点、时间线、影响分析、执行建议、source-index 来源索引、risk-notes 风险提示、移动端响应式样式。",
              "如果 previousResults 中有 QA 返工意见，必须逐条修复；否则先产出完整首版。",
              "最终输出必须以 <!doctype html> 开头。"
            ].join("\n"),
          tools: []
        }
      },
      {
        id: "chaos-slot-qa",
        type: "manager_slot",
        position: { x: 1220, y: 454 },
        size: { width: 640, height: 320 },
        config: {
          label: "Slot 2 - QA 检查",
          description: "严格检查最终 HTML，必要时要求回到 Slot 1 返工。",
          managerNodeId: "chaos-manager",
          slot: 2
        }
      },
      {
        id: "chaos-qa-reviewer",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "chaos-slot-qa",
        position: { x: 154, y: 142 },
        config: {
          label: "QA 审查 Agent",
          resultRole: "ignore",
          openclawAgentId: "main",
          agentName: "html-qa-reviewer",
          description: "检查 HTML 是否满足新闻事实、结构、风险提示、来源索引和移动端要求。",
          prompt:
            [
              "你是 QA 审查 Agent。请检查上游 HTML 是否满足验收要求：",
              "1. 以 <!doctype html> 开头；2. 包含 hero、新闻要点、时间线、影响分析、执行建议；",
              "3. 包含 id=\"source-index\" 的来源索引；4. 包含 id=\"risk-notes\" 的风险提示；5. 有移动端响应式 CSS。",
              "如果不通过，返回严格 JSON：{\"status\":\"fail\",\"returnToSlot\":1,\"reason\":\"...\",\"fixes\":[\"...\"]}。",
              "如果通过，返回严格 JSON：{\"status\":\"complete\",\"reason\":\"HTML 已满足测试机验收\",\"deliveryReady\":true}。",
              "不要返回 markdown。"
            ].join("\n"),
          tools: []
        }
      },
      {
        id: "chaos-slot-research",
        type: "manager_slot",
        position: { x: 520, y: 58 },
        size: { width: 640, height: 320 },
        config: {
          label: "Slot 3 - 新闻研究",
          description: "先收集中文新闻简报和可核验线索，这是后续制作说明和 HTML 的事实基础。",
          managerNodeId: "chaos-manager",
          slot: 3
        }
      },
      {
        id: "chaos-news-researcher",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "chaos-slot-research",
        position: { x: 154, y: 142 },
        config: {
          label: "新闻研究 Agent",
          resultRole: "ignore",
          openclawAgentId: "main",
          agentName: "news-researcher-cn",
          description: "收集 AI agent、多 agent 工作流、企业运营自动化相关的中文新闻简报。",
          prompt:
            [
              "你是中文新闻研究 Agent。请为后续 HTML 页面收集一份新闻简报。",
              "如果运行器具备联网或检索能力，优先检索最近的真实新闻；如果不能联网，请明确写出“未联网核验”，并给出可核验的来源线索，不要伪造具体链接。",
              "输出必须包含：主题、受众、时间范围、5 条新闻/趋势线索、每条为什么重要、页面呈现角度、来源线索、事实风险。",
              "请用中文结构化输出，不要输出 JSON。"
            ].join("\n"),
          tools: []
        }
      },
      {
        id: "chaos-slot-spec",
        type: "manager_slot",
        position: { x: 1220, y: 58 },
        size: { width: 640, height: 320 },
        config: {
          label: "Slot 4 - HTML 制作说明",
          description: "把新闻研究整理成可交付给 HTML 构建 Agent 的生产说明。",
          managerNodeId: "chaos-manager",
          slot: 4
        }
      },
      {
        id: "chaos-execution-doc",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "chaos-slot-spec",
        position: { x: 154, y: 142 },
        config: {
          label: "制作说明 Agent",
          resultRole: "ignore",
          openclawAgentId: "main",
          agentName: "html-execution-doc-writer",
          description: "把新闻简报转成完整 HTML 生产说明、信息架构和验收清单。",
          prompt:
            [
              "你是 HTML 制作说明 Agent。请把上游新闻研究整理成可直接交给 HTML 构建 Agent 的生产说明。",
              "必须包含：页面标题、核心主张、目标读者、信息架构、每个区块的真实文案方向、视觉约束、互动要求、来源索引要求、风险提示要求、移动端验收标准。",
              "请明确要求最终 HTML 包含 source-index 和 risk-notes。",
              "不要要求更多上下文，不要使用 placeholder。请用中文输出制作文档，不要输出 JSON。"
            ].join("\n"),
          tools: []
        }
      }
    ],
    edges: [
      { id: "chaos-manager-to-build", source: "chaos-manager", sourceHandle: "manager-out-1", target: "chaos-slot-build", targetHandle: "manager-slot-in", condition: "success" },
      { id: "chaos-build-to-manager", source: "chaos-slot-build", sourceHandle: "manager-slot-out", target: "chaos-manager", targetHandle: "manager-in-1", condition: "success" },
      { id: "chaos-manager-to-qa", source: "chaos-manager", sourceHandle: "manager-out-2", target: "chaos-slot-qa", targetHandle: "manager-slot-in", condition: "success" },
      { id: "chaos-qa-to-manager", source: "chaos-slot-qa", sourceHandle: "manager-slot-out", target: "chaos-manager", targetHandle: "manager-in-2", condition: "success" },
      { id: "chaos-manager-to-research", source: "chaos-manager", sourceHandle: "manager-out-3", target: "chaos-slot-research", targetHandle: "manager-slot-in", condition: "success" },
      { id: "chaos-research-to-manager", source: "chaos-slot-research", sourceHandle: "manager-slot-out", target: "chaos-manager", targetHandle: "manager-in-3", condition: "success" },
      { id: "chaos-manager-to-spec", source: "chaos-manager", sourceHandle: "manager-out-4", target: "chaos-slot-spec", targetHandle: "manager-slot-in", condition: "success" },
      { id: "chaos-spec-to-manager", source: "chaos-slot-spec", sourceHandle: "manager-slot-out", target: "chaos-manager", targetHandle: "manager-in-4", condition: "success" },
      { id: "chaos-build-start", source: "chaos-slot-build", sourceHandle: "manager-slot-inner-out", target: "chaos-html-builder", condition: "success" },
      { id: "chaos-build-finish", source: "chaos-html-builder", target: "chaos-slot-build", targetHandle: "manager-slot-inner-in", condition: "success" },
      { id: "chaos-qa-start", source: "chaos-slot-qa", sourceHandle: "manager-slot-inner-out", target: "chaos-qa-reviewer", condition: "success" },
      { id: "chaos-qa-finish", source: "chaos-qa-reviewer", target: "chaos-slot-qa", targetHandle: "manager-slot-inner-in", condition: "success" },
      { id: "chaos-research-start", source: "chaos-slot-research", sourceHandle: "manager-slot-inner-out", target: "chaos-news-researcher", condition: "success" },
      { id: "chaos-research-finish", source: "chaos-news-researcher", target: "chaos-slot-research", targetHandle: "manager-slot-inner-in", condition: "success" },
      { id: "chaos-spec-start", source: "chaos-slot-spec", sourceHandle: "manager-slot-inner-out", target: "chaos-execution-doc", condition: "success" },
      { id: "chaos-spec-finish", source: "chaos-execution-doc", target: "chaos-slot-spec", targetHandle: "manager-slot-inner-in", condition: "success" }
    ],
    variables: {},
    display: {
      viewport: { x: -18, y: 14, zoom: 0.62 }
    },
    createdAt: now,
    updatedAt: now
  };
}

export function createActiveManagerRemotionVideoChaosBlueprint(
  now: string,
  companyId = "company-hiveward-studio"
): BlueprintDefinition {
  return {
    id: "active-manager-remotion-video-chaos-blueprint",
    companyId,
    name: "主动分发 Manager 测试机：乱序 Remotion 视频",
    description:
      "一个中文 Remotion 视频生产测试蓝图：端口顺序被故意打乱，manager 必须主动安排研究、脚本、技术规划、Remotion 构建和严格 QA，并在不合格时回退返工。",
    version: 1,
    nodes: [
      {
        id: "remotion-manager",
        type: "manager",
        runtimeId: "openclaw",
        position: { x: 80, y: 420 },
        config: {
          label: "Remotion 主动分发 Manager",
          description: "读取 Remotion 视频团队职责，主动选择下一步，并根据 QA 结果回退返工。",
          portCount: 5,
          maxHandoffs: 14,
          openclawAgentId: "main",
          agentName: "remotion-dispatch-manager",
          dispatchMode: "self_dispatch",
          timeoutMs: 3600000,
          tools: [],
          instructions:
            [
              "你是 Hiveward 的 Remotion 视频制作 manager。你只负责选择下一步委派，不要自己写完整代码或审查报告。",
              "这个蓝图故意打乱端口顺序：Slot 1 是 Remotion 构建，Slot 2 是严格 QA，Slot 3 是新闻/主题研究，Slot 4 是视频脚本与分镜，Slot 5 是 Remotion 技术规划。",
              "正确基础路线应该是 Slot 3 -> Slot 4 -> Slot 5 -> Slot 1 -> Slot 2。",
              "如果 QA 输出 status 为 fail、needs_revision、retry、rework，或包含 returnToSlot/nextSlot，则优先按 QA 意见回退，通常回到 Slot 1 修复 Remotion 代码。",
              "如果 QA 输出 status 为 complete/completed/pass/approved，或者明确 deliveryReady 为 true，则结束流程。",
              "每次只选择一个 slot。只返回 JSON，不要返回 markdown。",
              "示例：{\"status\":\"continue\",\"nextSlot\":3,\"reason\":\"先收集视频主题事实\"} 或 {\"status\":\"complete\",\"reason\":\"QA 已通过\"}。"
            ].join("\n")
        }
      },
      {
        id: "remotion-slot-build",
        type: "manager_slot",
        position: { x: 520, y: 490 },
        size: { width: 680, height: 340 },
        config: {
          label: "Slot 1 - Remotion 构建（故意放在最前）",
          description: "根据研究、分镜和技术规划产出 Remotion Composition 源码包；QA 不通过时负责返工。",
          managerNodeId: "remotion-manager",
          slot: 1
        }
      },
      {
        id: "remotion-code-builder",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "remotion-slot-build",
        position: { x: 142, y: 152 },
        config: {
          label: "Remotion 构建 Agent",
          resultRole: "final",
          openclawAgentId: "main",
          agentName: "remotion-code-builder",
          description: "产出可落地的 Remotion React Composition 源码包，并按 QA 意见返工。",
          prompt:
            [
              "你是 Remotion 构建 Agent。请根据 previousResults 中的研究、脚本分镜和技术规划，输出 Remotion 源码包，不要输出 HTML 页面。",
              "输出必须包含文件路径和代码内容，至少包括：src/Root.tsx、src/AgentOpsBrief.tsx、src/remotion-data.ts、package.json 依赖片段或运行命令。",
              "Composition 要求：id 为 AgentOpsBriefVideo，1920x1080，30fps，12 到 18 秒，总帧数明确，使用 React + Remotion API。",
              "必须使用 Remotion 的 Composition、AbsoluteFill、Sequence、interpolate 或 spring 中的至少两类；画面要有 4 个以上镜头/段落。",
              "视频主题：AI agent 和多 agent 工作流进入企业运营。必须包含中文标题、3 个事实/趋势点、风险提示、结尾行动建议。",
              "视觉要求：不是网页落地页，不要生成 <!doctype html>，不要依赖 Tailwind；使用内联 style 或组件内样式。",
              "如果 previousResults 中有 QA 返工意见，必须先列出修复摘要，再输出修复后的完整源码包。",
              "最终输出应能让开发者复制到 Remotion 项目中运行 npx remotion studio 预览。"
            ].join("\n"),
          tools: []
        }
      },
      {
        id: "remotion-slot-qa",
        type: "manager_slot",
        position: { x: 1260, y: 490 },
        size: { width: 680, height: 340 },
        config: {
          label: "Slot 2 - 严格 Remotion QA",
          description: "严格审查 Remotion 源码包，失败时要求 manager 回退到 Slot 1。",
          managerNodeId: "remotion-manager",
          slot: 2
        }
      },
      {
        id: "remotion-qa-reviewer",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "remotion-slot-qa",
        position: { x: 142, y: 152 },
        config: {
          label: "Remotion QA Agent",
          resultRole: "ignore",
          openclawAgentId: "main",
          agentName: "remotion-qa-reviewer",
          description: "检查 Remotion 产物是否真的可运行、符合镜头/时长/组件/API/非 HTML 要求。",
          prompt:
            [
              "你是严格 Remotion QA Agent。请审查上游 Remotion 源码包。",
              "必须检查：1. 不是 HTML 页面；2. 包含 src/Root.tsx 和 Composition；3. Composition id 为 AgentOpsBriefVideo；4. 1920x1080、30fps、12-18 秒；",
              "5. 使用 AbsoluteFill 和 Sequence；6. 使用 interpolate 或 spring；7. 至少 4 个镜头/段落；8. 有中文标题、趋势点、风险提示、行动建议；",
              "9. 没有 lorem ipsum、placeholder、外部不可控图片依赖；10. 给出 npx remotion studio 或 still 的验证命令。",
              "如果不通过，返回严格 JSON：{\"status\":\"fail\",\"returnToSlot\":1,\"reason\":\"...\",\"fixes\":[\"...\"]}。",
              "如果通过，返回严格 JSON：{\"status\":\"complete\",\"reason\":\"Remotion 产物已通过严格审查\",\"deliveryReady\":true}。",
              "不要返回 markdown。"
            ].join("\n"),
          tools: []
        }
      },
      {
        id: "remotion-slot-research",
        type: "manager_slot",
        position: { x: 520, y: 58 },
        size: { width: 680, height: 340 },
        config: {
          label: "Slot 3 - 视频主题研究",
          description: "先收集适合视频表达的 AI agent 企业运营主题事实、趋势和风险线索。",
          managerNodeId: "remotion-manager",
          slot: 3
        }
      },
      {
        id: "remotion-researcher",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "remotion-slot-research",
        position: { x: 142, y: 152 },
        config: {
          label: "视频研究 Agent",
          resultRole: "ignore",
          openclawAgentId: "main",
          agentName: "remotion-video-researcher",
          description: "为 Remotion 视频收集中文主题事实、叙事角度、风险和素材线索。",
          prompt:
            [
              "你是中文视频研究 Agent。请为一个 12-18 秒 Remotion 短视频收集主题材料。",
              "主题聚焦 AI agent、多 agent 协同和企业运营自动化。若不能联网，请明确写出未联网核验，并给出可核验的来源方向，不要伪造具体链接。",
              "输出必须包含：视频目标受众、核心观点、3-5 个事实/趋势点、每个点的画面隐喻、风险提示、可视化素材建议、不可声称的内容。",
              "用中文结构化输出，不要输出 JSON。"
            ].join("\n"),
          tools: []
        }
      },
      {
        id: "remotion-slot-storyboard",
        type: "manager_slot",
        position: { x: 1260, y: 58 },
        size: { width: 680, height: 340 },
        config: {
          label: "Slot 4 - 视频脚本与分镜",
          description: "把研究材料变成可执行的 Remotion 分镜、旁白和节奏表。",
          managerNodeId: "remotion-manager",
          slot: 4
        }
      },
      {
        id: "remotion-storyboard-writer",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "remotion-slot-storyboard",
        position: { x: 142, y: 152 },
        config: {
          label: "脚本分镜 Agent",
          resultRole: "ignore",
          openclawAgentId: "main",
          agentName: "remotion-storyboard-writer",
          description: "写出 12-18 秒短视频的镜头表、字幕、动效节奏和画面重点。",
          prompt:
            [
              "你是视频脚本与分镜 Agent。请基于上游研究输出一个 Remotion 可执行分镜。",
              "必须包含：总时长、fps、镜头序列、每个镜头的帧范围、画面构图、字幕文本、动效建议、色彩/字体建议、转场节奏。",
              "至少 4 个镜头，不能写成网页结构。字幕必须是中文，文案要短而有节奏。",
              "请给 Remotion 构建 Agent 明确的 props/data 结构建议。不要输出 JSON。"
            ].join("\n"),
          tools: []
        }
      },
      {
        id: "remotion-slot-tech-plan",
        type: "manager_slot",
        position: { x: 2000, y: 58 },
        size: { width: 680, height: 340 },
        config: {
          label: "Slot 5 - Remotion 技术规划",
          description: "把分镜翻译成 Remotion 组件结构、时序、动画 API 和验收命令。",
          managerNodeId: "remotion-manager",
          slot: 5
        }
      },
      {
        id: "remotion-tech-planner",
        type: "agent",
        runtimeId: "openclaw",
        parentId: "remotion-slot-tech-plan",
        position: { x: 142, y: 152 },
        config: {
          label: "Remotion 技术规划 Agent",
          resultRole: "ignore",
          openclawAgentId: "main",
          agentName: "remotion-tech-planner",
          description: "设计 Remotion 文件结构、Composition 元数据、Sequence 时序和动画实现约束。",
          prompt:
            [
              "你是 Remotion 技术规划 Agent。请把上游分镜转成 Remotion 实现计划。",
              "必须明确：文件结构、Composition id、width、height、fps、durationInFrames、props/data shape、每个 Sequence 的 from/durationInFrames。",
              "必须要求使用 AbsoluteFill、Sequence、interpolate 或 spring；避免 Tailwind 和外部图片依赖。",
              "必须给出 QA 可执行的检查点和建议命令：npx remotion studio、npx remotion still AgentOpsBriefVideo --frame=30 --scale=0.25。",
              "用中文输出技术规划，不要输出 JSON。"
            ].join("\n"),
          tools: []
        }
      }
    ],
    edges: [
      { id: "remotion-manager-to-build", source: "remotion-manager", sourceHandle: "manager-out-1", target: "remotion-slot-build", targetHandle: "manager-slot-in", condition: "success" },
      { id: "remotion-build-to-manager", source: "remotion-slot-build", sourceHandle: "manager-slot-out", target: "remotion-manager", targetHandle: "manager-in-1", condition: "success" },
      { id: "remotion-manager-to-qa", source: "remotion-manager", sourceHandle: "manager-out-2", target: "remotion-slot-qa", targetHandle: "manager-slot-in", condition: "success" },
      { id: "remotion-qa-to-manager", source: "remotion-slot-qa", sourceHandle: "manager-slot-out", target: "remotion-manager", targetHandle: "manager-in-2", condition: "success" },
      { id: "remotion-manager-to-research", source: "remotion-manager", sourceHandle: "manager-out-3", target: "remotion-slot-research", targetHandle: "manager-slot-in", condition: "success" },
      { id: "remotion-research-to-manager", source: "remotion-slot-research", sourceHandle: "manager-slot-out", target: "remotion-manager", targetHandle: "manager-in-3", condition: "success" },
      { id: "remotion-manager-to-storyboard", source: "remotion-manager", sourceHandle: "manager-out-4", target: "remotion-slot-storyboard", targetHandle: "manager-slot-in", condition: "success" },
      { id: "remotion-storyboard-to-manager", source: "remotion-slot-storyboard", sourceHandle: "manager-slot-out", target: "remotion-manager", targetHandle: "manager-in-4", condition: "success" },
      { id: "remotion-manager-to-tech-plan", source: "remotion-manager", sourceHandle: "manager-out-5", target: "remotion-slot-tech-plan", targetHandle: "manager-slot-in", condition: "success" },
      { id: "remotion-tech-plan-to-manager", source: "remotion-slot-tech-plan", sourceHandle: "manager-slot-out", target: "remotion-manager", targetHandle: "manager-in-5", condition: "success" },
      { id: "remotion-build-start", source: "remotion-slot-build", sourceHandle: "manager-slot-inner-out", target: "remotion-code-builder", condition: "success" },
      { id: "remotion-build-finish", source: "remotion-code-builder", target: "remotion-slot-build", targetHandle: "manager-slot-inner-in", condition: "success" },
      { id: "remotion-qa-start", source: "remotion-slot-qa", sourceHandle: "manager-slot-inner-out", target: "remotion-qa-reviewer", condition: "success" },
      { id: "remotion-qa-finish", source: "remotion-qa-reviewer", target: "remotion-slot-qa", targetHandle: "manager-slot-inner-in", condition: "success" },
      { id: "remotion-research-start", source: "remotion-slot-research", sourceHandle: "manager-slot-inner-out", target: "remotion-researcher", condition: "success" },
      { id: "remotion-research-finish", source: "remotion-researcher", target: "remotion-slot-research", targetHandle: "manager-slot-inner-in", condition: "success" },
      { id: "remotion-storyboard-start", source: "remotion-slot-storyboard", sourceHandle: "manager-slot-inner-out", target: "remotion-storyboard-writer", condition: "success" },
      { id: "remotion-storyboard-finish", source: "remotion-storyboard-writer", target: "remotion-slot-storyboard", targetHandle: "manager-slot-inner-in", condition: "success" },
      { id: "remotion-tech-plan-start", source: "remotion-slot-tech-plan", sourceHandle: "manager-slot-inner-out", target: "remotion-tech-planner", condition: "success" },
      { id: "remotion-tech-plan-finish", source: "remotion-tech-planner", target: "remotion-slot-tech-plan", targetHandle: "manager-slot-inner-in", condition: "success" }
    ],
    variables: {},
    display: {
      viewport: { x: -54, y: 8, zoom: 0.54 }
    },
    createdAt: now,
    updatedAt: now
  };
}

export function createDefaultBlueprints(
  now: string,
  companyId = "company-hiveward-studio",
  workingDirectory = ""
): BlueprintDefinition[] {
  return [
    createStarterBlueprint(now, companyId),
    createRealThreeAgentBlueprint(now, companyId),
    createMultiAgentCompatibilityBlueprint(now, companyId, workingDirectory),
    createManagerDrivenHtmlBlueprint(now, companyId),
    createActiveManagerNewsHtmlChaosBlueprint(now, companyId),
    createActiveManagerRemotionVideoChaosBlueprint(now, companyId)
  ];
}

export function createBlankBlueprint({
  id,
  now,
  companyId = "company-hiveward-studio",
  name,
  description
}: {
  id: string;
  now: string;
  companyId?: string;
  name?: string;
  description?: string;
}): BlueprintDefinition {
  return {
    id,
    companyId,
    name: normalizeBlueprintText(name, "Untitled blueprint"),
    description: normalizeBlueprintText(description, "Start with an empty command canvas and add Hiveward blueprint nodes."),
    version: 1,
    nodes: [],
    edges: [],
    variables: {},
    display: {
      viewport: { x: 0, y: 0, zoom: 1 }
    },
    createdAt: now,
    updatedAt: now
  };
}

export function createPortableBlueprintPackage(
  blueprints: BlueprintDefinition[],
  exportedAt: string
): PortableBlueprintPackage {
  return {
    schema: portableBlueprintPackageSchema,
    exportedAt,
    blueprints: blueprints.map(toPortableBlueprintDefinition)
  };
}

export function toPortableBlueprintDefinition(blueprint: BlueprintDefinition): PortableBlueprintDefinition {
  return {
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description,
    version: blueprint.version,
    nodes: blueprint.nodes.map(toPortableBlueprintNode),
    edges: blueprint.edges.map((edge) => ({ ...edge })),
    variables: { ...blueprint.variables },
    display: {
      viewport: blueprint.display.viewport ? { ...blueprint.display.viewport } : undefined
    }
  };
}

export function readPortableBlueprintPackage(value: unknown): PortableBlueprintPackage {
  if (!isRecord(value)) {
    throw new Error("Blueprint package must be a JSON object.");
  }
  if (value.schema !== portableBlueprintPackageSchema) {
    throw new Error(`Unsupported blueprint package schema: ${String(value.schema ?? "missing")}`);
  }
  if (!Array.isArray(value.blueprints) || value.blueprints.length === 0) {
    throw new Error("Blueprint package does not contain any blueprints.");
  }

  return {
    schema: portableBlueprintPackageSchema,
    exportedAt: readRequiredString(value.exportedAt, "exportedAt"),
    blueprints: value.blueprints.map(readPortableBlueprintDefinition)
  };
}

export function hydrateImportedBlueprint(
  portableBlueprint: PortableBlueprintDefinition,
  options: {
    id: string;
    companyId: string;
    now: string;
    defaults?: BlueprintImportDefaults;
    name?: string;
  }
): BlueprintDefinition {
  const edges = portableBlueprint.edges.map((edge) => ({ ...edge }));
  const nodes = layoutImportedNodesIfNeeded(
    portableBlueprint.nodes.map((node) => applyImportDefaultsToNode(toPortableBlueprintNode(node), options.defaults)),
    edges
  );
  return {
    id: options.id,
    companyId: options.companyId,
    name: normalizeBlueprintText(options.name ?? portableBlueprint.name, "Imported blueprint"),
    description: portableBlueprint.description,
    version: 1,
    nodes,
    edges,
    variables: { ...portableBlueprint.variables },
    display: {
      viewport: shouldAutoLayoutImportedNodes(portableBlueprint.nodes)
        ? { x: 0, y: 0, zoom: 0.85 }
        : portableBlueprint.display.viewport ? { ...portableBlueprint.display.viewport } : { x: 0, y: 0, zoom: 1 }
    },
    createdAt: options.now,
    updatedAt: options.now
  };
}

function layoutImportedNodesIfNeeded(nodes: BlueprintNode[], edges: BlueprintEdge[]): BlueprintNode[] {
  if (!shouldAutoLayoutImportedNodes(nodes)) return nodes;
  if (nodes.some((node) => node.type === "manager_slot")) return layoutManagerSlotNodes(nodes, edges);
  return layoutNodesByGraph(nodes, edges);
}

function shouldAutoLayoutImportedNodes(nodes: Array<Pick<BlueprintNode, "position">>): boolean {
  if (nodes.length <= 1) return false;
  const positions = nodes.map((node) => node.position);
  if (positions.some((position) => !Number.isFinite(position.x) || !Number.isFinite(position.y))) return true;
  const uniquePositions = new Set(positions.map((position) => `${Math.round(position.x)}:${Math.round(position.y)}`));
  if (uniquePositions.size < positions.length) return true;

  const xs = positions.map((position) => position.x);
  const ys = positions.map((position) => position.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return width < 160 && height < 120;
}

function layoutNodesByGraph(nodes: BlueprintNode[], edges: BlueprintEdge[]): BlueprintNode[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const incomingCounts = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    incomingCounts.set(edge.target, (incomingCounts.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const depthById = new Map<string, number>();
  const queue = nodes
    .filter((node) => (incomingCounts.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  for (const nodeId of queue) {
    depthById.set(nodeId, 0);
  }

  while (queue.length > 0) {
    const source = queue.shift()!;
    const sourceDepth = depthById.get(source) ?? 0;
    for (const target of outgoing.get(source) ?? []) {
      const nextDepth = Math.max(depthById.get(target) ?? 0, sourceDepth + 1);
      depthById.set(target, nextDepth);
      incomingCounts.set(target, Math.max(0, (incomingCounts.get(target) ?? 0) - 1));
      if (incomingCounts.get(target) === 0) queue.push(target);
    }
  }

  for (const [index, node] of nodes.entries()) {
    if (!depthById.has(node.id)) depthById.set(node.id, Math.min(index, 6));
  }

  const nodesByDepth = new Map<number, BlueprintNode[]>();
  for (const node of nodes) {
    const depth = depthById.get(node.id) ?? 0;
    nodesByDepth.set(depth, [...(nodesByDepth.get(depth) ?? []), node]);
  }

  const rowGap = 190;
  const columnGap = 360;
  const originX = 80;
  const originY = 120;
  return nodes.map((node) => {
    const depth = depthById.get(node.id) ?? 0;
    const depthNodes = nodesByDepth.get(depth) ?? [];
    const row = Math.max(0, depthNodes.findIndex((candidate) => candidate.id === node.id));
    const centeredOffset = ((depthNodes.length - 1) * rowGap) / 2;
    return {
      ...node,
      position: {
        x: originX + depth * columnGap,
        y: originY + row * rowGap - centeredOffset
      }
    };
  });
}

function layoutManagerSlotNodes(nodes: BlueprintNode[], edges: BlueprintEdge[]): BlueprintNode[] {
  const managers = nodes.filter((node) => node.type === "manager");
  const slots = nodes.filter((node) => node.type === "manager_slot");
  const slotsByManager = new Map<string, BlueprintNode[]>();
  for (const slotNode of slots) {
    const managerNodeId = (slotNode.config as ManagerSlotNodeConfig).managerNodeId;
    slotsByManager.set(managerNodeId, [...(slotsByManager.get(managerNodeId) ?? []), slotNode]);
  }

  const positioned = new Map<string, BlueprintNode>();
  let groupOriginY = 80;
  for (const managerNode of managers) {
    const managerSlots = [...(slotsByManager.get(managerNode.id) ?? [])].sort(
      (left, right) => (left.config as ManagerSlotNodeConfig).slot - (right.config as ManagerSlotNodeConfig).slot
    );
    const groupHeight = Math.max(300, managerSlots.length * 360);
    positioned.set(managerNode.id, {
      ...managerNode,
      position: { x: 80, y: groupOriginY + Math.max(120, (groupHeight - 220) / 2) }
    });

    managerSlots.forEach((slotNode, index) => {
      const childNodes = nodes.filter((node) => node.parentId === slotNode.id);
      const layout = layoutManagerSlotChildNodes(slotNode, childNodes, edges);
      const slotSize = {
        width: Math.max(managerSlotDefaultSize.width, layout.requiredWidth),
        height: Math.max(managerSlotDefaultSize.height, layout.requiredHeight)
      };
      positioned.set(slotNode.id, {
        ...slotNode,
        position: { x: 460, y: groupOriginY + index * 360 },
        size: slotSize
      });
      for (const childNode of layout.nodes) {
        positioned.set(childNode.id, childNode);
      }
    });

    groupOriginY += groupHeight + 120;
  }

  const remainingTopLevelNodes = nodes.filter(
    (node) => !positioned.has(node.id) && !node.parentId
  );
  remainingTopLevelNodes.forEach((node, index) => {
    positioned.set(node.id, {
      ...node,
      position: { x: 460 + index * 360, y: groupOriginY }
    });
  });

  for (const node of nodes) {
    if (!positioned.has(node.id)) positioned.set(node.id, node);
  }

  return nodes.map((node) => positioned.get(node.id)!);
}

function layoutManagerSlotChildNodes(
  slotNode: BlueprintNode,
  childNodes: BlueprintNode[],
  edges: BlueprintEdge[]
): { nodes: BlueprintNode[]; requiredWidth: number; requiredHeight: number } {
  if (childNodes.length === 0) {
    return {
      nodes: [],
      requiredWidth: managerSlotDefaultSize.width,
      requiredHeight: managerSlotDefaultSize.height
    };
  }

  const childIds = new Set(childNodes.map((node) => node.id));
  const incomingCounts = new Map(childNodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!childIds.has(edge.target)) continue;
    if (edge.source === slotNode.id && isManagerSlotInnerOutHandle(edge.sourceHandle)) continue;
    if (!childIds.has(edge.source)) continue;
    if (resolveManagerSlotExecutionMode(slotNode.config as ManagerSlotNodeConfig) === "parallel") continue;
    incomingCounts.set(edge.target, (incomingCounts.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }

  const depthById = new Map<string, number>();
  const queue = childNodes
    .filter((node) => (incomingCounts.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  for (const nodeId of queue) depthById.set(nodeId, 0);

  while (queue.length > 0) {
    const source = queue.shift()!;
    const sourceDepth = depthById.get(source) ?? 0;
    for (const target of outgoing.get(source) ?? []) {
      depthById.set(target, Math.max(depthById.get(target) ?? 0, sourceDepth + 1));
      incomingCounts.set(target, Math.max(0, (incomingCounts.get(target) ?? 0) - 1));
      if (incomingCounts.get(target) === 0) queue.push(target);
    }
  }

  for (const [index, node] of childNodes.entries()) {
    if (!depthById.has(node.id)) depthById.set(node.id, Math.min(index, 6));
  }

  const nodesByDepth = new Map<number, BlueprintNode[]>();
  for (const node of childNodes) {
    const depth = depthById.get(node.id) ?? 0;
    nodesByDepth.set(depth, [...(nodesByDepth.get(depth) ?? []), node]);
  }

  const childColumnGap = 300;
  const childRowGap = 150;
  const childOriginX = 72;
  const childOriginY = 132;
  const maxDepth = Math.max(...[...depthById.values()]);
  const maxRows = Math.max(...[...nodesByDepth.values()].map((depthNodes) => depthNodes.length));
  return {
    nodes: childNodes.map((node) => {
      const depth = depthById.get(node.id) ?? 0;
      const depthNodes = nodesByDepth.get(depth) ?? [];
      const row = Math.max(0, depthNodes.findIndex((candidate) => candidate.id === node.id));
      const centeredOffset = ((depthNodes.length - 1) * childRowGap) / 2;
      return {
        ...node,
        position: {
          x: childOriginX + depth * childColumnGap,
          y: childOriginY + row * childRowGap - centeredOffset
        }
      };
    }),
    requiredWidth: childOriginX + (maxDepth + 1) * childColumnGap + 160,
    requiredHeight: childOriginY + maxRows * childRowGap + 80
  };
}

function normalizeBlueprintText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function toPortableBlueprintNode(node: BlueprintNode): BlueprintNode {
  return {
    ...node,
    position: { ...node.position },
    size: node.size ? { ...node.size } : undefined,
    config: toPortableBlueprintNodeConfig(node.type, node.config)
  };
}

function toPortableBlueprintNodeConfig(type: BlueprintNodeType, config: BlueprintNodeConfig): BlueprintNodeConfig {
  if (isAgentBlueprintNodeType(type)) {
    const agentConfig = config as AgentNodeConfig;
    return {
      label: agentConfig.label,
      description: agentConfig.description,
      resultRole: agentConfig.resultRole,
      crossRoundContextMode: agentConfig.crossRoundContextMode,
      profileId: agentConfig.profileId,
      agentName: agentConfig.agentName,
      prompt: agentConfig.prompt,
      userPrompt: agentConfig.userPrompt,
      skillIds: agentConfig.skillIds ?? [],
      permissionProfile: agentConfig.permissionProfile,
      runtimeAccessPolicy: agentConfig.runtimeAccessPolicy ? { ...agentConfig.runtimeAccessPolicy } : undefined,
      timeoutMs: agentConfig.timeoutMs,
      outputSchema: cloneJsonObject(agentConfig.outputSchema),
      approval: agentConfig.approval ? { ...agentConfig.approval } : undefined,
      send: agentConfig.send
        ? {
            ...agentConfig.send,
            channelId: "",
            target: ""
          }
        : undefined,
      tools: []
    };
  }
  if (type === "summary") {
    const summaryConfig = config as SummaryNodeConfig;
    return {
      label: summaryConfig.label,
      description: summaryConfig.description,
      resultRole: summaryConfig.resultRole,
      crossRoundContextMode: summaryConfig.crossRoundContextMode,
      mode: summaryConfig.mode,
      runtimeId: summaryConfig.runtimeId,
      profileId: summaryConfig.profileId,
      prompt: summaryConfig.prompt,
      modelId: summaryConfig.modelId,
      runtimeAccessPolicy: summaryConfig.runtimeAccessPolicy ? { ...summaryConfig.runtimeAccessPolicy } : undefined
    };
  }
  return { ...config };
}

function cloneJsonObject(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value ? JSON.parse(JSON.stringify(value)) as Record<string, unknown> : undefined;
}

function applyImportDefaultsToNode(node: BlueprintNode, defaults: BlueprintImportDefaults = {}): BlueprintNode {
  const runtimeId = resolveImportNodeRuntimeId(node, defaults);
  return {
    ...node,
    runtimeId: runtimeId ?? node.runtimeId,
    disabled: node.disabled,
    config: applyImportDefaultsToConfig(node.type, node.config, defaults, runtimeId)
  };
}

function applyImportDefaultsToConfig(
  type: BlueprintNodeType,
  config: BlueprintNodeConfig,
  defaults: BlueprintImportDefaults,
  runtimeId?: AgentRuntimeId
): BlueprintNodeConfig {
  if (isAgentBlueprintNodeType(type)) {
    const agentConfig = config as AgentNodeConfig;
    const modelId = defaultModelForImportRuntime(runtimeId, defaults);
    return {
      ...agentConfig,
      openclawAgentId: runtimeId === "openclaw" ? defaults.openclawAgentId ?? agentConfig.openclawAgentId ?? "main" : undefined,
      modelId: modelId ?? agentConfig.modelId,
      send: agentConfig.send
        ? {
            ...agentConfig.send,
            channelId: runtimeId === "openclaw" ? defaults.channelId ?? agentConfig.send.channelId ?? "" : "",
            target: runtimeId === "openclaw" ? agentConfig.send.target ?? "" : "",
            enabled: runtimeId === "openclaw" && agentConfig.send.enabled
          }
        : undefined,
      tools: []
    };
  }
  if (type === "manager") {
    const managerConfig = config as ManagerNodeConfig;
    const modelId = defaultModelForImportRuntime(runtimeId, defaults);
    return {
      ...managerConfig,
      openclawAgentId: runtimeId === "openclaw" ? defaults.openclawAgentId ?? managerConfig.openclawAgentId ?? "main" : undefined,
      modelId: modelId ?? managerConfig.modelId,
      tools: managerConfig.tools ?? []
    };
  }
  if (type === "summary") {
    const summaryConfig = config as SummaryNodeConfig;
    const runtimeId = summaryConfig.runtimeId ?? "openclaw";
    const modelId = summaryConfig.modelId ?? defaultModelForImportRuntime(runtimeId, defaults);
    return {
      ...summaryConfig,
      runtimeId: summaryConfig.mode === "harness_summary" ? runtimeId : summaryConfig.runtimeId,
      modelId: summaryConfig.mode === "harness_summary" ? modelId : undefined
    };
  }
  return config;
}

function resolveImportNodeRuntimeId(node: BlueprintNode, defaults: BlueprintImportDefaults): AgentRuntimeId | undefined {
  if (node.type !== "agent" && node.type !== "manager") {
    return node.runtimeId;
  }
  return node.runtimeId ?? defaults.runtimeId ?? "openclaw";
}

function defaultModelForImportRuntime(runtimeId: AgentRuntimeId | undefined, defaults: BlueprintImportDefaults): string | undefined {
  if (!runtimeId || runtimeId === "openclaw") return defaults.modelIds?.openclaw ?? defaults.modelId;
  return defaults.modelIds?.[runtimeId];
}

function readPortableBlueprintDefinition(value: unknown): PortableBlueprintDefinition {
  if (!isRecord(value)) {
    throw new Error("Blueprint entry must be an object.");
  }
  const display = isRecord(value.display) ? value.display : {};
  const viewport = isRecord(display.viewport)
    ? {
        x: readNumber(display.viewport.x, 0),
        y: readNumber(display.viewport.y, 0),
        zoom: readNumber(display.viewport.zoom, 1)
      }
    : undefined;

  const blueprint = {
    id: readRequiredString(value.id, "blueprint.id"),
    name: readRequiredString(value.name, "blueprint.name"),
    description: readOptionalString(value.description),
    version: readNumber(value.version, 1),
    nodes: readArray(value.nodes, "blueprint.nodes").map(readPortableBlueprintNode),
    edges: readArray(value.edges, "blueprint.edges").map(readPortableBlueprintEdge),
    variables: isRecord(value.variables) ? readStringRecord(value.variables) : {},
    display: {
      viewport
    }
  };

  return normalizePortableBlueprintSpecialNodes(blueprint);
}

function readPortableBlueprintNode(value: unknown, index: number): BlueprintNode {
  if (!isRecord(value)) {
    throw new Error(`blueprint.nodes[${index}] must be an object.`);
  }
  const type = readRequiredString(value.type, `blueprint.nodes[${index}].type`);
  if (!isBlueprintNodeType(type)) {
    throw new Error(`Unsupported blueprint node type: ${type}.`);
  }
  const runtimeId = readOptionalAgentRuntimeId(value.runtimeId, `blueprint.nodes[${index}].runtimeId`);
  return {
    id: readRequiredString(value.id, `blueprint.nodes[${index}].id`),
    type,
    runtimeId,
    position: readPosition(value.position, `blueprint.nodes[${index}].position`),
    size: isRecord(value.size)
      ? {
          width: readNumber(value.size.width, 0),
          height: readNumber(value.size.height, 0)
        }
      : undefined,
    config: readPortableBlueprintNodeConfig(type, value.config, `blueprint.nodes[${index}].config`),
    parentId: readOptionalString(value.parentId),
    disabled: value.disabled === true ? true : undefined
  };
}

function readPortableBlueprintNodeConfig(
  type: BlueprintNodeType,
  value: unknown,
  fieldName: string
): BlueprintNodeConfig {
  const config = readConfigRecord(value, fieldName);
  const base = {
    label: readRequiredString(config.label, `${fieldName}.label`),
    description: readOptionalString(config.description),
    resultRole: readOptionalResultRole(config.resultRole, `${fieldName}.resultRole`),
    crossRoundContextMode: readCrossRoundContextMode(config.crossRoundContextMode, `${fieldName}.crossRoundContextMode`)
  };

  if (type === "agent") {
    return readAgentNodeConfig(config, fieldName, base);
  }
  if (type === "summary") {
    const mode = readSummaryNodeMode(config.mode);
    return {
      ...base,
      mode,
      runtimeId:
        mode === "harness_summary"
          ? readOptionalAgentRuntimeId(config.runtimeId, `${fieldName}.runtimeId`) ?? "openclaw"
          : readOptionalAgentRuntimeId(config.runtimeId, `${fieldName}.runtimeId`),
      profileId: readOptionalString(config.profileId),
      modelId: readOptionalString(config.modelId),
      prompt: readOptionalString(config.prompt),
      runtimeAccessPolicy: readRuntimeAccessPolicy(config.runtimeAccessPolicy, config.permissionProfile)
    } as SummaryNodeConfig;
  }
  if (type === "manager") {
    return {
      ...base,
      portCount: readBoundedInteger(config.portCount, 1, maxManagerPortCount, 1),
      maxHandoffs: readBoundedInteger(config.maxHandoffs, 1, 50, 12),
      instructions: readOptionalString(config.instructions),
      openclawAgentId: readOptionalString(config.openclawAgentId),
      profileId: readOptionalString(config.profileId),
      agentName: readOptionalString(config.agentName),
      modelId: readOptionalString(config.modelId),
      skillIds: Array.isArray(config.skillIds) ? readStringArray(config.skillIds, `${fieldName}.skillIds`) : [],
      permissionProfile: readOptionalPermissionProfile(config.permissionProfile),
      runtimeAccessPolicy: readRuntimeAccessPolicy(config.runtimeAccessPolicy, config.permissionProfile),
      lifecycleMode: readManagerLifecycleMode(config.lifecycleMode, `${fieldName}.lifecycleMode`),
      dispatchMode: readManagerDispatchMode(config.dispatchMode, `${fieldName}.dispatchMode`),
      maxRounds: readBoundedInteger(config.maxRounds, 1, 50, 3),
      researchAgentNodeId: readOptionalString(config.researchAgentNodeId),
      requirementAgentNodeId: readOptionalString(config.requirementAgentNodeId),
      maxPreparationAttempts: readBoundedInteger(config.maxPreparationAttempts, 1, 10, 3),
      autoApproveRequirements: config.autoApproveRequirements === true ? true : undefined,
      autoApproveReleaseReports: config.autoApproveReleaseReports === true ? true : undefined,
      workingDirectory: readOptionalString(config.workingDirectory),
      timeoutMs: typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) ? Math.max(0, config.timeoutMs) : undefined,
      tools: Array.isArray(config.tools) ? readStringArray(config.tools, `${fieldName}.tools`) : []
    } as ManagerNodeConfig;
  }
  if (type === "manager_slot") {
    return {
      ...base,
      managerNodeId: readOptionalString(config.managerNodeId) ?? "",
      slot: readBoundedInteger(config.slot, 1, maxManagerPortCount, 1),
      executionMode: readManagerSlotExecutionMode(config.executionMode, `${fieldName}.executionMode`),
      parallelLaneCount: readBoundedInteger(config.parallelLaneCount, 1, maxManagerSlotParallelLaneCount, 1)
    } as ManagerSlotNodeConfig;
  }

  return {
    ...config,
    ...base
  } as BlueprintNodeConfig;
}

function readAgentNodeConfig(
  config: Record<string, unknown>,
  fieldName: string,
  base: Pick<BlueprintNodeBaseConfig, "label" | "description" | "resultRole" | "crossRoundContextMode">
): AgentNodeConfig {
  return {
    ...base,
    openclawAgentId: readOptionalString(config.openclawAgentId),
    profileId: readOptionalString(config.profileId),
    agentName: readRequiredString(config.agentName, `${fieldName}.agentName`),
    prompt: readRequiredString(config.prompt, `${fieldName}.prompt`),
    userPrompt: readOptionalString(config.userPrompt),
    skillIds: Array.isArray(config.skillIds) ? readStringArray(config.skillIds, `${fieldName}.skillIds`) : [],
    modelId: readOptionalString(config.modelId),
    permissionProfile: readOptionalPermissionProfile(config.permissionProfile),
    runtimeAccessPolicy: readRuntimeAccessPolicy(config.runtimeAccessPolicy, config.permissionProfile),
    workingDirectory: readOptionalString(config.workingDirectory),
    timeoutMs: typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) ? Math.max(0, config.timeoutMs) : undefined,
    outputSchema: isRecord(config.outputSchema) ? config.outputSchema : undefined,
    approval: readAgentApprovalConfig(config.approval, `${fieldName}.approval`),
    send: readAgentSendConfig(config.send, `${fieldName}.send`),
    tools: readStringArray(config.tools, `${fieldName}.tools`)
  };
}

function readAgentApprovalConfig(value: unknown, fieldName: string): AgentApprovalConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return {
    enabled: value.enabled === true
  };
}

function readAgentSendConfig(value: unknown, fieldName: string): AgentSendConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return {
    enabled: value.enabled === true,
    channelId: readOptionalString(value.channelId) ?? "",
    target: readOptionalString(value.target) ?? "",
    bodyTemplate: readOptionalString(value.bodyTemplate) ?? ""
  };
}

function readPortableBlueprintEdge(value: unknown, index: number): BlueprintEdge {
  if (!isRecord(value)) {
    throw new Error(`blueprint.edges[${index}] must be an object.`);
  }
  const source = readOptionalString(value.source) ?? readOptionalString(value.from);
  const target = readOptionalString(value.target) ?? readOptionalString(value.to);
  if (!source) {
    throw new Error(`blueprint.edges[${index}].source must be a non-empty string.`);
  }
  if (!target) {
    throw new Error(`blueprint.edges[${index}].target must be a non-empty string.`);
  }
  const condition = readOptionalString(value.condition);
  if (condition && !blueprintEdgeConditions.has(condition as NonNullable<BlueprintEdge["condition"]>)) {
    throw new Error(`Unsupported blueprint edge condition: ${condition}.`);
  }
  return {
    id: readOptionalString(value.id) ?? `edge-${index + 1}-${source}-${target}`,
    source,
    target,
    sourceHandle: readOptionalString(value.sourceHandle),
    targetHandle: readOptionalString(value.targetHandle),
    label: readOptionalString(value.label),
    condition: condition as BlueprintEdge["condition"] | undefined
  };
}

function normalizePortableBlueprintSpecialNodes(blueprint: PortableBlueprintDefinition): PortableBlueprintDefinition {
  const nodes = blueprint.nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    size: node.size ? { ...node.size } : undefined,
    config: { ...node.config } as BlueprintNodeConfig
  }));
  const edges = blueprint.edges.map((edge) => ({ ...edge }));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  for (const edge of edges) {
    if (!nodesById.has(edge.source)) {
      throw new Error(`Blueprint edge ${edge.id} references missing source node ${edge.source}.`);
    }
    if (!nodesById.has(edge.target)) {
      throw new Error(`Blueprint edge ${edge.id} references missing target node ${edge.target}.`);
    }
  }

  const slotNodes = nodes.filter((node) => node.type === "manager_slot");
  if (slotNodes.length === 0) {
    return {
      ...blueprint,
      nodes,
      edges
    };
  }

  attachSlotChildNodesFromEdges(nodes, edges, nodesById);
  normalizeManagerSlotConfigs(nodes, edges, nodesById);

  const refreshedNodesById = new Map(nodes.map((node) => [node.id, node]));
  const managersWithSlots = new Set(
    nodes
      .filter((node) => node.type === "manager_slot")
      .map((node) => (node.config as ManagerSlotNodeConfig).managerNodeId)
  );
  let nextEdges = edges.reduce<BlueprintEdge[]>(
    (normalizedEdges, edge) => appendNormalizedEdge(
      normalizedEdges,
      normalizeManagerSlotEdge(edge, refreshedNodesById, managersWithSlots)
    ),
    []
  );

  for (const slotNode of nodes.filter((node) => node.type === "manager_slot")) {
    nextEdges = ensureManagerSlotEdges(nextEdges, nodes, slotNode);
  }

  return {
    ...blueprint,
    nodes,
    edges: nextEdges
  };
}

function attachSlotChildNodesFromEdges(
  nodes: BlueprintNode[],
  edges: BlueprintEdge[],
  nodesById: Map<string, BlueprintNode>
): void {
  const slotIds = new Set(nodes.filter((node) => node.type === "manager_slot").map((node) => node.id));
  for (const edge of edges) {
    const sourceIsSlot = slotIds.has(edge.source);
    const targetIsSlot = slotIds.has(edge.target);
    if (sourceIsSlot === targetIsSlot) continue;
    if (sourceIsSlot && isManagerSlotForwardOutHandle(edge.sourceHandle)) continue;

    const slotId = sourceIsSlot ? edge.source : edge.target;
    const childId = sourceIsSlot ? edge.target : edge.source;
    const child = nodesById.get(childId);
    if (!child || child.type === "manager" || child.type === "manager_slot") continue;
    if (child.parentId && child.parentId !== slotId) {
      throw new Error(`Node ${child.id} cannot be connected to manager slot ${slotId}; it already belongs to slot ${child.parentId}.`);
    }
    child.parentId = slotId;
  }
}

function normalizeManagerSlotConfigs(
  nodes: BlueprintNode[],
  edges: BlueprintEdge[],
  nodesById: Map<string, BlueprintNode>
): void {
  const managers = nodes.filter((node) => node.type === "manager");
  const managerIds = new Set(managers.map((node) => node.id));
  const slotsByManager = new Map<string, BlueprintNode[]>();

  for (const slotNode of nodes.filter((node) => node.type === "manager_slot")) {
    const config = slotNode.config as ManagerSlotNodeConfig;
    const managerNodeId = resolveManagerSlotManagerId(slotNode, config, edges, nodesById, managerIds);
    slotNode.config = {
      ...config,
      managerNodeId
    };
    slotNode.size = normalizeManagerSlotSize(slotNode.size);
    slotsByManager.set(managerNodeId, [...(slotsByManager.get(managerNodeId) ?? []), slotNode]);
  }

  for (const [managerNodeId, slotNodes] of slotsByManager) {
    const usedSlots = new Set<number>();
    let highestSlot = 1;
    for (const slotNode of slotNodes) {
      const config = slotNode.config as ManagerSlotNodeConfig;
      const edgeSlot = resolveManagerSlotNumberFromEdges(slotNode, managerNodeId, edges);
      const requestedSlot = edgeSlot ?? normalizeManagerSlotNumber(config.slot, 1);
      const slot = usedSlots.has(requestedSlot) ? nextAvailableSlotNumber(usedSlots) : requestedSlot;
      usedSlots.add(slot);
      highestSlot = Math.max(highestSlot, slot);
      slotNode.config = {
        ...config,
        managerNodeId,
        slot
      };
    }

    const managerNode = nodesById.get(managerNodeId);
    if (managerNode?.type !== "manager") continue;
    const managerConfig = managerNode.config as ManagerNodeConfig;
    managerNode.config = {
      ...managerConfig,
      portCount: Math.min(maxManagerPortCount, Math.max(managerConfig.portCount, highestSlot))
    };
  }
}

function resolveManagerSlotManagerId(
  slotNode: BlueprintNode,
  config: ManagerSlotNodeConfig,
  edges: BlueprintEdge[],
  nodesById: Map<string, BlueprintNode>,
  managerIds: Set<string>
): string {
  if (config.managerNodeId && managerIds.has(config.managerNodeId)) return config.managerNodeId;

  const edgeManagerIds = edges.flatMap((edge) => {
    if (edge.target === slotNode.id) {
      return nodesById.get(edge.source)?.type === "manager" ? [edge.source] : [];
    }
    if (edge.source === slotNode.id) {
      return nodesById.get(edge.target)?.type === "manager" ? [edge.target] : [];
    }
    return [];
  });
  const uniqueEdgeManagerIds = [...new Set(edgeManagerIds)];
  if (uniqueEdgeManagerIds.length === 1) return uniqueEdgeManagerIds[0]!;

  const allManagerIds = [...managerIds];
  if (allManagerIds.length === 1) return allManagerIds[0]!;

  throw new Error(`Manager slot ${slotNode.id} must reference exactly one manager node through config.managerNodeId.`);
}

function resolveManagerSlotNumberFromEdges(
  slotNode: BlueprintNode,
  managerNodeId: string,
  edges: BlueprintEdge[]
): number | undefined {
  for (const edge of edges) {
    if (edge.source === managerNodeId && edge.target === slotNode.id) {
      const slot = parseManagerPortHandle(edge.sourceHandle, managerOutHandlePrefix);
      if (slot !== undefined) return slot;
    }
    if (edge.source === slotNode.id && edge.target === managerNodeId) {
      const slot = parseManagerPortHandle(edge.targetHandle, managerInHandlePrefix);
      if (slot !== undefined) return slot;
    }
  }
  return undefined;
}

function normalizeManagerSlotEdge(
  edge: BlueprintEdge,
  nodesById: Map<string, BlueprintNode>,
  managersWithSlots: Set<string>
): BlueprintEdge {
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  if (!source || !target) return edge;

  if (source.type === "manager" && target.type === "manager_slot") {
    const slotConfig = target.config as ManagerSlotNodeConfig;
    if (slotConfig.managerNodeId !== source.id) {
      throw new Error(`Manager slot ${target.id} belongs to ${slotConfig.managerNodeId}, not ${source.id}.`);
    }
    return {
      ...edge,
      sourceHandle: `${managerOutHandlePrefix}${slotConfig.slot}`,
      targetHandle: managerSlotInHandle,
      condition: edge.condition ?? "success"
    };
  }

  if (source.type === "manager_slot" && target.type === "manager") {
    const slotConfig = source.config as ManagerSlotNodeConfig;
    if (slotConfig.managerNodeId !== target.id) {
      throw new Error(`Manager slot ${source.id} belongs to ${slotConfig.managerNodeId}, not ${target.id}.`);
    }
    if (edge.sourceHandle && edge.sourceHandle !== managerSlotOutHandle) {
      throw new Error(`Manager slot edge ${edge.id} must use the left manager return handle for manager connections.`);
    }
    return {
      ...edge,
      sourceHandle: managerSlotOutHandle,
      targetHandle: `${managerInHandlePrefix}${slotConfig.slot}`,
      condition: edge.condition ?? "success"
    };
  }

  if (source.type === "manager_slot" || target.type === "manager_slot") {
    return normalizeManagerSlotBoundaryEdge(edge, source, target);
  }

  if (source.type === "manager" && managersWithSlots.has(source.id) && edge.sourceHandle?.startsWith(managerOutHandlePrefix)) {
    throw new Error(`Manager ${source.id} must send ${edge.sourceHandle} to a manager_slot node, not ${target.type} ${target.id}.`);
  }
  if (target.type === "manager" && managersWithSlots.has(target.id) && edge.targetHandle?.startsWith(managerInHandlePrefix)) {
    throw new Error(`Manager ${target.id} must receive ${edge.targetHandle} from a manager_slot node, not ${source.type} ${source.id}.`);
  }

  return edge;
}

function normalizeManagerSlotBoundaryEdge(edge: BlueprintEdge, source: BlueprintNode, target: BlueprintNode): BlueprintEdge {
  const slotNode = source.type === "manager_slot" ? source : target;
  const otherNode = source.type === "manager_slot" ? target : source;

  if (otherNode.type === "manager_slot") {
    throw new Error(`Manager slots must not connect directly to each other (${source.id} -> ${target.id}).`);
  }
  if (source.type === "manager_slot" && isManagerSlotForwardOutHandle(edge.sourceHandle)) {
    if (otherNode.type === "manager") {
      throw new Error(`Manager slot edge ${edge.id} must use the left manager return handle for manager connections.`);
    }
    if (otherNode.parentId) {
      throw new Error(`Manager slot edge ${edge.id} must use inner handles for nodes inside the slot.`);
    }
    return {
      ...edge,
      sourceHandle: managerSlotForwardOutHandle,
      condition: edge.condition ?? "success"
    };
  }
  if (source.type === "manager_slot" && edge.sourceHandle === managerSlotOutHandle) {
    throw new Error(`Manager slot edge ${edge.id} must use the right forward handle for non-manager connections.`);
  }
  if (otherNode.type === "manager") {
    throw new Error(`Manager slot edge ${edge.id} must use canonical manager-slot handles.`);
  }
  if (otherNode.parentId !== slotNode.id) {
    throw new Error(`Node ${otherNode.id} must set parentId to manager slot ${slotNode.id} before connecting to it.`);
  }

  if (source.type === "manager_slot") {
    return {
      ...edge,
      sourceHandle: isManagerSlotInnerOutHandle(edge.sourceHandle) ? edge.sourceHandle : managerSlotInnerOutHandle,
      condition: edge.condition ?? "success"
    };
  }
  return {
    ...edge,
    targetHandle: isManagerSlotInnerInHandle(edge.targetHandle) ? edge.targetHandle : managerSlotInnerInHandle,
    condition: edge.condition ?? "success"
  };
}

function ensureManagerSlotEdges(edges: BlueprintEdge[], nodes: BlueprintNode[], slotNode: BlueprintNode): BlueprintEdge[] {
  const slotConfig = slotNode.config as ManagerSlotNodeConfig;
  let nextEdges = appendNormalizedEdge(edges, {
    id: `edge-${slotConfig.managerNodeId}-${slotNode.id}-slot-${slotConfig.slot}-out`,
    source: slotConfig.managerNodeId,
    sourceHandle: `${managerOutHandlePrefix}${slotConfig.slot}`,
    target: slotNode.id,
    targetHandle: managerSlotInHandle,
    condition: "success"
  });
  nextEdges = appendNormalizedEdge(nextEdges, {
    id: `edge-${slotNode.id}-${slotConfig.managerNodeId}-slot-${slotConfig.slot}-return`,
    source: slotNode.id,
    sourceHandle: managerSlotOutHandle,
    target: slotConfig.managerNodeId,
    targetHandle: `${managerInHandlePrefix}${slotConfig.slot}`,
    condition: "success"
  });

  const childNodes = nodes.filter((node) => node.parentId === slotNode.id);
  if (childNodes.length === 0) return nextEdges;
  if (resolveManagerSlotExecutionMode(slotConfig) === "parallel") {
    return ensureManagerSlotParallelEdges(nextEdges, slotNode, childNodes);
  }

  const childIds = new Set(childNodes.map((node) => node.id));
  const hasSlotInputEdge = nextEdges.some((edge) => edge.source === slotNode.id && isManagerSlotInnerOutHandle(edge.sourceHandle));
  const hasSlotOutputEdge = nextEdges.some((edge) => edge.target === slotNode.id && isManagerSlotInnerInHandle(edge.targetHandle));
  const firstChild = childNodes.find(
    (node) => !nextEdges.some((edge) => edge.target === node.id && (edge.source === slotNode.id || childIds.has(edge.source)))
  ) ?? childNodes[0]!;
  const lastChild = childNodes.find(
    (node) => !nextEdges.some((edge) => edge.source === node.id && (edge.target === slotNode.id || childIds.has(edge.target)))
  ) ?? childNodes[childNodes.length - 1]!;

  if (!hasSlotInputEdge) {
    nextEdges = appendNormalizedEdge(nextEdges, {
      id: `edge-${slotNode.id}-${firstChild.id}-slot-input`,
      source: slotNode.id,
      sourceHandle: managerSlotInnerOutHandle,
      target: firstChild.id,
      condition: "success"
    });
  }
  if (!hasSlotOutputEdge) {
    nextEdges = appendNormalizedEdge(nextEdges, {
      id: `edge-${lastChild.id}-${slotNode.id}-slot-output`,
      source: lastChild.id,
      target: slotNode.id,
      targetHandle: managerSlotInnerInHandle,
      condition: "success"
    });
  }
  return nextEdges;
}

function ensureManagerSlotParallelEdges(
  edges: BlueprintEdge[],
  slotNode: BlueprintNode,
  childNodes: BlueprintNode[]
): BlueprintEdge[] {
  const childIds = new Set(childNodes.map((node) => node.id));
  let nextEdges = edges.filter((edge) => !isManagerSlotParallelManagedEdge(edge, slotNode.id, childIds));

  childNodes.forEach((childNode, index) => {
    const lane = index + 1;
    nextEdges = appendNormalizedEdge(nextEdges, {
      id: `edge-${slotNode.id}-${childNode.id}-parallel-input`,
      source: slotNode.id,
      sourceHandle: managerSlotInnerOutHandleId(lane),
      target: childNode.id,
      condition: "success"
    });
    nextEdges = appendNormalizedEdge(nextEdges, {
      id: `edge-${childNode.id}-${slotNode.id}-parallel-output`,
      source: childNode.id,
      target: slotNode.id,
      targetHandle: managerSlotInnerInHandleId(lane),
      condition: "success"
    });
  });

  return nextEdges;
}

function isManagerSlotParallelManagedEdge(edge: BlueprintEdge, slotNodeId: string, childIds: Set<string>): boolean {
  return (
    (edge.source === slotNodeId && isManagerSlotInnerOutHandle(edge.sourceHandle) && childIds.has(edge.target)) ||
    (edge.target === slotNodeId && isManagerSlotInnerInHandle(edge.targetHandle) && childIds.has(edge.source)) ||
    (childIds.has(edge.source) && childIds.has(edge.target))
  );
}

function appendNormalizedEdge(edges: BlueprintEdge[], edge: BlueprintEdge): BlueprintEdge[] {
  if (
    edges.some(
      (candidate) =>
        candidate.source === edge.source &&
        candidate.target === edge.target &&
        candidate.sourceHandle === edge.sourceHandle &&
        candidate.targetHandle === edge.targetHandle
    )
  ) {
    return edges;
  }

  const usedIds = new Set(edges.map((candidate) => candidate.id));
  let id = edge.id;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${edge.id}-${suffix}`;
    suffix += 1;
  }
  return [...edges, { ...edge, id }];
}

function normalizeManagerSlotSize(size?: CanvasSize): CanvasSize {
  return {
    width: normalizeCanvasSizeValue(size?.width, managerSlotDefaultSize.width, managerSlotMinSize.width),
    height: normalizeCanvasSizeValue(size?.height, managerSlotDefaultSize.height, managerSlotMinSize.height)
  };
}

function normalizeCanvasSizeValue(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.round(value)) : fallback;
}

function normalizeManagerSlotNumber(value: unknown, fallback: number): number {
  return readBoundedInteger(value, 1, maxManagerPortCount, fallback);
}

function nextAvailableSlotNumber(usedSlots: Set<number>): number {
  for (let slot = 1; slot <= maxManagerPortCount; slot += 1) {
    if (!usedSlots.has(slot)) return slot;
  }
  return maxManagerPortCount;
}

function parseManagerPortHandle(handle: string | undefined, prefix: string): number | undefined {
  if (!handle?.startsWith(prefix)) return undefined;
  const parsed = Number.parseInt(handle.slice(prefix.length), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > maxManagerPortCount) return undefined;
  return parsed;
}

function readPosition(value: unknown, fieldName: string): CanvasPosition {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return {
    x: readNumber(value.x, 0),
    y: readNumber(value.y, 0)
  };
}

function readConfigRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return value;
}

function readStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }
  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
}

function readOptionalAgentRuntimeId(value: unknown, fieldName: string): AgentRuntimeId | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && agentRuntimeIds.has(value as AgentRuntimeId)) return value as AgentRuntimeId;
  throw new Error(`${fieldName} must be openclaw, codex, claude, google, cursor, opencode, or hermes.`);
}

function readOptionalResultRole(value: unknown, fieldName: string): BlueprintNodeResultRole | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string" && blueprintNodeResultRoles.has(value as BlueprintNodeResultRole)) {
    return value as BlueprintNodeResultRole;
  }
  throw new Error(`${fieldName} must be auto, final, or ignore.`);
}

function readCrossRoundContextMode(value: unknown, fieldName: string): CrossRoundContextMode | undefined {
  if (value === undefined || value === null || value === "" || value === "off") return undefined;
  if (typeof value === "string" && crossRoundContextModes.has(value as CrossRoundContextMode)) {
    return value as CrossRoundContextMode;
  }
  throw new Error(`${fieldName} must be off, node_history, node_history_with_upstream, or node_history_with_upstream_and_manager_memory.`);
}

function readManagerSlotExecutionMode(value: unknown, fieldName: string): ManagerSlotExecutionMode {
  if (value === undefined || value === null || value === "") return "parallel";
  if (typeof value === "string" && managerSlotExecutionModes.has(value as ManagerSlotExecutionMode)) {
    return value as ManagerSlotExecutionMode;
  }
  throw new Error(`${fieldName} must be manual or parallel.`);
}

function readManagerLifecycleMode(value: unknown, fieldName: string): ManagerLifecycleMode {
  if (value === undefined || value === null || value === "") return "none";
  if (value === "none" || value === "self_iteration") return value;
  throw new Error(`${fieldName} must be none or self_iteration.`);
}

function readManagerDispatchMode(value: unknown, fieldName: string): ManagerDispatchMode {
  if (value === undefined || value === null || value === "") return "sequential";
  if (value === "sequential" || value === "self_dispatch") return value;
  throw new Error(`${fieldName} must be sequential or self_dispatch.`);
}

function readOptionalPermissionProfile(value: unknown): AgentPermissionProfile | undefined {
  return value === "read_only" || value === "workspace_write" ? value : undefined;
}

function readRuntimeAccessPolicy(value: unknown, legacyPermissionProfile?: unknown): RuntimeAccessPolicy {
  return normalizeRuntimeAccessPolicy(isRecord(value) ? value as Partial<RuntimeAccessPolicy> : undefined, legacyPermissionProfile);
}

function readSummaryNodeMode(value: unknown): SummaryNodeConfig["mode"] {
  return value === "harness_summary" || value === "openclaw_summary_agent" ? "harness_summary" : "structured_merge";
}

function isBlueprintNodeType(value: string): value is BlueprintNodeType {
  return portableBlueprintNodeTypes.has(value as BlueprintNodeType);
}

function readArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array.`);
  }
  return value;
}

function readRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readStringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (typeof item === "string" ? [[key, item]] : []))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

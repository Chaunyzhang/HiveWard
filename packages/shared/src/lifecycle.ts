import type { BlueprintNodeType } from "./blueprint";

export type ManagerLifecycleMode = "none" | "self_iteration";
export type ManagerDispatchMode = "sequential" | "self_dispatch";

export interface ManagerModeConfig {
  lifecycleMode: ManagerLifecycleMode;
  dispatchMode: ManagerDispatchMode;
}

export interface RuntimeAccessPolicy {
  filesystem: "read_only" | "workspace_write";
  network: "disabled" | "enabled";
  webSearch: "disabled" | "live";
}

export type RuntimeAccessPolicyRuntime = "openclaw" | "codex" | "claude" | "google" | "cursor" | "opencode" | "hermes";
export type RuntimeAccessPolicyAxisSupport = "enforced" | "delegated" | "unsupported";

export interface RuntimeAccessPolicySupport {
  filesystem: RuntimeAccessPolicyAxisSupport;
  network: RuntimeAccessPolicyAxisSupport;
  webSearch: RuntimeAccessPolicyAxisSupport;
}

export const runtimeAccessPolicySupportByRuntime = Object.freeze({
  codex: {
    filesystem: "enforced",
    network: "enforced",
    webSearch: "enforced"
  },
  claude: {
    filesystem: "enforced",
    network: "unsupported",
    webSearch: "unsupported"
  },
  openclaw: {
    filesystem: "delegated",
    network: "delegated",
    webSearch: "delegated"
  },
  google: {
    filesystem: "enforced",
    network: "delegated",
    webSearch: "delegated"
  },
  cursor: {
    filesystem: "enforced",
    network: "delegated",
    webSearch: "delegated"
  },
  opencode: {
    filesystem: "enforced",
    network: "delegated",
    webSearch: "delegated"
  },
  hermes: {
    filesystem: "enforced",
    network: "delegated",
    webSearch: "delegated"
  }
} satisfies Record<RuntimeAccessPolicyRuntime, RuntimeAccessPolicySupport>);

export interface ApprovalCapabilities {
  approve: boolean;
  reject: boolean;
  reply: boolean;
  complete: boolean;
  terminate: boolean;
  requestChanges?: boolean;
  revise?: boolean;
}

export type ApprovalRequestKind =
  | "iteration_requirement_plan"
  | "manager_release_report"
  | "agent_proposal"
  | "function_node"
  | "blueprint_proposal"
  | "leader_delegation"
  | "run_request"
  | "company_config";

export function normalizeApprovalRequestKind(value: unknown): ApprovalRequestKind | undefined {
  if (value === "generic_message") return "function_node";
  if (
    value === "iteration_requirement_plan" ||
    value === "manager_release_report" ||
    value === "agent_proposal" ||
    value === "function_node" ||
    value === "blueprint_proposal" ||
    value === "leader_delegation" ||
    value === "run_request" ||
    value === "company_config"
  ) {
    return value;
  }
  return undefined;
}

export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "replied"
  | "completed"
  | "terminated"
  | "superseded";

export type ApprovalThreadStatus = "open" | "closed";
export type ApprovalThreadKind = ApprovalRequestKind;
export type InboxDiscussionThreadType = "approval" | "inbox";
export type InboxDiscussionHarnessId = "openclaw" | "claudeCode" | "codex" | "google" | "cursor" | "opencode" | "hermes";
export type InboxDiscussionNativeSessionState = "unknown" | "resumable" | "missing";
export type InboxDiscussionSessionStatus = "active" | "ended" | "failed" | "native_missing";

export interface InboxDiscussionSession {
  threadType: InboxDiscussionThreadType;
  threadId: string;
  chatSessionId?: string;
  harnessId: InboxDiscussionHarnessId;
  agentId?: string;
  modelId?: string;
  nativeSessionId?: string;
  nativeSessionState?: InboxDiscussionNativeSessionState;
  status: InboxDiscussionSessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalThread {
  id: string;
  kind: ApprovalThreadKind;
  status: ApprovalThreadStatus;
  title: string;
  runId?: string;
  roundId?: string;
  nodeRunId?: string;
  sourceRef?: ApprovalRequest["sourceRef"];
  currentRequestId?: string;
  currentRevision: number;
  capabilities: ApprovalCapabilities;
  discussionSession?: InboxDiscussionSession;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type ApprovalReplyActor = "user" | "assistant" | "agent" | "manager" | "system";

export interface ApprovalReply {
  id: string;
  threadId: string;
  approvalRequestId?: string;
  actor: ApprovalReplyActor;
  body: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  runId?: string;
  roundId?: string;
  nodeRunId?: string;
  kind: ApprovalRequestKind;
  status: ApprovalRequestStatus;
  title: string;
  body: string;
  payloadRef?: string;
  sourceRef?: {
    type: "blueprint_run" | "node_run" | "inbox_item" | "system";
    id: string;
  };
  threadId?: string;
  revision: number;
  selectedReplyId?: string;
  replacesRequestId?: string;
  supersededByRequestId?: string;
  capabilities: ApprovalCapabilities;
  requestedBy: {
    type: "node" | "role" | "system";
    label: string;
    nodeId?: string;
    roleId?: string;
  };
  requestedAt: string;
  updatedAt?: string;
}

export type ApprovalDecisionAction =
  | "approve"
  | "reject"
  | "reply"
  | "complete"
  | "terminate"
  | "request_changes"
  | "revise"
  | "auto_approve"
  | "supersede";

export interface ApprovalDecision {
  id: string;
  approvalRequestId: string;
  action: ApprovalDecisionAction;
  actor: "user" | "system" | "manager";
  comment?: string;
  selectedReplyId?: string;
  resultingStatus: ApprovalRequestStatus;
  createdAt: string;
}

export interface IterationSession {
  id: string;
  runId: string;
  topManagerNodeId: string;
  blueprintSnapshotId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  maxRounds: number;
  currentRoundId?: string;
  createdAt: string;
  endedAt?: string;
}

export interface IterationRound {
  id: string;
  sessionId: string;
  runId: string;
  roundNumber: number;
  status:
    | "requirement_pending"
    | "requirement_approved"
    | "executing"
    | "artifact_published"
    | "report_pending"
    | "report_approved"
    | "completed"
    | "failed"
    | "cancelled";
  requirementRequestId?: string;
  approvedRequirementRequestId?: string;
  approvedRequirementRevision?: number;
  releaseReportRequestId?: string;
  artifactIds: string[];
  researchStatus?: "not_required" | "user_provided" | "context_sufficient" | "agent_generated" | "manager_fallback" | "assumption_based" | "blocked";
  researchSummary?: string;
  researchArtifactIds?: string[];
  planSource?: "user_provided" | "agent_generated" | "manager_fallback" | "revised_from_feedback";
  contextSnapshotId?: string;
  startedAt: string;
  endedAt?: string;
}

export interface ManagerContextSnapshot {
  id: string;
  runId: string;
  sessionId: string;
  roundId: string;
  version: number;
  sourceReportId?: string;
  completedItems: string[];
  rejectedOptions: string[];
  keyDecisions: string[];
  validatedFacts: string[];
  openQuestions: string[];
  activeRisks: string[];
  assumptions: string[];
  artifactRefs: Array<{
    artifactId: string;
    title: string;
    current: boolean;
  }>;
  recommendedNextStep: "research" | "plan" | "execute" | "complete";
  summary: string;
  freeform?: string;
  createdAt: string;
}

export interface ManagerMail {
  id: string;
  sourceType: "approval_request" | "artifact" | "system";
  sourceId: string;
  kind: string;
  status: string;
  title: string;
  body: string;
  capabilities: ApprovalCapabilities;
  relatedRunId?: string;
  relatedRoundId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Artifact {
  id: string;
  runId: string;
  roundId?: string;
  nodeRunId?: string;
  slot?: string;
  title?: string;
  kind: "html" | "markdown" | "json" | "file" | "link";
  format?: string;
  storagePath?: string;
  relativePath?: string;
  downloadUrl?: string;
  previewPolicy: "none" | "source" | "sandboxed_iframe";
  trusted: boolean;
  status?: "current" | "rejected" | "superseded";
  bytes?: number;
  sha256?: string;
  createdAt: string;
}

export interface ReleaseReport {
  id: string;
  runId: string;
  roundId: string;
  approvalRequestId: string;
  version: number;
  title: string;
  summary: string;
  artifactRefs: Array<{
    artifactId: string;
    title: string;
    location: string;
    current: boolean;
  }>;
  supersedesReportId?: string;
  createdAt: string;
}

export interface AgentHumanReport {
  id: string;
  runId: string;
  roundId?: string;
  managerRoundNumber?: number;
  nodeRunId: string;
  nodeId: string;
  nodeLabel: string;
  title: string;
  bodyMd: string;
  source: "agent" | "fallback";
  fallbackReason?: string;
  createdAt: string;
}

export interface AgentHandoff {
  id: string;
  runId: string;
  roundId?: string;
  nodeRunId: string;
  nodeId: string;
  payload: unknown;
  createdAt: string;
}

export interface AgentArtifactPayload {
  id?: string;
  slot?: string;
  title?: string;
  kind: Artifact["kind"];
  format?: string;
  previewPolicy?: Artifact["previewPolicy"];
  trusted?: boolean;
  content?: unknown;
  body?: unknown;
  path?: string;
  url?: string;
}

export interface AgentOutputEnvelope {
  contractVersion?: 2;
  humanReportMd?: string;
  handoffJson?: unknown;
  result?: unknown;
  artifacts?: AgentArtifactPayload[];
}

export interface RunTimelineItem {
  id: string;
  runId: string;
  sequence: number;
  createdAt: string;
  actorNodeId?: string;
  actorLabel: string;
  kind:
    | "round_started"
    | "requirement_published"
    | "approval_created"
    | "decision_created"
    | "node_started"
    | "node_runtime"
    | "node_output"
    | "artifact_published"
    | "release_report_published"
    | "round_completed"
    | "round_failed"
    | "round_cancelled"
    | "run_completed"
    | "run_failed"
    | "run_cancelled";
  title: string;
  body?: string;
  payloadRef?: string;
}

export const emptyApprovalCapabilities = Object.freeze({
  approve: false,
  reject: false,
  reply: false,
  complete: false,
  terminate: false,
  requestChanges: false,
  revise: false
}) satisfies ApprovalCapabilities;

export function resolveApprovalCapabilities(
  kind: ApprovalRequestKind,
  status: ApprovalRequestStatus = "pending",
  options: { finalRound?: boolean } = {}
): ApprovalCapabilities {
  if (status !== "pending") return { ...emptyApprovalCapabilities };

  switch (kind) {
    case "iteration_requirement_plan":
      return { approve: true, reject: true, reply: true, complete: false, terminate: false, requestChanges: false, revise: true };
    case "agent_proposal":
      return { approve: true, reject: true, reply: true, complete: false, terminate: false, requestChanges: true, revise: false };
    case "manager_release_report":
      return { approve: !options.finalRound, reject: true, reply: true, complete: true, terminate: false, requestChanges: false, revise: true };
    case "function_node":
      return { approve: true, reject: true, reply: true, complete: false, terminate: true, requestChanges: false, revise: false };
    case "blueprint_proposal":
    case "leader_delegation":
    case "company_config":
      return { approve: true, reject: true, reply: true, complete: false, terminate: false, requestChanges: false, revise: false };
    case "run_request":
      return { approve: true, reject: true, reply: true, complete: false, terminate: true, requestChanges: false, revise: false };
  }
}

export function capabilitiesAllow(capabilities: ApprovalCapabilities, action: ApprovalDecisionAction): boolean {
  if (action === "auto_approve") return capabilities.approve;
  if (action === "supersede") return true;
  if (action === "approve") return capabilities.approve;
  if (action === "reject") return capabilities.reject;
  if (action === "reply") return capabilities.reply;
  if (action === "complete") return capabilities.complete;
  if (action === "terminate") return capabilities.terminate;
  if (action === "request_changes") return capabilities.requestChanges === true;
  if (action === "revise") return capabilities.revise === true;
  return false;
}

export function approvalActionIsMessageOnly(action: ApprovalDecisionAction): boolean {
  return action === "reply";
}

export function approvalActionCanTriggerWorkflow(action: ApprovalDecisionAction): boolean {
  return action === "approve" ||
    action === "complete" ||
    action === "terminate" ||
    action === "request_changes" ||
    action === "revise" ||
    action === "auto_approve";
}

export function resolveApprovalThreadStatus(status: ApprovalRequestStatus): ApprovalThreadStatus {
  return status === "pending" ? "open" : "closed";
}

export function approvalThreadIdForRequest(request: Pick<ApprovalRequest, "id" | "threadId">): string {
  return request.threadId ?? request.id;
}

export function approvalThreadFromRequest(request: ApprovalRequest): ApprovalThread {
  return {
    id: approvalThreadIdForRequest(request),
    kind: request.kind,
    status: resolveApprovalThreadStatus(request.status),
    title: request.title,
    runId: request.runId,
    roundId: request.roundId,
    nodeRunId: request.nodeRunId,
    sourceRef: request.sourceRef,
    currentRequestId: request.status === "pending" ? request.id : undefined,
    currentRevision: request.revision,
    capabilities: request.capabilities,
    createdAt: request.requestedAt,
    updatedAt: request.updatedAt ?? request.requestedAt,
    closedAt: request.status === "pending" ? undefined : request.updatedAt ?? request.requestedAt
  };
}

export function normalizeRuntimeAccessPolicy(
  value: Partial<RuntimeAccessPolicy> | undefined,
  legacyPermissionProfile?: unknown
): RuntimeAccessPolicy {
  const filesystem = value?.filesystem === "workspace_write" || legacyPermissionProfile === "workspace_write"
    ? "workspace_write"
    : "read_only";
  const network = value?.network === "disabled" || value?.network === "enabled" ? value.network : "enabled";
  const webSearch = value?.webSearch === "disabled" || value?.webSearch === "live" ? value.webSearch : "disabled";
  return { filesystem, network, webSearch };
}

export function runtimeAccessPolicySupportForRuntime(runtime: RuntimeAccessPolicyRuntime): RuntimeAccessPolicySupport {
  return runtimeAccessPolicySupportByRuntime[runtime];
}

export function unsupportedRuntimeAccessPolicyChanges(
  runtime: RuntimeAccessPolicyRuntime,
  policy: RuntimeAccessPolicy
): string[] {
  const support = runtimeAccessPolicySupportForRuntime(runtime);
  const defaults: RuntimeAccessPolicy = {
    filesystem: "read_only",
    network: "enabled",
    webSearch: "disabled"
  };
  return (["filesystem", "network", "webSearch"] as const).filter((axis) =>
    support[axis] === "unsupported" && policy[axis] !== defaults[axis]
  );
}

export function runtimeAccessPolicyToPermissionProfile(policy: RuntimeAccessPolicy): "read_only" | "workspace_write" {
  return policy.filesystem;
}

export function lifecycleKindForNodeType(type: BlueprintNodeType): ApprovalRequestKind {
  return type === "agent" ? "agent_proposal" : "function_node";
}

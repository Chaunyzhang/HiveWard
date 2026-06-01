import { mkdir } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { RuntimeAdapter } from "@hiveward/adapter";
import {
  isAgentBlueprintNode,
  approvalThreadFromRequest,
  approvalThreadIdForRequest,
  resolveAgentRuntimeSource,
  isManagerSlotInnerInHandle,
  isManagerSlotInnerOutHandle,
  resolveCrossRoundContextMode,
  resolveManagerSlotExecutionMode,
  type AgentHandoff,
  type AgentHumanReport,
  type ChatStreamEvent,
  type AgentNodeConfig,
  type ApprovalReply,
  type AgentRuntimeId,
  type AgentTaskResult,
  type ConditionNodeConfig,
  type HarnessId,
  type HarnessSkillId,
  type HivewardChatSession,
  type LoopNodeConfig,
  type IterationRound,
  type IterationSession,
  type ManagerNodeConfig,
  type ManagerSlotNodeConfig,
  type RuntimeObjectRef,
  type StartAgentTaskInput,
  type InboxThreadType,
  type StreamInboxThreadMessageEvent,
  type Artifact,
  type ApprovalRequest,
  type ReleaseReport,
  type SummaryNodeConfig,
  type BlueprintDefinition,
  type BlueprintEdge,
  type BlueprintNode,
  type BlueprintNodeEvent,
  type BlueprintNodeRun,
  type BlueprintRun
} from "@hiveward/shared";
import type { HivewardStore } from "../store/hivewardStore";
import { ApprovalService, type ApprovalActionResult, type ApprovalRevisionDraft, type LifecycleApprovalOutcome } from "../services/lifecycleApprovalService";
import { ArtifactService } from "../services/artifactService";
import { IterationService } from "../services/iterationLifecycleService";
import { ManagerMailProjector } from "../services/managerMailProjector";
import { MigrationService } from "../services/runtimeAccessPolicyService";
import { AgentReportService } from "../services/agentReportService";
import { agentWorkspaceRefForNode, type AgentWorkspaceRef } from "../services/agentWorkspaceService";
import { ManagerContextService, type ManagerInjectedContext, type ManagerSnapshotDraft } from "../services/managerContextService";
import { RoundPreflightService, type RoundPreflightExecutionResult, type RoundPreflightMode } from "../services/roundPreflightService";
import { SelfIterationOrchestrator } from "../services/selfIterationOrchestrator";

const executableTypes = new Set([
  "agent",
  "manager",
  "manager_slot",
  "loop",
  "condition",
  "summary"
]);
const managerInHandlePrefix = "manager-in-";
const managerOutHandlePrefix = "manager-out-";
const defaultManagerAgentName = "manager";
const selfIterationPreparationSlotCount = 2;
const selfIterationRequirementInterfaceSlot = 2;
const managerRosterPromptBudget = 24000;
const managerRosterItemPromptBudget = 6000;
const managerReceiptPromptBudget = 6000;
const reviewOutputSelectionId = "reviewOutput";
const defaultManagerPrompt = [
  "You are a Hiveward manager agent.",
  "Route work inside the platform-provided Manager round by reading upstream input, previousResults, and delegationRoster.",
  "The platform owns round lifecycle state. You do not create, approve, or advance rounds.",
  "If there is no better instruction, run connected slots in ascending order.",
  "Return an AgentOutputEnvelope JSON object. Put status, roundNumber, nextSlot, and reason inside result; roundNumber must copy input.manager.roundNumber exactly.",
  "Use status=\"continue\" with nextSlot to delegate, or status=\"complete\" only when current-round delegation is done."
].join("\n");
const defaultSummaryHarnessPrompt = [
  "Perform a structured merge of the upstream node outputs.",
  "Preserve each upstream node label and output, deduplicate overlapping facts, and return the merged result in a clear structured form."
].join("\n");
const flexibleJsonObjectSchema: Record<string, unknown> = {
  type: ["object", "null"],
  properties: {
    summary: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          kind: { type: "string" },
          location: { type: "string" },
          description: { type: "string" }
        }
      }
    },
    assumptions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
    dataJson: { type: "string" },
    notes: { type: "string" }
  }
};
const agentArtifactPayloadSchema: Record<string, unknown> = {
  type: "array",
  description: "Optional address index for deliverables produced by this step. One agent may return many artifact items; prefer file paths or URLs so HiveWard can present them as links without expanding artifact bodies in reports.",
  items: {
    type: "object",
    description: "Top-level artifact address declaration. Prefer kind, title, path, or url when available; content/body are compatibility fallbacks for small inline payloads only, not the normal deliverable channel.",
    properties: {
      id: { type: "string" },
      slot: { type: "string" },
      title: { type: "string" },
      kind: { type: "string", description: "Artifact type hint, such as html, markdown, json, file, or link." },
      format: { type: "string" },
      previewPolicy: { type: "string", enum: ["none", "source", "sandboxed_iframe"] },
      trusted: { type: "boolean" },
      content: { type: "string", description: "Compatibility fallback for small inline payloads only. Do not put full deliverables here; write a file and return path or url instead." },
      body: { type: "string", description: "Alias for content, with the same compatibility-only guidance." },
      path: { type: "string", description: "Path to a generated file when available." },
      url: { type: "string", description: "External or local URL when available." }
    }
  }
};
const managerDecisionResultSchema: Record<string, unknown> = {
  type: "object",
  required: ["status", "reason", "roundNumber"],
  properties: {
    status: { type: "string" },
    roundNumber: { type: "integer" },
    nextSlot: { type: "integer" },
    routeToSlot: { type: "integer" },
    returnToSlot: { type: "integer" },
    targetSlot: { type: "integer" },
    reason: { type: "string" }
  }
};
const managerDecisionOutputSchema: Record<string, unknown> = {
  type: "object",
  required: ["humanReportMd", "result"],
  properties: {
    humanReportMd: { type: "string" },
    handoffJson: flexibleJsonObjectSchema,
    result: managerDecisionResultSchema
  }
};
const preflightResultSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    hardBlocker: { type: "boolean" },
    reason: { type: "string" },
    body: { type: "string" },
    summary: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    needsMoreResearch: { type: "boolean" },
    researchBrief: { type: "string" }
  }
};
const preflightOutputSchema: Record<string, unknown> = {
  type: "object",
  required: ["humanReportMd", "result"],
  properties: {
    humanReportMd: { type: "string" },
    handoffJson: flexibleJsonObjectSchema,
    result: preflightResultSchema,
    artifacts: agentArtifactPayloadSchema
  }
};
const agentOutputContractLines = [
  "Output contract:",
  "- Return an AgentOutputEnvelope JSON object when you produce a formal result. This prompt-level contract overrides earlier task wording such as \"return only JSON\" or \"do not return markdown\".",
  "- AgentOutputEnvelope is a transport wrapper. HiveWard preserves your answer even if the shape is imperfect, but you must still follow this output contract whenever the fields are available.",
  "- Include humanReportMd: a Markdown report written for a human reader. This field is required by the prompt contract, and humanReportMd is your free-form human answer.",
  "- Write humanReportMd in the natural style needed by the task. Keep useful narrative, judgment, reasoning, recommendations, and caveats instead of only filling fixed fields.",
  "- Write humanReportMd in the user's working language. If the user request, blueprint title, agent label, or runContext is Chinese, write Simplified Chinese. Do not default to English for human-facing reports.",
  "- All visible headings, labels, and prose inside humanReportMd must use that language. For Chinese reports, do not use English headings such as Decision, Summary, Validation, or Delivery location.",
  "- humanReportMd must be literal human-readable Markdown, not a JSON-encoded string, not an escaped string, and not a dump of the output envelope. Do not include visible escape sequences such as \\n, \\t, or JSON braces unless the task itself is to show JSON.",
  "- Before any other visible final content, humanReportMd must start with a visible summary section. For Chinese reports, use \"## \u6458\u8981\"; for English reports, use \"## Summary\". Write the summary yourself in plain human language, target 100-150 Chinese characters or similarly brief English, and do not describe internal program phases, raw workflow status, or generic process labels.",
  "- Immediately after the summary, humanReportMd must include a visible delivery-location section. For Chinese reports, use \"## \u4ea4\u4ed8\u4f4d\u7f6e\"; for English reports, use \"## Delivery location\". If this step created any deliverable, write a real file path, browser URL, or exact artifacts[] reference for each deliverable. Do not paste the deliverable body in this section. If there is no deliverable, write only \"\u65e0\" for Chinese or \"None\" for English.",
  "- When platform fields are available, fill them: humanReportMd for the human report, artifacts[] for generated artifact addresses, result for task-specific structured content, and handoffJson for downstream continuation context.",
  "- Include result for the task-specific result or artifact-producing content. If the task asked for strict JSON, put that strict JSON inside result while keeping humanReportMd readable.",
  "- When the task schema allows it, include concise hard fields in result such as status, summary, artifacts, and handoff. Do not embed large file bodies there.",
  "- If another agent, manager, or downstream node may continue from your work, include handoffJson with structured facts, decisions, artifact references, assumptions, risks, and suggested next steps.",
  "- If you created or referenced concrete deliverables, summarize them naturally in humanReportMd and declare their addresses in top-level artifacts[]. The report should point to artifacts, not contain their full bodies.",
  "- One step may declare many artifacts, including mixed HTML, Markdown, JSON, files, links, notes, and manifests. Use the shape that best represents your output.",
  "- Top-level artifacts[] is a publication hint and link/address index, not a quality gate. HiveWard will preserve declared artifacts when possible; Manager and downstream agents judge whether the content is useful.",
  "- For generated deliverables, create or update files and return path. For external or browser-openable references, return url. content/body are compatibility fallbacks for small inline snippets only; do not use them for full documents, HTML, source code, reports, or other long artifacts.",
  "- If input.agentWorkspace is present, put durable working files under input.agentWorkspace.artifactsPath and temporary files under input.agentWorkspace.tmpPath when that fits the task.",
  "- Do not paste artifact source, artifact HTML, long Markdown deliverables, source code deliverables, or other artifact bodies directly into humanReportMd or chat text. Put the content behind a file path or URL and give the human the link/address.",
  "- Keep handoffJson separate from humanReportMd. Do not require downstream agents to parse the Markdown report.",
  "- Raw logs and debugging details belong in result or runtime logs, not as the primary human report."
];
const humanReportEnvelopeSchemaBase: Record<string, unknown> = {
  type: "object",
  required: ["humanReportMd"],
  properties: {
    humanReportMd: { type: "string" },
    handoffJson: flexibleJsonObjectSchema,
    result: flexibleJsonObjectSchema,
    artifacts: agentArtifactPayloadSchema
  }
};
type IncomingEdgeState = "pending" | "satisfied" | "blocked";

interface ManagerReceiptArtifact {
  artifactId: string;
  title: string;
  kind: string;
  storagePath?: string;
  relativePath?: string;
  downloadUrl?: string;
  location?: string;
}

interface ManagerReceiptRoleContext {
  nodeId: string;
  nodeLabel: string;
  type: BlueprintNode["type"];
  description?: string;
  runtimeId?: string;
  openclawAgentId?: string;
  agentName?: string;
  systemPrompt?: string;
  userPrompt?: string;
  promptTruncated?: boolean;
  promptVisibility: "ai_only";
  agentWorkspace?: AgentWorkspaceRef;
}

interface ExecutorDiscussionTarget {
  actor: "agent" | "manager";
  taskInput: StartAgentTaskInput;
  metadata: Record<string, unknown>;
}

type InboxDiscussionMode = "reply" | "candidate";

interface InboxDiscussionChatResult {
  status: Extract<ChatStreamEvent, { type: "done" }>["status"];
  output?: string;
  error?: string;
  doneEvent?: Extract<ChatStreamEvent, { type: "done" }>;
  runtime: Record<string, unknown>;
}

interface ManagerResultReceipt {
  nodeRunId: string;
  nodeId: string;
  nodeLabel: string;
  status: BlueprintNodeRun["status"];
  valid: boolean;
  invalidReason?: string;
  humanReportId?: string;
  humanReportMd?: string;
  handoffJson?: unknown;
  artifacts: ManagerReceiptArtifact[];
  roleContexts: ManagerReceiptRoleContext[];
  outputSummary?: string;
}

interface ManagerTraceItem {
  handoff: number;
  slot: number;
  nodeId: string;
  nodeLabel: string;
  status: AgentTaskResult["status"];
  output?: unknown;
  error?: string;
  returnEdgePresent: boolean;
  managerDecision?: ManagerDecision;
  decision?: ManagerDecision;
  receipt?: ManagerResultReceipt;
}

interface ManagerDecision {
  status: "continue" | "retry" | "complete";
  roundNumber?: number;
  nextSlot?: number;
  reason?: string;
}

interface AgentApprovalReply {
  id: string;
  role: "assistant" | "user";
  body: string;
  createdAt: string;
  selected?: boolean;
  canUseAsSolution?: boolean;
}

interface AgentApprovalWaitingOutput {
  approvalType: "agent";
  reviewOutput: unknown;
  replies: AgentApprovalReply[];
  selectedReplyId?: string;
  selectedOutput?: unknown;
}

interface AgentApprovalChatInput {
  previousOutput: unknown;
  latestUserReply: string;
  conversation: AgentApprovalReply[];
  instruction: string;
  requestedOutput: InboxDiscussionMode;
  candidateRequested: boolean;
}

interface ApprovedAgentOutputEnvelope {
  approvedOutput: unknown;
  approval: {
    status: "approved";
    comment?: string;
    replies: AgentApprovalReply[];
    selectedReplyId?: string;
  };
}

interface PendingApprovalRevisionContext {
  threadId?: string;
  replacesRequestId?: string;
  revision?: number;
  requestedChanges?: string;
}

interface RequirementRevisionDraft extends ApprovalRevisionDraft {
  metadata: Pick<IterationRound, "researchStatus" | "researchSummary" | "researchArtifactIds" | "planSource" | "contextSnapshotId">;
}

interface ManagerSlotContext {
  manager: {
    nodeId: string;
    nodeLabel: string;
    instructions?: string;
    roundNumber: number;
    slot: number;
    handoff: number;
    maxHandoffs: number;
  };
  upstream: UpstreamOutput;
  managerDecision?: ManagerDecision;
  previousResults: Array<{
    handoff: number;
    slot: number;
    nodeId: string;
    nodeLabel: string;
    status: AgentTaskResult["status"];
    error?: string;
    decision?: ManagerDecision;
    receipt?: ManagerResultReceipt;
  }>;
}

interface UpstreamArtifactRef {
  artifactId: string;
  title: string;
  kind: string;
  storagePath?: string;
  relativePath?: string;
  downloadUrl?: string;
  location?: string;
}

interface UpstreamReportRef {
  humanReportId: string;
  title: string;
  bodyMd: string;
  source: string;
}

interface UpstreamOutputItem {
  nodeId: string;
  nodeLabel: string;
  nodeRunId: string;
  status: BlueprintNodeRun["status"];
  output?: unknown;
  handoffJson?: unknown;
  humanReportId?: string;
  humanReportMd?: string;
  report?: UpstreamReportRef;
  artifacts?: UpstreamArtifactRef[];
  outputSummary?: string;
  context?: unknown;
  runtimeRef?: RuntimeObjectRef;
}

type UpstreamOutput = UpstreamOutputItem[];

interface StandardNodeInput {
  upstream: UpstreamOutput;
}

type SelfIterationPublishResult = "none" | "continue" | "handled";

interface AutoAdvanceResult {
  run: BlueprintRun;
  changed: boolean;
  resumeExecution: boolean;
  completeRun: boolean;
}

interface BlueprintWorkerOptions {
  artifactRoot?: string;
  workerId?: string;
  nodeRunLeaseMs?: number;
}

export class InboxDiscussionInProgressError extends Error {
  readonly statusCode = 409;
  readonly code = "inbox_discussion_in_progress";

  constructor() {
    super("Inbox discussion is already streaming for this thread.");
    this.name = "InboxDiscussionInProgressError";
  }
}

interface StreamInboxThreadMessageInput {
  threadType: InboxThreadType;
  threadId: string;
  message: string;
  onEvent: (event: StreamInboxThreadMessageEvent) => void;
}

interface StreamInboxThreadMessageResult {
  threadType: InboxThreadType;
  threadId: string;
  userMessageId: string;
  assistantMessageId?: string;
}

interface NodeRuntimeTimelineState {
  id: string;
  sequence?: number;
  output: string;
  runtimeStatus?: string;
  runtimeLabel?: string;
  error?: string;
  completedAt?: string;
}

export class BlueprintWorker {
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly pendingRunSchedules = new Map<string, { blueprint: BlueprintDefinition; run: BlueprintRun }>();
  private readonly cancelledRunIds = new Set<string>();
  private readonly approvalService: ApprovalService;
  private readonly iterationService: IterationService;
  private readonly artifactService: ArtifactService;
  private readonly agentReportService: AgentReportService;
  private readonly managerContextService: ManagerContextService;
  private readonly roundPreflightService: RoundPreflightService;
  private readonly managerMailProjector: ManagerMailProjector;
  private readonly migrationService: MigrationService;
  private readonly selfIterationOrchestrator: SelfIterationOrchestrator;
  private readonly workerId: string;
  private readonly nodeRunLeaseMs: number;
  private readonly nodeRunClaims = new Map<string, { owner: string; workerEpoch: number }>();
  private readonly pendingApprovalRevisionContexts = new Map<string, PendingApprovalRevisionContext>();
  private readonly activeInboxThreadStreams = new Set<string>();

  constructor(
    private readonly store: HivewardStore,
    private readonly adapter: RuntimeAdapter,
    options: BlueprintWorkerOptions = {}
  ) {
    this.approvalService = new ApprovalService(store);
    this.iterationService = new IterationService(store, this.approvalService);
    this.artifactService = new ArtifactService(store, { rootDir: options.artifactRoot });
    this.agentReportService = new AgentReportService(store);
    this.managerContextService = new ManagerContextService(store);
    this.roundPreflightService = new RoundPreflightService(this.managerContextService);
    this.managerMailProjector = new ManagerMailProjector(store);
    this.migrationService = new MigrationService(store, this.approvalService);
    this.selfIterationOrchestrator = new SelfIterationOrchestrator();
    this.workerId = options.workerId ?? `worker-${nanoid(8)}`;
    this.nodeRunLeaseMs = options.nodeRunLeaseMs ?? 30 * 60 * 1000;
  }

  async resumeActiveRuns(): Promise<void> {
    const archives = await this.store.listRunArchives();
    for (const archive of archives) {
      if (archive.run.status === "queued") {
        const runningRun = { ...archive.run, status: "running" as const };
        await this.store.updateBlueprintRun(runningRun);
        this.scheduleRun(archive.blueprintSnapshot, runningRun);
        continue;
      }
      if (archive.run.status === "running") {
        if (await this.resumeSelfIterationPreparationIfNeeded(archive.blueprintSnapshot, archive.run)) {
          continue;
        }
        this.scheduleRun(archive.blueprintSnapshot, archive.run);
      }
    }
  }

  async startRun(blueprint: BlueprintDefinition, startedBy: string): Promise<BlueprintRun> {
    const run = await this.store.createBlueprintRun(blueprint, startedBy);
    const runningRun = {
      ...run,
      status: "running" as const
    };
    await this.store.updateBlueprintRun(runningRun);
    await this.event(runningRun.id, "blueprint.run.started", `Blueprint ${blueprint.name} started.`);
    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (topManager) {
      const { session, round } = await this.iterationService.startSession({
        blueprint,
        run: runningRun,
        topManagerNode: topManager
      });
      this.scheduleSelfIterationPreparation(blueprint, runningRun, session, round, topManager);
      return runningRun;
    }
    this.scheduleRun(blueprint, runningRun);
    return runningRun;
  }

  async applyApprovalRequest(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    approvalRequestId: string,
    action: "approve" | "reject" | "reply" | "complete" | "terminate" | "request_changes" | "revise",
    input: { comment?: string; message?: string; selectedReplyId?: string } = {}
  ): Promise<BlueprintRun> {
    const request = await this.store.getApprovalRequest(approvalRequestId);
    if (!request) throw new Error(`Approval request not found: ${approvalRequestId}`);
    if (request.runId !== run.id) {
      throw new Error("Approval request does not belong to this run.");
    }
    const latestRun = await this.store.getBlueprintRun(request.runId);
    const currentRun = latestRun ?? run;
    if (this.isTerminalRunStatus(currentRun.status)) {
      throw new Error("Run is already finished.");
    }

    if (action === "reply") {
      await this.approvalService.recordPendingReply(approvalRequestId, input.message ?? "");
      if (request.kind === "agent_proposal" && request.nodeRunId) {
        await this.recordAgentApprovalComment(currentRun, request.nodeRunId, input.message ?? "");
      }
      await this.managerMailProjector.refresh(run.id);
      const waiting = { ...currentRun, status: "waiting_approval" as const };
      await this.store.updateBlueprintRun(waiting);
      return waiting;
    }

    let requirementRevisionMetadata: RequirementRevisionDraft["metadata"] | undefined;
    let result: ApprovalActionResult;
    if (action === "approve") {
      result = await this.approvalService.approve(approvalRequestId, input.comment, input.selectedReplyId);
    } else if (action === "reject") {
      result = await this.approvalService.reject(approvalRequestId, input.comment);
    } else if (action === "complete") {
      result = await this.approvalService.complete(approvalRequestId, input.comment);
    } else if (action === "request_changes") {
      result = await this.approvalService.requestChanges(approvalRequestId, input.comment ?? input.message ?? "");
      if (request.kind === "agent_proposal" && request.nodeRunId) {
        await this.rerunAgentApprovalForRequestedChanges(blueprint, currentRun, request, result.approvalRequest, input.comment ?? input.message ?? "");
        await this.managerMailProjector.refresh(run.id);
        const latestRun = await this.store.getBlueprintRun(run.id);
        const waiting = { ...(latestRun ?? currentRun), status: "waiting_approval" as const };
        await this.store.updateBlueprintRun(waiting);
        return waiting;
      }
    } else if (action === "revise") {
      const message = input.message ?? input.comment ?? "";
      if (request.kind === "iteration_requirement_plan") {
        const draft = await this.buildRequirementDecisionRevision(blueprint, currentRun, request, message);
        requirementRevisionMetadata = draft.metadata;
        result = await this.approvalService.revise(approvalRequestId, message, draft);
      } else if (request.kind === "manager_release_report") {
        const draft = await this.buildManagerReleaseReportRevision(blueprint, currentRun, request, message);
        result = await this.approvalService.revise(approvalRequestId, message, draft);
      } else {
        result = await this.approvalService.revise(approvalRequestId, message);
      }
    } else {
      result = await this.approvalService.terminate(approvalRequestId, input.comment);
    }

    const lifecycle = await this.iterationService.handleApprovalResult(result);
    if (requirementRevisionMetadata && result.nextApprovalRequest?.roundId) {
      const round = (await this.store.listIterationRounds({ runId: result.nextApprovalRequest.runId }))
        .find((candidate) => candidate.id === result.nextApprovalRequest?.roundId);
      if (round) {
        await this.store.upsertIterationRound({
          ...round,
          ...requirementRevisionMetadata
        });
      }
    }
    await this.persistManagerSnapshotAfterReleaseDecision(blueprint, currentRun, result);
    await this.managerMailProjector.refresh(run.id);

    if (request.kind === "agent_proposal" && request.nodeRunId) {
      if (action === "approve") return this.approveRun(blueprint, currentRun, request.nodeRunId, input.comment, input.selectedReplyId);
    }

    if (!lifecycle.completeRun && !lifecycle.resumeExecution) {
      if (lifecycle.prepareNextRound) {
        await this.prepareNextRoundFromIntent(blueprint, currentRun, lifecycle.prepareNextRound);
        await this.managerMailProjector.refresh(run.id);
      }
      const autoAdvanced = await this.autoAdvanceSelfIterationApprovals(blueprint, currentRun);
      if (autoAdvanced) {
        return autoAdvanced.run;
      }
    }

    if (lifecycle.completeRun) {
      const completed = await this.applyRunTotals(currentRun, new Date(currentRun.startedAt).getTime(), "succeeded");
      await this.store.updateBlueprintRun(completed);
      return completed;
    }
    if (lifecycle.resumeExecution) {
      const running = { ...currentRun, status: "running" as const };
      await this.store.updateBlueprintRun(running);
      this.scheduleRun(blueprint, running);
      return running;
    }

    const waiting = { ...currentRun, status: "waiting_approval" as const };
    await this.store.updateBlueprintRun(waiting);
    return waiting;
  }

  private async resumeSelfIterationPreparationIfNeeded(blueprint: BlueprintDefinition, run: BlueprintRun): Promise<boolean> {
    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager) return false;

    const rounds = await this.store.listIterationRounds({ runId: run.id });
    const pendingRound = rounds
      .filter((round) => round.status === "requirement_pending")
      .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())[0];
    if (!pendingRound) {
      if (rounds.length > 0) return false;
      const started = await this.iterationService.startSession({
        blueprint,
        run,
        topManagerNode: topManager
      });
      this.scheduleSelfIterationPreparation(blueprint, run, started.session, started.round, topManager);
      return true;
    }

    if (pendingRound.requirementRequestId) {
      await this.store.updateBlueprintRun({ ...run, status: "waiting_approval" as const });
      await this.managerMailProjector.refresh(run.id);
      return true;
    }

    const session = (await this.store.listIterationSessions(run.id)).find((candidate) => candidate.id === pendingRound.sessionId);
    if (!session) return false;
    this.scheduleSelfIterationPreparation(blueprint, run, session, pendingRound, topManager);
    return true;
  }

  private scheduleSelfIterationPreparation(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    session: IterationSession,
    round: IterationRound,
    topManager: BlueprintNode
  ): void {
    if (this.activeRuns.has(run.id)) {
      return;
    }

    const execution = this.prepareInitialSelfIterationRound(blueprint, run, session, round, topManager)
      .catch((error) => this.handleBackgroundRunError(blueprint, run, error))
      .finally(async () => {
        this.activeRuns.delete(run.id);
        if (await this.flushPendingRunSchedule(run.id)) {
          return;
        }
        this.cancelledRunIds.delete(run.id);
      });

    this.activeRuns.set(run.id, execution);
  }

  private async prepareInitialSelfIterationRound(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    session: IterationSession,
    round: IterationRound,
    topManager: BlueprintNode
  ): Promise<void> {
    if (await this.isRunCancelled(run.id)) return;

    await this.prepareRoundPlan(blueprint, run, session, round, topManager);
    if (await this.isRunCancelled(run.id)) return;

    const latestRun = await this.store.getBlueprintRun(run.id);
    const currentRun = latestRun ?? run;
    if (this.isTerminalRunStatus(currentRun.status)) return;

    const autoAdvanced = await this.autoAdvanceSelfIterationApprovals(blueprint, currentRun, { scheduleOnResume: false });
    if (autoAdvanced?.completeRun) return;
    if (autoAdvanced?.resumeExecution) {
      await this.runUntilBlockedOrDone(blueprint, autoAdvanced.run);
      return;
    }
    if (await this.isRunCancelled(run.id)) return;

    const waitingBase = (await this.store.getBlueprintRun(run.id)) ?? currentRun;
    if (this.isTerminalRunStatus(waitingBase.status)) return;
    const waitingRun = { ...waitingBase, status: "waiting_approval" as const };
    await this.store.updateBlueprintRun(waitingRun);
    await this.managerMailProjector.refresh(waitingRun.id);
  }

  private async prepareNextRoundFromIntent(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    intent: NonNullable<LifecycleApprovalOutcome["prepareNextRound"]>
  ): Promise<void> {
    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager) throw new Error("Self-iteration manager not found.");
    const session = (await this.store.listIterationSessions(run.id)).find((candidate) => candidate.id === intent.sessionId);
    if (!session) throw new Error(`Iteration session not found: ${intent.sessionId}`);
    const round = (await this.store.listIterationRounds({ runId: run.id })).find((candidate) => candidate.id === intent.roundId);
    if (!round) throw new Error(`Iteration round not found: ${intent.roundId}`);
    await this.prepareRoundPlan(blueprint, run, session, round, topManager, {
      humanFeedback: intent.humanFeedback
    });
  }

  private async persistManagerSnapshotAfterReleaseDecision(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    result: ApprovalActionResult
  ): Promise<void> {
    if (result.approvalRequest.kind !== "manager_release_report") return;
    if (
      result.decision.action !== "approve" &&
      result.decision.action !== "auto_approve" &&
      result.decision.action !== "complete"
    ) {
      return;
    }
    if (!result.approvalRequest.roundId) return;

    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager) return;
    const rounds = await this.store.listIterationRounds({ runId: run.id });
    const round = rounds.find((candidate) => candidate.id === result.approvalRequest.roundId);
    if (!round || round.contextSnapshotId) return;
    const session = (await this.store.listIterationSessions(run.id)).find((candidate) => candidate.id === round.sessionId);
    if (!session) return;

    const releaseReport = await this.releaseReportForApprovalRequest(run.id, result.approvalRequest);
    const humanFeedback = await this.approvalService.buildApprovalHumanFeedback(result.approvalRequest, result.decision);
    const managerSummary = releaseReport
      ? await this.buildManagerSnapshotDraft(
        blueprint,
        run,
        session,
        round,
        topManager,
        releaseReport,
        humanFeedback
      )
      : undefined;
    const latestRound = (await this.store.listIterationRounds({ runId: run.id }))
      .find((candidate) => candidate.id === round.id);
    if (!latestRound || latestRound.contextSnapshotId) return;
    const snapshot = await this.managerContextService.createSnapshotFromRoundResult({
      run,
      session,
      round: latestRound,
      releaseReport,
      humanFeedback,
      managerSummary
    });
    await this.store.upsertIterationRound({ ...latestRound, contextSnapshotId: snapshot.id });
  }

  private async releaseReportForApprovalRequest(
    runId: string,
    request: ApprovalRequest
  ): Promise<ReleaseReport | undefined> {
    const reports = await this.store.listReleaseReports(runId);
    const byPayload = request.payloadRef
      ? reports.find((report) => report.id === request.payloadRef)
      : undefined;
    if (byPayload) return byPayload;
    const byApproval = reports.find((report) => report.approvalRequestId === request.id);
    if (byApproval) return byApproval;
    return request.roundId
      ? reports.filter((report) => report.roundId === request.roundId).at(-1)
      : undefined;
  }

  private async prepareRoundPlan(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    session: IterationSession,
    round: IterationRound,
    topManager: BlueprintNode,
    context: {
      humanFeedback?: string;
      previousRequirement?: string;
      revision?: number;
    } = {}
  ): Promise<ApprovalRequest> {
    const preflight = await this.roundPreflightService.prepareRoundPlan({
      blueprint,
      run,
      session,
      round,
      topManagerNode: topManager,
      humanFeedback: context.humanFeedback,
      previousRequirement: context.previousRequirement,
      revision: context.revision,
      executors: this.buildRoundPreflightExecutors(blueprint, run, round, topManager)
    });
    const request = await this.iterationService.requestRoundPlan({
      session,
      round,
      managerNode: topManager,
      body: preflight.body,
      revision: context.revision,
      metadata: {
        researchStatus: preflight.researchStatus,
        researchSummary: preflight.researchSummary,
        researchArtifactIds: preflight.researchArtifactIds,
        planSource: preflight.planSource
      }
    });
    await this.managerMailProjector.refresh(run.id);
    return request;
  }

  private buildRoundPreflightExecutors(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    round: IterationRound,
    topManager: BlueprintNode
  ) {
    return {
      runAgentNode: (input: {
        node: BlueprintNode & { type: "agent"; config: AgentNodeConfig };
        mode: RoundPreflightMode;
        runContext: ManagerInjectedContext;
        taskInput: Record<string, unknown>;
      }) => this.runPreflightAgentTask(blueprint, run, round, input.node, input.mode, input.runContext, input.taskInput),
      runManagerFallback: (input: {
        mode: RoundPreflightMode;
        runContext: ManagerInjectedContext;
        taskInput: Record<string, unknown>;
      }) => this.runPreflightManagerFallback(blueprint, run, round, topManager, input.mode, input.runContext, input.taskInput)
    };
  }

  private async runPreflightAgentTask(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    round: IterationRound,
    node: BlueprintNode & { type: "agent"; config: AgentNodeConfig },
    mode: RoundPreflightMode,
    runContext: ManagerInjectedContext,
    taskInput: Record<string, unknown>
  ): Promise<RoundPreflightExecutionResult> {
    const config = node.config;
    const runtimeId = node.runtimeId ?? "openclaw";
    const nodeRunId = `preflight-${mode}-${round.id}-${node.id}-${nanoid(6)}`;
    const preflightNode = await this.startPreflightNodeRun(blueprint, run, round, node, nodeRunId);
    await this.appendPreflightTaskStarted(run, round, node, mode, nodeRunId);
    let result: AgentTaskResult;
    try {
      ({ result } = await this.runAgentTask({
        blueprintRunId: run.id,
        nodeRunId,
        source: resolveAgentRuntimeSource(runtimeId),
        agentId: runtimeId === "openclaw" ? config.openclawAgentId ?? "main" : undefined,
        profileId: runtimeId === "hermes" ? config.profileId : undefined,
        agentName: config.agentName,
        prompt: this.resolveAgentPrompt(config, { requiresHandoff: true }),
        modelId: config.modelId,
        permissionProfile: config.permissionProfile,
        runtimeAccessPolicy: config.runtimeAccessPolicy,
        workingDirectory: config.workingDirectory,
        timeoutMs: config.timeoutMs,
        outputSchema: config.outputSchema ? buildAgentOutputEnvelopeSchema(config.outputSchema) : preflightOutputSchema,
        input: {
          ...taskInput,
          runContext
        },
        skillIds: config.skillIds,
        tools: config.tools
      }, async (runtimeRef) => {
        await this.store.startNodeRun({
          nodeRunId,
          owner: preflightNode.claim.owner,
          workerEpoch: preflightNode.claim.workerEpoch,
          runtimeRef
        });
      }));
    } catch (error) {
      await this.failPreflightNodeRun(preflightNode.nodeRun, preflightNode.claim, error instanceof Error ? error.message : String(error));
      await this.appendPreflightTaskFailed(run, round, node, mode, nodeRunId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (result.status !== "succeeded") {
      const error = result.error ?? `Agent task ended with status ${result.status}.`;
      await this.failPreflightNodeRun(preflightNode.nodeRun, preflightNode.claim, error);
      await this.appendPreflightTaskFailed(run, round, node, mode, nodeRunId, error);
    }
    const artifactIds = mode === "research_resolution"
      ? await this.publishPreflightOutput(blueprint, run, round, node, preflightNode, mode, result)
      : [];
    if (result.status === "succeeded" && mode !== "research_resolution") {
      await this.publishPreflightOutput(blueprint, run, round, node, preflightNode, mode, result);
    }
    return { result, artifactIds };
  }

  private async runPreflightManagerFallback(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    round: IterationRound,
    topManager: BlueprintNode,
    mode: RoundPreflightMode,
    runContext: ManagerInjectedContext,
    taskInput: Record<string, unknown>
  ): Promise<RoundPreflightExecutionResult> {
    const config = topManager.config as ManagerNodeConfig;
    const runtimeId = this.resolveManagerRuntimeId(topManager);
    const nodeRunId = `preflight-${mode}-${round.id}-${topManager.id}-${nanoid(6)}`;
    const preflightNode = await this.startPreflightNodeRun(blueprint, run, round, topManager, nodeRunId);
    await this.appendPreflightTaskStarted(run, round, topManager, mode, nodeRunId);
    let result: AgentTaskResult;
    try {
      ({ result } = await this.runAgentTask({
        blueprintRunId: run.id,
        nodeRunId,
        source: resolveAgentRuntimeSource(runtimeId),
        agentId: runtimeId === "openclaw" ? config.openclawAgentId ?? "main" : undefined,
        profileId: runtimeId === "hermes" ? config.profileId : undefined,
        agentName: config.agentName?.trim() || defaultManagerAgentName,
        prompt: this.resolveManagerPreflightPrompt(config, mode),
        modelId: config.modelId,
        permissionProfile: config.permissionProfile,
        runtimeAccessPolicy: config.runtimeAccessPolicy,
        workingDirectory: config.workingDirectory,
        timeoutMs: config.timeoutMs,
        outputSchema: mode === "context_snapshot" ? undefined : preflightOutputSchema,
        input: {
          ...taskInput,
          runContext
        },
        skillIds: config.skillIds,
        tools: config.tools ?? []
      }, async (runtimeRef) => {
        await this.store.startNodeRun({
          nodeRunId,
          owner: preflightNode.claim.owner,
          workerEpoch: preflightNode.claim.workerEpoch,
          runtimeRef
        });
      }));
    } catch (error) {
      await this.failPreflightNodeRun(preflightNode.nodeRun, preflightNode.claim, error instanceof Error ? error.message : String(error));
      await this.appendPreflightTaskFailed(run, round, topManager, mode, nodeRunId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (result.status !== "succeeded") {
      const error = result.error ?? `Agent task ended with status ${result.status}.`;
      await this.failPreflightNodeRun(preflightNode.nodeRun, preflightNode.claim, error);
      await this.appendPreflightTaskFailed(run, round, topManager, mode, nodeRunId, error);
    }
    const artifactIds = mode === "research_resolution"
      ? await this.publishPreflightOutput(blueprint, run, round, topManager, preflightNode, mode, result)
      : [];
    if (result.status === "succeeded" && mode !== "research_resolution") {
      await this.publishPreflightOutput(blueprint, run, round, topManager, preflightNode, mode, result);
    }
    return { result, artifactIds };
  }

  private async startPreflightNodeRun(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    round: IterationRound,
    node: BlueprintNode,
    nodeRunId: string
  ): Promise<{ nodeRun: BlueprintNodeRun; claim: { owner: string; workerEpoch: number } }> {
    const now = new Date().toISOString();
    const nodeRun: BlueprintNodeRun = {
      id: nodeRunId,
      blueprintRunId: run.id,
      blueprintId: blueprint.id,
      iterationRoundId: round.id,
      nodeId: node.id,
      nodeLabel: node.config.label,
      nodeType: node.type,
      status: "queued",
      queuedAt: now
    };
    await this.store.createQueuedNodeRun(nodeRun);
    const claim = await this.store.claimNodeRun({
      nodeRunId,
      owner: this.workerId,
      leaseMs: this.nodeRunLeaseMs
    });
    if (!claim.claimed || claim.workerEpoch === undefined) {
      throw new Error(`Unable to claim preflight node run ${nodeRunId}.`);
    }
    const token = { owner: this.workerId, workerEpoch: claim.workerEpoch };
    this.nodeRunClaims.set(nodeRunId, token);
    return { nodeRun, claim: token };
  }

  private async failPreflightNodeRun(
    nodeRun: BlueprintNodeRun,
    claim: { owner: string; workerEpoch: number },
    error: string
  ): Promise<void> {
    await this.store.failNodeRun({
      nodeRunId: nodeRun.id,
      owner: claim.owner,
      workerEpoch: claim.workerEpoch,
      error
    });
    this.nodeRunClaims.delete(nodeRun.id);
  }

  private async appendPreflightTaskStarted(
    run: BlueprintRun,
    round: IterationRound,
    node: BlueprintNode,
    mode: RoundPreflightMode,
    nodeRunId: string
  ): Promise<void> {
    await this.store.appendRunTimelineItem({
      id: `timeline-${nodeRunId}-started`,
      runId: run.id,
      createdAt: new Date().toISOString(),
      actorNodeId: node.id,
      actorLabel: node.config.label,
      kind: "node_started",
      title: `${node.config.label}: ${this.preflightModeLabel(mode)} started`,
      body: `Round ${round.roundNumber} preflight is running ${this.preflightModeLabel(mode)}.`,
      payloadRef: nodeRunId
    });
  }

  private async appendPreflightTaskFailed(
    run: BlueprintRun,
    round: IterationRound,
    node: BlueprintNode,
    mode: RoundPreflightMode,
    nodeRunId: string,
    error: string
  ): Promise<void> {
    await this.store.appendRunTimelineItem({
      id: `timeline-${nodeRunId}-failed`,
      runId: run.id,
      createdAt: new Date().toISOString(),
      actorNodeId: node.id,
      actorLabel: node.config.label,
      kind: "node_output",
      title: `${node.config.label}: ${this.preflightModeLabel(mode)} failed`,
      body: error,
      payloadRef: nodeRunId
    });
  }

  private preflightModeLabel(mode: RoundPreflightMode): string {
    if (mode === "research_resolution") return "research";
    if (mode === "requirement_resolution") return "requirement planning";
    if (mode === "revise_plan") return "plan revision";
    if (mode === "preflight_judgment") return "plan review";
    if (mode === "context_snapshot") return "context snapshot";
    return "preflight";
  }

  private async publishPreflightOutput(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    round: IterationRound,
    node: BlueprintNode,
    preflightNode: { nodeRun: BlueprintNodeRun; claim: { owner: string; workerEpoch: number } },
    mode: RoundPreflightMode,
    result: AgentTaskResult
  ): Promise<string[]> {
    if (result.status !== "succeeded" || result.output === undefined || result.output === null) return [];
    const now = new Date().toISOString();
    const completed: BlueprintNodeRun = {
      ...preflightNode.nodeRun,
      status: "succeeded",
      startedAt: preflightNode.nodeRun.startedAt ?? now,
      endedAt: now,
      output: result.output,
      usage: result.usage,
      runtimeRef: result.taskId
        ? {
          source: result.source,
          sourceId: result.taskId,
          sourceUpdatedAt: result.updatedAt,
          taskId: result.taskId,
          runId: result.runId,
          sessionKey: result.sessionKey,
          usageRef: result.usage?.id
        }
        : preflightNode.nodeRun.runtimeRef
    };
    const artifacts = mode === "research_resolution" ? await this.artifactService.prepareFromNodeRun({
      runId: run.id,
      roundId: round.id,
      nodeRun: completed
    }) : [];
    const reports = this.agentReportService.prepareFromOutput({
      runId: run.id,
      roundId: round.id,
      nodeRunId: completed.id,
      nodeId: node.id,
      nodeLabel: node.config.label,
      output: result.output,
      createdAt: now
    });
    const timelineItems = [
      {
        id: `timeline-${completed.id}-output`,
        runId: run.id,
        createdAt: now,
        actorNodeId: node.id,
        actorLabel: node.config.label,
        kind: "node_output" as const,
        title: `${node.config.label}: ${this.preflightModeLabel(mode)} completed`,
        payloadRef: completed.id
      },
      ...artifacts.map((artifact) => ({
        id: `timeline-${artifact.id}`,
        runId: run.id,
        createdAt: now,
        actorNodeId: node.id,
        actorLabel: node.config.label,
        kind: "artifact_published" as const,
        title: artifact.title ?? artifact.kind,
        body: artifact.downloadUrl ?? artifact.relativePath ?? artifact.storagePath,
        payloadRef: artifact.id
      }))
    ];
    const published = await this.store.publishAgentOutput({
      runId: run.id,
      roundId: round.id,
      nodeRunId: completed.id,
      owner: preflightNode.claim.owner,
      workerEpoch: preflightNode.claim.workerEpoch,
      nodeRun: completed,
      output: result.output,
      rawResult: result.output,
      artifacts,
      humanReport: reports.humanReport,
      handoff: reports.handoff,
      event: {
        id: `event-${completed.id}-completed`,
        blueprintRunId: run.id,
        nodeRunId: completed.id,
        type: "node.run.completed",
        message: `${node.config.label} ${this.preflightModeLabel(mode)} completed.`,
        runtimeRef: completed.runtimeRef,
        createdAt: now
      },
      timelineItems
    });
    if (!published.published) {
      throw new Error(`Preflight node run ${completed.id} could not publish atomically.`);
    }
    this.nodeRunClaims.delete(completed.id);
    return artifacts.map((artifact) => artifact.id);
  }

  private resolveManagerPreflightPrompt(
    config: ManagerNodeConfig,
    mode: RoundPreflightMode
  ): string {
    const modeInstruction = mode === "research_resolution"
      ? [
          "This is the mandatory system research step for a self-iteration round. It must run before requirement planning even when the answer is that no extra research is needed.",
          "Ordinary user-connected Manager slots are not substitutes for this system step. If no explicit system research agent is configured, you as Manager perform the step yourself.",
          "Perform the round research pass; do not treat this as a bare sufficiency check.",
          "If input.roundNumber is 1, absence of previousResults, lastRound, existing artifacts, previous feedback, or prior research is normal startup context, not a blocker and not an excuse to stop.",
          "For round 1, build the first research baseline from the blueprint goal and available sources. Use external web/live research when available; if it is unavailable, state that limitation and use local repository/artifact inspection plus stable domain knowledge.",
          "Do not answer that the goal is too broad unless no useful baseline can be produced. Narrow broad goals into concrete facts, constraints, risks, acceptance criteria, and execution inputs.",
          "You may decide no additional research is needed only by returning an explicit research result with rationale; never silently skip this step.",
          "Put facts, assumptions, risks, research conclusions, and hardBlocker in result only when execution truly cannot continue."
        ].join(" ")
      : mode === "preflight_judgment"
        ? "Semantically judge whether the draft round execution plan can proceed or needs another research pass. Put needsMoreResearch, reason, optional researchBrief, and optional hardBlocker inside result."
        : mode === "context_snapshot"
          ? "This is the post-confirmation review deposition step for future manager memory. Summarize the confirmed release report plus any human feedback or requested additions into durable memory. Return one JSON object directly, not an AgentOutputEnvelope, with completedItems, rejectedOptions, keyDecisions, validatedFacts, openQuestions, activeRisks, assumptions, recommendedNextStep, summary, and optional freeform."
          : [
              "This is the mandatory system requirement/planning step for a self-iteration round. It must run after research even when existing requirements are already sufficient.",
              "Ordinary user-connected Manager slots are not substitutes for this system step. If no explicit system requirement agent is configured, you as Manager perform the step yourself.",
              "Generate a round execution plan. Put objective, scope, exclusions, basis, assumptions, risks, acceptance criteria, expected artifacts, and hardBlocker inside result when execution must stop.",
              "You may decide the current requirements are already sufficient only by returning an explicit plan result with rationale; never silently skip this step."
            ].join(" ");
    return [
      config.instructions?.trim() || "You are a Hiveward manager preparing a self-iteration round.",
      "",
      modeInstruction,
      ...(mode === "context_snapshot" ? [
        "Output must be valid JSON only. Do not include Markdown fences, prose before the JSON, or humanReportMd."
      ] : agentOutputContractLines),
      ...(mode === "context_snapshot" ? [] : [
        "For hard blockers, set result.hardBlocker: true and put the user-readable blocker explanation in humanReportMd."
      ]),
      "Use the provided runContext as structured input for this call only.",
      "Do not increment or invent roundNumber. Treat task input roundNumber and runContext round data as platform lifecycle state.",
      "Do not claim the round is complete. Do not dispatch worker slots from this preflight call."
    ].join("\n");
  }

  private resolveManagerReleaseReportPrompt(config: ManagerNodeConfig, options: { revision?: boolean } = {}): string {
    return [
      config.instructions?.trim() || "You are a Hiveward manager writing a self-iteration round release report.",
      "",
      options.revision
        ? "This is a release report revision for the current self-iteration round. It is one new Manager run triggered by explicit human feedback."
        : "This is the base release report step for the current self-iteration round. It is one Manager run.",
      "Write the report yourself from the provided structured facts. Do not mechanically concatenate each node report, do not dump every Agent output, and do not expose raw JSON/logs as the human report.",
      options.revision
        ? "Address input.revision.feedback directly. Use input.revision.previousReport only as context, and return a full replacement report instead of an appendix or acknowledgement."
        : "This report is before human confirmation. Do not include post-confirmation review deposition, future memory, or human feedback that is not present in the input.",
      "The report should help a human decide whether to approve continuing, complete the run, leave a comment, or use an explicit revise action. Include the useful outcome, delivered artifacts, verification status, important problems, and recommended next action.",
      "The release report itself belongs in humanReportMd. Do not declare top-level artifacts[] unless this Manager run actually creates a separate new file.",
      ...agentOutputContractLines,
      "- Return an AgentOutputEnvelope JSON object. humanReportMd is the release report. result may contain concise status, summary, recommendation, and risk fields. handoffJson may contain compact structured facts for later confirmation and review deposition."
    ].join("\n");
  }

  private async buildRequirementDecisionRevision(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    request: ApprovalRequest,
    message: string
  ): Promise<RequirementRevisionDraft> {
    const feedback = message.trim();
    if (!feedback) throw new Error("Approval revision message is required.");

    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager) throw new Error("Self-iteration manager not found.");

    const round = request.roundId
      ? (await this.store.listIterationRounds({ runId: run.id })).find((candidate) => candidate.id === request.roundId)
      : undefined;
    if (!round) throw new Error("Iteration round not found for requirement revision.");
    const session = (await this.store.listIterationSessions(run.id)).find((candidate) => candidate.id === round.sessionId);
    if (!session) throw new Error("Iteration session not found for requirement revision.");
    const revision = request.revision + 1;
    const preflight = await this.roundPreflightService.prepareRoundPlan({
      blueprint,
      run,
      session,
      round,
      topManagerNode: topManager,
      humanFeedback: feedback,
      previousRequirement: request.body,
      revision,
      executors: this.buildRoundPreflightExecutors(blueprint, run, round, topManager)
    });
    return {
      body: preflight.body,
      capabilities: preflight.researchStatus === "blocked"
        ? { approve: false, reject: true, reply: true, complete: false, terminate: false, requestChanges: false, revise: true }
        : request.capabilities,
      metadata: {
        researchStatus: preflight.researchStatus,
        researchSummary: preflight.researchSummary,
        researchArtifactIds: preflight.researchArtifactIds,
        planSource: "revised_from_feedback"
      }
    };
  }

  private async buildManagerReleaseReportRevision(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    request: ApprovalRequest,
    message: string
  ): Promise<ApprovalRevisionDraft> {
    const feedback = message.trim();
    if (!feedback) throw new Error("Release report revision message is required.");
    if (!request.roundId) throw new Error("Release report revision requires an iteration round.");

    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager) throw new Error("Self-iteration manager not found.");

    const round = (await this.store.listIterationRounds({ runId: run.id }))
      .find((candidate) => candidate.id === request.roundId);
    if (!round) throw new Error("Iteration round not found for release report revision.");

    const [reports, nodeRuns, allArtifacts, agentReports, agentHandoffs, approvedPlanRequest] = await Promise.all([
      this.store.listReleaseReports(run.id).then((items) => items.filter((report) => report.roundId === round.id)),
      this.store.listNodeRuns(run.id),
      this.store.listArtifacts(run.id),
      this.store.listAgentHumanReports(run.id).then((items) => items.filter((report) => report.roundId === round.id)),
      this.store.listAgentHandoffs(run.id).then((items) => items.filter((handoff) => handoff.roundId === round.id)),
      round.approvedRequirementRequestId
        ? this.store.getApprovalRequest(round.approvedRequirementRequestId)
        : Promise.resolve(undefined)
    ]);
    const currentReport = reports.find((report) => report.approvalRequestId === request.id || report.id === request.payloadRef) ?? reports.at(-1);
    const version = Math.max(0, ...reports.map((report) => report.version)) + 1;
    const reportId = `release-report-${nanoid(10)}`;
    const title = `Round ${round.roundNumber} Release Report v${version}`;
    const artifactRefs = currentReport?.artifactRefs ?? artifactsToReleaseReportRefs(
      allArtifacts.filter((artifact) => artifact.roundId === round.id && (artifact.status ?? "current") === "current")
    );
    const artifactIds = new Set(artifactRefs.map((ref) => ref.artifactId));
    const artifacts = allArtifacts.filter((artifact) =>
      artifact.roundId === round.id &&
      (artifact.status ?? "current") === "current" &&
      (artifactIds.size === 0 || artifactIds.has(artifact.id))
    );
    const nodeRunsById = new Map(nodeRuns.map((nodeRun) => [nodeRun.id, nodeRun]));
    const releaseAgentReports = agentReports.filter((report) => {
      const nodeRun = nodeRunsById.get(report.nodeRunId);
      return !(nodeRun?.nodeType === "manager" && report.source === "fallback");
    });
    const body = await this.writeSelfIterationReleaseReport({
      blueprint,
      run,
      round,
      managerNode: topManager,
      roundNumber: round.roundNumber,
      approvedPlan: approvedPlanRequest ? {
        title: approvedPlanRequest.title,
        revision: round.approvedRequirementRevision ?? approvedPlanRequest.revision,
        body: approvedPlanRequest.body
      } : undefined,
      research: {
        status: round.researchStatus,
        summary: round.researchSummary
      },
      artifacts,
      agentReports: releaseAgentReports,
      agentHandoffs,
      revision: {
        feedback,
        previousReport: currentReport ? {
          title: currentReport.title,
          summary: currentReport.summary,
          version: currentReport.version
        } : undefined
      }
    });

    return {
      title,
      body,
      payloadRef: reportId,
      capabilities: request.capabilities,
      releaseReport: {
        id: reportId,
        runId: run.id,
        roundId: round.id,
        approvalRequestId: "",
        version,
        title,
        summary: body,
        artifactRefs,
        supersedesReportId: currentReport?.id,
        createdAt: ""
      }
    };
  }

  async approveRun(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    nodeRunId?: string,
    comment?: string,
    selectedReplyId?: string
  ): Promise<BlueprintRun> {
    if (this.isTerminalRunStatus(run.status)) {
      throw new Error("Run is already finished.");
    }

    const nodeRuns = await this.store.listNodeRuns(run.id);
    const waiting = nodeRuns.find((nodeRun) =>
      nodeRun.status === "waiting_approval" && (!nodeRunId || nodeRun.id === nodeRunId)
    );
    if (!waiting) {
      throw new Error(nodeRunId ? "Requested approval is no longer waiting." : "No node is waiting for approval.");
    }

    const approvedOutput = await this.resolveApprovedOutput(blueprint, run, waiting, comment, selectedReplyId);
    await this.completeNode(waiting, approvedOutput, waiting.runtimeRef);
    const running = { ...run, status: "running" as const };
    await this.store.updateBlueprintRun(running);
    this.scheduleRun(blueprint, running);
    return running;
  }

  async selectApprovalReply(
    _blueprint: BlueprintDefinition,
    run: BlueprintRun,
    nodeRunId: string,
    selectedReplyId: string
  ): Promise<BlueprintRun> {
    if (this.isTerminalRunStatus(run.status)) {
      throw new Error("Run is already finished.");
    }

    const nodeRuns = await this.store.listNodeRuns(run.id);
    const waiting = nodeRuns.find((nodeRun) => nodeRun.status === "waiting_approval" && nodeRun.id === nodeRunId);
    if (!waiting) {
      throw new Error("Requested approval is no longer waiting.");
    }
    if (!isAgentApprovalWaitingOutput(waiting.output)) {
      throw new Error("Only Agent approval requests can select a solution.");
    }

    const normalizedSelectedReplyId = normalizeAgentApprovalSelectionId(selectedReplyId);
    if (!normalizedSelectedReplyId) {
      throw new Error("Approval selection id is required.");
    }
    const selectedOutput = applyAgentApprovalSelection(waiting.output, normalizedSelectedReplyId);

    const updatedWaiting = {
      ...waiting,
      output: selectedOutput
    };
    await this.store.upsertNodeRun(updatedWaiting);
    await this.migrationService.migratePendingNodeApproval({
      runId: run.id,
      nodeRun: updatedWaiting,
      requestedByLabel: waiting.nodeLabel
    });
    await this.managerMailProjector.refresh(run.id);
    return { ...run, status: "waiting_approval" as const };
  }

  async rejectRun(blueprint: BlueprintDefinition, run: BlueprintRun, nodeRunId?: string, comment?: string): Promise<BlueprintRun> {
    if (this.isTerminalRunStatus(run.status)) {
      throw new Error("Run is already finished.");
    }

    const nodeRuns = await this.store.listNodeRuns(run.id);
    const waiting = nodeRuns.find((nodeRun) =>
      nodeRun.status === "waiting_approval" && (!nodeRunId || nodeRun.id === nodeRunId)
    );
    if (!waiting) {
      throw new Error(nodeRunId ? "Requested approval is no longer waiting." : "No node is waiting for approval.");
    }

    await this.failNode(waiting, comment?.trim() || "Rejected by human reviewer.");
    const running = { ...run, status: "running" as const };
    await this.store.updateBlueprintRun(running);
    this.scheduleRun(blueprint, running);
    return running;
  }

  async replyToApproval(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    nodeRunId: string,
    message: string
  ): Promise<BlueprintRun> {
    void blueprint;
    if (this.isTerminalRunStatus(run.status)) {
      throw new Error("Run is already finished.");
    }

    const request = (await this.store.listApprovalRequests({ runId: run.id, status: "pending" }))
      .find((candidate) => candidate.nodeRunId === nodeRunId);
    if (request) {
      await this.approvalService.recordPendingReply(request.id, message);
    }
    await this.recordAgentApprovalComment(run, nodeRunId, message);
    await this.managerMailProjector.refresh(run.id);
    const nextRun = { ...run, status: "waiting_approval" as const };
    await this.store.updateBlueprintRun(nextRun);
    return nextRun;
  }

  isInboxThreadStreamActive(threadType: InboxThreadType, threadId: string): boolean {
    return this.activeInboxThreadStreams.has(inboxThreadStreamKey(threadType, threadId));
  }

  async streamInboxThreadMessage(input: StreamInboxThreadMessageInput): Promise<StreamInboxThreadMessageResult> {
    const message = input.message.trim();
    if (!message) {
      throw new Error("Inbox discussion message is required.");
    }
    const lockKey = inboxThreadStreamKey(input.threadType, input.threadId);
    if (this.activeInboxThreadStreams.has(lockKey)) {
      throw new InboxDiscussionInProgressError();
    }
    this.activeInboxThreadStreams.add(lockKey);
    try {
      if (input.threadType === "inbox") {
        return await this.streamPlainInboxThreadMessage(input.threadId, message, input.onEvent);
      }
      return await this.streamApprovalInboxThreadMessage(input.threadId, message, input.onEvent);
    } finally {
      this.activeInboxThreadStreams.delete(lockKey);
    }
  }

  private async streamPlainInboxThreadMessage(
    threadId: string,
    message: string,
    onEvent: (event: StreamInboxThreadMessageEvent) => void
  ): Promise<StreamInboxThreadMessageResult> {
    const item = await this.store.replyToInboxItem(threadId, message);
    const userMessageId = item.replies?.at(-1)?.id ?? threadId;
    onEvent({ type: "inbox_message_created", messageId: userMessageId, threadType: "inbox", threadId });
    onEvent(inboxDiscussionDoneEvent("inbox", threadId, userMessageId));
    return { threadType: "inbox", threadId, userMessageId };
  }

  private async streamApprovalInboxThreadMessage(
    threadId: string,
    message: string,
    onEvent: (event: StreamInboxThreadMessageEvent) => void
  ): Promise<StreamInboxThreadMessageResult> {
    const discussionMode: InboxDiscussionMode = "reply";
    const request = await this.resolveApprovalThreadRequest(threadId);
    if (!request) {
      throw new Error(`Approval thread not found: ${threadId}`);
    }
    if (await this.isExecutorBackedApprovalRequest(request, "agent_approval")) {
      return this.streamAgentMailDiscussion(request, message, discussionMode, onEvent);
    }
    const userReply = await this.appendApprovalDiscussionReply(request, "user", message);
    onEvent({ type: "inbox_message_created", messageId: userReply.id, threadType: "approval", threadId });
    if (request.runId) {
      await this.managerMailProjector.refresh(request.runId);
    }
    const target = await this.resolveExecutorDiscussionTarget(request, userReply, discussionMode);
    if (target) {
      return this.streamExecutorMailDiscussion(request, userReply, target, discussionMode, onEvent);
    }
    onEvent(inboxDiscussionDoneEvent("approval", threadId, userReply.id));
    return { threadType: "approval", threadId, userMessageId: userReply.id };
  }

  private async streamAgentMailDiscussion(
    request: ApprovalRequest,
    message: string,
    discussionMode: InboxDiscussionMode,
    onEvent: (event: StreamInboxThreadMessageEvent) => void
  ): Promise<StreamInboxThreadMessageResult> {
    if (request.status !== "pending") {
      throw new Error("Agent approval request is no longer pending.");
    }
    if (!request.runId || !request.nodeRunId) {
      throw new Error("Agent approval request is missing run or node context.");
    }
    const run = await this.store.getBlueprintRun(request.runId);
    if (!run) {
      throw new Error(`Blueprint run not found: ${request.runId}`);
    }
    if (this.isTerminalRunStatus(run.status)) {
      throw new Error("Run is already finished.");
    }
    const archive = await this.store.getRunArchive(run.id);
    const blueprint = archive?.blueprintSnapshot;
    if (!blueprint) {
      throw new Error("Blueprint snapshot was not found for this approval thread.");
    }
    const nodeRuns = await this.store.listNodeRuns(run.id);
    const waiting = nodeRuns.find((nodeRun) => nodeRun.id === request.nodeRunId && nodeRun.status === "waiting_approval");
    if (!waiting) {
      throw new Error("Requested approval is no longer waiting.");
    }
    if (!isAgentApprovalWaitingOutput(waiting.output)) {
      throw new Error("Only Agent approval requests can stream Agent discussion.");
    }
    const node = blueprint.nodes.find((candidate) => candidate.id === waiting.nodeId);
    if (!node || !isAgentBlueprintNode(node)) {
      throw new Error("Agent approval node was not found.");
    }

    const now = new Date().toISOString();
    const threadId = approvalThreadIdForRequest(request);
    await this.store.upsertApprovalThread(approvalThreadFromRequest({ ...request, updatedAt: now }));
    const userReply: AgentApprovalReply = {
      id: `approval-reply-${nanoid(10)}`,
      role: "user",
      body: message,
      createdAt: now
    };
    await this.store.appendApprovalReply({
      id: userReply.id,
      threadId,
      approvalRequestId: request.id,
      actor: "user",
      body: userReply.body,
      createdAt: userReply.createdAt,
      metadata: {
        source: "inbox_thread_stream",
        nodeRunId: waiting.id
      }
    });
    const nodeRunWithUserReply: BlueprintNodeRun = {
      ...waiting,
      output: {
        ...waiting.output,
        replies: markSelectedApprovalReplies([...waiting.output.replies, userReply], waiting.output.selectedReplyId)
      }
    };
    await this.store.upsertNodeRun(nodeRunWithUserReply);
    await this.migrationService.migratePendingNodeApproval({
      runId: run.id,
      nodeRun: nodeRunWithUserReply,
      requestedByLabel: waiting.nodeLabel
    });
    await this.managerMailProjector.refresh(run.id);
    onEvent({ type: "inbox_message_created", messageId: userReply.id, threadType: "approval", threadId });

    const config = node.config as AgentNodeConfig;
    const runtimeId: AgentRuntimeId = waiting.runtimeRef?.source ?? node.runtimeId ?? "openclaw";
    const replyInput = buildAgentApprovalReplyInput(waiting.input, waiting.output.reviewOutput, waiting.output.replies, userReply, discussionMode);
    const inputWithWorkspace = await this.withAgentWorkspaceInput(blueprint, node, replyInput);
    const crossRoundInput = await this.withNodeCrossRoundContext({
      run,
      node,
      nodeRun: nodeRunWithUserReply,
      input: inputWithWorkspace,
      prompt: this.resolveAgentPrompt(config, { requiresHandoff: this.hasDownstreamConsumers(blueprint, node) })
    });
    const taskInput: StartAgentTaskInput = {
      blueprintRunId: run.id,
      nodeRunId: waiting.id,
      source: resolveAgentRuntimeSource(runtimeId),
      agentId: runtimeId === "openclaw" ? config.openclawAgentId ?? "main" : undefined,
      profileId: runtimeId === "hermes" ? config.profileId : undefined,
      agentName: config.agentName,
      prompt: crossRoundInput.prompt,
      modelId: config.modelId,
      permissionProfile: config.permissionProfile,
      runtimeAccessPolicy: config.runtimeAccessPolicy,
      workingDirectory: config.workingDirectory,
      timeoutMs: config.timeoutMs,
      outputSchema: buildAgentOutputEnvelopeSchema(config.outputSchema),
      input: crossRoundInput.input,
      skillIds: config.skillIds,
      tools: config.tools
    };

    const result = await this.streamInboxDiscussionChat(request, userReply.id, userReply.body, taskInput, discussionMode, onEvent);
    if (result.status !== "succeeded") {
      await this.appendApprovalDiscussionReply(
        request,
        "system",
        result.error ?? `Agent discussion ${result.status}.`,
        {
          source: "inbox_thread_stream",
          nodeRunId: waiting.id,
          status: "failed",
          runtime: result.runtime
        }
      );
      await this.managerMailProjector.refresh(run.id);
      return { threadType: "approval", threadId, userMessageId: userReply.id };
    }

    const assistantReply: AgentApprovalReply = {
      id: `approval-reply-${nanoid(10)}`,
      role: "assistant",
      body: formatAgentApprovalDiscussionBody(result.output),
      createdAt: new Date().toISOString(),
      canUseAsSolution: discussionMode === "candidate"
    };
    await this.store.appendApprovalReply({
      id: assistantReply.id,
      threadId,
      approvalRequestId: request.id,
      actor: "agent",
      body: assistantReply.body,
      createdAt: assistantReply.createdAt,
      metadata: {
        source: "inbox_thread_stream",
        nodeRunId: waiting.id,
        inboxDiscussionMode: discussionMode,
        candidate: discussionMode === "candidate",
        agentOutput: result.output,
        runtime: result.runtime
      }
    });
    const latestWaiting = (await this.store.listNodeRuns(run.id))
      .find((nodeRun) => nodeRun.id === waiting.id && nodeRun.status === "waiting_approval");
    const output = latestWaiting?.output;
    if (!latestWaiting || !isAgentApprovalWaitingOutput(output)) {
      throw new Error("Agent approval was resolved before the discussion reply could be saved.");
    }
    const nodeRunWithAssistantReply: BlueprintNodeRun = {
      ...latestWaiting,
      output: {
        ...output,
        replies: markSelectedApprovalReplies([...output.replies, assistantReply], output.selectedReplyId)
      },
      usage: result.doneEvent?.usage ?? latestWaiting.usage
    };
    await this.store.upsertNodeRun(nodeRunWithAssistantReply);
    await this.migrationService.migratePendingNodeApproval({
      runId: run.id,
      nodeRun: nodeRunWithAssistantReply,
      requestedByLabel: waiting.nodeLabel
    });
    await this.managerMailProjector.refresh(run.id);
    if (discussionMode === "candidate") {
      onEvent({ type: "inbox_candidate_created", replyId: assistantReply.id, threadType: "approval", threadId });
    }
    return { threadType: "approval", threadId, userMessageId: userReply.id, assistantMessageId: assistantReply.id };
  }

  private async resolveApprovalThreadRequest(threadId: string): Promise<ApprovalRequest | undefined> {
    const requests = await this.store.listApprovalRequests();
    const matching = requests.filter((request) => request.id === threadId || approvalThreadIdForRequest(request) === threadId);
    return matching
      .sort((left, right) => {
        if (left.status === "pending" && right.status !== "pending") return -1;
        if (right.status === "pending" && left.status !== "pending") return 1;
        return right.revision - left.revision || approvalRequestTimestamp(right) - approvalRequestTimestamp(left);
      })[0];
  }

  private async streamExecutorMailDiscussion(
    request: ApprovalRequest,
    userReply: ApprovalReply,
    target: ExecutorDiscussionTarget,
    discussionMode: InboxDiscussionMode,
    onEvent: (event: StreamInboxThreadMessageEvent) => void
  ): Promise<StreamInboxThreadMessageResult> {
    const threadId = approvalThreadIdForRequest(request);
    const result = await this.streamInboxDiscussionChat(request, userReply.id, userReply.body, target.taskInput, discussionMode, onEvent);
    if (result.status !== "succeeded") {
      await this.appendApprovalDiscussionReply(
        request,
        "system",
        result.error ?? `Executor discussion ${result.status}.`,
        {
          ...target.metadata,
          status: "failed",
          runtime: result.runtime
        }
      );
      if (request.runId) {
        await this.managerMailProjector.refresh(request.runId);
      }
      return { threadType: "approval", threadId, userMessageId: userReply.id };
    }

    const assistantReply = await this.appendApprovalDiscussionReply(
      request,
      target.actor,
      formatAgentApprovalDiscussionBody(result.output),
      {
        ...target.metadata,
        status: "succeeded",
        inboxDiscussionMode: discussionMode,
        candidate: discussionMode === "candidate",
        agentOutput: result.output,
        runtime: result.runtime
      }
    );
    if (request.runId) {
      await this.managerMailProjector.refresh(request.runId);
    }
    if (discussionMode === "candidate") {
      onEvent({ type: "inbox_candidate_created", replyId: assistantReply.id, threadType: "approval", threadId });
    }
    return { threadType: "approval", threadId, userMessageId: userReply.id, assistantMessageId: assistantReply.id };
  }

  private async streamInboxDiscussionChat(
    request: ApprovalRequest,
    userMessageId: string,
    visibleUserMessage: string,
    taskInput: StartAgentTaskInput,
    discussionMode: InboxDiscussionMode,
    onEvent: (event: StreamInboxThreadMessageEvent) => void
  ): Promise<InboxDiscussionChatResult> {
    const threadId = approvalThreadIdForRequest(request);
    const chatSession = await this.ensureApprovalDiscussionChatSession(request, taskInput);
    const prompt = formatInboxDiscussionChatPrompt(request, taskInput, {
      chatSession,
      discussionMode,
      visibleUserMessage
    });
    const userChatMessage = await this.store.appendChatMessage({
      sessionId: chatSession.id,
      role: "user",
      content: formatInboxDiscussionVisibleUserMessage(visibleUserMessage),
      harnessId: chatSession.harnessId,
      modelId: taskInput.modelId,
      status: "sent",
      id: `chat-${userMessageId}`
    });
    const assistantChatMessage = await this.store.appendChatMessage({
      sessionId: chatSession.id,
      role: "assistant",
      content: "",
      harnessId: chatSession.harnessId,
      modelId: taskInput.modelId,
      status: "streaming"
    });
    let session = chatSession;
    let sessionKey = session.nativeSessionId ?? "";
    const attemptedNativeResume = Boolean(sessionKey);
    let streamedOutput = "";
    let doneEvent: Extract<ChatStreamEvent, { type: "done" }> | undefined;

    try {
      if (session.harnessId === "openclaw" && !sessionKey) {
        const nativeSession = await this.adapter.createChatSession({ agentId: session.agentId });
        sessionKey = nativeSession.sessionKey;
        session = await this.store.updateChatSession(session.id, {
          nativeSessionId: sessionKey,
          nativeSessionState: "resumable",
          status: "active"
        }) ?? session;
        await this.updateApprovalDiscussionSessionFromChat(request, session);
      }

      await this.adapter.streamChatMessage(
        {
          sessionKey,
          source: taskInput.source,
          message: prompt,
          attachments: [],
          modelId: taskInput.modelId,
          permissionMode: chatPermissionModeForTaskInput(taskInput),
          idempotencyKey: userChatMessage.id,
          timeoutMs: taskInput.timeoutMs,
          skillIds: taskInput.skillIds as HarnessSkillId[] | undefined
        },
        (event) => {
          if (event.type === "delta") {
            streamedOutput = event.replace ? event.text : `${streamedOutput}${event.text}`;
          }
          if (event.type === "done") {
            doneEvent = event;
          }
          onEvent(event);
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Inbox discussion chat failed.";
      const nativeMissing = attemptedNativeResume && isNativeResumeFailure(message);
      await this.store.updateChatMessage(chatSession.id, assistantChatMessage.id, {
        content: message,
        status: "failed"
      });
      session = await this.store.updateChatSession(chatSession.id, {
        status: nativeMissing ? "native_missing" : "failed",
        nativeSessionState: nativeMissing ? "missing" : session.nativeSessionState
      }) ?? session;
      await this.updateApprovalDiscussionSessionFromChat(request, session);
      onEvent({ type: "error", message });
      return {
        status: "failed",
        error: message,
        runtime: {
          source: taskInput.source,
          status: "failed",
          error: message,
          nativeSessionState: nativeMissing ? "missing" : session.nativeSessionState
        }
      };
    }

    if (!doneEvent) {
      const message = "Inbox discussion chat completed without a final runtime event.";
      await this.store.updateChatMessage(chatSession.id, assistantChatMessage.id, {
        content: streamedOutput || message,
        status: streamedOutput ? "sent" : "failed"
      });
      session = await this.store.updateChatSession(chatSession.id, {
        status: streamedOutput ? "active" : "failed"
      }) ?? session;
      await this.updateApprovalDiscussionSessionFromChat(request, session);
      return {
        status: streamedOutput ? "succeeded" : "failed",
        output: streamedOutput,
        error: streamedOutput ? undefined : message,
        runtime: {
          source: taskInput.source,
          status: streamedOutput ? "succeeded" : "failed",
          error: streamedOutput ? undefined : message
        }
      };
    }

    const output = doneEvent.output ?? streamedOutput ?? doneEvent.error;
    const nativeMissing = attemptedNativeResume && doneEvent.status === "failed" && isNativeResumeFailure(doneEvent.error);
    await this.store.updateChatMessage(chatSession.id, assistantChatMessage.id, {
      content: output ?? "",
      status: doneEvent.status === "failed" || doneEvent.status === "cancelled" ? "failed" : "sent",
      modelId: taskInput.modelId,
      runtimeRef: {
        taskId: doneEvent.taskId,
        runId: doneEvent.runId,
        sessionKey: doneEvent.sessionKey,
        source: doneEvent.source,
        status: doneEvent.status,
        updatedAt: doneEvent.updatedAt,
        error: doneEvent.error,
        usage: doneEvent.usage,
        timings: doneEvent.timings
      }
    });
    session = await this.store.updateChatSession(chatSession.id, {
      status: nativeMissing ? "native_missing" : "active",
      nativeSessionState: nativeMissing ? "missing" : doneEvent.sessionKey ? "resumable" : session.nativeSessionState,
      ...(doneEvent.sessionKey ? { nativeSessionId: doneEvent.sessionKey } : {})
    }) ?? session;
    await this.updateApprovalDiscussionSessionFromChat(request, session);
    return {
      status: doneEvent.status,
      output,
      error: doneEvent.error,
      doneEvent,
      runtime: chatDoneRuntimeMetadata(doneEvent)
    };
  }

  private async ensureApprovalDiscussionChatSession(
    request: ApprovalRequest,
    taskInput: StartAgentTaskInput
  ): Promise<HivewardChatSession> {
    const threadId = approvalThreadIdForRequest(request);
    const thread = (await this.store.listApprovalThreads()).find((candidate) => candidate.id === threadId);
    const existingSessionId = thread?.discussionSession?.chatSessionId;
    const existing = existingSessionId ? await this.store.getChatSession(existingSessionId) : undefined;
    if (existing) return existing;

    const chatSession = await this.store.createChatSession({
      harnessId: harnessIdForRuntimeSource(taskInput.source),
      title: `Inbox discussion: ${request.title}`,
      nativeSessionId: thread?.discussionSession?.nativeSessionId,
      modelId: taskInput.modelId,
      agentId: taskInput.agentId,
      permissionMode: chatPermissionModeForTaskInput(taskInput),
      mode: "chat"
    });
    await this.updateApprovalDiscussionSessionFromChat(request, chatSession);
    return chatSession;
  }

  private async updateApprovalDiscussionSessionFromChat(
    request: ApprovalRequest,
    chatSession: HivewardChatSession
  ): Promise<void> {
    const threadId = approvalThreadIdForRequest(request);
    const now = new Date().toISOString();
    const existing = (await this.store.listApprovalThreads()).find((candidate) => candidate.id === threadId);
    await this.store.upsertApprovalThread({
      ...(existing ?? approvalThreadFromRequest(request)),
      updatedAt: now,
      discussionSession: {
        threadType: "approval",
        threadId,
        chatSessionId: chatSession.id,
        harnessId: chatSession.harnessId,
        agentId: chatSession.agentId,
        modelId: chatSession.modelId,
        nativeSessionId: chatSession.nativeSessionId,
        nativeSessionState: chatSession.nativeSessionState ?? (chatSession.nativeSessionId ? "resumable" : "unknown"),
        status: chatSession.status === "ended" || chatSession.status === "failed" || chatSession.status === "native_missing"
          ? chatSession.status
          : "active",
        createdAt: existing?.discussionSession?.createdAt ?? chatSession.createdAt,
        updatedAt: now
      }
    });
  }

  private async isExecutorBackedApprovalRequest(
    request: ApprovalRequest,
    targetKind?: "agent_approval"
  ): Promise<boolean> {
    const target = await this.resolveExecutorDiscussionTarget(request);
    return targetKind ? target?.metadata.executorKind === targetKind : Boolean(target);
  }

  private async resolveExecutorDiscussionTarget(
    request: ApprovalRequest,
    userReply?: ApprovalReply,
    discussionMode: InboxDiscussionMode = "reply"
  ): Promise<ExecutorDiscussionTarget | undefined> {
    if (request.status !== "pending") return undefined;
    if (!request.runId) return undefined;

    const run = await this.store.getBlueprintRun(request.runId);
    if (!run) return undefined;
    if (this.isTerminalRunStatus(run.status)) {
      throw new Error("Run is already finished.");
    }
    const archive = await this.store.getRunArchive(run.id);
    const blueprint = archive?.blueprintSnapshot;
    if (!blueprint) return undefined;

    const nodeRuns = await this.store.listNodeRuns(run.id);
    if (request.kind === "agent_proposal") {
      const waiting = request.nodeRunId
        ? nodeRuns.find((nodeRun) => nodeRun.id === request.nodeRunId && nodeRun.status === "waiting_approval")
        : undefined;
      const node = waiting ? blueprint.nodes.find((candidate) => candidate.id === waiting.nodeId) : undefined;
      return waiting && isAgentApprovalWaitingOutput(waiting.output) && node && isAgentBlueprintNode(node)
        ? {
            actor: "agent",
            taskInput: {} as StartAgentTaskInput,
            metadata: {
              executorKind: "agent_approval",
              nodeRunId: waiting.id,
              nodeId: waiting.nodeId
            }
          }
        : undefined;
    }

    if (!userReply) return undefined;
    if (request.kind === "iteration_requirement_plan") {
      return this.resolveRequirementPlanDiscussionTarget(blueprint, run, request, userReply, discussionMode);
    }
    if (request.kind === "manager_release_report") {
      return this.resolveManagerReleaseReportDiscussionTarget(blueprint, run, request, userReply, discussionMode);
    }
    if (request.kind === "function_node") {
      return this.resolveFunctionNodeDiscussionTarget(blueprint, run, request, userReply, discussionMode, nodeRuns);
    }
    return undefined;
  }

  private async resolveRequirementPlanDiscussionTarget(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    request: ApprovalRequest,
    userReply: ApprovalReply,
    discussionMode: InboxDiscussionMode
  ): Promise<ExecutorDiscussionTarget | undefined> {
    if (!request.roundId) return undefined;
    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager) return undefined;
    const round = (await this.store.listIterationRounds({ runId: run.id }))
      .find((candidate) => candidate.id === request.roundId);
    if (!round) return undefined;
    const session = (await this.store.listIterationSessions(run.id))
      .find((candidate) => candidate.id === round.sessionId);
    const managerConfig = topManager.config as ManagerNodeConfig;
    const requirementAgent = this.resolveConfiguredPreflightAgent(blueprint, managerConfig.requirementAgentNodeId)
      ?? this.resolveSystemInterfaceAgent(blueprint, topManager, selfIterationRequirementInterfaceSlot);
    const context = session
      ? await this.managerContextService.buildRoundStartContext({
          run,
          session,
          round,
          managerNode: topManager,
          humanFeedback: userReply.body
        })
      : undefined;
    const runContext = context
      ? this.managerContextService.buildManagerInjectedContext(context, {
          mode: "revise_plan",
          roundStatus: round.status,
          research: {
            status: round.researchStatus,
            summary: round.researchSummary,
            source: round.researchStatus
          }
        })
      : undefined;
    const discussion = await this.buildApprovalExecutorDiscussionInput(request, userReply, discussionMode);
    const baseInput = {
      ...discussion,
      task: "approval_thread_discussion",
      approvalKind: request.kind,
      roundNumber: round.roundNumber,
      previousRequirement: request.body,
      revisionFeedback: userReply.body,
      runContext
    };

    if (requirementAgent) {
      const config = requirementAgent.config;
      const runtimeId = requirementAgent.runtimeId ?? "openclaw";
      return {
        actor: "agent",
        taskInput: {
          blueprintRunId: run.id,
          nodeRunId: request.nodeRunId ?? `approval-discussion-${request.id}`,
          source: resolveAgentRuntimeSource(runtimeId),
          agentId: runtimeId === "openclaw" ? config.openclawAgentId ?? "main" : undefined,
          profileId: runtimeId === "hermes" ? config.profileId : undefined,
          agentName: config.agentName,
          prompt: this.resolveApprovalDiscussionPrompt(
            this.resolveAgentPrompt(config, { requiresHandoff: true }),
            request.kind,
            discussionMode
          ),
          modelId: config.modelId,
          permissionProfile: config.permissionProfile,
          runtimeAccessPolicy: config.runtimeAccessPolicy,
          workingDirectory: config.workingDirectory,
          timeoutMs: config.timeoutMs,
          outputSchema: config.outputSchema ? buildAgentOutputEnvelopeSchema(config.outputSchema) : humanReportEnvelopeSchemaBase,
          input: baseInput,
          skillIds: config.skillIds,
          tools: config.tools
        },
        metadata: {
          executorKind: "requirement_agent",
          nodeId: requirementAgent.id,
          roundId: round.id
        }
      };
    }

    return this.buildManagerDiscussionTarget({
      blueprint,
      run,
      request,
      node: topManager,
      userReply,
      input: baseInput,
      prompt: this.resolveManagerPreflightPrompt(managerConfig, "revise_plan"),
      executorKind: "requirement_manager",
      discussionMode
    });
  }

  private async resolveManagerReleaseReportDiscussionTarget(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    request: ApprovalRequest,
    userReply: ApprovalReply,
    discussionMode: InboxDiscussionMode
  ): Promise<ExecutorDiscussionTarget | undefined> {
    const managerNode = request.requestedBy.nodeId
      ? blueprint.nodes.find((node) => node.id === request.requestedBy.nodeId)
      : undefined;
    const topManager = managerNode?.type === "manager"
      ? managerNode
      : this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager || topManager.type !== "manager") return undefined;

    const round = request.roundId
      ? (await this.store.listIterationRounds({ runId: run.id })).find((candidate) => candidate.id === request.roundId)
      : undefined;
    const session = round
      ? (await this.store.listIterationSessions(run.id)).find((candidate) => candidate.id === round.sessionId)
      : undefined;
    const context = round && session
      ? await this.managerContextService.buildRoundStartContext({
          run,
          session,
          round,
          managerNode: topManager,
          humanFeedback: userReply.body
        })
      : undefined;
    const runContext = context && round
      ? this.managerContextService.buildManagerInjectedContext(context, {
          mode: "revise_report",
          roundStatus: round.status
        })
      : undefined;
    const reports = request.roundId
      ? (await this.store.listReleaseReports(run.id)).filter((report) => report.roundId === request.roundId)
      : [];
    const currentReport = reports.find((report) => report.approvalRequestId === request.id || report.id === request.payloadRef) ?? reports.at(-1);
    const discussion = await this.buildApprovalExecutorDiscussionInput(request, userReply, discussionMode);
    const config = topManager.config as ManagerNodeConfig;
    return this.buildManagerDiscussionTarget({
      blueprint,
      run,
      request,
      node: topManager,
      userReply,
      input: {
        ...discussion,
        task: "approval_thread_discussion",
        approvalKind: request.kind,
        roundNumber: round?.roundNumber,
        releaseReport: currentReport,
        previousReport: request.body,
        revisionFeedback: userReply.body,
        runContext
      },
      prompt: this.resolveManagerReleaseReportPrompt(config, { revision: true }),
      executorKind: "release_report_manager",
      discussionMode
    });
  }

  private async resolveFunctionNodeDiscussionTarget(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    request: ApprovalRequest,
    userReply: ApprovalReply,
    discussionMode: InboxDiscussionMode,
    nodeRuns: BlueprintNodeRun[]
  ): Promise<ExecutorDiscussionTarget | undefined> {
    const nodeRun = request.nodeRunId
      ? nodeRuns.find((candidate) => candidate.id === request.nodeRunId)
      : undefined;
    const node = nodeRun
      ? blueprint.nodes.find((candidate) => candidate.id === nodeRun.nodeId)
      : request.requestedBy.nodeId
        ? blueprint.nodes.find((candidate) => candidate.id === request.requestedBy.nodeId)
        : undefined;
    if (!node || node.disabled) return undefined;
    const discussion = await this.buildApprovalExecutorDiscussionInput(request, userReply, discussionMode);
    const input = {
      ...discussion,
      task: "approval_thread_discussion",
      approvalKind: request.kind,
      node: {
        id: node.id,
        label: node.config.label,
        type: node.type
      },
      nodeRun: nodeRun ? {
        id: nodeRun.id,
        status: nodeRun.status,
        input: nodeRun.input,
        output: nodeRun.output,
        error: nodeRun.error,
        runtimeRef: nodeRun.runtimeRef
      } : undefined
    };

    if (node.type === "manager" && this.isAgentDrivenManager(node)) {
      return this.buildManagerDiscussionTarget({
        blueprint,
        run,
        request,
        node,
        userReply,
        input,
        prompt: this.resolveManagerPrompt(node.config as ManagerNodeConfig),
        executorKind: "function_manager",
        discussionMode
      });
    }

    if (node.type === "summary" && isHarnessSummaryMode(node.config as SummaryNodeConfig)) {
      const config = node.config as SummaryNodeConfig;
      const runtimeId = resolveSummaryRuntimeId(config);
      return {
        actor: "agent",
        taskInput: {
          blueprintRunId: run.id,
          nodeRunId: nodeRun?.id ?? `approval-discussion-${request.id}`,
          source: resolveAgentRuntimeSource(runtimeId),
          agentId: runtimeId === "openclaw" ? "main" : undefined,
          profileId: runtimeId === "hermes" ? config.profileId : undefined,
          agentName: "summary-agent",
          prompt: this.resolveApprovalDiscussionPrompt(config.prompt?.trim() || defaultSummaryHarnessPrompt, request.kind, discussionMode),
          modelId: config.modelId,
          runtimeAccessPolicy: config.runtimeAccessPolicy,
          outputSchema: humanReportEnvelopeSchemaBase,
          input,
          tools: []
        },
        metadata: {
          executorKind: "function_summary",
          nodeId: node.id,
          ...(nodeRun ? { nodeRunId: nodeRun.id } : {})
        }
      };
    }

    return undefined;
  }

  private async buildManagerDiscussionTarget(input: {
    blueprint: BlueprintDefinition;
    run: BlueprintRun;
    request: ApprovalRequest;
    node: BlueprintNode;
    userReply: ApprovalReply;
    input: Record<string, unknown>;
    prompt: string;
    executorKind: string;
    discussionMode: InboxDiscussionMode;
  }): Promise<ExecutorDiscussionTarget> {
    const config = input.node.config as ManagerNodeConfig;
    const runtimeId = this.resolveManagerRuntimeId(input.node);
    return {
      actor: "manager",
      taskInput: {
        blueprintRunId: input.run.id,
        nodeRunId: input.request.nodeRunId ?? `approval-discussion-${input.request.id}`,
        source: resolveAgentRuntimeSource(runtimeId),
        agentId: runtimeId === "openclaw" ? config.openclawAgentId ?? "main" : undefined,
        profileId: runtimeId === "hermes" ? config.profileId : undefined,
        agentName: config.agentName?.trim() || defaultManagerAgentName,
        prompt: this.resolveApprovalDiscussionPrompt(input.prompt, input.request.kind, input.discussionMode),
        modelId: config.modelId,
        permissionProfile: config.permissionProfile,
        runtimeAccessPolicy: config.runtimeAccessPolicy,
        workingDirectory: config.workingDirectory,
        timeoutMs: config.timeoutMs,
        outputSchema: humanReportEnvelopeSchemaBase,
        input: input.input,
        skillIds: config.skillIds,
        tools: config.tools ?? []
      },
      metadata: {
        executorKind: input.executorKind,
        nodeId: input.node.id,
        ...(input.request.roundId ? { roundId: input.request.roundId } : {})
      }
    };
  }

  private async buildApprovalExecutorDiscussionInput(
    request: ApprovalRequest,
    userReply: ApprovalReply,
    discussionMode: InboxDiscussionMode
  ): Promise<Record<string, unknown>> {
    const replies = await this.store.listApprovalReplies({ threadId: approvalThreadIdForRequest(request) });
    const conversation = replies.map((reply) => ({
      id: reply.id,
      role: reply.actor,
      body: reply.body,
      createdAt: reply.createdAt
    }));
    return {
      approvalThread: {
        threadId: approvalThreadIdForRequest(request),
        requestId: request.id,
        kind: request.kind,
        title: request.title,
        body: request.body,
        revision: request.revision,
        status: request.status
      },
      approvalChat: {
        latestUserReply: userReply.body,
        conversation,
        requestedOutput: discussionMode,
        candidateRequested: discussionMode === "candidate",
        instruction: [
          "This is a HiveWard inbox discussion reply.",
          discussionMode === "candidate"
            ? "The human explicitly asked for a formal candidate artifact. Produce a full replacement candidate draft for this approval thread."
            : "The human did not explicitly ask for a formal candidate artifact. Reply as a normal short conversation, clarification, explanation, or tradeoff discussion.",
          "Do not approve, reject, rerun, schedule, complete, terminate, or otherwise advance workflow lifecycle.",
          discussionMode === "candidate"
            ? "The platform will publish your answer as an assistant candidate; the human must explicitly select it and use Pass/Reject/Revise controls for lifecycle actions."
            : "The platform will persist your answer as a discussion reply, not as a selectable candidate. You may naturally offer to prepare a formal candidate if the direction is confirmed."
        ].join(" ")
      }
    };
  }

  private resolveApprovalDiscussionPrompt(basePrompt: string, kind: ApprovalRequest["kind"], discussionMode: InboxDiscussionMode): string {
    return [
      basePrompt,
      "",
      "Inbox discussion contract:",
      `- Approval kind: ${kind}.`,
      "- This call is caused by the human pressing Reply, not by Pass, Reject, or Revise.",
      `- Discussion mode: ${discussionMode}.`,
      discussionMode === "candidate"
        ? "- The latest inbox reply explicitly asks for a formal candidate artifact. Return the full candidate draft in humanReportMd."
        : "- The latest inbox reply is ordinary discussion. Return a concise conversational answer in humanReportMd, not a full candidate/report/final artifact.",
      "- Do not claim that the approval has passed or that execution has advanced.",
      "- Return an AgentOutputEnvelope. Put the human-readable answer or candidate draft in humanReportMd.",
      discussionMode === "candidate"
        ? "- Write the full candidate draft, not a one-line acknowledgement."
        : "- If the direction seems viable, you may end by offering to produce a formal candidate after the human confirms."
    ].join("\n");
  }

  private resolveConfiguredPreflightAgent(
    blueprint: BlueprintDefinition,
    nodeId: string | undefined
  ): BlueprintNode & { type: "agent"; config: AgentNodeConfig } | undefined {
    const targetId = nodeId?.trim();
    if (!targetId) return undefined;
    const target = blueprint.nodes.find((node) => node.id === targetId);
    if (!target || target.disabled || !isAgentBlueprintNode(target)) return undefined;
    return target;
  }

  private resolveSystemInterfaceAgent(
    blueprint: BlueprintDefinition,
    managerNode: BlueprintNode,
    interfaceSlot: number
  ): BlueprintNode & { type: "agent"; config: AgentNodeConfig } | undefined {
    const target = this.resolveManagerSystemInterfaceTarget(blueprint, managerNode, interfaceSlot);
    if (!target || target.disabled) return undefined;
    if (isAgentBlueprintNode(target)) return target;
    if (target.type !== "manager_slot") return undefined;

    const childAgents = blueprint.nodes.filter(
      (node): node is BlueprintNode & { type: "agent"; config: AgentNodeConfig } =>
        node.parentId === target.id && !node.disabled && isAgentBlueprintNode(node)
    );
    if (childAgents.length === 0) return undefined;

    const entryEdge = blueprint.edges.find(
      (edge) => edge.source === target.id && isManagerSlotInnerOutHandle(edge.sourceHandle)
    );
    return childAgents.find((node) => node.id === entryEdge?.target) ?? childAgents[0];
  }

  private resolveManagerSystemInterfaceTarget(
    blueprint: BlueprintDefinition,
    managerNode: BlueprintNode,
    interfaceSlot: number
  ): BlueprintNode | undefined {
    const edge = blueprint.edges.find(
      (candidate) => candidate.source === managerNode.id && candidate.sourceHandle === `${managerOutHandlePrefix}${interfaceSlot}`
    );
    return edge ? blueprint.nodes.find((node) => node.id === edge.target) : undefined;
  }

  private async appendApprovalDiscussionReply(
    request: ApprovalRequest,
    actor: "user" | "agent" | "manager" | "system",
    body: string,
    metadata?: Record<string, unknown>
  ) {
    const now = new Date().toISOString();
    const threadId = approvalThreadIdForRequest(request);
    await this.store.upsertApprovalThread(approvalThreadFromRequest({ ...request, updatedAt: now }));
    return this.store.appendApprovalReply({
      id: `approval-reply-${nanoid(10)}`,
      threadId,
      approvalRequestId: request.id,
      actor,
      body,
      createdAt: now,
      ...(metadata ? { metadata } : {})
    });
  }

  private async rerunAgentApprovalForRequestedChanges(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    request: ApprovalRequest,
    pendingRequest: ApprovalRequest,
    message: string
  ): Promise<void> {
    void pendingRequest;
    const feedback = message.trim();
    if (!feedback) throw new Error("Approval request_changes comment is required.");
    if (!request.nodeRunId) throw new Error("Agent approval request is missing nodeRunId.");

    const nodeRuns = await this.store.listNodeRuns(run.id);
    const waiting = nodeRuns.find((nodeRun) => nodeRun.status === "waiting_approval" && nodeRun.id === request.nodeRunId);
    if (!waiting) throw new Error("Requested approval is no longer waiting.");
    if (!isAgentApprovalWaitingOutput(waiting.output)) {
      throw new Error("Only Agent approval requests can be regenerated.");
    }
    const node = blueprint.nodes.find((candidate) => candidate.id === waiting.nodeId);
    if (!node || !isAgentBlueprintNode(node)) {
      throw new Error("Agent approval node was not found.");
    }

    const revisionContext: PendingApprovalRevisionContext = {
      threadId: request.threadId,
      replacesRequestId: request.id,
      revision: request.revision + 1,
      requestedChanges: feedback
    };
    this.pendingApprovalRevisionContexts.set(waiting.id, revisionContext);
    const revisionInput = buildAgentApprovalRevisionInput(
      waiting.input,
      waiting.output.reviewOutput,
      waiting.output.replies,
      feedback,
      revisionContext
    );
    const rerunNodeRun = await this.store.createQueuedNodeRun({
      ...waiting,
      input: revisionInput,
      output: undefined,
      runtimeRef: undefined,
      usage: undefined
    });
    let rerunResult: AgentTaskResult;
    try {
      rerunResult = await this.executeAgentNodeWithInput(
        blueprint,
        run,
        node,
        rerunNodeRun,
        revisionInput
      );
    } catch (error) {
      await this.restoreOriginalAgentApprovalAfterRevisionFailure(run, waiting, error);
      throw error;
    } finally {
      this.pendingApprovalRevisionContexts.delete(waiting.id);
    }

    if (rerunResult.status !== "succeeded") {
      const error = new Error(rerunResult.error ?? "Agent revision failed before creating a new approval request.");
      await this.restoreOriginalAgentApprovalAfterRevisionFailure(run, waiting, error);
      throw error;
    }

    const nextRequest = (await this.store.listApprovalRequests({ runId: run.id, status: "pending" }))
      .find((candidate) => candidate.replacesRequestId === request.id && candidate.nodeRunId === request.nodeRunId);
    if (!nextRequest) {
      const error = new Error("Agent revision completed without creating a new pending approval request.");
      await this.restoreOriginalAgentApprovalAfterRevisionFailure(run, waiting, error);
      throw error;
    }
    await this.supersedeOriginalApprovalIfPending(request.id, nextRequest.id);
  }

  private async supersedeOriginalApprovalIfPending(replacesRequestId: string, nextRequestId: string): Promise<void> {
    const current = await this.store.getApprovalRequest(replacesRequestId);
    if (!current) return;
    if (current.status === "pending") {
      await this.approvalService.markSupersededByRevision(replacesRequestId, nextRequestId);
      return;
    }
    if (current.status === "superseded" && current.supersededByRequestId !== nextRequestId) {
      throw new Error(`Approval request ${replacesRequestId} was superseded by ${current.supersededByRequestId}, not ${nextRequestId}.`);
    }
  }

  private async restoreOriginalAgentApprovalAfterRevisionFailure(
    run: BlueprintRun,
    waiting: BlueprintNodeRun,
    error: unknown
  ): Promise<void> {
    await this.store.upsertNodeRun(waiting);
    await this.store.updateBlueprintRun({ ...run, status: "waiting_approval" });
    const message = error instanceof Error ? error.message : String(error);
    await this.event(run.id, "node.run.waiting_approval", `${waiting.nodeLabel} revision failed; original approval remains pending: ${message}`, waiting.id);
    await this.managerMailProjector.refresh(run.id);
  }

  private async recordAgentApprovalComment(
    run: BlueprintRun,
    nodeRunId: string,
    message: string
  ): Promise<void> {
    const nodeRuns = await this.store.listNodeRuns(run.id);
    const waiting = nodeRuns.find((nodeRun) => nodeRun.status === "waiting_approval" && nodeRun.id === nodeRunId);
    if (!waiting) {
      throw new Error("Requested approval is no longer waiting.");
    }
    if (!message.trim()) {
      throw new Error("Approval reply message is required.");
    }
    if (!isAgentApprovalWaitingOutput(waiting.output)) {
      throw new Error("Only Agent approval requests can receive replies.");
    }

    const now = new Date().toISOString();
    const userReply: AgentApprovalReply = {
      id: `approval-reply-${nanoid(10)}`,
      role: "user",
      body: message.trim(),
      createdAt: now
    };
    const repliedNodeRun: BlueprintNodeRun = {
      ...waiting,
      output: {
        ...waiting.output,
        replies: markSelectedApprovalReplies([...waiting.output.replies, userReply], waiting.output.selectedReplyId)
      }
    };
    await this.store.upsertNodeRun(repliedNodeRun);
    await this.migrationService.migratePendingNodeApproval({
      runId: run.id,
      nodeRun: repliedNodeRun,
      requestedByLabel: waiting.nodeLabel
    });
  }

  async cancelRun(run: BlueprintRun): Promise<BlueprintRun> {
    if (this.isTerminalRunStatus(run.status)) {
      if (!(await this.hasOpenNodeRuns(run.id))) {
        return run;
      }

      await this.cancelOpenNodeRuns(run.id, "Run already reached a terminal state; closing stale work.");
      const latestRun = await this.store.getBlueprintRun(run.id);
      const startedAt = new Date((latestRun ?? run).startedAt).getTime();
      const normalized = await this.applyRunTotals(latestRun ?? run, startedAt, run.status);
      await this.store.updateBlueprintRun(normalized);
      return normalized;
    }

    this.cancelledRunIds.add(run.id);
    await this.cancelOpenNodeRuns(run.id, "Run stopped by user.");

    const latestRun = await this.store.getBlueprintRun(run.id);
    const startedAt = new Date((latestRun ?? run).startedAt).getTime();
    const cancelled = await this.applyRunTotals(latestRun ?? run, startedAt, "cancelled");
    await this.store.updateBlueprintRun(cancelled);
    await this.event(run.id, "blueprint.run.cancelled", `Blueprint ${run.blueprintName ?? run.blueprintId} stopped.`);

    if (!this.activeRuns.has(run.id)) {
      this.cancelledRunIds.delete(run.id);
    }
    return cancelled;
  }

  private scheduleRun(blueprint: BlueprintDefinition, run: BlueprintRun): void {
    if (this.activeRuns.has(run.id)) {
      this.pendingRunSchedules.set(run.id, { blueprint, run });
      return;
    }

    const execution = this.runUntilBlockedOrDone(blueprint, run)
      .catch((error) => this.handleBackgroundRunError(blueprint, run, error))
      .finally(async () => {
        this.activeRuns.delete(run.id);
        if (await this.flushPendingRunSchedule(run.id)) {
          return;
        }
        this.cancelledRunIds.delete(run.id);
      });

    this.activeRuns.set(run.id, execution);
  }

  private async flushPendingRunSchedule(runId: string): Promise<boolean> {
    const pending = this.pendingRunSchedules.get(runId);
    this.pendingRunSchedules.delete(runId);
    if (!pending || await this.isRunCancelled(runId)) {
      return false;
    }

    const latestRun = await this.store.getBlueprintRun(runId);
    const nextRun = latestRun ?? pending.run;
    if (this.isTerminalRunStatus(nextRun.status)) {
      return false;
    }

    const running = { ...nextRun, status: "running" as const };
    await this.store.updateBlueprintRun(running);
    this.scheduleRun(pending.blueprint, running);
    return true;
  }

  private async handleBackgroundRunError(blueprint: BlueprintDefinition, run: BlueprintRun, error: unknown): Promise<void> {
    const currentRun = await this.store.getBlueprintRun(run.id);
    if (!currentRun) return;
    if (currentRun.status === "cancelled" || this.cancelledRunIds.has(run.id)) return;

    const message = error instanceof Error ? error.message : "Blueprint worker crashed unexpectedly.";
    await this.cancelOpenNodeRuns(run.id, `Blueprint crashed: ${message}`);
    const latestRun = await this.store.getBlueprintRun(run.id);
    const failed = await this.applyRunTotals(latestRun ?? currentRun, new Date(currentRun.startedAt).getTime(), "failed");
    await this.event(run.id, "blueprint.run.failed", `Blueprint ${blueprint.name} crashed: ${message}`);
    await this.store.updateBlueprintRun(failed);
  }

  private async runUntilBlockedOrDone(blueprint: BlueprintDefinition, run: BlueprintRun): Promise<void> {
    const startedAt = new Date(run.startedAt).getTime();

    while (true) {
      if (await this.isRunCancelled(run.id)) {
        return;
      }

      const allNodeRuns = await this.store.listNodeRuns(run.id);
      const nodeRuns = await this.scopeNodeRunsForActiveIterationRound(run.id, allNodeRuns);
      const skippedNodes = this.findSkippableNodes(blueprint, nodeRuns);
      if (skippedNodes.length > 0) {
        await Promise.all(skippedNodes.map((node) => this.skipNode(blueprint, run, node)));
        continue;
      }

      const failedNodeRun = nodeRuns.find((nodeRun) => nodeRun.status === "failed" || nodeRun.status === "cancelled");
      if (failedNodeRun) {
        await this.cancelOpenNodeRuns(run.id, `Run stopped after ${failedNodeRun.nodeLabel} ${failedNodeRun.status}.`);
        const latestRun = await this.store.getBlueprintRun(run.id);
        const failed = await this.applyRunTotals(latestRun ?? run, startedAt, "failed");
        await this.event(run.id, "blueprint.run.failed", `Blueprint ${blueprint.name} failed at node ${failedNodeRun.nodeLabel}.`);
        await this.store.updateBlueprintRun(failed);
        return;
      }

      if (await this.reconcileOpenNodeRuns(blueprint, run, nodeRuns)) {
        continue;
      }
      if (nodeRuns.some((nodeRun) => nodeRun.status === "waiting_approval")) {
        await this.store.updateBlueprintRun({ ...run, status: "waiting_approval" });
        return;
      }

      const readyNodes = this.findReadyNodes(blueprint, nodeRuns);
      if (readyNodes.length === 0) {
        if (nodeRuns.some((nodeRun) => nodeRun.status === "queued" || nodeRun.status === "running")) {
          await this.keepRunActive(run, "running");
          return;
        }

        const pending = blueprint.nodes.filter(
          (node) =>
            this.isGlobalSchedulingNode(blueprint, node) &&
            !this.hasCurrentTerminalNodeRun(blueprint, node, nodeRuns)
        );
        if (pending.length === 0) {
          const selfIterationPublishResult = await this.publishSelfIterationRoundIfNeeded(blueprint, run, nodeRuns);
          if (selfIterationPublishResult === "continue") {
            continue;
          }
          if (selfIterationPublishResult === "handled") {
            return;
          }
          const completed = await this.applyRunTotals(run, startedAt, "succeeded");
          await this.event(run.id, "blueprint.run.completed", `Blueprint ${blueprint.name} completed.`);
          await this.store.updateBlueprintRun(completed);
          return;
        }

        const failed = await this.applyRunTotals(run, startedAt, "failed");
        await this.event(run.id, "blueprint.run.failed", `Blueprint ${blueprint.name} could not continue. Pending nodes: ${pending.map((node) => node.id).join(", ")}.`);
        await this.store.updateBlueprintRun(failed);
        return;
      }

      await Promise.all(readyNodes.map((node) => this.executeNode(blueprint, run, node)));
    }
  }

  private async publishSelfIterationRoundIfNeeded(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    nodeRuns: BlueprintNodeRun[]
  ): Promise<SelfIterationPublishResult> {
    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager) return "none";
    const executingRound = (await this.store.listIterationRounds({ runId: run.id, status: "executing" })).at(-1);
    if (!executingRound) return "none";

    const succeededRuns = nodeRuns.filter((nodeRun) =>
      !this.isPreflightNodeRun(nodeRun) && nodeRun.status === "succeeded" && nodeRun.output !== undefined
    );
    const artifactRunIds = new Set(
      succeededRuns
        .filter((nodeRun) => this.isArtifactProducingNodeRun(blueprint, nodeRun))
        .map((nodeRun) => nodeRun.id)
    );
    const artifacts = (await this.store.listArtifacts(run.id)).filter((artifact) =>
      artifact.roundId === executingRound.id &&
      artifact.nodeRunId !== undefined &&
      artifactRunIds.has(artifact.nodeRunId) &&
      (artifact.status ?? "current") === "current"
    );
    const [agentReports, agentHandoffs, approvedPlanRequest] = await Promise.all([
      this.store.listAgentHumanReports(run.id).then((reports) => reports.filter((report) => report.roundId === executingRound.id)),
      this.store.listAgentHandoffs(run.id).then((handoffs) => handoffs.filter((handoff) => handoff.roundId === executingRound.id)),
      executingRound.approvedRequirementRequestId
        ? this.store.getApprovalRequest(executingRound.approvedRequirementRequestId)
        : Promise.resolve(undefined)
    ]);
    const nodeRunsById = new Map(nodeRuns.map((nodeRun) => [nodeRun.id, nodeRun]));
    const releaseAgentReports = agentReports.filter((report) => {
      const nodeRun = nodeRunsById.get(report.nodeRunId);
      return !(nodeRun?.nodeType === "manager" && report.source === "fallback");
    });
    const summary = await this.writeSelfIterationReleaseReport({
      blueprint,
      run,
      round: executingRound,
      managerNode: topManager,
      roundNumber: executingRound.roundNumber,
      approvedPlan: approvedPlanRequest ? {
        title: approvedPlanRequest.title,
        revision: executingRound.approvedRequirementRevision ?? approvedPlanRequest.revision,
        body: approvedPlanRequest.body
      } : undefined,
      research: {
        status: executingRound.researchStatus,
        summary: executingRound.researchSummary
      },
      artifacts,
      agentReports: releaseAgentReports,
      agentHandoffs
    });
    await this.iterationService.publishExecutionResult({
      run,
      managerNode: topManager,
      summary,
      artifacts
    });
    const autoAdvanced = await this.autoAdvanceSelfIterationApprovals(blueprint, run, { scheduleOnResume: false });
    if (autoAdvanced?.completeRun) {
      return "handled";
    }
    if (autoAdvanced?.resumeExecution) {
      return "continue";
    }
    const waiting = { ...run, status: "waiting_approval" as const };
    await this.store.updateBlueprintRun(waiting);
    await this.managerMailProjector.refresh(run.id);
    return "handled";
  }

  private async writeSelfIterationReleaseReport(input: {
    blueprint: BlueprintDefinition;
    run: BlueprintRun;
    round: IterationRound;
    managerNode: BlueprintNode;
    roundNumber?: number;
    approvedPlan?: { title: string; revision: number; body: string };
    research?: { status?: string; summary?: string };
    artifacts: Array<{ id: string; title?: string; kind: string; downloadUrl?: string; relativePath?: string; storagePath?: string }>;
    agentReports: AgentHumanReport[];
    agentHandoffs: AgentHandoff[];
    revision?: {
      feedback: string;
      previousReport?: {
        title: string;
        summary: string;
        version: number;
      };
    };
  }): Promise<string> {
    const config = input.managerNode.config as ManagerNodeConfig;
    const runtimeId = this.resolveManagerRuntimeId(input.managerNode);
    const taskInput = {
      task: "self_iteration_release_report",
      runId: input.run.id,
      blueprintName: input.blueprint.name,
      manager: this.buildManagerRoundMetadata(input.managerNode, input.round.roundNumber),
      roundNumber: input.roundNumber ?? input.round.roundNumber,
      approvedPlan: input.approvedPlan,
      research: input.research,
      artifacts: input.artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        location: artifact.storagePath ?? artifact.downloadUrl ?? artifact.relativePath ?? artifact.id,
        downloadUrl: artifact.downloadUrl,
        storagePath: artifact.storagePath,
        relativePath: artifact.relativePath
      })),
      agentReports: input.agentReports.map((report) => ({
        nodeId: report.nodeId,
        nodeLabel: report.nodeLabel,
        title: report.title,
        bodyMd: report.bodyMd
      })),
      agentHandoffs: input.agentHandoffs.map((handoff) => ({
        nodeId: handoff.nodeId,
        payload: handoff.payload
      })),
      revision: input.revision
    };
    let nodeRun = await this.createRunningNodeRun(input.blueprint, input.run, input.managerNode, taskInput);
    const { result, runtimeRef } = await this.runAgentTask({
      blueprintRunId: input.run.id,
      nodeRunId: nodeRun.id,
      source: resolveAgentRuntimeSource(runtimeId),
      agentId: runtimeId === "openclaw" ? config.openclawAgentId ?? "main" : undefined,
      profileId: runtimeId === "hermes" ? config.profileId : undefined,
      agentName: config.agentName?.trim() || defaultManagerAgentName,
      prompt: this.resolveManagerReleaseReportPrompt(config, { revision: Boolean(input.revision) }),
      modelId: config.modelId,
      permissionProfile: config.permissionProfile,
      runtimeAccessPolicy: config.runtimeAccessPolicy,
      workingDirectory: config.workingDirectory,
      timeoutMs: config.timeoutMs,
      outputSchema: humanReportEnvelopeSchemaBase,
      input: taskInput,
      skillIds: config.skillIds,
      tools: config.tools ?? []
    }, async (startedRef) => {
      nodeRun = await this.recordNodeRuntimeRef(nodeRun, startedRef);
    });
    if (result.status !== "succeeded") {
      await this.failNode({ ...nodeRun, runtimeRef, usage: result.usage }, result.error ?? `Manager release report run ${result.status}.`);
      throw new Error(result.error ?? `Manager release report run ${result.status}.`);
    }
    const humanReport = this.agentReportService.extractHumanReport(result.output);
    if (!humanReport?.bodyMd) {
      const error = "Manager release report run did not return humanReportMd.";
      await this.failNode({ ...nodeRun, runtimeRef, usage: result.usage }, error);
      throw new Error(error);
    }
    await this.completeNode({ ...nodeRun, runtimeRef, usage: result.usage }, result.output, runtimeRef);
    return humanReport.bodyMd;
  }

  private async buildManagerSnapshotDraft(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    session: IterationSession,
    round: IterationRound,
    topManager: BlueprintNode,
    releaseReport: ReleaseReport,
    humanFeedback?: string
  ): Promise<ManagerSnapshotDraft | undefined> {
    const roundStartContext = await this.managerContextService.buildRoundStartContext({
      run,
      session,
      round,
      managerNode: topManager,
      humanFeedback
    });
    const runContext = this.managerContextService.buildManagerInjectedContext(roundStartContext, {
      mode: "context_snapshot",
      roundStatus: round.status,
      research: {
        status: round.researchStatus,
        summary: round.researchSummary,
        source: round.researchStatus
      }
    });
    const agentReports = (await this.store.listAgentHumanReports(run.id))
      .filter((report) => report.roundId === round.id);
    try {
      const executed = await this.runPreflightManagerFallback(
        blueprint,
        run,
        round,
        topManager,
        "context_snapshot",
        runContext,
        {
          runId: run.id,
          blueprintName: blueprint.name,
          roundNumber: round.roundNumber,
          releaseReport,
          humanFeedback,
          agentReports: agentReports.map((report) => ({
            nodeId: report.nodeId,
            nodeLabel: report.nodeLabel,
            bodyMd: report.bodyMd,
            source: report.source
          })),
          requiredFields: [
            "completedItems",
            "rejectedOptions",
            "keyDecisions",
            "validatedFacts",
            "openQuestions",
            "activeRisks",
            "assumptions",
            "recommendedNextStep",
            "summary",
            "freeform"
          ],
          instruction: "Create a durable cross-round manager memory snapshot after report confirmation. Treat releaseReport as the confirmed report and fold humanFeedback into the memory when present. Fill required fields with concrete content and use freeform for task-specific context.",
          runContext
        }
      );
      if (executed.result.status !== "succeeded") return undefined;
      return readManagerSnapshotDraft(executed.result.output);
    } catch {
      return undefined;
    }
  }

  private async autoAdvanceSelfIterationApprovals(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    options: { scheduleOnResume?: boolean } = {}
  ): Promise<AutoAdvanceResult | undefined> {
    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager) return undefined;

    const config = topManager.config as ManagerNodeConfig;
    let changed = false;
    let currentRun = run;

    for (let guard = 0; guard < 20; guard += 1) {
      const request = await this.nextAutoResolvableRequest(run.id, topManager.id, config);
      if (!request) break;

      const result = await this.approvalService.autoResolve(request.id, "Auto-resolved by manager lifecycle policy.");
      changed = true;
      const lifecycle = await this.iterationService.handleApprovalResult(result);
      await this.persistManagerSnapshotAfterReleaseDecision(blueprint, currentRun, result);
      await this.managerMailProjector.refresh(run.id);

      if (lifecycle.prepareNextRound) {
        await this.prepareNextRoundFromIntent(blueprint, currentRun, lifecycle.prepareNextRound);
        currentRun = { ...currentRun, status: "waiting_approval" as const };
        await this.store.updateBlueprintRun(currentRun);
        continue;
      }

      if (lifecycle.completeRun) {
        const completed = await this.applyRunTotals(currentRun, new Date(currentRun.startedAt).getTime(), "succeeded");
        await this.store.updateBlueprintRun(completed);
        return { run: completed, changed, resumeExecution: false, completeRun: true };
      }

      if (lifecycle.resumeExecution) {
        const running = { ...currentRun, status: "running" as const };
        await this.store.updateBlueprintRun(running);
        if (options.scheduleOnResume !== false) {
          this.scheduleRun(blueprint, running);
        }
        return { run: running, changed, resumeExecution: true, completeRun: false };
      }

      currentRun = { ...currentRun, status: "waiting_approval" as const };
    }

    if (!changed) return undefined;
    await this.store.updateBlueprintRun(currentRun);
    return { run: currentRun, changed, resumeExecution: false, completeRun: false };
  }

  private async nextAutoResolvableRequest(
    runId: string,
    topManagerNodeId: string,
    config: ManagerNodeConfig
  ): Promise<ApprovalRequest | undefined> {
    const requests = await this.store.listApprovalRequests({ runId, status: "pending" });
    return this.selfIterationOrchestrator.selectNextAutoResolvableRequest({
      requests,
      topManagerNodeId,
      config
    });
  }

  private async scopeNodeRunsForActiveIterationRound(
    runId: string,
    nodeRuns: BlueprintNodeRun[]
  ): Promise<BlueprintNodeRun[]> {
    const runtimeNodeRuns = nodeRuns.filter((nodeRun) => !this.isPreflightNodeRun(nodeRun));
    const executingRound = (await this.store.listIterationRounds({ runId, status: "executing" })).at(-1);
    if (!executingRound) return runtimeNodeRuns;

    const roundStartedAt = Date.parse(executingRound.startedAt);
    const scoped = runtimeNodeRuns.filter((nodeRun) =>
      nodeRun.iterationRoundId === executingRound.id && isNodeRunAtOrAfter(nodeRun, roundStartedAt)
    );
    if (scoped.length > 0 || runtimeNodeRuns.some((nodeRun) => nodeRun.iterationRoundId)) {
      return scoped;
    }

    if (!Number.isFinite(roundStartedAt)) return runtimeNodeRuns;
    return runtimeNodeRuns.filter((nodeRun) => isNodeRunAtOrAfter(nodeRun, roundStartedAt));
  }

  private async currentExecutingRoundId(runId: string): Promise<string | undefined> {
    return (await this.store.listIterationRounds({ runId, status: "executing" })).at(-1)?.id;
  }

  private async reconcileOpenNodeRuns(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    nodeRuns: BlueprintNodeRun[]
  ): Promise<boolean> {
    const runningNodeRuns = nodeRuns.filter((nodeRun) => !this.isPreflightNodeRun(nodeRun) && nodeRun.status === "running");
    for (const nodeRun of runningNodeRuns) {
      const node = blueprint.nodes.find((candidate) => candidate.id === nodeRun.nodeId);
      if (node && isAgentBlueprintNode(node)) {
        if (await this.reconcileRunningAgentNode(blueprint, run, node, nodeRun)) return true;
      }
    }

    for (const nodeRun of runningNodeRuns) {
      const node = blueprint.nodes.find((candidate) => candidate.id === nodeRun.nodeId);
      if (node?.type === "manager_slot") {
        if (await this.reconcileRunningManagerSlotNode(blueprint, run, node, nodeRun, nodeRuns)) return true;
      }
    }

    for (const nodeRun of runningNodeRuns) {
      const node = blueprint.nodes.find((candidate) => candidate.id === nodeRun.nodeId);
      if (node?.type === "manager") {
        if (await this.reconcileRunningManagerNode(blueprint, run, node, nodeRun, nodeRuns)) return true;
      }
    }

    return false;
  }

  private async reconcileRunningAgentNode(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode & { type: "agent"; runtimeId: AgentRuntimeId; config: AgentNodeConfig },
    nodeRun: BlueprintNodeRun
  ): Promise<boolean> {
    const runtimeRef = this.resolveAgentRuntimeRef(node, nodeRun);
    if (!runtimeRef?.sessionKey) return false;
    const runtimeId = node.runtimeId ?? "openclaw";
    const claim = await this.ensureNodeRunClaim(nodeRun);
    if (!claim) {
      await this.keepRunActive(run, "running");
      return false;
    }

    let result: AgentTaskResult;
    try {
      result = await this.adapter.waitForAgentTask({
        nodeRunId: nodeRun.id,
        taskId: runtimeRef.taskId ?? runtimeRef.sourceId,
        runId: runtimeRef.runId ?? runtimeRef.sourceId,
        sessionKey: runtimeRef.sessionKey,
        source: runtimeRef.source,
        agentId: runtimeId === "openclaw" ? (node.config as AgentNodeConfig).openclawAgentId ?? "main" : undefined,
        modelId: (node.config as AgentNodeConfig).modelId
      });
    } catch (error) {
      if (this.isRecoverableSdkTaskLookupMiss(error, runtimeRef)) {
        const message = error instanceof Error ? error.message : String(error);
        await this.event(
          run.id,
          "node.run.started",
          `${nodeRun.nodeLabel} is still running; ${formatRuntimeSource(runtimeRef.source)} task ${runtimeRef.taskId ?? runtimeRef.sourceId} is not ready to reconcile yet: ${message}`,
          nodeRun.id,
          runtimeRef
        );
        await this.keepRunActive(run, "running");
        return false;
      }
      throw error;
    }
    const finalRef: RuntimeObjectRef = {
      ...runtimeRef,
      sourceId: result.taskId,
      sourceUpdatedAt: result.updatedAt,
      taskId: result.taskId,
      runId: result.runId,
      sessionKey: result.sessionKey,
      usageRef: result.usage?.id
    };
    await this.applyAgentTaskResult(blueprint, run, node, { ...nodeRun, runtimeRef: finalRef }, result, finalRef);
    return true;
  }

  private async reconcileRunningManagerSlotNode(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    slotNode: BlueprintNode,
    slotRun: BlueprintNodeRun,
    nodeRuns: BlueprintNodeRun[]
  ): Promise<boolean> {
    const context = this.readManagerSlotContext(slotRun.input);
    if (!context) return false;

    const scopeStartIndex = nodeRuns.findIndex((candidate) => candidate.id === slotRun.id);
    if (scopeStartIndex < 0) return false;

    const childNodes = blueprint.nodes.filter((node) => node.parentId === slotNode.id && this.isRunnableNode(node));
    if (childNodes.length === 0) {
      const slotInput = isRecord(slotRun.input) ? slotRun.input : {};
      const output = JSON.stringify({
        status: "complete",
        reason: "manager_slot_empty",
        input: { status: "manager_slot_input", ...slotInput }
      });
      await this.completeNode(slotRun, output);
      return true;
    }

    const childIds = new Set(childNodes.map((node) => node.id));
    const failed = nodeRuns.find(
      (candidate, index) =>
        index > scopeStartIndex &&
        childIds.has(candidate.nodeId) &&
        (candidate.status === "failed" || candidate.status === "cancelled")
    );
    if (failed) {
      await this.failNode(slotRun, failed.error ?? `${failed.nodeLabel} returned ${failed.status}.`);
      return true;
    }

    const output = this.resolveManagerSlotOutput(blueprint, slotNode, childNodes, nodeRuns, scopeStartIndex);
    if (output !== undefined) {
      await this.completeNode(slotRun, stringifyManagerSlotOutput(output));
      return true;
    }

    const hasRunningChild = nodeRuns.some(
      (candidate, index) => index > scopeStartIndex && childIds.has(candidate.nodeId) && candidate.status === "running"
    );
    if (hasRunningChild) return false;

    await this.executeManagerSlotNode(blueprint, run, slotNode, slotRun, context, scopeStartIndex);
    return true;
  }

  private async reconcileRunningManagerNode(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode,
    nodeRun: BlueprintNodeRun,
    nodeRuns: BlueprintNodeRun[]
  ): Promise<boolean> {
    const config = node.config as ManagerNodeConfig;
    const portCount = normalizeInteger(config.portCount, 1, 8, 3);
    const maxHandoffs = normalizeInteger(config.maxHandoffs, 1, 50, 12);
    const dispatchRunContext = await this.buildDispatchRunContext(run, node);
    const initialManagerRoundNumber = await this.resolveManagerRoundNumber(run.id, nodeRun);
    const nodeRunWithInput = nodeRun.input === undefined
      ? await this.recordNodeInput(nodeRun, {
          manager: this.buildManagerRoundMetadata(node, initialManagerRoundNumber),
          upstream: await this.collectUpstreamOutputs(blueprint, run.id, node),
          ...(dispatchRunContext ? { runContext: dispatchRunContext } : {})
        })
      : readManagerRoundNumberFromManagerContext(nodeRun.input) === undefined
        ? await this.recordNodeInput(nodeRun, {
            ...(isRecord(nodeRun.input) ? nodeRun.input : {}),
            manager: this.buildManagerRoundMetadata(node, initialManagerRoundNumber),
            upstream: isRecord(nodeRun.input) && Array.isArray(nodeRun.input.upstream)
              ? nodeRun.input.upstream as UpstreamOutput
              : await this.collectUpstreamOutputs(blueprint, run.id, node),
            ...(isRecord(nodeRun.input) && "runContext" in nodeRun.input
              ? { runContext: nodeRun.input.runContext }
              : dispatchRunContext ? { runContext: dispatchRunContext } : {})
          })
      : nodeRun;
    const managerUpstream = this.readUpstreamInput(nodeRunWithInput.input);
    const isAgentDriven = this.isAgentDrivenManager(node);
    const firstWorkSlot = this.firstManagerWorkSlot(node);
    const trace: ManagerTraceItem[] = [];
    let managerRoundNumber = await this.resolveManagerRoundNumber(run.id, nodeRunWithInput);
    let slot = this.firstConnectedManagerSlot(blueprint, node, portCount, firstWorkSlot);
    let searchAfterIndex = nodeRuns.findIndex((candidate) => candidate.id === nodeRun.id);
    if (searchAfterIndex < 0) return false;

    if (!slot) {
      await this.completeNode(nodeRunWithInput, {
        status: "completed",
        roundNumber: managerRoundNumber,
        reason: firstWorkSlot > 1 ? "manager_has_no_connected_work_slots" : "manager_has_no_connected_slots",
        trace
      });
      return true;
    }

    for (let handoff = 1; handoff <= maxHandoffs; handoff += 1) {
      let managerDecision: ManagerDecision | undefined;
      const existingAssignment = this.findManagerSlotAssignment(blueprint, node, slot);
      const existingParticipant = existingAssignment
        ? this.findFirstNodeRunAfter(nodeRuns, existingAssignment.target.id, searchAfterIndex)
        : undefined;
      if (isAgentDriven && !existingParticipant) {
        const context: ManagerSlotContext = {
          manager: {
            nodeId: node.id,
            nodeLabel: node.config.label,
            instructions: config.instructions,
            roundNumber: managerRoundNumber,
            slot,
            handoff,
            maxHandoffs
          },
          upstream: managerUpstream,
          ...(managerDecision ? { managerDecision } : {}),
          previousResults: this.managerPreviousResultsFromTrace(trace)
        };
        const managerDecisionResult = await this.runManagerDecisionTask(blueprint, run, node, nodeRunWithInput, context, dispatchRunContext, slot, portCount, firstWorkSlot);
        if (managerDecisionResult.result.status !== "succeeded") {
          await this.failNode(nodeRunWithInput, managerDecisionResult.result.error ?? "Manager decision agent failed.");
          return true;
        }
        managerDecision = managerDecisionResult.decision;
        managerRoundNumber = managerDecision.roundNumber ?? managerRoundNumber;
        if (managerDecision.status === "complete" || managerDecision.nextSlot === undefined) {
          await this.completeNode(nodeRunWithInput, {
            status: "completed",
            roundNumber: managerRoundNumber,
            reason: managerDecision.reason ?? "manager_completed",
            trace
          });
          return true;
        }
        slot = managerDecision.nextSlot;
      }

      const assignment = this.findManagerSlotAssignment(blueprint, node, slot);
      if (!assignment) {
        await this.completeNode(nodeRunWithInput, {
          status: "completed",
          roundNumber: managerRoundNumber,
          reason: `manager_slot_${slot}_is_not_connected`,
          trace
        });
        return true;
      }

      if (assignment.target.disabled) {
        const decision = this.resolveManagerDecision({ status: "skipped" }, slot, portCount, { minSlot: firstWorkSlot });
        trace.push({
          handoff,
          slot,
          nodeId: assignment.target.id,
          nodeLabel: assignment.target.config.label,
          status: "cancelled",
          error: "disabled",
          returnEdgePresent: assignment.returnEdgePresent,
          managerDecision,
          decision
        });
        slot = decision.nextSlot ?? slot + 1;
        if (slot > portCount || decision.status === "complete") {
          await this.completeNode(nodeRunWithInput, {
            status: "completed",
            roundNumber: managerRoundNumber,
            reason: decision.reason ?? "manager_reached_final_slot",
            trace
          });
          return true;
        }
        continue;
      }

      const participant = this.findFirstNodeRunAfter(nodeRuns, assignment.target.id, searchAfterIndex);
      if (!participant) {
        const context: ManagerSlotContext = {
          manager: {
            nodeId: node.id,
            nodeLabel: node.config.label,
            instructions: config.instructions,
            roundNumber: managerRoundNumber,
            slot,
            handoff,
            maxHandoffs
          },
          upstream: managerUpstream,
          ...(managerDecision ? { managerDecision } : {}),
          previousResults: this.managerPreviousResultsFromTrace(trace)
        };
        await this.executeManagerAssignment(blueprint, run, node, nodeRunWithInput, assignment, context);
        return true;
      }

      if (!this.isTerminalStatus(participant.nodeRun.status)) return false;
      managerRoundNumber = readManagerRoundNumberFromManagerContext(participant.nodeRun.input) ?? managerRoundNumber;

      const result = this.nodeRunToAgentTaskResult(participant.nodeRun);
      const receipt = await this.buildManagerResultReceipt(blueprint, run.id, participant.nodeRun, result.output);
      const traceItem: ManagerTraceItem = {
        handoff,
        slot,
        nodeId: assignment.target.id,
        nodeLabel: assignment.target.config.label,
        status: result.status,
        output: result.output,
        error: result.error,
        returnEdgePresent: assignment.returnEdgePresent,
        managerDecision,
        receipt
      };
      trace.push(traceItem);
      searchAfterIndex = participant.index;

      if (result.status !== "succeeded") {
        const error = result.error ?? `Manager participant ${assignment.target.config.label} returned ${result.status}.`;
        await this.failNode(nodeRunWithInput, error);
        return true;
      }

      if (isAgentDriven) {
        traceItem.decision = {
          status: "continue",
          nextSlot: slot,
          reason: "manager_will_decide_after_result"
        };
        continue;
      }

      const decision = this.resolveSequentialManagerDecision(blueprint, node, slot, portCount, firstWorkSlot);
      traceItem.decision = decision;
      if (decision.status === "complete" || !decision.nextSlot) {
        await this.completeNode(nodeRunWithInput, {
          status: "completed",
          roundNumber: managerRoundNumber,
          reason: decision.reason ?? "manager_reached_final_connected_slot",
          trace
        });
        return true;
      }
      slot = decision.nextSlot;
    }

    await this.failNode(nodeRunWithInput, `Manager exceeded max handoffs (${maxHandoffs}).`);
    return true;
  }

  private async executeManagerAssignment(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    managerNode: BlueprintNode,
    managerRun: BlueprintNodeRun,
    assignment: { target: BlueprintNode; returnEdgePresent: boolean },
    context: ManagerSlotContext
  ): Promise<AgentTaskResult> {
    if (isAgentBlueprintNode(assignment.target)) {
      const participantRun = await this.createRunningNodeRun(blueprint, run, assignment.target, context);
      return this.executeAgentNodeWithInput(blueprint, run, assignment.target, participantRun, context);
    }
    if (assignment.target.type === "manager_slot") {
      const slotRun = await this.createRunningNodeRun(blueprint, run, assignment.target, context);
      return this.executeManagerSlotNode(blueprint, run, assignment.target, slotRun, context);
    }
    if (assignment.target.type === "manager") {
      const managerUpstreamInput: UpstreamOutput = [
        {
          nodeId: managerNode.id,
          nodeLabel: managerNode.config.label,
          nodeRunId: managerRun.id,
          status: managerRun.status,
          context
        }
      ];
      const nestedManagerRun = await this.createRunningNodeRun(blueprint, run, assignment.target, { upstream: managerUpstreamInput });
      return this.executeManagerNode(blueprint, run, assignment.target, nestedManagerRun, managerUpstreamInput);
    }

    const error = `Manager slot ${context.manager.slot} targets unsupported node type ${assignment.target.type}.`;
    await this.failNode(managerRun, error);
    return this.syntheticAgentResult(managerRun.id, "failed", undefined, error);
  }

  private async buildDispatchRunContext(
    run: BlueprintRun,
    managerNode: BlueprintNode
  ): Promise<ManagerInjectedContext | undefined> {
    const session = (await this.store.listIterationSessions(run.id))
      .filter((candidate) => candidate.status === "running")
      .at(-1);
    if (!session) return undefined;
    const round = session.currentRoundId
      ? (await this.store.listIterationRounds({ runId: run.id })).find((candidate) => candidate.id === session.currentRoundId)
      : (await this.store.listIterationRounds({ runId: run.id })).at(-1);
    if (!round) return undefined;
    const roundStartContext = await this.managerContextService.buildRoundStartContext({
      run,
      session,
      round,
      managerNode
    });
    return this.managerContextService.buildManagerInjectedContext(roundStartContext, {
      mode: "dispatch",
      roundStatus: round.status,
      research: {
        status: round.researchStatus,
        summary: round.researchSummary,
        source: round.researchStatus
      }
    });
  }

  private async runManagerDecisionTask(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode,
    nodeRun: BlueprintNodeRun,
    context: ManagerSlotContext,
    runContext: ManagerInjectedContext | undefined,
    fallbackSlot: number,
    portCount: number,
    minSlot = 1
  ): Promise<{ result: AgentTaskResult; decision: ManagerDecision; runtimeRef: RuntimeObjectRef }> {
    const config = node.config as ManagerNodeConfig;
    const runtimeId = this.resolveManagerRuntimeId(node);
    const managerDecisionNodeRunId = `${nodeRun.id}-manager-decision-${context.manager.handoff}`;
    const { result, runtimeRef } = await this.runAgentTask({
      blueprintRunId: run.id,
      nodeRunId: managerDecisionNodeRunId,
      source: resolveAgentRuntimeSource(runtimeId),
      agentId: runtimeId === "openclaw" ? config.openclawAgentId ?? "main" : undefined,
      profileId: runtimeId === "hermes" ? config.profileId : undefined,
      agentName: config.agentName?.trim() || defaultManagerAgentName,
      prompt: this.resolveManagerPrompt(config),
      modelId: config.modelId,
      permissionProfile: config.permissionProfile,
      runtimeAccessPolicy: config.runtimeAccessPolicy,
      workingDirectory: config.workingDirectory,
      timeoutMs: config.timeoutMs,
      outputSchema: managerDecisionOutputSchema,
      input: {
        manager: context.manager,
        ...(runContext ? { runContext } : {}),
        upstream: context.upstream,
        previousResults: context.previousResults,
        delegationRoster: this.buildManagerDelegationRoster(blueprint, node, portCount, minSlot),
        decisionContract: {
          status: "continue | complete | retry; complete means current-round delegation is done, not that the round is approved",
          roundNumber: "copy input.manager.roundNumber exactly; do not infer, increment, or announce a next round",
          nextSlot: "numbered slot to delegate next; required for continue or retry, omitted when complete",
          reason: "short explanation for the route inside the current round"
        }
      },
      skillIds: config.skillIds,
      tools: config.tools ?? []
    });
    if (result.status !== "succeeded") {
      await this.publishManagerDecisionReport({
        run,
        node,
        nodeRunId: managerDecisionNodeRunId,
        roundId: nodeRun.iterationRoundId,
        handoff: context.manager.handoff,
        result
      });
      return {
        result,
        decision: { status: "complete", reason: result.error ?? "manager_decision_failed" },
        runtimeRef
      };
    }
    const decision = this.resolveManagerDecision(result.output, Math.max(minSlot - 1, fallbackSlot - 1), portCount, { minSlot });
    if (decision.roundNumber === undefined) {
      return {
        result: { ...result, status: "failed", error: "Manager decision result.roundNumber is required." },
        decision: { status: "complete", reason: "manager_decision_missing_round_number" },
        runtimeRef
      };
    }
    const roundValidationError = validateManagerDecisionRoundNumber(decision.roundNumber, context.manager.roundNumber);
    if (roundValidationError) {
      return {
        result: { ...result, status: "failed", error: roundValidationError },
        decision: { status: "complete", reason: "manager_decision_invalid_round_number" },
        runtimeRef
      };
    }

    await this.publishManagerDecisionReport({
      run,
      node,
      nodeRunId: managerDecisionNodeRunId,
      roundId: nodeRun.iterationRoundId,
      handoff: context.manager.handoff,
      result
    });

    return { result, decision, runtimeRef };
  }

  private async publishManagerDecisionReport(input: {
    run: BlueprintRun;
    node: BlueprintNode;
    nodeRunId: string;
    roundId?: string;
    handoff: number;
    result: AgentTaskResult;
  }): Promise<void> {
    const output = input.result.output ?? input.result.error;
    if (output === undefined) return;

    const nodeLabel = usesChineseText(input.node.config.label)
      ? `${input.node.config.label} \u00b7 \u8c03\u5ea6 ${input.handoff}`
      : `${input.node.config.label} dispatch ${input.handoff}`;
    const published = await this.agentReportService.publishFromOutput({
      runId: input.run.id,
      roundId: input.roundId,
      nodeRunId: input.nodeRunId,
      nodeId: input.node.id,
      nodeLabel,
      output
    });
    if (!published.humanReport) return;

    const existing = (await this.store.listRunTimeline(input.run.id))
      .find((item) => item.payloadRef === published.humanReport?.id);
    await this.store.appendRunTimelineItem({
      id: existing?.id ?? `timeline-${nanoid(10)}`,
      ...(existing?.sequence ? { sequence: existing.sequence } : {}),
      runId: input.run.id,
      createdAt: published.humanReport.createdAt,
      actorNodeId: input.node.id,
      actorLabel: nodeLabel,
      kind: "node_output",
      title: nodeLabel,
      body: published.humanReport.bodyMd,
      payloadRef: published.humanReport.id
    });
  }

  private resolveManagerRuntimeId(node: BlueprintNode): AgentRuntimeId {
    return node.runtimeId === "codex" ||
      node.runtimeId === "claude" ||
      node.runtimeId === "google" ||
      node.runtimeId === "cursor" ||
      node.runtimeId === "opencode" ||
      node.runtimeId === "hermes" ||
      node.runtimeId === "openclaw"
      ? node.runtimeId
      : "openclaw";
  }

  private isAgentDrivenManager(node: BlueprintNode): boolean {
    const dispatchMode = (node.config as ManagerNodeConfig).dispatchMode;
    return node.type === "manager" &&
      dispatchMode === "self_dispatch" &&
      (node.runtimeId === "openclaw" ||
        node.runtimeId === "codex" ||
        node.runtimeId === "claude" ||
        node.runtimeId === "google" ||
        node.runtimeId === "cursor" ||
        node.runtimeId === "opencode" ||
        node.runtimeId === "hermes");
  }

  private resolveManagerPrompt(config: ManagerNodeConfig): string {
    const customPrompt = config.instructions?.trim();
    return [
      customPrompt || defaultManagerPrompt,
      "",
      "Round lifecycle contract:",
      "- input.manager.roundNumber is platform lifecycle state and the single source of truth for this decision.",
      "- result.roundNumber must equal input.manager.roundNumber exactly on every response.",
      "- Do not infer, increment, create, approve, or announce the next round. The platform creates it only after the user approves the manager_release_report for the current round.",
      "- result.status=\"complete\" means current-round delegation is finished and ready for platform report handling; it is not a user approval signal and it does not advance the round.",
      "- Slot and Agent work inherits this Manager round. Do not ask downstream nodes to change the round number.",
      "",
      "Delegation rules:",
      "- Treat delegationRoster entries as descriptions of available subordinates, not as instructions for you to execute directly.",
      "- Pick only slots that exist in delegationRoster unless completing the workflow.",
      "- Return JSON for routing decisions.",
      "- Every routing decision must include reason, explaining the upstream task, completed receipts you considered, and why you chose the next slot or completion.",
      ...agentOutputContractLines,
      "- For any manager result that summarizes completed work, include humanReportMd as a free-form Markdown report and handoffJson as structured continuation context.",
      "- Keep Markdown for humans separate from machine handoff JSON."
    ].join("\n");
  }

  private resolveAgentPrompt(config: AgentNodeConfig, options: { requiresHandoff?: boolean } = {}): string {
    const userPrompt = config.userPrompt?.trim();
    const contract = [
      ...agentOutputContractLines,
      options.requiresHandoff
        ? "- This node has downstream consumers, so handoffJson is required for machine continuation."
        : "- If you know later work will use this result, include handoffJson even when no direct edge is visible."
    ].join("\n");
    const base = userPrompt ? [
      "System prompt:",
      config.prompt,
      "",
      "User prompt:",
      userPrompt
    ].join("\n") : config.prompt;
    return [base, "", contract].join("\n");
  }

  private hasDownstreamConsumers(blueprint: BlueprintDefinition, node: BlueprintNode): boolean {
    return blueprint.edges.some((edge) => edge.source === node.id);
  }

  private buildManagerDelegationRoster(
    blueprint: BlueprintDefinition,
    managerNode: BlueprintNode,
    portCount: number,
    minSlot = 1
  ): Record<string, unknown> {
    let remainingPromptBudget = managerRosterPromptBudget;
    const readPrompt = (value: string | undefined): { prompt?: string; promptTruncated?: boolean } => {
      if (!value?.trim() || remainingPromptBudget <= 0) {
        return value?.trim() ? { promptTruncated: true } : {};
      }
      const limit = Math.min(managerRosterItemPromptBudget, remainingPromptBudget);
      const prompt = value.length > limit ? value.slice(0, limit) : value;
      remainingPromptBudget -= prompt.length;
      return {
        prompt,
        promptTruncated: prompt.length < value.length
      };
    };

    return {
      policy: "full_prompts_with_deterministic_truncation",
      promptBudget: managerRosterPromptBudget,
      slotRange: {
        first: minSlot,
        last: portCount
      },
      slots: Array.from({ length: Math.max(0, portCount - minSlot + 1) }, (_item, index) => minSlot + index).flatMap((slot) => {
        const assignment = this.findManagerSlotAssignment(blueprint, managerNode, slot);
        if (!assignment) return [];
        return [
          {
            slot,
            returnEdgePresent: assignment.returnEdgePresent,
            target: this.describeManagerDelegationTarget(blueprint, assignment.target, readPrompt)
          }
        ];
      })
    };
  }

  private describeManagerDelegationTarget(
    blueprint: BlueprintDefinition,
    target: BlueprintNode,
    readPrompt: (value: string | undefined) => { prompt?: string; promptTruncated?: boolean }
  ): Record<string, unknown> {
    if (isAgentBlueprintNode(target)) {
      const config = target.config as AgentNodeConfig;
      return {
        nodeId: target.id,
        label: config.label,
        type: target.type,
        runtimeId: target.runtimeId,
        openclawAgentId: config.openclawAgentId,
        agentName: config.agentName,
        description: config.description,
        ...readPrompt(this.resolveAgentPrompt(config))
      };
    }

    if (target.type === "manager_slot") {
      const children = blueprint.nodes
        .filter((node) => node.parentId === target.id && this.isRunnableNode(node))
        .map((node) => this.describeManagerDelegationTarget(blueprint, node, readPrompt));
      return {
        nodeId: target.id,
        label: target.config.label,
        type: target.type,
        description: target.config.description,
        executionMode: resolveManagerSlotExecutionMode(target.config as ManagerSlotNodeConfig),
        children
      };
    }

    if (target.type === "manager") {
      const config = target.config as ManagerNodeConfig;
      return {
        nodeId: target.id,
        label: config.label,
        type: target.type,
        runtimeId: this.resolveManagerRuntimeId(target),
        openclawAgentId: config.openclawAgentId,
        agentName: config.agentName,
        description: config.description,
        ...readPrompt(config.instructions)
      };
    }

    return {
      nodeId: target.id,
      label: target.config.label,
      type: target.type,
      description: target.config.description
    };
  }

  private resolveAgentRuntimeRef(
    node: BlueprintNode & { type: "agent"; runtimeId: AgentRuntimeId; config: AgentNodeConfig },
    nodeRun: BlueprintNodeRun
  ): RuntimeObjectRef | undefined {
    const existing = nodeRun.runtimeRef;
    const source = existing?.source ?? resolveAgentRuntimeSource(node.runtimeId);
    const sourceId = existing?.sourceId ?? existing?.taskId ?? existing?.runId ?? nodeRun.id;
    const sessionKey = existing?.sessionKey ?? (source === "openclaw" ? buildAgentSessionKey(node.config.openclawAgentId ?? "main") : undefined);
    if (!sourceId || !sessionKey) return undefined;
    return {
      source,
      sourceId,
      sourceUpdatedAt: existing?.sourceUpdatedAt ?? nodeRun.startedAt ?? nodeRun.queuedAt,
      taskId: existing?.taskId ?? sourceId,
      runId: existing?.runId ?? sourceId,
      sessionKey,
      usageRef: existing?.usageRef
    };
  }

  private readManagerSlotContext(value: unknown): ManagerSlotContext | undefined {
    if (!isRecord(value) || !isRecord(value.manager)) return undefined;
    return {
      manager: {
        nodeId: readString(value.manager.nodeId) ?? "",
        nodeLabel: readString(value.manager.nodeLabel) ?? "",
        instructions: readString(value.manager.instructions),
        roundNumber: readInteger(value.manager.roundNumber) ?? 1,
        slot: readInteger(value.manager.slot) ?? 1,
        handoff: readInteger(value.manager.handoff) ?? 1,
        maxHandoffs: readInteger(value.manager.maxHandoffs) ?? 1
      },
      upstream: Array.isArray(value.upstream) ? value.upstream as UpstreamOutput : [],
      ...(isRecord(value.managerDecision) ? { managerDecision: value.managerDecision as unknown as ManagerDecision } : {}),
      previousResults: Array.isArray(value.previousResults)
        ? value.previousResults as ManagerSlotContext["previousResults"]
        : []
    };
  }

  private readUpstreamInput(value: unknown): UpstreamOutput {
    if (!isRecord(value) || !Array.isArray(value.upstream)) return [];
    return value.upstream as UpstreamOutput;
  }

  private buildManagerRoundMetadata(node: BlueprintNode, roundNumber: number): {
    nodeId: string;
    nodeLabel: string;
    instructions?: string;
    roundNumber: number;
  } {
    const config = node.config as ManagerNodeConfig;
    return {
      nodeId: node.id,
      nodeLabel: node.config.label,
      instructions: config.instructions,
      roundNumber
    };
  }

  private async resolveManagerRoundNumber(runId: string, nodeRun: BlueprintNodeRun): Promise<number> {
    const explicit =
      readManagerRoundNumberFromManagerContext(nodeRun.input) ??
      readManagerRoundNumberFromDecisionOutput(nodeRun.output);
    if (explicit !== undefined) return explicit;
    if (nodeRun.iterationRoundId) {
      const round = (await this.store.listIterationRounds({ runId }))
        .find((candidate) => candidate.id === nodeRun.iterationRoundId);
      if (round) return round.roundNumber;
    }
    return 1;
  }

  private findFirstNodeRunAfter(
    nodeRuns: BlueprintNodeRun[],
    nodeId: string,
    requiredAfterIndex: number
  ): { nodeRun: BlueprintNodeRun; index: number } | undefined {
    for (let index = requiredAfterIndex + 1; index < nodeRuns.length; index += 1) {
      const nodeRun = nodeRuns[index]!;
      if (this.isPreflightNodeRun(nodeRun)) continue;
      if (nodeRun.nodeId === nodeId) return { nodeRun, index };
    }
    return undefined;
  }

  private nodeRunToAgentTaskResult(nodeRun: BlueprintNodeRun): AgentTaskResult {
    const runtimeRef = nodeRun.runtimeRef;
    const sourceId = runtimeRef?.sourceId ?? nodeRun.id;
    const status: AgentTaskResult["status"] = nodeRun.status === "succeeded"
      ? "succeeded"
      : nodeRun.status === "cancelled"
        ? "cancelled"
        : "failed";
    return {
      taskId: runtimeRef?.taskId ?? sourceId,
      runId: runtimeRef?.runId ?? sourceId,
      sessionKey: runtimeRef?.sessionKey ?? "",
      source: runtimeRef?.source ?? "openclaw",
      status,
      output: nodeRun.output === undefined ? undefined : stringifyManagerSlotOutput(nodeRun.output),
      error: nodeRun.error,
      usage: nodeRun.usage,
      updatedAt: nodeRun.endedAt ?? nodeRun.startedAt ?? nodeRun.queuedAt
    };
  }

  private findReadyNodes(blueprint: BlueprintDefinition, nodeRuns: BlueprintNodeRun[]): BlueprintNode[] {
    return blueprint.nodes.filter((node) => {
      if (!this.isRunnableNode(node)) return false;
      if (!this.isGlobalSchedulingNode(blueprint, node)) return false;
      if (this.hasCurrentNodeRun(blueprint, node, nodeRuns)) return false;

      const incoming = this.getSchedulingIncomingEdges(blueprint, node);
      if (incoming.length === 0) return true;

      const requiredAfterIndex = this.getRequiredAfterIndex(blueprint, node, nodeRuns);
      return incoming.every((edge) => this.resolveIncomingEdgeState(blueprint, edge, nodeRuns, requiredAfterIndex) === "satisfied");
    });
  }

  private findSkippableNodes(blueprint: BlueprintDefinition, nodeRuns: BlueprintNodeRun[]): BlueprintNode[] {
    return blueprint.nodes.filter((node) => {
      if (!this.isGlobalSchedulingNode(blueprint, node)) return false;
      if (this.hasCurrentNodeRun(blueprint, node, nodeRuns)) return false;

      const incoming = this.getSchedulingIncomingEdges(blueprint, node);
      if (node.disabled) {
        if (incoming.length === 0) return true;
        const requiredAfterIndex = this.getRequiredAfterIndex(blueprint, node, nodeRuns);
        return incoming.every((edge) => this.resolveIncomingEdgeState(blueprint, edge, nodeRuns, requiredAfterIndex) !== "pending");
      }
      if (incoming.length === 0) return false;

      const requiredAfterIndex = this.getRequiredAfterIndex(blueprint, node, nodeRuns);
      const edgeStates = incoming.map((edge) => this.resolveIncomingEdgeState(blueprint, edge, nodeRuns, requiredAfterIndex));
      return edgeStates.every((state) => state !== "pending") && edgeStates.some((state) => state === "blocked");
    });
  }

  private async executeNode(blueprint: BlueprintDefinition, run: BlueprintRun, node: BlueprintNode): Promise<void> {
    const input = await this.collectStandardNodeInput(blueprint, run.id, node);
    const nodeRun = await this.createRunningNodeRun(blueprint, run, node, input);
    if (this.cancelledRunIds.has(run.id)) {
      await this.cancelNodeRun(nodeRun, "Run stopped by user.");
      return;
    }

    try {
      if (isAgentBlueprintNode(node)) {
        await this.executeAgentNodeWithInput(blueprint, run, node, nodeRun, input);
      } else if (node.type === "manager") {
        await this.executeManagerNode(blueprint, run, node, nodeRun, input.upstream);
      } else if (node.type === "manager_slot") {
        await this.failNode(nodeRun, "Manager slot nodes can only run when called by their manager.");
      } else if (node.type === "loop") {
        await this.executeLoopNode(blueprint, run, node, nodeRun, input.upstream);
      } else if (node.type === "condition") {
        await this.completeNode(nodeRun, { result: this.evaluateCondition(blueprint, node.config as ConditionNodeConfig) });
      } else if (node.type === "summary") {
        await this.executeSummaryNodeWithUpstream(run, node, nodeRun, input.upstream);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown node failure";
      await this.failNode(nodeRun, message);
    }
  }

  private async createRunningNodeRun(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode,
    input?: unknown
  ): Promise<BlueprintNodeRun> {
    const now = new Date().toISOString();
    const iterationRoundId = await this.currentExecutingRoundId(run.id);
    const nodeRun: BlueprintNodeRun = {
      id: `node-run-${nanoid(10)}`,
      blueprintRunId: run.id,
      blueprintId: blueprint.id,
      nodeId: node.id,
      nodeLabel: node.config.label,
      nodeType: node.type,
      ...(iterationRoundId ? { iterationRoundId } : {}),
      status: "queued",
      queuedAt: now,
      ...(input === undefined ? {} : { input })
    };
    await this.store.createQueuedNodeRun(nodeRun);
    await this.event(run.id, "node.run.queued", `${node.config.label} queued.`, nodeRun.id);
    const claim = await this.store.claimNodeRun({
      nodeRunId: nodeRun.id,
      owner: this.workerId,
      leaseMs: this.nodeRunLeaseMs
    });
    if (!claim.claimed || !claim.nodeRun || claim.workerEpoch === undefined) {
      throw new Error(`Node run ${nodeRun.id} could not be claimed by ${this.workerId}.`);
    }
    this.nodeRunClaims.set(nodeRun.id, { owner: this.workerId, workerEpoch: claim.workerEpoch });
    await this.store.startNodeRun({
      nodeRunId: nodeRun.id,
      owner: this.workerId,
      workerEpoch: claim.workerEpoch,
      startedAt: now,
      input
    });
    await this.event(run.id, "node.run.started", `${node.config.label} started.`, nodeRun.id);
    return { ...claim.nodeRun, input, startedAt: claim.nodeRun.startedAt ?? now };
  }

  private async executeAgentNode(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode & { type: "agent"; runtimeId: AgentRuntimeId; config: AgentNodeConfig },
    nodeRun: BlueprintNodeRun
  ): Promise<void> {
    await this.executeAgentNodeWithInput(blueprint, run, node, nodeRun, {
      upstream: await this.collectUpstreamOutputs(blueprint, run.id, node)
    });
  }

  private async executeAgentNodeWithInput(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode & { type: "agent"; runtimeId: AgentRuntimeId; config: AgentNodeConfig },
    nodeRun: BlueprintNodeRun,
    input: unknown
  ): Promise<AgentTaskResult> {
    const config = node.config as AgentNodeConfig;
    const runtimeId = node.runtimeId ?? "openclaw";
    const inputWithWorkspace = await this.withAgentWorkspaceInput(blueprint, node, input);
    const crossRoundInput = await this.withNodeCrossRoundContext({
      run,
      node,
      nodeRun,
      input: inputWithWorkspace,
      prompt: this.resolveAgentPrompt(config, { requiresHandoff: this.hasDownstreamConsumers(blueprint, node) })
    });
    let nodeRunWithInput = await this.recordNodeInput(nodeRun, crossRoundInput.input);
    const { result, runtimeRef } = await this.runAgentTask({
      blueprintRunId: run.id,
      nodeRunId: nodeRun.id,
      source: resolveAgentRuntimeSource(runtimeId),
      agentId: runtimeId === "openclaw" ? config.openclawAgentId ?? "main" : undefined,
      profileId: runtimeId === "hermes" ? config.profileId : undefined,
      agentName: config.agentName,
      prompt: crossRoundInput.prompt,
      modelId: config.modelId,
      permissionProfile: config.permissionProfile,
      runtimeAccessPolicy: config.runtimeAccessPolicy,
      workingDirectory: config.workingDirectory,
      timeoutMs: config.timeoutMs,
      outputSchema: buildAgentOutputEnvelopeSchema(config.outputSchema),
      input: crossRoundInput.input,
      skillIds: config.skillIds,
      tools: config.tools
    }, async (startedRef) => {
      nodeRunWithInput = await this.recordNodeRuntimeRef(nodeRunWithInput, startedRef);
    });
    return this.applyAgentTaskResult(blueprint, run, node, nodeRunWithInput, result, runtimeRef);
  }

  private async withAgentWorkspaceInput(
    blueprint: BlueprintDefinition,
    node: BlueprintNode & { type: "agent" },
    input: unknown
  ): Promise<unknown> {
    const agentWorkspace = this.agentWorkspaceForNode(blueprint, node);
    await Promise.all([
      mkdir(agentWorkspace.path, { recursive: true }),
      mkdir(agentWorkspace.artifactsPath, { recursive: true }),
      mkdir(agentWorkspace.tmpPath, { recursive: true })
    ]);
    return isRecord(input)
      ? { ...input, agentWorkspace }
      : { value: input, agentWorkspace };
  }

  private agentWorkspaceForNode(blueprint: BlueprintDefinition, node: BlueprintNode & { type: "agent" }): AgentWorkspaceRef {
    return agentWorkspaceRefForNode(this.store.getBlueprintWorkspacePath(blueprint.id), node);
  }

  private async withNodeCrossRoundContext(input: {
    run: BlueprintRun;
    node: BlueprintNode;
    nodeRun: BlueprintNodeRun;
    input: unknown;
    prompt: string;
  }): Promise<{ input: unknown; prompt: string }> {
    const mode = resolveCrossRoundContextMode(input.node.config);
    if (mode === "off") return { input: input.input, prompt: input.prompt };

    const nodeCrossRoundContext = await this.managerContextService.buildNodeCrossRoundContext({
      mode,
      run: input.run,
      node: input.node,
      currentNodeRun: input.nodeRun,
      upstream: this.readUpstreamInput(input.input)
    });
    if (!nodeCrossRoundContext) return { input: input.input, prompt: input.prompt };

    return {
      input: {
        ...(isRecord(input.input) ? input.input : { value: input.input }),
        nodeCrossRoundContext
      },
      prompt: [
        this.managerContextService.formatNodeCrossRoundContextPrompt(nodeCrossRoundContext),
        "",
        input.prompt
      ].join("\n")
    };
  }

  private async applyAgentTaskResult(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode & { type: "agent"; runtimeId: AgentRuntimeId; config: AgentNodeConfig },
    nodeRun: BlueprintNodeRun,
    result: AgentTaskResult,
    runtimeRef: RuntimeObjectRef
  ): Promise<AgentTaskResult> {
    if (result.status !== "succeeded") {
      await this.failNode({ ...nodeRun, runtimeRef, usage: result.usage }, result.error ?? `Agent run ${result.status}.`);
      return result;
    }
    if (!hasVisibleAgentOutput(result.output)) {
      const error = this.missingAgentOutputError(runtimeRef);
      await this.failNode({ ...nodeRun, runtimeRef, usage: result.usage }, error);
      return { ...result, status: "failed", error, output: undefined };
    }

    const config = node.config as AgentNodeConfig;
    if (config.approval?.enabled) {
      await this.waitForAgentApproval({ ...nodeRun, runtimeRef, usage: result.usage }, result.output);
      return result;
    }

    if ((node.runtimeId ?? "openclaw") === "openclaw" && config.send?.enabled) {
      await this.executeAgentConfiguredSend(run, nodeRun, blueprint.name, config.send, result.output);
    }

    await this.completeNode(
      { ...nodeRun, runtimeRef, usage: result.usage },
      result.output,
      runtimeRef
    );
    return result;
  }

  private async executeManagerNode(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode,
    nodeRun: BlueprintNodeRun,
    upstream?: UpstreamOutput
  ): Promise<AgentTaskResult> {
    const config = node.config as ManagerNodeConfig;
    const portCount = normalizeInteger(config.portCount, 1, 8, 3);
    const maxHandoffs = normalizeInteger(config.maxHandoffs, 1, 50, 12);
    const managerUpstream = upstream ?? await this.collectUpstreamOutputs(blueprint, run.id, node);
    const dispatchRunContext = await this.buildDispatchRunContext(run, node);
    let managerRoundNumber = await this.resolveManagerRoundNumber(run.id, nodeRun);
    const nodeRunWithInput = await this.recordNodeInput(nodeRun, {
      manager: this.buildManagerRoundMetadata(node, managerRoundNumber),
      upstream: managerUpstream,
      ...(dispatchRunContext ? { runContext: dispatchRunContext } : {})
    });
    const isAgentDriven = this.isAgentDrivenManager(node);
    const firstWorkSlot = this.firstManagerWorkSlot(node);
    const trace: ManagerTraceItem[] = [];
    let slot = this.firstConnectedManagerSlot(blueprint, node, portCount, firstWorkSlot);

    if (!slot) {
      const output = {
        status: "completed",
        roundNumber: managerRoundNumber,
        reason: firstWorkSlot > 1 ? "manager_has_no_connected_work_slots" : "manager_has_no_connected_slots",
        trace
      };
      await this.completeNode(nodeRunWithInput, output);
      return this.syntheticAgentResult(nodeRun.id, "succeeded", stringifyManagerSlotOutput(output));
    }

    for (let handoff = 1; handoff <= maxHandoffs; handoff += 1) {
      const managerContext: ManagerSlotContext = {
        manager: {
          nodeId: node.id,
          nodeLabel: node.config.label,
          instructions: config.instructions,
          roundNumber: managerRoundNumber,
          slot,
          handoff,
          maxHandoffs
        },
        upstream: managerUpstream,
        previousResults: this.managerPreviousResultsFromTrace(trace)
      };
      let managerDecision: ManagerDecision | undefined;
      if (isAgentDriven) {
        const managerDecisionResult = await this.runManagerDecisionTask(blueprint, run, node, nodeRunWithInput, managerContext, dispatchRunContext, slot, portCount, firstWorkSlot);
        if (managerDecisionResult.result.status !== "succeeded") {
          const error = managerDecisionResult.result.error ?? "Manager decision agent failed.";
          await this.failNode(nodeRunWithInput, error);
          return this.syntheticAgentResult(nodeRun.id, "failed", undefined, error);
        }

        managerDecision = managerDecisionResult.decision;
        managerRoundNumber = managerDecision.roundNumber ?? managerRoundNumber;
        managerContext.manager.roundNumber = managerRoundNumber;
        managerContext.managerDecision = managerDecision;
        if (managerDecision.status === "complete" || managerDecision.nextSlot === undefined) {
          const output = {
            status: "completed",
            roundNumber: managerRoundNumber,
            reason: managerDecision.reason ?? "manager_completed",
            trace
          };
          await this.completeNode(nodeRunWithInput, output);
          return this.syntheticAgentResult(nodeRun.id, "succeeded", stringifyManagerSlotOutput(output));
        }
        slot = managerDecision.nextSlot;
      }

      const assignment = this.findManagerSlotAssignment(blueprint, node, slot);
      if (!assignment) {
        const output = {
          status: "completed",
          roundNumber: managerRoundNumber,
          reason: `manager_slot_${slot}_is_not_connected`,
          trace
        };
        await this.completeNode(nodeRunWithInput, output);
        return this.syntheticAgentResult(nodeRun.id, "succeeded", stringifyManagerSlotOutput(output));
      }

      if (assignment.target.disabled) {
        trace.push({
          handoff,
          slot,
          nodeId: assignment.target.id,
          nodeLabel: assignment.target.config.label,
          status: "cancelled",
          error: "disabled",
          returnEdgePresent: assignment.returnEdgePresent,
          managerDecision,
          decision: this.resolveManagerDecision({ status: "skipped" }, slot, portCount, { minSlot: firstWorkSlot })
        });
        slot += 1;
        if (slot > portCount) {
          const output = {
            status: "completed",
            roundNumber: managerRoundNumber,
            reason: "manager_reached_final_slot",
            trace
          };
          await this.completeNode(nodeRunWithInput, output);
          return this.syntheticAgentResult(nodeRun.id, "succeeded", stringifyManagerSlotOutput(output));
        }
        continue;
      }

      let result: AgentTaskResult;
      let participantNodeRun: BlueprintNodeRun | undefined;

      if (isAgentBlueprintNode(assignment.target)) {
        const participantRun = await this.createRunningNodeRun(blueprint, run, assignment.target, managerContext);
        participantNodeRun = participantRun;
        result = await this.executeAgentNodeWithInput(blueprint, run, assignment.target, participantRun, managerContext);
      } else if (assignment.target.type === "manager_slot") {
        const slotRun = await this.createRunningNodeRun(blueprint, run, assignment.target, managerContext);
        participantNodeRun = slotRun;
        result = await this.executeManagerSlotNode(blueprint, run, assignment.target, slotRun, managerContext);
      } else if (assignment.target.type === "manager") {
        const managerUpstreamInput: UpstreamOutput = [
          {
            nodeId: node.id,
            nodeLabel: node.config.label,
            nodeRunId: nodeRun.id,
            status: nodeRun.status,
            context: managerContext
          }
        ];
        const managerRun = await this.createRunningNodeRun(blueprint, run, assignment.target, { upstream: managerUpstreamInput });
        participantNodeRun = managerRun;
        result = await this.executeManagerNode(blueprint, run, assignment.target, managerRun, managerUpstreamInput);
      } else {
        const error = `Manager slot ${slot} targets unsupported node type ${assignment.target.type}.`;
        await this.failNode(nodeRunWithInput, error);
        return this.syntheticAgentResult(nodeRun.id, "failed", undefined, error);
      }

      const latestParticipantRun = participantNodeRun
        ? await this.findNodeRunById(run.id, participantNodeRun.id)
        : undefined;
      const receipt = latestParticipantRun
        ? await this.buildManagerResultReceipt(blueprint, run.id, latestParticipantRun, result.output)
        : undefined;
      const traceItem: ManagerTraceItem = {
        handoff,
        slot,
        nodeId: assignment.target.id,
        nodeLabel: assignment.target.config.label,
        status: result.status,
        output: result.output,
        error: result.error,
        returnEdgePresent: assignment.returnEdgePresent,
        managerDecision,
        receipt
      };
      trace.push(traceItem);

      if (result.status !== "succeeded") {
        const error = result.error ?? `Manager participant ${assignment.target.config.label} returned ${result.status}.`;
        await this.failNode(nodeRunWithInput, error);
        return this.syntheticAgentResult(nodeRun.id, "failed", undefined, error);
      }

      if (isAgentDriven) {
        traceItem.decision = {
          status: "continue",
          nextSlot: slot,
          reason: "manager_will_decide_after_result"
        };
        continue;
      }

      const decision = this.resolveSequentialManagerDecision(blueprint, node, slot, portCount, firstWorkSlot);
      traceItem.decision = decision;
      if (decision.status === "complete" || !decision.nextSlot) {
        const output = {
          status: "completed",
          roundNumber: managerRoundNumber,
          reason: decision.reason ?? "manager_reached_final_connected_slot",
          trace
        };
        await this.completeNode(nodeRunWithInput, output);
        return this.syntheticAgentResult(nodeRun.id, "succeeded", stringifyManagerSlotOutput(output));
      }

      slot = decision.nextSlot;
    }

    const error = `Manager exceeded max handoffs (${maxHandoffs}).`;
    await this.failNode(nodeRunWithInput, error);
    return this.syntheticAgentResult(nodeRun.id, "failed", undefined, error);
  }

  private async executeManagerSlotNode(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    slotNode: BlueprintNode,
    slotRun: BlueprintNodeRun,
    context: ManagerSlotContext,
    existingScopeStartIndex?: number
  ): Promise<AgentTaskResult> {
    const childNodes = blueprint.nodes.filter((node) => node.parentId === slotNode.id && this.isRunnableNode(node));
    const scopeStartIndex = existingScopeStartIndex ?? Math.max(0, (await this.store.listNodeRuns(run.id)).length - 1);
    const slotInput = {
      manager: context.manager,
      upstream: context.upstream,
      previousResults: context.previousResults
    };
    const slotRunWithInput = await this.recordNodeInput(slotRun, slotInput);
    const boundaryOutput = {
      status: "manager_slot_input",
      ...slotInput
    };

    if (childNodes.length === 0) {
      const output = JSON.stringify({
        status: "complete",
        reason: "manager_slot_empty",
        input: boundaryOutput
      });
      await this.completeNode(slotRunWithInput, output);
      return this.syntheticAgentResult(slotRun.id, "succeeded", output);
    }

    const childIds = new Set(childNodes.map((node) => node.id));
    while (true) {
      const nodeRuns = await this.store.listNodeRuns(run.id);
      const failed = nodeRuns.find(
        (nodeRun, index) =>
          !this.isPreflightNodeRun(nodeRun) &&
          index > scopeStartIndex &&
          childIds.has(nodeRun.nodeId) &&
          (nodeRun.status === "failed" || nodeRun.status === "cancelled")
      );
      if (failed) {
        const error = failed.error ?? `${failed.nodeLabel} returned ${failed.status}.`;
        await this.failNode(slotRunWithInput, error);
        return this.syntheticAgentResult(slotRun.id, "failed", undefined, error);
      }

      const skippable = childNodes.filter((node) => this.isScopedSkippableNode(blueprint, slotNode, node, nodeRuns, scopeStartIndex));
      if (skippable.length > 0) {
        await Promise.all(skippable.map((node) => this.skipNode(blueprint, run, node)));
        continue;
      }

      const ready = childNodes.filter((node) => this.isScopedReadyNode(blueprint, slotNode, node, nodeRuns, scopeStartIndex));
      if (ready.length > 0) {
        await Promise.all(
          ready.map(async (node) =>
            this.executeScopedNode(
              blueprint,
              run,
              node,
              await this.collectScopedUpstreamOutputs(blueprint, slotNode, slotRunWithInput, node, nodeRuns, scopeStartIndex, boundaryOutput),
              context
            )
          )
        );
        continue;
      }

      const output = this.resolveManagerSlotOutput(blueprint, slotNode, childNodes, nodeRuns, scopeStartIndex);
      if (output !== undefined) {
        const serialized = stringifyManagerSlotOutput(output);
        await this.completeNode(slotRunWithInput, serialized);
        return this.syntheticAgentResult(slotRun.id, "succeeded", serialized);
      }

      const pending = childNodes
        .filter((node) => !this.findLatestNodeRun(nodeRuns, node.id, undefined, scopeStartIndex))
        .map((node) => node.id);
      const error = `Manager slot ${slotNode.config.label} could not continue. Pending nodes: ${pending.join(", ") || "unknown"}.`;
      await this.failNode(slotRunWithInput, error);
      return this.syntheticAgentResult(slotRun.id, "failed", undefined, error);
    }
  }

  private async executeScopedNode(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode,
    upstream: UpstreamOutput,
    managerContext?: ManagerSlotContext
  ): Promise<void> {
    const input = managerContext
      ? {
          manager: managerContext.manager,
          upstream,
          previousResults: managerContext.previousResults,
          ...(managerContext.managerDecision ? { managerDecision: managerContext.managerDecision } : {})
        }
      : { upstream };
    const nodeRun = await this.createRunningNodeRun(blueprint, run, node, input);
    if (isAgentBlueprintNode(node)) {
      await this.executeAgentNodeWithInput(blueprint, run, node, nodeRun, input);
    } else if (node.type === "condition") {
      await this.completeNode(nodeRun, { result: this.evaluateCondition(blueprint, node.config as ConditionNodeConfig) });
    } else if (node.type === "summary") {
      await this.executeSummaryNodeWithUpstream(run, node, nodeRun, upstream);
    } else {
      await this.failNode(nodeRun, `Node type ${node.type} is not supported inside a manager slot yet.`);
    }
  }

  private isScopedReadyNode(
    blueprint: BlueprintDefinition,
    slotNode: BlueprintNode,
    node: BlueprintNode,
    nodeRuns: BlueprintNodeRun[],
    scopeStartIndex: number
  ): boolean {
    if (this.findLatestNodeRun(nodeRuns, node.id, undefined, scopeStartIndex)) return false;
    const incoming = this.getScopedIncomingEdges(blueprint, slotNode, node);
    if (incoming.length === 0) return true;
    return incoming.every((edge) => this.resolveScopedEdgeState(blueprint, slotNode, edge, nodeRuns, scopeStartIndex) === "satisfied");
  }

  private isScopedSkippableNode(
    blueprint: BlueprintDefinition,
    slotNode: BlueprintNode,
    node: BlueprintNode,
    nodeRuns: BlueprintNodeRun[],
    scopeStartIndex: number
  ): boolean {
    if (this.findLatestNodeRun(nodeRuns, node.id, undefined, scopeStartIndex)) return false;
    const incoming = this.getScopedIncomingEdges(blueprint, slotNode, node);
    if (incoming.length === 0) return false;
    const states = incoming.map((edge) => this.resolveScopedEdgeState(blueprint, slotNode, edge, nodeRuns, scopeStartIndex));
    return states.every((state) => state !== "pending") && states.some((state) => state === "blocked");
  }

  private getScopedIncomingEdges(blueprint: BlueprintDefinition, slotNode: BlueprintNode, node: BlueprintNode): BlueprintEdge[] {
    const isParallelSlot = this.isParallelManagerSlot(slotNode);
    return blueprint.edges.filter((edge) => {
      if (edge.target !== node.id) return false;
      if (edge.source === slotNode.id) return isManagerSlotInnerOutHandle(edge.sourceHandle);
      if (isParallelSlot) return false;
      const source = blueprint.nodes.find((candidate) => candidate.id === edge.source);
      return source?.parentId === slotNode.id;
    });
  }

  private resolveScopedEdgeState(
    blueprint: BlueprintDefinition,
    slotNode: BlueprintNode,
    edge: BlueprintEdge,
    nodeRuns: BlueprintNodeRun[],
    scopeStartIndex: number
  ): IncomingEdgeState {
    if (edge.source === slotNode.id && isManagerSlotInnerOutHandle(edge.sourceHandle)) return "satisfied";
    const source = blueprint.nodes.find((candidate) => candidate.id === edge.source);
    if (!source || source.parentId !== slotNode.id) return "blocked";
    const sourceRun = this.findLatestNodeRun(nodeRuns, source.id, undefined, scopeStartIndex);
    if (!sourceRun) return "pending";
    if (!this.isTerminalStatus(sourceRun.status)) return "pending";

    const condition = edge.condition ?? "success";
    if (condition === "success") return sourceRun.status === "succeeded" ? "satisfied" : "blocked";
    if (condition === "failure") return sourceRun.status === "failed" || sourceRun.status === "cancelled" ? "satisfied" : "blocked";
    if (sourceRun.status !== "succeeded") return "blocked";

    const expected = condition === "true";
    return this.readConditionResult(sourceRun.output) === expected ? "satisfied" : "blocked";
  }

  private async collectScopedUpstreamOutputs(
    blueprint: BlueprintDefinition,
    slotNode: BlueprintNode,
    slotRun: BlueprintNodeRun,
    node: BlueprintNode,
    nodeRuns: BlueprintNodeRun[],
    scopeStartIndex: number,
    boundaryOutput: unknown
  ): Promise<UpstreamOutput> {
    const incoming = this.getScopedIncomingEdges(blueprint, slotNode, node);
    const [humanReports, handoffs, artifacts] = await Promise.all([
      this.store.listAgentHumanReports(slotRun.blueprintRunId),
      this.store.listAgentHandoffs(slotRun.blueprintRunId),
      this.store.listArtifacts(slotRun.blueprintRunId)
    ]);
    const reportContext = (nodeRun: BlueprintNodeRun) =>
      this.buildUpstreamReportContext(blueprint, nodeRun, nodeRuns, humanReports, handoffs, artifacts);
    if (incoming.length === 0) {
      return [this.toUpstreamOutputItem(slotRun, boundaryOutput, { ...reportContext(slotRun), context: boundaryOutput })];
    }

    const outputs: UpstreamOutput = [];
    for (const edge of incoming) {
      if (this.resolveScopedEdgeState(blueprint, slotNode, edge, nodeRuns, scopeStartIndex) !== "satisfied") continue;
      if (edge.source === slotNode.id && isManagerSlotInnerOutHandle(edge.sourceHandle)) {
        outputs.push(this.toUpstreamOutputItem(slotRun, boundaryOutput, { ...reportContext(slotRun), context: boundaryOutput }));
        continue;
      }

      const sourceRun = this.findLatestNodeRun(nodeRuns, edge.source, "succeeded", scopeStartIndex);
      if (!sourceRun) continue;
      outputs.push(this.toUpstreamOutputItem(sourceRun, sourceRun.output, reportContext(sourceRun)));
    }
    return outputs;
  }

  private resolveManagerSlotOutput(
    blueprint: BlueprintDefinition,
    slotNode: BlueprintNode,
    childNodes: BlueprintNode[],
    nodeRuns: BlueprintNodeRun[],
    scopeStartIndex: number
  ): unknown {
    if (this.isParallelManagerSlot(slotNode)) {
      const childRuns = childNodes.flatMap((node) => {
        const nodeRun = this.findLatestNodeRun(nodeRuns, node.id, "succeeded", scopeStartIndex);
        return nodeRun ? [nodeRun] : [];
      });
      if (childRuns.length === 0 || childRuns.length < childNodes.length) return undefined;
      if (childRuns.length === 1) return childRuns[0]!.output;
      return {
        outputs: childRuns.map((nodeRun) => ({
          nodeId: nodeRun.nodeId,
          nodeLabel: nodeRun.nodeLabel,
          output: nodeRun.output
        }))
      };
    }

    const explicitOutputs = blueprint.edges
      .filter((edge) => edge.target === slotNode.id && isManagerSlotInnerInHandle(edge.targetHandle))
      .flatMap((edge) => {
        const source = childNodes.find((node) => node.id === edge.source);
        if (!source) return [];
        if (this.resolveScopedEdgeState(blueprint, slotNode, edge, nodeRuns, scopeStartIndex) !== "satisfied") return [];
        const sourceRun = this.findLatestNodeRun(nodeRuns, source.id, "succeeded", scopeStartIndex);
        return sourceRun
          ? [
              {
                nodeId: sourceRun.nodeId,
                nodeLabel: sourceRun.nodeLabel,
                output: sourceRun.output
              }
            ]
          : [];
      });
    if (explicitOutputs.length === 1) return explicitOutputs[0]!.output;
    if (explicitOutputs.length > 1) return { outputs: explicitOutputs };

    const leafNodes = childNodes.filter((node) => {
      return !blueprint.edges.some((edge) => edge.source === node.id && childNodes.some((candidate) => candidate.id === edge.target));
    });
    const leafRuns = leafNodes.flatMap((node) => {
      const nodeRun = this.findLatestNodeRun(nodeRuns, node.id, "succeeded", scopeStartIndex);
      return nodeRun ? [nodeRun] : [];
    });
    if (leafRuns.length === 1) return leafRuns[0]!.output;
    if (leafRuns.length > 1) {
      return {
        outputs: leafRuns.map((nodeRun) => ({
          nodeId: nodeRun.nodeId,
          nodeLabel: nodeRun.nodeLabel,
          output: nodeRun.output
        }))
      };
    }
    return undefined;
  }

  private isParallelManagerSlot(slotNode: BlueprintNode): boolean {
    return (
      slotNode.type === "manager_slot" &&
      resolveManagerSlotExecutionMode(slotNode.config as ManagerSlotNodeConfig) === "parallel"
    );
  }

  private syntheticAgentResult(
    nodeRunId: string,
    status: AgentTaskResult["status"],
    output?: unknown,
    error?: string
  ): AgentTaskResult {
    return {
      taskId: nodeRunId,
      runId: nodeRunId,
      sessionKey: `manager-slot:${nodeRunId}`,
      source: "openclaw",
      status,
      output,
      error,
      updatedAt: new Date().toISOString()
    };
  }

  private async executeLoopNode(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode,
    nodeRun: BlueprintNodeRun,
    upstream: UpstreamOutput
  ): Promise<void> {
    const config = node.config as LoopNodeConfig;
    const nodeRunWithInput = await this.recordNodeInput(nodeRun, { upstream });
    const maxIterations = normalizeInteger(config.maxIterations, 1, 25, 3);
    const previousLoopRuns = await this.store.listNodeRuns(run.id);
    const previousIteration = previousLoopRuns
      .filter((candidate) => candidate.nodeId === node.id && candidate.status === "succeeded")
      .reduce((max, candidate) => Math.max(max, readInteger(readOutputRecord(candidate.output)?.iteration) ?? 0), 0);
    const iteration = previousIteration + 1;
    const rerunTargets = this.getLoopRerunTargets(blueprint, node).map((target) => ({
      nodeId: target.id,
      nodeLabel: target.config.label
    }));
    const shouldRerun = iteration < maxIterations && rerunTargets.length > 0;

    await this.completeNode(nodeRunWithInput, {
      status: shouldRerun ? "rerun" : "completed",
      iteration,
      maxIterations,
      rerunTargets,
      upstream
    });
  }

  private async executeSummaryNode(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    node: BlueprintNode,
    nodeRun: BlueprintNodeRun
  ): Promise<void> {
    await this.executeSummaryNodeWithUpstream(
      run,
      node,
      nodeRun,
      await this.collectUpstreamOutputs(blueprint, run.id, node)
    );
  }

  private async executeSummaryNodeWithUpstream(
    run: BlueprintRun,
    node: BlueprintNode,
    nodeRun: BlueprintNodeRun,
    upstream: UpstreamOutput
  ): Promise<void> {
    const config = node.config as SummaryNodeConfig;
    const input = await this.withNodeCrossRoundContext({
      run,
      node,
      nodeRun,
      input: { upstream },
      prompt: config.prompt?.trim() || defaultSummaryHarnessPrompt
    });
    const summaryInput = input.input;
    let nodeRunWithInput = await this.recordNodeInput(nodeRun, summaryInput);
    if (isHarnessSummaryMode(config)) {
      const runtimeId = resolveSummaryRuntimeId(config);
      const { result, runtimeRef } = await this.runAgentTask({
        blueprintRunId: run.id,
        nodeRunId: nodeRun.id,
        source: resolveAgentRuntimeSource(runtimeId),
        agentId: runtimeId === "openclaw" ? "main" : undefined,
        profileId: runtimeId === "hermes" ? config.profileId : undefined,
        agentName: "summary-agent",
        prompt: [
          input.prompt,
          "",
          ...agentOutputContractLines
        ].join("\n"),
        modelId: config.modelId,
        runtimeAccessPolicy: config.runtimeAccessPolicy,
        outputSchema: humanReportEnvelopeSchemaBase,
        input: summaryInput,
        tools: []
      }, async (startedRef) => {
        nodeRunWithInput = await this.recordNodeRuntimeRef(nodeRunWithInput, startedRef);
      });
      if (result.status !== "succeeded") {
        await this.failNode({ ...nodeRunWithInput, runtimeRef, usage: result.usage }, result.error ?? `Agent run ${result.status}.`);
        return;
      }
      if (!hasVisibleAgentOutput(result.output)) {
        await this.failNode({ ...nodeRunWithInput, runtimeRef, usage: result.usage }, this.missingAgentOutputError(runtimeRef));
        return;
      }
      await this.completeNode({ ...nodeRunWithInput, runtimeRef, usage: result.usage }, result.output, runtimeRef);
      return;
    }

    await this.completeNode(
      nodeRunWithInput,
      {
        merged: upstream.map((candidate) => ({
          node: candidate.nodeLabel,
          ...(candidate.humanReportMd ? { humanReportMd: candidate.humanReportMd } : {}),
          ...(candidate.handoffJson !== undefined ? { handoffJson: candidate.handoffJson } : {}),
          ...(candidate.artifacts?.length ? { artifacts: candidate.artifacts } : {}),
          ...(candidate.outputSummary ? { outputSummary: candidate.outputSummary } : {}),
          ...(candidate.output !== undefined ? { output: candidate.output } : {})
        }))
      }
    );
  }

  private async waitForAgentApproval(
    nodeRun: BlueprintNodeRun,
    reviewOutput: unknown,
    replies: AgentApprovalReply[] = [],
    selectedReplyId?: string,
    selectedOutput?: unknown
  ): Promise<void> {
    const waiting: BlueprintNodeRun = {
      ...nodeRun,
      status: "waiting_approval",
      output: {
        approvalType: "agent",
        reviewOutput,
        replies: markSelectedApprovalReplies(replies, selectedReplyId),
        ...(selectedReplyId ? { selectedReplyId } : {}),
        ...(selectedOutput !== undefined ? { selectedOutput } : {})
      } satisfies AgentApprovalWaitingOutput
    };
    await this.store.upsertNodeRun(waiting);
    this.nodeRunClaims.delete(nodeRun.id);
    await this.event(nodeRun.blueprintRunId, "node.run.waiting_approval", `${nodeRun.nodeLabel} is waiting for approval.`, nodeRun.id);
    const revisionContext = readApprovalRevisionContext(nodeRun.input) ?? this.pendingApprovalRevisionContexts.get(nodeRun.id);
    const migratedRequest = await this.migrationService.migratePendingNodeApproval({
      runId: nodeRun.blueprintRunId,
      nodeRun: waiting,
      requestedByLabel: nodeRun.nodeLabel,
      threadId: revisionContext?.threadId,
      replacesRequestId: revisionContext?.replacesRequestId,
      revision: revisionContext?.revision
    });
    if (revisionContext?.replacesRequestId && migratedRequest?.id) {
      await this.supersedeOriginalApprovalIfPending(revisionContext.replacesRequestId, migratedRequest.id);
    }
    await this.managerMailProjector.refresh(nodeRun.blueprintRunId);
  }

  private async resolveApprovedOutput(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    nodeRun: BlueprintNodeRun,
    comment?: string,
    selectedReplyId?: string
  ): Promise<unknown> {
    if (!isAgentApprovalWaitingOutput(nodeRun.output)) {
      return { approved: true, comment: comment?.trim() || undefined };
    }

    const approvalOutput = applyAgentApprovalSelection(nodeRun.output, selectedReplyId);
    const approvedOutput = resolveAgentApprovalSelectedOutput(approvalOutput);
    const node = blueprint.nodes.find((candidate) => candidate.id === nodeRun.nodeId);
    if (node && isAgentBlueprintNode(node)) {
      const config = node.config as AgentNodeConfig;
      if ((node.runtimeId ?? "openclaw") === "openclaw" && config.send?.enabled) {
        await this.executeAgentConfiguredSend(run, nodeRun, blueprint.name, config.send, approvedOutput);
      }
    }
    return buildApprovedAgentOutput(approvedOutput, approvalOutput.replies, comment, approvalOutput.selectedReplyId);
  }

  private async executeAgentConfiguredSend(
    run: BlueprintRun,
    nodeRun: BlueprintNodeRun,
    blueprintName: string,
    config: NonNullable<AgentNodeConfig["send"]>,
    output: unknown
  ): Promise<void> {
    if (!config.enabled) return;
    const body = config.bodyTemplate
      .replaceAll("{{blueprint.name}}", blueprintName)
      .replaceAll("{{summary}}", JSON.stringify(output))
      .replaceAll("{{upstream}}", JSON.stringify([{ nodeId: nodeRun.nodeId, nodeLabel: nodeRun.nodeLabel, nodeRunId: nodeRun.id, output }]));
    await this.adapter.sendChannelMessage({
      channelId: config.channelId,
      target: config.target,
      body,
      blueprintRunId: run.id,
      nodeRunId: nodeRun.id
    });
  }

  private evaluateCondition(blueprint: BlueprintDefinition, config: ConditionNodeConfig): boolean {
    const expression = config.expression.trim();
    if (expression === "true") return true;
    if (expression === "false") return false;
    return blueprint.variables[expression] === "true";
  }

  private firstConnectedManagerSlot(
    blueprint: BlueprintDefinition,
    managerNode: BlueprintNode,
    portCount: number,
    minSlot = 1
  ): number | undefined {
    for (let slot = minSlot; slot <= portCount; slot += 1) {
      if (this.findManagerSlotAssignment(blueprint, managerNode, slot)) return slot;
    }
    return undefined;
  }

  private firstManagerWorkSlot(managerNode: BlueprintNode): number {
    const config = managerNode.config as ManagerNodeConfig;
    return config.lifecycleMode === "self_iteration" ? selfIterationPreparationSlotCount + 1 : 1;
  }

  private findManagerSlotAssignment(
    blueprint: BlueprintDefinition,
    managerNode: BlueprintNode,
    slot: number
  ): { target: BlueprintNode; returnEdgePresent: boolean } | undefined {
    const outHandle = `${managerOutHandlePrefix}${slot}`;
    const outEdge = blueprint.edges.find((edge) => edge.source === managerNode.id && edge.sourceHandle === outHandle);
    if (!outEdge) return undefined;

    const target = blueprint.nodes.find((candidate) => candidate.id === outEdge.target);
    if (!target) return undefined;

    const inHandle = `${managerInHandlePrefix}${slot}`;
    const returnEdgePresent = blueprint.edges.some(
      (edge) => edge.source === target.id && edge.target === managerNode.id && edge.targetHandle === inHandle
    );
    return { target, returnEdgePresent };
  }

  private resolveSequentialManagerDecision(
    blueprint: BlueprintDefinition,
    managerNode: BlueprintNode,
    currentSlot: number,
    portCount: number,
    minSlot = 1
  ): ManagerDecision {
    for (let nextSlot = Math.max(minSlot, currentSlot + 1); nextSlot <= portCount; nextSlot += 1) {
      if (this.findManagerSlotAssignment(blueprint, managerNode, nextSlot)) {
        return {
          status: "continue",
          nextSlot,
          reason: `manager_sequential_next_slot_${nextSlot}`
        };
      }
    }
    return {
      status: "complete",
      reason: "manager_reached_final_connected_slot"
    };
  }

  private managerPreviousResultsFromTrace(trace: ManagerTraceItem[]): ManagerSlotContext["previousResults"] {
    return trace.map((item) => ({
      handoff: item.handoff,
      slot: item.slot,
      nodeId: item.nodeId,
      nodeLabel: item.nodeLabel,
      status: item.status,
      error: item.error,
      decision: item.decision,
      receipt: item.receipt
    }));
  }

  private async findNodeRunById(runId: string, nodeRunId: string): Promise<BlueprintNodeRun | undefined> {
    return (await this.store.listNodeRuns(runId)).find((candidate) => candidate.id === nodeRunId);
  }

  private async buildManagerResultReceipt(
    blueprint: BlueprintDefinition,
    runId: string,
    nodeRun: BlueprintNodeRun,
    output: unknown
  ): Promise<ManagerResultReceipt> {
    const [nodeRuns, humanReports, handoffs, artifacts] = await Promise.all([
      this.store.listNodeRuns(runId),
      this.store.listAgentHumanReports(runId),
      this.store.listAgentHandoffs(runId),
      this.store.listArtifacts(runId)
    ]);
    const relatedNodeRunIds = this.relatedReceiptNodeRunIds(blueprint, nodeRun, nodeRuns);
    const relatedReports = humanReports.filter((report) => relatedNodeRunIds.has(report.nodeRunId));
    const relatedHandoffs = handoffs.filter((handoff) => relatedNodeRunIds.has(handoff.nodeRunId));
    const relatedArtifacts = artifacts.filter((artifact) =>
      artifact.nodeRunId !== undefined && relatedNodeRunIds.has(artifact.nodeRunId)
    );
    const roleContexts = this.relatedReceiptRoleContexts(blueprint, relatedNodeRunIds, nodeRuns);
    const humanReportMd = relatedReports.map((report) => report.bodyMd).filter(Boolean).join("\n\n") || undefined;
    const handoffJson = relatedHandoffs.length === 1
      ? relatedHandoffs[0]!.payload
      : relatedHandoffs.length > 1
        ? relatedHandoffs.map((handoff) => ({ nodeId: handoff.nodeId, payload: handoff.payload }))
        : undefined;
    const outputSummary = hasVisibleAgentOutput(output) ? formatNodeOutputSummary(output) : undefined;
    const valid = nodeRun.status === "succeeded" && Boolean(humanReportMd || handoffJson !== undefined || relatedArtifacts.length > 0 || outputSummary);
    return {
      nodeRunId: nodeRun.id,
      nodeId: nodeRun.nodeId,
      nodeLabel: nodeRun.nodeLabel,
      status: nodeRun.status,
      valid,
      ...(valid ? {} : { invalidReason: "manager_participant_returned_no_visible_receipt" }),
      ...(relatedReports[0] ? { humanReportId: relatedReports[0].id } : {}),
      ...(humanReportMd ? { humanReportMd } : {}),
      ...(handoffJson !== undefined ? { handoffJson } : {}),
      artifacts: relatedArtifacts.map((artifact) => this.toArtifactRef(artifact)),
      roleContexts,
      ...(outputSummary ? { outputSummary } : {})
    };
  }

  private relatedReceiptRoleContexts(
    blueprint: BlueprintDefinition,
    relatedNodeRunIds: Set<string>,
    nodeRuns: BlueprintNodeRun[]
  ): ManagerReceiptRoleContext[] {
    const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
    const seen = new Set<string>();
    const contexts: ManagerReceiptRoleContext[] = [];
    for (const nodeRun of nodeRuns) {
      if (!relatedNodeRunIds.has(nodeRun.id) || seen.has(nodeRun.nodeId)) continue;
      const node = nodesById.get(nodeRun.nodeId);
      if (!node) continue;
      seen.add(node.id);
      contexts.push(this.managerReceiptRoleContextForNode(blueprint, node));
    }
    return contexts;
  }

  private managerReceiptRoleContextForNode(
    blueprint: BlueprintDefinition,
    node: BlueprintNode
  ): ManagerReceiptRoleContext {
    const base = {
      nodeId: node.id,
      nodeLabel: node.config.label,
      type: node.type,
      ...(node.config.description ? { description: node.config.description } : {}),
      promptVisibility: "ai_only" as const
    };

    if (isAgentBlueprintNode(node)) {
      const config = node.config as AgentNodeConfig;
      const systemPrompt = readPromptForReceiptRoleContext(config.prompt);
      const userPrompt = readPromptForReceiptRoleContext(config.userPrompt);
      return {
        ...base,
        ...(node.runtimeId ? { runtimeId: node.runtimeId } : {}),
        ...(config.openclawAgentId ? { openclawAgentId: config.openclawAgentId } : {}),
        ...(config.agentName ? { agentName: config.agentName } : {}),
        ...(systemPrompt.value ? { systemPrompt: systemPrompt.value } : {}),
        ...(userPrompt.value ? { userPrompt: userPrompt.value } : {}),
        ...(systemPrompt.truncated || userPrompt.truncated ? { promptTruncated: true } : {}),
        agentWorkspace: this.agentWorkspaceForNode(blueprint, node)
      };
    }

    if (node.type === "manager") {
      const config = node.config as ManagerNodeConfig;
      const systemPrompt = readPromptForReceiptRoleContext(config.instructions);
      return {
        ...base,
        runtimeId: this.resolveManagerRuntimeId(node),
        ...(config.openclawAgentId ? { openclawAgentId: config.openclawAgentId } : {}),
        ...(config.agentName ? { agentName: config.agentName } : {}),
        ...(systemPrompt.value ? { systemPrompt: systemPrompt.value } : {}),
        ...(systemPrompt.truncated ? { promptTruncated: true } : {})
      };
    }

    return base;
  }

  private relatedReceiptNodeRunIds(
    blueprint: BlueprintDefinition,
    nodeRun: BlueprintNodeRun,
    nodeRuns: BlueprintNodeRun[]
  ): Set<string> {
    const related = new Set<string>([nodeRun.id]);
    if (nodeRun.nodeType !== "manager_slot") return related;

    const childNodeIds = new Set(
      blueprint.nodes
        .filter((node) => node.parentId === nodeRun.nodeId)
        .map((node) => node.id)
    );
    const slotStart = Date.parse(nodeRun.startedAt ?? nodeRun.queuedAt ?? "");
    const slotEnd = Date.parse(nodeRun.endedAt ?? "");
    for (const candidate of nodeRuns) {
      if (!childNodeIds.has(candidate.nodeId)) continue;
      const candidateStart = Date.parse(candidate.startedAt ?? candidate.queuedAt ?? "");
      const afterSlotStart = !Number.isFinite(slotStart) || !Number.isFinite(candidateStart) || candidateStart >= slotStart;
      const beforeSlotEnd = !Number.isFinite(slotEnd) || !Number.isFinite(candidateStart) || candidateStart <= slotEnd;
      if (afterSlotStart && beforeSlotEnd) related.add(candidate.id);
    }
    return related;
  }

  private buildUpstreamReportContext(
    blueprint: BlueprintDefinition,
    nodeRun: BlueprintNodeRun,
    nodeRuns: BlueprintNodeRun[],
    humanReports: Awaited<ReturnType<HivewardStore["listAgentHumanReports"]>>,
    handoffs: Awaited<ReturnType<HivewardStore["listAgentHandoffs"]>>,
    artifacts: Awaited<ReturnType<HivewardStore["listArtifacts"]>>
  ): {
    humanReports: Awaited<ReturnType<HivewardStore["listAgentHumanReports"]>>;
    handoffs: Awaited<ReturnType<HivewardStore["listAgentHandoffs"]>>;
    artifacts: Artifact[];
  } {
    const relatedNodeRunIds = this.relatedReceiptNodeRunIds(blueprint, nodeRun, nodeRuns);
    return {
      humanReports: humanReports.filter((report) => relatedNodeRunIds.has(report.nodeRunId)),
      handoffs: handoffs.filter((handoff) => relatedNodeRunIds.has(handoff.nodeRunId)),
      artifacts: artifacts.filter((artifact) =>
        artifact.nodeRunId !== undefined && relatedNodeRunIds.has(artifact.nodeRunId)
      )
    };
  }

  private toArtifactRef(artifact: Artifact): ManagerReceiptArtifact {
    const location = artifact.downloadUrl ?? artifact.relativePath ?? artifact.storagePath;
    return {
      artifactId: artifact.id,
      title: artifact.title ?? artifact.kind,
      kind: artifact.kind,
      ...(artifact.storagePath ? { storagePath: artifact.storagePath } : {}),
      ...(artifact.relativePath ? { relativePath: artifact.relativePath } : {}),
      ...(artifact.downloadUrl ? { downloadUrl: artifact.downloadUrl } : {}),
      ...(location ? { location } : {})
    };
  }

  private getLoopRerunTargets(blueprint: BlueprintDefinition, loopNode: BlueprintNode): BlueprintNode[] {
    const nodesById = new Map(blueprint.nodes.map((candidate) => [candidate.id, candidate]));
    const visited = new Set<string>();
    const queue = blueprint.edges.filter((edge) => edge.source === loopNode.id).map((edge) => edge.target);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (nodeId === loopNode.id || visited.has(nodeId)) continue;
      const node = nodesById.get(nodeId);
      if (!node) continue;

      visited.add(nodeId);
      for (const edge of blueprint.edges) {
        if (edge.source !== nodeId || edge.target === loopNode.id) continue;
        queue.push(edge.target);
      }
    }

    return [...visited].flatMap((nodeId) => {
      const node = nodesById.get(nodeId);
      return node ? [node] : [];
    });
  }

  private getRequiredAfterIndex(
    blueprint: BlueprintDefinition,
    node: BlueprintNode,
    nodeRuns: BlueprintNodeRun[]
  ): number | undefined {
    if (node.type === "loop") {
      return this.findLatestTerminalNodeRunWithIndex(nodeRuns, node.id)?.index;
    }

    let latestMarker: { index: number } | undefined;
    for (const candidate of blueprint.nodes) {
      if (candidate.type !== "loop") continue;
      if (!this.getLoopRerunTargets(blueprint, candidate).some((target) => target.id === node.id)) continue;

      for (let index = nodeRuns.length - 1; index >= 0; index -= 1) {
        const nodeRun = nodeRuns[index]!;
        if (this.isPreflightNodeRun(nodeRun)) continue;
        if (nodeRun.nodeId !== candidate.id || nodeRun.status !== "succeeded") continue;
        const status = readString(readOutputRecord(nodeRun.output)?.status);
        if (status !== "rerun") continue;
        if (!latestMarker || index > latestMarker.index) {
          latestMarker = { index };
        }
        break;
      }
    }

    return latestMarker?.index;
  }

  private hasSatisfiedIncomingAfter(
    blueprint: BlueprintDefinition,
    node: BlueprintNode,
    nodeRuns: BlueprintNodeRun[],
    requiredAfterIndex: number
  ): boolean {
    const incoming = this.getSchedulingIncomingEdges(blueprint, node);
    if (incoming.length === 0) return false;
    return incoming.every((edge) => this.resolveIncomingEdgeState(blueprint, edge, nodeRuns, requiredAfterIndex) === "satisfied");
  }

  private isAfterRequiredIndex(index: number, requiredAfterIndex?: number): boolean {
    return requiredAfterIndex === undefined || index > requiredAfterIndex;
  }

  private resolveManagerDecision(
    output: unknown,
    currentSlot: number,
    portCount: number,
    options: { ignoreCompletionStatus?: boolean; minSlot?: number } = {}
  ): ManagerDecision {
    const minSlot = normalizeInteger(options.minSlot, 1, portCount, 1);
    const record = readDecisionRecord(output);
    const explicitSlot =
      readInteger(record?.nextSlot) ??
      readInteger(record?.routeToSlot) ??
      readInteger(record?.returnToSlot) ??
      readInteger(record?.targetSlot);
    const status = readString(record?.status)?.toLowerCase();
    const reason = readString(record?.reason) ?? readString(record?.message) ?? "manager_decision_missing_reason";
    const roundNumber = readManagerRoundNumberFromDecisionRecord(record);

    if (
      !options.ignoreCompletionStatus &&
      status &&
      ["complete", "completed", "done", "stop", "passed", "pass", "approved"].includes(status) &&
      currentSlot >= portCount
    ) {
      return { status: "complete", roundNumber, reason };
    }
    if (!options.ignoreCompletionStatus && status && ["complete", "completed", "done", "stop"].includes(status)) {
      return { status: "complete", roundNumber, reason };
    }
    if (explicitSlot !== undefined) {
      if (explicitSlot < minSlot || explicitSlot > portCount) {
        return { status: "complete", roundNumber, reason: reason ?? `next slot ${explicitSlot} is outside available manager work slots` };
      }
      return {
        status: explicitSlot <= currentSlot ? "retry" : "continue",
        roundNumber,
        nextSlot: explicitSlot,
        reason
      };
    }

    const failed =
      status !== undefined &&
      ["fail", "failed", "needs_revision", "needs-revision", "retry", "rework", "blocked", "reject", "rejected"].includes(status);
    if (failed) {
      return {
        status: "retry",
        roundNumber,
        nextSlot: Math.max(minSlot, currentSlot - 1),
        reason
      };
    }

    if (currentSlot >= portCount) {
      return { status: "complete", roundNumber, reason };
    }
    return { status: "continue", roundNumber, nextSlot: Math.max(minSlot, currentSlot + 1), reason };
  }

  private async collectUpstreamOutputs(
    blueprint: BlueprintDefinition,
    blueprintRunId: string,
    node: BlueprintNode
  ): Promise<UpstreamOutput> {
    const incoming = this.getUpstreamIncomingEdges(blueprint, node);
    if (incoming.length === 0) return [];

    const nodeRuns = await this.store.listNodeRuns(blueprintRunId);
    const [humanReports, handoffs, artifacts] = await Promise.all([
      this.store.listAgentHumanReports(blueprintRunId),
      this.store.listAgentHandoffs(blueprintRunId),
      this.store.listArtifacts(blueprintRunId)
    ]);
    const outputs: UpstreamOutput = [];
    const seen = new Set<string>();
    const requiredAfterIndex = this.getRequiredAfterIndex(blueprint, node, nodeRuns);

    for (const edge of incoming) {
      const source = blueprint.nodes.find((candidate) => candidate.id === edge.source);
      const edgeRequiredAfterIndex = source?.type === "loop" ? undefined : requiredAfterIndex;
      if (this.resolveIncomingEdgeState(blueprint, edge, nodeRuns, edgeRequiredAfterIndex) !== "satisfied") {
        continue;
      }

      const sourceRun = this.findLatestNodeRun(nodeRuns, edge.source, "succeeded", edgeRequiredAfterIndex);
      if (!sourceRun || seen.has(sourceRun.nodeId)) continue;

      seen.add(sourceRun.nodeId);
      outputs.push(this.toUpstreamOutputItem(
        sourceRun,
        sourceRun.output,
        this.buildUpstreamReportContext(blueprint, sourceRun, nodeRuns, humanReports, handoffs, artifacts)
      ));
    }

    return outputs;
  }

  private toUpstreamOutputItem(
    nodeRun: BlueprintNodeRun,
    output = nodeRun.output,
    context: {
      humanReports?: Awaited<ReturnType<HivewardStore["listAgentHumanReports"]>>;
      handoffs?: Awaited<ReturnType<HivewardStore["listAgentHandoffs"]>>;
      artifacts?: Artifact[];
      context?: unknown;
    } = {}
  ): UpstreamOutputItem {
    const humanReports = context.humanReports ?? [];
    const handoffs = context.handoffs ?? [];
    const artifacts = context.artifacts ?? [];
    const humanReportMd = humanReports.map((report) => report.bodyMd).filter(Boolean).join("\n\n") || undefined;
    const handoffJson = handoffs.length === 1
      ? handoffs[0]!.payload
      : handoffs.length > 1
        ? handoffs.map((handoff) => ({ nodeId: handoff.nodeId, payload: handoff.payload }))
        : undefined;
    const shouldExposeRawOutput = this.shouldExposeRawUpstreamOutput(nodeRun);
    const outputSummary = !shouldExposeRawOutput && !humanReportMd && hasVisibleAgentOutput(output)
      ? formatNodeOutputSummary(output)
      : undefined;
    return {
      nodeId: nodeRun.nodeId,
      nodeLabel: nodeRun.nodeLabel,
      nodeRunId: nodeRun.id,
      status: nodeRun.status,
      ...(shouldExposeRawOutput && output !== undefined ? { output } : {}),
      ...(handoffJson !== undefined ? { handoffJson } : {}),
      ...(humanReports[0] ? { humanReportId: humanReports[0].id } : {}),
      ...(humanReportMd ? { humanReportMd } : {}),
      ...(humanReports[0] && humanReportMd ? {
        report: {
          humanReportId: humanReports[0].id,
          title: humanReports[0].title,
          bodyMd: humanReportMd,
          source: humanReports[0].source
        }
      } : {}),
      ...(artifacts.length ? { artifacts: artifacts.map((artifact) => this.toArtifactRef(artifact)) } : {}),
      ...(outputSummary ? { outputSummary } : {}),
      ...(context.context !== undefined ? { context: context.context } : {}),
      runtimeRef: nodeRun.runtimeRef
    };
  }

  private shouldExposeRawUpstreamOutput(nodeRun: BlueprintNodeRun): boolean {
    return nodeRun.nodeType === "condition" || nodeRun.nodeType === "loop";
  }

  private async completeNode(nodeRun: BlueprintNodeRun, output: unknown, runtimeRef?: RuntimeObjectRef): Promise<void> {
    if (this.cancelledRunIds.has(nodeRun.blueprintRunId)) {
      await this.cancelNodeRun(nodeRun, "Run stopped by user.", runtimeRef);
      return;
    }

    const completedAt = new Date().toISOString();
    const completed: BlueprintNodeRun = {
      ...nodeRun,
      status: "succeeded",
      endedAt: completedAt,
      output,
      runtimeRef: runtimeRef ?? nodeRun.runtimeRef
    };
    const artifacts = completed.nodeType === "agent" || completed.nodeType === "summary"
      ? await this.artifactService.prepareFromNodeRun({
        runId: completed.blueprintRunId,
        roundId: completed.iterationRoundId,
        nodeRun: completed
      })
      : [];
    const reports = completed.nodeType === "agent" || completed.nodeType === "manager"
      ? this.agentReportService.prepareFromOutput({
        runId: completed.blueprintRunId,
        roundId: completed.iterationRoundId,
        nodeRunId: completed.id,
        nodeId: completed.nodeId,
        nodeLabel: completed.nodeLabel,
        output: completed.output,
        createdAt: completedAt
      })
      : {};
    const claim = await this.ensureNodeRunClaim(nodeRun);
    if (!claim) return;
    const published = await this.store.publishAgentOutput({
      runId: completed.blueprintRunId,
      roundId: completed.iterationRoundId,
      nodeRunId: completed.id,
      owner: claim.owner,
      workerEpoch: claim.workerEpoch,
      nodeRun: completed,
      output,
      rawResult: output,
      artifacts,
      humanReport: reports.humanReport,
      handoff: reports.handoff,
      event: {
        id: `event-${nanoid(10)}`,
        blueprintRunId: nodeRun.blueprintRunId,
        nodeRunId: nodeRun.id,
        type: "node.run.completed",
        message: `${nodeRun.nodeLabel} completed.`,
        runtimeRef,
        createdAt: completedAt
      }
    });
    if (published.published) this.nodeRunClaims.delete(nodeRun.id);
  }

  private async collectStandardNodeInput(
    blueprint: BlueprintDefinition,
    blueprintRunId: string,
    node: BlueprintNode
  ): Promise<StandardNodeInput> {
    return {
      upstream: await this.collectUpstreamOutputs(blueprint, blueprintRunId, node)
    };
  }

  private async recordNodeInput(nodeRun: BlueprintNodeRun, input: unknown): Promise<BlueprintNodeRun> {
    const nodeRunWithInput: BlueprintNodeRun = {
      ...nodeRun,
      input
    };
    const claim = await this.ensureNodeRunClaim(nodeRun);
    if (claim) {
      await this.store.startNodeRun({
        nodeRunId: nodeRun.id,
        owner: claim.owner,
        workerEpoch: claim.workerEpoch,
        input
      });
    } else {
      await this.store.upsertNodeRun(nodeRunWithInput);
    }
    return nodeRunWithInput;
  }

  private async ensureNodeRunClaim(nodeRun: BlueprintNodeRun): Promise<{ owner: string; workerEpoch: number } | undefined> {
    const existing = this.nodeRunClaims.get(nodeRun.id);
    if (existing && nodeRun.status !== "waiting_approval") return existing;
    if (existing) this.nodeRunClaims.delete(nodeRun.id);
    if (!this.isOpenNodeRunStatus(nodeRun.status)) return undefined;
    if (nodeRun.status !== "queued" && nodeRun.status !== "running" && nodeRun.status !== "waiting_approval") return undefined;
    if (nodeRun.status === "waiting_approval") {
      await this.store.createQueuedNodeRun({ ...nodeRun, status: "queued" });
    }
    const claim = await this.store.claimNodeRun({
      nodeRunId: nodeRun.id,
      owner: this.workerId,
      leaseMs: this.nodeRunLeaseMs
    });
    if (!claim.claimed || claim.workerEpoch === undefined) return undefined;
    const token = { owner: this.workerId, workerEpoch: claim.workerEpoch };
    this.nodeRunClaims.set(nodeRun.id, token);
    return token;
  }

  private async recordNodeRuntimeRef(nodeRun: BlueprintNodeRun, runtimeRef: RuntimeObjectRef): Promise<BlueprintNodeRun> {
    const currentNodeRun = (await this.store.listNodeRuns(nodeRun.blueprintRunId)).find((candidate) => candidate.id === nodeRun.id);
    const nodeRunWithRef: BlueprintNodeRun = {
      ...(currentNodeRun ?? nodeRun),
      runtimeRef
    };
    const claim = await this.ensureNodeRunClaim(nodeRun);
    if (claim) {
      await this.store.startNodeRun({
        nodeRunId: nodeRun.id,
        owner: claim.owner,
        workerEpoch: claim.workerEpoch,
        runtimeRef
      });
    } else {
      await this.store.upsertNodeRun(nodeRunWithRef);
    }
    return nodeRunWithRef;
  }

  private async failNode(nodeRun: BlueprintNodeRun, error: string): Promise<void> {
    if (this.cancelledRunIds.has(nodeRun.blueprintRunId)) {
      await this.cancelNodeRun(nodeRun, "Run stopped by user.");
      return;
    }

    const claim = await this.ensureNodeRunClaim(nodeRun);
    const failed = claim
      ? await this.store.failNodeRun({
          nodeRunId: nodeRun.id,
          owner: claim.owner,
          workerEpoch: claim.workerEpoch,
          endedAt: new Date().toISOString(),
          error
        })
      : false;
    if (failed) {
      this.nodeRunClaims.delete(nodeRun.id);
      await this.event(nodeRun.blueprintRunId, "node.run.failed", `${nodeRun.nodeLabel} failed: ${error}`, nodeRun.id);
    }
  }

  private async skipNode(blueprint: BlueprintDefinition, run: BlueprintRun, node: BlueprintNode): Promise<void> {
    const now = new Date().toISOString();
    const reason = node.disabled ? "disabled" : "branch_not_selected";
    const iterationRoundId = await this.currentExecutingRoundId(run.id);
    const skipped: BlueprintNodeRun = {
      id: `node-run-${nanoid(10)}`,
      blueprintRunId: run.id,
      blueprintId: blueprint.id,
      nodeId: node.id,
      nodeLabel: node.config.label,
      nodeType: node.type,
      ...(iterationRoundId ? { iterationRoundId } : {}),
      status: "skipped",
      queuedAt: now,
      startedAt: now,
      endedAt: now,
      output: {
        reason
      }
    };
    await this.store.upsertNodeRun(skipped);
    await this.event(run.id, "node.run.completed", `${node.config.label} skipped (${reason}).`, skipped.id);
  }

  private async cancelOpenNodeRuns(blueprintRunId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const nodeRuns = await this.store.listNodeRuns(blueprintRunId);
    await Promise.all(
      nodeRuns
        .filter((nodeRun) => this.isOpenNodeRunStatus(nodeRun.status))
        .map((nodeRun) => this.cancelNodeRun({ ...nodeRun, endedAt: now }, reason))
    );
  }

  private async hasOpenNodeRuns(blueprintRunId: string): Promise<boolean> {
    const nodeRuns = await this.store.listNodeRuns(blueprintRunId);
    return nodeRuns.some((nodeRun) => this.isOpenNodeRunStatus(nodeRun.status));
  }

  private async cancelNodeRun(nodeRun: BlueprintNodeRun, reason: string, runtimeRef?: RuntimeObjectRef): Promise<void> {
    const currentNodeRun = (await this.store.listNodeRuns(nodeRun.blueprintRunId)).find((candidate) => candidate.id === nodeRun.id);
    if (currentNodeRun?.status === "cancelled") return;

    const cancelled: BlueprintNodeRun = {
      ...(currentNodeRun ?? nodeRun),
      status: "cancelled",
      endedAt: currentNodeRun?.endedAt ?? nodeRun.endedAt ?? new Date().toISOString(),
      error: reason,
      runtimeRef: runtimeRef ?? currentNodeRun?.runtimeRef ?? nodeRun.runtimeRef
    };
    const claim = await this.ensureNodeRunClaim(currentNodeRun ?? nodeRun);
    const cancelledOk = claim
      ? await this.store.cancelNodeRun({
          nodeRunId: nodeRun.id,
          owner: claim.owner,
          workerEpoch: claim.workerEpoch,
          endedAt: cancelled.endedAt,
          reason,
          runtimeRef: cancelled.runtimeRef
        })
      : false;
    if (cancelledOk) {
      this.nodeRunClaims.delete(nodeRun.id);
      await this.event(nodeRun.blueprintRunId, "node.run.cancelled", `${nodeRun.nodeLabel} cancelled: ${reason}`, nodeRun.id, cancelled.runtimeRef);
    }
  }

  private async applyRunTotals(run: BlueprintRun, startedAt: number, status: "succeeded" | "failed" | "cancelled"): Promise<BlueprintRun> {
    const endedAt = new Date().toISOString();
    await this.approvalService.closePendingForRun(run.id, `Run ${status}; pending approvals are frozen.`);
    await this.iterationService.markRunTerminal(run.id, status, endedAt);
    await this.managerMailProjector.refresh(run.id);
    const nodeRuns = await this.store.listNodeRuns(run.id);
    const usage = nodeRuns.flatMap((nodeRun) => (nodeRun.usage ? [nodeRun.usage] : []));
    const runtimeRefs = nodeRuns.flatMap((nodeRun) => (nodeRun.runtimeRef ? [nodeRun.runtimeRef] : []));
    return {
      ...run,
      status,
      endedAt,
      durationMs: Date.now() - startedAt,
      totalInputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
      totalOutputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
      totalCostUsd: Number(usage.reduce((sum, item) => sum + item.costUsd, 0).toFixed(6)),
      runtimeRefs
    };
  }

  private async keepRunActive(run: BlueprintRun, status: "running" | "waiting_approval"): Promise<void> {
    await this.store.updateBlueprintRun({
      ...run,
      status,
      endedAt: undefined,
      durationMs: undefined
    });
  }

  private isRecoverableSdkTaskLookupMiss(error: unknown, runtimeRef: RuntimeObjectRef): boolean {
    if (
      runtimeRef.source !== "codex" &&
      runtimeRef.source !== "claude" &&
      runtimeRef.source !== "google" &&
      runtimeRef.source !== "cursor" &&
      runtimeRef.source !== "opencode" &&
      runtimeRef.source !== "hermes"
    ) return false;
    return error instanceof Error && error.message.startsWith("SDK task not found:");
  }

  private async isRunCancelled(blueprintRunId: string): Promise<boolean> {
    if (this.cancelledRunIds.has(blueprintRunId)) return true;

    const currentRun = await this.store.getBlueprintRun(blueprintRunId);
    if (currentRun?.status !== "cancelled") return false;

    this.cancelledRunIds.add(blueprintRunId);
    return true;
  }

  private isTerminalRunStatus(status: BlueprintRun["status"]): status is "succeeded" | "failed" | "cancelled" {
    return status === "succeeded" || status === "failed" || status === "cancelled";
  }

  private isOpenNodeRunStatus(status: BlueprintNodeRun["status"]): boolean {
    return status === "queued" || status === "running" || status === "waiting_approval";
  }

  private isPreflightNodeRun(nodeRun: BlueprintNodeRun): boolean {
    return nodeRun.id.startsWith("preflight-");
  }

  private hasCurrentNodeRun(blueprint: BlueprintDefinition, node: BlueprintNode, nodeRuns: BlueprintNodeRun[]): boolean {
    if (node.type === "loop") {
      const latestLoopRun = this.findLatestNodeRunWithIndex(nodeRuns, node.id);
      if (!latestLoopRun) return false;
      return !this.hasSatisfiedIncomingAfter(blueprint, node, nodeRuns, latestLoopRun.index);
    }

    const requiredAfterIndex = this.getRequiredAfterIndex(blueprint, node, nodeRuns);
    return nodeRuns.some((nodeRun, index) =>
      !this.isPreflightNodeRun(nodeRun) &&
      nodeRun.nodeId === node.id &&
      this.isAfterRequiredIndex(index, requiredAfterIndex)
    );
  }

  private hasCurrentTerminalNodeRun(blueprint: BlueprintDefinition, node: BlueprintNode, nodeRuns: BlueprintNodeRun[]): boolean {
    if (node.type === "loop") {
      const latestLoopRun = this.findLatestNodeRunWithIndex(nodeRuns, node.id);
      if (!latestLoopRun) return false;
      return this.isTerminalStatus(latestLoopRun.nodeRun.status) && !this.hasSatisfiedIncomingAfter(blueprint, node, nodeRuns, latestLoopRun.index);
    }

    const requiredAfterIndex = this.getRequiredAfterIndex(blueprint, node, nodeRuns);
    return nodeRuns.some(
      (nodeRun, index) =>
        !this.isPreflightNodeRun(nodeRun) &&
        nodeRun.nodeId === node.id &&
        this.isAfterRequiredIndex(index, requiredAfterIndex) &&
        ["succeeded", "failed", "cancelled", "skipped"].includes(nodeRun.status)
    );
  }

  private isBlueprintStep(node: BlueprintNode): boolean {
    return executableTypes.has(node.type);
  }

  private isRunnableNode(node: BlueprintNode): boolean {
    return this.isBlueprintStep(node) && !node.disabled;
  }

  private isGlobalSchedulingNode(blueprint: BlueprintDefinition, node: BlueprintNode): boolean {
    return this.isBlueprintStep(node) &&
      node.type !== "manager_slot" &&
      !this.isNestedNode(node) &&
      !this.isManagedParticipant(blueprint, node);
  }

  private isArtifactProducingNodeRun(blueprint: BlueprintDefinition, nodeRun: BlueprintNodeRun): boolean {
    const node = blueprint.nodes.find((candidate) => candidate.id === nodeRun.nodeId);
    return Boolean(node && (isAgentBlueprintNode(node) || node.type === "summary"));
  }

  private isTopSelfIterationManager(blueprint: BlueprintDefinition, node: BlueprintNode): boolean {
    return node.type === "manager" && this.iterationService.findTopSelfIterationManager(blueprint)?.id === node.id;
  }

  private isNestedNode(node: BlueprintNode): boolean {
    return Boolean(node.parentId);
  }

  private isManagedParticipant(blueprint: BlueprintDefinition, node: BlueprintNode): boolean {
    return blueprint.edges.some((edge) => {
      if (edge.target !== node.id || !edge.sourceHandle?.startsWith(managerOutHandlePrefix)) return false;
      const source = blueprint.nodes.find((candidate) => candidate.id === edge.source);
      return source?.type === "manager";
    });
  }

  private getSchedulingIncomingEdges(blueprint: BlueprintDefinition, node: BlueprintNode): BlueprintEdge[] {
    return blueprint.edges.filter((edge) => {
      if (edge.target !== node.id) return false;
      if (node.type === "manager" && edge.targetHandle?.startsWith(managerInHandlePrefix)) return false;

      const source = blueprint.nodes.find((candidate) => candidate.id === edge.source);
      if (source?.type === "loop") return false;
      return true;
    });
  }

  private getUpstreamIncomingEdges(blueprint: BlueprintDefinition, node: BlueprintNode): BlueprintEdge[] {
    return blueprint.edges.filter((edge) => {
      if (edge.target !== node.id) return false;
      return !(node.type === "manager" && edge.targetHandle?.startsWith(managerInHandlePrefix));
    });
  }

  private findLatestNodeRun(
    nodeRuns: BlueprintNodeRun[],
    nodeId: string,
    status?: BlueprintNodeRun["status"],
    requiredAfterIndex?: number
  ): BlueprintNodeRun | undefined {
    for (let index = nodeRuns.length - 1; index >= 0; index -= 1) {
      const nodeRun = nodeRuns[index]!;
      if (this.isPreflightNodeRun(nodeRun)) continue;
      if (nodeRun.nodeId !== nodeId) continue;
      if (!this.isAfterRequiredIndex(index, requiredAfterIndex)) continue;
      if (status && nodeRun.status !== status) continue;
      return nodeRun;
    }
    return undefined;
  }

  private findLatestNodeRunWithIndex(
    nodeRuns: BlueprintNodeRun[],
    nodeId: string,
    status?: BlueprintNodeRun["status"]
  ): { nodeRun: BlueprintNodeRun; index: number } | undefined {
    for (let index = nodeRuns.length - 1; index >= 0; index -= 1) {
      const nodeRun = nodeRuns[index]!;
      if (this.isPreflightNodeRun(nodeRun)) continue;
      if (nodeRun.nodeId !== nodeId) continue;
      if (status && nodeRun.status !== status) continue;
      return { nodeRun, index };
    }
    return undefined;
  }

  private findLatestTerminalNodeRunWithIndex(
    nodeRuns: BlueprintNodeRun[],
    nodeId: string
  ): { nodeRun: BlueprintNodeRun; index: number } | undefined {
    for (let index = nodeRuns.length - 1; index >= 0; index -= 1) {
      const nodeRun = nodeRuns[index]!;
      if (this.isPreflightNodeRun(nodeRun)) continue;
      if (nodeRun.nodeId !== nodeId) continue;
      if (!this.isTerminalStatus(nodeRun.status)) continue;
      return { nodeRun, index };
    }
    return undefined;
  }

  private resolveIncomingEdgeState(
    blueprint: BlueprintDefinition,
    edge: BlueprintEdge,
    nodeRuns: BlueprintNodeRun[],
    requiredAfterIndex?: number
  ): IncomingEdgeState {
    const source = blueprint.nodes.find((candidate) => candidate.id === edge.source);
    if (!source) return "blocked";
    if (!this.isBlueprintStep(source)) return "satisfied";

    const sourceRun = this.findLatestNodeRun(nodeRuns, source.id, undefined, requiredAfterIndex);
    if (!sourceRun) return "pending";
    if (!this.isTerminalStatus(sourceRun.status)) return "pending";

    const condition = edge.condition ?? "success";
    if (condition === "success") {
      return sourceRun.status === "succeeded" ? "satisfied" : "blocked";
    }
    if (condition === "failure") {
      return sourceRun.status === "failed" || sourceRun.status === "cancelled" ? "satisfied" : "blocked";
    }

    if (sourceRun.status !== "succeeded") {
      return "blocked";
    }

    const expected = condition === "true";
    const actual = this.readConditionResult(sourceRun.output);
    return actual === expected ? "satisfied" : "blocked";
  }

  private isTerminalStatus(status: BlueprintNodeRun["status"]): boolean {
    return ["succeeded", "failed", "cancelled", "skipped"].includes(status);
  }

  private readConditionResult(output: unknown): boolean | undefined {
    if (typeof output === "boolean") return output;
    if (!output || typeof output !== "object") return undefined;

    const result = (output as { result?: unknown }).result;
    return typeof result === "boolean" ? result : undefined;
  }

  private missingAgentOutputError(runtimeRef: RuntimeObjectRef): string {
    const location = [
      runtimeRef.runId ? `runId ${runtimeRef.runId}` : undefined,
      runtimeRef.sessionKey ? `session ${runtimeRef.sessionKey}` : undefined
    ].filter(Boolean).join(", ");
    return `Agent run finished without visible output${location ? ` (${location})` : ""}.`;
  }

  private async runAgentTask(
    input: StartAgentTaskInput,
    onStarted?: (runtimeRef: RuntimeObjectRef) => Promise<void>
  ): Promise<{ result: AgentTaskResult; runtimeRef: RuntimeObjectRef }> {
    let runtimeRef: RuntimeObjectRef | undefined;
    const timelineState: NodeRuntimeTimelineState = {
      id: `timeline-${input.nodeRunId}-runtime`,
      output: ""
    };
    let eventWriteError: unknown;
    let eventWrites = Promise.resolve();
    const enqueueEventWrite = (write: () => Promise<void>) => {
      eventWrites = eventWrites.then(write).catch((error) => {
        eventWriteError ??= error;
      });
    };

    const result = await this.adapter.streamAgentTask(input, (event) => {
      if (event.type === "started") {
        runtimeRef = runtimeRefFromStartedEvent(event);
        enqueueEventWrite(async () => {
          await onStarted?.(runtimeRef!);
          await this.appendNodeRuntimeTimelineItem(input, timelineState, event, runtimeRef!);
        });
        return;
      }
      if (event.type === "runtime_state" || event.type === "delta" || event.type === "done") {
        enqueueEventWrite(async () => {
          await this.appendNodeRuntimeTimelineItem(input, timelineState, event, runtimeRef);
        });
      }
    });
    await eventWrites;
    if (eventWriteError) {
      throw eventWriteError;
    }

    runtimeRef ??= runtimeRefFromTaskResult(result);

    return {
      result,
      runtimeRef: {
        ...runtimeRef,
        sourceId: result.taskId,
        sourceUpdatedAt: result.updatedAt,
        taskId: result.taskId,
        runId: result.runId,
        sessionKey: result.sessionKey,
        usageRef: result.usage?.id
      }
    };
  }

  private async appendNodeRuntimeTimelineItem(
    input: StartAgentTaskInput,
    state: NodeRuntimeTimelineState,
    event: Extract<ChatStreamEvent, { type: "started" | "runtime_state" | "delta" | "done" }>,
    runtimeRef: RuntimeObjectRef | undefined
  ): Promise<void> {
    updateNodeRuntimeTimelineState(state, event);
    if (state.sequence === undefined) {
      const existing = (await this.store.listRunTimeline(input.blueprintRunId)).find((item) => item.id === state.id);
      state.sequence = existing?.sequence;
    }
    const item = await this.store.appendRunTimelineItem({
      id: state.id,
      ...(state.sequence !== undefined ? { sequence: state.sequence } : {}),
      runId: input.blueprintRunId,
      createdAt: new Date().toISOString(),
      actorLabel: input.agentName,
      kind: "node_runtime",
      title: nodeRuntimeTimelineTitle(input, state),
      body: nodeRuntimeTimelineBody(input, state, runtimeRef),
      payloadRef: input.nodeRunId
    });
    state.sequence = item.sequence;
  }

  private async event(
    blueprintRunId: string,
    type: BlueprintNodeEvent["type"],
    message: string,
    nodeRunId?: string,
    runtimeRef?: RuntimeObjectRef
  ): Promise<void> {
    await this.store.appendEvent({
      id: `event-${nanoid(10)}`,
      blueprintRunId,
      nodeRunId,
      type,
      message,
      createdAt: new Date().toISOString(),
      runtimeRef
    });
  }
}

function normalizeInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isAgentApprovalWaitingOutput(value: unknown): value is AgentApprovalWaitingOutput {
  if (!isRecord(value)) return false;
  return value.approvalType === "agent" && "reviewOutput" in value && Array.isArray(value.replies);
}

function normalizeAgentApprovalSelectionId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatNodeOutputSummary(output: unknown): string {
  if (typeof output === "string") {
    return output.length > 500 ? `${output.slice(0, 500)}...` : output;
  }
  try {
    const serialized = JSON.stringify(output);
    return serialized.length > 500 ? `${serialized.slice(0, 500)}...` : serialized;
  } catch {
    return String(output);
  }
}

function readPromptForReceiptRoleContext(value: string | undefined): { value?: string; truncated?: boolean } {
  const prompt = value?.trim();
  if (!prompt) return {};
  return prompt.length > managerReceiptPromptBudget
    ? { value: prompt.slice(0, managerReceiptPromptBudget), truncated: true }
    : { value: prompt, truncated: false };
}

function isNodeRunAtOrAfter(nodeRun: BlueprintNodeRun, timestamp: number): boolean {
  if (!Number.isFinite(timestamp)) return true;
  const nodeRunStartedAt = Date.parse(nodeRun.queuedAt ?? nodeRun.startedAt ?? "");
  return !Number.isFinite(nodeRunStartedAt) || nodeRunStartedAt >= timestamp;
}

function isReviewOutputSelectionId(value: string | undefined): boolean {
  return value === reviewOutputSelectionId;
}

function isAgentApprovalSelectionAvailable(replies: AgentApprovalReply[], selectedReplyId: string | undefined): boolean {
  if (!selectedReplyId || isReviewOutputSelectionId(selectedReplyId)) return true;
  return replies.some((reply) => reply.id === selectedReplyId && reply.role === "assistant");
}

function assertAgentApprovalSelection(output: AgentApprovalWaitingOutput, selectedReplyId: string): void {
  if (isReviewOutputSelectionId(selectedReplyId)) return;
  if (output.replies.some((reply) => reply.id === selectedReplyId && reply.role === "assistant")) return;
  throw new Error("Only assistant approval replies can be selected as candidates.");
}

function applyAgentApprovalSelection(
  output: AgentApprovalWaitingOutput,
  selectedReplyId: string | undefined
): AgentApprovalWaitingOutput {
  const normalizedSelectedReplyId = normalizeAgentApprovalSelectionId(selectedReplyId) ?? output.selectedReplyId;
  if (!normalizedSelectedReplyId) {
    return {
      ...output,
      replies: markSelectedApprovalReplies(output.replies, undefined)
    };
  }
  assertAgentApprovalSelection(output, normalizedSelectedReplyId);
  const selectedOutput = selectedReplyId
    ? resolveAgentApprovalSelectionSnapshot(output, normalizedSelectedReplyId)
    : output.selectedOutput;
  return {
    ...output,
    selectedReplyId: normalizedSelectedReplyId,
    ...(selectedOutput !== undefined ? { selectedOutput } : {}),
    replies: markSelectedApprovalReplies(output.replies, normalizedSelectedReplyId)
  };
}

function resolveAgentApprovalSelectedOutput(output: AgentApprovalWaitingOutput): unknown {
  const selectedReplyId = normalizeAgentApprovalSelectionId(output.selectedReplyId);
  if (!selectedReplyId) return output.reviewOutput;
  if (isReviewOutputSelectionId(selectedReplyId)) {
    return "selectedOutput" in output ? output.selectedOutput : output.reviewOutput;
  }
  const selectedReply = output.replies.find((reply) => reply.id === selectedReplyId && reply.role === "assistant");
  if (!selectedReply) {
    throw new Error("Selected approval reply is no longer available.");
  }
  return selectedReply.body;
}

function resolveAgentApprovalSelectionSnapshot(output: AgentApprovalWaitingOutput, selectedReplyId: string): unknown {
  if (isReviewOutputSelectionId(selectedReplyId)) return output.reviewOutput;
  const selectedReply = output.replies.find((reply) => reply.id === selectedReplyId && reply.role === "assistant");
  return selectedReply?.body;
}

function markSelectedApprovalReplies(
  replies: AgentApprovalReply[],
  selectedReplyId: string | undefined
): AgentApprovalReply[] {
  return replies.map((reply) => {
    const { selected: _selected, ...unselectedReply } = reply;
    return selectedReplyId && reply.id === selectedReplyId
      ? { ...unselectedReply, canUseAsSolution: true, selected: true }
      : unselectedReply;
  });
}

function inboxThreadStreamKey(threadType: InboxThreadType, threadId: string): string {
  return `${threadType}:${threadId}`;
}

function harnessIdForRuntimeSource(source: StartAgentTaskInput["source"]): HarnessId {
  return source === "claude" ? "claudeCode" : source;
}

function chatPermissionModeForTaskInput(input: StartAgentTaskInput): "safe" | "full_access" {
  return input.permissionProfile === "workspace_write" || input.runtimeAccessPolicy?.filesystem === "workspace_write"
    ? "full_access"
    : "safe";
}

const inboxDiscussionPromptBodyMaxChars = 1_200;

function formatInboxDiscussionChatPrompt(
  request: ApprovalRequest,
  input: StartAgentTaskInput,
  options: {
    chatSession: HivewardChatSession;
    discussionMode: InboxDiscussionMode;
    visibleUserMessage: string;
  }
): string {
  const needsWorkPrompt = options.discussionMode === "candidate" || options.chatSession.nativeSessionState === "missing";
  return needsWorkPrompt
    ? formatInboxDiscussionWorkPrompt(input)
    : formatInboxDiscussionReplyPrompt(request, options.visibleUserMessage, options.chatSession);
}

function formatInboxDiscussionWorkPrompt(input: StartAgentTaskInput): string {
  return [
    input.prompt,
    "",
    "HiveWard inbox discussion payload:",
    formatJsonForApprovalReply(input.input),
    "",
    "Session contract:",
    "- Continue this same native chat session when a session key is provided.",
    "- Treat the latest approvalChat.latestUserReply as the user's newest message.",
    "- Do not approve, reject, schedule, rerun, complete, or advance workflow lifecycle from this chat turn.",
    "- If this turn is producing a formal candidate or final report, apply the report writing rules from the node prompt again: start with a summary, then list delivery locations for any generated artifacts, and fill available platform fields such as humanReportMd, artifacts, result, and handoffJson.",
    "- Return only the human-visible discussion answer or candidate content."
  ].join("\n");
}

function formatInboxDiscussionReplyPrompt(
  request: ApprovalRequest,
  visibleUserMessage: string,
  chatSession: HivewardChatSession
): string {
  const latestMessage = formatInboxDiscussionVisibleUserMessage(visibleUserMessage);
  const summaryLines = [
    `- Title: ${request.title}`,
    `- Type: ${request.kind}`,
    `- Status: ${request.status}`,
    request.nodeRunId ? `- Node run: ${request.nodeRunId}` : undefined,
    request.roundId ? `- Round: ${request.roundId}` : undefined,
    request.body ? `- Current mail body: ${trimInboxDiscussionPromptText(request.body, inboxDiscussionPromptBodyMaxChars)}` : undefined,
    chatSession.nativeSessionId
      ? "- Native session: continue the existing session history; do not restate all prior context."
      : "- Native session: this may be the first chat turn, so use only this compact mail summary as context."
  ];
  return [
    "This is an ordinary reply in a HiveWard inbox discussion.",
    "Continue the current native session conversation when a session key is provided.",
    "Do not approve, reject, rerun, schedule, complete, terminate, publish candidates, or otherwise advance workflow lifecycle.",
    "Return only the human-visible discussion answer. Do not produce a selectable candidate unless this turn is explicitly routed as candidate mode.",
    "",
    "Latest user message:",
    latestMessage,
    "",
    "Current mail summary:",
    ...summaryLines.filter((line): line is string => Boolean(line))
  ].join("\n");
}

function formatInboxDiscussionVisibleUserMessage(value: string): string {
  return value.trim();
}

function trimInboxDiscussionPromptText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function chatDoneRuntimeMetadata(event: Extract<ChatStreamEvent, { type: "done" }>): Record<string, unknown> {
  return {
    taskId: event.taskId,
    runId: event.runId,
    sessionKey: event.sessionKey,
    source: event.source,
    status: event.status,
    updatedAt: event.updatedAt,
    ...(event.error ? { error: event.error } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.timings ? { timings: event.timings } : {})
  };
}

function isNativeResumeFailure(message: string | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    /(resume|resum|session|thread).*(missing|not found|invalid|expired|deleted|unavailable|cannot|could not|failed)/.test(normalized) ||
    /(missing|not found|invalid|expired|deleted).*(session|thread)/.test(normalized) ||
    normalized.includes("no conversation found")
  );
}

const nodeRuntimeOutputMaxChars = 2_000;

function runtimeRefFromStartedEvent(event: Extract<ChatStreamEvent, { type: "started" }>): RuntimeObjectRef {
  return {
    source: event.source,
    sourceId: event.taskId,
    sourceUpdatedAt: event.updatedAt,
    taskId: event.taskId,
    runId: event.runId,
    sessionKey: event.sessionKey,
    usageRef: undefined
  };
}

function runtimeRefFromTaskResult(result: AgentTaskResult): RuntimeObjectRef {
  return {
    source: result.source,
    sourceId: result.taskId,
    sourceUpdatedAt: result.updatedAt,
    taskId: result.taskId,
    runId: result.runId,
    sessionKey: result.sessionKey,
    usageRef: result.usage?.id
  };
}

function updateNodeRuntimeTimelineState(
  state: NodeRuntimeTimelineState,
  event: Extract<ChatStreamEvent, { type: "started" | "runtime_state" | "delta" | "done" }>
): void {
  if (event.type === "started") {
    state.runtimeLabel = `${event.source} task started`;
    state.runtimeStatus = event.status;
    return;
  }
  if (event.type === "runtime_state") {
    state.runtimeLabel = event.label;
    state.runtimeStatus = [event.phase, event.status].filter(Boolean).join(" ");
    return;
  }
  if (event.type === "delta") {
    state.output = trimRuntimeOutput(event.replace ? event.text : `${state.output}${event.text}`);
    return;
  }
  state.runtimeStatus = event.status;
  state.completedAt = event.updatedAt;
  state.error = event.error;
  if (!state.output && event.output) {
    state.output = trimRuntimeOutput(event.output);
  }
}

function nodeRuntimeTimelineTitle(input: StartAgentTaskInput, state: NodeRuntimeTimelineState): string {
  const status = state.completedAt ? "done" : state.runtimeStatus ?? "running";
  return `${input.agentName}: ${state.runtimeLabel ?? status}`;
}

function nodeRuntimeTimelineBody(
  input: StartAgentTaskInput,
  state: NodeRuntimeTimelineState,
  runtimeRef: RuntimeObjectRef | undefined
): string {
  const lines = [
    `nodeRunId: ${input.nodeRunId}`,
    `runtime: ${runtimeRef?.source ?? input.source}`,
    state.runtimeStatus ? `runtime_state: ${state.runtimeStatus}` : undefined,
    state.runtimeLabel ? `activity: ${state.runtimeLabel}` : undefined,
    state.output ? `recent_output:\n${state.output}` : undefined,
    state.error ? `error: ${state.error}` : undefined,
    state.completedAt ? `done: ${state.completedAt}` : undefined
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function trimRuntimeOutput(output: string): string {
  return output.length > nodeRuntimeOutputMaxChars
    ? output.slice(output.length - nodeRuntimeOutputMaxChars)
    : output;
}

function approvalRequestTimestamp(request: ApprovalRequest): number {
  return new Date(request.updatedAt ?? request.requestedAt).getTime();
}

function inboxDiscussionDoneEvent(threadType: InboxThreadType, threadId: string, messageId: string): StreamInboxThreadMessageEvent {
  const now = new Date().toISOString();
  return {
    type: "done",
    taskId: messageId,
    runId: threadId,
    sessionKey: inboxThreadStreamKey(threadType, threadId),
    status: "succeeded",
    updatedAt: now,
    threadType,
    threadId,
    messageId
  };
}

function formatAgentApprovalDiscussionBody(output: unknown): string {
  const record = readOutputRecord(output);
  const humanReportMd = readString(record?.humanReportMd);
  if (humanReportMd) return humanReportMd;
  if (typeof output === "string" && output.trim()) return output.trim();
  return formatJsonForApprovalReply(output);
}

function formatJsonForApprovalReply(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildAgentApprovalReplyInput(
  originalInput: unknown,
  previousOutput: unknown,
  previousReplies: AgentApprovalReply[],
  userReply: AgentApprovalReply,
  discussionMode: InboxDiscussionMode
): Record<string, unknown> {
  const conversation = [...previousReplies, userReply];
  const instruction = [
    "This node is paused at a human approval checkpoint.",
    discussionMode === "candidate"
      ? "The human explicitly asked for a formal candidate artifact in the latest inbox reply."
      : "The latest inbox reply is ordinary discussion, not a request to publish a candidate artifact.",
    "Treat approvalChat.conversation and approvalChat.latestUserReply as an in-progress meeting with the human.",
    discussionMode === "candidate"
      ? "Produce the full reviewable candidate for this node in humanReportMd."
      : "When the user is clarifying, asking for simpler wording, exploring options, or steering direction, answer conversationally in plain language and move the discussion forward.",
    "Use the user's language and match their requested tone unless a formal artifact is being finalized.",
    discussionMode === "candidate"
      ? "Do not return only an acknowledgement; write the complete candidate draft."
      : "Do not repeat the previous formal template or produce a final report unless approvalChat.requestedOutput is candidate.",
    "If the user asks whether something is feasible, give the feasible path, tradeoffs, and any blocker before offering a final artifact.",
    "If required information is still missing, ask only the specific missing question.",
    "Do not claim the approval has passed, been selected, or advanced downstream."
  ].join(" ");
  const approvalChat: AgentApprovalChatInput = {
    previousOutput,
    latestUserReply: userReply.body,
    conversation,
    instruction,
    requestedOutput: discussionMode,
    candidateRequested: discussionMode === "candidate"
  };

  return {
    originalInput,
    approvalReplies: conversation,
    approvalChat,
    humanApproval: {
      previousOutput,
      previousReplies,
      latestReply: userReply.body,
      instruction
    }
  };
}

function buildAgentApprovalRevisionInput(
  originalInput: unknown,
  previousOutput: unknown,
  previousReplies: AgentApprovalReply[],
  requestedChanges: string,
  revisionContext: PendingApprovalRevisionContext
): Record<string, unknown> {
  const instruction = [
    "This node is being rerun because the human explicitly selected request_changes.",
    "Treat requestedChanges as required revision feedback, not as a casual chat reply.",
    "Produce a revised output for the original task while preserving useful parts of the previous output.",
    "Do not claim the approval is complete or approved; the platform will create a new pending approval for the revised output."
  ].join(" ");

  return {
    originalInput,
    approvalReplies: previousReplies,
    approvalRevisionContext: revisionContext,
    approvalRevision: {
      previousOutput,
      previousReplies,
      requestedChanges,
      instruction
    },
    humanApproval: {
      previousOutput,
      previousReplies,
      requestedChanges,
      instruction
    }
  };
}

function readApprovalRevisionContext(input: unknown): PendingApprovalRevisionContext | undefined {
  if (!isRecord(input)) return undefined;
  const raw = input.approvalRevisionContext;
  if (!isRecord(raw)) return undefined;
  const context: PendingApprovalRevisionContext = {};
  if (typeof raw.threadId === "string" && raw.threadId.trim()) context.threadId = raw.threadId;
  if (typeof raw.replacesRequestId === "string" && raw.replacesRequestId.trim()) context.replacesRequestId = raw.replacesRequestId;
  if (typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision > 0) context.revision = raw.revision;
  if (typeof raw.requestedChanges === "string" && raw.requestedChanges.trim()) context.requestedChanges = raw.requestedChanges;
  return context.threadId || context.replacesRequestId || context.revision ? context : undefined;
}

function buildApprovedAgentOutput(
  approvedOutput: unknown,
  replies: AgentApprovalReply[],
  comment?: string,
  selectedReplyId?: string
): unknown {
  const decisionComment = comment?.trim();
  if (replies.length === 0 && !decisionComment && !selectedReplyId) return approvedOutput;

  const envelope: ApprovedAgentOutputEnvelope = {
    approvedOutput,
    approval: {
      status: "approved",
      ...(decisionComment ? { comment: decisionComment } : {}),
      replies,
      ...(selectedReplyId ? { selectedReplyId } : {})
    }
  };
  return envelope;
}

function readOutputRecord(output: unknown): Record<string, unknown> | undefined {
  if (isRecord(output)) return output;
  if (typeof output !== "string") return undefined;

  const trimmed = output.trim();
  if (!trimmed) return undefined;

  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Keep trying the next candidate.
    }
  }
  return undefined;
}

function readDecisionRecord(output: unknown): Record<string, unknown> | undefined {
  const record = readOutputRecord(output);
  if (!record) return undefined;
  if (!isRecord(record.result)) return record;
  return {
    ...record,
    ...record.result
  };
}

function readManagerRoundNumberFromManagerContext(value: unknown): number | undefined {
  const record = readOutputRecord(value);
  if (!isRecord(record?.manager)) return undefined;
  return readPositiveInteger(record.manager.roundNumber);
}

function readManagerRoundNumberFromDecisionOutput(output: unknown): number | undefined {
  return readManagerRoundNumberFromDecisionRecord(readDecisionRecord(output));
}

function readManagerRoundNumberFromDecisionRecord(record: Record<string, unknown> | undefined): number | undefined {
  return readPositiveInteger(record?.managerRoundNumber) ?? readPositiveInteger(record?.roundNumber);
}

function validateManagerDecisionRoundNumber(roundNumber: number, currentRoundNumber: number): string | undefined {
  const current = Math.max(1, currentRoundNumber);
  if (roundNumber === current) return undefined;
  return `Manager decision result.roundNumber must equal current round ${current}; next round is created only after the manager release report is approved, received ${roundNumber}.`;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = readInteger(value);
  return parsed !== undefined && parsed >= 1 ? parsed : undefined;
}

function readManagerSnapshotDraft(output: unknown): ManagerSnapshotDraft | undefined {
  const record = readOutputRecord(output);
  if (!record) return undefined;
  const summary = readString(record.summary);
  const draft: ManagerSnapshotDraft = {
    completedItems: readStringList(record.completedItems),
    rejectedOptions: readStringList(record.rejectedOptions),
    keyDecisions: readStringList(record.keyDecisions),
    validatedFacts: readStringList(record.validatedFacts),
    openQuestions: readStringList(record.openQuestions),
    activeRisks: readStringList(record.activeRisks),
    assumptions: readStringList(record.assumptions),
    recommendedNextStep: readRecommendedNextStep(record.recommendedNextStep),
    summary,
    freeform: readString(record.freeform)
  };
  return Object.values(draft).some((value) => value !== undefined) ? draft : undefined;
}

function buildAgentOutputEnvelopeSchema(resultSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ...humanReportEnvelopeSchemaBase,
    required: resultSchema ? ["humanReportMd", "result"] : ["humanReportMd"],
    properties: {
      ...(humanReportEnvelopeSchemaBase.properties as Record<string, unknown>),
      result: resultSchema ?? flexibleJsonObjectSchema
    }
  };
}

function artifactsToReleaseReportRefs(artifacts: Artifact[]): ReleaseReport["artifactRefs"] {
  return artifacts.map((artifact) => ({
    artifactId: artifact.id,
    title: artifact.title ?? artifact.id,
    location: artifact.storagePath ?? artifact.downloadUrl ?? artifact.relativePath ?? artifact.id,
    current: (artifact.status ?? "current") === "current"
  }));
}

function readRecommendedNextStep(value: unknown): ManagerSnapshotDraft["recommendedNextStep"] | undefined {
  return value === "research" || value === "plan" || value === "execute" || value === "complete" ? value : undefined;
}

function usesChineseText(value: string | undefined): boolean {
  return /[\u3400-\u9fff]/.test(value ?? "");
}

function isManagerCompletionEnvelope(output: unknown): boolean {
  const record = readOutputRecord(output);
  if (!record) return false;
  const status = readString(record.status)?.toLowerCase();
  return status === "completed" && Array.isArray(record.trace);
}

function isHarnessSummaryMode(config: SummaryNodeConfig): boolean {
  const mode = config.mode as string;
  return mode === "harness_summary" || mode === "openclaw_summary_agent";
}

function resolveSummaryRuntimeId(config: SummaryNodeConfig): AgentRuntimeId {
  return config.runtimeId === "codex" ||
    config.runtimeId === "claude" ||
    config.runtimeId === "google" ||
    config.runtimeId === "cursor" ||
    config.runtimeId === "opencode" ||
    config.runtimeId === "hermes" ||
    config.runtimeId === "openclaw"
    ? config.runtimeId
    : "openclaw";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== "string") return undefined;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map((item) => readString(item)).filter((item): item is string => Boolean(item));
  return normalized.length ? normalized : undefined;
}

function hasVisibleAgentOutput(output: unknown): boolean {
  if (typeof output === "string") return output.trim().length > 0;
  if (output === undefined || output === null) return false;
  if (Array.isArray(output)) return output.length > 0;
  if (typeof output === "object") return Object.keys(output).length > 0;
  return true;
}

function stringifyManagerSlotOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function formatRuntimeSource(source: RuntimeObjectRef["source"]): string {
  if (source === "codex") return "Codex";
  if (source === "claude") return "Claude";
  if (source === "google") return "Google CLI";
  if (source === "cursor") return "Cursor CLI";
  if (source === "opencode") return "OpenCode";
  if (source === "hermes") return "Hermes";
  return "OpenClaw";
}

function buildAgentSessionKey(agentId: string): string {
  return `agent:${normalizeAgentId(agentId)}:main`;
}

function normalizeAgentId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/g, "").replace(/-+$/g, "").slice(0, 64) || "main";
}

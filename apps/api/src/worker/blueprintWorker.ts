import { nanoid } from "nanoid";
import type { RuntimeAdapter } from "@hiveward/adapter";
import {
  isAgentBlueprintNode,
  resolveAgentRuntimeSource,
  isManagerSlotInnerInHandle,
  isManagerSlotInnerOutHandle,
  resolveCrossRoundContextMode,
  resolveManagerSlotExecutionMode,
  type AgentNodeConfig,
  type AgentRuntimeId,
  type AgentTaskResult,
  type ConditionNodeConfig,
  type LoopNodeConfig,
  type IterationRound,
  type IterationSession,
  type ManagerNodeConfig,
  type ManagerSlotNodeConfig,
  type RuntimeObjectRef,
  type StartAgentTaskInput,
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
import { ApprovalService, type LifecycleApprovalOutcome } from "../services/lifecycleApprovalService";
import { ArtifactService } from "../services/artifactService";
import { IterationService } from "../services/iterationLifecycleService";
import { ManagerMailProjector } from "../services/managerMailProjector";
import { MigrationService } from "../services/runtimeAccessPolicyService";
import { AgentReportService } from "../services/agentReportService";
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
const managerRosterPromptBudget = 24000;
const managerRosterItemPromptBudget = 6000;
const reviewOutputSelectionId = "reviewOutput";
const defaultManagerPrompt = [
  "You are a Hiveward manager agent.",
  "Choose which numbered slot should receive the next handoff by reading the upstream input, previousResults, and delegationRoster.",
  "If there is no better instruction, run connected slots in ascending order.",
  "Return an AgentOutputEnvelope JSON object. Put the routing decision keys status, nextSlot, and reason inside result.",
  "Use status=\"continue\" with nextSlot to delegate, or status=\"complete\" when the workflow is done."
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
  items: {
    type: "object",
    required: ["kind", "title"],
    properties: {
      id: { type: "string" },
      slot: { type: "string" },
      title: { type: "string" },
      kind: { type: "string", enum: ["html", "markdown", "json", "file", "link"] },
      format: { type: "string" },
      previewPolicy: { type: "string", enum: ["none", "source", "sandboxed_iframe"] },
      trusted: { type: "boolean" },
      content: { type: "string" },
      body: { type: "string" },
      path: { type: "string" },
      url: { type: "string" }
    }
  }
};
const managerDecisionResultSchema: Record<string, unknown> = {
  type: "object",
  required: ["status"],
  properties: {
    status: { type: "string" },
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
  "- Return an AgentOutputEnvelope JSON object when you produce a result. This platform contract overrides earlier task wording such as \"return only JSON\" or \"do not return markdown\".",
  "- Include humanReportMd: a Markdown report written for a human reader. This field is required.",
  "- Write humanReportMd in the user's working language. If the user request, blueprint title, agent label, or runContext is Chinese, write Simplified Chinese. Do not default to English for human-facing reports.",
  "- All visible headings, labels, and prose inside humanReportMd must use that language. For Chinese reports, do not use English headings such as Decision, Summary, Validation, or Delivery location.",
  "- humanReportMd must include a visible delivery-location section near the top. For Chinese reports, use \"## \u4ea4\u4ed8\u4f4d\u7f6e\" and write \"\u672c\u6b65\u9aa4\u6ca1\u6709\u4ea7\u751f\u65b0\u7684\u4ea4\u4ed8\u7269\u3002\" if this step created no new deliverable. For English reports, use \"## Delivery location\" and \"No new deliverable produced in this step.\"",
  "- Include result for the task-specific result or artifact-producing content. If the task asked for strict JSON, put that strict JSON inside result.",
  "- If another agent, manager, or downstream node may continue from your work, include handoffJson with structured facts, decisions, artifact references, assumptions, risks, and suggested next steps.",
  "- If you created a concrete deliverable file or preview, declare it in artifacts[]. Do not hide deliverables inside humanReportMd or result.",
  "- Each artifacts[] item must include kind (html, markdown, json, file, or link), title, and content/body for generated text artifacts, path for existing file artifacts, or url for link artifacts.",
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
}

interface ManagerDecision {
  status: "continue" | "retry" | "complete";
  nextSlot?: number;
  reason?: string;
}

interface AgentApprovalReply {
  id: string;
  role: "assistant" | "user";
  body: string;
  createdAt: string;
  selected?: boolean;
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

interface ManagerSlotContext {
  manager: {
    nodeId: string;
    nodeLabel: string;
    instructions?: string;
    slot: number;
    handoff: number;
    maxHandoffs: number;
  };
  upstream: UpstreamOutput;
  previousResults: Array<{
    handoff: number;
    slot: number;
    nodeId: string;
    nodeLabel: string;
    status: AgentTaskResult["status"];
    output?: unknown;
    error?: string;
    decision?: ManagerDecision;
  }>;
}

interface UpstreamOutputItem {
  nodeId: string;
  nodeLabel: string;
  nodeRunId: string;
  status: BlueprintNodeRun["status"];
  output: unknown;
  handoffJson?: unknown;
  humanReportId?: string;
  humanReportMd?: string;
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
    action: "approve" | "reject" | "reply" | "complete" | "terminate",
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

    if (request.kind === "agent_proposal" && request.nodeRunId && action === "reply") {
      await this.approvalService.recordPendingReply(approvalRequestId, input.message ?? "");
      return this.replyToApproval(blueprint, currentRun, request.nodeRunId, input.message ?? "");
    }

    const requirementRevision = request.kind === "iteration_requirement_plan" && action === "reply"
      ? await this.buildRequirementReplyRevision(blueprint, currentRun, request, input.message ?? "")
      : undefined;

    let result;
    if (action === "approve") {
      result = await this.approvalService.approve(approvalRequestId, input.comment, input.selectedReplyId);
    } else if (action === "reject") {
      result = await this.approvalService.reject(approvalRequestId, input.comment);
    } else if (action === "reply") {
      result = await this.approvalService.reply(approvalRequestId, input.message ?? "", requirementRevision);
    } else if (action === "complete") {
      result = await this.approvalService.complete(approvalRequestId, input.comment);
    } else {
      result = await this.approvalService.terminate(approvalRequestId, input.comment);
    }

    const lifecycle = await this.iterationService.handleApprovalResult(result);
    await this.managerMailProjector.refresh(run.id);

    if (request.kind === "agent_proposal" && request.nodeRunId) {
      if (action === "approve") return this.approveRun(blueprint, currentRun, request.nodeRunId, input.comment, input.selectedReplyId);
      if (action === "reject") return this.rejectRun(blueprint, currentRun, request.nodeRunId, input.comment);
      if (action === "reply") return this.replyToApproval(blueprint, currentRun, request.nodeRunId, input.message ?? "");
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
      await this.appendPreflightTaskFailed(run, node, mode, nodeRunId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (result.status !== "succeeded") {
      const error = result.error ?? `Agent task ended with status ${result.status}.`;
      await this.failPreflightNodeRun(preflightNode.nodeRun, preflightNode.claim, error);
      await this.appendPreflightTaskFailed(run, node, mode, nodeRunId, error);
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
      await this.appendPreflightTaskFailed(run, topManager, mode, nodeRunId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (result.status !== "succeeded") {
      const error = result.error ?? `Agent task ended with status ${result.status}.`;
      await this.failPreflightNodeRun(preflightNode.nodeRun, preflightNode.claim, error);
      await this.appendPreflightTaskFailed(run, topManager, mode, nodeRunId, error);
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
      ? "Resolve whether this round has enough information. Put facts, assumptions, risks, and hardBlocker in result when execution must stop."
      : mode === "preflight_judgment"
        ? "Semantically judge whether the draft round execution plan can proceed or needs another research pass. Put needsMoreResearch, reason, optional researchBrief, and optional hardBlocker inside result."
        : mode === "context_snapshot"
          ? "Summarize this completed round for future manager memory. Return JSON with completedItems, rejectedOptions, keyDecisions, validatedFacts, openQuestions, activeRisks, assumptions, recommendedNextStep, summary, and optional freeform."
          : "Generate a round execution plan. Put objective, scope, exclusions, basis, assumptions, risks, acceptance criteria, expected artifacts, and hardBlocker inside result when execution must stop.";
    return [
      config.instructions?.trim() || "You are a Hiveward manager preparing a self-iteration round.",
      "",
      modeInstruction,
      ...agentOutputContractLines,
      "For hard blockers, set result.hardBlocker: true and put the user-readable blocker explanation in humanReportMd.",
      "Use the provided runContext as structured input for this call only.",
      "Do not claim the round is complete. Do not dispatch worker slots from this preflight call."
    ].join("\n");
  }

  private async buildRequirementReplyRevision(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    request: ApprovalRequest,
    message: string
  ): Promise<{ title: string; body: string; capabilities?: ApprovalRequest["capabilities"] } | undefined> {
    const feedback = message.trim();
    if (!feedback) return undefined;

    const topManager = this.iterationService.findTopSelfIterationManager(blueprint);
    if (!topManager) return undefined;

    const round = request.roundId
      ? (await this.store.listIterationRounds({ runId: run.id })).find((candidate) => candidate.id === request.roundId)
      : undefined;
    if (!round) return undefined;
    const session = (await this.store.listIterationSessions(run.id)).find((candidate) => candidate.id === round.sessionId);
    if (!session) return undefined;
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
    await this.store.upsertIterationRound({
      ...round,
      researchStatus: preflight.researchStatus,
      researchSummary: preflight.researchSummary,
      researchArtifactIds: preflight.researchArtifactIds,
      planSource: "revised_from_reply"
    });
    const title = `Round ${round.roundNumber} Execution Plan v${revision}`;
    return {
      title,
      body: preflight.body,
      capabilities: preflight.researchStatus === "blocked"
        ? { approve: false, reject: true, reply: true, complete: false, terminate: false }
        : undefined
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
    if (this.isTerminalRunStatus(run.status)) {
      throw new Error("Run is already finished.");
    }

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

    const node = blueprint.nodes.find((candidate) => candidate.id === waiting.nodeId);
    if (!node || !isAgentBlueprintNode(node)) {
      throw new Error("Approval reply target Agent node was not found.");
    }

    const now = new Date().toISOString();
    const userReply: AgentApprovalReply = {
      id: `approval-reply-${nanoid(10)}`,
      role: "user",
      body: message.trim(),
      createdAt: now
    };
    const runningNodeRun: BlueprintNodeRun = {
      ...waiting,
      status: "running",
      output: {
        ...waiting.output,
        replies: markSelectedApprovalReplies([...waiting.output.replies, userReply], waiting.output.selectedReplyId)
      }
    };
    const claim = await this.ensureNodeRunClaim(waiting);
    if (!claim) throw new Error(`Node run ${runningNodeRun.id} could not be reclaimed for approval reply.`);
    await this.store.startNodeRun({
      nodeRunId: runningNodeRun.id,
      owner: claim.owner,
      workerEpoch: claim.workerEpoch,
      startedAt: now,
      input: runningNodeRun.input
    });
    await this.event(run.id, "node.run.started", `${waiting.nodeLabel} received a review reply.`, waiting.id);
    await this.store.updateBlueprintRun({ ...run, status: "running" });

    try {
      const config = node.config as AgentNodeConfig;
      const runtimeId = node.runtimeId ?? "openclaw";
      let nodeRunWithRef = runningNodeRun;
      const { result, runtimeRef } = await this.runAgentTask({
        blueprintRunId: run.id,
        nodeRunId: waiting.id,
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
        outputSchema: buildAgentOutputEnvelopeSchema(config.outputSchema),
        input: buildAgentApprovalReplyInput(waiting.input, waiting.output.reviewOutput, waiting.output.replies, userReply),
        skillIds: config.skillIds,
        tools: config.tools
      }, async (startedRef) => {
        nodeRunWithRef = await this.recordNodeRuntimeRef(nodeRunWithRef, startedRef);
      });

      if (result.status !== "succeeded") {
        await this.failNode({ ...nodeRunWithRef, runtimeRef, usage: result.usage }, result.error ?? `Agent run ${result.status}.`);
      } else if (!hasVisibleAgentOutput(result.output)) {
        await this.failNode({ ...nodeRunWithRef, runtimeRef, usage: result.usage }, this.missingAgentOutputError(runtimeRef));
      } else {
        const assistantReply: AgentApprovalReply = {
          id: `approval-reply-${nanoid(10)}`,
          role: "assistant",
          body: formatNodeOutputSummary(result.output),
          createdAt: new Date().toISOString()
        };
        const nextReplies = [...waiting.output.replies, userReply, assistantReply];
        const selectedReplyId = isAgentApprovalSelectionAvailable(nextReplies, waiting.output.selectedReplyId)
          ? waiting.output.selectedReplyId
          : undefined;
        await this.waitForAgentApproval(
          { ...nodeRunWithRef, runtimeRef, usage: result.usage },
          result.output,
          nextReplies,
          selectedReplyId,
          selectedReplyId ? waiting.output.selectedOutput : undefined
        );
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : "Unknown approval reply failure.";
      await this.failNode(runningNodeRun, failure);
    }

    const latestNodeRun = (await this.store.listNodeRuns(run.id)).find((candidate) => candidate.id === nodeRunId);
    const nextStatus = latestNodeRun?.status === "waiting_approval" ? "waiting_approval" as const : "running" as const;
    const nextRun = { ...run, status: nextStatus };
    await this.store.updateBlueprintRun(nextRun);
    if (nextRun.status === "running") {
      this.scheduleRun(blueprint, nextRun);
    }
    return nextRun;
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
    const summary = this.selfIterationOrchestrator.buildReleaseSummary({
      blueprint,
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
    const published = await this.iterationService.publishExecutionResult({
      run,
      managerNode: topManager,
      summary,
      artifacts
    });
    if (published) {
      const session = (await this.store.listIterationSessions(run.id)).find((candidate) => candidate.id === published.round.sessionId);
      if (session) {
        const managerSummary = await this.buildManagerSnapshotDraft(blueprint, run, session, published.round, topManager, published.releaseReport);
        const snapshot = await this.managerContextService.createSnapshotFromRoundResult({
          run,
          session,
          round: published.round,
          releaseReport: published.releaseReport,
          managerSummary
        });
        await this.store.upsertIterationRound({ ...published.round, contextSnapshotId: snapshot.id });
      }
    }
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

  private async buildManagerSnapshotDraft(
    blueprint: BlueprintDefinition,
    run: BlueprintRun,
    session: IterationSession,
    round: IterationRound,
    topManager: BlueprintNode,
    releaseReport: ReleaseReport
  ): Promise<ManagerSnapshotDraft | undefined> {
    const roundStartContext = await this.managerContextService.buildRoundStartContext({
      run,
      session,
      round,
      managerNode: topManager
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
          instruction: "Create a durable cross-round manager memory snapshot. Fill required fields with concrete content and use freeform for task-specific context.",
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
    const nodeRunWithInput = nodeRun.input === undefined
      ? await this.recordNodeInput(nodeRun, {
          upstream: await this.collectUpstreamOutputs(blueprint, run.id, node),
          ...(dispatchRunContext ? { runContext: dispatchRunContext } : {})
        })
      : nodeRun;
    const managerUpstream = this.readUpstreamInput(nodeRunWithInput.input);
    const isAgentDriven = this.isAgentDrivenManager(node);
    const trace: ManagerTraceItem[] = [];
    let slot = this.firstConnectedManagerSlot(blueprint, node, portCount);
    let searchAfterIndex = nodeRuns.findIndex((candidate) => candidate.id === nodeRun.id);
    if (searchAfterIndex < 0) return false;

    if (!slot) {
      await this.completeNode(nodeRunWithInput, {
        status: "completed",
        reason: "manager_has_no_connected_slots",
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
            slot,
            handoff,
            maxHandoffs
          },
          upstream: managerUpstream,
          previousResults: trace.map((item) => ({
            handoff: item.handoff,
            slot: item.slot,
            nodeId: item.nodeId,
            nodeLabel: item.nodeLabel,
            status: item.status,
            output: item.output,
            error: item.error,
            decision: item.decision
          }))
        };
        const managerDecisionResult = await this.runManagerDecisionTask(blueprint, run, node, nodeRunWithInput, context, dispatchRunContext, slot, portCount);
        if (managerDecisionResult.result.status !== "succeeded") {
          await this.failNode(nodeRunWithInput, managerDecisionResult.result.error ?? "Manager decision agent failed.");
          return true;
        }
        managerDecision = managerDecisionResult.decision;
        if (managerDecision.status === "complete" || managerDecision.nextSlot === undefined) {
          await this.completeNode(nodeRunWithInput, {
            status: "completed",
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
          reason: `manager_slot_${slot}_is_not_connected`,
          trace
        });
        return true;
      }

      if (assignment.target.disabled) {
        const decision = this.resolveManagerDecision({ status: "skipped" }, slot, portCount);
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
            slot,
            handoff,
            maxHandoffs
          },
          upstream: managerUpstream,
          previousResults: trace.map((item) => ({
            handoff: item.handoff,
            slot: item.slot,
            nodeId: item.nodeId,
            nodeLabel: item.nodeLabel,
            status: item.status,
            output: item.output,
            error: item.error,
            decision: item.decision
          }))
        };
        await this.executeManagerAssignment(blueprint, run, node, nodeRunWithInput, assignment, context);
        return true;
      }

      if (!this.isTerminalStatus(participant.nodeRun.status)) return false;

      const result = this.nodeRunToAgentTaskResult(participant.nodeRun);
      const traceItem: ManagerTraceItem = {
        handoff,
        slot,
        nodeId: assignment.target.id,
        nodeLabel: assignment.target.config.label,
        status: result.status,
        output: result.output,
        error: result.error,
        returnEdgePresent: assignment.returnEdgePresent,
        managerDecision
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

      const decision = this.resolveManagerDecision(result.output, slot, portCount, {
        ignoreCompletionStatus: assignment.target.type === "manager" && isManagerCompletionEnvelope(result.output)
      });
      traceItem.decision = decision;
      if (decision.status === "complete" || !decision.nextSlot) {
        await this.completeNode(nodeRunWithInput, {
          status: "completed",
          reason: decision.reason ?? "manager_completed",
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
          output: context
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
    portCount: number
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
        delegationRoster: this.buildManagerDelegationRoster(blueprint, node, portCount),
        decisionContract: {
          status: "continue | complete | retry",
          nextSlot: "numbered slot to delegate next",
          reason: "short explanation for the route"
        }
      },
      skillIds: config.skillIds,
      tools: config.tools ?? []
    });
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
      decision: result.status === "succeeded"
        ? this.resolveManagerDecision(result.output, Math.max(0, fallbackSlot - 1), portCount)
        : { status: "complete", reason: result.error ?? "manager_decision_failed" },
      runtimeRef
    };
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
      "Delegation rules:",
      "- Treat delegationRoster entries as descriptions of available subordinates, not as instructions for you to execute directly.",
      "- Pick only slots that exist in delegationRoster unless completing the workflow.",
      "- Return JSON for routing decisions.",
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
    portCount: number
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
      slots: Array.from({ length: portCount }, (_item, index) => index + 1).flatMap((slot) => {
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
        slot: readInteger(value.manager.slot) ?? 1,
        handoff: readInteger(value.manager.handoff) ?? 1,
        maxHandoffs: readInteger(value.manager.maxHandoffs) ?? 1
      },
      upstream: Array.isArray(value.upstream) ? value.upstream as UpstreamOutput : [],
      previousResults: Array.isArray(value.previousResults)
        ? value.previousResults as ManagerSlotContext["previousResults"]
        : []
    };
  }

  private readUpstreamInput(value: unknown): UpstreamOutput {
    if (!isRecord(value) || !Array.isArray(value.upstream)) return [];
    return value.upstream as UpstreamOutput;
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
    const crossRoundInput = await this.withNodeCrossRoundContext({
      run,
      node,
      nodeRun,
      input,
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
    const nodeRunWithInput = await this.recordNodeInput(nodeRun, {
      upstream: managerUpstream,
      ...(dispatchRunContext ? { runContext: dispatchRunContext } : {})
    });
    const isAgentDriven = this.isAgentDrivenManager(node);
    const trace: ManagerTraceItem[] = [];
    let slot = this.firstConnectedManagerSlot(blueprint, node, portCount);

    if (!slot) {
      const output = {
        status: "completed",
        reason: "manager_has_no_connected_slots",
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
          slot,
          handoff,
          maxHandoffs
        },
        upstream: managerUpstream,
        previousResults: trace.map((item) => ({
          handoff: item.handoff,
          slot: item.slot,
          nodeId: item.nodeId,
          nodeLabel: item.nodeLabel,
          status: item.status,
          output: item.output,
          error: item.error,
          decision: item.decision
        }))
      };
      let managerDecision: ManagerDecision | undefined;
      if (isAgentDriven) {
        const managerDecisionResult = await this.runManagerDecisionTask(blueprint, run, node, nodeRunWithInput, managerContext, dispatchRunContext, slot, portCount);
        if (managerDecisionResult.result.status !== "succeeded") {
          const error = managerDecisionResult.result.error ?? "Manager decision agent failed.";
          await this.failNode(nodeRunWithInput, error);
          return this.syntheticAgentResult(nodeRun.id, "failed", undefined, error);
        }

        managerDecision = managerDecisionResult.decision;
        if (managerDecision.status === "complete" || managerDecision.nextSlot === undefined) {
          const output = {
            status: "completed",
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
          decision: this.resolveManagerDecision({ status: "skipped" }, slot, portCount)
        });
        slot += 1;
        if (slot > portCount) {
          const output = {
            status: "completed",
            reason: "manager_reached_final_slot",
            trace
          };
          await this.completeNode(nodeRunWithInput, output);
          return this.syntheticAgentResult(nodeRun.id, "succeeded", stringifyManagerSlotOutput(output));
        }
        continue;
      }

      let result: AgentTaskResult;

      if (isAgentBlueprintNode(assignment.target)) {
        const participantRun = await this.createRunningNodeRun(blueprint, run, assignment.target, managerContext);
        result = await this.executeAgentNodeWithInput(blueprint, run, assignment.target, participantRun, managerContext);
      } else if (assignment.target.type === "manager_slot") {
        const slotRun = await this.createRunningNodeRun(blueprint, run, assignment.target, managerContext);
        result = await this.executeManagerSlotNode(blueprint, run, assignment.target, slotRun, managerContext);
      } else if (assignment.target.type === "manager") {
        const managerUpstreamInput: UpstreamOutput = [
          {
            nodeId: node.id,
            nodeLabel: node.config.label,
            nodeRunId: nodeRun.id,
            status: nodeRun.status,
            output: managerContext
          }
        ];
        const managerRun = await this.createRunningNodeRun(blueprint, run, assignment.target, { upstream: managerUpstreamInput });
        result = await this.executeManagerNode(blueprint, run, assignment.target, managerRun, managerUpstreamInput);
      } else {
        const error = `Manager slot ${slot} targets unsupported node type ${assignment.target.type}.`;
        await this.failNode(nodeRunWithInput, error);
        return this.syntheticAgentResult(nodeRun.id, "failed", undefined, error);
      }

      const traceItem: ManagerTraceItem = {
        handoff,
        slot,
        nodeId: assignment.target.id,
        nodeLabel: assignment.target.config.label,
        status: result.status,
        output: result.output,
        error: result.error,
        returnEdgePresent: assignment.returnEdgePresent,
        managerDecision
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

      const decision = this.resolveManagerDecision(result.output, slot, portCount, {
        ignoreCompletionStatus: assignment.target.type === "manager" && isManagerCompletionEnvelope(result.output)
      });
      traceItem.decision = decision;
      if (decision.status === "complete" || !decision.nextSlot) {
        const output = {
          status: "completed",
          reason: decision.reason ?? "manager_completed",
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
              await this.collectScopedUpstreamOutputs(blueprint, slotNode, slotRunWithInput, node, nodeRuns, scopeStartIndex, boundaryOutput)
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
    upstream: UpstreamOutput
  ): Promise<void> {
    const input = { upstream };
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
    const [humanReports, handoffs] = await Promise.all([
      this.store.listAgentHumanReports(slotRun.blueprintRunId),
      this.store.listAgentHandoffs(slotRun.blueprintRunId)
    ]);
    const reportContext = (nodeRun: BlueprintNodeRun) => ({
      humanReport: humanReports.find((report) => report.nodeRunId === nodeRun.id),
      handoff: handoffs.find((handoff) => handoff.nodeRunId === nodeRun.id)
    });
    if (incoming.length === 0) {
      return [this.toUpstreamOutputItem(slotRun, boundaryOutput, reportContext(slotRun))];
    }

    const outputs: UpstreamOutput = [];
    for (const edge of incoming) {
      if (this.resolveScopedEdgeState(blueprint, slotNode, edge, nodeRuns, scopeStartIndex) !== "satisfied") continue;
      if (edge.source === slotNode.id && isManagerSlotInnerOutHandle(edge.sourceHandle)) {
        outputs.push(this.toUpstreamOutputItem(slotRun, boundaryOutput, reportContext(slotRun)));
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
          output: candidate.output
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
    await this.migrationService.migratePendingNodeApproval({
      runId: nodeRun.blueprintRunId,
      nodeRun: waiting,
      requestedByLabel: nodeRun.nodeLabel
    });
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

  private firstConnectedManagerSlot(blueprint: BlueprintDefinition, managerNode: BlueprintNode, portCount: number): number | undefined {
    for (let slot = 1; slot <= portCount; slot += 1) {
      if (this.findManagerSlotAssignment(blueprint, managerNode, slot)) return slot;
    }
    return undefined;
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
    options: { ignoreCompletionStatus?: boolean } = {}
  ): ManagerDecision {
    const record = readDecisionRecord(output);
    const explicitSlot =
      readInteger(record?.nextSlot) ??
      readInteger(record?.routeToSlot) ??
      readInteger(record?.returnToSlot) ??
      readInteger(record?.targetSlot);
    const status = readString(record?.status)?.toLowerCase();
    const reason = readString(record?.reason) ?? readString(record?.message);

    if (
      !options.ignoreCompletionStatus &&
      status &&
      ["complete", "completed", "done", "stop", "passed", "pass", "approved"].includes(status) &&
      currentSlot >= portCount
    ) {
      return { status: "complete", reason };
    }
    if (!options.ignoreCompletionStatus && status && ["complete", "completed", "done", "stop"].includes(status)) {
      return { status: "complete", reason };
    }
    if (explicitSlot !== undefined) {
      if (explicitSlot < 1 || explicitSlot > portCount) {
        return { status: "complete", reason: reason ?? `next slot ${explicitSlot} is outside manager ports` };
      }
      return {
        status: explicitSlot <= currentSlot ? "retry" : "continue",
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
        nextSlot: Math.max(1, currentSlot - 1),
        reason
      };
    }

    if (currentSlot >= portCount) {
      return { status: "complete", reason };
    }
    return { status: "continue", nextSlot: currentSlot + 1, reason };
  }

  private async collectUpstreamOutputs(
    blueprint: BlueprintDefinition,
    blueprintRunId: string,
    node: BlueprintNode
  ): Promise<UpstreamOutput> {
    const incoming = this.getUpstreamIncomingEdges(blueprint, node);
    if (incoming.length === 0) return [];

    const nodeRuns = await this.store.listNodeRuns(blueprintRunId);
    const [humanReports, handoffs] = await Promise.all([
      this.store.listAgentHumanReports(blueprintRunId),
      this.store.listAgentHandoffs(blueprintRunId)
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
      outputs.push(this.toUpstreamOutputItem(sourceRun, sourceRun.output, {
        humanReport: humanReports.find((report) => report.nodeRunId === sourceRun.id),
        handoff: handoffs.find((handoff) => handoff.nodeRunId === sourceRun.id)
      }));
    }

    return outputs;
  }

  private toUpstreamOutputItem(
    nodeRun: BlueprintNodeRun,
    output = nodeRun.output,
    context: {
      humanReport?: Awaited<ReturnType<HivewardStore["listAgentHumanReports"]>>[number];
      handoff?: Awaited<ReturnType<HivewardStore["listAgentHandoffs"]>>[number];
    } = {}
  ): UpstreamOutputItem {
    return {
      nodeId: nodeRun.nodeId,
      nodeLabel: nodeRun.nodeLabel,
      nodeRunId: nodeRun.id,
      status: nodeRun.status,
      output,
      ...(context.handoff ? { handoffJson: context.handoff.payload } : {}),
      ...(context.humanReport ? { humanReportId: context.humanReport.id, humanReportMd: context.humanReport.bodyMd } : {}),
      runtimeRef: nodeRun.runtimeRef
    };
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
    const started = await this.adapter.startAgentTask(input);
    const source = started.source;
    const runtimeRef: RuntimeObjectRef = {
      source,
      sourceId: started.taskId,
      sourceUpdatedAt: started.updatedAt,
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      usageRef: undefined
    };
    await onStarted?.(runtimeRef);

    if (started.status === "failed" || started.status === "cancelled") {
      return {
        result: {
          ...started,
          output: undefined,
          usage: undefined
        },
        runtimeRef
      };
    }

    const result = await this.adapter.waitForAgentTask({
      nodeRunId: input.nodeRunId,
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source,
      agentId: input.agentId,
      modelId: input.modelId
    });

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
  throw new Error("Only assistant approval replies can be selected.");
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
      ? { ...unselectedReply, selected: true }
      : unselectedReply;
  });
}

function buildAgentApprovalReplyInput(
  originalInput: unknown,
  previousOutput: unknown,
  previousReplies: AgentApprovalReply[],
  userReply: AgentApprovalReply
): Record<string, unknown> {
  const conversation = [...previousReplies, userReply];
  const instruction = [
    "This node is paused at a human approval checkpoint.",
    "Treat approvalChat.conversation and approvalChat.latestUserReply as an in-progress meeting with the human, not as a command to produce a formal report every turn.",
    "Infer the user's immediate intent from the latest reply and the conversation history.",
    "When the user is clarifying, asking for simpler wording, exploring options, or steering direction, answer conversationally in plain language and move the discussion forward.",
    "Use the user's language and match their requested tone unless a formal artifact is being finalized.",
    "When the user explicitly asks to finalize, generate a report, use a proposal, wrap up, or indicates the discussion is settled, produce the final reviewable artifact for this node.",
    "If the user asks whether something is feasible, give the feasible path, tradeoffs, and any blocker before offering a final artifact.",
    "Do not repeat the previous formal template unless the latest user intent calls for a formal artifact.",
    "If required information is still missing, ask only the specific missing question."
  ].join(" ");
  const approvalChat: AgentApprovalChatInput = {
    previousOutput,
    latestUserReply: userReply.body,
    conversation,
    instruction
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

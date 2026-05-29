import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BlueprintDefinition, BlueprintRunView } from "@hiveward/shared";
import { messages } from "../lib/i18n";
import { RunsPage } from "./WorkspacePages";

describe("RunsPage", () => {
  it("renders the run report board before raw trace details", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-1",
      companyId: "company-1",
      name: "Self iteration blueprint",
      version: 1,
      nodes: [],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-1",
        companyId: "company-1",
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        blueprintVersion: 1,
        status: "waiting_approval",
        startedBy: "user-1",
        startedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      },
      nodeRuns: [
        {
          id: "node-run-1",
          blueprintRunId: "run-1",
          blueprintId: blueprint.id,
          nodeId: "agent-1",
          nodeLabel: "Reporter",
          nodeType: "agent",
          iterationRoundId: "round-1",
          status: "succeeded",
          queuedAt: now,
          startedAt: now,
          endedAt: now,
          output: "SECRET_RAW_OUTPUT http://localhost:5173/raw-only.html"
        },
        {
          id: "node-run-2",
          blueprintRunId: "run-1",
          blueprintId: blueprint.id,
          nodeId: "agent-2",
          nodeLabel: "Legacy Reporter",
          nodeType: "agent",
          iterationRoundId: "round-1",
          status: "succeeded",
          queuedAt: now,
          startedAt: now,
          endedAt: now,
          output: { summary: "legacy output" }
        }
      ],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [
        {
          id: "round-1",
          sessionId: "session-1",
          runId: "run-1",
          roundNumber: 1,
          status: "report_pending",
          requirementRequestId: "request-plan-1",
          approvedRequirementRequestId: "request-plan-1",
          approvedRequirementRevision: 1,
          artifactIds: ["artifact-1"],
          researchStatus: "agent_generated",
          researchSummary: "Research facts for the round.",
          planSource: "agent_generated",
          startedAt: now
        }
      ],
      approvalRequests: [
        {
          id: "request-plan-1",
          runId: "run-1",
          roundId: "round-1",
          kind: "iteration_requirement_plan",
          status: "approved",
          title: "Round 1 Execution Plan",
          body: "Approved plan body.",
          revision: 1,
          capabilities: { approve: true, reject: true, reply: true, complete: false, terminate: false },
          requestedBy: { type: "node", label: "Top Manager", nodeId: "manager-1" },
          requestedAt: now
        }
      ],
      approvalDecisions: [],
      artifacts: [
        {
          id: "artifact-1",
          runId: "run-1",
          roundId: "round-1",
          nodeRunId: "node-run-1",
          title: "Readable artifact",
          kind: "markdown",
          downloadUrl: "/artifacts/artifact-1",
          previewPolicy: "source",
          trusted: false,
          createdAt: now
        }
      ],
      releaseReports: [
        {
          id: "release-report-1",
          runId: "run-1",
          roundId: "round-1",
          approvalRequestId: "release-request-1",
          version: 1,
          title: "Round 1 Release Report",
          summary: "Manager summary from reports.",
          artifactRefs: [
            {
              artifactId: "artifact-1",
              title: "Readable artifact",
              location: "/artifacts/artifact-1",
              current: true
            }
          ],
          createdAt: now
        }
      ],
      agentHumanReports: [
        {
          id: "human-report-1",
          runId: "run-1",
          roundId: "round-1",
          nodeRunId: "node-run-1",
          nodeId: "agent-1",
          nodeLabel: "Reporter",
          title: "Reporter report",
          bodyMd: "## Human Report\n\nReadable facts for the user.",
          source: "agent",
          createdAt: now
        },
        {
          id: "human-report-2",
          runId: "run-1",
          roundId: "round-1",
          nodeRunId: "node-run-2",
          nodeId: "agent-2",
          nodeLabel: "Legacy Reporter",
          title: "Legacy Reporter report",
          bodyMd: "legacy output",
          source: "fallback",
          fallbackReason: "Agent output did not include humanReportMd.",
          createdAt: now
        }
      ],
      agentHandoffs: [
        {
          id: "handoff-1",
          runId: "run-1",
          roundId: "round-1",
          nodeRunId: "node-run-1",
          nodeId: "agent-1",
          payload: { decision: "machine-only" },
          createdAt: now
        }
      ],
      managerContextSnapshots: [],
      runTimeline: [],
      managerMail: []
    };

    const html = renderToStaticMarkup(
      <RunsPage
        runs={[runView]}
        blueprints={[blueprint]}
        blueprint={blueprint}
        selectedRunId={runView.run.id}
        language="en"
        t={messages.en}
        onSelectBlueprint={() => undefined}
        onSelectRun={() => undefined}
      />
    );

    expect(html.indexOf("Round Execution Plan")).toBeLessThan(html.indexOf("Agent Markdown reports"));
    expect(html.indexOf("Agent Markdown reports")).toBeLessThan(html.indexOf("Manager Release Report"));
    expect(html.indexOf("Manager Release Report")).toBeLessThan(html.indexOf("Artifacts"));
    expect(html.indexOf("Artifacts")).toBeLessThan(html.indexOf("Run Advanced Details"));
    expect(html).toContain("Approved plan body.");
    expect(html).toContain("Human Report");
    expect(html).toContain("Delivery location");
    expect(html).toContain("fallback");
    expect(html).toContain("Manager summary from reports.");
    expect(html).toContain("Readable artifact");
    expect(html.indexOf("/artifacts/artifact-1")).toBeLessThan(html.indexOf("Advanced details"));
    expect(html.indexOf("http://localhost:5173/raw-only.html")).toBeGreaterThan(html.indexOf("Advanced details"));
    expect(html.indexOf("SECRET_RAW_OUTPUT")).toBeGreaterThan(html.indexOf("Advanced details"));
    expect(html.indexOf("machine-only")).toBeGreaterThan(html.indexOf("Advanced details"));
  });

  it("does not promote raw output paths into delivery locations when artifacts are empty", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-raw-path",
      companyId: "company-1",
      name: "Raw path blueprint",
      version: 1,
      nodes: [],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-raw-path",
        companyId: "company-1",
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        blueprintVersion: 1,
        status: "succeeded",
        startedBy: "user-1",
        startedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      },
      nodeRuns: [
        {
          id: "node-run-raw-path",
          blueprintRunId: "run-raw-path",
          blueprintId: blueprint.id,
          nodeId: "agent-raw-path",
          nodeLabel: "Raw Path Agent",
          nodeType: "agent",
          status: "succeeded",
          queuedAt: now,
          startedAt: now,
          endedAt: now,
          output: { path: "D:/HiveWard/raw-only.html", result: { ok: true } }
        }
      ],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [],
      approvalRequests: [],
      approvalDecisions: [],
      artifacts: [],
      releaseReports: [],
      agentHumanReports: [
        {
          id: "human-report-raw-path",
          runId: "run-raw-path",
          nodeRunId: "node-run-raw-path",
          nodeId: "agent-raw-path",
          nodeLabel: "Raw Path Agent",
          title: "Raw Path Agent report",
          bodyMd: "## Summary\n\nThe agent returned debug output only.",
          source: "agent",
          createdAt: now
        }
      ],
      agentHandoffs: [],
      managerContextSnapshots: [],
      runTimeline: [],
      managerMail: []
    };

    const html = renderToStaticMarkup(
      <RunsPage
        runs={[runView]}
        blueprints={[blueprint]}
        blueprint={blueprint}
        selectedRunId={runView.run.id}
        language="en"
        t={messages.en}
        onSelectBlueprint={() => undefined}
        onSelectRun={() => undefined}
      />
    );

    expect(html).toContain("No new deliverable produced in this step.");
    expect(html.indexOf("D:/HiveWard/raw-only.html")).toBeGreaterThan(html.indexOf("Advanced details"));
    expect(html).not.toContain('href="D:/HiveWard/raw-only.html"');
  });

  it("does not add a duplicate Chinese delivery section when the report already has one", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-existing-delivery",
      companyId: "company-1",
      name: "交付区识别",
      version: 1,
      nodes: [],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-existing-delivery",
        companyId: "company-1",
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        blueprintVersion: 1,
        status: "succeeded",
        startedBy: "user-1",
        startedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      },
      nodeRuns: [
        {
          id: "node-run-existing-delivery",
          blueprintRunId: "run-existing-delivery",
          blueprintId: blueprint.id,
          nodeId: "agent-existing-delivery",
          nodeLabel: "交付 Agent",
          nodeType: "agent",
          status: "succeeded",
          queuedAt: now,
          startedAt: now,
          endedAt: now,
          output: { status: "complete" }
        }
      ],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [],
      approvalRequests: [],
      approvalDecisions: [],
      artifacts: [],
      releaseReports: [],
      agentHumanReports: [
        {
          id: "human-report-existing-delivery",
          runId: "run-existing-delivery",
          nodeRunId: "node-run-existing-delivery",
          nodeId: "agent-existing-delivery",
          nodeLabel: "交付 Agent",
          title: "交付 Agent report",
          bodyMd: "## 交付位置\n\n最终单文件 HTML 已交付在 artifacts[0].content。",
          source: "agent",
          createdAt: now
        }
      ],
      agentHandoffs: [],
      managerContextSnapshots: [],
      runTimeline: [],
      managerMail: []
    };

    const html = renderToStaticMarkup(
      <RunsPage
        runs={[runView]}
        blueprints={[blueprint]}
        blueprint={blueprint}
        selectedRunId={runView.run.id}
        language="zh-CN"
        t={messages["zh-CN"]}
        onSelectBlueprint={() => undefined}
        onSelectRun={() => undefined}
      />
    );

    expect(html).toContain("交付位置");
    expect(html).toContain("最终单文件 HTML 已交付在 artifacts[0].content");
    expect(html).not.toContain("本步骤没有产生新的交付物");
    expect(html).not.toContain("浜や粯浣嶇疆");
  });

  it("localizes common agent report chrome and shows Windows artifact paths in Chinese runs", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-zh",
      companyId: "company-1",
      name: "政治新闻 HTML 自迭代",
      version: 1,
      nodes: [],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-zh",
        companyId: "company-1",
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        blueprintVersion: 1,
        status: "succeeded",
        startedBy: "user-1",
        startedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      },
      nodeRuns: [
        {
          id: "node-run-final",
          blueprintRunId: "run-zh",
          blueprintId: blueprint.id,
          nodeId: "final-html",
          nodeLabel: "最终 HTML 产物 Agent",
          nodeType: "agent",
          iterationRoundId: "round-zh",
          status: "succeeded",
          queuedAt: now,
          startedAt: now,
          endedAt: now,
          output: { humanReportMd: "## Summary\n\nNo filesystem file was created in this read-only node.\n\n## Validation\n\nChecked." }
        }
      ],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [],
      approvalRequests: [],
      approvalDecisions: [],
      artifacts: [
        {
          id: "artifact-final",
          runId: "run-zh",
          roundId: "round-zh",
          nodeRunId: "node-run-final",
          title: "最终 HTML",
          kind: "html",
          storagePath: "D:/HiveWard/artifacts/runs/run-zh/artifact-final.html",
          relativePath: "runs/run-zh/artifact-final.html",
          downloadUrl: "/artifacts/runs/run-zh/artifact-final.html",
          previewPolicy: "sandboxed_iframe",
          trusted: false,
          createdAt: now
        }
      ],
      releaseReports: [],
      agentHumanReports: [
        {
          id: "human-report-final",
          runId: "run-zh",
          roundId: "round-zh",
          nodeRunId: "node-run-final",
          nodeId: "final-html",
          nodeLabel: "最终 HTML 产物 Agent",
          title: "最终 HTML 产物 Agent report",
          bodyMd: "## Decision\n\nRoute to Slot 3.\n\n## Summary\n\nNo filesystem file was created in this read-only node.\n\n## Validation\n\nChecked.",
          source: "agent",
          createdAt: now
        },
        {
          id: "human-report-manager",
          runId: "run-zh",
          roundId: "round-zh",
          nodeRunId: "manager-node-run-manager-decision-3",
          nodeId: "manager",
          nodeLabel: "政治新闻 HTML 自迭代 Manager dispatch 3",
          title: "Manager report",
          bodyMd: "## Manager Routing Decision\n\nRoute to Slot 3.",
          source: "agent",
          createdAt: now
        }
      ],
      agentHandoffs: [],
      managerContextSnapshots: [],
      runTimeline: [
        {
          id: "timeline-artifact",
          runId: "run-zh",
          sequence: 1,
          createdAt: now,
          actorNodeId: "node-run-final",
          actorLabel: "最终 HTML 产物 Agent",
          kind: "artifact_published",
          title: "最终 HTML",
          body: "/artifacts/runs/run-zh/artifact-final.html"
        }
      ],
      managerMail: []
    };

    const html = renderToStaticMarkup(
      <RunsPage
        runs={[runView]}
        blueprints={[blueprint]}
        blueprint={blueprint}
        selectedRunId={runView.run.id}
        language="zh-CN"
        t={messages["zh-CN"]}
        onSelectBlueprint={() => undefined}
        onSelectRun={() => undefined}
      />
    );

    expect(html).toContain("决策");
    expect(html).toContain("摘要");
    expect(html).toContain("验证");
    expect(html).toContain("路由到 Slot 3");
    expect(html).toContain("本节点以只读方式运行");
    expect(html).toContain("政治新闻 HTML 自迭代 Manager · 调度 3");
    expect(html).toContain("D:\\HiveWard\\artifacts\\runs\\run-zh\\artifact-final.html");
    expect(html).toContain("/artifacts/runs/run-zh/artifact-final.html");
  });

  it("falls back to run events and artifacts when timeline projection rows are missing", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-event-fallback",
      companyId: "company-1",
      name: "Event fallback blueprint",
      version: 1,
      nodes: [],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-event-fallback",
        companyId: "company-1",
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        blueprintVersion: 1,
        status: "succeeded",
        startedBy: "user-1",
        startedAt: now,
        endedAt: "2026-05-28T00:00:05.000Z",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      },
      nodeRuns: [],
      events: [
        {
          id: "event-run-started",
          blueprintRunId: "run-event-fallback",
          type: "blueprint.run.started",
          message: "Run started.",
          createdAt: now
        },
        {
          id: "event-run-completed",
          blueprintRunId: "run-event-fallback",
          type: "blueprint.run.completed",
          message: "Run completed.",
          createdAt: "2026-05-28T00:00:05.000Z"
        }
      ],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [],
      approvalRequests: [],
      approvalDecisions: [],
      artifacts: [
        {
          id: "artifact-final-html",
          runId: "run-event-fallback",
          title: "Final HTML",
          kind: "html",
          downloadUrl: "/artifacts/runs/run-event-fallback/final.html",
          previewPolicy: "sandboxed_iframe",
          trusted: false,
          createdAt: "2026-05-28T00:00:04.000Z"
        }
      ],
      releaseReports: [],
      agentHumanReports: [],
      agentHandoffs: [],
      managerContextSnapshots: [],
      runTimeline: [],
      managerMail: []
    };

    const html = renderToStaticMarkup(
      <RunsPage
        runs={[runView]}
        blueprints={[blueprint]}
        blueprint={blueprint}
        selectedRunId={runView.run.id}
        language="en"
        t={messages.en}
        onSelectBlueprint={() => undefined}
        onSelectRun={() => undefined}
      />
    );

    expect(html).toContain("Run completed");
    expect(html).toContain("The run has completed.");
    expect(html).toContain("An artifact was published.");
    expect(html).toContain("/artifacts/runs/run-event-fallback/final.html");
  });

  it("renders run steps from actual chronological node runs without slot boundary cards", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-chronology",
      companyId: "company-1",
      name: "Chronology blueprint",
      version: 1,
      nodes: [
        {
          id: "slot-1",
          type: "manager_slot",
          position: { x: 120, y: 120 },
          config: { label: "Slot 1 - QA", managerNodeId: "manager-1", slot: 1 }
        },
        {
          id: "qa",
          type: "agent",
          runtimeId: "openclaw",
          position: { x: 320, y: 120 },
          parentId: "slot-1",
          config: { label: "QA Agent", agentName: "qa", prompt: "Check the output.", tools: [] }
        }
      ],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-chronology",
        companyId: "company-1",
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        blueprintVersion: 1,
        status: "succeeded",
        startedBy: "user-1",
        startedAt: now,
        endedAt: "2026-05-28T00:00:05.000Z",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      },
      nodeRuns: [
        {
          id: "slot-run",
          blueprintRunId: "run-chronology",
          blueprintId: blueprint.id,
          nodeId: "slot-1",
          nodeLabel: "Slot 1 - QA",
          nodeType: "manager_slot",
          status: "succeeded",
          queuedAt: "2026-05-28T00:00:03.000Z",
          startedAt: "2026-05-28T00:00:03.000Z",
          endedAt: "2026-05-28T00:00:04.000Z",
          output: { status: "complete", reason: "Slot completed." }
        },
        {
          id: "qa-run",
          blueprintRunId: "run-chronology",
          blueprintId: blueprint.id,
          nodeId: "qa",
          nodeLabel: "QA Agent",
          nodeType: "agent",
          status: "succeeded",
          queuedAt: "2026-05-28T00:00:01.000Z",
          startedAt: "2026-05-28T00:00:01.000Z",
          endedAt: "2026-05-28T00:00:02.000Z",
          output: { status: "complete", reason: "QA passed the delivery." }
        }
      ],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [],
      approvalRequests: [],
      approvalDecisions: [],
      artifacts: [],
      releaseReports: [],
      agentHumanReports: [],
      agentHandoffs: [],
      managerContextSnapshots: [],
      runTimeline: [],
      managerMail: []
    };

    const html = renderToStaticMarkup(
      <RunsPage
        runs={[runView]}
        blueprints={[blueprint]}
        blueprint={blueprint}
        selectedRunId={runView.run.id}
        language="en"
        t={messages.en}
        onSelectBlueprint={() => undefined}
        onSelectRun={() => undefined}
      />
    );

    expect(html).toMatch(/trace-issue-index">1<\/div><div class="trace-issue-main"><div class="trace-issue-topline"><strong>QA Agent<\/strong>/);
    expect(html).toContain("QA passed the delivery.");
    expect(html).not.toMatch(/trace-issue-topline"><strong>Slot 1 - QA<\/strong>/);
    expect(html).not.toContain("Manager input entered this slot.");
  });

  it("renders self-iteration preflight lifecycle as run steps before node runs exist", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-preflight",
      companyId: "company-1",
      name: "Preflight blueprint",
      version: 1,
      nodes: [],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-preflight",
        companyId: "company-1",
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        blueprintVersion: 1,
        status: "running",
        startedBy: "user-1",
        startedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      },
      nodeRuns: [],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [
        {
          id: "round-preflight-1",
          sessionId: "session-preflight-1",
          runId: "run-preflight",
          roundNumber: 1,
          status: "requirement_pending",
          artifactIds: [],
          startedAt: now
        }
      ],
      approvalRequests: [],
      approvalDecisions: [],
      artifacts: [],
      releaseReports: [],
      agentHumanReports: [],
      agentHandoffs: [],
      managerContextSnapshots: [],
      runTimeline: [
        {
          id: "timeline-round-started",
          runId: "run-preflight",
          sequence: 1,
          createdAt: now,
          actorNodeId: "manager-1",
          actorLabel: "Top Manager",
          kind: "round_started",
          title: "Round 1 started"
        }
      ],
      managerMail: []
    };

    const html = renderToStaticMarkup(
      <RunsPage
        runs={[runView]}
        blueprints={[blueprint]}
        blueprint={blueprint}
        selectedRunId={runView.run.id}
        language="zh-CN"
        t={messages["zh-CN"]}
        onSelectBlueprint={() => undefined}
        onSelectRun={() => undefined}
      />
    );

    expect(html).toContain("第 1 轮启动");
    expect(html).toContain("Manager 正在准备第 1 轮计划");
    expect(html).toContain("调研、提需和计划整理都属于运行步骤。");
    expect(html).not.toContain(messages["zh-CN"].empty.noRunHistory);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalThread, BlueprintDefinition, BlueprintRunView, PendingApprovalItem } from "@hiveward/shared";
import { messages } from "../lib/i18n";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ApprovalsPage, buildCurrentOutputDisplayBody, CompanyDirectoryPage, RunsPage, shouldAwaitApprovalHarnessReply } from "./WorkspacePages";

describe("CompanyDirectoryPage", () => {
  it("renders the add-company action without the external Plus icon component", () => {
    const html = renderToStaticMarkup(
      <CompanyDirectoryPage
        companies={[]}
        language="en"
        busy={false}
        onEnterCompany={() => undefined}
        onCreateCompany={async () => undefined}
        onUpdateCompany={async () => undefined}
        onDeleteCompany={() => undefined}
      />
    );

    expect(html).toContain("Add company");
    expect(html).toContain("local-add-icon");
  });
});

function createPendingApproval(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    approvalRequestId: "request-1",
    approvalThreadId: "thread-1",
    kind: "agent_proposal",
    blueprintId: "blueprint-1",
    blueprintName: "Blueprint 1",
    blueprintRunId: "run-1",
    nodeRunId: "node-run-1",
    nodeId: "agent-1",
    nodeLabel: "Review",
    startedBy: "tester",
    startedAt: "2026-05-21T01:00:00.000Z",
    requestedAt: "2026-05-21T01:02:00.000Z",
    status: "pending",
    reviewOutput: "body",
    canApprove: true,
    canReject: true,
    canReply: true,
    canComplete: false,
    canTerminate: false,
    ...overrides
  };
}

describe("ApprovalsPage", () => {
  it("groups approval rows by stable approval thread id", () => {
    const approvals = [
      createPendingApproval({
        approvalRequestId: "request-v1",
        approvalThreadId: "thread-1",
        nodeRunId: "node-run-v1",
        nodeLabel: "Review v1",
        requestedAt: "2026-05-21T01:02:00.000Z",
        reviewOutput: "old body"
      }),
      createPendingApproval({
        approvalRequestId: "request-v2",
        approvalThreadId: "thread-1",
        nodeRunId: "node-run-v2",
        nodeLabel: "Review v2",
        requestedAt: "2026-05-21T01:04:00.000Z",
        reviewOutput: "current body"
      })
    ];
    const approvalThreads: ApprovalThread[] = [
      {
        id: "thread-1",
        kind: "agent_proposal",
        status: "open",
        title: "Review thread",
        runId: "run-1",
        nodeRunId: "node-run-v2",
        currentRequestId: "request-v2",
        currentRevision: 2,
        capabilities: { approve: true, reject: true, reply: true, complete: false, terminate: false },
        createdAt: "2026-05-21T01:02:00.000Z",
        updatedAt: "2026-05-21T01:04:00.000Z"
      }
    ];

    const html = renderToStaticMarkup(
      <ApprovalsPage
        approvals={approvals}
        approvalThreads={approvalThreads}
        inboxItems={[]}
        language="en"
        t={messages.en}
        onApprove={() => undefined}
        onApproveApprovalRequest={() => undefined}
        onComplete={() => undefined}
        onReject={() => undefined}
        onRejectApprovalRequest={() => undefined}
        onReply={() => undefined}
        onReplyApprovalRequest={() => undefined}
        onRequestChangesApprovalRequest={() => undefined}
        onReviseApprovalRequest={() => undefined}
        onSelectApprovalReply={() => undefined}
        onReplyInboxItem={() => undefined}
        onApproveInboxItem={() => undefined}
        onRejectInboxItem={() => undefined}
      />
    );

    expect(html).toContain("Review v2");
    expect(html).toContain("current body");
    expect(html).not.toContain("Review v1");
    expect(html).not.toContain("old body");
  });

  it("renders comment and explicit change-request actions as separate controls", () => {
    const html = renderToStaticMarkup(
      <ApprovalsPage
        approvals={[createPendingApproval({
          canRequestChanges: true,
          canRevise: false
        } as Partial<PendingApprovalItem>)]}
        approvalThreads={[]}
        inboxItems={[]}
        language="en"
        t={messages.en}
        onApprove={() => undefined}
        onApproveApprovalRequest={() => undefined}
        onComplete={() => undefined}
        onReject={() => undefined}
        onRejectApprovalRequest={() => undefined}
        onReply={() => undefined}
        onReplyApprovalRequest={() => undefined}
        onRequestChangesApprovalRequest={() => undefined}
        onReviseApprovalRequest={() => undefined}
        onSelectApprovalReply={() => undefined}
        onReplyInboxItem={() => undefined}
        onApproveInboxItem={() => undefined}
        onRejectInboxItem={() => undefined}
      />
    );

    expect(html).toContain("Comment");
    expect(html).toContain("Request changes");
    expect(html).not.toMatch(/reply with changes/i);
  });

  it("approval action disables approve button while request is pending", () => {
    const html = renderToStaticMarkup(
      <ApprovalsPage
        approvals={[createPendingApproval()]}
        approvalThreads={[]}
        inboxItems={[]}
        language="en"
        t={messages.en}
        actionPending
        onApprove={() => undefined}
        onApproveApprovalRequest={() => undefined}
        onComplete={() => undefined}
        onReject={() => undefined}
        onRejectApprovalRequest={() => undefined}
        onReply={() => undefined}
        onReplyApprovalRequest={() => undefined}
        onRequestChangesApprovalRequest={() => undefined}
        onReviseApprovalRequest={() => undefined}
        onSelectApprovalReply={() => undefined}
        onReplyInboxItem={() => undefined}
        onApproveInboxItem={() => undefined}
        onRejectInboxItem={() => undefined}
      />
    );

    expect(extractButtonByAriaLabel(html, "Approve")).toContain("disabled");
  });

  it("processed approval keeps the discussion composer while disabling lifecycle actions", () => {
    const html = renderToStaticMarkup(
      <ApprovalsPage
        approvals={[createPendingApproval({
          status: "approved",
          canApprove: false,
          canReject: false,
          canReply: false,
          canComplete: false,
          canRequestChanges: false,
          canRevise: false
        })]}
        approvalThreads={[]}
        inboxItems={[]}
        language="en"
        t={messages.en}
        onApprove={() => undefined}
        onApproveApprovalRequest={() => undefined}
        onComplete={() => undefined}
        onReject={() => undefined}
        onRejectApprovalRequest={() => undefined}
        onReply={() => undefined}
        onReplyApprovalRequest={() => undefined}
        onRequestChangesApprovalRequest={() => undefined}
        onReviseApprovalRequest={() => undefined}
        onSelectApprovalReply={() => undefined}
        onReplyInboxItem={() => undefined}
        onApproveInboxItem={() => undefined}
        onRejectInboxItem={() => undefined}
      />
    );

    expect(extractButtonByAriaLabel(html, "Approve")).toContain("disabled");
    expect(html).toContain("Add a comment; comments do not change the workflow.");
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  it("does not wait for a harness reply for request-backed approval comments", () => {
    const legacyApproval = createPendingApproval({ kind: "agent_proposal" });
    delete legacyApproval.approvalRequestId;
    expect(shouldAwaitApprovalHarnessReply(createPendingApproval({
      approvalRequestId: "request-backed",
      kind: "agent_proposal"
    }))).toBe(false);
    expect(shouldAwaitApprovalHarnessReply(legacyApproval)).toBe(true);
  });
});

function extractButtonByAriaLabel(html: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<button[^>]+aria-label="${escaped}"[^>]*>`));
  if (!match) throw new Error(`Button with aria-label "${label}" was not rendered.`);
  return match[0];
}

describe("RunsPage", () => {
  it("renders structured artifact links with clean titles", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer value="- [页面预览](/artifacts/structured/preview.html)" />
    );

    expect(html).toContain('href="/artifacts/structured/preview.html"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("页面预览");
    expect(html).not.toContain("artifacts[0]");
  });

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

    expect(html.indexOf("Current output")).toBeLessThan(html.indexOf("Artifacts"));
    expect(html.indexOf("Artifacts")).toBeLessThan(html.indexOf("Round Report"));
    expect(html).not.toContain("Round Execution Plan");
    expect(html).not.toContain("Agent Markdown reports");
    expect(html).not.toContain("Run Advanced Details");
    expect(html).toContain("Manager summary from reports.");
    expect(html).toContain("Readable artifact");
    expect(html).not.toContain("SECRET_RAW_OUTPUT");
    expect(html).not.toContain("machine-only");
  });

  it("structures current output as fixed concise sections", () => {
    const longBody = "我已经检查了现有页面、整理了用户真正关心的判断顺序，并把可读结论放在前面。".repeat(8);
    const body = [
      "## 交付位置",
      "",
      "本步骤没有产生新的交付物。",
      "",
      "## 执行说明",
      "",
      longBody
    ].join("\n");

    const output = buildCurrentOutputDisplayBody({
      bodyMd: body,
      artifacts: [
        {
          id: "artifact-structured",
          runId: "run-structured",
          title: "页面预览",
          kind: "html",
          downloadUrl: "/artifacts/structured/preview.html",
          previewPolicy: "sandboxed_iframe",
          trusted: false,
          createdAt: "2026-05-28T00:00:00.000Z"
        }
      ],
      language: "zh-CN",
      actorKind: "agent"
    });

    expect(output.indexOf("## 🧾 摘要")).toBeLessThan(output.indexOf("## 📍 交付位置"));
    expect(output.indexOf("## 📍 交付位置")).toBeLessThan(output.indexOf("## 📦 产物"));
    expect(output.indexOf("## 📦 产物")).toBeLessThan(output.indexOf("## ✍️ Agent 自由输出"));
    const summary = output.match(/## 🧾 摘要\n\n([\s\S]*?)\n\n## 📍 交付位置/)?.[1] ?? "";
    expect(summary).toBe("无");
    const delivery = output.match(/## 📍 交付位置\n\n([\s\S]*?)\n\n## 📦 产物/)?.[1] ?? "";
    const artifactSummary = output.match(/## 📦 产物\n\n([\s\S]*?)\n\n## 执行说明/)?.[1] ?? "";
    expect(delivery).toContain("/artifacts/structured/preview.html");
    expect(delivery).toContain("[/artifacts/structured/preview.html](/artifacts/structured/preview.html)");
    expect(artifactSummary).toContain("[页面预览](/artifacts/structured/preview.html)");
    expect(artifactSummary).not.toContain("artifacts[0]");
    expect(output).toContain(longBody);

    const coveredOutput = buildCurrentOutputDisplayBody({
      bodyMd: [
        "## 交付位置",
        "",
        "- 页面预览: /artifacts/structured/preview.html",
        "",
        "## 执行说明",
        "",
        "我已经把交付物写清楚了。"
      ].join("\n"),
      artifacts: [
        {
          id: "artifact-structured",
          runId: "run-structured",
          title: "页面预览",
          kind: "html",
          downloadUrl: "/artifacts/structured/preview.html",
          previewPolicy: "sandboxed_iframe",
          trusted: false,
          createdAt: "2026-05-28T00:00:00.000Z"
        }
      ],
      language: "zh-CN",
      actorKind: "agent"
    });
    expect(coveredOutput).toContain("## 📦 产物\n\n- [页面预览](/artifacts/structured/preview.html)");
    expect(coveredOutput).not.toContain("artifacts[0]: 页面预览");

    const managerOutput = buildCurrentOutputDisplayBody({
      bodyMd: "",
      artifacts: [],
      language: "zh-CN",
      actorKind: "manager",
      reason: "previousResults 为空，所以继续派发到需求分析 Agent。"
    });
    expect(managerOutput).toContain("## 🧭 调度原因\n\npreviousResults 为空，所以继续派发到需求分析 Agent。");
    expect(managerOutput.indexOf("## 🧭 调度原因")).toBeLessThan(managerOutput.indexOf("## ✍️ Manager 自由输出"));
    expect(managerOutput).toContain("## 🧾 摘要\n\n无");
    expect(managerOutput).toContain("## 📍 交付位置\n\n无");
    expect(managerOutput).toContain("## 📦 产物\n\n无");
    expect(managerOutput).toContain("## ✍️ Manager 自由输出\n\n无");
  });

  it("shows the agent-written summary verbatim and removes it from free output", () => {
    const agentSummary = "已完成单文件 HTML 页面，页面能展示需求分析结果、Manager 自分发说明和等待 QA 的状态，并通过醒目的状态卡片让用户快速理解当前交付内容。";
    const longAgentSummary = `${agentSummary}这句超过上限的补充说明仍然应该原样显示，因为字数要求由 Agent 提示词约束，前端不替 Agent 截断或改写。`;
    const output = buildCurrentOutputDisplayBody({
      bodyMd: [
        "## 摘要",
        "",
        longAgentSummary,
        "",
        "## 交付位置",
        "",
        "- 本地文件: /tmp/hiveward/page.html",
        "",
        "## 制作报告",
        "",
        "页面已经写入文件，并声明为 HTML 产物。"
      ].join("\n"),
      artifacts: [],
      language: "zh-CN",
      actorKind: "agent"
    });

    const summary = output.match(/## 🧾 摘要\n\n([\s\S]*?)\n\n## 📍 交付位置/)?.[1] ?? "";
    expect(summary).toBe(longAgentSummary);
    const freeOutput = output.match(/## ✍️ Agent 自由输出\n\n([\s\S]*)$/)?.[1] ?? "";
    expect(freeOutput).not.toContain(agentSummary);
    expect(output.indexOf("## 制作报告")).toBeLessThan(output.indexOf("## ✍️ Agent 自由输出"));
    expect(output).toContain("页面已经写入文件");
    expect(freeOutput).toBe("无");
  });

  it("uses only recorded artifacts for the structured artifact section", () => {
    const output = buildCurrentOutputDisplayBody({
      bodyMd: [
        "## 摘要",
        "",
        "已根据需求分析回执制作一个单文件 HTML 测试页面。",
        "",
        "## 交付位置",
        "",
        "artifacts[0]：自分发测试页面。运行界面应能点击打开该 HTML artifact，并以 sandboxed_iframe 方式预览。",
        "",
        "## 制作说明",
        "",
        "页面使用内联 CSS，不依赖外部资源。"
      ].join("\n"),
      artifacts: [
        {
          id: "artifact-html-self-dispatch-test-page",
          runId: "run-self-dispatch",
          nodeRunId: "node-run-page",
          title: "自分发测试页面",
          kind: "html",
          storagePath: "/Users/zhangye/Documents/hiveward/data/artifacts/objects/sha256/88/page.html",
          downloadUrl: "/artifacts/objects/sha256/88/page.html",
          previewPolicy: "sandboxed_iframe",
          trusted: false,
          createdAt: "2026-05-30T00:00:00.000Z"
        }
      ],
      language: "zh-CN",
      actorKind: "agent"
    });

    const delivery = output.match(/## 📍 交付位置\n\n([\s\S]*?)\n\n## 📦 产物/)?.[1] ?? "";
    const artifacts = output.match(/## 📦 产物\n\n([\s\S]*?)\n\n## 制作说明/)?.[1] ?? "";
    const freeOutput = output.match(/## ✍️ Agent 自由输出\n\n([\s\S]*)$/)?.[1] ?? "";

    expect(delivery).toContain("/Users/zhangye/Documents/hiveward/data/artifacts/objects/sha256/88/page.html");
    expect(delivery).toContain("/artifacts/objects/sha256/88/page.html");
    expect(delivery).not.toContain("artifacts[0]");
    expect(artifacts).toContain("[自分发测试页面](/artifacts/objects/sha256/88/page.html)");
    expect(artifacts).not.toContain("artifacts[0]");
    expect(artifacts).not.toContain("运行界面应能点击打开该 HTML artifact");
    expect(output.indexOf("## 制作说明")).toBeLessThan(output.indexOf("## ✍️ Agent 自由输出"));
    expect(freeOutput).toBe("无");
  });

  it("does not turn agent-written artifact prose into structured artifacts", () => {
    const output = buildCurrentOutputDisplayBody({
      bodyMd: [
        "## 摘要",
        "",
        "已完成页面说明。",
        "",
        "## 产物",
        "",
        "- artifacts[0]: 页面预览 (/artifacts/from-body.html)",
        "",
        "## 制作说明",
        "",
        "Agent 在正文里写了产物描述，但没有填 artifacts 字段。"
      ].join("\n"),
      artifacts: [],
      language: "zh-CN",
      actorKind: "agent"
    });

    const artifacts = output.match(/## 📦 产物\n\n([\s\S]*?)\n\n## 制作说明/)?.[1] ?? "";
    expect(artifacts).toBe("无");
    expect(output).not.toContain("artifacts[0]: 页面预览");
    expect(output).not.toContain("/artifacts/from-body.html");
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

    expect(html).toContain("Delivery location");
    expect(html).toContain("None");
    expect(html).not.toContain("D:/HiveWard/raw-only.html");
    expect(html).not.toContain('href="D:/HiveWard/raw-only.html"');
  });

  it("does not treat Chinese delivery prose as a structured deliverable when artifacts are missing", () => {
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
    expect(html).toContain("<h2><span>📍 交付位置</span></h2><p><span>无</span></p>");
    expect(html).toContain("<h2><span>📦 产物</span></h2><p><span>无</span></p>");
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
    expect(html).toContain("<strong>政治新闻 HTML 自迭代 Manager</strong>");
    expect(html).toContain("D:\\HiveWard\\artifacts\\runs\\run-zh\\artifact-final.html");
    expect(html).toContain("/artifacts/runs/run-zh/artifact-final.html");
  });

  it("falls back to artifacts without showing system-only completion cards", () => {
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

    expect(html).not.toContain("Run completed");
    expect(html).not.toContain("The run has completed.");
    expect(html).not.toContain("An artifact was published.");
    expect(html).toContain("Final HTML");
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

    expect(html).toMatch(/trace-actor-title.*<strong>QA Agent<\/strong>/s);
    expect(html).toContain("QA passed the delivery.");
    expect(html).not.toMatch(/trace-actor-title.*<strong>Slot 1 - QA<\/strong>/s);
    expect(html).not.toContain("Manager input entered this slot.");
  });

  it("renders employee work cards with round ribbons, work tags, and bottom-right time", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-work-card",
      companyId: "company-1",
      name: "Work card blueprint",
      version: 1,
      nodes: [
        {
          id: "requirements-agent",
          type: "agent",
          runtimeId: "codex",
          position: { x: 320, y: 120 },
          config: { label: "需求分析 Agent", agentName: "requirements", prompt: "整理需求。", tools: [] }
        },
        {
          id: "manager",
          type: "manager",
          position: { x: 120, y: 120 },
          config: { label: "自分发测试 Manager", portCount: 1, maxHandoffs: 4 }
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
        id: "run-work-card",
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
          id: "preflight-research_resolution-round-1-manager",
          blueprintRunId: "run-work-card",
          blueprintId: blueprint.id,
          nodeId: "manager",
          nodeLabel: "自分发测试 Manager",
          nodeType: "manager",
          iterationRoundId: "round-1",
          status: "succeeded",
          queuedAt: "2026-05-28T00:00:00.500Z",
          startedAt: "2026-05-28T00:00:00.500Z",
          endedAt: "2026-05-28T00:00:00.900Z",
          output: { status: "complete" }
        },
        {
          id: "requirements-run",
          blueprintRunId: "run-work-card",
          blueprintId: blueprint.id,
          nodeId: "requirements-agent",
          nodeLabel: "需求分析 Agent",
          nodeType: "agent",
          iterationRoundId: "round-1",
          status: "succeeded",
          queuedAt: "2026-05-28T00:00:01.000Z",
          startedAt: "2026-05-28T00:00:01.000Z",
          endedAt: "2026-05-28T00:00:02.000Z",
          output: { status: "complete", reason: "我整理了页面制作需求，明确标题、说明文字和验收标准。第二句话不应该进入小卡片。" }
        },
        {
          id: "manager-dispatch-run",
          blueprintRunId: "run-work-card",
          blueprintId: blueprint.id,
          nodeId: "manager",
          nodeLabel: "自分发测试 Manager · 调度 3",
          nodeType: "manager",
          iterationRoundId: "round-1",
          status: "succeeded",
          queuedAt: "2026-05-28T00:00:04.000Z",
          startedAt: "2026-05-28T00:00:04.000Z",
          endedAt: "2026-05-28T00:00:05.000Z",
          output: { status: "complete", reason: "Manager 已完成调度。" }
        }
      ],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [
        {
          id: "round-1",
          sessionId: "session-1",
          runId: "run-work-card",
          roundNumber: 1,
          status: "executing",
          artifactIds: [],
          startedAt: now
        }
      ],
      approvalRequests: [],
      approvalDecisions: [],
      artifacts: [
        {
          id: "artifact-preview",
          runId: "run-work-card",
          roundId: "round-1",
          nodeRunId: "requirements-run",
          title: "页面预览",
          kind: "html",
          downloadUrl: "/artifacts/runs/run-work-card/preview.html",
          previewPolicy: "sandboxed_iframe",
          trusted: false,
          createdAt: "2026-05-28T00:00:03.500Z"
        }
      ],
      releaseReports: [],
      agentHandoffs: [],
      managerContextSnapshots: [],
      runTimeline: [
        {
          id: "timeline-requirements-output",
          runId: "run-work-card",
          sequence: 1,
          createdAt: "2026-05-28T00:00:03.000Z",
          actorNodeId: "requirements-agent",
          actorLabel: "需求分析 Agent",
          kind: "node_output",
          title: "需求分析 Agent: requirement planning completed",
          body: "Requirement planning is complete.",
          payloadRef: "requirements-run"
        },
        {
          id: "timeline-artifact",
          runId: "run-work-card",
          sequence: 2,
          createdAt: "2026-05-28T00:00:03.500Z",
          actorNodeId: "requirements-run",
          actorLabel: "页面预览",
          kind: "artifact_published",
          title: "页面预览",
          body: "/artifacts/runs/run-work-card/preview.html",
          payloadRef: "artifact-preview"
        }
      ],
      agentHumanReports: [
        {
          id: "requirements-report",
          runId: "run-work-card",
          roundId: "round-1",
          nodeRunId: "requirements-run",
          nodeId: "requirements-agent",
          nodeLabel: "需求分析 Agent",
          title: "需求分析 Agent report",
          bodyMd: "## 交付位置\n本步骤没有产生新的交付物。\n\n## 需求摘要\n我整理了页面制作需求，明确标题、说明文字和验收标准。第二句话不应该进入小卡片。",
          source: "agent",
          createdAt: "2026-05-28T00:00:02.000Z"
        },
        {
          id: "manager-research-report",
          runId: "run-work-card",
          roundId: "round-1",
          nodeRunId: "preflight-research_resolution-round-1-manager",
          nodeId: "manager",
          nodeLabel: "自分发测试 Manager",
          title: "Manager research report",
          bodyMd: "## 交付位置\n本步骤没有产生新的交付物。\n\n## 调研判断\n我调研了当前上下文，确认需要先让需求分析 Agent 提需。",
          source: "agent",
          createdAt: "2026-05-28T00:00:00.900Z"
        },
        {
          id: "manager-decision-report",
          runId: "run-work-card",
          roundId: "round-1",
          nodeRunId: "manager-dispatch-run-manager-decision-1",
          nodeId: "manager",
          nodeLabel: "自分发测试 Manager · 调度 1",
          title: "Manager dispatch report",
          bodyMd: "Manager 派发给页面制作 Agent。",
          source: "agent",
          createdAt: "2026-05-28T00:00:04.500Z"
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

    expect(html).toContain("trace-round-ribbon");
    expect(html).toContain("第一轮");
    expect(html).toContain("trace-role-icon");
    expect(html).toContain("trace-role-manager");
    expect(html).toContain("trace-role-agent");
    expect(html).toContain("lucide-bot-message-square");
    expect(html).toContain("lucide-bot");
    expect(html).not.toContain("lucide-git-branch");
    const issueCards = html.match(/<button type="button" class="trace-issue-card[\s\S]*?<\/button>/g) ?? [];
    const issueCardsHtml = issueCards.join("");
    expect(issueCardsHtml).toContain("需求分析 Agent");
    expect(issueCardsHtml.match(/<strong>需求分析 Agent<\/strong>/g)).toHaveLength(1);
    expect(issueCardsHtml).not.toContain("<strong>需求分析 Agent: requirement planning completed</strong>");
    expect(issueCardsHtml).not.toContain("该步骤已经产生输出。");
    expect(issueCardsHtml).toContain("<strong>自分发测试 Manager</strong>");
    expect(issueCardsHtml).not.toContain("<strong>自分发测试 Manager · 调度 3</strong>");
    expect(issueCardsHtml).not.toContain("Manager 已完成调度。");
    expect(issueCardsHtml).not.toContain("<strong>页面预览</strong>");
    expect(issueCardsHtml).not.toContain("trace-work-tag-artifact");
    expect(html).toContain("/artifacts/runs/run-work-card/preview.html");
    expect(html).toContain("Manager 派发给页面制作 Agent。");
    expect(html).toContain("trace-status-chip trace-completed");
    const requirementsCardHtml = issueCards.find((card) => card.includes("<strong>需求分析 Agent</strong>")) ?? "";
    expect(requirementsCardHtml).toContain("我整理了页面制作需求，明确标题、说明文字和验收标准。");
    expect(requirementsCardHtml).not.toContain("第二句话不应该进入小卡片。");
    expect(html).toContain("trace-work-tag");
    expect(issueCardsHtml).toContain('<span class="trace-role-tag trace-role-tag-manager">Manager</span>');
    expect(issueCardsHtml).toContain('<span class="trace-role-tag trace-role-tag-agent">Agent</span>');
    expect(issueCardsHtml).toContain('<span class="trace-work-tag trace-work-tag-research">调研</span>');
    expect(issueCardsHtml).toContain('<span class="trace-work-tag trace-work-tag-requirements">提需</span>');
    expect(issueCardsHtml).toContain('<span class="trace-work-tag trace-work-tag-dispatch">调度</span>');
    const managerResearchCardHtml = issueCards.find((card) => card.includes("我调研了当前上下文")) ?? "";
    expect(managerResearchCardHtml).toContain('<span class="trace-role-tag trace-role-tag-manager">Manager</span>');
    expect(managerResearchCardHtml).toContain('<span class="trace-work-tag trace-work-tag-research">调研</span>');
    expect(managerResearchCardHtml).not.toContain("本步骤没有产生新的交付物。");
    expect(issueCardsHtml).not.toContain('<span class="trace-work-tag">需求规划</span>');
    expect(issueCardsHtml).not.toContain('<span class="trace-work-tag">计划准备</span>');
    expect(issueCardsHtml).not.toContain('<span class="trace-work-tag">计划校验</span>');
    expect(html).toContain("trace-issue-time");
    expect(html).toMatch(/trace-issue-time[^>]*dateTime="2026-05-28T00:00:01\.000Z"/);
  });

  it("restores context-sufficient round research as a Manager research step before requirements", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-context-research",
      companyId: "company-1",
      name: "Context research blueprint",
      version: 1,
      nodes: [
        {
          id: "manager",
          type: "manager",
          position: { x: 120, y: 120 },
          config: { label: "自分发测试 Manager", portCount: 1, maxHandoffs: 4 }
        },
        {
          id: "requirements-agent",
          type: "agent",
          runtimeId: "codex",
          position: { x: 320, y: 120 },
          config: { label: "需求分析 Agent", agentName: "requirements", prompt: "整理需求。", tools: [] }
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
        id: "run-context-research",
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
      nodeRuns: [
        {
          id: "round-2-requirements",
          blueprintRunId: "run-context-research",
          blueprintId: blueprint.id,
          nodeId: "requirements-agent",
          nodeLabel: "需求分析 Agent",
          nodeType: "agent",
          iterationRoundId: "round-2",
          status: "running",
          queuedAt: "2026-05-28T00:01:01.000Z",
          startedAt: "2026-05-28T00:01:01.000Z",
          output: undefined
        }
      ],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [
        {
          id: "round-1",
          sessionId: "session-1",
          runId: "run-context-research",
          roundNumber: 1,
          status: "completed",
          artifactIds: [],
          startedAt: now,
          endedAt: "2026-05-28T00:01:00.000Z"
        },
        {
          id: "round-2",
          sessionId: "session-1",
          runId: "run-context-research",
          roundNumber: 2,
          status: "requirement_pending",
          artifactIds: [],
          researchStatus: "context_sufficient",
          researchSummary: "上一轮 Manager 记忆已经覆盖页面标题、说明文字和彩色状态卡片验收标准。",
          planSource: "agent_generated",
          startedAt: "2026-05-28T00:01:00.000Z"
        }
      ],
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
        language="zh-CN"
        t={messages["zh-CN"]}
        onSelectBlueprint={() => undefined}
        onSelectRun={() => undefined}
      />
    );

    const issueCards: string[] = html.match(/<button type="button" class="trace-issue-card[\s\S]*?<\/button>/g) ?? [];
    const restoredResearchCard = issueCards.find((card) => card.includes("已复用上一轮上下文，判断不需要额外调研。")) ?? "";
    const requirementsCard = issueCards.find((card) => card.includes("<strong>需求分析 Agent</strong>")) ?? "";

    expect(restoredResearchCard).toContain("<strong>自分发测试 Manager</strong>");
    expect(restoredResearchCard).toContain('<span class="trace-work-tag trace-work-tag-research">调研</span>');
    expect(restoredResearchCard).toContain("第二轮");
    expect(restoredResearchCard).toContain('dateTime="2026-05-28T00:01:00.000Z"');
    expect(requirementsCard).toContain("<strong>需求分析 Agent</strong>");
    expect(issueCards.indexOf(restoredResearchCard)).toBeLessThan(issueCards.indexOf(requirementsCard));
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

    expect(html).not.toContain("第 1 轮启动");
    expect(html).not.toContain("Manager 正在准备第 1 轮计划");
    expect(html).toContain(messages["zh-CN"].empty.noRunHistory);
  });

  it("shows pending plan approval instead of internal preflight judgment output", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-plan-approval",
      companyId: "company-1",
      name: "自分发测试",
      version: 1,
      nodes: [{
        id: "manager",
        type: "manager",
        position: { x: 120, y: 120 },
        config: { label: "自分发测试 Manager", portCount: 1, maxHandoffs: 4 }
      }],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-plan-approval",
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
          id: "preflight-research_resolution-round-1-manager",
          blueprintRunId: "run-plan-approval",
          blueprintId: blueprint.id,
          nodeId: "manager",
          nodeLabel: "自分发测试 Manager",
          nodeType: "manager",
          iterationRoundId: "round-1",
          status: "succeeded",
          queuedAt: now,
          startedAt: now,
          endedAt: now,
          output: "当前输入只包含蓝图说明与第一轮上下文，没有看到需要额外调研的未知项。"
        },
        {
          id: "preflight-requirement_resolution-round-1-manager",
          blueprintRunId: "run-plan-approval",
          blueprintId: blueprint.id,
          nodeId: "manager",
          nodeLabel: "自分发测试 Manager",
          nodeType: "manager",
          iterationRoundId: "round-1",
          status: "succeeded",
          queuedAt: "2026-05-28T00:01:00.000Z",
          startedAt: "2026-05-28T00:01:00.000Z",
          endedAt: "2026-05-28T00:01:00.000Z",
          output: "制作一个单文件 HTML 测试页面。"
        },
        {
          id: "preflight-preflight_judgment-round-1-manager",
          blueprintRunId: "run-plan-approval",
          blueprintId: blueprint.id,
          nodeId: "manager",
          nodeLabel: "自分发测试 Manager",
          nodeType: "manager",
          iterationRoundId: "round-1",
          status: "succeeded",
          queuedAt: "2026-05-28T00:02:00.000Z",
          startedAt: "2026-05-28T00:02:00.000Z",
          endedAt: "2026-05-28T00:02:00.000Z",
          output: {
            humanReportMd: "draftPlan 已经给出清晰、可执行的页面需求与验收要点，没有需要额外研究的未知项；同时本节点只是预检判断，不派发 worker 槽位、不宣布完成。",
            result: { needsMoreResearch: false }
          }
        }
      ],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [{
        id: "round-1",
        sessionId: "session-1",
        runId: "run-plan-approval",
        roundNumber: 1,
        status: "requirement_pending",
        requirementRequestId: "approval-plan-1",
        artifactIds: [],
        startedAt: now
      }],
      approvalRequests: [{
        id: "approval-plan-1",
        runId: "run-plan-approval",
        roundId: "round-1",
        kind: "iteration_requirement_plan",
        title: "Round 1 Execution Plan",
        body: "# Round 1 Execution Plan\n\n## Plan\n制作一个单文件 HTML 测试页面。",
        status: "pending",
        requestedBy: { type: "node", label: "自分发测试 Manager", nodeId: "manager" },
        capabilities: { approve: true, reject: true, reply: true, complete: false, terminate: false },
        requestedAt: "2026-05-28T00:03:00.000Z",
        revision: 1
      }],
      approvalDecisions: [],
      artifacts: [],
      releaseReports: [],
      agentHumanReports: [],
      agentHandoffs: [],
      managerContextSnapshots: [],
      runTimeline: [{
        id: "timeline-plan",
        runId: "run-plan-approval",
        sequence: 1,
        createdAt: "2026-05-28T00:03:00.000Z",
        actorNodeId: "manager",
        actorLabel: "自分发测试 Manager",
        kind: "requirement_published",
        title: "Round 1 Execution Plan",
        body: "# Round 1 Execution Plan\n\n## Plan\n制作一个单文件 HTML 测试页面。"
      }],
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

    expect(html).toContain("待审批");
    expect(html).toContain("计划确认");
    expect(html).toContain("前期准备工作已经完成");
    expect(html).toContain("确认后会开始后续 Agent 工作");
    expect(html).not.toContain("draftPlan");
    expect(html).not.toContain("不派发 worker 槽位");
  });

  it("uses manager output roundNumber instead of guessing or report roundId", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-manager-round",
      companyId: "company-1",
      name: "自分发测试",
      version: 1,
      nodes: [{
        id: "manager",
        type: "manager",
        position: { x: 120, y: 120 },
        config: { label: "自分发测试 Manager", portCount: 1, maxHandoffs: 4 }
      }],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-manager-round",
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
      nodeRuns: [],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [
        {
          id: "round-1",
          sessionId: "session-1",
          runId: "run-manager-round",
          roundNumber: 1,
          status: "completed",
          artifactIds: [],
          startedAt: now,
          endedAt: "2026-05-28T00:01:00.000Z"
        },
        {
          id: "round-2",
          sessionId: "session-1",
          runId: "run-manager-round",
          roundNumber: 2,
          status: "executing",
          artifactIds: [],
          startedAt: "2026-05-28T00:02:00.000Z"
        }
      ],
      approvalRequests: [],
      approvalDecisions: [],
      artifacts: [],
      releaseReports: [],
      agentHumanReports: [{
        id: "manager-report-round-2",
        runId: "run-manager-round",
        roundId: "round-1",
        managerRoundNumber: 2,
        nodeRunId: "manager-run-manager-decision-2",
        nodeId: "manager",
        nodeLabel: "自分发测试 Manager · 调度 2",
        title: "Manager dispatch report",
        bodyMd: "上一轮参考：Round 1 Execution Plan v1\n\nManager 已经开始第二轮调度。",
        source: "agent",
        createdAt: "2026-05-28T00:03:00.000Z"
      }],
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

    const issueCards: string[] = html.match(/<button type="button" class="trace-issue-card[\s\S]*?<\/button>/g) ?? [];
    const managerCard = issueCards.find((card) => card.includes("自分发测试 Manager")) ?? "";

    expect(managerCard).toContain("第二轮");
    expect(managerCard).not.toContain("第一轮");
  });

  it("marks manager report round as incomplete instead of guessing from text or ids", () => {
    const now = "2026-05-28T00:00:00.000Z";
    const blueprint: BlueprintDefinition = {
      id: "blueprint-manager-missing-round",
      companyId: "company-1",
      name: "自分发测试",
      version: 1,
      nodes: [{
        id: "manager",
        type: "manager",
        position: { x: 120, y: 120 },
        config: { label: "自分发测试 Manager", portCount: 1, maxHandoffs: 4 }
      }],
      edges: [],
      variables: {},
      display: { viewport: { x: 0, y: 0, zoom: 1 } },
      createdAt: now,
      updatedAt: now
    };
    const runView: BlueprintRunView = {
      run: {
        id: "run-manager-missing-round",
        companyId: "company-1",
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        blueprintVersion: 1,
        status: "succeeded",
        startedBy: "user-1",
        startedAt: now,
        endedAt: "2026-05-28T00:03:00.000Z",
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      },
      nodeRuns: [],
      events: [],
      finalResult: null,
      iterationSessions: [],
      iterationRounds: [{
        id: "round-1",
        sessionId: "session-1",
        runId: "run-manager-missing-round",
        roundNumber: 1,
        status: "completed",
        artifactIds: [],
        startedAt: now,
        endedAt: "2026-05-28T00:02:00.000Z"
      }],
      approvalRequests: [],
      approvalDecisions: [],
      artifacts: [],
      releaseReports: [],
      agentHumanReports: [{
        id: "manager-report-missing-round",
        runId: "run-manager-missing-round",
        nodeRunId: "manager-run-round-1-decision",
        nodeId: "manager",
        nodeLabel: "自分发测试 Manager · 调度 1",
        title: "Manager dispatch report",
        bodyMd: "上一轮参考：Round 1 Execution Plan v1\n\nManager 正在处理第一轮调度。",
        source: "agent",
        createdAt: "2026-05-28T00:03:00.000Z"
      }],
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

    const issueCards: string[] = html.match(/<button type="button" class="trace-issue-card[\s\S]*?<\/button>/g) ?? [];
    const managerCard = issueCards.find((card) => card.includes("自分发测试 Manager")) ?? "";

    expect(managerCard).toContain("轮次缺失");
    expect(managerCard).not.toContain("第一轮");
    expect(managerCard).not.toContain("第1轮");
  });
});

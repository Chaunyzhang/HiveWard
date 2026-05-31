import { describe, expect, it } from "vitest";
import type { HarnessId, HarnessSkillInstallStatus, HarnessSkillStatusResponse, HarnessStatus } from "@hiveward/shared";
import { resolveSidebarActivityMeta } from "./sidebar-activity";

function harnessStatus(
  id: HarnessId,
  connectionState: HarnessStatus["connectionState"],
  checks: HarnessStatus["checks"] = []
): HarnessStatus {
  return {
    id,
    label: id,
    installed: connectionState !== "unavailable",
    environmentOk: connectionState === "connected" || connectionState === "available",
    connectionState,
    summary: id,
    checkedAt: "2026-06-01T00:00:00.000Z",
    checks
  };
}

function skillStatus(harnessId: HarnessId, statuses: HarnessSkillInstallStatus[]): HarnessSkillStatusResponse {
  return {
    harnessId,
    supported: true,
    checkedAt: "2026-06-01T00:00:00.000Z",
    skills: statuses.map((status, index) => ({
      id: index === 0 ? "hiveward-ceo" : index === 1 ? "hiveward-leader" : "hiveward-skill-decomposer",
      label: `Skill ${index + 1}`,
      sourcePath: `/source/${index + 1}`,
      targetPath: `/target/${index + 1}`,
      installed: status === "installed" || status === "stale",
      status
    }))
  };
}

describe("resolveSidebarActivityMeta", () => {
  it("alerts configured harnesses only when an installed skill is stale", () => {
    const activity = resolveSidebarActivityMeta({
      activeTaskCount: 0,
      pendingApprovalCount: 0,
      pendingInboxCount: 0,
      dirtyBlueprintCount: 0,
      harnessStatuses: {
        codex: harnessStatus("codex", "available", [
          { id: "codex-auth", label: "Codex credentials", status: "warning", detail: "Ignored by sidebar." }
        ]),
        claudeCode: harnessStatus("claudeCode", "needs_config"),
        google: harnessStatus("google", "available")
      },
      harnessSkillStatuses: {
        codex: skillStatus("codex", ["stale", "missing", "error"]),
        claudeCode: skillStatus("claudeCode", ["stale"]),
        google: skillStatus("google", ["missing", "error"])
      }
    });

    expect(activity.codexConfig).toBe(1);
    expect(activity.claudeCodeConfig).toBeUndefined();
    expect(activity.googleConfig).toBeUndefined();
  });

  it("keeps running runs and pending inbox work as sidebar activity, but leaves history quiet", () => {
    const activity = resolveSidebarActivityMeta({
      activeTaskCount: 2,
      pendingApprovalCount: 1,
      pendingInboxCount: 3,
      dirtyBlueprintCount: 4,
      harnessStatuses: {
        codex: harnessStatus("codex", "available", [
          { id: "codex-auth", label: "Codex credentials", status: "fail", detail: "Ignored by sidebar." }
        ])
      },
      harnessSkillStatuses: {
        codex: skillStatus("codex", ["installed"])
      }
    });

    expect(activity.runs).toBe(2);
    expect(activity.approvals).toBe(4);
    expect(activity.schedule).toBeUndefined();
    expect(activity.blueprint).toBeUndefined();
    expect(activity.codexConfig).toBeUndefined();
  });

  it("routes OpenClaw and Hermes stale skill updates to their skill pages without duplicate config alerts", () => {
    const activity = resolveSidebarActivityMeta({
      activeTaskCount: 0,
      pendingApprovalCount: 0,
      pendingInboxCount: 0,
      dirtyBlueprintCount: 0,
      harnessStatuses: {
        openclaw: harnessStatus("openclaw", "connected"),
        hermes: harnessStatus("hermes", "available")
      },
      harnessSkillStatuses: {
        openclaw: skillStatus("openclaw", ["stale"]),
        hermes: skillStatus("hermes", ["stale"])
      }
    });

    expect(activity.skills).toBe(1);
    expect(activity.hermesSkills).toBe(1);
    expect(activity.openclaw).toBeUndefined();
    expect(activity.hermesConfig).toBeUndefined();
  });
});

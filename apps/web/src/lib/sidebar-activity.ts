import type { HarnessId, HarnessSkillStatusResponse, HarnessStatus } from "@hiveward/shared";
import type { AppNavSectionId } from "./app-sections";

export type SidebarActivityInput = {
  activeTaskCount: number;
  pendingApprovalCount: number;
  pendingInboxCount: number;
  dirtyBlueprintCount: number;
  harnessStatuses: Partial<Record<HarnessId, HarnessStatus | undefined>>;
  harnessSkillStatuses: Partial<Record<HarnessId, HarnessSkillStatusResponse | undefined>>;
};

const harnessSkillActivitySections = {
  openclaw: "skills",
  claudeCode: "claudeCodeConfig",
  codex: "codexConfig",
  google: "googleConfig",
  cursor: "cursorConfig",
  opencode: "opencodeConfig",
  hermes: "hermesSkills"
} satisfies Record<HarnessId, AppNavSectionId>;

export function resolveSidebarActivityMeta(input: SidebarActivityInput): Partial<Record<AppNavSectionId, number>> {
  const activity: Partial<Record<AppNavSectionId, number>> = {
    runs: activeCountOrUndefined(input.activeTaskCount),
    approvals: activeCountOrUndefined(input.pendingApprovalCount + input.pendingInboxCount)
  };

  for (const [harnessId, sectionId] of Object.entries(harnessSkillActivitySections) as Array<[HarnessId, AppNavSectionId]>) {
    const skillUpdateCount = countConfiguredHarnessSkillUpdateActivity(input.harnessStatuses[harnessId], input.harnessSkillStatuses[harnessId]);
    activity[sectionId] = activeCountOrUndefined(skillUpdateCount);
  }

  return activity;
}

function activeCountOrUndefined(count: number): number | undefined {
  return count > 0 ? count : undefined;
}

function countConfiguredHarnessSkillUpdateActivity(
  status: HarnessStatus | undefined,
  skillStatus: HarnessSkillStatusResponse | undefined
): number {
  if (!isConfiguredHarness(status)) return 0;
  if (!skillStatus?.supported || skillStatus.harnessId !== status.id) return 0;
  return skillStatus.skills.filter((skill) => skill.status === "stale").length;
}

function isConfiguredHarness(status: HarnessStatus | undefined): status is HarnessStatus {
  return status?.connectionState === "connected" || status?.connectionState === "available";
}

import { describe, expect, it } from "vitest";
import { appSectionGroups, appSystemLabels } from "./app-sections";

describe("appSectionGroups", () => {
  it("orders harness groups by operator priority", () => {
    expect(appSectionGroups.map((group) => group.id)).toEqual([
      "hiveward",
      "openclaw",
      "hermes",
      "claudeCode",
      "codex",
      "google",
      "cursor",
      "opencode"
    ]);
  });

  it("keeps Claude Code model settings on a dedicated Claude Code page", () => {
    const claudeCodeGroup = appSectionGroups.find((group) => group.id === "claudeCode");

    expect(claudeCodeGroup?.sections).toEqual(["claudeCodeConfig", "claudeCodeModels"]);
  });

  it("gives Hermes the same operator-facing sections as OpenClaw", () => {
    const hermesGroup = appSectionGroups.find((group) => group.id === "hermes");

    expect(hermesGroup?.sections).toEqual(["hermesConfig", "hermesModels", "hermesAgents", "hermesSkills", "hermesChannels"]);
  });

  it("marks newly added CLI system groups as beta", () => {
    expect(appSystemLabels.google).toBe("Google CLI Beta");
    expect(appSystemLabels.cursor).toBe("Cursor CLI Beta");
    expect(appSystemLabels.opencode).toBe("OpenCode Beta");
    expect(appSystemLabels.hermes).toBe("Hermes Beta");
  });
});

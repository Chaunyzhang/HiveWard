import { describe, expect, it } from "vitest";
import {
  buildAgentHarnessOptions,
  buildArchitectureRoleDetailRows,
  buildBlueprintModelSelectOptions,
  buildHermesProfileSelectOptions,
  buildSummaryHarnessOptions,
  blueprintSelectOpenEventName,
  createBlueprintCanvasWorld,
  getBlueprintSelectOutsidePointerListenerOptions,
  isBlueprintCardKeyboardActivationKey,
  isBlueprintSelectorDisabled,
  resolveBlueprintModelSelectValue,
  shouldActivateBlueprintCardPointer,
  shouldExpandBlueprintCanvasWorld
} from "./blueprint-studio-state";

describe("blueprint studio state", () => {
  it("keeps the blueprint selector available for an empty selected company", () => {
    expect(isBlueprintSelectorDisabled({ busy: false, selectedCompanyId: "company-empty" })).toBe(false);
  });

  it("keeps the blueprint selector disabled while another action is busy", () => {
    expect(isBlueprintSelectorDisabled({ busy: true, selectedCompanyId: "company-empty" })).toBe(true);
  });

  it("keeps the blueprint selector disabled when no company is selected", () => {
    expect(isBlueprintSelectorDisabled({ busy: false })).toBe(true);
  });

  it("allows agent and manager nodes to switch to Claude Code from OpenClaw", () => {
    expect(buildAgentHarnessOptions().map((option) => option.value)).toEqual([
      "codex",
      "google",
      "cursor",
      "opencode",
      "hermes",
      "openclaw",
      "claude"
    ]);
  });

  it("marks newly added CLI harness options as beta", () => {
    expect(buildAgentHarnessOptions().filter((option) => ["google", "cursor", "opencode", "hermes"].includes(option.value))).toEqual([
      { value: "google", label: "Google CLI", badgeLabel: "Beta" },
      { value: "cursor", label: "Cursor CLI", badgeLabel: "Beta" },
      { value: "opencode", label: "OpenCode", badgeLabel: "Beta" },
      { value: "hermes", label: "Hermes", badgeLabel: "Beta" }
    ]);
  });

  it("uses stable Hermes profile ids as blueprint values while showing aliases as labels", () => {
    expect(
      buildHermesProfileSelectOptions({
        runtimeId: "hermes",
        defaultLabel: "Default",
        profiles: [
          { id: "architect", label: "Architect", alias: "hermes-architect", isDefault: true },
          { id: "researcher", label: "Researcher" }
        ]
      })
    ).toEqual([
      { value: "", label: "Default" },
      { value: "architect", label: "Architect (hermes-architect)", badgeLabel: "Default" },
      { value: "researcher", label: "Researcher", disabled: true }
    ]);
  });

  it("disables Hermes profiles that do not expose a runtime alias", () => {
    expect(
      buildHermesProfileSelectOptions({
        runtimeId: "hermes",
        defaultLabel: "Default",
        profiles: [
          { id: "architect", label: "Architect", alias: "hermes-architect" },
          { id: "researcher", label: "Researcher" }
        ]
      })
    ).toEqual([
      { value: "", label: "Default" },
      { value: "architect", label: "Architect (hermes-architect)" },
      { value: "researcher", label: "Researcher", disabled: true }
    ]);
  });

  it("allows agent and manager nodes to switch to Claude Code from Codex", () => {
    expect(buildAgentHarnessOptions().map((option) => option.value)).toContain("claude");
  });

  it("gives summary nodes the same beta CLI harness choices as agent nodes", () => {
    expect(buildSummaryHarnessOptions().filter((option) => ["google", "cursor", "opencode", "hermes"].includes(option.value))).toEqual([
      { value: "google", label: "Google CLI", badgeLabel: "Beta" },
      { value: "cursor", label: "Cursor CLI", badgeLabel: "Beta" },
      { value: "opencode", label: "OpenCode", badgeLabel: "Beta" },
      { value: "hermes", label: "Hermes", badgeLabel: "Beta" }
    ]);
  });

  it("listens for outside pointer events during capture so modal propagation stops do not trap open selects", () => {
    expect(getBlueprintSelectOutsidePointerListenerOptions()).toMatchObject({ capture: true });
  });

  it("uses a shared event name for closing peer selects when another select opens", () => {
    expect(blueprintSelectOpenEventName).toBe("hiveward:blueprint-select-open");
  });

  it("activates a blueprint card from an ordinary primary pointer gesture", () => {
    expect(
      shouldActivateBlueprintCardPointer({
        button: 0,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false
      })
    ).toBe(true);
  });

  it("does not activate a blueprint card from a secondary pointer gesture", () => {
    expect(
      shouldActivateBlueprintCardPointer({
        button: 2,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false
      })
    ).toBe(false);
  });

  it("does not activate a blueprint card from a macOS control-click context menu gesture", () => {
    expect(
      shouldActivateBlueprintCardPointer({
        button: 0,
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false
      })
    ).toBe(false);
  });

  it("keeps keyboard activation explicit for blueprint cards", () => {
    expect(isBlueprintCardKeyboardActivationKey("Enter")).toBe(true);
    expect(isBlueprintCardKeyboardActivationKey(" ")).toBe(true);
    expect(isBlueprintCardKeyboardActivationKey("Escape")).toBe(false);
  });

  it("builds architecture leader detail as static rows with a blueprint action", () => {
    expect(
      buildArchitectureRoleDetailRows({
        roleKind: "leader",
        pendingLabel: "待处理",
        pendingApprovalCount: 0,
        leaderLabel: "Leader",
        latestRunLabel: "最近运行",
        noRunLabel: "暂无运行",
        businessLabel: "业务蓝图",
        blueprintId: "blueprint-a",
        blueprintLabel: "主动分发 Manager 测试机"
      })
    ).toEqual([
      { id: "pending", label: "待处理", value: "0" },
      { id: "latestRun", label: "最近运行", value: "暂无运行" },
      {
        id: "blueprint",
        label: "业务蓝图",
        value: "主动分发 Manager 测试机",
        actionBlueprintId: "blueprint-a"
      }
    ]);
  });

  it("builds architecture CEO detail as static rows without a blueprint action", () => {
    expect(
      buildArchitectureRoleDetailRows({
        roleKind: "ceo",
        pendingLabel: "待处理",
        pendingApprovalCount: 2,
        leaderLabel: "Leader",
        leaderCount: 3,
        latestRunLabel: "最近运行",
        noRunLabel: "暂无运行",
        businessLabel: "业务蓝图"
      })
    ).toEqual([
      { id: "pending", label: "待处理", value: "2" },
      { id: "leaderCount", label: "Leader", value: "3" }
    ]);
  });

  it("labels the implicit model choice as plain default without a runtime prefix", () => {
    expect(
      buildBlueprintModelSelectOptions({
        models: [],
        defaultLabel: "默认",
        defaultBadgeLabel: "默认"
      })
    ).toEqual([{ value: "", label: "默认" }]);
  });

  it("shows concrete harness models and marks the concrete default model", () => {
    expect(
      buildBlueprintModelSelectOptions({
        models: [
          { id: "inherit", label: "Claude Code default", isDefault: true },
          { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5", isDefault: true },
          { id: "claude-opus-4-1", label: "claude-opus-4-1" }
        ],
        defaultLabel: "默认",
        defaultBadgeLabel: "默认"
      })
    ).toEqual([
      { value: "", label: "默认" },
      { value: "claude-sonnet-4-5", label: "claude-sonnet-4-5 默认" },
      { value: "claude-opus-4-1", label: "claude-opus-4-1" }
    ]);
  });

  it("treats inherited harness defaults as the implicit default selection", () => {
    expect(resolveBlueprintModelSelectValue("inherit")).toBe("");
  });

  it("keeps a custom selected model visible when it is not in the scanned model list", () => {
    expect(
      buildBlueprintModelSelectOptions({
        selectedModel: "custom-model",
        models: [{ id: "gpt-5.5", label: "gpt-5.5" }],
        defaultLabel: "默认",
        defaultBadgeLabel: "默认"
      })
    ).toEqual([
      { value: "", label: "默认" },
      { value: "custom-model", label: "custom-model" },
      { value: "gpt-5.5", label: "gpt-5.5" }
    ]);
  });

  it("creates the initial blueprint canvas world at the existing fixed size", () => {
    expect(createBlueprintCanvasWorld({ width: 1200, height: 900 })).toMatchObject({
      minX: -1200,
      minY: -900,
      maxX: 9600,
      maxY: 7200,
      width: 10800,
      height: 8100,
      viewportWidth: 1200,
      viewportHeight: 900
    });
  });

  it("expands the blueprint canvas by one fixed ring on every side", () => {
    expect(createBlueprintCanvasWorld({ width: 1200, height: 900 }, 1)).toMatchObject({
      minX: -2400,
      minY: -1800,
      maxX: 10800,
      maxY: 8100,
      width: 13200,
      height: 9900
    });
  });

  it("expands the initial blueprint canvas around far-away content with two outer rings", () => {
    expect(
      createBlueprintCanvasWorld({ width: 1200, height: 900 }, 0, {
        minX: 9800,
        minY: 1200,
        maxX: 10000,
        maxY: 1400
      })
    ).toMatchObject({
      minX: -4800,
      maxX: 13200
    });
  });

  it("uses the same content expansion rings for negative-side content", () => {
    expect(
      createBlueprintCanvasWorld({ width: 1200, height: 900 }, 0, {
        minX: -2600,
        minY: 1200,
        maxX: -2400,
        maxY: 1400
      })
    ).toMatchObject({
      minX: -6000,
      maxX: 14400
    });
  });

  it("does not expand for content that already has two rings of default margin", () => {
    expect(
      createBlueprintCanvasWorld({ width: 1200, height: 900 }, 0, {
        minX: 1300,
        minY: 1000,
        maxX: 7000,
        maxY: 3000
      })
    ).toMatchObject({
      minX: -1200,
      minY: -900,
      maxX: 9600,
      maxY: 7200
    });
  });

  it("does not expand the blueprint canvas near the starting viewport", () => {
    const viewportSize = { width: 1200, height: 900 };
    const canvasWorld = createBlueprintCanvasWorld(viewportSize);
    expect(
      shouldExpandBlueprintCanvasWorld({
        viewport: { x: 0, y: 0, zoom: 1 },
        viewportSize,
        canvasWorld
      })
    ).toBe(false);
  });

  it("expands the blueprint canvas when the viewport touches an edge", () => {
    const viewportSize = { width: 1200, height: 900 };
    const canvasWorld = createBlueprintCanvasWorld(viewportSize);
    expect(
      shouldExpandBlueprintCanvasWorld({
        viewport: { x: -(canvasWorld.maxX - viewportSize.width), y: 0, zoom: 1 },
        viewportSize,
        canvasWorld
      })
    ).toBe(true);
  });

  it("expands the blueprint canvas when the viewport touches a corner", () => {
    const viewportSize = { width: 1200, height: 900 };
    const canvasWorld = createBlueprintCanvasWorld(viewportSize);
    expect(
      shouldExpandBlueprintCanvasWorld({
        viewport: { x: -canvasWorld.minX, y: -canvasWorld.minY, zoom: 1 },
        viewportSize,
        canvasWorld
      })
    ).toBe(true);
  });
});

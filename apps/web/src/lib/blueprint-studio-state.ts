import type { AgentRuntimeId, CanvasSize, HarnessProfileOption } from "@hiveward/shared";
import { runtimeDisplayParts } from "./harness-labels";

export type BlueprintRuntimeOption = {
  value: AgentRuntimeId;
  label: string;
  badgeLabel?: string;
};

export type BlueprintModelOption = {
  id: string;
  label: string;
  isDefault?: boolean;
};

export type BlueprintModelSelectOption = {
  value: string;
  label: string;
  badgeLabel?: string;
  disabled?: boolean;
};

export type BlueprintCanvasViewport = {
  x: number;
  y: number;
  zoom: number;
};

export type BlueprintCanvasWorld = {
  extent: [[number, number], [number, number]];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type BlueprintCanvasContentBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type ArchitectureRoleDetailRow = {
  id: "pending" | "leaderCount" | "latestRun" | "blueprint";
  label: string;
  value: string;
  actionBlueprintId?: string;
};

export const blueprintSelectOpenEventName = "hiveward:blueprint-select-open";
const canvasWorldScreenScale = 9;
const canvasWorldExpansionRingScale = 1;
const canvasWorldExpansionEdgeMargin = 24;
const canvasWorldContentOuterRings = 2;

export function isBlueprintSelectorDisabled(input: {
  busy: boolean;
  selectedCompanyId?: string;
}): boolean {
  return input.busy || !input.selectedCompanyId;
}

export function buildAgentHarnessOptions(): BlueprintRuntimeOption[] {
  return ([
    "codex",
    "google",
    "cursor",
    "opencode",
    "hermes",
    "openclaw",
    "claude"
  ] as const).map((value) => ({ value, ...runtimeDisplayParts(value) }));
}

export function buildSummaryHarnessOptions(): BlueprintRuntimeOption[] {
  return buildAgentHarnessOptions();
}

export function createBlueprintCanvasWorld(
  viewportSize: CanvasSize,
  expansionRings = 0,
  contentBounds?: BlueprintCanvasContentBounds
): BlueprintCanvasWorld {
  const viewportWidth = Math.max(960, Math.round(viewportSize.width));
  const viewportHeight = Math.max(720, Math.round(viewportSize.height));
  const ringWidth = viewportWidth * canvasWorldExpansionRingScale;
  const ringHeight = viewportHeight * canvasWorldExpansionRingScale;
  const baseMinX = -viewportWidth;
  const baseMinY = -viewportHeight;
  const baseMaxX = baseMinX + viewportWidth * canvasWorldScreenScale;
  const baseMaxY = baseMinY + viewportHeight * canvasWorldScreenScale;
  const rings = Math.max(
    normalizeCanvasWorldExpansionRings(expansionRings),
    resolveContentExpansionRings({
      contentBounds,
      baseMinX,
      baseMinY,
      baseMaxX,
      baseMaxY,
      ringWidth,
      ringHeight
    })
  );
  const minX = -viewportWidth - ringWidth * rings;
  const minY = -viewportHeight - ringHeight * rings;
  const width = viewportWidth * canvasWorldScreenScale + ringWidth * rings * 2;
  const height = viewportHeight * canvasWorldScreenScale + ringHeight * rings * 2;
  const maxX = minX + width;
  const maxY = minY + height;
  return {
    extent: [
      [minX, minY],
      [maxX, maxY]
    ],
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    viewportWidth,
    viewportHeight
  };
}

export function shouldExpandBlueprintCanvasWorld(input: {
  viewport: BlueprintCanvasViewport;
  viewportSize: CanvasSize;
  canvasWorld: BlueprintCanvasWorld;
}): boolean {
  const viewportRect = resolveBlueprintViewportRect(input.viewport, input.viewportSize);
  const edgeMarginX = Math.max(canvasWorldExpansionEdgeMargin, input.canvasWorld.viewportWidth * 0.02);
  const edgeMarginY = Math.max(canvasWorldExpansionEdgeMargin, input.canvasWorld.viewportHeight * 0.02);
  return (
    viewportRect.x <= input.canvasWorld.minX + edgeMarginX ||
    viewportRect.y <= input.canvasWorld.minY + edgeMarginY ||
    viewportRect.x + viewportRect.width >= input.canvasWorld.maxX - edgeMarginX ||
    viewportRect.y + viewportRect.height >= input.canvasWorld.maxY - edgeMarginY
  );
}

function resolveBlueprintViewportRect(
  viewport: BlueprintCanvasViewport,
  viewportSize: CanvasSize
): { x: number; y: number; width: number; height: number } {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  return {
    x: -viewport.x / zoom,
    y: -viewport.y / zoom,
    width: Math.max(1, viewportSize.width) / zoom,
    height: Math.max(1, viewportSize.height) / zoom
  };
}

function normalizeCanvasWorldExpansionRings(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function resolveContentExpansionRings(input: {
  contentBounds?: BlueprintCanvasContentBounds;
  baseMinX: number;
  baseMinY: number;
  baseMaxX: number;
  baseMaxY: number;
  ringWidth: number;
  ringHeight: number;
}): number {
  const { contentBounds } = input;
  if (!contentBounds) return 0;

  const paddedMinX = contentBounds.minX - input.ringWidth * canvasWorldContentOuterRings;
  const paddedMaxX = contentBounds.maxX + input.ringWidth * canvasWorldContentOuterRings;
  const paddedMinY = contentBounds.minY - input.ringHeight * canvasWorldContentOuterRings;
  const paddedMaxY = contentBounds.maxY + input.ringHeight * canvasWorldContentOuterRings;

  return Math.max(
    requiredExpansionRings(input.baseMinX - paddedMinX, input.ringWidth),
    requiredExpansionRings(paddedMaxX - input.baseMaxX, input.ringWidth),
    requiredExpansionRings(input.baseMinY - paddedMinY, input.ringHeight),
    requiredExpansionRings(paddedMaxY - input.baseMaxY, input.ringHeight)
  );
}

function requiredExpansionRings(overage: number, ringSize: number): number {
  if (!Number.isFinite(overage) || overage <= 0 || !Number.isFinite(ringSize) || ringSize <= 0) return 0;
  return Math.ceil(overage / ringSize);
}

export function getBlueprintSelectOutsidePointerListenerOptions(): AddEventListenerOptions {
  return { capture: true };
}

export function shouldActivateBlueprintCardPointer(input: {
  button: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
}): boolean {
  if (input.defaultPrevented) return false;
  if (input.button !== 0) return false;
  return !input.ctrlKey && !input.metaKey && !input.altKey && !input.shiftKey;
}

export function isBlueprintCardKeyboardActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

export function buildArchitectureRoleDetailRows(input: {
  roleKind: "ceo" | "leader";
  pendingLabel: string;
  pendingApprovalCount: number;
  leaderLabel: string;
  leaderCount?: number;
  latestRunLabel: string;
  latestRunStatus?: string;
  noRunLabel: string;
  businessLabel: string;
  blueprintId?: string;
  blueprintLabel?: string;
}): ArchitectureRoleDetailRow[] {
  const rows: ArchitectureRoleDetailRow[] = [
    { id: "pending", label: input.pendingLabel, value: String(input.pendingApprovalCount) }
  ];

  if (input.roleKind === "ceo") {
    return rows.concat({
      id: "leaderCount",
      label: input.leaderLabel,
      value: String(input.leaderCount ?? 0)
    });
  }

  rows.push({
    id: "latestRun",
    label: input.latestRunLabel,
    value: input.latestRunStatus ?? input.noRunLabel
  });

  if (input.blueprintLabel) {
    rows.push({
      id: "blueprint",
      label: input.businessLabel,
      value: input.blueprintLabel,
      actionBlueprintId: input.blueprintId
    });
  }

  return rows;
}

export function buildBlueprintModelSelectOptions(input: {
  models: BlueprintModelOption[];
  defaultLabel: string;
  defaultBadgeLabel: string;
  selectedModel?: string;
  defaultValue?: string;
  noChangeLabel?: string;
}): BlueprintModelSelectOption[] {
  const concreteModels = input.models.filter((model) => model.id !== "inherit");
  const selectedModel = resolveBlueprintModelSelectValue(input.selectedModel);
  const selectedModelOption: BlueprintModelOption[] =
    selectedModel && !concreteModels.some((model) => model.id === selectedModel)
      ? [{ id: selectedModel, label: selectedModel }]
      : [];

  return [
    ...(input.noChangeLabel ? [{ value: "", label: input.noChangeLabel }] : []),
    { value: input.defaultValue ?? "", label: input.defaultLabel },
    ...selectedModelOption
      .concat(concreteModels)
      .map((model) => ({
        value: model.id,
        label: model.isDefault ? `${model.label} ${input.defaultBadgeLabel}` : model.label
      }))
  ];
}

export function resolveBlueprintModelSelectValue(modelId: string | undefined): string {
  return modelId === "inherit" ? "" : modelId ?? "";
}

export function buildHermesProfileSelectOptions(input: {
  runtimeId: AgentRuntimeId;
  profiles: HarnessProfileOption[];
  defaultLabel: string;
  defaultBadgeLabel?: string;
}): BlueprintModelSelectOption[] {
  if (input.runtimeId !== "hermes") return [];
  return [
    { value: "", label: input.defaultLabel },
    ...input.profiles.map((profile) => {
      const option: BlueprintModelSelectOption = {
        value: profile.id,
        label: profile.alias ? `${profile.label} (${profile.alias})` : profile.label
      };
      if (profile.isDefault) option.badgeLabel = input.defaultBadgeLabel ?? input.defaultLabel;
      if (!profile.alias) option.disabled = true;
      return option;
    })
  ];
}

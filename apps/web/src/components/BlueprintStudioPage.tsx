import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  ReactFlow,
  ReactFlowProvider,
  Position,
  SelectionMode,
  type Connection,
  type CoordinateExtent,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type EdgeMouseHandler,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type OnNodesChange,
  type OnConnectEnd,
  useReactFlow,
  useStore
} from "@xyflow/react";
import {
  ArrowUpDown,
  Bot,
  Check,
  ChevronDown,
  Download,
  GitBranch,
  LayoutTemplate,
  Loader2,
  MessagesSquare,
  Network,
  Play,
  Plus,
  Repeat2,
  Save,
  Search,
  ShieldCheck,
  Settings2,
  Square,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  isAgentBlueprintNode,
  isManagerSlotForwardOutHandle,
  isManagerSlotInnerInHandle,
  isManagerSlotInnerOutHandle,
  normalizeRuntimeAccessPolicy,
  runtimeAccessPolicySupportByRuntime,
  resolveCrossRoundContextMode,
  resolveManagerSlotExecutionMode,
  resolveManagerSlotParallelLaneCount,
  type AgentRuntimeId
} from "@hiveward/shared";
import type {
  AgentNodeConfig,
  ArchitectureBlueprintView,
  CanvasPosition,
  CanvasSize,
  CatalogSnapshot,
  ConditionNodeConfig,
  CompanyRoleDirectory,
  CompanyRoleKind,
  CrossRoundContextMode,
  GroupNodeConfig,
  LoopNodeConfig,
  ManagerNodeConfig,
  ManagerSlotNodeConfig,
  ChatPermissionMode,
  HarnessId,
  HarnessStatus,
  HarnessSkillStatusResponse,
  NoteNodeConfig,
  OpenClawConfiguredAgent,
  SummaryNodeConfig,
  BlueprintDefinition,
  BlueprintEdge,
  BlueprintNode,
  BlueprintNodeRun,
  BlueprintNodeType,
  BlueprintRunSummary,
  BlueprintRunView,
  RuntimeAccessPolicy
} from "@hiveward/shared";
import {
  MANAGER_SLOT_DEFAULT_SIZE,
  MANAGER_SLOT_FRAME,
  MANAGER_SLOT_MIN_SIZE,
  BlueprintNodeCard,
  type BlueprintNodeCardData
} from "./BlueprintNodeCard";
import { type Messages } from "../lib/i18n";
import {
  isPollingRunStatus,
  isTerminalBlueprintRunStatus,
  readAcknowledgedTerminalRunIds,
  resolveBlueprintActivityState,
  resolveRunViewDisplayStatus,
  resolveRunViewStatus,
  shouldShowBlueprintWorkspaceRunState,
  writeAcknowledgedTerminalRunIds
} from "../lib/run-state";
import {
  blueprintSelectOpenEventName,
  buildAgentHarnessOptions,
  buildArchitectureRoleDetailRows,
  buildBlueprintModelSelectOptions,
  buildHermesProfileSelectOptions,
  buildSummaryHarnessOptions,
  createBlueprintCanvasWorld,
  getBlueprintSelectOutsidePointerListenerOptions,
  isBlueprintCardKeyboardActivationKey,
  isBlueprintSelectorDisabled,
  resolveBlueprintModelSelectValue,
  shouldActivateBlueprintCardPointer,
  shouldExpandBlueprintCanvasWorld,
  type BlueprintCanvasContentBounds,
  type BlueprintCanvasViewport,
  type BlueprintCanvasWorld
} from "../lib/blueprint-studio-state";
import {
  resolveRuntimeHarnessPermissionMode,
  resolveRuntimePermissionProfile
} from "../lib/harness-permissions";
import { runtimeDisplayLabel } from "../lib/harness-labels";
import { HarnessLabel } from "./HarnessLabel";

const nodeTypes = {
  blueprintNode: BlueprintNodeCard,
  architectureRole: ArchitectureRoleNodeCard
};

const edgeTypes: EdgeTypes = {
  architectureDistributor: ArchitectureDistributorEdge
};

const fallbackCanvasViewportSize: CanvasSize = { width: 1200, height: 900 };
const nodeMenuPopoverWidth = 146;
const nodeMenuViewportMargin = 12;

const palette: Array<{ type: BlueprintNodeType; icon: typeof Plus }> = [
  { type: "agent", icon: Bot },
  { type: "manager", icon: Network },
  { type: "manager_slot", icon: Network },
  { type: "loop", icon: Repeat2 },
  { type: "condition", icon: GitBranch },
  { type: "summary", icon: MessagesSquare }
];

const managerInHandlePrefix = "manager-in-";
const managerOutHandlePrefix = "manager-out-";
const managerSlotInHandle = "manager-slot-in";
const managerSlotOutHandle = "manager-slot-out";
const maxManagerPortCount = 8;
const blueprintStepTypes = new Set<BlueprintNodeType>([
  "agent",
  "manager",
  "manager_slot",
  "loop",
  "condition",
  "summary"
]);
const rightButtonDragThreshold = 4;
const defaultChildNodeSize: CanvasSize = { width: 232, height: 108 };
const architectureCeoNodeSize: CanvasSize = { width: 420, height: 86 };
const architectureLeaderNodeSize: CanvasSize = { width: 340, height: 220 };
const defaultBlueprintViewport: BlueprintCanvasViewport = { x: 0, y: 0, zoom: 1 };
type BlueprintViewport = BlueprintCanvasViewport;
type BlueprintSortMode = "recent" | "usage" | "created" | "nodes" | "name";
type BlueprintConnectionCandidate = {
  source?: string | null;
  target?: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};
type BlueprintDrawerAnchor = {
  left: number;
  width: number;
  bottom: number;
};

interface ArchitectureRoleNodeData extends Record<string, unknown> {
  label: string;
  roleKind: CompanyRoleKind;
  blueprintId?: string;
  blueprintName?: string;
  pendingApprovalCount: number;
  latestRunStatus?: BlueprintRunSummary["status"];
  latestRunAt?: string;
  leaderCount?: number;
  copy: BlueprintBoardCopy;
  onOpenBlueprint: (blueprintId: string) => void;
}

interface ArchitectureDistributorEdgeData extends Record<string, unknown> {
  drawsRootAndTrunk: boolean;
  trunkY: number;
}

export function BlueprintStudioPage({
  blueprint,
  blueprints,
  architecture,
  roleDirectory,
  catalog,
  configuredAgents,
  harnessStatuses,
  harnessPermissionModes,
  harnessSkillStatuses,
  runSummaries,
  runView,
  selectedNodeId,
  selectedCompanyId,
  busy,
  busyAction,
  blueprintDirty,
  onSelectBlueprint,
  onCreateBlueprint,
  onOpenBlueprintImport,
  onExportBlueprint,
  onDeleteBlueprint,
  onSaveBlueprint,
  onRunBlueprint,
  onCancelBlueprintRun,
  onSelectNode,
  onUpdateBlueprint,
  onUpdateArchitectureLayout,
  onApproveRun,
  t
}: {
  blueprint?: BlueprintDefinition;
  blueprints: BlueprintDefinition[];
  architecture?: ArchitectureBlueprintView;
  roleDirectory?: CompanyRoleDirectory;
  catalog?: CatalogSnapshot;
  configuredAgents?: OpenClawConfiguredAgent[];
  harnessStatuses?: HarnessStatus[];
  harnessPermissionModes?: Partial<Record<HarnessId, ChatPermissionMode>>;
  harnessSkillStatuses?: Partial<Record<HarnessStatus["id"], HarnessSkillStatusResponse>>;
  runSummaries: BlueprintRunSummary[];
  runView?: BlueprintRunView;
  selectedNodeId?: string;
  selectedCompanyId?: string;
  busy: boolean;
  busyAction?: string;
  blueprintDirty: boolean;
  onSelectBlueprint: (blueprintId: string) => void;
  onCreateBlueprint: () => void;
  onOpenBlueprintImport: () => void;
  onExportBlueprint: (blueprintId?: string) => void;
  onDeleteBlueprint: (blueprintId: string) => void;
  onSaveBlueprint: () => void;
  onRunBlueprint: () => void;
  onCancelBlueprintRun: () => void;
  onSelectNode: (nodeId?: string) => void;
  onUpdateBlueprint: (updater: (current: BlueprintDefinition) => BlueprintDefinition) => void;
  onUpdateArchitectureLayout: (positions: Record<string, CanvasPosition>) => void;
  onApproveRun: () => void;
  t: Messages;
}) {
  const [inspectedNodeId, setInspectedNodeId] = useState<string | undefined>();
  const [selectedCanvasNodeIds, setSelectedCanvasNodeIds] = useState<string[]>([]);
  const selectedDetailNodeId =
    selectedCanvasNodeIds.length === 1 ? selectedCanvasNodeIds[0] : selectedCanvasNodeIds.length === 0 ? selectedNodeId : undefined;
  const inspectedNode = blueprint?.nodes.find((node) => node.id === selectedDetailNodeId);
  const [batchEditorOpen, setBatchEditorOpen] = useState(false);
  const [localNodes, setLocalNodes] = useState<Node<BlueprintNodeCardData>[]>([]);
  const [localEdges, setLocalEdges] = useState<Edge[]>([]);
  const [businessViewport, setBusinessViewport] = useState<BlueprintViewport>(blueprint?.display.viewport ?? defaultBlueprintViewport);
  const [architectureFlowNodes, setArchitectureFlowNodes] = useState<Node<ArchitectureRoleNodeData>[]>([]);
  const [selectedArchitectureNodeId, setSelectedArchitectureNodeId] = useState<string | undefined>();
  const [nodeMenuOpen, setNodeMenuOpen] = useState(false);
  const [nodeMenuAnchor, setNodeMenuAnchor] = useState<{ x: number; y: number; placement?: "above" }>({ x: 88, y: 252 });
  const [blueprintDrawerOpen, setBlueprintDrawerOpen] = useState(false);
  const [blueprintDrawerAnchor, setBlueprintDrawerAnchor] = useState<BlueprintDrawerAnchor | undefined>();
  const [blueprintBoard, setBlueprintBoard] = useState<"business" | "architecture">("business");
  const [drawerSelectedBlueprintId, setDrawerSelectedBlueprintId] = useState<string | undefined>(blueprint?.id);
  const [blueprintSearch, setBlueprintSearch] = useState("");
  const [blueprintSortMode, setBlueprintSortMode] = useState<BlueprintSortMode>("recent");
  const [blueprintCardContextMenu, setBlueprintCardContextMenu] = useState<{ x: number; y: number; blueprintId: string }>();
  const [deleteCandidateBlueprintId, setDeleteCandidateBlueprintId] = useState<string | undefined>();
  const acknowledgedTerminalRunIdsRef = useRef<Set<string>>(new Set());
  const [acknowledgedTerminalRunIds, setAcknowledgedTerminalRunIds] = useState<Set<string>>(() => {
    const initial = readAcknowledgedTerminalRunIds(getBrowserStorage());
    acknowledgedTerminalRunIdsRef.current = initial;
    return initial;
  });
  const currentTerminalRunIdRef = useRef<string | undefined>(undefined);
  const [nodeContextMenu, setNodeContextMenu] = useState<{ open: boolean; x: number; y: number; nodeId?: string }>({
    open: false,
    x: 0,
    y: 0,
    nodeId: undefined
  });
  const [canvasViewportSize, setCanvasViewportSize] = useState(fallbackCanvasViewportSize);
  const [canvasExpansionRings, setCanvasExpansionRings] = useState(0);
  const canvasExpansionRingsRef = useRef(0);
  const canvasPanelRef = useRef<HTMLElement | null>(null);
  const nodeMenuRef = useRef<HTMLDivElement | null>(null);
  const nodeMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const nodeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const blueprintSelectorButtonRef = useRef<HTMLButtonElement | null>(null);
  const blueprintDrawerRef = useRef<HTMLElement | null>(null);
  const blueprintCardContextMenuRef = useRef<HTMLDivElement | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const rightDragStateRef = useRef<{ x: number; y: number; moved: boolean; openedMenu: boolean } | undefined>(undefined);
  const suppressNextPaneClickRef = useRef(false);

  const setSelectedCanvasNodeIdsIfChanged = useCallback((nextIds: string[]) => {
    setSelectedCanvasNodeIds((current) => {
      if (current.length === nextIds.length && current.every((item, index) => item === nextIds[index])) {
        return current;
      }
      return nextIds;
    });
  }, [blueprintBoard]);

  const workspaceRunStatus = resolveRunViewDisplayStatus(runView);
  const workspaceTerminalRunSeen = Boolean(
    runView?.run.id &&
      isTerminalBlueprintRunStatus(runView.run.status) &&
      acknowledgedTerminalRunIds.has(runView.run.id)
  );
  const workspaceRunView = shouldShowBlueprintWorkspaceRunState(workspaceRunStatus, workspaceTerminalRunSeen) ? runView : undefined;
  const workspaceEdgeRunStatus = workspaceRunView ? workspaceRunStatus : undefined;
  const statusByNode = useMemo(() => {
    const map = new Map<string, BlueprintNodeRun>();
    for (const nodeRun of workspaceRunView?.nodeRuns ?? []) {
      map.set(nodeRun.nodeId, nodeRun);
    }
    return map;
  }, [workspaceRunView]);

  useEffect(() => {
    setLocalNodes((current) => mergeBlueprintFlowNodes(buildFlowNodes(blueprint, statusByNode, t), current));
  }, [statusByNode, t, blueprint]);

  useEffect(() => {
    setLocalEdges(buildFlowEdges(blueprint, workspaceEdgeRunStatus));
  }, [workspaceEdgeRunStatus, blueprint]);

  useEffect(() => {
    setBusinessViewport(blueprint?.display.viewport ?? defaultBlueprintViewport);
  }, [blueprint?.display.viewport?.x, blueprint?.display.viewport?.y, blueprint?.display.viewport?.zoom, blueprint?.id]);

  useEffect(() => {
    canvasExpansionRingsRef.current = canvasExpansionRings;
  }, [canvasExpansionRings]);

  useEffect(() => {
    canvasExpansionRingsRef.current = 0;
    setCanvasExpansionRings(0);
  }, [blueprint?.id]);

  useEffect(() => {
    setDrawerSelectedBlueprintId(blueprint?.id);
  }, [blueprint?.id]);

  const selectedDrawerBlueprint = useMemo(
    () => blueprints.find((item) => item.id === drawerSelectedBlueprintId),
    [blueprints, drawerSelectedBlueprintId]
  );
  const deleteCandidateBlueprint = useMemo(
    () => blueprints.find((item) => item.id === deleteCandidateBlueprintId),
    [blueprints, deleteCandidateBlueprintId]
  );
  const blueprintDrawerCopy = useMemo(() => {
    const english = t.navigation.blueprint === "Blueprint";
    return english
      ? {
          createAction: "New",
          importAction: "Import",
          exportAction: "Export",
          search: "Search blueprints",
          sort: "Sort",
          recent: "Recently used",
          usage: "Use count",
          created: "Newest created",
          nodes: "Node count",
          name: "A-Z",
          delete: "Delete blueprint",
          deleteTitle: "Delete blueprint?",
          deleteBody: (name: string) => `Delete "${name}"? This cannot be undone.`,
          cancel: "Cancel",
          confirmDelete: "Delete"
        }
      : {
          createAction: "新建",
          importAction: "导入",
          exportAction: "导出",
          search: "搜索蓝图",
          sort: "排序",
          recent: "最近使用",
          usage: "使用次数",
          created: "最新创建",
          nodes: "节点数量",
          name: "首字母",
          delete: "删除蓝图",
          deleteTitle: "删除蓝图？",
          deleteBody: (name: string) => `确定删除「${name}」吗？此操作无法撤销。`,
          cancel: "取消",
          confirmDelete: "删除"
        };
  }, [t.navigation.blueprint]);
  const boardCopy = useMemo(() => {
    const english = t.navigation.blueprint === "Blueprint";
    return english
      ? {
          architecture: "Architecture",
          business: "Business",
          architectureEmpty: "Create a business blueprint to generate its leader role.",
          ceo: "CEO",
          leader: "Leader",
          pending: "pending",
          latestRun: "latest run",
          noRun: "no runs",
          openBlueprint: "Open business blueprint"
        }
      : {
          architecture: "\u67b6\u6784\u84dd\u56fe",
          business: "\u4e1a\u52a1\u84dd\u56fe",
          architectureEmpty: "\u65b0\u5efa\u4e1a\u52a1\u84dd\u56fe\u540e\u4f1a\u751f\u6210\u5bf9\u5e94 Leader\u3002",
          ceo: "CEO",
          leader: "Leader",
          pending: "\u5f85\u5904\u7406",
          latestRun: "\u6700\u8fd1\u8fd0\u884c",
          noRun: "\u6682\u65e0\u8fd0\u884c",
          openBlueprint: "\u6253\u5f00\u4e1a\u52a1\u84dd\u56fe"
        };
  }, [t.navigation.blueprint]);
  const blueprintRunStats = useMemo(() => {
    const stats = new Map<string, { lastUsedAt: number; latestRunId?: string; latestStatus?: BlueprintRunSummary["status"]; usageCount: number }>();
    for (const run of runSummaries) {
      const current = stats.get(run.blueprintId) ?? { lastUsedAt: 0, usageCount: 0 };
      const startedAt = toTimestamp(run.startedAt);
      const isLatestRun = startedAt >= current.lastUsedAt;
      stats.set(run.blueprintId, {
        lastUsedAt: Math.max(current.lastUsedAt, startedAt),
        latestRunId: isLatestRun ? run.id : current.latestRunId,
        latestStatus: isLatestRun ? run.status : current.latestStatus,
        usageCount: current.usageCount + 1
      });
    }
    return stats;
  }, [runSummaries]);
  const visibleBlueprints = useMemo(() => {
    const query = blueprintSearch.trim().toLocaleLowerCase();
    const filtered = query
      ? blueprints.filter((item) => item.name.toLocaleLowerCase().includes(query))
      : blueprints;

    return filtered.slice().sort((left, right) => {
      const leftStats = blueprintRunStats.get(left.id);
      const rightStats = blueprintRunStats.get(right.id);
      if (blueprintSortMode === "recent") {
        return compareDescending(leftStats?.lastUsedAt ?? 0, rightStats?.lastUsedAt ?? 0) || compareBlueprintNames(left, right);
      }
      if (blueprintSortMode === "usage") {
        return compareDescending(leftStats?.usageCount ?? 0, rightStats?.usageCount ?? 0) || compareBlueprintNames(left, right);
      }
      if (blueprintSortMode === "created") {
        return compareDescending(toTimestamp(left.createdAt), toTimestamp(right.createdAt)) || compareBlueprintNames(left, right);
      }
      if (blueprintSortMode === "nodes") {
        return compareDescending(left.nodes.length, right.nodes.length) || compareBlueprintNames(left, right);
      }
      return compareBlueprintNames(left, right);
    });
  }, [blueprintRunStats, blueprintSearch, blueprintSortMode, blueprints]);
  const selectedSortLabel = useMemo(() => {
    if (blueprintSortMode === "recent") return blueprintDrawerCopy.recent;
    if (blueprintSortMode === "usage") return blueprintDrawerCopy.usage;
    if (blueprintSortMode === "created") return blueprintDrawerCopy.created;
    if (blueprintSortMode === "nodes") return blueprintDrawerCopy.nodes;
    return blueprintDrawerCopy.name;
  }, [blueprintDrawerCopy, blueprintSortMode]);
  const blueprintSortOptions = useMemo<BlueprintSelectOption[]>(
    () => [
      { value: "recent", label: blueprintDrawerCopy.recent },
      { value: "usage", label: blueprintDrawerCopy.usage },
      { value: "created", label: blueprintDrawerCopy.created },
      { value: "nodes", label: blueprintDrawerCopy.nodes },
      { value: "name", label: blueprintDrawerCopy.name }
    ],
    [blueprintDrawerCopy]
  );
  const currentBlueprintRunStats = blueprint ? blueprintRunStats.get(blueprint.id) : undefined;
  const currentBlueprintRunView = runView && blueprint && runView.run.blueprintId === blueprint.id ? runView : undefined;
  const currentBlueprintRawLatestStatus =
    currentBlueprintRunView?.run.status ?? currentBlueprintRunStats?.latestStatus;
  const currentBlueprintEffectiveStatus =
    currentBlueprintRunView ? resolveRunViewStatus(currentBlueprintRunView) : currentBlueprintRawLatestStatus;
  const currentBlueprintLatestStatus =
    currentBlueprintRunView ? resolveRunViewDisplayStatus(currentBlueprintRunView) : currentBlueprintRunStats?.latestStatus;
  const currentTerminalRunId =
    currentBlueprintRunStats?.latestRunId && isTerminalBlueprintRunStatus(currentBlueprintRawLatestStatus)
      ? currentBlueprintRunStats.latestRunId
      : undefined;
  const currentTerminalRunSeen = Boolean(currentTerminalRunId && acknowledgedTerminalRunIds.has(currentTerminalRunId));
  const currentBlueprintActivity = currentBlueprintLatestStatus
    ? resolveBlueprintActivityState(currentBlueprintLatestStatus, currentTerminalRunSeen)
    : "idle";
  const isBlueprintInteractionLocked = Boolean(currentBlueprintEffectiveStatus && isPollingRunStatus(currentBlueprintEffectiveStatus));
  const isRunButtonBusy = busyAction === "runBlueprint" || busyAction === "cancelBlueprintRun";
  const isRunButtonStopMode = isBlueprintInteractionLocked || busyAction === "cancelBlueprintRun";
  const runButtonTitle = isRunButtonStopMode ? t.actions.stopRun : t.actions.runBlueprint;
  const runButtonLabel = isRunButtonStopMode ? t.actions.stopRun : t.actions.run;
  const isSaveButtonBusy = busyAction === "saveBlueprint";
  const blueprintCanvasContentBounds = useMemo(
    () => buildBlueprintCanvasContentBounds(blueprintBoard === "architecture" ? architectureFlowNodes : localNodes),
    [architectureFlowNodes, blueprintBoard, localNodes]
  );
  const blueprintCanvasWorld = useMemo(
    () => createBlueprintCanvasWorld(canvasViewportSize, canvasExpansionRings, blueprintCanvasContentBounds),
    [blueprintCanvasContentBounds, canvasExpansionRings, canvasViewportSize.height, canvasViewportSize.width]
  );
  const expandBlueprintCanvasIfNeeded = useCallback(
    (viewport: BlueprintViewport) => {
      const currentWorld = createBlueprintCanvasWorld(canvasViewportSize, canvasExpansionRingsRef.current, blueprintCanvasContentBounds);
      if (!shouldExpandBlueprintCanvasWorld({ viewport, viewportSize: canvasViewportSize, canvasWorld: currentWorld })) return;
      const nextExpansionRings = canvasExpansionRingsRef.current + 1;
      canvasExpansionRingsRef.current = nextExpansionRings;
      setCanvasExpansionRings(nextExpansionRings);
    },
    [blueprintCanvasContentBounds, canvasViewportSize.height, canvasViewportSize.width]
  );
  const isCompactBlueprintCanvas = canvasViewportSize.width <= 760;
  const blueprintCornerStyle = useMemo<CSSProperties>(() => {
    const buttonSize = isCompactBlueprintCanvas ? 14 : 20;
    const gap = isCompactBlueprintCanvas ? 4 : 6;
    const switchHeight = isCompactBlueprintCanvas ? 32 : 37;
    const cornerHeight = buttonSize * 4;
    const miniMapWidth = Math.round(cornerHeight * (blueprintCanvasWorld.viewportWidth / blueprintCanvasWorld.viewportHeight));
    return {
      "--blueprint-corner-edge": `${gap}px`,
      "--blueprint-control-button-size": `${buttonSize}px`,
      "--blueprint-controls-width": `${buttonSize}px`,
      "--blueprint-corner-gap": `${gap}px`,
      "--blueprint-corner-height": `${cornerHeight}px`,
      "--blueprint-dock-height": `${switchHeight}px`,
      "--blueprint-switch-height": `${switchHeight}px`,
      "--blueprint-minimap-width": `${miniMapWidth}px`,
      "--blueprint-corner-stack-width": `${buttonSize + gap + miniMapWidth}px`
    } as CSSProperties;
  }, [blueprintCanvasWorld.viewportHeight, blueprintCanvasWorld.viewportWidth, isCompactBlueprintCanvas]);
  const openArchitectureBlueprint = useCallback(
    (blueprintId: string) => {
      onSelectBlueprint(blueprintId);
      setBlueprintBoard("business");
    },
    [onSelectBlueprint]
  );
  const generatedArchitectureFlowNodes = useMemo(
    () => buildArchitectureFlowNodes(architecture, roleDirectory, blueprints, boardCopy, openArchitectureBlueprint),
    [architecture, blueprints, boardCopy, openArchitectureBlueprint, roleDirectory]
  );
  const selectedArchitectureNode = useMemo(
    () => architectureFlowNodes.find((node) => node.id === selectedArchitectureNodeId),
    [architectureFlowNodes, selectedArchitectureNodeId]
  );
  const architectureFlowEdges = useMemo(
    () => buildArchitectureFlowEdges(architecture, architectureFlowNodes, blueprintCanvasWorld),
    [architecture, architectureFlowNodes, blueprintCanvasWorld]
  );

  useEffect(() => {
    setArchitectureFlowNodes((current) => mergeArchitectureFlowNodes(generatedArchitectureFlowNodes, current));
  }, [generatedArchitectureFlowNodes]);

  useEffect(() => {
    if (!selectedArchitectureNodeId) return;
    if (architectureFlowNodes.some((node) => node.id === selectedArchitectureNodeId)) return;
    setSelectedArchitectureNodeId(undefined);
  }, [architectureFlowNodes, selectedArchitectureNodeId]);

  const updateBlueprintDrawerAnchor = useCallback(() => {
    const button = blueprintSelectorButtonRef.current;
    const panel = canvasPanelRef.current;
    if (!button || !panel || isCompactBlueprintCanvas) {
      setBlueprintDrawerAnchor(undefined);
      return;
    }

    const buttonRect = button.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const nextAnchor: BlueprintDrawerAnchor = {
      left: Math.round(buttonRect.left - panelRect.left),
      width: Math.round(buttonRect.width),
      bottom: Math.round(panelRect.bottom - buttonRect.top + 8)
    };

    setBlueprintDrawerAnchor((current) =>
      current &&
      current.left === nextAnchor.left &&
      current.width === nextAnchor.width &&
      current.bottom === nextAnchor.bottom
        ? current
        : nextAnchor
    );
  }, [isCompactBlueprintCanvas]);
  const blueprintDrawerStyle = useMemo<CSSProperties | undefined>(() => {
    if (!blueprintDrawerAnchor || isCompactBlueprintCanvas) return undefined;
    return {
      left: blueprintDrawerAnchor.left,
      right: "auto",
      bottom: blueprintDrawerAnchor.bottom,
      width: blueprintDrawerAnchor.width
    };
  }, [blueprintDrawerAnchor, isCompactBlueprintCanvas]);
  const selectedBlueprintNodes = useMemo(() => {
    if (!blueprint || selectedCanvasNodeIds.length === 0) return [];
    const selectedIds = new Set(selectedCanvasNodeIds);
    return blueprint.nodes.filter((node) => selectedIds.has(node.id));
  }, [blueprint, selectedCanvasNodeIds]);
  const selectedAgentNodes = useMemo(
    () => selectedBlueprintNodes.filter((node): node is BlueprintNode & { type: "agent"; runtimeId: AgentRuntimeId; config: AgentNodeConfig } => node.type === "agent"),
    [selectedBlueprintNodes]
  );
  const canBatchEditSelectedAgents = selectedAgentNodes.length > 1;

  useEffect(() => {
    if (!batchEditorOpen || canBatchEditSelectedAgents) return;
    setBatchEditorOpen(false);
  }, [batchEditorOpen, canBatchEditSelectedAgents]);

  const rememberAcknowledgedTerminalRunId = useCallback((runId: string) => {
    if (acknowledgedTerminalRunIdsRef.current.has(runId)) return;
    const next = new Set(acknowledgedTerminalRunIdsRef.current);
    next.add(runId);
    acknowledgedTerminalRunIdsRef.current = next;
    writeAcknowledgedTerminalRunIds(getBrowserStorage(), next);
    setAcknowledgedTerminalRunIds(next);
  }, []);

  useEffect(() => {
    if (!blueprint) return;
    if (hasDuplicateNodeIds(blueprint)) {
      onUpdateBlueprint((current) => (current.id === blueprint.id ? ensureUniqueBlueprintNodeIds(current) : current));
      return;
    }
  }, [onUpdateBlueprint, blueprint]);

  useEffect(() => {
    currentTerminalRunIdRef.current = currentTerminalRunId;
  }, [currentTerminalRunId]);

  useEffect(() => {
    return () => {
      if (currentTerminalRunId) {
        rememberAcknowledgedTerminalRunId(currentTerminalRunId);
      }
    };
  }, [currentTerminalRunId, rememberAcknowledgedTerminalRunId]);

  useEffect(() => {
    const handlePageHide = () => {
      if (currentTerminalRunIdRef.current) {
        rememberAcknowledgedTerminalRunId(currentTerminalRunIdRef.current);
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [rememberAcknowledgedTerminalRunId]);

  useEffect(() => {
    acknowledgedTerminalRunIdsRef.current = acknowledgedTerminalRunIds;
    writeAcknowledgedTerminalRunIds(getBrowserStorage(), acknowledgedTerminalRunIds);
  }, [acknowledgedTerminalRunIds]);

  useEffect(() => {
    if (runSummaries.length === 0) return;
    const runIds = new Set(runSummaries.map((run) => run.id));
    setAcknowledgedTerminalRunIds((current) => {
      const next = new Set([...current].filter((runId) => runIds.has(runId)));
      acknowledgedTerminalRunIdsRef.current = next;
      return next.size === current.size ? current : next;
    });
  }, [runSummaries]);

  useEffect(() => {
    const element = canvasPanelRef.current;
    if (!element) return;

    const updateCanvasViewportSize = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width <= 0 || height <= 0) return;
      setCanvasViewportSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };

    updateCanvasViewportSize();
    const observer = new ResizeObserver(updateCanvasViewportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!blueprintDrawerOpen) return;
    updateBlueprintDrawerAnchor();
  }, [
    blueprintDrawerOpen,
    canBatchEditSelectedAgents,
    canvasViewportSize.height,
    canvasViewportSize.width,
    isCompactBlueprintCanvas,
    updateBlueprintDrawerAnchor
  ]);

  const patchNodeConfig = useCallback(
    (nodeId: string, patch: Partial<BlueprintNode["config"]>) => {
      if (isBlueprintInteractionLocked) return;
      onUpdateBlueprint((current) => {
        const normalizedPatch =
          (patch as Partial<ManagerSlotNodeConfig>).executionMode === "parallel" &&
          (patch as Partial<ManagerSlotNodeConfig>).parallelLaneCount === undefined
            ? ({
                ...patch,
                parallelLaneCount: 1
              } as Partial<BlueprintNode["config"]>)
            : patch;
        const currentNode = current.nodes.find((node) => node.id === nodeId);
        const isManagerSlotAssignmentPatch =
          currentNode?.type === "manager_slot" && ("managerNodeId" in normalizedPatch || "slot" in normalizedPatch);
        if (isManagerSlotAssignmentPatch) {
          const currentSlotConfig = currentNode.config as ManagerSlotNodeConfig;
          const nextSlotConfig = {
            ...currentSlotConfig,
            ...normalizedPatch
          } as ManagerSlotNodeConfig;
          const patchedBlueprint: BlueprintDefinition = {
            ...current,
            nodes: current.nodes.map((node) =>
              node.id === nodeId
                ? {
                    ...node,
                    config: nextSlotConfig
                  }
                : node
            )
          };
          if (!nextSlotConfig.managerNodeId) {
            return {
              ...patchedBlueprint,
              edges: patchedBlueprint.edges.filter((edge) => !isManagerSlotAssignmentEdge(edge, nodeId))
            };
          }
          const managerNode = patchedBlueprint.nodes.find((node) => node.id === nextSlotConfig.managerNodeId && node.type === "manager");
          const slotNode = patchedBlueprint.nodes.find((node) => node.id === nodeId && node.type === "manager_slot");
          if (managerNode && slotNode) {
            return applyManagerSlotAssignment(
              patchedBlueprint,
              {
                managerNode,
                slotNode,
                slot: nextSlotConfig.slot
              },
              t
            );
          }
          return patchedBlueprint;
        }
        const next = {
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === nodeId
              ? {
                  ...node,
                  config: {
                    ...node.config,
                    ...normalizedPatch
                  } as BlueprintNode["config"]
                }
              : node
          )
        };
        return next;
      });
    },
    [isBlueprintInteractionLocked, onUpdateBlueprint, t]
  );

  const patchSelectedAgentNodes = useCallback(
    (
      nodeIds: string[],
      runtimeId: AgentRuntimeId | undefined,
      configPatch: Partial<AgentNodeConfig>
    ) => {
      if (isBlueprintInteractionLocked || nodeIds.length === 0) return;
      const selectedIds = new Set(nodeIds);
      const agentOptions = configuredAgents ?? [];
      onUpdateBlueprint((current) => ({
        ...current,
        nodes: current.nodes.map((node) => {
          if (!selectedIds.has(node.id) || node.type !== "agent") return node;
          const runtimeConfigPatch = runtimeId
            ? buildRuntimeConfigPatch(node.config as AgentNodeConfig, runtimeId, agentOptions, harnessPermissionModes)
            : {};
          return {
            ...node,
            runtimeId: runtimeId ?? node.runtimeId,
            config: {
              ...node.config,
              ...runtimeConfigPatch,
              ...configPatch
            } as AgentNodeConfig
          };
        })
      }));
    },
    [configuredAgents, harnessPermissionModes, isBlueprintInteractionLocked, onUpdateBlueprint]
  );

  const patchNode = useCallback(
    (nodeId: string, patch: Partial<BlueprintNode>) => {
      if (isBlueprintInteractionLocked) return;
      onUpdateBlueprint((current) => ({
        ...current,
        nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node))
      }));
    },
    [isBlueprintInteractionLocked, onUpdateBlueprint]
  );

  const onNodesChange: OnNodesChange<Node<BlueprintNodeCardData>> = useCallback(
    (changes) => {
      const allowedChanges = isBlueprintInteractionLocked ? changes.filter((change) => change.type === "select") : changes;
      if (allowedChanges.length === 0) return;
      setLocalNodes((current) => applyNodeChanges(allowedChanges, current));
      if (isBlueprintInteractionLocked) return;
      const positionChanges = collectBlueprintNodePositionChanges(changes);
      const sizeChanges = collectManagerSlotSizeChanges(changes);
      if (positionChanges.size === 0 && sizeChanges.size === 0) return;
      onUpdateBlueprint((current) => {
        const blueprintWithPositions = updateBlueprintNodePositions(current, positionChanges);
        return resizeManagerSlotNodes(blueprintWithPositions, sizeChanges);
      });
    },
    [isBlueprintInteractionLocked, onUpdateBlueprint]
  );

  const onArchitectureNodesChange: OnNodesChange<Node<ArchitectureRoleNodeData>> = useCallback(
    (changes) => {
      setArchitectureFlowNodes((current) => applyNodeChanges(changes, current));
      const positionChanges = collectArchitectureNodePositionChanges(changes);
      if (positionChanges.size === 0) return;
      onUpdateArchitectureLayout(Object.fromEntries(positionChanges));
    },
    [onUpdateArchitectureLayout]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (isBlueprintInteractionLocked) return;
      if (!connection.source || !connection.target) return;
      onUpdateBlueprint((current) => {
        if (!isBlueprintConnectionAllowed(current, connection)) return current;
        return connectBlueprintNodes(current, connection, t);
      });
    },
    [isBlueprintInteractionLocked, onUpdateBlueprint, t]
  );

  const addNode = useCallback(
    (type: BlueprintNodeType) => {
      if (isBlueprintInteractionLocked) return;
      onUpdateBlueprint((current) => {
        const blueprintWithUniqueIds = ensureUniqueBlueprintNodeIds(current);
        const selectedSlot =
          selectedNodeId ? blueprintWithUniqueIds.nodes.find((node) => node.id === selectedNodeId && node.type === "manager_slot") : undefined;
        const nodeSize = initialBlueprintNodeSize(type);
        const topLevelPosition = resolveViewportCenterNodePosition(
          businessViewport,
          canvasViewportSize,
          nodeSize,
          blueprintCanvasWorld.extent
        );
        if (type === "manager_slot") {
          return addManagerSlotFromMenu(blueprintWithUniqueIds, selectedNodeId, topLevelPosition, t);
        }
        const shouldNest = Boolean(selectedSlot && type !== "manager");
        const id = nextBlueprintNodeId(blueprintWithUniqueIds, type, shouldNest ? selectedSlot?.id : undefined);
        const node: BlueprintNode = {
          id,
          type,
          runtimeId: type === "agent" || type === "manager" ? "openclaw" : undefined,
          parentId: shouldNest ? selectedSlot?.id : undefined,
          position: shouldNest
            ? managerSlotChildCenterPosition(selectedSlot!, nodeSize)
            : topLevelPosition,
          config: defaultConfig(type, t)
        };
        const next = {
          ...blueprintWithUniqueIds,
          nodes: [...blueprintWithUniqueIds.nodes, node]
        };
        return next;
      });
      setNodeMenuOpen(false);
    },
    [blueprintCanvasWorld.extent, businessViewport, canvasViewportSize, isBlueprintInteractionLocked, onUpdateBlueprint, selectedNodeId, t]
  );

  const openNodeMenuAt = useCallback(
    (x: number, y: number, placement?: "above") => {
      if (isBlueprintInteractionLocked) return;
      setNodeMenuAnchor({ x, y, placement });
      setNodeContextMenu((current) => (current.open ? { ...current, open: false } : current));
      setNodeMenuOpen(true);
    },
    [isBlueprintInteractionLocked]
  );

  const closeNodeMenu = useCallback(() => {
    setNodeMenuOpen(false);
  }, []);

  const closeNodeContextMenu = useCallback(() => {
    setNodeContextMenu({ open: false, x: 0, y: 0, nodeId: undefined });
  }, []);

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      if (isBlueprintInteractionLocked) return;
      if (connectionState.toNode || connectionState.toHandle) return;
      const point = getConnectionEndPoint(event);
      if (!point) return;
      const { x, y } = getMenuPoint(point);
      closeNodeContextMenu();
      setInspectedNodeId(undefined);
      suppressNextPaneClickRef.current = true;
      openNodeMenuAt(x, y);
    },
    [closeNodeContextMenu, isBlueprintInteractionLocked, openNodeMenuAt]
  );

  const clearCanvasSelection = useCallback(() => {
    setSelectedCanvasNodeIdsIfChanged([]);
    setLocalNodes((current) => {
      if (!current.some((node) => node.selected)) return current;
      return current.map((node) => (node.selected ? { ...node, selected: false } : node));
    });
    onSelectNode(undefined);
  }, [onSelectNode, setSelectedCanvasNodeIdsIfChanged]);

  const clearArchitectureSelection = useCallback(() => {
    setSelectedArchitectureNodeId(undefined);
    setArchitectureFlowNodes((current) => {
      if (!current.some((node) => node.selected)) return current;
      return current.map((node) => (node.selected ? { ...node, selected: false } : node));
    });
  }, []);

  useEffect(() => {
    const hasFloatingUi =
      nodeMenuOpen ||
      nodeContextMenu.open ||
      blueprintDrawerOpen ||
      Boolean(blueprintCardContextMenu) ||
      Boolean(deleteCandidateBlueprintId) ||
      Boolean(selectedNodeId) ||
      Boolean(selectedArchitectureNodeId) ||
      selectedCanvasNodeIds.length > 0;
    if (!hasFloatingUi) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const isInsideNodeMenu = Boolean(nodeMenuRef.current?.contains(target));
      const isInsideNodeMenuButton = Boolean(nodeMenuButtonRef.current?.contains(target));
      if (nodeMenuOpen && !isInsideNodeMenu && !isInsideNodeMenuButton) {
        closeNodeMenu();
      }

      const isInsideNodeContextMenu = Boolean(nodeContextMenuRef.current?.contains(target));
      if (nodeContextMenu.open && !isInsideNodeContextMenu) {
        closeNodeContextMenu();
      }

      const isInsideBlueprintDrawer = Boolean(blueprintDrawerRef.current?.contains(target));
      const isInsideBlueprintSelectorButton = Boolean(blueprintSelectorButtonRef.current?.contains(target));
      const isInsideBlueprintCardContextMenu = Boolean(blueprintCardContextMenuRef.current?.contains(target));
      const isInsideDeleteDialog = Boolean(deleteDialogRef.current?.contains(target));
      if (
        blueprintDrawerOpen &&
        !isInsideBlueprintDrawer &&
        !isInsideBlueprintSelectorButton &&
        !isInsideBlueprintCardContextMenu &&
        !isInsideDeleteDialog
      ) {
        setBlueprintDrawerOpen(false);
        setBlueprintCardContextMenu(undefined);
      }
      if (blueprintCardContextMenu && !isInsideBlueprintCardContextMenu) {
        setBlueprintCardContextMenu(undefined);
      }
      if (deleteCandidateBlueprintId && !isInsideDeleteDialog) {
        setDeleteCandidateBlueprintId(undefined);
      }

      if (
        (selectedNodeId || selectedArchitectureNodeId || selectedCanvasNodeIds.length > 0) &&
        !target.closest(".react-flow__node") &&
        !target.closest(".node-modal") &&
        !target.closest(".node-menu-popover") &&
        !target.closest(".node-context-menu")
      ) {
        clearCanvasSelection();
        clearArchitectureSelection();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [
    blueprintCardContextMenu,
    blueprintDrawerOpen,
    clearArchitectureSelection,
    clearCanvasSelection,
    closeNodeContextMenu,
    closeNodeMenu,
    deleteCandidateBlueprintId,
    nodeContextMenu.open,
    nodeMenuOpen,
    selectedArchitectureNodeId,
    selectedCanvasNodeIds.length,
    selectedNodeId
  ]);

  useEffect(() => {
    if (!isBlueprintInteractionLocked) return;
    setInspectedNodeId(undefined);
    setBatchEditorOpen(false);
    closeNodeMenu();
    closeNodeContextMenu();
    rightDragStateRef.current = undefined;
    suppressNextPaneClickRef.current = false;
  }, [closeNodeContextMenu, closeNodeMenu, isBlueprintInteractionLocked]);

  const openDockNodeMenu = useCallback(
    (button: HTMLButtonElement) => {
      if (nodeMenuOpen) {
        closeNodeMenu();
        return;
      }
      const rect = button.getBoundingClientRect();
      const dockRect = button.closest(".blueprint-action-dock")?.getBoundingClientRect();
      const x = Math.max(nodeMenuViewportMargin, Math.min(rect.left, window.innerWidth - nodeMenuPopoverWidth - nodeMenuViewportMargin));
      openNodeMenuAt(x, (dockRect?.top ?? rect.top) - 8, "above");
    },
    [closeNodeMenu, nodeMenuOpen, openNodeMenuAt]
  );

  const toggleBlueprintDrawer = useCallback(() => {
    if (blueprintDrawerOpen) {
      setBlueprintDrawerOpen(false);
      setBlueprintCardContextMenu(undefined);
      return;
    }
    setDrawerSelectedBlueprintId(blueprint?.id ?? blueprints[0]?.id);
    setBlueprintDrawerOpen(true);
    setBlueprintCardContextMenu(undefined);
    closeNodeMenu();
    closeNodeContextMenu();
    updateBlueprintDrawerAnchor();
  }, [blueprint?.id, blueprintDrawerOpen, blueprints, closeNodeContextMenu, closeNodeMenu, updateBlueprintDrawerAnchor]);

  const selectBlueprintCard = useCallback(
    (blueprintId: string) => {
      setDrawerSelectedBlueprintId(blueprintId);
      setBlueprintCardContextMenu(undefined);
      onSelectBlueprint(blueprintId);
      closeNodeMenu();
      closeNodeContextMenu();
    },
    [closeNodeContextMenu, closeNodeMenu, onSelectBlueprint]
  );

  const activateBlueprintCardFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, blueprintId: string) => {
      if (
        !shouldActivateBlueprintCardPointer({
          button: event.button,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          defaultPrevented: event.defaultPrevented
        })
      ) {
        return;
      }
      selectBlueprintCard(blueprintId);
    },
    [selectBlueprintCard]
  );

  const activateBlueprintCardFromKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, blueprintId: string) => {
      if (!isBlueprintCardKeyboardActivationKey(event.key)) return;
      event.preventDefault();
      selectBlueprintCard(blueprintId);
    },
    [selectBlueprintCard]
  );

  const openBlueprintCardContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>, blueprintId: string) => {
      event.preventDefault();
      event.stopPropagation();
      setDrawerSelectedBlueprintId(blueprintId);
      setBlueprintCardContextMenu({ x: event.clientX + 4, y: event.clientY + 4, blueprintId });
      closeNodeMenu();
      closeNodeContextMenu();
    },
    [closeNodeContextMenu, closeNodeMenu]
  );

  const exportSelectedBlueprint = useCallback(() => {
    if (!selectedDrawerBlueprint) return;
    setBlueprintCardContextMenu(undefined);
    onExportBlueprint(selectedDrawerBlueprint.id);
  }, [onExportBlueprint, selectedDrawerBlueprint]);

  const confirmDeleteBlueprint = useCallback(() => {
    if (!deleteCandidateBlueprint) return;
    onDeleteBlueprint(deleteCandidateBlueprint.id);
    setDeleteCandidateBlueprintId(undefined);
    setBlueprintCardContextMenu(undefined);
    if (drawerSelectedBlueprintId === deleteCandidateBlueprint.id) {
      setDrawerSelectedBlueprintId(undefined);
    }
  }, [deleteCandidateBlueprint, drawerSelectedBlueprintId, onDeleteBlueprint]);

  const deleteNodeById = useCallback(
    (nodeId: string) => {
      if (isBlueprintInteractionLocked) return;
      onUpdateBlueprint((current) => {
        const deleteIds = collectDeletedNodeIds(current, new Set([nodeId]));
        return {
          ...current,
          nodes: current.nodes.filter((node) => !deleteIds.has(node.id)),
          edges: current.edges.filter((edge) => !deleteIds.has(edge.source) && !deleteIds.has(edge.target))
        };
      });
      setLocalNodes((current) => {
        const deleteIds = new Set([nodeId]);
        return current.filter((node) => !deleteIds.has(node.id) && node.parentId !== nodeId);
      });
      setLocalEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
      if (selectedNodeId === nodeId) onSelectNode(undefined);
      if (inspectedNodeId === nodeId) setInspectedNodeId(undefined);
      setSelectedCanvasNodeIdsIfChanged([]);
      closeNodeContextMenu();
    },
    [closeNodeContextMenu, inspectedNodeId, isBlueprintInteractionLocked, onSelectNode, onUpdateBlueprint, selectedNodeId, setSelectedCanvasNodeIdsIfChanged]
  );

  const toggleNodeDisabled = useCallback(
    (nodeId: string) => {
      if (isBlueprintInteractionLocked) return;
      onUpdateBlueprint((current) => ({
        ...current,
        nodes: current.nodes.map((node) => (node.id === nodeId ? { ...node, disabled: !node.disabled } : node))
      }));
      closeNodeContextMenu();
    },
    [closeNodeContextMenu, isBlueprintInteractionLocked, onUpdateBlueprint]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (isBlueprintInteractionLocked) return;
      if (selectedCanvasNodeIds.length === 0) return;

      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      const selectedSet = new Set(selectedCanvasNodeIds);

      onUpdateBlueprint((current) => {
        const deleteIds = collectDeletedNodeIds(current, selectedSet);
        return {
          ...current,
          nodes: current.nodes.filter((node) => !deleteIds.has(node.id)),
          edges: current.edges.filter((edge) => !deleteIds.has(edge.source) && !deleteIds.has(edge.target))
        };
      });

      if (selectedNodeId && selectedSet.has(selectedNodeId)) {
        onSelectNode(undefined);
      }
      if (inspectedNodeId && selectedSet.has(inspectedNodeId)) {
        setInspectedNodeId(undefined);
      }

      setSelectedCanvasNodeIdsIfChanged([]);
      closeNodeContextMenu();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    closeNodeContextMenu,
    inspectedNodeId,
    isBlueprintInteractionLocked,
    onSelectNode,
    onUpdateBlueprint,
    selectedCanvasNodeIds,
    selectedNodeId,
    setSelectedCanvasNodeIdsIfChanged
  ]);

  const onNodeClick: NodeMouseHandler<Node<BlueprintNodeCardData>> = useCallback(
    (event, node) => {
      closeNodeMenu();
      closeNodeContextMenu();
      if (node.data.type === "manager_slot" && isManagerSlotInnerFrameContext(event)) {
        if (selectedNodeId !== node.id) {
          setSelectedCanvasNodeIdsIfChanged([node.id]);
          onSelectNode(node.id);
        }
        setInspectedNodeId(undefined);
        return;
      }
      if (selectedNodeId === node.id) {
        setSelectedCanvasNodeIdsIfChanged([node.id]);
        return;
      }
      setSelectedCanvasNodeIdsIfChanged([node.id]);
      onSelectNode(node.id);
      setInspectedNodeId(undefined);
    },
    [closeNodeContextMenu, closeNodeMenu, isBlueprintInteractionLocked, onSelectNode, selectedNodeId, setSelectedCanvasNodeIdsIfChanged]
  );

  const onNodeContextMenu: NodeMouseHandler<Node<BlueprintNodeCardData>> = useCallback(
    (event, node) => {
      event.preventDefault();
      event.stopPropagation();
      rightDragStateRef.current = undefined;
      const { x, y } = getMenuPoint(event);
      setSelectedCanvasNodeIdsIfChanged([node.id]);
      onSelectNode(node.id);
      setInspectedNodeId(undefined);
      if (isBlueprintInteractionLocked) {
        closeNodeContextMenu();
        closeNodeMenu();
        return;
      }
      if (node.data.type === "manager_slot" && isManagerSlotInnerFrameContext(event)) {
        closeNodeContextMenu();
        openNodeMenuAt(x, y);
        return;
      }
      closeNodeMenu();
      setNodeContextMenu({
        open: true,
        x,
        y,
        nodeId: node.id
      });
    },
    [closeNodeContextMenu, closeNodeMenu, isBlueprintInteractionLocked, onSelectNode, openNodeMenuAt, setSelectedCanvasNodeIdsIfChanged]
  );

  const onEdgeClick: EdgeMouseHandler<Edge> = useCallback(
    (event, edge) => {
      if (isBlueprintInteractionLocked) return;
      if (!event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      setLocalEdges((current) => current.filter((item) => item.id !== edge.id));
      onUpdateBlueprint((current) => ({
        ...current,
        edges: current.edges.filter((item) => item.id !== edge.id)
      }));
    },
    [isBlueprintInteractionLocked, onUpdateBlueprint]
  );

  if (blueprintBoard === "architecture") {
    return (
      <ReactFlowProvider>
        <section className="blueprint-shell compact-blueprint-shell">
          <section
            ref={canvasPanelRef}
            className="blueprint-canvas-panel expanded-blueprint-panel architecture-blueprint-shell"
            style={blueprintCornerStyle}
          >
            <ReactFlow
              nodes={architectureFlowNodes}
              edges={architectureFlowEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              translateExtent={blueprintCanvasWorld.extent}
              nodeExtent={blueprintCanvasWorld.extent}
              onMove={(_event, viewport) => expandBlueprintCanvasIfNeeded(viewport)}
              onNodeClick={(_event, node) => setSelectedArchitectureNodeId(node.id)}
              onPaneClick={clearArchitectureSelection}
              onSelectionChange={({ nodes }) => setSelectedArchitectureNodeId(nodes.length === 1 ? nodes[0]?.id : undefined)}
              onNodesChange={onArchitectureNodesChange}
              nodesDraggable
              nodesConnectable={false}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              panOnDrag={[1, 2]}
              deleteKeyCode={null}
              minZoom={0.35}
              maxZoom={1.5}
              fitView
              fitViewOptions={{ padding: 0.28 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="var(--architecture-grid-line)" gap={36} lineWidth={1} variant={BackgroundVariant.Lines} />
              <BlueprintCornerStack
                board={blueprintBoard}
                copy={boardCopy}
                canvasWorld={blueprintCanvasWorld}
                nodes={architectureFlowNodes}
                style={blueprintCornerStyle}
                onChange={setBlueprintBoard}
              />
            </ReactFlow>
            {selectedArchitectureNode && (
              <ArchitectureRoleDetailSidebar
                node={selectedArchitectureNode}
                onClose={clearArchitectureSelection}
                onOpenBlueprint={openArchitectureBlueprint}
              />
            )}
          </section>
        </section>
      </ReactFlowProvider>
    );
  }

  return (
    <ReactFlowProvider>
      <section className="blueprint-shell compact-blueprint-shell">
        <section
          ref={canvasPanelRef}
          className={`blueprint-canvas-panel expanded-blueprint-panel blueprint-canvas-state-${currentBlueprintActivity}`}
          style={blueprintCornerStyle}
          onPointerDownCapture={(event) => {
            if (isBlueprintInteractionLocked) return;
            if (event.button !== 2) return;
            rightDragStateRef.current = {
              x: event.clientX,
              y: event.clientY,
              moved: false,
              openedMenu: false
            };
          }}
          onPointerMoveCapture={(event) => {
            if (isBlueprintInteractionLocked) return;
            const state = rightDragStateRef.current;
            if (!state || (event.buttons & 2) !== 2) return;
            if (Math.hypot(event.clientX - state.x, event.clientY - state.y) > rightButtonDragThreshold) {
              state.moved = true;
            }
          }}
          onPointerUpCapture={(event) => {
            if (isBlueprintInteractionLocked) return;
            if (event.button !== 2) return;
            const state = rightDragStateRef.current;
            if (!state || state.moved || state.openedMenu || !isPaneAddMenuTarget(event.target)) return;
            state.openedMenu = true;
            const { x, y } = getMenuPoint(event);
            closeNodeContextMenu();
            setInspectedNodeId(undefined);
            openNodeMenuAt(x, y);
          }}
          onContextMenuCapture={(event) => {
            event.preventDefault();
            if (isBlueprintInteractionLocked) {
              event.stopPropagation();
              rightDragStateRef.current = undefined;
              closeNodeContextMenu();
              closeNodeMenu();
              setInspectedNodeId(undefined);
              return;
            }
            if (rightDragStateRef.current?.moved) {
              event.stopPropagation();
              rightDragStateRef.current = undefined;
              closeNodeContextMenu();
              closeNodeMenu();
              setInspectedNodeId(undefined);
            }
          }}
        >
          <ReactFlow
            key={blueprint?.id ?? "empty-blueprint"}
            nodes={localNodes}
            edges={localEdges}
            nodeTypes={nodeTypes}
            defaultViewport={blueprint?.display.viewport ?? defaultBlueprintViewport}
            translateExtent={blueprintCanvasWorld.extent}
            nodeExtent={blueprintCanvasWorld.extent}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeClick={onEdgeClick}
            onConnectEnd={onConnectEnd}
            onMove={(_event, viewport) => expandBlueprintCanvasIfNeeded(viewport)}
            onMoveEnd={(_event, viewport) => {
              setBusinessViewport(viewport);
            }}
            onPaneClick={() => {
              if (suppressNextPaneClickRef.current) {
                suppressNextPaneClickRef.current = false;
                return;
              }
              setSelectedCanvasNodeIdsIfChanged([]);
              onSelectNode(undefined);
              closeNodeMenu();
              closeNodeContextMenu();
              setInspectedNodeId(undefined);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              const rightDragState = rightDragStateRef.current;
              rightDragStateRef.current = undefined;
              if (isBlueprintInteractionLocked) {
                closeNodeContextMenu();
                closeNodeMenu();
                setInspectedNodeId(undefined);
                return;
              }
              if (rightDragState?.moved) {
                closeNodeContextMenu();
                closeNodeMenu();
                setInspectedNodeId(undefined);
                return;
              }
              const { x, y } = getMenuPoint(event);
              closeNodeContextMenu();
              setInspectedNodeId(undefined);
              openNodeMenuAt(x, y);
            }}
            onSelectionChange={({ nodes }) => {
              const nodeIds = nodes.map((node) => node.id);
              setSelectedCanvasNodeIdsIfChanged(nodeIds);
              onSelectNode(nodeIds.length === 1 ? nodeIds[0] : undefined);
            }}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            isValidConnection={(connection) => Boolean(blueprint && isBlueprintConnectionAllowed(blueprint, connection))}
            nodesDraggable={!isBlueprintInteractionLocked}
            nodesConnectable={!isBlueprintInteractionLocked}
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnDrag={[1, 2]}
            deleteKeyCode={null}
            minZoom={0.35}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={2} />
            <BlueprintCornerStack
              board={blueprintBoard}
              copy={boardCopy}
              canvasWorld={blueprintCanvasWorld}
              nodes={localNodes}
              style={blueprintCornerStyle}
              onChange={setBlueprintBoard}
            />
          </ReactFlow>

          <div className="blueprint-action-dock" aria-label={t.navigation.blueprint}>
            <button
              className="primary-action blueprint-run-button"
              type="button"
              title={runButtonTitle}
              onClick={isRunButtonStopMode ? onCancelBlueprintRun : onRunBlueprint}
              disabled={!blueprint || busy}
            >
              {isRunButtonBusy ? <Loader2 className="spin" size={16} /> : isRunButtonStopMode ? <Square size={16} /> : <Play size={16} />}
              {runButtonLabel}
            </button>
            <button
              type="button"
              className={`blueprint-dock-save${blueprintDirty ? " dirty" : ""}`}
              title={t.actions.saveBlueprint}
              onClick={onSaveBlueprint}
              disabled={!blueprint || busy || isBlueprintInteractionLocked || !blueprintDirty}
            >
              {isSaveButtonBusy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
              <span>{t.actions.save}</span>
            </button>
            <button
              ref={nodeMenuButtonRef}
              type="button"
              className="blueprint-dock-add"
              title={t.actions.add}
              onClick={(event) => openDockNodeMenu(event.currentTarget)}
              disabled={!blueprint || busy || isBlueprintInteractionLocked}
            >
              <Plus size={18} />
            </button>
            {canBatchEditSelectedAgents && (
              <button
                type="button"
                className="blueprint-dock-batch"
                title="Batch agent settings"
                onClick={() => setBatchEditorOpen(true)}
                disabled={busy || isBlueprintInteractionLocked}
              >
                <Settings2 size={16} />
                <span>{selectedAgentNodes.length}</span>
              </button>
            )}
            <button
              ref={blueprintSelectorButtonRef}
              type="button"
              className="blueprint-selector-button"
              title={t.fields.blueprint}
              onClick={toggleBlueprintDrawer}
              disabled={isBlueprintSelectorDisabled({ busy, selectedCompanyId })}
            >
              <LayoutTemplate size={16} />
              <span>{blueprint?.name ?? t.empty.selectBlueprint}</span>
            </button>
          </div>

          {blueprintDrawerOpen && (
            <aside ref={blueprintDrawerRef} className="blueprint-side-panel" style={blueprintDrawerStyle} aria-label={t.navigation.blueprint}>
              <div className="blueprint-side-panel-header">
                <div className="blueprint-side-panel-title">
                  <strong>{t.navigation.blueprint}</strong>
                </div>
                <div className="blueprint-side-panel-actions">
                  <button type="button" title={t.actions.createBlueprint} onClick={onCreateBlueprint} disabled={!selectedCompanyId || busy}>
                    {busyAction === "createBlueprint" ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                    <span>{blueprintDrawerCopy.createAction}</span>
                  </button>
                  <button type="button" title={t.actions.importBlueprint} onClick={onOpenBlueprintImport} disabled={!selectedCompanyId || busy}>
                    {busyAction === "importBlueprint" ? <Loader2 className="spin" size={14} /> : <Upload size={14} />}
                    <span>{blueprintDrawerCopy.importAction}</span>
                  </button>
                  <button
                    type="button"
                    title={t.actions.exportBlueprint}
                    onClick={exportSelectedBlueprint}
                    disabled={!selectedDrawerBlueprint || busy}
                  >
                    {busyAction === "exportBlueprint" ? <Loader2 className="spin" size={14} /> : <Download size={14} />}
                    <span>{blueprintDrawerCopy.exportAction}</span>
                  </button>
                </div>
              </div>
              <div className="blueprint-side-panel-tools">
                <label className="blueprint-search-field">
                  <Search size={14} />
                  <input
                    type="search"
                    value={blueprintSearch}
                    onChange={(event) => setBlueprintSearch(event.target.value)}
                    placeholder={blueprintDrawerCopy.search}
                  />
                </label>
                <div className="blueprint-sort-button" title={`${blueprintDrawerCopy.sort}: ${selectedSortLabel}`}>
                  <ArrowUpDown size={15} />
                  <BlueprintSelect
                    ariaLabel={blueprintDrawerCopy.sort}
                    value={blueprintSortMode}
                    options={blueprintSortOptions}
                    className="blueprint-sort-select"
                    onChange={(value) => setBlueprintSortMode(value as BlueprintSortMode)}
                  />
                </div>
              </div>
              <div className="blueprint-card-list">
                {visibleBlueprints.length === 0 ? (
                  <div className="empty-state compact-empty-state">{t.empty.selectBlueprint}</div>
                ) : (
                  visibleBlueprints.map((item) => {
                    const selected = item.id === drawerSelectedBlueprintId;
                    const stats = blueprintRunStats.get(item.id);
                    const terminalStatusSeen = stats?.latestRunId ? acknowledgedTerminalRunIds.has(stats.latestRunId) : false;
                    const activity = resolveBlueprintActivityState(stats?.latestStatus, terminalStatusSeen);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`blueprint-card-button blueprint-run-state-${activity}${selected ? " selected" : ""}`}
                        onPointerUp={(event) => activateBlueprintCardFromPointer(event, item.id)}
                        onKeyDown={(event) => activateBlueprintCardFromKeyboard(event, item.id)}
                        onContextMenu={(event) => openBlueprintCardContextMenu(event, item.id)}
                      >
                        <span className="blueprint-card-icon">
                          <LayoutTemplate size={17} />
                        </span>
                        <strong>{item.name}</strong>
                        {selected && <Check className="blueprint-card-check" size={14} />}
                      </button>
                    );
                  })
                )}
              </div>
            </aside>
          )}

          {blueprintCardContextMenu && (
            <div
              ref={blueprintCardContextMenuRef}
              className="blueprint-card-context-menu"
              style={{
                left: blueprintCardContextMenu.x,
                top: blueprintCardContextMenu.y
              }}
            >
              <button
                type="button"
                className="node-context-item danger"
                onClick={() => {
                  setDeleteCandidateBlueprintId(blueprintCardContextMenu.blueprintId);
                  setBlueprintCardContextMenu(undefined);
                }}
              >
                <Trash2 size={14} />
                {blueprintDrawerCopy.delete}
              </button>
            </div>
          )}

          {deleteCandidateBlueprint && (
            <div
              className="blueprint-delete-backdrop"
              role="dialog"
              aria-modal="true"
              aria-labelledby="blueprint-delete-title"
              onClick={() => setDeleteCandidateBlueprintId(undefined)}
            >
              <div ref={deleteDialogRef} className="blueprint-delete-dialog" onClick={(event) => event.stopPropagation()}>
                <div className="blueprint-delete-icon">
                  <Trash2 size={18} />
                </div>
                <div className="blueprint-delete-copy">
                  <strong id="blueprint-delete-title">{blueprintDrawerCopy.deleteTitle}</strong>
                  <p>{blueprintDrawerCopy.deleteBody(deleteCandidateBlueprint.name)}</p>
                </div>
                <div className="blueprint-delete-actions">
                  <button type="button" onClick={() => setDeleteCandidateBlueprintId(undefined)} disabled={busy}>
                    {blueprintDrawerCopy.cancel}
                  </button>
                  <button type="button" className="danger-action" onClick={confirmDeleteBlueprint} disabled={busy}>
                    {busyAction === "deleteBlueprint" ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                    {blueprintDrawerCopy.confirmDelete}
                  </button>
                </div>
              </div>
            </div>
          )}

          {nodeMenuOpen && blueprint && (
            <div
              ref={nodeMenuRef}
              className="node-menu-popover"
              style={{
                left: nodeMenuAnchor.x,
                top: nodeMenuAnchor.y,
                transform: nodeMenuAnchor.placement === "above" ? "translateY(-100%)" : undefined
              }}
            >
              <div className="node-menu-title">{t.panels.nodes}</div>
              <div className="node-menu-list">
                {palette.map((item) => {
                  const Icon = item.icon;
                  const label = t.nodeTypes[item.type];
                  return (
                    <button
                      key={item.type}
                      type="button"
                      className="node-menu-item"
                      title={`${t.actions.add} ${label}`}
                      onClick={() => addNode(item.type)}
                      disabled={busy}
                    >
                      <Icon size={15} />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {nodeContextMenu.open && nodeContextMenu.nodeId && (
            <div
              ref={nodeContextMenuRef}
              className="node-context-menu"
              style={{
                left: nodeContextMenu.x,
                top: nodeContextMenu.y
              }}
            >
              <button type="button" className="node-context-item" onClick={() => toggleNodeDisabled(nodeContextMenu.nodeId!)}>
                {blueprint?.nodes.find((node) => node.id === nodeContextMenu.nodeId)?.disabled ? t.actions.enableNode : t.actions.disableNode}
              </button>
              <button type="button" className="node-context-item danger" onClick={() => deleteNodeById(nodeContextMenu.nodeId!)}>
                {t.actions.deleteNode}
              </button>
            </div>
          )}
        </section>

        {inspectedNode && blueprint && !isBlueprintInteractionLocked && (
          <NodeDetailSidebar
            catalog={catalog}
            configuredAgents={configuredAgents}
            harnessStatuses={harnessStatuses}
            harnessPermissionModes={harnessPermissionModes}
            harnessSkillStatuses={harnessSkillStatuses}
            allNodes={blueprint.nodes}
            node={inspectedNode}
            t={t}
            onClose={() => {
              setInspectedNodeId(undefined);
              clearCanvasSelection();
            }}
            onPatchNode={(patch) => patchNode(inspectedNode.id, patch)}
            onPatchConfig={(patch) => patchNodeConfig(inspectedNode.id, patch)}
          />
        )}

        {batchEditorOpen && blueprint && !isBlueprintInteractionLocked && canBatchEditSelectedAgents && (
          <BatchAgentSettingsModal
            nodes={selectedAgentNodes}
            models={catalog?.models ?? []}
            configuredAgents={configuredAgents ?? []}
            harnessStatuses={harnessStatuses}
            t={t}
            onClose={() => setBatchEditorOpen(false)}
            onApply={(runtimeId, configPatch) => {
              patchSelectedAgentNodes(selectedAgentNodes.map((node) => node.id), runtimeId, configPatch);
              setBatchEditorOpen(false);
            }}
          />
        )}
      </section>
    </ReactFlowProvider>
  );
}

type BlueprintBoardCopy = {
  architecture: string;
  business: string;
  architectureEmpty: string;
  ceo: string;
  leader: string;
  pending: string;
  latestRun: string;
  noRun: string;
  openBlueprint: string;
};

function BlueprintBoardSwitch({
  board,
  copy,
  onChange
}: {
  board: "business" | "architecture";
  copy: BlueprintBoardCopy;
  onChange: (board: "business" | "architecture") => void;
}) {
  return (
    <div className="blueprint-board-switch" role="tablist" aria-label="Blueprint board">
      <button
        type="button"
        className={board === "architecture" ? "active" : ""}
        onClick={() => onChange("architecture")}
        aria-pressed={board === "architecture"}
      >
        <Network size={15} />
        {copy.architecture}
      </button>
      <button
        type="button"
        className={board === "business" ? "active" : ""}
        onClick={() => onChange("business")}
        aria-pressed={board === "business"}
      >
        <LayoutTemplate size={15} />
        {copy.business}
      </button>
    </div>
  );
}

function BlueprintCornerStack({
  board,
  copy,
  canvasWorld,
  nodes,
  style,
  onChange
}: {
  board: "business" | "architecture";
  copy: BlueprintBoardCopy;
  canvasWorld: BlueprintCanvasWorld;
  nodes: Node[];
  style: CSSProperties;
  onChange: (board: "business" | "architecture") => void;
}) {
  return (
    <div className="blueprint-corner-stack" style={style} aria-label="Blueprint viewport tools">
      <BlueprintBoardSwitch board={board} copy={copy} onChange={onChange} />
      <div className="blueprint-corner-toolrow">
        <Controls position="top-left" />
        <BlueprintCanvasMiniMap canvasWorld={canvasWorld} nodes={nodes} />
      </div>
    </div>
  );
}

function ArchitectureRoleNodeCard({ data, selected }: NodeProps) {
  const nodeData = data as ArchitectureRoleNodeData;
  const isCeo = nodeData.roleKind === "ceo";
  const blueprintLabel = nodeData.blueprintName ?? nodeData.blueprintId;

  return (
    <article
      className={`architecture-role-card architecture-flow-role-card ${isCeo ? "architecture-ceo-card" : "architecture-leader-card"} ${selected ? "selected" : ""}`}
    >
      <Handle id="architecture-role-in" className="node-handle architecture-role-handle" type="target" position={Position.Top} />
      <span className={`architecture-role-icon${isCeo ? "" : " leader"}`}>
        {isCeo ? <ShieldCheck size={20} /> : <Bot size={19} />}
      </span>
      <div className="architecture-role-main">
        <span>{isCeo ? nodeData.copy.ceo : nodeData.copy.leader}</span>
        <strong>{nodeData.label}</strong>
        {!isCeo && blueprintLabel && <small>{blueprintLabel}</small>}
        {!isCeo && !blueprintLabel && <small>{nodeData.copy.architectureEmpty}</small>}
      </div>
      <div className="architecture-role-metrics">
        <span>{nodeData.pendingApprovalCount} {nodeData.copy.pending}</span>
        {isCeo ? (
          <span>{nodeData.leaderCount ?? 0} {nodeData.copy.leader}</span>
        ) : (
          <span>{nodeData.latestRunStatus ? `${nodeData.copy.latestRun}: ${nodeData.latestRunStatus}` : nodeData.copy.noRun}</span>
        )}
        {!isCeo && nodeData.latestRunAt && <time dateTime={nodeData.latestRunAt}>{formatArchitectureDate(nodeData.latestRunAt)}</time>}
      </div>
      {!isCeo && nodeData.blueprintId && (
        <button type="button" className="architecture-open-blueprint" onClick={() => nodeData.onOpenBlueprint(nodeData.blueprintId!)}>
          <LayoutTemplate size={15} />
          {nodeData.copy.openBlueprint}
        </button>
      )}
      <Handle id="architecture-role-out" className="node-handle architecture-role-handle" type="source" position={Position.Bottom} />
    </article>
  );
}

function ArchitectureRoleDetailSidebar({
  node,
  onClose,
  onOpenBlueprint
}: {
  node: Node<ArchitectureRoleNodeData>;
  onClose: () => void;
  onOpenBlueprint: (blueprintId: string) => void;
}) {
  const nodeData = node.data;
  const isCeo = nodeData.roleKind === "ceo";
  const blueprintLabel = nodeData.blueprintName ?? nodeData.blueprintId;
  const detailRows = buildArchitectureRoleDetailRows({
    roleKind: nodeData.roleKind,
    pendingLabel: nodeData.copy.pending,
    pendingApprovalCount: nodeData.pendingApprovalCount,
    leaderLabel: nodeData.copy.leader,
    leaderCount: nodeData.leaderCount,
    latestRunLabel: nodeData.copy.latestRun,
    latestRunStatus: nodeData.latestRunStatus,
    noRunLabel: nodeData.copy.noRun,
    businessLabel: nodeData.copy.business,
    blueprintId: nodeData.blueprintId,
    blueprintLabel
  });

  return (
    <aside className="node-modal node-detail-sidebar" aria-label={nodeData.label} onPointerDown={(event) => event.stopPropagation()}>
      <header className="node-modal-header">
        <div>
          <span className="hero-eyebrow modal-eyebrow">{isCeo ? nodeData.copy.ceo : nodeData.copy.leader}</span>
          <h3>{nodeData.label}</h3>
        </div>
        <button type="button" className="icon-button node-modal-close" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <div className="node-modal-grid">
        <div className="node-modal-main">
          <div className="architecture-detail-list">
            {detailRows.map((row) => (
              <div key={row.id} className="architecture-detail-row">
                <span>{row.label}</span>
                {row.actionBlueprintId ? (
                  <button type="button" onClick={() => onOpenBlueprint(row.actionBlueprintId!)}>
                    <LayoutTemplate size={14} />
                    <strong>{row.value}</strong>
                  </button>
                ) : (
                  <strong>{row.value}</strong>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function ArchitectureDistributorEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  style,
  markerStart,
  markerEnd,
  interactionWidth,
  selected
}: EdgeProps) {
  const edgeData = data as ArchitectureDistributorEdgeData | undefined;
  const fallbackTrunkY = sourceY + (targetY - sourceY) / 2;
  const trunkY = typeof edgeData?.trunkY === "number" ? edgeData.trunkY : fallbackTrunkY;
  const horizontalPath = `M ${sourceX},${trunkY} L ${targetX},${trunkY}`;
  const dropPath = `M ${targetX},${trunkY} L ${targetX},${targetY}`;
  const path = edgeData?.drawsRootAndTrunk
    ? `M ${sourceX},${sourceY} L ${sourceX},${trunkY} ${horizontalPath} ${dropPath}`
    : `${horizontalPath} ${dropPath}`;

  return (
    <BaseEdge
      id={id}
      path={path}
      className={`architecture-distributor-edge-path${selected ? " selected" : ""}`}
      style={style}
      markerStart={markerStart}
      markerEnd={markerEnd}
      interactionWidth={interactionWidth}
    />
  );
}

function formatArchitectureDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function NodeDetailSidebar({
  catalog,
  configuredAgents,
  harnessStatuses,
  harnessPermissionModes,
  harnessSkillStatuses,
  allNodes,
  node,
  t,
  onClose,
  onPatchNode,
  onPatchConfig
}: {
  catalog?: CatalogSnapshot;
  configuredAgents?: OpenClawConfiguredAgent[];
  harnessStatuses?: HarnessStatus[];
  harnessPermissionModes?: Partial<Record<HarnessId, ChatPermissionMode>>;
  harnessSkillStatuses?: Partial<Record<HarnessStatus["id"], HarnessSkillStatusResponse>>;
  allNodes: BlueprintNode[];
  node: BlueprintNode;
  t: Messages;
  onClose: () => void;
  onPatchNode: (patch: Partial<BlueprintNode>) => void;
  onPatchConfig: (patch: Partial<BlueprintNode["config"]>) => void;
}) {
  const models = catalog?.models ?? [];
  const channels = catalog?.channels ?? [];

  return (
    <aside
      className={`node-modal node-detail-sidebar node-detail-sidebar-${node.type}`}
      aria-label={node.config.label}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="node-modal-header">
        <div>
          <span className="hero-eyebrow modal-eyebrow">{t.nodeTypes[node.type]}</span>
          <EditableNodeTitle value={node.config.label} onChange={(label) => onPatchConfig({ label })} />
        </div>
        <button type="button" className="icon-button node-modal-close" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <div className="node-modal-grid">
        <div className="node-modal-main">
          <NodeConfigForm
            node={node}
            configuredAgents={configuredAgents}
            harnessStatuses={harnessStatuses}
            harnessPermissionModes={harnessPermissionModes}
            harnessSkillStatuses={harnessSkillStatuses}
            allNodes={allNodes}
            models={models}
            channels={channels}
            onPatchNode={onPatchNode}
            onPatchConfig={onPatchConfig}
            t={t}
          />
        </div>
      </div>
    </aside>
  );
}

function EditableNodeTitle({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelBlurCommitRef = useRef(false);

  useEffect(() => {
    if (!isEditing) setDraft(value);
  }, [isEditing, value]);

  const commit = () => {
    if (cancelBlurCommitRef.current) {
      cancelBlurCommitRef.current = false;
      return;
    }
    setIsEditing(false);
    onChange(draft);
  };

  const beginEdit = () => {
    cancelBlurCommitRef.current = false;
    setDraft(value);
    setIsEditing(true);
  };

  if (isEditing) {
    return (
      <input
        autoFocus
        className="node-title-input"
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            cancelBlurCommitRef.current = true;
            setDraft(value);
            setIsEditing(false);
          }
        }}
      />
    );
  }

  return (
    <h3 className="node-title-editable" onDoubleClick={beginEdit}>
      {value}
    </h3>
  );
}

type BlueprintSelectOption = {
  value: string;
  label: string;
  badgeLabel?: string;
  disabled?: boolean;
};

function BlueprintSelect({
  value,
  options,
  ariaLabel,
  className,
  disabled,
  onChange
}: {
  value: string;
  options: BlueprintSelectOption[];
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value);
  const displayParts = selectedOption ? { label: selectedOption.label, badgeLabel: selectedOption.badgeLabel } : { label: value };
  const isDisabled = disabled || options.every((option) => option.disabled);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && rootRef.current?.contains(target)) return;
      if (target?.closest(".blueprint-select")) return;
      setOpen(false);
    };
    const closeOnPeerOpen = (event: Event) => {
      const peerRoot = event instanceof CustomEvent ? event.detail : undefined;
      if (peerRoot && peerRoot === rootRef.current) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const pointerListenerOptions = getBlueprintSelectOutsidePointerListenerOptions();

    document.addEventListener("pointerdown", closeOnOutsidePointer, pointerListenerOptions);
    window.addEventListener(blueprintSelectOpenEventName, closeOnPeerOpen);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, pointerListenerOptions);
      window.removeEventListener(blueprintSelectOpenEventName, closeOnPeerOpen);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toggleOpen = () => {
    if (isDisabled) return;
    window.dispatchEvent(new CustomEvent(blueprintSelectOpenEventName, { detail: rootRef.current }));
    setOpen((current) => !current);
  };

  return (
    <div ref={rootRef} className={`blueprint-select ${className ?? ""}`}>
      <button
        type="button"
        className={`blueprint-select-button ${open ? "open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={isDisabled}
        onClick={toggleOpen}
      >
        <HarnessLabel {...displayParts} />
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="blueprint-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                className={`blueprint-select-option ${selected ? "selected" : ""}`}
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <HarnessLabel label={option.label} badgeLabel={option.badgeLabel} />
                {selected && <Check size={15} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RuntimeAccessPolicyFields({
  runtimeId,
  config,
  t,
  variant = "select",
  inheritedPermissionMode,
  onPatchConfig
}: {
  runtimeId: AgentRuntimeId;
  config: Pick<AgentNodeConfig & ManagerNodeConfig & SummaryNodeConfig, "permissionProfile" | "runtimeAccessPolicy">;
  t: Messages;
  variant?: "select" | "toggle";
  inheritedPermissionMode?: ChatPermissionMode;
  onPatchConfig: (patch: Partial<AgentNodeConfig & ManagerNodeConfig & SummaryNodeConfig>) => void;
}) {
  const inheritedAccessMode = inheritedPermissionMode ? accessModeForHarnessPermissionMode(inheritedPermissionMode) : undefined;
  const policy = inheritedAccessMode
    ? runtimeAccessPolicyForMode(inheritedAccessMode, runtimeId)
    : normalizePolicyForRuntime(config, runtimeId);
  const accessMode = resolveRuntimeAccessMode(policy, runtimeId);
  const isInherited = inheritedAccessMode !== undefined;
  const patchAccessMode = (mode: RuntimeAccessMode) => {
    if (isInherited) return;
    const nextPolicy = normalizePolicyForRuntime(
      {
        ...config,
        permissionProfile: mode === "full" ? "workspace_write" : "read_only",
        runtimeAccessPolicy: runtimeAccessPolicyForMode(mode, runtimeId)
      },
      runtimeId
    );
    onPatchConfig({
      runtimeAccessPolicy: nextPolicy,
      permissionProfile: nextPolicy.filesystem
    });
  };

  if (variant === "toggle") {
    const fullAccess = accessMode === "full";
    return (
      <div className="config-field blueprint-permission-field">
        <span>{t.fields.harnessPermission}</span>
        <label className={`blueprint-permission-toggle ${fullAccess ? "enabled" : ""} ${isInherited ? "inherited" : ""}`}>
          <input
            type="checkbox"
            checked={fullAccess}
            disabled={isInherited}
            onChange={(event) => patchAccessMode(event.target.checked ? "full" : "safe")}
          />
          <span className="blueprint-permission-label">
            <strong>{accessModeLabel(accessMode, t)}</strong>
            {fullAccess && <Check className="harness-permission-check" size={14} />}
          </span>
          <span className="harness-permission-switch" aria-hidden="true" />
        </label>
      </div>
    );
  }

  return (
    <label>
      <span>{t.fields.harnessPermission}</span>
      <BlueprintSelect
        value={accessMode}
        options={[
          { value: "safe", label: t.options.safeMode },
          { value: "full", label: t.options.fullAccessMode }
        ]}
        ariaLabel={t.fields.harnessPermission}
        disabled={isInherited}
        onChange={(value) => patchAccessMode(value as RuntimeAccessMode)}
      />
    </label>
  );
}

function normalizePolicyForRuntime(
  config: Pick<AgentNodeConfig & ManagerNodeConfig & SummaryNodeConfig, "permissionProfile" | "runtimeAccessPolicy">,
  runtimeId: AgentRuntimeId
): RuntimeAccessPolicy {
  const support = runtimeAccessPolicySupportByRuntime[runtimeId];
  const defaultPolicy = runtimeAccessPolicyForMode(
    config.permissionProfile === "workspace_write" ? "full" : "safe",
    runtimeId
  );
  const policy = normalizeRuntimeAccessPolicy(
    { ...defaultPolicy, ...config.runtimeAccessPolicy },
    config.permissionProfile
  );
  return {
    filesystem: policy.filesystem,
    network: support.network === "unsupported" ? "enabled" : policy.network,
    webSearch: support.webSearch === "unsupported" ? "disabled" : policy.webSearch
  };
}

function runtimeAccessPolicyForMode(mode: RuntimeAccessMode, runtimeId: AgentRuntimeId): RuntimeAccessPolicy {
  const support = runtimeAccessPolicySupportByRuntime[runtimeId];
  if (mode === "full") {
    return {
      filesystem: "workspace_write",
      network: "enabled",
      webSearch: support.webSearch === "unsupported" ? "disabled" : "live"
    };
  }
  return {
    filesystem: "read_only",
    network: support.network === "unsupported" ? "enabled" : "disabled",
    webSearch: "disabled"
  };
}

function resolveRuntimeAccessMode(policy: RuntimeAccessPolicy, runtimeId: AgentRuntimeId): RuntimeAccessMode {
  const support = runtimeAccessPolicySupportByRuntime[runtimeId];
  const hasElevatedAccess = policy.filesystem === "workspace_write" ||
    (support.network !== "unsupported" && policy.network === "enabled") ||
    (support.webSearch !== "unsupported" && policy.webSearch === "live");
  return hasElevatedAccess ? "full" : "safe";
}

function resolveManagerPanelMode(config: ManagerNodeConfig): ManagerPanelMode {
  if (config.lifecycleMode === "self_iteration") return "self_iteration";
  if (config.dispatchMode === "self_dispatch") return "self_dispatch";
  return "sequential";
}

function managerModePatch(mode: ManagerPanelMode): Partial<ManagerNodeConfig> {
  if (mode === "self_iteration") return { lifecycleMode: "self_iteration", dispatchMode: "self_dispatch" };
  if (mode === "self_dispatch") return { lifecycleMode: "none", dispatchMode: "self_dispatch" };
  return { lifecycleMode: "none", dispatchMode: "sequential" };
}

function accessModeLabel(mode: RuntimeAccessMode, t: Messages): string {
  return mode === "full" ? t.options.fullAccessMode : t.options.safeMode;
}

function accessModeForHarnessPermissionMode(permissionMode: ChatPermissionMode): RuntimeAccessMode {
  return permissionMode === "full_access" ? "full" : "safe";
}

function ManagerModeField({
  value,
  options,
  t,
  onChange
}: {
  value: ManagerPanelMode;
  options: BlueprintSelectOption[];
  t: Messages;
  onChange: (mode: ManagerPanelMode) => void;
}) {
  return (
    <div className="config-field manager-mode-field field-span-full">
      <span>{t.fields.managerMode}</span>
      <div className="manager-mode-switch" role="radiogroup" aria-label={t.fields.managerMode}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? "active" : ""}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value as ManagerPanelMode)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CrossRoundContextField({
  config,
  t,
  onPatchConfig,
  className
}: {
  config: Pick<AgentNodeConfig & ManagerNodeConfig & ManagerSlotNodeConfig & SummaryNodeConfig & LoopNodeConfig & ConditionNodeConfig, "crossRoundContextMode">;
  t: Messages;
  onPatchConfig: (patch: { crossRoundContextMode?: CrossRoundContextMode }) => void;
  className?: string;
}) {
  const options: BlueprintSelectOption[] = [
    { value: "off", label: t.options.crossRoundOff },
    { value: "node_history", label: t.options.crossRoundNodeHistory },
    { value: "node_history_with_upstream", label: t.options.crossRoundNodeHistoryWithUpstream },
    { value: "node_history_with_upstream_and_manager_memory", label: t.options.crossRoundNodeHistoryWithManagerMemory }
  ];
  return (
    <label className={className}>
      <span>{t.fields.crossRoundContext}</span>
      <BlueprintSelect
        value={resolveCrossRoundContextMode(config)}
        options={options}
        ariaLabel={t.fields.crossRoundContext}
        onChange={(value) => onPatchConfig({ crossRoundContextMode: value === "off" ? undefined : value as CrossRoundContextMode })}
      />
      <small>{t.fields.crossRoundContextHint}</small>
    </label>
  );
}

function BatchAgentSettingsModal({
  nodes,
  models,
  configuredAgents,
  harnessStatuses,
  t,
  onClose,
  onApply
}: {
  nodes: Array<BlueprintNode & { type: "agent"; config: AgentNodeConfig }>;
  models: NonNullable<CatalogSnapshot["models"]>;
  configuredAgents: OpenClawConfiguredAgent[];
  harnessStatuses?: HarnessStatus[];
  t: Messages;
  onClose: () => void;
  onApply: (runtimeId: AgentRuntimeId | undefined, configPatch: Partial<AgentNodeConfig>) => void;
}) {
  const [runtimeId, setRuntimeId] = useState<"" | AgentRuntimeId>("");
  const [modelSelection, setModelSelection] = useState("");
  const effectiveRuntimeId = runtimeId || commonAgentRuntime(nodes) || "openclaw";
  const isSdkProvider = effectiveRuntimeId === "claude" || effectiveRuntimeId === "codex";
  const runtimeModelOptions = buildBlueprintRuntimeModelOptions(effectiveRuntimeId, models, harnessStatuses);
  const runtimeOptions: BlueprintSelectOption[] = [
    { value: "", label: "No change" },
    ...buildAgentHarnessOptions()
  ];
  const modelSelectionOptions: BlueprintSelectOption[] = buildBlueprintModelSelectOptions({
    models: runtimeModelOptions,
    defaultLabel: t.common.defaultOption,
    defaultBadgeLabel: t.common.defaultOption,
    defaultValue: "__default",
    noChangeLabel: "No change"
  });

  const apply = () => {
    const configPatch: Partial<AgentNodeConfig> = {};
    if (modelSelection === "__default") {
      configPatch.modelId = undefined;
    } else if (modelSelection) {
      configPatch.modelId = modelSelection;
    }
    onApply(runtimeId || undefined, configPatch);
  };

  return (
    <div className="node-modal-backdrop" onClick={onClose}>
      <section className="node-modal batch-agent-modal" onClick={(event) => event.stopPropagation()}>
        <header className="node-modal-header">
          <div>
            <span className="hero-eyebrow modal-eyebrow">{t.metrics.agents(nodes.length)}</span>
            <h3>Batch settings</h3>
          </div>
          <button type="button" className="icon-button node-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="node-modal-grid">
          <div className="node-modal-main">
            <div className="config-form node-modal-form">
              <label>
                <span>{t.fields.harness}</span>
                <BlueprintSelect
                  value={runtimeId}
                  options={runtimeOptions}
                  ariaLabel={t.fields.harness}
                  onChange={(value) => setRuntimeId(value as "" | AgentRuntimeId)}
                />
              </label>
              <label>
                <span>{t.fields.model}</span>
                {isSdkProvider && runtimeModelOptions.length === 0 ? (
                  <input value={modelSelection} placeholder="No change" onChange={(event) => setModelSelection(event.target.value)} />
                ) : (
                  <BlueprintSelect
                    value={modelSelection}
                    options={modelSelectionOptions}
                    ariaLabel={t.fields.model}
                    onChange={setModelSelection}
                  />
                )}
              </label>
            </div>
            <div className="node-modal-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="primary-action" onClick={apply}>
                Apply
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function NodeConfigForm({
  node,
  configuredAgents,
  harnessStatuses,
  harnessPermissionModes,
  harnessSkillStatuses,
  allNodes,
  models,
  channels,
  onPatchNode,
  onPatchConfig,
  t
}: {
  node: BlueprintNode;
  configuredAgents?: OpenClawConfiguredAgent[];
  harnessStatuses?: HarnessStatus[];
  harnessPermissionModes?: Partial<Record<HarnessId, ChatPermissionMode>>;
  harnessSkillStatuses?: Partial<Record<HarnessStatus["id"], HarnessSkillStatusResponse>>;
  allNodes: BlueprintNode[];
  models: NonNullable<CatalogSnapshot["models"]>;
  channels: NonNullable<CatalogSnapshot["channels"]>;
  onPatchNode: (patch: Partial<BlueprintNode>) => void;
  onPatchConfig: (patch: Partial<BlueprintNode["config"]>) => void;
  t: Messages;
}) {
  if (isAgentBlueprintNode(node)) {
    const config = node.config;
    const runtimeId = node.runtimeId ?? "openclaw";
    const skills = buildBlueprintRuntimeSkillOptions(runtimeId, harnessSkillStatuses);
    const isSdkProvider = runtimeId === "claude" || runtimeId === "codex";
    const modelSelectValue = resolveBlueprintModelSelectValue(config.modelId);
    const runtimeModelOptions = buildBlueprintRuntimeModelOptions(runtimeId, models, harnessStatuses);
    const profileOptions = buildHermesProfileOptions(runtimeId, harnessStatuses, t);
    const agentOptions = configuredAgents ?? [];
    const approvalEnabled = config.approval?.enabled === true;
    const sendEnabled = runtimeId === "openclaw" && config.send?.enabled === true;
    const sendConfig = config.send ?? {
      enabled: false,
      channelId: channels[0]?.id ?? "slack",
      target: "",
      bodyTemplate: t.defaults.sendBody
    };
    const binaryOptions: BlueprintSelectOption[] = [
      { value: "no", label: t.common.no },
      { value: "yes", label: t.common.yes }
    ];
    const channelOptions: BlueprintSelectOption[] =
      channels.length === 0
        ? [{ value: sendConfig.channelId || "slack", label: sendConfig.channelId || "slack" }]
        : channels.map((channel) => ({ value: channel.id, label: channel.label }));
    const runtimeOptions: BlueprintSelectOption[] = buildAgentHarnessOptions();
    const inheritedPermissionMode = resolveRuntimeHarnessPermissionMode(runtimeId, harnessPermissionModes);
    const modelOptions: BlueprintSelectOption[] = buildBlueprintModelSelectOptions({
      selectedModel: config.modelId,
      models: runtimeModelOptions,
      defaultLabel: t.common.defaultOption,
      defaultBadgeLabel: t.common.defaultOption
    });
    const switchRuntime = (nextRuntimeId: AgentRuntimeId) => {
      onPatchNode({ runtimeId: nextRuntimeId });
      onPatchConfig(buildRuntimeConfigPatch(config, nextRuntimeId, agentOptions, harnessPermissionModes));
    };

    return (
      <div className="node-agent-config">
        <div className="config-form node-modal-form node-agent-primary-form">
          <label>
            <span>{t.fields.harness}</span>
            <BlueprintSelect
              value={runtimeId}
              options={runtimeOptions}
              ariaLabel={t.fields.harness}
              onChange={(value) => switchRuntime(value as AgentRuntimeId)}
            />
          </label>
          <label>
            <span>{t.fields.model}</span>
            {isSdkProvider && runtimeModelOptions.length === 0 ? (
              <input
                value={modelSelectValue}
                placeholder={t.common.defaultOption}
                onChange={(event) => onPatchConfig({ modelId: event.target.value || undefined })}
              />
            ) : (
              <BlueprintSelect
                value={modelSelectValue}
                options={modelOptions}
                ariaLabel={t.fields.model}
                onChange={(value) => onPatchConfig({ modelId: value || undefined })}
              />
            )}
          </label>
          <RuntimeAccessPolicyFields
            runtimeId={runtimeId}
            config={config}
            t={t}
            variant="toggle"
            inheritedPermissionMode={inheritedPermissionMode}
            onPatchConfig={onPatchConfig}
          />
          {runtimeId === "hermes" && (
            <label>
              <span>{t.fields.profile}</span>
              <BlueprintSelect
                value={config.profileId ?? ""}
                options={profileOptions}
                ariaLabel={t.fields.profile}
                onChange={(value) => onPatchConfig({ profileId: value || undefined })}
              />
            </label>
          )}
          <label className="field-span-full">
            <span>{t.fields.systemPrompt}</span>
            <textarea
              className="node-system-prompt-input"
              rows={10}
              value={config.prompt}
              onChange={(event) => onPatchConfig({ prompt: event.target.value })}
            />
          </label>
          <label className="field-span-full">
            <span>{t.fields.userPrompt}</span>
            <textarea
              className="node-user-prompt-input"
              rows={6}
              value={config.userPrompt ?? ""}
              onChange={(event) => onPatchConfig({ userPrompt: event.target.value || undefined })}
            />
          </label>
          <AgentSkillField
            className="field-span-full"
            selectedSkills={config.skillIds ?? []}
            skills={skills}
            t={t}
            onChange={(skillIds) => onPatchConfig({ skillIds })}
          />
          <label>
            <span>{t.defaults.approvalLabel}</span>
            <BlueprintSelect
              value={approvalEnabled ? "yes" : "no"}
              options={binaryOptions}
              ariaLabel={t.defaults.approvalLabel}
              onChange={(value) =>
                onPatchConfig({
                  approval: {
                    enabled: value === "yes"
                  }
                })
              }
            />
          </label>
          {runtimeId === "openclaw" && (
            <>
              <label>
                <span>{t.defaults.sendLabel}</span>
                <BlueprintSelect
                  value={sendEnabled ? "yes" : "no"}
                  options={binaryOptions}
                  ariaLabel={t.defaults.sendLabel}
                  onChange={(value) =>
                    onPatchConfig({
                      send: {
                        ...sendConfig,
                        enabled: value === "yes",
                        channelId: sendConfig.channelId || channels[0]?.id || "slack",
                        bodyTemplate: sendConfig.bodyTemplate || t.defaults.sendBody
                      }
                    })
                  }
                />
              </label>
              {sendEnabled && (
                <>
                  <label>
                    <span>{t.fields.channels}</span>
                    <BlueprintSelect
                      value={sendConfig.channelId || channelOptions[0]?.value || "slack"}
                      options={channelOptions}
                      ariaLabel={t.fields.channels}
                      onChange={(value) =>
                        onPatchConfig({
                          send: {
                            ...sendConfig,
                            enabled: true,
                            channelId: value
                          }
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{t.fields.target}</span>
                    <input
                      value={sendConfig.target}
                      onChange={(event) =>
                        onPatchConfig({
                          send: {
                            ...sendConfig,
                            enabled: true,
                            target: event.target.value
                          }
                        })
                      }
                    />
                  </label>
                  <label className="field-span-full">
                    <span>{t.fields.body}</span>
                    <textarea
                      rows={5}
                      value={sendConfig.bodyTemplate}
                      onChange={(event) =>
                        onPatchConfig({
                          send: {
                            ...sendConfig,
                            enabled: true,
                            bodyTemplate: event.target.value
                          }
                        })
                      }
                    />
                  </label>
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  }
  if (node.type === "manager") {
    const config = node.config as ManagerNodeConfig;
    const runtimeId = node.runtimeId ?? "openclaw";
    const skills = buildBlueprintRuntimeSkillOptions(runtimeId, harnessSkillStatuses);
    const isSdkProvider = runtimeId === "claude" || runtimeId === "codex";
    const modelSelectValue = resolveBlueprintModelSelectValue(config.modelId);
    const runtimeModelOptions = buildBlueprintRuntimeModelOptions(runtimeId, models, harnessStatuses);
    const profileOptions = buildHermesProfileOptions(runtimeId, harnessStatuses, t);
    const agentOptions = configuredAgents ?? [];
    const managerMode = resolveManagerPanelMode(config);
    const isSelfIterationManager = managerMode === "self_iteration";
    const binaryOptions: BlueprintSelectOption[] = [
      { value: "no", label: t.common.no },
      { value: "yes", label: t.common.yes }
    ];
    const preflightAgentOptions: BlueprintSelectOption[] = [
      { value: "", label: t.options.managerFallback },
      ...allNodes
        .filter((candidate) => candidate.type === "agent")
        .map((candidate) => ({ value: candidate.id, label: candidate.config.label }))
    ];
    const runtimeOptions: BlueprintSelectOption[] = buildAgentHarnessOptions();
    const inheritedPermissionMode = resolveRuntimeHarnessPermissionMode(runtimeId, harnessPermissionModes);
    const modelOptions: BlueprintSelectOption[] = buildBlueprintModelSelectOptions({
      selectedModel: config.modelId,
      models: runtimeModelOptions,
      defaultLabel: t.common.defaultOption,
      defaultBadgeLabel: t.common.defaultOption
    });
    const managerModeOptions: BlueprintSelectOption[] = [
      { value: "sequential", label: t.options.sequential },
      { value: "self_dispatch", label: t.options.selfDispatch },
      { value: "self_iteration", label: t.options.selfIteration }
    ];
    const switchRuntime = (nextRuntimeId: AgentRuntimeId) => {
      onPatchNode({ runtimeId: nextRuntimeId });
      onPatchConfig(buildRuntimeConfigPatch(config, nextRuntimeId, agentOptions, harnessPermissionModes));
    };
    return (
      <div className="config-form node-modal-form manager-config-form">
        <ManagerModeField
          value={managerMode}
          options={managerModeOptions}
          t={t}
          onChange={(mode) => onPatchConfig(managerModePatch(mode))}
        />
        <label>
          <span>{t.fields.harness}</span>
          <BlueprintSelect
            value={runtimeId}
            options={runtimeOptions}
            ariaLabel={t.fields.harness}
            onChange={(value) => switchRuntime(value as AgentRuntimeId)}
          />
        </label>
        <label>
          <span>{t.fields.model}</span>
          {isSdkProvider && runtimeModelOptions.length === 0 ? (
            <input
              value={modelSelectValue}
              placeholder={t.common.defaultOption}
              onChange={(event) => onPatchConfig({ modelId: event.target.value || undefined })}
            />
          ) : (
            <BlueprintSelect
              value={modelSelectValue}
              options={modelOptions}
              ariaLabel={t.fields.model}
              onChange={(value) => onPatchConfig({ modelId: value || undefined })}
            />
          )}
        </label>
        <RuntimeAccessPolicyFields
          runtimeId={runtimeId}
          config={config}
          t={t}
          variant="toggle"
          inheritedPermissionMode={inheritedPermissionMode}
          onPatchConfig={onPatchConfig}
        />
        {runtimeId === "hermes" && (
          <label>
            <span>{t.fields.profile}</span>
            <BlueprintSelect
              value={config.profileId ?? ""}
              options={profileOptions}
              ariaLabel={t.fields.profile}
              onChange={(value) => onPatchConfig({ profileId: value || undefined })}
            />
          </label>
        )}
        <AgentSkillField
          className="field-span-full"
          selectedSkills={config.skillIds ?? []}
          skills={skills}
          t={t}
          onChange={(skillIds) => onPatchConfig({ skillIds })}
        />
        <label className="field-span-full">
          <span>{t.fields.systemPrompt}</span>
          <textarea
            className="node-system-prompt-input"
            rows={8}
            value={config.instructions ?? ""}
            onChange={(event) => onPatchConfig({ instructions: event.target.value })}
          />
        </label>
        <div className="manager-settings-divider field-span-full" />
        <details className="manager-advanced-settings field-span-full" open>
          <summary>
            <ChevronDown size={15} />
            <span>{t.fields.advancedSettings}</span>
          </summary>
          <div className="config-form manager-advanced-grid">
            {isSelfIterationManager && (
              <>
                <label>
                  <span>{t.fields.researchAgent}</span>
                  <BlueprintSelect
                    value={config.researchAgentNodeId ?? ""}
                    options={preflightAgentOptions}
                    ariaLabel={t.fields.researchAgent}
                    onChange={(value) => onPatchConfig({ researchAgentNodeId: value || undefined })}
                  />
                </label>
                <label>
                  <span>{t.fields.requirementAgent}</span>
                  <BlueprintSelect
                    value={config.requirementAgentNodeId ?? ""}
                    options={preflightAgentOptions}
                    ariaLabel={t.fields.requirementAgent}
                    onChange={(value) => onPatchConfig({ requirementAgentNodeId: value || undefined })}
                  />
                </label>
                <label>
                  <span>{t.fields.autoApproveRequirements}</span>
                  <BlueprintSelect
                    value={config.autoApproveRequirements ? "yes" : "no"}
                    options={binaryOptions}
                    ariaLabel={t.fields.autoApproveRequirements}
                    onChange={(value) => onPatchConfig({ autoApproveRequirements: value === "yes" ? true : undefined })}
                  />
                </label>
                <label>
                  <span>{t.fields.autoApproveReleaseReports}</span>
                  <BlueprintSelect
                    value={config.autoApproveReleaseReports ? "yes" : "no"}
                    options={binaryOptions}
                    ariaLabel={t.fields.autoApproveReleaseReports}
                    onChange={(value) => onPatchConfig({ autoApproveReleaseReports: value === "yes" ? true : undefined })}
                  />
                </label>
              </>
            )}
            <AgentSkillField
              className="field-span-full"
              selectedSkills={config.skillIds ?? []}
              skills={skills}
              t={t}
              onChange={(skillIds) => onPatchConfig({ skillIds })}
            />
            <CrossRoundContextField
              className="field-span-full"
              config={config}
              t={t}
              onPatchConfig={onPatchConfig}
            />
            <label>
              <span>{t.fields.managerSlotCount}</span>
              <BoundedNumberInput
                value={config.portCount}
                min={1}
                max={8}
                fallback={3}
                onValueChange={(portCount) => onPatchConfig({ portCount })}
              />
            </label>
            {isSelfIterationManager && (
              <label>
                <span>{t.fields.maxRounds}</span>
                <BoundedNumberInput
                  value={config.maxRounds ?? 3}
                  min={1}
                  max={50}
                  fallback={3}
                  onValueChange={(maxRounds) => onPatchConfig({ maxRounds })}
                />
              </label>
            )}
            <label>
              <span>{t.fields.managerDispatchStepLimit}</span>
              <BoundedNumberInput
                value={config.maxHandoffs}
                min={1}
                max={50}
                fallback={12}
                onValueChange={(maxHandoffs) => onPatchConfig({ maxHandoffs })}
              />
            </label>
          </div>
        </details>
      </div>
    );
  }

  if (node.type === "manager_slot") {
    const config = node.config as ManagerSlotNodeConfig;
    return (
      <div className="config-form node-modal-form">
        <label>
          <span>{t.fields.parallelLanes}</span>
          <BoundedNumberInput
            value={resolveManagerSlotParallelLaneCount(config)}
            min={1}
            max={16}
            fallback={1}
            onValueChange={(parallelLaneCount) => onPatchConfig({ parallelLaneCount })}
          />
        </label>
      </div>
    );
  }

  if (node.type === "loop") {
    const config = node.config as LoopNodeConfig;
    return (
      <div className="config-form node-modal-form">
        <label>
          <span>{t.fields.maxIterations}</span>
          <BoundedNumberInput
            value={config.maxIterations}
            min={1}
            max={25}
            fallback={3}
            onValueChange={(maxIterations) => onPatchConfig({ maxIterations })}
          />
        </label>
      </div>
    );
  }

  if (node.type === "condition") {
    const config = node.config as ConditionNodeConfig;
    return (
      <div className="config-form node-modal-form">
        <label className="field-span-full">
          <span>{t.fields.expression}</span>
          <input value={config.expression} onChange={(event) => onPatchConfig({ expression: event.target.value })} />
        </label>
      </div>
    );
  }

  if (node.type === "summary") {
    const config = node.config as SummaryNodeConfig;
    const summaryMode = (config.mode as string) === "harness_summary" || (config.mode as string) === "openclaw_summary_agent"
      ? "harness_summary"
      : "structured_merge";
    const runtimeId = config.runtimeId ?? "openclaw";
    const modelSelectValue = resolveBlueprintModelSelectValue(config.modelId);
    const runtimeModelOptions = buildBlueprintRuntimeModelOptions(runtimeId, models, harnessStatuses);
    const profileOptions = buildHermesProfileOptions(runtimeId, harnessStatuses, t);
    const modeOptions: BlueprintSelectOption[] = [
      { value: "structured_merge", label: t.options.structuredMerge },
      { value: "harness_summary", label: t.options.harnessSummary }
    ];
    const harnessOptions: BlueprintSelectOption[] = buildSummaryHarnessOptions();
    const inheritedPermissionMode = resolveRuntimeHarnessPermissionMode(runtimeId, harnessPermissionModes);
    const modelOptions: BlueprintSelectOption[] = buildBlueprintModelSelectOptions({
      selectedModel: config.modelId,
      models: runtimeModelOptions,
      defaultLabel: t.common.defaultOption,
      defaultBadgeLabel: t.common.defaultOption
    });
    const isSdkProvider = runtimeId === "claude" || runtimeId === "codex";
    const switchMode = (mode: SummaryNodeConfig["mode"]) => {
      onPatchConfig(
        mode === "harness_summary"
          ? {
              mode,
              runtimeId,
              modelId: undefined,
              runtimeAccessPolicy: buildHarnessRuntimeAccessPolicy(config, runtimeId, harnessPermissionModes)
            }
          : { mode, modelId: undefined }
      );
    };
    const switchRuntime = (nextRuntimeId: AgentRuntimeId) => {
      onPatchConfig({
        runtimeId: nextRuntimeId,
        modelId: undefined,
        runtimeAccessPolicy: buildHarnessRuntimeAccessPolicy(config, nextRuntimeId, harnessPermissionModes),
        profileId: nextRuntimeId === "hermes" ? config.profileId : undefined
      });
    };
    return (
      <div className="config-form node-modal-form">
        <label>
          <span>{t.fields.mode}</span>
          <BlueprintSelect
            value={summaryMode}
            options={modeOptions}
            ariaLabel={t.fields.mode}
            onChange={(value) => switchMode(value as SummaryNodeConfig["mode"])}
          />
        </label>
        {summaryMode === "harness_summary" && (
          <>
            <label>
              <span>{t.fields.harness}</span>
              <BlueprintSelect
                value={runtimeId}
                options={harnessOptions}
                ariaLabel={t.fields.harness}
                onChange={(value) => switchRuntime(value as AgentRuntimeId)}
              />
            </label>
            <label>
              <span>{t.fields.model}</span>
              {isSdkProvider && runtimeModelOptions.length === 0 ? (
                <input
                  value={modelSelectValue}
                  placeholder={t.common.defaultOption}
                  onChange={(event) => onPatchConfig({ modelId: event.target.value || undefined })}
                />
              ) : (
                <BlueprintSelect
                  value={modelSelectValue}
                  options={modelOptions}
                  ariaLabel={t.fields.model}
                  onChange={(value) => onPatchConfig({ modelId: value || undefined })}
                />
              )}
            </label>
            <RuntimeAccessPolicyFields
              runtimeId={runtimeId}
              config={config}
              t={t}
              variant="toggle"
              inheritedPermissionMode={inheritedPermissionMode}
              onPatchConfig={onPatchConfig}
            />
            {runtimeId === "hermes" && (
              <label>
                <span>{t.fields.profile}</span>
                <BlueprintSelect
                  value={config.profileId ?? ""}
                  options={profileOptions}
                  ariaLabel={t.fields.profile}
                  onChange={(value) => onPatchConfig({ profileId: value || undefined })}
                />
              </label>
            )}
            <label className="field-span-full">
              <span>{t.fields.systemPrompt}</span>
              <textarea
                className="node-system-prompt-input"
                rows={8}
                value={config.prompt ?? ""}
                onChange={(event) => onPatchConfig({ prompt: event.target.value || undefined })}
              />
            </label>
          </>
        )}
      </div>
    );
  }

  if (node.type === "note") {
    const config = node.config as NoteNodeConfig;
    return (
      <div className="config-form node-modal-form">
        <label className="field-span-full">
          <span>{t.fields.body}</span>
          <textarea rows={10} value={config.body} onChange={(event) => onPatchConfig({ body: event.target.value })} />
        </label>
      </div>
    );
  }

  if (node.type === "group") {
    const config = node.config as GroupNodeConfig;
    return (
      <div className="config-form node-modal-form">
        <label>
          <span>{t.fields.tagColor}</span>
          <input type="color" value={normalizeColorInput(config.color)} onChange={(event) => onPatchConfig({ color: event.target.value })} />
        </label>
      </div>
    );
  }

  return (
    <div className="config-form node-modal-form" />
  );
}

function AgentSkillField({
  className,
  selectedSkills,
  skills,
  t,
  onChange
}: {
  className?: string;
  selectedSkills: string[];
  skills: BlueprintSkillOption[];
  t: Messages;
  onChange: (skillIds: string[]) => void;
}) {
  const availableSkills = skills.filter((skill) => !selectedSkills.includes(skill.id));
  const skillOptions: BlueprintSelectOption[] = [
    { value: "", label: t.empty.selectSkill, disabled: availableSkills.length === 0 },
    ...availableSkills.map((skill) => ({ value: skill.id, label: `${skill.label} (${skill.category})` }))
  ];

  const addSkill = (skillId: string) => {
    if (!skillId || selectedSkills.includes(skillId)) return;
    onChange([...selectedSkills, skillId]);
  };

  const removeSkill = (skillId: string) => {
    onChange(selectedSkills.filter((item) => item !== skillId));
  };

  return (
    <div className={`node-skill-field ${className ?? ""}`}>
      <span className="node-field-label">{t.fields.skills}</span>
      <div className="skill-picker">
        <BlueprintSelect
          value=""
          options={skillOptions}
          ariaLabel={t.fields.skills}
          disabled={availableSkills.length === 0}
          onChange={addSkill}
        />
      </div>
      <div className="skill-list">
        {selectedSkills.length === 0 ? (
          <div className="skill-empty-text">{t.empty.noSelectedSkills}</div>
        ) : (
          selectedSkills.map((skillId) => {
            const match = skills.find((skill) => skill.id === skillId);
            return (
              <div key={skillId} className="skill-item">
                <div className="skill-item-main">
                  <strong>{match?.label ?? skillId}</strong>
                  <span>{match ? `${match.category} | ${match.id}` : skillId}</span>
                </div>
                <button type="button" className="icon-button" onClick={() => removeSkill(skillId)}>
                  <X size={14} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function BoundedNumberInput({
  value,
  min,
  max,
  fallback,
  onValueChange
}: {
  value?: number;
  min: number;
  max: number;
  fallback: number;
  onValueChange: (value: number) => void;
}) {
  const normalizedValue = normalizeBoundedNumberValue(value, min, max, fallback);
  const [draft, setDraft] = useState(String(normalizedValue));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(normalizedValue));
  }, [normalizedValue]);

  return (
    <input
      min={min}
      max={max}
      type="number"
      value={draft}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(event) => {
        const nextDraft = event.target.value;
        setDraft(nextDraft);
        const nextValue = readBoundedNumberDraft(nextDraft, min, max);
        if (nextValue !== undefined) onValueChange(nextValue);
      }}
      onBlur={() => {
        focusedRef.current = false;
        const nextValue = readBoundedNumberDraft(draft, min, max) ?? fallback;
        const normalizedNextValue = normalizeBoundedNumberValue(nextValue, min, max, fallback);
        setDraft(String(normalizedNextValue));
        if (normalizedNextValue !== normalizedValue) onValueChange(normalizedNextValue);
      }}
    />
  );
}

function normalizeBoundedNumberValue(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readBoundedNumberDraft(value: string, min: number, max: number): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeColorInput(value: string | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#64748b";
}

type BlueprintRuntimeModelOption = {
  id: string;
  label: string;
  isDefault?: boolean;
};

type RuntimeAccessMode = "safe" | "full";
type ManagerPanelMode = "sequential" | "self_dispatch" | "self_iteration";

type BlueprintSkillOption = {
  id: string;
  label: string;
  category: string;
};

function buildRuntimeConfigPatch(
  config: AgentNodeConfig | ManagerNodeConfig,
  runtimeId: AgentRuntimeId,
  agentOptions: OpenClawConfiguredAgent[],
  harnessPermissionModes?: Partial<Record<HarnessId, ChatPermissionMode>>
): Partial<AgentNodeConfig & ManagerNodeConfig> {
  const patch: Partial<AgentNodeConfig & ManagerNodeConfig> = {
    modelId: undefined
  };
  const permissionPatch = buildHarnessPermissionRuntimePatch(config, runtimeId, harnessPermissionModes);
  if (runtimeId === "openclaw") {
    return {
      ...patch,
      openclawAgentId: config.openclawAgentId ?? agentOptions[0]?.id ?? "main",
      runtimeAccessPolicy: permissionPatch.runtimeAccessPolicy,
      permissionProfile: permissionPatch.permissionProfile,
      profileId: undefined
    };
  }
  return {
    ...patch,
    openclawAgentId: undefined,
    send: undefined,
    runtimeAccessPolicy: permissionPatch.runtimeAccessPolicy,
    permissionProfile: permissionPatch.permissionProfile,
    profileId: runtimeId === "hermes" ? config.profileId : undefined,
    timeoutMs: config.timeoutMs ?? 3600000
  };
}

function buildHarnessPermissionRuntimePatch(
  config: Pick<AgentNodeConfig & ManagerNodeConfig, "permissionProfile" | "runtimeAccessPolicy">,
  runtimeId: AgentRuntimeId,
  harnessPermissionModes?: Partial<Record<HarnessId, ChatPermissionMode>>
): Pick<AgentNodeConfig & ManagerNodeConfig, "permissionProfile" | "runtimeAccessPolicy"> {
  const inheritedPermissionMode = resolveRuntimeHarnessPermissionMode(runtimeId, harnessPermissionModes);
  const permissionProfile = resolveRuntimePermissionProfile(
    runtimeId,
    harnessPermissionModes,
    config.permissionProfile ?? "read_only"
  );
  return {
    permissionProfile,
    runtimeAccessPolicy: inheritedPermissionMode
      ? runtimeAccessPolicyForMode(accessModeForHarnessPermissionMode(inheritedPermissionMode), runtimeId)
      : normalizePolicyForRuntime({ ...config, permissionProfile }, runtimeId)
  };
}

function buildHarnessRuntimeAccessPolicy(
  config: Pick<AgentNodeConfig & ManagerNodeConfig & SummaryNodeConfig, "permissionProfile" | "runtimeAccessPolicy">,
  runtimeId: AgentRuntimeId,
  harnessPermissionModes?: Partial<Record<HarnessId, ChatPermissionMode>>
): RuntimeAccessPolicy {
  const inheritedPermissionMode = resolveRuntimeHarnessPermissionMode(runtimeId, harnessPermissionModes);
  return inheritedPermissionMode
    ? runtimeAccessPolicyForMode(accessModeForHarnessPermissionMode(inheritedPermissionMode), runtimeId)
    : normalizePolicyForRuntime(config, runtimeId);
}

function buildHermesProfileOptions(
  runtimeId: AgentRuntimeId,
  harnessStatuses: HarnessStatus[] | undefined,
  t: Messages
): BlueprintSelectOption[] {
  const profiles = harnessStatuses?.find((status) => status.id === "hermes")?.profiles ?? [];
  return buildHermesProfileSelectOptions({
    runtimeId,
    profiles,
    defaultLabel: t.common.defaultOption,
    defaultBadgeLabel: t.common.defaultOption
  });
}

function buildBlueprintRuntimeModelOptions(
  runtimeId: AgentRuntimeId,
  models: NonNullable<CatalogSnapshot["models"]>,
  harnessStatuses?: HarnessStatus[]
): BlueprintRuntimeModelOption[] {
  const harnessStatus = harnessStatuses?.find((status) => status.id === runtimeHarnessId(runtimeId));

  if (runtimeId === "openclaw") {
    return models.map((model) => ({
      id: model.id,
      label: model.label,
      isDefault: harnessStatus?.defaultModelId ? model.id === harnessStatus.defaultModelId : undefined
    }));
  }

  if (harnessStatus?.models?.length) {
    return harnessStatus.models.map((model) => ({
      id: model.id,
      label: model.label || model.id,
      isDefault: model.isDefault ?? (harnessStatus.defaultModelId ? model.id === harnessStatus.defaultModelId : undefined)
    }));
  }
  return harnessStatus?.defaultModelId && harnessStatus.defaultModelId !== "inherit"
    ? [{ id: harnessStatus.defaultModelId, label: harnessStatus.defaultModelId, isDefault: true }]
    : [];
}

function buildBlueprintRuntimeSkillOptions(
  runtimeId: AgentRuntimeId,
  harnessSkillStatuses?: Partial<Record<HarnessStatus["id"], HarnessSkillStatusResponse>>
): BlueprintSkillOption[] {
  const harnessId = runtimeHarnessId(runtimeId);
  const status = harnessSkillStatuses?.[harnessId];
  if (!status?.supported) return [];

  return status.skills
    .filter((skill) => skill.installed || skill.status === "stale")
    .map((skill) => ({
      id: skill.id,
      label: skill.label,
      category: skill.status === "installed" ? runtimeLabel(runtimeId) : `${runtimeLabel(runtimeId)} ${skill.status}`
    }));
}

function runtimeLabel(runtimeId: AgentRuntimeId): string {
  return runtimeDisplayLabel(runtimeId);
}

function commonAgentRuntime(nodes: Array<BlueprintNode & { type: "agent" }>): AgentRuntimeId | undefined {
  const runtimes = new Set(nodes.map((node) => node.runtimeId ?? "openclaw"));
  return runtimes.size === 1 ? [...runtimes][0] : undefined;
}

function runtimeHarnessId(runtimeId: AgentRuntimeId): HarnessStatus["id"] {
  return runtimeId === "claude" ? "claudeCode" : runtimeId;
}

function compareDescending(left: number, right: number): number {
  return right - left;
}

function compareBlueprintNames(left: BlueprintDefinition, right: BlueprintDefinition): number {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
}

function toTimestamp(value: string): number {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getBrowserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function nextBlueprintNodeId(blueprint: BlueprintDefinition, type: BlueprintNodeType, parentId?: string): string {
  return nextAvailableBlueprintNodeId(new Set(blueprint.nodes.map((node) => node.id)), type, parentId);
}

function nextAvailableBlueprintNodeId(existingIds: Set<string>, type: BlueprintNodeType, parentId?: string): string {
  const baseId = parentId ? `${parentId}-${type}` : type;
  let index = 1;
  let id = `${baseId}-${index}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `${baseId}-${index}`;
  }
  return id;
}

function hasDuplicateNodeIds(blueprint: BlueprintDefinition): boolean {
  const seen = new Set<string>();
  for (const node of blueprint.nodes) {
    if (seen.has(node.id)) return true;
    seen.add(node.id);
  }
  return false;
}

function ensureUniqueBlueprintNodeIds(blueprint: BlueprintDefinition): BlueprintDefinition {
  const usedIds = new Set<string>();
  let changed = false;
  const nodes = blueprint.nodes.map((node) => {
    if (!usedIds.has(node.id)) {
      usedIds.add(node.id);
      return node;
    }
    const nextId = nextAvailableBlueprintNodeId(usedIds, node.type, node.parentId);
    usedIds.add(nextId);
    changed = true;
    return {
      ...node,
      id: nextId
    };
  });

  return changed ? { ...blueprint, nodes } : blueprint;
}

function isPaneAddMenuTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      ".react-flow__node, .react-flow__handle, .react-flow__controls, .react-flow__minimap, .node-menu-popover, .node-context-menu, .blueprint-action-dock, .blueprint-side-panel"
    )
  ) {
    return false;
  }
  return Boolean(target.closest(".react-flow__pane"));
}

function isManagerSlotInnerFrameContext(event: { currentTarget: EventTarget | null; clientX: number; clientY: number }): boolean {
  if (!(event.currentTarget instanceof Element)) return false;
  const innerFrame = event.currentTarget.querySelector(".manager-slot-box-body");
  if (!innerFrame) return false;
  const rect = innerFrame.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

function getMenuPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
  return {
    x: event.clientX + 8,
    y: event.clientY + 8
  };
}

function getConnectionEndPoint(event: globalThis.MouseEvent | globalThis.TouchEvent): { clientX: number; clientY: number } | undefined {
  if ("changedTouches" in event) {
    const touch = event.changedTouches[0];
    return touch ? { clientX: touch.clientX, clientY: touch.clientY } : undefined;
  }
  return { clientX: event.clientX, clientY: event.clientY };
}

function collectBlueprintNodePositionChanges(changes: NodeChange<Node<BlueprintNodeCardData>>[]): Map<string, CanvasPosition> {
  const positions = new Map<string, CanvasPosition>();
  for (const change of changes) {
    if (change.type !== "position" || !change.position) continue;
    if (change.dragging === true) continue;
    positions.set(change.id, change.position);
  }
  return positions;
}

function collectArchitectureNodePositionChanges(changes: NodeChange<Node<ArchitectureRoleNodeData>>[]): Map<string, CanvasPosition> {
  const positions = new Map<string, CanvasPosition>();
  for (const change of changes) {
    if (change.type !== "position" || !change.position) continue;
    if (change.dragging === true) continue;
    positions.set(change.id, change.position);
  }
  return positions;
}

function collectManagerSlotSizeChanges(changes: NodeChange<Node<BlueprintNodeCardData>>[]): Map<string, CanvasSize> {
  const sizes = new Map<string, CanvasSize>();
  for (const change of changes) {
    if (change.type !== "dimensions" || !change.dimensions) continue;
    if (change.resizing === true) continue;
    sizes.set(change.id, normalizeManagerSlotSize(change.dimensions));
  }
  return sizes;
}

function updateBlueprintNodePositions(blueprint: BlueprintDefinition, positionsById: Map<string, CanvasPosition>): BlueprintDefinition {
  if (positionsById.size === 0) return blueprint;

  let changed = false;
  const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
  const nodes = blueprint.nodes.map((node) => {
    const nextPosition = positionsById.get(node.id);
    if (!nextPosition) return node;
    const parentNode = node.parentId ? nodesById.get(node.parentId) : undefined;
    const position =
      parentNode?.type === "manager_slot" ? clampPositionToManagerSlotFrame(nextPosition, parentNode, defaultChildNodeSize) : nextPosition;
    if (position.x === node.position.x && position.y === node.position.y) return node;
    changed = true;
    return { ...node, position };
  });

  return changed ? { ...blueprint, nodes } : blueprint;
}

function resizeManagerSlotNodes(blueprint: BlueprintDefinition, sizesById: Map<string, CanvasSize>): BlueprintDefinition {
  if (sizesById.size === 0) return blueprint;

  let changed = false;
  const resizedNodes = blueprint.nodes.map((node) => {
    const nextSize = sizesById.get(node.id);
    if (!nextSize || node.type !== "manager_slot") return node;
    const currentSize = normalizeManagerSlotSize(node.size);
    if (currentSize.width === nextSize.width && currentSize.height === nextSize.height) return node;
    changed = true;
    return { ...node, size: nextSize };
  });

  if (!changed) return blueprint;

  const resizedNodesById = new Map(resizedNodes.map((node) => [node.id, node]));
  const nodes = resizedNodes.map((node) => {
    if (!node.parentId) return node;
    const parentNode = resizedNodesById.get(node.parentId);
    if (parentNode?.type !== "manager_slot") return node;
    const position = clampPositionToManagerSlotFrame(node.position, parentNode, defaultChildNodeSize);
    if (position.x === node.position.x && position.y === node.position.y) return node;
    return { ...node, position };
  });

  return {
    ...blueprint,
    nodes
  };
}

function normalizeManagerSlotSize(size?: Partial<CanvasSize>): CanvasSize {
  return {
    width: normalizeDimension(size?.width, MANAGER_SLOT_DEFAULT_SIZE.width, MANAGER_SLOT_MIN_SIZE.width),
    height: normalizeDimension(size?.height, MANAGER_SLOT_DEFAULT_SIZE.height, MANAGER_SLOT_MIN_SIZE.height)
  };
}

function normalizeDimension(value: unknown, fallback: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.round(value));
}

function managerSlotChildExtent(slotNode: BlueprintNode): CoordinateExtent {
  const size = normalizeManagerSlotSize(slotNode.size);
  return [
    [MANAGER_SLOT_FRAME.side, MANAGER_SLOT_FRAME.top],
    [size.width - MANAGER_SLOT_FRAME.side, size.height - MANAGER_SLOT_FRAME.bottom]
  ];
}

function managerSlotChildCenterPosition(slotNode: BlueprintNode, childSize: CanvasSize): CanvasPosition {
  const extent = managerSlotChildExtent(slotNode);
  return clampPositionToExtent(
    {
      x: (extent[0][0] + extent[1][0]) / 2 - childSize.width / 2,
      y: (extent[0][1] + extent[1][1]) / 2 - childSize.height / 2
    },
    extent,
    childSize
  );
}

function clampPositionToManagerSlotFrame(position: CanvasPosition, slotNode: BlueprintNode, childSize: CanvasSize): CanvasPosition {
  return clampPositionToExtent(position, managerSlotChildExtent(slotNode), childSize);
}

function clampPositionToExtent(position: CanvasPosition, extent: CoordinateExtent, childSize: CanvasSize): CanvasPosition {
  return {
    x: Math.min(Math.max(position.x, extent[0][0]), Math.max(extent[0][0], extent[1][0] - childSize.width)),
    y: Math.min(Math.max(position.y, extent[0][1]), Math.max(extent[0][1], extent[1][1] - childSize.height))
  };
}

function initialBlueprintNodeSize(type: BlueprintNodeType): CanvasSize {
  return type === "manager_slot" ? MANAGER_SLOT_DEFAULT_SIZE : defaultChildNodeSize;
}

function resolveViewportCenterNodePosition(
  viewport: BlueprintViewport,
  viewportSize: CanvasSize,
  childSize: CanvasSize,
  extent: CoordinateExtent
): CanvasPosition {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : defaultBlueprintViewport.zoom;
  const center = {
    x: (viewportSize.width / 2 - viewport.x) / zoom,
    y: (viewportSize.height / 2 - viewport.y) / zoom
  };
  return clampPositionToExtent(
    {
      x: center.x - childSize.width / 2,
      y: center.y - childSize.height / 2
    },
    extent,
    childSize
  );
}

function addManagerSlotFromMenu(
  blueprint: BlueprintDefinition,
  selectedNodeId: string | undefined,
  topLevelPosition: CanvasPosition,
  t: Messages
): BlueprintDefinition {
  const selectedNode = selectedNodeId ? blueprint.nodes.find((node) => node.id === selectedNodeId) : undefined;
  const selectedSlot = selectedNode?.type === "manager_slot" ? selectedNode : undefined;
  const selectedManager =
    selectedNode?.type === "manager"
      ? selectedNode
      : selectedSlot
        ? blueprint.nodes.find((node) => node.id === (selectedSlot.config as ManagerSlotNodeConfig).managerNodeId && node.type === "manager")
        : undefined;
  const assignableSlot = selectedManager ? nextAvailableManagerSlot(blueprint, selectedManager) : undefined;
  const slot = assignableSlot ?? nextManagerSlotNumber(blueprint);
  const position = selectedSlot
    ? { x: selectedSlot.position.x + 44, y: selectedSlot.position.y + 44 }
    : topLevelPosition;
  const node: BlueprintNode = {
    id: nextBlueprintNodeId(blueprint, "manager_slot"),
    type: "manager_slot",
    position,
    size: MANAGER_SLOT_DEFAULT_SIZE,
    config: {
      ...defaultConfig("manager_slot", t),
      label: t.defaults.managerSlotLabel,
      managerNodeId: selectedManager?.id ?? "",
      slot
    } as BlueprintNode["config"]
  };
  const blueprintWithSlot = {
    ...blueprint,
    nodes: [...blueprint.nodes, node]
  };
  if (!selectedManager || assignableSlot === undefined) return blueprintWithSlot;
  return applyManagerSlotAssignment(blueprintWithSlot, {
    managerNode: selectedManager,
    slotNode: node,
    slot: assignableSlot
  }, t);
}

function nextManagerSlotNumber(blueprint: BlueprintDefinition): number {
  return blueprint.nodes
    .filter((node) => node.type === "manager_slot")
    .reduce((highest, node) => Math.max(highest, (node.config as ManagerSlotNodeConfig).slot), 0) + 1;
}

function nextAvailableManagerSlot(blueprint: BlueprintDefinition, managerNode: BlueprintNode): number | undefined {
  const occupied = new Set<number>();
  const managerId = managerNode.id;

  for (const edge of blueprint.edges) {
    if (edge.source === managerId) {
      const slot = parseManagerPortHandle(edge.sourceHandle, managerOutHandlePrefix);
      if (slot !== undefined) occupied.add(slot);
    }
    if (edge.target === managerId) {
      const slot = parseManagerPortHandle(edge.targetHandle, managerInHandlePrefix);
      if (slot !== undefined) occupied.add(slot);
    }
  }

  for (const node of blueprint.nodes) {
    if (node.type !== "manager_slot") continue;
    const config = node.config as ManagerSlotNodeConfig;
    if (config.managerNodeId === managerId && config.slot >= 1 && config.slot <= maxManagerPortCount) {
      occupied.add(config.slot);
    }
  }

  for (let slot = 1; slot <= maxManagerPortCount; slot += 1) {
    if (!occupied.has(slot)) return slot;
  }
  return undefined;
}

function isBlueprintConnectionAllowed(blueprint: BlueprintDefinition, connection: BlueprintConnectionCandidate): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false;
  const source = blueprint.nodes.find((node) => node.id === connection.source);
  const target = blueprint.nodes.find((node) => node.id === connection.target);
  if (!source || !target) return false;

  if (source.type === "manager" && connection.sourceHandle?.startsWith(managerOutHandlePrefix)) {
    return target.type === "manager_slot" && connection.targetHandle === managerSlotInHandle;
  }

  if (target.type === "manager" && connection.targetHandle?.startsWith(managerInHandlePrefix)) {
    return source.type === "manager_slot" && connection.sourceHandle === managerSlotOutHandle;
  }

  if (source.type === "manager_slot" && connection.sourceHandle === managerSlotOutHandle) {
    return target.type === "manager" && Boolean(connection.targetHandle?.startsWith(managerInHandlePrefix));
  }

  if (source.type === "manager_slot" && isManagerSlotForwardOutHandle(connection.sourceHandle)) {
    return target.type !== "manager" && target.type !== "manager_slot" && !target.parentId;
  }

  if (source.type === "manager_slot" && isManagerSlotInnerOutHandle(connection.sourceHandle)) {
    return target.parentId === source.id;
  }

  if (target.type === "manager_slot" && isManagerSlotInnerInHandle(connection.targetHandle)) {
    return source.parentId === target.id;
  }

  return source.type !== "manager_slot" && target.type !== "manager_slot";
}

function connectBlueprintNodes(blueprint: BlueprintDefinition, connection: Connection, t: Messages): BlueprintDefinition {
  if (!isBlueprintConnectionAllowed(blueprint, connection)) return blueprint;
  const assignment = readManagerSlotConnection(blueprint, connection);
  if (assignment) {
    return applyManagerSlotAssignment(blueprint, assignment, t);
  }
  if (
    blueprint.edges.some(
      (edge) =>
        edge.source === connection.source &&
        edge.target === connection.target &&
        edge.sourceHandle === connection.sourceHandle &&
        edge.targetHandle === connection.targetHandle
    )
  ) {
    return blueprint;
  }

  return {
    ...blueprint,
    edges: [...blueprint.edges, createBlueprintEdge(blueprint, connection)]
  };
}

function readManagerSlotConnection(
  blueprint: BlueprintDefinition,
  connection: Connection
): { managerNode: BlueprintNode; slotNode: BlueprintNode; slot: number } | undefined {
  if (!connection.source || !connection.target) return undefined;
  const source = blueprint.nodes.find((node) => node.id === connection.source);
  const target = blueprint.nodes.find((node) => node.id === connection.target);

  if (source?.type === "manager" && target?.type === "manager_slot" && connection.targetHandle === managerSlotInHandle) {
    const slot = parseManagerPortHandle(connection.sourceHandle, managerOutHandlePrefix);
    return slot === undefined ? undefined : { managerNode: source, slotNode: target, slot };
  }

  if (source?.type === "manager_slot" && target?.type === "manager" && connection.sourceHandle === managerSlotOutHandle) {
    const slot = parseManagerPortHandle(connection.targetHandle, managerInHandlePrefix);
    return slot === undefined ? undefined : { managerNode: target, slotNode: source, slot };
  }

  return undefined;
}

function applyManagerSlotAssignment(
  blueprint: BlueprintDefinition,
  assignment: { managerNode: BlueprintNode; slotNode: BlueprintNode; slot: number },
  t?: Messages
): BlueprintDefinition {
  const { managerNode, slotNode, slot } = assignment;
  const boundedSlot = Math.min(maxManagerPortCount, Math.max(1, Math.round(slot)));
  const outHandle = `${managerOutHandlePrefix}${boundedSlot}`;
  const inHandle = `${managerInHandlePrefix}${boundedSlot}`;
  const edges = blueprint.edges.filter(
    (edge) =>
      !isManagerSlotAssignmentEdge(edge, slotNode.id) &&
      !(edge.source === managerNode.id && edge.sourceHandle === outHandle) &&
      !(edge.target === managerNode.id && edge.targetHandle === inHandle)
  );
  const nextEdges = appendBlueprintEdge(
    appendBlueprintEdge(edges, {
      id: nextBlueprintEdgeId(edges, `edge-${managerNode.id}-${slotNode.id}-slot-${boundedSlot}-out`),
      source: managerNode.id,
      sourceHandle: outHandle,
      target: slotNode.id,
      targetHandle: managerSlotInHandle,
      condition: "success"
    }),
    {
      id: nextBlueprintEdgeId(edges, `edge-${slotNode.id}-${managerNode.id}-slot-${boundedSlot}-return`),
      source: slotNode.id,
      sourceHandle: managerSlotOutHandle,
      target: managerNode.id,
      targetHandle: inHandle,
      condition: "success"
    }
  );

  return {
    ...blueprint,
    nodes: blueprint.nodes.map((node) => {
      if (node.id === managerNode.id && node.type === "manager") {
        const config = node.config as ManagerNodeConfig;
        const portCount = typeof config.portCount === "number" && Number.isFinite(config.portCount) ? config.portCount : 3;
        return {
          ...node,
          config: {
            ...config,
            portCount: Math.min(maxManagerPortCount, Math.max(portCount, boundedSlot))
          }
        };
      }
      if (node.id !== slotNode.id || node.type !== "manager_slot") return node;
      const config = node.config as ManagerSlotNodeConfig;
      return {
        ...node,
        config: {
          ...config,
          label: shouldRenameManagerSlot(config.label) ? t?.defaults.managerSlotLabel ?? "Slot" : config.label,
          managerNodeId: managerNode.id,
          slot: boundedSlot
        }
      };
    }),
    edges: nextEdges
  };
}

function appendBlueprintEdge(edges: BlueprintEdge[], edge: BlueprintEdge): BlueprintEdge[] {
  if (
    edges.some(
      (item) =>
        item.source === edge.source &&
        item.target === edge.target &&
        item.sourceHandle === edge.sourceHandle &&
        item.targetHandle === edge.targetHandle
    )
  ) {
    return edges;
  }
  return [...edges, edge];
}

function isManagerSlotAssignmentEdge(edge: BlueprintEdge, slotNodeId: string): boolean {
  if (edge.target === slotNodeId && edge.targetHandle === managerSlotInHandle && edge.sourceHandle?.startsWith(managerOutHandlePrefix)) {
    return true;
  }
  return Boolean(edge.source === slotNodeId && edge.sourceHandle === managerSlotOutHandle && edge.targetHandle?.startsWith(managerInHandlePrefix));
}

function parseManagerPortHandle(handle: string | null | undefined, prefix: string): number | undefined {
  if (!handle?.startsWith(prefix)) return undefined;
  const parsed = Number.parseInt(handle.slice(prefix.length), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > maxManagerPortCount) return undefined;
  return parsed;
}

function shouldRenameManagerSlot(label: string | undefined): boolean {
  return !label || label === "Slot" || label === "槽位" || /^Slot \d+$/i.test(label) || /^槽位 \d+$/i.test(label);
}

function nextBlueprintEdgeId(edges: BlueprintEdge[], baseId: string): string {
  const used = new Set(edges.map((edge) => edge.id));
  if (!used.has(baseId)) return baseId;
  let index = 2;
  let id = `${baseId}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${baseId}-${index}`;
  }
  return id;
}

function collectDeletedNodeIds(blueprint: BlueprintDefinition, seedIds: Set<string>): Set<string> {
  const deleteIds = new Set(seedIds);
  for (const node of blueprint.nodes) {
    if (!deleteIds.has(node.id)) continue;
    if (node.type !== "manager") continue;
    for (const candidate of blueprint.nodes) {
      if (candidate.type === "manager_slot" && (candidate.config as ManagerSlotNodeConfig).managerNodeId === node.id) {
        deleteIds.add(candidate.id);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of blueprint.nodes) {
      if (node.parentId && deleteIds.has(node.parentId) && !deleteIds.has(node.id)) {
        deleteIds.add(node.id);
        changed = true;
      }
    }
  }
  return deleteIds;
}

function buildFlowNodes(
  blueprint: BlueprintDefinition | undefined,
  statusByNode: Map<string, BlueprintNodeRun>,
  t: Messages
): Node<BlueprintNodeCardData>[] {
  const nodesById = new Map((blueprint?.nodes ?? []).map((node) => [node.id, node]));
  return (blueprint?.nodes ?? []).map((node) => {
    const status = statusByNode.get(node.id)?.status;
    const managerSlotSize = node.type === "manager_slot" ? normalizeManagerSlotSize(node.size) : undefined;
    const parentNode = node.parentId ? nodesById.get(node.parentId) : undefined;
    const extent = parentNode?.type === "manager_slot" ? managerSlotChildExtent(parentNode) : node.parentId ? "parent" : undefined;
    return {
      id: node.id,
      type: "blueprintNode",
      position: node.position,
      style: managerSlotSize ? { width: managerSlotSize.width, height: managerSlotSize.height } : undefined,
      initialWidth: managerSlotSize?.width,
      initialHeight: managerSlotSize?.height,
      parentId: node.parentId,
      extent,
      data: {
        label: node.config.label,
        type: node.type,
        kindLabel: t.nodeTypes[node.type],
        status,
        statusLabel: t.status[status ?? "idle"],
        disabled: node.disabled,
        isStartNode: isBlueprintStartNode(blueprint, node, nodesById),
        managerPortCount:
          node.type === "manager" ? (node.config as ManagerNodeConfig).portCount : undefined,
        managerSlotLaneCount: node.type === "manager_slot" ? resolveManagerSlotLaneCount(blueprint, node) : undefined,
        managerSlotSize
      }
    };
  });
}

function mergeBlueprintFlowNodes(
  nextNodes: Node<BlueprintNodeCardData>[],
  currentNodes: Node<BlueprintNodeCardData>[]
): Node<BlueprintNodeCardData>[] {
  if (currentNodes.length === 0) return nextNodes;
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  return nextNodes.map((node) => {
    const current = currentById.get(node.id);
    if (!current) return node;
    return {
      ...node,
      selected: current.selected,
      dragging: current.dragging,
      width: current.width,
      height: current.height,
      measured: current.measured
    };
  });
}

function buildArchitectureFlowNodes(
  architecture: ArchitectureBlueprintView | undefined,
  roleDirectory: CompanyRoleDirectory | undefined,
  blueprints: BlueprintDefinition[],
  copy: BlueprintBoardCopy,
  onOpenBlueprint: (blueprintId: string) => void
): Node<ArchitectureRoleNodeData>[] {
  const architectureNodes = architecture?.nodes ?? [];
  const leaderCount = roleDirectory?.leaders.length ?? architectureNodes.filter((node) => node.kind === "leader").length;
  const fallbackCeo: ArchitectureBlueprintView["nodes"][number] | undefined = roleDirectory?.ceo
    ? {
        id: roleDirectory.ceo.id,
        roleId: roleDirectory.ceo.id,
        kind: "ceo" as const,
        label: roleDirectory.ceo.label,
        pendingApprovalCount: 0,
        position: { x: 0, y: 0 }
      }
    : undefined;
  const nodes = architectureNodes.length > 0 ? architectureNodes : fallbackCeo ? [fallbackCeo] : [];

  return nodes.map((node) => {
    const isCeo = node.kind === "ceo";
    const blueprint = node.blueprintId ? blueprints.find((item) => item.id === node.blueprintId) : undefined;
    const size = isCeo ? architectureCeoNodeSize : architectureLeaderNodeSize;
    return {
      id: node.id,
      type: "architectureRole",
      position: node.position,
      initialWidth: size.width,
      initialHeight: size.height,
      style: { width: size.width, height: size.height },
      data: {
        label: node.label,
        roleKind: node.kind,
        blueprintId: node.blueprintId,
        blueprintName: node.blueprintName ?? blueprint?.name,
        pendingApprovalCount: node.pendingApprovalCount,
        latestRunStatus: node.latestRunStatus,
        latestRunAt: node.latestRunAt,
        leaderCount: isCeo ? leaderCount : undefined,
        copy,
        onOpenBlueprint
      }
    };
  });
}

function mergeArchitectureFlowNodes(
  nextNodes: Node<ArchitectureRoleNodeData>[],
  currentNodes: Node<ArchitectureRoleNodeData>[]
): Node<ArchitectureRoleNodeData>[] {
  if (currentNodes.length === 0) return nextNodes;
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  return nextNodes.map((node) => {
    const current = currentById.get(node.id);
    if (!current) return node;
    return {
      ...node,
      position: current.position,
      selected: current.selected,
      dragging: current.dragging,
      width: current.width,
      height: current.height,
      measured: current.measured
    };
  });
}

function buildArchitectureFlowEdges(
  architecture: ArchitectureBlueprintView | undefined,
  nodes: Node<ArchitectureRoleNodeData>[],
  canvasWorld: BlueprintCanvasWorld
): Edge[] {
  if (!architecture) return [];

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edgesBySource = new Map<string, ArchitectureBlueprintView["edges"]>();
  for (const edge of architecture.edges) {
    const edges = edgesBySource.get(edge.source) ?? [];
    edges.push(edge);
    edgesBySource.set(edge.source, edges);
  }

  return architecture.edges.map((edge) => {
    const sourceGroup = edgesBySource.get(edge.source) ?? [edge];
    const firstSourceEdge = sourceGroup[0];
    const sourceNode = nodesById.get(edge.source);
    const targetNodes = sourceGroup.map((sourceEdge) => nodesById.get(sourceEdge.target)).filter((node): node is NonNullable<typeof node> => Boolean(node));
    const sourcePoint = sourceNode ? resolveArchitectureFlowHandlePoint(sourceNode, "out", canvasWorld) : undefined;
    const targetPoints = targetNodes.map((targetNode) => resolveArchitectureFlowHandlePoint(targetNode, "in", canvasWorld));
    const targetYs = targetPoints.map((point) => point.y);
    const trunkY = sourcePoint ? resolveArchitectureDistributorTrunkY(sourcePoint.y, targetYs) : 0;

    return {
      id: edge.id,
      type: "architectureDistributor",
      source: edge.source,
      target: edge.target,
      sourceHandle: "architecture-role-out",
      targetHandle: "architecture-role-in",
      className: "blueprint-edge architecture-blueprint-edge",
      data: {
        drawsRootAndTrunk: edge.id === firstSourceEdge?.id,
        trunkY
      } satisfies ArchitectureDistributorEdgeData,
      style: { strokeWidth: 3.5 }
    };
  });
}

function resolveArchitectureFlowHandlePoint(
  node: Node<ArchitectureRoleNodeData>,
  handle: "in" | "out",
  canvasWorld: BlueprintCanvasWorld
): CanvasPosition {
  const size = resolveFlowNodeSize(node);
  const position = {
    x: clampNumber(node.position.x, canvasWorld.minX, canvasWorld.maxX),
    y: clampNumber(node.position.y, canvasWorld.minY, canvasWorld.maxY)
  };
  return {
    x: position.x + size.width / 2,
    y: position.y + (handle === "out" ? size.height : 0)
  };
}

function resolveArchitectureDistributorTrunkY(sourceY: number, targetYs: number[]): number {
  const nearestLowerTargetY = targetYs.filter((targetY) => targetY > sourceY).sort((left, right) => left - right)[0];
  if (nearestLowerTargetY === undefined) return sourceY + 64;
  return sourceY + (nearestLowerTargetY - sourceY) / 2;
}

function resolveManagerSlotLaneCount(
  blueprint: BlueprintDefinition | undefined,
  slotNode: BlueprintNode
): number {
  if (!blueprint || slotNode.type !== "manager_slot") return 1;
  const childIds = new Set(blueprint.nodes.filter((node) => node.parentId === slotNode.id).map((node) => node.id));
  const innerEdgeCount = blueprint.edges.filter(
    (edge) =>
      (edge.source === slotNode.id && isManagerSlotInnerOutHandle(edge.sourceHandle) && childIds.has(edge.target)) ||
      (edge.target === slotNode.id && isManagerSlotInnerInHandle(edge.targetHandle) && childIds.has(edge.source))
  ).length;
  const executionMode = resolveManagerSlotExecutionMode(slotNode.config as ManagerSlotNodeConfig);
  if (executionMode === "parallel") {
    return Math.max(
      resolveManagerSlotParallelLaneCount(slotNode.config as ManagerSlotNodeConfig),
      Math.ceil(innerEdgeCount / 2)
    );
  }
  return Math.max(1, Math.ceil(innerEdgeCount / 2));
}

function BlueprintCanvasMiniMap({
  canvasWorld,
  nodes
}: {
  canvasWorld: BlueprintCanvasWorld;
  nodes: Node[];
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { setCenter } = useReactFlow();
  const viewport = useStore((store) => {
    const zoom = store.transform[2] || 1;
    return {
      x: -store.transform[0] / zoom,
      y: -store.transform[1] / zoom,
      width: store.width / zoom,
      height: store.height / zoom,
      zoom
    };
  });
  const miniMapNodes = useMemo(() => buildMiniMapNodeBoxes(nodes), [nodes]);
  const viewportRect = useMemo(() => clampViewportToCanvasWorld(viewport, canvasWorld), [canvasWorld, viewport]);
  const maskPath = `M${canvasWorld.minX},${canvasWorld.minY}h${canvasWorld.width}v${canvasWorld.height}h${-canvasWorld.width}z M${viewportRect.x},${viewportRect.y}h${viewportRect.width}v${viewportRect.height}h${-viewportRect.width}z`;

  const centerViewportAtPointer = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const position = getMiniMapPointerPosition(event.currentTarget, event);
      if (!position) return;
      const halfWidth = viewportRect.width / 2;
      const halfHeight = viewportRect.height / 2;
      const x = clampNumber(position.x, canvasWorld.minX + halfWidth, canvasWorld.maxX - halfWidth);
      const y = clampNumber(position.y, canvasWorld.minY + halfHeight, canvasWorld.maxY - halfHeight);
      void setCenter(x, y, { zoom: viewport.zoom, duration: event.type === "pointerdown" ? 120 : 0 });
    },
    [canvasWorld.maxX, canvasWorld.maxY, canvasWorld.minX, canvasWorld.minY, setCenter, viewport.zoom, viewportRect.height, viewportRect.width]
  );

  return (
    <div
      className="blueprint-world-minimap"
      style={{ aspectRatio: `${canvasWorld.viewportWidth} / ${canvasWorld.viewportHeight}` }}
    >
      <svg
        ref={svgRef}
        className="blueprint-world-minimap-svg"
        viewBox={`${canvasWorld.minX} ${canvasWorld.minY} ${canvasWorld.width} ${canvasWorld.height}`}
        role="img"
        aria-label="Blueprint map"
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          centerViewportAtPointer(event);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          centerViewportAtPointer(event);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
      >
        <rect className="blueprint-world-minimap-surface" x={canvasWorld.minX} y={canvasWorld.minY} width={canvasWorld.width} height={canvasWorld.height} />
        {miniMapNodes.map((node) => (
          <rect
            key={node.id}
            className={`blueprint-world-minimap-node${node.selected ? " selected" : ""}`}
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            rx={16}
            ry={16}
          />
        ))}
        <path className="blueprint-world-minimap-mask" d={maskPath} fillRule="evenodd" pointerEvents="none" />
        <rect
          className="blueprint-world-minimap-viewport"
          x={viewportRect.x}
          y={viewportRect.y}
          width={viewportRect.width}
          height={viewportRect.height}
          pointerEvents="none"
        />
      </svg>
    </div>
  );
}

type MiniMapNodeBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
};

function buildBlueprintCanvasContentBounds(nodes: Node[]): BlueprintCanvasContentBounds | undefined {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const absolutePositions = new Map<string, CanvasPosition>();
  let bounds: BlueprintCanvasContentBounds | undefined;

  for (const node of nodes) {
    if (node.hidden) continue;
    const position = resolveFlowNodeAbsolutePosition(node, nodesById, absolutePositions);
    const size = resolveFlowNodeSize(node);
    const maxX = position.x + size.width;
    const maxY = position.y + size.height;
    if (![position.x, position.y, maxX, maxY].every(Number.isFinite)) continue;
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, position.x),
          minY: Math.min(bounds.minY, position.y),
          maxX: Math.max(bounds.maxX, maxX),
          maxY: Math.max(bounds.maxY, maxY)
        }
      : {
          minX: position.x,
          minY: position.y,
          maxX,
          maxY
        };
  }

  return bounds;
}

function buildMiniMapNodeBoxes(nodes: Node[]): MiniMapNodeBox[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const absolutePositions = new Map<string, CanvasPosition>();
  return nodes
    .filter((node) => !node.hidden)
    .map((node) => {
      const position = resolveFlowNodeAbsolutePosition(node, nodesById, absolutePositions);
      const size = resolveFlowNodeSize(node);
      return {
        id: node.id,
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        selected: Boolean(node.selected)
      };
    });
}

function resolveFlowNodeAbsolutePosition(
  node: Node,
  nodesById: Map<string, Node>,
  cache: Map<string, CanvasPosition>
): CanvasPosition {
  const cached = cache.get(node.id);
  if (cached) return cached;
  const parent = node.parentId ? nodesById.get(node.parentId) : undefined;
  const parentPosition = parent ? resolveFlowNodeAbsolutePosition(parent, nodesById, cache) : { x: 0, y: 0 };
  const position = {
    x: parentPosition.x + node.position.x,
    y: parentPosition.y + node.position.y
  };
  cache.set(node.id, position);
  return position;
}

function resolveFlowNodeSize(node: Node): CanvasSize {
  return {
    width: node.width ?? node.measured?.width ?? node.initialWidth ?? readCssPixelValue(node.style?.width) ?? defaultChildNodeSize.width,
    height: node.height ?? node.measured?.height ?? node.initialHeight ?? readCssPixelValue(node.style?.height) ?? defaultChildNodeSize.height
  };
}

function readCssPixelValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampViewportToCanvasWorld(
  viewport: { x: number; y: number; width: number; height: number },
  canvasWorld: BlueprintCanvasWorld
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(Math.max(viewport.width, 1), canvasWorld.width);
  const height = Math.min(Math.max(viewport.height, 1), canvasWorld.height);
  return {
    x: clampNumber(viewport.x, canvasWorld.minX, canvasWorld.maxX - width),
    y: clampNumber(viewport.y, canvasWorld.minY, canvasWorld.maxY - height),
    width,
    height
  };
}

function getMiniMapPointerPosition(svg: SVGSVGElement, event: ReactPointerEvent<SVGSVGElement>): CanvasPosition | undefined {
  const matrix = svg.getScreenCTM();
  if (!matrix) return undefined;
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const mapped = point.matrixTransform(matrix.inverse());
  return { x: mapped.x, y: mapped.y };
}

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2;
  return Math.min(Math.max(value, min), max);
}

function isBlueprintStartNode(
  blueprint: BlueprintDefinition | undefined,
  node: BlueprintNode,
  nodesById: Map<string, BlueprintNode>
): boolean {
  if (!blueprint || !isGlobalSchedulingNode(blueprint, node, nodesById)) return false;
  return getSchedulingIncomingEdges(blueprint, node, nodesById).length === 0;
}

function isGlobalSchedulingNode(
  blueprint: BlueprintDefinition,
  node: BlueprintNode,
  nodesById: Map<string, BlueprintNode>
): boolean {
  return blueprintStepTypes.has(node.type) && node.type !== "manager_slot" && !node.parentId && !isManagedParticipantNode(blueprint, node, nodesById);
}

function isManagedParticipantNode(
  blueprint: BlueprintDefinition,
  node: BlueprintNode,
  nodesById: Map<string, BlueprintNode>
): boolean {
  return blueprint.edges.some((edge) => {
    if (edge.target !== node.id || !edge.sourceHandle?.startsWith(managerOutHandlePrefix)) return false;
    return nodesById.get(edge.source)?.type === "manager";
  });
}

function getSchedulingIncomingEdges(
  blueprint: BlueprintDefinition,
  node: BlueprintNode,
  nodesById: Map<string, BlueprintNode>
): BlueprintEdge[] {
  return blueprint.edges.filter((edge) => {
    if (edge.target !== node.id) return false;
    if (node.type === "manager" && edge.targetHandle?.startsWith(managerInHandlePrefix)) return false;
    return nodesById.get(edge.source)?.type !== "loop";
  });
}

function buildFlowEdges(blueprint: BlueprintDefinition | undefined, runStatus?: BlueprintRunView["run"]["status"]): Edge[] {
  return (blueprint?.edges ?? []).map((edge) => ({
    id: edge.id,
    type: blueprintEdgeType(edge),
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    label: edge.label ?? defaultVisibleEdgeLabel(edge.condition),
    animated: runStatus === "queued" || runStatus === "running" || runStatus === "waiting_approval",
    className: "blueprint-edge",
    style: { strokeWidth: 3.5 }
  }));
}

function blueprintEdgeType(edge: BlueprintEdge): Edge["type"] | undefined {
  if (isManagerSlotInnerOutHandle(edge.sourceHandle) || isManagerSlotInnerInHandle(edge.targetHandle)) return "default";
  return undefined;
}

export function defaultConfig(type: BlueprintNodeType, t: Messages): BlueprintNode["config"] {
  if (type === "agent") {
    return {
      label: t.defaults.agentLabel,
      openclawAgentId: "main",
      agentName: t.defaults.agentName,
      prompt: t.defaults.agentPrompt,
      permissionProfile: "read_only",
      timeoutMs: 3600000,
      tools: []
    };
  }
  if (type === "condition") {
    return {
      label: t.defaults.conditionLabel,
      expression: "true"
    };
  }
  if (type === "summary") {
    return {
      label: t.defaults.summaryLabel,
      mode: "structured_merge",
      runtimeId: "openclaw"
    };
  }
  if (type === "manager") {
    return {
      label: t.defaults.managerLabel,
      portCount: 3,
      maxHandoffs: 12,
      maxPreparationAttempts: 3,
      instructions: t.defaults.managerInstructions,
      openclawAgentId: "main",
      agentName: "manager",
      permissionProfile: "read_only",
      timeoutMs: 3600000,
      tools: []
    };
  }
  if (type === "manager_slot") {
    return {
      label: t.defaults.managerSlotLabel,
      managerNodeId: "",
      slot: 1,
      parallelLaneCount: 1
    };
  }
  if (type === "loop") {
    return {
      label: t.defaults.loopLabel,
      maxIterations: 3
    };
  }
  if (type === "note") {
    return {
      label: t.defaults.noteLabel,
      body: t.defaults.noteBody
    };
  }
  return {
    label: t.defaults.groupLabel,
    color: "#64748b"
  };
}

function createBlueprintEdge(blueprint: BlueprintDefinition, connection: Connection): BlueprintEdge {
  const condition = pickDefaultEdgeCondition(blueprint, connection.source!);
  return {
    id: `edge-${connection.source}-${connection.target}-${Math.random().toString(36).slice(2, 8)}`,
    source: connection.source!,
    target: connection.target!,
    sourceHandle: connection.sourceHandle ?? undefined,
    targetHandle: connection.targetHandle ?? undefined,
    condition,
    label: defaultVisibleEdgeLabel(condition)
  };
}

function pickDefaultEdgeCondition(
  blueprint: BlueprintDefinition,
  sourceId: string
): BlueprintEdge["condition"] {
  const source = blueprint.nodes.find((node) => node.id === sourceId);
  if (source?.type !== "condition") {
    return "success";
  }

  const outgoing = blueprint.edges.filter((edge) => edge.source === sourceId);
  const hasTrue = outgoing.some((edge) => edge.condition === "true");
  const hasFalse = outgoing.some((edge) => edge.condition === "false");
  if (!hasTrue) return "true";
  if (!hasFalse) return "false";
  return "true";
}

function defaultVisibleEdgeLabel(condition?: BlueprintEdge["condition"]): string | undefined {
  if (condition === "true" || condition === "false" || condition === "failure") {
    return condition;
  }
  return undefined;
}

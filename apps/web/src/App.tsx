import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Building2,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Database,
  Download,
  ExternalLink,
  Github,
  History,
  Inbox,
  Languages,
  LayoutTemplate,
  ListChecks,
  MessageSquareText,
  Moon,
  Plus,
  Puzzle,
  Radio,
  RefreshCw,
  Save,
  Settings,
  Sun,
  Trash2,
  X
} from "lucide-react";
import type {
  CatalogSnapshot,
  ClaudeCodeModelConfig,
  ClaudeCodeModelPreset,
  ClaudeCodeSavedModelProfile,
  CompanyOverview,
  CreateCompanyRequest,
  ConfigureOpenClawChannelRequest,
  ConfigureOpenClawModelAuthRequest,
  DashboardWidgetType,
  CreateHermesChannelRequest,
  CreateHermesProfileRequest,
  HarnessId,
  HermesConfigResponse,
  HarnessSkillInstallStatus,
  HarnessSkillStatusResponse,
  HarnessStatus,
  ApplyHivewardUpdateResponse,
  HivewardUpdateStatus,
  ArchitectureBlueprintView,
  CompanyRoleDirectory,
  InboxItem,
  OpenClawConfigWizardMetadata,
  OpenClawConfigState,
  OpenClawModelUsageSummary,
  OpenClawVersionInfo,
  PendingApprovalItem,
  PortableBlueprintPackage,
  RuntimeOverview,
  UpdateClaudeCodeModelConfigRequest,
  UpdateCompanyRequest,
  WorkspaceDashboard,
  CanvasPosition,
  BlueprintDefinition,
  BlueprintRunSummary,
  BlueprintRunView,
  ChatPermissionMode
} from "@hiveward/shared";
import { api } from "./lib/api";
import { appSectionGroups, appSystemLabels, type AppNavSectionId, type AppSectionId, type AppSystemId } from "./lib/app-sections";
import { getVisibleClaudeCodeSavedProfiles, isClaudeCodeSavedProfileActiveProvider } from "./lib/claude-code-saved-profiles";
import { harnessDisplayLabel, harnessDisplayParts, isHarnessId } from "./lib/harness-labels";
import { applyHarnessPermissionModesToBlueprint } from "./lib/harness-permissions";
import {
  applyBlueprintUpdaterToCollection,
  blueprintCollectionSignature,
  clearBlueprintDirty,
  isSameBlueprintSnapshot,
  listDirtyBlueprintsForAutosave,
  markBlueprintDirty,
  mergeBlueprintsPreservingLocalEdits,
  removeBlueprintFromDirtySet,
  replaceBlueprint
} from "./lib/blueprint-edit-state";
import { getInitialLanguage, messages, type Language, type Messages } from "./lib/i18n";
import { isActiveRunView, selectRunPollingTarget, syncApprovalsForRun, syncRunDetails, upsertRunSummary } from "./lib/run-state";
import { BlueprintStudioPage } from "./components/BlueprintStudioPage";
import { HarnessLabel } from "./components/HarnessLabel";
import hivewardPackage from "../../../package.json";
import {
  AgentsPage,
  ApprovalsPage,
  ChannelsPage,
  CompanyDirectoryPage,
  CompanyPage,
  ConfiguredModelCard,
  HistoryPage,
  IdentityTitle,
  ModelsPage,
  RunsPage,
  SkillsPage
} from "./components/WorkspacePages";
import { ChatPage } from "./components/ChatPage";

const sidebarIcons = {
  company: Building2,
  chat: MessageSquareText,
  blueprint: LayoutTemplate,
  runs: ListChecks,
  approvals: Inbox,
  models: Database,
  agents: Bot,
  openclaw: Settings,
  skills: Puzzle,
  schedule: History,
  channels: Radio,
  claudeCodeConfig: Settings,
  claudeCodeModels: Database,
  codexConfig: Settings,
  googleConfig: Settings,
  cursorConfig: Settings,
  opencodeConfig: Settings,
  hermesConfig: Settings,
  hermesModels: Database,
  hermesAgents: Bot,
  hermesSkills: Puzzle,
  hermesChannels: Radio
};

const RUN_POLL_INTERVAL_MS = 2500;
const BLUEPRINT_CHANGE_POLL_INTERVAL_MS = 20000;
const BLUEPRINT_AUTOSAVE_INTERVAL_MS = 60 * 1000;
const HIVEWARD_UPDATE_POLL_INTERVAL_MS = 60 * 60 * 1000;
const companyScopedSections = new Set<AppSectionId>(["company", "chat", "blueprint", "runs", "approvals", "schedule"]);
const hivewardVersionLabel = `v${hivewardPackage.version}`;
const hivewardRepositoryUrl = "https://github.com/Chaunyzhang/HiveWard";
const harnessSkillHarnessIds: HarnessId[] = ["openclaw", "claudeCode", "codex", "google", "cursor", "opencode", "hermes"];

type AppTheme = "light" | "dark";
type SdkChatHarnessId = Extract<HarnessId, "claudeCode" | "codex" | "google" | "cursor" | "opencode" | "hermes">;

function AppSystemLabel({ systemId }: { systemId: AppSystemId }) {
  if (isHarnessId(systemId)) {
    return <HarnessLabel {...harnessDisplayParts(systemId)} className="nav-system-label" />;
  }
  return <span className="nav-system-label">{appSystemLabels[systemId]}</span>;
}

type OpenClawPanelCopy = {
  title: string;
  subtitle: string;
  openPanel: string;
  version: string;
  gateway: string;
  config: string;
  activity: string;
  available: string;
  unavailable: string;
  configured: string;
  notConfigured: string;
  environment: string;
  configFile: string;
  none: string;
  url: string;
  origin: string;
  locale: string;
  source: string;
  auth: string;
  requestTimeout: string;
  agentStartTimeout: string;
  configPath: string;
  workspace: string;
  defaultModel: string;
  models: string;
  agents: string;
  channels: string;
  catalogRefreshed: string;
  lastChecked: string;
  checkUpdates: string;
  checking: string;
  skills: string;
  skillsReady: string;
  skillsMissing: string;
  skillsUnsupported: string;
  installSkills: string;
  installingSkills: string;
  skillStatus: Record<HarnessSkillInstallStatus, string>;
};

export function App() {
  const [language, setLanguage] = useState<Language>(() => getInitialLanguage());
  const [theme, setTheme] = useState<AppTheme>(() => getInitialTheme());
  const [section, setSection] = useState<AppSectionId>("blueprint");
  const [companies, setCompanies] = useState<CompanyOverview[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | undefined>();
  const [blueprints, setBlueprints] = useState<BlueprintDefinition[]>([]);
  const [blueprint, setBlueprint] = useState<BlueprintDefinition | undefined>();
  const [dirtyBlueprintIds, setDirtyBlueprintIds] = useState<Set<string>>(() => new Set());
  const [catalog, setCatalog] = useState<CatalogSnapshot | undefined>();
  const [openClawConfig, setOpenClawConfig] = useState<OpenClawConfigState | undefined>();
  const [openClawWizard, setOpenClawWizard] = useState<OpenClawConfigWizardMetadata | undefined>();
  const [openClawModelUsage, setOpenClawModelUsage] = useState<OpenClawModelUsageSummary[]>([]);
  const [openClawVersion, setOpenClawVersion] = useState<OpenClawVersionInfo | undefined>();
  const [hivewardUpdate, setHivewardUpdate] = useState<HivewardUpdateStatus | undefined>();
  const [hivewardUpdateResult, setHivewardUpdateResult] = useState<ApplyHivewardUpdateResponse | undefined>();
  const [hivewardUpdateChecking, setHivewardUpdateChecking] = useState(false);
  const [harnessStatuses, setHarnessStatuses] = useState<HarnessStatus[]>([]);
  const [hermesConfig, setHermesConfig] = useState<HermesConfigResponse | undefined>();
  const [claudeCodeModelConfig, setClaudeCodeModelConfig] = useState<ClaudeCodeModelConfig | undefined>();
  const [claudeCodeModelPresets, setClaudeCodeModelPresets] = useState<ClaudeCodeModelPreset[]>([]);
  const [claudeCodeSavedModelProfiles, setClaudeCodeSavedModelProfiles] = useState<ClaudeCodeSavedModelProfile[]>([]);
  const [harnessSkillStatuses, setHarnessSkillStatuses] = useState<Partial<Record<HarnessId, HarnessSkillStatusResponse>>>({});
  const [chatPermissionModes, setChatPermissionModes] = useState<Record<SdkChatHarnessId, ChatPermissionMode>>(() =>
    getInitialChatPermissionModes()
  );
  const [runtime, setRuntime] = useState<RuntimeOverview | undefined>();
  const [runSummaries, setRunSummaries] = useState<BlueprintRunSummary[]>([]);
  const [runDetailsById, setRunDetailsById] = useState<Record<string, BlueprintRunView>>({});
  const [approvals, setApprovals] = useState<PendingApprovalItem[]>([]);
  const [roleDirectory, setRoleDirectory] = useState<CompanyRoleDirectory | undefined>();
  const [architecture, setArchitecture] = useState<ArchitectureBlueprintView | undefined>();
  const [inboxItems, setInboxItems] = useState<InboxItem[]>([]);
  const [dashboard, setDashboard] = useState<WorkspaceDashboard | undefined>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>();
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [runPageBlueprintId, setRunPageBlueprintId] = useState<string | undefined>();
  const [busyAction, setBusyAction] = useState<string | undefined>();
  const [dashboardDirty, setDashboardDirty] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [systemMenuOpen, setSystemMenuOpen] = useState(false);
  const [expandedSystems, setExpandedSystems] = useState<Record<AppSystemId, boolean>>({
    hiveward: true,
    openclaw: true,
    claudeCode: false,
    codex: false,
    google: false,
    cursor: false,
    opencode: false,
    hermes: false
  });
  const t = messages[language];
  const messageRef = useRef(t);
  const blueprintRef = useRef<BlueprintDefinition | undefined>(undefined);
  const blueprintsRef = useRef<BlueprintDefinition[]>([]);
  const dirtyBlueprintIdsRef = useRef<Set<string>>(new Set());
  const chatPermissionModesRef = useRef<Record<SdkChatHarnessId, ChatPermissionMode>>(chatPermissionModes);
  const blueprintAutosaveInFlightRef = useRef(false);
  const busyActionRef = useRef<string | undefined>(undefined);
  const selectedBlueprintIdRef = useRef<string | undefined>(undefined);
  const selectedRunIdRef = useRef<string | undefined>(undefined);
  const systemMenuRef = useRef<HTMLDivElement | null>(null);
  const blueprintImportInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    messageRef.current = t;
  }, [t]);

  useEffect(() => {
    blueprintRef.current = blueprint;
    selectedBlueprintIdRef.current = blueprint?.id;
  }, [blueprint]);

  useEffect(() => {
    blueprintsRef.current = blueprints;
  }, [blueprints]);

  useEffect(() => {
    dirtyBlueprintIdsRef.current = dirtyBlueprintIds;
  }, [dirtyBlueprintIds]);

  useEffect(() => {
    busyActionRef.current = busyAction;
  }, [busyAction]);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    localStorage.setItem("hiveward-language", language);
  }, [language]);

  useEffect(() => {
    localStorage.setItem("hiveward-chat-permission-modes", JSON.stringify(chatPermissionModes));
  }, [chatPermissionModes]);

  useEffect(() => {
    chatPermissionModesRef.current = chatPermissionModes;
  }, [chatPermissionModes]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("hiveward-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (selectedCompanyId || !companyScopedSections.has(section)) return;
    setSection("companyDirectory");
  }, [section, selectedCompanyId]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [section]);

  useEffect(() => {
    const preventGesture = (event: Event) => {
      event.preventDefault();
    };

    const preventZoomGesture = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
      }
    };

    document.addEventListener("gesturestart", preventGesture, { passive: false });
    document.addEventListener("gesturechange", preventGesture, { passive: false });
    document.addEventListener("gestureend", preventGesture, { passive: false });
    document.addEventListener("wheel", preventZoomGesture, { passive: false });

    return () => {
      document.removeEventListener("gesturestart", preventGesture);
      document.removeEventListener("gesturechange", preventGesture);
      document.removeEventListener("gestureend", preventGesture);
      document.removeEventListener("wheel", preventZoomGesture);
    };
  }, []);

  const runs = useMemo<BlueprintRunView[]>(
    () =>
      runSummaries.map((summary) => {
        const detail = runDetailsById[summary.id];
        return detail ? { ...detail, run: summary } : { run: summary, nodeRuns: [], events: [], finalResult: null };
      }),
    [runSummaries, runDetailsById]
  );

  const hydrateWorkspace = useCallback(
    async (options?: { blueprintId?: string; runId?: string }) => {
      const [
        companyDirectory,
        nextBlueprints,
        nextCatalog,
        nextOpenClawConfig,
        nextOpenClawWizard,
        nextOpenClawModelUsage,
        nextHarnessStatuses,
        nextHermesConfig,
        nextClaudeCodeModelResponse,
        nextHarnessSkillStatuses,
        nextRunSummaries,
        nextApprovals,
        nextRoles,
        nextInboxItems,
        nextDashboard,
        nextRuntime
      ] = await Promise.all([
        api.listCompanies(),
        api.listBlueprints(),
        api.getCatalogSnapshot(),
        api.getOpenClawConfig(),
        api.getOpenClawConfigWizard(),
        api.getOpenClawModelUsage().catch(() => []),
        api.getHarnessStatus().catch(() => []),
        api.getHermesConfig().catch(() => undefined),
        api.getClaudeCodeModelConfig().catch(() => undefined),
        loadHarnessSkillStatuses(),
        api.listBlueprintRuns(),
        api.listPendingApprovals(),
        api.getRoleDirectory().catch(() => undefined),
        api.listInboxItems().catch(() => []),
        api.getDashboardState(),
        api.getRuntimeOverview().catch(() => emptyRuntimeOverview())
      ]);

      const preferredRunId = options?.runId ?? selectedRunIdRef.current;
      const nextRunId = preferredRunId && nextRunSummaries.some((item) => item.id === preferredRunId) ? preferredRunId : undefined;
      const nextRunView = nextRunId ? await api.getBlueprintRun(nextRunId).catch(() => undefined) : undefined;

      setCompanies(companyDirectory.companies);
      setSelectedCompanyId(companyDirectory.selectedCompanyId);
      const hydratedBlueprints = mergeBlueprintsPreservingLocalEdits(
        nextBlueprints,
        blueprintsRef.current,
        dirtyBlueprintIdsRef.current
      );
      blueprintsRef.current = hydratedBlueprints;
      setBlueprints(hydratedBlueprints);
      setCatalog(nextCatalog);
      setOpenClawConfig(nextOpenClawConfig);
      setOpenClawWizard(nextOpenClawWizard);
      setOpenClawModelUsage(nextOpenClawModelUsage);
      setHarnessStatuses(nextHarnessStatuses);
      setHermesConfig(nextHermesConfig);
      setClaudeCodeModelConfig(nextClaudeCodeModelResponse?.config);
      setClaudeCodeModelPresets(nextClaudeCodeModelResponse?.presets ?? []);
      setClaudeCodeSavedModelProfiles(nextClaudeCodeModelResponse?.savedProfiles ?? []);
      setHarnessSkillStatuses(nextHarnessSkillStatuses);
      setRunSummaries(nextRunSummaries);
      setRunDetailsById((current) => syncRunDetails(current, nextRunSummaries, nextRunView));
      setApprovals(nextApprovals);
      setRoleDirectory(nextRoles?.roles);
      setArchitecture(nextRoles?.architecture);
      setInboxItems(nextInboxItems);
      setDashboard(nextDashboard);
      setRuntime(nextRuntime);
      setDashboardDirty(false);

      const preferredBlueprintId = options?.blueprintId ?? selectedBlueprintIdRef.current ?? hydratedBlueprints[0]?.id;
      const nextBlueprint = hydratedBlueprints.find((item) => item.id === preferredBlueprintId) ?? hydratedBlueprints[0];
      blueprintRef.current = nextBlueprint;
      selectedBlueprintIdRef.current = nextBlueprint?.id;
      setBlueprint(nextBlueprint);
      setSelectedNodeId(undefined);
      setSelectedRunId(nextRunId);
    },
    []
  );

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId),
    [companies, selectedCompanyId]
  );
  const systemUi = useMemo(
    () =>
      language === "zh-CN"
        ? {
            title: "\u7cfb\u7edf",
            settings: "\u8bbe\u7f6e",
            theme: "\u4e3b\u9898",
            language: "\u8bed\u8a00",
            switchToDay: "\u5207\u6362\u5230\u65e5\u95f4\u6a21\u5f0f",
            switchToNight: "\u5207\u6362\u5230\u591c\u95f4\u6a21\u5f0f",
            day: "\u65e5\u95f4",
            night: "\u591c\u95f4",
            versionPrefix: "v"
          }
        : {
            title: "System",
            settings: "Settings",
            theme: "Theme",
            language: "Language",
            switchToDay: "Switch to day mode",
            switchToNight: "Switch to night mode",
            day: "Day",
            night: "Night",
            versionPrefix: "v"
          },
    [language]
  );
  const openClawPanelUi = useMemo<OpenClawPanelCopy>(
    () =>
      language === "zh-CN"
        ? {
            title: "OpenClaw \u63a7\u5236\u9762\u677f",
            subtitle: "\u7f51\u5173\u3001\u914d\u7f6e\u548c\u7248\u672c\u68c0\u67e5",
            openPanel: "\u6253\u5f00 OpenClaw \u63a7\u5236\u9762\u677f",
            version: "\u7248\u672c",
            gateway: "\u7f51\u5173",
            config: "\u914d\u7f6e",
            activity: "\u8fd0\u884c",
            available: "\u53ef\u7528",
            unavailable: "\u4e0d\u53ef\u7528",
            configured: "\u5df2\u914d\u7f6e",
            notConfigured: "\u672a\u914d\u7f6e",
            environment: "\u73af\u5883\u53d8\u91cf",
            configFile: "\u914d\u7f6e\u6587\u4ef6",
            none: "-",
            url: "URL",
            origin: "Origin",
            locale: "Locale",
            source: "\u6765\u6e90",
            auth: "\u8ba4\u8bc1",
            requestTimeout: "\u8bf7\u6c42\u8d85\u65f6",
            agentStartTimeout: "Agent \u542f\u52a8\u8d85\u65f6",
            configPath: "\u914d\u7f6e\u6587\u4ef6",
            workspace: "\u9ed8\u8ba4\u5de5\u4f5c\u533a",
            defaultModel: "\u9ed8\u8ba4\u6a21\u578b",
            models: "\u6a21\u578b",
            agents: "Agent",
            channels: "\u9891\u9053",
            catalogRefreshed: "\u76ee\u5f55\u5237\u65b0",
            lastChecked: "\u6700\u540e\u68c0\u67e5",
            checkUpdates: "\u68c0\u67e5\u66f4\u65b0",
            checking: "\u68c0\u67e5\u4e2d",
            skills: "HiveWard Skill",
            skillsReady: "CEO / Leader \u6267\u884c\u624b\u518c\u5df2\u5b89\u88c5\uff0c\u804a\u5929\u65f6\u53ea\u9700\u77ed\u8eab\u4efd\u63d0\u793a\u5e76\u8c03\u7528 Harness \u539f\u751f skill\u3002",
            skillsMissing: "\u9700\u8981\u5b89\u88c5 HiveWard CEO / Leader skill\uff0c\u624d\u80fd\u8ba9 Harness \u539f\u751f\u8bfb\u53d6\u5e73\u53f0\u6267\u884c\u624b\u518c\u3002",
            skillsUnsupported: "\u8be5 Harness \u6682\u672a\u63a5\u5165\u539f\u751f skill \u5b89\u88c5\u3002",
            installSkills: "\u4e00\u952e\u5b89\u88c5",
            installingSkills: "\u5b89\u88c5\u4e2d",
            skillStatus: {
              installed: "\u5df2\u5b89\u88c5",
              missing: "\u672a\u5b89\u88c5",
              stale: "\u9700\u66f4\u65b0",
              unsupported: "\u672a\u652f\u6301",
              error: "\u5f02\u5e38"
            }
          }
        : {
            title: "OpenClaw Control Panel",
            subtitle: "Gateway, configuration, and version checks",
            openPanel: "Open OpenClaw control panel",
            version: "Version",
            gateway: "Gateway",
            config: "Config",
            activity: "Activity",
            available: "Available",
            unavailable: "Unavailable",
            configured: "Configured",
            notConfigured: "Not configured",
            environment: "Environment",
            configFile: "Config file",
            none: "-",
            url: "URL",
            origin: "Origin",
            locale: "Locale",
            source: "Source",
            auth: "Auth",
            requestTimeout: "Request timeout",
            agentStartTimeout: "Agent start timeout",
            configPath: "Config file",
            workspace: "Default workspace",
            defaultModel: "Default model",
            models: "Models",
            agents: "Agents",
            channels: "Channels",
            catalogRefreshed: "Catalog refreshed",
            lastChecked: "Last checked",
            checkUpdates: "Check updates",
            checking: "Checking",
            skills: "HiveWard Skills",
            skillsReady: "CEO / Leader operating skills are installed, so chat can send a short role prompt and let the harness load native skills.",
            skillsMissing: "Install HiveWard CEO / Leader skills so the harness can natively read the platform operating manual.",
            skillsUnsupported: "This harness does not have native skill installation wired yet.",
            installSkills: "Install skills",
            installingSkills: "Installing",
            skillStatus: {
              installed: "Installed",
              missing: "Missing",
              stale: "Update needed",
              unsupported: "Unsupported",
              error: "Error"
            }
          },
    [language]
  );
  const openClawVersionLabel = openClawVersion?.version
    ? `${systemUi.versionPrefix}${openClawVersion.version}`
    : `${systemUi.versionPrefix}--`;
  const openClawVersionHealthy = Boolean(openClawVersion?.version && !openClawVersion.error);
  const hivewardHomeUi = useMemo(() => hivewardHomeCopy(language), [language]);
  const hivewardVersionTitle = hivewardUpdate?.updateAvailable
    ? `${hivewardHomeUi.updateAvailable}: ${hivewardVersionLabel}`
    : `Hiveward ${hivewardVersionLabel}`;
  const gatewaySettings = openClawConfig?.gateway;
  const gatewayStatusLabel = gatewaySettings?.url ? openClawPanelUi.configured : openClawPanelUi.notConfigured;
  const gatewaySourceLabel =
    gatewaySettings?.source === "environment"
      ? openClawPanelUi.environment
      : gatewaySettings?.source === "config"
        ? openClawPanelUi.configFile
        : openClawPanelUi.none;
  const gatewayAuthLabel = [
    gatewaySettings?.tokenConfigured ? "Token" : undefined,
    gatewaySettings?.passwordConfigured ? "Password" : undefined
  ]
    .filter(Boolean)
    .join(" / ") || openClawPanelUi.notConfigured;
  const openClawPanelBusy = busyAction === "checkOpenClawUpdates";
  const installingOpenClawSkills = busyAction === "installHarnessSkills:openclaw";
  const installingClaudeCodeSkills = busyAction === "installHarnessSkills:claudeCode";
  const installingCodexSkills = busyAction === "installHarnessSkills:codex";
  const installingGoogleSkills = busyAction === "installHarnessSkills:google";
  const installingCursorSkills = busyAction === "installHarnessSkills:cursor";
  const installingOpenCodeSkills = busyAction === "installHarnessSkills:opencode";
  const installingHermesSkills = busyAction === "installHarnessSkills:hermes";
  const openClawHarnessStatus = harnessStatuses.find((status) => status.id === "openclaw");
  const claudeCodeHarnessStatus = harnessStatuses.find((status) => status.id === "claudeCode");
  const codexHarnessStatus = harnessStatuses.find((status) => status.id === "codex");
  const googleHarnessStatus = harnessStatuses.find((status) => status.id === "google");
  const cursorHarnessStatus = harnessStatuses.find((status) => status.id === "cursor");
  const opencodeHarnessStatus = harnessStatuses.find((status) => status.id === "opencode");
  const hermesHarnessStatus = harnessStatuses.find((status) => status.id === "hermes");
  const themeToggleTitle = theme === "dark" ? systemUi.switchToDay : systemUi.switchToNight;
  const themeToggleLabel = theme === "dark" ? systemUi.day : systemUi.night;
  const companySwitcherLabel = language === "zh-CN" ? "\u9009\u62E9\u516C\u53F8" : "Choose company";

  useEffect(() => {
    setBusyAction("load");
    setError(undefined);
    void hydrateWorkspace()
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : messageRef.current.errors.load);
      })
      .finally(() => {
        setBusyAction(undefined);
      });
  }, [hydrateWorkspace]);

  const isSelectedBlueprintDirty = Boolean(blueprint && dirtyBlueprintIds.has(blueprint.id));
  const latestRunForBlueprint = useMemo(
    () => (blueprint ? runs.find((runView) => runView.run.blueprintId === blueprint.id) : undefined),
    [runs, blueprint]
  );
  const runPageBlueprint = useMemo(
    () => blueprints.find((item) => item.id === runPageBlueprintId),
    [blueprints, runPageBlueprintId]
  );

  useEffect(() => {
    if (!runPageBlueprintId || runPageBlueprint) return;
    setRunPageBlueprintId(undefined);
    setSelectedRunId(undefined);
  }, [runPageBlueprint, runPageBlueprintId]);

  useEffect(() => {
    if (section !== "runs" || runPageBlueprintId || runs.length === 0) return;
    const preferredRun =
      runs.find(isActiveRunView) ??
      (blueprint ? runs.find((runView) => runView.run.blueprintId === blueprint.id) : undefined) ??
      runs[0];
    if (!preferredRun) return;
    setRunPageBlueprintId(preferredRun.run.blueprintId);
    setSelectedRunId(preferredRun.run.id);
  }, [blueprint, runPageBlueprintId, runs, section]);

  const activeTaskCount = useMemo(
    () => runs.filter(isActiveRunView).length,
    [runs]
  );
  const pendingApprovalCount = useMemo(
    () => approvals.filter(isActionableApproval).length,
    [approvals]
  );
  const pendingInboxCount = useMemo(() => inboxItems.filter((item) => item.status === "pending").length, [inboxItems]);
  const pollingRunId = useMemo(
    () =>
      selectRunPollingTarget({
        runs,
        selectedBlueprintId: section === "runs" ? runPageBlueprint?.id : blueprint?.id,
        selectedRunId,
        view: section === "runs" ? "runs" : "blueprint"
      }),
    [blueprint?.id, runPageBlueprint?.id, runs, section, selectedRunId]
  );

  const selectBlueprint = useCallback(
    (blueprintId: string) => {
      const next = blueprints.find((item) => item.id === blueprintId);
      if (!next) return;
      blueprintRef.current = next;
      selectedBlueprintIdRef.current = next.id;
      setBlueprint(next);
      setSelectedNodeId(undefined);
      const latestRunForNextBlueprint = runs.find((runView) => runView.run.blueprintId === next.id);
      setSelectedRunId(latestRunForNextBlueprint?.run.id);
    },
    [runs, blueprints]
  );

  const selectRunPageBlueprint = useCallback(
    (blueprintId: string) => {
      setRunPageBlueprintId(blueprintId);
      selectBlueprint(blueprintId);
    },
    [selectBlueprint]
  );

  const openRunFromHistory = useCallback((runId: string, blueprintId: string) => {
    const nextBlueprint = blueprintsRef.current.find((item) => item.id === blueprintId);
    if (nextBlueprint) {
      setBlueprint(nextBlueprint);
    }
    setRunPageBlueprintId(blueprintId);
    setSelectedRunId(runId);
    setSelectedNodeId(undefined);
    setSection("runs");
  }, []);

  const sidebarMeta = useMemo<Partial<Record<AppNavSectionId, number>>>(
    () => ({
      company: companies.length,
      blueprint: blueprints.length,
      runs: activeTaskCount,
      approvals: pendingApprovalCount + pendingInboxCount,
      models: openClawConfig?.configuredModels.length ?? 0,
      agents: openClawConfig?.configuredAgents.length ?? 0,
      skills: catalog?.tools.length ?? 0,
      schedule: runs.length + pendingApprovalCount + pendingInboxCount,
      channels: openClawConfig?.configuredChannels.length ?? 0,
      claudeCodeModels: countConfiguredClaudeCodeModels(claudeCodeModelConfig)
    }),
    [
      companies.length,
      pendingApprovalCount,
      pendingInboxCount,
      activeTaskCount,
      openClawConfig?.configuredModels.length,
      openClawConfig?.configuredAgents.length,
      openClawConfig?.configuredChannels.length,
      claudeCodeModelConfig,
      catalog?.tools.length,
      runs.length,
      blueprints.length
    ]
  );

  const toggleSystemGroup = useCallback((systemId: AppSystemId) => {
    setExpandedSystems((current) => ({ ...current, [systemId]: !current[systemId] }));
  }, []);

  const withBusy = useCallback(async <T,>(action: string, work: () => Promise<T>): Promise<T | undefined> => {
    setBusyAction(action);
    setError(undefined);
    try {
      return await work();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : errorMessageForAction(action, messageRef.current));
      return undefined;
    } finally {
      setBusyAction(undefined);
    }
  }, []);

  const applyRunView = useCallback((runView: BlueprintRunView) => {
    setRunDetailsById((current) => ({ ...current, [runView.run.id]: runView }));
    setRunSummaries((current) => upsertRunSummary(current, runView.run));
    setApprovals((current) => syncApprovalsForRun(current, runView));
  }, []);

  const loadOpenClawVersion = useCallback(async () => {
    try {
      setOpenClawVersion(await api.getOpenClawVersion());
    } catch (versionError) {
      setOpenClawVersion({
        resolvedAt: new Date().toISOString(),
        error: versionError instanceof Error ? versionError.message : String(versionError)
      });
    }
  }, []);

  useEffect(() => {
    void loadOpenClawVersion();
  }, [loadOpenClawVersion]);

  const updateBlueprint = useCallback((updater: (current: BlueprintDefinition) => BlueprintDefinition) => {
    const result = applyBlueprintUpdaterToCollection(blueprintRef.current, blueprintsRef.current, updater);
    if (!result.changed || !result.blueprint) return;

    blueprintRef.current = result.blueprint;
    selectedBlueprintIdRef.current = result.blueprint.id;
    blueprintsRef.current = result.blueprints;
    setBlueprint(result.blueprint);
    setBlueprints(result.blueprints);
    setDirtyBlueprintIds((currentDirty) => {
      const nextDirty = markBlueprintDirty(currentDirty, result.blueprint!.id);
      dirtyBlueprintIdsRef.current = nextDirty;
      return nextDirty;
    });
  }, []);

  const acceptSavedBlueprintSnapshot = useCallback((saved: BlueprintDefinition, savedSnapshot: BlueprintDefinition) => {
    const currentSnapshot = blueprintsRef.current.find((candidate) => candidate.id === savedSnapshot.id);
    if (!currentSnapshot || !isSameBlueprintSnapshot(currentSnapshot, savedSnapshot)) return false;

    const nextBlueprints = replaceBlueprint(blueprintsRef.current, saved);
    blueprintsRef.current = nextBlueprints;
    setBlueprints(nextBlueprints);
    if (selectedBlueprintIdRef.current === saved.id) {
      blueprintRef.current = saved;
      setBlueprint(saved);
    }
    setDirtyBlueprintIds((current) => {
      const next = clearBlueprintDirty(current, saved.id);
      dirtyBlueprintIdsRef.current = next;
      return next;
    });
    return true;
  }, []);

  const updateArchitectureLayout = useCallback((positions: Record<string, CanvasPosition>) => {
    if (Object.keys(positions).length === 0) return;
    void api.saveArchitectureLayout(positions)
      .then((nextRoles) => {
        setRoleDirectory(nextRoles.roles);
        setArchitecture(nextRoles.architecture);
      })
      .catch((layoutError) => {
        setError(layoutError instanceof Error ? layoutError.message : messageRef.current.errors.save);
      });
  }, []);

  const mutateDashboard = useCallback((updater: (current: WorkspaceDashboard) => WorkspaceDashboard) => {
    setDashboard((current) => {
      if (!current) return current;
      return updater(current);
    });
    setDashboardDirty(true);
  }, []);

  const enterCompany = useCallback(
    (companyId: string) => {
      void withBusy("enterCompany", async () => {
        await api.selectCompany(companyId);
        setSection("company");
        await hydrateWorkspace();
      });
    },
    [hydrateWorkspace, withBusy]
  );

  const createCompany = useCallback(
    (input: CreateCompanyRequest) =>
      withBusy("createCompany", async () => {
        const directory = await api.createCompany(input);
        setCompanies(directory.companies);
        setSelectedCompanyId(directory.selectedCompanyId);
        await hydrateWorkspace();
        return directory;
      }),
    [hydrateWorkspace, withBusy]
  );

  const updateCompany = useCallback(
    (companyId: string, input: UpdateCompanyRequest) =>
      withBusy("updateCompany", async () => {
        const directory = await api.updateCompany(companyId, input);
        setCompanies(directory.companies);
        setSelectedCompanyId(directory.selectedCompanyId);
        await hydrateWorkspace();
        return directory;
      }),
    [hydrateWorkspace, withBusy]
  );

  const deleteCompany = useCallback(
    (companyId: string) => {
      void withBusy("deleteCompany", async () => {
        await api.deleteCompany(companyId);
        await hydrateWorkspace();
      });
    },
    [hydrateWorkspace, withBusy]
  );

  const refreshCatalog = useCallback(
    () =>
      withBusy("refreshCatalog", async () => {
        const [nextCatalog, nextOpenClawConfig, nextOpenClawModelUsage, nextHarnessStatuses, nextHarnessSkillStatuses, nextRuntime] = await Promise.all([
          api.refreshCatalog(),
          api.getOpenClawConfig(),
          api.getOpenClawModelUsage().catch(() => []),
          api.getHarnessStatus().catch(() => []),
          loadHarnessSkillStatuses(),
          api.getRuntimeOverview().catch(() => emptyRuntimeOverview())
        ]);
        setCatalog(nextCatalog);
        setOpenClawConfig(nextOpenClawConfig);
        setOpenClawModelUsage(nextOpenClawModelUsage);
        setHarnessStatuses(nextHarnessStatuses);
        setHarnessSkillStatuses(nextHarnessSkillStatuses);
        setRuntime(nextRuntime);
      }),
    [withBusy]
  );

  const checkOpenClawUpdates = useCallback(
    () =>
      withBusy("checkOpenClawUpdates", async () => {
        const [nextOpenClawVersion, nextCatalog, nextOpenClawConfig, nextOpenClawModelUsage, nextHarnessStatuses, nextHarnessSkillStatuses, nextRuntime] = await Promise.all([
          api.getOpenClawVersion(),
          api.refreshCatalog(),
          api.getOpenClawConfig(),
          api.getOpenClawModelUsage().catch(() => []),
          api.getHarnessStatus().catch(() => []),
          loadHarnessSkillStatuses(),
          api.getRuntimeOverview().catch(() => emptyRuntimeOverview())
        ]);
        setOpenClawVersion(nextOpenClawVersion);
        setCatalog(nextCatalog);
        setOpenClawConfig(nextOpenClawConfig);
        setOpenClawModelUsage(nextOpenClawModelUsage);
        setHarnessStatuses(nextHarnessStatuses);
        setHarnessSkillStatuses(nextHarnessSkillStatuses);
        setRuntime(nextRuntime);
      }),
    [withBusy]
  );

  const checkHivewardUpdate = useCallback(async () => {
    setHivewardUpdateChecking(true);
    try {
      const nextUpdate = await api.getHivewardUpdate();
      setHivewardUpdate(nextUpdate);
    } catch (updateError) {
      setHivewardUpdate({
        source: "git",
        currentVersion: hivewardPackage.version,
        repositoryUrl: hivewardRepositoryUrl,
        checkedAt: new Date().toISOString(),
        updateAvailable: false,
        canApply: false,
        applyCommand: "",
        restartRequired: true,
        error: updateError instanceof Error ? updateError.message : String(updateError)
      });
    } finally {
      setHivewardUpdateChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkHivewardUpdate();
    const timer = window.setInterval(() => {
      void checkHivewardUpdate();
    }, HIVEWARD_UPDATE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkHivewardUpdate]);

  const applyHivewardUpdateAction = useCallback(() => {
    void withBusy("applyHivewardUpdate", async () => {
      const result = await api.applyHivewardUpdate();
      setHivewardUpdateResult(result);
      setHivewardUpdate(result.update);
    });
  }, [withBusy]);

  const refreshHarnessStatus = useCallback(
    () =>
      withBusy("refreshHarnessStatus", async () => {
        const [nextHarnessStatuses, nextHermesConfig, nextClaudeCodeModelResponse, nextHarnessSkillStatuses] = await Promise.all([
          api.getHarnessStatus(),
          api.getHermesConfig().catch(() => undefined),
          api.getClaudeCodeModelConfig().catch(() => undefined),
          loadHarnessSkillStatuses()
        ]);
        setHarnessStatuses(nextHarnessStatuses);
        setHermesConfig(nextHermesConfig);
        setClaudeCodeModelConfig(nextClaudeCodeModelResponse?.config);
        setClaudeCodeModelPresets(nextClaudeCodeModelResponse?.presets ?? []);
        setClaudeCodeSavedModelProfiles(nextClaudeCodeModelResponse?.savedProfiles ?? []);
        setHarnessSkillStatuses(nextHarnessSkillStatuses);
      }),
    [withBusy]
  );

  const addHermesProfile = useCallback(
    (input: CreateHermesProfileRequest) => {
      void withBusy("addHermesProfile", async () => {
        const nextHermesConfig = await api.addHermesProfile(input);
        const nextHarnessStatuses = await api.getHarnessStatus().catch(() => harnessStatuses);
        setHermesConfig(nextHermesConfig);
        setHarnessStatuses(nextHarnessStatuses);
      });
    },
    [harnessStatuses, withBusy]
  );

  const addHermesChannel = useCallback(
    (input: CreateHermesChannelRequest) => {
      void withBusy("addHermesChannel", async () => {
        const nextHermesConfig = await api.addHermesChannel(input);
        setHermesConfig(nextHermesConfig);
      });
    },
    [withBusy]
  );

  const installHarnessSkills = useCallback(
    (harnessId: HarnessId) => {
      void withBusy(`installHarnessSkills:${harnessId}`, async () => {
        const nextSkillStatus = await api.installHarnessSkills(harnessId);
        setHarnessSkillStatuses((current) => ({
          ...current,
          [harnessId]: nextSkillStatus
        }));
        if (harnessId === "openclaw") {
          const [nextCatalog, nextHarnessStatuses] = await Promise.all([
            api.refreshCatalog().catch(() => catalog),
            api.getHarnessStatus().catch(() => harnessStatuses)
          ]);
          if (nextCatalog) setCatalog(nextCatalog);
          setHarnessStatuses(nextHarnessStatuses);
        }
      });
    },
    [catalog, harnessStatuses, withBusy]
  );

  const addOpenClawAgent = useCallback(
    (input: { name: string; workspace?: string; modelId?: string }) => {
      void withBusy("addOpenClawAgent", async () => {
        const nextOpenClawConfig = await api.addOpenClawAgent(input);
        setOpenClawConfig(nextOpenClawConfig);
      });
    },
    [withBusy]
  );

  const configureOpenClawModelAuth = useCallback(
    (input: ConfigureOpenClawModelAuthRequest) => {
      void withBusy("configureOpenClawModelAuth", async () => {
        const nextOpenClawConfig = await api.configureOpenClawModelAuth(input);
        setOpenClawConfig(nextOpenClawConfig);
      });
    },
    [withBusy]
  );

  const setOpenClawDefaultModel = useCallback(
    (modelId: string) => {
      void withBusy(`setOpenClawDefaultModel:${modelId}`, async () => {
        const nextOpenClawConfig = await api.updateOpenClawDefaultModel(modelId);
        setOpenClawConfig(nextOpenClawConfig);
      });
    },
    [withBusy]
  );

  const updateClaudeCodeModelConfig = useCallback(
    (input: UpdateClaudeCodeModelConfigRequest) => {
      void withBusy("updateClaudeCodeModelConfig", async () => {
        const nextClaudeCodeModelResponse = await api.updateClaudeCodeModelConfig(input);
        const nextHarnessStatuses = await api.getHarnessStatus().catch(() => harnessStatuses);
        setClaudeCodeModelConfig(nextClaudeCodeModelResponse.config);
        setClaudeCodeModelPresets(nextClaudeCodeModelResponse.presets);
        setClaudeCodeSavedModelProfiles(nextClaudeCodeModelResponse.savedProfiles);
        setHarnessStatuses(nextHarnessStatuses);
      });
    },
    [harnessStatuses, withBusy]
  );

  const saveClaudeCodeModelProfile = useCallback(
    () => {
      void withBusy("saveClaudeCodeModelProfile", async () => {
        const nextClaudeCodeModelResponse = await api.saveClaudeCodeModelProfile();
        setClaudeCodeModelConfig(nextClaudeCodeModelResponse.config);
        setClaudeCodeModelPresets(nextClaudeCodeModelResponse.presets);
        setClaudeCodeSavedModelProfiles(nextClaudeCodeModelResponse.savedProfiles);
      });
    },
    [withBusy]
  );

  const applyClaudeCodeModelProfile = useCallback(
    (profileId: string) => {
      void withBusy(`applyClaudeCodeModelProfile:${profileId}`, async () => {
        const nextClaudeCodeModelResponse = await api.applyClaudeCodeModelProfile(profileId);
        const nextHarnessStatuses = await api.getHarnessStatus().catch(() => harnessStatuses);
        setClaudeCodeModelConfig(nextClaudeCodeModelResponse.config);
        setClaudeCodeModelPresets(nextClaudeCodeModelResponse.presets);
        setClaudeCodeSavedModelProfiles(nextClaudeCodeModelResponse.savedProfiles);
        setHarnessStatuses(nextHarnessStatuses);
      });
    },
    [harnessStatuses, withBusy]
  );

  const deleteClaudeCodeModelProfile = useCallback(
    (profileId: string) => {
      void withBusy(`deleteClaudeCodeModelProfile:${profileId}`, async () => {
        const nextClaudeCodeModelResponse = await api.deleteClaudeCodeModelProfile(profileId);
        setClaudeCodeModelConfig(nextClaudeCodeModelResponse.config);
        setClaudeCodeModelPresets(nextClaudeCodeModelResponse.presets);
        setClaudeCodeSavedModelProfiles(nextClaudeCodeModelResponse.savedProfiles);
      });
    },
    [withBusy]
  );

  const configureOpenClawChannel = useCallback(
    (input: ConfigureOpenClawChannelRequest) => {
      void withBusy("configureOpenClawChannel", async () => {
        const nextOpenClawConfig = await api.configureOpenClawChannel(input);
        setOpenClawConfig(nextOpenClawConfig);
      });
    },
    [withBusy]
  );

  const saveBlueprint = useCallback(() => {
    if (!blueprint) return;
    void withBusy("saveBlueprint", async () => {
      const savedSnapshot = blueprint;
      const saved = await api.saveBlueprint(applyHarnessPermissionModesToBlueprint(savedSnapshot, chatPermissionModes));
      acceptSavedBlueprintSnapshot(saved, savedSnapshot);
    });
  }, [acceptSavedBlueprintSnapshot, withBusy, blueprint, chatPermissionModes]);

  useEffect(() => {
    if (!selectedCompanyId) return;

    const saveDirtyBlueprints = async () => {
      if (blueprintAutosaveInFlightRef.current || busyActionRef.current) return;
      const dirtyBlueprints = listDirtyBlueprintsForAutosave(blueprintsRef.current, dirtyBlueprintIdsRef.current);
      if (dirtyBlueprints.length === 0) return;

      blueprintAutosaveInFlightRef.current = true;
      try {
        for (const dirtyBlueprint of dirtyBlueprints) {
          if (!dirtyBlueprintIdsRef.current.has(dirtyBlueprint.id)) continue;
          const savedSnapshot = blueprintsRef.current.find((candidate) => candidate.id === dirtyBlueprint.id);
          if (!savedSnapshot) continue;
          const saved = await api.saveBlueprint(
            applyHarnessPermissionModesToBlueprint(savedSnapshot, chatPermissionModesRef.current)
          );
          acceptSavedBlueprintSnapshot(saved, savedSnapshot);
        }
      } catch (autosaveError) {
        setError(autosaveError instanceof Error ? autosaveError.message : messageRef.current.errors.save);
      } finally {
        blueprintAutosaveInFlightRef.current = false;
      }
    };

    const timer = window.setInterval(() => {
      void saveDirtyBlueprints();
    }, BLUEPRINT_AUTOSAVE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [acceptSavedBlueprintSnapshot, selectedCompanyId]);

  const exportBlueprint = useCallback((blueprintId?: string) => {
    const targetBlueprint = blueprintId ? blueprints.find((item) => item.id === blueprintId) : blueprint;
    if (!targetBlueprint) return;
    void withBusy("exportBlueprint", async () => {
      const blueprintPackage = await api.exportBlueprint(targetBlueprint.id);
      downloadBlueprintPackage(blueprintPackage, targetBlueprint.name);
    });
  }, [blueprint, blueprints, withBusy]);

  const deleteBlueprint = useCallback((blueprintId: string) => {
    void withBusy("deleteBlueprint", async () => {
      await api.deleteBlueprint(blueprintId);
      setDirtyBlueprintIds((current) => {
        const next = removeBlueprintFromDirtySet(current, blueprintId);
        dirtyBlueprintIdsRef.current = next;
        return next;
      });
      const remainingBlueprints = blueprints.filter((item) => item.id !== blueprintId);
      const nextBlueprintId = blueprint?.id === blueprintId ? remainingBlueprints[0]?.id : blueprint?.id;
      await hydrateWorkspace({ blueprintId: nextBlueprintId });
    });
  }, [blueprint?.id, blueprints, hydrateWorkspace, withBusy]);

  const openBlueprintImport = useCallback(() => {
    blueprintImportInputRef.current?.click();
  }, []);

  const importBlueprintFile = useCallback(
    (file?: File) => {
      if (!file) return;
      void withBusy("importBlueprint", async () => {
        const blueprintPackage = JSON.parse(await file.text());
        const imported = await api.importBlueprintPackage(blueprintPackage);
        await hydrateWorkspace({ blueprintId: imported[0]?.id });
        setSection("blueprint");
      });
    },
    [hydrateWorkspace, withBusy]
  );

  const createBlueprint = useCallback(() => {
    void withBusy("createBlueprint", async () => {
      const created = await api.createBlueprint({
        name: defaultNewBlueprintName(blueprints.length + 1, language)
      });
      await hydrateWorkspace({ blueprintId: created.id });
      setSection("blueprint");
    });
  }, [hydrateWorkspace, language, withBusy, blueprints.length]);

  const runBlueprint = useCallback(() => {
    if (!blueprint) return;
    void withBusy("runBlueprint", async () => {
      const saved = await api.saveBlueprint(applyHarnessPermissionModesToBlueprint(blueprint, chatPermissionModes));
      blueprintRef.current = saved;
      selectedBlueprintIdRef.current = saved.id;
      setBlueprint(saved);
      setBlueprints((current) => {
        const next = replaceBlueprint(current, saved);
        blueprintsRef.current = next;
        return next;
      });
      setDirtyBlueprintIds((current) => {
        const next = clearBlueprintDirty(current, saved.id);
        dirtyBlueprintIdsRef.current = next;
        return next;
      });
      const runView = await api.startBlueprintRun(saved.id);
      applyRunView(runView);
      setRunPageBlueprintId(saved.id);
      setSelectedRunId(runView.run.id);
    });
  }, [applyRunView, withBusy, blueprint, chatPermissionModes]);

  const cancelBlueprintRun = useCallback(() => {
    const targetRunId = latestRunForBlueprint?.run.id;
    if (!targetRunId) return;
    void withBusy("cancelBlueprintRun", async () => {
      const updated = await api.cancelBlueprintRun(targetRunId);
      applyRunView(updated);
      setSelectedRunId(updated.run.id);
    });
  }, [applyRunView, latestRunForBlueprint?.run.id, withBusy]);

  const approveRun = useCallback(
    (blueprintRunId?: string, nodeRunId?: string, comment?: string, selectedReplyId?: string) => {
      const targetRunId = blueprintRunId ?? latestRunForBlueprint?.run.id;
      if (!targetRunId) return;
      void withBusy("approveRun", async () => {
        const updated = await api.approveBlueprintRun(targetRunId, nodeRunId, comment, selectedReplyId);
        applyRunView(updated);
        setSelectedRunId(updated.run.id);
      });
    },
    [applyRunView, latestRunForBlueprint?.run.id, withBusy]
  );

  const rejectRunApproval = useCallback(
    (blueprintRunId: string, nodeRunId: string, comment?: string) => {
      void withBusy("rejectRunApproval", async () => {
        const updated = await api.rejectBlueprintRun(blueprintRunId, nodeRunId, comment);
        applyRunView(updated);
        setSelectedRunId(updated.run.id);
      });
    },
    [applyRunView, withBusy]
  );

  const replyToRunApproval = useCallback(
    (blueprintRunId: string, nodeRunId: string, message: string) => {
      void withBusy("replyRunApproval", async () => {
        const updated = await api.replyToBlueprintRunApproval(blueprintRunId, nodeRunId, message);
        applyRunView(updated);
        setSelectedRunId(updated.run.id);
      });
    },
    [applyRunView, withBusy]
  );

  const applyApprovalRequestResponse = useCallback(
    async (response: Awaited<ReturnType<typeof api.approveApprovalRequest>>) => {
      if (response.run) {
        applyRunView(response.run);
        setSelectedRunId(response.run.run.id);
        return;
      }
      await hydrateWorkspace({ blueprintId: blueprint?.id });
    },
    [applyRunView, blueprint?.id, hydrateWorkspace]
  );

  const approveApprovalRequest = useCallback(
    (approvalRequestId: string, comment?: string, selectedReplyId?: string) => {
      void withBusy("approveApprovalRequest", async () => {
        await applyApprovalRequestResponse(await api.approveApprovalRequest(approvalRequestId, comment, selectedReplyId));
      });
    },
    [applyApprovalRequestResponse, withBusy]
  );

  const rejectApprovalRequest = useCallback(
    (approvalRequestId: string, comment?: string) => {
      void withBusy("rejectApprovalRequest", async () => {
        await applyApprovalRequestResponse(await api.rejectApprovalRequest(approvalRequestId, comment));
      });
    },
    [applyApprovalRequestResponse, withBusy]
  );

  const replyToApprovalRequest = useCallback(
    (approvalRequestId: string, message: string) => {
      void withBusy("replyApprovalRequest", async () => {
        await applyApprovalRequestResponse(await api.replyToApprovalRequest(approvalRequestId, message));
      });
    },
    [applyApprovalRequestResponse, withBusy]
  );

  const completeRunApproval = useCallback(
    (approvalRequestId: string, comment?: string) => {
      void withBusy("completeRunApproval", async () => {
        const response = await api.completeApprovalRequest(approvalRequestId, comment);
        await applyApprovalRequestResponse(response);
      });
    },
    [applyApprovalRequestResponse, withBusy]
  );

  const selectRunApprovalReply = useCallback(
    (blueprintRunId: string, nodeRunId: string, selectedReplyId: string) => {
      void withBusy("selectRunApprovalReply", async () => {
        const updated = await api.selectBlueprintRunApprovalReply(blueprintRunId, nodeRunId, selectedReplyId);
        applyRunView(updated);
        setSelectedRunId(updated.run.id);
      });
    },
    [applyRunView, withBusy]
  );

  const replyToInboxItem = useCallback(
    (itemId: string, message: string) => {
      void withBusy("replyInboxItem", async () => {
        const item = await api.replyToInboxItem(itemId, message);
        setInboxItems((current) => [item, ...current.filter((candidate) => candidate.id !== item.id)]);
      });
    },
    [withBusy]
  );

  const approveInboxItem = useCallback(
    (itemId: string, comment?: string) => {
      void withBusy("approveInboxItem", async () => {
        const result = await api.approveInboxItem(itemId, comment);
        await hydrateWorkspace({ blueprintId: result.importedBlueprints?.[0]?.id ?? blueprint?.id });
      });
    },
    [blueprint?.id, hydrateWorkspace, withBusy]
  );

  const rejectInboxItem = useCallback(
    (itemId: string, comment?: string) => {
      void withBusy("rejectInboxItem", async () => {
        await api.rejectInboxItem(itemId, comment);
        await hydrateWorkspace({ blueprintId: blueprint?.id });
      });
    },
    [blueprint?.id, hydrateWorkspace, withBusy]
  );

  const handleChatInboxItemCreated = useCallback(
    (item: InboxItem) => {
      setInboxItems((current) => [item, ...current.filter((candidate) => candidate.id !== item.id)]);
      void hydrateWorkspace({ blueprintId: item.blueprintId ?? blueprint?.id }).catch((refreshError) => {
        setError(refreshError instanceof Error ? refreshError.message : messageRef.current.errors.load);
      });
    },
    [blueprint?.id, hydrateWorkspace]
  );

  const addWidget = useCallback(
    (type: DashboardWidgetType) => {
      mutateDashboard((current) => ({
        ...current,
        dashboardWidgets: [
          ...current.dashboardWidgets,
          {
            id: makeClientId("widget"),
            type,
            title: defaultWidgetTitle(type, t),
            layout: defaultWidgetLayout(current.dashboardWidgets.length),
            config: {}
          }
        ],
        updatedAt: new Date().toISOString()
      }));
    },
    [mutateDashboard, t]
  );

  const removeWidget = useCallback(
    (widgetId: string) => {
      mutateDashboard((current) => ({
        ...current,
        dashboardWidgets: current.dashboardWidgets.filter((widget) => widget.id !== widgetId),
        updatedAt: new Date().toISOString()
      }));
    },
    [mutateDashboard]
  );

  const toggleLanguage = useCallback(() => {
    setLanguage((current) => (current === "zh-CN" ? "en" : "zh-CN"));
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const setSdkChatPermissionMode = useCallback((harnessId: SdkChatHarnessId, permissionMode: ChatPermissionMode) => {
    setChatPermissionModes((current) => ({ ...current, [harnessId]: permissionMode }));
  }, []);

  useEffect(() => {
    if (!systemMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (systemMenuRef.current?.contains(event.target as Node)) return;
      setSystemMenuOpen(false);
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [systemMenuOpen]);

  useEffect(() => {
    if (!selectedRunId || runDetailsById[selectedRunId]) return;

    let cancelled = false;
    void api.getBlueprintRun(selectedRunId)
      .then((runView) => {
        if (!cancelled) applyRunView(runView);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [applyRunView, runDetailsById, selectedRunId]);

  useEffect(() => {
    if (!pollingRunId) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const scheduleNextPoll = () => {
      timer = window.setTimeout(() => {
        void api.getBlueprintRun(pollingRunId)
          .then((runView) => {
            if (!cancelled) applyRunView(runView);
          })
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) scheduleNextPoll();
          });
      }, RUN_POLL_INTERVAL_MS);
    };

    scheduleNextPoll();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyRunView, pollingRunId]);

  useEffect(() => {
    if (!selectedCompanyId) return;

    let cancelled = false;
    let timer: number | undefined;

    const pollForBlueprintChanges = async () => {
      if (busyActionRef.current) return;

      try {
        const previousBlueprints = blueprintsRef.current;
        const nextBlueprints = await api.listBlueprints();
        const nextMergedBlueprints = mergeBlueprintsPreservingLocalEdits(
          nextBlueprints,
          previousBlueprints,
          dirtyBlueprintIdsRef.current
        );
        if (cancelled || blueprintCollectionSignature(nextMergedBlueprints) === blueprintCollectionSignature(previousBlueprints)) return;

        const selectedBlueprintId = selectedBlueprintIdRef.current;
        if (dirtyBlueprintIdsRef.current.size === 0) {
          await hydrateWorkspace({ blueprintId: selectedBlueprintId });
          return;
        }

        blueprintsRef.current = nextMergedBlueprints;
        setBlueprints(nextMergedBlueprints);
        const nextSelectedBlueprint = selectedBlueprintId
          ? nextMergedBlueprints.find((item) => item.id === selectedBlueprintId)
          : undefined;
        if (nextSelectedBlueprint && !dirtyBlueprintIdsRef.current.has(nextSelectedBlueprint.id)) {
          blueprintRef.current = nextSelectedBlueprint;
          setBlueprint(nextSelectedBlueprint);
        }
        const nextRoles = await api.getRoleDirectory().catch(() => undefined);
        if (cancelled || !nextRoles) return;
        setRoleDirectory(nextRoles.roles);
        setArchitecture(nextRoles.architecture);
      } catch {
        // Background refresh is opportunistic; user-triggered actions surface errors.
      }
    };

    const scheduleNextPoll = () => {
      timer = window.setTimeout(() => {
        void pollForBlueprintChanges().finally(() => {
          if (!cancelled) scheduleNextPoll();
        });
      }, BLUEPRINT_CHANGE_POLL_INTERVAL_MS);
    };

    scheduleNextPoll();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [hydrateWorkspace, selectedCompanyId]);

  const renderSection = () => {
    if (section === "hivewardHome") {
      return (
        <HivewardHomePage
          ui={hivewardHomeUi}
          language={language}
          versionLabel={hivewardVersionLabel}
          update={hivewardUpdate}
          updateResult={hivewardUpdateResult}
          checking={hivewardUpdateChecking}
          updating={busyAction === "applyHivewardUpdate"}
          onCheckUpdate={checkHivewardUpdate}
          onApplyUpdate={applyHivewardUpdateAction}
        />
      );
    }
    if (section === "companyDirectory") {
      return (
        <CompanyDirectoryPage
          companies={companies}
          selectedCompanyId={selectedCompanyId}
          language={language}
          busy={Boolean(busyAction)}
          onEnterCompany={enterCompany}
          onCreateCompany={createCompany}
          onUpdateCompany={updateCompany}
          onDeleteCompany={deleteCompany}
        />
      );
    }
    if (section === "company") {
      return <CompanyPage companies={companies} selectedCompanyId={selectedCompanyId} language={language} />;
    }
    if (section === "chat") {
      return (
        <ChatPage
          catalog={catalog}
          openClawConfig={openClawConfig}
          harnessStatuses={harnessStatuses}
          runtime={runtime}
          company={selectedCompany}
          selectedCompanyId={selectedCompanyId}
          blueprints={blueprints}
          roleDirectory={roleDirectory}
          language={language}
          harnessPermissionModes={chatPermissionModes}
          onInboxItemCreated={handleChatInboxItemCreated}
        />
      );
    }
    if (section === "openclaw") {
      return (
        <OpenClawControlPanelPage
          ui={openClawPanelUi}
          language={language}
          openClawVersionLabel={openClawVersionLabel}
          openClawVersionHealthy={openClawVersionHealthy}
          openClawVersion={openClawVersion}
          openClawConfig={openClawConfig}
          catalog={catalog}
          runtime={runtime}
          gatewaySettings={gatewaySettings}
          gatewayStatusLabel={gatewayStatusLabel}
          gatewaySourceLabel={gatewaySourceLabel}
          gatewayAuthLabel={gatewayAuthLabel}
          harnessStatus={openClawHarnessStatus}
          busy={openClawPanelBusy}
          skillStatus={harnessSkillStatuses.openclaw}
          skillBusy={installingOpenClawSkills}
          onCheckUpdates={checkOpenClawUpdates}
          onInstallSkills={() => installHarnessSkills("openclaw")}
        />
      );
    }
    if (section === "blueprint") {
      return (
        <BlueprintStudioPage
          blueprint={blueprint}
          blueprints={blueprints}
          architecture={architecture}
          roleDirectory={roleDirectory}
          catalog={catalog}
          configuredAgents={openClawConfig?.configuredAgents}
          harnessStatuses={harnessStatuses}
          harnessPermissionModes={chatPermissionModes}
          harnessSkillStatuses={harnessSkillStatuses}
          runSummaries={runSummaries}
          runView={latestRunForBlueprint}
          selectedNodeId={selectedNodeId}
          selectedCompanyId={selectedCompanyId}
          busy={Boolean(busyAction)}
          busyAction={busyAction}
          blueprintDirty={isSelectedBlueprintDirty}
          onSelectBlueprint={selectBlueprint}
          onCreateBlueprint={createBlueprint}
          onOpenBlueprintImport={openBlueprintImport}
          onExportBlueprint={exportBlueprint}
          onDeleteBlueprint={deleteBlueprint}
          onSaveBlueprint={saveBlueprint}
          onRunBlueprint={runBlueprint}
          onCancelBlueprintRun={cancelBlueprintRun}
          onSelectNode={setSelectedNodeId}
          onUpdateBlueprint={updateBlueprint}
          onUpdateArchitectureLayout={updateArchitectureLayout}
          onApproveRun={() => approveRun()}
          t={t}
        />
      );
    }
    if (section === "runs") {
      return (
        <RunsPage
          runs={runs}
          blueprints={blueprints}
          blueprint={runPageBlueprint}
          selectedRunId={selectedRunId}
          language={language}
          t={t}
          onSelectBlueprint={selectRunPageBlueprint}
          onSelectRun={setSelectedRunId}
        />
      );
    }
    if (section === "approvals") {
      return (
        <ApprovalsPage
          approvals={approvals}
          inboxItems={inboxItems}
          language={language}
          t={t}
          onApprove={approveRun}
          onApproveApprovalRequest={approveApprovalRequest}
          onComplete={completeRunApproval}
          onReject={rejectRunApproval}
          onRejectApprovalRequest={rejectApprovalRequest}
          onReply={replyToRunApproval}
          onReplyApprovalRequest={replyToApprovalRequest}
          onSelectApprovalReply={selectRunApprovalReply}
          onReplyInboxItem={replyToInboxItem}
          onApproveInboxItem={approveInboxItem}
          onRejectInboxItem={rejectInboxItem}
        />
      );
    }
    if (section === "models") {
      return (
        <ModelsPage
          catalog={catalog}
          openClawConfig={openClawConfig}
          wizard={openClawWizard}
          language={language}
          t={t}
          busy={Boolean(busyAction)}
          busyAction={busyAction}
          runs={runs}
          openClawModelUsage={openClawModelUsage}
          onRefreshCatalog={refreshCatalog}
          onConfigureModelAuth={configureOpenClawModelAuth}
          onSetDefaultModel={setOpenClawDefaultModel}
        />
      );
    }
    if (section === "agents") {
      return (
        <AgentsPage
          catalog={catalog}
          openClawConfig={openClawConfig}
          language={language}
          t={t}
          busy={Boolean(busyAction)}
          onAddAgent={addOpenClawAgent}
        />
      );
    }
    if (section === "skills") {
      return <SkillsPage catalog={catalog} language={language} t={t} />;
    }
    if (section === "claudeCodeConfig") {
      return (
        <HarnessConfigPage
          title={t.pages.claudeCodeConfig?.title ?? "Claude code Config"}
          description={t.pages.claudeCodeConfig?.description ?? ""}
          status={claudeCodeHarnessStatus}
          fallbackLabel={harnessDisplayLabel("claudeCode")}
          fallbackHarnessId="claudeCode"
          language={language}
          busy={busyAction === "refreshHarnessStatus"}
          skillStatus={harnessSkillStatuses.claudeCode}
          skillBusy={installingClaudeCodeSkills}
          permissionMode={chatPermissionModes.claudeCode}
          onPermissionModeChange={(permissionMode) => setSdkChatPermissionMode("claudeCode", permissionMode)}
          onRefresh={refreshHarnessStatus}
          onInstallSkills={() => installHarnessSkills("claudeCode")}
        />
      );
    }
    if (section === "claudeCodeModels") {
      return (
        <ClaudeCodeModelsPage
          config={claudeCodeModelConfig}
          presets={claudeCodeModelPresets}
          savedProfiles={claudeCodeSavedModelProfiles}
          status={claudeCodeHarnessStatus}
          language={language}
          busy={busyAction === "updateClaudeCodeModelConfig"}
          busyAction={busyAction}
          refreshBusy={busyAction === "refreshHarnessStatus"}
          onRefresh={refreshHarnessStatus}
          onUpdate={updateClaudeCodeModelConfig}
          onSaveProfile={saveClaudeCodeModelProfile}
          onApplyProfile={applyClaudeCodeModelProfile}
          onDeleteProfile={deleteClaudeCodeModelProfile}
        />
      );
    }
    if (section === "codexConfig") {
      return (
        <HarnessConfigPage
          title={t.pages.codexConfig?.title ?? "Codex Config"}
          description={t.pages.codexConfig?.description ?? ""}
          status={codexHarnessStatus}
          fallbackLabel={harnessDisplayLabel("codex")}
          fallbackHarnessId="codex"
          language={language}
          busy={busyAction === "refreshHarnessStatus"}
          skillStatus={harnessSkillStatuses.codex}
          skillBusy={installingCodexSkills}
          permissionMode={chatPermissionModes.codex}
          onPermissionModeChange={(permissionMode) => setSdkChatPermissionMode("codex", permissionMode)}
          onRefresh={refreshHarnessStatus}
          onInstallSkills={() => installHarnessSkills("codex")}
        />
      );
    }
    if (section === "googleConfig") {
      return (
        <HarnessConfigPage
          title={t.pages.googleConfig?.title ?? "Google CLI Beta Config"}
          description={t.pages.googleConfig?.description ?? ""}
          status={googleHarnessStatus}
          fallbackLabel={harnessDisplayLabel("google")}
          fallbackHarnessId="google"
          language={language}
          busy={busyAction === "refreshHarnessStatus"}
          skillStatus={harnessSkillStatuses.google}
          skillBusy={installingGoogleSkills}
          permissionMode={chatPermissionModes.google}
          onPermissionModeChange={(permissionMode) => setSdkChatPermissionMode("google", permissionMode)}
          onRefresh={refreshHarnessStatus}
          onInstallSkills={() => installHarnessSkills("google")}
        />
      );
    }
    if (section === "cursorConfig") {
      return (
        <HarnessConfigPage
          title={t.pages.cursorConfig?.title ?? "Cursor CLI Beta Config"}
          description={t.pages.cursorConfig?.description ?? ""}
          status={cursorHarnessStatus}
          fallbackLabel={harnessDisplayLabel("cursor")}
          fallbackHarnessId="cursor"
          language={language}
          busy={busyAction === "refreshHarnessStatus"}
          skillStatus={harnessSkillStatuses.cursor}
          skillBusy={installingCursorSkills}
          permissionMode={chatPermissionModes.cursor}
          onPermissionModeChange={(permissionMode) => setSdkChatPermissionMode("cursor", permissionMode)}
          onRefresh={refreshHarnessStatus}
          onInstallSkills={() => installHarnessSkills("cursor")}
        />
      );
    }
    if (section === "opencodeConfig") {
      return (
        <HarnessConfigPage
          title={t.pages.opencodeConfig?.title ?? "OpenCode Beta Config"}
          description={t.pages.opencodeConfig?.description ?? ""}
          status={opencodeHarnessStatus}
          fallbackLabel={harnessDisplayLabel("opencode")}
          fallbackHarnessId="opencode"
          language={language}
          busy={busyAction === "refreshHarnessStatus"}
          skillStatus={harnessSkillStatuses.opencode}
          skillBusy={installingOpenCodeSkills}
          permissionMode={chatPermissionModes.opencode}
          onPermissionModeChange={(permissionMode) => setSdkChatPermissionMode("opencode", permissionMode)}
          onRefresh={refreshHarnessStatus}
          onInstallSkills={() => installHarnessSkills("opencode")}
        />
      );
    }
    if (section === "hermesConfig") {
      return (
        <HarnessConfigPage
          title={t.pages.hermesConfig?.title ?? "Hermes Beta Config"}
          description={t.pages.hermesConfig?.description ?? ""}
          status={hermesHarnessStatus}
          fallbackLabel={harnessDisplayLabel("hermes")}
          fallbackHarnessId="hermes"
          language={language}
          busy={busyAction === "refreshHarnessStatus"}
          skillStatus={harnessSkillStatuses.hermes}
          skillBusy={installingHermesSkills}
          permissionMode={chatPermissionModes.hermes}
          onPermissionModeChange={(permissionMode) => setSdkChatPermissionMode("hermes", permissionMode)}
          onRefresh={refreshHarnessStatus}
          onInstallSkills={() => installHarnessSkills("hermes")}
        />
      );
    }
    if (section === "hermesModels") {
      return (
        <HermesModelsPage
          title={t.pages.hermesModels?.title ?? "Hermes Models"}
          description={t.pages.hermesModels?.description ?? ""}
          status={hermesHarnessStatus}
          language={language}
          busy={busyAction === "refreshHarnessStatus"}
          onRefresh={refreshHarnessStatus}
        />
      );
    }
    if (section === "hermesAgents") {
      return (
        <HermesAgentsPage
          title={t.pages.hermesAgents?.title ?? "Hermes Agents"}
          description={t.pages.hermesAgents?.description ?? ""}
          config={hermesConfig}
          status={hermesHarnessStatus}
          language={language}
          busy={busyAction === "addHermesProfile"}
          refreshBusy={busyAction === "refreshHarnessStatus"}
          onRefresh={refreshHarnessStatus}
          onAddProfile={addHermesProfile}
        />
      );
    }
    if (section === "hermesSkills") {
      return (
        <HarnessSkillsPage
          title={t.pages.hermesSkills?.title ?? "Hermes Skills"}
          description={t.pages.hermesSkills?.description ?? ""}
          language={language}
          skillStatus={harnessSkillStatuses.hermes}
          hermesSkills={hermesConfig?.skills}
          busy={installingHermesSkills}
          onInstallSkills={() => installHarnessSkills("hermes")}
        />
      );
    }
    if (section === "hermesChannels") {
      return (
        <HermesChannelsPage
          title={t.pages.hermesChannels?.title ?? "Hermes Channels"}
          description={t.pages.hermesChannels?.description ?? ""}
          config={hermesConfig}
          language={language}
          busy={busyAction === "addHermesChannel"}
          refreshBusy={busyAction === "refreshHarnessStatus"}
          onRefresh={refreshHarnessStatus}
          onAddChannel={addHermesChannel}
        />
      );
    }
    if (section === "schedule") {
      return (
        <HistoryPage
          runs={runs}
          approvals={approvals}
          blueprints={blueprints}
          language={language}
          t={t}
          onOpenRun={openRunFromHistory}
        />
      );
    }
    if (section === "channels") {
      return (
      <ChannelsPage
        catalog={catalog}
        openClawConfig={openClawConfig}
        wizard={openClawWizard}
        language={language}
        t={t}
        busy={Boolean(busyAction)}
        onConfigureChannel={configureOpenClawChannel}
      />
      );
    }
    return null;
  };

  return (
    <main className="app-shell">
      <aside className="sidebar-shell">
        <div className="sidebar-brand">
          <div className="brand-mark">
            <img src="/brand/hiveward-hive.png" alt="" />
          </div>
          <div>
            <img
              className="brand-wordmark"
              src={theme === "dark" ? "/brand/hiveward-wordmark-on-dark.png" : "/brand/hiveward-wordmark.png"}
              alt="Hiveward"
            />
          </div>
        </div>
        <nav className="sidebar-nav">
          {appSectionGroups.map((group) => {
            const expanded = expandedSystems[group.id];
            const groupActive = group.sections.some((item) => item === section);
            const systemChildrenId = `sidebar-system-${group.id}`;
            const SystemChevron = expanded ? ChevronDown : ChevronRight;
            return (
              <section key={group.id} className={`nav-system-group ${groupActive ? "active" : ""}`}>
                <button
                  type="button"
                  className={`nav-system-toggle ${groupActive ? "active" : ""}`}
                  aria-expanded={expanded}
                  aria-controls={group.sections.length > 0 ? systemChildrenId : undefined}
                  onClick={() => toggleSystemGroup(group.id)}
                >
                  <span className="nav-system-main">
                    <SystemChevron size={14} />
                    <AppSystemLabel systemId={group.id} />
                  </span>
                </button>
                {expanded && group.sections.length > 0 && (
                  <div id={systemChildrenId} className="nav-system-children">
                    {group.sections.map((item) => {
                      const Icon = sidebarIcons[item];
                      return (
                        <button
                          key={item}
                          type="button"
                          className={`nav-item ${section === item ? "active" : ""}`}
                          onClick={() => {
                            setSection(item);
                            setSystemMenuOpen(false);
                          }}
                        >
                          <span className="nav-item-main">
                            <Icon size={16} />
                            <span className="nav-item-label">{t.navigation[item] ?? fallbackNavigationLabel(item, language)}</span>
                          </span>
                          {sidebarMeta[item] !== undefined && <span className="nav-count">{sidebarMeta[item]}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </nav>
        <div className="sidebar-status">
          {dashboardDirty && <span className="status-badge">{t.common.dirtyWorkspace}</span>}
          <div className="sidebar-system" ref={systemMenuRef}>
            <div className="sidebar-company">
              <button
                type="button"
                className={`company-switcher sidebar-company-switcher ${section === "companyDirectory" ? "active" : ""}`}
                title={selectedCompany?.name ?? companySwitcherLabel}
                onClick={() => {
                  setSection("companyDirectory");
                  setSystemMenuOpen(false);
                }}
              >
                <span className="company-switcher-avatar">
                  {selectedCompany?.logoUrl ? (
                    <img src={selectedCompany.logoUrl} alt={selectedCompany.name} />
                  ) : (
                    <span>{companyMonogram(selectedCompany)}</span>
                  )}
                </span>
                <span className="company-switcher-copy">
                  <strong>{selectedCompany?.name ?? companySwitcherLabel}</strong>
                </span>
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="sidebar-system-control">
              <button
                type="button"
                className={`sidebar-system-version ${hivewardUpdate?.updateAvailable ? "update-available" : "online"} ${section === "hivewardHome" ? "active" : ""}`}
                aria-label={hivewardVersionTitle}
                title={hivewardVersionTitle}
                onClick={() => {
                  setSystemMenuOpen(false);
                  setSection("hivewardHome");
                  void checkHivewardUpdate();
                }}
              >
                <span className="sidebar-system-dot" aria-hidden="true" />
                <strong>{hivewardVersionLabel}</strong>
                {hivewardUpdate?.updateAvailable && <span className="sidebar-system-update-badge">{hivewardHomeUi.newBadge}</span>}
              </button>
              <button
                type="button"
                className={`sidebar-system-settings ${systemMenuOpen ? "active" : ""}`}
                title={systemUi.settings}
                aria-label={systemUi.settings}
                aria-expanded={systemMenuOpen}
                onClick={() => {
                  setSystemMenuOpen((current) => !current);
                }}
              >
                <Settings size={14} />
              </button>
              {systemMenuOpen && (
                <div className="sidebar-system-menu" aria-label={systemUi.title}>
                  <button type="button" title={themeToggleTitle} aria-label={themeToggleTitle} onClick={toggleTheme}>
                    {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
                    <span>{systemUi.theme}</span>
                    <strong>{themeToggleLabel}</strong>
                  </button>
                  <button type="button" title={t.actions.switchLanguage} aria-label={t.actions.switchLanguage} onClick={toggleLanguage}>
                    <Languages size={14} />
                    <span>{systemUi.language}</span>
                    <strong>{language === "zh-CN" ? "ZH" : "EN"}</strong>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </aside>

      <section className="main-shell">
        <input
          ref={blueprintImportInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            importBlueprintFile(event.target.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        <section className="page-shell">
          {error && <div className="error-banner">{error}</div>}
          {renderSection()}
        </section>
      </section>
    </main>
  );
}

function HivewardHomePage({
  ui,
  language,
  versionLabel,
  update,
  updateResult,
  checking,
  updating,
  onCheckUpdate,
  onApplyUpdate
}: {
  ui: HivewardHomeCopy;
  language: Language;
  versionLabel: string;
  update?: HivewardUpdateStatus;
  updateResult?: ApplyHivewardUpdateResponse;
  checking: boolean;
  updating: boolean;
  onCheckUpdate: () => void;
  onApplyUpdate: () => void;
}) {
  const updateAvailable = Boolean(update?.updateAvailable);
  const updateStatusLabel = update?.error
    ? ui.updateUnknown
    : updateAvailable
      ? ui.updateAvailable
      : update
        ? ui.upToDate
        : ui.updateUnknown;
  const updateTone = update?.error ? "offline" : updateAvailable ? "update" : "online";
  const latestLabel = update?.latestVersion
    ? `v${update.latestVersion}`
    : update?.latestCommit
      ? shortCommit(update.latestCommit)
      : ui.none;
  const sourceLabel = update?.source === "npm" ? "npm" : "GitHub";
  const canApply = Boolean(update?.updateAvailable && update.canApply && !updating);

  return (
    <section className="hiveward-home-page" aria-label="Hiveward">
      <div className="hiveward-home-hero">
        <img className="hiveward-home-logo" src="/brand/hiveward-hive.png" alt="Hiveward" />
        <div className="hiveward-home-title">
          <span>{versionLabel}</span>
          <h2>{ui.title}</h2>
          <p>{ui.subtitle}</p>
        </div>
        <div className="hiveward-home-actions">
          <a className="primary-link-button" href={hivewardRepositoryUrl} target="_blank" rel="noreferrer">
            <Github size={16} />
            {ui.github}
            <ExternalLink size={13} />
          </a>
          <button type="button" onClick={onCheckUpdate} disabled={checking || updating}>
            <RefreshCw size={14} className={checking ? "spin" : undefined} />
            {checking ? ui.checking : ui.checkUpdate}
          </button>
        </div>
      </div>

      <div className="hiveward-update-panel">
        <div className="hiveward-update-head">
          <div>
            <span className={`openclaw-panel-state ${updateTone}`}>{updateStatusLabel}</span>
            <h3>{ui.updateTitle}</h3>
          </div>
          <button type="button" onClick={onApplyUpdate} disabled={!canApply}>
            <Download size={14} className={updating ? "spin" : undefined} />
            {updating ? ui.updating : ui.applyUpdate}
          </button>
        </div>
        <div className="openclaw-panel-metrics">
          <OpenClawPanelMetric label={ui.current} value={versionLabel} />
          <OpenClawPanelMetric label={ui.latest} value={latestLabel} tone={updateAvailable ? "offline" : "online"} />
          <OpenClawPanelMetric label={ui.source} value={sourceLabel} />
          <OpenClawPanelMetric label={ui.lastChecked} value={formatDateTimeLabel(update?.checkedAt, language, ui.none)} />
        </div>
        {update?.error && <p className="hiveward-update-note">{update.error}</p>}
        {update && !update.canApply && update.updateAvailable && <p className="hiveward-update-note">{ui.cannotAutoApply}</p>}
        {updateResult && (
          <p className="hiveward-update-note">
            {updateResult.applied ? ui.updateApplied : updateResult.output || ui.updateSkipped}
          </p>
        )}
      </div>

      <div className="hiveward-readme-layout">
        <div className="hiveward-readme-left">
          <article className="hiveward-home-notice">
            <span>{ui.permissionNotice.eyebrow(versionLabel)}</span>
            <h3>{ui.permissionNotice.title}</h3>
            <p>{ui.permissionNotice.body}</p>
            <p>{ui.permissionNotice.risk}</p>
          </article>

          <article className="hiveward-readme-main">
            {ui.readmeSections.map((section) => (
              <section key={section.title} className="hiveward-readme-section">
                <h3>{section.title}</h3>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {section.items && (
                  <ul>
                    {section.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </article>
        </div>
        <aside className="hiveward-community-panel">
          <div className="hiveward-community-qr">
            <img src="/community/wechat-group.jpg" alt={ui.communityTitle} />
          </div>
          <h3>{ui.communityTitle}</h3>
          <p>{ui.communityPlaceholder}</p>
        </aside>
      </div>
    </section>
  );
}

function OpenClawControlPanelPage({
  ui,
  language,
  openClawVersionLabel,
  openClawVersionHealthy,
  openClawVersion,
  openClawConfig,
  catalog,
  runtime,
  gatewaySettings,
  gatewayStatusLabel,
  gatewaySourceLabel,
  gatewayAuthLabel,
  harnessStatus,
  busy,
  skillStatus,
  skillBusy,
  onCheckUpdates,
  onInstallSkills
}: {
  ui: OpenClawPanelCopy;
  language: Language;
  openClawVersionLabel: string;
  openClawVersionHealthy: boolean;
  openClawVersion?: OpenClawVersionInfo;
  openClawConfig?: OpenClawConfigState;
  catalog?: CatalogSnapshot;
  runtime?: RuntimeOverview;
  gatewaySettings?: OpenClawConfigState["gateway"];
  gatewayStatusLabel: string;
  gatewaySourceLabel: string;
  gatewayAuthLabel: string;
  harnessStatus?: HarnessStatus;
  busy: boolean;
  skillStatus?: HarnessSkillStatusResponse;
  skillBusy: boolean;
  onCheckUpdates: () => void;
  onInstallSkills: () => void;
}) {
  return (
    <section id="openclaw-control-panel" className="page-grid openclaw-control-page">
      <div className="trace-page-title openclaw-page-title">
        <div className="openclaw-panel-title">
          <Cloud size={18} />
          <div>
            <strong>{ui.title}</strong>
            <span>{ui.subtitle}</span>
          </div>
        </div>
        <div className="openclaw-page-actions">
          <span className={`openclaw-panel-state ${openClawVersionHealthy ? "online" : "offline"}`}>
            {openClawVersionHealthy ? ui.available : ui.unavailable}
          </span>
          <button type="button" onClick={onCheckUpdates} disabled={busy}>
            <RefreshCw size={14} className={busy ? "spin" : undefined} />
            {busy ? ui.checking : ui.checkUpdates}
          </button>
        </div>
      </div>

      <div className="content-card stack-card openclaw-status-card">
        <div className="openclaw-panel-metrics">
          <OpenClawPanelMetric label={ui.version} value={openClawVersionLabel} />
          <OpenClawPanelMetric label={ui.gateway} value={gatewayStatusLabel} tone={gatewaySettings?.url ? "online" : "offline"} />
          <OpenClawPanelMetric label={ui.config} value={(openClawConfig?.configuredModels.length ?? 0) + (openClawConfig?.configuredAgents.length ?? 0)} />
          <OpenClawPanelMetric label={ui.activity} value={runtime?.tasks.length ?? 0} />
        </div>
      </div>

      <HarnessStatusBlock status={harnessStatus} language={language} fallbackLabel={harnessDisplayLabel("openclaw")} fallbackHarnessId="openclaw" />

      <div className="openclaw-control-grid">
        <div className="content-card stack-card openclaw-control-section">
          <div className="card-title-block">
            <h3>{ui.gateway}</h3>
          </div>
          <OpenClawPanelRow label={ui.url} value={gatewaySettings?.url ?? ui.none} />
          <OpenClawPanelRow label={ui.origin} value={gatewaySettings?.origin ?? ui.none} />
          <OpenClawPanelRow label={ui.source} value={gatewaySourceLabel} />
          <OpenClawPanelRow label={ui.auth} value={gatewayAuthLabel} />
          <OpenClawPanelRow label={ui.locale} value={gatewaySettings?.locale ?? ui.none} />
          <OpenClawPanelRow label={ui.requestTimeout} value={formatDurationMs(gatewaySettings?.requestTimeoutMs, ui.none)} />
          <OpenClawPanelRow label={ui.agentStartTimeout} value={formatDurationMs(gatewaySettings?.agentStartTimeoutMs, ui.none)} />
        </div>

        <div className="content-card stack-card openclaw-control-section">
          <div className="card-title-block">
            <h3>{ui.config}</h3>
          </div>
          <OpenClawPanelRow label={ui.configPath} value={openClawConfig?.configPath ?? ui.none} />
          <OpenClawPanelRow label={ui.workspace} value={openClawConfig?.defaultWorkspace ?? ui.none} />
          <OpenClawPanelRow label={ui.defaultModel} value={openClawConfig?.defaultModelId ?? ui.none} />
          <OpenClawPanelRow label={ui.models} value={(openClawConfig?.configuredModels.length ?? catalog?.models.length ?? 0).toLocaleString(language)} />
          <OpenClawPanelRow label={ui.agents} value={(openClawConfig?.configuredAgents.length ?? catalog?.agents.length ?? 0).toLocaleString(language)} />
          <OpenClawPanelRow label={ui.channels} value={(openClawConfig?.configuredChannels.length ?? catalog?.channels.length ?? 0).toLocaleString(language)} />
          <OpenClawPanelRow label={ui.catalogRefreshed} value={formatDateTimeLabel(catalog?.refreshedAt, language, ui.none)} />
          <OpenClawPanelRow label={ui.lastChecked} value={formatDateTimeLabel(openClawVersion?.resolvedAt, language, ui.none)} />
        </div>
      </div>

      <HarnessSkillsCard
        ui={ui}
        skillStatus={skillStatus}
        language={language}
        busy={skillBusy}
        onInstallSkills={onInstallSkills}
      />
    </section>
  );
}

function HarnessConfigPage({
  title,
  description,
  status,
  fallbackLabel,
  fallbackHarnessId,
  language,
  busy,
  skillStatus,
  skillBusy,
  permissionMode,
  onPermissionModeChange,
  onRefresh,
  onInstallSkills,
  children
}: {
  title: string;
  description: string;
  status?: HarnessStatus;
  fallbackLabel: string;
  fallbackHarnessId?: HarnessId;
  language: Language;
  busy: boolean;
  skillStatus?: HarnessSkillStatusResponse;
  skillBusy: boolean;
  permissionMode?: ChatPermissionMode;
  onPermissionModeChange?: (permissionMode: ChatPermissionMode) => void;
  onRefresh: () => void;
  onInstallSkills: () => void;
  children?: ReactNode;
}) {
  const copy = harnessStatusCopy(language);
  const skillUi = openClawPanelSkillCopy(language);
  const permissionCopy = harnessPermissionCopy(language);
  const connectionState = status?.connectionState ?? "unavailable";
  const healthy = connectionState === "connected" || connectionState === "available";
  return (
    <section className="page-grid openclaw-control-page">
      <div className="trace-page-title openclaw-page-title">
        <div className="openclaw-panel-title">
          <Settings size={18} />
          <div>
            <strong>{title}</strong>
            <span>{description}</span>
          </div>
        </div>
        <div className="openclaw-page-actions">
          <span className={`openclaw-panel-state ${healthy ? "online" : "offline"}`}>{copy.states[connectionState]}</span>
          <button type="button" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={14} className={busy ? "spin" : undefined} />
            {busy ? copy.checking : copy.check}
          </button>
        </div>
      </div>

      <HarnessStatusBlock status={status} language={language} fallbackLabel={fallbackLabel} fallbackHarnessId={fallbackHarnessId} />

      {permissionMode && onPermissionModeChange ? (
        <div className="content-card stack-card harness-permission-card">
          <div className="card-title-block harness-permission-title">
            <h3>{permissionCopy.title}</h3>
            <span className="harness-permission-help" tabIndex={0} aria-label={permissionCopy.helpAria}>
              <CircleAlert size={14} />
              <span className="harness-permission-tooltip" role="tooltip">
                <strong>{permissionMode === "full_access" ? permissionCopy.fullLabel : permissionCopy.safeLabel}</strong>
                <span>{permissionMode === "full_access" ? permissionCopy.fullBody : permissionCopy.safeBody}</span>
                <span>{permissionMode === "full_access" ? permissionCopy.fullWarning : permissionCopy.safeWarning}</span>
              </span>
            </span>
          </div>
          <label className={`harness-permission-toggle ${permissionMode === "full_access" ? "enabled" : ""}`}>
            <input
              type="checkbox"
              checked={permissionMode === "full_access"}
              onChange={(event) => onPermissionModeChange(event.target.checked ? "full_access" : "safe")}
            />
            <span className="harness-permission-switch" aria-hidden="true" />
            <span className="harness-permission-copy">
              <strong>{permissionMode === "full_access" ? permissionCopy.fullLabel : permissionCopy.safeLabel}</strong>
            </span>
          </label>
        </div>
      ) : null}

      {children}

      <HarnessSkillsCard
        ui={skillUi}
        skillStatus={skillStatus}
        language={language}
        busy={skillBusy}
        onInstallSkills={onInstallSkills}
      />
    </section>
  );
}

type ClaudeCodeModelSlotField = "fallbackModelId" | "haikuModelId" | "sonnetModelId" | "opusModelId";

function ClaudeCodeModelsPage({
  config,
  presets,
  savedProfiles,
  status,
  language,
  busy,
  busyAction,
  refreshBusy,
  onRefresh,
  onUpdate,
  onSaveProfile,
  onApplyProfile,
  onDeleteProfile
}: {
  config?: ClaudeCodeModelConfig;
  presets: ClaudeCodeModelPreset[];
  savedProfiles: ClaudeCodeSavedModelProfile[];
  status?: HarnessStatus;
  language: Language;
  busy: boolean;
  busyAction?: string;
  refreshBusy: boolean;
  onRefresh: () => void;
  onUpdate: (input: UpdateClaudeCodeModelConfigRequest) => void;
  onSaveProfile: () => void;
  onApplyProfile: (profileId: string) => void;
  onDeleteProfile: (profileId: string) => void;
}) {
  const copy =
    language === "zh-CN"
      ? {
          configuredModels: "\u5df2\u914d\u7f6e\u6a21\u578b",
          savedModels: "\u5df2\u4fdd\u5b58\u6a21\u578b",
          configureModels: "\u6a21\u578b\u914d\u7f6e",
          refresh: "\u91cd\u65b0\u68c0\u67e5",
          refreshing: "\u68c0\u67e5\u4e2d",
          empty: "\u914d\u7f6e\u6570\u636e\u5c1a\u672a\u52a0\u8f7d",
          noSavedProfiles: "\u5c1a\u672a\u4fdd\u5b58\u6a21\u578b\u914d\u7f6e",
          saveCurrent: "\u4fdd\u5b58\u5f53\u524d\u914d\u7f6e",
          savingCurrent: "\u4fdd\u5b58\u4e2d",
          applyProfile: "\u542f\u7528",
          activeProfile: "\u5df2\u542f\u7528",
          applyingProfile: "\u542f\u7528\u4e2d",
          deleteProfile: "\u5220\u9664",
          switchModel: "\u5207\u6362",
          saveSwitch: "\u4fdd\u5b58",
          cancel: "\u53d6\u6d88",
          provider: "\u5e73\u53f0",
          defaultModel: "\u9ed8\u8ba4",
          lightModel: "\u8f7b\u91cf",
          primaryModel: "\u4e3b\u529b",
          advancedModel: "\u9ad8\u9636"
        }
      : {
          configuredModels: "Configured models",
          savedModels: "Saved models",
          configureModels: "Model config",
          refresh: "Refresh",
          refreshing: "Checking",
          empty: "Config data not loaded",
          noSavedProfiles: "No saved model configs yet",
          saveCurrent: "Save current config",
          savingCurrent: "Saving",
          applyProfile: "Use",
          activeProfile: "Enabled",
          applyingProfile: "Using",
          deleteProfile: "Delete",
          switchModel: "Switch",
          saveSwitch: "Save",
          cancel: "Cancel",
          provider: "Provider",
          defaultModel: "Default",
          lightModel: "Light",
          primaryModel: "Primary",
          advancedModel: "Advanced"
        };
  const modelCardCopy =
    language === "zh-CN"
      ? {
          usage: "\u7528\u91cf",
          calls: "\u8c03\u7528",
          tokens: "Token",
          cost: "\u8d39\u7528",
          recent7d: "\u6700\u8fd1 7 \u5929",
          defaultOption: "\u9ed8\u8ba4"
        }
      : {
          usage: "Usage",
          calls: "Calls",
          tokens: "Tokens",
          cost: "Cost",
          recent7d: "Last 7 days",
          defaultOption: "Default"
        };
  const configuredModels = useMemo(() => buildConfiguredClaudeCodeModels(config, presets, language), [config, language, presets]);
  const modelOptions = useMemo(() => buildClaudeCodeModelOptions(status, presets), [presets, status?.models]);
  const activeProviderModelOptions = useMemo(
    () => buildClaudeCodeModelOptions(status, presets, config?.providerPresetId),
    [config?.providerPresetId, presets, status?.models]
  );
  const [visibleSavedProfiles, setVisibleSavedProfiles] = useState<ClaudeCodeSavedModelProfile[]>(() => getVisibleClaudeCodeSavedProfiles(savedProfiles));
  const [slotDrafts, setSlotDrafts] = useState<Partial<Record<ClaudeCodeModelSlotField, string>>>({});
  const [editingSlot, setEditingSlot] = useState<ClaudeCodeModelSlotField | undefined>();

  useEffect(() => {
    setVisibleSavedProfiles((current) => getVisibleClaudeCodeSavedProfiles(savedProfiles, current));
  }, [savedProfiles]);

  useEffect(() => {
    setSlotDrafts(Object.fromEntries(configuredModels.map((model) => [model.modelField, model.id])) as Partial<Record<ClaudeCodeModelSlotField, string>>);
  }, [configuredModels]);

  const startSwitchModelSlot = (modelField: ClaudeCodeModelSlotField) => {
    setEditingSlot(modelField);
  };

  const updateSlotDraft = (modelField: ClaudeCodeModelSlotField, value: string) => {
    setSlotDrafts((current) => ({ ...current, [modelField]: value }));
  };

  const switchModelSlot = (modelField: ClaudeCodeModelSlotField) => {
    const nextModelId = String(slotDrafts[modelField] ?? "").trim();
    if (!nextModelId) return;
    onUpdate({ [modelField]: nextModelId } as UpdateClaudeCodeModelConfigRequest);
    setEditingSlot(undefined);
  };

  return (
    <>
      <section className="page-grid">
        <div className="content-card stack-card">
          <div className="card-toolbar">
            <div className="card-title-block">
              <h3>{copy.configuredModels}</h3>
            </div>
            <div className="card-actions">
              <button type="button" disabled={busyAction === "saveClaudeCodeModelProfile" || configuredModels.length === 0} onClick={onSaveProfile}>
                {busyAction === "saveClaudeCodeModelProfile" ? <RefreshCw size={16} className="spin" /> : <Save size={16} />}
                {busyAction === "saveClaudeCodeModelProfile" ? copy.savingCurrent : copy.saveCurrent}
              </button>
              <button type="button" title={copy.refresh} disabled={refreshBusy} onClick={onRefresh}>
                <RefreshCw size={16} className={refreshBusy ? "spin" : undefined} />
                {refreshBusy ? copy.refreshing : copy.refresh}
              </button>
            </div>
          </div>
          <div className="model-card-grid claude-code-model-list">
            {configuredModels.length ? (
              configuredModels.map((model) => (
                <ConfiguredModelCard
                  key={`${model.modelField}:${model.id}`}
                  model={{ id: model.id, provider: model.providerId, label: model.id }}
                  badgeLabel={model.label}
                  copy={modelCardCopy}
                  language={language}
                  className="claude-code-model-card"
                  actions={
                    editingSlot === model.modelField ? undefined : (
                      <button type="button" disabled={busy} onClick={() => startSwitchModelSlot(model.modelField)}>
                        <Settings size={14} />
                        {copy.switchModel}
                      </button>
                    )
                  }
                >
                  {editingSlot === model.modelField ? (
                    <div className="claude-code-model-switch-panel">
                      <select
                        autoFocus
                        value={String(slotDrafts[model.modelField] ?? model.id)}
                        onChange={(event) => updateSlotDraft(model.modelField, event.target.value)}
                      >
                        {modelOptionsWithCurrent(activeProviderModelOptions, model.id).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <div className="model-card-actions claude-code-model-actions">
                        <button
                          type="button"
                          disabled={busy || !String(slotDrafts[model.modelField] ?? "").trim() || String(slotDrafts[model.modelField] ?? "").trim() === model.id}
                          onClick={() => switchModelSlot(model.modelField)}
                        >
                          <Save size={14} />
                          {copy.saveSwitch}
                        </button>
                        <button type="button" onClick={() => setEditingSlot(undefined)}>
                          <X size={14} />
                          {copy.cancel}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </ConfiguredModelCard>
              ))
            ) : (
              <div className="empty-state page-empty">{copy.empty}</div>
            )}
          </div>
        </div>

        <div className="content-card stack-card">
          <div className="card-toolbar">
            <div className="card-title-block">
              <h3>{copy.savedModels}</h3>
            </div>
          </div>
          <div className="model-card-grid claude-code-model-list">
            {visibleSavedProfiles.length ? (
              visibleSavedProfiles.map((profile) => {
                const applying = busyAction === `applyClaudeCodeModelProfile:${profile.id}`;
                const deleting = busyAction === `deleteClaudeCodeModelProfile:${profile.id}`;
                const active = isClaudeCodeSavedProfileActiveProvider(profile, config);
                return (
                  <ConfiguredModelCard
                    key={profile.id}
                    model={{
                      id: profile.fallbackModelId ?? profile.name,
                      provider: profile.providerPresetId ?? profile.providerPresetName ?? profile.baseUrl ?? profile.name,
                      label: profile.name
                    }}
                    badgeLabel={profile.providerPresetName}
                    copy={modelCardCopy}
                    language={language}
                    className={`claude-code-model-card${active ? " selected" : ""}`}
                    actions={
                      <>
                        <button type="button" disabled={Boolean(busyAction) || active} onClick={() => onApplyProfile(profile.id)}>
                          {applying ? <RefreshCw size={14} className="spin" /> : active ? <CheckCircle2 size={14} /> : <Settings size={14} />}
                          {applying ? copy.applyingProfile : active ? copy.activeProfile : copy.applyProfile}
                        </button>
                        <button type="button" disabled={Boolean(busyAction)} onClick={() => onDeleteProfile(profile.id)}>
                          {deleting ? <RefreshCw size={14} className="spin" /> : <Trash2 size={14} />}
                          {copy.deleteProfile}
                        </button>
                      </>
                    }
                  >
                    <div className="model-card-meta claude-code-profile-meta">
                      {profile.providerPresetName && <span>{`${copy.provider}: ${profile.providerPresetName}`}</span>}
                      {profile.fallbackModelId && <span>{`${copy.defaultModel}: ${profile.fallbackModelId}`}</span>}
                      {profile.haikuModelId && <span>{`${copy.lightModel}: ${profile.haikuModelId}`}</span>}
                      {profile.sonnetModelId && <span>{`${copy.primaryModel}: ${profile.sonnetModelId}`}</span>}
                      {profile.opusModelId && <span>{`${copy.advancedModel}: ${profile.opusModelId}`}</span>}
                    </div>
                  </ConfiguredModelCard>
                );
              })
            ) : (
              <div className="empty-state page-empty">{copy.noSavedProfiles}</div>
            )}
          </div>
        </div>

        <div>
          <ClaudeCodeModelConfigCard
            title={copy.configureModels}
            config={config}
            presets={presets}
            modelOptions={modelOptions}
            language={language}
            busy={busy}
            onUpdate={onUpdate}
          />
        </div>
      </section>
    </>
  );
}

function HermesModelsPage({
  title,
  description,
  status,
  language,
  busy,
  onRefresh
}: {
  title: string;
  description: string;
  status?: HarnessStatus;
  language: Language;
  busy: boolean;
  onRefresh: () => void;
}) {
  const copy = language === "zh-CN"
    ? { refresh: "\u91cd\u65b0\u68c0\u67e5", refreshing: "\u68c0\u67e5\u4e2d", empty: "\u5c1a\u672a\u89e3\u6790\u5230 Hermes \u6a21\u578b\u3002", usage: "\u7528\u91cf", calls: "\u8c03\u7528", tokens: "Token", cost: "\u8d39\u7528", recent7d: "\u6700\u8fd1 7 \u5929", defaultOption: "\u9ed8\u8ba4" }
    : { refresh: "Refresh", refreshing: "Checking", empty: "No Hermes models have been resolved.", usage: "Usage", calls: "Calls", tokens: "Tokens", cost: "Cost", recent7d: "Last 7 days", defaultOption: "Default" };
  const models = status?.models ?? [];
  return (
    <section className="page-grid">
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
          <button type="button" title={copy.refresh} disabled={busy} onClick={onRefresh}>
            <RefreshCw size={16} className={busy ? "spin" : undefined} />
            {busy ? copy.refreshing : copy.refresh}
          </button>
        </div>
        <div className="model-card-grid">
          {models.length ? models.map((model) => (
            <ConfiguredModelCard
              key={model.id}
              model={{ id: model.id, label: model.label, provider: model.provider ?? "hermes" }}
              badgeLabel={model.isDefault ? copy.defaultOption : model.provider}
              copy={copy}
              language={language}
            />
          )) : <div className="empty-state page-empty">{copy.empty}</div>}
        </div>
      </div>
    </section>
  );
}

function HermesAgentsPage({
  title,
  description,
  config,
  status,
  language,
  busy,
  refreshBusy,
  onRefresh,
  onAddProfile
}: {
  title: string;
  description: string;
  config?: HermesConfigResponse;
  status?: HarnessStatus;
  language: Language;
  busy: boolean;
  refreshBusy: boolean;
  onRefresh: () => void;
  onAddProfile: (input: CreateHermesProfileRequest) => void;
}) {
  const copy = language === "zh-CN"
    ? { configured: "已配置 Agent", add: "添加 Agent", adding: "添加中", refresh: "重新检查", refreshing: "检查中", name: "Profile ID", description: "描述", cloneFrom: "从 Profile 复制", noClone: "不复制", defaultBadge: "默认", defaultModel: "默认模型", provider: "提供方", alias: "Alias", path: "Agent 路径", workspace: "工作区", empty: "尚未解析到 Hermes Profile。", hint: "这里的每个 Agent 对应到 Hermes 里面的每个 Profile。" }
    : { configured: "Configured agents", add: "Add Agent", adding: "Adding", refresh: "Refresh", refreshing: "Checking", name: "Profile ID", description: "Description", cloneFrom: "Clone from profile", noClone: "Do not clone", defaultBadge: "Default", defaultModel: "Default model", provider: "Provider", alias: "Alias", path: "Agent path", workspace: "Workspace", empty: "No Hermes profiles have been resolved.", hint: "Each Agent here maps to one Hermes profile." };
  const profiles = config?.profiles ?? status?.profiles ?? [];
  const [name, setName] = useState("");
  const [profileDescription, setProfileDescription] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const submit = () => {
    const nextName = name.trim();
    if (!nextName || busy) return;
    onAddProfile({ name: nextName, description: profileDescription.trim() || undefined, cloneFrom: cloneFrom || undefined });
    setName("");
    setProfileDescription("");
  };
  return (
    <section className="page-grid">
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{copy.configured}</h3>
            <p>{copy.hint}</p>
          </div>
          <button type="button" title={copy.refresh} disabled={refreshBusy} onClick={onRefresh}>
            <RefreshCw size={16} className={refreshBusy ? "spin" : undefined} />
            {refreshBusy ? copy.refreshing : copy.refresh}
          </button>
        </div>
        <div className="model-card-grid">
          {profiles.length ? (
            profiles.map((profile) => (
              <article key={profile.id} className="model-card">
                <div className="model-card-head">
                  <IdentityTitle kind="agent" id={profile.id} label={profile.label} />
                  {profile.isDefault && <span className="status-pill status-default">{copy.defaultBadge}</span>}
                </div>
                <div className="model-card-main">
                  <code>{profile.path ?? profile.id}</code>
                </div>
                <div className="model-card-meta">
                  <span>{`${copy.defaultModel}: ${profile.modelId ?? "-"}`}</span>
                  <span>{`${copy.provider}: ${profile.provider ?? "-"}`}</span>
                  <span>{`${copy.workspace}: ${profile.workspace ?? "-"}`}</span>
                  <span>{`${copy.alias}: ${profile.alias ?? "-"}`}</span>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state page-empty">{copy.empty}</div>
          )}
        </div>
      </div>
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{copy.add}</h3>
            <p>{description}</p>
          </div>
        </div>
        <div className="form-grid">
          <label>
            <span>{copy.name}</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="researcher" />
          </label>
          <label>
            <span>{copy.cloneFrom}</span>
            <select value={cloneFrom} onChange={(event) => setCloneFrom(event.target.value)}>
              <option value="">{copy.noClone}</option>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
            </select>
          </label>
          <label className="field-span-full">
            <span>{copy.description}</span>
            <input value={profileDescription} onChange={(event) => setProfileDescription(event.target.value)} />
          </label>
        </div>
        <div className="card-actions">
          <button type="button" className="primary-action" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />}
            {busy ? copy.adding : copy.add}
          </button>
        </div>
      </div>
    </section>
  );
}

function HarnessSkillsPage({
  title,
  description,
  language,
  skillStatus,
  hermesSkills,
  busy,
  onInstallSkills
}: {
  title: string;
  description: string;
  language: Language;
  skillStatus?: HarnessSkillStatusResponse;
  hermesSkills?: HermesConfigResponse["skills"];
  busy: boolean;
  onInstallSkills: () => void;
}) {
  const copy = language === "zh-CN"
    ? { installed: "已安装 Hermes Skill", profile: "Profile", path: "路径", source: "数据源", count: (value: number) => `${value.toLocaleString(language)} Skills`, empty: "尚未扫描到 Hermes 已安装 Skill。" }
    : { installed: "Installed Hermes Skills", profile: "Profile", path: "Path", source: "Source", count: (value: number) => `${value.toLocaleString(language)} Skills`, empty: "No installed Hermes skills were scanned." };
  return (
    <section className="page-grid">
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
          <span className="status-pill status-running">{copy.count(hermesSkills?.length ?? 0)}</span>
        </div>
        <div className="model-card-grid">
          {hermesSkills?.length ? (
            hermesSkills.map((skill) => (
              <article key={`${skill.profileId ?? "default"}:${skill.id}:${skill.path}`} className="model-card">
                <div className="model-card-head">
                  <div className="model-card-main">
                    <strong>{skill.label}</strong>
                    <code>{skill.id}</code>
                  </div>
                  <span className="status-pill status-succeeded">{skill.profileId ?? "default"}</span>
                </div>
                <div className="model-card-main">
                  <code>{skill.path}</code>
                </div>
                <div className="model-card-meta">
                  <span>{`${copy.source}: Hermes`}</span>
                  <span>{`${copy.profile}: ${skill.profileId ?? "default"}`}</span>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state page-empty">{copy.empty}</div>
          )}
        </div>
      </div>
      <HarnessSkillsCard ui={openClawPanelSkillCopy(language)} skillStatus={skillStatus} language={language} busy={busy} onInstallSkills={onInstallSkills} />
    </section>
  );
}

function HermesChannelsPage({
  title,
  description,
  config,
  language,
  busy,
  refreshBusy,
  onRefresh,
  onAddChannel
}: {
  title: string;
  description: string;
  config?: HermesConfigResponse;
  language: Language;
  busy: boolean;
  refreshBusy: boolean;
  onRefresh: () => void;
  onAddChannel: (input: CreateHermesChannelRequest) => void;
}) {
  const copy = language === "zh-CN"
    ? { configured: "已配置频道", add: "添加频道配置", adding: "添加中", refresh: "重新检查", refreshing: "检查中", enabled: "已启用", platform: "平台", profile: "Profile", id: "频道 ID", name: "名称", type: "类型", threadId: "Thread ID", source: "目录", empty: "尚未解析到 Hermes 频道。" }
    : { configured: "Configured channels", add: "Add channel config", adding: "Adding", refresh: "Refresh", refreshing: "Checking", enabled: "Enabled", platform: "Platform", profile: "Profile", id: "Channel ID", name: "Name", type: "Type", threadId: "Thread ID", source: "Directory", empty: "No Hermes channels have been resolved." };
  const channels = config?.channels ?? [];
  const [draft, setDraft] = useState<CreateHermesChannelRequest>({ platform: "feishu", id: "", name: "", type: "group" });
  const updateDraft = (field: keyof CreateHermesChannelRequest, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const submit = () => {
    if (!draft.platform.trim() || !draft.id.trim() || busy) return;
    onAddChannel(draft);
    setDraft({ platform: draft.platform, id: "", name: "", type: draft.type });
  };
  return (
    <section className="page-grid">
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{copy.configured}</h3>
            <p>{description}</p>
          </div>
          <button type="button" title={copy.refresh} disabled={refreshBusy} onClick={onRefresh}>
            <RefreshCw size={16} className={refreshBusy ? "spin" : undefined} />
            {refreshBusy ? copy.refreshing : copy.refresh}
          </button>
        </div>
        <div className="model-card-grid">
          {channels.length ? channels.map((channel) => (
            <article key={`${channel.profileId ?? "default"}:${channel.platform}:${channel.id}:${channel.threadId ?? ""}`} className="model-card">
              <div className="model-card-head">
                <IdentityTitle kind="channel" id={channel.platform} label={channel.name} />
                <span className="status-pill status-succeeded">{copy.enabled}</span>
              </div>
              <div className="model-card-main">
                <code>{`${channel.platform}:${channel.id}`}</code>
              </div>
              <div className="model-card-meta">
                <span>{`${copy.profile}: ${channel.profileId ?? "default"}`}</span>
                <span>{`${copy.type}: ${channel.type ?? "-"}`}</span>
                <span>{`${copy.threadId}: ${channel.threadId ?? "-"}`}</span>
              </div>
            </article>
          )) : <div className="empty-state page-empty">{copy.empty}</div>}
        </div>
      </div>
      <div className="content-card stack-card">
        <div className="card-toolbar">
          <div className="card-title-block">
            <h3>{copy.add}</h3>
            <p>{config?.channelDirectoryPath ?? copy.source}</p>
          </div>
        </div>
        <div className="form-grid">
          <label><span>{copy.platform}</span><input value={draft.platform} onChange={(event) => updateDraft("platform", event.target.value)} /></label>
          <label><span>{copy.id}</span><input value={draft.id} onChange={(event) => updateDraft("id", event.target.value)} /></label>
          <label><span>{copy.name}</span><input value={draft.name ?? ""} onChange={(event) => updateDraft("name", event.target.value)} /></label>
          <label><span>{copy.type}</span><input value={draft.type ?? ""} onChange={(event) => updateDraft("type", event.target.value)} /></label>
          <label className="field-span-full"><span>{copy.threadId}</span><input value={draft.threadId ?? ""} onChange={(event) => updateDraft("threadId", event.target.value)} /></label>
        </div>
        <div className="card-actions">
          <button type="button" className="primary-action" disabled={busy || !draft.platform.trim() || !draft.id.trim()} onClick={submit}>
            {busy ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />}
            {busy ? copy.adding : copy.add}
          </button>
        </div>
      </div>
    </section>
  );
}

function ClaudeCodeModelConfigCard({
  title,
  config,
  presets,
  modelOptions,
  language,
  busy,
  onUpdate
}: {
  title?: string;
  config?: ClaudeCodeModelConfig;
  presets: ClaudeCodeModelPreset[];
  modelOptions: ClaudeCodeModelOptionEntry[];
  language: Language;
  busy: boolean;
  onUpdate: (input: UpdateClaudeCodeModelConfigRequest) => void;
}) {
  const copy =
    language === "zh-CN"
      ? {
          title: "Claude Code \u6a21\u578b",
          preset: "\u9884\u8bbe",
          authToken: "API Key / Token",
          authRequired: "\u8bf7\u8f93\u5165\u8be5\u5e73\u53f0\u7684 API Key / Token\u3002",
          authPlaceholder: "API Key / Token",
          slotRequired: "\u8bf7\u9009\u62e9\u9884\u8bbe\u6216\u9ed8\u8ba4\u6a21\u578b\u3002",
          selectModel: "\u9009\u62e9\u6a21\u578b",
          fallbackModel: "\u9ed8\u8ba4\u6a21\u578b",
          save: "\u5199\u5165 Claude Code",
          saving: "\u5199\u5165\u4e2d"
        }
      : {
          title: "Claude Code models",
          preset: "Preset",
          authToken: "API Key / Token",
          authRequired: "Enter this provider's API Key / Token.",
          authPlaceholder: "API Key / Token",
          slotRequired: "Choose a preset or default model.",
          selectModel: "Select model",
          fallbackModel: "Default model",
          save: "Write to Claude Code",
          saving: "Writing"
        };
  const [draft, setDraft] = useState<UpdateClaudeCodeModelConfigRequest>({});
  const [localError, setLocalError] = useState<string | undefined>();
  const applyPresetToDraft = useCallback((presetId: string) => {
    const preset = presets.find((item) => item.id === presetId);
    setLocalError(undefined);
    if (!preset) {
      setDraft((current) => ({ ...current, presetId, authValue: "" }));
      return;
    }
    setDraft((current) => ({
      ...current,
      presetId,
      baseUrl: preset.baseUrl ?? "",
      authEnvKey: preset.authEnvKey ?? "ANTHROPIC_AUTH_TOKEN",
      authValue: "",
      extraEnv: preset.extraEnv,
      fallbackModelId: preset.fallbackModelId ?? "",
      haikuModelId: undefined,
      haikuModelName: undefined,
      sonnetModelId: undefined,
      sonnetModelName: undefined,
      opusModelId: undefined,
      opusModelName: undefined
    }));
  }, [presets]);

  useEffect(() => {
    const preset = presets.find((item) => item.id === config?.providerPresetId);
    setDraft({
      presetId: config?.providerPresetId ?? "",
      baseUrl: preset?.baseUrl ?? config?.baseUrl ?? "",
      authEnvKey: preset?.authEnvKey ?? config?.authEnvKey ?? "ANTHROPIC_AUTH_TOKEN",
      authValue: "",
      extraEnv: preset?.extraEnv ?? config?.extraEnv,
      fallbackModelId: preset?.fallbackModelId ?? config?.fallbackModelId ?? "",
      haikuModelId: undefined,
      haikuModelName: undefined,
      sonnetModelId: undefined,
      sonnetModelName: undefined,
      opusModelId: undefined,
      opusModelName: undefined
    });
    setLocalError(undefined);
  }, [config, presets]);

  const updateField = (field: keyof UpdateClaudeCodeModelConfigRequest, value: string) => {
    setLocalError(undefined);
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const selectedPreset = presets.find((item) => item.id === draft.presetId);
  const scopedModelOptions = selectedPreset ? buildClaudeCodeModelOptions(undefined, presets, selectedPreset.id) : modelOptions;
  const visibleModelOptions = selectedPreset ? scopedModelOptions : modelOptionsWithCurrent(modelOptions, String(draft.fallbackModelId ?? ""));
  const requiresAuth = Boolean(draft.presetId || draft.baseUrl);
  const presetChanged = Boolean(draft.presetId && draft.presetId !== config?.providerPresetId);
  const baseUrlChanged = Boolean(draft.baseUrl && draft.baseUrl !== config?.baseUrl);
  const selectedAuthEnvKey = selectedPreset?.authEnvKey ?? draft.authEnvKey ?? "ANTHROPIC_AUTH_TOKEN";
  const authEnvChanged = Boolean(config?.authEnvKey && selectedAuthEnvKey !== config.authEnvKey);
  const canReuseAuth = Boolean(config?.authConfigured && !presetChanged && !baseUrlChanged && !authEnvChanged);
  const hasAuthInput = Boolean(String(draft.authValue ?? "").trim());
  const hasModelSlotInput = Boolean(String(draft.fallbackModelId ?? "").trim());
  const submitDraft = () => {
    if (requiresAuth && !canReuseAuth && !hasAuthInput) {
      setLocalError(copy.authRequired);
      return;
    }
    if (!selectedPreset && !hasModelSlotInput) {
      setLocalError(copy.slotRequired);
      return;
    }
    onUpdate({
      presetId: draft.presetId,
      baseUrl: draft.baseUrl,
      authValue: draft.authValue,
      extraEnv: draft.extraEnv,
      fallbackModelId: draft.fallbackModelId,
      authEnvKey: selectedAuthEnvKey
    });
  };

  return (
    <div className="content-card stack-card openclaw-control-section claude-code-config-card">
      <div className="card-toolbar">
        <div className="card-title-block">
          <h3>{title ?? copy.title}</h3>
        </div>
        <button type="button" disabled={busy} onClick={submitDraft}>
          {busy ? <RefreshCw size={14} className="spin" /> : <Save size={14} />}
          {busy ? copy.saving : copy.save}
        </button>
      </div>
      <div className="form-grid form-grid-wide wizard-field-grid claude-code-config-grid">
        <div className="wizard-field claude-code-provider-field">
          <label>
            <span>{copy.preset}</span>
            <select value={draft.presetId ?? ""} onChange={(event) => applyPresetToDraft(event.target.value)}>
              <option value="">-</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{copy.fallbackModel}</span>
            <select
              value={String(draft.fallbackModelId ?? "")}
              onChange={(event) => updateField("fallbackModelId", event.target.value)}
            >
              <option value="">{copy.selectModel}</option>
              {visibleModelOptions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{copy.authToken}</span>
            <input
              type="password"
              autoComplete="off"
              value={String(draft.authValue ?? "")}
              placeholder={copy.authPlaceholder}
              onChange={(event) => updateField("authValue", event.target.value)}
            />
          </label>
        </div>
        {localError && <div className="error-banner field-span-full">{localError}</div>}
      </div>
    </div>
  );
}

type ClaudeCodeModelOptionEntry = readonly [string, string];

function buildClaudeCodeModelOptions(status: HarnessStatus | undefined, presets: ClaudeCodeModelPreset[], presetId?: string): ClaudeCodeModelOptionEntry[] {
  const selectedPreset = presetId ? presets.find((preset) => preset.id === presetId) : undefined;
  if (presetId) return selectedPreset ? buildClaudeCodePresetModelOptions(selectedPreset) : [];

  return [
    ...new Map(
      [
        ...(status?.models ?? [])
          .filter((model) => model.id && model.id !== "inherit")
          .map((model) => [model.id, model.label === model.id ? model.id : `${model.label} (${model.id})`] as const),
        ...presets.flatMap((preset) =>
          [preset.fallbackModelId, preset.haikuModelId, preset.sonnetModelId, preset.opusModelId]
            .filter((modelId): modelId is string => Boolean(modelId))
            .map((modelId) => [modelId, `${preset.name} (${modelId})`] as const)
        )
      ]
    ).entries()
  ];
}

function buildClaudeCodePresetModelOptions(preset: ClaudeCodeModelPreset): ClaudeCodeModelOptionEntry[] {
  return [
    ...new Map(
      [preset.fallbackModelId, preset.haikuModelId, preset.sonnetModelId, preset.opusModelId]
        .filter((modelId): modelId is string => Boolean(modelId))
        .map((modelId) => [modelId, preset.name ? `${preset.name} (${modelId})` : modelId] as const)
    ).entries()
  ];
}

function modelOptionsWithCurrent(options: ClaudeCodeModelOptionEntry[], currentModelId: string | undefined): ClaudeCodeModelOptionEntry[] {
  const current = String(currentModelId ?? "").trim();
  if (!current || options.some(([id]) => id === current)) return options;
  return [[current, current], ...options];
}

function buildConfiguredClaudeCodeModels(config: ClaudeCodeModelConfig | undefined, presets: ClaudeCodeModelPreset[], language: Language): Array<{
  id: string;
  label: string;
  modelField: ClaudeCodeModelSlotField;
  providerId: string;
  providerName: string;
}> {
  const preset = presets.find((item) => item.id === config?.providerPresetId);
  const providerId = config?.providerPresetId ?? preset?.id ?? config?.providerPresetName ?? config?.baseUrl ?? config?.fallbackModelId ?? "anthropic";
  const providerName = config?.providerPresetName ?? preset?.name ?? "Claude Code";
  const labels =
    language === "zh-CN"
      ? {
          sonnet: "\u4e3b\u529b\u6a21\u578b",
          opus: "\u9ad8\u9636\u6a21\u578b",
          haiku: "\u8f7b\u91cf\u6a21\u578b",
          fallback: "\u9ed8\u8ba4\u6a21\u578b"
        }
      : {
          sonnet: "Primary model",
          opus: "Advanced model",
          haiku: "Light model",
          fallback: "Default model"
        };
  return [
    { id: config?.fallbackModelId, label: labels.fallback, modelField: "fallbackModelId", providerId, providerName },
    { id: config?.haikuModelId, label: labels.haiku, modelField: "haikuModelId", providerId, providerName },
    { id: config?.sonnetModelId, label: labels.sonnet, modelField: "sonnetModelId", providerId, providerName },
    { id: config?.opusModelId, label: labels.opus, modelField: "opusModelId", providerId, providerName }
  ].filter((model): model is { id: string; label: string; modelField: ClaudeCodeModelSlotField; providerId: string; providerName: string } => Boolean(model.id));
}

function countConfiguredClaudeCodeModels(config: ClaudeCodeModelConfig | undefined): number {
  return [
    config?.sonnetModelId,
    config?.opusModelId,
    config?.haikuModelId,
    config?.fallbackModelId
  ].filter(Boolean).length;
}

type HarnessSkillsCardCopy = Pick<
  OpenClawPanelCopy,
  "skills" | "skillsReady" | "skillsMissing" | "skillsUnsupported" | "installSkills" | "installingSkills" | "skillStatus"
>;

function HarnessSkillsCard({
  ui,
  skillStatus,
  language,
  busy,
  onInstallSkills
}: {
  ui: HarnessSkillsCardCopy;
  skillStatus?: HarnessSkillStatusResponse;
  language: Language;
  busy: boolean;
  onInstallSkills: () => void;
}) {
  const supported = Boolean(skillStatus?.supported);
  const skills = skillStatus?.skills ?? [];
  const installed = supported && skills.length > 0 && skills.every((skill) => skill.status === "installed");
  const description = !supported ? ui.skillsUnsupported : installed ? ui.skillsReady : ui.skillsMissing;
  return (
    <div className="content-card stack-card openclaw-control-section harness-skills-card">
      <div className="card-title-block harness-skills-card-head">
        <div>
          <h3>{ui.skills}</h3>
          <p>{description}</p>
        </div>
        <button type="button" onClick={onInstallSkills} disabled={busy || !supported} title={ui.installSkills}>
          <Puzzle size={14} className={busy ? "spin" : undefined} />
          {busy ? ui.installingSkills : ui.installSkills}
        </button>
      </div>

      {skills.length ? (
        skills.map((skill) => (
          <OpenClawPanelRow
            key={skill.id}
            label={skill.label}
            value={
              <span className="harness-check-value">
                <span className={`status-pill ${statusClassForHarnessSkill(skill.status)}`}>{ui.skillStatus[skill.status]}</span>
                <span>{skill.targetPath ?? skill.sourcePath}</span>
              </span>
            }
          />
        ))
      ) : (
        <div className="empty-state page-empty">{language === "zh-CN" ? "\u5c1a\u672a\u83b7\u53d6 skill \u72b6\u6001\u3002" : "Skill status has not been loaded."}</div>
      )}
    </div>
  );
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

interface HivewardHomeCopy {
  title: string;
  subtitle: string;
  github: string;
  updateTitle: string;
  updateAvailable: string;
  upToDate: string;
  updateUnknown: string;
  checkUpdate: string;
  checking: string;
  applyUpdate: string;
  updating: string;
  updateApplied: string;
  updateSkipped: string;
  cannotAutoApply: string;
  newBadge: string;
  current: string;
  latest: string;
  source: string;
  lastChecked: string;
  none: string;
  communityTitle: string;
  communityPlaceholder: string;
  permissionNotice: {
    eyebrow: (versionLabel: string) => string;
    title: string;
    body: string;
    risk: string;
  };
  readmeSections: Array<{
    title: string;
    paragraphs: string[];
    items?: string[];
  }>;
}

function hivewardHomeCopy(language: Language): HivewardHomeCopy {
  if (language === "zh-CN") {
    return {
      title: "HiveWard",
      subtitle: "开源 Agent Company 工作区，把模型、Agent、蓝图、审批、运行和历史组织成一个可管理的操作系统。",
      github: "GitHub 仓库",
      updateTitle: "版本更新",
      updateAvailable: "发现更新",
      upToDate: "已是最新",
      updateUnknown: "状态未知",
      checkUpdate: "检查更新",
      checking: "检查中",
      applyUpdate: "自动更新",
      updating: "更新中",
      updateApplied: "更新已执行，重启 HiveWard 后生效。",
      updateSkipped: "未执行更新。",
      cannotAutoApply: "当前 checkout 无法自动更新；通常需要在 main 分支且工作区干净。",
      newBadge: "更新",
      current: "当前",
      latest: "远端",
      source: "来源",
      lastChecked: "最后检查",
      none: "-",
      communityTitle: "交流群",
      communityPlaceholder: "扫码加入 HiveWard 交流群，获取更新、反馈问题和交流蓝图玩法。",
      permissionNotice: {
        eyebrow: (versionLabel) => `${versionLabel} 本地运行公告`,
        title: "完全访问权限需要手动开启",
        body: "CLI 聊天 Harness 默认使用安全模式。你可以在各自配置页里手动开启完整本地权限。",
        risk: "全权限会允许模型读写工作区文件、执行命令、访问网络和使用实时网页搜索；请只在信任的本地仓库中开启。"
      },
      readmeSections: [
        {
          title: "什么是 HiveWard？",
          paragraphs: [
            "HiveWard 是面向 Agent Company 的开源工作区。它不试图成为另一个模型，也不把所有工作藏进聊天框，而是给 Agent 团队一个可见、可治理、可审查的运行结构。",
            "可以把它理解成下一代 AI 组织的运营台：公司是边界，蓝图是组织图，模型是资源池，收件箱是治理层，历史记录是执行账本。"
          ]
        },
        {
          title: "什么是蓝图？",
          paragraphs: [
            "蓝图不是静态图，而是一份可运行的 Agent 工作定义，描述谁做什么、按什么顺序做、何时汇总或审批，以及如何交付结果。"
          ],
          items: [
            "节点：Agent、Manager、并行 Slot、汇总、审批和交付步骤。",
            "连线：成功路径、失败路径、执行顺序和回滚路线。",
            "运行记录：每个执行步骤的状态、输入、输出、OpenClaw 引用、成本和时间证据。"
          ]
        },
        {
          title: "为什么选择 HiveWard？",
          paragraphs: [
            "现代 Agent 工具已经能写代码、研究和执行任务，但复杂工作一多，聊天窗口加重复复制提示词的体验很快会到达上限。",
            "HiveWard 从另一个假设出发：Agent 不应该只是更聪明的聊天伙伴，而应该成为被组织、被管理、可审计的工作单元。"
          ]
        },
        {
          title: "它如何工作？",
          paragraphs: [
            "选择公司，设计蓝图，配置模型，启动运行，然后在收件箱里审批和复盘。HiveWard 负责产品层的组织、监控和治理，OpenClaw 等运行时负责真实执行。"
          ]
        },
        {
          title: "核心能力",
          paragraphs: [],
          items: [
            "公司上下文：按公司组织目标、蓝图、运行和审批。",
            "蓝图编排：用可视化节点描述 Agent 团队结构。",
            "Manager 调度：让 Manager 节点选择 Slot、分派 Agent、要求返工或结束流程。",
            "人类治理：把需要判断的步骤集中到收件箱。",
            "运行账本：让每次执行都能被审查和复盘。"
          ]
        },
        {
          title: "当前状态",
          paragraphs: ["当前版本面向本地演示和早期使用。核心产品界面已经可用，API 和交互细节仍会继续演进。"]
        }
      ]
    };
  }

  return {
    title: "HiveWard",
    subtitle: "An open-source Agent Company workspace that organizes models, agents, blueprints, approvals, runs, and history into one managed operating system.",
    github: "GitHub repo",
    updateTitle: "Version updates",
    updateAvailable: "Update available",
    upToDate: "Up to date",
    updateUnknown: "Unknown",
    checkUpdate: "Check updates",
    checking: "Checking",
    applyUpdate: "Auto update",
    updating: "Updating",
    updateApplied: "Update applied. Restart HiveWard to use the new version.",
    updateSkipped: "Update was not applied.",
    cannotAutoApply: "Automatic update needs a clean checkout on the main branch.",
    newBadge: "New",
    current: "Current",
    latest: "Remote",
    source: "Source",
    lastChecked: "Last checked",
    none: "-",
    communityTitle: "Community",
    communityPlaceholder: "Scan to join the HiveWard community group for updates, feedback, and blueprint workflow discussion.",
    permissionNotice: {
      eyebrow: (versionLabel) => `${versionLabel} local runtime notice`,
      title: "Full access is opt-in",
      body: "CLI chat harnesses use safe mode by default. You can enable full local access from each harness configuration page.",
      risk: "Full access allows workspace writes, command execution, network access, and live web search. Enable it only in local repositories you trust."
    },
    readmeSections: [
      {
        title: "What is HiveWard?",
        paragraphs: [
          "HiveWard is an open-source workspace for Agent Companies. It gives agent teams a visible, governable, reviewable operating structure instead of hiding all work inside a chat box.",
          "Think of it as an operations desk for the next generation of AI organizations: company as scope, blueprint as organization chart, models as resource pool, inbox as governance layer, and history as execution ledger."
        ]
      },
      {
        title: "What is a blueprint?",
        paragraphs: [
          "A blueprint is a runnable agent work definition that describes who does what, in which order, when work must be summarized or approved, and how results are delivered."
        ],
        items: [
          "Nodes: agents, managers, parallel lanes, summaries, approvals, and delivery steps.",
          "Edges: success paths, failure paths, sequencing, and rollback routes.",
          "Run records: node status, inputs, outputs, OpenClaw references, cost, and timing evidence."
        ]
      },
      {
        title: "Why HiveWard?",
        paragraphs: [
          "Modern agent tools can write code, research, and execute tasks, but complex work quickly outgrows a chat window and repeated prompt copying.",
          "HiveWard starts from a different assumption: agents should become organized, managed, and auditable work units."
        ]
      },
      {
        title: "How it works",
        paragraphs: [
          "Choose a company, design a blueprint, configure models, start a run, then approve and review through the inbox. HiveWard owns the product layer while OpenClaw and other runtimes own real execution."
        ]
      },
      {
        title: "Core capabilities",
        paragraphs: [],
        items: [
          "Company context for goals, blueprints, runs, and approvals.",
          "Blueprint orchestration with visual nodes.",
          "Manager dispatch across Slots and agents.",
          "Human governance through the inbox.",
          "Run history that turns execution into reviewable evidence."
        ]
      },
      {
        title: "Current status",
        paragraphs: [
          "The current version is ready for local demos and early use. Core product surfaces are in place while APIs and interaction details continue to evolve."
        ]
      }
    ]
  };
}

function openClawPanelSkillCopy(language: Language): HarnessSkillsCardCopy {
  return language === "zh-CN"
    ? {
        skills: "HiveWard Skill",
        skillsReady: "CEO / Leader \u6267\u884c\u624b\u518c\u5df2\u5b89\u88c5\uff0c\u804a\u5929\u65f6\u53ea\u9700\u77ed\u8eab\u4efd\u63d0\u793a\u5e76\u8c03\u7528 Harness \u539f\u751f skill\u3002",
        skillsMissing: "\u9700\u8981\u5b89\u88c5 HiveWard CEO / Leader skill\uff0c\u624d\u80fd\u8ba9 Harness \u539f\u751f\u8bfb\u53d6\u5e73\u53f0\u6267\u884c\u624b\u518c\u3002",
        skillsUnsupported: "\u8be5 Harness \u6682\u672a\u63a5\u5165\u539f\u751f skill \u5b89\u88c5\u3002",
        installSkills: "\u4e00\u952e\u5b89\u88c5",
        installingSkills: "\u5b89\u88c5\u4e2d",
        skillStatus: {
          installed: "\u5df2\u5b89\u88c5",
          missing: "\u672a\u5b89\u88c5",
          stale: "\u9700\u66f4\u65b0",
          unsupported: "\u672a\u652f\u6301",
          error: "\u5f02\u5e38"
        }
      }
    : {
        skills: "HiveWard Skills",
        skillsReady: "CEO / Leader operating skills are installed, so chat can send a short role prompt and let the harness load native skills.",
        skillsMissing: "Install HiveWard CEO / Leader skills so the harness can natively read the platform operating manual.",
        skillsUnsupported: "This harness does not have native skill installation wired yet.",
        installSkills: "Install skills",
        installingSkills: "Installing",
        skillStatus: {
          installed: "Installed",
          missing: "Missing",
          stale: "Update needed",
          unsupported: "Unsupported",
          error: "Error"
        }
      };
}

function harnessPermissionCopy(language: Language) {
  return language === "zh-CN"
    ? {
        title: "全部权限",
        helpAria: "查看全部权限说明",
        safeLabel: "安全模式",
        safeBody: "当前 Harness 的聊天会话和蓝图 Agent / Manager 节点会使用只读或受限权限。",
        safeWarning: "不会默认授予文件写入、命令执行、联网或实时网页搜索等完整本地能力。",
        fullLabel: "完全访问模式",
        fullBody: "聊天会话会开启完整本地权限；蓝图中引用该 Harness 的 Agent / Manager 节点会使用工作区写权限。",
        fullWarning: "只在你信任的本地仓库里开启。模型可能修改文件、运行脚本或访问网络。"
      }
    : {
        title: "All permissions",
        helpAria: "View all-permissions details",
        safeLabel: "Safe mode",
        safeBody: "Chat sessions and blueprint Agent / Manager nodes for this harness use read-only or limited permissions.",
        safeWarning: "File writes, command execution, network access, and live web search are not granted by default.",
        fullLabel: "Full access mode",
        fullBody: "Chat sessions get full local access. Blueprint Agent / Manager nodes that reference this harness use workspace-write permissions.",
        fullWarning: "Enable only in local repositories you trust. The model may modify files, run scripts, or access the network."
      };
}

function statusClassForHarnessSkill(status: HarnessSkillInstallStatus): string {
  if (status === "installed") return "status-succeeded";
  if (status === "stale" || status === "missing") return "status-running";
  return "status-failed";
}

function HarnessStatusBlock({
  status,
  language,
  fallbackLabel,
  fallbackHarnessId
}: {
  status?: HarnessStatus;
  language: Language;
  fallbackLabel: string;
  fallbackHarnessId?: HarnessId;
}) {
  const copy = harnessStatusCopy(language);
  const labelParts = status ? harnessDisplayParts(status.id) : fallbackHarnessId ? harnessDisplayParts(fallbackHarnessId) : { label: fallbackLabel };
  const connectionState = status?.connectionState ?? "unavailable";
  return (
    <div className="harness-status-block">
      <div className="openclaw-panel-metrics">
        <OpenClawPanelMetric label={copy.harness} value={<HarnessLabel {...labelParts} />} />
        <OpenClawPanelMetric label={copy.defaultModel} value={status?.defaultModelId ?? copy.none} />
        <OpenClawPanelMetric label={copy.installed} value={status?.installed ? copy.yes : copy.no} tone={status?.installed ? "online" : "offline"} />
        <OpenClawPanelMetric
          label={copy.environment}
          value={status?.environmentOk ? copy.matched : copy.needsAttention}
          tone={status?.environmentOk ? "online" : "offline"}
        />
        <OpenClawPanelMetric label={copy.connection} value={copy.states[connectionState]} />
      </div>

      <div className="openclaw-control-grid">
        <div className="content-card stack-card openclaw-control-section">
          <div className="card-title-block">
            <h3>{copy.summary}</h3>
            <p>{status?.summary ?? copy.notChecked}</p>
          </div>
          <OpenClawPanelRow label={copy.checkedAt} value={formatDateTimeLabel(status?.checkedAt, language, "-")} />
        </div>

        <div className="content-card stack-card openclaw-control-section">
          <div className="card-title-block">
            <h3>{copy.checks}</h3>
          </div>
          {status?.checks.length ? (
            status.checks.map((check) => (
              <OpenClawPanelRow
                key={check.id}
                label={check.label}
                value={
                  <span className="harness-check-value">
                    <span className={`status-pill ${statusClassForHarnessCheck(check.status)}`}>{copy.checkStatus[check.status]}</span>
                    <span>{check.detail}</span>
                  </span>
                }
              />
            ))
          ) : (
            <div className="empty-state page-empty">{copy.notChecked}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function statusClassForHarnessCheck(status: HarnessStatus["checks"][number]["status"]): string {
  if (status === "pass") return "status-succeeded";
  if (status === "warning") return "status-running";
  return "status-failed";
}

function harnessStatusCopy(language: Language) {
  return language === "zh-CN"
    ? {
        harness: "Harness",
        defaultModel: "\u9ed8\u8ba4\u6a21\u578b",
        installed: "\u5b89\u88c5",
        environment: "\u73af\u5883",
        connection: "\u8fde\u63a5\u72b6\u6001",
        matched: "\u5339\u914d",
        needsAttention: "\u9700\u5904\u7406",
        yes: "\u5df2\u5b89\u88c5",
        no: "\u672a\u5b89\u88c5",
        none: "-",
        summary: "\u72b6\u6001\u6458\u8981",
        checks: "\u68c0\u67e5\u9879",
        checkedAt: "\u68c0\u67e5\u65f6\u95f4",
        notChecked: "\u5c1a\u672a\u83b7\u53d6\u72b6\u6001\u3002",
        check: "\u91cd\u65b0\u68c0\u67e5",
        checking: "\u68c0\u67e5\u4e2d",
        states: {
          connected: "\u5df2\u8fde\u63a5",
          available: "\u53ef\u7528",
          needs_config: "\u9700\u8981\u914d\u7f6e",
          unavailable: "\u4e0d\u53ef\u7528"
        },
        checkStatus: {
          pass: "\u901a\u8fc7",
          warning: "\u6ce8\u610f",
          fail: "\u5931\u8d25"
        }
      }
    : {
        harness: "Harness",
        defaultModel: "Default model",
        installed: "Installed",
        environment: "Environment",
        connection: "Connection",
        matched: "Matched",
        needsAttention: "Needs attention",
        yes: "Installed",
        no: "Not installed",
        none: "-",
        summary: "Status summary",
        checks: "Checks",
        checkedAt: "Checked at",
        notChecked: "Status has not been loaded.",
        check: "Check again",
        checking: "Checking",
        states: {
          connected: "Connected",
          available: "Available",
          needs_config: "Needs config",
          unavailable: "Unavailable"
        },
        checkStatus: {
          pass: "Pass",
          warning: "Warning",
          fail: "Fail"
        }
      };
}

function OpenClawPanelMetric({
  label,
  value,
  tone
}: {
  label: string;
  value: ReactNode;
  tone?: "online" | "offline";
}) {
  return (
    <div className={`openclaw-panel-metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OpenClawPanelRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="openclaw-panel-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function companyMonogram(company?: Pick<CompanyOverview, "logoLabel" | "name">): string {
  if (company?.logoLabel?.trim()) return company.logoLabel.trim().slice(0, 2).toUpperCase();
  if (company?.name?.trim()) {
    const parts = company.name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return parts
      .slice(0, 2)
      .map((part) => part[0] ?? "")
      .join("")
      .toUpperCase();
  }
  return "CO";
}

function getInitialTheme(): AppTheme {
  const stored = localStorage.getItem("hiveward-theme");
  if (stored === "light" || stored === "dark") return stored;
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}

function getInitialChatPermissionModes(): Record<SdkChatHarnessId, ChatPermissionMode> {
  const fallback: Record<SdkChatHarnessId, ChatPermissionMode> = {
    claudeCode: "safe",
    codex: "safe",
    google: "safe",
    cursor: "safe",
    opencode: "safe",
    hermes: "safe"
  };
  const stored = localStorage.getItem("hiveward-chat-permission-modes");
  if (!stored) return fallback;
  try {
    const parsed = JSON.parse(stored) as Partial<Record<SdkChatHarnessId, ChatPermissionMode>>;
    return {
      claudeCode: parsed.claudeCode === "full_access" ? "full_access" : "safe",
      codex: parsed.codex === "full_access" ? "full_access" : "safe",
      google: parsed.google === "full_access" ? "full_access" : "safe",
      cursor: parsed.cursor === "full_access" ? "full_access" : "safe",
      opencode: parsed.opencode === "full_access" ? "full_access" : "safe",
      hermes: parsed.hermes === "full_access" ? "full_access" : "safe"
    };
  } catch {
    return fallback;
  }
}

function formatDurationMs(value: number | undefined, fallback: string): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toLocaleString()} ms` : fallback;
}

function formatDateTimeLabel(value: string | undefined, language: Language, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

async function loadHarnessSkillStatuses(): Promise<Partial<Record<HarnessId, HarnessSkillStatusResponse>>> {
  const entries = await Promise.all(
    harnessSkillHarnessIds.map(async (harnessId) => {
      try {
        return [harnessId, await api.getHarnessSkillStatus(harnessId)] as const;
      } catch {
        return [harnessId, undefined] as const;
      }
    })
  );
  const statuses: Partial<Record<HarnessId, HarnessSkillStatusResponse>> = {};
  for (const [harnessId, status] of entries) {
    if (status) statuses[harnessId] = status;
  }
  return statuses;
}

function emptyRuntimeOverview(): RuntimeOverview {
  return {
    sessions: [],
    tasks: []
  };
}

function isActionableApproval(approval: PendingApprovalItem): boolean {
  return approval.status !== "approved" && approval.status !== "rejected" && approval.status !== "replying";
}

function defaultWidgetTitle(type: DashboardWidgetType, t: Messages): string {
  if (type === "recent_runs") return t.widgetTypes.runs;
  if (type === "pending_approvals") return t.widgetTypes.approvals;
  if (type === "runtime_overview") return t.common.realTime;
  if (type === "catalog_status") return t.widgetTypes.catalog;
  return t.widgetTypes.notes;
}

function defaultWidgetLayout(index: number) {
  return {
    x: index % 2 === 0 ? 0 : 6,
    y: Math.floor(index / 2) * 4,
    w: 6,
    h: 4
  };
}

function defaultNewBlueprintName(index: number, language: Language): string {
  return language === "zh-CN" ? `\u65b0\u5efa\u84dd\u56fe ${index}` : `New blueprint ${index}`;
}

function downloadBlueprintPackage(blueprintPackage: PortableBlueprintPackage, blueprintName: string): void {
  const blob = new Blob([`${JSON.stringify(blueprintPackage, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeBlueprintFileName(blueprintName)}.blueprint.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function safeBlueprintFileName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "blueprint";
}

function fallbackNavigationLabel(sectionId: AppNavSectionId, language: Language): string {
  if (language === "zh-CN" && sectionId === "chat") return "\u804a\u5929";
  return messages.en.navigation[sectionId] ?? sectionId;
}

function makeClientId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function errorMessageForAction(action: string, t: Messages): string {
  if (action === "createBlueprint") return t.errors.save;
  if (action === "saveBlueprint") return t.errors.save;
  if (action === "exportBlueprint") return t.errors.save;
  if (action === "importBlueprint") return t.errors.save;
  if (action === "runBlueprint") return t.errors.run;
  if (action === "cancelBlueprintRun") return t.errors.run;
  if (action === "approveRun") return t.errors.approve;
  if (action === "completeRunApproval") return t.errors.approve;
  if (action === "selectRunApprovalReply") return t.errors.approve;
  if (action === "configureOpenClawModelAuth") return t.errors.catalog;
  if (action.startsWith("setOpenClawDefaultModel:")) return t.errors.catalog;
  if (action === "addOpenClawAgent") return t.errors.catalog;
  if (action === "configureOpenClawChannel") return t.errors.catalog;
  if (action === "refreshCatalog") return t.errors.catalog;
  return t.errors.load;
}

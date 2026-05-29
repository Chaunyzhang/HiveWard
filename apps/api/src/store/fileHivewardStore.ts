import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type {
  AgentRuntimeId,
  CatalogSnapshot,
  CompanyOverview,
  CompanyProfile,
  ArchitectureBlueprintView,
  CompanyRoleDirectory,
  CompanyRoleProfile,
  InboxItem,
  InboxItemType,
  PendingApprovalItem,
  PortableBlueprintPackage,
  WorkspaceDashboard,
  BlueprintDefinition,
  BlueprintImportDefaults,
  BlueprintNodeEvent,
  BlueprintNodeRun,
  BlueprintRun,
  BlueprintRunArchive,
  BlueprintRunSummary,
  BlueprintRunView,
  ChatRoleScope,
  CreateHivewardChatSessionRequest,
  HarnessId,
  HivewardChatMessage,
  HivewardChatSession,
  AgentHandoff,
  AgentHumanReport,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  IterationRound,
  IterationSession,
  ManagerContextSnapshot,
  ManagerMail,
  ReleaseReport,
  RunTimelineItem,
  UpdateHivewardChatSessionRequest,
  RoleDriverBinding,
  RuntimeObjectRef
} from "@hiveward/shared";
import {
  blueprintRunArchiveSchema,
  createBlankBlueprint,
  createDefaultCompanies,
  createDefaultBlueprints,
  createDefaultWorkspaceDashboard,
  defaultCompanyId,
  hydrateImportedBlueprint,
  normalizeWorkspaceDashboard,
  readBlueprintNodeEventRuntimeRef,
  readBlueprintNodeRunRuntimeRef,
  readBlueprintRunRuntimeRefs,
  readPortableBlueprintPackage,
  resolveApprovalCapabilities,
  resolveFinalRunResult
} from "@hiveward/shared";
import { FileHivewardChatStore, type LegacyHivewardChatState } from "./fileHivewardChatStore";
import type {
  ApplyApprovalDecisionInput,
  ApplyApprovalDecisionResult,
  ApplyInboxDecisionInput,
  ApplyInboxDecisionResult,
  CancelNodeRunInput,
  ClaimNodeRunResult,
  CompleteNodeRunInput,
  FailNodeRunInput,
  HivewardStore,
  PublishAgentOutputInput,
  PublishAgentOutputResult
} from "./hivewardStore";
import { isFileNotFoundError, safeWriteJson } from "./jsonFile";

const storeIndexSchema = "hiveward.store-index/v1";

type LegacyRuntimeRefFields = {
  openclawRef?: RuntimeObjectRef;
};

type LegacyRuntimeRefsField = {
  openclawRefs?: RuntimeObjectRef[];
};

type RunArchiveWithLegacyRuntimeRefs = Omit<BlueprintRunArchive, "run" | "nodeRuns" | "events"> & {
  run: BlueprintRunSummary & LegacyRuntimeRefsField;
  nodeRuns: Array<BlueprintNodeRun & LegacyRuntimeRefFields>;
  events: Array<BlueprintNodeEvent & LegacyRuntimeRefFields>;
};

export interface BlueprintIndexEntry {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface HivewardStoreIndex {
  schema: typeof storeIndexSchema;
  companies: CompanyProfile[];
  selectedCompanyId: string | null;
  blueprintIndex: BlueprintIndexEntry[];
  runIndex: BlueprintRunSummary[];
  catalogSnapshot?: CatalogSnapshot;
  companyDashboards: Record<string, WorkspaceDashboard>;
  roleDirectories: Record<string, CompanyRoleDirectory>;
  inboxItems: Record<string, InboxItem[]>;
  iterationSessions: IterationSession[];
  iterationRounds: IterationRound[];
  approvalRequests: ApprovalRequest[];
  approvalDecisions: ApprovalDecision[];
  artifacts: Artifact[];
  releaseReports: ReleaseReport[];
  agentHumanReports: AgentHumanReport[];
  agentHandoffs: AgentHandoff[];
  managerContextSnapshots: ManagerContextSnapshot[];
  runTimeline: RunTimelineItem[];
  managerMail: ManagerMail[];
}

type RawHivewardStoreIndex = Partial<HivewardStoreIndex> & {
  companyDashboards?: Record<string, Partial<WorkspaceDashboard>>;
  roleDirectories?: Record<string, Partial<CompanyRoleDirectory>>;
  inboxItems?: Record<string, InboxItem[]>;
  chatSessions?: unknown;
  chatMessages?: unknown;
};

type LegacyHivewardStoreState = Partial<RawHivewardStoreIndex> & {
  blueprints?: BlueprintDefinition[];
  blueprintRuns?: BlueprintRun[];
  nodeRuns?: BlueprintNodeRun[];
  events?: BlueprintNodeEvent[];
};

type ArchitectureNodePosition = ArchitectureBlueprintView["nodes"][number]["position"];

type SkillSourceCompleteness = "full_package" | "markdown_only" | "partial_package" | "unknown";

interface BlueprintSkillSourceSnapshot {
  skillSourceId: string;
  blueprintId: string;
  workingDirectory: string;
  sourceCompleteness: SkillSourceCompleteness;
  capturedFiles: string[];
  fileHashes: Record<string, string>;
  scriptInventory: Array<{
    path: string;
    runtime: "node" | "python" | "bash" | "unknown";
    sizeBytes: number;
    sha256: string;
    shouldExecuteByDefault: false;
  }>;
}

export class FileHivewardStore implements HivewardStore {
  private readonly filePath: string;
  private readonly dataDir: string;
  private readonly blueprintsDir: string;
  private readonly blueprintWorkspacesDir: string;
  private readonly runsDir: string;
  private readonly chatStore: FileHivewardChatStore;
  private readonly seedDefaultsOnInit: boolean;
  private readonly nodeRunLeases = new Map<string, { owner: string; workerEpoch: number; leaseExpiresAt: string }>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    filePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../data/hiveward-store.json"),
    options: { seedDefaults?: boolean } = {}
  ) {
    this.filePath = filePath;
    this.dataDir = dirname(filePath);
    this.blueprintsDir = join(this.dataDir, "blueprints");
    this.blueprintWorkspacesDir = join(this.dataDir, "blueprint-workspaces");
    this.runsDir = join(this.dataDir, "runs");
    this.chatStore = new FileHivewardChatStore(join(this.dataDir, "hiveward-chat-store.json"));
    this.seedDefaultsOnInit = options.seedDefaults ?? true;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  async init(): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(this.dataDir, { recursive: true });
      await mkdir(this.blueprintsDir, { recursive: true });
      await mkdir(this.blueprintWorkspacesDir, { recursive: true });
      await mkdir(this.runsDir, { recursive: true });
      if (!this.seedDefaultsOnInit && !await isReadableFile(this.filePath)) {
        return;
      }
      try {
        const { index, legacyChat } = await this.readIndexWithLegacyChatUnlocked();
        await this.chatStore.init(index.companies, legacyChat);
        await this.ensureBlueprintWorkspacesUnlocked(index);
        await this.writeIndexUnlocked(index);
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw error;
        }
        if (!this.seedDefaultsOnInit) {
          return;
        }
        const now = new Date().toISOString();
        const companies = createDefaultCompanies(now);
        const seededCompanyId = companies[0]?.id ?? defaultCompanyId;
        const blueprints = createDefaultBlueprints(now, seededCompanyId);
        const index: HivewardStoreIndex = {
          schema: storeIndexSchema,
          companies,
          selectedCompanyId: seededCompanyId,
          blueprintIndex: blueprints.map(toBlueprintIndexEntry),
          runIndex: [],
          companyDashboards: {
            [seededCompanyId]: createDefaultWorkspaceDashboard(now)
          },
          roleDirectories: {},
          inboxItems: {
            [seededCompanyId]: []
          },
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
        index.roleDirectories[seededCompanyId] = buildRoleDirectory(index, seededCompanyId, now);
        await Promise.all(blueprints.map((blueprint) => this.writeBlueprintUnlocked(blueprint)));
        await this.chatStore.init(index.companies);
        await this.writeIndexUnlocked(index);
      }
    });
  }

  async listCompanies(): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string }> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return {
        companies: this.buildCompanyOverviews(index),
        selectedCompanyId: index.selectedCompanyId ?? undefined
      };
    });
  }

  async createCompany(input: { name?: string; businessGoal?: string; logoLabel?: string; logoUrl?: string }): Promise<{
    companies: CompanyOverview[];
    selectedCompanyId?: string;
  }> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const now = new Date().toISOString();
      const name = readOptionalString(input.name) ?? nextCompanyName(index.companies);
      const company: CompanyProfile = {
        id: nextCompanyId(index.companies),
        name,
        logoLabel: readOptionalString(input.logoLabel) ?? companyInitials(name),
        logoUrl: readOptionalString(input.logoUrl),
        businessGoal: readOptionalString(input.businessGoal) ?? "Coordinate blueprints, governed agent runs, and review gates.",
        createdAt: now,
        updatedAt: now
      };

      index.companies.push(company);
      index.selectedCompanyId = company.id;
      index.companyDashboards[company.id] = createDefaultWorkspaceDashboard(now);
      index.roleDirectories[company.id] = buildRoleDirectory(index, company.id, now);
      index.inboxItems[company.id] = [];
      await this.writeIndexUnlocked(index);

      return {
        companies: this.buildCompanyOverviews(index),
        selectedCompanyId: index.selectedCompanyId ?? undefined
      };
    });
  }

  async updateCompany(
    companyId: string,
    input: { name?: string; businessGoal?: string; logoLabel?: string; logoUrl?: string }
  ): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string }> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const existingIndex = index.companies.findIndex((company) => company.id === companyId);
      if (existingIndex < 0) {
        throw new Error(`Company not found: ${companyId}`);
      }

      const current = index.companies[existingIndex]!;
      const nextName = input.name === undefined ? current.name : readRequiredCompanyName(input.name);
      const renamed = nextName !== current.name;
      const nextLogoLabel =
        input.logoLabel === undefined
          ? renamed && (!current.logoLabel || current.logoLabel === companyInitials(current.name))
            ? companyInitials(nextName)
            : current.logoLabel
          : readOptionalString(input.logoLabel);
      const nextCompany: CompanyProfile = {
        ...current,
        name: nextName,
        businessGoal: input.businessGoal === undefined ? current.businessGoal : readOptionalString(input.businessGoal) ?? current.businessGoal,
        logoLabel: nextLogoLabel,
        logoUrl: input.logoUrl === undefined ? current.logoUrl : readOptionalString(input.logoUrl),
        updatedAt: new Date().toISOString()
      };

      index.companies[existingIndex] = nextCompany;
      index.companyDashboards[companyId] ??= createDefaultWorkspaceDashboard(nextCompany.updatedAt);
      index.roleDirectories[companyId] = buildRoleDirectory(index, companyId, nextCompany.updatedAt, index.roleDirectories[companyId]);
      index.inboxItems[companyId] ??= [];
      await this.writeIndexUnlocked(index);

      return {
        companies: this.buildCompanyOverviews(index),
        selectedCompanyId: index.selectedCompanyId ?? undefined
      };
    });
  }

  async selectCompany(companyId?: string): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string }> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      if (!companyId) {
        index.selectedCompanyId = null;
      } else if (index.companies.some((company) => company.id === companyId)) {
        index.selectedCompanyId = companyId;
      } else {
        throw new Error(`Company not found: ${companyId}`);
      }

      await this.writeIndexUnlocked(index);
      return {
        companies: this.buildCompanyOverviews(index),
        selectedCompanyId: index.selectedCompanyId ?? undefined
      };
    });
  }

  async deleteCompany(companyId: string): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string; deleted: boolean }> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const existingIndex = index.companies.findIndex((company) => company.id === companyId);
      if (existingIndex < 0) {
        return {
          companies: this.buildCompanyOverviews(index),
          selectedCompanyId: index.selectedCompanyId ?? undefined,
          deleted: false
        };
      }

      const blueprintIds = index.blueprintIndex.filter((blueprint) => blueprint.companyId === companyId).map((blueprint) => blueprint.id);
      const runIds = index.runIndex.filter((run) => run.companyId === companyId).map((run) => run.id);

      index.companies.splice(existingIndex, 1);
      index.blueprintIndex = index.blueprintIndex.filter((blueprint) => blueprint.companyId !== companyId);
      index.runIndex = index.runIndex.filter((run) => run.companyId !== companyId);
      delete index.companyDashboards[companyId];
      delete index.roleDirectories[companyId];
      delete index.inboxItems[companyId];

      if (index.selectedCompanyId === companyId) {
        index.selectedCompanyId = index.companies[0]?.id ?? null;
      }

      await this.writeIndexUnlocked(index);
      await this.chatStore.deleteCompanyChats(companyId);
      await Promise.all([
        ...blueprintIds.map((id) => rm(this.blueprintPath(id), { force: true })),
        ...runIds.map((id) => rm(this.runArchivePath(id), { force: true }))
      ]);

      return {
        companies: this.buildCompanyOverviews(index),
        selectedCompanyId: index.selectedCompanyId ?? undefined,
        deleted: true
      };
    });
  }

  async listBlueprints(): Promise<BlueprintDefinition[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return [];
      return Promise.all(
        index.blueprintIndex
          .filter((blueprint) => blueprint.companyId === companyId)
          .map((blueprint) => this.readBlueprintUnlocked(blueprint.id))
      );
    });
  }

  async getBlueprint(id: string): Promise<BlueprintDefinition | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return undefined;
      const indexed = index.blueprintIndex.find((blueprint) => blueprint.id === id && blueprint.companyId === companyId);
      return indexed ? this.readBlueprintUnlocked(indexed.id) : undefined;
    });
  }

  getBlueprintWorkspacePath(id: string): string {
    return this.blueprintWorkspacePath(id);
  }

  async saveBlueprint(blueprint: BlueprintDefinition): Promise<BlueprintDefinition> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const now = new Date().toISOString();
      const existingIndex = index.blueprintIndex.findIndex((item) => item.id === blueprint.id && item.companyId === companyId);
      const currentVersion = existingIndex >= 0 ? index.blueprintIndex[existingIndex]!.version : blueprint.version;
      const currentCreatedAt = existingIndex >= 0 ? index.blueprintIndex[existingIndex]!.createdAt : now;
      const nextBlueprint = stripRemovedBlueprintNodes({
        ...blueprint,
        companyId,
        version: existingIndex >= 0 ? currentVersion + 1 : blueprint.version,
        updatedAt: now,
        createdAt: currentCreatedAt
      });

      await this.writeBlueprintUnlocked(nextBlueprint);
      if (existingIndex >= 0) {
        index.blueprintIndex[existingIndex] = toBlueprintIndexEntry(nextBlueprint);
      } else {
        index.blueprintIndex.push(toBlueprintIndexEntry(nextBlueprint));
      }

      index.roleDirectories[companyId] = buildRoleDirectory(index, companyId, now);
      await this.writeIndexUnlocked(index);
      return nextBlueprint;
    });
  }

  async createBlueprint(input: { name?: string; description?: string } = {}): Promise<BlueprintDefinition> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const now = new Date().toISOString();
      const blueprint = createBlankBlueprint({
        id: nextBlueprintId(index.blueprintIndex),
        companyId,
        now,
        name: input.name,
        description: input.description
      });

      await this.writeBlueprintUnlocked(blueprint);
      index.blueprintIndex.push(toBlueprintIndexEntry(blueprint));
      index.roleDirectories[companyId] = buildRoleDirectory(index, companyId, now);
      await this.writeIndexUnlocked(index);
      return blueprint;
    });
  }

  async deleteBlueprint(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return false;

      const existingIndex = index.blueprintIndex.findIndex((item) => item.id === id && item.companyId === companyId);
      if (existingIndex < 0) return false;

      index.blueprintIndex.splice(existingIndex, 1);
      index.roleDirectories[companyId] = buildRoleDirectory(index, companyId, new Date().toISOString());
      await this.writeIndexUnlocked(index);
      await rm(this.blueprintPath(id), { force: true });
      await rm(this.blueprintWorkspacePath(id), { recursive: true, force: true });
      return true;
    });
  }

  async importBlueprintPackage(
    blueprintPackage: PortableBlueprintPackage,
    defaults: BlueprintImportDefaults = {}
  ): Promise<BlueprintDefinition[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const imported = await this.importBlueprintPackageUnlocked(index, companyId, blueprintPackage, defaults);
      await this.writeIndexUnlocked(index);
      return imported;
    });
  }

  async storeBlueprintSkillSource(input: {
    blueprintId: string;
    sourcePath: string;
    sourceLabel?: string;
    skillSourceId?: string;
    skillIr?: unknown;
  }): Promise<BlueprintSkillSourceSnapshot> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const blueprintEntry = index.blueprintIndex.find((entry) => entry.companyId === companyId && entry.id === input.blueprintId);
      if (!blueprintEntry) {
        throw new Error(`Blueprint not found: ${input.blueprintId}`);
      }
      const blueprint = await this.readBlueprintUnlocked(input.blueprintId);
      const snapshot = await this.writeBlueprintSkillSourceSnapshotUnlocked(blueprint, input);
      await this.addSkillSourceToBlueprintManifestUnlocked(blueprint, snapshot);
      return snapshot;
    });
  }

  async getRoleDirectory(): Promise<{ roles: CompanyRoleDirectory; architecture: ArchitectureBlueprintView }> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const roles = buildRoleDirectory(index, companyId, new Date().toISOString(), index.roleDirectories[companyId]);
      return {
        roles,
        architecture: buildArchitectureBlueprintView(index, companyId, roles)
      };
    });
  }

  async saveArchitectureLayout(
    positions: Record<string, ArchitectureNodePosition>
  ): Promise<{ roles: CompanyRoleDirectory; architecture: ArchitectureBlueprintView }> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const now = new Date().toISOString();
      const roles = buildRoleDirectory(index, companyId, now, index.roleDirectories[companyId]);
      const roleIds = new Set([roles.ceo.id, ...roles.leaders.map((leader) => leader.id)]);
      const architecturePositions = {
        ...(roles.architecturePositions ?? {})
      };

      for (const [roleId, position] of Object.entries(positions)) {
        if (!roleIds.has(roleId)) continue;
        const normalizedPosition = normalizeArchitecturePosition(position);
        if (normalizedPosition) {
          architecturePositions[roleId] = normalizedPosition;
        }
      }

      const nextRoles: CompanyRoleDirectory = {
        ...roles,
        architecturePositions: pruneArchitecturePositions(architecturePositions, roleIds),
        updatedAt: now
      };
      index.roleDirectories[companyId] = nextRoles;
      await this.writeIndexUnlocked(index);

      return {
        roles: nextRoles,
        architecture: buildArchitectureBlueprintView(index, companyId, nextRoles)
      };
    });
  }

  async listInboxItems(): Promise<InboxItem[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return [];
      return [...(index.inboxItems[companyId] ?? [])].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      );
    });
  }

  async createLeaderDelegationRequest(input: {
    leaderId: string;
    blueprintId?: string;
    title?: string;
    summary?: string;
    createdByRoleId?: string;
  }): Promise<InboxItem> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const now = new Date().toISOString();
      const roles = buildRoleDirectory(index, companyId, now);
      const leader = roles.leaders.find((candidate) => candidate.id === input.leaderId);
      if (!leader) {
        throw new Error(`Leader not found: ${input.leaderId}`);
      }
      const blueprint = index.blueprintIndex.find((candidate) => candidate.companyId === companyId && candidate.id === (input.blueprintId ?? leader.blueprintId));
      const item = createInboxItem({
        companyId,
        type: "leader_delegation",
        title: input.title ?? `Call ${leader.label}`,
        summary: input.summary ?? `Request approval to bring ${leader.label} into this conversation.`,
        createdByRoleId: input.createdByRoleId ?? roles.ceo.id,
        targetRoleId: leader.id,
        blueprintId: blueprint?.id ?? leader.blueprintId,
        blueprintName: blueprint?.name,
        payload: {
          leaderId: leader.id,
          blueprintId: blueprint?.id ?? leader.blueprintId
        },
        now
      });
      index.roleDirectories[companyId] = roles;
      index.inboxItems[companyId] = [item, ...(index.inboxItems[companyId] ?? [])];
      await this.writeIndexUnlocked(index);
      return item;
    });
  }

  async createBlueprintProposal(input: {
    title: string;
    summary: string;
    blueprintId?: string;
    blueprintPackage?: PortableBlueprintPackage;
    preview?: Record<string, unknown>;
    diffSummary?: string;
    createdByRoleId?: string;
    targetRoleId?: string;
    runtimeId?: AgentRuntimeId;
  }): Promise<InboxItem> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const now = new Date().toISOString();
      const roles = buildRoleDirectory(index, companyId, now);
      if (!input.blueprintPackage) {
        throw new Error("Blueprint proposal requires an importable blueprintPackage.");
      }
      const blueprint = input.blueprintId
        ? index.blueprintIndex.find((candidate) => candidate.companyId === companyId && candidate.id === input.blueprintId)
        : undefined;
      const item = createInboxItem({
        companyId,
        type: "blueprint_proposal",
        title: readOptionalString(input.title) ?? "Blueprint proposal",
        summary: readOptionalString(input.summary) ?? "A leader generated importable blueprint package for approval.",
        createdByRoleId: input.createdByRoleId ?? inferLeaderRoleId(roles, input.blueprintId) ?? roles.ceo.id,
        targetRoleId: input.targetRoleId,
        blueprintId: blueprint?.id ?? input.blueprintId,
        blueprintName: blueprint?.name,
        payload: {
          blueprintPackage: input.blueprintPackage,
          preview: input.preview,
          diffSummary: input.diffSummary,
          runtimeId: input.runtimeId
        },
        now
      });
      index.roleDirectories[companyId] = roles;
      index.inboxItems[companyId] = [item, ...(index.inboxItems[companyId] ?? [])];
      await this.writeIndexUnlocked(index);
      return item;
    });
  }

  async approveInboxItem(
    itemId: string,
    defaults: BlueprintImportDefaults = {},
    comment?: string
  ): Promise<{ item: InboxItem; importedBlueprints?: BlueprintDefinition[] }> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const items = index.inboxItems[companyId] ?? [];
      const itemIndex = items.findIndex((item) => item.id === itemId);
      if (itemIndex < 0) throw new Error(`Inbox item not found: ${itemId}`);
      const item = items[itemIndex]!;
      if (item.status === "approved") {
        return { item };
      }
      let importedBlueprints: BlueprintDefinition[] | undefined;
      const blueprintPackage = readBlueprintPackagePayload(item.payload?.blueprintPackage);
      if (item.type === "blueprint_proposal" && !blueprintPackage) {
        throw new Error(`Blueprint proposal inbox item ${item.id} is missing an importable blueprintPackage.`);
      }
      if (item.type === "blueprint_proposal") {
        const importableBlueprintPackage = blueprintPackage;
        if (!importableBlueprintPackage) {
          throw new Error(`Blueprint proposal inbox item ${item.id} is missing an importable blueprintPackage.`);
        }
        importedBlueprints = await this.importBlueprintPackageUnlocked(index, companyId, importableBlueprintPackage, {
          ...defaults,
          runtimeId: readAgentRuntimeId(item.payload?.runtimeId) ?? defaults.runtimeId,
          replaceBlueprintId: item.blueprintId ?? defaults.replaceBlueprintId
        });
      }
      const now = new Date().toISOString();
      const approved: InboxItem = {
        ...item,
        status: "approved",
        updatedAt: now,
        decidedAt: now,
        decisionComment: readOptionalString(comment)
      };
      items[itemIndex] = approved;
      index.inboxItems[companyId] = items;
      await this.writeIndexUnlocked(index);
      return { item: approved, importedBlueprints };
    });
  }

  async rejectInboxItem(itemId: string, comment?: string): Promise<InboxItem> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const items = index.inboxItems[companyId] ?? [];
      const itemIndex = items.findIndex((item) => item.id === itemId);
      if (itemIndex < 0) throw new Error(`Inbox item not found: ${itemId}`);
      const item = items[itemIndex]!;
      if (item.status === "approved") {
        return item;
      }
      const now = new Date().toISOString();
      const rejected: InboxItem = {
        ...item,
        status: "rejected",
        updatedAt: now,
        decidedAt: now,
        decisionComment: readOptionalString(comment)
      };
      items[itemIndex] = rejected;
      index.inboxItems[companyId] = items;
      await this.writeIndexUnlocked(index);
      return rejected;
    });
  }

  async replyToInboxItem(itemId: string, message: string): Promise<InboxItem> {
    return this.enqueue(async () => {
      const body = readOptionalString(message);
      if (!body) {
        throw new Error("Inbox reply message is required.");
      }

      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const items = index.inboxItems[companyId] ?? [];
      const itemIndex = items.findIndex((item) => item.id === itemId);
      if (itemIndex < 0) throw new Error(`Inbox item not found: ${itemId}`);
      const item = items[itemIndex]!;
      if (item.status === "approved") {
        return item;
      }

      const now = new Date().toISOString();
      const replied: InboxItem = {
        ...item,
        replies: [
          ...(item.replies ?? []),
          {
            id: `inbox-reply-${nanoid(10)}`,
            role: "user",
            body,
            createdAt: now
          }
        ],
        updatedAt: now
      };
      items[itemIndex] = replied;
      index.inboxItems[companyId] = items;
      await this.writeIndexUnlocked(index);
      return replied;
    });
  }

  async applyInboxDecision(input: ApplyInboxDecisionInput): Promise<ApplyInboxDecisionResult> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const items = index.inboxItems[companyId] ?? [];
      const itemIndex = items.findIndex((item) => item.id === input.inboxItemId);
      const item = itemIndex >= 0 ? items[itemIndex]! : undefined;
      if (!item || item.status !== "pending") return { status: "conflict", item };
      const requestIndex = input.approvalRequestId
        ? index.approvalRequests.findIndex((request) => request.id === input.approvalRequestId)
        : -1;
      const request = requestIndex >= 0 ? index.approvalRequests[requestIndex]! : undefined;
      if (input.approvalRequestId && (!request || request.status !== "pending")) {
        return { status: "conflict", item };
      }

      let importedBlueprints: BlueprintDefinition[] | undefined;
      const now = new Date().toISOString();
      if (input.action === "reply") {
        const body = readOptionalString(input.comment);
        if (!body) throw new Error("Inbox reply message is required.");
        const replied = {
          ...item,
          replies: [...(item.replies ?? []), { id: `inbox-reply-${nanoid(10)}`, role: "user" as const, body, createdAt: now }],
          updatedAt: now
        };
        items[itemIndex] = replied;
        index.inboxItems[companyId] = items;
        if (requestIndex >= 0 && request) {
          index.approvalRequests[requestIndex] = { ...request, updatedAt: now };
          if (input.approvalDecision) upsertById(index.approvalDecisions, input.approvalDecision);
          if (input.approvalTimelineItem) {
            upsertById(index.runTimeline, {
              ...input.approvalTimelineItem,
              sequence: input.approvalTimelineItem.sequence ?? nextTimelineSequence(index.runTimeline, input.approvalTimelineItem.runId)
            });
          }
        }
        await this.writeIndexUnlocked(index);
        return { status: "applied", item: replied };
      }

      if (input.action === "approve" && item.type === "blueprint_proposal") {
        const blueprintPackage = readBlueprintPackagePayload(item.payload?.blueprintPackage);
        if (!blueprintPackage) throw new Error(`Blueprint proposal inbox item ${item.id} is missing an importable blueprintPackage.`);
        importedBlueprints = await this.importBlueprintPackageUnlocked(index, companyId, blueprintPackage, {
          ...(input.defaults ?? {}),
          runtimeId: readAgentRuntimeId(item.payload?.runtimeId) ?? input.defaults?.runtimeId,
          replaceBlueprintId: item.blueprintId ?? input.defaults?.replaceBlueprintId
        });
      }

      const decided: InboxItem = {
        ...item,
        status: input.action === "approve" ? "approved" : "rejected",
        updatedAt: now,
        decidedAt: now,
        decisionComment: readOptionalString(input.comment)
      };
      items[itemIndex] = decided;
      index.inboxItems[companyId] = items;
      if (requestIndex >= 0 && request) {
        index.approvalRequests[requestIndex] = {
          ...request,
          status: input.action === "approve" ? "approved" : "rejected",
          capabilities: resolveApprovalCapabilities(request.kind, input.action === "approve" ? "approved" : "rejected"),
          updatedAt: now
        };
        if (input.approvalDecision) upsertById(index.approvalDecisions, input.approvalDecision);
        if (input.approvalTimelineItem) {
          upsertById(index.runTimeline, {
            ...input.approvalTimelineItem,
            sequence: input.approvalTimelineItem.sequence ?? nextTimelineSequence(index.runTimeline, input.approvalTimelineItem.runId)
          });
        }
      }
      await this.writeIndexUnlocked(index);
      await Promise.all((importedBlueprints ?? []).map((blueprint) => this.writeBlueprintUnlocked(blueprint)));
      return { status: "applied", item: decided, importedBlueprints };
    });
  }

  async createBlueprintRun(blueprint: BlueprintDefinition, startedBy: string): Promise<BlueprintRun> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const runnableBlueprint = stripRemovedBlueprintNodes(blueprint);
      const run: BlueprintRun = {
        id: `run-${nanoid(10)}`,
        companyId: runnableBlueprint.companyId,
        blueprintId: runnableBlueprint.id,
        blueprintName: runnableBlueprint.name,
        blueprintVersion: runnableBlueprint.version,
        status: "queued",
        startedBy,
        startedAt: new Date().toISOString(),
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      };
      const summary = toBlueprintRunSummary(run, runnableBlueprint);
      const archive: BlueprintRunArchive = {
        schema: blueprintRunArchiveSchema,
        run: summary,
        blueprintSnapshot: runnableBlueprint,
        nodeRuns: [],
        events: [],
        finalResult: null
      };
      await this.writeRunArchiveUnlocked(archive);
      index.runIndex.push(summary);
      await this.writeIndexUnlocked(index);
      return run;
    });
  }

  async updateBlueprintRun(run: BlueprintRun): Promise<void> {
    await this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const runIndex = index.runIndex.findIndex((item) => item.id === run.id);
      if (runIndex < 0) {
        throw new Error(`Blueprint run not found: ${run.id}`);
      }
      const archive = await this.readRunArchiveUnlocked(run.id);
      const nextRun = applyNodeRunFactsToRun(
        toBlueprintRunSummary({ ...archive.run, ...run }, archive.blueprintSnapshot),
        archive.nodeRuns
      );
      const nextArchive: BlueprintRunArchive = {
        ...archive,
        run: nextRun,
        finalResult: resolveFinalRunResult(archive.blueprintSnapshot, archive.nodeRuns, nextRun.status)
      };
      index.runIndex[runIndex] = nextRun;
      await this.writeRunArchiveUnlocked(nextArchive);
      await this.writeIndexUnlocked(index);
    });
  }

  async getBlueprintRun(id: string): Promise<BlueprintRun | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      const run = index.runIndex.find((candidate) => candidate.id === id);
      if (!run) return undefined;
      if (!companyId || run.companyId !== companyId) return undefined;
      return run;
    });
  }

  async upsertNodeRun(nodeRun: BlueprintNodeRun): Promise<void> {
    await this.enqueue(async () => {
      const indexState = await this.readIndexUnlocked();
      const archive = await this.readRunArchiveUnlocked(nodeRun.blueprintRunId);
      const index = archive.nodeRuns.findIndex((item) => item.id === nodeRun.id);
      if (index >= 0) {
        archive.nodeRuns[index] = nodeRun;
      } else {
        archive.nodeRuns.push(nodeRun);
      }
      const run = applyNodeRunFactsToRun(archive.run, archive.nodeRuns);
      const runIndex = indexState.runIndex.findIndex((item) => item.id === run.id);
      if (runIndex >= 0) {
        indexState.runIndex[runIndex] = run;
      }
      await this.writeRunArchiveUnlocked({
        ...archive,
        run,
        finalResult: resolveFinalRunResult(archive.blueprintSnapshot, archive.nodeRuns, run.status)
      });
      if (runIndex >= 0) {
        await this.writeIndexUnlocked(indexState);
      }
    });
  }

  async createQueuedNodeRun(nodeRun: BlueprintNodeRun): Promise<BlueprintNodeRun> {
    const queued: BlueprintNodeRun = {
      ...nodeRun,
      status: "queued",
      startedAt: undefined,
      endedAt: undefined,
      error: undefined
    };
    await this.upsertNodeRun(queued);
    return queued;
  }

  async claimNodeRun(input: { nodeRunId: string; owner: string; leaseMs: number }): Promise<ClaimNodeRunResult> {
    return this.enqueue(async () => {
      const located = await this.findNodeRunUnlocked(input.nodeRunId);
      if (!located || !this.isClaimableNodeRun(located.nodeRun, input.nodeRunId)) return { claimed: false };
      const now = new Date().toISOString();
      const previousEpoch = this.nodeRunLeases.get(input.nodeRunId)?.workerEpoch ?? 0;
      const workerEpoch = previousEpoch + 1;
      const leaseExpiresAt = new Date(Date.now() + input.leaseMs).toISOString();
      const nodeRun: BlueprintNodeRun = {
        ...located.nodeRun,
        status: "running",
        startedAt: located.nodeRun.startedAt ?? now
      };
      located.archive.nodeRuns[located.index] = nodeRun;
      this.nodeRunLeases.set(input.nodeRunId, { owner: input.owner, workerEpoch, leaseExpiresAt });
      await this.persistNodeRunArchiveAndIndexUnlocked(located.archive);
      return { claimed: true, nodeRun, workerEpoch, leaseExpiresAt };
    });
  }

  async renewNodeRunLease(input: { nodeRunId: string; owner: string; workerEpoch: number; leaseMs: number }): Promise<boolean> {
    return this.enqueue(async () => {
      const located = await this.findNodeRunUnlocked(input.nodeRunId);
      if (!located || located.nodeRun.status !== "running" || !this.matchesLease(input)) return false;
      const leaseExpiresAt = new Date(Date.now() + input.leaseMs).toISOString();
      this.nodeRunLeases.set(input.nodeRunId, { owner: input.owner, workerEpoch: input.workerEpoch, leaseExpiresAt });
      return true;
    });
  }

  async startNodeRun(input: { nodeRunId: string; owner: string; workerEpoch: number; startedAt?: string; input?: unknown; runtimeRef?: BlueprintNodeRun["runtimeRef"] }): Promise<boolean> {
    return this.enqueue(async () => {
      const located = await this.findNodeRunUnlocked(input.nodeRunId);
      if (!located || located.nodeRun.status !== "running" || !this.matchesLease(input)) return false;
      located.archive.nodeRuns[located.index] = {
        ...located.nodeRun,
        startedAt: input.startedAt ?? located.nodeRun.startedAt ?? new Date().toISOString(),
        ...(input.input === undefined ? {} : { input: input.input }),
        ...(input.runtimeRef === undefined ? {} : { runtimeRef: input.runtimeRef })
      };
      await this.persistNodeRunArchiveAndIndexUnlocked(located.archive);
      return true;
    });
  }

  async completeNodeRun(input: CompleteNodeRunInput): Promise<boolean> {
    return this.enqueue(async () => {
      const located = await this.findNodeRunUnlocked(input.nodeRunId);
      if (!located || located.nodeRun.status !== "running" || !this.matchesLease(input)) return false;
      located.archive.nodeRuns[located.index] = {
        ...located.nodeRun,
        ...input.nodeRun,
        status: "succeeded",
        endedAt: input.nodeRun.endedAt ?? new Date().toISOString(),
        error: undefined
      };
      await this.persistNodeRunArchiveAndIndexUnlocked(located.archive);
      return true;
    });
  }

  async failNodeRun(input: FailNodeRunInput): Promise<boolean> {
    return this.enqueue(async () => {
      const located = await this.findNodeRunUnlocked(input.nodeRunId);
      if (!located || located.nodeRun.status !== "running" || !this.matchesLease(input)) return false;
      located.archive.nodeRuns[located.index] = {
        ...located.nodeRun,
        status: "failed",
        endedAt: input.endedAt ?? new Date().toISOString(),
        error: input.error
      };
      await this.persistNodeRunArchiveAndIndexUnlocked(located.archive);
      return true;
    });
  }

  async cancelNodeRun(input: CancelNodeRunInput): Promise<boolean> {
    return this.enqueue(async () => {
      const located = await this.findNodeRunUnlocked(input.nodeRunId);
      if (!located || located.nodeRun.status !== "running" || !this.matchesLease(input)) return false;
      located.archive.nodeRuns[located.index] = {
        ...located.nodeRun,
        status: "cancelled",
        endedAt: input.endedAt ?? new Date().toISOString(),
        error: input.reason,
        runtimeRef: input.runtimeRef ?? located.nodeRun.runtimeRef
      };
      await this.persistNodeRunArchiveAndIndexUnlocked(located.archive);
      return true;
    });
  }

  async publishAgentOutput(input: PublishAgentOutputInput): Promise<PublishAgentOutputResult> {
    return this.enqueue(async () => {
      const indexState = await this.readIndexUnlocked();
      const archive = await this.readRunArchiveUnlocked(input.nodeRun.blueprintRunId);
      const nodeIndex = archive.nodeRuns.findIndex((item) => item.id === input.nodeRunId);
      const current = nodeIndex >= 0 ? archive.nodeRuns[nodeIndex] : undefined;
      if (!current || current.status !== "running" || !this.matchesLease(input)) return { published: false };
      const completed: BlueprintNodeRun = {
        ...current,
        ...input.nodeRun,
        status: "succeeded",
        endedAt: input.nodeRun.endedAt ?? new Date().toISOString(),
        output: input.output,
        usage: input.nodeRun.usage,
        runtimeRef: input.nodeRun.runtimeRef,
        error: undefined
      };
      archive.nodeRuns[nodeIndex] = completed;
      archive.events.push(input.event);
      for (const artifact of input.artifacts) upsertById(indexState.artifacts, artifact);
      if (input.humanReport) upsertById(indexState.agentHumanReports, input.humanReport);
      if (input.handoff) upsertById(indexState.agentHandoffs, input.handoff);
      for (const item of input.timelineItems ?? []) {
        upsertById(indexState.runTimeline, {
          ...item,
          sequence: item.sequence ?? nextTimelineSequence(indexState.runTimeline, item.runId)
        });
      }
      const run = applyNodeRunFactsToRun(archive.run, archive.nodeRuns);
      const runIndex = indexState.runIndex.findIndex((item) => item.id === run.id);
      if (runIndex >= 0) indexState.runIndex[runIndex] = run;
      await this.writeRunArchiveUnlocked({
        ...archive,
        run,
        finalResult: resolveFinalRunResult(archive.blueprintSnapshot, archive.nodeRuns, run.status)
      });
      await this.writeIndexUnlocked(indexState);
      return { published: true };
    });
  }

  async listNodeRuns(blueprintRunId: string): Promise<BlueprintNodeRun[]> {
    return this.enqueue(async () => {
      const archive = await this.readRunArchiveUnlocked(blueprintRunId);
      return archive.nodeRuns;
    });
  }

  async appendEvent(event: BlueprintNodeEvent): Promise<void> {
    await this.enqueue(async () => {
      const archive = await this.readRunArchiveUnlocked(event.blueprintRunId);
      archive.events.push(event);
      await this.writeRunArchiveUnlocked(archive);
    });
  }

  async getRunView(blueprintRunId: string): Promise<BlueprintRunView | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      const run = index.runIndex.find((item) => item.id === blueprintRunId);
      if (!run || !companyId || run.companyId !== companyId) return undefined;
      return this.getRunViewFromArchive(await this.readRunArchiveUnlocked(blueprintRunId), index);
    });
  }

  async getLatestRunViewForBlueprint(blueprintId: string): Promise<BlueprintRunView | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return undefined;
      const run = index.runIndex
        .filter((item) => item.companyId === companyId && item.blueprintId === blueprintId)
        .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())[0];
      if (!run) return undefined;
      return this.getRunViewFromArchive(await this.readRunArchiveUnlocked(run.id), index);
    });
  }

  async listRunSummaries(): Promise<BlueprintRunSummary[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return [];
      return index.runIndex
        .filter((run) => run.companyId === companyId)
        .slice()
        .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());
    });
  }

  async listRunViews(): Promise<BlueprintRunView[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return [];
      const archives = await Promise.all(
        index.runIndex
        .filter((run) => run.companyId === companyId)
        .slice()
        .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
          .map((run) => this.readRunArchiveUnlocked(run.id))
      );
      return archives.map((archive) => this.getRunViewFromArchive(archive, index));
    });
  }

  async listRunArchives(): Promise<BlueprintRunArchive[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return [];
      return Promise.all(
        index.runIndex
          .filter((run) => run.companyId === companyId)
          .map((run) => this.readRunArchiveUnlocked(run.id))
      );
    });
  }

  async listPendingApprovals(): Promise<PendingApprovalItem[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return [];
      const runsById = new Map(index.runIndex.filter((run) => run.companyId === companyId).map((run) => [run.id, run]));
      const archivesByRunId = new Map(
        await Promise.all([...runsById.keys()].map(async (runId) => [runId, await this.readRunArchiveUnlocked(runId)] as const))
      );
      return index.approvalRequests
        .filter((request) => request.status === "pending" && runsById.has(request.runId))
        .map((request) => {
          const run = runsById.get(request.runId)!;
          const nodeRun = request.nodeRunId
            ? archivesByRunId.get(request.runId)?.nodeRuns.find((candidate) => candidate.id === request.nodeRunId)
            : undefined;
          const output = isRecord(nodeRun?.output) && nodeRun.output.approvalType === "agent" ? nodeRun.output : undefined;
          const selectedReplyId = readString(output?.selectedReplyId);
          const replies = readPendingApprovalReplies(output?.replies, selectedReplyId);
          const upstream = readPendingApprovalUpstream(nodeRun?.input);
          return {
            approvalRequestId: request.id,
            kind: request.kind,
            blueprintId: run.blueprintId,
            blueprintName: run.blueprintName,
            blueprintRunId: run.id,
            nodeRunId: request.nodeRunId ?? request.id,
            nodeId: request.requestedBy.nodeId ?? request.id,
            nodeLabel: request.requestedBy.label,
            startedBy: run.startedBy,
            startedAt: run.startedAt,
            requestedAt: request.requestedAt,
            status: nodeRun?.status === "running" ? "replying" as const : "pending" as const,
            reviewOutput: output && "reviewOutput" in output ? output.reviewOutput : request.body,
            ...(replies ? { replies } : {}),
            ...(selectedReplyId ? { selectedReplyId } : {}),
            ...(upstream ? { upstream } : {}),
            canApprove: request.capabilities.approve,
            canReject: request.capabilities.reject,
            canReply: request.capabilities.reply,
            canComplete: request.capabilities.complete,
            canTerminate: request.capabilities.terminate
          };
        })
        .sort((left, right) => new Date(right.requestedAt).getTime() - new Date(left.requestedAt).getTime());
    });
  }

  async listApprovalRequests(filter: { runId?: string; status?: ApprovalRequest["status"] } = {}): Promise<ApprovalRequest[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.approvalRequests
        .filter((request) => !filter.runId || request.runId === filter.runId)
        .filter((request) => !filter.status || request.status === filter.status)
        .slice()
        .sort((left, right) => new Date(right.requestedAt).getTime() - new Date(left.requestedAt).getTime());
    });
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.approvalRequests.find((request) => request.id === id);
    });
  }

  async upsertApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      upsertById(index.approvalRequests, request);
      await this.writeIndexUnlocked(index);
      return request;
    });
  }

  async appendApprovalDecision(decision: ApprovalDecision): Promise<ApprovalDecision> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      upsertById(index.approvalDecisions, decision);
      await this.writeIndexUnlocked(index);
      return decision;
    });
  }

  async applyApprovalDecision(input: ApplyApprovalDecisionInput): Promise<ApplyApprovalDecisionResult> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const requestIndex = index.approvalRequests.findIndex((request) => request.id === input.approvalRequestId);
      const current = requestIndex >= 0 ? index.approvalRequests[requestIndex]! : undefined;
      if (!current || current.status !== input.expectedStatus) {
        return { status: "conflict", approvalRequest: current };
      }
      index.approvalRequests[requestIndex] = input.nextRequest;
      upsertById(index.approvalDecisions, input.decision);
      if (input.nextApprovalRequest) upsertById(index.approvalRequests, input.nextApprovalRequest);
      if (input.releaseReport) upsertById(index.releaseReports, input.releaseReport);
      if (input.timelineItem) {
        upsertById(index.runTimeline, {
          ...input.timelineItem,
          sequence: input.timelineItem.sequence ?? nextTimelineSequence(index.runTimeline, input.timelineItem.runId)
        });
      }
      await this.writeIndexUnlocked(index);
      return {
        status: "applied",
        approvalRequest: input.nextRequest,
        decision: input.decision,
        nextApprovalRequest: input.nextApprovalRequest
      };
    });
  }

  async listApprovalDecisions(approvalRequestId?: string): Promise<ApprovalDecision[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.approvalDecisions
        .filter((decision) => !approvalRequestId || decision.approvalRequestId === approvalRequestId)
        .slice()
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    });
  }

  async listIterationSessions(runId?: string): Promise<IterationSession[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.iterationSessions.filter((session) => !runId || session.runId === runId);
    });
  }

  async upsertIterationSession(session: IterationSession): Promise<IterationSession> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      upsertById(index.iterationSessions, session);
      await this.writeIndexUnlocked(index);
      return session;
    });
  }

  async listIterationRounds(filter: { runId?: string; sessionId?: string; status?: IterationRound["status"] } = {}): Promise<IterationRound[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.iterationRounds
        .filter((round) => !filter.runId || round.runId === filter.runId)
        .filter((round) => !filter.sessionId || round.sessionId === filter.sessionId)
        .filter((round) => !filter.status || round.status === filter.status)
        .slice()
        .sort((left, right) => left.roundNumber - right.roundNumber);
    });
  }

  async upsertIterationRound(round: IterationRound): Promise<IterationRound> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      upsertById(index.iterationRounds, round);
      await this.writeIndexUnlocked(index);
      return round;
    });
  }

  async listArtifacts(runId?: string): Promise<Artifact[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.artifacts.filter((artifact) => !runId || artifact.runId === runId);
    });
  }

  async upsertArtifact(artifact: Artifact): Promise<Artifact> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      upsertById(index.artifacts, artifact);
      await this.writeIndexUnlocked(index);
      return artifact;
    });
  }

  async listReleaseReports(runId?: string): Promise<ReleaseReport[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.releaseReports
        .filter((report) => !runId || report.runId === runId)
        .slice()
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    });
  }

  async upsertReleaseReport(report: ReleaseReport): Promise<ReleaseReport> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      upsertById(index.releaseReports, report);
      await this.writeIndexUnlocked(index);
      return report;
    });
  }

  async listAgentHumanReports(runId?: string): Promise<AgentHumanReport[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.agentHumanReports
        .filter((report) => !runId || report.runId === runId)
        .slice()
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    });
  }

  async upsertAgentHumanReport(report: AgentHumanReport): Promise<AgentHumanReport> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      upsertById(index.agentHumanReports, report);
      await this.writeIndexUnlocked(index);
      return report;
    });
  }

  async listAgentHandoffs(runId?: string): Promise<AgentHandoff[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.agentHandoffs
        .filter((handoff) => !runId || handoff.runId === runId)
        .slice()
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    });
  }

  async upsertAgentHandoff(handoff: AgentHandoff): Promise<AgentHandoff> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      upsertById(index.agentHandoffs, handoff);
      await this.writeIndexUnlocked(index);
      return handoff;
    });
  }

  async listManagerContextSnapshots(runId?: string): Promise<ManagerContextSnapshot[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.managerContextSnapshots
        .filter((snapshot) => !runId || snapshot.runId === runId)
        .slice()
        .sort((left, right) => left.version - right.version);
    });
  }

  async upsertManagerContextSnapshot(snapshot: ManagerContextSnapshot): Promise<ManagerContextSnapshot> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      upsertById(index.managerContextSnapshots, snapshot);
      await this.writeIndexUnlocked(index);
      return snapshot;
    });
  }

  async appendRunTimelineItem(item: Omit<RunTimelineItem, "sequence"> & { sequence?: number }): Promise<RunTimelineItem> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const sequence = item.sequence ?? nextTimelineSequence(index.runTimeline, item.runId);
      const timelineItem: RunTimelineItem = { ...item, sequence };
      upsertById(index.runTimeline, timelineItem);
      await this.writeIndexUnlocked(index);
      return timelineItem;
    });
  }

  async listRunTimeline(runId: string): Promise<RunTimelineItem[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.runTimeline.filter((item) => item.runId === runId).sort((left, right) => left.sequence - right.sequence);
    });
  }

  async listManagerMail(runId?: string): Promise<ManagerMail[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.managerMail
        .filter((mail) => !runId || mail.relatedRunId === runId)
        .slice()
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    });
  }

  async replaceManagerMail(mail: ManagerMail[], scope?: { runId?: string }): Promise<ManagerMail[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const mailIds = new Set(mail.map((item) => item.id));
      const retained = scope
        ? index.managerMail.filter((item) => scope.runId !== undefined ? item.relatedRunId !== scope.runId : false)
        : index.managerMail.filter((item) => !mailIds.has(item.id));
      index.managerMail = [...retained, ...mail];
      await this.writeIndexUnlocked(index);
      return mail;
    });
  }

  async getDashboardState(): Promise<WorkspaceDashboard> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) {
        return createDefaultWorkspaceDashboard(new Date().toISOString());
      }
      return index.companyDashboards[companyId] ?? createDefaultWorkspaceDashboard(new Date().toISOString());
    });
  }

  async saveDashboardState(dashboard: WorkspaceDashboard): Promise<WorkspaceDashboard> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      index.companyDashboards[companyId] = normalizeWorkspaceDashboard(dashboard, new Date().toISOString());
      index.companyDashboards[companyId].updatedAt = new Date().toISOString();
      await this.writeIndexUnlocked(index);
      return index.companyDashboards[companyId];
    });
  }

  async saveCatalogSnapshot(snapshot: CatalogSnapshot): Promise<CatalogSnapshot> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      index.catalogSnapshot = snapshot;
      await this.writeIndexUnlocked(index);
      return snapshot;
    });
  }

  async getCatalogSnapshot(): Promise<CatalogSnapshot | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      return index.catalogSnapshot;
    });
  }

  async listChatSessions(): Promise<HivewardChatSession[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return [];
      return this.chatStore.listChatSessions(companyId);
    });
  }

  async getChatSession(id: string): Promise<HivewardChatSession | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return undefined;
      return this.chatStore.getChatSession(companyId, id);
    });
  }

  async findChatSessionByNative(input: { harnessId: HarnessId; nativeSessionId: string }): Promise<HivewardChatSession | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return undefined;
      return this.chatStore.findChatSessionByNative({ companyId, ...input });
    });
  }

  async createChatSession(input: CreateHivewardChatSessionRequest): Promise<HivewardChatSession> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.requireSelectedCompanyId(index);
      const now = new Date().toISOString();
      const roleScope = normalizeChatRoleScopeForSelectedCompany(index, companyId, input.roleScope, now);
      return this.chatStore.createChatSession(companyId, { ...input, roleScope });
    });
  }

  async updateChatSession(id: string, patch: UpdateHivewardChatSessionRequest): Promise<HivewardChatSession | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return undefined;
      const now = new Date().toISOString();
      const roleScope = patch.roleScope
        ? normalizeChatRoleScopeForSelectedCompany(index, companyId, patch.roleScope, now)
        : undefined;
      return this.chatStore.updateChatSession(companyId, id, {
        ...patch,
        ...(patch.roleScope ? { roleScope } : {})
      });
    });
  }

  async endChatSession(id: string): Promise<HivewardChatSession | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return undefined;
      return this.chatStore.endChatSession(companyId, id);
    });
  }

  async listChatMessages(sessionId: string): Promise<HivewardChatMessage[]> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      if (!companyId) return [];
      return this.chatStore.listChatMessages(companyId, sessionId);
    });
  }

  async appendChatMessage(
    input: Omit<HivewardChatMessage, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
      createdAt?: string;
      updatedAt?: string;
    }
  ): Promise<HivewardChatMessage> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      return this.chatStore.appendChatMessage(companyId, input);
    });
  }

  async updateChatMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<Pick<HivewardChatMessage, "content" | "status" | "runtimeRef" | "nativeMessageId" | "modelId">>
  ): Promise<HivewardChatMessage | undefined> {
    return this.enqueue(async () => {
      const index = await this.readIndexUnlocked();
      const companyId = this.getCurrentCompanyId(index);
      return this.chatStore.updateChatMessage(companyId, sessionId, messageId, patch);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async readIndexUnlocked(): Promise<HivewardStoreIndex> {
    return (await this.readIndexWithLegacyChatUnlocked()).index;
  }

  private async readIndexWithLegacyChatUnlocked(): Promise<{
    index: HivewardStoreIndex;
    legacyChat?: LegacyHivewardChatState;
  }> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isFileNotFoundError(error) || this.seedDefaultsOnInit) throw error;
      return { index: this.emptyIndex() };
    }
    const parsed = JSON.parse(raw) as LegacyHivewardStoreState;
    if (parsed.schema === storeIndexSchema) {
      return {
        index: this.normalizeIndex(parsed as RawHivewardStoreIndex),
        legacyChat: extractLegacyChatState(parsed)
      };
    }
    return {
      index: await this.migrateLegacyStateUnlocked(parsed),
      legacyChat: extractLegacyChatState(parsed)
    };
  }

  private async writeIndexUnlocked(index: HivewardStoreIndex): Promise<void> {
    await safeWriteJson(this.filePath, index);
  }

  private emptyIndex(): HivewardStoreIndex {
    return {
      schema: storeIndexSchema,
      companies: [],
      selectedCompanyId: null,
      blueprintIndex: [],
      runIndex: [],
      companyDashboards: {},
      roleDirectories: {},
      inboxItems: {},
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
  }

  private async readBlueprintUnlocked(id: string): Promise<BlueprintDefinition> {
    return stripRemovedBlueprintNodes(JSON.parse(await readFile(this.blueprintPath(id), "utf8")) as BlueprintDefinition);
  }

  private async writeBlueprintUnlocked(blueprint: BlueprintDefinition): Promise<void> {
    const sanitizedBlueprint = stripRemovedBlueprintNodes(blueprint);
    await safeWriteJson(this.blueprintPath(sanitizedBlueprint.id), sanitizedBlueprint);
    await this.writeBlueprintWorkspaceUnlocked(sanitizedBlueprint);
  }

  private async readRunArchiveUnlocked(id: string): Promise<BlueprintRunArchive> {
    const rawArchive = JSON.parse(await readFile(this.runArchivePath(id), "utf8")) as Partial<BlueprintRunArchive>;
    const archive = normalizeRunArchiveRuntimeRefs(rawArchive as BlueprintRunArchive);
    return stripRemovedBlueprintRunArchive({
      schema: blueprintRunArchiveSchema,
      run: archive.run,
      blueprintSnapshot: archive.blueprintSnapshot,
      nodeRuns: Array.isArray(archive.nodeRuns) ? archive.nodeRuns : [],
      events: Array.isArray(archive.events) ? archive.events : [],
      finalResult: archive.finalResult ?? null
    });
  }

  private async writeRunArchiveUnlocked(archive: BlueprintRunArchive): Promise<void> {
    await safeWriteJson(this.runArchivePath(archive.run.id), stripRemovedBlueprintRunArchive(normalizeRunArchiveRuntimeRefs(archive)));
  }

  private async findNodeRunUnlocked(nodeRunId: string): Promise<{
    archive: BlueprintRunArchive;
    nodeRun: BlueprintNodeRun;
    index: number;
  } | undefined> {
    const indexState = await this.readIndexUnlocked();
    for (const run of indexState.runIndex) {
      const archive = await this.readRunArchiveUnlocked(run.id);
      const index = archive.nodeRuns.findIndex((item) => item.id === nodeRunId);
      if (index >= 0) {
        return { archive, nodeRun: archive.nodeRuns[index]!, index };
      }
    }
    return undefined;
  }

  private async persistNodeRunArchiveAndIndexUnlocked(archive: BlueprintRunArchive): Promise<void> {
    const indexState = await this.readIndexUnlocked();
    const run = applyNodeRunFactsToRun(archive.run, archive.nodeRuns);
    const runIndex = indexState.runIndex.findIndex((item) => item.id === run.id);
    if (runIndex >= 0) indexState.runIndex[runIndex] = run;
    await this.writeRunArchiveUnlocked({
      ...archive,
      run,
      finalResult: resolveFinalRunResult(archive.blueprintSnapshot, archive.nodeRuns, run.status)
    });
    if (runIndex >= 0) await this.writeIndexUnlocked(indexState);
  }

  private matchesLease(input: { nodeRunId: string; owner: string; workerEpoch: number }): boolean {
    const lease = this.nodeRunLeases.get(input.nodeRunId);
    return Boolean(
      lease &&
      lease.owner === input.owner &&
      lease.workerEpoch === input.workerEpoch &&
      Date.parse(lease.leaseExpiresAt) > Date.now()
    );
  }

  private isClaimableNodeRun(nodeRun: BlueprintNodeRun, nodeRunId: string): boolean {
    if (nodeRun.status === "queued") return true;
    if (nodeRun.status !== "running") return false;
    const lease = this.nodeRunLeases.get(nodeRunId);
    return !lease || Date.parse(lease.leaseExpiresAt) <= Date.now();
  }

  private async importBlueprintPackageUnlocked(
    index: HivewardStoreIndex,
    companyId: string,
    blueprintPackage: PortableBlueprintPackage,
    defaults: BlueprintImportDefaults
  ): Promise<BlueprintDefinition[]> {
    const now = new Date().toISOString();
    const imported: BlueprintDefinition[] = [];
    const knownBlueprints = [...index.blueprintIndex];
    let replacementUsed = false;

    for (const portableBlueprint of blueprintPackage.blueprints) {
      const replacementIndex = !replacementUsed && defaults.replaceBlueprintId
        ? index.blueprintIndex.findIndex((entry) => entry.companyId === companyId && entry.id === defaults.replaceBlueprintId)
        : -1;
      const replacementEntry = replacementIndex >= 0 ? index.blueprintIndex[replacementIndex] : undefined;
      const blueprint = hydrateImportedBlueprint(portableBlueprint, {
        id: replacementEntry?.id ?? nextBlueprintId(knownBlueprints),
        companyId,
        now,
        defaults,
        name: replacementEntry ? portableBlueprint.name : nextImportedBlueprintName(knownBlueprints, portableBlueprint.name)
      });
      const importedBlueprint = replacementEntry
        ? {
            ...blueprint,
            version: replacementEntry.version + 1,
            createdAt: replacementEntry.createdAt
          }
        : blueprint;
      const entry = toBlueprintIndexEntry(importedBlueprint);
      await this.writeBlueprintUnlocked(importedBlueprint);
      if (replacementIndex >= 0) {
        index.blueprintIndex[replacementIndex] = entry;
        const knownIndex = knownBlueprints.findIndex((known) => known.companyId === companyId && known.id === entry.id);
        if (knownIndex >= 0) {
          knownBlueprints[knownIndex] = entry;
        } else {
          knownBlueprints.push(entry);
        }
        replacementUsed = true;
      } else {
        knownBlueprints.push(entry);
        index.blueprintIndex.push(entry);
      }
      imported.push(importedBlueprint);
    }

    index.roleDirectories[companyId] = buildRoleDirectory(index, companyId, now);
    return imported;
  }

  private blueprintPath(id: string): string {
    return join(this.blueprintsDir, `${id}.json`);
  }

  private blueprintWorkspacePath(id: string): string {
    return join(this.blueprintWorkspacesDir, id);
  }

  private async ensureBlueprintWorkspacesUnlocked(index: HivewardStoreIndex): Promise<void> {
    await Promise.all(index.blueprintIndex.map(async (entry) => {
      try {
        await this.writeBlueprintWorkspaceUnlocked(await this.readBlueprintUnlocked(entry.id));
      } catch (error) {
        if (!isFileNotFoundError(error)) throw error;
      }
    }));
  }

  private async writeBlueprintWorkspaceUnlocked(blueprint: BlueprintDefinition): Promise<void> {
    const workspacePath = this.blueprintWorkspacePath(blueprint.id);
    await Promise.all([
      mkdir(join(workspacePath, "blueprints"), { recursive: true }),
      mkdir(join(workspacePath, "skills"), { recursive: true }),
      mkdir(join(workspacePath, "mcp"), { recursive: true }),
      mkdir(join(workspacePath, "scripts"), { recursive: true }),
      mkdir(join(workspacePath, "artifacts"), { recursive: true }),
      mkdir(join(workspacePath, "tmp"), { recursive: true })
    ]);
    const manifestPath = join(workspacePath, "manifest.json");
    const existingManifest = await readJsonIfExists(manifestPath);
    await Promise.all([
      writeFile(join(workspacePath, "BLUEPRINT.md"), buildBlueprintEntryMarkdown(blueprint), "utf8"),
      safeWriteJson(manifestPath, mergeBlueprintWorkspaceManifest(buildBlueprintWorkspaceManifest(blueprint), existingManifest)),
      safeWriteJson(join(workspacePath, "blueprints", `${blueprint.id}.json`), blueprint)
    ]);
  }

  private async writeBlueprintSkillSourceSnapshotUnlocked(
    blueprint: BlueprintDefinition,
    input: {
      sourcePath: string;
      sourceLabel?: string;
      skillSourceId?: string;
      skillIr?: unknown;
    }
  ): Promise<BlueprintSkillSourceSnapshot> {
    await this.writeBlueprintWorkspaceUnlocked(blueprint);
    const sourcePath = resolve(input.sourcePath);
    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Skill source snapshots do not support symbolic links: ${sourcePath}`);
    }
    const sourceIsDirectory = sourceStat.isDirectory();
    const sourceName = basename(sourcePath);
    const sourceCompleteness = await classifySkillSource(sourcePath, sourceIsDirectory);
    const skillSourceId = input.skillSourceId ?? `skill-src-${nanoid(8)}`;
    const skillSourcePath = join(this.blueprintWorkspacePath(blueprint.id), "skills", skillSourceId);

    validateSkillIrScriptPaths(skillSourcePath, input.skillIr);
    await rm(skillSourcePath, { recursive: true, force: true });
    await mkdir(skillSourcePath, { recursive: true });

    if (sourceIsDirectory) {
      await assertSkillPackagePartsContainNoSymlinks(sourcePath);
      await copySkillPackageParts(sourcePath, skillSourcePath);
    } else {
      await cp(sourcePath, join(skillSourcePath, sourceName));
    }

    const capturedFiles = await listRelativeFiles(skillSourcePath);
    const fileHashes = await hashRelativeFiles(skillSourcePath, capturedFiles);
    const scriptInventory = await buildScriptInventory(skillSourcePath, capturedFiles);
    const snapshot: BlueprintSkillSourceSnapshot = {
      skillSourceId,
      blueprintId: blueprint.id,
      workingDirectory: skillSourcePath,
      sourceCompleteness,
      capturedFiles,
      fileHashes,
      scriptInventory
    };

    await safeWriteJson(join(skillSourcePath, "hiveward-skill-source.json"), {
      schema: "hiveward.skill-source/v1",
      skillSourceId,
      blueprintId: blueprint.id,
      sourceKind: sourceIsDirectory ? "local_path" : "markdown_file",
      sourceLabel: input.sourceLabel ?? sourceName,
      originalPath: sourcePath,
      sourceCompleteness,
      capturedFiles,
      fileHashes,
      scriptInventory,
      createdAt: new Date().toISOString()
    });
    if (input.skillIr !== undefined) {
      await safeWriteJson(join(skillSourcePath, "skill-ir.json"), input.skillIr);
    }

    return snapshot;
  }

  private async addSkillSourceToBlueprintManifestUnlocked(
    blueprint: BlueprintDefinition,
    snapshot: BlueprintSkillSourceSnapshot
  ): Promise<void> {
    const manifestPath = join(this.blueprintWorkspacePath(blueprint.id), "manifest.json");
    const currentManifest = await readJsonIfExists(manifestPath) ?? buildBlueprintWorkspaceManifest(blueprint);
    const requiredResources = isPlainObject(currentManifest.requiredResources)
      ? currentManifest.requiredResources
      : {};
    const skills = new Set(readStringArray(requiredResources.skills));
    const scripts = new Set(readStringArray(requiredResources.scripts));
    skills.add(snapshot.skillSourceId);
    for (const script of snapshot.scriptInventory) {
      scripts.add(`${snapshot.skillSourceId}/${script.path}`);
    }

    await safeWriteJson(manifestPath, {
      ...currentManifest,
      requiredResources: {
        ...requiredResources,
        skills: [...skills].sort(),
        scripts: [...scripts].sort(),
        mcp: readStringArray(requiredResources.mcp)
      },
      skillSources: [
        ...readRecordArray(currentManifest.skillSources).filter((item) => item.skillSourceId !== snapshot.skillSourceId),
        {
          skillSourceId: snapshot.skillSourceId,
          sourceCompleteness: snapshot.sourceCompleteness,
          workingDirectory: snapshot.workingDirectory,
          capturedFiles: snapshot.capturedFiles,
          scripts: snapshot.scriptInventory.map((script) => script.path)
        }
      ]
    });
  }

  private runArchivePath(id: string): string {
    return join(this.runsDir, `${id}.json`);
  }

  private normalizeIndex(rawIndex: RawHivewardStoreIndex): HivewardStoreIndex {
    const now = new Date().toISOString();
    const companies = normalizeCompanies(rawIndex.companies, now);
    const primaryCompanyId = companies[0]?.id ?? defaultCompanyId;
    const selectedCompanyId = normalizeSelectedCompanyId(rawIndex.selectedCompanyId, companies, primaryCompanyId);
    const companyDashboards = normalizeCompanyDashboards(rawIndex.companyDashboards, companies, now);
    const blueprintIndex = Array.isArray(rawIndex.blueprintIndex)
      ? rawIndex.blueprintIndex.map((entry) => normalizeBlueprintIndexEntry(entry, primaryCompanyId, now))
      : [];
    const runIndex = Array.isArray(rawIndex.runIndex)
      ? rawIndex.runIndex.map((run) => normalizeRunSummary(run, primaryCompanyId))
      : [];
    const index: HivewardStoreIndex = {
      schema: storeIndexSchema,
      companies,
      selectedCompanyId,
      blueprintIndex,
      runIndex,
      catalogSnapshot: rawIndex.catalogSnapshot,
      companyDashboards,
      roleDirectories: {},
      inboxItems: normalizeInboxItems(rawIndex.inboxItems, companies, now),
      iterationSessions: normalizeArray<IterationSession>(rawIndex.iterationSessions),
      iterationRounds: normalizeArray<IterationRound>(rawIndex.iterationRounds),
      approvalRequests: normalizeArray<ApprovalRequest>(rawIndex.approvalRequests),
      approvalDecisions: normalizeArray<ApprovalDecision>(rawIndex.approvalDecisions),
      artifacts: normalizeArray<Artifact>(rawIndex.artifacts),
      releaseReports: normalizeArray<ReleaseReport>(rawIndex.releaseReports),
      agentHumanReports: normalizeArray<AgentHumanReport>(rawIndex.agentHumanReports),
      agentHandoffs: normalizeArray<AgentHandoff>(rawIndex.agentHandoffs),
      managerContextSnapshots: normalizeArray<ManagerContextSnapshot>(rawIndex.managerContextSnapshots),
      runTimeline: normalizeArray<RunTimelineItem>(rawIndex.runTimeline),
      managerMail: normalizeArray<ManagerMail>(rawIndex.managerMail)
    };
    for (const company of companies) {
      index.roleDirectories[company.id] = buildRoleDirectory(index, company.id, now, rawIndex.roleDirectories?.[company.id]);
    }

    return index;
  }

  private async migrateLegacyStateUnlocked(state: LegacyHivewardStoreState): Promise<HivewardStoreIndex> {
    const now = new Date().toISOString();
    const companies = normalizeCompanies(state.companies, now);
    const primaryCompanyId = companies[0]?.id ?? defaultCompanyId;
    const selectedCompanyId = normalizeSelectedCompanyId(state.selectedCompanyId, companies, primaryCompanyId);
    const normalizedBlueprints = Array.isArray(state.blueprints)
      ? state.blueprints.map((blueprint) => stripRemovedBlueprintNodes({
          ...blueprint,
          companyId: readScopedCompanyId(blueprint.companyId, primaryCompanyId)
        }))
      : createDefaultBlueprints(now, primaryCompanyId);
    const blueprintCompanyIds = new Map(normalizedBlueprints.map((blueprint) => [blueprint.id, blueprint.companyId]));
    const normalizedRuns = Array.isArray(state.blueprintRuns)
      ? state.blueprintRuns.map((run) => ({
          ...run,
          companyId: readScopedCompanyId(run.companyId ?? blueprintCompanyIds.get(run.blueprintId), primaryCompanyId)
        }))
      : [];
    const nodeRuns = Array.isArray(state.nodeRuns) ? state.nodeRuns : [];
    const events = Array.isArray(state.events) ? state.events : [];
    const index: HivewardStoreIndex = {
      schema: storeIndexSchema,
      companies,
      selectedCompanyId,
      blueprintIndex: normalizedBlueprints.map(toBlueprintIndexEntry),
      runIndex: normalizedRuns.map((run) => {
        const blueprint = normalizedBlueprints.find((candidate) => candidate.id === run.blueprintId);
        return toBlueprintRunSummary(run, blueprint);
      }),
      catalogSnapshot: state.catalogSnapshot,
      companyDashboards: normalizeCompanyDashboards(state.companyDashboards, companies, now),
      roleDirectories: {},
      inboxItems: normalizeInboxItems(state.inboxItems, companies, now),
      iterationSessions: normalizeArray<IterationSession>(state.iterationSessions),
      iterationRounds: normalizeArray<IterationRound>(state.iterationRounds),
      approvalRequests: normalizeArray<ApprovalRequest>(state.approvalRequests),
      approvalDecisions: normalizeArray<ApprovalDecision>(state.approvalDecisions),
      artifacts: normalizeArray<Artifact>(state.artifacts),
      releaseReports: normalizeArray<ReleaseReport>(state.releaseReports),
      agentHumanReports: normalizeArray<AgentHumanReport>(state.agentHumanReports),
      agentHandoffs: normalizeArray<AgentHandoff>(state.agentHandoffs),
      managerContextSnapshots: normalizeArray<ManagerContextSnapshot>(state.managerContextSnapshots),
      runTimeline: normalizeArray<RunTimelineItem>(state.runTimeline),
      managerMail: normalizeArray<ManagerMail>(state.managerMail)
    };
    for (const company of companies) {
      index.roleDirectories[company.id] = buildRoleDirectory(index, company.id, now, state.roleDirectories?.[company.id]);
    }

    await Promise.all(normalizedBlueprints.map((blueprint) => this.writeBlueprintUnlocked(blueprint)));
    for (const run of index.runIndex) {
      const blueprint = normalizedBlueprints.find((candidate) => candidate.id === run.blueprintId) ?? createArchivePlaceholderBlueprint(run, now);
      const archiveNodeRuns = nodeRuns.filter((nodeRun) => nodeRun.blueprintRunId === run.id);
      const archive = normalizeRunArchiveRuntimeRefs({
        schema: blueprintRunArchiveSchema,
        run,
        blueprintSnapshot: blueprint,
        nodeRuns: archiveNodeRuns,
        events: events.filter((event) => event.blueprintRunId === run.id),
        finalResult: resolveFinalRunResult(blueprint, archiveNodeRuns, run.status)
      });
      await this.writeRunArchiveUnlocked(archive);
    }
    return index;
  }

  private getRunViewFromArchive(archive: BlueprintRunArchive, index: HivewardStoreIndex): BlueprintRunView {
    const runId = archive.run.id;
    return {
      run: archive.run,
      nodeRuns: archive.nodeRuns,
      events: archive.events,
      finalResult: archive.finalResult,
      iterationSessions: index.iterationSessions.filter((item) => item.runId === runId),
      iterationRounds: index.iterationRounds.filter((item) => item.runId === runId),
      approvalRequests: index.approvalRequests.filter((item) => item.runId === runId),
      approvalDecisions: index.approvalDecisions.filter((item) =>
        index.approvalRequests.some((request) => request.runId === runId && request.id === item.approvalRequestId)
      ),
      artifacts: index.artifacts.filter((item) => item.runId === runId),
      releaseReports: index.releaseReports.filter((item) => item.runId === runId),
      agentHumanReports: index.agentHumanReports.filter((item) => item.runId === runId),
      agentHandoffs: index.agentHandoffs.filter((item) => item.runId === runId),
      managerContextSnapshots: index.managerContextSnapshots.filter((item) => item.runId === runId),
      runTimeline: index.runTimeline
        .filter((item) => item.runId === runId)
        .sort((left, right) => left.sequence - right.sequence),
      managerMail: index.managerMail.filter((item) => item.relatedRunId === runId)
    };
  }

  private buildCompanyOverviews(index: HivewardStoreIndex): CompanyOverview[] {
    return index.companies.map((company) => {
      const blueprints = index.blueprintIndex.filter((blueprint) => blueprint.companyId === company.id);
      const runs = index.runIndex.filter((run) => run.companyId === company.id);
      const pendingInboxCount = (index.inboxItems[company.id] ?? []).filter((item) => item.status === "pending").length;
      const dashboard = index.companyDashboards[company.id] ?? createDefaultWorkspaceDashboard(new Date().toISOString());
      return {
        ...company,
        blueprintCount: blueprints.length,
        runCount: runs.length,
        totalTokens: runs.reduce((sum, run) => sum + run.totalInputTokens + run.totalOutputTokens, 0),
        totalCostUsd: Number(runs.reduce((sum, run) => sum + run.totalCostUsd, 0).toFixed(6)),
        dashboardWidgetCount: dashboard.dashboardWidgets.length,
        savedViewCount: dashboard.savedViews.length,
        noteCount: dashboard.notes.length,
        activeApprovalCount: runs.filter((run) => run.status === "waiting_approval").length + pendingInboxCount,
        latestRunAt: maxTimestamp(runs.map((run) => run.endedAt ?? run.startedAt))
      };
    });
  }

  private getCurrentCompanyId(index: HivewardStoreIndex): string | undefined {
    return index.selectedCompanyId ?? undefined;
  }

  private requireSelectedCompanyId(index: HivewardStoreIndex): string {
    const companyId = this.getCurrentCompanyId(index);
    if (!companyId) {
      throw new Error("No company selected.");
    }
    return companyId;
  }
}

const removedStandaloneBlueprintNodeTypes = new Set(["approval", "send", "parallel_agents"]);

export function stripRemovedBlueprintNodes(blueprint: BlueprintDefinition): BlueprintDefinition {
  const nodes = blueprint.nodes.filter((node) => !isRemovedStandaloneBlueprintNodeType(node.type));
  if (nodes.length === blueprint.nodes.length) return blueprint;

  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...blueprint,
    nodes,
    edges: blueprint.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  };
}

export function stripRemovedBlueprintRunArchive(archive: BlueprintRunArchive): BlueprintRunArchive {
  const blueprintSnapshot = stripRemovedBlueprintNodes(archive.blueprintSnapshot);
  const snapshotNodeIds = new Set(blueprintSnapshot.nodes.map((node) => node.id));
  const nodeRuns = archive.nodeRuns.filter((nodeRun) =>
    !isRemovedStandaloneBlueprintNodeType(nodeRun.nodeType) &&
    (snapshotNodeIds.size === 0 || snapshotNodeIds.has(nodeRun.nodeId))
  );
  const nodeRunIds = new Set(nodeRuns.map((nodeRun) => nodeRun.id));
  const events = archive.events.filter((event) => !event.nodeRunId || nodeRunIds.has(event.nodeRunId));
  return {
    ...archive,
    blueprintSnapshot,
    nodeRuns,
    events,
    finalResult: resolveFinalRunResult(blueprintSnapshot, nodeRuns, archive.run.status)
  };
}

function normalizeRunArchiveRuntimeRefs(archive: BlueprintRunArchive): BlueprintRunArchive {
  const legacyArchive = archive as RunArchiveWithLegacyRuntimeRefs;
  const runWithLegacyRefs = legacyArchive.run;
  const { openclawRefs: _legacyRunRefs, ...runWithoutLegacyRefs } = runWithLegacyRefs;
  const nodeRuns = Array.isArray(legacyArchive.nodeRuns)
    ? legacyArchive.nodeRuns.map((nodeRun) => {
        const { openclawRef: _legacyRuntimeRef, ...nodeRunWithoutLegacyRef } = nodeRun;
        const runtimeRef = readLegacyNodeRunRuntimeRef(nodeRun);
        return runtimeRef ? { ...nodeRunWithoutLegacyRef, runtimeRef } : nodeRunWithoutLegacyRef;
      })
    : [];
  const events = Array.isArray(legacyArchive.events)
    ? legacyArchive.events.map((event) => {
        const { openclawRef: _legacyRuntimeRef, ...eventWithoutLegacyRef } = event;
        const runtimeRef = readLegacyNodeEventRuntimeRef(event);
        return runtimeRef ? { ...eventWithoutLegacyRef, runtimeRef } : eventWithoutLegacyRef;
      })
    : [];
  const runtimeRefs = mergeRuntimeRefs(
    readLegacyRunRuntimeRefs(runWithLegacyRefs),
    nodeRuns.flatMap((nodeRun) => {
      const runtimeRef = readBlueprintNodeRunRuntimeRef(nodeRun);
      return runtimeRef ? [runtimeRef] : [];
    })
  );
  return {
    ...archive,
    run: {
      ...runWithoutLegacyRefs,
      runtimeRefs
    },
    nodeRuns,
    events
  };
}

function readLegacyNodeRunRuntimeRef(nodeRun: BlueprintNodeRun & LegacyRuntimeRefFields): RuntimeObjectRef | undefined {
  return nodeRun.runtimeRef ?? nodeRun.openclawRef;
}

function readLegacyNodeEventRuntimeRef(event: BlueprintNodeEvent & LegacyRuntimeRefFields): RuntimeObjectRef | undefined {
  return event.runtimeRef ?? event.openclawRef;
}

function readLegacyRunRuntimeRefs(run: BlueprintRunSummary & LegacyRuntimeRefsField): RuntimeObjectRef[] {
  return run.runtimeRefs ?? run.openclawRefs ?? [];
}

function mergeRuntimeRefs(...groups: RuntimeObjectRef[][]): RuntimeObjectRef[] {
  const refs = new Map<string, RuntimeObjectRef>();
  for (const runtimeRef of groups.flat()) {
    refs.set(runtimeRefKey(runtimeRef), runtimeRef);
  }
  return [...refs.values()];
}

function runtimeRefKey(runtimeRef: RuntimeObjectRef): string {
  return [
    runtimeRef.source,
    runtimeRef.sourceId,
    runtimeRef.taskId ?? "",
    runtimeRef.runId ?? "",
    runtimeRef.sessionKey ?? ""
  ].join(":");
}

function isRemovedStandaloneBlueprintNodeType(type: unknown): boolean {
  return typeof type === "string" && removedStandaloneBlueprintNodeTypes.has(type);
}

function normalizeCompanies(value: unknown, now: string): CompanyProfile[] {
  return Array.isArray(value) && value.length > 0
    ? (value as CompanyProfile[]).map((company) => normalizeCompany(company, now))
    : createDefaultCompanies(now);
}

function extractLegacyChatState(value: LegacyHivewardStoreState): LegacyHivewardChatState | undefined {
  if (!Object.hasOwn(value, "chatSessions") && !Object.hasOwn(value, "chatMessages")) return undefined;
  return {
    chatSessions: value.chatSessions,
    chatMessages: value.chatMessages
  };
}

function normalizeCompanyDashboards(
  value: unknown,
  companies: CompanyProfile[],
  now: string
): Record<string, WorkspaceDashboard> {
  const companyDashboards: Record<string, WorkspaceDashboard> = {};
  for (const company of companies) {
    const rawDashboard = isRecord(value) ? value[company.id] : undefined;
    companyDashboards[company.id] = normalizeWorkspaceDashboard(rawDashboard as Partial<WorkspaceDashboard> | undefined, now);
  }
  return companyDashboards;
}

function normalizeInboxItems(value: unknown, companies: CompanyProfile[], now: string): Record<string, InboxItem[]> {
  const inboxItems: Record<string, InboxItem[]> = {};
  for (const company of companies) {
    const companyItems = isRecord(value) ? value[company.id] : undefined;
    const rawItems: unknown[] = Array.isArray(companyItems) ? companyItems : [];
    inboxItems[company.id] = rawItems.flatMap((item) => {
      if (!isRecord(item)) return [];
      const id = readString(item.id) ?? `inbox-${nanoid(8)}`;
      const type = normalizeInboxItemType(item.type);
      const status = item.status === "approved" || item.status === "rejected" ? item.status : "pending";
      const title = readString(item.title) ?? "Inbox item";
      const summary = readString(item.summary) ?? "";
      return [{
        id,
        companyId: company.id,
        type,
        status,
        title,
        summary,
        createdByRoleId: readString(item.createdByRoleId) ?? "ceo",
        targetRoleId: readString(item.targetRoleId),
        blueprintId: readString(item.blueprintId),
        blueprintName: readString(item.blueprintName),
        payload: isRecord(item.payload) ? item.payload : undefined,
        createdAt: readString(item.createdAt) ?? now,
        updatedAt: readString(item.updatedAt) ?? now,
        decidedAt: readString(item.decidedAt),
        decisionComment: readString(item.decisionComment),
        replies: normalizeInboxItemReplies(item.replies)
      }];
    });
  }
  return inboxItems;
}

function normalizeInboxItemReplies(value: unknown): InboxItem["replies"] {
  if (!Array.isArray(value)) return undefined;
  const replies = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = readString(item.id);
    const body = readString(item.body);
    const createdAt = readString(item.createdAt);
    if (!id || !body || !createdAt) return [];
    return [{ id, role: "user" as const, body, createdAt }];
  });
  return replies.length ? replies : undefined;
}

function normalizeInboxItemType(value: unknown): InboxItemType {
  if (
    value === "leader_delegation" ||
    value === "blueprint_proposal" ||
    value === "run_request" ||
    value === "report" ||
    value === "company_config"
  ) {
    return value;
  }
  return "report";
}

function normalizeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function upsertById<T extends { id: string }>(items: T[], item: T): void {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) {
    items[index] = item;
  } else {
    items.push(item);
  }
}

function nextTimelineSequence(items: RunTimelineItem[], runId: string): number {
  return items
    .filter((item) => item.runId === runId)
    .reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
}
function normalizeChatRoleScope(value: unknown): ChatRoleScope | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role === "leader" ? "leader" : value.role === "ceo" ? "ceo" : undefined;
  if (!role) return undefined;
  return {
    companyId: readString(value.companyId),
    role,
    leaderId: readString(value.leaderId),
    blueprintId: readString(value.blueprintId)
  };
}

function normalizeChatRoleScopeForCompany(value: unknown, companyId: string): ChatRoleScope | undefined {
  const scope = normalizeChatRoleScope(value);
  return scope ? { ...scope, companyId } : undefined;
}

function normalizeChatRoleScopeForSelectedCompany(
  index: HivewardStoreIndex,
  companyId: string,
  value: unknown,
  now: string
): ChatRoleScope | undefined {
  const scope = normalizeChatRoleScopeForCompany(value, companyId);
  if (!scope) return undefined;
  if (scope.role === "ceo") {
    return {
      companyId,
      role: "ceo",
      blueprintId: readCompanyBlueprintId(index, companyId, scope.blueprintId)
    };
  }

  const roles = buildRoleDirectory(index, companyId, now, index.roleDirectories[companyId]);
  const leader = roles.leaders.find((candidate) => candidate.id === scope.leaderId || candidate.blueprintId === scope.blueprintId);
  if (!leader) return undefined;
  return {
    companyId,
    role: "leader",
    leaderId: leader.id,
    blueprintId: leader.blueprintId
  };
}

function readCompanyBlueprintId(index: HivewardStoreIndex, companyId: string, blueprintId: string | undefined): string | undefined {
  if (!blueprintId) return undefined;
  return index.blueprintIndex.some((blueprint) => blueprint.companyId === companyId && blueprint.id === blueprintId)
    ? blueprintId
    : undefined;
}

export function buildRoleDirectory(
  index: HivewardStoreIndex,
  companyId: string,
  now: string,
  rawDirectory?: Partial<CompanyRoleDirectory>
): CompanyRoleDirectory {
  const company = index.companies.find((candidate) => candidate.id === companyId);
  const sourceDirectory = rawDirectory ?? index.roleDirectories[companyId];
  const existingCeo = sourceDirectory?.ceo;
  const previousDriverBindings = Array.isArray(sourceDirectory?.driverBindings) ? sourceDirectory.driverBindings : [];
  const ceoId = existingCeo?.id || "ceo";
  const ceoLabel = existingCeo?.label || "CEO";
  const driverBindings: RoleDriverBinding[] = [];
  const ceoDriverBinding = buildRoleDriverBinding({
    companyId,
    roleId: ceoId,
    roleLabel: ceoLabel,
    roleSource: existingCeo,
    previousDriverBindings,
    now
  });
  driverBindings.push(ceoDriverBinding);
  const ceo: CompanyRoleProfile = {
    id: ceoId,
    companyId,
    kind: "ceo",
    label: ceoLabel,
    description: existingCeo?.description || `Company-level command role for ${company?.name ?? companyId}.`,
    defaultDriverBindingId: ceoDriverBinding.id,
    capabilities: ["read_company", "discuss", "delegate_leader", "submit_inbox"],
    instructions: existingCeo?.instructions,
    createdAt: existingCeo?.createdAt || now,
    updatedAt: now
  };
  const previousLeaders = Array.isArray(sourceDirectory?.leaders) ? sourceDirectory.leaders : [];
  const blueprints = index.blueprintIndex
    .filter((blueprint) => blueprint.companyId === companyId)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
  const leaders = blueprints.map((blueprint) => {
    const existing =
      previousLeaders.find((leader) => leader.blueprintId === blueprint.id) ??
      previousLeaders.find((leader) => leader.id === `leader-${safeRoleIdSegment(blueprint.id)}`);
    const leaderId = existing?.id || `leader-${safeRoleIdSegment(blueprint.id)}`;
    const leaderLabel = existing?.label || `${blueprint.name} Leader`;
    const leaderDriverBinding = buildRoleDriverBinding({
      companyId,
      roleId: leaderId,
      roleLabel: leaderLabel,
      roleSource: existing,
      previousDriverBindings,
      now
    });
    driverBindings.push(leaderDriverBinding);
    return {
      id: leaderId,
      companyId,
      kind: "leader",
      label: leaderLabel,
      description: existing?.description || `Leader role bound to ${blueprint.name}.`,
      blueprintId: blueprint.id,
      defaultDriverBindingId: leaderDriverBinding.id,
      capabilities: ["read_blueprint", "discuss", "create_blueprint_proposal", "submit_inbox"],
      instructions: existing?.instructions,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    } satisfies CompanyRoleProfile;
  });

  const roleIds = new Set([ceo.id, ...leaders.map((leader) => leader.id)]);

  return {
    companyId,
    ceo,
    leaders,
    driverBindings,
    architecturePositions: pruneArchitecturePositions(sourceDirectory?.architecturePositions ?? {}, roleIds),
    updatedAt: now
  };
}

function buildRoleDriverBinding(input: {
  companyId: string;
  roleId: string;
  roleLabel: string;
  roleSource?: unknown;
  previousDriverBindings: RoleDriverBinding[];
  now: string;
}): RoleDriverBinding {
  const source = isRecord(input.roleSource) ? input.roleSource : {};
  const requestedBindingId = readString(source.defaultDriverBindingId);
  const existing =
    (requestedBindingId ? input.previousDriverBindings.find((binding) => binding.id === requestedBindingId) : undefined) ??
    input.previousDriverBindings.find((binding) => binding.roleId === input.roleId);
  const id = existing?.id ?? requestedBindingId ?? `driver-${safeRoleIdSegment(input.roleId)}-default`;

  return {
    id,
    companyId: input.companyId,
    roleId: input.roleId,
    harnessId: normalizeRoleDriverHarnessId(existing?.harnessId ?? source.harnessId),
    label: existing?.label || `${input.roleLabel} default driver`,
    agentId: existing?.agentId ?? readString(source.defaultAgentId),
    modelId: existing?.modelId ?? readString(source.modelId),
    workspacePath: existing?.workspacePath ?? readString(source.workspacePath),
    createdAt: existing?.createdAt || input.now,
    updatedAt: input.now
  };
}

function normalizeRoleDriverHarnessId(value: unknown): RoleDriverBinding["harnessId"] {
  return value === "codex" || value === "claude" || value === "openclaw" || value === "google" || value === "cursor" || value === "opencode" || value === "hermes"
    ? value
    : "openclaw";
}

export function buildArchitectureBlueprintView(
  index: HivewardStoreIndex,
  companyId: string,
  roles: CompanyRoleDirectory
): ArchitectureBlueprintView {
  const companyRuns = index.runIndex.filter((run) => run.companyId === companyId);
  const companyInbox = index.inboxItems[companyId] ?? [];
  const pendingInboxCount = companyInbox.filter((item) => item.status === "pending").length;
  const ceoNode = {
    id: roles.ceo.id,
    roleId: roles.ceo.id,
    kind: "ceo" as const,
    label: roles.ceo.label,
    pendingApprovalCount: pendingInboxCount + companyRuns.filter((run) => run.status === "waiting_approval").length,
    latestRunStatus: latestRun(companyRuns)?.status,
    latestRunAt: latestRun(companyRuns)?.startedAt,
    position: roles.architecturePositions?.[roles.ceo.id] ?? { x: 0, y: 0 }
  };
  const leaderSpacing = 280;
  const leaders = roles.leaders.map((leader, indexOffset) => {
    const blueprint = leader.blueprintId
      ? index.blueprintIndex.find((candidate) => candidate.companyId === companyId && candidate.id === leader.blueprintId)
      : undefined;
    const runs = leader.blueprintId ? companyRuns.filter((run) => run.blueprintId === leader.blueprintId) : [];
    const latest = latestRun(runs);
    return {
      id: leader.id,
      roleId: leader.id,
      kind: "leader" as const,
      label: leader.label,
      blueprintId: leader.blueprintId,
      blueprintName: blueprint?.name,
      pendingApprovalCount:
        runs.filter((run) => run.status === "waiting_approval").length +
        companyInbox.filter((item) => item.status === "pending" && item.blueprintId === leader.blueprintId).length,
      latestRunStatus: latest?.status,
      latestRunAt: latest?.startedAt,
      lastImportAt: blueprint?.updatedAt,
      position: roles.architecturePositions?.[leader.id] ?? {
        x: (indexOffset - (roles.leaders.length - 1) / 2) * leaderSpacing,
        y: 220
      }
    };
  });

  return {
    companyId,
    rootRoleId: roles.ceo.id,
    nodes: [ceoNode, ...leaders],
    edges: leaders.map((leader) => ({
      id: `${roles.ceo.id}-${leader.id}`,
      source: roles.ceo.id,
      target: leader.id,
      label: "delegates"
    })),
    updatedAt: roles.updatedAt
  };
}

function pruneArchitecturePositions(
  positions: Record<string, ArchitectureNodePosition>,
  roleIds: Set<string>
): Record<string, ArchitectureNodePosition> {
  const nextPositions: Record<string, ArchitectureNodePosition> = {};
  for (const [roleId, position] of Object.entries(positions)) {
    if (!roleIds.has(roleId)) continue;
    const normalizedPosition = normalizeArchitecturePosition(position);
    if (normalizedPosition) {
      nextPositions[roleId] = normalizedPosition;
    }
  }
  return nextPositions;
}

function normalizeArchitecturePosition(value: unknown): ArchitectureNodePosition | undefined {
  if (!isRecord(value)) return undefined;
  const x = value.x;
  const y = value.y;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return undefined;
  return {
    x,
    y
  };
}

function latestRun(runs: BlueprintRunSummary[]): BlueprintRunSummary | undefined {
  return runs
    .slice()
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())[0];
}

function createInboxItem(input: {
  companyId: string;
  type: InboxItemType;
  title: string;
  summary: string;
  createdByRoleId: string;
  targetRoleId?: string;
  blueprintId?: string;
  blueprintName?: string;
  payload?: Record<string, unknown>;
  now: string;
}): InboxItem {
  return {
    id: `inbox-${nanoid(10)}`,
    companyId: input.companyId,
    type: input.type,
    status: "pending",
    title: input.title,
    summary: input.summary,
    createdByRoleId: input.createdByRoleId,
    targetRoleId: input.targetRoleId,
    blueprintId: input.blueprintId,
    blueprintName: input.blueprintName,
    payload: input.payload,
    createdAt: input.now,
    updatedAt: input.now
  };
}

function readBlueprintPackagePayload(value: unknown): PortableBlueprintPackage | undefined {
  if (!value) return undefined;
  try {
    return readPortableBlueprintPackage(value);
  } catch {
    return undefined;
  }
}

function inferLeaderRoleId(roles: CompanyRoleDirectory, blueprintId: string | undefined): string | undefined {
  if (!blueprintId) return undefined;
  return roles.leaders.find((leader) => leader.blueprintId === blueprintId)?.id;
}

function safeRoleIdSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || nanoid(8);
}

function normalizeBlueprintIndexEntry(
  entry: BlueprintIndexEntry,
  fallbackCompanyId: string,
  now: string
): BlueprintIndexEntry {
  return {
    id: entry.id,
    companyId: readScopedCompanyId(entry.companyId, fallbackCompanyId),
    name: entry.name,
    description: entry.description,
    version: entry.version,
    createdAt: entry.createdAt || now,
    updatedAt: entry.updatedAt || now
  };
}

function normalizeRunSummary(run: BlueprintRunSummary, fallbackCompanyId: string): BlueprintRunSummary {
  const runWithLegacyRefs = run as BlueprintRunSummary & LegacyRuntimeRefsField;
  const { openclawRefs: _legacyRefs, ...runWithoutLegacyRefs } = runWithLegacyRefs;
  return {
    ...runWithoutLegacyRefs,
    companyId: readScopedCompanyId(run.companyId, fallbackCompanyId),
    blueprintName: run.blueprintName || run.blueprintId,
    runtimeRefs: readLegacyRunRuntimeRefs(runWithLegacyRefs)
  };
}

export function toBlueprintIndexEntry(blueprint: BlueprintDefinition): BlueprintIndexEntry {
  return {
    id: blueprint.id,
    companyId: blueprint.companyId,
    name: blueprint.name,
    description: blueprint.description,
    version: blueprint.version,
    createdAt: blueprint.createdAt,
    updatedAt: blueprint.updatedAt
  };
}

export function toBlueprintRunSummary(run: BlueprintRun, blueprint?: BlueprintDefinition): BlueprintRunSummary {
  return {
    ...run,
    blueprintName: run.blueprintName ?? blueprint?.name ?? run.blueprintId
  };
}

export function applyNodeRunFactsToRun(run: BlueprintRunSummary, nodeRuns: BlueprintNodeRun[]): BlueprintRunSummary {
  const usage = nodeRuns.flatMap((nodeRun) => (nodeRun.usage ? [nodeRun.usage] : []));
  const runtimeRefs = nodeRuns.flatMap((nodeRun) => {
    const runtimeRef = readBlueprintNodeRunRuntimeRef(nodeRun);
    return runtimeRef ? [runtimeRef] : [];
  });
  return {
    ...run,
    totalInputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
    totalOutputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
    totalCostUsd: Number(usage.reduce((sum, item) => sum + item.costUsd, 0).toFixed(6)),
    runtimeRefs
  };
}

function createArchivePlaceholderBlueprint(run: BlueprintRunSummary, now: string): BlueprintDefinition {
  return {
    id: run.blueprintId,
    companyId: run.companyId,
    name: run.blueprintName,
    version: run.blueprintVersion,
    nodes: [],
    edges: [],
    variables: {},
    display: {},
    createdAt: run.startedAt || now,
    updatedAt: run.endedAt ?? run.startedAt ?? now
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readPendingApprovalReplies(value: unknown, selectedReplyId?: string): PendingApprovalItem["replies"] {
  if (!Array.isArray(value)) return undefined;
  const replies = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = readString(item.id);
    const role: "assistant" | "user" | undefined =
      item.role === "assistant" || item.role === "user" ? item.role : undefined;
    const body = readString(item.body);
    const createdAt = readString(item.createdAt);
    if (!id || !role || !body || !createdAt) return [];
    return [{ id, role, body, createdAt, ...(selectedReplyId === id ? { selected: true } : {}) }];
  });
  return replies.length ? replies : undefined;
}

function readPendingApprovalUpstream(input: unknown): PendingApprovalItem["upstream"] {
  if (!isRecord(input) || !Array.isArray(input.upstream)) return undefined;

  const upstream = input.upstream.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const nodeId = readString(candidate.nodeId);
    const nodeLabel = readString(candidate.nodeLabel);
    const nodeRunId = readString(candidate.nodeRunId);
    if (!nodeId || !nodeLabel || !nodeRunId) return [];
    return [
      {
        nodeId,
        nodeLabel,
        nodeRunId,
        output: candidate.output
      }
    ];
  });

  return upstream.length ? upstream : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function buildBlueprintEntryMarkdown(blueprint: BlueprintDefinition): string {
  const name = slugifyBlueprintName(blueprint.name || blueprint.id);
  const description = blueprint.description?.trim() || `Use when running the ${blueprint.name || blueprint.id} blueprint.`;
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `version: ${blueprint.version}`,
    `primaryBlueprintId: ${blueprint.id}`,
    "---",
    "",
    `# ${blueprint.name || blueprint.id}`,
    "",
    description,
    ""
  ].join("\n");
}

function buildBlueprintWorkspaceManifest(blueprint: BlueprintDefinition): Record<string, unknown> {
  const description = blueprint.description?.trim() || `Use when running the ${blueprint.name || blueprint.id} blueprint.`;
  return {
    schema: "hiveward.blueprint-bundle/v1",
    kind: "blueprint_exposure",
    id: blueprint.id,
    name: slugifyBlueprintName(blueprint.name || blueprint.id),
    label: blueprint.name,
    description,
    aliases: [],
    intentTags: [],
    triggerPhrases: [],
    notFor: [],
    inputs: [],
    outputs: [],
    runModes: ["draft", "approval_required"],
    permissions: ["read_only"],
    sideEffects: [],
    requiredResources: {
      skills: [],
      scripts: [],
      mcp: []
    },
    ownerRole: "leader",
    primaryBlueprintId: blueprint.id,
    blueprints: [blueprint.id],
    createdAt: blueprint.createdAt,
    updatedAt: blueprint.updatedAt
  };
}

function mergeBlueprintWorkspaceManifest(
  baseManifest: Record<string, unknown>,
  existingManifest: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!existingManifest) return baseManifest;
  const baseResources = isPlainObject(baseManifest.requiredResources) ? baseManifest.requiredResources : {};
  const existingResources = isPlainObject(existingManifest.requiredResources) ? existingManifest.requiredResources : {};
  const mergedManifest: Record<string, unknown> = {
    ...existingManifest,
    ...baseManifest
  };
  for (const field of blueprintExposureMetadataFields) {
    if (existingManifest[field] !== undefined) {
      mergedManifest[field] = existingManifest[field];
    }
  }
  return {
    ...mergedManifest,
    requiredResources: {
      ...baseResources,
      skills: mergeStringArrays(baseResources.skills, existingResources.skills),
      scripts: mergeStringArrays(baseResources.scripts, existingResources.scripts),
      mcp: mergeStringArrays(baseResources.mcp, existingResources.mcp)
    },
    skillSources: readRecordArray(existingManifest.skillSources)
  };
}

const blueprintExposureMetadataFields = [
  "aliases",
  "intentTags",
  "triggerPhrases",
  "notFor",
  "inputs",
  "outputs",
  "runModes",
  "permissions",
  "sideEffects"
];

function mergeStringArrays(left: unknown, right: unknown): string[] {
  return [...new Set([...readStringArray(left), ...readStringArray(right)])].sort();
}

function slugifyBlueprintName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "blueprint";
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

async function classifySkillSource(sourcePath: string, sourceIsDirectory: boolean): Promise<SkillSourceCompleteness> {
  const name = basename(sourcePath).toLowerCase();
  if (sourceIsDirectory) return await isReadableFile(join(sourcePath, "SKILL.md")) ? "full_package" : "unknown";
  if (name === "skill.md") return "partial_package";
  return extname(name) === ".md" ? "markdown_only" : "unknown";
}

async function copySkillPackageParts(sourcePath: string, targetPath: string): Promise<void> {
  if (await isReadableFile(join(sourcePath, "SKILL.md"))) {
    await cp(join(sourcePath, "SKILL.md"), join(targetPath, "SKILL.md"));
  }
  for (const folder of ["references", "scripts", "assets", "agents"]) {
    const sourceFolder = join(sourcePath, folder);
    if (await isReadableDirectory(sourceFolder)) {
      await cp(sourceFolder, join(targetPath, folder), { recursive: true });
    }
  }
}

async function assertSkillPackagePartsContainNoSymlinks(sourcePath: string): Promise<void> {
  await assertPathContainsNoSymlinks(join(sourcePath, "SKILL.md"), sourcePath);
  for (const folder of ["references", "scripts", "assets", "agents"]) {
    await assertPathContainsNoSymlinks(join(sourcePath, folder), sourcePath);
  }
}

async function assertPathContainsNoSymlinks(path: string, rootPath: string): Promise<void> {
  let pathStat;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
  if (pathStat.isSymbolicLink()) {
    const relativePath = toPosixPath(relative(rootPath, path)) || basename(path);
    throw new Error(`Skill source snapshots do not support symbolic links: ${relativePath}`);
  }
  if (!pathStat.isDirectory()) return;

  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    await assertPathContainsNoSymlinks(join(path, entry.name), rootPath);
  }
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files = await walkFiles(root);
  return files
    .map((file) => toPosixPath(relative(root, file)))
    .sort((left, right) => left.localeCompare(right));
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill source snapshots do not support symbolic links: ${childPath}`);
    } else if (entry.isDirectory()) {
      files.push(...await walkFiles(childPath));
    } else if (entry.isFile()) {
      files.push(childPath);
    }
  }
  return files;
}

async function hashRelativeFiles(root: string, files: string[]): Promise<Record<string, string>> {
  const fileHashes: Record<string, string> = {};
  for (const file of files) {
    fileHashes[file] = await hashFile(join(root, file));
  }
  return fileHashes;
}

async function buildScriptInventory(root: string, files: string[]): Promise<BlueprintSkillSourceSnapshot["scriptInventory"]> {
  const scripts = files.filter((file) => file.startsWith("scripts/"));
  return Promise.all(scripts.map(async (path) => {
    const absolutePath = join(root, path);
    const scriptStat = await stat(absolutePath);
    return {
      path,
      runtime: inferScriptRuntime(path),
      sizeBytes: scriptStat.size,
      sha256: await hashFile(absolutePath),
      shouldExecuteByDefault: false
    };
  }));
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function validateSkillIrScriptPaths(skillSourcePath: string, skillIr: unknown): void {
  if (!isPlainObject(skillIr) || !Array.isArray(skillIr.scripts)) return;
  for (const script of skillIr.scripts) {
    if (!isPlainObject(script) || typeof script.path !== "string") continue;
    assertBlueprintRelativePath(skillSourcePath, script.path, `Skill IR script path ${script.path}`);
  }
}

function assertBlueprintRelativePath(root: string, path: string, label: string): void {
  if (isAbsolute(path)) {
    throw new Error(`${label} must be relative to the blueprint skill source workspace.`);
  }
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);
  if (!relativePath || relativePath.split(/[\\/]/)[0] === ".." || isAbsolute(relativePath)) {
    throw new Error(`${label} resolves outside the blueprint skill source workspace.`);
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function inferScriptRuntime(path: string): "node" | "python" | "bash" | "unknown" {
  const extension = extname(path).toLowerCase();
  if (extension === ".mjs" || extension === ".js" || extension === ".cjs" || extension === ".ts") return "node";
  if (extension === ".py") return "python";
  if (extension === ".sh" || extension === ".bash" || extension === ".zsh") return "bash";
  return "unknown";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function readAgentRuntimeId(value: unknown): AgentRuntimeId | undefined {
  return value === "openclaw" || value === "codex" || value === "claude" || value === "google" || value === "cursor" || value === "opencode" || value === "hermes"
    ? value
    : undefined;
}

function readRequiredCompanyName(value: unknown): string {
  const name = readOptionalString(value);
  if (!name) {
    throw new Error("Company name is required.");
  }
  return name;
}

function readScopedCompanyId(value: unknown, fallbackCompanyId: string): string {
  return typeof value === "string" && value ? value : fallbackCompanyId;
}

function normalizeSelectedCompanyId(
  value: unknown,
  companies: CompanyProfile[],
  fallbackCompanyId: string
): string | null {
  if (value === null) return null;
  if (typeof value === "string" && companies.some((company) => company.id === value)) {
    return value;
  }
  return fallbackCompanyId;
}

function normalizeCompany(company: CompanyProfile, now: string): CompanyProfile {
  return {
    id: company.id,
    name: company.name,
    logoUrl: company.logoUrl,
    logoLabel: company.logoLabel,
    businessGoal: company.businessGoal,
    createdAt: company.createdAt || now,
    updatedAt: company.updatedAt || now
  };
}

function maxTimestamp(values: Array<string | undefined>): string | undefined {
  const normalized = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (normalized.length === 0) return undefined;
  return normalized.sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0];
}

function nextBlueprintId(blueprints: Array<{ id: string }>): string {
  const used = new Set(blueprints.map((blueprint) => blueprint.id));
  let id = `blueprint-${nanoid(8)}`;
  while (used.has(id)) {
    id = `blueprint-${nanoid(8)}`;
  }
  return id;
}

function nextCompanyId(companies: Array<{ id: string }>): string {
  const used = new Set(companies.map((company) => company.id));
  let id = `company-${nanoid(8)}`;
  while (used.has(id)) {
    id = `company-${nanoid(8)}`;
  }
  return id;
}

function nextCompanyName(companies: Array<{ name: string }>): string {
  const baseName = "New Company";
  const used = new Set(companies.map((company) => company.name.trim()).filter(Boolean));
  if (!used.has(baseName)) return baseName;

  let index = 2;
  let candidate = `${baseName} ${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${baseName} ${index}`;
  }
  return candidate;
}

function companyInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return parts
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function nextImportedBlueprintName(blueprints: Array<{ name: string }>, baseName: string): string {
  const normalizedBase = baseName.trim() || "Imported blueprint";
  const used = new Set(blueprints.map((blueprint) => blueprint.name));
  if (!used.has(normalizedBase)) return normalizedBase;

  let index = 2;
  let candidate = `${normalizedBase} (${index})`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${normalizedBase} (${index})`;
  }
  return candidate;
}

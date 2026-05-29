import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type {
  AgentHandoff,
  AgentHumanReport,
  AgentOutputEnvelope,
  AgentRuntimeId,
  ArchitectureBlueprintView,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  BlueprintDefinition,
  BlueprintImportDefaults,
  BlueprintNodeEvent,
  BlueprintNodeRun,
  BlueprintRun,
  BlueprintRunArchive,
  BlueprintRunSummary,
  BlueprintRunView,
  CatalogSnapshot,
  ChatAttachment,
  ChatRoleScope,
  CompanyOverview,
  CompanyProfile,
  CompanyRoleDirectory,
  CreateHivewardChatSessionRequest,
  HarnessId,
  HivewardChatMessage,
  HivewardChatSession,
  InboxItem,
  InboxItemType,
  IterationRound,
  IterationSession,
  ManagerContextSnapshot,
  ManagerMail,
  PortableBlueprintPackage,
  ReleaseReport,
  RoleDriverBinding,
  RunTimelineItem,
  UpdateHivewardChatSessionRequest,
  WorkspaceDashboard
} from "@hiveward/shared";
import {
  blueprintRunArchiveSchema,
  createBlankBlueprint,
  createDefaultBlueprints,
  createDefaultCompanies,
  createDefaultWorkspaceDashboard,
  defaultCompanyId,
  hydrateImportedBlueprint,
  normalizeWorkspaceDashboard,
  readBlueprintNodeEventRuntimeRef,
  readBlueprintNodeRunRuntimeRef,
  readBlueprintRunRuntimeRefs,
  readPortableBlueprintPackage,
  resolveFinalRunResult
} from "@hiveward/shared";
import {
  applyNodeRunFactsToRun,
  buildArchitectureBlueprintView,
  buildRoleDirectory,
  stripRemovedBlueprintNodes,
  stripRemovedBlueprintRunArchive,
  toBlueprintIndexEntry,
  toBlueprintRunSummary,
  type HivewardStoreIndex
} from "../fileHivewardStore";
import type {
  ApplyApprovalDecisionInput,
  ApplyApprovalDecisionResult,
  ApplyInboxDecisionInput,
  ApplyInboxDecisionResult,
  BlueprintSkillSourceSnapshot,
  CancelNodeRunInput,
  ClaimNodeRunResult,
  CompleteNodeRunInput,
  FailNodeRunInput,
  HivewardStore,
  PublishAgentOutputInput,
  PublishAgentOutputResult
} from "../hivewardStore";
import { SqliteDriver } from "./sqliteDriver";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const selectedCompanySettingKey = "selected_company_id";
const catalogSnapshotSettingKey = "catalog_snapshot";
const maxMessagesPerSession = 60;

type Row = Record<string, unknown>;

export class SqliteHivewardStore implements HivewardStore {
  private readonly sqlitePath: string;
  private readonly dataDir: string;
  private readonly blueprintWorkspacesDir: string;
  private readonly driver: SqliteDriver;
  private readonly seedDefaultsOnInit: boolean;

  constructor(sqlitePath = resolve(repositoryRoot, "data", "hiveward.sqlite"), options: { seedDefaults?: boolean } = {}) {
    this.sqlitePath = resolve(sqlitePath);
    this.dataDir = dirname(this.sqlitePath);
    this.blueprintWorkspacesDir = join(this.dataDir, "blueprint-workspaces");
    this.driver = new SqliteDriver(this.sqlitePath);
    this.seedDefaultsOnInit = options.seedDefaults ?? true;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.blueprintWorkspacesDir, { recursive: true });
    await mkdir(join(this.dataDir, "artifacts"), { recursive: true });
    this.driver.migrate();
    if (this.seedDefaultsOnInit && this.countRows("companies") === 0) {
      await this.seedDefaults();
    }
  }

  close(): void {
    this.driver.close();
  }

  recordMigrationManifest(input: {
    id: string;
    sourceRoot: string;
    backupRoot: string;
    sourceManifest: unknown;
    result: unknown;
    status: "dry_run" | "applied" | "failed";
    createdAt: string;
    completedAt?: string;
  }): void {
    this.driver.db.prepare(
      `INSERT INTO migration_manifests (
        id, source_root, backup_root, source_manifest_json, result_json, status, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        result_json = excluded.result_json,
        status = excluded.status,
        completed_at = excluded.completed_at`
    ).run(
      input.id,
      input.sourceRoot,
      input.backupRoot,
      stringifyJson(input.sourceManifest),
      stringifyJson(input.result),
      input.status,
      input.createdAt,
      input.completedAt
    );
  }

  async importFromStore(source: HivewardStore): Promise<{
    companies: number;
    blueprints: number;
    runs: number;
    nodeRuns: number;
    events: number;
    approvals: number;
    artifacts: number;
    agentHumanReports: number;
    agentHandoffs: number;
    inboxItems: number;
    chatSessions: number;
    chatMessages: number;
  }> {
    const counts = {
      companies: 0,
      blueprints: 0,
      runs: 0,
      nodeRuns: 0,
      events: 0,
      approvals: 0,
      artifacts: 0,
      agentHumanReports: 0,
      agentHandoffs: 0,
      inboxItems: 0,
      chatSessions: 0,
      chatMessages: 0
    };
    const { companies, selectedCompanyId } = await source.listCompanies();
    for (const company of companies) {
      await source.selectCompany(company.id);
      const dashboard = await source.getDashboardState();
      const { roles } = await source.getRoleDirectory();
      const blueprints = await source.listBlueprints();
      const inboxItems = await source.listInboxItems();
      const archives = await source.listRunArchives();
      const chatSessions = await source.listChatSessions();

      this.driver.transaction(() => {
        this.upsertCompany({
          id: company.id,
          name: company.name,
          logoLabel: company.logoLabel,
          logoUrl: company.logoUrl,
          businessGoal: company.businessGoal,
          createdAt: company.createdAt,
          updatedAt: company.updatedAt
        });
        this.upsertDashboard(company.id, dashboard);
        this.upsertRoleDirectory(roles);
        this.setSelectedCompanyId(company.id, new Date().toISOString());
        counts.companies += 1;

        for (const blueprint of blueprints) {
          this.upsertBlueprint(blueprint);
          counts.blueprints += 1;
        }
        for (const item of inboxItems) {
          this.upsertInboxItem(item);
          this.replaceInboxReplies(item);
          counts.inboxItems += 1;
        }
        for (const archive of archives) {
          this.importArchive(archive);
          counts.runs += 1;
          counts.nodeRuns += archive.nodeRuns.length;
          counts.events += archive.events.length;
        }
      });

      await Promise.all(blueprints.map((blueprint) => this.writeBlueprintWorkspace(blueprint)));

      for (const archive of archives) {
        const view = await source.getRunView(archive.run.id);
        if (!view) continue;
        this.driver.transaction(() => {
          for (const session of view.iterationSessions ?? []) this.upsertIterationSessionSync(session);
          for (const round of view.iterationRounds ?? []) this.upsertIterationRoundSync(round);
          for (const request of view.approvalRequests ?? []) {
            this.upsertApprovalRequestSync(request);
            counts.approvals += 1;
          }
          for (const decision of view.approvalDecisions ?? []) this.appendApprovalDecisionSync(decision);
          for (const artifact of view.artifacts ?? []) {
            this.upsertArtifactSync(artifact);
            counts.artifacts += 1;
          }
          for (const report of view.releaseReports ?? []) this.upsertReleaseReportSync(report);
          for (const report of view.agentHumanReports ?? []) {
            this.upsertAgentHumanReportSync(report);
            counts.agentHumanReports += 1;
          }
          for (const handoff of view.agentHandoffs ?? []) {
            this.upsertAgentHandoffSync(handoff);
            counts.agentHandoffs += 1;
          }
          for (const snapshot of view.managerContextSnapshots ?? []) this.upsertManagerContextSnapshotSync(snapshot);
          for (const item of view.runTimeline ?? []) this.appendRunTimelineItemSync(item);
          if (view.managerMail?.length) this.replaceManagerMailSync(view.managerMail);
        });
      }

      for (const session of chatSessions) {
        const messages = await source.listChatMessages(session.id);
        this.driver.transaction(() => {
          this.upsertChatSession(session);
          counts.chatSessions += 1;
          for (const message of messages) {
            this.upsertChatMessage(message);
            counts.chatMessages += 1;
          }
        });
      }
    }
    await source.selectCompany(selectedCompanyId);
    this.setSelectedCompanyId(selectedCompanyId ?? companies[0]?.id ?? null, new Date().toISOString());
    return counts;
  }

  async listCompanies(): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string }> {
    const index = this.readIndexSnapshot();
    return {
      companies: this.buildCompanyOverviews(index),
      selectedCompanyId: index.selectedCompanyId ?? undefined
    };
  }

  async createCompany(input: { name?: string; businessGoal?: string; logoLabel?: string; logoUrl?: string }): Promise<{
    companies: CompanyOverview[];
    selectedCompanyId?: string;
  }> {
    return this.driver.transaction(() => {
      const index = this.readIndexSnapshot();
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
      this.upsertCompany(company);
      this.setSelectedCompanyId(company.id, now);
      this.upsertDashboard(company.id, createDefaultWorkspaceDashboard(now));
      this.upsertRoleDirectory(buildRoleDirectory(this.readIndexSnapshot(), company.id, now));
      const refreshed = this.readIndexSnapshot();
      return {
        companies: this.buildCompanyOverviews(refreshed),
        selectedCompanyId: refreshed.selectedCompanyId ?? undefined
      };
    });
  }

  async updateCompany(
    companyId: string,
    input: { name?: string; businessGoal?: string; logoLabel?: string; logoUrl?: string }
  ): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string }> {
    return this.driver.transaction(() => {
      const current = this.requireCompany(companyId);
      const nextName = input.name === undefined ? current.name : requireCompanyName(input.name);
      const renamed = nextName !== current.name;
      const next: CompanyProfile = {
        ...current,
        name: nextName,
        businessGoal: input.businessGoal === undefined ? current.businessGoal : readOptionalString(input.businessGoal) ?? current.businessGoal,
        logoLabel: input.logoLabel === undefined
          ? renamed && (!current.logoLabel || current.logoLabel === companyInitials(current.name))
            ? companyInitials(nextName)
            : current.logoLabel
          : readOptionalString(input.logoLabel),
        logoUrl: input.logoUrl === undefined ? current.logoUrl : readOptionalString(input.logoUrl),
        updatedAt: new Date().toISOString()
      };
      this.upsertCompany(next);
      this.upsertRoleDirectory(buildRoleDirectory(this.readIndexSnapshot(), companyId, next.updatedAt));
      const index = this.readIndexSnapshot();
      return {
        companies: this.buildCompanyOverviews(index),
        selectedCompanyId: index.selectedCompanyId ?? undefined
      };
    });
  }

  async selectCompany(companyId?: string): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string }> {
    return this.driver.transaction(() => {
      if (companyId) this.requireCompany(companyId);
      this.setSelectedCompanyId(companyId ?? null, new Date().toISOString());
      const index = this.readIndexSnapshot();
      return {
        companies: this.buildCompanyOverviews(index),
        selectedCompanyId: index.selectedCompanyId ?? undefined
      };
    });
  }

  async deleteCompany(companyId: string): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string; deleted: boolean }> {
    return this.driver.transaction(() => {
      const existing = this.getCompany(companyId);
      if (!existing) {
        const index = this.readIndexSnapshot();
        return {
          companies: this.buildCompanyOverviews(index),
          selectedCompanyId: index.selectedCompanyId ?? undefined,
          deleted: false
        };
      }
      this.driver.db.prepare("DELETE FROM companies WHERE id = ?").run(companyId);
      const companies = this.listCompanyProfiles();
      if (this.getSelectedCompanyId() === companyId) {
        this.setSelectedCompanyId(companies[0]?.id ?? null, new Date().toISOString());
      }
      const index = this.readIndexSnapshot();
      return {
        companies: this.buildCompanyOverviews(index),
        selectedCompanyId: index.selectedCompanyId ?? undefined,
        deleted: true
      };
    });
  }

  async listBlueprints(): Promise<BlueprintDefinition[]> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return [];
    return this.selectBlueprintRows("WHERE b.company_id = ?", [companyId]).map((row) => readJson<BlueprintDefinition>(row.definition_json));
  }

  async getBlueprint(id: string): Promise<BlueprintDefinition | undefined> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return undefined;
    const row = this.driver.db.prepare(
      `SELECT bv.definition_json
       FROM blueprints b
       JOIN blueprint_versions bv ON bv.id = b.current_version_id
       WHERE b.id = ? AND b.company_id = ?`
    ).get(id, companyId) as Row | undefined;
    return row ? stripRemovedBlueprintNodes(readJson<BlueprintDefinition>(row.definition_json)) : undefined;
  }

  getBlueprintWorkspacePath(id: string): string {
    return join(this.blueprintWorkspacesDir, id);
  }

  async saveBlueprint(blueprint: BlueprintDefinition): Promise<BlueprintDefinition> {
    const saved = this.driver.transaction(() => {
      const companyId = this.requireSelectedCompanyId();
      const now = new Date().toISOString();
      const existing = this.getBlueprintIndexEntry(blueprint.id, companyId);
      const next = stripRemovedBlueprintNodes({
        ...blueprint,
        companyId,
        version: existing ? existing.version + 1 : blueprint.version,
        createdAt: existing?.createdAt ?? blueprint.createdAt ?? now,
        updatedAt: now
      });
      this.upsertBlueprint(next);
      this.upsertRoleDirectory(buildRoleDirectory(this.readIndexSnapshot(), companyId, now));
      return next;
    });
    await this.writeBlueprintWorkspace(saved);
    return saved;
  }

  async createBlueprint(input: { name?: string; description?: string } = {}): Promise<BlueprintDefinition> {
    const blueprint = this.driver.transaction(() => {
      const index = this.readIndexSnapshot();
      const companyId = this.requireSelectedCompanyId();
      const now = new Date().toISOString();
      const created = createBlankBlueprint({
        id: nextBlueprintId(index.blueprintIndex),
        companyId,
        now,
        name: input.name,
        description: input.description
      });
      this.upsertBlueprint(created);
      this.upsertRoleDirectory(buildRoleDirectory(this.readIndexSnapshot(), companyId, now));
      return created;
    });
    await this.writeBlueprintWorkspace(blueprint);
    return blueprint;
  }

  async deleteBlueprint(id: string): Promise<boolean> {
    return this.driver.transaction(() => {
      const companyId = this.getSelectedCompanyId();
      if (!companyId || !this.getBlueprintIndexEntry(id, companyId)) return false;
      this.driver.db.prepare("DELETE FROM blueprints WHERE id = ? AND company_id = ?").run(id, companyId);
      this.upsertRoleDirectory(buildRoleDirectory(this.readIndexSnapshot(), companyId, new Date().toISOString()));
      return true;
    });
  }

  async importBlueprintPackage(
    blueprintPackage: PortableBlueprintPackage,
    defaults: BlueprintImportDefaults = {}
  ): Promise<BlueprintDefinition[]> {
    const imported = this.driver.transaction(() => this.importBlueprintPackageTx(blueprintPackage, defaults));
    await Promise.all(imported.map((blueprint) => this.writeBlueprintWorkspace(blueprint)));
    return imported;
  }

  async storeBlueprintSkillSource(input: {
    blueprintId: string;
    sourcePath: string;
    sourceLabel?: string;
    skillSourceId?: string;
    skillIr?: unknown;
  }): Promise<BlueprintSkillSourceSnapshot> {
    const blueprint = await this.getBlueprint(input.blueprintId);
    if (!blueprint) throw new Error(`Blueprint not found: ${input.blueprintId}`);
    await this.writeBlueprintWorkspace(blueprint);
    const sourcePath = resolve(input.sourcePath);
    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isSymbolicLink()) throw new Error(`Skill source snapshots do not support symbolic links: ${sourcePath}`);
    const sourceIsDirectory = sourceStat.isDirectory();
    const sourceName = basename(sourcePath);
    const skillSourceId = input.skillSourceId ?? `skill-src-${nanoid(8)}`;
    const skillSourcePath = join(this.getBlueprintWorkspacePath(blueprint.id), "skills", skillSourceId);
    await rm(skillSourcePath, { recursive: true, force: true });
    await mkdir(skillSourcePath, { recursive: true });
    if (sourceIsDirectory) {
      await copySkillPackageParts(sourcePath, skillSourcePath);
    } else {
      await cp(sourcePath, join(skillSourcePath, sourceName));
    }
    if (input.skillIr !== undefined) {
      await writeJson(join(skillSourcePath, "skill-ir.json"), input.skillIr);
    }
    const capturedFiles = await listRelativeFiles(skillSourcePath);
    const fileHashes = await hashRelativeFiles(skillSourcePath, capturedFiles);
    const scriptInventory = await buildScriptInventory(skillSourcePath, capturedFiles);
    const snapshot: BlueprintSkillSourceSnapshot = {
      skillSourceId,
      blueprintId: blueprint.id,
      workingDirectory: skillSourcePath,
      sourceCompleteness: await classifySkillSource(sourcePath, sourceIsDirectory),
      capturedFiles,
      fileHashes,
      scriptInventory
    };
    await writeJson(join(skillSourcePath, "hiveward-skill-source.json"), {
      schema: "hiveward.skill-source/v1",
      ...snapshot,
      originalPath: sourcePath,
      sourceLabel: input.sourceLabel ?? sourceName,
      createdAt: new Date().toISOString()
    });
    this.driver.db.prepare(
      `INSERT INTO blueprint_skill_sources (id, blueprint_id, working_directory, source_completeness, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         working_directory = excluded.working_directory,
         source_completeness = excluded.source_completeness,
         snapshot_json = excluded.snapshot_json`
    ).run(snapshot.skillSourceId, snapshot.blueprintId, snapshot.workingDirectory, snapshot.sourceCompleteness, stringifyJson(snapshot), new Date().toISOString());
    return snapshot;
  }

  async getRoleDirectory(): Promise<{ roles: CompanyRoleDirectory; architecture: ArchitectureBlueprintView }> {
    return this.driver.transaction(() => {
      const companyId = this.requireSelectedCompanyId();
      const now = new Date().toISOString();
      const index = this.readIndexSnapshot();
      const roles = buildRoleDirectory(index, companyId, now, index.roleDirectories[companyId]);
      this.upsertRoleDirectory(roles);
      return {
        roles,
        architecture: buildArchitectureBlueprintView(this.readIndexSnapshot(), companyId, roles)
      };
    });
  }

  async saveArchitectureLayout(
    positions: Record<string, ArchitectureBlueprintView["nodes"][number]["position"]>
  ): Promise<{ roles: CompanyRoleDirectory; architecture: ArchitectureBlueprintView }> {
    return this.driver.transaction(() => {
      const companyId = this.requireSelectedCompanyId();
      const now = new Date().toISOString();
      const index = this.readIndexSnapshot();
      const roles = buildRoleDirectory(index, companyId, now, index.roleDirectories[companyId]);
      const roleIds = new Set([roles.ceo.id, ...roles.leaders.map((leader) => leader.id)]);
      const architecturePositions = { ...(roles.architecturePositions ?? {}) };
      for (const [roleId, position] of Object.entries(positions)) {
        if (roleIds.has(roleId)) architecturePositions[roleId] = position;
      }
      const nextRoles = buildRoleDirectory({
        ...index,
        roleDirectories: {
          ...index.roleDirectories,
          [companyId]: {
            ...roles,
            architecturePositions
          }
        }
      }, companyId, now);
      this.upsertRoleDirectory(nextRoles);
      const refreshed = this.readIndexSnapshot();
      return {
        roles: nextRoles,
        architecture: buildArchitectureBlueprintView(refreshed, companyId, nextRoles)
      };
    });
  }

  async listInboxItems(): Promise<InboxItem[]> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return [];
    return this.readInboxItems("WHERE company_id = ?", [companyId])
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  async createLeaderDelegationRequest(input: {
    leaderId: string;
    blueprintId?: string;
    title?: string;
    summary?: string;
    createdByRoleId?: string;
  }): Promise<InboxItem> {
    return this.driver.transaction(() => {
      const companyId = this.requireSelectedCompanyId();
      const now = new Date().toISOString();
      const index = this.readIndexSnapshot();
      const roles = buildRoleDirectory(index, companyId, now, index.roleDirectories[companyId]);
      const leader = roles.leaders.find((candidate) => candidate.id === input.leaderId);
      if (!leader) throw new Error(`Leader not found: ${input.leaderId}`);
      const blueprint = index.blueprintIndex.find((candidate) =>
        candidate.companyId === companyId && candidate.id === (input.blueprintId ?? leader.blueprintId)
      );
      const item = createInboxItem({
        companyId,
        type: "leader_delegation",
        title: input.title ?? `Call ${leader.label}`,
        summary: input.summary ?? `Request approval to bring ${leader.label} into this conversation.`,
        createdByRoleId: input.createdByRoleId ?? roles.ceo.id,
        targetRoleId: leader.id,
        blueprintId: blueprint?.id ?? leader.blueprintId,
        blueprintName: blueprint?.name,
        payload: { leaderId: leader.id, blueprintId: blueprint?.id ?? leader.blueprintId },
        now
      });
      this.upsertRoleDirectory(roles);
      this.upsertInboxItem(item);
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
    return this.driver.transaction(() => {
      const companyId = this.requireSelectedCompanyId();
      if (!input.blueprintPackage) throw new Error("Blueprint proposal requires an importable blueprintPackage.");
      const now = new Date().toISOString();
      const index = this.readIndexSnapshot();
      const roles = buildRoleDirectory(index, companyId, now, index.roleDirectories[companyId]);
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
      this.upsertRoleDirectory(roles);
      this.upsertInboxItem(item);
      return item;
    });
  }

  async approveInboxItem(
    itemId: string,
    defaults: BlueprintImportDefaults = {},
    comment?: string
  ): Promise<{ item: InboxItem; importedBlueprints?: BlueprintDefinition[] }> {
    const result = this.driver.transaction(() => {
      const item = this.requireInboxItem(itemId);
      if (item.status === "approved") return { item };
      const blueprintPackage = readBlueprintPackagePayload(item.payload?.blueprintPackage);
      let importedBlueprints: BlueprintDefinition[] | undefined;
      if (item.type === "blueprint_proposal") {
        if (!blueprintPackage) throw new Error(`Blueprint proposal inbox item ${item.id} is missing an importable blueprintPackage.`);
        importedBlueprints = this.importBlueprintPackageTx(blueprintPackage, {
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
      this.upsertInboxItem(approved);
      return { item: approved, importedBlueprints };
    });
    await Promise.all((result.importedBlueprints ?? []).map((blueprint) => this.writeBlueprintWorkspace(blueprint)));
    return result;
  }

  async rejectInboxItem(itemId: string, comment?: string): Promise<InboxItem> {
    return this.driver.transaction(() => {
      const item = this.requireInboxItem(itemId);
      if (item.status === "approved") return item;
      const now = new Date().toISOString();
      const rejected: InboxItem = {
        ...item,
        status: "rejected",
        updatedAt: now,
        decidedAt: now,
        decisionComment: readOptionalString(comment)
      };
      this.upsertInboxItem(rejected);
      return rejected;
    });
  }

  async replyToInboxItem(itemId: string, message: string): Promise<InboxItem> {
    return this.driver.transaction(() => {
      const body = readOptionalString(message);
      if (!body) throw new Error("Inbox reply message is required.");
      const item = this.requireInboxItem(itemId);
      if (item.status === "approved") return item;
      const now = new Date().toISOString();
      this.driver.db.prepare(
        `INSERT INTO inbox_replies (id, inbox_item_id, message, created_at) VALUES (?, ?, ?, ?)`
      ).run(`inbox-reply-${nanoid(10)}`, item.id, body, now);
      const replied = { ...item, replies: this.readInboxReplies(item.id), updatedAt: now };
      this.upsertInboxItem(replied);
      return replied;
    });
  }

  async applyInboxDecision(input: ApplyInboxDecisionInput): Promise<ApplyInboxDecisionResult> {
    return this.driver.transaction(() => {
      const item = this.requireInboxItem(input.inboxItemId);
      if (item.status !== "pending") return { status: "conflict", item };
      const request = input.approvalRequestId ? this.getApprovalRequestSync(input.approvalRequestId) : undefined;
      if (input.approvalRequestId && (!request || request.status !== "pending")) {
        return { status: "conflict", item };
      }

      let importedBlueprints: BlueprintDefinition[] | undefined;
      if (input.action === "reply") {
        const body = readOptionalString(input.comment);
        if (!body) throw new Error("Inbox reply message is required.");
        const now = new Date().toISOString();
        const itemResult = this.driver.db.prepare(
          "UPDATE inbox_items SET updated_at = ? WHERE id = ? AND status = 'pending'"
        ).run(now, item.id);
        if (itemResult.changes !== 1) return { status: "conflict", item };
        if (input.approvalRequestId) {
          const requestResult = this.driver.db.prepare(
            "UPDATE approval_requests SET updated_at = ? WHERE id = ? AND status = 'pending'"
          ).run(now, input.approvalRequestId);
          if (requestResult.changes !== 1) return { status: "conflict", item };
          if (input.approvalDecision) this.appendApprovalDecisionSync(input.approvalDecision);
          if (input.approvalTimelineItem) this.appendRunTimelineItemSync(input.approvalTimelineItem);
        }
        this.driver.db.prepare(
          `INSERT INTO inbox_replies (id, inbox_item_id, message, created_at) VALUES (?, ?, ?, ?)`
        ).run(`inbox-reply-${nanoid(10)}`, item.id, body, now);
        const replied = { ...item, replies: this.readInboxReplies(item.id), updatedAt: now };
        return { status: "applied", item: replied };
      }

      const now = new Date().toISOString();
      const nextStatus = input.action === "approve" ? "approved" : "rejected";
      const decided: InboxItem = {
        ...item,
        status: nextStatus,
        updatedAt: now,
        decidedAt: now,
        decisionComment: readOptionalString(input.comment)
      };
      const itemResult = this.driver.db.prepare(
        `UPDATE inbox_items
         SET status = ?,
             updated_at = ?,
             decided_at = ?,
             decision_comment = ?
         WHERE id = ? AND status = 'pending'`
      ).run(nextStatus, now, now, decided.decisionComment, item.id);
      if (itemResult.changes !== 1) return { status: "conflict", item };
      if (input.action === "approve" && item.type === "blueprint_proposal") {
        const blueprintPackage = readBlueprintPackagePayload(item.payload?.blueprintPackage);
        if (!blueprintPackage) throw new Error(`Blueprint proposal inbox item ${item.id} is missing an importable blueprintPackage.`);
        importedBlueprints = this.importBlueprintPackageTx(blueprintPackage, {
          ...(input.defaults ?? {}),
          runtimeId: readAgentRuntimeId(item.payload?.runtimeId) ?? input.defaults?.runtimeId,
          replaceBlueprintId: item.blueprintId ?? input.defaults?.replaceBlueprintId
        });
      }

      if (input.approvalRequestId) {
        const result = this.driver.db.prepare(
          `UPDATE approval_requests
           SET status = ?,
               capabilities_json = ?,
               updated_at = ?
           WHERE id = ? AND status = 'pending'`
        ).run(
          nextStatus,
          stringifyJson({ approve: false, reject: false, reply: false, complete: false, terminate: false }),
          now,
          input.approvalRequestId
        );
        if (result.changes !== 1) return { status: "conflict", item };
        if (input.approvalDecision) this.appendApprovalDecisionSync(input.approvalDecision);
        if (input.approvalTimelineItem) this.appendRunTimelineItemSync(input.approvalTimelineItem);
      }

      return { status: "applied", item: decided, importedBlueprints };
    });
  }

  async createBlueprintRun(blueprint: BlueprintDefinition, startedBy: string): Promise<BlueprintRun> {
    return this.driver.transaction(() => {
      const runnableBlueprint = stripRemovedBlueprintNodes(blueprint);
      const now = new Date().toISOString();
      const run: BlueprintRun = {
        id: `run-${nanoid(10)}`,
        companyId: runnableBlueprint.companyId,
        blueprintId: runnableBlueprint.id,
        blueprintName: runnableBlueprint.name,
        blueprintVersion: runnableBlueprint.version,
        status: "queued",
        startedBy,
        startedAt: now,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        runtimeRefs: []
      };
      this.upsertRun(toBlueprintRunSummary(run, runnableBlueprint));
      this.driver.db.prepare(
        `INSERT INTO run_blueprint_snapshots (run_id, blueprint_version_id, definition_json, sha256, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           blueprint_version_id = excluded.blueprint_version_id,
           definition_json = excluded.definition_json,
           sha256 = excluded.sha256`
      ).run(run.id, this.currentBlueprintVersionId(runnableBlueprint.id), stringifyJson(runnableBlueprint), sha256Json(runnableBlueprint), now);
      return run;
    });
  }

  async updateBlueprintRun(run: BlueprintRun): Promise<void> {
    this.driver.transaction(() => {
      const archive = this.requireRunArchive(run.id);
      const nextRun = applyNodeRunFactsToRun(toBlueprintRunSummary({ ...archive.run, ...run }, archive.blueprintSnapshot), archive.nodeRuns);
      this.upsertRun(nextRun);
      return undefined;
    });
  }

  async getBlueprintRun(id: string): Promise<BlueprintRun | undefined> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return undefined;
    const row = this.driver.db.prepare("SELECT * FROM runs WHERE id = ? AND company_id = ?").get(id, companyId) as Row | undefined;
    return row ? runFromRow(row) : undefined;
  }

  async upsertNodeRun(nodeRun: BlueprintNodeRun): Promise<void> {
    this.driver.transaction(() => {
      const now = new Date().toISOString();
      this.driver.db.prepare(
        `INSERT INTO node_runs (
          id, run_id, blueprint_id, node_id, node_label, node_type, iteration_round_id, status,
          queued_at, started_at, ended_at, error, usage_json, openclaw_ref_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          iteration_round_id = excluded.iteration_round_id,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          error = excluded.error,
          usage_json = excluded.usage_json,
          openclaw_ref_json = excluded.openclaw_ref_json,
          row_version = node_runs.row_version + 1,
          updated_at = excluded.updated_at`
      ).run(
        nodeRun.id,
        nodeRun.blueprintRunId,
        nodeRun.blueprintId,
        nodeRun.nodeId,
        nodeRun.nodeLabel,
        nodeRun.nodeType,
        nodeRun.iterationRoundId,
        nodeRun.status,
        nodeRun.queuedAt,
        nodeRun.startedAt,
        nodeRun.endedAt,
        nodeRun.error,
        optionalJson(nodeRun.usage),
        optionalJson(readBlueprintNodeRunRuntimeRef(nodeRun)),
        now
      );
      this.driver.db.prepare(
        `INSERT INTO node_run_payloads (node_run_id, input_json, output_json, raw_result_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_run_id) DO UPDATE SET
           input_json = excluded.input_json,
           output_json = excluded.output_json,
           raw_result_json = excluded.raw_result_json,
           updated_at = excluded.updated_at`
      ).run(nodeRun.id, optionalJson(nodeRun.input), optionalJson(nodeRun.output), optionalJson(nodeRun.output), now);
      this.upsertAgentOutputFromNodeRun(nodeRun, now);
      this.refreshRunFacts(nodeRun.blueprintRunId);
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

  async listNodeRuns(blueprintRunId: string): Promise<BlueprintNodeRun[]> {
    return this.readNodeRuns(blueprintRunId);
  }

  async appendEvent(event: BlueprintNodeEvent): Promise<void> {
    this.driver.transaction(() => {
      this.appendEventSync(event);
    });
  }

  async getRunView(blueprintRunId: string): Promise<BlueprintRunView | undefined> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return undefined;
    const row = this.driver.db.prepare("SELECT * FROM runs WHERE id = ? AND company_id = ?").get(blueprintRunId, companyId) as Row | undefined;
    if (!row) return undefined;
    return this.runViewFromRunRow(row);
  }

  async getLatestRunViewForBlueprint(blueprintId: string): Promise<BlueprintRunView | undefined> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return undefined;
    const row = this.driver.db.prepare(
      `SELECT * FROM runs WHERE blueprint_id = ? AND company_id = ? ORDER BY started_at DESC LIMIT 1`
    ).get(blueprintId, companyId) as Row | undefined;
    return row ? this.runViewFromRunRow(row) : undefined;
  }

  async listRunSummaries(): Promise<BlueprintRunSummary[]> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return [];
    return (this.driver.db.prepare("SELECT * FROM runs WHERE company_id = ? ORDER BY started_at DESC").all(companyId) as Row[])
      .map(runSummaryFromRow);
  }

  async listRunViews(): Promise<BlueprintRunView[]> {
    const summaries = await this.listRunSummaries();
    return summaries.flatMap((run) => {
      const view = this.runViewFromRunRow(this.requireRunRow(run.id));
      return view ? [view] : [];
    });
  }

  async listRunArchives(): Promise<BlueprintRunArchive[]> {
    const summaries = await this.listRunSummaries();
    return summaries.map((run) => this.requireRunArchive(run.id));
  }

  async listPendingApprovals(): Promise<import("@hiveward/shared").PendingApprovalItem[]> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return [];
    const rows = this.driver.db.prepare(
      `SELECT ar.*, r.blueprint_id, r.blueprint_name, r.started_by, r.started_at,
              nr.status AS node_status, nr.node_id AS joined_node_id, nr.node_label AS joined_node_label,
              p.input_json AS node_input_json, p.output_json AS node_output_json
       FROM approval_requests ar
       JOIN runs r ON r.id = ar.run_id
       LEFT JOIN node_runs nr ON nr.id = ar.node_run_id
       LEFT JOIN node_run_payloads p ON p.node_run_id = nr.id
       WHERE ar.status = 'pending' AND r.company_id = ?
       ORDER BY ar.requested_at DESC`
    ).all(companyId) as Row[];
    return rows.map((row) => {
      const request = approvalRequestFromRow(row);
      const parsedOutput = parseOptionalJson(row.node_output_json);
      const output = isRecord(parsedOutput) && parsedOutput.approvalType === "agent"
        ? parsedOutput
        : undefined;
      const selectedReplyId = readString(output?.selectedReplyId);
      return {
        approvalRequestId: request.id,
        kind: request.kind,
        blueprintId: readString(row.blueprint_id) ?? request.runId,
        blueprintName: readString(row.blueprint_name) ?? readString(row.blueprint_id) ?? request.runId,
        blueprintRunId: request.runId,
        nodeRunId: request.nodeRunId ?? request.id,
        nodeId: request.requestedBy.nodeId ?? readString(row.joined_node_id) ?? request.id,
        nodeLabel: request.requestedBy.label || readString(row.joined_node_label) || request.id,
        startedBy: readString(row.started_by) ?? "unknown",
        startedAt: readString(row.started_at) ?? request.requestedAt,
        requestedAt: request.requestedAt,
        status: row.node_status === "running" ? "replying" : "pending",
        reviewOutput: output && "reviewOutput" in output ? output.reviewOutput : request.body,
        ...(selectedReplyId ? { selectedReplyId } : {}),
        canApprove: request.capabilities.approve,
        canReject: request.capabilities.reject,
        canReply: request.capabilities.reply,
        canComplete: request.capabilities.complete,
        canTerminate: request.capabilities.terminate
      };
    });
  }

  async listApprovalRequests(filter: { runId?: string; status?: ApprovalRequest["status"] } = {}): Promise<ApprovalRequest[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.runId) {
      clauses.push("run_id = ?");
      values.push(filter.runId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      values.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.driver.db.prepare(`SELECT * FROM approval_requests ${where} ORDER BY requested_at DESC`).all(...values) as Row[])
      .map(approvalRequestFromRow);
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    return this.getApprovalRequestSync(id);
  }

  async upsertApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest> {
    return this.upsertApprovalRequestSync(request);
  }

  private upsertApprovalRequestSync(request: ApprovalRequest): ApprovalRequest {
    this.driver.db.prepare(
      `INSERT INTO approval_requests (
        id, run_id, round_id, node_run_id, kind, status, title, body, payload_ref,
        source_type, source_id, thread_id, revision, replaces_request_id, superseded_by_request_id,
        capabilities_json, requested_by_json, requested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        title = excluded.title,
        body = excluded.body,
        payload_ref = excluded.payload_ref,
        thread_id = excluded.thread_id,
        revision = excluded.revision,
        replaces_request_id = excluded.replaces_request_id,
        superseded_by_request_id = excluded.superseded_by_request_id,
        capabilities_json = excluded.capabilities_json,
        requested_by_json = excluded.requested_by_json,
        updated_at = excluded.updated_at`
    ).run(
      request.id,
      request.runId,
      request.roundId,
      request.nodeRunId,
      request.kind,
      request.status,
      request.title,
      request.body,
      request.payloadRef,
      request.sourceRef?.type,
      request.sourceRef?.id,
      request.threadId,
      request.revision,
      request.replacesRequestId,
      request.supersededByRequestId,
      stringifyJson(request.capabilities),
      stringifyJson(request.requestedBy),
      request.requestedAt,
      request.updatedAt
    );
    return request;
  }

  async appendApprovalDecision(decision: ApprovalDecision): Promise<ApprovalDecision> {
    this.appendApprovalDecisionSync(decision);
    return decision;
  }

  private getApprovalRequestSync(id: string): ApprovalRequest | undefined {
    const row = this.driver.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as Row | undefined;
    return row ? approvalRequestFromRow(row) : undefined;
  }

  private appendApprovalDecisionSync(decision: ApprovalDecision): void {
    this.driver.db.prepare(
      `INSERT INTO approval_decisions (id, approval_request_id, action, actor, comment, selected_reply_id, resulting_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         comment = excluded.comment,
         selected_reply_id = excluded.selected_reply_id,
         resulting_status = excluded.resulting_status`
    ).run(
      decision.id,
      decision.approvalRequestId,
      decision.action,
      decision.actor,
      decision.comment,
      decision.selectedReplyId,
      decision.resultingStatus,
      decision.createdAt
    );
    if (decision.action === "reply" && decision.comment?.trim()) {
      this.driver.db.prepare(
        `INSERT OR IGNORE INTO approval_replies (id, approval_request_id, message, actor, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(`reply-${decision.id}`, decision.approvalRequestId, decision.comment, decision.actor, decision.createdAt);
    }
  }

  async applyApprovalDecision(input: ApplyApprovalDecisionInput): Promise<ApplyApprovalDecisionResult> {
    return this.driver.transaction(() => {
      const current = this.getApprovalRequestSync(input.approvalRequestId);
      if (!current || current.status !== input.expectedStatus) {
        return { status: "conflict", approvalRequest: current };
      }
      const result = this.driver.db.prepare(
        `UPDATE approval_requests
         SET status = ?,
             capabilities_json = ?,
             superseded_by_request_id = ?,
             updated_at = ?
         WHERE id = ? AND status = 'pending'`
      ).run(
        input.nextRequest.status,
        stringifyJson(input.nextRequest.capabilities),
        input.nextRequest.supersededByRequestId,
        input.nextRequest.updatedAt,
        input.approvalRequestId
      );
      if (result.changes !== 1) {
        return { status: "conflict", approvalRequest: this.getApprovalRequestSync(input.approvalRequestId) };
      }
      this.appendApprovalDecisionSync(input.decision);
      if (input.nextApprovalRequest) this.upsertApprovalRequestSync(input.nextApprovalRequest);
      if (input.releaseReport) this.upsertReleaseReportSync(input.releaseReport);
      if (input.timelineItem) this.appendRunTimelineItemSync(input.timelineItem);
      return {
        status: "applied",
        approvalRequest: input.nextRequest,
        decision: input.decision,
        nextApprovalRequest: input.nextApprovalRequest
      };
    });
  }

  async listApprovalDecisions(approvalRequestId?: string): Promise<ApprovalDecision[]> {
    const rows = approvalRequestId
      ? this.driver.db.prepare("SELECT * FROM approval_decisions WHERE approval_request_id = ? ORDER BY created_at").all(approvalRequestId) as Row[]
      : this.driver.db.prepare("SELECT * FROM approval_decisions ORDER BY created_at").all() as Row[];
    return rows.map(approvalDecisionFromRow);
  }

  async listIterationSessions(runId?: string): Promise<IterationSession[]> {
    const rows = runId
      ? this.driver.db.prepare("SELECT * FROM iteration_sessions WHERE run_id = ?").all(runId) as Row[]
      : this.driver.db.prepare("SELECT * FROM iteration_sessions").all() as Row[];
    return rows.map(iterationSessionFromRow);
  }

  async upsertIterationSession(session: IterationSession): Promise<IterationSession> {
    return this.upsertIterationSessionSync(session);
  }

  private upsertIterationSessionSync(session: IterationSession): IterationSession {
    this.driver.db.prepare(
      `INSERT INTO iteration_sessions (id, run_id, top_manager_node_id, blueprint_snapshot_id, status, max_rounds, current_round_id, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         current_round_id = excluded.current_round_id,
         ended_at = excluded.ended_at`
    ).run(session.id, session.runId, session.topManagerNodeId, session.blueprintSnapshotId, session.status, session.maxRounds, session.currentRoundId, session.createdAt, session.endedAt);
    return session;
  }

  async listIterationRounds(filter: { runId?: string; sessionId?: string; status?: IterationRound["status"] } = {}): Promise<IterationRound[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.runId) {
      clauses.push("run_id = ?");
      values.push(filter.runId);
    }
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      values.push(filter.sessionId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      values.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.driver.db.prepare(`SELECT * FROM iteration_rounds ${where} ORDER BY round_number`).all(...values) as Row[])
      .map(iterationRoundFromRow);
  }

  async upsertIterationRound(round: IterationRound): Promise<IterationRound> {
    return this.upsertIterationRoundSync(round);
  }

  private upsertIterationRoundSync(round: IterationRound): IterationRound {
    this.driver.db.prepare(
      `INSERT INTO iteration_rounds (
        id, session_id, run_id, round_number, status, requirement_request_id,
        approved_requirement_request_id, approved_requirement_revision, release_report_request_id,
        artifact_ids_json, research_status, research_summary, research_artifact_ids_json,
        plan_source, context_snapshot_id, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        requirement_request_id = excluded.requirement_request_id,
        approved_requirement_request_id = excluded.approved_requirement_request_id,
        approved_requirement_revision = excluded.approved_requirement_revision,
        release_report_request_id = excluded.release_report_request_id,
        artifact_ids_json = excluded.artifact_ids_json,
        research_status = excluded.research_status,
        research_summary = excluded.research_summary,
        research_artifact_ids_json = excluded.research_artifact_ids_json,
        plan_source = excluded.plan_source,
        context_snapshot_id = excluded.context_snapshot_id,
        ended_at = excluded.ended_at`
    ).run(
      round.id,
      round.sessionId,
      round.runId,
      round.roundNumber,
      round.status,
      round.requirementRequestId,
      round.approvedRequirementRequestId,
      round.approvedRequirementRevision,
      round.releaseReportRequestId,
      stringifyJson(round.artifactIds ?? []),
      round.researchStatus,
      round.researchSummary,
      stringifyJson(round.researchArtifactIds ?? []),
      round.planSource,
      round.contextSnapshotId,
      round.startedAt,
      round.endedAt
    );
    return round;
  }

  async listArtifacts(runId?: string): Promise<Artifact[]> {
    const rows = runId
      ? this.driver.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at").all(runId) as Row[]
      : this.driver.db.prepare("SELECT * FROM artifacts ORDER BY created_at").all() as Row[];
    return rows.map(artifactFromRow);
  }

  async upsertArtifact(artifact: Artifact): Promise<Artifact> {
    return this.upsertArtifactSync(artifact);
  }

  private upsertArtifactSync(artifact: Artifact): Artifact {
    const declaredNodeRunId = artifact.nodeRunId;
    const nodeRunId = declaredNodeRunId && this.nodeRunExists(declaredNodeRunId) ? declaredNodeRunId : undefined;
    this.driver.db.prepare(
      `INSERT INTO artifacts (
        id, run_id, round_id, node_run_id, declared_node_run_id, slot, title, kind, format, storage_path,
        relative_path, download_url, preview_policy, trusted, status, bytes, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        round_id = excluded.round_id,
        node_run_id = excluded.node_run_id,
        declared_node_run_id = excluded.declared_node_run_id,
        slot = excluded.slot,
        title = excluded.title,
        kind = excluded.kind,
        format = excluded.format,
        storage_path = excluded.storage_path,
        relative_path = excluded.relative_path,
        download_url = excluded.download_url,
        preview_policy = excluded.preview_policy,
        trusted = excluded.trusted,
        status = excluded.status,
        bytes = excluded.bytes,
        sha256 = excluded.sha256`
    ).run(
      artifact.id,
      artifact.runId,
      artifact.roundId,
      nodeRunId,
      declaredNodeRunId,
      artifact.slot,
      artifact.title,
      artifact.kind,
      artifact.format,
      artifact.storagePath,
      artifact.relativePath,
      artifact.downloadUrl,
      artifact.previewPolicy,
      artifact.trusted ? 1 : 0,
      artifact.status ?? "current",
      artifact.bytes,
      artifact.sha256,
      artifact.createdAt
    );
    return artifact;
  }

  async listReleaseReports(runId?: string): Promise<ReleaseReport[]> {
    const rows = runId
      ? this.driver.db.prepare("SELECT * FROM release_reports WHERE run_id = ? ORDER BY created_at").all(runId) as Row[]
      : this.driver.db.prepare("SELECT * FROM release_reports ORDER BY created_at").all() as Row[];
    return rows.map((row) => this.releaseReportFromRow(row));
  }

  async upsertReleaseReport(report: ReleaseReport): Promise<ReleaseReport> {
    return this.driver.transaction(() => this.upsertReleaseReportSync(report));
  }

  private upsertReleaseReportSync(report: ReleaseReport): ReleaseReport {
    this.driver.db.prepare(
      `INSERT INTO release_reports (id, run_id, round_id, approval_request_id, version, title, summary, supersedes_report_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         approval_request_id = excluded.approval_request_id,
         version = excluded.version,
         title = excluded.title,
         summary = excluded.summary,
         supersedes_report_id = excluded.supersedes_report_id`
    ).run(report.id, report.runId, report.roundId, report.approvalRequestId, report.version, report.title, report.summary, report.supersedesReportId, report.createdAt);
    this.driver.db.prepare("DELETE FROM release_report_artifacts WHERE release_report_id = ?").run(report.id);
    for (const [position, ref] of report.artifactRefs.entries()) {
      this.driver.db.prepare(
        `INSERT INTO release_report_artifacts (release_report_id, artifact_id, position, title, location, current) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(report.id, ref.artifactId, position, ref.title, ref.location, ref.current ? 1 : 0);
    }
    return report;
  }

  async listAgentHumanReports(runId?: string): Promise<AgentHumanReport[]> {
    const rows = runId
      ? this.driver.db.prepare("SELECT * FROM agent_human_reports WHERE run_id = ? ORDER BY created_at").all(runId) as Row[]
      : this.driver.db.prepare("SELECT * FROM agent_human_reports ORDER BY created_at").all() as Row[];
    return rows.map(agentHumanReportFromRow);
  }

  async upsertAgentHumanReport(report: AgentHumanReport): Promise<AgentHumanReport> {
    return this.upsertAgentHumanReportSync(report);
  }

  private upsertAgentHumanReportSync(report: AgentHumanReport): AgentHumanReport {
    this.driver.db.prepare(
      `INSERT INTO agent_human_reports (id, run_id, round_id, node_run_id, node_id, node_label, title, body_md, source, fallback_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body_md = excluded.body_md,
         source = excluded.source,
         fallback_reason = excluded.fallback_reason`
    ).run(report.id, report.runId, report.roundId, report.nodeRunId, report.nodeId, report.nodeLabel, report.title, report.bodyMd, report.source, report.fallbackReason, report.createdAt);
    return report;
  }

  async listAgentHandoffs(runId?: string): Promise<AgentHandoff[]> {
    const rows = runId
      ? this.driver.db.prepare("SELECT * FROM agent_handoffs WHERE run_id = ? ORDER BY created_at").all(runId) as Row[]
      : this.driver.db.prepare("SELECT * FROM agent_handoffs ORDER BY created_at").all() as Row[];
    return rows.map(agentHandoffFromRow);
  }

  async upsertAgentHandoff(handoff: AgentHandoff): Promise<AgentHandoff> {
    return this.upsertAgentHandoffSync(handoff);
  }

  private upsertAgentHandoffSync(handoff: AgentHandoff): AgentHandoff {
    this.driver.db.prepare(
      `INSERT INTO agent_handoffs (id, run_id, round_id, node_run_id, node_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`
    ).run(handoff.id, handoff.runId, handoff.roundId, handoff.nodeRunId, handoff.nodeId, stringifyJson(handoff.payload), handoff.createdAt);
    return handoff;
  }

  async listManagerContextSnapshots(runId?: string): Promise<ManagerContextSnapshot[]> {
    const rows = runId
      ? this.driver.db.prepare("SELECT * FROM manager_context_snapshots WHERE run_id = ? ORDER BY version").all(runId) as Row[]
      : this.driver.db.prepare("SELECT * FROM manager_context_snapshots ORDER BY version").all() as Row[];
    return rows.map(managerContextSnapshotFromRow);
  }

  async upsertManagerContextSnapshot(snapshot: ManagerContextSnapshot): Promise<ManagerContextSnapshot> {
    return this.upsertManagerContextSnapshotSync(snapshot);
  }

  private upsertManagerContextSnapshotSync(snapshot: ManagerContextSnapshot): ManagerContextSnapshot {
    this.driver.db.prepare(
      `INSERT INTO manager_context_snapshots (id, run_id, session_id, round_id, version, source_report_id, snapshot_json, summary, recommended_next_step, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         source_report_id = excluded.source_report_id,
         snapshot_json = excluded.snapshot_json,
         summary = excluded.summary,
         recommended_next_step = excluded.recommended_next_step`
    ).run(
      snapshot.id,
      snapshot.runId,
      snapshot.sessionId,
      snapshot.roundId,
      snapshot.version,
      snapshot.sourceReportId,
      stringifyJson(snapshot),
      snapshot.summary,
      snapshot.recommendedNextStep,
      snapshot.createdAt
    );
    return snapshot;
  }

  async appendRunTimelineItem(item: Omit<RunTimelineItem, "sequence"> & { sequence?: number }): Promise<RunTimelineItem> {
    return this.driver.transaction(() => {
      return this.appendRunTimelineItemSync(item);
    });
  }

  async listRunTimeline(runId: string): Promise<RunTimelineItem[]> {
    return (this.driver.db.prepare("SELECT * FROM run_timeline_items WHERE run_id = ? ORDER BY sequence").all(runId) as Row[])
      .map(runTimelineItemFromRow);
  }

  async listManagerMail(runId?: string): Promise<ManagerMail[]> {
    const rows = runId
      ? this.driver.db.prepare("SELECT * FROM manager_mail WHERE related_run_id = ? ORDER BY created_at DESC").all(runId) as Row[]
      : this.driver.db.prepare("SELECT * FROM manager_mail ORDER BY created_at DESC").all() as Row[];
    return rows.map(managerMailFromRow);
  }

  async replaceManagerMail(mail: ManagerMail[], scope?: { runId?: string }): Promise<ManagerMail[]> {
    this.driver.transaction(() => this.replaceManagerMailSync(mail, scope));
    return mail;
  }

  private replaceManagerMailSync(mail: ManagerMail[], scope?: { runId?: string }): ManagerMail[] {
    if (scope) {
      if (scope.runId !== undefined) {
        this.driver.db.prepare("DELETE FROM manager_mail WHERE related_run_id = ?").run(scope.runId);
      } else {
        this.driver.db.prepare("DELETE FROM manager_mail").run();
      }
    }
    const mailIds = new Set(mail.map((item) => item.id));
    if (!scope) {
      for (const id of mailIds) {
        this.driver.db.prepare("DELETE FROM manager_mail WHERE id = ?").run(id);
      }
    }
    for (const item of mail) {
      this.driver.db.prepare(
        `INSERT INTO manager_mail (
          id, source_type, source_id, kind, status, title, body, capabilities_json,
          related_run_id, related_round_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(item.id, item.sourceType, item.sourceId, item.kind, item.status, item.title, item.body, stringifyJson(item.capabilities), item.relatedRunId, item.relatedRoundId, item.createdAt, item.updatedAt);
    }
    return mail;
  }

  async getDashboardState(): Promise<WorkspaceDashboard> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return createDefaultWorkspaceDashboard(new Date().toISOString());
    return this.getDashboard(companyId) ?? createDefaultWorkspaceDashboard(new Date().toISOString());
  }

  async saveDashboardState(dashboard: WorkspaceDashboard): Promise<WorkspaceDashboard> {
    const companyId = this.requireSelectedCompanyId();
    const now = new Date().toISOString();
    const normalized = { ...normalizeWorkspaceDashboard(dashboard, now), updatedAt: now };
    this.upsertDashboard(companyId, normalized);
    return normalized;
  }

  async saveCatalogSnapshot(snapshot: CatalogSnapshot): Promise<CatalogSnapshot> {
    this.setSetting(catalogSnapshotSettingKey, snapshot, new Date().toISOString());
    return snapshot;
  }

  async getCatalogSnapshot(): Promise<CatalogSnapshot | undefined> {
    return this.getSetting<CatalogSnapshot>(catalogSnapshotSettingKey);
  }

  async listChatSessions(): Promise<HivewardChatSession[]> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return [];
    return (this.driver.db.prepare("SELECT * FROM chat_sessions WHERE company_id = ? ORDER BY updated_at DESC").all(companyId) as Row[])
      .map(chatSessionFromRow);
  }

  async getChatSession(id: string): Promise<HivewardChatSession | undefined> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return undefined;
    const row = this.driver.db.prepare("SELECT * FROM chat_sessions WHERE id = ? AND company_id = ?").get(id, companyId) as Row | undefined;
    return row ? chatSessionFromRow(row) : undefined;
  }

  async findChatSessionByNative(input: { harnessId: HarnessId; nativeSessionId: string }): Promise<HivewardChatSession | undefined> {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return undefined;
    const row = this.driver.db.prepare(
      "SELECT * FROM chat_sessions WHERE company_id = ? AND harness_id = ? AND native_session_id = ?"
    ).get(companyId, input.harnessId, input.nativeSessionId) as Row | undefined;
    return row ? chatSessionFromRow(row) : undefined;
  }

  async createChatSession(input: CreateHivewardChatSessionRequest): Promise<HivewardChatSession> {
    return this.driver.transaction(() => {
      const companyId = this.requireSelectedCompanyId();
      const now = new Date().toISOString();
      const session: HivewardChatSession = {
        id: `chat-session-${nanoid(10)}`,
        companyId,
        harnessId: normalizeHarnessId(input.harnessId),
        roleScope: normalizeChatRoleScopeForSelectedCompany(this.readIndexSnapshot(), companyId, input.roleScope, now),
        title: readOptionalString(input.title) ?? "New chat",
        nativeSessionId: readOptionalString(input.nativeSessionId),
        nativeSessionState: readOptionalString(input.nativeSessionId) ? "resumable" : "unknown",
        modelId: readOptionalString(input.modelId),
        agentId: readOptionalString(input.agentId),
        thinkingEffort: normalizeThinkingEffort(input.thinkingEffort),
        permissionMode: normalizePermissionMode(input.permissionMode) ?? "safe",
        mode: normalizeChatMode(input.mode),
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      this.upsertChatSession(session);
      return session;
    });
  }

  async updateChatSession(id: string, patch: UpdateHivewardChatSessionRequest): Promise<HivewardChatSession | undefined> {
    return this.driver.transaction(() => {
      const current = this.getChatSessionSync(id);
      if (!current) return undefined;
      const now = new Date().toISOString();
      const status = normalizeChatSessionStatus(patch.status) ?? current.status;
      const next: HivewardChatSession = {
        ...current,
        title: readOptionalString(patch.title) ?? current.title,
        nativeSessionId: Object.hasOwn(patch, "nativeSessionId") ? readOptionalString(patch.nativeSessionId) : current.nativeSessionId,
        nativeSessionState: normalizeNativeSessionState(patch.nativeSessionState) ?? current.nativeSessionState,
        modelId: readOptionalString(patch.modelId) ?? current.modelId,
        agentId: readOptionalString(patch.agentId) ?? current.agentId,
        thinkingEffort: normalizeThinkingEffort(patch.thinkingEffort) ?? current.thinkingEffort,
        permissionMode: normalizePermissionMode(patch.permissionMode) ?? current.permissionMode,
        mode: patch.mode ? normalizeChatMode(patch.mode) : current.mode,
        roleScope: patch.roleScope
          ? normalizeChatRoleScopeForSelectedCompany(this.readIndexSnapshot(), current.companyId ?? this.requireSelectedCompanyId(), patch.roleScope, now)
          : current.roleScope,
        status,
        endedAt: status === "ended" ? current.endedAt ?? now : current.endedAt,
        updatedAt: now
      };
      this.upsertChatSession(next);
      return next;
    });
  }

  async endChatSession(id: string): Promise<HivewardChatSession | undefined> {
    return this.updateChatSession(id, { status: "ended" });
  }

  async listChatMessages(sessionId: string): Promise<HivewardChatMessage[]> {
    const session = await this.getChatSession(sessionId);
    if (!session) return [];
    return this.readChatMessages(sessionId);
  }

  async appendChatMessage(
    input: Omit<HivewardChatMessage, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
      createdAt?: string;
      updatedAt?: string;
    }
  ): Promise<HivewardChatMessage> {
    return this.driver.transaction(() => {
      const session = this.getChatSessionSync(input.sessionId);
      if (!session) throw new Error(`Chat session not found: ${input.sessionId}`);
      const now = new Date().toISOString();
      const message: HivewardChatMessage = {
        id: input.id ?? `chat-message-${nanoid(10)}`,
        sessionId: input.sessionId,
        role: normalizeChatMessageRole(input.role) ?? "user",
        content: input.content,
        attachments: input.attachments,
        harnessId: normalizeHarnessId(input.harnessId),
        modelId: readOptionalString(input.modelId),
        nativeMessageId: readOptionalString(input.nativeMessageId),
        status: normalizeChatMessageStatus(input.status) ?? "sent",
        runtimeRef: input.runtimeRef,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt
      };
      this.upsertChatMessage(message);
      this.enforceMessageRetention(input.sessionId);
      this.upsertChatSession({
        ...session,
        title: deriveChatSessionTitle(session, message),
        updatedAt: now
      });
      return message;
    });
  }

  async updateChatMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<Pick<HivewardChatMessage, "content" | "status" | "runtimeRef" | "nativeMessageId" | "modelId">>
  ): Promise<HivewardChatMessage | undefined> {
    return this.driver.transaction(() => {
      const current = this.readChatMessages(sessionId).find((message) => message.id === messageId);
      if (!current) return undefined;
      const next: HivewardChatMessage = {
        ...current,
        content: patch.content ?? current.content,
        status: normalizeChatMessageStatus(patch.status) ?? current.status,
        runtimeRef: patch.runtimeRef === undefined ? current.runtimeRef : patch.runtimeRef,
        nativeMessageId: readOptionalString(patch.nativeMessageId) ?? current.nativeMessageId,
        modelId: readOptionalString(patch.modelId) ?? current.modelId,
        updatedAt: new Date().toISOString()
      };
      this.upsertChatMessage(next);
      return next;
    });
  }

  async claimNodeRun(input: { nodeRunId: string; owner: string; leaseMs: number }): Promise<ClaimNodeRunResult> {
    return this.driver.transaction(() => {
      const now = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + input.leaseMs).toISOString();
      const result = this.driver.db.prepare(
        `UPDATE node_runs
         SET status = 'running',
             started_at = COALESCE(started_at, ?),
             lease_owner = ?,
             lease_expires_at = ?,
             worker_epoch = worker_epoch + 1,
             row_version = row_version + 1,
             updated_at = ?
         WHERE id = ?
           AND (
             status = 'queued'
             OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
           )`
      ).run(now, input.owner, leaseExpiresAt, now, input.nodeRunId, now);
      if (result.changes !== 1) return { claimed: false };
      const row = this.driver.db.prepare(
        `SELECT node_runs.*, node_run_payloads.input_json, node_run_payloads.output_json, node_run_payloads.raw_result_json
         FROM node_runs
         LEFT JOIN node_run_payloads ON node_run_payloads.node_run_id = node_runs.id
         WHERE node_runs.id = ?`
      ).get(input.nodeRunId) as Row;
      return {
        claimed: true,
        nodeRun: nodeRunFromRow(row),
        workerEpoch: readNumber(row.worker_epoch, 0),
        leaseExpiresAt
      };
    });
  }

  async renewNodeRunLease(input: { nodeRunId: string; owner: string; workerEpoch: number; leaseMs: number }): Promise<boolean> {
    return this.driver.transaction(() => {
      const now = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + input.leaseMs).toISOString();
      const result = this.driver.db.prepare(
        `UPDATE node_runs
         SET lease_expires_at = ?,
             row_version = row_version + 1,
             updated_at = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND worker_epoch = ?
           AND lease_expires_at > ?`
      ).run(leaseExpiresAt, now, input.nodeRunId, input.owner, input.workerEpoch, now);
      return result.changes === 1;
    });
  }

  async startNodeRun(input: { nodeRunId: string; owner: string; workerEpoch: number; startedAt?: string; input?: unknown; runtimeRef?: BlueprintNodeRun["runtimeRef"] }): Promise<boolean> {
    return this.driver.transaction(() => {
      const now = new Date().toISOString();
      const result = this.driver.db.prepare(
        `UPDATE node_runs
         SET started_at = COALESCE(started_at, ?),
             openclaw_ref_json = COALESCE(?, openclaw_ref_json),
             row_version = row_version + 1,
             updated_at = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND worker_epoch = ?
           AND lease_expires_at > ?`
      ).run(input.startedAt ?? now, optionalJson(input.runtimeRef), now, input.nodeRunId, input.owner, input.workerEpoch, now);
      if (result.changes !== 1) return false;
      if (input.input !== undefined) {
        this.driver.db.prepare(
          `INSERT INTO node_run_payloads (node_run_id, input_json, output_json, raw_result_json, updated_at)
           VALUES (?, ?, NULL, NULL, ?)
           ON CONFLICT(node_run_id) DO UPDATE SET
             input_json = excluded.input_json,
             updated_at = excluded.updated_at`
        ).run(input.nodeRunId, optionalJson(input.input), now);
      }
      return true;
    });
  }

  async completeNodeRun(input: CompleteNodeRunInput): Promise<boolean> {
    return this.driver.transaction(() => {
      const now = new Date().toISOString();
      const completed: BlueprintNodeRun = {
        ...input.nodeRun,
        status: "succeeded",
        endedAt: input.nodeRun.endedAt ?? now
      };
      const result = this.driver.db.prepare(
        `UPDATE node_runs
         SET status = 'succeeded',
             ended_at = ?,
             error = NULL,
             usage_json = ?,
             openclaw_ref_json = ?,
             row_version = row_version + 1,
             updated_at = ?
          WHERE id = ?
            AND status = 'running'
            AND lease_owner = ?
            AND worker_epoch = ?
            AND lease_expires_at > ?`
      ).run(
        completed.endedAt,
        optionalJson(completed.usage),
        optionalJson(readBlueprintNodeRunRuntimeRef(completed)),
        now,
        input.nodeRunId,
        input.owner,
        input.workerEpoch,
        now
      );
      if (result.changes !== 1) return false;
      this.driver.db.prepare(
        `INSERT INTO node_run_payloads (node_run_id, input_json, output_json, raw_result_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_run_id) DO UPDATE SET
           input_json = excluded.input_json,
           output_json = excluded.output_json,
           raw_result_json = excluded.raw_result_json,
           updated_at = excluded.updated_at`
      ).run(completed.id, optionalJson(completed.input), optionalJson(completed.output), optionalJson(completed.output), now);
      this.upsertAgentOutputFromNodeRun(completed, now);
      this.refreshRunFacts(completed.blueprintRunId);
      return true;
    });
  }

  async failNodeRun(input: FailNodeRunInput): Promise<boolean> {
    return this.driver.transaction(() => {
      const now = new Date().toISOString();
      const result = this.driver.db.prepare(
        `UPDATE node_runs
         SET status = 'failed',
             ended_at = ?,
             error = ?,
             row_version = row_version + 1,
             updated_at = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND worker_epoch = ?
           AND lease_expires_at > ?`
      ).run(input.endedAt ?? now, input.error, now, input.nodeRunId, input.owner, input.workerEpoch, now);
      if (result.changes !== 1) return false;
      const row = this.driver.db.prepare("SELECT run_id FROM node_runs WHERE id = ?").get(input.nodeRunId) as Row | undefined;
      if (row) this.refreshRunFacts(requireString(row.run_id));
      return true;
    });
  }

  async cancelNodeRun(input: CancelNodeRunInput): Promise<boolean> {
    return this.driver.transaction(() => {
      const now = new Date().toISOString();
      const result = this.driver.db.prepare(
        `UPDATE node_runs
         SET status = 'cancelled',
             ended_at = ?,
             error = ?,
             openclaw_ref_json = COALESCE(?, openclaw_ref_json),
             row_version = row_version + 1,
             updated_at = ?
         WHERE id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND worker_epoch = ?
           AND lease_expires_at > ?`
      ).run(input.endedAt ?? now, input.reason, optionalJson(input.runtimeRef), now, input.nodeRunId, input.owner, input.workerEpoch, now);
      if (result.changes !== 1) return false;
      const row = this.driver.db.prepare("SELECT run_id FROM node_runs WHERE id = ?").get(input.nodeRunId) as Row | undefined;
      if (row) this.refreshRunFacts(requireString(row.run_id));
      return true;
    });
  }

  async publishAgentOutput(input: PublishAgentOutputInput): Promise<PublishAgentOutputResult> {
    return this.driver.transaction(() => {
      const nodeRun: BlueprintNodeRun = {
        ...input.nodeRun,
        status: "succeeded",
        endedAt: input.nodeRun.endedAt ?? new Date().toISOString(),
        output: input.output,
        usage: input.nodeRun.usage,
        runtimeRef: readBlueprintNodeRunRuntimeRef(input.nodeRun)
      };
      const completed = this.completeNodeRunSync({
        nodeRunId: input.nodeRunId,
        owner: input.owner,
        workerEpoch: input.workerEpoch,
        nodeRun,
        rawResult: input.rawResult
      });
      if (!completed) return { published: false };
      for (const artifact of input.artifacts) this.upsertArtifactSync(artifact);
      if (input.humanReport) this.upsertAgentHumanReportSync(input.humanReport);
      if (input.handoff) this.upsertAgentHandoffSync(input.handoff);
      this.appendEventSync(input.event);
      for (const item of input.timelineItems ?? []) this.appendRunTimelineItemSync(item);
      this.refreshRunFacts(input.runId);
      return { published: true };
    });
  }

  private completeNodeRunSync(input: CompleteNodeRunInput & { rawResult?: unknown }): boolean {
    const now = new Date().toISOString();
    const completed: BlueprintNodeRun = {
      ...input.nodeRun,
      status: "succeeded",
      endedAt: input.nodeRun.endedAt ?? now
    };
    const result = this.driver.db.prepare(
      `UPDATE node_runs
       SET status = 'succeeded',
           ended_at = ?,
           error = NULL,
           usage_json = ?,
           openclaw_ref_json = ?,
           row_version = row_version + 1,
           updated_at = ?
       WHERE id = ?
         AND status = 'running'
         AND lease_owner = ?
         AND worker_epoch = ?
         AND lease_expires_at > ?`
    ).run(
      completed.endedAt,
      optionalJson(completed.usage),
      optionalJson(readBlueprintNodeRunRuntimeRef(completed)),
      now,
      input.nodeRunId,
      input.owner,
      input.workerEpoch,
      now
    );
    if (result.changes !== 1) return false;
    this.driver.db.prepare(
      `INSERT INTO node_run_payloads (node_run_id, input_json, output_json, raw_result_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_run_id) DO UPDATE SET
         input_json = excluded.input_json,
         output_json = excluded.output_json,
         raw_result_json = excluded.raw_result_json,
         updated_at = excluded.updated_at`
    ).run(completed.id, optionalJson(completed.input), optionalJson(completed.output), optionalJson(input.rawResult ?? completed.output), now);
    this.upsertAgentOutputFromNodeRun(completed, now);
    return true;
  }

  private async seedDefaults(): Promise<void> {
    const now = new Date().toISOString();
    const companies = createDefaultCompanies(now);
    const companyId = companies[0]?.id ?? defaultCompanyId;
    const blueprints = createDefaultBlueprints(now, companyId);
    this.driver.transaction(() => {
      for (const company of companies) {
        this.upsertCompany(company);
        this.upsertDashboard(company.id, createDefaultWorkspaceDashboard(now));
      }
      this.setSelectedCompanyId(companyId, now);
      for (const blueprint of blueprints) {
        this.upsertBlueprint(blueprint);
      }
      this.upsertRoleDirectory(buildRoleDirectory(this.readIndexSnapshot(), companyId, now));
    });
    await Promise.all(blueprints.map((blueprint) => this.writeBlueprintWorkspace(blueprint)));
  }

  private countRows(table: string): number {
    return Number((this.driver.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count ?? 0);
  }

  private readIndexSnapshot(): HivewardStoreIndex {
    const companies = this.listCompanyProfiles();
    const primaryCompanyId = companies[0]?.id ?? defaultCompanyId;
    const selectedCompanyId = this.getSelectedCompanyId() ?? primaryCompanyId ?? null;
    const blueprintIndex = (this.driver.db.prepare("SELECT * FROM blueprints").all() as Row[]).map((row) => ({
      id: requireString(row.id),
      companyId: requireString(row.company_id),
      name: requireString(row.name),
      description: readString(row.description),
      version: readNumber(row.current_version, 1),
      createdAt: requireString(row.created_at),
      updatedAt: requireString(row.updated_at)
    }));
    const runIndex = (this.driver.db.prepare("SELECT * FROM runs").all() as Row[]).map(runSummaryFromRow);
    const companyDashboards: Record<string, WorkspaceDashboard> = {};
    const roleDirectories: Record<string, CompanyRoleDirectory> = {};
    for (const company of companies) {
      companyDashboards[company.id] = this.getDashboard(company.id) ?? createDefaultWorkspaceDashboard(new Date().toISOString());
      const directory = this.getStoredRoleDirectory(company.id);
      if (directory) roleDirectories[company.id] = directory;
    }
    const inboxItems: Record<string, InboxItem[]> = {};
    for (const company of companies) {
      inboxItems[company.id] = this.readInboxItems("WHERE company_id = ?", [company.id]);
    }
    return {
      schema: "hiveward.store-index/v1",
      companies,
      selectedCompanyId,
      blueprintIndex,
      runIndex,
      catalogSnapshot: this.getSetting<CatalogSnapshot>(catalogSnapshotSettingKey),
      companyDashboards,
      roleDirectories,
      inboxItems,
      iterationSessions: (this.driver.db.prepare("SELECT * FROM iteration_sessions").all() as Row[]).map(iterationSessionFromRow),
      iterationRounds: (this.driver.db.prepare("SELECT * FROM iteration_rounds").all() as Row[]).map(iterationRoundFromRow),
      approvalRequests: (this.driver.db.prepare("SELECT * FROM approval_requests").all() as Row[]).map(approvalRequestFromRow),
      approvalDecisions: (this.driver.db.prepare("SELECT * FROM approval_decisions").all() as Row[]).map(approvalDecisionFromRow),
      artifacts: (this.driver.db.prepare("SELECT * FROM artifacts").all() as Row[]).map(artifactFromRow),
      releaseReports: (this.driver.db.prepare("SELECT * FROM release_reports").all() as Row[]).map((row) => this.releaseReportFromRow(row)),
      agentHumanReports: (this.driver.db.prepare("SELECT * FROM agent_human_reports").all() as Row[]).map(agentHumanReportFromRow),
      agentHandoffs: (this.driver.db.prepare("SELECT * FROM agent_handoffs").all() as Row[]).map(agentHandoffFromRow),
      managerContextSnapshots: (this.driver.db.prepare("SELECT * FROM manager_context_snapshots").all() as Row[]).map(managerContextSnapshotFromRow),
      runTimeline: (this.driver.db.prepare("SELECT * FROM run_timeline_items").all() as Row[]).map(runTimelineItemFromRow),
      managerMail: (this.driver.db.prepare("SELECT * FROM manager_mail").all() as Row[]).map(managerMailFromRow)
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

  private listCompanyProfiles(): CompanyProfile[] {
    return (this.driver.db.prepare("SELECT * FROM companies ORDER BY created_at").all() as Row[]).map(companyFromRow);
  }

  private getCompany(id: string): CompanyProfile | undefined {
    const row = this.driver.db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Row | undefined;
    return row ? companyFromRow(row) : undefined;
  }

  private requireCompany(id: string): CompanyProfile {
    const company = this.getCompany(id);
    if (!company) throw new Error(`Company not found: ${id}`);
    return company;
  }

  private upsertCompany(company: CompanyProfile): void {
    this.driver.db.prepare(
      `INSERT INTO companies (id, name, logo_label, logo_url, business_goal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         logo_label = excluded.logo_label,
         logo_url = excluded.logo_url,
         business_goal = excluded.business_goal,
         updated_at = excluded.updated_at`
    ).run(company.id, company.name, company.logoLabel, company.logoUrl, company.businessGoal, company.createdAt, company.updatedAt);
  }

  private getSelectedCompanyId(): string | undefined {
    const value = this.getSetting<string | null>(selectedCompanySettingKey);
    return typeof value === "string" && value ? value : undefined;
  }

  private requireSelectedCompanyId(): string {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) throw new Error("No company selected.");
    return companyId;
  }

  private setSelectedCompanyId(companyId: string | null, now: string): void {
    this.setSetting(selectedCompanySettingKey, companyId, now);
  }

  private setSetting(key: string, value: unknown, now: string): void {
    this.driver.db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run(key, stringifyJson(value), now);
  }

  private getSetting<T>(key: string): T | undefined {
    const row = this.driver.db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key) as Row | undefined;
    return row ? readJson<T>(row.value_json) : undefined;
  }

  private getDashboard(companyId: string): WorkspaceDashboard | undefined {
    const row = this.driver.db.prepare("SELECT dashboard_json FROM workspace_dashboards WHERE company_id = ?").get(companyId) as Row | undefined;
    return row ? readJson<WorkspaceDashboard>(row.dashboard_json) : undefined;
  }

  private upsertDashboard(companyId: string, dashboard: WorkspaceDashboard): void {
    this.driver.db.prepare(
      `INSERT INTO workspace_dashboards (company_id, dashboard_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(company_id) DO UPDATE SET dashboard_json = excluded.dashboard_json, updated_at = excluded.updated_at`
    ).run(companyId, stringifyJson(dashboard), dashboard.updatedAt);
  }

  private getStoredRoleDirectory(companyId: string): CompanyRoleDirectory | undefined {
    const row = this.driver.db.prepare("SELECT directory_json FROM role_directories WHERE company_id = ?").get(companyId) as Row | undefined;
    return row ? readJson<CompanyRoleDirectory>(row.directory_json) : undefined;
  }

  private upsertRoleDirectory(directory: CompanyRoleDirectory): void {
    this.driver.db.prepare(
      `INSERT INTO role_directories (company_id, directory_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(company_id) DO UPDATE SET directory_json = excluded.directory_json, updated_at = excluded.updated_at`
    ).run(directory.companyId, stringifyJson(directory), directory.updatedAt);
    for (const binding of directory.driverBindings) {
      this.driver.db.prepare(
        `INSERT INTO role_driver_bindings (company_id, role_id, runtime_id, model_id, binding_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_id, role_id) DO UPDATE SET
           runtime_id = excluded.runtime_id,
           model_id = excluded.model_id,
           binding_json = excluded.binding_json,
           updated_at = excluded.updated_at`
      ).run(directory.companyId, binding.roleId, binding.harnessId, binding.modelId, stringifyJson(binding), binding.updatedAt);
    }
  }

  private selectBlueprintRows(where = "", values: unknown[] = []): Row[] {
    return this.driver.db.prepare(
      `SELECT b.*, bv.definition_json
       FROM blueprints b
       JOIN blueprint_versions bv ON bv.id = b.current_version_id
       ${where}
       ORDER BY b.name`
    ).all(...values) as Row[];
  }

  private getBlueprintIndexEntry(id: string, companyId: string): ReturnType<typeof toBlueprintIndexEntry> | undefined {
    const row = this.driver.db.prepare("SELECT * FROM blueprints WHERE id = ? AND company_id = ?").get(id, companyId) as Row | undefined;
    return row
      ? {
          id: requireString(row.id),
          companyId: requireString(row.company_id),
          name: requireString(row.name),
          description: readString(row.description),
          version: readNumber(row.current_version, 1),
          createdAt: requireString(row.created_at),
          updatedAt: requireString(row.updated_at)
        }
      : undefined;
  }

  private upsertBlueprint(blueprint: BlueprintDefinition): void {
    const versionId = `${blueprint.id}:v${blueprint.version}`;
    this.driver.db.prepare(
      `INSERT INTO blueprints (id, company_id, name, description, current_version, current_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         company_id = excluded.company_id,
         name = excluded.name,
         description = excluded.description,
         current_version = excluded.current_version,
         current_version_id = excluded.current_version_id,
         updated_at = excluded.updated_at`
    ).run(blueprint.id, blueprint.companyId, blueprint.name, blueprint.description, blueprint.version, versionId, blueprint.createdAt, blueprint.updatedAt);
    this.driver.db.prepare(
      `INSERT INTO blueprint_versions (id, blueprint_id, version, definition_json, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(blueprint_id, version) DO UPDATE SET
         definition_json = excluded.definition_json,
         sha256 = excluded.sha256`
    ).run(versionId, blueprint.id, blueprint.version, stringifyJson(blueprint), sha256Json(blueprint), blueprint.updatedAt);
  }

  private currentBlueprintVersionId(blueprintId: string): string | undefined {
    const row = this.driver.db.prepare("SELECT current_version_id FROM blueprints WHERE id = ?").get(blueprintId) as Row | undefined;
    return readString(row?.current_version_id);
  }

  private importBlueprintPackageTx(blueprintPackage: PortableBlueprintPackage, defaults: BlueprintImportDefaults): BlueprintDefinition[] {
    const companyId = this.requireSelectedCompanyId();
    const now = new Date().toISOString();
    const index = this.readIndexSnapshot();
    const imported: BlueprintDefinition[] = [];
    const knownBlueprints = [...index.blueprintIndex];
    let replacementUsed = false;
    for (const portableBlueprint of blueprintPackage.blueprints) {
      const replacementIndex = !replacementUsed && defaults.replaceBlueprintId
        ? knownBlueprints.findIndex((entry) => entry.companyId === companyId && entry.id === defaults.replaceBlueprintId)
        : -1;
      const replacementEntry = replacementIndex >= 0 ? knownBlueprints[replacementIndex] : undefined;
      const blueprint = hydrateImportedBlueprint(portableBlueprint, {
        id: replacementEntry?.id ?? nextBlueprintId(knownBlueprints),
        companyId,
        now,
        defaults,
        name: replacementEntry ? portableBlueprint.name : nextImportedBlueprintName(knownBlueprints, portableBlueprint.name)
      });
      const importedBlueprint = replacementEntry
        ? { ...blueprint, version: replacementEntry.version + 1, createdAt: replacementEntry.createdAt }
        : blueprint;
      this.upsertBlueprint(importedBlueprint);
      const entry = toBlueprintIndexEntry(importedBlueprint);
      if (replacementIndex >= 0) {
        knownBlueprints[replacementIndex] = entry;
        replacementUsed = true;
      } else {
        knownBlueprints.push(entry);
      }
      imported.push(importedBlueprint);
    }
    this.upsertRoleDirectory(buildRoleDirectory(this.readIndexSnapshot(), companyId, now));
    return imported;
  }

  private async writeBlueprintWorkspace(blueprint: BlueprintDefinition): Promise<void> {
    const workspacePath = this.getBlueprintWorkspacePath(blueprint.id);
    await Promise.all([
      mkdir(join(workspacePath, "blueprints"), { recursive: true }),
      mkdir(join(workspacePath, "skills"), { recursive: true }),
      mkdir(join(workspacePath, "mcp"), { recursive: true }),
      mkdir(join(workspacePath, "scripts"), { recursive: true }),
      mkdir(join(workspacePath, "artifacts"), { recursive: true }),
      mkdir(join(workspacePath, "tmp"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(workspacePath, "BLUEPRINT.md"), buildBlueprintEntryMarkdown(blueprint), "utf8"),
      writeJson(join(workspacePath, "manifest.json"), buildBlueprintWorkspaceManifest(blueprint)),
      writeJson(join(workspacePath, "blueprints", `${blueprint.id}.json`), blueprint)
    ]);
  }

  private upsertInboxItem(item: InboxItem): void {
    this.driver.db.prepare(
      `INSERT INTO inbox_items (
        id, company_id, type, status, title, summary, created_by_role_id,
        target_role_id, blueprint_id, blueprint_name, payload_json, created_at,
        updated_at, decided_at, decision_comment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        title = excluded.title,
        summary = excluded.summary,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        decided_at = excluded.decided_at,
        decision_comment = excluded.decision_comment`
    ).run(
      item.id,
      item.companyId,
      item.type,
      item.status,
      item.title,
      item.summary,
      item.createdByRoleId,
      item.targetRoleId,
      item.blueprintId,
      item.blueprintName,
      optionalJson(item.payload),
      item.createdAt,
      item.updatedAt,
      item.decidedAt,
      item.decisionComment
    );
  }

  private readInboxItems(where = "", values: unknown[] = []): InboxItem[] {
    return (this.driver.db.prepare(`SELECT * FROM inbox_items ${where}`).all(...values) as Row[]).map((row) => ({
      id: requireString(row.id),
      companyId: requireString(row.company_id),
      type: normalizeInboxItemType(row.type),
      status: row.status === "approved" || row.status === "rejected" ? row.status : "pending",
      title: requireString(row.title),
      summary: requireString(row.summary),
      createdByRoleId: requireString(row.created_by_role_id),
      targetRoleId: readString(row.target_role_id),
      blueprintId: readString(row.blueprint_id),
      blueprintName: readString(row.blueprint_name),
      payload: parseOptionalJson(row.payload_json) as Record<string, unknown> | undefined,
      createdAt: requireString(row.created_at),
      updatedAt: requireString(row.updated_at),
      decidedAt: readString(row.decided_at),
      decisionComment: readString(row.decision_comment),
      replies: this.readInboxReplies(requireString(row.id))
    }));
  }

  private readInboxReplies(itemId: string): InboxItem["replies"] {
    const replies = (this.driver.db.prepare("SELECT * FROM inbox_replies WHERE inbox_item_id = ? ORDER BY created_at").all(itemId) as Row[])
      .map((row) => ({
        id: requireString(row.id),
        role: "user" as const,
        body: requireString(row.message),
        createdAt: requireString(row.created_at)
      }));
    return replies.length ? replies : undefined;
  }

  private replaceInboxReplies(item: InboxItem): void {
    this.driver.db.prepare("DELETE FROM inbox_replies WHERE inbox_item_id = ?").run(item.id);
    for (const reply of item.replies ?? []) {
      this.driver.db.prepare(
        `INSERT INTO inbox_replies (id, inbox_item_id, message, created_at) VALUES (?, ?, ?, ?)`
      ).run(reply.id, item.id, reply.body, reply.createdAt);
    }
  }

  private requireInboxItem(itemId: string): InboxItem {
    const item = this.readInboxItems("WHERE id = ?", [itemId])[0];
    if (!item) throw new Error(`Inbox item not found: ${itemId}`);
    return item;
  }

  private upsertRun(run: BlueprintRunSummary): void {
    const now = new Date().toISOString();
    this.driver.db.prepare(
      `INSERT INTO runs (
        id, company_id, blueprint_id, blueprint_version_id, blueprint_name, blueprint_version,
        status, started_by, started_at, ended_at, duration_ms, total_input_tokens,
        total_output_tokens, total_cost_usd, openclaw_refs_json, final_result_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        ended_at = excluded.ended_at,
        duration_ms = excluded.duration_ms,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cost_usd = excluded.total_cost_usd,
        openclaw_refs_json = excluded.openclaw_refs_json,
        final_result_json = excluded.final_result_json,
        row_version = runs.row_version + 1,
        updated_at = excluded.updated_at`
    ).run(
      run.id,
      run.companyId,
      run.blueprintId,
      this.currentBlueprintVersionId(run.blueprintId),
      run.blueprintName,
      run.blueprintVersion,
      run.status,
      run.startedBy,
      run.startedAt,
      run.endedAt,
      run.durationMs,
      run.totalInputTokens,
      run.totalOutputTokens,
      run.totalCostUsd,
      stringifyJson(readBlueprintRunRuntimeRefs(run)),
      null,
      now
    );
  }

  private refreshRunFacts(runId: string): void {
    const archive = this.requireRunArchive(runId);
    const run = applyNodeRunFactsToRun(archive.run, archive.nodeRuns);
    this.upsertRun(run);
  }

  private requireRunRow(runId: string): Row {
    const row = this.driver.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Row | undefined;
    if (!row) throw new Error(`Blueprint run not found: ${runId}`);
    return row;
  }

  private requireRunArchive(runId: string): BlueprintRunArchive {
    const row = this.requireRunRow(runId);
    const run = runSummaryFromRow(row);
    const snapshotRow = this.driver.db.prepare("SELECT * FROM run_blueprint_snapshots WHERE run_id = ?").get(run.id) as Row | undefined;
    const blueprintSnapshot = snapshotRow
      ? readJson<BlueprintDefinition>(snapshotRow.definition_json)
      : createArchivePlaceholderBlueprint(run, new Date().toISOString());
    const nodeRuns = this.readNodeRuns(run.id);
    return stripRemovedBlueprintRunArchive({
      schema: blueprintRunArchiveSchema,
      run,
      blueprintSnapshot,
      nodeRuns,
      events: this.readEvents(run.id),
      finalResult: resolveFinalRunResult(blueprintSnapshot, nodeRuns, run.status)
    });
  }

  private importArchive(archive: BlueprintRunArchive): void {
    const sanitized = stripRemovedBlueprintRunArchive(archive);
    this.upsertRun(sanitized.run);
    this.driver.db.prepare(
      `INSERT INTO run_blueprint_snapshots (run_id, blueprint_version_id, definition_json, sha256, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         blueprint_version_id = excluded.blueprint_version_id,
         definition_json = excluded.definition_json,
         sha256 = excluded.sha256`
    ).run(
      sanitized.run.id,
      this.currentBlueprintVersionId(sanitized.blueprintSnapshot.id),
      stringifyJson(sanitized.blueprintSnapshot),
      sha256Json(sanitized.blueprintSnapshot),
      sanitized.run.startedAt
    );
    for (const nodeRun of sanitized.nodeRuns) {
      const now = nodeRun.endedAt ?? nodeRun.startedAt ?? nodeRun.queuedAt;
      this.driver.db.prepare(
        `INSERT INTO node_runs (
          id, run_id, blueprint_id, node_id, node_label, node_type, iteration_round_id, status,
          queued_at, started_at, ended_at, error, usage_json, openclaw_ref_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          error = excluded.error,
          usage_json = excluded.usage_json,
          openclaw_ref_json = excluded.openclaw_ref_json,
          updated_at = excluded.updated_at`
      ).run(
        nodeRun.id,
        nodeRun.blueprintRunId,
        nodeRun.blueprintId,
        nodeRun.nodeId,
        nodeRun.nodeLabel,
        nodeRun.nodeType,
        nodeRun.iterationRoundId,
        nodeRun.status,
        nodeRun.queuedAt,
        nodeRun.startedAt,
        nodeRun.endedAt,
        nodeRun.error,
        optionalJson(nodeRun.usage),
        optionalJson(readBlueprintNodeRunRuntimeRef(nodeRun)),
        now
      );
      this.driver.db.prepare(
        `INSERT INTO node_run_payloads (node_run_id, input_json, output_json, raw_result_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_run_id) DO UPDATE SET
           input_json = excluded.input_json,
           output_json = excluded.output_json,
           raw_result_json = excluded.raw_result_json,
           updated_at = excluded.updated_at`
      ).run(nodeRun.id, optionalJson(nodeRun.input), optionalJson(nodeRun.output), optionalJson(nodeRun.output), now);
      this.upsertAgentOutputFromNodeRun(nodeRun, now);
    }
    for (const event of sanitized.events) {
      this.driver.db.prepare(
        `INSERT INTO run_events (id, run_id, node_run_id, sequence, type, message, openclaw_ref_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           message = excluded.message,
           openclaw_ref_json = excluded.openclaw_ref_json,
           created_at = excluded.created_at`
      ).run(
        event.id,
        event.blueprintRunId,
        event.nodeRunId,
        this.nextEventSequence(event.blueprintRunId),
        event.type,
        event.message,
        optionalJson(readBlueprintNodeEventRuntimeRef(event)),
        event.createdAt
      );
    }
  }

  private runViewFromRunRow(row: Row): BlueprintRunView {
    const archive = this.requireRunArchive(requireString(row.id));
    const runId = archive.run.id;
    const approvalRequests = (this.driver.db.prepare("SELECT * FROM approval_requests WHERE run_id = ?").all(runId) as Row[]).map(approvalRequestFromRow);
    const approvalIds = new Set(approvalRequests.map((request) => request.id));
    return {
      run: archive.run,
      nodeRuns: archive.nodeRuns,
      events: archive.events,
      finalResult: archive.finalResult,
      iterationSessions: (this.driver.db.prepare("SELECT * FROM iteration_sessions WHERE run_id = ?").all(runId) as Row[]).map(iterationSessionFromRow),
      iterationRounds: (this.driver.db.prepare("SELECT * FROM iteration_rounds WHERE run_id = ?").all(runId) as Row[]).map(iterationRoundFromRow),
      approvalRequests,
      approvalDecisions: (this.driver.db.prepare("SELECT * FROM approval_decisions ORDER BY created_at").all() as Row[])
        .map(approvalDecisionFromRow)
        .filter((decision) => approvalIds.has(decision.approvalRequestId)),
      artifacts: (this.driver.db.prepare("SELECT * FROM artifacts WHERE run_id = ?").all(runId) as Row[]).map(artifactFromRow),
      releaseReports: (this.driver.db.prepare("SELECT * FROM release_reports WHERE run_id = ?").all(runId) as Row[]).map((reportRow) => this.releaseReportFromRow(reportRow)),
      agentHumanReports: (this.driver.db.prepare("SELECT * FROM agent_human_reports WHERE run_id = ?").all(runId) as Row[]).map(agentHumanReportFromRow),
      agentHandoffs: (this.driver.db.prepare("SELECT * FROM agent_handoffs WHERE run_id = ?").all(runId) as Row[]).map(agentHandoffFromRow),
      managerContextSnapshots: (this.driver.db.prepare("SELECT * FROM manager_context_snapshots WHERE run_id = ?").all(runId) as Row[]).map(managerContextSnapshotFromRow),
      runTimeline: (this.driver.db.prepare("SELECT * FROM run_timeline_items WHERE run_id = ? ORDER BY sequence").all(runId) as Row[]).map(runTimelineItemFromRow),
      managerMail: (this.driver.db.prepare("SELECT * FROM manager_mail WHERE related_run_id = ?").all(runId) as Row[]).map(managerMailFromRow)
    };
  }

  private readNodeRuns(runId: string): BlueprintNodeRun[] {
    return (this.driver.db.prepare(
      `SELECT nr.*, p.input_json, p.output_json
       FROM node_runs nr
       LEFT JOIN node_run_payloads p ON p.node_run_id = nr.id
       WHERE nr.run_id = ?
       ORDER BY nr.queued_at, nr.id`
    ).all(runId) as Row[]).map(nodeRunFromRow);
  }

  private nodeRunExists(id: string): boolean {
    return Boolean(this.driver.db.prepare("SELECT 1 FROM node_runs WHERE id = ?").get(id));
  }

  private readEvents(runId: string): BlueprintNodeEvent[] {
    return (this.driver.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence").all(runId) as Row[])
      .map(eventFromRow);
  }

  private nextEventSequence(runId: string): number {
    return this.claimRunSequence(runId, "event");
  }

  private nextTimelineSequence(runId: string): number {
    return this.claimRunSequence(runId, "timeline");
  }

  private claimRunSequence(runId: string, scope: "event" | "timeline"): number {
    const table = scope === "event" ? "run_events" : "run_timeline_items";
    const now = new Date().toISOString();
    const row = this.driver.db.prepare(
      `INSERT INTO run_sequence_counters (run_id, scope, last_sequence, updated_at)
       VALUES (?, ?, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM ${table} WHERE run_id = ?), ?)
       ON CONFLICT(run_id, scope) DO UPDATE SET
         last_sequence = MAX(last_sequence, excluded.last_sequence - 1) + 1,
         updated_at = excluded.updated_at
       RETURNING last_sequence`
    ).get(runId, scope, runId, now) as Row;
    return readNumber(row.last_sequence, 1);
  }

  private rememberRunSequence(runId: string, scope: "event" | "timeline", sequence: number): void {
    const now = new Date().toISOString();
    this.driver.db.prepare(
      `INSERT INTO run_sequence_counters (run_id, scope, last_sequence, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id, scope) DO UPDATE SET
         last_sequence = MAX(last_sequence, excluded.last_sequence),
         updated_at = excluded.updated_at`
    ).run(runId, scope, sequence, now);
  }

  private appendEventSync(event: BlueprintNodeEvent): void {
    const sequence = this.nextEventSequence(event.blueprintRunId);
    this.driver.db.prepare(
      `INSERT INTO run_events (id, run_id, node_run_id, sequence, type, message, openclaw_ref_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         node_run_id = excluded.node_run_id,
         type = excluded.type,
         message = excluded.message,
         openclaw_ref_json = excluded.openclaw_ref_json,
         created_at = excluded.created_at`
    ).run(
      event.id,
      event.blueprintRunId,
      event.nodeRunId,
      sequence,
      event.type,
      event.message,
      optionalJson(readBlueprintNodeEventRuntimeRef(event)),
      event.createdAt
    );
  }

  private appendRunTimelineItemSync(item: Omit<RunTimelineItem, "sequence"> & { sequence?: number }): RunTimelineItem {
    const sequence = item.sequence ?? this.nextTimelineSequence(item.runId);
    if (item.sequence !== undefined) this.rememberRunSequence(item.runId, "timeline", item.sequence);
    const timelineItem: RunTimelineItem = { ...item, sequence };
    this.driver.db.prepare(
      `INSERT INTO run_timeline_items (id, run_id, sequence, created_at, actor_node_id, actor_label, kind, title, body, payload_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         payload_ref = excluded.payload_ref`
    ).run(
      timelineItem.id,
      timelineItem.runId,
      timelineItem.sequence,
      timelineItem.createdAt,
      timelineItem.actorNodeId,
      timelineItem.actorLabel,
      timelineItem.kind,
      timelineItem.title,
      timelineItem.body,
      timelineItem.payloadRef
    );
    return timelineItem;
  }

  private upsertAgentOutputFromNodeRun(nodeRun: BlueprintNodeRun, createdAt: string): void {
    const envelope = normalizeAgentOutputEnvelope(nodeRun.output);
    if (!envelope) return;
    this.driver.db.prepare(
      `INSERT INTO agent_outputs (id, run_id, round_id, node_run_id, node_id, envelope_json, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_run_id) DO UPDATE SET
         envelope_json = excluded.envelope_json,
         result_json = excluded.result_json`
    ).run(
      `agent-output-${nodeRun.id}`,
      nodeRun.blueprintRunId,
      nodeRun.iterationRoundId,
      nodeRun.id,
      nodeRun.nodeId,
      stringifyJson(envelope),
      optionalJson(envelope.result),
      createdAt
    );
  }

  private releaseReportFromRow(row: Row): ReleaseReport {
    const artifactRefs = (this.driver.db.prepare("SELECT * FROM release_report_artifacts WHERE release_report_id = ? ORDER BY position ASC, artifact_id ASC").all(row.id) as Row[])
      .map((refRow) => ({
        artifactId: requireString(refRow.artifact_id),
        title: requireString(refRow.title),
        location: requireString(refRow.location),
        current: Boolean(refRow.current)
      }));
    return {
      id: requireString(row.id),
      runId: requireString(row.run_id),
      roundId: requireString(row.round_id),
      approvalRequestId: requireString(row.approval_request_id),
      version: readNumber(row.version, 1),
      title: requireString(row.title),
      summary: requireString(row.summary),
      artifactRefs,
      supersedesReportId: readString(row.supersedes_report_id),
      createdAt: requireString(row.created_at)
    };
  }

  private upsertChatSession(session: HivewardChatSession): void {
    this.driver.db.prepare(
      `INSERT INTO chat_sessions (
        id, company_id, harness_id, native_session_id, native_session_state, title,
        role_scope_json, model_id, agent_id, thinking_effort, permission_mode, mode,
        status, created_at, updated_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        native_session_id = excluded.native_session_id,
        native_session_state = excluded.native_session_state,
        title = excluded.title,
        role_scope_json = excluded.role_scope_json,
        model_id = excluded.model_id,
        agent_id = excluded.agent_id,
        thinking_effort = excluded.thinking_effort,
        permission_mode = excluded.permission_mode,
        mode = excluded.mode,
        status = excluded.status,
        updated_at = excluded.updated_at,
        ended_at = excluded.ended_at`
    ).run(
      session.id,
      session.companyId,
      session.harnessId,
      session.nativeSessionId,
      session.nativeSessionState,
      session.title,
      optionalJson(session.roleScope),
      session.modelId,
      session.agentId,
      session.thinkingEffort,
      session.permissionMode,
      session.mode,
      session.status,
      session.createdAt,
      session.updatedAt,
      session.endedAt
    );
  }

  private getChatSessionSync(id: string): HivewardChatSession | undefined {
    const companyId = this.getSelectedCompanyId();
    if (!companyId) return undefined;
    const row = this.driver.db.prepare("SELECT * FROM chat_sessions WHERE id = ? AND company_id = ?").get(id, companyId) as Row | undefined;
    return row ? chatSessionFromRow(row) : undefined;
  }

  private upsertChatMessage(message: HivewardChatMessage): void {
    this.driver.db.prepare(
      `INSERT INTO chat_messages (
        id, session_id, role, content, status, harness_id, model_id, native_message_id,
        runtime_ref_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        status = excluded.status,
        model_id = excluded.model_id,
        native_message_id = excluded.native_message_id,
        runtime_ref_json = excluded.runtime_ref_json,
        updated_at = excluded.updated_at`
    ).run(
      message.id,
      message.sessionId,
      message.role,
      message.content,
      message.status,
      message.harnessId,
      message.modelId,
      message.nativeMessageId,
      optionalJson(message.runtimeRef),
      message.createdAt,
      message.updatedAt
    );
    this.driver.db.prepare("DELETE FROM chat_attachments WHERE message_id = ?").run(message.id);
    for (const attachment of message.attachments ?? []) {
      this.driver.db.prepare(
        `INSERT INTO chat_attachments (id, message_id, attachment_json, created_at) VALUES (?, ?, ?, ?)`
      ).run(attachment.id, message.id, stringifyJson(attachment), message.createdAt);
    }
  }

  private readChatMessages(sessionId: string): HivewardChatMessage[] {
    return (this.driver.db.prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at").all(sessionId) as Row[])
      .map((row) => ({
        id: requireString(row.id),
        sessionId: requireString(row.session_id),
        role: normalizeChatMessageRole(row.role) ?? "user",
        content: requireString(row.content),
        attachments: this.readChatAttachments(requireString(row.id)),
        harnessId: normalizeHarnessId(row.harness_id),
        modelId: readString(row.model_id),
        nativeMessageId: readString(row.native_message_id),
        status: normalizeChatMessageStatus(row.status) ?? "sent",
        runtimeRef: parseOptionalJson(row.runtime_ref_json) as HivewardChatMessage["runtimeRef"],
        createdAt: requireString(row.created_at),
        updatedAt: readString(row.updated_at)
      }));
  }

  private readChatAttachments(messageId: string): ChatAttachment[] | undefined {
    const attachments = (this.driver.db.prepare("SELECT attachment_json FROM chat_attachments WHERE message_id = ?").all(messageId) as Row[])
      .map((row) => readJson<ChatAttachment>(row.attachment_json));
    return attachments.length ? attachments : undefined;
  }

  private enforceMessageRetention(sessionId: string): void {
    const rows = this.driver.db.prepare(
      `SELECT id FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`
    ).all(sessionId, maxMessagesPerSession) as Row[];
    for (const row of rows) {
      this.driver.db.prepare("DELETE FROM chat_messages WHERE id = ?").run(row.id);
    }
  }
}

function companyFromRow(row: Row): CompanyProfile {
  return {
    id: requireString(row.id),
    name: requireString(row.name),
    logoLabel: readString(row.logo_label),
    logoUrl: readString(row.logo_url),
    businessGoal: readString(row.business_goal) ?? "Coordinate blueprints, governed agent runs, and review gates.",
    createdAt: requireString(row.created_at),
    updatedAt: requireString(row.updated_at)
  };
}

function runFromRow(row: Row): BlueprintRun {
  return {
    id: requireString(row.id),
    companyId: requireString(row.company_id),
    blueprintId: requireString(row.blueprint_id),
    blueprintName: readString(row.blueprint_name),
    blueprintVersion: readNumber(row.blueprint_version, 1),
    status: normalizeRunStatus(row.status),
    startedBy: requireString(row.started_by),
    startedAt: requireString(row.started_at),
    endedAt: readString(row.ended_at),
    durationMs: readNumberOrUndefined(row.duration_ms),
    totalInputTokens: readNumber(row.total_input_tokens, 0),
    totalOutputTokens: readNumber(row.total_output_tokens, 0),
    totalCostUsd: readNumber(row.total_cost_usd, 0),
    runtimeRefs: readJsonArray(row.openclaw_refs_json)
  };
}

function runSummaryFromRow(row: Row): BlueprintRunSummary {
  return {
    ...runFromRow(row),
    blueprintName: readString(row.blueprint_name) ?? requireString(row.blueprint_id)
  };
}

function nodeRunFromRow(row: Row): BlueprintNodeRun {
  return {
    id: requireString(row.id),
    blueprintRunId: requireString(row.run_id),
    blueprintId: requireString(row.blueprint_id),
    nodeId: requireString(row.node_id),
    nodeLabel: requireString(row.node_label),
    nodeType: requireString(row.node_type) as BlueprintNodeRun["nodeType"],
    iterationRoundId: readString(row.iteration_round_id),
    status: normalizeNodeRunStatus(row.status),
    queuedAt: requireString(row.queued_at),
    startedAt: readString(row.started_at),
    endedAt: readString(row.ended_at),
    input: parseOptionalJson(row.input_json),
    output: parseOptionalJson(row.output_json),
    error: readString(row.error),
    usage: parseOptionalJson(row.usage_json) as BlueprintNodeRun["usage"],
    runtimeRef: parseOptionalJson(row.openclaw_ref_json) as BlueprintNodeRun["runtimeRef"]
  };
}

function eventFromRow(row: Row): BlueprintNodeEvent {
  return {
    id: requireString(row.id),
    blueprintRunId: requireString(row.run_id),
    nodeRunId: readString(row.node_run_id),
    type: requireString(row.type) as BlueprintNodeEvent["type"],
    message: requireString(row.message),
    createdAt: requireString(row.created_at),
    runtimeRef: parseOptionalJson(row.openclaw_ref_json) as BlueprintNodeEvent["runtimeRef"]
  };
}

function approvalRequestFromRow(row: Row): ApprovalRequest {
  const sourceType = readString(row.source_type) as NonNullable<ApprovalRequest["sourceRef"]>["type"] | undefined;
  const sourceId = readString(row.source_id);
  return {
    id: requireString(row.id),
    runId: requireString(row.run_id),
    roundId: readString(row.round_id),
    nodeRunId: readString(row.node_run_id),
    kind: requireString(row.kind) as ApprovalRequest["kind"],
    status: requireString(row.status) as ApprovalRequest["status"],
    title: requireString(row.title),
    body: requireString(row.body),
    payloadRef: readString(row.payload_ref),
    sourceRef: sourceType && sourceId ? { type: sourceType, id: sourceId } : undefined,
    threadId: readString(row.thread_id),
    revision: readNumber(row.revision, 1),
    replacesRequestId: readString(row.replaces_request_id),
    supersededByRequestId: readString(row.superseded_by_request_id),
    capabilities: readJson(row.capabilities_json),
    requestedBy: readJson(row.requested_by_json),
    requestedAt: requireString(row.requested_at),
    updatedAt: readString(row.updated_at)
  };
}

function approvalDecisionFromRow(row: Row): ApprovalDecision {
  return {
    id: requireString(row.id),
    approvalRequestId: requireString(row.approval_request_id),
    action: requireString(row.action) as ApprovalDecision["action"],
    actor: requireString(row.actor) as ApprovalDecision["actor"],
    comment: readString(row.comment),
    selectedReplyId: readString(row.selected_reply_id),
    resultingStatus: requireString(row.resulting_status) as ApprovalDecision["resultingStatus"],
    createdAt: requireString(row.created_at)
  };
}

function iterationSessionFromRow(row: Row): IterationSession {
  return {
    id: requireString(row.id),
    runId: requireString(row.run_id),
    topManagerNodeId: requireString(row.top_manager_node_id),
    blueprintSnapshotId: requireString(row.blueprint_snapshot_id),
    status: requireString(row.status) as IterationSession["status"],
    maxRounds: readNumber(row.max_rounds, 1),
    currentRoundId: readString(row.current_round_id),
    createdAt: requireString(row.created_at),
    endedAt: readString(row.ended_at)
  };
}

function iterationRoundFromRow(row: Row): IterationRound {
  return {
    id: requireString(row.id),
    sessionId: requireString(row.session_id),
    runId: requireString(row.run_id),
    roundNumber: readNumber(row.round_number, 1),
    status: requireString(row.status) as IterationRound["status"],
    requirementRequestId: readString(row.requirement_request_id),
    approvedRequirementRequestId: readString(row.approved_requirement_request_id),
    approvedRequirementRevision: readNumberOrUndefined(row.approved_requirement_revision),
    releaseReportRequestId: readString(row.release_report_request_id),
    artifactIds: readJsonArray(row.artifact_ids_json),
    researchStatus: readString(row.research_status) as IterationRound["researchStatus"],
    researchSummary: readString(row.research_summary),
    researchArtifactIds: readJsonArray(row.research_artifact_ids_json),
    planSource: readString(row.plan_source) as IterationRound["planSource"],
    contextSnapshotId: readString(row.context_snapshot_id),
    startedAt: requireString(row.started_at),
    endedAt: readString(row.ended_at)
  };
}

function artifactFromRow(row: Row): Artifact {
  return {
    id: requireString(row.id),
    runId: requireString(row.run_id),
    roundId: readString(row.round_id),
    nodeRunId: readString(row.node_run_id) ?? readString(row.declared_node_run_id),
    slot: readString(row.slot),
    title: readString(row.title),
    kind: requireString(row.kind) as Artifact["kind"],
    format: readString(row.format),
    storagePath: readString(row.storage_path),
    relativePath: readString(row.relative_path),
    downloadUrl: readString(row.download_url),
    previewPolicy: requireString(row.preview_policy) as Artifact["previewPolicy"],
    trusted: Boolean(row.trusted),
    status: readString(row.status) as Artifact["status"],
    bytes: readNumberOrUndefined(row.bytes),
    sha256: readString(row.sha256),
    createdAt: requireString(row.created_at)
  };
}

function agentHumanReportFromRow(row: Row): AgentHumanReport {
  return {
    id: requireString(row.id),
    runId: requireString(row.run_id),
    roundId: readString(row.round_id),
    nodeRunId: requireString(row.node_run_id),
    nodeId: requireString(row.node_id),
    nodeLabel: requireString(row.node_label),
    title: requireString(row.title),
    bodyMd: requireString(row.body_md),
    source: requireString(row.source) as AgentHumanReport["source"],
    fallbackReason: readString(row.fallback_reason),
    createdAt: requireString(row.created_at)
  };
}

function agentHandoffFromRow(row: Row): AgentHandoff {
  return {
    id: requireString(row.id),
    runId: requireString(row.run_id),
    roundId: readString(row.round_id),
    nodeRunId: requireString(row.node_run_id),
    nodeId: requireString(row.node_id),
    payload: readJson(row.payload_json),
    createdAt: requireString(row.created_at)
  };
}

function managerContextSnapshotFromRow(row: Row): ManagerContextSnapshot {
  return readJson<ManagerContextSnapshot>(row.snapshot_json);
}

function runTimelineItemFromRow(row: Row): RunTimelineItem {
  return {
    id: requireString(row.id),
    runId: requireString(row.run_id),
    sequence: readNumber(row.sequence, 0),
    createdAt: requireString(row.created_at),
    actorNodeId: readString(row.actor_node_id),
    actorLabel: requireString(row.actor_label),
    kind: requireString(row.kind) as RunTimelineItem["kind"],
    title: requireString(row.title),
    body: readString(row.body),
    payloadRef: readString(row.payload_ref)
  };
}

function managerMailFromRow(row: Row): ManagerMail {
  return {
    id: requireString(row.id),
    sourceType: requireString(row.source_type) as ManagerMail["sourceType"],
    sourceId: requireString(row.source_id),
    kind: requireString(row.kind),
    status: requireString(row.status),
    title: requireString(row.title),
    body: requireString(row.body),
    capabilities: readJson(row.capabilities_json),
    relatedRunId: readString(row.related_run_id),
    relatedRoundId: readString(row.related_round_id),
    createdAt: requireString(row.created_at),
    updatedAt: requireString(row.updated_at)
  };
}

function chatSessionFromRow(row: Row): HivewardChatSession {
  return {
    id: requireString(row.id),
    companyId: readString(row.company_id),
    harnessId: normalizeHarnessId(row.harness_id),
    roleScope: parseOptionalJson(row.role_scope_json) as ChatRoleScope | undefined,
    title: readString(row.title) ?? "New chat",
    nativeSessionId: readString(row.native_session_id),
    nativeSessionState: normalizeNativeSessionState(row.native_session_state),
    modelId: readString(row.model_id),
    agentId: readString(row.agent_id),
    thinkingEffort: normalizeThinkingEffort(row.thinking_effort),
    permissionMode: normalizePermissionMode(row.permission_mode) ?? "safe",
    mode: normalizeChatMode(row.mode),
    status: normalizeChatSessionStatus(row.status) ?? "active",
    createdAt: requireString(row.created_at),
    updatedAt: requireString(row.updated_at),
    endedAt: readString(row.ended_at)
  };
}

function normalizeAgentOutputEnvelope(output: unknown): AgentOutputEnvelope | undefined {
  const record = readOutputRecord(output);
  if (!record) return undefined;
  if (!Object.hasOwn(record, "humanReportMd") && !Object.hasOwn(record, "handoffJson") && !Object.hasOwn(record, "result") && !Object.hasOwn(record, "artifacts")) {
    return undefined;
  }
  return {
    contractVersion: record.contractVersion === 2 ? 2 : undefined,
    humanReportMd: readString(record.humanReportMd),
    handoffJson: record.handoffJson,
    result: record.result,
    artifacts: Array.isArray(record.artifacts) ? record.artifacts as AgentOutputEnvelope["artifacts"] : undefined
  };
}

function readOutputRecord(output: unknown): Record<string, unknown> | undefined {
  if (isRecord(output)) return output;
  if (typeof output !== "string") return undefined;
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
      blueprintId: scope.blueprintId && index.blueprintIndex.some((blueprint) => blueprint.companyId === companyId && blueprint.id === scope.blueprintId)
        ? scope.blueprintId
        : undefined
    };
  }
  const roles = buildRoleDirectory(index, companyId, now, index.roleDirectories[companyId]);
  const leader = roles.leaders.find((candidate) => candidate.id === scope.leaderId || candidate.blueprintId === scope.blueprintId);
  return leader
    ? {
        companyId,
        role: "leader",
        leaderId: leader.id,
        blueprintId: leader.blueprintId
      }
    : undefined;
}

function normalizeChatRoleScopeForCompany(value: unknown, companyId: string): ChatRoleScope | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role === "leader" ? "leader" : value.role === "ceo" ? "ceo" : undefined;
  if (!role) return undefined;
  return {
    companyId,
    role,
    leaderId: readString(value.leaderId),
    blueprintId: readString(value.blueprintId)
  };
}

function buildBlueprintEntryMarkdown(blueprint: BlueprintDefinition): string {
  const description = blueprint.description?.trim() || `Use when running the ${blueprint.name || blueprint.id} blueprint.`;
  return [
    "---",
    `name: ${slugifyBlueprintName(blueprint.name || blueprint.id)}`,
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
    requiredResources: { skills: [], scripts: [], mcp: [] },
    ownerRole: "leader",
    primaryBlueprintId: blueprint.id,
    blueprints: [blueprint.id],
    createdAt: blueprint.createdAt,
    updatedAt: blueprint.updatedAt
  };
}

async function copySkillPackageParts(sourcePath: string, targetPath: string): Promise<void> {
  if (await isReadableFile(join(sourcePath, "SKILL.md"))) {
    await cp(join(sourcePath, "SKILL.md"), join(targetPath, "SKILL.md"));
  }
  for (const folder of ["references", "scripts", "assets", "agents"]) {
    if (await isReadableDirectory(join(sourcePath, folder))) {
      await cp(join(sourcePath, folder), join(targetPath, folder), { recursive: true });
    }
  }
}

async function classifySkillSource(sourcePath: string, sourceIsDirectory: boolean): Promise<BlueprintSkillSourceSnapshot["sourceCompleteness"]> {
  const name = basename(sourcePath).toLowerCase();
  if (sourceIsDirectory) return await isReadableFile(join(sourcePath, "SKILL.md")) ? "full_package" : "unknown";
  if (name === "skill.md") return "partial_package";
  return extname(name) === ".md" ? "markdown_only" : "unknown";
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files = await walkFiles(root);
  return files.map((file) => toPosixPath(relative(root, file))).sort((left, right) => left.localeCompare(right));
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(childPath));
    else if (entry.isFile()) files.push(childPath);
  }
  return files;
}

async function hashRelativeFiles(root: string, files: string[]): Promise<Record<string, string>> {
  const fileHashes: Record<string, string> = {};
  for (const file of files) {
    fileHashes[file] = createHash("sha256").update(await readFile(join(root, file))).digest("hex");
  }
  return fileHashes;
}

async function buildScriptInventory(root: string, files: string[]): Promise<BlueprintSkillSourceSnapshot["scriptInventory"]> {
  const scripts = files.filter((file) => file.startsWith("scripts/"));
  return Promise.all(scripts.map(async (path) => {
    const scriptStat = await stat(join(root, path));
    return {
      path,
      runtime: inferScriptRuntime(path),
      sizeBytes: scriptStat.size,
      sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
      shouldExecuteByDefault: false
    };
  }));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function optionalJson(value: unknown): string | null {
  return value === undefined ? null : stringifyJson(value);
}

function readJson<T>(value: unknown): T {
  return JSON.parse(requireString(value)) as T;
}

function parseOptionalJson(value: unknown): unknown {
  const raw = readString(value);
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

function readJsonArray(value: unknown): never[] {
  const parsed = parseOptionalJson(value);
  return Array.isArray(parsed) ? parsed as never[] : [];
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stringifyJson(value)).digest("hex");
}

function requireString(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "");
  return value;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireCompanyName(value: unknown): string {
  const name = readOptionalString(value);
  if (!name) throw new Error("Company name is required.");
  return name;
}

function normalizeRunStatus(value: unknown): BlueprintRun["status"] {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled" || value === "waiting_approval"
    ? value
    : "queued";
}

function normalizeNodeRunStatus(value: unknown): BlueprintNodeRun["status"] {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled" || value === "skipped" || value === "waiting_approval"
    ? value
    : "queued";
}

function normalizeInboxItemType(value: unknown): InboxItemType {
  return value === "leader_delegation" || value === "blueprint_proposal" || value === "run_request" || value === "report" || value === "company_config"
    ? value
    : "report";
}

function normalizeHarnessId(value: unknown, fallback: HarnessId = "openclaw"): HarnessId {
  return value === "codex" || value === "claudeCode" || value === "openclaw" || value === "google" || value === "cursor" || value === "opencode" || value === "hermes"
    ? value
    : fallback;
}

function normalizeChatMode(value: unknown): HivewardChatSession["mode"] {
  return value === "blueprint" || value === "skill_split" ? value : "chat";
}

function normalizePermissionMode(value: unknown): HivewardChatSession["permissionMode"] | undefined {
  return value === "safe" || value === "full_access" ? value : undefined;
}

function normalizeThinkingEffort(value: unknown): HivewardChatSession["thinkingEffort"] | undefined {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "adaptive" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

function normalizeChatSessionStatus(value: unknown): HivewardChatSession["status"] | undefined {
  return value === "active" || value === "ended" || value === "native_missing" || value === "failed" ? value : undefined;
}

function normalizeNativeSessionState(value: unknown): HivewardChatSession["nativeSessionState"] | undefined {
  return value === "unknown" || value === "resumable" || value === "missing" ? value : undefined;
}

function normalizeChatMessageRole(value: unknown): HivewardChatMessage["role"] | undefined {
  return value === "user" || value === "assistant" || value === "system" ? value : undefined;
}

function normalizeChatMessageStatus(value: unknown): HivewardChatMessage["status"] | undefined {
  return value === "sent" || value === "streaming" || value === "failed" ? value : undefined;
}

function readAgentRuntimeId(value: unknown): AgentRuntimeId | undefined {
  return value === "openclaw" || value === "codex" || value === "claude" || value === "google" || value === "cursor" || value === "opencode" || value === "hermes"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nextCompanyId(companies: Array<{ id: string }>): string {
  const used = new Set(companies.map((company) => company.id));
  let id = `company-${nanoid(8)}`;
  while (used.has(id)) id = `company-${nanoid(8)}`;
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
  return parts.slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
}

function nextBlueprintId(blueprints: Array<{ id: string }>): string {
  const used = new Set(blueprints.map((blueprint) => blueprint.id));
  let id = `blueprint-${nanoid(8)}`;
  while (used.has(id)) id = `blueprint-${nanoid(8)}`;
  return id;
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

function deriveChatSessionTitle(session: HivewardChatSession, message: HivewardChatMessage): string {
  if (session.title && session.title !== "New chat") return session.title;
  if (message.role !== "user") return session.title || "New chat";
  const content = message.content.trim();
  if (!content) return session.title || "New chat";
  return content.length > 42 ? `${content.slice(0, 42)}...` : content;
}

function maxTimestamp(values: Array<string | undefined>): string | undefined {
  const normalized = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (normalized.length === 0) return undefined;
  return normalized.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function slugifyBlueprintName(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "blueprint";
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

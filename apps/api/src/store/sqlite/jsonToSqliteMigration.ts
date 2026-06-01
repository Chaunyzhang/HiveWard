import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import Database from "better-sqlite3";
import type {
  AgentHandoff,
  AgentHumanReport,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  BlueprintDefinition,
  BlueprintNodeEvent,
  BlueprintNodeRun,
  BlueprintRunArchive,
  HivewardChatMessage,
  HivewardChatSession,
  InboxItem,
  NodeExecutionSession,
  NodeSessionTranscriptEvent,
  ReleaseReport
} from "@hiveward/shared";
import { FileHivewardStore } from "../fileHivewardStore";
import { acquireSqliteMaintenanceLock } from "./sqliteProcessLock";
import { SqliteHivewardStore } from "./sqliteHivewardStore";

export interface JsonToSqliteMigrationOptions {
  dataDir: string;
  sqlitePath?: string;
  dryRun?: boolean;
  checkArtifacts?: boolean;
  listOrphanArtifacts?: boolean;
}

export interface SourceManifestEntry {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  parseStatus: "json" | "binary" | "skipped" | "invalid_json";
}

export interface JsonToSqliteMigrationResult {
  id: string;
  status: "dry_run" | "applied" | "failed";
  sourceRoot: string;
  backupRoot: string;
  sqlitePath: string;
  sourceManifest: SourceManifestEntry[];
  counts: Awaited<ReturnType<SqliteHivewardStore["importFromStore"]>>;
  createdAt: string;
  completedAt: string;
}

export async function migrateJsonToSqlite(options: JsonToSqliteMigrationOptions): Promise<JsonToSqliteMigrationResult> {
  const sourceRoot = resolve(options.dataDir);
  await assertLegacyIndexExists(sourceRoot);
  const createdAt = new Date().toISOString();
  const id = `migration-${createdAt.replace(/[:.]/g, "-")}-${nanoid(6)}`;
  const backupRoot = join(sourceRoot, "migration-backups", id);
  await mkdir(backupRoot, { recursive: true });
  const sourceManifest = await buildSourceManifest(sourceRoot);
  await copyMigrationInputs(sourceRoot, backupRoot);

  const sqlitePath = resolve(options.sqlitePath ?? join(sourceRoot, "hiveward.sqlite"));
  const targetSqlitePath = options.dryRun ? join(backupRoot, "hiveward.sqlite") : sqlitePath;
  const maintenanceLock = options.dryRun
    ? undefined
    : await acquireSqliteMaintenanceLock({ sqlitePath, command: process.argv.join(" ") });

  try {
    await resetSqliteTarget(targetSqlitePath, backupRoot, options.dryRun ?? false);
    const sourceStore = new FileHivewardStore(join(backupRoot, "hiveward-store.json"));
    const sqliteStore = new SqliteHivewardStore(targetSqlitePath, { seedDefaults: false });
    await sourceStore.init();
    try {
      await sqliteStore.init();
      const counts = await sqliteStore.importFromStore(sourceStore);
      const completedAt = new Date().toISOString();
      const result: JsonToSqliteMigrationResult = {
        id,
        status: options.dryRun ? "dry_run" : "applied",
        sourceRoot,
        backupRoot,
        sqlitePath: targetSqlitePath,
        sourceManifest,
        counts,
        createdAt,
        completedAt
      };
      sqliteStore.recordMigrationManifest({
        id,
        sourceRoot,
        backupRoot,
        sourceManifest,
        result,
        status: result.status,
        createdAt,
        completedAt
      });
      return result;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const failedResult = {
        id,
        sourceRoot,
        backupRoot,
        sqlitePath: targetSqlitePath,
        error: error instanceof Error ? error.message : String(error),
        completedAt
      };
      try {
        sqliteStore.recordMigrationManifest({
          id,
          sourceRoot,
          backupRoot,
          sourceManifest,
          result: failedResult,
          status: "failed",
          createdAt,
          completedAt
        });
      } catch {
        // The original migration error is more useful.
      }
      throw error;
    } finally {
      sqliteStore.close();
    }
  } finally {
    await maintenanceLock?.release();
  }
}

export async function verifySqliteMigration(options: JsonToSqliteMigrationOptions): Promise<{
  ok: boolean;
  source: Record<string, number>;
  sqlite: Record<string, number>;
  mismatches: string[];
  identityMismatches: string[];
  viewMismatches: string[];
  missingArtifacts: string[];
  orphanArtifacts: string[];
}> {
  const sourceRoot = resolve(options.dataDir);
  await assertLegacyIndexExists(sourceRoot);
  const tempRoot = join(tmpdir(), `hiveward-verify-${nanoid(8)}`);
  await mkdir(tempRoot, { recursive: true });
  await copyMigrationInputs(sourceRoot, tempRoot);
  const sourceStore = new FileHivewardStore(join(tempRoot, "hiveward-store.json"));
  await sourceStore.init();
  const sqliteStore = new SqliteHivewardStore(resolve(options.sqlitePath ?? join(sourceRoot, "hiveward.sqlite")));
  await sqliteStore.init();
  try {
    const sourceSnapshot = await collectStoreSnapshot(sourceStore);
    const sqliteSnapshot = await collectStoreSnapshot(sqliteStore);
    const sourceCounts = collectSnapshotCounts(sourceSnapshot);
    const sqliteCounts = collectSnapshotCounts(sqliteSnapshot);
    const keys = [...new Set([...Object.keys(sourceCounts), ...Object.keys(sqliteCounts)])].sort();
    const countMismatches = keys
      .filter((key) => sourceCounts[key] !== sqliteCounts[key])
      .map((key) => `count:${key}: source=${sourceCounts[key] ?? 0} sqlite=${sqliteCounts[key] ?? 0}`);
    const identityMismatches = compareIdentitySets(sourceSnapshot, sqliteSnapshot);
    const viewMismatches = compareViewParity(sourceSnapshot, sqliteSnapshot);
    const missingArtifacts = options.checkArtifacts ? await findMissingArtifactFiles(sqliteSnapshot.artifacts) : [];
    const orphanArtifacts = options.listOrphanArtifacts ? await listOrphanArtifacts(sourceRoot, sqliteSnapshot.artifacts) : [];
    const mismatches = [...countMismatches, ...identityMismatches, ...viewMismatches, ...missingArtifacts.map((item) => `artifact_missing:${item}`)];
    return {
      ok: mismatches.length === 0,
      source: sourceCounts,
      sqlite: sqliteCounts,
      mismatches,
      identityMismatches,
      viewMismatches,
      missingArtifacts,
      orphanArtifacts
    };
  } finally {
    sqliteStore.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export interface OrphanArtifactMaintenanceResult {
  ok: boolean;
  dataDir: string;
  sqlitePath: string;
  artifactRoot: string;
  orphanArtifacts: string[];
  deletedArtifacts: string[];
  dryRun: boolean;
}

export async function listSqliteOrphanArtifacts(options: {
  dataDir: string;
  sqlitePath?: string;
}): Promise<OrphanArtifactMaintenanceResult> {
  return maintainSqliteOrphanArtifacts({ ...options, dryRun: true });
}

export async function cleanupSqliteOrphanArtifacts(options: {
  dataDir: string;
  sqlitePath?: string;
  dryRun?: boolean;
}): Promise<OrphanArtifactMaintenanceResult> {
  return maintainSqliteOrphanArtifacts(options);
}

async function maintainSqliteOrphanArtifacts(options: {
  dataDir: string;
  sqlitePath?: string;
  dryRun?: boolean;
}): Promise<OrphanArtifactMaintenanceResult> {
  const dataDir = resolve(options.dataDir);
  const sqlitePath = resolve(options.sqlitePath ?? join(dataDir, "hiveward.sqlite"));
  await assertSqliteExists(sqlitePath);
  const sqliteStore = new SqliteHivewardStore(sqlitePath, { seedDefaults: false });
  await sqliteStore.init();
  try {
    const artifacts = await sqliteStore.listArtifacts();
    const orphanArtifacts = await listOrphanArtifacts(dataDir, artifacts);
    const deletedArtifacts: string[] = [];
    if (!options.dryRun) {
      const artifactRoot = join(dataDir, "artifacts");
      for (const orphan of orphanArtifacts) {
        const candidate = resolve(artifactRoot, orphan);
        if (!isPathInside(candidate, artifactRoot)) {
          throw new Error(`Refusing to delete artifact path outside artifact root: ${orphan}`);
        }
        await rm(candidate, { force: true });
        deletedArtifacts.push(orphan);
      }
    }
    return {
      ok: true,
      dataDir,
      sqlitePath,
      artifactRoot: join(dataDir, "artifacts"),
      orphanArtifacts,
      deletedArtifacts,
      dryRun: options.dryRun ?? false
    };
  } finally {
    sqliteStore.close();
  }
}

type VerificationSnapshot = {
  selectedCompanyId?: string;
  companies: Array<Pick<Awaited<ReturnType<FileHivewardStore["listCompanies"]>>["companies"][number], "id" | "name">>;
  blueprints: Array<Pick<BlueprintDefinition, "id" | "companyId" | "name" | "version">>;
  runs: Array<{ id: string; blueprintId: string; status: string; finalResultHash: string | null }>;
  nodeRuns: Array<Pick<BlueprintNodeRun, "id" | "blueprintRunId" | "nodeId" | "iterationRoundId" | "status" | "error">>;
  events: Array<Pick<BlueprintNodeEvent, "id" | "blueprintRunId" | "nodeRunId" | "type" | "message" | "createdAt"> & { sequence: number }>;
  pendingApprovals: Array<Pick<ApprovalRequest, "id" | "kind" | "status" | "runId" | "roundId" | "revision">>;
  approvalDecisions: Array<Pick<ApprovalDecision, "id" | "approvalRequestId" | "action" | "actor" | "resultingStatus">>;
  inboxPending: Array<Pick<InboxItem, "id" | "status" | "type" | "blueprintId"> & { payloadHash: string }>;
  agentHumanReports: Array<Pick<AgentHumanReport, "id" | "nodeRunId" | "runId" | "roundId" | "source"> & { bodyHash: string }>;
  agentHandoffs: Array<Pick<AgentHandoff, "id" | "nodeRunId" | "runId" | "roundId"> & { payloadHash: string }>;
  artifacts: Array<Pick<Artifact, "id" | "runId" | "roundId" | "nodeRunId" | "kind" | "format" | "storagePath" | "downloadUrl" | "sha256" | "bytes" | "relativePath">>;
  releaseReports: Array<Pick<ReleaseReport, "id" | "roundId" | "approvalRequestId" | "version"> & { artifactRefsHash: string }>;
  nodeExecutionSessions: Array<Pick<NodeExecutionSession, "id" | "runId" | "nodeRunId" | "nodeId" | "agentSeatId" | "harnessId" | "nativeSessionId" | "policy" | "status" | "fallbackOfSessionId" | "resumedFromSessionId">>;
  nodeSessionTranscriptEvents: Array<Pick<NodeSessionTranscriptEvent, "id" | "sessionId" | "runId" | "nodeRunId" | "role" | "kind" | "content"> & { runtimeRefHash: string | null; metadataHash: string | null }>;
  chatSessions: Array<Pick<HivewardChatSession, "id" | "harnessId" | "nativeSessionId" | "status">>;
  chatMessages: Array<Pick<HivewardChatMessage, "id" | "sessionId" | "role" | "content" | "status" | "nativeMessageId">>;
};

async function collectStoreSnapshot(store: FileHivewardStore | SqliteHivewardStore): Promise<VerificationSnapshot> {
  const snapshot: VerificationSnapshot = {
    companies: [],
    blueprints: [],
    runs: [],
    nodeRuns: [],
    events: [],
    pendingApprovals: [],
    approvalDecisions: [],
    inboxPending: [],
    agentHumanReports: [],
    agentHandoffs: [],
    artifacts: [],
    releaseReports: [],
    nodeExecutionSessions: [],
    nodeSessionTranscriptEvents: [],
    chatSessions: [],
    chatMessages: []
  };
  const { companies, selectedCompanyId } = await store.listCompanies();
  snapshot.selectedCompanyId = selectedCompanyId;
  snapshot.companies = companies.map((company) => ({ id: company.id, name: company.name })).sort(compareById);
  for (const company of companies) {
    await store.selectCompany(company.id);
    snapshot.blueprints.push(...(await store.listBlueprints()).map((blueprint) => ({
      id: blueprint.id,
      companyId: blueprint.companyId,
      name: blueprint.name,
      version: blueprint.version
    })));
    const archives = await store.listRunArchives();
    for (const archive of archives) {
      collectArchiveSnapshot(snapshot, archive);
    }
    mergeById(snapshot.artifacts, (await store.listArtifacts()).map((artifact) => ({
      id: artifact.id,
      runId: artifact.runId,
      roundId: artifact.roundId,
      nodeRunId: artifact.nodeRunId,
      kind: artifact.kind,
      format: artifact.format,
      storagePath: artifact.storagePath,
      relativePath: artifact.relativePath,
      downloadUrl: artifact.downloadUrl,
      sha256: artifact.sha256,
      bytes: artifact.bytes
    })));
    mergeById(snapshot.agentHumanReports, (await store.listAgentHumanReports()).map((report) => ({
      id: report.id,
      runId: report.runId,
      roundId: report.roundId,
      nodeRunId: report.nodeRunId,
      source: report.source,
      bodyHash: hashString(report.bodyMd)
    })));
    mergeById(snapshot.agentHandoffs, (await store.listAgentHandoffs()).map((handoff) => ({
      id: handoff.id,
      runId: handoff.runId,
      roundId: handoff.roundId,
      nodeRunId: handoff.nodeRunId,
      payloadHash: hashJson(handoff.payload)
    })));
    mergeById(snapshot.releaseReports, (await store.listReleaseReports()).map((report) => ({
      id: report.id,
      roundId: report.roundId,
      approvalRequestId: report.approvalRequestId,
      version: report.version,
      artifactRefsHash: hashJson(report.artifactRefs)
    })));
    mergeById(snapshot.nodeExecutionSessions, (await store.listNodeExecutionSessions()).map((session) => ({
      id: session.id,
      runId: session.runId,
      nodeRunId: session.nodeRunId,
      nodeId: session.nodeId,
      agentSeatId: session.agentSeatId,
      harnessId: session.harnessId,
      nativeSessionId: session.nativeSessionId,
      policy: session.policy,
      status: session.status,
      fallbackOfSessionId: session.fallbackOfSessionId,
      resumedFromSessionId: session.resumedFromSessionId
    })));
    mergeById(snapshot.nodeSessionTranscriptEvents, (await store.listNodeSessionTranscriptEvents()).map((event) => ({
      id: event.id,
      sessionId: event.sessionId,
      runId: event.runId,
      nodeRunId: event.nodeRunId,
      role: event.role,
      kind: event.kind,
      content: event.content,
      runtimeRefHash: event.runtimeRef ? hashJson(event.runtimeRef) : null,
      metadataHash: event.metadata ? hashJson(event.metadata) : null
    })));
    snapshot.inboxPending.push(...(await store.listInboxItems())
      .filter((item) => item.status === "pending")
      .map((item) => ({
        id: item.id,
        type: item.type,
        status: item.status,
        blueprintId: item.blueprintId,
        payloadHash: hashJson(item.payload)
      })));
    const sessions = await store.listChatSessions();
    snapshot.chatSessions.push(...sessions.map((session) => ({
      id: session.id,
      harnessId: session.harnessId,
      nativeSessionId: session.nativeSessionId,
      status: session.status
    })));
    for (const session of sessions) {
      snapshot.chatMessages.push(...(await store.listChatMessages(session.id)).map((message) => ({
        id: message.id,
        sessionId: message.sessionId,
        role: message.role,
        content: message.content,
        status: message.status,
        nativeMessageId: message.nativeMessageId
      })));
    }
  }
  await store.selectCompany(selectedCompanyId);
  sortSnapshot(snapshot);
  return snapshot;
}

function mergeById<T extends { id: string }>(target: T[], items: T[]): void {
  for (const item of items) {
    const index = target.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) target[index] = item;
    else target.push(item);
  }
}

function collectArchiveSnapshot(snapshot: VerificationSnapshot, archive: BlueprintRunArchive): void {
  snapshot.runs.push({
    id: archive.run.id,
    blueprintId: archive.run.blueprintId,
    status: archive.run.status,
    finalResultHash: archive.finalResult ? hashJson(archive.finalResult) : null
  });
  snapshot.nodeRuns.push(...archive.nodeRuns.map((nodeRun) => ({
    id: nodeRun.id,
    blueprintRunId: nodeRun.blueprintRunId,
    nodeId: nodeRun.nodeId,
    iterationRoundId: nodeRun.iterationRoundId,
    status: nodeRun.status,
    error: nodeRun.error
  })));
  snapshot.events.push(...archive.events.map((event, index) => ({
    id: event.id,
    blueprintRunId: event.blueprintRunId,
    nodeRunId: event.nodeRunId,
    type: event.type,
    message: event.message,
    createdAt: event.createdAt,
    sequence: index + 1
  })));
  snapshot.pendingApprovals.push(...(archive.approvalRequests ?? [])
    .filter((request) => request.status === "pending")
    .map((request) => ({
      id: request.id,
      kind: request.kind,
      status: request.status,
      runId: request.runId,
      roundId: request.roundId,
      revision: request.revision
    })));
  snapshot.approvalDecisions.push(...(archive.approvalDecisions ?? []).map((decision) => ({
    id: decision.id,
    approvalRequestId: decision.approvalRequestId,
    action: decision.action,
    actor: decision.actor,
    resultingStatus: decision.resultingStatus
  })));
  snapshot.agentHumanReports.push(...(archive.agentHumanReports ?? []).map((report) => ({
    id: report.id,
    runId: report.runId,
    roundId: report.roundId,
    nodeRunId: report.nodeRunId,
    source: report.source,
    bodyHash: hashString(report.bodyMd)
  })));
  snapshot.agentHandoffs.push(...(archive.agentHandoffs ?? []).map((handoff) => ({
    id: handoff.id,
    runId: handoff.runId,
    roundId: handoff.roundId,
    nodeRunId: handoff.nodeRunId,
    payloadHash: hashJson(handoff.payload)
  })));
  snapshot.artifacts.push(...(archive.artifacts ?? []).map((artifact) => ({
    id: artifact.id,
    runId: artifact.runId,
    roundId: artifact.roundId,
    nodeRunId: artifact.nodeRunId,
    kind: artifact.kind,
    format: artifact.format,
    storagePath: artifact.storagePath,
    relativePath: artifact.relativePath,
    downloadUrl: artifact.downloadUrl,
    sha256: artifact.sha256,
    bytes: artifact.bytes
  })));
  snapshot.releaseReports.push(...(archive.releaseReports ?? []).map((report) => ({
    id: report.id,
    roundId: report.roundId,
    approvalRequestId: report.approvalRequestId,
    version: report.version,
    artifactRefsHash: hashJson(report.artifactRefs)
  })));
  snapshot.nodeExecutionSessions.push(...(archive.nodeExecutionSessions ?? []).map((session) => ({
    id: session.id,
    runId: session.runId,
    nodeRunId: session.nodeRunId,
    nodeId: session.nodeId,
    agentSeatId: session.agentSeatId,
    harnessId: session.harnessId,
    nativeSessionId: session.nativeSessionId,
    policy: session.policy,
    status: session.status,
    fallbackOfSessionId: session.fallbackOfSessionId,
    resumedFromSessionId: session.resumedFromSessionId
  })));
  snapshot.nodeSessionTranscriptEvents.push(...(archive.nodeSessionTranscriptEvents ?? []).map((event) => ({
    id: event.id,
    sessionId: event.sessionId,
    runId: event.runId,
    nodeRunId: event.nodeRunId,
    role: event.role,
    kind: event.kind,
    content: event.content,
    runtimeRefHash: event.runtimeRef ? hashJson(event.runtimeRef) : null,
    metadataHash: event.metadata ? hashJson(event.metadata) : null
  })));
}

function collectSnapshotCounts(snapshot: VerificationSnapshot): Record<string, number> {
  return {
    companies: snapshot.companies.length,
    blueprints: snapshot.blueprints.length,
    runs: snapshot.runs.length,
    nodeRuns: snapshot.nodeRuns.length,
    events: snapshot.events.length,
    pendingApprovals: snapshot.pendingApprovals.length,
    approvalDecisions: snapshot.approvalDecisions.length,
    artifacts: snapshot.artifacts.length,
    agentHumanReports: snapshot.agentHumanReports.length,
    agentHandoffs: snapshot.agentHandoffs.length,
    releaseReports: snapshot.releaseReports.length,
    nodeExecutionSessions: snapshot.nodeExecutionSessions.length,
    nodeSessionTranscriptEvents: snapshot.nodeSessionTranscriptEvents.length,
    inboxPending: snapshot.inboxPending.length,
    chatSessions: snapshot.chatSessions.length,
    chatMessages: snapshot.chatMessages.length
  };
}

function compareIdentitySets(source: VerificationSnapshot, sqlite: VerificationSnapshot): string[] {
  const mismatches: string[] = [];
  for (const key of [
    "companies",
    "blueprints",
    "runs",
    "nodeRuns",
    "events",
    "pendingApprovals",
    "approvalDecisions",
    "artifacts",
    "agentHumanReports",
    "agentHandoffs",
    "releaseReports",
    "nodeExecutionSessions",
    "nodeSessionTranscriptEvents",
    "inboxPending",
    "chatSessions",
    "chatMessages"
  ] as const) {
    const sourceIds = source[key].map((item) => item.id).sort();
    const sqliteIds = sqlite[key].map((item) => item.id).sort();
    if (JSON.stringify(sourceIds) !== JSON.stringify(sqliteIds)) {
      mismatches.push(`identity:${key}: source=${sourceIds.join("|")} sqlite=${sqliteIds.join("|")}`);
    }
  }
  return mismatches;
}

function compareViewParity(source: VerificationSnapshot, sqlite: VerificationSnapshot): string[] {
  const mismatches: string[] = [];
  for (const key of Object.keys(source) as Array<keyof VerificationSnapshot>) {
    const sourceJson = stableJson(source[key]);
    const sqliteJson = stableJson(sqlite[key]);
    if (sourceJson !== sqliteJson) {
      mismatches.push(`view:${key}`);
    }
  }
  return mismatches;
}

async function findMissingArtifactFiles(artifacts: VerificationSnapshot["artifacts"]): Promise<string[]> {
  const missing: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind === "link") continue;
    if (!artifact.storagePath) {
      missing.push(`${artifact.id}:missing-storage-path`);
      continue;
    }
    if (!await pathExists(artifact.storagePath)) {
      missing.push(`${artifact.id}:${artifact.storagePath}`);
    }
  }
  return missing.sort();
}

async function listOrphanArtifacts(dataDir: string, artifacts: VerificationSnapshot["artifacts"]): Promise<string[]> {
  const artifactRoot = join(resolve(dataDir), "artifacts");
  const referenced = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.storagePath) referenced.add(resolve(artifact.storagePath).toLowerCase());
    if (artifact.relativePath) referenced.add(resolve(artifactRoot, artifact.relativePath).toLowerCase());
  }
  const files = await collectArtifactFiles(artifactRoot);
  return files.filter((file) => !referenced.has(resolve(file).toLowerCase())).map((file) => toPosixPath(relative(artifactRoot, file))).sort();
}

async function collectArtifactFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...await collectArtifactFiles(path));
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
    return files;
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function sortSnapshot(snapshot: VerificationSnapshot): void {
  snapshot.blueprints.sort(compareById);
  snapshot.runs.sort(compareById);
  snapshot.nodeRuns.sort(compareById);
  snapshot.events.sort(compareByRunSequenceId);
  snapshot.pendingApprovals.sort(compareById);
  snapshot.approvalDecisions.sort(compareById);
  snapshot.inboxPending.sort(compareById);
  snapshot.agentHumanReports.sort(compareById);
  snapshot.agentHandoffs.sort(compareById);
  snapshot.artifacts.sort(compareById);
  snapshot.releaseReports.sort(compareById);
  snapshot.nodeExecutionSessions.sort(compareById);
  snapshot.nodeSessionTranscriptEvents.sort(compareById);
  snapshot.chatSessions.sort(compareById);
  snapshot.chatMessages.sort(compareById);
}

function compareById(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function compareByRunSequenceId(left: { blueprintRunId: string; sequence: number; id: string }, right: { blueprintRunId: string; sequence: number; id: string }): number {
  return left.blueprintRunId.localeCompare(right.blueprintRunId) || left.sequence - right.sequence || left.id.localeCompare(right.id);
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return hashString(stableJson(value));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.keys(item as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = (item as Record<string, unknown>)[key];
      return result;
    }, {});
  });
}

async function buildSourceManifest(sourceRoot: string): Promise<SourceManifestEntry[]> {
  const files = await collectSourceFiles(sourceRoot);
  const entries: SourceManifestEntry[] = [];
  for (const file of files) {
    const fileStat = await stat(file);
    const bytes = await readFile(file);
    const path = toPosixPath(relative(sourceRoot, file));
    entries.push({
      path,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      parseStatus: classifyParseStatus(path, bytes)
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "migration-backups" || entry.name === "hiveward.sqlite" || entry.name.endsWith(".sqlite-wal") || entry.name.endsWith(".sqlite-shm")) {
      continue;
    }
    if (entry.name.endsWith(".tmp")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function copyMigrationInputs(sourceRoot: string, targetRoot: string): Promise<void> {
  await mkdir(targetRoot, { recursive: true });
  for (const fileName of ["hiveward-store.json", "hiveward-chat-store.json"]) {
    await copyIfExists(join(sourceRoot, fileName), join(targetRoot, fileName));
  }
  await copyJsonDir(join(sourceRoot, "blueprints"), join(targetRoot, "blueprints"));
  await copyJsonDir(join(sourceRoot, "runs"), join(targetRoot, "runs"));
  await copyDirIfExists(join(sourceRoot, "artifacts"), join(targetRoot, "artifacts"));
}

async function copyIfExists(source: string, target: string, sqlitePathForLockMessage?: string): Promise<void> {
  try {
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  } catch (error) {
    if (sqlitePathForLockMessage && isSqliteBusyOrLocked(error)) {
      throw sqliteTargetLockedError(sqlitePathForLockMessage, error);
    }
    if (!isNotFound(error)) throw error;
  }
}

async function copyJsonDir(source: string, target: string): Promise<void> {
  try {
    const entries = await readdir(source, { withFileTypes: true });
    await mkdir(target, { recursive: true });
    for (const entry of entries) {
      if (entry.isFile() && extname(entry.name) === ".json" && !entry.name.endsWith(".tmp")) {
        await cp(join(source, entry.name), join(target, entry.name));
      }
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function copyDirIfExists(source: string, target: string): Promise<void> {
  try {
    await cp(source, target, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function resetSqliteTarget(sqlitePath: string, backupRoot: string, dryRun: boolean): Promise<void> {
  if (!dryRun) {
    await assertSqliteTargetUnlocked(sqlitePath);
    await copyIfExists(sqlitePath, join(backupRoot, "previous-hiveward.sqlite"), sqlitePath);
    await copyIfExists(`${sqlitePath}-wal`, join(backupRoot, "previous-hiveward.sqlite-wal"), sqlitePath);
    await copyIfExists(`${sqlitePath}-shm`, join(backupRoot, "previous-hiveward.sqlite-shm"), sqlitePath);
  }
  await removeIfExists(sqlitePath, dryRun ? undefined : sqlitePath);
  await removeIfExists(`${sqlitePath}-wal`, dryRun ? undefined : sqlitePath);
  await removeIfExists(`${sqlitePath}-shm`, dryRun ? undefined : sqlitePath);
}

async function assertSqliteTargetUnlocked(sqlitePath: string): Promise<void> {
  try {
    await stat(sqlitePath);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(sqlitePath, { fileMustExist: true });
    db.pragma("busy_timeout = 1");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("ROLLBACK");
  } catch (error) {
    if (isSqliteBusyOrLocked(error)) {
      throw sqliteTargetLockedError(sqlitePath, error);
    }
    throw error;
  } finally {
    try {
      db?.close();
    } catch {
      // The lock error above is the useful failure.
    }
  }
}

async function removeIfExists(path: string, sqlitePathForLockMessage?: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    if (sqlitePathForLockMessage && isSqliteBusyOrLocked(error)) {
      throw sqliteTargetLockedError(sqlitePathForLockMessage, error);
    }
    throw error;
  }
}

function sqliteTargetLockedError(sqlitePath: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error([
    `SQLite database is locked or busy: ${sqlitePath}`,
    "Migration did not run and the live SQLite database was not removed or rebuilt.",
    "Stop the process currently using this SQLite file, then retry the migration.",
    "Run: npm run doctor:sqlite-lock",
    `Original error: ${detail}`
  ].join("\n"));
}

function isSqliteBusyOrLocked(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  if (["SQLITE_BUSY", "SQLITE_LOCKED", "EBUSY", "EPERM", "EACCES"].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /busy|locked|resource busy|being used by another process/i.test(message);
}

function classifyParseStatus(path: string, bytes: Buffer): SourceManifestEntry["parseStatus"] {
  if (basename(path).endsWith(".tmp")) return "skipped";
  if (extname(path) !== ".json") return "binary";
  try {
    JSON.parse(bytes.toString("utf8"));
    return "json";
  } catch {
    return "invalid_json";
  }
}

function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function assertLegacyIndexExists(sourceRoot: string): Promise<void> {
  try {
    await stat(join(sourceRoot, "hiveward-store.json"));
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`JSON migration source is missing ${join(sourceRoot, "hiveward-store.json")}; refusing to seed default data.`);
    }
    throw error;
  }
}

async function assertSqliteExists(sqlitePath: string): Promise<void> {
  try {
    await stat(sqlitePath);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`SQLite store is missing ${sqlitePath}; refusing to run artifact maintenance against an implicit empty database.`);
    }
    throw error;
  }
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export async function runJsonToSqliteMigrationCli(argv = process.argv.slice(2)): Promise<void> {
  const dataDir = readFlag(argv, "--data-dir") ?? "data";
  const sqlitePath = readFlag(argv, "--sqlite-path");
  const dryRun = argv.includes("--dry-run") || !argv.includes("--apply");
  const result = await migrateJsonToSqlite({ dataDir, sqlitePath, dryRun });
  const verification = await verifySqliteMigration({
    dataDir,
    sqlitePath: result.sqlitePath,
    checkArtifacts: true,
    listOrphanArtifacts: true
  });
  const report = {
    before: {
      dataDir: result.sourceRoot,
      sqlitePath: resolve(sqlitePath ?? join(result.sourceRoot, "hiveward.sqlite")),
      sourceFiles: result.sourceManifest.length,
      jsonFiles: result.sourceManifest.filter((entry) => entry.parseStatus === "json").length,
      invalidJsonFiles: result.sourceManifest.filter((entry) => entry.parseStatus === "invalid_json").map((entry) => entry.path)
    },
    migration: result,
    verification,
    missingArtifacts: verification.missingArtifacts,
    orphanArtifacts: verification.orphanArtifacts,
    rollbackHint: dryRun
      ? "Dry-run did not modify the final SQLite database. Review this report before running --apply."
      : `Previous SQLite files, when present, were copied under ${result.backupRoot}. Stop services before restoring those files.`
  };
  await writeFile(
    join(result.backupRoot, "migration-result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  console.log(JSON.stringify(report, null, 2));
  if (!verification.ok) process.exitCode = 1;
}

export async function runVerifySqliteStoreCli(argv = process.argv.slice(2)): Promise<void> {
  const dataDir = readFlag(argv, "--data-dir") ?? "data";
  const sqlitePath = readFlag(argv, "--sqlite-path");
  const cleanupOrphans = argv.includes("--cleanup-orphan-artifacts");
  if (cleanupOrphans) {
    const result = await cleanupSqliteOrphanArtifacts({
      dataDir,
      sqlitePath,
      dryRun: argv.includes("--dry-run")
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const legacyIndexPath = join(resolve(dataDir), "hiveward-store.json");
  if (argv.includes("--list-orphan-artifacts") && !await pathExists(legacyIndexPath)) {
    const result = await listSqliteOrphanArtifacts({ dataDir, sqlitePath });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = await verifySqliteMigration({
    dataDir,
    sqlitePath,
    checkArtifacts: argv.includes("--check-artifacts"),
    listOrphanArtifacts: argv.includes("--list-orphan-artifacts")
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

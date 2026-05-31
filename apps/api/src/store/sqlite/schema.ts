import { createHash } from "node:crypto";

export interface SqliteMigration {
  version: number;
  name: string;
  checksum: string;
  up: string[];
}

const sqliteInitialSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS migration_manifests (
    id TEXT PRIMARY KEY,
    source_root TEXT NOT NULL,
    backup_root TEXT NOT NULL,
    source_manifest_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('dry_run','applied','failed')),
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    logo_label TEXT,
    logo_url TEXT,
    business_goal TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_dashboards (
    company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    dashboard_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS role_directories (
    company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    directory_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS role_driver_bindings (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    model_id TEXT,
    binding_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (company_id, role_id)
  )`,
  `CREATE TABLE IF NOT EXISTS blueprints (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    current_version INTEGER NOT NULL,
    current_version_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS blueprint_versions (
    id TEXT PRIMARY KEY,
    blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (blueprint_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS blueprint_skill_sources (
    id TEXT PRIMARY KEY,
    blueprint_id TEXT NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
    working_directory TEXT NOT NULL,
    source_completeness TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    blueprint_id TEXT NOT NULL,
    blueprint_version_id TEXT REFERENCES blueprint_versions(id),
    blueprint_name TEXT,
    blueprint_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','skipped','waiting_approval')),
    started_by TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms INTEGER,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    openclaw_refs_json TEXT NOT NULL DEFAULT '[]',
    final_result_json TEXT,
    row_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS run_blueprint_snapshots (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    blueprint_version_id TEXT,
    definition_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS run_sequence_counters (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('event','timeline')),
    last_sequence INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, scope)
  )`,
  `CREATE TABLE IF NOT EXISTS node_runs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    blueprint_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_label TEXT NOT NULL,
    node_type TEXT NOT NULL,
    iteration_round_id TEXT,
    execution_kind TEXT NOT NULL DEFAULT 'node',
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','skipped','waiting_approval')),
    queued_at TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    error TEXT,
    usage_json TEXT,
    openclaw_ref_json TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    worker_epoch INTEGER NOT NULL DEFAULT 0,
    row_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS node_run_payloads (
    node_run_id TEXT PRIMARY KEY REFERENCES node_runs(id) ON DELETE CASCADE,
    input_json TEXT,
    output_json TEXT,
    raw_result_json TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
    sequence INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    payload_json TEXT,
    openclaw_ref_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS iteration_sessions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    top_manager_node_id TEXT NOT NULL,
    blueprint_snapshot_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
    max_rounds INTEGER NOT NULL,
    current_round_id TEXT,
    created_at TEXT NOT NULL,
    ended_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS iteration_rounds (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES iteration_sessions(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    requirement_request_id TEXT,
    approved_requirement_request_id TEXT,
    approved_requirement_revision INTEGER,
    release_report_request_id TEXT,
    artifact_ids_json TEXT NOT NULL DEFAULT '[]',
    research_status TEXT,
    research_summary TEXT,
    research_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
    plan_source TEXT,
    context_snapshot_id TEXT,
    approved_plan_json TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE (session_id, round_number)
  )`,
  `CREATE TABLE IF NOT EXISTS manager_dispatches (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    round_id TEXT REFERENCES iteration_rounds(id) ON DELETE CASCADE,
    manager_node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
    target_node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
    slot INTEGER,
    route_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('created','running','succeeded','failed','cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS manager_context_snapshots (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES iteration_sessions(id) ON DELETE CASCADE,
    round_id TEXT NOT NULL REFERENCES iteration_rounds(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    source_report_id TEXT,
    snapshot_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    recommended_next_step TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    round_id TEXT,
    node_run_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','replied','completed','terminated','superseded')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    payload_ref TEXT,
    source_type TEXT,
    source_id TEXT,
    thread_id TEXT,
    revision INTEGER NOT NULL,
    replaces_request_id TEXT,
    superseded_by_request_id TEXT,
    capabilities_json TEXT NOT NULL,
    requested_by_json TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS approval_decisions (
    id TEXT PRIMARY KEY,
    approval_request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor IN ('user','system','manager')),
    comment TEXT,
    selected_reply_id TEXT,
    resulting_status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approval_replies (
    id TEXT PRIMARY KEY,
    approval_request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_by_role_id TEXT NOT NULL,
    target_role_id TEXT,
    blueprint_id TEXT,
    blueprint_name TEXT,
    payload_json TEXT,
    source_json TEXT,
    approval_request_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_at TEXT,
    decision_comment TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS inbox_replies (
    id TEXT PRIMARY KEY,
    inbox_item_id TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_outputs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    round_id TEXT,
    node_run_id TEXT NOT NULL REFERENCES node_runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (node_run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_human_reports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    round_id TEXT,
    node_run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_label TEXT NOT NULL,
    title TEXT NOT NULL,
    body_md TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('agent','fallback')),
    fallback_reason TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_handoffs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    round_id TEXT,
    node_run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    round_id TEXT,
    node_run_id TEXT REFERENCES node_runs(id) ON DELETE SET NULL,
    slot TEXT,
    title TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('html','markdown','json','file','link')),
    format TEXT,
    storage_path TEXT,
    relative_path TEXT,
    download_url TEXT,
    preview_policy TEXT NOT NULL CHECK (preview_policy IN ('none','source','sandboxed_iframe')),
    trusted INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','rejected','superseded','failed')),
    bytes INTEGER,
    sha256 TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS release_reports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    round_id TEXT NOT NULL,
    approval_request_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    supersedes_report_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS release_report_artifacts (
    release_report_id TEXT NOT NULL REFERENCES release_reports(id) ON DELETE CASCADE,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id),
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    current INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (release_report_id, artifact_id)
  )`,
  `CREATE TABLE IF NOT EXISTS run_timeline_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    actor_node_id TEXT,
    actor_label TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    payload_ref TEXT,
    UNIQUE (run_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS manager_mail (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    related_run_id TEXT,
    related_round_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    company_id TEXT,
    harness_id TEXT NOT NULL,
    native_session_id TEXT,
    native_session_state TEXT,
    title TEXT,
    role_scope_json TEXT,
    model_id TEXT,
    agent_id TEXT,
    thinking_effort TEXT,
    permission_mode TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    harness_id TEXT NOT NULL,
    model_id TEXT,
    native_message_id TEXT,
    runtime_ref_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS chat_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    attachment_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_company_started ON runs(company_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_blueprint_started ON runs(blueprint_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_node_runs_run_status ON node_runs(run_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_node_runs_run_round_node ON node_runs(run_id, iteration_round_id, node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(run_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_approval_requests_status_created ON approval_requests(status, requested_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_approval_requests_run_round ON approval_requests(run_id, round_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inbox_items_company_status ON inbox_items(company_id, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_run_round_node ON agent_human_reports(run_id, round_id, node_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_handoffs_run_node ON agent_handoffs(run_id, node_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_run_round_node ON artifacts(run_id, round_id, node_run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_release_reports_run_round ON release_reports(run_id, round_id, version DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_run_timeline_run_created ON run_timeline_items(run_id, created_at)`
];

const sqliteLegacyMigrationCompatibilityStatements = [
  "ALTER TABLE artifacts ADD COLUMN declared_node_run_id TEXT",
  "UPDATE artifacts SET declared_node_run_id = node_run_id WHERE declared_node_run_id IS NULL AND node_run_id IS NOT NULL",
  "ALTER TABLE release_report_artifacts ADD COLUMN position INTEGER NOT NULL DEFAULT 0"
];

const sqliteManagerReportRoundNumberStatements = [
  "ALTER TABLE agent_human_reports ADD COLUMN manager_round_number INTEGER"
];

const sqliteApprovalThreadStatements = [
  `CREATE TABLE IF NOT EXISTS approval_threads (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','closed')),
    title TEXT NOT NULL,
    run_id TEXT,
    round_id TEXT,
    node_run_id TEXT,
    source_type TEXT,
    source_id TEXT,
    current_request_id TEXT,
    current_revision INTEGER NOT NULL,
    capabilities_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  )`,
  `INSERT OR IGNORE INTO approval_threads (
     id, kind, status, title, run_id, round_id, node_run_id, source_type, source_id,
     current_request_id, current_revision, capabilities_json, created_at, updated_at, closed_at
   )
   SELECT
     COALESCE(thread_id, id),
     kind,
     CASE WHEN status = 'pending' THEN 'open' ELSE 'closed' END,
     title,
     run_id,
     round_id,
     node_run_id,
     source_type,
     source_id,
     CASE WHEN status = 'pending' THEN id ELSE NULL END,
     revision,
     capabilities_json,
     requested_at,
     COALESCE(updated_at, requested_at),
     CASE WHEN status = 'pending' THEN NULL ELSE COALESCE(updated_at, requested_at) END
   FROM approval_requests`,
  `CREATE TABLE IF NOT EXISTS approval_replies_next (
    id TEXT PRIMARY KEY,
    approval_request_id TEXT REFERENCES approval_requests(id) ON DELETE SET NULL,
    thread_id TEXT NOT NULL REFERENCES approval_threads(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  )`,
  `INSERT OR IGNORE INTO approval_replies_next (id, approval_request_id, thread_id, message, actor, created_at)
   SELECT
     approval_replies.id,
     approval_replies.approval_request_id,
     COALESCE(approval_requests.thread_id, approval_replies.approval_request_id),
     approval_replies.message,
     approval_replies.actor,
     approval_replies.created_at
   FROM approval_replies
   LEFT JOIN approval_requests ON approval_requests.id = approval_replies.approval_request_id
   WHERE COALESCE(approval_requests.thread_id, approval_replies.approval_request_id) IS NOT NULL`,
  "DROP TABLE approval_replies",
  "ALTER TABLE approval_replies_next RENAME TO approval_replies",
  `CREATE INDEX IF NOT EXISTS idx_approval_threads_run_status ON approval_threads(run_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_approval_replies_thread_created ON approval_replies(thread_id, created_at)`
];

const sqliteApprovalReplyMetadataStatements = [
  "ALTER TABLE approval_replies ADD COLUMN metadata_json TEXT",
  `UPDATE approval_replies
   SET metadata_json = '{"legacySource":"approval_replies_v1","legacyAction":"reply","legacyMeaning":"message_only","requestKind":"'
     || COALESCE((SELECT kind FROM approval_requests WHERE approval_requests.id = approval_replies.approval_request_id), 'unknown')
     || '"}'
   WHERE metadata_json IS NULL`
];

const sqliteApprovalReplyLegacyMeaningStatements = [
  `UPDATE approval_replies
   SET metadata_json = '{"legacySource":"approval_replies_v1","legacyAction":"reply","legacyMeaning":"'
     || CASE COALESCE((SELECT kind FROM approval_requests WHERE approval_requests.id = approval_replies.approval_request_id), 'unknown')
       WHEN 'agent_proposal' THEN 'legacy_agent_rerun_feedback'
       WHEN 'iteration_requirement_plan' THEN 'legacy_requirement_revision_feedback'
       WHEN 'manager_release_report' THEN 'legacy_release_report_feedback'
       ELSE 'message_only'
     END
     || '","requestKind":"'
     || COALESCE((SELECT kind FROM approval_requests WHERE approval_requests.id = approval_replies.approval_request_id), 'unknown')
     || '"}'
   WHERE metadata_json LIKE '%"legacySource":"approval_replies_v1"%'`
];

const sqliteRuntimeRefCanonicalColumnStatements = [
  "ALTER TABLE runs RENAME COLUMN openclaw_refs_json TO runtime_refs_json",
  "ALTER TABLE node_runs RENAME COLUMN openclaw_ref_json TO runtime_ref_json",
  "ALTER TABLE run_events RENAME COLUMN openclaw_ref_json TO runtime_ref_json"
];

function checksumStatements(statements: string[]): string {
  return createHash("sha256").update(statements.join("\n")).digest("hex");
}

export const sqliteMigrations: SqliteMigration[] = [
  {
    version: 1,
    name: "sqlite_vnext_v1",
    checksum: checksumStatements(sqliteInitialSchemaStatements),
    up: sqliteInitialSchemaStatements
  },
  {
    version: 2,
    name: "legacy_migration_compatibility",
    checksum: checksumStatements(sqliteLegacyMigrationCompatibilityStatements),
    up: sqliteLegacyMigrationCompatibilityStatements
  },
  {
    version: 3,
    name: "manager_report_round_number",
    checksum: checksumStatements(sqliteManagerReportRoundNumberStatements),
    up: sqliteManagerReportRoundNumberStatements
  },
  {
    version: 4,
    name: "approval_threads",
    checksum: checksumStatements(sqliteApprovalThreadStatements),
    up: sqliteApprovalThreadStatements
  },
  {
    version: 5,
    name: "approval_reply_metadata",
    checksum: checksumStatements(sqliteApprovalReplyMetadataStatements),
    up: sqliteApprovalReplyMetadataStatements
  },
  {
    version: 6,
    name: "approval_reply_legacy_meaning",
    checksum: checksumStatements(sqliteApprovalReplyLegacyMeaningStatements),
    up: sqliteApprovalReplyLegacyMeaningStatements
  },
  {
    version: 7,
    name: "runtime_ref_canonical_columns",
    checksum: checksumStatements(sqliteRuntimeRefCanonicalColumnStatements),
    up: sqliteRuntimeRefCanonicalColumnStatements
  }
];

export const sqliteSchemaVersion = sqliteMigrations.at(-1)?.version ?? 0;
export const sqliteSchemaStatements = sqliteMigrations.flatMap((migration) => migration.up);

export const sqliteRequiredSchema = {
  schema_migrations: ["version", "name", "applied_at", "checksum"],
  migration_manifests: ["id", "source_root", "backup_root", "source_manifest_json", "result_json", "status", "created_at"],
  runs: ["id", "company_id", "blueprint_id", "status", "started_by", "started_at", "runtime_refs_json", "row_version", "updated_at"],
  run_sequence_counters: ["run_id", "scope", "last_sequence", "updated_at"],
  node_runs: ["id", "run_id", "blueprint_id", "node_id", "node_label", "node_type", "status", "runtime_ref_json", "lease_owner", "worker_epoch", "row_version", "updated_at"],
  node_run_payloads: ["node_run_id", "input_json", "output_json", "raw_result_json", "updated_at"],
  run_events: ["id", "run_id", "node_run_id", "sequence", "type", "message", "runtime_ref_json", "created_at"],
  approval_threads: ["id", "kind", "status", "title", "current_revision", "capabilities_json", "created_at", "updated_at"],
  approval_replies: ["id", "approval_request_id", "thread_id", "message", "actor", "created_at", "metadata_json"],
  approval_requests: ["id", "run_id", "round_id", "node_run_id", "kind", "status", "title", "body", "revision", "requested_by_json", "requested_at"],
  approval_decisions: ["id", "approval_request_id", "action", "actor", "resulting_status", "created_at"],
  inbox_items: ["id", "company_id", "type", "status", "title", "summary", "created_by_role_id", "created_at", "updated_at"],
  agent_outputs: ["id", "run_id", "round_id", "node_run_id", "node_id", "envelope_json", "created_at"],
  agent_human_reports: ["id", "run_id", "round_id", "manager_round_number", "node_run_id", "node_id", "node_label", "title", "body_md", "source", "created_at"],
  agent_handoffs: ["id", "run_id", "round_id", "node_run_id", "node_id", "payload_json", "created_at"],
  artifacts: ["id", "run_id", "round_id", "node_run_id", "declared_node_run_id", "kind", "storage_path", "relative_path", "download_url", "preview_policy", "trusted", "status", "created_at"],
  release_reports: ["id", "run_id", "round_id", "approval_request_id", "version", "title", "summary", "created_at"],
  release_report_artifacts: ["release_report_id", "artifact_id", "position", "title", "location", "current"],
  run_timeline_items: ["id", "run_id", "sequence", "created_at", "actor_label", "kind", "title"],
  chat_sessions: ["id", "harness_id", "mode", "status", "created_at", "updated_at"],
  chat_messages: ["id", "session_id", "role", "content", "status", "harness_id", "created_at"]
} satisfies Record<string, string[]>;

export const sqliteRequiredIndexes = {
  runs: ["idx_runs_company_started", "idx_runs_blueprint_started", "idx_runs_status_updated"],
  node_runs: ["idx_node_runs_run_status", "idx_node_runs_run_round_node"],
  run_events: ["idx_run_events_run_created"],
  run_timeline_items: ["idx_run_timeline_run_created"],
  approval_threads: ["idx_approval_threads_run_status"],
  approval_replies: ["idx_approval_replies_thread_created"],
  approval_requests: ["idx_approval_requests_status_created", "idx_approval_requests_run_round"],
  artifacts: ["idx_artifacts_run_round_node"],
  release_reports: ["idx_release_reports_run_round"]
} satisfies Record<string, string[]>;

export const sqliteRequiredUniqueConstraints = [
  { table: "run_events", columns: ["run_id", "sequence"] },
  { table: "run_timeline_items", columns: ["run_id", "sequence"] },
  { table: "agent_outputs", columns: ["node_run_id"] }
];

export const sqliteRequiredForeignKeys = [
  { table: "runs", from: "company_id", targetTable: "companies", to: "id" },
  { table: "node_runs", from: "run_id", targetTable: "runs", to: "id" },
  { table: "run_events", from: "run_id", targetTable: "runs", to: "id" },
  { table: "run_timeline_items", from: "run_id", targetTable: "runs", to: "id" },
  { table: "approval_decisions", from: "approval_request_id", targetTable: "approval_requests", to: "id" },
  { table: "approval_replies", from: "approval_request_id", targetTable: "approval_requests", to: "id" },
  { table: "approval_replies", from: "thread_id", targetTable: "approval_threads", to: "id" },
  { table: "artifacts", from: "run_id", targetTable: "runs", to: "id" },
  { table: "release_reports", from: "run_id", targetTable: "runs", to: "id" },
  { table: "release_report_artifacts", from: "artifact_id", targetTable: "artifacts", to: "id" }
];

export const sqliteRequiredChecks = [
  { table: "runs", contains: "status IN ('queued','running','succeeded','failed','cancelled','skipped','waiting_approval')" },
  { table: "node_runs", contains: "status IN ('queued','running','succeeded','failed','cancelled','skipped','waiting_approval')" },
  { table: "approval_requests", contains: "status IN ('pending','approved','rejected','replied','completed','terminated','superseded')" },
  { table: "approval_threads", contains: "status IN ('open','closed')" },
  { table: "approval_decisions", contains: "actor IN ('user','system','manager')" },
  { table: "artifacts", contains: "kind IN ('html','markdown','json','file','link')" },
  { table: "artifacts", contains: "preview_policy IN ('none','source','sandboxed_iframe')" },
  { table: "artifacts", contains: "status IN ('current','rejected','superseded','failed')" },
  { table: "release_reports", contains: "version >= 1" }
];

export type DashboardWidgetType =
  | "recent_runs"
  | "pending_approvals"
  | "runtime_overview"
  | "catalog_status"
  | "notes";

export interface DashboardWidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardWidget {
  id: string;
  type: DashboardWidgetType;
  title: string;
  layout: DashboardWidgetLayout;
  config?: Record<string, unknown>;
}

export interface SavedView {
  id: string;
  name: string;
  blueprintId?: string;
  filters: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTag {
  id: string;
  label: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceNote {
  id: string;
  title: string;
  body: string;
  relatedBlueprintId?: string;
  relatedRunId?: string;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PendingApprovalItem {
  approvalRequestId?: string;
  approvalThreadId?: string;
  kind?: string;
  blueprintId: string;
  blueprintName: string;
  blueprintRunId: string;
  nodeRunId: string;
  nodeId: string;
  nodeLabel: string;
  harnessId?: string;
  startedBy: string;
  startedAt: string;
  requestedAt: string;
  reviewOutput?: unknown;
  replies?: PendingApprovalReply[];
  selectedReplyId?: string;
  status?: "pending" | "replying" | "approved" | "rejected" | "replied" | "completed" | "terminated" | "superseded";
  decidedAt?: string;
  decisionComment?: string;
  canApprove?: boolean;
  canReply?: boolean;
  canReject?: boolean;
  canComplete?: boolean;
  canTerminate?: boolean;
  canRequestChanges?: boolean;
  canRevise?: boolean;
  upstream?: PendingApprovalUpstreamItem[];
}

export interface PendingApprovalReply {
  id: string;
  role: "assistant" | "user";
  body: string;
  createdAt: string;
  selected?: boolean;
  canUseAsSolution?: boolean;
}

export interface PendingApprovalUpstreamItem {
  nodeId: string;
  nodeLabel: string;
  nodeRunId: string;
  output: unknown;
}

export type InboxItemStatus = "pending" | "approved" | "rejected";

export type InboxItemType =
  | "leader_delegation"
  | "blueprint_proposal"
  | "run_request"
  | "company_config";

export interface InboxItem {
  id: string;
  companyId: string;
  type: InboxItemType;
  status: InboxItemStatus;
  title: string;
  summary: string;
  createdByRoleId: string;
  targetRoleId?: string;
  blueprintId?: string;
  blueprintName?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decisionComment?: string;
  replies?: InboxItemReply[];
}

export interface InboxItemReply {
  id: string;
  role: "user";
  body: string;
  createdAt: string;
}

export interface WorkspaceDashboard {
  dashboardWidgets: DashboardWidget[];
  savedViews: SavedView[];
  tags: WorkspaceTag[];
  notes: WorkspaceNote[];
  updatedAt: string;
}

export function createDefaultWorkspaceDashboard(now: string): WorkspaceDashboard {
  return {
    dashboardWidgets: [],
    savedViews: [],
    tags: [],
    notes: [],
    updatedAt: now
  };
}

export function normalizeWorkspaceDashboard(
  value: Partial<WorkspaceDashboard> | undefined,
  now: string
): WorkspaceDashboard {
  return {
    dashboardWidgets: Array.isArray(value?.dashboardWidgets) ? value.dashboardWidgets : [],
    savedViews: Array.isArray(value?.savedViews) ? value.savedViews : [],
    tags: Array.isArray(value?.tags) ? value.tags : [],
    notes: Array.isArray(value?.notes) ? value.notes : [],
    updatedAt: typeof value?.updatedAt === "string" && value.updatedAt ? value.updatedAt : now
  };
}

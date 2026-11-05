// 保留本地启动和 RPC 使用的兼容枚举；不再注册、采集或发送统计事件。

export {
  AGENT_KIND_VALUES,
  addRepoDefaultCheckoutHandoffReasonSchema,
  addRepoDefaultCheckoutHandoffResultSchema,
  addRepoDefaultCheckoutHandoffSourceSchema,
  addRepoExistingWorkspaceSourceSchema,
  addRepoSetupStepActionSchema,
  agentKindSchema,
  errorClassSchema,
  launchSourceSchema,
  repoMethodSchema,
  requestKindSchema,
  setupScriptImportProviderSchema,
  workspaceCreateErrorClassSchema,
  workspaceSourceSchema
} from './telemetry-property-schemas'
export type {
  AddRepoDefaultCheckoutHandoffSource,
  AddRepoExistingWorkspaceSource,
  AgentKind,
  ErrorClass,
  LaunchSource,
  RepoMethod,
  RequestKind,
  WorkspaceCreateErrorClass,
  WorkspaceSource
} from './telemetry-property-schemas'

export type { HookInstallAgent, RuntimeRpcStartErrorClass } from './telemetry-daemon-event-schemas'

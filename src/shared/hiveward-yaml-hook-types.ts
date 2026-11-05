export type SetupRunPolicy = 'ask' | 'run-by-default' | 'skip-by-default'
export type SetupAgentStartupPolicy = 'start-immediately' | 'wait-for-setup'
export type HookCommandSourcePolicy = 'shared-only' | 'local-only' | 'run-both'

export type HiveWardHooks = {
  scripts: {
    setup?: string // Runs after worktree is created
    archive?: string // Runs before worktree is archived
  }
  setupAgentStartupPolicy?: SetupAgentStartupPolicy
  issueCommand?: string // Shared default command for linked GitHub issues
  defaultTabs?: HivewarddefaultTabTemplate[] // Terminal tabs to create once for a new worktree
  environmentRecipes?: HiveWardVmRecipe[] // Project-scoped per-workspace environment recipes
  environmentRecipeDiagnostics?: HiveWardVmRecipeDiagnostic[] // Non-fatal validation issues from environmentRecipes
  worktree?: HiveWardWorktreeDefaults // Project-scoped defaults applied when a worktree is created
}

export type HiveWardWorktreeDefaults = {
  // Share large rebuildable directories such as node_modules across worktrees instead of copying installs.
  sharedDirectories?: string[]
}

export type HivewarddefaultTabTemplate = {
  title?: string
  color?: string
  command?: string
}

export type EphemeralVmCheckoutMode = 'hiveward-worktree' | 'provisioned-root'

export type HiveWardVmRecipe = {
  id: string
  name: string
  create: string
  checkoutMode?: EphemeralVmCheckoutMode
  description?: string
  suspend?: string
  resume?: string
  destroy?: string
  destroyDisabled?: boolean
}

export type HiveWardVmRecipeDiagnostic = {
  index: number
  field?: string
  message: string
}

export type RepoHookSettings = {
  // Retain the old hook-UI mode so persisted state reads without migration.
  mode: 'auto' | 'override'
  setupRunPolicy?: SetupRunPolicy
  setupAgentStartupPolicy?: SetupAgentStartupPolicy
  commandSourcePolicy?: HookCommandSourcePolicy
  scripts: {
    setup: string
    archive: string
  }
}

export type PersistedTrustedHiveWardHookEntry = {
  contentHash: string
  approvedAt: number
}

export type PersistedTrustedHiveWardHookRepo = {
  all?: {
    approvedAt: number
  }
  setup?: PersistedTrustedHiveWardHookEntry
  archive?: PersistedTrustedHiveWardHookEntry
  issueCommand?: PersistedTrustedHiveWardHookEntry
  vmRecipe?: PersistedTrustedHiveWardHookEntry
}

export type PersistedTrustedHiveWardHooks = Record<string, PersistedTrustedHiveWardHookRepo>

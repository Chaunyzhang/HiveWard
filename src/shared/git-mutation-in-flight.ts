/** Whether the execution host is running or has queued an HiveWard Git command that can change this worktree. */
export type GitMutationInFlight = {
  inFlight: boolean
}

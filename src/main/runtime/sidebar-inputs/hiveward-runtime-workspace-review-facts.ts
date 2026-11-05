import { HiveWardRuntimeWithWorkspaceActivityFacts } from './hiveward-runtime-workspace-activity-facts'
import {
  buildWorkspaceReviewFacts,
  type WorkspaceReviewFactsSnapshot
} from '../../../shared/sidebar-list/workspace-review-facts'

/** Read host-persisted PR facts on demand; windows save cache updates within a second, while hivewardd uses its existing profile. */
export abstract class HiveWardRuntimeWithWorkspaceReviewFacts extends HiveWardRuntimeWithWorkspaceActivityFacts {
  async getWorkspaceReviewFacts(): Promise<WorkspaceReviewFactsSnapshot> {
    if (!this.store) {
      return { facts: {} }
    }
    const { worktrees } = await this.listResolvedWorktreeSnapshot()
    return {
      facts: buildWorkspaceReviewFacts(
        worktrees,
        this.store.getRepos(),
        this.store.getGitHubCache().pr
      )
    }
  }
}

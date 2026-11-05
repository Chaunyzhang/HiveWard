/** Worktree-relative folder that client files dropped onto a remote workspace are uploaded into. */
export const DROP_STAGING_RELATIVE_DIR = '.hiveward/drops'

// Why: `*` also matches the ignore file itself. Un-ignoring it (`!.gitignore`) left
// `?? .hiveward/.gitignore` behind, which still blocked a plain workspace delete.
export const DROP_STAGING_GITIGNORE_CONTENT = '*\n'

/** Nonidentifying child marker; current CLIs prefer injected session IDs. Retain it both for old children without IDs
 * and old CLIs that refuse by marker. A structured session has no pane: implicit guesses hit siblings and orchestration check is destructive by default. */
export const HIVEWARD_STRUCTURED_SESSION_ENV = 'HIVEWARD_STRUCTURED_SESSION'

export function hasStructuredSessionMarker(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[HIVEWARD_STRUCTURED_SESSION_ENV] ?? '').length > 0
}

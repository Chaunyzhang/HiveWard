import { z } from 'zod'

export const HIVEWARDD_PROFILE_PREFLIGHT_FLAG = '--hivewardd-profile-state-preflight'
export const HIVEWARDD_STARTUP_PREFLIGHT_FLAG = '--hivewardd-startup-preflight'
export const HIVEWARDD_PROFILE_PREFLIGHT_TIMEOUT_MS = 90_000
// Server startup follows the disposable native/SQLite probe on every bundled launch.
export const HIVEWARDD_STARTUP_READINESS_TIMEOUT_MS = HIVEWARDD_PROFILE_PREFLIGHT_TIMEOUT_MS + 90_000

export const HIVEWARDD_PREFLIGHT_RUNTIMES = ['node', 'bun'] as const

/** The runtime the caller launched; the candidate must prove it ran under exactly this one. */
export type HivewarddPreflightRuntimeIdentity = {
  runtime: (typeof HIVEWARDD_PREFLIGHT_RUNTIMES)[number]
  runtimeVersion: string
}

export const hivewarddProfilePreflightResponseSchema = z.object({
  type: z.literal('hiveward_profile_state_ready'),
  nonce: z.string().uuid(),
  runtime: z.enum(HIVEWARDD_PREFLIGHT_RUNTIMES),
  runtimeVersion: z.string().min(1),
  artifactVersion: z.string().regex(/^\d+\.\d+\.\d+\+[a-f0-9]{12}$/),
  sqliteVersion: z.string().min(1),
  revision: z.number().int().positive(),
  /** Daemon generations alive under the served data root, when asked; null when unverifiable. */
  liveDaemonProtocols: z.array(z.number().int().positive()).nullable().optional()
})

export type HivewarddProfilePreflightResponse = z.infer<typeof hivewarddProfilePreflightResponseSchema>

/** A fresh challenge prevents stale or unrelated output from admitting a candidate. */
export function parseHivewarddProfilePreflight(
  output: string,
  nonce: string,
  expected: HivewarddPreflightRuntimeIdentity,
  artifactVersion?: string
): HivewarddProfilePreflightResponse {
  const response = hivewarddProfilePreflightResponseSchema.parse(JSON.parse(output.trim()))
  if (
    response.nonce !== nonce ||
    response.runtime !== expected.runtime ||
    response.runtimeVersion !== expected.runtimeVersion ||
    (artifactVersion !== undefined && response.artifactVersion !== artifactVersion)
  ) {
    throw new Error('Profile preflight did not run under the expected candidate runtime')
  }
  return response
}

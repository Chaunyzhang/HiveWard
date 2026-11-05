// Remember failures only for this session so restarting retries once.
export type HivewarddUpdateFailureHost = { kind: 'ssh' | 'wsl'; id: string }

export type HivewarddUpdateFailure = { code: string; reason: string }

const failedThisLaunch = new Map<string, HivewarddUpdateFailure>()

function key(host: HivewarddUpdateFailureHost): string {
  return `${host.kind}:${host.id}`
}

export function recordHivewarddUpdateFailedThisLaunch(
  host: HivewarddUpdateFailureHost,
  failure: HivewarddUpdateFailure
): void {
  failedThisLaunch.set(key(host), failure)
}

export function hivewarddUpdateFailureThisLaunch(
  host: HivewarddUpdateFailureHost
): HivewarddUpdateFailure | null {
  return failedThisLaunch.get(key(host)) ?? null
}

export function hivewarddUpdateFailedThisLaunch(host: HivewarddUpdateFailureHost): boolean {
  return failedThisLaunch.has(key(host))
}

export function clearHivewarddUpdateFailedThisLaunch(host: HivewarddUpdateFailureHost): void {
  failedThisLaunch.delete(key(host))
}

export function resetHivewarddUpdateFailuresForTests(): void {
  failedThisLaunch.clear()
}

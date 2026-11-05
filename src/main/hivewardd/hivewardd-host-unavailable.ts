// Remember repeatable deployment refusals per app version; host-fixable settings must be reprobed.

export class HivewarddHostUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HivewarddHostUnsupportedError'
  }
}

export class HivewarddArtifactsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HivewarddArtifactsUnavailableError'
  }
}

export class HivewarddStdioBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HivewarddStdioBridgeUnavailableError'
  }
}

export const HIVEWARDD_TUNNEL_UNAVAILABLE_REASON = 'ssh_tunnel_unavailable'
export const HIVEWARDD_WINDOWS_LAUNCH_REFUSED_CODE = 'hivewardd_windows_launch_refused'
export const HIVEWARDD_WINDOWS_COMMAND_LINE_UNSAFE_CODE = 'hivewardd_windows_command_line_unsafe'

export type HivewarddHostUnavailableReason =
  | 'unsupported_host'
  | 'artifacts_unavailable'
  | 'libc_unidentified'
  | 'runtime_self_test'
  | 'runtime_noexec'
  | 'windows_build_unsupported'
  | 'windows_no_extractor'
  | 'security_software'
  | 'native_preflight'
  | typeof HIVEWARDD_TUNNEL_UNAVAILABLE_REASON

const UNAVAILABLE_BY_ERROR_NAME: Record<string, HivewarddHostUnavailableReason> = {
  HivewarddHostUnsupportedError: 'unsupported_host',
  HivewarddArtifactsUnavailableError: 'artifacts_unavailable',
  HivewarddRemoteLaunchUnsupportedError: 'unsupported_host',
  UnidentifiedHostLibcError: 'libc_unidentified',
  RemoteNodeRuntimeSelfTestError: 'runtime_self_test',
  RemoteNodeRuntimeNoexecError: 'runtime_noexec',
  RemoteWindowsBuildUnsupportedError: 'windows_build_unsupported',
  RemoteNodeRuntimeNoExtractorError: 'windows_no_extractor',
  RemoteNodeRuntimeSecurityModifiedError: 'security_software',
  HivewarddStdioBridgeUnavailableError: HIVEWARDD_TUNNEL_UNAVAILABLE_REASON,
  HivewarddWindowsLaunchRefusedError: 'unsupported_host',
  HivewarddWindowsCommandLineError: 'unsupported_host'
}

// Native preflight, PTY self-test and permanent Windows refusals repeat; transient races do not.
const UNAVAILABLE_BY_DEFERRAL_CODE: Record<string, HivewarddHostUnavailableReason> = {
  hivewardd_candidate_preflight_failed: 'native_preflight',
  hivewardd_activation_pty_self_test_failed: 'native_preflight',
  [HIVEWARDD_WINDOWS_LAUNCH_REFUSED_CODE]: 'unsupported_host',
  [HIVEWARDD_WINDOWS_COMMAND_LINE_UNSAFE_CODE]: 'unsupported_host'
}

// Reprobed on every connect, so fixing or upgrading the host needs no new HiveWard version.
const FIXABLE_ON_HOST: ReadonlySet<string> = new Set<HivewarddHostUnavailableReason>([
  'runtime_noexec',
  'windows_build_unsupported',
  'windows_no_extractor'
])

export function isHivewarddHostUnavailableFixableOnHost(reason: string): boolean {
  return FIXABLE_ON_HOST.has(reason)
}

export function hivewarddCandidateLaunchFailureCode(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === HIVEWARDD_WINDOWS_LAUNCH_REFUSED_CODE ||
    code === HIVEWARDD_WINDOWS_COMMAND_LINE_UNSAFE_CODE
    ? code
    : 'hivewardd_candidate_launch_failed'
}

export function classifyHivewarddHostUnavailable(failure: unknown): HivewarddHostUnavailableReason | null {
  if (failure instanceof Error) {
    return UNAVAILABLE_BY_ERROR_NAME[failure.name] ?? null
  }
  if (failure && typeof failure === 'object' && 'code' in failure) {
    const code = failure.code
    return typeof code === 'string' ? (UNAVAILABLE_BY_DEFERRAL_CODE[code] ?? null) : null
  }
  return null
}

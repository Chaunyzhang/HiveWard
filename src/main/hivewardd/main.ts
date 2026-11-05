import '../memory/host-malloc-tunables-claim'
import process from 'node:process'
import { main } from './hivewardd-entry'
import { resolveHivewarddExitCode } from './hivewardd-exit-code'
import { reserveServeStdoutForReadiness } from '../server/serve-stdout-boundary'
import { runHivewarddNativePreflightVerdict } from './hivewardd-native-preflight'
import {
  HIVEWARDD_PROFILE_PREFLIGHT_FLAG,
  HIVEWARDD_STARTUP_PREFLIGHT_FLAG
} from '../../shared/hivewardd-profile-preflight'
import { onNodePtyLoadFailure } from '../providers/node-pty-load-failure'
import {
  confirmBundledHivewarddStartupQualified,
  discardBundledHivewarddStartupQualification,
  forgetBundledHivewarddStartupQualification,
  preflightBundledHivewarddStartup,
  runHivewarddProfilePreflight
} from './hivewardd-profile-preflight'
import { assertHivewarddServerRuntime } from './hivewardd-bundled-runtime'
import {
  formatHivewarddNativePreflightReport,
  HIVEWARDD_NATIVE_PREFLIGHT_FLAG
} from '../../shared/hivewardd-native-preflight-report'
import {
  HIVEWARDD_CANCEL_MANAGED_STOP_FLAG,
  HIVEWARDD_COMPLETE_MANAGED_STOP_FLAG
} from '../../shared/hivewardd-stop-request'
import {
  HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG
} from '../../shared/windows-breakaway-launch'
import { runWindowsBreakawayLaunchIfRequested } from '../../shared/windows-breakaway-launcher'
import { parseArgs } from './hivewardd-command-arguments'
import { HIVEWARDD_RECLAIM_STALE_LOCK_FLAG } from '../../shared/hivewardd-stale-lock-reclaim'

// A resolved plain-Node module graph proves the build guard; skip probes, ports and data-root locks.
if (process.argv.includes('--hivewardd-smoke-load-check')) {
  process.exit(0)
}

function failStartup(error: unknown): void {
  console.error('hivewardd: failed to start:', error)
  // Distinguish configuration refusals so supervisors cannot restart-spin on them.
  process.exit(resolveHivewarddExitCode(error))
}

// One-shot launch and stop commands must skip server startup and preflights.
if (process.argv[2] === '--hivewardd-structured-provider-load-check') {
  void import('./hivewardd-structured-provider-smoke')
    .then(({ smokeLoadHivewarddStructuredProviders }) => smokeLoadHivewarddStructuredProviders())
    .then(() => process.exit(0))
    .catch(failStartup)
} else if (process.argv[2] === WINDOWS_BREAKAWAY_LAUNCH_FLAG) {
  runWindowsBreakawayLaunchIfRequested(HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT, process.argv)
} else if (
  process.argv[2] === HIVEWARDD_COMPLETE_MANAGED_STOP_FLAG ||
  process.argv[2] === HIVEWARDD_CANCEL_MANAGED_STOP_FLAG
) {
  void import('./hivewardd-managed-stop-command').then(({ runHivewarddManagedStopCommandAndExit }) =>
    runHivewarddManagedStopCommandAndExit(process.argv.slice(2))
  )
} else if (process.argv[2] === HIVEWARDD_RECLAIM_STALE_LOCK_FLAG) {
  void import('./hivewardd-stale-lock-reclaim').then(({ runHivewarddStaleLockReclaimCommandAndExit }) =>
    runHivewarddStaleLockReclaimCommandAndExit(process.argv.slice(2))
  )
} else {
  startHivewarddProcess()
}

function startHivewarddProcess(): void {
  try {
    const argv = process.argv.slice(2)
    if ((argv.includes('--help') || argv.includes('-h')) && parseArgs(argv).help) {
      void main(argv).catch(failStartup)
      return
    }
    assertHivewarddServerRuntime()
    const flag = process.argv[2]
    if (flag === HIVEWARDD_NATIVE_PREFLIGHT_FLAG && process.argv.length === 3) {
      void import('./node-pty-precondition').then(({ checkNodePtyPrecondition }) => {
        const verdict = checkNodePtyPrecondition()
        const report = formatHivewarddNativePreflightReport(verdict.status, verdict.reason ?? null)
        process.stdout.write(`${report}\n`, () => process.exit(0))
      }, failStartup)
    } else if (
      (flag === HIVEWARDD_STARTUP_PREFLIGHT_FLAG && process.argv.length === 4) ||
      (flag === HIVEWARDD_PROFILE_PREFLIGHT_FLAG &&
        (process.argv.length === 4 || process.argv.length === 5))
    ) {
      void runHivewarddProfilePreflight(process.argv[3], {
        nativeFeatures: flag === HIVEWARDD_PROFILE_PREFLIGHT_FLAG,
        servedUserDataPath: process.argv[4]
      })
        // The owner reads EOF; lingering native handles must not keep this probe alive.
        .then(() => process.stdout.write('', () => process.exit(0)))
        .catch(failStartup)
    } else {
      // Stdout is the readiness API; send incidental diagnostics to stderr.
      reserveServeStdoutForReadiness()
      void preflightBundledHivewarddStartup()
        .then((qualified) => {
          onNodePtyLoadFailure(() => void discardBundledHivewarddStartupQualification())
          // Probe before deferred node-pty loading can crash this process; a slot qualified on this
          // unchanged host passed it on its last launch.
          if (runHivewarddNativePreflightVerdict({ qualified }) !== 'ok') {
            forgetBundledHivewarddStartupQualification()
          }
          return main()
        })
        .then(confirmBundledHivewarddStartupQualified)
        .catch(failStartup)
    }
  } catch (error) {
    failStartup(error)
  }
}

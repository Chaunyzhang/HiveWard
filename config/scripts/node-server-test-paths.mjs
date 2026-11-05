/** Mirrors HIVEWARD_REQUIRED_TEST_INPUTS_ENV in src/main/hivewardd/hivewardd-node-slot-fixture.ts. */
export const REQUIRED_TEST_INPUTS_ENV = 'HIVEWARD_REQUIRED_TEST_INPUTS'

// Need the pinned Bun and the last Bun hivewardd slot beside the built Node slot (design D7).
export const CROSS_RUNTIME_TEST_PATHS = [
  'src/main/hivewardd/hivewardd-cross-runtime-daemon-adoption.integration.test.ts',
  'src/main/persistence/profile-state/profile-state-cross-runtime.integration.test.ts'
]

// Need the built desktop server template; CI runs them by path after build-hivewardd-template.mjs.
export const TEMPLATE_TEST_PATHS = [
  'src/main/hivewardd/hivewardd-packaged-structured-chat.integration.test.ts'
]

export function nodeServerTestPaths({
  artifact = false,
  crossRuntime = false,
  template = false
} = {}) {
  return [
    'src/main/persistence/profile-state',
    'src/main/persistence/loading-store/profile-state',
    'src/main/sqlite',
    'src/main/hivewardd/hivewardd-entry.test.ts',
    'src/main/hivewardd/hivewardd-push-startup.test.ts',
    // The hivewardd server's identity and stop path, which Windows SSH hosts rely on (W2).
    'src/main/hivewardd/hivewardd-instance-lock.test.ts',
    'src/main/hivewardd/hivewardd-process-start-time.test.ts',
    'src/main/hivewardd/hivewardd-stop-request-listener.test.ts',
    'src/main/hivewardd/hivewardd-managed-stop.test.ts',
    'src/main/hivewardd/hivewardd-managed-stop-cancellation.test.ts',
    'src/main/hivewardd/hivewardd-daemon-teardown-linux.test.ts',
    // The directory, not a prefix: its siblings are POSIX-host unit tests pr.yml already runs.
    'src/main/daemon/pty-subprocess/',
    'src/main/daemon/pty-subprocess-spawn-file-foreground.test.ts',
    'src/main/daemon/pty-subprocess-io-failure-native.test.ts',
    ...(artifact
      ? [
          'tests/e2e/daemon-running-work-probe.unit.test.ts',
          'src/shared/pty-running-work-probe.test.ts',
          'src/main/hivewardd/hivewardd-packaged-node-pty.integration.test.ts',
          'src/main/providers/agent-foreground-process-git-bash.win32.test.ts',
          'src/main/hivewardd/hivewardd-node-launcher.integration.test.ts',
          'src/main/hivewardd/hivewardd-cli-launcher.integration.test.ts',
          'src/main/hivewardd/hivewardd-cli-orchestration.integration.test.ts',
          'src/main/hivewardd/hivewardd-launcher-isolation.integration.test.ts',
          'src/main/hivewardd/hivewardd-stop-request-shutdown.integration.test.ts',
          'src/main/hivewardd/hivewardd-windows-conpty-breakaway.integration.test.ts',
          'src/main/hivewardd/hivewardd-serve-parity.integration.test.ts',
          'src/main/hivewardd/hivewardd-idle-memory-budget.integration.test.ts',
          'config/scripts/zip-extractor-command.test.mjs'
        ]
      : []),
    ...(crossRuntime ? CROSS_RUNTIME_TEST_PATHS : []),
    ...(template ? TEMPLATE_TEST_PATHS : [])
  ]
}

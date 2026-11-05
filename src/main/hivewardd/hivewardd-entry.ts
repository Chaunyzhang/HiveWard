// Compose the Node-host runtime; paired desktop pages work even without a local browser engine.
import process from 'node:process'
import { getAppEnvironment } from '../../shared/app-environment'
import { resolveHivewarddInstallRoot, resolveUserDataPath } from './hivewardd-app-paths'
import { prepareHivewarddCliLauncher } from './hivewardd-cli-launcher'
import { installHivewarddHostAdapters, runHivewarddQuitHandlers } from './hivewardd-host-adapters'
import { prepareHivewarddSecretStoreAndMigrate } from './hivewardd-secret-store-startup'
import { describeHivewarddBindExposure, resolveHivewarddBindHost } from './hivewardd-bind-address'
import {
  flushHivewarddProfileStoreForShutdown,
  installHivewarddShutdownSignals,
  startHivewarddWithHost,
  stopHivewarddStructuredAgentSessions,
  type HivewarddShutdownTrigger
} from './hivewardd-lifecycle'
import {
  HIVEWARDD_USAGE,
  parseArgs,
  resolveHivewarddWebClientRoot
} from './hivewardd-command-arguments'
import type { HivewarddRuntimeCleanup } from './hivewardd-runtime-lifetime'
import { installHivewarddStopRequestListeners } from './hivewardd-stop-request-listener'
import { prepareHivewarddManagedStop } from './hivewardd-managed-stop-admission'
import { bindHivewarddStopTerminalAdmission } from './hivewardd-stop-terminal-admission'
import type { HivewarddHandle, HivewarddOptions } from './hivewardd-start-contract'
import {
  beginHivewarddIdleExit,
  bindHivewarddIdleShutdown
} from './hivewardd-managed-idle-exit-host'
import {
  hivewarddAutomationsKeepHostBusy,
  startHivewarddAutomations
} from './hivewardd-automations'
import { changedAiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import type { AiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import { stampRuntimeSourceEnv } from '../../shared/runtime-source-env'
import { adoptWslHostLoginEnvironmentLogged } from './hivewardd-wsl-host-login-environment'
import { installHivewarddProcessErrorGuards } from './hivewardd-process-error-guards'
import { hivewarddWsPortOptions } from './hivewardd-ws-port-policy'
import { createHivewarddStartupTiming } from './hivewardd-startup-timing'
import { HIVEWARD_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { restoreHivewarddTerminalAuthority } from './hivewardd-restored-terminal-authority'
import { installHivewarddFeatureReadiness } from '../runtime/rpc/hivewardd-feature-readiness'

export { parseArgs }

let closeHivewarddObservability = (): Promise<void> => Promise.resolve()

/** Resolve after transport readiness publishes the desktop-compatible serve payload. */
export async function startHivewardd(options: HivewarddOptions = {}): Promise<HivewarddHandle> {
  installHivewarddHostAdapters()
  // Inherited terminal identity must not fence hivewardd’s CLI children to the launching desktop.
  stampRuntimeSourceEnv(process.env, null)
  const userDataPath = resolveUserDataPath()
  // Override inherited data roots so CLI-shared Codex homes resolve on this host.
  process.env.HIVEWARD_USER_DATA_PATH = userDataPath
  const { readiness, instance, stop } = await startHivewarddWithHost(
    userDataPath,
    (registerCleanup) => startHivewarddRuntime(options, registerCleanup),
    async () => {
      try {
        runHivewarddQuitHandlers()
      } finally {
        // Close after quit handlers, including failed ones, so their spans reach disk.
        const closing = closeHivewarddObservability()
        closeHivewarddObservability = () => Promise.resolve()
        await closing
      }
    }
  )
  const version = getAppEnvironment().getVersion()
  return { readiness, managedStop: { version, runtimeId: readiness.runtimeId, instance }, stop }
}

async function startHivewarddRuntime(
  options: HivewarddOptions,
  registerCleanup: (cleanup: HivewarddRuntimeCleanup) => void
): Promise<Pick<HivewarddHandle, 'readiness'>> {
  const { time: timed, report: reportStartupTiming } = createHivewarddStartupTiming()
  // Overlap login-shell probing with imports and store startup.
  const loginEnvironment = adoptWslHostLoginEnvironmentLogged()
  const { startHivewarddDaemon, stopHivewarddDaemon } =
    await import('./hivewardd-daemon-supervision')
  // The daemon and its PTYs inherit the adopted login env and nothing later startup writes, so it
  // spawns as soon as that lands, in parallel with the imports, stores and hook server. Never rejects.
  const daemonStartup = loginEnvironment.then(() => timed('daemon', () => startHivewarddDaemon()))
  // Observed now: an early abort may never reach the await below.
  void daemonStartup.catch(() => {})
  // Registered first, so it runs last (cleanups run in reverse) and covers an import that throws
  // mid-spawn. It disconnects without killing daemon PTYs that must survive restart, after an
  // in-flight spawn settles; a failed one leaves only the disconnect to do.
  registerCleanup(() => daemonStartup.catch(() => {}).then(() => stopHivewarddDaemon()))
  const { HiveWardRuntimeService } = await import('../runtime/hiveward-runtime')
  const { HiveWardRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerHeadlessPtyRuntime } = await import('../ipc/pty/register-headless-runtime')
  const { getLocalPtyProvider } = await import('../ipc/pty/provider/registry')
  const { installHivewarddObservability } = await import('./hivewardd-observability')
  closeHivewarddObservability = installHivewarddObservability()
  const { ServeReadinessPublisher } = await import('../server/serve-readiness')
  const { servePublishMode } = await import('../server/serve-pairing-readiness')
  const { buildHivewarddServeReadiness } = await import('./hivewardd-serve-readiness')
  const { createHivewarddProfileStateStartup } = await import('./hivewardd-profile-state-startup')
  const { daemonOwnsFreshPersistentPtys } = await import('../daemon/daemon-provider-state')
  const { resolveDaemonSessionScrollbackRows } =
    await import('../daemon/daemon-session-scrollback-window')
  const { collectHivewarddHealth } = await import('./hivewardd-health')
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { agentHookRuntimeDeps } = await import('../agent-hooks/agent-hook-runtime-deps')
  const { installHookStatusSessionTabsRepublish } =
    await import('../agent-hooks/hook-status-session-tabs-republish')
  const { startHivewarddAgentHookServer, startHivewarddManagedAgentHooks } =
    await import('./hivewardd-managed-agent-hooks')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../runtime/agent-status-observed-pane-identity')

  const { disposeWatcherProcessAndWait } =
    await import('../ipc/filesystem/watcher-process/parcel-watcher-process')

  let paneGridsForShutdown: { flushPaneGrids(): Promise<void> | null } | null = null
  let profileStoreForShutdown:
    | { flushFinalOrThrowAsync(): Promise<void>; freezeWritesAsync(): Promise<void> }
    | undefined
  let uninstallHookStatusRepublish = (): void => {}
  let uninstallObservedStatusIdentity = (): void => {}
  // Cleanups run in reverse: RPC, then recovery and watchers, then the final flush; the daemon
  // disconnect, registered above, runs last.
  registerCleanup(() => agentHookServer.stop())
  registerCleanup(() => uninstallHookStatusRepublish())
  registerCleanup(() => uninstallObservedStatusIdentity())
  registerCleanup(async () => {
    // A SQLite-backed hivewardd has no JSON mirror to absorb a debounced write after SIGTERM.
    if (profileStoreForShutdown) {
      await flushHivewarddProfileStoreForShutdown(profileStoreForShutdown, paneGridsForShutdown)
    }
  })
  registerCleanup(stopHivewarddStructuredAgentSessions)
  registerCleanup(() => disposeWatcherProcessAndWait())

  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  const { startEventLoopDelayProbe } = await import('../diagnostics/event-loop-delay-probe')
  startEventLoopDelayProbe('hivewardd', runtimeUserDataPath)
  await timed('cli-launcher', () => prepareHivewarddCliLauncher()).catch((error: unknown) => {
    console.warn('[hivewardd] Could not prepare the profile CLI launcher', error)
  })
  const idleExitStartup = beginHivewarddIdleExit(runtimeUserDataPath)
  const { hivewarddSessionScannerIdleTimeoutMs } = await import('./hivewardd-session-scanner-idle')
  const scannerIdleTimeoutMs = hivewarddSessionScannerIdleTimeoutMs()
  if (scannerIdleTimeoutMs !== null) {
    const { setAiVaultServiceIdleTimeoutMs } =
      await import('../ai-vault/session-scanner-service-spawn')
    setAiVaultServiceIdleTimeoutMs(scannerIdleTimeoutMs)
  }
  // Initialize sealing before Store load unseals protected settings.
  await timed('secret-store', () => prepareHivewarddSecretStoreAndMigrate(runtimeUserDataPath))
  const { store: profileStore, authority: profileStateAuthority } = await timed('profile', () =>
    createHivewarddProfileStateStartup(runtimeUserDataPath)
  )
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const observedStatusCapture = new AgentStatusObservedPaneIdentityCapture(observedPaneIdentities)
  profileStoreForShutdown = profileStore
  uninstallObservedStatusIdentity = agentHookServer.subscribeEnrichedStatus((enriched) =>
    observedStatusCapture.observe(enriched)
  )
  // Subscribe before hooks start so early turns are counted.
  const { startHivewarddStats } = await import('./hivewardd-stats')
  const stats = startHivewarddStats(runtimeUserDataPath, agentHookServer, registerCleanup)
  await startHivewarddAgentHookServer(agentHookServer, {
    env: 'production',
    userDataPath: runtimeUserDataPath,
    statusHooksEnabled: isAgentStatusHooksEnabled(profileStore.getSettings())
  })

  // Reconcile, daemon and runtime all consume this environment.
  await timed('login-env-wait', () => loginEnvironment)
  const managedAgentHooks = startHivewarddManagedAgentHooks(
    profileStore,
    (enabled) => agentHookServer.setStatusHooksEnabled(enabled),
    registerCleanup
  )

  // Install the daemon provider before PTY handlers can route their first call.
  await daemonStartup

  // Runtime constructor callbacks use this index only after it is installed.
  let sessionSearch: { apply(settings: AiVaultSearchSettings): void; dispose(): void } | null = null

  const { hivewarddCodexAccountHomes } = await import('./hivewardd-codex-account-homes')
  const codexAccountHomes = hivewarddCodexAccountHomes(
    () => profileStore.getSettings(),
    registerCleanup
  )

  // Gates open where each phase finishes today; RPC starts after all of them (no behavior change).
  const featureReadiness = installHivewarddFeatureReadiness()
  const { createHivewarddAccountServices } = await import('./hivewardd-account-services')
  const accountLaunch = createHivewarddAccountServices({
    store: profileStore,
    setClaudeStatusLineListener: (listener) =>
      agentHookServer.setClaudeStatusLineListener(listener),
    registerCleanup,
    clientCodexHomes: codexAccountHomes
  })

  const { loadAgentSessionClaimSigner } =
    await import('../runtime/agent-session/ownership/agent-session-claim-identity')
  const runtime = new HiveWardRuntimeService(profileStore, stats, {
    // Persistent signatures let restarted runtimes adopt PTYs owned before restart.
    agentSessionClaimSigner: loadAgentSessionClaimSigner(runtimeUserDataPath, runtimeUserDataPath),
    getAdditionalAiVaultCodexHomePaths: () => [
      ...codexAccountHomes.listSessionHomes(),
      ...(accountLaunch?.listCodexSessionHomes() ?? [])
    ],
    // WSL must retain desktop-pushed CODEX_HOME instead of host-selected resolvers.
    ...accountLaunch?.runtimeDeps,
    ...agentHookRuntimeDeps(agentHookServer, observedPaneIdentities, () =>
      profileStore.getSettings()
    ),
    // Resolve lazily because daemon swaps replace the provider after construction.
    getLocalProvider: () => getLocalPtyProvider(),
    // Read current daemon ownership; failed/degraded launch cannot claim fresh PTY persistence.
    canRecoverPersistentLocalPtys: () => daemonOwnsFreshPersistentPtys(),
    // Node hosts cannot promote into desktop windows; override the constructor’s openable default.
    getDesktopWindowStatus: () => 'blocked',
    // No renderer reveals from this model; it keeps the daemon's live window, which deeper snapshot reads ask first.
    headlessTerminalScrollbackRows: resolveDaemonSessionScrollbackRows(),
    // Unchanged settings would reconstruct a healthy search index; deduplicate before apply.
    applySessionSearchSettings: (before, after) => {
      const next = changedAiVaultSearchSettings(before, after)
      if (next) {
        sessionSearch?.apply(next)
      }
    }
  })
  paneGridsForShutdown = runtime

  accountLaunch?.attachToRuntime(runtime)
  const { installHivewarddEmulatorBridge } = await import('./hivewardd-emulator-bridge')
  installHivewarddEmulatorBridge(runtime, registerCleanup)

  // Restore prior desktop-pushed account selection before automations or CLI launches.
  const { restoreHivewarddHostAccountLaunchEnv } =
    await import('./hivewardd-host-account-launch-env-store')
  restoreHivewarddHostAccountLaunchEnv(runtime, runtimeUserDataPath)
  featureReadiness.open('accounts')

  const { installHivewarddSessionSearchService } = await import('./hivewardd-session-search')
  sessionSearch = await installHivewarddSessionSearchService({
    userDataPath: runtimeUserDataPath,
    getSettings: () => profileStore.getSettings()
  })
  getAppEnvironment().onWillQuit(() => sessionSearch?.dispose())
  featureReadiness.open('sessionSearch')

  if (HIVEWARD_LAYOUT_OWNER_IS_MAIN) {
    const { repairDuplicatePtyPanesOnStart } = await import('../runtime/moved-pane-owner-rekey')
    // Wait behind earlier writes and persist repair before reconciliation/RPC admission.
    await repairDuplicatePtyPanesOnStart(profileStore, runtime)
  }

  // Status changes must republish session.tabs to paired clients.
  uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => runtime
  )
  registerCleanup(runtime.attachAgentStatusStore(agentHookServer))

  // Headless registration threads Store into persistence; account homes prefer client then host selection.
  // WSL has no host selection and keeps the desktop-prepared environment.
  await registerHeadlessPtyRuntime(
    runtime,
    async (target, launchEnv, context) =>
      (await codexAccountHomes.selectLaunchHome(target, launchEnv, context)) ??
      (accountLaunch ? accountLaunch.prepareCodexHome(target, launchEnv, context) : null),
    () => profileStore.getSettings(),
    accountLaunch?.prepareClaudeAuth,
    profileStore,
    accountLaunch?.prepareCodexSessionResume
  )

  // Recover browser/orchestration authority before clients attach to the runtime graph.
  runtime.rehydrateClientHostedBrowserPages()

  await restoreHivewarddTerminalAuthority(runtime, timed, featureReadiness)
  runtime.agentTransitions.seedRestoredRows()
  void runtime.sidebarFacts?.reconcileSortStampTiers(getLocalPtyProvider())

  // Run after RPC stops; later dismissal records save synchronously until exit.
  registerCleanup(() => runtime.closeNotificationDismissals())
  // Stop recovery retries before final profile flush.
  registerCleanup(() => runtime.stopLegacyWorkerTerminalRecovery())

  // Recovery establishes terminal/dispatch identities before fencing observations.
  observedStatusCapture.attach(runtime)
  agentHookServer.setCliWriterExecutionMatcher(observedPaneIdentities, runtime)
  // First RPC clients must see a fully published graph.
  const { publishHeadlessRuntimeGraph } = await import('../runtime/headless-runtime-graph')
  publishHeadlessRuntimeGraph(runtime)
  // Only the runtime can identify running shells and install deferred migrated history.
  void runtime.installPendingHivewarddMigrationShellHistory().catch((error: unknown) => {
    console.error('[hivewardd-migration] installing pending shell history failed:', error)
  })

  const bindHost = resolveHivewarddBindHost(options.bind)
  bindHivewarddStopTerminalAdmission(runtime.terminalUpdateAdmission)
  const rpc = new HiveWardRuntimeRpcServer({
    runtime,
    userDataPath: runtimeUserDataPath,
    enableWebSocket: true,
    // Pin operator exposure across restarts; pairing must not silently widen a loopback bind.
    pinnedBindHost: bindHost,
    webClientRoot: resolveHivewarddWebClientRoot(options.webClientRoot),
    ...hivewarddWsPortOptions(options.port)
  })
  // Stop RPC before cleanup can tear down writers and runtime state.
  registerCleanup(() => rpc.stop())
  await timed('rpc', () => rpc.start())
  startHivewarddAutomations(runtime, profileStore, registerCleanup)
  console.error(`[hivewardd] ${describeHivewarddBindExposure(bindHost)}`)

  const readiness = await buildHivewarddServeReadiness({
    options,
    runtimeId: runtime.getRuntimeId(),
    rpc,
    collectHealth: () =>
      collectHivewarddHealth(
        getAppEnvironment().getVersion(),
        profileStateAuthority,
        idleExitStartup.previousIdleStop
      )
  })

  await new ServeReadinessPublisher().publish(readiness, servePublishMode(options))
  reportStartupTiming()
  managedAgentHooks.readinessPublished()

  await idleExitStartup.start({
    rpc,
    agentStates: () => agentHookServer.getStatusSnapshot(),
    hasStagedMigration: () => profileStore.hasStagedHivewarddMigrationCatalog(),
    automationsBusy: () => hivewarddAutomationsKeepHostBusy(profileStore),
    emulatorsBusy: async () =>
      (await runtime.getEmulatorBridge()?.hasLiveManagedSessions()) ?? false,
    registerCleanup
  })
  return { readiness }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(HIVEWARDD_USAGE)
    return
  }
  let shutdownTrigger: HivewarddShutdownTrigger | null = null
  // Fire-and-forget startup work can reject before its first await completes.
  installHivewarddProcessErrorGuards(() => shutdownTrigger)
  const startup = startHivewardd(options)
  const requestShutdown = installHivewarddShutdownSignals(async () => (await startup).stop())
  shutdownTrigger = requestShutdown
  const handle = await startup
  // Stop requests must name the runtime/instance established by startup.
  installHivewarddStopRequestListeners(() => requestShutdown('stop request'), {
    installRoot: resolveHivewarddInstallRoot(),
    managedStop: handle.managedStop,
    beforeManagedStop: prepareHivewarddManagedStop
  })
  bindHivewarddIdleShutdown(requestShutdown)
}

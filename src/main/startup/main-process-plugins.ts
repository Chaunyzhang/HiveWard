import { join } from 'node:path'
import { PluginImageCache } from '../plugins/plugin-image-cache'
import { installPluginImageProtocolHandler } from '../plugins/plugin-image-protocol'
import { getPluginDesktopFrameServices } from '../plugins/panels/plugin-frame-desktop-services'
import { pluginHostVersion } from '../../shared/plugins/installation/plugin-host-version'
import { app, BrowserWindow } from 'electron'
import { performance } from 'node:perf_hooks'
import { PluginService } from '../plugins/plugin-service'
import { PluginBundledBootstrapCoordinator } from '../plugins/plugin-bundled-bootstrap-coordinator'
import { getPluginsDataDir } from '../plugins/plugin-discovery'
import { bundledPluginRootForApp } from '../plugins/plugin-bundled-bootstrap'
import { approveBundledPluginsFromStore } from '../plugins/plugin-bundled-approval'
import { resolvePluginHostEntryPath } from '../plugins/workers/plugin-host-process'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/plugin-enablement'
import { clearRemovedPluginSettings } from '../plugins/plugin-removal-settings'
import { clearPluginFrameStorage } from '../plugins/panels/plugin-frame-guest-sessions'
import { setPluginServiceForRpc } from '../runtime/rpc/methods/plugins'
import { bindPluginDesktopViews } from '../plugins/view/plugin-view-desktop-binding'
import { openPluginFrameGuestDevTools } from '../plugins/panels/plugin-frame-guest-diagnostics'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/approval/plugin-consent-state'
import { projectPluginAgentStatusChangedPayload } from '../plugins/plugin-agent-status-event'
import { setMainPluginLanguagePacks, setMainUiLanguage } from '../i18n/main-i18n'
import { isUsablePluginLanguagePack } from '../../shared/plugins/languages/plugin-language-pack-coverage'
import { rebuildAppMenu } from '../menu/register-app-menu'
import { rebuildSystemTrayMenu } from '../tray/system-tray'
import { logStartupMilestone } from './startup-diagnostics'
import { agentHookServer } from '../agent-hooks/server'
import {
  createPluginAgentStatusForwarder,
  pluginRuntimeDelegate,
  watchPluginWorkspaceContext
} from '../plugins/plugin-runtime-binding'
import { emitPluginWorktreeLifecycle } from './main-process-pty-startup'
import { mainProcessState as state } from './main-process-state'
import type { HiveWardRuntimeService } from '../runtime/hiveward-runtime'
import { PluginStatusBarState } from '../plugins/status-bar/plugin-status-bar-state'

export async function initializeMainProcessPlugins(runtime: HiveWardRuntimeService): Promise<void> {
  const { store, keybindings } = state
  if (!store || !keybindings) {
    throw new Error('Store and keybindings must be initialized before plugins')
  }
  const pluginSystemStartupStartedAt = performance.now()
  const pluginImageCache = new PluginImageCache(
    join(getPluginsDataDir(app.getPath('userData')), 'image-cache')
  )
  const bundledPluginRoot = bundledPluginRootForApp(app)
  state.pluginService = new PluginService({
    userDataPath: app.getPath('userData'),
    hostVersion: pluginHostVersion(app.getVersion()),
    // Feature flag: with the setting off, discovery returns nothing and no
    // plugin code path runs at all.
    isPluginSystemEnabled: () => state.store?.getSettings().pluginSystemEnabled === true,
    getDisabledPlugins: () => normalizePluginIdList(state.store?.getSettings().disabledPlugins),
    getPluginConsents: () => normalizePluginConsents(state.store?.getSettings().pluginConsents),
    getDevPluginPaths: () => normalizePluginIdList(state.store?.getSettings().devPluginPaths),
    getKeybindings: () => state.keybindings?.getOverrides() ?? {},
    hostEntryPath: resolvePluginHostEntryPath(app.getAppPath(), app.isPackaged),
    getDesktopFrameServices: getPluginDesktopFrameServices,
    statusBar: new PluginStatusBarState(),
    bundledPluginRoot
  })
  const pluginService = state.pluginService
  installPluginImageProtocolHandler({
    cache: pluginImageCache,
    findValidPlugin: (pluginKey) => state.pluginService?.findValidPlugin(pluginKey) ?? null
  })
  const bundledPluginBootstrap = new PluginBundledBootstrapCoordinator({
    root: bundledPluginRoot,
    userDataPath: app.getPath('userData'),
    hostVersion: pluginHostVersion(app.getVersion()),
    isEnabled: () => state.store?.getSettings().pluginSystemEnabled === true,
    // Why: a retired bundled plugin must not leave consent, theme choices or frame storage behind.
    beforeRetire: (pluginKey) => clearRemovedPluginSettings(store, pluginKey),
    afterRetire: (pluginKey) => clearPluginFrameStorage(pluginKey),
    refreshPlugins: () => state.pluginService?.refresh() ?? Promise.resolve(),
    approveContentPlugins: (pluginKeys) =>
      approveBundledPluginsFromStore(store, pluginService, pluginKeys)
  })
  const requestBundledPluginBootstrap = (): void => {
    void bundledPluginBootstrap
      .request()
      .then((result) => {
        for (const failure of result?.errors ?? []) {
          console.warn(`[plugins] failed to publish bundled ${failure.pluginKey}:`, failure.error)
        }
      })
      .catch((error) => console.warn('[plugins] failed to bootstrap bundled plugins:', error))
  }
  store.onSettingsChanged((updates) => {
    if ('pluginSystemEnabled' in updates || 'devPluginPaths' in updates) {
      void pluginService.refresh().catch((error) => console.warn('[plugins] refresh failed', error))
    }
  })
  // Bound here, not in the IPC handlers: a headless serve never opens a window to register them.
  const pluginDelegate = pluginRuntimeDelegate(runtime, () => agentHookServer.getStatusSnapshot())
  pluginService.setRuntimeDelegate(pluginDelegate)
  // Headless RPC resolves this service too; consent shares the desktop hash-keyed write path.
  setPluginServiceForRpc(state.pluginService, {
    applyConsent: (request) =>
      applyPluginConsent({ store, pluginService: state.pluginService!, ...request }),
    applyEnablement: (pluginKey, enabled) =>
      applyPluginEnablement({ store, pluginService: state.pluginService!, pluginKey, enabled }),
    setPluginSystemEnabled: (pluginSystemEnabled) =>
      store.updateSettings({ pluginSystemEnabled }, { notifyListeners: true }),
    setDevPluginPaths: (devPluginPaths) =>
      store.updateSettings({ devPluginPaths }, { notifyListeners: true }),
    openFrameDevTools: openPluginFrameGuestDevTools
  })
  bindPluginDesktopViews(state.isServeMode, pluginService, () => state.mainWindow)
  // Initialization discovers manifests only; workers/panel reads wait for explicit triggers.
  void state.pluginService
    .initialize()
    .then(() => {
      logStartupMilestone('plugin-system-initialized', {
        durationMs: Number((performance.now() - pluginSystemStartupStartedAt).toFixed(2)),
        installedPlugins: state.pluginService?.getDiscovered().length ?? 0
      })
      // Why delayed: catalog fetches and git checkouts must not compete with startup.
    })
    .catch((error) => console.warn('[plugins] failed to initialize plugin service:', error))
  state.pluginService.onChanged((event) => {
    if (
      event.contentPacksChanged &&
      setMainPluginLanguagePacks(
        (state.pluginService?.contentPacks.languagePacks.list() ?? []).filter(
          isUsablePluginLanguagePack
        )
      )
    ) {
      void setMainUiLanguage(store.getSettings().uiLanguage).then(() => {
        rebuildAppMenu()
        rebuildSystemTrayMenu()
      })
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('plugins:changed', event)
      }
    }
  })
  requestBundledPluginBootstrap()
  // Filter hook/worktree events server-side by each plugin subscription.
  const forwardAgentStatus = createPluginAgentStatusForwarder(pluginDelegate, pluginService)
  agentHookServer.subscribeEnrichedStatus((enriched) => {
    const payload = projectPluginAgentStatusChangedPayload(enriched)
    if (payload) {
      forwardAgentStatus(payload, enriched.terminalHandle)
    }
  })
  watchPluginWorkspaceContext({
    delegate: pluginDelegate,
    events: pluginService,
    onSessionWritten: (listener) => store.onWorkspaceSessionWritten(listener)
  })
  runtime.onWorktreeLifecycle(emitPluginWorktreeLifecycle)
}

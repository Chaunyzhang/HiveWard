const { hivewardEnvironment } = require('../src/shared/hiveward-environment.mjs')
const { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const {
  MACOS_FOLDER_USAGE_DESCRIPTIONS,
  applyMacHelperFolderUsageDescriptions
} = require('./scripts/macos-folder-usage-descriptions.cjs')
const electronBuilderNativeRebuild = require('./scripts/electron-builder-native-rebuild.cjs')
const {
  assertPackagedDaemonEntryExists,
  verifyPackagedDaemonEntryBoots,
  verifyPackagedMacTerminalHostBoots
} = require('./scripts/verify-packaged-daemon-entry.cjs')
const {
  buildMacTerminalHost,
  macTerminalHostSignIgnore,
  verifyMacTerminalHost
} = require('./scripts/macos-terminal-host-bundle.cjs')
const {
  assertPackagedNativeVariantsInstalled,
  assertProcessHostOutputBuilt,
  createPackagedRuntimeNodeModuleResources,
  prunePackagedRuntimeNodeModules,
  verifyPackagedMainRuntimeDeps
} = require('./packaged-runtime-node-modules.cjs')
const {
  assertNoWindowsExecutablesInRuntimeNodeModules
} = require('./packaged-windows-only-runtime-files.cjs')
const { verifyLinuxGlibcFloor } = require('./scripts/verify-linux-glibc-floor.cjs')
const {
  verifyPackagedWindowsAgentHook
} = require('./scripts/verify-packaged-windows-agent-hook.cjs')
const {
  ensureBundledWaylandClipboard,
  finalizePackagedWaylandClipboard
} = require('./wayland-clipboard-resources.cjs')
const { writeMacBuildCompatibility } = require('./scripts/mac-build-compatibility.cjs')
const { MOBILE_WEB_BUNDLE_DIR } = require('./scripts/verify-packaged-mobile-web-bundle.cjs')
const { verifyPackagedPluginResources } = require('./scripts/verify-packaged-plugin-resources.cjs')
const {
  assertPackagedServeSelectionEntry,
  assertPackagedWebClient
} = require('./scripts/verify-packaged-serve-payload.cjs')
const {
  assertBundledRipgrepInstalled,
  bundledRipgrepExtraResources,
  bundledRipgrepMacSignIgnore,
  finalizePackagedRipgrep
} = require('./bundled-ripgrep-resources.cjs')
const {
  verifyPackagedWindowsNodePty
} = require('./scripts/verify-packaged-node-pty-job-ownership.cjs')
const {
  assertHivewarddTemplateBuilt,
  finalizePackagedHivewarddTemplate,
  hivewarddTemplateExtraResource,
  hivewarddTemplateNodeModulesExtraResource,
  hivewarddTemplateMacSignIgnore
} = require('./scripts/packaged-hivewardd-template.cjs')
const { verifySkillsCliRuntime } = require('./scripts/verify-skills-cli-runtime.cjs')
const { assertNotDarkBuild } = require('./dark-build-switches.cjs')
const { verifyStaticAppImagePackage } = require('./scripts/static-appimage-package-contract.cjs')
const {
  appImageNodeRuntimeFpmArgs,
  placeAppImageNodeRuntime,
  verifyAppImageNodeRuntimeServesPty
} = require('./scripts/appimage-node-runtime.cjs')
const { buildMacShipItScheduling } = require('./scripts/macos-shipit-scheduling.cjs')

// 仅保留显式本地签名配置；正式 HiveWard 发版脚本使用 ad-hoc。
const isMacRelease = process.env.HIVEWARD_MAC_RELEASE === '1'
const isLinuxArm64Release = process.env.HIVEWARD_LINUX_ARM64_RELEASE === '1'
const localBuildVersion = isMacRelease ? undefined : process.env.HIVEWARD_LOCAL_BUILD_VERSION
const hivewardProduct = require('../src/shared/hiveward-product.json')
const appId = hivewardProduct.appId
// Freshness checks need immutable build identity, not skill bytes or runtime network access.
const skillFreshnessResources = {
  from: 'resources/skills',
  to: 'skills'
}
// The bundled agent-browser binary finds its version-matched catalog via the nearest skills/ above it (Resources/).
const agentBrowserSkillResources = [
  { from: 'node_modules/agent-browser/skills/agent-browser', to: 'skills/agent-browser' },
  { from: 'node_modules/agent-browser/skill-data', to: 'skill-data' }
]
// Native agents load plugins by path and cannot read inside app.asar.
const nativeChatVisualsResource = {
  from: 'resources/native-chat-visuals',
  to: 'native-chat-visuals'
}
// SSH deploy resolves process.resourcesPath/relay; extraResources keeps bundles on real disk.
const relayExtraResource = {
  from: 'out/relay',
  to: 'relay'
}
// Bootstrap verifies/publishes immutable plugin bytes from ordinary directories.
const bundledPluginResources = {
  from: 'resources/plugins/launch',
  to: 'plugins/launch'
}
// Packaged main/CLI/SSH/speech paths lack pnpm links; copy runtime closure so bare requires cannot fall through to checkout dependencies.
// Ship only the 166KB emoji dataset used by worktree naming, not all 49MB of emojibase-data.
const emojiShortcodeDatasetResource = {
  from: 'node_modules/emojibase-data/en/shortcodes/emojibase.json',
  to: 'node_modules/emojibase-data/en/shortcodes/emojibase.json'
}
const commonExtraResources = [
  { from: 'hiveward/bin', to: 'hiveward/bin' },
  { from: 'hiveward/package.json', to: 'hiveward/package.json' },
  { from: 'hiveward/docs/agent-browser.md', to: 'hiveward/docs/agent-browser.md' },
  {
    from: 'hiveward/server',
    to: 'hiveward/server',
    filter: ['**/*', '!tests/**', '!**/*.test.mjs']
  },
  {
    from: 'hiveward/shared',
    to: 'hiveward/shared',
    filter: ['**/*', '!environment.mjs', '!profile-paths.mjs']
  },
  { from: 'src/shared/hiveward-environment.mjs', to: 'hiveward/shared/environment.mjs' },
  { from: 'src/shared/hiveward-profile-storage.mjs', to: 'hiveward/shared/profile-paths.mjs' },
  { from: 'hiveward/desktop', to: 'hiveward/desktop' },
  { from: '.hiveward-build/cockpit/dist', to: 'hiveward/web' },

  relayExtraResource,
  hivewarddTemplateExtraResource,
  hivewarddTemplateNodeModulesExtraResource,
  ...bundledRipgrepExtraResources,
  bundledPluginResources,
  skillFreshnessResources,
  ...agentBrowserSkillResources,
  nativeChatVisualsResource,
  emojiShortcodeDatasetResource
]
// Native speech addons need real disk paths; copy only the artifact target’s variant.
const macSpeechNativeResource = {
  from: 'node_modules/sherpa-onnx-darwin-${arch}',
  to: 'node_modules/sherpa-onnx-darwin-${arch}'
}
const linuxSpeechNativeResource = {
  from: 'node_modules/sherpa-onnx-linux-${arch}',
  to: 'node_modules/sherpa-onnx-linux-${arch}'
}
const winSpeechNativeResource = {
  from: 'node_modules/sherpa-onnx-win-x64',
  to: 'node_modules/sherpa-onnx-win-x64'
}
// electron-builder replaces these defaults when `depends` is configured; retain
// Electron's loader requirements alongside HiveWard's headless-host dependencies.
const debElectronRuntimeDependencies = [
  'libgtk-3-0',
  'libnotify4',
  'libnss3',
  'libxss1',
  'libxtst6',
  'xdg-utils',
  'libatspi2.0-0',
  'libuuid1',
  'libsecret-1-0',
  // Electron links these but electron-builder's defaults omit them; t64 is Ubuntu 24.04+/Debian 13.
  'libasound2t64 | libasound2',
  'libgbm1'
]
const rpmElectronRuntimeDependencies = [
  'gtk3',
  'libnotify',
  'nss',
  'libXScrnSaver',
  '(libXtst or libXtst6)',
  'xdg-utils',
  'at-spi2-core',
  '(libuuid or libuuid1)',
  'alsa-lib'
]

// Mirror OS document extensions: CJS packager cannot import TS; keep startup/os-opened-documents.ts and NSIS hooks aligned.
const MARKDOWN_FILE_EXTENSIONS = ['md', 'markdown', 'mdx']
const TABULAR_FILE_EXTENSIONS = ['csv', 'tsv']

// Config loads without unused Windows addons; beforePack enforces target natives. Only @vscode/windows-process-tree has os:win32; workspace links prove no binary exists.
const windowsRuntimeResources = existsSync(
  join(__dirname, '..', 'node_modules', '@vscode', 'windows-process-tree', 'package.json')
)
  ? createPackagedRuntimeNodeModuleResources('win32')
  : []

// Shared with the terminal host helper so its purpose strings cannot drift from the app's.
const macUsageDescriptions = {
  NSAppleEventsUsageDescription:
    'HiveWard allows terminal-launched developer tools to automate local apps when you request it.',
  NSBluetoothAlwaysUsageDescription:
    'HiveWard allows terminal-launched developer tools to access Bluetooth devices when you request it.',
  NSBluetoothPeripheralUsageDescription:
    'HiveWard allows terminal-launched developer tools to access Bluetooth devices when you request it.',
  NSCalendarsUsageDescription:
    'HiveWard allows terminal-launched developer tools to access your calendars when you request it.',
  NSCalendarsFullAccessUsageDescription:
    'HiveWard allows terminal-launched developer tools to access your calendars when you request it.',
  NSCameraUsageDescription: "Application requests access to the device's camera.",
  NSContactsUsageDescription:
    'HiveWard allows terminal-launched developer tools to access your contacts when you request it.',
  NSLocationUsageDescription:
    'HiveWard allows terminal-launched developer tools to access location when you request it.',
  NSLocalNetworkUsageDescription:
    'HiveWard allows terminal-launched developer tools to discover and connect to local development servers when you request it.',
  NSMicrophoneUsageDescription: "Application requests access to the device's microphone.",
  NSRemindersUsageDescription:
    'HiveWard allows terminal-launched developer tools to access your reminders when you request it.',
  NSRemindersFullAccessUsageDescription:
    'HiveWard allows terminal-launched developer tools to access your reminders when you request it.',
  NSAudioCaptureUsageDescription:
    'HiveWard allows terminal-launched developer tools to capture desktop audio when you request it.',
  NSBonjourServices: ['_http._tcp', '_https._tcp'],
  ...MACOS_FOLDER_USAGE_DESCRIPTIONS
}
// Developer ID team that signs every release-channel mac build.
const HIVEWARD_MAC_TEAM_ID = process.env.HIVEWARD_MAC_TEAM_ID ?? null

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId,
  productName: hivewardProduct.name,
  protocols: [{ name: hivewardProduct.name, schemes: [hivewardProduct.scheme] }],
  toolsets: { appimage: '1.0.3' },
  ...(localBuildVersion ? { extraMetadata: { version: localBuildVersion } } : {}),
  directories: {
    buildResources: 'resources/build'
  },
  files: [
    '!**/.vscode/*',
    // Repo inputs already bundled/copied through extraResources would bloat app.asar.
    '!src{,/**/*}',
    '!out/hivewardd{,/**/*}',
    // Never in app.asar: the template ships via hivewarddTemplateExtraResource; prebuilds are build inputs.
    '!out/hivewardd-*{,/**/*}',
    '!out/.hivewardd-*{,/**/*}',
    // Why: the pinned Node a local hivewardd build references (~120 MB) and its download cache.
    '!out/runtimes{,/**/*}',
    '!out/node-runtime-cache{,/**/*}',
    '!config{,/**/*}',
    // Cloud services deploy separately; their sources are not desktop runtime resources.
    '!cloud{,/**/*}',
    // Release archives and other build staging are not runtime resources.
    '!.build{,/**/*}',
    // Worktree-local Vite dependency caches are development inputs.
    '!.cache/vite{,.lock}{,/**/*}',
    '!docs{,/**/*}',
    '!mobile{,/**/*}',
    '!native{,/**/*}',
    '!skills{,/**/*}',
    // Authoring guides/stubs compile into runtime artifacts; source trees only duplicate content.
    '!skill-guides{,/**/*}',
    '!skill-stubs{,/**/*}',
    '!tests{,/**/*}',
    // Examples have no runtime consumer and include adversarial hostile-panel; ship only resources/plugins/launch.
    '!examples{,/**/*}',
    // Exclude gitignored local screenshot evidence defensively so packaging cannot pick up stray captures.
    '!pr-evidence{,/**/*}',
    // Local build logs and rollback copies are never application resources.
    '!notes{,/**/*}',
    // Local tooling directories are not runtime inputs and may contain symlink loops.
    '!{.claude,.grok,.agents,.codex}{,/**/*}',
    '!Casks{,/**/*}',
    '!{AGENTS.md,CLAUDE.md,DEVELOPING.md,bundle-size-progress.md,ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md,ORCHESTRATION_STRUCTURED_OUTPUT_DESIGN.md}',
    '!out/**/*.test.js',
    // Why: main builds with sourcemap:'hidden' so release CI can publish maps
    // for decoding minified crash traces. The app never loads them (no
    // sourceMappingURL is emitted), and packing them would add ~34MB to app.asar.
    '!out/**/*.map',
    // Why: Vite's manifest is only used to project the paired web client.
    '!out/renderer{,/**/*}',
    '!out/preload{,/**/*}',
    // The installed browser serves its allowlisted assets from the unpacked renderer.
    '!out/web{,/**/*}',
    // HiveWard 不带 HiveWard 的手机网页包（HiveWard 手机 App 用的界面），手机端另做
    '!out/mobile-web{,/**/*}',
    // Local dev Electron.app caches (~270MB/branch) must not enter packaged builds.
    '!out/electron-dev{,/**/*}',
    // extraResources already ships relay; duplicating it in asar added 14MB and let script-heuristic quarantine gut the whole archive (#20966/#20972).
    '!out/relay{,/**/*}',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!{.oxlintrc.json,.oxfmtrc.json,components.json,opencode.json,hiveward.yaml,pnpm-workspace.yaml,vite.web.config.ts}',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!tsconfig.json',
    // Feature media is read from process.resourcesPath via extraResources; exclude duplicate sources.
    '!resources/onboarding/feature-wall/**',
    '!resources/skills/**',
    '!resources/native-chat-visuals/**',
    // extraResources already ships plugin bytes; exclude source duplicates.
    '!resources/plugins/launch/**',
    // Platform extraResources selects speech natives; asar would duplicate it and ship other variants.
    '!node_modules/sherpa-onnx*{,/**/*}',
    // CLI shims belong beside the packaged launchers; unpacking source creates a second .cmd without its executable (#7351).
    '!resources/win32{,/**/*}'
  ],
  // Node-mode CLI/daemon/foreign SQLite reader/serve entries cannot read asar; unpack their shared/main dependencies too.
  // Keep out/package.json’s CommonJS boundary and remote CLI WebSocket/E2EE deps. Electron-only workers may stay packed.
  // Renderer/mobile-web assets need real paths: swept temporary asar extracts are not recreated (#27976).
  asarUnpack: [
    'out/package.json',
    'out/cli/**',
    'out/shared/**',
    'out/main/agent-hooks/**',
    'out/main/antigravity/**',
    'out/main/claude/**',
    'out/main/codex/**',
    'out/main/copilot/**',
    'out/main/cursor/**',
    'out/main/droid/**',
    'out/main/gemini/**',
    'out/main/gitlab/project-ref-parser.js',
    'out/main/grok/**',
    'out/main/hermes/**',
    'out/main/asar-transparent-fs.js',
    'out/main/macos-tree-clone.js',
    'out/main/hiveward-profiles/profile-index-store.js',
    'out/main/persistence/profile-state/**',
    'out/main/plugins/plugin-authoring-checks.js',
    // `hiveward plugin types` copies the author typings from here in Node mode.
    'resources/plugins/declarative/hiveward*.d.ts',
    // `hiveward plugin test` and `hiveward plugin check` load the runtime, kit and hooks in Node.
    'resources/plugins/declarative/*.mjs',
    'resources/plugins/types/*.d.ts',
    'out/main/skills/bundled-skill-install/cli-entry.js',
    'out/main/startup/http1-compatibility-marker.js',
    'out/main/startup/hiveward-launch-agent-migration.js',
    'out/main/daemon-entry.js',
    'out/main/session-scanner-service-entry.js',
    'out/main/wsl-transcript-fs-process-entry.js',
    'out/main/foreign-sqlite-reader-entry.js',
    'out/main/plugin-host-entry.js',
    'out/main/browser-extension-native-host-supervisor-entry.js',
    'out/main/computer-sidecar.js',
    'out/main/parcel-watcher-process-entry.js',
    'out/main/hivewardd/hivewardd-local-serve-selection-entry.js',
    'out/main/hivewardd/hivewardd-stale-lock-reclaim.js',
    'out/main/chunks/**',
    'resources/**',
    'node_modules/ws/**',
    'node_modules/tweetnacl/**',
    'node_modules/zod/**',
    'node_modules/yaml/**'
  ],
  artifactBuildCompleted: ({ file, arch }) => {
    if (file.endsWith('.AppImage')) {
      verifyStaticAppImagePackage(file, arch)
    }
  },
  // electron-builder calls this with the context alone. The second parameter is the bundle root,
  // so a test can point the guard at a scratch bundle instead of needing the repo's out/ built.
  beforePack: (
    context,
    mobileWebBundleDir = MOBILE_WEB_BUNDLE_DIR,
    ensureWaylandClipboard = ensureBundledWaylandClipboard,
    hivewarddTemplateDir = join(__dirname, '..', hivewarddTemplateExtraResource.from)
  ) => {
    // The template is the server every SSH host gets, so a dark test template must never ship.
    assertNotDarkBuild([join(__dirname, '..', 'out', 'main'), mobileWebBundleDir, hivewarddTemplateDir])
    assertPackagedNativeVariantsInstalled(context.electronPlatformName, context.arch)
    assertBundledRipgrepInstalled()
    assertProcessHostOutputBuilt()
    assertHivewarddTemplateBuilt()
    if (context.electronPlatformName === 'linux') {
      ensureWaylandClipboard(context.arch)
    }
  },
  afterPack: async (context) => {
    const resourcesDir =
      context.electronPlatformName === 'darwin'
        ? join(
            context.appOutDir,
            `${context.packager.appInfo.productFilename}.app`,
            'Contents',
            'Resources'
          )
        : join(context.appOutDir, 'resources')
    if (!existsSync(resourcesDir)) {
      throw new Error(`Missing packaged resources directory: ${resourcesDir}`)
    }
    // FpmTarget replaces this with deb/rpm while building those artifacts from the shared app tree.
    if (context.electronPlatformName === 'linux') {
      writeFileSync(join(resourcesDir, 'package-type'), 'AppImage')
    }
    if (context.electronPlatformName === 'darwin') {
      applyMacHelperFolderUsageDescriptions(
        join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
        context.packager.appInfo.productFilename
      )
      const architecture = macSliceArch(context.arch, 'local-build compatibility')
      const schedulingAddon = buildMacShipItScheduling(resourcesDir, architecture)
      await signMacStandaloneHelper(schedulingAddon, 'ShipIt scheduling', context.packager)
      const version = context.packager.appInfo.version
      let commit = process.env.HIVEWARD_BUILD_COMMIT || process.env.GITHUB_SHA || 'unknown'
      if (commit === 'unknown') {
        try {
          commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
            encoding: 'utf8'
          }).trim()
        } catch {
          // Source archives can still produce a signed build with an explicit version.
        }
      }
      writeMacBuildCompatibility(resourcesDir, { version, commit, architecture })
    }
    for (const entry of [
      'desktop/engine.mjs',
      'desktop/preload.cjs',
      'server/hiwd.mjs',
      'web/index.html'
    ]) {
      if (!existsSync(join(resourcesDir, 'hiveward', entry))) {
        throw new Error(`Missing cockpit resource: ${entry}`)
      }
    }
    chmodSync(join(resourcesDir, 'hiveward/server/hiwd.mjs'), 0o755)
    stampPackagedCliVersion(resourcesDir, context.packager.appInfo.version)
    prunePackagedRuntimeNodeModules(resourcesDir, context.electronPlatformName, context.arch)
    assertNoWindowsExecutablesInRuntimeNodeModules(resourcesDir, context.electronPlatformName)
    // Gate native glibc floor after pruning foreign CPU variants; GLIBC_2.34 once broke Ubuntu 20.04 startup (#9902).
    let appImageNodeRuntime = null
    if (context.electronPlatformName === 'linux') {
      const targetArch = { 1: 'x64', 3: 'arm64' }[context.arch]
      // Before the floor gate, so the bundled Node is held to the same glibc floor.
      appImageNodeRuntime = await placeAppImageNodeRuntime(resourcesDir, targetArch)
      // Why the arch is passed: symbol-version checks pass happily on a wrong-architecture binary,
      // so a cross-built slice could ship the host's pty.node and only fail at runtime.
      finalizePackagedWaylandClipboard(resourcesDir)
      verifyLinuxGlibcFloor(context.appOutDir, { targetArch })
    }
    verifyPackagedMainRuntimeDeps(resourcesDir)
    // Smoke only host-runnable slices: daemon JS loads target-arch node-pty. Arch enum ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
    const archEnumByNodeArch = { ia32: 0, x64: 1, armv7l: 2, arm64: 3 }
    const hostArchEnum = archEnumByNodeArch[process.arch]
    const canExecuteTargetArch = context.arch === hostArchEnum || context.arch === 4
    if (context.electronPlatformName === 'win32') {
      verifyPackagedWindowsNodePty(resourcesDir, context.arch, { canExecuteTargetArch })
      verifyPackagedWindowsAgentHook(resourcesDir, context.arch)
    }
    verifySkillsCliRuntime(join(resourcesDir, 'app.asar.unpacked', 'out'), resourcesDir, {
      executeCommands: canExecuteTargetArch
    })
    if (!canExecuteTargetArch) {
      console.log(
        `[verify-skills-cli-runtime] skipped command probes on cross-arch slice (target ${context.arch}, host ${process.arch})`
      )
    }
    if (canExecuteTargetArch) {
      verifyPackagedDaemonEntryBoots(resourcesDir)
      if (appImageNodeRuntime) {
        await verifyAppImageNodeRuntimeServesPty(resourcesDir, appImageNodeRuntime)
      }
    } else {
      // Cross-arch smoke cannot run, but missing unpacked entry is always a packaging error.
      assertPackagedDaemonEntryExists(resourcesDir)
      console.log(
        `[verify-packaged-daemon-entry] skipped boot on cross-arch slice (target ${context.arch}, host ${process.arch})`
      )
    }
    // Validate real electron-builder output so broken extraResources mappings fail before shipping.
    verifyPackagedPluginResources(resourcesDir)
    assertPackagedWebClient(resourcesDir)
    assertPackagedServeSelectionEntry(resourcesDir)
    finalizePackagedRipgrep(resourcesDir)
    for (const filename of readdirSync(resourcesDir)) {
      if (!filename.startsWith('agent-browser-')) {
        continue
      }
      // Upstream executable bits vary (notably darwin-x64); restore them so packaged execFile works.
      chmodSync(join(resourcesDir, filename), 0o755)
      // The hivewardd template hashes this exact file next, so app signing must not rewrite it later.
      if (context.electronPlatformName === 'darwin') {
        await signMacStandaloneHelper(
          join(resourcesDir, filename),
          filename,
          context.packager,
          resolve(__dirname, '../resources/build/entitlements.mac.plist')
        )
      }
    }
    await finalizePackagedHivewarddTemplate(resourcesDir, {
      platform: context.electronPlatformName,
      signMacBinary: (path) =>
        signMacStandaloneHelper(path, 'hivewardd template binary', context.packager)
    })
    chmodUnixCliLaunchers(resourcesDir, context.electronPlatformName)
    if (context.electronPlatformName === 'darwin') {
      await signMacComputerUseHelper(
        join(resourcesDir, 'HiveWard Computer Use.app'),
        context.packager
      )
      await signMacStandaloneHelper(
        join(resourcesDir, '..', 'MacOS', 'hiveward-notification-status'),
        'hiveward-notification-status',
        context.packager
      )
      await signMacStandaloneHelper(
        join(resourcesDir, '..', 'MacOS', 'hiveward-keyboard-layout'),
        'hiveward-keyboard-layout',
        context.packager
      )
      await signMacStandaloneHelper(
        join(resourcesDir, '..', 'MacOS', 'hiveward-process-footprint'),
        'hiveward-process-footprint',
        context.packager
      )
      await packageMacTerminalHost(join(resourcesDir, '..', '..'), context)
    }
  },
  win: {
    executableName: 'HiveWard',
    icon: 'resources/build/hiveward.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] }
    ],
    artifactName: 'HiveWard-${version}-windows-${arch}.${ext}',

    verifyUpdateCodeSignature: false,
    extraResources: [
      ...commonExtraResources,
      ...windowsRuntimeResources,
      winSpeechNativeResource,
      // bin\ 进 PATH，只放对外的 hiwd（hiveward 是别名）；引擎启动器放 engine\，不进 PATH
      { from: 'resources/win32/bin/hiwd.cmd', to: 'bin/hiwd.cmd' },
      { from: 'resources/win32/bin/hiveward.cmd', to: 'bin/hiveward.cmd' },
      { from: 'resources/win32/engine/hiwd-engine.cmd', to: 'engine/hiwd-engine.cmd' },
      {
        from: 'native/windows-cli-launcher/.build/hiwd-engine.exe',
        to: 'engine/hiwd-engine.exe'
      },
      {
        from: 'native/windows-cli-launcher/.build/hiveward-administrator-restart.exe',
        to: 'bin/hiveward-administrator-restart.exe'
      },
      // installer copies this signed file into ~/.hiveward/agent-hooks (#20913).
      {
        from: 'native/windows-agent-hook/.build/hiveward-agent-hook.exe',
        to: 'bin/hiveward-agent-hook.exe'
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe',
        to: 'agent-browser-win32-x64.exe'
      },
      {
        from: 'native/computer-use-windows/runtime.ps1',
        to: 'computer-use-windows/runtime.ps1'
      }
    ]
  },
  nsis: {
    artifactName: 'HiveWard-${version}-windows-${arch}-setup.${ext}',
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    createDesktopShortcut: 'always',
    // One NSIS include hosts update-guarded daemon cleanup and additive markdown Open With registration.
    // Avoid fileAssociations: it would steal default .md ownership; see the include’s header.
    include: resolve(__dirname, 'nsis', 'hiveward-installer-hooks.nsh')
  },
  mac: {
    // Alternate rank preserves Finder’s default; one entry per extension because app-builder globs the value as a string.
    fileAssociations: [
      ...MARKDOWN_FILE_EXTENSIONS.map((ext) => ({
        ext,
        name: 'Markdown Document',
        description: 'Markdown Document',
        role: 'Editor',
        rank: 'Alternate'
      })),
      ...TABULAR_FILE_EXTENSIONS.map((ext) => ({
        ext,
        name: `${ext.toUpperCase()} Document`,
        description: `${ext.toUpperCase()} Document`,
        role: 'Editor',
        rank: 'Alternate'
      }))
    ],
    icon: 'resources/build/hiveward.icns',
    entitlements: 'resources/build/entitlements.mac.plist',
    entitlementsInherit: 'resources/build/entitlements.mac.plist',
    ...(isMacRelease ? { sign: resolve(__dirname, 'scripts/sign-mac-app.mjs') } : {}),
    signIgnore: [
      ...bundledRipgrepMacSignIgnore,
      ...hivewarddTemplateMacSignIgnore,
      // afterPack signs it before the hivewardd template hashes it.
      '/Contents/Resources/agent-browser-darwin-[^/]+$',
      ...macTerminalHostSignIgnore
    ],
    extendInfo: macUsageDescriptions,
    // Local macOS builds need no release credentials; hardening/notarization stay on explicit release paths.
    hardenedRuntime: isMacRelease,
    notarize: isMacRelease,
    extraResources: [
      ...commonExtraResources,
      ...createPackagedRuntimeNodeModuleResources('darwin'),
      macSpeechNativeResource,
      // bin/ 进 PATH，只放对外的 hiwd（hiveward 是别名）；引擎启动脚本放 engine/，不进 PATH
      { from: 'resources/darwin/bin/hiwd', to: 'bin/hiwd' },
      { from: 'resources/darwin/bin/hiveward', to: 'bin/hiveward' },
      { from: 'resources/darwin/engine/hiwd-engine', to: 'engine/hiwd-engine' },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-darwin-${arch}',
        to: 'agent-browser-darwin-${arch}'
      },
      {
        from: 'native/computer-use-macos/.build/release/HiveWard Computer Use.app',
        to: 'HiveWard Computer Use.app'
      }
    ],
    // macOS 26 UNUserNotificationCenter aborts helpers launched from Resources; execute from Contents/MacOS (#7929).
    extraFiles: [
      {
        from: 'native/notification-status-macos/.build/release/hiveward-notification-status',
        to: 'MacOS/hiveward-notification-status'
      },
      {
        from: 'native/keyboard-layout-macos/.build/release/hiveward-keyboard-layout',
        to: 'MacOS/hiveward-keyboard-layout'
      },
      {
        from: 'native/process-footprint-macos/.build/release/hiveward-process-footprint',
        to: 'MacOS/hiveward-process-footprint'
      }
    ],
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64']
      },
      {
        target: 'zip',
        arch: ['x64', 'arm64']
      }
    ]
  },
  // Why: release builds should fail if signing is unavailable instead of
  // silently downgrading to ad-hoc artifacts that look shippable in CI logs.
  forceCodeSigning: isMacRelease,
  dmg: {
    artifactName: 'HiveWard-${version}-mac-${arch}.${ext}'
  },
  linux: {
    // shared-mime-info already maps md/markdown: advertise handler only, leaving mimeapps.list defaults intact.
    // Omit mdx because Ubuntu 24.04 maps it to application/x-genesis-32x-rom; claiming it would need a glob override.
    mimeTypes: ['text/markdown', 'text/csv', 'text/tab-separated-values'],
    // Avoid GNOME HiveWard’s hiveward package and /usr/bin/hiveward names.
    executableName: 'hiveward',
    // Use icns to generate hicolor sizes; some Linux docks ignore a lone 1024px PNG.
    icon: 'resources/build/hiveward.icns',
    desktop: {
      entry: {
        // Why: Electron reports WM_CLASS=hiveward for the visible Linux window;
        // GNOME docks need an exact match to group it with hiveward-ide.desktop.
        StartupWMClass: 'hiveward'
      }
    },
    extraResources: [
      ...commonExtraResources,
      ...createPackagedRuntimeNodeModuleResources('linux'),
      linuxSpeechNativeResource,
      {
        from: 'native/wayland-clipboard/.build/${arch}/hiveward-wayland-clipboard',
        to: 'bin/hiveward-wayland-clipboard'
      },
      // bin/ 进 PATH，只放对外的 hiwd（hiveward 是别名）；引擎启动脚本放 engine/，不进 PATH
      { from: 'resources/linux/bin/hiwd', to: 'bin/hiwd' },
      { from: 'resources/linux/bin/hiveward', to: 'bin/hiveward' },
      { from: 'resources/linux/engine/hiwd-engine', to: 'engine/hiwd-engine' },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-linux-${arch}',
        to: 'agent-browser-linux-${arch}'
      },
      {
        from: 'native/computer-use-linux/runtime.py',
        to: 'computer-use-linux/runtime.py'
      }
    ],
    // Keep local artifacts aligned with the release pipeline.
    target: ['AppImage', 'deb', 'rpm'],
    maintainer: 'HiveWard',
    category: 'Utility'
  },
  appImage: {
    artifactName: isLinuxArm64Release ? 'hiveward-linux-arm64.${ext}' : 'hiveward-linux.${ext}'
  },
  deb: {
    packageName: 'hiveward',
    artifactName: 'hiveward-ide_${version}_${arch}.${ext}',
    // Headless Chromium still needs display service; hiveward serve starts packaged Xvfb when available (ensure-virtual-display.ts).
    depends: [
      ...debElectronRuntimeDependencies,
      'python3',
      'python3-gi',
      'gir1.2-atspi-2.0',
      'at-spi2-core',
      'xdotool',
      'xclip',
      'xvfb'
    ],
    // Install CLI onto PATH for headless hosts where GUI-triggered CliInstaller can never run.
    afterInstall: 'resources/linux/packaging/after-install.sh',
    afterRemove: 'resources/linux/packaging/after-remove.sh',
    // Why: only an AppImage's files can vanish under a running daemon (see appimage-node-runtime.cjs).
    fpm: appImageNodeRuntimeFpmArgs
  },
  rpm: {
    packageName: 'hiveward',
    artifactName: 'hiveward-ide-${version}.${arch}.${ext}',
    // Why: see deb depends. RPM distros ship Xvfb as xorg-x11-server-Xvfb (there
    // is no `xvfb` package), so the name differs from the deb here.
    depends: [
      ...rpmElectronRuntimeDependencies,
      'python3',
      'python3-gobject',
      'xdotool',
      'xclip',
      'xorg-x11-server-Xvfb'
    ],
    // Why: same headless CLI-on-PATH registration as deb; rpm runs these via fpm.
    afterInstall: 'resources/linux/packaging/after-install.sh',
    afterRemove: 'resources/linux/packaging/after-remove.sh',
    // Why: only an AppImage's files can vanish under a running daemon (see appimage-node-runtime.cjs).
    fpm: appImageNodeRuntimeFpmArgs
  },
  beforeBuild: electronBuilderNativeRebuild,
  // Dual-arch builds need target node-pty rebuilds or Intel Macs get arm64 binaries and posix_spawnp failure.
  // beforeBuild performs targeted rebuild then returns false to skip optional cpu-features.
  npmRebuild: true,
  publish: {
    provider: 'github',
    owner: 'Chaunyzhang',
    repo: 'HiveWard',
    // Keep main-repo releases draft until release-cut verifies all assets; early --publish always would expose missing Windows installers.
    releaseType: 'release'
  }
}

// Stamp the effective channel version where node-mode CLI code can read it.
function stampPackagedCliVersion(resourcesDir, version) {
  const packageJsonPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'package.json')
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Missing unpacked CLI package boundary: ${packageJsonPath}`)
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  writeFileSync(packageJsonPath, `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`)
}

function chmodUnixCliLaunchers(resourcesDir, electronPlatformName) {
  if (electronPlatformName === 'win32') {
    return
  }
  for (const launcherName of ['bin/hiwd', 'bin/hiveward', 'engine/hiwd-engine']) {
    const launcherPath = join(resourcesDir, launcherName)
    if (!existsSync(launcherPath)) {
      continue
    }
    // Public shell commands need executable extraResources modes despite source/packager drift.
    chmodSync(launcherPath, 0o755)
  }
}

async function signMacComputerUseHelper(helperAppPath, _packager) {
  if (!existsSync(helperAppPath)) {
    if (isMacRelease) {
      throw new Error(`Missing HiveWard Computer Use helper app at ${helperAppPath}`)
    }
    return
  }
  const identity =
    process.env.HIVEWARD_COMPUTER_MACOS_SIGN_IDENTITY ??
    hivewardEnvironment.HIVEWARD_SIGN_IDENTITY ??
    process.env.CSC_NAME ??
    (isMacRelease ? null : '-')
  if (!identity) {
    throw new Error('Missing signing identity for HiveWard Computer Use helper app')
  }
  // Why: TCC grants attach to this nested app's code identity. Sign it before
  // the outer HiveWard.app is sealed so production builds preserve that identity.
  execFileSync('codesign', codesignArgs(identity, helperAppPath), { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', helperAppPath], {
    stdio: 'inherit'
  })
}

// electron-builder `Arch` enum: x64=1, arm64=3. A universal (4) slice has no single arch.
function macSliceArch(archEnum, purpose) {
  const arch = { 1: 'x64', 3: 'arm64' }[archEnum]
  if (!arch) {
    throw new Error(`Unsupported ${purpose} architecture: ${archEnum}`)
  }
  return arch
}

// Why after the node_modules prune: the helper copies this slice's node-pty.
async function packageMacTerminalHost(appPath, context) {
  const arch = macSliceArch(context.arch, 'macOS terminal host')
  await buildMacTerminalHost({
    appPath,
    arch,
    iconPath: resolve(__dirname, '../resources/build/icon.icns'),
    entitlementsPath: resolve(__dirname, '../resources/build/entitlements.mac.plist'),
    usageDescriptions: macUsageDescriptions,
    signCode: (path, { entitlements }) =>
      signMacStandaloneHelper(path, 'terminal host', context.packager, entitlements)
  })
  // Only a local build may skip a slice this host cannot run; a shipped slice must serve a PTY.
  await verifyPackagedMacTerminalHostBoots(appPath, {
    arch,
    required: isMacRelease || process.env.CI === 'true'
  })
  await verifyMacTerminalHost({
    appPath,
    arch,
    usageDescriptions: macUsageDescriptions,
    expectedTeamId: isMacRelease ? HIVEWARD_MAC_TEAM_ID : null
  })
}

async function signMacStandaloneHelper(helperPath, helperName, _packager, entitlements) {
  if (!existsSync(helperPath)) {
    if (isMacRelease) {
      throw new Error(`Missing ${helperName} helper at ${helperPath}`)
    }
    return
  }
  const identity =
    hivewardEnvironment.HIVEWARD_SIGN_IDENTITY ??
    process.env.CSC_NAME ??
    (isMacRelease ? null : '-')
  if (!identity) {
    throw new Error(`Missing signing identity for ${helperName} helper`)
  }
  // Why: nested executables must be signed before the outer app bundle is sealed.
  const args = ['--force', '--sign', identity]
  if (isMacRelease) {
    args.push('--options', 'runtime', '--timestamp')
  }
  if (entitlements) {
    args.push('--entitlements', entitlements)
  }
  args.push(helperPath)
  execFileSync('codesign', args, { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', helperPath], { stdio: 'inherit' })
}

function codesignArgs(identity, targetPath) {
  const args = ['--force', '--deep', '--sign', identity]
  if (isMacRelease) {
    args.push(
      '--options',
      'runtime',
      '--timestamp',
      '--entitlements',
      resolve(__dirname, '../resources/build/entitlements.computer-use.mac.plist')
    )
  }
  args.push(targetPath)
  return args
}

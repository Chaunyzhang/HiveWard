// Run pnpm bench:multi-workspace-typing -- --panes 8 --rate-kbps 512 --keys 48 --label before-fix (see terminal-multi-workspace-typing-latency.spec.ts).
// Save distinct labels per build/config in tests/tools/benchmarks/results/multi-workspace-typing-*.json; compare totalMs/inputHalfMs/echoHalfMs percentiles.
import { spawn } from 'node:child_process'

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const knobByFlag = {
  '--visited-workspaces': 'HIVEWARD_TYPING_BENCH_VISITED_WORKSPACES',
  '--load-workspaces': 'HIVEWARD_TYPING_BENCH_LOAD_WORKSPACES',
  '--panes': 'HIVEWARD_TYPING_BENCH_LOAD_PANES',
  '--rate-kbps': 'HIVEWARD_TYPING_BENCH_RATE_KBPS',
  '--keys': 'HIVEWARD_TYPING_BENCH_KEYS',
  '--cadence-ms': 'HIVEWARD_TYPING_BENCH_KEY_CADENCE_MS',
  '--cpu-workers': 'HIVEWARD_TYPING_BENCH_CPU_WORKERS',
  '--git-churn-repos': 'HIVEWARD_TYPING_BENCH_GIT_CHURN_REPOS',
  '--git-churn-files': 'HIVEWARD_TYPING_BENCH_GIT_CHURN_FILES',
  '--git-churn-concurrency': 'HIVEWARD_TYPING_BENCH_GIT_CHURN_CONCURRENCY',
  '--codex-frame-rows': 'HIVEWARD_TYPING_BENCH_CODEX_FRAME_ROWS',
  '--codex-split-delay-ms': 'HIVEWARD_TYPING_BENCH_CODEX_SPLIT_DELAY_MS',
  '--worktrees': 'HIVEWARD_TYPING_BENCH_METADATA_WORKTREES',
  '--repositories': 'HIVEWARD_TYPING_BENCH_METADATA_REPOSITORIES',
  '--terminal-tabs': 'HIVEWARD_TYPING_BENCH_METADATA_TERMINAL_TABS',
  '--unified-tabs': 'HIVEWARD_TYPING_BENCH_METADATA_UNIFIED_TABS',
  '--sleepers': 'HIVEWARD_TYPING_BENCH_METADATA_SLEEPERS',
  '--live-statuses': 'HIVEWARD_TYPING_BENCH_METADATA_LIVE_STATUSES',
  '--panes-per-tab': 'HIVEWARD_TYPING_BENCH_METADATA_PANES',
  '--status-history': 'HIVEWARD_TYPING_BENCH_METADATA_STATUS_HISTORY',
  '--status-interval-ms': 'HIVEWARD_TYPING_BENCH_METADATA_STATUS_INTERVAL_MS',
  '--agent-rows': 'HIVEWARD_TYPING_BENCH_AGENT_ROWS',
  '--title-change-ms': 'HIVEWARD_TYPING_BENCH_TITLE_CHANGE_MS',
  '--lifecycle-ms': 'HIVEWARD_TYPING_BENCH_LIFECYCLE_MS',
  '--cpu-profile': 'HIVEWARD_TYPING_BENCH_CPU_PROFILE',
  '--pty-metadata': 'HIVEWARD_TYPING_BENCH_PTY_METADATA',
  '--metadata-status': 'HIVEWARD_TYPING_BENCH_METADATA_STATUS',
  '--metadata-titles': 'HIVEWARD_TYPING_BENCH_METADATA_TITLES',
  '--instrumentation': 'HIVEWARD_TYPING_BENCH_INSTRUMENTATION',
  '--graph-probe': 'HIVEWARD_TYPING_BENCH_GRAPH_PROBE',
  '--cpu-throttle': 'HIVEWARD_TYPING_BENCH_CPU_THROTTLE',
  '--order-churn-ms': 'HIVEWARD_TYPING_BENCH_ORDER_CHURN_MS',
  '--in-app-diagnostic': 'HIVEWARD_TYPING_BENCH_IN_APP_DIAGNOSTIC',
  '--label': 'HIVEWARD_TYPING_BENCH_LABEL'
}

const env = { ...process.env, HIVEWARD_BACKGROUND_LAUNCH: '1', HIVEWARD_TYPING_BENCH: '1' }
const passthroughArgs = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--') {
    continue
  }
  const knob = knobByFlag[argv[i]]
  if (knob) {
    env[knob] = argv[++i]
  } else {
    passthroughArgs.push(argv[i])
  }
}

const child = spawn(
  npxCommand,
  [
    'playwright',
    'test',
    'tests/e2e/terminal-multi-workspace-typing-latency.spec.ts',
    'tests/e2e/terminal-workspace-update-typing-latency.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1',
    ...passthroughArgs
  ],
  { stdio: 'inherit', env }
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

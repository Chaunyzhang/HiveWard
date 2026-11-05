// hiwd 先认自己的命令，认不出来的原样转给引擎命令行（src/cli，打包后在 app.asar.unpacked/out/cli）。
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { join, resolve } from 'node:path'

// 改这里要同步 hiwd.mjs 的 switch；hiwd-engine-forward.test.mjs 保证和引擎顶层命令不撞名
export const HIWD_COMMANDS = [
  'agents',
  'assign',
  'close',
  'decide',
  'decisions',
  'files',
  'inbox',
  'machines',
  'mcp',
  'new',
  'overview',
  'projects',
  'read',
  'review',
  'seat',
  'stop',
  'task',
  'tasks',
  'tell',
  'web'
]

// 和引擎同名、但由 hiwd 接管的子命令：file open 打开在工作台右栏（引擎那个打开到的界面已经删了）
export const HIWD_SUBCOMMANDS = { file: ['open'] }

// 引擎里 --on 是自己的参数（orchestration worker-start --on <环境>），不是 hiwd 的跨电脑调用
const ENGINE_ON_COMMANDS = new Set(['orchestration'])

export const isHelpCommand = (cmd) => cmd === undefined || ['help', '--help', '-h'].includes(cmd)

/** 跳过 --on <电脑> 找出命令名；认不出来就交给引擎 */
export function routeHiwdArgv(argv) {
  let on = false
  const words = []
  for (let i = 0; i < argv.length && argv[i] !== '--'; i++) {
    if (argv[i] === '--on') {
      on = true
      i++
    } else if (!argv[i].startsWith('-')) {
      words.push(argv[i])
    } else if (!words.length) {
      words.push(argv[i])
    }
  }
  const [cmd, sub] = words
  if (isHelpCommand(cmd)) {
    return { kind: 'help' }
  }
  if (HIWD_COMMANDS.includes(cmd) || HIWD_SUBCOMMANDS[cmd]?.includes(sub)) {
    return { kind: 'hiwd' }
  }
  if (on && !ENGINE_ON_COMMANDS.has(cmd)) {
    return { kind: 'error', message: `${cmd} 不支持 --on（这是引擎命令，只能在本机执行）` }
  }
  return { kind: 'engine' }
}

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function packagedElectron(resourcesDir, platform) {
  const appDir = resolve(resourcesDir, '..')
  const candidates =
    platform === 'darwin'
      ? [join(appDir, 'MacOS', 'HiveWard')]
      : platform === 'win32'
        ? [join(appDir, 'HiveWard.exe')]
        : [join(appDir, 'hiveward'), join(appDir, 'HiveWard')]
  return candidates.find((path) =>
    platform === 'win32' ? existsSync(path) : isExecutableFile(path)
  )
}

/**
 * 找引擎：装好的 App（hiveward/server 往上两层是 Resources）用 App 自带的 Electron 跑；
 * 开发环境（仓库里 hiveward/server 往上两层是仓库根）用当前 node 跑 out/cli/index.js。
 */
export function resolveEngineLaunch({
  serverDir,
  platform = process.platform,
  execPath = process.execPath
}) {
  const root = resolve(serverDir, '..', '..')
  const packagedCli = join(root, 'app.asar.unpacked', 'out', 'cli', 'index.js')
  if (existsSync(packagedCli)) {
    const electron = packagedElectron(root, platform)
    return electron ? { command: electron, cli: packagedCli } : null
  }
  const devCli = join(root, 'out', 'cli', 'index.js')
  return existsSync(devCli) ? { command: execPath, cli: devCli } : null
}

export function engineEnv(env) {
  const next = { ...env, ELECTRON_RUN_AS_NODE: '1' }
  // 和 hiwd-engine 启动脚本一样：用户的 NODE_OPTIONS 交给引擎自己转给子进程，不作用于 Electron
  for (const [key, saved] of [
    ['NODE_OPTIONS', 'HIVEWARD_NODE_OPTIONS'],
    ['NODE_REPL_EXTERNAL_MODULE', 'HIVEWARD_NODE_REPL_EXTERNAL_MODULE']
  ]) {
    if (key in next) {
      next[saved] = next[key]
      delete next[key]
    } else {
      next[saved] ??= ''
    }
  }
  return next
}

/** stdin / stdout / stderr 直通，返回引擎的退出码 */
export function runEngine(launch, argv, env = process.env) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(launch.command, [launch.cli, ...argv], {
      stdio: 'inherit',
      env: engineEnv(env)
    })
    // Ctrl-C 本来就同时送到引擎（同一进程组），这边不再转；单独发给 hiwd 的 SIGTERM 转给引擎。等它退出后带着它的退出码走
    const ignore = () => {}
    const relay = (signal) => child.kill(signal)
    process.on('SIGINT', ignore)
    process.on('SIGTERM', relay)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      process.off('SIGINT', ignore)
      process.off('SIGTERM', relay)
      resolveExit(code ?? 128 + (osConstants.signals[signal] ?? 0))
    })
  })
}

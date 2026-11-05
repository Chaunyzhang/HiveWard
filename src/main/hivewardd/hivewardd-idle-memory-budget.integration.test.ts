// Regression guard for the WSL host memory gate: a built hivewardd, launched the way a WSL host launch does,
// must keep its whole process tree under a resident budget once idle with two terminals open.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { runProcess, spawnProcess } from '@hiveward/process-host'
import {
  HIVEWARDD_CLI_ENTRY_FILENAME,
  HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME
} from '../../shared/hivewardd-artifacts'
import { HIVEWARDD_WSL_HOST_ENV } from '../ipc/wsl-guest-windows-drive-path'
import { HIVEWARDD_RUNTIME_V8_FLAGS } from '../managed-server/install/hivewardd-remote-launch'
import { hostMallocTunablesLaunchEnv } from '../memory/host-malloc-tunables'
import { resolveBundledHivewarddRuntime } from './hivewardd-bundled-runtime'
import { skipForMissingInputs } from './hivewardd-node-slot-fixture'
import {
  killProfileDaemons,
  recordProfileDaemons,
  removeTestRoot
} from './hivewardd-daemon-teardown-fixture'

// About 255 MB today (linux-arm64, cold compile); the headroom absorbs runner noise, not a new resident cost.
const HIVEWARDD_TREE_RSS_BUDGET_MB = 400
const IDLE_MS = 90_000

const slotDir = resolve('out/hivewardd')
const cliEntry = join(slotDir, ...HIVEWARDD_CLI_ENTRY_FILENAME.split('/'))
const runtime = existsSync(join(slotDir, HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME))
  ? resolveBundledHivewarddRuntime(slotDir)
  : null
// smaps_rollup is Linux-only, and Linux is the host OS a WSL distro runs.
const skip =
  process.platform !== 'linux' ||
  skipForMissingInputs(
    'artifact',
    runtime && existsSync(cliEntry) ? [] : ['a Node hivewardd slot in out/hivewardd']
  )

const roots: string[] = []
const servers: ReturnType<typeof spawnProcess>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.exitCode === null) {
      const exited = new Promise((settle) => server.once('exit', settle))
      server.kill('SIGTERM')
      await exited
    }
  }
  for (const root of roots.splice(0)) {
    await killProfileDaemons(join(root, 'user-data'))
    await removeTestRoot(root)
  }
})

/** Every process below `rootPid`, including it, read from /proc. */
function processTree(rootPid: number): number[] {
  const parents = new Map<number, number>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]))
    } catch {
      // Exited while listing.
    }
  }
  const tree = new Set([rootPid])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, parent] of parents) {
      if (tree.has(parent) && !tree.has(pid)) {
        tree.add(pid)
        grew = true
      }
    }
  }
  return [...tree]
}

function residentMb(pid: number): number {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    return Number(/^Rss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0) / 1024
  } catch {
    return 0
  }
}

function commandOf(pid: number): string {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    // Name Node processes by their entry script; the runtime path alone says nothing.
    const entry = argv.find((arg) => arg.endsWith('.js'))
    return entry ? entry.split('/').pop()! : argv.join(' ').slice(0, 80)
  } catch {
    return '(exited)'
  }
}

async function cli<T>(
  env: NodeJS.ProcessEnv,
  pairingCode: string,
  args: string[],
  schema: z.ZodType<T>
): Promise<T> {
  const result = await runProcess({
    program: runtime!,
    args: [cliEntry, ...args, '--pairing-code', pairingCode, '--json'],
    env,
    timeoutMs: 60_000
  })
  expect(result.code, result.stderr).toBe(0)
  return schema.parse(JSON.parse(result.stdout.trim()))
}

const RepoAdded = z.object({ result: z.object({ repo: z.object({ id: z.string() }) }) })
const WorktreeCreated = z.object({ result: z.object({ worktree: z.object({ id: z.string() }) }) })
const Anything = z.unknown()
const Readiness = z.object({ pairing: z.object({ url: z.string() }) })

async function startHivewardd(env: NodeJS.ProcessEnv): Promise<{ pid: number; pairingCode: string }> {
  const server = spawnProcess({
    program: runtime!,
    args: [
      ...HIVEWARDD_RUNTIME_V8_FLAGS.split(' '),
      join(slotDir, 'hivewardd.js'),
      '--json',
      '--bind',
      '127.0.0.1',
      '--port',
      '0'
    ],
    env,
    timeoutMs: null
  })
  servers.push(server)
  let stdout = ''
  let stderr = ''
  server.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const ready = await new Promise<string>((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error(`no readiness: ${stderr}`)), 120_000)
    server.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const newline = stdout.indexOf('\n')
      if (newline !== -1) {
        clearTimeout(timer)
        resolveLine(stdout.slice(0, newline))
      }
    })
  })
  const pairingCode = new URL(Readiness.parse(JSON.parse(ready)).pairing.url).searchParams.get(
    'code'
  )
  if (!pairingCode || server.pid === undefined) {
    throw new Error(`hivewardd readiness carried no pairing offer: ${ready}`)
  }
  return { pid: server.pid, pairingCode }
}

it.skipIf(skip)(
  'keeps an idle WSL-host hivewardd tree with two terminals under its resident budget',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hivewardd-idle-memory-'))
    roots.push(root)
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('VITEST') && key !== 'NODE_ENV'
        )
      ),
      HOME: root,
      HIVEWARD_BACKGROUND_LAUNCH: '1',
      HIVEWARD_USER_DATA: join(root, 'user-data'),
      // The WSL host launch: its malloc tunables, and the marker that turns on the idle writer stop.
      ...Object.fromEntries(hostMallocTunablesLaunchEnv().map(([name, value]) => [name, value])),
      [HIVEWARDD_WSL_HOST_ENV]: '1',
      WSL_DISTRO_NAME: 'hiveward-memory-lane'
    }
    const { pid, pairingCode } = await startHivewardd(env)

    const repo = join(root, 'repo')
    for (const args of [
      ['init', '-q', '-b', 'main', repo],
      [
        '-C',
        repo,
        '-c',
        'user.email=lane@hiveward.test',
        '-c',
        'user.name=lane',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'seed'
      ]
    ]) {
      const git = await runProcess({ program: 'git', args, timeoutMs: 30_000 })
      expect(git.code, git.stderr).toBe(0)
    }
    const added = await cli(env, pairingCode, ['repo', 'add', '--path', repo], RepoAdded)
    const created = await cli(
      env,
      pairingCode,
      [
        'worktree',
        'create',
        '--repo',
        `id:${added.result.repo.id}`,
        '--name',
        'lane',
        '--setup',
        'skip'
      ],
      WorktreeCreated
    )
    for (let terminal = 0; terminal < 2; terminal += 1) {
      await cli(
        env,
        pairingCode,
        ['terminal', 'create', '--worktree', `id:${created.result.worktree.id}`],
        Anything
      )
    }

    // ast-grep-ignore: test-no-real-time-wait -- idle memory is the thing under test; only real idle time shows it
    await new Promise((settle) => setTimeout(settle, IDLE_MS))

    await recordProfileDaemons(env.HIVEWARD_USER_DATA!)
    const tree = processTree(pid).map((member) => ({
      pid: member,
      mb: residentMb(member),
      command: commandOf(member)
    }))
    const totalMb = tree.reduce((sum, member) => sum + member.mb, 0)
    const breakdown = tree
      .sort((left, right) => right.mb - left.mb)
      .map((member) => `${member.mb.toFixed(1)} MB  ${member.command}`)
      .join('\n')
    expect(totalMb, `hivewardd tree RSS ${totalMb.toFixed(1)} MB:\n${breakdown}`).toBeLessThan(
      HIVEWARDD_TREE_RSS_BUDGET_MB
    )
  },
  // Boot, a repo and two terminals, then a 90 s idle: well past the default per-test timeout.
  240_000
)

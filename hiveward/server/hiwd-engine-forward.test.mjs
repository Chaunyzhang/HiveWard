import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HIWD_COMMANDS, routeHiwdArgv } from './hiwd-engine-forward.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))

async function engineRootCommands() {
  const roots = new Set()
  const specs = join(repo, 'src/cli/specs')
  for (const file of await readdir(specs)) {
    if (file.endsWith('.ts') && !file.endsWith('.test.ts')) {
      for (const match of (await readFile(join(specs, file), 'utf8')).matchAll(
        /path:\s*\[\s*'([^']+)'/g
      )) {
        roots.add(match[1])
      }
    }
  }
  // cli-command-parity 测试保证这份表和 specs 的顶层命令一致；两处都查，任何一边新增都会撞上
  const names = await readFile(join(repo, 'src/main/startup/cli-command-names.ts'), 'utf8')
  for (const match of names.matchAll(/^\s*'([^']+)',?$/gm)) {
    roots.add(match[1])
  }
  return roots
}

test('hiwd 自己的命令和引擎顶层命令不重名', async () => {
  const roots = await engineRootCommands()
  assert.ok(roots.has('terminal') && roots.has('status'), '没读到引擎命令表')
  assert.deepEqual(
    [...HIWD_COMMANDS, 'help'].filter((name) => roots.has(name)),
    []
  )
})

test('认得的走 hiwd，不认得的转引擎，引擎命令带 --on 直接报错', () => {
  assert.equal(routeHiwdArgv(['overview']).kind, 'hiwd')
  assert.equal(routeHiwdArgv(['--on', 'Windows', 'files', 'roots']).kind, 'hiwd')
  for (const argv of [['status'], ['project', 'list'], ['wait'], ['browser', 'tabs']]) {
    assert.equal(routeHiwdArgv(argv).kind, 'engine', argv.join(' '))
  }
  for (const argv of [[], ['help'], ['--help'], ['-h']]) {
    assert.equal(routeHiwdArgv(argv).kind, 'help', argv.join(' '))
  }
  assert.match(routeHiwdArgv(['terminal', 'list', '--on', 'Windows']).message, /不支持 --on/)
  assert.equal(
    routeHiwdArgv(['orchestration', 'worker-start', '--on', 'sandbox']).kind,
    'engine',
    'orchestration 的 --on 是引擎自己的参数'
  )
  assert.equal(routeHiwdArgv(['tell', 'a', '--', '--on', 'x']).kind, 'hiwd')
  assert.equal(routeHiwdArgv(['file', 'open', 'a.md']).kind, 'hiwd', 'file open 打开在工作台')
  assert.equal(routeHiwdArgv(['file', 'diff', 'a.md']).kind, 'engine')
})

test('转给引擎：参数和 stdin 原样传过去，退出码原样返回', async () => {
  const dir = await mkdtemp('/tmp/hiwd-engine-forward-')
  const cli = join(dir, 'index.js')
  const out = join(dir, 'seen.json')
  await writeFile(
    cli,
    `let input = ''
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({
    argv: process.argv.slice(2), input, runAsNode: process.env.ELECTRON_RUN_AS_NODE,
    nodeOptions: process.env.NODE_OPTIONS ?? null, saved: process.env.HIVEWARD_NODE_OPTIONS
  }))
  process.exit(7)
})`
  )
  // 在子进程里跑 runEngine，才能给它喂 stdin
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { runEngine } from ${JSON.stringify(new URL('./hiwd-engine-forward.mjs', import.meta.url).href)}
process.exit(await runEngine({ command: process.execPath, cli: ${JSON.stringify(cli)} }, process.argv.slice(1)))`,
      'terminal',
      'send',
      '多行\n正文'
    ],
    {
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
      stdio: ['pipe', 'inherit', 'inherit']
    }
  )
  child.stdin.end('从 stdin 来')
  const [code] = await new Promise((done) => child.once('exit', (...args) => done(args)))
  assert.equal(code, 7)
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), {
    argv: ['terminal', 'send', '多行\n正文'],
    input: '从 stdin 来',
    runAsNode: '1',
    nodeOptions: null,
    saved: '--no-warnings'
  })
})

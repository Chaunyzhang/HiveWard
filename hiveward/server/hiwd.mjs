#!/usr/bin/env node
import { hivewardEnvironment } from '../shared/environment.mjs'
// hiwd（全名 hiveward）：HiveWard 的命令行，给 Grok Bot、Leader Agent 和桌面端会话用。走本机桥接服务（hiveward-bridge.mjs），
// 输出都是纯文本，方便 Bot 读。
//
//   hiwd agents                               列出所有终端和里面跑的 Agent
//   hiwd projects [--business 业务]           列出业务及其项目、Leader
//   hiwd seat ceo|leader … / seat leave       当前 Agent 会话 / 终端坐座位或离座
//   hiwd inbox [--timeout 分钟]               等自己的收件箱有消息，收到或超时后退出
//   hiwd projects schedule <项目> --every 30 --say "话" / --off  设置、停止或查看定时巡检
//   hiwd read <agent> [-n 20]                 看它最近的对话（找不到对话记录就看终端画面）
//   hiwd tell <agent> <话…>                   对它说话（派活、追问、纠偏）
//   hiwd new <目录> <claude|codex|kimi|opencode> [--model 模型] [话…]  新开一个 Agent（完全访问模式），可带第一句话
//   hiwd stop <agent>                         中断它手上的事
//   hiwd close <agent>                        验收通过后关掉它的终端（任务记录保留，架构图上不再显示）
//   hiwd overview                             全局一屏：每块业务一行（Leader Agent、任务、待决定）
//   hiwd tasks [业务] [--open] [-n 20]        任务列表，新的在前；--open 只看没完成的
//   hiwd task <id>                            一个任务的全部：派单、补充、汇报
//   hiwd review <id> --accept | --rework <意见> 复核派单；Agent 只能复核自己派的
//   hiwd decisions                            要老板决定的事（列选项、标推荐）
//   hiwd decide <id> <答复…>                  替老板答复一个决定
//   hiwd assign <业务>/<项目> <话…>           把活派给这块业务的 Leader Agent（老板卡同款）
//
//   hiwd web …                                操作 HiveWard 内置浏览器
//   hiwd file open <路径> [--focus]           在 HiveWard 工作台右栏打开文件给老板看
//
// <agent> 可以是终端 handle，也可以是标题 / 项目名里的一段字。
// 不认识的命令（status、terminal、worktree…）原样转给引擎命令行，见 hiwd-engine-forward.mjs。

import { runFiles } from './files-cli.mjs'
import { resolveEngineLaunch, routeHiwdArgv, runEngine } from './hiwd-engine-forward.mjs'
import { runMcp } from './mcp-cli.mjs'
import { ERROR_STOP_LABELS, quotaLabel } from './model-error-stop.mjs'
import { within } from './business-projects.mjs'
import { FULL_ACCESS } from './business-terminals.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 本机端口从 8787 换成了 47615；换端口前开的终端环境里还是旧地址，照新地址连
const BASE =
  !hivewardEnvironment.HIVEWARD_BRIDGE ||
  hivewardEnvironment.HIVEWARD_BRIDGE === 'http://127.0.0.1:8787'
    ? 'http://127.0.0.1:47615'
    : hivewardEnvironment.HIVEWARD_BRIDGE
const enc = encodeURIComponent
let machinePrefix = ''
const endpoint = (path) => BASE + (machinePrefix ? machinePrefix + path.slice(4) : path)

async function api(path, body, headers = {}, method) {
  let res
  try {
    res = await fetch(endpoint(path), {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined
    })
  } catch {
    fail(`连不上 HiveWard ${BASE}（先打开 HiveWard App）`)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    fail(
      `${data?.error?.code === 'exit_region_blocked' ? '[exit_region_blocked] ' : ''}${data?.error?.message ?? `HTTP ${res.status}`}`
    )
  }
  return data
}

function fail(msg) {
  console.error(`hiwd: ${msg}`)
  process.exit(1)
}

const short = (p) => p.split(/[/\\]/).pop()

// 谁在派单：桌面端 Claude 会话 / 终端里的 Claude Code / Grok（设 HIVEWARD_DISPATCHER=grok）/ 其它命令行
function dispatcher() {
  const env = hivewardEnvironment
  // 每块业务一个 Grok Bot：HIVEWARD_DISPATCHER=grok:<业务id>（只写 grok 时按派活的目录归业务）
  if (env.HIVEWARD_DISPATCHER) {
    const grok = /^grok(:|$)/.test(env.HIVEWARD_DISPATCHER)
    return {
      kind: grok ? 'grok' : 'cli',
      id: env.HIVEWARD_DISPATCHER,
      label: grok ? 'Grok Bot' : env.HIVEWARD_DISPATCHER,
      cwd: process.cwd()
    }
  }
  if (env.HIVEWARD_TERMINAL_HANDLE) {
    return { kind: 'cli', id: env.HIVEWARD_TERMINAL_HANDLE, label: 'Agent', cwd: process.cwd() }
  }
  // Grok Bot（xAI 的桌面 App）在本机跑的命令：认进程链，不用另外设环境变量；业务按派活的目录归
  if (fromGrokBot()) {
    return { kind: 'grok', id: 'grok', label: 'Grok Bot', cwd: process.cwd() }
  }
  if (env.CLAUDE_CODE_SESSION_ID) {
    const desktop = env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
    return {
      kind: desktop ? 'claude-desktop' : 'claude-code',
      id: env.CLAUDE_CODE_SESSION_ID,
      label: desktop ? 'Claude 桌面端' : 'Claude Code',
      cwd: process.cwd()
    }
  }
  if (env.CODEX_THREAD_ID) {
    return { kind: 'cli', id: env.CODEX_THREAD_ID, label: 'Codex', cwd: process.cwd() }
  }
  return { kind: 'cli', id: `hiveward-cli:${process.ppid}`, label: '命令行', cwd: process.cwd() }
}

function callerHeaders(id) {
  const caller = id ? { id } : dispatcher()
  return {
    'x-hiveward-caller': 'agent',
    'x-hiveward-dispatcher-id': encodeURIComponent(caller.id),
    'x-hiveward-dispatcher-kind': caller.kind ?? dispatcher().kind,
    'x-hiveward-dispatcher-label': encodeURIComponent(caller.label ?? dispatcher().label),
    'x-hiveward-dispatcher-cwd': encodeURIComponent(caller.cwd ?? process.cwd())
  }
}

function seatSession() {
  if (process.env.HIVEWARD_TERMINAL_HANDLE) {
    return null
  }
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    return {
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
      agent: process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop' ? 'claude-desktop' : 'claude',
      cwd: process.cwd()
    }
  }
  if (process.env.CODEX_THREAD_ID) {
    return { sessionId: process.env.CODEX_THREAD_ID, agent: 'codex', cwd: process.cwd() }
  }
  return null
}

function takeOption(args, name) {
  const i = args.indexOf(name)
  if (i === -1) {
    return undefined
  }
  const value = args[i + 1]
  if (!value || value.startsWith('--')) {
    fail(`${name} 缺少值`)
  }
  args.splice(i, 2)
  return value
}

// 往上找父进程，有一层是 Grok Bot.app 里的进程就算 Grok Bot 派的
function fromGrokBot() {
  if (process.platform !== 'darwin') {
    return false
  }
  let pid = process.ppid
  for (let i = 0; i < 12 && pid > 1; i++) {
    let line
    try {
      line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8'
      }).trim()
    } catch {
      return false
    }
    if (line.includes('/Grok Bot.app/')) {
      return true
    }
    pid = Number(line.split(/\s+/, 1)[0])
  }
  return false
}

async function terminals() {
  return (await api('/api/hiveward/terminals')).terminals
}

async function find(query, optional = false) {
  if (!query) {
    fail('要指定是哪个 Agent')
  }
  const list = await terminals()
  const exact = list.find((t) => t.handle === query)
  if (exact) {
    return exact
  }
  // handle 只写前半截（比如 term_7ceed433）也认，前提是只对上一个
  const byPrefix = list.filter((t) => t.handle.startsWith(query))
  if (query.startsWith('term_') && byPrefix.length === 1) {
    return byPrefix[0]
  }
  const q = query.toLowerCase()
  const hits = list.filter((t) =>
    [t.title, t.project, t.agent].some((s) => s?.toLowerCase().includes(q))
  )
  // 同名多个时优先真的在跑 Agent 的
  const agents = hits.filter((t) => t.agent)
  const pick = agents.length ? agents : hits
  if (pick.length === 1) {
    return pick[0]
  }
  if (!pick.length) {
    if (optional) {
      return null
    }
    fail(`没找到「${query}」，用 hiwd agents 看看有哪些`)
  }
  fail(
    `「${query}」对上了 ${pick.length} 个，换个更准的说法或直接用 handle：\n${pick
      .map((t) => `  ${t.handle}  ${t.title}`)
      .join('\n')}`
  )
}

/** 哪家额度用完、几个下属停着；不在桌面 App 里、后台旧版本没有这个接口时为空 */
async function quota() {
  // 不走 api()：它失败会直接退出进程，而额度只是附加信息
  const res = await fetch(endpoint('/api/quota')).catch(() => null)
  const data = res?.ok ? await res.json().catch(() => null) : null
  return data?.providers ?? []
}

/** 因额度停下的下属终端 → 「额度用完 · 约 03:25 恢复」 */
function quotaByHandle(alerts) {
  return new Map(alerts.flatMap((a) => a.handles.map((h) => [h, quotaLabel(a.resetsAt)])))
}

function line(t) {
  const who = t.agent ?? 'shell'
  return `${t.handle}  [${who}]  ${t.title || '终端'}  · ${short(t.project)}${
    t.preview ? `\n    ${t.preview}` : ''
  }`
}

async function topoRows() {
  return (await api('/api/topology')).nodes
}

// 业务行一行摘要（报错时列出可选）
function bizLine(n) {
  return `  ${n.businessId ?? short(n.project ?? '?')}  ${n.label}${n.project ? `  (${n.project})` : ''}`
}

// 按业务名 / 业务 id / 项目目录名 找拓扑图里的项目行（不区分大小写，唯一前缀即可）
async function matchBusiness(query) {
  const rows = (await topoRows()).filter((n) => ['business', 'project'].includes(n.kind))
  if (!query) {
    fail('要指定是哪块业务')
  }
  const q = query.toLowerCase()
  const nameOf = (n) => [n.label, n.businessId, short(n.project ?? '')]
  let picks = rows.filter((n) => nameOf(n).some((s) => s?.toLowerCase() === q))
  if (!picks.length) {
    picks = rows.filter((n) => nameOf(n).some((s) => s?.toLowerCase().startsWith(q)))
  }
  if (picks.length === 1) {
    return picks[0]
  }
  fail(
    picks.length
      ? `「${query}」对上了 ${picks.length} 行，换个更准的说法：\n${picks.map(bizLine).join('\n')}`
      : `没找到业务「${query}」，可选：\n${rows.map(bizLine).join('\n')}`
  )
}

async function matchProject(query) {
  const split = query.indexOf('/')
  const business = await matchBusiness(split === -1 ? query : query.slice(0, split))
  const { projects } = await api(`/api/businesses/${enc(business.businessId)}/projects`)
  const active = projects.filter((p) => p.status === 'active')
  const name = split === -1 ? undefined : query.slice(split + 1)
  const project = name
    ? active.find((p) => p.name === name || p.id === name)
    : active.length === 1
      ? active[0]
      : null
  if (!project) {
    fail(
      `请指定项目，可选：${active.map((p) => `${business.label}/${p.name}`).join('、') || '（没有项目，先 hiwd projects add）'}`
    )
  }
  return { business, project }
}

async function seatBusiness(query) {
  if (query) {
    return matchBusiness(query)
  }
  const { businesses } = await api('/api/overview')
  const hits = businesses
    .filter((b) => within(process.cwd(), b.workspacePath))
    .sort((a, b) => b.workspacePath.length - a.workspacePath.length)
  if (hits.length !== 1) {
    fail(
      hits.length
        ? `当前目录对上了 ${hits.length} 块业务，请用 --business 指定`
        : '认不出当前目录属于哪块业务，请用 --business <业务名或 id> 指定'
    )
  }
  const b = hits[0]
  return { businessId: b.id, label: b.name, project: b.workspacePath }
}

async function seatProject(business, query, includeArchived = false) {
  if (!query) {
    fail('要用 --project <项目名或 id> 指定项目')
  }
  const { projects } = await api(`/api/businesses/${enc(business.businessId)}/projects`)
  const rows = includeArchived ? projects : projects.filter((p) => p.status === 'active')
  const hits = rows.filter((p) => p.id === query || p.name === query)
  if (hits.length !== 1) {
    fail(`没找到项目「${query}」，可选：${rows.map((p) => `${p.name} (${p.id})`).join('、')}`)
  }
  return hits[0]
}

const occupiedBy = (seat, id) =>
  (seat?.occupant?.kind === 'session'
    ? seat.occupant.sessionId
    : (seat?.occupant?.terminal ?? seat?.terminal)) === id

// 汇报的第一句
const firstSentence = (s) =>
  (s.split(/\n|(?<=[。！？!?])/).find((x) => x.trim()) ?? '').trim().slice(0, 100)

function chatText(items) {
  return items
    .map((it) => {
      if (it.kind === 'user') {
        return `【你】${it.text}`
      }
      if (it.kind === 'assistant') {
        return `【Agent】${it.text}`
      }
      if (it.kind === 'thinking') {
        return null
      }
      const mark = it.status === 'running' ? '…进行中' : it.status === 'error' ? '✗出错' : ''
      return `  · ${it.title} ${mark}`.trimEnd()
    })
    .filter(Boolean)
    .join('\n')
}

// Browser arguments use -- to keep option-looking text literal.
async function browser(argv) {
  const positional = [],
    options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (['--tab', '--profile', '--out', '--confirm'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
        fail(`${arg} 缺少值`)
      }
      options[arg.slice(2)] = argv[++i]
    } else {
      positional.push(arg)
    }
  }
  const [action, ...values] = positional
  const usage =
    'hiwd web tabs | open <url> [--profile <id>] | snapshot | click <ref> | fill <ref> <值> | type <文字> | press <键> | select <ref> <值> | check/uncheck <ref> | hover <ref> | scroll <up|down> [amount] | upload <ref> <文件…> | get <what> [ref] | eval <js> | wait [ms] | goto <url> | back/forward/reload/activate | screenshot [--out 文件] | close；可用 --tab <id>；发布 / 提交这类操作要老板批准的 --confirm <gate-id>'
  const arities = {
    tabs: [0, 0],
    open: [1, 1],
    snapshot: [0, 0],
    click: [1, 1],
    fill: [2, 2],
    type: [1, Infinity],
    press: [1, 1],
    select: [2, 2],
    check: [1, 1],
    uncheck: [1, 1],
    hover: [1, 1],
    scroll: [1, 2],
    upload: [2, Infinity],
    get: [1, 2],
    eval: [1, Infinity],
    wait: [0, 1],
    goto: [1, 1],
    back: [0, 0],
    forward: [0, 0],
    reload: [0, 0],
    activate: [0, 0],
    screenshot: [0, 0],
    close: [0, 0]
  }
  const range = arities[action]
  if (!range || values.length < range[0] || values.length > range[1]) {
    fail(usage)
  }
  if (options.profile && action !== 'open') {
    fail('--profile 仅用于 open')
  }
  if (options.out && action !== 'screenshot') {
    fail('--out 仅用于 screenshot')
  }
  const root = '/api/browser/tabs'
  const handle = process.env.HIVEWARD_TERMINAL_HANDLE
  const showTab = (t) =>
    `${t.id}${t.active ? ' *' : ''}  [${t.profile}]  ${t.title || '(无标题)'}  ${t.url}${t.by ? `  by=${t.by}` : ''}`
  if (action === 'open') {
    console.log(
      showTab(
        await api(root, {
          url: values[0],
          ...(options.profile ? { profile: options.profile } : {}),
          ...(handle ? { by: handle } : {})
        })
      )
    )
    return
  }
  const { tabs } = await api(root)
  if (action === 'tabs') {
    console.log(tabs.length ? tabs.map(showTab).join('\n') : '（没有标签页）')
    return
  }
  const own = handle
    ? tabs
        .filter((t) => t.by === handle)
        .sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)))
    : []
  const tab = options.tab
    ? tabs.find((t) => t.id === options.tab)
    : (own[0] ?? tabs.find((t) => t.active))
  if (!tab) {
    fail(
      options.tab
        ? `没有这个标签页：${options.tab}`
        : '没有可操作的标签页，请先 hiwd web open <url>'
    )
  }
  const path = `${root}/${enc(tab.id)}/${action}`
  if (action === 'screenshot') {
    const res = await fetch(endpoint(path))
    if (!res.ok) {
      fail((await res.json().catch(() => null))?.error?.message ?? `HTTP ${res.status}`)
    }
    const out = resolve(options.out ?? join(tmpdir(), `hiveward-shot-${Date.now()}.png`))
    await writeFile(out, Buffer.from(await res.arrayBuffer()))
    console.log(out)
    return
  }
  let body = {}
  switch (action) {
    case 'click':
    case 'check':
    case 'uncheck':
    case 'hover':
      body = { ref: values[0] }
      break
    case 'fill':
    case 'select':
      body = { ref: values[0], value: values[1] }
      break
    case 'type':
      body = { text: values.join(' ') }
      break
    case 'press':
      body = { key: values[0] }
      break
    case 'scroll':
      body = {
        direction: values[0],
        ...(values[1] !== undefined ? { amount: Number(values[1]) } : {})
      }
      break
    case 'upload':
      body = { ref: values[0], files: values.slice(1).map((f) => resolve(f)) }
      break
    case 'get':
      body = { what: values[0], ...(values[1] !== undefined ? { ref: values[1] } : {}) }
      break
    case 'eval':
      body = { expression: values.join(' ') }
      break
    case 'wait':
      if (values[0] !== undefined) {
        body = { ms: Number(values[0]) }
      }
      break
    case 'goto':
      body = { url: values[0] }
      break
  }
  if (options.confirm) {
    body.confirm = options.confirm
  }
  const data = await api(path, body)
  if (action === 'snapshot') {
    console.log(data.snapshot)
  } else if (action === 'get' || action === 'eval') {
    console.log(typeof data.value === 'string' ? data.value : JSON.stringify(data.value))
  } else {
    console.log(
      action === 'close'
        ? `已关闭 ${tab.id}`
        : `ok  ${data.url ?? tab.url}${data.title ? `  ${data.title}` : ''}`
    )
  }
}

// hiwd new 能开的下属：OpenCode 默认跑 OpenCode Go 的 DeepSeek 4.1 Flash，Kimi / Codex 没额度时顶上
const WORKER_AGENTS = Object.keys(FULL_ACCESS)

const HIWD_HELP = [
  'HiveWard 命令（hiwd，别名 hiveward）：',
  'hiwd machines | machines invite <host:port> | machines join <电脑名或地址> | machines accept/reject/cancel <inviteId> | machines remove <id> | machines leave',
  'hiwd mcp <名字> [--on 电脑] | mcp ls [--on 电脑] | mcp add/rm/on/off | mcp config <名字> --on <电脑>',
  '    例：hiwd mcp add myapp -- npx myapp-mcp；hiwd mcp add local --url http://127.0.0.1:3000/mcp',
  'hiwd files roots | ls <路径> | cat <路径> [--max <字节>] | get <远程路径> [本地路径] | put <本地文件> [远程目录]',
  '    例：hiwd files put ./报告.pdf --on Windows；不填远程目录时进入对方收件箱',
  '上面这些和下面 hiwd 自己的命令都支持 --on <机器名或 id>（唯一前缀，不区分大小写）；引擎命令不支持',
  'hiwd seat ceo|leader [--business 业务] [--project 项目] [--replace] | seat leave',
  'hiwd inbox [--timeout <分钟>]（收到自己的消息后退出；默认 60，最长 1440）',
  'hiwd projects [--business 业务]（列出业务和项目）',
  'hiwd projects add <名字> [--dir 子目录] [--leader agent] [--prompt 话] | archive <项目> | rename <项目> <新名字>',
  'hiwd projects schedule <项目> [--business 业务] [--every <分钟> --say "话" | --off]',
  'hiwd projects new <业务> <项目名> [--dir 子目录] [--agent claude|codex|kimi] [话]（旧写法）',
  'hiwd new <目录> <agent> [--project 项目ID或业务/项目] [--model 模型名] [话]',
  'hiwd agents | read <agent> [-n 20] | tell <agent> <话>',
  '    | new <目录> <claude|codex|kimi|opencode> [话] | stop <agent> | close <agent>',
  'hiwd overview | tasks [业务] [--open] [-n 20] | task <id>',
  '    | review <任务id> --accept | review <任务id> --rework "意见"',
  '    | decisions | decide <id> <答复…> | assign <业务>/<项目> <话…>',
  'hiwd web tabs | open <url> [--profile <id>] | snapshot | … [--tab <id>]',
  'hiwd file open <文件或目录> [--focus]（给老板看文件：打开在 HiveWard 工作台右栏，不要用系统的 open；--focus 把窗口叫到前面）'
].join('\n')

const route = routeHiwdArgv(process.argv.slice(2))
if (route.kind === 'error') {
  fail(route.message)
}
if (route.kind !== 'hiwd') {
  const launch = resolveEngineLaunch({ serverDir: import.meta.dirname })
  const missing =
    '找不到引擎命令行（装好的 App 里是 app.asar.unpacked/out/cli/index.js；开发环境先 pnpm build:cli 生成 out/cli/index.js）'
  if (route.kind === 'help') {
    const tail = launch ? '\n\n引擎命令（hiwd 不认识的命令都原样转给它）：\n\n' : `\n\n${missing}\n`
    await new Promise((done) => process.stdout.write(`${HIWD_HELP}${tail}`, done))
    if (!launch) {
      process.exit(0)
    }
  } else if (!launch) {
    fail(missing)
  }
  let engineEnvironment = process.env
  if (
    process.argv[2] === 'orchestration' &&
    !process.env.HIVEWARD_TERMINAL_HANDLE &&
    !process.env.HIVEWARD_AGENT_SESSION_ID
  ) {
    const party = await api('/api/orchestration/session', { path: process.cwd() }, callerHeaders())
    engineEnvironment = { ...process.env, HIVEWARD_ORCHESTRATION_SESSION_ID: party.sessionId }
  }
  process.exit(
    await runEngine(
      launch,
      route.kind === 'help' ? ['--help'] : process.argv.slice(2),
      engineEnvironment
    )
  )
}

const argv = process.argv.slice(2)
let on
let selectedMachine
for (let i = 0; i < argv.length && argv[i] !== '--'; i++) {
  if (argv[i] === '--on') {
    if (on || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      fail('--on 需要唯一的机器名或 id')
    }
    on = argv.splice(i, 2)[1]
    i--
  }
}
const [cmd, ...args] = argv
if (on && cmd === 'file') {
  fail('file open 打开在本机工作台；别的电脑上的文件用 hiwd files cat / get 看')
}
if (on && cmd === 'review') {
  fail('复核使用派单方本机的原生 Task，不需要 --on')
}
if (on && cmd !== 'new') {
  const { machines } = await api('/api/machines')
  const q = on.toLowerCase()
  const exact = machines.filter((m) => m.id.toLowerCase() === q || m.name.toLowerCase() === q)
  const hits = exact.length
    ? exact
    : machines.filter((m) => m.id.toLowerCase().startsWith(q) || m.name.toLowerCase().startsWith(q))
  if (hits.length !== 1) {
    fail(
      hits.length
        ? `机器名不唯一，请用 id：${hits.map((m) => `${m.name} (${m.id})`).join('、')}`
        : `没找到电脑「${on}」`
    )
  }
  if (!hits[0].self && !hits[0].paired) {
    fail('电脑尚未配对')
  }
  selectedMachine = hits[0]
  machinePrefix = `/api/m/${enc(selectedMachine.id)}`
}

const PROJECT_ACTIONS = ['add', 'new', 'schedule', 'archive', 'rename']
switch (cmd === 'projects' && PROJECT_ACTIONS.includes(args[0]) ? 'projects:manage' : cmd) {
  case 'inbox': {
    const timeout = Number(takeOption(args, '--timeout') ?? 60)
    const identity = dispatcher().id
    if (on) {
      fail('hiwd inbox 只能接收本机当前身份的消息')
    }
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 1440 || args.length) {
      fail('用法：hiwd inbox [--timeout <分钟>]（大于 0，最长 1440 分钟）')
    }
    const deadline = Date.now() + timeout * 60_000
    while (true) {
      const remaining = Math.max(0, (deadline - Date.now()) / 1000)
      if (!remaining) {
        console.log('没有新消息')
        break
      }
      const result = await api(
        `/api/inbox/wait?timeout=${Math.min(60, remaining)}`,
        undefined,
        callerHeaders(identity)
      )
      if (result.messages?.length) {
        console.log(result.text)
        if (result.deliveryId) {
          console.log(`处理完取信批次后确认：hiwd orchestration check --ack ${result.deliveryId}`)
        }
        break
      }
      if (Date.now() >= deadline) {
        console.log('没有新消息')
        break
      }
    }
    break
  }
  case 'mcp': {
    try {
      await runMcp(args, {
        endpoint,
        localEndpoint: (path) => BASE + path,
        machine: selectedMachine,
        on
      })
    } catch (e) {
      fail(e.message)
    }
    break
  }
  case 'files': {
    try {
      await runFiles(args, {
        endpoint,
        localEndpoint: (path) => BASE + path,
        machine: selectedMachine
      })
    } catch (e) {
      fail(e.message)
    }
    break
  }
  case 'machines': {
    const [action, ...values] = args
    if (action === 'invite') {
      console.log(JSON.stringify(await api('/api/machines/invite', { address: values[0] })))
    } else if (action === 'join') {
      const target = values[0]
      if (!target) {
        fail('用法：hiwd machines join <电脑名或地址>')
      }
      const { machines } = await api('/api/machines')
      const q = target.toLowerCase()
      const exact = machines.filter((m) => m.id.toLowerCase() === q || m.name.toLowerCase() === q)
      const hits = exact.length
        ? exact
        : machines.filter(
            (m) => m.id.toLowerCase().startsWith(q) || m.name.toLowerCase().startsWith(q)
          )
      if (hits.length > 1) {
        fail(`机器名不唯一，请用 id：${hits.map((m) => `${m.name} (${m.id})`).join('、')}`)
      }
      console.log(
        JSON.stringify(
          await api(
            '/api/machines/join',
            hits.length ? { machineId: hits[0].id } : { address: target }
          )
        )
      )
    } else if (['accept', 'reject', 'cancel'].includes(action)) {
      console.log(
        JSON.stringify(await api(`/api/machines/invitations/${enc(values[0])}/${action}`, {}))
      )
    } else if (action === 'leave') {
      console.log(JSON.stringify(await api('/api/machines/organization/leave', {})))
    } else if (action === 'remove') {
      console.log(JSON.stringify(await api(`/api/machines/${enc(values[0])}/remove`, {})))
    } else {
      const { machines } = await api('/api/machines')
      console.log(
        machines
          .map(
            (m) =>
              `${m.name}${m.self ? ' (本机)' : ''}  ${m.id}  ${m.status}  ${m.address ?? '-'}  组织 ${m.organization?.name ?? '-'}  Agent ${m.summary?.agents ?? '-'}${m.paired ? '' : '  未配对'}`
          )
          .join('\n')
      )
    }
    break
  }
  case 'file': {
    // hiwd file open <路径> [--focus]：在工作台右栏的文件查看器里打开，不用系统默认程序
    const focus = args.includes('--focus')
    const rest = args.filter((a) => a !== '--focus')
    if (rest[0] !== 'open' || rest.length !== 2 || rest[1].startsWith('-')) {
      fail('用法：hiwd file open <文件或目录> [--focus]')
    }
    const path = resolve(process.cwd(), rest[1])
    const opened = await api('/api/workbench/open-file', { path, focus })
    console.log(`已在 HiveWard 工作台右栏打开：${opened.path}`)
    break
  }
  case 'web': {
    try {
      await browser(args)
    } catch (e) {
      fail(e.message)
    }
    break
  }
  case 'agents': {
    const list = await terminals()
    const stops = quotaByHandle(await quota())
    console.log(
      list.length
        ? list
            .map((t) => {
              const [head, ...rest] = line(t).split('\n')
              return [
                stops.has(t.handle) ? `${head}  · ${stops.get(t.handle)}` : head,
                ...rest
              ].join('\n')
            })
            .join('\n')
        : '（没有终端）'
    )
    break
  }
  case 'seat': {
    const action = args.shift()
    const terminal = process.env.HIVEWARD_TERMINAL_HANDLE
    const session = seatSession()
    if (!terminal && !session) {
      fail('只能在 Claude Code / Codex 会话里坐座位')
    }
    const replace = args.includes('--replace')
    if (replace) {
      args.splice(args.indexOf('--replace'), 1)
    }
    const businessQuery = takeOption(args, '--business')
    if (action === 'leave') {
      const id = terminal ?? session.sessionId
      const { businesses } = await api('/api/overview')
      const seats = businesses.flatMap((b) => [
        ...(occupiedBy(b.ceo, id) ? [{ business: b, seat: 'ceo' }] : []),
        ...(b.projects ?? []).flatMap((p) =>
          occupiedBy(p.leader, id) ? [{ business: b, project: p, seat: 'leader' }] : []
        )
      ])
      if (seats.length !== 1) {
        fail(
          seats.length ? '当前身份坐在多个座位上，请先离座再重试' : '当前会话 / 终端没有坐在座位上'
        )
      }
      const current = seats[0]
      await api(
        '/api/seats/leave',
        {
          seat: current.seat,
          businessId: current.business.id,
          projectId: current.project?.id,
          sessionId: session?.sessionId
        },
        callerHeaders(terminal)
      )
      console.log(
        `已离座：${current.business.name}${current.project ? `/${current.project.name}` : ''} 的 ${current.seat === 'ceo' ? 'CEO' : 'Leader'} 位`
      )
      break
    }
    if (!['ceo', 'leader'].includes(action)) {
      fail(
        '用法：hiwd seat ceo|leader [--business 业务] [--project 项目] [--replace]；hiwd seat leave'
      )
    }
    const business = await seatBusiness(businessQuery)
    const projectQuery = takeOption(args, '--project')
    const project = action === 'leader' ? await seatProject(business, projectQuery) : null
    let result
    if (terminal) {
      const current = (await terminals()).find((t) => t.handle === terminal)
      if (!current?.agent || !['claude', 'codex', 'kimi'].includes(current.agent)) {
        fail('当前 HiveWard 终端里没有可认出的 Claude Code / Codex / Kimi Agent')
      }
      result = await api(
        project
          ? `/api/businesses/${enc(business.businessId)}/projects/${enc(project.id)}/leader`
          : `/api/businesses/${enc(business.businessId)}/ceo`,
        { agent: current.agent, replace },
        { ...callerHeaders(terminal), 'x-hiveward-seat-claim': 'terminal' }
      )
    } else {
      result = await api('/api/seats/claim', {
        seat: action,
        businessId: business.businessId,
        projectId: project?.id,
        session,
        replace
      })
    }
    console.log(result.brief)
    break
  }
  case 'projects': {
    // 列业务（含业务 id）及其项目
    const businessQuery = takeOption(args, '--business')
    if (args.length) {
      fail('用法：hiwd projects [--business 业务] | projects add|new|schedule|archive|rename …')
    }
    let { businesses } = await api('/api/overview')
    if (businessQuery) {
      const selected = await matchBusiness(businessQuery)
      businesses = businesses.filter((b) => b.id === selected.businessId)
    }
    console.log(
      businesses
        .map(
          (b) =>
            `${b.name}  ${b.id}  ${b.workspacePath}\n${(b.projects ?? [])
              .map((p) => {
                const leader = p.leader
                  ? `${p.leader.agent} ${p.leader.occupant?.sessionId ?? p.leader.terminal} [${p.leader.liveness}]`
                  : 'Leader 位空着'
                return `  → ${p.name}  ${p.id}  [${p.status}]  ${p.path}\n     Leader：${leader}`
              })
              .join('\n')}`
        )
        .join('\n')
    )
    break
  }
  case 'read': {
    const i = args.indexOf('-n')
    const n = i !== -1 ? Number(args.splice(i, 2)[1]) || 20 : 20
    const query = args.join(' ')
    const task = (await api('/api/tasks')).find(
      (item) =>
        item.id === query ||
        item.assignee?.dispatchId === query ||
        `dispatch:${item.assignee?.dispatchId}` === query
    )
    if (task?.assignee?.dispatchId) {
      const output = await api(`/api/workers/${enc(task.assignee.dispatchId)}/screen`)
      console.log(
        chatText(output.items ?? [])
          .split('\n')
          .slice(-n)
          .join('\n') ||
          output.text ||
          '暂无输出'
      )
      break
    }
    if (/^(?:dsp_|task_)/.test(query) && !task?.terminal) {
      fail(`没找到任务「${query}」对应的在线终端，可用 hiwd task ${query} 看完整汇报`)
    }
    const t = await find(task?.terminal ?? query)
    const chat = await api(`/api/hiveward/terminals/${enc(t.handle)}/chat`)
    const screen = await api(`/api/hiveward/terminals/${enc(t.handle)}/screen`)
    const state =
      screen.agent === 'working'
        ? '干活中'
        : screen.errorStop
          ? screen.errorStop.reason === 'quota'
            ? `${quotaLabel((await quota()).find((a) => a.agent === t.agent)?.resetsAt)}（${screen.errorStop.line}）`
            : `出错停了：${ERROR_STOP_LABELS[screen.errorStop.reason]}（${screen.errorStop.line}）`
          : screen.agent
            ? '等输入'
            : '没有 Agent'
    console.log(`# ${t.title || '终端'} · ${short(t.project)} · ${state}\n`)
    for (const text of screen.dropped ?? []) {
      console.log(`⚠ 发给它的消息因为模型出错被丢了，恢复后要重发：${text}\n`)
    }
    console.log(
      chat.source
        ? chatText(chat.items.slice(-n))
        : screen.text
            .trimEnd()
            .split('\n')
            .slice(-n * 2)
            .join('\n')
    )
    break
  }
  case 'tell': {
    const [who, ...words] = args
    const text = words.join(' ').trim()
    if (!text) {
      fail('要说什么？ hiwd tell <agent> <话>')
    }
    const task = (await api('/api/tasks')).find(
      (row) =>
        row.id === who ||
        row.assignee?.dispatchId === who ||
        `dispatch:${row.assignee?.dispatchId}` === who
    )
    if (task?.assignee?.dispatchId) {
      await api(`/api/workers/${enc(task.assignee.dispatchId)}/tell`, { text }, callerHeaders())
      console.log(`已发给 ${task.id}`)
      break
    }
    let t = await find(who, !on)
    t ??= await find(who)
    await api(
      `/api/hiveward/terminals/${enc(t.handle)}/send`,
      {
        text,
        agentPrompt: t.agent ? true : undefined,
        dispatchTell: t.agent ? true : undefined
      },
      callerHeaders()
    )
    console.log(`已发给 ${t.title || t.handle}`)
    break
  }
  case 'new': {
    const projectOption = args.indexOf('--project')
    const projectQuery = projectOption === -1 ? undefined : args.splice(projectOption, 2)[1]
    const modelOption = args.indexOf('--model')
    const model = modelOption === -1 ? undefined : args.splice(modelOption, 2)[1]
    if (modelOption !== -1 && !model?.trim()) {
      fail('--model 需要模型名，例如 --model gpt-6.1-sol')
    }
    let selectedProject
    if (projectQuery) {
      const overview = await api('/api/overview')
      selectedProject =
        overview.businesses.flatMap((b) => b.projects ?? []).find((p) => p.id === projectQuery) ??
        (await matchProject(projectQuery)).project
    }
    const projectId = selectedProject?.id
    const [project, agent, ...words] = args
    if (!project || !agent) {
      fail('用法：hiwd new <目录> <agent> [--model 模型] "活"')
    }
    // 那家额度用完了：只提醒，不拦
    const out = (await quota()).find((a) => a.agent === agent && a.exhausted)
    if (out) {
      const others = WORKER_AGENTS.filter((x) => x !== agent).join(' / ')
      console.error(
        `⚠ ${out.name} ${quotaLabel(out.resetsAt)}${out.stopped ? `（${out.stopped} 个下属停着）` : ''}，开出来可能马上停下；可以换 ${others}`
      )
    }
    const { projects } = await api('/api/hiveward/projects')
    const remote = Boolean(on)
    // 远程未登记目录原样交给执行端校验，不能在派单电脑上展开或检查。
    const expanded = remote ? project : project.replace(/^~(?=[\\/]|$)/, homedir())
    const dir = remote ? null : resolve(expanded)
    // /tmp 是 /private/tmp 的软链；按真实路径找已登记项目，否则会把同一个目录当成两个。
    const realDir = dir && existsSync(dir) ? realpathSync(dir) : dir
    const p =
      (remote ? { path: project, name: short(project) || project } : selectedProject) ??
      projects.find((x) => x.path === project || (!remote && x.path === realDir)) ??
      projects.find((x) => x.name.toLowerCase() === project.toLowerCase()) ??
      (remote
        ? { path: project, name: short(project) || project }
        : /[/\\]/.test(expanded) && realDir
          ? { path: realDir, name: short(realDir) || realDir }
          : null)
    if (!p) {
      fail(`没有可用目录「${project}」，可选：${projects.map((x) => x.name).join('、')}`)
    }
    const text = words.join(' ').trim()
    if (!text) {
      fail('要写清楚让下属做什么')
    }
    const result = await api(
      '/api/workers/start',
      {
        path: p.path,
        agent,
        projectId,
        model,
        prompt: text,
        ...(on ? { on, dispatcherPath: process.cwd() } : {})
      },
      callerHeaders()
    )
    console.log(
      `已派 ${agent} @ ${p.name}：${result.terminal}，任务 ${result.taskId}，派单 ${result.dispatchId} [${result.state}]`
    )

    break
  }
  case 'stop': {
    const t = await find(args.join(' '))
    await api(`/api/hiveward/terminals/${enc(t.handle)}/send`, { interrupt: true })
    console.log(`已中断 ${t.title || t.handle}`)
    break
  }
  case 'close': {
    const t = await find(args.join(' '))
    await api(`/api/hiveward/terminals/${enc(t.handle)}/close`, {})
    console.log(`已关掉 ${t.title || t.handle}（任务记录还在，hiwd tasks 能看到）`)
    break
  }
  case 'overview': {
    const nodes = await topoRows()
    const decisions = await api('/api/decisions?state=pending')
    const grokOf = Object.fromEntries(
      nodes.filter((n) => n.kind === 'grok').map((n) => [n.businessId, n])
    )
    const leaders = nodes.filter((n) => n.kind === 'leader' && n.parentId)
    const leaderByParent = Object.fromEntries(leaders.map((l) => [l.parentId, l]))
    const projects = nodes.filter((n) => ['business', 'project'].includes(n.kind))
    if (!projects.length) {
      console.log('（架构图上还没有业务 / 未登记目录）')
    }
    for (const n of projects) {
      const l = leaderByParent[n.id]
      const dir = n.project ? short(n.project) : '-'
      const who = l
        ? (l.sublabel ?? (l.terminal ? '有 Leader Agent' : '无 Leader Agent'))
        : '无 Leader Agent'
      // 没有 Leader Agent、或是桌面端会话这类看不到在不在的，不写括号
      const live = l ? (l.liveness === 'live' ? '（在）' : l.liveness ? '（不在）' : '') : ''
      console.log(
        `${n.label} [${n.businessId ?? dir}]  ${dir} · Leader Agent：${who}${live}${l?.activity ? ` · ${l.activity}` : ''}`
      )
      const g = n.businessId ? grokOf[n.businessId] : null
      if (g) {
        console.log(`    Personal Agent（${g.label}）：${g.activity ?? '最近没派单'}`)
      }
      console.log(`    ${(n.stats ?? []).join(' · ') || '暂无任务'}`)
    }
    console.log(`要老板决定的事：${decisions.length} 件`)
    break
  }
  case 'review': {
    const [id] = args
    const accept = args.includes('--accept')
    const rework = args.indexOf('--rework')
    const validAccept = accept && args.length === 2 && args[1] === '--accept'
    const validRework = rework === 1 && args.length === 3 && args[2]?.trim()
    if (!id || accept === (rework !== -1) || (!validAccept && !validRework)) {
      fail('用法：hiwd review <任务id> --accept 或 hiwd review <任务id> --rework "意见"')
    }
    if (!(await api('/api/tasks')).some((task) => task.id === id)) {
      fail(`没有原生任务「${id}」，请在派单方本机复核`)
    }
    const caller = dispatcher()
    const result = await api(
      `/api/tasks/${enc(id)}/review`,
      accept ? { verdict: 'accept' } : { verdict: 'rework', note: args[2] },
      {
        'x-hiveward-caller': 'agent',
        'x-hiveward-dispatcher-id': encodeURIComponent(caller.id),
        'x-hiveward-dispatcher-kind': caller.kind ?? dispatcher().kind,
        'x-hiveward-dispatcher-label': encodeURIComponent(caller.label ?? dispatcher().label),
        'x-hiveward-dispatcher-cwd': encodeURIComponent(caller.cwd ?? process.cwd())
      }
    )
    if (accept) {
      console.log(`已通过 ${id}，工作记录：${result.record?.id ?? '-'}`)
      if (result.closeError) {
        console.log(`终端未关闭：${result.closeError}`)
      }
    } else {
      console.log(`已打回 ${id}，编排已接收后续任务`)
    }
    break
  }
  case 'tasks': {
    let open = false,
      n = 20
    const rest = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--open') {
        open = true
      } else if (args[i] === '-n') {
        n = Number(args[++i]) || 20
      } else {
        rest.push(args[i])
      }
    }
    let tasks
    if (rest.length) {
      const row = await matchBusiness(rest.join(' '))
      if (row.businessId) {
        tasks = await api(`/api/tasks?businessId=${enc(row.businessId)}`)
      } else {
        // 不属于业务的项目行：没有 businessId，按项目目录名筛
        const dir = short(row.project ?? '')
        tasks = (await api('/api/tasks')).filter((t) => t.project === dir)
      }
    } else {
      tasks = await api('/api/tasks')
    }
    if (open) {
      tasks = tasks.filter((t) => !['completed', 'failed'].includes(t.status))
    }
    tasks = tasks.slice(0, n)
    if (!tasks.length) {
      console.log('（没有任务）')
      break
    }
    console.log(
      tasks
        .map((t) => {
          const from = t.dispatchedBy?.label ?? '-'
          const to = t.assignee?.agent ?? t.terminal ?? '-'
          const biz = t.businessId || t.project || '-'
          const review =
            t.review?.state === 'awaiting'
              ? ` [待复核·${t.review.reviewer === 'owner' ? '老板' : `派单方 ${from}`}]`
              : ''
          const head = `${t.id} [${t.status}]${review} ${from}→${to} · ${biz} · ${t.title}`
          const report = t.report?.summary ? `\n    汇报：${firstSentence(t.report.summary)}` : ''
          return head + report
        })
        .join('\n')
    )
    break
  }
  case 'task': {
    const [id] = args
    if (!id) {
      fail('用法：hiwd task <id>')
    }
    const t = (await api('/api/tasks')).find((x) => x.id === id)
    if (!t) {
      fail(`没找到任务「${id}」，用 hiwd tasks 看看有哪些`)
    }
    const rows = [
      `# ${t.title}`,
      `状态：${t.status} · ${t.dispatchedBy?.label ?? '-'} → ${t.assignee?.agent ?? t.terminal ?? '-'}${t.businessId || t.project ? ` · 业务 ${t.businessId || t.project}` : ''}`
    ]
    if (t.followUps?.length) {
      rows.push(`中途补充：\n${t.followUps.map((f) => `  · ${f}`).join('\n')}`)
    }
    if (t.errorStop) {
      rows.push(
        `出错停了：${ERROR_STOP_LABELS[t.errorStop.reason]}（${t.errorStop.line}）。恢复后再让它接着干`
      )
    }
    if (t.dropped) {
      rows.push(`⚠ 发给它的消息因为模型出错被丢了，恢复后要重发：${t.dropped.text}`)
    }
    if (t.blockedReason && t.status === 'failed') {
      rows.push(`原因：${t.blockedReason}`)
    }
    rows.push(
      t.report
        ? `汇报（${t.report.outcome}，${t.report.reportedAt ?? ''}）：\n${t.report.summary}`
        : '汇报：（还没有）'
    )
    rows.push(`更新：${t.updatedAt}`)
    console.log(rows.join('\n'))
    break
  }
  case 'decisions': {
    const list = await api('/api/decisions?state=pending')
    if (!list.length) {
      console.log('没有要老板决定的事')
      break
    }
    console.log(
      list
        .map((d) => {
          const head = `${d.id} ${d.businessId ?? '-'} · ${d.question}${
            d.urgency === 'high' ? '（急）' : ''
          }`
          const opts = d.options?.length
            ? `\n${d.options.map((o) => `  ${o === d.recommendation ? '★' : '-'} ${o}`).join('\n')}`
            : ''
          return head + opts
        })
        .join('\n')
    )
    break
  }
  case 'decide': {
    const [id, ...words] = args
    const choice = words.join(' ').trim()
    if (!id || !choice) {
      fail('用法：hiwd decide <id> <答复…>')
    }
    const d = (await api('/api/decisions?state=pending')).find((x) => x.id === id)
    if (!d) {
      fail(`没找到待决定的事「${id}」，用 hiwd decisions 看看有哪些`)
    }
    // 答复正好是某个选项就走选项，否则算自定义答复
    const body = d.options?.includes(choice) ? { choice } : { choice, custom: true }
    const r = await api(`/api/decisions/${enc(id)}/resolve`, body)
    console.log(`已答复 ${id}：${r.resolution?.choice ?? choice}`)
    break
  }
  case 'projects:manage': {
    const action = args.shift()
    const dir = takeOption(args, '--dir')
    const businessQuery = takeOption(args, '--business')
    if (action === 'add' || action === 'new') {
      const agent = takeOption(args, action === 'add' ? '--leader' : '--agent')
      const promptOption = takeOption(args, '--prompt')
      const [businessArg, nameArg, ...words] = args
      const name = action === 'add' ? businessArg : nameArg
      if (!name || (action === 'add' && nameArg)) {
        fail(
          '用法：hiwd projects add <名字> [--dir 子目录] [--leader claude|codex|kimi] [--prompt "话"]'
        )
      }
      const business = await seatBusiness(action === 'add' ? businessQuery : businessArg)
      const result = await api(
        `/api/businesses/${enc(business.businessId)}/projects`,
        {
          name,
          dir,
          agent,
          prompt: promptOption ?? (action === 'new' ? words.join(' ') || undefined : undefined)
        },
        callerHeaders()
      )
      if (action === 'new') {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(
          `已新建项目 ${result.project.name} (${result.project.id})${result.project.leader ? `；Leader ${result.project.leader.terminal ?? result.project.leader.occupant?.sessionId}` : ''}${result.leaderError ? `；Leader 未启动：${result.leaderError.message}` : ''}`
        )
      }
      break
    }
    if (action === 'schedule') {
      const every = takeOption(args, '--every')
      const say = takeOption(args, '--say')
      const off = args.includes('--off')
      if (off) {
        args.splice(args.indexOf('--off'), 1)
      }
      const [query, ...extra] = args
      if (!query || extra.length || (off && (every !== undefined || say !== undefined))) {
        fail(
          '用法：hiwd projects schedule <项目名或 id> [--business 业务] [--every <分钟> --say "话" | --off]'
        )
      }
      const business = await seatBusiness(businessQuery)
      const project = await seatProject(business, query, true)
      if (!off && every === undefined && say === undefined) {
        const schedule = project.schedule
        if (!schedule) {
          console.log(`定时巡检：未设置（${project.name}）`)
        } else {
          console.log(
            [
              `定时巡检：${schedule.enabled ? '开启' : '已停止'}（${project.name}）`,
              `间隔：每 ${schedule.everyMinutes} 分钟`,
              `巡检内容：${schedule.message}`,
              `上一轮：${schedule.lastRunAt ?? '还没跑过'}${schedule.lastResult ? ` · ${schedule.lastResult}` : ''}`,
              `下一轮：${schedule.nextRunAt ?? '无'}`
            ].join('\n')
          )
        }
        break
      }
      if (off && !project.schedule) {
        fail('项目还没设置定时巡检')
      }
      if (!off && (every === undefined || say === undefined)) {
        fail('开启或修改定时巡检要同时给 --every <分钟> 和 --say "话"')
      }
      const result = await api(
        `/api/businesses/${enc(business.businessId)}/projects/${enc(project.id)}/schedule`,
        off
          ? {
              enabled: false,
              ...(project.schedule.trigger ? { trigger: project.schedule.trigger } : {}),
              everyMinutes: project.schedule.everyMinutes,
              message: project.schedule.message
            }
          : { enabled: true, everyMinutes: Number(every), message: say },
        callerHeaders(),
        'PUT'
      )
      console.log(
        off
          ? `已停止定时巡检：${result.project.name}`
          : `已设置定时巡检：${result.project.name} · 每 ${result.project.schedule.everyMinutes} 分钟`
      )
      break
    }
    if (!['archive', 'rename'].includes(action)) {
      fail(
        '用法：hiwd projects [--business 业务] | projects add|schedule|archive|rename …（旧写法：projects new <业务> <项目名>）'
      )
    }
    const [query, newName] = args
    if (!query || (action === 'rename' && !newName)) {
      fail(`用法：hiwd projects ${action} <项目名或 id>${action === 'rename' ? ' <新名字>' : ''}`)
    }
    const business = await seatBusiness(businessQuery)
    const project = await seatProject(business, query, action === 'rename')
    const result = await api(
      `/api/businesses/${enc(business.businessId)}/projects/${enc(project.id)}`,
      action === 'archive' ? { status: 'archived' } : { name: newName },
      callerHeaders(),
      'PATCH'
    )
    console.log(`${action === 'archive' ? '已归档' : '已改名'}：${result.project.name}`)
    break
  }
  case 'assign': {
    const [who, ...words] = args
    const text = words.join(' ').trim()
    if (!who || !text) {
      fail('用法：hiwd assign <业务>/<项目> <话…>')
    }
    const { business, project } = await matchProject(who)
    const result = await api(
      `/api/businesses/${enc(business.businessId)}/projects/${enc(project.id)}/leader`,
      { agent: project.leader?.agent ?? 'claude', prompt: text }
    )
    console.log(`已派给 ${business.label}/${project.name} 的 Leader Agent：${result.terminal}`)
    break
  }
  default:
    // routeHiwdArgv 已把不认识的命令转给引擎，这里只会是 HIWD_COMMANDS 里漏写了分支
    fail(`内部错误：${cmd} 没有实现`)
}

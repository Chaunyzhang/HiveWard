#!/usr/bin/env node
// opc：给 Grok Bot（云端派单入口）用的命令行。走本机 OPC 桥接服务（orca-bridge.mjs），
// 输出都是纯文本，方便 Bot 读。
//
//   opc agents                               列出所有终端和里面跑的 Agent
//   opc projects                             列出能开 Agent 的项目
//   opc read <agent> [-n 20]                 看它最近的对话（找不到对话记录就看终端画面）
//   opc tell <agent> <话…>                   对它说话（派活、追问、纠偏）
//   opc new <项目> <claude|codex|kimi> [话…]  新开一个 Agent（完全访问模式），可带第一句话
//   opc stop <agent>                         中断它手上的事
//   opc close <agent>                        验收通过后关掉它的终端（任务记录保留，架构图上不再显示）
//   opc status                               全局一屏：每块业务一行（总 Agent、任务、待决定）
//   opc tasks [业务] [--open] [-n 20]        任务列表，新的在前；--open 只看没完成的
//   opc task <id>                            一个任务的全部：派单、补充、汇报
//   opc decisions                            要老板决定的事（列选项、标推荐）
//   opc decide <id> <答复…>                  替老板答复一个决定
//   opc assign <业务> <话…>                  把活派给这块业务的总 Agent（老板卡同款）
//
// <agent> 可以是终端 handle，也可以是标题 / 项目名里的一段字。

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const browserGuide = fileURLToPath(new URL('../docs/agent-browser.md', import.meta.url))

const BASE = process.env.OPC_BRIDGE ?? 'http://127.0.0.1:8787'
const enc = encodeURIComponent
let machinePrefix = ''
const endpoint = (path) => BASE + (machinePrefix ? machinePrefix + path.slice(4) : path)

async function api(path, body) {
  let res
  try {
    res = await fetch(endpoint(path), {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
  } catch {
    fail(`连不上 HiveWard ${BASE}（先打开 HiveWard App）`)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    fail(`${data?.error?.code === 'exit_region_blocked' ? '[exit_region_blocked] ' : ''}${data?.error?.message ?? `HTTP ${res.status}`}`)
  }
  return data
}

function fail(msg) {
  console.error(`opc: ${msg}`)
  process.exit(1)
}

const short = (p) => p.split('/').pop()

// 谁在派单：桌面端 Claude 会话 / 终端里的 Claude Code / Grok（设 OPC_DISPATCHER=grok）/ 其它命令行
function dispatcher() {
  const env = process.env
  // 每块业务一个 Grok Bot：OPC_DISPATCHER=grok:<业务id>（只写 grok 时按派活的目录归业务）
  if (env.OPC_DISPATCHER) {
    const grok = /^grok(:|$)/.test(env.OPC_DISPATCHER)
    return {
      kind: grok ? 'grok' : 'cli',
      id: env.OPC_DISPATCHER,
      label: grok ? 'Grok Bot' : env.OPC_DISPATCHER,
      cwd: process.cwd()
    }
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
  return { kind: 'cli', id: 'cli', label: '命令行', cwd: process.cwd() }
}

// 往上找父进程，有一层是 Grok Bot.app 里的进程就算 Grok Bot 派的
function fromGrokBot() {
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

// 登记失败不影响派单本身，只提示
async function record(t, prompt, extra) {
  try {
    await fetch(endpoint('/api/dispatches'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: t.handle,
        project: t.project,
        agent: t.agent,
        title: t.title,
        prompt,
        by: dispatcher(),
        ...extra
      })
    }).then((r) => {
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`)
      }
    })
  } catch (e) {
    console.error(`opc: 派单已发出，但没登记进任务列表（${e.message}）`)
  }
}

async function terminals() {
  return (await api('/api/orca/terminals')).terminals
}

async function find(query) {
  if (!query) {
    fail('要指定是哪个 Agent')
  }
  const list = await terminals()
  const exact = list.find((t) => t.handle === query)
  if (exact) {
    return exact
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
    fail(`没找到「${query}」，用 opc agents 看看有哪些`)
  }
  fail(
    `「${query}」对上了 ${pick.length} 个，换个更准的说法或直接用 handle：\n${pick
      .map((t) => `  ${t.handle}  ${t.title}`)
      .join('\n')}`
  )
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
  const rows = (await topoRows()).filter((n) => n.kind === 'project')
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

// Agent 进程出现不等于能收字：启动画面还在刷时发进去的话会丢。
// 等到前台是 Agent、且画面连续 2 秒不变，才算可以说话。
async function waitForAgent(handle, ms = 45_000) {
  const until = Date.now() + ms
  let last = null
  let stableSince = 0
  while (Date.now() < until) {
    const s = await api(`/api/orca/terminals/${enc(handle)}/screen`)
    if (s.agent && s.agent !== 'permission' && s.text === last) {
      if (Date.now() - stableSince >= 2000) {
        return true
      }
    } else {
      last = s.text
      stableSince = Date.now()
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// 发出去后确认它真收到了（对话记录里出现这句话）；没收到再补发一次
async function sendFirst(handle, text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await api(`/api/orca/terminals/${enc(handle)}/send`, { text, agentPrompt: true })
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const chat = await api(`/api/orca/terminals/${enc(handle)}/chat`)
      if (chat.items.some((it) => it.kind === 'user' && it.text.includes(text.slice(0, 20)))) {
        return true
      }
    }
  }
  return false
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
    'opc browser tabs | open <url> [--profile <id>] | snapshot | click <ref> | fill <ref> <值> | type <文字> | press <键> | select <ref> <值> | check/uncheck <ref> | hover <ref> | scroll <up|down> [amount] | upload <ref> <文件…> | get <what> [ref] | eval <js> | wait [ms] | goto <url> | back/forward/reload/activate | screenshot [--out 文件] | close；可用 --tab <id>；发布 / 提交这类操作要老板给的 --confirm <确认码>'
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
  const handle = process.env.ORCA_TERMINAL_HANDLE
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
        : '没有可操作的标签页，请先 opc browser open <url>'
    )
  }
  const path = `${root}/${enc(tab.id)}/${action}`
  if (action === 'screenshot') {
    const res = await fetch(endpoint(path))
    if (!res.ok) {
      fail((await res.json().catch(() => null))?.error?.message ?? `HTTP ${res.status}`)
    }
    const out = resolve(options.out ?? `/tmp/opc-shot-${Date.now()}.png`)
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

const argv = process.argv.slice(2)
let on
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
if (on) {
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
  machinePrefix = `/api/m/${enc(hits[0].id)}`
}

switch (cmd) {
  case 'machines': {
    const [action, ...values] = args
    if (action === 'invite') {
      console.log(JSON.stringify(await api('/api/machines/invite', { address: values[0] })))
    } else if (['accept', 'reject', 'cancel'].includes(action)) {
      console.log(JSON.stringify(await api(`/api/machines/invitations/${enc(values[0])}/${action}`, {})))
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
              `${m.name}${m.self ? ' (本机)' : ''}  ${m.id}  ${m.status}  ${m.address ?? '-'}  Agent ${m.summary?.agents ?? '-'}${m.paired ? '' : '  未配对'}`
          )
          .join('\n')
      )
    }
    break
  }
  case 'browser': {
    try {
      await browser(args)
    } catch (e) {
      fail(e.message)
    }
    break
  }
  case 'agents': {
    const list = await terminals()
    console.log(list.length ? list.map(line).join('\n') : '（没有终端）')
    break
  }
  case 'projects': {
    // 项目 = 业务：列业务（含业务 id），和引擎项目列表一一对应
    const { businesses } = await api('/api/overview')
    console.log(
      businesses
        .map((b) => `${b.name}  ${b.id}  ${b.workspacePath}${b.kind ? `  [${b.kind}]` : ''}`)
        .join('\n')
    )
    break
  }
  case 'read': {
    const i = args.indexOf('-n')
    const n = i !== -1 ? Number(args.splice(i, 2)[1]) || 20 : 20
    const t = await find(args.join(' '))
    const chat = await api(`/api/orca/terminals/${enc(t.handle)}/chat`)
    const screen = await api(`/api/orca/terminals/${enc(t.handle)}/screen`)
    const state = screen.agent === 'working' ? '干活中' : screen.agent ? '等输入' : '没有 Agent'
    console.log(`# ${t.title || '终端'} · ${short(t.project)} · ${state}\n`)
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
      fail('要说什么？ opc tell <agent> <话>')
    }
    const t = await find(who)
    await api(`/api/orca/terminals/${enc(t.handle)}/send`, {
      text,
      agentPrompt: t.agent ? true : undefined
    })
    if (t.agent) {
      await record(t, text)
    }
    console.log(`已发给 ${t.title || t.handle}`)
    break
  }
  case 'new': {
    const [project, agent, ...words] = args
    if (!project || !['claude', 'codex', 'kimi'].includes(agent)) {
      fail('用法：opc new <项目> <claude|codex|kimi> [第一句话]')
    }
    const { projects } = await api('/api/orca/projects')
    // 也可以直接给目录：还没登记的，开终端时后台会自动登记
    const dir = resolve(project.replace(/^~(?=\/|$)/, process.env.HOME))
    const p =
      projects.find((x) => x.path === project || x.path === dir) ??
      projects.find((x) => x.name.toLowerCase() === project.toLowerCase()) ??
      (project.includes('/') && existsSync(dir) ? { path: dir, name: dir.split('/').at(-1) } : null)
    if (!p) {
      fail(`没有项目「${project}」，可选：${projects.map((x) => x.name).join('、')}`)
    }
    const { handle } = await api('/api/orca/terminals', { project: p.path, agent })
    console.log(`已开 ${agent} @ ${p.name}：${handle}`)
    const text = words.join(' ').trim()
    if (text) {
      if (!(await waitForAgent(handle))) {
        fail(`${agent} 45 秒内没起来，第一句话没发，稍后用 opc tell ${handle} 再发`)
      }
      // 新开的 Agent 都附一句浏览器用法的指引：要上外部网站时照着规矩来
      const brief = `${text}\n\n（HiveWard：要上外部网站时，先读 ${browserGuide}，用 opc browser 命令操作。）`
      if (!(await sendFirst(handle, brief))) {
        fail(`第一句话发了两次都没见它收到，用 opc read ${handle} 看看，必要时 opc tell 重发`)
      }
      await record({ handle, project: p.path, agent, title: '' }, text)
      console.log('第一句话已送达')
    }
    break
  }
  case 'stop': {
    const t = await find(args.join(' '))
    await api(`/api/orca/terminals/${enc(t.handle)}/send`, { interrupt: true })
    console.log(`已中断 ${t.title || t.handle}`)
    break
  }
  case 'close': {
    const t = await find(args.join(' '))
    await api(`/api/orca/terminals/${enc(t.handle)}/close`, {})
    console.log(`已关掉 ${t.title || t.handle}（任务记录还在，opc tasks 能看到）`)
    break
  }
  case 'status': {
    const nodes = await topoRows()
    const { businesses } = await api('/api/overview')
    const decisions = await api('/api/decisions?state=pending')
    const grokOf = Object.fromEntries(
      nodes.filter((n) => n.kind === 'grok').map((n) => [n.businessId, n])
    )
    const byId = Object.fromEntries(businesses.map((b) => [b.id, b]))
    const leaders = nodes.filter((n) => n.kind === 'leader' && n.parentId)
    const leaderByParent = Object.fromEntries(leaders.map((l) => [l.parentId, l]))
    const projects = nodes.filter((n) => n.kind === 'project')
    if (!projects.length) {
      console.log('（架构图上还没有业务 / 项目）')
    }
    for (const n of projects) {
      const l = leaderByParent[n.id]
      const dir = n.project ? short(n.project) : '-'
      const who = l ? (l.sublabel ?? (l.terminal ? '有总 Agent' : '无总 Agent')) : '无总 Agent'
      // 没有总 Agent、或是桌面端会话这类看不到在不在的，不写括号
      const live = l ? (l.liveness === 'live' ? '（在）' : l.liveness ? '（不在）' : '') : ''
      console.log(
        `${n.label} [${n.businessId ?? dir}]  ${dir} · 总 Agent：${who}${live}${l?.activity ? ` · ${l.activity}` : ''}`
      )
      const g = n.businessId ? grokOf[n.businessId] : null
      if (g) {
        console.log(`    Grok Bot：${g.activity ?? '最近没派单'}`)
      }
      console.log(`    ${(n.stats ?? []).join(' · ') || '暂无任务'}`)
    }
    console.log(`要老板决定的事：${decisions.length} 件`)
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
          const head = `${t.id} [${t.status}] ${from}→${to} · ${biz} · ${t.title}`
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
      fail('用法：opc task <id>')
    }
    const t = (await api('/api/tasks')).find((x) => x.id === id)
    if (!t) {
      fail(`没找到任务「${id}」，用 opc tasks 看看有哪些`)
    }
    const rows = [
      `# ${t.title}`,
      `状态：${t.status} · ${t.dispatchedBy?.label ?? '-'} → ${t.assignee?.agent ?? t.terminal ?? '-'}${t.businessId || t.project ? ` · 业务 ${t.businessId || t.project}` : ''}`
    ]
    if (t.followUps?.length) {
      rows.push(`中途补充：\n${t.followUps.map((f) => `  · ${f}`).join('\n')}`)
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
      fail('用法：opc decide <id> <答复…>')
    }
    const d = (await api('/api/decisions?state=pending')).find((x) => x.id === id)
    if (!d) {
      fail(`没找到待决定的事「${id}」，用 opc decisions 看看有哪些`)
    }
    // 答复正好是某个选项就走选项，否则算自定义答复
    const body = d.options?.includes(choice) ? { choice } : { choice, custom: true }
    const r = await api(`/api/decisions/${enc(id)}/resolve`, body)
    console.log(`已答复 ${id}：${r.resolution?.choice ?? choice}`)
    break
  }
  case 'assign': {
    const [who, ...words] = args
    const text = words.join(' ').trim()
    if (!who || !text) {
      fail('用法：opc assign <业务> <话…>')
    }
    const row = await matchBusiness(who)
    if (!row.project) {
      fail(`「${who}」这一行没有项目目录，派不了活`)
    }
    const leader = (await topoRows()).find((n) => n.kind === 'leader' && n.parentId === row.id)
    let handle = leader?.terminal
    let agent
    if (handle) {
      // 已有总 Agent：直接发（它忙的时候话会排队，只发一次不补发）
      await api(`/api/orca/terminals/${enc(handle)}/send`, { text, agentPrompt: true })
    } else {
      // 没有总 Agent：在业务目录开一个 claude（老板卡同款）
      ;({ handle } = await api('/api/orca/terminals', {
        project: row.project,
        agent: 'claude',
        role: 'leader'
      }))
      agent = 'claude'
      console.log(`已开 claude @ ${short(row.project)}：${handle}`)
      if (!(await waitForAgent(handle))) {
        fail(`claude 45 秒内没起来，话没发，稍后用 opc tell ${handle} 再发`)
      }
      const brief = `${text}\n\n（HiveWard：要上外部网站时，先读 ${browserGuide}，用 opc browser 命令操作。）`
      if (!(await sendFirst(handle, brief))) {
        fail(`话发了两次都没见它收到，用 opc read ${handle} 看看，必要时 opc tell 重发`)
      }
    }
    // 登记派单（和老板卡一样标 role: 'leader'）
    await record({ handle, project: row.project, agent, title: '' }, text, { role: 'leader' })
    console.log(`已派给 ${row.label} 的总 Agent：${handle}`)
    break
  }
  default:
    console.log(
      [
        'opc machines | machines invite <host:port> | machines accept/reject/cancel <inviteId> | machines remove <id> | machines leave',
        '所有子命令支持 --on <机器名或 id>（唯一前缀，不区分大小写）',
        'opc agents | projects | read <agent> [-n 20] | tell <agent> <话>',
        '    | new <项目> <claude|codex|kimi> [话] | stop <agent>',
        'opc status | tasks [业务] [--open] [-n 20] | task <id>',
        '    | decisions | decide <id> <答复…> | assign <业务> <话…>',
        'opc browser tabs | open <url> [--profile <id>] | snapshot | … [--tab <id>]'
      ].join('\n')
    )
}

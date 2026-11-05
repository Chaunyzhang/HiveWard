import { dispatches } from './dispatches.mjs'
import { showDispatchTasks } from './dispatch-prompt.mjs'
import { hivewardWorkerChat } from './hiveward-worker-chat.mjs'
import { agentOfPid, agentPidIn, attachPastedImages, locate, readChat } from './transcripts.mjs'
import { readPlan } from './session-plan.mjs'
import { rpc, optionalRpc, iso } from './api-runtime.mjs'
import { businessProjects } from './business-projects.mjs'
import { seatOccupantName } from './seat-occupants.mjs'

export const FULL_ACCESS = {
  claude: 'claude --dangerously-skip-permissions',
  codex: 'codex --dangerously-bypass-approvals-and-sandbox',
  kimi: 'kimi --yolo',
  // --auto：没明确拒绝的权限都自动批准（OpenCode 的完全访问）
  opencode: 'opencode --auto'
}
// 能坐 CEO / Leader 位的几家；OpenCode 只当下属
export const SEAT_AGENTS = ['claude', 'codex', 'kimi']

export const OWNER_DELIVERY_RULE =
  '做完一轮，有成品要直接交给老板看时，在汇报里写绝对路径，并主动用 hiwd file open "<路径>" 把最终的一两个文件或文件夹打开在 HiveWard 工作台右栏（老板说现在就要看时加 --focus 把窗口叫到前面）；不要用系统的 open / start，那会交给外部程序；不要打开中间文件，给 CEO / Leader 交活时不要打开。'
export const REMOTE_DELIVERY_RULE =
  '做完一轮，有成品要直接交给老板看时，在汇报里写清成品在哪台电脑，以及成品在那台电脑上的绝对路径；不要打开中间文件，给 CEO / Leader 交活时不要打开。'

// 座位岗位说明随原生派单前言进入会话。
export const LEADER_RULES = [
  '你是 HiveWard 里这个项目的 Leader Agent。老板把活交给你，你负责拆活、派给下属 Agent、验收、汇报。',
  '派活和管下属用本机的 hiwd 命令：hiwd new <目录> <claude|codex|kimi|opencode> <话> 开下属并派活；hiwd read <agent> 看进度和汇报；hiwd tell <agent> <话> 追问、纠偏。',
  '跨电脑文件用 hiwd files ls <路径> --on <电脑> 浏览，hiwd files get <路径> --on <电脑> 取回；hiwd files put <本地文件> --on <电脑> 推入对方收件箱。',
  '下属交活后先用 hiwd read 看汇报和实际改动，再 hiwd review <任务id> --accept 或 hiwd review <任务id> --rework "意见"；没看过的活不要直接通过。通过会按规则关终端并留下工作记录，打回会让同一个 Agent 接着改。',
  OWNER_DELIVERY_RULE,
  '对外的、不可撤回的事（发布、付款、发消息、删数据）必须先问老板。'
].join(' ')

export function leaderBrief(business, project) {
  return [
    LEADER_RULES,
    `你带的项目：${project.name}；项目目录：${project.path}；业务目录：${business.workspacePath}。下属开终端时加 --project ${project.id}。`
  ].join('\n\n')
}

export function ceoBrief(business) {
  const projects = businessProjects(business.id).filter((p) => p.status === 'active')
  const list = projects.length
    ? projects
        .map(
          (p) =>
            `- ${p.name}（${p.id}）：Leader ${p.leader ? seatOccupantName(p.leader) : '空位'}；目录 ${p.path}`
        )
        .join('\n')
    : '- （暂时没有项目）'
  return [
    `你现在坐在「${business.name}」的 CEO 位上。你负责这块业务的派单、项目增减和复核，不亲自写代码 / 干具体活。`,
    `当前项目和 Leader（随时可用 hiwd projects --business ${business.id} 查最新）：\n${list}`,
    '没有项目，或活不属于任何项目：用 hiwd new <目录> <claude|codex|kimi|opencode> <话> 直接派 Worker。属于某个项目：用 hiwd tell <Leader终端> <话> 交给那个项目的 Leader；Leader 位空着时先用 hiwd projects add / 网页开一个终端坐上去。',
    `项目由你增减：hiwd projects add <名字> [--dir <子目录>] [--leader claude|codex|kimi] [--prompt "…"]；hiwd projects rename <名字或id> <新名字>；hiwd projects archive <名字或id>。新的长期方向就建项目，做完的线就归档；归档前必须确认项目没有在干的活或待复核的单。`,
    '下属交活后按派单复核流程，用 hiwd read 看汇报和实际改动，再用 hiwd review <任务id> --accept 或 --rework "意见" 复核。',
    OWNER_DELIVERY_RULE,
    '活干完、没有在等的下属后，执行 hiwd seat leave 离座。',
    `业务目录：${business.workspacePath}`
  ].join('\n\n')
}

// 不指定模型时：Kimi 用 K3.1 Pro，OpenCode 用 OpenCode Go 的 DeepSeek 4.1 Flash
const DEFAULT_MODELS = {
  kimi: 'kimi-code/k3.1-pro',
  opencode: 'opencode-go/deepseek-v4.1-flash'
}
export const agentModel = (agent, model) => model ?? DEFAULT_MODELS[agent]

const quote = (s) =>
  process.platform === 'win32' ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", "'\\''")}'`
/** 开 Agent 的命令行：完全访问模式；当 Leader Agent 的 Claude Code 再追加岗位说明 */
export function agentCommand(agent, { role, model, project, business, resume } = {}) {
  model = agentModel(agent, model)
  let command = FULL_ACCESS[agent] ?? agent
  if (resume && agent === 'codex') {
    if (model) {
      command += ` --model ${quote(model)}`
    }
    return `${command} resume ${quote(resume)}`
  }
  if (resume) {
    command += agent === 'claude' ? ` --resume ${quote(resume)}` : ` --session ${quote(resume)}`
  }
  if (model) {
    command += ` --model ${quote(model)}`
  }
  if (['leader', 'ceo'].includes(role) && agent === 'claude') {
    const brief = role === 'ceo' ? ceoBrief(business) : leaderBrief(business, project)
    command += ` --append-system-prompt ${quote(brief)}`
  }
  return command
}
const stripAnsi = (s) =>
  s.replace(
    // oxlint-disable-next-line no-control-regex -- 去掉终端转义序列，本来就要匹配 ESC 控制字符
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g,
    ''
  )
export async function observeTerminal(terminal) {
  const [proc, agentStatus] = await Promise.all([
    optionalRpc('terminal.inspectProcess', { terminal: terminal.handle }),
    optionalRpc('terminal.agentStatus', { terminal: terminal.handle })
  ])
  const process = proc?.process?.foregroundProcessEvidence?.fence?.process
  const exitedToShell =
    proc?.process?.hasChildProcesses === false && proc?.process?.foregroundProcess === null
  return {
    ...terminal,
    agentStatus: agentStatus?.agentStatus,
    agent: exitedToShell
      ? null
      : (terminal.agentIdentity ?? (process?.pid ? await agentOfPid(process.pid) : null)),
    startedAt: iso(process?.startTime),
    pid: process?.pid,
    exitedToShell
  }
}
export async function terminalScreen(handle) {
  const worker = dispatches().findLast((d) => d.handle === handle)
  if (worker && worker.agent !== 'kimi') {
    const output = await rpc('orchestration.workerRead', {
      dispatch: worker.dispatchId,
      source: 'auto',
      limit: 300
    })
    return {
      ...hivewardWorkerChat(output),
      text: output.terminal?.tail?.join('\n') ?? '',
      capturedAt: new Date().toISOString()
    }
  }
  if (!handle) {
    return { text: '', capturedAt: new Date().toISOString() }
  }
  const list = await rpc('terminal.list')
  const terminal = list.terminals.find((t) => t.handle === handle)
  if (!terminal) {
    return { text: '', capturedAt: new Date().toISOString() }
  }
  const [read, observed] = await Promise.all([
    optionalRpc('terminal.read', { terminal: handle, screen: true }),
    observeTerminal(terminal)
  ])
  const response = {
    text: stripAnsi(read?.terminal?.tail?.join('\n') ?? ''),
    capturedAt: new Date().toISOString()
  }
  if (observed.pid && observed.agent) {
    const { agent, path } = await locate({
      pid: observed.pid,
      cwd: terminal.worktreePath,
      startedAt: Date.parse(observed.startedAt) || undefined
    })
    if (agent && path) {
      response.items = readChat(agent, path, terminal.worktreePath)
    }
  }
  return response
}

export async function locateTerminalSession(handle) {
  const [proc, list] = await Promise.all([
    optionalRpc('terminal.inspectProcess', { terminal: handle }),
    rpc('terminal.list')
  ])
  const fence = proc?.process?.foregroundProcessEvidence?.fence
  const term = list.terminals.find((t) => t.handle === handle)
  const cwd = term?.worktreePath
  const known = /^(codex|claude|kimi|opencode)$/i.exec(term?.agentIdentity ?? '')?.[1].toLowerCase()
  const pid = fence?.process?.pid ?? (known && cwd ? await agentPidIn(known, cwd) : null)
  if (!pid || !cwd) {
    return { agent: null, path: null, cwd }
  }
  const { agent, path } = await locate({
    pid,
    cwd,
    startedAt: Date.parse(fence?.process?.startTime) || undefined
  })
  return { agent, path, cwd }
}

export async function terminalChat(handle) {
  const worker = dispatches().findLast((d) => d.handle === handle)
  if (worker && worker.agent !== 'kimi') {
    const output = await rpc('orchestration.workerRead', {
      dispatch: worker.dispatchId,
      source: 'auto',
      limit: 300
    })
    const chat = showDispatchTasks(
      hivewardWorkerChat(output),
      (id) => dispatches().find((d) => d.id === id)?.prompt
    )
    return { ...chat, items: attachPastedImages(chat.items, worker.project) }
  }
  const { agent, path, cwd } = await locateTerminalSession(handle)
  return {
    agent,
    source: path,
    items: agent && path ? readChat(agent, path, cwd) : [],
    // Agent 自己列的任务清单，对话页压在最后一条消息下面
    ...(agent && path ? { plan: await readPlan(agent, path) } : {})
  }
}

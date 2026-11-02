import { agentOfPid, agentPidIn, locate, readChat } from './transcripts.mjs'
import { rpc, optionalRpc, iso } from './api-runtime.mjs'

export const FULL_ACCESS = {
  claude: 'claude --dangerously-skip-permissions',
  codex: 'codex --dangerously-bypass-approvals-and-sandbox',
  kimi: 'kimi --yolo'
}

// Leader Agent 的岗位说明：开 Claude Code 当 Leader Agent 时作为系统提示追加（不进对话，不影响任务标题）
export const LEADER_RULES = [
  '你是 HiveWard 里这个项目的 Leader Agent。老板把活交给你，你负责拆活、派给下属 Agent、验收、汇报。',
  '派活和管下属用本机的 hiwd 命令：hiwd new <目录> <claude|codex|kimi> <话> 开下属并派活；hiwd read <agent> 看进度和汇报；hiwd tell <agent> <话> 追问、纠偏。',
  '跨电脑文件用 hiwd files ls <路径> --on <电脑> 浏览，hiwd files get <路径> --on <电脑> 取回；hiwd files put <本地文件> --on <电脑> 推入对方收件箱。',
  '下属交活后先用 hiwd read 看汇报和实际改动，再 hiwd review <任务id> --accept 或 hiwd review <任务id> --rework "意见"；没看过的活不要直接通过。通过会按规则关终端并留下工作记录，打回会让同一个 Agent 接着改。',
  '对外的、不可撤回的事（发布、付款、发消息、删数据）必须先问老板。'
].join(' ')

export const agentModel = (agent, model) =>
  model ?? (agent === 'kimi' ? 'kimi-code/k3.1-pro' : undefined)

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
  if (role === 'leader' && agent === 'claude') {
    command += ` --append-system-prompt ${quote([LEADER_RULES, project && `你带的项目：${project.name}；项目目录：${project.path}；业务目录：${business.workspacePath}。下属开终端时加 --project ${project.id}。`].filter(Boolean).join(' '))}`
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
  const proc = await optionalRpc('terminal.inspectProcess', { terminal: terminal.handle })
  const process = proc?.process?.foregroundProcessEvidence?.fence?.process
  const exitedToShell =
    proc?.process?.hasChildProcesses === false && proc?.process?.foregroundProcess === null
  return {
    ...terminal,
    agent: exitedToShell
      ? null
      : (terminal.agentIdentity ?? (process?.pid ? await agentOfPid(process.pid) : null)),
    startedAt: iso(process?.startTime),
    pid: process?.pid,
    exitedToShell
  }
}
export async function terminalScreen(handle) {
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
      response.items = readChat(agent, path)
    }
  }
  return response
}

export async function locateTerminalSession(handle) {
  const [proc, list] = await Promise.all([
    rpc('terminal.inspectProcess', { terminal: handle }),
    rpc('terminal.list')
  ])
  const fence = proc.process?.foregroundProcessEvidence?.fence
  const term = list.terminals.find((t) => t.handle === handle)
  const cwd = term?.worktreePath
  const known = /^(codex|claude|kimi)$/i.exec(term?.agentIdentity ?? '')?.[1].toLowerCase()
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
  const { agent, path } = await locateTerminalSession(handle)
  return { agent, source: path, items: agent && path ? readChat(agent, path) : [] }
}

export async function firstPromptScreen(handle) {
  const [read, status, processState] = await Promise.all([
    rpc('terminal.read', { terminal: handle, screen: true }),
    rpc('terminal.agentStatus', { terminal: handle }),
    rpc('terminal.inspectProcess', { terminal: handle })
  ])
  const exited =
    processState.process?.hasChildProcesses === false &&
    processState.process?.foregroundProcess === null
  return {
    text: stripAnsi(read.terminal.tail.join('\n')),
    agent:
      !exited && status.agentStatus?.isRunningAgent
        ? (status.agentStatus.status ?? 'unknown')
        : null
  }
}

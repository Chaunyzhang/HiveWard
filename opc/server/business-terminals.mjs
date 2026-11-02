import { agentOfPid, locate, readChat } from './transcripts.mjs'
import { rpc, optionalRpc, iso } from './api-runtime.mjs'

export const FULL_ACCESS = {
  claude: 'claude --dangerously-skip-permissions',
  codex: 'codex --dangerously-bypass-approvals-and-sandbox',
  kimi: 'kimi --yolo'
}

// 总 Agent 的岗位说明：开 Claude Code 当总 Agent 时作为系统提示追加（不进对话，不影响任务标题）
export const LEADER_RULES = [
  '你是 HiveWard 里这块业务的总 Agent。老板把活交给你，你负责拆活、派给下属 Agent、验收、汇报。',
  '派活和管下属用本机的 opc 命令：opc new <目录> <claude|codex|kimi> <话> 开下属并派活；opc read <agent> 看进度和汇报；opc tell <agent> <话> 追问、纠偏或打回。',
  '下属汇报后由你验收：通过了就 opc close <agent> 关掉它的终端（任务记录会保留，架构图上不再显示）；要返工的用 opc tell 打回，别关。',
  '对外的、不可撤回的事（发布、付款、发消息、删数据）必须先问老板。'
].join(' ')

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
/** 开 Agent 的命令行：完全访问模式；当总 Agent 的 Claude Code 再追加岗位说明 */
export function agentCommand(agent, { role, model } = {}) {
  let command = FULL_ACCESS[agent] ?? agent
  if (model) {
    command += ` --model ${quote(model)}`
  }
  if (role === 'leader' && agent === 'claude') {
    command += ` --append-system-prompt ${quote(LEADER_RULES)}`
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
  return {
    ...terminal,
    agent: process?.pid ? await agentOfPid(process.pid) : null,
    startedAt: iso(process?.startTime),
    pid: process?.pid,
    exitedToShell:
      proc?.process?.hasChildProcesses === false && proc?.process?.foregroundProcess === null
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

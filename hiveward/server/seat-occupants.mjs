import { statSync } from 'node:fs'
import { findSessionTranscript, readChat, readTurnState } from './transcripts.mjs'

export function normalizeSeat(seat) {
  if (!seat) {
    return null
  }
  const occupant =
    seat.occupant ?? (seat.terminal ? { kind: 'terminal', terminal: seat.terminal } : undefined)
  return { ...seat, ...(occupant ? { occupant } : {}) }
}

export function seatOccupantId(seat) {
  seat = normalizeSeat(seat)
  return seat?.occupant?.kind === 'session' ? seat.occupant.sessionId : seat?.occupant?.terminal
}

export function seatOccupantName(seat) {
  seat = normalizeSeat(seat)
  if (!seat) {
    return '空位'
  }
  const id = seatOccupantId(seat)
  return `${seat.agent}（${id}）`
}

// 干到一半这么久没动静，就不再担保它还活着
const SILENT_SESSION_MS = 30 * 60 * 1000

/** 坐在座位上的外部会话（Claude 桌面端、别处开的 Claude Code …）不在原生终端里，原生没有它的状态：
 * 读它的对话记录——一轮没结束算干活，在问老板（AskUserQuestion）算等待，结束了算空闲 */
function sessionTurn(session, now) {
  const path = findSessionTranscript(session.agent, session.sessionId, session.cwd)
  let mtimeMs
  try {
    mtimeMs = path ? statSync(path).mtimeMs : null
  } catch {
    mtimeMs = null
  }
  if (!path || mtimeMs === null) {
    return { liveness: 'unverifiable', state: 'idle', activity: undefined }
  }
  const agent = ['claude-desktop', 'claude-code'].includes(session.agent) ? 'claude' : session.agent
  const items = readChat(agent, path, session.cwd)
  const latest = items.findLast((item) => ['user', 'assistant'].includes(item.kind) && item.text)
  const last = items.at(-1)
  const asking =
    last?.kind === 'tool' && last.status === 'running' && last.title === 'AskUserQuestion'
  const working = readTurnState(agent, path, session.cwd) === 'working' && !asking
  return {
    liveness: working && now - mtimeMs > SILENT_SESSION_MS ? 'unverifiable' : 'live',
    state: asking ? 'pending' : working ? 'working' : 'idle',
    activity: latest?.text.split('\n')[0].slice(0, 80)
  }
}

// 座位只保存业务绑定；终端座位的运行状态来自原生 Task / worker 与 crew。
// 外部会话原生看不到，按它的对话记录算（sessionTurn）。
export function summarizeSeat(value, terminals, sent, crew, now = Date.now()) {
  const seat = normalizeSeat(value)
  if (!seat) {
    return null
  }
  if (seat.occupant?.kind === 'session') {
    return { ...seat, crew, ...sessionTurn(seat.occupant, now) }
  }
  const terminal = terminals.find((t) => t.handle === seat.terminal)
  const worker = sent.findLast((d) => d.handle && d.handle === seat.terminal)
  const state = terminal?.agentStatus?.status
  const offline = seat.occupant?.kind === 'terminal' && !terminal
  return {
    ...seat,
    crew,
    liveness: worker?.liveness ?? (terminal ? 'live' : 'unverifiable'),
    state:
      state === 'working'
        ? 'working'
        : worker?.turnStop?.reason === 'errored'
          ? 'failed'
          : offline
            ? 'offline'
            : state === 'permission' || worker?.turnStop?.reason === 'needs-input'
              ? 'pending'
              : worker?.status === 'dispatched'
                ? 'working'
                : 'idle',
    activity: worker?.turnStop?.body ?? worker?.prompt?.split('\n')[0].slice(0, 80)
  }
}

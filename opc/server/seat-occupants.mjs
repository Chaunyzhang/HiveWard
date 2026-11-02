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

function terminalState(seat, terminals, sent) {
  const terminal = terminals.find((t) => t.handle === seat.terminal)
  if (!terminal) {
    return null
  }
  const last = sent.findLast((d) => d.handle === seat.terminal)
  return {
    ...seat,
    liveness: terminal.agent ? 'live' : 'unverifiable',
    state:
      last?.delivery === 'failed'
        ? 'failed'
        : ({ dispatched: 'working', pending: 'pending', blocked: 'blocked' }[last?.status] ??
          'idle'),
    activity:
      last?.delivery === 'failed' ? last.blockedReason : last?.prompt.split('\n')[0].slice(0, 80)
  }
}

function sessionState(seat) {
  const session = seat.occupant
  const path = findSessionTranscript(session.agent, session.sessionId, session.cwd)
  if (!path) {
    return { ...seat, liveness: 'unverifiable', state: 'idle', activity: undefined }
  }
  let mtimeMs
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return { ...seat, liveness: 'unverifiable', state: 'idle', activity: undefined }
  }
  const agent = ['claude-desktop', 'claude-code'].includes(session.agent) ? 'claude' : session.agent
  const items = readChat(agent, path)
  const latest = items.findLast((item) => ['user', 'assistant'].includes(item.kind) && item.text)
  return {
    ...seat,
    liveness: Date.now() - mtimeMs <= 30 * 60 * 1000 ? 'live' : 'unverifiable',
    state: readTurnState(agent, path) === 'working' ? 'working' : 'idle',
    activity: latest?.text.split('\n')[0].slice(0, 80)
  }
}

export function summarizeSeat(value, terminals, sent) {
  const seat = normalizeSeat(value)
  if (!seat) {
    return null
  }
  return seat.occupant?.kind === 'session'
    ? sessionState(seat)
    : terminalState(seat, terminals, sent)
}

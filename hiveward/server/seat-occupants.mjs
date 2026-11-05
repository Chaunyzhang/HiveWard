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

// 座位只保存业务绑定；运行状态来自原生 Task / worker 与 crew，不读文件时间或猜会话是否卡住。
export function summarizeSeat(value, terminals, sent, crew) {
  const seat = normalizeSeat(value)
  if (!seat) {
    return null
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

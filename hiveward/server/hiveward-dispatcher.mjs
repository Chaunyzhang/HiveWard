import { rpc, ensureRepo } from './api-runtime.mjs'
import { badRequest } from './business.mjs'

export async function resolveDispatcher(caller, path, machineId) {
  if (caller.kind === 'agent' && !caller.id) {
    throw badRequest('派单方缺少身份')
  }
  const listed = await rpc('terminal.list')
  const terminal = listed.terminals.find((t) => t.handle === caller.id)
  if (terminal) {
    return { address: terminal.handle }
  }
  const dispatcher = {
    kind: caller.kind === 'owner' ? 'owner' : (caller.sourceKind ?? 'cli'),
    id: caller.id,
    label: caller.label ?? 'Agent',
    cwd: caller.cwd ?? path,
    ...(machineId ? { machineId } : {})
  }
  const target = path ?? caller.cwd
  if (!target) {
    throw badRequest('外部会话需要工作目录')
  }
  await ensureRepo(target)
  const session = await rpc('orchestration.hivewardSessionRegister', {
    key: `${machineId ?? 'local'}:${dispatcher.kind}:${dispatcher.id}`,
    dispatcher,
    path: target
  })
  return { address: session.address, sessionId: session.sessionId }
}

export const dispatcherEnvelope = (party) =>
  party.sessionId ? { hivewardSessionId: party.sessionId } : {}
export const dispatcherRpc = (party, method, params = {}) =>
  rpc(method, params, dispatcherEnvelope(party))

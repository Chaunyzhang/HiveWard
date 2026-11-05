import { rpc, ensureRepo } from './api-runtime.mjs'
import { badRequest, apiError } from './business.mjs'
import { resolveDispatcher, dispatcherRpc } from './hiveward-dispatcher.mjs'
import { exitRegionGuard } from './agent-exit-region.mjs'

// 引擎负责建 Task、Dispatch、终端和派单前言，不另发第一句话。
export async function startWorker(body, caller, machineId, dispatcher) {
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw badRequest('要写清楚让它做什么')
  }
  if (!body.on) {
    await exitRegionGuard().assertAllowed(body.agent, { cwd: body.path })
  }
  const party =
    dispatcher ??
    (body.from
      ? { address: body.from }
      : await resolveDispatcher(
          caller,
          body.on ? (body.dispatcherPath ?? caller.cwd) : body.path,
          machineId
        ))
  const path = body.on ? body.path : (await ensureRepo(body.path)).path
  const receipt = await dispatcherRpc(party, 'orchestration.workerStart', {
    from: party.address,
    spec: body.prompt,
    worktree: `path:${path}`,
    on: body.on,
    agent: body.agent,
    model: body.model
  })
  if (receipt.state !== 'ready') {
    const readiness = receipt.failedStage === 'agent_readiness'
    const reason = readiness
      ? `${body.agent ?? 'Agent'} 没有就绪，尚未确认能接收任务`
      : `派单没有就绪（${receipt.failedStage ?? receipt.stage ?? receipt.state}）`
    const outcome = receipt.state === 'failed' ? '派单已失败' : `派单状态：${receipt.state}`
    const next = readiness
      ? '请打开终端检查登录、信任或确认提示，处理后重新派单。'
      : '请检查终端及派单详情后再处理。'
    throw apiError(
      409,
      'worker_start_failed',
      `${reason}；${outcome}。${next}${receipt.lastError ? ` 原因：${receipt.lastError}。` : ''}${receipt.recovery ? ` ${receipt.recovery}` : ''}`
    )
  }
  const shown = await rpc('orchestration.workerShow', { dispatch: receipt.dispatchId })
  return {
    terminal: shown.server
      ? `dispatch:${receipt.dispatchId}`
      : (shown.terminal?.handle ?? shown.worker?.agentTerminalHandle),
    execution: shown.server,
    dispatchId: receipt.dispatchId,
    taskId: receipt.taskId,
    runId: receipt.runId,
    state: receipt.state,
    identity: party
  }
}

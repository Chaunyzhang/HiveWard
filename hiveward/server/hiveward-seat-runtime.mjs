import { exitRegionGuard } from './agent-exit-region.mjs'
import { agentModel } from './business-terminals.mjs'
import { rpc } from './api-runtime.mjs'
import { resolveDispatcher, dispatcherRpc } from './hiveward-dispatcher.mjs'
import { startWorker } from './worker-start.mjs'

export async function bindHivewardSeat(party, objective, call = dispatcherRpc) {
  const current = await call(party, 'orchestration.runCurrent', { from: party.address })
  const { run } = current.run
    ? current
    : await call(party, 'orchestration.runCreate', { from: party.address, objective })
  return { party, runId: run.id }
}

export async function launchHivewardSeat({ path, agent, model, brief, prompt, parent }) {
  await exitRegionGuard().assertAllowed(agent, { cwd: path })
  const dispatcher =
    parent ??
    (await resolveDispatcher({ kind: 'owner', id: 'hiveward-owner', label: '老板' }, path))
  const started = await startWorker(
    {
      path,
      agent,
      model: agentModel(agent, model),
      prompt: [brief, prompt].filter(Boolean).join('\n\n')
    },
    { kind: 'owner' },
    undefined,
    dispatcher
  )
  await rpc('orchestration.workerKeepOpen', { terminal: started.terminal, keep: true })
  const native = await bindHivewardSeat({ address: started.terminal }, brief)
  return {
    terminal: started.terminal,
    native: { ...native, dispatchId: started.dispatchId, dispatcher }
  }
}

export async function tellHivewardSeat(seat, path, prompt) {
  const native =
    seat.native ?? (await bindHivewardSeat({ address: seat.terminal }, 'HiveWard 座位'))
  const owner =
    native.dispatcher ??
    (await resolveDispatcher({ kind: 'owner', id: 'hiveward-owner', label: '老板' }, path))
  return dispatcherRpc(owner, 'orchestration.send', {
    from: owner.address,
    to: native.dispatchId ? `dispatch:${native.dispatchId}` : native.party.address,
    subject: '座位安排',
    body: prompt
  })
}

export async function unpinHivewardSeat(seat) {
  if (seat?.native?.dispatchId && seat.terminal) {
    await rpc('orchestration.workerKeepOpen', { terminal: seat.terminal, keep: false })
  }
}

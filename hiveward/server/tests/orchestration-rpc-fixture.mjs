import { randomUUID } from 'node:crypto'

// HTTP 测试只替换运行时边界；真实 SQLite / RPC / CLI 链另由集成测试验证。
export function orchestrationRpcFixture(terminalRpc) {
  const runs = [],
    tasks = [],
    workers = [],
    messages = [],
    sessions = new Map()
  const shown = new Map()
  function seed({ handle, path, spec, from = 'fixture-coordinator', sessionId, owned = false }) {
    const session = [...sessions.values()].find((s) => s.sessionId === sessionId)
    const run = {
      id: `run_${randomUUID()}`,
      coordinator_handle: sessionId ? null : from,
      coordinatorAddress: session?.address ?? from,
      hivewardSession: session,
      status: 'active'
    }
    runs.push(run)
    const task = {
      id: `task_${randomUUID()}`,
      run_id: run.id,
      spec,
      status: 'dispatched',
      created_at: Date.now()
    }
    const dispatchId = `dispatch_${randomUUID()}`
    task.dispatch_id = dispatchId
    tasks.push(task)
    const worker = {
      taskId: task.id,
      dispatchId,
      runId: run.id,
      projection: { provider: { id: 'claude' }, liveness: { verdict: 'live' } }
    }
    workers.push(worker)
    shown.set(dispatchId, {
      dispatch: { id: dispatchId, assigneeHandle: handle, creatorAddress: run.coordinatorAddress },
      terminal: { handle },
      worker: { agentTerminalHandle: handle, startOptions: { agent: 'claude' } },
      owned,
      path
    })
    return { state: 'ready', runId: run.id, taskId: task.id, dispatchId }
  }
  function report(handle, body) {
    const worker = workers.findLast(
      (w) =>
        shown.get(w.dispatchId)?.terminal?.handle === handle &&
        tasks.find((t) => t.id === w.taskId).status === 'dispatched'
    )
    if (!worker) {
      return
    }
    const task = tasks.find((t) => t.id === worker.taskId)
    task.status = 'completed'
    task.completed_at = Date.now()
    messages.push({
      id: randomUUID(),
      run_id: worker.runId,
      from_handle: handle,
      type: 'worker_done',
      body,
      created_at: Date.now(),
      payload: JSON.stringify({
        taskId: task.id,
        dispatchId: worker.dispatchId,
        outcome: 'succeeded'
      })
    })
  }
  async function respond(request) {
    const { method, params = {}, hivewardSessionId } = request
    switch (method) {
      case 'orchestration.hivewardSessionRegister': {
        let row = sessions.get(params.key)
        if (!row) {
          const sessionId = `hiveward_${randomUUID()}`
          row = { sessionId, address: `hiveward_session_id:${sessionId}` }
        }
        Object.assign(row, { dispatcher: params.dispatcher, workspacePath: params.path })
        sessions.set(params.key, row)
        return row
      }
      case 'orchestration.runCurrent': {
        return { run: runs.find((r) => r.coordinatorAddress === params.from) ?? null }
      }
      case 'orchestration.runCreate': {
        const run = {
          id: `run_${randomUUID()}`,
          coordinatorAddress: params.from,
          coordinator_handle: params.from,
          objective: params.objective,
          created_at: Date.now()
        }
        runs.push(run)
        return { run }
      }
      case 'orchestration.workerKeepOpen': {
        for (const detail of shown.values()) {
          if (detail.terminal?.handle === params.terminal) {
            detail.keepOpen = params.keep
          }
        }
        return { keep: params.keep }
      }
      case 'orchestration.hivewardCrewShow': {
        const children = workers.filter(
          (w) => shown.get(w.dispatchId)?.dispatch.creatorAddress === params.party
        )
        return {
          status: 'ok',
          sections: {
            managedBy: [],
            managing: children.map((w) => ({
              partyKey: w.dispatchId,
              role: 'worker',
              label: w.taskId,
              agentKind: 'claude',
              status: 'working',
              openTarget: { kind: 'terminal', handle: shown.get(w.dispatchId)?.terminal?.handle }
            })),
            talkingWith: []
          }
        }
      }
      case 'orchestration.workerStart': {
        const agent = params.agent
        if (!['claude', 'kimi', 'codex', 'opencode'].includes(agent)) {
          throw new Error('unsupported agent')
        }
        const command = `${agent}${agent === 'opencode' ? ' --auto' : ''}${params.model ? ` --model '${params.model}'` : ''}`
        const { terminal } = await terminalRpc({
          method: 'terminal.create',
          params: { worktree: params.worktree, command, presentation: 'background' }
        })
        const receipt = seed({
          handle: terminal.handle,
          path: params.worktree.slice(5),
          spec: params.spec,
          from: params.from,
          sessionId: hivewardSessionId,
          owned: true
        })
        await terminalRpc({
          method: 'terminal.send',
          params: {
            terminal: terminal.handle,
            text: `${params.spec}\nhiwd orchestration send --type worker_done`,
            enter: true
          }
        })
        return receipt
      }
      case 'orchestration.runList':
        return { runs }
      case 'orchestration.taskList':
        return { tasks: tasks.filter((t) => t.run_id === params.run) }
      case 'orchestration.workerList':
        return { workers: workers.filter((w) => w.runId === params.run) }
      case 'orchestration.workerRead': {
        const detail = shown.get(params.dispatch)
        const message = messages.findLast(
          (m) =>
            JSON.parse(m.payload ?? '{}').dispatchId === params.dispatch && m.type === 'worker_done'
        )
        return {
          dispatchId: params.dispatch,
          source: 'transcript',
          sourceIdentity: `hiveward-fixture:${params.dispatch}`,
          provider: detail.worker.startOptions.agent,
          cursor: 'hiveward_fixture_end',
          transcript: {
            messages: message
              ? [
                  {
                    id: message.id,
                    role: 'assistant',
                    blocks: [{ type: 'text', text: message.body }],
                    timestamp: message.created_at
                  }
                ]
              : [],
            limited: false
          },
          fallbackReason: null,
          warnings: []
        }
      }
      case 'orchestration.workerShow':
        return shown.get(params.dispatch)
      case 'orchestration.gateList':
        return { gates: [] }
      case 'orchestration.inbox':
        return { messages }
      case 'orchestration.check': {
        const address =
          [...sessions.values()].find((s) => s.sessionId === hivewardSessionId)?.address ??
          params.terminal
        const runIds = runs.filter((r) => r.coordinatorAddress === address).map((r) => r.id)
        return { messages: messages.filter((m) => runIds.includes(m.run_id)) }
      }
      case 'orchestration.send': {
        if (params.to?.startsWith('dispatch:')) {
          const previousId = params.to.slice(9),
            previous = shown.get(previousId)
          const existing = tasks.find((t) => t.dispatch_id === previousId)
          if (existing?.status === 'dispatched') {
            const message = {
              id: randomUUID(),
              run_id: existing.run_id,
              from_handle: params.from,
              to_handle: params.to,
              type: 'status',
              body: params.body,
              created_at: Date.now(),
              payload: JSON.stringify({ dispatchId: previousId })
            }
            messages.push(message)
            await terminalRpc({
              method: 'terminal.send',
              params: {
                terminal: previous.terminal.handle,
                text: params.body,
                enter: true,
                agentPrompt: true
              }
            })
            return { message }
          }
          const receipt = seed({
            handle: previous.terminal.handle,
            path: previous.path,
            spec: params.body,
            from: params.from,
            sessionId: hivewardSessionId,
            owned: previous.owned
          })
          shown.get(receipt.dispatchId).dispatch.followUpOf = previousId
          return receipt
        }
        const message = {
          id: randomUUID(),
          run_id: params.to.slice(4),
          from_handle: params.from,
          type: params.type,
          body: params.body,
          payload: params.payload,
          created_at: Date.now()
        }
        messages.push(message)
        return { messageId: message.id }
      }
      case 'orchestration.workerRelease':
      case 'orchestration.workerStop': {
        const detail = shown.get(params.dispatch)
        if (detail.owned && !detail.keepOpen) {
          await terminalRpc({
            method: 'terminal.close',
            params: { terminal: detail.terminal.handle }
          })
          detail.terminal = null
        }
        return { state: detail.owned && !detail.keepOpen ? 'released' : 'retained' }
      }
      default:
        return terminalRpc(request)
    }
  }
  return { respond, seed, report, tasks, shown, sessions, messages }
}

export function fixtureRpcConnection(socket, respond) {
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      Promise.resolve()
        .then(() => respond(request))
        .then(
          (result) =>
            socket.write(
              `${JSON.stringify({ id: request.id, ok: result !== undefined, result })}\n`
            ),
          (error) =>
            socket.write(
              `${JSON.stringify({ id: request.id, ok: false, error: { code: error.code ?? 'invalid_params', message: error.message } })}\n`
            )
        )
    }
  })
}

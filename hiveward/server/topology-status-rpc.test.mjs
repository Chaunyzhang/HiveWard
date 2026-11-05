import {
  orchestrationRpcFixture,
  fixtureRpcConnection
} from './tests/orchestration-rpc-fixture.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'

test('停掉 / 放弃的派单不挂在线下属，也不进待决策', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'hiveward-topology-rpc-'))
  const data = join(root, 'data')
  await Promise.all([mkdir(data), mkdir(join(root, 'business'))])
  const workspace = await realpath(join(root, 'business'))
  const now = new Date().toISOString()
  await writeFile(
    join(data, 'businesses.json'),
    JSON.stringify([
      {
        id: 'business',
        name: '业务',
        nameSource: 'user',
        workspacePath: workspace,
        status: 'active',
        priority: 2,
        leaderAgent: 'claude',
        ceo: {
          terminal: 'term_ceo_closed',
          occupant: { kind: 'terminal', terminal: 'term_ceo_closed' },
          agent: 'claude',
          liveness: 'live',
          state: 'idle'
        },
        runIds: [],
        updatedAt: now
      }
    ])
  )
  await writeFile(
    join(data, 'dispatches.json'),
    JSON.stringify([
      {
        id: 'legacy_open',
        prompt: '升级前的旧任务',
        status: 'dispatched',
        by: { kind: 'cli', id: 'old' }
      }
    ])
  )

  const terminals = []
  const repos = [{ id: 'repo', path: workspace, displayName: '业务', kind: 'folder' }]
  const respond = ({ method }) => {
    switch (method) {
      case 'notifications.getMissedSince':
        return { epoch: 'topology-status', notifications: [] }
      case 'repo.list':
        return { repos }
      case 'repo.update':
        return {}
      case 'status.get':
        return { appVersion: 'stub', graphStatus: 'ready' }
      case 'terminal.list':
        return { terminals }
      case 'terminal.agentStatus':
        return { agentStatus: { isRunningAgent: true, status: 'idle' } }
      case 'terminal.inspectProcess':
        return { process: { hasChildProcesses: true } }
      case 'terminal.read':
        return { terminal: { tail: ['fixture'], status: 'running' } }
      case 'worktree.list':
        return { worktrees: [] }
      default:
        return undefined
    }
  }

  const socketPath = join(root, 'runtime.sock')
  const engine = orchestrationRpcFixture(respond)
  const sockets = new Set()
  const runtime = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    fixtureRpcConnection(socket, engine.respond)
  })
  runtime.listen(socketPath)
  await once(runtime, 'listening')
  const meta = join(root, 'runtime.json')
  await writeFile(
    meta,
    JSON.stringify({ authToken: 'test', transports: [{ kind: 'unix', endpoint: socketPath }] })
  )
  const previous = {
    data: process.env.HIVEWARD_DATA_DIR,
    runtime: process.env.HIVEWARD_RUNTIME_META,
    owner: process.env.HIVEWARD_OWNER_MAILBOX
  }
  process.env.HIVEWARD_DATA_DIR = data
  process.env.HIVEWARD_RUNTIME_META = meta
  process.env.HIVEWARD_OWNER_MAILBOX = 'hiveward-owner'
  const { startBridge } = await import('./hiveward-bridge.mjs')
  const { invalidate } = await import('./orchestration.mjs')
  const { closeRuntimeConnection } = await import('./hiveward-client.mjs')
  const guard = {
    assertAllowed: async () => {},
    beforeRpc: async () => {},
    observe: async () => {},
    warnings: () => [],
    status: async () => ({})
  }
  const server = await startBridge({ port: 0, lanPort: false, regionGuard: guard })
  const base = `http://127.0.0.1:${server.address().port}`
  const api = async (path) => {
    const response = await fetch(base + path)
    return await response.json()
  }

  try {
    const handle = 'term_stopped_worker'
    const receipt = engine.seed({
      handle,
      path: workspace,
      spec: 'S3 停掉的任务',
      from: 'hiveward-owner'
    })
    terminals.push({ handle, worktreePath: workspace, agent: 'claude' })
    engine.tasks.find((task) => task.id === receipt.taskId).status = 'blocked'
    const shown = engine.shown.get(receipt.dispatchId)
    shown.worker.state = 'stopped'
    shown.dispatch.lastFailure = 'stopped'
    engine.messages.push({
      id: 'msg_stopped_question',
      run_id: receipt.runId,
      from_handle: handle,
      to_handle: 'hiveward-owner',
      type: 'escalation',
      subject: 'Blocked: 需要确认',
      body: '停掉之后留下的提问',
      created_at: Date.now(),
      payload: JSON.stringify({ taskId: receipt.taskId, dispatchId: receipt.dispatchId })
    })

    invalidate()
    const tasks = Object.values(await api('/api/tasks'))
    assert.equal(tasks.find((task) => task.id === receipt.taskId).status, 'failed')
    const legacy = tasks.find((task) => task.id === 'legacy_open')
    assert.equal(legacy.historical, true)
    assert.equal(legacy.status, 'failed')
    invalidate()
    const pending = Object.values(await api('/api/decisions?state=pending'))
    assert.equal(
      pending.some((decision) => decision.id === 'msg_stopped_question'),
      false
    )
    invalidate()
    const overview = await api('/api/overview')
    assert.equal(overview.decisionsPending, 0)
    invalidate()
    const nodes = (await api('/api/topology')).nodes
    assert.equal(
      nodes.some((node) => node.kind === 'worker'),
      false
    )
    assert.equal(nodes.find((node) => node.id === 'ceo:business').state, 'offline')
    assert.equal(nodes.find((node) => node.id === 'business:business').attention, false)
  } finally {
    closeRuntimeConnection()
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise((resolve) => runtime.close(resolve))
    for (const [key, value] of [
      ['HIVEWARD_DATA_DIR', previous.data],
      ['HIVEWARD_RUNTIME_META', previous.runtime],
      ['HIVEWARD_OWNER_MAILBOX', previous.owner]
    ]) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    await rm(root, { recursive: true, force: true })
  }
})

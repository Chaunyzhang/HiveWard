import {
  orchestrationRpcFixture,
  fixtureRpcConnection
} from './tests/orchestration-rpc-fixture.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:net'

test(
  'boss launches workers from the topology: owner-only, project / business placement',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp('/tmp/hiveward-worker-launch-')
    const data = join(root, 'data'),
      workspace = join(root, 'business'),
      build = join(workspace, 'build')
    await Promise.all([mkdir(data), mkdir(workspace)])
    await mkdir(build)
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
          updatedAt: now
        }
      ])
    )
    const terminals = []
    const repos = [{ id: 'b', path: workspace, displayName: '业务', kind: 'folder' }]
    const notifications = []
    const mutations = [],
      sockets = new Set()
    const respond = ({ method, params = {} }) => {
      switch (method) {
        case 'notifications.getMissedSince':
          return { epoch: 'projects', notifications }
        case 'repo.list':
          return { repos }
        case 'repo.add': {
          const repo = { id: `r${repos.length}`, ...params }
          repos.push(repo)
          return { repo }
        }
        case 'repo.update':
          return {}
        case 'status.get':
          return { appVersion: 'stub', graphStatus: 'ready' }
        case 'terminal.list':
          return { terminals }
        case 'terminal.inspectProcess':
          return { process: { hasChildProcesses: true } }
        case 'terminal.agentStatus':
          return { agentStatus: { isRunningAgent: true, status: 'idle' } }
        case 'terminal.create': {
          mutations.push({ method, params })
          const terminal = {
            handle: `t${terminals.length}`,
            agentIdentity: 'claude',
            worktreePath: params.worktree.slice(5)
          }
          terminals.push(terminal)
          return { terminal }
        }
        case 'terminal.close':
        case 'terminal.send':
          mutations.push({ method, params })
          return {}
        case 'worktree.list':
          return { worktrees: [] }
        case 'orchestration.runList':
          return { runs: [] }
        case 'orchestration.inbox':
          return { messages: [] }
        default:
          return undefined
      }
    }
    const socketPath = join(root, 'runtime.sock')
    const engine = orchestrationRpcFixture(respond)
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
      JSON.stringify({
        authToken: 'test',
        transports: [{ kind: 'unix', endpoint: socketPath }]
      })
    )
    process.env.HIVEWARD_DATA_DIR = data
    process.env.HIVEWARD_RUNTIME_META = meta
    const { startBridge } = await import('./hiveward-bridge.mjs')
    const { invalidate } = await import('./orchestration.mjs')
    const { closeRuntimeConnection } = await import('./hiveward-client.mjs')
    let blocked = false
    const guard = {
      assertAllowed: async () => {
        if (blocked) {
          throw Object.assign(new Error('exit_region_blocked test'), {
            status: 403,
            code: 'exit_region_blocked'
          })
        }
      },
      beforeRpc: async () => {},
      observe: async () => {},
      warnings: () => [],
      status: async () => ({})
    }
    const server = await startBridge({
      port: 0,
      lanPort: false,
      regionGuard: guard
    })
    const base = `http://127.0.0.1:${server.address().port}`
    const api = async (path, body, method, headers = {}) => {
      const r = await fetch(base + path, {
        method: method ?? (body ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined
      })
      const result = await r.json()
      return { status: r.status, ...result }
    }
    try {
      const project = (
        await api('/api/businesses/business/projects', {
          name: '构建',
          dir: 'build'
        })
      ).project
      assert.ok(project?.id)
      const creates = () => mutations.filter((m) => m.method === 'terminal.create')
      const createdIn = () => realpathSync(creates().at(-1).params.worktree.slice(5))

      const direct = await api('/api/businesses/business/workers', {
        agent: 'kimi',
        prompt: '整理一下业务目录'
      })
      assert.equal(direct.status, 200, JSON.stringify(direct))
      assert.equal(createdIn(), realpathSync(workspace))
      const inProject = await api('/api/businesses/business/workers', {
        agent: 'claude',
        prompt: '把构建脚本跑一遍',
        projectId: project.id
      })
      assert.equal(inProject.status, 200, JSON.stringify(inProject))
      assert.equal(createdIn(), realpathSync(build))
      console.log(
        `ACCEPT owner launches: ${direct.terminal} @ business, ${inProject.terminal} @ project`
      )

      invalidate()
      const tasks = await api('/api/tasks')
      for (const id of [direct.taskId, inProject.taskId]) {
        const task = Object.values(tasks).find((t) => t?.id === id)
        assert.equal(task?.dispatchedBy?.kind, 'owner', `task ${id}`)
      }
      invalidate()
      const nodes = (await api('/api/topology')).nodes
      assert.equal(nodes.find((n) => n.terminal === direct.terminal)?.parentId, 'ceo:business')
      assert.equal(
        nodes.find((n) => n.terminal === inProject.terminal)?.parentId,
        `leader:${project.id}`
      )
      console.log('ACCEPT topology: business worker → CEO, project worker → project')

      const ceo = await api('/api/businesses/business/ceo', { agent: 'claude' })
      const leader = await api(`/api/businesses/business/projects/${project.id}/leader`, {
        agent: 'claude'
      })
      for (const [coordinator, from, projectId] of [
        ['ceo', ceo.terminal, undefined],
        ['leader', leader.terminal, project.id]
      ]) {
        const count = creates().length
        const child = await api('/api/businesses/business/workers', {
          agent: 'claude',
          prompt: '节点下派单',
          coordinator,
          projectId
        })
        assert.equal(child.status, 200, JSON.stringify(child))
        assert.deepEqual(child.identity, { address: from })
        assert.equal(engine.shown.get(child.dispatchId).dispatch.creatorAddress, from)
        assert.equal(creates().length, count + 1)
      }
      const ownerWithSeats = await api('/api/businesses/business/workers', {
        agent: 'claude',
        prompt: '老板仍走自己的邮箱'
      })
      assert.equal(ownerWithSeats.identity.sessionId, direct.identity.sessionId)
      assert.notEqual(ownerWithSeats.identity.address, ceo.terminal)
      assert.notEqual(ownerWithSeats.identity.address, leader.terminal)
      console.log('ACCEPT CEO / Leader 节点精确使用座位终端；老板直派即使有座位也用独立 session')

      const at = terminals.findIndex((t) => t.handle === leader.terminal)
      const [closedSeat] = terminals.splice(at, 1)
      const offlineSeat = await api('/api/businesses/business/workers', {
        agent: 'claude',
        prompt: '座位离线时节点下派单',
        coordinator: 'leader',
        projectId: project.id
      })
      terminals.splice(at, 0, closedSeat)
      assert.equal(offlineSeat.status, 200, JSON.stringify(offlineSeat))
      assert.equal(offlineSeat.identity.sessionId, direct.identity.sessionId)
      assert.notEqual(offlineSeat.identity.address, leader.terminal)
      console.log('ACCEPT Leader 座位终端关了：记在老板名下派，不拿关掉的终端派单')

      const before = creates().length
      const agent = await api(
        '/api/businesses/business/workers',
        { agent: 'claude', prompt: '冒充老板' },
        'POST',
        { 'x-hiveward-caller': 'agent', 'x-hiveward-dispatcher-id': 'term_x' }
      )
      assert.equal(agent.status, 403)
      for (const bad of [
        { agent: 'claude', prompt: '   ' },
        { agent: 'gpt', prompt: '做事' },
        { agent: 'claude', prompt: '做事', projectId: 'nope' }
      ]) {
        const r = await api('/api/businesses/business/workers', bad)
        assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(r))
        console.log(`ACCEPT reject ${JSON.stringify(bad)} → ${r.status} ${r.error?.message}`)
      }
      blocked = true
      assert.equal(
        (
          await api('/api/businesses/business/workers', {
            agent: 'claude',
            prompt: '做事'
          })
        ).status,
        403
      )
      blocked = false
      assert.equal(creates().length, before)
      console.log(
        'ACCEPT agent caller 403, bad input 4xx, exit region blocked; no terminal created'
      )
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
      await rm(root, { recursive: true, force: true })
    }
  }
)

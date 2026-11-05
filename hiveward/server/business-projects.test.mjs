import {
  orchestrationRpcFixture,
  fixtureRpcConnection
} from './tests/orchestration-rpc-fixture.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { runProcess } from '@hiveward/process-host'
import { pathKey } from './workspace-path.mjs'

test(
  'business projects: isolated HTTP, migration, ownership, guard and real CLI',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'hiveward-projects-'))
    const data = join(root, 'data'),
      workspace = join(root, 'business'),
      old = join(root, 'legacy')
    await Promise.all([mkdir(data), mkdir(workspace), mkdir(old)])
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
        },
        {
          id: 'legacy',
          name: '旧业务',
          nameSource: 'user',
          workspacePath: old,
          status: 'active',
          priority: 2,
          leaderAgent: 'claude',
          updatedAt: now
        }
      ])
    )
    await writeFile(
      join(data, 'dispatches.json'),
      JSON.stringify([
        {
          id: 'old-dispatch',
          handle: 'old-leader',
          role: 'leader',
          project: old,
          agent: 'claude',
          prompt: '旧任务',
          by: { kind: 'owner', id: 'hiveward-owner', label: '老板' },
          at: now,
          status: 'completed'
        }
      ])
    )
    const terminals = [{ handle: 'old-leader', agentIdentity: 'claude', worktreePath: old }]
    const repos = [
      { id: 'b', path: workspace, displayName: '业务', kind: 'folder' },
      { id: 'l', path: old, displayName: '旧业务', kind: 'folder' }
    ]
    const notifications = []
    const mutations = [],
      sockets = new Set()
    const agentStatusFailures = new Map()
    let agentStatusState = 'idle'
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
          if (agentStatusFailures.has(params.terminal)) {
            throw Object.assign(new Error(agentStatusFailures.get(params.terminal)), {
              code: agentStatusFailures.get(params.terminal)
            })
          }
          return { agentStatus: { isRunningAgent: true, status: agentStatusState } }
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
    const socketPath =
      process.platform === 'win32'
        ? String.raw`\\.\pipe\hiveward-business-projects-${process.pid}`
        : join(root, 'runtime.sock')
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
      JSON.stringify({ authToken: 'test', transports: [{ kind: 'unix', endpoint: socketPath }] })
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
    const server = await startBridge({ port: 0, lanPort: false, regionGuard: guard })
    const base = `http://127.0.0.1:${server.address().port}`
    const api = async (path, body, method) => {
      const r = await fetch(base + path, {
        method: method ?? (body ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      })
      const result = await r.json()
      return { status: r.status, ...result }
    }
    const cli = async (...args) => {
      const r = await runProcess({
        program: process.execPath,
        args: ['hiveward/server/hiwd.mjs', ...args],
        env: { ...process.env, HIVEWARD_BRIDGE: base, HIVEWARD_DISPATCHER: 'cli:test' },
        timeoutMs: 15000
      })
      console.log(`ACCEPT hiwd ${args.join(' ')}\n${r.stdout}${r.stderr}`)
      return r
    }
    try {
      const overview = await api('/api/overview')
      const migrated = overview.businesses.find((b) => b.id === 'legacy').projects
      assert.equal(migrated.length, 1)
      assert.equal(migrated[0].name, '主线')
      assert.equal(migrated[0].leader.terminal, 'old-leader')
      assert.deepEqual(mutations, [])
      invalidate()
      await api('/api/overview')
      assert.deepEqual(mutations, [])
      console.log(
        'ACCEPT migration 主线 → old-leader; terminal mutations = 0; reentrant = 1 project'
      )
      const a = (
        await api('/api/businesses/business/projects', {
          name: '运营',
          agent: 'claude'
        })
      ).project
      const b = (
        await api('/api/businesses/business/projects', {
          name: '构建',
          dir: 'build',
          agent: 'claude'
        })
      ).project
      assert.ok(a.leader, JSON.stringify(a))
      assert.ok(b.leader)
      await api(`/api/businesses/business/projects/${a.id}/leader`, {
        agent: 'claude',
        prompt: '运营任务'
      })
      await api(`/api/businesses/business/projects/${b.id}/leader`, {
        agent: 'claude',
        prompt: '构建任务'
      })
      assert.ok(engine.tasks.some((t) => t.spec.includes('项目目录')))
      agentStatusFailures.set(b.leader.terminal, 'terminal_gone')
      agentStatusState = 'working'
      invalidate()
      const resilient = await api('/api/businesses/business')
      assert.equal(resilient.status, 200, JSON.stringify(resilient))
      assert.equal(resilient.business.projects.find((p) => p.id === a.id).leader.state, 'working')
      assert.ok(resilient.business.projects.find((p) => p.id === b.id).leader)
      const { observeTerminal } = await import('./business-terminals.mjs')
      const observed = await observeTerminal(terminals.find((t) => t.handle === b.leader.terminal))
      assert.equal(observed.agentStatus, undefined)
      agentStatusFailures.clear()
      agentStatusState = 'idle'
      invalidate()
      console.log('ACCEPT terminal_gone: 业务详情照常返回，断开终端的 agentStatus 为空')
      await symlink(
        root,
        join(workspace, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      for (const dir of ['../x', root, 'escape/out']) {
        const r = await api('/api/businesses/business/projects', { name: dir, dir })
        assert.equal(r.status, 400, JSON.stringify(r))
        console.log(`ACCEPT dir ${dir}: ${r.status} ${r.error.message}`)
      }
      assert.equal((await api('/api/businesses/business/projects', { name: '运营' })).status, 409)
      const assign = async (handle, path, projectId, byId) => {
        terminals.push({ handle, worktreePath: path, agentIdentity: 'claude' })
        engine.seed({ handle, path, spec: `任务 ${handle}`, from: byId ?? 'cli' })
        if (projectId) {
          const { bindProjectTerminal } = await import('./business-projects.mjs')
          bindProjectTerminal(handle, projectId)
        }
        invalidate()
      }
      await assign('worker-a', workspace, a.id)
      await assign('worker-b', b.path, undefined, b.leader.terminal)
      await assign('worker-tree', workspace, undefined, 'worker-b')
      await assign('worker-deep', b.path)
      const topology = await api('/api/topology')
      assert.equal(
        topology.nodes.filter((n) => n.kind === 'leader' && n.businessId === 'business').length,
        2
      )
      for (const [handle, p] of [
        ['worker-a', a],
        ['worker-b', b],
        ['worker-tree', b],
        ['worker-deep', b]
      ]) {
        const node = topology.nodes.find((n) => n.terminal === handle)
        const nativeParent =
          handle === 'worker-tree'
            ? topology.nodes.find((n) => n.terminal === 'worker-b').id
            : `leader:${p.id}`
        assert.equal(node.parentId, nativeParent)
      }
      console.log(
        'ACCEPT topology: two leaders; explicit / dispatch tree / deepest directory ownership correct'
      )
      terminals.push({ handle: 'manual-root-kimi', worktreePath: workspace, agentIdentity: 'kimi' })
      await assign('worker-a-tree', workspace, undefined, a.leader.terminal)
      invalidate()
      const rootRegression = await api('/api/topology')
      const manualRoot = rootRegression.nodes.find((n) => n.terminal === 'manual-root-kimi')
      assert.equal(manualRoot, undefined, '没有编排 Task 的手开终端不投影为下属')
      assert.equal(rootRegression.nodes.find((n) => n.terminal === 'worker-a').projectId, a.id)
      assert.equal(rootRegression.nodes.find((n) => n.terminal === 'worker-a-tree').projectId, a.id)
      assert.equal(rootRegression.nodes.find((n) => n.terminal === 'worker-deep').projectId, b.id)
      console.log(
        'ACCEPT root directory regression: 手开终端不冒充 Worker; explicit/tree → no-dir project; subdirectory → dir project'
      )
      const empty = await api('/api/businesses', { path: join(root, 'data'), name: '未归业务' })
      assert.equal(empty.business.lastEvent.title, '业务加入：未归业务')
      assert.equal(
        (await api(`/api/businesses/${empty.business.id}/logo`)).error.message,
        '业务没有可识别的 logo'
      )
      await assign('unassigned', data)
      const unassigned = (await api('/api/topology')).nodes.find((n) => n.terminal === 'unassigned')
      assert.equal(unassigned.parentId, `leader:${empty.business.id}:unassigned`)
      console.log('ACCEPT unassigned → 未归项目')
      const count = mutations.filter((m) => m.method === 'terminal.create').length
      await api(`/api/businesses/business/projects/${a.id}/leader`, {
        agent: 'codex',
        prompt: '追加'
      })
      assert.equal(mutations.filter((m) => m.method === 'terminal.create').length, count)
      await api(`/api/businesses/business/projects/${a.id}/leader`, {
        agent: 'claude',
        replace: true
      })
      assert.equal(mutations.filter((m) => m.method === 'terminal.create').length, count + 1)
      assert.ok(terminals.some((t) => t.handle === a.leader.terminal))
      blocked = true
      const denied = await api('/api/businesses/business/projects', {
        name: '地区限制',
        agent: 'claude'
      })
      assert.equal(denied.leaderError.code, 'exit_region_blocked')
      assert.equal(denied.project.leader, null)
      console.log(`ACCEPT exit blocked: ${JSON.stringify(denied)}`)
      blocked = false
      const cliDenied = await cli('projects', 'new', '业务', 'CLI项目', '--dir', 'cli')
      assert.equal(cliDenied.code, 1)
      assert.match(cliDenied.stderr, /项目由 CEO 增减/)
      assert.equal(
        (await api('/api/businesses/business/projects', { name: 'CLI项目', dir: 'cli' })).status,
        200
      )
      assert.equal((await cli('assign', '业务/运营', 'CLI派单')).code, 0)
      assert.equal((await cli('assign', '业务', '模糊派单')).code, 1)
      assert.equal((await cli('projects')).code, 0)
      const solo = await api('/api/businesses/data/projects', { name: '单项目' })
      await api(`/api/businesses/data/projects/${solo.project.id}/leader`, { agent: 'claude' })
      assert.equal((await cli('assign', '未归业务', '单项目自动选择')).code, 0)
      assert.equal((await cli('new', workspace, 'claude', '--project', b.id, 'CLI 派单')).code, 0)
      const latestTerminal = terminals.at(-1)
      assert.equal(pathKey(latestTerminal.worktreePath), pathKey(b.path))
      invalidate()
      assert.equal(
        (await api('/api/topology')).nodes.find((n) => n.terminal === latestTerminal.handle)
          .projectId,
        b.id
      )
      assert.equal(solo.project.leader, null)
      const viaTerminal = await api('/api/hiveward/terminals', {
        project: workspace,
        projectId: solo.project.id,
        role: 'leader',
        agent: 'claude'
      })
      assert.equal(viaTerminal.status, 200)
      assert.equal(
        (await api(`/api/businesses/data/projects`)).projects[0].leader.terminal,
        viaTerminal.handle
      )
      console.log('ACCEPT terminal create role=leader binds project Leader Agent')
      const leaderTerminal = terminals.find((t) => t.handle === b.leader.terminal)
      leaderTerminal.paneKey = 'project-pane'
      notifications.push({
        type: 'notification',
        source: 'agent-task-complete',
        agentState: 'done',
        paneKey: 'project-pane',
        notificationSeq: 1,
        emittedAt: new Date().toISOString(),
        title: '构建完成'
      })
      invalidate()
      const completedTimeline = await api(`/api/timeline?projectId=${b.id}`)
      assert.ok(
        !completedTimeline.items.some((e) => e.title === 'Agent 一轮干完：构建完成'),
        'hook 不能充当编排交活'
      )
      const overviewWithCounts = await api('/api/overview')
      const summary = overviewWithCounts.businesses
        .find((x) => x.id === 'business')
        .projects.find((p) => p.id === b.id)
      assert.equal(summary.counts.workersLive, 4)
      assert.ok(summary.counts.dispatches >= 4)
      assert.ok(summary.leader.native.runId)
      assert.equal(summary.leader.crew.status, 'ok')
      const timeline = await api(`/api/timeline?projectId=${a.id}`)
      assert.ok(timeline.items.length > 1)
      assert.ok(timeline.items.every((e) => e.projectId === a.id))
      const tasks = await fetch(`${base}/api/tasks?projectId=${b.id}`).then((r) => r.json())
      assert.ok(tasks.length >= 3)
      assert.ok(tasks.every((t) => t.projectId === b.id))
      const sendsBefore = mutations.filter((m) => m.method === 'terminal.send').length
      const queued = await api('/api/businesses/business/projects', {
        name: '首句失败回归',
        agent: 'kimi',
        prompt: '异步首句'
      })
      assert.equal(queued.status, 200)
      assert.ok(queued.project.leader.native.dispatchId)
      assert.equal(queued.project.leader.model, 'kimi-code/k3.1-pro')
      assert.ok(mutations.filter((m) => m.method === 'terminal.send').length > sendsBefore)
      assert.ok(engine.tasks.some((t) => t.spec.includes('异步首句')))
      console.log('ACCEPT 座位首句随原生 workerStart 前言投递，不再排自家队列')
      for (const agent of ['kimi', 'claude', 'codex']) {
        const modelLaunch = await api('/api/hiveward/terminals', {
          project: workspace,
          agent,
          model: 'explicit-model'
        })
        assert.equal(modelLaunch.status, 200)
        assert.match(
          mutations.findLast((m) => m.method === 'terminal.create').params.command,
          /--model 'explicit-model'/
        )
        const modelProject = (
          await api('/api/businesses/business/projects', { name: `model-${agent}` })
        ).project
        const modelLeader = await api('/api/hiveward/terminals', {
          project: workspace,
          projectId: modelProject.id,
          role: 'leader',
          agent,
          model: 'leader-model'
        })
        assert.equal(modelLeader.status, 200)
        assert.match(
          mutations.findLast((m) => m.method === 'terminal.create').params.command,
          /--model 'leader-model'/
        )
      }
      console.log(
        'ACCEPT HTTP models: Kimi default K3.1 Pro; kimi/claude/codex explicit models preserved for workers and leaders'
      )
      // OpenCode 下属：hiwd new 直接开，带 --model；不能坐 Leader 位
      const openCodeNew = await cli(
        'new',
        workspace,
        'opencode',
        '--model',
        'opencode-go/deepseek-v4.1-flash',
        '离线 OpenCode 任务'
      )
      assert.equal(openCodeNew.code, 0, openCodeNew.stderr)
      assert.match(openCodeNew.stdout, /已派 opencode/)
      assert.equal(
        mutations.findLast((m) => m.method === 'terminal.create').params.command,
        "opencode --auto --model 'opencode-go/deepseek-v4.1-flash'"
      )
      const openCodeLeaderProject = (
        await api('/api/businesses/business/projects', { name: 'model-opencode' })
      ).project
      const openCodeLeader = await api('/api/hiveward/terminals', {
        project: workspace,
        projectId: openCodeLeaderProject.id,
        role: 'leader',
        agent: 'opencode'
      })
      assert.equal(openCodeLeader.status, 400)
      const unknownAgent = await cli('new', workspace, 'unconfigured-agent', '未知 Agent')
      assert.equal(unknownAgent.code, 1)
      assert.match(unknownAgent.stderr, /unsupported agent/)
      const renamed = await api(
        `/api/businesses/business/projects/${b.id}`,
        { name: '开发' },
        'PATCH'
      )
      assert.equal(renamed.project.name, '开发')
      const archivable = await api('/api/businesses/business/projects', {
        name: '空项目归档',
        agent: 'claude'
      })
      engine.report(archivable.project.leader.terminal, '空项目初始化完成')
      invalidate()
      const initialized = engine.tasks.findLast(
        (task) =>
          engine.shown.get(task.dispatch_id)?.terminal?.handle ===
          archivable.project.leader.terminal
      )
      await api(`/api/tasks/${initialized.id}/review`, { verdict: 'accept' })
      const archived = await api(
        `/api/businesses/business/projects/${archivable.project.id}`,
        { status: 'archived' },
        'PATCH'
      )
      assert.equal(archived.project.status, 'archived', JSON.stringify(archived))
      assert.ok(terminals.some((t) => t.handle === archivable.project.leader.terminal))
      assert.equal((await api('/api/projects', { path: root })).status, 404)
      assert.equal((await api('/api/businesses/business/leader', {})).status, 404)
      assert.equal((await api('/api/businesses/business/leader/screen')).status, 404)
      console.log('ACCEPT filters / rename / archive / replacement / removed routes passed')
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

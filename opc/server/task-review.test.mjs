/* oxlint-disable max-lines -- one isolated review lifecycle reuses one runtime and data directory. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import * as path from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

async function dispatchFixture(t) {
  const root = await mkdtemp('/tmp/opc-review-state-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const chats = {}
  const context = vm.createContext({ process: { pid: process.pid } })
  const modules = {
    './business-projects.mjs': {
      businessProjects: () => [],
      projectOf: () => undefined,
      getProject: () => undefined
    },
    './data-dir.mjs': { dataDir: () => root },
    'node:path': path,
    'node:fs': fs,
    'node:crypto': await import('node:crypto'),
    './api-runtime.mjs': {
      optionalRpc: async () => ({ agentStatus: { isRunningAgent: true, status: 'idle' } })
    },
    './business.mjs': {
      badRequest: (message) => Object.assign(new Error(message), { status: 400 }),
      apiError: (status, code, message) => Object.assign(new Error(message), { status, code })
    },
    './business-terminals.mjs': {
      observeTerminal: async (terminal) => ({
        pid: terminal.handle,
        agent: 'claude',
        startedAt: new Date().toISOString()
      })
    },
    './transcripts.mjs': {
      locate: async ({ pid }) => ({ agent: 'claude', path: pid }),
      readChat: (_agent, file) => chats[file] ?? [],
      readTurnState: () => 'completed'
    },
    './confirmations.mjs': { issueConfirmation: () => 'confirm-test' },
    './screen-menu.mjs': { screenMenu: () => null, chooseMenu: async () => ({}) }
  }
  const source = new vm.SourceTextModule(
    await readFile(new URL('./dispatches.mjs', import.meta.url), 'utf8'),
    { context }
  )
  await source.link((specifier) => {
    const exports = modules[specifier]
    if (!exports) {
      throw new Error(`Unexpected module: ${specifier}`)
    }
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) {
          this.setExport(name, value)
        }
      },
      { context }
    )
  })
  await source.evaluate()
  return { root, chats, api: source.namespace }
}

test('派单回话进入复核，rework 只认新回话，blocked 与旧任务不追溯', async (t) => {
  const f = await dispatchFixture(t)
  const now = new Date().toISOString()
  await writeFile(
    join(f.root, 'dispatches.json'),
    JSON.stringify([
      {
        id: 'dsp-old',
        handle: 'old',
        project: f.root,
        prompt: '旧任务',
        by: { kind: 'cli', id: 'old', label: '旧派单方' },
        at: now,
        status: 'completed',
        report: { summary: '旧汇报', reportedAt: now }
      }
    ])
  )
  const created = f.api.recordDispatch({
    handle: 'worker',
    project: f.root,
    agent: 'claude',
    prompt: '实现复核',
    by: { kind: 'cli', id: 'leader-a', label: 'Leader A' }
  })
  const blocked = f.api.recordDispatch({
    handle: 'blocked',
    project: f.root,
    agent: 'claude',
    prompt: '需要确认的任务',
    by: { kind: 'owner', id: 'opc-owner', label: '老板' }
  })
  f.chats.worker = [
    { kind: 'user', text: '实现复核' },
    { kind: 'assistant', text: '第一版完成', ts: now }
  ]
  f.chats.blocked = [
    { kind: 'user', text: '需要确认的任务' },
    { kind: 'assistant', text: '【需要确认】是否继续', ts: now }
  ]
  const listed = [{ handle: 'worker' }, { handle: 'blocked' }]
  await f.api.observeDispatches(listed)
  let rows = f.api.dispatches()
  let worker = rows.find((row) => row.id === created.id)
  assert.equal(worker.status, 'completed')
  assert.equal(worker.review.state, 'awaiting')
  assert.equal(worker.review.reviewer, 'dispatcher')
  assert.equal(worker.review.round, 1)
  assert.equal(rows.find((row) => row.id === blocked.id).status, 'blocked')
  assert.equal(rows.find((row) => row.id === blocked.id).review, undefined)
  assert.equal(rows.find((row) => row.id === 'dsp-old').review, undefined)

  const answered = await f.api.answerDispatch(blocked.id, '继续', async () => {})
  f.chats.blocked.push(
    { kind: 'user', text: '老板答复：继续' },
    { kind: 'assistant', text: '确认后完成', ts: new Date().toISOString() }
  )
  await f.api.observeDispatches(listed)
  rows = f.api.dispatches()
  assert.equal(rows.find((row) => row.id === blocked.id).review, undefined)
  assert.equal(rows.find((row) => row.id === answered.id).review.state, 'awaiting')
  assert.equal(rows.find((row) => row.id === answered.id).review.reviewer, 'owner')

  f.api.markDispatchRework(created.id, '补上测试', {
    kind: 'agent',
    id: 'leader-a',
    label: 'Leader A'
  })
  await f.api.observeDispatches(listed)
  worker = f.api.dispatches().find((row) => row.id === created.id)
  assert.equal(worker.status, 'dispatched')
  assert.equal(worker.review.state, 'rework')
  assert.equal(worker.review.round, 2)
  assert.equal(worker.report, undefined)

  f.chats.worker.push(
    { kind: 'user', text: '复核没通过：补上测试' },
    { kind: 'assistant', text: '第二版已补测试', ts: new Date().toISOString() }
  )
  await f.api.observeDispatches(listed)
  worker = f.api.dispatches().find((row) => row.id === created.id)
  assert.equal(worker.status, 'completed')
  assert.equal(worker.review.state, 'awaiting')
  assert.equal(worker.review.round, 2)
  assert.equal(worker.report.summary, '第二版已补测试')

  f.api.markDispatchRework(created.id, '补上测试', {
    kind: 'agent',
    id: 'leader-a',
    label: 'Leader A'
  })
  await f.api.observeDispatches(listed)
  worker = f.api.dispatches().find((row) => row.id === created.id)
  assert.equal(worker.status, 'dispatched')
  assert.equal(worker.review.round, 3)
  f.chats.worker.push(
    { kind: 'user', text: '复核没通过：补上测试' },
    { kind: 'assistant', text: '第三版完成', ts: new Date().toISOString() }
  )
  await f.api.observeDispatches(listed)
  worker = f.api.dispatches().find((row) => row.id === created.id)
  assert.equal(worker.review.state, 'awaiting')
  assert.equal(worker.review.round, 3)
  assert.equal(worker.report.summary, '第三版完成')
  console.log(
    'ACCEPT state: completed→awaiting; blocked answer→awaiting; legacy=no review; repeated rework rounds=2,3'
  )
})

function seedDispatch(id, handle, workspace, by, overrides = {}) {
  const now = new Date().toISOString()
  return {
    id,
    handle,
    projectId: 'p-normal',
    project: workspace,
    agent: 'claude',
    title: id,
    prompt: `任务 ${id}`,
    by,
    at: now,
    updatedAt: now,
    status: 'completed',
    report: { outcome: 'succeeded', summary: `汇报 ${id}`, reportedAt: now },
    review: { state: 'awaiting', reviewer: by.kind === 'owner' ? 'owner' : 'dispatcher', round: 1 },
    ...overrides
  }
}

function seedRecord(id, agent, cwd) {
  const now = new Date().toISOString()
  return {
    id,
    taskId: `task-${id}`,
    businessId: 'business',
    projectId: 'p-normal',
    title: `恢复 ${agent}`,
    prompt: '原任务',
    summary: '原汇报',
    agent,
    dispatchedBy: { kind: 'owner', id: 'opc-owner', label: '老板' },
    reviewedBy: { kind: 'owner', id: 'opc-owner', label: '老板' },
    startedAt: now,
    finishedAt: now,
    acceptedAt: now,
    reworks: 0,
    resume: { agent, sessionId: `${agent}-session`, cwd }
  }
}

async function runCli(base, ...args) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./hiwd.mjs', import.meta.url)), ...args],
    {
      env: { ...process.env, OPC_BRIDGE: base, OPC_DISPATCHER: 'leader-a' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const code = await new Promise((resolve) => child.once('close', resolve))
  return { code, stdout, stderr }
}

test(
  'review HTTP/CLI：权限、关窗、记录、重开与时间线（独立端口和 /tmp）',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp('/tmp/opc-review-http-')
    const data = join(root, 'data')
    const workspace = join(root, 'workspace')
    await Promise.all([mkdir(data), mkdir(workspace)])
    const now = new Date().toISOString()
    const owner = { kind: 'owner', id: 'opc-owner', label: '老板', cwd: workspace }
    const leaderA = { kind: 'cli', id: 'leader-a', label: 'Leader A', cwd: workspace }
    const leaderB = { kind: 'cli', id: 'leader-b', label: 'Leader B', cwd: workspace }
    const dispatches = [
      seedDispatch('dsp-owner', 'owner-worker', workspace, owner),
      seedDispatch('dsp-agent', 'agent-worker', workspace, leaderA),
      seedDispatch('dsp-other', 'other-worker', workspace, leaderB),
      seedDispatch('dsp-rework', 'rework-worker', workspace, leaderA),
      seedDispatch('dsp-leader', 'leader-terminal', workspace, owner, {
        projectId: 'p-leader',
        role: 'leader'
      }),
      seedDispatch('dsp-shared-a', 'shared-worker', workspace, owner),
      seedDispatch('dsp-shared-b', 'shared-worker', workspace, owner),
      seedDispatch('dsp-close-error', 'close-error', workspace, owner),
      seedDispatch('dsp-remote-owner', 'remote-owner-worker', workspace, owner),
      seedDispatch('dsp-old-http', 'old-http', workspace, owner, { review: undefined })
    ]
    const terminals = dispatches
      .filter((row) => row.id !== 'dsp-old-http')
      .map((row, index, rows) =>
        rows.findIndex((other) => other.handle === row.handle) === index
          ? { handle: row.handle, agentIdentity: 'stub', worktreePath: workspace }
          : null
      )
      .filter(Boolean)
    await writeFile(
      join(data, 'businesses.json'),
      JSON.stringify([
        {
          id: 'business',
          name: '复核业务',
          workspacePath: workspace,
          status: 'active',
          priority: 1,
          leaderAgent: 'claude',
          authority: '',
          runIds: [],
          updatedAt: now
        }
      ])
    )
    await writeFile(join(data, 'dispatches.json'), JSON.stringify(dispatches))
    await writeFile(
      join(data, 'business-projects.json'),
      JSON.stringify({
        projects: [
          {
            id: 'p-normal',
            businessId: 'business',
            name: '普通项目',
            path: workspace,
            status: 'active',
            leader: null,
            counts: { workersLive: 0, dispatches: 0, dispatchesDone: 0 },
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'p-leader',
            businessId: 'business',
            name: 'Leader 项目',
            path: workspace,
            status: 'active',
            leader: {
              terminal: 'leader-terminal',
              agent: 'claude',
              liveness: 'live',
              startedAt: now
            },
            counts: { workersLive: 0, dispatches: 0, dispatchesDone: 0 },
            createdAt: now,
            updatedAt: now
          }
        ],
        migrated: ['business'],
        bindings: {}
      })
    )
    await writeFile(
      join(data, 'work-records.json'),
      JSON.stringify([
        seedRecord('rec-claude', 'claude', workspace),
        seedRecord('rec-codex', 'codex', workspace),
        seedRecord('rec-kimi', 'kimi', workspace)
      ])
    )

    const mutations = []
    const sockets = new Set()
    let creates = 0
    const repos = [{ id: 'repo', path: workspace, displayName: '复核业务', kind: 'folder' }]
    const respond = ({ method, params = {} }) => {
      switch (method) {
        case 'notifications.getMissedSince':
          return { epoch: 'review', notifications: [] }
        case 'repo.list':
          return { repos }
        case 'repo.add': {
          const repo = { id: `repo-${repos.length}`, ...params }
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
        case 'terminal.send':
          mutations.push({ method, params })
          return {}
        case 'terminal.close': {
          mutations.push({ method, params })
          if (params.terminal === 'close-error') {
            throw Object.assign(new Error('桩：关窗失败'), { code: 'close_failed' })
          }
          const index = terminals.findIndex((terminal) => terminal.handle === params.terminal)
          if (index !== -1) {
            terminals.splice(index, 1)
          }
          return {}
        }
        case 'terminal.create': {
          mutations.push({ method, params })
          const terminal = {
            handle: `resumed-${++creates}`,
            agentIdentity: 'stub',
            worktreePath: params.worktree.slice(5)
          }
          terminals.push(terminal)
          return { terminal }
        }
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
    const runtime = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        let end
        while ((end = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          let result
          let error
          try {
            result = respond(request)
          } catch (cause) {
            error = { code: cause.code ?? 'stub_error', message: cause.message }
          }
          if (result === undefined && !error) {
            error = { code: 'method_not_found', message: 'stub' }
          }
          socket.write(`${JSON.stringify({ id: request.id, ok: !error, result, error })}\n`)
        }
      })
    })
    runtime.listen(join(root, 'runtime.sock'))
    await once(runtime, 'listening')
    const meta = join(root, 'runtime.json')
    await writeFile(
      meta,
      JSON.stringify({
        authToken: 'test',
        transports: [{ kind: 'unix', endpoint: join(root, 'runtime.sock') }]
      })
    )
    const previous = {
      OPC_DATA_DIR: process.env.OPC_DATA_DIR,
      ORCA_RUNTIME_META: process.env.ORCA_RUNTIME_META
    }
    process.env.OPC_DATA_DIR = data
    process.env.ORCA_RUNTIME_META = meta
    let blockedAgent
    const guardCalls = []
    const guard = {
      assertAllowed: async (agent) => {
        guardCalls.push(agent)
        if (blockedAgent === agent) {
          throw Object.assign(new Error(`地区拒绝 ${agent}`), {
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
    const { startBridge } = await import('./orca-bridge.mjs')
    const { closeRuntimeConnection } = await import('./orca-client.mjs')
    const server = await startBridge({ port: 0, lanPort: false, regionGuard: guard })
    const base = `http://127.0.0.1:${server.address().port}`
    const api = async (path, body, headers = {}) => {
      const response = await fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined
      })
      const result = await response.json()
      return Array.isArray(result)
        ? Object.assign(result, { status: response.status })
        : { status: response.status, ...result }
    }
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve))
      closeRuntimeConnection()
      for (const socket of sockets) {
        socket.destroy()
      }
      runtime.close()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      await rm(root, { recursive: true, force: true })
    })

    const initial = await api('/api/tasks')
    assert.equal(initial.status, 200, JSON.stringify(initial))
    assert.equal(initial.find((task) => task.id === 'dsp-old-http').review, undefined)
    const taskList = await runCli(base, 'tasks')
    assert.equal(taskList.code, 0, taskList.stderr)
    assert.match(taskList.stdout, /dsp-owner \[completed\] \[待复核·老板\]/)
    assert.match(taskList.stdout, /dsp-agent \[completed\] \[待复核·派单方 Leader A\]/)

    const accepted = await api('/api/tasks/dsp-owner/review', { verdict: 'accept' })
    assert.equal(accepted.status, 200, JSON.stringify(accepted))
    assert.equal(accepted.task.review.state, 'accepted')
    assert.equal(accepted.task.terminal, undefined)
    assert.equal(accepted.record.id, 'wr_dsp-owner')
    assert.ok(
      mutations.some((m) => m.method === 'terminal.close' && m.params.terminal === 'owner-worker')
    )
    const persisted = JSON.parse(await readFile(join(data, 'work-records.json'), 'utf8'))
    assert.ok(persisted.some((record) => record.id === 'wr_dsp-owner'))
    const timeline = await api('/api/timeline?limit=100')
    const recordEvent = timeline.items.find((event) => event.recordId === 'wr_dsp-owner')
    assert.equal(recordEvent.kind, 'record')
    assert.equal(recordEvent.title, '工作记录：任务 dsp-owner')
    assert.equal(recordEvent.detail, '汇报 dsp-owner')
    assert.equal(recordEvent.taskId, 'dsp-owner')
    assert.equal(recordEvent.projectId, 'p-normal')
    const topology = await api('/api/topology')
    assert.ok(!topology.nodes.some((node) => node.terminal === 'owner-worker'))
    const fetched = await api('/api/records/wr_dsp-owner')
    assert.equal(fetched.status, 200)
    assert.equal(fetched.taskId, 'dsp-owner')
    console.log(
      'ACCEPT owner: terminal closed; record persisted; timeline record; topology removed'
    )

    const forbidden = await runCli(base, 'review', 'dsp-other', '--accept')
    assert.notEqual(forbidden.code, 0)
    assert.match(forbidden.stderr, /只能复核自己派出去的活/)
    assert.ok(
      !mutations.some((m) => m.method === 'terminal.close' && m.params.terminal === 'other-worker')
    )
    const own = await runCli(base, 'review', 'dsp-agent', '--accept')
    assert.equal(own.code, 0, own.stderr)
    assert.match(own.stdout, /已通过 dsp-agent，工作记录：wr_dsp-agent/)
    const ownRecord = await api('/api/records/wr_dsp-agent')
    assert.equal(ownRecord.reviewedBy.kind, 'agent')
    assert.equal(ownRecord.reviewedBy.id, 'leader-a')

    const agentHeaders = {
      'x-opc-caller': 'agent',
      'x-opc-dispatcher-id': encodeURIComponent('leader-a')
    }
    const machines = await api('/api/machines')
    const selfId = machines.machines.find((machine) => machine.self).id
    const remoteAgent = await api(
      `/api/m/${selfId}/api/tasks/dsp-remote-owner/review`,
      { verdict: 'accept' },
      agentHeaders
    )
    assert.equal(remoteAgent.status, 403)
    const remoteOwner = await api(`/api/m/${selfId}/api/tasks/dsp-remote-owner/review`, {
      verdict: 'accept'
    })
    assert.equal(remoteOwner.status, 200, JSON.stringify(remoteOwner))
    console.log(
      'ACCEPT identity: other agent=403; own agent=accepted; /api/m/ agent=403; owner=200'
    )

    const rework = await runCli(base, 'review', 'dsp-rework', '--rework', '补上测试')
    assert.equal(rework.code, 0, rework.stderr)
    assert.match(rework.stdout, /第 2 轮重做/)
    const reworked = (await api('/api/tasks')).find((task) => task.id === 'dsp-rework')
    assert.equal(reworked.status, 'dispatched')
    assert.equal(reworked.review.state, 'rework')
    assert.equal(reworked.review.round, 2)
    const send = mutations.findLast(
      (mutation) =>
        mutation.method === 'terminal.send' && mutation.params.terminal === 'rework-worker'
    )
    assert.equal(send.params.text, '复核没通过：补上测试')
    assert.equal(send.params.enter, true)
    assert.equal(send.params.agentPrompt, true)
    assert.ok(terminals.some((terminal) => terminal.handle === 'rework-worker'))
    assert.equal((await api('/api/tasks/dsp-rework/review', { verdict: 'accept' })).status, 409)
    console.log('ACCEPT rework: exact note sent; terminal retained; status=dispatched; round=2')

    const closesBeforeLeader = mutations.filter(
      (mutation) => mutation.method === 'terminal.close'
    ).length
    const leader = await api('/api/tasks/dsp-leader/review', { verdict: 'accept' })
    assert.equal(leader.status, 200)
    assert.equal(leader.closeError, undefined)
    assert.equal(leader.record.id, 'wr_dsp-leader')
    assert.equal(
      mutations.filter((mutation) => mutation.method === 'terminal.close').length,
      closesBeforeLeader
    )
    assert.ok(terminals.some((terminal) => terminal.handle === 'leader-terminal'))

    const shared = await api('/api/tasks/dsp-shared-a/review', { verdict: 'accept' })
    assert.equal(shared.status, 200)
    assert.ok(
      !mutations.some(
        (mutation) =>
          mutation.method === 'terminal.close' && mutation.params.terminal === 'shared-worker'
      )
    )
    assert.ok(terminals.some((terminal) => terminal.handle === 'shared-worker'))

    const closeFailure = await api('/api/tasks/dsp-close-error/review', { verdict: 'accept' })
    assert.equal(closeFailure.status, 200)
    assert.match(closeFailure.closeError, /关窗失败/)
    assert.equal(closeFailure.record.id, 'wr_dsp-close-error')
    assert.equal(closeFailure.task.review.state, 'accepted')
    console.log('ACCEPT close policy: leader/shared retained; closeError does not drop record')

    const { agentCommand, LEADER_RULES } = await import('./business-terminals.mjs')
    assert.match(LEADER_RULES, /hiwd review <任务id> --accept/)
    assert.match(LEADER_RULES, /没看过的活不要直接通过/)
    assert.equal(
      agentCommand('claude', { resume: 'claude-session' }),
      "claude --dangerously-skip-permissions --resume 'claude-session'"
    )
    assert.equal(
      agentCommand('codex', { resume: 'codex-session' }),
      "codex --dangerously-bypass-approvals-and-sandbox resume 'codex-session'"
    )
    assert.equal(
      agentCommand('kimi', { resume: 'kimi-session' }),
      "kimi --yolo --session 'kimi-session' --model 'kimi-code/k3.1-pro'"
    )
    for (const agent of ['claude', 'codex', 'kimi']) {
      const resumed = await api(`/api/records/rec-${agent}/resume`, {})
      assert.equal(resumed.status, 200, JSON.stringify(resumed))
      assert.equal(resumed.terminal, `resumed-${creates}`)
      const create = mutations.findLast((mutation) => mutation.method === 'terminal.create')
      assert.equal(create.params.worktree, `path:${workspace}`)
      assert.equal(create.params.command, agentCommand(agent, { resume: `${agent}-session` }))
    }
    const projects = JSON.parse(await readFile(join(data, 'business-projects.json'), 'utf8'))
    assert.equal(projects.bindings[`resumed-${creates}`], 'p-normal')
    const resumedTimeline = await api('/api/timeline?limit=100')
    assert.ok(
      resumedTimeline.items.some(
        (event) => event.recordId === 'rec-kimi' && event.title.startsWith('重新打开工作记录：')
      )
    )
    const createsBeforeBlock = creates
    blockedAgent = 'codex'
    const blockedResume = await api('/api/records/rec-codex/resume', {})
    assert.equal(blockedResume.status, 403)
    assert.equal(blockedResume.error.code, 'exit_region_blocked')
    assert.equal(creates, createsBeforeBlock)
    assert.ok(guardCalls.includes('claude') && guardCalls.includes('codex'))

    const { transcriptSessionId } = await import('./transcripts.mjs')
    const claudeTranscript = join(root, 'claude-session.jsonl')
    const codexTranscript = join(root, 'rollout-codex.jsonl')
    const kimiTranscript = join(root, 'kimi-session', 'wire.jsonl')
    await mkdir(join(root, 'kimi-session'))
    await Promise.all([
      writeFile(claudeTranscript, ''),
      writeFile(
        codexTranscript,
        `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session' } })}\n`
      ),
      writeFile(kimiTranscript, '')
    ])
    assert.equal(transcriptSessionId('claude', claudeTranscript), 'claude-session')
    assert.equal(transcriptSessionId('codex', codexTranscript), 'codex-session')
    assert.equal(transcriptSessionId('kimi', kimiTranscript), 'kimi-session')

    const { saveWorkRecord, workRecords } = await import('./work-records.mjs')
    for (let index = 0; index < 205; index++) {
      saveWorkRecord({ ...seedRecord(`bulk-${index}`, 'kimi', workspace), taskId: `bulk-${index}` })
    }
    assert.equal(workRecords().filter((record) => record.id.startsWith('bulk-')).length, 205)
    assert.ok(fs.readdirSync(data).every((file) => !file.includes('.tmp')))
    console.log(
      'ACCEPT resume: claude/codex/kimi argv, session ids, cwd, project binding, timeline, region guard; records>200'
    )
  }
)

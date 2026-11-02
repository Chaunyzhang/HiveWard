/* oxlint-disable max-lines -- one isolated CEO lifecycle reuses one runtime, HOME and data directory. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const hiwd = fileURLToPath(new URL('./hiwd.mjs', import.meta.url))

test(
  'CEO seats: terminal/session occupants, ownership, projects, owner prompts and review',
  { timeout: 180000 },
  async () => {
    const root = await mkdtemp('/tmp/opc-ceo-seats-')
    const data = join(root, 'data'),
      home = join(root, 'home'),
      workspace = join(root, 'business')
    await Promise.all([mkdir(data), mkdir(home), mkdir(workspace)])
    const workspaceReal = await realpath(workspace)
    const now = new Date().toISOString()
    await writeFile(
      join(data, 'businesses.json'),
      JSON.stringify([
        {
          id: 'business',
          name: '验收业务',
          nameSource: 'user',
          workspacePath: workspace,
          status: 'active',
          priority: 1,
          leaderAgent: 'kimi',
          runIds: [],
          updatedAt: now
        }
      ])
    )
    await writeFile(
      join(data, 'business-projects.json'),
      JSON.stringify({ projects: [], migrated: ['business'], bindings: {} })
    )
    await writeFile(join(data, 'dispatches.json'), '[]')

    const previous = Object.fromEntries(
      ['HOME', 'OPC_DATA_DIR', 'ORCA_RUNTIME_META'].map((key) => [key, process.env[key]])
    )
    process.env.HOME = home
    process.env.OPC_DATA_DIR = data

    const terminals = [],
      mutations = [],
      sockets = new Set(),
      children = new Map(),
      transcripts = new Map()
    const repos = [
      {
        id: 'repo-business',
        path: workspaceReal,
        displayName: '验收业务',
        kind: 'folder'
      }
    ]
    let created = 0,
      message = 0
    const transcriptPath = (cwd, sessionId) =>
      join(home, '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
    const appendChat = (path, type, text) => {
      const id = `message-${++message}`
      appendFileSync(
        path,
        `${JSON.stringify({
          type,
          uuid: id,
          timestamp: new Date().toISOString(),
          message: {
            role: type,
            ...(type === 'assistant' ? { stop_reason: 'end_turn' } : {}),
            content: [{ type: 'text', text }]
          }
        })}\n`
      )
    }
    const createTerminal = (params) => {
      const handle = `terminal-${++created}`,
        worktreePath = params.worktree.slice(5),
        sessionId = `fixture-${handle}`,
        transcript = transcriptPath(worktreePath, sessionId)
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'claude'], {
        env: { ...process.env, HOME: home },
        stdio: 'ignore'
      })
      children.set(handle, child)
      transcripts.set(handle, transcript)
      mkdirSync(dirname(transcript), { recursive: true })
      writeFileSync(transcript, '')
      const sessions = join(home, '.claude/sessions')
      mkdirSync(sessions, { recursive: true })
      writeFileSync(
        join(sessions, `${child.pid}.json`),
        JSON.stringify({ pid: child.pid, cwd: worktreePath, sessionId })
      )
      const terminal = {
        handle,
        agentIdentity: 'claude',
        worktreePath,
        title: params.title,
        preview: 'fixture ready',
        connected: true,
        writable: true
      }
      terminals.push(terminal)
      return terminal
    }
    const respond = ({ method, params = {} }) => {
      switch (method) {
        case 'notifications.getMissedSince':
          return { epoch: 'ceo-seats', notifications: [] }
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
        case 'terminal.create': {
          mutations.push({ method, params })
          return { terminal: createTerminal(params) }
        }
        case 'terminal.read': {
          const terminal = terminals.find((t) => t.handle === params.terminal)
          return { terminal: { tail: [terminal?.preview ?? 'fixture ready'], status: 'running' } }
        }
        case 'terminal.agentStatus':
          return { agentStatus: { isRunningAgent: true, status: 'idle' } }
        case 'terminal.inspectProcess': {
          const child = children.get(params.terminal)
          return {
            process: {
              hasChildProcesses: true,
              foregroundProcess: 'claude',
              foregroundProcessEvidence: {
                fence: {
                  process: { pid: child?.pid, startTime: now }
                }
              }
            }
          }
        }
        case 'terminal.send': {
          mutations.push({ method, params })
          if (params.text) {
            const transcript = transcripts.get(params.terminal)
            assert.ok(transcript, `no transcript for ${params.terminal}`)
            appendChat(transcript, 'user', params.text)
          }
          return {}
        }
        case 'terminal.close': {
          mutations.push({ method, params })
          const index = terminals.findIndex((t) => t.handle === params.terminal)
          if (index !== -1) {
            terminals.splice(index, 1)
          }
          children.get(params.terminal)?.kill()
          return {}
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
    const socketPath = join(root, 'runtime.sock')
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
          let result, error
          try {
            result = respond(request)
          } catch (cause) {
            error = { code: cause.code ?? 'stub_error', message: cause.message }
          }
          if (result === undefined && !error) {
            error = { code: 'method_not_found', message: request.method }
          }
          socket.write(`${JSON.stringify({ id: request.id, ok: !error, result, error })}\n`)
        }
      })
    })
    runtime.listen(socketPath)
    await once(runtime, 'listening')
    const meta = join(root, 'runtime.json')
    await writeFile(
      meta,
      JSON.stringify({ authToken: 'test', transports: [{ kind: 'unix', endpoint: socketPath }] })
    )
    process.env.ORCA_RUNTIME_META = meta

    // transcripts.mjs fixes HOME at import time, so load the whole bridge only after isolation.
    const { startBridge } = await import('./orca-bridge.mjs')
    const { invalidate } = await import('./orchestration.mjs')
    const { closeRuntimeConnection } = await import('./orca-client.mjs')
    const guard = {
      assertAllowed: async () => {},
      beforeRpc: async () => {},
      observe: async () => {},
      warnings: () => [],
      status: async () => ({})
    }
    const server = await startBridge({ port: 0, lanPort: false, regionGuard: guard })
    const base = `http://127.0.0.1:${server.address().port}`
    const api = async (path, body, method, headers = {}) => {
      const response = await fetch(base + path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      const result = await response.json()
      return Array.isArray(result)
        ? Object.assign(result, { status: response.status })
        : { status: response.status, ...result }
    }
    const caller = (id) => ({
      'x-opc-caller': 'agent',
      'x-opc-dispatcher-id': encodeURIComponent(id)
    })
    const cli = (args, options = {}) =>
      new Promise((resolve, reject) => {
        const env = {
          ...process.env,
          HOME: home,
          OPC_BRIDGE: base,
          OPC_DATA_DIR: data,
          ORCA_RUNTIME_META: meta,
          ORCA_BACKGROUND_LAUNCH: '1'
        }
        for (const key of [
          'ORCA_TERMINAL_HANDLE',
          'OPC_DISPATCHER',
          'CLAUDE_CODE_SESSION_ID',
          'CLAUDE_CODE_ENTRYPOINT',
          'CODEX_THREAD_ID'
        ]) {
          delete env[key]
        }
        if (options.terminal) {
          env.ORCA_TERMINAL_HANDLE = options.terminal
        }
        if (options.dispatcher) {
          env.OPC_DISPATCHER = options.dispatcher
        }
        if (options.session) {
          env.CLAUDE_CODE_SESSION_ID = options.session
          env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
        }
        const child = spawn(process.execPath, [hiwd, ...args], {
          cwd: options.cwd ?? workspace,
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = '',
          stderr = '',
          timedOut = false
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        const timer = setTimeout(() => {
          timedOut = true
          child.kill()
        }, 30000)
        child.on('error', reject)
        child.on('close', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal, stdout, stderr, timedOut })
        })
      })
    const creates = () => mutations.filter((m) => m.method === 'terminal.create')
    const closes = (handle) =>
      mutations.filter((m) => m.method === 'terminal.close' && m.params.terminal === handle)
    const complete = (handle, text) => {
      const transcript = transcripts.get(handle)
      assert.ok(transcript, `no transcript for ${handle}`)
      appendChat(transcript, 'assistant', text)
    }
    const projects = async () => (await api('/api/businesses/business/projects')).projects
    const ceoNode = async () =>
      (await api('/api/topology?businessId=business')).nodes.find((n) => n.id === 'ceo:business')

    try {
      const launch = await api('/api/businesses/business/ceo', { agent: 'claude' })
      assert.equal(launch.status, 200, JSON.stringify(launch))
      const ceo = launch.terminal
      const ceoCreate = creates().at(-1)
      assert.equal(ceoCreate.params.worktree, `path:${workspaceReal}`)
      assert.equal(terminals.find((t) => t.handle === ceo).worktreePath, workspaceReal)
      assert.match(ceoCreate.params.command, /^claude --dangerously-skip-permissions/)
      assert.ok(ceoCreate.params.command.includes('--append-system-prompt'))
      assert.ok(ceoCreate.params.command.includes(launch.brief), 'full CEO brief must be injected')
      const launchTimeline = await api('/api/timeline?businessId=business&limit=100')
      assert.ok(
        launchTimeline.items.some(
          (event) => event.terminal === ceo && /坐上 验收业务 的 CEO 位/.test(event.title)
        )
      )
      const launchedNode = await ceoNode()
      assert.equal(launchedNode.kind, 'ceo')
      assert.equal(launchedNode.parentId, 'business:business')
      assert.equal(launchedNode.terminal, ceo)
      console.log(
        `ACCEPT 1 terminal CEO: realpath=${workspaceReal}; full Claude brief; timeline; ceo:business node`
      )

      const direct = await cli(['new', workspace, 'claude', 'CEO 直接派 Worker'], {
        terminal: ceo
      })
      assert.equal(direct.code, 0, `${direct.stdout}\n${direct.stderr}`)
      assert.equal(direct.timedOut, false)
      const directWorker = creates().at(-1).params
      const directHandle = terminals.at(-1).handle
      assert.match(direct.stdout, new RegExp(directHandle))
      assert.equal(directWorker.worktree, `path:${workspaceReal}`)
      let nodes = (await api('/api/topology?businessId=business')).nodes
      const directNode = nodes.find((n) => n.terminal === directHandle && n.kind === 'worker')
      assert.equal(directNode.parentId, 'ceo:business')
      console.log(`ACCEPT 2 CEO hiwd new: Worker ${directHandle} parent=ceo:business`)

      const grok = await cli(['new', workspace, 'claude', 'Grok 直接派 Worker'], {
        dispatcher: 'grok:business'
      })
      assert.equal(grok.code, 0, `${grok.stdout}\n${grok.stderr}`)
      const grokHandle = terminals.at(-1).handle
      nodes = (await api('/api/topology?businessId=business')).nodes
      const grokNode = nodes.find((n) => n.terminal === grokHandle && n.kind === 'worker')
      assert.equal(grokNode.parentId, 'leader:business:unassigned')
      assert.notEqual(grokNode.parentId, 'ceo:business')
      console.log(`ACCEPT 4 OPC_DISPATCHER=grok:business: ${grokHandle} parent=unassigned`)

      const ownerPrompt = '老板给 CEO 的任务'
      const createCount = creates().length
      const ownerLaunch = await api('/api/businesses/business/ceo', {
        agent: 'claude',
        prompt: ownerPrompt
      })
      assert.equal(ownerLaunch.status, 200, JSON.stringify(ownerLaunch))
      assert.equal(ownerLaunch.terminal, ceo)
      assert.equal(creates().length, createCount, 'occupied CEO terminal must be reused')
      const ownerSend = mutations.findLast(
        (m) => m.method === 'terminal.send' && m.params.terminal === ceo
      )
      assert.equal(ownerSend.params.text, ownerPrompt)
      assert.equal(ownerSend.params.enter, true)

      const add = await cli(['project', 'add', '交付', '--dir', 'delivery', '--leader', 'claude'], {
        terminal: ceo
      })
      assert.equal(add.code, 0, `${add.stdout}\n${add.stderr}`)
      const main = (await projects()).find((p) => p.name === '交付')
      assert.ok(main, add.stdout)
      const leader = main.leader.terminal
      assert.ok(leader)
      assert.equal(main.path, join(workspaceReal, 'delivery'))
      assert.match(add.stdout, new RegExp(leader))

      const delegation = '请 Leader 拆解交付任务'
      const told = await cli(['tell', leader, delegation], { terminal: ceo })
      assert.equal(told.code, 0, `${told.stdout}\n${told.stderr}`)
      assert.ok(
        mutations.some(
          (m) =>
            m.method === 'terminal.send' &&
            m.params.terminal === leader &&
            m.params.text === delegation
        )
      )
      const leaderNew = await cli(['new', main.path, 'claude', 'Leader 派 Worker'], {
        terminal: leader,
        cwd: main.path
      })
      assert.equal(leaderNew.code, 0, `${leaderNew.stdout}\n${leaderNew.stderr}`)
      const projectWorker = terminals.at(-1).handle
      nodes = (await api('/api/topology?businessId=business')).nodes
      const projectWorkerNode = nodes.find(
        (n) => n.terminal === projectWorker && n.kind === 'worker'
      )
      assert.equal(projectWorkerNode.parentId, `leader:${main.id}`)
      assert.equal(projectWorkerNode.projectId, main.id)
      console.log(
        `ACCEPT 3 CEO tell Leader then Leader hiwd new: ${projectWorker} parent=leader:${main.id}`
      )

      for (const { label, options } of [
        { label: 'Leader', options: { terminal: leader, cwd: main.path } },
        { label: 'Worker', options: { terminal: projectWorker, cwd: main.path } },
        { label: 'Grok', options: { dispatcher: 'grok:business', cwd: workspace } }
      ]) {
        const denied = await cli(
          ['project', 'add', `越权${label}`, '--business', 'business'],
          options
        )
        assert.equal(denied.code, 1, `${label}: ${denied.stdout}\n${denied.stderr}`)
        assert.match(denied.stderr, /项目由 CEO 增减/)
      }
      assert.ok(!(await projects()).some((p) => p.name.startsWith('越权')))

      const busy = await api(
        `/api/businesses/business/projects/${main.id}`,
        { status: 'archived' },
        'PATCH',
        caller(ceo)
      )
      assert.equal(busy.status, 409, JSON.stringify(busy))
      assert.equal(busy.error.code, 'project_busy')
      assert.match(busy.error.message, /在干活 \/ 待复核/)

      complete(leader, 'Leader 已完成交付拆解')
      complete(projectWorker, 'Worker 已完成交付任务')
      invalidate()
      const mainTasks = await api('/api/tasks?businessId=business')
      const leaderTask = mainTasks.find((task) => task.terminal === leader)
      const workerTask = mainTasks.find((task) => task.terminal === projectWorker)
      assert.equal(leaderTask.review?.state, 'awaiting', JSON.stringify(leaderTask))
      assert.equal(workerTask.review?.state, 'awaiting', JSON.stringify(workerTask))
      const acceptedWorker = await api(
        `/api/tasks/${workerTask.id}/review`,
        { verdict: 'accept' },
        undefined,
        caller(leader)
      )
      assert.equal(acceptedWorker.status, 200, JSON.stringify(acceptedWorker))
      assert.ok(acceptedWorker.record)
      const acceptedLeader = await api(
        `/api/tasks/${leaderTask.id}/review`,
        { verdict: 'accept' },
        undefined,
        caller(ceo)
      )
      assert.equal(acceptedLeader.status, 200, JSON.stringify(acceptedLeader))
      assert.equal(closes(leader).length, 0)

      const renamed = await cli(
        ['project', 'rename', '交付', '交付完成', '--business', 'business'],
        { terminal: ceo }
      )
      assert.equal(renamed.code, 0, `${renamed.stdout}\n${renamed.stderr}`)
      assert.match(renamed.stdout, /已改名：交付完成/)
      const archived = await cli(['project', 'archive', '交付完成', '--business', 'business'], {
        terminal: ceo
      })
      assert.equal(archived.code, 0, `${archived.stdout}\n${archived.stderr}`)
      const archivedMain = (await projects()).find((p) => p.id === main.id)
      assert.equal(archivedMain.status, 'archived')
      assert.equal(archivedMain.leader, null)
      assert.ok(
        terminals.some((t) => t.handle === leader),
        'archive must not close Leader'
      )
      const restored = await api(
        `/api/businesses/business/projects/${main.id}`,
        { status: 'active' },
        'PATCH'
      )
      assert.equal(restored.status, 200, JSON.stringify(restored))
      assert.equal(restored.project.status, 'active')
      const rearchived = await api(
        `/api/businesses/business/projects/${main.id}`,
        { status: 'archived' },
        'PATCH'
      )
      assert.equal(rearchived.project.status, 'archived')
      console.log(
        `ACCEPT 4b project add --leader; busy archive=409; complete+archive; Leader/Worker/Grok=403; rename; Leader retained; owner restore`
      )

      const sessionProjectResponse = await api('/api/businesses/business/projects', {
        name: '会话 Leader',
        dir: 'session-leader',
        agent: 'claude'
      })
      assert.equal(sessionProjectResponse.status, 200, JSON.stringify(sessionProjectResponse))
      const sessionProject = sessionProjectResponse.project
      const originalLeader = sessionProject.leader.terminal
      const leaderSessionA = 'leader-session-a',
        leaderSessionB = 'leader-session-b'
      const sessionClaim = (sessionId) => ({
        seat: 'leader',
        businessId: 'business',
        projectId: sessionProject.id,
        session: { sessionId, agent: 'claude', cwd: sessionProject.path }
      })
      const occupied = await api('/api/seats/claim', sessionClaim(leaderSessionA))
      assert.equal(occupied.status, 409, JSON.stringify(occupied))
      assert.equal(occupied.error.code, 'seat_occupied')
      const claimedA = await cli(
        ['seat', 'leader', '--business', 'business', '--project', sessionProject.id, '--replace'],
        { session: leaderSessionA, cwd: sessionProject.path }
      )
      assert.equal(claimedA.code, 0, `${claimedA.stdout}\n${claimedA.stderr}`)
      assert.match(claimedA.stdout, /Leader Agent/)
      assert.equal(
        (await projects()).find((p) => p.id === sessionProject.id).leader.occupant.sessionId,
        leaderSessionA
      )
      const conflict = await api('/api/seats/claim', sessionClaim(leaderSessionB))
      assert.equal(conflict.status, 409, JSON.stringify(conflict))
      assert.equal(conflict.error.code, 'seat_occupied')
      const claimedB = await cli(
        ['seat', 'leader', '--business', 'business', '--project', sessionProject.id, '--replace'],
        { session: leaderSessionB, cwd: sessionProject.path }
      )
      assert.equal(claimedB.code, 0, `${claimedB.stdout}\n${claimedB.stderr}`)
      assert.equal(
        (await projects()).find((p) => p.id === sessionProject.id).leader.occupant.sessionId,
        leaderSessionB
      )
      const leaderLeave = await cli(['seat', 'leave'], {
        session: leaderSessionB,
        cwd: sessionProject.path
      })
      assert.equal(leaderLeave.code, 0, `${leaderLeave.stdout}\n${leaderLeave.stderr}`)
      assert.equal((await projects()).find((p) => p.id === sessionProject.id).leader, null)
      assert.equal(closes(originalLeader).length, 0)
      assert.ok(terminals.some((t) => t.handle === originalLeader))
      console.log(
        'ACCEPT 1c session Leader: claim conflict=409; replace A→B; leave empty; original terminal not closed'
      )

      complete(ceo, 'CEO 已完成老板任务')
      invalidate()
      const ceoTasks = await api('/api/tasks?businessId=business')
      const ceoTask = ceoTasks.find((task) => task.terminal === ceo && task.title === ownerPrompt)
      assert.equal(ceoTask.status, 'completed', JSON.stringify(ceoTask))
      assert.equal(ceoTask.review?.state, 'awaiting')
      const persistedDispatches = JSON.parse(await readFile(join(data, 'dispatches.json'), 'utf8'))
      assert.equal(persistedDispatches.find((d) => d.id === ceoTask.id).role, 'ceo')
      const acceptedCeo = await api(`/api/tasks/${ceoTask.id}/review`, { verdict: 'accept' })
      assert.equal(acceptedCeo.status, 200, JSON.stringify(acceptedCeo))
      assert.ok(acceptedCeo.record)
      assert.equal(acceptedCeo.record.taskId, ceoTask.id)
      assert.equal(acceptedCeo.task.terminal, ceo)
      assert.equal(closes(ceo).length, 0)
      const record = await api(`/api/records/${acceptedCeo.record.id}`)
      assert.equal(record.status, 200)
      assert.equal(record.taskId, ceoTask.id)
      assert.equal((await api('/api/overview')).businesses[0].ceo.terminal, ceo)
      console.log(
        `ACCEPT 9 role=ceo awaiting accept: record=${record.id}; no terminal.close; CEO seat occupied`
      )

      const noIdentity = await cli(['seat', 'ceo', '--business', 'business'])
      assert.equal(noIdentity.code, 1)
      assert.match(noIdentity.stderr, /只能在 Claude Code \/ Codex 会话里坐座位/)

      const ceoSession = 'ceo-session-fixture',
        externalTranscript = transcriptPath(workspaceReal, ceoSession)
      mkdirSync(dirname(externalTranscript), { recursive: true })
      writeFileSync(externalTranscript, '')
      appendChat(externalTranscript, 'user', '外部 CEO 会话正在处理工作')
      const { findSessionTranscript } = await import('./transcripts.mjs')
      assert.equal(
        findSessionTranscript('claude-desktop', ceoSession, workspaceReal),
        externalTranscript
      )
      const sessionCeo = await cli(['seat', 'ceo', '--business', 'business', '--replace'], {
        session: ceoSession
      })
      assert.equal(sessionCeo.code, 0, `${sessionCeo.stdout}\n${sessionCeo.stderr}`)
      const ceoClaimBody = {
        seat: 'ceo',
        businessId: 'business',
        session: { sessionId: ceoSession, agent: 'claude-desktop', cwd: workspaceReal }
      }
      const sameClaim = await api('/api/seats/claim', ceoClaimBody)
      assert.equal(sameClaim.status, 200, JSON.stringify(sameClaim))
      assert.equal(sessionCeo.stdout.trim(), sameClaim.brief, 'CLI must print the complete brief')
      assert.match(sessionCeo.stdout, /不亲自写代码 \/ 干具体活/)
      assert.match(sessionCeo.stdout, /hiwd new/)
      assert.match(sessionCeo.stdout, /hiwd project add/)
      assert.match(sessionCeo.stdout, /hiwd review/)
      assert.match(sessionCeo.stdout, /hiwd seat leave/)
      const externalNode = await ceoNode()
      assert.equal(externalNode.sessionId, ceoSession)
      assert.equal(externalNode.terminal, undefined)
      assert.equal(externalNode.state, 'working', JSON.stringify(externalNode))
      assert.equal(externalNode.liveness, 'live', JSON.stringify(externalNode))
      assert.equal(externalNode.activity, '外部 CEO 会话正在处理工作')
      assert.equal(closes(ceo).length, 0)
      const stale = new Date(Date.now() - 31 * 60 * 1000)
      await utimes(externalTranscript, stale, stale)
      invalidate()
      const staleNode = await ceoNode()
      assert.equal(staleNode.liveness, 'unverifiable')
      assert.equal(staleNode.sessionId, ceoSession, 'silent sessions must remain seated')

      const sessionOwnerPrompt = await api('/api/businesses/business/ceo', {
        agent: 'claude',
        prompt: '老板不应打进外部会话'
      })
      assert.equal(sessionOwnerPrompt.status, 409, JSON.stringify(sessionOwnerPrompt))
      assert.equal(sessionOwnerPrompt.error.code, 'seat_is_session')
      assert.equal(sessionOwnerPrompt.error.sessionId, ceoSession)
      assert.ok(
        !mutations.some(
          (m) => m.method === 'terminal.send' && m.params.text === '老板不应打进外部会话'
        )
      )
      console.log(
        `ACCEPT 5 owner prompt: terminal ${ceo} received "${ownerPrompt}"; session CEO=409 seat_is_session sessionId=${ceoSession}`
      )

      const ceoLeave = await cli(['seat', 'leave'], { session: ceoSession })
      assert.equal(ceoLeave.code, 0, `${ceoLeave.stdout}\n${ceoLeave.stderr}`)
      const emptyNode = await ceoNode()
      assert.equal(emptyNode.agent, undefined)
      assert.equal(emptyNode.sessionId, undefined)
      assert.equal((await api('/api/overview')).businesses[0].ceo, null)
      console.log(
        'ACCEPT 1b isolated HOME transcript: complete brief; sessionId/state=working/live; 31m=stale but seated; leave empty; no identity rejected'
      )

      const terminalClaim = await cli(['seat', 'ceo'], { terminal: ceo })
      assert.equal(terminalClaim.code, 0, `${terminalClaim.stdout}\n${terminalClaim.stderr}`)
      assert.match(terminalClaim.stdout, /你现在坐在「验收业务」的 CEO 位上/)
      assert.equal((await ceoNode()).terminal, ceo)
      const terminalLeave = await cli(['seat', 'leave'], { terminal: ceo })
      assert.equal(terminalLeave.code, 0, `${terminalLeave.stdout}\n${terminalLeave.stderr}`)
      assert.equal((await ceoNode()).terminal, undefined)
      const terminalReclaim = await cli(['seat', 'ceo'], { terminal: ceo })
      assert.equal(terminalReclaim.code, 0, terminalReclaim.stderr)
      assert.equal((await api(`/api/orca/terminals/${ceo}/close`, {})).status, 200)
      invalidate()
      assert.equal((await ceoNode()).agent, undefined)
      assert.equal((await api('/api/overview')).businesses[0].ceo, null)
      console.log(
        'ACCEPT terminal hiwd seat: cwd inference; full brief; leave; closed terminal auto-empty'
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
      for (const child of children.values()) {
        child.kill()
      }
      await rm(root, { recursive: true, force: true })
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  }
)

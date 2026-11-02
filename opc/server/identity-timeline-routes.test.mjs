/* oxlint-disable max-lines -- one isolated end-to-end lifecycle avoids duplicate runtime setup. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function closeHttp(server) {
  if (!server) {
    return
  }
  await new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

test(
  'project identity and persisted timeline work through the HTTP bridge',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'opc-identity-routes-'))
    const dataDir = join(root, 'data')
    const runtimeMeta = join(root, 'runtime.json')
    const socketPath =
      process.platform === 'win32'
        ? String.raw`\\.\pipe\opc-identity-routes-${process.pid}`
        : join(root, 'runtime.sock')
    const previousEnv = {
      OPC_DATA_DIR: process.env.OPC_DATA_DIR,
      ORCA_RUNTIME_META: process.env.ORCA_RUNTIME_META
    }
    const sockets = new Set()
    let runtime
    let bridge
    let closeRuntimeConnection

    try {
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(dataDir, 'businesses.json'), '[]\n')

      const state = {
        repos: [],
        runs: [],
        tasks: [],
        gates: [],
        workers: [],
        workerShows: {},
        messages: [],
        terminals: [],
        worktrees: [],
        notifications: [],
        notificationEpoch: 'epoch-test'
      }
      const respond = (request) => {
        const params = request.params ?? {}
        switch (request.method) {
          case 'repo.list':
            return { repos: state.repos }
          case 'repo.add': {
            const repo = {
              id: `repo-${state.repos.length + 1}`,
              path: params.path,
              kind: params.kind,
              displayName: params.displayName
            }
            state.repos.push(repo)
            return { repo }
          }
          case 'repo.update': {
            const repo = state.repos.find((row) => row.id === params.repo)
            Object.assign(repo, params.updates)
            return { repo }
          }
          case 'repo.rm':
            state.repos = state.repos.filter((row) => row.id !== params.repo)
            return { removed: true }
          case 'status.get':
            return { appVersion: 'fixture', graphStatus: 'ready' }
          case 'terminal.list':
            return { terminals: state.terminals }
          case 'worktree.list':
            return { worktrees: state.worktrees }
          case 'orchestration.runList':
            return { runs: state.runs }
          case 'orchestration.taskList':
            return { tasks: state.tasks.filter((row) => row.run_id === params.run) }
          case 'orchestration.gateList':
            return { gates: state.gates.filter((row) => row.run_id === params.run) }
          case 'orchestration.workerList':
            return { workers: state.workers.filter((row) => row.runId === params.run) }
          case 'orchestration.workerShow':
            return state.workerShows[params.dispatch]
          case 'orchestration.inbox':
            return { messages: state.messages }
          case 'orchestration.send': {
            const message = {
              id: `owner-message-${state.messages.length + 1}`,
              run_id: params.to.slice(4),
              from_handle: params.from,
              to_handle: params.to,
              type: params.type,
              subject: params.subject,
              body: params.body,
              payload: params.payload,
              created_at: params.created_at
            }
            state.messages.push(message)
            return { message }
          }
          case 'notifications.getMissedSince':
            return {
              epoch: state.notificationEpoch,
              notifications: state.notifications.filter(
                (row) =>
                  row.notificationEpoch !== params.epoch || row.notificationSeq > params.lastSeenSeq
              )
            }
          default:
            return undefined
        }
      }

      runtime = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString()
          let newline
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const request = JSON.parse(buffer.slice(0, newline))
            buffer = buffer.slice(newline + 1)
            const result = respond(request)
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: result !== undefined,
                result,
                error:
                  result === undefined
                    ? { code: 'method_not_found', message: `Fixture has no ${request.method}` }
                    : undefined
              })}\n`
            )
          }
        })
      })
      runtime.listen(socketPath)
      await once(runtime, 'listening')
      await writeFile(
        runtimeMeta,
        JSON.stringify({
          authToken: 'identity-timeline-test-only',
          transports: [{ kind: 'unix', endpoint: socketPath }]
        })
      )

      process.env.OPC_DATA_DIR = dataDir
      process.env.ORCA_RUNTIME_META = runtimeMeta
      const [{ startBridge }, { invalidate }, orcaClient] = await Promise.all([
        import('./orca-bridge.mjs'),
        import('./orchestration.mjs'),
        import('./orca-client.mjs')
      ])
      closeRuntimeConnection = orcaClient.closeRuntimeConnection
      bridge = await startBridge({ port: 0, lanPort: false })

      const api = async (path, { method, body } = {}) => {
        const response = await fetch(`http://127.0.0.1:${bridge.address().port}${path}`, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10000)
        })
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          return {
            status: response.status,
            headers: response.headers,
            data: await response.json()
          }
        }
        return {
          status: response.status,
          headers: response.headers,
          bytes: Buffer.from(await response.arrayBuffer())
        }
      }
      const timeline = async (query = '') => {
        const response = await api(`/api/timeline${query}`)
        assert.equal(response.status, 200, JSON.stringify(response.data))
        return response.data
      }
      const event = (items, id) => {
        const found = items.find((row) => row.id === id)
        assert.ok(
          found,
          `missing timeline event ${id}; got ${items.map((row) => row.id).join(', ')}`
        )
        return found
      }

      const projectDir = join(root, 'product-project')
      const logoBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128])
      await mkdir(join(projectDir, 'resources'), { recursive: true })
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({ name: '@fixture/fallback-name', productName: 'Fixture Product' })
      )
      await writeFile(join(projectDir, 'resources', 'icon.png'), logoBytes)

      const created = await api('/api/projects', { body: { path: projectDir } })
      assert.equal(created.status, 200, JSON.stringify(created.data))
      const business = created.data.business
      assert.equal(business.name, 'Fixture Product')
      assert.equal(business.nameSource, 'auto')
      assert.match(business.logo, new RegExp(`^/api/projects/${business.id}/logo\\?v=\\d+$`))
      assert.equal(business.icon, undefined)
      console.log('ACCEPT project create', JSON.stringify(business))
      assert.equal(business.lastEvent.kind, 'system')
      assert.match(business.lastEvent.title, /项目加入：Fixture Product/)

      const storedAfterCreate = JSON.parse(await readFile(join(dataDir, 'businesses.json'), 'utf8'))
      const storedBusiness = storedAfterCreate.find((row) => row.id === business.id)
      assert.equal(storedBusiness.name, 'Fixture Product')
      assert.equal(storedBusiness.nameSource, 'auto')
      assert.equal(Object.hasOwn(storedBusiness, 'icon'), false)

      const patched = await api(`/api/projects/${business.id}`, {
        method: 'PATCH',
        body: { name: 'Owner Product Name' }
      })
      assert.equal(patched.status, 200, JSON.stringify(patched.data))
      assert.equal(patched.data.business.name, 'Owner Product Name')
      assert.equal(patched.data.business.nameSource, 'user')
      assert.equal(patched.data.business.logo, business.logo)
      console.log('ACCEPT project rename', JSON.stringify(patched.data.business))
      const storedAfterPatch = JSON.parse(await readFile(join(dataDir, 'businesses.json'), 'utf8'))
      assert.equal(storedAfterPatch.find((row) => row.id === business.id).nameSource, 'user')

      const emptyDir = join(root, 'empty-project')
      await mkdir(emptyDir)
      const emptyCreated = await api('/api/projects', { body: { path: emptyDir } })
      assert.equal(emptyCreated.status, 200, JSON.stringify(emptyCreated.data))
      const emptyBusiness = emptyCreated.data.business
      assert.equal(emptyBusiness.logo, undefined)

      invalidate()
      const overviewResponse = await api('/api/overview')
      assert.equal(overviewResponse.status, 200, JSON.stringify(overviewResponse.data))
      const overview = overviewResponse.data
      const overviewBusiness = overview.businesses.find((row) => row.id === business.id)
      assert.equal(overviewBusiness.name, 'Owner Product Name')
      assert.equal(overviewBusiness.nameSource, 'user')
      assert.equal(overviewBusiness.logo, business.logo)
      assert.deepEqual(overviewBusiness.lastEvent, business.lastEvent)
      assert.ok(overview.recentEvents.some((row) => row.id === business.lastEvent.id))
      assert.ok(overview.recentEvents.some((row) => row.businessId === emptyBusiness.id))
      console.log(
        'ACCEPT overview',
        JSON.stringify({
          businesses: overview.businesses.map((row) => ({
            id: row.id,
            name: row.name,
            nameSource: row.nameSource,
            logo: row.logo,
            lastEvent: row.lastEvent?.id
          })),
          recentEvents: overview.recentEvents.map((row) => row.id)
        })
      )

      const detailResponse = await api(`/api/businesses/${business.id}`)
      assert.equal(detailResponse.status, 200, JSON.stringify(detailResponse.data))
      assert.deepEqual(detailResponse.data.recentEvents, [business.lastEvent])

      const versionedLogo = await api(business.logo)
      assert.equal(versionedLogo.status, 200)
      assert.equal(versionedLogo.headers.get('content-type'), 'image/png')
      assert.equal(
        versionedLogo.headers.get('content-security-policy'),
        "default-src 'none'; style-src 'unsafe-inline'"
      )
      assert.equal(versionedLogo.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(
        versionedLogo.headers.get('cache-control'),
        'public, max-age=31536000, immutable'
      )
      assert.deepEqual(versionedLogo.bytes, logoBytes)
      const unversionedLogo = await api(`/api/projects/${business.id}/logo`)
      assert.equal(unversionedLogo.status, 200)
      assert.equal(unversionedLogo.headers.get('cache-control'), 'no-store')
      assert.deepEqual(unversionedLogo.bytes, logoBytes)
      console.log(
        'ACCEPT logo',
        JSON.stringify({
          status: versionedLogo.status,
          contentType: versionedLogo.headers.get('content-type'),
          cacheControl: versionedLogo.headers.get('cache-control'),
          bytes: versionedLogo.bytes.toString('hex')
        })
      )
      assert.equal((await api(`/api/projects/${emptyBusiness.id}/logo`)).status, 404)
      assert.equal((await api('/api/projects/unknown-project/logo')).status, 404)

      await writeFile(
        join(emptyDir, 'package.json'),
        JSON.stringify({ productName: 'Detected Later' })
      )
      invalidate()
      const refreshedOverview = (await api('/api/overview')).data
      assert.equal(
        refreshedOverview.businesses.find((row) => row.id === emptyBusiness.id).name,
        'Detected Later'
      )
      assert.equal(
        state.repos.find((repo) => repo.id === emptyBusiness.repoId).displayName,
        'Detected Later'
      )

      const projectPath = business.workspacePath
      const rows = JSON.parse(await readFile(join(dataDir, 'businesses.json'), 'utf8'))
      rows.find((row) => row.id === business.id).runIds = ['run-1']
      await writeFile(join(dataDir, 'businesses.json'), `${JSON.stringify(rows, null, 2)}\n`)

      const base = Date.now()
      const at = (seconds) => new Date(base + seconds * 1000).toISOString()
      state.runs = [
        {
          id: 'run-1',
          objective: 'Fixture objective',
          coordinator_handle: 'leader-fixture',
          created_at: at(1)
        }
      ]
      state.tasks = [
        {
          id: 'task-1',
          run_id: 'run-1',
          spec: 'Build identity timeline',
          status: 'dispatched',
          dispatch_id: 'dispatch-1',
          deps: '[]',
          created_at: at(2),
          updated_at: at(2)
        }
      ]
      state.gates = [
        {
          id: 'gate-1',
          run_id: 'run-1',
          task_id: 'task-1',
          question: 'Ship the fixture?',
          options: JSON.stringify(['Ship', 'Hold']),
          status: 'pending',
          created_at: at(2.5)
        }
      ]

      const dispatchResponse = await api('/api/dispatches', {
        body: {
          handle: 'missing-dispatch-terminal',
          project: projectPath,
          agent: 'codex',
          title: 'Fixture dispatch',
          prompt: 'Exercise dispatch failure',
          by: { kind: 'cli', id: 'fixture-owner', label: 'Fixture owner', cwd: projectPath }
        }
      })
      assert.equal(dispatchResponse.status, 200, JSON.stringify(dispatchResponse.data))
      const dispatchId = dispatchResponse.data.id

      invalidate()
      const createdEvents = (await timeline(`?businessId=${business.id}&limit=100`)).items
      const dispatchCreated = event(createdEvents, `dispatch:${dispatchId}:created`)
      assert.equal(dispatchCreated.kind, 'task')
      assert.equal(dispatchCreated.taskId, dispatchId)
      assert.equal(dispatchCreated.agent, 'codex')
      assert.equal(dispatchCreated.terminal, 'missing-dispatch-terminal')
      assert.equal(dispatchCreated.path, projectPath)
      assert.match(dispatchCreated.title, /^派活：/)
      assert.match(event(createdEvents, `dispatch:${dispatchId}:failed`).title, /^任务失败：/)
      const taskCreated = event(createdEvents, 'task:task-1:created')
      assert.equal(taskCreated.taskId, 'task-1')
      assert.equal(taskCreated.path, projectPath)
      const gateCreated = event(createdEvents, 'decision:gate-1:created')
      assert.equal(gateCreated.decisionId, 'gate-1')
      assert.equal(gateCreated.taskId, 'task-1')
      assert.equal(gateCreated.path, projectPath)

      const pendingResponse = await api(`/api/decisions?businessId=${business.id}&state=pending`)
      assert.equal(pendingResponse.status, 200, JSON.stringify(pendingResponse.data))
      assert.equal(pendingResponse.data.length, 1)
      assert.equal(pendingResponse.data[0].id, 'gate-1')
      assert.equal(pendingResponse.data[0].source, 'gate')
      assert.deepEqual(pendingResponse.data[0].options, ['Ship', 'Hold'])

      state.workers = [
        {
          runId: 'run-1',
          dispatchId: 'dispatch-1',
          taskId: 'task-1',
          terminalState: 'active',
          projection: {
            provider: { id: 'codex', model: 'fixture-model' },
            liveness: { verdict: 'live' }
          }
        }
      ]
      state.workerShows['dispatch-1'] = {
        worker: { createdAt: at(3), startOptions: { agent: 'codex' } },
        dispatch: { dispatchedAt: at(3) },
        terminal: { handle: 'worker-terminal' }
      }
      state.terminals = [
        {
          handle: 'notification-terminal',
          incarnationId: 'incarnation-1',
          paneKey: 'pane-1',
          worktreeId: 'worktree-1',
          worktreePath: projectPath,
          agentIdentity: 'codex',
          title: 'Fixture notification terminal'
        }
      ]
      state.worktrees = [{ id: 'worktree-1', path: projectPath }]
      invalidate()
      const startedEvents = (await timeline(`?businessId=${business.id}&limit=100`)).items
      const workerStarted = event(startedEvents, 'worker:dispatch-1:started')
      assert.equal(workerStarted.kind, 'worker')
      assert.equal(workerStarted.taskId, 'task-1')
      assert.equal(workerStarted.agent, 'codex')
      assert.equal(workerStarted.terminal, 'worker-terminal')
      assert.equal(workerStarted.path, projectPath)
      const terminalOpened = startedEvents.find((row) =>
        row.id.startsWith('terminal:opened:incarnation-1:')
      )
      assert.ok(terminalOpened)
      assert.equal(terminalOpened.terminal, 'notification-terminal')
      assert.equal(terminalOpened.path, projectPath)

      const enqueuedResponse = await api('/api/decisions/gate-1/resolve', {
        body: { choice: 'Ship', note: 'Go', custom: false }
      })
      assert.equal(enqueuedResponse.status, 200, JSON.stringify(enqueuedResponse.data))
      assert.equal(enqueuedResponse.data.delivery, 'enqueued')
      assert.equal(enqueuedResponse.data.state, 'pending')
      const ownerMessage = state.messages.find(
        (row) => row.from_handle === 'opc-owner' && JSON.parse(row.payload).gateId === 'gate-1'
      )
      assert.ok(ownerMessage)
      assert.equal(JSON.parse(ownerMessage.payload).choice, 'Ship')
      ownerMessage.created_at = at(4)
      invalidate()
      const enqueuedDecisions = await api(`/api/decisions?businessId=${business.id}&state=pending`)
      assert.equal(enqueuedDecisions.data[0].delivery, 'enqueued')
      const beforeActualResolution = await timeline(`?businessId=${business.id}&limit=100`)
      assert.equal(
        beforeActualResolution.items.some((row) => row.id === 'decision:gate-1:resolved'),
        false
      )

      state.gates[0].status = 'resolved'
      state.gates[0].resolved_at = at(5)
      state.gates[0].resolution = JSON.stringify({ choice: 'Ship', note: 'Go', custom: false })
      state.messages.push({
        id: 'worker-done-1',
        run_id: 'run-1',
        from_handle: 'worker-terminal',
        to_handle: 'leader-fixture',
        type: 'worker_done',
        subject: 'Identity finished',
        body: 'Worker summary: all fixture checks passed',
        payload: JSON.stringify({
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          outcome: 'succeeded',
          filesModified: ['fixture.txt']
        }),
        created_at: at(6)
      })
      state.messages.push({
        id: 'worker-done-2',
        run_id: 'run-1',
        from_handle: 'worker-terminal',
        to_handle: 'leader-fixture',
        type: 'worker_done',
        subject: 'Identity retry finished',
        body: 'Second worker summary is retained',
        payload: JSON.stringify({
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          outcome: 'succeeded'
        }),
        created_at: at(6.5)
      })
      state.tasks[0].status = 'completed'
      state.tasks[0].updated_at = at(7)
      state.tasks[0].completed_at = at(7)
      invalidate()
      const finishedEvents = (await timeline(`?businessId=${business.id}&limit=100`)).items
      const resolved = event(finishedEvents, 'decision:gate-1:resolved')
      assert.equal(resolved.decisionId, 'gate-1')
      assert.equal(resolved.taskId, 'task-1')
      assert.equal(resolved.path, projectPath)
      assert.match(resolved.title, /^待办已处理：/)
      assert.match(resolved.detail, /Ship/)
      assert.match(resolved.detail, /Go/)
      const report = event(finishedEvents, 'worker-report:worker-done-1')
      assert.equal(report.detail, 'Worker summary: all fixture checks passed')
      assert.equal(report.taskId, 'task-1')
      assert.equal(report.agent, 'codex')
      assert.equal(report.terminal, 'worker-terminal')
      assert.equal(report.path, projectPath)
      assert.equal(
        event(finishedEvents, 'worker-report:worker-done-2').detail,
        'Second worker summary is retained'
      )
      const completed = event(finishedEvents, `task:task-1:completed:${at(7)}`)
      assert.match(completed.title, /^任务完成：/)
      assert.equal(completed.taskId, 'task-1')
      assert.equal(completed.agent, 'codex')
      assert.equal(completed.terminal, 'worker-terminal')
      console.log(
        'ACCEPT timeline flow',
        JSON.stringify(
          [dispatchCreated, workerStarted, report, gateCreated, resolved, completed].map((row) => ({
            id: row.id,
            ts: row.ts,
            title: row.title,
            detail: row.detail
          }))
        )
      )

      state.notifications = [
        {
          type: 'notification',
          source: 'agent-task-complete',
          agentState: 'done',
          notificationEpoch: 'epoch-test',
          notificationSeq: 1,
          paneKey: 'pane-1',
          worktreeId: 'worktree-1',
          emittedAt: Date.parse(at(8)),
          title: 'Agent turn complete',
          body: 'Notification summary'
        }
      ]
      invalidate()
      const notifiedEvents = (await timeline(`?businessId=${business.id}&limit=100`)).items
      const notification = event(notifiedEvents, 'notification:epoch-test:1')
      assert.equal(notification.kind, 'worker')
      assert.equal(notification.detail, 'Notification summary')
      assert.equal(notification.agent, 'codex')
      assert.equal(notification.terminal, 'notification-terminal')
      assert.equal(notification.path, projectPath)

      state.terminals = []
      invalidate()
      const allForBusiness = (await timeline(`?businessId=${business.id}&limit=100`)).items
      const terminalClosed = allForBusiness.find((row) =>
        row.id.startsWith('terminal:closed:incarnation-1:')
      )
      assert.ok(terminalClosed)
      assert.equal(terminalClosed.terminal, 'notification-terminal')
      assert.equal(terminalClosed.path, projectPath)
      assert.ok(
        allForBusiness.every(
          (row, index) =>
            index === 0 || Date.parse(allForBusiness[index - 1].ts) >= Date.parse(row.ts)
        )
      )

      const globalTimeline = await timeline('?limit=100')
      assert.ok(globalTimeline.items.some((row) => row.businessId === emptyBusiness.id))
      const emptyTimeline = await timeline(`?businessId=${emptyBusiness.id}&limit=100`)
      assert.ok(emptyTimeline.items.length > 0)
      assert.ok(emptyTimeline.items.every((row) => row.businessId === emptyBusiness.id))
      assert.ok(allForBusiness.every((row) => row.businessId === business.id))

      const firstPage = await timeline(`?businessId=${business.id}&limit=3`)
      assert.equal(firstPage.items.length, 3)
      assert.ok(firstPage.nextCursor)
      const secondPage = await timeline(
        `?businessId=${business.id}&limit=3&cursor=${encodeURIComponent(firstPage.nextCursor)}`
      )
      assert.equal(secondPage.items.length, 3)
      console.log(
        'ACCEPT timeline pages',
        JSON.stringify({
          first: firstPage.items.map((row) => row.id),
          nextCursor: firstPage.nextCursor,
          second: secondPage.items.map((row) => row.id),
          secondCursor: secondPage.nextCursor
        })
      )
      const pagedItems = [...firstPage.items, ...secondPage.items]
      assert.equal(new Set(pagedItems.map((row) => row.id)).size, pagedItems.length)
      assert.deepEqual(
        pagedItems.map((row) => row.id),
        allForBusiness.slice(0, 6).map((row) => row.id)
      )
      let cursor = secondPage.nextCursor
      while (cursor) {
        const page = await timeline(
          `?businessId=${business.id}&limit=3&cursor=${encodeURIComponent(cursor)}`
        )
        pagedItems.push(...page.items)
        cursor = page.nextCursor
      }
      assert.deepEqual(
        pagedItems.map((row) => row.id),
        allForBusiness.map((row) => row.id)
      )

      invalidate()
      const finalOverview = (await api('/api/overview')).data
      assert.deepEqual(
        finalOverview.businesses.find((row) => row.id === business.id).lastEvent,
        allForBusiness[0]
      )
      assert.deepEqual(finalOverview.recentEvents, globalTimeline.items.slice(0, 20))

      await closeHttp(bridge)
      bridge = await startBridge({ port: 0, lanPort: false })
      invalidate()
      const afterRestart = await timeline(`?businessId=${business.id}&limit=100`)
      assert.deepEqual(afterRestart.items, allForBusiness)
      assert.equal(afterRestart.nextCursor, null)
      console.log(
        'ACCEPT timeline restart',
        JSON.stringify({ persisted: true, events: afterRestart.items.length })
      )
      const removed = await api(`/api/projects/${emptyBusiness.id}`, { method: 'DELETE' })
      assert.equal(removed.status, 200, JSON.stringify(removed.data))
      const removalEvents = await timeline(`?businessId=${emptyBusiness.id}&limit=100`)
      assert.ok(removalEvents.items.some((row) => row.title.startsWith('项目移除：')))
    } finally {
      await closeHttp(bridge)
      bridge = undefined
      closeRuntimeConnection?.()
      for (const socket of sockets) {
        socket.destroy()
      }
      if (runtime?.listening) {
        runtime.close()
        await once(runtime, 'close')
      }
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  }
)

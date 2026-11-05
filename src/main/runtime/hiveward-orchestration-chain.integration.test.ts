import { openTestAgentSessionRecordStore } from './agent-session/records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HiveWardRuntimeRpcServer } from './runtime-rpc'
import { createOrchestrationWorkerReleaseHarness } from './rpc/methods/orchestration/worker/worker-release.test-support'
import { TerminalWorkerTurnStops } from './orchestration/terminal-worker-turn-stops'
import { getWorkerTerminalAutoReleaseScheduler } from './orchestration/worker-terminal-auto-release-scheduler'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'

it('HiveWard 独立 HTTP + RPC + SQLite：派单、交活、上级取信、复核释放和两种停下提醒', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hiveward-chain-'))
  mkdirSync(join(root, 'hiveward'))
  writeFileSync(join(root, 'hiveward', 'businesses.json'), '[]\n')
  const h = createOrchestrationWorkerReleaseHarness()
  h.setup({ userDataDir: root })
  const records = await openTestAgentSessionRecordStore(root)
  vi.spyOn(h.runtime, 'openAgentSessionRecordStore').mockResolvedValue(records)
  vi.mocked(h.runtime.notifyMessageArrived).mockRestore()
  let incarnation = 0
  vi.mocked(h.runtime.createTerminal).mockImplementation(async () => {
    incarnation++
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 沿用原生终端夹具的返回形状，只给每次启动独立进程身份。
    return { handle: 'term_worker', worktreeId: 'repo::worktree', status: 'running' } as never
  })
  vi.mocked(h.runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
    handle === 'term_worker' ? `runtime_test:term_worker:${incarnation}` : null
  )
  vi.mocked(h.runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) =>
    handle === 'term_worker'
      ? {
          runtimeId: 'runtime_test',
          ptyId: 'pty_test',
          worktreeId: 'repo::worktree',
          launchTokenHash: 'fixture-launch-token',
          terminalHandle: handle,
          paneKey: h.workerPaneKey,
          processIncarnation: `runtime_test:term_worker:${incarnation}`,
          hostScope: { kind: 'local', hostId: 'local' }
        }
      : null
  )
  const rpc = new HiveWardRuntimeRpcServer({ runtime: h.runtime, userDataPath: root })
  await rpc.start()
  const nativeCall = (method: string, params: Record<string, unknown>, sessionId: string) => {
    const metadata: { authToken: string; transports: { kind: string; endpoint: string }[] } =
      JSON.parse(readFileSync(join(root, 'hiveward-runtime.json'), 'utf8'))
    const transport = metadata.transports.find((t) => t.kind === 'unix')!
    return new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(transport.endpoint)
      const id = randomUUID()
      let buffer = ''
      socket.setEncoding('utf8')
      socket.setTimeout(10000, () => socket.destroy(new Error('HiveWard 测试 RPC 超时')))
      socket.on('error', reject)
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const end = buffer.indexOf('\n')
        if (end === -1) {
          return
        }
        const frame = JSON.parse(buffer.slice(0, end))
        socket.destroy()
        if (frame.ok) {
          resolve(frame.result)
        } else {
          reject(new Error(JSON.stringify(frame.error)))
        }
      })
      socket.on('connect', () =>
        socket.write(
          `${JSON.stringify({ id, authToken: metadata.authToken, method, params, hivewardSessionId: sessionId, orchestrationContractVersion: 1, orchestrationRequestId: id })}\n`
        )
      )
    })
  }
  const bridgeScript = join(root, 'bridge.mjs')
  const bridgeUrl = new URL('../../../hiveward/server/hiveward-bridge.mjs', import.meta.url).href
  writeFileSync(
    bridgeScript,
    `import { startBridge } from ${JSON.stringify(bridgeUrl)};\nconst server = await startBridge({ port: 0, lanPort: false, regionGuard: { observe: async () => {}, beforeRpc: async () => {}, assertAllowed: async () => {}, status: async () => ({ country: 'US' }), warnings: () => [] } });\nprocess.on('SIGTERM', () => server.close(() => process.exit()));\n`
  )
  vi.spyOn(h.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('hiveward')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 仓库显示名写入只作用于夹具目录，不访问用户仓库配置。
  vi.spyOn(h.runtime, 'updateRepo').mockResolvedValue({
    id: 'repo',
    path: root,
    kind: 'folder',
    displayName: '临时验证'
  } as never)
  vi.spyOn(h.runtime, 'getTerminalAgentStatus').mockResolvedValue({
    handle: 'term_worker',
    isRunningAgent: true,
    status: 'idle'
  })
  vi.spyOn(h.runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
    supported: false,
    reason: 'agent'
  })
  vi.spyOn(h.runtime, 'enrichMissingRepoGitRemoteIdentities').mockImplementation(() => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 此夹具仅消费项目目录字段，原生仓库访问已替换。
  vi.spyOn(h.runtime, 'listVisibleRepos').mockReturnValue([
    { id: 'repo', path: root, kind: 'folder', displayName: '临时验证' }
  ] as never)
  vi.spyOn(h.runtime, 'listManagedWorktrees').mockResolvedValue({
    worktrees: [],
    totalCount: 0,
    truncated: false
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 终端边界由现有编排夹具替换，此列表只给桥接投影使用。
  vi.spyOn(h.runtime, 'listTerminals').mockResolvedValue({
    terminals: [
      { handle: 'term_coord', worktreePath: root, agentIdentity: 'claude' },
      { handle: 'term_worker', worktreePath: root, agentIdentity: 'claude' }
    ]
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 桥接仅查询前台是否有子进程，不访问原生进程信息。
  vi.spyOn(h.runtime, 'inspectTerminalProcess').mockResolvedValue({
    hasChildProcesses: true,
    foregroundProcess: 'claude'
  } as never)
  const child = spawn(process.execPath, [bridgeScript], {
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      TMPDIR: '/tmp',
      HIVEWARD_BACKGROUND_LAUNCH: '1',
      HIVEWARD_DEV_USER_DATA_PATH: root,
      HIVEWARD_DATA_DIR: join(root, 'hiveward'),
      HIVEWARD_RUNTIME_META: join(root, 'hiveward-runtime.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  try {
    await vi.waitFor(() => expect(output).toContain('HiveWard bridge on http://127.0.0.1:'), {
      timeout: 10000
    })
    const base = /HiveWard bridge on (http:\/\/127.0.0.1:\d+)/.exec(output)?.[1]
    expect(base).toBeDefined()
    const response = await fetch(`${base}/api/workers/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hiveward-caller': 'agent',
        'x-hiveward-dispatcher-id': 'term_coord'
      },
      body: JSON.stringify({ path: root, agent: 'claude', prompt: '离线完成测试任务' })
    })
    const started = await response.json()
    expect(started, JSON.stringify(started)).toMatchObject({
      state: 'ready',
      terminal: 'term_worker'
    })
    expect(vi.mocked(h.runtime.sendTerminalAgentPrompt).mock.calls[0]?.[1]).toContain(
      'hiveward orchestration send'
    )
    const { taskId, dispatchId } = started
    await h.call('orchestration.send', {
      from: 'term_worker',
      type: 'worker_done',
      subject: '完成',
      body: '已完成。检查通过。没有遗留。',
      payload: JSON.stringify({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        filesModified: ['result.txt'],
        reportPath: join(root, 'report.md')
      })
    })
    const checked = await h.call('orchestration.check', { terminal: 'term_coord' })
    expect(checked).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
    })
    const accepted = await fetch(`${base}/api/tasks/${taskId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'accept' })
    })
    const receipt = await accepted.json()
    expect(receipt, JSON.stringify(receipt)).toMatchObject({
      release: { state: 'released' },
      task: { review: { state: 'accepted' } }
    })
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    console.log(
      `ACCEPT 派单 ${taskId} → worker_done → 上级取信 → 通过 → released；HTTP ${base}；SQLite ${root}`
    )
    for (const reason of ['finished', 'errored', 'needs-input'] as const) {
      const next = await h.startWorker({ agent: 'claude' })
      const row: AgentStatusIpcPayload = {
        state: reason === 'needs-input' ? 'waiting' : 'done',
        prompt: '',
        agentType: 'claude',
        paneKey: h.workerPaneKey,
        connectionId: null,
        receivedAt: 1,
        stateStartedAt: Date.now(),
        ...(reason === 'errored'
          ? { mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: Date.now() } }
          : {})
      }
      const stops = new TerminalWorkerTurnStops({
        getDb: () => h.db,
        readHookRow: () => row,
        isWaitingForMail: () => false,
        getHandle: () => 'term_worker',
        getProcessIncarnation: () => `runtime_test:term_worker:${incarnation}`,
        setTimer: (run) => {
          queueMicrotask(run)
          return { cancel() {} }
        },
        readScreen: async () => ({
          handle: 'term_worker',
          status: 'running',
          tail: ['最后一屏：离线测试错误'],
          truncated: false,
          nextCursor: null
        }),
        notify: (to, type) => h.runtime.notifyMessageArrived(to, type)
      })
      stops.observe({
        kind: 'moved',
        paneKey: h.workerPaneKey,
        workspace: { worktreeId: 'repo::worktree', sshHostId: null },
        from: 'working',
        to: reason === 'needs-input' ? 'needs-you' : 'done',
        at: Date.now(),
        transition: 'turn-finished'
      })
      await vi.waitFor(() =>
        expect(
          h.db
            .getUnreadRunMailbox(h.activeRunId, 100, ['escalation'])
            .some((m) => JSON.parse(m.payload ?? '{}').dispatchId === next.dispatchId)
        ).toBe(true)
      )
      const message = h.db
        .getUnreadRunMailbox(h.activeRunId, 100, ['escalation'])
        .find((m) => JSON.parse(m.payload ?? '{}').dispatchId === next.dispatchId)
      expect(JSON.parse(message?.payload ?? '{}').stopReason).toBe(reason)
      expect(h.db.getTask(next.taskId)?.status).toBe('dispatched')
      await vi.waitFor(
        async () => {
          const stoppedTasks = await (await fetch(`${base}/api/tasks`)).json()
          const stoppedTask = stoppedTasks.find((task: { id: string }) => task.id === next.taskId)
          expect(stoppedTask).toMatchObject({ status: 'dispatched' })
          expect(stoppedTask.report).toBeUndefined()
          expect(stoppedTask.review).toBeUndefined()
          expect(!!stoppedTask.errorStop).toBe(reason === 'errored')
        },
        { timeout: 4000 }
      )
      console.log(`ACCEPT ${reason}: ${message?.subject}；Task 保持 dispatched；附最后一屏`)
      await h.call('orchestration.workerStop', { dispatch: next.dispatchId })
    }
    const externalHeaders = {
      'content-type': 'application/json',
      'x-hiveward-caller': 'agent',
      'x-hiveward-dispatcher-id': 'desktop-fixture',
      'x-hiveward-dispatcher-kind': 'claude-desktop',
      'x-hiveward-dispatcher-label': encodeURIComponent('Claude 桌面端'),
      'x-hiveward-dispatcher-cwd': encodeURIComponent(root)
    }
    const externalResponse = await fetch(`${base}/api/workers/start`, {
      method: 'POST',
      headers: externalHeaders,
      body: JSON.stringify({ path: root, agent: 'claude', prompt: '外部会话派单' })
    })
    const external = await externalResponse.json()
    expect(external, JSON.stringify(external)).toMatchObject({
      state: 'ready',
      identity: { address: expect.stringMatching(/^hiveward_session_id:hiveward_/) }
    })
    expect(h.db.getRun(external.runId)).toMatchObject({
      coordinator_handle: null,
      coordinator_hiveward_session_id: external.identity.sessionId
    })
    const waitSpy = vi.spyOn(h.runtime, 'waitForMessage')
    const cli = spawn(
      process.execPath,
      [
        join(process.cwd(), 'hiveward/server/hiwd.mjs'),
        'orchestration',
        'check',
        '--wait',
        '--timeout-ms',
        '10000',
        '--json',
        '--full'
      ],
      {
        cwd: root,
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TMPDIR: '/tmp',
          HIVEWARD_BACKGROUND_LAUNCH: '1',
          HIVEWARD_BRIDGE: base,
          HIVEWARD_DATA_DIR: join(root, 'hiveward'),
          HIVEWARD_USER_DATA_PATH: root,
          CLAUDE_CODE_SESSION_ID: 'desktop-fixture',
          CLAUDE_CODE_ENTRYPOINT: 'claude-desktop'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let cliOut = '',
      cliError = ''
    cli.stdout.on('data', (chunk: Buffer) => {
      cliOut += chunk.toString()
    })
    cli.stderr.on('data', (chunk: Buffer) => {
      cliError += chunk.toString()
    })
    const cliExit = once(cli, 'exit')
    try {
      await vi.waitFor(
        () => {
          expect(cli.exitCode, cliError + cliOut).toBeNull()
          expect(waitSpy).toHaveBeenCalledWith(`run:${external.runId}`, expect.anything())
        },
        { timeout: 10000 }
      )
      await h.call('orchestration.send', {
        from: 'term_worker',
        type: 'worker_done',
        subject: '交活',
        body: '已实现。已验证。没有遗留。',
        payload: JSON.stringify({
          taskId: external.taskId,
          dispatchId: external.dispatchId,
          outcome: 'succeeded',
          filesModified: ['external.txt'],
          reportPath: join(root, 'external-report.md')
        })
      })
      const [code] = await cliExit
      expect(code, cliError).toBe(0)
      expect(cliOut).toContain('worker_done')
      expect(cliOut).toContain(external.taskId)
    } finally {
      if (cli.exitCode === null) {
        cli.kill()
        await cliExit
      }
    }
    console.log(
      `ACCEPT 外部会话派单 ${external.taskId} → 无终端 session → hiwd orchestration check 阻塞取到 worker_done`
    )
    const reworkResponse = await fetch(`${base}/api/tasks/${external.taskId}/review`, {
      method: 'POST',
      headers: externalHeaders,
      body: JSON.stringify({ verdict: 'rework', note: '补充离线验证' })
    })
    const reworked = await reworkResponse.json()
    expect(reworked, JSON.stringify(reworked)).toMatchObject({
      followUp: { state: 'ready', taskId: expect.any(String), dispatchId: expect.any(String) }
    })
    const followUp = reworked.followUp
    expect(followUp.taskId).not.toBe(external.taskId)
    expect(h.db.getDispatchContextById(followUp.dispatchId)?.follow_up_of_dispatch_id).toBe(
      external.dispatchId
    )
    await h.call('orchestration.send', {
      from: 'term_worker',
      type: 'worker_done',
      subject: '补充完成',
      body: '补充完成。检查通过。没有遗留。',
      payload: JSON.stringify({
        taskId: followUp.taskId,
        dispatchId: followUp.dispatchId,
        outcome: 'succeeded'
      })
    })
    const inboxResponse = await fetch(`${base}/api/inbox/wait?timeout=1`, {
      headers: externalHeaders
    })
    const externalMail = await inboxResponse.json()
    expect(externalMail, JSON.stringify(externalMail)).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
    })
    const externalAccept = await fetch(`${base}/api/tasks/${followUp.taskId}/review`, {
      method: 'POST',
      headers: externalHeaders,
      body: JSON.stringify({ verdict: 'accept' })
    })
    const externalAccepted = await externalAccept.json()
    expect(externalAccepted, JSON.stringify(externalAccepted)).toMatchObject({
      release: { state: 'released' }
    })
    expect(h.db.getWorkerTerminalResourceByOwner(followUp.dispatchId)?.release_state).toBe(
      'released'
    )
    console.log(
      `ACCEPT 外部会话打回 → 后续 Task ${followUp.taskId} → 再报 worker_done → 自己邮箱取到 → 通过 → released`
    )
    const afterReworkTasks = await (await fetch(`${base}/api/tasks`)).json()
    expect(
      afterReworkTasks.find((task: { id: string }) => task.id === external.taskId)
    ).toMatchObject({ review: { state: 'rework' }, report: { outcome: 'succeeded' } })
    const terminalCreates = vi.mocked(h.runtime.createTerminal).mock.calls.length
    const simpleResponse = await fetch(`${base}/api/workers/start`, {
      method: 'POST',
      headers: externalHeaders,
      body: JSON.stringify({ path: root, agent: 'claude', prompt: '外部会话直接通过' })
    })
    const simple = await simpleResponse.json()
    expect(simple.identity).toEqual(external.identity)
    expect(vi.mocked(h.runtime.createTerminal).mock.calls.length).toBe(terminalCreates + 1)
    await h.call('orchestration.send', {
      from: 'term_worker',
      type: 'worker_done',
      subject: '完成',
      body: '外部任务完成。',
      payload: JSON.stringify({
        taskId: simple.taskId,
        dispatchId: simple.dispatchId,
        outcome: 'succeeded'
      })
    })
    const simpleMail = await (
      await fetch(`${base}/api/inbox/wait?timeout=1`, { headers: externalHeaders })
    ).json()
    expect(
      simpleMail.messages.some(
        (message: { payload: string }) => JSON.parse(message.payload).taskId === simple.taskId
      )
    ).toBe(true)
    const simpleAccepted = await (
      await fetch(`${base}/api/tasks/${simple.taskId}/review`, {
        method: 'POST',
        headers: externalHeaders,
        body: JSON.stringify({ verdict: 'accept' })
      })
    ).json()
    expect(simpleAccepted.release.state).toBe('released')
    expect(h.db.getWorkerTerminalResourceByOwner(simple.dispatchId)?.release_state).toBe('released')
    console.log(
      `ACCEPT 外部派单方 ${simple.identity.address} → ${simple.taskId} → worker_done → 自己邮箱取到 → 通过 → released；只创建一个下属终端`
    )
    const ownerResponse = await fetch(`${base}/api/workers/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root, agent: 'claude', prompt: '老板独立会话提问验收' })
    })
    const ownerWorker = await ownerResponse.json()
    expect(ownerWorker.state, JSON.stringify(ownerWorker)).toBe('ready')
    await h.call('orchestration.ask', {
      from: 'term_worker',
      question: '交付放在哪个目录？',
      options: '成品目录,临时目录',
      wait: false
    })
    const question = h.db
      .getInbox(-1)
      .find((m) => m.type === 'question' && m.body === '交付放在哪个目录？')!
    expect(question).toBeDefined()
    const answered = await fetch(`${base}/api/decisions/${question.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: '成品目录' })
    })
    expect(await answered.json()).toMatchObject({ state: 'resolved' })
    expect(h.db.getQuestion(question.id)).toMatchObject({
      status: 'answered',
      answer_body: '成品目录'
    })
    expect(await h.call('orchestration.check', { terminal: 'term_worker' })).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          body: '成品目录',
          thread_id: question.id,
          to_handle: `dispatch:${ownerWorker.dispatchId}`
        })
      ])
    })
    await h.call('orchestration.send', {
      from: 'term_worker',
      type: 'worker_done',
      subject: '回答后交活',
      body: '已按成品目录交付',
      payload: JSON.stringify({
        taskId: ownerWorker.taskId,
        dispatchId: ownerWorker.dispatchId,
        outcome: 'succeeded'
      })
    })
    expect(
      (
        await (
          await fetch(`${base}/api/tasks/${ownerWorker.taskId}/review`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ verdict: 'accept' })
          })
        ).json()
      ).release.state
    ).toBe('released')
    console.log(
      `ACCEPT 提问立即返回 → 网页 reply → 原生 Dispatch 答案邮件 → worker_done；HTTP ${base}；SQLite ${root}；PTY 夹具`
    )
    await nativeCall(
      'orchestration.taskCreate',
      {
        callerTerminalHandle: ownerWorker.identity.address,
        run: ownerWorker.runId,
        spec: '老板审批独立 Task'
      },
      ownerWorker.identity.sessionId
    )
    const approvalTask = h.db
      .listTasksWithDispatch({ runId: ownerWorker.runId })
      .find((t) => t.spec === '老板审批独立 Task')!
    await nativeCall(
      'orchestration.gateCreate',
      {
        from: ownerWorker.identity.address,
        run: ownerWorker.runId,
        task: approvalTask.id,
        question: '是否同意执行？',
        options: JSON.stringify(['同意执行', '拒绝'])
      },
      ownerWorker.identity.sessionId
    )
    const gate = h.db.listGates({ taskId: approvalTask.id })[0]
    const gateResponse = await fetch(`${base}/api/decisions/${gate.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: '同意执行' })
    })
    expect(await gateResponse.json()).toMatchObject({ state: 'resolved' })
    expect(h.db.getGate(gate.id)?.status).toBe('resolved')
    expect(JSON.parse(h.db.getGate(gate.id)!.resolution!)).toMatchObject({
      choice: '同意执行',
      hivewardOwner: true
    })
    console.log(
      `ACCEPT 原生 Task → gateCreate → 网页 gateResolve → SQLite resolved；gate ${gate.id}；PTY 夹具`
    )
    expect(readFileSync(join(root, 'hiveward', 'work-records.json'), 'utf8')).toContain(taskId)
  } finally {
    child.kill('SIGTERM')
    await once(child, 'exit')
    await rpc.stop()
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
    await closeTestJournalHostDatabase(root)
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)

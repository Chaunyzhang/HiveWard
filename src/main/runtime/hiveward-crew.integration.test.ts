import { mkdtempSync, rmSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './rpc/methods/orchestration/worker/worker-release.test-support'

it('HiveWard 三层原生关系：Leader → 下属 → 孙级；孙级交活只回直接上级', async () => {
  const root = mkdtempSync('/tmp/hiveward-crew-')
  const h = createOrchestrationWorkerReleaseHarness()
  h.setup({ userDataDir: root })
  expect(h.runtime.getNestedWorkerMaxDepth()).toBe(4)
  let sequence = 0
  const panes = new Map([['term_coord', h.coordinatorPaneKey]])
  vi.mocked(h.runtime.createTerminal).mockImplementation(async () => {
    const handle = `term_hiveward_${++sequence}`
    panes.set(
      handle,
      `tab_${sequence}:00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
    )
    return { handle, worktreeId: 'repo::worktree', title: handle }
  })
  vi.mocked(h.runtime.getTerminalPaneKey).mockImplementation((handle) => panes.get(handle) ?? null)
  vi.mocked(h.runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
    panes.has(handle) ? `hiveward:${handle}:1` : null
  )
  vi.mocked(h.runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) => {
    const paneKey = panes.get(handle)
    return paneKey
      ? {
          runtimeId: 'hiveward-test',
          ptyId: handle,
          worktreeId: 'repo::worktree',
          launchTokenHash: 'test-launch-token',
          terminalHandle: handle,
          paneKey,
          processIncarnation: `hiveward:${handle}:1`,
          hostScope: { kind: 'local', hostId: 'local' }
        }
      : null
  })
  vi.spyOn(h.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('hiveward')
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const ceo = await h.call('orchestration.workerStart', {
      from: 'term_coord',
      spec: '老板开 CEO',
      agent: 'codex'
    })
    expect(ceo).toMatchObject({ state: 'ready' })
    const leader = await h.call('orchestration.workerStart', {
      from: 'term_hiveward_1',
      spec: 'CEO 开 Leader',
      agent: 'claude'
    })
    expect(leader).toMatchObject({ state: 'ready' })
    const child = await h.call('orchestration.workerStart', {
      from: 'term_hiveward_2',
      spec: 'Leader 派下属',
      agent: 'codex'
    })
    expect(child).toMatchObject({ state: 'ready' })
    const grandchild = await h.call('orchestration.workerStart', {
      from: 'term_hiveward_3',
      spec: '下属派孙级',
      agent: 'claude'
    })
    expect(grandchild).toMatchObject({ state: 'ready' })
    if (
      !grandchild ||
      typeof grandchild !== 'object' ||
      !('dispatchId' in grandchild) ||
      !('taskId' in grandchild)
    ) {
      throw new Error('孙级回执不完整')
    }
    const dispatchId = String(grandchild.dispatchId),
      taskId = String(grandchild.taskId)
    if (!child || typeof child !== 'object' || !('dispatchId' in child)) {
      throw new Error('下属回执不完整')
    }
    const context = h.db.getDispatchContextById(dispatchId)
    expect(context?.creator_dispatch_id).toBe(child.dispatchId)
    expect(context?.run_id).toBe(h.activeRunId)
    const crew = h.runtime.getOrchestrationCrewSnapshot('term_hiveward_3')
    expect(crew.sections.managing.map((row) => row.sendAddress)).toContain(`dispatch:${dispatchId}`)
    await h.call('orchestration.send', {
      from: 'term_hiveward_4',
      type: 'worker_done',
      subject: '孙级完成',
      body: '已完成。',
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
    })
    const direct = await h.call('orchestration.check', { terminal: 'term_hiveward_3' })
    expect(direct).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
    })
    expect(
      h.db
        .getRunMailboxHistory(h.activeRunId, 100)
        .some((message) => message.subject === '孙级完成')
    ).toBe(false)
    console.log(
      `ACCEPT 老板 → CEO term_hiveward_1 → Leader term_hiveward_2 → 下属 term_hiveward_3 → 孙级 term_hiveward_4（原生默认层级 4）；原生 Run ${h.activeRunId}；${dispatchId} worker_done 只回直接上级；SQLite ${root}；PTY 夹具`
    )
  } finally {
    await new Promise<void>((resolve) => setImmediate(resolve))
    h.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

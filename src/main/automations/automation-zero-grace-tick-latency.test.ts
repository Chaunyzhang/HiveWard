import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import { AutomationService } from './service'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

describe('AutomationService zero-grace tick latency', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'hiveward-automations-test-'))
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const DUE = new Date('2026-05-13T09:00:00').getTime()

  const makeZeroGrace = (store: Awaited<ReturnType<typeof createStore>>) =>
    store.createAutomation({
      name: 'Zero grace',
      prompt: 'Run it',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'r1::wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00').getTime(),
      missedRunGraceMinutes: 0
    })

  /** Set the clock without advancing timers to avoid a second scheduler pass. */
  const evaluateAt = async (
    store: Awaited<ReturnType<typeof createStore>>,
    at: number
  ): Promise<void> => {
    vi.setSystemTime(at)
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send: vi.fn() })
    service.start()
    service.setRendererReady()
    await vi.waitFor(() => {
      if (store.listAutomations().some((automation) => automation.nextRunAt <= at)) {
        throw new Error('Automation evaluation is still saving its next occurrence')
      }
    })
    service.stop()
  }

  const statusAt = async (lateMs: number): Promise<string | undefined> => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = makeZeroGrace(store)
    await evaluateAt(store, DUE + lateMs)
    return store.listAutomationRuns(automation.id)[0]?.status
  }

  it.each([
    ['1ms late', 1],
    ['45s late', 45_000]
  ])('dispatches a zero-grace occurrence only the tick was late for (%s)', async (_l, lateMs) => {
    expect(await statusAt(lateMs)).toBe('dispatching')
  })

  it('still skips a zero-grace occurrence that came due during a long sleep', async () => {
    expect(await statusAt(4 * 60 * 60 * 1000)).toBe('skipped_missed')
  })

  it('skips once lateness exceeds the tick-latency tolerance', async () => {
    expect(await statusAt(2 * 60_000 + 1)).toBe('skipped_missed')
  })

  it('dispatches after a restart that crosses the occurrence within tolerance', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = makeZeroGrace(store)
    await evaluateAt(store, DUE - 30_000)
    expect(store.listAutomationRuns(automation.id)).toHaveLength(0)
    await evaluateAt(store, DUE + 30_000)
    expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatching')
  })
  it('HiveWard 70 分钟旧巡检使用原生持久调度生成 scheduled run', async () => {
    vi.setSystemTime(DUE - 60_000)
    const store = await createStore()
    store.addRepo(makeRepo({ path: testState.dir }))
    const automation = store.createAutomation({
      name: 'HiveWard 定时巡检',
      prompt: '派发巡检任务',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'r1::wt1',
      timezone: 'UTC',
      rrule: 'FREQ=MINUTELY;INTERVAL=70',
      dtstart: DUE,
      missedRunGraceMinutes: 0
    })
    await evaluateAt(store, DUE + 1)
    const run = store.listAutomationRuns(automation.id)[0]
    expect(run).toMatchObject({ status: 'dispatching', trigger: 'scheduled', scheduledFor: DUE })
    expect(store.listAutomations().find((a) => a.id === automation.id)?.nextRunAt).toBe(
      DUE + 70 * 60_000
    )
    console.log(
      `ACCEPT HiveWard 定时：原生 automation → scheduled run ${run.id}；SQLite ${testState.dir}；受控时钟与 Agent 边界夹具`
    )
  })
  it('HiveWard 空座位配置停用持久化，选定 Agent 后才能启用或手动派活', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ path: testState.dir }))
    const automation = store.createAutomation({
      name: 'HiveWard 空位巡检',
      prompt: '保留原消息',
      agentId: null,
      enabled: true,
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'r1::wt1',
      timezone: 'UTC',
      rrule: 'FREQ=MINUTELY;INTERVAL=70',
      dtstart: DUE
    })
    store.flush()
    await closeTestStores()
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0]).toMatchObject({
      id: automation.id,
      enabled: false,
      prompt: '保留原消息',
      rrule: 'FREQ=MINUTELY;INTERVAL=70'
    })
    expect(() => reloaded.updateAutomation(automation.id, { enabled: true })).toThrow(
      '先选择 Agent'
    )
    expect(reloaded.listAutomations()[0].agentId).toBeNull()
    const service = new AutomationService(reloaded)
    await expect(service.runNow(automation.id)).rejects.toThrow('先选择 Agent')
    const selected = reloaded.updateAutomation(automation.id, { agentId: 'codex', enabled: true })
    expect(selected).toMatchObject({
      agentId: 'codex',
      enabled: true
    })
    console.log(
      `ACCEPT 空 Leader：停用 automation ${automation.id} → SQLite 重开保留原文和周期 → 拒绝未选 Agent 的启用 / runNow → 选定 Codex 后启用`
    )
  })
})

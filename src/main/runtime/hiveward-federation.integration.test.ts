vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { sendRequest } from '../../cli/runtime/transport'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { HiveWardRuntimeRpcServer } from './runtime-rpc'
import { createOrchestrationWorkerReleaseHarness } from './rpc/methods/orchestration/worker/worker-release.test-support'
import {
  resolveEnvironment,
  addEnvironmentFromPairingCode
} from '../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import {
  fingerprintOrchestrationPeer,
  type OrchestrationEnvironmentTransport
} from './orchestration/environment-transport'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { resetSharedControlSupport } from '../ipc/runtime-environments/runtime-environment-shared-control-support'
import { syncFederationBarrier } from './rpc/methods/orchestration/federation/federation-sync-barrier.test-support'

it('HiveWard 两个临时实例：environment 配对 → worker-start --on → worker_done 回原派单方', async () => {
  const root = mkdtempSync('/tmp/hiveward-federation-')
  const homePath = join(root, 'home'),
    workerPath = join(root, 'worker')
  mkdirSync(homePath)
  mkdirSync(workerPath)
  const transport: OrchestrationEnvironmentTransport = {
    resolve(selector) {
      const environment = resolveEnvironment(homePath, selector)
      const connection = getPreferredPairedRuntimeConnection(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        peerFingerprint: fingerprintOrchestrationPeer(connection.hostPublicKeyB64),
        pairingRevision: environment.pairingRevision ?? environment.createdAt
      }
    },
    call: (selector, method, params, timeout, envelope, revision) =>
      callRuntimeEnvironment(homePath, selector, method, params, timeout, revision, envelope)
  }
  const home = createOrchestrationWorkerReleaseHarness()
  home.setup({ userDataDir: homePath, orchestrationEnvironmentTransport: transport })
  const worker = createOrchestrationWorkerReleaseHarness()
  worker.setup({ userDataDir: workerPath })
  vi.spyOn(home.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('hiveward')
  vi.spyOn(worker.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('hiveward')
  const homeServer = new HiveWardRuntimeRpcServer({
    runtime: home.runtime,
    userDataPath: homePath,
    enableWebSocket: true,
    wsPort: 0,
    pinnedBindHost: '127.0.0.1'
  })
  const workerServer = new HiveWardRuntimeRpcServer({
    runtime: worker.runtime,
    userDataPath: workerPath,
    enableWebSocket: true,
    wsPort: 0,
    pinnedBindHost: '127.0.0.1'
  })
  try {
    await homeServer.start()
    await workerServer.start()
    const homeOffer = homeServer.createPairingOffer({
      address: '127.0.0.1',
      name: 'HiveWard home',
      scope: 'runtime'
    })
    if (!homeOffer.available) {
      throw new Error('派单端临时实例无法生成配对码')
    }
    const offer = workerServer.createPairingOffer({
      address: '127.0.0.1',
      name: 'HiveWard worker',
      scope: 'runtime'
    })
    if (!offer.available) {
      throw new Error('临时实例无法生成配对码')
    }
    const environment = addEnvironmentFromPairingCode(homePath, {
      name: 'hiveward-worker',
      pairingCode: offer.pairingUrl
    })
    const metadata: RuntimeMetadata = JSON.parse(
      readFileSync(join(homePath, 'hiveward-runtime.json'), 'utf8')
    )
    const response = await sendRequest<unknown>(
      metadata,
      'orchestration.workerStart',
      {
        from: 'term_coord',
        spec: '离线跨实例任务',
        on: environment.id,
        agent: 'codex',
        worktree: 'id:repo::worktree'
      },
      30000,
      { orchestrationContractVersion: 1, orchestrationRequestId: randomUUID() }
    )
    expect(response.ok, JSON.stringify(response)).toBe(true)
    if (!response.ok) {
      throw new Error(JSON.stringify(response.error))
    }
    const started = response.result
    expect(started).toMatchObject({ state: 'ready' })
    if (
      !started ||
      typeof started !== 'object' ||
      !('dispatchId' in started) ||
      !('taskId' in started)
    ) {
      throw new Error('派单回执不完整')
    }
    const dispatchId = String(started.dispatchId),
      taskId = String(started.taskId)
    expect(worker.db.getRemoteDispatchAttachment(dispatchId)?.state).toBe('ready')
    expect(worker.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    await worker.call('orchestration.send', {
      from: 'term_worker',
      type: 'worker_done',
      subject: '跨实例交活',
      body: '已完成，离线核验通过。',
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded', filesModified: [] })
    })
    await syncFederationBarrier(home.runtime, home.db)
    expect(home.db.getTask(taskId)?.status).toBe('completed')
    const inbox = await home.call('orchestration.check', { terminal: 'term_coord' })
    expect(inbox).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ type: 'worker_done', subject: '跨实例交活' })
      ])
    })
    console.log(
      `ACCEPT environment ${environment.id}；两个独立数据目录 ${homePath} / ${workerPath}；独立 WebSocket ${homeOffer.endpoint} → ${offer.endpoint}（加密）；${dispatchId} → worker_done → 派单方原生邮箱；PTY 夹具`
    )
  } finally {
    home.runtime.stopOrchestrationFederationRelay()
    worker.runtime.stopOrchestrationFederationRelay()
    resetSharedControlSupport()
    await workerServer.stop()
    await homeServer.stop()
    worker.cleanup()
    home.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
}, 60000)

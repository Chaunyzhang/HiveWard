import { afterEach, describe, expect, it } from 'vitest'
import { isHiveWardSessionId } from '../../../../../shared/hiveward-session-address'
import { mintStructuredWorkerHandle } from '../../../structured-worker-identity'
import { OrchestrationDb } from '../orchestration-db'

const EARLIER_HIVEWARD_SESSION_ID = '7d9f1b3e-5a2c-4e6b-8f0a-1c3e5a7b9d42'
const WORKER_PANE = 'tab_worker:88888888-8888-4888-8888-888888888888'

describe('assignee identity writers', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  /** A starting Dispatch whose row already names an HiveWard session id, standing in for any earlier writer. */
  function startingDispatchWithHiveWardSessionId(target: OrchestrationDb): string {
    const task = target.createTask({ runId: 'run_legacy_local', spec: 'worker' })
    const started = target.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    target.db
      .prepare('UPDATE dispatch_contexts SET assignee_hiveward_session_id = ? WHERE id = ?')
      .run(EARLIER_HIVEWARD_SESSION_ID, started.dispatch.id)
    return started.dispatch.id
  }

  it('clears the HiveWard session id when worker authority names the assignee', () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = startingDispatchWithHiveWardSessionId(db)

    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: 'pty_proc_9c1d:31',
      worktreeId: 'wt_1',
      setupState: 'not_applicable',
      effects: []
    })

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: 'term_worker',
      assignee_hiveward_session_id: null
    })
  })

  it('clears the HiveWard session id when a failed start records the terminal it owned', () => {
    db = new OrchestrationDb(':memory:')
    const dispatchId = startingDispatchWithHiveWardSessionId(db)
    db.recordCreatedWorkerTerminalCustody({
      dispatchId,
      handle: 'term_worker',
      paneKey: WORKER_PANE,
      processIncarnation: 'pty_proc_9c1d:31',
      worktreeId: 'wt_1'
    })
    db.recordWorkerStage({ dispatchId, stage: 'agent_readiness', terminalHandle: 'term_worker' })

    db.failWorkerStart(dispatchId, 'agent_readiness', 'agent never became ready')

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      assignee_handle: 'term_worker',
      assignee_hiveward_session_id: null
    })
  })

  it('refuses a minted structured-worker handle as an HiveWard session id', () => {
    expect(isHiveWardSessionId(mintStructuredWorkerHandle())).toBe(false)
  })
})

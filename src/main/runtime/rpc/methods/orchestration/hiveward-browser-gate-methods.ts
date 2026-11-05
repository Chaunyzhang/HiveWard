import { defineMethod } from '../../core'
import { HivewardBrowserGateConsumeParams } from '../../../../../shared/rpc-contract/hiveward-browser-gate-params'
import { runLifecycleWriteTransaction } from '../../../orchestration/db/lifecycle-write-transaction-runner'

export const HIVEWARD_BROWSER_GATE_METHODS = [
  defineMethod({
    name: 'orchestration.hivewardBrowserGateConsume',
    permission: 'workspace',
    params: HivewardBrowserGateConsumeParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      return runLifecycleWriteTransaction(db.db, 'hiveward_browser_gate_consume', () => {
        const gate = db.getGate(params.gateId)
        if (gate?.status !== 'resolved' || gate.question !== params.question) {
          return { consumed: false }
        }
        let resolution: unknown
        let request: unknown
        try {
          resolution = JSON.parse(gate.resolution ?? '')
          const prefix = 'HiveWard 浏览器操作确认：'
          if (!gate.question.startsWith(prefix)) {
            return { consumed: false }
          }
          request = JSON.parse(gate.question.slice(prefix.length))
        } catch {
          return { consumed: false }
        }
        if (
          !request ||
          typeof request !== 'object' ||
          !('terminal' in request) ||
          request.terminal !== params.terminal
        ) {
          return { consumed: false }
        }
        if (
          typeof resolution !== 'object' ||
          resolution === null ||
          !('hivewardOwner' in resolution) ||
          resolution.hivewardOwner !== true ||
          !('choice' in resolution) ||
          resolution.choice !== '同意执行'
        ) {
          return { consumed: false }
        }
        const id = `hiveward_browser_gate_${gate.id}`
        if (db.getMessageById(id)) {
          return { consumed: false }
        }
        db.insertMessage({
          id,
          runId: gate.run_id,
          from: params.terminal,
          to: `run:${gate.run_id}`,
          type: 'status',
          subject: 'HiveWard 浏览器确认已消费',
          body: params.question,
          payload: JSON.stringify({ hivewardBrowserGate: gate.id, terminal: params.terminal }),
          deliveryContract: 'audit_only'
        })
        return { consumed: true }
      })
    }
  })
]

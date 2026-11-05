import { CrewSubscribeParams } from '../../../../../shared/orchestration-crew'
import { defineMethod } from '../../core'

export const HIVEWARD_CREW_METHODS = [
  defineMethod({
    name: 'orchestration.hivewardCrewShow',
    permission: 'workspace',
    params: CrewSubscribeParams,
    handler: async ({ party }, { runtime }) => {
      await runtime.openAgentSessionRecordStore()
      return runtime.getOrchestrationCrewSnapshot(party)
    }
  })
]

import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

export async function hivewardWorkerStartFixture({
  result = {},
  party = { address: 'term_home' },
  error
} = {}) {
  const calls = []
  const context = vm.createContext({ console })
  const rpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'orchestration.workerStart') {
      if (error) {throw error}
      return {
        state: 'ready',
        runId: 'run_home',
        taskId: 'task_home',
        dispatchId: 'ctx_remote',
        ...result
      }
    }
    if (method === 'orchestration.workerShow')
      {return {
        server: { environmentId: 'environment_peer', name: 'peer' },
        terminal: { handle: 'term_same' }
      }}
    throw new Error(method)
  }
  const values = {
    './api-runtime.mjs': {
      rpc,
      ensureRepo: async (path) => {
        calls.push({ method: 'ensureRepo', params: { path } })
        return { path }
      }
    },
    './business.mjs': {
      badRequest: (message) => Object.assign(new Error(message), { status: 400 }),
      apiError: (status, code, message) => Object.assign(new Error(message), { status, code })
    },
    './hiveward-dispatcher.mjs': {
      resolveDispatcher: async (_caller, path) => {
        calls.push({ method: 'resolveDispatcher', params: { path } })
        return party
      },
      dispatcherRpc: async (identity, method, params) => {
        calls.push({ method: 'identity', params: identity })
        return rpc(method, params)
      }
    },
    './agent-exit-region.mjs': { exitRegionGuard: () => ({ assertAllowed: async () => {} }) }
  }
  const module = new vm.SourceTextModule(
    await readFile(new URL('../worker-start.mjs', import.meta.url), 'utf8'),
    { context }
  )
  await module.link(
    (specifier) =>
      new vm.SyntheticModule(
        Object.keys(values[specifier]),
        function () {
          for (const [key, value] of Object.entries(values[specifier])) {this.setExport(key, value)}
        },
        { context }
      )
  )
  await module.evaluate()
  return { startWorker: module.namespace.startWorker, calls }
}

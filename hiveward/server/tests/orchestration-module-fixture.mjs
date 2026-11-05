import vm from 'node:vm'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 隔离业务数据和 RPC；模块本体照常执行，测试不接真实引擎和 Agent。
export async function orchestrationFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-orchestration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const records = []
  const run = {
    id: 'run_test',
    coordinator_handle: 'term_leader',
    objective: '测试任务',
    created_at: '2026-11-04 10:00:00'
  }
  const task = {
    id: 'task_test',
    run_id: run.id,
    dispatch_id: 'dispatch_test',
    spec: '完成工作',
    status: 'dispatched',
    deps: '[]',
    created_at: run.created_at
  }
  const worker = {
    dispatchId: task.dispatch_id,
    taskId: task.id,
    projection: { provider: { id: 'claude' }, liveness: { verdict: 'live' } },
    terminalState: 'active'
  }
  const shown = {
    dispatch: { id: task.dispatch_id, assigneeHandle: 'term_worker', creatorHandle: 'term_leader' },
    worker: { agentTerminalHandle: 'term_worker', startOptions: { agent: 'claude' } },
    terminal: { handle: 'term_worker' }
  }
  const terminals = [
    { handle: 'term_leader', worktreePath: root, agent: 'claude' },
    { handle: 'term_worker', worktreePath: root, agent: 'claude' }
  ]
  const messages = []
  const gates = []
  // 原单上开出的下一轮：各自一张 Task、一个 Worker、一份 workerShow
  const followUps = []
  let snapshot
  const rpc = async (method, params = {}) => {
    calls.push({ method, params })
    if (overrides.call) {
      return overrides.call(method, params)
    }
    if (method === 'orchestration.send' && params.to === `run:${run.id}`) {
      messages.unshift({
        type: params.type ?? 'status',
        from_handle: params.from,
        run_id: run.id,
        payload: params.payload
      })
    }
    const reads = {
      'orchestration.runList': { runs: [run] },
      'orchestration.hivewardCrewShow': {
        status: 'ok',
        sections: { managedBy: [], managing: [], talkingWith: [] }
      },
      'orchestration.inbox': { messages },
      'orchestration.taskList': { tasks: [task, ...followUps.map((f) => f.task)] },
      'orchestration.gateList': { gates },
      'orchestration.workerList': { workers: [worker, ...followUps.map((f) => f.worker)] },
      'orchestration.workerShow':
        followUps.find((f) => f.shown.dispatch.id === params.dispatch)?.shown ?? shown,
      'orchestration.workerRelease': { dispatchId: task.dispatch_id, state: 'released' },
      'orchestration.send': { message: { id: 'message_followup' } }
    }
    if (!(method in reads)) {
      throw new Error(`不应调用：${method}`)
    }
    return reads[method]
  }
  const stubs = {
    'data-dir.mjs': { dataDir: () => root },
    'api-runtime.mjs': {
      rpc,
      optionalRpc: rpc,
      iso: (s) =>
        s ? new Date(s.endsWith?.('Z') ? s : `${s.replace?.(' ', 'T')}Z`).toISOString() : '',
      json: (s, fallback) => (s == null ? fallback : typeof s === 'string' ? JSON.parse(s) : s),
      ensureRepo: async () => ({ path: root })
    },
    'business.mjs': {
      businesses: () => [],
      badRequest: (s) => Object.assign(new Error(s), { status: 400 }),
      apiError: (status, code, s) => Object.assign(new Error(s), { status, code })
    },
    'business-projects.mjs': {
      businessProjects: () => [],
      projectOf: () => undefined,
      getProject: () => undefined,
      bindProjectTerminal() {},
      within: (p, r) => p?.startsWith(r)
    },
    'machine-identity.mjs': { remoteOrigin: () => false },
    'business-terminals.mjs': {
      FULL_ACCESS: {},
      locateTerminalSession: async () => {
        throw new Error('没有会话')
      },
      agentCommand: () => ''
    },
    'transcripts.mjs': { transcriptSessionId: () => undefined },
    'agent-exit-region.mjs': { exitRegionGuard: () => ({ assertAllowed: async () => {} }) },
    'timeline.mjs': { appendTimelineEvents() {} },
    'work-records.mjs': {
      workRecords: () => records,
      saveWorkRecord: (r) => (records.push(r), r),
      getWorkRecord: (id) => records.find((r) => r.id === id)
    },
    'orchestration.mjs': { invalidate() {}, snapshot: async () => snapshot },
    'seat-occupants.mjs': { seatOccupantId: (s) => s?.terminal }
  }
  Object.assign(stubs, overrides.modules)
  const context = vm.createContext({ process, console, setTimeout, clearTimeout, Date, Set, Map })
  const cache = new Map()
  async function load(url) {
    const key = url.href
    if (cache.has(key)) {
      return cache.get(key)
    }
    const name = fileURLToPath(url).split('/').at(-1)
    const values = stubs[name]
    const module = values
      ? new vm.SyntheticModule(
          Object.keys(values),
          function () {
            for (const [k, v] of Object.entries(values)) {
              this.setExport(k, v)
            }
          },
          { context, identifier: key }
        )
      : new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: key })
    cache.set(key, module)
    await module.link(async (specifier, parent) => {
      if (!specifier.startsWith('node:')) {
        return load(new URL(specifier, parent.identifier))
      }
      const values = await import(specifier)
      return new vm.SyntheticModule(
        Object.keys(values),
        function () {
          for (const [k, v] of Object.entries(values)) {
            this.setExport(k, v)
          }
        },
        { context }
      )
    })
    return module
  }
  const entry = new URL('../dispatches.mjs', import.meta.url)
  const dispatches = await load(entry)
  await dispatches.evaluate()
  const api = dispatches.namespace
  async function project() {
    const source = await api.orchestrationProjection(terminals)
    snapshot = {
      dispatches: source.rows,
      details: [],
      orphanTasks: source.rows.map((d) => api.dispatchTask(d, ''))
    }
    return snapshot
  }
  async function module(name) {
    const loaded = await load(new URL(`../${name}`, import.meta.url))
    await loaded.evaluate()
    return loaded.namespace
  }
  return {
    root,
    api,
    calls,
    run,
    task,
    worker,
    shown,
    terminals,
    messages,
    gates,
    records,
    project,
    module,
    followUp(title) {
      const n = followUps.length + 1
      const next = {
        id: `task_next_${n}`,
        run_id: run.id,
        dispatch_id: `dispatch_next_${n}`,
        task_title: title,
        spec: title,
        status: 'dispatched',
        deps: '[]',
        created_at: run.created_at
      }
      followUps.push({
        task: next,
        worker: { ...worker, dispatchId: next.dispatch_id, taskId: next.id },
        shown: {
          ...shown,
          dispatch: {
            ...shown.dispatch,
            id: next.dispatch_id,
            taskId: next.id,
            followUpOf: task.dispatch_id
          }
        }
      })
    },
    report(outcome = 'succeeded') {
      task.status = outcome === 'succeeded' ? 'completed' : 'failed'
      messages.unshift({
        id: 'done_test',
        type: 'worker_done',
        body: '完成了。检查通过。没有遗留。',
        created_at: '2026-11-04T11:00:00Z',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: task.dispatch_id,
          outcome,
          filesModified: ['result.txt'],
          reportPath: '/tmp/report.md'
        })
      })
    }
  }
}

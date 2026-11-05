// 旧派单只读展示；当前状态只来自 HiveWard 引擎的 Task、Dispatch 和邮箱。
import { dispatcherRpc } from './hiveward-dispatcher.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { businessProjects, projectOf, within } from './business-projects.mjs'
import { dataDir } from './data-dir.mjs'
import { businesses } from './business.mjs'
import { rpc, iso, json } from './api-runtime.mjs'
import { remoteOrigin } from './machine-identity.mjs'
import { errorStopReason } from './model-error-stop.mjs'

// 打回发出去的话以此为题：原单上开出的下一轮才算打回，老板接着说的后续安排不算
export const REWORK_SUBJECT = '复核没通过'

let current = []
export const dispatches = () => current
export function legacyDispatches() {
  try {
    return JSON.parse(readFileSync(join(dataDir(), 'dispatches.json'), 'utf8')).map((row) => ({
      ...row,
      historical: true,
      alive: false,
      review: undefined
    }))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

const STOPPED_STATES = new Set(['stopped', 'abandoned'])

/** 派单方已经停掉 / 放弃的派单：不再算在线下属，也不再算待决策。 */
export function dispatchHalted(d) {
  const workerState = d.workerState ?? d.worker?.workerState ?? d.detail?.worker?.state
  const lastFailure = d.lastFailure ?? d.detail?.dispatch?.lastFailure
  return STOPPED_STATES.has(workerState) || STOPPED_STATES.has(lastFailure)
}

/** 终端还在，且派单没有被派单方停掉 / 放弃、没有复核通过：架构图上才算在线下属。 */
export function dispatchOnline(d) {
  if (!d.alive) {
    return false
  }
  const releaseState = d.worker?.resource?.releaseState ?? d.detail?.terminalResource?.release_state
  const stage = d.detail?.worker?.stage
  if (releaseState === 'released' || stage === 'released' || dispatchHalted(d)) {
    return false
  }
  return d.review?.state !== 'accepted'
}

export async function pages(method, key, params = {}) {
  const rows = []
  let cursor
  do {
    const response = await rpc(method, { ...params, cursor })
    rows.push(...response[key])
    cursor = response.nextCursor ?? response.page?.nextCursor
  } while (cursor)
  return rows
}

export async function orchestrationProjection(listed, workspaces = new Map()) {
  const [runs, inbox] = await Promise.all([
    pages('orchestration.runList', 'runs'),
    rpc('orchestration.inbox', { limit: -1 })
  ])
  const groups = await Promise.all(
    runs.map(async (run) => {
      const [tasks, workers, gates] = await Promise.all([
        rpc('orchestration.taskList', { run: run.id }),
        pages('orchestration.workerList', 'workers', { run: run.id }),
        rpc('orchestration.gateList', { run: run.id })
      ])
      const dispatchIds = new Set(workers.map((w) => w.dispatchId))
      for (const message of inbox.messages) {
        const payload = json(message.payload, {})
        if (message.type === 'worker_done' && tasks.tasks.some((t) => t.id === payload.taskId)) {
          dispatchIds.add(payload.dispatchId)
        }
      }
      const shown = await Promise.all(
        [...dispatchIds].map((dispatch) => rpc('orchestration.workerShow', { dispatch }))
      )
      for (const detail of shown) {
        const selector = detail.worker?.startOptions?.worktree
        if (selector?.startsWith('path:')) {
          workspaces.set(detail.worker.worktreeId, selector.slice(5))
        }
      }
      const rows = tasks.tasks.map((task) => {
        const index = workers.findIndex((w) =>
          task.dispatch_id ? w.dispatchId === task.dispatch_id : w.taskId === task.id
        )
        const worker = workers[index]
        const doneMessage = inbox.messages.find(
          (m) => m.type === 'worker_done' && json(m.payload, {}).taskId === task.id
        )
        const dispatchId =
          worker?.dispatchId ?? task.dispatch_id ?? json(doneMessage?.payload, {}).dispatchId
        const detail = shown.find((d) => d.dispatch?.id === dispatchId)
        const dispatch = detail?.dispatch
        const projection = worker?.projection ?? worker
        const nativeTerminal =
          detail?.terminal?.handle ??
          detail?.worker?.agentTerminalHandle ??
          dispatch?.assigneeHandle
        const handle = detail?.server ? `dispatch:${dispatchId}` : nativeTerminal
        const terminal = !detail?.server && listed.find((t) => t.handle === handle)
        const messages = inbox.messages.filter(
          (m) =>
            json(m.payload, {}).dispatchId === dispatchId &&
            (m.type !== 'worker_done' || json(m.payload, {}).taskId === task.id)
        )
        const done = messages.find((m) => m.type === 'worker_done')
        const payload = done && json(done.payload, {})
        const report =
          payload && ['succeeded', 'failed'].includes(payload.outcome)
            ? {
                outcome: payload.outcome,
                summary: done.body,
                reportedAt: iso(done.created_at),
                filesModified: payload.filesModified,
                reportPath: payload.reportPath
              }
            : undefined
        const stop = messages.find((m) => json(m.payload, {}).stopReason)
        const stopped = stop && json(stop.payload, {})
        const creator =
          dispatch?.creatorAddress ??
          dispatch?.creatorHandle ??
          run.coordinatorAddress ??
          run.coordinator_handle
        const external =
          run.hivewardSession && creator === run.coordinatorAddress
            ? run.hivewardSession
            : undefined
        const party = { address: creator, ...(external ? { sessionId: external.sessionId } : {}) }
        const acceptedMessage = inbox.messages.find((m) => {
          const review = json(m.payload, {}).hivewardReview
          return (
            m.run_id === run.id &&
            m.from_handle === creator &&
            review?.taskId === task.id &&
            review.dispatchId === dispatchId &&
            review.verdict === 'accept'
          )
        })
        const accepted = acceptedMessage && json(acceptedMessage.payload, {}).hivewardReview
        const followUps = shown.filter((d) => d.dispatch?.followUpOf === dispatchId)
        const continued = followUps.some(
          (d) => tasks.tasks.find((t) => t.id === d.dispatch.taskId)?.task_title === REWORK_SUBJECT
        )
        const coordinator = listed.find((t) => t.handle === creator)
        const workerState = worker?.workerState ?? detail?.worker?.state
        const lastFailure = dispatch?.lastFailure
        const halted = STOPPED_STATES.has(workerState) || STOPPED_STATES.has(lastFailure)
        const status = halted ? 'failed' : task.status
        const review = halted
          ? undefined
          : report
            ? continued
              ? { state: 'rework', reviewer: 'dispatcher', round: 1 }
              : accepted
                ? {
                    state: 'accepted',
                    reviewer: 'dispatcher',
                    round: 1,
                    by: accepted.reviewedBy,
                    at: accepted.acceptedAt
                  }
                : followUps.length
                  ? // 交活后老板又接着说了话，原单上开了下一轮：这一轮看过了，不再等复核
                    undefined
                  : {
                      state: 'awaiting',
                      reviewer: external?.dispatcher.kind === 'owner' ? 'owner' : 'dispatcher',
                      round: 1
                    }
            : undefined
        const row = {
          id: task.id,
          dispatchId,
          execution: detail?.server,
          nativeTerminal,
          runId: run.id,
          handle,
          project: terminal?.worktreePath ?? workspaces.get(detail?.worker?.worktreeId) ?? '',
          agent: projection?.provider?.id ?? detail?.worker?.startOptions?.agent ?? terminal?.agent,
          title: task.spec.slice(0, 100),
          prompt: task.spec,
          by: external?.dispatcher ?? {
            kind: 'cli',
            id: creator,
            label: 'Agent',
            cwd: coordinator?.worktreePath
          },
          party,
          at: iso(task.created_at),
          updatedAt: iso(task.completed_at ?? task.created_at),
          status,
          blockedReason: status === 'failed' ? detail?.worker?.lastError : undefined,
          deps: json(task.deps, []),
          report,
          alive: !!worker && !!detail?.terminal && projection?.liveness?.verdict !== 'exited',
          liveness: projection?.liveness?.verdict ?? 'unverifiable',
          terminalState: worker?.terminalState ?? worker?.resource?.terminalState,
          workerState,
          lastFailure,
          review,
          errorStop:
            stopped?.stopReason === 'errored' && !report
              ? { reason: errorStopReason(stop.body), line: stop.body, at: iso(stop.created_at) }
              : undefined,
          turnStop: stopped
            ? { reason: stopped.stopReason, body: stop.body, at: iso(stop.created_at) }
            : undefined,
          worker,
          detail,
          task
        }
        row.online = dispatchOnline(row)
        return row
      })
      return { run, rows, gates: gates.gates, workers, shown }
    })
  )
  current = groups.flatMap((g) => g.rows)
  return { runs, inbox: inbox.messages, groups, rows: current }
}

export async function observeDispatches(listed) {
  return (await orchestrationProjection(listed)).rows
}

export function dispatchLocation(dispatch) {
  const projects = businessProjects()
  const project =
    projects.find((item) => item.id === dispatch.projectId) ??
    projectOf({ ...dispatch, path: dispatch.project }, projects, dispatches())
  const business = project
    ? businesses().find((item) => item.id === project.businessId)
    : businesses().find((item) =>
        [...(remoteOrigin(dispatch) ? [] : [dispatch.by?.cwd]), dispatch.project].some(
          (path) => path && within(path, item.workspacePath)
        )
      )
  return {
    businessId: business?.id,
    projectId: project?.id,
    businessName: business?.name,
    projectName: project?.name
  }
}

export function dispatchTask(d, businessId, followUps = []) {
  // 历史派单已经结算：升级前的 dispatched / pending 之类不能再算「进行中」。
  const status = d.historical && !['completed', 'failed'].includes(d.status) ? 'failed' : d.status
  return {
    id: d.id,
    businessId: businessId ?? '',
    projectId: d.projectId,
    objectiveId: d.runId,
    runId: d.runId,
    title: clip(norm(d.prompt.split('\n')[0]), 80),
    status,
    deps: [],
    assignee: d.agent
      ? { agent: d.agent, dispatchId: d.dispatchId, liveness: d.alive ? 'live' : 'exited' }
      : undefined,
    blockedReason: status === 'failed' ? d.blockedReason : undefined,
    report: d.report,
    updatedAt: d.updatedAt ?? d.at,
    project: d.project ? d.project.split(/[/\\]/).pop() : undefined,
    dispatchedBy: {
      kind: d.by.kind,
      id: d.by.id,
      label: d.by.label,
      machineId: d.by.machineId
    },
    terminal: d.alive ? d.handle : undefined,
    backgroundCommands: d.backgroundCommands,
    followUps: followUps.length ? followUps.map((f) => clip(norm(f.prompt), 200)) : undefined,
    review: d.historical ? undefined : d.review,
    errorStop: d.errorStop,
    dropped: [d, ...followUps].flatMap((x) => (x.dropped ? [x.dropped] : [])).at(-1),
    closed: d.closed,
    execution: d.execution,
    historical: d.historical
  }
}

// Agent 对派出去的 Agent 说话：用它自己的身份发到这张派单，交过活的在原单上开下一张
export async function recordTerminalTell(handle, prompt, party) {
  const row = current.findLast((d) => d.handle === handle)
  if (!row) {
    return null
  }
  return dispatcherRpc(party, 'orchestration.send', {
    from: party.address,
    to: `dispatch:${row.dispatchId}`,
    subject: '后续安排',
    body: prompt
  })
}

// 定时巡检每轮新开一个 Agent，不复用会话：这轮的 Agent 有问题自己接着处理，没问题就闲着，
// 空闲满设置里的时间（默认一小时）自动关掉终端。原生的空闲自动关（worker auto-release）只管派单下属，定时任务的运行终端原生不关。
// 在对话里问老板「要不要做」也算空闲：老板回话它就接着干，一直不回就按空闲关。
// 只关：HiveWard 项目定时巡检开出来的、这轮已经结束（原生状态 done）、此后一直没再干活的终端；
// 座位上的终端不关。报告原文留在原生运行记录（outputSnapshot）里，关掉终端不丢。
import { randomUUID } from 'node:crypto'
import { rpc } from './api-runtime.mjs'
import { businessProjects } from './business-projects.mjs'
import { invalidate } from './orchestration.mjs'
import { patrolSettings } from './patrol-settings.mjs'
import { appendTimelineEvents } from './timeline.mjs'
import { seatHandles } from './worker-close.mjs'

export const AUTOMATION_RUN_IDLE_CLOSE_MS = 60 * 60_000
const SWEEP_MS = 60_000
export const PROJECT_SCHEDULE_KEY = 'hiveward-project-schedule:'
const BUSY_STATUSES = new Set(['working', 'permission'])

/** 这个定时任务各轮还开着的终端和它们的原生状态 */
export async function liveRunTerminals(call, automationId, terminals) {
  const { runs } = await call('automation.runs', { automationId })
  const live = []
  for (const run of runs) {
    const terminal = terminals.find((t) => t.ptyId === run.terminalPtyId)
    if (!run.terminalPtyId || !terminal) {
      continue
    }
    const reply = await call('terminal.agentStatus', { terminal: terminal.handle }).catch(
      () => null
    )
    live.push({ run, terminal, status: reply?.agentStatus ?? null })
  }
  return live
}

/** 上一轮还没做完（在干活或在等权限）的终端；空闲的、问完老板在等回话的都算做完了 */
export function busyRunTerminals(live) {
  return live.filter(({ status }) => BUSY_STATUSES.has(status?.status))
}

/** 原生定时任务的前置检查调它：上一轮还在干活就报忙，原生把这一轮记成「已跳过」 */
export async function patrolReady(project, call = rpc) {
  const automationId = project.schedule?.automationId
  if (!automationId) {
    return { ready: true }
  }
  const { terminals } = await call('terminal.list')
  const busy = busyRunTerminals(await liveRunTerminals(call, automationId, terminals))
  return busy.length > 0
    ? {
        ready: false,
        busy: busy.map(({ run, terminal }) => ({ run: run.id, terminal: terminal.handle }))
      }
    : { ready: true }
}

/** 空闲满 idleMs 的巡检终端：按原生状态进入 done 的时间算，又干活了就从下次 done 重新算 */
export function idleRunTerminals({ runs, terminals, statuses, seats, now, idleMs }) {
  const closing = []
  for (const run of runs) {
    if (run.sessionKind !== 'terminal' || run.status !== 'completed' || !run.terminalPtyId) {
      continue
    }
    const terminal = terminals.find((t) => t.ptyId === run.terminalPtyId)
    if (!terminal || seats.has(terminal.handle)) {
      continue
    }
    const status = statuses.get(terminal.handle)
    const since = status?.lastStatus?.stateStartedAt
    if (
      status?.status === 'idle' &&
      status.lastStatus?.state === 'done' &&
      Number.isFinite(since) &&
      now - since >= idleMs
    ) {
      closing.push({ run, terminal })
    }
  }
  return closing
}

export function createAutomationRunIdleCloser({
  call = rpc,
  now = Date.now,
  idleMs = () => patrolSettings().idleCloseMinutes * 60_000,
  sweepMs = SWEEP_MS,
  seats = seatHandles,
  projects = businessProjects
} = {}) {
  let timer = null
  let sweeping = false
  async function sweep() {
    const { automations } = await call('automation.list')
    const own = automations.filter((a) => a.creationKey?.startsWith(PROJECT_SCHEDULE_KEY))
    if (own.length === 0) {
      return []
    }
    const { terminals } = await call('terminal.list')
    const seated = seats()
    const closed = []
    const idle = typeof idleMs === 'function' ? idleMs() : idleMs
    for (const automation of own) {
      const live = await liveRunTerminals(call, automation.id, terminals)
      const statuses = new Map(live.map(({ terminal, status }) => [terminal.handle, status]))
      const project = projects().find((p) => p.schedule?.automationId === automation.id)
      for (const { run, terminal } of idleRunTerminals({
        runs: live.map(({ run }) => run),
        terminals,
        statuses,
        seats: seated,
        now: now(),
        idleMs: idle
      })) {
        await call('terminal.close', { terminal: terminal.handle })
        closed.push(terminal.handle)
        appendTimelineEvents({
          id: `automation-idle-close:${randomUUID()}`,
          ts: new Date(now()).toISOString(),
          ...(project?.businessId ? { businessId: project.businessId } : {}),
          ...(project ? { projectId: project.id } : {}),
          kind: 'system',
          title: `${run.title} 空闲满 ${Math.round(idle / 60_000)} 分钟，自动关掉终端；报告留在运行记录里`,
          terminal: terminal.handle,
          path: run.runContext?.path
        })
      }
    }
    if (closed.length > 0) {
      invalidate()
    }
    return closed
  }
  return {
    sweep,
    start() {
      timer = setInterval(() => {
        if (sweeping) {
          return
        }
        sweeping = true
        void sweep()
          .catch(() => {})
          .finally(() => {
            sweeping = false
          })
      }, sweepMs)
      timer.unref?.()
    },
    close() {
      clearInterval(timer)
      timer = null
    }
  }
}

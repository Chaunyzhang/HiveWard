// 网页手动关闭保留五秒撤销；下属的释放和停止全部由引擎裁决。
import { businesses } from './business.mjs'
import { businessProjects } from './business-projects.mjs'
import { dispatches } from './dispatches.mjs'
import { invalidate } from './orchestration.mjs'
import { seatOccupantId } from './seat-occupants.mjs'

export const UNDO_CLOSE_MS = 5000
const pending = new Map()
export const closingWorkers = () => new Set(pending.keys())

function seatHandles() {
  const seats = new Set()
  for (const b of businesses()) {
    seats.add(seatOccupantId(b.ceo))
    seats.add(b.leaderTerminal)
  }
  for (const p of businessProjects()) {
    seats.add(seatOccupantId(p.leader))
  }
  seats.delete(undefined)
  seats.delete(null)
  return seats
}

export function createWorkerCloser({
  call,
  now = Date.now,
  undoMs = UNDO_CLOSE_MS,
  rows = dispatches,
  seats = seatHandles
} = {}) {
  async function closeNow(handle) {
    const row = rows().findLast((d) => d.handle === handle)
    if (!row) {
      throw Object.assign(new Error('这个终端没有编排下属'), { status: 409, code: 'not_worker' })
    }
    return call(
      row.report || row.status === 'failed'
        ? 'orchestration.workerRelease'
        : 'orchestration.workerStop',
      {
        dispatch: row.dispatchId
      }
    )
  }
  return {
    /** 老板手动关：过 undoMs 才真关，返回真关的时间；CEO / Leader 位上的不让关 */
    requestClose(handle) {
      if (seats().has(handle)) {
        throw Object.assign(new Error('CEO / Leader 位上的终端不在这里关'), {
          status: 409,
          code: 'not_worker'
        })
      }
      const existing = pending.get(handle)
      if (existing) {
        return { closeAt: new Date(existing.closeAt).toISOString() }
      }
      const closeAt = now() + undoMs
      const timer = setTimeout(() => {
        pending.delete(handle)
        void closeNow(handle).catch(() => invalidate())
      }, undoMs)
      timer.unref?.()
      pending.set(handle, { closeAt, timer })
      invalidate()
      return { closeAt: new Date(closeAt).toISOString() }
    },
    /** 撤销期里撤销：不关了；已经关掉了返回 false */
    undo(handle) {
      const item = pending.get(handle)
      if (!item) {
        return false
      }
      clearTimeout(item.timer)
      pending.delete(handle)
      invalidate()
      return true
    },
    closeNow,
    close() {
      for (const item of pending.values()) {
        clearTimeout(item.timer)
      }
      pending.clear()
    }
  }
}

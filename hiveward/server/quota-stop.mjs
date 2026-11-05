// 额度用完：哪家 Agent 的额度用完了、大约几点恢复、几个下属因此停着；恢复后自动叫它们接着干。
// 额度数据来自引擎的 /api/usage（各家 5 小时 / 每周窗口的 usedPercent、resetsAt）；
// 只由引擎 errored 提醒触发；Kimi 丢消息从终端滚动记录补齐。

import { dispatcherEnvelope } from './hiveward-dispatcher.mjs'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './data-dir.mjs'
import { dispatchLocation, dispatches } from './dispatches.mjs'
import { appendTimelineEvents } from './timeline.mjs'
import { droppedQueuedMessages, errorStopReason } from './model-error-stop.mjs'
export { quotaLabel } from './model-error-stop.mjs'

/** 恢复后发给下属的话 */
export const RESUME_TEXT = '额度恢复了，接着做刚才的活'
/** 引擎读不到这家额度时（没有恢复时间）：隔这么久试着叫一次 */
export const RESUME_RETRY_MS = 30 * 60 * 1000

// Agent → /api/usage 里那家的 id
const PROVIDERS = { claude: 'claude', codex: 'codex', kimi: 'kimi' }
const NAMES = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi' }

const settingsFile = () => join(dataDir(), 'quota-resume.json')

/** 额度相关的设置：autoResume 额度恢复后自动继续，默认开 */
export function quotaSettings() {
  try {
    const value = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return { autoResume: value.autoResume !== false }
  } catch {
    return { autoResume: true }
  }
}

export function saveQuotaSettings(patch) {
  if (typeof patch?.autoResume !== 'boolean') {
    throw Object.assign(new Error('autoResume 必须是 true / false'), {
      status: 400,
      code: 'bad_request'
    })
  }
  const next = { ...quotaSettings(), autoResume: patch.autoResume }
  mkdirSync(dataDir(), { recursive: true })
  const temp = `${settingsFile()}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, settingsFile())
  return next
}

/** 这家 Agent 的额度：known 引擎有没有它的数据；exhausted 有窗口用满了；resetsAt 用满的窗口里最晚恢复的那个；updatedAt 数据是几时读的 */
export function providerQuota(usage, agent) {
  const p = usage?.providers?.find((x) => x.id === PROVIDERS[agent])
  if (!p?.windows?.length) {
    return { known: false, exhausted: false }
  }
  const full = p.windows.filter((w) => w.usedPercent >= 100)
  return {
    known: true,
    updatedAt: p.updatedAt,
    exhausted: full.length > 0,
    resetsAt: full
      .map((w) => w.resetsAt)
      .filter(Boolean)
      .sort()
      .at(-1)
  }
}

/** 因额度停下、终端还开着的下属：handle → 这个终端上的派单（最后一条带着 errorStop） */
export function quotaStopped(rows, live) {
  const out = new Map()
  for (const d of rows) {
    if (live.has(d.handle) && d.errorStop?.reason === 'quota' && !d.closed) {
      out.set(
        d.handle,
        rows.filter((x) => x.handle === d.handle)
      )
    }
  }
  return out
}

/**
 * 顶栏提示：用完了的、或者有下属因它停着的那几家。
 * 引擎读不到这家额度（Kimi 常这样）、但有下属撞上了，也列出来，只是没有恢复时间。
 */
export function quotaAlerts(usage, stopped) {
  return Object.keys(PROVIDERS).flatMap((agent) => {
    const q = providerQuota(usage, agent)
    const handles = [...stopped.entries()]
      .filter(([, mine]) => (mine.at(-1).liveAgent ?? mine.at(-1).agent) === agent)
      .map(([handle]) => handle)
    if (!q.exhausted && !handles.length) {
      return []
    }
    return [
      {
        agent,
        name: NAMES[agent],
        exhausted: q.exhausted || !q.known,
        resetsAt: q.resetsAt,
        stopped: handles.length,
        handles
      }
    ]
  })
}

/** 发给停下的下属的话：接着干，出错时丢掉的消息原文一并重发 */
export function resumeText(mine) {
  const lost = mine.filter((d) => d.dropped && !d.dropped.resentAt)
  return lost.length
    ? `${RESUME_TEXT}。刚才出错时这几条消息没收到，一并补上：\n\n${lost.map((d) => d.prompt).join('\n\n')}`
    : RESUME_TEXT
}

/**
 * 每轮巡检：开着「额度恢复后自动继续」时，那家额度恢复了（引擎显示没用满、或过了恢复时间）
 * 就给因额度停下的下属发一句接着干；引擎读不到这家额度的，出错后每隔 retryMs 试一次。
 */
export function createQuotaResumer({
  call,
  readUsage,
  now = Date.now,
  retryMs = RESUME_RETRY_MS,
  rows = dispatches,
  settings = quotaSettings,
  record = appendTimelineEvents
}) {
  const lastSent = new Map()
  const dropped = new Map()
  return {
    async observe(terminals) {
      if (!settings().autoResume) {
        return
      }
      const errored = rows().filter((d) => d.turnStop?.reason === 'errored' && !d.report)
      const stopped = quotaStopped(
        errored.map((d) => ({
          ...d,
          errorStop: { ...d.errorStop, reason: errorStopReason(d.turnStop.body) }
        })),
        new Set(terminals.map((t) => t.handle))
      )
      if (!stopped.size) {
        return
      }
      const usage = await readUsage().catch(() => null)
      for (const [handle, mine] of stopped) {
        const last = mine.at(-1)
        const agent = last.liveAgent ?? last.agent
        const q = providerQuota(usage, agent)
        const since = Math.max(Date.parse(last.errorStop.at) || 0, lastSent.get(handle) ?? 0)
        // 引擎显示没用满，但数据比撞上报错还早：不作数，按读不到额度处理
        const fresh =
          q.known && Date.parse(q.updatedAt ?? '') > (Date.parse(last.errorStop.at) || 0)
        const ready = q.exhausted
          ? !!q.resetsAt && now() >= Date.parse(q.resetsAt)
          : fresh || now() - since >= retryMs
        // 刚叫过还没反应（屏幕上还是那行报错）：隔一阵再叫，别刷屏
        if (!ready || (lastSent.has(handle) && now() - lastSent.get(handle) < retryMs)) {
          continue
        }
        const lostMessages = []
        if (agent === 'kimi') {
          const read = await call('terminal.read', { terminal: handle, limit: 2000 })
          const lost = droppedQueuedMessages(read.terminal.tail.join('\n'))
          const pending = lost.filter((text) => !dropped.get(last.dispatchId)?.has(text))
          const inbox = pending.length
            ? await call('orchestration.inbox', { limit: -1 })
            : { messages: [] }
          const candidates = [
            ...mine.map((d) => d.prompt),
            ...inbox.messages
              .filter(
                (m) => m.to_handle === `dispatch:${last.dispatchId}` || m.to_handle === handle
              )
              .map((m) => m.body)
              .filter(Boolean)
          ]
          for (const text of pending) {
            const original = candidates.findLast((body) =>
              body.startsWith(text.replace(/(…|\.\.\.)$/, ''))
            )
            if (original) {
              lostMessages.push({ prompt: original, dropped: { text, at: last.errorStop.at } })
            }
          }
        }
        const text = resumeText([...mine, ...lostMessages])
        try {
          await call(
            'orchestration.send',
            {
              from: last.party?.address ?? last.by.id,
              to: `dispatch:${last.dispatchId}`,
              subject: '额度恢复后继续',
              body: text
            },
            last.party ? dispatcherEnvelope(last.party) : {}
          )
        } catch {
          continue
        }
        lastSent.set(handle, now())
        const resent = [...mine, ...lostMessages].filter((d) => d.dropped && !d.dropped.resentAt)
        const at = new Date(now()).toISOString()
        if (resent.length) {
          const sent = dropped.get(last.dispatchId) ?? new Set()
          for (const d of resent) {
            sent.add(d.dropped.text)
            d.dropped.resentAt = at
          }
          dropped.set(last.dispatchId, sent)
        }
        const root = mine.find((d) => !d.parent) ?? last
        const where = dispatchLocation(root)
        try {
          record({
            id: `quota-resume:${randomUUID()}`,
            ts: at,
            businessId: where.businessId,
            projectId: where.projectId,
            kind: 'system',
            title: `${NAMES[agent] ?? agent} 额度恢复，已让下属接着做${resent.length ? `，并重发了出错时丢掉的 ${resent.length} 条消息` : ''}`,
            detail: (root.title || root.prompt).split('\n')[0].slice(0, 120),
            agent,
            taskId: root.id
          })
        } catch {}
      }
    }
  }
}

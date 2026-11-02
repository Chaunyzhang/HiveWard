// 派单记录：谁（桌面端会话 / Grok / 命令行）在哪个终端派了什么活。
// 每一次 opc new / opc tell 是一条；状态和汇报从该终端 Agent 的对话记录里推出来，算出来就落盘，
// 终端关了也还能看到最后的结果。
import { dataDir } from './data-dir.mjs'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { optionalRpc } from './api-runtime.mjs'
import { badRequest } from './business.mjs'
import { observeTerminal } from './business-terminals.mjs'
import { locate, readChat, readTurnState } from './transcripts.mjs'
import { issueConfirmation } from './confirmations.mjs'

const dir = dataDir()
const file = join(dir, 'dispatches.json')
// owner：老板在架构图的老板卡上派的活（交给这块业务的总 Agent）
const KINDS = new Set(['claude-desktop', 'claude-code', 'grok', 'cli', 'owner'])
const KEEP = 200

export function dispatches() {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') {
      return []
    }
    throw e
  }
}

function save(rows) {
  mkdirSync(dir, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(rows.slice(-KEEP), null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

export function recordDispatch(body) {
  const by = body.by ?? {}
  if (typeof body.handle !== 'string' || !body.handle) {
    throw badRequest('缺少 handle')
  }
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw badRequest('缺少 prompt')
  }
  if (!KINDS.has(by.kind) || typeof by.id !== 'string' || !by.id) {
    throw badRequest('by 需要 kind 和 id')
  }
  const row = {
    id: `dsp_${randomUUID().slice(0, 8)}`,
    handle: body.handle,
    project: typeof body.project === 'string' ? body.project : '',
    agent: typeof body.agent === 'string' ? body.agent : null,
    title: typeof body.title === 'string' ? body.title : '',
    prompt: body.prompt.trim(),
    by: { kind: by.kind, id: by.id, label: String(by.label ?? by.kind), cwd: by.cwd },
    // leader：这句话是派给这一行的总 Agent 的（老板卡 / opc assign），开出来的 Agent 就是总 Agent
    ...(body.role === 'leader' ? { role: 'leader' } : {}),
    at: new Date().toISOString(),
    status: 'pending'
  }
  save([...dispatches(), row])
  return row
}

const norm = (s) => s.replace(/\s+/g, ' ').trim()
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

const OPEN = new Set(['pending', 'dispatched'])

/**
 * 从对话记录推状态：没收到 → pending；在干 → dispatched；干完有回话 → completed（最后一段话当汇报）。
 * bounded：只看到下一句派过去的话为止（同一终端后面又派了活时，前面那条只认它自己那段回话）。
 */
function judge(d, items, working, bounded = false, canFinish = true) {
  const key = norm(d.prompt).slice(0, 30)
  let start = -1
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user' && norm(items[i].text).includes(key)) {
      start = i
      break
    }
  }
  if (start < 0) {
    return working ? { status: 'dispatched' } : { status: 'pending' }
  }
  if (working) {
    return { status: 'dispatched' }
  }
  const next = bounded ? items.findIndex((it, i) => i > start && it.kind === 'user') : -1
  const replies = items
    .slice(start + 1, next < 0 ? undefined : next)
    .filter((it) => it.kind === 'assistant' && it.text.trim())
  if (!replies.length || !canFinish) {
    return { status: 'dispatched' }
  }
  const last = replies.at(-1)
  const report = {
    outcome: 'succeeded',
    summary: clip(last.text.trim(), 1200),
    reportedAt: last.ts ?? new Date().toISOString()
  }
  // Agent 停下来要老板拍板：话里带【需要确认】→ 受阻，问题进待办
  const ask = /【需要确认】\s*([\s\S]*)/.exec(last.text)
  if (ask) {
    return {
      status: 'blocked',
      blockedReason: clip(ask[1].trim().split('\n')[0] || '需要你确认', 200),
      report
    }
  }
  return { status: 'completed', report }
}

/** 受阻的派单 → 待办。选项取【需要确认】后面以「1. / - 」开头的行；含「建议」的那行当建议 */
export function dispatchDecision(d, businessId) {
  const text =
    /【需要确认】\s*([\s\S]*)/.exec(d.report?.summary ?? '')?.[1] ?? d.blockedReason ?? ''
  const lines = text.split('\n').map((l) => l.trim())
  const options = lines
    .map((l) => /^(?:\d+[.、)]|[-*])\s+(.+)/.exec(l)?.[1]?.replace(/\*\*/g, ''))
    .filter(Boolean)
    .slice(0, 6)
  const hint = lines.find((l) => /建议/.test(l))
  // Agent 附的截图（opc browser screenshot 存在 /tmp/opc-shot-*.png）直接给老板看
  const shot = /\/tmp\/(opc-shot-\d+\.png)/.exec(text)?.[1]
  const plain = (l) => l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  return {
    id: d.id,
    businessId: businessId ?? '',
    source: 'question',
    question: d.blockedReason ?? '需要你确认',
    body:
      lines
        .filter((l) => l && !options.some((o) => l.includes(o)) && !/opc-shot-/.test(l))
        .slice(1)
        .map(plain)
        .join('\n') || undefined,
    screenshot: shot ? `/api/shots/${shot}` : undefined,
    options,
    recommendation: hint ? options.find((o) => hint.includes(o)) : undefined,
    urgency: 'normal',
    state: 'pending',
    createdAt: d.updatedAt ?? d.at,
    dispatch: { handle: d.handle, agent: d.agent, by: d.by.label }
  }
}

/** 老板在待办里答复：把话发回那个 Agent 的终端，原派单记为已汇报（附上老板的决定），答复本身记成一条新派单 */
export async function answerDispatch(id, text, send) {
  const rows = dispatches()
  const d = rows.find((x) => x.id === id)
  if (!d) {
    return null
  }
  // 附一个一次性确认码：老板同意执行时，Agent 带着它才能点发布 / 提交这类按钮
  const code = issueConfirmation(d.handle)
  await send(
    d.handle,
    `老板答复：${text}\n\n（确认码 ${code}，30 分钟内有效、只能用一次。只有老板同意执行时才用：在最后那一下加 --confirm ${code}，例如 opc browser click <ref> --confirm ${code}）`
  )
  Object.assign(d, {
    status: 'completed',
    blockedReason: undefined,
    report: { ...d.report, summary: `${d.report?.summary ?? ''}\n\n**老板决定**：${text}` },
    updatedAt: new Date().toISOString()
  })
  save(rows.map(({ alive, liveAgent, ...rest }) => rest))
  return recordDispatch({
    handle: d.handle,
    project: d.project,
    agent: d.agent,
    prompt: text,
    by: { kind: 'cli', id: 'opc-owner', label: '老板' }
  })
}

/**
 * 刷新派单状态。每个终端读一次对话记录，把这个终端上还没定论的派单都推一遍：
 * - 最新那条：照常推（在干 / 已汇报 / 要确认）；
 * - 前面的：下一句话来之前已经回过话 → 已汇报；还没回话就又被追加了 → 后面那句挂到它下面（parent），
 *   追加的话不单独算任务，Agent 最后的汇报回填到原任务上。
 * 终端没了：已汇报的保留，还没汇报的记为失败。
 */
export async function observeDispatches(listed) {
  const rows = dispatches()
  if (!rows.length) {
    return rows
  }
  const byHandle = new Map()
  for (const d of rows) {
    byHandle.set(d.handle, [...(byHandle.get(d.handle) ?? []), d])
  }
  let changed = false
  const update = (d, next) => {
    if (next.status === d.status && next.report?.summary === d.report?.summary) {
      return
    }
    Object.assign(d, next, { updatedAt: new Date().toISOString() })
    changed = true
  }
  // 同一终端上前面还没定论的派单：自己那段有回话 → 已汇报；没有 → 后面那句挂到它下面
  const settleEarlier = (list, items) =>
    list.forEach((x, i) => {
      if (i === list.length - 1 || !OPEN.has(x.status)) {
        return
      }
      const r = items.length ? judge(x, items, false, true) : {}
      // 就算当时要确认，后面已经接着说了，也算这段结束
      if (r.report) {
        update(x, { status: 'completed', report: r.report, blockedReason: undefined })
      } else if (!list[i + 1].parent) {
        list[i + 1].parent = x.parent ?? x.id
        changed = true
      }
    })
  await Promise.all(
    [...byHandle.values()].map(async (list) => {
      const d = list.at(-1)
      const t = listed.find((x) => x.handle === d.handle)
      for (const x of list) {
        x.alive = !!t
      }
      if (d.status === 'completed' || (d.status === 'blocked' && d.report)) {
        return
      }
      if (!t) {
        settleEarlier(list, [])
        if (OPEN.has(d.status) || d.status === 'blocked') {
          update(d, { status: 'failed', blockedReason: '终端已关闭，没有汇报' })
        }
      } else {
        const [observed, status] = await Promise.all([
          observeTerminal(t),
          optionalRpc('terminal.agentStatus', { terminal: d.handle })
        ])
        const a = status?.agentStatus
        let working = !!a?.isRunningAgent && a.status === 'working'
        let turn = null
        let items = []
        if (observed.pid && observed.agent) {
          const { agent, path } = await locate({
            pid: observed.pid,
            cwd: t.worktreePath,
            startedAt: Date.parse(observed.startedAt) || undefined
          })
          if (agent && path) {
            items = readChat(agent, path)
            turn = readTurnState(agent, path)
          }
          if (!d.agentObserved) {
            d.agentObserved = true
            d.agentObservedAt = new Date().toISOString()
            changed = true
          }
          d.agent = d.agent ?? observed.agent
        }
        d.liveAgent = observed.agent
        settleEarlier(list, items)
        // 读不到对话（Agent 退了、记录找不到）又没在干活：维持原判，别把已汇报的打回去
        working ||= turn === 'working'
        if (a?.status === 'permission') {
          update(d, { status: 'blocked', blockedReason: 'Agent 正在等待权限确认' })
        } else if (observed.exitedToShell && d.agentObserved && OPEN.has(d.status)) {
          update(d, { status: 'failed', blockedReason: 'Agent 已退出，没有汇报' })
        } else if (items.length || working) {
          update(d, judge(d, items, working, false, turn === 'completed' || a?.status === 'idle'))
        }
      }
      // 最新那条是追加的话：它的进展就是原任务的进展
      const root = d.parent && list.find((x) => x.id === d.parent)
      if (root && (root.status !== d.status || root.report?.summary !== d.report?.summary)) {
        Object.assign(root, {
          status: d.status,
          report: d.report,
          blockedReason: d.blockedReason,
          updatedAt: d.updatedAt
        })
        changed = true
      }
    })
  )
  if (changed) {
    // 只落盘结果字段，alive / liveAgent 是瞬时观察
    save(rows.map(({ alive, liveAgent, ...rest }) => rest))
  }
  return rows
}

/** 派单 → 任务列表里的一条 */
export function dispatchTask(d, businessId, followUps = []) {
  return {
    id: d.id,
    businessId: businessId ?? '',
    objectiveId: '',
    runId: '',
    title: clip(norm(d.prompt.split('\n')[0]), 80),
    status: d.status,
    deps: [],
    assignee: d.agent
      ? { agent: d.agent, dispatchId: `term:${d.handle}`, liveness: d.alive ? 'live' : 'exited' }
      : undefined,
    blockedReason: d.blockedReason,
    report: d.report,
    updatedAt: d.updatedAt ?? d.at,
    project: d.project ? d.project.split('/').pop() : undefined,
    dispatchedBy: { kind: d.by.kind, id: d.by.id, label: d.by.label },
    terminal: d.alive ? d.handle : undefined,
    followUps: followUps.length ? followUps.map((f) => clip(norm(f.prompt), 200)) : undefined
  }
}

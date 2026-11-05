import type {
  BusinessSummary,
  HiveWardTerminal,
  TopologyNode,
} from '@shared/api'
import {
  agentStatus,
  terminalTitle,
  type AgentStatus,
} from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { topologySeats, type Seat } from '@/components/hiveward/topology-seats'
import {
  airborneCount,
  airborneLabel,
  airborneOf,
  rootLabel,
  type Airborne,
} from './airborne-seat'
import { externalOrigin } from './external-seat'

/** 左栏会话树里的一个会话：架构图上的一个节点 */
export type SessionRow = {
  node: TopologyNode
  /** 坐的位子（seatTitle）；没坐座位的为空 */
  title?: string
  /** 只留需要你看一眼的：干活蓝、等你橙、出错红、额度用完（橙圈） */
  status?: AgentStatus
  /** 主 Agent 之外还在跑的后台命令数（只写进悬停提示，不改状态） */
  background?: number
  /** 架构图上挂在它后面的（CEO / Leader 的下属、下属的下属） */
  children: SessionRow[]
}

export type ProjectGroup = {
  /** 记住展开收起用的键 */
  key: string
  /** 「未归项目」没有 */
  projectId?: string
  /** 项目目录 */
  path?: string
  label: string
  /** 空降 Leader 的影子行（别的电脑上的派单方）：点它到那台电脑上打开真正的座位 */
  airborne?: { node: TopologyNode; info: Airborne }
  sessions: SessionRow[]
}

export type BusinessTree = {
  business: BusinessSummary
  ceo?: SessionRow
  grok?: SessionRow
  projects: ProjectGroup[]
  /** 「外来派单」组：别的电脑派过来、不属于这台电脑任何业务的活；没有业务页 */
  foreign?: boolean
}

const SHOWN = new Set<AgentStatus>(['working', 'waiting', 'failed', 'quota'])

/** 节点的实况：接着终端时以终端为准，和架构图同一套判断 */
export function sessionStatus(
  n: TopologyNode,
  terminals: HiveWardTerminal[] | undefined
): AgentStatus | undefined {
  const terminal =
    n.terminal && terminals
      ? (terminals.find((t) => t.handle === n.terminal) ?? null)
      : undefined
  const s = agentStatus({
    terminal,
    state: n.state,
    liveness: n.liveness,
    // 远程下属的终端在执行端那台电脑上，本机没有：照后台报的状态
    session: !!n.sessionId || !!n.execution,
    errorStop: n.errorStop,
  })
  return s && SHOWN.has(s) ? s : undefined
}

/** Leader 位上真有人（终端、桌面端会话或派单方）才算一个会话；空位不列 */
const seated = (n: TopologyNode) =>
  !!(n.terminal || n.sessionId || n.dispatcher || n.dispatchId)

/**
 * 业务 → CEO（后面挂它直接派的下属）、Personal Agent、项目 → Leader → 下属 → 下属的下属。
 * 和架构图读同一份节点（全公司那份）、用同一种排法（topologySeats），架构图上有什么、左栏就有什么：
 * 项目是架构图上的项目行（开着的项目、有会话时的「未归项目」），外援照架构图挂在发话方下面。
 */
export function buildSessionTree(
  businesses: BusinessSummary[],
  /** 这台电脑的全公司架构图节点（每块业务的子树和业务页那份一致） */
  nodes: TopologyNode[],
  terminals: HiveWardTerminal[] | undefined,
  keyPrefix = '',
  /** 左栏里并排列着的其他电脑：和架构图一样，空降影子的派单方也在时只留占位 */
  beside?: readonly string[]
): BusinessTree[] {
  const roots = topologySeats(nodes, { beside })[0]?.children ?? []
  const row = (s: Seat & { node: TopologyNode }): SessionRow => ({
    node: s.node,
    title: seatTitle(s.node, nodes),
    status: sessionStatus(s.node, terminals),
    background: terminals?.find((t) => t.handle === s.node.terminal)
      ?.backgroundCommands,
    children: s.children.filter(isSession).map(row),
  })
  const tree = (b: BusinessSummary, root?: Seat): BusinessTree => {
    const ceo = root?.children.find((s) => s.role === 'ceo')
    const projects = (ceo ?? root)?.children ?? []
    return {
      business: b,
      ceo: ceo?.node && row({ ...ceo, node: ceo.node }),
      grok: ceo?.spur?.node && row({ ...ceo.spur, node: ceo.spur.node }),
      projects: projects.flatMap(
        ({ role, node: n, children, merged }): ProjectGroup[] => {
          if (role !== 'project' || !n) {
            return []
          }
          const sessions = children.filter(isSession).map(row)
          const a = airborneOf(n)
          // 空降 Leader：别的电脑派活过来的影子行，下属挂在它下面
          return a
            ? [
                {
                  key: `${keyPrefix}${b.id}/${n.id}`,
                  label: merged ? airborneCount(a) : airborneLabel(a),
                  airborne: { node: n, info: a },
                  sessions,
                },
              ]
            : [
                {
                  key: `${keyPrefix}${b.id}/${n.projectId ?? 'unassigned'}`,
                  projectId: n.projectId,
                  path: n.project,
                  label: n.label,
                  sessions,
                },
              ]
        }
      ),
    }
  }
  const own = businesses
    .filter((b) => b.status !== 'archived')
    .map((b) =>
      tree(
        b,
        roots.find((s) => s.node?.businessId === b.id)
      )
    )
  // 下属目录不属于任何业务的空降派单：后台归在「外来派单」那一组，左栏也单列一组
  const foreign = roots.flatMap((s) =>
    s.node &&
    !businesses.some((b) => b.id === s.node?.businessId) &&
    s.children.some((k) => k.node && airborneOf(k.node))
      ? [{ ...tree(foreignBusiness(s.node), s), foreign: true }]
      : []
  )
  return [...own, ...foreign]
}

/** 「外来派单」组没有登记过的业务，拼一个只够左栏画组标题的业务摘要 */
function foreignBusiness(n: TopologyNode): BusinessSummary {
  return {
    id: n.id,
    name: rootLabel(n) || tr('外来派单'),
    status: 'active',
    priority: 3,
    workspacePath: n.project ?? '',
    leader: null,
    projects: [],
    counts: {
      objectivesRunning: 0,
      tasksOpen: 0,
      tasksDone: 0,
      workersLive: 0,
      decisionsPending: 0,
    },
    updatedAt: '',
  }
}

/** 座位树里算一个会话的：Leader 和下属（项目、业务那几格不算） */
const isSession = (s: Seat): s is Seat & { node: TopologyNode } =>
  !!s.node && (s.role === 'leader' || s.role === 'worker')

/** 一组会话连同挂在后面的，摊平成一列（算状态点、找选中的那一行用） */
export function allRows(rows: (SessionRow | undefined)[]): SessionRow[] {
  return rows.flatMap((r) => (r ? [r, ...allRows(r.children)] : []))
}

/** 一组会话合成一个点：有出错 → 红；有人等你 → 橙；有人额度用完停着 → 橙圈；有人在干活 → 蓝 */
export function groupStatus(
  rows: (SessionRow | undefined)[]
): AgentStatus | undefined {
  const s = rows.map((r) => r?.status)
  return s.includes('failed')
    ? 'failed'
    : s.includes('waiting')
      ? 'waiting'
      : s.includes('quota')
        ? 'quota'
        : s.includes('working')
          ? 'working'
          : undefined
}

/**
 * 会话坐在哪个位子上：「业务 · 项目 · Leader」「业务 · 项目 · 下属」「业务 · CEO · 下属」「业务 · CEO」；
 * 外援写「外援 · 它自己的业务 · 项目 · 职位」。
 * 中间栏标题、左栏会话行、终端列表都用它；没坐座位的（未归项目里的、没经派单的终端）返回 undefined，照旧显示终端标题。
 */
export function seatTitle(
  n: TopologyNode,
  nodes: TopologyNode[]
): string | undefined {
  // 别的业务找来帮忙的：写它自己的出处
  const origin = externalOrigin(n)
  if (origin) {
    return tr('外援 · {0}', [origin])
  }
  const byId = new Map(nodes.map((x) => [x.id, x]))
  // 下属往上找到它挂在谁下面（Leader 或 CEO，可能隔几层）
  let boss: TopologyNode | undefined = n
  while (boss?.kind === 'worker') {
    boss = boss.parentId ? byId.get(boss.parentId) : undefined
  }
  // 挂在空降 Leader（别的电脑上的派单方）下面的：不是本机哪个座位的下属，照旧写手上的活
  if (!boss || airborneOf(boss)) {
    return undefined
  }
  const isRoot = (x?: TopologyNode) =>
    x?.kind === 'business' || x?.kind === 'project'
  const root =
    boss.kind === 'grok'
      ? nodes.find((x) => isRoot(x) && x.businessId === boss.businessId)
      : boss.parentId
        ? byId.get(boss.parentId)
        : undefined
  if (!root || !isRoot(root)) {
    return undefined
  }
  const self = n === boss
  // CEO 的下属写「CEO · 下属」；项目的下属写「项目 · 下属」
  const seat =
    boss.kind === 'ceo'
      ? ['CEO', ...(self ? [] : [tr('下属')])]
      : boss.kind === 'grok'
        ? self
          ? ['Personal Agent']
          : undefined
        : boss.kind === 'leader' && (boss.projectId || seated(boss))
          ? [
              ...(boss.projectId ? [boss.label] : []),
              self ? 'Leader' : tr('下属'),
            ]
          : undefined
  return seat && [root.label, ...seat].join(' · ')
}

/** 没坐座位的会话行上写什么：它手上的活（终端标题），没有活写名字 */
export function sessionLabel(n: TopologyNode): string {
  return terminalTitle(n.activity) ?? n.label
}

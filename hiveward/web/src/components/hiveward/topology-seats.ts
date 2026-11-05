import type { TopologyNode } from '@shared/api'
import { airborneKids, airborneOf } from '@/features/session/airborne-seat'
import type { Slot } from './topology-layout'

/**
 * 架构图上的角色各坐哪一列、线怎么经过它。加一种新角色：在这里声明一行，再在画布里给它一个外形，连线不用动。
 * 从左到右：电脑 → 业务 → CEO（Personal Agent 在它正上方）→ 项目 → Leader → 下属 → 下属的下属…
 */
export const ROLES = {
  computer: { col: 0 },
  business: { col: 1, gap: 40 },
  ceo: { col: 2, align: 'center' },
  pa: { col: 2, align: 'center' },
  project: { col: 3 },
  leader: { col: 4, pass: 'bridge', align: 'center' },
  worker: { col: 5 },
} as const satisfies Record<
  string,
  Pick<Slot, 'col' | 'pass' | 'align' | 'gap'>
>

export type TopologyRole = keyof typeof ROLES

/** 线尾 ⊕ 能加什么：CEO 后面加项目 / 下属；Leader 后面加下属 */
export type AddKind = 'ceo' | 'leader'

const ADD_COL: Record<AddKind, number> = {
  ceo: ROLES.project.col,
  leader: ROLES.worker.col,
}

export type Seat = Omit<Slot, 'children' | 'spur'> & {
  role: TopologyRole
  node?: TopologyNode
  add?: AddKind
  spur?: Seat
  children: Seat[]
  /** 空降影子卡：派单方那台电脑在总览里也有一列，这张卡只当「派来 N 个」的占位 */
  merged?: boolean
}

export const isUnassigned = (n: TopologyNode) =>
  n.kind === 'leader' && !n.projectId && n.id.endsWith(':unassigned')

function seat(
  role: TopologyRole,
  id: string,
  node: TopologyNode | undefined,
  children: Seat[] = [],
  add?: AddKind
): Seat {
  return {
    id,
    role,
    node,
    ...ROLES[role],
    children,
    ...(add && { add, addCol: ADD_COL[add] }),
  }
}

/**
 * 一台电脑的架构节点排成座位树。
 * 业务 → CEO → [项目…, CEO 直接派的下属…]；Personal Agent 挂在 CEO 正上方。没登记的目录没有 CEO，项目直接挂在业务后面。
 * 每个项目都有 Leader 位：项目 → Leader（并联在线上，没人坐时画空位）→ 下属。
 * project 为 true 时只排项目这一段（项目页）。
 * beside：总览里并排画着的其他电脑（机器 id），空降影子的派单方在里面时影子卡只当占位。
 */
export function topologySeats(
  nodes: TopologyNode[],
  {
    project,
    canAdd,
    beside,
  }: { project?: boolean; canAdd?: boolean; beside?: readonly string[] }
): Seat[] {
  const childrenOf = (id: string) => nodes.filter((n) => n.parentId === id)
  const byId = (id?: string) => nodes.find((n) => n.id === id)
  // 每块业务一组：根是业务节点（旧版后台叫 project）
  const roots = nodes.filter(
    (n) => (n.kind === 'business' || n.kind === 'project') && !n.parentId
  )

  // 派到别的电脑上执行的下属：接过来的线画虚线
  const worker = (n: TopologyNode): Seat => ({
    ...seat('worker', n.id, n, childrenOf(n.id).map(worker)),
    ...(n.execution && { dashed: true }),
  })

  const projectSeat = (n: TopologyNode): Seat => {
    // 空降 Leader（别的电脑派活过来的影子卡）：坐项目那一列，派来的下属挂在它后面；总览里 A 列也在时只留占位
    const a = airborneOf(n)
    if (a) {
      const merged = !!beside?.includes(a.machineId)
      const kids = airborneKids(
        a,
        childrenOf(n.id).filter((k) => k.kind === 'worker'),
        merged
      )
      return { ...seat('project', n.id, n, kids.map(worker)), merged }
    }
    const workers = childrenOf(n.id).map(worker)
    // 未归项目、旧版不带项目的 Leader：没有 ⊕，下属直接挂在卡后面
    if (!n.projectId) return seat('project', n.id, n, workers)
    const leader = seat(
      'leader',
      `${n.id}:leader`,
      n,
      workers,
      canAdd && n.businessId ? 'leader' : undefined
    )
    return seat('project', n.id, n, [leader])
  }

  // 项目行：Leader 和空降 Leader（影子卡 kind 也是 leader）
  const leadersOf = (root: TopologyNode) =>
    childrenOf(root.id).filter((n) => n.kind === 'leader')

  if (project) {
    return roots.flatMap((r) =>
      leadersOf(r)
        .filter((n) => !airborneOf(n))
        .map(projectSeat)
    )
  }

  const business = (root: TopologyNode): Seat => {
    const leaders = leadersOf(root)
    const projects = leaders.map(projectSeat)
    const ceo = childrenOf(root.id).find((n) => n.kind === 'ceo')
    if (!ceo) return seat('business', root.id, root, projects)
    const grok =
      byId(leaders.find((n) => n.via)?.via) ??
      nodes.find((n) => n.kind === 'grok' && n.businessId === root.businessId)
    // CEO 直接派的下属（不属于任何项目）挂在 CEO 后面，排在项目下面
    const ceoSeat = seat(
      'ceo',
      ceo.id,
      ceo,
      [...projects, ...childrenOf(ceo.id).map(worker)],
      canAdd && root.businessId ? 'ceo' : undefined
    )
    if (grok) ceoSeat.spur = seat('pa', grok.id, grok)
    return seat('business', root.id, root, [ceoSeat])
  }

  return [seat('computer', 'computer', undefined, roots.map(business))]
}

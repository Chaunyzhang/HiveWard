import type { TopologyNode } from '@shared/api'
import { describe, expect, it } from 'vitest'
import { GAP_X, layoutTree, type Box, type Layout } from './topology-layout'
import { topologySeats, type Seat, type TopologyRole } from './topology-seats'

// 每种角色一张假尺寸：CEO、Personal Agent 只有方块 / 圆接线，Leader 的线从底下穿过
const BOX: Record<TopologyRole, Box> = {
  computer: { w: 120, h: 36 },
  business: { w: 240, h: 72 },
  ceo: { w: 90, h: 66, port: { x: 21, y: 0, w: 48, h: 48 } },
  pa: { w: 130, h: 60, port: { x: 43, y: 0, w: 44, h: 44 } },
  project: { w: 176, h: 48 },
  leader: { w: 150, h: 56, port: { x: 20, y: 0, w: 110, h: 32 } },
  worker: { w: 224, h: 64 },
}

const flat = (seats: Seat[]): Seat[] =>
  seats.flatMap((s) => [s, ...(s.spur ? [s.spur] : []), ...flat(s.children)])

function lay(
  nodes: TopologyNode[],
  opts: Parameters<typeof topologySeats>[1] = { canAdd: true }
) {
  const seats = topologySeats(nodes, opts)
  const all = flat(seats)
  const sizes = Object.fromEntries(all.map((s) => [s.id, BOX[s.role]]))
  const layout = layoutTree(seats, sizes)
  const byId = Object.fromEntries(all.map((s) => [s.id, s]))
  const at = (id: string) => layout.boxes[id]
  // 线在这张卡上的高度
  const trunk = (id: string) => {
    const s = byId[id]
    const b = BOX[s.role]
    return (
      at(id).y +
      (s.pass === 'bridge' ? b.h : (b.port?.y ?? 0) + (b.port?.h ?? b.h) / 2)
    )
  }
  return { seats, all, layout, at, trunk, byId }
}

/** 任意两张卡不重叠，连线里没有 NaN */
function expectSane(all: Seat[], layout: Layout) {
  expect(layout.path).not.toMatch(/NaN|Infinity|undefined/)
  for (const a of all)
    for (const b of all) {
      if (a.id >= b.id) continue
      const p = layout.boxes[a.id]
      const q = layout.boxes[b.id]
      const pa = BOX[a.role]
      const qb = BOX[b.role]
      const apart =
        p.x + pa.w <= q.x ||
        q.x + qb.w <= p.x ||
        p.y + pa.h <= q.y ||
        q.y + qb.h <= p.y
      expect(apart, `${a.id} 和 ${b.id} 重叠`).toBe(true)
    }
  for (const p of Object.values(layout.boxes)) {
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.y).toBeGreaterThanOrEqual(0)
  }
}

let seq = 0
const node = (n: Partial<TopologyNode> & Pick<TopologyNode, 'kind'>) =>
  ({ id: `${n.kind}-${++seq}`, label: n.kind, ...n }) as TopologyNode

/** 一块登记过的业务：业务、CEO、Personal Agent */
function business(id: string) {
  const root = node({ id, kind: 'business', businessId: id })
  const ceo = node({
    id: `ceo:${id}`,
    kind: 'ceo',
    parentId: id,
    businessId: id,
  })
  const grok = node({ id: `grok:${id}`, kind: 'grok', businessId: id })
  return { root, ceo, grok, nodes: [root, ceo, grok] }
}
const project = (b: string, name: string, leader = false) =>
  node({
    id: `leader:${name}`,
    kind: 'leader',
    parentId: b,
    businessId: b,
    projectId: name,
    label: name,
    ...(leader && { agent: 'claude-code' as TopologyNode['agent'] }),
  })
const worker = (parentId: string, id: string) =>
  node({ id, kind: 'worker', parentId })

describe('架构图排版', () => {
  it('同一角色坐同一列：坐了人和空着的 Leader 位，下属都在同一列', () => {
    const b = business('b1')
    const withLeader = project('b1', 'p1', true)
    const without = project('b1', 'p2')
    const { all, layout, at, trunk } = lay([
      ...b.nodes,
      withLeader,
      worker(withLeader.id, 'w1'),
      worker(withLeader.id, 'w2'),
      without,
      worker(without.id, 'w3'),
    ])
    expectSane(all, layout)
    expect(at('w1').x).toBe(at('w3').x)
    expect(at('w2').x).toBe(at('w3').x)
    expect(at(withLeader.id).x).toBe(at(without.id).x)
    // 主干是直的：业务 → CEO → 第一个项目 → Leader → 第一个下属在同一条线上
    for (const id of [
      'b1',
      b.ceo.id,
      withLeader.id,
      `${withLeader.id}:leader`,
      'w1',
    ])
      expect(trunk(id)).toBe(trunk('b1'))
    // 没人坐的项目也有 Leader 空位，下属挂在空位后面，同一条线
    expect(at(`${without.id}:leader`).x).toBe(at(`${withLeader.id}:leader`).x)
    expect(trunk('w3')).toBe(trunk(`${without.id}:leader`))
    expect(trunk(`${without.id}:leader`)).toBe(trunk(without.id))
    // 两个 Leader 位的 ⊕ 竖着对齐，都在下属列前面的空隙正中；项目卡后面不再有 ⊕
    const leaderAdd = layout.adds[`${withLeader.id}:leader`]
    const vacantAdd = layout.adds[`${without.id}:leader`]
    expect(leaderAdd.x).toBe(vacantAdd.x)
    expect(vacantAdd.x).toBe(at('w3').x - GAP_X / 2)
    expect(layout.adds[withLeader.id]).toBeUndefined()
    expect(layout.adds[without.id]).toBeUndefined()
  })

  it('Leader 是并联的：两条腿落在线上，胶囊在线上方', () => {
    const b = business('b1')
    const p = project('b1', 'p1', true)
    const { layout, at, trunk } = lay([...b.nodes, p, worker(p.id, 'w1')])
    const id = `${p.id}:leader`
    const y = trunk(id)
    expect(layout.dots).toContainEqual({ x: at(id).x, y })
    expect(layout.dots).toContainEqual({ x: at(id).x + BOX.leader.w, y })
    expect(at(id).y + BOX.leader.port!.h).toBeLessThan(y)
  })

  it('Personal Agent 在 CEO 正上方：从 CEO 前面的线上分叉上去，穿过它再从右边落回线上', () => {
    const b = business('b1')
    const { layout, at, trunk } = lay(b.nodes)
    const ceo = at(b.ceo.id)
    const pa = at(b.grok.id)
    expect(pa.x + 43 + 22).toBe(ceo.x + 21 + 24)
    expect(pa.y + BOX.pa.h).toBeLessThan(ceo.y)
    const colLeft = ceo.x - (130 - 90) / 2
    const jx = colLeft - GAP_X / 2
    const rx = colLeft + 130 + GAP_X / 2
    const y = trunk(b.ceo.id)
    expect(layout.dots).toContainEqual({ x: jx, y })
    expect(layout.dots).toContainEqual({ x: rx, y })
    // 右边那条腿：从圆圈右沿出来，落到 rx 那一点
    const top = pa.y + 22
    expect(layout.path).toContain(`M${pa.x + 43 + 44} ${top}H`)
    expect(layout.path).toMatch(new RegExp(`Q${rx} ${top} ${rx} [\\d.]+V${y}`))
  })

  it('没 CEO（没登记的目录）：项目照样坐项目列，线穿过 CEO 那一列', () => {
    const b = business('b1')
    const p1 = project('b1', 'p1')
    const dir = node({ id: 'dir', kind: 'business', unregistered: true })
    const loose = node({
      id: 'loose',
      kind: 'leader',
      parentId: 'dir',
      projectId: 'x',
    })
    const { all, layout, at, trunk, byId } = lay([...b.nodes, p1, dir, loose])
    expectSane(all, layout)
    expect(at('loose').x).toBe(at(p1.id).x)
    expect(trunk('loose')).toBe(trunk('dir'))
    expect(byId['dir'].children.map((s) => s.id)).toEqual(['loose'])
    // 业务出口一条直线连到项目入口
    expect(layout.path).toContain(`H${at('loose').x}`)
  })

  it('CEO 位空着也照样占 CEO 那一列', () => {
    const b = business('b1')
    const { at } = lay(b.nodes)
    expect(at(b.ceo.id).x).toBeGreaterThan(at('b1').x + BOX.business.w)
  })

  it('未归项目：虚线卡没有 ⊕，下属和别的项目的下属同一列', () => {
    const b = business('b1')
    const p1 = project('b1', 'p1', true)
    const un = node({
      id: 'leader:b1:unassigned',
      kind: 'leader',
      parentId: 'b1',
      businessId: 'b1',
    })
    const { all, layout, at, trunk } = lay([
      ...b.nodes,
      p1,
      worker(p1.id, 'w1'),
      un,
      worker(un.id, 'u1'),
      worker(un.id, 'u2'),
    ])
    expectSane(all, layout)
    expect(at('u1').x).toBe(at('w1').x)
    expect(at('u2').x).toBe(at('w1').x)
    expect(layout.adds[un.id]).toBeUndefined()
    // 两个下属：分叉点有个圆点
    expect(layout.dots).toContainEqual({
      x: at('u1').x - GAP_X / 2,
      y: trunk(un.id),
    })
  })

  it('多层下属一层层往右长，上级和第一个下级同一条线，其余往下排', () => {
    const b = business('b1')
    const p = project('b1', 'p1')
    const { all, layout, at, trunk } = lay([
      ...b.nodes,
      p,
      worker(p.id, 'w1'),
      worker('w1', 'w11'),
      worker('w11', 'w111'),
      worker('w1', 'w12'),
      worker(p.id, 'w2'),
    ])
    expectSane(all, layout)
    expect(at('w11').x).toBe(at('w1').x + BOX.worker.w + GAP_X)
    expect(at('w111').x).toBe(at('w11').x + BOX.worker.w + GAP_X)
    expect(at('w12').x).toBe(at('w11').x)
    expect(trunk('w11')).toBe(trunk('w1'))
    expect(trunk('w111')).toBe(trunk('w1'))
    // 行高由内容撑开：w2 排在 w1 整棵子树（含 w12）下面
    expect(at('w2').y).toBeGreaterThanOrEqual(at('w12').y + BOX.worker.h)
    expect(at('w2').x).toBe(at('w1').x)
  })

  it('CEO 直接派的下属坐下属列，排在项目下面', () => {
    const b = business('b1')
    const p = project('b1', 'p1')
    const { at } = lay([
      ...b.nodes,
      p,
      worker(p.id, 'w1'),
      worker(b.ceo.id, 'c1'),
    ])
    expect(at('c1').x).toBe(at('w1').x)
    expect(at('c1').y).toBeGreaterThan(at('w1').y)
  })

  it('派到别的电脑上的下属：只有它接过来的那一段走虚线，位置和普通下属一样', () => {
    const b = business('b1')
    const remote = node({
      id: 'remote:B:d1',
      kind: 'worker',
      parentId: b.ceo.id,
      execution: { machineId: 'B', dispatchId: 'd1' },
    })
    const { at, trunk, layout, all } = lay([
      ...b.nodes,
      worker(b.ceo.id, 'c1'),
      remote,
    ])
    expectSane(all, layout)
    expect(at(remote.id).x).toBe(at('c1').x)
    const end = `H${at(remote.id).x}`
    expect(layout.dashed).toContain(`${trunk(remote.id)}${end}`)
    expect(layout.path).not.toContain(`${trunk(remote.id)}${end}`)
    expect(layout.dashed).not.toContain(`${trunk('c1')}${end}`)
  })

  it('空降 Leader：影子卡坐项目那一列，派来的下属挂在它后面', () => {
    const b = business('b1')
    const shadow = node({
      id: 'airborne:A:sess1',
      kind: 'leader',
      parentId: b.root.id,
      businessId: 'b1',
      airborne: {
        machineId: 'A',
        machineName: 'Mac',
        dispatcherId: 'sess1',
        dispatcherLabel: 'Leader',
      },
      count: 1,
      remoteChildren: ['d1'],
    })
    const p = project('b1', 'p1')
    const { byId, at, all, layout } = lay([
      ...b.nodes,
      p,
      shadow,
      { ...worker(shadow.id, 'w1'), dispatchId: 'd1' },
    ])
    expectSane(all, layout)
    expect(byId[b.ceo.id].role).toBe('ceo')
    expect(byId[shadow.id].role).toBe('project')
    expect(byId[shadow.id].merged).toBe(false)
    expect(at(shadow.id).x).toBe(at(p.id).x)
    expect(byId[shadow.id].children.map((k) => k.id)).toEqual(['w1'])
  })

  it('多机总览里派单方那台也并排时影子卡只当占位：remoteChildren 里的下属不再画，别的照画', () => {
    const b = business('b1')
    const shadow = node({
      id: 'airborne:A:sess1',
      kind: 'leader',
      parentId: b.root.id,
      businessId: 'b1',
      airborne: {
        machineId: 'A',
        machineName: 'Mac',
        dispatcherId: 'sess1',
        dispatcherLabel: 'Leader',
      },
      count: 1,
      remoteChildren: ['d1'],
    })
    const { byId } = lay(
      [
        ...b.nodes,
        shadow,
        node({
          id: 'w1',
          kind: 'worker',
          parentId: shadow.id,
          dispatchId: 'd1',
        }),
        node({
          id: 'w2',
          kind: 'worker',
          parentId: shadow.id,
          dispatchId: 'd2',
        }),
      ],
      { canAdd: true, beside: ['A'] }
    )
    expect(byId[shadow.id].merged).toBe(true)
    expect(byId[shadow.id].children.map((k) => k.id)).toEqual(['w2'])
  })

  it('空业务：只有业务、CEO 和 CEO 后面的 ⊕；几块业务竖着排，同角色同一列', () => {
    const a = business('a')
    const b = business('b')
    const p = project('b', 'p1')
    const { all, layout, at, trunk } = lay([...a.nodes, ...b.nodes, p])
    expectSane(all, layout)
    expect(layout.adds[a.ceo.id].y).toBe(trunk(a.ceo.id))
    expect(layout.adds[a.ceo.id].x).toBe(at(p.id).x - GAP_X / 2)
    expect(at('a').x).toBe(at('b').x)
    expect(at(a.ceo.id).x).toBe(at(b.ceo.id).x)
    expect(at('b').y).toBeGreaterThan(at('a').y + BOX.business.h)
    // 不能加东西时没有 ⊕
    expect(lay(a.nodes, { canAdd: false }).layout.adds).toEqual({})
  })

  it('没有业务的电脑只有电脑卡', () => {
    const { layout, all } = lay([])
    expect(all.map((s) => s.id)).toEqual(['computer'])
    expect(layout.path).toBe('')
    expect(layout.width).toBe(BOX.computer.w)
  })

  it('多台电脑各排各的：每个项目都有 Leader 位，两台的下属在同一列', () => {
    const a = business('a')
    const pa = project('a', 'pa', true)
    const b = business('b')
    const pb = project('b', 'pb')
    const one = lay([...a.nodes, pa, worker(pa.id, 'wa')])
    const two = lay([...b.nodes, pb, worker(pb.id, 'wb')])
    expect(one.at('wa').x).toBe(two.at('wb').x)
    expect(one.at('computer')).toEqual(two.at('computer'))
  })

  it('项目页只排这个项目：项目卡在最前面，左边不接线', () => {
    const b = business('b1')
    const p = project('b1', 'p1', true)
    const seats = topologySeats([...b.nodes, p, worker(p.id, 'w1')], {
      project: true,
    })
    expect(seats.map((s) => s.role)).toEqual(['project'])
    const sizes = Object.fromEntries(
      flat(seats).map((s) => [s.id, BOX[s.role]])
    )
    const layout = layoutTree(seats, sizes)
    // 项目卡和 Leader 同一条线：Leader 胶囊在线上方，项目卡往下让出这段高度
    expect(layout.boxes[p.id]).toEqual({
      x: 0,
      y: BOX.leader.h - BOX.project.h / 2,
    })
    expect(layout.path.startsWith(`M${BOX.project.w} `)).toBe(true)
  })
})

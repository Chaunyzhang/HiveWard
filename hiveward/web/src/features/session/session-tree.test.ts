import type {
  BusinessSummary,
  HiveWardTerminal,
  TopologyNode,
} from '@shared/api'
import { describe, expect, it } from 'vitest'
import {
  buildSessionTree,
  seatTitle,
  sessionStatus,
  type SessionRow,
} from './session-tree'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 测试夹具只填建树用到的字段
const business = {
  id: 'b',
  name: '网店',
  status: 'active',
  workspacePath: '/biz',
  counts: { decisionsPending: 0 },
  projects: [
    { id: 'p1', businessId: 'b', name: '后台', path: '/biz', status: 'active' },
    {
      id: 'p2',
      businessId: 'b',
      name: 'SEO',
      path: '/biz/seo',
      status: 'active',
    },
    {
      id: 'old',
      businessId: 'b',
      name: '旧',
      path: '/biz/old',
      status: 'archived',
    },
  ],
} as unknown as BusinessSummary

const node = (n: Partial<TopologyNode> & Pick<TopologyNode, 'id' | 'kind'>) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 测试夹具只填建树用到的字段
  ({ label: n.id, businessId: 'b', ...n }) as TopologyNode

describe('buildSessionTree', () => {
  it('和架构图同一种层级：CEO 后面挂它派的下属，项目 → Leader → 下属 → 下属的下属', () => {
    const nodes = [
      node({ id: 'business:b', kind: 'business' }),
      node({ id: 'ceo:b', kind: 'ceo', parentId: 'business:b' }),
      node({ id: 'grok:b', kind: 'grok' }),
      node({
        id: 'l1',
        kind: 'leader',
        parentId: 'business:b',
        projectId: 'p1',
        label: '后台',
        agent: 'claude',
        terminal: 't1',
        state: 'working',
      }),
      node({ id: 'w1', kind: 'worker', parentId: 'l1' }),
      // 空位的 Leader 不算会话，它下面的下属直接挂在项目下
      node({
        id: 'l2',
        kind: 'leader',
        parentId: 'business:b',
        projectId: 'p2',
        label: 'SEO',
      }),
      node({ id: 'w2', kind: 'worker', parentId: 'l2', terminal: 't2' }),
      node({ id: 'w2a', kind: 'worker', parentId: 'w2', state: 'failed' }),
      node({
        id: 'leader:b:unassigned',
        kind: 'leader',
        parentId: 'business:b',
        label: '未归项目',
      }),
      node({
        id: 'w3',
        kind: 'worker',
        parentId: 'leader:b:unassigned',
        terminal: 't3',
      }),
      node({ id: 'c1', kind: 'worker', parentId: 'ceo:b' }),
    ]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 测试夹具只填建树用到的字段
    const terminals = [
      { handle: 't1', status: 'working' },
      { handle: 't2', status: 'permission' },
      { handle: 't3' },
    ] as never
    const [tree] = buildSessionTree([business], nodes, terminals, 'm:')
    const shape = (r: SessionRow): unknown => [
      r.node.id,
      r.status,
      r.children.map(shape),
    ]
    expect(tree.ceo && shape(tree.ceo)).toEqual([
      'ceo:b',
      undefined,
      [['c1', undefined, []]],
    ])
    expect(tree.grok?.node.id).toBe('grok:b')
    expect(
      tree.projects.map((p) => [p.key, p.label, p.sessions.map(shape)])
    ).toEqual([
      ['m:b/p1', '后台', [['l1', 'working', [['w1', undefined, []]]]]],
      ['m:b/p2', 'SEO', [['w2', 'waiting', [['w2a', 'failed', []]]]]],
      ['m:b/unassigned', '未归项目', [['w3', undefined, []]]],
    ])
  })

  it('只剩后台命令在跑：带出命令数，状态照旧按终端（空闲不亮灯）', () => {
    const nodes = [
      node({ id: 'business:b', kind: 'business' }),
      node({ id: 'ceo:b', kind: 'ceo', parentId: 'business:b' }),
      node({ id: 'c1', kind: 'worker', parentId: 'ceo:b', terminal: 't' }),
    ]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 测试夹具只填判断用到的字段
    const terminals = [
      { handle: 't', status: 'idle', backgroundCommands: 1 },
    ] as HiveWardTerminal[]
    const [c1] = buildSessionTree([business], nodes, terminals)[0].ceo!.children
    expect([c1.status, c1.background]).toEqual([undefined, 1])
  })

  it('外援照架构图挂在发话方下面，写它自己的出处', () => {
    const nodes = [
      node({ id: 'business:b', kind: 'business', label: '网店' }),
      node({ id: 'ceo:b', kind: 'ceo', parentId: 'business:b' }),
      node({
        id: 'x',
        kind: 'worker',
        parentId: 'ceo:b',
        external: {
          businessId: 'hw',
          businessName: 'HiveWard',
          projectName: 'bug 修复组',
          role: 'leader',
        },
      }),
    ]
    const [tree] = buildSessionTree([business], nodes, [])
    expect(tree.ceo?.children.map((r) => r.title)).toEqual([
      '外援 · HiveWard · bug 修复组 · Leader',
    ])
  })

  it('空降 Leader 是一行影子，派来的下属挂在下面；不属于任何业务的单列「外来派单」一组', () => {
    // 后台的影子总带 count / remoteChildren；只有派单方那台电脑也并排列着时才收成占位
    const airborne = (id: string, parentId: string, kids: string[]) =>
      node({
        id,
        kind: 'leader',
        parentId,
        airborne: {
          machineId: 'A',
          machineName: 'Mac',
          dispatcherId: id,
          dispatcherLabel: 'Leader',
        },
        online: true,
        count: kids.length,
        remoteChildren: kids,
      })
    const nodes = [
      node({ id: 'business:b', kind: 'business', label: '网店' }),
      node({ id: 'ceo:b', kind: 'ceo', parentId: 'business:b' }),
      airborne('airborne:A:s1', 'business:b', ['d1']),
      node({
        id: 'w1',
        kind: 'worker',
        parentId: 'airborne:A:s1',
        dispatchId: 'd1',
      }),
      node({
        id: 'business:/tmp/x',
        kind: 'business',
        label: '外来派单',
        unregistered: true,
        businessId: undefined,
      }),
      airborne('airborne:A:s2', 'business:/tmp/x', ['d2']),
      node({
        id: 'w2',
        kind: 'worker',
        parentId: 'airborne:A:s2',
        dispatchId: 'd2',
      }),
    ]
    const [own, foreign] = buildSessionTree([business], nodes, [])
    expect(own.ceo?.node.id).toBe('ceo:b')
    expect(
      own.projects.map((p) => [p.label, p.sessions.map((r) => r.node.id)])
    ).toEqual([['Mac · Leader · 空降', ['w1']]])
    expect(foreign.foreign).toBe(true)
    expect(foreign.business.name).toBe('外来派单')
    expect(foreign.projects[0].sessions.map((r) => r.node.id)).toEqual(['w2'])

    const [merged] = buildSessionTree([business], nodes, [], '', ['A'])
    expect(
      merged.projects.map((p) => [p.label, p.sessions.map((r) => r.node.id)])
    ).toEqual([['Mac Leader 派来 1 个', []]])
  })

  it('架构图上没有的项目不列，跳过归档的业务', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 测试夹具只填建树用到的字段
    const archived = {
      ...business,
      id: 'gone',
      status: 'archived',
    } as BusinessSummary
    const trees = buildSessionTree([business, archived], [], [])
    expect(trees).toHaveLength(1)
    expect(trees[0].projects).toEqual([])
  })
})

describe('sessionStatus', () => {
  it('桌面端会话坐座位：对话记录说在干活就是干活，不算等待', () => {
    const ceo = (state: TopologyNode['state']) =>
      node({
        id: 'ceo:b',
        kind: 'ceo',
        sessionId: 's',
        liveness: 'live',
        state,
      })
    expect(sessionStatus(ceo('working'), [])).toBe('working')
    expect(sessionStatus(ceo('pending'), [])).toBe('waiting')
    expect(sessionStatus(ceo('idle'), [])).toBe(undefined)
  })

  it('终端停着、任务记录说还在做：算空闲（灰），不算等你', () => {
    const n = node({
      id: 'w',
      kind: 'worker',
      terminal: 't',
      state: 'working',
      liveness: 'live',
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 测试夹具只填判断用到的字段
    const terminals = [{ handle: 't', status: 'idle' }] as HiveWardTerminal[]
    expect(sessionStatus(n, terminals)).toBe(undefined)
  })
})

describe('seatTitle', () => {
  const nodes = [
    node({ id: 'business:b', kind: 'business', label: '网店' }),
    node({ id: 'ceo:b', kind: 'ceo', parentId: 'business:b' }),
    node({ id: 'grok:b', kind: 'grok' }),
    node({
      id: 'leader:p1',
      kind: 'leader',
      parentId: 'business:b',
      projectId: 'p1',
      label: 'UI 质检组',
    }),
    node({ id: 'w1', kind: 'worker', parentId: 'leader:p1' }),
    node({ id: 'w2', kind: 'worker', parentId: 'w1' }),
    node({ id: 'w3', kind: 'worker', parentId: 'ceo:b' }),
    node({ id: 'leader:b:unassigned', kind: 'leader', parentId: 'business:b' }),
    node({ id: 'w4', kind: 'worker', parentId: 'leader:b:unassigned' }),
  ]
  const title = (id: string) =>
    seatTitle(nodes.find((n) => n.id === id)!, nodes)

  it('写出业务、项目和职位；下属隔几层也认得出挂在哪个项目、还是 CEO 下面', () => {
    expect(title('ceo:b')).toBe('网店 · CEO')
    expect(title('grok:b')).toBe('网店 · Personal Agent')
    expect(title('leader:p1')).toBe('网店 · UI 质检组 · Leader')
    expect(title('w1')).toBe('网店 · UI 质检组 · 下属')
    expect(title('w2')).toBe('网店 · UI 质检组 · 下属')
    expect(title('w3')).toBe('网店 · CEO · 下属')
  })

  it('没坐座位的（未归项目里的、架构图上找不到上级的）不给职位', () => {
    expect(title('w4')).toBe(undefined)
    expect(
      seatTitle(node({ id: 'hiveward:t', kind: 'worker', parentId: '' }), nodes)
    ).toBe(undefined)
  })
})

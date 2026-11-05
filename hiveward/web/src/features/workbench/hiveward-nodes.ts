import type { HiveWardTerminal, TopologyNode } from '@shared/api'
import { terminalTitle } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'

/**
 * 没经派单、在 HiveWard 里直接开的 Agent：按所在目录挂到对应那一行的 Leader Agent 下；
 * 哪一行都对不上的项目单独成一行（只有直线、没有 Leader Agent），这些 Agent 挂在下面。
 */
export function hivewardNodes(
  terminals: HiveWardTerminal[],
  rows: TopologyNode[]
): TopologyNode[] {
  const inside = (path: string, root?: string) =>
    !!root && (path === root || path.startsWith(root + '/'))
  const extra = new Map<string, HiveWardTerminal[]>()
  const nodes: TopologyNode[] = []
  for (const t of terminals) {
    if (!t.agent) {
      continue
    }
    // 落在多个项目目录里时归最深的那个
    const row = rows
      .filter((n) => inside(t.project, n.project))
      .sort((a, b) => (b.project?.length ?? 0) - (a.project?.length ?? 0))[0]
    if (row) {
      nodes.push(hivewardWorker(t, row.id))
    } else {
      extra.set(t.project, [...(extra.get(t.project) ?? []), t])
    }
  }
  for (const [project, list] of extra) {
    const root = `dir:${project}`
    const id = `dir-leader:${project}`
    const label = project.split('/').pop() ?? project
    nodes.push(
      { id: root, kind: 'business', project, label, unregistered: true },
      {
        id,
        kind: 'leader',
        parentId: root,
        project,
        label,
        activity: tr('{0} 个 Agent 在跑', [list.length]),
      },
      ...list.map((t) => hivewardWorker(t, id))
    )
  }
  return nodes
}

export function hivewardWorker(
  t: HiveWardTerminal,
  parentId: string
): TopologyNode {
  return {
    id: `hiveward:${t.handle}`,
    kind: 'worker',
    parentId,
    label: t.agent!,
    agent: t.agent!,
    liveness: 'live',
    activity: terminalTitle(t.title) ?? tr('终端'),
    sublabel: tr('没经派单'),
    terminal: t.handle,
    startedAt: t.startedAt,
    state:
      t.status === 'working'
        ? 'working'
        : t.status === 'permission'
          ? 'blocked'
          : 'idle',
  }
}

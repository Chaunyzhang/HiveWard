import type { TopologyNode } from '@shared/api'
import { tr } from '@/lib/i18n'

/** 外援在它自己业务里的身份 */
const ROLE: Record<NonNullable<TopologyNode['external']>['role'], string> = {
  ceo: 'CEO',
  leader: 'Leader',
  worker: tr('下属'),
}

/** 外援（别的业务找来帮忙的，后台挂在发话方的 CEO / Leader 下面）的出处：「HiveWard · bug 修复组 · Leader」；不是外援返回 undefined */
export function externalOrigin(n: TopologyNode): string | undefined {
  const x = n.external
  return (
    x &&
    [x.businessName, x.projectName, ROLE[x.role]].filter(Boolean).join(' · ')
  )
}

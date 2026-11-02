import type { BusinessSummary } from '@shared/api'

/** 目录属于哪个项目：取包含它的最深的那个项目（项目里套项目时归里面那个）；已移除的不算 */
export function projectForPath(
  businesses: BusinessSummary[],
  dir: string
): BusinessSummary | undefined {
  return businesses
    .filter(
      (b) =>
        b.status !== 'archived' &&
        (dir === b.workspacePath || dir.startsWith(`${b.workspacePath}/`))
    )
    .sort((a, b) => b.workspacePath.length - a.workspacePath.length)[0]
}

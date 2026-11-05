import { hasReachedAppVersion } from './app-version'

export const SQLITE_PROFILE_RELEASE_FLOOR = '1.0.0'

/** 版本只在同一产品内有顺序，HiveWard 的 1.4.x 不是 HiveWard 的后续版本。 */
export function profileStateBuildCompatibilityError(
  _currentVersion: string,
  targetVersion: string,
  targetProduct = 'HiveWard'
): string | null {
  if (
    targetProduct === 'HiveWard' &&
    hasReachedAppVersion(targetVersion, SQLITE_PROFILE_RELEASE_FLOOR)
  ) {
    return null
  }
  return '目标版本不属于支持当前 SQLite 资料的 HiveWard 正式版本。请保留当前版本；手工迁移前使用 --profile-id 导出资料。'
}

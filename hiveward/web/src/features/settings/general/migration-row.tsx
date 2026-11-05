import { useQuery } from '@tanstack/react-query'
import type { MigrationNotice } from '@shared/api'
import { tr } from '@/lib/i18n'
import { SettingRow } from '../components/setting-row'

export function MigrationRow() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['migration'],
    queryFn: async (): Promise<MigrationNotice[]> => {
      const response = await fetch('/api/migration')
      if (!response.ok) {
        throw new Error('migration_unavailable')
      }
      return response.json()
    },
    retry: false,
  })
  const failed = data?.filter((item) => item.status === 'failed') ?? []
  const deferred = data?.filter((item) => item.status === 'deferred') ?? []
  if (
    !isPending &&
    !isError &&
    !failed.length &&
    !deferred.length &&
    !data?.some((item) => item.status === 'migrated')
  ) {
    return null
  }
  const description = isPending
    ? tr('正在检查资料迁移状态…')
    : isError
      ? tr('无法读取迁移状态，请重新打开设置。')
      : failed.some((item) => item.reason === 'migration_alias_failed')
        ? tr('旧路径兼容入口修复失败，新资料仍可使用，请使用新版 hiwd。')
        : failed.some((item) => item.reason === 'migration_serve_failed')
          ? tr('后台服务迁移未完成，已保留原注册，请检查服务状态。')
          : failed.length
            ? tr('资料迁移失败，继续使用原资料。请查看日志或联系支持。')
            : deferred.length
              ? tr(
                  '资料迁移暂缓，继续使用原资料。请在终端和服务结束后重新启动。'
                )
              : tr('资料已迁移，旧资料保留为备份。')
  return <SettingRow title={tr('资料迁移')} desc={description} control={null} />
}

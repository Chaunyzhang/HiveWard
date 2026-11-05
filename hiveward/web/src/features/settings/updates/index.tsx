import { tr } from '@/lib/i18n'
import { SettingsTitle } from '../components/setting-row'
import { UpdateRow } from '../general/update-row'

/** 版本更新：从 GitHub 上 HiveWard 的正式发布版本检查、下载、重启安装 */
export function SettingsUpdates() {
  return (
    <>
      <SettingsTitle>{tr('版本更新')}</SettingsTitle>
      <UpdateRow />
    </>
  )
}

import { setMainUiLanguage } from '../i18n/main-i18n'
import { registerHiveWardMenu } from '../hiveward/hiveward-menu'
import { mainProcessState as state } from './main-process-state'
import { getAppMenuQuitHandlers } from './main-window-actions'
import { logStartupMilestone } from './startup-diagnostics'

export async function initializeMainProcessI18nAndMenu(): Promise<void> {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before menu')
  }
  await setMainUiLanguage(store.getSettings().uiLanguage)
  logStartupMilestone('i18n-ready')
  // HiveWard 是唯一界面：用 HiveWard 自己的菜单，不注册 HiveWard 的（它的菜单项都指向看不到的 HiveWard 界面）
  registerHiveWardMenu(getAppMenuQuitHandlers())
}

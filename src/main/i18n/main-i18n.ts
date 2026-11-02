import { getSystemLanguageDetection } from './system-language'
import type { i18n as I18nInstance } from 'i18next'

import { createOrcaI18n } from '../../shared/orca-i18n-instance'
import { DEFAULT_UI_LOCALE } from '../../shared/ui-locale'
import { UI_LANGUAGE_SYSTEM, type UiLanguage } from '../../shared/ui-language'

let languageGeneration = 0

// English uses caller fallbacks; load only the selected non-English catalog after startup.
// Initializes synchronously, so startup dialogs can translate before settings load.
const orcaI18n = createOrcaI18n({
  loadCatalog: (language) =>
    language === 'zh' ? import('./zh.json').then((mod) => mod.default) : undefined,
  englishResources: {}
})

export const mainI18n: I18nInstance = orcaI18n.i18n
export const translateMain = orcaI18n.translate
export const setMainPluginLanguagePacks = orcaI18n.setPluginLanguagePacks

export function getMainSystemLocale(): string {
  return getSystemLanguageDetection()?.locale ?? DEFAULT_UI_LOCALE
}

export async function setMainUiLanguage(language: UiLanguage): Promise<string> {
  const request = ++languageGeneration
  void language
  const locale = 'zh'
  if (mainI18n.language !== locale) {
    await mainI18n.loadLanguages(locale)
    if (request !== languageGeneration) {
      return mainI18n.language
    }
    await mainI18n.changeLanguage(locale)
  }
  return locale
}

/** Startup failures can show dialogs before settings load; use the system language until then. */
export async function prepareEarlyMainUiLanguage(): Promise<void> {
  if (languageGeneration > 0) {
    return
  }
  try {
    await setMainUiLanguage(UI_LANGUAGE_SYSTEM)
  } catch (error) {
    console.warn('[i18n] Could not localize early startup dialogs:', error)
  }
}

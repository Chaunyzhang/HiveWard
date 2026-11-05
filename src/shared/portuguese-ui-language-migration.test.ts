import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { migratePortugueseUiLanguageOnLoad } from './portuguese-ui-language-migration'
import { normalizeUiLanguage } from './ui-language'

const plugin = 'plugin:stablyai.hiveward-portuguese/pt-BR'

describe('Portuguese UI language load migration', () => {
  it.each([undefined, false, null, 'true', 1, {}])(
    'converts only the exact legacy preference with marker %j',
    (marker) => {
      const stored = JSON.parse(
        JSON.stringify({ uiLanguage: plugin, uiLanguagePortugueseMigrationApplied: marker })
      )
      const migrated = migratePortugueseUiLanguageOnLoad(stored)
      expect(migrated).toEqual({ uiLanguage: 'pt', uiLanguagePortugueseMigrationApplied: true })
      expect(migratePortugueseUiLanguageOnLoad(migrated)).toEqual(migrated)
    }
  )

  it.each([
    'system',
    'en',
    'zh',
    'ko',
    'ja',
    'es',
    'fr',
    'pt',
    'plugin:other.hiveward-portuguese/pt-BR',
    'plugin:stablyai.other/pt-BR',
    'plugin:stablyai.hiveward-portuguese/pt',
    'plugin:stablyai.hiveward-portuguese/pt-br',
    'Plugin:stablyai.hiveward-portuguese/pt-BR',
    'plugin:Stablyai.hiveward-portuguese/pt-BR',
    undefined,
    null,
    42,
    'invalid'
  ])('normalizes without aliasing %j', (uiLanguage) => {
    expect(migratePortugueseUiLanguageOnLoad(JSON.parse(JSON.stringify({ uiLanguage })))).toEqual({
      uiLanguage: normalizeUiLanguage(uiLanguage),
      uiLanguagePortugueseMigrationApplied: true
    })
  })

  it('preserves explicit plugin selection in stamped and fresh stores', () => {
    expect(normalizeUiLanguage(plugin)).toBe(plugin)
    expect(
      migratePortugueseUiLanguageOnLoad({
        ...getDefaultSettings('~'),
        uiLanguage: plugin
      })
    ).toEqual({ uiLanguage: plugin, uiLanguagePortugueseMigrationApplied: true })
    expect(migratePortugueseUiLanguageOnLoad(undefined)).toEqual({
      uiLanguage: 'system',
      uiLanguagePortugueseMigrationApplied: true
    })
  })
})

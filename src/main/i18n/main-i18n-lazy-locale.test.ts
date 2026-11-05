import { expect, it } from 'vitest'
import { setMainUiLanguage, translateMain } from './main-i18n'
it('loads the native Chinese catalog without a renderer', async () => {
  expect(await setMainUiLanguage('system')).toBe('zh')
  expect(translateMain('menu.file', 'File')).toBe('文件')
})

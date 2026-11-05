import { expect, test } from './helpers/hiveward-app'
import type { Page } from '@stablyai/playwright-test'

type MeterFixture = {
  level: number
  isSpeaking: boolean
  isClipping: boolean
}

async function setDictationVisualState(
  page: Page,
  state: 'listening' | 'stopping',
  meter: MeterFixture,
  partialTranscript = ''
): Promise<void> {
  await page.evaluate(
    ({ dictationState, transcript }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Expected the E2E store to be exposed')
      }
      store.setState({
        dictationState,
        partialTranscript: transcript
      })
    },
    { dictationState: state, transcript: partialTranscript }
  )
  await page.waitForFunction(() => Boolean(window.__dictationMeterE2E))
  await page.evaluate((dictationMeter) => {
    window.__dictationMeterE2E?.publish(dictationMeter)
  }, meter)
}

async function pauseForRecordedProof(page: Page): Promise<void> {
  if (process.env.HIVEWARD_E2E_RECORD_VIDEO === '1') {
    await page.waitForTimeout(700)
  }
}

test('dictation grapes react across the visible recording lifecycle', async ({ hivewardPage }) => {
  const quiet = { level: 0, isSpeaking: false, isClipping: false }
  await setDictationVisualState(hivewardPage, 'listening', quiet)

  const indicator = hivewardPage.getByTestId('dictation-indicator')
  const status = indicator.getByRole('status')
  await expect(indicator).toBeVisible()
  await expect(status).toHaveText('Listening')
  await expect(indicator.getByTestId('dictation-grapes').locator('span')).toHaveCount(9)
  await expect(indicator.getByRole('button', { name: 'Stop dictation' })).toBeVisible()
  await hivewardPage.emulateMedia({ reducedMotion: 'reduce' })
  await expect(indicator.getByTestId('dictation-grapes').locator('span').first()).toHaveCSS(
    'transition-property',
    'none'
  )
  await hivewardPage.emulateMedia({ reducedMotion: 'no-preference' })
  await pauseForRecordedProof(hivewardPage)

  const speaking = {
    level: 0.76,
    isSpeaking: true,
    isClipping: false
  }
  await setDictationVisualState(hivewardPage, 'listening', speaking)
  await expect(indicator.getByText('Speaking')).toBeVisible()
  await expect(status).toHaveText('Listening')
  await pauseForRecordedProof(hivewardPage)

  const clipping = { ...speaking, level: 1, isClipping: true }
  await setDictationVisualState(hivewardPage, 'listening', clipping)
  await expect(status).toHaveText('Too loud')
  await expect(indicator).toHaveClass(/text-destructive/)
  await pauseForRecordedProof(hivewardPage)

  await setDictationVisualState(
    hivewardPage,
    'listening',
    speaking,
    'The visualizer follows every word without covering the workspace.'
  )
  await expect(
    hivewardPage.getByText('The visualizer follows every word without covering the workspace.')
  ).toBeVisible()
  await expect(status).toHaveText('Listening')
  await pauseForRecordedProof(hivewardPage)

  await setDictationVisualState(hivewardPage, 'stopping', quiet)
  await expect(status).toHaveText('Processing…')
  await expect(indicator.getByRole('button', { name: 'Stop dictation' })).toHaveCount(0)
  await pauseForRecordedProof(hivewardPage)
})

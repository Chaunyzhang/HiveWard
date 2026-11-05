import type { Page } from '@stablyai/playwright-test'

export async function installRendererTitleLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __hivewardE2eTitleLog?: string[]
      __hivewardE2eTitleUnsubscribe?: () => void
    }
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    w.__hivewardE2eTitleUnsubscribe?.()
    w.__hivewardE2eTitleLog = []

    const recordTitles = (): void => {
      const state = store.getState()
      const paneTitles = Object.values(state.runtimePaneTitlesByTabId ?? {}).flatMap((byPane) =>
        Object.values(byPane ?? {})
      )
      const tabTitles = Object.values(state.tabsByWorktree ?? {})
        .flat()
        .map((tab) => tab.title)

      for (const title of [...paneTitles, ...tabTitles]) {
        if (typeof title === 'string') {
          w.__hivewardE2eTitleLog!.push(title)
        }
      }
    }

    // Record transient OSC titles before shell prompts overwrite them.
    recordTitles()
    w.__hivewardE2eTitleUnsubscribe = store.subscribe(recordTitles)
  })
}

export async function getRendererTitleLog(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __hivewardE2eTitleLog?: string[] }
    return w.__hivewardE2eTitleLog ?? []
  })
}

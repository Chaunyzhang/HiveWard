import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/hiveward-app'
import { openChecks } from './helpers/source-control-ai-generation'
import { seedPRCommentsSidebarFixture } from './helpers/pr-comments-sidebar-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function visibleTextX(card: Locator, text: string): Promise<number> {
  const textBox = await card.evaluate((element, targetText) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const value = node.textContent ?? ''
      const index = value.indexOf(targetText)
      if (index === -1) {
        continue
      }
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + targetText.length)
      const rect = range.getBoundingClientRect()
      return { x: rect.x }
    }
    return null
  }, text)
  if (!textBox) {
    throw new Error(`visible text not found: ${text}`)
  }
  return textBox.x
}

async function expectOpenTextNotShiftedLeft(
  openCard: Locator,
  conversationCard: Locator,
  openText: string,
  conversationText: string
): Promise<void> {
  const delta =
    (await visibleTextX(openCard, openText)) -
    (await visibleTextX(conversationCard, conversationText))
  // Why: the open rail is a real border, but focused row actions must not scroll content left.
  expect(delta).toBeGreaterThanOrEqual(0)
  expect(delta).toBeLessThanOrEqual(3)
}

test.describe('PR comments sidebar cards view', () => {
  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
  })

  test('groups open, conversation, and resolved comments in cards layout', async ({ hivewardPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(hivewardPage)
    await openChecks(hivewardPage, worktreeId)

    const commentsSection = hivewardPage.getByText('Comments', { exact: true })
    await expect(commentsSection).toBeVisible({ timeout: 10_000 })

    await expect(hivewardPage.getByText('Needs review · 1')).toBeVisible()
    await expect(hivewardPage.getByText('Please update this handler before merge.')).toBeVisible()
    await expect(hivewardPage.getByText('coderabbitai')).toBeVisible()
    await expect(hivewardPage.getByText('LGTM on the overall approach.')).toBeVisible()

    const openThreadCard = hivewardPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    const conversationCard = hivewardPage.getByTestId('pr-comment-group').filter({
      hasText: 'LGTM on the overall approach.'
    })
    await expect(openThreadCard).toBeVisible()
    await expect(conversationCard).toBeVisible()
    await expect(openThreadCard).toHaveClass(/shadow-xs/)
    await expectOpenTextNotShiftedLeft(
      openThreadCard,
      conversationCard,
      'Please update this handler before merge.',
      'LGTM on the overall approach.'
    )
    await expectOpenTextNotShiftedLeft(openThreadCard, conversationCard, 'coderabbitai', 'bob')

    const resolvedTrigger = hivewardPage.getByRole('button', { name: 'Resolved · 1' })
    await expect(resolvedTrigger).toBeVisible()
    await expect(hivewardPage.getByText('Already fixed upstream.')).toBeHidden()

    await resolvedTrigger.click()
    await expect(hivewardPage.getByText('Already fixed upstream.')).toBeVisible()
    await expect(hivewardPage.getByText('Resolved', { exact: true })).toBeVisible()
    await expect(
      hivewardPage
        .getByTestId('pr-comment-group')
        .filter({ hasText: 'Already fixed upstream.' })
        .getByRole('button', { name: 'Unresolve', exact: true })
    ).toBeVisible()

    await expect(hivewardPage.getByRole('button', { name: /^Add$/ })).toHaveCount(0)
  })

  test('can switch from grouped to chronological timeline order', async ({ hivewardPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(hivewardPage)
    await openChecks(hivewardPage, worktreeId)

    await expect(hivewardPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })
    await hivewardPage.getByRole('button', { name: 'Comment display options' }).click()
    await hivewardPage.getByRole('menuitemradio', { name: 'Timeline' }).click()

    await expect(hivewardPage.getByText('Needs review · 1')).toHaveCount(0)
    await expect(hivewardPage.getByText('Already fixed upstream.')).toBeVisible()

    const comments = [
      hivewardPage.getByText('Already fixed upstream.'),
      hivewardPage.getByText('Please update this handler before merge.'),
      hivewardPage.getByText('LGTM on the overall approach.')
    ]
    const positions = await Promise.all(
      comments.map(async (comment) => {
        const box = await comment.boundingBox()
        if (!box) {
          throw new Error(`Comment not visible: ${await comment.textContent()}`)
        }
        return box.y
      })
    )

    expect(positions[0]).toBeLessThan(positions[1])
    expect(positions[1]).toBeLessThan(positions[2])
  })

  test('adds reactions to conversation and review-thread comments', async ({
    hivewardPage
  }, testInfo) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(hivewardPage)
    await openChecks(hivewardPage, worktreeId)
    await expect(hivewardPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })

    const reviewThreadCard = hivewardPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    const threadReactionButton = reviewThreadCard.getByRole('button', { name: 'Add reaction' })
    await hivewardPage.screenshot({ path: testInfo.outputPath('reaction-before.png') })
    await threadReactionButton.click()
    await expect(hivewardPage.getByRole('group', { name: 'Add reaction' })).toBeFocused()
    await expect(hivewardPage.getByRole('button', { name: 'Add rocket reaction' })).toBeVisible()
    await hivewardPage.screenshot({
      path: testInfo.outputPath('reaction-picker.png'),
      animations: 'disabled'
    })
    await hivewardPage.getByRole('button', { name: 'Add rocket reaction' }).click()
    await expect(hivewardPage.getByRole('group', { name: 'Add reaction' })).toBeHidden()
    const selectedRocket = reviewThreadCard.getByRole('button', { name: '1 rocket reaction' })
    await expect(selectedRocket).toHaveAttribute('aria-pressed', 'true')
    await selectedRocket.focus()
    await expect(selectedRocket).toBeFocused()
    await hivewardPage.screenshot({
      path: testInfo.outputPath('reaction-after.png'),
      animations: 'disabled'
    })
    await selectedRocket.press('Enter')
    await expect(selectedRocket).toHaveCount(0)
    await expect(threadReactionButton).toBeFocused()

    const conversationCard = hivewardPage.getByTestId('pr-comment-group').filter({
      hasText: 'LGTM on the overall approach.'
    })
    const conversationReactionButton = conversationCard.getByRole('button', {
      name: 'Add reaction'
    })
    await conversationReactionButton.click()
    const conversationPicker = hivewardPage.getByRole('group', { name: 'Add reaction' }).last()
    const heartReactionButton = conversationPicker.getByRole('button', {
      name: 'Add heart reaction'
    })
    await expect(heartReactionButton).toBeVisible()
    await heartReactionButton.evaluate((element) => (element as HTMLElement).click())
    await expect(
      conversationCard.getByRole('button', { name: '1 heart reaction' })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(hivewardPage.getByRole('button', { name: 'Add rocket reaction' })).toHaveCount(0)
  })

  test('keeps reaction focus while a remote mutation fails', async ({ hivewardPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(hivewardPage)
    await openChecks(hivewardPage, worktreeId)
    await expect(hivewardPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })
    await hivewardPage.evaluate(() => {
      window.__store?.setState({
        setPRCommentReaction: async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 300))
          return false
        }
      })
    })

    const reviewThreadCard = hivewardPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    const addReaction = reviewThreadCard.getByRole('button', { name: 'Add reaction' })
    await addReaction.focus()
    await addReaction.press('Enter')
    const picker = hivewardPage.getByRole('group', { name: 'Add reaction' })
    await expect(picker).toBeFocused()
    const rocket = picker.getByRole('button', { name: /rocket reaction/ })
    await rocket.focus()
    await rocket.press('Enter')
    await expect(rocket).toBeFocused()
    await expect(rocket).toHaveAttribute('aria-disabled', 'true')
    await rocket.press('Enter')
    await expect(picker).toBeVisible()
    await expect(rocket).toHaveAttribute('aria-disabled', 'false')
    await expect(rocket).toBeFocused()
    await expect(rocket).toHaveAccessibleName('Add rocket reaction')

    await hivewardPage.evaluate(() => {
      window.__store?.setState({ setPRCommentReaction: async () => true })
    })
    await rocket.press('Enter')
    const selectedRocket = reviewThreadCard.getByRole('button', { name: '1 rocket reaction' })
    await expect(selectedRocket).toHaveAttribute('aria-pressed', 'true')
    await hivewardPage.evaluate(() => {
      window.__store?.setState({
        setPRCommentReaction: async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 300))
          return false
        }
      })
    })
    await selectedRocket.focus()
    await selectedRocket.press('Enter')
    await expect(addReaction).toBeFocused()
    await expect(addReaction).toHaveAttribute('aria-disabled', 'true')
    await expect(selectedRocket).toHaveCount(0)
    await expect(selectedRocket).toHaveCount(1)
    await expect(addReaction).toHaveAttribute('aria-disabled', 'false')
    await expect(addReaction).toBeFocused()
  })

  test('queues an open thread for the agent from the visible row action and menu fallback', async ({
    hivewardPage
  }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(hivewardPage)
    await openChecks(hivewardPage, worktreeId)

    await expect(hivewardPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })

    const openThreadCard = hivewardPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    await openThreadCard.hover()
    const visibleQueueButton = openThreadCard.getByRole('button', { name: 'Queue for agent' })
    await expect(visibleQueueButton).toBeVisible()
    await visibleQueueButton.click()
    await expect(visibleQueueButton).toBeHidden()
    await expect(
      hivewardPage.getByRole('button', { name: 'Send 1 queued comments to AI' })
    ).toBeVisible()
    await expect(hivewardPage.getByText('Queued', { exact: true })).toBeVisible()

    await hivewardPage.getByRole('button', { name: 'Clear queued comments' }).click()
    await expect(
      hivewardPage.getByRole('button', { name: 'Send 1 queued comments to AI' })
    ).toBeHidden()
    await openThreadCard.hover()
    await expect(visibleQueueButton).toBeVisible()

    const actionsMenu = openThreadCard.getByRole('button', { name: 'More comment actions' })
    await actionsMenu.evaluate((element) => (element as HTMLElement).focus())
    await actionsMenu.press('Enter')
    const queueMenuItem = hivewardPage.getByRole('menuitem', { name: 'Queue for agent' })
    await queueMenuItem.click({ force: true })
    await expect(queueMenuItem).toBeHidden()

    await expect(
      hivewardPage.getByRole('button', { name: 'Send 1 queued comments to AI' })
    ).toBeVisible()
    await expect(hivewardPage.getByText('Queued', { exact: true })).toBeVisible()

    const queuedCard = hivewardPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    const queuedCardBox = await queuedCard.boundingBox()
    const checkboxBox = await hivewardPage
      .getByRole('checkbox', { name: 'Select comment' })
      .first()
      .boundingBox()
    if (!queuedCardBox || !checkboxBox) {
      throw new Error('queued card and checkbox must be measurable')
    }
    expect(checkboxBox.x - queuedCardBox.x).toBeGreaterThanOrEqual(8)
  })

  test('keeps open card content aligned while the row menu is open', async ({ hivewardPage }) => {
    const { worktreeId } = await seedPRCommentsSidebarFixture(hivewardPage)
    await openChecks(hivewardPage, worktreeId)

    await expect(hivewardPage.getByText('Needs review · 1')).toBeVisible({ timeout: 10_000 })
    const openThreadCard = hivewardPage.getByTestId('pr-comment-group').filter({
      hasText: 'Please update this handler before merge.'
    })
    const conversationCard = hivewardPage.getByTestId('pr-comment-group').filter({
      hasText: 'LGTM on the overall approach.'
    })

    await openThreadCard.hover()
    const actionsMenu = openThreadCard.getByRole('button', { name: 'More comment actions' })
    await actionsMenu.evaluate((element) => (element as HTMLElement).focus())
    await actionsMenu.press('Enter')
    await expect(hivewardPage.getByRole('menuitem', { name: 'Queue for agent' })).toBeVisible()

    await expectOpenTextNotShiftedLeft(
      openThreadCard,
      conversationCard,
      'Please update this handler before merge.',
      'LGTM on the overall approach.'
    )
  })
})

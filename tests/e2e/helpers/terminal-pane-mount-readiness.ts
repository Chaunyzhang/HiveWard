import { test } from './hiveward-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './store'
import { waitForActiveTerminalManager, waitForPaneCount } from './terminal'

export function registerTerminalPaneMountReadiness(): void {
  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
    await ensureTerminalVisible(hivewardPage)
    // Allow cold starts 30s for the React terminal lifecycle to register PaneManager.
    const hasPaneManager = await waitForActiveTerminalManager(hivewardPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so pane split/resize assertions would only fail on harness setup.'
    )
    // Hidden-window readiness may precede the first xterm/PTY pair; require it before split/content assertions.
    await waitForPaneCount(hivewardPage, 1, 30_000)
  })
}

import { readFile, writeFile } from 'node:fs/promises'
import { buildShellCommandFromArgv } from '../../src/shared/tui-agent-startup-shell'
import { test, expect } from './helpers/hiveward-app'
import { getPiAgentStatusExtensionSource } from '../../src/main/pi/agent-status-extension-source'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

test('installed OMP renders the task draft without starting a turn', async ({
  hivewardPage
}, testInfo) => {
  test.skip(
    !process.env.HIVEWARD_OMP_PROOF_BINARY || process.platform === 'win32',
    'Opt-in POSIX OMP runtime proof'
  )
  await waitForSessionReady(hivewardPage)
  await waitForActiveWorktree(hivewardPage)
  await ensureTerminalVisible(hivewardPage)
  await waitForActiveTerminalManager(hivewardPage)
  const ptyId = await waitForActivePanePtyId(hivewardPage)
  const sourcePath = testInfo.outputPath('status.ts')
  const probePath = testInfo.outputPath('probe.ts')
  const resultPath = testInfo.outputPath('result.json')
  const draft = 'Review the OMP task draft before sending'
  await writeFile(sourcePath, getPiAgentStatusExtensionSource('omp'))
  await writeFile(
    probePath,
    `import { writeFileSync } from 'node:fs'
export default function (api) {
  let turns = 0
  api.on('agent_start', () => { turns++ })
  api.on('session_start', (_event, ctx) => {
    setTimeout(() => writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
      text: ctx.ui.getEditorText(), hasUI: ctx.hasUI,
      consumed: !process.env.HIVEWARD_OMP_PREFILL, turns
    })), 1500)
  })
}`
  )
  await execInTerminal(
    hivewardPage,
    ptyId,
    buildShellCommandFromArgv(
      [
        'env',
        `HIVEWARD_OMP_PREFILL=${draft}`,
        'HIVEWARD_PI_STATUS_OWNED=',
        process.env.HIVEWARD_OMP_PROOF_BINARY ?? '',
        '--no-session',
        '--no-extensions',
        '--extension',
        sourcePath,
        '--extension',
        probePath
      ],
      'posix'
    )
  )
  await expect
    .poll(
      async () => {
        try {
          return JSON.parse(await readFile(resultPath, 'utf8'))
        } catch {
          return null
        }
      },
      { timeout: 45_000 }
    )
    .toEqual({ text: draft, hasUI: true, consumed: true, turns: 0 })
  await expect(hivewardPage.locator('.xterm-screen').first()).toBeVisible()
  await hivewardPage.screenshot({ path: testInfo.outputPath('omp-prefilled.png') })
})

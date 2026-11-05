// STA-11039: save a fake MiniMax key on the scoped server, then require its own usage poller’s error meter.
// Run electron-headless with HIVEWARD_E2E_USAGE_CREDENTIALS=1 HIVEWARD_BACKGROUND_LAUNCH=1; add HIVEWARD_E2E_HIVEWARDD_SERVE=1 after pnpm build:hivewardd for Node hosting.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { resolveBundledHivewarddRuntime } from '../../src/main/hivewardd/hivewardd-bundled-runtime'
import { expect, test } from './helpers/hiveward-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { cliServeProfile, spawnUntilReady } from './helpers/hiveward-serve-cli-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'

const RUN = process.env.HIVEWARD_E2E_USAGE_CREDENTIALS === '1'
const RUN_HIVEWARDD = RUN && process.env.HIVEWARD_E2E_HIVEWARDD_SERVE === '1'
const HOST_NAME = 'Build box'
const FAKE_KEY = 'sk-e2e-fake-minimax-key-not-real'
const KEY_FILE = path.join('.hiveward', 'minimax-api-key.enc')

test.skip(
  !RUN,
  'Set HIVEWARD_E2E_USAGE_CREDENTIALS=1 to run; the server polls MiniMax with a fake key.'
)

function homeOf(userDataDir: string): string {
  return path.join(userDataDir, 'home')
}

async function findWorktreeId(page: Page, repoPath: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (expected) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((entry) => entry.path === expected) ?? false,
          repoPath
        ),
      { timeout: 60_000 }
    )
    .toBe(true)
  return page.evaluate(
    (expected) =>
      window.__store
        ?.getState()
        .allWorktrees()
        .find((entry) => entry.path === expected)?.id ?? '',
    repoPath
  )
}

async function proveKeySavedOnServer(options: {
  client: PairedElectronClient
  serverUserDataDir: string
  repoPath: string
  label: string
  testInfo: TestInfo
}): Promise<void> {
  const { client, serverUserDataDir, repoPath, label, testInfo } = options
  const { page } = client
  const shot = async (name: string, target: Page | ReturnType<Page['locator']>): Promise<void> => {
    const file = testInfo.outputPath(`${label}-${name}.png`)
    await target.screenshot({ path: file })
    await testInfo.attach(`${label}-${name}`, { path: file, contentType: 'image/png' })
  }

  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsPage()
    state.openSettingsTarget({ pane: 'accounts', repoId: null })
  })
  await page.getByRole('combobox', { name: 'Host' }).click()
  await page.getByRole('option', { name: HOST_NAME }).click()
  const section = page.locator('#accounts-minimax')
  await section.scrollIntoViewIfNeeded()
  await expect(section.getByText('Credentials not set')).toBeVisible({ timeout: 30_000 })
  const apiKeyInput = section.locator('#minimax-api-key')
  await apiKeyInput.fill(FAKE_KEY)
  await apiKeyInput.locator('xpath=..').getByRole('button', { name: 'Save' }).click()
  await expect(section.getByText(`Stored on ${HOST_NAME}`)).toBeVisible({ timeout: 30_000 })
  await shot('1-settings-host-key-saved', section)
  await page.getByRole('combobox', { name: 'Host' }).scrollIntoViewIfNeeded()
  await shot('1b-settings-host-picker', page)

  const serverKey = path.join(homeOf(serverUserDataDir), KEY_FILE)
  const clientKey = path.join(homeOf(client.userDataDir), KEY_FILE)
  const listing = (home: string): string[] =>
    existsSync(path.join(home, '.hiveward')) ? readdirSync(path.join(home, '.hiveward')).sort() : []
  const report = [
    `server key file exists: ${existsSync(serverKey)}`,
    `client key file exists: ${existsSync(clientKey)}`,
    `server ~/.hiveward: ${listing(homeOf(serverUserDataDir)).join(', ')}`,
    `client ~/.hiveward: ${listing(homeOf(client.userDataDir)).join(', ')}`
  ].join('\n')
  writeFileSync(testInfo.outputPath(`${label}-2-key-files.txt`), `${report}\n`)
  await testInfo.attach(`${label}-2-key-files`, { body: report, contentType: 'text/plain' })
  expect(existsSync(serverKey), report).toBe(true)
  expect(existsSync(clientKey), report).toBe(false)

  // The server's workspace takes focus, so the status bar reads the server's usage.
  const worktreeId = await findWorktreeId(page, repoPath)
  await page.evaluate(
    ({ environmentId, id }) => {
      const state = window.__store!.getState()
      state.closeSettingsPage()
      state.setActiveWorktree(id, `runtime:${environmentId}`)
    },
    { environmentId: client.environmentId, id: worktreeId }
  )
  const meter = page.locator('[data-usage-chip="minimax"]')
  await expect(meter).toBeVisible({ timeout: 90_000 })
  // The fake key's fetch settles into MiniMax's error; until then the chip shows a pending pulse.
  await expect.poll(() => meter.innerText(), { timeout: 90_000 }).not.toContain('···')
  await meter.hover()
  await page.waitForTimeout(1_000)
  await shot('3-status-bar-server-minimax', page)
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  {
    const file = testInfo.outputPath(`${label}-3b-status-bar-strip.png`)
    await page.screenshot({
      path: file,
      clip: { x: 0, y: viewport.height - 60, width: Math.min(700, viewport.width), height: 60 }
    })
    await testInfo.attach(`${label}-3b-status-bar-strip`, { path: file, contentType: 'image/png' })
  }
  await testInfo.attach(`${label}-3-meter-text`, {
    body: await meter.innerText(),
    contentType: 'text/plain'
  })
}

test('a paired desktop saves a MiniMax key on its Electron serve host', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, HOST_NAME)
    await proveKeySavedOnServer({
      client,
      serverUserDataDir: host.userDataDir,
      repoPath: testRepoPath,
      label: 'electron-serve',
      testInfo
    })
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})

test('a paired desktop saves a MiniMax key on its headless hivewardd host', async ({
  testRepoPath
}, testInfo) => {
  test.skip(!RUN_HIVEWARDD, 'Set HIVEWARD_E2E_HIVEWARDD_SERVE=1 after pnpm build:hivewardd.')
  test.setTimeout(300_000)
  const slotDir = path.resolve('out/hivewardd')
  const program = resolveBundledHivewarddRuntime(slotDir)
  if (!program) {
    throw new Error('pnpm build:hivewardd must produce a packaged slot in out/hivewardd')
  }
  // Short root: macOS caps a unix socket path at 104 bytes, and the daemon's lives in userData.
  const scratch = mkdtempSync(
    path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'hiveward-uc-')
  )
  const profile = cliServeProfile(scratch)
  const serve = await spawnUntilReady<{ pairing?: { url?: string } }>({
    label: 'hivewardd serve',
    program,
    args: [
      path.join(slotDir, 'hivewardd.js'),
      '--bind',
      '127.0.0.1',
      '--port',
      '0',
      '--pairing-address',
      '127.0.0.1',
      '--json'
    ],
    env: { ...profile.env, HIVEWARD_USER_DATA: profile.userDataDir },
    timeoutMs: 120_000,
    parseReady: (stdout) => {
      const newline = stdout.indexOf('\n')
      return newline === -1 ? null : JSON.parse(stdout.slice(0, newline))
    }
  })
  let client: PairedElectronClient | null = null
  try {
    const pairingUrl = serve.ready.pairing?.url
    expect(pairingUrl, serve.stderr()).toEqual(expect.any(String))
    await new RuntimeClient(profile.userDataDir, 15_000).call('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    const offer: RuntimeDesktopPairingOffer = { pairingUrl: pairingUrl! }
    client = await launchPairedElectronClient(offer, testInfo, HOST_NAME)
    await proveKeySavedOnServer({
      client,
      serverUserDataDir: profile.userDataDir,
      repoPath: testRepoPath,
      label: 'hivewardd',
      testInfo
    })
  } finally {
    await client?.dispose()
    await serve.stop()
    rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
  }
})

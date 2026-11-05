import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
import { getPiAgentStatusExtensionSource } from '../../src/main/pi/agent-status-extension-source'
import { test, expect } from './helpers/hiveward-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

test('OMP completion retry clears the rendered working indicator', async ({
  hivewardPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(hivewardPage)
  await waitForActiveWorktree(hivewardPage)
  await ensureTerminalVisible(hivewardPage)
  await waitForActiveTerminalManager(hivewardPage, 30_000)
  const endpoint = await readHookEndpoint(electronApp)
  const { paneKey, worktreeId } = await waitForActivePaneHookDescriptor(hivewardPage)
  let completions = 0
  const proxy = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) {
      body += chunk
    }
    if (JSON.parse(body).payload.hook_event_name === 'agent_end' && ++completions === 1) {
      response.writeHead(503).end()
      return
    }
    const forwarded = await fetch(`http://127.0.0.1:${endpoint.port}/hook/omp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HiveWard-Agent-Hook-Token': endpoint.token },
      body
    })
    response.writeHead(forwarded.status).end()
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  try {
    const address = proxy.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP listener')
    }
    type Handler = (event: Record<string, unknown>, ctx: { isIdle: () => boolean }) => void
    const handlers = new Map<string, Handler>()
    const module: {
      exports: { default?: (api: { on: (name: string, fn: Handler) => void }) => void }
    } = { exports: {} }
    const { code } = await transform(getPiAgentStatusExtensionSource('omp'), {
      loader: 'ts',
      format: 'cjs'
    })
    runInNewContext(code, {
      module,
      exports: module.exports,
      require: createRequire(join(process.cwd(), 'package.json')),
      process: {
        pid: process.pid,
        argv: [],
        title: 'omp',
        env: {
          HIVEWARD_PANE_KEY: paneKey,
          HIVEWARD_TAB_ID: paneKey.split(':')[0],
          HIVEWARD_WORKTREE_ID: worktreeId,
          HIVEWARD_AGENT_HOOK_PORT: String(address.port),
          HIVEWARD_AGENT_HOOK_TOKEN: endpoint.token,
          HIVEWARD_AGENT_HOOK_ENV: endpoint.env,
          HIVEWARD_AGENT_HOOK_VERSION: endpoint.version
        }
      },
      fetch,
      AbortController,
      Buffer,
      console,
      setTimeout,
      clearTimeout
    })
    expect(module.exports.default).toBeDefined()
    module.exports.default?.({ on: (name, fn) => handlers.set(name, fn) })
    const working = hivewardPage.locator('[aria-label="Working"]')
    handlers.get('before_agent_start')?.(
      { prompt: 'OMP completion recovery' },
      { isIdle: () => false }
    )
    handlers.get('agent_start')?.({}, { isIdle: () => false })
    await expect(working.first()).toBeVisible()
    await hivewardPage.screenshot({ path: testInfo.outputPath('before-working.png') })
    handlers.get('agent_end')?.({ willContinue: false }, { isIdle: () => false })
    await expect.poll(() => completions).toBe(2)
    await expect(working).toHaveCount(0)
    await expect
      .poll(() =>
        hivewardPage.evaluate(
          (key) => window.__store?.getState().agentStatusByPaneKey[key]?.state,
          paneKey
        )
      )
      .toBe('done')
    await hivewardPage.screenshot({ path: testInfo.outputPath('after-completed.png') })
  } finally {
    proxy.closeAllConnections()
    proxy.close()
  }
})

import { readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createExitRegionGuard } from '../agent-exit-region.mjs'
import { startBridge } from '../orca-bridge.mjs'

const dir = process.env.OPC_DATA_DIR
if (!dir) {
  throw new Error('Fixture requires isolated OPC_DATA_DIR')
}
const configuration = () => {
  try {
    return JSON.parse(readFileSync(join(dir, 'test-exit-region.json'), 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { country: 'US', revision: 1 }
    }
    throw e
  }
}
const guard = createExitRegionGuard({
  capture: async () => ({
    env: { FIXTURE_REVISION: String(configuration().revision) },
    shell: 'fixture-shell'
  }),
  fingerprint: (context) => context.env.FIXTURE_REVISION,
  probe: async () => ({
    country: configuration().country,
    method: 'login-shell-route-trace',
    source: 'https://www.cloudflare.com/cdn-cgi/trace',
    reason: 'probe_failed'
  }),
  onWarning: (warning) =>
    appendFileSync(join(dir, 'test-warnings.jsonl'), `${JSON.stringify(warning)}\n`)
})
const server = await startBridge({ regionGuard: guard })
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0))
    server.closeAllConnections()
  })
}

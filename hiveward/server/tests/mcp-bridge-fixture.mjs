import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExitRegionGuard } from '../agent-exit-region.mjs'
import { startBridge } from '../hiveward-bridge.mjs'

const directory = process.env.HIVEWARD_DATA_DIR
if (!directory?.startsWith(join(tmpdir(), 'hiveward-mcp-acceptance-'))) {
  throw new Error('MCP fixture requires an isolated temporary HIVEWARD_DATA_DIR')
}
const regionGuard = createExitRegionGuard({
  capture: async () => ({ env: { MCP_FIXTURE: '1' }, shell: 'fixture-shell' }),
  fingerprint: () => 'mcp-fixture',
  probe: async () => ({
    country: 'US',
    method: 'login-shell-route-trace',
    source: null,
    reason: null
  })
})
const server = await startBridge({ regionGuard })
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0))
    server.closeAllConnections()
  })
}

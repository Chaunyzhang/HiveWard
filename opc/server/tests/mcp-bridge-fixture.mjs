import { createExitRegionGuard } from '../agent-exit-region.mjs'
import { startBridge } from '../orca-bridge.mjs'

const directory = process.env.OPC_DATA_DIR
if (!directory?.startsWith('/tmp/opc-mcp-acceptance-')) {
  throw new Error('MCP fixture requires an isolated /tmp OPC_DATA_DIR')
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

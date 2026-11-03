import { writeFileSync } from 'node:fs'
import readline from 'node:readline'

if (process.env.MCP_FIXTURE_PID_FILE) {
  writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid))
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  if (!line) {
    return
  }
  const request = JSON.parse(line)
  if (request.id === undefined) {
    return
  }
  let result
  if (request.method === 'initialize') {
    result = {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'opc-test-echo', version: '1' }
    }
  } else if (request.method === 'tools/list') {
    result = {
      tools: [{ name: 'echo', description: 'Echo test input', inputSchema: { type: 'object' } }]
    }
  } else if (request.method === 'tools/call' && request.params?.name === 'echo') {
    result = { content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }] }
  } else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Not found' } })}\n`
    )
    return
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
})

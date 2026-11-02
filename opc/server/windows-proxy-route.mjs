import { win32 } from 'node:path'
import { runProcess } from '@orca/process-host'

// CLI libraries disagree on Windows system proxies; refuse an ambiguous route.
export async function windowsProxyRoute(env, run = runProcess) {
  const system = win32.join(env.SystemRoot || 'C:\\Windows', 'System32')
  const query = async (program, args) => {
    const result = await run({
      program: win32.join(system, program),
      args,
      env,
      timeoutMs: 4000,
      maxOutputBytes: 32768,
      killOnOutputLimit: true
    })
    if (result.timedOut || result.outputTruncated) {
      throw new Error('proxy_query_failed')
    }
    return result
  }
  try {
    const internet = await query('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    ])
    const connections = await query('reg.exe', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections',
      '/v',
      'DefaultConnectionSettings'
    ])
    const winhttp = await query('reg.exe', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections',
      '/v',
      'WinHttpSettings'
    ])
    if (internet.code !== 0) {
      return 'windows_proxy_unknown'
    }
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x[1-9a-f]/i.test(internet.stdout)
    const pac = /AutoConfigURL\s+REG_SZ\s+\S/i.test(internet.stdout)
    const binary = /WinHttpSettings\s+REG_BINARY\s+([a-f0-9]+)/i.exec(winhttp.stdout)?.[1]
    // WinHTTP connection settings flags are a DWORD at offset 8; 1 means direct.
    const connectionBytes = /DefaultConnectionSettings\s+REG_BINARY\s+([a-f0-9]+)/i.exec(
      connections.stdout
    )?.[1]
    const connectionFlags =
      connectionBytes && connectionBytes.length >= 24
        ? Buffer.from(connectionBytes, 'hex').readUInt32LE(8)
        : null
    if (connectionFlags !== null && connectionFlags & 14) {
      return 'windows_system_proxy_ambiguous'
    }
    if (connections.code !== 0 || connectionFlags === null) {
      return 'windows_proxy_unknown'
    }
    const flags = binary && binary.length >= 24 ? Buffer.from(binary, 'hex').readUInt32LE(8) : null
    if (enabled || pac || (flags !== null && flags !== 1)) {
      return 'windows_system_proxy_ambiguous'
    }
    if (winhttp.code !== 0 || flags === null) {
      return 'windows_proxy_unknown'
    }
    return null
  } catch {
    return 'windows_proxy_unknown'
  }
}

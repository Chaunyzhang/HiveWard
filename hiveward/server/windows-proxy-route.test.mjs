import test from 'node:test'
import assert from 'node:assert/strict'
import { windowsProxyRoute } from './windows-proxy-route.mjs'

const direct = 'WinHttpSettings REG_BINARY 460000000000000001000000'
function registry(internet, winhttp = direct, code = 0) {
  return async ({ program, args }) => {
    assert.match(program, /System32\\reg.exe$/)
    return {
      code,
      stdout: args.includes('DefaultConnectionSettings')
        ? direct.replace('WinHttpSettings', 'DefaultConnectionSettings')
        : args.includes('/v')
          ? winhttp
          : internet
    }
  }
}
test('Windows route guard rejects static, PAC, WinHTTP proxies and unreadable settings', async () => {
  assert.equal(await windowsProxyRoute({}, registry('ProxyEnable REG_DWORD 0x0')), null)
  assert.equal(
    await windowsProxyRoute({}, registry('ProxyEnable REG_DWORD 0x1')),
    'windows_system_proxy_ambiguous'
  )
  assert.equal(
    await windowsProxyRoute({}, registry('AutoConfigURL REG_SZ http://proxy/pac')),
    'windows_system_proxy_ambiguous'
  )
  assert.equal(
    await windowsProxyRoute({}, registry('', direct.replace('01000000', '03000000'))),
    'windows_system_proxy_ambiguous'
  )
  assert.equal(await windowsProxyRoute({}, registry('', '', 1)), 'windows_proxy_unknown')
})

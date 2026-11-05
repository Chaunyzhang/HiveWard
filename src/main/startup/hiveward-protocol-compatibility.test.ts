import { describe, expect, it, vi } from 'vitest'
import {
  normalizeHiveWardProtocolUrl,
  registerHiveWardProtocolClient
} from './hiveward-protocol-registration'

describe('HiveWard 协议', () => {
  it('只接受 hiveward 链接，不接受其他协议', () => {
    expect(normalizeHiveWardProtocolUrl('hiveward://open/path')).toBe('hiveward://open/path')
    expect(normalizeHiveWardProtocolUrl('other://pair/secret')).toBeNull()
  })

  it('Windows 正式桌面只注册 HiveWard 协议，serve 不接管系统处理器', () => {
    const app = {
      isPackaged: true,
      isDefaultProtocolClient: vi.fn(() => false),
      setAsDefaultProtocolClient: vi.fn((_scheme: string) => true)
    }
    expect(registerHiveWardProtocolClient(app, { platform: 'win32', desktopLaunch: false })).toBe(false)
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
    expect(registerHiveWardProtocolClient(app, { platform: 'win32', desktopLaunch: true })).toBe(true)
    expect(app.setAsDefaultProtocolClient.mock.calls.map((args) => args[0])).toEqual(['hiveward'])
  })
})

import {
  readSessionRecipient,
  refuseUndeliverableSessionRecipient
} from '../rpc/methods/orchestration/messaging/session-recipient'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { resolveOrchestrationSessionCaller } from '../rpc/orchestration-session-caller'
import { createOrchestrationWorkerReleaseHarness } from '../rpc/methods/orchestration/worker/worker-release.test-support'
import { OrchestrationDb } from './db'
import {
  hivewardExternalCaller,
  registerHivewardExternalSession
} from './hiveward-external-sessions'
import {
  formatHiveWardSessionAddress,
  parseHiveWardSessionAddress
} from '../../../shared/hiveward-session-address'

it('外部会话持久隔离：桌面端按会话、老板一个身份，重开数据库不换地址、不占终端', () => {
  const root = mkdtempSync(join(tmpdir(), 'hiveward-session-'))
  const path = join(root, 'orchestration.db')
  let db = new OrchestrationDb(path)
  try {
    const register = (key: string) =>
      registerHivewardExternalSession(db, {
        key,
        dispatcher: { kind: key === 'owner' ? 'owner' : 'claude-desktop', id: key, label: key },
        workspaceId: 'folder',
        path: root
      })
    const desktop = register('desktop:one'),
      other = register('desktop:two'),
      owner = register('owner')
    expect(desktop.sessionId).not.toBe(other.sessionId)
    expect(owner.sessionId).not.toBe(desktop.sessionId)
    const caller = hivewardExternalCaller(db, desktop.sessionId)
    expect(caller).toMatchObject({
      terminalHandle: null,
      paneKey: null,
      address: `hiveward_session_id:${desktop.sessionId}`
    })
    const parsed = parseHiveWardSessionAddress(caller.address)
    expect(parsed).toBe(desktop.sessionId)
    expect(parsed && formatHiveWardSessionAddress(parsed)).toBe(caller.address)
    const recipient = readSessionRecipient(caller.address, null)
    expect(recipient).toMatchObject({ sessionId: desktop.sessionId })
    if (!recipient || 'code' in recipient) {
      throw new Error('会话地址未被识别')
    }
    expect(refuseUndeliverableSessionRecipient(recipient, null, db)).toBeNull()
    expect(parseHiveWardSessionAddress(`other_session_id:${desktop.sessionId}`)).toBeNull()
    expect(parseHiveWardSessionAddress('hiveward_session_id:')).toBeNull()
    db.close()
    db = new OrchestrationDb(path)
    expect(register('desktop:one').sessionId).toBe(desktop.sessionId)
    expect(register('owner').sessionId).toBe(owner.sessionId)
    expect(() => hivewardExternalCaller(db, 'unregistered-session')).toThrow('尚未登记')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('外部会话 RPC 不接受另一身份或跨主机声明', async () => {
  const h = createOrchestrationWorkerReleaseHarness()
  h.setup()
  try {
    const row = registerHivewardExternalSession(h.db, {
      key: 'owner',
      dispatcher: { kind: 'owner', id: 'hiveward-owner', label: '老板' },
      workspaceId: 'folder',
      path: '/tmp'
    })
    const request = {
      id: 'request',
      authToken: 'fixture',
      method: 'orchestration.check',
      hivewardSessionId: row.sessionId,
      params: {}
    }
    const resolved = await resolveOrchestrationSessionCaller(h.runtime, request, undefined)
    expect(resolved.caller).toMatchObject({ terminalHandle: null, paneKey: null })
    await expect(
      resolveOrchestrationSessionCaller(
        h.runtime,
        { ...request, params: { terminal: 'term_coord' } },
        undefined
      )
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    await expect(
      resolveOrchestrationSessionCaller(h.runtime, request, { pairedDeviceId: 'peer' })
    ).rejects.toMatchObject({ code: 'session_caller_host_boundary' })
  } finally {
    h.cleanup()
  }
})

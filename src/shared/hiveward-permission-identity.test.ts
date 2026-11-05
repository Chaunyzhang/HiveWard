import { describe, expect, it } from 'vitest'
import { isHiveWardPermissionBundleId } from './hiveward-permission-identity'

describe('HiveWard TCC 重置边界', () => {
  it('只允许本产品 Computer Use helper', () => {
    for (const id of [
      'app.hiveward.computer-use',
      'app.hiveward.dev.computer-use',
      'app.hiveward.dev.branch.computer-use'
    ]) {
      expect(isHiveWardPermissionBundleId(id)).toBe(true)
    }
    for (const id of [
      'com.stablyai.orca',
      'com.stablyai.orca.computer-use',
      'local.opc.app.computer-use',
      'app.hiveward',
      'app.hivewardevil.computer-use',
      'app.hiveward.computer-use.other',
      ''
    ]) {
      expect(isHiveWardPermissionBundleId(id)).toBe(false)
    }
  })
})

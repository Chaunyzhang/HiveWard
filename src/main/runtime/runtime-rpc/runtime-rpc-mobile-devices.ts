import type {
  DelegatedPhone,
  DelegatedMobileDeviceSyncResult
} from '../../../shared/delegated-mobile-device-contract'
import { RuntimeRpcRequestAdmission } from './runtime-rpc-request-admission'

// Why: below dispatch so a caller-bound RPC context can revoke and mint mobile devices.
export class RuntimeRpcMobileDevices extends RuntimeRpcRequestAdmission {
  async revokeMobileDevice(deviceId: string): Promise<boolean> {
    const revoked = this.revokeMobileDeviceNow(deviceId)
    if (revoked) {
      this.mobileDesktopRelay?.phonesChanged()
    }
    return revoked
  }

  private revokeMobileDeviceNow(deviceId: string): boolean {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'mobile') {
      return false
    }
    // Capture gateway registration before deleting its device row so unpair also revokes push.
    if (!this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(deviceId)
    return true
  }

  revokeRuntimeAccess(deviceId: string): boolean {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (device?.scope !== 'runtime') {
      return false
    }
    for (const child of this.deviceRegistry?.listDelegatedMobileDevices(deviceId) ?? []) {
      // Keep parent until child cleanup is durable so retry can rediscover them.
      if (!this.revokeMobileDeviceNow(child.deviceId)) {
        return false
      }
    }
    if (!this.deviceRegistry?.removeDevice(deviceId)) {
      return false
    }
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(deviceId)
    return true
  }

  /** Make the runtime device `parentDeviceId`'s phones exactly `phones`; dropped ones are fully revoked. */
  protected syncDelegatedMobileDevices(
    parentDeviceId: string,
    phones: readonly DelegatedPhone[]
  ): DelegatedMobileDeviceSyncResult {
    const registry = this.deviceRegistry
    const parent = registry?.getDevice(parentDeviceId)
    if (!registry || parent?.scope !== 'runtime') {
      throw new Error('delegated_device_parent_unavailable')
    }
    const wanted = new Set(phones.map((phone) => phone.phoneKey))
    for (const child of registry.listDelegatedMobileDevices(parentDeviceId)) {
      if (
        (!child.phoneKey || !wanted.has(child.phoneKey)) &&
        !this.revokeMobileDeviceNow(child.deviceId)
      ) {
        throw new Error('delegated_device_revoke_failed')
      }
    }
    let devices = registry.upsertDelegatedMobileDevices(parent, phones)
    // A child removed on disk meanwhile is dropped by the save; one rerun mints it fresh.
    if (devices.length < phones.length) {
      const current = registry.getDevice(parentDeviceId)
      if (current?.scope !== 'runtime') {
        throw new Error('delegated_device_parent_unavailable')
      }
      devices = registry.upsertDelegatedMobileDevices(current, phones)
    }
    return {
      devices: devices.map((device) => ({
        phoneKey: device.phoneKey,
        deviceId: device.deviceId,
        token: device.token
      }))
    }
  }
}

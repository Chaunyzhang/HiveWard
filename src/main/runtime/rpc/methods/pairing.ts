import { defineMethod } from '../core'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DelegatedMobileDeviceSyncParamsSchema
} from '../../../../shared/delegated-mobile-device-contract'
import {
  HIVEWARDD_DECLARE_CLIENT_METHOD,
  HIVEWARDD_PEER_DESKTOPS_METHOD,
  HivewarddDeclareClientParamsSchema,
  HivewarddPeerDesktopsParamsSchema
} from '../../../../shared/hivewardd-peer-desktops-contract'
import { RegisterDeviceKeyParamsSchema } from '../../../../shared/device-key-registration-contract'
import { REGISTER_DEVICE_KEY_METHOD } from '../../../../shared/device-key-capability'

export const PAIRING_METHODS = [
  defineMethod({
    name: REGISTER_DEVICE_KEY_METHOD,
    permission: 'device-self',
    params: RegisterDeviceKeyParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.deviceSelf) {
        throw new Error('device_key_registration_unavailable')
      }
      return ctx.deviceSelf.registerDeviceKey(params)
    }
  }),
  defineMethod({
    name: HIVEWARDD_PEER_DESKTOPS_METHOD,
    // Paired desktops lack pairing-admin; they learn only other desktops' names, never credentials.
    permission: 'workspace',
    params: HivewarddPeerDesktopsParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.peerDesktops) {
        throw new Error('runtime_device_required')
      }
      return ctx.peerDesktops.list(params.clientInstanceId)
    }
  }),
  defineMethod({
    name: HIVEWARDD_DECLARE_CLIENT_METHOD,
    permission: 'workspace',
    params: HivewarddDeclareClientParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.peerDesktops) {
        throw new Error('runtime_device_required')
      }
      ctx.peerDesktops.declare(params.clientInstanceId)
      return {}
    }
  }),
  defineMethod({
    name: DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
    // Paired desktops lack pairing-admin but must manage their children within rpc-caller-scope.
    permission: 'workspace',
    params: DelegatedMobileDeviceSyncParamsSchema,
    handler: (params, ctx) => {
      if (!ctx.delegatedMobileDevices) {
        throw new Error('runtime_device_required')
      }
      return ctx.delegatedMobileDevices.sync(params.phones)
    }
  })
]

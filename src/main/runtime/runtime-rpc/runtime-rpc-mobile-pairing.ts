import type { MobilePairingConnectionMode } from '../../../shared/mobile-pairing-connection-mode'
import { RuntimeRpcPairing } from './runtime-rpc-pairing'
import { pairingUnavailable, type MobilePairingOffer } from './runtime-rpc-pairing-types'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../network-exposure-guidance'
export class RuntimeRpcMobilePairing extends RuntimeRpcPairing {
  async createMobilePairingOffer(args: {
    address?: string | null
    connectionMode?: MobilePairingConnectionMode
    name?: string
    rotate?: boolean
  }): Promise<MobilePairingOffer> {
    await this.ensureNetworkExposure().catch(() => {})
    if (!this.wsBoundHost || this.wsBoundHost === '127.0.0.1') {
      return pairingUnavailable('network_exposure_failed', NETWORK_EXPOSURE_FAILED_GUIDANCE)
    }
    const direct = this.createPairingOffer({ ...args, scope: 'mobile' })
    if (!direct.available) {
      return direct
    }
    if (!this.deviceRegistry?.setMobilePairingConnectionMode(direct.deviceId, 'local-only')) {
      throw new Error('无法保存局域网配对策略')
    }
    return { ...direct, connectionMode: 'local-only' }
  }
}

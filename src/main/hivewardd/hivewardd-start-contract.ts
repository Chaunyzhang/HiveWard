import type { ServeReadiness } from '../server/serve-readiness'
import type { HivewarddManagedStopContext } from '../../shared/hivewardd-stop-request'

export type HivewarddOptions = {
  port?: number
  json?: boolean
  noPairing?: boolean
  pairingAddress?: string
  /** Request a mobile-scoped pairing offer and terminal QR. */
  mobilePairing?: boolean
  grantDesktopControl?: boolean
  /** Print only the ephemeral-VM recipe line. */
  recipeJson?: boolean
  projectRoot?: string
  bind?: string
  /** Slots have no browser client; hiveward serve supplies the installed app client. */
  webClientRoot?: string
}

export type HivewarddHandle = {
  readiness: ServeReadiness
  managedStop: HivewarddManagedStopContext
  stop(): Promise<void>
}

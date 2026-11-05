import { hostAtom, hydrateAtoms } from './declarative-atoms'
import { readHostMessage, readStoredValues } from './declarative-host-messages'
import type { HiveWardPanelContext } from './declarative-runtime-types'

/**
 * The `setup(ctx)` context, and hydration: panel id, visibility and persisted atoms from HiveWard.
 * `onRetain` runs when HiveWard asks for keyed memory atoms, to hand them to a dev hot reload.
 */
export function createPanelContext(onRetain?: () => void) {
  const visibility = hostAtom(true)
  const lifetime = new AbortController()
  const context: HiveWardPanelContext = {
    subscriptions: [],
    signal: lifetime.signal,
    visible: visibility.atom,
    panel: { id: '' }
  }
  let hydratedNow = false
  let resolve: () => void = () => undefined
  const hydrated = new Promise<void>((done) => {
    resolve = () => {
      hydratedNow = true
      done()
    }
  })

  function setVisibility(payload: unknown): void {
    const { visible } = readHostMessage(payload)
    if (typeof visible === 'boolean') {
      visibility.set(visible)
    }
  }

  return {
    context,
    hydrated,
    isHydrated: () => hydratedNow,
    markHydrated: () => resolve(),
    setVisibility,
    /** `ui.hydrate`: on boot, and again with the new workspace's values after a switch. */
    hydrate(payload: unknown): void {
      const message = readHostMessage(payload)
      if (typeof message.panelId === 'string') {
        context.panel = { id: message.panelId }
      }
      setVisibility(payload)
      for (const scope of ['plugin', 'workspace', 'memory'] as const) {
        const values = readStoredValues(message[scope])
        if (values) {
          hydrateAtoms(scope, values)
        }
      }
      if (message.retain === true) {
        onRetain?.()
      }
      resolve()
    },
    abort: () => lifetime.abort()
  }
}

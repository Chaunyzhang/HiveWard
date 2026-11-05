import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  normalizeFeatureInteractions,
  type FeatureInteractionId
} from '../../../shared/feature-interactions'

export type FeatureInteractionOperations = {
  state: PersistedState
  scheduleSave: (domains?: readonly string[]) => void
  notifyUIChanged: () => void
  getUI: () => PersistedState['ui']
}

export function recordFeatureInteraction(
  operations: FeatureInteractionOperations,
  id: FeatureInteractionId
): PersistedState['ui'] {
  const featureInteractions = normalizeFeatureInteractions(operations.state.ui?.featureInteractions)
  const existing = featureInteractions[id]
  const previousCount = existing?.interactionCount ?? 0
  const nextCount = previousCount + 1
  operations.state.ui = {
    ...operations.state.ui,
    featureInteractions: {
      ...featureInteractions,
      [id]: {
        firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
        interactionCount: nextCount
      }
    }
  }
  operations.scheduleSave(['ui'])
  // 本地次数变化无需刷新界面，只通知首次使用。
  if (!existing) {
    operations.notifyUIChanged()
  }

  return operations.getUI()
}

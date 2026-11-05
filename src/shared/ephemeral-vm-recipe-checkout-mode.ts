import { getEphemeralVmRecipeResultCheckoutMode } from './ephemeral-vm-recipes'
import type { EphemeralVmRecipeResult } from './ephemeral-vm-recipes'
import type { HiveWardVmRecipe } from './hiveward-yaml-hook-types'
import { ephemeralVmFailure, type EphemeralVmFailure } from './ephemeral-vm-failure-copy'

export function getEphemeralVmRecipeResultSchemaVersion(recipe: HiveWardVmRecipe): 1 | 2 {
  return recipe.checkoutMode === 'provisioned-root' ? 2 : 1
}

export function getEphemeralVmRecipeCheckoutModeFailure(
  recipe: HiveWardVmRecipe,
  result: EphemeralVmRecipeResult
): EphemeralVmFailure | null {
  const configuredMode = recipe.checkoutMode ?? 'hiveward-worktree'
  const resultMode = getEphemeralVmRecipeResultCheckoutMode(result)
  if (configuredMode === resultMode) {
    return null
  }
  return ephemeralVmFailure(
    configuredMode === 'provisioned-root'
      ? 'provisionedRootResultRequired'
      : 'provisionedRootNotConfigured'
  )
}

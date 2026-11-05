import { stripCredentialsFromMessage } from './git-remote-error'
import type { HiveWardVmRecipe } from './hiveward-yaml-hook-types'

export function getProvisionedRootRecipeRepoUrl(
  checkoutMode: HiveWardVmRecipe['checkoutMode'],
  remoteUrl: string | undefined
): string | undefined {
  if (checkoutMode !== 'provisioned-root' || !remoteUrl) {
    return undefined
  }
  return stripCredentialsFromMessage(remoteUrl)
}

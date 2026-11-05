export function isHiveWardPermissionBundleId(bundleId: string): boolean {
  return /^app\.hiveward\.(?:computer-use|dev(?:\.[\w-]+)*\.computer-use)$/.test(bundleId)
}

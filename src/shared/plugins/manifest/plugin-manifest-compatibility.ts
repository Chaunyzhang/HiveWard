import type { PluginCatalogRelease } from '../catalog/plugin-catalog-release'
import { satisfiesHiveWardEngineRange } from './plugin-manifest'

/** Newest manifest format this build reads. */
export const PLUGIN_MANIFEST_VERSION_CURRENT = 2

/** Lenient pre-read of a manifest the strict schema rejected. A plugin built for a newer HiveWard
 *  fails on fields this build has never heard of; naming the version gap is the useful fix. */
export function pluginManifestCompatibilityError(raw: unknown, hostVersion: string): string | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const engines = 'engines' in raw ? raw.engines : undefined
  const range =
    typeof engines === 'object' && engines !== null && 'hiveward' in engines ? engines.hiveward : undefined
  // Why only the leading floor: a later range grammar (`>=1.6.0 <2`) must still name the gap here.
  const floor = typeof range === 'string' ? /^\s*(>=\d+\.\d+\.\d+)/.exec(range)?.[1] : undefined
  if (typeof range === 'string' && floor && !satisfiesHiveWardEngineRange(hostVersion, floor)) {
    return `requires HiveWard ${range} (this is ${hostVersion})`
  }
  const version = 'manifestVersion' in raw ? raw.manifestVersion : undefined
  if (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version > PLUGIN_MANIFEST_VERSION_CURRENT
  ) {
    return `requires HiveWard support for manifest format ${version} (this is ${hostVersion})`
  }
  return null
}

/** Why before any download: a release for a newer HiveWard stays listed, but fetching bytes this
 *  build will refuse only delays the real answer. */
export function pluginCatalogReleaseCompatibilityError(
  release: PluginCatalogRelease,
  hostVersion: string
): string | null {
  return satisfiesHiveWardEngineRange(hostVersion, `>=${release.minimumHiveWard}`)
    ? null
    : `requires HiveWard >=${release.minimumHiveWard} (this is ${hostVersion})`
}

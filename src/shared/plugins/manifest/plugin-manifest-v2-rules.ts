import type { RefinementCtx } from 'zod'
import type { PluginCapability } from '../capabilities/plugin-capabilities'
import {
  pluginExecutionAllows,
  type PluginExecutionProfile
} from '../contributions/plugin-execution-profile'
import { pluginCapabilityReachable } from '../capabilities/plugin-capability-reach'
import { hivewardEngineRangeSchema, satisfiesHiveWardEngineRange } from './plugin-manifest-engine-range'
import {
  PLUGIN_DERIVED_PUBLISHER_SINCE,
  PLUGIN_SOURCE_MODULES_SINCE
} from './plugin-schema-field-docs'
import {
  isPluginSourceModulePath,
  isPluginWorkerSourcePath
} from '../frames/plugin-frame-source-modules'

type V2RuleSubject = {
  execution: PluginExecutionProfile
  pluginApi?: number
  capabilities: readonly PluginCapability[]
}

/** Format 2 rules that are not about shape. */
export function validatePluginManifestV2Rules(manifest: V2RuleSubject, ctx: RefinementCtx): void {
  if (
    manifest.pluginApi !== undefined &&
    !pluginExecutionAllows(manifest.execution, 'sandboxed-ui')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['pluginApi'],
      message: `${manifest.execution} plugins never call the host API; remove pluginApi`
    })
  }
  manifest.capabilities.forEach((capability, index) => {
    if (!pluginCapabilityReachable(capability.kind, manifest.execution)) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', index, 'kind'],
        message: `${capability.kind} needs the trusted-worker execution profile; ${manifest.execution} plugins can't use it, so remove it or add a worker`
      })
    }
  })
}

/** Why authoring only: HiveWard before PLUGIN_DERIVED_PUBLISHER_SINCE requires `publisher`, so a
 *  manifest without it must say "requires HiveWard X" there instead of failing to parse. */
export function validateOmittedPublisherFloor(
  manifest: { publisher?: string; engines: { hiveward: string } },
  ctx: RefinementCtx
): void {
  if (
    manifest.publisher !== undefined ||
    !hivewardEngineRangeSchema.safeParse(manifest.engines.hiveward).success ||
    satisfiesHiveWardEngineRange(manifest.engines.hiveward.slice(2), `>=${PLUGIN_DERIVED_PUBLISHER_SINCE}`)
  ) {
    return
  }
  ctx.addIssue({
    code: 'custom',
    path: ['engines', 'hiveward'],
    message: `must be at least >=${PLUGIN_DERIVED_PUBLISHER_SINCE} when publisher is left out, because older HiveWard requires publisher`
  })
}

const engineBelow = (range: string, version: string): boolean =>
  hivewardEngineRangeSchema.safeParse(range).success &&
  !satisfiesHiveWardEngineRange(range.slice(2), `>=${version}`)

/** Why authoring only: older HiveWard serves a `.tsx` entry as raw bytes, so it must not install it. */
export function validateSourceModuleEntryFloor(
  manifest: {
    engines: { hiveward: string }
    main?: string
    contributes: {
      panels: readonly { entry: string }[]
      customEditors: readonly { entry: string }[]
    }
  },
  ctx: RefinementCtx
): void {
  const { panels, customEditors } = manifest.contributes
  const usesSource = [...panels, ...customEditors].some((item) =>
    isPluginSourceModulePath(item.entry)
  )
  if (usesSource && engineBelow(manifest.engines.hiveward, PLUGIN_SOURCE_MODULES_SINCE)) {
    ctx.addIssue({
      code: 'custom',
      path: ['engines', 'hiveward'],
      message: `must be at least >=${PLUGIN_SOURCE_MODULES_SINCE} when a panel or editor entry is a .ts, .tsx, .mts or .jsx file, because older HiveWard does not transpile it`
    })
  }
  const main = manifest.main?.toLowerCase()
  if (main === undefined || !isPluginSourceModulePath(main)) {
    return
  }
  if (!isPluginWorkerSourcePath(main)) {
    ctx.addIssue({
      code: 'custom',
      path: ['main'],
      message: 'a worker runs in Node with no JSX; use a .ts, .mts, .js or .mjs file'
    })
  } else if (engineBelow(manifest.engines.hiveward, PLUGIN_SOURCE_MODULES_SINCE)) {
    ctx.addIssue({
      code: 'custom',
      path: ['engines', 'hiveward'],
      message: `must be at least >=${PLUGIN_SOURCE_MODULES_SINCE} when main is a .ts or .mts file, because older HiveWard does not transpile it`
    })
  }
}

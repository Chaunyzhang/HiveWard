import {
  renderPluginEventPayloadMembers,
  renderPluginHostMethodMembers
} from '../authoring/plugin-host-typings'

/** Markers around the generated region of resources/plugins/declarative/hiveward.d.ts. */
export const HIVEWARD_HOST_TYPINGS_BEGIN = '  // <generated: host methods, from plugin-host-api.ts>'
export const HIVEWARD_HOST_TYPINGS_END = '  // </generated>'

/** The panel's host methods as `HostMethods`, from the same generator as `.hiveward/types/hiveward-host`. */
export function renderHiveWardHostTypings(): string {
  return [
    HIVEWARD_HOST_TYPINGS_BEGIN,
    '  export type HostMethods = {',
    `${renderPluginHostMethodMembers('    ', { surface: 'panel', compact: true }).trimEnd()}`,
    '  }',
    '  /** Workspace and agent events `on(event)` delivers, with the read capability of their domain. */',
    '  export type PluginEvents = {',
    `${renderPluginEventPayloadMembers('    ').trimEnd()}`,
    '  }',
    HIVEWARD_HOST_TYPINGS_END
  ].join('\n')
}

/** `file` with its generated region replaced; throws when the markers are missing. */
export function spliceHiveWardHostTypings(file: string): string {
  const begin = file.indexOf(HIVEWARD_HOST_TYPINGS_BEGIN)
  const end = file.indexOf(HIVEWARD_HOST_TYPINGS_END, begin)
  if (begin === -1 || end === -1) {
    throw new Error('hiveward.d.ts lacks the generated host-method markers')
  }
  return (
    file.slice(0, begin) + renderHiveWardHostTypings() + file.slice(end + HIVEWARD_HOST_TYPINGS_END.length)
  )
}

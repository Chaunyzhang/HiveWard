import { parse as parseToml } from 'smol-toml'
import {
  findManagedTomlBlocks,
  type ManagedTomlBlockRegion,
  type ManagedTomlMarkers,
  type ManagedTomlRegion,
  type RecognizedManagedTable
} from '../agent-hooks/managed-toml-ownership'

export const KIMI_HOOK_MARKERS: ManagedTomlMarkers = {
  startMarker: '# >>> hiveward-managed-kimi-hooks (managed by HiveWard; do not edit) >>>',
  endMarker: '# <<< hiveward-managed-kimi-hooks <<<'
}
export const KIMI_LEGACY_HOOK_MARKERS: ManagedTomlMarkers = {
  startMarker: '# >>> hiveward-managed-kimi-hooks (managed by HiveWard; do not edit) >>>',
  endMarker: '# <<< hiveward-managed-kimi-hooks <<<'
}

type CommandMatcher = (command: string | undefined) => boolean

function readHookCommands(text: string): string[] | null {
  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch {
    try {
      parsed = parseToml(`hooks = [\n${text}\n]`)
    } catch {
      return null
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  if (Object.keys(parsed).length !== 1 || !('hooks' in parsed) || !Array.isArray(parsed.hooks)) {
    return null
  }
  const commands: string[] = []
  for (const entry of parsed.hooks) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('command' in entry) ||
      typeof entry.command !== 'string'
    ) {
      return null
    }
    commands.push(entry.command)
  }
  return commands
}

function readMarkerBlockCommands(
  configText: string,
  block: ManagedTomlBlockRegion,
  markers: ManagedTomlMarkers
): string[] | null {
  const startLineEnd = configText.indexOf('\n', block.markerOffset)
  const endMarkerOffset = configText.lastIndexOf(markers.endMarker, block.endOffset)
  if (startLineEnd === -1 || endMarkerOffset === -1) {
    return null
  }
  const content = configText.slice(startLineEnd + 1, endMarkerOffset)
  if (content.split(/(?<=\n)/).some((line) => line.trim().startsWith('#'))) {
    return null
  }
  return readHookCommands(content)
}

export function findOwnedKimiMarkerBlocks(
  configText: string,
  isManagedCommand: CommandMatcher
): ManagedTomlBlockRegion[] {
  const owned: ManagedTomlBlockRegion[] = []
  for (const markers of [KIMI_HOOK_MARKERS, KIMI_LEGACY_HOOK_MARKERS]) {
    for (const block of findManagedTomlBlocks(configText, markers)) {
      if (!block.terminated) {
        if (markers === KIMI_HOOK_MARKERS) {
          owned.push(block)
        }
        continue
      }
      const commands = readMarkerBlockCommands(configText, block, markers)
      if (commands === null) {
        throw new Error('Cannot safely determine Kimi hook marker ownership')
      }
      if (commands.length === 0) {
        if (markers === KIMI_HOOK_MARKERS) {
          owned.push(block)
        }
        continue
      }
      const ownership = commands.map((command) => isManagedCommand(command))
      if (ownership.every(Boolean)) {
        owned.push(block)
      } else if (ownership.some(Boolean)) {
        throw new Error('Cannot safely replace a mixed-ownership Kimi hook marker block')
      }
    }
  }
  return owned
}

type MultilineHooksArray = {
  region: ManagedTomlRegion
  text: string
}

function findMultilineTopLevelHooksArrays(configText: string): MultilineHooksArray[] {
  const lines = configText.split(/(?<=\n)/)
  const offsets: number[] = []
  let nextOffset = 0
  for (const line of lines) {
    offsets.push(nextOffset)
    nextOffset += line.length
  }

  const arrays: MultilineHooksArray[] = []
  let atTopLevel = true
  for (let index = 0; index < lines.length; index++) {
    const body = lines[index].replace(/\r?\n$/, '')
    if (body.trim().startsWith('[')) {
      atTopLevel = false
      continue
    }
    if (!atTopLevel || !/^\s*hooks\s*=\s*\[[ \t]*$/.test(body)) {
      continue
    }
    let closingIndex = -1
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      if (/^\s*\]\s*(?:#.*)?$/.test(lines[cursor].replace(/\r?\n$/, ''))) {
        closingIndex = cursor
        break
      }
    }
    if (closingIndex === -1) {
      throw new Error('Cannot safely replace an unterminated top-level Kimi hooks array')
    }
    const closingBody = lines[closingIndex].replace(/\r?\n$/, '')
    const closeBracketOffset = offsets[closingIndex] + closingBody.indexOf(']')
    arrays.push({
      region: { startOffset: offsets[index] + body.length, endOffset: closeBracketOffset },
      text: configText.slice(offsets[index], offsets[closingIndex] + lines[closingIndex].length)
    })
    index = closingIndex
  }
  return arrays
}

function hasOnlyManagedMarkerComments(text: string): boolean {
  const allowed = new Set([
    KIMI_HOOK_MARKERS.startMarker,
    KIMI_HOOK_MARKERS.endMarker,
    KIMI_LEGACY_HOOK_MARKERS.startMarker,
    KIMI_LEGACY_HOOK_MARKERS.endMarker
  ])
  return text.split(/(?<=\n)/).every((line) => {
    const trimmed = line.trim()
    return (!trimmed.startsWith('#') || allowed.has(trimmed)) && !/\}\s*,?\s*#/.test(line)
  })
}

export function findOwnedKimiInlineArrayRegions(
  configText: string,
  isManagedCommand: CommandMatcher,
  inlineTables: readonly RecognizedManagedTable<string | null>[]
): ManagedTomlRegion[] {
  const ownedRegions: ManagedTomlRegion[] = []
  for (const array of findMultilineTopLevelHooksArrays(configText)) {
    const hasRecognizedInlineTable = inlineTables.some(
      (table) =>
        table.startOffset >= array.region.startOffset && table.endOffset <= array.region.endOffset
    )
    const commands = readHookCommands(array.text)
    if (commands === null) {
      if (hasRecognizedInlineTable) {
        throw new Error('Cannot safely determine Kimi inline hook array ownership')
      }
      continue
    }
    const ownership = commands.map((command) => isManagedCommand(command))
    if (ownership.every(Boolean) && commands.length > 0) {
      if (!hasOnlyManagedMarkerComments(array.text)) {
        throw new Error('Cannot safely replace a Kimi inline hook array containing user comments')
      }
      ownedRegions.push(array.region)
    } else if (ownership.some(Boolean)) {
      throw new Error('Cannot safely replace a mixed-ownership Kimi inline hook array')
    }
  }
  return ownedRegions
}

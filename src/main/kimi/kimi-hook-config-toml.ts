// Preserve user TOML while managing HiveWard marker blocks and positively recognized hook tables.

import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import {
  findRecognizedManagedTables,
  stripManagedTomlRegions,
  type ManagedTomlRegion,
  type RecognizedManagedTable
} from '../agent-hooks/managed-toml-ownership'
import {
  findOwnedKimiInlineArrayRegions,
  findOwnedKimiMarkerBlocks,
  KIMI_HOOK_MARKERS
} from './kimi-hook-ownership'

export const KIMI_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure'
] as const

const HOOK_TABLE_HEADER = '[[hooks]]'

export type ManagedCommandMatcher = (command: string | undefined) => boolean

// Command paths confer ownership even with extra keys; unknown multiline extents fail closed to preserve user bytes.
function matchManagedHookTable(
  lines: readonly string[],
  index: number,
  isManagedCommand: ManagedCommandMatcher
): { lineCount: number; value: string | null } | null {
  if (lines[index].trim() !== HOOK_TABLE_HEADER) {
    return null
  }
  const pairs = new Map<string, string>()
  let cursor = index + 1
  while (cursor < lines.length) {
    const line = lines[cursor].trim()
    // A blank, the next table header or a comment (the end marker included)
    // ends the table's key run.
    if (line === '' || line.startsWith('[') || line.startsWith('#')) {
      break
    }
    const pair = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.*)$/)
    if (!pair || pairs.has(pair[1])) {
      return null
    }
    pairs.set(pair[1], pair[2].trim())
    cursor++
  }
  // TOML gaps do not end tables; later keys make this partial run unsafe to splice.
  if (keysFollowGap(lines, cursor)) {
    return null
  }
  // Raw (still-escaped) literal; createManagedCommandMatcher normalizes separators itself.
  const command = readTomlString(pairs.get('command'))
  if (!isManagedCommand(command)) {
    return null
  }
  return { lineCount: cursor - index, value: readEventName(pairs.get('event')) }
}

function keysFollowGap(lines: readonly string[], from: number): boolean {
  for (let cursor = from; cursor < lines.length; cursor++) {
    const line = lines[cursor].trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    return !line.startsWith('[')
  }
  return false
}

// Basic or literal TOML string, ignoring any inline comment after it.
function readTomlString(value: string | undefined): string | undefined {
  return value?.match(/^"((?:[^"\\]|\\.)*)"/)?.[1] ?? value?.match(/^'([^']*)'/)?.[1]
}

// Unreadable command-owned events must report partial, not absent; raw text cannot match a known event.
function readEventName(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }
  return readTomlString(value) ?? value.trim() ?? null
}

function recognizeManagedTables(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): RecognizedManagedTable<string | null>[] {
  return findRecognizedManagedTables(configText, (lines, index) =>
    matchManagedHookTable(lines, index, isManagedCommand)
  )
}

// Own matched marker pairs and positively recognized tables wherever edits moved them.
function findOwnedRegions(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): ManagedTomlRegion[] {
  const inlineTables = recognizeManagedInlineTables(configText, isManagedCommand)
  return [
    ...findOwnedKimiMarkerBlocks(configText, isManagedCommand),
    ...findOwnedKimiInlineArrayRegions(configText, isManagedCommand, inlineTables),
    ...recognizeManagedTables(configText, isManagedCommand),
    ...inlineTables
  ]
}

function readInlineTomlValue(line: string, key: 'event' | 'command'): string | undefined {
  const match = line.match(
    new RegExp(`(?:\\{|,)\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^,}]+)`)
  )
  return match?.[1].trim()
}

function matchManagedInlineHookTable(
  lines: readonly string[],
  index: number,
  isManagedCommand: ManagedCommandMatcher
): { lineCount: number; value: string | null } | null {
  const line = lines[index].trim()
  if (!line.startsWith('{') || !/\},?$/.test(line)) {
    return null
  }
  const command = readTomlString(readInlineTomlValue(line, 'command'))
  if (!isManagedCommand(command)) {
    return null
  }
  const event = readInlineTomlValue(line, 'event')
  return { lineCount: 1, value: event === undefined ? null : readEventName(event) }
}

function recognizeManagedInlineTables(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): RecognizedManagedTable<string | null>[] {
  return findRecognizedManagedTables(configText, (lines, index) =>
    matchManagedInlineHookTable(lines, index, isManagedCommand)
  )
}

// Escape Windows fallback paths for TOML basic strings.
function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // Control chars would make Kimi's TOML parser reject the file.
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

function managedKimiHookFields(event: string, commandLiteral: string): string[] {
  // Kimi treats matcher as regex (so * is invalid); omit it except to scope SessionStart.
  return [
    `event = "${event}"`,
    // Why: Kimi awaits SessionStart during a new session's first prompt; only a resume is used.
    ...(event === 'SessionStart' ? ['matcher = "^resume$"'] : []),
    `command = ${commandLiteral}`,
    `timeout = ${MANAGED_HOOK_TIMEOUT_SECONDS}`
  ]
}

export function buildManagedKimiHooksBlock(command: string, eol = '\n'): string {
  const commandLiteral = tomlBasicString(command)
  const entries = KIMI_HOOK_EVENTS.map((event) =>
    [HOOK_TABLE_HEADER, ...managedKimiHookFields(event, commandLiteral)].join(eol)
  )
  return [KIMI_HOOK_MARKERS.startMarker, ...entries, KIMI_HOOK_MARKERS.endMarker].join(eol)
}

function buildManagedKimiInlineHooksBlock(command: string, eol: string): string {
  const commandLiteral = tomlBasicString(command)
  const entries = KIMI_HOOK_EVENTS.map(
    (event) => `{ ${managedKimiHookFields(event, commandLiteral).join(', ')} },`
  )
  return [KIMI_HOOK_MARKERS.startMarker, ...entries, KIMI_HOOK_MARKERS.endMarker].join(eol)
}

function detectEol(configText: string): string {
  return configText.includes('\r\n') ? '\r\n' : '\n'
}

function findEmptyTopLevelHooksArray(configText: string): { closeBracketOffset: number } | null {
  let offset = 0
  let atTopLevel = true
  let found: { closeBracketOffset: number } | null = null
  for (const line of configText.split(/(?<=\n)/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      atTopLevel = false
    }
    const declaresHooks = /^\s*(?:hooks|"hooks"|'hooks')\s*[=.]/.test(line)
    if (atTopLevel && declaresHooks) {
      const body = line.replace(/\r?\n$/, '')
      if (found || !/^\s*hooks\s*=\s*\[\s*\]\s*(?:#.*)?$/.test(body)) {
        throw new Error('Cannot safely replace a non-empty or ambiguous top-level Kimi hooks value')
      }
      found = { closeBracketOffset: offset + line.indexOf(']') }
    }
    offset += line.length
  }
  return found
}

export function applyManagedKimiHooks(
  configText: string,
  command: string,
  isManagedCommand: ManagedCommandMatcher
): string {
  const eol = detectEol(configText)
  const withoutManaged = stripManagedTomlRegions(
    configText,
    findOwnedRegions(configText, isManagedCommand)
  ).text
  const emptyArray = findEmptyTopLevelHooksArray(withoutManaged)
  if (emptyArray) {
    const insertion = `${eol}${buildManagedKimiInlineHooksBlock(command, eol)}${eol}`
    return `${withoutManaged.slice(0, emptyArray.closeBracketOffset)}${insertion}${withoutManaged.slice(emptyArray.closeBracketOffset)}`
  }
  const trimmed = withoutManaged.replace(/\s+$/, '')
  const block = buildManagedKimiHooksBlock(command, eol)
  return trimmed.length > 0 ? `${trimmed}${eol}${eol}${block}${eol}` : `${block}${eol}`
}

export function removeManagedKimiHooks(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): { text: string; changed: boolean } {
  const hasInlineBlock =
    findOwnedKimiInlineArrayRegions(
      configText,
      isManagedCommand,
      recognizeManagedInlineTables(configText, isManagedCommand)
    ).length > 0
  const stripped = stripManagedTomlRegions(
    configText,
    findOwnedRegions(configText, isManagedCommand)
  )
  if (!stripped.changed) {
    return { text: configText, changed: false }
  }
  if (hasInlineBlock) {
    return { text: stripped.text, changed: true }
  }
  const eol = detectEol(configText)
  const trimmed = stripped.text.replace(/\s+$/, '')
  return { text: trimmed.length > 0 ? `${trimmed}${eol}` : '', changed: true }
}

// Count managed tables outside markers too: they still emit events and must not appear uninstalled.
export function readManagedKimiHookEvents(
  configText: string,
  isManagedCommand: ManagedCommandMatcher
): Set<string> {
  const events = new Set<string>()
  for (const table of [
    ...recognizeManagedTables(configText, isManagedCommand),
    ...recognizeManagedInlineTables(configText, isManagedCommand)
  ]) {
    if (table.value) {
      events.add(table.value)
    }
  }
  return events
}

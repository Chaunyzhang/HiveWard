import { parse as parseToml } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import {
  applyManagedKimiHooks,
  buildManagedKimiHooksBlock,
  KIMI_HOOK_EVENTS,
  readManagedKimiHookEvents,
  removeManagedKimiHooks
} from './kimi-hook-config-toml'

const COMMAND =
  "if [ -x '/home/u/.hiveward/agent-hooks/hiveward/kimi-hook.sh' ]; then /bin/sh '/home/u/.hiveward/agent-hooks/hiveward/kimi-hook.sh'; fi"
const HIVEWARD_COMMAND =
  "if [ -x '/home/u/.hiveward/agent-hooks/kimi-hook.sh' ]; then /bin/sh '/home/u/.hiveward/agent-hooks/kimi-hook.sh'; fi"
const isManaged = (command: string | undefined): boolean =>
  typeof command === 'string' && command.includes('agent-hooks/hiveward/kimi-hook.sh')

const END_MARKER_LINE = '# <<< hiveward-managed-kimi-hooks <<<'
const START_MARKER = '# >>> hiveward-managed-kimi-hooks (managed by HiveWard; do not edit) >>>'
const LEGACY_END_MARKER = '# <<< hiveward-managed-kimi-hooks <<<'
const LEGACY_START_MARKER = '# >>> hiveward-managed-kimi-hooks (managed by HiveWard; do not edit) >>>'

/** Drops only the `# <<< ... <<<` line, the hand-edit that orphans the block. */
function deleteEndMarker(text: string): string {
  return text.replace(/\r?\n# <<< hiveward-managed-kimi-hooks <<</, '')
}

function deleteMarkerLine(text: string, marker: string): string {
  const markerOffset = text.indexOf(marker)
  if (markerOffset === -1) {
    throw new Error(`Marker not found: ${marker}`)
  }
  const lineStart = text.lastIndexOf('\n', markerOffset - 1) + 1
  const lineEnd = text.indexOf('\n', markerOffset)
  return text.slice(0, lineStart) + text.slice(lineEnd === -1 ? text.length : lineEnd + 1)
}

describe('kimi managed hooks TOML block', () => {
  it('installs every managed event, scoping only SessionStart to resumes', () => {
    const block = buildManagedKimiHooksBlock(COMMAND)
    for (const event of KIMI_HOOK_EVENTS) {
      expect(block).toContain(`event = "${event}"`)
    }
    // Kimi treats matcher as a regex; omitting it matches all tools.
    expect(block.match(/matcher = .*/g)).toEqual(['matcher = "^resume$"'])
    expect(block).toContain('event = "SessionStart"\nmatcher = "^resume$"')
    expect(block).not.toContain('event = "PermissionRequest"')
    expect(KIMI_HOOK_EVENTS).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'Stop',
      'StopFailure'
    ])
    expect(
      readManagedKimiHookEvents(applyManagedKimiHooks('', COMMAND, isManaged), isManaged)
    ).toEqual(new Set(KIMI_HOOK_EVENTS))
  })

  it('inserts inline tables without replacing the original empty hooks array', () => {
    const next = applyManagedKimiHooks(
      '# keep this comment\ndefault_model = "kimi-k2.6"\nhooks = [] # keep inline comment\n',
      COMMAND,
      isManaged
    )
    expect(next).toContain('# keep this comment')
    expect(next).toContain('default_model = "kimi-k2.6"')
    expect(next).toContain('hooks = [')
    expect(next).toContain('] # keep inline comment')
    expect(next.match(/^\[\[hooks\]\]$/gm)).toBeNull()
    expect(next.match(/^\{ event = /gm)).toHaveLength(KIMI_HOOK_EVENTS.length)
    expect(readManagedKimiHookEvents(next, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    expect(() => parseToml(next)).not.toThrow()
  })

  it('reinstalls inline hooks idempotently and uninstalls to the exact original bytes', () => {
    const original = 'default_model = "x"\nhooks = []\n\n# retain trailing bytes\n'
    const installed = applyManagedKimiHooks(original, COMMAND, isManaged)
    expect(applyManagedKimiHooks(installed, COMMAND, isManaged)).toBe(installed)
    expect(removeManagedKimiHooks(installed, isManaged)).toEqual({
      text: original,
      changed: true
    })
    expect(applyManagedKimiHooks(original, COMMAND, isManaged)).toBe(installed)
  })

  it.each([
    ['start', START_MARKER],
    ['end', END_MARKER_LINE]
  ])('recovers inline hooks after deleting the %s marker', (_name, marker) => {
    const original = 'hooks = []\n# retain this user tail\n'
    const installed = applyManagedKimiHooks(original, COMMAND, isManaged)
    const orphaned = deleteMarkerLine(installed, marker)
    expect(() => parseToml(orphaned)).not.toThrow()
    expect(readManagedKimiHookEvents(orphaned, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    expect(removeManagedKimiHooks(orphaned, isManaged)).toEqual({
      text: original,
      changed: true
    })
    expect(applyManagedKimiHooks(orphaned, COMMAND, isManaged)).toBe(installed)
    expect(applyManagedKimiHooks(installed, COMMAND, isManaged)).toBe(installed)
  })

  it('fails closed for non-empty or ambiguous top-level hooks values', () => {
    for (const config of [
      'hooks = [{ event = "Stop", command = "mine" }]\n',
      'hooks = [\n]\n',
      '"hooks" = []\n',
      'hooks = []\nhooks = []\n'
    ]) {
      expect(() => applyManagedKimiHooks(config, COMMAND, isManaged)).toThrow(
        'non-empty or ambiguous top-level Kimi hooks'
      )
    }
  })

  it('drops a previously managed PermissionRequest entry without rewriting user hooks', () => {
    const previous = [
      LEGACY_START_MARKER,
      '[[hooks]]',
      'event = "PermissionRequest"',
      `command = "${COMMAND}"`,
      'timeout = 10',
      LEGACY_END_MARKER,
      '',
      '[[hooks]]',
      'event = "PermissionRequest"',
      'command = "node my-own-hook.mjs"'
    ].join('\n')
    const next = applyManagedKimiHooks(previous, COMMAND, isManaged)
    expect(next).toContain('command = "node my-own-hook.mjs"')
    expect(next.match(/event = "PermissionRequest"/g)).toHaveLength(1)
  })

  it('preserves existing user config above the managed block', () => {
    const userConfig = [
      'default_model = "kimi-k2.6"',
      '',
      '[providers."mine"]',
      'type = "openai"',
      'base_url = "https://example.com/v1"',
      'api_key = "sk-secret"',
      '',
      '[[hooks]]',
      'event = "SessionStart"',
      'command = "node my-own-hook.mjs"',
      ''
    ].join('\n')

    const next = applyManagedKimiHooks(userConfig, COMMAND, isManaged)
    expect(next).toContain('default_model = "kimi-k2.6"')
    expect(next).toContain('api_key = "sk-secret"')
    // The user's own hook survives untouched.
    expect(next).toContain('command = "node my-own-hook.mjs"')
    expect(readManagedKimiHookEvents(next, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })

  it('is idempotent — reinstalling does not duplicate the block', () => {
    const once = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const twice = applyManagedKimiHooks(once, COMMAND, isManaged)
    expect(twice).toBe(once)
    const markerCount = (twice.match(/hiveward-managed-kimi-hooks \(/g) ?? []).length
    expect(markerCount).toBe(1)
  })

  it('removes the managed block and restores the user config', () => {
    const userConfig = 'default_model = "kimi-k2.6"\n'
    const installed = applyManagedKimiHooks(userConfig, COMMAND, isManaged)
    const { text, changed } = removeManagedKimiHooks(installed, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe(userConfig)
    expect(readManagedKimiHookEvents(text, isManaged).size).toBe(0)
  })

  it('is stable across repeated calls (no stateful global-regex lastIndex drift)', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    // Repeated detection must not inherit stateful regex lastIndex.
    expect(removeManagedKimiHooks(installed, isManaged).changed).toBe(true)
    expect(removeManagedKimiHooks(installed, isManaged).changed).toBe(true)
    expect(removeManagedKimiHooks('default_model = "x"\n', isManaged).changed).toBe(false)
    expect(removeManagedKimiHooks(installed, isManaged).changed).toBe(true)
    expect(readManagedKimiHookEvents(installed, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    expect(readManagedKimiHookEvents(installed, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
  })

  it('recovers when a hand-edit deletes only the trailing end marker', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const orphaned = deleteEndMarker(installed)
    expect(orphaned).not.toContain('<<<')
    expect(readManagedKimiHookEvents(orphaned, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    expect(removeManagedKimiHooks(orphaned, isManaged)).toEqual({
      text: 'default_model = "x"\n',
      changed: true
    })
    const reinstalled = applyManagedKimiHooks(orphaned, COMMAND, isManaged)
    expect((reinstalled.match(/hiveward-managed-kimi-hooks \(/g) ?? []).length).toBe(1)
  })
})

describe('Kimi hook marker ownership coexistence', () => {
  it('leaves a pure HiveWard block intact while adding a separate HiveWard block', () => {
    const hivewardBlock = [
      LEGACY_START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      `command = "${HIVEWARD_COMMAND}"`,
      'timeout = 10',
      LEGACY_END_MARKER,
      ''
    ].join('\n')
    expect(removeManagedKimiHooks(hivewardBlock, isManaged)).toEqual({
      text: hivewardBlock,
      changed: false
    })

    const next = applyManagedKimiHooks(hivewardBlock, COMMAND, isManaged)
    expect(next).toContain(HIVEWARD_COMMAND)
    expect(next).toContain(COMMAND)
    expect(next).toContain(LEGACY_START_MARKER)
    expect(next).toContain(START_MARKER)
    expect(() => parseToml(next)).not.toThrow()
    expect(applyManagedKimiHooks(next, COMMAND, isManaged)).toBe(next)
  })

  it('migrates pure HiveWard inline hooks from legacy HiveWard markers without losing bytes', () => {
    const original = 'hooks = []\n# keep this tail\n'
    const installed = applyManagedKimiHooks(original, COMMAND, isManaged)
    const legacy = installed
      .replace(START_MARKER, LEGACY_START_MARKER)
      .replace(END_MARKER_LINE, LEGACY_END_MARKER)

    expect(applyManagedKimiHooks(legacy, COMMAND, isManaged)).toBe(installed)
    expect(removeManagedKimiHooks(legacy, isManaged)).toEqual({
      text: original,
      changed: true
    })
    expect(applyManagedKimiHooks(installed, COMMAND, isManaged)).toBe(installed)
  })

  it.each([
    [START_MARKER, END_MARKER_LINE],
    [LEGACY_START_MARKER, LEGACY_END_MARKER]
  ])('fails closed on a mixed normal block without dropping either owner', (start, end) => {
    const mixed = [
      start,
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND}"`,
      'timeout = 10',
      '[[hooks]]',
      'event = "PreToolUse"',
      `command = "${HIVEWARD_COMMAND}"`,
      'timeout = 10',
      end
    ].join('\n')
    expect(() => applyManagedKimiHooks(mixed, COMMAND, isManaged)).toThrow('mixed-ownership')
    expect(() => removeManagedKimiHooks(mixed, isManaged)).toThrow('mixed-ownership')
    expect(mixed).toContain(COMMAND)
    expect(mixed).toContain(HIVEWARD_COMMAND)
  })

  it('fails closed on a mixed inline array without dropping either owner', () => {
    const installed = applyManagedKimiHooks('hooks = []\n', COMMAND, isManaged)
    const mixed = installed.replace(
      END_MARKER_LINE,
      `{ event = "PreToolUse", command = "${HIVEWARD_COMMAND}", timeout = 10 },\n${END_MARKER_LINE}`
    )
    expect(() => parseToml(mixed)).not.toThrow()
    expect(() => applyManagedKimiHooks(mixed, COMMAND, isManaged)).toThrow('mixed-ownership')
    expect(() => removeManagedKimiHooks(mixed, isManaged)).toThrow('mixed-ownership')
    expect(mixed).toContain(COMMAND)
    expect(mixed).toContain(HIVEWARD_COMMAND)
  })

  it('leaves a pure HiveWard inline array unchanged', () => {
    const foreign = `hooks = [\n${LEGACY_START_MARKER}\n{ event = "Stop", command = "${HIVEWARD_COMMAND}", timeout = 10 },\n${LEGACY_END_MARKER}\n]\n`
    expect(removeManagedKimiHooks(foreign, isManaged)).toEqual({
      text: foreign,
      changed: false
    })
    expect(() => applyManagedKimiHooks(foreign, COMMAND, isManaged)).toThrow(
      'non-empty or ambiguous'
    )
    expect(foreign).toContain(HIVEWARD_COMMAND)
  })
})

// #18861: an orphaned start marker used to make every following byte "managed".
describe('orphaned managed block ownership (#18861)', () => {
  const USER_TAIL = [
    '[providers."mine"]',
    'type = "openai"',
    'api_key = "sk-secret"',
    '',
    '[[hooks]]',
    'event = "Stop"',
    'command = "node my-own-hook.mjs"'
  ].join('\n')

  function orphanedWithUserTail(): string {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    return `${deleteEndMarker(installed)}\n${USER_TAIL}\n`
  }

  it('keeps user tables appended after an orphaned block through remove', () => {
    const { text, changed } = removeManagedKimiHooks(orphanedWithUserTail(), isManaged)
    expect(changed).toBe(true)
    expect(text).toContain('api_key = "sk-secret"')
    expect(text).toContain('command = "node my-own-hook.mjs"')
    expect(text).toContain('default_model = "x"')
    expect(text).not.toContain(START_MARKER)
    expect(text).not.toContain('agent-hooks/kimi-hook.sh')
  })

  it('keeps user tables appended after an orphaned block through reinstall', () => {
    const reinstalled = applyManagedKimiHooks(orphanedWithUserTail(), COMMAND, isManaged)
    expect(reinstalled).toContain('api_key = "sk-secret"')
    expect(reinstalled).toContain('command = "node my-own-hook.mjs"')
    expect((reinstalled.match(/hiveward-managed-kimi-hooks \(/g) ?? []).length).toBe(1)
    expect(reinstalled.indexOf('sk-secret')).toBeLessThan(reinstalled.indexOf(START_MARKER))
    expect(readManagedKimiHookEvents(reinstalled, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    expect(applyManagedKimiHooks(reinstalled, COMMAND, isManaged)).toBe(reinstalled)
  })

  it('reclaims a genuinely managed orphan table but stops at the first user line', () => {
    const orphan = [
      'default_model = "x"',
      '',
      START_MARKER,
      '[[hooks]]',
      `event = "Stop"`,
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      '[hand.written]',
      'value = "keep"',
      ''
    ].join('\n')
    const { text, changed } = removeManagedKimiHooks(orphan, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe('default_model = "x"\n[hand.written]\nvalue = "keep"\n')
  })

  it('removes only the stray marker when an orphan owns no managed content', () => {
    const orphan = `default_model = "x"\n\n${START_MARKER}\n[user.table]\nvalue = "keep"\n`
    const { text, changed } = removeManagedKimiHooks(orphan, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe('default_model = "x"\n[user.table]\nvalue = "keep"\n')
  })

  it('does not treat a user [[hooks]] table as HiveWard-owned content', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      'command = "node my-own-hook.mjs"',
      'timeout = 10',
      ''
    ].join('\n')
    const { text } = removeManagedKimiHooks(orphan, isManaged)
    expect(text).toContain('command = "node my-own-hook.mjs"')
    expect(text).not.toContain(START_MARKER)
  })

  // Command ownership survives extra user keys; leaving the table would still emit events after uninstall.
  it('owns a managed table the user added an extra key to', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      'matcher = "Bash"',
      ''
    ].join('\n')
    expect(removeManagedKimiHooks(orphan, isManaged).text).toBe('')
  })

  it('owns a customised managed table sitting outside any marker', () => {
    const customised = [
      'default_model = "x"',
      '',
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      'matcher = "Bash"',
      ''
    ].join('\n')
    expect(removeManagedKimiHooks(customised, isManaged).text).toBe('default_model = "x"\n')
    expect(readManagedKimiHookEvents(customised, isManaged)).toEqual(new Set(['Stop']))
    const reinstalled = applyManagedKimiHooks(customised, COMMAND, isManaged)
    expect((reinstalled.match(/event = "Stop"/g) ?? []).length).toBe(1)
  })

  // Extent safety: a multi-line value means the table's end is not knowable by
  // line scanning, so splicing it would take the wrong bytes.
  it('fails closed on a table whose value spans lines', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'args = [',
      '  "a"',
      ']',
      ''
    ].join('\n')
    const { text } = removeManagedKimiHooks(orphan, isManaged)
    expect(text).toContain('args = [')
    expect(text).not.toContain(START_MARKER)
  })

  // Match exact parsed keys, excluding suffixes and comments.
  it('does not read a managed event from key suffixes or commented keys', () => {
    const nearMiss = [
      START_MARKER,
      '[[hooks]]',
      'previous_event = "Stop"',
      `fallback_command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      END_MARKER_LINE,
      '',
      '[[hooks]]',
      '# event = "PreToolUse"',
      `# command = "${COMMAND.replaceAll('"', '')}"`,
      ''
    ].join('\n')
    expect(readManagedKimiHookEvents(nearMiss, isManaged)).toEqual(new Set())
  })

  // TOML gaps do not end tables; removing a partial run would orphan later keys.
  it('fails closed when more keys follow a gap inside the table', () => {
    for (const gap of ['', '# note']) {
      const orphan = [
        START_MARKER,
        '[[hooks]]',
        'event = "Stop"',
        `command = "${COMMAND.replaceAll('"', '')}"`,
        gap,
        'timeout = 10',
        ''
      ].join('\n')
      const { text } = removeManagedKimiHooks(orphan, isManaged)
      expect(text).toContain('timeout = 10')
      expect(text).toContain('[[hooks]]')
      expect(text).not.toContain(START_MARKER)
    }
  })

  it('still owns a table whose keys are followed by a gap and a new table', () => {
    const orphan = [
      START_MARKER,
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      '',
      '# a user comment',
      '',
      '[user.table]',
      'v = 1',
      ''
    ].join('\n')
    const { text } = removeManagedKimiHooks(orphan, isManaged)
    expect(text).not.toContain(START_MARKER)
    expect(text).not.toContain('agent-hooks/kimi-hook.sh')
    expect(text).toContain('# a user comment')
    expect(text).toContain('[user.table]')
  })

  // Command-owned tables with unreadable events must still appear installed or partial.
  it('never reports not_installed for a table remove() would strip', () => {
    for (const eventLine of [`event = 'Stop'`, 'event = "Stop" # note', 'event = 12']) {
      const config = [
        START_MARKER,
        '[[hooks]]',
        eventLine,
        `command = "${COMMAND.replaceAll('"', '')}"`,
        'timeout = 10',
        END_MARKER_LINE,
        ''
      ].join('\n')
      expect(removeManagedKimiHooks(config, isManaged).changed).toBe(true)
      expect(readManagedKimiHookEvents(config, isManaged).size).toBeGreaterThan(0)
    }
    const singleQuoted = [
      START_MARKER,
      '[[hooks]]',
      `event = 'Stop'`,
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10',
      END_MARKER_LINE,
      ''
    ].join('\n')
    expect(readManagedKimiHookEvents(singleQuoted, isManaged)).toEqual(new Set(['Stop']))
  })

  // Reclaim recognized managed tables even when edits strand them outside the marker block.
  it('reclaims managed tables stranded below user text', () => {
    const managedTable = [
      '[[hooks]]',
      'event = "Stop"',
      `command = "${COMMAND.replaceAll('"', '')}"`,
      'timeout = 10'
    ].join('\n')
    const orphan = `${START_MARKER}\n${managedTable}\n[user.table]\nv = 1\n${managedTable}\n`
    const { text } = removeManagedKimiHooks(orphan, isManaged)
    expect(text).toBe('[user.table]\nv = 1\n')
  })

  it('stops an orphaned block at a second start marker', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const duplicated = `${deleteEndMarker(installed)}\n${START_MARKER}\n[user.table]\nv = 1\n`
    const { text, changed } = removeManagedKimiHooks(duplicated, isManaged)
    expect(changed).toBe(true)
    expect(text).toContain('[user.table]')
    expect(text).not.toContain(START_MARKER)
    expect(text).not.toContain('agent-hooks/kimi-hook.sh')
  })

  it('removes both blocks when the markers are duplicated wholesale', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const block = buildManagedKimiHooksBlock(COMMAND)
    const doubled = `${installed}\n${block}\n[user.table]\nv = 1\n`
    const { text, changed } = removeManagedKimiHooks(doubled, isManaged)
    expect(changed).toBe(true)
    expect(text).toBe('default_model = "x"\n[user.table]\nv = 1\n')
  })

  it('leaves a stray start marker after a well-formed block bounded', () => {
    const installed = applyManagedKimiHooks('default_model = "x"\n', COMMAND, isManaged)
    const withStray = `${installed}${START_MARKER}\n[user.table]\nv = 1\n`
    const { text } = removeManagedKimiHooks(withStray, isManaged)
    expect(text).toBe('default_model = "x"\n[user.table]\nv = 1\n')
  })
})

describe('CRLF configs', () => {
  const userConfig = 'default_model = "kimi-k2.6"\r\n'

  it('inserts inline hooks without replacing the empty array or changing CRLF endings', () => {
    const original = `${userConfig}hooks = []\r\n`
    const installed = applyManagedKimiHooks(original, COMMAND, isManaged)
    expect(installed).toContain('hooks = [\r\n')
    expect(installed).toContain('\r\n]\r\n')
    expect(installed).not.toMatch(/[^\r]\n/)
    expect(() => parseToml(installed)).not.toThrow()
    expect(removeManagedKimiHooks(installed, isManaged)).toEqual({
      text: original,
      changed: true
    })
  })

  it('writes the managed block with the file’s existing CRLF endings', () => {
    const installed = applyManagedKimiHooks(userConfig, COMMAND, isManaged)
    expect(installed).not.toMatch(/[^\r]\n/)
    expect(readManagedKimiHookEvents(installed, isManaged)).toEqual(new Set(KIMI_HOOK_EVENTS))
    expect(applyManagedKimiHooks(installed, COMMAND, isManaged)).toBe(installed)
    expect(removeManagedKimiHooks(installed, isManaged)).toEqual({
      text: userConfig,
      changed: true
    })
  })

  it('keeps CRLF user bytes after an orphaned block', () => {
    const installed = applyManagedKimiHooks(userConfig, COMMAND, isManaged)
    const orphaned = `${deleteEndMarker(installed)}\r\n[providers."mine"]\r\napi_key = "sk-secret"\r\n`
    const { text, changed } = removeManagedKimiHooks(orphaned, isManaged)
    expect(changed).toBe(true)
    expect(text).toContain('api_key = "sk-secret"')
    expect(text).not.toContain('agent-hooks/kimi-hook.sh')
    expect(text).not.toMatch(/[^\r]\n/)
  })
})

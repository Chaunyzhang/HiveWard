import { expect, test } from './helpers/hiveward-app'
import { readTerminalImeBoundaryTrace } from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import {
  commitImeText,
  dispatchImeIdleComposingTextKey,
  dispatchImeSubstitutedTextKey,
  dispatchPlainEnter,
  setImeComposition
} from './terminal-ime-cdp-composition'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { applyImePlatformPolicy } from './terminal-ime-platform-policy'

// CDP exercises Linux renderer policy and PTY bytes; it does not simulate native fcitx5/Wayland.
test('Linux direct IME punctuation reaches the PTY before and after composition', async ({
  hivewardPage,
  testRepoPath
}, testInfo) => {
  await applyImePlatformPolicy(hivewardPage, 'linux')
  const arena = await openTerminalImePaneArena(hivewardPage)
  const reader = createTerminalImeByteReader(testRepoPath, 1)
  let completed = false
  try {
    await startTerminalImeByteReader(hivewardPage, arena.ptyId, reader)
    for (const precedingComposition of [false, true]) {
      if (precedingComposition) {
        await setImeComposition(arena.session, 'ni')
        await commitImeText(arena.session, '你')
      }
      for (const [code, glyph] of [
        ['Comma', '，'],
        ['Period', '。']
      ]) {
        await (precedingComposition || code !== 'Comma'
          ? dispatchImeSubstitutedTextKey(
              arena.session,
              { key: 'Process', code, keyCode: 229 },
              glyph
            )
          : dispatchImeIdleComposingTextKey(
              arena.page,
              { key: 'Process', code, keyCode: 229 },
              glyph
            ))
      }
    }
    await dispatchPlainEnter(arena.session)
    expect(await waitForTerminalImeBytes(hivewardPage, reader)).toEqual([
      Buffer.from('，。你，。\n').toString('hex')
    ])
    const trace = await readTerminalImeBoundaryTrace(hivewardPage)
    expect(trace.onData.join('')).toBe('，。你，。\r')
    expect(trace.dom.filter((event) => event.type === 'compositionstart')).toHaveLength(1)
    completed = true
  } finally {
    await closeTerminalImePaneArena(arena, testInfo, 'linux-direct-ime-commit', !completed)
    removeTerminalImeByteReader(reader)
  }
})

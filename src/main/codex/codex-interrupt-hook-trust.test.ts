import { describe, expect, it } from 'vitest'
import { CODEX_EVENT_LABEL } from './codex-hook-definition'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import { parseCodexTrustKey } from './codex-trust-identity'
import { computeTrustedHash, type CodexTrustEntry } from './config-toml-trust'

// Frozen form-1 fixture: codex-cli 0.159.3 hooks/list reported this Interrupt hash with timeout 3.
const HIVEWARD_FORM_1_COMMAND =
  ': hiveward-agent-hook-form=1; if [ -n "${HIVEWARD_PANE_KEY-}" ] && [ -n "${HIVEWARD_AGENT_HOOK_ROOT-}" ] && [ -f "${HIVEWARD_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" ]; then /bin/sh "${HIVEWARD_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" || :; elif [ -z "${HIVEWARD_AGENT_HOOK_ROOT-}" ] && [ -n "${HIVEWARD_PANE_KEY-}" ] && [ -n "${HIVEWARD_AGENT_HOOK_PORT-}" ] && [ -f "${HOME-}/.hiveward/agent-hooks/codex-hook.sh" ]; then /bin/sh "${HOME-}/.hiveward/agent-hooks/codex-hook.sh" || :; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi'
const REAL_INTERRUPT_HASH =
  'sha256:e310040038407326ed45a5bc0794801ac4dd417ea52edccf0712a8c7a7cab5c3'

const INTERRUPT_ENTRY: CodexTrustEntry = {
  sourcePath: '/home/dev/.codex/hooks.json',
  eventLabel: 'interrupt',
  groupIndex: 0,
  handlerIndex: 0,
  command: HIVEWARD_FORM_1_COMMAND,
  timeoutSec: 3
}

describe('the managed Codex Interrupt hook', () => {
  it('uses the trust key label Codex uses', () => {
    expect(CODEX_EVENT_LABEL.Interrupt).toBe('interrupt')
    expect(parseCodexTrustKey('/home/dev/.codex/hooks.json:interrupt:0:0')).toMatchObject({
      eventLabel: 'interrupt'
    })
  })

  it('reproduces the hash real Codex computed for the Interrupt hook', () => {
    expect(computeTrustedHash(INTERRUPT_ENTRY)).toBe(REAL_INTERRUPT_HASH)
  })

  it('hashes the timeout Codex clamps to, so an over-cap entry stays trusted', () => {
    // Codex clamps Interrupt to [1, 3], defaulting to 1, before hashing.
    expect(computeTrustedHash({ ...INTERRUPT_ENTRY, timeoutSec: 10 })).toBe(REAL_INTERRUPT_HASH)
    expect(computeTrustedHash({ ...INTERRUPT_ENTRY, timeoutSec: undefined })).toBe(
      computeTrustedHash({ ...INTERRUPT_ENTRY, timeoutSec: 1 })
    )
    expect(getCodexHookTrustSignature({ ...INTERRUPT_ENTRY, timeoutSec: 10 })).toBe(
      getCodexHookTrustSignature(INTERRUPT_ENTRY)
    )
    expect(computeTrustedHash({ ...INTERRUPT_ENTRY, eventLabel: 'stop', timeoutSec: 10 })).not.toBe(
      computeTrustedHash({ ...INTERRUPT_ENTRY, eventLabel: 'stop', timeoutSec: 3 })
    )
  })

  it('ignores a matcher, as Codex does for Interrupt', () => {
    expect(computeTrustedHash({ ...INTERRUPT_ENTRY, matcher: 'anything' })).toBe(
      REAL_INTERRUPT_HASH
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  isPluginFrameIsolationEnabled,
  PLUGIN_ISOLATED_FRAMES_DEFAULT
} from './plugin-frame-isolation'

describe('isolated frames switch', () => {
  it('defaults on, follows the setting, and lets the env var override either way', () => {
    expect(PLUGIN_ISOLATED_FRAMES_DEFAULT).toBe(true)
    expect(isPluginFrameIsolationEnabled({}, {})).toBe(true)
    expect(isPluginFrameIsolationEnabled({ experimentalPluginIsolatedFrames: false }, {})).toBe(
      false
    )
    expect(
      isPluginFrameIsolationEnabled(
        { experimentalPluginIsolatedFrames: false },
        { HIVEWARD_PLUGIN_ISOLATED_FRAMES: '1' }
      )
    ).toBe(true)
    expect(
      isPluginFrameIsolationEnabled(
        { experimentalPluginIsolatedFrames: true },
        { HIVEWARD_PLUGIN_ISOLATED_FRAMES: '0' }
      )
    ).toBe(false)
    expect(isPluginFrameIsolationEnabled(null, { HIVEWARD_PLUGIN_ISOLATED_FRAMES: 'yes' })).toBe(true)
  })
})

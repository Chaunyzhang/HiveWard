import { describe, expect, it } from 'vitest'
import { mapGhosttyToHiveWard } from './mapper'

describe('mapGhosttyToHiveWard — font & cursor', () => {
  it('maps supported keys to GlobalSettings', () => {
    const result = mapGhosttyToHiveWard({
      'font-family': 'JetBrains Mono',
      'font-size': '14',
      'cursor-style': 'bar'
    })
    expect(result.diff).toEqual({
      terminalFontFamily: 'JetBrains Mono',
      terminalFontSize: 14,
      terminalCursorStyle: 'bar'
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('imports the primary font-family from a repeated fallback list, honoring "" resets', () => {
    const fallbackList = mapGhosttyToHiveWard({ 'font-family': ['Menlo', 'Monaco'] })
    expect(fallbackList.diff).toEqual({ terminalFontFamily: 'Menlo' })
    expect(fallbackList.unsupportedKeys).toEqual(['font-family (fallback fonts not preserved)'])
    expect(mapGhosttyToHiveWard({ 'font-family': ['Fira Code', '', 'Menlo', 'Monaco'] }).diff).toEqual({
      terminalFontFamily: 'Menlo'
    })
    const cleared = mapGhosttyToHiveWard({ 'font-family': ['Fira Code', ''] })
    expect(cleared.diff).toEqual({})
    expect(cleared.unsupportedKeys).toEqual(['font-family'])
  })

  it('skips invalid font-size values', () => {
    const result = mapGhosttyToHiveWard({ 'font-size': 'not-a-number' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['font-size'])
  })

  it('skips invalid cursor-style values', () => {
    const result = mapGhosttyToHiveWard({ 'cursor-style': 'beam' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-style'])
  })

  it('returns zero font-size as unsupported', () => {
    const result = mapGhosttyToHiveWard({ 'font-size': '0' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['font-size'])
  })

  it('maps font-weight to terminalFontWeight', () => {
    const result = mapGhosttyToHiveWard({ 'font-weight': '700' })
    expect(result.diff).toEqual({ terminalFontWeight: 700 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('uses the latest value when a scalar key is repeated', () => {
    const result = mapGhosttyToHiveWard({ 'font-size': ['12', '14'] })
    expect(result.diff).toEqual({ terminalFontSize: 14 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects out-of-range font-weight', () => {
    const result = mapGhosttyToHiveWard({ 'font-weight': '50' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['font-weight'])
  })

  it('maps cursor-style-blink true to terminalCursorBlink', () => {
    const result = mapGhosttyToHiveWard({ 'cursor-style-blink': 'true' })
    expect(result.diff).toEqual({ terminalCursorBlink: true })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps cursor-style-blink false to terminalCursorBlink', () => {
    const result = mapGhosttyToHiveWard({ 'cursor-style-blink': 'false' })
    expect(result.diff).toEqual({ terminalCursorBlink: false })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid cursor-style-blink value', () => {
    const result = mapGhosttyToHiveWard({ 'cursor-style-blink': 'yes' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['cursor-style-blink'])
  })

  it('maps focus-follows-mouse to terminalFocusFollowsMouse', () => {
    const result = mapGhosttyToHiveWard({ 'focus-follows-mouse': 'true' })
    expect(result.diff).toEqual({ terminalFocusFollowsMouse: true })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid focus-follows-mouse value', () => {
    const result = mapGhosttyToHiveWard({ 'focus-follows-mouse': '1' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['focus-follows-mouse'])
  })

  it('maps middle-click-action primary-paste to primary selection paste', () => {
    const result = mapGhosttyToHiveWard({ 'middle-click-action': 'primary-paste' })
    expect(result.diff).toEqual({ primarySelectionMiddleClickPaste: true })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps middle-click-action ignore to disabled primary selection paste', () => {
    const result = mapGhosttyToHiveWard({ 'middle-click-action': 'ignore' })
    expect(result.diff).toEqual({ primarySelectionMiddleClickPaste: false })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid middle-click-action value', () => {
    const result = mapGhosttyToHiveWard({ 'middle-click-action': 'copy' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['middle-click-action'])
  })
})

describe('mapGhosttyToHiveWard — macos-option-as-alt', () => {
  it('maps on to true', () => {
    const result = mapGhosttyToHiveWard({ 'macos-option-as-alt': 'on' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'true' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps true to true', () => {
    const result = mapGhosttyToHiveWard({ 'macos-option-as-alt': 'true' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'true' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps off to false', () => {
    const result = mapGhosttyToHiveWard({ 'macos-option-as-alt': 'off' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'false' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps left to left', () => {
    const result = mapGhosttyToHiveWard({ 'macos-option-as-alt': 'left' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'left' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps right to right', () => {
    const result = mapGhosttyToHiveWard({ 'macos-option-as-alt': 'right' }, true)
    expect(result.diff).toEqual({ terminalMacOptionAsAlt: 'right' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid value', () => {
    const result = mapGhosttyToHiveWard({ 'macos-option-as-alt': 'maybe' }, true)
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['macos-option-as-alt'])
  })

  it('treats as unsupported on non-macOS', () => {
    const result = mapGhosttyToHiveWard({ 'macos-option-as-alt': 'true' }, false)
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['macos-option-as-alt'])
  })
})

describe('mapGhosttyToHiveWard — background & colors', () => {
  it('maps background-opacity to terminalBackgroundOpacity', () => {
    const result = mapGhosttyToHiveWard({ 'background-opacity': '0.72' })
    expect(result.diff).toEqual({ terminalBackgroundOpacity: 0.72 })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('skips out-of-range background-opacity', () => {
    const result = mapGhosttyToHiveWard({ 'background-opacity': '1.5' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['background-opacity'])
  })

  it('skips negative background-opacity', () => {
    const result = mapGhosttyToHiveWard({ 'background-opacity': '-0.1' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['background-opacity'])
  })

  it('maps a nonzero blur radius to the blur window material', () => {
    const result = mapGhosttyToHiveWard({ 'background-blur-radius': '20' })
    expect(result.diff).toEqual({ windowMaterial: 'blur' })
    expect(result.unsupportedKeys).toEqual(['background-blur-radius (radius value not preserved)'])
  })

  it('maps zero blur to the translucent window material without a drop note', () => {
    const result = mapGhosttyToHiveWard({ 'background-blur-radius': '0' })
    expect(result.diff).toEqual({ windowMaterial: 'translucent' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps the current background-blur key, including booleans and macOS glass', () => {
    expect(mapGhosttyToHiveWard({ 'background-blur': 'true' }).diff).toEqual({ windowMaterial: 'blur' })
    expect(mapGhosttyToHiveWard({ 'background-blur': 'false' }).diff).toEqual({
      windowMaterial: 'translucent'
    })
    expect(mapGhosttyToHiveWard({ 'background-blur': 'macos-glass-regular' }).diff).toEqual({
      windowMaterial: 'blur'
    })
  })

  it('rejects invalid background-blur-radius', () => {
    const result = mapGhosttyToHiveWard({ 'background-blur-radius': 'heavy' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['background-blur-radius'])
  })

  it('maps background with hash to terminalColorOverrides.background', () => {
    const result = mapGhosttyToHiveWard({ background: '#111111' })
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#111111' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps background without hash to terminalColorOverrides.background', () => {
    const result = mapGhosttyToHiveWard({ background: '111111' })
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#111111' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps foreground to terminalColorOverrides.foreground', () => {
    const result = mapGhosttyToHiveWard({ foreground: '#eeeeee' })
    expect(result.diff).toEqual({ terminalColorOverrides: { foreground: '#eeeeee' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps foreground without hash to terminalColorOverrides.foreground', () => {
    const result = mapGhosttyToHiveWard({ foreground: 'eeeeee' })
    expect(result.diff).toEqual({ terminalColorOverrides: { foreground: '#eeeeee' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps cursor-color to terminalColorOverrides.cursor', () => {
    const result = mapGhosttyToHiveWard({ 'cursor-color': '#ff00ff' })
    expect(result.diff).toEqual({ terminalColorOverrides: { cursor: '#ff00ff' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps cursor-color without hash to terminalColorOverrides.cursor', () => {
    const result = mapGhosttyToHiveWard({ 'cursor-color': 'ff00ff' })
    expect(result.diff).toEqual({ terminalColorOverrides: { cursor: '#ff00ff' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps selection-background to terminalColorOverrides.selectionBackground', () => {
    const result = mapGhosttyToHiveWard({ 'selection-background': '#333333' })
    expect(result.diff).toEqual({ terminalColorOverrides: { selectionBackground: '#333333' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps selection-background without hash', () => {
    const result = mapGhosttyToHiveWard({ 'selection-background': '333333' })
    expect(result.diff).toEqual({ terminalColorOverrides: { selectionBackground: '#333333' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps selection-foreground to terminalColorOverrides.selectionForeground', () => {
    const result = mapGhosttyToHiveWard({ 'selection-foreground': '#cccccc' })
    expect(result.diff).toEqual({ terminalColorOverrides: { selectionForeground: '#cccccc' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps selection-foreground without hash', () => {
    const result = mapGhosttyToHiveWard({ 'selection-foreground': 'cccccc' })
    expect(result.diff).toEqual({ terminalColorOverrides: { selectionForeground: '#cccccc' } })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('rejects invalid hex color and continues parsing others', () => {
    const result = mapGhosttyToHiveWard({ foreground: '#12ZZ12', background: '#111111' })
    expect(result.diff).toEqual({ terminalColorOverrides: { background: '#111111' } })
    expect(result.unsupportedKeys).toEqual(['foreground'])
  })
})

describe('mapGhosttyToHiveWard — palette', () => {
  it('maps palette array to terminalColorOverrides ANSI fields', () => {
    const result = mapGhosttyToHiveWard({
      palette: ['0=#000000', '1=#ff0000', '3=#ffaa00', '15=#ffffff']
    })
    expect(result.diff).toEqual({
      terminalColorOverrides: {
        black: '#000000',
        red: '#ff0000',
        yellow: '#ffaa00',
        brightWhite: '#ffffff'
      }
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('treats palette with only unknown indices as unsupported', () => {
    const result = mapGhosttyToHiveWard({ palette: ['27=#abcdef'] })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['palette'])
  })

  it('ignores palette entries with invalid hex', () => {
    const result = mapGhosttyToHiveWard({ palette: ['0=#000000', '1=gggggg'] })
    expect(result.diff).toEqual({ terminalColorOverrides: { black: '#000000' } })
    expect(result.unsupportedKeys).toEqual([])
  })
})

describe('mapGhosttyToHiveWard — window & padding', () => {
  // These window-padding variables have no consuming CSS rules, so importing them would be a silent no-op.
  it('marks window-padding-color as unsupported', () => {
    const result = mapGhosttyToHiveWard({ 'window-padding-color': '#202020' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-color'])
  })

  it('marks window-padding-balance as unsupported', () => {
    const result = mapGhosttyToHiveWard({ 'window-padding-balance': 'true' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['window-padding-balance'])
  })
})

describe('mapGhosttyToHiveWard — unsupported keys', () => {
  it('marks unknown keys as unsupported', () => {
    const result = mapGhosttyToHiveWard({ 'unknown-key': 'value' })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['unknown-key'])
  })

  it('handles a mix of supported and unsupported keys', () => {
    const result = mapGhosttyToHiveWard({
      'font-family': 'Fira Code',
      'font-size': '13',
      'background-blur-radius': '20'
    })
    expect(result.diff).toEqual({
      terminalFontFamily: 'Fira Code',
      terminalFontSize: 13,
      windowMaterial: 'blur'
    })
    expect(result.unsupportedKeys).toEqual(['background-blur-radius (radius value not preserved)'])
  })

  it('marks all intentionally unsupported keys', () => {
    const result = mapGhosttyToHiveWard({
      'window-decoration': 'true',
      'window-step-resize': 'true',
      'window-height': '1000',
      'window-width': '1000',
      'gtk-tabs-location': 'top',
      'custom-shader': 'shader.glsl',
      keybind: 'ctrl+a=new_window'
    })
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual([
      'window-decoration',
      'window-step-resize',
      'window-height',
      'window-width',
      'gtk-tabs-location',
      'custom-shader',
      'keybind'
    ])
  })
})

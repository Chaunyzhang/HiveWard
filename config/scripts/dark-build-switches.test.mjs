import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const {
  assertNoDarkOutputOfOffSwitches,
  assertNotDarkBuild,
  darkBuildDefines,
  darkBuildMarkers,
  turnedOnDarkBuildDefines
} = createRequire(import.meta.url)('../dark-build-switches.cjs')

const scratch = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dark build switches', () => {
  it.each(['HIVEWARD_LAYOUT_OWNER', 'HIVEWARD_SIDEBAR_INPUTS'])(
    'compiles the dark path in only when %s=main asks',
    (variable) => {
      expect(darkBuildDefines({ [variable]: 'main' })[variable]).toBe('"main"')
      expect(darkBuildDefines({ [variable]: 'window' })[variable]).toBe('"window"')
      expect(darkBuildDefines({})[variable]).toBe('"window"')
      expect(turnedOnDarkBuildDefines({ [variable]: 'main' })).toEqual({ [variable]: '"main"' })
      expect(turnedOnDarkBuildDefines({})).toEqual({})
    }
  )

  it('keeps the layout-owner marker name packaging already refuses', () => {
    expect(darkBuildMarkers({ HIVEWARD_LAYOUT_OWNER: 'main' })).toEqual([
      {
        fileName: 'HIVEWARD_LAYOUT_OWNER_MAIN',
        text: 'Built with HIVEWARD_LAYOUT_OWNER=main, for dark testing only.\n'
      }
    ])
    expect(darkBuildMarkers({})).toEqual([])
  })

  it.each(['HIVEWARD_LAYOUT_OWNER', 'HIVEWARD_SIDEBAR_INPUTS'])(
    'refuses %s at packaging time, and any output its dark build marked',
    async (variable) => {
      const clean = await mkdtemp(join(tmpdir(), 'hiveward-dark-build-clean-'))
      const dark = await mkdtemp(join(tmpdir(), 'hiveward-dark-build-dark-'))
      scratch.push(clean, dark)
      const [marker] = darkBuildMarkers({ [variable]: 'main' })
      await writeFile(join(dark, marker.fileName), marker.text)

      expect(() => assertNotDarkBuild([clean], {})).not.toThrow()
      expect(() => assertNotDarkBuild([clean], { [variable]: 'main' })).toThrow(`${variable}=main`)
      expect(() => assertNotDarkBuild([clean, dark], {})).toThrow(dark)
    }
  )

  it.each([
    ['HIVEWARD_LAYOUT_OWNER', 'HIVEWARD_SIDEBAR_INPUTS'],
    ['HIVEWARD_SIDEBAR_INPUTS', 'HIVEWARD_LAYOUT_OWNER']
  ])('lets a dark build carry its own %s output, never one of %s', async (own, other) => {
    const dark = await mkdtemp(join(tmpdir(), 'hiveward-dark-build-own-'))
    scratch.push(dark)
    const [marker] = darkBuildMarkers({ [own]: 'main' })
    await writeFile(join(dark, marker.fileName), marker.text)

    expect(() => assertNoDarkOutputOfOffSwitches([dark], { [own]: 'main' })).not.toThrow()
    expect(() => assertNoDarkOutputOfOffSwitches([dark], { [other]: 'main' })).toThrow(dark)
    expect(() => assertNoDarkOutputOfOffSwitches([dark], {})).toThrow(dark)
  })
})

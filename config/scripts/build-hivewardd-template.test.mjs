import { describe, expect, it } from 'vitest'
import { HIVEWARDD_TEMPLATE_TARGETS } from '../../src/shared/node-runtime-pin.ts'
import { assertTemplateBuildAllowed, requestedTemplateTargets } from './build-hivewardd-template.mjs'

describe('requestedTemplateTargets', () => {
  it('builds every target unless a subset is named', () => {
    expect(requestedTemplateTargets(['node', 'build-hivewardd-template.mjs'])).toEqual(
      HIVEWARDD_TEMPLATE_TARGETS
    )
  })

  it('accepts a named subset once each', () => {
    expect(
      requestedTemplateTargets([
        'node',
        'build-hivewardd-template.mjs',
        '--targets',
        'linux-x64-glibc,linux-x64-musl,linux-x64-glibc'
      ])
    ).toEqual(['linux-x64-glibc', 'linux-x64-musl'])
  })

  it.each([[['--targets']], [['--targets', '']], [['--targets', 'linux-x64-glibc,sunos-sparc']]])(
    'refuses %j',
    (args) => {
      expect(() => requestedTemplateTargets(['node', 'build-hivewardd-template.mjs', ...args])).toThrow(
        '--targets needs a comma-separated subset'
      )
    }
  )
})

describe('assertTemplateBuildAllowed', () => {
  const argv = ['node', 'build-hivewardd-template.mjs']
  const dark = { HIVEWARD_LAYOUT_OWNER: 'main' }

  it('refuses a dark switch for a release template', () => {
    expect(() => assertTemplateBuildAllowed(argv, dark)).toThrow('HIVEWARD_LAYOUT_OWNER=main')
  })

  it('lets a dark switch through only for an explicit test template', () => {
    expect(() => assertTemplateBuildAllowed([...argv, '--dark-test-template'], dark)).not.toThrow()
  })

  it('allows a plain template either way', () => {
    expect(() => assertTemplateBuildAllowed(argv, {})).not.toThrow()
    expect(() => assertTemplateBuildAllowed([...argv, '--dark-test-template'], {})).not.toThrow()
  })
})

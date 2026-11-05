import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from './constants'
import {
  NESTED_WORKER_MAX_DEPTH_DEFAULT,
  nestedWorkerDepthExceededMessage,
  resolveNestedWorkerMaxDepth
} from './nested-worker-depth'

describe('resolveNestedWorkerMaxDepth', () => {
  it('HiveWard 未设置时默认允许四层下属', () => {
    expect(resolveNestedWorkerMaxDepth(undefined)).toBe(4)
    expect(resolveNestedWorkerMaxDepth(null)).toBe(4)
    expect(resolveNestedWorkerMaxDepth({})).toBe(4)
  })

  it('HiveWard 新用户的默认设置与运行时一致', () => {
    expect(
      getDefaultPersistedState('/tmp/hiveward-depth-default').settings.nestedWorkerMaxDepth
    ).toBe(4)
  })

  it.each([1, 2, 3, 4, 7])('保留用户明确设置的层级 %s', (depth) => {
    expect(resolveNestedWorkerMaxDepth({ nestedWorkerMaxDepth: depth })).toBe(depth)
  })

  // Malformed settings must fall back to the cap, never disable nesting limits.
  it.each([
    ['a numeric string', '2'],
    ['a boolean', true],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['null', null]
  ])('falls back to the default for %s', (_label, value) => {
    expect(resolveNestedWorkerMaxDepth({ nestedWorkerMaxDepth: value as unknown as number })).toBe(
      NESTED_WORKER_MAX_DEPTH_DEFAULT
    )
  })
})

describe('depth-exceeded message', () => {
  it('names both depths and tells the worker to finish the task itself', () => {
    const message = nestedWorkerDepthExceededMessage(2, 1)
    expect(message).toContain('depth 2 (max 1)')
    expect(message).toContain('Complete this task yourself')
  })
})

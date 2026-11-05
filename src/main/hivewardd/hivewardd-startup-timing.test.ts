import { describe, expect, it } from 'vitest'
import {
  createHivewarddStartupTiming,
  HIVEWARDD_STARTUP_TIMING_ENV,
  HIVEWARDD_STARTUP_TIMING_PREFIX
} from './hivewardd-startup-timing'

function clock(times: number[]): () => number {
  return () => times.shift() ?? Number.NaN
}

describe('createHivewarddStartupTiming', () => {
  it('reports each phase, failed ones included, in one line', async () => {
    const lines: string[] = []
    const timing = createHivewarddStartupTiming(
      { [HIVEWARDD_STARTUP_TIMING_ENV]: '1' },
      clock([100.4, 250.6, 300, 320, 400]),
      (line) => lines.push(line)
    )

    await timing.time('profile', async () => {})
    await expect(
      timing.time('daemon', () => Promise.reject(new Error('spawn failed')))
    ).rejects.toThrow('spawn failed')
    timing.report()

    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith(HIVEWARDD_STARTUP_TIMING_PREFIX)).toBe(true)
    expect(JSON.parse(lines[0].slice(HIVEWARDD_STARTUP_TIMING_PREFIX.length))).toEqual({
      readyMs: 400,
      phases: [
        ['profile', 100, 251],
        ['daemon', 300, 320]
      ]
    })
  })
})

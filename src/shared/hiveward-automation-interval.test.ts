import { expect, it } from 'vitest'
import { isValidAutomationSchedule } from './automation-schedule-parsing'
import {
  nextAutomationOccurrenceAfter,
  latestAutomationOccurrenceAtOrBefore
} from './automation-schedule-occurrences'

it.each([10, 30, 70, 1440])('HiveWard %i 分钟间隔沿用原生起点、下一次与重启补算', (minutes) => {
  const start = Date.UTC(2026, 10, 4, 9, 13, 21)
  const interval = minutes * 60_000
  const rule = `FREQ=MINUTELY;INTERVAL=${minutes}`
  expect(isValidAutomationSchedule(rule)).toBe(true)
  expect(nextAutomationOccurrenceAfter(rule, start, start - 1)).toBe(start)
  expect(nextAutomationOccurrenceAfter(rule, start, start)).toBe(start + interval)
  expect(nextAutomationOccurrenceAfter(rule, start, start + 2 * interval + 5000)).toBe(
    start + 3 * interval
  )
  expect(latestAutomationOccurrenceAtOrBefore(rule, start, start - 1)).toBeNull()
  expect(latestAutomationOccurrenceAtOrBefore(rule, start, start + 2 * interval + 5000)).toBe(
    start + 2 * interval
  )
})

it.each(['0', '9', '1441', 'abc', '1.5'])(
  'HiveWard 分钟 recurrence 拒绝非法间隔 %s',
  (interval) => {
    expect(isValidAutomationSchedule(`FREQ=MINUTELY;INTERVAL=${interval}`)).toBe(false)
  }
)

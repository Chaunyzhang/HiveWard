import { describe, expect, it } from 'vitest'
import {
  classifyWslHivewarddLiveness,
  nextWslLivenessProbe,
  type WslLivenessEvidence
} from './wsl-hivewardd-liveness-verdict'

const INSTANCE = 'boot-a:100'
const HIVEWARDD = '321:5000'

function evidence(overrides: Partial<WslLivenessEvidence> = {}): WslLivenessEvidence {
  return {
    trigger: { source: 'bridge', code: 1 },
    running: { status: 'confirmed', running: true },
    expected: { distroInstance: INSTANCE, hivewardd: HIVEWARDD },
    ...overrides
  }
}

describe('classifyWslHivewarddLiveness', () => {
  it('reads a failed running-list probe as unverifiable, never exited, whatever the exit code', () => {
    for (const code of [0, 1, null]) {
      const verdict = classifyWslHivewarddLiveness(
        evidence({ trigger: { source: 'bridge', code }, running: { status: 'unavailable' } })
      )
      expect(verdict).toEqual({ kind: 'unverifiable', reason: 'running-list-unavailable' })
    }
  })

  it('marks every terminal exited when the distro is confirmed stopped', () => {
    const verdict = classifyWslHivewarddLiveness(
      evidence({ running: { status: 'confirmed', running: false } })
    )
    expect(verdict).toEqual({ kind: 'distro-stopped', corroborated: true })
  })

  it('needs no exit code to prove a stop, but only a failed exit corroborates it', () => {
    const stopped = { status: 'confirmed', running: false } as const
    expect(
      classifyWslHivewarddLiveness(evidence({ trigger: { source: 'verify' }, running: stopped }))
    ).toEqual({ kind: 'distro-stopped', corroborated: false })
    expect(
      classifyWslHivewarddLiveness(
        evidence({ trigger: { source: 'holder', code: 0 }, running: stopped })
      )
    ).toEqual({ kind: 'distro-stopped', corroborated: false })
  })

  it('treats a running distro whose guest did not answer as unverifiable', () => {
    expect(classifyWslHivewarddLiveness(evidence({ identity: null }))).toEqual({
      kind: 'unverifiable',
      reason: 'guest-unanswered'
    })
  })

  it('proves a restart from a new boot id or pid 1 start time, without any wall clock', () => {
    const verdict = classifyWslHivewarddLiveness(
      evidence({ identity: { distroInstance: 'boot-a:900', hivewardd: null } })
    )
    expect(verdict).toEqual({ kind: 'distro-restarted' })
  })

  it('reads a gone or reused hivewardd pid in the same incarnation as hivewardd exited', () => {
    for (const hivewardd of [null, '321:7777']) {
      const verdict = classifyWslHivewarddLiveness(
        evidence({
          trigger: { source: 'bridge', code: 0 },
          identity: { distroInstance: INSTANCE, hivewardd }
        })
      )
      expect(verdict).toEqual({ kind: 'hivewardd-exited' })
    }
  })

  it('keeps hivewardd live when the same process still runs, even after a bridge exit', () => {
    expect(
      classifyWslHivewarddLiveness(
        evidence({
          trigger: { source: 'bridge', code: 0 },
          identity: { distroInstance: INSTANCE, hivewardd: HIVEWARDD }
        })
      )
    ).toEqual({ kind: 'live' })
  })

  it('falls back to the port when no hivewardd pid was known', () => {
    const base = evidence({
      expected: { distroInstance: INSTANCE, hivewardd: null },
      identity: { distroInstance: INSTANCE, hivewardd: null }
    })
    expect(classifyWslHivewarddLiveness({ ...base, hivewarddPort: 'ready' })).toEqual({ kind: 'live' })
    expect(classifyWslHivewarddLiveness({ ...base, hivewarddPort: 'refused' })).toEqual({
      kind: 'hivewardd-exited'
    })
    expect(classifyWslHivewarddLiveness({ ...base, hivewarddPort: 'unverifiable' })).toEqual({
      kind: 'unverifiable',
      reason: 'hivewardd-unanswered'
    })
  })
})

describe('nextWslLivenessProbe', () => {
  it('never probes inside a distro that is not confirmed running (an exec would boot it)', () => {
    expect(nextWslLivenessProbe(evidence({ running: { status: 'unavailable' } }))).toBeNull()
    expect(
      nextWslLivenessProbe(evidence({ running: { status: 'confirmed', running: false } }))
    ).toBeNull()
  })

  it('asks for identity first, and for the port only when no pid identity can decide', () => {
    expect(nextWslLivenessProbe(evidence())).toBe('identity')
    expect(
      nextWslLivenessProbe(evidence({ identity: { distroInstance: INSTANCE, hivewardd: HIVEWARDD } }))
    ).toBeNull()
    const noPid = evidence({
      expected: { distroInstance: INSTANCE, hivewardd: null },
      identity: { distroInstance: INSTANCE, hivewardd: null }
    })
    expect(nextWslLivenessProbe(noPid)).toBe('hivewardd-port')
    expect(nextWslLivenessProbe({ ...noPid, hivewarddPort: 'refused' })).toBeNull()
    expect(
      nextWslLivenessProbe({ ...noPid, identity: { distroInstance: 'other', hivewardd: null } })
    ).toBeNull()
  })
})

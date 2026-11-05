import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runWslProcess } from './wsl-runner'
import { invalidateWslGuestEnvironment } from './wsl-guest-environment'
import { runProcess } from '@hiveward/process-host'
import { resolveWslExecutablePath } from './wsl-executable-path'

/** Real distro/login/rc contract, gated on Windows and HIVEWARD_REAL_WSL_RUNNER_TEST because it mutates ~/.profile. Run: HIVEWARD_REAL_WSL_RUNNER_TEST=1 pnpm vitest run src/main/wsl/wsl-runner.wsl.test.ts */
const DISTRO = process.env.HIVEWARD_WSL_TEST_DISTRO ?? 'Ubuntu-24.04'
const enabled = process.platform === 'win32' && process.env.HIVEWARD_REAL_WSL_RUNNER_TEST === '1'
const describeOnWsl = enabled ? describe : describe.skip

const PROFILE = '/tmp/hiveward-wsl-runner-profile.bak'

async function guest(script: string): Promise<string> {
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: ['-d', DISTRO, '--exec', 'sh', '-c', script],
    timeoutMs: 30_000
  })
  return result.stdout.trim()
}

describeOnWsl('runWslProcess against a real distro', () => {
  beforeAll(async () => {
    // Save the profile, then reproduce #14288 with a real blocking login.
    await guest(`cp -f "$HOME/.profile" ${PROFILE} 2>/dev/null || true`)
    await guest(`printf '\\nsleep 60\\n' >> "$HOME/.profile"`)
    invalidateWslGuestEnvironment(undefined, true)
  }, 120_000)

  afterAll(async () => {
    await guest(`cp -f ${PROFILE} "$HOME/.profile" 2>/dev/null || rm -f "$HOME/.profile"`)
    await guest(`rm -f ${PROFILE}`)
    invalidateWslGuestEnvironment(undefined, true)
  }, 120_000)

  it('probe lane survives a ~/.profile that blocks for a minute', async () => {
    // Probe failure must remain nonfatal and the call must finish within its budget despite the 60s profile block.
    const started = Date.now()
    const result = await runWslProcess({
      loginPath: 'preferred',
      distro: DISTRO,
      program: '/bin/echo',
      args: ['hiveward-probe-ok'],
      timeoutMs: 15_000
    })
    const elapsed = Date.now() - started
    expect(result.stdout.trim()).toContain('hiveward-probe-ok')
    expect(elapsed).toBeLessThan(20_000)
  }, 60_000)

  it('second probe-lane call does not pay the login shell again', async () => {
    const started = Date.now()
    await runWslProcess({
      loginPath: 'preferred',
      distro: DISTRO,
      program: '/bin/true',
      timeoutMs: 15_000
    })
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 30_000)

  it('interactive lane strips the distro banner from parsed stdout', async () => {
    // Fence stock Ubuntu rc hints out of stdout before parsing (#11327/#11823).
    const result = await runWslProcess({
      loginPath: 'preferred',
      distro: DISTRO,
      program: '/bin/echo',
      args: ['HIVEWARD_PAYLOAD'],
      timeoutMs: 60_000
    })
    expect(result.stdout.trim()).toBe('HIVEWARD_PAYLOAD')
  }, 90_000)

  it('a script with quotes and $ arrives byte-identical', async () => {
    // Preserve $2 and embedded quotes; -- expansion/base64-eval wrappers broke both (#12964/#14292).
    const script = [
      `printf '%s\\n' "$1"`,
      `echo 'it'\\''s fine'`,
      `echo "x" | awk '{print $1}'`
    ].join('\n')
    const result = await runWslProcess({
      loginPath: 'preferred',
      distro: DISTRO,
      script,
      args: ['HIVEWARD_ARG'],
      timeoutMs: 30_000
    })
    expect(
      result.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    ).toEqual(['HIVEWARD_ARG', "it's fine", 'x'])
  }, 60_000)

  it('propagated env crosses the boundary via WSLENV', async () => {
    const result = await runWslProcess({
      loginPath: 'preferred',
      distro: DISTRO,
      script: 'printf %s "$HIVEWARD_WSLENV_PROBE"',
      env: { HIVEWARD_WSLENV_PROBE: 'crossed' },
      timeoutMs: 30_000
    })
    expect(result.stdout.trim()).toBe('crossed')
  }, 60_000)

  it('runs in the requested guest cwd', async () => {
    const result = await runWslProcess({
      loginPath: 'preferred',
      distro: DISTRO,
      program: '/bin/pwd',
      cwd: '/tmp',
      timeoutMs: 30_000
    })
    expect(result.stdout.trim()).toBe('/tmp')
  }, 60_000)
})

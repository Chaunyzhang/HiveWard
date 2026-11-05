import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import type { HivewarddMachineHomeProbe } from './hivewardd-machine-home'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Local shell commands run with per-machine hostname and hardware identity shims.
const shell = vi.hoisted((): { env: NodeJS.ProcessEnv | undefined } => ({
  env: undefined
}))
vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => {
  const { runProcess } = await import('@hiveward/process-host')
  return {
    ...(await importOriginal<typeof ExecCommandModule>()),
    execCommand: async (conn: { env?: NodeJS.ProcessEnv }, command: string) => {
      const env = conn.env ?? shell.env
      const merged = env?.HIVEWARD_TEST_MERGE_STDERR === '1'
      const result = await runProcess({
        program: '/bin/sh',
        args: ['-c', merged ? `{ ${command}\n} 2>&1` : command],
        env
      })
      if (result.code !== 0) {
        const { sshCommandExitError } = await import('../../ssh/remote-exec/remote-exec-command')
        throw sshCommandExitError(command, result.code ?? 1, result.stdout)
      }
      return result.stdout
    }
  }
})

const { resolveHivewarddMachineHome } = await import('../install/hivewardd-remote-context')
const {
  decideHivewarddMachineHome,
  hivewarddMachineIdentity,
  hivewarddMachineOwnershipUnresolvedMessage,
  parseHivewarddMachineHomeProbe,
  HIVEWARDD_MACHINE_CLAIM_FILENAME,
  HIVEWARDD_MACHINE_HOMES_DIRNAME
} = await import('./hivewardd-machine-home')
const { HIVEWARDD_MACHINE_CLAIM_ARBITER_DIRNAME } = await import('./hivewardd-machine-claim-command')
const { computeRemoteInstallDir } = await import('../install/remote-versioned-install')
const { HIVEWARDD_INSTALL_MODEL } = await import('../install/remote-install-model')
const { hivewarddLivenessProbeCommand } = await import('../install/hivewardd-remote-launch')
const { HIVEWARDD_PID_FILENAME } = await import('../install/hivewardd-remote-host-support')
const { execHivewarddRemote } = await import('../install/hivewardd-remote-runtime-control')
const { getRemoteHostPlatform } = await import('../../ssh/ssh-remote-platform')
type Probe = HivewarddMachineHomeProbe
type Host = RemoteHostPlatform

const linux = getRemoteHostPlatform('linux-x64')
const darwin = getRemoteHostPlatform('darwin-arm64')
const POSIX = process.platform !== 'win32'

let scratch: string
let home: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hivewardd-machine-home-'))
  home = join(scratch, 'shared-home')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function uuidOf(name: string): string {
  const hex = Buffer.from(name.padEnd(16, '-')).toString('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function ioregOutput(name: string): string {
  return `+-o J316sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "${uuidOf(name).toUpperCase()}"\n`
}

type MachineOptions = {
  noHardLinks?: boolean
  /** Barrier both claim writers, then delay this machine's publication. */
  claimWriteDelay?: number
  /** Simulated df source distinguishes shared exports from local disks. */
  homeSource?: string
  availableKb?: number
  claimMoveError?: string
  /** Simulate stderr merged into stdout by an SSH gateway. */
  catStderrNoise?: string
  machineName?: string
}

/** Model macOS machines sharing one NFS home. */
function machine(name: string, hostname = name, options: MachineOptions = {}) {
  const bin = join(scratch, `bin-${name}-${hostname}`)
  mkdirSync(bin, { recursive: true })
  const tool = (tool: string, script: string): void => {
    writeFileSync(join(bin, tool), `#!/bin/sh\n${script}\n`)
    chmodSync(join(bin, tool), 0o755)
  }
  tool('uname', `echo ${hostname}`)
  tool('ioreg', `printf '%s' '${ioregOutput(name)}'`)
  // macOS has no kern.hostuuid OID; probe must use ioreg.
  tool('sysctl', `echo "sysctl: unknown oid '$2'" >&2; exit 1`)
  if (options.homeSource !== undefined || options.availableKb !== undefined) {
    tool(
      'df',
      `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n%s 100 1 ${options.availableKb ?? 99} 1%% /home\\n' '${options.homeSource ?? '/dev/disk3s5'}'`
    )
  }
  if (options.claimMoveError !== undefined) {
    tool(
      'mv',
      [
        'for last; do :; done',
        `case "$last" in */${HIVEWARDD_MACHINE_CLAIM_FILENAME}) echo "mv: ${options.claimMoveError}" >&2; exit 1;; esac`,
        'exec /bin/mv "$@"'
      ].join('\n')
    )
  }
  if (options.noHardLinks) {
    tool('ln', 'echo "ln: Operation not supported" >&2; exit 1')
  }
  if (options.claimWriteDelay !== undefined) {
    const barrier = join(scratch, 'claim-write-barrier')
    mkdirSync(barrier, { recursive: true })
    tool(
      'mv',
      [
        'for last; do :; done',
        `case "$last" in */${HIVEWARDD_MACHINE_CLAIM_FILENAME})`,
        `  : > '${barrier}/'$$; i=0`,
        `  while [ "$(ls '${barrier}' | wc -l)" -lt 2 ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i + 1)); done`,
        `  sleep ${options.claimWriteDelay};;`,
        'esac',
        'exec /bin/mv "$@"'
      ].join('\n')
    )
  }
  if (options.catStderrNoise !== undefined) {
    // Inject noise around the claim, which ends without a newline.
    tool(
      'cat',
      `echo '${options.catStderrNoise}' >&2; /bin/cat "$@"; s=$?; printf '%s' '${options.catStderrNoise}' >&2; exit $s`
    )
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HIVEWARD_TEST_MERGE_STDERR: options.catStderrNoise === undefined ? '0' : '1',
    HIVEWARD_MACHINE_NAME: options.machineName ?? ''
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked execCommand reads only env.
  const conn = {
    env
  } as unknown as HivewarddHostTransport
  return { conn, host: darwin, env }
}

function loginHomeResult() {
  return { loginHome: home, hivewarddHome: home, userDataDir: join(home, '.hiveward') }
}

function claimPath(): string {
  return join(home, '.hiveward-remote', HIVEWARDD_MACHINE_CLAIM_FILENAME)
}

function legacyOwner(name: string, machineIdentity: string | null = uuidOf(name)): void {
  const dir = join(home, '.hiveward', '.profile-state-access', 'participants', 'token')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'token.owner'),
    JSON.stringify({
      token: 'token',
      pid: 4242,
      host: name,
      platform: 'darwin',
      ...(machineIdentity === null ? {} : { machineIdentity })
    })
  )
}

describe.runIf(POSIX)('resolveHivewarddMachineHome on a home several machines share', () => {
  it('gives the first machine the login home and every other machine its own', async () => {
    const a = machine('node-a')
    const b = machine('node-b')

    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
    const bHome = await resolveHivewarddMachineHome(b, true)
    expect(bHome.loginHome).toBe(home)
    expect(bHome.hivewarddHome).toMatch(
      new RegExp(`^${home}/\\.hiveward-remote/${HIVEWARDD_MACHINE_HOMES_DIRNAME}/[a-f0-9]{16}$`)
    )
    expect(statSync(bHome.hivewarddHome).mode & 0o777).toBe(0o700)
    // A shallow sibling path keeps runtime sockets within Unix length limits.
    expect(bHome.userDataDir).toMatch(new RegExp(`^${home}/\\.hiveward-[a-f0-9]{8}$`))

    expect(await resolveHivewarddMachineHome(b, true)).toEqual(bHome)
    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
    expect(
      computeRemoteInstallDir(HIVEWARDD_INSTALL_MODEL, bHome.hivewarddHome, '0.1.0+abc').startsWith(
        `${bHome.hivewarddHome}/.hiveward-remote/`
      )
    ).toBe(true)
  })

  it('never judges another machine’s PID: the second machine probes only its own slot', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    await resolveHivewarddMachineHome(a, true)
    // Node-a's PID is not evidence about a process on node-b.
    const aSlot = computeRemoteInstallDir(HIVEWARDD_INSTALL_MODEL, home, '0.1.0+abc')
    mkdirSync(aSlot, { recursive: true })
    writeFileSync(join(aSlot, HIVEWARDD_PID_FILENAME), '999999\n')

    const { hivewarddHome } = await resolveHivewarddMachineHome(b, true)
    const bSlot = computeRemoteInstallDir(HIVEWARDD_INSTALL_MODEL, hivewarddHome, '0.1.0+abc')
    expect(bSlot).not.toBe(aSlot)
    const answer = await execHivewarddRemote(b, hivewarddLivenessProbeCommand(darwin, bSlot))
    expect(answer.trim()).toBe('NEVER_LAUNCHED')
    expect(readFileSync(join(aSlot, HIVEWARDD_PID_FILENAME), 'utf8')).toBe('999999\n')
  })

  it('upgrades an existing single-machine install in place', async () => {
    const a = machine('node-a')
    mkdirSync(join(home, '.hiveward-remote', 'hivewardd-0.1.0+abc'), {
      recursive: true
    })
    writeFileSync(join(home, '.hiveward-remote', 'hivewardd-active.json'), '{"schemaVersion":1}')
    mkdirSync(join(home, '.hiveward', 'profiles'), { recursive: true })
    legacyOwner('node-a')

    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
    expect(existsSync(claimPath())).toBe(true)
    expect(readFileSync(join(home, '.hiveward-remote', 'hivewardd-active.json'), 'utf8')).toBe(
      '{"schemaVersion":1}'
    )
    expect(existsSync(join(home, '.hiveward-remote', HIVEWARDD_MACHINE_HOMES_DIRNAME))).toBe(false)
  })

  it('leaves an unclaimed install to the machine whose hivewardd holds its data root', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    legacyOwner('node-a')

    const bHome = await resolveHivewarddMachineHome(b, true)
    expect(bHome.hivewarddHome).not.toBe(home)
    expect(existsSync(claimPath())).toBe(false)

    // Node-a exits; node-b must retain its own home instead of adopting that install.
    rmSync(join(home, '.hiveward'), { recursive: true })
    expect(await resolveHivewarddMachineHome(b, true)).toEqual(bHome)
    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('lets exactly one of two machines claiming at once win', async () => {
    const a = machine('node-a')
    const b = machine('node-b')
    const homes = await Promise.all([
      resolveHivewarddMachineHome(a, true),
      resolveHivewarddMachineHome(b, true)
    ])
    expect(homes.filter((resolved) => resolved.hivewarddHome === home)).toHaveLength(1)
    expect(readdirNames(join(home, '.hiveward-remote'))).toEqual(
      [HIVEWARDD_MACHINE_CLAIM_FILENAME, HIVEWARDD_MACHINE_HOMES_DIRNAME].sort()
    )
  })

  it('keeps a Mac whose hivewardd predates macOS machine identity on its running install', async () => {
    const a = machine('node-a')
    mkdirSync(join(home, '.hiveward-remote', 'hivewardd-0.1.0+abc'), { recursive: true })
    // Legacy macOS ownership may omit machine identity.
    legacyOwner('node-a', null)
    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('never lets another Mac claim a live install whose owner recorded no machine identity', async () => {
    const nfs = { homeSource: 'filer:/export/home' }
    const b = machine('node-b', 'node-b', nfs)
    mkdirSync(join(home, '.hiveward-remote', 'hivewardd-0.1.0+abc'), { recursive: true })
    writeFileSync(join(home, '.hiveward-remote', 'hivewardd-active.json'), '{"schemaVersion":1}')
    // Legacy owner proves hostname only, not machine UUID.
    legacyOwner('node-a', null)

    await expect(resolveHivewarddMachineHome(b, true)).rejects.toThrow(
      /recorded only a hostname[\s\S]*If node-b set it up/
    )
    expect(existsSync(claimPath())).toBe(false)
    // macOS hostname drift cannot establish that a legacy owner belongs to this machine.
    await expect(
      resolveHivewarddMachineHome(machine('node-a', 'cafe-wifi', nfs), true)
    ).rejects.toThrow(/recorded only a hostname/)
    expect(await resolveHivewarddMachineHome(machine('node-a', 'node-a', nfs), true)).toEqual(
      loginHomeResult()
    )
  })

  it('lets exactly one machine claim a home on a filesystem without hard links', async () => {
    const a = machine('node-a', 'node-a', { noHardLinks: true, claimWriteDelay: 0 })
    const b = machine('node-b', 'node-b', { noHardLinks: true, claimWriteDelay: 0.5 })
    const homes = await Promise.all([
      resolveHivewarddMachineHome(a, true),
      resolveHivewarddMachineHome(b, true)
    ])
    expect(homes.filter((resolved) => resolved.hivewarddHome === home)).toHaveLength(1)
    expect(readdirNames(join(home, '.hiveward-remote'))).toEqual(
      [
        HIVEWARDD_MACHINE_CLAIM_ARBITER_DIRNAME,
        HIVEWARDD_MACHINE_CLAIM_FILENAME,
        HIVEWARDD_MACHINE_HOMES_DIRNAME
      ].sort()
    )
    expect(readdirNames(join(home, '.hiveward-remote', HIVEWARDD_MACHINE_CLAIM_ARBITER_DIRNAME))).toEqual([
      HIVEWARDD_MACHINE_CLAIM_FILENAME
    ])
    expect(
      await Promise.all([resolveHivewarddMachineHome(a, true), resolveHivewarddMachineHome(b, true)])
    ).toEqual(homes)
  })

  it('lets exactly one of two machines replace an empty claim', async () => {
    mkdirSync(join(home, '.hiveward-remote'))
    writeFileSync(claimPath(), '')
    const homes = await Promise.all([
      resolveHivewarddMachineHome(machine('node-a', 'node-a', { claimWriteDelay: 0 }), true),
      resolveHivewarddMachineHome(machine('node-b', 'node-b', { claimWriteDelay: 0.5 }), true)
    ])
    expect(homes.filter((resolved) => resolved.hivewarddHome === home)).toHaveLength(1)
  })

  it('restores an emptied claim to the machine the arbiter already chose', async () => {
    const a = machine('node-a', 'node-a', { noHardLinks: true })
    const b = machine('node-b', 'node-b', { noHardLinks: true })
    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
    writeFileSync(claimPath(), '')
    expect((await resolveHivewarddMachineHome(b, true)).hivewarddHome).not.toBe(home)
    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('gives a machine named in its environment its own home, even a clone of the claimer (#32918)', async () => {
    // Clones copy their machine identity; only an explicit name separates them.
    expect(await resolveHivewarddMachineHome(machine('node-a', 'dev-a'), true)).toEqual(
      loginHomeResult()
    )
    expect(await resolveHivewarddMachineHome(machine('node-a', 'dev-b'), true)).toEqual(
      loginHomeResult()
    )
    const named = machine('node-a', 'dev-b', { machineName: 'dev-b' })
    const namedHome = await resolveHivewarddMachineHome(named, true)
    expect(namedHome.userDataDir).toMatch(new RegExp(`^${home}/\\.hiveward-[a-f0-9]{8}$`))
    expect(await resolveHivewarddMachineHome(named, true)).toEqual(namedHome)
    const other = machine('node-a', 'dev-c', { machineName: 'dev-c' })
    expect((await resolveHivewarddMachineHome(other, true)).userDataDir).not.toBe(namedHome.userDataDir)
  })

  it('refuses a machine name it cannot use instead of ignoring it', async () => {
    await expect(
      resolveHivewarddMachineHome(machine('node-a', 'dev-a', { machineName: 'dev a!' }), true)
    ).rejects.toThrow(/HIVEWARD_MACHINE_NAME is set to "dev a!"/)
    await expect(
      resolveHivewarddMachineHome(machine('node-a', 'dev-a', { machineName: 'dev\nb' }), true)
    ).rejects.toThrow(/HIVEWARD_MACHINE_NAME is set to "dev b"/)
    await expect(
      resolveHivewarddMachineHome(machine('node-a', 'dev-a', { machineName: '   ' }), true)
    ).rejects.toThrow(/HIVEWARD_MACHINE_NAME is set to " {3}"/)
  })

  it('keeps a renamed machine on its own install', async () => {
    expect(await resolveHivewarddMachineHome(machine('node-a'), true)).toEqual(loginHomeResult())
    expect(await resolveHivewarddMachineHome(machine('node-a', 'renamed'), true)).toEqual(
      loginHomeResult()
    )
  })

  it('replaces an empty claim a full disk left behind', async () => {
    mkdirSync(join(home, '.hiveward-remote'))
    writeFileSync(claimPath(), '')
    expect(await resolveHivewarddMachineHome(machine('node-a'), true)).toEqual(loginHomeResult())
    expect(readFileSync(claimPath(), 'utf8')).toContain('machineKey')
  })

  it.skipIf(process.getuid?.() === 0)(
    'says why it could not write the claim, and leaves no partial behind (#30491)',
    async () => {
      const remote = mkdirp(home, '.hiveward-remote')
      chmodSync(remote, 0o500)
      try {
        await expect(resolveHivewarddMachineHome(machine('node-a'), true)).rejects.toThrow(
          /^hivewardd could not claim this host's \.hiveward-remote: could not write a claim file in ~\/\.hiveward-remote: .*Permission denied.*belongs to this user and is writable/u
        )
        expect(readdirSync(remote)).toEqual([])
      } finally {
        chmodSync(remote, 0o700)
      }
    }
  )

  it('reads the claim through a gateway that merges shell noise into the answer (#30491)', async () => {
    const noisy = { catStderrNoise: 'bash: warning: setlocale: LC_ALL: cannot change locale' }
    expect(await resolveHivewarddMachineHome(machine('node-a', 'node-a', noisy), true)).toEqual(
      loginHomeResult()
    )
    expect(
      (await resolveHivewarddMachineHome(machine('node-b', 'node-b', noisy), true)).hivewarddHome
    ).not.toBe(home)
  })

  it('names a full disk when the claim cannot be moved into place (#30491)', async () => {
    const full = { noHardLinks: true, availableKb: 0, claimMoveError: 'No space left on device' }
    await expect(resolveHivewarddMachineHome(machine('node-a', 'node-a', full), true)).rejects.toThrow(
      /could not move the claim into place at ~\/\.hiveward-remote\/hivewardd-machine\.json: mv: No space left on device\. The filesystem holding ~\/\.hiveward-remote has 0 KB free/u
    )
    expect(existsSync(claimPath())).toBe(false)
    expect(await resolveHivewarddMachineHome(machine('node-a', 'node-a-freed'), true)).toEqual(
      loginHomeResult()
    )
  })

  it('refuses to guess when the claim cannot be read', async () => {
    mkdirSync(join(home, '.hiveward-remote'))
    writeFileSync(claimPath(), 'not json')
    await expect(resolveHivewarddMachineHome(machine('node-a'), true)).rejects.toThrow(
      /cannot tell which machine owns/
    )
  })

  it('names no owner for a stopped pre-claim install on a shared home until the user does', async () => {
    const nfs = { homeSource: 'filer:/export/home' }
    const a = machine('node-a', 'node-a', nfs)
    const b = machine('node-b', 'node-b', nfs)
    // Clean shutdown removed the data-root owner but left an unattributed prior activation.
    writeFileSync(join(mkdirp(home, '.hiveward-remote'), 'hivewardd-active.json'), '{"schemaVersion":1}')
    mkdirp(home, '.hiveward', '.profile-state-access', 'participants')

    await expect(resolveHivewarddMachineHome(b, true)).rejects.toThrow(/can't tell which machine/)
    expect(existsSync(claimPath())).toBe(false)
    expect(existsSync(join(home, '.hiveward-remote', HIVEWARDD_MACHINE_HOMES_DIRNAME))).toBe(false)

    const message = await resolveHivewarddMachineHome(a, true).then(
      () => '',
      (error: unknown) => String(error)
    )
    expect(message).toContain('If node-a set it up')
    await execHivewarddRemote(a, message.slice(message.indexOf('reconnect: ') + 'reconnect: '.length))
    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
    expect((await resolveHivewarddMachineHome(b, true)).hivewarddHome).not.toBe(home)
  })

  it('claims a shared home whose data root no hivewardd ever activated, and its fix runs anywhere', async () => {
    const a = machine('node-a', 'node-a', { homeSource: 'filer:/export/home' })
    // Profile use by a CLI need not imply any managed server install.
    mkdirp(home, '.hiveward', '.profile-state-access', 'participants')
    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())

    // Ownership repair must also work before ~/.hiveward-remote exists.
    rmSync(join(home, '.hiveward-remote'), { recursive: true })
    const fix = hivewarddMachineOwnershipUnresolvedMessage('a'.repeat(16), null)
    await execHivewarddRemote(a, fix.slice(fix.indexOf('reconnect: ') + 'reconnect: '.length))
    expect(readFileSync(claimPath(), 'utf8')).toContain('a'.repeat(16))
  })

  it('claims a stopped pre-claim install on a local disk, which no other machine can share', async () => {
    const a = machine('node-a', 'node-a', { homeSource: '/dev/disk3s5' })
    writeFileSync(join(mkdirp(home, '.hiveward-remote'), 'hivewardd-active.json'), '{"schemaVersion":1}')
    expect(await resolveHivewarddMachineHome(a, true)).toEqual(loginHomeResult())
  })

  it('keeps WSL on the login home without probing or claiming', async () => {
    expect(await resolveHivewarddMachineHome(machine('node-a'), false)).toEqual(loginHomeResult())
    expect(existsSync(join(home, '.hiveward-remote'))).toBe(false)
  })
})

function mkdirp(...parts: string[]): string {
  const dir = join(...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort()
}

function probe(host: Host, overrides: Partial<Probe> = {}): Probe {
  return {
    loginHome: '/home/u',
    identity: hivewarddMachineIdentity(host, 'a'.repeat(32), 'node-a'),
    claim: { state: 'absent' },
    dataRootOwners: [],
    machineHomeKeys: [],
    loginHomeInstalled: false,
    homeOnLocalDisk: false,
    machineName: null,
    ...overrides
  }
}

describe('decideHivewarddMachineHome', () => {
  it('keys Linux by machine-id alone, so a rename keeps the key', () => {
    const a = hivewarddMachineIdentity(linux, 'a'.repeat(32), 'node-a')
    expect(a?.key).toMatch(/^[a-f0-9]{16}$/)
    expect(hivewarddMachineIdentity(linux, 'a'.repeat(32), 'renamed')?.key).toBe(a?.key)
    expect(hivewarddMachineIdentity(linux, 'b'.repeat(32), 'node-a')?.key).not.toBe(a?.key)
    // Missing/invalid machine identity preserves the legacy login-home fallback.
    expect(hivewarddMachineIdentity(linux, '', 'node-a')).toBeNull()
    expect(hivewarddMachineIdentity(linux, '0'.repeat(32), 'node-a')).toBeNull()
  })

  it('keys macOS by hardware UUID alone, since its hostname follows the network', () => {
    const uuid = '12345678-1234-1234-1234-123456789ABC'
    const ioreg = `    "IOPlatformUUID" = "${uuid}"`
    expect(hivewarddMachineIdentity(darwin, ioreg, 'cafe-wifi')?.key).toBe(
      hivewarddMachineIdentity(darwin, ioreg, 'home-wifi')?.key
    )
    expect(hivewarddMachineIdentity(darwin, ioreg, 'cafe-wifi')?.machineIdentity).toBe(
      uuid.toLowerCase()
    )
    // Empty legacy macOS sysctl output is not machine identity.
    expect(hivewarddMachineIdentity(darwin, '', 'cafe-wifi')).toBeNull()
    const renamed = probe(darwin, {
      identity: hivewarddMachineIdentity(darwin, ioreg, 'cafe-wifi'),
      dataRootOwners: [{ host: 'home-wifi', machineIdentity: uuid.toLowerCase() }]
    })
    expect(decideHivewarddMachineHome(renamed, darwin).kind).toBe('claim')
  })

  it('judges a data-root owner by machine-id, and by hostname only when it recorded none', () => {
    const other = probe(linux, {
      dataRootOwners: [{ host: 'node-a', machineIdentity: 'b'.repeat(32) }]
    })
    expect(decideHivewarddMachineHome(other, linux).kind).toBe('machine-home')
    const renamed = probe(linux, {
      dataRootOwners: [{ host: 'old-name', machineIdentity: 'a'.repeat(32) }]
    })
    expect(decideHivewarddMachineHome(renamed, linux).kind).toBe('claim')
    const unrecorded = probe(linux, {
      dataRootOwners: [{ host: 'node-b', machineIdentity: null }]
    })
    expect(decideHivewarddMachineHome(unrecorded, linux).kind).toBe('machine-home')
  })

  it('claims no install whose owner names neither its machine nor a matching hostname', () => {
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const mac = hivewarddMachineIdentity(darwin, `"IOPlatformUUID" = "${uuid}"`, 'mac-b')
    const otherMac = { host: 'mac-a', machineIdentity: null }
    expect(
      decideHivewarddMachineHome(probe(darwin, { identity: mac, dataRootOwners: [otherMac] }), darwin)
    ).toEqual({ kind: 'unresolved', machineKey: mac?.key, cause: 'unattributed-owner' })
    expect(
      decideHivewarddMachineHome(
        probe(darwin, { identity: mac, dataRootOwners: [otherMac], homeOnLocalDisk: true }),
        darwin
      ).kind
    ).toBe('claim')
    const nameless = probe(linux, { dataRootOwners: [{ host: null, machineIdentity: null }] })
    expect(decideHivewarddMachineHome(nameless, linux).kind).toBe('unresolved')
  })

  it('reads a Linux home’s filesystem type before its df source', () => {
    const output = (installed: string, type: string, source: string): string =>
      [
        '/home/u',
        'a'.repeat(32),
        'node-a',
        'ABSENT',
        '',
        '',
        installed,
        type,
        `${source} 100 1 99 1% /home`
      ].join('\n__HIVEWARD_MACHINE_HOME_SECTION__\n')
    const decide = (installed: string, type: string, source: string) =>
      decideHivewarddMachineHome(
        parseHivewarddMachineHomeProbe(output(installed, type, source), linux),
        linux
      )
    expect(decide('INSTALLED', 'nfs', '/dev/sda1').kind).toBe('unresolved')
    expect(decide('INSTALLED', 'ext2/ext3', 'filer:/export').kind).toBe('claim')
    // Old BusyBox may omit filesystem type; only device sources prove a local disk.
    expect(decide('INSTALLED', '', '/dev/sda1').kind).toBe('claim')
    expect(decide('INSTALLED', '', 'filer:/export').kind).toBe('unresolved')
    // Unused login homes have no prior server owner to strand.
    expect(decide('', 'nfs', 'filer:/export').kind).toBe('claim')
  })

  it('claims a stopped install only with evidence of whose it is', () => {
    const stopped = { loginHomeInstalled: true }
    expect(decideHivewarddMachineHome(probe(linux, stopped), linux).kind).toBe('unresolved')
    expect(
      decideHivewarddMachineHome(probe(linux, { ...stopped, homeOnLocalDisk: true }), linux).kind
    ).toBe('claim')
    const ownRunning = probe(linux, {
      ...stopped,
      dataRootOwners: [{ host: 'node-a', machineIdentity: 'a'.repeat(32) }]
    })
    expect(decideHivewarddMachineHome(ownRunning, linux).kind).toBe('claim')
  })

  it('keeps the login home when the machine cannot be identified', () => {
    expect(decideHivewarddMachineHome(probe(linux, { identity: null }), linux)).toEqual({
      kind: 'login-home'
    })
  })
})

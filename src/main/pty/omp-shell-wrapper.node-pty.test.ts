import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import { getPosixOmpShellWrapper } from './omp-shell-wrapper'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip
const itWithZsh = hasZsh ? it : it.skip

type PosixShell = 'bash' | 'zsh'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hiveward-omp-node-pty-'))
  tempDirs.push(dir)
  return dir
}

function writeFakeOmp(binDir: string): void {
  const ompPath = join(binDir, 'omp')
  writeFileSync(
    ompPath,
    `#!/bin/sh
agent_dir="\${PI_CODING_AGENT_DIR:-\${HIVEWARD_FAKE_OMP_DEFAULT_DIR:-}}"
if [ "\${1:-}" = "config" ] && [ -n "$agent_dir" ]; then
  mkdir -p "$agent_dir"
  printf 'updated-by-omp-config\\n' > "$agent_dir/config.yml"
fi
{
  printf 'PI=%s\\n' "$PI_CODING_AGENT_DIR"
  printf 'EFFECTIVE=%s\\n' "$agent_dir"
  printf 'CWD=%s\\n' "$(pwd -P)"
  i=0
  for arg in "$@"; do
    i=$((i + 1))
    printf 'ARG%s=%s\\n' "$i" "$arg"
  done
} > "$HIVEWARD_CAPTURE_FILE"
exit "\${HIVEWARD_TEST_FAKE_OMP_EXIT_CODE:-0}"
`,
    { mode: 0o755 }
  )
  chmodSync(ompPath, 0o755)
}

async function runInteractivePosixPty(args: {
  rcfileContent: string
  env: Record<string, string>
  input: string
  cwd: string
  shell?: PosixShell
}): Promise<string> {
  const rcfile = join(args.cwd, 'rcfile')
  writeFileSync(rcfile, args.rcfileContent)
  const shell = args.shell ?? 'bash'
  const shellArgs = shell === 'bash' ? ['--noprofile', '--rcfile', rcfile, '-i'] : ['-f', '-i']

  const proc = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: args.cwd,
    env: { ...args.env, HIVEWARD_TEST_RCFILE: rcfile }
  })

  let output = ''
  proc.onData((data) => {
    output += data
  })

  const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
    proc.onExit(({ exitCode }) => resolve({ exitCode }))
  })

  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`timed out waiting for ${shell} PTY output:\n${output}`)),
      5000
    )
  })

  try {
    const input = shell === 'zsh' ? `source "$HIVEWARD_TEST_RCFILE"\n${args.input}` : args.input
    proc.write(input.replace(/\n/g, '\r'))
    const { exitCode } = await Promise.race([exitPromise, timeoutPromise])
    expect(exitCode).toBe(0)
    return output
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout)
    }
    try {
      proc.kill()
    } catch {
      // The process may already have exited normally before cleanup runs.
    }
  }
}

describePosix('OMP shell wrapper node-pty reproduction', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  itWithBash('reproduces why restored shells miss OMP status without the wrapper', async () => {
    const tempDir = makeTempDir()
    const binDir = join(tempDir, 'bin')
    const piDir = join(tempDir, 'pi-agent')
    const ompDir = join(tempDir, 'omp-agent')
    const extensionDir = join(ompDir, 'extensions')
    mkdirSync(binDir)
    mkdirSync(piDir)
    mkdirSync(extensionDir, { recursive: true })
    const statusExtension = join(extensionDir, 'hiveward-agent-status.ts')
    writeFileSync(statusExtension, 'export default {}')
    writeFakeOmp(binDir)

    const makeEnv = (captureFile: string, afterPiFile: string): Record<string, string> => ({
      ...process.env,
      HOME: tempDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      PI_CODING_AGENT_DIR: '',
      HIVEWARD_PI_CODING_AGENT_DIR: '',
      HIVEWARD_OMP_CODING_AGENT_DIR: '',
      HIVEWARD_OMP_STATUS_EXTENSION: statusExtension,
      HIVEWARD_FAKE_OMP_DEFAULT_DIR: ompDir,
      HIVEWARD_CAPTURE_FILE: captureFile,
      HIVEWARD_AFTER_PI_FILE: afterPiFile,
      TERM: process.env.TERM || 'xterm-256color'
    })

    const unwrappedCapture = join(tempDir, 'unwrapped-capture')
    const unwrappedAfterPi = join(tempDir, 'unwrapped-after-pi')
    await runInteractivePosixPty({
      cwd: tempDir,
      rcfileContent: '',
      env: makeEnv(unwrappedCapture, unwrappedAfterPi),
      input: `omp ask
printf '%s' "$PI_CODING_AGENT_DIR" > "$HIVEWARD_AFTER_PI_FILE"
exit 0
`
    })

    const unwrapped = readFileSync(unwrappedCapture, 'utf8')
    expect(unwrapped).toContain('PI=\n')
    expect(unwrapped).toContain(`EFFECTIVE=${ompDir}`)
    expect(unwrapped).toContain('ARG1=ask')
    expect(unwrapped).not.toContain('ARG1=--extension')

    const wrappedCapture = join(tempDir, 'wrapped-capture')
    const wrappedAfterPi = join(tempDir, 'wrapped-after-pi')
    const wrappedOutput = await runInteractivePosixPty({
      cwd: tempDir,
      rcfileContent: getPosixOmpShellWrapper(),
      env: makeEnv(wrappedCapture, wrappedAfterPi),
      input: `type omp
omp ask
printf '%s' "$PI_CODING_AGENT_DIR" > "$HIVEWARD_AFTER_PI_FILE"
exit 0
`
    })

    const wrapped = readFileSync(wrappedCapture, 'utf8')
    expect(wrappedOutput).toContain('omp is a function')
    expect(wrapped).toContain('PI=\n')
    expect(wrapped).toContain(`EFFECTIVE=${ompDir}`)
    expect(wrapped).toContain('ARG1=--extension')
    expect(wrapped).toContain(`ARG2=${statusExtension}`)
    expect(wrapped).toContain('ARG3=ask')
    expect(readFileSync(wrappedAfterPi, 'utf8')).toBe('')
  })

  itWithBash('runs OMP config subcommands without redirecting the home', async () => {
    const tempDir = makeTempDir()
    const binDir = join(tempDir, 'bin')
    const sourceDir = join(tempDir, 'source-omp-agent')
    const extensionDir = join(sourceDir, 'extensions')
    mkdirSync(binDir)
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(extensionDir, { recursive: true })
    const statusExtension = join(extensionDir, 'hiveward-agent-status.ts')
    writeFileSync(statusExtension, 'export default {}')
    writeFakeOmp(binDir)

    const captureFile = join(tempDir, 'config-capture')
    await runInteractivePosixPty({
      cwd: tempDir,
      rcfileContent: getPosixOmpShellWrapper(),
      env: {
        ...process.env,
        HOME: tempDir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        PI_CODING_AGENT_DIR: '',
        HIVEWARD_PI_CODING_AGENT_DIR: '',
        HIVEWARD_OMP_CODING_AGENT_DIR: '',
        HIVEWARD_OMP_SOURCE_AGENT_DIR: sourceDir,
        HIVEWARD_OMP_STATUS_EXTENSION: statusExtension,
        HIVEWARD_FAKE_OMP_DEFAULT_DIR: sourceDir,
        HIVEWARD_CAPTURE_FILE: captureFile,
        TERM: process.env.TERM || 'xterm-256color'
      },
      input: `omp config
exit 0
`
    })

    const capture = readFileSync(captureFile, 'utf8')
    expect(capture).toContain('PI=\n')
    expect(capture).toContain(`EFFECTIVE=${sourceDir}`)
    expect(capture).toContain('ARG1=config')
    expect(readFileSync(join(sourceDir, 'config.yml'), 'utf8')).toBe('updated-by-omp-config\n')
  })

  itWithBash.each([
    '__complete',
    'bench',
    'completions',
    'dry-balance',
    'gallery',
    'install',
    'join',
    'models',
    'say',
    'tiny-models',
    'token',
    'ttsr',
    'usage'
  ])('runs OMP %s subcommands without injecting the status extension', async (subcommand) => {
    const tempDir = makeTempDir()
    const binDir = join(tempDir, 'bin')
    const sourceDir = join(tempDir, 'source-omp-agent')
    const extensionDir = join(sourceDir, 'extensions')
    mkdirSync(binDir)
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(extensionDir, { recursive: true })
    const statusExtension = join(extensionDir, 'hiveward-agent-status.ts')
    writeFileSync(statusExtension, 'export default {}')
    writeFakeOmp(binDir)

    const captureFile = join(tempDir, `${subcommand}-capture`)
    await runInteractivePosixPty({
      cwd: tempDir,
      rcfileContent: getPosixOmpShellWrapper(),
      env: {
        ...process.env,
        HOME: tempDir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        PI_CODING_AGENT_DIR: '',
        HIVEWARD_PI_CODING_AGENT_DIR: '',
        HIVEWARD_OMP_CODING_AGENT_DIR: '',
        HIVEWARD_OMP_SOURCE_AGENT_DIR: sourceDir,
        HIVEWARD_OMP_STATUS_EXTENSION: statusExtension,
        HIVEWARD_FAKE_OMP_DEFAULT_DIR: sourceDir,
        HIVEWARD_CAPTURE_FILE: captureFile,
        TERM: process.env.TERM || 'xterm-256color'
      },
      input: `omp ${subcommand}
exit 0
`
    })

    const capture = readFileSync(captureFile, 'utf8')
    expect(capture).toContain('PI=\n')
    expect(capture).toContain(`EFFECTIVE=${sourceDir}`)
    expect(capture).toContain(`ARG1=${subcommand}`)
    expect(capture).not.toContain('ARG1=--extension')
  })

  itWithBash(
    'lets OMP config subcommands fall back to the default home without a source shadow',
    async () => {
      const tempDir = makeTempDir()
      const binDir = join(tempDir, 'bin')
      const defaultOmpDir = join(tempDir, '.omp', 'agent')
      const extensionDir = join(defaultOmpDir, 'extensions')
      mkdirSync(binDir)
      mkdirSync(defaultOmpDir, { recursive: true })
      mkdirSync(extensionDir, { recursive: true })
      const statusExtension = join(extensionDir, 'hiveward-agent-status.ts')
      writeFileSync(statusExtension, 'export default {}')
      writeFakeOmp(binDir)

      const captureFile = join(tempDir, 'default-config-capture')
      await runInteractivePosixPty({
        cwd: tempDir,
        rcfileContent: getPosixOmpShellWrapper(),
        env: {
          ...process.env,
          HOME: tempDir,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          PI_CODING_AGENT_DIR: '',
          HIVEWARD_PI_CODING_AGENT_DIR: '',
          HIVEWARD_OMP_CODING_AGENT_DIR: '',
          HIVEWARD_OMP_STATUS_EXTENSION: statusExtension,
          HIVEWARD_FAKE_OMP_DEFAULT_DIR: defaultOmpDir,
          HIVEWARD_CAPTURE_FILE: captureFile,
          TERM: process.env.TERM || 'xterm-256color'
        },
        input: `omp config
exit 0
`
      })

      const capture = readFileSync(captureFile, 'utf8')
      expect(capture).toContain('PI=\n')
      expect(capture).toContain(`EFFECTIVE=${defaultOmpDir}`)
      expect(readFileSync(join(defaultOmpDir, 'config.yml'), 'utf8')).toBe(
        'updated-by-omp-config\n'
      )
    }
  )

  async function expectStaleCwdRecovery(shell: PosixShell): Promise<void> {
    const tempDir = makeTempDir()
    const workspaceDir = join(tempDir, 'workspace')
    const projectDir = join(workspaceDir, 'project')
    const homeDir = join(tempDir, 'home')
    const binDir = join(tempDir, 'bin')
    const extensionDir = join(tempDir, 'extensions')
    const logicalProjectLink = join(tempDir, 'logical-project')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(homeDir)
    mkdirSync(binDir)
    mkdirSync(extensionDir)
    symlinkSync(projectDir, logicalProjectLink)
    const expectedProjectDir = realpathSync(projectDir)
    const expectedWorkspaceDir = realpathSync(workspaceDir)
    const statusExtension = join(extensionDir, 'hiveward-agent-status.ts')
    writeFileSync(statusExtension, 'export default {}')
    writeFakeOmp(binDir)

    const unsetPwdCaptureFile = join(tempDir, 'unset-pwd-capture')
    const deletedLinkCaptureFile = join(tempDir, 'deleted-link-capture')
    const staleCaptureFile = join(tempDir, 'stale-cwd-capture')
    const skipCaptureFile = join(tempDir, 'skip-capture')
    const staleUnsetCaptureFile = join(tempDir, 'stale-unset-capture')
    const noLogicalCaptureFile = join(tempDir, 'no-logical-capture')
    const resultFile = join(tempDir, 'stale-cwd-result')
    const scenarioFile = join(tempDir, 'stale-cwd-scenario')
    writeFileSync(
      scenarioFile,
      `HIVEWARD_CAPTURE_FILE="$HIVEWARD_UNSET_PWD_CAPTURE_FILE"
unset PWD
omp
__hiveward_test_unset_status=$?
if [[ -z "\${PWD+x}" ]]; then
  __hiveward_test_pwd_state=unset
else
  __hiveward_test_pwd_state=set
fi
builtin cd -- "$HIVEWARD_LOGICAL_PROJECT_LINK"
/bin/rm -- "$HIVEWARD_LOGICAL_PROJECT_LINK"
HIVEWARD_CAPTURE_FILE="$HIVEWARD_DELETED_LINK_CAPTURE_FILE"
omp
__hiveward_test_deleted_link_status=$?
builtin cd -P -- "$HIVEWARD_STALE_PROJECT_DIR"
HIVEWARD_CAPTURE_FILE="$HIVEWARD_STALE_CAPTURE_FILE"
/bin/rm -rf -- "$HIVEWARD_STALE_PROJECT_DIR"
/bin/mkdir -p -- "$HIVEWARD_STALE_PROJECT_DIR"
omp
__hiveward_test_first_status=$?
HIVEWARD_CAPTURE_FILE="$HIVEWARD_SKIP_CAPTURE_FILE"
omp --version
__hiveward_test_skip_status=$?
if [[ "$PWD" -ef . ]]; then
  __hiveward_test_parent_state=live
else
  __hiveward_test_parent_state=stale
fi
unset PWD
HIVEWARD_CAPTURE_FILE="$HIVEWARD_STALE_UNSET_CAPTURE_FILE"
omp
__hiveward_test_stale_unset_status=$?
unset HIVEWARD_WORKTREE_PATH HIVEWARD_ROOT_PATH
HIVEWARD_CAPTURE_FILE="$HIVEWARD_NO_LOGICAL_CAPTURE_FILE"
omp
__hiveward_test_no_logical_status=$?
PWD="$HIVEWARD_STALE_PROJECT_DIR"
/bin/rm -rf -- "$HIVEWARD_STALE_PROJECT_DIR"
omp
__hiveward_test_missing_status=$?
{
  echo "UNSET=$__hiveward_test_unset_status"
  echo "PWD=$__hiveward_test_pwd_state"
  echo "LINK=$__hiveward_test_deleted_link_status"
  echo "FIRST=$__hiveward_test_first_status"
  echo "SKIP=$__hiveward_test_skip_status"
  echo "PARENT=$__hiveward_test_parent_state"
  echo "STALE_UNSET=$__hiveward_test_stale_unset_status"
  echo "NO_LOGICAL=$__hiveward_test_no_logical_status"
  echo "MISSING=$__hiveward_test_missing_status"
} > "$HIVEWARD_RESULT_FILE"
exit 0
`
    )
    const output = await runInteractivePosixPty({
      shell,
      cwd: projectDir,
      rcfileContent: `cd() { return 97; }
${getPosixOmpShellWrapper()}`,
      env: {
        INPUTRC: '/dev/null',
        PROMPT_COMMAND: '',
        HIVEWARD_STALE_PROJECT_DIR: projectDir,
        HIVEWARD_LOGICAL_PROJECT_LINK: logicalProjectLink,
        HIVEWARD_UNSET_PWD_CAPTURE_FILE: unsetPwdCaptureFile,
        HIVEWARD_DELETED_LINK_CAPTURE_FILE: deletedLinkCaptureFile,
        HIVEWARD_STALE_CAPTURE_FILE: staleCaptureFile,
        HIVEWARD_SKIP_CAPTURE_FILE: skipCaptureFile,
        HIVEWARD_STALE_UNSET_CAPTURE_FILE: staleUnsetCaptureFile,
        HIVEWARD_NO_LOGICAL_CAPTURE_FILE: noLogicalCaptureFile,
        HIVEWARD_WORKTREE_PATH: workspaceDir,
        HOME: homeDir,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HIVEWARD_OMP_STATUS_EXTENSION: statusExtension,
        HIVEWARD_CAPTURE_FILE: staleCaptureFile,
        HIVEWARD_RESULT_FILE: resultFile,
        HIVEWARD_SCENARIO_FILE: scenarioFile,
        HIVEWARD_TEST_FAKE_OMP_EXIT_CODE: '23',
        TERM: 'xterm-256color'
      },
      input: 'source "$HIVEWARD_SCENARIO_FILE"\n'
    })

    const unsetPwdCapture = readFileSync(unsetPwdCaptureFile, 'utf8')
    expect(unsetPwdCapture).toContain(`CWD=${expectedProjectDir}`)
    const deletedLinkCapture = readFileSync(deletedLinkCaptureFile, 'utf8')
    expect(deletedLinkCapture).toContain(`CWD=${expectedProjectDir}`)
    const staleCapture = readFileSync(staleCaptureFile, 'utf8')
    expect(staleCapture).toContain(`CWD=${expectedProjectDir}`)
    expect(staleCapture.split('\n').filter((line) => line.startsWith('ARG'))).toEqual([
      'ARG1=--extension',
      `ARG2=${statusExtension}`
    ])
    expect(staleCapture).not.toContain('--cwd')
    const skipCapture = readFileSync(skipCaptureFile, 'utf8')
    expect(skipCapture).toContain(`CWD=${expectedProjectDir}`)
    expect(skipCapture).toContain('ARG1=--version')
    expect(skipCapture).not.toContain('--extension')
    const staleUnsetCapture = readFileSync(staleUnsetCaptureFile, 'utf8')
    expect(staleUnsetCapture).toContain(`CWD=${expectedWorkspaceDir}`)
    expect(existsSync(noLogicalCaptureFile)).toBe(false)
    expect(readFileSync(resultFile, 'utf8')).toBe(
      'UNSET=23\nPWD=unset\nLINK=23\nFIRST=23\nSKIP=23\nPARENT=stale\nSTALE_UNSET=23\nNO_LOGICAL=1\nMISSING=1\n'
    )
    expect(output).toContain('no terminal working directory is available')
    expect(output).toContain('HiveWard: OMP cannot access the terminal working directory')
  }

  itWithBash('rebinds a stale Bash cwd before launching OMP', async () => {
    await expectStaleCwdRecovery('bash')
  })

  itWithZsh('rebinds a stale Zsh cwd before launching OMP', async () => {
    await expectStaleCwdRecovery('zsh')
  })
})

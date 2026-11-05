import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '@hiveward/process-host'
import { HIVEWARDD_LAUNCHER_FILENAME, HIVEWARDD_SERVER_ENTRY_FILENAME } from '../../shared/hivewardd-artifacts'

const nodeExecutable = process.env.HIVEWARD_TEST_NODE_EXECUTABLE ?? process.execPath

let directory = ''
let launcher = ''

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hivewardd-help-'))
  launcher = join(directory, HIVEWARDD_LAUNCHER_FILENAME)
  const builder = pathToFileURL(join(process.cwd(), 'config/scripts/hivewardd-entry-build.mjs')).href
  const built = await runProcess({
    program: nodeExecutable,
    args: [
      '--input-type=module',
      '-e',
      `import {buildHivewarddEntry,buildHivewarddLauncher} from ${JSON.stringify(builder)};` +
        `await buildHivewarddEntry(${JSON.stringify(join(directory, HIVEWARDD_SERVER_ENTRY_FILENAME))});` +
        `await buildHivewarddLauncher(${JSON.stringify(launcher)});`
    ],
    env: { ...process.env, HIVEWARD_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 60_000
  })
  expect(built.code, built.stderr).toBe(0)
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('real hivewardd executable help', () => {
  it.each([['--help'], ['-h'], ['--json', '--help'], ['--help', '--json']])(
    'prints usage to stdout and exits without creating a profile: %j',
    async (...argv) => {
      const dataRoot = join(directory, `absent-${argv.join('-')}`)
      const result = await runProcess({
        program: nodeExecutable,
        args: [launcher, ...argv],
        env: { ...process.env, HIVEWARD_BACKGROUND_LAUNCH: '1', HIVEWARD_USER_DATA: dataRoot },
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('Usage: hivewardd [options]')
      expect(result.stdout).toContain('--bind <ip>')
      expect(result.stdout).not.toContain('"type":"hiveward_server_ready"')
      await expect(readdir(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('leaves an existing instance lock untouched', async () => {
    const dataRoot = join(directory, 'locked-profile')
    await mkdir(dataRoot)
    const lock = join(dataRoot, 'hivewardd.lock')
    const content = 'an existing instance owns this profile\n'
    await writeFile(lock, content)
    const result = await runProcess({
      program: nodeExecutable,
      args: [launcher, '--help'],
      env: { ...process.env, HIVEWARD_BACKGROUND_LAUNCH: '1', HIVEWARD_USER_DATA: dataRoot },
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(await readFile(lock, 'utf8')).toBe(content)
    expect(await readdir(dataRoot)).toEqual(['hivewardd.lock'])
  })
})

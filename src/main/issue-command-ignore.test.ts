import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import { writeIssueCommand } from './issue-command-file'

describe('issue command ignore rules', () => {
  let root: string
  let repo: string
  let globalConfig: string

  const git = (args: string[]) => gitExecFileAsync(args, { cwd: repo })

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hiveward-issue-ignore-'))
    repo = join(root, 'repo with spaces')
    mkdirSync(repo)
    globalConfig = join(root, 'gitconfig')
    const globalIgnore = join(root, 'ignore')
    writeFileSync(globalConfig, '')
    writeFileSync(globalIgnore, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    await git(['init', '-q'])
    await git(['config', '--file', globalConfig, 'core.excludesFile', globalIgnore])
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it.each(['.hiveward', '.hiveward/', '/.hiveward/', '.hiveward/*', '.hiveward/issue-command'])(
    'respects global ignore pattern %s',
    async (pattern) => {
      writeFileSync(join(root, 'ignore'), `${pattern}\n`)
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')

      await writeIssueCommand(repo, 'local command')

      expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n')
      expect(readFileSync(join(repo, '.hiveward', 'issue-command'), 'utf8')).toBe('local command\n')
    }
  )

  it('respects shared repository excludes from a linked worktree', async () => {
    await git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'initial'
    ])
    const worktree = join(root, 'linked worktree')
    await git(['worktree', 'add', '-q', '-b', 'issue-command-test', worktree])
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.hiveward/\n')

    await writeIssueCommand(worktree, 'local command')

    expect(existsSync(join(worktree, '.gitignore'))).toBe(false)
    expect((await gitExecFileAsync(['status', '--porcelain'], { cwd: worktree })).stdout).toBe('')
  })

  it('adds the rule once when .hiveward is not ignored', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/')

    await writeIssueCommand(repo, 'first command')
    await writeIssueCommand(repo, 'second command')

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n.hiveward\n')
    expect(readFileSync(join(repo, '.hiveward', 'issue-command'), 'utf8')).toBe('second command\n')
  })

  it('honors a repository rule that negates a global ignore', async () => {
    writeFileSync(join(root, 'ignore'), '.hiveward/\n')
    writeFileSync(join(repo, '.gitignore'), '!.hiveward/\n')

    await writeIssueCommand(repo, 'local command')

    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('!.hiveward/\n.hiveward\n')
  })
})

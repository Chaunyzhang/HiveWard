import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runProcess } from '@hiveward/process-host'
import {
  allowedDir,
  fileDiff,
  listChanges,
  parseStatus,
  workspaceChangesRoutes
} from './workspace-changes.mjs'

const git = async (cwd, ...args) => {
  const r = await runProcess({ program: 'git', args, cwd })
  assert.equal(r.code, 0, r.stderr)
  return r.stdout
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-changes-'))
  const work = join(root, 'biz')
  await mkdir(join(work, 'app'), { recursive: true })
  await git(work, 'init', '-q', '-b', 'main')
  await git(work, 'config', 'user.email', 't@example.com')
  await git(work, 'config', 'user.name', 't')
  await writeFile(join(work, 'README.md'), 'hello\n')
  await writeFile(join(work, 'app', 'a.txt'), 'one\ntwo\n')
  await writeFile(join(work, 'gone.txt'), 'bye\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '-q', '-m', 'init')
  return { root, work }
}

test('parseStatus reads porcelain v1 -z', () => {
  const out = ' M a.txt\0?? new file.md\0A  added.js\0 D gone\0R  new.js\0old.js\0UU c.txt\0'
  assert.deepEqual(parseStatus(out), [
    { path: 'a.txt', staged: false, unstaged: true, status: 'modified' },
    { path: 'new file.md', staged: false, unstaged: true, status: 'untracked' },
    { path: 'added.js', staged: true, unstaged: false, status: 'added' },
    { path: 'gone', staged: false, unstaged: true, status: 'deleted' },
    { path: 'new.js', staged: true, unstaged: false, oldPath: 'old.js', status: 'renamed' },
    { path: 'c.txt', staged: true, unstaged: true, status: 'conflict' }
  ])
})

test('lists uncommitted changes and per-file diff, without touching the repo', async () => {
  const { root, work } = await repo()
  try {
    await writeFile(join(work, 'app', 'a.txt'), 'one\nTWO\n')
    await writeFile(join(work, 'app', 'new.txt'), 'fresh\n')
    await writeFile(join(work, 'staged.txt'), 'staged\n')
    await git(work, 'add', 'staged.txt')
    await rm(join(work, 'gone.txt'))
    const before = await readdir(join(work, '.git'))

    const all = await listChanges(work)
    assert.equal(all.git, true)
    assert.equal(all.branch, 'main')
    assert.deepEqual(all.files.map((f) => [f.path, f.status]).sort(), [
      ['app/a.txt', 'modified'],
      ['app/new.txt', 'untracked'],
      ['gone.txt', 'deleted'],
      ['staged.txt', 'added']
    ])

    // 子目录只看它里面的改动，路径仍相对仓库根
    const sub = await listChanges(join(work, 'app'))
    assert.deepEqual(sub.files.map((f) => f.path).sort(), ['app/a.txt', 'app/new.txt'])

    const modified = await fileDiff(work, 'app/a.txt')
    assert.match(modified.diff, /-two\n\+TWO/)
    const untracked = await fileDiff(work, 'app/new.txt')
    assert.match(untracked.diff, /\+fresh/)
    const staged = await fileDiff(work, 'staged.txt')
    assert.match(staged.diff, /\+staged/)

    // 不在改动列表里的文件不给看
    await assert.rejects(fileDiff(work, 'README.md'), { status: 404 })
    await assert.rejects(fileDiff(work, '../../etc/passwd'), { status: 404 })

    // 只读：暂存区没变，.git 里没多出锁文件之类
    assert.match(await git(work, 'diff', '--cached', '--name-only'), /^staged\.txt\n$/)
    assert.deepEqual(await readdir(join(work, '.git')), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('non-git folder workspaces report git=false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-changes-plain-'))
  try {
    assert.deepEqual(await listChanges(root), { dir: root, git: false, files: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('paths must sit inside a registered business directory', async () => {
  const { root, work } = await repo()
  try {
    const roots = () => [work]
    assert.ok(allowedDir(join(work, 'app'), roots).endsWith('/biz/app'))
    assert.throws(() => allowedDir(root, roots), { status: 403 })
    assert.throws(() => allowedDir('relative/dir', roots), { status: 400 })
    assert.throws(() => allowedDir(join(work, 'nope'), roots), { status: 404 })
    // 软链指到业务目录外面也不行
    const outside = await mkdtemp(join(tmpdir(), 'hiveward-changes-out-'))
    await symlink(outside, join(work, 'escape'))
    assert.throws(() => allowedDir(join(work, 'escape'), roots), { status: 403 })
    await rm(outside, { recursive: true, force: true })

    const [list, diff] = workspaceChangesRoutes({ roots })
    const url = (p) => new URL(`http://x${p}`)
    await writeFile(join(work, 'README.md'), 'changed\n')
    const listed = await list[2](
      null,
      [],
      url(`/api/workspace/changes?path=${encodeURIComponent(work)}`)
    )
    assert.deepEqual(
      listed.files.map((f) => f.path),
      ['README.md', 'escape']
    )
    const shown = await diff[2](
      null,
      [],
      url(`/api/workspace/changes/diff?path=${encodeURIComponent(work)}&file=README.md`)
    )
    assert.match(shown.diff, /\+changed/)
    await assert.rejects(
      list[2](null, [], url(`/api/workspace/changes?path=${encodeURIComponent(root)}`)),
      { status: 403 }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

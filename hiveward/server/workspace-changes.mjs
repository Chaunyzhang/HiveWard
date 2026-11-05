import { runProcess } from '@hiveward/process-host'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { apiError, businesses } from './business.mjs'
import { containsPath } from './workspace-path.mjs'

// 「更改」面板：会话工作目录里还没提交的改动。只读——只跑 status / diff / rev-parse，
// 关掉可选锁和 fsmonitor、外部 diff、textconv，不让 git 在仓库里写东西或跑别的程序。
// 引擎的 git.status / git.diff 只认登记过的 HiveWard 工作区（精确路径），业务目录、项目子目录多半不是，所以这里直接读。

const MAX_DIFF = 400_000
const MAX_FILES = 2000
const READ_ONLY = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']

async function git(cwd, args, { okCodes = [0] } = {}) {
  const r = await runProcess({
    program: 'git',
    args: [...READ_ONLY, ...args],
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    timeoutMs: 20_000,
    maxOutputBytes: 16 * 1024 * 1024
  })
  if (r.timedOut || !okCodes.includes(r.code)) {
    throw Object.assign(new Error(r.stderr.trim() || 'git 失败'), { exitCode: r.code })
  }
  return r.stdout
}

const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** 目录必须真实存在、落在某块登记过的业务目录里（软链解开后比） */
export function allowedDir(dir, roots = () => businesses().map((b) => b.workspacePath)) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) {
    throw apiError(400, 'bad_request', 'path 必须是绝对路径')
  }
  const resolved = real(dir)
  if (!resolved) {
    throw apiError(404, 'not_found', `目录不在了：${dir}`)
  }
  const inside = roots()
    .map(real)
    .some((root) => root && containsPath(root, resolved))
  if (!inside) {
    throw apiError(403, 'forbidden', '只能看登记过的业务目录里的改动')
  }
  return resolved
}

const STATUS = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflict',
  T: 'modified'
}

/** git status --porcelain=v1 -z 的输出 → 文件列表（路径相对仓库根） */
export function parseStatus(out) {
  const parts = out.split('\0')
  const files = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) {
      continue
    }
    const x = entry[0]
    const y = entry[1]
    const file = entry.slice(3)
    if (x === '!') {
      continue
    }
    const row = { path: file, staged: x !== ' ' && x !== '?', unstaged: y !== ' ' }
    if (x === 'R' || x === 'C') {
      row.oldPath = parts[++i]
    }
    row.status =
      x === '?'
        ? 'untracked'
        : x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
          ? 'conflict'
          : (STATUS[x] ?? STATUS[y] ?? 'modified')
    files.push(row)
  }
  return files
}

async function repoOf(dir) {
  try {
    const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
    return top ? real(top) : null
  } catch {
    return null
  }
}

/** 目录里（含子目录）还没提交的改动；不是 git 仓库时 git=false */
export async function listChanges(dir) {
  const top = await repoOf(dir)
  if (!top) {
    return { dir, git: false, files: [] }
  }
  const [status, branch] = await Promise.all([
    git(dir, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
      '.'
    ]),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then(
      (s) => s.trim(),
      () => null
    )
  ])
  const files = parseStatus(status)
  return {
    dir,
    git: true,
    root: top,
    branch: branch && branch !== 'HEAD' ? branch : null,
    files: files.slice(0, MAX_FILES),
    truncated: files.length > MAX_FILES
  }
}

const clipDiff = (diff) =>
  diff.length > MAX_DIFF
    ? { diff: diff.slice(0, MAX_DIFF), truncated: true }
    : { diff, truncated: false }

/** 一个文件相对 HEAD 的改动（工作区 + 暂存区一起）；新文件和 /dev/null 比 */
export async function fileDiff(dir, file) {
  const top = await repoOf(dir)
  if (!top) {
    throw apiError(400, 'bad_request', '这个目录不是 git 仓库')
  }
  const { files } = await listChanges(dir)
  // 只给列表里有的文件看 diff，免得拿它读任意文件
  const row = files.find((f) => f.path === file)
  if (!row) {
    throw apiError(404, 'not_found', `没有这个改动：${file}`)
  }
  const common = ['--no-color', '--no-ext-diff', '--no-textconv']
  if (row.status === 'untracked') {
    const out = await git(top, ['diff', ...common, '--no-index', '--', '/dev/null', file], {
      okCodes: [0, 1]
    })
    return { path: file, status: row.status, ...clipDiff(out) }
  }
  const hasHead = await git(top, ['rev-parse', '--verify', '-q', 'HEAD']).then(
    () => true,
    () => false
  )
  const out = await git(
    top,
    hasHead ? ['diff', ...common, 'HEAD', '--', file] : ['diff', ...common, '--cached', '--', file]
  )
  return { path: file, status: row.status, ...clipDiff(out) }
}

/** 路由：GET /api/workspace/changes?path=  ·  GET /api/workspace/changes/diff?path=&file= */
export function workspaceChangesRoutes({ roots } = {}) {
  return [
    [
      'GET',
      /^\/api\/workspace\/changes$/,
      async (_req, _params, url) => listChanges(allowedDir(url.searchParams.get('path'), roots))
    ],
    [
      'GET',
      /^\/api\/workspace\/changes\/diff$/,
      async (_req, _params, url) => {
        const file = url.searchParams.get('file')
        if (!file) {
          throw apiError(400, 'bad_request', 'file 不能为空')
        }
        return fileDiff(allowedDir(url.searchParams.get('path'), roots), file)
      }
    ]
  ]
}

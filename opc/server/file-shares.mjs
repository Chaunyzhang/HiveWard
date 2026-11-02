import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dataDir } from './data-dir.mjs'
import { businesses } from './business.mjs'
import { fileError, filePathPolicy } from './file-path-policy.mjs'

export function fileShares({
  directory = dataDir(),
  home = homedir(),
  platform = process.platform,
  businessRows = businesses,
  defaultInbox,
  attributes
} = {}) {
  const policy = filePathPolicy({ platform, home })
  const file = join(directory, 'file-shares.json')
  const defaults = {
    roots: [],
    inbox: defaultInbox ?? policy.path.join(home, 'HiveWard 收件箱'),
    agentWrite: 'inbox'
  }
  async function settings() {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (e) {
      if (e.code === 'ENOENT') {
        return defaults
      }
      throw e
    }
  }
  async function canonical(value, create = false) {
    let current = policy.validate(value)
    const missing = []
    for (;;) {
      try {
        const resolved = await realpath(current)
        policy.validate(resolved)
        await attributes?.check(current)
        return { path: policy.path.join(resolved, ...missing), existing: resolved, missing }
      } catch (e) {
        if (e.code !== 'ENOENT' || !create) {
          throw e
        }
        missing.unshift(policy.path.basename(current))
        const parent = policy.path.dirname(current)
        if (parent === current) {
          throw e
        }
        current = parent
      }
    }
  }
  async function roots() {
    const config = await settings()
    const candidates = [
      ...(await businessRows())
        .filter((b) => !b.removedAt && b.status !== 'archived')
        .map((b) => ({
          id: `business:${b.id}`,
          path: b.workspacePath,
          label: b.name,
          kind: 'business',
          writable: true
        })),
      { id: 'inbox', path: config.inbox, label: '收件箱', kind: 'inbox', writable: true },
      ...[
        ['Downloads', '下载'],
        ['Desktop', '桌面'],
        ['Documents', '文稿']
      ].map(([folder, label]) => ({
        id: `home:${folder}`,
        label,
        path: policy.path.join(home, folder),
        kind: 'home',
        writable: false
      })),
      ...config.roots.map((r, i) => ({
        ...r,
        id: `custom:${i}`,
        label: r.label || policy.path.basename(r.path),
        kind: platform === 'win32' && policy.path.parse(r.path).root === r.path ? 'drive' : 'custom'
      }))
    ]
    const result = []
    for (const root of candidates) {
      try {
        const resolved = await canonical(root.path, root.kind === 'inbox')
        if (root.kind === 'inbox') {
          await mkdir(resolved.path, { recursive: true })
        }
        if (!(await stat(resolved.path)).isDirectory()) {
          continue
        }
        result.push({ ...root, path: resolved.path })
      } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'file_forbidden') {
          throw e
        }
      }
    }
    return { roots: result, inbox: (await canonical(config.inbox, true)).path, platform }
  }
  async function setSettings(body) {
    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray(body.roots) ||
      body.roots.length > 100 ||
      !['inbox', 'roots', 'none'].includes(body.agentWrite)
    ) {
      throw fileError(400, 'bad_request', '共享目录或 agentWrite 设置无效')
    }
    const inbox = await canonical(body.inbox, true)
    await mkdir(inbox.path, { recursive: true }).catch((e) => {
      if (e.code === 'EEXIST') {
        throw fileError(400, 'bad_request', '收件箱必须是目录')
      }
      throw e
    })
    if (!(await stat(inbox.path)).isDirectory()) {
      throw fileError(400, 'bad_request', '收件箱必须是目录')
    }
    const extras = []
    for (const r of body.roots) {
      if (
        typeof r?.writable !== 'boolean' ||
        (r.label !== undefined && typeof r.label !== 'string')
      ) {
        throw fileError(400, 'bad_request', '共享目录设置无效')
      }
      const target = await canonical(r.path)
      if (!(await stat(target.path)).isDirectory()) {
        throw fileError(400, 'bad_request', '共享路径必须是目录')
      }
      extras.push({
        path: target.path,
        writable: r.writable,
        ...(r.label ? { label: r.label } : {})
      })
    }
    const config = { roots: extras, inbox: inbox.path, agentWrite: body.agentWrite }
    await mkdir(directory, { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 })
    await rename(temp, file)
    return config
  }
  async function resolve(value, { write = false, create = false, agent = false } = {}) {
    policy.validate(value)
    const shared = await roots()
    const target = await canonical(value, create)
    const matching = shared.roots
      .filter((r) => policy.within(target.path, r.path))
      .sort((a, b) => b.path.length - a.path.length)
    if (!matching.length) {
      throw fileError(403, 'file_forbidden', '路径不在共享目录内')
    }
    const root = matching[0]
    if (write && !root.writable) {
      throw fileError(403, 'file_read_only', '该共享目录不可写')
    }
    if (write && agent) {
      const config = await settings()
      if (
        config.agentWrite === 'none' ||
        (config.agentWrite === 'inbox' && !policy.within(target.path, shared.inbox))
      ) {
        throw fileError(
          403,
          'agent_write_denied',
          '目标电脑限制 Agent 写入：只允许收件箱，或已禁止写入'
        )
      }
    }
    let ancestor = target.existing
    while (policy.within(ancestor, root.path)) {
      await attributes?.check(ancestor)
      if (ancestor === root.path) {
        break
      }
      ancestor = policy.path.dirname(ancestor)
    }
    return { ...target, root, shared }
  }
  return { settings, setSettings, roots, resolve, policy }
}

import { businessProjects, migrateProjects } from './business-projects.mjs'
// 登记文件夹是业务：业务列表由引擎 repo.list 推导，businesses.json 只存附加信息（按 workspacePath 对应）。
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  businesses,
  addBusiness,
  saveBusinesses,
  getBusiness,
  updateBusiness,
  workspacePath,
  canonicalPath,
  badRequest
} from './business.mjs'
import { rpc, ensureRepo } from './api-runtime.mjs'
import { businessIdentity, detectProjectIdentity } from './project-identity.mjs'
import { appendTimelineEvents } from './timeline.mjs'

function recordProjectEvent(row, name, action) {
  appendTimelineEvents({
    id: `project:${row.id}:${action}:${row.updatedAt}`,
    ts: row.updatedAt,
    businessId: row.id,
    kind: 'system',
    title: `${action === 'added' ? '业务加入' : '业务移除'}：${name}`,
    path: row.workspacePath
  })
}

/** 目录名 → 短 id（只含 a-z0-9-）；中文等没有可用字符时用 p-<repoId 前 8 位>；冲突加数字后缀 */
export function projectIdFor(dirName, repoId, taken) {
  const slug = dirName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  let id =
    slug ||
    `p-${String(repoId)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 8)}`
  while (taken.has(id)) {
    const match = /^(.*?)(\d+)$/.exec(id)
    id = match ? `${match[1]}${Number(match[2]) + 1}` : `${id}-2`
  }
  taken.add(id)
  return id
}

/**
 * 业务 ↔ 引擎项目对账（纯函数）。rows 是 businesses.json 的记录，repos 是 repo.list 的项目：
 * - 目录已不在 → 标 missing: true（记录不删）；目录回来了去掉
 * - 引擎里有项目、业务里没有 → 补一条（id 推导、leaderAgent claude、priority 2）
 * - 已移除（removedAt）的记录不再挂回项目
 * 返回 { rows, changed }；changed 为 false 时 rows 与原值同序同引用内容，无需落盘。
 */
export function reconcileBusinesses(rows, repos, dirExists, canonical = (p) => p) {
  let changed = false
  const repoByPath = new Map(repos.map((r) => [canonical(r.path), r]))
  const businessPaths = new Set(rows.map((b) => canonical(b.workspacePath)))
  const out = rows.map((b) => {
    const missing = !dirExists(b.workspacePath)
    const repo = b.removedAt ? undefined : repoByPath.get(canonical(b.workspacePath))
    const patch = {}
    if (!!b.missing !== missing) {
      patch.missing = missing
    }
    if ((b.repoId ?? undefined) !== (repo?.id ?? undefined)) {
      patch.repoId = repo?.id
    }
    if ((b.kind ?? undefined) !== (repo?.kind ?? undefined)) {
      patch.kind = repo?.kind
    }
    if (!Object.keys(patch).length) {
      return b
    }
    changed = true
    return { ...b, ...patch }
  })
  const taken = new Set(rows.map((b) => b.id))
  for (const repo of repos) {
    if (businessPaths.has(canonical(repo.path))) {
      continue
    }
    changed = true
    const now = new Date().toISOString()
    out.push({
      id: projectIdFor(basename(repo.path), repo.id, taken),
      name: repo.displayName || basename(repo.path),
      nameSource: 'auto',
      workspacePath: repo.path,
      leaderAgent: 'claude',
      priority: 2,
      status: 'active',
      authority: '',
      runIds: [],
      repoId: repo.id,
      kind: repo.kind,
      updatedAt: now
    })
  }
  return { rows: out, changed }
}

/** 读业务并和引擎对账：已有业务目录还在但引擎里没登记的 → 迁移成项目；有新项目 → 补业务记录 */
export async function syncedBusinesses() {
  const before = businesses()
  const identities = new Map()
  let repos = (await rpc('repo.list')).repos
  for (const b of before) {
    if (b.removedAt || b.missing) {
      continue
    }
    if (!existsSync(b.workspacePath)) {
      continue
    }
    const repo = repos.find((r) => canonicalPath(r.path) === canonicalPath(b.workspacePath))
    const identity = await businessIdentity(b)
    identities.set(b.id, identity)
    if (!repo) {
      repos = [...repos, await ensureRepo(b.workspacePath, identity.name)]
    } else if (repo.displayName !== identity.name) {
      // 项目身份是唯一命名来源，旧假名和后续识别变化都同步回引擎
      await rpc('repo.update', { repo: repo.id, updates: { displayName: identity.name } })
      repo.displayName = identity.name
    }
  }
  const projectPaths = new Set(
    businessProjects()
      .filter((p) => p.dir)
      .map((p) => canonicalPath(p.path))
  )
  repos = repos.filter(
    (r) =>
      !projectPaths.has(canonicalPath(r.path)) ||
      before.some((b) => canonicalPath(b.workspacePath) === canonicalPath(r.path))
  )
  const result = reconcileBusinesses(before, repos, (p) => existsSync(p), canonicalPath)
  if (result.changed) {
    saveBusinesses(result.rows)
  }
  for (const row of result.rows) {
    if (!identities.has(row.id)) {
      identities.set(row.id, await businessIdentity(row))
    }
    if (!before.some((b) => b.id === row.id)) {
      recordProjectEvent(row, identities.get(row.id).name, 'added')
    }
  }
  return { rows: result.rows, identities }
}

/** 登记业务（POST /api/businesses）：目录必须存在；已登记过返回已有业务 */
export async function registerProject({
  path,
  name,
  priority = 2,
  leaderAgent = 'claude',
  leaderModel,
  authority = ''
}) {
  // 存真实路径：终端报的都是真实路径，网页按前缀把终端归到项目
  const dir = canonicalPath(workspacePath(path))
  const info = await stat(dir).catch((e) => {
    if (e.code === 'ENOENT') {
      throw badRequest('目录不存在')
    }
    throw e
  })
  if (!info.isDirectory()) {
    throw badRequest('不是目录')
  }
  const detected = await detectProjectIdentity(dir)
  const explicitName = name?.trim()
  const existing = businesses().find((b) => canonicalPath(b.workspacePath) === canonicalPath(dir))
  const nameSource = explicitName ? 'user' : existing?.nameSource === 'user' ? 'user' : 'auto'
  const effectiveName = explicitName || (nameSource === 'user' ? existing.name : detected.name)
  const repo = await ensureRepo(dir, effectiveName)
  if (existing) {
    if (!existing.removedAt) {
      return existing
    }
    const row = updateBusiness(existing.id, {
      removedAt: undefined,
      status: 'active',
      name: effectiveName,
      nameSource,
      repoId: repo.id,
      kind: repo.kind
    })
    recordProjectEvent(row, effectiveName, 'added')
    return row
  }
  const row = {
    id: projectIdFor(basename(dir), repo.id, new Set(businesses().map((b) => b.id))),
    name: effectiveName,
    nameSource,
    workspacePath: dir,
    leaderAgent,
    priority,
    status: 'active',
    authority,
    runIds: [],
    leaderModel,
    repoId: repo.id,
    kind: repo.kind,
    updatedAt: new Date().toISOString()
  }
  addBusiness(row)
  migrateProjects(row, [], [])
  recordProjectEvent(row, effectiveName, 'added')
  return row
}

/** 从引擎移除项目（不删磁盘文件）；附加信息保留，标 removedAt / archived */
export async function removeProject(id) {
  const row = getBusiness(id)
  if (row.repoId) {
    const { repos } = await rpc('repo.list')
    if (repos.some((r) => r.id === row.repoId)) {
      await rpc('repo.rm', { repo: row.repoId })
    }
  }
  const updated = updateBusiness(id, {
    status: 'archived',
    removedAt: new Date().toISOString(),
    repoId: undefined,
    kind: undefined
  })
  if (!row.removedAt) {
    recordProjectEvent(updated, (await businessIdentity(updated)).name, 'removed')
  }
  return updated
}

/** 项目改名同步引擎 displayName（项目还在引擎里时） */
export async function renameProjectRepo(row, name) {
  if (!row.repoId) {
    return
  }
  const { repos } = await rpc('repo.list')
  if (repos.some((r) => r.id === row.repoId)) {
    await rpc('repo.update', { repo: row.repoId, updates: { displayName: name } })
  }
}

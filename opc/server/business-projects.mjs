import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { containsPath, validProjectDir } from './workspace-path.mjs'
import { dataDir } from './data-dir.mjs'
import { getBusiness, badRequest, apiError, canonicalPath } from './business.mjs'
import { appendTimelineEvents } from './timeline.mjs'

function read() {
  try {
    return JSON.parse(readFileSync(join(dataDir(), 'business-projects.json'), 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { projects: [], migrated: [], bindings: {} }
    }
    throw e
  }
}
function save(data) {
  mkdirSync(dataDir(), { recursive: true })
  const file = join(dataDir(), 'business-projects.json'),
    temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}
export function within(path, root) {
  if (!path || !root) {
    return false
  }
  return containsPath(canonicalPath(root), canonicalPath(path))
}
export function projectPath(business, dir = '') {
  if (!validProjectDir(dir)) {
    throw badRequest('dir 必须是业务目录内的相对路径')
  }
  const root = realpathSync(business.workspacePath)
  let path = root
  for (const part of dir.split(/[/\\]/).filter(Boolean)) {
    path = join(path, part)
    try {
      path = realpathSync(path)
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e
      }
      mkdirSync(path)
      path = realpathSync(path)
    }
    if (!within(path, root)) {
      throw badRequest('dir 软链逃出业务目录')
    }
  }
  return path
}
export const businessProjects = (businessId) =>
  read().projects.filter((p) => !businessId || p.businessId === businessId)
export function getProject(id, businessId) {
  const p = businessProjects(businessId).find((p) => p.id === id)
  if (!p) {
    throw apiError(404, 'not_found', '项目不存在')
  }
  return p
}
function nameOf(name, projects, except) {
  if (typeof name !== 'string' || !name.trim()) {
    throw badRequest('name 不能为空')
  }
  if (projects.some((p) => p.id !== except && p.name === name.trim())) {
    throw apiError(409, 'project_exists', '同一业务项目名不能重复')
  }
  return name.trim()
}
function event(p, title) {
  appendTimelineEvents({
    id: `project:${p.id}:${randomUUID()}`,
    ts: p.updatedAt,
    businessId: p.businessId,
    projectId: p.id,
    kind: 'system',
    title,
    path: p.path
  })
}
export function createBusinessProject(businessId, body) {
  const data = read(),
    b = getBusiness(businessId)
  const name = nameOf(
    body.name,
    data.projects.filter((p) => p.businessId === businessId)
  )
  const path = projectPath(b, body.dir)
  const now = new Date().toISOString()
  const p = {
    id: randomUUID(),
    businessId,
    name,
    dir: body.dir || undefined,
    path,
    status: 'active',
    leader: null,
    counts: { workersLive: 0, dispatches: 0, dispatchesDone: 0 },
    createdAt: now,
    updatedAt: now
  }
  data.projects.push(p)
  save(data)
  event(p, `新建项目：${name}`)
  return p
}
export function updateProject(id, patch) {
  const data = read(),
    p = data.projects.find((p) => p.id === id)
  if (!p) {
    throw apiError(404, 'not_found', '项目不存在')
  }
  if (patch.name !== undefined) {
    patch.name = nameOf(
      patch.name,
      data.projects.filter((x) => x.businessId === p.businessId),
      id
    )
  }
  if (patch.status !== undefined && !['active', 'archived'].includes(patch.status)) {
    throw badRequest('status 必须为 active 或 archived')
  }
  Object.assign(p, patch, { updatedAt: new Date().toISOString() })
  save(data)
  if (patch.name || patch.status) {
    event(p, `${patch.status === 'archived' ? '归档项目' : '更新项目'}：${p.name}`)
  }
  return p
}
export function bindProjectTerminal(handle, projectId) {
  getProject(projectId)
  const data = read()
  data.bindings ??= {}
  data.bindings[handle] = projectId
  save(data)
}
export function projectOf({ handle, projectId, path, by }, projects, sent = []) {
  const own =
    projectId ??
    sent.findLast((d) => d.handle === handle && d.projectId)?.projectId ??
    read().bindings?.[handle]
  if (own) {
    return projects.find((p) => p.id === own)
  }
  const visited = new Set()
  let current = handle
  while (current && !visited.has(current)) {
    visited.add(current)
    const leader = projects.find((p) => p.leader?.terminal === current)
    if (leader) {
      return leader
    }
    const row = sent.find((d) => d.handle === current)
    current = row?.by?.id ?? (current === handle ? by?.id : undefined)
  }
  return projects
    .filter((p) => p.dir && within(path, p.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
}
export function migrateProjects(business, terminals, sent) {
  const data = read()
  if (data.migrated.includes(business.id)) {
    return
  }
  const alive = (handle) => terminals.find((t) => t.handle === handle && t.agent)
  const registered = alive(business.leaderTerminal)
  const owner = sent.findLast(
    (d) =>
      (d.role === 'leader' || d.by.kind === 'owner') &&
      within(d.project, business.workspacePath) &&
      alive(d.handle)
  )
  const session = sent.findLast((d) => within(d.by.cwd, business.workspacePath) && alive(d.by.id))
  const terminal = registered ?? alive(owner?.handle) ?? alive(session?.by.id)
  if (!data.projects.some((p) => p.businessId === business.id) && terminal) {
    const now = new Date().toISOString()
    data.projects.push({
      id: randomUUID(),
      businessId: business.id,
      name: '主线',
      path: business.workspacePath,
      status: 'active',
      leader: {
        terminal: terminal.handle,
        agent: terminal.agent,
        liveness: 'live',
        startedAt: terminal.startedAt || business.leaderStartedAt || ''
      },
      counts: { workersLive: 0, dispatches: 0, dispatchesDone: 0 },
      createdAt: now,
      updatedAt: now
    })
  }
  data.migrated.push(business.id)
  save(data)
}
export function projectSummaries(businessId, terminals, sent, workers = []) {
  const projects = businessProjects(businessId)
  return projects.map((p) => {
    const rows = sent.filter(
      (d) => projectOf({ ...d, path: d.project }, projects, sent)?.id === p.id
    )
    const last = rows.findLast((d) => d.handle === p.leader?.terminal)
    const t = terminals.find((t) => t.handle === p.leader?.terminal)
    return {
      ...p,
      leader: p.leader
        ? {
            ...p.leader,
            liveness: !t ? 'exited' : t.agent ? 'live' : 'unverifiable',
            state: !t
              ? 'exited'
              : last?.delivery === 'failed'
                ? 'failed'
                : ({ dispatched: 'working', pending: 'pending', blocked: 'blocked' }[
                    last?.status
                  ] ?? 'idle'),
            activity:
              last?.delivery === 'failed'
                ? last.blockedReason
                : last?.prompt.split('\n')[0].slice(0, 80)
          }
        : null,
      counts: {
        workersLive: new Set([
          ...workers
            .filter(
              (w) =>
                w.liveness === 'live' &&
                w.terminal !== p.leader?.terminal &&
                projectOf({ handle: w.terminal, path: w.path }, projects, sent)?.id === p.id
            )
            .map((w) => w.terminal ?? w.dispatchId),
          ...rows.filter((d) => d.alive && d.handle !== p.leader?.terminal).map((d) => d.handle)
        ]).size,
        dispatches: rows.filter((d) => !d.parent).length,
        dispatchesDone: rows.filter((d) => !d.parent && d.status === 'completed').length
      }
    }
  })
}

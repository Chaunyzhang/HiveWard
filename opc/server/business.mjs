import { dataDir } from './data-dir.mjs'
// OPC owns registration only. Runtime activity always comes from Orca.
import { homedir } from 'node:os'
import { join, isAbsolute, normalize } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const file = join(dataDir(), 'businesses.json')
export const apiError = (status, code, message) =>
  Object.assign(new Error(message), { status, code })
export const badRequest = (message) => apiError(400, 'bad_request', message)
export function workspacePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest('workspacePath 不能为空')
  }
  const path =
    value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(path)) {
    throw badRequest('workspacePath 必须是绝对路径或 ~/ 路径')
  }
  return normalize(path)
}
/** 引擎落库的路径都是 realpath（/tmp 是 /private/tmp 的软链），比较前先归一 */
export function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
export function businesses() {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e
    }
    const updatedAt = new Date().toISOString()
    const rows = [
      ['shop', '玉石独立站', '~/玉石', 'claude', 1, 'active'],
      ['finance', '财经自媒体', '~/Documents/文案稿', 'claude', 1, 'active'],
      ['cutgo', 'CutGo', '~/dev/cuttgo', 'codex', 2, 'active'],
      ['mini', '小程序', '~/Documents/uidemo', 'kimi', 3, 'active'],
      ['video', '剪辑工作室', '~/Documents/视频', 'claude', 3, 'paused']
    ].map(([id, name, path, leaderAgent, priority, status]) => ({
      id,
      name,
      nameSource: 'auto',
      workspacePath: workspacePath(path),
      leaderAgent,
      priority,
      status,
      authority: '',
      runIds: [],
      updatedAt
    }))
    save(rows)
    return rows
  }
}
function save(rows) {
  mkdirSync(dataDir(), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}
export function getBusiness(id) {
  const row = businesses().find((b) => b.id === id)
  if (!row) {
    throw apiError(404, 'not_found', `业务不存在：${id}`)
  }
  return row
}
export function updateBusiness(id, patch) {
  const rows = businesses(),
    index = rows.findIndex((b) => b.id === id)
  if (index === -1) {
    throw apiError(404, 'not_found', `业务不存在：${id}`)
  }
  rows[index] = { ...rows[index], ...patch, updatedAt: new Date().toISOString() }
  save(rows)
  return rows[index]
}
export function registerBusiness(body) {
  const rows = businesses()
  if (rows.some((b) => b.workspacePath === body.workspacePath)) {
    throw apiError(409, 'business_exists', '此目录已登记业务')
  }
  const row = {
    ...body,
    id: randomUUID(),
    status: 'active',
    runIds: [],
    updatedAt: new Date().toISOString()
  }
  rows.push(row)
  save(rows)
  return row
}
/** 项目对账用：直接落一条完整记录（id 已推导好） */
export function addBusiness(row) {
  const rows = businesses()
  rows.push(row)
  save(rows)
  return row
}
/** 对账后整批回写 */
export function saveBusinesses(rows) {
  save(rows)
}

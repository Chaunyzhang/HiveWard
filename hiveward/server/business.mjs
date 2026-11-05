import { pathKey } from './workspace-path.mjs'
import { normalizeSeat } from './seat-occupants.mjs'
import { dataDir } from './data-dir.mjs'
// HiveWard owns registration only. Runtime activity always comes from HiveWard.
import { homedir } from 'node:os'
import { join, isAbsolute, normalize } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const file = join(dataDir(), 'businesses.json')
const withCeo = (row) => ({ ...row, ceo: normalizeSeat(row.ceo) })
export const apiError = (status, code, message) =>
  Object.assign(new Error(message), { status, code })
export const badRequest = (message) => apiError(400, 'bad_request', message)
export function workspacePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest('workspacePath 不能为空')
  }
  const path =
    value === '~' ? homedir() : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(path)) {
    throw badRequest('workspacePath 必须是绝对路径或 ~/ 路径')
  }
  return normalize(path)
}
/** 引擎落库的路径都是 realpath（/tmp 是 /private/tmp 的软链），比较前先归一 */
export function canonicalPath(path) {
  try {
    path = realpathSync(path)
  } catch {
    // Missing paths still need consistent Windows comparison.
  }
  return pathKey(path)
}
export function businesses() {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).map(withCeo)
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e
    }
    // 第一次打开：还没有业务，老板自己加
    return []
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
  if (rows.some((b) => canonicalPath(b.workspacePath) === canonicalPath(body.workspacePath))) {
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

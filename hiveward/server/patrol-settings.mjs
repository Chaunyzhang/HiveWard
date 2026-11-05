// 定时巡检的全局设置（设置 → 常规）：巡检终端空闲多久自动关。存在数据目录的 patrol-settings.json。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { badRequest } from './business.mjs'
import { dataDir } from './data-dir.mjs'

const DEFAULTS = { idleCloseMinutes: 60 }
const file = () => join(dataDir(), 'patrol-settings.json')

export function patrolSettings() {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8'))
    return { ...DEFAULTS, ...(validMinutes(saved.idleCloseMinutes) ? saved : {}) }
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) {
      return { ...DEFAULTS }
    }
    throw e
  }
}

function validMinutes(value) {
  return Number.isInteger(value) && value >= 10 && value <= 1440
}

export function setPatrolSettings(body) {
  if (!validMinutes(body?.idleCloseMinutes)) {
    throw badRequest('idleCloseMinutes 必须是 10–1440 的整数')
  }
  const next = { ...patrolSettings(), idleCloseMinutes: body.idleCloseMinutes }
  mkdirSync(dataDir(), { recursive: true })
  const temp = `${file()}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 })
  renameSync(temp, file())
  return next
}

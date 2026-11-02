import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { call, OrcaUnavailable } from './orca-client.mjs'
import { apiError, canonicalPath } from './business.mjs'

const context = new AsyncLocalStorage()
const waiting = []
let active = 0
// Limit RPC concurrency across all new endpoints, including concurrent browser polls.
export async function rpc(method, params = {}) {
  const signal = context.getStore()
  signal?.throwIfAborted()
  if (active >= 4) {
    await new Promise((resolve) => waiting.push(resolve))
  } else {
    active++
  }
  try {
    signal?.throwIfAborted()
    return await call(method, params)
  } finally {
    const next = waiting.shift()
    if (next) {
      next()
    } else {
      active--
    }
  }
}
export function bounded(handler) {
  return async (...args) => {
    const controller = new AbortController()
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new OrcaUnavailable('接口采集超时（25 秒）')
        controller.abort(error)
        reject(error)
      }, 25_000)
    })
    try {
      return await Promise.race([context.run(controller.signal, () => handler(...args)), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
/** 目录还没登记成引擎里的项目就先登记：开终端要按项目找目录（新引擎里一开始只有空的项目列表） */
export async function ensureRepo(dir, displayName) {
  // 按真实路径比较和登记：/tmp 是 /private/tmp 的软链，引擎开终端时按真实路径找项目
  const path = canonicalPath(dir)
  const listed = await rpc('repo.list')
  const existing = listed.repos.find((r) => canonicalPath(r.path) === path)
  if (existing) {
    return existing
  }
  // 不是 git 仓库的目录（比如文案、素材目录）按普通文件夹登记
  const { repo } = await rpc('repo.add', {
    path,
    kind: existsSync(join(path, '.git')) ? 'git' : 'folder',
    ...(displayName ? { displayName } : {})
  })
  return repo
}

export async function optionalRpc(method, params) {
  try {
    return await rpc(method, params)
  } catch (e) {
    // Missing optional observations are unknown, transport failures are never empty success.
    if (e instanceof OrcaUnavailable) {
      throw e
    }
    if (
      [
        'method_not_found',
        'terminal_not_found',
        'terminal_handle_stale',
        'terminal_not_running'
      ].includes(e.code)
    ) {
      return null
    }
    throw e
  }
}
export function iso(value) {
  if (!value) {
    return ''
  }
  const date = new Date(
    typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value
  )
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}
export function json(value, fallback) {
  if (value == null || value === '') {
    return fallback
  }
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value)
  } catch {
    throw apiError(502, 'orca_invalid_data', 'Orca 返回的 JSON 字段无法解析')
  }
}

export const outsideRequest = (operation) => context.run(undefined, operation)

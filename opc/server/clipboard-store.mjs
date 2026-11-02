import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FILE_MAX_BYTES } from './files.mjs'
import { fileError } from './file-path-policy.mjs'

export const DEFAULT_CLIPBOARD_FILE_BYTES = 100 * 1024 * 1024
const RECENT_LIMIT = 20

export function createClipboardStore(directory) {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'clipboard.json')
  let state
  try {
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
    state = {
      settings: { enabled: false, maxFileBytes: DEFAULT_CLIPBOARD_FILE_BYTES },
      recent: []
    }
  }
  state.settings = {
    enabled: state.settings?.enabled === true,
    maxFileBytes: validLimit(state.settings?.maxFileBytes)
      ? state.settings.maxFileBytes
      : DEFAULT_CLIPBOARD_FILE_BYTES
  }
  state.recent = Array.isArray(state.recent) ? state.recent.slice(0, RECENT_LIMIT) : []

  function save() {
    const temp = `${file}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }
  function status() {
    return {
      settings: { ...state.settings },
      recent: state.recent.map((event) => ({ ...event, machine: { ...event.machine } }))
    }
  }
  return {
    status,
    settings: () => ({ ...state.settings }),
    setSettings(body) {
      if (
        !body ||
        typeof body !== 'object' ||
        typeof body.enabled !== 'boolean' ||
        !validLimit(body.maxFileBytes)
      ) {
        throw fileError(400, 'bad_request', 'enabled 或 maxFileBytes 设置无效')
      }
      state.settings = { enabled: body.enabled, maxFileBytes: body.maxFileBytes }
      save()
      return status()
    },
    add({ direction, machine, kind, count, bytes, skipped }, at = new Date()) {
      const event = {
        direction,
        machine: {
          id: String(machine.id).slice(0, 200),
          name: String(machine.name).slice(0, 200)
        },
        kind,
        ...(Number.isSafeInteger(count) ? { count } : {}),
        ...(Number.isSafeInteger(bytes) ? { bytes } : {}),
        at: at.toISOString(),
        ...(skipped ? { skipped: String(skipped).slice(0, 100) } : {})
      }
      state.recent = [event, ...state.recent].slice(0, RECENT_LIMIT)
      save()
      return event
    }
  }
}

function validLimit(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= FILE_MAX_BYTES
}

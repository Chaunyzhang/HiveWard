import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './data-dir.mjs'

const file = join(dataDir(), 'work-records.json')

export function workRecords() {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export function getWorkRecord(id) {
  return workRecords().find((record) => record.id === id)
}

export function saveWorkRecord(record) {
  const rows = workRecords()
  const existing = rows.find(
    (row) => row.taskId === record.taskId && (row.round ?? 1) === (record.round ?? 1)
  )
  if (existing) {
    return existing
  }
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify([...rows, record], null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
  return record
}

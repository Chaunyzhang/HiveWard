#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const SKIP_DIRECTORIES = new Set(['node_modules', 'Partitions', 'daemon', 'sessions'])

function candidateRoots() {
  const roots = []
  if (process.env.HIVEWARD_DATA_DIR) {
    roots.push(resolve(process.env.HIVEWARD_DATA_DIR))
  }
  const home = homedir()
  if (process.platform === 'darwin') {
    roots.push(join(home, 'Library', 'Application Support', 'HiveWard'))
    roots.push(join(home, 'Library', 'Application Support', 'HiveWard-Dev'))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    roots.push(join(appData, 'HiveWard'))
    roots.push(join(appData, 'HiveWard-Dev'))
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
    roots.push(join(configHome, 'HiveWard'))
    roots.push(join(configHome, 'HiveWard-Dev'))
  }
  roots.push(join(home, '.hiveward'))
  roots.push(join(home, '.hiveward-dev'))
  return [...new Set(roots)].filter((root) => existsSync(root))
}

function jsonFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(item.name)) {
          visit(join(directory, item.name))
        }
      } else if (item.isFile() && item.name.endsWith('.json') && !item.name.endsWith('.bak')) {
        files.push(join(directory, item.name))
      }
    }
  }
  visit(root)
  return files
}

function pathMatches(value, from) {
  return value === from || value.startsWith(`${from}/`) || value.startsWith(`${from}${sep}`)
}

function rewrite(value, from, to) {
  if (typeof value === 'string' && pathMatches(value, from)) {
    return to + value.slice(from.length)
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewrite(item, from, to))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewrite(item, from, to)])
    )
  }
  return value
}

function changedPaths(before, after, prefix = '') {
  if (typeof before === 'string') {
    return before === after ? [] : [prefix || '(根)']
  }
  if (Array.isArray(before)) {
    return before.flatMap((item, index) => changedPaths(item, after[index], `${prefix}[${index}]`))
  }
  if (before && typeof before === 'object') {
    return Object.keys(before).flatMap((key) =>
      changedPaths(before[key], after?.[key], prefix ? `${prefix}.${key}` : key)
    )
  }
  return []
}

function main(argv) {
  const args = argv.filter((arg) => arg !== '--apply')
  const apply = args.length !== argv.length
  if (args.length !== 2) {
    console.error('用法：node move-directory.mjs <旧路径> <新路径> [--apply]')
    return 2
  }
  const from = resolve(args[0]).replace(/[/\\]+$/, '')
  const to = resolve(args[1]).replace(/[/\\]+$/, '')
  if (from === to) {
    console.error('旧路径和新路径相同')
    return 2
  }

  let changedFiles = 0
  for (const root of candidateRoots()) {
    for (const file of jsonFiles(root)) {
      const raw = readFileSync(file, 'utf8')
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const next = rewrite(parsed, from, to)
      const fields = changedPaths(parsed, next)
      if (fields.length === 0) {
        continue
      }
      changedFiles += 1
      console.log(`${apply ? '修改' : '会改'} ${file}`)
      for (const field of fields) {
        console.log(`  ${field}`)
      }
      if (apply) {
        copyFileSync(file, `${file}.bak`)
        const newline = raw.endsWith('\n') ? '\n' : ''
        writeFileSync(file, `${JSON.stringify(next, null, 2)}${newline}`)
      }
    }
  }
  console.log(`${apply ? '已改' : '将改'} ${changedFiles} 个文件；旧路径 ${from} -> ${to}`)
  return 0
}

process.exitCode = main(process.argv.slice(2))

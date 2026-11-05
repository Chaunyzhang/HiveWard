import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import {
  asynchronousMigrationIO,
  synchronousMigrationIO,
  runAsynchronousMigration,
  runSynchronousMigration
} from './hiveward-migration-io.mjs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const HIVEWARD_MIGRATION_MARKER = '.hiveward-migration.json'

const RESIDUAL_SOCKET_CODES = new Set(['ECONNREFUSED', 'ENOENT'])
const SYNCHRONOUS_SOCKET_PROBE = `
  const net = require('node:net')
  const socket = net.connect(process.argv[1])
  socket.setTimeout(1000)
  socket.once('connect', () => { socket.destroy(); process.exit(0) })
  socket.once('error', (error) => process.exit(['ECONNREFUSED', 'ENOENT'].includes(error.code) ? 1 : 2))
  socket.once('timeout', () => { socket.destroy(); process.exit(2) })
`

// 只有没人监听的 socket 才是旧进程留下的运行时残渣；其它探测失败按活跃处理，避免误丢数据。
export function probeMigrationSocket(path) {
  return new Promise((done) => {
    const socket = connect(path)
    let settled = false
    const finish = (live) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      done(live)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', (error) => finish(!RESIDUAL_SOCKET_CODES.has(error?.code)))
    socket.setTimeout(1000, () => finish(true))
  })
}

export function probeMigrationSocketSync(path) {
  const result = spawnSync(process.execPath, ['-e', SYNCHRONOUS_SOCKET_PROBE, path], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 3000,
    stdio: 'ignore'
  })
  return result.status !== 1
}

export function migrationFailure(code) {
  return Object.assign(new Error(code), { code })
}

export function migrationChild(root, name) {
  const path = resolve(root, name)
  const suffix = relative(root, path)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw migrationFailure('migration_path_outside_root')
  }
  return path
}

export function* migrationChildWithoutLinksSteps(io, root, name) {
  const path = migrationChild(root, name)
  let parent = root
  for (const part of relative(root, path).split(sep).slice(0, -1)) {
    parent = join(parent, part)
    if (!(yield io.lstat(parent)).isDirectory()) {
      throw migrationFailure('migration_linked_parent')
    }
  }
  return path
}

function* hashFile(io, path) {
  const hash = createHash('sha256')
  const file = yield io.open(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = yield file.read(buffer, 0, buffer.length, position)
      if (!bytesRead) {
        break
      }
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return hash.digest('hex')
  } finally {
    yield file.close()
  }
}

function* readMigrationManifestSteps(
  io,
  root,
  probeSocket = probeMigrationSocket,
  residualSockets
) {
  const entries = []
  function* visit(directory, prefix) {
    const names = (yield io.readdir(directory)).sort()
    for (const name of names) {
      if (!prefix && name === HIVEWARD_MIGRATION_MARKER) {
        continue
      }
      const path = join(directory, name)
      const key = prefix ? `${prefix}/${name}` : name
      const stat = yield io.lstat(path)
      const mode = stat.mode & 0o777
      if (stat.isSymbolicLink()) {
        entries.push({ path: key, kind: 'link', target: yield io.readlink(path) })
      } else if (stat.isDirectory()) {
        entries.push({ path: key, kind: 'directory', mode })
        yield* visit(path, key)
      } else if (stat.isFile()) {
        entries.push({
          path: key,
          kind: 'file',
          mode,
          size: stat.size,
          hash: yield* hashFile(io, path)
        })
      } else if (stat.isSocket() && !(yield probeSocket(path))) {
        // 旧进程退出后留下的 socket 只是运行时残渣：不复制、不进清单，备份里原样保留。
        residualSockets?.add(resolve(path))
      } else {
        // 活跃 socket 等特殊文件不能伪装成已完整复制的数据。
        throw migrationFailure('migration_special_file')
      }
    }
  }
  yield* visit(root, '')
  return entries
}

export function assertMigrationManifest(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw migrationFailure('migration_verification_failed')
  }
}

export function summarizeMigrationManifest(entries) {
  const files = entries.filter((entry) => entry.kind === 'file')
  return { files: files.length, bytes: files.reduce((sum, entry) => sum + entry.size, 0) }
}

function* validateMigrationJsonSteps(io, root, names) {
  for (const name of names) {
    // 关键 JSON 的每层父目录都不跟随链接，避免读取目录外的数据。
    const path = yield* migrationChildWithoutLinksSteps(io, root, name)
    if (!(yield io.lstat(path)).isFile()) {
      throw migrationFailure('migration_json_not_file')
    }
    try {
      JSON.parse(yield io.readFile(path, 'utf8'))
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw migrationFailure('migration_json_invalid')
      }
      throw error
    }
  }
}

export const readMigrationManifest = (root, probeSocket = probeMigrationSocket, residualSockets) =>
  runAsynchronousMigration(
    readMigrationManifestSteps(asynchronousMigrationIO, root, probeSocket, residualSockets)
  )
export const readMigrationManifestSync = (
  root,
  probeSocket = probeMigrationSocketSync,
  residualSockets
) =>
  runSynchronousMigration(
    readMigrationManifestSteps(synchronousMigrationIO, root, probeSocket, residualSockets)
  )
export const validateMigrationJson = (root, names) =>
  runAsynchronousMigration(validateMigrationJsonSteps(asynchronousMigrationIO, root, names))
export const validateMigrationJsonSync = (root, names) =>
  runSynchronousMigration(validateMigrationJsonSteps(synchronousMigrationIO, root, names))

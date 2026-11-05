import { randomUUID } from 'node:crypto'
import {
  asynchronousMigrationIO,
  synchronousMigrationIO,
  runAsynchronousMigration,
  runSynchronousMigration
} from './hiveward-migration-io.mjs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  assertMigrationManifest,
  HIVEWARD_MIGRATION_MARKER,
  migrationChild,
  migrationChildWithoutLinksSteps,
  migrationFailure,
  probeMigrationSocket,
  probeMigrationSocketSync,
  readMigrationManifest,
  readMigrationManifestSync,
  summarizeMigrationManifest,
  validateMigrationJson,
  validateMigrationJsonSync
} from './hiveward-migration-manifest.mjs'

function* inspect(io, path) {
  try {
    return yield io.lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function sibling(path, label) {
  return `${path}.${label}-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`
}

function* writeMarker(io, root, marker) {
  const target = migrationChild(root, HIVEWARD_MIGRATION_MARKER)
  const temporary = `${target}.${randomUUID()}.tmp`
  const file = yield io.open(temporary, 'wx', 0o600)
  try {
    yield file.writeFile(`${JSON.stringify(marker)}\n`)
    yield file.sync()
  } finally {
    yield file.close()
  }
  yield io.rename(temporary, target)
}

function* readMarker(io, root, source, target) {
  const path = migrationChild(root, HIVEWARD_MIGRATION_MARKER)
  const stat = yield* inspect(io, path)
  if (!stat?.isFile()) {
    return null
  }
  try {
    const marker = JSON.parse(yield io.readFile(path, 'utf8'))
    if (
      marker !== null &&
      typeof marker === 'object' &&
      marker.version === 1 &&
      marker.source === source &&
      marker.target === target &&
      ['verified', 'complete'].includes(marker.phase) &&
      ((marker.initialized === true && marker.backup === null && marker.phase === 'complete') ||
        (typeof marker.backup === 'string' &&
          dirname(marker.backup) === dirname(source) &&
          basename(marker.backup).startsWith(`${basename(source)}.migrated-`))) &&
      Array.isArray(marker.manifest)
    ) {
      return marker
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
  }
  return null
}

function* acquireMigrationLock(io, path) {
  const ownedPath = `${path}-${process.pid}-${randomUUID()}`
  yield io.mkdir(ownedPath, { mode: 0o700 })
  try {
    for (const name of yield io.readdir(dirname(path))) {
      const prefix = `${basename(path)}-`
      if (!name.startsWith(prefix) || name === basename(ownedPath)) {
        continue
      }
      const pid = Number(name.slice(prefix.length).split('-')[0])
      if (!Number.isSafeInteger(pid) || pid < 1) {
        throw migrationFailure('migration_lock_unknown')
      }
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') {
          continue
        }
      }
      throw migrationFailure('migration_in_progress')
    }
  } catch (error) {
    yield io.rm(ownedPath, { recursive: true })
    throw error
  }
  // 每次仅删除自己的锁，崩溃残留按 PID 判断，不抢占仍存活的迁移。
  return () => io.rm(ownedPath, { recursive: true })
}

function validateRoots(source, target) {
  if (!isAbsolute(source) || !isAbsolute(target)) {
    throw migrationFailure('migration_absolute_paths_required')
  }
  for (const [parent, child] of [
    [source, target],
    [target, source]
  ]) {
    const suffix = relative(parent, child)
    if (!suffix || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))) {
      throw migrationFailure('migration_overlapping_roots')
    }
  }
}

function* physicalPath(io, path) {
  try {
    return yield io.realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
    return join(yield* physicalPath(io, dirname(path)), basename(path))
  }
}

// Chromium 在资料目录定下来之前只会写 Local State；没有完成标记的这类残留目录可以安全重迁。
const CHROMIUM_RESIDUE_FILES = new Set(['Local State', '.DS_Store'])

function* chromiumOnlyResidue(io, root) {
  const names = yield io.readdir(root)
  // 空目录同样是 Electron 抢在选目录前建的壳，没有数据可以保留。
  if (!names.length) {
    return true
  }
  for (const name of names) {
    if (!CHROMIUM_RESIDUE_FILES.has(name)) {
      return false
    }
    if (!(yield* inspect(io, join(root, name)))?.isFile()) {
      return false
    }
  }
  return true
}

// 调用方必须持有源目录使用权；有活跃终端或服务时返回 null，继续沿用旧路径。
function* migrationSteps(
  io,
  {
    source,
    target,
    acquireSourceLease,
    criticalJsonFiles = [],
    renames = [],
    transformStaging = () => {},
    copyTree = io.cp,
    probeSocket = io === synchronousMigrationIO ? probeMigrationSocketSync : probeMigrationSocket
  }
) {
  const probes = new Map()
  const socketIsLive = (path) => {
    if (!probes.has(path)) {
      probes.set(path, probeSocket(path))
    }
    return probes.get(path)
  }
  const readManifest = (root, residualSockets) =>
    io === synchronousMigrationIO
      ? readMigrationManifestSync(root, socketIsLive, residualSockets)
      : readMigrationManifest(root, socketIsLive, residualSockets)
  const validateJson =
    io === synchronousMigrationIO ? validateMigrationJsonSync : validateMigrationJson
  validateRoots(source, target)
  source = resolve(source)
  target = resolve(target)
  if (typeof acquireSourceLease !== 'function') {
    throw migrationFailure('migration_source_lease_required')
  }
  let unlock
  let releaseSource
  let backup
  let phase = 'admission'
  try {
    if ((yield* inspect(io, source))?.isSymbolicLink()) {
      const marker = yield* readMarker(io, target, source, target)
      if (
        marker?.phase === 'complete' &&
        (yield io.realpath(source)) === (yield io.realpath(target))
      ) {
        return { status: 'current', path: target, backup: marker.backup, legacyPresent: true }
      }
    }
    for (const [path, code] of [
      [source, 'source'],
      [target, 'target']
    ]) {
      if ((yield* inspect(io, path))?.isSymbolicLink()) {
        throw migrationFailure(`migration_${code}_not_directory`)
      }
    }
    validateRoots(yield* physicalPath(io, source), yield* physicalPath(io, target))
    yield io.mkdir(dirname(target), { recursive: true, mode: 0o700 })
    unlock = yield* acquireMigrationLock(io, `${target}.migration-lock`)
    const sourceStat = yield* inspect(io, source)
    const targetStat = yield* inspect(io, target)
    if (sourceStat && (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())) {
      throw migrationFailure('migration_source_not_directory')
    }
    if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
      throw migrationFailure('migration_target_not_directory')
    }
    const marker = targetStat ? yield* readMarker(io, target, source, target) : null
    if (marker?.phase === 'complete') {
      return { status: 'current', path: target, legacyPresent: !!sourceStat, backup: marker.backup }
    }
    if (
      !sourceStat &&
      marker?.phase === 'verified' &&
      (yield* inspect(io, marker.backup))?.isDirectory()
    ) {
      phase = 'recover-publication'
      backup = marker.backup
      assertMigrationManifest(yield readManifest(target), marker.manifest)
      yield* writeMarker(io, target, { ...marker, phase: 'complete' })
      return { status: 'migrated', path: target, backup: marker.backup, recovered: true }
    }
    if (!sourceStat) {
      if (targetStat) {
        if (!(yield* chromiumOnlyResidue(io, target))) {
          throw migrationFailure('migration_incomplete_without_source')
        }
        yield io.rename(target, sibling(target, 'incomplete'))
      }
      phase = 'initialize'
      const stagingContainer = yield io.mkdtemp(`${target}.migration-staging-`)
      const staging = join(stagingContainer, 'data')
      yield io.mkdir(staging, { mode: 0o700 })
      yield* writeMarker(io, staging, {
        version: 1,
        phase: 'complete',
        initialized: true,
        source,
        target,
        backup: null,
        manifest: []
      })
      yield io.rename(staging, target)
      yield io.rmdir(stagingContainer)
      return { status: 'initialized', path: target }
    }
    const lease = yield acquireSourceLease(source)
    if (typeof lease !== 'function') {
      throw migrationFailure('migration_source_busy')
    }
    releaseSource = lease
    phase = 'copy'
    if (targetStat) {
      yield io.rename(target, sibling(target, 'incomplete'))
    }
    const residualSockets = new Set()
    const original = yield readManifest(source, residualSockets)
    yield validateJson(source, criticalJsonFiles)
    const stagingContainer = yield io.mkdtemp(`${target}.migration-staging-`)
    const staging = join(stagingContainer, 'data')
    yield copyTree(source, staging, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      filter: (path) => !residualSockets.has(resolve(path))
    })
    phase = 'verify'
    assertMigrationManifest(yield readManifest(staging), original)
    assertMigrationManifest(yield readManifest(source), original)
    yield validateJson(staging, criticalJsonFiles)
    yield transformStaging(staging)
    yield validateJson(staging, criticalJsonFiles)
    for (const [oldName, newName] of renames) {
      const oldPath = yield* migrationChildWithoutLinksSteps(io, staging, oldName)
      const newPath = yield* migrationChildWithoutLinksSteps(io, staging, newName)
      if (yield* inspect(io, oldPath)) {
        if (yield* inspect(io, newPath)) {
          throw migrationFailure('migration_layout_conflict')
        }
        yield io.rename(oldPath, newPath)
      }
    }
    const manifest = yield readManifest(staging)
    backup = sibling(source, 'migrated')
    const record = { version: 1, phase: 'verified', source, target, backup, manifest }
    phase = 'publish'
    yield* writeMarker(io, staging, record)
    if (yield* inspect(io, target)) {
      throw migrationFailure('migration_target_appeared')
    }
    yield io.rename(staging, target)
    yield io.rmdir(stagingContainer)
    phase = 'backup'
    yield io.rename(source, backup)
    phase = 'complete'
    yield* writeMarker(io, target, { ...record, phase: 'complete' })
    return { status: 'migrated', path: target, backup, ...summarizeMigrationManifest(original) }
  } catch (error) {
    if (backup && !(yield* inspect(io, source)) && (yield* inspect(io, backup))) {
      try {
        yield io.rename(backup, source)
      } catch {
        return { status: 'failed', path: null, backup, phase, reason: 'migration_restore_failed' }
      }
    }
    return {
      status: ['migration_source_busy', 'migration_in_progress'].includes(error.code)
        ? 'deferred'
        : 'failed',
      path: (yield* inspect(io, source))?.isDirectory() ? source : null,
      phase,
      reason: typeof error.code === 'string' ? error.code : 'migration_failed'
    }
  } finally {
    try {
      if (releaseSource) {
        yield releaseSource({ source, target, backup })
      }
    } finally {
      if (unlock) {
        yield unlock()
      }
    }
  }
}

export const migrateHiveWardDirectory = (options) =>
  runAsynchronousMigration(migrationSteps(asynchronousMigrationIO, options))
export const migrateHiveWardDirectorySync = (options) =>
  runSynchronousMigration(migrationSteps(synchronousMigrationIO, options))

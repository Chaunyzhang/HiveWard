import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import { join } from 'node:path'

export const asynchronousMigrationIO = promises
// fs.cpSync 不保留目录权限（异步 cp 会），同步路径自己补回来，否则清单校验判失败。
function preserveDirectoryModes(source, target) {
  const stat = fs.lstatSync(source)
  if (!stat.isDirectory()) {
    return
  }
  for (const name of fs.readdirSync(source)) {
    preserveDirectoryModes(join(source, name), join(target, name))
  }
  fs.chmodSync(target, stat.mode & 0o7777)
}

function copySyncPreservingDirectoryModes(source, target, options) {
  fs.cpSync(source, target, options)
  preserveDirectoryModes(source, target)
}

export const synchronousMigrationIO = Object.fromEntries(
  [
    'lstat',
    'mkdir',
    'mkdtemp',
    'readdir',
    'readFile',
    'readlink',
    'realpath',
    'rename',
    'rm',
    'rmdir'
  ].map((name) => [name, (...args) => fs[`${name}Sync`](...args)])
)
synchronousMigrationIO.cp = copySyncPreservingDirectoryModes
synchronousMigrationIO.open = (...args) => {
  const fd = fs.openSync(...args)
  return {
    read: (buffer, offset, length, position) => ({
      bytesRead: fs.readSync(fd, buffer, offset, length, position)
    }),
    writeFile: (text) => fs.writeFileSync(fd, text),
    sync: () => fs.fsyncSync(fd),
    close: () => fs.closeSync(fd)
  }
}

// 两种执行器共用状态机；同步启动路径不让出事件循环，Electron 此时不能进入 ready。
export function runSynchronousMigration(steps) {
  let current = steps.next()
  while (!current.done) {
    try {
      if (current.value && typeof current.value.then === 'function') {
        throw new Error('Synchronous migration received an asynchronous operation')
      }
      current = steps.next(current.value)
    } catch (error) {
      current = steps.throw(error)
    }
  }
  return current.value
}

export async function runAsynchronousMigration(steps) {
  let current = steps.next()
  while (!current.done) {
    let value
    try {
      value = await current.value
    } catch (error) {
      current = steps.throw(error)
      continue
    }
    current = steps.next(value)
  }
  return current.value
}

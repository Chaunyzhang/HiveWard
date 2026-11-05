import path from 'node:path'

export function pathKey(value, paths = path) {
  if (typeof value !== 'string') {
    return value
  }
  const normalized = paths.normalize(value)
  return paths.sep === '\\' ? normalized.toLowerCase() : normalized
}

export function containsPath(root, value, paths = path) {
  if (!root || !value) {
    return false
  }
  const child = paths.relative(pathKey(root, paths), pathKey(value, paths))
  return !paths.isAbsolute(child) && child !== '..' && !child.startsWith(`..${paths.sep}`)
}

export function validProjectDir(dir, paths = path) {
  return (
    typeof dir === 'string' &&
    !paths.isAbsolute(dir) &&
    !path.win32.isAbsolute(dir) &&
    !dir.includes(':') &&
    !dir.includes('\0') &&
    !dir.split(/[/\\]/).includes('..')
  )
}

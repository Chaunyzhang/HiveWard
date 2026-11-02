import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileError } from './file-path-policy.mjs'

const MAX_ENTRIES = 1000
const MAX_DEPTH = 64

export async function scanClipboardFiles(paths, maxFileBytes, platformPath = path) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_ENTRIES) {
    throw fileError(400, 'invalid_clipboard_files', '文件列表为空或项目过多')
  }
  const entries = []
  const roots = new Set()
  let totalBytes = 0
  for (const source of paths) {
    if (typeof source !== 'string' || !platformPath.isAbsolute(source)) {
      throw fileError(400, 'invalid_clipboard_files', '剪贴板文件必须使用绝对路径')
    }
    const name = platformPath.basename(platformPath.normalize(source))
    const key = platformPath === path.win32 ? name.toLowerCase() : name
    if (!name || name.startsWith('.') || roots.has(key)) {
      throw fileError(400, 'invalid_clipboard_files', '隐藏项、无效名称或同名文件不能同步')
    }
    roots.add(key)
    totalBytes += await walk(source, name, source, entries, 0, platformPath)
    if (entries.length > MAX_ENTRIES) {
      throw fileError(413, 'clipboard_files_too_many', '剪贴板文件项目过多')
    }
  }
  return {
    entries,
    count: roots.size,
    totalBytes,
    tooLarge: totalBytes > maxFileBytes
  }
}

async function walk(source, relative, original, entries, depth, platformPath) {
  if (depth > MAX_DEPTH) {
    throw fileError(400, 'invalid_clipboard_files', '目录层级过深')
  }
  const info = await lstat(source)
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw fileError(400, 'invalid_clipboard_files', '符号链接和特殊文件不能同步')
  }
  if (info.isFile()) {
    entries.push({ path: relative, type: 'file', size: info.size, source: original })
    return info.size
  }
  entries.push({ path: relative, type: 'directory', source: original })
  const { readdir } = await import('node:fs/promises')
  const children = await readdir(source)
  children.sort()
  let bytes = 0
  for (const child of children) {
    if (child.startsWith('.')) {
      throw fileError(400, 'invalid_clipboard_files', '目录中的隐藏项不能同步')
    }
    bytes += await walk(
      platformPath.join(source, child),
      `${relative}/${child}`,
      platformPath.join(source, child),
      entries,
      depth + 1,
      platformPath
    )
  }
  return bytes
}
